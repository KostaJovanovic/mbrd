// The board's link to real-world sizes. Pure arithmetic and pure formatting, so
// all of it is testable without a browser - which is the reason measure.js was
// written as a module that takes its two settings as arguments rather than one
// that reaches into `board`.
//
// What is worth guarding here is not the multiply. It is the three places this
// can lie to somebody: a scale that came out of a file and is nonsense, a
// rounding that reports 9.999 as 10 when it is not, and a scale bar whose
// printed length does not match the bar that was drawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toMm, toUnits, formatMm, formatLength, formatSize, scaleFrom, scaleStep,
  clampScale, DEFAULT_SCALE, MIN_SCALE, MAX_SCALE, MM_PER_INCH,
  PAPERS, paperMm, PX_PER_INCH,
} from '../web/assets/js/measure.ts';

test('the default scale is life size on screen at 100% zoom', () => {
  // One world unit is one CSS pixel at 1:1, and CSS fixes an inch at 96 of
  // them. So the default scale is life size exactly when a millimetre buys
  // 96/25.4 units - and an A4 outline is 793.7 px wide, which at 100% zoom is
  // a sheet you can hold against the screen.
  assert.equal(toUnits(MM_PER_INCH, DEFAULT_SCALE), PX_PER_INCH);
  const a4 = paperMm('a4');
  assert.ok(Math.abs(toUnits(a4.w, DEFAULT_SCALE) - 793.7) < 0.05,
    `A4 came out ${toUnits(a4.w, DEFAULT_SCALE)} px wide`);
  // And those 793.7 units read back as the sheet they were drawn from, rather
  // than as 209.9 mm of accumulated floating point.
  const back = toMm(toUnits(a4.w, DEFAULT_SCALE), DEFAULT_SCALE);
  assert.equal(formatMm(back), '21 cm');
  assert.equal(formatMm(back, 'imperial'), '8.27 in');
});

test('the default scale round-trips like any other', () => {
  assert.ok(Math.abs(toUnits(toMm(640, DEFAULT_SCALE), DEFAULT_SCALE) - 640) < 1e-9);
});

test('units and millimetres round-trip at any scale', () => {
  for (const scale of [0.01, 0.5, 1, 2.54, 37.5, 500]) {
    const there = toMm(640, scale);
    assert.ok(Math.abs(toUnits(there, scale) - 640) < 1e-9, `lost precision at ${scale}`);
  }
});

test('a scale out of a file cannot poison every measurement', () => {
  // The failure this prevents is not a wrong number, it is a readout that says
  // "Infinity cm" or "NaN" forever, in the one part of the interface whose job
  // is to be trusted. Every one of these arrives from somebody else's .mbrd.
  for (const bad of [0, -1, NaN, Infinity, -Infinity, null, undefined, '', 'big', {}]) {
    assert.equal(clampScale(bad), DEFAULT_SCALE, `${String(bad)} was let through`);
  }
  assert.equal(clampScale(1e9), MAX_SCALE);
  assert.equal(clampScale(1e-9), MIN_SCALE);
  assert.ok(Number.isFinite(toMm(100, 0)), 'a zero scale still measures something');
});

test('metric picks the unit a person would say', () => {
  assert.equal(formatMm(4.2), '4.2 mm');
  assert.equal(formatMm(85), '8.5 cm');
  assert.equal(formatMm(1000), '1 m');
  assert.equal(formatMm(3420), '3.42 m');
});

test('imperial reads off a tape measure, not a calculator', () => {
  assert.equal(formatMm(MM_PER_INCH * 6, 'imperial'), '6 in');
  assert.equal(formatMm(MM_PER_INCH * 12, 'imperial'), '1 ft');
  assert.equal(formatMm(MM_PER_INCH * 51, 'imperial'), '4 ft 3 in');
  // The remainder can round up to a full twelve inches, which is not a thing
  // anybody writes. It has to carry into the feet instead.
  const almost = MM_PER_INCH * 23.98;
  assert.equal(formatMm(almost, 'imperial'), '2 ft');
});

test('negatives keep their sign and their unit', () => {
  // Coordinates are signed - half the board is at negative x - so this is the
  // common case for the HUD rather than an edge one.
  assert.equal(formatMm(-85), '-8.5 cm');
  assert.equal(formatMm(-MM_PER_INCH * 18, 'imperial'), '-1 ft 6 in');
});

test('trailing zeros are dropped so a dragged readout stops jittering', () => {
  assert.equal(formatMm(100), '10 cm');
  assert.equal(formatMm(2000), '2 m');
  assert.equal(formatMm(50), '5 cm');
});

test('a size says its unit once when both halves agree', () => {
  assert.equal(formatSize(320, 240, 1, 'metric'), '32 × 24 cm');
});

test('a size keeps both units when they differ', () => {
  // A sliver: 9 mm by 4 cm. Converting one into the other reads badly whichever
  // way it is done, so neither is.
  const out = formatSize(9, 40, 1, 'metric');
  assert.ok(out.includes('mm') && out.includes('cm'), out);
});

test('the scale can be derived from one thing whose size is known', () => {
  // The way a board is actually calibrated: that card is 320 units and 80 cm.
  const scale = scaleFrom(320, 800);
  assert.equal(formatLength(320, scale, 'metric'), '80 cm');
  // And everything else on the board follows from it, with no second input.
  assert.equal(formatLength(160, scale, 'metric'), '40 cm');
});

test('deriving a scale from nothing falls back rather than dividing by zero', () => {
  assert.equal(scaleFrom(0, 100), DEFAULT_SCALE);
  assert.equal(scaleFrom(100, 0), DEFAULT_SCALE);
  assert.equal(scaleFrom(100, -5), DEFAULT_SCALE);
});

test('the scale bar is a round number that fits', () => {
  // 2 px per mm, 116 px of room: 50 mm fits at 100 px, 100 mm would need 200.
  const step = scaleStep(2, 116, 'metric');
  assert.equal(step.mm, 50);
  assert.equal(step.px, 100);
});

test('the bar it draws is the length it prints', () => {
  // The one way a scale bar can be actively wrong. Walked across four decades
  // of zoom, because the rung it lands on changes at every one of them.
  for (let pxPerMm = 0.002; pxPerMm < 200; pxPerMm *= 1.7) {
    for (const system of ['metric', 'imperial']) {
      const step = scaleStep(pxPerMm, 116, system);
      if (!step) continue;
      assert.ok(step.px <= 116, `overflowed at ${pxPerMm} ${system}`);
      assert.ok(Math.abs(step.mm * pxPerMm - step.px) < 1e-9,
        `bar and label disagree at ${pxPerMm} ${system}`);
    }
  }
});

test('the bar takes the longest rung that fits, not the nearest', () => {
  // A bar is read by comparing it against what is beside it, so a short one is
  // a worse answer than a long one even when the short one is closer to some
  // notional ideal length.
  const step = scaleStep(1, 116, 'metric');
  assert.equal(step.mm, 100);
});

test('no honest bar means no bar', () => {
  // Zoomed so far in that the smallest rung overflows the corner. Drawing a
  // clipped bar would be drawing a lie about its own length.
  assert.equal(scaleStep(1e6, 116, 'metric'), null);
  assert.equal(scaleStep(0, 116, 'metric'), null);
  assert.equal(scaleStep(2, 0, 'metric'), null);
});

test('a sheet is portrait until it is turned', () => {
  assert.deepEqual(paperMm('a4'), { w: 210, h: 297, label: 'A4' });
  assert.deepEqual(paperMm('a4', true), { w: 297, h: 210, label: 'A4' });
});

test('a sheet nobody has heard of draws nothing', () => {
  // The id arrives out of a .mbrd, so it can name a size a newer version added
  // or a size that never existed. Both have to end up where '' ends up, which
  // is the state the whole feature already handles because it is the default.
  for (const bad of ['', 'a9', 'A4', 'foolscap', null, undefined, 0, {}]) {
    assert.equal(paperMm(bad), null, `${String(bad)} was let through`);
  }
});

test('the A series halves down the ladder', () => {
  // The property that defines the series: each size is the one above folded in
  // half, so the long side of A(n+1) is the short side of A(n). This catches a
  // transposed pair in the table, which is the mistake that would look right in
  // the menu and be wrong on the board.
  const a = PAPERS.filter(p => /^a\d$/.test(p.id)).sort((x, y) => x.id.localeCompare(y.id));
  for (let i = 0; i < a.length - 1; i++) {
    const [, longer] = a[i].mm;
    const [next] = a[i + 1].mm;
    assert.ok(Math.abs(longer / 2 - next) <= 1,
      `${a[i + 1].label} is not half of ${a[i].label}`);
  }
});

test('every sheet is portrait in the table and has a unique id', () => {
  const ids = new Set();
  for (const p of PAPERS) {
    assert.ok(!ids.has(p.id), `${p.id} is listed twice`);
    ids.add(p.id);
    assert.ok(p.mm[0] < p.mm[1], `${p.label} is stored landscape`);
    assert.ok(p.mm[0] > 0 && Number.isFinite(p.mm[1]), `${p.label} has no size`);
  }
});

test('a sheet is measured by the same scale as everything else', () => {
  // The point of the outline: at 1 unit per mm an A4 is 210 units wide, and at
  // a scale set from a real object it is however many units that object made a
  // millimetre worth. Nothing about the sheet is stored in units.
  const sheet = paperMm('a4');
  assert.equal(toUnits(sheet.w, 1), 210);      // one unit per mm, said explicitly
  const half = scaleFrom(100, 200);            // 100 units measure 200 mm
  assert.equal(toUnits(sheet.w, half), 105);
  assert.equal(formatLength(toUnits(sheet.h, half), half, 'metric'), '29.7 cm');
});

test('imperial rungs are marks off a tape, never 2.5 inches', () => {
  const seen = new Set();
  for (let pxPerMm = 0.01; pxPerMm < 100; pxPerMm *= 1.3) {
    const step = scaleStep(pxPerMm, 116, 'imperial');
    if (step) seen.add(Math.round((step.mm / MM_PER_INCH) * 1000) / 1000);
  }
  assert.ok(seen.size > 3, 'the imperial ladder never moved');
  for (const inches of seen) {
    const round = inches < 1
      ? [0.25, 0.5].includes(inches)
      : Number.isInteger(inches);
    assert.ok(round, `${inches} in is arithmetic, not a mark on a tape`);
  }
});
