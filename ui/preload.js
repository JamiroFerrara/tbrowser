'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tb', {
  submit: (text) => ipcRenderer.send('bar:submit', text),
  hide: () => ipcRenderer.send('bar:hide'),
  suggest: (text) => ipcRenderer.invoke('bar:suggest', text),
  onEdit: (callback) => ipcRenderer.on('bar:edit', (_event, value, command) => callback(value, command)),
  onMove: (callback) => ipcRenderer.on('bar:move', (_event, delta) => callback(delta)),
  onError: (callback) => ipcRenderer.on('bar:error', (_event, message) => callback(message)),
  onNotice: (callback) => ipcRenderer.on('bar:notice', (_event, message) => callback(message)),
});
