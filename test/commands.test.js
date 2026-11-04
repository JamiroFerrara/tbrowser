'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseInput, parseCommand, looksLikeUrl } = require('../lib/commands');

const SEARCH = 'https://duckduckgo.com/?q=';

test('explicit http(s) URLs pass through', () => {
  assert.equal(parseInput('https://example.com/a?b=1', SEARCH), 'https://example.com/a?b=1');
  assert.equal(parseInput('http://example.com', SEARCH), 'http://example.com');
  assert.equal(parseInput('about:blank', SEARCH), 'about:blank');
  assert.equal(parseInput('file:///tmp/x.html', SEARCH), 'file:///tmp/x.html');
});

test('host-looking input gets https', () => {
  assert.equal(parseInput('example.com', SEARCH), 'https://example.com');
  assert.equal(parseInput('example.com/path?q=1', SEARCH), 'https://example.com/path?q=1');
  assert.equal(parseInput('localhost:3000', SEARCH), 'http://localhost:3000');
  assert.equal(parseInput('127.0.0.1:8080/x', SEARCH), 'http://127.0.0.1:8080/x');
  assert.equal(parseInput('sub.domain.co.uk', SEARCH), 'https://sub.domain.co.uk');
  assert.equal(parseInput('example.com:8080', SEARCH), 'http://example.com:8080');
  assert.equal(parseInput('example.com:443', SEARCH), 'https://example.com:443');
});

test('everything else is a search', () => {
  assert.equal(parseInput('rust ownership', SEARCH), `${SEARCH}rust%20ownership`);
  assert.equal(parseInput('example.com is down', SEARCH), `${SEARCH}example.com%20is%20down`);
  assert.equal(parseInput('hello', SEARCH), `${SEARCH}hello`);
  assert.equal(parseInput('javascript:alert(1)', SEARCH), `${SEARCH}javascript%3Aalert(1)`);
  assert.equal(parseInput('mailto:a@b.c', SEARCH), `${SEARCH}mailto%3Aa%40b.c`);
});

test('blank input yields null', () => {
  assert.equal(parseInput('', SEARCH), null);
  assert.equal(parseInput('   ', SEARCH), null);
  assert.equal(parseInput(null, SEARCH), null);
});

test('looksLikeUrl boundaries', () => {
  assert.equal(looksLikeUrl('a.b'), true);
  assert.equal(looksLikeUrl('a b.c'), false);
  assert.equal(looksLikeUrl('http://x'), false);
  assert.equal(looksLikeUrl('foo:bar'), false);
  assert.equal(looksLikeUrl('example.com:8080'), true);
  assert.equal(looksLikeUrl('localhost'), true);
  assert.equal(looksLikeUrl('localhost test'), false);
});

test('command bar commands parse after a colon', () => {
  assert.deepEqual(parseCommand(':extensions'), { name: 'extensions', args: [] });
  assert.deepEqual(parseCommand('  :settings  '), { name: 'settings', args: [] });
  assert.deepEqual(parseCommand(':ext foo bar'), { name: 'ext', args: ['foo', 'bar'] });
  assert.deepEqual(parseCommand(':'), { name: '', args: [] });
  assert.equal(parseCommand('example.com'), null);
  assert.equal(parseCommand('https://example.com/:extensions'), null);
});
