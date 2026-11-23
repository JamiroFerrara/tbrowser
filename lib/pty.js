'use strict';

/**
 * A shell in a pseudo console, from the main process's side.
 *
 * The console is ConPTY, made and pumped by `node-pty`: this class is the
 * handle the window holds — write to the shell, resize it, close it — and the
 * callbacks its output arrives through. Nothing here can block.
 *
 * `node-pty` is loaded on demand: a build without its native prebuilds still
 * starts the browser, it just has no terminal, and `available()` says so.
 */

const path = require('node:path');

let native = null;
let loadError = null;

function load() {
  if (native) return native;
  if (loadError) throw loadError;
  try {
    // Inside a packaged app, node-pty must load from `app.asar.unpacked`: it
    // starts its ConPTY drain as a worker thread, and a worker entry inside
    // the archive cannot be started. Its own path tweak only knows the older
    // `node_modules.asar` layout, so the unpacked tree is named here.
    const inArchive = __dirname.includes(`${path.sep}app.asar${path.sep}`);
    const base = inArchive ? __dirname.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`) : __dirname;
    native = require(path.join(base, '..', 'node_modules', 'node-pty'));
    return native;
  } catch (err) {
    loadError = err;
    throw err;
  }
}

class Pty {
  constructor({ cols, rows, command = 'wsl.exe', args = [], cwd = null, onData, onExit, onError = null }) {
    this.cols = Math.max(1, Math.floor(Number(cols) || 80));
    this.rows = Math.max(1, Math.floor(Number(rows) || 24));
    this.command = command;
    this.cwd = cwd;
    this.onData = onData;
    this.onExit = onExit;
    this.onError = onError;
    this.closed = false;
    this.killed = false;
    this.ended = false;
    this.ready = false;
    this.wrote = false; // whether the shell ever said anything

    if (process.platform !== 'win32') {
      const message = 'the terminal needs Windows';
      this.closed = true;
      this.onError?.(message);
      throw new Error(message);
    }

    let pty;
    try {
      pty = load();
    } catch (err) {
      const message = `the terminal needs node-pty: ${err.message}`;
      this.closed = true;
      this.onError?.(message);
      throw new Error(message, { cause: err });
    }

    try {
      // The shell's home is the user's home, not whatever directory the
      // browser happened to be started from: a shortcut launched off a UNC
      // path would otherwise fail to start anything at all.
      this.pty = pty.spawn(command, Array.isArray(args) ? args : [], {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: cwd ?? process.env.USERPROFILE ?? process.cwd(),
        useConpty: true,
      });
    } catch (err) {
      const message = `the shell could not start: ${err.message}`;
      this.closed = true;
      this.onError?.(message);
      throw new Error(message, { cause: err });
    }

    this.pty.on('error', (err) => this.fail(`the shell failed: ${err.message}`));
    this.pty.onData((data) => {
      if (this.closed) return;
      this.ready = true;
      this.wrote = true;
      this.onData?.(Buffer.from(data, 'utf8'));
    });
    this.pty.onExit(({ exitCode }) => this.exit(exitCode));
  }

  /** The shell broke after it started. */
  fail(message) {
    if (this.closed) return;
    this.closed = true;
    this.ended = true;
    this.onError?.(message);
  }

  exit(code = 0) {
    if (this.closed) return;
    this.closed = true;
    this.ended = true;
    this.onExit?.(Number(code) >>> 0);
  }

  /** Send bytes to the shell: a keystroke, a paste, a mouse report. */
  write(bytes) {
    if (this.closed) return;
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (!data.length) return;
    this.pty.write(data.toString('utf8'));
  }

  resize(cols, rows) {
    if (this.closed) return;
    const nextCols = Math.max(1, Math.floor(Number(cols) || 0));
    const nextRows = Math.max(1, Math.floor(Number(rows) || 0));
    if (nextCols === this.cols && nextRows === this.rows) return;
    this.cols = nextCols;
    this.rows = nextRows;
    this.pty.resize(nextCols, nextRows);
  }

  /** Close the console and kill the shell. */
  kill() {
    if (this.killed) return;
    this.killed = true;
    this.closed = true;
    if (this.ended) return;
    this.ended = true;
    try {
      this.pty.kill();
    } catch {
      // the console is already gone with the shell
    }
  }
}

/** Whether a real pseudo console can be made on this machine at all. */
function available() {
  if (process.platform !== 'win32') return false;
  try {
    load();
    return true;
  } catch {
    return false;
  }
}

module.exports = { Pty, available };
