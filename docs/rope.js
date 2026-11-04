'use strict';
/* The rope window: physics, layout, click-through, auto hide, and all card interactions. */
const stage = $('#stage'), hangsEl = $('#hangs'), peek = $('#peek'), tab = $('#tab'), menuBtn = $('#menuBtn');
const ropeMain = $('#ropeMain'), ropeTwist = $('#ropeTwist'), ropeShadow = $('#ropeShadow'), ropeHit = $('#ropeHit'), nailL = $('#nailL'), nailR = $('#nailR');
let ANCHOR = 12; const MARGIN_L = 40, MARGIN_R = 66;
/* The rope can live on the top, left or right edge. All rope maths runs in "rope space":
   u = distance along the rope, v = distance away from the screen edge. The stage is rotated onto the edge. */
let EDGE = 'top';
const ropeLen = () => (EDGE === 'top' ? innerWidth : innerHeight);
function V(x, y) {
  if (EDGE === 'left') return { x: innerHeight - y, y: x };
  if (EDGE === 'right') return { x: y, y: innerWidth - x };
  return { x, y };
}
const VE = e => V(e.clientX, e.clientY);

let items = [], settings = {};
const R = { sag: 20, sagT: 20, sv: 0, pa: 0, pv: 0, px: 0, plucking: false, scroll: 0, maxScroll: 0, tw: 108, step: 124, startX: 0, hot: null, phys: new Map(), running: false, last: 0, W: 1200, maxH: 120, clickT: 0, dragOutUntil: 0 };
let op = null, expanded = true, holdUntil = performance.now() + 3200, menuOpen = false, cur = { x: -1, y: -1, inside: false }, leaveSince = 0, edgeSince = 0;

const byId = id => items.find(i => i.id === id);
const ropeBaseY = x => { const u = clamp(x / R.W, 0, 1); return ANCHOR + R.sag * 4 * u * (1 - u); };
function ropeY(x) { const s = R.W * .12, d = (x - R.px) / s; return ropeBaseY(x) + R.pa * Math.exp(-d * d) + mascotDent(x); }
function ropeSlope(x) { const u = clamp(x / R.W, 0, 1), s = R.W * .12, d = (x - R.px) / s; return R.sag * 4 * (1 - 2 * u) / R.W + R.pa * Math.exp(-d * d) * (-2 * d / s); }
const zoneBottom = () => ANCHOR + R.sag + (items.length ? Math.max(70, R.maxH * .9 + 14) : 64);
function thumbAspect(it) {
  if (EDGE !== 'top') return 1;
  switch (it.type) { case 'image': case 'pdf': return clamp(it.ratio || 1.3, .66, 1.6); case 'video': return clamp(it.ratio || 1.78, .66, 1.78); case 'note': return 1.05; case 'text': return .8; default: return 1.2; }
}

/* ---------- cards ---------- */
function makeHang(it) {
  const el = document.createElement('div');
  el.className = 'hang'; el.dataset.id = it.id;
  el.style.setProperty('--pc', `var(--n${1 + (hashNum(it.id) % 5)})`);
  el.innerHTML = `<div class="swing"><div class="thumb" draggable="true"><div class="tv tv-${it.type}"></div><div class="tcap"></div></div><button class="hang-x" title="删除" aria-label="删除">${ic('x')}</button></div><div class="clip" title="点夹子：钉到屏幕上"></div>`;
  const p = { id: it.id, el, swing: el.firstElementChild, thumb: el.querySelector('.thumb'), tv: el.querySelector('.tv'), tx: 0, ox: 0, oy: 0, vx: 0, vy: 0, th: 0, om: 0, w: R.tw, h: 110, drag: null, ppx: null, pvx: 0, placed: false, cx: -999, cy: 0, sig: '' };
  updateHang(p, it);
  return p;
}
function setRatio(it, p, ratio) {
  if (!ratio || !isFinite(ratio)) return;
  if (it.ratio && Math.abs(it.ratio - ratio) < .01) return;
  it.ratio = ratio; api.send('set-meta', it.id, { ratio });
  p.tv.style.aspectRatio = thumbAspect(it).toFixed(3); layoutRope();
}
function fillThumb(p, it) {
  const tv = p.tv;
  tv.style.aspectRatio = thumbAspect(it).toFixed(3);
  tv.style.background = '';
  if (it.missing) { tv.innerHTML = '<span class="tv-miss">原文件找不到了</span>'; return; }
  switch (it.type) {
    case 'image': {
      tv.innerHTML = `<img alt="" draggable="false">`;
      const img = tv.firstChild;
      img.onload = () => setRatio(it, p, img.naturalWidth / img.naturalHeight);
      img.onerror = () => { tv.innerHTML = '<span class="tv-miss">预览不了</span>'; };
      img.src = it.src; break;
    }
    case 'pdf':
      tv.innerHTML = '<canvas></canvas><span class="tbadge">PDF</span>';
      getPdf(it.id).then(doc => renderPage(doc, 1, 140, 200, 2)).then(r => { const cv = tv.querySelector('canvas'); if (cv) paint(cv, r); setRatio(it, p, r.ratio); }).catch(() => { tv.innerHTML = '<span class="tv-miss">PDF 打不开</span>'; });
      break;
    case 'video': {
      tv.innerHTML = `<video muted playsinline preload="metadata"></video><span class="tplay">${ic('play')}</span>`;
      const v = tv.firstChild;
      v.onloadedmetadata = () => setRatio(it, p, v.videoWidth / v.videoHeight);
      v.onerror = () => { tv.innerHTML = `<div class="tv-file"><span class="ext"></span></div>`; tv.querySelector('.ext').textContent = it.ext || 'VID'; };
      v.src = it.src + '#t=0.1'; break;
    }
    case 'note': tv.innerHTML = '<div class="tv-note"></div>'; tv.firstChild.textContent = it.text || ''; tv.style.background = `var(--n${it.color || 1})`; break;
    case 'text': tv.innerHTML = '<pre class="tv-text"></pre>'; api.invoke('read-text', it.id, 1500).then(t => { const pre = tv.querySelector('pre'); if (pre) pre.textContent = t; }); break;
    case 'link': { const host = hostOf(it.url); tv.innerHTML = '<div class="tv-link"><span class="lk-avatar"></span><span class="tv-host"></span></div>'; tv.querySelector('.lk-avatar').textContent = (host[0] || '?').toUpperCase(); tv.querySelector('.tv-host').textContent = host; break; }
    default: tv.innerHTML = '<div class="tv-file"><span class="ext"></span></div>'; tv.querySelector('.ext').textContent = it.ext || 'FILE';
  }
}
/* ghost cards (see the 先挂个虚影 setting): see-through, breathing, with a countdown ring until clicked */
function syncGhost(p, it) {
  let tag = p.el.querySelector('.ghost-tag');
  if (!it.pending) { if (tag) { tag.remove(); p.el.classList.remove('ghost', 'ghost-hold'); p.pendTs = null; } return; }
  p.el.classList.add('ghost');
  if (!tag) { tag = document.createElement('div'); tag.className = 'ghost-tag'; tag.innerHTML = '<i class="ghost-ring"></i><span>点一下留下</span>'; p.thumb.appendChild(tag); }
  if (p.pendTs !== it.pending) {
    p.pendTs = it.pending;
    const total = Math.max(3, Math.min(60, settings.ghostSecs || 8)) * 1000, left = clamp(it.pending - Date.now(), 200, total);
    const ring = tag.firstChild; ring.style.animation = 'none'; void ring.offsetWidth;
    ring.style.animation = ''; ring.style.animationDuration = total + 'ms'; ring.style.animationDelay = (left - total) + 'ms';
  }
}
function keepGhost(p) {
  const it = byId(p.id); if (!it || !it.pending) return false;
  delete it.pending; api.send('keep', p.id); syncGhost(p, it);
  p.el.classList.remove('kept'); void p.el.offsetWidth; p.el.classList.add('kept');
  p.oy -= 14; p.om += (Math.random() - .5) * 1.6; kick();
  burst(p.cx, p.cy + 6, 6);
  return true;
}
function updateHang(p, it) {
  syncGhost(p, it);
  const sig = [it.type, it.src, it.text, it.color, it.missing, it.url].join('|');
  if (sig !== p.sig) { p.sig = sig; fillThumb(p, it); }
  const cap = p.el.querySelector('.tcap'), t = it.title || TYPE_NAME[it.type];
  if (cap.textContent !== t) cap.textContent = t;
}
function renderRope(from, added) {
  const ids = new Set(items.map(i => i.id));
  for (const [id, p] of R.phys) if (!ids.has(id)) {
    R.phys.delete(id);
    /* an unclaimed ghost fades away instead of blinking out */
    if (p.el.classList.contains('ghost') && !reduceMotion) { p.el.classList.add('vanish'); setTimeout(() => p.el.remove(), 520); }
    else p.el.remove();
  }
  const fresh = [];
  for (const it of items) {
    let p = R.phys.get(it.id);
    if (!p) { p = makeHang(it); R.phys.set(it.id, p); hangsEl.appendChild(p.el); fresh.push(p); }
    else updateHang(p, it);
  }
  layoutRope(true);
  for (const p of fresh) {
    const r = from && from[p.id];
    if (r) {
      const sx = r.x + r.width / 2, sy = r.y;
      p.ox = sx - p.tx; p.oy = sy - ropeY(sx); p.om = (Math.random() - .5) * 2;
      p.el.style.setProperty('--from', clamp(r.width / p.w, 1, 5).toFixed(3));
      p.el.classList.add('morph'); setTimeout(() => p.el.classList.remove('morph'), 520);
    } else if (!reduceMotion) { p.oy = -170 - Math.random() * 90; p.th = (Math.random() - .5) * .5; }
  }
  if (fresh.length) R.sv += 60;
  if (added && added.length) {
    const last = R.phys.get(added[added.length - 1]);
    if (R.maxScroll && last && (last.tx < MARGIN_L || last.tx > R.W - MARGIN_R)) { R.scroll = clamp(R.scroll + last.tx - R.W / 2, 0, R.maxScroll); layoutRope(true); }
  }
  stage.classList.toggle('empty', !items.length);
  $('#tabCount').textContent = items.length ? `${items.length}` : '';
  placeToasts(); kick();
}
/* Cards hang wherever you put them (it.rx = position along the rope, 0..1 of the width).
   They never overlap: a card dropped onto a crowded spot nudges its neighbours aside.
   If the rope is too full to fit everyone, cards shrink, then the rope scrolls. */
function solveRope(list, hotX) {
  const W = R.W, L = MARGIN_L, Rt = W - MARGIN_R;
  const n = list.length + (hotX != null ? 1 : 0);
  const base = W < 1100 ? 94 : 108;
  const tw = Math.round(base * clamp(1 - Math.max(0, n - 8) * .03, .66, 1));
  const step = tw + Math.round(tw * .17), half = step / 2;
  const minX = L + half, maxX = Rt - half;
  /* cards without a spot yet (new arrivals) go just right of the rightmost card */
  let right = -Infinity;
  for (const it of list) if (it.rx != null) right = Math.max(right, it.rx * W);
  for (const it of list) if (it.rx == null) { const x = right === -Infinity ? W / 2 : right + step; it.rx = clamp(x, minX, maxX) / W; right = Math.max(right, x); it._new = true; }
  const arr = list.map(it => ({ it, d: clamp(it.rx * W, minX, maxX) }));
  if (hotX != null) arr.push({ ghost: true, d: clamp(hotX, minX, maxX) });
  arr.sort((a, b) => a.d - b.d || (a.ghost ? -1 : b.ghost ? 1 : 0));
  const need = (arr.length - 1) * step, avail = maxX - minX;
  let scroll = 0;
  if (need <= avail) {
    arr.forEach((a, i) => { a.x = i === 0 ? Math.max(a.d, minX) : Math.max(a.d, arr[i - 1].x + step); });
    for (let i = arr.length - 1; i >= 0; i--) arr[i].x = Math.min(arr[i].x, i === arr.length - 1 ? maxX : arr[i + 1].x - step);
  } else {
    scroll = need - avail;
    R.scroll = clamp(R.scroll, 0, scroll);
    arr.forEach((a, i) => { a.x = minX + i * step - R.scroll; });
  }
  return { arr, tw, step, scroll };
}
function layoutRope(immediate) {
  R.W = ropeLen();
  const list = items.filter(i => { const p = R.phys.get(i.id); return p && !p.drag; });
  const { arr, tw, step, scroll } = solveRope(list, R.hot);
  if (tw !== R.tw) { R.tw = tw; hangsEl.style.setProperty('--tw', tw + 'px'); }
  R.step = step; R.maxScroll = scroll; R.scroll = clamp(R.scroll, 0, scroll);
  hangsEl.classList.toggle('scrolls', scroll > 0);
  R.ghostX = null;
  let maxH = 0;
  const fresh = [];
  for (const a of arr) {
    if (a.ghost) { R.ghostX = a.x; continue; }
    const p = R.phys.get(a.it.id);
    if (p.placed && !immediate) p.ox += p.tx - a.x;
    p.tx = a.x; p.placed = true;
    p.w = tw; p.h = p.thumb.offsetHeight || tw; maxH = Math.max(maxH, p.h);
    if (a.it._new) { delete a.it._new; fresh.push(a.it); }
  }
  if (fresh.length) savePositions();
  R.maxH = maxH || 110;
  R.sagT = 10 + Math.min(list.length, 16) * 2.4 + (R.hot != null ? 8 : 0);
  stage.style.setProperty('--hide', (zoneBottom() + 60) + 'px');
  if (!R.running) drawRope();
  placeToasts(); kick();
}
/* remember where every card ended up (only when nothing is scrolling, so positions stay meaningful) */
function savePositions() {
  if (R.maxScroll > 0) { api.send('positions', Object.fromEntries(items.map(i => [i.id, i.rx]))); return; }
  const pos = {};
  for (const it of items) { const p = R.phys.get(it.id); if (p && p.placed && !p.drag) { it.rx = p.tx / R.W; } pos[it.id] = it.rx; }
  items.sort((a, b) => a.rx - b.rx);
  api.send('positions', pos);
}
function setHot(x) {
  if (x == null && R.hot == null) return;
  if (x != null && R.hot != null && Math.abs(x - R.hot) < 2) return;
  R.hot = x; stage.classList.toggle('hot', x != null); layoutRope();
}
function drawRope() {
  const W = R.W, N = Math.max(40, Math.round(W / 16)), pts = [];
  for (let i = 0; i <= N; i++) { const x = -6 + (W + 12) * i / N; pts.push(x.toFixed(1) + ' ' + ropeY(x).toFixed(2)); }
  const d = 'M' + pts.join('L');
  ropeMain.setAttribute('d', d); ropeTwist.setAttribute('d', d); ropeShadow.setAttribute('d', d); ropeHit.setAttribute('d', d);
  nailL.setAttribute('cx', 8); nailL.setAttribute('cy', ropeY(8).toFixed(1));
  nailR.setAttribute('cx', W - 8); nailR.setAttribute('cy', ropeY(W - 8).toFixed(1));
  const mx = W - 36; menuBtn.style.translate = `${mx - 13}px ${Math.max(6, ropeY(mx) - 13).toFixed(1)}px`;
}
function kick() { if (!R.running && expanded) { R.running = true; R.last = performance.now(); requestAnimationFrame(frame); } }
function frame(now) {
  const dt = clamp((now - R.last) / 1000, 1 / 240, 1 / 30); R.last = now;
  R.sv += (170 * (R.sagT - R.sag) - 10 * R.sv) * dt; R.sag += R.sv * dt;
  if (!R.plucking) { R.pv += (-240 * R.pa - 3 * R.pv) * dt; R.pa += R.pv * dt; }
  let active = R.plucking || Math.abs(R.sv) > .04 || Math.abs(R.sagT - R.sag) > .04 || Math.abs(R.pa) > .04 || Math.abs(R.pv) > .04;
  for (const p of R.phys.values()) {
    let px, py;
    if (p.drag) {
      px = p.drag.x; py = p.drag.y;
      const vx = p.ppx == null ? 0 : (px - p.ppx) / dt, ax = (vx - p.pvx) / dt;
      p.pvx = vx; p.ppx = px;
      p.om += (-38 * p.th - 3 * p.om - clamp(ax, -9000, 9000) * .0011) * dt;
      active = true;
    } else {
      const ax = -165 * p.ox - 15 * p.vx;
      p.vx += ax * dt; p.ox += p.vx * dt;
      p.vy += (-165 * p.oy - 14 * p.vy) * dt; p.oy += p.vy * dt;
      p.om += (-36 * p.th - 1.3 * p.om - clamp(ax, -6000, 6000) * .0011) * dt;
      px = p.tx + p.ox; py = ropeY(px) + p.oy;
      p.ppx = null; p.pvx = 0;
      if (Math.abs(p.ox) > .25 || Math.abs(p.oy) > .25 || Math.abs(p.vx) > .25 || Math.abs(p.vy) > .25) active = true;
    }
    p.om = clamp(p.om, -7, 7); p.th = clamp(p.th + p.om * dt, -1.1, 1.1);
    if (Math.abs(p.th) > .0015 || Math.abs(p.om) > .0015) active = true;
    const slope = p.drag ? 0 : Math.atan(ropeSlope(px));
    p.el.style.transform = `translate(${(px - p.w / 2).toFixed(2)}px, ${py.toFixed(2)}px) rotate(${slope.toFixed(4)}rad)`;
    p.swing.style.transform = `rotate(${(p.th - slope).toFixed(4)}rad)`;
    p.cx = px; p.cy = py;
  }
  drawRope();
  if (active && expanded && !document.hidden) requestAnimationFrame(frame); else R.running = false;
}

/* ---------- show / hide + click-through ---------- */
function expand(holdMs) {
  if (holdMs) holdUntil = Math.max(holdUntil, performance.now() + holdMs);
  if (expanded) return;
  expanded = true; stage.classList.remove('collapsed'); tab.classList.remove('show');
  for (const p of R.phys.values()) { p.oy -= 30 + Math.random() * 30; p.om += (Math.random() - .5) * 1.2; }
  kick();
}
function collapse() {
  if (!expanded) return;
  expanded = false; hidePeek(); stage.classList.add('collapsed'); tab.classList.toggle('show', true);
  setInteractive(false);
}
let interactive = false;
function setInteractive(v) { if (v === interactive) return; interactive = v; api.send('set-ignore', !v); }
function hitTest(x, y) {
  if (op) return true;
  const el = document.elementFromPoint(x, y);
  if (el && el.closest('.toast, #panel')) return true;
  if (!expanded) return !!(el && el.closest('#tab'));
  if (el && el.closest('.hang, .rope-end, .mascot, #panel, #empty')) return true;
  const q = V(x, y);
  return q.x > 0 && q.x < R.W && Math.abs(q.y - ropeY(q.x)) < 13;
}
function inZone() { return (cur.inside && V(cur.x, cur.y).y < zoneBottom() + 26) || !peek.hidden; }
setInterval(() => {
  const now = performance.now();
  if (!expanded || op || menuOpen || !panel.hidden || !settings.autoHide || now < holdUntil) { leaveSince = 0; return; }
  if (inZone()) { leaveSince = 0; return; }
  if (!leaveSince) leaveSince = now;
  if (now - leaveSince > 650) { leaveSince = 0; collapse(); }
}, 120);
let edgeT = 0;
api.on('cursor', c => {
  cur = c;
  if (!expanded) {
    const atEdge = EDGE === 'left' ? c.x <= 2 : EDGE === 'right' ? c.x >= innerWidth - 3 : c.y <= 2;
    /* the cursor is only reported when it moves, so a pointer resting on the edge needs its own timer */
    if (c.inside && atEdge) { if (!edgeSince) { edgeSince = performance.now(); clearTimeout(edgeT); edgeT = setTimeout(() => { if (edgeSince && !expanded) { edgeSince = 0; expand(); } }, 150); } else if (performance.now() - edgeSince > 140) { edgeSince = 0; expand(); } }
    else { edgeSince = 0; clearTimeout(edgeT); }
  }
  if (c.inside) setInteractive(hitTest(c.x, c.y)); else if (!op) setInteractive(false);
});
let lastWind = null;
addEventListener('mousemove', e => {
  if (e.buttons === 0 && R.dragOutUntil) R.dragOutUntil = 0;
  setInteractive(hitTest(e.clientX, e.clientY));
  if (op || !expanded) { lastWind = null; return; }
  const t = performance.now();
  const q = VE(e);
  if (lastWind && q.y < zoneBottom() + 20) {
    const vx = (q.x - lastWind.x) / (Math.max(8, t - lastWind.t) / 1000);
    let hit = false;
    for (const p of R.phys.values()) {
      if (Math.abs(q.x - p.cx) < p.w / 2 + 6 && q.y > p.cy && q.y < p.cy + p.h + 12) { p.om += clamp(vx, -2500, 2500) * .00016; hit = true; }
    }
    if (hit) kick();
  }
  lastWind = { x: q.x, t };
});
api.on('toggle', force => { if (expanded && !force) collapse(); else expand(3500); });

/* ---------- peek ---------- */
let peekT = 0, peekFor = null;
hangsEl.addEventListener('mouseover', e => {
  const h = e.target.closest('.hang'); if (!h || op) return;
  if (peekFor === h.dataset.id) return;
  peekFor = h.dataset.id; clearTimeout(peekT); peek.hidden = true;
  peekT = setTimeout(() => showPeek(R.phys.get(h.dataset.id)), 420);
});
hangsEl.addEventListener('mouseout', e => { const h = e.target.closest('.hang'); if (h && !h.contains(e.relatedTarget)) hidePeek(); });
/* while the pointer rests on a ghost its countdown waits */
hangsEl.addEventListener('mouseover', e => {
  const h = e.target.closest('.hang.ghost'); if (!h || h.classList.contains('ghost-hold')) return;
  h.classList.add('ghost-hold'); api.send('pend-hold', h.dataset.id, true);
});
hangsEl.addEventListener('mouseout', e => {
  const h = e.target.closest('.hang.ghost-hold'); if (!h || h.contains(e.relatedTarget)) return;
  h.classList.remove('ghost-hold'); api.send('pend-hold', h.dataset.id, false);
});
function hidePeek() { clearTimeout(peekT); peekFor = null; if (!peek.hidden) { peek.hidden = true; peek.innerHTML = ''; } }
function placePeek(p) {
  if (peek.hidden || !p) return;
  const r = p.thumb.getBoundingClientRect(), pw = peek.offsetWidth, ph = peek.offsetHeight;
  let x, y;
  if (EDGE === 'left') { x = r.right + 12; y = r.top + r.height / 2 - ph / 2; }
  else if (EDGE === 'right') { x = r.left - pw - 12; y = r.top + r.height / 2 - ph / 2; }
  else { x = r.left + r.width / 2 - pw / 2; y = r.bottom + 12; }
  peek.style.translate = `${Math.round(clamp(x, 8, innerWidth - pw - 8))}px ${Math.round(clamp(y, 8, innerHeight - ph - 8))}px`;
}
function showPeek(p) {
  if (!p || op || !expanded || !p.el.isConnected) return;
  const it = byId(p.id); if (!it) return;
  let h = '';
  if (it.missing) h = '<div class="pk-file"><b></b><span>原文件找不到了</span></div>';
  else switch (it.type) {
    case 'image': h = '<img alt="">'; break;
    case 'pdf': h = '<div class="pk-paper"><canvas></canvas></div>'; break;
    case 'video': h = '<video muted autoplay loop playsinline></video>'; break;
    case 'note': h = `<div class="pk-note" style="background:var(--n${it.color || 1})"></div>`; break;
    case 'text': h = '<pre class="pk-text"></pre>'; break;
    default: h = '<div class="pk-file"><b></b><span></span></div>';
  }
  peek.innerHTML = h + '<div class="pk-hint">单击复制 · 双击钉到屏幕 · 往下拖进别的软件</div>';
  const b = peek.querySelector('.pk-file b'), s = peek.querySelector('.pk-file span');
  if (b) b.textContent = it.type === 'link' ? hostOf(it.url) : it.title;
  if (s && !it.missing) s.textContent = it.type === 'link' ? it.url : [fmtSize(it.size), it.isDir ? '文件夹' : ''].filter(Boolean).join(' · ') || it.title;
  if (it.type === 'note') peek.querySelector('.pk-note').textContent = it.text || '';
  if (it.type === 'text' && !it.missing) api.invoke('read-text', it.id, 3000).then(t => { const pre = peek.querySelector('.pk-text'); if (pre) { pre.textContent = t; placePeek(p); } });
  if (it.type === 'pdf' && !it.missing) getPdf(it.id).then(doc => renderPage(doc, 1, 300, 300, devicePixelRatio || 1)).then(r => { const cv = peek.querySelector('canvas'); if (!cv) return; paint(cv, r); cv.style.width = r.cssW + 'px'; cv.style.height = r.cssH + 'px'; placePeek(p); }).catch(() => {});
  const media = peek.querySelector('img, video');
  if (media) { media.addEventListener(media.tagName === 'IMG' ? 'load' : 'loadedmetadata', () => placePeek(p)); media.src = it.src; }
  peek.hidden = false; placePeek(p);
}

/* ---------- pointer interactions ---------- */
function thumbRect(p) { const r = p.thumb.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }
stage.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  hidePeek();
  if (e.target.closest('.hang-x, .rope-end')) return;
  const h = e.target.closest('.hang');
  const q = VE(e);
  if (h) { op = { type: 'rope', pid: e.pointerId, id: h.dataset.id, sx: q.x, sy: q.y, lx: q.x, ly: q.y, moved: false, onClip: !!e.target.closest('.clip') }; return; }
  if (e.target === ropeHit) { e.preventDefault(); op = { type: 'pluck', pid: e.pointerId, sx: q.x, sy: q.y, moved: false }; }
});
let pending = null, rafMove = 0;
addEventListener('pointermove', e => {
  if (!op || e.pointerId !== op.pid) return;
  const q = VE(e); op.lx = q.x; op.ly = q.y;
  pending = e; if (!rafMove) rafMove = requestAnimationFrame(processMove);
});
function processMove() {
  rafMove = 0; const e = pending; pending = null; if (!e || !op) return;
  const q = VE(e), dx = q.x - op.sx, dy = q.y - op.sy;
  if (!op.moved && Math.hypot(dx, dy) < 4) return;
  const first = !op.moved; op.moved = true;
  if (op.type === 'pluck') { R.plucking = true; R.px = q.x; R.pa = clamp(q.y - ropeBaseY(q.x), -40, 150); kick(); return; }
  if (op.type === 'rope') {
    const p = R.phys.get(op.id); if (!p) return;
    if (first) { clearTimeout(R.clickT); p.drag = { x: p.cx, y: p.cy }; p.el.classList.add('dragging'); layoutRope(); }
    p.drag.x = q.x; p.drag.y = q.y - 10;
    const inRope = q.y < zoneBottom() + 10;
    setHot(inRope ? q.x : null);
    kick();
  }
}
/* dragging a card downward hands it to Windows as a real file: drop it into WeChat, a folder or the desktop */
hangsEl.addEventListener('dragstart', e => {
  e.preventDefault();
  if (!op || op.type !== 'rope') return;
  const dx = op.lx - op.sx, dy = op.ly - op.sy;
  if (dy > 2 && dy >= Math.abs(dx) * .8) {
    const id = op.id; cancelRopeDrag(); op = null; setHot(null);
    R.dragOutUntil = performance.now() + 30000;
    api.send('start-drag', id);
  }
});
function cancelRopeDrag() {
  const p = op && R.phys.get(op.id);
  if (p && p.drag) { const px = p.drag.x, py = p.drag.y; p.drag = null; p.el.classList.remove('dragging'); layoutRope(true); p.ox = px - p.tx; p.oy = py - ropeY(px); kick(); }
}
function finish(e) {
  if (!op || e.pointerId !== op.pid) return;
  if (pending) processMove();
  const o = op; op = null;
  if (o.type === 'pluck') { R.plucking = false; for (const p of R.phys.values()) p.om += (Math.random() - .5) * Math.min(2.4, Math.abs(R.pa) / 28); kick(); return; }
  if (o.type !== 'rope') return;
  const p = R.phys.get(o.id), it = byId(o.id);
  if (!o.moved) {
    if (e.type !== 'pointerup' || !p) return;
    if (!o.onClip && keepGhost(p)) { clearTimeout(R.clickT); toast('留下了'); return; }
    if (o.onClip) { api.send('pin', o.id, thumbRect(p)); return; }
    clearTimeout(R.clickT);
    R.clickT = setTimeout(async () => { const r = await api.invoke('copy', o.id); if (r && r.msg) toast(r.msg); if (r && r.ok) burst(p.cx, p.cy + p.h * .5, 7); p.el.classList.remove('flash'); void p.el.offsetWidth; p.el.classList.add('flash'); }, 250);
    return;
  }
  if (!p || !it || !p.drag) return;
  if (it.pending) keepGhost(p);
  p.el.classList.remove('dragging');
  const hot = R.hot, ghostX = R.ghostX, px = p.drag.x, py = p.drag.y;
  R.hot = null; stage.classList.remove('hot');
  if (hot != null || e.type !== 'pointerup') {
    if (hot != null && ghostX != null) it.rx = ghostX / R.W;
    p.drag = null; layoutRope(true); p.ox = px - p.tx; p.oy = py - ropeY(px); kick();
    if (hot != null) savePositions();
  } else {
    p.drag = null;
    api.send('pin', o.id, { x: e.clientX, y: e.clientY - 40, width: 0, height: 0 });
  }
}
addEventListener('pointerup', finish);
addEventListener('pointercancel', finish);
hangsEl.addEventListener('dblclick', e => {
  const h = e.target.closest('.hang'); if (!h || e.target.closest('.hang-x, .clip')) return;
  clearTimeout(R.clickT);
  const p = R.phys.get(h.dataset.id); if (p) api.send('pin', p.id, thumbRect(p));
});
hangsEl.addEventListener('click', e => {
  const x = e.target.closest('.hang-x'); if (!x) return;
  api.send('delete', x.closest('.hang').dataset.id);
  toast('已删除', '撤销', () => api.invoke('undo-delete'));
});
hangsEl.addEventListener('contextmenu', async e => {
  const h = e.target.closest('.hang'); if (!h) return;
  e.preventDefault(); hidePeek(); menuOpen = true;
  try { await api.invoke('card-menu', h.dataset.id); } finally { menuOpen = false; }
});
menuBtn.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); hidePeek(); togglePanel(); api.send('log', 'menu press -> panel ' + (panel.hidden ? 'closed' : 'open')); });
menuBtn.addEventListener('click', e => e.preventDefault());
api.on('open-panel', () => { expand(4000); togglePanel(true); });
/* report renderer errors to the main process so they land in pegline-debug.log */
addEventListener('error', e => api.send('log', 'rope error: ' + (e.message || e) + ' @' + (e.lineno || '')));
addEventListener('unhandledrejection', e => api.send('log', 'rope rejection: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
tab.addEventListener('click', () => expand(3000));
addEventListener('wheel', e => {
  if (!expanded || !R.maxScroll || VE(e).y > zoneBottom() + 10) return;
  const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * (e.deltaMode === 1 ? 16 : 1);
  const old = R.scroll; R.scroll = clamp(R.scroll + d, 0, R.maxScroll);
  layoutRope(true); for (const p of R.phys.values()) p.om += (R.scroll - old) * .006;
  hidePeek(); kick();
}, { passive: true });

/* files dropped onto the rope from Explorer */
addEventListener('dragover', e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
addEventListener('drop', e => {
  e.preventDefault();
  if (R.dragOutUntil > performance.now()) { R.dragOutUntil = 0; return; }
  const dt = e.dataTransfer; if (!dt) return;
  const paths = [...(dt.files || [])].map(f => api.pathForFile(f)).filter(Boolean);
  if (paths.length) { api.invoke('add-paths', paths, VE(e).x / R.W); return; }
  const t = dt.getData('text/uri-list') || dt.getData('text/plain');
  if (t && t.trim()) api.invoke('add-text', t.trim());
});

/* ---------- toasts sit just under the rope ---------- */
function placeToasts() {
  const t = $('#toasts'), z = Math.round(zoneBottom() + 14);
  t.style.top = t.style.left = t.style.right = '';
  if (EDGE === 'left') { t.style.left = z + 'px'; t.style.top = '50%'; }
  else if (EDGE === 'right') { t.style.right = z + 'px'; t.style.top = '50%'; }
  else t.style.top = z + 'px';
}
/* rotate the stage onto the chosen edge */
function applyEdge() {
  const e = (settings.edge === 'left' || settings.edge === 'right') ? settings.edge : 'top';
  EDGE = e; document.body.dataset.edge = e;
  const L = ropeLen(), D = e === 'top' ? innerHeight : innerWidth;
  stage.style.width = L + 'px'; stage.style.height = D + 'px';
  stage.style.transform = e === 'left' ? `translate(0px, ${L}px) rotate(-90deg)` : e === 'right' ? `translate(${innerWidth}px, 0px) rotate(90deg)` : '';
  for (const p of R.phys.values()) p.tv.style.aspectRatio = thumbAspect(byId(p.id) || {}).toFixed(3);
  R.W = L;
}

/* ---------- wiring to the main process ---------- */
api.on('rope', data => {
  items = data.items || [];
  if (data.settings) { const old = settings.skin + '|' + settings.mascot; settings = data.settings; applySkin(settings); if (old !== settings.skin + '|' + settings.mascot) setupMascot(); }
  renderRope(data.from, data.added);
  if (data.added && data.added.length && data.reveal) {
    const ghostLeft = Math.max(0, ...data.added.map(id => { const it = byId(id); return it && it.pending ? it.pending - Date.now() + 600 : 0; }));
    expand(Math.max(2600, ghostLeft));
    data.added.forEach(id => { const p = R.phys.get(id); if (p) { p.el.classList.remove('flash'); void p.el.offsetWidth; p.el.classList.add('flash'); if (M.kind === 'sweet' || M.kind === 'fizz') setTimeout(() => burst(p.cx, p.cy, 7), 260); } });
  }
});
api.on('settings', s => { const edgeChanged = (s.edge || 'top') !== EDGE; settings = s; applySkin(s); if (edgeChanged) { applyEdge(); M.kind = '_'; } setupMascot(); renderPanel(); requestAnimationFrame(() => { layoutRope(true); for (const p of R.phys.values()) p.om += (Math.random() - .5) * 1.4; R.sv += 30; kick(); }); });
api.on('toast', msg => toast(msg));
addEventListener('resize', () => { applyEdge(); layoutRope(true); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
api.invoke('init').then(d => { items = d.items || []; settings = d.settings || {}; applySkin(settings); applyEdge(); setupMascot(); renderRope(); });

/* ======================================================================
   Mascots: something small and alive on the rope.
   acrobat (白昼/蓝图) · sweet charms + hearts (草莓甜心) · fizz bubbles (汽水糖) · mech (赛博机甲) · sparrows (软木板) · fireflies (夜航)
   ====================================================================== */
const mascotsEl = $('#mascots');
const MASCOT_OF = { day: 'acro', blueprint: 'acro', berry: 'sweet', soda: 'fizz', mecha: 'robot', cork: 'birds', night: 'flies' };
const SVG_ACRO = `<g class="body-bob">
  <g class="pole"><line class="m-line" x1="-30" y1="-30" x2="30" y2="-30"/><circle class="m-acc" cx="-30" cy="-30" r="3.2"/><circle class="m-acc" cx="30" cy="-30" r="3.2"/></g>
  <path class="m-line" d="M0 -36 L-10 -30 M0 -36 L10 -30"/>
  <path class="m-line" d="M0 -42 L0 -20"/>
  <circle class="m-fill" cx="0" cy="-48" r="6"/>
  <path class="m-acc-line" d="M-5 -53 Q0 -60 5 -53"/>
  <g class="leg legA"><path class="m-line" d="M0 -20 L-3 -1"/></g>
  <g class="leg legB"><path class="m-line" d="M0 -20 L3 -1"/></g>
</g>`;
/* sweet skin: glossy jelly charms dangling from the ribbon, hearts drifting up, sparkles twinkling */
const HEART_D = 'M0 5 C0 1.6 -2.6 -1 -5.6 -1 C-9.2 -1 -11 2 -11 4.8 C-11 9.6 -4.6 13.4 0 17.6 C4.6 13.4 11 9.6 11 4.8 C11 2 9.2 -1 5.6 -1 C2.6 -1 0 1.6 0 5 Z';
const SPARK_D = 'M0 -7 C.8 -2 2 -.8 7 0 C2 .8 .8 2 0 7 C-.8 2 -2 .8 -7 0 C-2 -.8 -.8 -2 0 -7 Z';
const SWEET_DEFS = `<svg width="0" height="0" style="position:absolute"><defs>
  <linearGradient id="gHeart" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb3cf"/><stop offset=".55" stop-color="#ff6fa5"/><stop offset="1" stop-color="#f0457f"/></linearGradient>
  <linearGradient id="gLilac" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e6d4ff"/><stop offset="1" stop-color="#a57cff"/></linearGradient>
  <linearGradient id="gBerry" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff7a8c"/><stop offset="1" stop-color="#e2264d"/></linearGradient>
  <linearGradient id="gStar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff2a8"/><stop offset="1" stop-color="#ffc23d"/></linearGradient>
  <radialGradient id="gPearl" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff"/><stop offset=".6" stop-color="#ffeaf3"/><stop offset="1" stop-color="#f6c6da"/></radialGradient>
</defs></svg>`;
const shine = (x, y, r = 2.4) => `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * .6}" fill="#fff" opacity=".85" transform="rotate(-35 ${x} ${y})"/><circle cx="${x + r * 1.5}" cy="${y - r * .3}" r="${r * .32}" fill="#fff" opacity=".8"/>`;
const CHARM = {
  heart: L => `<g transform="translate(0 ${L + 1}) scale(1.05)"><path d="${HEART_D}" fill="url(#gHeart)" stroke="#e0457f" stroke-width="1.2"/>${shine(-5.2, 3.4)}</g>`,
  berry: L => `<g transform="translate(0 ${L + 3}) scale(1.2)"><path d="M0 16 C-7.5 13 -9.4 6 -8.6 2.4 C-8 -.4 -4 -.6 0 .6 C4 -.6 8 -.4 8.6 2.4 C9.4 6 7.5 13 0 16 Z" fill="url(#gBerry)" stroke="#c81f45" stroke-width="1"/>
    <g fill="#ffe7a3"><ellipse cx="-4" cy="5" rx=".7" ry="1"/><ellipse cx="0" cy="4" rx=".7" ry="1"/><ellipse cx="4" cy="5" rx=".7" ry="1"/><ellipse cx="-2.2" cy="9" rx=".7" ry="1"/><ellipse cx="2.2" cy="9" rx=".7" ry="1"/><ellipse cx="0" cy="12.6" rx=".7" ry="1"/></g>
    <path d="M-6.5 .8 L-3 -2.6 L0 -.4 L3 -2.6 L6.5 .8 L2.4 2 L0 3.4 L-2.4 2 Z" fill="#4fcf7a" stroke="#2fa85b" stroke-width=".8" stroke-linejoin="round"/>${shine(-4.4, 4.4, 1.8)}</g>`,
  star: L => `<g transform="translate(0 ${L + 1}) scale(1.12)"><path d="M0 0 L3 5.6 L9.4 6.6 L4.8 11 L5.9 17.4 L0 14.4 L-5.9 17.4 L-4.8 11 L-9.4 6.6 L-3 5.6 Z" fill="url(#gStar)" stroke="#f0a91f" stroke-width="1.6" stroke-linejoin="round"/>${shine(-2.8, 7, 1.7)}</g>`,
  lilac: L => `<g transform="translate(0 ${L + 1}) scale(.82)"><path d="${HEART_D}" fill="url(#gLilac)" stroke="#8d62f0" stroke-width="1.4"/>${shine(-5.2, 3.4)}</g>`,
  pearl: L => `<circle cx="0" cy="${L + 5}" r="5" fill="url(#gPearl)" stroke="#f0a9c6" stroke-width=".9"/>`,
};
const CHARM_SET = [['heart', 13, .14], ['pearl', 7, .3], ['berry', 10, .46], ['star', 15, .64], ['pearl', 9, .78], ['lilac', 11, .9]];
const charmSvg = (kind, L) => `<g class="charm-sw"><line x1="0" y1="0" x2="0" y2="${L + 1}" stroke="#ff9cc2" stroke-width="1.1"/><circle cx="0" cy="0" r="1.8" fill="#fff" stroke="#ff9cc2" stroke-width="1"/>${CHARM[kind](L)}</g>`;
const SWEET_COLORS = ['#ff6fa5', '#ff9cc2', '#ffb3cf', '#c9a7ff', '#ffa98a', '#ff4f8b'];
const FIZZ_COLORS = ['#ff3d8b', '#ffd84a', '#3ad0ff', '#7c5cff', '#2fd88a', '#ff8a3d'];
const pick = a => a[Math.floor(Math.random() * a.length)];
function heartEl(size, color, outline) {
  return `<svg viewBox="-12 -2 24 21" width="${size}" height="${size * .875}"><path d="${HEART_D}" fill="${outline ? 'none' : color}" stroke="${outline ? color : '#fff'}" stroke-width="${outline ? 2.2 : 1}" stroke-opacity="${outline ? 1 : .7}"/>${outline ? '' : shine(-5.2, 3.4, 2.2)}</svg>`;
}
const sparkEl = (size, color) => `<svg viewBox="-8 -8 16 16" width="${size}" height="${size}"><path d="${SPARK_D}" fill="${color}"/></svg>`;
/* one floating particle in rope space; it animates itself and cleans up */
function particle(cls, x, y, html, { dx = 0, dy = -30, dur = 2.2, rot = 0, scale = 1 } = {}) {
  if (mascotsEl.childElementCount > 90) return null;
  const el = document.createElement('div'); el.className = 'sw-p ' + cls;
  el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  el.style.setProperty('--dx', dx.toFixed(1) + 'px'); el.style.setProperty('--dy', dy.toFixed(1) + 'px');
  el.style.setProperty('--rot', rot.toFixed(0) + 'deg'); el.style.setProperty('--s', scale); el.style.setProperty('--dur', dur + 's');
  el.innerHTML = `<div class="sw-in">${html}</div>`;
  mascotsEl.appendChild(el); el.addEventListener('animationend', ev => { if (ev.target === el) el.remove(); });
  return el;
}
function riseHeart(x, y, big) {
  const outline = Math.random() < .28, size = big ? 13 + Math.random() * 7 : 8 + Math.random() * 8;
  return particle('rise', x, y, Math.random() < .18 ? sparkEl(size, '#ffd36e') : heartEl(size, pick(SWEET_COLORS), outline),
    { dx: (Math.random() - .5) * 26, dy: -(ANCHOR - 4 + Math.random() * 16), dur: 2 + Math.random() * 1.4, rot: (Math.random() - .5) * 50 });
}
function riseBubble(x, y) {
  const r = 4 + Math.random() * 9, c = pick(FIZZ_COLORS);
  return particle('rise bub', x, y, `<i style="width:${r.toFixed(1)}px;height:${r.toFixed(1)}px;--c:${c}"></i>`,
    { dx: (Math.random() - .5) * 18, dy: -(ANCHOR + Math.random() * 14), dur: 1.4 + Math.random() * 1.2 });
}
const SVG_ROBOT = `<g class="body-bob m-glow">
  <path class="flame m-acc" d="M-6 0 L-3 9 L0 2 L3 9 L6 0 Z" style="transform-box:fill-box;transform-origin:top"/>
  <g class="leg legA"><rect class="m-fill" x="-9" y="-13" width="5" height="12" rx="1"/><rect class="m-fill" x="-11" y="-3" width="9" height="3" rx="1"/></g>
  <g class="leg legB"><rect class="m-fill" x="4" y="-13" width="5" height="12" rx="1"/><rect class="m-fill" x="2" y="-3" width="9" height="3" rx="1"/></g>
  <path class="m-fill" d="M-14 -34 L10 -34 L14 -30 L14 -14 L-14 -14 Z"/>
  <rect x="-10" y="-31" width="20" height="8" rx="4" fill="#02060c" stroke="var(--m-line)" stroke-width="1.4"/>
  <rect class="scan" x="-3" y="-28.6" width="6" height="3.2" rx="1.6" fill="var(--m-line)"/>
  <path class="m-line" style="stroke-width:1.6" d="M-9 -19 L-3 -19 M3 -19 L9 -19"/>
  <path class="m-line" style="stroke-width:1.8" d="M0 -34 L0 -42"/>
  <circle class="ant m-acc" cx="0" cy="-44" r="2.6"/>
</g>`;
const SVG_BIRD = `<g>
  <path class="m-fill" d="M-9 -7 L-15 -10 L-13 -4 Z"/>
  <ellipse class="m-fill" cx="-1" cy="-7" rx="8.5" ry="6.5"/>
  <ellipse class="m-belly" cx="1" cy="-5" rx="5.5" ry="4" style="stroke:none"/>
  <circle class="m-fill" cx="6" cy="-12" r="4.6"/>
  <circle class="m-dark" cx="7.4" cy="-12.8" r="1.1"/>
  <path class="m-acc" d="M10 -12.6 L14 -11.6 L10 -10.4 Z"/>
  <path class="wing m-fill" d="M-6 -9 Q-1 -20 5 -10 Z"/>
  <g class="feet"><path class="m-line" style="stroke-width:1.4" d="M-2 -1 L-2 1 M2 -1 L2 1"/></g>
</g>`;
document.body.insertAdjacentHTML('beforeend', SWEET_DEFS);
const M = { kind: null, nodes: [], last: 0, running: false, dentX: 0, dentA: 0, t: 0 };
function mascotDent(x) { if (!M.dentA) return 0; const d = (x - M.dentX) / 46; return M.dentA * Math.exp(-d * d); }
function makeSvg(cls, inner, vb) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'mascot ' + cls);
  svg.setAttribute('width', vb[2]); svg.setAttribute('height', vb[3]);
  svg.setAttribute('viewBox', vb.join(' '));
  svg.innerHTML = `<g class="flip">${inner}</g>`;
  mascotsEl.appendChild(svg);
  return svg;
}
function setupMascot() {
  const kind = settings.mascot === false ? null : (MASCOT_OF[settings.skin || 'cork'] || null);
  if (kind === M.kind && mascotsEl.childElementCount) return;
  M.kind = kind; M.nodes = []; M.dentA = 0; mascotsEl.innerHTML = '';
  ANCHOR = kind === 'acro' || kind === 'robot' ? 46 : kind === 'sweet' || kind === 'fizz' ? 34 : kind === 'birds' ? 24 : 20; /* never let the rope (and the ⋯ button) touch the screen edge */
  M.spawnAt = 0; M.trail = null;
  const W = ropeLen();
  if (kind === 'acro' || kind === 'robot') {
    const svg = makeSvg(kind + ' walking', kind === 'acro' ? SVG_ACRO : SVG_ROBOT, [-40, -66, 80, 80]);
    const n = { svg, x: W * .25, dir: 1, v: kind === 'robot' ? 44 : 26, state: 'walk', until: 0, hop: 0, hopH: 0, hopT: 0, hopDur: .55 };
    svg.addEventListener('pointerdown', e => { e.stopPropagation(); jump(n, 46); burst(n.x, ropeY(n.x) - 30, 8); R.px = n.x; R.pv += 220; kick(); });
    M.nodes.push(n);
  } else if (kind === 'sweet') {
    for (const [ck, L, f] of CHARM_SET) {
      const svg = makeSvg('charm', charmSvg(ck, L), [-14, -3, 28, L + 28]);
      const n = { svg, home: f, x: W * f, th: 0, om: 0, ph: Math.random() * 6.28, vis: 1 };
      svg.addEventListener('pointerdown', e => {
        e.stopPropagation(); n.om += (Math.random() < .5 ? -1 : 1) * 9;
        for (let i = 0; i < 7; i++) riseHeart(n.x + (Math.random() - .5) * 16, ropeY(n.x) + L, true);
        burst(n.x, ropeY(n.x) + L, 6); R.px = n.x; R.pv += 120; kick();
      });
      M.nodes.push(n);
    }
    for (let i = 0; i < 6; i++) {
      const el = document.createElement('div'); el.className = 'sw-tw'; el.innerHTML = sparkEl(9 + Math.random() * 5, i % 3 ? '#ffd36e' : '#ffb3cf');
      el.style.animationDelay = (-Math.random() * 3) + 's'; el.style.animationDuration = (2.4 + Math.random() * 1.6) + 's';
      const place = () => { el._x = 30 + Math.random() * Math.max(60, ropeLen() - 110); el._o = -6 - Math.random() * 22; };
      place(); el.addEventListener('animationiteration', place);
      mascotsEl.appendChild(el); M.nodes.push({ tw: el });
    }
  } else if (kind === 'birds') {
    for (let i = 0; i < 3; i++) {
      const svg = makeSvg('bird', SVG_BIRD, [-16, -22, 32, 26]);
      const n = { svg, x: W * (.2 + i * .27) + Math.random() * 60, dir: Math.random() < .5 ? -1 : 1, state: 'perch', until: performance.now() + 1500 + Math.random() * 3000, fy: 0, vx: 0, vy: 0 };
      svg.addEventListener('pointerdown', e => { e.stopPropagation(); flyAway(n, VE(e).x); });
      M.nodes.push(n);
    }
  } else if (kind === 'flies') {
    for (let i = 0; i < 8; i++) {
      const el = document.createElement('div'); el.className = 'fly-dot'; el.style.animationDelay = (-Math.random() * 2.4) + 's';
      mascotsEl.appendChild(el);
      M.nodes.push({ el, base: Math.random() * W, ph: Math.random() * 6.28, sp: 6 + Math.random() * 10 });
    }
  }
  layoutRope(true); kickMascot();
}
function kickMascot() { if (!M.running && M.kind && expanded && !document.hidden) { M.running = true; M.last = performance.now(); requestAnimationFrame(mascotFrame); } }
function jump(n, h) { if (n.hop) return; n.hop = 1; n.hopT = 0; n.hopH = h; n.hopDur = h > 30 ? .7 : .5; n.svg.classList.add('hop'); }
function clipXs() { const xs = []; for (const p of R.phys.values()) if (!p.drag) xs.push(p.cx); return xs; }
function mascotFrame(now) {
  if (!M.kind || !expanded || document.hidden) { M.running = false; M.dentA = 0; return; }
  const dt = clamp((now - M.last) / 1000, 0, 1 / 20); M.last = now; M.t += dt;
  const W = R.W, minX = 26, maxX = W - 78;
  if (M.kind === 'acro' || M.kind === 'robot') {
    const n = M.nodes[0]; if (!n) { M.running = false; return; }
    if (n.state === 'idle' && now > n.until) { n.state = 'walk'; if (Math.random() < .4) n.dir *= -1; n.svg.classList.add('walking'); n.svg.classList.remove('idle'); }
    if (n.state === 'walk' || n.hop) {
      const speed = n.v * (n.hop ? 1.5 : 1);
      n.x += n.dir * speed * dt;
      if (!n.hop) for (const cx of clipXs()) { const d = (cx - n.x) * n.dir; if (d > 0 && d < 20) { jump(n, 24); break; } }
      if (n.x < minX) { n.x = minX; n.dir = 1; } else if (n.x > maxX) { n.x = maxX; n.dir = -1; }
      if (!n.hop && n.state === 'walk' && Math.random() < dt * .09) { n.state = 'idle'; n.until = now + 1400 + Math.random() * 2600; n.svg.classList.remove('walking'); n.svg.classList.add('idle'); }
    }
    let lift = 0;
    if (n.hop) {
      n.hopT += dt; const u = n.hopT / n.hopDur;
      if (u >= 1) { n.hop = 0; n.svg.classList.remove('hop'); R.px = n.x; R.pv += 60; kick(); }
      else lift = 4 * n.hopH * u * (1 - u);
    }
    M.dentX = n.x; M.dentA = n.hop ? M.dentA * .9 : 3.2;
    const y = ropeY(n.x) - lift, sl = Math.atan(ropeSlope(n.x));
    n.svg.style.transform = `translate(${(n.x - 40).toFixed(1)}px, ${(y - 66).toFixed(1)}px) rotate(${sl.toFixed(3)}rad)`;
    n.svg.style.transformOrigin = '40px 66px';
    n.svg.firstChild.setAttribute('transform', n.dir < 0 ? 'scale(-1,1)' : '');
  } else if (M.kind === 'birds') {
    const xs = clipXs();
    for (const n of M.nodes) {
      if (n.state === 'perch' && now > n.until) {
        let tx = clamp(n.x + (Math.random() < .5 ? -1 : 1) * (14 + Math.random() * 40), minX, maxX);
        for (const cx of xs) if (Math.abs(cx - tx) < 16) tx += tx < cx ? -18 : 18;
        n.dir = tx > n.x ? 1 : -1; n.state = 'hop'; n.from = n.x; n.to = clamp(tx, minX, maxX); n.k = 0;
      }
      if (n.state === 'hop') {
        n.k += dt / .35; const u = Math.min(1, n.k);
        n.x = n.from + (n.to - n.from) * u; n.fy = -4 * 12 * u * (1 - u);
        if (u >= 1) { n.state = 'perch'; n.fy = 0; n.until = now + 1200 + Math.random() * 3800; }
      }
      if (n.state === 'fly') {
        n.x += n.vx * dt; n.fy += n.vy * dt; n.vy -= 40 * dt;
        if (n.fy < -260 || n.x < -40 || n.x > W + 40) { n.state = 'away'; n.until = now + 4000 + Math.random() * 5000; n.svg.style.opacity = 0; }
      }
      if (n.state === 'away' && now > n.until) {
        n.state = 'land'; n.svg.style.opacity = 1; n.from = Math.random() < .5 ? -30 : W + 30; n.to = minX + Math.random() * (maxX - minX);
        for (const cx of xs) if (Math.abs(cx - n.to) < 16) n.to += 20;
        n.dir = n.to > n.from ? 1 : -1; n.k = 0; n.svg.classList.add('fly');
      }
      if (n.state === 'land') {
        n.k += dt / 1.4; const u = Math.min(1, n.k), e = 1 - Math.pow(1 - u, 2);
        n.x = n.from + (n.to - n.from) * e; n.fy = -160 * (1 - e) - 30 * Math.sin(u * Math.PI);
        if (u >= 1) { n.state = 'perch'; n.fy = 0; n.svg.classList.remove('fly'); n.until = now + 2000; R.px = n.x; R.pv += 30; kick(); }
      }
      if (n.state === 'away') continue;
      const y = ropeY(n.x) + n.fy;
      n.svg.style.transform = `translate(${(n.x - 16).toFixed(1)}px, ${(y - 22 + 2).toFixed(1)}px)`;
      n.svg.firstChild.setAttribute('transform', n.dir < 0 ? 'scale(-1,1)' : '');
    }
  } else if (M.kind === 'sweet' || M.kind === 'fizz') {
    /* a steady trickle of hearts (or soda bubbles) drifting up off the rope */
    if (now > M.spawnAt) {
      const x = 30 + Math.random() * Math.max(40, W - 110);
      if (M.kind === 'sweet') { riseHeart(x, ropeY(x) - 2); M.spawnAt = now + 260 + Math.random() * 420; }
      else { riseBubble(x, ropeY(x) - 2); M.spawnAt = now + 260 + Math.random() * 420; }
    }
    if (M.kind === 'sweet') {
      const blocks = []; for (const p of R.phys.values()) blocks.push([p.cx - p.w / 2 - 16, p.cx + p.w / 2 + 16]);
      const taken = [];
      for (const n of M.nodes) {
        if (n.tw) { const x = n.tw._x; n.tw.style.transform = `translate(${x.toFixed(1)}px, ${(ropeY(clamp(x, 0, W)) + n.tw._o).toFixed(1)}px)`; continue; }
        /* slide to the nearest gap between cards; hide when the rope is full */
        let tx = clamp(n.home * W, minX, maxX), ok = false;
        for (let k = 0; k < 40 && !ok; k++) {
          for (const sgn of [1, -1]) { const c = tx + sgn * k * 9; if (c < minX || c > maxX) continue; if (!blocks.some(([l, r]) => c > l && c < r)) { tx = c; ok = true; break; } }
        }
        if (ok && (taken.some(t => Math.abs(t - tx) < 24) || Math.abs(tx - n.home * W) > W * .2)) ok = false;
        if (ok) taken.push(tx); else tx = n.x;
        n.x += (tx - n.x) * Math.min(1, dt * 5);
        n.vis += ((ok ? 1 : 0) - n.vis) * Math.min(1, dt * 6);
        const acc = -26 * (n.th - Math.sin(M.t * 1.1 + n.ph) * .07) - 2.2 * n.om;
        n.om += acc * dt; n.th += n.om * dt; n.th = clamp(n.th, -1.2, 1.2);
        const y = ropeY(n.x);
        n.svg.style.transform = `translate(${(n.x - 14).toFixed(1)}px, ${(y - 3).toFixed(1)}px) rotate(${n.th.toFixed(3)}rad)`;
        n.svg.style.transformOrigin = '14px 3px'; n.svg.style.opacity = n.vis.toFixed(2);
        n.svg.style.pointerEvents = n.vis > .5 ? '' : 'none';
      }
    }
  } else if (M.kind === 'flies') {
    for (const n of M.nodes) {
      n.base += n.sp * dt; if (n.base > W + 20) n.base = -20;
      const x = n.base + Math.sin(M.t * .7 + n.ph) * 30;
      const y = ropeY(clamp(x, 0, W)) - 14 + Math.sin(M.t * 1.3 + n.ph * 2) * 12;
      n.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }
  if (!R.running) drawRope();
  requestAnimationFrame(mascotFrame);
}
function flyAway(n, fromX) {
  if (n.state === 'fly' || n.state === 'away' || n.state === 'land') return;
  n.state = 'fly'; n.dir = n.x < fromX ? -1 : 1; n.vx = n.dir * (120 + Math.random() * 80); n.vy = -140; n.svg.classList.add('fly');
  R.px = n.x; R.pv -= 60; kick();
}
/* birds startle when the pointer comes close */
addEventListener('mousemove', e => {
  if ((M.kind === 'sweet' || M.kind === 'fizz') && expanded && !op && panel.hidden) {
    const q = VE(e), now = performance.now(), t = M.trail;
    if (q.y > -10 && q.y < zoneBottom() + 30) {
      if (t && now - t.t > 40 && Math.hypot(q.x - t.x, q.y - t.y) > 10) {
        if (M.kind === 'sweet') particle('trail', q.x, q.y, Math.random() < .35 ? sparkEl(7 + Math.random() * 4, '#ffd36e') : heartEl(6 + Math.random() * 5, pick(SWEET_COLORS)),
          { dx: (Math.random() - .5) * 14, dy: 10 + Math.random() * 14, dur: .8, rot: (Math.random() - .5) * 60 });
        else particle('trail bub', q.x, q.y, `<i style="width:${(3 + Math.random() * 5).toFixed(1)}px;height:${(3 + Math.random() * 5).toFixed(1)}px;--c:${pick(FIZZ_COLORS)}"></i>`, { dx: (Math.random() - .5) * 10, dy: -12 - Math.random() * 12, dur: .8 });
        if (M.kind === 'sweet') { const vx = (q.x - t.x) / Math.max(.008, (now - t.t) / 1000); for (const n of M.nodes) if (n.svg && Math.abs(q.x - n.x) < 16 && q.y > ropeY(n.x) - 4 && q.y < ropeY(n.x) + 34) n.om += clamp(vx, -1500, 1500) * .004; }
        M.trail = { x: q.x, y: q.y, t: now };
      } else if (!t || now - t.t > 300) M.trail = { x: q.x, y: q.y, t: now };
    }
  }
  if (M.kind !== 'birds') return;
  const q = VE(e);
  for (const n of M.nodes) if (n.state === 'perch' || n.state === 'hop') { const y = ropeY(n.x) + n.fy - 8; if (Math.hypot(q.x - n.x, q.y - y) < 46) flyAway(n, q.x); }
});
/* little celebration particles: hearts for the cute skins, sparks for mecha, stars otherwise */
function burst(x, y, count) {
  const skin = settings.skin || 'cork';
  const color = getComputedStyle(document.documentElement).getPropertyValue(skin === 'mecha' ? '--accent' : '--m-accent').trim() || '#ff6fa5';
  if (skin === 'berry') count = Math.round(count * 1.6);
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div'); el.className = 'fx';
    const a = -Math.PI / 2 + (Math.random() - .5) * 2.4, d = 30 + Math.random() * 46;
    el.style.setProperty('--dx', (Math.cos(a) * d).toFixed(1) + 'px'); el.style.setProperty('--dy', (Math.sin(a) * d).toFixed(1) + 'px'); el.style.setProperty('--rot', ((Math.random() - .5) * 120).toFixed(0) + 'deg');
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.innerHTML = skin === 'berry' ? (i % 4 === 3 ? sparkEl(12, '#ffd36e') : heartEl(9 + Math.random() * 8, pick(SWEET_COLORS), Math.random() < .25))
      : skin === 'soda' ? `<svg viewBox="0 0 10 10" width="10" height="10">${i % 2 ? `<circle cx="5" cy="5" r="4" fill="${pick(FIZZ_COLORS)}" stroke="#1c1035" stroke-width="1.4"/>` : `<rect x="1" y="3" width="8" height="4" rx="2" fill="${pick(FIZZ_COLORS)}" stroke="#1c1035" stroke-width="1.4"/>`}</svg>`
      : skin === 'mecha' ? `<svg viewBox="0 0 14 14" width="14" height="14"><rect x="5" y="0" width="4" height="14" fill="${color}" style="filter:drop-shadow(0 0 3px ${color})"/></svg>`
      : `<svg viewBox="0 0 14 14" width="14" height="14"><path fill="${color}" d="M7 0 L8.8 5.2 L14 7 L8.8 8.8 L7 14 L5.2 8.8 L0 7 L5.2 5.2 Z"/></svg>`;
    stage.appendChild(el); setTimeout(() => el.remove(), 950);
  }
}
/* sweet skin: hovering a card makes a few hearts pop off its clip */
let sweetHover = null;
hangsEl.addEventListener('pointerover', e => {
  const h = e.target.closest('.hang'); if (!h || h.dataset.id === sweetHover) return;
  sweetHover = h.dataset.id;
  if (M.kind !== 'sweet' && M.kind !== 'fizz') return;
  const p = R.phys.get(h.dataset.id); if (!p || op) return;
  for (let i = 0; i < 3; i++) M.kind === 'sweet' ? riseHeart(p.cx + (Math.random() - .5) * 14, p.cy - 4, true) : riseBubble(p.cx + (Math.random() - .5) * 14, p.cy - 4);
});
hangsEl.addEventListener('pointerleave', () => { sweetHover = null; });
/* keep the mascot running whenever the rope is showing */
setInterval(() => { if (expanded) kickMascot(); }, 500);

/* ---------- skin picker panel ---------- */
const panel = $('#panel');
if (IS_MAC) panel.querySelectorAll('small, .pn-hint').forEach(el => { el.textContent = el.textContent.replace(/Ctrl\+Alt\+/g, '⌃⌥'); });
const SKIN_LIST = [
  ['berry', '草莓甜心', '丝带绳挂着爱心草莓小吊坠，爱心一直往上飘'],
  ['mecha', '赛博机甲', '霓虹数据线，LED 夹，小机甲巡逻'],
  ['cork', '软木板', '麻绳木夹拍立得，麻雀会被你吓飞'],
  ['day', '白昼', '银夹白棉绳，杂技小人走钢丝'],
  ['night', '夜航', '深色细绳，萤火虫绕着飞'],
  ['soda', '汽水糖', '糖果条纹绳，彩色泡泡咕嘟咕嘟往上冒'],
  ['blueprint', '蓝图', '钢丝细线，工程图纸风'],
];
const MINI = {
  acro: `<g transform="translate(118 36) scale(.5)"><g class="m-line"><line x1="-30" y1="-30" x2="30" y2="-30"/><path d="M0 -42 L0 -20 M0 -36 L-10 -30 M0 -36 L10 -30 M0 -20 L-3 0 M0 -20 L3 0"/></g><circle class="m-fill" cx="0" cy="-48" r="6"/></g>`,
  sweet: `<g transform="translate(106 23.5) scale(.72)">${charmSvg('heart', 9)}</g><g transform="translate(124 19) scale(.72)">${charmSvg('berry', 7)}</g><g transform="translate(141 14) scale(.66)">${charmSvg('star', 12)}</g><g transform="translate(112 4) scale(.5)"><path d="${HEART_D}" fill="#ff9cc2"/></g><g transform="translate(134 6) scale(.38)"><path d="${HEART_D}" fill="#c9a7ff"/></g>`,
  fizz: `<g fill="none" stroke-width="1.6"><circle cx="108" cy="18" r="5" stroke="#ff3d8b"/><circle cx="124" cy="8" r="3.5" stroke="#3ad0ff"/><circle cx="134" cy="22" r="6" stroke="#ffd84a"/><circle cx="146" cy="10" r="3" stroke="#7c5cff"/></g>`,
  robot: `<g transform="translate(116 37) scale(.55)">${SVG_ROBOT.replace('class="body-bob m-glow"', 'class="m-glow"')}</g>`,
  birds: `<g transform="translate(112 31) scale(.7)">${SVG_BIRD}</g><g transform="translate(130 30) scale(-.6 .6)">${SVG_BIRD}</g>`,
  flies: `<circle cx="104" cy="22" r="2" fill="var(--m-fill)" style="filter:drop-shadow(0 0 4px var(--m-glow))"/><circle cx="126" cy="32" r="2" fill="var(--m-fill)" style="filter:drop-shadow(0 0 4px var(--m-glow))"/><circle cx="140" cy="18" r="1.6" fill="var(--m-fill)" style="filter:drop-shadow(0 0 4px var(--m-glow))"/>`,
};
function renderPanel() {
  if (panel.hidden) return;
  $('#skinGrid').innerHTML = SKIN_LIST.map(([id, name, desc]) => `
    <button class="sk-card ${settings.skin === id ? 'on' : ''}" data-skin="${id}">
      <div class="pv sk-${id}"><svg viewBox="0 0 150 70" preserveAspectRatio="xMidYMid slice">
        <path class="r1" d="M-4 8 Q75 44 154 8"/><path class="r2" d="M-4 8 Q75 44 154 8"/>
        <rect class="c" x="26" y="22" width="30" height="36" rx="3"/><rect class="ci" x="30" y="26" width="22" height="22" rx="2"/>
        <rect class="c" x="66" y="27" width="28" height="32" rx="3"/><rect class="cn" x="70" y="31" width="20" height="20" rx="2"/>
        <rect class="k" x="38" y="16" width="5" height="11" rx="1.5"/><rect class="k" x="77" y="21" width="5" height="11" rx="1.5"/>
        ${MINI[MASCOT_OF[id]] || ''}
      </svg></div>
      <span class="sk-name">${name}</span><span class="sk-desc">${desc}</span>
    </button>`).join('');
  const st = settings, img = st.watchImages !== false, shots = !!st.screenshotsOnly, files = st.watchFiles !== false, text = st.watchText !== false;
  const mode = img && !shots && files && text ? 'auto' : img && shots && !files && !text ? 'shots' : !img && !files && !text ? 'manual' : '';
  panel.querySelectorAll('#modeSeg [data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  const flags = { watchImages: img, screenshotsOnly: shots, watchFiles: files, watchText: text };
  panel.querySelectorAll('[data-kind]').forEach(b => { b.setAttribute('aria-pressed', String(flags[b.dataset.kind])); b.disabled = b.dataset.kind === 'screenshotsOnly' && !img; });
  panel.querySelectorAll('#edgeSeg [data-edge]').forEach(b => b.classList.toggle('on', b.dataset.edge === EDGE));
  panel.querySelector('[data-set="mascot"]').setAttribute('aria-pressed', String(settings.mascot !== false));
  panel.querySelector('[data-set="autoHide"]').setAttribute('aria-pressed', String(settings.autoHide !== false));
  panel.querySelector('[data-set="ghost"]').setAttribute('aria-pressed', String(!!settings.ghost));
  $('#ghostSeg').hidden = !settings.ghost;
  panel.querySelectorAll('#ghostSeg [data-secs]').forEach(b => b.classList.toggle('on', +b.dataset.secs === (settings.ghostSecs || 8)));
}
function togglePanel(force) {
  const open = force != null ? force : panel.hidden;
  if (!open) { panel.hidden = true; return; }
  panel.hidden = false; renderPanel();
  const pw = panel.offsetWidth, ph = panel.offsetHeight;
  let left, top;
  if (EDGE === 'left') { left = ANCHOR + 40; top = 12; }
  else if (EDGE === 'right') { left = innerWidth - pw - ANCHOR - 40; top = 12; }
  else { left = innerWidth - pw - 14; top = ropeY(R.W - 36) + 20; }
  panel.style.left = clamp(left, 8, Math.max(8, innerWidth - pw - 8)) + 'px';
  panel.style.top = clamp(top, 8, Math.max(8, innerHeight - ph - 8)) + 'px';
  expand(1000);
}
panel.addEventListener('click', async e => {
  const mb = e.target.closest('#modeSeg [data-mode]');
  if (mb) {
    const presets = { auto: { watchImages: true, screenshotsOnly: false, watchFiles: true, watchText: true }, shots: { watchImages: true, screenshotsOnly: true, watchFiles: false, watchText: false }, manual: { watchImages: false, screenshotsOnly: false, watchFiles: false, watchText: false } };
    api.send('set-settings', presets[mb.dataset.mode]);
    toast({ auto: '全自动：截图、文件、文字都会自己挂上来', shots: '只收截图：复制的文字和文件不会再挂上来', manual: `只靠拖拽：想挂什么就拖上来，或按 ${KEYS.v}` }[mb.dataset.mode]);
    return;
  }
  const kb = e.target.closest('.pn-kinds [data-kind]');
  if (kb) { const k = kb.dataset.kind, cur = k === 'screenshotsOnly' ? !!settings[k] : settings[k] !== false; api.send('set-setting', k, !cur); return; }
  const gs = e.target.closest('#ghostSeg [data-secs]');
  if (gs) { api.send('set-setting', 'ghostSecs', +gs.dataset.secs); return; }
  const eb = e.target.closest('#edgeSeg [data-edge]');
  if (eb) { api.send('set-setting', 'edge', eb.dataset.edge); togglePanel(false); return; }
  const card = e.target.closest('.sk-card[data-skin]');
  if (card) { api.send('set-setting', 'skin', card.dataset.skin); return; }
  const row = e.target.closest('.pn-row[data-set]');
  if (row) { const k = row.dataset.set; api.send('set-setting', k, !(settings[k] !== false)); return; }
  if (e.target.closest('#panelX')) { togglePanel(false); return; }
  if (e.target.closest('#quitBtn')) { api.send('quit'); return; }
  if (e.target.closest('#moreBtn')) { togglePanel(false); menuOpen = true; try { await api.invoke('main-menu'); } finally { menuOpen = false; } }
});
addEventListener('pointerdown', e => { if (!panel.hidden && !e.target.closest('#panel, #menuBtn')) togglePanel(false); }, true);

/* close the picker if the pointer wanders off to other apps for a while */
let awaySince = 0;
setInterval(() => {
  if (panel.hidden) { awaySince = 0; return; }
  if (cur.inside) { awaySince = 0; return; }
  if (!awaySince) awaySince = performance.now();
  if (performance.now() - awaySince > 2500) { awaySince = 0; togglePanel(false); }
}, 300);

/* the empty-rope hint follows the collection mode, and doubles as a drop target */
function updateEmptyHint() {
  const st = settings, img = st.watchImages !== false, files = st.watchFiles !== false, text = st.watchText !== false;
  $('#empty').textContent = !img && !files && !text ? `把文件拖到这里，或按 ${KEYS.v} 挂上剪贴板`
    : st.screenshotsOnly && !files && !text ? `截个图（${KEYS.shot}），它就挂上来了`
    : '绳子空着：截个图、复制个文件，它就挂上来了';
}
api.on('settings', () => updateEmptyHint());
api.on('rope', () => updateEmptyHint());

/* pointer-tracked 3D tilt + glare on the hovered card */
hangsEl.addEventListener('mousemove', e => {
  const t = e.target.closest('.thumb'); if (!t || op) return;
  const r = t.getBoundingClientRect();
  let mx = clamp((e.clientX - r.left) / r.width, 0, 1), my = clamp((e.clientY - r.top) / r.height, 0, 1);
  if (EDGE === 'left') [mx, my] = [my, 1 - mx]; else if (EDGE === 'right') [mx, my] = [1 - my, mx];
  t.classList.add('tilting');
  t.style.setProperty('--mx', (mx * 100).toFixed(1) + '%'); t.style.setProperty('--my', (my * 100).toFixed(1) + '%');
  t.style.setProperty('--rx', ((mx - .5) * 22).toFixed(2) + 'deg'); t.style.setProperty('--ry', ((.5 - my) * 22).toFixed(2) + 'deg');
  t.style.setProperty('--mxdeg', (90 + (mx - .5) * 80).toFixed(0) + 'deg'); t.style.setProperty('--o', '1');
});
hangsEl.addEventListener('mouseout', e => {
  const t = e.target.closest('.thumb'); if (!t || t.contains(e.relatedTarget)) return;
  t.classList.remove('tilting'); t.style.setProperty('--rx', '0deg'); t.style.setProperty('--ry', '0deg'); t.style.setProperty('--o', '0');
});
