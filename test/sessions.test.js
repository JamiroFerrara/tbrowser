'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Sessions, normalizeName, autoName } = require('../lib/sessions');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tbrowser-sessions-'));
}

test('names are trimmed, collapsed and cut to a usable length', () => {
  assert.equal(normalizeName('  work   stuff  '), 'work stuff');
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName('x'.repeat(80)).length, 40);
});

test('a session saved without a name takes the page it is on', () => {
  assert.equal(autoName(['https://www.github.com/a/b'], 0), 'github.com');
  assert.equal(autoName(['https://github.com/', 'https://example.com/'], 0, ['github.com']), 'github.com 2');
  assert.equal(autoName([], 0), 'session');
});

test('a session keeps its tabs, its focused tab and its panes', () => {
  const dir = tempDir();
  const store = new Sessions(dir);
  const panes = {
    orientation: 'vertical',
    children: [{ tab: 1 }, { orientation: 'horizontal', children: [{ tab: 2 }, { tab: 0 }] }],
  };
  const saved = store.save('work', {
    tabs: ['https://github.com/', 'https://example.com/', 'https://news.ycombinator.com/'],
    activeTab: 1,
    panes,
  });
  assert.equal(saved.name, 'work');
  assert.equal(saved.tabs.length, 3);
  assert.equal(saved.order, 1);
  assert.deepEqual(saved.panes, panes);

  const reopened = new Sessions(dir);
  assert.deepEqual(reopened.get('WORK'), reopened.get('work'));
  assert.equal(reopened.get('work').activeTab, 1);
  assert.deepEqual(reopened.get('work').panes, panes);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a split saved by the older two-pane browser is read as panes', () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, 'sessions.json'),
    JSON.stringify({
      version: 2,
      sessions: [
        {
          name: 'work',
          tabs: ['https://github.com/', 'https://example.com/'],
          activeTab: 1,
          split: { a: 0, b: 1, orientation: 'horizontal' },
        },
      ],
    }),
  );
  const store = new Sessions(dir);
  assert.deepEqual(store.get('work').panes, {
    orientation: 'horizontal',
    children: [{ tab: 0 }, { tab: 1 }],
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saving the same name updates it instead of adding a copy', () => {
  const dir = tempDir();
  const store = new Sessions(dir);
  store.save('work', { tabs: ['https://github.com/'] });
  store.save('other', { tabs: ['https://example.com/'] });
  store.save('WORK', { tabs: ['https://github.com/', 'https://example.com/'], activeTab: 1 });
  assert.equal(store.list().length, 2);
  assert.equal(store.get('work').tabs.length, 2);
  assert.equal(store.get('work').order, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a renamed session keeps its tabs and refuses a name already taken', () => {
  const dir = tempDir();
  const store = new Sessions(dir);
  store.save('work', { tabs: ['https://github.com/'] });
  store.save('other', { tabs: ['https://example.com/'] });
  assert.equal(store.rename('work', 'other'), null);
  const renamed = store.rename('work', 'office');
  assert.equal(renamed.name, 'office');
  assert.deepEqual(renamed.tabs, ['https://github.com/']);
  assert.equal(renamed.order, 1);
  assert.equal(new Sessions(dir).get('office').tabs.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the order the sessions jump in moves with the arrows and is written down', () => {
  const dir = tempDir();
  const store = new Sessions(dir);
  for (const name of ['one', 'two', 'three']) store.save(name, { tabs: ['https://example.com/'] });
  assert.deepEqual(store.list().map((entry) => entry.name), ['one', 'two', 'three']);
  assert.equal(store.move('three', -1), true);
  assert.deepEqual(store.list().map((entry) => entry.name), ['one', 'three', 'two']);
  assert.equal(store.move('one', -1), false); // already first
  assert.equal(store.move('two', 1), false); // already last
  assert.deepEqual(new Sessions(dir).list().map((entry) => entry.order), [1, 2, 3]);
  assert.deepEqual(new Sessions(dir).list().map((entry) => entry.name), ['one', 'three', 'two']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a session ignores pages it cannot reopen and panes that point nowhere', () => {
  const dir = tempDir();
  const store = new Sessions(dir);
  const saved = store.save('work', {
    tabs: ['https://github.com/', 'javascript:alert(1)', 'not a url'],
    panes: { orientation: 'sideways', children: [{ tab: 0 }, { tab: 7 }] },
  });
  assert.deepEqual(saved.tabs, ['https://github.com/']);
  assert.equal(saved.panes, null);
  assert.equal(saved.activeTab, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a tab cannot be on screen in two panes at once', () => {
  const dir = tempDir();
  const store = new Sessions(dir);
  const saved = store.save('work', {
    tabs: ['https://github.com/', 'https://example.com/'],
    panes: { orientation: 'vertical', children: [{ tab: 0 }, { tab: 0 }] },
  });
  assert.equal(saved.panes, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the old workspaces file is read as sessions', () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, 'workspaces.json'),
    JSON.stringify({
      version: 1,
      workspaces: [
        { name: 'reading', tabs: ['https://news.ycombinator.com/'], activeTab: 0, savedAt: 5, created: 1 },
        { name: 'work', tabs: ['https://github.com/', 'https://example.com/'], activeTab: 1, savedAt: 6, created: 2 },
      ],
    }),
  );
  const store = new Sessions(dir);
  assert.deepEqual(store.list().map((entry) => entry.name), ['reading', 'work']);
  assert.equal(store.get('work').activeTab, 1);
  store.save('work', { tabs: ['https://github.com/'] });
  // Saving writes the new file; the next read prefers it.
  const reopened = new Sessions(dir);
  assert.deepEqual(reopened.list().map((entry) => entry.name), ['reading', 'work']);
  assert.equal(reopened.get('work').tabs.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a session removed stays removed', () => {
  const dir = tempDir();
  const store = new Sessions(dir);
  store.save('work', { tabs: ['https://github.com/'] });
  assert.equal(store.remove('work'), true);
  assert.equal(store.remove('work'), false);
  assert.deepEqual(new Sessions(dir).list(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
