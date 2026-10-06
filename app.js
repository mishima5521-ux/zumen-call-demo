/* 図面テレビ電話
 * - PeerJS（WebRTC）で 1 対 1 のビデオ通話とデータ通信
 * - 図面（PDF・画像）は映像ではなくファイルとして相手に送り、双方で描画するので劣化しない
 * - レーザーポインター・蛍光ペン・ペンは「図面上の位置（0〜1 の正規化座標）」で同期する
 */
(() => {
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const DPR = () => clamp(window.devicePixelRatio || 1, 1, 3);

// デモモード：この1台だけで「発信 → 着信 → 通話」を見せる（通信はしない）
const DEMO = new URLSearchParams(location.search).has('demo') || !!window.ZUMEN_DEMO;
const NS = DEMO ? 'zumen.demo.' : 'zumen.';
const store = {
  get(k, d) { try { const v = localStorage.getItem(NS + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch { /* 保存できなくても動作には影響しない */ } },
};

const CFG = Object.assign({}, window.ZUMEN_CONFIG || {});
const QS = new URLSearchParams(location.search);
const CHUNK = 15 * 1024; // PeerJS の分割サイズ（約16KB）未満に収める

// 社外の方：招待リンク（…#j=部屋番号&n=招待した会社）で開いたときはゲストとして入室する
const HASH = new URLSearchParams(location.hash.slice(1));
const JOIN_ROOM = /^[a-z2-9]{20,40}$/.test(HASH.get('j') || '') ? HASH.get('j') : '';
const GUEST_MODE = !!JOIN_ROOM && !DEMO;
// Web に置いた版（設定ファイルなし）：社内の呼び出しは使わず、招待リンクの打ち合わせだけを行う
const HOSTED = !!CFG.hosted;
// 議事録の自動作成（文字起こし＋AI）は保留中。config.js で minutes: true にしたときだけ使う
const MINUTES_ON = CFG.minutes === true;
// 文字起こし・字幕はいつでも使える（議事録の自動作成がオフのときは、字幕の表示だけ）
const TR_USE = MINUTES_ON ? '議事録に使われます' : '画面の下に字幕で表示されます';
const DEFAULT_JOIN_URL = 'https://mishima5521-ux.github.io/zumen-call-demo/meet/';
// 画面のデザイン（theme.js）。読み込めなかったときは今までのデザインのまま動く
const TH = window.ZumenTheme || null;
// 推測されない乱数（部屋番号・再接続の合言葉に使う）
const secureId = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b & 31]).join('');
const cleanText = (v, n = 40) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
// 相手から届くデータの検査（社外の相手でも、壊れた・大きすぎるデータで画面が止まらないように）
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const isId = (x) => typeof x === 'string' && x.length > 0 && x.length <= 64;
const isKey = (x) => typeof x === 'string' && x.length > 0 && x.length <= 120;
const validPts = (p, max) => Array.isArray(p) && p.length % 2 === 0 && p.length <= max && p.every(finite);
const validStroke = (st) => !!st && isId(st.id) && (st.tool === 'hl' || st.tool === 'pen') && typeof st.color === 'string' && /^#[0-9a-f]{6}$/i.test(st.color) && finite(st.w) && st.w > 0 && st.w < 10 && validPts(st.pts, 8000);
const validView = (v) => !!v && finite(v.cx) && finite(v.cy) && finite(v.zoom) && v.zoom > 0 && v.zoom <= 1000;
function validContent(c) {
  if (!c || typeof c !== 'object') return false;
  if (c.type === 'none') return true;
  if (c.type === 'live') return c.who === 'host' || c.who === 'guest' || isUid(c.who);
  if (c.type === 'doc') return isId(c.docId) && Number.isInteger(c.page) && c.page >= 1 && c.page <= 5000;
  return false;
}
const isUid = (x) => typeof x === 'string' && /^u[a-z2-9]{8}$/.test(x);
const newUid = () => 'u' + secureId(8);
const MAX_PARTY = 6;                 // 打ち合わせの最大人数
const MAX_FILE = 200 * 1024 * 1024;  // 受け取る図面の上限
const MAX_STROKES = 5000;            // 1ページの書き込みの上限
const MAX_STROKE_PTS = 40000;        // 1本の線の点の上限

// 送信画質の設定
const QUALITY = {
  std: { w: 1280, h: 720, fps: 30, br: 2_500_000, hint: 'motion', deg: 'balanced' },
  hi: { w: 1920, h: 1080, fps: 30, br: 6_000_000, hint: 'detail', deg: 'maintain-resolution' },
  max: { w: 3840, h: 2160, fps: 30, br: 12_000_000, hint: 'detail', deg: 'maintain-resolution' },
};

const COLORS = ['#ffe600', '#ff4fa3', '#39d353', '#3fa9ff', '#e53935', '#222222'];
const TOOL_WIDTH = { hl: 26, pen: 4 }; // 画面上の px（書いた時点の倍率で図面に固定される）

// ===================================================================
// 状態
// ===================================================================
const S = {
  role: null,            // 'host'（電話を受けた側） | 'guest'（かけた側）
  meId: '',              // このPC（config.js の members の id）
  name: '',
  peer: null,
  conn: null,
  call: null,
  inCall: false,
  partner: null,         // 通話相手の接続ID
  token: null,           // 回線が切れたときの自動再接続用
  ringing: null,         // 着信中 { c, name, from }
  outgoing: null,        // 発信中
  hostWaitTimer: null,   // 受けた側：回線断のあと相手の再接続を待つ期限
  reconnectUntil: 0,     // かけた側：再接続を試みる期限
  alert: { flash: false, sound: 'normal', volume: 0.8 }, // 着信の知らせ方（PCごとに保存）
  unread: store.get('unread', {}),  // 相手ごとの未読メッセージ数
  flags: store.get('flags', {}),    // 相手ごとの「不在着信」「折り返し予定」
  tr: { on: false, lines: [] },     // 文字起こし
  callDocs: new Set(),              // 通話中に開いた図面・写真の名前（議事録用）
  callStartedAt: 0,
  localStream: null,
  remoteStream: null,
  remoteName: '相手',
  camId: store.get('camId', ''),
  micId: store.get('micId', ''),
  quality: 'std',
  autoBoosted: false,
  mirror: store.get('mirror', true),

  docs: new Map(),       // docId -> { id, kind, name, mime, blob, pdf, img }
  content: { type: 'none' },
  contentTs: 0,
  view: { cx: 0.5, cy: 0.5, zoom: 1 },
  cur: null,             // 表示中コンテンツの準備済み情報 { key, kind, W, H, page, low, img }
  sync: true,

  strokes: new Map(),    // key -> stroke[]
  strokeById: new Map(),
  myStack: [],           // [key, id] 自分の書き込み（戻す用）
  tool: 'laser',
  color: COLORS[0],
  pointers: new Map(),   // 'me' | 'remote' -> { pts:[{u,v,t}], key, name, last }
  incoming: new Map(),   // 受信中ファイル
  pendingDoc: null,
  share: null,           // 画面共有中 { stream, track, prev }
  external: false,       // 社外の方との打ち合わせ中（ホスト・ゲストとも）
  meeting: null,         // ホスト：待機中の招待リンク { id, label, hostName, peer }
  extChat: [],           // 社外の方とのチャット（保存しない）
  previews: new Map(),   // 相手から先に届いた図面の見本画像 docId -> { name, kind, pages, imgs: Map(page -> {img, W, H}) }

  // 複数人の打ち合わせ（最大6人）。電話を受けた側（まとめ役）が全員とつながり、図面・書き込みなどを配る。
  // 映像と音声は、まとめ役以外の人どうしも直接つなぐ（つながらないときは、まとめ役が中継する）
  uid: '',               // 打ち合わせの中での自分の番号（社内の接続IDは社外の方に知らせないため、別の番号を使う）
  partnerUid: '',        // S.conn の相手の番号（まとめ役から見た最初の相手 / 参加者から見たまとめ役）
  primaryMesh: '',       // まとめ役：最初の相手の映像用の接続ID
  party: { id: '', hub: '', list: [] }, // 参加者の一覧 [{ uid, name, mesh }]
  extras: new Map(),     // まとめ役：2人目以降の参加者 uid -> { uid, c, call, name, stream, token, mesh, member, external, timer }
  mesh: new Map(),       // 参加者：ほかの参加者との映像 uid -> { call, peer, stream }
  relays: new Map(),     // 参加者：まとめ役が中継している映像 uid -> { call, stream }
  relayOut: new Map(),   // まとめ役：中継している映像
  meshPeer: null,        // 社内の参加者：映像用の接続（番号は毎回ランダム）
  sentMesh: '',
  meshWait: new Map(),
  invites: new Map(),    // まとめ役：呼び出し中の社内の人 memberId -> { c, m, timer, done }
  grpChat: [],           // 複数人の打ち合わせのチャット（保存しない）
  door: null,            // まとめ役：社外の方を受け入れる入口（毎回ランダムな ID）
  tickets: new Map(),    // まとめ役：入口から入ってよい社外の方の合言葉
  doorWait: new Map(),   // 参加者：入口を案内するのを待っている社外の方の接続
};
if (QS.has('debug')) window.__zumen = S; // 動作確認用

// ===================================================================
// 要素
// ===================================================================
const el = {
  lobby: $('#lobby'), room: $('#room'),
  lobbyVideo: $('#lobbyVideo'), lobbyNoCam: $('#lobbyNoCam'),
  lobbyCam: $('#lobbyCam'), lobbyMic: $('#lobbyMic'),
  lobbyMsg: $('#lobbyMsg'),
  stage: $('#stage'), base: $('#baseCanvas'), ink: $('#inkCanvas'), ptr: $('#ptrCanvas'),
  stageVideo: $('#stageVideo'), emptyHint: $('#emptyHint'),
  progress: $('#progress'), banner: $('#banner'),
  remoteWipe: $('#remoteWipe'), selfWipe: $('#selfWipe'),
  remoteAudio: $('#remoteAudio'),
  connDot: $('#connDot'), connText: $('#connText'), statsText: $('#statsText'),
  pageText: $('#pageText'), fileInput: $('#fileInput'),
};
const ctx = {
  base: el.base.getContext('2d'),
  ink: el.ink.getContext('2d'),
  ptr: el.ptr.getContext('2d'),
};

// ===================================================================
// 汎用 UI
// ===================================================================
function setStatus(text, kind) {
  el.connText.textContent = text;
  el.connDot.className = 'dot' + (kind ? ' ' + kind : '');
}
let bannerTimer;
function banner(text, ms = 4000) {
  clearTimeout(bannerTimer);
  if (!text) { el.banner.hidden = true; return; }
  el.banner.textContent = text;
  el.banner.hidden = false;
  if (ms) bannerTimer = setTimeout(() => { el.banner.hidden = true; }, ms);
}
function progress(label, ratio) {
  if (label == null) { el.progress.hidden = true; return; }
  el.progress.hidden = false;
  el.progress.querySelector('span').textContent = label;
  el.progress.querySelector('i').style.width = Math.round(clamp(ratio, 0, 1) * 100) + '%';
}
function lobbyMsg(t) { (GUEST_MODE ? $('#guestMsg') : el.lobbyMsg).textContent = t || ''; }
// 画面内の確認ダイアログ（ブラウザの confirm() は処理を止めてしまい、表示できない環境もあるため使わない）
function askConfirm(text, okLabel = 'はい') {
  const d = $('#confirmDlg');
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = okLabel;
  if (d.open) d.close(); // 前の確認が開いたままなら「やめる」扱いにする
  return new Promise((res) => {
    const done = () => { d.removeEventListener('close', done); res(d.returnValue === 'ok'); };
    d.addEventListener('close', done);
    d.returnValue = '';
    d.showModal();
  });
}

// ===================================================================
// カメラ・マイク
// ===================================================================
function videoConstraints(q) {
  const c = { width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps } };
  if (S.camId) c.deviceId = { exact: S.camId };
  return c;
}
function audioConstraints() {
  const c = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (S.micId) c.deviceId = { exact: S.micId };
  return c;
}

// 開いたストリームを返すだけ（S.localStream への代入は ensureMedia が行う）
async function openMedia() {
  const q = QUALITY[S.quality];
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(q), audio: audioConstraints() });
  } catch (e) {
    // 保存していた機器が外れている等 → 既定の機器で再試行
    S.camId = ''; S.micId = '';
    try { stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(q), audio: audioConstraints() }); }
    catch { try { stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() }); } catch { stream = null; } }
  }
  if (!stream) stream = new MediaStream();
  const noCam = !stream.getVideoTracks().length;
  ensureVideoTrack(stream);
  ensureAudioTrack(stream);
  const vt = stream.getVideoTracks()[0];
  if (vt && !vt._dummy) vt.contentHint = q.hint;
  if (noCam) banner('カメラを使えません。ほかのアプリ（Teams・Zoom など）がカメラを使っていないか確認してください', 8000);
  return stream;
}

// カメラが無い場合でも通話できるよう、ダミー映像・無音を用意する
let dummyCanvas = null;
function ensureVideoTrack(stream) {
  if (stream.getVideoTracks().length) return;
  if (!dummyCanvas) {
    dummyCanvas = document.createElement('canvas');
    dummyCanvas.width = 640; dummyCanvas.height = 360;
    const g = dummyCanvas.getContext('2d');
    const paint = () => { g.fillStyle = '#222'; g.fillRect(0, 0, 640, 360); g.fillStyle = '#aaa'; g.font = '28px sans-serif'; g.textAlign = 'center'; g.fillText('カメラなし', 320, 190); };
    paint(); setInterval(paint, 1000);
  }
  const t = dummyCanvas.captureStream(1).getVideoTracks()[0];
  if (!t) return;
  t._dummy = true;
  stream.addTrack(t);
}

// カメラ・マイクは通話中（と確認中）だけ使い、待受中は手放す
let mediaPromise = null;
let mediaGen = 0;
function ensureMedia() {
  if (!mediaPromise) {
    const gen = ++mediaGen;
    mediaPromise = openMedia().then(async (st) => {
      if (gen !== mediaGen) { st.getTracks().forEach((t) => t.stop()); return null; } // 準備中に手放された
      S.localStream = st;
      refreshLocalVideos();
      await listDevices();
      return st;
    });
  }
  return mediaPromise;
}
function releaseMedia() {
  mediaGen++;
  if (S.localStream) S.localStream.getTracks().forEach((t) => t.stop());
  S.localStream = null;
  mediaPromise = null;
  refreshLocalVideos();
}
function ensureAudioTrack(stream) {
  if (stream.getAudioTracks().length) return;
  try {
    const ac = audioCtx();
    const dst = ac.createMediaStreamDestination();
    const t = dst.stream.getAudioTracks()[0];
    t._dummy = true;
    stream.addTrack(t);
  } catch { /* 音声なしでも続行 */ }
}
function realVideoTrack() {
  const t = S.localStream && S.localStream.getVideoTracks()[0];
  return t && !t._dummy ? t : null;
}

async function listDevices() {
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { /* 未対応 */ }
  const cams = devs.filter((d) => d.kind === 'videoinput');
  const mics = devs.filter((d) => d.kind === 'audioinput');
  const curCam = realVideoTrack()?.getSettings().deviceId || S.camId;
  const curMic = S.localStream?.getAudioTracks()[0]?.getSettings().deviceId || S.micId;
  for (const sel of [el.lobbyCam, $('#setCam'), $('#guestCam')]) fillSelect(sel, cams, curCam, 'カメラ');
  S.cams = cams;
  $('#flipBtn').hidden = cams.length < 2 && !realVideoTrack()?.getSettings().facingMode;
  for (const sel of [el.lobbyMic, $('#setMic'), $('#guestMic')]) fillSelect(sel, mics, curMic, 'マイク');
}
function fillSelect(sel, list, cur, label) {
  sel.innerHTML = '';
  if (!list.length) { sel.add(new Option(label + 'が見つかりません', '')); sel.disabled = true; return; }
  sel.disabled = false;
  list.forEach((d, i) => sel.add(new Option(d.label || `${label} ${i + 1}`, d.deviceId)));
  if (cur && list.some((d) => d.deviceId === cur)) sel.value = cur;
}

// 映像を送っている相手すべて（1対1なら1つ。複数人なら人数分）
function allCalls() {
  const a = [];
  if (S.call) a.push(S.call);
  for (const X of S.extras.values()) if (X.call) a.push(X.call);
  for (const v of S.mesh.values()) if (v.call) a.push(v.call);
  return a;
}
function videoSenders() {
  const out = [];
  for (const call of allCalls()) {
    const pc = call.peerConnection;
    if (!pc) continue;
    const s = pc.getSenders().find((x) => x.track && x.track.kind === 'video') || pc.getSenders().find((x) => !x.track);
    if (s) out.push(s);
  }
  return out;
}
function audioSenders() {
  const out = [];
  for (const call of allCalls()) {
    const pc = call.peerConnection;
    const s = pc && pc.getSenders().find((x) => x.track && x.track.kind === 'audio');
    if (s) out.push(s);
  }
  return out;
}
// 相手に送る映像（画面共有中は共有している画面）
function outStream() {
  if (!S.share || !S.localStream) return S.localStream;
  return new MediaStream([S.share.track, ...S.localStream.getAudioTracks()]);
}

// deviceId でカメラを選ぶ。facing（'user'＝内側／'environment'＝外側）を渡すとスマホの向きで選ぶ
async function switchCamera(deviceId, facing = null) {
  S.camId = facing ? '' : deviceId; store.set('camId', S.camId);
  if (!S.localStream) return;
  const old = S.localStream.getVideoTracks()[0];
  const vc = () => { const c = videoConstraints(QUALITY[S.quality]); if (facing) { delete c.deviceId; c.facingMode = { exact: facing }; } return c; };
  let ns;
  try { ns = await navigator.mediaDevices.getUserMedia({ video: vc() }); }
  catch {
    // スマホはカメラを2つ同時に開けないことがあるので、今のカメラを止めてから開き直す
    if (old && !old._dummy) old.stop();
    try { ns = await navigator.mediaDevices.getUserMedia({ video: vc() }); }
    catch { banner('このカメラを開けませんでした'); return; }
  }
  const nt = ns.getVideoTracks()[0];
  nt.enabled = old ? old.enabled : true;
  if (old) { S.localStream.removeTrack(old); old.stop(); }
  S.localStream.addTrack(nt);
  if (!S.share) for (const sd of videoSenders()) await sd.replaceTrack(nt).catch(() => {});
  refreshLocalVideos();
  await applyQuality();
}
async function switchMic(deviceId) {
  S.micId = deviceId; store.set('micId', deviceId);
  if (!S.localStream) return;
  let ns;
  try { ns = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() }); }
  catch { banner('このマイクを開けませんでした'); return; }
  const nt = ns.getAudioTracks()[0];
  const old = S.localStream.getAudioTracks()[0];
  nt.enabled = old ? old.enabled : true;
  if (old) { S.localStream.removeTrack(old); old.stop(); }
  S.localStream.addTrack(nt);
  for (const sd of audioSenders()) await sd.replaceTrack(nt).catch(() => {});
}

function refreshLocalVideos() {
  el.lobbyVideo.srcObject = S.localStream;
  $('#guestVideo').srcObject = S.localStream;
  $('#guestNoCam').hidden = !!realVideoTrack();
  $('#guestCamBtn').textContent = S.localStream ? '確認を終わる' : 'カメラを確認';
  el.lobbyNoCam.hidden = !!realVideoTrack();
  $('#previewBtn').textContent = S.localStream ? '確認を終わる' : 'カメラを確認';
  $('#lobbyNoCam span').textContent = S.localStream ? 'カメラを使えません' : 'カメラは通話中だけ使います';
  el.selfWipe.querySelector('video').srcObject = S.localStream;
  // 外側カメラ（製品を映す）のときは反転しない
  el.selfWipe.classList.toggle('mirror', S.mirror && realVideoTrack()?.getSettings().facingMode !== 'environment');
  if (S.content.type === 'live') attachStageVideo();
}

// 送信画質を反映（解像度・ビットレート・優先度）
async function applyQuality() {
  const q = QUALITY[S.quality];
  const t = realVideoTrack();
  if (t) {
    try { await t.applyConstraints({ width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps } }); } catch { /* カメラ非対応の値は無視 */ }
    t.contentHint = q.hint;
  }
  // 複数人のときは送る相手の数だけ回線を使うので、大きく映されていないときは軽くする
  const group = isGroup();
  const featured = !group || (S.content.type === 'live' && isMeWho(S.content.who));
  const w = (t && t.getSettings().width) || 640;
  for (const sender of videoSenders()) {
    if (!sender.getParameters) continue;
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = S.share ? (group ? 2_500_000 : Math.max(q.br, 6_000_000)) : featured ? q.br : 600_000;
    p.encodings[0].scaleResolutionDownBy = S.share || featured ? 1 : Math.max(1, w / 640);
    p.degradationPreference = S.share ? 'maintain-resolution' : q.deg;
    try { await sender.setParameters(p); }
    catch {
      try { delete p.degradationPreference; await sender.setParameters(p); } catch { /* 未対応ブラウザ */ }
    }
  }
}
function setQuality(q, { auto = false } = {}) {
  S.quality = q;
  S.autoBoosted = auto;
  $('#qualitySel').value = q;
  applyQuality();
}

// ===================================================================
// 接続（PeerJS）― 電話のように「呼び出す → 相手が出る」
// ===================================================================
function peerOptions() {
  const o = { debug: 0 };
  const host = QS.get('host') || CFG.peerHost;
  if (host) {
    o.host = host;
    o.port = Number(QS.get('port') || CFG.peerPort || 443);
    o.path = QS.get('path') || CFG.peerPath || '/';
    o.secure = (QS.get('secure') ?? String(CFG.peerSecure ?? true)) !== 'false';
  }
  if (CFG.iceServers) o.config = { iceServers: CFG.iceServers };
  return o;
}

const DEFAULT_MEMBERS = [
  { id: 'office', name: '事務所' },
  { id: 'site1', name: '現場1' },
  { id: 'site2', name: '現場2' },
  { id: 'site3', name: '現場3' },
];
const MEMBERS = (Array.isArray(CFG.members) && CFG.members.length ? CFG.members : DEFAULT_MEMBERS)
  .map((m) => ({ id: String(m.id).replace(/[^A-Za-z0-9_]/g, ''), name: String(m.name || m.id) }))
  .filter((m) => m.id);
const COMPANY = String(CFG.companyKey || '').replace(/[^A-Za-z0-9_]/g, '');
// config.js が読めない・合言葉が無いときは、他社と混線しないよう待受しない
const CONFIG_ERROR = DEMO ? '' : !window.ZUMEN_CONFIG
  ? 'config.js を読み込めませんでした。zumen-call フォルダの中に config.js があるか、書き間違い（カンマ抜けなど）がないか確認してください。'
  : !COMPANY ? 'config.js に合言葉（companyKey）がありません。' : '';
const pidOf = (memberId) => `zumen-${COMPANY}-${memberId}`;
const memberByPid = (pid) => MEMBERS.find((m) => pidOf(m.id) === pid);
const memberById = (id) => MEMBERS.find((m) => m.id === id);
const RING_TIMEOUT = 45_000;
const HOST_WAIT = 90_000;      // 回線断のあと、受けた側が相手の再接続を待つ時間
const GUEST_RETRY = 120_000;   // 回線断のあと、かけた側が再接続を試みる時間
const CALLBACK_TEXT = '今は出られません。あとで折り返します。';

// ---- 待受（このPCを呼び出せる状態にしておく） ----
function startStandby() {
  if (S.peer && !S.peer.destroyed) S.peer.destroy();
  const peer = new Peer(pidOf(S.meId), peerOptions());
  S.peer = peer;
  setMeStatus('接続中…');
  peer.on('open', () => { setMeStatus('待受中', 'ok'); probeAll(true); });
  peer.on('connection', (c) => c.on('open', () => onIncoming(c)));
  peer.on('call', onMediaCall);
  peer.on('disconnected', () => { if (S.peer === peer) setMeStatus('再接続中…', 'bad'); });
  peer.on('error', (e) => {
    if (S.peer !== peer) return;
    if (e.type === 'unavailable-id') {
      setMeStatus(`「${S.name}」は別の画面で使用中です。他のタブ・PCを閉じてください（自動で再試行します）`, 'bad');
      peer.destroy();
    } else if (e.type === 'peer-unavailable') {
      const m = /peer\s+(\S+)/.exec(e.message || '');
      onPeerUnavailable(m ? m[1] : '');
    } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed') {
      setMeStatus('接続サーバーにつながりません。ネット接続を確認してください（自動で再試行します）', 'bad');
    } else {
      console.warn(e);
    }
  });
}

// 映像は、通話中のデータ接続の相手からだけ受ける
function onMediaCall(call) {
  const md = call.metadata || {};
  if (S.inCall && S.conn && call.peer === S.conn.peer && S.localStream) {
    if (isUid(md.relay)) { acceptRelay(call, md.relay); return; } // まとめ役が中継してくれる、ほかの参加者の映像
    call.answer(outStream()); bindCall(call); return;
  }
  const X = S.inCall && S.role === 'host' && extraByPeer(call.peer);
  if (X && S.localStream) { call.answer(outStream()); bindExtraCall(X, call); return; }
  if (S.inCall && md.g && acceptMesh(call)) return;
  call.close();
}

// スリープ復帰やネット切断のあとも自動で待受に戻る
function watchdog() {
  meetWatchdog();
  if (!S.meId || CONFIG_ERROR || DEMO || HOSTED || GUEST_MODE) return;
  if (!S.peer || S.peer.destroyed) startStandby();
  else if (S.peer.disconnected) { try { S.peer.reconnect(); } catch { S.peer.destroy(); } }
}

function onIncoming(c) {
  const md = c.metadata || {};
  const from = memberByPid(c.peer);
  if (from) setPresence(from.id, 'online');
  if (md.type === 'ping') { setTimeout(() => c.close(), 1000); return; }
  if (md.type === 'chat') { acceptChatConn(c, from); return; }
  if (md.type !== 'call' || !from) { c.close(); return; }
  const name = from.name;  // 相手の自己申告ではなく、一覧の名前を使う
  if (md.token) {
    // 通話中の回線断からの再接続 → 鳴らさずにそのままつなぐ
    if (S.inCall && md.token === S.token && c.peer === S.partner) { acceptConn(c); return; }
    const X = S.inCall && S.role === 'host' && extraByToken(md.token, c.peer);
    if (X) { reacceptExtra(X, c); return; }
    // すでに終わった通話への再接続 → 終了を伝えて断る（鳴らさない）
    c.send({ t: 'bye' });
    setTimeout(() => c.close(), 800);
    return;
  }
  // お互いが同時に呼び出した場合：接続IDの小さい側の発信を生かし、もう片方は着信として受ける
  const o = S.outgoing;
  if (o && !o.reconnect && o.peerId === c.peer && !S.inCall && !S.ringing) {
    if (pidOf(S.meId) < c.peer) { c.send({ t: 'busy', glare: true }); setTimeout(() => c.close(), 800); return; }
    abandonOutgoing(o);
  }
  if (S.inCall || S.ringing || S.outgoing) {
    c.send({ t: 'busy' });
    setTimeout(() => c.close(), 800);
    setFlag(from.id, 'missed');
    addChat(from.id, { from: 'sys', text: `着信がありました（${S.inCall ? '通話中' : '取り込み中'}のため出られませんでした）` });
    if (S.inCall) banner(`${name} から着信がありました（通話中のため出られませんでした）`, 10_000);
    return;
  }
  ring(c, name, from, { invite: !!md.invite, party: Array.isArray(md.party) ? md.party.map((x) => cleanText(x, 40)).filter(Boolean).slice(0, MAX_PARTY) : [] });
}

// ---- 着信 ----
function ring(c, name, from, { knock = false, invite = false, party = [] } = {}) {
  const r = { c, name, from, knock, invite, cancelled: false };
  S.ringing = r;
  showCallOverlay(knock ? 'knock' : 'incoming', name);
  if (invite) $('#callStatus').textContent = `から打ち合わせへの呼び出しです${party.length ? `（参加中：${party.join('、')}）` : ''}`;
  startAlert();
  notify(knock ? `${name} が入室を希望しています` : `${name} から着信`, '図面テレビ電話');
  try { window.focus(); } catch { /* 前面に出せない環境もある */ }
  r.timer = setTimeout(() => { if (S.ringing === r) missed(r); }, RING_TIMEOUT + 5000);
  c.on('data', (m) => { if (m.t === 'cancel') { r.cancelled = true; if (S.ringing === r) missed(r); } });
  c.on('close', () => { r.cancelled = true; if (S.ringing === r) missed(r); });
}
function endRinging(r) {
  S.ringing = null;
  clearTimeout(r.timer);
  hideCallOverlay();
  stopAlert();
  closeNotify();
}
function missed(r) {
  endRinging(r);
  const t = hhmm();
  if (r.knock) { if (!r.declined) lobbyMsg(`${r.name} の入室の希望に応答しませんでした（${t}）`); return; }
  setFlag(r.from.id, 'missed');
  addChat(r.from.id, { from: 'sys', text: '不在着信' });
  lobbyMsg(`不在着信：${r.name}（${t}）`);
}
async function answer() {
  const r = S.ringing;
  if (!r) return;
  if (r.demo) { demoAnswer(r); return; }
  if (r.invite) { joinInvite(r); return; }
  endRinging(r);
  S.role = 'host';
  S.partner = r.c.peer;
  S.token = secureId(24);
  S.remoteName = r.name;
  S.external = !!r.knock;
  S.callName = r.knock && S.meeting ? S.meeting.hostName : '';
  enterCall();
  await ensureMedia();
  if (!S.inCall) { try { r.c.send({ t: 'bye' }); } catch { /* 閉じている */ } setTimeout(() => r.c.close(), 500); return; }
  if (r.cancelled || !r.c.open) { hangup(`${r.name} が呼び出しを取り消しました`, false); return; }
  r.c.removeAllListeners('data');
  r.c.removeAllListeners('close');
  acceptConn(r.c);
}
// 出られないとき：「折り返します」を返す（kind='callback'）か、ただ断る（kind='reject'）
function decline(kind = 'reject') {
  const r = S.ringing;
  if (!r) return;
  if (r.demo) { demoDecline(r, kind); return; }
  endRinging(r);
  if (r.knock) {
    r.declined = true;
    try { r.c.send({ t: 'reject' }); } catch { /* 閉じている */ }
    lobbyMsg(`${r.name} の入室をお断りしました`);
  } else if (kind === 'callback') {
    const msg = { id: rid(), text: CALLBACK_TEXT, ts: Date.now() };
    addChat(r.from.id, { ...msg, from: 'me', st: 'sent' });
    setFlag(r.from.id, 'callback');
    r.c.send({ t: 'reject', reason: 'callback', msg });
    lobbyMsg(`${r.name} に「折り返します」と伝えました。一覧の「折り返す」から呼び出せます`);
  } else {
    r.c.send({ t: 'reject' });
  }
  setTimeout(() => r.c.close(), 800);
}

function acceptConn(c) {
  if (S.conn && S.conn !== c) { try { S.conn.close(); } catch { /* 既に閉じている */ } }
  clearTimeout(S.hostWaitTimer);
  S.conn = c;
  bindConn(c);
  fileChannel(c);
  if (!S.uid) S.uid = newUid();
  if (!S.partnerUid) S.partnerUid = newUid();
  c.send({ t: 'accept', token: S.token, name: myCallName() });
  sendHello(c);
  onCallConnected();
  broadcastRoster();
}
function onCallConnected() {
  if (isGroup()) updatePartyStatus(); else setStatus(`${S.remoteName} と通話中`, 'ok');
  if (!S.callStartedAt) S.callStartedAt = Date.now();
  if (S.tr.on) send({ t: 'tr-state', on: true }); // 回線断から戻ったら相手の文字起こしも再開
  S.reconnectUntil = 0;
  const m = memberByPid(S.partner);
  if (m) { clearFlag(m.id); renderChat(); }
  flushChatInCall();
}

// ---- 発信 ----
async function placeCall(member) {
  if (S.inCall || S.outgoing || S.ringing) return;
  if (DEMO) { demoCall(member); return; }
  if (!S.peer || !S.peer.open) { lobbyMsg('接続サーバーにつながっていません。少し待ってからもう一度押してください'); return; }
  lobbyMsg('');
  closeChat();
  const o = { pending: true, name: member.name, peerId: pidOf(member.id), member };
  S.outgoing = o;
  showCallOverlay('outgoing', member.name);
  startTone('ringback');
  await ensureMedia();
  if (S.outgoing !== o) return; // カメラ準備中に取り消された
  S.outgoing = null;
  if (!S.peer || !S.peer.open) {
    hideCallOverlay(); stopTone(); releaseMedia();
    lobbyMsg('接続サーバーとの接続が切れました。少し待ってからもう一度押してください');
    return;
  }
  dial(o.peerId, member.name, false, member);
}

// reconnect=true のときは通話中の再接続（呼出音・着信画面なし）
function dial(peerId, name, reconnect, member = memberByPid(peerId)) {
  const md = GUEST_MODE
    ? { type: 'join', name: G.name, company: G.company, token: reconnect ? S.token : null, ticket: !reconnect && G.ticket ? G.ticket : undefined }
    : { type: 'call', name: S.name, token: reconnect ? S.token : null };
  const c = S.peer && S.peer.open ? S.peer.connect(peerId, { reliable: true, metadata: md }) : null;
  const o = { c, peerId, name, reconnect, member };
  S.outgoing = o;
  if (!c) { endOutgoing(o, reconnect ? null : `${name} につながりませんでした`, 'net'); return; }
  o.timer = setTimeout(() => endOutgoing(o, reconnect ? null : `${name} は応答しませんでした`, 'timeout'), reconnect ? 10_000 : RING_TIMEOUT);
  // 社外のネットワークで直接つながれない（ICE 失敗）ときは、別の回線を勧める
  c.on('iceStateChanged', (st) => { if (st === 'failed') o.iceFailed = true; });
  // 社外の方：相手につながり、すぐに断られなかったら「申し込み中」の画面を出す
  if (GUEST_MODE && !reconnect) {
    c.on('open', () => {
      o.showTimer = setTimeout(() => { if (S.outgoing === o) { showCallOverlay('outgoing', name); startTone('ringback'); } }, 700);
    });
  }
  c.on('data', (m) => {
    if (S.outgoing !== o || !m) return;
    if (m.t === 'accept') { G.ticket = null; onAccepted(o, m); }
    else if (m.t === 'redirect' && GUEST_MODE && !reconnect && typeof m.door === 'string' && m.door.length <= 64 && typeof m.ticket === 'string') {
      // 許可された → 打ち合わせのまとめ役の入口に入り直す
      clearTimeout(o.timer); clearTimeout(o.showTimer);
      S.outgoing = null;
      c.removeAllListeners('close');
      setTimeout(() => c.close(), 300);
      G.ticket = m.ticket.slice(0, 64);
      dial(m.door, name, false, null);
    }
    else if (m.t === 'reject') {
      if (m.reason === 'callback' && member) {
        if (m.msg) addChat(member.id, { ...m.msg, from: 'them' });
        endOutgoing(o, `${name}：「${CALLBACK_TEXT}」`, 'reject');
      } else endOutgoing(o, `${name} は今は出られません`, 'reject');
    } else if (m.t === 'busy') {
      if (m.glare) { clearTimeout(o.timer); S.outgoing = null; return; } // 相手からの着信として受ける
      endOutgoing(o, `${name} は通話中です`, 'busy');
    } else if (m.t === 'bye' && reconnect) {
      clearTimeout(o.timer);
      S.outgoing = null;
      hangup(`${S.remoteName} との通話は終了しています`, false);
    }
  });
  c.on('close', () => { if (S.outgoing === o) endOutgoing(o, reconnect ? null : `${name} につながりませんでした`, o.iceFailed ? 'ice' : 'net'); });
}
function cancelCall() {
  const o = S.outgoing;
  if (!o) { if (GUEST_MODE) guestCancel(); return; }
  clearTimeout(o.timer);
  if (o.pending) { S.outgoing = null; hideCallOverlay(); stopTone(); releaseMedia(); return; }
  try { o.c.send({ t: 'cancel' }); } catch { /* 未接続 */ }
  setTimeout(() => o.c.close(), 500);
  endOutgoing(o, null, 'cancel');
}
// 同時呼び出しで自分の発信を取り下げる（カメラは着信に使うので手放さない）
function abandonOutgoing(o) {
  clearTimeout(o.timer);
  S.outgoing = null;
  if (o.c) { try { o.c.send({ t: 'cancel' }); } catch { /* 未接続 */ } setTimeout(() => o.c.close(), 500); }
  hideCallOverlay();
  stopTone();
}
function endOutgoing(o, msg, why = '') {
  if (S.outgoing !== o) return;
  clearTimeout(o.timer);
  clearTimeout(o.showTimer);
  S.outgoing = null;
  if (o.reconnect) { if (o.c) { try { o.c.close(); } catch { /* 既に閉じている */ } } scheduleReconnect(3000); return; }
  hideCallOverlay();
  stopTone();
  if (GUEST_MODE) { if (o.c) { try { o.c.close(); } catch { /* 既に閉じている */ } } guestOutcome(why); return; }
  if (!S.inCall) releaseMedia();
  if (msg) lobbyMsg(msg);
}
function onPeerUnavailable(peerId) {
  const m = memberByPid(peerId);
  if (m) setPresence(m.id, 'offline');
  for (const inv of S.invites.values()) if (inv.c.peer === peerId) inv.done(`${inv.m.name} を呼び出せません（相手のPCの電源・スリープ・ネット接続を確認してください）`);
  const o = S.outgoing;
  if (o && o.peerId === peerId && !o.pending) endOutgoing(o, o.reconnect ? null : `${o.name} を呼び出せません（相手のPCの電源・スリープ・ネット接続を確認してください）`, 'absent');
}
function onAccepted(o, m) {
  clearTimeout(o.timer);
  clearTimeout(o.showTimer);
  S.outgoing = null;
  o.c.removeAllListeners('data');
  o.c.removeAllListeners('close');
  if ((o.reconnect && !S.inCall) || !S.localStream) { try { o.c.send({ t: 'bye' }); } catch { /* 閉じている */ } setTimeout(() => o.c.close(), 500); return; }
  hideCallOverlay();
  stopTone();
  S.role = 'guest';
  S.partner = o.peerId;
  S.token = m.token;
  S.remoteName = (o.member && o.member.name) || m.name || o.name;
  if (!S.inCall) enterCall();
  S.conn = o.c;
  bindConn(o.c);
  fileChannel(o.c);
  const call = S.peer.call(o.peerId, outStream(), { metadata: { token: S.token } });
  if (call) bindCall(call);
  sendHello();
  onCallConnected();
}

let reconnectTimer = null;
function scheduleReconnect(ms) {
  if (!S.inCall || S.role !== 'guest' || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!S.inCall || (S.conn && S.conn.open) || S.outgoing) return;
    if (S.reconnectUntil && Date.now() > S.reconnectUntil) { hangup('回線が戻らなかったため、通話を終了しました', true); return; }
    if (!S.peer || S.peer.destroyed || S.peer.disconnected || !S.peer.open) { watchdog(); scheduleReconnect(2000); return; }
    dial(S.partner, S.remoteName, true);
  }, ms);
}

// ---- 通話画面への切替と終了 ----
function enterCall() {
  resetCallRecord();
  S.inCall = true;
  if (GUEST_MODE) { S.external = true; $('#guest').hidden = true; }
  S.extChat = [];
  $('#leaveBtn').textContent = GUEST_MODE ? '退室する' : '通話を終了';
  $('#saveBtn').classList.toggle('guest-hide', GUEST_MODE); // 社外の方には「保存」を出さない
  $('#recordBtn').classList.toggle('guest-hide', GUEST_MODE);
  buildQuick();
  el.lobby.hidden = true;
  el.room.hidden = false;
  closeChat();
  for (const id of ['#micBtn', '#camBtn']) { const b = $(id); b.classList.remove('off'); b.textContent = id === '#micBtn' ? 'マイク' : 'カメラ'; }
  prevStats.inBytes = 0; prevStats.inTs = 0;
  refreshLocalVideos();
  layout();
  setTool(S.tool);
  updateToolbar();
  updateChatBadges();
  setStatus('接続中…');
}

function hangup(msg, notifyPeer = true) {
  if (!S.inCall) return;
  if (notifyPeer) send({ t: 'bye' }); // まとめ役が終えると、全員の打ち合わせが終わる
  stopTr(false);
  const minutesInput = collectMinutesInput();
  const record = GUEST_MODE ? null : snapshotRecord(); // 図面を片付ける前に、保存用に取っておく
  S.inCall = false;
  const conn = S.conn, call = S.call;
  S.conn = null; S.call = null;
  setTimeout(() => { try { call && call.close(); conn && conn.close(); } catch { /* 既に閉じている */ } }, 300);
  clearTimeout(reconnectTimer); reconnectTimer = null;
  clearTimeout(S.hostWaitTimer);
  S.reconnectUntil = 0;
  const o = S.outgoing;
  if (o && o.reconnect) { clearTimeout(o.timer); S.outgoing = null; if (o.c) { try { o.c.close(); } catch { /* 既に閉じている */ } } }
  setRemoteStream(null);
  resetParty();
  endShare();
  // 通話中のデータを片付ける（図面はメモリから消す）
  for (const d of S.docs.values()) { try { d.pdf && d.pdf.destroy(); d.img && d.img.close && d.img.close(); } catch { /* 解放済み */ } }
  lowCache.clear();
  S.docs.clear(); S.strokes.clear(); S.strokeById.clear(); S.incoming.clear(); S.pointers.clear();
  S.myStack = []; S.content = { type: 'none' }; S.contentTs = 0; S.cur = null; S.partner = null; S.token = null;
  for (const t of docReqTimers.values()) clearTimeout(t);
  docReqTimers.clear();
  S.previews.clear();
  renderTabs();
  if (S.quality !== 'std') setQuality('std');
  progress(null); banner(null);
  closeChat();
  const wasExternal = S.external;
  S.external = GUEST_MODE; S.extChat = [];
  if (EXT in S.unread || GRP in S.unread) { delete S.unread[EXT]; delete S.unread[GRP]; store.set('unread', S.unread); }
  if (el.room.classList.contains('full')) setFullscreen(false);
  el.room.hidden = true;
  releaseMedia();
  if (GUEST_MODE) { showGuest('ended', msg || '打ち合わせは終了しました。このページは閉じてかまいません。'); return; }
  el.lobby.hidden = false;
  lobbyMsg(msg || (wasExternal ? '打ち合わせを終了しました' : '通話を終了しました'));
  probeAll(true);
  // 文字起こしかチャットがあれば、議事録を作る
  if (MINUTES_ON && (minutesInput.lines.length || minutesInput.chats.length)) openMinutes(minutesInput);
  else if (recordHasContent(record)) askSaveRecord(record);
}

function bindConn(c) {
  c.on('data', (m) => onLinkData(c, m));
  c.on('close', () => onConnClosed(c));
  c.on('error', () => onConnClosed(c));
}

function onConnClosed(c) {
  if (S.inCall && S.role === 'host' && c !== S.conn) { const X = extraByConn(c); if (X) extraDown(X); return; }
  if (S.conn !== c || !S.inCall) return;
  S.conn = null;
  S.incoming.clear();
  progress(null);
  if (S.call) { try { S.call.close(); } catch { /* 既に閉じている */ } S.call = null; }
  setRemoteStream(null);
  S.pointers.delete('remote');
  if (S.role === 'host') {
    if (S.extras.size) { banner(`${S.remoteName} との回線が切れました。再接続を待っています`, 6000); broadcastRoster(); }
    else setStatus(`回線が切れました。相手からの再接続を待っています（${HOST_WAIT / 1000}秒で自動終了）`, 'bad');
    clearTimeout(S.hostWaitTimer);
    S.hostWaitTimer = setTimeout(() => primaryGone(`${S.remoteName} との接続が戻らなかったため、通話を終了しました`), HOST_WAIT);
  } else {
    setStatus('回線が切れました。再接続しています…', 'bad');
    if (!S.reconnectUntil) S.reconnectUntil = Date.now() + GUEST_RETRY;
    scheduleReconnect(1500);
  }
}

function bindCall(call) {
  if (S.call && S.call !== call) { try { S.call.close(); } catch { /* 既に閉じている */ } }
  S.call = call;
  call.on('stream', (st) => {
    if (S.call !== call) return;
    setRemoteStream(st);
    if (S.share) for (const sd of videoSenders()) sd.replaceTrack(S.share.track).catch(() => {});
    setTimeout(applyQuality, 500);
  });
  call.on('close', () => {
    if (S.call !== call) return;
    S.call = null;
    setRemoteStream(null);
    // 映像だけが切れた（データの接続は生きている）→ かけた側が映像をかけ直す
    if (S.inCall && S.role === 'guest') {
      setTimeout(() => {
        if (!S.inCall || S.call || !S.conn || !S.conn.open || !S.localStream) return;
        const nc = S.peer.call(S.partner, outStream(), { metadata: { token: S.token } });
        if (nc) bindCall(nc);
      }, 2000);
    }
  });
}

function setRemoteStream(st) {
  S.remoteStream = st;
  el.remoteAudio.srcObject = st;
  if (st) el.remoteAudio.play().catch((e) => { if (e.name === 'NotAllowedError') banner('画面をクリックすると音声が出ます', 0); });
  el.remoteWipe.querySelector('video').srcObject = st;
  el.remoteWipe.querySelector('.wipe-label').textContent = S.remoteName;
  updateWipes();
  partyMedia();
  if (S.content.type === 'live') attachStageVideo();
}

// 送る：参加者はまとめ役へ、まとめ役は全員へ
function links() {
  const out = [];
  if (S.conn && S.conn.open) out.push(S.conn);
  for (const X of S.extras.values()) if (X.c && X.c.open) out.push(X.c);
  return out;
}
function sendTo(c, m) {
  if (c && c.open) { try { c.send(m); } catch (e) { console.warn(e); } }
}
function send(m) {
  for (const c of links()) sendTo(c, m);
}

// 大きなデータは順番を守り、送信バッファがあふれないように送る
let queue = Promise.resolve();
function sendQueued(fn) {
  queue = queue.then(fn).catch((e) => console.warn(e));
  return queue;
}
async function waitDrain(c) {
  for (;;) {
    if (!c || !c.open || !linkAlive(c)) return false;
    const dc = c.dataChannel;
    // 図面送信中もポインター等が遅れすぎないよう、ためる量は少なめにする
    if ((!dc || dc.bufferedAmount < 256 * 1024) && !(c.bufferSize > 0)) return true;
    await sleep(15);
  }
}

function sendHello(c = S.conn) {
  const m = { t: 'hello', name: myCallName(), docs: [...S.docs.keys()], contentTs: S.contentTs, role: S.role };
  const X = extraByConn(c);
  if (S.role === 'host' && TH && (S.external || (X && X.external))) Object.assign(m, themeMsg());
  sendTo(c, m);
}

// ===================================================================
// 相手が待受中かどうか（一覧の表示用）
// ===================================================================
const presence = new Map();
function setPresence(id, st) {
  const prev = presence.get(id);
  presence.set(id, st);
  if (prev !== st) renderContacts();
  if (st === 'online' && hasPendingChat(id)) deliverChat(id);
}
// 画面が見えているときだけ確認する（最小化中に24時間通信し続けないため）。未送信のチャットがある相手は見えていなくても確認する
function probeAll(force = false) {
  if (GUEST_MODE || HOSTED || !S.meId || !S.peer || !S.peer.open || S.inCall) return;
  const visible = !el.lobby.hidden && document.visibilityState === 'visible';
  for (const m of MEMBERS) {
    if (m.id === S.meId) continue;
    if (!(force || visible || hasPendingChat(m.id))) continue;
    const c = S.peer.connect(pidOf(m.id), { metadata: { type: 'ping' } });
    if (!c) continue;
    const to = setTimeout(() => c.close(), 10_000);
    c.on('open', () => { clearTimeout(to); setPresence(m.id, 'online'); setTimeout(() => c.close(), 300); });
  }
}

// ===================================================================
// 着信の知らせ方（音・画面の点滅）・通知
// ===================================================================
let AC = null;
let tone = null;
function audioCtx() {
  if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch { AC = null; } }
  return AC;
}
function beep(ac, out, at, dur, freq, vol, type = 'sine') {
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(vol, at + 0.01);
  g.gain.setValueAtTime(vol, at + dur - 0.02);
  g.gain.linearRampToValueAtTime(0, at + dur);
  o.connect(g).connect(out);
  o.start(at);
  o.stop(at + dur);
}
// タブが裏にあっても鳴り続けるよう、最初に 60 秒ぶんを予約しておく
// kind: 'ring'（着信）/ 'ringback'（呼出音）/ 'chat'（メッセージ着信）
function startTone(kind, opts = {}) {
  if (kind !== 'chat') stopTone();
  const ac = audioCtx();
  if (!ac) return;
  if (ac.state !== 'running') ac.resume().catch(() => {});
  const a = S.alert;
  const sound = opts.sound || a.sound;
  const vol = opts.volume ?? a.volume;
  if (sound === 'off' && kind !== 'ringback') return;
  const out = ac.createGain();
  out.connect(ac.destination);
  const t0 = ac.currentTime + 0.05;
  const secs = opts.seconds || 60;
  if (kind === 'ring' && sound === 'loud') {
    // 工場・現場向け：騒音の中でも聞き取りやすい 2〜3kHz の断続音を大きめに
    for (let k = 0; k < secs; k++) {
      for (let i = 0; i < 4; i++) beep(ac, out, t0 + k + i * 0.11, 0.08, i % 2 ? 2400 : 3150, 0.55 * vol, 'square');
    }
  } else if (kind === 'ring') {
    for (let k = 0; k < secs / 2; k++) {
      for (let i = 0; i < 6; i++) beep(ac, out, t0 + k * 2 + i * 0.12, 0.1, i % 2 ? 1046 : 1318, 0.35 * vol);
    }
  } else if (kind === 'chat') {
    const loud = sound === 'loud';
    beep(ac, out, t0, 0.09, loud ? 2400 : 1318, (loud ? 0.45 : 0.3) * vol, loud ? 'square' : 'sine');
    beep(ac, out, t0 + 0.14, 0.12, loud ? 3150 : 1760, (loud ? 0.45 : 0.3) * vol, loud ? 'square' : 'sine');
    return;
  } else {
    for (let k = 0; k < 20; k++) beep(ac, out, t0 + k * 3, 1, 400, 0.12);
  }
  tone = out;
  if (kind !== 'chat') flashTitle(kind === 'ring' ? '着信中' : '呼び出し中');
}
function stopTone() {
  if (tone) { try { tone.disconnect(); } catch { /* 停止済み */ } tone = null; }
  flashTitle(null);
}
function startAlert() {
  startTone('ring');
  $('#callOverlay').classList.toggle('flash', !!S.alert.flash);
}
function stopAlert() {
  stopTone();
  $('#callOverlay').classList.remove('flash');
}

let titleTimer = null;
const appTitle = DEMO ? '図面テレビ電話（デモ）' : GUEST_MODE ? 'オンライン打ち合わせ' : document.title;
function baseTitle() {
  const n = unreadTotal() + flagCount();
  return n ? `(${n}) ${appTitle}` : appTitle;
}
function flashTitle(t) {
  clearInterval(titleTimer);
  titleTimer = null;
  document.title = baseTitle();
  if (!t) return;
  let on = false;
  titleTimer = setInterval(() => { on = !on; document.title = on ? `■ ${t}` : baseTitle(); }, 800);
}
function refreshTitle() { if (!titleTimer) document.title = baseTitle(); }

let lastNotice = null;
function notify(title, body) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    closeNotify();
    const n = new Notification(title, { body, requireInteraction: true, tag: 'zumen-call' });
    n.onclick = () => { window.focus(); n.close(); };
    lastNotice = n;
    setTimeout(() => n.close(), RING_TIMEOUT);
  } catch { /* 通知に未対応 */ }
}
function closeNotify() { if (lastNotice) { try { lastNotice.close(); } catch { /* 閉じ済み */ } lastNotice = null; } }
function soundReady() { return !!AC && AC.state === 'running'; }
function unlockSound() {
  const ac = audioCtx();
  if (ac && ac.state !== 'running') ac.resume().then(updateBellHint).catch(() => {});
  // 通知（最小化中の着信をデスクトップに出す）の許可は、このPCで最初の1回だけ聞く。あとは「着信の知らせ方」から
  if (!GUEST_MODE && !DEMO && !store.get('notifyAsked', false)) { store.set('notifyAsked', true); askNotify(); }
}
function askNotify() {
  try { if ('Notification' in window && Notification.permission === 'default') return Notification.requestPermission().catch(() => {}); } catch { /* 未対応 */ }
  return Promise.resolve();
}
function updateNotifyRow() {
  const row = $('#notifyRow');
  if (!row) return;
  const st = 'Notification' in window ? Notification.permission : 'none';
  row.hidden = st === 'none' || st === 'granted';
  $('#notifyText').textContent = st === 'denied'
    ? 'デスクトップ通知はブロックされています。使うときは、アドレス欄の左のマークから「通知」を「許可」にしてください。'
    : '画面を最小化していても、着信をデスクトップの通知でお知らせできます。';
  $('#notifyBtn').hidden = st !== 'default';
}
function updateBellHint() {
  const h = $('#bellHint');
  if (!h) return;
  const ok = soundReady();
  const a = S.alert;
  if (!ok) h.textContent = '着信音を鳴らすには、この画面を一度クリックしてください';
  else h.textContent = `着信：${a.flash ? '画面全体を点滅' : '普通に表示'}・${{ loud: '大きく高い音', normal: '標準の音', off: '音なし' }[a.sound]}`;
  h.classList.toggle('warn', !ok);
}

// 相手の印：数字で終わる名前は大字（現場1 → 壱）、それ以外は先頭の1文字
const DAIJI = ['零', '壱', '弐', '参', '肆', '伍', '陸', '漆', '捌', '玖'];
function markOf(name) {
  const m = /(\d+)$/.exec(name);
  return m ? (m[1].length === 1 ? DAIJI[m[1]] : m[1]) : name.slice(0, 1);
}

// ---- 着信・発信の画面 ----
function showCallOverlay(kind, name, { keepDialogs = false } = {}) {
  // 開いている画面（議事録・設定など）があると着信画面が隠れるので閉じる（議事録は閉じるときに保存される）
  if (!keepDialogs) $$('dialog[open]').forEach((d) => d.close());
  const ringing = kind === 'incoming' || kind === 'knock';
  // 社外の方は「佐藤様（△△工業）」→ 名前を大きく、会社名は下の行に
  const m = kind === 'knock' && /^(.*?)（(.*)）$/.exec(name);
  $('#callName').textContent = m ? m[1] : name;
  $('#callAvatar').textContent = markOf(name);
  $('.call-keys').textContent = kind === 'knock' ? 'キーボード：Enter＝入室を許可　Esc＝お断り' : 'キーボード：Enter＝出る　Esc＝折り返します';
  $('#callKanji').textContent = ringing ? '着信' : GUEST_MODE ? '入室' : '発信';
  $('#callStatus').textContent = kind === 'knock' ? `${m ? m[2] + '　' : ''}招待リンクから入室を希望しています`
    : kind === 'incoming' ? 'から着信しています'
    : GUEST_MODE ? 'に入室を申し込んでいます。相手が許可すると始まります…' : 'を呼び出しています…';
  for (const id of ['#answerBtn', '#declineBtn']) $(id).hidden = !ringing;
  $('#callbackBtn').hidden = kind !== 'incoming';
  $('#answerBtn').textContent = kind === 'knock' ? '入室を許可' : '出る';
  $('#declineBtn').textContent = kind === 'knock' ? 'お断りする' : '何も伝えずに拒否';
  $('#cancelBtn').hidden = ringing;
  $('#cancelBtn').textContent = GUEST_MODE ? '申し込みをやめる' : '取り消す';
  $$('#callOverlay .shot').forEach((x) => x.remove());
  $('#callOverlay').dataset.kind = kind;
  $('#callOverlay').classList.remove('flash');
  $('#callOverlay').hidden = false;
}
function hideCallOverlay() { $('#callOverlay').hidden = true; }

// ===================================================================
// チャット・不在着信・折り返し（相手ごとの履歴はこのPCに保存）
// ===================================================================
const hhmm = (ts = Date.now()) => new Date(ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
const CHAT_MAX = 300;
const chatCache = new Map();
const EXT = 'ext'; // 社外の方とのチャットの番号（保存しない）
const GRP = 'grp'; // 複数人の打ち合わせのチャット（保存しない）
function partnerChatId() {
  if (isGroup()) return GRP;
  if (S.external) return S.inCall ? EXT : null;
  const m = S.partner && memberByPid(S.partner);
  return m ? m.id : null;
}
const chatName = (id) => (id === GRP ? `打ち合わせの全員（${S.party.list.length}人）` : id === EXT ? S.remoteName : (memberById(id) || {}).name || '');
function chatLog(id) {
  if (id === GRP) return S.grpChat;
  if (id === EXT) return S.extChat;
  if (!chatCache.has(id)) chatCache.set(id, store.get('chat.' + id, []));
  return chatCache.get(id);
}
function saveChat(id) {
  const log = chatLog(id);
  if (log.length > CHAT_MAX) log.splice(0, log.length - CHAT_MAX);
  if (id === EXT || id === GRP) return;
  store.set('chat.' + id, log);
}
function addChat(id, entry) {
  if (!memberById(id) && id !== EXT && id !== GRP) return null;
  const log = chatLog(id);
  if (entry.id && log.some((x) => x.id === entry.id)) return null; // 同じメッセージの二重受信
  const e = { id: entry.id || rid(), ts: entry.ts || Date.now(), from: entry.from, text: String(entry.text || '').slice(0, 2000), st: entry.st };
  if (entry.name) e.name = entry.name;
  log.push(e);
  saveChat(id);
  if (e.from === 'them' || (e.from === 'sys' && entry.unread !== false)) {
    if (!(chat.open === id && document.visibilityState === 'visible')) S.unread[id] = (S.unread[id] || 0) + (e.from === 'them' ? 1 : 0);
    store.set('unread', S.unread);
  }
  if (chat.open === id) renderChat();
  renderContacts();
  updateChatBadges();
  refreshTitle();
  return e;
}
function unreadTotal() { return Object.values(S.unread).reduce((a, b) => a + (b || 0), 0); }
function flagCount() { return Object.keys(S.flags).length; }
function setFlag(id, kind) {
  S.flags[id] = { kind, ts: Date.now() };
  store.set('flags', S.flags);
  renderContacts();
  refreshTitle();
}
function clearFlag(id) {
  if (!S.flags[id]) return;
  delete S.flags[id];
  store.set('flags', S.flags);
  renderContacts();
  refreshTitle();
}
function hasPendingChat(id) { return chatLog(id).some((e) => e.from === 'me' && e.st === 'pending'); }

// 送る：通話中の相手ならその接続で、それ以外はチャット用の接続を開いて送る。届かなければ相手が待受に戻ったときに自動で送り直す
function sendChat(id, text) {
  text = text.trim();
  if (!text) return;
  addChat(id, { from: 'me', text, st: 'pending' });
  deliverChat(id);
}
function inCallWith(id) { return S.inCall && links().length > 0 && partnerChatId() === id; }
function flushChatInCall() {
  const id = partnerChatId();
  if (id) deliverChat(id);
}
const chatConns = new Map();
function deliverChat(id) {
  const pending = chatLog(id).filter((e) => e.from === 'me' && e.st === 'pending');
  if (!pending.length) return;
  if (DEMO) { demoChatReply(id, pending); return; }
  if (inCallWith(id)) {
    for (const e of pending) send({ t: 'chat', msg: { id: e.id, text: e.text, ts: e.ts } });
    if (id === GRP) { for (const e of pending) e.st = 'sent'; if (chat.open === id) renderChat(); } // 複数人のときは受け取りの返事を待たない
    return;
  }
  if (id === EXT || id === GRP || !S.peer || !S.peer.open) return;
  let c = chatConns.get(id);
  const go = () => { for (const e of chatLog(id).filter((x) => x.from === 'me' && x.st === 'pending')) c.send({ t: 'chat', msg: { id: e.id, text: e.text, ts: e.ts } }); };
  if (c && c.open) { go(); return; }
  if (c) return; // 接続中
  c = S.peer.connect(pidOf(id), { reliable: true, metadata: { type: 'chat', name: S.name } });
  if (!c) return;
  chatConns.set(id, c);
  const idle = () => { clearTimeout(c._idle); c._idle = setTimeout(() => c.close(), 20_000); };
  c.on('open', () => { setPresence(id, 'online'); go(); idle(); });
  c.on('data', (m) => { if (m.t === 'chat-ack') markSent(id, m.id); else if (m.t === 'chat') receiveChat(id, m.msg, c); idle(); });
  c.on('close', () => { if (chatConns.get(id) === c) chatConns.delete(id); });
  c.on('error', () => { if (chatConns.get(id) === c) chatConns.delete(id); });
  setTimeout(() => { if (!c.open) { c.close(); if (chatConns.get(id) === c) chatConns.delete(id); } }, 12_000);
}
function markSent(id, msgId) {
  const e = chatLog(id).find((x) => x.id === msgId);
  if (!e || e.st === 'sent') return;
  e.st = 'sent';
  saveChat(id);
  if (chat.open === id) renderChat();
}
function acceptChatConn(c, from) {
  if (!from) { c.close(); return; }
  if (!chatConns.has(from.id)) chatConns.set(from.id, c);
  const idle = () => { clearTimeout(c._idle); c._idle = setTimeout(() => c.close(), 30_000); };
  idle();
  c.on('data', (m) => { if (m.t === 'chat') receiveChat(from.id, m.msg, c); else if (m.t === 'chat-ack') markSent(from.id, m.id); idle(); });
  c.on('close', () => { if (chatConns.get(from.id) === c) chatConns.delete(from.id); });
  deliverChat(from.id);
}
function receiveChat(id, msg, conn) {
  if (!msg || !isId(msg.id) || typeof msg.text !== 'string') return;
  if (!finite(msg.ts)) msg.ts = Date.now();
  const ack = { t: 'chat-ack', id: msg.id };
  if (conn) { try { conn.send(ack); } catch { /* 閉じている */ } } else send(ack);
  const e = addChat(id, { id: msg.id, ts: msg.ts, text: msg.text, from: 'them' });
  if (!e) return;
  if (chat.open === id && document.visibilityState === 'visible') return;
  startTone('chat');
  const name = chatName(id);
  notify(`${name} からメッセージ`, e.text.slice(0, 80));
  if (S.inCall) banner(`${name}：${e.text.slice(0, 60)}`, 6000);
}

// ---- チャット画面 ----
const chat = { open: null };
const QUICK = ['了解しました', '少し待ってください', 'あとで折り返します', 'OKです', 'NGです', '図面を確認します', '今から電話します'];
const QUICK_EXT = ['承知しました', '少々お待ちください', '図面を確認します', '画面を共有します', '資料をお送りします', 'ありがとうございます'];
// 定型文：社外の方とは丁寧な言い方にする
function buildQuick() {
  const q = $('#chatQuick');
  const list = S.external ? QUICK_EXT : QUICK;
  if (q.dataset.set === String(S.external)) return;
  q.dataset.set = String(S.external);
  q.innerHTML = '';
  for (const t of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost quick';
    b.textContent = t;
    b.addEventListener('click', () => { if (chat.open) sendChat(chat.open, t); });
    q.appendChild(b);
  }
}
function openChat(id) {
  if (!memberById(id) && id !== EXT && id !== GRP) return;
  buildQuick();
  chat.open = id;
  S.unread[id] = 0;
  store.set('unread', S.unread);
  const panel = $('#chatPanel');
  // 通話中は上下のバー（終了ボタン・ツールバー）を隠さない
  panel.style.top = S.inCall ? $('.topbar').getBoundingClientRect().bottom + 'px' : '0';
  panel.style.bottom = S.inCall ? $('.toolbar').offsetHeight + 'px' : '0';
  panel.hidden = false;
  $('#chatTitle').textContent = chatName(id);
  renderChat();
  renderContacts();
  updateChatBadges();
  refreshTitle();
  setTimeout(() => $('#chatInput').focus(), 50);
}
function closeChat() {
  chat.open = null;
  $('#chatPanel').hidden = true;
}
function renderChat() {
  const id = chat.open;
  if (!id) return;
  const list = $('#chatList');
  list.innerHTML = '';
  let lastDay = '';
  for (const e of chatLog(id)) {
    const day = new Date(e.ts).toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
    if (day !== lastDay) {
      lastDay = day;
      const d = document.createElement('div');
      d.className = 'chat-day';
      d.textContent = day;
      list.appendChild(d);
    }
    const row = document.createElement('div');
    row.className = 'chat-row ' + e.from;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = e.text;
    const meta = document.createElement('span');
    meta.className = 'chat-meta';
    meta.textContent = (e.from === 'them' && e.name ? e.name + '　' : '') + hhmm(e.ts) + (e.from === 'me' ? (e.st === 'pending' ? ' 未送信（相手の待受に戻ると自動で送ります）' : ' 送信済み') : '');
    row.append(bubble, meta);
    list.appendChild(row);
  }
  list.scrollTop = list.scrollHeight;
  const callBtn = $('#chatCallBtn');
  callBtn.hidden = S.inCall || id === EXT || id === GRP;
}
function updateChatBadges() {
  const b = $('#chatBtnBadge');
  if (!b) return;
  const id = partnerChatId();
  const n = id ? S.unread[id] || 0 : 0;
  b.textContent = n;
  b.hidden = !n;
}

// ===================================================================
// デモモード（PC・スマホ1台でのプレゼン用）
//   発信 → 数秒後に同じ画面で「相手側の着信画面」を見せる → 「出る」で自分のカメラを相手の映像として映す
// ===================================================================
async function demoCall(member) {
  lobbyMsg('');
  closeChat();
  const o = { pending: true, demo: true, name: member.name, peerId: pidOf(member.id), member };
  S.outgoing = o;
  showCallOverlay('outgoing', member.name);
  startTone('ringback');
  await ensureMedia();
  if (S.outgoing !== o) return;
  o.timer = setTimeout(() => {
    if (S.outgoing !== o) return;
    S.outgoing = null;
    stopTone();
    demoRing(member);
  }, 2500);
}
function demoRing(member) {
  const r = { demo: true, member, name: S.name, from: member, cancelled: false };
  S.ringing = r;
  showCallOverlay('incoming', S.name);
  $('#callStatus').textContent = `から着信しています（デモ：相手「${member.name}」の画面）`;
  startAlert();
  r.timer = setTimeout(() => { if (S.ringing === r) { endRinging(r); releaseMedia(); lobbyMsg(`デモ：${member.name} は応答しませんでした（相手の画面には「不在着信」が残ります）`); } }, RING_TIMEOUT);
}
async function demoAnswer(r) {
  endRinging(r);
  S.role = 'guest';
  S.partner = pidOf(r.member.id);
  S.token = rid();
  S.remoteName = r.member.name;
  enterCall();
  const st = await ensureMedia();
  if (!S.inCall) return;
  // 相手の映像として、このPC（スマホ）のカメラを映す
  setRemoteStream(st || S.localStream);
  onCallConnected();
  setStatus(`${r.member.name} と通話中（デモ）`, 'ok');
  el.statsText.textContent = 'デモ：相手の映像には、この端末のカメラを映しています';
}
function demoDecline(r, kind) {
  endRinging(r);
  releaseMedia();
  if (kind === 'callback') {
    addChat(r.member.id, { from: 'them', text: CALLBACK_TEXT });
    lobbyMsg(`${r.member.name}：「${CALLBACK_TEXT}」（デモ：相手の一覧には「折り返し予定」が残ります）`);
  } else {
    lobbyMsg(`${r.member.name} は今は出られません`);
  }
}
const DEMO_REPLIES = ['了解しました', '確認します。少し待ってください', 'OKです。その寸法で加工します', '図面を見ました。ありがとうございます'];
let demoReplyIdx = 0;
function demoChatReply(id, pending) {
  for (const e of pending) e.st = 'sent';
  saveChat(id);
  if (chat.open === id) renderChat();
  setTimeout(() => {
    const text = DEMO_REPLIES[demoReplyIdx++ % DEMO_REPLIES.length] + '（デモの自動返信）';
    receiveChat(id, { id: rid(), ts: Date.now(), text }, { send() {} });
  }, 1500);
}

// ===================================================================
// 文字起こし・字幕・議事録
//   各端末は「自分のマイクの声」だけを文字にして相手へ送る（双方の発言が名前つきでそろう）
//   議事録は config.js に Claude の API キーがあれば AI がまとめ、なければ下書き（発言記録つき）を作る
//   ※ ブラウザの文字起こしは音声をブラウザ提供元（Chrome なら Google）のサーバーで文字にする。
//     AI のまとめは記録を Anthropic（Claude）に送る。どちらも利用者の了承のもとで使う機能。
// ===================================================================
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const MINUTES_MODEL = 'claude-opus-5-5';
let recog = null;

function resetCallRecord() {
  stopTr(false);
  S.tr = { on: false, lines: [] };
  S.callDocs = new Set();
  S.callStartedAt = 0;
}
function startTr(announce = true) {
  if (S.tr.on || !S.inCall) return;
  if (!SR) {
    banner('このブラウザは文字起こしに対応していません（Chrome・Edge・Safari で使えます）', 8000);
    if (announce) send({ t: 'msg', text: `${S.name} の端末は文字起こしに対応していないため、${S.name} の発言は記録されません` });
    return;
  }
  S.tr.on = true;
  if (announce) send({ t: 'tr-state', on: true });
  runRecog();
  updateTrBtn();
  banner(`文字起こしを開始しました。話した内容が文字になり、${TR_USE}`, 5000);
}
function runRecog() {
  const r = new SR();
  r.lang = 'ja-JP';
  r.continuous = true;
  r.interimResults = true;
  r.onresult = (e) => {
    const mic = S.localStream && S.localStream.getAudioTracks()[0];
    if (mic && !mic.enabled) return; // マイクをオフにしている間は記録しない
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const text = (res[0] && res[0].transcript || '').trim();
      if (!text) continue;
      if (res.isFinal) {
        const line = { id: rid(), ts: Date.now(), text };
        addTrLine('me', S.name, line);
        send({ t: 'tr', line });
      } else interim += text;
    }
    if (interim) showCaption('me', S.name, interim);
  };
  r.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      stopTr(true);
      banner('文字起こしを使えません（マイクの許可とネット接続を確認してください）', 8000);
    }
  };
  // 無音が続くと止まるので、オンの間は自動で再開する
  r.onend = () => { if (recog === r && S.tr.on && S.inCall) setTimeout(() => { if (recog === r && S.tr.on) { try { r.start(); } catch { /* 開始済み */ } } }, 300); };
  recog = r;
  try { r.start(); } catch { /* 開始済み */ }
}
function stopTr(announce = true) {
  if (!S.tr || !S.tr.on) { updateTrBtn(); return; }
  S.tr.on = false;
  const r = recog;
  recog = null;
  try { r && r.stop(); } catch { /* 停止済み */ }
  if (announce) send({ t: 'tr-state', on: false });
  updateTrBtn();
}
function updateTrBtn() {
  const b = $('#trBtn');
  if (!b) return;
  const on = !!(S.tr && S.tr.on);
  b.classList.toggle('on', on);
  b.textContent = on ? '文字起こし中' : '文字起こし';
}
function addTrLine(who, name, line) {
  if (!line || !line.text || S.tr.lines.some((x) => x.id === line.id)) return;
  S.tr.lines.push({ id: line.id, ts: line.ts || Date.now(), who, name, text: String(line.text).slice(0, 1000) });
  showCaption(who, name, line.text);
}
// 字幕（画面下）：話した人ごとに最新の一文を表示し、6秒で消す
const capTimers = {};
function showCaption(who, name, text) {
  const box = $('#captions');
  if (!box) return;
  let row = box.querySelector(`[data-who="${who}"]`);
  if (!row) {
    row = document.createElement('div');
    row.className = 'cap ' + (who === 'me' ? 'me' : 'them');
    row.dataset.who = who;
    row.append(document.createElement('b'), document.createElement('span'));
    box.appendChild(row);
  }
  row.querySelector('b').textContent = name + '：';
  row.querySelector('span').textContent = text;
  row.hidden = false;
  clearTimeout(capTimers[who]);
  capTimers[who] = setTimeout(() => { row.hidden = true; }, 6000);
}

function collectMinutesInput() {
  const m = S.partner && memberByPid(S.partner);
  const start = S.callStartedAt || Date.now();
  const chats = m ? chatLog(m.id).filter((e) => e.ts >= start && e.from !== 'sys').map((e) => ({ ts: e.ts, name: e.from === 'me' ? S.name : S.remoteName, text: e.text })) : [];
  for (const e of S.grpChat) if (e.from !== 'sys') chats.push({ ts: e.ts, name: e.from === 'me' ? myCallName() : e.name || '', text: e.text });
  const others = S.party.list.filter((p) => p.uid !== S.uid).map((p) => p.name);
  return {
    start, end: Date.now(), me: S.name, partner: others.length > 1 ? others.join('、') : S.remoteName,
    docs: [...(S.callDocs || [])],
    lines: [...(S.tr ? S.tr.lines : [])].sort((a, b) => a.ts - b.ts),
    chats,
  };
}
const fmtDate = (ts) => new Date(ts).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
function minutesHeader(inp) {
  const mins = Math.max(1, Math.round((inp.end - inp.start) / 60000));
  return [
    '議事録（図面テレビ電話）',
    `日時：${fmtDate(inp.start)} ${hhmm(inp.start)}〜${hhmm(inp.end)}（約${mins}分）`,
    `参加者：${inp.me}、${inp.partner}`,
    `使用した図面・写真：${inp.docs.length ? inp.docs.join('、') : 'なし'}`,
  ].join('\n');
}
function minutesRecord(inp) {
  const out = ['■ 発言記録（文字起こし）'];
  if (inp.lines.length) for (const l of inp.lines) out.push(`[${hhmm(l.ts)}] ${l.name}：${l.text}`);
  else out.push('（文字起こしなし）');
  if (inp.chats.length) {
    out.push('', '■ チャット');
    for (const c of inp.chats) out.push(`[${hhmm(c.ts)}] ${c.name}：${c.text}`);
  }
  return out.join('\n');
}
function minutesDraft(inp) {
  return `${minutesHeader(inp)}\n\n■ 要点\n（AIでまとめると、ここに概要・決定事項・宿題が入ります）\n\n${minutesRecord(inp)}`;
}

const MINUTES_SYSTEM = `あなたは製造業（機械加工）の打ち合わせの議事録係です。事務所と現場がテレビ電話で図面や製品を見ながら話した内容の文字起こしとチャットから、日本語の議事録を作成してください。

守ること：
- 寸法・公差・数量・材質・図番・日付・時刻などの数値と固有名詞は、原文どおり正確に書く。
- 発言やチャットにないことは書かない。推測で補わない。
- 音声の聞き取り誤りと思われる箇所は勝手に直さず、「（聞き取り不明瞭：○○）」と原文を添える。
- 出力はプレーンテキスト。見出しは「■」で始め、項目は「・」で書く。前置きやあいさつは書かない。

見出しは次の5つをこの順で必ず出す（該当がなければ「・なし」）：
■ 打ち合わせの概要（2〜3行）
■ 決定事項
■ 宿題・やること（「・内容（担当：○○／期限：○○）」の形。不明なら「未定」）
■ 確認が必要な点・保留事項
■ 図面・寸法・加工についての指摘`;

function minutesPrompt(inp) {
  return `次の打ち合わせの議事録を作成してください。\n\n${minutesHeader(inp)}\n\n<記録>\n${minutesRecord(inp)}\n</記録>`;
}

async function aiMinutes(inp) {
  const key = String(CFG.claudeApiKey || '').trim();
  if (!key) return null;
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MINUTES_MODEL,
        max_tokens: 16000,
        output_config: { effort: 'medium' },
        fallbacks: 'default', // 安全確認で断られた場合は、別のモデルで自動的にやり直す
        system: MINUTES_SYSTEM,
        messages: [{ role: 'user', content: minutesPrompt(inp) }],
      }),
    });
  } catch {
    throw new Error('AIにつながりませんでした。ネット接続を確認して「AIでまとめ直す」を押してください');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('Claude の API キーが正しくありません（config.js を確認してください）');
    if (res.status === 429 || res.status === 529) throw new Error('AIが混み合っています。少し待ってから「AIでまとめ直す」を押してください');
    throw new Error(`AIでまとめられませんでした（${res.status}${data && data.error ? '：' + data.error.message : ''}）`);
  }
  if (data.stop_reason === 'refusal') throw new Error('AIが議事録の作成を断りました。下書きをご利用ください');
  let text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new Error('AIから結果が返りませんでした');
  if (data.stop_reason === 'max_tokens') text += '\n（長すぎるため途中で切れています）';
  return text;
}

let minutesState = null;
async function openMinutes(inp, { interim = false } = {}) {
  const dlg = $('#minutesDlg');
  minutesState = { inp, ts: Date.now() };
  $('#minutesTitle').textContent = interim ? '議事録（途中まで）' : '議事録';
  $('#minutesText').value = minutesDraft(inp);
  $('#minutesAiBtn').hidden = !CFG.claudeApiKey;
  $('#minutesCopyPromptBtn').hidden = !!CFG.claudeApiKey;
  if (!dlg.open) dlg.showModal();
  if (!inp.lines.length && !inp.chats.length) {
    $('#minutesStatus').textContent = '文字起こしやチャットの記録がないため、要点は作れません。次回は通話中に「文字起こし」を押してください。';
    return;
  }
  if (!CFG.claudeApiKey) {
    $('#minutesStatus').textContent = 'AIでまとめるには、config.js に Claude の API キーを設定してください。今は「Claudeに渡す文をコピー」で、Claude アプリに貼り付けてまとめられます。';
    saveMinutes(inp, $('#minutesText').value);
    return;
  }
  await runAiMinutes();
}
async function runAiMinutes() {
  const st = minutesState;
  if (!st || !st.inp.lines) return;
  $('#minutesStatus').textContent = 'AIが議事録をまとめています…（30秒ほどかかることがあります）';
  $('#minutesAiBtn').disabled = true;
  try {
    const body = await aiMinutes(st.inp);
    if (minutesState !== st) return;
    const text = `${minutesHeader(st.inp)}\n\n${body}\n\n${minutesRecord(st.inp)}`;
    $('#minutesText').value = text;
    $('#minutesStatus').textContent = 'AIがまとめました。内容を確認し、必要なら直接書き直してから保存してください。';
    saveMinutes(st.inp, text);
  } catch (e) {
    if (minutesState !== st) return;
    $('#minutesStatus').textContent = e.message + '（下は下書きです）';
    saveMinutes(st.inp, $('#minutesText').value);
  } finally {
    $('#minutesAiBtn').disabled = false;
  }
}
function saveMinutes(inp, text) {
  const list = store.get('minutes', []);
  const i = list.findIndex((x) => x.start === inp.start && x.partner === inp.partner);
  const item = { start: inp.start, partner: inp.partner, text };
  if (i >= 0) list[i] = item; else list.unshift(item);
  store.set('minutes', list.slice(0, 30));
}
async function copyText(text, label) {
  try { await navigator.clipboard.writeText(text); banner(`${label}をコピーしました`, 3000); }
  catch { const t = $('#minutesText'); t.focus(); t.select(); banner('自動でコピーできませんでした。選択された文字をコピーしてください', 5000); }
}
function downloadMinutes() {
  const text = $('#minutesText').value;
  const inp = minutesState && minutesState.inp;
  const d = new Date(inp ? inp.start : Date.now());
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + text.replace(/\n/g, '\r\n')], { type: 'text/plain' }));
  a.download = `議事録_${stamp}_${inp ? inp.partner : ''}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function openMinutesHistory() {
  const list = store.get('minutes', []);
  const ul = $('#minutesList');
  ul.innerHTML = '';
  if (!list.length) { const li = document.createElement('li'); li.textContent = 'まだ議事録はありません'; ul.appendChild(li); }
  for (const it of list) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost';
    b.textContent = `${fmtDate(it.start)} ${hhmm(it.start)}　${it.partner}`;
    b.addEventListener('click', () => {
      $('#historyDlg').close();
      minutesState = { inp: { start: it.start, partner: it.partner }, ts: Date.now() };
      $('#minutesTitle').textContent = '議事録';
      $('#minutesText').value = it.text;
      $('#minutesStatus').textContent = '';
      $('#minutesAiBtn').hidden = true;
      $('#minutesCopyPromptBtn').hidden = true;
      $('#minutesDlg').showModal();
    });
    li.appendChild(b);
    ul.appendChild(li);
  }
  $('#historyDlg').showModal();
}
function setupMinutes() {
  $('#trBtn').addEventListener('click', () => { if (S.tr.on) stopTr(true); else startTr(true); });
  $('#minutesBtn').addEventListener('click', () => openMinutes(collectMinutesInput(), { interim: true }));
  $('#minutesAiBtn').addEventListener('click', runAiMinutes);
  $('#minutesCopyBtn').addEventListener('click', () => copyText($('#minutesText').value, '議事録'));
  $('#minutesCopyPromptBtn').addEventListener('click', () => {
    const st = minutesState;
    if (!st || !st.inp.lines) return;
    copyText(`${MINUTES_SYSTEM}\n\n${minutesPrompt(st.inp)}`, 'Claudeに渡す文');
  });
  $('#minutesSaveBtn').addEventListener('click', downloadMinutes);
  $('#historyBtn').addEventListener('click', openMinutesHistory);
  const keep = () => { const st = minutesState; if (st && st.inp.lines) saveMinutes(st.inp, $('#minutesText').value); };
  $('#minutesText').addEventListener('change', keep);
  $('#minutesDlg').addEventListener('close', keep);
}

// ===================================================================
// 受信メッセージ
// ===================================================================
// 届いたデータ：まとめ役は、ほかの参加者にも配る（送った人の番号を付けて）
const RELAY = new Set(['content', 'view', 'ptr', 'ptr-off', 'sb', 'sp', 'del', 'clear', 'doc-close', 'share', 'msg', 'tr', 'tr-state', 'chat', 'pv']);
function linkAlive(c) { return !!c && (c === S.conn || !!extraByConn(c)); }
function onLinkData(c, m) {
  if (!m || typeof m !== 'object' || !linkAlive(c)) return; // 古い接続から遅れて届いたデータは捨てる
  if (S.role === 'host' && S.extras.size && RELAY.has(m.t)) {
    const fwd = { ...m, from: uidOfConn(c) };
    for (const o of links()) if (o !== c) sendTo(o, fwd);
  }
  try { onMessage(m, c); } catch (e) { console.error(e); }
}
// 送った人：まとめ役から見ればその接続の相手、参加者から見れば（中継されたものは）付いている番号
function senderOf(m, c) {
  if (S.role === 'host') return uidOfConn(c);
  return isUid(m.from) && S.party.list.some((p) => p.uid === m.from) ? m.from : S.partnerUid;
}
function nameOfUid(uid) {
  const p = uid && S.party.list.find((x) => x.uid === uid);
  return p ? p.name : S.remoteName;
}
const ptrKey = (uid) => (uid && isGroup() ? 'u:' + uid : 'remote');

function onMessage(m, c = S.conn) {
  const from = senderOf(m, c);
  const fromName = nameOfUid(from);
  switch (m.t) {
    case 'bye':
      if (S.role === 'host' && c !== S.conn) { const X = extraByConn(c); if (X) removeExtra(X, `${X.name} が退出しました`); break; }
      if (S.role === 'host' && S.extras.size) { primaryGone(`${S.remoteName} が退出しました`); break; }
      hangup(!S.external ? `${S.remoteName} が通話を終了しました`
        : GUEST_MODE ? `${S.remoteName} が打ち合わせを終了しました。このページは閉じてかまいません。` : `${S.remoteName} が退室しました`, false);
      break;
    case 'chat': {
      if (isGroup()) { receiveGroupChat(m.msg, fromName); break; }
      const id = partnerChatId(); if (id) receiveChat(id, m.msg, c); break;
    }
    case 'chat-ack': { const id = partnerChatId(); if (id && isId(m.id)) markSent(id, m.id); break; }
    case 'hello': onHello(m, c); break;
    case 'theme': applyHostTheme(m); break;
    case 'state': onState(m); break;
    case 'fb': fileBegin(m, c); break;
    case 'fc': fileChunk(m); break;
    case 'fe': fileEnd(m, c); break;
    case 'roster': if (S.role !== 'host') onRoster(m); break;
    case 'mesh': if (S.role === 'host' && typeof m.id === 'string' && m.id.length <= 64) setLinkMesh(c, m.id); break;
    case 'mesh-fail': if (S.role === 'host' && isUid(m.uid)) relayTo(c, m.uid); break;
    case 'invite': if (S.role === 'host' && isInternalLink(c)) inviteMember(memberById(String(m.id))); break;
    case 'door-req': if (S.role === 'host' && isInternalLink(c) && isId(m.reqId)) openDoorFor(c, m); break;
    case 'door': if (S.role !== 'host' && isId(m.reqId)) onDoor(m); break;
    case 'content':
      if (validContent(m.c)) setContent(m.c, { send: false, view: validView(m.view) ? m.view : null, ts: finite(m.ts) ? m.ts : null });
      break;
    case 'view':
      if (validView(m.view) && S.sync && S.cur && m.key === S.cur.key) { S.view = m.view; viewChanged(false); }
      break;
    case 'ptr':
      if (isKey(m.key) && finite(m.u) && finite(m.v)) {
        const k = ptrKey(from);
        const p = pushPtr(S.pointers.get(k), m.key, m.u, m.v);
        p.name = fromName; p.uid = from;
        S.pointers.set(k, p);
      }
      break;
    case 'ptr-off': S.pointers.delete(ptrKey(from)); break;
    case 'sb':
      if (isKey(m.key) && validStroke(m.s) && !S.strokeById.has(m.s.id) && (S.strokes.get(m.key) || []).length < MAX_STROKES) addStroke(m.key, m.s);
      break;
    case 'sp': {
      const st = isId(m.id) && S.strokeById.get(m.id);
      if (st && validPts(m.pts, 4000) && st.pts.length + m.pts.length <= MAX_STROKE_PTS) { st.pts.push(...m.pts); if (S.cur && st.key === S.cur.key) drawInk(); }
      break;
    }
    case 'del': if (isId(m.id)) deleteStroke(m.id, false); break;
    case 'clear': if (isKey(m.key)) clearStrokes(m.key, false); break;
    case 'snap-req':
      // 複数人のときは、撮ってほしい人あて。まとめ役は、その人に渡す
      if (S.role === 'host' && isUid(m.to) && m.to !== S.uid) { const t = linkOfUid(m.to); if (t) sendTo(t, { t: 'snap-req', from }); break; }
      onSnapRequest(fromName);
      break;
    case 'doc-req': {
      // 送り直しの依頼は 1 つの図面につき 10 秒に 1 回まで（相手ごと）
      const d = isId(m.id) && S.docs.get(m.id);
      c._reqAt = c._reqAt || new Map();
      if (d && !(c._reqAt.get(d.id) > Date.now() - 10_000)) { c._reqAt.set(d.id, Date.now()); hasSet(c).delete(d.id); sendDocTo(c, d); }
      break;
    }
    case 'got': if (isId(m.id)) hasSet(c).add(m.id); break;
    case 'pv': onPreview(m); break;
    case 'doc-close': if (isId(m.id)) closeDoc(m.id, { fromRemote: true }); break;
    case 'share': banner(m.on ? `${fromName} が画面を共有しています` : `${fromName} が画面の共有を終えました`, 5000); break;
    case 'msg': if (typeof m.text === 'string') banner(m.text.slice(0, 200)); break;
    case 'tr': if (m.line && typeof m.line.text === 'string') addTrLine(isGroup() && from ? from : 'them', fromName, { id: String(m.line.id).slice(0, 64), ts: finite(m.line.ts) ? m.line.ts : Date.now(), text: m.line.text.slice(0, 2000) }); break;
    case 'tr-state':
      if (m.on && !S.tr.on) { startTr(false); banner(`${fromName} が文字起こしを開始しました。話した内容が${TR_USE}`, 6000); }
      else if (!m.on && S.tr.on) { stopTr(false); banner(`${fromName} が文字起こしを止めました`, 4000); }
      break;
    default: break;
  }
}

function onHello(m, link = S.conn) {
  applyHostTheme(m);
  const extra = S.role === 'host' && link !== S.conn;
  // 社外の方の名前は入室時のもの（〇〇様）を使い続ける。2人目以降の参加者の名前も、まとめ役が決めたもの
  if (m.name && !extra && !(S.external && S.role === 'host')) S.remoteName = cleanText(m.name, 60);
  const theirs = Array.isArray(m.docs) ? m.docs.filter(isId).slice(0, 500) : [];
  for (const id of theirs) hasSet(link).add(id);
  el.remoteWipe.querySelector('.wipe-label').textContent = S.remoteName;
  if (!extra) broadcastRoster();
  const c = S.content;
  // 途中から参加した人には、開いている図面をすべて（タブの順に）渡す
  if (extra) for (const d of S.docs.values()) if (!(c.type === 'doc' && c.docId === d.id)) setTimeout(() => sendDocTo(link, d), 0);
  const mine = c.type !== 'none';
  const newer = S.contentTs > (m.contentTs || 0) || (S.contentTs === m.contentTs && S.role === 'host');
  if (!mine || !newer) {
    if (extra && S.strokes.size) sendQueued(() => sendTo(link, { t: 'state', c, ts: S.contentTs, view: S.view, strokes: [...S.strokes.entries()] }));
    return;
  }
  // 自分の表示内容の方が新しい → 相手に図面と書き込みを渡す
  if (c.type === 'doc' && !theirs.includes(c.docId)) sendDocTo(link, S.docs.get(c.docId));
  const prefix = c.type === 'doc' ? c.docId + ':' : 'live:';
  const strokes = [...S.strokes.entries()].filter(([k]) => extra || k.startsWith(prefix));
  sendQueued(() => sendTo(link, { t: 'state', c, ts: S.contentTs, view: S.view, strokes }));
}

function onState(m) {
  if (!validContent(m.c)) return;
  for (const [key, list] of Array.isArray(m.strokes) ? m.strokes.slice(0, 2000) : []) {
    if (!isKey(key) || !Array.isArray(list)) continue;
    clearStrokes(key, false);
    for (const st of list.slice(0, MAX_STROKES)) if (validStroke(st)) addStroke(key, st, false);
  }
  setContent(m.c, { send: false, view: validView(m.view) ? m.view : null, ts: finite(m.ts) ? m.ts : null });
}

// ===================================================================
// 図面ファイル
// ===================================================================
let pdfReady = null;
function ensurePdfjs() {
  if (pdfReady) return pdfReady;
  const lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  if (location.protocol === 'file:') {
    // ファイルを直接開いた場合は、ファイル指定の Worker が使えない。
    // 中身を文字列で読み込み、メモリ上（Blob）から別スレッドで動かす（図面の処理中も画面と送受信が止まらない）
    const load = (src) => new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = rej;
      document.head.appendChild(s);
    });
    pdfReady = load('vendor/pdf.worker.blob.js').then(() => {
      const url = URL.createObjectURL(new Blob([window.__PDF_WORKER_SRC], { type: 'text/javascript' }));
      lib.GlobalWorkerOptions.workerPort = new Worker(url);
      delete window.__PDF_WORKER_SRC;
      return lib;
    }).catch((e) => {
      // うまくいかないときは、従来どおり同じスレッドで処理する
      console.warn('pdf worker', e);
      lib.GlobalWorkerOptions.workerPort = null;
      return load('vendor/pdf.worker.min.js').then(() => lib);
    });
  } else {
    pdfReady = Promise.resolve(lib);
  }
  return pdfReady;
}

async function prepareDoc(doc) {
  if (doc.kind === 'pdf') {
    const lib = await ensurePdfjs();
    const data = new Uint8Array(await doc.blob.arrayBuffer());
    doc.pdf = await lib.getDocument({ data, isEvalSupported: false }).promise;
    doc.pages = doc.pdf.numPages;
  } else {
    doc.img = await createImageBitmap(doc.blob);
    doc.pages = 1;
  }
  S.docs.set(doc.id, doc);
  if (S.inCall) S.callDocs.add(doc.name);
  renderTabs();
  return doc;
}

// 図面（PDF・画像）を通話中の画面にドラッグ＆ドロップで開く（複数まとめてもよい。1つずつタブになり、相手にも表示される）
function setupDropOpen() {
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  let depth = 0;
  const show = (on) => el.room.classList.toggle('dropping', on);
  // 画面のどこに落としても、ブラウザがファイルを開いて図面テレビ電話の画面から離れてしまわないようにする
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = el.room.hidden ? 'none' : 'copy';
  });
  window.addEventListener('dragenter', (e) => { if (hasFiles(e) && !el.room.hidden) { depth++; show(true); } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && !el.room.hidden && --depth <= 0) { depth = 0; show(false); } });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    show(false);
    if (el.room.hidden) return;
    await openLocalFiles(Array.from(e.dataTransfer.files || []));
  });
}

// 複数のファイルを順に開く（開けないものは、どうすれば見られるかを案内する）
async function openLocalFiles(files) {
  const ng = [];
  let n = 0;
  for (const f of files) {
    if (fileHow(f).how === 'no') { ng.push(f); continue; }
    if (++n > 10) { banner('一度に開けるのは 10 ファイルまでです', 5000); break; }
    await openLocalFile(f);
  }
  if (ng.length) banner(ng.length === 1 || n ? `${ng[0].name}：${fileHow(ng[0]).msg}` : `${ng.length} 個のファイルは開けません。PDF に保存してから開いてください`, 9000);
}
// ファイルの種類を調べる（変換の部品が読み込めていないときは、PDF と画像だけ）
const CONV = window.ZumenConvert || null;
function fileHow(file) {
  if (CONV) return CONV.classify(file);
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return { how: 'pdf' };
  if (file.type.startsWith('image/')) return { how: 'image' };
  return { how: 'no', msg: 'PDF か画像ファイルを選んでください' };
}

async function openLocalFile(file) {
  const how = fileHow(file);
  if (how.how === 'no') { banner(how.msg, 9000); return; }
  let doc;
  if (how.how === 'convert') {
    // Word・Excel・PowerPoint・CAD などは、この端末で PDF（または画像）に変換してから開く。相手には変換後のものを送る
    let out;
    try { out = await CONV.convert(file, (t, r) => progress(`${file.name}：${t}`, r)); }
    catch (e) { console.warn(e); progress(null); banner(e.userMsg || 'このファイルは開けませんでした', 9000); return; }
    doc = { id: rid(), kind: out.kind, name: file.name, mime: out.mime, blob: out.blob, src: file };
    if (out.cut) banner(`${file.name} は大きいため、途中までを表示しています`, 6000);
  } else {
    const isPdf = how.how === 'pdf';
    doc = { id: rid(), kind: isPdf ? 'pdf' : 'image', name: file.name, mime: file.type || (isPdf ? 'application/pdf' : 'image/jpeg'), blob: file };
  }
  progress('図面を読み込み中…', 0.2);
  try { await prepareDoc(doc); }
  catch (e) {
    console.error(e); progress(null);
    banner(/\.(heic|heif)$/i.test(file.name) ? 'iPhone の写真形式（HEIC）はこの端末では開けません。iPhone の「設定 → カメラ → フォーマット」を「互換性優先」にするか、JPEG で送ってください' : 'このファイルは開けませんでした', 9000);
    return;
  }
  progress(null);
  sendDoc(doc);
  setContent({ type: 'doc', docId: doc.id, page: 1 });
}

// 図面は相手ごとに「持っているか」を覚え、持っていない人にだけ送る
const hasSet = (c) => c._has || (c._has = new Set());
function sendDoc(doc) {
  if (!doc) return;
  for (const c of links()) sendDocTo(c, doc);
}
function sendDocTo(c, doc) {
  if (!doc || !c || hasSet(c).has(doc.id)) return;
  c._sending = c._sending || new Set();
  if (c._sending.has(doc.id)) return;
  c._sending.add(doc.id);
  sendQueued(async () => {
    try { await sendDocNow(c, doc); } finally { c._sending.delete(doc.id); }
  });
}
async function sendDocNow(c, doc) {
  if (!c.open || !linkAlive(c) || hasSet(c).has(doc.id) || !S.docs.has(doc.id)) return;
  const buf = await doc.blob.arrayBuffer();
  const ch = await openFileChannel(c);
  if (ch) return sendViaFileChannel(c, ch, doc, buf);
  {
    // 図面専用の通り道が使えないとき（古い版の相手など）は、制御用の接続で少しずつ送る
    const size = buf.byteLength;
    sendTo(c, { t: 'fb', id: doc.id, kind: doc.kind, name: doc.name, mime: doc.mime, size });
    for (let off = 0; off < size; off += CHUNK) {
      if (!(await waitDrain(c))) { progress(null); return; }
      sendTo(c, { t: 'fc', id: doc.id, d: buf.slice(off, Math.min(size, off + CHUNK)) });
      if ((off / CHUNK) % 32 === 0) progress(`相手に送信中 ${doc.name}`, off / size);
    }
    sendTo(c, { t: 'fe', id: doc.id });
    progress(null);
  }
}

// ---- 図面専用の通り道 ----
//   制御用の接続（ポインター・書き込みなど）とは別に、番号を決めたデータチャネルを両側で作る。
//   大きな塊のまま変換なしで流せるので速く、図面の送信中もポインターが遅れない。
const FILE_CH_ID = 50;
const FCHUNK = 64 * 1024;
function fileChannel(c) {
  const pc = c && c.peerConnection;
  if (!pc || pc.signalingState === 'closed') return null;
  if (c._fch && c._fch.readyState !== 'closed') return c._fch;
  try {
    const ch = pc.createDataChannel('zumen-file', { negotiated: true, id: FILE_CH_ID, ordered: true });
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = 1 << 20;
    ch.onmessage = (e) => { if (linkAlive(c)) onFileData(c, e.data); };
    c._fch = ch;
    return ch;
  } catch (e) { console.warn('file channel', e); return null; }
}
// 開くまで少し待つ（相手が古い版だと開かないので、そのときは null）
async function openFileChannel(c, ms = 3000) {
  const ch = fileChannel(c);
  if (!ch) return null;
  const end = Date.now() + ms;
  while (ch.readyState === 'connecting' && Date.now() < end) await sleep(50);
  return ch.readyState === 'open' ? ch : null;
}
function onFileData(c, d) {
  if (typeof d === 'string') {
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'fb') { c._rx = m.id; fileBegin(m, c); }
    else if (m.t === 'fe') { c._rx = null; fileEnd(m, c); }
    return;
  }
  if (c._rx) fileChunk({ id: c._rx, d });
}
async function sendViaFileChannel(c, ch, doc, buf) {
  const size = buf.byteLength;
  ch.send(JSON.stringify({ t: 'fb', id: doc.id, kind: doc.kind, name: doc.name, mime: doc.mime, size }));
  for (let off = 0, n = 0; off < size; off += FCHUNK, n++) {
    if (ch.bufferedAmount > 4 * FCHUNK * 16) {
      await new Promise((r) => {
        const done = () => { ch.removeEventListener('bufferedamountlow', done); ch.removeEventListener('close', done); r(); };
        ch.addEventListener('bufferedamountlow', done);
        ch.addEventListener('close', done);
      });
    }
    if (ch.readyState !== 'open' || !linkAlive(c) || hasSet(c).has(doc.id)) { progress(null); return; }
    ch.send(buf.slice(off, Math.min(size, off + FCHUNK)));
    if (n % 16 === 0) progress(`相手に送信中 ${doc.name}`, off / size);
  }
  ch.send(JSON.stringify({ t: 'fe', id: doc.id }));
  progress(null);
}

// ---- 見本画像（大きな図面は、先に軽い画像を送って相手の画面にすぐ映す） ----
const PREVIEW_MIN = 600 * 1024;   // これより小さいファイルは本物をそのまま送る方が早い
const PREVIEW_PX = 2000;
async function sendPreview(doc, page) {
  const lacks = () => links().some((c) => !hasSet(c).has(doc.id));
  if (!doc || doc.blob.size < PREVIEW_MIN || !lacks()) return;
  doc.pvSent = doc.pvSent || new Set();
  if (doc.pvSent.has(page)) return;
  doc.pvSent.add(page);
  try {
    let src, W, H;
    if (doc.kind === 'pdf') {
      const pg = await doc.pdf.getPage(clamp(page, 1, doc.pages));
      const vp = pg.getViewport({ scale: 1 });
      W = vp.width; H = vp.height;
      src = await renderLow(pg);
    } else {
      W = doc.img.width; H = doc.img.height;
      src = doc.img;
    }
    if (!lacks()) return;
    const k = Math.min(1, PREVIEW_PX / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
    if (!blob || !lacks()) return;
    send({ t: 'pv', id: doc.id, kind: doc.kind, name: doc.name, pages: doc.pages, page, W, H, img: await blob.arrayBuffer() });
  } catch (e) { console.warn('preview', e); doc.pvSent.delete(page); }
}
async function onPreview(m) {
  if (!isId(m.id) || S.docs.has(m.id) || !finite(m.W) || !finite(m.H) || m.W <= 0 || m.H <= 0 || !Number.isInteger(m.page) || !Number.isInteger(m.pages) || m.page < 1 || m.page > m.pages || m.pages > 5000) return;
  if (m.kind !== 'pdf' && m.kind !== 'image') return;
  const data = m.img instanceof ArrayBuffer ? m.img : m.img && m.img.buffer ? m.img.buffer.slice(m.img.byteOffset, m.img.byteOffset + m.img.byteLength) : null;
  if (!data || data.byteLength > 8 * 1024 * 1024) return;
  if (S.previews.size >= 50 && !S.previews.has(m.id)) return;
  m.name = cleanText(m.name, 120) || '図面';
  let img;
  try { img = await createImageBitmap(new Blob([data], { type: 'image/jpeg' })); } catch { return; }
  if (S.docs.has(m.id) || !S.inCall) return;
  let pv = S.previews.get(m.id);
  if (!pv) { pv = { id: m.id, name: m.name, kind: m.kind, pages: m.pages, imgs: new Map() }; S.previews.set(m.id, pv); }
  pv.imgs.set(m.page, { img, W: m.W, H: m.H });
  renderTabs();
  const c = S.content;
  if (c.type === 'doc' && c.docId === m.id && c.page === m.page && (!S.cur || S.cur.preview)) prepareContent();
}

// 表示する図面が手元にない（再接続で取りこぼした等）ときは、少し待ってから相手に送ってもらう
const docReqTimers = new Map();
function requestDocLater(id) {
  if (docReqTimers.has(id)) return;
  docReqTimers.set(id, setTimeout(() => {
    docReqTimers.delete(id);
    if (S.inCall && !S.docs.has(id) && !S.incoming.has(id) && S.content.type === 'doc' && S.content.docId === id) send({ t: 'doc-req', id });
  }, 4000));
}

function fileBegin(m, c) {
  if (c && isId(m.id)) hasSet(c).add(m.id); // 送ってきた人は持っている
  if (!isId(m.id) || (m.kind !== 'pdf' && m.kind !== 'image') || !finite(m.size) || m.size <= 0 || S.docs.has(m.id)) return;
  if (m.size > MAX_FILE) { banner(`相手から届いた図面が大きすぎるため受け取れませんでした（${MAX_FILE / 1024 / 1024}MB まで）`, 8000); return; }
  if (S.incoming.size >= 4) return;
  const name = cleanText(m.name, 120) || '図面';
  const mime = typeof m.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(m.mime) ? m.mime : m.kind === 'pdf' ? 'application/pdf' : 'image/jpeg';
  S.incoming.set(m.id, { meta: { id: m.id, kind: m.kind, name, mime, size: m.size }, parts: [], got: 0 });
  progress(`受信中 ${name}`, 0);
}
function fileChunk(m) {
  const f = S.incoming.get(m.id);
  if (!f || !m.d) return;
  const d = m.d instanceof ArrayBuffer ? m.d : m.d.buffer ? m.d.buffer.slice(m.d.byteOffset, m.d.byteOffset + m.d.byteLength) : null;
  if (!d) return;
  if (f.got + d.byteLength > f.meta.size) { S.incoming.delete(m.id); progress(null); return; } // 申告より大きい → 破棄
  f.parts.push(d);
  f.got += d.byteLength;
  if (f.parts.length % 32 === 0) progress(`受信中 ${f.meta.name}`, f.got / f.meta.size);
}
async function fileEnd(m, c) {
  const f = isId(m.id) && S.incoming.get(m.id);
  if (!f) return;
  S.incoming.delete(m.id);
  progress(null);
  if (f.got !== f.meta.size) return; // 途中が欠けている
  const doc = { id: m.id, kind: f.meta.kind, name: f.meta.name, mime: f.meta.mime, blob: new Blob(f.parts, { type: f.meta.mime }) };
  if (S.docs.has(doc.id)) return; // 同じ図面を二重に受け取った
  const pv = S.previews.get(doc.id);
  if (pv) doc.pvImgs = pv.imgs;
  try { await prepareDoc(doc); } catch (e) { console.error(e); banner('受け取った図面を開けませんでした'); return; }
  S.previews.delete(doc.id);
  sendTo(c, { t: 'got', id: doc.id });
  if (S.role === 'host' && S.extras.size) sendDoc(doc); // まとめ役は、ほかの参加者にも渡す
  if (S.content.type === 'doc' && S.content.docId === doc.id) prepareContent();
}

// ===================================================================
// 表示内容（図面のページ / カメラ映像）
// ===================================================================
function keyOf(c) {
  if (c.type === 'doc') return `${c.docId}:${c.page}`;
  if (c.type === 'live') return `live:${c.who}${c.screen ? ':screen' : ''}`;
  return null;
}

function setContent(c, { send: doSend = true, view = null, ts = null } = {}) {
  rememberDocView();
  S.content = c;
  S.contentTs = ts || Date.now();
  S.view = view ? { ...view } : { cx: 0.5, cy: 0.5, zoom: 1 };
  if (doSend) send({ t: 'content', c, ts: S.contentTs, view: S.view });
  if (c.type === 'doc') sendPreview(S.docs.get(c.docId), c.page); // 相手がページを送っても、その見本を返す
  // 自分のカメラが大きく映されたら自動で高画質に、外れたら元に戻す
  const meLive = c.type === 'live' && isMeWho(c.who);
  if (meLive && S.quality === 'std') setQuality('hi', { auto: true });
  else if (!meLive && S.autoBoosted) setQuality('std');
  else if (isGroup()) applyQuality();
  partyMedia();
  prepareContent();
}

let prepSeq = 0;
async function prepareContent() {
  const seq = ++prepSeq;
  const c = S.content;
  const key = keyOf(c);
  S.pointers.delete('me');
  if (c.type === 'none') { S.cur = null; return redrawAll(); }
  if (c.type === 'live') {
    attachStageVideo();
    const v = el.stageVideo;
    S.cur = { key, kind: 'live', W: v.videoWidth || 16, H: v.videoHeight || 9 };
    return redrawAll();
  }
  const doc = S.docs.get(c.docId);
  if (!doc) {
    const pv = S.previews.get(c.docId);
    const p = pv && pv.imgs.get(c.page);
    if (p) S.cur = { key, kind: 'image', W: p.W, H: p.H, img: p.img, preview: true };
    else { S.cur = null; progress('図面を受信中…', 0); }
    redrawAll();
    if (p && !S.incoming.has(c.docId)) progress(`高画質の図面を受信中… ${pv.name}`, 0);
    requestDocLater(c.docId);
    return;
  }
  if (doc.kind === 'image') {
    S.cur = { key, kind: 'image', W: doc.img.width, H: doc.img.height, img: doc.img, doc };
    return redrawAll();
  }
  const page = await doc.pdf.getPage(clamp(c.page, 1, doc.pages));
  if (seq !== prepSeq) return;
  const vp = page.getViewport({ scale: 1 });
  const pvp = doc.pvImgs && doc.pvImgs.get(c.page);
  const cur = { key, kind: 'pdf', W: vp.width, H: vp.height, page, doc, low: pvp ? pvp.img : null };
  S.cur = cur;
  redrawAll();
  cur.low = await renderLow(page);
  if (pvp) doc.pvImgs.delete(c.page);
  if (S.cur === cur) drawBase();
}

// ズーム中の仮表示用に、ページ全体を中くらいの解像度で1枚描いておく
const lowCache = new Map();
function renderLow(page) {
  // 自分の表示用と相手への見本画像用で同じページを二重に描かないよう、描画中の約束（Promise）ごと覚える
  const k = page;
  if (lowCache.has(k)) return lowCache.get(k);
  const job = (async () => {
    const vp1 = page.getViewport({ scale: 1 });
    const scale = 2400 / Math.max(vp1.width, vp1.height);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    return c;
  })();
  lowCache.set(k, job);
  job.catch(() => lowCache.delete(k));
  if (lowCache.size > 6) lowCache.delete(lowCache.keys().next().value);
  return job;
}

function attachStageVideo() {
  const c = S.content;
  if (c.type !== 'live') return;
  const src = isMeWho(c.who) ? (c.screen && S.share ? S.share.stream : S.localStream) : streamOfWho(c.who);
  if (el.stageVideo.srcObject !== src) el.stageVideo.srcObject = src;
  el.stageVideo.play().catch(() => {});
}
el.stageVideo.addEventListener('resize', () => {
  if (S.cur && S.cur.kind === 'live' && el.stageVideo.videoWidth) {
    S.cur.W = el.stageVideo.videoWidth;
    S.cur.H = el.stageVideo.videoHeight;
    redrawAll();
  }
});

// ===================================================================
// 座標変換と描画
// ===================================================================
let SW = 1, SH = 1;
function layout() {
  const r = el.stage.getBoundingClientRect();
  SW = Math.max(1, r.width); SH = Math.max(1, r.height);
  const d = DPR();
  for (const cv of [el.base, el.ink, el.ptr]) {
    cv.width = Math.round(SW * d);
    cv.height = Math.round(SH * d);
  }
  keepWipesInside();
  redrawAll();
}

function xform(cur = S.cur, view = S.view) {
  const fit = Math.min(SW / cur.W, SH / cur.H) * 0.98;
  const s = fit * view.zoom;
  return { fit, s, ox: SW / 2 - view.cx * cur.W * s, oy: SH / 2 - view.cy * cur.H * s, W: cur.W, H: cur.H };
}
function toNorm(x, y) {
  const t = xform();
  return { u: (x - t.ox) / (t.W * t.s), v: (y - t.oy) / (t.H * t.s) };
}

function redrawAll() {
  drawBase();
  drawInk();
  updateToolbar();
}

function drawBase() {
  const g = ctx.base;
  const d = DPR();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, el.base.width, el.base.height);
  const cur = S.cur;
  el.emptyHint.hidden = !!cur || S.content.type !== 'none';
  el.stageVideo.style.display = cur && cur.kind === 'live' ? 'block' : 'none';
  updateWipes();
  if (!cur) return;
  const t = xform();
  if (cur.kind === 'live') {
    const v = el.stageVideo.style;
    v.width = cur.W + 'px'; v.height = cur.H + 'px';
    v.transform = `translate(${t.ox}px, ${t.oy}px) scale(${t.s})`;
    return;
  }
  g.setTransform(d, 0, 0, d, 0, 0);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  if (cur.kind === 'image') {
    g.drawImage(cur.img, t.ox, t.oy, t.W * t.s, t.H * t.s);
    return;
  }
  // PDF：まず仮表示 → 落ち着いたら見えている範囲だけを画面解像度で描き直す
  g.fillStyle = '#fff';
  g.fillRect(t.ox, t.oy, t.W * t.s, t.H * t.s);
  if (cur.low) g.drawImage(cur.low, t.ox, t.oy, t.W * t.s, t.H * t.s);
  scheduleCrisp();
}

let crispTimer = null, crispTask = null, crispSeq = 0;
function scheduleCrisp() {
  clearTimeout(crispTimer);
  crispTimer = setTimeout(renderCrisp, 90);
}
async function renderCrisp() {
  const cur = S.cur;
  if (!cur || cur.kind !== 'pdf') return;
  const seq = ++crispSeq;
  if (crispTask) { crispTask.cancel(); crispTask = null; }
  const d = DPR();
  const t = xform();
  const off = document.createElement('canvas');
  off.width = el.base.width; off.height = el.base.height;
  const g = off.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(t.ox * d, t.oy * d, t.W * t.s * d, t.H * t.s * d);
  const viewport = cur.page.getViewport({ scale: t.s * d });
  const task = cur.page.render({ canvasContext: g, viewport, transform: [1, 0, 0, 1, t.ox * d, t.oy * d], background: 'rgba(0,0,0,0)' });
  crispTask = task;
  try { await task.promise; } catch { return; } // 途中で取り消された
  if (seq !== crispSeq || S.cur !== cur) return;
  crispTask = null;
  const b = ctx.base;
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.clearRect(0, 0, el.base.width, el.base.height);
  b.drawImage(off, 0, 0);
}

function drawInk() {
  const g = ctx.ink;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, el.ink.width, el.ink.height);
  if (!S.cur) return;
  const list = S.strokes.get(S.cur.key);
  if (!list || !list.length) return;
  const d = DPR();
  g.setTransform(d, 0, 0, d, 0, 0);
  drawStrokes(g, list, xform());
}

function drawStrokes(g, list, t) {
  const sx = t.W * t.s, sy = t.H * t.s;
  for (const st of list) {
    const p = st.pts;
    if (!p.length) continue;
    g.save();
    g.globalAlpha = st.tool === 'hl' ? 0.4 : 1;
    g.strokeStyle = g.fillStyle = st.color;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = Math.max(1, st.w * sx);
    if (p.length === 2) {
      g.beginPath();
      g.arc(t.ox + p[0] * sx, t.oy + p[1] * sy, g.lineWidth / 2, 0, Math.PI * 2);
      g.fill();
    } else {
      g.beginPath();
      g.moveTo(t.ox + p[0] * sx, t.oy + p[1] * sy);
      for (let i = 2; i < p.length; i += 2) g.lineTo(t.ox + p[i] * sx, t.oy + p[i + 1] * sy);
      g.stroke();
    }
    g.restore();
  }
}

// レーザーポインター（常時アニメーション）
const TRAIL_MS = 380;
function pushPtr(p, key, u, v) {
  const now = performance.now();
  if (!p || p.key !== key) p = { key, pts: [] };
  p.pts.push({ u, v, t: now });
  p.last = now;
  return p;
}
function drawPointers() {
  const g = ctx.ptr;
  const d = DPR();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, el.ptr.width, el.ptr.height);
  if (S.cur) {
    g.setTransform(d, 0, 0, d, 0, 0);
    const t = xform();
    const now = performance.now();
    for (const [who, p] of S.pointers) {
      if (p.key !== S.cur.key) continue;
      if (now - p.last > 4000) { S.pointers.delete(who); continue; }
      p.pts = p.pts.filter((q) => now - q.t < TRAIL_MS || q === p.pts[p.pts.length - 1]);
      const pts = p.pts.map((q) => ({ x: t.ox + q.u * t.W * t.s, y: t.oy + q.v * t.H * t.s, a: 1 - (now - q.t) / TRAIL_MS }));
      const color = who.startsWith('u:') ? ptrColor(p.uid) : '255,40,40';
      g.lineCap = 'round';
      for (let i = 1; i < pts.length; i++) {
        g.strokeStyle = `rgba(${color},${clamp(pts[i].a, 0, 1) * 0.6})`;
        g.lineWidth = 6 * clamp(pts[i].a, 0.2, 1);
        g.beginPath(); g.moveTo(pts[i - 1].x, pts[i - 1].y); g.lineTo(pts[i].x, pts[i].y); g.stroke();
      }
      const h = pts[pts.length - 1];
      if (!h) continue;
      g.save();
      g.shadowColor = `rgba(${color},1)`;
      g.shadowBlur = 18;
      g.fillStyle = `rgba(${color},0.95)`;
      g.beginPath(); g.arc(h.x, h.y, 8, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0;
      g.fillStyle = 'rgba(255,255,255,.9)';
      g.beginPath(); g.arc(h.x, h.y, 3, 0, Math.PI * 2); g.fill();
      g.restore();
      if (who !== 'me') {
        g.font = '12px sans-serif';
        const label = p.name || S.remoteName;
        const w = g.measureText(label).width + 10;
        g.fillStyle = 'rgba(0,0,0,.6)';
        g.fillRect(h.x + 12, h.y + 8, w, 18);
        g.fillStyle = '#fff';
        g.fillText(label, h.x + 17, h.y + 21);
      }
    }
  }
  requestAnimationFrame(drawPointers);
}

// ===================================================================
// 書き込み（蛍光ペン・ペン）
// ===================================================================
function addStroke(key, s, redraw = true) {
  const st = { ...s, key, pts: [...s.pts] };
  if (!S.strokes.has(key)) S.strokes.set(key, []);
  S.strokes.get(key).push(st);
  S.strokeById.set(st.id, st);
  if (redraw && S.cur && S.cur.key === key) drawInk();
  return st;
}
function deleteStroke(id, doSend = true) {
  const st = S.strokeById.get(id);
  if (!st) return;
  S.strokeById.delete(id);
  const list = S.strokes.get(st.key) || [];
  const i = list.indexOf(st);
  if (i >= 0) list.splice(i, 1);
  if (doSend) send({ t: 'del', id });
  if (S.cur && S.cur.key === st.key) drawInk();
}
function clearStrokes(key, doSend = true) {
  for (const st of S.strokes.get(key) || []) S.strokeById.delete(st.id);
  S.strokes.set(key, []);
  if (doSend) send({ t: 'clear', key });
  if (S.cur && S.cur.key === key) drawInk();
}
function undo() {
  while (S.myStack.length) {
    const [, id] = S.myStack.pop();
    if (S.strokeById.has(id)) { deleteStroke(id); return; }
  }
}

function eraseAt(x, y) {
  if (!S.cur) return;
  const t = xform();
  const sx = t.W * t.s, sy = t.H * t.s;
  const list = S.strokes.get(S.cur.key) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const st = list[i], p = st.pts;
    const tol = Math.max(8, (st.w * sx) / 2 + 4);
    for (let j = 0; j < p.length; j += 2) {
      const ax = t.ox + p[j] * sx, ay = t.oy + p[j + 1] * sy;
      const bx = j + 2 < p.length ? t.ox + p[j + 2] * sx : ax, by = j + 2 < p.length ? t.oy + p[j + 3] * sy : ay;
      if (distSeg(x, y, ax, ay, bx, by) < tol) { deleteStroke(st.id); return; }
    }
  }
}
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const k = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
  return Math.hypot(px - (ax + k * dx), py - (ay + k * dy));
}

// ===================================================================
// 表示の拡大・移動
// ===================================================================
function clampView() {
  S.view.zoom = clamp(S.view.zoom, 0.5, 60);
  S.view.cx = clamp(S.view.cx, 0, 1);
  S.view.cy = clamp(S.view.cy, 0, 1);
}
let viewSendTimer = null, viewLastSent = 0;
function viewChanged(doSend = true) {
  clampView();
  drawBase();
  drawInk();
  if (!doSend || !S.sync || !S.cur) return;
  const now = performance.now();
  const fire = () => { viewLastSent = performance.now(); viewSendTimer = null; if (S.cur) send({ t: 'view', key: S.cur.key, view: S.view }); };
  if (now - viewLastSent > 50) fire();
  else if (!viewSendTimer) viewSendTimer = setTimeout(fire, 50);
}
function zoomAt(px, py, f) {
  if (!S.cur) return;
  const t = xform();
  const u = (px - t.ox) / (t.W * t.s), v = (py - t.oy) / (t.H * t.s);
  const zoom = clamp(S.view.zoom * f, 0.5, 60);
  const s2 = t.fit * zoom;
  S.view = { zoom, cx: u - (px - SW / 2) / (t.W * s2), cy: v - (py - SH / 2) / (t.H * s2) };
  viewChanged();
}

// ===================================================================
// ステージ上のマウス・タッチ操作
// ===================================================================
const touches = new Map();
let gesture = null;   // { type:'pan'|'stroke'|'erase'|'pinch'|'laser', ... }
let ptrSendLast = 0;

function localPos(e) {
  const r = el.ptr.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function sendPointer(u, v) {
  const now = performance.now();
  if (now - ptrSendLast < 25) return;
  ptrSendLast = now;
  send({ t: 'ptr', key: S.cur.key, u, v });
}

el.ptr.addEventListener('pointerdown', (e) => {
  el.ptr.setPointerCapture(e.pointerId);
  const p = localPos(e);
  touches.set(e.pointerId, p);
  if (touches.size === 2) {
    // 2本指 → 拡大縮小・移動
    if (gesture && gesture.type === 'stroke') finishStroke();
    const [a, b] = [...touches.values()];
    gesture = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view0: { ...S.view } };
    return;
  }
  if (touches.size > 2 || !S.cur) return;
  const tool = e.button === 1 || e.button === 2 ? 'hand' : S.tool;
  if (tool === 'hand') {
    gesture = { type: 'pan', x: p.x, y: p.y, view0: { ...S.view } };
    el.stage.classList.add('panning');
  } else if (tool === 'hl' || tool === 'pen') {
    const { u, v } = toNorm(p.x, p.y);
    const t = xform();
    const s = { id: rid(), tool, color: S.color, w: TOOL_WIDTH[tool] / (t.W * t.s), pts: [u, v] };
    const st = addStroke(S.cur.key, s);
    S.myStack.push([S.cur.key, s.id]);
    send({ t: 'sb', key: S.cur.key, s });
    gesture = { type: 'stroke', st, last: p, buf: [], sent: performance.now() };
  } else if (tool === 'eraser') {
    gesture = { type: 'erase' };
    eraseAt(p.x, p.y);
  } else if (tool === 'laser') {
    gesture = { type: 'laser' };
    moveLaser(p);
  }
});

el.ptr.addEventListener('pointermove', (e) => {
  const p = localPos(e);
  if (touches.has(e.pointerId)) touches.set(e.pointerId, p);
  if (!S.cur) return;
  if (gesture && gesture.type === 'pinch' && touches.size >= 2) {
    const [a, b] = [...touches.values()];
    const t0 = xform(S.cur, gesture.view0);
    const m0 = gesture.m0;
    const u = (m0.x - t0.ox) / (t0.W * t0.s), v = (m0.y - t0.oy) / (t0.H * t0.s);
    const zoom = clamp(gesture.view0.zoom * Math.hypot(a.x - b.x, a.y - b.y) / gesture.d0, 0.5, 60);
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const s2 = t0.fit * zoom;
    S.view = { zoom, cx: u - (m.x - SW / 2) / (t0.W * s2), cy: v - (m.y - SH / 2) / (t0.H * s2) };
    viewChanged();
    return;
  }
  if (gesture && gesture.type === 'pan') {
    const t = xform();
    S.view = { zoom: gesture.view0.zoom, cx: gesture.view0.cx - (p.x - gesture.x) / (t.W * t.s), cy: gesture.view0.cy - (p.y - gesture.y) / (t.H * t.s) };
    viewChanged();
    return;
  }
  if (gesture && gesture.type === 'stroke') {
    if (Math.hypot(p.x - gesture.last.x, p.y - gesture.last.y) < 1.5) return;
    gesture.last = p;
    const { u, v } = toNorm(p.x, p.y);
    gesture.st.pts.push(u, v);
    gesture.buf.push(u, v);
    drawInk();
    if (performance.now() - gesture.sent > 40) flushStroke();
    return;
  }
  if (gesture && gesture.type === 'erase') { eraseAt(p.x, p.y); return; }
  // ポインターはマウスを動かすだけで表示（タッチは触れている間）
  if (S.tool === 'laser' && (e.pointerType === 'mouse' || (gesture && gesture.type === 'laser'))) moveLaser(p);
});

function moveLaser(p) {
  const { u, v } = toNorm(p.x, p.y);
  S.pointers.set('me', pushPtr(S.pointers.get('me'), S.cur.key, u, v));
  sendPointer(u, v);
}
function flushStroke() {
  if (!gesture || gesture.type !== 'stroke' || !gesture.buf.length) return;
  send({ t: 'sp', id: gesture.st.id, pts: gesture.buf });
  gesture.buf = [];
  gesture.sent = performance.now();
}
function finishStroke() { flushStroke(); gesture = null; }

function endPointer(e) {
  touches.delete(e.pointerId);
  if (!gesture) return;
  if (gesture.type === 'stroke') finishStroke();
  else if (gesture.type === 'laser' && e.pointerType !== 'mouse') { S.pointers.delete('me'); send({ t: 'ptr-off' }); gesture = null; }
  else if (gesture.type === 'pinch') { if (touches.size < 2) gesture = null; }
  else gesture = null;
  el.stage.classList.remove('panning');
}
el.ptr.addEventListener('pointerup', endPointer);
el.ptr.addEventListener('pointercancel', endPointer);
el.ptr.addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'mouse' && S.pointers.has('me')) { S.pointers.delete('me'); send({ t: 'ptr-off' }); }
});
el.ptr.addEventListener('contextmenu', (e) => e.preventDefault());
el.ptr.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = localPos(e);
  if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
}, { passive: false });

// ===================================================================
// ワイプ（小窓）のドラッグ・サイズ変更
// ===================================================================
function setupWipe(w) {
  let drag = null;
  w.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.wipe-close')) return;
    e.preventDefault();
    w.setPointerCapture(e.pointerId);
    const r = w.getBoundingClientRect(), sr = el.stage.getBoundingClientRect();
    drag = { resize: !!e.target.closest('.wipe-resize'), x: e.clientX, y: e.clientY, l: r.left - sr.left, t: r.top - sr.top, w: r.width };
  });
  w.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (drag.resize) {
      // 左下の角をつかんで拡大縮小（右上を固定）
      const nw = clamp(drag.w - dx, 120, SW * 0.9);
      w.style.width = nw + 'px';
      w.style.left = drag.l + drag.w - nw + 'px';
      w.style.top = drag.t + 'px';
    } else {
      w.style.left = clamp(drag.l + dx, 0, SW - drag.w) + 'px';
      w.style.top = clamp(drag.t + dy, 0, SH - w.offsetHeight) + 'px';
    }
    w.style.right = 'auto'; w.style.bottom = 'auto';
  });
  const end = () => { drag = null; };
  w.addEventListener('pointerup', end);
  w.addEventListener('pointercancel', end);
  w.addEventListener('dblclick', () => {
    // ダブルクリックで 小 → 中 → 大
    const sizes = [200, 320, Math.min(560, SW * 0.6)];
    const cur = w.offsetWidth;
    const next = sizes.find((s) => s > cur + 10) || sizes[0];
    w.style.width = next + 'px';
    keepWipesInside();
  });
  w.querySelector('.wipe-close').addEventListener('click', () => { w.dataset.closed = '1'; updateWipes(); });
}
function keepWipesInside() {
  for (const w of [el.remoteWipe, el.selfWipe]) {
    if (!w.style.left) continue;
    w.style.left = clamp(parseFloat(w.style.left), 0, Math.max(0, SW - w.offsetWidth)) + 'px';
    w.style.top = clamp(parseFloat(w.style.top), 0, Math.max(0, SH - w.offsetHeight)) + 'px';
  }
}
function updateWipes() {
  const live = S.content.type === 'live' ? S.content.who : null;
  const remoteWho = S.role === 'host' ? 'guest' : 'host';
  // 複数人のときは、相手の映像を左の列に並べる（ワイプは自分だけ）
  el.remoteWipe.hidden = isGroup() || !S.remoteStream || el.remoteWipe.dataset.closed === '1' || live === remoteWho || (!!live && live === S.partnerUid);
  el.selfWipe.hidden = el.selfWipe.dataset.closed === '1' || (!!live && isMeWho(live) && !S.content.screen);
  el.selfWipe.classList.toggle('mirror', S.mirror && realVideoTrack()?.getSettings().facingMode !== 'environment');
}

// ===================================================================
// 高画質スナップショット
// ===================================================================
async function takeSnapshot() {
  if (S.share) return snapScreen();
  const t = realVideoTrack();
  if (!t) { banner('カメラがありません'); send({ t: 'msg', text: `${S.name} 側にカメラがないため撮影できません` }); return; }
  progress('撮影中…', 0.3);
  let blob = null;
  try {
    // 一時的にカメラの最大解像度に上げてから1コマ取り出す
    const caps = t.getCapabilities ? t.getCapabilities() : {};
    const before = t.getSettings();
    if (caps.width && caps.width.max > (before.width || 0)) {
      try { await t.applyConstraints({ width: { ideal: caps.width.max }, height: { ideal: caps.height.max } }); } catch { /* 非対応 */ }
      await waitFrameSize(t, 1500);
    }
    blob = await grabFrame(t);
  } catch (e) { console.error(e); }
  await applyQuality();
  progress(null);
  if (!blob) { banner('撮影できませんでした'); return; }
  const now = new Date();
  const name = `写真_${now.getHours()}時${String(now.getMinutes()).padStart(2, '0')}分.jpg`;
  const doc = { id: rid(), kind: 'image', name, mime: 'image/jpeg', blob };
  await prepareDoc(doc);
  sendDoc(doc);
  setContent({ type: 'doc', docId: doc.id, page: 1 });
}
function onSnapRequest(who = S.remoteName) {
  if (!S.external) { banner(`${who} の依頼で撮影します`); takeSnapshot(); return; }
  askConfirm(`${who} から、こちらのカメラで高画質の写真を撮って共有するよう依頼がありました。撮影しますか？`, '撮影する').then((ok) => {
    if (!S.inCall) return;
    if (ok) takeSnapshot();
    else send({ t: 'msg', text: '撮影の依頼はお断りされました' });
  });
}
async function snapScreen() {
  progress('画面を撮影中…', 0.3);
  let blob = null;
  try { blob = await grabFrame(S.share.track); } catch (e) { console.error(e); }
  progress(null);
  if (!blob) { banner('撮影できませんでした'); return; }
  const now = new Date();
  const doc = { id: rid(), kind: 'image', name: `画面_${now.getHours()}時${String(now.getMinutes()).padStart(2, '0')}分.jpg`, mime: 'image/jpeg', blob };
  await prepareDoc(doc);
  sendDoc(doc);
  setContent({ type: 'doc', docId: doc.id, page: 1 });
}
async function waitFrameSize(track, ms) {
  const end = performance.now() + ms;
  const target = track.getSettings().width;
  const v = el.selfWipe.querySelector('video');
  while (performance.now() < end) {
    if (v.videoWidth && v.videoWidth >= target) return;
    await sleep(50);
  }
}
async function grabFrame(track) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true;
  v.srcObject = new MediaStream([track]);
  await v.play();
  await new Promise((r) => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(() => r()) : setTimeout(r, 200)));
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  v.srcObject = null;
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.93));
}

// ===================================================================
// 書き込み付きで保存
// ===================================================================
async function saveImage() {
  const cur = S.cur;
  if (!cur) { banner('保存する図面がありません'); return; }
  progress('保存用の画像を作成中…', 0.5);
  let W, H, drawBg;
  if (cur.kind === 'pdf') {
    const k = 5000 / Math.max(cur.W, cur.H);
    W = Math.round(cur.W * k); H = Math.round(cur.H * k);
    drawBg = async (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); await cur.page.render({ canvasContext: g, viewport: cur.page.getViewport({ scale: k }) }).promise; };
  } else if (cur.kind === 'image') {
    W = cur.W; H = cur.H;
    drawBg = (g) => g.drawImage(cur.img, 0, 0);
  } else {
    W = el.stageVideo.videoWidth || 1280; H = el.stageVideo.videoHeight || 720;
    drawBg = (g) => g.drawImage(el.stageVideo, 0, 0, W, H);
  }
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  await drawBg(g);
  const ink = document.createElement('canvas');
  ink.width = W; ink.height = H;
  drawStrokes(ink.getContext('2d'), S.strokes.get(cur.key) || [], { s: W / cur.W, ox: 0, oy: 0, W: cur.W, H: cur.H });
  g.globalCompositeOperation = 'multiply';
  g.drawImage(ink, 0, 0);
  progress(null);
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const base = cur.doc ? cur.doc.name.replace(/\.[^.]+$/, '') : 'カメラ';
  const page = cur.kind === 'pdf' ? `_p${S.content.page}` : '';
  c.toBlob((b) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `${base}${page}_書き込み_${stamp}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}

// ===================================================================
// 打ち合わせの記録を保存（1つの ZIP にまとめる）
//   文字起こし・チャット.txt … 日時・参加者・使った資料・発言（文字起こし）・チャット
//   資料/      … 開いた図面・資料・撮った写真の元のファイル
//   書き込み/  … 書き込みのあるページを、書き込み付きの画像（PNG）にしたもの
// ===================================================================
let lastRecord = null; // 通話を終えたあと、保存するかを聞く間だけ持っておく
function snapshotRecord() {
  const inp = collectMinutesInput();
  const ext = S.external ? S.extChat.filter((e) => e.from !== 'sys').map((e) => ({ ts: e.ts, name: e.from === 'me' ? myCallName() : S.remoteName, text: e.text })) : [];
  return {
    ...inp, me: myCallName(), chats: [...inp.chats, ...ext].sort((a, b) => a.ts - b.ts),
    docs: [...S.docs.values()].map((d) => ({ id: d.id, kind: d.kind, name: d.name, mime: d.mime, blob: d.blob, src: d.src || null, pages: d.pages })),
    strokes: [...S.strokes.entries()].filter(([, l]) => l && l.length).map(([k, l]) => [k, l.map((st) => ({ ...st, pts: st.pts.slice() }))]),
  };
}
const recordHasContent = (r) => !!r && (r.docs.length || r.lines.length || r.chats.length);
function recordText(r) {
  const t = (ts) => new Date(ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  const mins = Math.max(1, Math.round((r.end - r.start) / 60000));
  const out = [
    '打ち合わせの記録（図面テレビ電話）',
    `日時：${fmtDate(r.start)} ${hhmm(r.start)}〜${hhmm(r.end)}（約${mins}分）`,
    `参加者：${r.me}、${r.partner}`,
    `資料・写真：${r.docs.length ? r.docs.map((d) => d.name).join('、') : 'なし'}`,
    '', '■ 文字起こし',
  ];
  if (r.lines.length) for (const l of r.lines) out.push(`[${t(l.ts)}] ${l.name}：${l.text}`);
  else out.push('（文字起こしはしていません）');
  out.push('', '■ チャット');
  if (r.chats.length) for (const c of r.chats) out.push(`[${t(c.ts)}] ${c.name}：${c.text}`);
  else out.push('（なし）');
  return out.join('\r\n') + '\r\n';
}
// ZIP（無圧縮）を作る。ファイル名は UTF-8（Windows のエクスプローラーで日本語のまま開ける）
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = f.data, crc = crc32(data);
    const head = (sig, extra) => { const b = new DataView(new ArrayBuffer(extra)); b.setUint32(0, sig, true); return b; };
    const lh = head(0x04034b50, 30);
    lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh, name, data);
    const ch = head(0x02014b50, 46);
    ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, x) => n + x.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
const safeName = (n) => String(n).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || '資料';
function recordFileName(d) {
  if (d.src) return d.name;
  if (d.kind === 'pdf') return /\.pdf$/i.test(d.name) ? d.name : d.name + '.pdf';
  return /\.(png|jpe?g|jfif|gif|webp|bmp|avif|heic|heif|ico)$/i.test(d.name) ? d.name : d.name + (d.mime === 'image/png' ? '.png' : '.jpg');
}
async function saveRecord(r) {
  if (!recordHasContent(r)) { banner('保存する記録（資料・書き込み・文字起こし）がありません', 4000); return false; }
  const files = [], used = new Set();
  const add = (name, data) => {
    let n = name, i = 2;
    while (used.has(n)) n = name.replace(/(\.[^./]+)?$/, (ext) => `(${i++})${ext}`);
    used.add(n); files.push({ name: n, data });
  };
  add('文字起こし・チャット.txt', new TextEncoder().encode('\ufeff' + recordText(r)));
  const strokes = new Map(r.strokes);
  try {
    let done = 0;
    for (const d of r.docs) {
      progress(`記録を作成中… ${d.name}`, done++ / Math.max(1, r.docs.length));
      // 自分で開いた Word・Excel・CAD などは元のファイルを、相手から届いたものは変換後の PDF・画像を保存する
      add(`資料/${safeName(recordFileName(d))}`, new Uint8Array(await (d.src || d.blob).arrayBuffer()));
      const pages = [...strokes.keys()].filter((k) => k.startsWith(d.id + ':')).map((k) => Number(k.slice(d.id.length + 1))).filter((n) => n >= 1).sort((a, b) => a - b);
      if (!pages.length) continue;
      const base = safeName(d.name.replace(/\.[^.]+$/, ''));
      let pdf = null, img = null;
      if (d.kind === 'pdf') pdf = await (await ensurePdfjs()).getDocument({ data: new Uint8Array(await d.blob.arrayBuffer()), isEvalSupported: false }).promise;
      else img = await createImageBitmap(d.blob);
      try {
        for (const n of pages) {
          let W, H, k, drawBg;
          if (pdf) {
            const pg = await pdf.getPage(clamp(n, 1, pdf.numPages));
            const vp = pg.getViewport({ scale: 1 });
            W = vp.width; H = vp.height; k = 3000 / Math.max(W, H);
            drawBg = (g) => pg.render({ canvasContext: g, viewport: pg.getViewport({ scale: k }) }).promise;
          } else {
            W = img.width; H = img.height; k = 1;
            drawBg = (g) => g.drawImage(img, 0, 0);
          }
          const c = document.createElement('canvas');
          c.width = Math.round(W * k); c.height = Math.round(H * k);
          const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
          await drawBg(g);
          const ink = document.createElement('canvas');
          ink.width = c.width; ink.height = c.height;
          drawStrokes(ink.getContext('2d'), strokes.get(`${d.id}:${n}`), { s: k, ox: 0, oy: 0, W, H });
          g.globalCompositeOperation = 'multiply';
          g.drawImage(ink, 0, 0);
          const png = await new Promise((res) => c.toBlob(res, 'image/png'));
          add(`書き込み/${base}${pdf ? `_p${n}` : ''}_書き込み.png`, new Uint8Array(await png.arrayBuffer()));
        }
      } finally { try { pdf && pdf.destroy(); img && img.close && img.close(); } catch { /* 解放済み */ } }
    }
  } catch (e) {
    console.error(e);
    progress(null);
    banner('記録の一部を作れませんでした', 6000);
  }
  progress(null);
  const dt = new Date(r.start);
  const stamp = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}-${String(dt.getHours()).padStart(2, '0')}${String(dt.getMinutes()).padStart(2, '0')}`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(makeZip(files));
  a.download = `打ち合わせ記録_${stamp}_${safeName(r.partner)}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return true;
}
// 通話を終えたら、記録を保存するか聞く
function askSaveRecord(r) {
  lastRecord = r;
  const n = r.docs.length, ink = r.strokes.filter(([k]) => !k.startsWith('live:')).length;
  $('#recordSummary').textContent = `資料・写真 ${n} 件、書き込みのあるページ ${ink} 枚、文字起こし ${r.lines.length} 件、チャット ${r.chats.length} 件`;
  $('#recordDlg').showModal();
}

// ===================================================================
// 受信・送信画質の表示
// ===================================================================
const prevStats = { inBytes: 0, inTs: 0 };
async function pollStats() {
  const pc = S.call && S.call.peerConnection;
  if (!pc) { el.statsText.textContent = ''; return; }
  let rep;
  try { rep = await pc.getStats(); } catch { return; }
  let inb = null, outb = null;
  rep.forEach((r) => {
    if (r.type === 'inbound-rtp' && r.kind === 'video') inb = r;
    if (r.type === 'outbound-rtp' && r.kind === 'video') outb = r;
  });
  const parts = [];
  if (inb && inb.frameWidth) {
    let mbps = '';
    if (prevStats.inTs) mbps = ` ${((inb.bytesReceived - prevStats.inBytes) * 8 / ((inb.timestamp - prevStats.inTs) / 1000) / 1e6).toFixed(1)}Mbps`;
    prevStats.inBytes = inb.bytesReceived; prevStats.inTs = inb.timestamp;
    parts.push(`受信 ${inb.frameWidth}×${inb.frameHeight} ${Math.round(inb.framesPerSecond || 0)}fps${mbps}`);
  }
  if (outb && outb.frameWidth) {
    const why = { bandwidth: '・回線で制限中', cpu: '・PC性能で制限中' }[outb.qualityLimitationReason] || '';
    parts.push(`送信 ${outb.frameWidth}×${outb.frameHeight}${why}`);
  }
  // 直接つながらず中継サーバー（TURN）を通っていると、映像も図面の送信も遅くなる
  let relay = false;
  rep.forEach((r) => {
    if (r.type !== 'transport' || !r.selectedCandidatePairId) return;
    const pair = rep.get(r.selectedCandidatePairId);
    const lc = pair && rep.get(pair.localCandidateId), rc = pair && rep.get(pair.remoteCandidateId);
    relay = relay || (lc && lc.candidateType === 'relay') || (rc && rc.candidateType === 'relay');
  });
  if (relay) parts.push('中継サーバー経由（図面の送信が遅くなります）');
  el.statsText.textContent = parts.join(' ／ ');
  el.statsText.classList.toggle('warn', relay);
}

// ===================================================================
// ツールバー
// ===================================================================
function setTool(t) {
  S.tool = t;
  $$('.tool-sel').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  el.stage.className = 'tool-' + t;
  if (t !== 'laser' && S.pointers.has('me')) { S.pointers.delete('me'); send({ t: 'ptr-off' }); }
  if (t === 'hl' && S.color === '#222222') setColor(COLORS[0]); // 黒の蛍光ペンは見えにくい
}
function setColor(c) {
  S.color = c;
  $$('.swatch').forEach((b) => b.classList.toggle('on', b.dataset.color === c));
}
function updateToolbar() {
  const c = S.content;
  const doc = c.type === 'doc' ? S.docs.get(c.docId) || S.previews.get(c.docId) : null;
  const isPdf = doc && doc.kind === 'pdf';
  el.pageText.textContent = isPdf ? `${c.page} / ${doc.pages}` : doc ? '1 / 1' : c.type === 'live' ? (c.screen ? '画面' : 'カメラ') : '-';
  $('#prevBtn').disabled = !isPdf || c.page <= 1;
  $('#nextBtn').disabled = !isPdf || c.page >= doc.pages;
  $('#liveRemoteBtn').classList.toggle('on', c.type === 'live' && !isMeWho(c.who) && !c.screen);
  $('#liveSelfBtn').classList.toggle('on', c.type === 'live' && isMeWho(c.who) && !c.screen);
  const sb = $('#shareBtn');
  sb.classList.toggle('on', !!S.share);
  sb.textContent = S.share ? '共有を停止' : '画面共有';
  renderTabs();
}
// 全画面：上下のバーを隠し、映像（図面）だけを画面いっぱいに表示する
function setFullscreen(on) {
  if (on && S.content.type === 'none') showLive(otherWho()); // 何も映していなければ相手のカメラ
  el.room.classList.toggle('full', on);
  $('#fullExitBtn').hidden = !on;
  try {
    if (on && !document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  } catch { /* 全画面に対応していないブラウザは、バーを隠すだけ */ }
  requestAnimationFrame(layout);
}

function gotoPage(d) {
  const c = S.content;
  if (c.type !== 'doc') return;
  const doc = S.docs.get(c.docId) || S.previews.get(c.docId);
  if (!doc) return;
  const page = clamp(c.page + d, 1, doc.pages);
  if (page !== c.page) setContent({ ...c, page });
}
function showLive(who) {
  const c = S.content;
  if (c.type === 'live' && c.who === who && !c.screen) return;
  setContent({ type: 'live', who });
}

// ===================================================================
// タブ（通話中に開いた図面・撮った写真。エクセルのシートのように切り替える）
//   図面と書き込みは通話が終わるまで両方の端末に残っているので、タブで選べばすぐ戻れる
// ===================================================================
function rememberDocView() {
  const c = S.content;
  if (c.type !== 'doc') return;
  const d = S.docs.get(c.docId);
  if (d) { d.lastPage = c.page; d.lastView = { ...S.view }; }
}
function selectDoc(id) {
  const d = S.docs.get(id);
  if (!d) return;
  if (S.content.type === 'doc' && S.content.docId === id) return;
  setContent({ type: 'doc', docId: id, page: d.lastPage || 1 }, { view: d.lastView });
}
const docIcon = (d) => (d.kind === 'pdf' ? '図' : /^画面_/.test(d.name) ? '画' : /^写真_/.test(d.name) ? '写' : '絵');
let tabSig = '';
function renderTabs() {
  const bar = $('#tabbar');
  if (!bar) return;
  const c = S.content;
  // 拡大・移動のたびに作り直さないよう、タブの中身が変わったときだけ描き直す
  const pending = [...S.previews.values()].filter((p) => !S.docs.has(p.id));
  const sig = [...S.docs.values()].map((d) => `${d.id}.${d.pages}.${d.lastPage || 1}`).join() + '|' + pending.map((p) => p.id).join() + '|' + (c.type === 'doc' ? `${c.docId}.${c.page}` : '');
  if (sig === tabSig) return;
  tabSig = sig;
  const list = $('#tabList');
  list.innerHTML = '';
  for (const d of S.docs.values()) {
    const active = c.type === 'doc' && c.docId === d.id;
    const tab = document.createElement('div');
    tab.className = 'tab' + (active ? ' on' : '');
    tab.setAttribute('role', 'presentation');
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'tab-main';
    main.setAttribute('role', 'tab');
    main.setAttribute('aria-selected', active ? 'true' : 'false');
    main.title = d.name;
    const ic = document.createElement('span');
    ic.className = 'tab-ic';
    ic.textContent = docIcon(d);
    const nm = document.createElement('span');
    nm.className = 'tab-name';
    nm.textContent = d.name.replace(/\.[^.]+$/, '');
    main.append(ic, nm);
    if (d.kind === 'pdf' && d.pages > 1) {
      const pg = document.createElement('span');
      pg.className = 'tab-page';
      pg.textContent = `${active ? c.page : d.lastPage || 1}/${d.pages}`;
      main.appendChild(pg);
    }
    main.addEventListener('click', () => selectDoc(d.id));
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'tab-x';
    x.textContent = '×';
    x.title = 'このタブを閉じる';
    x.setAttribute('aria-label', `${d.name} を閉じる`);
    x.addEventListener('click', () => closeDoc(d.id));
    tab.append(main, x);
    list.appendChild(tab);
    if (active) requestAnimationFrame(() => tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }
  // 見本画像だけ届いていて、本物を受信中の図面
  for (const p of pending) {
    const active = c.type === 'doc' && c.docId === p.id;
    const tab = document.createElement('div');
    tab.className = 'tab loading' + (active ? ' on' : '');
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'tab-main';
    main.setAttribute('role', 'tab');
    main.setAttribute('aria-selected', active ? 'true' : 'false');
    main.title = `${p.name}（受信中）`;
    const ic = document.createElement('span');
    ic.className = 'tab-ic';
    ic.textContent = docIcon(p);
    const nm = document.createElement('span');
    nm.className = 'tab-name';
    nm.textContent = p.name.replace(/\.[^.]+$/, '');
    const st = document.createElement('span');
    st.className = 'tab-page';
    st.textContent = '受信中';
    main.append(ic, nm, st);
    main.addEventListener('click', () => { if (!active) setContent({ type: 'doc', docId: p.id, page: p.imgs.keys().next().value || 1 }); });
    tab.appendChild(main);
    list.appendChild(tab);
  }
  bar.classList.toggle('empty', !S.docs.size && !pending.length);
}
async function closeDoc(id, { fromRemote = false } = {}) {
  const d = S.docs.get(id);
  if (!d) {
    if (fromRemote && S.previews.delete(id)) {
      if (S.content.type === 'doc' && S.content.docId === id) setContent({ type: 'none' }, { send: false });
      renderTabs();
    }
    return;
  }
  const keys = [...S.strokes.keys()].filter((k) => k.startsWith(id + ':'));
  const inked = keys.some((k) => (S.strokes.get(k) || []).length);
  if (!fromRemote && !(await askConfirm(`「${d.name}」のタブを閉じます。${inked ? '書き込みも消えます。' : ''}相手の画面からも閉じます。`, '閉じる'))) return;
  if (!S.docs.has(id)) return;
  // 表示中なら、となりのタブ（なければ何も表示しない）へ
  if (S.content.type === 'doc' && S.content.docId === id) {
    const ids = [...S.docs.keys()];
    const i = ids.indexOf(id);
    const next = ids[i + 1] || ids[i - 1];
    S.content = { type: 'none' }; // 閉じる図面の位置は覚えない
    if (next) selectDoc(next);
    else setContent({ type: 'none' }, { send: !fromRemote });
  }
  for (const k of keys) { for (const st of S.strokes.get(k) || []) S.strokeById.delete(st.id); S.strokes.delete(k); }
  try { d.pdf && d.pdf.destroy(); d.img && d.img.close && d.img.close(); } catch { /* 解放済み */ }
  S.docs.delete(id);
  if (!fromRemote) send({ t: 'doc-close', id });
  renderTabs();
}

// ===================================================================
// 画面共有（自分のデスクトップやアプリの画面を相手に見せる）
//   送っているカメラ映像を、共有する画面に差し替える（共有中は相手に顔は映らない）
// ===================================================================
const canShare = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
async function startShare() {
  if (S.share) return;
  if (!canShare()) { banner('この端末（ブラウザ）は画面共有に対応していません。PC の Chrome か Edge を使ってください', 6000); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 }, width: { max: 2560 }, height: { max: 1440 } }, audio: false });
  } catch (e) {
    if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') banner('画面共有を開始できませんでした');
    return;
  }
  const track = stream.getVideoTracks()[0];
  if (!track || !S.inCall) { stream.getTracks().forEach((t) => t.stop()); return; }
  track.contentHint = 'detail';
  track.addEventListener('ended', () => { if (S.share && S.share.track === track) stopShare(); });
  rememberDocView();
  S.share = { stream, track, prev: S.content };
  for (const sd of videoSenders()) { try { await sd.replaceTrack(track); } catch (e) { console.warn(e); } }
  applyQuality();
  send({ t: 'share', on: true });
  setContent({ type: 'live', who: meWho(), screen: true });
  banner('画面を共有しています。やめるときは「共有を停止」を押してください', 6000);
}
// 共有をやめて、カメラ映像に戻す
async function stopShare() {
  const sh = S.share;
  if (!sh) return;
  endShare();
  const cam = S.localStream && S.localStream.getVideoTracks()[0];
  if (cam) for (const sd of videoSenders()) { try { await sd.replaceTrack(cam); } catch (e) { console.warn(e); } }
  applyQuality();
  send({ t: 'share', on: false });
  if (S.content.type === 'live' && S.content.screen && isMeWho(S.content.who)) {
    const p = sh.prev;
    if (p && p.type === 'doc' && S.docs.has(p.docId)) { const d = S.docs.get(p.docId); setContent({ ...p, page: d.lastPage || p.page }, { view: d.lastView }); }
    else if (p && p.type === 'live' && !p.screen) setContent(p);
    else setContent({ type: 'none' });
  }
  updateToolbar();
}
function endShare() {
  if (!S.share) return;
  S.share.stream.getTracks().forEach((t) => t.stop());
  S.share = null;
}

function setupToolbar() {
  const sw = $('#swatches');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.color = c;
    b.style.background = c;
    b.title = '色';
    b.addEventListener('click', () => { setColor(c); if (S.tool !== 'hl' && S.tool !== 'pen') setTool('hl'); });
    sw.appendChild(b);
  }
  setColor(S.color);
  $$('.tool-sel').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#openBtn').addEventListener('click', () => el.fileInput.click());
  if (CONV) el.fileInput.accept = CONV.accept;
  el.fileInput.addEventListener('change', () => { const fs = Array.from(el.fileInput.files || []); el.fileInput.value = ''; if (fs.length) openLocalFiles(fs); });
  $('#prevBtn').addEventListener('click', () => gotoPage(-1));
  $('#nextBtn').addEventListener('click', () => gotoPage(1));
  $('#zoomInBtn').addEventListener('click', () => zoomAt(SW / 2, SH / 2, 1.4));
  $('#zoomOutBtn').addEventListener('click', () => zoomAt(SW / 2, SH / 2, 1 / 1.4));
  $('#fitBtn').addEventListener('click', () => { S.view = { cx: 0.5, cy: 0.5, zoom: 1 }; viewChanged(); });
  $('#syncBtn').addEventListener('click', (e) => { S.sync = !S.sync; e.currentTarget.classList.toggle('on', S.sync); if (S.sync) viewChanged(); });
  $('#undoBtn').addEventListener('click', undo);
  $('#clearBtn').addEventListener('click', async () => { if (S.cur && await askConfirm('このページの書き込みを全部消します（相手の画面からも消えます）。', '全部消す')) clearStrokes(S.cur.key); });
  $('#liveRemoteBtn').addEventListener('click', async () => {
    if (!isGroup()) { showLive(otherWho()); return; }
    const uid = await pickPerson('だれのカメラを大きく映しますか？');
    if (uid) showLive(uid);
  });
  $('#liveSelfBtn').addEventListener('click', () => showLive(meWho()));
  $('#snapSelfBtn').addEventListener('click', takeSnapshot);
  $('#shareBtn').hidden = !canShare();
  $('#shareBtn').addEventListener('click', () => (S.share ? stopShare() : startShare()));
  $('#tabAddBtn').addEventListener('click', () => el.fileInput.click());
  setupDropOpen();
  $('#snapRemoteBtn').addEventListener('click', async () => {
    if (DEMO) { takeSnapshot(); return; }
    if (!links().length) { banner('相手とつながっていません'); return; }
    if (isGroup()) {
      const uid = await pickPerson('だれのカメラで撮影しますか？');
      if (!uid || !S.inCall) return;
      if (S.role === 'host') { const t = linkOfUid(uid); if (t) sendTo(t, { t: 'snap-req', from: S.uid }); }
      else send({ t: 'snap-req', to: uid });
      banner(`${nameOfUid(uid)} のカメラで撮影しています…`);
      return;
    }
    send({ t: 'snap-req' });
    banner('相手のカメラで撮影しています…');
  });
  $('#addBtn').addEventListener('click', openPartyDlg);
  $('#fullBtn').addEventListener('click', () => setFullscreen(!el.room.classList.contains('full')));
  $('#fullExitBtn').addEventListener('click', () => setFullscreen(false));
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && el.room.classList.contains('full')) setFullscreen(false); });
  $('#wipeBtn').addEventListener('click', () => {
    delete el.remoteWipe.dataset.closed; delete el.selfWipe.dataset.closed; delete $('#peerTiles').dataset.closed;
    for (const w of [el.remoteWipe, el.selfWipe]) { w.style.left = w.style.top = w.style.right = w.style.bottom = w.style.width = ''; }
    updateWipes();
    partyMedia();
  });
  $('#saveBtn').addEventListener('click', saveImage);
  $('#recordBtn').addEventListener('click', () => saveRecord(snapshotRecord()));
  $('#recordSaveBtn').addEventListener('click', async () => {
    const r = lastRecord;
    $('#recordDlg').close();
    if (r && await saveRecord(r)) lobbyMsg('打ち合わせの記録を保存しました（ダウンロードのフォルダに入っています）');
  });
  $('#recordDlg').addEventListener('close', () => { lastRecord = null; });
  $('#qualitySel').addEventListener('change', (e) => setQuality(e.target.value));
  $('#micBtn').addEventListener('click', (e) => {
    const t = S.localStream.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    e.currentTarget.classList.toggle('off', !t.enabled);
    e.currentTarget.textContent = t.enabled ? 'マイク' : 'マイク オフ';
  });
  $('#camBtn').addEventListener('click', (e) => {
    const t = S.localStream.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    e.currentTarget.classList.toggle('off', !t.enabled);
    e.currentTarget.textContent = t.enabled ? 'カメラ' : 'カメラ オフ';
  });
  // カメラ切替：次のカメラへ（スマホなら外側／内側）
  $('#flipBtn').addEventListener('click', async () => {
    const t = realVideoTrack();
    const fm = t && t.getSettings().facingMode;
    if (fm) {
      // スマホ：内側 ⇔ 外側
      await switchCamera('', fm === 'environment' ? 'user' : 'environment');
    } else {
      const cams = S.cams || [];
      if (cams.length < 2) return;
      const cur = (t && t.getSettings().deviceId) || S.camId;
      const i = cams.findIndex((d) => d.deviceId === cur);
      await switchCamera(cams[(i + 1) % cams.length].deviceId);
    }
    await listDevices();
    const now = realVideoTrack()?.getSettings().facingMode;
    if (now) banner(now === 'environment' ? '外側のカメラに切り替えました' : '内側のカメラに切り替えました', 2500);
  });
  $('#settingsBtn').addEventListener('click', async () => { await listDevices(); $('#settingsDlg').showModal(); });
  $('#setCam').addEventListener('change', (e) => switchCamera(e.target.value));
  $('#setMic').addEventListener('change', (e) => switchMic(e.target.value));
  $('#mirrorChk').checked = S.mirror;
  $('#mirrorChk').addEventListener('change', (e) => { S.mirror = e.target.checked; store.set('mirror', S.mirror); updateWipes(); });
  $('#leaveBtn').addEventListener('click', async () => {
    const hub = S.role === 'host' && S.extras.size;
    const q = GUEST_MODE ? '打ち合わせから退室しますか？' : hub ? `通話を終了しますか？（あなたが打ち合わせのまとめ役なので、${S.party.list.length}人全員の通話が終わります）` : isGroup() ? '打ち合わせから抜けますか？（ほかの人の打ち合わせは続きます）' : '通話を終了しますか？';
    if (await askConfirm(q, GUEST_MODE ? '退室する' : '終了する')) hangup();
  });

  window.addEventListener('keydown', (e) => {
    if (el.room.hidden || e.target.closest('input, select, textarea, dialog')) return;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'ArrowLeft' || k === 'PageUp') gotoPage(-1);
    else if (k === 'ArrowRight' || k === 'PageDown') gotoPage(1);
    else if (k === '+' || k === ';') zoomAt(SW / 2, SH / 2, 1.4);
    else if (k === '-') zoomAt(SW / 2, SH / 2, 1 / 1.4);
    else if (k === '0') { S.view = { cx: 0.5, cy: 0.5, zoom: 1 }; viewChanged(); }
    else if (k === 'l' || k === 'L') setTool('laser');
    else if (k === 'h' || k === 'H') setTool('hl');
    else if (k === 'p' || k === 'P') setTool('pen');
    else if (k === 'e' || k === 'E') setTool('eraser');
    else if (k === 'm' || k === 'M') setTool('hand');
    else if (k === 'f' || k === 'F') setFullscreen(!el.room.classList.contains('full'));
    else if (k === 'Escape' && el.room.classList.contains('full')) setFullscreen(false);
  });
  // 自動再生が止められたときの保険
  document.addEventListener('click', () => {
    if (el.remoteAudio.srcObject && el.remoteAudio.paused) el.remoteAudio.play().then(() => banner(null)).catch(() => {});
  });
}

// ===================================================================
// 複数人の打ち合わせ（最大6人）
//   電話を受けた側（まとめ役）が全員とつながり、図面・書き込み・ポインターなどを全員に配る。
//   映像と音声は、まとめ役以外の人どうしも直接つなぐ（つながらないときは、まとめ役が中継する）。
//   人を加えるのは「人を追加」から：社内の人は呼び出し、社外の方は招待リンクから入室を申し込んでもらう。
//   参加者どうしには打ち合わせの中だけの番号（uid）と、毎回ランダムな映像用の接続IDだけを知らせる。
// ===================================================================
function isGroup() { return S.inCall && (S.extras.size > 0 || S.party.list.length > 2); }
function isMeWho(w) { return !!w && (w === S.role || (!!S.uid && w === S.uid)); }
function meWho() { return isGroup() && S.uid ? S.uid : S.role; }
function otherWho() {
  if (isGroup()) { const p = S.party.list.find((x) => x.uid !== S.uid); if (p) return p.uid; }
  return S.role === 'host' ? 'guest' : 'host';
}
function partyCount() { return 1 + (S.partnerUid || S.conn ? 1 : 0) + S.extras.size + S.invites.size; }
function streamOfWho(w) {
  if (w === 'host' || w === 'guest' || w === S.partnerUid) return S.remoteStream;
  const X = S.extras.get(w);
  if (X) return X.stream;
  const v = S.mesh.get(w);
  if (v && v.stream) return v.stream;
  const r = S.relays.get(w);
  return r ? r.stream : null;
}
const PTR_COLORS = ['255,40,40', '30,110,255', '20,160,60', '235,120,0', '170,60,210', '0,150,170'];
function ptrColor(uid) {
  const i = S.party.list.findIndex((p) => p.uid === uid);
  return PTR_COLORS[(i < 0 ? 0 : i) % PTR_COLORS.length];
}
function extraByConn(c) { if (!c) return null; for (const X of S.extras.values()) if (X.c === c) return X; return null; }
function extraByPeer(peer) { for (const X of S.extras.values()) if (X.peer === peer) return X; return null; }
function extraByToken(token, peer) { for (const X of S.extras.values()) if (X.token === token && X.peer === peer) return X; return null; }
function uidOfConn(c) { if (c && c === S.conn) return S.partnerUid; const X = extraByConn(c); return X ? X.uid : ''; }
function linkOfUid(uid) { if (uid === S.partnerUid) return S.conn; const X = S.extras.get(uid); return X ? X.c : null; }
// 社内の人とのつながりか（社外の方は、ほかの人を呼び出せない）
function isInternalLink(c) {
  if (c === S.conn) return !S.external || !!memberByPid(S.partner);
  const X = extraByConn(c);
  return !!X && !X.external;
}

// ---- まとめ役：参加者の一覧を全員に配る ----
function rosterList(forExternal = S.external) {
  const l = [{ uid: S.uid, name: forExternal ? myCallName() : S.name, mesh: '' }];
  if (S.partnerUid) l.push({ uid: S.partnerUid, name: S.remoteName, mesh: S.primaryMesh, down: !(S.conn && S.conn.open) });
  for (const X of S.extras.values()) l.push({ uid: X.uid, name: X.name, mesh: X.mesh, down: !(X.c && X.c.open) });
  return l;
}
function broadcastRoster() {
  if (S.role !== 'host' || !S.inCall || !S.uid) return;
  if (!S.party.id) S.party.id = secureId(12);
  const list = rosterList(false);
  S.party = { id: S.party.id, hub: S.uid, list };
  for (const c of links()) {
    const ext = c === S.conn ? !memberByPid(S.partner) : !!(extraByConn(c) || {}).external;
    sendTo(c, { t: 'roster', id: S.party.id, hub: S.uid, you: uidOfConn(c), list: ext ? rosterList(true) : list });
  }
  partyChanged();
}
function setLinkMesh(c, id) {
  if (c === S.conn) S.primaryMesh = id;
  else { const X = extraByConn(c); if (!X) return; X.mesh = id; }
  broadcastRoster();
}
// 参加者：一覧を受け取る
function onRoster(m) {
  if (!isUid(m.you) || !isUid(m.hub) || !Array.isArray(m.list) || typeof m.id !== 'string') return;
  const list = m.list.slice(0, MAX_PARTY).filter((p) => p && isUid(p.uid)).map((p) => ({
    uid: p.uid, name: cleanText(p.name, 60) || '参加者', mesh: typeof p.mesh === 'string' ? p.mesh.slice(0, 64) : '', down: !!p.down,
  }));
  const was = isGroup();
  S.uid = m.you;
  S.partnerUid = m.hub;
  S.party = { id: m.id.slice(0, 40), hub: m.hub, list };
  const hub = list.find((p) => p.uid === m.hub);
  if (hub && !S.external) S.remoteName = hub.name;
  if (isGroup()) ensureMesh(); else closeMesh();
  for (const k of [...S.pointers.keys()]) if (k.startsWith('u:') && !list.some((p) => 'u:' + p.uid === k)) S.pointers.delete(k);
  partyChanged();
  if (isGroup() && !was) banner(`${list.length}人の打ち合わせになりました`, 4000);
}
function partyChanged() {
  partyMedia();
  updateWipes();
  updatePartyStatus();
  updateChatBadges();
  if ($('#partyDlg').open) renderPartyDlg();
  applyQuality();
}
function updatePartyStatus() {
  if (!S.inCall) return;
  if (!isGroup()) { if (S.conn && S.conn.open) setStatus(`${S.remoteName} と通話中`, 'ok'); return; }
  const names = S.party.list.filter((p) => p.uid !== S.uid).map((p) => p.name + (p.down ? '（再接続待ち）' : ''));
  setStatus(`打ち合わせ中（${S.party.list.length}人）：${names.join('、')}`, 'ok');
  $('#chatBtn').title = '打ち合わせの全員とのチャット';
}

// 複数人になったとき：「大きく映すカメラ」の指定を、全員に通じる番号に置き換える
function groupFormed() {
  if (!S.uid) S.uid = newUid();
  if (!S.partnerUid) S.partnerUid = newUid();
  const c = S.content;
  if (c.type === 'live' && (c.who === 'host' || c.who === 'guest')) setContent({ ...c, who: c.who === S.role ? S.uid : S.partnerUid }, { view: S.view });
}

// ---- まとめ役：参加者を加える・外す ----
function acceptExtra(c, { name, member = null, external = false }) {
  if (!S.inCall || S.role !== 'host') return;
  const X = { uid: newUid(), c, peer: c.peer, name, member, external, token: secureId(24), call: null, stream: null, mesh: '', timer: null };
  S.extras.set(X.uid, X);
  if (S.extras.size === 1) groupFormed();
  bindConn(c);
  fileChannel(c);
  sendTo(c, { t: 'accept', token: X.token, name: external ? myCallName() : S.name });
  sendHello(c);
  broadcastRoster();
  banner(`${name} が打ち合わせに参加しました`, 4000);
  addSysGroupChat(`${name} が参加しました`);
}
function reacceptExtra(X, c) {
  clearTimeout(X.timer);
  X.timer = null;
  const old = X.c;
  X.c = c;
  X.peer = c.peer;
  if (old && old !== c) { try { old.close(); } catch { /* 閉じている */ } }
  bindConn(c);
  fileChannel(c);
  sendTo(c, { t: 'accept', token: X.token, name: X.external ? myCallName() : S.name });
  sendHello(c);
  broadcastRoster();
}
// 回線が切れた → しばらく再接続を待つ
function extraDown(X) {
  if (X.call) { try { X.call.close(); } catch { /* 閉じている */ } X.call = null; }
  X.stream = null;
  S.pointers.delete('u:' + X.uid);
  clearTimeout(X.timer);
  X.timer = setTimeout(() => removeExtra(X, `${X.name} との接続が戻らなかったため、打ち合わせから外れました`), HOST_WAIT);
  banner(`${X.name} との回線が切れました。再接続を待っています`, 6000);
  broadcastRoster();
}
function removeExtra(X, msg) {
  if (S.extras.get(X.uid) !== X) return;
  S.extras.delete(X.uid);
  clearTimeout(X.timer);
  const { c, call } = X;
  setTimeout(() => { try { call && call.close(); c && c.close(); } catch { /* 閉じている */ } }, 300);
  closeRelaysOf(X.uid);
  S.pointers.delete('u:' + X.uid);
  if (S.content.type === 'live' && S.content.who === X.uid) setContent({ type: 'none' });
  broadcastRoster();
  if (msg) { banner(msg, 6000); addSysGroupChat(msg); }
}
// 最初の相手が抜けた：ほかに参加者がいれば、その人を最初の相手にして続ける
function primaryGone(msg) {
  if (!S.inCall) return;
  if (!S.extras.size) { hangup(msg, false); return; }
  const X = [...S.extras.values()].find((x) => x.c && x.c.open) || S.extras.values().next().value;
  const oldUid = S.partnerUid, oldConn = S.conn, oldCall = S.call;
  S.extras.delete(X.uid);
  clearTimeout(S.hostWaitTimer);
  S.conn = X.c;
  S.call = X.call;
  S.partner = X.peer;
  S.token = X.token;
  S.remoteName = X.name;
  S.partnerUid = X.uid;
  S.primaryMesh = X.mesh;
  if (X.timer) {
    clearTimeout(X.timer);
    if (!(S.conn && S.conn.open)) S.hostWaitTimer = setTimeout(() => primaryGone(`${X.name} との接続が戻らなかったため、打ち合わせから外れました`), HOST_WAIT);
  }
  if (S.call) bindCall(S.call);
  setTimeout(() => { try { oldCall && oldCall !== S.call && oldCall.close(); oldConn && oldConn !== S.conn && oldConn.close(); } catch { /* 閉じている */ } }, 300);
  closeRelaysOf(oldUid);
  S.pointers.delete('u:' + oldUid);
  S.pointers.delete('remote');
  setRemoteStream(X.stream);
  if (S.content.type === 'live' && S.content.who === oldUid) setContent({ type: 'none' });
  broadcastRoster();
  banner(msg, 6000);
  addSysGroupChat(msg);
}
function bindExtraCall(X, call) {
  if (X.call && X.call !== call) { try { X.call.close(); } catch { /* 閉じている */ } }
  X.call = call;
  call.on('stream', (st) => {
    // 途中で「最初の相手」に繰り上がった場合も、どちらの映像かは届いた時点で決める
    if (S.call === call) setRemoteStream(st);
    else { const Y = [...S.extras.values()].find((x) => x.call === call); if (Y) Y.stream = st; }
    if (S.share) for (const sd of videoSenders()) sd.replaceTrack(S.share.track).catch(() => {});
    partyMedia();
    if (S.content.type === 'live') attachStageVideo();
    setTimeout(applyQuality, 500);
  });
  const gone = () => {
    if (S.call === call) { S.call = null; setRemoteStream(null); return; }
    const Y = [...S.extras.values()].find((x) => x.call === call);
    if (Y) { Y.call = null; Y.stream = null; partyMedia(); }
  };
  call.on('close', gone);
  call.on('error', gone);
}

// ---- 社内の人を呼び出して加える（まとめ役が呼ぶ。ほかの参加者が押したときは、まとめ役に頼む） ----
function inviteMember(m) {
  if (!m || !S.inCall || S.role !== 'host') return;
  if (HOSTED || GUEST_MODE || !S.peer || !S.peer.open) { banner('このPCからは社内の人を呼び出せません'); return; }
  if (S.party.list.some((p) => p.name === m.name) || (S.remoteName === m.name && !isGroup()) || m.id === S.meId) { banner(`${m.name} はすでに参加しています`); return; }
  if (S.invites.has(m.id)) return;
  if (partyCount() >= MAX_PARTY) { banner(`打ち合わせは${MAX_PARTY}人までです`, 5000); return; }
  if (!S.uid) S.uid = newUid();
  const c = S.peer.connect(pidOf(m.id), { reliable: true, metadata: { type: 'call', name: S.name, invite: secureId(12), party: rosterList().map((p) => p.name) } });
  if (!c) return;
  const inv = { c, m };
  inv.done = (msg) => {
    if (S.invites.get(m.id) !== inv) return;
    S.invites.delete(m.id);
    clearTimeout(inv.timer);
    if (msg) { banner(msg, 6000); send({ t: 'msg', text: msg }); }
    renderPartyDlg();
  };
  S.invites.set(m.id, inv);
  inv.timer = setTimeout(() => {
    try { c.send({ t: 'cancel' }); } catch { /* 未接続 */ }
    setTimeout(() => c.close(), 500);
    inv.done(`${m.name} は応答しませんでした`);
  }, RING_TIMEOUT);
  c.on('data', (x) => {
    if (!x || S.invites.get(m.id) !== inv) return;
    if (x.t === 'join') {
      inv.done(null);
      if (!S.inCall || partyCount() >= MAX_PARTY) { sendTo(c, { t: 'bye' }); setTimeout(() => c.close(), 500); return; }
      c.removeAllListeners('data');
      c.removeAllListeners('close');
      acceptExtra(c, { name: m.name, member: m });
    } else if (x.t === 'reject') {
      inv.done(x.reason === 'callback' ? `${m.name}：「${CALLBACK_TEXT}」` : `${m.name} は今は出られません`);
      setTimeout(() => c.close(), 500);
    } else if (x.t === 'busy') {
      inv.done(`${m.name} は通話中です`);
      setTimeout(() => c.close(), 500);
    }
  });
  c.on('close', () => inv.done(`${m.name} につながりませんでした`));
  banner(`${m.name} を呼び出しています…`, 5000);
  renderPartyDlg();
}
// 呼び出された側：「出る」→ まとめ役に参加を伝え、受け入れられたら打ち合わせに入る
async function joinInvite(r) {
  endRinging(r);
  showCallOverlay('outgoing', r.name);
  $('#callStatus').textContent = 'の打ち合わせに参加しています…';
  await ensureMedia();
  if (S.ringing || S.inCall) return;
  if (r.cancelled || !r.c.open) { hideCallOverlay(); releaseMedia(); lobbyMsg(`${r.name} が呼び出しを取り消しました`); return; }
  r.c.removeAllListeners('data');
  r.c.removeAllListeners('close');
  const o = { c: r.c, peerId: r.c.peer, name: r.name, reconnect: false, member: r.from };
  S.outgoing = o;
  o.timer = setTimeout(() => endOutgoing(o, '打ち合わせに参加できませんでした', 'net'), 15_000);
  r.c.on('data', (m) => {
    if (S.outgoing !== o || !m) return;
    if (m.t === 'accept') onAccepted(o, m);
    else if (m.t === 'bye') endOutgoing(o, '打ち合わせは終了していました', 'net');
  });
  r.c.on('close', () => { if (S.outgoing === o) endOutgoing(o, '打ち合わせに参加できませんでした', 'net'); });
  r.c.send({ t: 'join' });
}
// 打ち合わせ中に、招待リンクから入室の希望が届いた
function knockInCall(c, label, viaHub = false) {
  startTone('chat');
  notify(`${label} が入室を希望しています`, '図面テレビ電話');
  c.on('close', () => { if (c._asking) banner(`${label} は入室の申し込みを取り消しました`, 5000); });
  c._asking = true;
  askConfirm(`${label} が招待リンクから入室を希望しています。この打ち合わせに入ってもらいますか？（今 ${partyCount()}人。最大${MAX_PARTY}人）`, '入室を許可').then((ok) => {
    c._asking = false;
    if (!S.inCall || !c.open) return;
    if (ok && viaHub) {
      const reqId = rid();
      S.doorWait.set(reqId, c);
      send({ t: 'door-req', reqId, hostName: S.meeting ? S.meeting.hostName : '' });
      setTimeout(() => { if (S.doorWait.get(reqId) === c) { S.doorWait.delete(reqId); try { c.send({ t: 'reject' }); } catch { /* 閉じている */ } setTimeout(() => c.close(), 800); } }, 15_000);
      return;
    }
    if (ok && partyCount() < MAX_PARTY) {
      if (!S.external) { S.external = true; if (S.meeting && !S.callName) S.callName = S.meeting.hostName; buildQuick(); }
      acceptExtra(c, { name: label, external: true });
    } else {
      try { c.send({ t: 'reject' }); } catch { /* 閉じている */ }
      setTimeout(() => c.close(), 800);
    }
  });
}

// ---- 全員のチャット ----
function receiveGroupChat(msg, name) {
  if (!msg || !isId(msg.id) || typeof msg.text !== 'string') return;
  const e = addChat(GRP, { id: msg.id, ts: finite(msg.ts) ? msg.ts : Date.now(), text: msg.text, from: 'them', name });
  if (!e) return;
  if (chat.open === GRP && document.visibilityState === 'visible') return;
  startTone('chat');
  notify(`${name} からメッセージ`, e.text.slice(0, 80));
  banner(`${name}：${e.text.slice(0, 60)}`, 6000);
}
function addSysGroupChat(text) {
  if (S.inCall && isGroup()) addChat(GRP, { from: 'sys', text, unread: false });
}

// ---- 参加者どうしの映像（まとめ役以外） ----
function meshPeerObj() { return GUEST_MODE ? S.peer : S.meshPeer; }
function myMeshId() { const p = meshPeerObj(); return p && p.open ? p.id : ''; }
function ensureMesh() {
  if (S.role === 'host' || !isGroup()) return;
  if (!GUEST_MODE && (!S.meshPeer || S.meshPeer.destroyed)) {
    const p = new Peer(peerOptions()); // 映像用の接続は毎回ランダムな ID（社内の接続IDは使わない）
    S.meshPeer = p;
    p.on('open', () => { if (S.meshPeer === p) { reportMesh(); syncMesh(); } });
    p.on('call', onMediaCall);
    p.on('connection', (c) => c.close());
    p.on('disconnected', () => { if (S.meshPeer === p && !p.destroyed) { try { p.reconnect(); } catch { /* 作り直す */ } } });
    p.on('error', (e) => console.warn('mesh', e.type));
  }
  reportMesh();
  syncMesh();
}
function reportMesh() {
  const id = myMeshId();
  if (id && S.sentMesh !== id) { S.sentMesh = id; send({ t: 'mesh', id }); }
}
function meshOthers() { return S.party.list.filter((p) => p.uid !== S.uid && p.uid !== S.party.hub); }
function syncMesh() {
  if (S.role === 'host') return;
  const others = meshOthers();
  for (const [uid, v] of [...S.mesh]) if (!others.some((p) => p.uid === uid && p.mesh === v.peer)) dropMesh(uid);
  for (const uid of [...S.relays.keys()]) if (!others.some((p) => p.uid === uid)) dropRelay(uid);
  const mine = myMeshId();
  if (!mine || !S.localStream || !isGroup()) return;
  for (const p of others) {
    // 2人のうち、ID の小さい方からかける（両方からかけて二重にならないように）
    if (!p.mesh || S.mesh.has(p.uid) || !(mine < p.mesh)) continue;
    const call = meshPeerObj().call(p.mesh, outStream(), { metadata: { g: S.party.id, uid: S.uid } });
    if (call) bindMesh(p.uid, call);
  }
}
function bindMesh(uid, call) {
  const v = { call, peer: call.peer, stream: null, at: Date.now() };
  S.mesh.set(uid, v);
  call.on('stream', (st) => {
    if (S.mesh.get(uid) !== v) return;
    v.stream = st;
    dropRelay(uid); // 直接つながったので中継は不要
    partyMedia();
    if (S.content.type === 'live') attachStageVideo();
    setTimeout(applyQuality, 500);
  });
  const gone = () => {
    if (S.mesh.get(uid) !== v) return;
    S.mesh.delete(uid);
    partyMedia();
    setTimeout(syncMesh, 3000);
  };
  call.on('close', gone);
  call.on('error', gone);
}
function acceptMesh(call) {
  const md = call.metadata || {};
  if (S.role === 'host' || !S.party.id || md.g !== S.party.id || !S.localStream) return false;
  const p = meshOthers().find((x) => x.uid === md.uid && x.mesh === call.peer);
  if (!p) return false;
  const old = S.mesh.get(p.uid);
  S.mesh.delete(p.uid);
  if (old) { try { old.call.close(); } catch { /* 閉じている */ } }
  call.answer(outStream());
  bindMesh(p.uid, call);
  return true;
}
function dropMesh(uid) {
  const v = S.mesh.get(uid);
  S.mesh.delete(uid);
  if (v) { try { v.call.close(); } catch { /* 閉じている */ } }
}
function closeMesh() {
  for (const uid of [...S.mesh.keys()]) dropMesh(uid);
  for (const uid of [...S.relays.keys()]) dropRelay(uid);
  S.meshWait.clear();
}
// 直接つながらない相手がいたら、まとめ役に中継を頼む（会社のネットワークの制限など）
function meshCheck() {
  if (!S.inCall || S.role === 'host' || !isGroup()) return;
  reportMesh();
  syncMesh();
  const now = Date.now();
  // かけたのに映像が来ない（相手がまだ一覧を受け取っていなかった等）→ かけ直す
  for (const [uid, v] of [...S.mesh]) if (!v.stream && now - v.at > 12_000) dropMesh(uid);
  for (const p of meshOthers()) {
    if (p.down) { S.meshWait.delete(p.uid); continue; }
    const ok = (S.mesh.get(p.uid) || {}).stream || (S.relays.get(p.uid) || {}).stream;
    if (ok) { S.meshWait.delete(p.uid); continue; }
    const w = S.meshWait.get(p.uid) || { since: now, asked: false };
    S.meshWait.set(p.uid, w);
    if (!w.asked && now - w.since > 20_000) { w.asked = true; send({ t: 'mesh-fail', uid: p.uid }); }
  }
}
function acceptRelay(call, uid) {
  if (!S.party.list.some((p) => p.uid === uid)) { call.close(); return; }
  call.answer(); // 受け取るだけ
  dropRelay(uid);
  const v = { call, stream: null };
  S.relays.set(uid, v);
  call.on('stream', (st) => { if (S.relays.get(uid) === v) { v.stream = st; partyMedia(); if (S.content.type === 'live') attachStageVideo(); } });
  const gone = () => { if (S.relays.get(uid) === v) { S.relays.delete(uid); S.meshWait.delete(uid); partyMedia(); } };
  call.on('close', gone);
  call.on('error', gone);
}
function dropRelay(uid) {
  const v = S.relays.get(uid);
  S.relays.delete(uid);
  if (v) { try { v.call.close(); } catch { /* 閉じている */ } }
}
// まとめ役：c の相手へ、uid の人の映像を中継する
function relayTo(c, uid) {
  const to = uidOfConn(c);
  const key = to + '>' + uid;
  const st = streamOfWho(uid);
  if (!to || uid === to || S.relayOut.has(key) || !st || !c.provider) return;
  const call = c.provider.call(c.peer, st, { metadata: { relay: uid } });
  if (!call) return;
  S.relayOut.set(key, call);
  const gone = () => { if (S.relayOut.get(key) === call) S.relayOut.delete(key); };
  call.on('close', gone);
  call.on('error', gone);
}
function closeRelaysOf(uid) {
  for (const [key, call] of [...S.relayOut]) {
    if (!key.split('>').includes(uid)) continue;
    S.relayOut.delete(key);
    try { call.close(); } catch { /* 閉じている */ }
  }
}
// ---- 社外の方を、まとめ役の入口へ案内する（まとめ役でない人が招待リンクを持っているとき） ----
function ensureDoor() {
  return new Promise((res) => {
    if (S.door && !S.door.destroyed && S.door.open) { res(S.door.id); return; }
    if (!S.door || S.door.destroyed) {
      const p = new Peer(peerOptions()); // 毎回ランダムな ID（社内の接続IDは知らせない）
      S.door = p;
      p.on('connection', (c) => c.on('open', () => { if (S.door === p && S.inCall) onKnock(c, true); else c.close(); }));
      p.on('call', onMediaCall);
      p.on('disconnected', () => { if (S.door === p && !p.destroyed) { try { p.reconnect(); } catch { /* 作り直す */ } } });
      p.on('error', (e) => console.warn('door', e.type));
    }
    const p = S.door;
    const to = setTimeout(() => res(''), 10_000);
    p.once('open', () => { clearTimeout(to); res(p.id); });
  });
}
async function openDoorFor(c, m) {
  if (partyCount() >= MAX_PARTY) { sendTo(c, { t: 'door', reqId: m.reqId, full: true }); return; }
  const id = await ensureDoor();
  if (!id || !S.inCall) { sendTo(c, { t: 'door', reqId: m.reqId }); return; }
  const ticket = secureId(20);
  S.tickets.set(ticket, Date.now() + 60_000);
  const hn = cleanText(m.hostName, 40);
  if (hn && !S.callName) S.callName = hn;
  sendTo(c, { t: 'door', reqId: m.reqId, id, ticket });
}
function onDoor(m) {
  const c = S.doorWait.get(m.reqId);
  if (!c) return;
  S.doorWait.delete(m.reqId);
  const ok = typeof m.id === 'string' && m.id.length <= 64 && typeof m.ticket === 'string' && m.ticket.length <= 64;
  try { c.send(ok ? { t: 'redirect', door: m.id, ticket: m.ticket } : { t: 'reject' }); } catch { /* 閉じている */ }
  if (!ok && m.full) banner(`打ち合わせは${MAX_PARTY}人までです`, 5000);
  setTimeout(() => c.close(), 1500);
}

function resetParty() {
  for (const X of S.extras.values()) {
    clearTimeout(X.timer);
    const { c, call } = X;
    setTimeout(() => { try { call && call.close(); c && c.close(); } catch { /* 閉じている */ } }, 300);
  }
  S.extras.clear();
  for (const inv of [...S.invites.values()]) { try { inv.c.send({ t: 'cancel' }); } catch { /* 未接続 */ } const c = inv.c; setTimeout(() => c.close(), 500); clearTimeout(inv.timer); }
  S.invites.clear();
  closeMesh();
  for (const call of S.relayOut.values()) { try { call.close(); } catch { /* 閉じている */ } }
  S.relayOut.clear();
  if (S.meshPeer) { try { S.meshPeer.destroy(); } catch { /* 済み */ } S.meshPeer = null; }
  if (S.door) { try { S.door.destroy(); } catch { /* 済み */ } S.door = null; }
  S.tickets.clear();
  for (const c of S.doorWait.values()) { try { c.close(); } catch { /* 閉じている */ } }
  S.doorWait.clear();
  S.uid = ''; S.partnerUid = ''; S.primaryMesh = ''; S.sentMesh = '';
  S.party = { id: '', hub: '', list: [] };
  S.grpChat = [];
  if ($('#partyDlg').open) $('#partyDlg').close();
  partyMedia();
  $('#chatBtn').title = '通話相手とのチャット';
}

// ---- 画面：相手の映像を左の列に並べる（押すと大きく映す）・声を流す ----
const tileEls = new Map();
const audioEls = new Map();
function partyMedia() {
  const box = $('#peerTiles');
  if (!box) return;
  const group = isGroup();
  const others = group ? S.party.list.filter((p) => p.uid !== S.uid) : [];
  const live = S.content.type === 'live' ? S.content.who : null;
  box.hidden = !others.length || box.dataset.closed === '1';
  for (const [uid, t] of [...tileEls]) if (!others.some((p) => p.uid === uid)) { t.querySelector('video').srcObject = null; t.remove(); tileEls.delete(uid); }
  for (const p of others) {
    let t = tileEls.get(p.uid);
    if (!t) {
      t = document.createElement('button');
      t.type = 'button';
      t.className = 'ptile';
      const v = document.createElement('video');
      v.muted = true; v.autoplay = true; v.playsInline = true;
      const lab = document.createElement('span');
      lab.className = 'wipe-label';
      t.append(v, lab);
      t.addEventListener('click', () => showLive(p.uid));
      box.appendChild(t);
      tileEls.set(p.uid, t);
    }
    const st = streamOfWho(p.uid);
    const v = t.querySelector('video');
    if (v.srcObject !== st) { v.srcObject = st; if (st) v.play().catch(() => {}); }
    t.querySelector('.wipe-label').textContent = p.name + (p.down ? '（再接続待ち）' : !st ? '（接続中…）' : '');
    t.title = `${p.name} のカメラを大きく映す`;
    t.classList.toggle('down', !st || !!p.down);
    t.hidden = live === p.uid;
  }
  // 声：最初の相手は remoteAudio、ほかの人はそれぞれの audio で流す
  const want = new Map();
  if (group) for (const p of others) if (p.uid !== S.partnerUid) { const st = streamOfWho(p.uid); if (st) want.set(p.uid, st); }
  for (const [uid, a] of [...audioEls]) if (!want.has(uid)) { a.srcObject = null; a.remove(); audioEls.delete(uid); }
  for (const [uid, st] of want) {
    let a = audioEls.get(uid);
    if (!a) { a = document.createElement('audio'); a.autoplay = true; document.body.appendChild(a); audioEls.set(uid, a); }
    if (a.srcObject !== st) { a.srcObject = st; a.play().catch(() => {}); }
  }
}

// だれか1人を選ぶ（大きく映す人・撮影してもらう人）
function pickPerson(title) {
  const d = $('#pickDlg');
  $('#pickTitle').textContent = title;
  const list = $('#pickList');
  list.innerHTML = '';
  for (const p of S.party.list.filter((x) => x.uid !== S.uid)) {
    const b = document.createElement('button');
    b.className = 'ghost pick';
    b.value = p.uid;
    b.textContent = p.name;
    list.appendChild(b);
  }
  d.returnValue = '';
  d.showModal();
  return new Promise((res) => d.addEventListener('close', () => res(isUid(d.returnValue) ? d.returnValue : null), { once: true }));
}

// ---- 「人を追加」：参加者の一覧と、社内の人の呼び出し ----
function openPartyDlg() {
  renderPartyDlg();
  $('#partyDlg').showModal();
}
function renderPartyDlg() {
  const d = $('#partyDlg');
  if (!d) return;
  const list = isGroup() || S.party.list.length ? S.party.list : [];
  const people = list.length ? list.map((p) => ({ name: p.name + (p.uid === S.uid ? '（自分）' : '') + (p.uid === S.party.hub ? '・まとめ役' : '') + (p.down ? '・再接続待ち' : '') }))
    : [{ name: `${myCallName()}（自分）` }, { name: S.remoteName }];
  const n = Math.max(people.length, partyCount());
  $('#partyCount').textContent = `${people.length}人（最大${MAX_PARTY}人）`;
  const ul = $('#partyList');
  ul.innerHTML = '';
  for (const p of people) { const li = document.createElement('li'); li.textContent = p.name; ul.appendChild(li); }
  // 社内の人を呼ぶ（社外の方の画面・Web 版には出さない）
  const canCall = !GUEST_MODE && !HOSTED && !DEMO && !!S.meId && isInternalSelf();
  $('#partyInvite').hidden = !canCall;
  const ml = $('#partyMembers');
  ml.innerHTML = '';
  if (canCall) {
    for (const m of MEMBERS) {
      if (m.id === S.meId) continue;
      const li = document.createElement('li');
      const nm = document.createElement('span');
      nm.textContent = m.name;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'primary small';
      const inParty = people.some((p) => p.name.startsWith(m.name)) || S.remoteName === m.name;
      const calling = S.invites.has(m.id);
      b.textContent = inParty ? '参加中' : calling ? '呼び出し中…' : '呼ぶ';
      b.disabled = inParty || calling || n >= MAX_PARTY;
      b.addEventListener('click', () => {
        if (S.role === 'host') inviteMember(m);
        else { send({ t: 'invite', id: m.id }); banner(`${m.name} の呼び出しを、まとめ役（${S.remoteName}）のPCに頼みました`, 5000); }
        b.disabled = true; b.textContent = '呼び出し中…';
      });
      li.append(nm, b);
      ml.appendChild(li);
    }
  }
  const hint = $('#partyLinkHint');
  const copy = $('#partyCopyBtn');
  copy.hidden = true;
  if (S.role === 'host' && S.meeting) {
    hint.textContent = `社外の方は、招待リンク（${S.meeting.label || '招待リンク'}）から入室を申し込むと、この画面に確認が出ます。「入室を許可」すると参加できます。`;
    copy.hidden = false;
  } else if (S.role === 'host' && !GUEST_MODE) {
    hint.textContent = '社外の方を入れるときは、待受画面の「社外の方との打ち合わせ」で招待リンクを作って送ってください（打ち合わせ中に作ることはできません）。';
  } else {
    hint.textContent = GUEST_MODE ? 'ほかの方の参加は、招待した側が受け付けます。' : `社外の方の参加は、まとめ役（${S.remoteName}）の招待リンクから受け付けます。`;
  }
}
// 自分が社内の人か（社外の方との打ち合わせに参加している社内の人も、社内の人を呼べる）
function isInternalSelf() { return !GUEST_MODE && !HOSTED; }

// ===================================================================
// 社外の方との打ち合わせ（招待リンク）
//   自社側（ホスト）：招待リンクを作り、推測できない部屋番号（約130ビットの乱数）で待機する。
//     相手が来ると呼び出し音が鳴り、「入室を許可」したときだけ打ち合わせが始まる。
//   社外の方（ゲスト）：リンクを開き、名前を入れて「入室する」だけ（アカウント・インストール不要）。
//   社内用の合言葉（companyKey）や社内のPCの接続IDは、リンクにも通信にも含めない。
// ===================================================================
const roomPid = (room) => `zm-${room}`;
const MEET_RETRY_LIMIT = 30 * 60_000; // 相手（ホスト）がまだ待機していないとき、自動で申し込み直す時間
function myCallName() {
  return S.external && S.role === 'host' && S.callName ? S.callName : S.name;
}
function defaultHostName() {
  return cleanText(store.get('meetHostName', '') || [CFG.companyName, HOSTED ? '' : S.name].filter(Boolean).join(' '), 40);
}
function joinBase() {
  if (CFG.joinUrl) return String(CFG.joinUrl);
  if (/^https?:$/.test(location.protocol)) return location.origin + location.pathname;
  return DEFAULT_JOIN_URL;
}
function meetLink(mt) {
  // 動作確認用に接続先サーバーを指定している場合だけ、その指定を引き継ぐ
  const keep = QS.has('host') ? ['host', 'port', 'path', 'secure'].filter((k) => QS.has(k)) : [];
  const q = keep.length ? '?' + keep.map((k) => `${k}=${encodeURIComponent(QS.get(k))}`).join('&') : '';
  const h = new URLSearchParams({ j: mt.id });
  if (mt.hostName) h.set('n', mt.hostName);
  // 社外の方の画面も、こちらで選んだデザインで表示する（狙撃の効果音を切っているときは、相手側も鳴らさない）
  if (TH && TH.current() !== TH.DEFAULT) h.set('t', TH.current());
  if (TH && TH.current() === 'sniper' && !TH.sound()) h.set('s', '0');
  return joinBase().replace(/[?#].*$/, '') + q + '#' + h.toString();
}
const loadMeetings = () => (store.get('meetings', []) || []).filter((r) => r && /^[a-z2-9]{20,40}$/.test(r.id));
function saveMeeting(rec) {
  const list = loadMeetings().filter((r) => r.id !== rec.id);
  list.unshift({ id: rec.id, label: rec.label, hostName: rec.hostName, created: rec.created, used: rec.used });
  store.set('meetings', list.slice(0, 10));
}
function setMeetState(text, kind) {
  const st = $('#meetState');
  st.textContent = text;
  st.className = 'meet-state' + (kind ? ' ' + kind : '');
}
function renderMeet() {
  const box = $('#meetBox');
  if (!box) return;
  box.hidden = DEMO || GUEST_MODE;
  if (box.hidden) return;
  const mt = S.meeting;
  $('#meetIdle').hidden = !!mt;
  $('#meetActive').hidden = !mt;
  if (mt) {
    $('#meetActiveLabel').textContent = mt.label || '招待リンク';
    $('#meetLink').value = meetLink(mt);
  } else if (!$('#meetHostName').value) {
    $('#meetHostName').value = defaultHostName();
  }
  const list = loadMeetings();
  $('#meetRecentWrap').hidden = !list.length || !!mt;
  const ul = $('#meetRecent');
  ul.innerHTML = '';
  for (const r of list) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 'meet-recent-label';
    t.textContent = `${r.label || '（相手先の記入なし）'}　${new Date(r.created).toLocaleDateString('ja-JP')} 作成`;
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'ghost small';
    go.textContent = 'このリンクで待機';
    go.addEventListener('click', () => startMeeting({ ...r }));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost small';
    del.textContent = '削除';
    del.title = 'このリンクを使えなくする（一覧から消す）';
    del.addEventListener('click', async () => {
      if (!(await askConfirm(`「${r.label || '招待リンク'}」を一覧から消します。消したリンクで待機することはできなくなります。`, '削除する'))) return;
      store.set('meetings', loadMeetings().filter((x) => x.id !== r.id));
      renderMeet();
    });
    li.append(t, go, del);
    ul.appendChild(li);
  }
}
function createMeeting() {
  const hostName = cleanText($('#meetHostName').value, 40);
  if (!hostName) { $('#meetHostName').focus(); lobbyMsg('「こちらの表示名」を入れてください（相手の画面に表示されます）'); return; }
  store.set('meetHostName', hostName);
  const rec = { id: secureId(26), label: cleanText($('#meetLabel').value, 40), hostName, created: Date.now() };
  $('#meetLabel').value = '';
  startMeeting(rec);
}
function startMeeting(rec) {
  if (typeof Peer === 'undefined') { lobbyMsg('部品（vendor フォルダ）が読み込めません'); return; }
  unlockSound();
  stopMeeting();
  rec.used = Date.now();
  saveMeeting(rec);
  S.meeting = { ...rec, peer: null };
  if (HOSTED) S.name = rec.hostName;
  lobbyMsg('');
  openMeetingPeer();
  renderMeet();
}
function openMeetingPeer() {
  const mt = S.meeting;
  if (!mt) return;
  if (mt.peer && !mt.peer.destroyed) mt.peer.destroy();
  const peer = new Peer(roomPid(mt.id), peerOptions());
  mt.peer = peer;
  const mine = () => S.meeting === mt && mt.peer === peer;
  setMeetState('接続中…');
  peer.on('open', () => { if (mine()) setMeetState('待機中：相手の入室を待っています', 'ok'); });
  peer.on('connection', (c) => c.on('open', () => { if (mine()) onKnock(c); else c.close(); }));
  peer.on('call', onMediaCall);
  peer.on('disconnected', () => { if (mine()) setMeetState('再接続中…', 'bad'); });
  peer.on('error', (e) => {
    if (!mine()) return;
    if (e.type === 'unavailable-id') {
      setMeetState('このリンクは別の画面（または別のPC）で待機中です。そちらを閉じると、ここで待機を始めます', 'bad');
      peer.destroy();
    } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed') {
      setMeetState('接続サーバーにつながりません。ネット接続を確認してください（自動で再試行します）', 'bad');
    } else {
      console.warn(e);
    }
  });
}
function stopMeeting() {
  const mt = S.meeting;
  if (!mt) return;
  S.meeting = null;
  if (mt.peer && !mt.peer.destroyed) {
    const p = mt.peer;
    // 打ち合わせ中に待機をやめた場合は、打ち合わせが終わってから切る
    if (S.inCall && S.external) { const t = setInterval(() => { if (!S.inCall) { clearInterval(t); p.destroy(); } }, 2000); } else p.destroy();
  }
  renderMeet();
}
function meetWatchdog() {
  const mt = S.meeting;
  if (!mt) return;
  if (!mt.peer || mt.peer.destroyed) openMeetingPeer();
  else if (mt.peer.disconnected) { try { mt.peer.reconnect(); } catch { mt.peer.destroy(); } }
}
// 招待リンクからの入室の希望
function onKnock(c, door = false) {
  const md = c.metadata || {};
  if (md.type !== 'join') { c.close(); return; }
  const name = cleanText(md.name, 30) || 'お名前なし';
  const company = cleanText(md.company, 40);
  const label = company ? `${name}様（${company}）` : `${name}様`;
  if (md.token) {
    // 打ち合わせ中の回線断からの再接続 → 鳴らさずにそのままつなぐ（同じ相手・同じ合言葉のときだけ）
    if (S.inCall && S.external && md.token === S.token && c.peer === S.partner) { acceptConn(c); return; }
    const X = S.inCall && S.role === 'host' && extraByToken(md.token, c.peer);
    if (X) { reacceptExtra(X, c); return; }
    try { c.send({ t: 'bye' }); } catch { /* 閉じている */ }
    setTimeout(() => c.close(), 800);
    return;
  }
  // 入口から：ほかの参加者がすでに許可した方 → 確認せずに入ってもらう
  if (door) {
    const exp = typeof md.ticket === 'string' && S.tickets.get(md.ticket);
    if (exp) S.tickets.delete(md.ticket);
    if (exp && exp > Date.now() && S.inCall && S.role === 'host' && partyCount() < MAX_PARTY) {
      if (!S.external) { S.external = true; buildQuick(); }
      acceptExtra(c, { name: label, external: true });
    } else { try { c.send({ t: 'reject' }); } catch { /* 閉じている */ } setTimeout(() => c.close(), 800); }
    return;
  }
  // 打ち合わせ中でも、まとめ役なら途中から入ってもらえる（最大6人）
  if (S.inCall && S.role === 'host' && !S.ringing && partyCount() < MAX_PARTY) { knockInCall(c, label); return; }
  // まとめ役でないときは、確認してから、まとめ役の入口へ案内する
  if (S.inCall && S.role === 'guest' && !S.ringing && S.conn && S.conn.open && Math.max(2, S.party.list.length) < MAX_PARTY) { knockInCall(c, label, true); return; }
  if (S.inCall || S.ringing || S.outgoing) {
    try { c.send({ t: 'busy' }); } catch { /* 閉じている */ }
    setTimeout(() => c.close(), 800);
    if (S.inCall && !S.external) banner(`${label} が入室を待っています（この通話を終えると、入室の希望が届きます）`, 10_000);
    return;
  }
  ring(c, label, null, { knock: true });
}

// ---- 社外の方（ゲスト）の画面 ----
const G = { state: 'form', retryTimer: null, since: 0, name: '', company: '', hostLabel: '' };
function setupGuest() {
  document.body.classList.add('guest');
  el.lobby.hidden = true;
  $('#guest').hidden = false;
  S.external = true;
  const host = cleanText(HASH.get('n'), 60);
  G.hostLabel = host || '相手';
  $('#guestHostLine').textContent = host ? `${host} との打ち合わせに参加します。` : '打ち合わせに参加します。';
  document.title = appTitle + (host ? `（${host}）` : '');
  $('#guestName').value = store.get('guestName', '');
  $('#guestCompany').value = store.get('guestCompany', '');
  let joinClick = null;
  $('#guestJoinBtn').addEventListener('click', (e) => { joinClick = e; });
  $('#guestForm').addEventListener('submit', (e) => { e.preventDefault(); snipe(joinClick, $('#guestJoinBtn'), guestJoin); joinClick = null; });
  $('#guestCancelBtn').addEventListener('click', guestCancel);
  $('#guestCamBtn').addEventListener('click', () => { if (S.localStream) releaseMedia(); else ensureMedia(); });
  $('#guestCam').addEventListener('change', (e) => switchCamera(e.target.value));
  $('#guestMic').addEventListener('change', (e) => switchMic(e.target.value));
  showGuest('form');
}
function showGuest(state, msg) {
  G.state = state;
  $('#guest').hidden = false;
  for (const x of $('#guestForm').querySelectorAll('input, select')) x.disabled = state === 'waiting';
  $('#guestJoinBtn').hidden = state === 'waiting';
  $('#guestJoinBtn').textContent = state === 'ended' ? 'もう一度入室する' : '入室する';
  $('#guestCancelBtn').hidden = state !== 'waiting';
  $('#guestMsg').textContent = msg || '';
}
async function guestJoin() {
  const name = cleanText($('#guestName').value, 30);
  if (!name) { $('#guestMsg').textContent = 'お名前を入れてください'; $('#guestName').focus(); return; }
  const company = cleanText($('#guestCompany').value, 40);
  store.set('guestName', name);
  store.set('guestCompany', company);
  G.name = name; G.company = company;
  S.name = company ? `${name}（${company}）` : name;
  G.since = Date.now();
  unlockSound();
  showGuest('waiting', '接続しています…');
  guestDial();
}
// ゲストは毎回ランダムな接続IDを使う（社外の方の端末を特定できる固定IDは作らない）
function guestPeerReady() {
  return new Promise((res) => {
    if (!S.peer || S.peer.destroyed) {
      const peer = new Peer(peerOptions());
      S.peer = peer;
      peer.on('call', onMediaCall);
      peer.on('connection', (c) => c.close());
      peer.on('disconnected', () => { if (S.peer === peer && !peer.destroyed) { try { peer.reconnect(); } catch { peer.destroy(); } } });
      peer.on('error', (e) => {
        if (S.peer !== peer) return;
        if (e.type === 'peer-unavailable') {
          const m = /peer\s+(\S+)/.exec(e.message || '');
          onPeerUnavailable(m ? m[1] : '');
        } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed') {
          if (!S.inCall && G.state === 'waiting' && !S.outgoing) guestRetry('net');
        } else console.warn(e);
      });
    }
    const peer = S.peer;
    if (peer.open) { res(true); return; }
    const to = setTimeout(() => { peer.off('open', ok); res(false); }, 15_000);
    const ok = () => { clearTimeout(to); res(true); };
    peer.once('open', ok);
  });
}
async function guestDial() {
  clearTimeout(G.retryTimer);
  if (S.inCall || S.outgoing || G.state !== 'waiting') return;
  const [ready] = await Promise.all([guestPeerReady(), ensureMedia()]);
  if (G.state !== 'waiting' || S.inCall || S.outgoing) return;
  if (!ready) { if (S.peer && !S.peer.open) { S.peer.destroy(); } guestRetry('net'); return; }
  dial(roomPid(JOIN_ROOM), G.hostLabel, false, null);
}
function guestRetry(kind) {
  if (G.state !== 'waiting') return;
  clearTimeout(G.retryTimer);
  if (Date.now() - G.since > MEET_RETRY_LIMIT) {
    releaseMedia();
    showGuest('form', '相手とつながりませんでした。お手数ですが、時間をおいてもう一度「入室する」を押してください。');
    return;
  }
  const msg = {
    absent: '相手はまだ待機していません。このままお待ちください（自動で入室を申し込みます）。',
    busy: 'ただいま相手は別の打ち合わせ中です。このままお待ちください（自動で入室を申し込みます）。',
    net: 'インターネットに接続できません。接続を確認しています…',
  }[kind];
  showGuest('waiting', msg);
  G.retryTimer = setTimeout(guestDial, kind === 'absent' ? 5000 : 10_000);
}
// 申し込みの結果（入室できなかったとき）
function guestOutcome(why) {
  if (G.state !== 'waiting') return;
  if (why === 'absent' || why === 'busy' || why === 'net') { guestRetry(why); return; }
  releaseMedia();
  const msg = {
    reject: '入室はお断りされました。',
    timeout: '相手が応答しませんでした。お手数ですが、もう一度「入室する」を押してください。',
    ice: 'お使いのネットワークでは相手と直接つながりませんでした。会社のネットワークの制限が考えられます。スマートフォンの回線（テザリング）など、別の回線でお試しください。',
    cancel: '',
  }[why] ?? 'つながりませんでした。もう一度「入室する」を押してください。';
  showGuest('form', msg);
}
function guestCancel() {
  clearTimeout(G.retryTimer);
  const o = S.outgoing;
  G.state = 'form'; // 先に状態を戻して、自動の申し込み直しを止める
  if (o) cancelCall();
  releaseMedia();
  showGuest('form', '');
}

// ===================================================================
// 待受画面（相手の一覧）
// ===================================================================
function setMeStatus(text, kind) {
  $('#meStatus').textContent = text;
  $('#meDot').className = 'dot' + (kind ? ' ' + kind : '');
}

function renderContacts() {
  const ul = $('#contactList');
  if (!ul || GUEST_MODE || HOSTED) return;
  ul.innerHTML = '';
  for (const m of MEMBERS) {
    if (m.id === S.meId) continue;
    const st = presence.get(m.id) || 'unknown';
    const flag = S.flags[m.id];
    const unread = S.unread[m.id] || 0;
    const li = document.createElement('li');
    li.className = 'contact' + (flag ? ' flagged ' + flag.kind : '');
    const av = document.createElement('span');
    av.className = 'avatar';
    av.textContent = markOf(m.name);
    const info = document.createElement('span');
    info.className = 'cinfo';
    const nm = document.createElement('b');
    nm.textContent = m.name;
    const ps = document.createElement('small');
    ps.className = 'presence ' + st;
    ps.textContent = { online: '待受中', offline: '呼び出せません（PCの電源・スリープ・ネットを確認）', unknown: '確認中…' }[st];
    info.append(nm, ps);
    if (flag) {
      const f = document.createElement('span');
      f.className = 'flag';
      f.textContent = flag.kind === 'callback' ? `折り返し予定（${hhmm(flag.ts)}に「折り返します」と返信）` : `不在着信 ${hhmm(flag.ts)}`;
      const x = document.createElement('button');
      x.className = 'flag-x';
      x.title = 'この表示を消す';
      x.setAttribute('aria-label', 'この表示を消す');
      x.textContent = '×';
      x.addEventListener('click', () => clearFlag(m.id));
      f.appendChild(x);
      info.appendChild(f);
    }
    const chatBtn = document.createElement('button');
    chatBtn.className = 'ghost chatbtn';
    chatBtn.textContent = 'チャット';
    if (unread) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = unread;
      chatBtn.appendChild(b);
    }
    chatBtn.addEventListener('click', () => { unlockSound(); openChat(m.id); });
    const btn = document.createElement('button');
    btn.className = 'primary callbtn';
    btn.textContent = flag ? '折り返す' : '呼び出す';
    btn.addEventListener('click', () => { unlockSound(); placeCall(m); });
    const acts = document.createElement('span');
    acts.className = 'cacts';
    acts.append(chatBtn, btn);
    li.append(av, info, acts);
    ul.appendChild(li);
  }
}

function showSetup() {
  $('#setupBox').hidden = false;
  $('#standbyBox').hidden = true;
  const box = $('#memberChoices');
  box.innerHTML = '';
  for (const m of MEMBERS) {
    const b = document.createElement('button');
    b.className = 'ghost choice' + (m.id === S.meId ? ' on' : '');
    b.textContent = m.name;
    b.addEventListener('click', () => { unlockSound(); chooseMe(m.id); });
    box.appendChild(b);
  }
  // 最小化されていても気づけるよう、タスクバーの表示で知らせる
  flashTitle('このPCの設定が必要です');
}

function chooseMe(id) {
  const m = MEMBERS.find((x) => x.id === id);
  if (!m) { showSetup(); return; }
  flashTitle(null);
  S.meId = m.id;
  S.name = m.name;
  store.set('meId', m.id);
  // 着信の知らせ方：未設定なら、事務所は普通の表示、それ以外（現場）は点滅＋大きく高い音
  const saved = store.get('alert', null);
  const loud = DEMO || m.id !== 'office'; // デモでは現場側の目立つ着信を見せる
  S.alert = saved || { flash: loud, sound: loud ? 'loud' : 'normal', volume: 0.8 };
  $('#meName').textContent = m.name;
  $('#setupBox').hidden = true;
  $('#standbyBox').hidden = false;
  presence.clear();
  renderContacts();
  updateBellHint();
  if (DEMO) {
    for (const x of MEMBERS) if (x.id !== m.id) presence.set(x.id, 'online');
    renderContacts();
    setMeStatus('デモ（この1台だけで動きます。通信はしません）', 'ok');
    return;
  }
  if (CONFIG_ERROR) { setMeStatus(CONFIG_ERROR, 'bad'); flashTitle('設定ファイルの確認が必要です'); return; }
  if (typeof Peer === 'undefined') { setMeStatus('部品（vendor フォルダ）が読み込めません。フォルダごとコピーしてください', 'bad'); return; }
  startStandby();
}

// ---- 着信の知らせ方の設定 ----
let alertTest = null;
function openAlertSettings() {
  const a = S.alert;
  $$('input[name="alertFlash"]').forEach((r) => { r.checked = String(a.flash) === r.value; });
  $$('input[name="alertSound"]').forEach((r) => { r.checked = a.sound === r.value; });
  $('#alertVolume').value = Math.round(a.volume * 100);
  updateNotifyRow();
  $('#alertDlg').showModal();
}
function readAlertSettings() {
  const flash = ($$('input[name="alertFlash"]').find((r) => r.checked) || {}).value === 'true';
  const sound = ($$('input[name="alertSound"]').find((r) => r.checked) || {}).value || 'normal';
  const volume = clamp(Number($('#alertVolume').value) / 100, 0, 1);
  S.alert = { flash, sound, volume };
  store.set('alert', S.alert);
  updateBellHint();
}
function testAlert() {
  unlockSound();
  readAlertSettings();
  stopAlertTest();
  showCallOverlay('incoming', '（お試し）', { keepDialogs: true });
  $('#callStatus').textContent = 'このように知らせます（5秒で止まります）';
  for (const id of ['#answerBtn', '#callbackBtn', '#declineBtn']) $(id).hidden = true;
  startTone('ring', { seconds: 5 });
  $('#callOverlay').classList.toggle('flash', S.alert.flash);
  alertTest = setTimeout(stopAlertTest, 5000);
}
function stopAlertTest() {
  if (!alertTest) return;
  clearTimeout(alertTest);
  alertTest = null;
  if (!S.ringing && !S.outgoing) { hideCallOverlay(); stopAlert(); }
}

// ---- 画面のデザイン（このPCだけの設定。社外の方の画面も、これに合わせて表示する） ----
const themeMsg = () => ({ theme: TH.current(), fx: TH.sound() });
// 社外の方の画面：招待した側のデザインに合わせる（保存はしない）
function applyHostTheme(m) {
  if (!GUEST_MODE || !TH) return;
  if (typeof m.theme === 'string' && TH.valid(m.theme)) TH.set(m.theme, { save: false });
  if (typeof m.fx === 'boolean') TH.setSound(m.fx, { save: false });
}
// 案42「狙撃」のときは、ボタンを撃ち抜く動きを見せてから処理する。効果音は押したこの端末だけで鳴る（相手には送らない）
function snipe(e, btn, fn) {
  if (!TH || !TH.snipes()) { fn(); return; }
  TH.shoot(btn, e);
  if (btn.dataset.firing) return; // 続けて押しても、処理は1回だけ
  btn.dataset.firing = '1';
  setTimeout(() => { delete btn.dataset.firing; fn(); }, TH.shotMs());
}
function renderThemeChoices() {
  const cur = TH.current();
  const list = $('#themeList');
  list.innerHTML = '';
  for (const t of TH.list) {
    const lab = document.createElement('label');
    lab.className = 'theme-opt';
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = 'theme';
    r.value = t.id;
    r.checked = t.id === cur;
    const sw = document.createElement('span');
    sw.className = 'theme-sw';
    for (const c of t.sw) { const i = document.createElement('i'); i.style.background = c; sw.appendChild(i); }
    const nm = document.createElement('span');
    nm.className = 'theme-name';
    const b = document.createElement('b');
    b.textContent = t.name;
    const sm = document.createElement('small');
    sm.textContent = t.no + (t.id === TH.DEFAULT ? '（はじめのデザイン）' : '');
    nm.append(b, sm);
    lab.append(r, sw, nm);
    list.appendChild(lab);
  }
  $('#sniperOpts').hidden = cur !== 'sniper';
  $('#fxSoundChk').checked = TH.sound();
}
function chooseTheme(id) {
  TH.set(id);
  $('#sniperOpts').hidden = TH.current() !== 'sniper';
  $('#setTheme').value = TH.current();
  themeChanged();
}
// 招待リンクを作り直し、打ち合わせ中なら社外の方の画面も切り替える
function themeChanged() {
  renderMeet();
  if (S.inCall && S.external && S.role === 'host') send({ t: 'theme', ...themeMsg() });
}
function setupTheme() {
  if (!TH) { $('#themeBtn').hidden = true; $('#setTheme').closest('label').hidden = true; return; }
  $('#themeBtn').addEventListener('click', () => {
    renderThemeChoices();
    $$('#fxTestBtn .shot').forEach((x) => x.remove());
    $('#themeDlg').showModal();
  });
  $('#themeList').addEventListener('change', (e) => { if (e.target.name === 'theme') chooseTheme(e.target.value); });
  $('#fxSoundChk').addEventListener('change', (e) => { TH.setSound(e.target.checked); themeChanged(); });
  $('#fxTestBtn').addEventListener('click', (e) => snipe(e, e.currentTarget, () => {}));
  const sel = $('#setTheme');
  for (const t of TH.list) sel.add(new Option(`${t.no} ${t.name}`, t.id));
  sel.value = TH.current();
  sel.addEventListener('change', (e) => chooseTheme(e.target.value));
}

function setupMeet() {
  $('#meetCreateBtn').addEventListener('click', createMeeting);
  $('#meetEndBtn').addEventListener('click', async () => {
    if (await askConfirm('このリンクでの待機をやめます。相手はリンクから入室できなくなります（あとで「このリンクで待機」で再開できます）。', '待機をやめる')) stopMeeting();
  });
  $('#meetCopyBtn').addEventListener('click', async () => {
    const link = $('#meetLink').value;
    try { await navigator.clipboard.writeText(link); lobbyMsg('招待リンクをコピーしました。メールやチャットに貼り付けて相手に送ってください'); }
    catch { $('#meetLink').select(); document.execCommand('copy'); lobbyMsg('招待リンクをコピーしました'); }
  });
  $('#meetMailBtn').addEventListener('click', () => {
    const mt = S.meeting;
    if (!mt) return;
    const subject = 'オンライン打ち合わせのご案内';
    const body = `${mt.hostName}です。\n下記のリンクから、オンライン打ち合わせにご参加ください。\n\n${meetLink(mt)}\n\n・パソコンは Chrome か Edge、スマートフォンはそのままのブラウザで開いてください（インストール・登録は不要です）。\n・LINE などのアプリの中で開いてうまく映らないときは、メニューの「ブラウザで開く」を選んでください。\n・お名前を入れて「入室する」を押すと、こちらで確認のうえ打ち合わせを始めます。\n`;
    location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  });
  $('#meetShareBtn').hidden = !navigator.share;
  $('#meetShareBtn').addEventListener('click', () => {
    const mt = S.meeting;
    if (mt && navigator.share) navigator.share({ title: 'オンライン打ち合わせのご案内', text: `${mt.hostName} とのオンライン打ち合わせ`, url: meetLink(mt) }).catch(() => {});
  });
  $('#meetHostName').addEventListener('change', (e) => store.set('meetHostName', cleanText(e.target.value, 40)));
}
function setupLobby() {
  $('#changeMeBtn').addEventListener('click', () => { if (!S.inCall) showSetup(); });
  el.lobbyCam.addEventListener('change', async (e) => { await switchCamera(e.target.value); });
  el.lobbyMic.addEventListener('change', async (e) => { await switchMic(e.target.value); });
  $('#answerBtn').addEventListener('click', (e) => { unlockSound(); snipe(e, e.currentTarget, answer); });
  $('#callbackBtn').addEventListener('click', (e) => snipe(e, e.currentTarget, () => decline('callback')));
  $('#declineBtn').addEventListener('click', (e) => snipe(e, e.currentTarget, () => decline('reject')));
  $('#cancelBtn').addEventListener('click', cancelCall);
  $('#previewBtn').addEventListener('click', () => { if (S.localStream) releaseMedia(); else ensureMedia(); });
  // 着信の知らせ方
  $('#alertBtn').addEventListener('click', openAlertSettings);
  $('#alertTestBtn').addEventListener('click', testAlert);
  $('#notifyBtn').addEventListener('click', async () => { await askNotify(); updateNotifyRow(); });
  $('#alertDlg').addEventListener('change', readAlertSettings);
  $('#alertDlg').addEventListener('close', () => { readAlertSettings(); stopAlertTest(); });
  setupTheme();
  // チャット
  $('#chatCloseBtn').addEventListener('click', closeChat);
  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!chat.open) return;
    sendChat(chat.open, $('#chatInput').value);
    $('#chatInput').value = '';
  });
  buildQuick();
  $('#chatCallBtn').addEventListener('click', () => { const m = memberById(chat.open); if (m) placeCall(m); });
  $('#chatBtn').addEventListener('click', () => {
    const id = partnerChatId();
    if (!id) return;
    if (chat.open) closeChat(); else openChat(id);
  });
  // 最初のクリックで着信音を使えるようにする（ブラウザの決まり）
  document.addEventListener('pointerdown', unlockSound, true);
  document.addEventListener('keydown', unlockSound, true);
  // 着信画面はキーボードでも操作できる（手袋・フットスイッチ用）：Enter/スペース＝出る、Esc＝折り返します
  document.addEventListener('keydown', (e) => {
    if ($('#callOverlay').hidden || !S.ringing) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); answer(); }
    else if (e.key === 'Escape') { e.preventDefault(); decline('callback'); }
  });
}

// 同じPC・同じブラウザで2つ目の画面を開いたかどうか
function anotherWindowOpen() {
  if (!('BroadcastChannel' in window)) return Promise.resolve(false);
  const ch = new BroadcastChannel('zumen-call');
  return new Promise((res) => {
    let found = false;
    ch.onmessage = (e) => { if (e.data === 'here') found = true; };
    ch.postMessage('who');
    setTimeout(() => {
      // 以後は自分が「開いている画面」として返事をする
      ch.onmessage = (e) => { if (e.data === 'who') ch.postMessage('here'); };
      res(found);
    }, 400);
  });
}

async function init() {
  setupLobby();
  setupToolbar();
  setupWipe(el.remoteWipe);
  setupWipe(el.selfWipe);
  setupMinutes();
  window.addEventListener('resize', layout);
  new ResizeObserver(() => { if (!el.room.hidden) layout(); }).observe(el.stage);
  requestAnimationFrame(drawPointers);
  setInterval(pollStats, 2000);
  setInterval(meshCheck, 5000);
  $('#tilesHideBtn').addEventListener('click', () => { $('#peerTiles').dataset.closed = '1'; partyMedia(); });
  $('#partyCopyBtn').addEventListener('click', async () => { const mt = S.meeting; if (!mt) return; try { await navigator.clipboard.writeText(meetLink(mt)); banner('招待リンクをコピーしました', 3000); } catch { banner(meetLink(mt), 10_000); } });
  audioCtx(); // 起動オプションで自動再生が許可されていれば、この時点で着信音が使える
  setInterval(updateBellHint, 1000);
  if (!navigator.mediaDevices || !window.RTCPeerConnection) {
    if (GUEST_MODE) { el.lobby.hidden = true; $('#guest').hidden = false; $('#guestJoinBtn').disabled = true; }
    lobbyMsg(GUEST_MODE
      ? 'このブラウザでは参加できません。パソコンは Chrome か Edge、iPhone は Safari、Android は Chrome で開いてください（LINE などのアプリの中で開いた場合は、メニューの「ブラウザで開く」を選んでください）。'
      : 'このブラウザでは使えません。Chrome または Edge で開いてください');
    return;
  }
  if (DEMO) {
    document.body.classList.add('demo');
    $('#addBtn').hidden = true; // デモは1台だけなので、人は追加できない
  }
  // 議事録の自動作成は保留中：議事録のボタンを出さない（文字起こし・字幕は使える）
  if (!MINUTES_ON) {
    for (const id of ['#minutesBtn', '#historyBtn']) $(id).classList.add('feature-off');
    $('#trBtn').title = '話した内容を文字にして、画面の下に字幕で出す（相手側も自動で始まります）';
  }
  setupMeet();
  // 社外の方：招待リンクから開いた → 入室画面だけを出す
  if (GUEST_MODE) {
    setupGuest();
    setInterval(watchdog, 5000);
    window.addEventListener('pagehide', () => { if (S.inCall) send({ t: 'bye' }); });
    await listDevices();
    navigator.mediaDevices.addEventListener?.('devicechange', listDevices);
    return;
  }
  // Web に置いた版（設定ファイルなし）：招待リンクの打ち合わせだけ
  if (HOSTED) {
    document.body.classList.add('hosted');
    S.alert = store.get('alert', S.alert);
    updateBellHint();
    $('#setupBox').hidden = true;
    $('#standbyBox').hidden = true;
    renderMeet();
    setInterval(watchdog, 5000);
    window.addEventListener('online', watchdog);
    window.addEventListener('pagehide', () => { if (S.inCall) send({ t: 'bye' }); });
    refreshLocalVideos();
    await listDevices();
    navigator.mediaDevices.addEventListener?.('devicechange', listDevices);
    return;
  }
  if (!DEMO && await anotherWindowOpen()) {
    $('#setupBox').hidden = true;
    $('#standbyBox').hidden = true;
    setMeStatus('すでに別の画面で待受しています', 'bad');
    lobbyMsg('図面テレビ電話はすでに開いています。タスクバーの「図面テレビ電話」をクリックしてください。この画面は閉じてかまいません。');
    try { window.close(); } catch { /* 閉じられない場合はそのまま */ }
    return;
  }
  // このPCが誰かを決めて、すぐに待受を始める
  const saved = QS.get('me') || store.get('meId', DEMO ? 'office' : '');
  if (MEMBERS.some((m) => m.id === saved)) chooseMe(saved); else showSetup();
  renderMeet();
  refreshTitle();
  setInterval(watchdog, 5000);
  setInterval(probeAll, 30_000);
  window.addEventListener('online', watchdog);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    watchdog();
    probeAll(true);
    if (chat.open) openChat(chat.open); // 開いているチャットは既読にする
  });
  // 画面を閉じるときは、相手に通話の終了を伝える
  window.addEventListener('pagehide', () => { if (S.inCall) send({ t: 'bye' }); });

  refreshLocalVideos();
  await listDevices();
  navigator.mediaDevices.addEventListener?.('devicechange', listDevices);
}

init();
})();
