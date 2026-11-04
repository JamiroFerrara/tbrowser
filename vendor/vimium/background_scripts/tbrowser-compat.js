// Electron compatibility shims for Chrome APIs that Electron does not implement.
// Loaded before Vimium's background code so its service worker can boot.
const noopEvent = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
const define = (name, value) => {
  if (!chrome[name]) chrome[name] = value;
};
const lastFn = (args) => [...args].reverse().find((arg) => typeof arg === 'function');

if (!chrome.extension) chrome.extension = {};
if (chrome.extension.inIncognitoContext === undefined) chrome.extension.inIncognitoContext = false;
if (!chrome.extension.getBackgroundPage) chrome.extension.getBackgroundPage = () => globalThis;

define('webNavigation', {
  onHistoryStateUpdated: noopEvent(),
  onReferenceFragmentUpdated: noopEvent(),
  onCommitted: noopEvent(),
  onCompleted: noopEvent(),
  onBeforeNavigate: noopEvent(),
  onDOMContentLoaded: noopEvent(),
  getAllFrames: (...args) => {
    const frames = [{ frameId: 0, tabId: 0, url: '', parentFrameId: -1 }];
    const callback = lastFn(args);
    if (callback) {
      callback(frames);
      return undefined;
    }
    return Promise.resolve(frames);
  },
});

define('windows', {
  WINDOW_ID_CURRENT: -2,
  WINDOW_ID_NONE: -1,
  get: (...args) => lastFn(args)?.({ id: 1, focused: true, type: 'normal' }),
  getAll: (...args) => lastFn(args)?.([{ id: 1, focused: true, type: 'normal' }]),
  update: (...args) => lastFn(args)?.({ id: 1, focused: true, type: 'normal' }),
  onFocusChanged: noopEvent(),
  onCreated: noopEvent(),
  onRemoved: noopEvent(),
  onBoundsChanged: noopEvent(),
});

define('commands', {
  getAll: (...args) => lastFn(args)?.([]),
  onCommand: noopEvent(),
});

define('history', {
  search: (...args) => lastFn(args)?.([]),
  getVisits: (...args) => lastFn(args)?.([]),
  addUrl: (...args) => lastFn(args)?.(),
  deleteUrl: (...args) => lastFn(args)?.(),
  deleteRange: (...args) => lastFn(args)?.(),
  onVisited: noopEvent(),
  onVisitRemoved: noopEvent(),
});

define('bookmarks', {
  getTree: (...args) => lastFn(args)?.([]),
  get: (...args) => lastFn(args)?.([]),
  search: (...args) => lastFn(args)?.([]),
  onCreated: noopEvent(),
  onRemoved: noopEvent(),
  onChanged: noopEvent(),
  onMoved: noopEvent(),
});

define('sessions', {
  getRecentlyClosed: (...args) => lastFn(args)?.([]),
  restore: (...args) => lastFn(args)?.([]),
  onChanged: noopEvent(),
});

define('notifications', {
  create: (...args) => lastFn(args)?.(''),
  clear: (...args) => lastFn(args)?.(true),
  onClicked: noopEvent(),
  onClosed: noopEvent(),
});

define('action', {
  setBadgeText: () => {},
  setBadgeBackgroundColor: () => {},
  setIcon: () => {},
  setTitle: () => {},
  onClicked: noopEvent(),
});

define('omnibox', {
  setDefaultSuggestion: () => {},
  onInputChanged: noopEvent(),
  onInputEntered: noopEvent(),
});

define('downloads', {
  download: (...args) => lastFn(args)?.(-1),
  onCreated: noopEvent(),
});

define('tabGroups', {
  query: (...args) => lastFn(args)?.([]),
  onCreated: noopEvent(),
  onRemoved: noopEvent(),
  onUpdated: noopEvent(),
});

define('contentSettings', {
  get: (...args) => lastFn(args)?.({}),
  set: (...args) => lastFn(args)?.(),
});

if (chrome.storage && !chrome.storage.session) chrome.storage.session = chrome.storage.local;

for (const event of [
  'onUpdated',
  'onCreated',
  'onRemoved',
  'onActivated',
  'onMoved',
  'onReplaced',
  'onAttached',
  'onDetached',
  'onHighlighted',
]) {
  if (chrome.tabs && !chrome.tabs[event]) chrome.tabs[event] = noopEvent();
}

if (chrome.tabs) {
  if (!chrome.tabs.create) {
    chrome.tabs.create = ({ url }, callback) => {
      chrome.tabs.query({ active: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (url && tab) chrome.tabs.update(tab.id, { url });
        callback?.(tab ?? {});
      });
    };
  }
  if (!chrome.tabs.get) chrome.tabs.get = (...args) => lastFn(args)?.({});
  if (!chrome.tabs.remove) chrome.tabs.remove = (...args) => lastFn(args)?.();
  if (!chrome.tabs.goBack) chrome.tabs.goBack = () => {};
  if (!chrome.tabs.goForward) chrome.tabs.goForward = () => {};
}
