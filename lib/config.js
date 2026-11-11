'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  searchUrl: 'https://www.google.com/search?q=',
  adblock: true,
  resident: true,
  // Keep the favourites chosen in settings loaded in the background, so
  // opening one is instant. Off, none of them is preloaded.
  preload: true,
  // The desktop blur behind the empty tab and the chrome, the way the Windows
  // Terminal window paints it: acrylic, tinted with `blurColor` at
  // `blurOpacity` percent. The numbers are the terminal's own — the Debian
  // profile's opacity and the Catppuccin Macchiato base its colour scheme
  // uses — so the browser and the terminal look like the same material.
  blur: true,
  blurOpacity: 37,
  blurColor: '#24273a',
  // Which Windows backdrop the window asks for. `acrylic` is the accent brush
  // the Windows Terminal paints: it blurs what is behind the window and it
  // stays blurred when the window loses focus. `mica` is the DWM material,
  // which is drawn from the wallpaper and is much subtler.
  blurMaterial: 'acrylic',
  keybindings: {
    openBar: ['ctrl+l', 'ctrl+k', ':'],
    search: ['ctrl+p'],
    closeBar: ['escape'],
    reload: ['ctrl+r', 'f5'],
    back: ['alt+left'],
    forward: ['alt+right'],
    // The editor's C-o/C-i, with tabs in it: back and forward through every
    // tab and page the keys have visited in this window. Alt+O/Alt+I are the
    // keys an older build bound, kept so the habit still works.
    jumpBack: ['ctrl+o', 'alt+o'],
    jumpForward: ['ctrl+i', 'alt+i'],
    newTab: ['ctrl+t'],
    // The editor's two verbs, kept apart: a pane is a window and a tab is the
    // buffer it shows, so closing a pane leaves the tab in the list the way
    // `:q` leaves the buffer loaded, and killing a tab is `:bd`. The names
    // are new on purpose: a config written before panes bound `closeTab` and
    // `closeWindow` to these keys, and the old values must not shadow them.
    closePane: ['ctrl+w'],
    killTab: ['ctrl+shift+w'],
    nextTab: ['ctrl+tab', 'ctrl+j'],
    prevTab: ['ctrl+shift+tab', 'ctrl+k'],
    nextSuggestion: ['ctrl+j'],
    prevSuggestion: ['ctrl+k'],
    toggleSidebar: ['ctrl+e'],
    // The editor's C-,: the settings page, and the same key puts it away.
    settings: ['ctrl+,'],
    workspaces: ['alt+p'],
    splitVertical: ['alt+s'],
    splitHorizontal: ['alt+shift+s'],
    focusPane: ['alt+h', 'alt+j', 'alt+k', 'alt+l'],
    devtools: ['f12', 'ctrl+shift+i'],
    newWindow: ['ctrl+n'],
    // C-S-w kills the tab now, so closing a window has no key of its own:
    // the browser window is the editor itself, and C-q is how it goes. Bind
    // it in settings when one of several windows has to go alone.
    closeWindow: [],
    quit: ['ctrl+q'],
  },
};

/**
 * Defaults an earlier build shipped. A config holding one of these exactly was
 * never edited by hand — it was copied from the build that wrote it — so the
 * upgrade moves it to what this build binds. A binding the user typed is left
 * alone; only the shipped list is replaced.
 */
const SUPERSEDED = {
  jumpBack: [['alt+o']],
  jumpForward: [['alt+i']],
};

function sameAccelerators(left, right) {
  if (left.length !== right.length) return false;
  return left.every((accelerator, place) => String(accelerator).toLowerCase() === String(right[place]).toLowerCase());
}

function isSupersededDefault(action, accelerators) {
  return (SUPERSEDED[action] ?? []).some((old) => sameAccelerators(old, accelerators));
}

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

/** Parse a binding list once so key events never split strings again. */
function parseAccelerators(accelerators) {
  const list = Array.isArray(accelerators) ? accelerators : [accelerators];
  const parsed = [];
  for (const accelerator of list) {
    try {
      parsed.push(parseAccelerator(accelerator));
    } catch {
      // Invalid bindings are dropped, same as matches() always did.
    }
  }
  return parsed;
}

function matchesParsed(key, input, expected) {
  if (key !== expected.key) return false;
  // Shift only matters for letters and named keys. For punctuation the key
  // itself encodes shift (":" arrives as Shift+; on a US layout).
  const shiftMatters = expected.key.length > 1 || /^[a-z]$/.test(expected.key);
  return (
    Boolean(input.control) === expected.ctrl &&
    Boolean(input.alt) === expected.alt &&
    Boolean(input.meta) === expected.meta &&
    (!shiftMatters || Boolean(input.shift) === expected.shift)
  );
}

function matches(input, accelerators) {
  return matchesAny(input, parseAccelerators(accelerators));
}

function matchesAny(input, parsed) {
  const key = normalizeKey(input.key);
  return parsed.some((expected) => matchesParsed(key, input, expected));
}

/**
 * A binding list as the settings form writes it — `"ctrl+l, ctrl+k"` — turned
 * into the accelerator list the config file stores. An empty row is a valid
 * answer: it unbinds the action, which is how a key another program needs
 * gets freed. An accelerator that does not parse fails the whole row, so a
 * save never silently drops a binding.
 */
function parseBindingText(text) {
  const parts = String(text ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return { ok: true, list: [] };
  for (const part of parts) {
    try {
      parseAccelerator(part);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return { ok: true, list: parts };
}

/** keybindings -> { action: [parsed accelerator, ...] } for the hot path. */
function compileKeybindings(keybindings) {
  const compiled = {};
  for (const [action, accelerators] of Object.entries(keybindings ?? {})) {
    compiled[action] = parseAccelerators(accelerators);
  }
  return compiled;
}

/** A percentage the config may hold as a number or a numeric string. */
function normalizePercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULTS.blurOpacity;
  return Math.min(100, Math.max(0, Math.round(number)));
}

/** A `#rrggbb` colour, or the default when the text is not one. */
function normalizeColor(value) {
  const text = String(value ?? '').trim();
  const hex = /^#?([0-9a-f]{6})$/i.exec(text);
  return hex ? `#${hex[1].toLowerCase()}` : DEFAULTS.blurColor;
}

function normalize(config = {}) {
  const merged = {
    searchUrl: typeof config.searchUrl === 'string' && config.searchUrl ? config.searchUrl : DEFAULTS.searchUrl,
    adblock: typeof config.adblock === 'boolean' ? config.adblock : DEFAULTS.adblock,
    resident: typeof config.resident === 'boolean' ? config.resident : DEFAULTS.resident,
    preload: typeof config.preload === 'boolean' ? config.preload : DEFAULTS.preload,
    blur: typeof config.blur === 'boolean' ? config.blur : DEFAULTS.blur,
    blurOpacity: normalizePercent(config.blurOpacity),
    blurColor: normalizeColor(config.blurColor),
    blurMaterial: config.blurMaterial === 'mica' ? 'mica' : DEFAULTS.blurMaterial,
    keybindings: { ...DEFAULTS.keybindings },
  };
  for (const [action, accelerators] of Object.entries(config.keybindings ?? {})) {
    // An action this build does not know is a leftover from an older one —
    // `closeTab` and `closeWindow` before panes and buffers were separate
    // things. Keeping it would put a key on nothing and hide a binding the
    // new build does have, so it goes with one word of warning.
    if (!(action in DEFAULTS.keybindings)) {
      console.warn(`[tbrowser] ignoring unknown keybinding "${action}"`);
      continue;
    }
    const list = Array.isArray(accelerators) ? accelerators : [accelerators];
    // A list this build's predecessor wrote by default is not a choice: the
    // upgrade hands it the keys this build binds. Everything else is the
    // user's and passes through untouched.
    const upgraded = isSupersededDefault(action, list) ? DEFAULTS.keybindings[action] : list;
    const valid = upgraded.filter((accelerator) => {
      try {
        parseAccelerator(accelerator);
        return true;
      } catch {
        return false;
      }
    });
    if (valid.length !== upgraded.length) {
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

module.exports = {
  DEFAULTS,
  compileKeybindings,
  loadConfig,
  matches,
  matchesAny,
  normalize,
  parseAccelerator,
  parseBindingText,
  normalizeKey,
};
