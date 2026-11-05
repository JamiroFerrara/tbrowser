'use strict';

/**
 * Where the two panes of a split go inside the page area.
 *
 * The area is cut in half with a `gap`-wide line in the middle; the panes
 * appear at their final size in one step, so a page reflows once and never
 * again. `inset` keeps every pane that far from the edge of the area, which
 * is the strip the pane's own frame — and so the indicator of which pane has
 * the keys — is drawn in.
 */
function splitBounds(width, height, orientation, gap = 2, inset = 0) {
  const innerWidth = Math.max(0, width - inset * 2);
  const innerHeight = Math.max(0, height - inset * 2);
  if (orientation === 'horizontal') {
    const second = Math.round((innerHeight - gap) / 2);
    const first = innerHeight - gap - second;
    return [
      { x: inset, y: inset, width: innerWidth, height: first },
      { x: inset, y: inset + first + gap, width: innerWidth, height: second },
    ];
  }
  const second = Math.round((innerWidth - gap) / 2);
  const first = innerWidth - gap - second;
  return [
    { x: inset, y: inset, width: first, height: innerHeight },
    { x: inset + first + gap, y: inset, width: second, height: innerHeight },
  ];
}

/**
 * The strip of the frame on one side of a pane: the rectangle just outside
 * the pane's edge, `thickness` wide.
 */
function edgeBounds(pane, side, thickness) {
  switch (side) {
    case 'top':
      return { x: pane.x, y: pane.y - thickness, width: pane.width, height: thickness };
    case 'bottom':
      return { x: pane.x, y: pane.y + pane.height, width: pane.width, height: thickness };
    case 'left':
      return { x: pane.x - thickness, y: pane.y, width: thickness, height: pane.height };
    default:
      return { x: pane.x + pane.width, y: pane.y, width: thickness, height: pane.height };
  }
}

module.exports = { splitBounds, edgeBounds };
