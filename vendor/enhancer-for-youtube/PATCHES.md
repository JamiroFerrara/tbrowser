# Enhancer for YouTube fork notes

Upstream: https://chromewebstore.google.com/detail/enhancer-for-youtube/ponfpcnoihfmfllpaingbgckeeldkhle
(`ponfpcnoihfmfllpaingbgckeeldkhle`), version 3.0.19, unpacked from the Chrome
Web Store build. `license.txt` is the upstream “All Rights Reserved” licence,
kept as shipped; this is a working copy for tbrowser's own build.

Local changes only:

1. `js/tbrowser-compat.js` — fills in what Electron leaves out of the
   extension API. `chrome.commands` is absent, and the service worker asked for
   `onCommand` on its first line, so the worker never registered: settings
   stopped reaching other tabs and the options page had no message handler.
   `chrome.tabs.create` and the `chrome.windows` calls are absent too, and a
   service worker has no way to open a tab in Electron, so they answer without
   effect. The settings page is still reachable from tbrowser's `:extensions`
   panel; the extension's own shortcuts have no default keys to run.
2. `js/service-worker.js` — `importScripts("tbrowser-compat.js", "config.js")`
   so the stubs exist before the worker touches them.
3. `js/tbrowser-compat-page.js` — `chrome.extension.inIncognitoContext` is
   missing in an isolated content script and the pop-out player reads it.
4. `manifest.json` — `tbrowser-compat-page.js` prepended to every isolated
   content-script entry (`youtube`, `embed`, `live_chat`, `pop-up-player`,
   `shorts`); the `MAIN` world entries have no extension APIs. The
   `web_accessible_resources` match is `<all_urls>`: Electron refuses a themed
   resource to a page when the list names the page's own origin, and the theme
   stylesheets never loaded under the upstream matches.
5. `js/youtube-isolated.js` — a pop-out request opens the player with
   `window.open` (the click is the user gesture) instead of asking the
   background to make a window it cannot make.

To update: unpack the new store build over this directory, reapply 1–5.
