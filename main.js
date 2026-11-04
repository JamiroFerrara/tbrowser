'use strict';

const { app, BaseWindow, WebContentsView, session, ipcMain, Menu, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { parseInput, parseCommand } = require('./lib/commands');
const { DEFAULTS, loadConfig, normalize, compileKeybindings, matchesAny, parseBindingText } = require('./lib/config');
const { loadExtensions } = require('./lib/extensions');
const { enableAdblock } = require('./lib/adblock');
const { Visits } = require('./lib/history');
const { suggestions } = require('./lib/suggest');

const BAR_HEIGHT = 44;
const BAR_ROW = 32;
const BAR_PAD = 8;
const SIDEBAR_WIDTH = 220;
const PARTITION = 'persist:tbrowser';
const HOME = 'about:blank';
const PERSIST_DELAY = 250;
const START = Date.now();
const mark = (label) => {
  if (process.env.TBROWSER_TIMING) console.log(`[tbrowser] ${label} +${Date.now() - START}ms`);
};
const URL_RE = /^(https?|file|about):/i;

let win; // BaseWindow
let ses; // persistent session
let bar; // command bar
let panel; // :extensions / :settings
let sidebar; // tab list
let config;
let configPath;
let visited; // visited pages + favourites, ranked by frecency
let keys; // keybindings pre-parsed once
let state = {};
let extensionDirs = [];
let persistTimer = null;
let sessionReady = null;
let creatingWindow = null;

// The config file is the only source of truth: `configSnapshot` is the text
// this process last wrote or read, so a watcher event that merely echoes our
// own save applies nothing.
let configSnapshot = '';
let configWatcher = null;
let configWatchTimer = null;
let adblockBlocker = null; // built-in engine, when it is the one blocking
let adblockExtension = false; // a blocking extension loaded, so the engine stays off

const tabs = new Map();
let activeTabId = null;
let nextTabId = 1;

let barVisible = false;
let barHeight = BAR_HEIGHT;
let panelVisible = false;
let panelReady = null;
let currentPanel = null;
// The settings page is a form: while a field has focus, a typed ":" or "ctrl+w"
// belongs to the field, not to the shortcut table.
let panelEditing = false;
let sidebarVisible = true;
let sidebarLoaded = false;
let sidebarReady = null;
let sidebarAttached = false;
let sidebarWidth = SIDEBAR_WIDTH; // animated pixels currently on screen
let sidebarTimer = null;
const SIDEBAR_ANIM_MS = 160;

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

function tabsState() {
  return {
    tabs: [...tabs.values()].map((tab) => tab.view?.webContents.getURL() || tab.url || HOME),
    activeTab: [...tabs.keys()].indexOf(activeTabId),
    sidebar: sidebarVisible,
  };
}

function persistTabsNow() {
  saveState(tabsState());
}

/**
 * Navigation fires did-navigate on every page in every tab; writing the state
 * file synchronously there put disk I/O on the main thread mid-page-load.
 * Coalesce the writes instead, and flush synchronously when the window closes.
 */
function persistTabs() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistTabsNow();
  }, PERSIST_DELAY);
}

function layout() {
  const [width, height] = win.getContentSize();
  const barPixels = barVisible ? Math.round(barHeight) : 0;
  const sideWidth = Math.max(0, Math.round(sidebarWidth));
  const contentWidth = Math.max(0, width - sideWidth);
  const contentHeight = Math.max(0, height - barPixels);

  // The sidebar keeps its full width and slides out of the left edge, so its
  // contents are clipped by the window rather than reflowing every frame.
  if (sidebarAttached && sidebar) {
    sidebar.setBounds({ x: sideWidth - SIDEBAR_WIDTH, y: 0, width: SIDEBAR_WIDTH, height });
  }
  const tab = activeTab();
  if (tab?.view) tab.view.setBounds({ x: sideWidth, y: 0, width: contentWidth, height: contentHeight });
  if (panelVisible && panel) panel.setBounds({ x: sideWidth, y: 0, width: contentWidth, height: contentHeight });
  if (barVisible) bar.setBounds({ x: sideWidth, y: height - barPixels, width: contentWidth, height: barPixels });
}

function focusContent() {
  const target = panelVisible ? panel : activeTab()?.view;
  target?.webContents.focus();
}

function showBar({ command = false, search = false } = {}) {
  const url = activeTab()?.view?.webContents.getURL();
  const value = search ? ':s ' : command ? ':' : url && url !== 'about:blank' ? url : '';
  barHeight = BAR_HEIGHT;
  if (barVisible) {
    bar.webContents.send('bar:edit', value, command || search);
    bar.webContents.focus();
    return;
  }
  barVisible = true;
  win.contentView.addChildView(bar);
  layout();
  bar.webContents.send('bar:edit', value, command || search);
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
  tabView(tab).webContents.loadURL(url).catch((err) => {
    console.warn(`[tbrowser] navigation failed: ${err.message}`);
  });
}

function go(delta) {
  const tab = activeTab();
  if (!tab?.view) return;
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
  const url = tab.view ? tab.view.webContents.getURL() : tab.url;
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
    if (tab.url) visited.retitle(tab.url, title);
    if (tab.id === activeTabId) win.setTitle(title ? `${title} — tbrowser` : 'tbrowser');
    updateSidebar();
  });
  wc.on('did-navigate', (_event, url) => {
    tab.url = url;
    visited.record(url, tab.title);
    if (tab.id === activeTabId) persistTabs();
  });
  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    tab.url = url;
    visited.record(url, tab.title);
    if (tab.id === activeTabId) persistTabs();
  });
  watchKeys(wc);
}

/** Create a tab's renderer on first use; a restored tab costs nothing until then. */
function tabView(tab) {
  if (tab.view) return tab.view;
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  tab.view = view;
  wireTab(tab);
  view.webContents.loadURL(tab.url || HOME).catch(() => {});
  return view;
}

function createTab({ url = HOME, activate = true, openBar = false } = {}) {
  const id = nextTabId++;
  const tab = { id, view: null, title: '', url };
  tabs.set(id, tab);
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
  if (previous && previous.id !== id && previous.view) win.contentView.removeChildView(previous.view);
  activeTabId = id;
  const view = tabView(tab);
  win.contentView.addChildView(view);
  layout();
  view.webContents.focus();
  win.setTitle(tab.title ? `${tab.title} — tbrowser` : 'tbrowser');
  updateSidebar();
  persistTabs();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  tabs.delete(id);
  if (tab.view) {
    win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
  }

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
  if (visible === sidebarVisible) return;
  sidebarVisible = visible;
  if (visible) {
    const view = ensureSidebar();
    if (!sidebarAttached) {
      win.contentView.addChildView(view);
      sidebarAttached = true;
    }
  }
  animateSidebar(visible ? SIDEBAR_WIDTH : 0);
  persistTabs();
}

/**
 * Slide the sidebar by moving the page's left edge; the sidebar view keeps its
 * width and travels off the window edge, so its contents are clipped instead
 * of reflowing on every frame.
 */
function animateSidebar(target) {
  const from = sidebarWidth;
  const started = Date.now();
  clearInterval(sidebarTimer);
  sidebarTimer = setInterval(() => {
    const t = Math.min(1, (Date.now() - started) / SIDEBAR_ANIM_MS);
    sidebarWidth = from + (target - from) * (1 - (1 - t) ** 3);
    layout();
    if (t < 1) return;
    clearInterval(sidebarTimer);
    sidebarTimer = null;
    sidebarWidth = target;
    layout();
    if (!sidebarVisible && sidebarAttached) {
      win.contentView.removeChildView(sidebar);
      sidebarAttached = false;
      layout();
    }
  }, 16);
}

function pressShortcut(input) {
  if (panelVisible && panelEditing) return false;
  if (!barVisible) {
    // Only a handful of openers; the rest of the table is matched without
    // re-parsing accelerator strings on every keystroke.
    const index = keys.openBar.findIndex((expected) => matchesAny(input, [expected]));
    if (index !== -1) {
      // ":" lands in vim's command line, and its first command is the search:
      // every keystroke after ":s " is the query.
      showBar({ search: config.keybindings.openBar[index] === ':' });
      return true;
    }
    if (keys.search?.length && matchesAny(input, keys.search)) {
      showBar({ search: true });
      return true;
    }
  }
  if (barVisible && matchesAny(input, keys.closeBar)) {
    hideBar();
    return true;
  }
  if (panelVisible && matchesAny(input, keys.closeBar)) {
    closePanel();
    return true;
  }
  if (matchesAny(input, keys.reload)) {
    activeTab()?.view?.webContents.reload();
    return true;
  }
  if (matchesAny(input, keys.back)) {
    go(-1);
    return true;
  }
  if (matchesAny(input, keys.forward)) {
    go(1);
    return true;
  }
  if (matchesAny(input, keys.newTab)) {
    createTab({ openBar: true });
    return true;
  }
  if (matchesAny(input, keys.closeTab)) {
    if (activeTab()) closeTab(activeTabId);
    return true;
  }
  if (matchesAny(input, keys.nextTab)) {
    cycleTab(1);
    return true;
  }
  if (matchesAny(input, keys.prevTab)) {
    cycleTab(-1);
    return true;
  }
  if (matchesAny(input, keys.toggleSidebar)) {
    setSidebar(!sidebarVisible);
    return true;
  }
  if (matchesAny(input, keys.devtools)) {
    const target = barVisible ? bar : activeTab()?.view;
    target?.webContents.toggleDevTools();
    return true;
  }
  if (matchesAny(input, keys.closeWindow)) {
    win.close();
    return true;
  }
  if (matchesAny(input, keys.quit)) {
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

function ensurePanel() {
  if (panel) return panel;
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
  panelReady = panel.webContents.loadFile(path.join(__dirname, 'ui', 'panel.html'));
  return panel;
}

function ensureSidebar() {
  if (sidebar) return sidebar;
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
  sidebarReady = sidebar.webContents.loadFile(path.join(__dirname, 'ui', 'sidebar.html')).then(() => {
    sidebarLoaded = true;
    updateSidebar();
  });
  return sidebar;
}

async function openPanel(page) {
  const view = ensurePanel();
  await panelReady;
  if (!panelVisible) {
    panelVisible = true;
    win.contentView.addChildView(view);
  }
  currentPanel = page;
  layout();
  view.webContents.send('panel:show', page);
  view.webContents.focus();
}

function closePanel() {
  if (!panelVisible) return;
  panelVisible = false;
  panelEditing = false;
  win.contentView.removeChildView(panel);
  layout();
  focusContent();
}

function runCommand(command) {
  switch (command.name) {
    case 's': {
      const query = command.args.join(' ').trim();
      if (!query) return 'nothing to search';
      hideBar();
      navigate(`${config.searchUrl}${encodeURIComponent(query)}`);
      return null;
    }
    case 'fav': {
      const tab = activeTab();
      const url = tab?.view?.webContents.getURL();
      if (!url || url === HOME) return 'nothing to favourite';
      const added = visited.toggleFavourite(url, tab.title ?? '');
      bar.webContents.send('bar:notice', added ? '★ added to favourites' : '★ removed from favourites');
      return null;
    }
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
      return `unknown command: ${command.name || ':'} — try :s, :fav, :extensions or :settings`;
  }
}

/**
 * Everything a window needs from the session — extensions, the adblock engine,
 * the persistent partition — is done once per process. Reopening a window
 * (the resident daemon case) skips all of it.
 */
function prepareSession() {
  if (sessionReady) return sessionReady;
  sessionReady = (async () => {
    ses = session.fromPartition(PARTITION);
    extensionDirs = [
      path.join(__dirname, 'extensions'),
      path.join(__dirname, 'vendor'),
      path.join(app.getPath('userData'), 'extensions'),
    ];
    fs.mkdirSync(extensionDirs[2], { recursive: true });
    const extensions = await loadExtensions(ses, extensionDirs);
    // uBlock Origin is vendored and does its own blocking through the same
    // webRequest hooks; the built-in engine only stands in for it when the
    // extension did not load.
    adblockExtension = extensions.some((extension) => extension.name === 'uBlock Origin');
    // A cold cache downloads and parses filter lists; the first page must not
    // wait for that. Blocking switches on as soon as the engine is ready.
    syncAdblock().catch((err) => console.warn(`[tbrowser] adblock start failed: ${err.message}`));
  })();
  return sessionReady;
}

/**
 * The built-in adblock engine follows `config.adblock` while the browser runs:
 * switched on it loads the cached filter lists, switched off it unhooks. A
 * blocking extension that loaded owns the session, so the engine stays out.
 */
async function syncAdblock() {
  if (!ses || adblockExtension) return;
  if (config.adblock) {
    if (!adblockBlocker) adblockBlocker = await enableAdblock(ses, app.getPath('userData'));
    return;
  }
  if (adblockBlocker) {
    adblockBlocker.disableBlockingInSession(ses);
    adblockBlocker = null;
  }
}

/** Adopt a config object everywhere it is read, live. */
function applyConfig(next, origin) {
  config = next;
  keys = compileKeybindings(config.keybindings);
  syncAdblock().catch((err) => console.warn(`[tbrowser] adblock switch failed: ${err.message}`));
  if (panelVisible && panel && origin !== 'panel') panel.webContents.send('settings:changed', { config, origin });
  if (origin === 'disk') bar?.webContents.send('bar:notice', 'settings reloaded from config.json');
}

/** Write the config file, and remember the text so the watcher ignores it. */
function saveConfigFile(next) {
  const text = `${JSON.stringify(next, null, 2)}\n`;
  fs.writeFileSync(configPath, text);
  configSnapshot = text;
}

/** Apply an edit made outside the browser, keeping the last good config. */
function reloadConfigFromDisk() {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return; // the file is mid-replace; the next event brings it back
  }
  if (text === configSnapshot) return;
  configSnapshot = text;
  let parsed;
  try {
    parsed = normalize(JSON.parse(text));
  } catch (err) {
    console.warn(`[tbrowser] config change ignored: ${err.message}`);
    bar?.webContents.send('bar:error', `config.json not applied: ${err.message}`);
    return;
  }
  if (JSON.stringify(parsed) === JSON.stringify(config)) return;
  applyConfig(parsed, 'disk');
}

/**
 * Watch the directory, not the file: an editor that saves by renaming a temp
 * file over config.json replaces the inode, and a file watcher would stop
 * hearing about it. Bursts of events settle into one reload.
 */
function startConfigWatch() {
  if (configWatcher || !configPath) return;
  const dir = path.dirname(configPath);
  const name = path.basename(configPath);
  try {
    configWatcher = fs.watch(dir, (_event, filename) => {
      if (filename && filename !== name) return;
      clearTimeout(configWatchTimer);
      configWatchTimer = setTimeout(reloadConfigFromDisk, 200);
    });
  } catch (err) {
    console.warn(`[tbrowser] cannot watch ${dir}: ${err.message}`);
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
    backgroundColor: '#1b1b1b',
  });
  restoreBounds();

  win.on('resize', layout);
  win.on('close', () => {
    persistTabsNow();
    saveState({ bounds: win.getBounds() });
  });
  win.on('closed', () => {
    for (const tab of tabs.values()) tab.view?.webContents.close();
    tabs.clear();
    activeTabId = null;
    for (const view of [bar, panel, sidebar]) view?.webContents.close();
    bar = undefined;
    panel = undefined;
    sidebar = undefined;
    barVisible = false;
    panelVisible = false;
    currentPanel = null;
    sidebarAttached = false;
    sidebarLoaded = false;
    panelReady = null;
    sidebarReady = null;
    win = undefined;
  });

  // The window is the launch: show it before the session, the bar or a page
  // exists, so nothing on the slow path can hold the first paint.
  win.show();
  mark('window shown');

  await prepareSession();
  mark('session ready');

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

  sidebarVisible = state.sidebar !== false;
  sidebarWidth = sidebarVisible ? SIDEBAR_WIDTH : 0;
  if (sidebarVisible) {
    const view = ensureSidebar();
    sidebarReady.then(() => {
      if (!win) return;
      win.contentView.addChildView(view);
      sidebarAttached = true;
      layout();
      updateSidebar();
    });
  }

  const savedTabs = Array.isArray(state.tabs)
    ? state.tabs.filter((url) => typeof url === 'string' && URL_RE.test(url))
    : [];
  const startUrls = savedTabs.length ? savedTabs : [HOME];
  startUrls.forEach((url, index) => createTab({ url, activate: index === 0 }));
  if (typeof state.activeTab === 'number') {
    const ids = [...tabs.keys()];
    if (ids[state.activeTab] !== undefined) activateTab(ids[state.activeTab]);
  }

  layout();
  focusContent();
  updateSidebar();
  mark('page created');
  if (!savedTabs.length) showBar();

  // Warm the panel after the window is up: its first open then costs nothing.
  setImmediate(() => {
    if (win && !panel) ensurePanel();
  });
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

/**
 * Rows for the dropdown. The bar view grows upward to hold them, and the page
 * gives up the same pixels, so the list never covers the page it is over.
 */
ipcMain.handle('bar:suggest', (_event, text) => {
  const items = suggestions(text, {
    history: visited.list(),
    favourites: visited.favourites(),
    searchUrl: config.searchUrl,
  });
  barHeight = BAR_HEIGHT + (items.length ? items.length * BAR_ROW + BAR_PAD : 0);
  layout();
  return items;
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
  return { config, configPath, defaults: DEFAULTS, dirs: extensionDirs };
});
/**
 * The settings page sends the whole form: three scalars and every keybinding
 * as the text the user typed. Bindings are parsed here, so a row that does not
 * parse refuses the save by name instead of being dropped on the floor.
 */
ipcMain.handle('settings:save', (_event, patch) => {
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'invalid settings' };
  const keybindings = { ...config.keybindings };
  for (const [action, text] of Object.entries(patch.keybindings ?? {})) {
    const parsed = parseBindingText(text);
    if (!parsed.ok) return { ok: false, error: `${action}: ${parsed.error}` };
    keybindings[action] = parsed.list;
  }
  const next = normalize({ ...config, ...patch, keybindings });
  try {
    saveConfigFile(next);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  applyConfig(next, 'panel');
  return { ok: true, config };
});
ipcMain.handle('panel:rescan', async () => {
  await loadExtensions(ses, extensionDirs);
  return { extensions: listExtensions(), dirs: extensionDirs };
});
ipcMain.on('panel:close', () => closePanel());
ipcMain.on('panel:editing', (_event, editing) => {
  panelEditing = Boolean(editing);
});
ipcMain.on('panel:open-path', (_event, target) => {
  if (target === configPath) shell.showItemInFolder(configPath);
  else if (extensionDirs.includes(target)) shell.openPath(target);
});

/** Focus the open window, or build one — the instant path on a warm process. */
function showWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    return Promise.resolve();
  }
  if (!creatingWindow) {
    creatingWindow = createWindow().finally(() => {
      creatingWindow = null;
    });
  }
  return creatingWindow;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow().catch((err) => console.error(`[tbrowser] reopen failed: ${err.message}`));
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.tbrowser.app');
    Menu.setApplicationMenu(null);
    state = readState();
    configPath = path.join(app.getPath('userData'), 'config.json');
    config = loadConfig(app.getPath('userData'));
    try {
      configSnapshot = fs.readFileSync(configPath, 'utf8');
    } catch {
      configSnapshot = '';
    }
    keys = compileKeybindings(config.keybindings);
    visited = new Visits(app.getPath('userData'));
    startConfigWatch();
    return showWindow();
  });
}

// With the default resident daemon, closing the last window parks the process
// instead of paying Electron's cold start on the next launch.
app.on('window-all-closed', () => {
  if (!config?.resident) app.quit();
});
