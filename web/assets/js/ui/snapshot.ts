// Board snapshot — composites every item onto a canvas, exports PNG or
// one-page hand-written PDF. Manual compositing because foreignObject
// taints the canvas. detail 'full' for exports, 'thumb' for the library
// card — one parameter so the two renderers can't disagree.

import { readToken } from '../util.ts';
import { board, adjustFilter, itemCrop, itemFaded, itemFlip, itemRotate, itemMatte } from '../state.ts';
import { itemBounds } from '../geometry.ts';
import { assetURL, getAsset } from '../storage/assets.ts';
import { paperMm, toUnits } from '../measure.ts';
import { connMeta, pairKey } from '../board-model.ts';
import { CLEARANCE, routeConnection, pathData } from '../web-route.ts';
import type { RouteOpts } from '../web-route.ts';
// The lattice's policy, shared with the live grid: mark spacing, major
// frequency and weight, which tier draws crosses. Only the *drawing* is
// restated below - a mismatched major-mark cadence would be two different grids.
import { boardGridStep, MAJOR, MAJOR_WEIGHT, harshGrid } from '../canvas/grid.ts';
import { cutout } from '../canvas/matte.ts';
import { surface } from '../canvas/surface.ts';
import { fitMode } from '../canvas/renderers.ts';
import { noteWords } from '../canvas/note-model.ts';
import { tiltOf } from '../canvas/items.ts';
import { describeExt } from '../import/formats.ts';
import { extOf, formatBytes } from '../util.ts';
import { STICKER_SPRITE, STICKER_VIEWBOX } from '../stickers/catalogue.ts';
import type { Item, ItemType } from '../board-model.ts';

/** Which of the two jobs a render is for - see the head of this file. */
export type Detail = 'full' | 'thumb';

/**
 * The side of the box the sticker paths are drawn in, as a number - derived
 * from the viewBox string the five renderers already share, not written twice.
 */
const STICKER_GRID = +STICKER_VIEWBOX.split(' ')[2] || 256;

/** A frame of clear board around the outermost items, in world units. */
const MARGIN = 48;
/** The longest edge the output is allowed to reach, so a huge board still fits. */
const MAX_EDGE = 8000;

/**
 * The most pixels a canvas may hold, whatever shape they are in.
 *
 * iOS Safari refuses any canvas past 16,777,216 pixels the worst way: no
 * throw, no warning, just transparent output from then on. MAX_EDGE alone
 * permits 64 megapixels, so both exports came back blank on iOS for a large
 * enough board. Applied only where true - see drawsPastArea(), which asks
 * the canvas rather than the user agent (a UA test would be wrong for
 * Chrome on iOS, WebKit underneath).
 *
 * Sixteen million, not 16,777,216 exactly: both sides round *up* after the
 * scale is applied, so a budget at the exact limit lands a few thousand
 * pixels over it - and over by any amount is the same blank picture.
 */
const MAX_AREA = 16_000_000;

/** null until asked. true where a canvas past MAX_AREA actually draws. */
let bigCanvas: boolean | null = null;

/**
 * Whether this engine will draw a canvas larger than MAX_AREA.
 *
 * Asked of the canvas, not the user agent, and **lazily** - the probe costs
 * one oversized allocation, only reached when an export would exceed the
 * cap. The answer is kept for the session so multiple large exports pay once.
 *
 * The test is the failure mode itself: WebKit doesn't throw and doesn't
 * return a null context for an oversized canvas - it hands back one that
 * draws *nothing*. So: paint one white pixel and read it back. Opaque means
 * real; transparent (or a throw) means the cap applies. Collapsed to 0x0
 * afterwards rather than left to the collector - releasing ~60MB in one assignment.
 */
function drawsPastArea(): boolean {
  if (bigCanvas !== null) return bigCanvas;
  bigCanvas = false;
  const side = Math.ceil(Math.sqrt(MAX_AREA)) + 8;   // comfortably past the ceiling
  let probe: HTMLCanvasElement | null = null;
  try {
    probe = document.createElement('canvas');
    probe.width = side;
    probe.height = side;
    const ctx = probe.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 1, 1);
      bigCanvas = ctx.getImageData(0, 0, 1, 1).data[3] > 0;
    }
  } catch { /* unreadable is untrustworthy: the cap stands */ } finally {
    if (probe) { probe.width = 0; probe.height = 0; }
  }
  return bigCanvas;
}

/**
 * How far a board of this size has to shrink to become a canvas.
 *
 * Two ceilings, tighter wins: the edge cap is about a picture nobody wants,
 * the area cap is about a canvas the engine won't draw at all (MAX_AREA).
 * `areaCap` is Infinity for every engine but WebKit. Passed in rather than
 * read here, keeping the probe the caller's to run and this pure arithmetic.
 * Exported for testing without a board, a document or forty painters. Never
 * enlarges - a small board draws at 1:1.
 */
export function exportScale(
  worldW: number,
  worldH: number,
  maxEdge = MAX_EDGE,
  areaCap = MAX_AREA,
): number {
  const byEdge = maxEdge / Math.max(worldW, worldH);
  const byArea = Math.sqrt(areaCap / (worldW * worldH));
  return Math.min(1, byEdge, byArea);
}

/**
 * The area budget for this export, and the one place the probe is reached.
 *
 * Order is the economy of it: work out what the *edge* cap alone would
 * produce, and only ask the engine if that's past the ceiling. Nearly every
 * export costs nothing; the ones asking for 64 megapixels pay one allocation, once.
 */
function areaBudget(worldW: number, worldH: number, maxEdge: number): number {
  const byEdge = Math.min(1, maxEdge / Math.max(worldW, worldH));
  const wanted = worldW * byEdge * worldH * byEdge;
  if (wanted <= MAX_AREA) return MAX_AREA;   // never reached; the edge cap already binds
  return drawsPastArea() ? Infinity : MAX_AREA;
}

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
 * board-model.ts before landing on an item - the narrowing here is what the
 * open `meta` costs at the reading end.
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
 * readToken() is a getComputedStyle - a style flush - and a board can carry
 * hundreds of cards, so reading `--ink` inside the per-item painters would
 * flush per card. One read per token per render, and every colour on the
 * output is here.
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
 * `--shadow-1` is a `color-mix()` expression, and getPropertyValue hands a
 * custom property back unresolved - this file isn't growing a colour-space
 * implementation. So it's set as a real `box-shadow` on a real element and
 * the *computed* value is read back, already resolved. Null at the whimsy
 * extremes where the token is `none`, which a hand-rolled parser would get
 * wrong quietly.
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
 * The same two-part answer canvas/web.ts uses: `--item-tilt` (a per-card
 * fraction dealt from a bag, living only on the node) times `--tilt-max`,
 * zeroed outright by Harsh, a snapped board or Tilt cards off rather than by
 * zeroing the token - reading only the token would lean every card on a board
 * that draws none.
 */
function maxLean(): number {
  if (document.documentElement.dataset.whimsy === '2' || board.settings.snap
    || board.settings.tilt === false) return 0;
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
      // harshGrid(), not a bare '2': the crosses tier is canvas/grid.ts's
      // constant, not a second spelling of it here.
      harsh: harshGrid(),
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
 * A sticker is a vector outline that only exists in the sprite. Rasterising
 * via an <img> pointed at the SVG would taint the canvas or need the whole
 * file inlined per sticker, so the paths are fetched once as text and handed
 * to Path2D. A failure is silence, not an error: a missing sticker on a
 * thumbnail is worth less than a snapshot refusing to be taken.
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
      // body *and* an outline over it, painted differently, per the sprite's
      // own convention (no fill = paper, `fill="currentColor"` = ink).
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
 * Fills only, no stroke - Phosphor draws even its outline weights as filled
 * paths, so it's just two `fill()` calls in the sprite's own order.
 */
async function drawSticker(ctx: CanvasRenderingContext2D, it: Item, w: number, h: number) {
  const shape = it.meta?.shape;
  // A shape that is not a string is not in the sprite either: same silent way
  // out as one the sprite doesn't carry.
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
 * look. Origin is already the card's centre and rotation already applied, so
 * each painter is only about the card itself.
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
 * canvas/renderers.ts, so a new kind is one entry rather than an if-chain branch.
 *
 * `paintMedia` is the fallback rather than an entry: it's not a kind, it's
 * "has pixels, or has a name", covering everything not one of the four shapes above.
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
 * Its own painter because a fence has no face - falling through to the
 * named-card branch drew it as a small grey card, so labelled areas exported
 * as grey boxes lying under the work.
 *
 * Stroked, not filled: a region is a line drawn *round* things, and a fill
 * would wash over every card inside it. Name goes on the bottom bar, matching
 * bottomBar() in canvas/item-dom.ts.
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
 * **The rich model is flattened rather than laid out.** A note's `meta.rich`
 * is blocks with their own tags, font, size, alignment - drawing that on a
 * canvas would be a second text engine, disagreeing with the note on screen
 * at the first styled note somebody made. noteWords() is the board's own
 * answer to "what does this note say".
 *
 * Not flattenNoteRich() (writes the storage form with `#`/`##`, so a heading
 * came out as "# Kitchen"), and not `it.name` either (the note's first line
 * only, so a six-line note exported as its heading and nothing else).
 */
function paintNote({ ctx, it, w, h, look, scale }: Paint) {
  ctx.fillStyle = readToken(`--note-${(Number(it.meta?.tint) || 1)}`) || '#fff7d6';
  roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.06);
  // Low opacity: the paper at 60% and the words solid, as cards.css draws it.
  const alpha = ctx.globalAlpha;
  if (itemFaded(it)) ctx.globalAlpha = alpha * 0.6;
  ctx.fill();
  ctx.globalAlpha = alpha;
  if (look.detail !== 'full') return;

  // noteWords() and not flattenNoteRich() - see the header and note-model.ts.
  const text = noteWords(it.meta) || it.name || '';
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
 * Everything else: a picture if the card has one, a card face with its name
 * and kind if not.
 *
 * The picture half honours six things a plain draw would miss:
 *   meta.crop     source rectangle, through itemCrop()
 *   meta.flip     which way round it's hung, through itemFlip()
 *   meta.rotate   the quarter turn, through itemRotate()
 *   meta.matte    background removal, through prepare() below
 *   meta.adjust   the grade, through adjustFilter() - the *same string* the
 *                 card puts on --item-filter
 *   object-fit    through fitMode(); every Fit photograph was exporting
 *                 cropped to fill.
 */
async function paintMedia({ ctx, it, w, h, look, scale }: Paint) {
  const hash = pixelHash(it);
  const raw = hash ? await loadImage(assetURL(hash)) : null;
  // The picture to draw, and the rectangle of it to take: normally the file
  // and its crop; on a matted card, a knocked-out copy whose whole area is
  // the region. See prepare().
  const img = raw && await prepare(it, raw);
  if (img) {
    // A cut-out is drawn without its rounded clip as well as without its card
    // - the clip is a corner radius on a box a cut-out was told not to have.
    const bare = it.meta?.bare === true;
    const radius = Math.min(w, h) * 0.03;
    ctx.save();
    if (!bare) {
      roundRect(ctx, -w / 2, -h / 2, w, h, radius);
      ctx.clip();
    }
    // The card behind a contained picture, so letterboxed bands are the card,
    // not a hole. Never behind a cut-out - those bands are the empty
    // rectangle it exists to remove.
    if (fitMode(it) === 'contain' && !bare) {
      ctx.fillStyle = look.card;
      ctx.fillRect(-w / 2, -h / 2, w, h);
    }
    // The mirror is not gated on `detail` the way the grade below is: a grade
    // is a shade nobody can name at thumbnail size, but which way a
    // photograph faces is legible at any size.
    const flip = itemFlip(it);
    if (flip) ctx.scale(flip.x ? -1 : 1, flip.y ? -1 : 1);
    // The quarter turn, inside the mirror and outside the fit - the order the
    // three compose everywhere else. Box swapped for a quarter turn so the
    // rotation lands on the card's own w x h; 180 needs no swap.
    const rot = itemRotate(it);
    if (rot) ctx.rotate(rot * Math.PI / 180);
    const quarter = rot === 90 || rot === 270;
    const filter = look.detail === 'full' ? adjustFilter(it) : null;
    if (filter) ctx.filter = filter;
    drawFitted(ctx, img, it, quarter ? h : w, quarter ? w : h);
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
  // The line under the name: size and kind, both from formatBytes() and
  // describeExt(), so it's the card's own sentence, not a second opinion.
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
  // meta.ext first, filename second - the order the real card reads them in.
  const ext = (metaStr(it.meta?.ext) || extOf(it.name) || '').replace(/^\./, '');
  const known = describeExt(ext);
  const what = ext ? ext.toUpperCase() : (known ? known.label : metaStr(it.meta?.mime));
  return [asset && formatBytes(asset.size), what].filter(Boolean).join(' · ');
}

/**
 * The plate across the foot of a picture card, with its caption on it - every
 * card has one on the board (see bottomBar() in canvas/item-dom.ts). Exporting
 * without it lost the one piece of writing on that card.
 */
function captionBar(
  ctx: CanvasRenderingContext2D, it: Item, w: number, h: number, look: Look, scale: number,
) {
  const name = (it.name || '').trim();
  if (!name) return;
  const size = Math.max(9, Math.min(22 * scale, h * 0.07));
  const bar = size * 2;
  // Below a certain drawn size the plate is a smudge on a smudge, worse than
  // a clean photograph - same judgement canvas/paper.ts makes at its own threshold.
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

/** A picture ready to draw: the source, its size, and whether the crop is spent. */
type Ready = {
  src: CanvasImageSource, iw: number, ih: number, cropped: boolean,
};

/**
 * The long edge a cut-out picture is masked at, for the export - not the
 * display copy's ceiling, since this is the one path where the point is
 * resolution the screen never had.
 *
 * Bounds the *canvas the mask composites onto*, not the model's own work
 * (which always reads a 320x320 square, SIDE in canvas/matte.ts) - so this
 * costs one scaled draw, not more inference. Stretching a 320px mask further
 * makes the softness bigger, not better.
 */
const MATTE_EXPORT_MAX = 2048;

/**
 * The picture as it should be drawn, with the background taken out if it is.
 *
 * The common case is the file and its crop, unchanged (`cropped: false`
 * means drawFitted still applies the rectangle). A matted card can't work
 * that way - the removal is pixels, made here on a surface of its own.
 *
 * **The model runs on the cropped region, not the whole file** - a saliency
 * model answers "what is this a picture of" about whatever it's shown, and
 * the full frame is routinely a different subject from a tight crop.
 * Cropping first makes the export and the card the same picture.
 *
 * The turn is not applied here: paintMedia() rotates the context, so the
 * mask travels with the pixels it was computed from - unlike
 * canvas/display.ts, which turns before cutting because it bakes a bitmap
 * rather than driving a transform.
 *
 * Falls back to the untouched picture on any declined step - the background
 * still on it is a worse picture than the card, but a missing card is worse
 * than both.
 */
async function prepare(it: Item, img: HTMLImageElement): Promise<Ready | null> {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) return null;
  const plain: Ready = { src: img, iw, ih, cropped: false };
  if (!itemMatte(it)) return plain;
  const crop = itemCrop(it);
  const sx = crop ? Math.round(crop.x * iw) : 0;
  const sy = crop ? Math.round(crop.y * ih) : 0;
  const sw = Math.max(1, crop ? Math.round(crop.w * iw) : iw);
  const sh = Math.max(1, crop ? Math.round(crop.h * ih) : ih);
  const scale = Math.min(1, MATTE_EXPORT_MAX / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const face = surface(w, h);
  if (!face) return plain;
  face.ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  if (!await cutout(face, w, h)) return plain;
  return { src: face.canvas, iw: w, ih: h, cropped: true };
}

/**
 * Draw a prepared picture into the w x h box centred on the origin, through
 * the item's crop and its object-fit.
 *
 * The crop is a rectangle in *source* fractions (itemCrop), selecting the
 * region before the fit decides how it meets the card - the same order
 * canvas/display.ts uses when it bakes the crop into the display copy.
 *
 * `cropped` on the picture says the rectangle was already taken - a matted
 * card arrives as a canvas that *is* the crop, and applying it again would
 * cut a crop out of a crop.
 */
function drawFitted(
  ctx: CanvasRenderingContext2D, img: Ready, it: Item, w: number, h: number,
) {
  const { src, iw, ih } = img;
  if (!iw || !ih) return;
  const crop = img.cropped ? null : itemCrop(it);
  const sx0 = crop ? crop.x * iw : 0;
  const sy0 = crop ? crop.y * ih : 0;
  const sw0 = crop ? crop.w * iw : iw;
  const sh0 = crop ? crop.h * ih : ih;

  if (fitMode(it) === 'contain') {
    const s = Math.min(w / sw0, h / sh0);
    const dw = sw0 * s, dh = sh0 * s;
    ctx.drawImage(src, sx0, sy0, sw0, sh0, -dw / 2, -dh / 2, dw, dh);
    return;
  }
  // Cover: fill the card and take the overflow off the middle of the crop.
  const s = Math.max(w / sw0, h / sh0);
  const sw = w / s, sh = h / s;
  ctx.drawImage(src, sx0 + (sw0 - sw) / 2, sy0 + (sh0 - sh) / 2, sw, sh, -w / 2, -h / 2, w, h);
}

/**
 * Lay out a few wrapped lines.
 *
 * Centred on the origin by default (what a card face wants); `at` gives a
 * top-left corner and a line budget (what a note wants).
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
 * paintGrid() itself can't be reused - it paints against a live viewport as
 * a tiled background, none of which exists here. What *is* reused is the
 * pure half: boardGridStep(), MAJOR/MAJOR_WEIGHT, harshGrid() - imported so
 * the export can't disagree with the screen about what the grid *is*, even
 * though the drawing is restated. Marks, not ruled lines - a full-bleed line
 * grid beats against the pixel grid into moire. Crosses at Harsh, dots elsewhere.
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
  // moodboard is dirt. The real one coarsens with zoom; this has none, so it
  // simply stops.
  if (drawn < 4) return;

  // Rounded outward to the lattice, so marks land on the board's own
  // coordinates rather than the export's frame.
  const x0 = Math.floor(world.x0 / step) * step;
  const y0 = Math.floor(world.y0 / step) * step;
  ctx.save();
  for (let wx = x0; wx <= world.x1; wx += step) {
    for (let wy = y0; wy <= world.y1; wy += step) {
      const major = Math.round(wx / step) % MAJOR === 0 && Math.round(wy / step) % MAJOR === 0;
      const p = project(wx, wy);
      const r = (major ? MAJOR_WEIGHT : 1) * Math.max(1, scale);
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
 * The paper sheet, as the outline it is on the board - centred on the world
 * origin and never anywhere else (see canvas/paper.ts). Its size is the only
 * place `settings.scale` enters this file, through the same two functions the
 * live sheet uses.
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
 * The connections, under the items - where they are on the board.
 *
 * Cheap because the router is pure: routeConnection() takes boxes, gives
 * back points; pathData() turns points into an SVG `d`; a `d` becomes a
 * Path2D a canvas can stroke. Export lines are routed by the same code as
 * the screen, not drawn as straight segments between centres.
 *
 * The router works in the layer's own y-down coordinates (see centres() in
 * canvas/web.ts), so boxes go in with `-y` and points come back needing the
 * flip undone. Arrowheads and labels are drawn plainly - not worth a second
 * implementation of the SVG marker/halo.
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
  // The whimsy tier's own routing shape, the translation look() makes in
  // canvas/web.ts - restated because that one reads the live viewport's grid
  // step, which there isn't one of here.
  const level = document.documentElement.dataset.whimsy;
  const soft = 8;
  const opts: RouteOpts = level === '2'
    ? { shape: 'grid', step: boardGridStep(board.settings.gridStep, null, false), clearance: CLEARANCE }
    : level === '0'
      ? { shape: 'curve', clearance: CLEARANCE + soft }
      : { shape: 'square', clearance: CLEARANCE };
  // The corner radius, the other half of look() in canvas/web.ts - a route is
  // a list of points either way, and how sharply it turns is pathData()'s question.
  // Softish is drawn as a spline instead (curved), so its radius is unused.
  const radius = level === '2' ? 0 : level === '0' ? 0 : 16;
  const curved = level === '0';

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
    const routed = routeConnection(a, b, obstacles, opts);
    const points = routed.points;
    if (points.length < 2) continue;
    // Softish leaves each card square to its face; the router chose the sides.
    const ends = curved ? routed.ends : undefined;

    // The routed path arrives in layer coordinates; this transform takes it
    // to the canvas so pathData() can hand back its string untouched.
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
    ctx.stroke(new Path2D(pathData(points, radius, 0, 0, curved, ends)));
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
      // The halo the real label wears, drawn as a stroke under the fill - a
      // word over a routed line is unreadable without one.
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
 * The stock, last - written with an eye on the file rather than the picture.
 *
 * Noise is the worst case a JPEG can be handed: it destroys inter-block
 * prediction, so full-strength grain over an 8000px export costs several
 * times the file size for a texture that reads as artefacts anyway. Drawn
 * at a fraction of the board's own strength (GRAIN_EXPORT) and coarse - one
 * speck per few pixels, matching a printed sheet's stock at this scale.
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
  // A deterministic speckle rather than Math.random, so two exports of one
  // board are the same file - seeded by item count, enough to stop every
  // board wearing an identical pattern.
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
 * World y points up and a canvas lays y down, so every item's top is
 * measured from the board's top edge. Drawn in z order, turned by its own
 * rotation *and* the lean it's resting at, so a scrapbook board comes out as one.
 *
 * `--item-tilt` is dealt from a bag when a card is built and lives only on
 * the mounted node - nothing stores it. Read back through tiltOf(), which
 * answers 0 for a card with none. Consequence: **a culled card has no
 * node**, so an export taken zoomed out far enough for culling comes out
 * with some cards leaning and some straight - right for every card on
 * screen, straight for the rest, until an optional durable `meta.tilt` is
 * added deliberately rather than as an export side effect.
 */
async function renderBoardCanvas(detail: Detail = 'full', maxEdge = MAX_EDGE) {
  const items = drawable();
  const b = itemBounds(items);
  if (!b) return null;

  const worldW = (b.x1 - b.x0) + MARGIN * 2;
  const worldH = (b.y1 - b.y0) + MARGIN * 2;
  const scale = exportScale(worldW, worldH, maxEdge, areaBudget(worldW, worldH, maxEdge));
  const W = Math.max(1, Math.ceil(worldW * scale));
  const H = Math.max(1, Math.ceil(worldH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // The board's own faces, before a single fillText. ui/fonts.ts has already
  // added them to document.fonts for on-screen cards, so this only waits for
  // that - without it, the first export after a board load falls back to the
  // system stack, the one difference from the screen nobody would think to check.
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
    // The item's own rotation, then the lean it's resting at - both in the
    // canvas's y-down sense, so item.rot is negated where the lean (a CSS
    // rotation) already matches.
    const lean = it.type === 'fence' ? 0 : tiltOf(it.id) * look.lean;
    const turn = -(it.rot || 0) + lean;
    if (turn) ctx.rotate(turn * Math.PI / 180);
    // No shadow under a sticker or a fence - a mark pressed onto the board
    // and a line drawn round part of it, neither a thing lying on top.
    //
    // Nor under a cut-out, the third of that kind and the reason this list
    // had to be checked: this renderer hangs its own shadow rather than
    // relying on the stylesheet, so an image without a card would have grown
    // a border and shadow back on export - a bug visible only in the export,
    // seen only by whoever prints one.
    //
    // And a sticky at low opacity, which the canvas draws with no shadow twin
    // (noTwin() in canvas/items.ts). paintNote() thins its paper.
    const faded = it.type === 'note' && itemFaded(it);
    const lifted = it.type !== 'sticker' && it.type !== 'fence' && it.meta?.bare !== true && !faded;
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
 * switcher's cards. Rendered the same way, then shrunk hard, so a shelf of
 * them is a page of data URLs rather than a page of full-size boards.
 *
 * 'thumb' matters more than it used to: since the shelf started holding the
 * outgoing board, this runs on **every open and every new** - every stage
 * it skips (lattice, sheet, web, stock, shadows, text) is invisible at 360px
 * and paid for on a gesture somebody is waiting on.
 */
export async function boardThumb(max = 360) {
  // Rendered near the size it will end up, not at MAX_EDGE and shrunk. Used
  // to draw the whole board at 8000px - 256MB, four times iOS Safari's
  // canvas ceiling - so the thumbnail came back blank on exactly the
  // platform canvas/display.ts exists to protect, for a picture ending up
  // 360px wide. Four times the target leaves room for a smooth downscale,
  // costing ~2MB instead of 256.
  const shot = await renderBoardCanvas('thumb', max * 4);
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
  // WebP, then JPEG. toDataURL carries its own type in the returned string,
  // the only way to catch the engine silently substituting PNG (no Safari
  // writes WebP from a canvas). Matters more than a wrong extension:
  // storage/library.ts keeps this string in the shelf's index, read in full
  // every switcher draw - a 360px PNG is hundreds of KB of base64 where
  // WebP is fifteen, so Safari turned a fast read into a multi-megabyte one.
  // A board thumbnail is opaque (paper filled first), so JPEG needs no alpha question.
  try {
    const webp = c.toDataURL('image/webp', 0.7);
    if (webp.startsWith('data:image/webp')) return webp;
    return c.toDataURL('image/jpeg', 0.7);
  } catch { return null; }
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
 * Five objects (catalog, pages, page, image, one-line content stream) plus a
 * cross-reference table. The JPEG rides in verbatim under /DCTDecode, which
 * is why the canvas is encoded as JPEG here and not PNG - a PDF speaks JPEG
 * directly, where PNG would need decoding and re-deflating. The page is the
 * image's own pixel size in points, so it prints at 72dpi.
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

// ---------------------------------------------------------------------------
// The style tile is not here any more
// ---------------------------------------------------------------------------
//
// It was a 1500x1000 canvas painted box by box, saved as a PNG and wrapped
// in buildPdf(). Now it's a card on the board - see the style-tile renderer
// in canvas/renderers.ts. A card is DOM, so its swatches can hold
// `var(--accent)` and follow the palette live, which no painted tile could.
// The board export still answers *show me the board*; the card answers
// *what does this board look like*. Both questions survived; only one is a file.
