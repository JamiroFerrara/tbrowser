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

test('a binding from the older browser cannot take a key the new one uses', () => {
  // The file written before panes and buffers were separate things bound C-w
  // to closing the tab and C-S-w to closing the window. Those actions are
  // gone, so their keys are the new build's again.
  const config = normalize({
    keybindings: {
      closeTab: ['ctrl+w'],
      openBar: ['ctrl+p'],
    },
  });
  assert.equal('closeTab' in config.keybindings, false);
  assert.deepEqual(config.keybindings.closePane, ['ctrl+w']);
  assert.deepEqual(config.keybindings.killTab, ['ctrl+shift+w']);
  assert.deepEqual(config.keybindings.openBar, ['ctrl+p']);
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

test('the jump list answers to ctrl+o and ctrl+i', () => {
  const bindings = normalize({}).keybindings;
  assert.equal(matches(key({ key: 'o', control: true }), bindings.jumpBack), true);
  assert.equal(matches(key({ key: 'i', control: true }), bindings.jumpForward), true);
  // The keys the older build bound still work, and nothing else sneaks in.
  assert.equal(matches(key({ key: 'o', alt: true }), bindings.jumpBack), true);
  assert.equal(matches(key({ key: 'i', alt: true }), bindings.jumpForward), true);
  assert.equal(matches(key({ key: 'o', control: true, shift: true }), bindings.jumpBack), false);
  assert.equal(matches(key({ key: 'o' }), bindings.jumpBack), false);
});

test('a config still holding the old jump keys moves to the new ones', () => {
  const config = normalize({ keybindings: { jumpBack: ['alt+o'], jumpForward: ['alt+i'] } });
  assert.deepEqual(config.keybindings.jumpBack, ['ctrl+o', 'alt+o']);
  assert.deepEqual(config.keybindings.jumpForward, ['ctrl+i', 'alt+i']);
  // A list the user picked is their own, even when it drops a default key.
  const custom = normalize({ keybindings: { jumpBack: ['alt+o', 'alt+b'] } });
  assert.deepEqual(custom.keybindings.jumpBack, ['alt+o', 'alt+b']);
  assert.deepEqual(custom.keybindings.jumpForward, ['ctrl+i', 'alt+i']);
});

test('ctrl+comma ships bound to the settings page', () => {
  assert.deepEqual(normalize({}).keybindings.settings, ['ctrl+,']);
  // The comma arrives with a modifier of its own and no shift, so the binding
  // has to match the key Electron reports, not the text a layout produces.
  assert.equal(matches(key({ key: ',', control: true }), normalize({}).keybindings.settings), true);
  assert.equal(matches(key({ key: ',', control: true, shift: true }), normalize({}).keybindings.settings), true);
  assert.equal(matches(key({ key: ',', control: true, alt: true }), normalize({}).keybindings.settings), false);
  assert.equal(matches(key({ key: ',' }), normalize({}).keybindings.settings), false);
});

test('binding text parses comma-separated accelerators', () => {
  assert.deepEqual(parseBindingText('ctrl+l, ctrl+k'), { ok: true, list: ['ctrl+l', 'ctrl+k'] });
  assert.deepEqual(parseBindingText('  F5  '), { ok: true, list: ['f5'] });
  assert.deepEqual(parseBindingText(':'), { ok: true, list: [':'] });
});

test('a binding whose key is the comma survives the settings form', () => {
  // The settings row joins with ", ", so the row for ctrl+, reads "ctrl+,".
  assert.deepEqual(parseBindingText('ctrl+,'), { ok: true, list: ['ctrl+,'] });
  assert.deepEqual(parseBindingText('ctrl+, '), { ok: true, list: ['ctrl+,'] });
  assert.equal(parseBindingText(', ctrl+k').ok, false);
  assert.deepEqual(parseBindingText('ctrl+,, ctrl+k'), { ok: true, list: ['ctrl+,', 'ctrl+k'] });
  assert.deepEqual(parseBindingText(','), { ok: true, list: [','] });
  assert.deepEqual(parseBindingText('ctrl+l, ctrl+k'), { ok: true, list: ['ctrl+l', 'ctrl+k'] });
});

test('binding text refuses what does not parse', () => {
  const bad = parseBindingText('ctrl+l, bogus+x+y');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /bogus\+x\+y/);
});

test('an empty row unbinds the action instead of failing the save', () => {
  assert.deepEqual(parseBindingText('   '), { ok: true, list: [] });
  assert.deepEqual(parseBindingText(''), { ok: true, list: [] });
});
