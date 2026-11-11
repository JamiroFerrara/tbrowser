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

Installers come from electron-builder:

```powershell
npm run pack:win:installer   # dist/tbrowser-<version>-windows-x64-setup.exe
npm run pack:linux           # AppImage and .deb
npm run pack:mac             # x64 and arm64 .dmg
```

## Releases

Pushing a tag that matches the version in `package.json` builds and publishes
the installers:

```bash
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/release.yml` runs the tests, builds on Windows, Linux and
macOS runners, and attaches the artifacts to a GitHub release:

| Platform | Artifact |
| --- | --- |
| Windows x64 | `tbrowser-<version>-windows-x64-setup.exe` (NSIS) |
| Linux x64 | `tbrowser-<version>-linux-x86_64.AppImage`, `...-linux-amd64.deb` |
| macOS x64, arm64 | `tbrowser-<version>-macos-x64.dmg`, `...-macos-arm64.dmg` |

The tag must be `v` followed by the exact `version` in `package.json`; the
workflow fails before building if they differ. The release job also writes
`SHA256SUMS.txt`.

Windows installers are unsigned, so SmartScreen warns on first launch. macOS
builds are ad-hoc signed, which lets them run on Apple Silicon, but they are
not notarized: Gatekeeper needs a right-click → Open (or
`xattr -dr com.apple.quarantine /Applications/tbrowser.app`). Full signing
needs the usual certificates in repository secrets; the workflow does not
require them.

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
| `Alt+1` … `Alt+8` | go to that tab |
| `Alt+9` | go to the last tab |
| `Ctrl+1` … `Ctrl+9` | attach this window to the session in that place of the order |
| `Ctrl+R`, `F5` | reload |
| `Alt+Left` / `Alt+Right` | back / forward on this page |
| `Ctrl+O` / `Ctrl+I` | jump back / forward through tabs and pages |
| `Alt+O` / `Alt+I` | the same two jumps, for the older habit |
| `Alt+P` | open the session picker |
| `Alt+S` / `Alt+Shift+S` | split side by side / stacked |
| `Alt+H` `Alt+J` `Alt+K` `Alt+L` | move to the pane that way |
| `Ctrl+E` | toggle the sidebar |
| `Ctrl+,` | open the settings page, and put it away again |
| `Ctrl+W` | close the pane; the tab stays, and with no split it closes the window |
| `Ctrl+Shift+W` | kill the tab (`:bd`) |
| `F12`, `Ctrl+Shift+I` | DevTools |
| `Ctrl+N` | new window |
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
  "preload": true,
  "blur": true,
  "blurOpacity": 37,
  "blurColor": "#24273a",
  "blurMaterial": "mica",
  "keybindings": {
    "openBar": ["ctrl+l", "ctrl+k", ":"],
    "search": ["ctrl+p"],
    "closeBar": ["escape"],
    "reload": ["ctrl+r", "f5"],
    "back": ["alt+left"],
    "forward": ["alt+right"],
    "jumpBack": ["ctrl+o", "alt+o"],
    "jumpForward": ["ctrl+i", "alt+i"],
    "workspaces": ["alt+p"],
    "splitVertical": ["alt+s"],
    "splitHorizontal": ["alt+shift+s"],
    "focusPane": ["alt+h", "alt+j", "alt+k", "alt+l"],
    "settings": ["ctrl+,"],
    "closePane": ["ctrl+w"],
    "killTab": ["ctrl+shift+w"],
    "devtools": ["f12", "ctrl+shift+i"],
    "newWindow": ["ctrl+n"],
    "closeWindow": [],
    "quit": ["ctrl+q"]
  }
}
```

Accelerators are `modifier+...+key` with `ctrl`, `alt`, `shift`, `meta`. Keys
include `a`-`z`, `0`-`9`, `left`, `right`, `up`, `down`, `escape`, `enter`,
`space`, `f1`-`f12`, and punctuation. An empty list unbinds the action:
`closeWindow` ships unbound, so a browser window goes with `Ctrl+Q`.

## Command bar

`:` opens vim's command line: the field starts on `:`, and `:s <words>` is the
search. `Ctrl+P` opens the same bar on an empty field (text that names no
command is searched either way), and `Ctrl+L`/`Ctrl+K` open it on the current
address. Pressed while the bar is already up, any of them only brings the caret
back to it — the text you had typed stays where it was.

While you type, a list grows up out of the bar and narrows with you:

- `🗂` the tabs open in every window, this window's focused one first — a row
  from another window is marked with that window's number, and `Enter` goes
  there; either way it switches instead of loading an address again
- `🕘` pages you have visited, ranked by frecency, `Enter` on the first one
- `★` favourites, added and removed with `:fav`
- `🔍` the web search, last row, so a query with no match still searches —
  typing `you` preselects YouTube when you have opened it, the way Chrome does
- `⌘` commands, while the line starts with `:`

A bare address (`https://…`, `example.com`, `localhost:3000`) shows no list:
it is going to be opened as typed.

Ranking is the frecency shape fff.nvim uses: every visit counts 1, decays with
a 10-day half-life, stops counting after 30 days, and a page visited very often
grows only as the square root past ten. The match decides, the visits tilt it,
and a favourite sits above the open tabs and the history — while a page opened
all day can still climb over a favourite nobody visits.

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
| `:session` | open the session picker |
| `:session save [name]` | keep this window's session, so it comes back after a quit |
| `:session open <name>` | attach this window to that session |
| `:session kill <name>` | close every window attached to it and forget it |
| `:tab <id>` | go to a tab of any window by the id the lists show |
| `:tab copy <id>` | open that tab's page here as a second tab |
| `:vsplit` (`:vs`) / `:split` (`:sp`) | split side by side / stacked |
| `:only` | close every other pane, keeping every tab |
| `:q` (`:quit`, `:close`) | close the focused pane; the tab stays |
| `:bd` (`:bdelete`) | kill the focused tab and the pane holding it |

A `target=_blank` link opens in a new tab; a page asking for a sized popup —
a sign-in — opens in a real window so the login can finish.

## Windows and tabs

Every window is a client of a session (see below), and the tabs of all of them
are one list: the window you are in first, then every other window in the order
it opened, with the window's place named beside its rows. A tab keeps its own
id for the whole browser, so a list built from more than one window can hand
that id back to `:tab` without asking which window it came from.

- **`Ctrl+E` sidebar** lists every window's tabs under a `this window` /
  `window N` heading. Clicking a row of another window brings that window to
  the front on that tab; the tab keeps its own place, its own page and its own
  back history, because nothing moves.
- **The command bar** puts the same list first in its dropdown. A row from
  another window is marked `window N · host`, and `Enter` goes to it — the
  window comes forward, the tab is focused.
- **`:tab <id>`** goes to any tab of the browser by the id the lists show.
- **`:tab copy <id>`** opens a second tab on the page another one already
  shows, here, in the window you are typing in: the same page on both sides.
  The document is its own — a renderer cannot be in two windows at once — but
  the profile is shared, so the address is served from the memory cache the
  open tab already filled and there is no second download.
- A tab closed from a sidebar closes in the window that holds it; closing the
  last tab of a window still closes that window.
- Nothing crosses the process boundary. A separate `tbrowser.exe` (a `--no-ui`
  test run keeps a throwaway profile of its own) has its own tabs; sharing
  happens inside one browser at a time.

## Sessions

A session is what a tmux session is: a set of tabs and the windows attached to
it. `Ctrl+N` starts a new one, `Alt+P` lists them, and a window that attaches to
a session another window is already showing sees the same tabs — add a tab or
switch it in one and the other follows.

- **A window is a client.** It is attached to exactly one session; its tabs,
  the focused one and the panes belong to that session, not to the window. Two
  windows on one session show the same tabs, each with its own pages (a page
  lives in one window at a time), so a link opened on one side is on both.
- **`Ctrl+1` … `Ctrl+9`** attach this window to the session in that place of the
  order; **`Alt+1` … `Alt+9`** are the tabs (9 is the last, as in Chrome).
- **`Alt+P`** is the session finder: every session, how many tabs it holds and
  how many windows are attached, whether it survives a quit, and `Enter`
  attaches this window to it. `Ctrl+P` is still the general finder — tabs,
  history, favourites, commands and the web search.
- **Saving is what makes a session survive.** A new session is not saved: it
  lives while the browser does and is gone when the process quits.
  `:session save work` keeps it in `sessions.json` beside `config.json`, and a
  later launch re-joins the saved sessions that had windows on them. Saving an
  existing name replaces its tabs, and a saved session's tabs are written back
  as you change them.
- **Killing ends it.** `:session kill <name>` closes every window attached to
  the session and forgets its saved copy; so does **Kill** in the settings page.
- **Ordering is harpoon's.** `:settings` lists the sessions with arrows that
  move one up or down; that order is what `Ctrl+1`..`Ctrl+9` count through, and
  it is the order the picker shows first.
- **Renaming and attaching** from the settings page: a rename follows the
  session into its windows and keeps its place; a name another session holds is
  refused; **Attach** puts this window on that session.
- **What is stored.** The tab addresses in order, the focused tab and the pane
  tree. Titles and scroll positions are not stored; the pages load again.
- **Grouping is open.** A session is a flat list, so the same site can appear
  in two of them and twice in one.

## Splits

Splits work the way the editor's windows do: a pane is a window, a tab is the
buffer it shows, and the two are separate things. `Alt+S` divides the pane the
keys are in side by side, `Alt+Shift+S` stacks it; splitting again divides the
focused half. `Alt+H`/`Alt+J`/`Alt+K`/`Alt+L` move to the pane that way —
straight ahead beats diagonal, so a move never lands the long way round — and
clicking a page focuses its pane. The command bar, the keys and the sidebar act
on the focused pane, and the sidebar marks it.

Panes are all the same size, the editor's `equalalways`: three side by side are
a third each, never 50, 25 and 25. The panes appear in one step, all at their
final size, so the pages reflow once and no frame is spent moving a divider
across them.

Every split opens **an empty buffer**, as `:new` does: a place to type the next
address, never a second copy of the page you already have on screen. The bar
comes up on it, so the page is one address away.

The two close verbs are the editor's, and they are not the same key:

- **`Ctrl+W`** is `:q`: it closes the pane and leaves the tab loaded, and the
  keys go to the pane that is left. With no split there is nothing to close but
  the window, so `Ctrl+W` closes the window — and its tabs stay as buffers.
- **`Ctrl+Shift+W`** is `:bd`: it closes the tab — the next tab in the list
  takes its place — and the page's address goes to the buffers, unloaded.

- One pane is no split: closing down to it leaves the tab filling the window.
- The arrangement is remembered in `state.json` and in the session, so a
  restored window comes back with its panes; a file from the older two-pane
  browser is read as the split it stood for.
- `:only` closes every other pane and keeps every tab.

## Buffers

A tab is a buffer, so it outlives the window that was showing it, and killing
one closes the tab without losing the page. Two kinds end up in the list, both
under a **buffers** heading in the sidebar and both found by `Ctrl+P`:

- **Loaded.** A window closed while the page was open, and the page is still in
  memory. Picking it puts it back on screen in the frame you asked for it.
- **Not loaded.** A tab was closed with `Ctrl+Shift+W` (or `:bd`). Its address
  is kept and its row is dimmed; picking it loads the page the ordinary way.

`×` on a buffer row, or `:bd` on a loaded one, forgets it for good. Empty tabs
are never kept: a split opens the splash, and a window closing with three
empties leaves nothing behind.

- Sixteen loaded buffers are kept; the oldest goes when the list is full,
  because a page nobody has reached for is memory the browser needs back.
  Not-loaded addresses are cheap, so forty of them are remembered.
- Quitting ends the process, so the loaded pages go with it; the sessions bring
  their addresses back on the next launch.

## New tab

An empty tab is the splash the editor shows on a bare buffer: a sword drawn in
braille patterns — 78 rows of 78 cells, one cell one glyph, so no font can
shear it — over one Matrix quote, picked at random from the same list,
centered in the window in the editor's face and catppuccin blue.

It is sized off the window on both axes, so even the smallest window the
browser opens still fits all of it above the quote. The drawing is still:
nothing moves over the quote while a splash is open.

The bar is up and focused on every launch and every new tab, so the first thing
you type is a search without reaching for a key first.

The page is not built for the tab: one is kept loaded and painted in the
background (`warmTab`), so `Ctrl+T` swaps in a splash that is already on screen
and only picks a new quote. An empty tab you close goes back into that pool.

On Windows 11 22H2 and up the empty tab, the command bar, the sidebar and the
settings page are painted over the window's blurred backdrop. `blur` turns it
off, `blurOpacity` (0–100) says how much of `blurColor` covers the blur, and
the defaults are the terminal's own numbers: the Catppuccin Macchiato base,
`#24273a`, at 37%, the Debian profile's opacity. All of it is in settings
under *Look*.

`blurMaterial` picks the Windows material. `acrylic` (the default) is the
accent brush the Windows Terminal paints: it blurs what is behind the window
and keeps blurring when the window is not in front. It is one call on the
window handle, made through koffi — a prebuilt FFI, so nothing is compiled to
install it — and the pack step fetches koffi's Windows binary for the build.
`mica` is Windows' own DWM material: drawn from the wallpaper, subtler, and
kept for a window that is not in front as well. The tint can only lighten the
material: Windows lays its own wash over the desktop, and no setting removes
that.

## Extensions

Three directories are scanned at startup; each subfolder with a `manifest.json`
is loaded unpacked:

- `extensions/` — next to the app (source checkouts)
- `vendor/` — bundled extensions (Vimium, uBlock Origin, Dark Reader)
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

Vimium's `H` and `L` ask the browser for the step rather than calling
`history.go` (`ui/page-preload.js` carries the one event between the page's
world and the window), because Electron has no back-forward cache: the page's
own history step reloads. The window keeps the page the tab just left loaded
beside it, so the step back onto it is a view swap — no load, no network, and
the same for `Alt+Left` / `Alt+Right`. One page is kept, for the tab on screen.

Scrolling (`j`, `k`, `d`, `u`, `gg`, `G`) runs at one speed for the first 60% of
the distance and then decelerates into the destination. Upstream Vimium's plain
animation stops dead at the end, and Chromium's own smooth scroll answers a key
late enough to feel laggy; the fork keeps the first frame at the old speed, so
the key is answered at once, and spends the rest of the scroll easing off.
Vimium's `smoothScroll` setting still turns the animation off.

One collision is left by design: a key bound in `config.json` is taken before
the page sees it, so a Vimium mapping on the same key never fires. `Ctrl+P` is
the browser's search key and therefore shadows Vimium's `<c-p>`; rebind either
side in `:settings` if you want Vimium to have it.

Vimium C crashes the same way (`chrome.windows.onFocusChanged`); if you want it,
apply the same shim to its manifest's `background.service_worker`.

### Dark Reader

`vendor/dark-reader` is Dark Reader 4.9.134 with a small shim
(`background/tbrowser-compat.js`) loaded as its service worker. Electron's
`chrome.extension` has no `isAllowedFileSchemeAccess`, and Dark Reader's settings
payload waits on that callback, so its popup sat on "Loading, please wait"
forever and the extension could not be configured. The shim answers it (`false`,
because Electron gives extensions no access to `file://` URLs) and then loads
the real worker.

Pages are restyled as they load — `http(s)` pages only, for the same file-access
reason. The extension's card in `:extensions` has its **Settings** button, which
opens the on/off switch, site list, brightness and filter mode in a tab. Dark
Reader's own keyboard shortcuts come from `chrome.commands`, which Electron does
not implement, so they do not fire.

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
  usable in about a tenth of a second. Every window keeps its own tabs and its
  own bounds; closing one leaves the others alone, and closing the last still
  parks the process.
- A restored tab is a record, not a renderer: its view is created the first
  time you switch to it, so ten saved tabs start one renderer, not ten.
- A favourite can be kept ready: `:settings` lists them, and each one switched
  on, stays loaded in the background, so opening it is a view swap rather than
  a load, from a new tab or from any page. A page opened this way keeps the
  page it replaced as its back step, so Back still reaches it without a reload.
  Pages start one at a time after the window is up, a favourite already
  open in a tab is not loaded a second time, and taking one starts its
  replacement off the keystroke. The switch above the list, or `"preload":
  false`, turns the whole thing off; no preloaded renderer outlives the last
  window.
- The bar, the sidebar and the panel outlive the window they are shown in. A
  reopened window gets the already-painted chrome back, so it is complete
  about 130 ms after it appears instead of waiting for three renderers.
- The panel is warmed in the background after the window is up, so the first
  `:extensions` is instant.
- `Ctrl+E` puts the sidebar over the page: the page keeps the whole window and
  is never resized by the toggle, and showing the sidebar is one view added,
  with no slide animation stealing frames from the page. A window opens without
  it — a new window and a restored session both start on the whole page — and
  the key is the only thing that brings it out, for that window.
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
- The word the request carries picks the window: `show` focuses the one already
  open, `new` opens another, the way `Ctrl+N` does. `node scripts/show.mjs
  --new` asks for the second over the pipe. A hotkey that should not drag the
  user to a window sitting on another desktop or `GlazeWM` workspace sends
  `new` when no browser window is on the screen in front of them, and `show`
  when one is.
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
- `lib/` — command parsing, keybinding matcher/config, sessions, extensions, adblock
- `ui/` — command-bar page + preload
- `scripts/install-extension.mjs` — CRX/zip unpacker for `extensions/`
- `vendor/vimium` — patched Vimium fork
