'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { frecency, trimVisits } = require('../lib/frecency');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 15);

test('no visits score zero', () => {
  assert.equal(frecency([], NOW), 0);
});

test('a visit today is worth one, and each older one less', () => {
  assert.equal(frecency([NOW], NOW), 1);
  assert.equal(frecency([NOW - 10 * DAY], NOW), 1); // a half-life halves it to 0.5
  assert.equal(frecency([NOW, NOW], NOW), 2);
  assert.equal(frecency([NOW, NOW - 10 * DAY], NOW), 2); // 1 + 0.5 rounds to 2
});

test('visits older than the window stop counting', () => {
  assert.equal(frecency([NOW - 31 * DAY], NOW), 0);
  assert.equal(frecency([NOW - 29 * DAY], NOW), 0); // 0.13 of a visit rounds away
  assert.equal(frecency([NOW, NOW - 29 * DAY], NOW), 1);
});

test('heavy use grows logarithmically instead of linearly', () => {
  const often = Array.from({ length: 40 }, () => NOW);
  assert.equal(frecency(often, NOW), 15); // 10 + sqrt(30) rounds to 15
  assert.ok(frecency(often, NOW) < 40);
});

test('trim keeps the window and the newest 128 visits', () => {
  const visits = [NOW - 40 * DAY, NOW - 2 * DAY, NOW - DAY];
  assert.deepEqual(trimVisits(visits, NOW), [NOW - 2 * DAY, NOW - DAY]);

  const many = Array.from({ length: 200 }, (_, index) => NOW - index);
  const trimmed = trimVisits(many, NOW);
  assert.equal(trimmed.length, 128);
  assert.equal(trimmed.at(-1), NOW);
});
