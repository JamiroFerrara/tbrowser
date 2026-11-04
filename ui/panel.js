'use strict';

const title = document.getElementById('title');
const sub = document.getElementById('sub');
const content = document.getElementById('content');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function extCard(extension) {
  const card = el('div', 'card');
  card.append(
    el('h2', '', `${extension.name} ${extension.version ?? ''}`.trim()),
    el('div', 'meta', extension.path ?? ''),
  );
  return card;
}

function renderExtensions(data) {
  title.textContent = 'Extensions';
  sub.textContent = 'Loaded unpacked extensions. Drop a folder into one of these directories and rescan.';

  const actions = el('div', 'row');
  const rescan = el('button', '', 'Rescan');
  rescan.addEventListener('click', async () => {
    rescan.disabled = true;
    const fresh = await window.panel.rescan();
    renderExtensions(fresh);
  });
  actions.append(rescan);
  for (const dir of data.dirs) {
    const open = el('button', '', dir.split(/[\\/]/).pop());
    open.title = dir;
    open.addEventListener('click', () => window.panel.openPath(dir));
    actions.append(open);
  }
  content.replaceChildren(actions, ...data.extensions.map(extCard));
  if (!data.extensions.length) content.append(el('p', 'meta', 'No extensions loaded.'));
}

function renderSettings(data) {
  title.textContent = 'Settings';
  sub.textContent = `${data.configPath} — saved values take effect on restart (search URL immediately).`;

  const actions = el('div', 'row');
  const open = el('button', '', 'Show config file');
  open.addEventListener('click', () => window.panel.openPath(data.configPath));
  const save = el('button', '', 'Save');
  const status = el('div', 'status');
  const editor = el('textarea');
  editor.spellcheck = false;
  editor.value = JSON.stringify(data.config, null, 2);

  save.addEventListener('click', async () => {
    const result = await window.panel.saveConfig(editor.value);
    status.className = result.ok ? 'status ok' : 'status err';
    status.textContent = result.ok ? 'Saved' : result.error;
    if (result.ok) editor.value = JSON.stringify(result.config, null, 2);
  });

  actions.append(open, save);
  content.replaceChildren(actions, editor, status);
}

window.panel.onShow(async (page) => {
  const data = await window.panel.get(page);
  if (page === 'extensions') renderExtensions(data);
  else renderSettings(data);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    window.panel.close();
  }
});
