'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = ['init', 'copy', 'undo-delete', 'read-file', 'read-text', 'card-menu', 'main-menu', 'add-paths', 'add-text', 'pin-init', 'pin-menu'];
const SEND = ['set-ignore', 'positions', 'set-setting', 'set-settings', 'pin', 'delete', 'set-meta', 'start-drag', 'snip', 'pin-move', 'pin-moved', 'pin-zoom', 'pin-reset', 'pin-opacity', 'pin-hang', 'pin-delete', 'open-item', 'quit', 'keep', 'pend-hold', 'log'];
const ON = ['rope', 'cursor', 'toggle', 'settings', 'toast', 'open-panel'];

contextBridge.exposeInMainWorld('pinly', {
  invoke: (ch, ...a) => INVOKE.includes(ch) ? ipcRenderer.invoke(ch, ...a) : Promise.reject(new Error('blocked ' + ch)),
  send: (ch, ...a) => { if (SEND.includes(ch)) ipcRenderer.send(ch, ...a); },
  on: (ch, fn) => { if (!ON.includes(ch)) return () => {}; const h = (_e, ...a) => fn(...a); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); },
  platform: process.platform,
  pathForFile: f => { try { return webUtils.getPathForFile(f); } catch (e) { return ''; } },
});
