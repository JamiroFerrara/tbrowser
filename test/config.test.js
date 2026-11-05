'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { matches, normalize, parseAccelerator, parseBindingText } = require('../lib/config');

const key = (overrides) => ({
  key: '',
  control: false,
  alt: false,
  shift: false,
  meta: false,
  ...overrides,
});

test('accelerators parse modifiers and key aliases', () => {
  assert.deepEqual(parseAccelerator('ctrl+shift+i'), { key: 'i', ctrl: true, alt: false, shift: true, meta: false });
  assert.deepEqual(parseAccelerator('alt+left'), { key: 'left', ctrl: false, alt: true, shift: false, meta: false });
  assert.deepEqual(parseAccelerator('f5'), { key: 'f5', ctrl: false, alt: false, shift: false, meta: false });
  assert.deepEqual(parseAccelerator('cmd+k'), { key: 'k', ctrl: false, alt: false, shift: false, meta: true });
});

test('invalid accelerators throw', () => {
  assert.throws(() => parseAccelerator('ctrl+nope+k'));
  assert.throws(() => parseAccelerator(''));
});

test('punctuation bindings ignore the shift that produces them', () => {
  assert.equal(matches(key({ key: ':', shift: true }), [':']), true);
  assert.equal(matches(key({ key: ':' }), [':']), true);
  assert.equal(matches(key({ key: ';', shift: true }), [':']), false);
});

test('matches requires exact modifier state and ignores key case', () => {
  assert.equal(matches(key({ key: 'L', control: true }), ['ctrl+l']), true);
  assert.equal(matches(key({ key: 'l', control: true, shift: true }), ['ctrl+l']), false);
  assert.equal(matches(key({ key: 'l' }), ['ctrl+l']), false);
  assert.equal(matches(key({ key: 'ArrowLeft', alt: true }), ['alt+left']), true);
  assert.equal(matches(key({ key: 'Escape' }), ['escape']), true);
  assert.equal(matches(key({ key: 'r', control: true }), ['ctrl+r', 'f5']), true);
});

test('normalize keeps defaults and rejects bad bindings', () => {
  const config = normalize({ keybindings: { openBar: ['ctrl+l', 'bogus+x+y'], reload: 'f5' } });
  assert.deepEqual(config.keybindings.openBar, ['ctrl+l']);
  assert.deepEqual(config.keybindings.reload, ['f5']);
  assert.deepEqual(config.keybindings.closeBar, ['escape']);
  assert.equal(config.searchUrl, 'https://www.google.com/search?q=');
});

test('normalize accepts a custom search url', () => {
  assert.equal(normalize({ searchUrl: 'https://kagi.com/search?q=' }).searchUrl, 'https://kagi.com/search?q=');
  assert.equal(normalize({ searchUrl: 42 }).searchUrl, 'https://www.google.com/search?q=');
});

test('preloading is on by default and only a boolean changes it', () => {
  assert.equal(normalize({}).preload, true);
  assert.equal(normalize({ preload: false }).preload, false);
  assert.equal(normalize({ preload: 'yes' }).preload, true);
});

test('binding text parses comma-separated accelerators', () => {
  assert.deepEqual(parseBindingText('ctrl+l, ctrl+k'), { ok: true, list: ['ctrl+l', 'ctrl+k'] });
  assert.deepEqual(parseBindingText('  F5  '), { ok: true, list: ['f5'] });
  assert.deepEqual(parseBindingText(':'), { ok: true, list: [':'] });
});

test('binding text refuses an empty row and names what does not parse', () => {
  assert.equal(parseBindingText('   ').ok, false);
  assert.equal(parseBindingText('').ok, false);
  const bad = parseBindingText('ctrl+l, bogus+x+y');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /bogus\+x\+y/);
});
