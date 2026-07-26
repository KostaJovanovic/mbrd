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
} from '../web/assets/js/ui/pigments.js';
import { TOKENS } from '../web/assets/js/ui/look.js';
import { safeVars } from '../web/assets/js/ui/look.js';

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

test('the second and third hues land where the tokens expect them', () => {
  const near = (a, b, tol = 10) => apart(a, b) < tol;
  const hueOf = c => oklch(...[1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))).h;

  // One hue: --leafy is turned away from the accent, because a board whose
  // ornamental wash is its own accent has no second voice at all.
  const one = paletteFor([200]);
  assert.ok(apart(hueOf(one['--leafy']), 200) > 45,
    `--leafy stayed at ${hueOf(one['--leafy'])}`);

  // Two: the second hue is the second voice.
  const two = paletteFor([200, 40]);
  assert.ok(near(hueOf(two['--leafy']), 40), `--leafy is ${hueOf(two['--leafy'])}`);

  // Three: the third takes --accent-warm outright, which is the only pigment
  // slot with a job in app.css that is not already spoken for.
  const three = paletteFor([200, 40, 320]);
  assert.ok(near(hueOf(three['--accent-warm']), 320),
    `--accent-warm is ${hueOf(three['--accent-warm'])}`);
  assert.ok(near(hueOf(three['--leafy']), 40));
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
    // Within a degree or two: gamut clipping gives up chroma, and a nearly
    // neutral paper carries so little of it that the hue wobbles.
    const off = Math.abs(((h - blue + 540) % 360) - 180);
    assert.ok(off < 3, `${key} is ${off.toFixed(1)} degrees off the pick`);
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
