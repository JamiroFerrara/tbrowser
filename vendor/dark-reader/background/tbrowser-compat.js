// Electron compatibility shim, loaded before Dark Reader's own worker (see
// manifest.json) so its service worker can boot here.
//
// Electron's chrome.extension has no isAllowedFileSchemeAccess. Dark Reader's
// settings payload waits on that callback, so without it the popup sits on
// "Loading, please wait" forever and the extension cannot be configured.
// Electron never grants extensions access to file:// URLs, so the honest
// answer is false.
if (chrome.extension && typeof chrome.extension.isAllowedFileSchemeAccess !== 'function') {
  chrome.extension.isAllowedFileSchemeAccess = (callback) => {
    if (typeof callback === 'function') callback(false);
  };
}
importScripts('index.js');
