'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadExtensions, readDisabledExtensions, writeDisabledExtensions } = require('../lib/extensions');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbrowser-ext-test-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function extensionDir(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name, version: '1.0' }));
  return dir;
}

test('loadExtensions skips the folders the user switched off', async () => {
  const root = scratch();
  const on = extensionDir(root, 'dark-reader');
  const off = extensionDir(root, 'ublock');
  const tried = [];
  const ses = {
    extensions: {
      loadExtension: async (dir) => {
        tried.push(path.resolve(dir));
        return { name: path.basename(dir), version: '1.0', path: dir };
      },
    },
  };
  const quiet = { info() {}, error() {} };

  await loadExtensions(ses, root, { skip: [off], log: quiet });

  assert.deepEqual(tried, [path.resolve(on)]);
});

test('a folder without a manifest is not an extension', async () => {
  const root = scratch();
  fs.mkdirSync(path.join(root, 'notes'));
  const tried = [];
  const ses = { extensions: { loadExtension: async (dir) => tried.push(dir) } };

  await loadExtensions(ses, root, { log: { info() {}, error() {} } });

  assert.deepEqual(tried, []);
});

test('the off list round-trips as absolute paths, without duplicates', () => {
  const root = scratch();
  const file = path.join(root, 'extensions.json');

  assert.deepEqual(readDisabledExtensions(file), [], 'a missing file reads as nothing off');

  const written = writeDisabledExtensions(file, [path.join(root, 'a'), `${path.join(root, 'a')}${path.sep}`]);
  assert.deepEqual(written, [path.resolve(root, 'a')]);
  assert.deepEqual(readDisabledExtensions(file), [path.resolve(root, 'a')]);
});
