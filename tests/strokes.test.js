// The pen's arithmetic (canvas/strokes.ts): the stored form, simplifying, the
// burst rule, the card's frame, the eraser's hit test and the outline each
// tier draws. The drawing on screen needs a browser and is checked by eye.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  encodePts, decodePts, readDrawing, simplify, settle, joinsDrawing, newDrawing, addStroke,
  toLocal, toWorldPt, touches, outline, outlinePts, drawingSvg, MAX_POINTS, MAX_STROKES, BURST_MS, REACH_MIN,
} from '../web/assets/js/canvas/strokes.ts';

const line = (n, step = 1) => Array.from({ length: n }, (_, i) => ({ x: i * step, y: 0, p: 0.5 }));

test('points survive the stored form at a tenth of a unit', () => {
  const pts = [{ x: 12.34, y: -5.06, p: 0.731 }, { x: 0, y: 0, p: 1 }, { x: -800.5, y: 3, p: 0 }];
  const back = decodePts(encodePts(pts));
  assert.equal(back.length, 3);
  assert.deepEqual(back[0], { x: 12.3, y: -5.1, p: 0.73 });
  assert.deepEqual(back[2], { x: -800.5, y: 3, p: 0 });
});

test('a broken pts string loses only what is broken', () => {
  assert.deepEqual(decodePts(null), []);
  assert.deepEqual(decodePts(42), []);
  assert.deepEqual(decodePts('a,b,c zz'), [{ x: 1, y: 1.1, p: 0.12 }], 'a lone number is not a point');
  const mixed = decodePts('1,2,3 !!,!!,!! 4,5');
  assert.equal(mixed.length, 2);
  assert.equal(mixed[1].p, 0.5, 'a point with no pressure reads as a mouse');
});

test('decoding stops at the point ceiling', () => {
  const many = Array.from({ length: MAX_POINTS + 50 }, () => '1,1,1').join(' ');
  assert.equal(decodePts(many).length, MAX_POINTS);
});

test('readDrawing keeps good strokes, drops bad ones and clamps the rest', () => {
  const d = readDrawing({
    strokes: [
      { tool: 'pen', ink: 'accent', width: 3, pts: '0,0,1 a,a,1' },
      { tool: 'laser', ink: 'mauve', width: 1e9, pts: '0,0,1' },
      { tool: 'pen', ink: 'ink', width: 3 },
      'nonsense',
    ],
    space: [100, 50],
  });
  assert.equal(d.strokes.length, 2);
  assert.equal(d.strokes[1].tool, 'pen');
  assert.equal(d.strokes[1].ink, 'ink');
  assert.ok(d.strokes[1].width <= 400);
  assert.deepEqual(d.space, [100, 50]);
  assert.equal(readDrawing({ strokes: Array(MAX_STROKES + 5).fill({ pts: '0,0,1' }) }).strokes.length, MAX_STROKES);
  assert.deepEqual(readDrawing(null), { strokes: [], space: [1, 1] });
});

test('simplify folds a straight run to its ends and keeps a corner', () => {
  assert.equal(simplify(line(100)).length, 2);
  const corner = [...line(10), ...line(10).map(q => ({ x: 9, y: q.x + 1, p: 0.5 }))];
  const kept = simplify(corner);
  assert.equal(kept.length, 3);
  assert.deepEqual(kept[1], { x: 9, y: 0, p: 0.5 });
});

test('settle brings a long scribble under the point ceiling', () => {
  const zig = Array.from({ length: MAX_POINTS * 3 }, (_, i) => ({ x: i, y: (i % 2) * 30, p: 0.5 }));
  const out = settle(zig);
  assert.ok(out.length <= MAX_POINTS);
  assert.ok(out.length >= 2);
});

test('the burst rule needs both the time and the reach', () => {
  const last = { id: 'd', at: 1000, box: { x0: 0, y0: 0, x1: 100, y1: 40 } };
  assert.equal(joinsDrawing(null, { x: 0, y: 0 }, 1000), false);
  assert.equal(joinsDrawing(last, { x: 50, y: 20 }, 1000 + BURST_MS), true);
  assert.equal(joinsDrawing(last, { x: 50, y: 20 }, 1001 + BURST_MS), false, 'a pause ends a burst');
  assert.equal(joinsDrawing(last, { x: 100 + REACH_MIN, y: 20 }, 1500), true);
  assert.equal(joinsDrawing(last, { x: 101 + REACH_MIN, y: 20 }, 1500), false, 'far away is a new mark');
  assert.equal(joinsDrawing(last, { x: 50, y: 20 }, 900), false, 'a clock going backwards is no burst');
  const big = { ...last, box: { x0: 0, y0: 0, x1: 1000, y1: 10 } };
  assert.equal(joinsDrawing(big, { x: 1240, y: 0 }, 1500), true, 'a quarter of the longer side');
});

test('a frame maps world to its space and back, turned and scaled', () => {
  const f = { x: 40, y: -20, w: 300, h: 100, rot: 30, space: [150, 50] };
  for (const p of [{ x: 0, y: 0 }, { x: 75, y: 25 }, { x: 150, y: 50 }, { x: -10, y: 80 }]) {
    const back = toLocal(f, toWorldPt(f, p));
    assert.ok(Math.abs(back.x - p.x) < 1e-9 && Math.abs(back.y - p.y) < 1e-9);
  }
  // The middle of the space is the middle of the card.
  const mid = toWorldPt(f, { x: 75, y: 25 });
  assert.ok(Math.abs(mid.x - 40) < 1e-9 && Math.abs(mid.y + 20) < 1e-9);
  // Space y runs down, world y runs up.
  const top = toWorldPt({ ...f, rot: 0 }, { x: 75, y: 0 });
  assert.ok(top.y > -20);
});

test('a new drawing wraps its stroke and puts it back where it was drawn', () => {
  const world = [{ x: 10, y: 10, p: 0.5 }, { x: 110, y: 60, p: 0.5 }];
  const { box, drawing } = newDrawing(world, 4, 'pen', 'ink');
  assert.ok(box.w >= 104 && box.h >= 54);
  const f = { ...box, rot: 0, space: drawing.space };
  const pts = decodePts(drawing.strokes[0].pts).map(q => toWorldPt(f, q));
  assert.ok(Math.abs(pts[0].x - 10) < 0.2 && Math.abs(pts[0].y - 10) < 0.2);
  assert.ok(Math.abs(pts[1].x - 110) < 0.2 && Math.abs(pts[1].y - 60) < 0.2);
});

test('a dot makes a card no smaller than the smallest card, with the dot where it was put', () => {
  const { box, drawing } = newDrawing([{ x: 100, y: 200, p: 0.5 }], 4, 'pen', 'ink');
  assert.ok(box.w >= 48 && box.h >= 48, 'a smaller box would be clamped up and the dot drawn larger');
  assert.ok(Math.abs(box.x - 100) < 0.2 && Math.abs(box.y - 200) < 0.2);
  const f = { ...box, rot: 0, space: drawing.space };
  const [dot] = decodePts(drawing.strokes[0].pts).map(q => toWorldPt(f, q));
  assert.ok(Math.hypot(dot.x - 100, dot.y - 200) < 0.2);
});

test('a drawing written out as its own SVG file', () => {
  const { drawing } = newDrawing([{ x: 0, y: 0, p: 0.5 }, { x: 60, y: 20, p: 0.5 }], 4, 'pen', 'accent');
  drawing.strokes.unshift({ ...drawing.strokes[0], tool: 'highlighter', ink: 'warm' });
  const svg = drawingSvg(drawing, 1, ink => (ink === 'accent' ? '#b94900' : '"><script>'));
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 /);
  assert.ok(svg.indexOf('opacity="0.4"') < svg.indexOf('fill="#b94900"'), 'the highlighter under the pen');
  assert.doesNotMatch(svg, /<script/, 'a colour is escaped, never markup');
});

test('adding a stroke past the edge grows the card and moves nothing already drawn', () => {
  const first = newDrawing([{ x: 0, y: 0, p: 0.5 }, { x: 50, y: 0, p: 0.5 }], 4, 'pen', 'ink');
  const f = { ...first.box, rot: 15, space: first.drawing.space };
  const before = decodePts(first.drawing.strokes[0].pts).map(q => toWorldPt(f, q));
  const next = addStroke(f, first.drawing, [{ x: -80, y: 40, p: 0.5 }, { x: -60, y: 90, p: 0.5 }], 4, 'highlighter', 'warm');
  assert.equal(next.drawing.strokes.length, 2);
  const g = { ...next.box, rot: 15, space: next.drawing.space };
  const after = decodePts(next.drawing.strokes[0].pts).map(q => toWorldPt(g, q));
  for (let i = 0; i < before.length; i++) {
    assert.ok(Math.hypot(after[i].x - before[i].x, after[i].y - before[i].y) < 0.3, 'the old stroke stays put');
  }
  const added = decodePts(next.drawing.strokes[1].pts).map(q => toWorldPt(g, q));
  assert.ok(Math.hypot(added[0].x + 80, added[0].y - 40) < 0.3);
  assert.equal(next.drawing.strokes[1].tool, 'highlighter');
  assert.ok(next.box.w > first.box.w && next.box.h > first.box.h);
});

test('the eraser touches a stroke it crosses and misses one it does not', () => {
  const s = { tool: 'pen', ink: 'ink', width: 4, pts: encodePts(line(20, 5)) };
  assert.equal(touches(s, { x: 50, y: 3 }, 2), true);
  assert.equal(touches(s, { x: 50, y: 30 }, 2), false);
  const dot = { tool: 'pen', ink: 'ink', width: 4, pts: encodePts([{ x: 5, y: 5, p: 0.5 }]) };
  assert.equal(touches(dot, { x: 7, y: 7 }, 1), true);
});

test('each tier draws a stroke its own way', () => {
  const pts = [{ x: 0, y: 0, p: 0.2 }, { x: 20, y: 5, p: 0.6 }, { x: 40, y: 0, p: 0.9 }, { x: 60, y: 10, p: 0.5 }];
  const s = { tool: 'pen', ink: 'ink', width: 4, pts: encodePts(pts) };
  const soft = outline(s, 0), middle = outline(s, 1), harsh = outline(s, 2);
  assert.equal(soft.kind, 'fill');
  assert.equal(middle.kind, 'fill');
  assert.equal(harsh.kind, 'line');
  assert.equal(harsh.cap, 'square');
  assert.notEqual(soft.d, middle.d, 'Softish wobbles and tapers');
  assert.equal(outline(s, 0).d, soft.d, 'the wobble is seeded, so a redraw does not shimmer');
  for (const o of [soft, middle, harsh]) assert.match(o.d, /^M[-\d.]/);
  assert.doesNotMatch(soft.d + middle.d, /NaN|Infinity/);
  const hl = outline({ ...s, tool: 'highlighter' }, 1);
  assert.equal(hl.kind, 'line');
  assert.equal(hl.cap, 'round');
});

test('a single point is a dot at every tier', () => {
  const dot = [{ x: 5, y: 5, p: 0.5 }];
  for (const tier of [0, 1, 2]) {
    const o = outlinePts(dot, 4, 'pen', tier);
    assert.ok(o.d.length > 4);
    assert.doesNotMatch(o.d, /NaN/);
  }
  assert.equal(outlinePts([], 4, 'pen', 1).d, '');
});
