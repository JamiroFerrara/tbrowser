// Electron compatibility shims for content-script worlds. Must run first.
if (!chrome.extension) chrome.extension = {};
if (chrome.extension.inIncognitoContext === undefined) chrome.extension.inIncognitoContext = false;
if (chrome.storage && !chrome.storage.session) {
  try {
    chrome.storage.session = chrome.storage.local;
  } catch {
    // chrome.storage is read-only; session-only history just stays unavailable.
  }
}
