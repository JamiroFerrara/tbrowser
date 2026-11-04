'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Load every unpacked extension found in the given directories (one folder per
 * extension, each containing manifest.json). Failures are logged, never fatal.
 */
async function loadExtensions(ses, dirs, log = console) {
  const loaded = [];
  for (const dir of [].concat(dirs)) {
    for (const extensionDir of findExtensions(dir)) {
      try {
        const extension = await ses.extensions.loadExtension(extensionDir);
        loaded.push(extension);
        log.info(`[tbrowser] extension loaded: ${extension.name ?? path.basename(extensionDir)} ${extension.version ?? ''}`.trim());
      } catch (err) {
        log.error(`[tbrowser] extension failed (${path.basename(extensionDir)}): ${err.message}`);
      }
    }
  }
  return loaded;
}

function findExtensions(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
    .map((entry) => path.join(dir, entry.name))
    .filter((extensionDir) => fs.existsSync(path.join(extensionDir, 'manifest.json')));
}

module.exports = { loadExtensions, findExtensions };
