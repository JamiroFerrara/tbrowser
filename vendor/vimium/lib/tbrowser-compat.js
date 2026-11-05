// Electron compatibility shims for content-script worlds. Must run first.
if (!chrome.extension) chrome.extension = {};
if (chrome.extension.inIncognitoContext === undefined) chrome.extension.inIncognitoContext = false;

// Electron refuses chrome.storage.session to content scripts, whatever access
// level the background asks for. Vimium keeps the compiled key mappings there
// and every page reads them from it, so without this alias each document would
// silently fall back to Vimium's defaults and ignore the user's own bindings.
if (chrome.storage && chrome.storage.local) {
  const local = chrome.storage.local;
  const session = {
    get: (...args) => local.get(...args),
    set: (...args) => local.set(...args),
    remove: (...args) => local.remove(...args),
    clear: (...args) => local.clear(...args),
    getBytesInUse: (...args) => (local.getBytesInUse ? local.getBytesInUse(...args) : undefined),
    // Pages are meant to read this area, which is exactly what Electron denies.
    setAccessLevel() {},
    onChanged: local.onChanged,
  };
  try {
    Object.defineProperty(chrome.storage, 'session', { value: session, configurable: true });
  } catch {
    try {
      chrome.storage.session = session;
    } catch {
      // the area stays Electron's own; the page loses the key mappings
    }
  }
}
