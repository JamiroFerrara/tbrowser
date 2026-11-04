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

test(':s puts the typed query in the first row and ranks matches behind it', () => {
  const rows = rowsFor(':s github');
  assert.equal(rows[0].kind, 'search');
  assert.equal(rows[0].value, 'github');
  assert.match(rows[0].title, /github/);
  assert.equal(rows[1].title, 'GitHub');
});

test('typing a plain word offers the search first, then visited matches', () => {
  const rows = rowsFor('hacker');
  assert.equal(rows[0].kind, 'search');
  assert.equal(rows[1].title, 'Hacker News');
  assert.equal(rows.length, 2);
});

test('fuzzy letters in order still match', () => {
  assert.notEqual(fuzzyScore('Hacker News', 'hkrnws'), null);
  assert.equal(fuzzyScore('Hacker News', 'zzz'), null);
  assert.ok(fuzzyScore('Hacker News', 'hacker') > fuzzyScore('Hacker News', 'hkr'));
});

test('favourites outrank history they have never been visited from', () => {
  const rows = rowsFor(':s old');
  assert.equal(rows[0].kind, 'search');
  assert.equal(rows[1].kind, 'favourite');
  assert.equal(rows[1].value, 'https://old.example.com/');
});

test('a colon command lists commands, not pages', () => {
  const rows = rowsFor(':sett');
  assert.equal(rows[0].value, ':settings');
  assert.equal(rows[0].kind, 'command');

  const all = rowsFor(':');
  assert.equal(all.length, 4);
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
