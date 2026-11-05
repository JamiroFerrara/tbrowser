'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Jumps } = require('../lib/jumps');

const at = (tabId, url, index = -1) => ({ tabId, url, index });

test('moving back and forward walks the places already visited', () => {
  const jumps = new Jumps();
  jumps.record(at(1, 'a'));
  jumps.record(at(2, 'b'));
  jumps.record(at(1, 'c'));
  assert.deepEqual(jumps.current(), at(1, 'c'));

  assert.deepEqual(jumps.move(-1), at(2, 'b'));
  assert.deepEqual(jumps.move(-1), at(1, 'a'));
  assert.equal(jumps.move(-1), null, 'the first place is the end of the list');
  assert.deepEqual(jumps.current(), at(1, 'a'));

  assert.deepEqual(jumps.move(1), at(2, 'b'));
  assert.deepEqual(jumps.move(1), at(1, 'c'));
  assert.equal(jumps.move(1), null, 'the last place is the other end');
  assert.deepEqual(jumps.current(), at(1, 'c'));
});

test('a new place drops the forward half, as C-o then C-i does', () => {
  const jumps = new Jumps();
  jumps.record(at(1, 'a'));
  jumps.record(at(2, 'b'));
  jumps.record(at(3, 'c'));
  jumps.move(-2);
  assert.deepEqual(jumps.current(), at(1, 'a'));

  jumps.record(at(4, 'd'));
  assert.deepEqual(jumps.current(), at(4, 'd'));
  assert.equal(jumps.move(1), null);
  assert.deepEqual(jumps.move(-1), at(1, 'a'));
});

test('the same place twice is one entry', () => {
  const jumps = new Jumps();
  jumps.record(at(1, 'a'));
  jumps.record(at(2, 'b'));
  jumps.record(at(2, 'b'));
  assert.deepEqual(jumps.move(-1), at(1, 'a'));
});

test('an empty position or one without a page is ignored', () => {
  const jumps = new Jumps();
  jumps.record(null);
  jumps.record({ tabId: 1, url: '' });
  assert.equal(jumps.current(), null);
  assert.equal(jumps.move(-1), null);
});

test('the list keeps the newest places and drops the oldest', () => {
  const jumps = new Jumps(2);
  jumps.record(at(1, 'a'));
  jumps.record(at(2, 'b'));
  jumps.record(at(3, 'c'));
  assert.deepEqual(jumps.current(), at(3, 'c'));
  assert.deepEqual(jumps.move(-1), at(2, 'b'));
  assert.equal(jumps.move(-1), null);
});

test('a closed tab leaves the list', () => {
  const jumps = new Jumps();
  jumps.record(at(1, 'a'));
  jumps.record(at(2, 'b'));
  jumps.record(at(1, 'c'));
  jumps.forget(2);
  assert.deepEqual(jumps.move(-1), at(1, 'a'));
  assert.equal(jumps.move(-2), null);
});

test('closing the tab under the cursor steps back to the place before it', () => {
  const jumps = new Jumps();
  jumps.record(at(1, 'a'));
  jumps.record(at(2, 'b'));
  jumps.record(at(3, 'c'));
  jumps.move(-1);
  jumps.forget(2);
  assert.deepEqual(jumps.current(), at(1, 'a'));
  assert.deepEqual(jumps.move(1), at(3, 'c'));
});

test('clearing forgets every place', () => {
  const jumps = new Jumps();
  jumps.record(at(1, 'a'));
  jumps.clear();
  assert.equal(jumps.current(), null);
  assert.equal(jumps.move(-1), null);
});
