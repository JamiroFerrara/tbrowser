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
const { frecency } = require('./lib/frecency');
const { PreloadPool } = require('./lib/preload');
const { watchGesture, fromUser } = require('./lib/popups');
const { suggestions } = require('./lib/suggest');
const { Sessions, normalizeName, autoName, cleanLayout } = require('./lib/sessions');
const {
  isLeaf,
  paneTabs,
  showsTab,
  replaceTab,
  splitAt,
  removeTab,
  paneRects,
  paneInDirection,
  sameTree,
  edgeBounds,
} = require('./lib/layout');
const { Jumps } = require('./lib/jumps');
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
// While a pane's page is on its way, a line runs across the top of that pane:
// the splash quote's catppuccin blue over a dim track of the same colour. It
// is a plain view, not a page — a load never waits on a second renderer — and
// the line moves by having its bounds changed, which needs no repaint.
const LOAD_BAR_HEIGHT = 2;
// A load that ends inside this window never shows a line: ctrl+t has to feel
// like the splash was always there, not like a bar flashed over it.
const LOAD_DELAY_MS = 120;
const LOAD_STEP_MS = 33;
const LOAD_SWEEP_MS = 1100;
// The splash's own quote colour (--splash-quote in ui/home.html): catppuccin
// latte blue on a light theme, macchiato blue behind the dark one.
const LOAD_LINE = { dark: '#89b4fa', light: '#1e66f5' };
const LOAD_TRACK = { dark: '#4089b4fa', light: '#4d1e66f5' };
// Views take #AARRGGBB, so the track is the line's colour at a quarter alpha.
const loadBarColor = (track) =>
  (track ? LOAD_TRACK : LOAD_LINE)[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
// The same arrangement, with every leaf renamed: tab ids to their places in
// the tab list and back, when a state file changes hands.
const mapPanes = (node, fn) =>
  !node
    ? null
    : isLeaf(node)
      ? { tab: fn(node.tab) }
      : { orientation: node.orientation, children: node.children.map((child) => mapPanes(child, fn)) };
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
/**
 * The acrylic the Windows Terminal paints is the window's accent brush, not
 * its DWM backdrop: DWM withdraws the backdrop from a window that is not in
 * front — it is why the blur vanished with the focus — while the accent keeps
 * blurring whether the window is active or not. It is one call on the window
 * handle, so it goes through koffi, a prebuilt FFI: no native build in the
 * install, and nothing to compile on the machine that packs it.
 */
const ACCENT_ACRYLIC = 4; // ACCENT_ENABLE_ACRYLICBLURBEHIND
const WCA_ACCENT_POLICY = 19;

/** The window's Win32 handle, from the buffer Electron hands out. */
function hwndOf(win) {
  const handle = win.getNativeWindowHandle();
  return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
}

let accent = null; // undefined until asked for: the call, or false when it cannot be had
function accentCall() {
  if (accent !== null) return accent;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const policy = koffi.struct('TbAccentPolicy', {
      nAccentState: 'int',
      nFlags: 'int',
      nColor: 'uint32',
      nAnimationId: 'int',
    });
    const payload = koffi.struct('TbCompositionAttribData', {
      nAttribute: 'int',
      pData: 'void *',
      ulDataSize: 'size_t',
    });
    const set = user32.func(
      'int SetWindowCompositionAttribute(uintptr_t hwnd, TbCompositionAttribData *data)',
    );
    const buffer = koffi.alloc(policy, 1);
    const size = koffi.sizeof(policy);
    accent = (win, color) => {
      koffi.encode(buffer, policy, {
        nAccentState: ACCENT_ACRYLIC,
        nFlags: 0,
        nColor: color,
        nAnimationId: 0,
      });
      return set(hwndOf(win), { nAttribute: WCA_ACCENT_POLICY, pData: buffer, ulDataSize: size });
    };
  } catch (err) {
    console.warn(`[tbrowser] the window's acrylic is unavailable: ${err.message}`);
    accent = false;
  }
  return accent;
}

/** Whether the desktop is blurred behind the window: the setting, on a Windows that draws it. */
const blurOn = () => desktopBlur && config?.blur === true;
/** Whether that blur is the accent brush, which stays put when the window is not in front. */
const acrylicOn = () => blurOn() && config.blurMaterial === 'acrylic' && accentCall() !== false;
/**
 * The colour the empty tab and the chrome paint: the desktop blur showing
 * through `blurColor` at `blurOpacity` percent — the Windows Terminal window's
 * own recipe — or the chrome's colour when there is no blur behind it. An
 * #AARRGGBB colour, since that is the alpha Electron's views take.
 */
function surfaceBg() {
  if (!blurOn()) return chromeBg();
  // The accent brush carries the tint itself, so its surfaces stay clear;
  // anything else is tinted here, over the backdrop.
  if (acrylicOn()) return '#00000000';
  const alpha = Math.round((config.blurOpacity / 100) * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${alpha}${config.blurColor.slice(1)}`;
}

/** The tint as the accent brush wants it: 0xAABBGGRR, alpha in the top byte. */
function accentColor() {
  const rgb = config.blurColor.slice(1);
  const alpha = Math.round((config.blurOpacity / 100) * 255)
    .toString(16)
    .padStart(2, '0');
  return parseInt(`${alpha}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`, 16);
}

/** (Re)apply the accent brush and its tint to a window that is already open. */
function paintAccent(win) {
  const set = accentCall();
  if (!set || !win) return false;
  try {
    const painted = set(win, accentColor()) !== 0;
    mark('acrylic ' + (painted ? 'painted' : 'refused'));
    return painted;
  } catch (err) {
    console.warn(`[tbrowser] could not paint the acrylic: ${err.message}`);
    return false;
  }
}
// A wheel notch is answered on the next frame, by the whole distance. Left to itself Chromium
// glides a notch for ~180 ms, so the page keeps drifting after the wheel has stopped and lands
// past the line it was aimed at. Vimium animates its own keys, so this only takes the glide out
// of the wheel.
app.commandLine.appendSwitch('disable-smooth-scrolling');
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
// The page a tab just left is loaded again beside it, so the step back onto it
// is a swap. The load waits this long: a redirect chain, or a link followed
// straight away, must not pay for a page the next step will not reach.
const BACK_STEP_DELAY_MS = 400;
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
let sessions; // the sessions saved to disk, in their jump order
// The sessions that exist right now: a window is a client attached to one.
// They live in memory, and only a saved one outlives the browser.
const liveSessions = new Map(); // lowercase name -> session
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
 *
 * An ad opens one too, and Electron hands every `window.open` to us without
 * asking whether a person was behind it. `lib/popups.js` is where that
 * question is answered — a window is only the user's if their click on the
 * page is still recent.
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
      autoplayPolicy: 'document-user-activation-required',
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
    if (desktopBlur) win.setBackgroundMaterial(blurred && !acrylicOn() ? 'mica' : 'none');
    win.setBackgroundColor(blurred ? '#00000000' : chromeBg());
    if (acrylicOn()) paintAccent(win);
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
    // A loading line carries the theme's blue with it.
    for (const bar of window.loadBars.values()) {
      if (!bar.attached) continue;
      bar.track.setBackgroundColor(loadBarColor(true));
      bar.head.setBackgroundColor(loadBarColor(false));
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
  for (const { view } of freeTabs) {
    if (!view.webContents.isDestroyed()) view.setBackgroundColor(bg);
  }
}

/**
 * What each chrome view is painted with. The bar keeps its own strip at the
 * bottom of the window — the page stops above it, so the blur shows through.
 * The sidebar and the settings panel are laid over the page instead: a clear
 * surface there would show that page through their text, so both keep the
 * chrome's colour.
 */
const chromeBackground = (kind) => (kind === 'bar' ? surfaceBg() : chromeBg());

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
 * changes. The views are kept loaded and painted here, so a new tab swaps one
 * in already showing: the quote is on screen in the same frame as the tab, and
 * nothing about the new tab waits on a renderer.
 *
 * Two are kept, because a split and the tab beside it are the same keystroke
 * twice: one spare meant the second empty pane paid for a cold renderer and
 * showed its background first. A finished load is taken before one still
 * loading, and taking either starts a replacement in the background.
 *
 * The spares are never wired to a window until taken, so they hold no keys and
 * no page state.
 */
const freeTabs = [];
const WARM_TABS = 2;

/**
 * Buffers whose window closed. A tab is a buffer: closing the window that
 * showed it is not killing it, so its page stays here — a renderer still
 * loaded, holding everything it had — until a search or a click takes it back
 * onto a screen, or the browser quits. The oldest go first, and a page that
 * came back out of the pool is taken out of it, so nothing is in two lists.
 */
const parkedBuffers = new Map(); // tab id -> { id, view, title, url, session }
const PARKED_MAX = 16;

/**
 * Pages this browser has open without a window behind them. Closing a tab is a
 * logical close — its address stays here, with no renderer and no memory —
 * and asking for it again loads it, which is what "not loaded" means. Ids are
 * negative so a buffer can never be mistaken for a tab.
 */
const dormantBuffers = new Map(); // -1, -2, ... -> { id, url, title, loaded: false }
const DORMANT_MAX = 40;
let nextBufferId = -1;

function tabPreferences() {
  return {
    partition: PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    spellcheck: false,
    // The page's one way out of its own world: Vimium's H and L ask for the
    // browser's step back and forward, which is the one the kept page makes
    // instant. Every page pays a file read for it, nothing more.
    preload: path.join(__dirname, 'ui', 'page-preload.js'),
    // Chromium only keeps the compiled form of a script once it has seen the
    // same one twice: the first visit to a heavy site compiles every megabyte
    // of it from source, and so does the second. Asking for the cache on the
    // first load is what makes the *next* visit to YouTube — the case that is
    // repeated all day — skip that compile instead of paying it again.
    v8CacheOptions: 'bypassHeatCheck',
    // A page nobody is looking at is not idle work: it is a download and a
    // boot script that has to be done before it can be shown. Left throttled,
    // a background tab and a favourite kept warm crawl through their own
    // timers, so the page handed over on the keystroke is still half-loaded.
    backgroundThrottling: false,
    // Electron lets any page start making noise with nobody touching it, which
    // Chrome does not: an ad in a background tab, or in a favourite loaded by
    // the pool, played its soundtrack out of an empty browser. Sound now waits
    // for a click in the page it comes from, the policy Chrome runs by default.
    autoplayPolicy: 'document-user-activation-required',
  };
}

function warmTab() {
  while (freeTabs.length < WARM_TABS) {
    mark('tab warming');
    const view = newView(tabPreferences(), surfaceBg());
    const entry = { view, ready: false };
    view.webContents.once('did-finish-load', () => {
      entry.ready = true;
    });
    view.webContents.loadURL(HOME).catch(() => {});
    freeTabs.push(entry);
  }
}

/**
 * A spare home view, or null when the pool is still cold. A finished load goes
 * first: it is the one that paints in the frame the tab takes it, and the
 * other may still be on its way.
 */
function takeWarmTab() {
  const live = freeTabs.filter((entry) => !entry.view.webContents.isDestroyed());
  freeTabs.length = 0;
  if (!live.length) return null;
  const index = live.findIndex((entry) => entry.ready);
  const [taken] = live.splice(index === -1 ? 0 : index, 1);
  freeTabs.push(...live);
  mark('tab reused');
  setImmediate(warmTab);
  return taken.view;
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

// A resident process with no window has nobody to take a pooled page, but the
// next launch asks for one at once: the most-used few stay loaded, the rest
// give their renderers back until a window is open again.
const WARM_PARKED_KEEP = 3;

function desiredWarmUrls() {
  if (!config?.preload || !visited) return [];
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
  // The pages used most recently and most often warm first: the first two or
  // three are ready within seconds of a launch, and those are the ones a
  // keystroke is likely to ask for. An unvisited favourite sorts by when it was
  // added, so the order is stable rather than random.
  const now = Date.now();
  const scores = new Map(visited.list().map((entry) => [entry.url, frecency(entry.visits, now)]));
  const warm = visited
    .favourites()
    .filter((fav) => fav.warm && /^(https?|file):/i.test(fav.url) && !open.has(fav.url))
    .sort((a, b) => (scores.get(b.url) ?? 0) - (scores.get(a.url) ?? 0) || a.added - b.added)
    .map((fav) => fav.url);
  return windows.size ? warm : warm.slice(0, WARM_PARKED_KEEP);
}

/**
 * Background page loads — the preloaded favourites and the page kept for the
 * step back — are one queue of two. A load starts only when the pages on
 * screen are idle, and starts are spaced: nine favourites are not nine
 * renderers and nine downloads racing the page the user asked for, they are
 * work that happens when nothing else needs the machine. Two at a time is what
 * makes the most-used ones ready in seconds rather than a minute, without
 * turning a launch back into a burst. A keystroke that takes a pooled page
 * jumps the queue.
 */
const WARM_PARALLEL = 2;
const WARM_GAP_MS = 600;
const WARM_IDLE_POLL_MS = 500;
// A page that keeps fetching (an ad loop, a long poll) must not own a slot:
// the next start waits this long at most, then the stuck page loads on its own.
const WARM_JOB_TIMEOUT_MS = 8_000;
const warmQueue = [];
const warmActive = new Set();
let warmPumpTimer = null;

/** Is a page in a window still fetching its main frame? */
function foregroundLoading() {
  for (const window of windows) {
    for (const tab of window.tabs.values()) {
      if (!tab.attached || !tab.view) continue;
      const wc = tab.view.webContents;
      if (!wc.isDestroyed() && wc.isLoadingMainFrame()) return true;
    }
  }
  return false;
}

/**
 * Queue a background load; `start` resolves when its page has stopped loading.
 * An urgent load — the page the step back lands on — may take one slot over the
 * pool's limit: the pool is decoration, the step is a keystroke away.
 */
function queueWarm(start, { front = false, urgent = false } = {}) {
  const job = { start, done: false, urgent };
  if (front) warmQueue.unshift(job);
  else warmQueue.push(job);
  pumpWarm();
  return job;
}

/** Forget a queued load. A running one still finishes; nothing waits on it. */
function dropWarm(job) {
  if (!job || job.done) return;
  job.done = true;
  const at = warmQueue.indexOf(job);
  if (at >= 0) warmQueue.splice(at, 1);
}

function scheduleWarmPump(delay) {
  if (warmPumpTimer) return;
  warmPumpTimer = setTimeout(() => {
    warmPumpTimer = null;
    pumpWarm();
  }, delay);
}

function pumpWarm() {
  if (!windows.size || warmPumpTimer) return;
  const next = warmQueue[0];
  if (!next) return;
  const slots = next.urgent ? WARM_PARALLEL + 1 : WARM_PARALLEL;
  if (warmActive.size >= slots) return;
  // The page the user is waiting on owns the machine; look again when it is
  // done. Nothing polls while it loads, and a page that never finishes keeps
  // the pool idle rather than slow. The page the step back lands on is not the
  // pool: it is one renderer, and it has to be ready the moment the key falls,
  // so it leaves after its debounce even while the page on screen finishes.
  if (!next.urgent && foregroundLoading()) {
    scheduleWarmPump(WARM_IDLE_POLL_MS);
    return;
  }
  const job = warmQueue.shift();
  job.done = true;
  warmActive.add(job);
  let cap = null;
  const full = new Promise((resolve) => {
    cap = setTimeout(resolve, WARM_JOB_TIMEOUT_MS);
  });
  Promise.race([Promise.resolve().then(job.start), full])
    .catch(() => {})
    .finally(() => {
      clearTimeout(cap);
      warmActive.delete(job);
      scheduleWarmPump(WARM_GAP_MS);
    });
  // The second start steps off the first: two pages leave together, not as a
  // burst, and a slot that frees later pulls the next page in.
  if (warmActive.size < WARM_PARALLEL && warmQueue.length) scheduleWarmPump(WARM_GAP_MS);
}

function startWarmPage(url) {
  let view = null;
  let wc = null;
  let settle = null;
  const settleWarm = () => {
    const done = settle;
    settle = null;
    if (done) done();
  };
  const entry = {
    view: null,
    wc: null,
    url,
    loadedAt: 0,
    done: false,
    failed: false,
    started: false,
    closed: false,
    job: null,
    // The renderer is made when the page's turn comes, not when the pool is
    // filled: an idle pool holding nine pages is not nine renderers.
    load() {
      if (entry.started || entry.closed) return Promise.resolve();
      entry.started = true;
      if (!view) {
        view = newView(tabPreferences());
        wc = view.webContents;
        entry.view = view;
        entry.wc = wc;
        // A preloaded page is nobody's tab yet: a link it opens by itself must
        // not create one behind the user's back.
        wc.setWindowOpenHandler(() => ({ action: 'deny' }));
        wc.once('did-finish-load', () => {
          entry.loadedAt = Date.now();
          entry.done = true;
          mark(`warm ready ${url}`);
          settleWarm();
        });
        wc.once('did-fail-load', (_event, code, description, _validatedURL, isMainFrame) => {
          if (!isMainFrame) return;
          entry.failed = true;
          mark(`warm failed ${url}: ${description || code}`);
          settleWarm();
        });
        wc.once('destroyed', settleWarm);
      }
      mark(`warm start ${url}`);
      return new Promise((resolve) => {
        settle = resolve;
        wc.loadURL(url).catch(() => {
          entry.failed = true;
          settleWarm();
        });
      });
    },
    // A tab takes this page before its turn came: load it now, on the keystroke.
    activate() {
      dropWarm(entry.job);
      entry.job = null;
      entry.load();
    },
    close() {
      entry.closed = true;
      dropWarm(entry.job);
      entry.job = null;
      mark(`warm drop ${url}`);
      if (wc && !wc.isDestroyed()) wc.close();
      settleWarm();
    },
  };
  entry.job = queueWarm(() => entry.load());
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
  // Entries that survived a parked process are already queued: opening a window
  // is what lets them start.
  pumpWarm();
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
    // The session this window re-joins on restore, when the state file names
    // one that is still saved.
    this.sessionName = normalizeName(snapshot.session) || null;

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

    // The panes over one window, as the editor keeps its windows: a tree of
    // splits whose leaves name the tab each pane shows, so a split inside a
    // split nests. `null` is the ordinary window — one pane, the active tab,
    // filling the page area.
    this.panes = null;
    // The rectangles the panes were last laid out in, so moving between them
    // with the keys needs no fresh measurement.
    this.panePlacement = null;
    // The panes the keys have been in, newest last: closing one lands on the
    // pane it came from, as `:q` does in the editor.
    this.paneHistory = [];
    // The strips framing those panes, lit on the one with the keys; they
    // belong to a window, so a window that goes takes them with it.
    this.paneEdges = null;
    // The loading lines, one per tab whose page is coming: the views, where
    // the tab's page is on screen, and the clock the line sweeps on.
    this.loadBars = new Map(); // tab id -> { track, head, shown, attached, rect, ... }
    this.loadTimer = null;
    // The command bar's current shape; the session picker is one of them.
    this.barMode = 'address';
    // The tab a split pairs with, and the tab focus came from.
    this.previousTabId = null;
    // Every tab and page the keys have taken this window to, so Ctrl+O/Ctrl+I
    // walk back and forward through them the way C-o/C-i do in the editor.
    this.jumps = new Jumps();
    // A jump is being restored: the activation and load it causes are the
    // place the list already holds, not a new one to append.
    this.pendingJump = null;
    // The session this window is a client of; its tabs and split live there,
    // so a second window attached to the same session shows the same ones.
    this.sessionName = null;
    // A session state is being applied: this window is following, not leading,
    // so it must not publish what the other client just told it.
    this.sessionSyncing = false;
    // The page this window's active tab just left, kept loaded so the step
    // back onto it is a swap (see warmBackStep).
    this.backStep = null;

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
      // The backdrop is the window's, not a view's. The accent brush needs a
      // see-through window to show through — no colour, no material — and the
      // tint is painted by the brush, not by the views. Mica is the DWM
      // backdrop, which the views tint themselves.
      ...(acrylicOn()
        ? { transparent: true, backgroundColor: '#00000000' }
        : blurOn()
          ? { backgroundMaterial: 'mica' }
          : { backgroundColor: chromeBg() }),
    });
    this.win = win;
    windows.add(this);
    // The brush survives the window becoming inactive; re-asserting it when the
    // window comes back is what keeps a theme flip or a material switch honest.
    if (acrylicOn()) {
      // A see-through window starts with no brush at all: the first paint has
      // to ask for it, and again whenever the window is shown or focused, so
      // the blur is there from the first frame and not a beat later.
      win.on('show', () => paintAccent(win));
      win.on('focus', () => paintAccent(win));
      win.once('ready-to-show', () => paintAccent(win));
      paintAccent(win);
    }

    this.restoreBounds();

    win.on('resize', () => this.layout());
    win.on('close', () => {
      this.finalSnapshot = this.snapshot();
      this.persistTabsNow();
      this.saveSessionOnClose();
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
    // A window shows its session, not its own copy of the tabs: a restored
    // window re-joins the session it was attached to, and a second window on
    // one already live takes what that session holds right now.
    const joined = this.sessionName ? (liveSession(this.sessionName) ?? restoreSession(this.sessionName)) : null;
    if (joined) {
      this.sessionName = joined.name;
    } else {
      this.sessionName = freshSessionName(savedTabs.length ? savedTabs : [HOME]);
    }
    const startState = joined ?? {
      tabs: savedTabs,
      activeTab: this.saved.activeTab,
      panes: this.saved.panes,
      split: this.saved.split,
    };
    const startUrls = Array.isArray(startState.tabs) && startState.tabs.length ? startState.tabs : [HOME];
    if (!joined) newSession(this.sessionName, { tabs: startUrls, activeTab: startState.activeTab, panes: startState.panes });
    // This window is a client of the session from here on.
    sessionFor(this)?.clients.add(this);
    // A launch builds its tabs without focusing them: the page's focus call
    // lands whenever its renderer finishes, which is after the bar's and took
    // the caret back. The palette is the launch surface, so it is what holds
    // the focus, and it comes up as soon as its own renderer is ready.
    startUrls.forEach((url, index) =>
      this.createTab({ url, activate: index === 0, focus: false }),
    );
    if (typeof startState.activeTab === 'number') {
      const ids = [...this.tabs.keys()];
      if (ids[startState.activeTab] !== undefined) {
        this.activateTab(ids[startState.activeTab], { focus: false });
      }
    }
    this.refreshPanes(startState);
    this.saved = {};
    // The session now holds what this window opened, so a second client
    // attaching to it gets the same tabs.
    publishSession(this);

    this.layout();
    updateSidebars();
    mark('page created');
    // The favourites kept ready are queued now, but they do not start until
    // this window's pages are done loading: they are decoration for a later
    // keystroke, and a launch that races them against the page the user asked
    // for is a launch that stalls the page.
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
    // The window is going; its tabs are not. Each page is kept as a buffer, so
    // the address that was open here is still open — one search away, already
    // loaded — after the window that showed it is gone. A tab whose renderer
    // crashed has nothing to keep and is dropped.
    for (const tab of this.tabs.values()) {
      if (tab.view && !tab.view.webContents.isDestroyed()) parkBuffer(this, tab);
      this.closeSteps(tab);
    }
    this.tabs.clear();
    // The loading lines were the window's: their views go with it.
    for (const id of [...this.loadBars.keys()]) this.dropLoadBar(id);
    this.stopLoadSweep();
    this.activeTabId = null;
    this.dropBackStep();
    clearTimeout(this.persistTimer);
    this.panes = null;
    this.panePlacement = null;
    this.paneHistory = [];
    this.paneEdges = null;
    this.previousTabId = null;
    this.sessionName = null;
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
    const state = this.sessionState();
    return {
      bounds: this.win && !this.win.isDestroyed() ? this.win.getBounds() : this.saved.bounds,
      tabs: state.tabs,
      activeTab: state.activeTab,
      panes: state.panes,
      session: this.sessionName,
      saved: Boolean(sessionFor(this)?.saved),
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

  /** The window as a session: its tabs, the focused one, and the pane tree. */
  sessionState() {
    const ids = [...this.tabs.keys()];
    return {
      tabs: [...this.tabs.values()].map((tab) => this.urlOf(tab)),
      activeTab: Math.max(0, ids.indexOf(this.activeTabId)),
      panes: this.panes ? mapPanes(this.panes, (id) => ids.indexOf(id)) : null,
    };
  }

  /** Write the window's tabs into the session it is attached to. */
  saveSessionOnClose() {
    if (!this.sessionName) return;
    publishSession(this);
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
    // The tabs a window shows are its session's tabs: anything that changes
    // them goes out to the other windows attached to it now, so a window
    // attaching this instant sees them; the disk is written on the timer.
    publishSession(this);
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      persistState();
    }, PERSIST_DELAY);
  }

  /**
   * Follow another client of the same session: open what it has, close what it
   * does not, and land on the tab it is on. The pages are this window's own —
   * a renderer cannot be in two windows — so a URL that is already right is
   * left alone and only the ones that differ load again.
   */
  applySessionState(state) {
    if (this.sessionSyncing || !this.win) return;
    this.sessionSyncing = true;
    try {
      const urls = Array.isArray(state.tabs) ? state.tabs : [];
      const ids = [...this.tabs.keys()];
      // A tab the session no longer has: following the session closes it
      // here, and that is not the user closing a tab, so it leaves no buffer.
      for (let i = urls.length; i < ids.length; i += 1) this.closeTab(ids[i], { remember: false });
      for (let i = 0; i < urls.length; i += 1) {
        const id = [...this.tabs.keys()][i];
        if (id === undefined) {
          this.createTab({ url: urls[i], activate: false, focus: false });
          continue;
        }
        const tab = this.tabs.get(id);
        if (this.urlOf(tab) !== urls[i]) this.loadInTab(tab, urls[i]);
      }
      // The arrangement follows the session too: the same panes, each showing
      // the tab in that place.
      this.refreshPanes(state);
      const active = [...this.tabs.keys()][state.activeTab];
      if (active !== undefined && active !== this.activeTabId) this.activateTab(active, { focus: false });
    } finally {
      this.sessionSyncing = false;
    }
  }

  /** Send one tab to an address the session holds, without touching the rest. */
  loadInTab(tab, url) {
    tab.url = url;
    this.tabView(tab).webContents.loadURL(url).catch(() => {});
  }

  // ------------------------------------------------------------------ layout

  layout() {
    if (!this.win) return;
    const [width, height] = this.win.getContentSize();
    const barPixels = this.barVisible ? Math.round(this.barHeight) : 0;
    // With no split the bar is the window's own bottom strip and every page
    // stops above it. A split has a bottom edge per pane, so the bar is the
    // active pane's strip: the command line and its list open where the keys
    // are, and the pane beside the search keeps its full height.
    const contentHeight = Math.max(0, height - barPixels);

    // The page always gets the whole window: the sidebar sits over it, so
    // opening or closing the sidebar never resizes the page or reflows what is
    // on it. Only the browser's own chrome keeps clear of the sidebar.
    if (this.sidebarAttached && this.sidebar) {
      place(this.sidebar, { x: 0, y: 0, width: SIDEBAR_WIDTH, height });
    }
    const tab = this.activeTab();
    let barRect = null;
    if (this.panes) {
      // The tree is laid out over the whole window: the bar is inside a pane,
      // so it takes that pane's strip instead of shortening every one of them.
      const rects = paneRects(this.panes, width, height, SPLIT_GAP, SPLIT_EDGE);
      const focused = rects.get(this.activeTabId);
      if (barPixels && focused) {
        const strip = Math.min(barPixels, focused.height);
        barRect = {
          x: focused.x,
          y: focused.y + focused.height - strip,
          width: focused.width,
          height: strip,
        };
      }
      for (const [id, rect] of rects) {
        const paneTab = this.tabs.get(id);
        if (!paneTab) continue;
        const view = this.attachTabView(paneTab);
        // The page under the bar gives up the strip, as it does without a
        // split, so the list never covers the page it is over.
        const bounds = barRect && id === this.activeTabId
          ? { ...rect, height: Math.max(0, rect.height - barRect.height) }
          : rect;
        if (view && place(view, bounds)) this.pageLayouts += 1;
        this.placeLoadBar(paneTab, rect);
      }
      this.panePlacement = rects;
      this.ensurePaneEdges(rects.size);
      this.placePaneEdges(rects);
    } else {
      this.panePlacement = null;
      if (tab?.view && place(tab.view, { x: 0, y: 0, width, height: contentHeight })) {
        this.pageLayouts += 1;
      }
      if (tab) this.placeLoadBar(tab, { x: 0, y: 0, width });
    }
    // A line belongs to a pane on screen: a tab that left the screen, or one
    // whose page arrived while it was hidden, takes its line with it.
    const shown = new Set(this.shownTabs());
    for (const [id, bar] of this.loadBars) {
      if (bar.attached && (!shown.has(id) || !bar.shown)) this.detachLoadBar(bar);
    }
    const chromeX = this.sidebarVisible ? SIDEBAR_WIDTH : 0;
    const chromeWidth = Math.max(0, width - chromeX);
    if (this.panelVisible && this.panel) {
      place(this.panel, { x: chromeX, y: 0, width: chromeWidth, height: contentHeight });
    }
    if (this.barVisible && this.bar) {
      if (barRect) {
        // The bar keeps clear of the sidebar, as it does with no split.
        const x = Math.max(barRect.x, chromeX);
        const right = Math.min(barRect.x + barRect.width, width);
        place(this.bar, { x, y: barRect.y, width: Math.max(0, right - x), height: barRect.height });
      } else {
        place(this.bar, { x: chromeX, y: height - barPixels, width: chromeWidth, height: barPixels });
      }
    }
  }

  focusContent() {
    const target = this.panelVisible ? this.panel : this.activeTab()?.view;
    target?.webContents.focus();
  }

  // ------------------------------------------------------------------ panes
  //
  // The editor's two layers, kept apart: a pane is a window and a tab is the
  // buffer it shows. The tree says how the window is divided, the tab list
  // says what exists. Closing a pane takes its leaf out and leaves the tab
  // loaded — `:q` — and killing a tab is the other verb, `:bd`.

  /** The tabs on screen, in layout order: the top-left one first. */
  shownTabs() {
    return this.panes ? paneTabs(this.panes) : this.activeTabId === null ? [] : [this.activeTabId];
  }

  /** Whether a tab has a pane of its own right now. */
  inPane(id) {
    return Boolean(this.panes) && showsTab(this.panes, id);
  }

  /** A tab's view in the window, added below the chrome on first use. */
  attachTabView(tab) {
    if (!tab) return null;
    const view = this.tabView(tab);
    if (!tab.attached && this.win) {
      this.win.contentView.addChildView(view, 0);
      tab.attached = true;
    }
    return view;
  }

  /** Take a tab off the screen without touching the tab or its page. */
  detachTabView(tab) {
    if (!tab?.view || !tab.attached) return;
    try {
      this.win.contentView.removeChildView(tab.view);
    } catch {
      // the window is already gone with the pane
    }
    tab.attached = false;
  }

  /**
   * The strips that frame the panes, tmux's way of saying which one holds the
   * keys. Plain views, not pages: an indicator costs no renderer, and the
   * strips sit in the gaps the panes already leave.
   */
  ensurePaneEdges(count) {
    if (this.paneEdges?.length === count * 4) return this.paneEdges;
    this.detachPaneEdges();
    const edges = [];
    for (let pane = 0; pane < count; pane += 1) {
      for (const side of ['top', 'bottom', 'left', 'right']) {
        edges.push({ tab: null, side, view: new View() });
      }
    }
    this.paneEdges = edges;
    // Above the pages, so they show, and below the chrome, so a sidebar or
    // bar that floats over the split is not painted across.
    const pages = [...this.tabs.values()].filter((tab) => tab.attached).length;
    edges.forEach(({ view }, index) => this.win.contentView.addChildView(view, pages + index));
    return edges;
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

  /** Colour the frames: the pane with the keys in the accent, the rest dim. */
  paintPaneEdges() {
    if (!this.paneEdges) return;
    const active = paneEdge(true);
    const idle = paneEdge(false);
    for (const edge of this.paneEdges) {
      edge.view.setBackgroundColor(edge.tab === this.activeTabId ? active : idle);
    }
  }

  /** Frame every pane where the tree put it. */
  placePaneEdges(rects) {
    if (!this.paneEdges) return;
    const sides = ['top', 'bottom', 'left', 'right'];
    let index = 0;
    for (const [tab, rect] of rects) {
      for (const side of sides) {
        const edge = this.paneEdges[index];
        index += 1;
        if (!edge) break;
        edge.tab = tab;
        edge.view.setBounds(edgeBounds(rect, side, SPLIT_EDGE));
      }
    }
    this.paintPaneEdges();
  }

  // ----------------------------------------------------------------- loading
  //
  // A page that takes a moment says so: a blue line runs across the top of
  // the pane it is in, out of the splash's colour. Nothing here is a renderer
  // and nothing here is a repaint — the track sits still and one rectangle
  // moves along it — so the page's own load never waits on the indicator.

  /** The line a tab's page shows while it loads: made on that page's first load. */
  loadBarFor(tab) {
    let bar = this.loadBars.get(tab.id);
    if (bar) return bar;
    const track = new View();
    const head = new View();
    bar = { track, head, delay: null, shown: false, attached: false, rect: null, started: 0 };
    this.loadBars.set(tab.id, bar);
    return bar;
  }

  /** Above the pages, so the line shows; below the chrome, so it paints over none of it. */
  attachLoadBar(bar) {
    if (bar.attached || !this.win) return;
    const pages = [...this.tabs.values()].filter((tab) => tab.attached).length;
    bar.track.setBackgroundColor(loadBarColor(true));
    bar.head.setBackgroundColor(loadBarColor(false));
    this.win.contentView.addChildView(bar.track, pages);
    this.win.contentView.addChildView(bar.head, pages + 1);
    bar.attached = true;
    bar.started = Date.now();
  }

  detachLoadBar(bar) {
    if (bar.attached) {
      try {
        this.win?.contentView.removeChildView(bar.track);
        this.win?.contentView.removeChildView(bar.head);
      } catch {
        // the window went with the page
      }
      bar.attached = false;
    }
    bar.rect = null;
    if (![...this.loadBars.values()].some((other) => other.attached)) this.stopLoadSweep();
  }

  /**
   * A page started loading. The line waits a moment before it shows: a load
   * that ends inside that moment — the splash, a page already warm — never
   * gets a bar flashed over it.
   */
  beginLoad(tab) {
    const bar = this.loadBarFor(tab);
    bar.shown = false;
    clearTimeout(bar.delay);
    bar.delay = setTimeout(() => {
      bar.delay = null;
      // The tab may have closed, or come back as another one, inside the wait.
      if (this.tabs.get(tab.id) !== tab) return;
      bar.shown = true;
      this.layout();
    }, LOAD_DELAY_MS);
  }

  /** The page is there: the line goes with it. */
  endLoad(tab) {
    this.dropLoadBar(tab.id);
  }

  /** Forget a tab's line: its page arrived, or the tab itself is gone. */
  dropLoadBar(id) {
    const bar = this.loadBars.get(id);
    if (!bar) return;
    clearTimeout(bar.delay);
    this.detachLoadBar(bar);
    this.loadBars.delete(id);
  }

  /** Put a tab's line across the top of the pane its page is drawn in. */
  placeLoadBar(tab, rect) {
    const bar = this.loadBars.get(tab.id);
    if (!bar?.shown) return;
    if (!bar.attached) this.attachLoadBar(bar);
    bar.rect = { x: rect.x, y: rect.y, width: rect.width };
    place(bar.track, { x: rect.x, y: rect.y, width: rect.width, height: LOAD_BAR_HEIGHT });
    this.startLoadSweep();
    this.sweepLoadBars();
  }

  /**
   * Move each line one step along its pane, out past the right edge and back
   * in at the left: a scan over the page rather than a bar that pretends to
   * know how much of the load is done, which the page never tells us.
   */
  sweepLoadBars() {
    if (!this.win) return this.stopLoadSweep();
    const now = Date.now();
    for (const bar of this.loadBars.values()) {
      if (!bar.attached || !bar.rect) continue;
      const { x, y, width } = bar.rect;
      const reach = Math.max(64, Math.min(200, Math.round(width * 0.22)));
      const phase = ((now - bar.started) % LOAD_SWEEP_MS) / LOAD_SWEEP_MS;
      bar.head.setBounds({
        x: Math.round(x + phase * (width + reach) - reach),
        y,
        width: reach,
        height: LOAD_BAR_HEIGHT,
      });
    }
  }

  startLoadSweep() {
    if (this.loadTimer) return;
    this.loadTimer = setInterval(() => this.sweepLoadBars(), LOAD_STEP_MS);
  }

  stopLoadSweep() {
    clearInterval(this.loadTimer);
    this.loadTimer = null;
  }

  /**
   * Alt+S / Alt+Shift+S, `:vsplit` / `:split`: divide the pane the keys are
   * in. The new pane is an empty buffer, the way `:new` opens one: a split is
   * a place to type the next address into, never a second copy of a page that
   * is already on screen.
   */
  splitPane(orientation) {
    if (!this.win) return;
    const active = this.activeTab();
    if (!active) return;
    const partner = this.createTab({ activate: false });
    this.panes = splitAt(this.panes, active.id, partner.id, orientation);
    this.attachTabView(this.tabs.get(active.id));
    this.attachTabView(partner);
    this.layout();
    updateSidebars();
    this.persistTabs();
    // Splitting is a move into the pane just made, the way tmux hands the
    // cursor to the shell a split opens: the keys land where the split did.
    this.focusPane(partner.id);
    // An empty pane is a command line waiting: the bar comes up on it, as it
    // does for a new tab, so the page is one address away.
    this.showBar('address');
  }

  /**
   * Alt+H/J/K/L: move to the pane that way. Straight ahead wins over diagonal,
   * so a move never lands on the pane the long way round.
   */
  movePane(direction) {
    if (!this.panes || !this.panePlacement) return false;
    const next = paneInDirection(this.panePlacement, this.activeTabId, direction);
    if (next === null || next === undefined) return false;
    this.focusPane(next);
    return true;
  }

  /** Put the keys in a pane that is already on screen. */
  focusPane(id, { focus = true } = {}) {
    if (!this.panes || !showsTab(this.panes, id)) return;
    const tab = this.tabs.get(id);
    if (!tab) return;
    const moved = id !== this.activeTabId;
    if (moved) {
      this.previousTabId = this.activeTabId;
      this.activeTabId = id;
      this.paneHistory.push(id);
      if (this.paneHistory.length > 32) this.paneHistory.shift();
    }
    const view = this.tabView(tab);
    if (focus) view.webContents.focus();
    this.paintPaneEdges();
    if (this.win) this.win.setTitle(tab.title ? `${tab.title} — tbrowser` : 'tbrowser');
    updateSidebars();
    if (moved) {
      this.persistTabs();
      this.recordJump();
    }
  }

  /**
   * Take a tab's pane out of the arrangement and hand back the panes still on
   * screen. One pane left is no split at all, so the tree goes and that pane
   * fills the window.
   */
  removePaneFor(tabId) {
    const left = removeTab(this.panes, tabId);
    const remaining = left ? paneTabs(left) : [];
    this.panes = remaining.length > 1 ? left : null;
    this.panePlacement = null;
    this.detachPaneEdges();
    return remaining;
  }

  /** The pane focus lands on when one closes: the one it came from. */
  paneAfterClose(closing) {
    const remaining = this.shownTabs();
    for (let index = this.paneHistory.length - 1; index >= 0; index -= 1) {
      const candidate = this.paneHistory[index];
      if (candidate !== closing && remaining.includes(candidate)) return candidate;
    }
    return remaining[0] ?? null;
  }

  /**
   * Ctrl+W, `:q`: close the pane the keys are in. The tab stays — it is a
   * buffer, and closing the window that showed it does not delete it — so it
   * is still in the tab list and comes back with a split or a click.
   *
   * With no split there is no pane to close, and the editor quits instead of
   * doing nothing: here that is this window going away, with every tab it held
   * left in the buffer list rather than killed.
   */
  closePane() {
    if (!this.win || this.activeTabId === null) return false;
    if (!this.panes) {
      this.win.close();
      return true;
    }
    const closing = this.activeTabId;
    const tab = this.tabs.get(closing);
    if (!tab || !showsTab(this.panes, closing)) return false;
    const remaining = this.removePaneFor(closing);
    this.detachTabView(tab);
    if (!this.panes) {
      // No split left: the tab that shared it fills the window.
      this.activeTabId = remaining[0] ?? closing;
      this.attachTabView(this.tabs.get(this.activeTabId));
    } else {
      this.activeTabId = null;
      this.focusPane(this.paneAfterClose(closing));
    }
    this.layout();
    updateSidebars();
    this.persistTabs();
    // The keys belonged to the pane that just went: hand them to the page that
    // is left, so typing goes to it without a click first.
    this.focusContent();
    return true;
  }

  /** `:only`: every pane but this one closes. All the tabs stay. */
  closePanesExcept() {
    if (!this.panes || !this.win) return false;
    const keep = this.activeTabId;
    if (keep === null) return false;
    const closing = this.shownTabs().filter((id) => id !== keep);
    if (!closing.length) return false;
    this.panes = null;
    this.panePlacement = null;
    this.detachPaneEdges();
    for (const id of closing) this.detachTabView(this.tabs.get(id));
    this.attachTabView(this.tabs.get(keep));
    this.layout();
    updateSidebars();
    this.persistTabs();
    this.focusContent();
    return true;
  }

  /**
   * Follow a saved arrangement: a session's pane tree or this window's own,
   * from either shape the files have ever held.
   */
  refreshPanes(state) {
    if (!this.win) return;
    const ids = [...this.tabs.keys()];
    const saved = cleanLayout(state, ids.length);
    const wanted = saved ? mapPanes(saved, (index) => ids[index]) : null;
    const shown = wanted ? paneTabs(wanted) : [];
    // One pane is no split at all: the ordinary window already shows the tab.
    const next = shown.length > 1 ? wanted : null;
    if (sameTree(this.panes, next)) return;
    const before = this.shownTabs();
    this.panes = next;
    this.panePlacement = null;
    this.detachPaneEdges();
    for (const id of before) if (!this.inPane(id)) this.detachTabView(this.tabs.get(id));
    if (next) {
      if (!this.inPane(this.activeTabId)) this.activeTabId = paneTabs(next)[0];
    } else {
      // No arrangement left: the focused tab is the whole window again.
      this.attachTabView(this.tabs.get(this.activeTabId));
    }
    this.layout();
    updateSidebars();
    this.persistTabs();
  }

  /** Swap every tab for a saved set in one step, panes included. */
  replaceTabs(state) {
    if (!this.win) return;
    this.panes = null;
    this.panePlacement = null;
    this.paneHistory = [];
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
    for (const id of [...this.loadBars.keys()]) this.dropLoadBar(id);
    this.tabs.clear();
    this.activeTabId = null;
    this.previousTabId = null;
    this.jumps.clear();

    const urls = Array.isArray(state.tabs) && state.tabs.length ? state.tabs : [HOME];
    const ids = urls.map((url) => {
      const id = nextTabId++;
      this.tabs.set(id, { id, view: null, title: '', url });
      return id;
    });
    const active = ids[Number.isInteger(state.activeTab) ? state.activeTab : 0] ?? ids[0];
    this.activateTab(active);
    this.refreshPanes(state);
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
      mode === 'command' ? ':' : mode === 'search' || mode === 'session' ? '' : url && url !== HOME ? url : '';
    this.barMode = mode;
    const isCommand = mode === 'command';
    const preselect = mode === 'session';
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
   * A buffer coming back onto a screen: the same tab, the same page, the same
   * renderer — nothing loads, so it is there in the frame it was asked for.
   */
  adoptBuffer(entry) {
    const tab = { id: entry.id, view: null, title: entry.title, url: entry.url, attached: false };
    this.tabs.set(tab.id, tab);
    this.swapTabView(tab, entry.view, { attach: false });
    this.activateTab(tab.id);
    updateSidebars();
    return tab;
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
    if (tab.id === this.activeTabId) this.recordJump();
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
    if (freeTabs.length < WARM_TABS) {
      mark('tab parked');
      freeTabs.push({ view, ready: wc.isLoadingMainFrame() === false });
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
    tab.chainView = null;
    if (!tab.steps) return;
    for (const view of [...tab.steps.back, ...tab.steps.forward]) {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    tab.steps = null;
  }

  /**
   * Keep the page the tab just left loaded beside it, so the step back onto it
   * is a swap of views rather than a load: the renderer is already up, holding
   * the page it showed, and nothing on the step touches the network.
   *
   * One page is kept for the window, for the tab on screen — the one the step
   * back is about to reach — and the next departure loads over it, so the cache
   * costs one renderer and one page, never a pool. The load is deferred: a
   * redirect chain or a quick second navigation must not pay for a page nobody
   * will ask for.
   */
  warmBackStep(tab, url) {
    if (tab.id !== this.activeTabId || !URL_RE.test(url ?? '') || url === HOME) return;
    const entry = (this.backStep ??= {
      view: null,
      wc: null,
      url: null,
      ready: false,
      timer: null,
      job: null,
    });
    if (entry.wc?.isDestroyed()) {
      entry.view = null;
      entry.wc = null;
    }
    if (!entry.wc) {
      const view = newView(tabPreferences(), chromeBg());
      // Nobody's tab yet: a link the kept page opens must not make one, and a
      // page nobody is watching must not make a sound.
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.setAudioMuted(true);
      entry.view = view;
      entry.wc = view.webContents;
      entry.wc.on('did-finish-load', () => {
        const ready = !entry.wc.isDestroyed() && entry.wc.getURL() === entry.url;
        // Once it is loaded the page may idle: it is a picture of where the
        // step back goes, and it costs nothing until it is on screen again.
        if (ready) entry.wc.setBackgroundThrottling(true);
        entry.ready = ready;
      });
      entry.wc.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
        if (isMainFrame) entry.ready = false;
      });
      entry.wc.on('destroyed', () => {
        if (this.backStep === entry) this.backStep = null;
      });
    }
    entry.tabId = tab.id;
    entry.url = url;
    entry.ready = false;
    clearTimeout(entry.timer);
    // The address this step was warming is not the one the tab left any more:
    // its load is no longer worth a slot in the queue.
    const aborting = entry.job && warmActive.has(entry.job);
    dropWarm(entry.job);
    entry.job = null;
    // A load for the address the tab just left two steps ago owns a slot for
    // a page nobody can ask for any more: stop it instead of waiting it out.
    if (aborting && entry.wc && !entry.wc.isDestroyed()) entry.wc.stop();
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (entry.url !== url || entry.wc.isDestroyed()) return;
      // Behind the page on screen, ahead of the pool: a step back is a
      // keystroke away, a preloaded favourite is decoration.
      entry.job = queueWarm(
        () =>
          new Promise((resolve) => {
            if (entry.url !== url || entry.wc.isDestroyed()) return resolve();
            mark(`tab step warming ${url}`);
            const done = () => {
              entry.wc.removeListener('did-finish-load', done);
              entry.wc.removeListener('did-fail-load', failed);
              resolve();
            };
            const failed = (_event, _code, _description, _url, isMainFrame) => {
              if (isMainFrame) done();
            };
            entry.wc.once('did-finish-load', done);
            entry.wc.once('did-fail-load', failed);
            entry.wc.loadURL(url).catch(() => {
              entry.ready = false;
              done();
            });
          }),
        { front: true, urgent: true },
      );
    }, BACK_STEP_DELAY_MS);
  }

  /** Let the kept page go; the window has no step back for it to make instant. */
  dropBackStep() {
    const entry = this.backStep;
    this.backStep = null;
    if (!entry) return;
    clearTimeout(entry.timer);
    dropWarm(entry.job);
    entry.job = null;
    if (entry.wc && !entry.wc.isDestroyed()) entry.wc.close();
  }

  /** Put a parked view in the tab's place and park the one it replaces. */
  stepTo(tab, view, delta) {
    const gone = this.swapTabView(tab, view, { attach: true });
    if (gone && !gone.webContents.isDestroyed()) {
      this.parkView(tab, gone, delta < 0 ? 'forward' : 'back');
    }
    visited.record(tab.url, tab.title);
    updateSidebars();
    this.recordJump();
    return gone;
  }

  /**
   * A live page showing the address this step lands on: the one the window kept
   * for the step back, or a page a warm swap parked. Taking it is a swap; the
   * address check is what makes it the page the tab's own history would reach,
   * so a step means the same thing either way.
   */
  keptPage(tab, delta, url) {
    // The kept page is not "back" or "forward": it is the address the tab just
    // left. After a step that had to load because the kept page was still
    // coming, the next step the other way lands exactly on it, and the toggle
    // becomes a swap instead of reloading both directions from then on.
    const step = this.backStep;
    if (step?.ready && step.tabId === tab.id && !step.wc.isDestroyed() && step.url === url) {
      this.backStep = null;
      // It is on screen again: the tab's own page, with its sound back.
      step.wc.setAudioMuted(false);
      return { view: step.view, cached: true };
    }
    const list = delta < 0 ? tab.steps?.back : tab.steps?.forward;
    for (let i = list?.length ?? 0; i > 0; i--) {
      const view = list[i - 1];
      const wc = view.webContents;
      if (wc.isDestroyed() || wc.getURL() !== url) continue;
      list.splice(i - 1, 1);
      return { view, cached: false };
    }
    return null;
  }

  go(delta) {
    const tab = this.activeTab();
    if (!tab?.view) return;
    const history = tab.view.webContents.navigationHistory;
    const at = history.getActiveIndex();
    const target = delta < 0 ? (at > 0 ? history.getEntryAtIndex(at - 1) : null) : history.getEntryAtIndex(at + 1);
    // The page this step lands on is still loaded beside the tab: the step is a
    // swap of views, on screen in the frame the key comes in, with no load and
    // nothing from the network behind it.
    const kept = target?.url ? this.keptPage(tab, delta, target.url) : null;
    if (kept) {
      mark(kept.cached ? 'tab step cached' : 'tab step');
      const gone = this.stepTo(tab, kept.view, delta);
      // The view that was swapped out still holds the history the tab had: the
      // step after this one walks it instead of dying on a one-entry page.
      if (gone && !gone.webContents.isDestroyed()) tab.chainView = gone;
      return;
    }
    if (delta < 0 && history.canGoBack()) return history.goBack();
    if (delta > 0 && history.canGoForward()) return history.goForward();
    // The renderer has nothing left that way, but a warm swap may have stepped
    // over pages the tab still has: those are the steps, and back reaches them
    // without a load.
    const from = delta < 0 ? tab.steps?.back : tab.steps?.forward;
    let view = null;
    while (from?.length) {
      const parked = from.pop();
      if (!parked.webContents.isDestroyed()) {
        view = parked;
        break;
      }
    }
    if (!view) {
      // A kept page stepped the tab over its own history. That history is still
      // in the view it replaced, parked as the step the other way: walk it
      // there, so the second back finds the page the first one skipped.
      const chain = tab.chainView;
      if (chain && !chain.webContents.isDestroyed()) {
        const own = chain.webContents.navigationHistory;
        const entries = own.getAllEntries();
        let index = own.getActiveIndex() + delta;
        // The kept page already put the tab on the entry next door: step past
        // it, or the step lands on the page that is already on screen.
        while (index >= 0 && index < entries.length && entries[index].url === tab.url) {
          index += delta > 0 ? 1 : -1;
        }
        if (index >= 0 && index < entries.length) {
          for (const list of [tab.steps?.back, tab.steps?.forward]) {
            const held = list?.indexOf(chain) ?? -1;
            if (held >= 0) list.splice(held, 1);
          }
          mark('tab step chain');
          // Put it on screen first: wiring it is what hears the navigation
          // that follows, and leaves the tab with its own history again.
          this.stepTo(tab, chain, delta);
          own.goToIndex(index);
          return;
        }
      }
    }
    if (!view) return;
    mark('tab step');
    this.stepTo(tab, view, delta);
  }

  // ------------------------------------------------------------------ jumps

  /**
   * Where the keys are now, as the jump list keeps it: the tab, the page it
   * shows and, when its renderer is up, the step of its own history that page
   * is — so going back to it can be a history step instead of a fresh load.
   */
  jumpPosition(tab = this.activeTab()) {
    if (!tab) return null;
    const wc = tab.view?.webContents;
    const live = wc && !wc.isDestroyed();
    return {
      tabId: tab.id,
      url: tab.url || HOME,
      index: live ? wc.navigationHistory.getActiveIndex() : -1,
    };
  }

  /** Note the place the keys just arrived at, unless the arrival was a jump. */
  recordJump() {
    const position = this.jumpPosition();
    if (!position) return;
    const pending = this.pendingJump;
    if (pending && pending.tabId === position.tabId) {
      // The activation a jump causes is the entry the cursor already holds.
      if (pending.url === position.url) this.pendingJump = null;
      return;
    }
    this.jumps.record(position);
  }

  /**
   * Ctrl+O / Ctrl+I: the place `delta` away in the list, restored whole. In the
   * same tab a page is reached by a step of its own history when it is there,
   * so the jump costs no load; a tab moved between windows, or a page whose
   * renderer was swapped away, falls back to the address.
   */
  goJump(delta) {
    // Drop places whose tab is gone before moving, so one step lands on a tab
    // that is really there: the list can outlive a close that bypassed it.
    for (const entry of [...this.jumps.entries]) {
      if (!this.tabs.has(entry.tabId)) this.jumps.forget(entry.tabId);
    }
    const entry = this.jumps.move(delta);
    if (!entry) return false;
    const tab = this.tabs.get(entry.tabId);
    if (!tab) return false;
    mark('tab jump');
    const pending = { tabId: tab.id, url: entry.url };
    this.pendingJump = pending;
    // A navigation that never comes must not suppress a later real jump onto
    // the same page.
    setTimeout(() => {
      if (this.pendingJump === pending) this.pendingJump = null;
    }, 5000).unref?.();

    this.activateTab(tab.id);
    const wc = tab.view?.webContents;
    if (!wc || wc.isDestroyed() || tab.url === entry.url) return true;
    const history = wc.navigationHistory;
    const entries = history.getAllEntries();
    let at = entry.index >= 0 && entries[entry.index]?.url === entry.url ? entry.index : -1;
    if (at === -1) at = entries.findIndex((item) => item.url === entry.url);
    if (at !== -1) {
      history.goToIndex(at);
      return true;
    }
    if (URL_RE.test(entry.url)) {
      wc.loadURL(entry.url).catch((err) => {
        console.warn(`[tbrowser] jump failed: ${err.message}`);
      });
    }
    return true;
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
      'input-event',
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
        // A popunder is the same call from a timer: no click, no window.
        if (!fromUser(wc)) return { action: 'deny' };
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
      const left = tab.url;
      tab.url = url;
      // The tab's own history is this view's again from here.
      tab.chainView = null;
      // The home page is the absence of a page; it is not a visit.
      if (url !== HOME) visited.record(url, tab.title);
      if (tab.id === this.activeTabId) {
        this.persistTabs();
        this.recordJump();
      }
      // The page the tab just left stays loaded beside it, so the step back
      // onto it is a swap instead of a load.
      if (left && left !== url) this.warmBackStep(tab, left);
      // The page the tab left is nobody's now: a favourite among them can be
      // kept ready again. Deferred, so the page that is on screen comes first.
      setImmediate(syncWarmPages);
    });
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
      if (url !== HOME) visited.record(url, tab.title);
      if (tab.id === this.activeTabId) {
        this.persistTabs();
        this.recordJump();
      }
    });
    // The line over the page follows its load: it comes up when the load is
    // slow enough to be worth saying, and it goes when the page arrives.
    wc.on('did-start-loading', () => this.beginLoad(tab));
    wc.on('did-stop-loading', () => this.endLoad(tab));
    // Clicking a page is how a split changes which pane the bar and the keys
    // act on. Outside a split this event has nothing to say.
    wc.on('focus', () => {
      if (this.inPane(tab.id) && tab.id !== this.activeTabId) this.focusPane(tab.id, { focus: false });
    });
    this.watchKeys(wc);
    watchGesture(wc);
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
    if (this.inPane(id)) {
      this.focusPane(id, { focus });
      return;
    }
    const previous = this.activeTab();
    if (this.panes) {
      // `:b <tab>`: the focused pane changes the buffer it shows; the other
      // panes keep theirs, and the tab that leaves stays in the list.
      if (previous) {
        this.panes = replaceTab(this.panes, previous.id, id);
        this.detachTabView(previous);
      }
      this.previousTabId = previous?.id ?? null;
      this.activeTabId = id;
      this.paneHistory.push(id);
      if (this.paneHistory.length > 32) this.paneHistory.shift();
      const view = this.attachTabView(tab);
      this.layout();
      if (focus) view?.webContents.focus();
      this.win.setTitle(tab.title ? `${tab.title} — tbrowser` : 'tbrowser');
      updateSidebars();
      this.persistTabs();
      this.recordJump();
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
    this.recordJump();
  }

  /**
   * Ctrl+Shift+W, `:bd`: close the tab, the way `:bd` closes a buffer. The page
   * is not lost — its address goes to the list of pages open without a window,
   * ready to be loaded again — and the pane it was in shows the next tab in
   * the list. A tab with nowhere else to go takes the window with it.
   */
  closeTab(id, { remember = true } = {}) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const order = [...this.tabs.keys()];
    const place = order.indexOf(id);
    const wasPane = this.inPane(id);
    if (remember) rememberBuffer(this, tab);
    this.tabs.delete(id);
    // The line went with the page it was over.
    this.dropLoadBar(id);
    // The step back was this tab's: another tab has no history for it.
    if (this.backStep?.tabId === id) this.dropBackStep();
    this.jumps.forget(id);
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
        if (wc.getURL() === HOME && freeTabs.length < WARM_TABS) {
          mark('tab parked');
          this.unwireTab(wc);
          freeTabs.push({ view: tab.view, ready: true });
        } else {
          wc.close();
        }
      }
    }
    // The pages the tab kept for back and forward went with it.
    this.closeSteps(tab);
    if (wasPane) {
      const remaining = this.removePaneFor(id);
      if (!this.panes) {
        // No split is left: the tab that took its place fills the window.
        this.activeTabId = null;
        const next = remaining[0] ?? this.nextTabAfter(place);
        if (next === undefined) {
          this.win.close();
          return;
        }
        this.activateTab(next);
        return;
      }
      if (this.activeTabId === id) {
        this.activeTabId = null;
        this.focusPane(this.paneAfterClose(id), { focus: false });
      }
      this.layout();
      // The pane that had the keys is gone: the page that is left takes them.
      this.focusContent();
    }

    if (this.activeTabId === id) {
      this.activeTabId = null;
      const next = this.nextTabAfter(place);
      if (next === undefined) {
        this.win.close();
        return;
      }
      this.activateTab(next);
    }
    updateSidebars();
    this.persistTabs();
  }

  /** The tab that takes the place of one just closed: the next, else the one before. */
  nextTabAfter(place) {
    const order = [...this.tabs.keys()];
    return order[place] ?? order[Math.max(0, place - 1)];
  }

  cycleTab(delta) {
    const ids = [...this.tabs.keys()];
    if (ids.length < 2) return;
    const index = ids.indexOf(this.activeTabId);
    this.activateTab(ids[(index + delta + ids.length) % ids.length]);
  }

  /** Alt+N: the Nth tab, or — for 9 — the last one, as Chrome does. */
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
      this.showBar('session');
      return true;
    }
    if (matchesAny(input, keys.splitVertical)) {
      this.splitPane('vertical');
      return true;
    }
    if (matchesAny(input, keys.splitHorizontal)) {
      this.splitPane('horizontal');
      return true;
    }
    // Alt+H/J/K/L move to the pane that way, the way they move between tmux
    // panes in the editor; with no split they belong to the page.
    if (this.panes && keys.focusPane?.length && matchesAny(input, keys.focusPane)) {
      const key = String(input.key).toLowerCase();
      const direction = {
        h: 'left',
        left: 'left',
        j: 'down',
        down: 'down',
        k: 'up',
        up: 'up',
        l: 'right',
        right: 'right',
      }[key];
      if (direction) this.movePane(direction);
      return true;
    }
    // Alt+1..8 are the tab in that position, Alt+9 the last one; Ctrl+1..9
    // jump to the session in that place of the order the settings page keeps.
    if (input.alt && !input.control && !input.meta && !input.shift && /^[1-9]$/.test(input.key)) {
      this.selectTabNumber(Number(input.key));
      return true;
    }
    if (input.control && !input.alt && !input.meta && !input.shift && /^[1-9]$/.test(input.key)) {
      selectSessionNumber(this, Number(input.key));
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
    // Ctrl+O / Ctrl+I walk the window's jumps — every tab and page the keys
    // took it to — the way C-o/C-i walk the editor's jump list.
    if (matchesAny(input, keys.jumpBack)) {
      this.goJump(-1);
      return true;
    }
    if (matchesAny(input, keys.jumpForward)) {
      this.goJump(1);
      return true;
    }
    if (matchesAny(input, keys.newTab)) {
      this.createTab({ openBar: true });
      return true;
    }
    // Ctrl+W is the editor's `:q`: it takes the pane away and leaves the tab.
    if (keys.closePane?.length && matchesAny(input, keys.closePane)) {
      this.closePane();
      return true;
    }
    // Ctrl+Shift+W is `:bd`: the tab itself goes, and its pane with it.
    if (matchesAny(input, keys.killTab)) {
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
    // C-, is the editor's settings key: open the page, and pressed again while
    // it is up, put it away.
    if (matchesAny(input, keys.settings)) {
      if (this.panelVisible && this.currentPanel === 'settings') this.closePanel();
      else this.openPanel('settings');
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
  const lists = [...windows].map((window) => ({
    id: window.id,
    tabs: [...window.tabs.values()].map((tab) => ({
      id: tab.id,
      title: tab.title || window.titleFor(tab),
      url: window.urlOf(tab),
      active: tab.id === window.activeTabId,
    })),
  }));
  // The buffers no window is showing come last, under their own heading: the
  // loaded ones are pages that are still there, the dormant ones are addresses
  // waiting for a load.
  const buffers = [...parkedBuffers.values()].concat([...dormantBuffers.values()]);
  if (buffers.length) {
    lists.push({
      id: 0,
      parked: true,
      tabs: buffers.map((entry) => ({
        id: entry.id,
        title: entry.title,
        url: entry.url,
        active: false,
        loaded: entry.loaded !== false,
      })),
    });
  }
  return lists;
}

/** The tabs of every window, this one's first. */
function sharedTabRows(current) {
  return sharedTabs(windowTabLists(), current.id);
}

/**
 * Repaint every open sidebar: the list is the whole browser's tabs, so a tab
 * that opens, closes or renames in one window changes what all of them show.
 */
function updateSidebars() {
  for (const window of windows) {
    if (!window.sidebar || !window.sidebarLoaded) continue;
    window.sidebar.webContents.send('tabs:update', sharedTabRows(window));
  }
}

// ----------------------------------------------------------------- sessions

const sessionKey = (name) => String(name ?? '').toLowerCase();

/** The live session under that name, or null when nothing holds it. */
function liveSession(name) {
  return liveSessions.get(sessionKey(name)) ?? null;
}

/** A session in memory: the tabs it holds and the windows showing it. */
function newSession(name, { tabs = [HOME], activeTab = 0, panes = null, saved = false } = {}) {
  const entry = {
    name,
    tabs: Array.isArray(tabs) && tabs.length ? tabs : [HOME],
    activeTab: Number.isInteger(activeTab) ? activeTab : 0,
    panes: panes ?? null,
    saved: Boolean(saved),
    savedAt: saved ? Date.now() : null,
    clients: new Set(),
  };
  liveSessions.set(sessionKey(name), entry);
  return entry;
}

/** Bring a saved session into memory, or null when it is not on disk. */
function restoreSession(name) {
  const entry = sessions?.get(name);
  if (!entry) return null;
  return newSession(entry.name, { ...entry, saved: true });
}

/**
 * Every session that exists: the saved ones in the order they jump, then the
 * ones this run made that nobody has saved.
 */
function sessionList() {
  const rows = [];
  const seen = new Set();
  const add = (entry, saved) => {
    const live = liveSession(entry.name);
    rows.push({
      name: entry.name,
      tabs: live ? live.tabs.length : entry.tabs.length,
      attached: live ? live.clients.size : 0,
      saved: Boolean(saved) || Boolean(live?.saved),
      live: Boolean(live),
    });
    seen.add(sessionKey(entry.name));
  };
  for (const entry of sessions?.list() ?? []) add(entry, true);
  for (const entry of liveSessions.values()) if (!seen.has(sessionKey(entry.name))) add(entry, entry.saved);
  return rows;
}

/**
 * A name nothing is using: the page's host when it has one, otherwise the
 * lowest free number — tmux names its sessions by number, and an empty tab has
 * no host to borrow.
 */
function freshSessionName(tabs, activeTab = 0) {
  const taken = sessionList().map((entry) => entry.name);
  const host = autoName(tabs, activeTab, taken);
  if (host !== 'session' && !host.startsWith('session ')) return host;
  for (let n = 0; n < 100; n += 1) {
    if (!taken.some((name) => name.toLowerCase() === String(n))) return String(n);
  }
  return host;
}

/** The live session a window is attached to, or null. */
function sessionFor(window) {
  return window?.sessionName ? liveSession(window.sessionName) : null;
}

/**
 * Publish what a window shows into its session, and hand it to the other
 * windows attached to the same one. A client that is following a change does
 * not publish it back.
 */
function publishSession(window) {
  const session = sessionFor(window);
  if (!session || window.sessionSyncing) return;
  const state = window.sessionState();
  session.tabs = state.tabs;
  session.activeTab = state.activeTab;
  session.panes = state.panes;
  session.savedAt = Date.now();
  if (session.saved) sessions?.save(session.name, state);
  for (const client of session.clients) {
    if (client !== window) client.applySessionState(state);
  }
  announceSessions();
}

/** Make a session durable: it comes back on a later launch, in its place. */
function saveSession(name, state, live = liveSession(name)) {
  if (!sessions) return null;
  const chosen = normalizeName(name) || live?.name;
  const entry = sessions.save(chosen, state ?? live ?? {});
  if (!entry) return null;
  if (live) {
    const was = sessionKey(live.name);
    const now = sessionKey(entry.name);
    live.saved = true;
    live.name = entry.name;
    live.savedAt = entry.savedAt;
    // A session saved under a new name keeps its windows: they follow it.
    if (was !== now) {
      liveSessions.delete(was);
      liveSessions.set(now, live);
      for (const client of live.clients) client.sessionName = entry.name;
    }
  }
  announceSessions();
  return entry;
}

/**
 * Attach a window to a session: it leaves the one it was showing and takes the
 * tabs of this one, as `switch-client` does in tmux. A saved session that is
 * not running is brought back first.
 */
function attachToSession(window, name) {
  const wanted = normalizeName(name);
  if (!wanted) return 'which session?';
  const target = liveSession(wanted) ?? restoreSession(wanted);
  if (!target) return `no session called "${wanted}"`;
  if (sessionKey(window.sessionName) === sessionKey(target.name)) return null;
  const previous = sessionFor(window);
  if (previous) {
    publishSession(window);
    previous.clients.delete(window);
  }
  window.sessionName = target.name;
  target.clients.add(window);
  window.replaceTabs(target);
  window.persistTabs();
  announceSessions();
  return null;
}

/**
 * End a session for good: every window attached to it closes, its tabs are
 * gone and its saved copy is forgotten.
 */
function killSession(name) {
  const target = liveSession(name);
  const removed = sessions?.remove(name) ?? false;
  if (!target) {
    if (removed) announceSessions();
    return removed;
  }
  liveSessions.delete(sessionKey(target.name));
  for (const client of [...target.clients]) {
    client.sessionName = null;
    if (client.win && !client.win.isDestroyed()) client.win.close();
  }
  announceSessions();
  return true;
}

/** The window holding a tab, or null when no window does. */
function windowOfTab(id) {
  for (const window of windows) {
    if (window.tabs.has(id)) return window;
  }
  return null;
}

/**
 * Keep a window's tab as a buffer nobody is showing: its page stays loaded and
 * its row moves under the buffers heading. The window is going away, so the
 * view has to leave it first; the renderer itself is kept, which is what makes
 * bringing the page back a swap instead of a load.
 */
function parkBuffer(window, tab) {
  const view = tab.view;
  if (!view || view.webContents.isDestroyed()) return;
  const url = window.urlOf(tab);
  const title = tab.title || window.titleFor(tab);
  window.unwireTab(view.webContents);
  // The splash is not a buffer: every split opens one, and a window closing
  // with three empty tabs must not park three rows of nothing.
  if (!url || url === HOME) {
    if (freeTabs.length < WARM_TABS) {
      freeTabs.push({ view, ready: true });
    } else {
      view.webContents.close();
    }
    return;
  }
  // One row per page: a buffer already holding this address would only be the
  // same page twice.
  if (bufferFor(url)) {
    view.webContents.close();
    return;
  }
  parkedBuffers.set(tab.id, {
    id: tab.id,
    view,
    title,
    url,
    loaded: true,
    session: window.sessionName || '',
  });
  // The oldest buffer goes when the list is full: a page nobody has reached
  // for in sixteen windows' worth of opening is memory the browser needs.
  while (parkedBuffers.size > PARKED_MAX) {
    const oldest = parkedBuffers.keys().next().value;
    const entry = parkedBuffers.get(oldest);
    parkedBuffers.delete(oldest);
    entry.view.webContents.close();
  }
}

/** The buffer already holding that address, loaded or not, or null. */
function bufferFor(url) {
  for (const entry of parkedBuffers.values()) if (entry.url === url) return entry;
  for (const entry of dormantBuffers.values()) if (entry.url === url) return entry;
  return null;
}

/**
 * A closed tab's address, kept as a page this browser has open without a
 * window behind it. Nothing is loaded — asking for it loads it — which is why
 * an empty tab is not worth a row here.
 */
function rememberBuffer(window, tab) {
  const url = window.urlOf(tab);
  if (!url || url === HOME) return;
  if (bufferFor(url)) return;
  const id = nextBufferId--;
  dormantBuffers.set(id, { id, url, title: tab.title || window.titleFor(tab), loaded: false });
  while (dormantBuffers.size > DORMANT_MAX) {
    dormantBuffers.delete(dormantBuffers.keys().next().value);
  }
}

/** Kill a parked buffer for good, the `:bd` of a page no window is showing. */
function killBuffer(id) {
  const parked = parkedBuffers.get(id);
  if (parked) {
    parkedBuffers.delete(id);
    if (!parked.view.webContents.isDestroyed()) parked.view.webContents.close();
    updateSidebars();
    return true;
  }
  const dormant = dormantBuffers.delete(id);
  if (dormant) updateSidebars();
  return dormant;
}

/**
 * Take a buffer out of the pool and onto that window's screen: a loaded one
 * comes back with the page it still has, a dormant one loads its address the
 * ordinary way.
 */
function resumeBuffer(id, window) {
  const parked = parkedBuffers.get(id);
  if (parked) {
    parkedBuffers.delete(id);
    window.hideBar();
    window.adoptBuffer(parked);
    updateSidebars();
    return null;
  }
  const dormant = dormantBuffers.get(id);
  if (dormant) {
    dormantBuffers.delete(id);
    window.hideBar();
    window.createTab({ url: dormant.url });
    updateSidebars();
    return null;
  }
  return 'no such buffer';
}

/**
 * Go to a tab wherever it lives: a tab of this window is a plain switch, one
 * held by another window brings that window to the front with it, the way
 * `switch-client` does in tmux. A buffer no window shows comes onto this one's
 * screen with the page it still has. A test launch never shows a window, so
 * there it is only the switch.
 */
function revealTab(id, from) {
  const owner = windowOfTab(id);
  if (!owner) return resumeBuffer(id, from);
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
    // A window the request actually reveals is a launch and comes up to type:
    // hidden, minimized, or built on a desktop the user is not looking at, the
    // bar opens with the caret in it the way a cold start's does. A window
    // already on screen is only brought forward — asking for it while it is in
    // front must not throw the bar over the page being read, and neither must
    // focusing it again after a tab closed.
    const revealed = !existing.win.isVisible() || existing.win.isMinimized();
    if (!existing.win.isVisible()) existing.win.show();
    existing.focus();
    if (revealed) existing.showBar();
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
  // A session that was never saved does not come back: saving is what makes
  // one outlive the browser, the way a tmux session outlives its clients.
  const saved = snapshots.filter(
    (snapshot) => snapshot.session && snapshot.saved && sessions?.get(snapshot.session),
  );
  // A state file written before sessions have no `saved` on its windows: it
  // comes back once, as windows of their own, so the change does not eat the
  // tabs it was holding. Every file written from now on has the flag.
  const legacy = snapshots.some((snapshot) => !('saved' in snapshot))
    ? snapshots.filter((snapshot) => !('saved' in snapshot))
    : [];
  const chosen = saved.length ? saved : legacy;
  if (!chosen.length) return createWindow();
  // Two windows on one saved session come back as two clients of it.
  return Promise.all(chosen.map((snapshot) => createWindow(snapshot)));
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
      // A favourite dropped from the list stops being preloaded with it, and
      // a settings page showing the list redraws without a save.
      syncWarmPages();
      announceFavourites();
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
    case 'session':
    case 'sessions':
    case 'ws':
      return sessionCommand(window, command.args);
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
    case 'vs':
      window.hideBar();
      window.splitPane('vertical');
      return null;
    case 'split':
    case 'sp':
      window.hideBar();
      window.splitPane('horizontal');
      return null;
    case 'only':
      window.hideBar();
      window.closePanesExcept();
      return null;
    // The editor's two ways of undoing a pane: `:q` closes the window and
    // keeps the buffer, `:bd` ends the buffer and closes its window.
    case 'q':
    case 'quit':
    case 'close':
      window.hideBar();
      if (!window.closePane()) return 'no split to close';
      return null;
    case 'bd':
    case 'bdelete':
    case 'bwipeout':
      window.hideBar();
      if (window.activeTabId != null) window.closeTab(window.activeTabId);
      return null;
    default:
      return NOT_A_COMMAND;
  }
}

/**
 * `:session` with no verb is the picker; save keeps the tabs this window shows
 * under a name and makes them come back later, open attaches this window to
 * another session, kill ends one for good.
 */
function sessionCommand(window, args) {
  const [verb, ...rest] = args;
  const name = normalizeName(rest.join(' '));
  switch (String(verb ?? '').toLowerCase()) {
    case '':
    case 'list':
      window.showBar('session');
      return null;
    case 'save': {
      const state = window.sessionState();
      const current = sessionFor(window);
      const chosen = name || current?.name || freshSessionName(state.tabs, state.activeTab);
      const entry = saveSession(chosen, state, current);
      if (!entry) return 'the session needs a name';
      window.sessionName = entry.name;
      window.persistTabs();
      window.bar.webContents.send(
        'bar:notice',
        `saved session ${entry.name} · ${entry.tabs.length} tab${entry.tabs.length === 1 ? '' : 's'}`,
      );
      return null;
    }
    case 'open':
    case 'attach': {
      if (!name) {
        window.showBar('session');
        return null;
      }
      const error = attachToSession(window, name);
      if (error) return error;
      window.bar.webContents.send('bar:notice', `session ${name}`);
      return null;
    }
    case 'kill': {
      if (!name) return 'kill which session?';
      if (!killSession(name)) return `no session called "${name}"`;
      window.bar?.webContents.send('bar:notice', `killed session ${name}`);
      return null;
    }
    default:
      return `unknown session command "${verb}"`;
  }
}

/** Ctrl+N: the Nth session in the jump order, attached to this window. */
function selectSessionNumber(window, number) {
  const row = sessionList()[number - 1];
  if (!row) return false;
  const error = attachToSession(window, row.name);
  if (!error) window.bar.webContents.send('bar:notice', `session ${row.name}`);
  return !error;
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
  // A colon in the session picker means the user is typing a command, so the
  // list turns back into the ordinary command list from that character on.
  const typedColon = String(text ?? '').trim().startsWith(':');
  const picker = window?.barMode === 'session' && !typedColon;
  const mode = picker ? 'session' : window?.barMode === 'session' ? 'address' : window?.barMode;
  const items = suggestions(text, {
    history: visited.list(),
    favourites: visited.favourites(),
    searchUrl: config.searchUrl,
    tabs: window ? window.pickerTabs() : [],
    sessions: sessionList(),
    currentSession: window?.sessionName ?? '',
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

/**
 * A page asking for a step back or forward — Vimium's H and L — taken the way
 * the window's own back and forward keys take it, so the page kept loaded is
 * used instead of a reload. A counted step (3H) is Chromium's own history
 * navigation: one kept page cannot answer for three.
 */
ipcMain.on('page:step', (event, delta) => {
  const window = ctxFor(event);
  const tab = window?.activeTab();
  const history = tab?.view?.webContents.navigationHistory;
  const count = Math.trunc(Number(delta)) || 0;
  if (!history || !count) return;
  if (Math.abs(count) === 1) {
    window.go(count);
    return;
  }
  const index = history.getActiveIndex() + count;
  if (index >= 0 && index < history.length()) history.goToIndex(index);
});

ipcMain.on('sidebar:action', (event, action) => {
  const window = ctxFor(event);
  if (!window || !action || typeof action !== 'object') return;
  const id = Number(action.id);
  // A row can be a tab of another window, so the action goes to the window
  // holding it. `new` is always this window's.
  const owner = Number.isInteger(id) ? windowOfTab(id) : null;
  if (action.type === 'activate') revealTab(id, window);
  // A row of a window is that window's tab to close; a row under the buffers
  // heading is a buffer with no window, and closing it kills it outright.
  else if (action.type === 'close') {
    if (owner) owner.closeTab(id);
    else killBuffer(id);
  } else if (action.type === 'new') window.createTab({ openBar: true });
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

/**
 * The address a settings row is asking to keep, or null. Bare hosts get the
 * scheme the command bar would give them; text that would become a search is
 * not an address, and the search URL is what tells the two apart.
 */
function favouriteUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const url = parseInput(text, config.searchUrl);
  if (!url || !/^(https?|file):/i.test(url)) return null;
  if (config.searchUrl && url.startsWith(config.searchUrl)) return null;
  return url;
}

/** Every open settings page hears about a favourite changed, whichever window made it. */
function announceFavourites() {
  for (const window of windows) {
    if (!window.panelVisible || !window.panel) continue;
    window.panel.webContents.send('favourites:changed', { favourites: favouritesPayload() });
  }
}

/**
 * What the settings page's favourite rows do: add one, rewrite one, forget
 * one, or switch one on to keep it loaded. Each row is its own save — the
 * favourites are a list, not a form — so the bar's suggestions and the pages
 * waiting in the background follow the edit at once.
 */
ipcMain.handle('favourites:action', (event, request) => {
  if (!ctxFor(event)) return { ok: false, error: 'no window' };
  if (!request || typeof request !== 'object') return { ok: false, error: 'invalid favourite' };
  const action = String(request.action ?? '');
  const url = String(request.url ?? '');
  if (action === 'save') {
    const address = favouriteUrl(url);
    if (!address) return { ok: false, error: `"${url.trim()}" is not a web address` };
    const from = request.from ? String(request.from) : null;
    if (!visited.saveFavourite(address, { title: String(request.title ?? '').trim(), from })) {
      return { ok: false, error: `"${address}" is already a favourite` };
    }
  } else if (action === 'remove') {
    visited.removeFavourite(url);
  } else if (action === 'warm') {
    visited.setWarm(url, request.warm === true);
  } else {
    return { ok: false, error: `unknown favourite action "${action}"` };
  }
  syncWarmPages();
  announceFavourites();
  return { ok: true, favourites: favouritesPayload() };
});

/**
 * The sessions as the settings page and the picker list them: every one that
 * exists, in jump order, with how many windows are attached and whether it
 * survives a quit.
 */
function sessionsPayload(window) {
  const showing = sessionKey(window?.sessionName);
  return {
    sessions: sessionList().map((entry) => ({
      ...entry,
      current: showing !== '' && sessionKey(entry.name) === showing,
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
 * What the settings page's session rows do. Renaming follows the session into
 * the windows attached to it; killing closes them, which is what killing a
 * session means; the arrows change the order `Ctrl+1`..`Ctrl+9` jump in.
 */
ipcMain.handle('sessions:action', (event, request) => {
  const window = ctxFor(event);
  if (!window) return { ok: false, error: 'no window' };
  const action = String(request?.action ?? '');
  const name = normalizeName(request?.name);
  if (action === 'save') {
    const state = window.sessionState();
    const chosen = name || window.sessionName || freshSessionName(state.tabs, state.activeTab);
    const entry = saveSession(chosen, state, sessionFor(window));
    if (!entry) return { ok: false, error: 'the session needs a name' };
    window.sessionName = entry.name;
    window.persistTabs();
    announceSessions();
    return { ok: true, ...sessionsPayload(window) };
  }
  if (!name) return { ok: false, error: `${action} which session?` };
  if (action === 'rename') {
    const next = normalizeName(request?.to);
    if (!next) return { ok: false, error: 'the session needs a name' };
    const live = liveSession(name);
    if (live) {
      // A live session that has never been saved only changes its label; one
      // that is saved is renamed on disk too, which keeps its place.
      const saved = sessions?.get(name);
      if (saved && !sessions.rename(name, next)) {
        return { ok: false, error: `there is already a session called "${next}"` };
      }
      liveSessions.delete(sessionKey(live.name));
      live.name = next;
      liveSessions.set(sessionKey(next), live);
      for (const client of live.clients) client.sessionName = next;
    } else if (!sessions?.rename(name, next)) {
      return { ok: false, error: `no session called "${name}", or "${next}" is taken` };
    }
    announceSessions();
    return { ok: true, ...sessionsPayload(window) };
  }
  if (action === 'kill' || action === 'delete') {
    if (!killSession(name)) return { ok: false, error: `no session called "${name}"` };
    announceSessions();
    return { ok: true, ...sessionsPayload(window) };
  }
  if (action === 'up' || action === 'down') {
    if (!sessions?.get(name)) return { ok: false, error: `save "${name}" before ordering it` };
    sessions.move(name, action === 'up' ? -1 : 1);
    announceSessions();
    return { ok: true, ...sessionsPayload(window) };
  }
  if (action === 'open') {
    const failure = attachToSession(window, name);
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
 * Chromium asks the user for a permission; this browser has no question to put
 * on screen, and Electron's default is to answer yes for every page and every
 * permission. A notification is what an ad asks for by itself, and it arrives
 * as a Windows toast beside the browser — so that answer becomes no, and the
 * rest keep the answer they already got.
 */
function guardPermissions(target) {
  const allowed = (permission) => permission !== 'notifications';
  target.setPermissionRequestHandler((_webContents, permission, callback) => callback(allowed(permission)));
  target.setPermissionCheckHandler((_webContents, permission) => allowed(permission));
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
    guardPermissions(ses);
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
    sessions = new Sessions(app.getPath('userData'));
    startConfigWatch();
    // `--hidden` starts the resident process without a window: run at login so
    // every later launch is a request to an already warm browser.
    if (process.argv.includes('--hidden') || process.argv.includes('--daemon')) return undefined;
    return showWindow({ restore: true });
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
