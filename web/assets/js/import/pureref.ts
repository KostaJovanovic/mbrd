// PureRef .pur files, read: the pictures and where they sat. Pure and
// synchronous; a hand-written reader of a file the app did not write, so every
// offset is checked before it is read. Layout after FyorDev/PureRef-format
// (MIT), which reverse-engineered the 1.10 format PureRef 1.11 still writes.
// A file whose layout cannot be read gives up its pictures as a grid instead.

import { oversize, mb } from '../consent.ts';

/** The whole file is held, then every picture is copied out of it. */
export const PUR_LIMIT = 768 * 1024 ** 2;
const MAX_DEPTH = 16;
const MAX_POINTS = 1024;
const MAX_ITEMS = 65536;
const HEADER = 224;
const TEXT_ITEM = 32;
const IMAGE_ITEM = 34;

type PurPicture ={ bytes: Uint8Array, mime: 'image/png' | 'image/jpeg', width: number, height: number };

/** Where a card goes, in PureRef's own space: pixels, y down, centre at (x, y). */
type PurPlaced =
  | { kind: 'image', picture: number, name: string, x: number, y: number, w: number, h: number,
      rot: number, z: number, crop: { x: number, y: number, w: number, h: number } | null,
      flip: { x: boolean, y: boolean } | null }
  | { kind: 'missing', name: string, x: number, y: number, w: number, h: number, rot: number, z: number }
  | { kind: 'text', text: string, x: number, y: number, w: number, h: number, rot: number, z: number };

export type PurRead = { pictures: PurPicture[], placed: PurPlaced[], laidOut: boolean };

const corrupt = (why: string) => new Error(`that PureRef file is damaged: ${why}`);

/** A big-endian cursor that refuses to step outside the bytes it was given. */
class Reader {
  b: Uint8Array;
  v: DataView;
  p: number;
  constructor(b: Uint8Array, p = 0) {
    this.b = b;
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    this.p = p;
  }
  need(n: number) {
    if (!(n >= 0) || this.p + n > this.b.length) throw corrupt(`it ends ${this.p + n - this.b.length} bytes early`);
  }
  skip(n: number) { this.need(n); this.p += n; }
  u8() { this.need(1); return this.b[this.p++]; }
  u32() { this.need(4); const v = this.v.getUint32(this.p); this.p += 4; return v; }
  peek() { this.need(4); return this.v.getUint32(this.p); }
  /** An offset; a high word past zero is a file over 4 GB, which this is not. */
  u64() {
    this.need(8);
    const hi = this.v.getUint32(this.p), lo = this.v.getUint32(this.p + 4);
    this.p += 8;
    if (hi) throw corrupt('an offset points past 4 GB');
    return lo;
  }
  f64() {
    this.need(8);
    const v = this.v.getFloat64(this.p);
    this.p += 8;
    if (!Number.isFinite(v)) throw corrupt('a position is not a number');
    return v;
  }
  /** Qt's QString: a byte length, then UTF-16BE. All ones is the null string. */
  str() {
    const n = this.u32();
    if (n === 0xffffffff) return '';
    if (n % 2) throw corrupt('a name has an odd length');
    this.need(n);
    let out = '';
    for (let i = 0; i < n; i += 2) out += String.fromCharCode((this.b[this.p + i] << 8) | this.b[this.p + i + 1]);
    this.p += n;
    return out;
  }
  /** A QTransform's 2x2 part, of the six doubles stored. */
  matrix(): Matrix {
    const m11 = this.f64(), m12 = this.f64();
    this.skip(8);
    const m21 = this.f64(), m22 = this.f64();
    this.skip(8);
    return [m11, m12, m21, m22];
  }
}

type Matrix = [number, number, number, number];

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const at = (b: Uint8Array, p: number, sig: number[]) => p + sig.length <= b.length && sig.every((s, i) => b[p + i] === s);
const u32at = (b: Uint8Array, p: number) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;

/** The end of a PNG starting at `p`, walked chunk by chunk to IEND, or -1. */
function pngEnd(b: Uint8Array, p: number): { end: number, width: number, height: number } | -1 {
  if (!at(b, p, PNG)) return -1;
  let q = p + 8, width = 0, height = 0;
  while (q + 12 <= b.length) {
    const len = u32at(b, q);
    if (len > b.length - q - 12) return -1;
    const type = String.fromCharCode(b[q + 4], b[q + 5], b[q + 6], b[q + 7]);
    if (q === p + 8) {
      if (type !== 'IHDR' || len < 8) return -1;
      width = u32at(b, q + 8);
      height = u32at(b, q + 12);
    }
    q += 12 + len;
    if (type === 'IEND') return width && height ? { end: q, width, height } : -1;
  }
  return -1;
}

/** The end of a JPEG starting at `p`: segments to the scan, the scan to EOI. */
function jpegEnd(b: Uint8Array, p: number): { end: number, width: number, height: number } | -1 {
  if (!(b[p] === 0xff && b[p + 1] === 0xd8 && b[p + 2] === 0xff)) return -1;
  let q = p + 2, width = 0, height = 0;
  while (q + 4 <= b.length) {
    if (b[q] !== 0xff) return -1;
    const m = b[q + 1];
    if (m === 0xff) { q++; continue; }
    if (m === 0xd9) return width && height ? { end: q + 2, width, height } : -1;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { q += 2; continue; }
    const len = (b[q + 2] << 8) | b[q + 3];
    if (len < 2 || q + 2 + len > b.length) return -1;
    // Every SOF but the DHT, JPG and DAC markers that share the range.
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc && len >= 7) {
      height = (b[q + 5] << 8) | b[q + 6];
      width = (b[q + 7] << 8) | b[q + 8];
    }
    q += 2 + len;
    if (m === 0xda) {
      // Entropy-coded data: a marker is 0xFF then anything but a stuffed zero or a restart.
      while (q + 1 < b.length && !(b[q] === 0xff && b[q + 1] !== 0 && !(b[q + 1] >= 0xd0 && b[q + 1] <= 0xd7))) q++;
    }
  }
  return -1;
}

const pictureAt = (b: Uint8Array, p: number): (PurPicture & { end: number }) | null => {
  const png = pngEnd(b, p);
  if (png !== -1) return { bytes: b.subarray(p, png.end), mime: 'image/png', width: png.width, height: png.height, end: png.end };
  const jpg = jpegEnd(b, p);
  if (jpg !== -1) return { bytes: b.subarray(p, jpg.end), mime: 'image/jpeg', width: jpg.width, height: jpg.height, end: jpg.end };
  return null;
};

/** Whether an item record starts at `p`: an offset, then 32 or 34, then "G" in UTF-16. */
const itemAt = (b: Uint8Array, p: number) => {
  if (p + 14 > b.length) return false;
  const kind = u32at(b, p + 8);
  return (kind === TEXT_ITEM || kind === IMAGE_ITEM) && b[p + 12] === 0 && b[p + 13] === 0x47;
};

type RawItem =
  | { kind: 'text', text: string, m: Matrix, x: number, y: number, z: number, children: RawItem[] }
  | { kind: 'image', id: number, name: string, m: Matrix, x: number, y: number, z: number,
      crop: { x: number, y: number, scale: number }, box: { x0: number, y0: number, x1: number, y1: number },
      children: RawItem[] };

function readItem(r: Reader, limit: number, depth: number, count: { n: number }): RawItem {
  if (depth > MAX_DEPTH) throw corrupt('items nest deeper than anything PureRef writes');
  if (++count.n > MAX_ITEMS) throw corrupt('it claims more items than it could hold');
  const start = r.p;
  const end = r.u64();
  const kind = r.u32();
  r.skip(kind);
  if (end <= r.p || end > limit) throw corrupt(`an item at ${start} ends outside the file`);
  let item: RawItem, childCount: number;
  if (kind === TEXT_ITEM) {
    const text = r.str();
    const m = r.matrix();
    const x = r.f64(), y = r.f64();
    r.skip(8);
    r.u32();
    const z = r.f64();
    r.skip(1 + 2 + 6 + 2 + 1 + 2 + 6 + 2);
    childCount = r.u32();
    item = { kind: 'text', text, m, x, y, z, children: [] };
  } else if (kind === IMAGE_ITEM) {
    // A zero here is a picture loaded by brute force, which has no name field.
    const brute = r.peek() === 0;
    if (brute) r.skip(4);
    // -1 is a field left out; anything else is a string's length.
    const field = () => {
      if (r.peek() !== 0xffffffff) return r.str();
      r.skip(4);
      return '';
    };
    const source = field();
    const name = (brute ? '' : field()) || source.slice(Math.max(source.lastIndexOf('/'), source.lastIndexOf('\\')) + 1);
    r.skip(8);
    const m = r.matrix();
    const x = r.f64(), y = r.f64();
    r.skip(8);
    const id = r.u32();
    const z = r.f64();
    r.matrix();
    const crop = { x: r.f64(), y: r.f64(), scale: r.f64() };
    const points = r.u32();
    if (points > MAX_POINTS) throw corrupt(`a crop claims ${points} corners`);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < points; i++) {
      r.skip(4);
      const px = r.f64(), py = r.f64();
      x0 = Math.min(x0, px); x1 = Math.max(x1, px);
      y0 = Math.min(y0, py); y1 = Math.max(y1, py);
    }
    if (!(x1 > x0 && y1 > y0)) throw corrupt('a picture has no size');
    r.skip(21);
    childCount = r.u32();
    item = { kind: 'image', id, name, m, x, y, z, crop, box: { x0, y0, x1, y1 }, children: [] };
  } else {
    throw corrupt(`an item of a kind nobody has described (${kind})`);
  }
  if (r.p > end) throw corrupt(`an item at ${start} runs past its own end`);
  r.p = end;
  if (childCount > MAX_ITEMS) throw corrupt(`an item claims ${childCount} children`);
  for (let i = 0; i < childCount; i++) item.children.push(readItem(r, limit, depth + 1, count));
  return item;
}

/** p mapped through a QTransform's 2x2 (row vector, as Qt has it) and moved to `at`. */
const map = (m: Matrix, px: number, py: number, ax: number, ay: number) =>
  ({ x: ax + px * m[0] + py * m[2], y: ay + px * m[1] + py * m[3] });

/** Scale, turn and mirror out of a 2x2, taken as a scale then a rotation. */
function decompose(m: Matrix) {
  const sx = Math.hypot(m[0], m[1]);
  if (!(sx > 0)) throw corrupt('a picture is scaled to nothing');
  const det = m[0] * m[3] - m[1] * m[2];
  const sy = det / sx;
  if (!sy) throw corrupt('a picture is scaled to nothing');
  return { sx, sy: Math.abs(sy), turn: Math.atan2(m[1], m[0]) * 180 / Math.PI, mirrored: sy < 0 };
}

/** The structured read: header, pictures, items, then the table tying them together. */
function readLayout(b: Uint8Array): PurRead {
  if (b.length < HEADER) throw corrupt('it is shorter than its own header');
  const r = new Reader(b);
  const vlen = r.u32();
  if (vlen < 2 || vlen > 64 || vlen % 2) throw new Error('that is not a PureRef file');
  r.p = 0;
  if (!/^\d+\.\d+/.test(r.str())) throw new Error('that is not a PureRef file');
  r.p = 16;
  const refsAt = r.u64();
  if (refsAt < HEADER || refsAt > b.length) throw corrupt('its table of pictures is outside the file');

  // Pictures, each either the bytes or four bytes naming the item that has them.
  const pictures: PurPicture[] = [];
  const byStart = new Map<number, number>();
  let p = HEADER;
  while (p < refsAt && !itemAt(b, p)) {
    const pic = pictureAt(b, p);
    if (pic) {
      byStart.set(p, pictures.length);
      pictures.push({ bytes: pic.bytes, mime: pic.mime, width: pic.width, height: pic.height });
      p = pic.end;
    } else {
      p += 4;
    }
  }
  if (p > refsAt) throw corrupt('its pictures run into its table');

  const items: RawItem[] = [];
  const count = { n: 0 };
  r.p = p;
  while (r.p < refsAt && itemAt(b, r.p)) items.push(readItem(r, refsAt, 0, count));

  // The table: the folder it was saved from, then item id -> the bytes it shows.
  r.p = refsAt;
  r.str();
  const shows = new Map<number, { start: number, end: number }>();
  while (r.p + 20 <= b.length) {
    const id = r.u32(), start = r.u64(), end = r.u64();
    if (end < start || end > b.length) throw corrupt('the table points outside the file');
    shows.set(id, { start, end });
  }
  const pictureOf = (id: number): number => {
    // A four-byte run is a copy: the id of the item holding the real bytes.
    for (let hops = 0, want = id; hops < 8; hops++) {
      const ref = shows.get(want);
      if (!ref) return -1;
      const found = byStart.get(ref.start);
      if (found !== undefined) return found;
      if (ref.end - ref.start !== 4) return -1;
      want = u32at(b, ref.start);
      if (want === 0xffffffff) return -1;
    }
    return -1;
  };

  const placed: PurPlaced[] = [];
  const place = (it: RawItem, parent: Matrix | null, px: number, py: number) => {
    // A child sits in its parent's space: its position goes through the parent's matrix.
    const origin = parent ? map(parent, it.x, it.y, px, py) : { x: it.x, y: it.y };
    const m: Matrix = parent
      ? [it.m[0] * parent[0] + it.m[1] * parent[2], it.m[0] * parent[1] + it.m[1] * parent[3],
          it.m[2] * parent[0] + it.m[3] * parent[2], it.m[2] * parent[1] + it.m[3] * parent[3]]
      : it.m;
    const d = decompose(m);
    if (it.kind === 'text') {
      const lines = it.text.split('\n');
      const w = Math.min(640, Math.max(140, Math.max(...lines.map(l => l.length)) * 9)) * d.sx;
      const h = Math.max(48, lines.length * 22 + 20) * d.sy;
      // A text item's origin is its top-left corner.
      const c = map(m, w / d.sx / 2, h / d.sy / 2, origin.x, origin.y);
      placed.push({ kind: 'text', text: it.text, x: c.x, y: c.y, w, h, rot: d.turn, z: it.z });
    } else {
      const { x0, y0, x1, y1 } = it.box;
      const c = map(m, (x0 + x1) / 2, (y0 + y1) / 2, origin.x, origin.y);
      const w = (x1 - x0) * d.sx, h = (y1 - y0) * d.sy;
      const picture = pictureOf(it.id);
      if (picture < 0) {
        placed.push({ kind: 'missing', name: it.name, x: c.x, y: c.y, w, h, rot: d.turn, z: it.z });
      } else {
        // The crop, as a share of the whole picture, whose top-left is (crop.x, crop.y).
        const pic = pictures[picture];
        const scale = it.crop.scale > 0 ? it.crop.scale : 1;
        const fw = pic.width * scale, fh = pic.height * scale;
        const raw = { x: (x0 - it.crop.x) / fw, y: (y0 - it.crop.y) / fh, w: (x1 - x0) / fw, h: (y1 - y0) / fh };
        const whole = raw.x <= 0.001 && raw.y <= 0.001 && raw.w >= 0.999 && raw.h >= 0.999;
        const sane = raw.x >= -0.001 && raw.y >= -0.001 && raw.x + raw.w <= 1.001 && raw.y + raw.h <= 1.001;
        placed.push({
          kind: 'image', picture, name: it.name, x: c.x, y: c.y, w, h, rot: d.turn, z: it.z,
          crop: whole || !sane ? null : raw,
          flip: d.mirrored ? { x: false, y: true } : null,
        });
      }
    }
    for (const child of it.children) place(child, m, origin.x, origin.y);
  };
  for (const it of items) place(it, null, 0, 0);
  return { pictures, placed, laidOut: true };
}

/** The fallback: every whole picture in the file, wherever it is, in a grid. */
export function scanPictures(b: Uint8Array): PurPicture[] {
  const out: PurPicture[] = [];
  for (let p = 0; p < b.length - 8; p++) {
    if (b[p] !== 0x89 && b[p] !== 0xff) continue;
    const pic = pictureAt(b, p);
    if (!pic) continue;
    out.push({ bytes: pic.bytes, mime: pic.mime, width: pic.width, height: pic.height });
    p = pic.end - 1;
  }
  return out;
}

const CELL = 320;

/** Pictures in rows, each fitted to a cell, centred on the origin. */
export function gridOf(pictures: PurPicture[]): PurPlaced[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(pictures.length)));
  const rows = Math.ceil(pictures.length / cols);
  return pictures.map((pic, i) => {
    const fit = Math.min(1, (CELL - 20) / Math.max(pic.width, pic.height));
    return {
      kind: 'image', picture: i, name: '',
      x: ((i % cols) - (cols - 1) / 2) * CELL, y: (Math.floor(i / cols) - (rows - 1) / 2) * CELL,
      w: pic.width * fit, h: pic.height * fit, rot: 0, z: i, crop: null, flip: null,
    };
  });
}

/**
 * A .pur, read. The layout when the file gives it up; the pictures alone, in a
 * grid, when it does not. Throws Oversize past PUR_LIMIT unless lifted, and an
 * Error when there is neither a layout nor a single picture to be had.
 */
export function readPur(b: Uint8Array, { lift = false } = {}): PurRead {
  if (!lift && b.length > PUR_LIMIT) {
    throw oversize('pur-bytes', `This PureRef file is ${mb(b.length)}, past the ${mb(PUR_LIMIT)} read at once.`);
  }
  let failed: unknown = null;
  try {
    const read = readLayout(b);
    // Pictures and no items to place them: the layout is what went missing.
    if (read.placed.length || !read.pictures.length) return read;
  } catch (err) {
    failed = err;
  }
  const pictures = scanPictures(b);
  if (!pictures.length) throw failed ?? new Error('there is nothing in that PureRef file');
  return { pictures, placed: gridOf(pictures), laidOut: false };
}
