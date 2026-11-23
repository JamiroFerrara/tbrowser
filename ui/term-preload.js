'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The terminal page's one way out of its own world.
 *
 * The terminal lives in this renderer — libghostty-vt in WebAssembly and a
 * canvas beside it — so what crosses this bridge is only what has to: the
 * bytes the shell wrote, the bytes a key types, the size of the pane, and the
 * clipboard.
 */
contextBridge.exposeInMainWorld('term', {
  /** Ask for the wasm module; it is read once by the main process. */
  wasm: () => ipcRenderer.invoke('term:wasm'),

  /** Start a shell in this pane. Replies `{ ok }` or `{ error }`. */
  start: (size) => ipcRenderer.invoke('term:start', size),
  resize: (size) => ipcRenderer.send('term:resize', size),

  /** Bytes for the shell: a key, a paste, a scroll report. */
  input: (bytes) => ipcRenderer.send('term:input', bytes),

  copy: (text) => ipcRenderer.send('term:copy', text),
  paste: () => ipcRenderer.invoke('term:paste'),
  title: (text) => ipcRenderer.send('term:title', text),

  onData: (callback) => ipcRenderer.on('term:data', (_event, bytes) => callback(new Uint8Array(bytes))),
  onExit: (callback) => ipcRenderer.on('term:exit', () => callback()),
  onError: (callback) => ipcRenderer.on('term:error', (_event, message) => callback(message)),
});
