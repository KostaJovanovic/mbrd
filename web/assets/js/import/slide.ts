// A deck's first slide, composited into the picture its card draws.
//
// Every other document family in import/document.js is read the same cheap way:
// the application that wrote the file already rendered a thumbnail into it, and
// finding one is a container read and no renderer at all. PowerPoint is the
// family where that answer stopped being true. `docProps/thumbnail.jpeg` is
// optional, current PowerPoint does not write it unless somebody turns "save
// thumbnail" on, and the exporters most decks actually come from - Google
// Slides, Keynote, LibreOffice, python-pptx - never write one. So the single
// well was dry for essentially every real file, and a deck was a grey card with
// "pptx" on it whatever was inside.
//
// This is the other way of answering, and it is the expensive one: read the
// slide, lay it out, and draw it. It is worth the code because of what a
// moodboard is - a deck on a board is there to be *looked* at next to the other
// things, and a grey rectangle with an extension on it is the one card that
// carries no information at all.
//
// ── What this is and is not ──
//
// It is not a PowerPoint renderer and must not grow into one. DrawingML is a
// vector language with theme inheritance, autoshape geometry, gradients,
// effects, tables, charts and SmartArt in it, and a real implementation of that
// is a library the size of pdf.js. What is here is the part that makes a slide
// recognisable at card size, which is a much smaller thing:
//
//   - the pictures, at their real positions and sizes
//   - the text, at its real position, size and colour
//   - the background fill
//
// Everything else is skipped rather than approximated. An autoshape draws its
// text and not its shape; a chart, a table and a piece of SmartArt draw nothing.
// The test is whether somebody who made the deck recognises the slide at 300
// pixels wide, not whether the result would survive being opened full size.
//
// Where it cannot answer it returns null and the card is the grey one it was, so
// the whole of this is an upgrade over a known-bad state rather than something
// the importer depends on.
//
// ── Two coordinate systems, and the one that surprises people ──
//
// Everything in a slide is in EMU - English Metric Units, 914400 to the inch,
// 12700 to the point - which is an integer grid fine enough that no rounding in
// the format is ever visible. Font sizes are the exception and are in hundredths
// of a point, which is a different unit in the same file. Both are converted
// once, at the edges of draw(), and nothing downstream of that thinks in EMU.
//
// ── Where the geometry comes from when the shape does not have it ──
//
// A placeholder - a title, a body, a slide number - usually carries no `a:xfrm`
// of its own, because its position belongs to the layout it was placed from.
// That is not an edge case, it is how nearly every text shape on a real slide is
// written, so a reading that skips shapes without geometry draws the pictures
// and none of the words. One level of lookup into ppt/slideLayouts/ answers it,
// matched on the placeholder's index and then its type, and a shape that misses
// in both is the one that is genuinely skipped.

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

/**
 * The default slide box, when presentation.xml does not say.
 *
 * 13.333 x 7.5 inches - the 16:9 default every version since 2013 writes. The
 * older 4:3 default is 9144000 x 6858000, and guessing wrong there costs a
 * letterboxed card rather than a wrong one, so the modern shape is the guess.
 */
const DEFAULT_CX = 12192000;
const DEFAULT_CY = 6858000;

/** Long edge of the raster, in pixels. The same ceiling import/pdf.ts uses. */
const TARGET = 1600;

/**
 * Caps, each on a thing a hostile or merely enormous deck can have a lot of.
 *
 * Shapes because a generated deck can carry thousands on one slide and each is a
 * tree walk; images because each is a full decode held at once; characters
 * because fillText on a megabyte of text in one run is a frame that never ends.
 */
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

/**
 * The first slide of `file` as `{ blob, w, h }`, or null.
 *
 * Shaped exactly like firstPageRaster() in import/pdf.ts, and for the same
 * reason: prepareFile() treats both as "a picture of a document the app cannot
 * draw", stores it as meta.preview beside the untouched original, and retypes
 * the card to an image. The two are interchangeable at that call site and should
 * stay that way.
 */
export async function slideOneRaster(
  file: Blob,
  lift = false,
): Promise<{ blob: Blob, w: number, h: number } | null> {
  try {
    // Thrown, not returned - the same reasoning bakedPreview() gives at length.
    // A deck this size may well composite perfectly; what it will certainly do is
    // cost 96 MB of somebody else's memory to find out, and that is theirs to
    // spend. Declined, the deck is the grey card it was before this module existed.
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
    // A ceiling goes past, for the caller to ask about. See bakedPreview().
    if (isOversize(err)) throw err;
    // Same reasoning as import/pdf.ts's: the card is unchanged either way, but
    // "this deck has nothing this can draw" and "the archive would not read" are
    // different faults and only the console can tell them apart.
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

/**
 * The slide box in EMU, from the presentation part.
 *
 * Read from ppt/presentation.xml rather than assumed, because the two common
 * shapes are a full 16:9 against 4:3 and a deck drawn at the wrong one is
 * stretched rather than letterboxed - the scale below is not uniform if the box
 * is wrong.
 */
function slideBox(entries: Entries): { cx: number, cy: number } {
  const doc = xmlPart(entries, 'ppt/presentation.xml');
  const sz = doc && byLocal(doc, 'sldSz')[0];
  const cx = Number(sz?.getAttribute('cx')) || DEFAULT_CX;
  const cy = Number(sz?.getAttribute('cy')) || DEFAULT_CY;
  return { cx, cy };
}

/**
 * The layout this slide was placed from, parsed, or null.
 *
 * Reached through the slide's own relationship table rather than by guessing at
 * slideLayout1.xml: the numbering does not follow the slides and a deck of
 * twenty slides may use three layouts in any order.
 */
function layoutOf(entries: Entries, rels: Rels): Document | null {
  for (const target of rels.values()) {
    if (!/slideLayout\d*\.xml$/.test(target)) continue;
    return xmlPart(entries, resolveFrom('ppt/slides/', target));
  }
  return null;
}

/**
 * The slide's own background colour, or null for "whatever the layout said".
 *
 * Only a flat `a:srgbClr` fill directly on the slide is read. A theme colour, a
 * gradient or a picture fill is left to the white default - each of those needs
 * the theme part and its colour map, which is the beginning of the renderer this
 * module is written not to become, and white behind dark text is never the wrong
 * way round.
 */
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

/**
 * Every picture and every block of text on the slide, in the order they are
 * drawn in.
 *
 * Document order is z-order in this format - later shapes sit on top - so the
 * list is built by walking and never sorted. Groups are recursed into with their
 * transform applied; everything else is taken as it is.
 */
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

/**
 * A group's child-space to parent-space transform.
 *
 * A group states two rectangles: where it sits in its parent (`a:off`/`a:ext`)
 * and what coordinate space its children were authored in (`a:chOff`/`a:chExt`).
 * Ignoring the second is the single most visible way to get a grouped slide
 * wrong - children are authored at their original absolute positions, so
 * without the mapping a group that was moved or scaled draws its contents where
 * they used to be.
 */
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

/**
 * A shape's own rectangle, or null when it does not state one.
 *
 * Taken from the `a:xfrm` under this shape's own `p:spPr`, not from the first
 * one anywhere beneath it: a picture's `a:blipFill` can carry a `a:srcRect` and
 * a shape's text body can carry transforms of its own, and reaching past the
 * shape properties picks up whichever came first in the file.
 */
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

/**
 * Where the layout puts this placeholder, keyed the way the format matches them.
 *
 * `idx` first and `type` second, which is the order PowerPoint itself resolves
 * in: two body placeholders on a two-column layout are told apart only by their
 * index, while a title carries a type and usually no index at all. A shape with
 * neither, or one whose layout has no matching placeholder, gets null and is
 * skipped - drawing it at a guessed position would be worse than leaving it out.
 */
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

/**
 * A text body as drawable lines.
 *
 * One set of run properties per paragraph, taken from its first run. A paragraph
 * that changes size or colour part way through therefore draws in the first
 * run's, which at card size is a difference nobody can see and saves carrying a
 * styled-run model through the whole of draw().
 */
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

/**
 * The pieces, on a canvas the shape of the slide.
 *
 * Opaque, because a slide is: there is a background under everything and no card
 * on the board wants to see through a deck to the paper. That also lets the
 * encode fall back to JPEG without a question about transparency, the same trade
 * canvas/poster.ts makes for a video frame.
 */
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
      // A picture the browser cannot decode - a WMF or an EMF, which decks do
      // carry - is skipped and the rest of the slide is still drawn. That is the
      // difference between a slide with a hole in it and no slide at all.
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

/**
 * A shape's paragraphs inside its rectangle, wrapped and clipped.
 *
 * Clipped rather than shrunk to fit: PowerPoint's autofit would reflow the text
 * at a smaller size, and guessing at that produces a slide whose type sizes are
 * all subtly wrong. Text that overflows its box is cut off at the box, which is
 * what it looks like in the deck when autofit is off - and at card size the
 * difference between the two is a line.
 */
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
    // Points to pixels through EMU, so the one conversion in this module is the
    // one at the top of draw() and this borrows it rather than inventing a
    // second scale factor.
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

/**
 * The slide as bytes. WebP where the engine writes it, JPEG where it does not.
 *
 * The pattern import/pdf.ts established and canvas/surface.ts documents: ask for
 * WebP and then read the type that came back, because an engine that cannot
 * write it substitutes rather than refuses. JPEG unconditionally on the retry
 * for the reason the canvas is opaque - there is no transparency here to
 * flatten.
 */
async function encode(face: Surface): Promise<Blob | null> {
  const webp = await surfaceToBlob(face, 'image/webp', 0.82);
  if (!webp) return null;
  if (webp.type.toLowerCase() === 'image/webp') return webp;
  const jpeg = await surfaceToBlob(face, 'image/jpeg', 0.82);
  return jpeg?.type.toLowerCase() === 'image/jpeg' ? jpeg : webp;
}
