'use strict';

const title = document.getElementById('title');
const sub = document.getElementById('sub');
const content = document.getElementById('content');

/** What each keybinding action does, in the words the settings page shows. */
const ACTION_LABELS = {
  openBar: 'Open command bar',
  search: 'Search the web',
  closeBar: 'Close command bar',
  reload: 'Reload page',
  back: 'Back',
  forward: 'Forward',
  newTab: 'New tab',
  closeTab: 'Close tab',
  nextTab: 'Next tab',
  prevTab: 'Previous tab',
  nextSuggestion: 'Next suggestion',
  prevSuggestion: 'Previous suggestion',
  toggleSidebar: 'Toggle sidebar',
  workspaces: 'Workspace picker',
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
let status;

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

function checkbox(checked) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', markDirty);
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

/** One favourite, with the switch that keeps it loaded in the background. */
function favouriteRow(fav) {
  const row = el('label', 'fav-row');
  const box = checkbox(fav.warm === true);
  box.className = 'warm-box';
  box.dataset.url = fav.url;
  row.append(box, el('span', 'fav-name', fav.title || fav.url), el('span', 'fav-url', fav.url));
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

function collect() {
  const keybindings = {};
  for (const input of content.querySelectorAll('.kbd-input')) keybindings[input.dataset.action] = input.value;
  const warm = {};
  for (const box of content.querySelectorAll('.warm-box')) warm[box.dataset.url] = box.checked;
  return {
    searchUrl: content.querySelector('#setting-search-url').value,
    adblock: content.querySelector('#setting-adblock').checked,
    resident: content.querySelector('#setting-resident').checked,
    preload: content.querySelector('#setting-preload').checked,
    keybindings,
    warm,
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
  const favourites = model.favourites ?? [];

  const actions = el('div', 'row');
  const save = el('button', 'primary', 'Save');
  const revert = el('button', '', 'Revert');
  const open = el('button', '', 'Show config file');
  open.addEventListener('click', () => window.panel.openPath(model.configPath));
  status = el('div', 'status');

  save.addEventListener('click', async () => {
    save.disabled = true;
    const result = await window.panel.saveSettings(collect());
    save.disabled = false;
    if (!result.ok) {
      setStatus(result.error, 'err');
      return;
    }
    renderSettings({ config: result.config });
    setStatus('Saved — every change is already in effect.', 'ok');
  });
  revert.addEventListener('click', () => {
    renderSettings({ config: model.config });
    setStatus('Unsaved changes dropped.', '');
  });

  actions.append(save, revert, open);

  content.replaceChildren(
    actions,
    group(
      'Search',
      field(el('span', '', 'Search engine URL'), searchUrl, 'What :s sends the query to. The query is appended, so it ends in q=.'),
    ),
    group(
      'Browsing',
      field(el('span', '', 'Block ads and trackers'), adblock, 'The built-in engine, used unless uBlock Origin loaded.'),
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
        'A favourite switched on below stays loaded in the background, so opening it is instant. One left for a while is fetched again when you come back to it.',
      ),
      ...(favourites.length
        ? favourites.map(favouriteRow)
        : [el('div', 'hint', 'No favourites yet — star a page with :fav, then pick it here.')]),
    ),
    (() => {
      const section = el('section', 'group');
      section.append(
        el('h2', '', 'Keys'),
        el('div', 'hint', 'Comma-separated, e.g. ctrl+l, ctrl+k. One key still wins: the first row that matches.'),
        ...keyRows(model.config, model.defaults ?? { keybindings: {} }),
      );
      return section;
    })(),
    status,
  );
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
