// @ts-nocheck - TypeScript migration debt, not a judgement about this file.
//
// The tree was renamed from .js to .ts mechanically, which moved 104 modules in
// one step and annotated none of them. This module is carried unchecked so that
// npm run typecheck stays green and keeps meaning something, rather than going
// red and being ignored. Converting this module IS deleting this block and
// fixing what tsc then says - tests/ts-debt.test.js holds the count and lets it
// only fall.
// A picture of the whole board - the thing a moodboard is for and could not do.
//
// Until now the only thing that left mbrd was a .mbrd, a file only mbrd opens.
// A moodboard exists to be shown, so this paints the board onto a canvas and
// hands it out as a PNG, or wraps that in a one-page PDF for printing.
//
// It composites onto a canvas by hand rather than rasterising the live DOM. The
// obvious route - wrap the board's nodes in an <svg><foreignObject> and draw
// that - taints the canvas the moment the foreignObject holds an <img> in every
// engine that matters, and a tainted canvas cannot be read back out, so the
// export simply fails. Drawing each item straight onto the canvas keeps every
// source same-origin (the asset store's own object URLs) and the canvas clean.
//
// No dependency, in keeping with the rest of the app: the PNG is the platform's
// own toBlob, and the PDF is a few hundred bytes of structure written by hand
// around the canvas's JPEG - a DCTDecode image XObject on one page, which is the
// one PDF a hand can write correctly without a font stack or an interpreter.

import { readToken } from '../util.ts';
import { board } from '../state.ts';
import { itemBounds } from '../geometry.ts';
import { assetURL } from '../storage/assets.ts';
import { STICKER_SPRITE, STICKER_VIEWBOX } from '../stickers/catalogue.ts';

/**
 * The side of the box the sticker paths are drawn in, as a number.
 *
 * The canvas wants a scale factor and the DOM wants a viewBox string, so one of
 * the two has to be derived from the other rather than written twice - and the
 * string is the one the five renderers already share.
 */
const STICKER_GRID = +STICKER_VIEWBOX.split(' ')[2] || 256;

/** A frame of clear board around the outermost items, in world units. */
const MARGIN = 48;
/** The longest edge the output is allowed to reach, so a huge board still fits. */
const MAX_EDGE = 8000;

/** Everything on the board that is a thing rather than a hint to the person. */
const drawable = () => board.items.filter(i => i.type !== 'ghost');

function loadImage(url) {
  return new Promise(resolve => {
    if (!url) { resolve(null); return; }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Draw `img` covering the w x h box centred on the current origin, cropped. */
function drawCover(ctx, img, w, h) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale, sh = h / scale;
  const sx = (iw - sw) / 2, sy = (ih - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
}

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/** The pixel source an item draws from, or null - the same one the card uses. */
const pixelHash = it =>
  it.type === 'image' ? (it.meta?.preview || it.asset?.hash)
  : (it.meta?.cover || it.meta?.shot || null);

/**
 * The sprite's paths, by shape id, read once and kept.
 *
 * The least pleasant part of this file, and unavoidable. Everything else here
 * is a rectangle, a photograph or some text; a sticker is a vector outline, and
 * the only place its geometry exists is the sprite. Rasterising it the obvious
 * way - an <img> pointed at the SVG - would either taint the canvas or need the
 * whole file inlined as a data URI per sticker, so the paths are fetched once
 * as text and handed to Path2D, which is the platform's own way of drawing an
 * SVG path onto a canvas.
 *
 * A failure is silence rather than an error. The board thumbnail is a
 * convenience; a sticker missing from one is worth less than a snapshot that
 * refuses to be taken because the sprite was not in the cache.
 */
let shapePaths = null;
async function stickerPaths() {
  if (shapePaths) return shapePaths;
  shapePaths = new Map();
  try {
    const text = await (await fetch(STICKER_SPRITE)).text();
    for (const [, id, chunk] of text.matchAll(/<symbol id="([^"]+)"([\s\S]*?)<\/symbol>/g)) {
      // Every <path> in the symbol, not only the first: a duotone shape is a
      // body *and* the outline over it, and the two are painted differently.
      // The convention read here is the sprite's own, so a path that opts out
      // of the default paint there opts out here too - no fill attribute is the
      // paper, `fill="currentColor"` is the ink.
      const parts = [...chunk.matchAll(/<path([^>]*)\/>/g)].map(([, attrs]) => ({
        d: attrs.match(/\sd="([^"]+)"/)?.[1] || '',
        ink: /\sfill="currentColor"/.test(attrs),
        evenodd: attrs.includes('fill-rule="evenodd"'),
      })).filter(p => p.d);
      if (parts.length) shapePaths.set(id, parts);
    }
  } catch { /* offline, or the sprite is not cached: the stickers go unpainted */ }
  return shapePaths;
}

/**
 * One sticker, drawn the way items.css draws it: a paper body with the inked
 * outline over it.
 *
 * Fills only, and no stroke anywhere - the shapes are Phosphor's and it draws
 * even its outline weights as filled paths, where the line is a closed path
 * tracing the outline of a stroke. So this is two `fill()` calls in the order
 * the sprite lists them, which is the whole of the drawing.
 */
async function drawSticker(ctx, it, w, h) {
  const parts = (await stickerPaths()).get(it.meta?.shape);
  if (!parts) return;
  const tint = Math.trunc(+it.meta?.tint) || 1;
  const ink = readToken(`--sticker-${tint}`) || readToken('--sticker-1') || '#31261b';
  const body = readToken('--sticker-body') || readToken('--paper-card') || '#fdfdfa';
  ctx.save();
  ctx.translate(-w / 2, -h / 2);
  ctx.scale(w / STICKER_GRID, h / STICKER_GRID);
  for (const part of parts) {
    ctx.fillStyle = part.ink ? ink : body;
    ctx.fill(new Path2D(part.d), part.evenodd ? 'evenodd' : 'nonzero');
  }
  ctx.restore();
}

async function drawItem(ctx, it, w, h) {
  const ink = readToken('--ink') || '#222';
  const card = readToken('--paper-2') || '#e9e5db';

  // Before the picture branch and before the card face, because a sticker is
  // neither: it has no asset to draw and no edge to put a name on. A board
  // covered in stars would otherwise come out of here bare, or - worse - as a
  // wall of small grey cards each labelled "Star".
  if (it.type === 'sticker') return drawSticker(ctx, it, w, h);

  if (it.type === 'swatch') {
    ctx.fillStyle = it.meta?.hex || '#888';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    return;
  }

  const hash = pixelHash(it);
  const img = hash ? await loadImage(assetURL(hash)) : null;
  if (img) {
    roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.03);
    ctx.save();
    ctx.clip();
    drawCover(ctx, img, w, h);
    ctx.restore();
    return;
  }

  // No picture: a card face with its name, which covers notes, links, text,
  // audio without art, and any named file card.
  if (it.type === 'note') ctx.fillStyle = readToken(`--note-${(it.meta?.tint || 1)}`) || '#fff7d6';
  else ctx.fillStyle = card;
  roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.06);
  ctx.fill();

  const label = (it.name || '').slice(0, 120);
  if (!label) return;
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `500 ${Math.max(11, Math.min(w, h) * 0.11)}px system-ui, sans-serif`;
  // One wrapped block, clipped to the card so a long name never runs off it.
  ctx.save();
  roundRect(ctx, -w / 2, -h / 2, w, h, 0);
  ctx.clip();
  wrapText(ctx, label, w * 0.86, Math.max(12, Math.min(w, h) * 0.13));
  ctx.restore();
}

/** Centre a few wrapped lines of text on the origin. */
function wrapText(ctx, text, maxWidth, lineHeight) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const trial = line ? line + ' ' + word : word;
    if (ctx.measureText(trial).width > maxWidth && line) { lines.push(line); line = word; }
    else line = trial;
    if (lines.length >= 5) break;
  }
  if (line && lines.length < 6) lines.push(line);
  const top = -(lines.length - 1) * lineHeight / 2;
  lines.forEach((l, i) => ctx.fillText(l, 0, top + i * lineHeight));
}

/**
 * The whole board on a canvas, or null if there is nothing on it.
 *
 * World y points up and a canvas lays y down, so every item's top is measured
 * from the board's top edge. Items are drawn in z order, turned by their own
 * rotation, so a scrapbook board comes out tilted the way it looks.
 */
export async function renderBoardCanvas() {
  const items = drawable();
  const b = itemBounds(items);
  if (!b) return null;

  const worldW = (b.x1 - b.x0) + MARGIN * 2;
  const worldH = (b.y1 - b.y0) + MARGIN * 2;
  const scale = Math.min(1, MAX_EDGE / Math.max(worldW, worldH));
  const W = Math.max(1, Math.ceil(worldW * scale));
  const H = Math.max(1, Math.ceil(worldH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = readToken('--paper') || '#f4f1ea';
  ctx.fillRect(0, 0, W, H);

  const ordered = [...items].sort((p, q) => (p.z || 0) - (q.z || 0));
  for (const it of ordered) {
    const cx = ((it.x - b.x0) + MARGIN) * scale;
    const cy = ((b.y1 - it.y) + MARGIN) * scale;   // world y-up -> canvas y-down
    ctx.save();
    ctx.translate(cx, cy);
    if (it.rot) ctx.rotate(-it.rot * Math.PI / 180);
    await drawItem(ctx, it, it.w * scale, it.h * scale);
    ctx.restore();
  }
  return { canvas, w: W, h: H };
}

const toBlob = (canvas, type, quality) =>
  new Promise(resolve => canvas.toBlob(resolve, type, quality));

/** The board as a PNG blob, or null. */
export async function boardPng() {
  const shot = await renderBoardCanvas();
  return shot ? toBlob(shot.canvas, 'image/png') : null;
}

/**
 * A small thumbnail of the board as a data URL, or null - for the library
 * switcher's cards. Rendered the same way and then shrunk hard, so a shelf of
 * them is a page of data URLs rather than a page of full-size boards.
 */
export async function boardThumb(max = 360) {
  const shot = await renderBoardCanvas();
  if (!shot) return null;
  const scale = Math.min(1, max / Math.max(shot.w, shot.h));
  const tw = Math.max(1, Math.round(shot.w * scale));
  const th = Math.max(1, Math.round(shot.h * scale));
  const c = document.createElement('canvas');
  c.width = tw;
  c.height = th;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(shot.canvas, 0, 0, tw, th);
  try { return c.toDataURL('image/webp', 0.7); }
  catch { return null; }
}

/** The board as a one-page PDF blob, or null. */
export async function boardPdf() {
  const shot = await renderBoardCanvas();
  if (!shot) return null;
  const jpeg = await toBlob(shot.canvas, 'image/jpeg', 0.92);
  if (!jpeg) return null;
  return buildPdf(new Uint8Array(await jpeg.arrayBuffer()), shot.w, shot.h);
}

/**
 * A single-page PDF wrapping one JPEG, written by hand.
 *
 * Five objects - catalog, pages, page, the image, the one-line content stream
 * that stamps the image across the page - then a cross-reference table of where
 * each begins. The JPEG rides in verbatim under /DCTDecode, which is why the
 * canvas is encoded as JPEG for this path and not PNG: a PDF speaks JPEG
 * directly, where a PNG would have to be decoded and re-deflated. The page is
 * the image's own pixel size in points, so it prints at 72dpi and scales on the
 * page like any other picture.
 */
function buildPdf(jpeg, w, h) {
  const enc = new TextEncoder();
  const parts = [];
  let len = 0;
  const offsets = [];
  const push = data => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    parts.push(bytes);
    len += bytes.length;
  };
  const obj = (n, body) => {
    offsets[n] = len;
    push(`${n} 0 obj\n`);
    push(body);
    push('\nendobj\n');
  };

  // Header, with a high-byte comment so tools read the file as binary.
  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}]`
    + ` /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);

  offsets[4] = len;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h}`
    + ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`
    + ` /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push('\nendstream\nendobj\n');

  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

  const xrefAt = len;
  const count = 6;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(xref);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`);

  return new Blob(parts, { type: 'application/pdf' });
}
