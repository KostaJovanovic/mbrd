// The content id, on a page that does not have WebCrypto.
//
// `crypto.subtle` is a secure-context API - open the board from a phone at
// http://<lan-ip>:6273 and it's simply not there, so every import's hash
// used to fail at once. crypto.ts carries a hand-written SHA-256 for that case.
//
// What these check is that it's the same hash: content ids are written
// into .mbrd archives and compared across machines, so a fallback
// producing its own digests would dedupe against nothing and reopen with
// assets unclaimed. Node's own crypto is the reference here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { sha256 } from '../web/assets/js/crypto.ts';

const reference = bytes => createHash('sha256').update(bytes).digest('hex');

/** Run `fn` with crypto.subtle taken away, as an insecure origin has it. */
async function withoutSubtle(fn) {
  const had = 'crypto' in globalThis;
  const before = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', {
    value: { getRandomValues: v => webcrypto.getRandomValues(v) },
    configurable: true, writable: true,
  });
  try {
    return await fn();
  } finally {
    if (had) Object.defineProperty(globalThis, 'crypto', { value: before, configurable: true, writable: true });
    else delete globalThis.crypto;
  }
}

/** Run `fn` with no `crypto` global at all - the case `crypto?.subtle` missed. */
async function withoutCrypto(fn) {
  const had = 'crypto' in globalThis;
  const before = globalThis.crypto;
  delete globalThis.crypto;
  try {
    return await fn();
  } finally {
    if (had) Object.defineProperty(globalThis, 'crypto', { value: before, configurable: true, writable: true });
  }
}

test('a missing crypto global takes the fallback rather than throwing', async () => {
  // `crypto?.subtle` reads as a check and isn't one: optional chaining
  // guards an absent property, but an undeclared identifier throws a
  // ReferenceError before the `?.` is reached - taking the whole import
  // path down with an error naming neither hashing nor the file.
  const b = fill(1024);
  const out = await withoutCrypto(() => sha256(b));
  assert.equal(out, reference(b));
});

/** Deterministic filler - a fixed pattern beats a random one that fails once. */
const fill = n => Uint8Array.from({ length: n }, (_, i) => (i * 37 + (i >> 8) * 11) & 0xff);

test('the fallback agrees with WebCrypto', async () => {
  const b = fill(4096);
  const native = await sha256(b);
  const fallback = await withoutSubtle(() => sha256(b));
  assert.equal(fallback, native);
  assert.equal(native, reference(b));
});

test('every padding case comes out right', async () => {
  // Block boundaries are what a hand-written SHA-256 gets wrong: 55 is the
  // last length whose count fits its own block, 56 needs a second, 64 has
  // no remainder. Empty is here because a zero-byte file is a real case.
  const lengths = [0, 1, 2, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 1000, 65_536];
  for (const n of lengths) {
    const b = fill(n);
    const got = await withoutSubtle(() => sha256(b));
    assert.equal(got, reference(b), `length ${n}`);
  }
});

test('it hashes what it was given, not the buffer around it', async () => {
  // Assets often arrive as views into a larger buffer - a hash quietly
  // taking the whole backing store would pass every test that allocated exactly.
  const whole = fill(300);
  const part = whole.subarray(64, 200);
  assert.equal(await withoutSubtle(() => sha256(part)), reference(part));
  assert.equal(await sha256(part), reference(part));
});

test('an ArrayBuffer hashes the same as a view of it', async () => {
  const b = fill(500);
  const both = [b, b.buffer];
  for (const input of both) {
    assert.equal(await withoutSubtle(() => sha256(input)), reference(b));
    assert.equal(await sha256(input), reference(b));
  }
});

test('the id is 64 lowercase hex either way', async () => {
  const b = fill(77);
  for (const hash of [await sha256(b), await withoutSubtle(() => sha256(b))]) {
    assert.match(hash, /^[0-9a-f]{64}$/);
  }
});
