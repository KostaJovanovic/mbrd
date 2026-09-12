// Composite a deck's first slide into the card picture. Most exporters (Slides,
// Keynote, LibreOffice) omit docProps/thumbnail.jpeg, so this reads the slide
// XML and draws pictures + text + background fill at card size. Not a full
// DrawingML renderer — autoshapes render text only, charts/tables/SmartArt
// skipped. Coordinates in EMU (12700/pt); font sizes in hundredths of a point.
// Placeholders without geometry are resolved from the slide layout.

import { readZip } from '../storage/zip.ts';
import { surface, surfaceToBlob, type Surface } from '../canvas/surface.ts';
import { MAX_CONTAINER, MAX_INFLATED } from './document.ts';
import { oversize, isOversize, mb } from '../consent.ts';
import {
  byLocal, childOf, relationships, resolveFrom, slideNo, xmlPart,
  type Entries, type Rels,
} from './ooxml.ts';

/** The extensions this answers for. Every OOXML presentation spelling. */
const DECK_EXTS = new Set(['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm']);

/** English Metric Units to the point, and to the inch. The format's own grid. */
const EMU_PER_POINT = 12700;

/** Default 16:9 slide box (since 2013). Wrong guess = letterboxed, not broken. */
const DEFAULT_CX = 12192000;
const DEFAULT_CY = 6858000;

/** Long edge of the raster, in pixels. The same ceiling import/pdf.ts uses. */
const TARGET = 1600;

/** Per-slide caps — generated decks can have thousands of shapes. */
const MAX_SHAPES = 120;
const MAX_IMAGES = 16;
const MAX_CHARS = 4000;

/** Whether this file is a deck this module will attempt. */
export const isDeck = (ext: string) => DECK_EXTS.has(ext);

/** A rectangle in EMU, as the format gives it. */
type Frame = { x: number, y: number, w: number, h: number };

/** One thing to draw, already resolved out of the XML. */
type Piece =
  | { kind: 'image', at: Frame, bytes: Uint8Array<ArrayBuffer> }
  | { kind: 'text', at: Frame, lines: Line[] };

/** A paragraph, with the run properties of its first run standing for it. */
type Line = { text: string, size: number, bold: boolean, colour: string | null, align: string };

/** First slide as { blob, w, h }, or null. Same shape as pdf.ts's
 * firstPageRaster — prepareFile() treats both identically. */
export async function slideOneRaster(
  file: Blob,
  lift = false,
): Promise<{ blob: Blob, w: number, h: number } | null> {
  try {
    // Oversize = liftable ceiling, not a refusal.
    if (!lift && file.size > MAX_CONTAINER) {
      throw oversize(
        'container-bytes',
        `This deck is ${mb(file.size)}, past the ${mb(MAX_CONTAINER)} one is opened at to draw its first slide.`,
      );
    }
    const entries = await readZip(file, { entry: MAX_INFLATED, total: MAX_INFLATED, lift });

    const path = firstSlide(entries);
    if (!path) return null;
    const doc = xmlPart(entries, path);
    if (!doc) return null;

    const box = slideBox(entries);
    const rels = relationships(entries, relsFor(path));
    const pieces = collect(doc, entries, rels, layoutOf(entries, rels));
    if (!pieces.length) return null;

    return await draw(pieces, box, background(doc));
  } catch (err) {
    if (isOversize(err)) throw err;
    console.warn('[mbrd] slide: the first slide did not composite', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Finding the parts
// ---------------------------------------------------------------------------

/** The lowest-numbered slide part, or null for an archive with none. */
function firstSlide(entries: Entries): string | null {
  return [...entries.keys()]
    .filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => slideNo(a) - slideNo(b))[0] || null;
}

/** The _rels part beside a part - the format's own convention, spelled once. */
const relsFor = (path: string) => path.replace(/([^/]+)$/, '_rels/$1.rels');

/** Slide box in EMU from presentation.xml. Wrong ratio = non-uniform stretch. */
function slideBox(entries: Entries): { cx: number, cy: number } {
  const doc = xmlPart(entries, 'ppt/presentation.xml');
  const sz = doc && byLocal(doc, 'sldSz')[0];
  const cx = Number(sz?.getAttribute('cx')) || DEFAULT_CX;
  const cy = Number(sz?.getAttribute('cy')) || DEFAULT_CY;
  return { cx, cy };
}

/** Layout this slide references (via rels, not by guessing the number). */
function layoutOf(entries: Entries, rels: Rels): Document | null {
  for (const target of rels.values()) {
    if (!/slideLayout\d*\.xml$/.test(target)) continue;
    return xmlPart(entries, resolveFrom('ppt/slides/', target));
  }
  return null;
}

/** Slide background — only flat srgbClr. Theme/gradient/picture fills fall
 * back to white (reading the theme = beginning of a full renderer). */
function background(doc: Document): string | null {
  const bg = byLocal(doc, 'bg')[0];
  return bg ? srgbIn(bg) : null;
}

/** The first `a:srgbClr` under a node, as a CSS colour. */
function srgbIn(node: Element): string | null {
  const val = byLocal(node, 'srgbClr')[0]?.getAttribute('val');
  return /^[0-9a-f]{6}$/i.test(val || '') ? '#' + val : null;
}

// ---------------------------------------------------------------------------
// Reading the shape tree
// ---------------------------------------------------------------------------

/** Collect pictures and text in document order (= z-order). Groups recursed
 * with their transform applied. */
function collect(doc: Document, entries: Entries, rels: Rels, layout: Document | null): Piece[] {
  const tree = byLocal(doc, 'spTree')[0];
  if (!tree) return [];
  const out: Piece[] = [];
  const placeholders = layout ? layoutFrames(layout) : new Map<string, Frame>();
  walk(tree, identity, out, entries, rels, placeholders);
  return out;
}

/** A transform from a coordinate space to the slide's, as a pair of functions. */
type Mapping = (f: Frame) => Frame;

const identity: Mapping = f => f;

function walk(
  node: Element,
  map: Mapping,
  out: Piece[],
  entries: Entries,
  rels: Rels,
  placeholders: Map<string, Frame>,
) {
  for (const child of node.children) {
    if (out.length >= MAX_SHAPES) return;
    if (child.localName === 'grpSp') {
      walk(child, compose(map, groupMapping(child)), out, entries, rels, placeholders);
      continue;
    }
    if (child.localName === 'pic') {
      const at = frameOf(child) || placeholderFrame(child, placeholders);
      const bytes = at && pictureBytes(child, entries, rels);
      if (at && bytes) out.push({ kind: 'image', at: map(at), bytes });
      continue;
    }
    if (child.localName !== 'sp') continue;
    const body = childOf(child, 'txBody');
    if (!body) continue;
    const at = frameOf(child) || placeholderFrame(child, placeholders);
    if (!at) continue;
    const lines = paragraphs(body);
    if (lines.length) out.push({ kind: 'text', at: map(at), lines });
  }
}

const compose = (outer: Mapping, inner: Mapping): Mapping => f => outer(inner(f));

/** Group child→parent transform. chOff/chExt define the child coordinate space;
 * ignoring them draws group contents at their pre-move positions. */
function groupMapping(group: Element): Mapping {
  const xfrm = byLocal(group, 'xfrm')[0];
  const off = xfrm && childOf(xfrm, 'off');
  const ext = xfrm && childOf(xfrm, 'ext');
  const chOff = xfrm && childOf(xfrm, 'chOff');
  const chExt = xfrm && childOf(xfrm, 'chExt');
  if (!off || !ext || !chOff || !chExt) return identity;

  const x = num(off, 'x');
  const y = num(off, 'y');
  const cx = num(ext, 'cx');
  const cy = num(ext, 'cy');
  const cxo = num(chOff, 'x');
  const cyo = num(chOff, 'y');
  const cxe = num(chExt, 'cx');
  const cye = num(chExt, 'cy');
  if (!cxe || !cye) return identity;

  const sx = cx / cxe;
  const sy = cy / cye;
  return f => ({
    x: x + (f.x - cxo) * sx,
    y: y + (f.y - cyo) * sy,
    w: f.w * sx,
    h: f.h * sy,
  });
}

const num = (el: Element, attr: string) => Number(el.getAttribute(attr)) || 0;

/** Shape's own xfrm under spPr (not any nested xfrm — blipFill and txBody
 * can carry their own). */
function frameOf(shape: Element): Frame | null {
  const props = childOf(shape, 'spPr');
  const xfrm = props && childOf(props, 'xfrm');
  const off = xfrm && childOf(xfrm, 'off');
  const ext = xfrm && childOf(xfrm, 'ext');
  if (!off || !ext) return null;
  const w = num(ext, 'cx');
  const h = num(ext, 'cy');
  if (w <= 0 || h <= 0) return null;
  return { x: num(off, 'x'), y: num(off, 'y'), w, h };
}

/** Placeholder frame from layout, resolved idx-first then type (matches
 * PowerPoint's own resolution order). */
function placeholderFrame(shape: Element, frames: Map<string, Frame>): Frame | null {
  const ph = byLocal(shape, 'ph')[0];
  if (!ph) return null;
  const idx = ph.getAttribute('idx');
  const type = ph.getAttribute('type');
  return (idx && frames.get('idx:' + idx))
    || (type && frames.get('type:' + type))
    || frames.get('type:body')
    || null;
}

/** Every placeholder rectangle a layout states, by index and by type. */
function layoutFrames(layout: Document): Map<string, Frame> {
  const out = new Map<string, Frame>();
  const tree = byLocal(layout, 'spTree')[0];
  if (!tree) return out;
  for (const sp of byLocal(tree, 'sp')) {
    const ph = byLocal(sp, 'ph')[0];
    const at = frameOf(sp);
    if (!ph || !at) continue;
    const idx = ph.getAttribute('idx');
    const type = ph.getAttribute('type');
    if (idx && !out.has('idx:' + idx)) out.set('idx:' + idx, at);
    if (type && !out.has('type:' + type)) out.set('type:' + type, at);
  }
  return out;
}

/** The bytes behind a `p:pic`, through its relationship id. */
function pictureBytes(pic: Element, entries: Entries, rels: Rels) {
  const blip = byLocal(pic, 'blip')[0];
  const id = blip?.getAttribute('r:embed') || blip?.getAttribute('embed');
  const target = id && rels.get(id);
  if (!target) return null;
  return entries.get(resolveFrom('ppt/slides/', target)) || null;
}

/** Paragraphs from a text body. First run's properties stand for the whole
 * paragraph — at card size the difference is invisible. */
function paragraphs(body: Element): Line[] {
  const out: Line[] = [];
  let chars = 0;
  for (const p of byLocal(body, 'p')) {
    const text = byLocal(p, 't').map(t => t.textContent || '').join('');
    if (!text.trim()) continue;
    const run = byLocal(p, 'rPr')[0];
    const size = Number(run?.getAttribute('sz')) || 1800;
    out.push({
      text,
      size: size / 100,
      bold: run?.getAttribute('b') === '1',
      colour: run ? srgbIn(run) : null,
      align: childOf(p, 'pPr')?.getAttribute('algn') || 'l',
    });
    chars += text.length;
    if (chars > MAX_CHARS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drawing it
// ---------------------------------------------------------------------------

/** Draw pieces onto an opaque canvas (no alpha — JPEG fallback is safe). */
async function draw(
  pieces: Piece[],
  box: { cx: number, cy: number },
  bg: string | null,
): Promise<{ blob: Blob, w: number, h: number } | null> {
  const scale = TARGET / Math.max(box.cx, box.cy, 1);
  const w = Math.max(1, Math.round(box.cx * scale));
  const h = Math.max(1, Math.round(box.cy * scale));
  const face = surface(w, h, { alpha: false });
  if (!face) return null;
  const { ctx } = face;

  ctx.fillStyle = bg || '#ffffff';
  ctx.fillRect(0, 0, w, h);

  // EMU to device pixels. Every number below this line is in pixels.
  const px = (v: number) => v * scale;
  let images = 0;

  for (const piece of pieces) {
    const x = px(piece.at.x);
    const y = px(piece.at.y);
    const pw = px(piece.at.w);
    const ph = px(piece.at.h);
    if (pw <= 0 || ph <= 0) continue;

    if (piece.kind === 'image') {
      if (images >= MAX_IMAGES) continue;
      images++;
      // Undecodable pictures (WMF/EMF) skipped — hole beats no slide.
      try {
        const bmp = await createImageBitmap(new Blob([piece.bytes]));
        ctx.drawImage(bmp, x, y, pw, ph);
        bmp.close?.();
      } catch { /* one picture short is still a slide */ }
      continue;
    }

    drawText(ctx, piece.lines, x, y, pw, ph, scale);
  }

  const blob = await encode(face);
  return blob ? { blob, w, h } : null;
}

/** Draw paragraphs clipped to their box. Clipped, not autofitted — guessing
 * the reflow produces subtly wrong type sizes at card scale. */
function drawText(
  ctx: Surface['ctx'],
  lines: Line[],
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.textBaseline = 'top';

  let cursor = y;
  for (const line of lines) {
    // Points → pixels via EMU, reusing draw()'s single scale factor.
    const size = Math.max(6, line.size * EMU_PER_POINT * scale);
    ctx.font = `${line.bold ? 'bold ' : ''}${size}px system-ui, sans-serif`;
    ctx.fillStyle = line.colour || '#1a1a1a';
    for (const piece of wrap(ctx, line.text, w)) {
      if (cursor > y + h) break;
      const at = line.align === 'ctr' ? x + (w - ctx.measureText(piece).width) / 2
        : line.align === 'r' ? x + w - ctx.measureText(piece).width
          : x;
      ctx.fillText(piece, at, cursor);
      cursor += size * 1.2;
    }
  }
  ctx.restore();
}

/** A line broken to fit `w`, on spaces. A word longer than the box is left long. */
function wrap(ctx: Surface['ctx'], text: string, w: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    const next = line ? line + ' ' + word : word;
    if (line && ctx.measureText(next).width > w) {
      out.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out;
}

/** Encode: WebP preferred, JPEG fallback (opaque canvas, no transparency). */
async function encode(face: Surface): Promise<Blob | null> {
  const webp = await surfaceToBlob(face, 'image/webp', 0.82);
  if (!webp) return null;
  if (webp.type.toLowerCase() === 'image/webp') return webp;
  const jpeg = await surfaceToBlob(face, 'image/jpeg', 0.82);
  return jpeg?.type.toLowerCase() === 'image/jpeg' ? jpeg : webp;
}
