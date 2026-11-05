#!/usr/bin/env node
'use strict';

/**
 * Ask the running browser for a window.
 *
 * Booting Electron to show a window that already exists costs a couple of
 * seconds on Windows. This talks to the resident process over its local
 * control channel instead, so the launch is a pipe write and a very short
 * hop. Exit code 1 means nothing is running: start the app normally then.
 *
 * `--new` asks for a new window instead of the one already open — what a
 * hotkey binds to when it should open a browser beside what the user is doing
 * rather than pull them to a window they cannot see.
 */

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function controlTarget() {
  if (process.platform === 'win32') return '\\\\.\\pipe\\tbrowser-show';
  const configHome =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'tbrowser', 'show.sock');
}

const socket = net.createConnection(controlTarget());
const request = process.argv.includes('--new') ? 'new' : 'show';
const timer = setTimeout(() => {
  socket.destroy();
  process.exit(1);
}, 500);

socket.on('connect', () => {
  socket.end(`${request}\n`);
});

socket.on('data', () => {
  clearTimeout(timer);
  socket.end();
  process.exit(0);
});

socket.on('error', () => {
  clearTimeout(timer);
  process.exit(1);
});
