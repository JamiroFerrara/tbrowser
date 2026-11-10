'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../lib/layout');

const leaf = (tab) => ({ tab });
const vertical = (first, second) => ({ orientation: 'vertical', children: [first, second] });
const horizontal = (first, second) => ({ orientation: 'horizontal', children: [first, second] });

test('a vertical split gives each pane half the width and a gap', () => {
  const rects = paneRects(vertical(leaf(1), leaf(2)), 1200, 756, 2);
  assert.deepEqual(rects.get(1), { x: 0, y: 0, width: 599, height: 756 });
  assert.deepEqual(rects.get(2), { x: 601, y: 0, width: 599, height: 756 });
  assert.equal(rects.get(1).width + rects.get(2).width + 2, 1200);
});

test('a horizontal split stacks the panes', () => {
  const rects = paneRects(horizontal(leaf(1), leaf(2)), 1200, 756, 2);
  assert.deepEqual(rects.get(1), { x: 0, y: 0, width: 1200, height: 377 });
  assert.deepEqual(rects.get(2), { x: 0, y: 379, width: 1200, height: 377 });
  assert.equal(rects.get(1).height + rects.get(2).height + 2, 756);
});

test('an odd width still fills the area with the gap between the panes', () => {
  const rects = paneRects(vertical(leaf(1), leaf(2)), 1201, 756, 2);
  assert.equal(rects.get(1).width + rects.get(2).width + 2, 1201);
  assert.equal(rects.get(2).x, rects.get(1).width + 2);
});

test('an inset keeps each pane off the edge and the frames apart', () => {
  const rects = paneRects(vertical(leaf(1), leaf(2)), 1200, 756, 4, 2);
  assert.deepEqual(rects.get(1), { x: 2, y: 2, width: 596, height: 752 });
  assert.deepEqual(rects.get(2), { x: 602, y: 2, width: 596, height: 752 });
  assert.equal(rects.get(2).x - (rects.get(1).x + rects.get(1).width), 4);
  assert.equal(1200 - (rects.get(2).x + rects.get(2).width), 2);
});

test('the first pane keeps its place when the other half is split', () => {
  // Left is one pane, right is cut top and bottom: three panes, the way
  // `:split` after `:vsplit` leaves them.
  const tree = vertical(leaf(1), horizontal(leaf(2), leaf(3)));
  const rects = paneRects(tree, 1200, 756, 2, 0);
  assert.equal(rects.get(1).x, 0);
  assert.equal(rects.get(1).y, 0);
  assert.equal(rects.get(2).x, rects.get(1).width + 2);
  assert.equal(rects.get(3).x, rects.get(2).x);
  assert.equal(rects.get(3).y, rects.get(2).height + 2);
});

test('three panes side by side come out a third each, as vim equalizes them', () => {
  // Splitting twice, the second split did not take half of the first split's
  // half: `equalalways` is on, so all three are the same width.
  for (const tree of [vertical(vertical(leaf(1), leaf(2)), leaf(3)), vertical(leaf(1), vertical(leaf(2), leaf(3)))]) {
    const rects = paneRects(tree, 1200, 756, 4, 2);
    const widths = [...rects.values()].map((rect) => rect.width);
    for (const width of widths) assert.ok(Math.abs(width - 397) <= 2, `width ${width} in ${JSON.stringify(widths)}`);
    assert.equal(widths[0] + widths[1] + widths[2] + 8, 1196);
  }
  const stacked = paneRects(horizontal(horizontal(leaf(1), leaf(2)), leaf(3)), 1200, 756, 4, 2);
  const heights = [...stacked.values()].map((rect) => rect.height);
  for (const height of heights) assert.ok(Math.abs(height - 249) <= 2, `height ${height}`);
  assert.equal(heights[0] + heights[1] + heights[2] + 8, 752);
});

test('panes of a mixed split still get the same room', () => {
  // A vertical split then a horizontal one: the two stacked panes take two
  // thirds of the width between them, so each pane covers a third of the area.
  const tree = vertical(leaf(1), horizontal(leaf(2), leaf(3)));
  const rects = paneRects(tree, 1200, 756, 4, 2);
  const area = (rect) => rect.width * rect.height;
  const third = area(rects.get(1));
  for (const tab of [2, 3]) assert.ok(Math.abs(area(rects.get(tab)) - third) <= third * 0.02);
});

test('four panes in a cross are four quarters', () => {
  const tree = vertical(horizontal(leaf(1), leaf(2)), horizontal(leaf(3), leaf(4)));
  const rects = paneRects(tree, 1200, 756, 4, 0);
  const width = rects.get(1).width;
  const height = rects.get(1).height;
  for (const rect of rects.values()) {
    assert.equal(rect.width, width);
    assert.equal(rect.height, height);
  }
  assert.equal(width * 2 + 4, 1200);
  assert.equal(height * 2 + 4, 756);
  assert.equal(rects.get(4).y, rects.get(1).y + height + 4);
});

test('the panes read top-left first, whatever the tree nesting', () => {
  const tree = vertical(leaf(1), horizontal(leaf(2), leaf(3)));
  assert.deepEqual(paneTabs(tree), [1, 2, 3]);
  assert.equal(showsTab(tree, 2), true);
  assert.equal(showsTab(tree, 9), false);
});

test('splitting replaces one pane and leaves its siblings where they were', () => {
  const tree = splitAt(vertical(leaf(1), leaf(2)), 2, 3, 'horizontal');
  assert.deepEqual(tree, vertical(leaf(1), horizontal(leaf(2), leaf(3))));
  // A window with no split becomes the first two panes.
  assert.deepEqual(splitAt(null, 7, 8, 'vertical'), vertical(leaf(7), leaf(8)));
});

test('closing a pane gives its room to the pane beside it', () => {
  const tree = vertical(leaf(1), horizontal(leaf(2), leaf(3)));
  assert.deepEqual(removeTab(tree, 2), vertical(leaf(1), leaf(3)));
  assert.deepEqual(removeTab(tree, 1), horizontal(leaf(2), leaf(3)));
  // The last pane closed leaves no arrangement at all.
  assert.equal(removeTab(leaf(1), 1), null);
  assert.deepEqual(removeTab(tree, 9), tree);
});

test('a tab shown in another pane is renamed, not duplicated', () => {
  const tree = vertical(leaf(1), leaf(2));
  assert.deepEqual(replaceTab(tree, 2, 5), vertical(leaf(1), leaf(5)));
});

test('a move lands on the pane that way, straight ahead before diagonal', () => {
  const tree = vertical(leaf(1), horizontal(leaf(2), leaf(3)));
  const rects = paneRects(tree, 1200, 756, 2, 0);
  assert.equal(paneInDirection(rects, 1, 'right'), 2);
  assert.equal(paneInDirection(rects, 2, 'left'), 1);
  assert.equal(paneInDirection(rects, 2, 'down'), 3);
  assert.equal(paneInDirection(rects, 3, 'up'), 2);
  // Nothing that way is null, not a wrap-around.
  assert.equal(paneInDirection(rects, 1, 'left'), null);
  assert.equal(paneInDirection(rects, 3, 'right'), null);
});

test('two arrangements are the same only leaf for leaf', () => {
  assert.equal(sameTree(null, null), true);
  assert.equal(sameTree(vertical(leaf(1), leaf(2)), vertical(leaf(1), leaf(2))), true);
  assert.equal(sameTree(vertical(leaf(1), leaf(2)), vertical(leaf(2), leaf(1))), false);
  assert.equal(sameTree(vertical(leaf(1), leaf(2)), horizontal(leaf(1), leaf(2))), false);
  assert.equal(sameTree(vertical(leaf(1), leaf(2)), null), false);
});

test('a leaf is a tab, a branch is its two halves', () => {
  assert.equal(isLeaf(leaf(1)), true);
  assert.equal(isLeaf(vertical(leaf(1), leaf(2))), false);
  assert.equal(isLeaf(null), false);
});

test('a pane frame is the strip just outside the pane', () => {
  const pane = { x: 10, y: 20, width: 100, height: 50 };
  assert.deepEqual(edgeBounds(pane, 'top', 2), { x: 10, y: 18, width: 100, height: 2 });
  assert.deepEqual(edgeBounds(pane, 'bottom', 2), { x: 10, y: 70, width: 100, height: 2 });
  assert.deepEqual(edgeBounds(pane, 'left', 2), { x: 8, y: 20, width: 2, height: 50 });
  assert.deepEqual(edgeBounds(pane, 'right', 2), { x: 110, y: 20, width: 2, height: 50 });
});

test('the frames of two panes meet but never overlap', () => {
  const rects = paneRects(horizontal(leaf(1), leaf(2)), 1200, 756, 4, 2);
  const aBottom = edgeBounds(rects.get(1), 'bottom', 2);
  const bTop = edgeBounds(rects.get(2), 'top', 2);
  assert.equal(aBottom.y + aBottom.height, bTop.y);
  assert.equal(rects.get(1).y, 2);
  assert.equal(756 - (rects.get(2).y + rects.get(2).height), 2);
});
