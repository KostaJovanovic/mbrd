// A palette read off photographs has to be legible, and "legible" is the one
// property of it that can be tested rather than looked at.
//
// So the bulk of this file is not "does absinthe come out of a green picture" -
// that is a question about taste and the answer is a screenshot. It is the two
// things that would ship broken and never be noticed until somebody's board
// came out unreadable: that every hue on the wheel produces a palette whose ink
// clears its contrast floor, and that everything the extractor emits actually
// survives the filter it is about to be passed through.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  contrast, extractPalette, hex, huesOf, oklch, paletteFor, paletteFromAccent,
  PALETTE_TOKENS,
} from '../web/assets/js/ui/pigments.ts';
import { TOKENS } from '../web/assets/js/ui/look.ts';
import { safeVars } from '../web/assets/js/ui/look.ts';

/** `n` pixels of one colour, as the RGBA a canvas would hand back. */
function block(hexColour, n = 400) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hexColour.slice(i, i + 2), 16));
  const px = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255; }
  return px;
}

const apart = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

test('sRGB survives a round trip through OKLCh', () => {
  // Every one of these is in gamut by construction - they came out of sRGB - so
  // hex() must not have to give up any chroma to get back, and the result has
  // to be the same colour rather than merely a similar one.
  for (const c of ['#000000', '#ffffff', '#c25c2b', '#1f7a72', '#7d8f3c',
                   '#b4574f', '#372a1d', '#fbf8f1', '#0000ff', '#ffff00']) {
    const { L, C, h } = oklch(...[1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)));
    const back = hex(L, C, h);
    const off = [1, 3, 5].map(i =>
      Math.abs(parseInt(c.slice(i, i + 2), 16) - parseInt(back.slice(i, i + 2), 16)));
    assert.ok(Math.max(...off) <= 1, `${c} came back as ${back}`);
  }
});

test('contrast agrees with the values everybody knows', () => {
  assert.equal(+contrast('#ffffff', '#000000').toFixed(2), 21);
  assert.equal(+contrast('#777777', '#777777').toFixed(2), 1);
  // The canonical AA boundary colour pair, to catch a luminance formula that is
  // subtly wrong rather than obviously wrong.
  assert.ok(Math.abs(contrast('#767676', '#ffffff') - 4.54) < 0.02);
});

test('a hue too vivid for sRGB loses chroma, not hue or lightness', () => {
  // L 0.6 at chroma 0.4 is far outside sRGB for every hue. What comes back must
  // still be that lightness and that hue - the whole repair pass downstream is a
  // statement about lightness, and a gamut clip that moved it would undo it.
  for (let h = 0; h < 360; h += 30) {
    const got = oklch(...[1, 3, 5].map(i => parseInt(hex(0.6, 0.4, h).slice(i, i + 2), 16)));
    assert.ok(Math.abs(got.L - 0.6) < 0.02, `hue ${h} came back at L ${got.L}`);
    assert.ok(apart(got.h, h) < 3, `hue ${h} came back as ${got.h}`);
  }
});

// ---------------------------------------------------------------------------
// The vote
// ---------------------------------------------------------------------------

test('a solid colour votes for its own hue', () => {
  for (const c of ['#c25c2b', '#1f7a72', '#7d8f3c', '#b4574f', '#4050c0']) {
    const want = oklch(...[1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))).h;
    const [got] = huesOf([block(c)]);
    assert.ok(got != null && apart(got, want) < 8, `${c}: wanted ~${want}, got ${got}`);
  }
});

test('greys and near-blacks and near-whites do not vote', () => {
  assert.deepEqual(huesOf([block('#808080'), block('#3a3a3a'), block('#f2f2f2')]), []);
  // Black and white are not merely low-chroma, they are outside the lightness
  // window - a separate branch, and one that would happily return a hue.
  assert.deepEqual(huesOf([block('#000000'), block('#ffffff')]), []);
});

test('transparent pixels do not vote', () => {
  const px = block('#c25c2b');
  for (let i = 0; i < px.length; i += 4) px[i + 3] = 0;
  assert.deepEqual(huesOf([px]), []);
});

test('two distinct colours give two hues, and near neighbours give one', () => {
  const two = huesOf([block('#1f7a72'), block('#c25c2b')]);
  assert.equal(two.length, 2, `got ${two}`);
  assert.ok(apart(two[0], two[1]) >= 40);

  // Two greens a few degrees apart are one colour with variation in it, and a
  // palette that spent two slots on them would say the same thing twice.
  const one = huesOf([block('#7d8f3c'), block('#849439')]);
  assert.equal(one.length, 1, `got ${one}`);
});

test('never more than three hues, however many colours are in the picture', () => {
  const many = ['#c25c2b', '#1f7a72', '#7d8f3c', '#4050c0', '#b03a8a', '#d8c020'];
  assert.ok(huesOf(many.map(c => block(c))).length <= 3);
});

test('a grey screenshot with one stray coloured pixel does not vote', () => {
  // From a real board. A dark interface screenshot had exactly one pixel above
  // the neutral floor, and one-picture-one-vote handed it the same say as a
  // spectrogram with 771 - so a single olive pixel took the accent and coloured
  // the whole app. A picture has to be a coloured picture to vote like one.
  const grey = block('#3a3a3a', 2303);
  const stray = new Uint8ClampedArray(grey.length + 4);
  stray.set(grey);
  stray.set([0x87, 0x7e, 0x33, 255], grey.length);
  assert.deepEqual(huesOf([stray]), [], `one pixel voted: ${huesOf([stray])}`);

  // And the real board it came from: rose and magenta pictures outvote it, and
  // the palette is theirs rather than the stray pixel's.
  const real = huesOf([stray, block('#b0417f', 2304), block('#c25c4a', 2304)]);
  assert.ok(real.every(h => apart(h, 102) > 30), `the stray hue survived: ${real}`);
});

test('a small vivid thing outvotes a large washed-out one', () => {
  // The grey street with one red door. By pixel count the street wins twenty to
  // one; by what anybody would call the colour of the picture, the door does.
  const hues = huesOf([block('#b9b2a8', 4000), block('#d81e2c', 200)]);
  const red = oklch(0xd8, 0x1e, 0x2c).h;
  assert.ok(hues.length && apart(hues[0], red) < 12, `got ${hues}`);
});

// ---------------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------------

test('every hue on the wheel produces a legible palette', () => {
  // The one property that must hold for colours nobody chose. Stepped finely
  // enough to land inside the yellows and cyans, which are where lightness runs
  // out of gamut before it runs out of range and the repair pass has to give up
  // and flip the label instead.
  for (let h = 0; h < 360; h += 3) {
    const v = paletteFor([h]);
    const paper = v['--paper'];
    assert.ok(contrast(v['--ink'], paper) >= 7,
      `hue ${h}: ink on paper is ${contrast(v['--ink'], paper).toFixed(2)}`);
    assert.ok(contrast(v['--ink-2'], paper) >= 4.5,
      `hue ${h}: ink-2 on paper is ${contrast(v['--ink-2'], paper).toFixed(2)}`);
    assert.ok(contrast(v['--accent'], v['--accent-fg']) >= 4.5,
      `hue ${h}: accent-fg on accent is ${contrast(v['--accent'], v['--accent-fg']).toFixed(2)}`);
  }
});

const hueOf = c => oklch(...[1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))).h;
const near = (a, b, tol = 10) => apart(a, b) < tol;

test('every colour in the palette is a colour the pictures contain', () => {
  // The whole feature, and the thing an earlier scheme got wrong by putting the
  // accent 150 degrees off the sheet on general principle: a warm board came
  // out with a blue button that was in none of its photographs. A hue that no
  // picture holds may not appear in a palette taken from the pictures.
  for (const hues of [[40, 200], [200, 260], [0, 170, 200], [95, 300, 20]]) {
    const v = paletteFor(hues);
    for (const key of ['--accent', '--accent-deep', '--paper', '--ink']) {
      assert.ok(hues.some(h => apart(hueOf(v[key]), h) < 12),
        `${key} came out at ${hueOf(v[key]).toFixed(0)}, which is in none of ${hues}`);
    }
  }
});

test('with nothing to weigh, the accent is the hue furthest from the sheet', () => {
  // Bare angles carry no standing, so distance decides alone. Of the colours
  // actually on the board, the one that makes the most visible button - as much
  // of the contrast advice as can be had without inventing a colour.
  const two = paletteFor([200, 40]);
  assert.ok(near(hueOf(two['--accent']), 40), `--accent is ${hueOf(two['--accent'])}`);

  const three = paletteFor([200, 260, 20]);
  assert.ok(near(hueOf(three['--accent']), 20), `--accent is ${hueOf(three['--accent'])}`);
  assert.ok(near(hueOf(three['--leafy']), 260), `--leafy is ${hueOf(three['--leafy'])}`);
});

test('a wisp of sky does not take the accent from a colour of the board', () => {
  // The board this rule was written for, to its measured standings: a warm
  // sheet at 62 degrees, a green at 133 that owns a third of one photograph,
  // and a blue at 248 that is fifty-three pixels of haze in another. Under the
  // old rule the blue won on distance alone and the board got a cobalt button.
  const board = [
    { h: 62.5, standing: 0.240 },
    { h: 247.5, standing: 0.017 },
    { h: 132.5, standing: 0.227 },
  ];
  const v = paletteFor(board);
  assert.ok(near(hueOf(v['--accent']), 132.5), `--accent is ${hueOf(v['--accent'])}`);
  // The sky is still on the board - it is a colour those photographs hold, and
  // membership was never the thing at fault. It takes the ornament, not the
  // button.
  assert.ok(near(hueOf(v['--leafy']), 247.5), `--leafy is ${hueOf(v['--leafy'])}`);
});

test('facing the sheet is worth a near-tie and never worth a rout', () => {
  // Distance is a thumb on the scale. Two real colours a hair apart in standing
  // go to the one that makes the better button...
  const tie = paletteFor([
    { h: 62, standing: 0.30 },
    { h: 100, standing: 0.20 },
    { h: 240, standing: 0.18 },
  ]);
  assert.ok(near(hueOf(tie['--accent']), 240), `--accent is ${hueOf(tie['--accent'])}`);

  // ...and a colour ten times the other's is not overtaken by any amount of
  // distance, since FACING_BONUS tops out at doubling.
  const rout = paletteFor([
    { h: 62, standing: 0.30 },
    { h: 100, standing: 0.20 },
    { h: 240, standing: 0.02 },
  ]);
  assert.ok(near(hueOf(rout['--accent']), 100), `--accent is ${hueOf(rout['--accent'])}`);
});

test('a board of one colour gets a palette in one colour', () => {
  // Three of the four presets put their accent within 13 degrees of their
  // paper. A board whose photographs are all one colour honestly is that, and
  // the alternative is a second hue nobody photographed.
  const one = paletteFor([200]);
  assert.ok(near(hueOf(one['--accent']), 200), `--accent is ${hueOf(one['--accent'])}`);
  assert.ok(near(hueOf(one['--paper']), 200, 12), `--paper is ${hueOf(one['--paper'])}`);
  // --leafy is still turned away: it is the ornamental wash, and a wash that is
  // its own accent is not a second voice at all.
  assert.ok(apart(hueOf(one['--leafy']), 200) > 45, `--leafy is ${hueOf(one['--leafy'])}`);
});

test('two voices too close to tell apart by hue are told apart by lightness', () => {
  // Both far from the sheet, so the accent takes one and --leafy the other and
  // they land 30 degrees apart - which is not enough for anybody to read as two
  // colours. Hue is spoken for by then, so lightness does the work.
  const crowded = paletteFor([0, 170, 200]);
  const roomy = paletteFor([0, 170, 30]);
  assert.ok(oklch(...[1, 3, 5].map(i => parseInt(crowded['--leafy'].slice(i, i + 2), 16))).L
    < oklch(...[1, 3, 5].map(i => parseInt(roomy['--leafy'].slice(i, i + 2), 16))).L - 0.05,
    'the crowded pair was left at the same lightness');
});

// ---------------------------------------------------------------------------
// What the photographs are, not just which hue they are
// ---------------------------------------------------------------------------

const chromaOf = c => oklch(...[1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))).C;
const lightOf = c => oklch(...[1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))).L;

test('vivid pictures make a stronger palette than muted ones', () => {
  const muted = paletteFor([200], { vivid: 0.03, key: 0.62 });
  const plain = paletteFor([200], { vivid: 0.065, key: 0.62 });
  const loud = paletteFor([200], { vivid: 0.18, key: 0.62 });
  // Measured on the paper rather than the accent, and that is not a dodge: a
  // teal accent is pinned at chroma 0.091 by sRGB itself long before the dial
  // runs out, so the accent would report the gamut's opinion and not this
  // file's. The paper's chroma is an order of magnitude lower and never clipped.
  assert.ok(chromaOf(muted['--paper']) < chromaOf(plain['--paper']));
  assert.ok(chromaOf(plain['--paper']) < chromaOf(loud['--paper']));
  // Bounded at both ends, and both bounds came down with the tables: the sheet
  // is a cast now rather than a dye, so even a board of neon signs prints on
  // something within 0.02 of neutral. The lower bound is what stops the dial
  // reaching plain white - a muted board still has a colour, faintly.
  assert.ok(chromaOf(loud['--paper']) <= 0.020, `${chromaOf(loud['--paper'])}`);
  assert.ok(chromaOf(muted['--paper']) >= 0.004, `${chromaOf(muted['--paper'])}`);
  // The reference photograph leaves the tables exactly as measured.
  assert.ok(Math.abs(chromaOf(plain['--paper']) - chromaOf(paletteFor([200])['--paper'])) < 0.001);
});

test('dark pictures make a deeper sheet, and it is still a sheet', () => {
  const night = paletteFor([200], { vivid: 0.085, key: 0.28 });
  const plain = paletteFor([200], { vivid: 0.085, key: 0.62 });
  const beach = paletteFor([200], { vivid: 0.085, key: 0.88 });
  assert.ok(lightOf(night['--paper']) < lightOf(plain['--paper']) - 0.02);
  assert.ok(lightOf(beach['--paper']) > lightOf(plain['--paper']));
  // Never a dark palette by the back door: this is a light interface with a
  // deeper sheet, and the floor is the bound that says so. 0.85 now, down from
  // 0.9 and then 0.87 - the dial has been widened twice, both times because a
  // board of night photographs came out looking like every other board. The
  // second widening is also the one that had to carry more: with the sheet
  // near-neutral, lightness is the only thing left that can tell two papers
  // apart.
  assert.ok(lightOf(night['--paper']) > 0.85, `paper went to ${lightOf(night['--paper'])}`);
  assert.ok(lightOf(beach['--paper']) < 1);
});

test('the plain end of the axis gets a white sheet whatever the pictures said', () => {
  // Harsh is where the board becomes a drawing, and a drawing is made on white
  // paper - so the axis overrules the photographs about the sheet, and only
  // about the sheet.
  for (const traits of [{ vivid: 0.2, key: 0.2 }, { vivid: 0.03, key: 0.9 }]) {
    const scrapbook = paletteFor([30], traits);
    const drawing = paletteFor([30], { ...traits, plain: true });
    assert.ok(lightOf(drawing['--paper']) > 0.98,
      `paper stayed at ${lightOf(drawing['--paper']).toFixed(3)}`);
    assert.ok(chromaOf(drawing['--paper']) < chromaOf(scrapbook['--paper']),
      'the plain sheet kept all of its tint');
    // Still this board's white, not the browser's.
    assert.ok(chromaOf(drawing['--paper']) > 0.002, 'the plain sheet lost all its tint');
    // The pigments are what the pictures said, at either end of the axis. Hue,
    // not the exact colour: the accent is repaired against the sheet it sits on
    // and the sheet has just moved, so a whiter paper can cost it a little
    // lightness. What it may not do is change colour.
    assert.ok(near(hueOf(drawing['--accent']), hueOf(scrapbook['--accent'])),
      `accent moved from ${hueOf(scrapbook['--accent'])} to ${hueOf(drawing['--accent'])}`);
  }
  // A hand-picked colour is subject to the axis too, and is still kept exactly.
  const picked = paletteFromAccent('#c2410c', { plain: true });
  assert.equal(picked['--accent'], '#c2410c');
  assert.ok(lightOf(picked['--paper']) > 0.98, `paper is ${lightOf(picked['--paper'])}`);
});

test('every hue stays legible however the pictures bend the tables', () => {
  // The dials move chroma and the sheet's lightness, and the contrast floors are
  // statements about exactly those. The guarantee has to hold at the corners,
  // not only in the middle - this is the whole of "still looks good".
  for (const vivid of [0.02, 0.085, 0.3]) {
    for (const key of [0.15, 0.62, 0.95]) {
      for (let h = 0; h < 360; h += 15) {
        const v = paletteFor([h], { vivid, key });
        const paper = v['--paper'];
        assert.ok(contrast(v['--ink'], paper) >= 7,
          `hue ${h} at vivid ${vivid} key ${key}: ink is ${contrast(v['--ink'], paper).toFixed(2)}`);
        assert.ok(contrast(v['--ink-2'], paper) >= 4.5,
          `hue ${h} at vivid ${vivid} key ${key}: ink-2 is ${contrast(v['--ink-2'], paper).toFixed(2)}`);
        assert.ok(contrast(v['--accent'], v['--accent-fg']) >= 4.5,
          `hue ${h} at vivid ${vivid} key ${key}: label is ${contrast(v['--accent'], v['--accent-fg']).toFixed(2)}`);
      }
    }
  }
});

/** A picture that is mostly grey, with a speck of one colour in it. */
function speck(hexColour, of = 400, k = 12) {
  const px = block('#808080', of);
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hexColour.slice(i, i + 2), 16));
  for (let i = 0; i < k; i++) { px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; }
  return px;
}

test('the hue that would win the accent is never cut before it is asked', () => {
  // The shortlist used to be cut by peak height in the vote and the roles then
  // chosen from the survivors by standing, so a hue could be the obvious accent
  // by a factor of twenty and be pruned by two hues with taller votes and almost
  // no colour in them. On a real board that made the accent flicker between two
  // unrelated colours as pictures were added: one photograph joining moved it
  // from blue to magenta on a vote tie decided by sort order.
  //
  // Here: three pictures of a sheet hue, two pictures each holding a speck of
  // yellow and a speck of green - four votes between them, next to nothing of
  // either colour - and one picture that is entirely blue.
  const chunks = [
    ...Array.from({ length: 3 }, () => block(hex(0.55, 0.12, 30))),
    ...Array.from({ length: 2 }, () => speck(hex(0.60, 0.12, 90))),
    ...Array.from({ length: 2 }, () => speck(hex(0.60, 0.12, 150))),
    block(hex(0.50, 0.20, 260)),
  ];
  const v = extractPalette(chunks);
  assert.ok(near(hueOf(v['--paper']), 30, 15),
    `the sheet should still be the hue most pictures hold, was ${hueOf(v['--paper']).toFixed(0)}`);
  assert.ok(near(hueOf(v['--accent']), 260, 15),
    `the accent should be the board's other real colour, was ${hueOf(v['--accent']).toFixed(0)}`);
});

test('a speck of a colour is still not a candidate at all', () => {
  // The other half of the same rule, and the reason MIN_SHARE stays a floor on
  // the *vote*: ordering the shortlist by standing must not let a hue that
  // almost no picture holds buy its way onto it with one saturated frame. This
  // is the sky case from rolesFor(), asked of the shortlist rather than of the
  // ranking - six photographs of a warm board, one of which has a scrap of
  // cyan in the corner.
  const chunks = [
    ...Array.from({ length: 6 }, () => block(hex(0.55, 0.12, 30))),
    speck(hex(0.55, 0.30, 200), 400, 3),
  ];
  const v = extractPalette(chunks);
  assert.ok(!near(hueOf(v['--accent']), 200, 25),
    `a scrap of cyan took the accent at ${hueOf(v['--accent']).toFixed(0)}`);
});

// ---------------------------------------------------------------------------
// The pigment is the colour, not only the angle
// ---------------------------------------------------------------------------
//
// Only the hue used to come out of the photographs: every extracted board
// printed its accent at the tables' L 0.548, C 0.147, so two boards with nothing
// in common came out as one design in two rotations. Lightness and chroma are
// now measured too, held inside the band a pigment has to stay in to be one.

/** A picture that is one colour, given in OKLCh - so a test can name a tone. */
const tone = (L, C, h, n = 400) => block(hex(L, C, h), n);

test('two boards of the same hue come out as different colours', () => {
  const neon = extractPalette([tone(0.50, 0.24, 263)]);
  const dusty = extractPalette([tone(0.55, 0.06, 263)]);
  assert.ok(apart(hueOf(neon['--accent']), hueOf(dusty['--accent'])) < 12,
    'the hue is the same in both, which is the point of the comparison');
  assert.ok(chromaOf(neon['--accent']) > chromaOf(dusty['--accent']) + 0.1,
    `neon ${chromaOf(neon['--accent']).toFixed(3)} vs dusty ${chromaOf(dusty['--accent']).toFixed(3)}`);
  assert.notEqual(neon['--accent'], dusty['--accent']);
});

test('the accent carries the lightness and chroma the pictures had', () => {
  // Inside the wearable band the measurement is taken rather than approached: a
  // board of exactly this colour gets exactly this colour as its accent.
  for (const [L, C, h] of [[0.48, 0.09, 33], [0.55, 0.06, 263]]) {
    const v = extractPalette([tone(L, C, h)]);
    assert.ok(Math.abs(lightOf(v['--accent']) - L) < 0.03,
      `L ${lightOf(v['--accent']).toFixed(3)} for a picture at ${L}`);
    assert.ok(Math.abs(chromaOf(v['--accent']) - C) < 0.02,
      `C ${chromaOf(v['--accent']).toFixed(3)} for a picture at ${C}`);
  }
});

test('the contrast floor may darken a measured accent, and only darken it', () => {
  // A green at 0.62 cannot carry a light label, so repair() walks it down until
  // it can - which is the one thing allowed to overrule the photographs, and the
  // reason it moves L and never C. The measurement is a starting point for the
  // legibility pass, not a licence to skip it.
  const v = extractPalette([tone(0.62, 0.13, 150)]);
  assert.ok(lightOf(v['--accent']) < 0.62, 'the floor pulled it down');
  assert.ok(contrast(v['--accent'], v['--accent-fg']) >= 4.5, 'and pulled it far enough');
  assert.ok(Math.abs(chromaOf(v['--accent']) - 0.13) < 0.02,
    `chroma should survive the repair, was ${chromaOf(v['--accent']).toFixed(3)}`);
  // Never the other way: a dark picture is not brightened to meet a floor it
  // already clears.
  const dark = extractPalette([tone(0.40, 0.10, 150)]);
  assert.ok(lightOf(dark['--accent']) <= 0.43, `was ${lightOf(dark['--accent']).toFixed(3)}`);
});

test('a pigment stays a pigment however faint or extreme the pictures', () => {
  // The two bounds, and they are the only two. A hue with almost no colour in it
  // must not print a grey button; a picture too pale to be a button is brought
  // down to one rather than left to the contrast repair to salvage.
  const faint = extractPalette([tone(0.55, 0.05, 200)]);
  assert.ok(chromaOf(faint['--accent']) >= 0.045,
    `a near-grey board gave ${chromaOf(faint['--accent']).toFixed(3)}`);
  const pale = extractPalette([tone(0.92, 0.06, 90)]);
  assert.ok(lightOf(pale['--accent']) <= 0.80,
    `a chalk board gave a button at ${lightOf(pale['--accent']).toFixed(3)}`);
  const gloom = extractPalette([tone(0.15, 0.08, 300)]);
  assert.ok(lightOf(gloom['--accent']) >= 0.33,
    `a night board gave a button at ${lightOf(gloom['--accent']).toFixed(3)}`);
});

test('every measured colour still produces a legible palette', () => {
  // The same guarantee as the two tests above this section, now that the
  // pictures move two more axes than they used to. The corners are where it
  // would break: a dark saturated pigment against a dark sheet, a pale one
  // carrying a light label.
  for (const L of [0.2, 0.5, 0.9]) {
    for (const C of [0.05, 0.12, 0.3]) {
      for (let h = 0; h < 360; h += 15) {
        const v = extractPalette([tone(L, C, h)]);
        assert.ok(v, `no palette at all for L ${L} C ${C} hue ${h}`);
        const paper = v['--paper'];
        assert.ok(contrast(v['--ink'], paper) >= 7,
          `L ${L} C ${C} hue ${h}: ink is ${contrast(v['--ink'], paper).toFixed(2)}`);
        assert.ok(contrast(v['--ink-2'], paper) >= 4.5,
          `L ${L} C ${C} hue ${h}: ink-2 is ${contrast(v['--ink-2'], paper).toFixed(2)}`);
        assert.ok(contrast(v['--accent'], v['--accent-fg']) >= 4.5,
          `L ${L} C ${C} hue ${h}: label is ${contrast(v['--accent'], v['--accent-fg']).toFixed(2)}`);
      }
    }
  }
});

test('the deep accent stays the accent, darker', () => {
  for (const [L, C, h] of [[0.50, 0.24, 263], [0.48, 0.09, 33], [0.62, 0.13, 150]]) {
    const v = extractPalette([tone(L, C, h)]);
    assert.ok(apart(hueOf(v['--accent-deep']), hueOf(v['--accent'])) < 12,
      'the deep is the same hue');
    assert.ok(lightOf(v['--accent-deep']) < lightOf(v['--accent']),
      'and it is darker');
  }
});

test('a hue with nothing measured behind it still gets the tables', () => {
  // Bare angles are what a hand-picked colour and most of this file hand in.
  // There is no photograph to read a tone off, and the presets' own means are
  // the honest answer - so this path must come out exactly as it always did.
  const bare = paletteFor([200]);
  assert.ok(Math.abs(lightOf(bare['--accent']) - 0.548) < 0.01,
    `the table accent moved to L ${lightOf(bare['--accent']).toFixed(3)}`);
  assert.deepEqual(paletteFor([{ h: 200, standing: 0 }]), bare,
    'a hue carrying no tone is the same as a bare angle');
});

test('the sheet and the ink share the first hue', () => {
  const hueOf = c => oklch(...[1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))).h;
  for (const h of [20, 140, 260]) {
    const v = paletteFor([h, (h + 90) % 360]);
    for (const key of ['--paper', '--paper-3', '--ink', '--rule']) {
      assert.ok(apart(hueOf(v[key]), h) < 12, `${key} at hue ${h} is ${hueOf(v[key])}`);
    }
  }
});

test('pictures with no colour in them yield no palette at all', () => {
  // Null rather than a grey palette, because the caller's right move is to leave
  // the look alone and an all-neutral palette does not say that.
  assert.equal(extractPalette([block('#808080'), block('#4a4a4a')]), null);
  assert.equal(extractPalette([]), null);
  assert.equal(paletteFor([]), null);
});

test('the same pictures always give the same palette', () => {
  const px = [block('#1f7a72'), block('#c25c2b')];
  assert.deepEqual(extractPalette(px), extractPalette(px));
});

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

test('everything the extractor emits is something a look may hold', () => {
  // setPigments() puts this straight through safeVars(), so a token that is not
  // in TOKENS or a value that trips SAFE_VALUE is silently dropped - and a
  // palette missing its --ink is not a palette, it is a bug that only shows up
  // as one colour being wrong on somebody else's board.
  const vars = paletteFor([200, 40, 320]);
  const kept = safeVars(vars);
  assert.deepEqual(Object.keys(kept).sort(), Object.keys(vars).sort());
  for (const key of Object.keys(vars)) {
    assert.ok(TOKENS.has(key), `${key} is not a token a look may set`);
  }
});

// ---------------------------------------------------------------------------
// A whole sheet from one chosen colour
// ---------------------------------------------------------------------------

test('the colour picked is the colour kept', () => {
  // The difference between this and paletteFor(). An extraction has no opinion
  // to honour and takes the tables' lightness and chroma; somebody who reaches
  // for the picker and chooses #3355ff has, and handing them a different blue
  // back is overruling them with their own control.
  for (const picked of ['#3355ff', '#c2410c', '#15803d', '#a21caf', '#facc15']) {
    assert.equal(paletteFromAccent(picked)['--accent'], picked);
  }
});

test('a pick brings the whole sheet with it', () => {
  const vars = paletteFromAccent('#3355ff');
  // Every token the [data-palette] blocks declare, or the named palette
  // underneath goes on answering for whatever this one left out.
  assert.deepEqual(Object.keys(vars).sort(), [...PALETTE_TOKENS].sort());
});

test('the sheet a pick brings is the pick\'s own hue, not the table\'s', () => {
  const blue = oklch(0x33, 0x55, 0xff).h;
  const vars = paletteFromAccent('#3355ff');
  for (const key of ['--paper', '--paper-2', '--paper-3', '--ink', '--rule']) {
    const { h } = oklch(...[1, 3, 5].map(i => parseInt(vars[key].slice(i, i + 2), 16)));
    // Within a few degrees: gamut clipping gives up chroma, and a nearly
    // neutral paper carries so little of it that the hue wobbles. The tolerance
    // is 6 rather than the 3 it was because the papers are now a third as
    // chromatic - at chroma 0.008 a single step of 8-bit rounding is worth
    // several degrees, so this is sRGB's precision showing through and not the
    // sheet drifting off the pick.
    const off = Math.abs(((h - blue + 540) % 360) - 180);
    assert.ok(off < 6, `${key} is ${off.toFixed(1)} degrees off the pick`);
  }
});

test('the label on a picked accent is legible, whatever was picked', () => {
  // repair() darkens the accent to reach its floor, which this cannot do - the
  // pick is not ours to move. So the label moves instead, and the test is that
  // one of the two candidates always wins by enough.
  for (let h = 0; h < 360; h += 7) {
    const picked = hex(0.62, 0.16, h);
    const vars = paletteFromAccent(picked);
    const ratio = contrast(vars['--accent'], vars['--accent-fg']);
    assert.ok(ratio >= 3, `hue ${h}: label on accent is only ${ratio.toFixed(2)}`);
  }
});

test('a grey is not a palette', () => {
  // Every direction is equally wrong for a colour with no hue in it, and the
  // bins would hand back whatever rounding noise the pick happened to carry.
  assert.equal(paletteFromAccent('#808080'), null);
  assert.equal(paletteFromAccent('#ffffff'), null);
  assert.equal(paletteFromAccent('#000000'), null);
});

test('a pick that is not a colour is refused rather than guessed at', () => {
  assert.equal(paletteFromAccent('red'), null);
  assert.equal(paletteFromAccent('#abc'), null);
  assert.equal(paletteFromAccent(''), null);
  assert.equal(paletteFromAccent(null), null);
});

test('everything a pick produces survives the token filter', () => {
  const vars = paletteFromAccent('#c2410c');
  assert.deepEqual(Object.keys(safeVars(vars)).sort(), Object.keys(vars).sort());
});
