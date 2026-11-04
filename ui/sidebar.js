'use strict';

const list = document.getElementById('list');

function render(tabs) {
  list.replaceChildren(
    ...tabs.map((tab) => {
      const row = document.createElement('div');
      row.className = tab.active ? 'tab active' : 'tab';
      row.title = tab.title;

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = tab.title;

      const close = document.createElement('button');
      close.className = 'close';
      close.textContent = '×';
      close.title = 'Close tab (Ctrl+W)';
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        window.sidebar.act('close', tab.id);
      });

      row.append(title, close);
      row.addEventListener('click', () => window.sidebar.act('activate', tab.id));
      row.addEventListener('mouseup', (event) => {
        if (event.button === 1) {
          event.preventDefault();
          window.sidebar.act('close', tab.id);
        }
      });
      return row;
    }),
  );
}

document.getElementById('new').addEventListener('click', () => window.sidebar.act('new'));

window.sidebar.onTabs(render);
