'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  searchUrl: 'https://duckduckgo.com/?q=',
  adblock: true,
  keybindings: {
    openBar: ['ctrl+l', 'ctrl+k', ':'],
    closeBar: ['escape'],
    reload: ['ctrl+r', 'f5'],
    back: ['alt+left'],
    forward: ['alt+right'],
    newTab: ['ctrl+t'],
    closeTab: ['ctrl+w'],
    nextTab: ['ctrl+tab'],
    prevTab: ['ctrl+shift+tab'],
    toggleSidebar: ['ctrl+e'],
    devtools: ['f12', 'ctrl+shift+i'],
    closeWindow: ['ctrl+shift+w'],
    quit: ['ctrl+q'],
  },
};

const MODIFIERS = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
};

const KEY_ALIASES = {
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  esc: 'escape',
  return: 'enter',
  spacebar: ' ',
  space: ' ',
};

function normalizeKey(key) {
  const lower = String(key).toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

function parseAccelerator(accelerator) {
  const parts = String(accelerator).toLowerCase().split('+');
  const key = normalizeKey(parts.pop());
  if (!key) throw new Error(`Invalid accelerator "${accelerator}"`);

  const result = { key, ctrl: false, alt: false, shift: false, meta: false };
  for (const part of parts) {
    const modifier = MODIFIERS[part];
    if (!modifier) throw new Error(`Unknown modifier "${part}" in "${accelerator}"`);
    result[modifier] = true;
  }
  return result;
}

function matches(input, accelerators) {
  const list = Array.isArray(accelerators) ? accelerators : [accelerators];
  return list.some((accelerator) => {
    let expected;
    try {
      expected = parseAccelerator(accelerator);
    } catch {
      return false;
    }
    const keyMatches = normalizeKey(input.key) === expected.key;
    if (!keyMatches) return false;
    // Shift only matters for letters and named keys. For punctuation the key
    // itself encodes shift (":" arrives as Shift+; on a US layout).
    const shiftMatters = expected.key.length > 1 || /^[a-z]$/.test(expected.key);
    return (
      Boolean(input.control) === expected.ctrl &&
      Boolean(input.alt) === expected.alt &&
      Boolean(input.meta) === expected.meta &&
      (!shiftMatters || Boolean(input.shift) === expected.shift)
    );
  });
}

function normalize(config = {}) {
  const merged = {
    searchUrl: typeof config.searchUrl === 'string' && config.searchUrl ? config.searchUrl : DEFAULTS.searchUrl,
    adblock: typeof config.adblock === 'boolean' ? config.adblock : DEFAULTS.adblock,
    keybindings: { ...DEFAULTS.keybindings },
  };
  for (const [action, accelerators] of Object.entries(config.keybindings ?? {})) {
    const list = Array.isArray(accelerators) ? accelerators : [accelerators];
    const valid = list.filter((accelerator) => {
      try {
        parseAccelerator(accelerator);
        return true;
      } catch {
        return false;
      }
    });
    if (valid.length !== list.length) {
      console.warn(`[tbrowser] ignoring invalid keybinding(s) for "${action}"`);
    }
    if (valid.length) merged.keybindings[action] = valid;
  }
  return merged;
}

function loadConfig(userDataDir) {
  const file = path.join(userDataDir, 'config.json');
  if (!fs.existsSync(file)) {
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(DEFAULTS, null, 2)}\n`);
    } catch (err) {
      console.warn(`[tbrowser] could not create ${file}: ${err.message}`);
    }
    return normalize(DEFAULTS);
  }
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    console.warn(`[tbrowser] ignoring invalid ${file}: ${err.message}`);
    return normalize(DEFAULTS);
  }
}

module.exports = { DEFAULTS, loadConfig, matches, normalize, parseAccelerator, normalizeKey };
