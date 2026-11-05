# Agent guide — tbrowser

A minimal Chromium browser built on Electron: real Chrome extensions,
DevTools, a vim-style command bar, as little bloat as it can get away with.
Windows is the primary target; it also runs on Linux and macOS. `README.md`
is the user-facing description — this file is how to change the thing.

## Layout

- `main.js` — windows (each a `Browser` with its own tabs and views), command
  bar, panel, sidebar, key routing, state
- `lib/` — `commands.js` (input parsing), `config.js` (config + keybinding matcher),
  `extensions.js` (unpacked extension loading), `adblock.js`
- `ui/` — command bar, panel and sidebar pages plus their preload scripts
- `scripts/` — extension installer, Vimium settings importer
- `vendor/vimium` — patched Vimium 2.4.2 (see README)
- `test/` — `node --test` suites

## The four standing rules

**1. Every change is installed in the system, not just written.**

Work is not finished when the file is saved in the checkout. It is finished
when the copy that actually runs carries the change:

```bash
npm install          # new or changed dependencies
npm test             # the suites must stay green
npm run pack:win     # rewrites dist/tbrowser-win32-x64/ with the new code
```

`npm run pack:win` is the install step: it rebuilds the Windows build in
`dist/tbrowser-win32-x64/` (git-ignored), and that directory is the installed
app the user launches. A change that exists only in the source tree is
invisible to them.

Close the app before packing. Windows locks `tbrowser.exe` and the DLLs it
loaded, so `npm run pack:win` dies with `EIO: i/o error, unlink
'dist/tbrowser-win32-x64/<dll>'` while the browser runs, and an answer to a
`taskkill` that says the process was not found means the user closed it
already, not that the pack may skip. If it is running and blocks the pack,
kill it — no question asked, its tabs come back:

```bash
taskkill /IM tbrowser.exe /F
npm run pack:win
dist/tbrowser-win32-x64/tbrowser.exe    # relaunch on the tabs state.json holds
```

**2. Every change is committed and pushed. Never leave the tree dirty.**

After a coherent change — and always before handing work back — commit and
push to GitHub (`JamiroFerrara/tbrowser`):

```bash
git add -A
git commit -m "<imperative subject>"
git push origin main
```

- One commit per logical change, not one per file and not one dumping
  everything at the end of a session.
- Subject: imperative, lowercase, no trailing period, 50 characters or fewer.
  Detail goes in the body, wrapped at 72.
- Never commit `node_modules/` or `dist/`; `extensions/` holds downloaded
  extensions and is ignored too.
- Never force-push and never rewrite pushed history.

**3. Never put a window on the user's desktop to test.**

Several agents work this repo at once, and every window a check opens is one
the user did not ask for, stealing the focus from whatever they are doing. A
test launch is `--no-ui`:

```bash
dist/tbrowser-win32-x64/tbrowser.exe --no-ui
```

The window is built exactly as a normal launch builds it and never shown, so
the session, the extensions, the ad blocker and the page all still run. The
run also keeps its own throwaway profile and skips the single-instance lock,
so any number of them run beside the user's browser without touching their
tabs, visits or cookies, and a killed one leaves nothing behind that the next
start does not sweep.

Start a visible instance only when what you have to check *is* the window —
and close it as soon as you have looked:

```bash
taskkill /IM tbrowser.exe /F
```

**4. Speed is the feature: a keystroke is on screen before it is felt.**

The product is the gap between the key and the result — a new tab, a new
window, a page you have already been to, a character typed in the command bar.
Every one of those is a path that must not start a renderer, touch the network
or walk the disk.

- Chrome and the empty tab come from pools of running renderers: `warmChrome`
  keeps a spare bar and sidebar, `warmTab` a spare new-tab page. A path *takes*
  a pooled view; the pool refills itself afterwards, off the keystroke.
- Work a keystroke triggers either is already warm or goes out of the way —
  `setImmediate`, a background load, a promise nobody on screen awaits.
- Decoration — the splash quote, a thumbnail, a badge — renders from a pooled
  page and is redrawn there (see `rollQuote`), never reloaded.
- Measure the path you touched, with the trace that already exists:

```bash
TBROWSER_TIMING=1 dist/tbrowser-win32-x64/tbrowser.exe --no-ui
# per-step marks land in <userData>/startup.log
```

`window shown`, `page created`, `tab reused`, `tab dom-ready`, `tab painted`
say where the milliseconds go. A change that adds a step between the key and
the screen owes the marks it moved, in the hand-off, as numbers.

## Verification

- `npm test` runs the command-parsing and config/keybinding suites. It does not
  cover Electron runtime behaviour.
- Anything touching `main.js`, the views or extension loading needs the app
  actually started and the changed surface exercised before the work is called
  done.
- Start it with `--no-ui` (rule 3), not with a window on the user's screen.
- Report what was run. Never describe a check as passing when it was not run,
  and never claim a visual or interactive behaviour was validated when only
  unit tests ran.
- A speed claim carries its marks from `startup.log` beside it (rule 4); a
  number with no trace behind it was guessed.
