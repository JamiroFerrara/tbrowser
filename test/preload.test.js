'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PreloadPool } = require('../lib/preload');

/** A fake page: enough of the pool's contract to watch what it does. */
function page(url) {
  return {
    url,
    failed: false,
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

function pool() {
  const opened = [];
  const made = new Map();
  const instance = new PreloadPool((url) => {
    opened.push(url);
    const entry = page(url);
    made.set(url, entry);
    return entry;
  });
  return { instance, opened, made };
}

test('sync starts every wanted address once', () => {
  const { instance, opened } = pool();
  const urls = ['https://a.example/', 'https://b.example/'];
  instance.sync(urls);
  assert.deepEqual(opened, urls);
  instance.sync(urls);
  assert.deepEqual(opened, urls);
  assert.equal(instance.size, 2);
});

test('sync closes and forgets what is no longer wanted', () => {
  const { instance, made } = pool();
  instance.sync(['https://a.example/', 'https://b.example/']);
  instance.sync(['https://b.example/']);
  assert.equal(made.get('https://a.example/').closed, true);
  assert.deepEqual(instance.urls(), ['https://b.example/']);
});

test('taking a page hands it over and empties that slot', () => {
  const { instance, made } = pool();
  instance.sync(['https://a.example/']);
  const taken = instance.take('https://a.example/');
  assert.equal(taken, made.get('https://a.example/'));
  assert.equal(taken.closed, false);
  assert.equal(instance.size, 0);

  // The browser refills after a take, which makes the next open instant too.
  instance.sync(['https://a.example/']);
  assert.equal(instance.size, 1);
});

test('a page whose load failed is dropped, not handed over', () => {
  const { instance, made } = pool();
  instance.sync(['https://down.example/']);
  made.get('https://down.example/').failed = true;
  assert.equal(instance.take('https://down.example/'), null);
  assert.equal(made.get('https://down.example/').closed, true);
});

test('taking an address the pool does not hold is null', () => {
  const { instance } = pool();
  assert.equal(instance.take('https://a.example/'), null);
});

test('a wanted address is reopened after its page was taken', () => {
  const { instance, opened } = pool();
  instance.sync(['https://a.example/']);
  instance.take('https://a.example/');
  instance.sync(['https://a.example/']);
  assert.deepEqual(opened, ['https://a.example/', 'https://a.example/']);
});
