// Draw page one of a Word file as the card's picture. Word bakes a thumbnail in
// only when "Save preview picture" is on, so most .docx files arrived as a grey
// card. This reads word/document.xml and sets the first page's text and inline
// pictures on a page of the document's own size. Not a layout engine: one face,
// the built-in styles' default looks, tables as rows of text, no headers or floats.

import { readZip } from '../storage/zip.ts';
import { surface, surfaceToPicture } from '../canvas/surface.ts';
import { MAX_CONTAINER, MAX_INFLATED } from './document.ts';
import { oversize, isOversize, mb } from '../consent.ts';
import {
  byLocal, childOf, relationships, resolveFrom, xmlPart,
  type Entries, type Rels,
} from './ooxml.ts';

/** The extensions this answers for. Every OOXML word-processing spelling. */
const WORD_EXTS = new Set(['docx', 'docm', 'dotx', 'dotm']);

/** Whether this file is a Word file this module will attempt. */
export const isWordDoc = (ext: string) => WORD_EXTS.has(ext);

/** Twips per point, and EMU per twip: the two units a Word file measures in. */
const TWIPS_PER_POINT = 20;
const EMU_PER_TWIP = 635;

/** A4 in twips with Word's one-inch margins: the page when a file states none. */
const DEFAULT_PAGE = { w: 11906, h: 16838, top: 1440, right: 1440, bottom: 1440, left: 1440 };

/** The largest page edge believed, in twips: 22 inches, past any paper size. */
const MAX_EDGE = 31680;

/** Long edge of the raster, in pixels. The ceiling import/slide.ts uses. */
const TARGET = 1600;

/** Caps. A first page holds far less than these, and a crafted file far more. */
const MAX_BLOCKS = 400;
const MAX_CHARS = 8000;
const MAX_IMAGES = 8;

/** Line height as a share of the type size. */
const LEADING = 1.2;

/** Word's default body face and its stand-ins, in the order a machine may have them. */
const FACE = 'Aptos, Calibri, Carlito, "Segoe UI", system-ui, sans-serif';

export type Page = typeof DEFAULT_PAGE;
export type Align = 'left' | 'center' | 'right';

/** One thing page one holds, in document order. Sizes in twips, type in points. */
export type Block =
  | { kind: 'text', text: string, size: number, bold: boolean, colour: string | null,
      align: Align, after: number, indent: number }
  | { kind: 'image', w: number, h: number, align: Align, bytes: Uint8Array<ArrayBuffer> | null };

/** One thing to draw, placed. Twips from the page's top left corner. */
export type Placed =
  | { kind: 'text', text: string, x: number, y: number, size: number, bold: boolean,
      colour: string | null }
  | { kind: 'image', x: number, y: number, w: number, h: number,
      bytes: Uint8Array<ArrayBuffer> | null };

/** The width of `text` set at `size` points, in twips. */
export type Measure = (text: string, size: number, bold: boolean) => number;

/** Page one as { blob, w, h }, or null. The shape import/slide.ts gives. */
export async function pageOneRaster(
  file: Blob,
  lift = false,
): Promise<{ blob: Blob, w: number, h: number } | null> {
  try {
    // Oversize = liftable ceiling, not a refusal.
    if (!lift && file.size > MAX_CONTAINER) {
      throw oversize(
        'container-bytes',
        `This document is ${mb(file.size)}, past the ${mb(MAX_CONTAINER)} one is opened at to draw its first page.`,
      );
    }
    const entries = await readZip(file, { entry: MAX_INFLATED, total: MAX_INFLATED, lift });
    const doc = xmlPart(entries, 'word/document.xml');
    const body = doc && byLocal(doc, 'body')[0];
    if (!doc || !body) return null;

    const rels = relationships(entries, 'word/_rels/document.xml.rels');
    const blocks = readBlocks(body, entries, rels);
    if (!blocks.some(b => b.kind === 'image' || b.text.trim())) return null;

    return await draw(blocks, pageOf(doc));
  } catch (err) {
    if (isOversize(err)) throw err;
    console.warn('[mbrd] page one: the first page did not draw', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/** A `w:` attribute. The prefix is the format's own spelling, and the parser keeps it. */
const wAttr = (el: Element | null | undefined, name: string): string | null =>
  el?.getAttribute('w:' + name) ?? null;

/** A `w:` attribute as a number, or null when it is absent or not one. */
function wNum(el: Element | null | undefined, name: string): number | null {
  const raw = wAttr(el, name);
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Page one's size and margins. Its section's properties are the first
 * `w:sectPr` in document order: a section break keeps them in the paragraph
 * that ends the section, and the body's own is the last section's. */
function pageOf(doc: Document): Page {
  const sect = byLocal(doc, 'sectPr')[0];
  const sz = sect && childOf(sect, 'pgSz');
  const mar = sect && childOf(sect, 'pgMar');
  return pageBox({
    w: wNum(sz, 'w'), h: wNum(sz, 'h'),
    top: wNum(mar, 'top'), right: wNum(mar, 'right'),
    bottom: wNum(mar, 'bottom'), left: wNum(mar, 'left'),
  });
}

/**
 * The page, from whatever the file states, each number checked. A missing or
 * absurd one takes A4's. A margin stays under a third of its edge, so a
 * crafted file cannot squeeze the text to nothing.
 */
export function pageBox(stated: { [K in keyof Page]?: number | null }): Page {
  const pick = (key: keyof Page, lo: number) => {
    const v = stated[key];
    return v != null && v >= lo && v <= MAX_EDGE ? v : DEFAULT_PAGE[key];
  };
  const w = pick('w', 1440);
  const h = pick('h', 1440);
  const side = (key: keyof Page) => Math.min(pick(key, 0), w / 3);
  const end = (key: keyof Page) => Math.min(pick(key, 0), h / 3);
  return { w, h, top: end('top'), right: side('right'), bottom: end('bottom'), left: side('left') };
}

// ---------------------------------------------------------------------------
// Reading the body
// ---------------------------------------------------------------------------

/** Paragraphs and tables in document order, as blocks. Tables read as rows. */
function readBlocks(body: Element, entries: Entries, rels: Rels): Block[] {
  const out: Block[] = [];
  let chars = 0;
  let images = 0;
  // Each text is cut to what is left of MAX_CHARS, so one enormous paragraph
  // is not handed whole to the wrap: the check between children cannot see
  // inside one.
  const cut = (text: string) => text.slice(0, Math.max(0, MAX_CHARS - chars));
  for (const node of body.children) {
    if (out.length >= MAX_BLOCKS || chars >= MAX_CHARS) break;
    if (node.localName === 'p') {
      for (const block of paragraph(node, entries, rels, images < MAX_IMAGES)) {
        if (block.kind === 'image') images++;
        else {
          block.text = cut(block.text);
          chars += block.text.length;
        }
        out.push(block);
      }
    } else if (node.localName === 'tbl') {
      for (const row of byLocal(node, 'tr')) {
        const cells = [...row.children]
          .filter(cell => cell.localName === 'tc')
          .map(cell => tidy(textOf(cell)))
          .filter(Boolean);
        if (!cells.length) continue;
        const text = cut(cells.join('   '));
        out.push({ kind: 'text', text, size: 10, bold: false, colour: null,
          align: 'left', after: 60, indent: 0 });
        chars += text.length;
        if (out.length >= MAX_BLOCKS || chars >= MAX_CHARS) break;
      }
    }
  }
  return out;
}

/** How Word's built-in styles look by default, by style id. The file's own
 * styles.xml can say otherwise and is not read: at card size what shows is
 * whether a line is a heading, not its exact size. */
function lookOf(style: string): { size: number, bold: boolean, colour: string | null, after: number } {
  if (style === 'Title') return { size: 28, bold: false, colour: null, after: 160 };
  if (style === 'Subtitle') return { size: 15, bold: false, colour: '#595959', after: 160 };
  const heading = /^Heading(\d)$/i.exec(style);
  if (heading) {
    const level = Number(heading[1]);
    return { size: level === 1 ? 16 : level === 2 ? 13 : 12, bold: true, colour: '#0f4761', after: 80 };
  }
  return { size: 11, bold: false, colour: null, after: 160 };
}

/** One paragraph: its inline pictures, then its text. An empty paragraph is
 * still a block, since Word gives it a line. */
function paragraph(p: Element, entries: Entries, rels: Rels, pictures: boolean): Block[] {
  const props = childOf(p, 'pPr');
  const style = wAttr(props && childOf(props, 'pStyle'), 'val') || '';
  const look = lookOf(style);
  // The first run's properties stand for the paragraph, as in import/slide.ts.
  const run = byLocal(p, 'rPr').find(r => r.parentElement?.localName === 'r');
  const sz = wNum(run && childOf(run, 'sz'), 'val');
  const b = run && childOf(run, 'b');
  const bold = b ? !['0', 'false'].includes(wAttr(b, 'val') || '') : look.bold;
  const hex = wAttr(run && childOf(run, 'color'), 'val') || '';
  const colour = /^[0-9a-f]{6}$/i.test(hex) ? '#' + hex : look.colour;
  const jc = wAttr(props && childOf(props, 'jc'), 'val');
  const align: Align = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : 'left';
  const after = wNum(props && childOf(props, 'spacing'), 'after');
  // A list item numbers itself in its own properties, or through a list style
  // whose numbering lives in styles.xml. Either way it wears a bullet here:
  // which number it would have is the one thing this cannot know.
  const listed = !!(props && childOf(props, 'numPr')) || /^List(Bullet|Number)\d*$/.test(style);

  const out: Block[] = [];
  if (pictures) {
    for (const drawing of byLocal(p, 'drawing')) {
      const extent = byLocal(drawing, 'extent')[0];
      const cx = Number(extent?.getAttribute('cx')) || 0;
      const cy = Number(extent?.getAttribute('cy')) || 0;
      if (cx <= 0 || cy <= 0) continue;
      const blip = byLocal(drawing, 'blip')[0];
      const id = blip?.getAttribute('r:embed') || blip?.getAttribute('embed');
      const target = id ? rels.get(id) : undefined;
      const bytes = target ? entries.get(resolveFrom('word/', target)) || null : null;
      out.push({ kind: 'image', w: cx / EMU_PER_TWIP, h: cy / EMU_PER_TWIP, align, bytes });
    }
  }
  const text = tidy(textOf(p));
  out.push({
    kind: 'text',
    text: listed && text ? '• ' + text : text,
    size: sz && sz > 0 ? sz / 2 : look.size,
    bold,
    colour,
    align,
    after: after != null && after >= 0 && after <= 1440 ? after : look.after,
    indent: listed ? 360 : 0,
  });
  return out;
}

/** The text under a node, in order. A run's tab or break reads as a space;
 * a tab under `w:tabs` is a tab stop, not text. */
function textOf(node: Element): string {
  let text = '';
  for (const el of node.getElementsByTagNameNS('*', '*')) {
    const name = el.localName;
    if (name === 't') text += el.textContent || '';
    else if (name === 'br' || name === 'cr') text += ' ';
    else if (name === 'tab' && el.parentElement?.localName === 'r') text += ' ';
  }
  return text;
}

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Setting it
// ---------------------------------------------------------------------------

/**
 * Set the blocks on page one, top to bottom, and stop at its foot. Pure: the
 * measure is handed in, so a test can set type without a canvas. A picture
 * wider than the text shrinks to it, and one that does not fit under the text
 * above it would start page two, so the page ends there.
 */
export function flow(blocks: Block[], page: Page, measure: Measure): Placed[] {
  const out: Placed[] = [];
  const left = page.left;
  const width = page.w - page.left - page.right;
  const bottom = page.h - page.bottom;
  let y = page.top;
  for (const block of blocks) {
    if (y >= bottom) break;
    if (block.kind === 'image') {
      const fit = Math.min(1, width / block.w);
      const w = block.w * fit;
      const h = block.h * fit;
      if (y + h > bottom && y > page.top) break;
      out.push({ kind: 'image', x: offset(block.align, left, width, w), y, w, h, bytes: block.bytes });
      y += h;
      continue;
    }
    const line = block.size * LEADING * TWIPS_PER_POINT;
    const inner = width - block.indent;
    // Only the rows the page has room for are wrapped: a paragraph of a
    // million words is forty lines of page, not a million measures.
    const room = Math.max(1, Math.floor((bottom - y) / line));
    const rows = block.text ? wrap(block.text, inner, t => measure(t, block.size, block.bold), room) : [''];
    for (const row of rows) {
      if (y + line > bottom) return out;
      if (row) {
        const x = offset(block.align, left + block.indent, inner, measure(row, block.size, block.bold));
        out.push({ kind: 'text', text: row, x, y, size: block.size, bold: block.bold, colour: block.colour });
      }
      y += line;
    }
    y += block.after;
  }
  return out;
}

/** Where a thing `w` wide starts in a measure `width` wide from `left`. */
function offset(align: Align, left: number, width: number, w: number): number {
  if (align === 'center') return left + (width - w) / 2;
  if (align === 'right') return left + width - w;
  return left;
}

/** A paragraph broken to fit `width`, on spaces, into at most `rows` lines.
 * A word longer than the line is left long. */
function wrap(text: string, width: number, measure: (text: string) => number, rows = Infinity): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (!word) continue;
    const next = line ? line + ' ' + word : word;
    if (line && measure(next) > width) {
      out.push(line);
      if (out.length >= rows) return out;
      line = word;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out;
}

/** Draw the page onto an opaque canvas, white like paper. */
async function draw(blocks: Block[], page: Page): Promise<{ blob: Blob, w: number, h: number } | null> {
  const scale = TARGET / Math.max(page.w, page.h);
  const w = Math.max(1, Math.round(page.w * scale));
  const h = Math.max(1, Math.round(page.h * scale));
  const face = surface(w, h, { alpha: false });
  if (!face) return null;
  const { ctx } = face;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = 'top';

  // Points to device pixels, through twips and draw()'s one scale factor.
  const font = (size: number, bold: boolean) =>
    `${bold ? 'bold ' : ''}${size * TWIPS_PER_POINT * scale}px ${FACE}`;
  const measure: Measure = (text, size, bold) => {
    ctx.font = font(size, bold);
    return ctx.measureText(text).width / scale;
  };

  for (const piece of flow(blocks, page, measure)) {
    if (piece.kind === 'image') {
      if (!piece.bytes) continue;
      // Undecodable pictures (WMF/EMF) are skipped: a hole beats no page.
      try {
        const bmp = await createImageBitmap(new Blob([piece.bytes]));
        ctx.drawImage(bmp, piece.x * scale, piece.y * scale, piece.w * scale, piece.h * scale);
        bmp.close?.();
      } catch { /* one picture short is still a page */ }
      continue;
    }
    ctx.font = font(piece.size, piece.bold);
    ctx.fillStyle = piece.colour || '#1a1a1a';
    ctx.fillText(piece.text, piece.x * scale, piece.y * scale);
  }

  const blob = await surfaceToPicture(face, 0.82);
  return blob ? { blob, w, h } : null;
}
