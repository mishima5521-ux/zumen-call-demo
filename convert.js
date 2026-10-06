// 図面テレビ電話：PDF・画像以外のファイル（Word・Excel・PowerPoint・CAD など）を開けるようにする
//   この端末の中だけで「PDF（ページごとの画像）」か「画像」に変換してから、いつもの図面と同じように開く。
//   相手には変換後の PDF・画像を送るので、相手の版が古くても、相手の PC に Office や CAD がなくても見られる。
//   変換に使う部品は vendor フォルダにあり、そのファイルを初めて開くときだけ読み込む（起動は遅くならない）。
(() => {
'use strict';

const ext = (name) => (/\.([^./\\]+)$/.exec(name || '') || [])[1]?.toLowerCase() || '';
const E = (list) => new Set(list.split(' '));
const T = {
  pdf: E('pdf'),
  image: E('jpg jpeg jpe jfif png gif webp bmp dib ico avif heic heif'),
  docx: E('docx docm dotx dotm'),
  sheet: E('xlsx xlsm xltx xltm xlsb xls ods fods csv tsv'),
  pptx: E('pptx pptm ppsx ppsm potx potm'),
  text: E('txt text log md ini cfg conf json xml yaml yml nc ncd tap eia gcode ngc mpf spf min'),
  tiff: E('tif tiff'),
  svg: E('svg'),
  dxf: E('dxf'),
  stl: E('stl'),
};
// 開けない形式は、どうすれば見られるかを案内する
const NG = [
  [E('doc dot rtf'), '古い Word 形式（.doc）は開けません。Word で開いて「名前を付けて保存」で .docx か PDF にしてから開いてください'],
  [E('ppt pps pot'), '古い PowerPoint 形式（.ppt）は開けません。PowerPoint で開いて「名前を付けて保存」で .pptx か PDF にしてから開いてください'],
  [E('odt odp odg'), 'この形式は開けません。PDF に書き出してから開いてください'],
  [E('dwg dwf dwfx'), 'DWG は直接開けません。CAD で「DXF」か「PDF」に保存（印刷）してから開いてください'],
  [E('jww jwc jws'), 'Jw_cad のファイルは直接開けません。Jw_cad で「ファイル → DXF 形式で保存」するか、PDF に印刷してから開いてください'],
  [E('step stp igs iges x_t x_b sat sldprt sldasm slddrw ipt iam idw catpart catproduct prt asm 3dm obj 3mf'), '3D CAD のファイルは直接開けません。CAD で「STL」か「PDF」に保存してから開いてください（STL なら立体の絵で表示します）'],
  [E('zip lzh 7z rar'), '圧縮ファイルは開けません。展開（解凍）してから、中のファイルを開いてください'],
  [E('mp4 mov avi wmv mkv webm mp3 wav m4a'), '動画・音声は開けません。カメラの映像で見せるか、写真を撮って開いてください'],
  [E('msg eml'), 'メールのファイルは開けません。添付ファイルを保存してから開いてください'],
];

// ファイル選択の画面で選べるようにする拡張子
const ACCEPT = ['application/pdf', 'image/*', ...Object.values(T).flatMap((s) => [...s].map((e) => '.' + e))].join(',');

function classify(file) {
  const e = ext(file.name), t = file.type || '';
  if (T.pdf.has(e) || t === 'application/pdf') return { how: 'pdf' };
  if (T.tiff.has(e) || t === 'image/tiff') return { how: 'convert', kind: 'tiff' };
  if (T.svg.has(e) || t === 'image/svg+xml') return { how: 'convert', kind: 'svg' };
  if (T.image.has(e) || (t.startsWith('image/') && !e)) return { how: 'image' };
  for (const k of ['docx', 'sheet', 'pptx', 'text', 'dxf', 'stl']) if (T[k].has(e)) return { how: 'convert', kind: k };
  for (const [set, msg] of NG) if (set.has(e)) return { how: 'no', msg };
  if (t.startsWith('image/')) return { how: 'image' };
  if (t.startsWith('text/')) return { how: 'convert', kind: 'text' };
  return { how: 'no', msg: `この種類のファイル（${e ? '.' + e : '拡張子なし'}）は開けません。PDF に保存してから開いてください` };
}
const fail = (msg) => Object.assign(new Error(msg), { userMsg: msg });

// ---- 部品の読み込み（ファイルを直接開いた場合も使えるよう、script タグで読む） ----
const BASE = (() => {
  const s = document.currentScript && document.currentScript.src;
  return s ? s.replace(/[^/]*$/, '') + 'vendor/' : 'vendor/';
})();
const loaded = new Map();
function lib(file, global) {
  if (window[global]) return Promise.resolve(window[global]);
  if (!loaded.has(file)) {
    loaded.set(file, new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = BASE + file;
      s.onload = () => (window[global] ? res(window[global]) : rej(new Error('lib ' + file)));
      s.onerror = () => { loaded.delete(file); rej(fail('変換用の部品を読み込めませんでした（vendor フォルダを確認してください）')); };
      document.head.appendChild(s);
    }));
  }
  return loaded.get(file);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 画面を止めないよう少し休む（requestAnimationFrame は裏のタブでは止まるので使わない）
const tick = () => new Promise((r) => setTimeout(r, 0));

// 文字コードを判定して文字列にする（UTF-8 でなければ Shift_JIS とみなす）
function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^﻿/, ''); }
  catch { return new TextDecoder('shift_jis').decode(u8); }
}

// ===================================================================
// PDF を作る（ページごとに 1 枚の画像を貼る。文字は画像になるので、どの PC でも同じに見える）
// ===================================================================
//   gray：白黒（灰色）だけのページ（表・テキスト）は灰色だけで保存して、軽くする
async function encodePage(canvas, lossless, gray) {
  const w = canvas.width, h = canvas.height;
  if (lossless && typeof CompressionStream === 'function') {
    const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    let raw;
    if (gray) {
      raw = new Uint8Array(w * h);
      for (let i = 0, j = 0; i < px.length; i += 4, j++) raw[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
    } else {
      raw = new Uint8Array(w * h * 3);
      for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { raw[j] = px[i]; raw[j + 1] = px[i + 1]; raw[j + 2] = px[i + 2]; }
    }
    const data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    return { w, h, data, filter: 'FlateDecode', cs: gray ? 'DeviceGray' : 'DeviceRGB' };
  }
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  return { w, h, data: new Uint8Array(await blob.arrayBuffer()), filter: 'DCTDecode' };
}
// pages: [{ w, h（画素）, data, filter, pt（1 画素あたりのポイント） }]
function makePdf(pages) {
  const enc = new TextEncoder();
  const parts = [], offs = [];
  let pos = 0;
  const put = (x) => { const u = typeof x === 'string' ? enc.encode(x) : x; parts.push(u); pos += u.length; };
  const obj = (n, dict, stream) => {
    offs[n] = pos;
    put(`${n} 0 obj\n${dict}\n`);
    if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); }
    put('endobj\n');
  };
  put('%PDF-1.4\n');
  put(new Uint8Array([37, 226, 227, 207, 211, 10]));
  const n = pages.length;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] >>`);
  pages.forEach((p, i) => {
    const o = 3 + i * 3;
    const W = +(p.w * p.pt).toFixed(2), H = +(p.h * p.pt).toFixed(2);
    obj(o, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${o + 1} 0 R >> >> /Contents ${o + 2} 0 R >>`);
    obj(o + 1, `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /${p.cs || 'DeviceRGB'} /BitsPerComponent 8 /Filter /${p.filter} /Length ${p.data.length} >>`, p.data);
    const cs = enc.encode(`q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`);
    obj(o + 2, `<< /Length ${cs.length} >>`, cs);
  });
  const xref = pos, size = 3 + n * 3;
  let x = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  put(x + `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
const canvasBlob = (c, type = 'image/png') => new Promise((r) => c.toBlob(r, type, 0.92));

// ページ（canvas）を集めて PDF にする。1 枚だけなら画像のままにする
class Pages {
  constructor(lossless, maxPages = 300, gray = false) { this.list = []; this.lossless = lossless; this.max = maxPages; this.gray = gray; this.cut = false; }
  get full() { return this.list.length >= this.max; }
  async add(canvas, pt) {
    if (this.full) { this.cut = true; return; }
    const p = await encodePage(canvas, this.lossless, this.gray);
    p.pt = pt;
    p.canvas = this.list.length ? null : canvas; // 1 枚だけのときは画像で渡すので残しておく
    this.list.push(p);
    if (this.list.length === 2) this.list[0].canvas = null;
  }
  async result() {
    if (!this.list.length) throw fail('表示できる内容がありませんでした');
    if (this.list.length === 1 && this.list[0].canvas) {
      return { kind: 'image', mime: 'image/png', blob: await canvasBlob(this.list[0].canvas), cut: this.cut };
    }
    return { kind: 'pdf', mime: 'application/pdf', blob: makePdf(this.list), pages: this.list.length, cut: this.cut };
  }
}

// ===================================================================
// HTML で描いてから画像にする（Word・Excel・PowerPoint・テキスト）
// ===================================================================
//   画面の外に見えない枠（iframe）を作り、アプリの見た目（デザイン）に影響されないところで描く
function sandbox(width) {
  const f = document.createElement('iframe');
  f.setAttribute('aria-hidden', 'true');
  f.tabIndex = -1;
  f.style.cssText = `position:fixed;left:${-width - 200}px;top:0;width:${width}px;height:1200px;border:0;pointer-events:none;`;
  document.body.appendChild(f);
  const d = f.contentDocument;
  d.open();
  d.write('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff;color:#000;font-family:"Yu Gothic UI","Yu Gothic","Meiryo","Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;}</style></head><body></body></html>');
  d.close();
  return f;
}
function fitFrame(f) {
  const d = f.contentDocument;
  f.style.height = Math.max(400, d.documentElement.scrollHeight, d.body.scrollHeight) + 'px';
}
async function settle(root) {
  const imgs = [...root.querySelectorAll('img')];
  await Promise.all(imgs.map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; setTimeout(r, 5000); }))));
  try { await root.ownerDocument.fonts.ready; } catch { /* なくてもよい */ }
  await tick();
}
async function snap(el, opt) {
  const h2c = await lib('html2canvas.min.js', 'html2canvas');
  return h2c(el, { backgroundColor: '#ffffff', logging: false, useCORS: true, imageTimeout: 8000, ...opt });
}
const MAX_PX = 2600; // 1 ページの画像の横幅（これ以上は重くなるだけ）
const scaleFor = (w, max = MAX_PX) => Math.max(0.5, Math.min(2.5, max / Math.max(1, w)));

// 要素を「ページの高さ」ごとに区切って画像にする。区切りは段落や行の切れ目を選ぶ（文字の途中で切らない）。
//   html2canvas は呼ぶたびに中身を丸ごと写し取るので、何ページ分かをまとめて 1 回で描き、あとで切り分ける
async function capturePaged(el, pages, { pageH, padTop = 0, padBottom = 0, breaks = [], scale, pt, onPage }) {
  const W = el.offsetWidth, H = el.offsetHeight;
  if (H <= pageH * 1.03) {
    await pages.add(await snap(el, { scale }), pt / scale);
    onPage && onPage();
    return;
  }
  const top0 = el.getBoundingClientRect().top;
  const ends = [...new Set(breaks.map((n) => Math.round(n.getBoundingClientRect().bottom - top0)))].filter((b) => b > 0 && b < H).sort((a, b) => a - b);
  const wins = [];
  let start = 0;
  while (start < H - padBottom - 1) {
    const first = !wins.length;
    const avail = first ? pageH - padBottom : pageH - padTop - padBottom;
    let end = start + avail;
    if (end + padBottom >= H) end = H;
    else {
      let best = 0;
      for (const b of ends) { if (b > end) break; if (b > start + avail * 0.5) best = b; }
      if (best) end = best;
    }
    wins.push({ y: start, h: end - start, at: first ? 0 : padTop });
    start = end;
  }
  const BAND = Math.max(pageH, Math.floor(12000 / scale));
  for (let i = 0; i < wins.length && !pages.full;) {
    let j = i + 1;
    while (j < wins.length && wins[j].y + wins[j].h - wins[i].y <= BAND) j++;
    const y0 = wins[i].y, bandH = wins[j - 1].y + wins[j - 1].h - y0;
    const band = await snap(el, { scale, y: y0, height: bandH, width: W });
    for (let q = i; q < j && !pages.full; q++) {
      const w = wins[q];
      const page = document.createElement('canvas');
      page.width = Math.round(W * scale);
      page.height = Math.round(pageH * scale);
      const g = page.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, page.width, page.height);
      const sy = Math.round((w.y - y0) * scale), sh = Math.min(band.height - sy, Math.round(w.h * scale));
      if (sh > 0) g.drawImage(band, 0, sy, band.width, sh, 0, Math.round(w.at * scale), band.width, sh);
      await pages.add(page, pt / scale);
      onPage && onPage();
    }
    band.width = band.height = 0;
    i = j;
  }
}

// ---- Word（.docx） ----
async function convertDocx(file, prog) {
  await lib('jszip.min.js', 'JSZip');
  const docx = await lib('docx-preview.min.js', 'docx');
  const f = sandbox(1000);
  try {
    const d = f.contentDocument;
    const box = d.createElement('div');
    d.body.appendChild(box);
    prog('Word の文書を読み込み中…', 0.1);
    await docx.renderAsync(await file.arrayBuffer(), box, d.head, {
      className: 'docx', inWrapper: true, ignoreWidth: false, ignoreHeight: false, ignoreFonts: false,
      breakPages: true, ignoreLastRenderedPageBreak: false, experimental: true, useBase64URL: true,
      renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
    });
    const st = d.createElement('style');
    st.textContent = '.docx-wrapper{background:#fff!important;padding:0!important;display:block!important}.docx-wrapper>section.docx{box-shadow:none!important;margin:0 0 40px 0!important}';
    d.head.appendChild(st);
    fitFrame(f);
    await settle(box);
    fitFrame(f);
    const secs = [...box.querySelectorAll('section.docx')];
    if (!secs.length) throw fail('Word の文書を表示できませんでした');
    const pages = new Pages(true);
    let i = 0;
    for (const s of secs) {
      const W = s.offsetWidth;
      const cs = getComputedStyle(s);
      const pageH = parseFloat(s.style.minHeight) || parseFloat(cs.minHeight) || W * 1.414;
      const scale = scaleFor(W, 2000);
      await capturePaged(s, pages, {
        pageH, padTop: parseFloat(cs.paddingTop) || 0, padBottom: parseFloat(cs.paddingBottom) || 0,
        breaks: [...s.querySelectorAll('p, li, tr, img, h1, h2, h3, h4, h5, h6, header, footer, table')], scale, pt: 0.75,
        onPage: () => prog(`Word の文書を変換中…（${pages.list.length} ページ）`, Math.min(0.95, ++i / Math.max(secs.length, i + 1))),
      });
      if (pages.full) break;
    }
    return pages.result();
  } finally { f.remove(); }
}

// ---- Excel（.xlsx .xls .ods .csv） ----
//   表は canvas に直接描く（行が多くても速い）。列の記号（A, B, C…）と行番号を付け、どのページにも列の記号を出す。
//   横に長い表は、印刷と同じように列の途中でページを分ける（下へ → 右へ の順）
const MAX_ROWS = 5000, MAX_COLS = 150;
const UI_FONT = '"Yu Gothic UI","Yu Gothic","Meiryo","Hiragino Sans","Noto Sans JP",sans-serif';
async function convertSheet(file, prog, kind) {
  const XLSX = await lib('xlsx.full.min.js', 'XLSX');
  prog('表を読み込み中…', 0.1);
  const buf = await file.arrayBuffer();
  const e = ext(file.name);
  const wb = kind === 'csv'
    ? XLSX.read(decodeText(buf), { type: 'string', raw: true, FS: e === 'tsv' ? '\t' : undefined })
    : XLSX.read(buf, { type: 'array' });
  const names = wb.SheetNames.filter((n) => { const ws = wb.Sheets[n]; return ws && ws['!ref'] && !(wb.Workbook?.Sheets?.find((s) => s.name === n)?.Hidden); });
  const U = XLSX.utils;
  const FONT = '13px ' + UI_FONT;
  const mc = document.createElement('canvas').getContext('2d');
  mc.font = FONT;
  const pages = new Pages(true, 300, true);
  let cut = false;
  for (let si = 0; si < names.length && !pages.full; si++) {
    const name = names[si];
    const ws = wb.Sheets[name];
    const r = U.decode_range(ws['!ref']);
    if (r.e.r - r.s.r + 1 > MAX_ROWS) { r.e.r = r.s.r + MAX_ROWS - 1; cut = true; }
    if (r.e.c - r.s.c + 1 > MAX_COLS) { r.e.c = r.s.c + MAX_COLS - 1; cut = true; }
    const rinfo = ws['!rows'] || [], cinfo = ws['!cols'] || [];
    const rows = [], cols = [];
    for (let R = r.s.r; R <= r.e.r; R++) if (!rinfo[R]?.hidden) rows.push(R);
    for (let C = r.s.c; C <= r.e.c; C++) if (!cinfo[C]?.hidden) cols.push(C);
    // 結合されたセル
    const span = new Map(), covered = new Set();
    for (const m of ws['!merges'] || []) {
      if (m.s.r > r.e.r || m.s.c > r.e.c) continue;
      span.set(m.s.r + ',' + m.s.c, m);
      for (let R = m.s.r; R <= Math.min(m.e.r, r.e.r); R++) for (let C = m.s.c; C <= Math.min(m.e.c, r.e.c); C++) if (R !== m.s.r || C !== m.s.c) covered.add(R + ',' + C);
    }
    const ci = new Map(cols.map((C, i) => [C, i]));
    const width = cols.map((C) => Math.max(40, mc.measureText(U.encode_col(C)).width + 18));
    const cells = new Map(), lines = new Map();
    for (const R of rows) {
      let n = 1;
      for (const C of cols) {
        const k = R + ',' + C;
        const cell = ws[U.encode_cell({ r: R, c: C })];
        if (!cell || covered.has(k)) continue;
        let t;
        try { t = U.format_cell(cell); } catch { t = cell.v == null ? '' : String(cell.v); }
        if (t == null || t === '') continue;
        const ls = String(t).split(/\r?\n/).slice(0, 8);
        cells.set(k, { ls, num: cell.t === 'n' });
        if (!span.has(k)) {
          n = Math.max(n, ls.length);
          const w = Math.max(...ls.map((s) => mc.measureText(s).width)) + 16;
          width[ci.get(C)] = Math.max(width[ci.get(C)], Math.min(420, w));
        }
      }
      lines.set(R, n);
    }
    if (!cells.size) continue;
    const LH = 18, PADY = 5, HEAD = 24, CAP = 34, M = 28;
    const RN = Math.max(40, mc.measureText(String(rows[rows.length - 1] + 1)).width + 18);
    const rowH = (R) => lines.get(R) * LH + PADY;
    // 列をページの幅に収まるように分ける
    const MAXW = 1600;
    const groups = [];
    let g0 = [], gw = 0;
    cols.forEach((C, i) => {
      if (g0.length && gw + width[i] > MAXW - RN - M * 2) { groups.push(g0); g0 = []; gw = 0; }
      g0.push(i); gw += width[i];
    });
    if (g0.length) groups.push(g0);
    const pageW = Math.max(1123, ...groups.map((g) => RN + M * 2 + g.reduce((a, i) => a + width[i], 0)));
    const pageH = Math.round(pageW * 0.707);
    const showCap = names.length > 1 || kind !== 'csv';
    // 行をページの高さで分ける
    const chunks = [];
    let c0 = 0, h = 0, avail = pageH - M * 2 - HEAD - (showCap ? CAP : 0);
    rows.forEach((R, i) => {
      const rh = Math.min(rowH(R), pageH - M * 2 - HEAD - CAP);
      if (i > c0 && h + rh > avail) { chunks.push([c0, i]); c0 = i; h = 0; avail = pageH - M * 2 - HEAD; }
      h += rh;
    });
    chunks.push([c0, rows.length]);
    const scale = Math.min(1.8, 2400 / pageW);
    const total = chunks.length * groups.length;
    let pn = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      for (let ki = 0; ki < chunks.length; ki++) {
        if (pages.full) break;
        pn++;
        const grp = groups[gi], [a, b] = chunks[ki];
        const cv = document.createElement('canvas');
        cv.width = Math.round(pageW * scale);
        cv.height = Math.round(pageH * scale);
        const g = cv.getContext('2d');
        g.scale(scale, scale);
        g.fillStyle = '#fff';
        g.fillRect(0, 0, pageW, pageH);
        let y = M;
        g.textBaseline = 'alphabetic';
        if (showCap && ki === 0 && gi === 0) {
          g.font = 'bold 17px ' + UI_FONT;
          g.fillStyle = '#1d3d5c';
          g.fillText(`シート：${name}`, M, y + 18);
          y += CAP;
        }
        if (total > 1) {
          g.font = '12px ' + UI_FONT;
          g.fillStyle = '#7a8594';
          g.textAlign = 'right';
          g.fillText(`${showCap ? name + '　' : ''}${pn} / ${total}`, pageW - M, M - 10);
          g.textAlign = 'left';
        }
        g.font = FONT;
        const xs = [M + RN];
        for (const i of grp) xs.push(xs[xs.length - 1] + width[i]);
        const colX = new Map(grp.map((i, j) => [cols[i], xs[j]]));
        const right = xs[xs.length - 1];
        // 見出し（列の記号）
        g.fillStyle = '#eef1f5';
        g.fillRect(M, y, right - M, HEAD);
        g.fillStyle = '#5a6472';
        g.textAlign = 'center';
        grp.forEach((i, j) => g.fillText(U.encode_col(cols[i]), xs[j] + width[i] / 2, y + 17));
        g.textAlign = 'left';
        g.strokeStyle = '#c3cad3';
        g.lineWidth = 1;
        g.strokeRect(M + 0.5, y + 0.5, right - M, HEAD);
        y += HEAD;
        const rowY = new Map();
        for (let i = a; i < b; i++) { rowY.set(rows[i], y); y += Math.min(rowH(rows[i]), pageH - M * 2 - HEAD - CAP); }
        const bottom = y;
        // 行番号
        g.fillStyle = '#eef1f5';
        g.fillRect(M, rowY.get(rows[a]), RN, bottom - rowY.get(rows[a]));
        g.fillStyle = '#5a6472';
        g.textAlign = 'center';
        for (let i = a; i < b; i++) g.fillText(String(rows[i] + 1), M + RN / 2, rowY.get(rows[i]) + 14);
        g.textAlign = 'left';
        // セル（枠と文字）
        const endY = (R) => rowY.get(R) + Math.min(rowH(R), pageH - M * 2 - HEAD - CAP);
        g.beginPath();
        for (let i = a; i < b; i++) {
          const R = rows[i], y0 = rowY.get(R), y1 = endY(R);
          g.rect(M + 0.5, y0 + 0.5, RN, y1 - y0);
          for (const ix of grp) {
            const C = cols[ix], k = R + ',' + C;
            if (covered.has(k)) continue;
            const m = span.get(k);
            let x1 = colX.get(C) + width[ix], yy = y1;
            if (m) {
              for (const j of grp) if (cols[j] > C && cols[j] <= m.e.c) x1 = Math.max(x1, colX.get(cols[j]) + width[j]);
              for (let q = i + 1; q < b; q++) if (rows[q] <= m.e.r) yy = endY(rows[q]);
            }
            g.rect(colX.get(C) + 0.5, y0 + 0.5, x1 - colX.get(C), yy - y0);
          }
        }
        g.stroke();
        g.fillStyle = '#111';
        for (let i = a; i < b; i++) {
          const R = rows[i], y0 = rowY.get(R);
          for (const ix of grp) {
            const C = cols[ix], cell = cells.get(R + ',' + C);
            if (!cell) continue;
            const m = span.get(R + ',' + C);
            let x1 = colX.get(C) + width[ix], yy = endY(R);
            if (m) {
              for (const j of grp) if (cols[j] > C && cols[j] <= m.e.c) x1 = Math.max(x1, colX.get(cols[j]) + width[j]);
              for (let q = i + 1; q < b; q++) if (rows[q] <= m.e.r) yy = endY(rows[q]);
            }
            const x0 = colX.get(C);
            g.save();
            g.beginPath();
            g.rect(x0 + 1, y0 + 1, x1 - x0 - 2, yy - y0 - 2);
            g.clip();
            cell.ls.forEach((s, li) => {
              const tw = cell.num || m ? g.measureText(s).width : 0;
              const tx = cell.num ? x1 - 7 - tw : m && x1 - x0 > tw + 14 && !cell.num ? x0 + (x1 - x0 - tw) / 2 : x0 + 7;
              g.fillText(s, tx, y0 + 14 + li * LH);
            });
            g.restore();
          }
        }
        await pages.add(cv, 0.75 / scale);
        prog(`表を変換中…（${pages.list.length} ページ）`, Math.min(0.95, (si + pn / total) / names.length));
        if (pages.list.length % 5 === 0) await tick();
      }
    }
  }
  if (!pages.list.length) throw fail('表に中身がありませんでした');
  const out = await pages.result();
  out.cut = out.cut || cut;
  return out;
}

// ---- PowerPoint（.pptx） ----
async function convertPptx(file, prog) {
  await lib('jszip.min.js', 'JSZip');
  const pp = await lib('pptx-preview.umd.js', 'pptxPreview');
  const W = 1600;
  const f = sandbox(W + 40);
  try {
    const d = f.contentDocument;
    const box = d.createElement('div');
    d.body.appendChild(box);
    prog('PowerPoint を読み込み中…', 0.1);
    const view = pp.init(box, { width: W, height: Math.round(W * 9 / 16), mode: 'list' });
    await view.preview(await file.arrayBuffer());
    fitFrame(f);
    await settle(box);
    await sleep(300);
    fitFrame(f);
    const slides = [...box.querySelectorAll('.pptx-preview-slide-wrapper')];
    if (!slides.length) throw fail('PowerPoint のスライドを表示できませんでした');
    const pages = new Pages(false);
    for (let i = 0; i < slides.length && !pages.full; i++) {
      prog(`スライドを変換中…（${i + 1} / ${slides.length}）`, (i + 1) / (slides.length + 1));
      const s = slides[i];
      s.style.margin = '0';
      const c = await snap(s, { scale: 1.25 });
      await pages.add(c, 0.6 / 1.25);
    }
    if (pages.list.length === 1) pages.list[0].canvas = null; // 1 枚でも PDF にする（スライドとして扱う）
    return pages.result();
  } finally { try { f.remove(); } catch { /* 済み */ } }
}

// ---- テキスト・NC プログラムなど ----
//   A4 の紙に打ち出したように描く。左に行番号を付ける（「120 行目」と話せるように）
const MAX_TEXT = 3 * 1024 * 1024, MAX_LINES = 30000;
async function convertText(file, prog) {
  const buf = await file.slice(0, MAX_TEXT).arrayBuffer();
  const src = decodeText(buf).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  if (src.length > 1 && src[src.length - 1] === '') src.pop();
  const W = 794, H = 1123, MY = 56, MX = 56, FS = 14, LH = 21;
  const FONT = `${FS}px "BIZ UDGothic","MS Gothic","Osaka-Mono","Noto Sans Mono CJK JP",monospace`;
  const mc = document.createElement('canvas').getContext('2d');
  mc.font = FONT;
  const gut = mc.measureText(String(Math.min(src.length, MAX_LINES))).width + 16;
  const maxW = W - MX * 2 - gut;
  const cw = new Map();
  const wOf = (ch) => { let w = cw.get(ch); if (w == null) { w = mc.measureText(ch).width; cw.set(ch, w); } return w; };
  // 折り返した見た目の行 [行番号（続きは 0）, 文字]
  const vis = [];
  for (let i = 0; i < src.length && vis.length < MAX_LINES; i++) {
    const s = src[i];
    let start = 0, w = 0, first = true;
    for (let j = 0; j < s.length; j++) {
      const cwid = wOf(s[j]);
      if (w + cwid > maxW && j > start) { vis.push([first ? i + 1 : 0, s.slice(start, j)]); first = false; start = j; w = 0; }
      w += cwid;
    }
    vis.push([first ? i + 1 : 0, s.slice(start)]);
  }
  const TITLE = 34;
  const pages = new Pages(true, 300, true);
  const scale = 2;
  let k = 0, pn = 0;
  while (k < vis.length && !pages.full) {
    const cv = document.createElement('canvas');
    cv.width = W * scale;
    cv.height = H * scale;
    const g = cv.getContext('2d');
    g.scale(scale, scale);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
    let y = MY;
    if (pn === 0) {
      g.font = `bold 15px ${UI_FONT}`;
      g.fillStyle = '#1d3d5c';
      g.fillText(file.name, MX, y + 14);
      g.fillStyle = '#ccd3dc';
      g.fillRect(MX, y + 22, W - MX * 2, 1);
      y += TITLE;
    }
    g.font = FONT;
    while (k < vis.length && y + LH <= H - MY) {
      const [no, s] = vis[k++];
      if (no) { g.fillStyle = '#9aa3ae'; g.textAlign = 'right'; g.fillText(String(no), MX + gut - 12, y + FS); g.textAlign = 'left'; }
      g.fillStyle = '#111';
      g.fillText(s, MX + gut, y + FS);
      y += LH;
    }
    pn++;
    g.font = `11px ${UI_FONT}`;
    g.fillStyle = '#9aa3ae';
    g.textAlign = 'center';
    g.fillText(`${pn}`, W / 2, H - 24);
    await pages.add(cv, 0.75 / scale);
    prog(`テキストを変換中…（${pn} ページ）`, Math.min(0.95, k / vis.length));
    if (pn % 5 === 0) await tick();
  }
  if (pages.list.length === 1) pages.list[0].canvas = null; // 1 ページでも紙（PDF）として扱う
  const out = await pages.result();
  out.cut = out.cut || vis.length >= MAX_LINES || file.size > MAX_TEXT;
  return out;
}

// ===================================================================
// 画像系（TIFF・SVG）
// ===================================================================
async function convertTiff(file, prog) {
  const UTIF = await lib('utif.js', 'UTIF');
  const buf = await file.arrayBuffer();
  const ifds = UTIF.decode(buf).filter((i) => i.t256 && i.t257);
  if (!ifds.length) throw fail('TIFF 画像を読み込めませんでした');
  const pages = new Pages(true, 100);
  for (let i = 0; i < ifds.length && !pages.full; i++) {
    prog(`TIFF を変換中…（${i + 1} / ${ifds.length}）`, (i + 1) / (ifds.length + 1));
    const ifd = ifds[i];
    UTIF.decodeImage(buf, ifd);
    const w = ifd.width, h = ifd.height;
    if (!w || !h) continue;
    const rgba = UTIF.toRGBA8(ifd);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
    // FAX（普通画質）は縦と横の細かさが違うので、正しい縦横比に直す
    const rx = ifd.t282?.[0], ry = ifd.t283?.[0];
    let out = c;
    if (rx && ry && Math.abs(rx / ry - 1) > 0.2) {
      out = document.createElement('canvas');
      out.width = w;
      out.height = Math.round(h * rx / ry);
      const g = out.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(c, 0, 0, out.width, out.height);
    }
    await pages.add(out, 72 / (rx || 200));
  }
  return pages.result();
}

async function convertSvg(file) {
  const url = URL.createObjectURL(new Blob([await file.arrayBuffer()], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(fail('SVG 画像を読み込めませんでした')); img.src = url; });
    let w = img.naturalWidth || 800, h = img.naturalHeight || 600;
    const k = Math.min(8, 2400 / Math.max(w, h));
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);
    return { kind: 'image', mime: 'image/png', blob: await canvasBlob(c) };
  } finally { URL.revokeObjectURL(url); }
}

// ===================================================================
// CAD：DXF（2D 図面）
// ===================================================================
//   線・円・円弧・ポリライン・楕円・スプライン・文字・ブロック（寸法を含む）を描く。
//   白い線（色番号 7）は白い紙では見えないので黒にする。
const ACI = [0x000000, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0];
function cadColor(rgb) {
  if (rgb == null) return '#000';
  const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum > 0.82) return '#000'; // 白・薄い色 → 黒
  if (lum > 0.55) { const k = 0.55 / lum; return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`; } // 黄色など薄い色は少し濃く
  return `rgb(${r},${g},${b})`;
}
const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const ap = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const ID = [1, 0, 0, 1, 0, 0];

function cadText(s) {
  return String(s || '')
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%%[cC]/g, 'φ').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%%/g, '%').replace(/%%[uUoO]/g, '');
}
function mtextPlain(s) {
  return cadText(s)
    .replace(/\\P/g, '\n').replace(/\\~/g, ' ')
    .replace(/\\S([^;]*?)[#^/]([^;]*?);/g, '$1/$2')
    .replace(/\\[ACcFfHhQTtWwp][^;]*;/g, '').replace(/\\[LlOoKkN]/g, '')
    .replace(/\\([\\{}])/g, '$1').replace(/[{}]/g, '');
}

function bspline(cp, deg, knots, weights, n) {
  const k = knots && knots.length === cp.length + deg + 1 ? knots : (() => {
    const t = []; const m = cp.length;
    for (let i = 0; i <= m + deg; i++) t.push(i <= deg ? 0 : i >= m ? m - deg : i - deg);
    return t;
  })();
  const lo = k[deg], hi = k[cp.length];
  const out = [];
  for (let s = 0; s <= n; s++) {
    const t = s === n ? hi - 1e-9 * (hi - lo) : lo + (hi - lo) * s / n;
    let span = deg;
    while (span < cp.length - 1 && t >= k[span + 1]) span++;
    const d = [];
    for (let j = 0; j <= deg; j++) { const p = cp[span - deg + j]; const w = weights ? weights[span - deg + j] || 1 : 1; d.push([p.x * w, p.y * w, w]); }
    for (let r = 1; r <= deg; r++) {
      for (let j = deg; j >= r; j--) {
        const i = span - deg + j;
        const den = k[i + deg - r + 1] - k[i];
        const a = den ? (t - k[i]) / den : 0;
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
      }
    }
    out.push([d[deg][0] / d[deg][2], d[deg][1] / d[deg][2]]);
  }
  return out;
}
// 通る点（fit points）だけのスプラインは、なめらかな曲線（Catmull-Rom）で近似する
function fitCurve(pts) {
  if (pts.length < 3) return pts.map((p) => [p.x, p.y]);
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < 12; s++) {
      const t = s / 12, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y)]);
    }
  }
  const l = pts[pts.length - 1];
  out.push([l.x, l.y]);
  return out;
}
function arcPts(cx, cy, r, a0, a1, rx = r, rot = 0) {
  while (a1 <= a0) a1 += Math.PI * 2;
  const n = Math.max(8, Math.min(256, Math.ceil((a1 - a0) / (Math.PI * 2) * 128)));
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * i / n;
    const x = rx * Math.cos(a), y = r * Math.sin(a);
    out.push([cx + x * cr - y * sr, cy + x * sr + y * cr]);
  }
  return out;
}
function bulgePts(p, q, b) {
  if (!b) return [[q.x, q.y]];
  const th = 4 * Math.atan(b);
  const dx = q.x - p.x, dy = q.y - p.y, c = Math.hypot(dx, dy);
  if (!c) return [[q.x, q.y]];
  const r = c / (2 * Math.sin(th / 2));
  const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
  const h = r * Math.cos(th / 2);
  const cx = mx - h * dy / c, cy = my + h * dx / c;
  const a0 = Math.atan2(p.y - cy, p.x - cx);
  const n = Math.max(4, Math.ceil(Math.abs(th) / (Math.PI * 2) * 96));
  const out = [];
  for (let i = 1; i <= n; i++) { const a = a0 + th * i / n; out.push([cx + Math.abs(r) * Math.cos(a), cy + Math.abs(r) * Math.sin(a)]); }
  return out;
}

function dxfShapes(dxf) {
  const layers = dxf.tables?.layer?.layers || {};
  const blocks = dxf.blocks || {};
  const lines = [], texts = [], fills = [];
  const hidden = (e) => { const L = layers[e.layer]; return e.visible === false || (L && (L.visible === false || L.frozen)); };
  const colorOf = (e, inherit) => {
    if (e.colorIndex === 0) return inherit; // BYBLOCK
    if (e.color != null && e.colorIndex !== 256) return e.color;
    const L = layers[e.layer];
    if (L && L.color != null) return L.color;
    return inherit;
  };
  const ocs = (e) => { const z = e.extrusionDirection ? e.extrusionDirection.z : e.extrusionDirectionZ; return z != null && z < 0 ? [-1, 0, 0, 1, 0, 0] : ID; };
  let count = 0;
  const walk = (ents, m, inherit, depth) => {
    for (const e of ents || []) {
      if (++count > 400000) return;
      if (hidden(e)) continue;
      const col = colorOf(e, inherit);
      const M = mul(m, ocs(e));
      const line = (pts, closed) => { if (pts.length > 1) lines.push({ pts: pts.map(([x, y]) => ap(M, x, y)), closed, col }); };
      switch (e.type) {
        case 'LINE': line(e.vertices.map((v) => [v.x, v.y])); break;
        case 'LWPOLYLINE': case 'POLYLINE': {
          const v = (e.vertices || []).filter((p) => p && Number.isFinite(p.x));
          if (v.length < 2) break;
          const pts = [[v[0].x, v[0].y]];
          const n = e.shape || e.closed ? v.length : v.length - 1;
          for (let i = 0; i < n; i++) pts.push(...bulgePts(v[i], v[(i + 1) % v.length], v[i].bulge));
          line(pts, false);
          break;
        }
        case 'CIRCLE': line(arcPts(e.center.x, e.center.y, e.radius, 0, Math.PI * 2), true); break;
        case 'ARC': line(arcPts(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle)); break;
        case 'ELLIPSE': {
          const mx = e.majorAxisEndPoint.x, my = e.majorAxisEndPoint.y, R = Math.hypot(mx, my);
          let a0 = e.startAngle ?? 0, a1 = e.endAngle ?? Math.PI * 2;
          if (Math.abs(a1 - a0 - Math.PI * 2) < 1e-6) a1 = a0 + Math.PI * 2;
          line(arcPts(e.center.x, e.center.y, R * e.axisRatio, a0, a1, R, Math.atan2(my, mx)));
          break;
        }
        case 'SPLINE': {
          const cp = e.controlPoints || [];
          const pts = cp.length > (e.degreeOfSplineCurve || 3) ? bspline(cp, e.degreeOfSplineCurve || 3, e.knotValues, e.weights, Math.min(400, cp.length * 16)) : fitCurve(e.fitPoints || cp);
          line(pts);
          break;
        }
        case 'SOLID': case '3DFACE': {
          const p = (e.points || e.vertices || []).filter(Boolean);
          if (p.length >= 3) {
            const q = e.type === 'SOLID' && p.length === 4 ? [p[0], p[1], p[3], p[2]] : p;
            fills.push({ pts: q.map((v) => ap(M, v.x, v.y)), col });
          }
          break;
        }
        case 'POINT': break; // 点は描かない（作図の補助点が多い）
        case 'TEXT': case 'ATTDEF': {
          if (e.type === 'ATTDEF') break;
          const al = (e.halign || e.valign) && e.endPoint ? e.endPoint : e.startPoint;
          if (!al) break;
          const h = e.textHeight || 2.5;
          const ha = [0, 0.5, 1, 0.5, 0.5, 0][e.halign || 0] ?? 0;
          const va = [0, 0, 0.5, 1][e.valign || 0] ?? 0;
          texts.push({ m: M, x: al.x, y: al.y, h, rot: (e.rotation || 0) * Math.PI / 180, lines: [cadText(e.text)], ha, va, col });
          break;
        }
        case 'MTEXT': {
          if (!e.position) break;
          const h = e.height || 2.5;
          const ap1 = (e.attachmentPoint || 1) - 1;
          let rot = (e.rotation || 0) * Math.PI / 180;
          if (e.directionVector) rot = Math.atan2(e.directionVector.y, e.directionVector.x);
          texts.push({ m: M, x: e.position.x, y: e.position.y, h, rot, lines: mtextPlain(e.text).split('\n'), ha: (ap1 % 3) / 2, va: [1, 0.5, 0][Math.floor(ap1 / 3)], mtext: true, col });
          break;
        }
        case 'INSERT': case 'DIMENSION': {
          const name = e.type === 'INSERT' ? e.name : e.block;
          const b = blocks[name];
          if (!b || depth > 12) break;
          const base = b.position || { x: 0, y: 0 };
          const p = e.type === 'INSERT' ? e.position || { x: 0, y: 0 } : { x: 0, y: 0 };
          const sx = e.xScale ?? 1, sy = e.yScale ?? 1;
          const r = (e.rotation || 0) * Math.PI / 180;
          const cr = Math.cos(r), sr = Math.sin(r);
          const nc = e.columnCount || 1, nr = e.rowCount || 1;
          for (let ci = 0; ci < Math.min(nc, 100); ci++) {
            for (let ri = 0; ri < Math.min(nr, 100); ri++) {
              const ox = ci * (e.columnSpacing || 0), oy = ri * (e.rowSpacing || 0);
              const T1 = [cr * sx, sr * sx, -sr * sy, cr * sy, p.x + cr * ox - sr * oy, p.y + sr * ox + cr * oy];
              walk(b.entities, mul(M, mul(T1, [1, 0, 0, 1, -base.x, -base.y])), col, depth + 1);
            }
          }
          break;
        }
        default: break;
      }
    }
  };
  let ents = (dxf.entities || []).filter((e) => !e.inPaperSpace);
  if (!ents.length) ents = dxf.entities || [];
  walk(ents, ID, 0xffffff, 0);
  return { lines, texts, fills };
}

async function convertDxf(file, prog) {
  const DxfParser = await lib('dxf-parser.js', 'DxfParser');
  prog('CAD 図面を読み込み中…', 0.2);
  const text = decodeText(await file.arrayBuffer());
  if (/^AutoCAD Binary DXF/.test(text)) throw fail('バイナリ形式の DXF は開けません。CAD で「テキスト（ASCII）形式の DXF」か PDF に保存してください');
  await tick();
  let dxf;
  try { dxf = new DxfParser().parseSync(text); } catch (e) { console.warn('dxf', e); throw fail('DXF ファイルを読み込めませんでした'); }
  prog('CAD 図面を描画中…', 0.5);
  await tick();
  const { lines, texts, fills } = dxfShapes(dxf);
  if (!lines.length && !texts.length && !fills.length) throw fail('DXF ファイルに表示できる図形がありませんでした');
  // 図形の範囲（極端に離れた点は除いて、図面の本体が大きく写るようにする）
  const xs = [], ys = [];
  const addP = ([x, y]) => { if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); } };
  for (const l of lines) for (const p of l.pts) addP(p);
  for (const f of fills) for (const p of f.pts) addP(p);
  for (const t of texts) addP(ap(t.m, t.x, t.y));
  const sorted = (a) => Float64Array.from(a).sort();
  const sx = sorted(xs), sy = sorted(ys);
  const q = (a, f) => a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * f)))];
  let x0 = sx[0], x1 = sx[sx.length - 1], y0 = sy[0], y1 = sy[sy.length - 1];
  const core = [q(sx, 0.002), q(sx, 0.998), q(sy, 0.002), q(sy, 0.998)];
  const cw = core[1] - core[0] || 1, ch = core[3] - core[2] || 1;
  if (x1 - x0 > cw * 20 || y1 - y0 > ch * 20) { x0 = core[0] - cw * 0.05; x1 = core[1] + cw * 0.05; y0 = core[2] - ch * 0.05; y1 = core[3] + ch * 0.05; }
  const bw = Math.max(x1 - x0, 1e-6), bh = Math.max(y1 - y0, 1e-6);
  const LONG = 5000, MARGIN = 80;
  const k = (LONG - MARGIN * 2) / Math.max(bw, bh);
  const W = Math.max(400, Math.round(bw * k + MARGIN * 2)), H = Math.max(400, Math.round(bh * k + MARGIN * 2));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  const X = (x) => (x - x0) * k + (W - bw * k) / 2, Y = (y) => H - ((y - y0) * k + (H - bh * k) / 2);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.lineWidth = 3.2;
  for (const f of fills) {
    g.fillStyle = cadColor(f.col);
    g.beginPath();
    f.pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
    g.closePath();
    g.fill();
  }
  let n = 0;
  for (const l of lines) {
    g.strokeStyle = cadColor(l.col);
    g.beginPath();
    l.pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
    if (l.closed) g.closePath();
    g.stroke();
    if (++n % 20000 === 0) await tick();
  }
  g.textBaseline = 'alphabetic';
  for (const t of texts) {
    const [px, py] = ap(t.m, t.x, t.y);
    const scl = Math.hypot(t.m[0], t.m[1]) || 1;
    const fs = t.h * scl * k;
    if (fs < 1.5) continue;
    const flip = t.m[0] * t.m[3] - t.m[1] * t.m[2] < 0;
    const rot = t.rot + Math.atan2(t.m[1], t.m[0]);
    g.save();
    g.translate(X(px), Y(py));
    g.rotate(-rot);
    if (flip) g.scale(-1, 1);
    g.fillStyle = cadColor(t.col);
    g.font = `${fs}px "MS Gothic","Yu Gothic","Meiryo","Noto Sans JP",sans-serif`;
    const lh = fs * (t.mtext ? 1.6 : 1);
    const widths = t.lines.map((s) => g.measureText(s).width);
    const total = lh * (t.lines.length - 1) + fs;
    const top = t.mtext ? -total * (1 - t.va) : 0;
    t.lines.forEach((s, i) => g.fillText(s, -widths[i] * t.ha, t.mtext ? top + fs + i * lh : fs * t.va));
    g.restore();
  }
  prog('CAD 図面を仕上げ中…', 0.9);
  return { kind: 'image', mime: 'image/png', blob: await canvasBlob(c) };
}

// ===================================================================
// CAD：STL（3D の形を、斜めから見た立体の絵にする）
// ===================================================================
async function convertStl(file, prog) {
  const buf = await file.arrayBuffer();
  const dv = new DataView(buf);
  let tris;
  const nBin = buf.byteLength >= 84 ? dv.getUint32(80, true) : -1;
  if (nBin >= 0 && 84 + nBin * 50 === buf.byteLength) {
    const n = Math.min(nBin, 2000000);
    tris = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) for (let j = 0; j < 9; j++) tris[i * 9 + j] = dv.getFloat32(84 + i * 50 + 12 + j * 4, true);
  } else {
    const txt = new TextDecoder().decode(buf);
    const v = [];
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    let m;
    while ((m = re.exec(txt)) && v.length < 18000000) v.push(+m[1], +m[2], +m[3]);
    tris = Float32Array.from(v.slice(0, v.length - (v.length % 9)));
  }
  const n = tris.length / 9;
  if (!n) throw fail('STL ファイルに形のデータがありませんでした');
  prog('3D の形を描画中…', 0.4);
  await tick();
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], tris[i + a]); mx[a] = Math.max(mx[a], tris[i + a]); }
  const cen = [0, 1, 2].map((a) => (mn[a] + mx[a]) / 2);
  // 右手前・斜め上から見る（等角図）
  const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const fwd = norm([-1, 1, -0.82]);
  const right = norm(cross(fwd, [0, 0, 1]));
  const up = cross(right, fwd);
  const light = norm([0.35, -0.6, 0.75]);
  const P = new Float32Array(n * 6), shade = new Float32Array(n);
  let sx0 = Infinity, sx1 = -Infinity, sy0 = Infinity, sy1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    const pts = [];
    for (let j = 0; j < 3; j++) {
      const p = [tris[o + j * 3] - cen[0], tris[o + j * 3 + 1] - cen[1], tris[o + j * 3 + 2] - cen[2]];
      pts.push(p);
      const x = dot(p, right), y = dot(p, up);
      P[i * 6 + j * 2] = x;
      P[i * 6 + j * 2 + 1] = y;
      if (x < sx0) sx0 = x; if (x > sx1) sx1 = x; if (y < sy0) sy0 = y; if (y > sy1) sy1 = y;
    }
    const nn = norm(cross(pts[1].map((v, a) => v - pts[0][a]), pts[2].map((v, a) => v - pts[0][a])));
    shade[i] = 0.28 + 0.72 * Math.abs(dot(nn, light));
  }
  // 1 画素ずつ奥行きを比べて塗る（手前の面だけが見える。大きな三角形でも重なりが崩れない）
  const W = 2400, H = 1800, M = 140;
  const k = Math.min((W - M * 2) / Math.max(sx1 - sx0, 1e-6), (H - M * 2 - 60) / Math.max(sy1 - sy0, 1e-6));
  const ox = W / 2 - (sx0 + sx1) / 2 * k, oy = (H - 60) / 2 + (sy0 + sy1) / 2 * k;
  const zb = new Float32Array(W * H).fill(Infinity);
  const sb = new Float32Array(W * H).fill(-1);
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const x0 = ox + P[o] * k, y0 = oy - P[o + 1] * k, x1 = ox + P[o + 2] * k, y1 = oy - P[o + 3] * k, x2 = ox + P[o + 4] * k, y2 = oy - P[o + 5] * k;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (!area) continue;
    const t = i * 9;
    const dz = (j) => (tris[t + j * 3] - cen[0]) * fwd[0] + (tris[t + j * 3 + 1] - cen[1]) * fwd[1] + (tris[t + j * 3 + 2] - cen[2]) * fwd[2];
    const z0 = dz(0), z1 = dz(1), z2 = dz(2);
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * z0 + w1 * z1 + w2 * z2;
        const q = y * W + x;
        if (z < zb[q]) { zb[q] = z; sb[q] = shade[i]; }
      }
    }
    if (i % 100000 === 99999) await tick();
  }
  // 輪郭（奥行きが急に変わるところ）と折れ目（面の明るさが変わるところ）に線を引く
  const span = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
  const img = new ImageData(W, H);
  const px = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const q = y * W + x, s = sb[q];
      let r = 255, g2 = 255, b2 = 255;
      if (s >= 0) { r = 70 + 150 * s; g2 = 90 + 140 * s; b2 = 115 + 130 * s; }
      let edge = false;
      for (const d of [1, W]) {
        const q2 = q + d;
        if ((d === 1 && x === W - 1) || q2 >= W * H) continue;
        const s2 = sb[q2];
        if ((s < 0) !== (s2 < 0)) edge = true;
        else if (s >= 0 && (Math.abs(zb[q] - zb[q2]) > span * 0.01 || Math.abs(s - s2) > 0.06)) edge = true;
      }
      if (edge) { r = 40; g2 = 48; b2 = 60; }
      const o = q * 4;
      px[o] = r; px[o + 1] = g2; px[o + 2] = b2; px[o + 3] = 255;
    }
  }
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.putImageData(img, 0, 0);
  const f1 = (v) => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2)).replace(/\.?0+$/, '');
  g.fillStyle = '#334';
  g.font = '40px "Yu Gothic","Meiryo","Noto Sans JP",sans-serif';
  g.textAlign = 'center';
  g.fillText(`外形 X ${f1(mx[0] - mn[0])} × Y ${f1(mx[1] - mn[1])} × Z ${f1(mx[2] - mn[2])}（STL の単位）　三角形 ${n.toLocaleString()} 枚`, W / 2, H - 50);
  return { kind: 'image', mime: 'image/png', blob: await canvasBlob(c) };
}

// ===================================================================
// 入口
// ===================================================================
const LABEL = { docx: 'Word', sheet: '表', pptx: 'PowerPoint', text: 'テキスト', tiff: 'TIFF', svg: 'SVG', dxf: 'CAD 図面', stl: '3D の形' };
async function convert(file, onProgress) {
  const c = classify(file);
  if (c.how !== 'convert') throw fail(c.msg || 'このファイルは変換しなくても開けます');
  const prog = (t, f) => { try { onProgress && onProgress(t, f); } catch { /* 表示だけ */ } };
  prog(`${LABEL[c.kind]}を変換中…`, 0.05);
  try {
    switch (c.kind) {
      case 'docx': return await convertDocx(file, prog);
      case 'sheet': return await convertSheet(file, prog, ext(file.name) === 'csv' || ext(file.name) === 'tsv' ? 'csv' : 'book');
      case 'pptx': return await convertPptx(file, prog);
      case 'text': return await convertText(file, prog);
      case 'tiff': return await convertTiff(file, prog);
      case 'svg': return await convertSvg(file, prog);
      case 'dxf': return await convertDxf(file, prog);
      case 'stl': return await convertStl(file, prog);
    }
  } catch (e) {
    if (e && e.userMsg) throw e;
    console.warn('convert', file.name, e);
    throw fail(`${LABEL[c.kind]}のファイルを表示できませんでした。元のソフトで PDF に保存してから開いてください`);
  }
  throw fail('このファイルは開けません');
}

window.ZumenConvert = { classify, convert, accept: ACCEPT, makePdf };
})();
