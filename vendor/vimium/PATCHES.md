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
   `scripts/import-vimium-settings.mjs`).
2. `manifest.json` — `background.service_worker` points at `tbrowser-sw.js`.
3. `lib/tbrowser-compat.js` — same `extension.inIncognitoContext` /
   `storage.session` shims for content-script worlds; prepended to every
   `content_scripts` entry.

To update: copy the new unpacked build over this directory, reapply 1–3.
