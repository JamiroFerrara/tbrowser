'use strict';

/**
 * The panes of a window, the way the editor arranges its windows.
 *
 * A pane tree is either a leaf, `{ tab }` — the tab that pane is showing — or
 * a branch, `{ orientation, children: [first, second] }`, which cuts its
 * rectangle in half and hands each half to one child. Splitting a window
 * replaces the pane with a branch of two, so a split inside a split nests the
 * way `:split` inside `:split` does in vim: the first child holds the top (or
 * left) half, the second the bottom (or right) one, and the tree is the only
 * record of the arrangement — the rectangles are computed from it every time.
 *
 * The tab id in a leaf is whatever the caller put there: the window keeps tab
 * ids, the saved state keeps their places in the tab order. A tab is in at
 * most one leaf, which is what lets a leaf be found by its tab.
 */

/** A leaf, or a branch with two of them below. */
function isLeaf(node) {
  return Boolean(node) && typeof node === 'object' && !Array.isArray(node.children);
}

/** The tabs the tree shows, in layout order: top-left first. */
function paneTabs(tree) {
  const tabs = [];
  const walk = (node) => {
    if (!node) return;
    if (isLeaf(node)) {
      tabs.push(node.tab);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return tabs;
}

/** Whether the tree shows that tab. */
function showsTab(tree, tab) {
  return paneTabs(tree).includes(tab);
}

/** The same tree with one leaf's tab swapped for another: `:b <tab>`. */
function replaceTab(tree, from, to) {
  if (!tree) return null;
  if (isLeaf(tree)) return tree.tab === from ? { tab: to } : tree;
  return {
    orientation: tree.orientation,
    children: tree.children.map((child) => replaceTab(child, from, to)),
  };
}

/**
 * Split the pane showing `at` in two: it keeps the first half and `added`
 * takes the second. A window with no tree is one pane, which this turns into
 * the first two.
 */
function splitAt(tree, at, added, orientation) {
  const split = { orientation, children: [{ tab: at }, { tab: added }] };
  if (!tree) return split;
  if (isLeaf(tree)) return tree.tab === at ? split : tree;
  return {
    orientation: tree.orientation,
    children: tree.children.map((child) => splitAt(child, at, added, orientation)),
  };
}

/**
 * Close the pane showing `tab`. Its sibling takes the space, as the window
 * next to `:q` does, and a branch that is left holding one child becomes that
 * child. The tab itself is untouched: it stays a buffer, just not on screen.
 */
function removeTab(tree, tab) {
  if (!tree) return null;
  if (isLeaf(tree)) return tree.tab === tab ? null : tree;
  const [first, second] = tree.children.map((child) => removeTab(child, tab));
  if (!first) return second;
  if (!second) return first;
  return { orientation: tree.orientation, children: [first, second] };
}

/** Where every pane goes: a Map of tab -> rectangle inside the area. */
function paneRects(tree, width, height, gap = 2, inset = 0) {
  const rects = new Map();
  const areaWidth = Math.max(0, width - inset * 2);
  const areaHeight = Math.max(0, height - inset * 2);
  const walk = (node, x, y, w, h) => {
    if (!node) return;
    if (isLeaf(node)) {
      rects.set(node.tab, { x, y, width: w, height: h });
      return;
    }
    const [first, second] = halves(w, h, node.orientation, gap);
    walk(node.children[0], x + first.x, y + first.y, first.width, first.height);
    walk(node.children[1], x + second.x, y + second.y, second.width, second.height);
  };
  walk(tree, inset, inset, areaWidth, areaHeight);
  return rects;
}

/**
 * Cut a rectangle in half with a `gap`-wide line, the first half taking any
 * odd pixel so the two plus the gap always fill it exactly.
 */
function halves(width, height, orientation, gap) {
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

/** The middle of a rectangle. */
function centre(rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * The pane a move in `direction` lands on, or null when nothing is that way.
 * Distance along the move decides, and a pane straight ahead beats one off to
 * the side: the same rule that keeps `C-w h` from hopping diagonally in vim.
 */
function paneInDirection(rects, from, direction) {
  const base = rects.get(from);
  if (!base) return null;
  const origin = centre(base);
  let best = null;
  let bestScore = Infinity;
  for (const [tab, rect] of rects) {
    if (tab === from) continue;
    const point = centre(rect);
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    let ahead;
    let aside;
    switch (direction) {
      case 'left':
        if (dx >= 0) continue;
        ahead = -dx;
        aside = Math.abs(dy);
        break;
      case 'right':
        if (dx <= 0) continue;
        ahead = dx;
        aside = Math.abs(dy);
        break;
      case 'up':
        if (dy >= 0) continue;
        ahead = -dy;
        aside = Math.abs(dx);
        break;
      case 'down':
        if (dy <= 0) continue;
        ahead = dy;
        aside = Math.abs(dx);
        break;
      default:
        continue;
    }
    const score = ahead + aside / 2;
    if (score < bestScore) {
      best = tab;
      bestScore = score;
    }
  }
  return best;
}

/** The same arrangement, whichever leaves the tabs are numbered by. */
function sameTree(left, right) {
  if (!left || !right) return left === right || (!left && !right);
  if (isLeaf(left) || isLeaf(right)) {
    return isLeaf(left) && isLeaf(right) && left.tab === right.tab;
  }
  return (
    left.orientation === right.orientation &&
    left.children.length === right.children.length &&
    left.children.every((child, index) => sameTree(child, right.children[index]))
  );
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

module.exports = {
  isLeaf,
  paneTabs,
  showsTab,
  replaceTab,
  splitAt,
  removeTab,
  paneRects,
  paneInDirection,
  sameTree,
  edgeBounds,
};
