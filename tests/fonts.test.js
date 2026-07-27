// A filename becoming a CSS family name.
//
// This is the one string in the font path that came from outside: a .woff2 is
// dropped in, its name is turned into a family, and that family is substituted
// into a real declaration - `--font-display: "Name", serif`. So the interesting
// cases are not the pretty ones. They are the filenames that would end the
// declaration early, and the ones that are perfectly ordinary but would produce
// a silly name if the rewriting were naive.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  axesFromFilename, familyFor, fontAxes,
} from '../web/assets/js/ui/fonts.js';
import {
  axisStep, variationSettings,
} from '../web/assets/js/ui/mobile-header.js';
import { isFamily } from '../web/assets/js/util.js';

test('an ordinary face keeps its name', () => {
  assert.equal(familyFor('Inter.woff2'), 'Inter');
  assert.equal(familyFor('SourceSerif4.otf'), 'SourceSerif4');
  // Separators are word breaks, not characters to keep.
  assert.equal(familyFor('Source-Serif-4.ttf'), 'Source Serif 4');
  assert.equal(familyFor('source_serif_4.woff'), 'source serif 4');
});

test('a variable font loses its axis list, not just its brackets', () => {
  // The shape every good variable font ships in. Turning the brackets into
  // spaces - which is the first thing you write - leaves the axis tags behind
  // as words, and the menu offers a face called "Fraunces opsz wght".
  assert.equal(familyFor('Fraunces[opsz,wght].woff2'), 'Fraunces');
  assert.equal(familyFor('Newsreader[opsz,wght]-Italic.woff2'), 'Newsreader Italic');
});

test('a variable filename supplies its advertised axes when WOFF2 hides its tables', () => {
  assert.deepEqual(axesFromFilename('Fraunces[opsz,wght].woff2'), [
    { tag: 'opsz', min: 6, default: 14, max: 144 },
    { tag: 'wght', min: 100, default: 400, max: 900 },
  ]);
  assert.deepEqual(axesFromFilename('Odd[ABCD].woff2'), [
    { tag: 'ABCD', min: 0, default: 0, max: 100 },
  ]);
});

test('an OpenType fvar table supplies exact axis bounds', async () => {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  writeTag(bytes, 0, '\0\u0001\0\0');
  view.setUint16(4, 1);
  writeTag(bytes, 12, 'fvar');
  view.setUint32(20, 28);
  view.setUint32(24, 36);
  view.setUint16(28, 1);
  view.setUint16(32, 16);
  view.setUint16(36, 1);
  view.setUint16(38, 20);
  writeTag(bytes, 44, 'wght');
  view.setInt32(48, fixed(100));
  view.setInt32(52, fixed(425));
  view.setInt32(56, fixed(900));

  const axes = await fontAxes({
    name: 'Exact.ttf',
    arrayBuffer: async () => bytes.buffer,
  });
  assert.deepEqual(axes, [{ tag: 'wght', min: 100, default: 425, max: 900 }]);
});

test('header variation settings use every non-weight axis and italic axis', () => {
  const axes = [
    { tag: 'wght', min: 100, default: 400, max: 900 },
    { tag: 'opsz', min: 9, default: 14, max: 144 },
    { tag: 'ital', min: 0, default: 0, max: 1 },
  ];
  assert.equal(
    variationSettings({ italic: true, axes: { opsz: 72 } }, axes),
    '"opsz" 72, "ital" 1',
  );
  assert.equal(axisStep(axes[1]), 1);
  assert.equal(axisStep(axes[2]), 1);
});

test('a name that cannot survive is replaced, not smuggled through', () => {
  // Each of these is a filename that would close the string or end the
  // declaration if it reached the stylesheet intact.
  for (const bad of [
    'a", monospace; background-image: url(http://x/y) ; font-family: "b.woff2',
    '"; display: none; ".woff2',
    'x\\27 y.woff2',
    '}.woff2',
  ]) {
    const family = familyFor(bad);
    assert.ok(isFamily(family), `${bad} -> ${family}`);
    // ...and nothing outside the alphabet got through by another route.
    assert.match(family, /^[A-Za-z0-9][A-Za-z0-9 _-]*$/);
  }
});

test('a name with nothing left of it gets one', () => {
  assert.equal(familyFor('....woff2'), 'Custom face');
  assert.equal(familyFor('###.ttf'), 'Custom face');
  assert.equal(familyFor(''), 'Custom face');
  assert.equal(familyFor(undefined), 'Custom face');
  // A leading digit is fine; a name that is only punctuation is not.
  assert.equal(familyFor('4Ever.woff2'), '4Ever');
});

test('a very long name is cut to something a menu can hold', () => {
  const family = familyFor('A'.repeat(300) + '.woff2');
  assert.ok(isFamily(family), family);
  assert.ok(family.length <= 40);
});

test('everything familyFor produces is something isFamily accepts', () => {
  // The two are a pair: one builds names, the other is what state.js holds a
  // .mbrd's font list to on the way in. A name this app makes and then refuses
  // to load back is a face that vanishes on the next save.
  for (const name of [
    'Inter.woff2', 'Fraunces[opsz,wght].woff2', '  spaced  out  .ttf',
    '1.otf', 'a.woff', 'Ω.woff2', '-leading-dash.woff2', '_.ttf',
  ]) {
    assert.ok(isFamily(familyFor(name)), `${name} -> ${familyFor(name)}`);
  }
});

test('isFamily refuses what a stylesheet could not survive', () => {
  assert.ok(!isFamily('a"b'));
  assert.ok(!isFamily('a;b'));
  assert.ok(!isFamily('a}b'));
  assert.ok(!isFamily('a\\b'));
  assert.ok(!isFamily(' leading space'));
  assert.ok(!isFamily('-leading dash'));
  assert.ok(!isFamily('A'.repeat(41)));
  assert.ok(!isFamily(''));
  assert.ok(!isFamily(null));
  assert.ok(!isFamily({ toString: () => 'Inter' }));
});

function writeTag(bytes, at, tag) {
  for (let i = 0; i < 4; i++) bytes[at + i] = tag.charCodeAt(i);
}

const fixed = value => Math.round(value * 65536);
