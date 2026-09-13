// The desktop store's file format, and the bug it was written after.
//
// The desktop keeps recovery in `userData/store/<store>/<key>` rather than
// Chromium's evictable IndexedDB. Each file is a JSON envelope, a newline,
// and the raw bytes of every Blob the value held (desktop/format.mts).
//
// The format exists because JSON does not hold a Blob - a naive stringify
// turns one into `{}` with nothing throwing, so every picture comes back
// silently empty. The nesting made this easy to miss: `library` holds a
// packed Blob at the top, where a shallow check finds it; `assets` holds
// `{ blob, ext, mime, name }` one level down, where it doesn't. Both are here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encode, decode } from '../desktop/format.mts';

const bytesOf = (...values) => ({ __bytes: true, data: new Uint8Array(values).buffer });
const back = value => decode(encode(value));
const read = wrapped => [...new Uint8Array(wrapped.data)];

test('a value with no bytes in it is plain JSON and comes back as itself', () => {
  const value = { title: 'A board', items: [1, 2, 3], nested: { deep: true }, nothing: null };
  assert.deepEqual(back(value), value);
});

test('bytes at the top of a value round-trip - the shelf keeps a packed board there', () => {
  const out = back(bytesOf(1, 2, 3, 4));
  assert.equal(out.__bytes, true);
  assert.deepEqual(read(out), [1, 2, 3, 4]);
});

test('bytes one level down round-trip - this is the case that was broken', () => {
  // The asset record's real shape - a top-only converter wrote `{"blob":{}}`
  // here and lost the picture.
  const value = { blob: bytesOf(9, 8, 7), ext: 'png', mime: 'image/png', name: 'p.png' };
  const out = back(value);
  assert.deepEqual(read(out.blob), [9, 8, 7]);
  assert.equal(out.ext, 'png');
  assert.equal(out.name, 'p.png');
});

test('several byte fields in one value keep their own bytes', () => {
  // Two placements in one body - an off-by-one here shows up as one asset
  // holding another's pixels.
  const value = {
    a: { __bytes: true, data: new Uint8Array([1, 1, 1]).buffer },
    b: { __bytes: true, data: new Uint8Array([2, 2]).buffer },
    list: [{ __bytes: true, data: new Uint8Array([3]).buffer }],
  };
  const out = back(value);
  assert.deepEqual(read(out.a), [1, 1, 1]);
  assert.deepEqual(read(out.b), [2, 2]);
  assert.deepEqual(read(out.list[0]), [3]);
});

test('the MIME type travels with the bytes', () => {
  // Losing it turns every restored picture into a download prompt, a failure
  // nothing reports.
  const out = back({ __bytes: true, data: new Uint8Array([1]).buffer, mime: 'image/webp' });
  assert.equal(out.mime, 'image/webp');
});

test('empty bytes are bytes, not an absent value', () => {
  const out = back({ blob: { __bytes: true, data: new ArrayBuffer(0) } });
  assert.equal(out.blob.__bytes, true);
  assert.equal(out.blob.data.byteLength, 0);
});

test('a string full of newlines does not end the envelope early', () => {
  // The envelope terminates on the first raw newline, safe only because JSON
  // escapes one inside a string - otherwise a note with a line break would
  // truncate its own record.
  const value = { note: 'first\nsecond\n\nfourth', blob: bytesOf(5) };
  const out = back(value);
  assert.equal(out.note, 'first\nsecond\n\nfourth');
  assert.deepEqual(read(out.blob), [5]);
});

test('a Uint8Array is left alone, because only a literal is walked', () => {
  // A typed array rebuilt field by field comes back as `{0:1,1:2}` - the
  // prototype check keeps that a fact rather than an assumption.
  const out = back({ view: new Uint8Array([1, 2]) });
  assert.ok(!('__bytes' in (out.view ?? {})), 'not mistaken for a placement');
});

test('the format needs no Buffer - plain Uint8Array in and out', () => {
  // The Android bridge bundles format.mts into a WebView page, where Node's
  // Buffer does not exist. A Buffer is a Uint8Array too, so the check is on the
  // constructor, and decode() is fed a plain copy of what encode() wrote.
  const value = { note: 'pâte', blob: bytesOf(4, 5, 6) };
  const written = encode(value);
  assert.equal(written.constructor, Uint8Array, 'encode() returned a Buffer');
  const out = decode(new Uint8Array(written));
  assert.equal(out.note, 'pâte');
  assert.deepEqual(read(out.blob), [4, 5, 6]);
});

test('a truncated file is refused rather than read short', () => {
  // A crash mid-write is the expected damage. Node slices past the end
  // silently, which would hand the renderer a wrong-sized Blob - so length is
  // checked against the body, not trusted.
  const whole = encode({ blob: bytesOf(1, 2, 3, 4, 5, 6, 7, 8) });
  assert.throws(() => decode(whole.subarray(0, whole.length - 4)), /past the end/);
});

test('a file with no envelope at all is refused', () => {
  assert.throws(() => decode(Buffer.from('not a store file')), /no envelope/);
});

test('a version this build does not know is refused, not guessed at', () => {
  const wrong = Buffer.from('{"v":99,"value":{}}\n');
  assert.throws(() => decode(wrong), /unknown store format/);
});
