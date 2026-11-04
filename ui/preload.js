'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tb', {
  submit: (text) => ipcRenderer.send('bar:submit', text),
  hide: () => ipcRenderer.send('bar:hide'),
  onEdit: (callback) => ipcRenderer.on('bar:edit', (_event, value, command) => callback(value, command)),
  onError: (callback) => ipcRenderer.on('bar:error', (_event, message) => callback(message)),
});
