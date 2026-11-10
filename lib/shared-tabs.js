'use strict';

/**
 * Every window's tabs as one list, the window you are in first.
 *
 * `windows` is what each window holds, in the order the windows opened:
 * `{ id, tabs: [{ id, title, url, active }] }`. The rows come back window by
 * window, each tab carrying the window it lives in (`window`), that window's
 * place in the list (`slot`, one-based) and `here` — whether it is a tab of the
 * window that asked.
 *
 * Tab ids are unique for the whole process, so a row names a tab everywhere;
 * `slot` is only what a list shows to say which window holds it.
 */
function sharedTabs(windows, currentId) {
  const list = (Array.isArray(windows) ? windows : []).filter(
    (entry) => entry && Array.isArray(entry.tabs),
  );
  const ordered = list
    .filter((entry) => entry.id === currentId)
    .concat(list.filter((entry) => entry.id !== currentId));
  const rows = [];
  ordered.forEach((entry, index) => {
    for (const tab of entry.tabs) {
      rows.push({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        active: Boolean(tab.active),
        window: entry.id,
        slot: index + 1,
        here: entry.id === currentId,
        // A buffer is a tab no window is showing: it has no place in the
        // window order, so its rows group under a heading of their own.
        parked: Boolean(entry.parked),
      });
    }
  });
  return rows;
}

module.exports = { sharedTabs };
