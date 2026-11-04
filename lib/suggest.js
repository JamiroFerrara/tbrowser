'use strict';

const { looksLikeUrl, SCHEME_RE } = require('./commands');
const { frecency } = require('./frecency');

const ICONS = {
  favourite: '★',
  history: '🕘',
  search: '🔍',
  command: '⌘',
};

const COMMANDS = [
  { name: 's', usage: ':s <query>', description: 'search the web for everything after :s' },
  { name: 'extensions', usage: ':extensions', description: 'loaded Chrome extensions' },
  { name: 'settings', usage: ':settings', description: 'edit config.json' },
  { name: 'fav', usage: ':fav', description: 'add or remove this page from favourites' },
];

const MAX_ROWS = 8;
const FAVOURITE_FLOOR = 5;

/** True for text meant to be opened as-is, where suggestions make no sense. */
function isAddress(text) {
  const input = String(text ?? '').trim();
  if (!input) return false;
  const scheme = SCHEME_RE.exec(input);
  if (scheme) {
    const rest = input.slice(scheme[0].length);
    if (/^(https?|file|about)$/i.test(scheme[1]) || /^\d+(\/|$)/.test(rest)) return true;
  }
  return looksLikeUrl(input);
}

/**
 * fzf-ish scoring: an exact substring beats a scattered subsequence, an early
 * match beats a late one, a shorter text beats a longer one. Null means the
 * query's letters do not appear in order.
 */
function fuzzyScore(text, query) {
  const haystack = String(text ?? '').toLowerCase();
  const needle = String(query ?? '').toLowerCase().trim();
  if (!needle) return 0;

  const index = haystack.indexOf(needle);
  if (index !== -1) {
    const startBonus = index === 0 ? 50 : /[\s/._-]/.test(haystack[index - 1]) ? 25 : 0;
    return 100 + startBonus - index - haystack.length / 100;
  }

  let score = 40;
  let from = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, from);
    if (found === -1) return null;
    score -= (found - from) * 0.5;
    from = found + 1;
  }
  return score - haystack.length / 100;
}

function titleOf(url, title) {
  if (title) return title;
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function subtitleOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
}

function searchRow(query, searchUrl) {
  let host = 'web search';
  try {
    host = `via ${new URL(searchUrl).hostname}`;
  } catch {
    // keep the plain label when the configured search URL is unusable
  }
  return {
    kind: 'search',
    icon: ICONS.search,
    title: `Search for “${query}”`,
    subtitle: host,
    value: query,
  };
}

function pageRows({ query, history, favourites, now, limit }) {
  const byUrl = new Map();
  for (const entry of history) {
    byUrl.set(entry.url, {
      url: entry.url,
      title: titleOf(entry.url, entry.title),
      score: frecency(entry.visits ?? [], now),
      kind: 'history',
    });
  }
  for (const fav of favourites) {
    const row = byUrl.get(fav.url) ?? {
      url: fav.url,
      title: titleOf(fav.url, fav.title),
      score: 0,
      kind: 'history',
    };
    row.kind = 'favourite';
    row.score = Math.max(row.score, FAVOURITE_FLOOR);
    byUrl.set(fav.url, row);
  }

  const rows = [];
  for (const row of byUrl.values()) {
    const titleScore = fuzzyScore(row.title, query);
    const urlScore = fuzzyScore(row.url, query);
    if (titleScore === null && urlScore === null) continue;
    const match = Math.max(titleScore ?? -100, urlScore ?? -100);
    rows.push({
      sort: match + row.score * 4,
      item: {
        kind: row.kind,
        icon: ICONS[row.kind],
        title: row.title,
        subtitle: subtitleOf(row.url),
        value: row.url,
      },
    });
  }
  rows.sort((a, b) => b.sort - a.sort || a.item.title.localeCompare(b.item.title));
  return rows.slice(0, limit).map((row) => row.item);
}

function commandRows(query, limit) {
  return COMMANDS.map((command) => {
    const score = fuzzyScore(command.name, query) ?? fuzzyScore(command.usage, query);
    return { score, command };
  })
    .filter((row) => row.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ command }) => ({
      kind: 'command',
      icon: ICONS.command,
      title: command.usage,
      subtitle: command.description,
      value: command.name === 's' ? ':s ' : `:${command.name}`,
    }));
}

/**
 * Rows for the dropdown under the command bar.
 * `:s <query>` and bare text both search; a bare address has no dropdown.
 */
function suggestions(text, { history = [], favourites = [], searchUrl, now = Date.now(), limit = MAX_ROWS } = {}) {
  const input = String(text ?? '').trim();
  if (isAddress(input)) return [];

  const search = /^:s(?:\s+(.*))?$/.exec(input);
  if (search) {
    const query = (search[1] ?? '').trim();
    if (isAddress(query)) return [];
    const rows = pageRows({ query, history, favourites, now, limit: query ? limit - 1 : limit });
    return query ? [searchRow(query, searchUrl), ...rows] : rows;
  }

  if (input.startsWith(':')) return commandRows(input.slice(1).trim());

  const rows = pageRows({ query: input, history, favourites, now, limit: input ? limit - 1 : limit });
  return input ? [searchRow(input, searchUrl), ...rows] : rows;
}

module.exports = { suggestions, fuzzyScore, isAddress, ICONS, COMMANDS, MAX_ROWS };
