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
function lobbyMsg(t) { el.lobbyMsg.textContent = t || ''; }
// 画面内の確認ダイアログ（ブラウザの confirm() は処理を止めてしまい、表示できない環境もあるため使わない）
function askConfirm(text, okLabel = 'はい') {
  const d = $('#confirmDlg');
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = okLabel;
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
  for (const sel of [el.lobbyCam, $('#setCam')]) fillSelect(sel, cams, curCam, 'カメラ');
  S.cams = cams;
  $('#flipBtn').hidden = cams.length < 2 && !realVideoTrack()?.getSettings().facingMode;
  for (const sel of [el.lobbyMic, $('#setMic')]) fillSelect(sel, mics, curMic, 'マイク');
}
function fillSelect(sel, list, cur, label) {
  sel.innerHTML = '';
  if (!list.length) { sel.add(new Option(label + 'が見つかりません', '')); sel.disabled = true; return; }
  sel.disabled = false;
  list.forEach((d, i) => sel.add(new Option(d.label || `${label} ${i + 1}`, d.deviceId)));
  if (cur && list.some((d) => d.deviceId === cur)) sel.value = cur;
}

function videoSender() {
  const pc = S.call && S.call.peerConnection;
  return pc ? pc.getSenders().find((s) => s.track && s.track.kind === 'video') || pc.getSenders().find((s) => !s.track || s.track.kind === 'video') : null;
}
function audioSender() {
  const pc = S.call && S.call.peerConnection;
  return pc ? pc.getSenders().find((s) => s.track && s.track.kind === 'audio') : null;
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
  const sender = videoSender();
  if (sender) await sender.replaceTrack(nt);
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
  const sender = audioSender();
  if (sender) await sender.replaceTrack(nt);
}

function refreshLocalVideos() {
  el.lobbyVideo.srcObject = S.localStream;
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
  const sender = videoSender();
  if (!sender || !sender.getParameters) return;
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  p.encodings[0].maxBitrate = q.br;
  p.encodings[0].scaleResolutionDownBy = 1;
  p.degradationPreference = q.deg;
  try { await sender.setParameters(p); }
  catch {
    try { delete p.degradationPreference; await sender.setParameters(p); } catch { /* 未対応ブラウザ */ }
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
  peer.on('call', (call) => {
    if (S.inCall && S.conn && call.peer === S.conn.peer && S.localStream) { call.answer(S.localStream); bindCall(call); }
    else call.close();
  });
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

// スリープ復帰やネット切断のあとも自動で待受に戻る
function watchdog() {
  if (!S.meId || CONFIG_ERROR || DEMO) return;
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
  ring(c, name, from);
}

// ---- 着信 ----
function ring(c, name, from) {
  const r = { c, name, from, cancelled: false };
  S.ringing = r;
  showCallOverlay('incoming', name);
  startAlert();
  notify(`${name} から着信`, '図面テレビ電話');
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
  setFlag(r.from.id, 'missed');
  addChat(r.from.id, { from: 'sys', text: '不在着信' });
  lobbyMsg(`不在着信：${r.name}（${t}）`);
}
async function answer() {
  const r = S.ringing;
  if (!r) return;
  if (r.demo) { demoAnswer(r); return; }
  endRinging(r);
  S.role = 'host';
  S.partner = r.c.peer;
  S.token = rid();
  S.remoteName = r.name;
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
  if (kind === 'callback') {
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
  c.send({ t: 'accept', token: S.token, name: S.name });
  sendHello();
  onCallConnected();
}
function onCallConnected() {
  setStatus(`${S.remoteName} と通話中`, 'ok');
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
  const c = S.peer && S.peer.open ? S.peer.connect(peerId, { reliable: true, metadata: { type: 'call', name: S.name, token: reconnect ? S.token : null } }) : null;
  const o = { c, peerId, name, reconnect, member };
  S.outgoing = o;
  if (!c) { endOutgoing(o, reconnect ? null : `${name} につながりませんでした`); return; }
  o.timer = setTimeout(() => endOutgoing(o, reconnect ? null : `${name} は応答しませんでした`), reconnect ? 10_000 : RING_TIMEOUT);
  c.on('data', (m) => {
    if (S.outgoing !== o) return;
    if (m.t === 'accept') onAccepted(o, m);
    else if (m.t === 'reject') {
      if (m.reason === 'callback' && member) {
        if (m.msg) addChat(member.id, { ...m.msg, from: 'them' });
        endOutgoing(o, `${name}：「${CALLBACK_TEXT}」`);
      } else endOutgoing(o, `${name} は今は出られません`);
    } else if (m.t === 'busy') {
      if (m.glare) { clearTimeout(o.timer); S.outgoing = null; return; } // 相手からの着信として受ける
      endOutgoing(o, `${name} は通話中です`);
    } else if (m.t === 'bye' && reconnect) {
      clearTimeout(o.timer);
      S.outgoing = null;
      hangup(`${S.remoteName} との通話は終了しています`, false);
    }
  });
  c.on('close', () => { if (S.outgoing === o) endOutgoing(o, reconnect ? null : `${name} につながりませんでした`); });
}
function cancelCall() {
  const o = S.outgoing;
  if (!o) return;
  clearTimeout(o.timer);
  if (o.pending) { S.outgoing = null; hideCallOverlay(); stopTone(); releaseMedia(); return; }
  try { o.c.send({ t: 'cancel' }); } catch { /* 未接続 */ }
  setTimeout(() => o.c.close(), 500);
  endOutgoing(o, null);
}
// 同時呼び出しで自分の発信を取り下げる（カメラは着信に使うので手放さない）
function abandonOutgoing(o) {
  clearTimeout(o.timer);
  S.outgoing = null;
  if (o.c) { try { o.c.send({ t: 'cancel' }); } catch { /* 未接続 */ } setTimeout(() => o.c.close(), 500); }
  hideCallOverlay();
  stopTone();
}
function endOutgoing(o, msg) {
  if (S.outgoing !== o) return;
  clearTimeout(o.timer);
  S.outgoing = null;
  if (o.reconnect) { if (o.c) { try { o.c.close(); } catch { /* 既に閉じている */ } } scheduleReconnect(3000); return; }
  hideCallOverlay();
  stopTone();
  if (!S.inCall) releaseMedia();
  if (msg) lobbyMsg(msg);
}
function onPeerUnavailable(peerId) {
  const m = memberByPid(peerId);
  if (m) setPresence(m.id, 'offline');
  const o = S.outgoing;
  if (o && o.peerId === peerId && !o.pending) endOutgoing(o, o.reconnect ? null : `${o.name} を呼び出せません（相手のPCの電源・スリープ・ネット接続を確認してください）`);
}
function onAccepted(o, m) {
  clearTimeout(o.timer);
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
  const call = S.peer.call(o.peerId, S.localStream, { metadata: { token: S.token } });
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
  if (notifyPeer) send({ t: 'bye' });
  stopTr(false);
  const minutesInput = collectMinutesInput();
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
  // 通話中のデータを片付ける（図面はメモリから消す）
  for (const d of S.docs.values()) { try { d.pdf && d.pdf.destroy(); d.img && d.img.close && d.img.close(); } catch { /* 解放済み */ } }
  lowCache.clear();
  S.docs.clear(); S.strokes.clear(); S.strokeById.clear(); S.incoming.clear(); S.pointers.clear();
  S.myStack = []; S.content = { type: 'none' }; S.contentTs = 0; S.cur = null; S.partner = null; S.token = null;
  if (S.quality !== 'std') setQuality('std');
  progress(null); banner(null);
  closeChat();
  if (el.room.classList.contains('full')) setFullscreen(false);
  el.room.hidden = true;
  el.lobby.hidden = false;
  releaseMedia();
  lobbyMsg(msg || '通話を終了しました');
  probeAll(true);
  // 文字起こしかチャットがあれば、議事録を作る
  if (minutesInput.lines.length || minutesInput.chats.length) openMinutes(minutesInput);
}

function bindConn(c) {
  c.on('data', (m) => {
    if (S.conn !== c) return; // 古い接続から遅れて届いたデータは捨てる
    try { onMessage(m); } catch (e) { console.error(e); }
  });
  c.on('close', () => onConnClosed(c));
  c.on('error', () => onConnClosed(c));
}

function onConnClosed(c) {
  if (S.conn !== c || !S.inCall) return;
  S.conn = null;
  if (S.call) { try { S.call.close(); } catch { /* 既に閉じている */ } S.call = null; }
  setRemoteStream(null);
  S.pointers.delete('remote');
  if (S.role === 'host') {
    setStatus(`回線が切れました。相手からの再接続を待っています（${HOST_WAIT / 1000}秒で自動終了）`, 'bad');
    clearTimeout(S.hostWaitTimer);
    S.hostWaitTimer = setTimeout(() => hangup('相手との接続が戻らなかったため、通話を終了しました', false), HOST_WAIT);
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
    setRemoteStream(st);
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
        const nc = S.peer.call(S.partner, S.localStream, { metadata: { token: S.token } });
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
  if (S.content.type === 'live') attachStageVideo();
}

function send(m) {
  if (S.conn && S.conn.open) { try { S.conn.send(m); } catch (e) { console.warn(e); } }
}

// 大きなデータは順番を守り、送信バッファがあふれないように送る
let queue = Promise.resolve();
function sendQueued(fn) {
  queue = queue.then(fn).catch((e) => console.warn(e));
  return queue;
}
async function waitDrain() {
  for (;;) {
    const c = S.conn;
    if (!c || !c.open) return false;
    const dc = c.dataChannel;
    // 図面送信中もポインター等が遅れすぎないよう、ためる量は少なめにする
    if ((!dc || dc.bufferedAmount < 256 * 1024) && !(c.bufferSize > 0)) return true;
    await sleep(15);
  }
}

function sendHello() {
  send({ t: 'hello', name: S.name, docs: [...S.docs.keys()], contentTs: S.contentTs, role: S.role });
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
  if (!S.peer || !S.peer.open || S.inCall) return;
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
const appTitle = DEMO ? '図面テレビ電話（デモ）' : document.title;
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
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); } catch { /* 未対応 */ }
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
  $('#callName').textContent = name;
  $('#callAvatar').textContent = markOf(name);
  $('#callKanji').textContent = kind === 'incoming' ? '着信' : '発信';
  $('#callStatus').textContent = kind === 'incoming' ? 'から着信しています' : 'を呼び出しています…';
  for (const id of ['#answerBtn', '#callbackBtn', '#declineBtn']) $(id).hidden = kind !== 'incoming';
  $('#cancelBtn').hidden = kind === 'incoming';
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
function chatLog(id) {
  if (!chatCache.has(id)) chatCache.set(id, store.get('chat.' + id, []));
  return chatCache.get(id);
}
function saveChat(id) {
  const log = chatLog(id);
  if (log.length > CHAT_MAX) log.splice(0, log.length - CHAT_MAX);
  store.set('chat.' + id, log);
}
function addChat(id, entry) {
  if (!memberById(id)) return null;
  const log = chatLog(id);
  if (entry.id && log.some((x) => x.id === entry.id)) return null; // 同じメッセージの二重受信
  const e = { id: entry.id || rid(), ts: entry.ts || Date.now(), from: entry.from, text: String(entry.text || '').slice(0, 2000), st: entry.st };
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
function inCallWith(id) { return S.inCall && S.conn && S.conn.open && memberByPid(S.partner) && memberByPid(S.partner).id === id; }
function flushChatInCall() {
  const m = S.partner && memberByPid(S.partner);
  if (m) deliverChat(m.id);
}
const chatConns = new Map();
function deliverChat(id) {
  const pending = chatLog(id).filter((e) => e.from === 'me' && e.st === 'pending');
  if (!pending.length) return;
  if (DEMO) { demoChatReply(id, pending); return; }
  if (inCallWith(id)) { for (const e of pending) send({ t: 'chat', msg: { id: e.id, text: e.text, ts: e.ts } }); return; }
  if (!S.peer || !S.peer.open) return;
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
  if (!msg || !msg.id) return;
  const ack = { t: 'chat-ack', id: msg.id };
  if (conn) { try { conn.send(ack); } catch { /* 閉じている */ } } else send(ack);
  const e = addChat(id, { id: msg.id, ts: msg.ts, text: msg.text, from: 'them' });
  if (!e) return;
  if (chat.open === id && document.visibilityState === 'visible') return;
  startTone('chat');
  const name = memberById(id).name;
  notify(`${name} からメッセージ`, e.text.slice(0, 80));
  if (S.inCall) banner(`${name}：${e.text.slice(0, 60)}`, 6000);
}

// ---- チャット画面 ----
const chat = { open: null };
const QUICK = ['了解しました', '少し待ってください', 'あとで折り返します', 'OKです', 'NGです', '図面を確認します', '今から電話します'];
function openChat(id) {
  if (!memberById(id)) return;
  chat.open = id;
  S.unread[id] = 0;
  store.set('unread', S.unread);
  const panel = $('#chatPanel');
  // 通話中は上下のバー（終了ボタン・ツールバー）を隠さない
  panel.style.top = S.inCall ? $('.topbar').getBoundingClientRect().bottom + 'px' : '0';
  panel.style.bottom = S.inCall ? $('.toolbar').offsetHeight + 'px' : '0';
  panel.hidden = false;
  $('#chatTitle').textContent = memberById(id).name;
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
    meta.textContent = hhmm(e.ts) + (e.from === 'me' ? (e.st === 'pending' ? ' 未送信（相手の待受に戻ると自動で送ります）' : ' 送信済み') : '');
    row.append(bubble, meta);
    list.appendChild(row);
  }
  list.scrollTop = list.scrollHeight;
  const callBtn = $('#chatCallBtn');
  callBtn.hidden = S.inCall;
}
function updateChatBadges() {
  const b = $('#chatBtnBadge');
  if (!b) return;
  const m = S.partner && memberByPid(S.partner);
  const n = m ? S.unread[m.id] || 0 : 0;
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
  banner('文字起こしを開始しました。話した内容が文字になり、議事録に使われます', 5000);
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
    row.className = 'cap ' + who;
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
  return {
    start, end: Date.now(), me: S.name, partner: S.remoteName,
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
function onMessage(m) {
  switch (m.t) {
    case 'bye': hangup(`${S.remoteName} が通話を終了しました`, false); break;
    case 'chat': { const m2 = memberByPid(S.partner); if (m2) receiveChat(m2.id, m.msg, null); break; }
    case 'chat-ack': { const m2 = memberByPid(S.partner); if (m2) markSent(m2.id, m.id); break; }
    case 'hello': onHello(m); break;
    case 'state': onState(m); break;
    case 'fb': fileBegin(m); break;
    case 'fc': fileChunk(m); break;
    case 'fe': fileEnd(m); break;
    case 'content': setContent(m.c, { send: false, view: m.view, ts: m.ts }); break;
    case 'view':
      if (S.sync && S.cur && m.key === S.cur.key) { S.view = m.view; viewChanged(false); }
      break;
    case 'ptr':
      S.pointers.set('remote', pushPtr(S.pointers.get('remote'), m.key, m.u, m.v));
      break;
    case 'ptr-off': S.pointers.delete('remote'); break;
    case 'sb': addStroke(m.key, m.s); break;
    case 'sp': {
      const st = S.strokeById.get(m.id);
      if (st) { st.pts.push(...m.pts); if (S.cur && st.key === S.cur.key) drawInk(); }
      break;
    }
    case 'del': deleteStroke(m.id, false); break;
    case 'clear': clearStrokes(m.key, false); break;
    case 'snap-req': banner(`${S.remoteName} の依頼で撮影します`); takeSnapshot(); break;
    case 'msg': banner(m.text); break;
    case 'tr': addTrLine('them', S.remoteName, m.line); break;
    case 'tr-state':
      if (m.on && !S.tr.on) { startTr(false); banner(`${S.remoteName} が文字起こしを開始しました。話した内容が議事録に使われます`, 6000); }
      else if (!m.on && S.tr.on) { stopTr(false); banner(`${S.remoteName} が文字起こしを止めました`, 4000); }
      break;
    default: break;
  }
}

function onHello(m) {
  if (m.name) S.remoteName = m.name;
  el.remoteWipe.querySelector('.wipe-label').textContent = S.remoteName;
  const mine = S.content.type !== 'none';
  const newer = S.contentTs > (m.contentTs || 0) || (S.contentTs === m.contentTs && S.role === 'host');
  if (!mine || !newer) return;
  // 自分の表示内容の方が新しい → 相手に図面と書き込みを渡す
  const c = S.content;
  if (c.type === 'doc' && !m.docs.includes(c.docId)) sendDoc(S.docs.get(c.docId));
  const prefix = c.type === 'doc' ? c.docId + ':' : 'live:';
  const strokes = [...S.strokes.entries()].filter(([k]) => k.startsWith(prefix));
  sendQueued(() => send({ t: 'state', c, ts: S.contentTs, view: S.view, strokes }));
}

function onState(m) {
  for (const [key, list] of m.strokes || []) {
    clearStrokes(key, false);
    for (const s of list) addStroke(key, s, false);
  }
  setContent(m.c, { send: false, view: m.view, ts: m.ts });
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
    // ファイルを直接開いた場合は Worker が使えないので、同じスレッドで処理する
    pdfReady = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/pdf.worker.min.js';
      s.onload = () => res(lib);
      s.onerror = rej;
      document.head.appendChild(s);
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
  return doc;
}

async function openLocalFile(file) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf && !file.type.startsWith('image/')) { banner('PDF か画像ファイルを選んでください'); return; }
  const doc = { id: rid(), kind: isPdf ? 'pdf' : 'image', name: file.name, mime: file.type || (isPdf ? 'application/pdf' : 'image/jpeg'), blob: file };
  progress('図面を読み込み中…', 0.2);
  try { await prepareDoc(doc); }
  catch (e) { console.error(e); progress(null); banner('このファイルは開けませんでした'); return; }
  progress(null);
  sendDoc(doc);
  setContent({ type: 'doc', docId: doc.id, page: 1 });
}

function sendDoc(doc) {
  if (!doc) return;
  sendQueued(async () => {
    if (!S.conn || !S.conn.open) return;
    const buf = await doc.blob.arrayBuffer();
    const size = buf.byteLength;
    send({ t: 'fb', id: doc.id, kind: doc.kind, name: doc.name, mime: doc.mime, size });
    for (let off = 0; off < size; off += CHUNK) {
      if (!(await waitDrain())) { progress(null); return; }
      send({ t: 'fc', id: doc.id, d: buf.slice(off, Math.min(size, off + CHUNK)) });
      if ((off / CHUNK) % 32 === 0) progress(`相手に送信中 ${doc.name}`, off / size);
    }
    send({ t: 'fe', id: doc.id });
    progress(null);
  });
}

function fileBegin(m) {
  S.incoming.set(m.id, { meta: m, parts: [], got: 0 });
  progress(`受信中 ${m.name}`, 0);
}
function fileChunk(m) {
  const f = S.incoming.get(m.id);
  if (!f) return;
  const d = m.d instanceof ArrayBuffer ? m.d : m.d.buffer ? m.d.buffer.slice(m.d.byteOffset, m.d.byteOffset + m.d.byteLength) : m.d;
  f.parts.push(d);
  f.got += d.byteLength;
  if (f.parts.length % 32 === 0) progress(`受信中 ${f.meta.name}`, f.got / f.meta.size);
}
async function fileEnd(m) {
  const f = S.incoming.get(m.id);
  if (!f) return;
  S.incoming.delete(m.id);
  progress(null);
  const doc = { id: m.id, kind: f.meta.kind, name: f.meta.name, mime: f.meta.mime, blob: new Blob(f.parts, { type: f.meta.mime }) };
  try { await prepareDoc(doc); } catch (e) { console.error(e); banner('受け取った図面を開けませんでした'); return; }
  if (S.content.type === 'doc' && S.content.docId === doc.id) prepareContent();
}

// ===================================================================
// 表示内容（図面のページ / カメラ映像）
// ===================================================================
function keyOf(c) {
  if (c.type === 'doc') return `${c.docId}:${c.page}`;
  if (c.type === 'live') return `live:${c.who}`;
  return null;
}

function setContent(c, { send: doSend = true, view = null, ts = null } = {}) {
  S.content = c;
  S.contentTs = ts || Date.now();
  S.view = view ? { ...view } : { cx: 0.5, cy: 0.5, zoom: 1 };
  if (doSend) send({ t: 'content', c, ts: S.contentTs, view: S.view });
  // 自分のカメラが大きく映されたら自動で高画質に、外れたら元に戻す
  if (c.type === 'live' && c.who === S.role && S.quality === 'std') setQuality('hi', { auto: true });
  else if (!(c.type === 'live' && c.who === S.role) && S.autoBoosted) setQuality('std');
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
  if (!doc) { S.cur = null; redrawAll(); progress('図面を受信中…', 0); return; }
  if (doc.kind === 'image') {
    S.cur = { key, kind: 'image', W: doc.img.width, H: doc.img.height, img: doc.img, doc };
    return redrawAll();
  }
  const page = await doc.pdf.getPage(clamp(c.page, 1, doc.pages));
  if (seq !== prepSeq) return;
  const vp = page.getViewport({ scale: 1 });
  const cur = { key, kind: 'pdf', W: vp.width, H: vp.height, page, doc, low: null };
  S.cur = cur;
  redrawAll();
  cur.low = await renderLow(page);
  if (S.cur === cur) drawBase();
}

// ズーム中の仮表示用に、ページ全体を中くらいの解像度で1枚描いておく
const lowCache = new Map();
async function renderLow(page) {
  const k = page;
  if (lowCache.has(k)) return lowCache.get(k);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = 2400 / Math.max(vp1.width, vp1.height);
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g, viewport: vp }).promise;
  lowCache.set(k, c);
  if (lowCache.size > 6) lowCache.delete(lowCache.keys().next().value);
  return c;
}

function attachStageVideo() {
  const c = S.content;
  if (c.type !== 'live') return;
  const src = c.who === S.role ? S.localStream : S.remoteStream;
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
      const color = who === 'me' ? '255,40,40' : '255,40,40';
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
      if (who === 'remote') {
        g.font = '12px sans-serif';
        const label = S.remoteName;
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
  el.remoteWipe.hidden = !S.remoteStream || el.remoteWipe.dataset.closed === '1' || live === remoteWho;
  el.selfWipe.hidden = el.selfWipe.dataset.closed === '1' || live === S.role;
  el.selfWipe.classList.toggle('mirror', S.mirror);
}

// ===================================================================
// 高画質スナップショット
// ===================================================================
async function takeSnapshot() {
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
  el.statsText.textContent = parts.join(' ／ ');
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
  const doc = c.type === 'doc' ? S.docs.get(c.docId) : null;
  const isPdf = doc && doc.kind === 'pdf';
  el.pageText.textContent = isPdf ? `${c.page} / ${doc.pages}` : doc ? '1 / 1' : c.type === 'live' ? 'カメラ' : '-';
  $('#prevBtn').disabled = !isPdf || c.page <= 1;
  $('#nextBtn').disabled = !isPdf || c.page >= doc.pages;
  $('#liveRemoteBtn').classList.toggle('on', c.type === 'live' && c.who !== S.role);
  $('#liveSelfBtn').classList.toggle('on', c.type === 'live' && c.who === S.role);
}
// 全画面：上下のバーを隠し、映像（図面）だけを画面いっぱいに表示する
function setFullscreen(on) {
  if (on && S.content.type === 'none') showLive(S.role === 'host' ? 'guest' : 'host'); // 何も映していなければ相手のカメラ
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
  const doc = S.docs.get(c.docId);
  if (!doc) return;
  const page = clamp(c.page + d, 1, doc.pages);
  if (page !== c.page) setContent({ ...c, page });
}
function showLive(who) {
  const c = S.content;
  if (c.type === 'live' && c.who === who) return;
  setContent({ type: 'live', who });
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
  el.fileInput.addEventListener('change', () => { const f = el.fileInput.files[0]; el.fileInput.value = ''; if (f) openLocalFile(f); });
  $('#prevBtn').addEventListener('click', () => gotoPage(-1));
  $('#nextBtn').addEventListener('click', () => gotoPage(1));
  $('#zoomInBtn').addEventListener('click', () => zoomAt(SW / 2, SH / 2, 1.4));
  $('#zoomOutBtn').addEventListener('click', () => zoomAt(SW / 2, SH / 2, 1 / 1.4));
  $('#fitBtn').addEventListener('click', () => { S.view = { cx: 0.5, cy: 0.5, zoom: 1 }; viewChanged(); });
  $('#syncBtn').addEventListener('click', (e) => { S.sync = !S.sync; e.currentTarget.classList.toggle('on', S.sync); if (S.sync) viewChanged(); });
  $('#undoBtn').addEventListener('click', undo);
  $('#clearBtn').addEventListener('click', async () => { if (S.cur && await askConfirm('このページの書き込みを全部消します（相手の画面からも消えます）。', '全部消す')) clearStrokes(S.cur.key); });
  $('#liveRemoteBtn').addEventListener('click', () => showLive(S.role === 'host' ? 'guest' : 'host'));
  $('#liveSelfBtn').addEventListener('click', () => showLive(S.role));
  $('#snapSelfBtn').addEventListener('click', takeSnapshot);
  $('#snapRemoteBtn').addEventListener('click', () => {
    if (DEMO) { takeSnapshot(); return; }
    if (!S.conn || !S.conn.open) { banner('相手とつながっていません'); return; }
    send({ t: 'snap-req' });
    banner('相手のカメラで撮影しています…');
  });
  $('#fullBtn').addEventListener('click', () => setFullscreen(!el.room.classList.contains('full')));
  $('#fullExitBtn').addEventListener('click', () => setFullscreen(false));
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && el.room.classList.contains('full')) setFullscreen(false); });
  $('#wipeBtn').addEventListener('click', () => {
    delete el.remoteWipe.dataset.closed; delete el.selfWipe.dataset.closed;
    for (const w of [el.remoteWipe, el.selfWipe]) { w.style.left = w.style.top = w.style.right = w.style.bottom = w.style.width = ''; }
    updateWipes();
  });
  $('#saveBtn').addEventListener('click', saveImage);
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
  $('#leaveBtn').addEventListener('click', async () => { if (await askConfirm('通話を終了しますか？', '終了する')) hangup(); });

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
// 待受画面（相手の一覧）
// ===================================================================
function setMeStatus(text, kind) {
  $('#meStatus').textContent = text;
  $('#meDot').className = 'dot' + (kind ? ' ' + kind : '');
}

function renderContacts() {
  const ul = $('#contactList');
  if (!ul) return;
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

function setupLobby() {
  $('#changeMeBtn').addEventListener('click', () => { if (!S.inCall) showSetup(); });
  el.lobbyCam.addEventListener('change', async (e) => { await switchCamera(e.target.value); });
  el.lobbyMic.addEventListener('change', async (e) => { await switchMic(e.target.value); });
  $('#answerBtn').addEventListener('click', () => { unlockSound(); answer(); });
  $('#callbackBtn').addEventListener('click', () => decline('callback'));
  $('#declineBtn').addEventListener('click', () => decline('reject'));
  $('#cancelBtn').addEventListener('click', cancelCall);
  $('#previewBtn').addEventListener('click', () => { if (S.localStream) releaseMedia(); else ensureMedia(); });
  // 着信の知らせ方
  $('#alertBtn').addEventListener('click', openAlertSettings);
  $('#alertTestBtn').addEventListener('click', testAlert);
  $('#alertDlg').addEventListener('change', readAlertSettings);
  $('#alertDlg').addEventListener('close', () => { readAlertSettings(); stopAlertTest(); });
  // チャット
  $('#chatCloseBtn').addEventListener('click', closeChat);
  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!chat.open) return;
    sendChat(chat.open, $('#chatInput').value);
    $('#chatInput').value = '';
  });
  const q = $('#chatQuick');
  for (const t of QUICK) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost quick';
    b.textContent = t;
    b.addEventListener('click', () => { if (chat.open) sendChat(chat.open, t); });
    q.appendChild(b);
  }
  $('#chatCallBtn').addEventListener('click', () => { const m = memberById(chat.open); if (m) placeCall(m); });
  $('#chatBtn').addEventListener('click', () => {
    const m = S.partner && memberByPid(S.partner);
    if (!m) return;
    if (chat.open) closeChat(); else openChat(m.id);
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
  audioCtx(); // 起動オプションで自動再生が許可されていれば、この時点で着信音が使える
  setInterval(updateBellHint, 1000);
  if (!navigator.mediaDevices || !window.RTCPeerConnection) {
    lobbyMsg('このブラウザでは使えません。Chrome または Edge で開いてください');
    return;
  }
  if (DEMO) {
    document.body.classList.add('demo');
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
