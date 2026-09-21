// The board's link to real-world sizes. Pure arithmetic and formatting,
// testable without a browser since measure.ts takes its settings as
// arguments rather than reaching into `board`. Guards three ways this can
// lie: a nonsense scale from a file, a rounding that overstates precision,
// and a scale bar whose printed length doesn't match what was drawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toMm, toUnits, formatMm, formatLength, formatSize, scaleFrom, scaleStep,
  clampScale, DEFAULT_SCALE, MIN_SCALE, MAX_SCALE, MM_PER_INCH,
  PAPERS, paperMm, PX_PER_INCH,
} from '../web/assets/js/measure.ts';

test('the default scale puts A4 at 1325 units down its long side', () => {
  // The number the default is defined by, checked against the sheet it is
  // about rather than against itself: measure.ts writes 297 out beside it, and
  // PAPERS is where A4 actually lives.
  const a4 = paperMm('a4');
  assert.equal(toUnits(a4.h, DEFAULT_SCALE), 1325,
    `A4 came out ${toUnits(a4.h, DEFAULT_SCALE)} units tall`);
  assert.ok(Math.abs(toUnits(a4.w, DEFAULT_SCALE) - 936.87) < 0.01,
    `A4 came out ${toUnits(a4.w, DEFAULT_SCALE)} units wide`);
  // Those units read back as the sheet drawn, not 209.9mm of drift.
  const back = toMm(toUnits(a4.w, DEFAULT_SCALE), DEFAULT_SCALE);
  assert.equal(formatMm(back), '21 cm');
  assert.equal(formatMm(back, 'imperial'), '8.27 in');
});

test('the default scale is no longer life size, and nothing claims it is', () => {
  // It was, and the claim is easy to leave behind in a comment or a readout.
  // An inch of board is now about 113 CSS pixels at 1:1, not 96.
  assert.notEqual(toUnits(MM_PER_INCH, DEFAULT_SCALE), PX_PER_INCH);
  assert.ok(toUnits(MM_PER_INCH, DEFAULT_SCALE) > PX_PER_INCH,
    'the default got smaller, not larger - check which way round 1325 went');
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
  // Not a wrong number but a readout stuck saying "Infinity cm" or "NaN" -
  // in the one part of the interface whose job is to be trusted.
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
  // The remainder can round up to a full twelve inches - nobody writes
  // that, so it has to carry into the feet instead.
  const almost = MM_PER_INCH * 23.98;
  assert.equal(formatMm(almost, 'imperial'), '2 ft');
});

test('negatives keep their sign and their unit', () => {
  // Coordinates are signed - half the board is at negative x - so this is
  // the common case for the HUD, not an edge one.
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
  // A sliver: 9mm by 4cm. Converting one into the other reads badly either
  // way, so neither is.
  const out = formatSize(9, 40, 1, 'metric');
  assert.ok(out.includes('mm') && out.includes('cm'), out);
});

test('the scale can be derived from one thing whose size is known', () => {
  // The way a board is actually calibrated: that card is 320 units and 80cm.
  const scale = scaleFrom(320, 800);
  assert.equal(formatLength(320, scale, 'metric'), '80 cm');
  // Everything else on the board follows from it, with no second input.
  assert.equal(formatLength(160, scale, 'metric'), '40 cm');
});

test('deriving a scale from nothing falls back rather than dividing by zero', () => {
  assert.equal(scaleFrom(0, 100), DEFAULT_SCALE);
  assert.equal(scaleFrom(100, 0), DEFAULT_SCALE);
  assert.equal(scaleFrom(100, -5), DEFAULT_SCALE);
});

test('the scale bar is a round number that fits', () => {
  // 2px per mm, 116px of room: 50mm fits at 100px, 100mm would need 200.
  const step = scaleStep(2, 116, 'metric');
  assert.equal(step.mm, 50);
  assert.equal(step.px, 100);
});

test('the bar it draws is the length it prints', () => {
  // The one way a scale bar can be actively wrong. Walked across five
  // decades of zoom since the rung it lands on changes at each one.
  let drawn = 0;
  for (let pxPerMm = 0.002; pxPerMm < 200; pxPerMm *= 1.7) {
    for (const system of ['metric', 'imperial']) {
      const step = scaleStep(pxPerMm, 116, system);
      if (!step) continue;
      drawn++;
      assert.ok(step.px <= 116, `overflowed at ${pxPerMm} ${system}`);
      assert.ok(Math.abs(step.mm * pxPerMm - step.px) < 1e-9,
        `bar and label disagree at ${pxPerMm} ${system}`);
    }
  }
  // `if (!step) continue` is the loop's escape hatch: a scaleStep()
  // returning null at every zoom would pass, having drawn nothing.
  assert.ok(drawn > 20, `only ${drawn} of the ~30 zoom levels produced a bar at all`);
});

test('the bar takes the longest rung that fits, not the nearest', () => {
  // A bar is read against what's beside it, so a short one is a worse
  // answer than a long one even when closer to some ideal length.
  const step = scaleStep(1, 116, 'metric');
  assert.equal(step.mm, 100);
});

test('no honest bar means no bar', () => {
  // Zoomed so far in that the smallest rung overflows the corner - a
  // clipped bar would be a lie about its own length.
  assert.equal(scaleStep(1e6, 116, 'metric'), null);
  assert.equal(scaleStep(0, 116, 'metric'), null);
  assert.equal(scaleStep(2, 0, 'metric'), null);
});

test('a sheet is portrait until it is turned', () => {
  assert.deepEqual(paperMm('a4'), { w: 210, h: 297, label: 'A4' });
  assert.deepEqual(paperMm('a4', true), { w: 297, h: 210, label: 'A4' });
});

test('a sheet nobody has heard of draws nothing', () => {
  // The id arrives out of a .mbrd, so it can name a size a newer version
  // added or one that never existed - both must end up where '' does.
  for (const bad of ['', 'a9', 'A4', 'foolscap', null, undefined, 0, {}]) {
    assert.equal(paperMm(bad), null, `${String(bad)} was let through`);
  }
});

test('the A series halves down the ladder', () => {
  // The property that defines the series: each size is the one above
  // folded in half. Catches a transposed pair that would look right in the
  // menu and be wrong on the board.
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
  // At 1 unit per mm an A4 is 210 units wide; at a scale set from a real
  // object it's however many units that object made a millimetre worth.
  // Nothing about the sheet is stored in units.
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
