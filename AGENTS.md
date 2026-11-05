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

## The two standing rules

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

## Verification

- `npm test` runs the command-parsing and config/keybinding suites. It does not
  cover Electron runtime behaviour.
- Anything touching `main.js`, the views or extension loading needs the app
  actually started and the changed surface exercised before the work is called
  done.
- `--no-ui` is how to start it while the user keeps working: the window is
  built and kept off screen, and the run uses a throwaway profile, so a check
  takes no focus and leaves their tabs alone. Use a visible launch only when
  the change is what you have to see.
  `dist/tbrowser-win32-x64/tbrowser.exe --no-ui`
- Report what was run. Never describe a check as passing when it was not run,
  and never claim a visual or interactive behaviour was validated when only
  unit tests ran.
