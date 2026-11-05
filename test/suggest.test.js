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

test('open tabs are the first rows, and their pages are not listed twice', () => {
  const rows = suggestions('', {
    history,
    favourites,
    searchUrl: SEARCH,
    tabs: openTabs,
    now: NOW,
  });
  assert.equal(rows[0].kind, 'tab');
  assert.equal(rows[0].title, 'Hacker News'); // the focused tab comes first
  assert.equal(rows[0].value, ':tab 2');
  assert.equal(rows[1].value, ':tab 1');
  assert.equal(rows.filter((row) => row.kind === 'tab').length, 2);
  assert.equal(
    rows.some((row) => row.kind === 'favourite'),
    true,
  );

  const typed = suggestions('git', { history, searchUrl: SEARCH, tabs: openTabs, now: NOW });
  assert.equal(typed[0].kind, 'tab');
  assert.equal(typed[0].title, 'GitHub');
  // GitHub is open, so the history entry for it is not offered as a second row.
  assert.equal(typed.filter((row) => row.title === 'GitHub').length, 1);
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
