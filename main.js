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
const CASCADE = 32; // pixels a new window steps off the one it opened over
const START = Date.now();
const mark = (label) => {
  if (!process.env.TBROWSER_TIMING) return;
  const line = `[tbrowser] ${label} +${Date.now() - START}ms`;
  console.log(line);
  // A packaged Windows app has no console: keep the same trace beside the
  // user data so a slow launch off the packed build can still be measured.
  try {
    const file = path.join(app.getPath('userData'), 'startup.log');
    if (label === 'main loaded') fs.writeFileSync(file, `${line}\n`);
    else fs.appendFileSync(file, `${line}\n`);
  } catch {
    // timing is diagnostic; never let it break the launch
  }
};
mark('main loaded');
const URL_RE = /^(https?|file|about):/i;

// Everything below is one per process: the session, the config the running
// browser obeys, and the history every window draws on.
let ses; // persistent session
let config;
let configPath;
let visited; // visited pages + favourites, ranked by frecency
let keys; // keybindings pre-parsed once
let extensionDirs = [];
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

// Every open window, and the view its keys and clicks arrive from.
const windows = new Set();
const viewOwners = new Map(); // webContents.id -> Browser
let remembered = null; // the last window's snapshot, kept while none are open
let nextWindowId = 1;

const stateFile = () => path.join(app.getPath('userData'), 'state.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(data) {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(data));
  } catch (err) {
    console.warn(`[tbrowser] could not save state: ${err.message}`);
  }
}

/**
 * The saved shapes: one snapshot per window now, a single flat one from the
 * version that only ever had one window. Both restore; the flat one restores
 * as the only window.
 */
function readSnapshots() {
  const saved = readState();
  if (Array.isArray(saved.windows) && saved.windows.length) {
    return saved.windows.filter((snapshot) => snapshot && typeof snapshot === 'object');
  }
  if (saved.tabs || saved.bounds) return [saved];
  return [];
}

/** Write what every open window is showing; with none open, the last one. */
function persistState() {
  const list = windows.size
    ? [...windows].map((window) => window.snapshot())
    : remembered
      ? [remembered]
      : [];
  writeState({ windows: list });
}

/** Route an IPC call back to the window whose view sent it. */
function ctxFor(event) {
  return viewOwners.get(event.sender.id);
}

function track(window, view) {
  const id = view.webContents.id;
  viewOwners.set(id, window);
  view.webContents.once('destroyed', () => viewOwners.delete(id));
}

class Browser {
  constructor(snapshot = {}) {
    this.id = nextWindowId++;
    this.saved = snapshot;
    this.win = null;

    this.tabs = new Map();
    this.activeTabId = null;
    this.nextTabId = 1;

    this.bar = undefined;
    this.barVisible = false;
    this.barHeight = BAR_HEIGHT;

    this.panel = undefined;
    this.panelVisible = false;
    this.panelReady = null;
    this.currentPanel = null;
    // The settings page is a form: while a field has focus, a typed ":" or
    // "ctrl+w" belongs to the field, not to the shortcut table.
    this.panelEditing = false;

    this.sidebar = undefined;
    this.sidebarVisible = snapshot.sidebar !== false;
    this.sidebarLoaded = false;
    this.sidebarReady = null;
    this.barLoaded = false;
    this.pendingBar = null;
    this.sidebarAttached = false;
    this.sidebarWidth = this.sidebarVisible ? SIDEBAR_WIDTH : 0;
    this.sidebarTimer = null;

    this.persistTimer = null;
    this.finalSnapshot = null;
  }

  // --------------------------------------------------------------- lifecycle

  open() {
    const win = new BaseWindow({
      frame: false,
      width: 1200,
      height: 800,
      minWidth: 400,
      minHeight: 240,
      show: false,
      title: 'tbrowser',
      backgroundColor: '#1b1b1b',
    });
    this.win = win;
    windows.add(this);

    this.restoreBounds();

    win.on('resize', () => this.layout());
    win.on('close', () => {
      this.finalSnapshot = this.snapshot();
      this.persistTabsNow();
    });
    win.on('closed', () => this.release());

    // The window is the launch: show it before the session, the bar or a page
    // exists, so nothing on the slow path can hold the first paint.
    win.show();
    mark('window shown');

    return this.build();
  }

  /**
   * Everything the window shows, built after it is already on screen. A second
   * window skips the cold work: `prepareSession` is a resolved promise by then,
   * and it starts with no saved tabs, so the bar is the only view it loads.
   */
  async build() {
    const win = this.win;
    await prepareSession();
    mark('session ready');

    const bar = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'ui', 'preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    this.bar = bar;
    track(this, bar);
    bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.watchKeys(bar.webContents);
    // The bar, the sidebar and the page are three renderer processes. Starting
    // them together costs the slowest one instead of their sum, which on
    // Windows is the difference between an instant page and a stalled one.
    const barReady = bar.webContents.loadFile(path.join(__dirname, 'ui', 'index.html')).then(() => {
      this.barLoaded = true;
      const pending = this.pendingBar;
      this.pendingBar = null;
      if (pending) this.showBar(pending);
    });

    if (this.sidebarVisible) {
      const view = this.ensureSidebar();
      this.sidebarReady.then(() => {
        if (!this.win) return;
        win.contentView.addChildView(view);
        this.sidebarAttached = true;
        this.layout();
        this.updateSidebar();
      });
    }

    const savedTabs = Array.isArray(this.saved.tabs)
      ? this.saved.tabs.filter((url) => typeof url === 'string' && URL_RE.test(url))
      : [];
    const startUrls = savedTabs.length ? savedTabs : [HOME];
    startUrls.forEach((url, index) => this.createTab({ url, activate: index === 0 }));
    if (typeof this.saved.activeTab === 'number') {
      const ids = [...this.tabs.keys()];
      if (ids[this.saved.activeTab] !== undefined) this.activateTab(ids[this.saved.activeTab]);
    }
    this.saved = {};

    this.layout();
    this.focusContent();
    this.updateSidebar();
    mark('page created');
    if (!savedTabs.length) {
      await barReady;
      this.showBar();
    }

    // Warm the panel after the window is up: its first open then costs nothing.
    setImmediate(() => {
      if (this.win && !this.panel) this.ensurePanel();
    });
  }

  release() {
    for (const tab of this.tabs.values()) tab.view?.webContents.close();
    this.tabs.clear();
    this.activeTabId = null;
    for (const view of [this.bar, this.panel, this.sidebar]) view?.webContents.close();
    clearInterval(this.sidebarTimer);
    clearTimeout(this.persistTimer);
    this.bar = undefined;
    this.panel = undefined;
    this.sidebar = undefined;
    this.barVisible = false;
    this.panelVisible = false;
    this.currentPanel = null;
    this.sidebarAttached = false;
    this.sidebarLoaded = false;
    this.panelReady = null;
    this.sidebarReady = null;
    this.barLoaded = false;
    this.pendingBar = null;
    this.win = undefined;

    windows.delete(this);
    // Closing the last window leaves its tabs on disk, so a resident relaunch
    // (or the next cold start) opens what the user was just looking at.
    remembered = windows.size ? null : this.finalSnapshot;
    persistState();
  }

  focus() {
    if (!this.win) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.focus();
  }

  restoreBounds() {
    const bounds = this.saved.bounds;
    if (
      bounds &&
      ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key])) &&
      bounds.width >= 400 &&
      bounds.height >= 240
    ) {
      this.win.setBounds(bounds);
      return;
    }
    // A window opened from another one steps off it, so C-n never hides the
    // window the user was reading behind an identical copy.
    const previous = [...windows].filter((window) => window !== this && window.win).pop();
    if (!previous) return;
    const { x, y, width, height } = previous.win.getBounds();
    this.win.setBounds({ x: x + CASCADE, y: y + CASCADE, width, height });
  }

  // ------------------------------------------------------------------- state

  snapshot() {
    return {
      bounds: this.win ? this.win.getBounds() : this.saved.bounds,
      tabs: [...this.tabs.values()].map((tab) => tab.view?.webContents.getURL() || tab.url || HOME),
      activeTab: [...this.tabs.keys()].indexOf(this.activeTabId),
      sidebar: this.sidebarVisible,
    };
  }

  persistTabsNow() {
    persistState();
  }

  /**
   * Navigation fires did-navigate on every page in every tab; writing the state
   * file synchronously there put disk I/O on the main thread mid-page-load.
   * Coalesce the writes instead, and flush synchronously when the window closes.
   */
  persistTabs() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      persistState();
    }, PERSIST_DELAY);
  }

  // ------------------------------------------------------------------ layout

  layout() {
    if (!this.win) return;
    const [width, height] = this.win.getContentSize();
    const barPixels = this.barVisible ? Math.round(this.barHeight) : 0;
    const sideWidth = Math.max(0, Math.round(this.sidebarWidth));
    const contentWidth = Math.max(0, width - sideWidth);
    const contentHeight = Math.max(0, height - barPixels);

    // The sidebar keeps its full width and slides out of the left edge, so its
    // contents are clipped by the window rather than reflowing every frame.
    if (this.sidebarAttached && this.sidebar) {
      this.sidebar.setBounds({ x: sideWidth - SIDEBAR_WIDTH, y: 0, width: SIDEBAR_WIDTH, height });
    }
    const tab = this.activeTab();
    if (tab?.view) tab.view.setBounds({ x: sideWidth, y: 0, width: contentWidth, height: contentHeight });
    if (this.panelVisible && this.panel) {
      this.panel.setBounds({ x: sideWidth, y: 0, width: contentWidth, height: contentHeight });
    }
    if (this.barVisible && this.bar) {
      this.bar.setBounds({ x: sideWidth, y: height - barPixels, width: contentWidth, height: barPixels });
    }
  }

  focusContent() {
    const target = this.panelVisible ? this.panel : this.activeTab()?.view;
    target?.webContents.focus();
  }

  // ------------------------------------------------------------- command bar

  showBar({ command = false, search = false } = {}) {
    if (!this.barLoaded) {
      this.pendingBar = { command, search };
      return;
    }
    const url = this.activeTab()?.view?.webContents.getURL();
    const value = search ? ':s ' : command ? ':' : url && url !== HOME ? url : '';
    this.barHeight = BAR_HEIGHT;
    if (this.barVisible) {
      this.bar.webContents.send('bar:edit', value, command || search);
      this.bar.webContents.focus();
      return;
    }
    this.barVisible = true;
    this.win.contentView.addChildView(this.bar);
    this.layout();
    this.bar.webContents.send('bar:edit', value, command || search);
    this.bar.webContents.focus();
  }

  hideBar({ focusPage = true } = {}) {
    if (!this.barVisible) return;
    this.barVisible = false;
    this.win.contentView.removeChildView(this.bar);
    this.layout();
    if (focusPage) this.focusContent();
  }

  // ------------------------------------------------------------------- tabs

  activeTab() {
    return this.tabs.get(this.activeTabId);
  }

  titleFor(tab) {
    const url = tab.view ? tab.view.webContents.getURL() : tab.url;
    if (!url || url === HOME) return 'New tab';
    try {
      return new URL(url).hostname || url;
    } catch {
      return url;
    }
  }

  navigate(raw) {
    const url = parseInput(raw, config.searchUrl);
    const tab = this.activeTab();
    if (!url || !tab) return;
    this.tabView(tab).webContents.loadURL(url).catch((err) => {
      console.warn(`[tbrowser] navigation failed: ${err.message}`);
    });
  }

  go(delta) {
    const tab = this.activeTab();
    if (!tab?.view) return;
    const history = tab.view.webContents.navigationHistory;
    if (delta < 0 && history.canGoBack()) history.goBack();
    if (delta > 0 && history.canGoForward()) history.goForward();
  }

  updateSidebar() {
    if (!this.sidebar || !this.sidebarLoaded) return;
    this.sidebar.webContents.send(
      'tabs:update',
      [...this.tabs.values()].map((tab) => ({
        id: tab.id,
        title: tab.title || this.titleFor(tab),
        active: tab.id === this.activeTabId,
      })),
    );
  }

  wireTab(tab) {
    const wc = tab.view.webContents;

    wc.setWindowOpenHandler(({ url }) => {
      if (URL_RE.test(url)) this.createTab({ url });
      return { action: 'deny' };
    });
    wc.on('page-title-updated', (event, title) => {
      event.preventDefault();
      tab.title = title;
      if (tab.url) visited.retitle(tab.url, title);
      if (tab.id === this.activeTabId && this.win) {
        this.win.setTitle(title ? `${title} — tbrowser` : 'tbrowser');
      }
      this.updateSidebar();
    });
    wc.on('did-navigate', (_event, url) => {
      tab.url = url;
      visited.record(url, tab.title);
      if (tab.id === this.activeTabId) this.persistTabs();
    });
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
      visited.record(url, tab.title);
      if (tab.id === this.activeTabId) this.persistTabs();
    });
    this.watchKeys(wc);
  }

  /** Create a tab's renderer on first use; a restored tab costs nothing until then. */
  tabView(tab) {
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
    this.wireTab(tab);
    view.webContents.loadURL(tab.url || HOME).catch(() => {});
    return view;
  }

  createTab({ url = HOME, activate = true, openBar = false } = {}) {
    const id = this.nextTabId++;
    const tab = { id, view: null, title: '', url };
    this.tabs.set(id, tab);
    if (activate) this.activateTab(id);
    this.updateSidebar();
    this.persistTabs();
    if (openBar) this.showBar();
    return tab;
  }

  activateTab(id) {
    const tab = this.tabs.get(id);
    if (!tab || !this.win) return;
    const previous = this.activeTab();
    if (previous && previous.id !== id && previous.view) this.win.contentView.removeChildView(previous.view);
    this.activeTabId = id;
    const view = this.tabView(tab);
    this.win.contentView.addChildView(view);
    this.layout();
    view.webContents.focus();
    this.win.setTitle(tab.title ? `${tab.title} — tbrowser` : 'tbrowser');
    this.updateSidebar();
    this.persistTabs();
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.tabs.delete(id);
    if (tab.view) {
      this.win.contentView.removeChildView(tab.view);
      tab.view.webContents.close();
    }

    if (this.activeTabId === id) {
      this.activeTabId = null;
      const next = [...this.tabs.keys()].pop();
      if (next === undefined) {
        this.win.close();
        return;
      }
      this.activateTab(next);
    }
    this.updateSidebar();
    this.persistTabs();
  }

  cycleTab(delta) {
    const ids = [...this.tabs.keys()];
    if (ids.length < 2) return;
    const index = ids.indexOf(this.activeTabId);
    this.activateTab(ids[(index + delta + ids.length) % ids.length]);
  }

  // ---------------------------------------------------------------- sidebar

  setSidebar(visible) {
    if (visible === this.sidebarVisible) return;
    this.sidebarVisible = visible;
    if (visible) {
      const view = this.ensureSidebar();
      if (!this.sidebarAttached) {
        this.win.contentView.addChildView(view);
        this.sidebarAttached = true;
      }
    }
    this.animateSidebar(visible ? SIDEBAR_WIDTH : 0);
    this.persistTabs();
  }

  /**
   * Slide the sidebar by moving the page's left edge; the sidebar view keeps its
   * width and travels off the window edge, so its contents are clipped instead
   * of reflowing on every frame.
   */
  animateSidebar(target) {
    const from = this.sidebarWidth;
    const started = Date.now();
    clearInterval(this.sidebarTimer);
    this.sidebarTimer = setInterval(() => {
      const t = Math.min(1, (Date.now() - started) / SIDEBAR_ANIM_MS);
      this.sidebarWidth = from + (target - from) * (1 - (1 - t) ** 3);
      this.layout();
      if (t < 1) return;
      clearInterval(this.sidebarTimer);
      this.sidebarTimer = null;
      this.sidebarWidth = target;
      this.layout();
      if (!this.sidebarVisible && this.sidebarAttached) {
        this.win.contentView.removeChildView(this.sidebar);
        this.sidebarAttached = false;
        this.layout();
      }
    }, 16);
  }

  // ------------------------------------------------------------------- keys

  pressShortcut(input) {
    if (this.panelVisible && this.panelEditing) return false;
    if (!this.barVisible) {
      // Only a handful of openers; the rest of the table is matched without
      // re-parsing accelerator strings on every keystroke.
      const index = keys.openBar.findIndex((expected) => matchesAny(input, [expected]));
      if (index !== -1) {
        // ":" lands in vim's command line, and its first command is the search:
        // every keystroke after ":s " is the query.
        this.showBar({ search: config.keybindings.openBar[index] === ':' });
        return true;
      }
      if (keys.search?.length && matchesAny(input, keys.search)) {
        this.showBar({ search: true });
        return true;
      }
    }
    if (this.barVisible && matchesAny(input, keys.closeBar)) {
      this.hideBar();
      return true;
    }
    if (this.panelVisible && matchesAny(input, keys.closeBar)) {
      this.closePanel();
      return true;
    }
    if (matchesAny(input, keys.reload)) {
      this.activeTab()?.view?.webContents.reload();
      return true;
    }
    if (matchesAny(input, keys.back)) {
      this.go(-1);
      return true;
    }
    if (matchesAny(input, keys.forward)) {
      this.go(1);
      return true;
    }
    if (matchesAny(input, keys.newTab)) {
      this.createTab({ openBar: true });
      return true;
    }
    if (matchesAny(input, keys.closeTab)) {
      if (this.activeTab()) this.closeTab(this.activeTabId);
      return true;
    }
    if (matchesAny(input, keys.nextTab)) {
      this.cycleTab(1);
      return true;
    }
    if (matchesAny(input, keys.prevTab)) {
      this.cycleTab(-1);
      return true;
    }
    if (matchesAny(input, keys.toggleSidebar)) {
      this.setSidebar(!this.sidebarVisible);
      return true;
    }
    if (matchesAny(input, keys.devtools)) {
      const target = this.barVisible ? this.bar : this.activeTab()?.view;
      target?.webContents.toggleDevTools();
      return true;
    }
    if (matchesAny(input, keys.newWindow)) {
      openWindow();
      return true;
    }
    if (matchesAny(input, keys.closeWindow)) {
      this.win.close();
      return true;
    }
    if (matchesAny(input, keys.quit)) {
      app.quit();
      return true;
    }
    return false;
  }

  watchKeys(webContents) {
    webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      if (this.pressShortcut(input)) event.preventDefault();
    });
  }

  // ------------------------------------------------------------------ panel

  ensurePanel() {
    if (this.panel) return this.panel;
    const panel = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'ui', 'panel-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    this.panel = panel;
    track(this, panel);
    panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.watchKeys(panel.webContents);
    this.panelReady = panel.webContents.loadFile(path.join(__dirname, 'ui', 'panel.html'));
    return panel;
  }

  ensureSidebar() {
    if (this.sidebar) return this.sidebar;
    const sidebar = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'ui', 'sidebar-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    this.sidebar = sidebar;
    track(this, sidebar);
    sidebar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.watchKeys(sidebar.webContents);
    this.sidebarReady = sidebar.webContents.loadFile(path.join(__dirname, 'ui', 'sidebar.html')).then(() => {
      this.sidebarLoaded = true;
      this.updateSidebar();
    });
    return sidebar;
  }

  async openPanel(page) {
    const view = this.ensurePanel();
    await this.panelReady;
    if (!this.win) return;
    if (!this.panelVisible) {
      this.panelVisible = true;
      this.win.contentView.addChildView(view);
    }
    this.currentPanel = page;
    this.layout();
    view.webContents.send('panel:show', page);
    view.webContents.focus();
  }

  closePanel() {
    if (!this.panelVisible) return;
    this.panelVisible = false;
    this.panelEditing = false;
    this.win.contentView.removeChildView(this.panel);
    this.layout();
    this.focusContent();
  }
}

// ------------------------------------------------------------------ windows

function createWindow(snapshot = {}) {
  return new Browser(snapshot).open();
}

/** Focus the window in front, or build the ones the last run left behind. */
function showWindow() {
  const existing = [...windows].pop();
  if (existing) {
    existing.focus();
    return Promise.resolve();
  }
  if (!creatingWindow) {
    creatingWindow = restoreWindows().finally(() => {
      creatingWindow = null;
    });
  }
  return creatingWindow;
}

function restoreWindows() {
  const snapshots = readSnapshots();
  if (!snapshots.length) return createWindow();
  return Promise.all(snapshots.map((snapshot) => createWindow(snapshot)));
}

/**
 * A fresh window, the way Ctrl+N works in any browser: one blank tab, the
 * command bar already focused, no tabs borrowed from the window it opened over.
 */
function openWindow() {
  return createWindow().catch((err) => console.error(`[tbrowser] new window failed: ${err.message}`));
}

// ------------------------------------------------------------------ commands

function runCommand(window, command) {
  switch (command.name) {
    case 's': {
      const query = command.args.join(' ').trim();
      if (!query) return 'nothing to search';
      window.hideBar();
      window.navigate(`${config.searchUrl}${encodeURIComponent(query)}`);
      return null;
    }
    case 'fav': {
      const tab = window.activeTab();
      const url = tab?.view?.webContents.getURL();
      if (!url || url === HOME) return 'nothing to favourite';
      const added = visited.toggleFavourite(url, tab.title ?? '');
      window.bar.webContents.send('bar:notice', added ? '★ added to favourites' : '★ removed from favourites');
      return null;
    }
    case 'ext':
    case 'extensions':
      window.hideBar();
      window.openPanel('extensions');
      return null;
    case 'settings':
    case 'config':
      window.hideBar();
      window.openPanel('settings');
      return null;
    default:
      return `unknown command: ${command.name || ':'} — try :s, :fav, :extensions or :settings`;
  }
}

ipcMain.on('bar:submit', (event, text) => {
  const window = ctxFor(event);
  if (!window) return;
  const command = parseCommand(text);
  if (command) {
    const error = runCommand(window, command);
    if (error) window.bar.webContents.send('bar:error', error);
    return;
  }
  window.hideBar();
  window.navigate(text);
});

/**
 * Rows for the dropdown. The bar view grows upward to hold them, and the page
 * gives up the same pixels, so the list never covers the page it is over.
 */
ipcMain.handle('bar:suggest', (event, text) => {
  const items = suggestions(text, {
    history: visited.list(),
    favourites: visited.favourites(),
    searchUrl: config.searchUrl,
  });
  const window = ctxFor(event);
  if (window) {
    window.barHeight = BAR_HEIGHT + (items.length ? items.length * BAR_ROW + BAR_PAD : 0);
    window.layout();
  }
  return items;
});
ipcMain.on('bar:hide', (event) => ctxFor(event)?.hideBar());

ipcMain.on('sidebar:action', (event, action) => {
  const window = ctxFor(event);
  if (!window || !action || typeof action !== 'object') return;
  const id = Number(action.id);
  if (action.type === 'activate') window.activateTab(id);
  else if (action.type === 'close') window.closeTab(id);
  else if (action.type === 'new') window.createTab({ openBar: true });
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
ipcMain.handle('settings:save', (event, patch) => {
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
  applyConfig(next, 'panel', event.sender);
  return { ok: true, config };
});
ipcMain.handle('panel:rescan', async () => {
  await loadExtensions(ses, extensionDirs);
  return { extensions: listExtensions(), dirs: extensionDirs };
});
ipcMain.on('panel:close', (event) => ctxFor(event)?.closePanel());
ipcMain.on('panel:editing', (event, editing) => {
  const window = ctxFor(event);
  if (window) window.panelEditing = Boolean(editing);
});
ipcMain.on('panel:open-path', (_event, target) => {
  if (target === configPath) shell.showItemInFolder(configPath);
  else if (extensionDirs.includes(target)) shell.openPath(target);
});

// ------------------------------------------------------------ shared process

function listExtensions() {
  return ses.extensions.getAllExtensions().map((extension) => ({
    id: extension.id,
    name: extension.name,
    version: extension.version,
    path: extension.path,
  }));
}

/**
 * Everything a window needs from the session — extensions, the adblock engine,
 * the persistent partition — is done once per process. Every window after the
 * first one starts from a session that is already warm.
 */
function prepareSession() {
  if (sessionReady) return sessionReady;
  sessionReady = (async () => {
    ses = session.fromPartition(PARTITION);
    extensionDirs = [
      unpacked(path.join(__dirname, 'extensions')),
      unpacked(path.join(__dirname, 'vendor')),
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

/**
 * A packaged build keeps the app in app.asar, but the extension loader reads
 * manifests with native file calls that cannot see inside it: the vendor tree
 * is unpacked beside the archive, and the paths handed to Chromium point there.
 */
function unpacked(target) {
  if (!app.isPackaged) return target;
  return target.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

/** Adopt a config object everywhere it is read, live. */
function applyConfig(next, origin, source) {
  config = next;
  keys = compileKeybindings(config.keybindings);
  syncAdblock().catch((err) => console.warn(`[tbrowser] adblock switch failed: ${err.message}`));
  const changed = { config, origin };
  // Every window's settings page reads the same config: the one that saved is
  // already showing it, and the others hear about it.
  for (const window of windows) {
    if (window.panelVisible && window.panel && window.panel.webContents.id !== source?.id) {
      window.panel.webContents.send('settings:changed', changed);
    }
    if (origin === 'disk' && window.bar) {
      window.bar.webContents.send('bar:notice', 'settings reloaded from config.json');
    }
  }
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
    for (const window of windows) {
      window.bar?.webContents.send('bar:error', `config.json not applied: ${err.message}`);
    }
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

// --------------------------------------------------------------- app startup

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
