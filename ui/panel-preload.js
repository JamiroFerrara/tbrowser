'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panel', {
  get: (page) => ipcRenderer.invoke('panel:get', page),
  rescan: () => ipcRenderer.invoke('panel:rescan'),
  extension: (request) => ipcRenderer.invoke('panel:extension', request),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  sessions: (request) => ipcRenderer.invoke('sessions:action', request),
  favourites: (request) => ipcRenderer.invoke('favourites:action', request),
  close: () => ipcRenderer.send('panel:close'),
  setEditing: (editing) => ipcRenderer.send('panel:editing', editing),
  openPath: (target) => ipcRenderer.send('panel:open-path', target),
  onShow: (callback) => ipcRenderer.on('panel:show', (_event, page) => callback(page)),
  onSettingsChanged: (callback) => ipcRenderer.on('settings:changed', (_event, data) => callback(data)),
  onSessionsChanged: (callback) => ipcRenderer.on('sessions:changed', (_event, data) => callback(data)),
  onFavouritesChanged: (callback) => ipcRenderer.on('favourites:changed', (_event, data) => callback(data)),
});
