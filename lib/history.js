'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { trimVisits } = require('./frecency');

const VISITABLE = /^(https?|file):/i;
const MAX_ENTRIES = 5000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  } catch (err) {
    console.warn(`[tbrowser] could not write ${file}: ${err.message}`);
  }
}

/**
 * Visited pages (for frecency-ranked suggestions) and the user's favourites.
 * Both live as JSON in the user-data directory, next to config.json.
 */
class Visits {
  constructor(dir, now = Date.now) {
    this.now = now;
    this.file = path.join(dir, 'history.json');
    this.favFile = path.join(dir, 'favourites.json');
    this.entries = new Map();
    this.favs = new Map();
    this.load();
  }

  load() {
    const stored = readJson(this.file, {});
    for (const [url, entry] of Object.entries(stored ?? {})) {
      if (!VISITABLE.test(url) || !entry || !Array.isArray(entry.visits)) continue;
      const visits = trimVisits(entry.visits, this.now());
      if (visits.length) {
        this.entries.set(url, { url, title: String(entry.title ?? ''), visits });
      }
    }

    const favs = readJson(this.favFile, []);
    if (Array.isArray(favs)) {
      for (const fav of favs) {
        if (!fav || !VISITABLE.test(String(fav.url))) continue;
        this.favs.set(String(fav.url), {
          url: String(fav.url),
          title: String(fav.title ?? ''),
          added: Number(fav.added) || this.now(),
          // A favourite the user asked to keep loaded in the background.
          warm: fav.warm === true,
        });
      }
    }
  }

  save() {
    writeJson(this.file, Object.fromEntries(this.entries));
    writeJson(this.favFile, [...this.favs.values()]);
  }

  record(url, title, now = this.now()) {
    if (!VISITABLE.test(String(url ?? ''))) return;
    const entry = this.entries.get(url) ?? { url, title: '', visits: [] };
    if (title) entry.title = String(title);
    entry.visits = trimVisits([...entry.visits, now], now);
    this.entries.delete(url);
    this.entries.set(url, entry);
    while (this.entries.size > MAX_ENTRIES) {
      this.entries.delete(this.entries.keys().next().value);
    }
    this.save();
  }

  /** Update the title of a page already visited; no visit is counted. */
  retitle(url, title) {
    const entry = this.entries.get(url);
    if (!entry || !title) return;
    entry.title = String(title);
    this.save();
  }

  list() {
    return [...this.entries.values()];
  }

  favourites() {
    return [...this.favs.values()];
  }

  isFavourite(url) {
    return this.favs.has(url);
  }

  /** Which favourites stay loaded in the background — the settings page's list. */
  setWarm(url, warm) {
    const fav = this.favs.get(String(url));
    if (!fav) return false;
    if (Boolean(fav.warm) === Boolean(warm)) return false;
    fav.warm = Boolean(warm);
    this.save();
    return true;
  }

  toggleFavourite(url, title = '', now = this.now()) {
    if (!VISITABLE.test(String(url ?? ''))) return null;
    if (this.favs.delete(url)) {
      this.save();
      return false;
    }
    this.favs.set(url, { url, title: String(title ?? ''), added: now, warm: false });
    this.save();
    return true;
  }
}

module.exports = { Visits, VISITABLE };
