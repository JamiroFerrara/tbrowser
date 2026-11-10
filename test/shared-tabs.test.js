'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { sharedTabs } = require('../lib/shared-tabs');

const windows = [
  {
    id: 1,
    tabs: [
      { id: 1, title: 'GitHub', url: 'https://github.com/', active: false },
      { id: 2, title: 'Hacker News', url: 'https://news.ycombinator.com/', active: true },
    ],
  },
  {
    id: 2,
    tabs: [
      { id: 3, title: 'Docs', url: 'https://docs.example.com/', active: true },
      { id: 4, title: 'Mail', url: 'https://mail.example.com/', active: false },
    ],
  },
  { id: 3, tabs: [{ id: 5, title: 'Maps', url: 'https://maps.example.com/', active: true }] },
];

test('the asking window comes first, the others in the order they opened', () => {
  const rows = sharedTabs(windows, 2);
  assert.deepEqual(
    rows.map((row) => row.id),
    [3, 4, 1, 2, 5],
  );
  assert.deepEqual(
    rows.map((row) => row.slot),
    [1, 1, 2, 2, 3],
  );
  assert.deepEqual(
    rows.map((row) => row.here),
    [true, true, false, false, false],
  );
});

test('a tab keeps its own window and focus flag wherever it is listed', () => {
  const rows = sharedTabs(windows, 2);
  const mail = rows.find((row) => row.id === 4);
  assert.equal(mail.window, 2);
  assert.equal(mail.active, false);
  assert.equal(mail.title, 'Mail');
  const news = rows.find((row) => row.id === 2);
  assert.equal(news.window, 1);
  assert.equal(news.active, true);
  assert.equal(news.here, false);
});

test('a buffer no window shows is a row of its own kind', () => {
  const rows = sharedTabs(
    [
      ...windows,
      {
        id: 0,
        parked: true,
        tabs: [
          { id: 9, title: 'Parked', url: 'https://example.com/', active: false, loaded: true },
          { id: -1, title: 'Dormant', url: 'https://example.com/b', active: false, loaded: false },
        ],
      },
    ],
    1,
  );
  const buffer = rows.find((row) => row.id === 9);
  assert.equal(buffer.parked, true);
  assert.equal(buffer.loaded, true);
  assert.equal(buffer.here, false);
  assert.equal(rows.find((row) => row.id === -1).loaded, false);
  assert.equal(rows.find((row) => row.id === 1).parked, false);
});

test('a window that is gone leaves no rows, and no window is "here"', () => {
  const rows = sharedTabs(windows, 99);
  assert.equal(rows.length, 5);
  assert.equal(rows.some((row) => row.here), false);
  assert.deepEqual(
    rows.map((row) => row.slot),
    [1, 1, 2, 2, 3],
  );
  assert.deepEqual(sharedTabs([], 1), []);
  assert.deepEqual(sharedTabs(null, 1), []);
});
