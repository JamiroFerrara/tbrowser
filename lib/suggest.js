'use strict';

const { looksLikeUrl, SCHEME_RE } = require('./commands');
const { frecency } = require('./frecency');

const ICONS = {
  favourite: '★',
  history: '🕘',
  search: '🔍',
  command: '⌘',
  tab: '🗂',
  workspace: '🗃',
};

const COMMANDS = [
  { name: 's', usage: ':s <query>', description: 'search the web for everything after :s' },
  { name: 'extensions', usage: ':extensions', description: 'loaded Chrome extensions' },
  { name: 'settings', usage: ':settings', description: 'edit config.json' },
  { name: 'fav', usage: ':fav', description: 'add or remove this page from favourites' },
  { name: 'ws', usage: ':ws save <name>', description: 'save, open or delete a workspace' },
];

const MAX_ROWS = 8;
// A favourite nobody has opened yet still ranks like a page opened twice.
const FAVOURITE_FLOOR = 5;

// fff.nvim's blend: the match decides the score, and the visit history tilts it
// by up to a fifth, so a page used every day overtakes one that barely matches
// but never wins against a name that matches much better. Decay and the log cap
// that keep that "up to a fifth" a fact live in `frecency.js`.
const MATCH_POINTS = 100;
// A tier is worth this many points on top of the blend. Favourites are the user
// saying a page matters, tabs are the pages in front of them now, history is
// the rest — a tab that is opened very often (a fifth of a strong match) still
// climbs over a favourite nobody visits.
const TIER_BONUS = { favourite: 50, tab: 25, history: 0 };

/** A row's place in the list: fff's frecency blend plus its tier. */
function rankScore(match, tier, frecency) {
  const points = Math.max(0, MATCH_POINTS + match);
  return points * (1 + frecency / 100) + (TIER_BONUS[tier] ?? 0);
}

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

function pageRows({ query, history, favourites, now, exclude = new Set() }) {
  const byUrl = new Map();
  for (const entry of history) {
    if (exclude.has(entry.url)) continue;
    byUrl.set(entry.url, {
      url: entry.url,
      title: titleOf(entry.url, entry.title),
      score: frecency(entry.visits ?? [], now),
      kind: 'history',
    });
  }
  for (const fav of favourites) {
    if (exclude.has(fav.url)) continue;
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
      sort: rankScore(match, row.kind, row.score),
      item: {
        kind: row.kind,
        icon: ICONS[row.kind],
        title: row.title,
        subtitle: subtitleOf(row.url),
        value: row.url,
      },
    });
  }
  return rows;
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
 * The tabs already open in any window, which are the browser's files. An empty
 * field keeps this window's tabs first, its focused one on top, then the other
 * windows'; typing ranks them all by the same fuzzy match as pages, so `git`
 * reaches the GitHub tab before the history. A tab carries the visit history of
 * the page it shows, so a page opened all day keeps outranking the rest.
 */
function tabRows(query, tabs, { favouriteUrls = new Set(), visitScores = new Map() } = {}) {
  const open = Array.isArray(tabs) ? tabs : [];
  // `here` is absent on a list from one window: every tab in it is here.
  const home = (tab) => tab.here !== false;
  const ordered = open
    .filter((tab) => tab.active && home(tab))
    .concat(open.filter((tab) => !(tab.active && home(tab))));
  const rows = [];
  for (const tab of ordered) {
    const url = String(tab.url ?? '');
    const title = titleOf(url, tab.title);
    const titleScore = fuzzyScore(title, query);
    const urlScore = fuzzyScore(url, query);
    if (query && titleScore === null && urlScore === null) continue;
    const where = home(tab) ? '' : `window ${tab.slot} · `;
    const tier = favouriteUrls.has(url) ? 'favourite' : 'tab';
    rows.push({
      sort: rankScore(
        query ? Math.max(titleScore ?? -100, urlScore ?? -100) : 0,
        tier,
        visitScores.get(url) ?? 0,
      ),
      item: {
        kind: 'tab',
        icon: ICONS.tab,
        title,
        subtitle: `${where}${tab.active && home(tab) ? 'current tab' : subtitleOf(url)}`,
        value: `:tab ${tab.id}`,
      },
    });
  }
  return rows;
}

/** The saved tab sets, for the picker Alt+P opens. */
function workspaceRows(query, workspaces, limit) {
  const list = Array.isArray(workspaces) ? workspaces : [];
  const rows = [];
  for (const workspace of list) {
    const name = String(workspace.name ?? '');
    const tabs = Array.isArray(workspace.tabs) ? workspace.tabs : [];
    const score = fuzzyScore(name, query) ?? (query ? fuzzyScore(tabs.join(' '), query) : 0);
    if (query && score === null) continue;
    const first = tabs[workspace.activeTab] ?? tabs[0] ?? '';
    rows.push({
      score: score ?? 0,
      item: {
        kind: 'workspace',
        icon: ICONS.workspace,
        title: name,
        subtitle: `${tabs.length} tab${tabs.length === 1 ? '' : 's'}${first ? ` · ${subtitleOf(first)}` : ''}`,
        value: `:ws open ${name}`,
      },
    });
  }
  rows.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
  const items = rows.slice(0, query ? limit - 1 : limit).map((row) => row.item);
  // With nothing typed there is no "open this text" meaning, so the picker
  // ends with the way to keep what the window shows now.
  if (!query) {
    items.push({
      kind: 'workspace',
      icon: '＋',
      title: 'Save this session',
      subtitle: 'keep the tabs in this window under a name',
      value: ':ws save',
    });
  }
  return items;
}

/**
 * The pages a query matches, with the web search as the last row so it catches
 * everything the history and favourites do not — the way Chrome's address bar
 * preselects the most likely page and still offers the search underneath it.
 * Favourites, open tabs and history are one list ranked by `rankScore`, so a
 * favourite is the first row and a page opened all day can still climb over
 * one; an open tab's page is not listed twice.
 */
function lookupRows(query, { history, favourites, now, searchUrl, limit, tabs = [] }) {
  if (isAddress(query)) return [];
  const visits = Array.isArray(history) ? history : [];
  const favs = Array.isArray(favourites) ? favourites : [];
  const open = Array.isArray(tabs) ? tabs : [];
  const visitScores = new Map(
    visits.map((entry) => [entry.url, frecency(entry.visits ?? [], now)]),
  );
  const openUrls = new Set(open.map((tab) => tab.url).filter(Boolean));
  const rows = [
    ...tabRows(query, open, {
      favouriteUrls: new Set(favs.map((fav) => fav.url)),
      visitScores,
    }),
    ...pageRows({
      query,
      history: visits,
      favourites: favs,
      now,
      exclude: openUrls,
    }),
  ];
  // A stable sort keeps tabs in their own order (the focused one first) when
  // nothing is typed and every row scores the same.
  rows.sort((a, b) => b.sort - a.sort);
  const items = rows.slice(0, limit).map((row) => row.item);
  if (!query) return items;
  return [...items.slice(0, limit - 1), searchRow(query, searchUrl)];
}

/**
 * Rows for the dropdown under the command bar.
 * A leading `:` makes the text a command first and a search when no command
 * matches; bare text is the same lookup without that first stop. The workspace
 * mode is the picker Alt+P opens: only saved tab sets, and nothing is opened
 * as a page.
 */
function suggestions(
  text,
  {
    history = [],
    favourites = [],
    searchUrl,
    tabs = [],
    workspaces = [],
    mode = 'address',
    now = Date.now(),
    limit = MAX_ROWS,
  } = {},
) {
  const input = String(text ?? '').trim();
  if (mode === 'workspace') return workspaceRows(input, workspaces, limit);
  if (!input.startsWith(':') && isAddress(input)) return [];

  const body = input.startsWith(':') ? input.slice(1).trim() : input;
  if (isAddress(body)) return [];

  const search = /^s(?:\s+(.*))?$/.exec(body);
  if (search) {
    return lookupRows((search[1] ?? '').trim(), { history, favourites, now, searchUrl, limit, tabs });
  }

  if (input.startsWith(':')) {
    const commands = commandRows(body, limit);
    if (commands.length || !body) return commands;
  }

  return lookupRows(body, { history, favourites, now, searchUrl, limit, tabs });
}

module.exports = { suggestions, fuzzyScore, isAddress, ICONS, COMMANDS, MAX_ROWS };
