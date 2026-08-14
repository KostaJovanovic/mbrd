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
//
// ── This is a second renderer, and it always will be ──
//
// Everything above means renderBoardCanvas() is a parallel implementation of
// canvas/renderers.ts and five stylesheets, kept in step by hand. There is no
// way out of that while the DOM route taints: what can be done is to reach for
// the *pure* halves of the real thing wherever they exist rather than restating
// them, and this file does - fitMode(), itemCrop(), adjustFilter(),
// routeConnection(), pathData(), connMeta(), boardGridStep(), flattenNoteRich()
// and paperMm() are all the board's own answers, asked here.
//
// Three things genuinely cannot be reused and are restated below: paintGrid(),
// paintGrain() and paintPaper() each paint *against the live viewport* into an
// on-screen layer. They take a camera; this has none.
//
// ── What the board surface means here ──
//
// The export covers the whole surface, not only the cards: the grid, the paper
// sheet, the connections, the fences and the grain. A moodboard's regions and
// the lines between its cards are as much the work as the photographs are, and
// an export that dropped them handed somebody a bag of pictures rather than the
// board they made.
//
// ── detail: 'full' | 'thumb' ──
//
// The same renderer feeds three callers, and one of them is not an export at
// all: boardThumb() runs on every open and every new board, for a card in the
// library shelf that is a couple of hundred pixels across. Grain, the lattice,
// the sheet, the connections, the shadows and every string of text are invisible
// at that size and cost real time, so the thumbnail asks for 'thumb' and the two
// exports ask for 'full'. It is one parameter rather than two renderers for the
// same reason there is one renderer at all: two would disagree.

import { readToken } from '../util.ts';
import { board, adjustFilter, itemCrop } from '../state.ts';
import { itemBounds } from '../geometry.ts';
import { assetURL, getAsset } from '../storage/assets.ts';
import { paperMm, toUnits } from '../measure.ts';
import { connMeta, pairKey } from '../board-model.ts';
import { CLEARANCE, routeConnection, pathData } from '../web-route.ts';
import type { RouteOpts } from '../web-route.ts';
import { boardGridStep } from '../canvas/grid.ts';
import { fitMode } from '../canvas/renderers.ts';
import { flattenNoteRich } from '../canvas/note-model.ts';
import type { NoteRichInput } from '../canvas/note-model.ts';
import { tiltOf } from '../canvas/items.ts';
import { describeExt } from '../import/formats.ts';
import { extOf, formatBytes } from '../util.ts';
import { STICKER_SPRITE, STICKER_VIEWBOX } from '../stickers/catalogue.ts';
import type { Item, ItemType } from '../board-model.ts';

/** Which of the two jobs a render is for - see the head of this file. */
export type Detail = 'full' | 'thumb';

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

function loadImage(url: string | null): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    if (!url) { resolve(null); return; }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function roundRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/**
 * The pixel source an item draws from, or null - the same one the card uses.
 *
 * The three meta keys are content hashes, held to that shape by makeItem() in
 * board-model.ts before they ever land on an item; the narrowing here is what
 * the open `meta` costs at the reading end.
 */
const hashAt = (meta: Item['meta'], key: string): string | null =>
  typeof meta?.[key] === 'string' ? meta[key] : null;
const pixelHash = (it: Item): string | null =>
  it.type === 'image' ? (hashAt(it.meta, 'preview') || it.asset?.hash || null)
  : (hashAt(it.meta, 'cover') || hashAt(it.meta, 'shot') || null);

const metaStr = (v: unknown): string => (typeof v === 'string' ? v : '');

// ---------------------------------------------------------------------------
// The look, resolved once per render
// ---------------------------------------------------------------------------

/**
 * The tokens and flags one render draws against, read once at the top of it.
 *
 * readToken() is a getComputedStyle, which is a style flush, and a board can
 * carry hundreds of cards. Reading `--ink` inside drawItem() was a flush per
 * card; this is one read per token per render, and it is also what makes the
 * whole render describable - every colour on the output is in this object.
 */
type Look = {
  detail: Detail;
  ink: string;
  ink3: string;
  paper: string;
  card: string;
  rule: string;
  display: string;
  body: string;
  /** The most a card leans, in degrees - see leanOf(). */
  lean: number;
  shadow: { color: string, blur: number, dy: number } | null;
  /** The lattice's two inks, and whether it is drawn as crosses. */
  grid: { minor: string, major: string, harsh: boolean } | null;
  /** The web's own stroke and base weight, in world units. */
  web: { line: string, weight: number } | null;
  grain: number;
};

/** A font stack out of a token, with a stack the canvas will certainly resolve. */
const fontOf = (name: string, fallback: string) =>
  readToken(name) || fallback;

/**
 * The card shadow, resolved through the browser rather than parsed as a token.
 *
 * `--shadow-1` is `0 1px 2px color-mix(in srgb, var(--ink) 14%, transparent)`,
 * and a custom property is handed back as the tokens it was written with -
 * getPropertyValue does not resolve the color-mix, and this file is not going to
 * grow a colour-space implementation to do it. So the value is put on a real
 * element as a real `box-shadow` and the *computed* style is read back, which
 * the engine has already resolved to `rgba(r, g, b, a) Xpx Ypx Bpx Spx`.
 *
 * Null at the two ends of the whimsy axis where the token is `none`, which is
 * the case a parser would have got wrong quietly.
 */
function readShadow(): Look['shadow'] {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px';
  probe.style.boxShadow = 'var(--shadow-1)';
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).boxShadow;
  probe.remove();
  if (!value || value === 'none') return null;
  const color = value.match(/(rgba?\([^)]*\))/)?.[1];
  const lengths = [...value.matchAll(/(-?[\d.]+)px/g)].map(m => +m[1]);
  if (!color || lengths.length < 3) return null;
  // offset-x, offset-y, blur, spread - the order the computed value always uses.
  return { color, dy: lengths[1] || 0, blur: lengths[2] || 0 };
}

/**
 * How far a card leans, in degrees, at this look.
 *
 * The same two-part answer canvas/web.ts works out and for the same reason: the
 * lean is `--item-tilt` (a per-card fraction, dealt from a bag and living only
 * on the node) times `--tilt-max`, and two things zero it outright rather than
 * zeroing the token - Harsh, in quality.css, and a snapped board, in items.css.
 * Reading only the token would lean every card on a board that draws none.
 */
function maxLean(): number {
  if (document.documentElement.dataset.whimsy === '2' || board.settings.snap) return 0;
  return Math.abs(parseFloat(readToken('--tilt-max'))) || 0;
}

function readLook(detail: Detail): Look {
  const full = detail === 'full';
  const grain = parseFloat(readToken('--grain'));
  return {
    detail,
    ink: readToken('--ink') || '#222',
    ink3: readToken('--ink-3') || '#8a8578',
    paper: readToken('--paper') || '#f4f1ea',
    card: readToken('--paper-2') || '#e9e5db',
    rule: readToken('--rule-2') || '#d8d3c6',
    display: fontOf('--font-display', 'system-ui, sans-serif'),
    body: fontOf('--font-body', 'system-ui, sans-serif'),
    lean: full ? maxLean() : 0,
    shadow: full ? readShadow() : null,
    grid: full && board.settings.grid ? {
      minor: readToken('--grid-minor') || 'rgba(0,0,0,0.08)',
      major: readToken('--grid-major') || 'rgba(0,0,0,0.14)',
      harsh: document.documentElement.dataset.whimsy === '2',
    } : null,
    web: full && board.settings.web ? {
      line: readToken('--web-line') || '#9a9384',
      weight: parseFloat(readToken('--web-weight')) || 2,
    } : null,
    grain: full && Number.isFinite(grain) ? grain : 0,
  };
}

/** Hang the card shadow on the context, or take it off again. */
function withShadow(ctx: CanvasRenderingContext2D, look: Look, on: boolean, scale: number) {
  if (!look.shadow) return;
  ctx.shadowColor = on ? look.shadow.color : 'transparent';
  ctx.shadowBlur = on ? look.shadow.blur * scale : 0;
  ctx.shadowOffsetY = on ? look.shadow.dy * scale : 0;
}

// ---------------------------------------------------------------------------
// Stickers
// ---------------------------------------------------------------------------

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
/** One filled path out of the sprite: its data, and how the sprite paints it. */
type ShapePart = { d: string, ink: boolean, evenodd: boolean };

let shapePaths: Map<string, ShapePart[]> | null = null;
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
async function drawSticker(ctx: CanvasRenderingContext2D, it: Item, w: number, h: number) {
  const shape = it.meta?.shape;
  // A shape that is not a string is not in the sprite either, so it takes the
  // same silent way out as one the sprite does not carry.
  if (typeof shape !== 'string') return;
  const parts = (await stickerPaths()).get(shape);
  if (!parts) return;
  const tint = Math.trunc(Number(it.meta?.tint)) || 1;
  const ink = readToken(`--sticker-${tint}`) || readToken('--sticker-1') || '#31261b';
  const bodyInk = readToken('--sticker-body') || readToken('--paper-card') || '#fdfdfa';
  ctx.save();
  ctx.translate(-w / 2, -h / 2);
  ctx.scale(w / STICKER_GRID, h / STICKER_GRID);
  for (const part of parts) {
    ctx.fillStyle = part.ink ? ink : bodyInk;
    ctx.fill(new Path2D(part.d), part.evenodd ? 'evenodd' : 'nonzero');
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// The items, one painter per kind
// ---------------------------------------------------------------------------

/**
 * What every painter is handed: the context, the item, its drawn size, and the
 * look. The origin is already the card's centre and the rotation is already
 * applied, which is what lets each of these be about the card alone.
 */
type Paint = {
  ctx: CanvasRenderingContext2D;
  it: Item;
  w: number;
  h: number;
  look: Look;
  /** World units to canvas pixels, for anything measured in the board's own units. */
  scale: number;
};

type Painter = (p: Paint) => void | Promise<void>;

/**
 * The painters, by item type - keyed the way RENDERERS is in
 * canvas/renderers.ts, and for the same reason.
 *
 * This was a run of `if (it.type === ...)` branches with the picture case and
 * the card-face case falling out of the bottom of it, which is exactly the
 * shape RENDERERS replaced on the real renderer years ago. A table says what
 * the list of kinds *is*, and a new kind is one entry rather than a branch
 * inserted at whichever point in a chain happens to work.
 *
 * `paintMedia` is the fallback rather than an entry, because it is not a kind:
 * it is "has pixels, or has a name" and it covers every card that is not one of
 * the four special shapes above.
 */
const PAINTERS: Partial<Record<ItemType, Painter>> = {
  sticker: p => drawSticker(p.ctx, p.it, p.w, p.h),
  swatch: paintSwatch,
  fence: paintFence,
  note: paintNote,
};

const painterFor = (it: Item): Painter => PAINTERS[it.type] || paintMedia;

function paintSwatch({ ctx, it, w, h }: Paint) {
  const hex = it.meta?.hex;
  ctx.fillStyle = (typeof hex === 'string' && hex) || '#888';
  ctx.fillRect(-w / 2, -h / 2, w, h);
}

/**
 * A region: a rounded rectangle with a *stroke* and its name along the foot.
 *
 * Its own painter because a fence has no face. It fell through to the named-card
 * branch before this, which drew it as a small grey card with "Kitchen" in the
 * middle of it - so a board organised into six labelled areas exported as six
 * grey boxes lying under the work they were supposed to be grouping.
 *
 * Stroked and not filled, which is the whole visual argument for a region: it is
 * a line drawn *round* things, and a filled one would put a wash over every card
 * inside it. The name goes on the bar across the bottom, which is where the real
 * one is - see bottomBar() in canvas/item-dom.ts, and the `.item-bar-always`
 * class it gives a fence for the same reason the bar is the only part of one
 * that can be pressed.
 */
function paintFence({ ctx, it, w, h, look, scale }: Paint) {
  const r = Math.min(24 * scale, Math.min(w, h) / 2);
  ctx.save();
  ctx.strokeStyle = look.rule;
  ctx.lineWidth = Math.max(1, 1.5 * scale);
  roundRect(ctx, -w / 2, -h / 2, w, h, r);
  ctx.stroke();

  const name = (it.name || '').slice(0, 80);
  if (name && look.detail === 'full') {
    const size = Math.max(11, Math.min(28 * scale, h * 0.08));
    const bar = size * 1.9;
    ctx.fillStyle = look.card;
    roundRect(ctx, -w / 2, h / 2 - bar, w, bar, r);
    ctx.fill();
    ctx.fillStyle = look.ink;
    ctx.font = `600 ${size}px ${look.display}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, -w / 2 + size, h / 2 - bar / 2, w - size * 2);
  }
  ctx.restore();
}

/**
 * A note: its paper, and its text as plain text.
 *
 * **The rich model is deliberately flattened rather than laid out.** A note's
 * `meta.rich` is blocks with their own tags, font, size, alignment and vertical
 * placement, and drawing that on a canvas would be a text engine - a second one,
 * disagreeing with the note on screen at the first styled note somebody made.
 * flattenNoteRich() is the board's own answer to "what does this note say", it
 * is what `meta.text` already holds, and it is what goes here.
 *
 * It was `it.name` before, which is the note's *first line* - so a six-line note
 * exported as its own heading and nothing else.
 */
function paintNote({ ctx, it, w, h, look, scale }: Paint) {
  ctx.fillStyle = readToken(`--note-${(Number(it.meta?.tint) || 1)}`) || '#fff7d6';
  roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.06);
  ctx.fill();
  if (look.detail !== 'full') return;

  const rich = it.meta?.rich;
  const text = (rich ? flattenNoteRich(rich as NoteRichInput) : metaStr(it.meta?.text)) || it.name || '';
  if (!text) return;
  const size = Math.max(9, Math.min(w, h) * 0.09);
  ctx.save();
  roundRect(ctx, -w / 2, -h / 2, w, h, 0);
  ctx.clip();
  ctx.fillStyle = look.ink;
  ctx.font = `400 ${size}px ${look.body}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const pad = Math.max(6 * scale, size * 0.7);
  wrapText(ctx, text.slice(0, 600), w - pad * 2, size * 1.35,
    { x: -w / 2 + pad, y: -h / 2 + pad, lines: Math.floor((h - pad * 2) / (size * 1.35)) });
  ctx.restore();
}

/**
 * Everything else: a picture if the card has one, a card face with its name and
 * what it is if not.
 *
 * The picture half honours three things the export used to ignore, and the first
 * two are correctness rather than fidelity - both features shipped and the
 * export did not know either existed:
 *
 *   meta.crop     the source rectangle, through itemCrop()
 *   meta.adjust   the grade, through adjustFilter() - the *same string* the card
 *                 puts on --item-filter, which is why that builder moved down to
 *                 board-model.ts
 *   object-fit    through fitMode(), the board's own answer. Every photograph on
 *                 a board set to Fit was being exported cropped to fill.
 */
async function paintMedia({ ctx, it, w, h, look, scale }: Paint) {
  const hash = pixelHash(it);
  const img = hash ? await loadImage(assetURL(hash)) : null;
  if (img) {
    const radius = Math.min(w, h) * 0.03;
    ctx.save();
    roundRect(ctx, -w / 2, -h / 2, w, h, radius);
    ctx.clip();
    // The card behind a contained picture, so the letterboxed bands are the
    // card and not a hole in the board.
    if (fitMode(it) === 'contain') {
      ctx.fillStyle = look.card;
      ctx.fillRect(-w / 2, -h / 2, w, h);
    }
    const filter = look.detail === 'full' ? adjustFilter(it) : null;
    if (filter) ctx.filter = filter;
    drawFitted(ctx, img, it, w, h);
    if (filter) ctx.filter = 'none';
    ctx.restore();
    if (look.detail === 'full') captionBar(ctx, it, w, h, look, scale);
    return;
  }

  // No picture: a card face with its name, which covers links, text, audio
  // without art, and any named file card.
  ctx.fillStyle = look.card;
  roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.06);
  ctx.fill();

  const label = (it.name || '').slice(0, 120);
  if (!label) return;
  ctx.save();
  roundRect(ctx, -w / 2, -h / 2, w, h, 0);
  ctx.clip();
  const size = Math.max(11, Math.min(w, h) * 0.11);
  ctx.fillStyle = look.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `500 ${size}px ${look.display}`;
  wrapText(ctx, label, w * 0.86, Math.max(12, Math.min(w, h) * 0.13));
  // The line the card carries under its name: how big it is and what it is.
  // Both strings are already computed by the app - formatBytes() and
  // describeExt() - so this is the card's own sentence rather than a second
  // opinion about the file.
  if (look.detail === 'full') {
    const kicker = describeCard(it);
    if (kicker) {
      ctx.fillStyle = look.ink3;
      ctx.font = `400 ${Math.max(9, size * 0.62)}px ${look.body}`;
      ctx.textBaseline = 'bottom';
      ctx.fillText(kicker, 0, h / 2 - size * 0.7, w * 0.86);
    }
  }
  ctx.restore();
}

/** "1.4 MB · MP3", the way canvas/renderers.ts builds the same line. */
function describeCard(it: Item): string {
  const asset = it.asset && getAsset(it.asset.hash);
  // meta.ext first and the filename second, which is the order the real card
  // reads them in - see the note over the same line in canvas/renderers.ts.
  const ext = (metaStr(it.meta?.ext) || extOf(it.name) || '').replace(/^\./, '');
  const known = describeExt(ext);
  const what = ext ? ext.toUpperCase() : (known ? known.label : metaStr(it.meta?.mime));
  return [asset && formatBytes(asset.size), what].filter(Boolean).join(' · ');
}

/**
 * The plate across the foot of a picture card, with its caption on it.
 *
 * Every card has one on the board - see bottomBar() in canvas/item-dom.ts,
 * which builds it for every type and lets the CSS decide who shows a name. A
 * picture with a caption exported without it lost the one piece of writing on
 * that card.
 */
function captionBar(
  ctx: CanvasRenderingContext2D, it: Item, w: number, h: number, look: Look, scale: number,
) {
  const name = (it.name || '').trim();
  if (!name) return;
  const size = Math.max(9, Math.min(22 * scale, h * 0.07));
  const bar = size * 2;
  // Below a certain drawn size the plate is a smudge with a smudge on it, which
  // is worse than a clean photograph. The same judgement canvas/paper.ts makes
  // about its own caption, at its own threshold.
  if (bar > h * 0.4 || size < 7) return;
  ctx.save();
  roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.03);
  ctx.clip();
  ctx.fillStyle = look.card;
  ctx.globalAlpha = 0.92;
  ctx.fillRect(-w / 2, h / 2 - bar, w, bar);
  ctx.globalAlpha = 1;
  ctx.fillStyle = look.ink;
  ctx.font = `500 ${size}px ${look.display}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, -w / 2 + size * 0.8, h / 2 - bar / 2, w - size * 1.6);
  ctx.restore();
}

/**
 * Draw `img` into the w x h box centred on the origin, through the item's crop
 * and its object-fit.
 *
 * The crop is a rectangle in *source* fractions (itemCrop), so it selects the
 * region before the fit decides how that region meets the card. That order is
 * the one the app uses: canvas/display.ts bakes the crop into the display copy
 * and object-fit then works on what is left.
 */
function drawFitted(
  ctx: CanvasRenderingContext2D, img: HTMLImageElement, it: Item, w: number, h: number,
) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const crop = itemCrop(it);
  const sx0 = crop ? crop.x * iw : 0;
  const sy0 = crop ? crop.y * ih : 0;
  const sw0 = crop ? crop.w * iw : iw;
  const sh0 = crop ? crop.h * ih : ih;

  if (fitMode(it) === 'contain') {
    const s = Math.min(w / sw0, h / sh0);
    const dw = sw0 * s, dh = sh0 * s;
    ctx.drawImage(img, sx0, sy0, sw0, sh0, -dw / 2, -dh / 2, dw, dh);
    return;
  }
  // Cover: fill the card and take the overflow off the middle of the crop.
  const s = Math.max(w / sw0, h / sh0);
  const sw = w / s, sh = h / s;
  ctx.drawImage(img, sx0 + (sw0 - sw) / 2, sy0 + (sh0 - sh) / 2, sw, sh, -w / 2, -h / 2, w, h);
}

/**
 * Lay out a few wrapped lines.
 *
 * Centred on the origin by default, which is what the card face wants; `at`
 * gives a top-left corner and a line budget instead, which is what a note wants.
 */
function wrapText(
  ctx: CanvasRenderingContext2D, text: string, maxWidth: number, lineHeight: number,
  at?: { x: number, y: number, lines: number },
) {
  const cap = at ? Math.max(1, at.lines) : 6;
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const trial = line ? line + ' ' + word : word;
      if (ctx.measureText(trial).width > maxWidth && line) { lines.push(line); line = word; }
      else line = trial;
      if (lines.length >= cap) break;
    }
    if (lines.length >= cap) break;
    lines.push(line);
  }
  const shown = lines.slice(0, cap);
  if (at) {
    shown.forEach((l, i) => ctx.fillText(l, at.x, at.y + i * lineHeight, maxWidth));
    return;
  }
  const top = -(shown.length - 1) * lineHeight / 2;
  shown.forEach((l, i) => ctx.fillText(l, 0, top + i * lineHeight));
}

// ---------------------------------------------------------------------------
// The board surface: the lattice, the sheet, the web, the stock
// ---------------------------------------------------------------------------

/** World point -> canvas point, for a given render's frame. */
type Project = (x: number, y: number) => { x: number, y: number };

/**
 * The lattice.
 *
 * paintGrid() itself cannot be reused and this is not an oversight: it paints
 * against a live viewport, into an on-screen canvas, as a tiled background for
 * two of the three tiers - none of which exists here. What *is* reused is the
 * pure half: boardGridStep() answers what the step is, and the two ink tokens
 * are the same ones the real lattice reads.
 *
 * Marks, not ruled lines, for the reason the real one gives: a full-bleed line
 * grid beats against the pixel grid into moire and competes with the axes for
 * the same reading. Crosses at Harsh and dots elsewhere, which is the one
 * visible difference between the tiers.
 */
function paintGrid(
  ctx: CanvasRenderingContext2D, look: Look, project: Project,
  world: { x0: number, y0: number, x1: number, y1: number }, scale: number,
) {
  const g = look.grid;
  if (!g) return;
  const step = boardGridStep(board.settings.gridStep, null, false);
  if (!(step > 0)) return;
  const drawn = step * scale;
  // Below a couple of pixels a lattice is a grey wash, and a grey wash over a
  // moodboard is dirt. The real one coarsens as the zoom drops; this simply
  // stops, because there is no zoom here to coarsen with.
  if (drawn < 4) return;
  const MAJOR = 4;

  // Rounded outward to the lattice, so the marks land on the board's own
  // coordinates rather than on the export's frame - the origin has to be one of
  // them or the grid is a different grid from the one on screen.
  const x0 = Math.floor(world.x0 / step) * step;
  const y0 = Math.floor(world.y0 / step) * step;
  ctx.save();
  for (let wx = x0; wx <= world.x1; wx += step) {
    for (let wy = y0; wy <= world.y1; wy += step) {
      const major = Math.round(wx / step) % MAJOR === 0 && Math.round(wy / step) % MAJOR === 0;
      const p = project(wx, wy);
      const r = (major ? 1.5 : 1) * Math.max(1, scale);
      ctx.fillStyle = major ? g.major : g.minor;
      if (g.harsh) {
        // A registration cross, the mark the plain tier draws.
        const arm = r * 3;
        ctx.fillRect(p.x - arm, p.y - r / 2, arm * 2, r);
        ctx.fillRect(p.x - r / 2, p.y - arm, r, arm * 2);
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

/**
 * The paper sheet, as the outline it is on the board.
 *
 * Centred on the world origin and never anywhere else - see canvas/paper.ts,
 * which explains why a sheet you could put anywhere would be a sheet you have to
 * line things up against twice. Its size is the only place `settings.scale`
 * enters this file, through the same two functions the live sheet uses.
 */
function paintPaper(
  ctx: CanvasRenderingContext2D, look: Look, project: Project, scale: number,
) {
  const s = board.settings;
  const mm = paperMm(s.paper, s.paperLandscape);
  if (!mm) return;
  const w = toUnits(mm.w, s.scale), h = toUnits(mm.h, s.scale);
  if (!(w > 0 && h > 0)) return;
  const a = project(-w / 2, h / 2);
  const b = project(w / 2, -h / 2);
  ctx.save();
  ctx.strokeStyle = look.rule;
  ctx.lineWidth = Math.max(1, scale);
  ctx.setLineDash([6 * Math.max(1, scale), 5 * Math.max(1, scale)]);
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.restore();
}

/**
 * The connections, under the items - which is where they are on the board.
 *
 * Cheap, because the router is pure: routeConnection() takes boxes and gives
 * back points, pathData() turns points into an SVG `d`, and a `d` string becomes
 * a Path2D a canvas can stroke. So the lines in an export are routed by the same
 * code that routed them on screen rather than drawn as straight segments between
 * centres, which is the difference between a board's web and a cat's cradle.
 *
 * The router works in the layer's own coordinates, where y points down - see
 * centres() in canvas/web.ts - so the boxes go in with `-y` and the points come
 * back needing the same flip undone.
 *
 * Arrowheads and labels are drawn plainly: a filled triangle and a word. The
 * real ones are an SVG marker and a text element with a halo, and neither is
 * worth a second implementation here.
 */
function paintWeb(
  ctx: CanvasRenderingContext2D, look: Look, items: Item[],
  project: Project, scale: number,
) {
  const web = look.web;
  if (!web || !board.connections.length) return;
  const boxes = new Map(items
    .filter(i => i.type !== 'fence' && i.type !== 'sticker' && i.type !== 'ghost')
    .map(i => [i.id, {
      id: i.id, x: i.x, y: -i.y, w: i.w, h: i.h,
      rot: -(i.rot || 0) + tiltOf(i.id) * look.lean,
    }]));
  const all = [...boxes.values()];
  // The whimsy tier's own routing shape, the same translation look() makes in
  // canvas/web.ts. Restated rather than imported because that one reads the live
  // board's grid step off the viewport, which there is not one of here.
  const level = document.documentElement.dataset.whimsy;
  const soft = 14;
  const opts: RouteOpts = level === '2'
    ? { shape: 'grid', step: boardGridStep(board.settings.gridStep, null, false), clearance: CLEARANCE }
    : level === '0'
      ? { shape: 'taut', clearance: CLEARANCE + soft }
      : { shape: 'taut', clearance: CLEARANCE };
  // The corner, which is the other half of look() in canvas/web.ts and is not
  // part of the router's own options - the route is a list of points either way,
  // and how sharply it turns them is pathData()'s question.
  const radius = level === '2' ? 0 : level === '0' ? soft : 9;

  const seen = new Set<string>();
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const conn of board.connections) {
    const [aId, bId] = conn;
    const a = boxes.get(aId), b = boxes.get(bId);
    if (!a || !b) continue;
    const key = pairKey(aId, bId);
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = connMeta(conn[2]);
    const obstacles = all.filter(o => o.id !== aId && o.id !== bId);
    const points = routeConnection(a, b, obstacles, opts).points;
    if (points.length < 2) continue;

    // The routed path arrives in layer coordinates; the transform below is what
    // takes it to the canvas, so pathData() can hand back its string untouched.
    ctx.save();
    const origin = project(0, 0);
    ctx.translate(origin.x, origin.y);
    ctx.scale(scale, scale);
    ctx.strokeStyle = meta?.color ? connColour(meta.color, web.line) : web.line;
    ctx.lineWidth = web.weight
      * (meta?.weight === 'fine' ? 0.7 : meta?.weight === 'bold' ? 2.2 : 1);
    if (meta?.style === 'dashed') ctx.setLineDash([7, 5]);
    else if (meta?.style === 'dotted') ctx.setLineDash([0.5, 5]);
    else ctx.setLineDash([]);
    ctx.stroke(new Path2D(pathData(points, radius)));
    ctx.restore();

    if (meta?.dir === 'fwd' || meta?.dir === 'both') {
      arrowHead(ctx, points[points.length - 2], points[points.length - 1], project, scale,
        meta.color ? connColour(meta.color, web.line) : web.line, web.weight);
    }
    if (meta?.dir === 'back' || meta?.dir === 'both') {
      arrowHead(ctx, points[1], points[0], project, scale,
        meta.color ? connColour(meta.color, web.line) : web.line, web.weight);
    }
    if (meta?.label && look.detail === 'full') {
      const mid = points[Math.floor(points.length / 2)];
      const p = project(mid.x, -mid.y);
      const size = Math.max(9, 12 * scale);
      ctx.font = `500 ${size}px ${look.body}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // The halo the real label wears, drawn as a stroke under the fill - a word
      // laid over a routed line is unreadable without one.
      ctx.lineWidth = size * 0.35;
      ctx.strokeStyle = look.paper;
      ctx.setLineDash([]);
      ctx.strokeText(meta.label, p.x, p.y);
      ctx.fillStyle = look.ink;
      ctx.fillText(meta.label, p.x, p.y);
    }
  }
  ctx.restore();
}

/** A connection colour name to a value - the same five canvas.css names. */
function connColour(name: string, fallback: string) {
  const token = name === 'accent' ? '--accent'
    : name === 'warm' ? '--accent-warm'
    : name === 'leaf' ? '--leafy'
    : name === 'danger' ? '--danger'
    : '';
  return (token && readToken(token)) || fallback;
}

/** One filled triangle at `to`, pointing the way the last segment runs. */
function arrowHead(
  ctx: CanvasRenderingContext2D, from: { x: number, y: number }, to: { x: number, y: number },
  project: Project, scale: number, colour: string, weight: number,
) {
  const a = project(from.x, -from.y), b = project(to.x, -to.y);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const size = Math.max(4, weight * 3 * scale);
  ctx.save();
  ctx.setLineDash([]);
  ctx.translate(b.x, b.y);
  ctx.rotate(angle);
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, size * 0.55);
  ctx.lineTo(-size, -size * 0.55);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * The stock, last, and it is the one thing here written with an eye on the file
 * rather than on the picture.
 *
 * Noise is the worst case a JPEG can be handed: it destroys inter-block
 * prediction, so a full-strength grain over an 8000px export is several times
 * the file size of the same board without it, for a texture that at that
 * compression reads as artefacts anyway. So it is drawn at a fraction of what
 * the board wears - GRAIN_EXPORT - and coarse, one speck per few pixels rather
 * than per pixel, which is what a printed sheet's stock looks like at this size
 * in any case.
 *
 * If the size still comes out unacceptable, the way out is not to tune this
 * further: buildPdf() writes /DCTDecode, and a /FlateDecode PNG path is
 * available - CompressionStream and storage/zip.ts's deflate both already exist.
 * That is a bigger change than a strength, so it is written down rather than
 * done.
 */
const GRAIN_EXPORT = 0.35;
const GRAIN_CELL = 3;

function paintGrain(ctx: CanvasRenderingContext2D, look: Look, W: number, H: number) {
  const strength = look.grain * GRAIN_EXPORT;
  if (!(strength > 0.002)) return;
  const tile = document.createElement('canvas');
  const side = 128;
  tile.width = side;
  tile.height = side;
  const tctx = tile.getContext('2d');
  if (!tctx) return;
  const img = tctx.createImageData(side, side);
  // A deterministic speckle rather than Math.random, so two exports of one board
  // are the same file. The board's own item count seeds it, which is enough to
  // stop every board wearing an identical pattern.
  let seed = (board.items.length * 2654435761) >>> 0;
  const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let y = 0; y < side; y += GRAIN_CELL) {
    for (let x = 0; x < side; x += GRAIN_CELL) {
      const v = Math.round(next() * 255);
      const a = Math.round(next() * 255 * strength);
      for (let dy = 0; dy < GRAIN_CELL && y + dy < side; dy++) {
        for (let dx = 0; dx < GRAIN_CELL && x + dx < side; dx++) {
          const i = ((y + dy) * side + (x + dx)) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
          img.data[i + 3] = a;
        }
      }
    }
  }
  tctx.putImageData(img, 0, 0);
  const pattern = ctx.createPattern(tile, 'repeat');
  if (!pattern) return;
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// The render
// ---------------------------------------------------------------------------

/**
 * The whole board on a canvas, or null if there is nothing on it.
 *
 * World y points up and a canvas lays y down, so every item's top is measured
 * from the board's top edge. Items are drawn in z order, turned by their own
 * rotation *and* by the lean the card is resting at, so a scrapbook board comes
 * out looking like the scrapbook it is.
 *
 * ── The lean, and the one thing about it that is not right ──
 *
 * `--item-tilt` is dealt from a bag when a card is built and lives only on the
 * mounted node; nothing stores it and nothing can, because it is not the item's
 * rotation. So it is read back off the node through tiltOf(), which answers 0
 * for a card that has none.
 *
 * The consequence is worth stating plainly: **a card that is culled has no
 * node**, so an export taken while zoomed far enough out for culling comes out
 * with some cards leaning and some straight. The clean fix is an optional
 * durable `meta.tilt` - a backwards-compatible addition to the .mbrd - and that
 * is a format decision to take deliberately rather than as a side effect of an
 * export. Until it is taken, this is the honest half of the answer: right for
 * every card on screen, straight for the rest.
 */
export async function renderBoardCanvas(detail: Detail = 'full') {
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

  // The board's own faces, before a single fillText. ui/fonts.ts has already
  // added them to document.fonts for the cards on screen, so this is only
  // waiting for that to have finished - without it the first export after a
  // board load is set in the fallback stack, which is the one difference from
  // the screen nobody would think to look for.
  if (detail === 'full' && document.fonts?.ready) {
    try { await document.fonts.ready; } catch { /* no font manager: the stack falls back */ }
  }

  const look = readLook(detail);
  const project: Project = (x, y) => ({
    x: ((x - b.x0) + MARGIN) * scale,
    y: ((b.y1 - y) + MARGIN) * scale,
  });

  ctx.fillStyle = look.paper;
  ctx.fillRect(0, 0, W, H);

  paintGrid(ctx, look, project, {
    x0: b.x0 - MARGIN, y0: b.y0 - MARGIN, x1: b.x1 + MARGIN, y1: b.y1 + MARGIN,
  }, scale);
  paintPaper(ctx, look, project, scale);
  paintWeb(ctx, look, items, project, scale);

  const ordered = [...items].sort((p, q) => (p.z || 0) - (q.z || 0));
  for (const it of ordered) {
    const at = project(it.x, it.y);
    ctx.save();
    ctx.translate(at.x, at.y);
    // The item's own rotation, then the lean the card is resting at. Both in the
    // canvas's sense: world y points up and this lays it down, so item.rot is
    // negated, where the lean is a CSS rotation and is already in this sense.
    const lean = it.type === 'fence' ? 0 : tiltOf(it.id) * look.lean;
    const turn = -(it.rot || 0) + lean;
    if (turn) ctx.rotate(turn * Math.PI / 180);
    // No shadow under a sticker or a fence: one is a mark pressed onto the
    // board and the other is a line drawn round part of it, and neither is a
    // thing lying on top of anything.
    const lifted = it.type !== 'sticker' && it.type !== 'fence';
    withShadow(ctx, look, lifted, scale);
    await painterFor(it)({ ctx, it, w: it.w * scale, h: it.h * scale, look, scale });
    withShadow(ctx, look, false, scale);
    ctx.restore();
  }

  // Last, over everything, the way the layer sits over the board.
  paintGrain(ctx, look, W, H);
  return { canvas, w: W, h: H };
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> =>
  new Promise(resolve => canvas.toBlob(resolve, type, quality));

/** The board as a PNG blob, or null. */
export async function boardPng() {
  const shot = await renderBoardCanvas('full');
  return shot ? toBlob(shot.canvas, 'image/png') : null;
}

/**
 * A small thumbnail of the board as a data URL, or null - for the library
 * switcher's cards. Rendered the same way and then shrunk hard, so a shelf of
 * them is a page of data URLs rather than a page of full-size boards.
 *
 * 'thumb', and that matters more than it used to: since the shelf started
 * holding the outgoing board, this runs on **every open and every new**. Every
 * stage it skips - the lattice, the sheet, the web, the stock, the shadows and
 * every string of text - is one that would be invisible at 360px wide and is
 * paid for on a gesture somebody is waiting on.
 */
export async function boardThumb(max = 360) {
  const shot = await renderBoardCanvas('thumb');
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
  const shot = await renderBoardCanvas('full');
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
// The buffer is named in the array types below because a Blob part has to be
// one that is not shared: a Uint8Array over a SharedArrayBuffer is not a
// BlobPart, and `Uint8Array` alone leaves which one it is open.
function buildPdf(jpeg: Uint8Array<ArrayBuffer>, w: number, h: number) {
  const enc = new TextEncoder();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let len = 0;
  const offsets: number[] = [];
  const push = (data: string | Uint8Array<ArrayBuffer>) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    parts.push(bytes);
    len += bytes.length;
  };
  const obj = (n: number, body: string) => {
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
