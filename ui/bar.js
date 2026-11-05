'use strict';

const input = document.getElementById('q');
const hint = document.getElementById('hint');
const list = document.getElementById('list');
const HINT = 'Enter open · Esc close';

let items = [];
let selected = 0;
let queryToken = 0;
let hintTimer = null;
let preselectFirst = false;

function focusInput(value, command, preselect = false) {
  input.value = value || '';
  input.focus();
  preselectFirst = Boolean(preselect);
  if (command) {
    const end = input.value.length;
    input.setSelectionRange(end, end);
  } else {
    input.select();
  }
  selected = 0;
  refresh();
}

function setHint(message, { error = false } = {}) {
  hint.textContent = message;
  hint.classList.toggle('error', error);
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    hint.textContent = HINT;
    hint.classList.remove('error');
  }, error ? 4000 : 2500);
}

function renderRow(item, index) {
  const row = document.createElement('li');
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(index === selected));

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = item.icon;

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = item.title;

  row.append(icon, title);
  if (item.subtitle) {
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = item.subtitle;
    row.append(sub);
  }

  row.addEventListener('mouseenter', () => {
    selected = index;
    paint();
  });
  row.addEventListener('mousedown', (event) => {
    event.preventDefault();
    submit(item.value);
  });
  return row;
}

function paint() {
  [...list.children].forEach((row, index) => {
    row.setAttribute('aria-selected', String(index === selected));
  });
  list.children[selected]?.scrollIntoView({ block: 'nearest' });
}

function render() {
  list.hidden = items.length === 0;
  list.replaceChildren(...items.map(renderRow));
}

async function refresh() {
  const token = ++queryToken;
  const text = input.value;
  const rows = await window.tb.suggest(text);
  // A slower reply for older text must not replace what is on screen now.
  if (token !== queryToken) return;
  items = Array.isArray(rows) ? rows : [];
  // An empty field preselects nothing, so Enter opens what is typed; the
  // moment there are letters, the first row is the one Enter takes — the way
  // Chrome preselects the likeliest page under the address. A picker that has
  // nothing to type into it (Alt+P) asks for its first row instead.
  if (!text.trim() || !items.length) selected = preselectFirst && items.length ? 0 : -1;
  else if (selected < 0 || selected >= items.length) selected = 0;
  preselectFirst = false;
  render();
}

function step(delta) {
  if (!items.length) return;
  selected =
    selected < 0
      ? delta > 0
        ? 0
        : items.length - 1
      : (selected + delta + items.length) % items.length;
  paint();
}

function submit(value) {
  const text = String(value ?? input.value).trim();
  if (text) window.tb.submit(text);
}

window.tb.onEdit(focusInput);
// The bar is already on screen and one of its openers was pressed: put the
// caret back in the field without touching what it holds.
window.tb.onFocus(() => input.focus());
window.tb.onError((message) => setHint(message, { error: true }));
window.tb.onNotice((message) => setHint(message));
// Ctrl+J/Ctrl+K are matched in the main process (they are rebindable there),
// which sends the step here once it knows the list is on screen.
window.tb.onMove(step);

input.addEventListener('input', refresh);

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    const picked = items[selected];
    submit(picked ? picked.value : input.value);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    window.tb.hide();
  } else if (event.key === 'ArrowDown' && items.length) {
    event.preventDefault();
    step(1);
  } else if (event.key === 'ArrowUp' && items.length) {
    event.preventDefault();
    step(-1);
  }
});
