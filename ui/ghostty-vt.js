'use strict';

/**
 * libghostty-vt in WebAssembly: the escape sequences a shell writes, kept as a
 * grid, and the keys a terminal sends back.
 *
 * Ghostty owns the hard part — every VT sequence a program can send, the
 * primary and alternate screens, scrollback, wide characters, styles, and the
 * keyboard modes programs switch on (application cursor keys, the kitty
 * protocol, bracketed paste). This file is the thin, hot layer between that
 * library and the page: bytes in, rows out, keys encoded.
 *
 * It runs where the pixels are. The renderer loads the module once, keeps the
 * terminal next to the canvas that draws it, and reads cells straight out of
 * wasm memory — no process boundary, no per-cell marshalling. That is what
 * makes a frame cost microseconds rather than a message per cell.
 *
 * The module is the release build of libghostty-vt 1.0.1, fetched by
 * `scripts/fetch-ghostty-vt.mjs` and packed with the app.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GhosttyVt = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const RESULT = { SUCCESS: 0, OUT_OF_SPACE: -3, NO_VALUE: -4 };
  const DATA = {
    DIRTY: 3,
    ROW_ITERATOR: 4,
    COLORS: 19,
    CURSOR: 18,
  };
  const ROW_DATA = { CELLS: 3, VIEWPORT_Y: 6 };
  const CELL_DATA = { STYLE: 2, GRAPHEMES_UTF8: 9 };
  const TERMINAL_DATA = { TITLE: 12, VIEWPORT_ACTIVE: 32, MODE: 37 };
  const SCROLL = { DELTA: 2, BOTTOM: 1 };
  const ACTION = { RELEASE: 0, PRESS: 1, REPEAT: 2 };
  const MODS = { SHIFT: 1, CTRL: 2, ALT: 4, SUPER: 8, CAPS_LOCK: 16, NUM_LOCK: 32 };
  const MODE_BRACKETED_PASTE = 2004;

  /** GhosttyKey values, in the order the library's header lists them. */
  const KEY = {
    UNIDENTIFIED: 0, BACKQUOTE: 1, BACKSLASH: 2, BRACKET_LEFT: 3, BRACKET_RIGHT: 4,
    COMMA: 5, DIGIT_0: 6, DIGIT_1: 7, DIGIT_2: 8, DIGIT_3: 9, DIGIT_4: 10,
    DIGIT_5: 11, DIGIT_6: 12, DIGIT_7: 13, DIGIT_8: 14, DIGIT_9: 15, EQUAL: 16,
    INTL_BACKSLASH: 17, INTL_RO: 18, INTL_YEN: 19, A: 20, B: 21, C: 22, D: 23,
    E: 24, F: 25, G: 26, H: 27, I: 28, J: 29, K: 30, L: 31, M: 32, N: 33,
    O: 34, P: 35, Q: 36, R: 37, S: 38, T: 39, U: 40, V: 41, W: 42, X: 43,
    Y: 44, Z: 45, MINUS: 46, PERIOD: 47, QUOTE: 48, SEMICOLON: 49, SLASH: 50,
    ALT_LEFT: 51, ALT_RIGHT: 52, BACKSPACE: 53, CAPS_LOCK: 54, CONTEXT_MENU: 55,
    CONTROL_LEFT: 56, CONTROL_RIGHT: 57, ENTER: 58, META_LEFT: 59, META_RIGHT: 60,
    SHIFT_LEFT: 61, SHIFT_RIGHT: 62, SPACE: 63, TAB: 64, DELETE: 68, END: 69,
    HOME: 71, INSERT: 72, PAGE_DOWN: 73, PAGE_UP: 74, ARROW_DOWN: 75,
    ARROW_LEFT: 76, ARROW_RIGHT: 77, ARROW_UP: 78, ESCAPE: 120,
    F1: 121, F2: 122, F3: 123, F4: 124, F5: 125, F6: 126, F7: 127, F8: 128,
    F9: 129, F10: 130, F11: 131, F12: 132,
  };

  /** The DOM's `KeyboardEvent.code` for the keys above, by name. */
  const CODE = {
    Backquote: 'BACKQUOTE', Backslash: 'BACKSLASH', BracketLeft: 'BRACKET_LEFT',
    BracketRight: 'BRACKET_RIGHT', Comma: 'COMMA', Equal: 'EQUAL', Minus: 'MINUS',
    Period: 'PERIOD', Quote: 'QUOTE', Semicolon: 'SEMICOLON', Slash: 'SLASH',
    Space: 'SPACE', Enter: 'ENTER', NumpadEnter: 'ENTER', Tab: 'TAB',
    Backspace: 'BACKSPACE', Escape: 'ESCAPE', Delete: 'DELETE', Insert: 'INSERT',
    Home: 'HOME', End: 'END', PageUp: 'PAGE_UP', PageDown: 'PAGE_DOWN',
    ArrowUp: 'ARROW_UP', ArrowDown: 'ARROW_DOWN', ArrowLeft: 'ARROW_LEFT',
    ArrowRight: 'ARROW_RIGHT',
  };
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') CODE[`Key${letter}`] = letter;
  for (let digit = 0; digit <= 9; digit += 1) CODE[`Digit${digit}`] = `DIGIT_${digit}`;
  for (let fn = 1; fn <= 12; fn += 1) CODE[`F${fn}`] = `F${fn}`;

  /** The glyph mask bits of a `GhosttyStyle.flags`. */
  const FLAG = {
    BOLD: 1, ITALIC: 2, FAINT: 4, BLINK: 8, INVERSE: 16, INVISIBLE: 32,
    STRIKETHROUGH: 64, OVERLINE: 128,
  };

  /** Style flag bits 8..10 hold the underline kind. */
  const UNDERLINE_SHIFT = 8;
  const UNDERLINE_MASK = 7;

  const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  const decoder = typeof TextDecoder === 'function' ? new TextDecoder() : null;

  /** The module's memory and the helpers that keep views honest across growth. */
  class Lib {
    constructor(instance) {
      this.instance = instance;
      this.e = instance.exports;
      this.buffer = null;
      this.bytes = null;
      this.view = null;
      this.slot = this.e.ghostty_wasm_alloc_opaque();
    }

    /** Re-take the memory views; a wasm allocation may have moved the buffer. */
    sync() {
      const buffer = this.e.memory.buffer;
      if (buffer !== this.buffer) {
        this.buffer = buffer;
        this.bytes = new Uint8Array(buffer);
        this.view = new DataView(buffer);
      }
      return this.view;
    }

    u8(addr) {
      return this.sync().getUint8(addr);
    }

    u16(addr) {
      return this.sync().getUint16(addr, true);
    }

    u32(addr) {
      return this.sync().getUint32(addr, true);
    }

    setU16(addr, value) {
      this.sync().setUint16(addr, value, true);
    }

    setU32(addr, value) {
      this.sync().setUint32(addr, value, true);
    }

    alloc(length) {
      const ptr = this.e.ghostty_wasm_alloc(length);
      if (!ptr) throw new Error('libghostty-vt: out of memory');
      return ptr;
    }

    free(ptr, length) {
      this.e.ghostty_wasm_free(ptr, length);
    }

    /** A fresh opaque out-parameter slot, read back and reset. */
    takeOpaque() {
      return this.e.ghostty_wasm_take_opaque(this.slot);
    }

    opaqueSlot() {
      return this.slot;
    }

    /** Copy bytes into wasm memory; the caller frees the returned pointer. */
    copyIn(bytes) {
      const ptr = this.alloc(bytes.length);
      this.sync();
      this.bytes.set(bytes, ptr);
      return ptr;
    }

    /** The UTF-8 text at a `GhosttyString`, decoded. */
    string(addr) {
      const ptr = this.u32(addr);
      const len = this.u32(addr + 4);
      if (!ptr || !len) return '';
      return decoder.decode(this.bytes.subarray(ptr, ptr + len));
    }

  }

  /** Load the module once per page; every terminal shares it. */
  async function instantiate(bytes) {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new Lib(instance);
  }

  /**
   * One terminal: the grid, the render state that says what changed, and the
   * encoder that turns a key press into the bytes the program expects.
   */
  class Terminal {
    constructor(lib, { cols = 80, rows = 24 } = {}) {
      this.lib = lib;
      this.e = lib.e;
      this.cols = cols;
      this.rows = rows;
      this.freed = false;
      this.onWritePty = null;
      this.onBell = null;
      this.onTitle = null;
      this.onRenderHold = null;

      const e = this.e;
      e.ghostty_terminal_new(0, lib.opaqueSlot(), cols, rows);
      this.handle = lib.takeOpaque();
      if (!this.handle) throw new Error('libghostty-vt: could not create a terminal');

      e.ghostty_render_state_new(0, lib.opaqueSlot());
      this.state = lib.takeOpaque();
      e.ghostty_render_state_row_iterator_new(0, lib.opaqueSlot());
      this.iterator = lib.takeOpaque();
      e.ghostty_render_state_row_cells_new(0, lib.opaqueSlot());
      this.cells = lib.takeOpaque();
      e.ghostty_key_encoder_new(0, lib.opaqueSlot());
      this.keyEncoder = lib.takeOpaque();
      e.ghostty_key_event_new(0, lib.opaqueSlot());
      this.keyEvent = lib.takeOpaque();

      // Scratch that outlives every call: a text buffer per cell, the struct
      // a getter writes into, and the small numbers read back out of them.
      this.scratch = {
        text: lib.alloc(256),
        textStruct: lib.alloc(12), // GhosttyBuffer: ptr, cap, len
        string: lib.alloc(8), // GhosttyString: ptr, len
        u16: lib.alloc(4),
        u32: lib.alloc(4),
        style: lib.alloc(16),
        colors: lib.alloc(784),
        cursor: lib.alloc(20),
        mode: lib.alloc(4),
        keyBuf: lib.alloc(128),
        keyString: lib.alloc(8),
        iterator: lib.alloc(4),
        cells: lib.alloc(4),
        write: 0,
        writeSize: 0,
      };
      this.inputScratch = 0;
      this.inputSize = 0;
      // Styles live as long as the terminal: a run painted in an earlier
      // frame keeps its id, so a later partial frame cannot renumber it.
      this.styles = [null]; // id 0 is the terminal's own default style
      this.styleIndex = new Map();
      this.lastTitle = '';
    }

    /**
     * Feed bytes from the pty.
     *
     * The wasm build has no way to call back into the page, so what the
     * library would report as events is read off the byte stream here: a BEL
     * is a bell, and the title is asked for after a write that could have set
     * one instead of being signalled.
     */
    write(bytes) {
      const length = bytes.length;
      if (!length) return;
      if (this.onBell && bytes.indexOf(7) !== -1) this.onBell();
      if (this.inputSize < length) {
        if (this.inputScratch) this.lib.free(this.inputScratch, this.inputSize);
        this.inputSize = Math.max(1024, length * 2);
        this.inputScratch = this.lib.alloc(this.inputSize);
      }
      this.lib.sync();
      this.lib.bytes.set(bytes, this.inputScratch);
      this.e.ghostty_terminal_vt_write(this.handle, this.inputScratch, length);
      if (length > 3) this.pollTitle();
    }

    /** The title a program set with OSC 0/2, read rather than pushed. */
    pollTitle() {
      if (!this.onTitle) return;
      const title = this.title();
      if (title === this.lastTitle) return;
      this.lastTitle = title;
      this.onTitle(title);
    }

    resize(cols, rows, cellWidth = 0, cellHeight = 0) {
      if (!cols || !rows) return;
      if (cols === this.cols && rows === this.rows && !cellWidth) return;
      this.cols = cols;
      this.rows = rows;
      this.e.ghostty_terminal_resize(this.handle, cols, rows, cellWidth, cellHeight);
    }

    /** Scroll the viewport by whole rows; negative walks back in history. */
    scroll(delta) {
      const behavior = this.lib.alloc(24);
      this.lib.setU32(behavior, SCROLL.DELTA);
      this.lib.sync().setBigInt64(behavior + 8, BigInt(delta), true);
      this.e.ghostty_terminal_scroll_viewport(this.handle, behavior);
      this.lib.free(behavior, 24);
    }

    /** Put the viewport back on the newest output. */
    scrollToBottom() {
      const behavior = this.lib.alloc(24);
      this.lib.setU32(behavior, SCROLL.BOTTOM);
      this.e.ghostty_terminal_scroll_viewport(this.handle, behavior);
      this.lib.free(behavior, 24);
    }

    /** Whether the viewport is following new output at the bottom. */
    atBottom() {
      const scratch = this.scratch.u32;
      const result = this.e.ghostty_terminal_get(this.handle, TERMINAL_DATA.VIEWPORT_ACTIVE, scratch);
      return result !== RESULT.SUCCESS || this.lib.u8(scratch) !== 0;
    }

    title() {
      const scratch = this.scratch.string;
      const result = this.e.ghostty_terminal_get(this.handle, TERMINAL_DATA.TITLE, scratch);
      return result === RESULT.SUCCESS ? this.lib.string(scratch) : '';
    }

    /** The cursor as the renderer draws it, or null when it is off screen. */
    cursor() {
      const scratch = this.scratch.cursor;
      this.lib.setU32(scratch, 20);
      if (this.e.ghostty_render_state_get(this.state, DATA.CURSOR, scratch) !== RESULT.SUCCESS) return null;
      const lib = this.lib;
      if (!lib.u8(scratch + 4)) return null;
      return {
        x: lib.u16(scratch + 6),
        y: lib.u16(scratch + 8),
        wide: lib.u8(scratch + 10) !== 0,
        visible: lib.u8(scratch + 11) !== 0,
        blinking: lib.u8(scratch + 12) !== 0,
        style: lib.u32(scratch + 16),
      };
    }

    /** The colours the frame is drawn with, read once and kept. */
    colors() {
      if (this.palette) return this.palette;
      const scratch = this.scratch.colors;
      this.lib.setU32(scratch, 784);
      if (this.e.ghostty_render_state_get(this.state, DATA.COLORS, scratch) !== RESULT.SUCCESS) return null;
      const lib = this.lib;
      const palette = new Array(256);
      for (let i = 0; i < 256; i += 1) palette[i] = rgbAt(lib, scratch + 14 + i * 3);
      this.palette = {
        background: rgbAt(lib, scratch + 4),
        foreground: rgbAt(lib, scratch + 7),
        cursor: lib.u8(scratch + 13) ? rgbAt(lib, scratch + 10) : null,
        palette,
      };
      return this.palette;
    }

    /** The palette can change with an escape sequence, so re-read it on demand. */
    forgetColors() {
      this.palette = null;
    }

    /**
     * Paint the terminal in the browser's own colours: the background and
     * foreground a cell without a colour of its own is drawn with, and the
     * 256-entry palette an `ls --color` picks its greens from.
     */
    theme({ background, foreground, cursor, palette }) {
      const lib = this.lib;
      const rgb = (hex) => {
        const value = parseInt(hex.slice(1), 16);
        return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
      };
      const slot = lib.alloc(3);
      const set = (option, hex) => {
        const [r, g, b] = rgb(hex);
        lib.sync().setUint8(slot, r);
        lib.sync().setUint8(slot + 1, g);
        lib.sync().setUint8(slot + 2, b);
        this.e.ghostty_terminal_set(this.handle, option, slot);
      };
      if (foreground) set(12, foreground);
      if (background) set(13, background);
      if (cursor) set(14, cursor);
      if (palette && palette.length === 256) {
        const table = lib.alloc(768);
        for (let i = 0; i < 256; i += 1) {
          const [r, g, b] = rgb(palette[i]);
          lib.sync().setUint8(table + i * 3, r);
          lib.sync().setUint8(table + i * 3 + 1, g);
          lib.sync().setUint8(table + i * 3 + 2, b);
        }
        this.e.ghostty_terminal_set(this.handle, 15, table);
        lib.free(table, 768);
      }
      lib.free(slot, 3);
      this.forgetColors();
    }

    /** Whether bracketed paste is on: a paste into vim must not auto-indent. */
    bracketedPaste() {
      const scratch = this.scratch.mode;
      this.lib.setU16(scratch, MODE_BRACKETED_PASTE);
      this.lib.sync().setUint8(scratch + 2, 0);
      if (this.e.ghostty_terminal_get(this.handle, TERMINAL_DATA.MODE, scratch) !== RESULT.SUCCESS) return false;
      return this.lib.u8(scratch + 2) !== 0;
    }

    /**
     * The rows that changed since the last frame, as runs of text.
     *
     * A run is `[x, text, styleId]`: one `fillText` for a whole line of plain
     * output, and the style table holds the colours and the glyph flags. The
     * renderer walks rows and runs, never cells, which is what keeps a frame
     * in the tens of microseconds instead of milliseconds.
     */
    frame({ all = false, reset = false } = {}) {
      const lib = this.lib;
      const e = this.e;
      // The same table every frame: rows from earlier frames still point
      // into it, and `styleId` only appends, never renumbers.
      const styles = this.styles;
      const rows = [];

      // The render state is what the colours and the dirty rows are read from,
      // so it is brought up to date before either is asked for.
      e.ghostty_render_state_update(this.state, this.handle);
      const colors = this.colors();
      if (!colors) return null;
      const dirty = all || reset ? 2 : this.dirty();

      // The library hands the iterator back through a handle already created:
      // a getter writes into the address it is given, not into a fresh slot.
      lib.setU32(this.scratch.iterator, this.iterator);
      if (e.ghostty_render_state_get(this.state, DATA.ROW_ITERATOR, this.scratch.iterator) !== RESULT.SUCCESS) return null;
      this.iterator = lib.u32(this.scratch.iterator);

      const yOut = this.scratch.u16;
      const textStruct = this.scratch.textStruct;
      const text = this.scratch.text;
      lib.setU32(textStruct, text);
      lib.setU32(textStruct + 4, 256);

      for (;;) {
        const more = dirty === 2 ? e.ghostty_render_state_row_iterator_next(this.iterator) : e.ghostty_render_state_row_iterator_next_dirty(this.iterator, yOut);
        if (!more) break;
        let y;
        if (dirty === 2) {
          if (e.ghostty_render_state_row_get(this.iterator, ROW_DATA.VIEWPORT_Y, yOut) === RESULT.SUCCESS) {
            y = lib.u16(yOut);
          }
        } else {
          y = lib.u16(yOut);
        }
        lib.setU32(this.scratch.cells, this.cells);
        if (e.ghostty_render_state_row_get(this.iterator, ROW_DATA.CELLS, this.scratch.cells) !== RESULT.SUCCESS) continue;
        this.cells = lib.u32(this.scratch.cells);
        const cells = this.cells;

        const runs = [];
        let run = null;
        let column = 0;
        const cols = this.cols;
        while (column < cols && e.ghostty_render_state_row_cells_next(cells)) {
          const style = this.cellStyle(cells, colors);
          lib.setU32(textStruct + 8, 0);
          const result = e.ghostty_render_state_row_cells_get(cells, CELL_DATA.GRAPHEMES_UTF8, textStruct);
          const length = lib.u32(textStruct + 8);
          let glyph = '';
          if (result === RESULT.SUCCESS && length > 0) glyph = decodeCell(lib.bytes, text, length);
          if (!glyph && !style) {
            if (run) {
              runs.push(run);
              run = null;
            }
            column += 1;
            continue;
          }
          const id = this.styleId(style, styles);
          const cellText = glyph || ' ';
          if (run && run[2] === id) {
            run[1] += cellText;
          } else {
            if (run) runs.push(run);
            run = [column, cellText, id];
          }
          column += 1 + (isWide(glyph) ? 1 : 0);
        }
        if (run) runs.push(run);
        // Every dirty row is reported, blank ones included: an empty run list
        // is how the renderer learns to erase a line the program cleared.
        rows.push({ y: y ?? 0, runs });
      }

      const cursor = this.cursor();
      e.ghostty_render_state_clean(this.state);
      return { lines: rows, styles, cursor, colors, cols: this.cols, height: this.rows, dirty };
    }

    /** 0 clean, 1 partial, 2 full. */
    dirty() {
      const scratch = this.scratch.u32;
      if (this.e.ghostty_render_state_get(this.state, DATA.DIRTY, scratch) !== RESULT.SUCCESS) return 2;
      return this.lib.u32(scratch);
    }

    /** A cell's style, or null when it is the terminal's own default. */
    cellStyle(cells, colors) {
      const scratch = this.scratch.style;
      if (this.e.ghostty_render_state_row_cells_get(cells, CELL_DATA.STYLE, scratch) !== RESULT.SUCCESS) return null;
      const lib = this.lib;
      const flags = lib.u16(scratch + 12);
      const fg = styleColor(lib, scratch, colors);
      const bg = styleColor(lib, scratch + 4, colors);
      const underline = styleColor(lib, scratch + 8, colors);
      if (!flags && !fg && !bg && !underline) return null;
      return { fg, bg, underline, flags };
    }

    styleId(style, styles) {
      if (!style) return 0;
      const key = `${style.fg}|${style.bg}|${style.underline}|${style.flags}`;
      const seen = this.styleIndex.get(key);
      if (seen !== undefined) return seen;
      const id = styles.length;
      this.styleIndex.set(key, id);
      styles.push(style);
      return id;
    }

    /**
     * One key press as the bytes the running program expects.
     *
     * The encoder is told the terminal's current modes first: whether the
     * program asked for application cursor keys, the kitty keyboard protocol,
     * or modifyOtherKeys decides what an arrow or a ctrl+letter becomes.
     */
    encodeKey(input) {
      const e = this.e;
      const lib = this.lib;
      const key = KEY[CODE[input.code]] ?? letterKey(input);
      const mods =
        (input.shift ? MODS.SHIFT : 0) |
        (input.control ? MODS.CTRL : 0) |
        (input.alt ? MODS.ALT : 0) |
        (input.meta ? MODS.SUPER : 0);

      e.ghostty_key_event_set_action(this.keyEvent, input.repeat ? ACTION.REPEAT : ACTION.PRESS);
      e.ghostty_key_event_set_key(this.keyEvent, key);
      e.ghostty_key_event_set_mods(this.keyEvent, mods);
      const text = input.text ?? printable(input);
      let textPtr = 0;
      let textLen = 0;
      if (text) {
        const bytes = encoder.encode(text);
        textPtr = lib.alloc(bytes.length);
        lib.sync();
        lib.bytes.set(bytes, textPtr);
        textLen = bytes.length;
      }
      // A GhosttyString is passed by value, which on wasm32 is a pointer to
      // the pair: the bytes, then their length.
      const stringSlot = this.scratch.keyString;
      lib.setU32(stringSlot, textPtr);
      lib.setU32(stringSlot + 4, textLen);
      e.ghostty_key_event_set_utf8(this.keyEvent, stringSlot);

      e.ghostty_key_encoder_set_from_terminal(this.keyEncoder, this.handle);
      const out = this.scratch.keyBuf;
      lib.setU32(this.scratch.u32, 0);
      const result = e.ghostty_key_encoder_encode(this.keyEncoder, this.keyEvent, out, 128, this.scratch.u32);
      const written = lib.u32(this.scratch.u32);
      let bytes = null;
      if (result === RESULT.SUCCESS && written > 0) bytes = lib.bytes.slice(out, out + written);
      if (textPtr) lib.free(textPtr, textLen);
      return bytes;
    }

    /** Paste text the way the running program expects it. */
    encodePaste(text) {
      const lib = this.lib;
      const input = encoder.encode(text);
      const source = lib.alloc(input.length);
      lib.sync();
      lib.bytes.set(input, source);
      let size = 0;
      const outLen = this.scratch.u32;
      const probe = this.e.ghostty_paste_encode(source, input.length, this.bracketedPaste(), 0, 0, outLen);
      if (probe !== RESULT.OUT_OF_SPACE && probe !== RESULT.SUCCESS) {
        lib.free(source, input.length);
        return null;
      }
      size = lib.u32(outLen);
      let bytes = null;
      if (size > 0) {
        const out = lib.alloc(size);
        const ok = this.e.ghostty_paste_encode(source, input.length, this.bracketedPaste(), out, size, outLen);
        if (ok === RESULT.SUCCESS) bytes = lib.bytes.slice(out, out + lib.u32(outLen));
        lib.free(out, size);
      }
      lib.free(source, input.length);
      return bytes;
    }

    free() {
      if (this.freed) return;
      this.freed = true;
      const e = this.e;
      try {
        e.ghostty_render_state_row_cells_free(this.cells);
        e.ghostty_render_state_row_iterator_free(this.iterator);
        e.ghostty_render_state_free(this.state);
        e.ghostty_terminal_free(this.handle);
        e.ghostty_key_encoder_free(this.keyEncoder);
        e.ghostty_key_event_free(this.keyEvent);
        if (this.inputScratch) this.lib.free(this.inputScratch, this.inputSize);
      } catch {
        // a terminal already gone with the page
      }
    }
  }

  /** `#rrggbb` from the three bytes at an address. */
  function rgbAt(lib, addr) {
    const value = (lib.u8(addr) << 16) | (lib.u8(addr + 1) << 8) | lib.u8(addr + 2);
    return `#${value.toString(16).padStart(6, '0')}`;
  }

  /** A `GhosttyStyleColor` as a CSS colour, or null for the default. */
  function styleColor(lib, addr, colors) {
    const tag = lib.u8(addr);
    if (tag === 2) return rgbAt(lib, addr + 1);
    if (tag === 1) return colors.palette[lib.u8(addr + 1)] ?? null;
    return null;
  }

  /** A cell's UTF-8 text; the single-byte case skips the decoder. */
  function decodeCell(bytes, ptr, length) {
    if (length === 1) {
      const code = bytes[ptr];
      return code < 0x80 ? String.fromCharCode(code) : decoder.decode(bytes.subarray(ptr, ptr + 1));
    }
    return decoder.decode(bytes.subarray(ptr, ptr + length));
  }

  /** The key of a printable character the physical code did not name. */
  function letterKey(input) {
    const name = String(input.key ?? '').toUpperCase();
    if (name.length === 1 && KEY[name] !== undefined) return KEY[name];
    return KEY.UNIDENTIFIED;
  }

  /** The text a key press types, or undefined for a key that types nothing. */
  function printable(input) {
    const key = input.key;
    if (!key || key.length > 2) return undefined;
    if (key === 'Enter') return '\r';
    if (key === 'Tab') return '\t';
    if (key === 'Backspace') return '\x7f';
    if (key === 'Escape') return '\x1b';
    if (key.length === 1) return key;
    return undefined;
  }

  /** Whether a glyph takes two cells. */
  function isWide(glyph) {
    const code = glyph.codePointAt(0) ?? 0;
    return (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    );
  }

  return {
    instantiate,
    Terminal,
    KEY,
    FLAG,
    UNDERLINE_SHIFT,
    UNDERLINE_MASK,
    MODS,
  };
});
