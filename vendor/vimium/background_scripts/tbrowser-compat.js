// Electron compatibility shims for Chrome APIs that Electron does not implement.
// Loaded before Vimium's background code so its service worker can boot.
const noopEvent = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
const define = (name, value) => {
  if (!chrome[name]) chrome[name] = value;
};
const lastFn = (args) => [...args].reverse().find((arg) => typeof arg === 'function');
// Chrome's extension APIs answer a callback when one is passed and a promise
// otherwise; Vimium now awaits several of them, and `undefined` is not iterable.
const answer = (args, value) => {
  const callback = lastFn(args);
  if (callback) {
    callback(value);
    return undefined;
  }
  return Promise.resolve(value);
};
// Electron refuses chrome.storage.session to content scripts, whatever access
// level the background asks for — so Vimium, which keeps the compiled key
// mappings there and reads them from every page, would fall back to its
// defaults on each new document. Aliasing the area to local puts the mappings
// on a store both sides can reach.
const aliasSessionStorage = () => {
  if (!chrome.storage || !chrome.storage.local) return;
  const local = chrome.storage.local;
  const session = {
    get: (...args) => local.get(...args),
    set: (...args) => local.set(...args),
    remove: (...args) => local.remove(...args),
    clear: (...args) => local.clear(...args),
    getBytesInUse: (...args) => (local.getBytesInUse ? local.getBytesInUse(...args) : undefined),
    // The content scripts are meant to read this area, which is exactly what
    // Electron will not allow: the call is a no-op here.
    setAccessLevel() {},
    onChanged: local.onChanged,
  };
  try {
    Object.defineProperty(chrome.storage, 'session', { value: session, configurable: true });
  } catch {
    try {
      chrome.storage.session = session;
    } catch {
      // the area stays Electron's own; pages lose the key mappings
    }
  }
};
aliasSessionStorage();

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
  search: (...args) => answer(args, []),
  getVisits: (...args) => answer(args, []),
  addUrl: (...args) => answer(args, undefined),
  deleteUrl: (...args) => answer(args, undefined),
  deleteRange: (...args) => answer(args, undefined),
  onVisited: noopEvent(),
  onVisitRemoved: noopEvent(),
});

define('bookmarks', {
  // A tree, not a list: Vimium walks it as `[{ title, children }]`.
  getTree: (...args) => answer(args, [{ id: '0', title: '', children: [] }]),
  get: (...args) => answer(args, []),
  search: (...args) => answer(args, []),
  onCreated: noopEvent(),
  onRemoved: noopEvent(),
  onChanged: noopEvent(),
  onMoved: noopEvent(),
});

define('sessions', {
  getRecentlyClosed: (...args) => answer(args, []),
  restore: (...args) => answer(args, []),
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
