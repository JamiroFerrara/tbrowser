# tbrowser

A minimal Chromium browser: windows of tabs, one page at a time, one command bar
at the bottom opened with a keybind. Chrome extensions and DevTools work, so keys are handled by
[Vimium](#extensions) and `F12` opens DevTools.

Runs on Windows (primary target), Linux and macOS via Electron.

## Why Electron

The requirement is real Chrome extensions plus DevTools. Tauri/WebView2 can load
unpacked extensions but does not implement `chrome.tabs`, `chrome.windows` or
`chrome.commands`, has no extension UI, and does not enable `declarativeNetRequest`
rule sets — Vimium and uBlock Lite do not work there. Electron ships full Chromium,
so the extension API surface is large enough for Vimium, at the cost of ~100 MB.

That same gap is why the adblocker is built in instead of being a Chrome extension:
Electron has no working `declarativeNetRequest`, and Manifest V2 blocking
extensions no longer load. See [Adblock](#adblock).

## Run on Windows

Requires Node.js 20+.

```powershell
npm install
npm start
```

Package a standalone executable:

```powershell
npm run pack:win
# dist/tbrowser-win32-x64/tbrowser.exe
```

`npm install` must run on the platform you launch from; the Electron binary is
platform-specific. WSL users: run these commands from Windows, or package with
`npm run pack:win` and launch the `.exe`.

## Keys

| Key | Action |
| --- | --- |
| `Ctrl+P` | open the command bar on an empty field |
| `:` | vim's command line: the bar starts on `:` |
| `Ctrl+L`, `Ctrl+K` | open/focus the command bar with the current address |
| `Esc` | close the command bar |
| `Enter` | open what you typed, or the highlighted suggestion |
| `↑` / `↓`, `Ctrl+J` / `Ctrl+K` | move through the suggestions |
| `Ctrl+J` / `Ctrl+K` (no list) | next / previous tab |
| `Ctrl+1` … `Ctrl+8` | go to that tab |
| `Ctrl+9` | go to the last tab |
| `Ctrl+R`, `F5` | reload |
| `Alt+Left` / `Alt+Right` | back / forward |
| `F12`, `Ctrl+Shift+I` | DevTools |
| `Ctrl+N` | new window |
| `Ctrl+Shift+W` | close window |
| `Ctrl+Q` | quit |

Vimium handles everything else inside the page (`f`, `j`, `o`, `?`, ...).

Everything is rebindable in `config.json` (created on first run):

- Windows: `%APPDATA%\tbrowser\config.json`
- Linux: `~/.config/tbrowser/config.json`
- macOS: `~/Library/Application Support/tbrowser/config.json`

```json
{
  "searchUrl": "https://www.google.com/search?q=",
  "adblock": true,
  "keybindings": {
    "openBar": ["ctrl+l", "ctrl+k", ":"],
    "search": ["ctrl+p"],
    "closeBar": ["escape"],
    "reload": ["ctrl+r", "f5"],
    "back": ["alt+left"],
    "forward": ["alt+right"],
    "devtools": ["f12", "ctrl+shift+i"],
    "newWindow": ["ctrl+n"],
    "closeWindow": ["ctrl+shift+w"],
    "quit": ["ctrl+q"]
  }
}
```

Accelerators are `modifier+...+key` with `ctrl`, `alt`, `shift`, `meta`. Keys
include `a`-`z`, `0`-`9`, `left`, `right`, `up`, `down`, `escape`, `enter`,
`space`, `f1`-`f12`, and punctuation.

## Command bar

`:` opens vim's command line: the field starts on `:`, and `:s <words>` is the
search. `Ctrl+P` opens the same bar on an empty field (text that names no
command is searched either way), and `Ctrl+L`/`Ctrl+K` open it on the current
address.

While you type, a list grows up out of the bar and narrows with you:

- `🕘` pages you have visited, ranked by frecency, `Enter` on the first one
- `★` favourites, added and removed with `:fav`
- `🔍` the web search, last row, so a query with no match still searches —
  typing `you` preselects YouTube when you have opened it, the way Chrome does
- `⌘` commands, while the line starts with `:`

A bare address (`https://…`, `example.com`, `localhost:3000`) shows no list:
it is going to be opened as typed.

Ranking is the frecency shape fff.nvim uses: every visit counts 1, decays with
a 10-day half-life, stops counting after 30 days, and a page visited very often
grows only as the square root past ten. Favourites are floored above ordinary
visits so they stay reachable.

Visited pages and favourites are `history.json` and `favourites.json` in the
user-data directory next to `config.json`.

Input typing:

- `https://…`, `http://…`, `file:///…`, `about:blank` — opened as-is
- `example.com` — gets `https://`
- `localhost:3000`, `192.168.1.1:8080`, `example.com:8080` — gets `http://` (non-443 port or local/IP host)
- anything else — search via `searchUrl`, even after a `:` that named no command

Commands:

| Command | Effect |
| --- | --- |
| `:s <query>` | search for exactly that text |
| `:fav` | add or remove the current page from favourites |
| `:extensions` (`:ext`) | loaded extensions and their settings pages |
| `:settings` (`:config`) | edit `config.json` |

Single view, no tabs: `target=_blank` links open in the same page.

## Extensions

Three directories are scanned at startup; each subfolder with a `manifest.json`
is loaded unpacked:

- `extensions/` — next to the app (source checkouts)
- `vendor/` — bundled Vimium fork
- `%APPDATA%\tbrowser\extensions` (Linux: `~/.config/tbrowser/extensions`) —
  use this for a packaged install, where the app directory may be read-only

```powershell
# Chrome Web Store URL, 32-char extension id, .crx/.zip URL, or local file
npm run add-ext -- https://chromewebstore.google.com/detail/<slug>/<id>
npm run add-ext -- <extension-id>
```

For a packaged install, extract the folder into the user extensions directory
instead (the installer writes to `extensions/` next to the app).

### Vimium

`vendor/vimium` is Vimium 2.4.2 with a compatibility shim
(`background_scripts/tbrowser-compat.js`, plus `lib/tbrowser-compat.js` for content scripts) because Electron lacks
`chrome.webNavigation`, `chrome.windows`, `chrome.commands`, `chrome.history`,
`chrome.bookmarks`, `chrome.sessions`, `chrome.notifications` and `chrome.search`.
The shim stubs those APIs so the MV3 service worker boots; content-script features
(hints, scrolling, find, marks, omnibar, copy URL) work. Tab-management commands
(`x`, `T`, `g$`, ...) are limited because Electron has no tab management.

Vimium C crashes the same way (`chrome.windows.onFocusChanged`); if you want it,
apply the same shim to its manifest's `background.service_worker`.

### uBlock Origin

Does not work: Electron exposes `chrome.declarativeNetRequest` but never enables
rule sets (`getEnabledRulesets()` returns `[]`; requests are not filtered).

## Adblock

Built in via [`@ghostery/adblocker-electron`](https://github.com/ghostery/adblocker)
using Easylist/uBO filter lists, applied through Electron's `webRequest`. Filters
are cached in `adblock-engine.bin` under the user-data directory; the first run
needs network access. Set `"adblock": false` in `config.json` to disable.

## Speed

Only the active page costs a process, and only the first launch pays for a
cold start.

- The window appears before the session, the command bar or a page exists:
  filter lists, extensions and page loads happen while it is already visible.
- Closing the last window parks the process instead of quitting (`"resident":
  true`, the default). The next `npm start` hands off to that process and
  builds a window from the warm session. Set `"resident": false` to quit with
  the last window as a normal app does.
- `Ctrl+N` reuses the running process: the session, extensions and blocking are
  already warm, so a new window paints before it has loaded anything and is
  usable in about a tenth of a second. Every window keeps its own tabs, its own
  sidebar and its own bounds; closing one leaves the others alone, and closing
  the last still parks the process.
- A restored tab is a record, not a renderer: its view is created the first
  time you switch to it, so ten saved tabs start one renderer, not ten.
- The bar, the sidebar and the panel outlive the window they are shown in. A
  reopened window gets the already-painted chrome back, so it is complete
  about 130 ms after it appears instead of waiting for three renderers.
- The panel is warmed in the background after the window is up, so the first
  `:extensions` is instant.
- `Ctrl+E` puts the sidebar over the page: the page keeps the whole window and
  is never resized by the toggle, and showing the sidebar is one view added,
  with no slide animation stealing frames from the page.
- Tab state is written at most every 250 ms instead of synchronously on every
  navigation, and flushed when the window closes.
- Keybindings are parsed once at startup, not on every keystroke.
- The adblock engine loads alongside the window and switches blocking on when
  it is ready; the first page never waits for it.

Start it once and leave it running: ask that process for a window instead of
starting the executable again.

- `node scripts/show.mjs` writes one word to the control pipe and exits — 23 ms
  here; the resident browser opens the window.
- Any hotkey or shell script can drop a file named `show.request` beside the
  user data instead (`%APPDATA%\tbrowser\show.request` on Windows); the daemon
  watches for it. AutoHotkey can do that with `FileAppend`.
- `tbrowser.exe --hidden` starts the process with no window, so it can sit in
  the login startup folder: the first press of the day is then a request too.
- `tbrowser.exe --quit` ends the running process — window or no window. Every
  keybinding lives inside a window, so a parked daemon has no `Ctrl+Q` to
  press; this is how a hotkey or a script closes the browser for good. The
  request file works too: a `show.request` holding `quit` closes it.

A launcher that gets no answer can fall back to starting the app normally.

`TBROWSER_TIMING=1` logs where a launch spends its time (`window shown`,
`session ready`, `page created`), relative to the main script starting, and
appends the same lines to `startup.log` beside the user data — a packaged
Windows app has no console to print to.

## Development

```bash
npm test          # command parsing + keybinding matcher
npm start         # run from source (dev)
```

Layout:

- `main.js` — windows and their views, key routing, state
- `lib/` — command parsing, keybinding matcher/config, extension loading, adblock
- `ui/` — command-bar page + preload
- `scripts/install-extension.mjs` — CRX/zip unpacker for `extensions/`
- `vendor/vimium` — patched Vimium fork
