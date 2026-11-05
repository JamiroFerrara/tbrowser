'use strict';

/**
 * The pages kept loaded for the favourites the user switched on. The pool only
 * does the bookkeeping — what should be ready, what is ready, what a take
 * empties — and the browser hands it `open(url)`, a function that builds and
 * loads one page. Keeping the two apart is what lets the rules be tested
 * without starting a renderer.
 *
 * A page is anything with `failed` and `close()`; the browser's is a view
 * holding a Chromium renderer.
 */
class PreloadPool {
  constructor(open) {
    this.open = open;
    this.pages = new Map(); // url -> page
  }

  /** Make the pool hold exactly these addresses: start what is missing, close the rest. */
  sync(urls) {
    const want = new Set(urls);
    for (const [url, page] of this.pages) {
      if (want.has(url)) continue;
      this.pages.delete(url);
      page.close();
    }
    for (const url of want) {
      if (!this.pages.has(url)) this.pages.set(url, this.open(url));
    }
  }

  /**
   * Hand the page for this address to the browser, or null. A page whose load
   * failed is dropped rather than handed over: the tab then loads it normally.
   */
  take(url) {
    const page = this.pages.get(url);
    if (!page) return null;
    this.pages.delete(url);
    if (page.failed) {
      page.close();
      return null;
    }
    return page;
  }

  urls() {
    return [...this.pages.keys()];
  }

  get size() {
    return this.pages.size;
  }
}

module.exports = { PreloadPool };
