'use strict';

const list = document.getElementById('list');

// One row per tab, kept between updates. A title change or a new page used to
// rebuild the whole list, which threw away hover, scroll position and the row
// under the pointer; now only what changed is touched.
const rows = new Map();
// One heading per window, kept the same way. The list is the whole browser's
// tabs, so the heading is what says which window a row belongs to.
const headings = new Map();

function createHeading() {
  const heading = document.createElement('div');
  heading.className = 'window';
  return heading;
}

function createRow(id) {
  const row = document.createElement('div');
  row.className = 'tab';
  // The row's identity, so a list can say which tab it is without a second
  // map, and a buffer row can be told apart from a window's tab.
  row.dataset.id = String(id);

  const title = document.createElement('span');
  title.className = 'title';

  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '×';
  close.title = 'Close tab (Ctrl+W)';
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    window.sidebar.act('close', id);
  });

  row.append(title, close);
  row.addEventListener('click', () => window.sidebar.act('activate', id));
  row.addEventListener('mouseup', (event) => {
    if (event.button === 1) {
      event.preventDefault();
      window.sidebar.act('close', id);
    }
  });
  return row;
}

function render(tabs) {
  const keep = new Set();
  const liveHeadings = new Set();
  let placed = null;
  let windowId = null;

  for (const tab of tabs) {
    if (tab.window !== windowId) {
      windowId = tab.window;
      liveHeadings.add(windowId);
      let heading = headings.get(windowId);
      if (!heading) {
        heading = createHeading();
        headings.set(windowId, heading);
      }
      const label = tab.parked ? 'buffers' : tab.here ? 'this window' : `window ${tab.slot}`;
      if (heading.textContent !== label) heading.textContent = label;
      const where = placed ? placed.nextSibling : list.firstChild;
      if (heading !== where) list.insertBefore(heading, where);
      placed = heading;
    }

    keep.add(tab.id);
    let row = rows.get(tab.id);
    if (!row) {
      row = createRow(tab.id);
      rows.set(tab.id, row);
    }

    // Only the focused tab of this window is "the" tab: another window's
    // focused tab is a page that window shows, not this one's. A buffer is a
    // row of its own kind: nothing is showing it, × forgets it, and one that
    // is not loaded yet says so by being dimmed.
    const buffer = tab.parked ? (tab.loaded === false ? ' parked unloaded' : ' parked') : '';
    const className = `tab${tab.here && tab.active ? ' active' : ''}${buffer}`;
    if (row.className !== className) row.className = className;
    const close = row.lastElementChild;
    const closeTitle = tab.parked ? 'Kill buffer' : 'Close tab (Ctrl+W)';
    if (close.title !== closeTitle) close.title = closeTitle;

    const name = tab.title || '';
    const title = row.firstElementChild;
    if (title.textContent !== name) title.textContent = name;
    if (row.title !== name) row.title = name;

    // Only move a row that is not already where it belongs.
    const wanted = placed ? placed.nextSibling : list.firstChild;
    if (row !== wanted) list.insertBefore(row, wanted);
    placed = row;
  }

  for (const [id, row] of rows) {
    if (keep.has(id)) continue;
    rows.delete(id);
    row.remove();
  }
  for (const [id, heading] of headings) {
    if (liveHeadings.has(id)) continue;
    headings.delete(id);
    heading.remove();
  }
}

document.getElementById('new').addEventListener('click', () => window.sidebar.act('new'));

window.sidebar.onTabs(render);
