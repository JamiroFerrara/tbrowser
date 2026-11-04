'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sidebar', {
  act: (type, id) => ipcRenderer.send('sidebar:action', { type, id }),
  onTabs: (callback) => ipcRenderer.on('tabs:update', (_event, tabs) => callback(tabs)),
});
