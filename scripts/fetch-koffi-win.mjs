#!/usr/bin/env node
'use strict';

// Put koffi's Windows binary in node_modules before a cross-platform pack.
//
// npm only installs the optional platform package that matches the machine it
// runs on, so a Windows build packed from Linux — the usual case here — would
// carry koffi without the DLL it needs, and the acrylic call would fail at
// launch. The package is small and versioned with koffi itself, so the pack
// step fetches it instead of the install step: a Linux checkout stays free of
// a binary it can never load.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = '@koromix/koffi-win32-x64';
const TARGET = path.join(ROOT, 'node_modules', '@koromix', 'koffi-win32-x64');

/** Read a tar header's name and size out of the 512-byte blocks. */
function listTar(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
    const start = offset + 512;
    entries.push({ name, data: buffer.subarray(start, start + size) });
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function main() {
  const binary = path.join(TARGET, 'win32_x64', 'koffi.node');
  if (fs.existsSync(binary)) {
    console.log(`koffi: ${binary.split(path.sep).slice(-3).join('/')} already in place`);
    return;
  }
  const koffi = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'node_modules', 'koffi', 'package.json'), 'utf8'),
  );
  const spec = `${NAME}@${koffi.version}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koffi-win-'));
  console.log(`koffi: fetching ${spec}`);
  try {
    const tarball = execFileSync('npm', ['pack', spec, '--silent'], { cwd: tmp, encoding: 'utf8' })
      .trim()
      .split('\n')
      .pop();
    const entries = listTar(gunzipSync(fs.readFileSync(path.join(tmp, tarball))));
    fs.mkdirSync(TARGET, { recursive: true });
    for (const entry of entries) {
      const name = entry.name.replace(/^package\//, '');
      if (!name) continue;
      const target = path.join(TARGET, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.data);
    }
    console.log(`koffi: ${TARGET} ready`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
