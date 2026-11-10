'use strict';
/*
 * tbrowser compat for the service worker.
 *
 * Electron leaves out the extension APIs that open windows. The worker died on
 * its first line (chrome.commands is absent) and never registered, so changes
 * made in one tab stopped reaching the others; chrome.tabs.create and the
 * window calls below fill in what is left. A service worker has no way to open
 * a tab in Electron, so those requests are answered without effect: the
 * settings page is still reachable from tbrowser's extensions panel, and the
 * extension's own keyboard shortcuts have no default keys to run.
 */
if (!chrome.commands) {
  chrome.commands = { onCommand: { addListener() {} } };
}

if (chrome.tabs && !chrome.tabs.create) {
  chrome.tabs.create = (_options, callback) => {
    if (callback) callback(undefined);
    return Promise.resolve(undefined);
  };
}

if (chrome.windows) {
  chrome.windows.create = (_options, callback) => {
    if (callback) callback({ id: -1, tabs: [] });
    return Promise.resolve({ id: -1, tabs: [] });
  };
  chrome.windows.update = (_id, _info, callback) => {
    if (callback) callback(undefined);
    return Promise.resolve(undefined);
  };
} else {
  chrome.windows = {
    create: (_options, callback) => {
      if (callback) callback({ id: -1, tabs: [] });
      return Promise.resolve({ id: -1, tabs: [] });
    },
    update: (_id, _info, callback) => {
      if (callback) callback(undefined);
      return Promise.resolve(undefined);
    },
  };
}
