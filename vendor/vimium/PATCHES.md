# Vimium fork notes

Upstream: https://github.com/philc/vimium (MIT, see `LICENSE`), version 2.4.2,
unpacked from the Chrome Web Store build.

Local changes only:

1. `background_scripts/tbrowser-compat.js` + `background_scripts/tbrowser-sw.js`
   — stub the Chrome APIs Electron does not implement (`webNavigation`,
   `windows`, `commands`, `history`, `bookmarks`, `sessions`, `notifications`,
   `action`, `omnibox`, `downloads`, `tabGroups`, `contentSettings`,
   `extension.inIncognitoContext`, `tabs` events) and boot `main.js` through
   the wrapper. `tbrowser-seed.js` copies `tbrowser-settings.json` into
   `chrome.storage.sync` on first run (imported from a Brave profile via
   `scripts/import-vimium-settings.mjs`). The stubs answer a callback when one
   is passed and a promise otherwise, and `chrome.bookmarks.getTree` returns a
   tree rather than a list — Vimium awaits it and walks it.
2. `manifest.json` — `background.service_worker` points at `tbrowser-sw.js`.
3. `lib/tbrowser-compat.js` — the same shims for content-script worlds;
   prepended to every `content_scripts` entry.
4. `chrome.storage.session` is aliased to `chrome.storage.local` in both compat
   files. Electron refuses the session area to content scripts whatever access
   level the background asks for, and Vimium keeps the compiled key mappings
   (and the HUD stylesheet) there, so pages would otherwise run Vimium's
   defaults and ignore the imported settings.
5. `content_scripts/mode_normal.js` — `goBack`/`goForward` ask the browser for
   the step (a `tbrowser-step` event, which `ui/page-preload.js` forwards)
   instead of calling `history.go`. Electron has no back-forward cache, so the
   page's own history step reloads; the browser's step shows a view it kept
   loaded.
6. `content_scripts/scroller.js` — the frame-by-frame scroll animation keeps its
   first frame at upstream's speed and decelerates over the last 40% of the
   distance (a straight ramp, normalised so the whole distance is still covered
   by the end), with the duration stretched to `25 * ln(amount)` and capped at
   240ms so the start is unchanged. Upstream's version runs at one speed and
   stops dead at the end; Chromium's own `behavior: "smooth"` was tried instead
   and rejected — it ramps in from a standstill, so the key answer reads as lag.
   `smoothScroll` in Vimium's settings still chooses between the glide and the
   instant jump.
7. `content_scripts/mode_normal.js` + `ui/page-preload.js` — `yy`
   (`copyCurrentUrl`) asks the window for the copy with a `tbrowser-copy` event
   carrying the tab URL, the way `H`/`L` ask for their step, and the window
   writes the address with Electron's `clipboard` (`main.js`'s `page:copy-url`
   handler). The HUD iframe's own `navigator.clipboard.writeText` was not a
   path to rely on: it needs a focused document, and the promise it returns is
   never observed, so a refused write is silent. Only the sender's own URL is
   ever copied, so a page script that dispatches the event cannot put text of
   its choosing on the clipboard. The "Yanked" HUD message is still requested.

To update: copy the new unpacked build over this directory, reapply 1–7.
