import * as pdfjsLib from './lib/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdf.worker.min.mjs';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const NS = 'http://www.w3.org/2000/svg';

/* ============ Estado ============ */
const S = {
  sources: [],      // {name, bytes, pdf}
  pages: [],        // {uid, src, idx, rot, nat, w, h, annots[]}  (src -1 = página em branco)
  tool: 'view',
  view: 'read',
  zoom: 1,
  color: '#e11d48',
  size: 16,
  sel: new Set(),
  undo: [], redo: [],
  dirty: false,
  fileName: 'documento.pdf',
  current: 0,
};
let uidSeq = 1;

/* ============ Utilidades ============ */
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms);
}
function busy(on, txt = 'Aguarde…') { $('#busy').hidden = !on; $('#busyTxt').textContent = txt; }
const hasDoc = () => S.pages.length > 0;
const dispSize = p => (p.rot % 180 ? [p.h, p.w] : [p.w, p.h]);

// base (pontos, y para baixo, já com a rotação nativa) -> tela
function b2d(p, x, y, scale) {
  const [dw, dh] = dispSize(p);
  const nx = x / p.w, ny = y / p.h;
  let u, v;
  switch (p.rot) {
    case 90: u = 1 - ny; v = nx; break;
    case 180: u = 1 - nx; v = 1 - ny; break;
    case 270: u = ny; v = 1 - nx; break;
    default: u = nx; v = ny;
  }
  return [u * dw * scale, v * dh * scale];
}
function d2b(p, px, py, scale) {
  const [dw, dh] = dispSize(p);
  const u = px / (dw * scale), v = py / (dh * scale);
  let nx, ny;
  switch (p.rot) {
    case 90: nx = v; ny = 1 - u; break;
    case 180: nx = 1 - u; ny = 1 - v; break;
    case 270: nx = 1 - v; ny = u; break;
    default: nx = u; ny = v;
  }
  return [nx * p.w, ny * p.h];
}

/* ============ Desfazer / Refazer ============ */
function snapshot() { return JSON.stringify(S.pages); }
function pushUndo() {
  S.undo.push(snapshot()); if (S.undo.length > 60) S.undo.shift();
  S.redo = []; S.dirty = true; syncButtons();
}
function doUndo() {
  if (!S.undo.length) return;
  S.redo.push(snapshot()); S.pages = JSON.parse(S.undo.pop()); S.dirty = true;
  afterRestore();
}
function doRedo() {
  if (!S.redo.length) return;
  S.undo.push(snapshot()); S.pages = JSON.parse(S.redo.pop()); S.dirty = true;
  afterRestore();
}
function afterRestore() {
  const ids = new Set(S.pages.map(p => p.uid));
  S.sel = new Set([...S.sel].filter(u => ids.has(u)));
  refresh(); syncButtons();
}
function syncButtons() {
  $('#btnUndo').disabled = !S.undo.length;
  $('#btnRedo').disabled = !S.redo.length;
  $('#btnSave').disabled = !hasDoc();
  updateGridInfo();
}

/* ============ Abrir arquivos ============ */
async function loadSource(file, bytes) {
  const copy = bytes.slice();
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: copy }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('Este PDF é protegido por senha. Remova a senha e tente de novo.');
    throw new Error('Não consegui abrir este arquivo. Ele é mesmo um PDF?');
  }
  const src = { name: file, bytes, pdf };
  S.sources.push(src);
  const si = S.sources.length - 1;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i);
    const vp = pg.getViewport({ scale: 1 });
    pages.push({ uid: uidSeq++, src: si, idx: i - 1, rot: 0, nat: pg.rotate || 0, w: vp.width, h: vp.height, annots: [] });
  }
  return pages;
}

async function openFile(file, bytesIn) {
  try {
    busy(true, 'Abrindo…');
    const bytes = bytesIn || new Uint8Array(await file.arrayBuffer());
    const name = file.name || 'documento.pdf';
    pageObjCache.clear();
    const pages = await loadSource(name, bytes);
    S.sources = [S.sources[S.sources.length - 1]];
    pages.forEach(p => p.src = 0);
    S.pages = pages; S.undo = []; S.redo = []; S.sel.clear(); S.dirty = false;
    S.fileName = name; S.current = 0; S.zoom = 1;
    $('#fname').textContent = name; $('#fname').title = name;
    showView('read');
    syncButtons();
  } catch (e) { toast(e.message || 'Erro ao abrir o PDF', 4500); }
  finally { busy(false); }
}

async function mergeFiles(files) {
  if (!hasDoc()) { if (files[0]) return openFile(files[0]); return; }
  try {
    busy(true, 'Juntando…');
    pushUndo();
    let added = 0;
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const pages = await loadSource(f.name, bytes);
      S.pages.push(...pages); added += pages.length;
    }
    refresh(); syncButtons();
    toast(`${added} página(s) adicionada(s) no final`);
  } catch (e) { S.undo.pop(); toast(e.message, 4500); }
  finally { busy(false); }
}

/* ============ Renderização ============ */
const pageObjCache = new Map();
async function getPdfPage(p) {
  const key = p.src + ':' + p.idx;
  if (!pageObjCache.has(key)) pageObjCache.set(key, S.sources[p.src].pdf.getPage(p.idx + 1));
  return pageObjCache.get(key);
}

async function renderCanvas(el, p, cssW) {
  const canvas = $('canvas', el);
  if (!canvas || p.src < 0) return;
  const tok = (el._tok = (el._tok || 0) + 1);
  try { el._task && el._task.cancel(); } catch {}
  const pg = await getPdfPage(p);
  if (tok !== el._tok) return;
  const [dw] = dispSize(p);
  let dpr = Math.min(window.devicePixelRatio || 1, 2) * (el._boost || 1);
  let scale = (cssW / dw) * dpr;
  const vp0 = pg.getViewport({ scale, rotation: (p.nat + p.rot) % 360 });
  if (vp0.width * vp0.height > 14e6) { scale *= Math.sqrt(14e6 / (vp0.width * vp0.height)); }
  const vp = pg.getViewport({ scale, rotation: (p.nat + p.rot) % 360 });
  const off = document.createElement('canvas');
  off.width = Math.floor(vp.width); off.height = Math.floor(vp.height);
  const task = pg.render({ canvasContext: off.getContext('2d'), viewport: vp });
  el._task = task;
  try { await task.promise; } catch { return; }
  if (tok !== el._tok || !el.isConnected) return;
  canvas.width = off.width; canvas.height = off.height;
  canvas.getContext('2d').drawImage(off, 0, 0);
  el._ok = true;
}
function releaseCanvas(el) {
  el._tok = (el._tok || 0) + 1;
  try { el._task && el._task.cancel(); } catch {}
  const c = $('canvas', el); if (c) { c.width = 1; c.height = 1; }
  el._ok = false;
}

function hex(c) { return c; }
function mk(tag, attrs) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }

function drawOverlay(svg, p, scale) {
  svg.innerHTML = '';
  p.annots.forEach((a, i) => {
    let e;
    if (a.t === 'd') {
      const pts = a.pts.map(([x, y]) => b2d(p, x, y, scale).join(',')).join(' ');
      e = mk('polyline', { points: pts, fill: 'none', stroke: a.c, 'stroke-width': Math.max(1, a.w * scale), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      if (a.pts.length === 1) {
        const [cx, cy] = b2d(p, a.pts[0][0], a.pts[0][1], scale);
        e = mk('circle', { cx, cy, r: Math.max(.5, a.w * scale / 2), fill: a.c });
      }
    } else if (a.t === 'hl' || a.t === 'wo') {
      const [x1, y1] = b2d(p, a.x, a.y, scale), [x2, y2] = b2d(p, a.x + a.w, a.y + a.h, scale);
      e = mk('rect', { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), fill: a.t === 'wo' ? '#ffffff' : a.c, 'fill-opacity': a.t === 'wo' ? 1 : .35 });
    } else if (a.t === 't') {
      e = mk('g', {});
      a.text.split('\n').forEach((ln, k) => {
        const [bx, by] = b2d(p, a.x, a.y + k * a.size * 1.2, scale);
        const t = mk('text', { x: 0, y: 0, fill: a.c, 'font-size': a.size * scale, 'font-family': 'Helvetica, Arial, sans-serif', transform: `translate(${bx},${by}) rotate(${p.rot})` });
        t.textContent = ln || ' ';
        e.appendChild(t);
      });
    }
    if (e) { e.dataset.i = i; svg.appendChild(e); }
  });
}

/* ---------- Modo Ler ---------- */
const ioRead = new IntersectionObserver(entries => {
  for (const en of entries) {
    const el = en.target;
    if (en.isIntersecting) { if (!el._ok && !el._busy) { el._busy = true; renderCanvas(el, el._p, el._cssW).finally(() => el._busy = false); } }
    else if (el._ok) releaseCanvas(el);
  }
}, { root: null, rootMargin: '900px 0px' });

function makePageEl(p, cw) {
  const [dw, dh] = dispSize(p);
  const scale = (cw / dw) * S.zoom;
  const el = document.createElement('div'); el.className = 'page';
  el.style.width = dw * scale + 'px'; el.style.height = dh * scale + 'px';
  el.dataset.uid = p.uid; el._p = p; el._scale = scale; el._cssW = dw * scale;
  const inner = document.createElement('div'); inner.className = 'inner';
  inner.innerHTML = p.src < 0 ? '' : '<canvas width="1" height="1"></canvas>';
  const svg = mk('svg', { width: dw * scale, height: dh * scale, viewBox: `0 0 ${dw * scale} ${dh * scale}` });
  inner.appendChild(svg); el.appendChild(inner);
  const num = document.createElement('div'); num.className = 'pnum'; num.textContent = S.pages.indexOf(p) + 1;
  el.appendChild(num);
  drawOverlay(svg, p, scale);
  attachDraw(svg, el, p, scale);
  return el;
}

function buildRead() {
  const root = $('#read'); root.innerHTML = ''; ioRead.disconnect();
  const cw = Math.max(200, root.clientWidth - 24);
  const frag = document.createDocumentFragment();
  S.pages.forEach(p => frag.appendChild(makePageEl(p, cw)));
  root.appendChild(frag);
  $$('.page', root).forEach(el => ioRead.observe(el));
  root.dataset.tool = S.tool;
}

function currentPageIndex() {
  const root = $('#read'); const kids = root.children;
  const mid = root.scrollTop + root.clientHeight / 3;
  for (let i = 0; i < kids.length; i++) if (kids[i].offsetTop + kids[i].offsetHeight > mid) return i;
  return Math.max(0, kids.length - 1);
}
function updateFab() {
  S.current = Math.min(currentPageIndex(), Math.max(0, S.pages.length - 1));
  $('#fabPage').textContent = `${S.current + 1} / ${S.pages.length}`;
}
$('#read').addEventListener('scroll', () => { clearTimeout(updateFab._t); updateFab._t = setTimeout(updateFab, 60); }, { passive: true });

/* ---------- Anotar (desenhar, texto etc.) ---------- */
function attachDraw(svg, el, p, scale) {
  let cur = null;
  const pos = e => { const r = svg.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  svg.addEventListener('pointerdown', e => {
    if (!['draw', 'hl', 'wo'].includes(S.tool)) return;
    e.preventDefault(); svg.setPointerCapture(e.pointerId);
    const [px, py] = pos(e); const [bx, by] = d2b(p, px, py, scale);
    if (S.tool === 'draw') cur = { t: 'd', c: S.color, w: Math.max(1, S.size / 8), pts: [[bx, by]] };
    else cur = { t: S.tool, c: S.tool === 'wo' ? '#ffffff' : (S.color === '#111111' ? '#facc15' : S.color), x: bx, y: by, w: 0, h: 0, _x0: bx, _y0: by };
    const tmp = mk(S.tool === 'draw' ? 'polyline' : 'rect', {}); tmp.id = 'tmpShape'; svg.appendChild(tmp); cur._svg = tmp;
    paintTmp();
  });
  function paintTmp() {
    const t = cur._svg;
    if (cur.t === 'd') {
      t.setAttribute('points', cur.pts.map(([x, y]) => b2d(p, x, y, scale).join(',')).join(' '));
      t.setAttribute('fill', 'none'); t.setAttribute('stroke', cur.c); t.setAttribute('stroke-width', Math.max(1, cur.w * scale));
      t.setAttribute('stroke-linecap', 'round'); t.setAttribute('stroke-linejoin', 'round');
    } else {
      const [x1, y1] = b2d(p, cur.x, cur.y, scale), [x2, y2] = b2d(p, cur.x + cur.w, cur.y + cur.h, scale);
      t.setAttribute('x', Math.min(x1, x2)); t.setAttribute('y', Math.min(y1, y2));
      t.setAttribute('width', Math.abs(x2 - x1)); t.setAttribute('height', Math.abs(y2 - y1));
      t.setAttribute('fill', cur.t === 'wo' ? '#fff' : cur.c); t.setAttribute('fill-opacity', cur.t === 'wo' ? 1 : .35);
      if (cur.t === 'wo') { t.setAttribute('stroke', '#bbb'); t.setAttribute('stroke-dasharray', '4'); }
    }
  }
  svg.addEventListener('pointermove', e => {
    if (!cur) return;
    const [px, py] = pos(e); const [bx, by] = d2b(p, px, py, scale);
    if (cur.t === 'd') { const l = cur.pts[cur.pts.length - 1]; if (Math.hypot(bx - l[0], by - l[1]) * scale > 1.2) cur.pts.push([bx, by]); }
    else { cur.x = Math.min(cur._x0, bx); cur.y = Math.min(cur._y0, by); cur.w = Math.abs(bx - cur._x0); cur.h = Math.abs(by - cur._y0); }
    paintTmp();
  });
  const end = () => {
    if (!cur) return;
    const a = cur; cur = null; a._svg.remove();
    if (a.t !== 'd' && (a.w * scale < 4 || a.h * scale < 4)) return;
    delete a._svg; delete a._x0; delete a._y0;
    pushUndo(); p.annots.push(a); drawOverlay(svg, p, scale);
  };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);

  svg.addEventListener('click', e => {
    if (S.tool === 'erase') {
      const g = e.target.closest('[data-i]'); if (!g) return;
      pushUndo(); p.annots.splice(+g.dataset.i, 1); drawOverlay(svg, p, scale);
    } else if (S.tool === 'text') {
      const [px, py] = pos(e); askText().then(txt => {
        if (!txt) return;
        const [bx, by] = d2b(p, px, py, scale);
        pushUndo(); p.annots.push({ t: 't', c: S.color, size: S.size, x: bx, y: by, text: txt }); drawOverlay(svg, p, scale);
      });
    }
  });
}

function askText() {
  return new Promise(res => {
    const d = $('#textDlg'); $('#textVal').value = '';
    d.returnValue = ''; d.showModal(); setTimeout(() => $('#textVal').focus(), 50);
    d.addEventListener('close', () => res(d.returnValue === 'ok' ? $('#textVal').value.trim() : ''), { once: true });
  });
}

/* ---------- Modo Páginas ---------- */
const ioGrid = new IntersectionObserver(entries => {
  for (const en of entries) {
    const el = en.target;
    if (en.isIntersecting) { if (!el._ok && !el._busy) { el._busy = true; renderCanvas(el, el._p, el._cssW).finally(() => el._busy = false); } }
    else if (el._ok) releaseCanvas(el);
  }
}, { rootMargin: '700px 0px' });

function makeCard(p, i) {
  const [dw, dh] = dispSize(p);
  const s = Math.min(138 / dw, 190 / dh);
  const card = document.createElement('div'); card.className = 'card' + (S.sel.has(p.uid) ? ' sel' : '');
  card.dataset.uid = p.uid;
  card.innerHTML = `<div class="chk">✓</div><button class="eye" title="Abrir esta página">👁</button><div class="thumb"><div class="tw"></div></div><div class="lbl">Página ${i + 1}</div>`;
  const tw = $('.tw', card); tw.style.width = dw * s + 'px'; tw.style.height = dh * s + 'px';
  tw.innerHTML = p.src < 0 ? '' : '<canvas width="1" height="1"></canvas>';
  const svg = mk('svg', { viewBox: `0 0 ${dw * s} ${dh * s}` }); tw.appendChild(svg); drawOverlay(svg, p, s);
  card._p = p; card._cssW = dw * s; card._boost = 1.5; card._tw = tw;
  card.addEventListener('click', e => {
    if (e.target.closest('.eye')) { S.pendingScroll = S.pages.indexOf(p); showView('read'); return; }
    if (S.sel.has(p.uid)) S.sel.delete(p.uid); else S.sel.add(p.uid);
    card.classList.toggle('sel'); updateGridInfo();
  });
  return card;
}
function buildGrid() {
  const root = $('#grid'); root.innerHTML = ''; ioGrid.disconnect();
  S.pages.forEach((p, i) => { const c = makeCard(p, i); root.appendChild(c); ioGrid.observe(c); });
  updateGridInfo();
}
function updateGridInfo() {
  const n = S.sel.size;
  $('#gridInfo').textContent = n ? `${n} página(s) selecionada(s)` : 'Nenhuma selecionada — girar vale para TODAS as páginas';
  $('#gDel').disabled = !n || n >= S.pages.length;
  $('#gExtract').disabled = !n;
  $('#gDup').disabled = !n; $('#gLeft').disabled = !n; $('#gRight').disabled = !n;
  $('#gAll').querySelector('small').textContent = n === S.pages.length && n ? 'Nenhuma' : 'Todas';
}

/* ============ Vistas ============ */
function showView(v) {
  S.view = v;
  const doc = hasDoc();
  $('#empty').hidden = doc;
  $('#read').hidden = !doc || v !== 'read';
  $('#grid').hidden = !doc || v !== 'grid';
  $('#toolbar').hidden = !doc || v !== 'read';
  $('#fab').hidden = !doc || v !== 'read';
  $('#gridbar').hidden = !doc || v !== 'grid';
  $('#vRead').classList.toggle('on', v === 'read'); $('#vGrid').classList.toggle('on', v === 'grid');
  if (doc) {
    if (v === 'read') {
      buildRead();
      const idx = S.pendingScroll ?? S.current; S.pendingScroll = undefined;
      requestAnimationFrame(() => { const el = $('#read').children[idx]; if (el) $('#read').scrollTop = el.offsetTop - 10; updateFab(); });
    } else buildGrid();
  }
  syncButtons();
}
function refresh() {
  if (!hasDoc()) return showView(S.view);
  if (S.view === 'read') {
    const root = $('#read'); const top = root.scrollTop; const idx = currentPageIndex();
    const prevH = root.scrollHeight;
    buildRead();
    root.scrollTop = Math.min(top, root.scrollHeight);
    updateFab();
  } else {
    const root = $('#grid'); const top = root.scrollTop; buildGrid(); root.scrollTop = top;
  }
}

/* ============ Ações nas páginas ============ */
function spinEls(uids, d) {
  const root = S.view === 'read' ? $('#read') : $('#grid');
  uids.forEach(u => {
    const el = root.querySelector(`[data-uid="${u}"]`); if (!el) return;
    const target = S.view === 'read' ? $('.inner', el) : el._tw;
    if (target) target.style.transform = `rotate(${d}deg)`;
  });
}
function rotate(uids, d) {
  if (!uids.length) return;
  spinEls(uids, d);
  pushUndo();
  const set = new Set(uids);
  S.pages.forEach(p => { if (set.has(p.uid)) p.rot = (p.rot + d + 360) % 360; });
  clearTimeout(rotate._t);
  rotate._t = setTimeout(refresh, 240);
}
const selOrAll = () => S.sel.size ? S.pages.filter(p => S.sel.has(p.uid)).map(p => p.uid) : S.pages.map(p => p.uid);

$('#fabRotL').onclick = () => rotate([S.pages[S.current].uid], -90);
$('#fabRotR').onclick = () => rotate([S.pages[S.current].uid], 90);
$('#gRotL').onclick = () => rotate(selOrAll(), -90);
$('#gRotR').onclick = () => rotate(selOrAll(), 90);

$('#gLeft').onclick = () => movePages(-1);
$('#gRight').onclick = () => movePages(1);
function movePages(dir) {
  if (!S.sel.size) return;
  pushUndo();
  const a = S.pages, sel = S.sel;
  if (dir < 0) { for (let i = 1; i < a.length; i++) if (sel.has(a[i].uid) && !sel.has(a[i - 1].uid)) [a[i - 1], a[i]] = [a[i], a[i - 1]]; }
  else { for (let i = a.length - 2; i >= 0; i--) if (sel.has(a[i].uid) && !sel.has(a[i + 1].uid)) [a[i + 1], a[i]] = [a[i], a[i + 1]]; }
  refresh();
}
$('#gDup').onclick = () => {
  if (!S.sel.size) return; pushUndo();
  const out = [];
  for (const p of S.pages) { out.push(p); if (S.sel.has(p.uid)) out.push({ ...JSON.parse(JSON.stringify(p)), uid: uidSeq++ }); }
  S.pages = out; refresh(); toast('Página(s) duplicada(s)');
};
$('#gBlank').onclick = () => {
  pushUndo();
  const ref = S.pages.find(p => S.sel.has(p.uid)) || S.pages[S.pages.length - 1];
  const bp = { uid: uidSeq++, src: -1, idx: 0, rot: 0, nat: 0, w: ref ? (ref.rot % 180 ? ref.h : ref.w) : 595, h: ref ? (ref.rot % 180 ? ref.w : ref.h) : 842, annots: [] };
  let at = S.pages.length;
  if (S.sel.size) at = Math.max(...S.pages.map((p, i) => S.sel.has(p.uid) ? i : -1)) + 1;
  S.pages.splice(at, 0, bp); refresh(); toast('Página em branco adicionada');
};
$('#gDel').onclick = () => {
  if (!S.sel.size || S.sel.size >= S.pages.length) return;
  if (!confirm(`Excluir ${S.sel.size} página(s)? (dá para desfazer)`)) return;
  pushUndo(); S.pages = S.pages.filter(p => !S.sel.has(p.uid)); S.sel.clear(); refresh();
};
$('#gAll').onclick = () => {
  if (S.sel.size === S.pages.length) S.sel.clear(); else S.pages.forEach(p => S.sel.add(p.uid));
  $$('#grid .card').forEach(c => c.classList.toggle('sel', S.sel.has(+c.dataset.uid))); updateGridInfo();
};
$('#gExtract').onclick = async () => {
  const list = S.pages.filter(p => S.sel.has(p.uid)); if (!list.length) return;
  try { busy(true, 'Criando PDF…'); const bytes = await buildPdf(list); await deliver(bytes, baseName() + '-extraido.pdf'); }
  catch (e) { toast('Erro: ' + e.message, 5000); } finally { busy(false); }
};

/* ============ Salvar ============ */
function baseName() { return S.fileName.replace(/\.pdf$/i, ''); }
const rgbOf = c => { const n = parseInt(c.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

async function buildPdf(list) {
  const { PDFDocument, degrees, rgb, StandardFonts, LineCapStyle } = PDFLib;
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const docs = new Map(), prepared = new Map();
  const safe = s => [...s].map(ch => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');

  // copia as páginas de cada arquivo de uma vez (evita repetir recursos)
  const bySrc = new Map();
  for (const p of list) if (p.src >= 0) { if (!bySrc.has(p.src)) bySrc.set(p.src, new Set()); bySrc.get(p.src).add(p.idx); }
  for (const [si, idxSet] of bySrc) {
    const d = await PDFDocument.load(S.sources[si].bytes, { ignoreEncryption: true });
    docs.set(si, d);
    const idxs = [...idxSet]; const copies = await out.copyPages(d, idxs);
    idxs.forEach((ix, k) => prepared.set(si + ':' + ix, copies[k]));
  }

  for (const p of list) {
    let page, vp = null;
    if (p.src < 0) page = out.addPage([p.w, p.h]);
    else {
      const key = p.src + ':' + p.idx;
      page = prepared.get(key);
      if (page) prepared.delete(key);
      else [page] = await out.copyPages(docs.get(p.src), [p.idx]);
      out.addPage(page);
      vp = (await getPdfPage(p)).getViewport({ scale: 1 });
    }
    const toUser = (x, y) => vp ? vp.convertToPdfPoint(x, y) : [x, p.h - y];
    const nat = vp ? p.nat : 0;
    for (const a of p.annots) {
      const [r, g, b] = rgbOf(a.c || '#000000');
      if (a.t === 'd') {
        const pts = a.pts.map(([x, y]) => toUser(x, y));
        if (pts.length === 1) page.drawCircle({ x: pts[0][0], y: pts[0][1], size: a.w / 2, color: rgb(r, g, b) });
        for (let i = 1; i < pts.length; i++)
          page.drawLine({ start: { x: pts[i - 1][0], y: pts[i - 1][1] }, end: { x: pts[i][0], y: pts[i][1] }, thickness: a.w, color: rgb(r, g, b), lineCap: LineCapStyle.Round });
      } else if (a.t === 'hl' || a.t === 'wo') {
        const [x1, y1] = toUser(a.x, a.y), [x2, y2] = toUser(a.x + a.w, a.y + a.h);
        page.drawRectangle({ x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), color: a.t === 'wo' ? rgb(1, 1, 1) : rgb(r, g, b), opacity: a.t === 'wo' ? 1 : .35 });
      } else if (a.t === 't') {
        a.text.split('\n').forEach((ln, k) => {
          const [x, y] = toUser(a.x, a.y + k * a.size * 1.2);
          page.drawText(safe(ln), { x, y, size: a.size, font, color: rgb(r, g, b), rotate: degrees(nat) });
        });
      }
    }
    const cur = page.getRotation().angle;
    page.setRotation(degrees((((cur + p.rot) % 360) + 360) % 360));
  }
  out.setProducer('Editor de PDF');
  return out.save();
}

const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
async function deliverNative(bytes, name) {
  const { Filesystem, Share } = window.Capacitor.Plugins;
  let bin = ''; const ch = 0x8000;
  for (let i = 0; i < bytes.length; i += ch) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + ch));
  const r = await Filesystem.writeFile({ path: name, data: btoa(bin), directory: 'CACHE', recursive: true });
  try { await Share.share({ title: name, url: r.uri, dialogTitle: 'Salvar, enviar ou abrir o PDF' }); }
  catch (e) { if (!/cancel/i.test(String(e && e.message))) toast('Não consegui abrir o menu de compartilhar', 4000); }
}

async function deliver(bytes, name, { share = false } = {}) {
  if (isNative()) return deliverNative(bytes, name);
  const blob = new Blob([bytes], { type: 'application/pdf' });
  if (share && navigator.canShare) {
    const f = new File([blob], name, { type: 'application/pdf' });
    if (navigator.canShare({ files: [f] })) { try { await navigator.share({ files: [f], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
  toast('PDF salvo: ' + name);
}

$('#btnSave').onclick = async () => {
  if (!hasDoc()) return;
  try { busy(true, 'Salvando…'); const bytes = await buildPdf(S.pages); await deliver(bytes, baseName() + '-editado.pdf'); S.dirty = false; }
  catch (e) { console.error(e); toast('Erro ao salvar: ' + e.message, 5000); } finally { busy(false); }
};
$('#mShare').onclick = async () => {
  closeMenu(); if (!hasDoc()) return;
  try { busy(true, 'Preparando…'); const bytes = await buildPdf(S.pages); await deliver(bytes, baseName() + '-editado.pdf', { share: true }); }
  catch (e) { toast('Erro: ' + e.message, 5000); } finally { busy(false); }
};
$('#mPrint').onclick = async () => {
  closeMenu(); if (!hasDoc()) return;
  try {
    busy(true, 'Preparando…');
    const bytes = await buildPdf(S.pages);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    if (isNative()) { await deliverNative(bytes, baseName() + '-editado.pdf'); return; }
    if (matchMedia('(pointer:coarse)').matches) { window.open(url, '_blank'); return; }
    const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    f.src = url; document.body.appendChild(f);
    f.onload = () => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch { window.open(url, '_blank'); } };
  } catch (e) { toast('Erro: ' + e.message, 5000); } finally { busy(false); }
};

/* ============ Menu e eventos gerais ============ */
function closeMenu() { $('#menu').hidden = true; }
$('#btnMore').onclick = e => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; };
document.addEventListener('click', e => { if (!e.target.closest('#menu') && e.target.id !== 'btnMore') closeMenu(); });
$('#mMerge').onclick = () => { closeMenu(); $('#fileMerge').click(); };
$('#mClose').onclick = () => {
  closeMenu();
  if (S.dirty && !confirm('Há alterações não salvas. Fechar mesmo assim?')) return;
  S.pages = []; S.sources = []; S.sel.clear(); S.undo = []; S.redo = []; S.dirty = false; pageObjCache.clear();
  $('#fname').textContent = 'Nenhum arquivo'; showView('read');
};

$('#btnOpen').onclick = $('#btnOpen2').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) openFile(f); };
$('#fileMerge').onchange = e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) mergeFiles(fs); };

$('#vRead').onclick = () => showView('read');
$('#vGrid').onclick = () => { if (S.view === 'read') S.current = currentPageIndex(); showView('grid'); };
$('#btnUndo').onclick = doUndo; $('#btnRedo').onclick = doRedo;
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); doRedo(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); $('#btnSave').click(); }
});

$$('#tools button').forEach(b => b.onclick = () => {
  S.tool = b.dataset.tool;
  $$('#tools button').forEach(x => x.classList.toggle('on', x === b));
  $('#read').dataset.tool = S.tool;
});
$$('#colors button').forEach(b => b.onclick = () => {
  S.color = b.dataset.c; $$('#colors button').forEach(x => x.classList.toggle('on', x === b));
});
$('#sizeSel').onchange = e => S.size = +e.target.value;

$('#zoomIn').onclick = () => setZoom(S.zoom * 1.25);
$('#zoomOut').onclick = () => setZoom(S.zoom / 1.25);
function setZoom(z) {
  S.zoom = Math.max(.5, Math.min(4, z));
  const root = $('#read'); const ratio = root.scrollTop / Math.max(1, root.scrollHeight);
  buildRead(); root.scrollTop = ratio * root.scrollHeight; updateFab();
}
$('#fabPage').onclick = () => {
  const n = parseInt(prompt(`Ir para a página (1 a ${S.pages.length}):`, S.current + 1), 10);
  if (n >= 1 && n <= S.pages.length) { const el = $('#read').children[n - 1]; $('#read').scrollTop = el.offsetTop - 10; }
};

let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (hasDoc() && S.view === 'read') refresh(); }, 250); });
window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

/* arrastar e soltar */
['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); document.body.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); document.body.classList.remove('drag'); }));
document.addEventListener('drop', e => {
  const fs = [...e.dataTransfer.files].filter(f => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  if (!fs.length) return;
  hasDoc() ? mergeFiles(fs) : openFile(fs[0]);
});

/* ============ Inicialização / PWA ============ */
async function openFromUrl(url) {
  try {
    if (S.dirty && !confirm('Abrir outro PDF e descartar as alterações não salvas?')) return;
    const { Filesystem } = window.Capacitor.Plugins;
    const r = await Filesystem.readFile({ path: url });
    const bin = atob(r.data); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    let name = 'documento.pdf';
    try { const seg = decodeURIComponent(url.split('?')[0]).split(/[\/:]/).pop(); if (/\.pdf$/i.test(seg)) name = seg; } catch {}
    await openFile({ name }, bytes);
  } catch (e) { toast('Não consegui abrir este PDF', 4000); }
}
async function setupNativeOpen() {
  if (!isNative()) return;
  const { App } = window.Capacitor.Plugins;
  try { const l = await App.getLaunchUrl(); if (l && l.url) openFromUrl(l.url); } catch {}
  App.addListener('appUrlOpen', e => { if (e && e.url) openFromUrl(e.url); });
}
setupNativeOpen();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
(async function boot() {
  showView('read');
  if (new URLSearchParams(location.search).has('shared')) {
    try {
      const c = await caches.open('shared-files'); const r = await c.match('./shared.pdf');
      if (r) { const name = decodeURIComponent(r.headers.get('X-Name') || 'compartilhado.pdf'); const bytes = new Uint8Array(await r.arrayBuffer()); await c.delete('./shared.pdf'); history.replaceState(null, '', location.pathname); await openFile({ name }, bytes); }
    } catch { toast('Não consegui abrir o arquivo compartilhado'); }
  }
})();
window.__S = S; // para testes
