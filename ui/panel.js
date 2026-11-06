'use strict';

const title = document.getElementById('title');
const sub = document.getElementById('sub');
const content = document.getElementById('content');
const nav = document.getElementById('nav');
const actionsBar = document.getElementById('actions');
const status = document.getElementById('status');

/** What each keybinding action does, in the words the settings page shows. */
const ACTION_LABELS = {
  openBar: 'Open command bar',
  search: 'Search the web',
  closeBar: 'Close command bar',
  reload: 'Reload page',
  back: 'Back',
  forward: 'Forward',
  jumpBack: 'Jump back (last tab or page)',
  jumpForward: 'Jump forward',
  newTab: 'New tab',
  closeTab: 'Close tab',
  nextTab: 'Next tab',
  prevTab: 'Previous tab',
  nextSuggestion: 'Next suggestion',
  prevSuggestion: 'Previous suggestion',
  toggleSidebar: 'Toggle sidebar',
  workspaces: 'Session picker',
  splitVertical: 'Split side by side',
  splitHorizontal: 'Split stacked',
  focusPane: 'Move between panes',
  devtools: 'Developer tools',
  newWindow: 'New window',
  closeWindow: 'Close window',
  quit: 'Quit',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionLabel(action) {
  return ACTION_LABELS[action] ?? action.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

// ---------------------------------------------------------------- extensions

let extStatus;

function setExtStatus(text, kind) {
  if (!extStatus) return;
  extStatus.className = `status ${kind ?? ''}`.trim();
  extStatus.textContent = text;
}

function extensionButton(text, onClick, className = '') {
  const button = el('button', className, text);
  button.addEventListener('click', onClick);
  return button;
}

/** One card: what the extension is, what it may do, and what you can do to it. */
function extCard(extension) {
  const card = el('div', `card ext${extension.enabled ? '' : ' off'}`);

  const icon = el('div', 'ext-icon');
  if (extension.icon) {
    const image = new Image();
    image.src = extension.icon;
    image.alt = '';
    icon.append(image);
  } else {
    icon.textContent = (extension.name || '?').trim().charAt(0).toUpperCase() || '?';
  }

  const body = el('div', 'ext-body');
  const heading = el('h2', '', extension.name || 'Untitled extension');
  if (extension.version) heading.append(el('span', 'ext-version', extension.version));
  body.append(heading);
  if (extension.description) body.append(el('p', 'ext-desc', extension.description));
  body.append(el('div', 'meta', extension.id ? `${extension.id} · ${extension.path}` : extension.path));
  if (extension.permissions.length) {
    body.append(el('div', 'ext-perms', `Can use: ${extension.permissions.join(', ')}`));
  }

  const actions = el('div', 'row');
  const toggle = el('label', 'switch');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = extension.enabled;
  box.addEventListener('change', () => {
    box.disabled = true;
    runExtensionAction(extension, box.checked ? 'enable' : 'disable');
  });
  toggle.append(box, el('span', '', extension.enabled ? 'On' : 'Off'));
  actions.append(toggle);
  if (extension.enabled) {
    if (extension.options) actions.append(extensionButton('Settings', () => runExtensionAction(extension, 'options')));
    actions.append(extensionButton('Reload', () => runExtensionAction(extension, 'reload')));
  }
  actions.append(extensionButton('Folder', () => runExtensionAction(extension, 'folder')));
  body.append(actions);

  card.append(icon, body);
  return card;
}

async function runExtensionAction(extension, action) {
  if (extStatus) extStatus.textContent = '';
  const result = await window.panel.extension({ action, id: extension.id, path: extension.path });
  if (!result.ok) {
    renderExtensions(result);
    setExtStatus(result.error, 'err');
    return;
  }
  const name = extension.name || 'Extension';
  renderExtensions(result);
  const messages = {
    enable: `${name} is on.`,
    disable: `${name} is off — it stays installed, and comes back on when you switch it on.`,
    reload: `${name} reloaded.`,
    folder: `Opened the folder for ${name}.`,
  };
  if (messages[action]) setExtStatus(messages[action], 'ok');
}

function renderExtensions(data) {
  title.textContent = 'Extensions';
  nav.hidden = true;
  actionsBar.hidden = true;
  status.className = 'status';
  status.textContent = '';
  const off = data.extensions.length - data.loaded;
  sub.textContent = `${data.loaded} of ${data.extensions.length} on${off ? `, ${off} switched off` : ''}. Turn one off to stop it running; its settings page opens in a tab.`;

  const toolbar = el('div', 'row');
  const rescan = el('button', '', 'Rescan');
  rescan.title = 'Look in the extension folders again';
  rescan.addEventListener('click', async () => {
    rescan.disabled = true;
    renderExtensions(await window.panel.rescan());
  });
  toolbar.append(rescan);
  for (const dir of data.dirs) {
    const open = el('button', '', dir.split(/[\\/]/).pop());
    open.title = dir;
    open.addEventListener('click', () => window.panel.openPath(dir));
    toolbar.append(open);
  }
  extStatus = el('div', 'status');
  const cards = data.extensions.map(extCard);
  content.replaceChildren(toolbar, ...cards, extStatus);
  if (!data.extensions.length) {
    content.append(el('p', 'meta', 'No extensions found. Drop a folder into one of the extension directories, then rescan.'));
  }
}

// ------------------------------------------------------------------ settings

let model = null; // the last settings payload: config, configPath, defaults
let dirty = false;
/** The settings section the sidebar shows; kept across a redraw. */
let categoryIndex = 0;

function markDirty() {
  dirty = true;
}

/** One labelled control: a caption, the control, and a line saying what it does. */
function field(caption, control, hint) {
  const wrap = el('div', 'field');
  const label = el('label', 'field-label');
  label.append(caption);
  if (control.type === 'checkbox') label.prepend(control);
  wrap.append(label, control, hint ? el('div', 'hint', hint) : el('div'));
  return wrap;
}

function group(heading, ...fields) {
  const section = el('section', 'group');
  section.append(el('h2', '', heading), ...fields);
  return section;
}

function checkbox(checked, { dirty = true } = {}) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  if (dirty) input.addEventListener('change', markDirty);
  return input;
}

function textInput(value, hint) {
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.value = value;
  input.placeholder = hint ?? '';
  input.addEventListener('input', markDirty);
  return input;
}

/** A text field of its own: a favourite row saves itself, not the settings form. */
function plainInput(value, placeholder, className) {
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.value = value ?? '';
  input.placeholder = placeholder ?? '';
  if (className) input.className = className;
  return input;
}

/** One editable favourite: its title, its address, its preload switch, Remove. */
function favouriteRow(fav) {
  const row = el('div', 'fav-row');
  const warm = checkbox(fav.warm === true, { dirty: false });
  warm.className = 'warm-box';
  warm.dataset.url = fav.url;
  warm.title = 'Keep this page loaded in the background';
  warm.addEventListener('change', async () => {
    const result = await favouriteAction({ action: 'warm', url: fav.url, warm: warm.checked });
    if (!result.ok) warm.checked = fav.warm === true;
  });

  const title = plainInput(fav.title, 'Title', 'fav-title');
  title.setAttribute('aria-label', 'Favourite title');
  const url = plainInput(fav.url, 'https://example.com', 'fav-address');
  url.setAttribute('aria-label', 'Favourite address');

  const commit = async () => {
    const nextTitle = title.value.trim();
    const nextUrl = url.value.trim();
    if (nextTitle === (fav.title ?? '') && nextUrl === fav.url) return;
    const result = await favouriteAction({ action: 'save', from: fav.url, url: nextUrl, title: nextTitle });
    if (!result.ok) {
      // The row goes back to what is stored: a save that failed left no trace.
      title.value = fav.title ?? '';
      url.value = fav.url;
    }
  };
  for (const input of [title, url]) {
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      commit();
    });
  }

  const remove = el('button', 'fav-remove ghost', 'Remove');
  remove.title = 'Forget this favourite';
  remove.addEventListener('click', () => favouriteAction({ action: 'remove', url: fav.url }));

  row.append(warm, title, url, remove);
  return row;
}

/** The fields that add one: a title to tell it apart, and the address. */
function favouriteNewRow() {
  const row = el('div', 'fav-new');
  const title = plainInput('', 'Title (optional)', 'fav-title');
  title.setAttribute('aria-label', 'New favourite title');
  const url = plainInput('', 'https://example.com', 'fav-address');
  url.setAttribute('aria-label', 'New favourite address');
  const add = el('button', 'primary', 'Add favourite');

  const commit = async () => {
    if (!url.value.trim()) {
      setStatus('A favourite needs an address.', 'err');
      url.focus();
      return;
    }
    const result = await favouriteAction({ action: 'save', url: url.value, title: title.value });
    if (result.ok) setStatus('Favourite saved.', 'ok');
  };
  add.addEventListener('click', commit);
  for (const input of [title, url]) {
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      commit();
    });
  }

  row.append(el('span', 'fav-gap'), title, url, add);
  return row;
}

/** The keybinding rows, with the actions the running config knows first. */
function keyRows(config, defaults) {
  const known = new Set([...Object.keys(defaults.keybindings ?? {}), ...Object.keys(config.keybindings ?? {})]);
  const rows = [];
  for (const action of known) {
    const row = el('div', 'kbd-row');
    const input = textInput((config.keybindings[action] ?? []).join(', '), 'ctrl+l, ctrl+k');
    input.className = 'kbd-input';
    input.dataset.action = action;
    const reset = el('button', 'ghost', 'Reset');
    reset.title = `Back to ${(defaults.keybindings[action] ?? []).join(', ') || 'unset'}`;
    reset.addEventListener('click', () => {
      input.value = (defaults.keybindings[action] ?? []).join(', ');
      markDirty();
    });
    row.append(el('div', 'kbd-label', actionLabel(action)), input, reset);
    rows.push(row);
  }
  return rows;
}

function setStatus(text, kind) {
  status.className = `status ${kind ?? ''}`.trim();
  status.textContent = text;
}

// --------------------------------------------------------------- favourites

let favouritesSection = null;

/**
 * One round trip to the browser, then the list redraws from the answer. Each
 * edit is saved on its own, so the rows always show what the browser stored.
 */
async function favouriteAction(request) {
  let result;
  try {
    result = await window.panel.favourites(request);
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  if (!result.ok) {
    setStatus(result.error, 'err');
    return result;
  }
  model.favourites = result.favourites ?? [];
  renderFavourites();
  return result;
}

function renderFavourites() {
  if (!favouritesSection) return;
  const list = model.favourites ?? [];
  favouritesSection.replaceChildren(
    el('h2', '', 'Favourites'),
    el(
      'div',
      'hint',
      'The pages the bar suggests first. Edit one here and the list, the suggestions and what stays loaded follow straight away — nothing to Save.',
    ),
    ...(list.length
      ? list.map(favouriteRow)
      : [el('div', 'hint', 'No favourites yet — add one below, or star the page you are on with :fav.')]),
    favouriteNewRow(),
  );
}

// ------------------------------------------------------------------ sessions

let sessionsSection = null;

/** "5 Nov 2026, 17:40" — enough to tell two saved sets apart. */
function savedLabel(at) {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * One round trip to the browser, then the section redraws from the answer.
 * Only the section is replaced: a config field the user is half-way through
 * editing keeps what was typed.
 */
async function sessionAction(request) {
  const result = await window.panel.sessions(request);
  if (!result.ok) {
    // A refused rename leaves the rejected text in the field; the list is the
    // truth, so draw it again rather than let the row lie about its name.
    renderSessions();
    setStatus(result.error, 'err');
    return result;
  }
  if (result.sessions) model.sessions = result.sessions;
  renderSessions();
  return result;
}

/** One session: its name in a field, what it holds, and what can be done to it. */
function sessionRow(entry) {
  const row = el('div', 'session-row');
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'session-name';
  name.spellcheck = false;
  name.value = entry.name;
  name.setAttribute('aria-label', 'Session name');

  const meta = el('div', 'session-meta');
  meta.textContent = [
    `${entry.tabs} tab${entry.tabs === 1 ? '' : 's'}`,
    `${entry.attached ?? 0} attached`,
    entry.saved ? `saved ${savedLabel(entry.savedAt)}` : 'not saved — gone when the browser quits',
    entry.current ? 'this window' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  // Up and down are the jumps: Ctrl+1..Ctrl+9 follow the order here.
  const up = el('button', 'session-up ghost', '↑');
  up.title = 'Jump to this session earlier (Ctrl+' + entry.order + ')';
  up.addEventListener('click', () => sessionAction({ action: 'up', name: entry.name }));
  const down = el('button', 'session-down ghost', '↓');
  down.title = 'Jump to this session later';
  down.addEventListener('click', () => sessionAction({ action: 'down', name: entry.name }));

  const open = el('button', 'session-open', 'Attach');
  open.addEventListener('click', () => sessionAction({ action: 'open', name: entry.name }));

  const rename = el('button', 'session-rename', 'Rename');
  const applyName = async () => {
    const next = name.value.trim();
    if (!next || next === entry.name) return;
    const result = await sessionAction({ action: 'rename', name: entry.name, to: next });
    if (result.ok) setStatus(`renamed session "${entry.name}" to "${next}"`, 'ok');
  };
  rename.addEventListener('click', applyName);
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyName();
  });

  const remove = el('button', 'session-delete ghost', 'Kill');
  remove.addEventListener('click', async () => {
    const result = await sessionAction({ action: 'kill', name: entry.name });
    if (result.ok) setStatus(`killed session "${entry.name}"`, 'ok');
  });

  row.append(name, meta, up, down, open, rename, remove);
  return row;
}

/** The list plus the field that keeps what this window shows now under a name. */
function renderSessions() {
  if (!sessionsSection) return;
  const list = model.sessions ?? [];
  const rows = list.length
    ? list.map(sessionRow)
    : [el('div', 'hint', 'No sessions yet. Save this window below, or from the bar with :session save.')];

  const fresh = el('div', 'session-new');
  const name = document.createElement('input');
  name.type = 'text';
  name.id = 'session-new-name';
  name.placeholder = 'name for this window’s tabs';
  name.spellcheck = false;
  const keep = async () => {
    const result = await sessionAction({ action: 'save', name: name.value.trim() });
    if (!result.ok) return;
    const made = (result.sessions ?? []).find((entry) => entry.current);
    if (made) setStatus(`saved this window as "${made.name}"`, 'ok');
  };
  const save = el('button', 'primary', 'Save session');
  save.addEventListener('click', keep);
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') keep();
  });
  fresh.append(name, save);

  sessionsSection.replaceChildren(
    el('h2', '', 'Sessions'),
    el(
      'div',
      'hint',
      'A session is a set of tabs and the windows attached to it: attach this window to one to show its tabs, or kill one to end it. The order here is the order Ctrl+1..Ctrl+9 jump in; the arrows move a session up and down. Alt+P lists the same sessions.',
    ),
    ...rows,
    fresh,
  );
}

function collect() {
  const keybindings = {};
  for (const input of content.querySelectorAll('.kbd-input')) keybindings[input.dataset.action] = input.value;
  return {
    searchUrl: content.querySelector('#setting-search-url').value,
    adblock: content.querySelector('#setting-adblock').checked,
    resident: content.querySelector('#setting-resident').checked,
    preload: content.querySelector('#setting-preload').checked,
    blur: content.querySelector('#setting-blur').checked,
    blurColor: content.querySelector('#setting-blur-color').value,
    blurOpacity: content.querySelector('#setting-blur-opacity').value,
    blurMaterial: content.querySelector('#setting-blur-material').value,
    keybindings,
  };
}

function renderSettings(data) {
  model = { ...model, ...data };
  dirty = false;

  title.textContent = 'Settings';
  sub.textContent = 'Saved to the config file and applied straight away — no restart.';

  const searchUrl = textInput(model.config.searchUrl, 'https://www.google.com/search?q=');
  searchUrl.id = 'setting-search-url';
  const adblock = checkbox(model.config.adblock);
  adblock.id = 'setting-adblock';
  const resident = checkbox(model.config.resident);
  resident.id = 'setting-resident';
  const preload = checkbox(model.config.preload);
  preload.id = 'setting-preload';
  const blur = checkbox(model.config.blur);
  blur.id = 'setting-blur';
  const blurColor = textInput(model.config.blurColor, '#24273a');
  blurColor.id = 'setting-blur-color';
  const blurOpacity = textInput(String(model.config.blurOpacity), '37');
  blurOpacity.id = 'setting-blur-opacity';
  const blurMaterial = textInput(model.config.blurMaterial, 'mica');
  blurMaterial.id = 'setting-blur-material';

  const save = el('button', 'primary', 'Save');
  const revert = el('button', '', 'Revert');
  const open = el('button', '', 'Show config file');
  open.addEventListener('click', () => window.panel.openPath(model.configPath));

  save.addEventListener('click', async () => {
    save.disabled = true;
    let result;
    try {
      result = await window.panel.saveSettings(collect());
    } catch (err) {
      // A failed save must never leave the button dead with nothing said.
      save.disabled = false;
      setStatus(`could not save: ${err.message}`, 'err');
      return;
    }
    save.disabled = false;
    if (!result.ok) {
      setStatus(result.error, 'err');
      return;
    }
    // The browser answers with what it stored, switches included: the form
    // then shows the state it will obey rather than the boxes it just sent.
    renderSettings({ config: result.config, favourites: result.favourites });
    setStatus('Saved — every change is already in effect.', 'ok');
  });
  revert.addEventListener('click', () => {
    renderSettings({ config: model.config });
    setStatus('Unsaved changes dropped.', '');
  });

  actionsBar.replaceChildren(save, revert, open);
  actionsBar.hidden = false;
  nav.hidden = false;
  status.className = 'status';

  sessionsSection = el('section', 'group');
  renderSessions();
  favouritesSection = el('section', 'group');
  renderFavourites();

  const sections = [
    group(
      'Search',
      field(el('span', '', 'Search engine URL'), searchUrl, 'What :s sends the query to. The query is appended, so it ends in q=.'),
    ),
    group(
      'Browsing',
      field(el('span', '', 'Block ads and trackers'), adblock, 'The built-in engine, used unless uBlock Origin loaded.'),
    ),
    group(
      'Look',
      field(
        el('span', '', 'Blur the desktop behind the window'),
        blur,
        'Windows 11 acrylic: the empty tab, the command bar, the sidebar and this page go transparent over a blurred desktop. Off, every surface is painted its own colour.',
      ),
      field(
        el('span', '', 'Blur tint'),
        blurColor,
        'The colour laid over the blur, as #rrggbb. 37 at #24273a is the Catppuccin Macchiato terminal this browser was set up beside.',
      ),
      field(
        el('span', '', 'Blur opacity'),
        blurOpacity,
        'How much of the tint covers the blur, 0–100. 0 is the bare blur, 100 is the tint alone.',
      ),
      field(
        el('span', '', 'Blur material'),
        blurMaterial,
        'acrylic is the brush the Windows Terminal paints: it blurs what is behind the window and keeps blurring when another window takes the focus. mica is Windows\' own, drawn from the wallpaper and much subtler.',
      ),
    ),
    group(
      'Startup',
      field(el('span', '', 'Stay running when the last window closes'), resident, 'Keeps the process warm so the next window opens instantly.'),
    ),
    group(
      'Preloaded favourites',
      field(
        el('span', '', 'Keep favourite pages ready to open'),
        preload,
        'A favourite switched on in the list below stays loaded in the background, so opening it is instant. One left for a while is fetched again when you come back to it.',
      ),
    ),
    favouritesSection,
    sessionsSection,
    (() => {
      const section = el('section', 'group');
      section.append(
        el('h2', '', 'Keys'),
        el('div', 'hint', 'Comma-separated, e.g. ctrl+l, ctrl+k. One key still wins: the first row that matches.'),
        ...keyRows(model.config, model.defaults ?? { keybindings: {} }),
      );
      return section;
    })(),
  ];

  // The sidebar is one entry per section, and only the chosen section shows.
  // Every section stays in the DOM: a half-typed field survives a switch, and
  // Save still collects the whole form.
  const buttons = sections.map((section, index) => {
    const button = el('button', '', section.querySelector('h2').textContent);
    button.type = 'button';
    button.addEventListener('click', () => showCategory(index, true));
    // The list is walkable with the arrows once one entry has the focus, the
    // way a native tab strip behaves.
    button.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = (index + step + sections.length) % sections.length;
      showCategory(next, true);
      buttons[next].focus();
    });
    return button;
  });
  const showCategory = (index, scroll) => {
    categoryIndex = Math.min(Math.max(index, 0), sections.length - 1);
    sections.forEach((section, i) => {
      section.hidden = i !== categoryIndex;
    });
    buttons.forEach((button, i) => {
      button.classList.toggle('active', i === categoryIndex);
      if (i === categoryIndex) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
    if (scroll) content.closest('main').scrollTop = 0;
  };

  nav.replaceChildren(el('div', 'nav-title', 'Settings'), ...buttons);
  content.replaceChildren(...sections);
  showCategory(categoryIndex);
}

// While a field holds focus its keystrokes are its own — ":" and ctrl+w are
// characters there, not shortcuts.
content.addEventListener('focusin', () => window.panel.setEditing(true));
content.addEventListener('focusout', (event) => {
  if (!event.relatedTarget || !content.contains(event.relatedTarget)) window.panel.setEditing(false);
});

window.panel.onShow(async (page) => {
  window.panel.setEditing(content.contains(document.activeElement) && document.activeElement !== document.body);
  const data = await window.panel.get(page);
  if (page === 'extensions') renderExtensions(data);
  else renderSettings(data);
});

// A session saved, renamed or forgotten anywhere — the picker, another
// window's settings page — redraws this list without touching the form.
window.panel.onSessionsChanged((data) => {
  if (!model) return;
  model.sessions = data.sessions;
  if (title.textContent === 'Settings') renderSessions();
});

// A favourite starred, edited or forgotten anywhere — the bar, another
// window's settings page — redraws the list. A row being typed in keeps its
// text: the next focus change shows the new list.
window.panel.onFavouritesChanged((data) => {
  if (!model || title.textContent !== 'Settings') return;
  model.favourites = data.favourites ?? [];
  if (favouritesSection?.contains(document.activeElement)) return;
  renderFavourites();
});

// A config file edited outside the browser lands here: the new values are
// already live, and the form catches up unless the user is mid-edit.
window.panel.onSettingsChanged((data) => {
  if (!model || title.textContent !== 'Settings') return;
  model = { ...model, config: data.config };
  if (dirty) {
    setStatus('The config file changed on disk. Save overwrites it; Revert takes the disk copy.', '');
    return;
  }
  renderSettings({ config: data.config });
  setStatus('Reloaded from the config file.', 'ok');
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    window.panel.close();
  }
});
