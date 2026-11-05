'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { splitBounds, edgeBounds } = require('../lib/layout');

test('a vertical split gives each pane half the width and a gap', () => {
  const [first, second] = splitBounds(1200, 756, 'vertical', 2);
  assert.deepEqual(first, { x: 0, y: 0, width: 599, height: 756 });
  assert.deepEqual(second, { x: 601, y: 0, width: 599, height: 756 });
  assert.equal(first.width + second.width + 2, 1200);
});

test('a horizontal split stacks the panes', () => {
  const [first, second] = splitBounds(1200, 756, 'horizontal', 2);
  assert.deepEqual(first, { x: 0, y: 0, width: 1200, height: 377 });
  assert.deepEqual(second, { x: 0, y: 379, width: 1200, height: 377 });
  assert.equal(first.height + second.height + 2, 756);
});

test('an odd width still fills the area with the gap between the panes', () => {
  const [first, second] = splitBounds(1201, 756, 'vertical', 2);
  assert.equal(first.width + second.width + 2, 1201);
  assert.equal(second.x, first.width + 2);
});

test('an inset keeps each pane off the edge and the frames apart', () => {
  const [first, second] = splitBounds(1200, 756, 'vertical', 4, 2);
  assert.deepEqual(first, { x: 2, y: 2, width: 596, height: 752 });
  assert.deepEqual(second, { x: 602, y: 2, width: 596, height: 752 });
  assert.equal(second.x - (first.x + first.width), 4);
  assert.equal(1200 - (second.x + second.width), 2);
});

test('a pane frame is the strip just outside the pane', () => {
  const pane = { x: 10, y: 20, width: 100, height: 50 };
  assert.deepEqual(edgeBounds(pane, 'top', 2), { x: 10, y: 18, width: 100, height: 2 });
  assert.deepEqual(edgeBounds(pane, 'bottom', 2), { x: 10, y: 70, width: 100, height: 2 });
  assert.deepEqual(edgeBounds(pane, 'left', 2), { x: 8, y: 20, width: 2, height: 50 });
  assert.deepEqual(edgeBounds(pane, 'right', 2), { x: 110, y: 20, width: 2, height: 50 });
});

test('the frames of two panes in a split meet but never overlap', () => {
  const [first, second] = splitBounds(1200, 756, 'horizontal', 4, 2);
  const aBottom = edgeBounds(first, 'bottom', 2);
  const bTop = edgeBounds(second, 'top', 2);
  assert.equal(aBottom.y + aBottom.height, bTop.y);
  assert.equal(first.y, 2);
  assert.equal(756 - (second.y + second.height), 2);
});
