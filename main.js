'use strict';

const { app, BaseWindow, WebContentsView, session, ipcMain, Menu, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { parseInput, parseCommand } = require('./lib/commands');
const { loadConfig, normalize, matches } = require('./lib/config');
const { loadExtensions } = require('./lib/extensions');
const { enableAdblock } = require('./lib/adblock');

const BAR_HEIGHT = 44;
const SIDEBAR_WIDTH = 220;
const PARTITION = 'persist:tbrowser';
const HOME = 'about:blank';
const URL_RE = /^(https?|file|about):/i;

let win; // BaseWindow
let ses; // persistent session
let bar; // command bar
let panel; // :extensions / :settings
let sidebar; // tab list
let config;
let configPath;
let state = {};
let extensionDirs = [];

const tabs = new Map();
let activeTabId = null;
let nextTabId = 1;

let barVisible = false;
let panelVisible = false;
let currentPanel = null;
let sidebarVisible = true;
let sidebarLoaded = false;

const stateFile = () => path.join(app.getPath('userData'), 'state.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveState(patch) {
  state = { ...state, ...patch };
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state));
  } catch (err) {
    console.warn(`[tbrowser] could not save state: ${err.message}`);
  }
}

const activeTab = () => tabs.get(activeTabId);

function persistTabs() {
  saveState({
    tabs: [...tabs.values()].map((tab) => tab.view.webContents.getURL() || tab.url || HOME),
    activeTab: [...tabs.keys()].indexOf(activeTabId),
    sidebar: sidebarVisible,
  });
}

function layout() {
  const [width, height] = win.getContentSize();
  const barHeight = barVisible ? BAR_HEIGHT : 0;
  const sideWidth = sidebarVisible ? SIDEBAR_WIDTH : 0;
  const contentWidth = Math.max(0, width - sideWidth);
  const contentHeight = Math.max(0, height - barHeight);

  if (sidebarVisible && sidebar) sidebar.setBounds({ x: 0, y: 0, width: sideWidth, height });
  const tab = activeTab();
  if (tab) tab.view.setBounds({ x: sideWidth, y: 0, width: contentWidth, height: contentHeight });
  if (panelVisible) panel.setBounds({ x: sideWidth, y: 0, width: contentWidth, height: contentHeight });
  if (barVisible) bar.setBounds({ x: sideWidth, y: height - BAR_HEIGHT, width: contentWidth, height: BAR_HEIGHT });
}

function focusContent() {
  const target = panelVisible ? panel : activeTab()?.view;
  target?.webContents.focus();
}

function showBar({ command = false } = {}) {
  const url = activeTab()?.view.webContents.getURL();
  const value = command ? ':' : url && url !== 'about:blank' ? url : '';
  if (barVisible) {
    bar.webContents.send('bar:edit', value, command);
    bar.webContents.focus();
    return;
  }
  barVisible = true;
  win.contentView.addChildView(bar);
  layout();
  bar.webContents.send('bar:edit', value, command);
  bar.webContents.focus();
}

function hideBar({ focusPage = true } = {}) {
  if (!barVisible) return;
  barVisible = false;
  win.contentView.removeChildView(bar);
  layout();
  if (focusPage) focusContent();
}

function navigate(raw) {
  const url = parseInput(raw, config.searchUrl);
  const tab = activeTab();
  if (!url || !tab) return;
  tab.view.webContents.loadURL(url).catch((err) => {
    console.warn(`[tbrowser] navigation failed: ${err.message}`);
  });
}

function go(delta) {
  const tab = activeTab();
  if (!tab) return;
  const history = tab.view.webContents.navigationHistory;
  if (delta < 0 && history.canGoBack()) history.goBack();
  if (delta > 0 && history.canGoForward()) history.goForward();
}

function updateSidebar() {
  if (!sidebar || !sidebarLoaded) return;
  sidebar.webContents.send(
    'tabs:update',
    [...tabs.values()].map((tab) => ({
      id: tab.id,
      title: tab.title || titleFor(tab),
      active: tab.id === activeTabId,
    })),
  );
}

function titleFor(tab) {
  const url = tab.view.webContents.getURL();
  if (!url || url === HOME) return 'New tab';
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function wireTab(tab) {
  const wc = tab.view.webContents;

  wc.setWindowOpenHandler(({ url }) => {
    if (URL_RE.test(url)) createTab({ url });
    return { action: 'deny' };
  });
  wc.on('page-title-updated', (event, title) => {
    event.preventDefault();
    tab.title = title;
    if (tab.id === activeTabId) win.setTitle(title ? `${title} — tbrowser` : 'tbrowser');
    updateSidebar();
  });
  wc.on('did-navigate', (_event, url) => {
    tab.url = url;
    if (tab.id === activeTabId) persistTabs();
  });
  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    tab.url = url;
    if (tab.id === activeTabId) persistTabs();
  });
  watchKeys(wc);
}

function createTab({ url = HOME, activate = true, openBar = false } = {}) {
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  const id = nextTabId++;
  const tab = { id, view, title: '', url };
  tabs.set(id, tab);
  wireTab(tab);
  view.webContents.loadURL(url).catch(() => {});
  if (activate) activateTab(id);
  updateSidebar();
  persistTabs();
  if (openBar) showBar();
  return tab;
}

function activateTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  const previous = activeTab();
  if (previous && previous.id !== id) win.contentView.removeChildView(previous.view);
  activeTabId = id;
  win.contentView.addChildView(tab.view);
  layout();
  tab.view.webContents.focus();
  win.setTitle(tab.title ? `${tab.title} — tbrowser` : 'tbrowser');
  updateSidebar();
  persistTabs();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  tabs.delete(id);
  win.contentView.removeChildView(tab.view);
  tab.view.webContents.close();

  if (activeTabId === id) {
    activeTabId = null;
    const next = [...tabs.keys()].pop();
    if (next === undefined) {
      win.close();
      return;
    }
    activateTab(next);
  }
  updateSidebar();
  persistTabs();
}

function cycleTab(delta) {
  const ids = [...tabs.keys()];
  if (ids.length < 2) return;
  const index = ids.indexOf(activeTabId);
  activateTab(ids[(index + delta + ids.length) % ids.length]);
}

function setSidebar(visible) {
  sidebarVisible = visible;
  if (visible) win.contentView.addChildView(sidebar);
  else win.contentView.removeChildView(sidebar);
  layout();
  persistTabs();
}

function pressShortcut(input) {
  const keys = config.keybindings;

  if (!barVisible) {
    const opener = keys.openBar.find((accelerator) => matches(input, accelerator));
    if (opener) {
      showBar({ command: opener === ':' });
      return true;
    }
  }
  if (barVisible && matches(input, keys.closeBar)) {
    hideBar();
    return true;
  }
  if (panelVisible && matches(input, keys.closeBar)) {
    closePanel();
    return true;
  }
  if (matches(input, keys.reload)) {
    activeTab()?.view.webContents.reload();
    return true;
  }
  if (matches(input, keys.back)) {
    go(-1);
    return true;
  }
  if (matches(input, keys.forward)) {
    go(1);
    return true;
  }
  if (matches(input, keys.newTab)) {
    createTab({ openBar: true });
    return true;
  }
  if (matches(input, keys.closeTab)) {
    if (activeTab()) closeTab(activeTabId);
    return true;
  }
  if (matches(input, keys.nextTab)) {
    cycleTab(1);
    return true;
  }
  if (matches(input, keys.prevTab)) {
    cycleTab(-1);
    return true;
  }
  if (matches(input, keys.toggleSidebar)) {
    setSidebar(!sidebarVisible);
    return true;
  }
  if (matches(input, keys.devtools)) {
    const target = barVisible ? bar : activeTab()?.view;
    target?.webContents.toggleDevTools();
    return true;
  }
  if (matches(input, keys.closeWindow)) {
    win.close();
    return true;
  }
  if (matches(input, keys.quit)) {
    app.quit();
    return true;
  }
  return false;
}

function watchKeys(webContents) {
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    if (pressShortcut(input)) event.preventDefault();
  });
}

function restoreBounds() {
  const bounds = state.bounds;
  if (
    bounds &&
    ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key])) &&
    bounds.width >= 400 &&
    bounds.height >= 240
  ) {
    win.setBounds(bounds);
  }
}

function listExtensions() {
  return ses.extensions.getAllExtensions().map((extension) => ({
    id: extension.id,
    name: extension.name,
    version: extension.version,
    path: extension.path,
  }));
}

async function openPanel(page) {
  if (!panelVisible) {
    panelVisible = true;
    win.contentView.addChildView(panel);
  }
  currentPanel = page;
  layout();
  panel.webContents.send('panel:show', page);
  panel.webContents.focus();
}

function closePanel() {
  if (!panelVisible) return;
  panelVisible = false;
  win.contentView.removeChildView(panel);
  layout();
  focusContent();
}

function runCommand(command) {
  switch (command.name) {
    case 'ext':
    case 'extensions':
      hideBar();
      openPanel('extensions');
      return null;
    case 'settings':
    case 'config':
      hideBar();
      openPanel('settings');
      return null;
    default:
      return `unknown command: ${command.name || ':'} — try :extensions or :settings`;
  }
}

async function createWindow() {
  win = new BaseWindow({
    frame: false,
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 240,
    show: false,
    title: 'tbrowser',
  });
  restoreBounds();

  ses = session.fromPartition(PARTITION);
  extensionDirs = [
    path.join(__dirname, 'extensions'),
    path.join(__dirname, 'vendor'),
    path.join(app.getPath('userData'), 'extensions'),
  ];
  fs.mkdirSync(extensionDirs[2], { recursive: true });
  await loadExtensions(ses, extensionDirs);
  if (config.adblock) await enableAdblock(ses, app.getPath('userData'));

  bar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  watchKeys(bar.webContents);
  await bar.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'));

  panel = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'panel-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  watchKeys(panel.webContents);
  await panel.webContents.loadFile(path.join(__dirname, 'ui', 'panel.html'));

  sidebar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'sidebar-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  sidebar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  watchKeys(sidebar.webContents);
  await sidebar.webContents.loadFile(path.join(__dirname, 'ui', 'sidebar.html'));
  sidebarLoaded = true;

  sidebarVisible = state.sidebar !== false;
  if (sidebarVisible) win.contentView.addChildView(sidebar);

  const savedTabs = Array.isArray(state.tabs)
    ? state.tabs.filter((url) => typeof url === 'string' && URL_RE.test(url))
    : [];
  const startUrls = savedTabs.length ? savedTabs : [HOME];
  startUrls.forEach((url, index) => createTab({ url, activate: index === 0 }));
  if (typeof state.activeTab === 'number') {
    const ids = [...tabs.keys()];
    if (ids[state.activeTab] !== undefined) activateTab(ids[state.activeTab]);
  }

  win.on('resize', layout);
  win.on('close', () => {
    persistTabs();
    saveState({ bounds: win.getBounds() });
  });
  layout();

  win.show();
  focusContent();
  updateSidebar();
  if (!savedTabs.length) showBar();
}

ipcMain.on('bar:submit', (_event, text) => {
  const command = parseCommand(text);
  if (command) {
    const error = runCommand(command);
    if (error) bar.webContents.send('bar:error', error);
    return;
  }
  hideBar();
  navigate(text);
});
ipcMain.on('bar:hide', () => hideBar());

ipcMain.on('sidebar:action', (_event, action) => {
  if (!action || typeof action !== 'object') return;
  const id = Number(action.id);
  if (action.type === 'activate') activateTab(id);
  else if (action.type === 'close') closeTab(id);
  else if (action.type === 'new') createTab({ openBar: true });
});

ipcMain.handle('panel:get', (_event, page) => {
  if (page === 'extensions') return { extensions: listExtensions(), dirs: extensionDirs };
  return { config, configPath, dirs: extensionDirs };
});
ipcMain.handle('panel:save-config', (_event, json) => {
  try {
    const next = normalize(JSON.parse(json));
    fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
    config = next;
    return { ok: true, config };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('panel:rescan', async () => {
  await loadExtensions(ses, extensionDirs);
  return { extensions: listExtensions(), dirs: extensionDirs };
});
ipcMain.on('panel:close', () => closePanel());
ipcMain.on('panel:open-path', (_event, target) => {
  if (target === configPath) shell.showItemInFolder(configPath);
  else if (extensionDirs.includes(target)) shell.openPath(target);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.tbrowser.app');
    Menu.setApplicationMenu(null);
    state = readState();
    configPath = path.join(app.getPath('userData'), 'config.json');
    config = loadConfig(app.getPath('userData'));
    return createWindow();
  });
}

app.on('window-all-closed', () => app.quit());
