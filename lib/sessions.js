'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE = 'sessions.json';
// The file this one replaced: a saved tab set was a "workspace". They are the
// same thing under the name the browser uses now, so they are read as sessions
// and written back under the new file the first time anything is saved.
const LEGACY = 'workspaces.json';
const MAX_NAME = 40;
const MAX_TABS = 200;
const URL_RE = /^(https?|file|about):/i;

/** A typed name, or '' when nothing usable is left. */
function normalizeName(raw) {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

/** A name for a session saved with no argument: the page you are on. */
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

/**
 * A saved pane tree, kept only where every leaf is a tab the list really has.
 * `spots` collects the tab places already taken, so a tab cannot be shown in
 * two panes at once — the browser's panes are views of one renderer each, and
 * a file that says otherwise is not worth trusting.
 */
function cleanPanes(node, length, depth = 0, spots = new Set()) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node.children)) {
    if (node.children.length !== 2) return null;
    const orientation = node.orientation === 'horizontal' ? 'horizontal' : 'vertical';
    const children = node.children.map((child) => cleanPanes(child, length, depth + 1, spots));
    if (children.some((child) => !child)) return null;
    return { orientation, children };
  }
  const tab = Number(node.tab);
  if (!Number.isInteger(tab) || tab < 0 || tab >= length || spots.has(tab)) return null;
  spots.add(tab);
  return { tab };
}

/** The two-pane shape older files hold, read as the tree it stood for. */
function panesFromSplit(split, length) {
  if (!split || typeof split !== 'object') return null;
  const a = Number(split.a);
  const b = Number(split.b);
  const orientation = split.orientation === 'horizontal' ? 'horizontal' : 'vertical';
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  if (a === b || a < 0 || b < 0 || a >= length || b >= length) return null;
  return cleanPanes({ orientation, children: [{ tab: a }, { tab: b }] }, length);
}

/** A saved layout, from either shape the file has ever used. */
function cleanLayout(entry, length) {
  return cleanPanes(entry?.panes, length) ?? panesFromSplit(entry?.split, length);
}

/**
 * The sessions that survive a quit: what a tmux session is, saved to come back
 * to. A live session exists while the browser runs; saving one writes it here,
 * and this is the list the picker offers to attach to on a later launch.
 *
 * The order of the list is the order the sessions jump in (`Ctrl+1`..`Ctrl+9`),
 * so moving a row is the only thing the settings page's arrows change.
 */
class Sessions {
  constructor(dir) {
    this.file = path.join(dir, FILE);
    this.legacy = path.join(dir, LEGACY);
    this.entries = this.read();
  }

  read() {
    for (const file of [this.file, this.legacy]) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        const list = Array.isArray(saved) ? saved : (saved?.sessions ?? saved?.workspaces);
        if (!Array.isArray(list)) continue;
        return list
          .filter((entry) => entry && normalizeName(entry.name))
          .map((entry) => ({
            name: normalizeName(entry.name),
            tabs: cleanTabs(entry.tabs),
            activeTab: Number.isInteger(entry.activeTab) ? entry.activeTab : 0,
            panes: cleanLayout(entry, entry.tabs?.length ?? 0),
            created: Number.isFinite(entry.created) ? entry.created : Date.now(),
            savedAt: Number.isFinite(entry.savedAt) ? entry.savedAt : Date.now(),
          }));
      } catch {
        // no such file, or a half-written one: the next one is tried
      }
    }
    return [];
  }

  write() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify({ version: 2, sessions: this.entries }, null, 2)}\n`);
      return true;
    } catch (err) {
      console.warn(`[tbrowser] could not save sessions: ${err.message}`);
      return false;
    }
  }

  /** The saved sessions, in the order they jump. */
  list() {
    return this.entries.map((entry, index) => ({ ...entry, order: index + 1 }));
  }

  get(name) {
    const wanted = normalizeName(name).toLowerCase();
    const index = this.entries.findIndex((item) => item.name.toLowerCase() === wanted);
    return index === -1 ? null : { ...this.entries[index], order: index + 1 };
  }

  save(name, { tabs, activeTab = 0, panes = null } = {}) {
    const clean = normalizeName(name);
    if (!clean) return null;
    const urls = cleanTabs(tabs);
    const index = this.entries.findIndex((entry) => entry.name.toLowerCase() === clean.toLowerCase());
    const now = Date.now();
    const entry = {
      name: this.entries[index]?.name ?? clean,
      tabs: urls,
      activeTab: Number.isInteger(activeTab) && urls[activeTab] ? activeTab : 0,
      panes: cleanPanes(panes, urls.length),
      created: this.entries[index]?.created ?? now,
      savedAt: now,
    };
    if (index === -1) this.entries.push(entry);
    else this.entries[index] = entry;
    this.write();
    return { ...entry, order: this.entries.indexOf(entry) + 1 };
  }

  /**
   * Change a saved session's name in place: its tabs, its panes and the place
   * it jumps from stay where they are, only the label moves. A name another
   * session already holds is refused.
   */
  rename(name, next) {
    const wanted = normalizeName(name).toLowerCase();
    const clean = normalizeName(next);
    if (!clean) return null;
    const index = this.entries.findIndex((entry) => entry.name.toLowerCase() === wanted);
    if (index === -1) return null;
    const clash = this.entries.some(
      (entry, at) => at !== index && entry.name.toLowerCase() === clean.toLowerCase(),
    );
    if (clash) return null;
    this.entries[index] = { ...this.entries[index], name: clean };
    this.write();
    return { ...this.entries[index], order: index + 1 };
  }

  remove(name) {
    const wanted = normalizeName(name).toLowerCase();
    const index = this.entries.findIndex((entry) => entry.name.toLowerCase() === wanted);
    if (index === -1) return false;
    this.entries.splice(index, 1);
    this.write();
    return true;
  }

  /**
   * Move a saved session one place up or down the jump order. The ends are not
   * errors: the first row cannot go up, and saying so would be noise.
   */
  move(name, delta) {
    const wanted = normalizeName(name).toLowerCase();
    const from = this.entries.findIndex((entry) => entry.name.toLowerCase() === wanted);
    if (from === -1) return false;
    const to = from + (delta < 0 ? -1 : 1);
    if (to < 0 || to >= this.entries.length) return false;
    const [entry] = this.entries.splice(from, 1);
    this.entries.splice(to, 0, entry);
    this.write();
    return true;
  }
}

module.exports = { Sessions, normalizeName, autoName, cleanPanes, cleanLayout, FILE, LEGACY, MAX_NAME };
