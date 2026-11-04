'use strict';
const { app, BrowserWindow, ipcMain, clipboard, nativeImage, screen, Tray, Menu, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL, fileURLToPath } = require('url');
const { execFile } = require('child_process');
const IS_MAC = process.platform === 'darwin';
/* shortcut labels as each platform writes them */
const KEY = IS_MAC ? { t: '⌃⌥T', s: '⌃⌥S', v: '⌃⌥V', shot: '⌘⇧4' } : { t: 'Ctrl+Alt+T', s: 'Ctrl+Alt+S', v: 'Ctrl+Alt+V', shot: 'Win+Shift+S' };

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('com.pegline.app');

/* ---------------- storage ---------------- */
const ITEMS_DIR = () => path.join(app.getPath('userData'), 'items');
const STORE = () => path.join(app.getPath('userData'), 'store.json');
const MAX_ROPE = 100;
const COPY_LIMIT = 80 * 1024 * 1024; // files up to 80MB are kept as a private copy
const store = {
  items: [],
  settings: { skin: 'cork', edge: 'top', display: 'primary', mascot: true, autoHide: true, watchImages: true, screenshotsOnly: false, watchFiles: true, watchText: true, openAtLogin: false, ghost: false, ghostSecs: 8 },
};
function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE(), 'utf8'));
    if (Array.isArray(s.items)) store.items = s.items;
    Object.assign(store.settings, s.settings || {});
  } catch (e) { /* first run */ }
  /* ghosts nobody confirmed before the app closed are dropped */
  const stale = store.items.filter(i => i.pending);
  if (stale.length) { stale.forEach(removeFiles); store.items = store.items.filter(i => !i.pending); }
}
/* the app used to be called Pinly: bring its cards over once, on the first run under the new name */
function migrateFromPinly() {
  try {
    if (fs.existsSync(STORE())) return false;
    const oldDir = path.join(app.getPath('appData'), 'Pinly'), oldStore = path.join(oldDir, 'store.json');
    if (!fs.existsSync(oldStore)) return false;
    const oldItems = path.resolve(path.join(oldDir, 'items'));
    fs.mkdirSync(ITEMS_DIR(), { recursive: true });
    if (fs.existsSync(oldItems)) fs.cpSync(oldItems, ITEMS_DIR(), { recursive: true });
    const s = JSON.parse(fs.readFileSync(oldStore, 'utf8'));
    for (const it of s.items || []) if (it.path && path.resolve(it.path).startsWith(oldItems)) it.path = path.join(ITEMS_DIR(), path.relative(oldItems, path.resolve(it.path)));
    fs.writeFileSync(STORE(), JSON.stringify(s));
    return true;
  } catch (e) { debugLog('migrate failed ' + (e && e.stack || e)); return false; }
}
let saveT = null;
function saveStore(now) {
  clearTimeout(saveT);
  const write = () => {
    try { fs.writeFileSync(STORE() + '.tmp', JSON.stringify(store)); fs.renameSync(STORE() + '.tmp', STORE()); } catch (e) { console.error(e); }
  };
  if (now) write(); else saveT = setTimeout(write, 250);
}
const uid = () => crypto.randomBytes(6).toString('hex');
const byId = id => store.items.find(i => i.id === id);
const rxOf = i => (i.rx == null ? 2 + (i.ri || 0) * 1e-3 : i.rx); // cards without a spot yet sort to the right
const ropeItems = () => store.items.filter(i => i.state === 'rope').sort((a, b) => rxOf(a) - rxOf(b));
const pad2 = n => String(n).padStart(2, '0');
const timeStr = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const isOwnFile = p => !!p && path.resolve(p).startsWith(path.resolve(ITEMS_DIR()));

function kindOf(name) {
  const n = name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/.test(n)) return 'image';
  if (n.endsWith('.pdf')) return 'pdf';
  if (/\.(mp4|webm|mov|m4v|ogv|mkv)$/.test(n)) return 'video';
  if (/\.(mp3|wav|ogg|m4a|aac|flac|opus)$/.test(n)) return 'audio';
  if (/\.(txt|md|markdown|json|js|mjs|jsx|ts|tsx|py|java|c|cc|cpp|h|hpp|cs|go|rs|rb|php|swift|kt|css|scss|less|html|htm|xml|yml|yaml|toml|ini|cfg|sh|bat|ps1|sql|csv|tsv|log|tex|vue|lua|dart|env)$/.test(n)) return 'text';
  return 'file';
}
function forRenderer(it) {
  const o = { ...it };
  if (it.path) {
    o.src = pathToFileURL(it.path).href;
    o.missing = !fs.existsSync(it.path);
    if (!o.ext) o.ext = (path.extname(it.path).slice(1) || (it.isDir ? 'DIR' : 'FILE')).toUpperCase().slice(0, 4);
    try { if (!o.missing && !it.isDir) o.size = fs.statSync(it.path).size; } catch (e) {}
  }
  return o;
}
function removeFiles(it) { if (isOwnFile(it.path)) fs.promises.unlink(it.path).catch(() => {}); }
function trimRope() {
  const list = ropeItems();
  while (list.length > MAX_ROPE) {
    const oldest = list.reduce((a, b) => ((a.created || 0) <= (b.created || 0) ? a : b));
    list.splice(list.indexOf(oldest), 1);
    store.items = store.items.filter(i => i !== oldest);
    removeFiles(oldest);
  }
}
function renumber(list) { list.forEach((it, i) => { it.state = 'rope'; it.ri = i; }); }

/* hang an item on the rope: at opts.rx (0..1 along the rope) if given, otherwise at its old spot,
   otherwise the rope window puts it just right of the rightmost card */
function hang(it, opts = {}) {
  it.created = it.created || Date.now();
  it.state = 'rope';
  /* ghost mode: things that arrived on their own hang see-through until you click them */
  if (opts.auto && store.settings.ghost) it.pending = Date.now() + clampSecs(store.settings.ghostSecs) * 1000;
  if (opts.rx != null) it.rx = Math.max(0, Math.min(1, opts.rx));
  if (it.ri == null && it.rx == null) it.ri = 1e6 + Date.now() % 1e6;
  if (!store.items.includes(it)) store.items.push(it);
  renumber(ropeItems());
  trimRope(); saveStore();
  pushRope({ added: [it.id], from: opts.from ? { [it.id]: opts.from } : null, reveal: opts.reveal !== false });
}
const clampSecs = v => Math.max(3, Math.min(60, Number(v) || 8));
function keepItem(id) {
  const it = byId(id); if (!it || !it.pending) return false;
  delete it.pending; delete it.pendHeld; delete it.pendLeft;
  saveStore(); return true;
}
function expireGhosts() {
  const now = Date.now();
  const gone = store.items.filter(i => i.pending && !i.pendHeld && now > i.pending);
  if (!gone.length) return;
  store.items = store.items.filter(i => !gone.includes(i));
  gone.forEach(removeFiles);
  renumber(ropeItems()); saveStore(); pushRope({ expired: gone.map(i => i.id) });
}
function pushRope(extra = {}) {
  if (!rope || rope.isDestroyed()) return;
  rope.webContents.send('rope', { items: ropeItems().map(forRenderer), settings: store.settings, ...extra });
}

function addImage(img, title, opts = {}) {
  fs.mkdirSync(ITEMS_DIR(), { recursive: true });
  const id = uid();
  const p = path.join(ITEMS_DIR(), id + '.png');
  fs.writeFileSync(p, img.toPNG());
  const s = img.getSize();
  hang({ id, type: 'image', title: title || '截图 ' + timeStr(), path: p, ratio: s.width / Math.max(1, s.height), w: s.width, h: s.height }, opts);
}
function addPath(p, opts = {}) {
  let st; try { st = fs.statSync(p); } catch (e) { return; }
  const id = uid();
  const name = path.basename(p);
  if (st.isDirectory()) { hang({ id, type: 'file', title: name, path: p, isDir: true, ext: 'DIR' }, opts); return; }
  let keep = p;
  if (st.size <= COPY_LIMIT) {
    try { fs.mkdirSync(ITEMS_DIR(), { recursive: true }); keep = path.join(ITEMS_DIR(), id + path.extname(p).toLowerCase()); fs.copyFileSync(p, keep); }
    catch (e) { keep = p; }
  }
  const type = kindOf(name);
  const it = { id, type, title: name, path: keep, origin: p };
  if (type === 'image') { const im = nativeImage.createFromPath(keep); if (!im.isEmpty()) { const s = im.getSize(); it.ratio = s.width / s.height; it.w = s.width; it.h = s.height; } }
  if (type === 'text' && st.size > 2 * 1024 * 1024) it.type = 'file';
  hang(it, opts);
}
function addText(text, opts = {}) {
  const t = text.trim(); if (!t) return;
  const id = uid();
  if (/^https?:\/\/\S+$/i.test(t)) {
    let host = t; try { host = new URL(t).hostname.replace(/^www\./, ''); } catch (e) {}
    hang({ id, type: 'link', title: host, url: t }, opts);
  } else {
    const first = t.split('\n')[0].slice(0, 24);
    hang({ id, type: 'note', title: first || '文字', text: t.slice(0, 20000), color: 1 + Math.floor(Math.random() * 5) }, opts);
  }
}

/* ---------------- clipboard watcher ---------------- */
const clip = { img: null, text: null, file: null, primed: false, skipUntil: 0 };
function imageSig(img) {
  const s = img.getSize();
  const small = img.resize({ width: 24, height: 24, quality: 'good' }).toBitmap();
  return `${s.width}x${s.height}:` + crypto.createHash('md5').update(small).digest('hex');
}
const unXml = t => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function readCopiedFiles() {
  if (IS_MAC) {
    /* Finder puts every copied file in NSFilenamesPboardType (a plist), and the first one as public.file-url */
    try {
      const plist = clipboard.read('NSFilenamesPboardType');
      if (plist) { const list = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map(m => unXml(m[1])).filter(Boolean); if (list.length) return list; }
      const u = clipboard.read('public.file-url');
      if (u && u.startsWith('file://')) return [fileURLToPath(u.trim())];
    } catch (e) {}
    return [];
  }
  if (process.platform !== 'win32') return [];
  try {
    const buf = clipboard.readBuffer('FileNameW');
    if (!buf || !buf.length) return [];
    return buf.toString('ucs2').split('\0').filter(Boolean);
  } catch (e) { return []; }
}
function pollClipboard() {
  try {
    const formats = clipboard.availableFormats();
    const files = readCopiedFiles();
    const fileKey = files.join('|') || null;
    if (fileKey) {
      if (fileKey !== clip.file) {
        clip.file = fileKey;
        if (clip.primed && Date.now() > clip.skipUntil && store.settings.watchFiles) files.forEach(f => addPath(f, { auto: true }));
      }
      clip.primed = true; return;
    }
    clip.file = null;
    const hasText = formats.includes('text/plain');
    const plain = hasText ? clipboard.readText() : '';
    /* Excel and Word put a picture next to the text; real text wins. A copied web image has no plain text. */
    const tryImage = formats.some(f => f.startsWith('image/')) || !hasText;
    if (tryImage && !plain.trim()) {
      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        const sig = imageSig(img);
        if (sig !== clip.img) {
          clip.img = sig;
          /* a screenshot arrives as a bare picture; images copied from a web page or app also carry HTML */
          const fromScreenshot = !formats.includes('text/html');
          if (clip.primed && Date.now() > clip.skipUntil && store.settings.watchImages && (!store.settings.screenshotsOnly || fromScreenshot)) addImage(img, null, { auto: true });
        }
        clip.primed = true; return;
      }
    }
    const text = plain;
    if (text && text !== clip.text) {
      clip.text = text;
      if (clip.primed && Date.now() > clip.skipUntil && store.settings.watchText && text.trim().length) addText(text, { auto: true });
    }
  } catch (e) { console.error('clipboard', e); }
  clip.primed = true;
}
/* Ctrl+Alt+V: hang whatever is on the clipboard right now, whatever the collection settings say */
function hangClipboardNow() {
  try {
    const files = readCopiedFiles();
    if (files.length) { files.forEach(f => addPath(f)); return; }
    const plain = clipboard.readText();
    if (!plain.trim()) { const img = clipboard.readImage(); if (!img.isEmpty()) { addImage(img); return; } }
    if (plain.trim()) { addText(plain); return; }
    if (rope) { rope.webContents.send('toggle', true); rope.webContents.send('toast', '剪贴板里没有能挂的东西'); }
  } catch (e) { console.error(e); }
}
function markOwnClipboardWrite() {
  clip.skipUntil = Date.now() + 1200;
  try {
    const img = clipboard.readImage(); clip.img = img.isEmpty() ? clip.img : imageSig(img);
    clip.text = clipboard.readText() || clip.text;
    const f = readCopiedFiles().join('|'); clip.file = f || null;
  } catch (e) {}
}
function copyItem(it) {
  if (!it) return { ok: false };
  try {
    if (it.type === 'image' && it.path) {
      const img = nativeImage.createFromPath(it.path);
      if (img.isEmpty()) return { ok: false, msg: '这张图片的格式没法放进剪贴板' };
      clipboard.writeImage(img); markOwnClipboardWrite(); return { ok: true, msg: '已复制图片，去别处粘贴吧' };
    }
    if (it.type === 'note') { clipboard.writeText(it.text || ''); markOwnClipboardWrite(); return { ok: true, msg: '已复制文字' }; }
    if (it.type === 'link') { clipboard.writeText(it.url); markOwnClipboardWrite(); return { ok: true, msg: '已复制链接' }; }
    if (it.type === 'text' && it.path) { clipboard.writeText(fs.readFileSync(it.path, 'utf8')); markOwnClipboardWrite(); return { ok: true, msg: '已复制文件里的文字' }; }
    if (it.path) { clipboard.writeText(it.origin || it.path); markOwnClipboardWrite(); return { ok: true, msg: '已复制文件路径。想发文件，就把它往下拖进聊天窗口' }; }
  } catch (e) { return { ok: false, msg: '复制失败了' }; }
  return { ok: false };
}

/* ---------------- windows ---------------- */
let rope = null, tray = null;
const pins = new Map();
const PIN_M = 14; // transparent margin around a pin, room for its shadow

function ropeDisplay() {
  const all = screen.getAllDisplays();
  return all.find(d => String(d.id) === String(store.settings.display)) || screen.getPrimaryDisplay();
}
function ropeBounds() {
  const wa = ropeDisplay().workArea, edge = store.settings.edge;
  if (edge === 'left' || edge === 'right') {
    const w = Math.min(560, Math.round(wa.width * 0.45));
    return { x: edge === 'left' ? wa.x : wa.x + wa.width - w, y: wa.y, width: w, height: wa.height };
  }
  return { x: wa.x, y: wa.y, width: wa.width, height: Math.min(600, Math.round(wa.height * 0.66)) };
}
const webPrefs = () => ({ preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: false });

function createRope() {
  rope = new BrowserWindow({
    ...ropeBounds(), frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, hasShadow: false, focusable: false, alwaysOnTop: true, show: false,
    backgroundColor: '#00000000', title: '晾晾', webPreferences: webPrefs(),
  });
  rope.setAlwaysOnTop(true, 'screen-saver');
  if (IS_MAC) rope.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  rope.setIgnoreMouseEvents(true, { forward: true });
  rope.loadFile('rope.html');
  rope.once('ready-to-show', () => rope.showInactive());
  rope.on('closed', () => { rope = null; });
}
let lastCursor = '';
function pollCursor() {
  if (!rope || rope.isDestroyed()) return;
  const p = screen.getCursorScreenPoint(), b = rope.getBounds();
  const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  const key = `${p.x},${p.y},${inside}`;
  if (key === lastCursor) return;
  lastCursor = key;
  rope.webContents.send('cursor', { x: p.x - b.x, y: p.y - b.y, inside });
}

function naturalSize(it) {
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const sf = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).scaleFactor || 1;
  let w = 420, h = 300;
  const r = it.ratio || 0;
  switch (it.type) {
    case 'image': w = it.w ? it.w / sf : 480; h = it.h ? it.h / sf : (r ? w / r : 360); break;
    case 'pdf': w = 560; h = w / (r || 0.707); break;
    case 'video': w = (r && r < 1) ? 360 : 640; h = w / (r || 16 / 9); break;
    case 'text': w = 520; h = 600; break;
    case 'note': w = 340; h = Math.min(520, 150 + Math.ceil((it.text || '').length / 18) * 26); break;
    case 'link': w = 380; h = 210; break;
    case 'audio': w = 400; h = 150; break;
    default: w = 380; h = 160;
  }
  const maxW = wa.width * 0.8, maxH = wa.height * 0.8, k = Math.min(1, maxW / w, maxH / h);
  w = Math.max(120, Math.round(w * k)); h = Math.max(80, Math.round(h * k));
  return { w, h };
}
function clampToDisplay(b) {
  const wa = screen.getDisplayMatching(b).workArea;
  b.x = Math.max(wa.x - b.width + 80, Math.min(b.x, wa.x + wa.width - 80));
  b.y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - 60));
  return b;
}
function openPin(it, fromScreenRect) {
  keepItem(it.id);
  if (pins.has(it.id)) { pins.get(it.id).show(); return; }
  let b = it.bounds;
  if (!b) {
    const { w, h } = naturalSize(it);
    const c = screen.getCursorScreenPoint(), r = fromScreenRect || { x: c.x, y: c.y, width: 0, height: 0 };
    const edge = store.settings.edge;
    if (fromScreenRect && fromScreenRect.width && edge === 'left') b = { x: Math.round(r.x + r.width + 18 - PIN_M), y: Math.round(r.y + r.height / 2 - h / 2 - PIN_M), width: w + PIN_M * 2, height: h + PIN_M * 2 };
    else if (fromScreenRect && fromScreenRect.width && edge === 'right') b = { x: Math.round(r.x - 18 - w - PIN_M), y: Math.round(r.y + r.height / 2 - h / 2 - PIN_M), width: w + PIN_M * 2, height: h + PIN_M * 2 };
    else b = { x: Math.round(r.x + r.width / 2 - w / 2 - PIN_M), y: Math.round(r.y + r.height + 18 - PIN_M), width: w + PIN_M * 2, height: h + PIN_M * 2 };
  }
  b = clampToDisplay({ ...b });
  const win = new BrowserWindow({
    ...b, frame: false, transparent: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false, backgroundColor: '#00000000', title: it.title || '晾晾',
    webPreferences: webPrefs(),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  if (it.opacity && it.opacity < 1) win.setOpacity(it.opacity);
  win.loadFile('pin.html', { query: { id: it.id } });
  win.once('ready-to-show', () => win.show());
  win.pinId = it.id;
  pins.set(it.id, win);
  win.on('closed', () => pins.delete(it.id));
  it.state = 'pin'; it.bounds = b; saveStore();
}
function pinToRope(id, opts = {}) {
  const it = byId(id); if (!it) return;
  const win = pins.get(id);
  let from = null;
  if (win && !win.isDestroyed() && rope) {
    const b = win.getBounds(), rb = rope.getBounds();
    from = { x: b.x + PIN_M - rb.x, y: b.y + PIN_M - rb.y, width: b.width - PIN_M * 2, height: b.height - PIN_M * 2 };
    win.destroy();
  }
  delete it.bounds; delete it.opacity;
  hang(it, { from });
}
function deleteItem(id) {
  const it = byId(id); if (!it) return;
  const win = pins.get(id); if (win && !win.isDestroyed()) win.destroy();
  store.items = store.items.filter(i => i !== it);
  if (trash) removeFiles(trash);
  trash = it;
  renumber(ropeItems()); saveStore(); pushRope();
}
let trash = null;
function undoDelete() {
  if (!trash) return;
  const it = trash; trash = null;
  delete it.pending; delete it.pendHeld; delete it.pendLeft;
  hang(it, {});
}

/* ---------------- menus ---------------- */
const BOOL_SETTINGS = ['mascot', 'autoHide', 'watchImages', 'screenshotsOnly', 'watchFiles', 'watchText', 'ghost'];
const SKINS = [['berry', '草莓甜心'], ['mecha', '赛博机甲'], ['cork', '软木板'], ['day', '白昼'], ['night', '夜航'], ['soda', '汽水糖'], ['blueprint', '蓝图']];
function setSetting(k, v) {
  store.settings[k] = v; saveStore();
  if (k === 'openAtLogin') { try { app.setLoginItemSettings({ openAtLogin: v }); } catch (e) {} }
  if ((k === 'edge' || k === 'display') && rope && !rope.isDestroyed()) rope.setBounds(ropeBounds());
  broadcast('settings', store.settings);
  buildTray();
}
function broadcast(ch, data) {
  if (rope && !rope.isDestroyed()) rope.webContents.send(ch, data);
  for (const w of pins.values()) if (!w.isDestroyed()) w.webContents.send(ch, data);
}
function mainMenuTemplate() {
  const s = store.settings;
  return [
    { label: '显示绳子', accelerator: 'Control+Alt+T', click: () => rope && rope.webContents.send('toggle') },
    { label: '换皮肤和设置…', click: () => rope && rope.webContents.send('open-panel') },
    { label: '截个图（自动挂上绳）', accelerator: 'Control+Alt+S', click: snip },
    { type: 'separator' },
    { label: '鼠标离开后自动收起绳子', type: 'checkbox', checked: s.autoHide, click: m => setSetting('autoHide', m.checked) },
    { label: '把剪贴板挂上去', accelerator: 'Control+Alt+V', click: hangClipboardNow },
    { label: '收集截图和复制的图片', type: 'checkbox', checked: s.watchImages, click: m => setSetting('watchImages', m.checked) },
    { label: '　只收截图，不收网页和软件里复制的图片', type: 'checkbox', enabled: s.watchImages, checked: !!s.screenshotsOnly, click: m => setSetting('screenshotsOnly', m.checked) },
    { label: '收集复制的文件', type: 'checkbox', checked: s.watchFiles, click: m => setSetting('watchFiles', m.checked) },
    { label: '收集复制的文字和链接', type: 'checkbox', checked: s.watchText, click: m => setSetting('watchText', m.checked) },
    { label: '先挂个虚影，点一下才留下', type: 'checkbox', checked: !!s.ghost, click: m => setSetting('ghost', m.checked) },
    { label: '　虚影停留', enabled: !!s.ghost, submenu: [5, 8, 15, 30].map(n => ({ label: n + ' 秒', type: 'radio', checked: clampSecs(s.ghostSecs) === n, click: () => setSetting('ghostSecs', n) })) },
    { type: 'separator' },
    { label: '绳子挂在', submenu: [['top', '屏幕上边'], ['left', '屏幕左边'], ['right', '屏幕右边']].map(([id, name]) => ({ label: name, type: 'radio', checked: (s.edge || 'top') === id, click: () => setSetting('edge', id) })) },
    ...(screen.getAllDisplays().length > 1 ? [{ label: '放在哪块屏幕', submenu: [{ label: '主屏幕', type: 'radio', checked: s.display === 'primary' || !screen.getAllDisplays().some(d => String(d.id) === String(s.display)), click: () => setSetting('display', 'primary') }].concat(screen.getAllDisplays().map((d, i) => ({ label: `屏幕 ${i + 1}（${d.size.width}×${d.size.height}）`, type: 'radio', checked: String(d.id) === String(s.display), click: () => setSetting('display', String(d.id)) }))) }] : []),
    { label: '绳上的小动效', type: 'checkbox', checked: s.mascot !== false, click: m => setSetting('mascot', m.checked) },
    { label: '皮肤', submenu: SKINS.map(([id, name]) => ({ label: name, type: 'radio', checked: s.skin === id, click: () => setSetting('skin', id) })) },
    { label: '把绳上的全部钉到屏幕', click: () => { const list = ropeItems(); list.slice(0, 12).forEach((it, i) => { delete it.bounds; openPin(it, { x: 120 + i * 40, y: 120 + i * 30, width: 0, height: 0 }); }); saveStore(); pushRope(); } },
    { label: '清空绳子', click: () => { const list = ropeItems(); list.forEach(it => removeFiles(it)); store.items = store.items.filter(i => i.state !== 'rope'); saveStore(); pushRope(); } },
    { label: '打开收集文件夹', click: () => { fs.mkdirSync(ITEMS_DIR(), { recursive: true }); shell.openPath(ITEMS_DIR()); } },
    { label: '开机自动启动', type: 'checkbox', checked: s.openAtLogin, click: m => setSetting('openAtLogin', m.checked) },
    { type: 'separator' },
    { label: '退出晾晾', click: () => { app.isQuitting = true; app.quit(); } },
  ];
}
function buildTray() {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'build', IS_MAC ? 'trayTemplate.png' : 'tray.png')));
    tray.setToolTip('晾晾 Pegline');
    tray.on('click', () => rope && rope.webContents.send('toggle'));
  }
  tray.setContextMenu(Menu.buildFromTemplate(mainMenuTemplate()));
}
function itemMenu(it, win, onPin) {
  const t = [
    { label: '复制', click: () => notify(win, copyItem(it)) },
    onPin ? { label: '挂回绳上', click: () => pinToRope(it.id) } : { label: '钉到屏幕上', click: () => { openPin(it); saveStore(); pushRope(); } },
  ];
  if (onPin) t.push({ label: '透明度', submenu: [1, 0.85, 0.7, 0.5, 0.35].map(v => ({ label: Math.round(v * 100) + '%', type: 'radio', checked: Math.abs((it.opacity || 1) - v) < 0.01, click: () => { it.opacity = v; win.setOpacity(v); saveStore(); } })) });
  if (it.path) {
    t.push({ label: '用默认程序打开', click: () => shell.openPath(it.path) });
    t.push({ label: '在文件夹中显示', click: () => shell.showItemInFolder(it.origin && fs.existsSync(it.origin) ? it.origin : it.path) });
  }
  if (it.url) t.push({ label: '在浏览器打开', click: () => shell.openExternal(it.url) });
  t.push({ type: 'separator' }, { label: '删除', click: () => deleteItem(it.id) });
  return Menu.buildFromTemplate(t);
}
function notify(win, res) { if (res && res.msg && win && !win.isDestroyed()) win.webContents.send('toast', res.msg); }
function snip() {
  if (!IS_MAC) { shell.openExternal('ms-screenclip:').catch(() => {}); return; }
  /* macOS: interactive capture straight to a file, then hang it (works in every collection mode) */
  const tmp = path.join(os.tmpdir(), `pegline-shot-${Date.now()}.png`);
  execFile('/usr/sbin/screencapture', ['-i', '-x', tmp], () => {
    try { if (fs.existsSync(tmp) && fs.statSync(tmp).size) { const img = nativeImage.createFromPath(tmp); if (!img.isEmpty()) addImage(img); } } catch (e) {}
    fs.rm(tmp, { force: true }, () => {});
  });
}

/* macOS: ⌘⇧3 / ⌘⇧4 / ⌘⇧5 save a file (usually on the Desktop), not to the clipboard, so watch that folder */
const shotSeen = new Set();
const SHOT_NAME = /^(Screenshot|Screen Shot|截屏|屏幕快照|螢幕截圖|螢幕快照|スクリーンショット|Bildschirmfoto|Capture d.écran|Captura de pantalla|Schermata|스크린샷)/i;
function watchMacScreenshots() {
  execFile('/usr/bin/defaults', ['read', 'com.apple.screencapture', 'location'], (err, out) => {
    let dir = !err && String(out).trim();
    if (dir) dir = dir.replace(/^~(?=\/|$)/, os.homedir());
    if (!dir || !fs.existsSync(dir)) dir = path.join(os.homedir(), 'Desktop');
    try {
      fs.watch(dir, (_ev, name) => {
        if (!name || name.startsWith('.') || !SHOT_NAME.test(name) || !/\.(png|jpe?g|heic|tiff?)$/i.test(name)) return;
        const full = path.join(dir, name);
        if (shotSeen.has(full)) return;
        setTimeout(() => {
          try {
            const st = fs.statSync(full);
            if (shotSeen.has(full) || !st.size || Date.now() - st.mtimeMs > 30000) return;
            shotSeen.add(full);
            if (store.settings.watchImages) addPath(full, { reveal: true, auto: true });
          } catch (e) {}
        }, 700);
      });
    } catch (e) { console.error('screenshot folder', e); }
  });
}

/* ---------------- ipc ---------------- */
const winOf = e => BrowserWindow.fromWebContents(e.sender);
ipcMain.handle('init', () => ({ items: ropeItems().map(forRenderer), settings: store.settings }));
ipcMain.on('set-ignore', (e, v) => { const w = winOf(e); if (w) w.setIgnoreMouseEvents(!!v, { forward: true }); });
ipcMain.on('set-setting', (e, k, v) => { if (k === 'edge' && ['top', 'left', 'right'].includes(v)) setSetting('edge', v); else if (k === 'skin' && SKINS.some(s => s[0] === v)) setSetting('skin', v); else if (k === 'ghostSecs') setSetting('ghostSecs', clampSecs(v)); else if (BOOL_SETTINGS.includes(k)) setSetting(k, !!v); });
ipcMain.on('keep', (e, id) => { if (keepItem(id)) pushRope({ kept: id }); });
/* hovering a ghost stops its countdown; leaving restarts it with at least a couple of seconds */
ipcMain.on('pend-hold', (e, id, on) => {
  const it = byId(id); if (!it || !it.pending) return;
  if (on) { if (!it.pendHeld) { it.pendHeld = true; it.pendLeft = Math.max(0, it.pending - Date.now()); } return; }
  if (!it.pendHeld) return;
  it.pendHeld = false; it.pending = Date.now() + Math.max(it.pendLeft || 0, 2500); delete it.pendLeft; pushRope();
});
/* several switches at once (the collection presets) with one broadcast */
ipcMain.on('set-settings', (e, patch) => {
  for (const [k, v] of Object.entries(patch || {})) if (BOOL_SETTINGS.includes(k)) store.settings[k] = !!v;
  saveStore(); broadcast('settings', store.settings); buildTray();
});
ipcMain.on('positions', (e, pos) => { for (const [id, rx] of Object.entries(pos || {})) { const it = byId(id); if (it && typeof rx === 'number' && isFinite(rx)) it.rx = Math.max(0, Math.min(1, rx)); } renumber(ropeItems()); saveStore(); });
ipcMain.handle('copy', (e, id) => copyItem(byId(id)));
ipcMain.on('pin', (e, id, rect) => {
  const it = byId(id); if (!it || !rope) return;
  const rb = rope.getBounds();
  delete it.bounds;
  openPin(it, rect ? { x: rb.x + rect.x, y: rb.y + rect.y, width: rect.width, height: rect.height } : null);
  renumber(ropeItems()); saveStore(); pushRope();
});
ipcMain.on('delete', (e, id) => deleteItem(id));
ipcMain.handle('undo-delete', () => undoDelete());
ipcMain.handle('read-file', async (e, id, max) => {
  const it = byId(id); if (!it || !it.path) return null;
  try { const st = await fs.promises.stat(it.path); if (st.size > (max || 60 * 1024 * 1024)) return null; return new Uint8Array(await fs.promises.readFile(it.path)); } catch (err) { return null; }
});
ipcMain.handle('read-text', async (e, id, max) => {
  const it = byId(id); if (!it) return '';
  if (it.type === 'note') return it.text || '';
  if (!it.path) return '';
  try { const fh = await fs.promises.open(it.path, 'r'); const buf = Buffer.alloc(Math.min(max || 200000, (await fh.stat()).size)); await fh.read(buf, 0, buf.length, 0); await fh.close(); return buf.toString('utf8'); } catch (err) { return ''; }
});
ipcMain.on('set-meta', (e, id, patch) => { const it = byId(id); if (!it) return; for (const k of ['ratio', 'page']) if (patch[k] != null) it[k] = patch[k]; saveStore(); });
ipcMain.on('start-drag', (e, id) => {
  const it = byId(id); if (!it) return;
  if (keepItem(id)) pushRope();
  let file = it.path;
  if (!file || !fs.existsSync(file)) {
    const tmp = path.join(os.tmpdir(), 'pegline-drag'); fs.mkdirSync(tmp, { recursive: true });
    const safe = (it.title || 'pegline').replace(/[\\/:*?"<>|\r\n]+/g, ' ').slice(0, 40).trim() || 'pegline';
    if (it.type === 'link') { file = path.join(tmp, safe + '.url'); fs.writeFileSync(file, `[InternetShortcut]\r\nURL=${it.url}\r\n`); }
    else { file = path.join(tmp, safe + '.txt'); fs.writeFileSync(file, '﻿' + (it.text || '')); }
  }
  let icon = it.type === 'image' && it.path ? nativeImage.createFromPath(it.path) : nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
  if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
  icon = icon.resize({ width: 96 });
  try { e.sender.startDrag({ file, icon }); } catch (err) { console.error(err); }
});
ipcMain.handle('card-menu', (e, id) => new Promise(res => {
  const it = byId(id); if (!it) return res();
  itemMenu(it, winOf(e), false).popup({ window: winOf(e), callback: () => res() });
}));
ipcMain.handle('main-menu', e => new Promise(res => { Menu.buildFromTemplate(mainMenuTemplate()).popup({ window: winOf(e), callback: () => res() }); }));
ipcMain.handle('add-paths', (e, paths, rx) => { paths.forEach((p, i) => addPath(p, { rx: rx == null ? null : rx + i * 0.001 })); });
ipcMain.handle('add-text', (e, text) => addText(text));
ipcMain.on('snip', snip);
ipcMain.on('quit', () => { app.isQuitting = true; app.quit(); });
/* tiny capped debug log in the data folder, for tracking down problems on other people's machines */
function debugLog(msg) {
  try {
    const f = path.join(app.getPath('userData'), 'pegline-debug.log');
    try { if (fs.statSync(f).size > 200000) fs.renameSync(f, f + '.old'); } catch (e) {}
    fs.appendFileSync(f, `${new Date().toISOString()} ${String(msg).slice(0, 2000)}\n`);
  } catch (e) {}
}
ipcMain.on('log', (e, msg) => debugLog(msg));
process.on('uncaughtException', err => debugLog('main error: ' + (err && err.stack || err)));

/* pin windows */
ipcMain.handle('pin-init', e => {
  const w = winOf(e); const it = w && byId(w.pinId);
  return { item: it ? forRenderer(it) : null, settings: store.settings, margin: PIN_M };
});
ipcMain.on('pin-move', (e, x, y) => { const w = winOf(e); if (!w) return; w.setPosition(Math.round(x), Math.round(y)); });
ipcMain.on('pin-moved', e => { const w = winOf(e); const it = w && byId(w.pinId); if (it) { it.bounds = w.getBounds(); saveStore(); } });
ipcMain.on('pin-zoom', (e, f, sx, sy) => {
  const w = winOf(e); const it = w && byId(w.pinId); if (!w || !it) return;
  const b = w.getBounds();
  const cw = b.width - PIN_M * 2, ch = b.height - PIN_M * 2, aspect = cw / ch;
  const wa = screen.getDisplayMatching(b).workArea;
  let nw = Math.round(Math.max(90, Math.min(wa.width * 2, cw * f)));
  let nh = Math.round(nw / aspect);
  if (nh < 60) { nh = 60; nw = Math.round(nh * aspect); }
  const k = nw / cw;
  const nx = Math.round(sx - (sx - b.x - PIN_M) * k) - PIN_M, ny = Math.round(sy - (sy - b.y - PIN_M) * k) - PIN_M;
  w.setBounds({ x: nx, y: ny, width: nw + PIN_M * 2, height: nh + PIN_M * 2 });
  it.bounds = w.getBounds(); saveStore();
});
ipcMain.on('pin-reset', e => {
  const w = winOf(e); const it = w && byId(w.pinId); if (!w || !it) return;
  const b = w.getBounds(); const { w: nw, h: nh } = naturalSize(it);
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  w.setBounds({ x: Math.round(cx - nw / 2 - PIN_M), y: Math.round(cy - nh / 2 - PIN_M), width: nw + PIN_M * 2, height: nh + PIN_M * 2 });
  it.bounds = w.getBounds(); saveStore();
});
ipcMain.on('pin-opacity', (e, v) => { const w = winOf(e); const it = w && byId(w.pinId); if (!w || !it) return; it.opacity = Math.max(0.2, Math.min(1, v)); w.setOpacity(it.opacity); saveStore(); });
ipcMain.on('pin-hang', e => { const w = winOf(e); if (w) pinToRope(w.pinId); });
ipcMain.on('pin-delete', e => { const w = winOf(e); if (w) deleteItem(w.pinId); });
ipcMain.handle('pin-menu', e => new Promise(res => { const w = winOf(e); const it = w && byId(w.pinId); if (!it) return res(); itemMenu(it, w, true).popup({ window: w, callback: () => res() }); }));
ipcMain.on('open-item', (e, id) => { const it = byId(id); if (!it) return; if (it.url) shell.openExternal(it.url); else if (it.path) shell.openPath(it.path); });

/* ---------------- first run: a few example cards that explain the app ---------------- */
function seedExamples() {
  const now = Date.now();
  const note = (text, color, rx, title) => ({ id: uid(), type: 'note', title, text, color, rx, state: 'rope', created: now });
  const image = (file, title, rx, ratio) => {
    const id = uid(), dest = path.join(ITEMS_DIR(), id + '.png');
    try { fs.copyFileSync(path.join(__dirname, 'samples', file), dest); } catch (e) { return null; }
    return { id, type: 'image', title, path: dest, ratio, rx, state: 'rope', created: now };
  };
  const list = [
    note('你好，这是晾晾\n\n截图、复制的文件、文字和链接，都可以挂在这根绳子上，随用随取。\n\n这几张都是示例，点卡片右上角的 × 就能删掉。', 1, .2, '欢迎（示例）'),
    image('shot.png', '示例截图', .32, 1.6),
    note('怎么用\n· 单击卡片：复制\n· 双击 / 点夹子：钉到屏幕上\n· 往下拖：拖进微信、文件夹\n· 沿绳子拖：挂到任意位置\n· 拽一下绳子试试', 4, .44, '怎么用（示例）'),
    image('palette.png', '示例图片', .56, 600 / 760),
    note('换个样子\n点绳子右端的「⋯」：\n· 7 套皮肤：爱心吊坠、汽水泡泡、小机甲巡逻…\n· 绳子放屏幕上边、左边或右边\n· 选全自动 / 只收截图 / 只靠拖拽', 2, .68, '换皮肤（示例）'),
    note(`快捷键\n${KEY.s}  截图\n${KEY.v}  把剪贴板挂上去\n${KEY.t}  放下 / 收起绳子${IS_MAC ? '\n⌘⇧4 截的图也会自己挂上来' : ''}`, 3, .8, '快捷键（示例）'),
  ].filter(Boolean);
  store.items.push(...list); renumber(ropeItems()); saveStore(true);
}

/* ---------------- lifecycle ---------------- */
app.on('second-instance', () => { if (rope) rope.webContents.send('toggle', true); });
app.whenReady().then(() => {
  if (IS_MAC && app.dock) app.dock.hide();
  debugLog(`start ${app.getVersion()} ${process.platform} scale=${screen.getPrimaryDisplay().scaleFactor}`);
  const migrated = migrateFromPinly();
  loadStore();
  fs.mkdirSync(ITEMS_DIR(), { recursive: true });
  if (store.settings.openAtLogin) { try { app.setLoginItemSettings({ openAtLogin: true }); } catch (e) {} }
  if (!store.items.length && !fs.existsSync(STORE())) seedExamples();
  createRope();
  if (migrated) rope.webContents.once('did-finish-load', () => setTimeout(() => { rope.webContents.send('toggle', true); rope.webContents.send('toast', '已把 Pinly 里的东西搬过来了，旧的 Pinly 可以卸载啦'); }, 1200));
  buildTray();
  try { globalShortcut.register('Control+Alt+T', () => rope && rope.webContents.send('toggle')); } catch (e) {}
  try { globalShortcut.register('Control+Alt+S', snip); } catch (e) {}
  try { globalShortcut.register('Control+Alt+V', hangClipboardNow); } catch (e) {}
  store.items.filter(i => i.state === 'pin').forEach(it => openPin(it));
  pollClipboard();
  setInterval(pollClipboard, 600);
  if (IS_MAC) watchMacScreenshots();
  setInterval(pollCursor, 70);
  setInterval(expireGhosts, 250);
  screen.on('display-metrics-changed', () => rope && rope.setBounds(ropeBounds()));
  screen.on('display-added', () => rope && rope.setBounds(ropeBounds()));
  screen.on('display-removed', () => rope && rope.setBounds(ropeBounds()));
});
app.on('window-all-closed', e => { /* keep running in the tray */ });
app.on('before-quit', () => { app.isQuitting = true; for (const [id, w] of pins) { const it = byId(id); if (it && !w.isDestroyed()) it.bounds = w.getBounds(); } saveStore(true); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (trash) removeFiles(trash); });
