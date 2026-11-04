'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panel', {
  get: (page) => ipcRenderer.invoke('panel:get', page),
  rescan: () => ipcRenderer.invoke('panel:rescan'),
  saveConfig: (json) => ipcRenderer.invoke('panel:save-config', json),
  close: () => ipcRenderer.send('panel:close'),
  openPath: (target) => ipcRenderer.send('panel:open-path', target),
  onShow: (callback) => ipcRenderer.on('panel:show', (_event, page) => callback(page)),
});
