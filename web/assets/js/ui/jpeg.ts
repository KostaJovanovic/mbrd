// Baseline JPEG encoder, 4:4:4 only - the board export's, and here because a
// canvas cannot be asked for it: toBlob() picks its own chroma sampling, and
// Blink picks 4:2:0 at every quality, which halves the colour resolution of
// every coloured letter and ruled edge on a card. No DOM and no state: pixels
// in, bytes out, yielding between block rows so a big board keeps the page
// breathing. The tables are the standard's own (ITU T.81 Annex K).

/** Zigzag position -> natural (row-major) index within an 8x8 block. */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
];

/** Annex K.1 quantisation tables, natural order, the quality-50 baseline. */
const Q_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];
const Q_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
];

/** Annex K.3 Huffman tables: code counts per length 1..16, then the symbols. */
const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];
const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/**
 * The AAN forward DCT leaves each coefficient scaled by these, row and column,
 * and by 8 overall - folded into the quantiser rather than undone per block.
 */
const AAN = [1, 1.387039845, 1.306562965, 1.175875602, 1, 0.785694958, 0.541196100, 0.275899379];

type Huffman = { code: Uint16Array, len: Uint8Array };

/** Canonical codes from counts and symbols (T.81 Annex C). */
function huffman(bits: readonly number[], vals: readonly number[]): Huffman {
  const code = new Uint16Array(256);
  const len = new Uint8Array(256);
  let c = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < bits[l - 1]; i++) {
      code[vals[k]] = c++;
      len[vals[k]] = l;
      k++;
    }
    c <<= 1;
  }
  return { code, len };
}

const DC_Y = huffman(DC_LUMA_BITS, DC_VALS);
const DC_C = huffman(DC_CHROMA_BITS, DC_VALS);
const AC_Y = huffman(AC_LUMA_BITS, AC_LUMA_VALS);
const AC_C = huffman(AC_CHROMA_BITS, AC_CHROMA_VALS);

/**
 * A quantisation table at a quality, 1..100 - libjpeg's scaling, so "97"
 * here means what it means in every tool that says it. Natural order.
 * Exported for the test.
 */
export function qualityTable(base: readonly number[], quality: number): Uint8Array {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  return Uint8Array.from(base, b => Math.min(255, Math.max(1, Math.floor((b * scale + 50) / 100))));
}
export const LUMA_BASE: readonly number[] = Q_LUMA;

/** The divisor for each natural index: the table and the DCT's own scale in one. */
function divisors(table: Uint8Array): Float32Array {
  const out = new Float32Array(64);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) out[r * 8 + c] = 1 / (table[r * 8 + c] * AAN[r] * AAN[c] * 8);
  }
  return out;
}

/** In-place float AAN DCT of one 8x8 block (the libjpeg jfdctflt shape). */
function fdct(d: Float32Array) {
  for (let pass = 0; pass < 2; pass++) {
    // Rows first (step 1, stride 8), then columns (step 8, stride 1).
    const step = pass === 0 ? 1 : 8;
    const stride = pass === 0 ? 8 : 1;
    for (let i = 0; i < 8; i++) {
      const o = i * stride;
      const d0 = d[o], d1 = d[o + step], d2 = d[o + 2 * step], d3 = d[o + 3 * step];
      const d4 = d[o + 4 * step], d5 = d[o + 5 * step], d6 = d[o + 6 * step], d7 = d[o + 7 * step];
      const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6;
      const t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4;

      let t10 = t0 + t3;
      const t13 = t0 - t3;
      let t11 = t1 + t2;
      let t12 = t1 - t2;
      d[o] = t10 + t11;
      d[o + 4 * step] = t10 - t11;
      const z1 = (t12 + t13) * 0.707106781;
      d[o + 2 * step] = t13 + z1;
      d[o + 6 * step] = t13 - z1;

      t10 = t4 + t5;
      t11 = t5 + t6;
      t12 = t6 + t7;
      const z5 = (t10 - t12) * 0.382683433;
      const z2 = 0.541196100 * t10 + z5;
      const z4 = 1.306562965 * t12 + z5;
      const z3 = t11 * 0.707106781;
      const z11 = t7 + z3;
      const z13 = t7 - z3;
      d[o + 5 * step] = z13 + z2;
      d[o + 3 * step] = z13 - z2;
      d[o + step] = z11 + z4;
      d[o + 7 * step] = z11 - z4;
    }
  }
}

/** A growing byte buffer with the entropy coder's bit accumulator on it. */
class Out {
  buf = new Uint8Array(1 << 16);
  n = 0;
  private acc = 0;
  private cnt = 0;

  private room(k: number) {
    if (this.n + k <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
  }
  byte(v: number) { this.room(1); this.buf[this.n++] = v; }
  word(v: number) { this.byte((v >> 8) & 255); this.byte(v & 255); }
  bytes(a: readonly number[] | Uint8Array) { this.room(a.length); this.buf.set(a, this.n); this.n += a.length; }

  /** The low `length` bits of `value`, most significant first, 0xFF stuffed. */
  bits(value: number, length: number) {
    // acc keeps under 8 bits between calls and length is at most 16, so the
    // shift never leaves 32-bit integer range.
    this.acc = (this.acc << length) | (value & ((1 << length) - 1));
    this.cnt += length;
    while (this.cnt >= 8) {
      const b = (this.acc >> (this.cnt - 8)) & 255;
      this.byte(b);
      if (b === 255) this.byte(0);
      this.cnt -= 8;
    }
    this.acc &= (1 << this.cnt) - 1;
  }
  /** Pad the last byte with ones, as the standard asks. */
  flush() { if (this.cnt > 0) this.bits((1 << (8 - this.cnt)) - 1, 8 - this.cnt); }
}

/** Bits needed for a magnitude - the JPEG "category". */
const size = (v: number) => (v === 0 ? 0 : 32 - Math.clz32(v < 0 ? -v : v));

const coeffs = new Int32Array(64);

/** Transform, quantise and entropy-code one block. Returns its DC for the next. */
function block(out: Out, d: Float32Array, div: Float32Array, prev: number, dc: Huffman, ac: Huffman) {
  fdct(d);
  for (let k = 0; k < 64; k++) {
    const n = ZIGZAG[k];
    const v = d[n] * div[n];
    // Rounded half away from zero, and held to what baseline can say.
    const r = v < 0 ? -Math.round(-v) : Math.round(v);
    coeffs[k] = k === 0 ? Math.max(-2047, Math.min(2047, r)) : Math.max(-1023, Math.min(1023, r));
  }

  const diff = Math.max(-2047, Math.min(2047, coeffs[0] - prev));
  const ds = size(diff);
  out.bits(dc.code[ds], dc.len[ds]);
  if (ds) out.bits(diff < 0 ? diff - 1 : diff, ds);

  let last = 63;
  while (last > 0 && coeffs[last] === 0) last--;
  let run = 0;
  for (let k = 1; k <= last; k++) {
    const v = coeffs[k];
    if (v === 0) { run++; continue; }
    for (; run > 15; run -= 16) out.bits(ac.code[0xf0], ac.len[0xf0]);
    const s = size(v);
    const sym = (run << 4) | s;
    out.bits(ac.code[sym], ac.len[sym]);
    out.bits(v < 0 ? v - 1 : v, s);
    run = 0;
  }
  if (last < 63) out.bits(ac.code[0], ac.len[0]);
  return coeffs[0];
}

function marker(out: Out, m: number, body: number[]) {
  out.word(0xff00 | m);
  out.word(body.length + 2);
  out.bytes(body);
}

/** How long a stretch of blocks may run before the page gets a turn. */
const SLICE_MS = 24;

/**
 * RGBA pixels to a baseline 4:4:4 JPEG file.
 *
 * `quality` is 1..100 on libjpeg's scale; 0 is read as 1, its floor, which
 * is what the export box's slider means at its left end. `ppi`, when given, goes into the
 * JFIF header as the print density, so an image editor opens the picture at
 * the size it was drawn for rather than at 72 dpi. Alpha is ignored - the
 * export fills its paper edge to edge first.
 */
export async function encodeJpeg(
  px: { data: Uint8ClampedArray | Uint8Array, width: number, height: number },
  { quality, ppi = 0 }: { quality: number, ppi?: number },
): Promise<Uint8Array<ArrayBuffer>> {
  const { data, width: W, height: H } = px;
  if (!(W > 0 && H > 0 && W <= 65535 && H <= 65535) || data.length < W * H * 4) {
    throw new Error(`cannot encode a ${W} x ${H} picture`);
  }
  const qy = qualityTable(Q_LUMA, quality);
  const qc = qualityTable(Q_CHROMA, quality);
  const divY = divisors(qy);
  const divC = divisors(qc);

  const out = new Out();
  out.word(0xffd8);
  const dens = Math.min(65535, Math.max(1, Math.round(ppi) || 72));
  // JFIF 1.01, density in dots per inch, no thumbnail.
  marker(out, 0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, ppi > 0 ? 1 : 0,
    dens >> 8, dens & 255, dens >> 8, dens & 255, 0, 0]);
  marker(out, 0xdb, [0, ...ZIGZAG.map(n => qy[n]), 1, ...ZIGZAG.map(n => qc[n])]);
  // SOF0: eight bits, three components, every one sampled 1x1 - the 4:4:4.
  marker(out, 0xc0, [8, H >> 8, H & 255, W >> 8, W & 255, 3,
    1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const dht: number[] = [];
  for (const [cls, bits, vals] of [
    [0x00, DC_LUMA_BITS, DC_VALS], [0x10, AC_LUMA_BITS, AC_LUMA_VALS],
    [0x01, DC_CHROMA_BITS, DC_VALS], [0x11, AC_CHROMA_BITS, AC_CHROMA_VALS],
  ] as const) dht.push(cls, ...bits, ...vals);
  marker(out, 0xc4, dht);
  marker(out, 0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);

  const Y = new Float32Array(64);
  const Cb = new Float32Array(64);
  const Cr = new Float32Array(64);
  let pY = 0, pCb = 0, pCr = 0;
  let since = performance.now();
  for (let by = 0; by < H; by += 8) {
    for (let bx = 0; bx < W; bx += 8) {
      for (let j = 0; j < 8; j++) {
        // Past the edge, the last row and column repeat - padding that
        // matches its neighbours costs nothing to code.
        const row = Math.min(by + j, H - 1) * W;
        for (let i = 0; i < 8; i++) {
          const p = (row + Math.min(bx + i, W - 1)) * 4;
          const r = data[p], g = data[p + 1], b = data[p + 2];
          const k = j * 8 + i;
          // JFIF's YCbCr, level-shifted to centre on zero.
          Y[k] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          Cb[k] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          Cr[k] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      pY = block(out, Y, divY, pY, DC_Y, AC_Y);
      pCb = block(out, Cb, divC, pCb, DC_C, AC_C);
      pCr = block(out, Cr, divC, pCr, DC_C, AC_C);
    }
    if (performance.now() - since > SLICE_MS) {
      await new Promise(resolve => setTimeout(resolve, 0));
      since = performance.now();
    }
  }
  out.flush();
  out.word(0xffd9);
  return out.buf.slice(0, out.n);
}
