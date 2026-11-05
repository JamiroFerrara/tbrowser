'use strict';

/**
 * Where the two panes of a split go inside the page area.
 *
 * The area is cut in half with a `gap`-wide line in the middle; the panes
 * appear at their final size in one step, so a page reflows once and never
 * again.
 */
function splitBounds(width, height, orientation, gap = 2) {
  if (orientation === 'horizontal') {
    const second = Math.round((height - gap) / 2);
    const first = height - gap - second;
    return [
      { x: 0, y: 0, width, height: first },
      { x: 0, y: first + gap, width, height: second },
    ];
  }
  const second = Math.round((width - gap) / 2);
  const first = width - gap - second;
  return [
    { x: 0, y: 0, width: first, height },
    { x: first + gap, y: 0, width: second, height },
  ];
}

module.exports = { splitBounds };
