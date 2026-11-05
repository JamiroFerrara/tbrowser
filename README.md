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
| `Alt+P` | open the workspace picker |
| `Alt+S` / `Alt+Shift+S` | split side by side / stacked |
| `Alt+H` `Alt+J` `Alt+K` `Alt+L` | move between the two panes |
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
    "workspaces": ["alt+p"],
    "splitVertical": ["alt+s"],
    "splitHorizontal": ["alt+shift+s"],
    "focusPane": ["alt+h", "alt+j", "alt+k", "alt+l"],
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
address. Pressed while the bar is already up, any of them only brings the caret
back to it — the text you had typed stays where it was.

While you type, a list grows up out of the bar and narrows with you:

- `🗂` the tabs already open, the focused one first; `Enter` switches to the tab
  instead of loading its address again
- `🕘` pages you have visited, ranked by frecency, `Enter` on the first one
- `★` favourites, added and removed with `:fav`
- `🔍` the web search, last row, so a query with no match still searches —
  typing `you` preselects YouTube when you have opened it, the way Chrome does
- `⌘` commands, while the line starts with `:`

A bare address (`https://…`, `example.com`, `localhost:3000`) shows no list:
it is going to be opened as typed.

Ranking is the frecency shape fff.nvim uses: every visit counts 1, decays with
a 10-day half-life, stops counting after 30 days, and a page visited very often
grows only as the square root past ten. Favourites are listed above every
visited page, however often that page is opened; the star is kept further up
the list even when its match is weaker.

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
| `:ws` | open the workspace picker |
| `:ws save [name]` | keep this window's tabs under a name (the page's host by default) |
| `:ws open <name>` | swap this window's tabs for that saved set |
| `:ws delete <name>` | forget a saved set |
| `:tab <id>` | switch to a tab by the id the picker uses |
| `:vsplit` / `:split` / `:only` | split side by side / stacked / back to one page |

A `target=_blank` link opens in a new tab; a page asking for a sized popup —
a sign-in — opens in a real window so the login can finish.

## Workspaces

A workspace is a named set of tabs and the one that had focus, saved in
`workspaces.json` beside `config.json`. It is the browser's answer to a tmux
session: `Alt+P` lists them, `Enter` switches the window to one, and switching
back is another `Alt+P`.

- **Switching keeps what you had.** A window showing a named workspace writes
  its tabs back into it before switching, so a workspace is never lost by
  leaving it. A window that was never named puts its tabs in a single rolling
  `last session` slot, so `Alt+P` always has a way back.
- **Saving.** `:ws save work` names the current tabs `work`. `:ws save` with no
  argument names them after the page you are on. Saving an existing name
  replaces it, and closing a window updates the workspace it was showing.
- **What is stored.** The tab addresses in order, which tab had focus, and any
  split. Titles and scroll positions are not stored; the pages load again.
- **Grouping is open.** A workspace is a flat list, so the same site can appear
  in two of them and twice in one. Whether a site should instead be allowed in
  only one place is not decided yet.

## Splits

`Alt+S` puts the current tab and the tab you were on before it side by side;
`Alt+Shift+S` stacks them. Pressing the same key again closes the split,
pressing the other turns it. `Alt+H`/`Alt+L` move between the two panes, and
so do `Alt+J`/`Alt+K`; clicking a page focuses its pane. The command bar, the
keys and the sidebar act on the focused pane, and the sidebar marks it.

The split appears in one step, both panes already at their final size: the
pages reflow once and no frame is spent moving a divider across them. The two
panes are ordinary tabs: both stay in the tab list and in the sidebar, and
closing one leaves the other filling the window.

- The page order is fixed (first tab left or top), so focusing a pane never
  swaps the pictures.
- A split with one tab creates a second, empty one to sit beside it.
- The split is remembered in `state.json`, so a restored window opens with it.
- `:only` closes it without closing either tab.

## New tab

An empty tab is the splash the editor shows on a bare buffer: one Matrix quote,
picked at random from the same list, centered in the window in the editor's
face and catppuccin blue, and nothing else.

The bar is up and focused on every launch and every new tab, so the first thing
you type is a search without reaching for a key first.

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

`:extensions` is the page that manages them: each card shows the icon, version,
description and the permissions it asked for, with a switch that turns the
extension on or off without uninstalling it, a **Settings** button that opens
the extension's own options page in a tab, and **Reload** for a folder you just
rebuilt. Switching one off unloads it for the running browser and remembers the
folder in `extensions.json` next to `config.json`, so it stays off at the next
launch too. Turning uBlock Origin off hands blocking back to the built-in
engine.

### Vimium

`vendor/vimium` is Vimium 2.4.2 with a compatibility shim
(`background_scripts/tbrowser-compat.js`, plus `lib/tbrowser-compat.js` for content scripts) because Electron lacks
`chrome.webNavigation`, `chrome.windows`, `chrome.commands`, `chrome.history`,
`chrome.bookmarks`, `chrome.sessions`, `chrome.notifications` and `chrome.search`.
The shim stubs those APIs so the MV3 service worker boots; content-script features
(hints, scrolling, find, marks, omnibar, copy URL) work. Tab-management commands
(`x`, `T`, `g$`, ...) are limited because Electron has no tab management.

It also points `chrome.storage.session` at `chrome.storage.local`, because
Electron refuses the session area to content scripts. Vimium keeps the compiled
key mappings there, so without it every page ran Vimium's defaults and silently
ignored settings imported from Brave — the fork would look like it had not
loaded them at all.

One collision is left by design: a key bound in `config.json` is taken before
the page sees it, so a Vimium mapping on the same key never fires. `Ctrl+P` is
the browser's search key and therefore shadows Vimium's `<c-p>`; rebind either
side in `:settings` if you want Vimium to have it.

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
  true`, the default). The next `npm start` hands off to that process, which
  opens a new empty window — one home tab and the command bar focused. The
  saved session comes back only when the process starts cold, after `--quit`
  or a reboot; a launch that finds the browser already running never brings
  back the tabs it was parked on. Set `"resident": false` to quit with the last
  window as a normal app does.
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
- `tbrowser.exe --no-ui` is the test launch: it builds its window and never
  puts it on screen, so a smoke test — or an agent checking a change while you
  keep working — takes no focus and stacks nothing in the taskbar. It runs
  beside the resident browser instead of handing itself to it, so any number of
  them run at once, and it runs on a throwaway profile: it starts from your
  `config.json` and your installed extensions, shares no cookies, tabs or
  history with the browser you use, and deletes the directory when it ends.

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
- `lib/` — command parsing, keybinding matcher/config, workspaces, extensions, adblock
- `ui/` — command-bar page + preload
- `scripts/install-extension.mjs` — CRX/zip unpacker for `extensions/`
- `vendor/vimium` — patched Vimium fork
