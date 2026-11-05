'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { splitBounds } = require('../lib/layout');

test('a vertical split gives each pane half the width and a gap', () => {
  const [first, second] = splitBounds(1200, 756, 'vertical', 1, 2);
  assert.deepEqual(first, { x: 0, y: 0, width: 599, height: 756 });
  assert.deepEqual(second, { x: 601, y: 0, width: 599, height: 756 });
  assert.equal(first.width + second.width + 2, 1200);
});

test('a horizontal split stacks the panes', () => {
  const [first, second] = splitBounds(1200, 756, 'horizontal', 1, 2);
  assert.deepEqual(first, { x: 0, y: 0, width: 1200, height: 377 });
  assert.deepEqual(second, { x: 0, y: 379, width: 1200, height: 377 });
  assert.equal(first.height + second.height + 2, 756);
});

test('the opening slide starts with one page and no gap', () => {
  const [first, second] = splitBounds(1200, 756, 'vertical', 0, 2);
  assert.deepEqual(first, { x: 0, y: 0, width: 1200, height: 756 });
  assert.equal(second.width, 0);
  assert.equal(second.x, 1200);

  const [mid] = splitBounds(1200, 756, 'vertical', 0.5, 2);
  assert.ok(mid.width > 599 && mid.width < 1200);
});

test('a nonsense progress still lays out a usable page', () => {
  const [first] = splitBounds(1200, 756, 'vertical', Number.NaN, 2);
  assert.equal(first.width, 1200);
  const [clamped] = splitBounds(1200, 756, 'vertical', 8, 2);
  assert.equal(clamped.width, 599);
});
