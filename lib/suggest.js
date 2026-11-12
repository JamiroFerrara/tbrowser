'use strict';

const { looksLikeUrl, SCHEME_RE } = require('./commands');
const { frecency } = require('./frecency');

const ICONS = {
  favourite: '★',
  history: '🕘',
  search: '🔍',
  command: '⌘',
  tab: '🗂',
  session: '🗃',
};

const COMMANDS = [
  { name: 's', usage: ':s <query>', description: 'search the web for everything after :s' },
  { name: 'extensions', usage: ':extensions', description: 'loaded Chrome extensions' },
  { name: 'settings', usage: ':settings', description: 'edit config.json' },
  { name: 'fav', usage: ':fav', description: 'add or remove this page from favourites' },
  { name: 'session', usage: ':session save <name>', description: 'save, attach or kill a session' },
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

// A results page is a query, not a page: offered in the list it repeats the
// words already typed and pushes the sites the user wants down and out. The
// addresses that are one are the search engines' result paths, matched on the
// host without `www.` and on the path, with a query where the path alone is
// also the engine's home (`duckduckgo.com/?q=`).
const SEARCH_ENGINES = [
  // Google's country domains: google.com, google.de, google.co.uk, google.com.au.
  { host: /^google\.(?:[a-z]{2,3}|com?\.[a-z]{2})$/, path: /^\/(?:search|webhp|url)$/, query: false },
  { host: /^(?:html\.|lite\.)?duckduckgo\.com$/, path: /^\/(?:|html\/|lite\/)$/, query: true },
  {
    host: /^(?:bing\.com|search\.yahoo\.com|search\.brave\.com|startpage\.com|ecosia\.org)$/,
    path: /^\/(?:search|sp\/search|do\/search)$/,
    query: true,
  },
];

/** True for an address that is a search engine's results page. */
function isSearchPage(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  const host = parsed.hostname.replace(/^www\./, '');
  const hasQuery = ['q', 'p', 'query', 'text'].some((key) => parsed.searchParams.has(key));
  return SEARCH_ENGINES.some(
    (engine) =>
      engine.host.test(host) &&
      engine.path.test(parsed.pathname) &&
      (!engine.query || hasQuery),
  );
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
    if (exclude.has(entry.url) || isSearchPage(entry.url)) continue;
    byUrl.set(entry.url, {
      url: entry.url,
      title: titleOf(entry.url, entry.title),
      score: frecency(entry.visits ?? [], now),
      kind: 'history',
    });
  }
  for (const fav of favourites) {
    if (exclude.has(fav.url) || isSearchPage(fav.url)) continue;
    const row = byUrl.get(fav.url) ?? {
      url: fav.url,
      title: titleOf(fav.url, fav.title),
      score: 0,
      kind: 'history',
    };
    // The name the user typed in settings is how they know the page, so it
    // replaces the one the visit recorded, in the row and in the match both.
    if (fav.title) row.title = fav.title;
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
 *
 * `favourites` is the name the user gave each favourite page: a tab showing one
 * is listed — and found — under that name, the same one the page gets when it
 * is not open.
 */
function tabRows(query, tabs, { favourites = new Map(), visitScores = new Map() } = {}) {
  const open = Array.isArray(tabs) ? tabs : [];
  // `here` is absent on a list from one window: every tab in it is here.
  const home = (tab) => tab.here !== false;
  const ordered = open
    .filter((tab) => tab.active && home(tab))
    .concat(open.filter((tab) => !(tab.active && home(tab))));
  const rows = [];
  for (const tab of ordered) {
    const url = String(tab.url ?? '');
    const title = favourites.get(url) || titleOf(url, tab.title);
    const titleScore = fuzzyScore(title, query);
    const urlScore = fuzzyScore(url, query);
    if (query && titleScore === null && urlScore === null) continue;
    const where = tab.parked
      ? tab.loaded === false
        ? 'buffer (not loaded) · '
        : 'buffer · '
      : home(tab)
        ? ''
        : `window ${tab.slot} · `;
    const tier = favourites.has(url) ? 'favourite' : 'tab';
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

/**
 * The sessions, for the picker Alt+P opens: the saved ones in the order they
 * jump, then the ones this run made. The current session is marked, and the
 * rows say how many windows are attached to each.
 */
function sessionRows(query, sessions, limit, current = '') {
  const list = Array.isArray(sessions) ? sessions : [];
  const showing = String(current ?? '').toLowerCase();
  const rows = [];
  for (const session of list) {
    const name = String(session.name ?? '');
    const score = fuzzyScore(name, query) ?? (query ? fuzzyScore(`${name} ${session.tabs ?? ''}`, query) : 0);
    if (query && score === null) continue;
    const tabs = Number(session.tabs) || 0;
    const attached = Number(session.attached) || 0;
    const here = name.toLowerCase() === showing;
    rows.push({
      score: score ?? 0,
      item: {
        kind: 'session',
        icon: ICONS.session,
        title: name,
        subtitle: [here ? 'current' : '', `${tabs} tab${tabs === 1 ? '' : 's'}`, `${attached} attached`, session.saved ? 'saved' : 'unsaved']
          .filter(Boolean)
          .join(' · '),
        value: `:session open ${name}`,
      },
    });
  }
  rows.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
  const items = rows.slice(0, query ? limit - 1 : limit).map((row) => row.item);
  // With nothing typed there is no "open this text" meaning, so the picker
  // ends with the way to make what the window shows outlive the browser.
  if (!query) {
    items.push({
      kind: 'session',
      icon: '＋',
      title: 'Save this session',
      subtitle: 'keep the tabs in this window under a name',
      value: ':session save',
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
  // The user's own name for a page travels with it: a tab showing a favourite
  // is found under that name too, not only under the title the site gave it.
  // An unnamed favourite maps to nothing and keeps the title the tab has.
  const favouriteTitles = new Map(favs.map((fav) => [fav.url, fav.title || '']));
  const rows = [
    ...tabRows(query, open, {
      favourites: favouriteTitles,
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
 * matches; bare text is the same lookup without that first stop. The session
 * mode is the picker Alt+P opens: only sessions, and nothing is opened as a
 * page.
 */
function suggestions(
  text,
  {
    history = [],
    favourites = [],
    searchUrl,
    tabs = [],
    sessions = [],
    currentSession = '',
    mode = 'address',
    now = Date.now(),
    limit = MAX_ROWS,
  } = {},
) {
  const input = String(text ?? '').trim();
  if (mode === 'session') return sessionRows(input, sessions, limit, currentSession);
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
