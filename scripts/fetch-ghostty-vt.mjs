#!/usr/bin/env node
'use strict';

// Put libghostty-vt's WebAssembly module in vendor/ before the app runs.
//
// The terminal is the library itself: every escape sequence a shell writes,
// parsed and kept as a grid. The module is the release build of a pinned
// version, small enough to ship and portable enough that Windows, Linux and
// macOS run the identical code — which is why the terminal needs no native
// build on any of them.
//
// The file is downloaded once and checked against the checksum the release
// publishes, so a corrupted or substituted download never gets loaded.

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '1.0.1';
const URL_BASE = `https://release.files.ghostty.org/libghostty-vt/${VERSION}`;
const FILE = `ghostty-vt-${VERSION}.wasm`;
const TARGET_DIR = path.join(ROOT, 'vendor', 'libghostty-vt');
const TARGET = path.join(TARGET_DIR, 'ghostty-vt.wasm');

/** GET a URL into a Buffer, following redirects. */
function download(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          download(new URL(response.headers.location, url).toString()).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`GET ${url}: ${response.statusCode}`));
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      })
      .on('error', reject);
  });
}

async function main() {
  if (fs.existsSync(TARGET) && fs.statSync(TARGET).size > 0) {
    console.log(`ghostty-vt: ${path.relative(ROOT, TARGET)} already in place`);
    return;
  }
  console.log(`ghostty-vt: fetching ${FILE}`);
  const bytes = await download(`${URL_BASE}/${FILE}`);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');

  const sums = await download(`${URL_BASE}/SHA256SUMS`);
  const line = sums
    .toString('utf8')
    .split('\n')
    .find((row) => row.trim().endsWith(` ${FILE}`));
  if (!line) throw new Error(`SHA256SUMS has no line for ${FILE}`);
  const expected = line.trim().split(/\s+/)[0];
  if (digest !== expected) throw new Error(`ghostty-vt: checksum mismatch for ${FILE}`);

  fs.mkdirSync(TARGET_DIR, { recursive: true });
  fs.writeFileSync(TARGET, bytes);
  console.log(`ghostty-vt: ${path.relative(ROOT, TARGET)} ready (${(bytes.length / 1024).toFixed(0)} KiB)`);
}

main().catch((err) => {
  console.error(`ghostty-vt: ${err.message}`);
  process.exit(1);
});
