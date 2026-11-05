'use strict';

const {
  app,
  BaseWindow,
  WebContentsView,
  View,
  session,
  ipcMain,
  Menu,
  shell,
  nativeTheme,
  webContents,
} = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { parseInput, parseCommand } = require('./lib/commands');
const { DEFAULTS, loadConfig, normalize, compileKeybindings, matchesAny, parseBindingText } = require('./lib/config');
const { loadExtensions, findExtensions, readDisabledExtensions, writeDisabledExtensions } = require('./lib/extensions');
const { enableAdblock } = require('./lib/adblock');
const { Visits } = require('./lib/history');
const { PreloadPool } = require('./lib/preload');
const { suggestions } = require('./lib/suggest');
const { Workspaces, normalizeName, autoName, LAST: LAST_WORKSPACE } = require('./lib/workspaces');
const { splitBounds, edgeBounds } = require('./lib/layout');
const { sharedTabs } = require('./lib/shared-tabs');

const BAR_HEIGHT = 44;
const BAR_ROW = 32;
const BAR_PAD = 8;
const SIDEBAR_WIDTH = 220;
// The frame around a pane: the panes keep that far from the edge of the page
// area, and the strip left over is painted with the pane's colour. The line
// between two panes is the two frames meeting, so the split shows which pane
// has the keys on the seam as well as around the outside.
const SPLIT_EDGE = 2;
const SPLIT_GAP = SPLIT_EDGE * 2;
// tmux's pane frame: every pane is outlined, and the one holding the keys is
// lit in the accent the rest of the chrome already uses.
const PANE_EDGE = { dark: '#3a3a3a', light: '#d4d4d4' };
const PANE_EDGE_ACTIVE = { dark: '#5b8def', light: '#5b8def' };
const paneEdge = (active) =>
  (active ? PANE_EDGE_ACTIVE : PANE_EDGE)[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
const PARTITION = 'persist:tbrowser';
// The new-tab page is a local file, not about:blank: Chromium paints a blank
// document white whatever the theme, so the first thing a launch showed was a
// white window.
const HOME = pathToFileURL(path.join(__dirname, 'ui', 'home.html')).href;
const BLANK = 'about:blank'; // what state files written before the home page hold
// The window and every view behind a page share one background, so the frames
// between a window appearing and its page painting are the chrome's color
// instead of white.
const CHROME_BG = { dark: '#1b1b1b', light: '#f5f5f5' };
const chromeBg = () => (nativeTheme.shouldUseDarkColors ? CHROME_BG.dark : CHROME_BG.light);
// `backgroundMaterial` is Windows 11 22H2 and up. Older Windows would see a
// window told it is translucent with no blur behind it — a black hole where
// the chrome should be — so the backdrop is only asked for where it exists.
const WIN11_22H2 = 22621;
const desktopBlur =
  process.platform === 'win32' && Number(os.release().split('.')[2]) >= WIN11_22H2;
/** Whether the desktop is blurred behind the window: the setting, on a Windows that draws it. */
const blurOn = () => desktopBlur && config?.blur === true;
/**
 * The colour the empty tab and the chrome paint: the desktop blur showing
 * through `blurColor` at `blurOpacity` percent — the Windows Terminal window's
 * own recipe — or the chrome's colour when there is no blur behind it. An
 * #AARRGGBB colour, since that is the alpha Electron's views take.
 */
function surfaceBg() {
  if (!blurOn()) return chromeBg();
  const alpha = Math.round((config.blurOpacity / 100) * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${alpha}${config.blurColor.slice(1)}`;
}
// `--no-ui` is the test launch: the window is built exactly as a real one and
// never put on screen, so a run that only needs the browser up — a smoke test,
// or an agent checking a change while the user works — takes no focus and
// stacks nothing in the taskbar. It also runs beside the resident browser and
// keeps a throwaway profile, so ten of them can run at once.
const NO_UI = process.argv.includes('--no-ui');
const SCRATCH_PREFIX = 'tbrowser-no-ui-';
const STALE_PROFILE_MS = 24 * 60 * 60 * 1000;
const PERSIST_DELAY = 250;
// A preloaded page kept ready for a while is refreshed when it is taken: the
// tab shows the page it already has and fetches it again behind the picture.
const WARM_REFRESH_MS = 5 * 60 * 1000;
// How many pages a tab keeps behind and ahead of the one on screen when a warm
// swap skipped past them. Each one is a renderer, so the list is short.
const MAX_TAB_STEPS = 4;
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
let workspaces; // named tab sets, the browser's sessions
let keys; // keybindings pre-parsed once
let extensionDirs = [];
let disabledExtensions = []; // folders the extensions page switched off, by path
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
// One counter for every window: a tab is named by its id across the whole
// browser, so the lists that show tabs from more than one window can hand the
// id back to `:tab` without asking which window it came from.
let nextTabId = 1;

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
function newView(webPreferences, background = chromeBg()) {
  const view = new WebContentsView({ webPreferences });
  view.setBackgroundColor(background);
  return view;
}

/**
 * A page can ask for a popup, and a sign-in popup is the one that matters: a
 * login flow hands its result back through `window.opener`, which only a real
 * window keeps. A tab created here has no opener at all, so the page that
 * opened it waits forever — this is why "sign in with Google" did nothing.
 * The popup shares the app's session, so the cookies a login sets are the ones
 * the page that opened it reads, and Electron closes it with its opener.
 */
function popupWindowOptions() {
  return {
    backgroundColor: chromeBg(),
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  };
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
  const view = newView(
    {
      preload: path.join(__dirname, 'ui', preload),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
    chromeBackground(kind),
  );
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  watchViewKeys(view.webContents);
  return { view, ready: view.webContents.loadFile(path.join(__dirname, 'ui', file)) };
}

/**
 * Repaint every surface the blur setting controls, on the windows and pools
 * that already exist: the setting changes under a running browser, and what
 * the user sees has to be the new answer, not the next launch's.
 */
function applyBlur() {
  const bg = surfaceBg();
  const blurred = blurOn();
  for (const window of windows) {
    const win = window.win;
    if (!win) continue;
    if (desktopBlur) win.setBackgroundMaterial(blurred ? config.blurMaterial : 'none');
    win.setBackgroundColor(blurred ? '#00000000' : chromeBg());
    for (const [kind, view] of [
      ['bar', window.bar],
      ['panel', window.panel],
      ['sidebar', window.sidebar],
    ]) {
      if (view && !view.webContents.isDestroyed()) view.setBackgroundColor(chromeBackground(kind));
    }
    for (const tab of window.tabs.values()) {
      if (tab.url === HOME && tab.view) tab.view.setBackgroundColor(bg);
    }
  }
  for (const [kind, entry] of [
    ['bar', freeChrome.bar],
    ['sidebar', freeChrome.sidebar],
    ['panel', freeChrome.panel],
  ]) {
    for (const parked of entry) {
      if (parked.view && !parked.view.webContents.isDestroyed()) {
        parked.view.setBackgroundColor(chromeBackground(kind));
      }
    }
  }
  for (const view of freeTabs) {
    if (!view.webContents.isDestroyed()) view.setBackgroundColor(bg);
  }
}

/**
 * What each chrome view is painted with. The bar keeps its own strip at the
 * bottom of the window and the sidebar sits beside the page, so both show the
 * window's blur behind them. The settings panel is a whole page laid over the
 * page it covers: a clear surface there would show that page through its text,
 * so it keeps the chrome's colour.
 */
const chromeBackground = (kind) => (kind === 'panel' ? chromeBg() : surfaceBg());

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

/**
 * The empty tab is the same page every time, and starting a renderer for it on
 * the keystroke is what made ctrl+t wait seconds for a splash that never
 * changes. One view is kept loaded and painted here, so a new tab swaps it in
 * already showing: the quote is on screen in the same frame as the tab, and
 * nothing about the new tab waits on a renderer.
 *
 * The spare is never wired to a window until it is taken, so it holds no keys
 * and no page state; taking it starts the next spare in the background.
 */
const freeTabs = [];

function tabPreferences() {
  return {
    partition: PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    spellcheck: false,
  };
}

function warmTab() {
  if (freeTabs.length) return;
  mark('tab warming');
  const view = newView(tabPreferences(), surfaceBg());
  view.webContents.loadURL(HOME).catch(() => {});
  freeTabs.push(view);
}

/** A ready home view, or null when the pool is still cold. */
function takeWarmTab() {
  while (freeTabs.length) {
    const view = freeTabs.pop();
    if (!view.webContents.isDestroyed()) {
      mark('tab reused');
      setImmediate(warmTab);
      return view;
    }
    mark('tab dropped');
  }
  return null;
}

/**
 * Favourites the user keeps loaded (the preload switch in settings, plus the
 * page's own switch in the settings list). Each one is a real renderer already
 * showing the page and attached to no window, so opening it takes the view
 * instead of starting a load: the page is on screen in the frame the tab is.
 *
 * Taking one starts a replacement in the background — that is what makes the
 * second visit just as fast. The pool is never allowed to cost the browser
 * speed it did not ask for: pages start one at a time, none of them runs while
 * no window is open, and a favourite already on screen is not loaded twice
 * (opening it again is a normal load, which is what a fresh home page is).
 */
const preloads = new PreloadPool(startWarmPage);

function desiredWarmUrls() {
  if (!config?.preload || !visited || windows.size === 0) return [];
  const open = new Set();
  for (const window of windows) {
    for (const tab of window.tabs.values()) {
      open.add(tab.url);
      // A page kept as a back or forward step is still held by the tab: the
      // pool has no business loading a second copy of it.
      for (const view of [...(tab.steps?.back ?? []), ...(tab.steps?.forward ?? [])]) {
        const wc = view.webContents;
        if (!wc.isDestroyed() && wc.getURL()) open.add(wc.getURL());
      }
    }
  }
  return visited
    .favourites()
    .filter((fav) => fav.warm && /^(https?|file):/i.test(fav.url) && !open.has(fav.url))
    .map((fav) => fav.url);
}

// A start every this many milliseconds: several preloaded favourites are one
// queue, not a burst of renderers competing with the page the user is on.
const WARM_STAGGER_MS = 600;
let warmStaggerUntil = 0;

function startWarmPage(url) {
  const view = newView(tabPreferences());
  const wc = view.webContents;
  // A preloaded page is nobody's tab yet: a link it opens by itself must not
  // create one behind the user's back.
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const entry = {
    view,
    url,
    loadedAt: 0,
    done: false,
    failed: false,
    started: false,
    timer: null,
    load() {
      if (entry.started) return;
      entry.started = true;
      entry.timer = null;
      if (wc.isDestroyed()) {
        entry.failed = true;
        return;
      }
      mark(`warm start ${url}`);
      wc.loadURL(url).catch(() => {
        entry.failed = true;
      });
    },
    // A tab takes this page before its turn came: load it now, on the keystroke.
    activate() {
      clearTimeout(entry.timer);
      entry.load();
    },
    close() {
      clearTimeout(entry.timer);
      entry.timer = null;
      mark(`warm drop ${url}`);
      if (!wc.isDestroyed()) wc.close();
    },
  };
  wc.once('did-finish-load', () => {
    entry.loadedAt = Date.now();
    entry.done = true;
    mark(`warm ready ${url}`);
  });
  wc.once('did-fail-load', (_event, code, description, _validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    entry.failed = true;
    mark(`warm failed ${url}: ${description || code}`);
  });
  const now = Date.now();
  const delay = Math.max(0, warmStaggerUntil - now);
  warmStaggerUntil = Math.max(now, warmStaggerUntil) + WARM_STAGGER_MS;
  entry.timer = setTimeout(entry.load, delay);
  return entry;
}

/**
 * Make the pool match the user's choice: drop what is no longer a favourite,
 * no longer switched on, or now open in a window — and start what is missing.
 * Called at startup, after a favourite changes and after settings are saved.
 */
function syncWarmPages() {
  if (!config || !visited) return;
  preloads.sync(desiredWarmUrls());
}

/** A pooled view for this address, or null — the tab then loads normally. */
function takeWarmPage(url) {
  const entry = preloads.take(url);
  if (entry) {
    // Its turn had not come: the keystroke starts it instead of waiting.
    entry.activate();
    mark('warm used');
  }
  // Re-read the choice off the keystroke: while this page sits in a tab it is
  // not loaded a second time, and when it is closed or navigated away the pool
  // takes it back.
  setImmediate(syncWarmPages);
  return entry;
}

class Browser {
  constructor(snapshot = {}) {
    this.id = nextWindowId++;
    this.saved = snapshot;
    this.win = null;

    this.tabs = new Map();
    this.activeTabId = null;

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
    // A tool the user calls with ctrl+e, never part of what a window opens
    // with: a new window and a restored instance both start on the whole page,
    // and only a toggle made in a window brings its sidebar out.
    this.sidebarVisible = false;
    this.sidebarLoaded = false;
    this.sidebarReady = null;
    this.barLoaded = false;
    this.pendingBar = null;
    this.sidebarAttached = false;
    this.pageLayouts = 0;

    // Two panes over one window: `a` and `b` are tab ids kept in a fixed
    // order, so focusing the other one does not swap the pictures around.
    this.split = null;
    // The strips framing those panes, lit on the one with the keys; they
    // belong to a window, so a window that goes takes them with it.
    this.paneEdges = null;
    // The command bar's current shape; the workspace picker is one of them.
    this.barMode = 'address';
    // The tab a split pairs with, and the tab focus came from.
    this.previousTabId = null;
    // The named workspace this window is showing, when it came from one.
    this.workspaceName = null;

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
      // The backdrop is the window's, not a view's: ask Windows for it when
      // the setting is on, and the surfaces over it paint the tint the views
      // are given. No `backgroundColor` beside it — an opaque one would paint
      // over the blur.
      ...(blurOn()
        ? { backgroundMaterial: config.blurMaterial }
        : { backgroundColor: chromeBg() }),
    });
    this.win = win;
    windows.add(this);

    this.restoreBounds();

    win.on('resize', () => this.layout());
    win.on('close', () => {
      this.finalSnapshot = this.snapshot();
      this.persistTabsNow();
      this.saveWorkspaceOnClose();
      this.detachChrome();
    });
    win.on('closed', () => this.release());

    // The window is the launch: show it before the session, the bar or a page
    // exists, so nothing on the slow path can hold the first paint. A no-ui
    // launch builds the same window and leaves it off screen: the build, the
    // session and the page load are the part a test wants, and the window
    // itself is the part it came to avoid.
    if (!NO_UI) win.show();
    mark(NO_UI ? 'window kept hidden' : 'window shown');

    return this.build();
  }

  /**
   * Everything the window shows, built after it is already on screen. A second
   * window skips the cold work: `prepareSession` is a resolved promise by then,
   * and it starts with no saved tabs, so the bar is the only view it loads.
   */
  async build() {
    const win = this.win;
    // The bar is the launch surface and needs nothing from the session: its
    // renderer starts now, beside the extensions instead of behind them, so
    // the palette is up as early as the window allows.
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

    await prepareSession();
    mark('session ready');

    if (this.sidebarVisible) {
      const view = this.ensureSidebar();
      this.sidebarReady.then(() => {
        if (!this.win) return;
        win.contentView.addChildView(view);
        this.sidebarAttached = true;
        this.layout();
        updateSidebars();
      });
    }

    const savedTabs = Array.isArray(this.saved.tabs)
      ? this.saved.tabs
          .filter((url) => typeof url === 'string' && URL_RE.test(url))
          // A state file from before the home page says about:blank; that tab
          // is the empty one, so it opens on the home page.
          .map((url) => (url === BLANK ? HOME : url))
      : [];
    // A launch builds its tabs without focusing them: the page's focus call
    // lands whenever its renderer finishes, which is after the bar's and took
    // the caret back. The palette is the launch surface, so it is what holds
    // the focus, and it comes up as soon as its own renderer is ready.
    const startUrls = savedTabs.length ? savedTabs : [HOME];
    startUrls.forEach((url, index) =>
      this.createTab({ url, activate: index === 0, focus: false }),
    );
    if (typeof this.saved.activeTab === 'number') {
      const ids = [...this.tabs.keys()];
      if (ids[this.saved.activeTab] !== undefined) {
        this.activateTab(ids[this.saved.activeTab], { focus: false });
      }
    }
    const savedSplit = this.saved.split;
    if (savedSplit) {
      const ids = [...this.tabs.keys()];
      const a = ids[savedSplit.a];
      const b = ids[savedSplit.b];
      if (a !== undefined && b !== undefined && a !== b) {
        this.attachSplit(a, b, savedSplit.orientation === 'horizontal' ? 'horizontal' : 'vertical');
      }
    }
    this.workspaceName = normalizeName(this.saved.workspace) || null;
    this.saved = {};

    this.layout();
    updateSidebars();
    mark('page created');
    // The favourites kept ready load now, beside the bar: they are decoration
    // for a later keystroke, so nothing this launch shows waits on them, and
    // they do not wait on the bar's renderer either.
    setImmediate(() => {
      if (this.win) syncWarmPages();
    });
    // Waited for last, so the pages start loading beside the bar instead of
    // behind it: the bar only holds the launch back if its own renderer is
    // slower than the page's, and nothing else waits on either.
    await barReady;
    this.showBar();
    // Warm the panel, the spare chrome and the spare empty tab after the
    // window is up: the first `:extensions`, the next ctrl+n and the next
    // ctrl+t then cost nothing.
    setImmediate(() => {
      if (!this.win) return;
      if (!this.panel) this.ensurePanel();
      warmChrome();
      warmTab();
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
      this.closeSteps(tab);
    }
    this.tabs.clear();
    this.activeTabId = null;
    clearTimeout(this.persistTimer);
    this.split = null;
    this.paneEdges = null;
    this.previousTabId = null;
    this.workspaceName = null;
    this.barMode = 'address';
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
    // The tabs this window held are no longer anyone's: the windows still open
    // drop them from their sidebars.
    if (windows.size) updateSidebars();
    // A parked browser holds no preloaded renderer: with no window open there
    // is nothing for them to make instant, so the memory goes back.
    if (!windows.size) syncWarmPages();
    // Closing the last window leaves its tabs on disk, so a resident relaunch
    // (or the next cold start) opens what the user was just looking at.
    remembered = windows.size ? null : this.finalSnapshot;
    persistState();
  }

  focus() {
    // A test launch has no window on screen to focus, and asking the OS for one
    // is how a hidden window ends up showing.
    if (NO_UI || !this.win || this.win.isDestroyed()) return;
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
    const state = this.workspaceState();
    return {
      bounds: this.win && !this.win.isDestroyed() ? this.win.getBounds() : this.saved.bounds,
      tabs: state.tabs,
      activeTab: state.activeTab,
      split: state.split,
      workspace: this.workspaceName,
    };
  }

  /** A tab's address, read live when its page still exists. */
  urlOf(tab) {
    // A tab whose renderer is gone has no URL to read, and asking a destroyed
    // webContents throws. The tab's last recorded url still names the page,
    // and this runs while the window closes: a throw here keeps it open.
    return tab.view?.webContents.isDestroyed() === false
      ? tab.view.webContents.getURL() || tab.url || HOME
      : tab.url || HOME;
  }

  /** The window as a workspace: its tabs, the focused one, and any split. */
  workspaceState() {
    const ids = [...this.tabs.keys()];
    return {
      tabs: [...this.tabs.values()].map((tab) => this.urlOf(tab)),
      activeTab: Math.max(0, ids.indexOf(this.activeTabId)),
      split: this.split
        ? {
            a: ids.indexOf(this.split.a),
            b: ids.indexOf(this.split.b),
            orientation: this.split.orientation,
          }
        : null,
    };
  }

  /** Remember the tabs under this window's workspace name, if it has one. */
  saveWorkspaceOnClose() {
    if (!this.workspaceName) return;
    const state = this.workspaceState();
    if (!state.tabs.length) return;
    workspaces?.save(this.workspaceName, state);
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
    if (this.split) {
      const a = this.tabs.get(this.split.a);
      const b = this.tabs.get(this.split.b);
      const va = a?.view;
      const vb = b?.view;
      if (va && vb) {
        const [first, second] = splitBounds(
          width,
          contentHeight,
          this.split.orientation,
          SPLIT_GAP,
          SPLIT_EDGE,
        );
        if (place(va, first)) this.pageLayouts += 1;
        if (place(vb, second)) this.pageLayouts += 1;
        this.placePaneEdges({ a: first, b: second });
      }
    } else if (tab?.view && place(tab.view, { x: 0, y: 0, width, height: contentHeight })) {
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

  // ------------------------------------------------------------------ panes

  /**
   * The four strips that frame a pane, tmux's way of saying which one holds
   * the keys. Plain views, not pages: an indicator costs no renderer, and the
   * strips cover none of either page — the panes already leave that room.
   */
  buildPaneEdges() {
    if (this.paneEdges) return this.paneEdges;
    const edges = [];
    for (const slot of ['a', 'b']) {
      for (const side of ['top', 'bottom', 'left', 'right']) {
        edges.push({ slot, side, view: new View() });
      }
    }
    this.paneEdges = edges;
    return edges;
  }

  /**
   * Put the frames in the window: above the pages, so they show, and below the
   * chrome, so a sidebar or bar that floats over the split is not painted
   * across. Called once per split — the frames are then left to `layout`.
   */
  attachPaneEdges() {
    const pages = [...this.tabs.values()].filter((tab) => tab.attached).length;
    this.buildPaneEdges().forEach(({ view }, index) => {
      this.win.contentView.addChildView(view, pages + index);
    });
  }

  detachPaneEdges() {
    for (const { view } of this.paneEdges ?? []) {
      try {
        this.win?.contentView.removeChildView(view);
      } catch {
        // the window is already gone with the split
      }
    }
    this.paneEdges = null;
  }

  /** Which of the two panes the keys and the bar act on. */
  activePaneSlot() {
    return this.split?.a === this.activeTabId ? 'a' : 'b';
  }

  /** Colour the frames: the pane with the keys in the accent, the other dim. */
  paintPaneEdges() {
    if (!this.paneEdges) return;
    const active = paneEdge(true);
    const idle = paneEdge(false);
    const slot = this.activePaneSlot();
    for (const { slot: edgeSlot, view } of this.paneEdges) {
      view.setBackgroundColor(edgeSlot === slot ? active : idle);
    }
  }

  /** Frame both panes where the split put them. */
  placePaneEdges(rects) {
    if (!this.paneEdges) return;
    for (const { slot, side, view } of this.paneEdges) {
      view.setBounds(edgeBounds(rects[slot], side, SPLIT_EDGE));
    }
    this.paintPaneEdges();
  }

  /**
   * Two tabs over one window. `a` stays left (or top) and `b` right (or
   * bottom) whatever the focus does, so switching between them never swaps
   * the pictures; the focused one is simply the active tab.
   */
  attachSplit(a, b, orientation) {
    if (!this.win) return;
    const first = this.tabs.get(a);
    const second = this.tabs.get(b);
    if (!first || !second || a === b) return;
    const viewA = this.tabView(first);
    const viewB = this.tabView(second);
    this.split = { a, b, orientation };
    // Electron refuses to add a view that is already a child, so only the
    // pane that is not on screen yet is added.
    if (!first.attached) {
      this.win.contentView.addChildView(viewA, 0);
      first.attached = true;
    }
    if (!second.attached) {
      this.win.contentView.addChildView(viewB, 0);
      second.attached = true;
    }
    this.attachPaneEdges();
    this.layout();
    this.updateSidebar();
    this.persistTabs();
  }

  /** Alt+S / Alt+Shift+S: open a split, turn it, or close it. */
  toggleSplit(orientation) {
    if (!this.win) return;
    if (this.split) {
      if (this.split.orientation === orientation) {
        this.closeSplit();
        return;
      }
      this.split.orientation = orientation;
      this.layout();
      this.persistTabs();
      return;
    }
    const active = this.activeTab();
    if (!active) return;
    let partner =
      this.previousTabId != null && this.previousTabId !== active.id
        ? this.tabs.get(this.previousTabId)
        : null;
    if (!partner) partner = [...this.tabs.values()].find((tab) => tab.id !== active.id) ?? null;
    // One tab has nothing to pair with, so the split asks for a second page.
    if (!partner) partner = this.createTab({ activate: false });
    this.attachSplit(active.id, partner.id, orientation);
    // Splitting is a move into the pane just made, the way tmux hands the
    // cursor to the shell a split opens: the keys land where the split did.
    this.setActivePane(partner.id);
  }

  /** Close the split, keeping both tabs: the focused one fills the window. */
  closeSplit() {
    if (!this.split) return;
    const otherId = this.activeTabId === this.split.a ? this.split.b : this.split.a;
    const other = this.tabs.get(otherId);
    if (other?.view && other.attached) {
      try {
        this.win.contentView.removeChildView(other.view);
      } catch {
        // the view is already gone with the window
      }
      other.attached = false;
    }
    this.split = null;
    this.detachPaneEdges();
    this.layout();
    this.updateSidebar();
    this.persistTabs();
  }

  /**
   * Focus the other pane without moving it. Electron lets the click do this
   * on its own (`wireTab` listens for focus), and Alt+H/J/K/L do it from the
   * keyboard.
   */
  setActivePane(id, { focus = true } = {}) {
    if (!this.split || id === this.activeTabId) return;
    if (id !== this.split.a && id !== this.split.b) return;
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.previousTabId = this.activeTabId;
    this.activeTabId = id;
    const view = this.tabView(tab);
    if (focus) view.webContents.focus();
    this.paintPaneEdges();
    this.win.setTitle(tab.title ? `${tab.title} — tbrowser` : 'tbrowser');
    this.updateSidebar();
    this.persistTabs();
  }

  /** Swap every tab for a saved set in one step, split included. */
  replaceTabs(state) {
    if (!this.win) return;
    this.split = null;
    this.detachPaneEdges();
    for (const tab of this.tabs.values()) {
      if (!tab.view) continue;
      if (tab.attached) {
        try {
          this.win.contentView.removeChildView(tab.view);
        } catch {
          // the window is going away
        }
        tab.attached = false;
      }
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      this.closeSteps(tab);
    }
    this.tabs.clear();
    this.activeTabId = null;
    this.previousTabId = null;

    const urls = Array.isArray(state.tabs) && state.tabs.length ? state.tabs : [HOME];
    const ids = urls.map((url) => {
      const id = nextTabId++;
      this.tabs.set(id, { id, view: null, title: '', url });
      return id;
    });
    const active = ids[Number.isInteger(state.activeTab) ? state.activeTab : 0] ?? ids[0];
    this.activateTab(active);
    const split = state.split;
    if (split) {
      const a = ids[split.a];
      const b = ids[split.b];
      if (a !== undefined && b !== undefined && a !== b) {
        this.attachSplit(a, b, split.orientation === 'horizontal' ? 'horizontal' : 'vertical');
      }
    }
    updateSidebars();
    this.persistTabs();
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
    const value =
      mode === 'command' ? ':' : mode === 'search' || mode === 'workspace' ? '' : url && url !== HOME ? url : '';
    this.barMode = mode;
    const isCommand = mode === 'command';
    const preselect = mode === 'workspace';
    this.barHeight = BAR_HEIGHT;
    this.barListOpen = false;
    if (this.barVisible) {
      this.bar.webContents.send('bar:edit', value, isCommand, preselect);
      this.bar.webContents.focus();
      return;
    }
    this.barVisible = true;
    this.win.contentView.addChildView(this.bar);
    this.layout();
    this.bar.webContents.send('bar:edit', value, isCommand, preselect);
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

  /**
   * Every open tab in the browser, this window's first, as the palette needs
   * it. A tab of another window carries that window's place in the list, so
   * the row can say where it lives.
   */
  pickerTabs() {
    return sharedTabRows(this);
  }

  navigate(raw) {
    const url = parseInput(raw, config.searchUrl);
    const tab = this.activeTab();
    if (!url || !tab) return;
    // Opening a favourite swaps in the page that was kept ready: already
    // loaded, so it is on screen at once. A tab with an address of its own
    // hands the page it was showing to the back step below, so the swap costs
    // no history; the empty tab held nothing to lose. Asking for the page the
    // tab already shows is a refresh, not a visit: it loads the ordinary way.
    if (tab.view && url !== tab.url) {
      const warm = takeWarmPage(url);
      if (warm) {
        this.adoptWarmPage(tab, warm, { attach: true });
        return;
      }
    }
    this.tabView(tab).webContents.loadURL(url).catch((err) => {
      console.warn(`[tbrowser] navigation failed: ${err.message}`);
    });
  }

  /**
   * Wire a pooled page to a tab: it is already loaded, so it is a title and an
   * address to read, not a load to wait on. A page that has sat ready long
   * enough is fetched again after it is on screen, so a home page that moves is
   * current rather than the copy the pool happened to hold.
   */
  adoptWarmPage(tab, entry, { attach = false } = {}) {
    const view = entry.view;
    const wc = view.webContents;
    if (entry.done && Date.now() - entry.loadedAt > WARM_REFRESH_MS) {
      wc.reload();
    }
    const previous = this.swapTabView(tab, view, { attach });
    tab.url = wc.getURL() || entry.url || tab.url;
    tab.title = wc.getTitle() || tab.title;
    if (attach && previous && previous.webContents !== wc) {
      this.retirePage(tab, previous);
    }
    // The visit is recorded last: it writes to disk, and the page is already
    // on its way to the screen.
    visited.record(tab.url, tab.title);
    updateSidebars();
    mark('tab warm');
    return view;
  }

  /**
   * Put a view in a tab's place and hand back the one it replaced, detached
   * and no longer listening. The caller decides where the old page goes: to
   * the splash pool, to a history step, or closed.
   */
  swapTabView(tab, view, { attach = false } = {}) {
    const previous = tab.view;
    const wc = view.webContents;
    if (previous && previous.webContents !== wc && !previous.webContents.isDestroyed()) {
      this.unwireTab(previous.webContents);
      if (tab.attached) this.win?.contentView.removeChildView(previous);
      tab.attached = false;
    }
    tab.view = view;
    tab.url = wc.getURL() || tab.url;
    track(this, view);
    this.wireTab(tab);
    tab.title = wc.getTitle() || '';
    if (attach && this.win) {
      this.win.contentView.addChildView(view, 0);
      tab.attached = true;
    }
    if (tab.id === this.activeTabId) {
      if (this.win) {
        this.win.setTitle(tab.title ? `${tab.title} — tbrowser` : 'tbrowser');
        this.layout();
        // The bar had the keys until it hid, and the view it focused is the
        // one just swapped out: the page takes the keystroke from here.
        if (attach) wc.focus();
      }
      this.persistTabs();
    }
    return previous;
  }

  /**
   * The page a swap took out. An empty tab goes back to the splash pool, and a
   * page becomes the step back: it is a whole renderer still holding what it
   * showed, so going back is a swap rather than a load.
   */
  retirePage(tab, view) {
    const wc = view.webContents;
    if (wc.isDestroyed()) return;
    if (wc.getURL() !== HOME) {
      mark('tab step back');
      this.parkView(tab, view, 'back');
      return;
    }
    // The splash the tab was showing goes back to its own pool, as it does
    // when an empty tab is closed.
    if (freeTabs.length === 0) {
      mark('tab parked');
      freeTabs.push(view);
    } else {
      wc.close();
    }
  }

  /** Keep a page as a step beside the one on screen, dropping the oldest. */
  parkView(tab, view, direction) {
    const steps = (tab.steps ??= { back: [], forward: [] });
    steps[direction].push(view);
    while (steps[direction].length > MAX_TAB_STEPS) {
      const old = steps[direction].shift();
      if (!old.webContents.isDestroyed()) old.webContents.close();
    }
  }

  /** Close the pages a tab kept for back and forward; the tab is going. */
  closeSteps(tab) {
    if (!tab.steps) return;
    for (const view of [...tab.steps.back, ...tab.steps.forward]) {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    tab.steps = null;
  }

  go(delta) {
    const tab = this.activeTab();
    if (!tab?.view) return;
    const history = tab.view.webContents.navigationHistory;
    if (delta < 0 && history.canGoBack()) return history.goBack();
    if (delta > 0 && history.canGoForward()) return history.goForward();
    // The renderer has nothing left that way, but a warm swap may have stepped
    // over pages the tab still has: those are the steps, and back reaches them
    // without a load.
    const from = delta < 0 ? tab.steps?.back : tab.steps?.forward;
    let view = null;
    while (from?.length) {
      const step = from.pop();
      if (!step.webContents.isDestroyed()) {
        view = step;
        break;
      }
    }
    if (!view) return;
    mark('tab step');
    const gone = this.swapTabView(tab, view, { attach: true });
    if (gone && !gone.webContents.isDestroyed()) {
      this.parkView(tab, gone, delta < 0 ? 'forward' : 'back');
    }
    visited.record(tab.url, tab.title);
    updateSidebars();
  }

  /**
   * Take the tab's own wiring off a view before it goes back to the pool, so
   * the window that takes it next does not hear about a tab that is gone.
   */
  unwireTab(wc) {
    for (const event of [
      'page-title-updated',
      'did-navigate',
      'did-navigate-in-page',
      'focus',
      'before-input-event',
    ]) {
      wc.removeAllListeners(event);
    }
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    viewOwners.delete(wc.id);
  }

  wireTab(tab) {
    const wc = tab.view.webContents;

    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      if (!URL_RE.test(url)) return { action: 'deny' };
      // A popup is a window, not a tab: window.open with a size (the way a
      // sign-in button opens one) must keep `window.opener` alive, which a tab
      // we build ourselves cannot. A plain target=_blank link still lands in a
      // tab, as it always did.
      if (disposition === 'new-window' || features) {
        return { action: 'allow', overrideBrowserWindowOptions: popupWindowOptions() };
      }
      this.createTab({ url });
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
      updateSidebars();
    });
    wc.on('did-navigate', (_event, url) => {
      tab.url = url;
      // The home page is the absence of a page; it is not a visit.
      if (url !== HOME) visited.record(url, tab.title);
      if (tab.id === this.activeTabId) this.persistTabs();
      // The page the tab left is nobody's now: a favourite among them can be
      // kept ready again. Deferred, so the page that is on screen comes first.
      setImmediate(syncWarmPages);
    });
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
      if (url !== HOME) visited.record(url, tab.title);
      if (tab.id === this.activeTabId) this.persistTabs();
    });
    // Clicking a page is how a split changes which pane the bar and the keys
    // act on. Outside a split this event has nothing to say.
    wc.on('focus', () => {
      if (this.split && tab.id !== this.activeTabId) this.setActivePane(tab.id, { focus: false });
    });
    this.watchKeys(wc);
  }

  /** Create a tab's renderer on first use; a restored tab costs nothing until then. */
  tabView(tab) {
    if (tab.view) return tab.view;
    // A favourite kept ready is taken whole: the tab opens on a page that is
    // already loaded instead of starting a load of its own.
    if (tab.url && tab.url !== HOME) {
      const warm = takeWarmPage(tab.url);
      if (warm) return this.adoptWarmPage(tab, warm);
    }
    // An empty tab takes the splash that is already loaded and painted; only a
    // tab with an address of its own pays for a renderer.
    const warm = tab.url === HOME ? takeWarmTab() : null;
    if (!warm) mark('tab renderer new');
    const view = warm ?? newView(tabPreferences(), tab.url === HOME ? surfaceBg() : chromeBg());
    tab.view = view;
    track(this, view);
    this.wireTab(tab);
    if (warm) {
      // The spare already has a quote painted; this tab gets its own, and the
      // swap costs a text change rather than a page load.
      view.webContents.executeJavaScript('window.rollQuote?.()').catch(() => {});
      return view;
    }
    const wc = view.webContents;
    // A new tab is a keystroke: the gap between the press and the page on
    // screen is what these two marks measure.
    wc.once('dom-ready', () => mark('tab dom-ready'));
    wc.once('did-finish-load', () => mark('tab painted'));
    wc.loadURL(tab.url || HOME).catch(() => {});
    return view;
  }

  createTab({ url = HOME, activate = true, openBar = false, focus = true } = {}) {
    const id = nextTabId++;
    const tab = { id, view: null, title: '', url, attached: false };
    this.tabs.set(id, tab);
    // activateTab already repaints the list; only a background tab needs it.
    // A tab whose bar opens hands the focus to the bar instead of the page:
    // two focus calls in a row let the page's land last, which left the caret
    // in the new page rather than in the palette that had just opened.
    if (activate) this.activateTab(id, { focus: focus && !openBar });
    else updateSidebars();
    this.persistTabs();
    if (openBar) this.showBar();
    return tab;
  }

  activateTab(id, { focus = true } = {}) {
    const tab = this.tabs.get(id);
    if (!tab || !this.win) return;
    // A tab already on screen in one of the panes is just a focus move: it
    // must not be detached and re-added, or the split would collapse.
    if (this.split && (id === this.split.a || id === this.split.b)) {
      this.setActivePane(id, { focus });
      return;
    }
    const previous = this.activeTab();
    if (this.split) {
      // Change the page in the focused pane; the other pane keeps its own.
      const slot = previous && previous.id === this.split.a ? 'a' : 'b';
      if (previous && previous.id !== id && previous.view) {
        this.win.contentView.removeChildView(previous.view);
        previous.attached = false;
      }
      this.previousTabId = previous?.id ?? null;
      this.split[slot] = id;
      this.activeTabId = id;
      const view = this.tabView(tab);
      if (!tab.attached) {
        this.win.contentView.addChildView(view, 0);
        tab.attached = true;
      }
      this.layout();
      if (focus) view.webContents.focus();
      this.win.setTitle(tab.title ? `${tab.title} — tbrowser` : 'tbrowser');
      updateSidebars();
      this.persistTabs();
      return;
    }
    if (previous && previous.id !== id && previous.view) {
      this.win.contentView.removeChildView(previous.view);
      previous.attached = false;
    }
    this.previousTabId = previous?.id ?? null;
    this.activeTabId = id;
    const view = this.tabView(tab);
    // Bottom of the stack: the sidebar and the chrome draw over the page, so a
    // page added here never covers the view floating above it.
    if (!tab.attached) {
      this.win.contentView.addChildView(view, 0);
      tab.attached = true;
    }
    this.layout();
    if (focus) view.webContents.focus();
    this.win.setTitle(tab.title ? `${tab.title} — tbrowser` : 'tbrowser');
    updateSidebars();
    this.persistTabs();
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const inSplit = this.split && (id === this.split.a || id === this.split.b);
    const otherId = inSplit ? (this.split.a === id ? this.split.b : this.split.a) : null;
    this.tabs.delete(id);
    // A favourite that was open is no longer taking its renderer: it can be
    // kept ready again. Deferred, so closing a tab stays a keystroke.
    setImmediate(syncWarmPages);
    if (tab.view) {
      if (tab.attached) {
        this.win.contentView.removeChildView(tab.view);
        tab.attached = false;
      }
      // A tab whose renderer crashed still has its view, and closing a
      // destroyed webContents throws — which used to stop the close below.
      const wc = tab.view.webContents;
      if (!wc.isDestroyed()) {
        // An empty tab was the splash: closing it hands the painted page back to
        // the pool for the next ctrl+t, so it never pays for another renderer.
        if (wc.getURL() === HOME && freeTabs.length === 0) {
          mark('tab parked');
          this.unwireTab(wc);
          freeTabs.push(tab.view);
        } else {
          wc.close();
        }
      }
    }
    // The pages the tab kept for back and forward went with it.
    this.closeSteps(tab);
    if (inSplit) {
      // One pane is left, so the split goes with the tab; the surviving pane
      // fills the window.
      this.split = null;
      if (this.activeTabId === id) {
        this.activeTabId = null;
        if (otherId !== null && this.tabs.has(otherId)) {
          this.activateTab(otherId);
          this.layout();
          this.persistTabs();
          return;
        }
      }
      this.layout();
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
    updateSidebars();
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
    // Only a handful of openers; the rest of the table is matched without
    // re-parsing accelerator strings on every keystroke.
    const openerIndex = keys.openBar.findIndex((expected) => matchesAny(input, [expected]));
    const opener = openerIndex === -1 ? null : config.keybindings.openBar[openerIndex];
    const search = keys.search?.length > 0 && matchesAny(input, keys.search);
    if (opener || search) {
      if (!this.barVisible) {
        // ":" lands in vim's command line; Ctrl+L/Ctrl+K start on the address
        // instead, where a leading ":" turns the input back into a command.
        this.showBar(opener === ':' ? 'command' : search ? 'search' : 'address');
        return true;
      }
      // The bar is already up, so the key brings the caret back to it instead
      // of opening a second one or wiping what is typed. A bare ":" is text
      // once the bar holds the keys, so only a modified opener counts here —
      // otherwise ":" could never be typed into the bar.
      if (input.control || input.alt || input.meta) {
        this.bar.webContents.focus();
        this.bar.webContents.send('bar:focus');
        return true;
      }
    }
    if (matchesAny(input, keys.workspaces)) {
      this.showBar('workspace');
      return true;
    }
    if (matchesAny(input, keys.splitVertical)) {
      this.toggleSplit('vertical');
      return true;
    }
    if (matchesAny(input, keys.splitHorizontal)) {
      this.toggleSplit('horizontal');
      return true;
    }
    // Alt+H/J/K/L move between the panes, the way they move between tmux
    // panes in the editor; with no split they belong to the page.
    if (this.split && keys.focusPane?.length && matchesAny(input, keys.focusPane)) {
      const key = String(input.key).toLowerCase();
      const toB = ['l', 'right', 'j', 'down'].includes(key);
      const toA = ['h', 'left', 'k', 'up'].includes(key);
      this.setActivePane(
        toB ? this.split.b : toA ? this.split.a : this.activeTabId === this.split.a ? this.split.b : this.split.a,
      );
      return true;
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
      if (this.win) updateSidebars();
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

/** Every window's tabs as the shared list wants them: ids, titles, addresses. */
function windowTabLists() {
  return [...windows].map((window) => ({
    id: window.id,
    tabs: [...window.tabs.values()].map((tab) => ({
      id: tab.id,
      title: tab.title || window.titleFor(tab),
      url: window.urlOf(tab),
      active: tab.id === window.activeTabId,
    })),
  }));
}

/** The tabs of every window, this one's first. */
function sharedTabRows(current) {
  return sharedTabs(windowTabLists(), current.id);
}

/** The window holding a tab, or null when no window does. */
function windowOfTab(id) {
  for (const window of windows) {
    if (window.tabs.has(id)) return window;
  }
  return null;
}

/**
 * Go to a tab wherever it lives: a tab of this window is a plain switch, one
 * held by another window brings that window to the front with it, the way
 * `switch-client` does in tmux. A test launch never shows a window, so there
 * it is only the switch.
 */
function revealTab(id, from) {
  const owner = windowOfTab(id);
  if (!owner) return 'no such tab';
  from.hideBar();
  if (owner !== from && !NO_UI && owner.win && !owner.win.isDestroyed()) {
    if (!owner.win.isVisible()) owner.win.show();
    owner.win.focus();
  }
  owner.activateTab(id);
  return null;
}

/**
 * A second tab on the page another one already shows. The document is its own
 * — a renderer cannot be on two windows at once — but the session is shared, so
 * the address is served from the memory cache the open tab filled.
 */
function copyTabHere(id, target) {
  const owner = windowOfTab(id);
  if (!owner) return 'no such tab';
  const url = owner.urlOf(owner.tabs.get(id));
  target.hideBar();
  target.createTab({ url });
  return null;
}

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

/**
 * Focus the window in front, or build one.
 *
 * `restore` belongs to the process start alone: the first window it shows picks
 * up the tabs the last run left in `state.json`. A launch that lands on a
 * browser already running — a second press of the exe, the control pipe, the
 * request file — is a request for a new instance, so a parked process opens an
 * empty window instead of handing back the tabs it was parked on.
 */
function showWindow({ restore = false } = {}) {
  // A Browser can outlive its window: a failed build, or a release that never
  // ran, leaves one in this set with nothing on screen. Focusing it is a no-op
  // and the request dies there, which is how a resident process ends up with
  // no window and no way to ask for one — drop it and build a fresh window.
  for (const window of windows) {
    if (window.win && window.win.isDestroyed()) windows.delete(window);
  }
  const existing = [...windows].pop();
  if (existing) {
    // A no-ui run never brings a window back: not showing it is the whole point.
    if (NO_UI) return Promise.resolve();
    if (!existing.win.isVisible()) existing.win.show();
    existing.focus();
    // A launch is a request to type: the bar comes up with the caret in it, the
    // way a cold start's does, instead of leaving focus wherever the window had
    // it. Focus lands after the window's, or the bar's would be undone.
    existing.showBar();
    return Promise.resolve();
  }
  if (!restore) return openWindow();
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
      // A favourite dropped from the list stops being preloaded with it.
      syncWarmPages();
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
    case 'ws':
    case 'workspaces':
      return workspaceCommand(window, command.args);
    case 'tab': {
      // `:tab <id>` goes to the tab, whichever window holds it; `:tab copy
      // <id>` opens that tab's page here instead of leaving this window.
      const first = String(command.args[0] ?? '').toLowerCase();
      if (first === 'copy') {
        const copy = Number(command.args[1]);
        if (!Number.isInteger(copy)) return 'copy which tab?';
        return copyTabHere(copy, window);
      }
      const id = Number(command.args[0]);
      if (!Number.isInteger(id)) return 'no such tab';
      return revealTab(id, window);
    }
    case 'vsplit':
      window.hideBar();
      window.toggleSplit('vertical');
      return null;
    case 'split':
      window.hideBar();
      window.toggleSplit('horizontal');
      return null;
    case 'only':
      window.hideBar();
      window.closeSplit();
      return null;
    default:
      return NOT_A_COMMAND;
  }
}

/**
 * `:ws` with no verb is the picker; save keeps the window's tabs under a name
 * (the page's host when none is given), open swaps them in, delete forgets one.
 */
function workspaceCommand(window, args) {
  const [verb, ...rest] = args;
  const name = normalizeName(rest.join(' '));
  switch (String(verb ?? '').toLowerCase()) {
    case '':
    case 'list':
      window.showBar('workspace');
      return null;
    case 'save': {
      const state = window.workspaceState();
      const chosen =
        name || autoName(state.tabs, state.activeTab, workspaces.list().map((entry) => entry.name));
      const entry = workspaces.save(chosen, state);
      if (!entry) return 'the workspace needs a name';
      window.workspaceName = entry.name;
      window.persistTabs();
      window.bar.webContents.send(
        'bar:notice',
        `saved workspace ${entry.name} · ${entry.tabs.length} tab${entry.tabs.length === 1 ? '' : 's'}`,
      );
      return null;
    }
    case 'delete': {
      if (!name) return 'delete which workspace?';
      if (!workspaces.remove(name)) return `no workspace "${name}"`;
      if (window.workspaceName?.toLowerCase() === name.toLowerCase()) {
        window.workspaceName = null;
        window.persistTabs();
      }
      window.bar.webContents.send('bar:notice', `deleted workspace ${name}`);
      return null;
    }
    case 'open': {
      if (!name) {
        window.showBar('workspace');
        return null;
      }
      const entry = workspaces.get(name);
      if (!entry) return `no workspace "${name}"`;
      return switchWorkspace(window, entry);
    }
    default:
      return `unknown workspace command "${verb}"`;
  }
}

/**
 * Switch a window to a saved set of tabs. What it was showing is written back
 * first — into its own workspace when it has a name, into one rolling slot
 * otherwise — so Alt+P always has a way back.
 */
function switchWorkspace(window, entry) {
  const state = window.workspaceState();
  if (window.workspaceName) {
    workspaces.save(window.workspaceName, state);
  } else if (entry.name.toLowerCase() !== LAST_WORKSPACE) {
    workspaces.save(LAST_WORKSPACE, state);
  }
  const fresh = workspaces.get(entry.name);
  if (!fresh) return `no workspace "${entry.name}"`;
  window.replaceTabs(fresh);
  window.workspaceName = fresh.name;
  window.persistTabs();
  window.bar.webContents.send(
    'bar:notice',
    `workspace ${fresh.name} · ${fresh.tabs.length} tab${fresh.tabs.length === 1 ? '' : 's'}`,
  );
  return null;
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
  const window = ctxFor(event);
  // A colon in the workspace picker means the user is typing a command, so
  // the list turns back into the ordinary command list from that character on.
  const typedColon = String(text ?? '').trim().startsWith(':');
  const picker = window?.barMode === 'workspace' && !typedColon;
  const mode = picker ? 'workspace' : window?.barMode === 'workspace' ? 'address' : window?.barMode;
  const items = suggestions(text, {
    history: visited.list(),
    favourites: visited.favourites(),
    searchUrl: config.searchUrl,
    tabs: window ? window.pickerTabs() : [],
    workspaces: workspaces ? workspaces.list() : [],
    mode,
  });
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
  // A row can be a tab of another window, so the action goes to the window
  // holding it. `new` is always this window's.
  const owner = Number.isInteger(id) ? windowOfTab(id) : null;
  if (action.type === 'activate') revealTab(id, window);
  else if (action.type === 'close') owner?.closeTab(id);
  else if (action.type === 'new') window.createTab({ openBar: true });
});

ipcMain.handle('panel:get', (event, page) => {
  if (page === 'extensions') return extensionsPayload();
  return {
    config,
    configPath,
    defaults: DEFAULTS,
    dirs: extensionDirs,
    // The settings page lists the favourites so each one can be switched on
    // for preloading; the flag travels with the entry.
    favourites: favouritesPayload(),
    ...sessionsPayload(ctxFor(event)),
  };
});

/** The favourites as the settings form needs them: address, title, switch. */
function favouritesPayload() {
  return visited.favourites().map((fav) => ({ url: fav.url, title: fav.title, warm: Boolean(fav.warm) }));
}

/** The saved sessions as the settings page lists them, and which one this window shows. */
function sessionsPayload(window) {
  const showing = window?.workspaceName?.toLowerCase() ?? null;
  return {
    sessions: (workspaces?.list() ?? []).map((entry) => ({
      name: entry.name,
      tabs: entry.tabs.length,
      savedAt: entry.savedAt,
      current: showing !== null && entry.name.toLowerCase() === showing,
    })),
  };
}

/** Every open settings page hears about a change, whichever window made it. */
function announceSessions() {
  for (const window of windows) {
    if (!window.panelVisible || !window.panel) continue;
    window.panel.webContents.send('sessions:changed', sessionsPayload(window));
  }
}

/**
 * What the settings page's session rows do. Renaming and forgetting a set also
 * follows it into the windows that are showing it: a window renamed keeps its
 * next save under the new name, and one whose set was deleted stops claiming a
 * name, so it starts a fresh rolling slot instead of resurrecting the entry.
 */
ipcMain.handle('sessions:action', (event, request) => {
  const window = ctxFor(event);
  if (!window) return { ok: false, error: 'no window' };
  const action = String(request?.action ?? '');
  const name = normalizeName(request?.name);
  if (action === 'save') {
    const state = window.workspaceState();
    const chosen = name || autoName(state.tabs, state.activeTab, workspaces.list().map((entry) => entry.name));
    const entry = workspaces.save(chosen, state);
    if (!entry) return { ok: false, error: 'the session needs a name' };
    window.workspaceName = entry.name;
    window.persistTabs();
    announceSessions();
    return { ok: true, ...sessionsPayload(window) };
  }
  const entry = name ? workspaces.get(name) : null;
  if (!entry) return { ok: false, error: name ? `no session called "${name}"` : `${action} which session?` };
  if (action === 'rename') {
    const next = normalizeName(request?.to);
    if (!next) return { ok: false, error: 'the session needs a name' };
    const renamed = workspaces.rename(name, next);
    if (!renamed) return { ok: false, error: `there is already a session called "${next}"` };
    for (const other of windows) {
      if (other.workspaceName?.toLowerCase() !== name.toLowerCase()) continue;
      other.workspaceName = renamed.name;
      other.persistTabs();
    }
    announceSessions();
    return { ok: true, ...sessionsPayload(window) };
  }
  if (action === 'delete') {
    workspaces.remove(name);
    for (const other of windows) {
      if (other.workspaceName?.toLowerCase() !== name.toLowerCase()) continue;
      other.workspaceName = null;
      other.persistTabs();
    }
    announceSessions();
    return { ok: true, ...sessionsPayload(window) };
  }
  if (action === 'open') {
    // Switching writes the window's own tabs back first, so this is the same
    // way back the picker gives — the panel then goes away and the tabs are
    // what is left on screen.
    const failure = switchWorkspace(window, entry);
    if (failure) return { ok: false, error: failure };
    window.closePanel();
    announceSessions();
    return { ok: true, ...sessionsPayload(window) };
  }
  return { ok: false, error: `unknown session action "${action}"` };
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
  // The preload switches are the favourites' own: only the rows the form sent
  // change, so a favourite added in another window keeps the choice it has.
  for (const [url, warm] of Object.entries(patch.warm ?? {})) visited.setWarm(url, Boolean(warm));
  applyConfig(next, 'panel', event.sender);
  // The form re-renders from what was stored, not from what it sent: the
  // switches it shows after a save are the ones the browser will obey.
  return { ok: true, config, favourites: favouritesPayload() };
});
ipcMain.handle('panel:rescan', async () => {
  await loadExtensions(ses, extensionDirs, { skip: disabledExtensions });
  refreshAdblockOwner();
  return extensionsPayload();
});
/**
 * One button on an extension card. The page sends what it clicked and the
 * folder it belongs to; everything is done in the session here, and the whole
 * list comes back so the card re-renders from the truth, not from the click.
 */
ipcMain.handle('panel:extension', async (event, request) => {
  const window = ctxFor(event);
  const action = String(request?.action ?? '');
  const dir = String(request?.path ?? '');
  const loaded =
    ses.extensions.getExtension(String(request?.id ?? '')) ??
    ses.extensions.getAllExtensions().find((extension) => path.resolve(extension.path) === path.resolve(dir));
  try {
    if (action === 'folder') {
      shell.openPath(loaded?.path ?? dir);
      return { ok: true, ...extensionsPayload() };
    }
    if (action === 'options') {
      const url = loaded ? extensionOptionsUrl(loaded) : null;
      if (!url) return { ok: false, error: 'This extension has no settings page.', ...extensionsPayload() };
      window?.hideBar();
      window?.closePanel();
      window?.createTab({ url });
      return { ok: true, ...extensionsPayload() };
    }
    if (action === 'enable' && !loaded && dir) {
      await ses.extensions.loadExtension(dir);
      setExtensionEnabled(dir, true);
    } else if (action === 'disable' && loaded) {
      const extensionDir = loaded.path;
      ses.extensions.removeExtension(loaded.id);
      setExtensionEnabled(extensionDir, false);
    } else if (action === 'reload' && loaded) {
      const extensionDir = loaded.path;
      ses.extensions.removeExtension(loaded.id);
      await ses.extensions.loadExtension(extensionDir);
    }
    refreshAdblockOwner();
    return { ok: true, ...extensionsPayload() };
  } catch (err) {
    return { ok: false, error: err.message, ...extensionsPayload() };
  }
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

/**
 * The extensions page's model. A loaded extension answers for itself; a folder
 * the user switched off (or one whose load failed) is read from its manifest,
 * so it keeps its place in the list with its switch set to off.
 */
function extensionsPayload() {
  const loadedPaths = new Set();
  const loaded = ses.extensions.getAllExtensions().map((extension) => {
    loadedPaths.add(path.resolve(extension.path));
    return describeExtension(extension.path, extension);
  });
  const off = [];
  for (const dir of extensionDirs) {
    for (const extensionDir of findExtensions(dir)) {
      if (loadedPaths.has(path.resolve(extensionDir))) continue;
      off.push(describeExtension(extensionDir));
    }
  }
  const extensions = [...loaded, ...off].sort((a, b) => a.name.localeCompare(b.name));
  return { extensions, dirs: extensionDirs, loaded: loaded.length };
}

/** One card's worth of facts about an extension folder, loaded or not. */
function describeExtension(extensionDir, extension) {
  const manifest = extension?.manifest ?? readManifest(extensionDir);
  const messages = readLocaleMessages(extensionDir, manifest);
  const localize = (value) => {
    const match = typeof value === 'string' ? /^__MSG_(.+)__$/.exec(value) : null;
    return match ? (messages[match[1]]?.message ?? match[1]) : value;
  };
  return {
    id: extension?.id ?? null,
    name: localize(manifest?.name) ?? path.basename(extensionDir),
    version: extension?.version ?? manifest?.version ?? '',
    description: localize(manifest?.description) ?? '',
    path: extensionDir,
    enabled: Boolean(extension),
    options: extension ? extensionOptionsUrl(extension) : null,
    icon: extensionIcon(extensionDir, manifest),
    permissions: extensionPermissions(manifest),
  };
}

function readManifest(extensionDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** Chrome's `__MSG_name__` placeholders resolve against the extension's locale. */
function readLocaleMessages(extensionDir, manifest) {
  const locale = manifest?.default_locale;
  if (!locale) return {};
  try {
    return JSON.parse(fs.readFileSync(path.join(extensionDir, '_locales', locale, 'messages.json'), 'utf8'));
  } catch {
    return {};
  }
}

function extensionOptionsUrl(extension) {
  const page = extension.manifest?.options_ui?.page ?? extension.manifest?.options_page;
  if (typeof page !== 'string' || !page) return null;
  try {
    return new URL(page, extension.url).href;
  } catch {
    return null;
  }
}

/** The icon the card shows, inlined: a file:// page cannot load chrome-extension://. */
function extensionIcon(extensionDir, manifest) {
  const icons = manifest?.icons;
  if (!icons || typeof icons !== 'object') return null;
  const sizes = Object.keys(icons)
    .map(Number)
    .filter((size) => Number.isFinite(size))
    .sort((a, b) => Math.abs(a - 48) - Math.abs(b - 48));
  const chosen = icons[String(sizes[0])];
  if (typeof chosen !== 'string') return null;
  const root = path.resolve(extensionDir);
  const file = path.resolve(root, ...chosen.split('/'));
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) return null;
  try {
    if (fs.statSync(file).size > 128 * 1024) return null;
    return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

/** What the extension asked the browser for, in the words the card shows. */
function extensionPermissions(manifest) {
  const declared = [
    ...(Array.isArray(manifest?.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest?.host_permissions) ? manifest.host_permissions : []),
  ];
  const seen = new Set();
  const list = [];
  for (const item of declared) {
    if (typeof item !== 'string') continue;
    // Host patterns read as noise; the scheme and host are the part that says anything.
    const name = item.includes('://') ? item.replace(/\/\*$/, '').replace(/\/$/, '') : item;
    if (seen.has(name)) continue;
    seen.add(name);
    list.push(name);
  }
  return list;
}

/** Keep the extension page's off list and the running session in step. */
function setExtensionEnabled(extensionDir, enabled) {
  const resolved = path.resolve(extensionDir);
  const next = disabledExtensions.filter((dir) => dir !== resolved);
  if (!enabled) next.push(resolved);
  try {
    disabledExtensions = writeDisabledExtensions(extensionStateFile(), next);
  } catch (err) {
    console.warn(`[tbrowser] could not save the extension list: ${err.message}`);
    disabledExtensions = next;
  }
}

function extensionStateFile() {
  return path.join(app.getPath('userData'), 'extensions.json');
}

/**
 * A blocking extension owns the session: while uBlock Origin is on, the
 * built-in engine stays out; the moment it is switched off, the engine is what
 * keeps pages clean.
 */
function refreshAdblockOwner() {
  adblockExtension = ses.extensions.getAllExtensions().some((extension) => extension.name === 'uBlock Origin');
  syncAdblock().catch((err) => console.warn(`[tbrowser] adblock switch failed: ${err.message}`));
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
    // The empty tab is a local file that needs nothing from the session's
    // extensions: start it now, beside them, so a cold launch already has the
    // splash painted by the time the window builds its first tab.
    warmTab();
    extensionDirs = [
      unpacked(path.join(__dirname, 'extensions')),
      unpacked(path.join(__dirname, 'vendor')),
      path.join(app.getPath('userData'), 'extensions'),
    ];
    fs.mkdirSync(extensionDirs[2], { recursive: true });
    disabledExtensions = readDisabledExtensions(extensionStateFile());
    const extensions = await loadExtensions(ses, extensionDirs, { skip: disabledExtensions });
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
  if (!ses) return;
  // A blocking extension that loaded owns the session, so the engine stays out
  // of its way — and steps back in when that extension is switched off.
  if (adblockExtension) {
    if (adblockBlocker) {
      adblockBlocker.disableBlockingInSession(ses);
      adblockBlocker = null;
    }
    return;
  }
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
  applyBlur();
  syncAdblock().catch((err) => console.warn(`[tbrowser] adblock switch failed: ${err.message}`));
  // The preload switch and the favourites' own flags decide what stays loaded.
  syncWarmPages();
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

/**
 * What a `--no-ui` launch runs on: a directory of its own, thrown away when it
 * ends. The real profile is shared by one browser at a time, and a test that
 * wrote the user's tabs, visits or cookies would blank the session they were
 * reading — so the config travels (a test should obey the browser's settings)
 * and the extensions are linked in (read-only, and a copy per run would be
 * megabytes of unpacked extension), and nothing else does.
 */
function useScratchProfile() {
  const real = app.getPath('userData');
  const dir = path.join(os.tmpdir(), `${SCRATCH_PREFIX}${process.pid}`);
  sweepScratchProfiles();
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.copyFileSync(path.join(real, 'config.json'), path.join(dir, 'config.json'));
  } catch {
    // no config yet: the defaults loadConfig writes are what a fresh profile gets
  }
  // Favourites drive what a test launch preloads, so the run obeys the same
  // choices the browser does; the copy is thrown away with the profile.
  try {
    fs.copyFileSync(path.join(real, 'favourites.json'), path.join(dir, 'favourites.json'));
  } catch {
    // no favourites yet
  }
  try {
    fs.symlinkSync(
      path.join(real, 'extensions'),
      path.join(dir, 'extensions'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch {
    // nothing installed, or the link was refused: the vendored extensions still load
  }
  app.setPath('userData', dir);
  // Windows keeps a Chromium profile locked for a moment after the process is
  // gone, so this often fails; the sweep below is what clears the leftovers.
  app.on('quit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // still held: tomorrow's sweep takes it
    }
  });
  console.log(`[tbrowser] no-ui: no window will be shown, profile ${dir}`);
}

/** Profiles a killed test run left behind: nothing else sweeps these. */
function sweepScratchProfiles() {
  let entries;
  try {
    entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SCRATCH_PREFIX)) continue;
    const dir = path.join(os.tmpdir(), entry.name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs < STALE_PROFILE_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // a profile still in use, or one Windows will not release yet
    }
  }
}

function startApp() {
  app.whenReady().then(() => {
    app.setAppUserModelId('com.tbrowser.app');
    Menu.setApplicationMenu(null);
    // The control channel is one per machine: a test copy that bound it would
    // take every later launch, `--quit` included, from the browser behind it.
    if (!NO_UI) startControlServer();
    configPath = path.join(app.getPath('userData'), 'config.json');
    config = loadConfig(app.getPath('userData'));
    try {
      configSnapshot = fs.readFileSync(configPath, 'utf8');
    } catch {
      configSnapshot = '';
    }
    keys = compileKeybindings(config.keybindings);
    visited = new Visits(app.getPath('userData'));
    workspaces = new Workspaces(app.getPath('userData'));
    startConfigWatch();
    // `--hidden` starts the resident process without a window: run at login so
    // every later launch is a request to an already warm browser.
    if (process.argv.includes('--hidden') || process.argv.includes('--daemon')) return undefined;
    const shown = showWindow({ restore: true });
    // TEMP MEASUREMENT HOOK
    if (process.env.TBROWSER_MEASURE_URL) {
      return shown.then(async () => {
        const w = [...windows].pop();
        const rounds = Number(process.env.TBROWSER_MEASURE_ROUNDS || 1);
        for (let i = 0; i < rounds; i++) {
          w.navigate(process.env.TBROWSER_MEASURE_URL);
          const wc = w.activeTab().view.webContents;
          await new Promise((resolve) => {
            wc.once('did-finish-load', resolve);
            setTimeout(resolve, 30000);
          });
          try {
            const probe = await wc.executeJavaScript(
              `JSON.stringify({paint: performance.getEntriesByType('paint').map(p => [p.name, Math.round(p.startTime)]), nav: (() => { const n = performance.getEntriesByType('navigation')[0]; return n && {ttfb: Math.round(n.responseStart), dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd)}; })(), res: performance.getEntriesByType('resource').length})`,
            );
            mark(`measure round ${i + 1} ${probe}`);
          } catch (err) {
            mark(`measure round ${i + 1} probe failed ${err.message}`);
          }
          console.log(`[tbrowser] measure round ${i + 1} ${w.activeTab().view.webContents.getURL()}`);
        }
        mark('measure done');
      });
    }
    return shown;
  });
}

// Checked before the lock: quitting is a request to whichever instance holds it,
// including one parked with no window on screen.
if (process.argv.includes('--quit')) {
  quitRunningInstance();
} else if (NO_UI) {
  // A test launch keeps its own process. Handing it to the resident browser
  // would put the window a test asked not to see on screen, and would make two
  // tests share one browser.
  useScratchProfile();
  startApp();
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // A hidden launch only wants the daemon up; it must not pop a window.
    if (argv.includes('--hidden') || argv.includes('--daemon')) return;
    showWindow().catch((err) => console.error(`[tbrowser] reopen failed: ${err.message}`));
  });
  startApp();
}

// With the default resident daemon, closing the last window parks the process
// instead of paying Electron's cold start on the next launch. A test launch has
// nothing to hand to: it exits with its window.
app.on('window-all-closed', () => {
  if (NO_UI || !config?.resident) app.quit();
});
