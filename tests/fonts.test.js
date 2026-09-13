// A filename becoming a CSS family name.
//
// The one string in the font path that came from outside: a dropped .woff2's
// name becomes a family, substituted into `--font-display: "Name", serif`.
// The interesting cases are filenames that would end the declaration early,
// or produce a silly name if the rewriting were naive.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  axesFromFilename, familyFor, familyFrom, fontAxes, fontIsVariable, headerFontSize,
} from '../web/assets/js/ui/fonts.ts';
import {
  axisStep, variationSettings,
} from '../web/assets/js/ui/mobile-header.ts';
import { isFamily } from '../web/assets/js/util.ts';

test('an ordinary face keeps its name', () => {
  assert.equal(familyFor('Inter.woff2'), 'Inter');
  assert.equal(familyFor('SourceSerif4.otf'), 'SourceSerif4');
  // Separators are word breaks, not characters to keep.
  assert.equal(familyFor('Source-Serif-4.ttf'), 'Source Serif 4');
  assert.equal(familyFor('source_serif_4.woff'), 'source serif 4');
});

test('a variable font loses its axis list, not just its brackets', () => {
  // Turning brackets into spaces - the naive first attempt - leaves axis
  // tags behind as words: "Fraunces opsz wght".
  assert.equal(familyFor('Fraunces[opsz,wght].woff2'), 'Fraunces');
  assert.equal(familyFor('Newsreader[opsz,wght]-Italic.woff2'), 'Newsreader Italic');
});

test('a variable filename supplies its advertised axes when WOFF2 hides its tables', () => {
  // These bounds are a guess, leaning wide on purpose: overshooting ends the
  // slider in a dead zone (CSS clamps), undershooting hides part of the
  // face silently. opsz reaches 1200 because Playfair does.
  assert.deepEqual(axesFromFilename('Fraunces[opsz,wght].woff2'), [
    { tag: 'opsz', min: 5, default: 14, max: 1200 },
    { tag: 'wght', min: 100, default: 400, max: 900 },
  ]);
  // An unknown axis still gets a slider, with a shrug for bounds.
  assert.deepEqual(axesFromFilename('Odd[ABCD].woff2'), [
    { tag: 'ABCD', min: 0, default: 0, max: 100 },
  ]);
  // The tags a parametric family actually ships, each with its published range.
  assert.deepEqual(axesFromFilename('Recursive[CASL,MONO].woff2'), [
    { tag: 'CASL', min: 0, default: 0, max: 1 },
    { tag: 'MONO', min: 0, default: 0, max: 1 },
  ]);
});

test('a font with more axes than the panel holds gives its first axes, not none', async () => {
  // axisCount over 16 used to be read as a corrupt table and thrown away, so
  // the most variable faces (Roboto Flex, Amstelvar) offered no sliders. The
  // table must still fit its own declared length, which defends against a bad header.
  const axes = await fontAxes(fontWithAxes(20));
  assert.equal(axes.length, 20);
  assert.deepEqual(axes[0], { tag: 'AX00', min: 0, default: 50, max: 100 });
  assert.deepEqual(axes[19], { tag: 'AX19', min: 0, default: 50, max: 100 });

  // Past the cap it truncates rather than refuses - the same cap state.ts
  // limits stored axis values to.
  assert.equal((await fontAxes(fontWithAxes(40))).length, 32);
});

/** A minimal SFNT carrying nothing but an `fvar` with `count` axes. */
function fontWithAxes(count) {
  const FVAR = 28;
  const bytes = new Uint8Array(FVAR + 16 + count * 20);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000);   // sfnt version 1.0
  view.setUint16(4, 1);
  writeTag(bytes, 12, 'fvar');
  view.setUint32(20, FVAR);
  view.setUint32(24, 16 + count * 20);
  view.setUint16(FVAR, 1);
  view.setUint16(FVAR + 4, 16);
  view.setUint16(FVAR + 8, count);
  view.setUint16(FVAR + 10, 20);
  for (let i = 0; i < count; i++) {
    const at = FVAR + 16 + i * 20;
    writeTag(bytes, at, `AX${String(i).padStart(2, '0')}`);
    view.setInt32(at + 4, fixed(0));
    view.setInt32(at + 8, fixed(50));
    view.setInt32(at + 12, fixed(100));
  }
  return { name: 'Many.ttf', arrayBuffer: async () => bytes.buffer };
}

// WOFF2 keeps table data in one Brotli stream no browser decodes for us, so
// a bracketless .woff2 can never hand over its axes here. The uncompressed
// table directory answers the weaker question - is there an fvar at all -
// which decides whether the face gets a weight range or is stuck at 400.

test('a WOFF2 directory says whether the file is variable, without decompressing', async () => {
  // fvar named by its index into the known-tag list, which is the normal case.
  assert.equal(await fontIsVariable(woff2([{ index: 0 }, { index: 47 }])), true);
  assert.equal(await fontIsVariable(woff2([{ index: 0 }, { index: 1 }])), false);
  // ...and named literally, via the escape index.
  assert.equal(await fontIsVariable(woff2([{ index: 63, tag: 'fvar' }])), true);
  assert.equal(await fontIsVariable(woff2([{ index: 63, tag: 'ZZZZ' }])), false);
});

test('the directory walk stays in step across transformed tables', async () => {
  // The entry that can desynchronise the whole walk: glyf/loca are
  // transformed at version 0, every other table the other way round, and a
  // transformed entry carries a second length - miscounting puts the next
  // flags byte mid-number, so an fvar after glyf goes unseen.
  assert.equal(await fontIsVariable(
    woff2([{ index: 10, version: 0 }, { index: 47 }])), true);   // glyf, transformed
  assert.equal(await fontIsVariable(
    woff2([{ index: 10, version: 3 }, { index: 47 }])), true);   // glyf, null transform
  assert.equal(await fontIsVariable(
    woff2([{ index: 3, version: 1 }, { index: 47 }])), true);    // hmtx, transformed
  assert.equal(await fontIsVariable(
    woff2([{ index: 11, version: 0 }, { index: 63, tag: 'fvar' }])), true);

  // A length past one byte exercises the continuation bit too.
  assert.equal(await fontIsVariable(
    woff2([{ index: 0, length: 70000 }, { index: 47 }])), true);
});

test('a font that cannot be read is not variable, and does not throw', async () => {
  const truncated = { name: 'Cut.woff2', arrayBuffer: async () => new Uint8Array(20).buffer };
  assert.equal(await fontIsVariable(truncated), false);
  assert.equal(await fontIsVariable({ name: 'x.woff2', arrayBuffer: async () => { throw new Error('nope'); } }), false);
  assert.equal(await fontIsVariable(undefined), false);
  // A directory claiming more tables than it holds runs out, not past the end.
  const short = woff2([{ index: 0 }]);
  const bytes = new Uint8Array(await short.arrayBuffer());
  new DataView(bytes.buffer).setUint16(12, 40);
  assert.equal(await fontIsVariable({ arrayBuffer: async () => bytes.buffer }), false);
});

test('the other containers answer the same question through fvar itself', async () => {
  assert.equal(await fontIsVariable(fontWithAxes(3)), true);
  // A bracketless WOFF2 still yields no axes - why the weaker question is asked.
  assert.deepEqual(await fontAxes(woff2([{ index: 47 }])), []);
});

/** A WOFF2 header and table directory. No table data - none of it is read. */
function woff2(entries) {
  const dir = [];
  for (const { index, tag = '', version = 0, length = 64 } of entries) {
    dir.push(((version & 3) << 6) | (index & 0x3F));
    if (index === 63) for (const ch of tag) dir.push(ch.charCodeAt(0));
    dir.push(...base128(length));
    const paired = index === 10 || index === 11 || tag === 'glyf' || tag === 'loca';
    if (paired ? version === 0 : version !== 0) dir.push(...base128(length));
  }
  const bytes = new Uint8Array(48 + dir.length);
  bytes.set([0x77, 0x4F, 0x46, 0x32]);   // 'wOF2'
  new DataView(bytes.buffer).setUint16(12, entries.length);
  bytes.set(dir, 48);
  return { name: 'Dropped.woff2', arrayBuffer: async () => bytes.buffer };
}

/** UIntBase128: seven bits a byte, high bit set on every one but the last. */
function base128(value) {
  const out = [value & 0x7F];
  for (let rest = value >>> 7; rest > 0; rest >>>= 7) out.unshift(0x80 | (rest & 0x7F));
  return out;
}

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
  // Each would close the string or end the declaration if it reached the
  // stylesheet intact.
  for (const bad of [
    'a", monospace; background-image: url(http://x/y) ; font-family: "b.woff2',
    '"; display: none; ".woff2',
    'x\\27 y.woff2',
    '}.woff2',
  ]) {
    const family = familyFor(bad);
    assert.ok(isFamily(family), `${bad} -> ${family}`);
    // Nothing outside the alphabet got through another route.
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
  // A pair: one builds names, the other is what state.ts holds a .mbrd's
  // font list to. A name made here and refused on load vanishes next save.
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

// ---------------------------------------------------------------------------
// The family off the font's own `name` table, not its filename
// ---------------------------------------------------------------------------

function utf16be(text) {
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[i * 2] = code >> 8;
    bytes[i * 2 + 1] = code & 0xFF;
  }
  return bytes;
}

/** A minimal SFNT carrying one `name` table built from the given records. */
function sfntWithNames(records, filename = 'Face.otf') {
  const rows = records.map(r => ({
    ...r,
    bytes: r.platform === 1
      ? Uint8Array.from([...r.text].map(c => c.charCodeAt(0) & 0xFF))
      : utf16be(r.text),
  }));
  const header = 6 + rows.length * 12;
  const storage = rows.reduce((n, r) => n + r.bytes.length, 0);
  const nameLen = header + storage;
  const nameAt = 12 + 16;                // one directory entry, then the table
  const bytes = new Uint8Array(nameAt + nameLen);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000);         // sfnt 1.0
  view.setUint16(4, 1);                  // one table
  writeTag(bytes, 12, 'name');
  view.setUint32(12 + 8, nameAt);        // its offset
  view.setUint32(12 + 12, nameLen);      // its length
  view.setUint16(nameAt + 2, rows.length);
  view.setUint16(nameAt + 4, header);    // storage starts after the records
  let strAt = 0;
  rows.forEach((r, i) => {
    const rec = nameAt + 6 + i * 12;
    view.setUint16(rec, r.platform);
    view.setUint16(rec + 2, r.encoding ?? 0);
    view.setUint16(rec + 6, r.nameID);
    view.setUint16(rec + 8, r.bytes.length);
    view.setUint16(rec + 10, strAt);
    bytes.set(r.bytes, nameAt + header + strAt);
    strAt += r.bytes.length;
  });
  return { name: filename, arrayBuffer: async () => bytes.buffer };
}

test('a face is named from its own name table, not its filename', async () => {
  // The file says BasicallyAMono-Bold; the face says Basically a mono.
  const otf = sfntWithNames(
    [{ platform: 3, encoding: 1, nameID: 1, text: 'Basically a mono' }],
    'BasicallyAMono-Bold.otf');
  assert.equal(await familyFrom(otf), 'Basically a mono');
});

test('the typographic family (16) wins over the basic family (1)', async () => {
  // A Bold face whose basic family still carries the weight - nameID 16 is the
  // weight-independent umbrella and is what a specimen should read.
  const otf = sfntWithNames([
    { platform: 3, encoding: 1, nameID: 1, text: 'Basically a mono Bold' },
    { platform: 3, encoding: 1, nameID: 16, text: 'Basically a mono' },
  ]);
  assert.equal(await familyFrom(otf), 'Basically a mono');
});

test('a Windows name wins over a Mac one', async () => {
  const otf = sfntWithNames([
    { platform: 1, encoding: 0, nameID: 1, text: 'Mac Name' },
    { platform: 3, encoding: 1, nameID: 1, text: 'Win Name' },
  ]);
  assert.equal(await familyFrom(otf), 'Win Name');
});

test('a name table that cannot be read falls back to the filename', async () => {
  // WOFF2 table data is one Brotli stream with no decoder here.
  assert.equal(await familyFrom(woff2([{ index: 0 }])), 'Dropped');
  // A file object with no bytes has only its filename to go on.
  assert.equal(await familyFrom({ name: 'Inter.woff2' }), 'Inter');
  assert.equal(await familyFrom(undefined), 'Custom face');
});

const fixed = value => Math.round(value * 65536);

test('only Playfair asks the masthead to open at a size of its own', () => {
  // "Playfair only" is the requirement, so the negative half matters: every
  // other face must leave the size dial alone rather than snapping it.
  assert.equal(headerFontSize('Playfair'), 15);
  for (const face of [
    'Fraunces', 'Geist', 'Georgia', 'Times New Roman',
    'Iowan Old Style', 'Palatino Linotype',
  ]) assert.equal(headerFontSize(face), null, face);
  assert.equal(headerFontSize(''), null);            // Default follows the display face
  assert.equal(headerFontSize('A Dropped Face'), null);
  assert.equal(headerFontSize(undefined), null);
});
