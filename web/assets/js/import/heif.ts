// A HEIF still (.heic/.heif) turned into a picture, for the engines that will
// not decode one. The container is read here - by hand, like every reader in
// this folder - and the HEVC inside it is handed to WebCodecs, which every
// engine that plays video already has. Null for anything missing or malformed:
// the caller has the embedded-preview path behind this one.

import { surface, surfaceToBlob } from '../canvas/surface.ts';
import type { Surface } from '../canvas/surface.ts';

// Ceilings - "the file is lying" backstops, not refusals. Past any of them the
// read gives up and returns null, exactly as it does for a truncated box. None
// of them is liftable, for the same reason MAX_IFDS in preview.ts is not: they
// bound a search rather than judge a file.
const MAX_BYTES = 256 * 1024 * 1024;   // a still this large is not one
const MAX_BOXES = 4096;                // boxes read from one container
const MAX_ITEMS = 4096;                // entries believed in iinf / iloc
const MAX_EXTENTS = 64;                // extents believed for one item
const MAX_TILES = 1024;                // cells in a grid (32 x 32 covers any phone)
const MAX_ITEM_BYTES = 64 * 1024 * 1024;

/** The largest picture this composes, in pixels: iOS Safari's canvas ceiling,
 * past which it draws nothing and says nothing. A larger grid is drawn scaled
 * to fit - the original file is kept either way, so nothing is lost. */
const CANVAS_PIXELS = 4096 * 4096;

/** JPEG because every engine decodes it, and Safari's canvas cannot write WebP. */
const QUALITY = 0.92;

/** Brands that mean "there is a HEVC still in here". `mif1` is the generic
 * image brand AVIF also carries, which is why the item type is checked too. */
const BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);

/** One stored extent of one item: where its bytes are, and which pool they
 * are in. `idat` names the meta box's own data rather than the file at large. */
type Extent = { off: number, len: number, idat: boolean };

/** One item of the meta box, as much of it as the walk below reads. */
type Item = { type: string, extents: Extent[], props: number[] };

/** What the container turned out to hold, before any of it is decoded. */
export type Plan = {
  /** The decoder configuration record, shared by every tile below. */
  hvcC: Uint8Array,
  /** Tile payloads in raster order. One entry for a picture that is not a grid. */
  tiles: Uint8Array[],
  cols: number,
  rows: number,
  /** The size the container says the finished picture is. */
  width: number,
  height: number,
  /** Quarter-turns anti-clockwise (irot), and the mirror (imir) before them. */
  rotate: number,
  mirror: 'none' | 'x' | 'y',
};

/**
 * Decode a HEIF still to a JPEG this browser can draw, or null.
 *
 * Null covers every "not for us" as well as every failure: a file that is not
 * HEIF, a browser with no WebCodecs, an HEVC profile the machine has no decoder
 * for. The caller treats all of them the same way, which is why none of them
 * throws.
 */
export async function heifPicture(file: File): Promise<File | null> {
  if (file.size < 16 || file.size > MAX_BYTES) return null;
  if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') return null;
  try {
    // The brand first, off sixty-four bytes: every other file this is offered -
    // a PSD, a RAW, a video - is turned away without reading the whole of it.
    if (!isHeif(new Uint8Array(await file.slice(0, 64).arrayBuffer()))) return null;
    const plan = readPlan(new Uint8Array(await file.arrayBuffer()));
    if (!plan) return null;
    const blob = await draw(plan);
    if (!blob) return null;
    // The original's stem, so a card that falls back to a filename still says
    // something recognisable - the same reason nativePreview() does it.
    return new File([blob], file.name.replace(/\.[^.]*$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    // A picture that throws is a picture we did not find.
    return null;
  }
}

/**
 * Whether these opening bytes are a HEIF still. Cheap enough to ask before
 * reading the whole file, and the one part of this module a test can reach
 * without a decoder.
 */
export function isHeif(head: Uint8Array): boolean {
  if (head.length < 12 || str(head, 4, 4) !== 'ftyp') return false;
  const size = Math.min(u32(head, 0), head.length);
  if (size < 12) return false;
  if (BRANDS.has(str(head, 8, 4))) return true;
  for (let o = 16; o + 4 <= size; o += 4) if (BRANDS.has(str(head, o, 4))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Reading the container
// ---------------------------------------------------------------------------

const u8 = (b: Uint8Array, i: number) => (i < b.length ? b[i] : 0);
const u16 = (b: Uint8Array, i: number) => (u8(b, i) << 8) | u8(b, i + 1);
const u32 = (b: Uint8Array, i: number) =>
  u8(b, i) * 0x1000000 + ((u8(b, i + 1) << 16) | (u8(b, i + 2) << 8) | u8(b, i + 3));

const str = (b: Uint8Array, i: number, n: number) =>
  i + n <= b.length ? String.fromCharCode(...b.subarray(i, i + n)) : '';

/** A box and the slice of the file it covers. `body` skips the header only. */
type Box = { type: string, start: number, end: number, body: number };

/**
 * The boxes between two offsets. Every size is validated against the window it
 * was found in before it is believed, and a size that does not fit ends the
 * walk rather than being clamped - a container that overruns its parent is not
 * a container this reads half of.
 */
function* boxes(b: Uint8Array, from: number, to: number): Generator<Box> {
  let o = from;
  for (let n = 0; o + 8 <= to && n < MAX_BOXES; n++) {
    let size = u32(b, o);
    let body = o + 8;
    if (size === 1) {
      // 64-bit size. The high word must be zero for any file this can hold.
      if (o + 16 > to || u32(b, o + 8) !== 0) return;
      size = u32(b, o + 12);
      body = o + 16;
    } else if (size === 0) {
      size = to - o;
    }
    if (size < body - o || o + size > to) return;
    yield { type: str(b, o + 4, 4), start: o, end: o + size, body };
    o += size;
  }
}

/** The first child of `box` with this type, or null. */
function child(b: Uint8Array, box: Box, type: string, full = false): Box | null {
  for (const it of boxes(b, box.body + (full ? 4 : 0), box.end)) if (it.type === type) return it;
  return null;
}

/**
 * Everything needed to decode, or null. Reads the meta box once and asks four
 * questions of it: which item is the picture, where its bytes are, how it is
 * configured, and - when it is a grid - which tiles make it up.
 *
 * Exported for tests: this is the half of the module that runs with no decoder
 * and no canvas, and the half a malformed file reaches first.
 */
export function readPlan(b: Uint8Array): Plan | null {
  if (!isHeif(b.subarray(0, 64))) return null;

  let meta: Box | null = null;
  for (const box of boxes(b, 0, b.length)) if (box.type === 'meta') { meta = box; break; }
  if (!meta) return null;
  // meta is a FullBox: its children start four bytes past the header.
  const kids = meta.body + 4;

  const items = new Map<number, Item>();
  let idat: Box | null = null;
  let primary = 0;
  let ipco: Box | null = null;
  const refs = new Map<number, number[]>();   // dimg: derived item -> its inputs

  for (const box of boxes(b, kids, meta.end)) {
    if (box.type === 'pitm') primary = u8(b, box.body) === 0 ? u16(b, box.body + 4) : u32(b, box.body + 4);
    else if (box.type === 'iinf') readIinf(b, box, items);
    else if (box.type === 'iloc') readIloc(b, box, items);
    else if (box.type === 'iref') readIref(b, box, refs);
    else if (box.type === 'idat') idat = box;
    else if (box.type === 'iprp') {
      ipco = child(b, box, 'ipco');
      const ipma = child(b, box, 'ipma');
      if (ipma) readIpma(b, ipma, items);
    }
  }
  if (!ipco) return null;
  // ipco holds its properties in order and ipma names them by one-based index,
  // so the list is taken once and indexed rather than walked per lookup.
  const table = [...boxes(b, ipco.body, ipco.end)];

  // No pitm (legal only in a few old writers): take the first item that could
  // be a picture, which is what every other reader does with such a file.
  if (!items.has(primary)) {
    primary = 0;
    for (const [id, it] of items) if (it.type === 'hvc1' || it.type === 'grid') { primary = id; break; }
  }
  const root = items.get(primary);
  if (!root) return null;

  const props = (it: Item, type: string): Box | null => {
    for (const i of it.props) {
      const box = i >= 1 && i <= table.length ? table[i - 1] : null;
      if (box?.type === type) return box;
    }
    return null;
  };

  if (root.type === 'hvc1') {
    const cfg = props(root, 'hvcC');
    const data = payload(b, root, idat);
    if (!cfg || !data) return null;
    const box = props(root, 'ispe');
    return {
      hvcC: b.subarray(cfg.body, cfg.end),
      tiles: [data], cols: 1, rows: 1,
      width: box ? u32(b, box.body + 4) : 0,
      height: box ? u32(b, box.body + 8) : 0,
      ...transform(b, root, props),
    };
  }

  if (root.type !== 'grid') return null;

  // A grid is a descriptor plus a dimg reference naming its cells in raster
  // order. The cells carry the hvcC; the grid item itself has none.
  const desc = payload(b, root, idat);
  const big = !!desc && (u8(desc, 1) & 1) === 1;
  if (!desc || desc.length < (big ? 12 : 8)) return null;
  const cols = u8(desc, 3) + 1;
  const rows = u8(desc, 2) + 1;
  const width = big ? u32(desc, 4) : u16(desc, 4);
  const height = big ? u32(desc, 8) : u16(desc, 6);
  if (cols * rows > MAX_TILES) return null;

  const cells = refs.get(primary) || [];
  if (cells.length !== cols * rows) return null;

  let hvcC: Uint8Array | null = null;
  const tiles: Uint8Array[] = [];
  for (const id of cells) {
    const tile = items.get(id);
    if (!tile || tile.type !== 'hvc1') return null;
    const data = payload(b, tile, idat);
    if (!data) return null;
    if (!hvcC) {
      const cfg = props(tile, 'hvcC');
      if (!cfg) return null;
      hvcC = b.subarray(cfg.body, cfg.end);
    }
    tiles.push(data);
  }
  if (!hvcC) return null;
  return { hvcC, tiles, cols, rows, width, height, ...transform(b, root, props) };
}

/** The irot / imir pair, read off whichever item carries them. */
function transform(
  b: Uint8Array, it: Item, props: (it: Item, type: string) => Box | null,
): { rotate: number, mirror: 'none' | 'x' | 'y' } {
  const rot = props(it, 'irot');
  const mir = props(it, 'imir');
  return {
    rotate: rot ? u8(b, rot.body) & 3 : 0,
    // axis 0 mirrors about a horizontal axis (top over bottom), 1 about a
    // vertical one. Taken from libheif rather than the 2017 text, which the
    // 2021 corrigendum reversed and which writers follow inconsistently.
    mirror: mir ? ((u8(b, mir.body) & 1) === 0 ? 'y' : 'x') : 'none',
  };
}

/**
 * An item's stored bytes, gathered across its extents, or null.
 *
 * Every extent is turned into an absolute range and checked against the pool it
 * names before a single byte is copied - an item pointing into an idat box that
 * is not there, or past the end of either pool, is an item this has none of.
 */
function payload(b: Uint8Array, it: Item, idat: Box | null): Uint8Array | null {
  if (!it.extents.length) return null;
  const ranges: { at: number, len: number }[] = [];
  let total = 0;
  for (const e of it.extents) {
    const base = e.idat ? idat?.body : 0;
    const limit = e.idat ? idat?.end : b.length;
    if (base === undefined || limit === undefined) return null;
    if (e.off < 0 || e.len <= 0 || base + e.off + e.len > limit) return null;
    total += e.len;
    if (total > MAX_ITEM_BYTES) return null;
    ranges.push({ at: base + e.off, len: e.len });
  }
  // The common case is one extent, which needs no copy at all.
  const [only] = ranges;
  if (ranges.length === 1) return b.subarray(only.at, only.at + only.len);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const r of ranges) {
    out.set(b.subarray(r.at, r.at + r.len), cursor);
    cursor += r.len;
  }
  return out;
}

/** iinf / infe: the type of every item, by id. */
function readIinf(b: Uint8Array, box: Box, items: Map<number, Item>) {
  const v = u8(b, box.body);
  const at = box.body + 4;
  const count = v === 0 ? u16(b, at) : u32(b, at);
  if (count > MAX_ITEMS) return;
  let seen = 0;
  for (const infe of boxes(b, at + (v === 0 ? 2 : 4), box.end)) {
    if (infe.type !== 'infe' || ++seen > count) break;
    const ver = u8(b, infe.body);
    // Versions 0 and 1 predate item_type and carry no picture this can use.
    if (ver < 2) continue;
    const id = ver === 2 ? u16(b, infe.body + 4) : u32(b, infe.body + 4);
    const type = str(b, infe.body + (ver === 2 ? 8 : 10), 4);
    const was = items.get(id);
    if (was) was.type = type;
    else items.set(id, { type, extents: [], props: [] });
  }
}

/** iloc: where every item's bytes are. The one box in here with real arithmetic. */
function readIloc(b: Uint8Array, box: Box, items: Map<number, Item>) {
  const v = u8(b, box.body);
  if (v > 2) return;
  let p = box.body + 4;
  const sizes = u8(b, p);
  const more = u8(b, p + 1);
  const offSize = sizes >> 4, lenSize = sizes & 15;
  const baseSize = more >> 4, idxSize = v === 0 ? 0 : (more & 15);
  p += 2;
  const count = v < 2 ? u16(b, p) : u32(b, p);
  p += v < 2 ? 2 : 4;
  if (count > MAX_ITEMS) return;

  // Only the four widths the format defines; anything else is a broken header.
  const read = (at: number, n: number): number | null =>
    n === 0 ? 0 : n === 4 ? u32(b, at) : n === 8 ? (u32(b, at) === 0 ? u32(b, at + 4) : null)
      : n === 2 ? u16(b, at) : n === 1 ? u8(b, at) : null;
  if ([offSize, lenSize, baseSize, idxSize].some(n => ![0, 1, 2, 4, 8].includes(n))) return;

  for (let i = 0; i < count; i++) {
    if (p >= box.end) return;
    const id = v < 2 ? u16(b, p) : u32(b, p);
    p += v < 2 ? 2 : 4;
    let method = 0;
    if (v === 1 || v === 2) { method = u16(b, p) & 15; p += 2; }
    p += 2;                                   // data_reference_index
    const base = read(p, baseSize);
    p += baseSize;
    if (base === null) return;
    const extents = u16(b, p);
    p += 2;
    if (extents > MAX_EXTENTS) return;
    // Method 2 points into another item, which nothing in the wild writes for
    // a still. Its extents are read past rather than guessed at.
    const it = items.get(id) || { type: '', extents: [], props: [] };
    for (let e = 0; e < extents; e++) {
      p += idxSize;
      const off = read(p, offSize);
      p += offSize;
      const len = read(p, lenSize);
      p += lenSize;
      if (off === null || len === null) return;
      if (method === 0 || method === 1) it.extents.push({ off: base + off, len, idat: method === 1 });
    }
    items.set(id, it);
  }
}

/** ipma: which ipco properties belong to which item. */
function readIpma(b: Uint8Array, box: Box, items: Map<number, Item>) {
  const v = u8(b, box.body);
  const wide = (u32(b, box.body) & 1) === 1;   // flags & 1: 15-bit property indices
  let p = box.body + 4;
  const count = u32(b, p);
  p += 4;
  if (count > MAX_ITEMS) return;
  for (let i = 0; i < count; i++) {
    if (p >= box.end) return;
    const id = v < 1 ? u16(b, p) : u32(b, p);
    p += v < 1 ? 2 : 4;
    const n = u8(b, p);
    p += 1;
    const it = items.get(id) || { type: '', extents: [], props: [] };
    for (let k = 0; k < n; k++) {
      it.props.push(wide ? (u16(b, p) & 0x7fff) : (u8(b, p) & 0x7f));
      p += wide ? 2 : 1;
    }
    items.set(id, it);
  }
}

/** iref: the dimg links alone - a grid's cells, in the order it wants them. */
function readIref(b: Uint8Array, box: Box, refs: Map<number, number[]>) {
  const v = u8(b, box.body);
  const wide = v !== 0;
  for (const ref of boxes(b, box.body + 4, box.end)) {
    if (ref.type !== 'dimg') continue;
    let p = ref.body;
    const from = wide ? u32(b, p) : u16(b, p);
    p += wide ? 4 : 2;
    const n = u16(b, p);
    p += 2;
    if (n > MAX_TILES) continue;
    const to: number[] = [];
    for (let i = 0; i < n; i++) { to.push(wide ? u32(b, p) : u16(b, p)); p += wide ? 4 : 2; }
    refs.set(from, to);
  }
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * The RFC 6381 name of what this hvcC configures. WebCodecs is handed the
 * record itself as `description`, so the string only has to agree with it -
 * but Chrome checks that it does, which is why it is built rather than
 * guessed. The one surprising line is the compatibility word, which prints
 * bit-reversed.
 *
 * Exported for tests: get this wrong and every HEIC is refused by a decoder
 * that could have drawn it, with nothing anywhere to say why.
 */
export function codecName(hvcC: Uint8Array): string {
  const space = (u8(hvcC, 1) >> 6) & 3;
  const tier = (u8(hvcC, 1) >> 5) & 1;
  const profile = u8(hvcC, 1) & 31;
  let compat = 0;
  const flags = u32(hvcC, 2);
  for (let i = 0; i < 32; i++) compat = (compat * 2) + ((flags >>> i) & 1);
  const parts = [
    'hvc1',
    (space ? String.fromCharCode(64 + space) : '') + profile,
    (compat >>> 0).toString(16),
    (tier ? 'H' : 'L') + u8(hvcC, 12),
  ];
  const cons = [];
  for (let i = 6; i <= 11; i++) cons.push(u8(hvcC, i));
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  for (const c of cons) parts.push(c.toString(16).padStart(2, '0'));
  return parts.join('.');
}

/**
 * Every tile decoded and composed, written as a JPEG.
 *
 * One decoder for the whole grid: the cells share a configuration and each is
 * an IDR of its own, so they go in as one sequence. Each frame is drawn and
 * closed inside the callback rather than collected, because a decoder backed by
 * hardware owns a small pool of frames and stops producing while they are held
 * - forty-eight tiles queued and kept stalls at eighteen and never finishes.
 * The cell is taken from the timestamp, so a decoder that reorders is fine.
 */
async function draw(plan: Plan): Promise<Blob | null> {
  const config: VideoDecoderConfig = {
    codec: codecName(plan.hvcC),
    description: plan.hvcC,
    optimizeForLatency: true,
  };
  const support = await VideoDecoder.isConfigSupported(config).catch(() => null);
  if (!support?.supported) return null;

  // One record rather than four `let`s: the callback below writes them and the
  // code after the flush reads them, and tsc will not carry a narrowing across
  // that seam for a variable a closure assigns.
  const sheet: { laid: Sheet | null, drawn: number, failed: boolean } =
    { laid: null, drawn: 0, failed: false };

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        sheet.laid ??= layout(plan, frame);
        const { laid } = sheet;
        if (!laid) { sheet.failed = true; return; }
        const at = frame.timestamp;
        if (at < 0 || at >= plan.tiles.length) return;
        const col = at % plan.cols;
        const row = (at - col) / plan.cols;
        const { face, scale, cell } = laid;
        // Float positions on purpose - rounding each cell on its own opens
        // hairline seams between them once the grid is scaled down.
        face.ctx.drawImage(frame, col * cell.w * scale, row * cell.h * scale,
          cell.w * scale, cell.h * scale);
        sheet.drawn++;
      } finally {
        frame.close();
      }
    },
    error: () => { sheet.failed = true; },
  });

  try {
    decoder.configure(config);
    for (let i = 0; i < plan.tiles.length; i++) {
      decoder.decode(new EncodedVideoChunk({
        type: 'key', timestamp: i, duration: 1, data: plan.tiles[i],
      }));
    }
    await decoder.flush();
    // A part-drawn grid is a picture with holes in it, which is worse than the
    // named card the caller falls back to.
    if (sheet.failed || !sheet.laid || sheet.drawn !== plan.tiles.length) return null;
    const { face } = sheet.laid;
    face.ctx.restore();
    const blob = await surfaceToBlob(face, 'image/jpeg', QUALITY);
    return blob?.size ? blob : null;
  } catch {
    return null;
  } finally {
    // close() on an errored decoder throws; it is going away regardless.
    try { decoder.close(); } catch { /* already gone */ }
  }
}

/** The canvas every tile is drawn on, and the arithmetic that places them. */
type Sheet = { face: Surface, scale: number, cell: { w: number, h: number } };

/**
 * The canvas the tiles are drawn on, sized and turned once the first frame has
 * said how big a cell really is. The transform is left applied - draw()
 * restores it before encoding.
 */
function layout(plan: Plan, frame: VideoFrame): Sheet | null {
  const w0 = frame.displayWidth || frame.codedWidth;
  const h0 = frame.displayHeight || frame.codedHeight;
  if (!(w0 > 0 && h0 > 0)) return null;

  // The grid's own size when it is believable, the cells' otherwise: a grid is
  // cropped to `width` x `height` out of a whole number of cells, so the two
  // differ by less than one cell and a descriptor that says otherwise is wrong.
  const spanW = w0 * plan.cols;
  const spanH = h0 * plan.rows;
  const full = plan.width > 0 && plan.width <= spanW && plan.height > 0 && plan.height <= spanH
    ? { w: plan.width, h: plan.height } : { w: spanW, h: spanH };

  const scale = Math.min(1, Math.sqrt(CANVAS_PIXELS / (full.w * full.h)));
  const w = Math.max(1, Math.round(full.w * scale));
  const h = Math.max(1, Math.round(full.h * scale));
  // A quarter turn swaps the page.
  const turned = plan.rotate % 2 === 1;
  const face = surface(turned ? h : w, turned ? w : h, { alpha: false });
  if (!face) return null;

  const { ctx } = face;
  ctx.save();
  // Mirror first, then rotate: the order the two properties are defined to
  // apply in, and the order a reader that swaps them flips about the wrong
  // diagonal in.
  ctx.translate(turned ? h / 2 : w / 2, turned ? w / 2 : h / 2);
  ctx.rotate(-plan.rotate * Math.PI / 2);
  if (plan.mirror !== 'none') ctx.scale(plan.mirror === 'x' ? -1 : 1, plan.mirror === 'y' ? -1 : 1);
  ctx.translate(-w / 2, -h / 2);
  return { face, scale, cell: { w: w0, h: h0 } };
}
