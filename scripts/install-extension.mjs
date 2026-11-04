#!/usr/bin/env node
'use strict';

// Install an unpacked Chrome extension into ./extensions.
// Accepts a Chrome Web Store URL, a 32-character extension id, a .crx/.zip
// URL, or a local .crx/.zip file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS_DIR = path.join(ROOT, 'extensions');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function usage() {
  console.log(`Usage: node scripts/install-extension.mjs <chrome-store-url | id | .crx/.zip url | local file>

Examples:
  node scripts/install-extension.mjs https://chromewebstore.google.com/detail/vimium-c-all-by-keyboard/hfjbmagddngcpeloejdejnfgbamkjaeg
  node scripts/install-extension.mjs hfjbmagddngcpeloejdejnfgbamkjaeg
  node scripts/install-extension.mjs https://example.com/extension.zip`);
}

function parseSource(arg) {
  if (/^[a-p]{32}$/.test(arg)) return { kind: 'id', id: arg };
  const storeMatch = /(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)\/detail\/([^/?#]+)\/([a-p]{32})/.exec(arg);
  if (storeMatch) return { kind: 'id', id: storeMatch[2], slug: storeMatch[1] };
  if (/^https?:\/\//i.test(arg)) return { kind: 'url', url: arg };
  return { kind: 'file', file: path.resolve(arg) };
}

async function download(url) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchCrx(id) {
  const url =
    'https://clients2.google.com/service/update2/crx?response=redirect' +
    `&prodversion=130.0.0.0&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
  return download(url);
}

function crxToZip(bytes) {
  if (Buffer.from(bytes.subarray(0, 4)).toString('ascii') !== 'Cr24') return bytes;
  const buffer = Buffer.from(bytes);
  const version = buffer.readUInt32LE(4);
  let offset;
  if (version === 3) offset = 12 + buffer.readUInt32LE(8);
  else if (version === 2) offset = 16 + buffer.readUInt32LE(8) + buffer.readUInt32LE(12);
  else throw new Error(`Unsupported CRX version ${version}`);
  return new Uint8Array(buffer.subarray(offset));
}

function safeName(name) {
  if (path.isAbsolute(name) || name.split('/').includes('..')) throw new Error(`Unsafe zip entry: ${name}`);
  return name;
}

function unpack(bytes) {
  return unzipSync(bytes, { filter: (file) => !file.name.endsWith('/') && safeName(file.name) });
}

function readManifest(files) {
  const entry = files['manifest.json'];
  if (!entry) throw new Error('Archive has no manifest.json at its root');
  return JSON.parse(Buffer.from(entry).toString('utf8'));
}

function pickDirName(manifest, source) {
  const name = manifest.short_name || manifest.name || '';
  if (name && !name.startsWith('__MSG_')) {
    return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'extension';
  }
  return source.slug || source.id || 'extension';
}

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === '-h' || arg === '--help') {
    usage();
    process.exit(arg ? 0 : 1);
  }

  const source = parseSource(arg);
  let bytes;
  if (source.kind === 'id') bytes = await fetchCrx(source.id);
  else if (source.kind === 'url') bytes = await download(source.url);
  else bytes = new Uint8Array(fs.readFileSync(source.file));

  const files = unpack(crxToZip(bytes));
  const manifest = readManifest(files);
  const dirName = pickDirName(manifest, source);
  const target = path.join(EXTENSIONS_DIR, dirName);

  fs.rmSync(target, { recursive: true, force: true });
  for (const [name, data] of Object.entries(files)) {
    const destination = path.join(target, safeName(name));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, data);
  }

  console.log(`Installed ${manifest.name ?? dirName} (manifest v${manifest.manifest_version ?? '?'}) -> ${path.relative(ROOT, target)}`);
  console.log('Restart tbrowser to load it.');
}

main().catch((err) => {
  console.error(`Install failed: ${err.message}`);
  process.exit(1);
});
