'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const GhosttyVt = require('../ui/ghostty-vt');

const WASM = path.join(__dirname, '..', 'vendor', 'libghostty-vt', 'ghostty-vt.wasm');

/** A terminal the size of a small window, on the library the app ships. */
async function terminal({ cols = 20, rows = 4 } = {}) {
  assert.ok(fs.existsSync(WASM), `run scripts/fetch-ghostty-vt.mjs first (${WASM})`);
  const lib = await GhosttyVt.instantiate(new Uint8Array(fs.readFileSync(WASM)));
  return new GhosttyVt.Terminal(lib, { cols, rows });
}

/** The text of one row, as the renderer would draw it. */
function rowText(frame, y) {
  const line = frame.lines.find((entry) => entry.y === y);
  if (!line) return '';
  return line.runs.map((run) => run[1]).join('');
}

/** The styles a row's runs point at. */
function rowStyles(frame, y) {
  const line = frame.lines.find((entry) => entry.y === y);
  if (!line) return [];
  return line.runs.map((run) => ({ x: run[0], style: frame.styles[run[2]] }));
}

test('text lands on the grid where the program put it', async () => {
  const term = await terminal();
  term.write(Buffer.from('hello\r\nworld'));
  const frame = term.frame({ reset: true });
  assert.equal(rowText(frame, 0), 'hello');
  assert.equal(rowText(frame, 1), 'world');
  assert.deepEqual(frame.cursor, {
    x: 5,
    y: 1,
    wide: false,
    visible: true,
    blinking: false,
    style: 1,
  });
});

test('a colour and a weight are kept as a style of their own', async () => {
  const term = await terminal();
  term.write(Buffer.from('plain \x1b[1;32mbold green\x1b[0m done'));
  const frame = term.frame({ reset: true });
  const runs = rowStyles(frame, 0);
  assert.deepEqual(
    runs.map((run) => [run.x, run.style ? run.style.flags : 0]),
    [
      [0, 0],
      [6, 1],
      [16, 0],
    ],
  );
  const green = runs[1].style;
  assert.equal(green.fg, frame.colors.palette[2]);
  assert.equal(frame.styles[0], null, 'style id 0 is the terminal default');
});

test('one row changes on a keystroke, not the screen', async () => {
  const term = await terminal();
  term.write(Buffer.from('one\r\ntwo\r\nthree'));
  term.frame({ reset: true });
  term.write(Buffer.from('!'));
  const frame = term.frame();
  assert.equal(frame.dirty, 1);
  assert.deepEqual(frame.lines.map((line) => line.y), [2]);
  assert.equal(rowText(frame, 2), 'three!');
});

test('a resize repaints every row', async () => {
  const term = await terminal();
  term.write(Buffer.from('a\r\nb'));
  term.frame({ reset: true });
  term.resize(30, 5, 8, 16);
  const frame = term.frame();
  assert.equal(frame.dirty, 2);
  assert.equal(frame.lines.length, 5);
  assert.equal(frame.cols, 30);
  assert.equal(frame.height, 5);
  assert.equal(rowText(frame, 1), 'b');
});

test('a wide character takes two columns', async () => {
  const term = await terminal();
  term.write(Buffer.from('a中b'));
  const frame = term.frame({ reset: true });
  assert.equal(rowText(frame, 0), 'a中b');
  assert.equal(frame.cursor.x, 4);
});

test('scrollback moves the viewport, and the bottom is where it started', async () => {
  const term = await terminal({ cols: 20, rows: 3 });
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n');
  term.write(Buffer.from(lines));
  term.frame({ reset: true });
  assert.equal(term.atBottom(), true);
  term.scroll(-5);
  const up = term.frame({ reset: true });
  assert.equal(rowText(up, 0), 'line 22');
  assert.equal(term.atBottom(), false);
  // The pane is what brings the viewport back, not the library: a program
  // printing into a scrolled-up terminal must not yank the reader's place.
  term.scrollToBottom();
  assert.equal(term.atBottom(), true);
});

test('a keystroke is encoded the way the program asked for', async () => {
  const term = await terminal();
  const key = (extra) => {
    const bytes = term.encodeKey({ key: 'a', code: 'KeyA', ...extra });
    return bytes ? Buffer.from(bytes).toString('latin1') : null;
  };
  assert.equal(key({}), 'a');
  assert.equal(key({ shift: true, key: 'A' }), 'A');
  assert.equal(key({ control: true }), '\x01');
  assert.equal(key({ alt: true }), '\x1ba');

  const enter = term.encodeKey({ key: 'Enter', code: 'Enter' });
  assert.equal(Buffer.from(enter).toString('latin1'), '\r');
  const tab = term.encodeKey({ key: 'Tab', code: 'Tab' });
  assert.equal(Buffer.from(tab).toString('latin1'), '\t');
  const backspace = term.encodeKey({ key: 'Backspace', code: 'Backspace' });
  assert.equal(Buffer.from(backspace).toString('latin1'), '\x7f');
});

test('an arrow follows the cursor-key mode the program switched on', async () => {
  const term = await terminal();
  const up = () => Buffer.from(term.encodeKey({ key: 'ArrowUp', code: 'ArrowUp' })).toString('latin1');
  assert.equal(up(), '\x1b[A');
  term.write(Buffer.from('\x1b[?1h')); // application cursor keys, as vim asks
  assert.equal(up(), '\x1bOA');
  term.write(Buffer.from('\x1b[?1l'));
  assert.equal(up(), '\x1b[A');
});

test('a paste is bracketed only when the program asked for it', async () => {
  const term = await terminal();
  const pasted = (text) => Buffer.from(term.encodePaste(text)).toString('latin1');
  assert.equal(pasted('a\nb'), 'a\rb');
  // Inside brackets the newline is the program's to interpret: a TUI keeps
  // its own indentation policy, and the paste arrives as it was copied.
  term.write(Buffer.from('\x1b[?2004h'));
  assert.equal(pasted('a\nb'), '\x1b[200~a\nb\x1b[201~');
});

test('a title is read back after the program sets it', async () => {
  const term = await terminal();
  let seen = '';
  term.onTitle = (title) => {
    seen = title;
  };
  term.write(Buffer.from('\x1b]0;~/src\x07'));
  assert.equal(seen, '~/src');
  assert.equal(term.title(), '~/src');
});

test('the theme paints the terminal in the browser colours', async () => {
  const term = await terminal();
  term.theme({
    background: '#24273a',
    foreground: '#cad3f5',
    cursor: '#f4dbd6',
    palette: Array.from({ length: 256 }, (_, i) => (i === 2 ? '#a6da95' : '#000000')),
  });
  term.write(Buffer.from('\x1b[32mgreen'));
  const frame = term.frame({ reset: true });
  assert.equal(frame.colors.background, '#24273a');
  assert.equal(frame.colors.foreground, '#cad3f5');
  assert.equal(rowStyles(frame, 0)[0].style.fg, '#a6da95');
});
