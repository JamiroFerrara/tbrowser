'use strict';
/*
 * tbrowser compat for an isolated content script: Electron's chrome.extension
 * has no inIncognitoContext, and the pop-out player reads it.
 */
if (typeof chrome !== 'undefined' && chrome && !chrome.extension) {
  chrome.extension = { inIncognitoContext: false };
}
