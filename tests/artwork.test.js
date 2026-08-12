// Cover art out of the three container formats.
//
// Built rather than fixtured: a checked-in .mp3 would be a copyrighted file in
// the repository to test four bytes of header handling, and a hand-built tag
// says in the test what the parser is being asked to believe. Each builder here
// is the format's own spec written forwards, so a failure points at the parser
// rather than at a binary nobody can read.
//
// The pictures are real magic bytes and nothing more - coverArt() identifies a
// picture by sniffing it, never by trusting the tag's own MIME field, so four
// honest bytes exercise that path exactly as a whole JPEG would.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { coverArt, mayHaveArt } from '../web/assets/js/import/artwork.ts';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6]);

const bytes = (...parts) => {
  const flat = parts.flatMap(p => (typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : [...p]));
  return Uint8Array.from(flat);
};
const be32 = n => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be24 = n => [(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const syncsafe = n => [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];

const audio = (data, name) => new File([data], name);

/** An ID3v2 tag with one APIC frame, followed by a little fake audio. */
function mp3({ major = 3, mime = 'image/jpeg', pic = JPEG, desc = '', enc = 0, tagUnsync = false } = {}) {
  const descBytes = enc === 1
    ? [...[...desc].flatMap(c => [c.charCodeAt(0), 0]), 0, 0]
    : [...[...desc].map(c => c.charCodeAt(0)), 0];
  const body = major <= 2
    ? bytes([enc], mime === 'image/png' ? 'PNG' : 'JPG', [3], descBytes, pic)
    : bytes([enc], mime, [0], [3], descBytes, pic);
  const frame = major <= 2
    ? bytes('PIC', be24(body.length), body)
    : bytes('APIC', major === 4 ? syncsafe(body.length) : be32(body.length), [0, 0], body);
  const tagBody = tagUnsync ? unsync(frame) : frame;
  return bytes(
    'ID3', [major, 0], [tagUnsync ? 0x80 : 0], syncsafe(tagBody.length),
    tagBody,
    [0xff, 0xfb, 0x90, 0x00],       // where the audio would start
  );
}

/** Insert the 0x00 that unsynchronisation puts after every 0xFF. */
function unsync(b) {
  const out = [];
  for (const v of b) { out.push(v); if (v === 0xff) out.push(0); }
  return Uint8Array.from(out);
}

/** A FLAC stream: STREAMINFO, then a PICTURE block, then the last block. */
function flac({ pic = PNG, mime = 'image/png', last = false } = {}) {
  const picBlock = bytes(
    be32(3),                                    // picture type: front cover
    be32(mime.length), mime,
    be32(0),                                    // no description
    be32(600), be32(600), be32(24), be32(0),    // w, h, depth, colours
    be32(pic.length), pic,
  );
  return bytes(
    'fLaC',
    [0], be24(34), new Uint8Array(34),          // STREAMINFO, contents irrelevant
    [last ? 0x86 : 0x06], be24(picBlock.length), picBlock,
    ...(last ? [] : [[0x81], be24(2), [0, 0]]), // a last block after the picture
  );
}

/** An atom: size, name, payload. */
const atom = (name, ...payload) => {
  const body = bytes(...payload);
  return bytes(be32(body.length + 8), name, body);
};

/** An MP4 whose moov sits *after* the audio, as a streaming-ready file does. */
function m4a({ pic = JPEG, moovLast = true } = {}) {
  const covr = atom('covr', atom('data', be32(13), be32(0), pic));
  const moov = atom('moov', atom('udta', atom('meta', be32(0), atom('ilst', covr))));
  const ftyp = atom('ftyp', 'M4A ', be32(0), 'M4A ');
  const mdat = atom('mdat', new Uint8Array(64));
  return moovLast ? bytes(ftyp, mdat, moov) : bytes(ftyp, moov, mdat);
}

// ---------------------------------------------------------------------------
// ID3v2
// ---------------------------------------------------------------------------

test('finds a JPEG in an ID3v2.3 APIC frame', async () => {
  const art = await coverArt(audio(mp3(), 'song.mp3'));
  assert.ok(art, 'no art found');
  assert.equal(art.type, 'image/jpeg');
  assert.equal(art.name, 'cover.jpg');
  assert.deepEqual(new Uint8Array(await art.arrayBuffer()), JPEG);
});

test('reads v2.2, v2.3 and v2.4 alike', async () => {
  for (const major of [2, 3, 4]) {
    const art = await coverArt(audio(mp3({ major }), 'song.mp3'));
    assert.ok(art, `v2.${major} found nothing`);
    assert.deepEqual(new Uint8Array(await art.arrayBuffer()), JPEG, `v2.${major} got the wrong bytes`);
  }
});

test('steps over a description, in latin1 and in UTF-16', async () => {
  // The terminator is a null *in the description's own encoding*, so a UTF-16
  // description ends on a pair of zero bytes and a single one inside a
  // character is not the end of it. Getting this wrong slices into the picture.
  for (const enc of [0, 1]) {
    const art = await coverArt(audio(mp3({ enc, desc: 'front cover' }), 'song.mp3'));
    assert.ok(art, `encoding ${enc} found nothing`);
    assert.deepEqual(new Uint8Array(await art.arrayBuffer()), JPEG, `encoding ${enc} mis-sliced`);
  }
});

test('undoes tag-level unsynchronisation', async () => {
  // A JPEG begins 0xFF 0xD8, so an unsynchronised tag is exactly where a parser
  // that ignores the flag returns bytes that are not a picture.
  const art = await coverArt(audio(mp3({ tagUnsync: true }), 'song.mp3'));
  assert.ok(art, 'no art found');
  assert.deepEqual(new Uint8Array(await art.arrayBuffer()), JPEG);
});

test('believes the bytes, not the tag, about what the picture is', async () => {
  // 'image/png' declared over JPEG data. Real files get this wrong constantly.
  const art = await coverArt(audio(mp3({ mime: 'image/png', pic: JPEG }), 'song.mp3'));
  assert.equal(art.type, 'image/jpeg');
});

test('a tag with no picture in it yields nothing', async () => {
  const tag = bytes('ID3', [3, 0], [0], syncsafe(20), 'TIT2', be32(6), [0, 0], [0], 'hello');
  assert.equal(await coverArt(audio(tag, 'song.mp3')), null);
});

// ---------------------------------------------------------------------------
// FLAC
// ---------------------------------------------------------------------------

test('finds a PNG in a FLAC PICTURE block', async () => {
  const art = await coverArt(audio(flac(), 'song.flac'));
  assert.ok(art, 'no art found');
  assert.equal(art.type, 'image/png');
  assert.equal(art.name, 'cover.png');
  assert.deepEqual(new Uint8Array(await art.arrayBuffer()), PNG);
});

test('a FLAC picture in the last block is still found', async () => {
  const art = await coverArt(audio(flac({ last: true }), 'song.flac'));
  assert.ok(art, 'the last-block flag ended the walk too early');
});

test('a FLAC with no picture yields nothing', async () => {
  const plain = bytes('fLaC', [0x80], be24(34), new Uint8Array(34));
  assert.equal(await coverArt(audio(plain, 'song.flac')), null);
});

// ---------------------------------------------------------------------------
// MP4
// ---------------------------------------------------------------------------

test('finds a covr atom with the moov at the end of the file', async () => {
  // The case that matters: anything written for streaming puts moov after the
  // audio, so a parser that only reads the front of the file finds nothing.
  const art = await coverArt(audio(m4a({ moovLast: true }), 'song.m4a'));
  assert.ok(art, 'no art found');
  assert.equal(art.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await art.arrayBuffer()), JPEG);
});

test('finds it with the moov at the front too', async () => {
  const art = await coverArt(audio(m4a({ moovLast: false }), 'song.m4a'));
  assert.ok(art, 'no art found');
});

test("steps over meta's four bytes of version and flags", async () => {
  // 'meta' is the one container here whose children do not start immediately.
  // A walk that misses it reads ilst's size out of the middle of the version
  // field, which lands nowhere - so finding the picture at all proves this.
  const art = await coverArt(audio(m4a(), 'song.m4a'));
  assert.ok(art, 'the meta version field was not skipped');
});

test('an MP4 with no covr yields nothing', async () => {
  const bare = bytes(atom('ftyp', 'M4A ', be32(0), 'M4A '), atom('mdat', new Uint8Array(32)));
  assert.equal(await coverArt(audio(bare, 'song.m4a')), null);
});

// ---------------------------------------------------------------------------
// Refusing
// ---------------------------------------------------------------------------

test('nothing at all is not an error', async () => {
  // Every path answers null rather than throwing: most audio carries no art,
  // and the importer treats "no cover" as ordinary rather than as a failure.
  for (const junk of [new Uint8Array(0), new Uint8Array(4), bytes('not a music file at all')]) {
    assert.equal(await coverArt(audio(junk, 'song.mp3')), null);
  }
});

test('a picture the browser cannot draw is refused', async () => {
  // A TIFF, declared as one. Sniffing does not recognise it, so it never
  // becomes a cover that would mount as a broken image.
  const tiff = Uint8Array.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 2, 3, 4, 5, 6]);
  const art = await coverArt(audio(mp3({ mime: 'image/tiff', pic: tiff }), 'song.mp3'));
  assert.equal(art, null);
});

test('only the extensions that can carry art are worth reading', () => {
  for (const name of ['a.mp3', 'a.m4a', 'a.flac', 'A.MP3']) {
    assert.ok(mayHaveArt(name), `${name} should be worth a look`);
  }
  for (const name of ['a.wav', 'a.ogg', 'a.png', 'a']) {
    assert.ok(!mayHaveArt(name), `${name} should not be read at all`);
  }
});
