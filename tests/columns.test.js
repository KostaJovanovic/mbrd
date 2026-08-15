// Shortest-column-first packing - the rule the board's masonry and the Feed's
// wall both lay out by.
//
// It had no test in either of the two places it was written, which is how they
// came apart: spanning existed in one, the tie rule differed, and layout.ts's
// comment went on describing them as one thing. These are the cases that hold
// the two surfaces to the same answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { packColumns } from '../web/assets/js/arrange/columns.ts';
import { arrange } from '../web/assets/js/arrange/arrangements.ts';

const tops = pack => pack.spots.map(s => `${s.col}@${s.top}`);

/** The board's masonry, laid about the origin - see the block at the foot. */
const arrangeMasonry = (items, spacing) =>
  arrange(items, { name: 'masonry', center: { x: 0, y: 0 }, spacing });

test('boxes go to the shortest column, leftmost on a tie', () => {
  // Three equal boxes into three empty columns: every column is level, so each
  // takes the leftmost one still at zero.
  const pack = packColumns([{ h: 10 }, { h: 10 }, { h: 10 }], { cols: 3 });
  assert.deepEqual(tops(pack), ['0@0', '1@0', '2@0']);

  // A fourth has to go under one of them, and column 0 is as short as any.
  const next = packColumns([{ h: 10 }, { h: 10 }, { h: 10 }, { h: 10 }], { cols: 3 });
  assert.deepEqual(next.spots[3], { col: 0, top: 10 });
});

test('a tall box pushes the next one elsewhere', () => {
  const pack = packColumns([{ h: 100 }, { h: 10 }, { h: 10 }], { cols: 2 });
  assert.deepEqual(tops(pack), ['0@0', '1@0', '1@10'],
    'the third goes under the short one, not under the tall one');
});

test('the gap sits below each box and comes back off the total', () => {
  const pack = packColumns([{ h: 10 }, { h: 10 }], { cols: 1, gap: 4 });
  assert.deepEqual(tops(pack), ['0@0', '0@14']);
  assert.equal(pack.heights[0], 28, 'the column carries its trailing gap');
  assert.equal(pack.height, 24, 'the height does not - a wall ends at its last box');
});

// ---------------------------------------------------------------------------
// The two differences that used to be two loops
// ---------------------------------------------------------------------------

test('tolerance is what makes two columns count as level', () => {
  // The Feed's heights are pixel arithmetic off measured elements. Without a
  // tolerance a column 0.2px shorter wins and a full-width tile wanders off
  // x = 0 between layouts; with one, the leftmost holds.
  const boxes = [{ h: 10 }, { h: 9.8 }, { h: 5 }];
  assert.deepEqual(packColumns(boxes, { cols: 2 }).spots[2], { col: 1, top: 9.8 },
    'strict: 9.8 beats 10, which is the board masonry');
  assert.deepEqual(packColumns(boxes, { cols: 2, tolerance: 0.5 }).spots[2], { col: 0, top: 10 },
    'half a pixel of slack: level enough, so the leftmost keeps it');
});

test('a spanning box clears every column it covers', () => {
  // Columns at 0, 50, 0. A two-column box must start below the tallest of
  // whichever pair it takes, and the best pair is the last two - max 0 - not
  // the first two, whose max is 50.
  const pack = packColumns(
    [{ h: 50 }, { h: 0 }, { h: 0 }, { h: 20, span: 2 }],
    { cols: 3 },
  );
  assert.deepEqual(pack.spots[3], { col: 1, top: 0 });
  assert.deepEqual(pack.heights, [50, 20, 20],
    'both covered columns are filled to the same line, so nothing tucks under');
});

test('a span wider than the wall is the wall', () => {
  const pack = packColumns([{ h: 10, span: 9 }], { cols: 2 });
  assert.deepEqual(pack.spots[0], { col: 0, top: 0 });
  assert.deepEqual(pack.heights, [10, 10]);
});

test('a span that is not a number is one column', () => {
  // spanFor() in ui/feed.ts computes this from a stored fraction, so it is a
  // value out of somebody else's file by the time it arrives.
  for (const span of [undefined, 0, -3, NaN, 0.4]) {
    const pack = packColumns([{ h: 10, span }, { h: 10 }], { cols: 2 });
    assert.deepEqual(pack.heights, [10, 10], `span ${span} took one column`);
  }
});

// ---------------------------------------------------------------------------
// The claim layout.ts makes
// ---------------------------------------------------------------------------

test('the same boxes in the same order pack the same way twice', () => {
  // What "the same board" rests on: the Desktop pack is fed the Feed's order
  // and has to reproduce the Feed's wall. Nothing here is carried between calls.
  const boxes = [{ h: 30 }, { h: 12 }, { h: 44 }, { h: 8 }, { h: 21 }];
  const opts = { cols: 3, gap: 6 };
  assert.deepEqual(packColumns(boxes, opts), packColumns(boxes, opts));
});

test('no columns and no boxes are both answerable', () => {
  assert.deepEqual(packColumns([], { cols: 3 }).spots, []);
  assert.deepEqual(packColumns([{ h: 10 }], { cols: 0 }).spots, [{ col: 0, top: 0 }],
    'under one column is one column');
});

// ---------------------------------------------------------------------------
// The board's masonry, through the arrangement engine
// ---------------------------------------------------------------------------
//
// LAYOUTS.masonry had no test of its own, which is the other half of why the
// two packers could drift. These pin the world-space arrangement rather than
// the packer under it - the column widths, the centring and the +y-up flip are
// all things packColumns() knows nothing about.

test('the board masonry drops each card into the shortest column', () => {
  // Four equal cards: sqrt(4 * 1.4) rounds to 2 columns, so two per column.
  const items = Array.from({ length: 4 }, (_, i) => ({ id: `i${i}`, w: 100, h: 50 }));
  const out = arrangeMasonry(items, 10);

  // Two columns 110 wide (the card plus a spacing), centred on the origin, so
  // the column midpoints land at -55 and 55. Each column holds two cards 60
  // apart, and the block is centred vertically too - which with +y up puts the
  // first row above the origin and the second below it.
  assert.deepEqual(out, [
    { x: -55, y: 30 },
    { x: 55, y: 30 },
    { x: -55, y: -30 },
    { x: 55, y: -30 },
  ]);
});

test('the board masonry gives each column the width of its widest card', () => {
  // The half that stays in arrangements.ts rather than moving to columns.ts: a
  // wall of tiles has one column width and a board of cards does not.
  const out = arrangeMasonry([
    { id: 'a', w: 300, h: 50 },
    { id: 'b', w: 100, h: 50 },
  ], 10);
  // Columns 310 and 110 wide, laid side by side and centred: midpoints at 155
  // and 365 within a block 420 across, so -55 and 155 about the origin.
  assert.deepEqual(out.map(p => p.x), [-55, 155]);
});

test('a taller card in one column pushes the next card to the other', () => {
  // The property the whole layout is: which column is shortest is recomputed
  // per card, so one tall card diverts everything after it.
  const pack = packColumns([{ h: 100 }, { h: 10 }, { h: 10 }, { h: 10 }], { cols: 2 });
  assert.deepEqual(pack.spots.map(s => s.col), [0, 1, 1, 1],
    'three short cards stack in column 1 before column 0 is worth using again');
});
