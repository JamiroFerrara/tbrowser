'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Load every unpacked extension found in the given directories (one folder per
 * extension, each containing manifest.json). Directories in `skip` are the
 * ones the user turned off in the extensions page and are left unloaded.
 * Failures are logged, never fatal.
 */
async function loadExtensions(ses, dirs, { skip = [], log = console } = {}) {
  const loaded = [];
  const skipped = new Set([].concat(skip).map((dir) => path.resolve(dir)));
  for (const dir of [].concat(dirs)) {
    for (const extensionDir of findExtensions(dir)) {
      if (skipped.has(path.resolve(extensionDir))) continue;
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

/** The extensions page's own bookkeeping: the folders the user switched off. */
function readDisabledExtensions(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data?.disabled)) return [];
    return data.disabled.filter((dir) => typeof dir === 'string').map((dir) => path.resolve(dir));
  } catch {
    return [];
  }
}

function writeDisabledExtensions(file, dirs) {
  const list = [...new Set([].concat(dirs).map((dir) => path.resolve(dir)))];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ disabled: list }, null, 2)}\n`);
  return list;
}

module.exports = { loadExtensions, findExtensions, readDisabledExtensions, writeDisabledExtensions };
