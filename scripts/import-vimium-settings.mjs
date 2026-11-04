#!/usr/bin/env node
'use strict';

// Copy Vimium's synced settings from a Chromium-family profile (Brave, Chrome,
// Edge) into vendor/vimium/tbrowser-settings.json, which the fork seeds into
// chrome.storage.sync on first run.
//
// Requires a LevelDB reader. Install one globally-ish without touching the
// project: `npm install --no-save classic-level` in a scratch directory and run
// this script with NODE_PATH pointing there, or add it as a devDependency.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_ID = process.argv[3] || 'dbepggeogbaibhgnhhndojpepiihcmeb'; // Vimium
const profile =
  process.argv[2] ||
  path.join(os.homedir(), 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default');

async function loadLevel() {
  try {
    return await import('classic-level');
  } catch {
    console.error(
      'classic-level is missing. Run: npm install --no-save classic-level\n' +
        'then: NODE_PATH=$PWD/node_modules node scripts/import-vimium-settings.mjs',
    );
    process.exit(1);
  }
}

async function readDb(dir) {
  if (!fs.existsSync(dir)) return {};
  const { ClassicLevel } = await loadLevel();
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'vimium-db-'));
  fs.cpSync(dir, copy, { recursive: true });
  const db = new ClassicLevel(copy, { createIfMissing: false });
  await db.open();
  const values = {};
  for await (const [key, value] of db.iterator()) {
    const name = (Buffer.isBuffer(key) ? key : Buffer.from(String(key))).toString('utf8');
    const raw = (Buffer.isBuffer(value) ? value : Buffer.from(String(value))).toString('utf8');
    try {
      values[name] = JSON.parse(raw);
    } catch {
      values[name] = raw;
    }
  }
  await db.close();
  fs.rmSync(copy, { recursive: true, force: true });
  return values;
}

const sync = await readDb(path.join(profile, 'Sync Extension Settings', EXTENSION_ID));
const local = await readDb(path.join(profile, 'Local Extension Settings', EXTENSION_ID));
const settings = { ...local, ...sync };

const keys = Object.keys(settings);
if (!keys.length) {
  console.error(`No settings found under ${profile}`);
  process.exit(1);
}

const target = path.join(ROOT, 'vendor', 'vimium', 'tbrowser-settings.json');
fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`Wrote ${keys.length} keys to ${path.relative(ROOT, target)}: ${keys.join(', ')}`);
console.log('Delete the vimium extension storage (or the whole profile) and restart to reseed.');
