import assert from 'node:assert/strict';
import { test } from 'node:test';
import { worldToView, viewToWorld, zoomAt, sceneBounds, fitView, constrainView, visibleBoards } from '../src/editor/assets/viewport-math.js';

const boards = [
  { path: 'A.dc.html', x: -540, y: -200, w: 500, h: 600 },
  { path: 'B.dc.html', x: 0, y: 0, w: 500, h: 600 },
  { path: 'C.dc.html', x: 540, y: 0, w: 500, h: 600 },
];
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('canvas coordinates round trip at negative origins and all zoom boundaries', () => {
  for (const k of [0.1, 0.25, 1, 4]) {
    const view = { k, x: 41, y: -92 }, point = { x: -510, y: -150 };
    const result = viewToWorld(worldToView(point, view), view);
    near(result.x, point.x); near(result.y, point.y);
  }
});

test('zoom preserves pointer world coordinate and clamps to 10–400%', () => {
  const original = { k: 0.5, x: 100, y: 50 }, anchor = { x: 460, y: 210 };
  for (const zoom of [0, 0.25, 1, 100]) {
    const changed = zoomAt(original, zoom, anchor);
    const before = viewToWorld(anchor, original), after = viewToWorld(anchor, changed);
    near(before.x, after.x); near(before.y, after.y);
    assert.ok(changed.k >= 0.1 && changed.k <= 4);
  }
});

test('fit includes negative board coordinates, with 40px viewport margins', () => {
  const bounds = sceneBounds(boards), view = fitView(bounds, 1200, 800);
  assert.deepEqual(bounds, { x: -540, y: -200, w: 1580, h: 800 });
  const topLeft = worldToView(bounds, view);
  const bottomRight = worldToView({ x: bounds.x + bounds.w, y: bounds.y + bounds.h }, view);
  assert.ok(topLeft.x >= 39.999 && topLeft.y >= 39.999);
  assert.ok(bottomRight.x <= 1160.001 && bottomRight.y <= 760.001);
});

test('pan cannot strand the scene beyond the 40px visibility boundary', () => {
  const bounds = sceneBounds(boards);
  for (const displacement of [-1e6, 1e6]) {
    const view = constrainView({ k: 0.25, x: displacement, y: displacement }, bounds, 600, 500);
    const start = worldToView(bounds, view), end = worldToView({ x: bounds.x + bounds.w, y: bounds.y + bounds.h }, view);
    assert.ok(end.x >= 40 && end.y >= 40);
    assert.ok(start.x <= 560 && start.y <= 460);
  }
});

test('20-board visible previews respect the four-frame budget and evict offscreen boards', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ path: `${i}.dc.html`, x: i * 110, y: 0, w: 100, h: 100 }));
  const first = visibleBoards(many, { k: 1, x: 0, y: 0 }, 800, 600, '0.dc.html', 4);
  assert.equal(first.length, 3);
  assert.ok(!first.includes('0.dc.html'));
  const moved = visibleBoards(many, { k: 1, x: -1800, y: 0 }, 800, 600, '0.dc.html', 4);
  assert.ok(moved.every(path => Number(path.split('.')[0]) >= 16));
  assert.ok(first.every(path => !moved.includes(path)));
});
