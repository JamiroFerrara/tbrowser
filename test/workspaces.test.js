'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Workspaces, normalizeName, autoName, LAST } = require('../lib/workspaces');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tbrowser-ws-'));
}

test('names are trimmed, collapsed and cut to a usable length', () => {
  assert.equal(normalizeName('  work   stuff  '), 'work stuff');
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName('x'.repeat(80)).length, 40);
});

test('a workspace saved without a name takes the page it is on', () => {
  assert.equal(autoName(['https://www.github.com/a/b'], 0), 'github.com');
  assert.equal(autoName(['https://github.com/', 'https://example.com/'], 0, ['github.com']), 'github.com 2');
  assert.equal(autoName([], 0), 'session');
});

test('a workspace keeps its tabs, its focused tab and its split', () => {
  const dir = tempDir();
  const store = new Workspaces(dir);
  const saved = store.save('work', {
    tabs: ['https://github.com/', 'https://example.com/', 'about:blank'],
    activeTab: 1,
    split: { a: 1, b: 2, orientation: 'horizontal' },
  });
  assert.equal(saved.name, 'work');
  assert.equal(saved.tabs.length, 3);
  assert.deepEqual(saved.split, { a: 1, b: 2, orientation: 'horizontal' });

  const reopened = new Workspaces(dir);
  assert.deepEqual(reopened.get('WORK'), reopened.get('work'));
  assert.equal(reopened.get('work').activeTab, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saving the same name updates it instead of adding a copy', () => {
  const dir = tempDir();
  const store = new Workspaces(dir);
  store.save('work', { tabs: ['https://a.example.com/'] });
  store.save('WORK', { tabs: ['https://b.example.com/'], activeTab: 0 });
  assert.equal(store.list().length, 1);
  assert.equal(store.get('work').tabs[0], 'https://b.example.com/');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a workspace ignores pages it cannot reopen and a split that points nowhere', () => {
  const dir = tempDir();
  const store = new Workspaces(dir);
  const saved = store.save('odd', {
    tabs: ['javascript:alert(1)', 'https://ok.example.com/', 'nonsense'],
    activeTab: 5,
    split: { a: 0, b: 9, orientation: 'vertical' },
  });
  assert.deepEqual(saved.tabs, ['https://ok.example.com/']);
  assert.equal(saved.activeTab, 0);
  assert.equal(saved.split, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the rolling slot is the way back from an unsaved window', () => {
  const dir = tempDir();
  const store = new Workspaces(dir);
  store.save(LAST, { tabs: ['https://before.example.com/'] });
  assert.equal(store.get('last session').tabs[0], 'https://before.example.com/');
  assert.equal(store.remove(LAST), true);
  assert.equal(store.get(LAST), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
