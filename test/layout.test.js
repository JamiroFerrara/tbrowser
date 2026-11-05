'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { splitBounds } = require('../lib/layout');

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
