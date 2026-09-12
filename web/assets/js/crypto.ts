// SHA-256 content ids for assets. Hand-written fallback for insecure contexts
// (http:// on a phone over LAN) where crypto.subtle is absent. Both paths must
// produce identical digests — tests/hash.test.js pins them against each other.
// Nothing about assets lives here; isHash() stays in util.ts so callers need
// not import a digest implementation to ask whether a string looks like one.

/** SHA-256 hex of a buffer — the content id for assets. Native when available, fallback below. */
export async function sha256(buf: ArrayBuffer | ArrayBufferView): Promise<string> {
  // SAFETY: view.buffer is ArrayBufferLike (admits SharedArrayBuffer), but this
  // app never has cross-origin isolation, so the cast is always correct.
  const bytes = buf instanceof ArrayBuffer
    ? new Uint8Array(buf)
    : new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength);
  // globalThis.crypto — bare `crypto` throws a ReferenceError when the global
  // is absent, before optional chaining can guard .subtle.
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return [...await sha256Words(bytes)].map(w => (w >>> 0).toString(16).padStart(8, '0')).join('');
}

/** The first thirty-two bits of the fractional cube roots of the first 64 primes. */
const SHA_K = Uint32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** Bytes hashed between yields. ~25x slower than native, so yield every ~frame. */
const HASH_SLICE = 256 * 1024;

/** Yield via MessageChannel — setTimeout clamps to 4ms after 5 nesting levels. */
function breathe(): Promise<void> {
  return new Promise<void>(done => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => { port1.close(); port2.close(); done(undefined); };
    port2.postMessage(0);
  });
}

/** FIPS 180-4. Walks in place — no padded copy, since the input can be hundreds of MB. */
async function sha256Words(bytes: Uint8Array): Promise<Uint32Array> {
  const H = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                           0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
  const w = new Uint32Array(64);
  const n = bytes.length;
  const whole = n - (n % 64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < whole; i += 64) {
    shaBlock(H, w, view, i);
    if (i && i % HASH_SLICE === 0) await breathe();
  }

  // Pad: 0x80, zeros, big-endian 64-bit length. Two blocks when <9 bytes remain.
  const rest = n - whole;
  const tail = new Uint8Array(rest < 56 ? 64 : 128);
  tail.set(bytes.subarray(whole));
  tail[rest] = 0x80;
  const tv = new DataView(tail.buffer);
  const bits = n * 8;
  tv.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
  tv.setUint32(tail.length - 4, bits >>> 0);
  for (let i = 0; i < tail.length; i += 64) shaBlock(H, w, tv, i);
  return H;
}

function shaBlock(H: Uint32Array, w: Uint32Array, view: DataView, off: number): void {
  for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15], y = w[i - 2];
    const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
    const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (let i = 0; i < 64; i++) {
    const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) | 0;
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0;
    d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
  H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
}
