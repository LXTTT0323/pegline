'use strict';
/* A single pinned card window. */
const frame = $('#frame');
$('#copyBtn').innerHTML = ic('copy');
$('#copyBtn').title = '复制  ' + KEYS.copy;
$('#backBtn').innerHTML = ic('x');
let item = null, page = 1, pages = 0, renderTok = 0;

function build() {
  const it = item;
  const tools = frame.querySelector('.tools');
  frame.innerHTML = ''; frame.appendChild(tools);
  if (it.missing) { frame.insertAdjacentHTML('beforeend', `<div class="card"><div class="nm"></div><div class="miss">原文件找不到了</div></div>`); frame.querySelector('.nm').textContent = it.title; return; }
  switch (it.type) {
    case 'image': frame.insertAdjacentHTML('beforeend', '<div class="media"><img alt=""></div>'); frame.querySelector('img').src = it.src; break;
    case 'video': frame.insertAdjacentHTML('beforeend', '<div class="media"><video controls playsinline data-nodrag></video></div>'); frame.querySelector('video').src = it.src; break;
    case 'pdf':
      frame.insertAdjacentHTML('beforeend', `<div class="media paper"><canvas></canvas><div class="pdf-nav" data-nodrag><button data-p="-1" title="上一页  ←">${ic('left')}</button><span id="pg">1 / –</span><button data-p="1" title="下一页  →">${ic('right')}</button></div></div>`);
      page = it.page || 1; renderPdf(); break;
    case 'text':
      frame.insertAdjacentHTML('beforeend', '<div class="head"></div><pre class="body" data-scroll></pre>');
      frame.querySelector('.head').textContent = it.title;
      api.invoke('read-text', it.id, 400000).then(t => { frame.querySelector('pre').textContent = t; }); break;
    case 'note':
      frame.style.background = `var(--n${it.color || 1})`;
      frame.insertAdjacentHTML('beforeend', '<div class="note" data-scroll></div>');
      frame.querySelector('.note').textContent = it.text || ''; break;
    case 'link':
      frame.insertAdjacentHTML('beforeend', `<div class="card"><span class="lk-avatar"></span><div class="nm"></div><div class="sub"></div><button class="go" data-nodrag data-open>${ic('out')}在浏览器打开</button></div>`);
      frame.querySelector('.lk-avatar').textContent = (hostOf(it.url)[0] || '?').toUpperCase();
      frame.querySelector('.nm').textContent = hostOf(it.url); frame.querySelector('.sub').textContent = it.url; break;
    case 'audio':
      frame.insertAdjacentHTML('beforeend', `<div class="card"><div class="row"><span class="ext"></span><div class="nm"></div></div><audio controls data-nodrag></audio></div>`);
      frame.querySelector('.ext').textContent = it.ext || 'AUD'; frame.querySelector('.nm').textContent = it.title; frame.querySelector('audio').src = it.src; break;
    default:
      frame.insertAdjacentHTML('beforeend', `<div class="card"><div class="row"><span class="ext"></span><div><div class="nm"></div><div class="sub"></div></div></div><button class="go" data-nodrag data-open>${ic('out')}用默认程序打开</button></div>`);
      frame.querySelector('.ext').textContent = it.ext || 'FILE'; frame.querySelector('.nm').textContent = it.title;
      frame.querySelector('.sub').textContent = it.isDir ? '文件夹' : fmtSize(it.size);
  }
}
async function renderPdf() {
  const tok = ++renderTok;
  const media = frame.querySelector('.media'), cv = media && media.querySelector('canvas'); if (!cv) return;
  try {
    const doc = await getPdf(item.id); if (tok !== renderTok) return;
    pages = doc.numPages; page = clamp(page, 1, pages);
    $('#pg').textContent = `${page} / ${pages}`;
    const r = await renderPage(doc, page, media.clientWidth, media.clientHeight, devicePixelRatio || 1);
    if (tok !== renderTok) return;
    paint(cv, r); cv.style.width = r.cssW + 'px'; cv.style.height = r.cssH + 'px';
  } catch (e) { media.innerHTML = '<div class="miss">PDF 打不开</div>'; }
}
function flip(d) { if (item.type !== 'pdf' || !pages) return; const n = clamp(page + d, 1, pages); if (n === page) return; page = n; api.send('set-meta', item.id, { page }); renderPdf(); }
async function copy() { const r = await api.invoke('copy', item.id); if (r && r.msg) toast(r.msg); }
const hangBack = () => api.send('pin-hang');

/* move by dragging anywhere that is not a control */
let mv = null;
frame.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target.closest('[data-nodrag], [data-scroll], button')) return;
  mv = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY, moved: false };
  frame.setPointerCapture(e.pointerId);
});
frame.addEventListener('pointermove', e => {
  if (!mv) return;
  const dx = e.screenX - mv.sx, dy = e.screenY - mv.sy;
  if (!mv.moved && Math.hypot(dx, dy) < 3) return;
  if (!mv.moved) { mv.moved = true; frame.classList.add('moving'); }
  api.send('pin-move', mv.wx + dx, mv.wy + dy);
});
const endMove = () => { if (mv && mv.moved) api.send('pin-moved'); mv = null; frame.classList.remove('moving'); };
frame.addEventListener('pointerup', endMove);
frame.addEventListener('pointercancel', endMove);

/* wheel zooms (Ctrl+wheel changes opacity); scrollable text scrolls first */
let opacity = 1;
addEventListener('wheel', e => {
  /* opacity: Ctrl+wheel on Windows, ⌥+wheel on Mac (Mac trackpad pinch arrives as Ctrl+wheel, so it zooms) */
  if (IS_MAC ? e.altKey : e.ctrlKey) { e.preventDefault(); opacity = clamp(opacity + (e.deltaY < 0 ? .08 : -.08), .2, 1); api.send('pin-opacity', opacity); return; }
  const pinch = IS_MAC && e.ctrlKey;
  const sc = e.target.closest('[data-scroll]');
  if (sc && !pinch && !(IS_MAC ? e.metaKey : e.altKey) && sc.scrollHeight > sc.clientHeight + 1) return;
  e.preventDefault();
  api.send('pin-zoom', Math.exp(-clamp(e.deltaY, -120, 120) * (pinch ? .012 : .0013)), e.screenX, e.screenY);
}, { passive: false });
frame.addEventListener('dblclick', e => { if (e.target.closest('[data-nodrag], [data-scroll], button')) return; hangBack(); });
frame.addEventListener('contextmenu', e => { e.preventDefault(); api.invoke('pin-menu'); });
frame.addEventListener('click', e => {
  const p = e.target.closest('[data-p]'); if (p) { flip(+p.dataset.p); return; }
  if (e.target.closest('[data-open]')) api.send('open-item', item.id);
});
$('#copyBtn').addEventListener('click', copy);
$('#backBtn').addEventListener('click', hangBack);
addEventListener('keydown', e => {
  if (e.key === 'Escape') hangBack();
  else if (e.key === 'Delete' || (IS_MAC && e.key === 'Backspace' && e.metaKey)) api.send('pin-delete');
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !String(getSelection())) { e.preventDefault(); copy(); }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') flip(1);
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') flip(-1);
  else if (e.key === '=' || e.key === '+') api.send('pin-zoom', 1.15, window.screenX + innerWidth / 2, window.screenY + innerHeight / 2);
  else if (e.key === '-') api.send('pin-zoom', 1 / 1.15, window.screenX + innerWidth / 2, window.screenY + innerHeight / 2);
  else if (e.key === '0') api.send('pin-reset');
});
let rT = 0;
addEventListener('resize', () => { if (item && item.type === 'pdf') { clearTimeout(rT); rT = setTimeout(renderPdf, 140); } });
api.on('settings', s => applySkin(s));
api.on('toast', msg => toast(msg));
api.invoke('pin-init').then(d => {
  if (!d.item) { window.close(); return; }
  item = d.item; opacity = item.opacity || 1;
  document.documentElement.style.setProperty('--m', d.margin + 'px');
  applySkin(d.settings); build();
});

addEventListener('mousemove', e => {
  const g = document.getElementById('glare');
  g.style.setProperty('--mx', (e.clientX / innerWidth * 100).toFixed(1) + '%'); g.style.setProperty('--my', (e.clientY / innerHeight * 100).toFixed(1) + '%');
});
