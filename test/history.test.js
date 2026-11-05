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

test('a favourite added in settings survives a reload', () => {
  const dir = tempDir();
  const store = new Visits(dir);
  assert.equal(store.saveFavourite('https://example.com/docs', { title: 'Docs' }), true);

  const reopened = new Visits(dir);
  const [fav] = reopened.favourites();
  assert.equal(fav.url, 'https://example.com/docs');
  assert.equal(fav.title, 'Docs');
  assert.equal(fav.warm, false);
  // The address is the identity: adding it twice is refused, not duplicated.
  assert.equal(reopened.saveFavourite('https://example.com/docs', { title: 'Again' }), false);
  assert.equal(reopened.saveFavourite('not a url', {}), false);
});

test('editing a favourite keeps its day and its preload choice', () => {
  const dir = tempDir();
  const store = new Visits(dir, () => 1000);
  store.saveFavourite('https://example.com/', { title: 'Example' });
  store.setWarm('https://example.com/', true);

  assert.equal(store.saveFavourite('https://example.com/', { title: 'Renamed', from: 'https://example.com/' }), true);
  const [fav] = store.favourites();
  assert.equal(fav.title, 'Renamed');
  assert.equal(fav.warm, true);
  assert.equal(fav.added, 1000);

  // Moving the address moves the entry whole; the old address is gone.
  assert.equal(store.saveFavourite('https://example.org/', { title: 'Renamed', from: 'https://example.com/' }), true);
  const moved = new Visits(dir).favourites();
  assert.deepEqual(
    moved.map((entry) => [entry.url, entry.warm]),
    [['https://example.org/', true]],
  );
});

test('an edit onto an address that is already a favourite is refused', () => {
  const store = new Visits(tempDir());
  store.saveFavourite('https://one.example/', { title: 'One' });
  store.saveFavourite('https://two.example/', { title: 'Two' });

  assert.equal(store.saveFavourite('https://two.example/', { from: 'https://one.example/' }), false);
  assert.deepEqual(
    store.favourites().map((fav) => fav.url),
    ['https://one.example/', 'https://two.example/'],
  );
});

test('a favourite forgotten in settings stays forgotten', () => {
  const dir = tempDir();
  const store = new Visits(dir);
  store.saveFavourite('https://example.com/', { title: 'Example' });
  assert.equal(store.removeFavourite('https://example.com/'), true);
  assert.equal(store.removeFavourite('https://example.com/'), false);

  assert.deepEqual(new Visits(dir).favourites(), []);
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
