'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { GESTURE_MS, watchGesture, fromUser } = require('../lib/popups');

/** A stand-in for a page's webContents: it only has to carry events. */
function page() {
  const contents = new EventEmitter();
  contents.emitInput = (type) => contents.emit('input-event', {}, { type });
  return contents;
}

test('a page nobody touched has not had a gesture', () => {
  assert.equal(fromUser(page()), false);
});

test('a click on the page counts', () => {
  const wc = page();
  watchGesture(wc);
  wc.emitInput('mouseDown');
  assert.equal(fromUser(wc), true);
});

test('a key press on the page counts', () => {
  const wc = page();
  watchGesture(wc);
  wc.emitInput('keyDown');
  assert.equal(fromUser(wc), true);
});

test('moving and scrolling are not a gesture', () => {
  const wc = page();
  watchGesture(wc);
  wc.emitInput('mouseMove');
  wc.emitInput('mouseWheel');
  wc.emitInput('gestureScrollUpdate');
  assert.equal(fromUser(wc), false);
});

test('the gesture stops counting once it is old enough', () => {
  const wc = page();
  let now = 1_000_000;
  watchGesture(wc, () => now);
  wc.emitInput('mouseDown');

  now += GESTURE_MS - 1;
  assert.equal(fromUser(wc, () => now), true);

  now += 1;
  assert.equal(fromUser(wc, () => now), false);
});

test('the newest gesture is the one that counts', () => {
  const wc = page();
  let now = 1_000_000;
  watchGesture(wc, () => now);
  wc.emitInput('mouseDown');

  now += GESTURE_MS;
  wc.emitInput('keyDown');
  assert.equal(fromUser(wc, () => now), true);

  now += GESTURE_MS;
  assert.equal(fromUser(wc, () => now), false);
});

test('one page\'s click is not another page\'s', () => {
  const clicked = page();
  const ad = page();
  watchGesture(clicked);
  watchGesture(ad);
  clicked.emitInput('mouseDown');
  assert.equal(fromUser(clicked), true);
  assert.equal(fromUser(ad), false);
});
