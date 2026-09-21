// exportScale()'s arithmetic. iOS Safari silently blanks any canvas past
// 16,777,216 pixels - no throw, no warning - and MAX_EDGE alone permits 64
// megapixels, four times that. exportScale() was pulled out of
// renderBoardCanvas() so the area-cap arithmetic could be tested on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exportScale, pixelsPerUnit, ppiOf, buildPdf, EXPORT_DEFAULTS, parseShadows,
} from '../web/assets/js/ui/snapshot.ts';
import { DEFAULT_SCALE, paperMm, toUnits } from '../web/assets/js/measure.ts';

/** What WebKit will draw. A copy, not imported - importing it would stop
 *  testing the limit if the module's copy ever moved. */
const IOS_CEILING = 16777216;

/**
 * The pixels a board of this size comes out as, both sides rounded up as the
 * renderer rounds them. `areaCap` is a parameter because the cap is not
 * universal: any engine but WebKit gets Infinity and the edge cap decides alone.
 */
const output = (w, h, maxEdge, areaCap) => {
  const scale = exportScale(w, h, maxEdge, areaCap);
  return { w: Math.max(1, Math.ceil(w * scale)), h: Math.max(1, Math.ceil(h * scale)) };
};

/** The cap the module applies where an engine needs it. */
const CAP = 16_000_000;

test('a board smaller than both ceilings is drawn at 1:1', () => {
  assert.equal(exportScale(1200, 800), 1, 'nothing is ever enlarged, and a small board is untouched');
  const out = output(1200, 800);
  assert.deepEqual(out, { w: 1200, h: 800 });
});

test('a long thin board is still held to the edge cap', () => {
  // 20000x500 is only 10 megapixels, inside the area ceiling - only the edge
  // cap catches it, which is why there are two ceilings and not one.
  const out = output(20000, 500);
  assert.ok(Math.max(out.w, out.h) <= 8000, `long edge ${out.w} must be inside MAX_EDGE`);
});

test('a big square board is held to the area ceiling where the engine needs it', () => {
  // The case that was blank on iOS: 6000x5000 cleared the edge cap at
  // 8000x6667, 53 megapixels.
  const out = output(6000, 5000, undefined, CAP);
  assert.ok(out.w * out.h <= IOS_CEILING,
    `${out.w}x${out.h} = ${out.w * out.h} px must be inside the ${IOS_CEILING} ceiling`);
  assert.ok(Math.max(out.w, out.h) < 8000, 'and the area cap, not the edge cap, is what bound it');
});

test('an engine with no area limit is not capped at all', () => {
  // Everything but WebKit draws whatever it is handed, so a desktop export
  // should stay full-size. The edge cap still applies - that one is about
  // what a person wants to be handed, not what the engine can hold.
  const asIs = output(6000, 5000, undefined, Infinity);
  assert.deepEqual(asIs, { w: 6000, h: 5000 }, 'a board inside the edge cap is untouched');
  assert.ok(asIs.w * asIs.h > IOS_CEILING, 'and is deliberately past what WebKit would draw');

  const huge = output(12000, 10000, undefined, Infinity);
  assert.equal(Math.max(huge.w, huge.h), 8000, 'the edge cap alone decides');
  assert.ok(huge.w * huge.h > IOS_CEILING, 'and 8000 x 6667 is 53 MP, uncapped');
});

test('the ceiling holds at every shape and size a board can be', () => {
  // Both sides round *up* after the scale is applied, so a budget set at
  // exactly the engine's limit would land over it - this proves the cap's
  // headroom covers that.
  for (const w of [500, 1000, 4096, 6000, 8000, 30000, 120000]) {
    for (const h of [500, 1000, 4096, 6000, 8000, 30000, 120000]) {
      const out = output(w, h, undefined, CAP);
      assert.ok(out.w * out.h <= IOS_CEILING,
        `${w}x${h} world -> ${out.w}x${out.h} = ${out.w * out.h} px, past the ceiling`);
      assert.ok(Math.max(out.w, out.h) <= 8000, `${w}x${h} world -> long edge ${Math.max(out.w, out.h)}`);
    }
  }
});

test('the thumbnail keeps its own tighter budget', () => {
  // boardThumb() passes max * 4, a smaller ceiling for a different reason,
  // and it must not loosen once the area cap sits beside it. Checked on the
  // uncapped side: small because the caller said so, not the engine.
  const out = output(6000, 5000, 1440, Infinity);
  assert.ok(Math.max(out.w, out.h) <= 1440, `long edge ${Math.max(out.w, out.h)} must respect the caller's cap`);
});

// ---------------------------------------------------------------------------
// Resolution: dots per inch of board
// ---------------------------------------------------------------------------

test('a sheet of A4 at 300 ppi is the pixel size a printer expects', () => {
  // The export box's default, and the reason it is phrased in ppi at all.
  // Checked at two board scales: the answer is about the paper, not the board.
  for (const scale of [DEFAULT_SCALE, 1, 12.5]) {
    const a4 = paperMm('a4');
    const ppu = pixelsPerUnit(EXPORT_DEFAULTS.ppi, scale);
    const w = Math.round(toUnits(a4.w, scale) * ppu);
    const h = Math.round(toUnits(a4.h, scale) * ppu);
    assert.deepEqual({ w, h }, { w: 2480, h: 3508 }, `at ${scale} units/mm`);
  }
});

test('ppiOf undoes pixelsPerUnit', () => {
  for (const ppi of [72, 150, 300, 600]) {
    assert.ok(Math.abs(ppiOf(pixelsPerUnit(ppi, DEFAULT_SCALE), DEFAULT_SCALE) - ppi) < 1e-9);
  }
});

test('an export may enlarge, but never past either ceiling', () => {
  // `want` above 1 is new: a small board at 300 ppi comes out bigger than
  // its own size in world units. The ceilings still win over it.
  assert.equal(exportScale(1000, 800, 8000, Infinity, 2.5), 2.5, 'what was asked for, when it fits');
  assert.equal(exportScale(4000, 800, 8000, Infinity, 2.5), 2, 'the edge cap binds first');
  const s = exportScale(3000, 3000, 8000, CAP, 2.5);
  assert.ok(Math.ceil(3000 * s) ** 2 <= IOS_CEILING, 'and the area cap still holds where it applies');
});

test('the defaults are the ones asked for', () => {
  // Written down because each is a decision rather than a leftover: 300 ppi,
  // JPEG 97 (4:4:4 - ui/jpeg.ts), no texture, no lattice, the web kept.
  assert.deepEqual(
    { ppi: EXPORT_DEFAULTS.ppi, quality: EXPORT_DEFAULTS.quality,
      grain: EXPORT_DEFAULTS.grain, grid: EXPORT_DEFAULTS.grid,
      web: EXPORT_DEFAULTS.web, sheet: EXPORT_DEFAULTS.sheet, tilt: EXPORT_DEFAULTS.tilt,
      shadows: EXPORT_DEFAULTS.shadows },
    { ppi: 300, quality: 0.97, grain: false, grid: false, web: true, sheet: true, tilt: true, shadows: true });
});

test('a shadow stack is read whatever colour syntax the engine computes', () => {
  // Chromium's computed --item-shadow, verbatim. The export read rgba() only,
  // so this - every shadow on every board - came back as none.
  const edge = 'color(srgb 0.192157 0.14902 0.105882 / 0.11) 0px 1px 1px 0px, '
    + 'color(srgb 0.192157 0.14902 0.105882 / 0.34) 0px 10px 22px -10px';
  assert.deepEqual(parseShadows(edge), [
    { color: 'color(srgb 0.192157 0.14902 0.105882 / 0.11)', x: 0, y: 1, blur: 1, spread: 0 },
    { color: 'color(srgb 0.192157 0.14902 0.105882 / 0.34)', x: 0, y: 10, blur: 22, spread: -10 },
  ]);
  // The legacy comma syntax must not be split at its own commas.
  assert.deepEqual(parseShadows('rgba(0, 0, 0, 0.2) 2px 3px 4px 0px'),
    [{ color: 'rgba(0, 0, 0, 0.2)', x: 2, y: 3, blur: 4, spread: 0 }]);
  assert.deepEqual(parseShadows('none'), []);
  assert.deepEqual(parseShadows('rgb(0, 0, 0) 0px 0px 0px 1px inset'), [], 'nothing casts inward');
});

test('the PDF page is the board\'s real size, not its pixel count', () => {
  // An A4 picture at 300 ppi must be an A4 page: 595 x 842 points, to the pixel.
  // It used to be 2480 x 3508 points - a sheet printed four times too wide.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  return buildPdf(jpeg, 2480, 3508, 300).text().then(pdf => {
    const box = pdf.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
    assert.ok(box, 'a MediaBox');
    assert.ok(Math.abs(+box[1] - 595.2) < 0.1 && Math.abs(+box[2] - 841.92) < 0.1,
      `page is ${box[1]} x ${box[2]} pt`);
    assert.match(pdf, /\/Width 2480 \/Height 3508/, 'the image keeps every pixel');
    assert.match(pdf, new RegExp(`q ${box[1]} 0 0 ${box[2]} 0 0 cm`), 'and fills the page');
  });
});
