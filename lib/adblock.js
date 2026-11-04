'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Ad/tracker blocking built in, because Electron does not implement
 * chrome.declarativeNetRequest (so uBlock Origin Lite cannot work) and MV2
 * blocking webRequest extensions are gone. Ghostery's engine uses Electron's
 * own webRequest, which Electron does support.
 *
 * Filters are cached in userData; the first run needs network access.
 */
async function enableAdblock(ses, userDataDir, log = console) {
  let ElectronBlocker;
  try {
    ({ ElectronBlocker } = require('@ghostery/adblocker-electron'));
  } catch (err) {
    log.warn(`[tbrowser] adblock unavailable: ${err.message}`);
    return null;
  }

  const cachePath = path.join(userDataDir, 'adblock-engine.bin');
  try {
    const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cachePath,
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
    blocker.enableBlockingInSession(ses);
    log.info('[tbrowser] adblock enabled');
    return blocker;
  } catch (err) {
    log.warn(`[tbrowser] adblock disabled: ${err.message}`);
    return null;
  }
}

module.exports = { enableAdblock };
