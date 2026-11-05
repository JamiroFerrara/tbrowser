'use strict';

/**
 * The places the keys have taken you, in the order they took you there.
 *
 * Vim's jump list, with tabs in it: a position is a tab and the page it is
 * showing, so a tab switch is a jump the same way a page is. `back` and
 * `forward` walk the list without adding to it, and a new jump drops the
 * entries ahead of the cursor — the way you did not take is no longer a way
 * forward, which is exactly what C-o then C-i does in the editor.
 *
 * The list is pure data: the caller gives a position (`{ tabId, url }`), the
 * class decides where the cursor lands. Nothing here knows about views.
 */
const LIMIT = 100;

class Jumps {
  constructor(limit = LIMIT) {
    this.limit = limit;
    this.entries = [];
    this.index = -1;
  }

  /** The place the cursor is on, or null while the list is empty. */
  current() {
    return this.entries[this.index] ?? null;
  }

  /**
   * A place the user moved to. Landing on the place the cursor already names
   * changes nothing; landing anywhere else cuts off the forward half and
   * appends.
   */
  record(position) {
    if (!position || !position.url) return;
    const current = this.current();
    if (current && current.tabId === position.tabId && current.url === position.url) return;
    this.entries.splice(this.index + 1);
    this.entries.push({ tabId: position.tabId, url: position.url, index: position.index ?? -1 });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.index = this.entries.length - 1;
  }

  /**
   * The entry `delta` places away, and the cursor there — or null, the cursor
   * untouched, when the list has no such place: the ends stand still.
   */
  move(delta) {
    const next = this.index + delta;
    if (next < 0 || next >= this.entries.length) return null;
    this.index = next;
    return this.entries[next];
  }

  /**
   * A closed tab leaves the list: moving onto a tab that is gone is not a
   * jump, it is a dead end. A cursor on one of its entries steps back to the
   * nearest place before it, which is where the close put you anyway.
   */
  forget(tabId) {
    const current = this.current();
    const before = this.entries.slice(0, this.index).filter((entry) => entry.tabId !== tabId).length;
    this.entries = this.entries.filter((entry) => entry.tabId !== tabId);
    if (!this.entries.length) {
      this.index = -1;
      return;
    }
    this.index = current && current.tabId !== tabId
      ? this.entries.indexOf(current)
      : Math.max(0, Math.min(before - 1, this.entries.length - 1));
  }

  /** Forget everything: a window's tabs were swapped for another set. */
  clear() {
    this.entries = [];
    this.index = -1;
  }
}

module.exports = { Jumps };
