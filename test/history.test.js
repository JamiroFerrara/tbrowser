'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Visits } = require('../lib/history');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tbrowser-history-'));
}

test('a favourite is not preloaded until it is switched on', () => {
  const store = new Visits(tempDir());
  store.toggleFavourite('https://example.com/', 'Example');
  assert.equal(store.favourites()[0].warm, false);

  assert.equal(store.setWarm('https://example.com/', true), true);
  assert.equal(store.favourites()[0].warm, true);
  // Setting the value it already has changes nothing, so no write happens.
  assert.equal(store.setWarm('https://example.com/', true), false);
});

test('the preload flag survives a reload', () => {
  const dir = tempDir();
  const store = new Visits(dir);
  store.toggleFavourite('https://example.com/', 'Example');
  store.setWarm('https://example.com/', true);

  const reopened = new Visits(dir);
  assert.equal(reopened.favourites()[0].warm, true);
  assert.equal(reopened.favourites()[0].title, 'Example');
});

test('dropping a favourite drops its preload choice with it', () => {
  const dir = tempDir();
  const store = new Visits(dir);
  store.toggleFavourite('https://example.com/', 'Example');
  store.setWarm('https://example.com/', true);
  store.toggleFavourite('https://example.com/');

  const reopened = new Visits(dir);
  assert.deepEqual(reopened.favourites(), []);
  // Re-adding the page starts it switched off, not preloading by surprise.
  reopened.toggleFavourite('https://example.com/', 'Example');
  assert.equal(reopened.favourites()[0].warm, false);
  assert.equal(reopened.setWarm('https://nope.example/', true), false);
});
