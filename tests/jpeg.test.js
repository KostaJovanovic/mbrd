// ui/jpeg.ts, the export's own JPEG encoder. It exists for one property the
// canvas cannot give - 4:4:4 - so that is checked in the bytes, along with
// the file's structure and the quality scale. Decoding is checked in a
// browser, where a decoder exists; here the stream is walked for shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeJpeg, qualityTable, LUMA_BASE } from '../web/assets/js/ui/jpeg.ts';

/** A w x h RGBA picture: a colour ramp with hard edges, the hard case. */
function picture(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      data[p] = (x * 13) & 255;
      data[p + 1] = (y * 7) & 255;
      data[p + 2] = ((x ^ y) & 8) ? 255 : 0;
      data[p + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/** The marker segments up to the scan, as { marker, body }. */
function segments(b) {
  assert.equal(b[0], 0xff); assert.equal(b[1], 0xd8, 'starts with SOI');
  const out = [];
  let i = 2;
  for (;;) {
    assert.equal(b[i], 0xff, `a marker at ${i}`);
    const m = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    out.push({ marker: m, body: b.subarray(i + 4, i + 2 + len) });
    i += 2 + len;
    if (m === 0xda) return { out, scan: i };
  }
}

test('every component is sampled 1x1 - the 4:4:4 the canvas would not give', async () => {
  const b = await encodeJpeg(picture(37, 21), { quality: 97 });
  const sof = segments(b).out.find(s => s.marker === 0xc0);
  assert.ok(sof, 'baseline SOF0');
  const body = sof.body;
  assert.equal((body[1] << 8) | body[2], 21, 'height');
  assert.equal((body[3] << 8) | body[4], 37, 'width');
  assert.equal(body[5], 3, 'three components');
  for (let c = 0; c < 3; c++) assert.equal(body[7 + c * 3], 0x11, `component ${c + 1} at 1x1`);
});

test('the scan is well formed: stuffed, and ends in EOI', async () => {
  const b = await encodeJpeg(picture(64, 48), { quality: 97 });
  const { scan } = segments(b);
  assert.equal(b[b.length - 2], 0xff); assert.equal(b[b.length - 1], 0xd9, 'ends with EOI');
  // Inside entropy data every 0xFF is followed by a stuffed zero.
  for (let i = scan; i < b.length - 2; i++) {
    if (b[i] === 0xff) assert.equal(b[i + 1], 0x00, `unstuffed 0xFF at ${i}`);
  }
});

test('the Huffman tables are the standard\'s, and complete', async () => {
  const b = await encodeJpeg(picture(8, 8), { quality: 50 });
  const dht = segments(b).out.find(s => s.marker === 0xc4).body;
  const counts = [];
  for (let i = 0; i < dht.length;) {
    const bits = [...dht.subarray(i + 1, i + 17)];
    const n = bits.reduce((a, v) => a + v, 0);
    counts.push([dht[i], n]);
    // Kraft: a prefix code of these lengths must fit - and leave the
    // all-ones code free, which the standard forbids using.
    const kraft = bits.reduce((a, v, l) => a + v / 2 ** (l + 1), 0);
    assert.ok(kraft < 1, `table ${dht[i].toString(16)} over-full`);
    i += 17 + n;
  }
  assert.deepEqual(counts, [[0x00, 12], [0x10, 162], [0x01, 12], [0x11, 162]]);
});

test('quality means what libjpeg means by it', () => {
  // The two ends every tool agrees on: 50 is the table as written, 100 is all ones.
  assert.deepEqual([...qualityTable(LUMA_BASE, 50)], [...LUMA_BASE]);
  assert.ok(qualityTable(LUMA_BASE, 100).every(v => v === 1));
  // 97 scales by 6%: 16 -> 1, 99 -> 6.
  const q97 = qualityTable(LUMA_BASE, 97);
  assert.equal(q97[0], 1);
  assert.equal(q97[63], 6);
});

test('the print density rides in the JFIF header', async () => {
  const b = await encodeJpeg(picture(8, 8), { quality: 90, ppi: 300 });
  const app0 = segments(b).out.find(s => s.marker === 0xe0).body;
  assert.equal(String.fromCharCode(...app0.subarray(0, 4)), 'JFIF');
  assert.equal(app0[7], 1, 'units: dots per inch');
  assert.equal((app0[8] << 8) | app0[9], 300);
  assert.equal((app0[10] << 8) | app0[11], 300);
});

test('a picture it cannot describe is refused, not written', async () => {
  await assert.rejects(encodeJpeg({ data: new Uint8Array(0), width: 0, height: 4 }, { quality: 90 }));
  await assert.rejects(encodeJpeg({ data: new Uint8Array(16), width: 4, height: 4 }, { quality: 90 }));
});
