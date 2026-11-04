'use strict';
const IS_MAC = (window.pinly && window.pinly.platform) === 'darwin';
const KEYS = IS_MAC ? { v: '⌃⌥V', shot: '⌘⇧4', copy: '⌘C' } : { v: 'Ctrl+Alt+V', shot: 'Win+Shift+S', copy: 'Ctrl+C' };
/* helpers shared by the rope window and the pinned windows */
const api = window.pinly;
const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hashNum = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const P = {
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  left: '<path d="M15 6l-6 6 6 6"/>', right: '<path d="M9 6l6 6-6 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
  hang: '<path d="M12 21V10m0 0l-4 4m4-4l4 4"/><path d="M3 4c6 3.5 12 3.5 18 0"/>',
  out: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4"/>',
};
const ic = n => `<svg class="i" viewBox="0 0 24 24">${P[n] || ''}</svg>`;
const TYPE_NAME = { image: '图片', pdf: 'PDF', video: '视频', audio: '音频', text: '文本', file: '文件', note: '文字', link: '链接' };
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u || ''; } };
function fmtSize(b) { if (b == null) return ''; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'; return (b / 1073741824).toFixed(2) + ' GB'; }
function applySkin(s) { document.documentElement.dataset.skin = (s && s.skin) || 'cork'; }

/* pdf.js runs on the main thread: the worker script is loaded as a plain script, so no Worker is needed */
const pdfDocs = new Map();
function getPdf(id) {
  if (!pdfDocs.has(id)) {
    const p = api.invoke('read-file', id).then(data => {
      if (!data) throw new Error('missing');
      return window.pdfjsLib.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
    });
    p.catch(() => pdfDocs.delete(id));
    pdfDocs.set(id, p);
  }
  return pdfDocs.get(id);
}
async function renderPage(doc, num, boxW, boxH, res) {
  const pg = await doc.getPage(num);
  const vp1 = pg.getViewport({ scale: 1 });
  const fit = Math.min(boxW / vp1.width, boxH / vp1.height);
  const cssW = vp1.width * fit, cssH = vp1.height * fit;
  res = Math.max(1, Math.min(res, 3200 / cssW, 3200 / cssH));
  const vp = pg.getViewport({ scale: fit * res });
  const off = document.createElement('canvas'); off.width = Math.ceil(vp.width); off.height = Math.ceil(vp.height);
  await pg.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
  return { off, cssW, cssH, ratio: vp1.width / vp1.height };
}
function paint(cv, r) { cv.width = r.off.width; cv.height = r.off.height; cv.getContext('2d').drawImage(r.off, 0, 0); }

function toast(msg, actLabel, act) {
  const box = $('#toasts'); if (!box) return;
  const prev = box.lastElementChild; if (prev && !actLabel && prev.firstChild.textContent === msg) prev.remove();
  const t = document.createElement('div'); t.className = 'toast';
  t.innerHTML = '<span></span>'; t.firstChild.textContent = msg;
  let gone = false; const kill = () => { if (gone) return; gone = true; t.classList.add('out'); setTimeout(() => t.remove(), 220); };
  if (actLabel) { const b = document.createElement('button'); b.textContent = actLabel; b.onclick = () => { act(); kill(); }; t.appendChild(b); }
  box.appendChild(t); while (box.children.length > 3) box.firstChild.remove();
  setTimeout(kill, actLabel ? 5000 : 2400);
}
