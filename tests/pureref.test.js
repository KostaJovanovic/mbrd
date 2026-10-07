// The PureRef reader: a file written the way FyorDev's writer writes one is
// read back into places, and a broken one gives up its pictures as a grid, or
// a plain Error - never a hang, never a lift-able Oversize for a lie.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readPur, scanPictures, PUR_LIMIT } from '../web/assets/js/import/pureref.ts';
import { isOversize } from '../web/assets/js/consent.ts';

/** A PNG the walker accepts: signature, IHDR, IEND. Nothing decodes it. */
function png(w, h) {
  const out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type, data) => {
    out.push(...u32(data.length), ...[...type].map(c => c.charCodeAt(0)), ...data, 0, 0, 0, 0);
  };
  chunk('IHDR', [...u32(w), ...u32(h), 8, 6, 0, 0, 0]);
  chunk('IEND', []);
  return out;
}
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u64 = n => [0, 0, 0, 0, ...u32(n)];
const f64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return [...b]; };
const utf16 = s => [...s].flatMap(c => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255]);
const qstr = s => [...u32(s.length * 2), ...utf16(s)];
const matrix = ([a, b, c, d]) => [...f64(a), ...f64(b), ...f64(0), ...f64(c), ...f64(d), ...f64(0)];

/** A file in the 1.10 layout: header, pictures, items, folder, table. */
function pur({ pictures, images, texts = [] }) {
  const out = Array.from({ length: 224 }, () => 0);
  out.splice(0, 12, ...u32(8), ...utf16('1.10'));
  const starts = [];
  for (const p of pictures) {
    starts.push([out.length, out.length + p.length]);
    out.push(...p);
  }
  // Every image item after the first on a picture is four bytes naming that first one.
  const firstOn = new Map();
  const dupes = [];
  for (const im of images) {
    if (firstOn.has(im.picture)) {
      dupes.push({ id: im.id, at: out.length });
      out.push(...u32(firstOn.get(im.picture)));
    } else {
      firstOn.set(im.picture, im.id);
    }
  }
  const item = (kind, body) => {
    const at = out.length;
    out.push(...u64(0), ...u32(kind), ...utf16(kind === 34 ? 'GraphicsImageItem' : 'GraphicsTextItem'), ...body);
    out.splice(at, 8, ...u64(out.length));
  };
  for (const im of images) {
    const [w, h] = [im.w, im.h];
    const crop = im.crop ?? [-w / 2, -h / 2, w / 2, h / 2];
    item(34, [
      ...qstr('C:/refs/' + im.name), ...qstr(im.name), ...f64(1),
      ...matrix(im.m), ...f64(im.x), ...f64(im.y), ...f64(1), ...u32(im.id), ...f64(im.z ?? 0),
      ...matrix([1, 0, 0, 1]), ...f64(-w / 2), ...f64(-h / 2), ...f64(1),
      ...u32(5),
      ...[[crop[0], crop[1]], [crop[2], crop[1]], [crop[2], crop[3]], [crop[0], crop[3]], [crop[0], crop[1]]]
        .flatMap(([x, y], i) => [...u32(i ? 1 : 0), ...f64(x), ...f64(y)]),
      ...f64(0), ...u32(1), 0, ...f64(-1).map(() => 255), ...u32(0),
    ]);
  }
  for (const t of texts) {
    item(32, [
      ...qstr(t.text), ...matrix([1, 0, 0, 1]), ...f64(t.x), ...f64(t.y), ...f64(1), ...u32(t.id), ...f64(9),
      1, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 1, 19, 136, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(0),
    ]);
  }
  const refs = out.length;
  out.push(...qstr('C:/refs'));
  for (const im of images) {
    const dupe = dupes.find(d => d.id === im.id);
    const [s, e] = dupe ? [dupe.at, dupe.at + 4] : starts[im.picture];
    out.push(...u32(im.id), ...u64(s), ...u64(e));
  }
  out.splice(16, 8, ...u64(refs));
  return new Uint8Array(out);
}

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} is not ${b}`);

const sample = () => pur({
  pictures: [png(200, 100), png(50, 80)],
  images: [
    { id: 1, picture: 0, name: 'wide.png', w: 200, h: 100, m: [2, 0, 0, 2], x: 300, y: 40, z: 2 },
    // Turned a quarter clockwise on screen, mirrored, and cropped to its left half.
    { id: 2, picture: 1, name: 'tall', w: 50, h: 80, m: [0, 1, 1, 0], x: -100, y: 0, z: 1, crop: [-25, -40, 0, 40] },
    { id: 3, picture: 0, name: 'wide again', w: 200, h: 100, m: [1, 0, 0, 1], x: 0, y: 500, z: 3 },
  ],
  texts: [{ id: 4, text: 'two\nlines', x: 10, y: 20 }],
});

test('a file in the 1.10 layout comes back placed, sized, turned, cropped and mirrored', () => {
  const read = readPur(sample());
  assert.equal(read.laidOut, true);
  assert.equal(read.pictures.length, 2);
  assert.deepEqual(read.pictures.map(p => [p.mime, p.width, p.height]), [['image/png', 200, 100], ['image/png', 50, 80]]);
  const [wide, tall, again, note] = read.placed;

  assert.equal(wide.kind, 'image');
  assert.equal(wide.name, 'wide.png');
  near(wide.x, 300, 'x'); near(wide.y, 40, 'y'); near(wide.w, 400, 'w'); near(wide.h, 200, 'h');
  near(wide.rot, 0, 'rot');
  assert.equal(wide.crop, null);
  assert.equal(wide.flip, null);

  // The left half of a 50x80, centred at local (-12.5, 0), through the swap.
  assert.equal(tall.picture, 1);
  near(tall.rot, 90, 'turn');
  assert.deepEqual(tall.flip, { x: false, y: true });
  near(tall.w, 25, 'cropped width'); near(tall.h, 80, 'height');
  near(tall.x, -100, 'x'); near(tall.y, -12.5, 'y');
  assert.deepEqual(tall.crop, { x: 0, y: 0, w: 0.5, h: 1 });

  // The copy shows the first item's bytes.
  assert.equal(again.picture, 0);
  near(again.y, 500, 'copy y');

  assert.equal(note.kind, 'text');
  assert.equal(note.text, 'two\nlines');
});

test('a file cut short gives up the pictures it still holds, as a grid', () => {
  const whole = sample();
  const cut = whole.subarray(0, 224 + png(200, 100).length + png(50, 80).length + 30);
  const read = readPur(cut);
  assert.equal(read.laidOut, false);
  assert.equal(read.pictures.length, 2);
  assert.equal(read.placed.length, 2);
  assert.ok(read.placed.every(p => p.kind === 'image' && p.rot === 0 && !p.crop));
});

test('an item whose end points past the file is damage, and the pictures still come', () => {
  const b = sample().slice();
  const first = 224 + png(200, 100).length + png(50, 80).length + 4;
  b.set(u64(b.length + 100), first);
  const read = readPur(b);
  assert.equal(read.laidOut, false);
  assert.equal(read.pictures.length, 2);
});

test('a crop claiming millions of corners is refused before anything is allocated', () => {
  const b = sample().slice();
  // The point count of the first image item sits just before its first corner.
  const first = 224 + png(200, 100).length + png(50, 80).length + 4;
  const skip = 8 + 4 + 34 + qstr('C:/refs/wide.png').length + qstr('wide.png').length + 8 + 48 + 16 + 8 + 4 + 8 + 48 + 24;
  b.set(u32(50_000_000), first + skip);
  const read = readPur(b);
  assert.equal(read.laidOut, false);
});

test('something that is not a PureRef file and holds no picture is a plain Error', () => {
  for (const b of [new Uint8Array(0), new Uint8Array(500), new TextEncoder().encode('hello '.repeat(100))]) {
    assert.throws(() => readPur(b), err => err instanceof Error && !isOversize(err));
  }
});

test('every truncation of a good file either reads or fails as damage, never as a lift', () => {
  const whole = sample();
  for (let n = 0; n < whole.length; n += 7) {
    try {
      readPur(whole.subarray(0, n));
    } catch (err) {
      assert.ok(err instanceof Error && !isOversize(err), `cut at ${n}: ${err}`);
    }
  }
});

test('a PNG with a chunk longer than the file is not a picture', () => {
  const bad = png(10, 10);
  bad.splice(8, 4, ...u32(0x7fffffff));
  assert.deepEqual(scanPictures(new Uint8Array(bad)), []);
});

test('a JPEG is walked to its end through stuffed bytes and restarts', () => {
  const jpg = [0xff, 0xd8,
    0xff, 0xc0, 0, 11, 8, 0, 30, 0, 40, 1, 1, 0x11, 0,
    0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
    1, 2, 0xff, 0x00, 3, 0xff, 0xd0, 4,
    0xff, 0xd9];
  const pics = scanPictures(new Uint8Array([9, 9, 9, ...jpg, 7, 7]));
  assert.equal(pics.length, 1);
  assert.deepEqual([pics[0].mime, pics[0].width, pics[0].height, pics[0].bytes.length], ['image/jpeg', 40, 30, jpg.length]);
});

test('past the ceiling is a question, not damage', () => {
  const big = new Uint8Array(8);
  Object.defineProperty(big, 'length', { value: PUR_LIMIT + 1 });
  assert.throws(() => readPur(big), err => isOversize(err) && err.ceiling === 'pur-bytes');
});
