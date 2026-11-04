'use strict';

const list = document.getElementById('list');

// One row per tab, kept between updates. A title change or a new page used to
// rebuild the whole list, which threw away hover, scroll position and the row
// under the pointer; now only what changed is touched.
const rows = new Map();

function createRow(id) {
  const row = document.createElement('div');
  row.className = 'tab';

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
  let placed = null;

  for (const tab of tabs) {
    keep.add(tab.id);
    let row = rows.get(tab.id);
    if (!row) {
      row = createRow(tab.id);
      rows.set(tab.id, row);
    }

    const className = tab.active ? 'tab active' : 'tab';
    if (row.className !== className) row.className = className;

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
}

document.getElementById('new').addEventListener('click', () => window.sidebar.act('new'));

window.sidebar.onTabs(render);
