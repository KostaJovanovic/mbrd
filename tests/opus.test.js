// The Ogg container writer.
//
// optimize/opus.ts is the sixth of the hand-written binary readers CLAUDE.md
// names, and the only one that also *writes* a format - which is the harder
// half. A reader that gets a length wrong refuses a file; a writer that gets
// one wrong produces a file that opens in this app and in nothing else, and the
// user finds out months later on somebody else's player.
//
// toOpus() itself needs AudioEncoder, AudioData and OfflineAudioContext, so it
// cannot run here. Everything under it can: the segment table, the CRC, the
// granule arithmetic and the two headers are pure functions of their arguments,
// and they are where all three of Ogg's off-by-ones live. They are exported for
// this file, with the reason written at the export.
//
// The segment-table rules being checked, since they are the whole of the
// format's cleverness:
//
//   - a packet is a run of 255s ended by a value below 255
//   - so a packet whose length is an exact multiple of 255 needs a trailing 0,
//     or the next packet is read as more of this one
//   - a table holds at most 255 entries, so a packet over 65,025 bytes spills
//     onto another page, which flags itself as a continuation and carries a
//     granule of -1 because nothing finished on it

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  crc32, pager, usableHead, opusHead, opusTags, base64,
} from '../web/assets/js/optimize/opus.ts';

const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));

/** Split a written stream back into pages, the way a player would. */
function pages(out) {
  const found = [];
  let at = 0;
  while (at < out.length) {
    assert.equal(ascii(out, at, 4), 'OggS', `no page header at ${at}`);
    const laces = out[at + 26];
    const table = out.subarray(at + 27, at + 27 + laces);
    const bodyLen = table.reduce((n, v) => n + v, 0);
    const dv = new DataView(out.buffer, out.byteOffset + at, 27);
    found.push({
      at,
      flags: out[at + 5],
      granuleLo: dv.getUint32(6, true),
      granuleHi: dv.getUint32(10, true),
      serial: dv.getUint32(14, true),
      seq: dv.getUint32(18, true),
      crc: dv.getUint32(22, true),
      laces: [...table],
      body: out.subarray(at + 27 + laces, at + 27 + laces + bodyLen),
      length: 27 + laces + bodyLen,
    });
    at += 27 + laces + bodyLen;
  }
  return found;
}

const bytes = n => Uint8Array.from({ length: n }, (_, i) => i & 0xff);

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

test('a stream of one small packet is one page, and it parses back', () => {
  const ogg = pager();
  ogg.packet(bytes(100), 0);
  ogg.page(true);
  const out = ogg.done();

  const [p, ...rest] = pages(out);
  assert.deepEqual(rest, [], 'one packet should not need two pages');
  assert.deepEqual(p.laces, [100], 'one lace under 255 ends the packet');
  assert.equal(p.body.length, 100);
  assert.equal(p.seq, 0);
  assert.equal(p.flags & 2, 2, 'the first page is flagged beginning-of-stream');
  assert.equal(p.flags & 4, 4, 'and this one is also the end');
});

test('the checksum is over the page with its own field zeroed', () => {
  // The one rule in Ogg that cannot be inferred from a hex dump, and the one a
  // player checks before anything else: get it wrong and every page is
  // rejected as corrupt.
  const ogg = pager();
  ogg.packet(bytes(500), 1234);
  ogg.page(true);
  const out = ogg.done();
  const [p] = pages(out);

  const copy = out.slice(p.at, p.at + p.length);
  new DataView(copy.buffer).setUint32(22, 0, true);
  assert.equal(crc32(copy), p.crc, 'the page does not checksum to what it carries');
  assert.notEqual(p.crc, 0, 'and the field is actually written');
});

test('the serial number is the same on every page, and constant across runs', () => {
  // optimize.ts addresses files by the hash of their bytes, so an encoder that
  // produced a different file every run would defeat its whole ledger.
  const build = () => {
    const ogg = pager();
    ogg.packet(bytes(300), 0); ogg.page();
    ogg.packet(bytes(300), 960); ogg.page(true);
    return ogg.done();
  };
  const a = build(), b = build();
  assert.deepEqual([...a], [...b], 'two runs produced different bytes');
  const serials = new Set(pages(a).map(p => p.serial));
  assert.equal(serials.size, 1, 'the pages disagree about which stream they are');
});

test('page sequence numbers count up from zero with no gaps', () => {
  const ogg = pager();
  for (let i = 0; i < 5; i++) { ogg.packet(bytes(80), i * 960); ogg.page(); }
  ogg.page(true);
  assert.deepEqual(pages(ogg.done()).map(p => p.seq), [0, 1, 2, 3, 4]);
});

// ---------------------------------------------------------------------------
// The segment table
// ---------------------------------------------------------------------------

test('a packet whose length is a multiple of 255 gets its terminating zero', () => {
  // Without it the next packet is read as more of this one - a stream that is
  // structurally valid, decodes to noise, and looks fine in a hex dump.
  const ogg = pager();
  ogg.packet(bytes(510), 0);
  ogg.page(true);
  const [p] = pages(ogg.done());
  assert.deepEqual(p.laces, [255, 255, 0], '510 bytes must end on a zero lace');
  assert.equal(p.body.length, 510, 'and the zero lace adds no body');
});

test('a packet one byte short of the multiple does not', () => {
  const ogg = pager();
  ogg.packet(bytes(509), 0);
  ogg.page(true);
  const [p] = pages(ogg.done());
  assert.deepEqual(p.laces, [255, 254]);
});

test('an empty packet is one zero lace', () => {
  const ogg = pager();
  ogg.packet(new Uint8Array(0), 0);
  ogg.page(true);
  const [p] = pages(ogg.done());
  assert.deepEqual(p.laces, [0]);
  assert.equal(p.body.length, 0);
});

test('a packet larger than a page spills, and the spill says so', () => {
  // The album-art case: 255 laces of 255 is 65,025 bytes, and a cover is
  // routinely bigger. The continuation page must flag itself and must carry a
  // granule of -1, because no packet finished on it.
  const ogg = pager();
  ogg.packet(bytes(70000), 4321);
  ogg.page(true);
  const out = pages(ogg.done());

  assert.ok(out.length >= 2, `70,000 bytes fitted on ${out.length} page(s)`);
  assert.equal(out[0].laces.length, 255, 'the first page fills its table');
  assert.equal(out[0].flags & 1, 0, 'the first page is not a continuation');
  assert.equal(out[0].granuleLo, 0xffffffff, 'nothing finished on it');
  assert.equal(out[0].granuleHi, 0xffffffff);
  assert.equal(out[1].flags & 1, 1, 'the second page is flagged as continued');

  const carried = out.reduce((n, p) => n + p.body.length, 0);
  assert.equal(carried, 70000, 'the packet lost bytes crossing the page boundary');
});

test('the granule is written as two little-endian halves', () => {
  const ogg = pager();
  ogg.packet(bytes(10), 0x1_0000_0007);
  ogg.page(true);
  const [p] = pages(ogg.done());
  assert.equal(p.granuleLo, 7);
  assert.equal(p.granuleHi, 1, 'the high word is dropped, so long tracks date wrongly');
});

test('closing a page with nothing on it writes nothing', () => {
  const ogg = pager();
  ogg.page();
  ogg.page(true);
  assert.equal(ogg.done().length, 0);
});

// ---------------------------------------------------------------------------
// The headers
// ---------------------------------------------------------------------------

test('a written identification header is the shape the format names', () => {
  const h = opusHead(2);
  assert.equal(h.length, 19);
  assert.equal(ascii(h, 0, 8), 'OpusHead');
  assert.equal(h[8], 1, 'version');
  assert.equal(h[9], 2, 'channels');
  assert.equal(h[10] | (h[11] << 8), 312, "libopus's own lookahead");
  assert.equal(new DataView(h.buffer).getUint32(12, true), 48000, 'the original rate');
  assert.equal(h[18], 0, 'mapping family 0 for stereo');
});

test("the encoder's own header is taken only when it fits the stream", () => {
  const good = opusHead(2);
  assert.equal(usableHead(good, 2), good, 'a matching header is used as it stands');
  assert.equal(usableHead(good, 1), null, 'a header claiming two channels on a mono stream');
  assert.equal(usableHead(null, 2), null);
  assert.equal(usableHead(good.subarray(0, 18), 2), null, 'too short to be one');
  const wrong = opusHead(2).slice();
  wrong[0] = 0x58;
  assert.equal(usableHead(wrong, 2), null, 'the magic is checked, not assumed');
});

test('the comment header carries its vendor and every tag, length-prefixed', () => {
  const t = opusTags([['TITLE', 'One'], ['ARTIST', 'Two']], null);
  assert.equal(ascii(t, 0, 8), 'OpusTags');
  const dv = new DataView(t.buffer);
  const vendorLen = dv.getUint32(8, true);
  assert.equal(ascii(t, 12, vendorLen), 'mbrd');

  let at = 12 + vendorLen;
  assert.equal(dv.getUint32(at, true), 2, 'two comments'); at += 4;
  const read = () => {
    const n = dv.getUint32(at, true); at += 4;
    const s = ascii(t, at, n); at += n;
    return s;
  };
  assert.equal(read(), 'TITLE=One');
  assert.equal(read(), 'ARTIST=Two');
  assert.equal(at, t.length, 'the block is exactly as long as its contents');
});

test('a cover rides in the comment header as METADATA_BLOCK_PICTURE', () => {
  const t = opusTags(null, 'AAAA');
  const dv = new DataView(t.buffer);
  const vendorLen = dv.getUint32(8, true);
  let at = 12 + vendorLen;
  assert.equal(dv.getUint32(at, true), 1); at += 4;
  const n = dv.getUint32(at, true); at += 4;
  assert.equal(ascii(t, at, n), 'METADATA_BLOCK_PICTURE=AAAA');
});

test('no tags and no cover is still a well-formed comment header', () => {
  const t = opusTags(null, null);
  const dv = new DataView(t.buffer);
  assert.equal(ascii(t, 0, 8), 'OpusTags');
  assert.equal(dv.getUint32(12 + dv.getUint32(8, true), true), 0, 'zero comments');
});

// ---------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------

test('base64 chunks without producing padding in the middle', () => {
  // The chunk size is a multiple of three so no boundary lands mid-triplet.
  // Getting that wrong yields a string that is valid base64 and decodes to
  // something else, which no player would report as an error - the cover just
  // does not appear.
  for (const n of [0, 1, 2, 3, 12287, 12288, 12289, 40000]) {
    const src = bytes(n);
    const encoded = base64(src);
    assert.equal(encoded.indexOf('='), n % 3 === 0 ? -1 : encoded.length - (3 - n % 3),
      `padding in the wrong place at ${n} bytes`);
    const back = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    assert.deepEqual([...back], [...src], `${n} bytes did not survive the round trip`);
  }
});

test('base64 of a cover-sized buffer does not overflow the stack', () => {
  // `String.fromCharCode(...bytes)` on 200 KB is 200,000 arguments in one call,
  // which throws on every engine. This is the size the chunking exists for.
  assert.doesNotThrow(() => base64(bytes(200 * 1024)));
});
