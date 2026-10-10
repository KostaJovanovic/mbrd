// Byte readers for the hand-written binary parsers under import/ and mesh/:
// a range of a file, integers at an offset in either order, and short Latin-1
// runs. Each parser bounds-checks before it reads; only ascii() checks again,
// because a tag compared against a string reads the same whether it ran short.

/** Backed by an ArrayBuffer, which a Blob part has to be. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** `length` bytes of a file from `start`, through slice() so the rest is never
 *  read; empty when the range is. */
export async function bytes(file: Blob, start: number, length: number): Promise<Bytes> {
  if (start < 0 || length <= 0 || start >= file.size) return new Uint8Array(0);
  return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
}

export const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
/** Unsigned: the top byte is multiplied in rather than shifted into the sign bit. */
export const le32 = (b: Uint8Array, i: number) =>
  (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000;
export const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
export const be24 = (b: Uint8Array, i: number) => (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
export const be32 = (b: Uint8Array, i: number) =>
  ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/** ID3's synchsafe integer: 7 bits a byte, so no 0xFF looks like a frame header. */
export const syncsafe = (b: Uint8Array, i: number) =>
  (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];

/** `n` bytes from `i` as characters, or '' when they would run past the end. */
export const ascii = (b: Uint8Array, i: number, n = 4) =>
  i + n <= b.length ? String.fromCharCode(...b.subarray(i, i + n)) : '';

export const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
