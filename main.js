'use strict';

const { app, BaseWindow, WebContentsView, session, ipcMain, Menu, shell, nativeTheme } = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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
// The new-tab page is a local file, not about:blank: Chromium paints a blank
// document white whatever the theme, so the first thing a launch showed was a
// white window.
const HOME = pathToFileURL(path.join(__dirname, 'ui', 'home.html')).href;
const BLANK = 'about:blank'; // what state files written before the home page hold
// The chrome's own background: catppuccin's base, the color ui/theme.css
// paints every panel with — mocha on a dark system, latte on a light one.
const CHROME_BG = { dark: '#1e1e2e', light: '#eff1f5' };
// The window and every view behind a page share one background, so the frames
// between a window appearing and its page painting are the chrome's color
// instead of white.
const chromeBg = () => (nativeTheme.shouldUseDarkColors ? CHROME_BG.dark : CHROME_BG.light);
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

// A view whose bounds did not change is not worth telling the compositor
// about: layout runs on every window resize, bar toggle and sidebar frame, and
// re-placing the page each of those times would reflow it for nothing.
const lastBounds = new WeakMap();
function place(view, bounds) {
  const prev = lastBounds.get(view);
  if (
    prev &&
    prev.x === bounds.x &&
    prev.y === bounds.y &&
    prev.width === bounds.width &&
    prev.height === bounds.height
  ) {
    return false;
  }
  lastBounds.set(view, bounds);
  view.setBounds(bounds);
  return true;
}

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
let controlServer = null;
let showRequestWatcher = null;

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

/**
 * The bar, the panel and the sidebar do not depend on a window: they are built
 * once and moved to the next window when one closes. Reopening therefore shows
 * the chrome instantly — no renderer has to start. A second window open at the
 * same time gets its own copy, because a view can only live in one window.
 */
const freeChrome = { bar: [], sidebar: [], panel: [] };

function watchViewKeys(webContents) {
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    const owner = viewOwners.get(webContents.id);
    if (owner && owner.pressShortcut(input)) event.preventDefault();
  });
}

/**
 * A view paints its own background until the page inside it does. Left to the
 * default, that gap is white: the flash every window and tab showed as it
 * opened. Give the view the chrome's color and the gap disappears.
 */
function newView(webPreferences) {
  const view = new WebContentsView({ webPreferences });
  view.setBackgroundColor(chromeBg());
  return view;
}

function chromeView(kind, file, preload) {
  const free = freeChrome[kind];
  // A parked view whose renderer died is still a view and still in the pool.
  // Handing it to a new window makes building that window throw — and that is
  // the window a show request was waiting for, so the whole app stays dark.
  while (free.length) {
    const parked = free.pop();
    if (parked.view && !parked.view.webContents.isDestroyed()) {
      mark(`chrome reused ${kind}`);
      return parked;
    }
    mark(`chrome dropped ${kind}`);
  }
  mark(`chrome new ${kind}`);
  const view = newView({
    preload: path.join(__dirname, 'ui', preload),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    spellcheck: false,
  });
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  watchViewKeys(view.webContents);
  return { view, ready: view.webContents.loadFile(path.join(__dirname, 'ui', file)) };
}

/**
 * Keep one spare bar and sidebar ready. The next window takes the pair out of
 * the pool instead of starting two renderers, so its chrome is painted the
 * moment the window is shown — this is what makes ctrl+n feel instant.
 */
function warmChrome() {
  for (const [kind, file, preload] of [
    ['bar', 'index.html', 'preload.js'],
    ['sidebar', 'sidebar.html', 'sidebar-preload.js'],
  ]) {
    if (freeChrome[kind].length) continue;
    mark(`chrome warming ${kind}`);
    freeChrome[kind].push(chromeView(kind, file, preload));
  }
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
    // Whether the dropdown under the bar has rows: ctrl+j/ctrl+k move the
    // selection there and only fall through to tab switching when it is empty.
    this.barListOpen = false;

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
    this.pageLayouts = 0;

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
      backgroundColor: chromeBg(),
    });
    this.win = win;
    windows.add(this);

    this.restoreBounds();

    win.on('resize', () => this.layout());
    win.on('close', () => {
      this.finalSnapshot = this.snapshot();
      this.persistTabsNow();
      this.detachChrome();
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

    const barEntry = chromeView('bar', 'index.html', 'preload.js');
    const bar = barEntry.view;
    this.bar = bar;
    this.barEntry = barEntry;
    track(this, bar);
    // The bar, the sidebar and the page are three renderer processes. Starting
    // them together costs the slowest one instead of their sum, which on
    // Windows is the difference between an instant page and a stalled one.
    const barReady = barEntry.ready.then(() => {
      mark('bar ready');
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
      ? this.saved.tabs
          .filter((url) => typeof url === 'string' && URL_RE.test(url))
          // A state file from before the home page says about:blank; that tab
          // is the empty one, so it opens on the home page.
          .map((url) => (url === BLANK ? HOME : url))
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

    // Warm the panel and the spare chrome after the window is up: the first
    // `:extensions` and the next ctrl+n then cost nothing.
    setImmediate(() => {
      if (!this.win) return;
      if (!this.panel) this.ensurePanel();
      warmChrome();
    });
  }

  /**
   * Take the chrome views out of the window before it is destroyed, and park
   * them for the next one. Their renderers keep running, so the next window
   * shows a bar and a sidebar that are already painted.
   */
  detachChrome() {
    if (!this.win) return;
    const entries = [
      ['bar', this.barEntry, this.barVisible],
      ['panel', this.panelEntry, this.panelVisible],
      ['sidebar', this.sidebarEntry, this.sidebarAttached],
    ];
    for (const [kind, entry, attached] of entries) {
      if (!entry || !entry.view) continue;
      if (attached) {
        try {
          this.win.contentView.removeChildView(entry.view);
        } catch {
          // the window is already going away
        }
      }
      const free = freeChrome[kind];
      mark(`chrome parked ${kind}`);
      if (free.length < 1) free.push(entry);
      // A full pool keeps one spare only; close what it cannot take, or the
      // renderer stays alive with nothing pointing at it.
      else entry.view.webContents.close();
    }
  }

  release() {
    // The window is already gone here, and its tab views went with it: closing
    // a destroyed webContents throws, which would abort this handler and leave
    // a dead Browser in `windows` for every later show request to focus.
    for (const tab of this.tabs.values()) {
      const contents = tab.view?.webContents;
      if (contents && !contents.isDestroyed()) contents.close();
    }
    this.tabs.clear();
    this.activeTabId = null;
    clearTimeout(this.persistTimer);
    this.bar = undefined;
    this.barEntry = undefined;
    this.panel = undefined;
    this.panelEntry = undefined;
    this.sidebar = undefined;
    this.sidebarEntry = undefined;
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
    if (!this.win || this.win.isDestroyed()) return;
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
      bounds: this.win && !this.win.isDestroyed() ? this.win.getBounds() : this.saved.bounds,
      // A tab whose renderer is gone has no URL to read, and asking a destroyed
      // webContents throws. The tab's last recorded url still names the page,
      // and this runs while the window closes: a throw here keeps it open.
      tabs: [...this.tabs.values()].map((tab) =>
        tab.view?.webContents.isDestroyed() === false
          ? tab.view.webContents.getURL() || tab.url || HOME
          : tab.url || HOME,
      ),
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
    const contentHeight = Math.max(0, height - barPixels);

    // The page always gets the whole window: the sidebar sits over it, so
    // opening or closing the sidebar never resizes the page or reflows what is
    // on it. Only the browser's own chrome keeps clear of the sidebar.
    if (this.sidebarAttached && this.sidebar) {
      place(this.sidebar, { x: 0, y: 0, width: SIDEBAR_WIDTH, height });
    }
    const tab = this.activeTab();
    if (tab?.view && place(tab.view, { x: 0, y: 0, width, height: contentHeight })) {
      this.pageLayouts += 1;
    }
    const chromeX = this.sidebarVisible ? SIDEBAR_WIDTH : 0;
    const chromeWidth = Math.max(0, width - chromeX);
    if (this.panelVisible && this.panel) {
      place(this.panel, { x: chromeX, y: 0, width: chromeWidth, height: contentHeight });
    }
    if (this.barVisible && this.bar) {
      place(this.bar, { x: chromeX, y: height - barPixels, width: chromeWidth, height: barPixels });
    }
  }

  focusContent() {
    const target = this.panelVisible ? this.panel : this.activeTab()?.view;
    target?.webContents.focus();
  }

  // ------------------------------------------------------------- command bar

  /**
   * Open the bar in one of three shapes: `command` starts on ":" (vim's
   * command line, `:s` and the rest), `search` on an empty field, `address`
   * on the page's current address. A typed `:` in any of them is still a
   * command, and text that names no command is searched.
   */
  showBar(mode = 'address') {
    if (!this.barLoaded) {
      this.pendingBar = mode;
      return;
    }
    const url = this.activeTab()?.view?.webContents.getURL();
    const value = mode === 'command' ? ':' : mode === 'search' ? '' : url && url !== HOME ? url : '';
    this.barHeight = BAR_HEIGHT;
    this.barListOpen = false;
    if (this.barVisible) {
      this.bar.webContents.send('bar:edit', value, mode === 'command');
      this.bar.webContents.focus();
      return;
    }
    this.barVisible = true;
    this.win.contentView.addChildView(this.bar);
    this.layout();
    this.bar.webContents.send('bar:edit', value, mode === 'command');
    this.bar.webContents.focus();
  }

  hideBar({ focusPage = true } = {}) {
    if (!this.barVisible) return;
    this.barVisible = false;
    this.barListOpen = false;
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
    wc.on('page-title-updated', (event, pageTitle) => {
      event.preventDefault();
      // An empty tab is not a page: without a <title> Chromium names it after
      // the file it came from, which no window or tab list should show.
      const title = wc.getURL() === HOME ? '' : pageTitle;
      tab.title = title;
      if (tab.url && tab.url !== HOME) visited.retitle(tab.url, title);
      if (tab.id === this.activeTabId && this.win) {
        this.win.setTitle(title ? `${title} — tbrowser` : 'tbrowser');
      }
      this.updateSidebar();
    });
    wc.on('did-navigate', (_event, url) => {
      tab.url = url;
      // The home page is the absence of a page; it is not a visit.
      if (url !== HOME) visited.record(url, tab.title);
      if (tab.id === this.activeTabId) this.persistTabs();
    });
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
      if (url !== HOME) visited.record(url, tab.title);
      if (tab.id === this.activeTabId) this.persistTabs();
    });
    this.watchKeys(wc);
  }

  /** Create a tab's renderer on first use; a restored tab costs nothing until then. */
  tabView(tab) {
    if (tab.view) return tab.view;
    const view = newView({
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    });
    tab.view = view;
    track(this, view);
    this.wireTab(tab);
    view.webContents.loadURL(tab.url || HOME).catch(() => {});
    return view;
  }

  createTab({ url = HOME, activate = true, openBar = false } = {}) {
    const id = this.nextTabId++;
    const tab = { id, view: null, title: '', url };
    this.tabs.set(id, tab);
    // activateTab already repaints the list; only a background tab needs it.
    if (activate) this.activateTab(id);
    else this.updateSidebar();
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
    // Bottom of the stack: the sidebar and the chrome draw over the page, so a
    // page added here never covers the view floating above it.
    this.win.contentView.addChildView(view, 0);
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
      // A tab whose renderer crashed still has its view, and closing a
      // destroyed webContents throws — which used to stop the close below.
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
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

  /** Ctrl+N: the Nth tab, or — for 9 — the last one, as Chrome does. */
  selectTabNumber(number) {
    const ids = [...this.tabs.keys()];
    if (!ids.length) return;
    const id = ids[number === 9 ? ids.length - 1 : number - 1];
    if (id !== undefined) this.activateTab(id);
  }

  // ---------------------------------------------------------------- sidebar

  /**
   * Show or hide the sidebar. It floats over the page, so a toggle attaches or
   * detaches one view and lays nothing else out: no page resize, no animation
   * frames, nothing on the main thread between the key and the picture.
   */
  setSidebar(visible) {
    if (visible === this.sidebarVisible) return;
    this.sidebarVisible = visible;
    this.pageLayouts = 0;
    if (visible) {
      const view = this.ensureSidebar();
      if (!this.sidebarAttached) {
        // Added last so it draws over the page: views stack in the order they
        // are added, and the page goes in at the bottom every time a tab opens.
        this.win.contentView.addChildView(view);
        this.sidebarAttached = true;
      }
    } else if (this.sidebarAttached) {
      this.win.contentView.removeChildView(this.sidebar);
      this.sidebarAttached = false;
    }
    this.layout();
    mark(`sidebar ${visible ? 'in' : 'out'}: ${this.pageLayouts} page layout(s)`);
    this.persistTabs();
  }

  // ------------------------------------------------------------------- keys

  pressShortcut(input) {
    if (this.panelVisible && this.panelEditing) return false;
    // With a list under the bar, ctrl+j/ctrl+k walk it; with the list empty
    // they fall through to the tab bindings below, as they do on the page.
    if (this.barVisible && this.barListOpen) {
      const delta = matchesAny(input, keys.nextSuggestion)
        ? 1
        : matchesAny(input, keys.prevSuggestion)
          ? -1
          : 0;
      if (delta) {
        this.bar.webContents.send('bar:move', delta);
        return true;
      }
    }
    if (!this.barVisible) {
      // Only a handful of openers; the rest of the table is matched without
      // re-parsing accelerator strings on every keystroke.
      const index = keys.openBar.findIndex((expected) => matchesAny(input, [expected]));
      if (index !== -1) {
        // ":" lands in vim's command line; Ctrl+L/Ctrl+K start on the address
        // instead, where a leading ":" turns the input back into a command.
        this.showBar(config.keybindings.openBar[index] === ':' ? 'command' : 'address');
        return true;
      }
      if (keys.search?.length && matchesAny(input, keys.search)) {
        this.showBar('search');
        return true;
      }
    }
    // Ctrl+1..8 are the tab in that position, Ctrl+9 the last one — the
    // browser convention, not a rebindable accelerator.
    if (input.control && !input.alt && !input.meta && !input.shift && /^[1-9]$/.test(input.key)) {
      this.selectTabNumber(Number(input.key));
      return true;
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
    watchViewKeys(webContents);
  }

  // ------------------------------------------------------------------ panel

  ensurePanel() {
    if (this.panel) return this.panel;
    const entry = chromeView('panel', 'panel.html', 'panel-preload.js');
    this.panelEntry = entry;
    this.panel = entry.view;
    track(this, this.panel);
    this.panelReady = entry.ready;
    return this.panel;
  }

  ensureSidebar() {
    if (this.sidebar) return this.sidebar;
    const entry = chromeView('sidebar', 'sidebar.html', 'sidebar-preload.js');
    this.sidebarEntry = entry;
    this.sidebar = entry.view;
    track(this, this.sidebar);
    this.sidebarReady = entry.ready.then(() => {
      this.sidebarLoaded = true;
      if (this.win) this.updateSidebar();
    });
    return this.sidebar;
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
  const window = new Browser(snapshot);
  return window.open().catch((err) => {
    // A window that never finished building has no tabs and half its chrome.
    // Left in `windows` it answers every later show request with a focus on a
    // skeleton, so the browser can never be opened again: drop it outright.
    if (window.win && !window.win.isDestroyed()) window.win.destroy();
    windows.delete(window);
    throw err;
  });
}

/**
 * A file a hotkey can drop to ask for a window. AutoHotkey and shell scripts
 * can write a file faster and more portably than they can open a pipe, and
 * the watch costs nothing while it waits.
 */
function showRequestPath() {
  return path.join(app.getPath('userData'), 'show.request');
}

function startShowRequestWatch() {
  if (showRequestWatcher) return;
  const file = showRequestPath();
  try {
    fs.unlinkSync(file);
  } catch {
    // nothing left over
  }
  try {
    showRequestWatcher = fs.watch(app.getPath('userData'), (_event, name) => {
      if (name !== 'show.request') return;
      let request = 'show';
      try {
        request = fs.readFileSync(file, 'utf8').trim() || 'show';
        fs.unlinkSync(file);
      } catch {
        // the file vanished between the event and the read
      }
      if (request === 'new') {
        openWindow();
        return;
      }
      if (request === 'quit') {
        app.quit();
        return;
      }
      showWindow().catch((err) => console.error(`[tbrowser] reopen failed: ${err.message}`));
    });
  } catch (err) {
    console.warn(`[tbrowser] cannot watch for show requests: ${err.message}`);
  }
}

/**
 * A local channel the launcher can talk to. Booting Electron just to hand a
 * "show" message to an already-running process costs seconds on Windows; a
 * pipe write costs nothing, so a cold process is only paid for once.
 */
function controlTarget() {
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\tbrowser-show'
    : path.join(app.getPath('userData'), 'show.sock');
}

/**
 * `tbrowser --quit` ends the running instance. Every keybinding lives inside a
 * window, so a resident process parked with no window on screen could not be
 * closed again short of killing it; this asks it over the same channel a launch
 * uses. With nothing running there is nothing to ask, and the command succeeds.
 */
function quitRunningInstance() {
  const socket = net.createConnection(controlTarget());
  const exit = (code) => {
    socket.destroy();
    process.exit(code);
  };
  // A refused connect means nothing is running, which is what was asked for.
  // A channel that takes the message but never answers is a process that heard
  // the request and is not going: say so instead of pretending it closed.
  socket.setTimeout(500, () => exit(1));
  socket.on('error', () => exit(0));
  socket.on('end', () => exit(0));
  socket.on('data', () => {});
  socket.on('connect', () => socket.end('quit\n'));
}

function startControlServer() {
  if (controlServer) return;
  const target = controlTarget();
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(target); // a socket left behind by a killed process
    } catch {
      // nothing to remove
    }
  }
  controlServer = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.once('data', (message) => {
      const request = String(message).trim();
      if (request === 'show') {
        showWindow().catch((err) => console.error(`[tbrowser] reopen failed: ${err.message}`));
      } else if (request === 'new') {
        openWindow();
      } else if (request === 'quit') {
        // Answer first: the reply has to leave before the process goes.
        setImmediate(() => app.quit());
      }
      socket.end('ok\n');
    });
  });
  controlServer.on('error', (err) => {
    console.warn(`[tbrowser] control channel unavailable: ${err.message}`);
    controlServer = null;
  });
  controlServer.listen(target);
  startShowRequestWatch();
  app.on('quit', () => {
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(target);
      } catch {
        // already gone
      }
    }
  });
}

/** Focus the window in front, or build the ones the last run left behind. */
function showWindow() {
  // A Browser can outlive its window: a failed build, or a release that never
  // ran, leaves one in this set with nothing on screen. Focusing it is a no-op
  // and the request dies there, which is how a resident process ends up with
  // no window and no way to ask for one — drop it and build a fresh window.
  for (const window of windows) {
    if (window.win && window.win.isDestroyed()) windows.delete(window);
  }
  const existing = [...windows].pop();
  if (existing) {
    if (!existing.win.isVisible()) existing.win.show();
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

// Returned by runCommand for text that is not a command at all: the bar then
// opens it the way it would open the same text without the colon.
const NOT_A_COMMAND = Symbol('not a command');

function runCommand(window, command) {
  switch (command.name) {
    case 's': {
      const query = command.args.join(' ').trim();
      window.hideBar();
      if (query) window.navigate(`${config.searchUrl}${encodeURIComponent(query)}`);
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
      return NOT_A_COMMAND;
  }
}

ipcMain.on('bar:submit', (event, text) => {
  const window = ctxFor(event);
  if (!window) return;
  const command = parseCommand(text);
  if (command) {
    if (!command.name) {
      window.hideBar();
      return;
    }
    const error = runCommand(window, command);
    if (error === NOT_A_COMMAND) {
      // Nothing after the colon named a command, so the text is what it would
      // have been without the colon: an address or a search.
      window.hideBar();
      window.navigate(String(text).trim().slice(1).trim());
      return;
    }
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
    window.barListOpen = items.length > 0;
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

// Checked before the lock: quitting is a request to whichever instance holds it,
// including one parked with no window on screen.
if (process.argv.includes('--quit')) {
  quitRunningInstance();
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // A hidden launch only wants the daemon up; it must not pop a window.
    if (argv.includes('--hidden') || argv.includes('--daemon')) return;
    showWindow().catch((err) => console.error(`[tbrowser] reopen failed: ${err.message}`));
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.tbrowser.app');
    Menu.setApplicationMenu(null);
    startControlServer();
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
    // `--hidden` starts the resident process without a window: run at login so
    // every later launch is a request to an already warm browser.
    if (process.argv.includes('--hidden') || process.argv.includes('--daemon')) return undefined;
    return showWindow();
  });
}

// With the default resident daemon, closing the last window parks the process
// instead of paying Electron's cold start on the next launch.
app.on('window-all-closed', () => {
  if (!config?.resident) app.quit();
});
