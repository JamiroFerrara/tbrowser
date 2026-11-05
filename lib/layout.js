'use strict';

/**
 * Where the two panes of a split go inside the page area.
 *
 * `progress` is the opening slide: 0 leaves the first pane the whole area and
 * the second one with no width, 1 splits it in half. The gap between them is
 * only there once the second pane exists, so the first frame after closing a
 * split is the full page again.
 */
function splitBounds(width, height, orientation, progress = 1, gap = 2) {
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  const space = p > 0 ? gap : 0;
  if (orientation === 'horizontal') {
    const second = Math.round(((height - space) * p) / 2);
    const first = height - space - second;
    return [
      { x: 0, y: 0, width, height: first },
      { x: 0, y: first + space, width, height: second },
    ];
  }
  const second = Math.round(((width - space) * p) / 2);
  const first = width - space - second;
  return [
    { x: 0, y: 0, width: first, height },
    { x: first + space, y: 0, width: second, height },
  ];
}

module.exports = { splitBounds };
