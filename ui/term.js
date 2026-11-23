'use strict';

/**
 * The terminal pane: a canvas, and libghostty-vt in wasm beside it.
 *
 * Everything that costs time is here and nowhere else. A chunk the shell wrote
 * comes in over one IPC message, goes straight into wasm, and the rows it
 * changed are painted on this same turn of the event loop — no second process,
 * no cell-by-cell message. A keystroke is encoded here too, by the library's
 * own key encoder, so application cursor keys, ctrl+arrows and the kitty
 * keyboard protocol all do what the program on the other end asked for.
 */

/** Catppuccin Macchiato: the palette the browser is set up beside. */
const THEME = {
  background: '#24273a',
  foreground: '#cad3f5',
  cursor: '#f4dbd6',
  ansi: [
    '#494d64', '#ed8796', '#a6da95', '#eed49f', '#8aadf4', '#c6a0f6', '#8bd5ca', '#b8c0e0',
    '#5b6078', '#ed8796', '#a6da95', '#eed49f', '#8aadf4', '#c6a0f6', '#8bd5ca', '#a5adcb',
  ],
};

const FONT_SIZE = 13;
const FONT_FAMILY = '"Cascadia Mono", "Consolas", "DejaVu Sans Mono", monospace';
const LINE_HEIGHT = 1.22;
const SELECTION = 'rgba(138, 173, 244, 0.32)';
const BLINK_MS = 530;

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');

let terminal = null;
let lib = null;
let ready = false;
let cols = 80;
let rows = 24;
let cellW = 8;
let cellH = 17;
let dpr = 1;
let colors = null;
/** Per-row runs, the whole screen's model: the last thing drawn at each row. */
let grid = [];
let cursor = null;
let cursorOn = true;
let selection = null; // { from: {x, y}, to: {x, y} } in cells, ordered
let dragging = false;
let exited = false;
let queue = [];
let received = 0;
/** The colour the terminal's own background is drawn in: the window's material. */
let surface = 'transparent';

// --------------------------------------------------------------- the palette

/** The 256 colours the terminal is told about: ANSI above, the cube below. */
function palette() {
  const table = THEME.ansi.slice();
  const steps = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i += 1) {
    const r = steps[Math.floor(i / 36) % 6];
    const g = steps[Math.floor(i / 6) % 6];
    const b = steps[i % 6];
    table.push(`#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`);
  }
  for (let i = 0; i < 24; i += 1) {
    const value = 8 + i * 10;
    table.push(`#${((value << 16) | (value << 8) | value).toString(16).padStart(6, '0')}`);
  }
  return table;
}

// ------------------------------------------------------------------- metrics

/** Measure the font once: every cell is this wide and this tall. */
function measure() {
  ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  // A long sample averages out hinting, which a single glyph does not.
  const width = ctx.measureText('M'.repeat(40)).width / 40;
  cellW = width;
  cellH = Math.round(FONT_SIZE * LINE_HEIGHT);
}

/** Lay the canvas out again and hand back the grid it now holds. */
function fit() {
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  measure();
  return {
    cols: Math.max(20, Math.floor(width / cellW)),
    rows: Math.max(4, Math.floor(height / cellH)),
    cellWidth: Math.round(cellW * dpr),
    cellHeight: Math.round(cellH * dpr),
  };
}

// ------------------------------------------------------------------ painting

/** Whether a style says anything at all. */
function styled(style) {
  return Boolean(style && (style.fg || style.bg || style.flags));
}

/** The font string for a run's flags, cached: a canvas font change is not free. */
const fonts = new Map();
function fontFor(flags) {
  const key = flags & 3;
  let font = fonts.get(key);
  if (!font) {
    const weight = key & 1 ? '700' : '400';
    const style = key & 2 ? 'italic' : 'normal';
    font = `${style} ${weight} ${FONT_SIZE}px ${FONT_FAMILY}`;
    fonts.set(key, font);
  }
  return font;
}

/** Paint one row from the model, selection and all. */
function paintRow(y) {
  const base = colors?.background ?? THEME.background;
  const width = cols * cellW;
  const top = y * cellH;
  if (surface === 'transparent') {
    // The window's own material is the background: erase only, never cover.
    ctx.clearRect(0, top, width, cellH);
  } else {
    ctx.fillStyle = surface;
    ctx.fillRect(0, top, width, cellH);
  }

  const runs = grid[y];
  if (runs) {
    let current = null;
    for (const [x, text, id] of runs) {
      const style = frameStyles[id];
      const flags = style ? style.flags : 0;
      let fg = (style && style.fg) || (colors ? colors.foreground : THEME.foreground);
      let bg = style && style.bg;
      if (flags & 16) {
        // Inverse: the cell is drawn in the colours swapped round.
        const fgSwap = bg || base;
        bg = fg;
        fg = fgSwap;
      }
      const left = x * cellW;
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(left, top, cellW * text.length, cellH);
      }
      if (flags & 32) continue; // invisible text keeps only its background
      const font = fontFor(flags);
      if (font !== current) {
        ctx.font = font;
        current = font;
      }
      ctx.fillStyle = fg;
      const baseline = top + Math.round((cellH + FONT_SIZE * 0.72) / 2);
      ctx.fillText(text, left, baseline);
      if (flags & 8) {
        // Underline bits live above the glyph flags: 0 is none.
        const kind = (flags >> 8) & 7;
        if (kind) {
          ctx.strokeStyle = (style && style.underline) || fg;
          ctx.lineWidth = 1;
          ctx.beginPath();
          const under = baseline + 2;
          ctx.moveTo(left, under + 0.5);
          ctx.lineTo(left + cellW * text.length, under + 0.5);
          ctx.stroke();
        }
      }
      if (flags & 64) {
        ctx.strokeStyle = fg;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const mid = top + Math.round(cellH / 2) + 0.5;
        ctx.moveTo(left, mid);
        ctx.lineTo(left + cellW * text.length, mid);
        ctx.stroke();
      }
    }
  }

  if (selection) paintSelectionRow(y);
}

/** The selected cells of one row, over the background it already has. */
function paintSelectionRow(y) {
  const span = selectionRow(y);
  if (!span) return;
  ctx.fillStyle = SELECTION;
  ctx.fillRect(span.from * cellW, y * cellH, (span.to - span.from + 1) * cellW, cellH);
}

function selectionRow(y) {
  const [a, b] = ordered(selection.from, selection.to);
  if (y < a.y || y > b.y) return null;
  const from = y === a.y ? a.x : 0;
  const to = y === b.y ? b.x : cols - 1;
  return { from, to };
}

function ordered(a, b) {
  if (a.y < b.y || (a.y === b.y && a.x <= b.x)) return [a, b];
  return [b, a];
}

/** The style table of the frame in hand; a run's id indexes it. */
let frameStyles = [];

function drawCursor() {
  if (!cursor || !cursor.visible || exited) return;
  if (cursor.blinking && !cursorOn) return;
  const color = (colors && colors.cursor) || (colors && colors.foreground) || THEME.foreground;
  const left = cursor.x * cellW;
  const top = cursor.y * cellH;
  ctx.fillStyle = color;
  if (cursor.style === 0) {
    // Bar: a vertical stroke on the left edge of the cell.
    ctx.fillRect(left, top, Math.max(1, Math.round(cellW * 0.15)), cellH);
  } else if (cursor.style === 2) {
    ctx.fillRect(left, top + cellH - 2, cellW, 2);
  } else if (cursor.style === 3) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 0.5, top + 0.5, cellW - 1, cellH - 1);
  } else {
    ctx.fillRect(left, top, cellW, cellH);
  }
}

// ------------------------------------------------------------------- running

/**
 * Paint everything the shell has written since the last frame.
 *
 * A full redraw (a resize, a scrolled viewport, the first frame) replaces the
 * whole model; a partial one patches the rows the library calls dirty, which
 * on a keystroke is one row of one line.
 */
function flush() {
  if (!terminal || !ready) return;
  const frame = terminal.frame();
  if (!frame) return;
  colors = frame.colors;
  cursor = frame.cursor;
  frameStyles = frame.styles;
  if (frame.dirty === 2) {
    grid = [];
    for (const line of frame.lines) {
      grid[line.y] = line.runs;
      paintRow(line.y);
    }
    drawCursor();
    return;
  }
  for (const line of frame.lines) {
    grid[line.y] = line.runs;
    paintRow(line.y);
  }
  drawCursor();
}

function onData(bytes) {
  received += bytes.length;
  if (!terminal) {
    queue.push(bytes);
    return;
  }
  terminal.write(bytes);
  flush();
}

async function boot() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  const size = fit();
  const bytes = await window.term.wasm();
  lib = await GhosttyVt.instantiate(new Uint8Array(bytes));
  // The shell is told the size the canvas can hold; the reply is the size it
  // actually got, which is what the terminal must agree with.
  const started = await window.term.start(size);
  if (started.error) {
    window.__terminalError = started.error;
    showError(started.error);
    return;
  }
  surface = started.background ?? 'transparent';
  cols = started.cols;
  rows = started.rows;
  terminal = new GhosttyVt.Terminal(lib, { cols, rows });
  terminal.theme({
    background: THEME.background,
    foreground: THEME.foreground,
    cursor: THEME.cursor,
    palette: palette(),
  });
  terminal.onTitle = (title) => window.term.title(title);
  terminal.onBell = () => {
    document.body.classList.remove('bell');
    // Forcing a reflow restarts the animation for a second bell.
    void document.body.offsetWidth;
    document.body.classList.add('bell');
  };
  terminal.resize(cols, rows, size.cellWidth, size.cellHeight);
  ready = true;
  colors = terminal.colors();
  grid = [];
  const frame = terminal.frame({ reset: true });
  if (frame) {
    flush();
  }
  for (const chunk of queue) terminal.write(chunk);
  queue = [];
  flush();
  canvas.focus();
}

// ---------------------------------------------------------------- the keyboard

function send(bytes) {
  if (!bytes || !bytes.length || exited) return;
  window.term.input(bytes);
}

/**
 * Typing is how a reader says they are done reading history: the viewport goes
 * back to the newest output before the key lands, as it does in every other
 * terminal.
 */
function followOutput() {
  if (!terminal || exited || terminal.atBottom()) return;
  terminal.scrollToBottom();
  const frame = terminal.frame({ reset: true });
  if (!frame) return;
  colors = frame.colors;
  cursor = frame.cursor;
  frameStyles = frame.styles;
  grid = [];
  for (const line of frame.lines) grid[line.y] = line.runs;
  repaintAll();
}

/** Copy the selection, or the whole screen when nothing is selected. */
function copy() {
  const text = selectedText();
  if (text) window.term.copy(text);
}

/** Read the selected cells out of the model the frame left behind. */
function selectedText() {
  if (!selection) return '';
  const [a, b] = ordered(selection.from, selection.to);
  const lines = [];
  for (let y = a.y; y <= b.y; y += 1) {
    const from = y === a.y ? a.x : 0;
    const to = y === b.y ? b.x : cols - 1;
    let text = '';
    let column = 0;
    for (const [, runText] of grid[y] ?? []) {
      for (const char of runText) {
        if (column >= from && column <= to) text += char;
        column += char.codePointAt(0) > 0x2e7f ? 2 : 1;
      }
    }
    lines.push(text.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

async function paste() {
  const text = await window.term.paste();
  if (!text) return;
  followOutput();
  send(terminal ? terminal.encodePaste(text) : null);
}

function keydown(event) {
  if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') return;
  if (exited) return;

  // The two chords Windows Terminal gives every paste and copy, plus the
  // Insert pair the old consoles used.
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyV') {
    event.preventDefault();
    paste();
    return;
  }
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
    event.preventDefault();
    copy();
    return;
  }
  if (event.shiftKey && event.code === 'Insert') {
    event.preventDefault();
    paste();
    return;
  }
  if (event.ctrlKey && event.code === 'Insert') {
    event.preventDefault();
    copy();
    return;
  }
  followOutput();
  // ctrl+shift+plus/minus/0 are the browser's page zoom, which main already
  // took; a bare ctrl+anything else is the shell's.
  const bytes = terminal?.encodeKey({
    key: event.key,
    code: event.code,
    control: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    repeat: event.repeat,
    // Only a real character is text: named keys must go through the library's
    // own mapping, or Enter arrives as the word "Enter" rather than CR.
    text: event.key.length === 1 ? event.key : undefined,
  });
  // Everything is the terminal's: Chromium must not scroll the page, walk the
  // focus ring, or open its own find bar.
  event.preventDefault();
  send(bytes);
}

// ------------------------------------------------------------------- the mouse

function cellAt(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(cols - 1, Math.floor((event.clientX - rect.left) / cellW))),
    y: Math.max(0, Math.min(rows - 1, Math.floor((event.clientY - rect.top) / cellH))),
  };
}

function mousedown(event) {
  canvas.focus();
  if (exited) return;
  if (event.button === 2) {
    event.preventDefault();
    paste();
    return;
  }
  if (event.button !== 0) return;
  const cell = cellAt(event);
  if (event.shiftKey && selection) {
    selection = { from: selection.from, to: cell };
  } else {
    selection = { from: cell, to: { ...cell } };
    dragging = true;
  }
  repaintAll();
}

function mousemove(event) {
  if (!dragging || !selection) return;
  const cell = cellAt(event);
  if (cell.x === selection.to.x && cell.y === selection.to.y) return;
  selection = { from: selection.from, to: cell };
  repaintAll();
}

function mouseup() {
  if (!dragging) return;
  dragging = false;
  // A click that selected a single cell is a click, not a selection.
  if (selection && selection.from.x === selection.to.x && selection.from.y === selection.to.y) {
    selection = null;
    repaintAll();
  }
}

function repaintAll() {
  for (let y = 0; y < rows; y += 1) paintRow(y);
  drawCursor();
}

function wheel(event) {
  if (!terminal || exited) return;
  event.preventDefault();
  const lines = event.deltaMode === 1 ? event.deltaY : Math.round(event.deltaY / cellH);
  if (!lines) return;
  terminal.scroll(-lines);
  const frame = terminal.frame({ reset: true });
  if (frame) {
    colors = frame.colors;
    cursor = frame.cursor;
    frameStyles = frame.styles;
    grid = [];
    for (const line of frame.lines) grid[line.y] = line.runs;
    repaintAll();
  }
}

/** One line across the top of the pane, in the terminal's own font. */
function showError(message) {
  window.__terminalError = message;
  ctx.save();
  ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  ctx.fillStyle = '#ed8796';
  ctx.fillText(message, 12, FONT_SIZE + 8);
  ctx.restore();
}

// -------------------------------------------------------------------- wiring

window.term.onData(onData);
window.term.onError((message) => {
  exited = true;
  cursor = null;
  showError(message);
});

window.term.onExit(() => {
  exited = true;
  cursor = null;
  // The shell is gone: say so on the last line, and let the window close the
  // pane it was in.
  if (surface === 'transparent') ctx.clearRect(0, rows * cellH - cellH, cols * cellW, cellH);
  else {
    ctx.fillStyle = surface;
    ctx.fillRect(0, rows * cellH - cellH, cols * cellW, cellH);
  }
  ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  ctx.fillStyle = '#6e738d';
  ctx.fillText('[shell exited]', 0, rows * cellH - Math.round(cellH * 0.25));
});

canvas.addEventListener('keydown', keydown);
canvas.addEventListener('mousedown', mousedown);
window.addEventListener('mousemove', mousemove);
window.addEventListener('mouseup', mouseup);
canvas.addEventListener('wheel', wheel, { passive: false });
canvas.addEventListener('contextmenu', (event) => event.preventDefault());

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  // The drag of a window edge fires this every pixel; one relayout per frame
  // is plenty, and the shell only hears about the size it ends up with.
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    const size = fit();
    if (!terminal) return;
    if (size.cols === cols && size.rows === rows) {
      terminal.resize(cols, rows, size.cellWidth, size.cellHeight);
      return;
    }
    cols = size.cols;
    rows = size.rows;
    terminal.resize(cols, rows, size.cellWidth, size.cellHeight);
    window.term.resize(size);
    const frame = terminal.frame({ reset: true });
    colors = frame?.colors ?? colors;
    cursor = frame?.cursor ?? null;
    frameStyles = frame?.styles ?? frameStyles;
    grid = [];
    if (frame) for (const line of frame.lines) grid[line.y] = line.runs;
    repaintAll();
  }, 12);
});

// A blinking cursor is the terminal saying it is still there: toggle it twice
// a second, and repaint only the row it sits on.
setInterval(() => {
  if (!terminal || !cursor || !cursor.blinking || exited) return;
  cursorOn = !cursorOn;
  paintRow(cursor.y);
  drawCursor();
}, BLINK_MS);

/**
 * The pane's own model, for devtools and for the harness that checks the
 * terminal end to end: what the screen holds, where the cursor is, and the
 * size the shell was told.
 */
window.__terminal = {
  get term() {
    return terminal;
  },
  get grid() {
    return grid;
  },
  get size() {
    return { cols, rows };
  },
  get bytes() {
    return received;
  },
};

boot().catch((err) => {
  window.__terminalError = err.message;
  showError(err.message);
});
