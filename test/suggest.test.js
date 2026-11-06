'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { suggestions, fuzzyScore, isAddress } = require('../lib/suggest');

const NOW = Date.UTC(2026, 0, 15);
const DAY = 24 * 60 * 60 * 1000;
const SEARCH = 'https://duckduckgo.com/?q=';

const history = [
  { url: 'https://github.com/', title: 'GitHub', visits: [NOW, NOW, NOW] },
  { url: 'https://news.ycombinator.com/', title: 'Hacker News', visits: [NOW - 3 * DAY] },
];
const favourites = [{ url: 'https://old.example.com/', title: 'Old Example' }];

const rowsFor = (text) => suggestions(text, { history, favourites, searchUrl: SEARCH, now: NOW });

test('an address has no dropdown', () => {
  assert.equal(isAddress('https://example.com'), true);
  assert.equal(isAddress('example.com'), true);
  assert.equal(isAddress('localhost:3000'), true);
  assert.equal(isAddress('rust ownership'), false);
  assert.equal(isAddress(':s'), false);

  assert.deepEqual(rowsFor('https://example.com/x'), []);
  assert.deepEqual(rowsFor('example.com'), []);
  assert.deepEqual(rowsFor(':s example.com'), []);
});

test('empty search shows the most frequent pages first', () => {
  const rows = rowsFor(':s');
  assert.equal(rows[0].kind, 'favourite'); // favourites are pinned above history
  assert.equal(rows[1].title, 'GitHub');
  assert.equal(rows[2].title, 'Hacker News');
});

test(':s ranks matches first and leaves the search last to catch the rest', () => {
  const rows = rowsFor(':s github');
  assert.equal(rows[0].title, 'GitHub');
  const last = rows[rows.length - 1];
  assert.equal(last.kind, 'search');
  assert.equal(last.value, 'github');
  assert.match(last.title, /github/);
});

test('typing a plain word preselects the visited match, search behind it', () => {
  const rows = rowsFor('hacker');
  assert.equal(rows[0].title, 'Hacker News');
  assert.equal(rows[1].kind, 'search');
  assert.equal(rows.length, 2);
});

test('a word nothing matches falls back to the search row alone', () => {
  const rows = rowsFor('zzzz');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'search');
  assert.equal(rows[0].value, 'zzzz');

  const search = rowsFor(':s frobnicate');
  assert.equal(search.length, 1);
  assert.equal(search[0].kind, 'search');
});

test('a colon with no matching command is looked up as text', () => {
  const rows = rowsFor(':hacker');
  assert.equal(rows[0].title, 'Hacker News');
  assert.equal(rows[1].kind, 'search');

  const none = rowsFor(':zzzz');
  assert.equal(none.length, 1);
  assert.equal(none[0].kind, 'search');
  assert.equal(none[0].value, 'zzzz');
});

test('fuzzy letters in order still match', () => {
  assert.notEqual(fuzzyScore('Hacker News', 'hkrnws'), null);
  assert.equal(fuzzyScore('Hacker News', 'zzz'), null);
  assert.ok(fuzzyScore('Hacker News', 'hacker') > fuzzyScore('Hacker News', 'hkr'));
});

test('favourites outrank history they have never been visited from', () => {
  const rows = rowsFor(':s old');
  assert.equal(rows[0].kind, 'favourite');
  assert.equal(rows[0].value, 'https://old.example.com/');
});

test('a favourite outranks a page opened far more often', () => {
  const busy = [{ url: 'https://news.ycombinator.com/', title: 'Hacker News', visits: Array(128).fill(NOW) }];
  const starred = [{ url: 'https://h.example.com/', title: 'Hacker' }];
  const rows = suggestions(':s hacker', { history: busy, favourites: starred, searchUrl: SEARCH, now: NOW });
  assert.equal(rows[0].kind, 'favourite');
  assert.equal(rows[0].value, 'https://h.example.com/');
  assert.equal(rows[1].kind, 'history');
});

test('a colon command lists commands, not pages', () => {
  const rows = rowsFor(':sett');
  assert.equal(rows[0].value, ':settings');
  assert.equal(rows[0].kind, 'command');

  const all = rowsFor(':');
  assert.equal(all.length, 5);
  assert.ok(all.every((row) => row.kind === 'command'));
});

test('rows are capped at eight', () => {
  const many = Array.from({ length: 30 }, (_, index) => ({
    url: `https://site${index}.example.com/`,
    title: `Site ${index}`,
    visits: [NOW],
  }));
  const rows = suggestions(':s site', { history: many, searchUrl: SEARCH, now: NOW });
  assert.equal(rows.length, 8);
});

const openTabs = [
  { id: 1, url: 'https://github.com/', title: 'GitHub', active: false },
  { id: 2, url: 'https://news.ycombinator.com/', title: 'Hacker News', active: true },
];

test('a favourite comes first, the open tabs under it, and pages twice', () => {
  const rows = suggestions('', {
    history,
    favourites,
    searchUrl: SEARCH,
    tabs: openTabs,
    now: NOW,
  });
  assert.equal(rows[0].kind, 'favourite');
  assert.equal(rows[0].value, 'https://old.example.com/');
  assert.equal(rows[1].kind, 'tab');
  assert.equal(rows[1].title, 'GitHub'); // opened three times today, so above the tab opened once
  assert.equal(rows[1].value, ':tab 1');
  assert.equal(rows[2].value, ':tab 2');
  assert.equal(rows.filter((row) => row.kind === 'tab').length, 2);
  // Both pages are open, so neither is offered a second time from history.
  assert.equal(rows.length, 3);

  const typed = suggestions('git', { history, searchUrl: SEARCH, tabs: openTabs, now: NOW });
  assert.equal(typed[0].kind, 'tab');
  assert.equal(typed[0].title, 'GitHub');
  // GitHub is open, so the history entry for it is not offered as a second row.
  assert.equal(typed.filter((row) => row.title === 'GitHub').length, 1);
});

test('a tab opened all day climbs over a favourite nobody visits', () => {
  const busyTab = [
    { id: 1, url: 'https://news.ycombinator.com/', title: 'Hacker News', active: true },
  ];
  const everyDay = [{ url: busyTab[0].url, title: 'Hacker News', visits: Array(128).fill(NOW) }];
  const starred = [{ url: 'https://h.example.com/', title: 'Hacker' }];
  const rows = suggestions(':s hacker', {
    history: everyDay,
    favourites: starred,
    searchUrl: SEARCH,
    tabs: busyTab,
    now: NOW,
  });
  assert.equal(rows[0].kind, 'tab');
  assert.equal(rows[0].value, ':tab 1');
  assert.equal(rows[1].kind, 'favourite');
});

test('a rarely opened tab stays under a favourite', () => {
  const rows = suggestions('', { history, favourites, searchUrl: SEARCH, tabs: openTabs, now: NOW });
  assert.equal(rows[0].kind, 'favourite');
});

test('an open tab keeps the visit history of the page it shows', () => {
  const tabs = [
    { id: 1, url: 'https://rare.example.com/', title: 'Rare', active: true },
    { id: 2, url: 'https://daily.example.com/', title: 'Daily', active: false },
  ];
  const visits = [
    { url: 'https://daily.example.com/', title: 'Daily', visits: Array(16).fill(NOW) },
  ];
  const rows = suggestions('', { history: visits, searchUrl: SEARCH, tabs, now: NOW });
  assert.equal(rows[0].title, 'Daily'); // opened all day, though it is not the focused tab
  assert.equal(rows[1].title, 'Rare');
});

test('a tab of another window keeps its place in that window', () => {
  // What lib/shared-tabs hands the bar: this window's tab first, then the one
  // another window holds.
  const tabs = [
    { id: 1, url: 'https://github.com/', title: 'GitHub', active: true, window: 1, slot: 1, here: true },
    {
      id: 9,
      url: 'https://news.ycombinator.com/',
      title: 'Hacker News',
      active: true,
      window: 2,
      slot: 2,
      here: false,
    },
  ];
  const rows = suggestions('', { searchUrl: SEARCH, tabs, now: NOW });
  assert.equal(rows[0].kind, 'tab');
  assert.equal(rows[0].subtitle, 'current tab');
  const other = rows.find((row) => row.value === ':tab 9');
  assert.equal(other.subtitle, 'window 2 · news.ycombinator.com');
  // The other window's focused tab is not hoisted above this window's list.
  assert.equal(rows[1].value, ':tab 9');
});

test('a workspace picker lists saved sets and a way to save this one', () => {
  const workspaces = [
    { name: 'work', tabs: ['https://github.com/', 'https://mail.example.com/'], activeTab: 0 },
    { name: 'reading', tabs: ['https://news.ycombinator.com/'], activeTab: 0 },
  ];
  const rows = suggestions('', { mode: 'workspace', workspaces, searchUrl: SEARCH });
  assert.equal(rows[0].kind, 'workspace');
  assert.equal(rows[0].value, ':ws open reading'); // alphabetical when nothing is typed
  assert.equal(rows[0].subtitle, '1 tab · news.ycombinator.com');
  assert.equal(rows.at(-1).value, ':ws save');

  const filtered = suggestions('work', { mode: 'workspace', workspaces });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].value, ':ws open work');
});
