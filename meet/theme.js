/* 画面のデザイン（設定で選ぶ）と、案42「狙撃」の効果（照準・ガラスの弾痕・重低音）
 * - デザインはこのPC（ブラウザ）ごとに保存する。招待リンクから開いた社外の方の画面は、招待した側のデザインで表示する
 * - 狙撃の効果音は、ボタンを押した端末だけで鳴らす（相手には何も送らない）
 * - 画面が一瞬でも違うデザインで出ないように、<head> で読み込む
 */
(() => {
'use strict';

const THEMES = [
  { id: 'youto', name: '妖刀（墨と朱）', no: '案8', sw: ['#f4eedf', '#1a1714', '#c8322a'] },
  { id: 'neon', name: 'ネオン横丁', no: '案16', sw: ['#0a0718', '#ff2e88', '#00f0ff'],
    fonts: 'family=RocknRoll+One&family=M+PLUS+1p:wght@500;700;800' },
  { id: 'mirror', name: '鏡面仕上げ', no: '案19', sw: ['#050505', '#c9cdd3', '#d4af37'],
    fonts: 'family=Cinzel:wght@600;800&family=Zen+Old+Mincho:wght@500;700;900' },
  { id: 'comic', name: 'アメコミ', no: '案35', sw: ['#ffd400', '#e5202a', '#1c5dd8'],
    fonts: 'family=Bangers&family=M+PLUS+Rounded+1c:wght@500;700;800;900' },
  { id: 'varsity', name: 'カレッジ・バーシティ', no: '案41', sw: ['#f2e6c9', '#6b1428', '#c99b2e'],
    fonts: 'family=Graduate&family=Kaisei+Tokumin:wght@500;800&family=M+PLUS+1p:wght@500;700;800' },
  { id: 'sniper', name: '狙撃', no: '案42', sw: ['#0a0d0b', '#ff2a2a', '#7ce38b'],
    fonts: 'family=Black+Ops+One&family=Share+Tech+Mono&family=Zen+Kaku+Gothic+New:wght@500;700;900' },
];
const DEFAULT = 'youto';
const valid = (id) => THEMES.some((t) => t.id === id);
const KEY = 'zumen.theme', SOUND_KEY = 'zumen.fxSound';
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 保存できなくても表示は変えられる */ } };

// 招待リンク（…#j=部屋番号&n=…&t=デザイン&s=0）から開いたときは、招待した側のデザインにする
const hash = new URLSearchParams(location.hash.slice(1));
const fromLink = /^[a-z2-9]{20,40}$/.test(hash.get('j') || '');
let cur = DEFAULT, soundOn = true;

function loadFonts(t) {
  if (!t.fonts || document.getElementById('font-' + t.id)) return;
  const l = document.createElement('link');
  l.id = 'font-' + t.id;
  l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?' + t.fonts + '&display=swap';
  document.head.appendChild(l);
}
function set(id, { save = true } = {}) {
  if (!valid(id)) id = DEFAULT;
  loadFonts(THEMES.find((t) => t.id === id));
  document.documentElement.dataset.theme = id;
  cur = id;
  if (save) write(KEY, id);
}
function setSound(on, { save = true } = {}) {
  soundOn = !!on;
  if (save) write(SOUND_KEY, soundOn ? '1' : '0');
}

if (fromLink) {
  set(hash.get('t') || DEFAULT, { save: false });
  setSound(hash.get('s') !== '0', { save: false });
} else {
  set(read(KEY) || DEFAULT, { save: false });
  setSound(read(SOUND_KEY) !== '0', { save: false });
}

// ===================================================================
// 案42「狙撃」：照準が合い、ガラスが撃ち抜かれたような弾痕とひびが残る
// ===================================================================

// 弾痕のガラスのひび（SVG）。rnd: 0〜1 の乱数、R: ひびの最大半径(px)
function glassCrack(rnd, R) {
  const f = (v) => v.toFixed(1), pt = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
  const seg = (A, B) => `M${f(A[0])} ${f(A[1])} L${f(B[0])} ${f(B[1])}`;
  const line = (d, w, a) => `<path d="${d}" stroke="rgba(0,0,0,${(a * 0.28).toFixed(2)})" stroke-width="${f(w + 0.6)}" transform="translate(.35 .4)"></path><path d="${d}" stroke="rgba(255,255,255,${a.toFixed(2)})" stroke-width="${f(w)}"></path>`;
  const poly = (q) => 'M' + q.map((v) => f(v[0]) + ' ' + f(v[1])).join(' L');
  // 放射状のひび（中心から外へ、だんだん細く）
  const N = 15 + Math.floor(rnd() * 6), radials = [];
  for (let i = 0; i < N; i++) {
    const base = i * 2 * Math.PI / N + (rnd() - 0.5) * (2 * Math.PI / N) * 0.6;
    const L = R * (0.5 + rnd() * 0.5) * (rnd() < 0.22 ? 0.62 : 1);
    let r = 4 + rnd() * 1.5, a = base;
    const pts = [[r, a]];
    while (r < L) { r = Math.min(L, r + 4 + rnd() * 5); a = base + (a - base) * 0.6 + (rnd() - 0.5) * 0.09; pts.push([r, a]); }
    radials.push({ L, pts });
  }
  const at = (rad, rr) => {
    const p = rad.pts;
    if (rr > rad.L || rr < p[0][0]) return null;
    for (let k = 1; k < p.length; k++) if (p[k][0] >= rr) { const t = (rr - p[k - 1][0]) / (p[k][0] - p[k - 1][0] || 1); return pt(rr, p[k - 1][1] + (p[k][1] - p[k - 1][1]) * t); }
    return null;
  };
  // 同心円状のひび（放射状のひびの間をつなぐ）
  const ringR = [9, 15, 23, 33, 44].map((x) => x * R / 52), ringP = [0.97, 0.86, 0.7, 0.5, 0.3];
  const edges = ringR.map((rr, k) => radials.map((rad, i) => {
    const p1 = at(rad, rr), p2 = at(radials[(i + 1) % N], rr);
    return p1 && p2 && rnd() < ringP[k] ? [p1, p2] : null;
  }));
  let facets = '', rings = '', cracks = '', branches = '', micro = '';
  // 割れた破片ごとに光の当たり方を少し変える
  for (let k = 0; k < ringR.length - 1; k++) for (let i = 0; i < N; i++) {
    const e1 = edges[k][i], e2 = edges[k + 1][i];
    if (!e1 || !e2 || rnd() > 0.72) continue;
    const op = [0.05, 0.09, 0.14, 0.2][Math.floor(rnd() * 4)], fill = rnd() < 0.3 ? `rgba(0,0,0,${op})` : `rgba(255,255,255,${op})`;
    facets += `<path d="M${f(e1[0][0])} ${f(e1[0][1])} L${f(e2[0][0])} ${f(e2[0][1])} L${f(e2[1][0])} ${f(e2[1][1])} L${f(e1[1][0])} ${f(e1[1][1])} Z" fill="${fill}"></path>`;
  }
  edges.forEach((row, k) => row.forEach((e) => {
    if (!e) return;
    const bow = 1.04 + (rnd() - 0.5) * 0.14, m = [(e[0][0] + e[1][0]) / 2 * bow, (e[0][1] + e[1][1]) / 2 * bow];
    rings += line(`M${f(e[0][0])} ${f(e[0][1])} Q${f(m[0])} ${f(m[1])} ${f(e[1][0])} ${f(e[1][1])}`, 0.45 * (1 - ringR[k] / R) + 0.3, 0.72);
  }));
  radials.forEach((rad) => {
    const p = rad.pts;
    const xy = p.map((q) => pt(q[0], q[1])), n3 = Math.max(2, Math.ceil(xy.length / 3));
    [[0, n3, 1.1, 0.95], [n3 - 1, 2 * n3, 0.7, 0.9], [2 * n3 - 1, xy.length, 0.4, 0.8]].forEach(([a0, a1, w, al]) => { const part = xy.slice(a0, a1); if (part.length > 1) cracks += line(poly(part), w, al); });
    if (p.length > 3 && rnd() < 0.45) {
      const q = p[1 + Math.floor(rnd() * (p.length - 2))], A = pt(q[0], q[1]);
      const ba = q[1] + (rnd() < 0.5 ? -1 : 1) * (0.35 + rnd() * 0.35), bl = 6 + rnd() * 12;
      branches += line(seg(A, [A[0] + bl * Math.cos(ba), A[1] + bl * Math.sin(ba)]), 0.4, 0.75);
    }
  });
  // 穴のまわりの細かいひび
  for (let i = 0; i < 30; i++) {
    const a = rnd() * 2 * Math.PI, r1 = 3.8 + rnd() * 4.5, r2 = r1 + 1 + rnd() * 3, b = a + (rnd() - 0.5) * 0.4;
    micro += `<path d="${seg(pt(r1, a), pt(r2, b))}" stroke="rgba(255,255,255,0.55)" stroke-width="0.35"></path>`;
  }
  const hv = [];
  for (let i = 0; i < 11; i++) hv.push(pt(2.8 + rnd() * 1.5, i * 2 * Math.PI / 11 + (rnd() - 0.5) * 0.3));
  const glints = [0, 1, 2].map(() => { const g = pt(6 + rnd() * R * 0.6, rnd() * 2 * Math.PI); return `<circle cx="${f(g[0])}" cy="${f(g[1])}" r="${f(0.6 + rnd() * 0.8)}" fill="#FFFFFF"></circle>`; }).join('');
  const S = R + 8;
  return `<svg class="glass" width="${2 * S}" height="${2 * S}" viewBox="${-S} ${-S} ${2 * S} ${2 * S}" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
    + facets
    + `<circle r="${f(R * 0.25)}" fill="rgba(255,255,255,0.1)"></circle><circle r="${f(R * 0.18)}" fill="rgba(255,255,255,0.22)"></circle><circle r="${f(R * 0.12)}" fill="rgba(255,255,255,0.45)"></circle>`
    + rings + cracks + branches + micro
    + `<path d="M${hv.map((q) => f(q[0]) + ' ' + f(q[1])).join(' L')} Z" fill="#050505" stroke="rgba(255,255,255,0.7)" stroke-width="0.6"></path>`
    + glints + '</svg>';
}

// 低く長く響く「ズドーーーーーン」：短い破裂音＋重い衝撃＋長い地鳴りと残響（押した端末だけで鳴る）
let ac = null, ir = null;
function boom(delay) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = ac || (ac = new AC());
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t = ctx.currentTime + (delay || 0), sr = ctx.sampleRate;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 10; comp.attack.value = 0.003; comp.release.value = 0.6; comp.connect(ctx.destination);
    const master = ctx.createGain(); master.gain.value = 0.8; master.connect(comp);
    // 低音に倍音を足して、ノートPCの小さなスピーカーでも重く聞こえるようにする
    const shaper = ctx.createWaveShaper(), curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(2.6 * x) / Math.tanh(2.6); }
    shaper.curve = curve; shaper.connect(master);
    if (!ir) {
      const len = Math.floor(sr * 5.5);
      ir = ctx.createBuffer(2, len, sr);
      for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.8); }
    }
    const rev = ctx.createConvolver(), revLp = ctx.createBiquadFilter(), wet = ctx.createGain();
    rev.buffer = ir; revLp.type = 'lowpass'; revLp.frequency.value = 320; wet.gain.value = 0.85;
    rev.connect(revLp); revLp.connect(wet); wet.connect(master);
    const env = (g, peak, attack, decay) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + decay); };
    const noise = (sec, brown) => {
      const n = Math.floor(sr * sec), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
      let last = 0;
      for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w; }
      const s = ctx.createBufferSource(); s.buffer = b; return s;
    };
    // 「ズ」：一瞬の破裂音
    const z = noise(0.25, false), zf = ctx.createBiquadFilter(), zg = ctx.createGain();
    zf.type = 'bandpass'; zf.frequency.value = 1100; zf.Q.value = 0.6; env(zg, 0.5, 0.003, 0.16);
    z.connect(zf); zf.connect(zg); zg.connect(master); z.start(t); z.stop(t + 0.25);
    // 「ド」：腹に来る衝撃
    const d1 = ctx.createOscillator(), d1g = ctx.createGain();
    d1.type = 'sine'; d1.frequency.setValueAtTime(95, t); d1.frequency.exponentialRampToValueAtTime(36, t + 0.3);
    env(d1g, 1.0, 0.004, 0.8); d1.connect(d1g); d1g.connect(shaper); d1g.connect(rev); d1.start(t); d1.stop(t + 0.9);
    // 「ーーーーーン」：長く低いうなり
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(58, t); o.frequency.exponentialRampToValueAtTime(23, t + 4.5);
    env(og, 0.85, 0.03, 6.0); o.connect(og); og.connect(shaper); og.connect(rev); o.start(t); o.stop(t + 6.1);
    const h = ctx.createOscillator(), hg = ctx.createGain();
    h.type = 'triangle'; h.frequency.setValueAtTime(116, t); h.frequency.exponentialRampToValueAtTime(46, t + 2.5);
    env(hg, 0.22, 0.02, 3.2); h.connect(hg); hg.connect(master); h.start(t); h.stop(t + 3.3);
    // 地鳴り（低い雑音）
    const rb = noise(6.5, true), rf = ctx.createBiquadFilter(), rg = ctx.createGain();
    rf.type = 'lowpass'; rf.Q.value = 0.9; rf.frequency.setValueAtTime(160, t); rf.frequency.exponentialRampToValueAtTime(38, t + 5);
    env(rg, 0.9, 0.05, 6.4); rb.connect(rf); rf.connect(rg); rg.connect(shaper); rg.connect(rev); rb.start(t); rb.stop(t + 6.5);
  } catch { /* 音が出せない環境でも、ボタンの動作は続ける */ }
}

const reduced = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const f1 = (v) => v.toFixed(1);
// 飛び散るガラスの細かい破片（画面全体の上に重ねる。ダイアログの中なら、ダイアログの中に）
function chips(x, y, host) {
  if (reduced()) return;
  const fx = document.createElement('div');
  fx.className = 'fx-chips';
  fx.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 12; i++) {
    const s = document.createElement('span'), a = Math.random() * Math.PI * 2, d = 25 + Math.random() * 90, sz = 2 + Math.random() * 4.5;
    s.className = 'shard';
    s.style.left = f1(x) + 'px';
    s.style.top = f1(y) + 'px';
    s.style.setProperty('--dx', f1(Math.cos(a) * d) + 'px');
    s.style.setProperty('--dy', f1(Math.sin(a) * d + 110) + 'px');
    s.style.setProperty('--r', f1((Math.random() - 0.5) * 720) + 'deg');
    const p = () => f1(Math.random() * 2 - 1);
    s.innerHTML = `<svg width="${f1(sz * 2)}" height="${f1(sz * 2)}" viewBox="-1 -1 2 2"><path d="M${p()} ${p()} L${p()} ${p()} L${p()} ${p()} Z" fill="rgba(225,238,255,.75)" stroke="rgba(255,255,255,.95)" stroke-width=".12"></path></svg>`;
    fx.appendChild(s);
  }
  host.appendChild(fx);
  setTimeout(() => fx.remove(), 1600);
}
// ボタンを撃ち抜く。e はクリックの位置（キーボードで押したときはボタンの中央）
function shoot(btn, e) {
  const r = btn.getBoundingClientRect();
  let cx = e && e.clientX, cy = e && e.clientY;
  if (!(cx || cy) || cx < r.left - 2 || cx > r.right + 2 || cy < r.top - 2 || cy > r.bottom + 2) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
  const shot = document.createElement('span');
  shot.className = 'shot';
  shot.setAttribute('aria-hidden', 'true');
  shot.style.left = f1(cx - r.left) + 'px';
  shot.style.top = f1(cy - r.top) + 'px';
  shot.innerHTML = '<span class="ring"></span><span class="scope"></span><span class="flash"></span><span class="gw" style="transform: rotate(' + Math.floor(Math.random() * 360) + 'deg)">' + glassCrack(Math.random, 52) + '</span>';
  btn.appendChild(shot);
  const all = btn.querySelectorAll('.shot');
  if (all.length > 8) all[0].remove();
  if (soundOn) boom(reduced() ? 0 : 0.38);
  chips(cx, cy, btn.closest('dialog') || document.body);
  // 撃たれた札（カード）だけを軽く揺らす
  const box = btn.closest('.call-card, .guest-card, .lobby-card, dialog');
  if (box && !reduced()) setTimeout(() => { box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake'); }, 380);
}

window.ZumenTheme = {
  list: THEMES,
  DEFAULT,
  valid,
  fromLink,
  current: () => cur,
  sound: () => soundOn,
  set,
  setSound,
  // 狙撃のデザインのときだけ撃ち抜く。弾が当たってから（約0.7秒後）ボタンの処理をする
  snipes: () => cur === 'sniper',
  shotMs: () => (reduced() ? 150 : 700),
  shoot,
};
})();
