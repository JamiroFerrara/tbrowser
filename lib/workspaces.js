'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE = 'workspaces.json';
const MAX_NAME = 40;
const MAX_TABS = 200;
const URL_RE = /^(https?|file|about):/i;
// Where a window's tabs go when it switches to a workspace without ever
// having been saved itself: one rolling slot, so the switch is always
// reversible with the same key.
const LAST = 'last session';

/** A typed name, or '' when nothing usable is left. */
function normalizeName(raw) {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

/** A name for `:ws save` with no argument: the page you are on. */
function autoName(tabs, activeTab = 0, taken = []) {
  const urls = Array.isArray(tabs) ? tabs : [];
  const url = urls[activeTab] ?? urls[0] ?? '';
  let name = '';
  try {
    name = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // the home page and about:blank have no host worth naming
  }
  if (!name) name = 'session';
  const used = new Set(taken.map((entry) => String(entry).toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${name} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${name} ${Date.now()}`;
}

function cleanTabs(tabs) {
  if (!Array.isArray(tabs)) return [];
  return tabs.filter((url) => typeof url === 'string' && URL_RE.test(url)).slice(0, MAX_TABS);
}

function cleanSplit(split, length) {
  if (!split || typeof split !== 'object') return null;
  const a = Number(split.a);
  const b = Number(split.b);
  const orientation = split.orientation === 'horizontal' ? 'horizontal' : 'vertical';
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  if (a === b || a < 0 || b < 0 || a >= length || b >= length) return null;
  return { a, b, orientation };
}

/**
 * The named tab sets. A workspace is what a tmux session is: a thing you
 * switch to, that keeps its contents, and that you save again when you have
 * changed it. Stored beside config.json so a checkout and a packed install
 * share nothing but the user's own data.
 */
class Workspaces {
  constructor(dir) {
    this.file = path.join(dir, FILE);
    this.entries = this.read();
  }

  read() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const list = Array.isArray(saved) ? saved : saved?.workspaces;
      if (!Array.isArray(list)) return [];
      return list
        .filter((entry) => entry && normalizeName(entry.name))
        .map((entry) => ({
          name: normalizeName(entry.name),
          tabs: cleanTabs(entry.tabs),
          activeTab: Number.isInteger(entry.activeTab) ? entry.activeTab : 0,
          split: cleanSplit(entry.split, entry.tabs?.length ?? 0),
          created: Number.isFinite(entry.created) ? entry.created : Date.now(),
          savedAt: Number.isFinite(entry.savedAt) ? entry.savedAt : Date.now(),
        }));
    } catch {
      return [];
    }
  }

  write() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify({ version: 1, workspaces: this.entries }, null, 2)}\n`);
      return true;
    } catch (err) {
      console.warn(`[tbrowser] could not save workspaces: ${err.message}`);
      return false;
    }
  }

  list() {
    return this.entries.map((entry) => ({ ...entry }));
  }

  get(name) {
    const wanted = normalizeName(name).toLowerCase();
    const entry = this.entries.find((item) => item.name.toLowerCase() === wanted);
    return entry ? { ...entry } : null;
  }

  save(name, { tabs, activeTab = 0, split = null } = {}) {
    const clean = normalizeName(name);
    if (!clean) return null;
    const urls = cleanTabs(tabs);
    const index = this.entries.findIndex((entry) => entry.name.toLowerCase() === clean.toLowerCase());
    const now = Date.now();
    const entry = {
      name: this.entries[index]?.name ?? clean,
      tabs: urls,
      activeTab: Number.isInteger(activeTab) && urls[activeTab] ? activeTab : 0,
      split: cleanSplit(split, urls.length),
      created: this.entries[index]?.created ?? now,
      savedAt: now,
    };
    if (index === -1) this.entries.push(entry);
    else this.entries[index] = entry;
    this.write();
    return { ...entry };
  }

  remove(name) {
    const wanted = normalizeName(name).toLowerCase();
    const index = this.entries.findIndex((entry) => entry.name.toLowerCase() === wanted);
    if (index === -1) return false;
    this.entries.splice(index, 1);
    this.write();
    return true;
  }
}

module.exports = { Workspaces, normalizeName, autoName, LAST, FILE, MAX_NAME };
