// Board snapshot — composites every item onto a canvas, exports JPEG or
// one-page hand-written PDF. On Chromium an export draws each card from its
// own DOM (ui/capture.ts); on Safari and Firefox, where foreignObject taints
// the canvas, and for every thumbnail, each card has a painter here instead.
// detail 'full' for exports, 'thumb' for the library card — one parameter so
// the two renderers can't disagree. What a full export contains and how big it
// comes out is ExportOpts, below, which ui/export-options.ts fills from the box.

import { readToken } from '../util.ts';
import {
  board, adjustFilter, itemCrop, itemFaded, itemFlip, itemRotate, itemMatte, childOf, childFace,
} from '../state.ts';
import { itemBounds, PRINT_MAT, PRINT_CHIN } from '../geometry.ts';
import { assetURL, getAsset } from '../storage/assets.ts';
import { paperMm, toUnits, clampScale, MM_PER_INCH } from '../measure.ts';
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
import { isPrint } from '../canvas/picture-shape.ts';
import { noteWords, normalizeNoteRich, richLines, NOTE_FONTS } from '../canvas/note-model.ts';
import type { NoteFont } from '../canvas/note-model.ts';
import { drawCaptured, captureCards, rootAttrs } from './capture.ts';
import { boardSvg as boardSvgText } from './capture-css.ts';
import type { SvgCard } from './capture-css.ts';
import { tiltOf } from '../canvas/items.ts';
import { readDrawing, outline, INK_VAR } from '../canvas/strokes.ts';
import { currentTier } from '../canvas/drawing.ts';
import { describeExt } from '../import/formats.ts';
import { extOf, formatBytes, isRecord } from '../util.ts';
import { STICKER_SPRITE, STICKER_VIEWBOX } from '../stickers/catalogue.ts';
import type { Item, ItemType } from '../board-model.ts';
import { encodeJpeg } from './jpeg.ts';

/** Which of the two jobs a render is for - see the head of this file. */
export type Detail = 'full' | 'thumb';

/**
 * The side of the box the sticker paths are drawn in, as a number - derived
 * from the viewBox string the five renderers already share, not written twice.
 */
const STICKER_GRID = +STICKER_VIEWBOX.split(' ')[2] || 256;

/** The thumbnail's frame of clear board around the outermost items, in world
 *  units. An export measures its own margin in millimetres - see ExportOpts. */
const MARGIN = 48;
/** The longest edge the output is allowed to reach, so a huge board still fits. */
const MAX_EDGE = 8000;

/**
 * What one export is, as the box that offers it settles it.
 *
 * All nine are the person's to change and none is remembered past the
 * session - ui/export-options.ts holds the working copy. Kept here beside
 * the renderer that obeys them so a new option cannot exist in the box and
 * not in the picture.
 *
 * `ppi` is the whole of the resolution question: the board knows how many
 * world units make a millimetre (settings.scale), so a dots-per-inch figure
 * fixes the pixel size of everything on it. A sheet of A4 at 300 comes out
 * 2480 x 3508 - the size a printer expects - however the board is scaled.
 */
export interface ExportOpts {
  /** Dots per inch of real board. The export's only size control. */
  ppi: number;
  /** JPEG quality, 0..1 - the image and the picture inside the PDF both. */
  quality: number;
  /** Clear board around the outermost items, in millimetres. */
  margin: number;
  /** Draw the connections between cards. */
  web: boolean;
  /** Draw the paper sheet's outline, where the board shows one. */
  sheet: boolean;
  /** Draw the board's lattice. */
  grid: boolean;
  /** Draw the paper's texture - the board's own tile, under everything. */
  grain: boolean;
  /** Lean the cards as the board leans them; off stands them all up. */
  tilt: boolean;
  /** Draw the cards' shadows, as the board's underlay does. */
  shadows: boolean;
  /**
   * Draw only these items, framed on them - a selection, or a fence and what
   * is in it. Absent or null is the whole board. Filtered in planRender(), the
   * one place every export and the box's own readout ask, so a later renderer
   * inherits it rather than restating it.
   */
  only?: readonly string[] | null;
}

/**
 * What an export is before anybody touches it.
 *
 * 300 ppi is what a print wants. The texture is off because it is the board's
 * surface rather than anything on it, and a sheet handed to somebody else is
 * about what is on the board; the lattice is off because it is a working aid
 * rather than content.
 *
 * Quality 97 on libjpeg's scale, always 4:4:4 - which is why the encoding is
 * ui/jpeg.ts and not canvas.toBlob(): the engine picks a canvas's chroma
 * sampling, and Blink picks 4:2:0 at every quality, 0.97 included. Full colour
 * resolution is what keeps a card's coloured text and ruled edges clean.
 */
export const EXPORT_DEFAULTS: ExportOpts = {
  ppi: 300,
  quality: 0.97,
  margin: 10,
  web: true,
  sheet: true,
  grid: false,
  grain: false,
  tilt: true,
  shadows: true,
};

/** Canvas pixels per world unit, and its inverse. The ppi rule, both ways. */
export const pixelsPerUnit = (ppi: number, scale: unknown) =>
  (ppi > 0 ? ppi : EXPORT_DEFAULTS.ppi) / MM_PER_INCH / clampScale(scale);
export const ppiOf = (pxPerUnit: number, scale: unknown) =>
  pxPerUnit * clampScale(scale) * MM_PER_INCH;

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
 * Exported for testing without a board, a document or forty painters.
 *
 * `want` is what the caller asked for and the only thing this can return
 * that is not a ceiling: the ppi the export box names, as pixels per world
 * unit. It defaults to 1, which is the thumbnail's question and was once the
 * only one - a board was drawn at its own size and shrunk if it was too big
 * to hold. Both ceilings still bind, so asking for 600 ppi of a wall-sized
 * board gets whatever fits rather than a blank canvas.
 */
export function exportScale(
  worldW: number,
  worldH: number,
  maxEdge = MAX_EDGE,
  areaCap = MAX_AREA,
  want = 1,
): number {
  const byEdge = maxEdge / Math.max(worldW, worldH);
  const byArea = Math.sqrt(areaCap / (worldW * worldH));
  return Math.min(want, byEdge, byArea);
}

/**
 * The area budget for this export, and the one place the probe is reached.
 *
 * Order is the economy of it: work out what the *edge* cap alone would
 * produce, and only ask the engine if that's past the ceiling. Nearly every
 * export costs nothing; the ones asking for 64 megapixels pay one allocation, once.
 */
function areaBudget(worldW: number, worldH: number, maxEdge: number, want = 1): number {
  const byEdge = Math.min(want, maxEdge / Math.max(worldW, worldH));
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
  ink2: string;
  ink3: string;
  paper: string;
  /** A card's face, --paper-card, and the hairline round it. */
  card: string;
  border: string;
  /** The quieter paper a pill or a well sits on. */
  paper2: string;
  rule: string;
  display: string;
  body: string;
  mono: string;
  /** A note's title size and its corner, world units, resolved. */
  noteTitle: number;
  noteRadius: number;
  /** The most a card leans, in degrees - see leanOf(). */
  lean: number;
  /** The underlay's shadows, cards and notes apart, as the twins wear them. */
  shadows: Shadows | null;
  /** A card's corner radius, world units - the resolved --radius. */
  radius: number;
  /** The lattice's two inks, and whether it is drawn as crosses. */
  grid: { minor: string, major: string, harsh: boolean } | null;
  /** The web's own stroke and base weight, in world units. */
  web: { line: string, weight: number } | null;
  /** Whether the paper sheet's outline is drawn, where the board shows one. */
  sheet: boolean;
  grain: number;
};

/** A font stack out of a token, with a stack the canvas will certainly resolve. */
const fontOf = (name: string, fallback: string) =>
  readToken(name) || fallback;

/** One layer of a CSS box-shadow, lengths in world units. */
export type ShadowLayer = { color: string, x: number, y: number, blur: number, spread: number };

type Shadows = {
  card: ShadowLayer[];
  note: ShadowLayer[];
  /** The twins' corner radii, world units: --radius and --note-radius. */
  radius: number;
  noteRadius: number;
};

/**
 * A computed box-shadow as its layers. Exported for the test.
 *
 * Layers are split on the commas outside parentheses, since a colour function
 * has commas of its own in some engines. The colour is whatever the engine
 * computed - `rgb()`, `color(srgb ...)`, a keyword - and is handed to the
 * canvas as it came; this used to accept `rgba()` alone, and Chromium writes a
 * `color-mix()` token back as `color(srgb ...)`, so every export came out
 * with no shadows at all. Inset layers are dropped: nothing here casts inward.
 */
export function parseShadows(value: string): ShadowLayer[] {
  if (!value || value === 'none') return [];
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  parts.push(value.slice(start));
  return parts.flatMap(part => {
    if (/\binset\b/.test(part)) return [];
    const color = part.match(/[a-z-]+\([^()]*\)/i)?.[0] ?? part.match(/\b(transparent|black|white)\b/i)?.[0];
    if (!color) return [];
    // offset-x, offset-y, blur, spread - the order computed values use.
    const n = [...part.replace(color, '').matchAll(/(-?[\d.]+)px/g)].map(m => +m[1]);
    if (n.length < 2) return [];
    return [{ color, x: n[0], y: n[1], blur: n[2] || 0, spread: n[3] || 0 }];
  });
}

/**
 * The shadows the underlay draws, resolved through the browser rather than
 * parsed as tokens.
 *
 * `--item-shadow` and `--note-shadow` are `color-mix()` stacks, and
 * getPropertyValue hands a custom property back unresolved - so each is set
 * as a real `box-shadow` on a real element and the *computed* value read
 * back. The radii the same way, through `border-radius`. These are the tokens
 * `.item-shadow` wears in canvas.css; the export used to read `--shadow-1`, a
 * different and much fainter shadow. Null at the whimsy tiers where both are
 * `none`.
 */
function readShadows(): Shadows | null {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:100px;height:100px';
  document.body.appendChild(probe);
  const read = (shadow: string, radius: string) => {
    probe.style.boxShadow = `var(${shadow})`;
    probe.style.borderRadius = `var(${radius})`;
    const cs = getComputedStyle(probe);
    return { layers: parseShadows(cs.boxShadow), radius: parseFloat(cs.borderTopLeftRadius) || 0 };
  };
  const card = read('--item-shadow', '--radius');
  const note = read('--note-shadow', '--note-radius');
  probe.remove();
  if (!card.layers.length && !note.layers.length) return null;
  return { card: card.layers, note: note.layers, radius: card.radius, noteRadius: note.radius };
}

/** A length token resolved to world units, the way readShadows() resolves it. */
function readLength(value: string, prop: 'borderRadius' | 'fontSize' = 'borderRadius'): number {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:100px;height:100px';
  probe.style[prop] = value;
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const r = parseFloat(prop === 'fontSize' ? cs.fontSize : cs.borderTopLeftRadius) || 0;
  probe.remove();
  return r;
}

const readRadius = () => readLength('var(--radius)');

/**
 * Whether the board leans its cards at all right now - the question the
 * export box asks before offering to stand them up.
 */
export const boardTilts = () => maxLean() > 0;

/** Whether the board's cards cast shadows at this look - some whimsy tiers draw none. */
export const boardShadows = () => readShadows() !== null;

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

/**
 * Six of these read an option as well as the board's own setting, and the
 * `&&` is the rule: the box can leave a mark out, never put one in that the
 * board is not wearing. A thumbnail asks none of them - it is the board's
 * portrait rather than anybody's export, so it keeps the settings alone.
 */
function readLook(detail: Detail, opts: ExportOpts): Look {
  const full = detail === 'full';
  const grain = parseFloat(readToken('--grain'));
  return {
    detail,
    ink: readToken('--ink') || '#222',
    ink2: readToken('--ink-2') || '#555',
    ink3: readToken('--ink-3') || '#8a8578',
    paper: readToken('--paper') || '#f4f1ea',
    card: readToken('--paper-card') || readToken('--paper-2') || '#fbfaf6',
    border: readToken('--item-border') || readToken('--rule') || '#d8d3c6',
    paper2: readToken('--paper-2') || '#e9e5db',
    rule: readToken('--rule-2') || '#d8d3c6',
    display: fontOf('--font-display', 'system-ui, sans-serif'),
    body: fontOf('--font-body', 'system-ui, sans-serif'),
    mono: fontOf('--font-mono', 'ui-monospace, Consolas, monospace'),
    // cards.css's --note-t-title, which is declared on the note itself.
    noteTitle: readLength('calc(var(--t-title) * 0.76)', 'fontSize') || 17,
    noteRadius: readLength('var(--note-radius)'),
    lean: full && opts.tilt ? maxLean() : 0,
    shadows: full && opts.shadows ? readShadows() : null,
    radius: readRadius(),
    grid: full && opts.grid && board.settings.grid ? {
      minor: readToken('--grid-minor') || 'rgba(0,0,0,0.08)',
      major: readToken('--grid-major') || 'rgba(0,0,0,0.14)',
      // harshGrid(), not a bare '2': the crosses tier is canvas/grid.ts's
      // constant, not a second spelling of it here.
      harsh: harshGrid(),
    } : null,
    web: full && opts.web && board.settings.web ? {
      line: readToken('--web-line') || '#9a9384',
      weight: parseFloat(readToken('--web-weight')) || 2,
    } : null,
    sheet: full ? opts.sheet : true,
    grain: full && opts.grain && Number.isFinite(grain) ? grain : 0,
  };
}

/**
 * How far a card is turned on the canvas, in degrees: its own rotation, then
 * the lean it's resting at - both in the canvas's y-down sense, so item.rot
 * is negated where the lean (a CSS rotation) already matches.
 */
const turnOf = (it: Item, look: Look) =>
  -(it.rot || 0) + (it.type === 'fence' ? 0 : tiltOf(it.id) * look.lean);

/**
 * Whether a card casts a shadow. Not a sticker or a fence - a mark pressed
 * onto the board and a line drawn round part of it, neither a thing lying on
 * top. Nor a cut-out, which has no card to cast one (and without this check
 * grew a border and shadow back on export - a bug seen only by whoever prints
 * one). Nor a sticky at low opacity, which the board draws with no shadow twin
 * (noTwin() in canvas/items.ts).
 */
const casts = (it: Item) => it.type !== 'sticker' && it.type !== 'fence'
  && it.meta?.bare !== true && !(it.type === 'note' && itemFaded(it));

/**
 * Every card's shadow, before any card - the board's own underlay.
 *
 * On the board the shadows are twins in #item-shadows, one layer below every
 * card, so no shadow ever falls across the face of a card behind; hanging the
 * shadow on each card as it was drawn got that wrong, and also cast a shadow
 * from every text line and plate inside the card. So this is its own pass,
 * and each twin is what canvas.css makes it: a rounded box the card's size,
 * turned as the card is, wearing every layer of the shadow stack.
 *
 * A canvas shadow belongs to whatever shape is filled, so the shape is filled
 * far off the canvas and its shadow thrown back onto it - the usual way to get
 * a shadow without its shape, and the only way to honour a *spread*, which
 * the negative-spread layers of --item-shadow lean on. The throw is worked out
 * through the current transform because shadow offsets ignore it, where a
 * twin's box-shadow turns with the twin.
 */
function paintShadows(
  ctx: CanvasRenderingContext2D, look: Look, items: Item[], project: Project, scale: number,
  W: number, H: number,
) {
  const s = look.shadows;
  if (!s) return;
  const away = (W + H) * 2 + 1000;
  for (const it of items) {
    if (!casts(it)) continue;
    const note = it.type === 'note';
    const layers = note ? s.note : s.card;
    if (!layers.length) continue;
    const r0 = (note ? s.noteRadius : s.radius) * scale;
    const w = it.w * scale;
    const h = cardHeight(it, w, it.h * scale);
    const at = project(it.x, it.y);
    ctx.save();
    ctx.translate(at.x, at.y);
    const turn = turnOf(it, look);
    if (turn) ctx.rotate(turn * Math.PI / 180);
    const m = ctx.getTransform();
    ctx.fillStyle = '#000';
    for (const layer of layers) {
      const spread = layer.spread * scale;
      const bw = w + spread * 2;
      const bh = h + spread * 2;
      if (!(bw > 0 && bh > 0)) continue;
      const lx = layer.x * scale + away;
      const ly = layer.y * scale;
      ctx.shadowColor = layer.color;
      ctx.shadowBlur = layer.blur * scale;
      ctx.shadowOffsetX = m.a * lx + m.c * ly;
      ctx.shadowOffsetY = m.b * lx + m.d * ly;
      roundRect(ctx, -bw / 2 - away, -bh / 2, bw, bh, Math.max(0, r0 + spread));
      ctx.fill();
    }
    ctx.restore();
  }
}

/** Clear pixels round a staged card, so its edge is sampled against nothing. */
const STAGE_PAD = 2;
/** How much larger a turned card is staged than it is drawn, and the most pixels that may cost. */
const STAGE_OVER = 2;
const STAGE_MAX = 16_000_000;

/**
 * Size the stage - the canvas a turned card is painted upright on, one per
 * render so a preview still drawing cannot paint into an export's - for a
 * w x h card, which clears it, and hand back a context whose origin is the
 * card's centre, as a painter expects. Null if the engine will not give one.
 */
function setStage(stage: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  // Whole pixels either side of the centre, so the centre is where the
  // painter and drawImage() both think it is.
  stage.width = Math.ceil(w / 2 + STAGE_PAD) * 2;
  stage.height = Math.ceil(h / 2 + STAGE_PAD) * 2;
  const sctx = stage.getContext('2d');
  sctx?.translate(stage.width / 2, stage.height / 2);
  return sctx;
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
  drawing: paintDrawing,
  board: paintBoardCard,
  swatch: paintSwatch,
  fence: paintFence,
  note: paintNote,
  title: paintTitle,
  link: paintLink,
  text: paintText,
};

/**
 * A board inside this one, as renderers.ts board() draws it: the child's
 * picture in a window on the card, its name along the foot. With no picture
 * yet, the named card every file without one gets.
 */
async function paintBoardCard(p: Paint) {
  const { ctx, it, w, h, look, scale } = p;
  const img = await loadImage(childFace(childOf(it))?.thumb ?? null);
  if (!img) return paintMedia(p);
  ctx.save();
  cardFace(ctx, w, h, look, scale);
  const pad = 8 * scale;
  const size = Math.max(9, 13 * scale);
  const foot = size * 1.8;
  const pw = w - 2 * pad, ph = h - pad - foot;
  ctx.save();
  roundRect(ctx, -w / 2 + pad, -h / 2 + pad, pw, ph, Math.min(look.radius * scale * 0.5, pw / 2, ph / 2));
  ctx.clip();
  // Contained, centred in the window, as the card's object-fit does it.
  const k = Math.min(pw / img.naturalWidth, ph / img.naturalHeight);
  const iw = img.naturalWidth * k, ih = img.naturalHeight * k;
  ctx.drawImage(img, -iw / 2, -h / 2 + pad + (ph - ih) / 2, iw, ih);
  ctx.restore();
  if (look.detail === 'full') {
    ctx.fillStyle = look.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `500 ${size}px ${look.display}`;
    ctx.fillText((it.name || 'Untitled board').slice(0, 120), 0, h / 2 - foot / 2, pw);
  }
  ctx.restore();
}

/**
 * A drawing: the same outlines its card draws (canvas/drawing.ts), through
 * Path2D, highlighters first and multiplied - screened on a dark board, as
 * cards.css does it. No card under them, as there is none on the board.
 */
function paintDrawing({ ctx, it, w, h }: Paint) {
  const { strokes, space } = readDrawing(it.meta);
  const k = Math.min(w / space[0], h / space[1]);
  const tier = currentTier();
  const dark = document.documentElement.dataset.scheme === 'dark';
  ctx.save();
  ctx.scale(k, k);
  ctx.translate(-space[0] / 2, -space[1] / 2);
  for (const pass of ['highlighter', 'pen'] as const) {
    for (const s of strokes) {
      if (s.tool !== pass) continue;
      const o = outline(s, tier);
      if (!o.d) continue;
      const ink = readToken(INK_VAR[s.ink]) || '#31261b';
      ctx.globalAlpha = pass === 'highlighter' ? 0.4 : 1;
      ctx.globalCompositeOperation = pass === 'highlighter' ? (dark ? 'screen' : 'multiply') : 'source-over';
      const path = new Path2D(o.d);
      if (o.kind === 'fill') {
        ctx.fillStyle = ink;
        ctx.fill(path);
      } else {
        ctx.strokeStyle = ink;
        ctx.lineWidth = o.width;
        ctx.lineCap = o.cap;
        ctx.lineJoin = o.join;
        ctx.stroke(path);
      }
    }
  }
  ctx.restore();
}

/**
 * A card's own face, as items.css draws one: --paper-card, a hairline of
 * --item-border inside the edge, and the tier's corner - square at Harsh.
 */
function cardFace(ctx: CanvasRenderingContext2D, w: number, h: number, look: Look, scale: number) {
  const r = Math.min(look.radius * scale, w / 2, h / 2);
  ctx.fillStyle = look.card;
  roundRect(ctx, -w / 2, -h / 2, w, h, r);
  ctx.fill();
  const hair = Math.max(1, scale);
  ctx.strokeStyle = look.border;
  ctx.lineWidth = hair;
  roundRect(ctx, -w / 2 + hair / 2, -h / 2 + hair / 2, w - hair, h - hair, Math.max(0, r - hair / 2));
  ctx.stroke();
}

/** Clip to a card's face, for what is written on it. */
function clipFace(ctx: CanvasRenderingContext2D, w: number, h: number, look: Look, scale: number) {
  roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(look.radius * scale, w / 2, h / 2));
  ctx.clip();
}

/**
 * The height of the card an item draws, in the units `h` is in. Only the title
 * differs: a 3:2 card centred in an item box that snapping can make taller
 * (canvas.css .title-card), so its shadow and paper are that card, not the box.
 */
const cardHeight = (it: Item, w: number, h: number) =>
  it.type === 'title' ? Math.min(h, w * 2 / 3) : h;

/** The board's name as the title card sets it - lines, face, size, placement. */
type TitleSet = {
  lines: string[];
  font: string;
  color: string;
  opacity: number;
  /** Letter spacing and line height as fractions of the font size. */
  tracking: number;
  leading: number | null;
  /** Font size as a fraction of the card's width. */
  size: number;
  stretch: number;
  offset: number;
};

/**
 * The name's lines as the card on screen broke them, read out of the layout.
 *
 * The live name wraps with `text-wrap: balance`, which a canvas has no way to
 * reproduce by measuring - its answer is the browser's. So the characters are
 * walked with a Range and a new line starts wherever the next one drops by
 * more than half a line; that holds on a leaning card, whose lines slope by
 * far less than that across the card.
 */
function liveLines(node: HTMLElement): string[] | null {
  const text = node.firstChild;
  if (!(text instanceof Text) || !text.data) return null;
  const range = document.createRange();
  const lines: string[] = [];
  let line = '';
  let top = NaN;
  for (let i = 0; i < text.data.length; i++) {
    range.setStart(text, i);
    range.setEnd(text, i + 1);
    const r = range.getBoundingClientRect();
    if (r.height > 0 && Number.isFinite(top) && r.top - top > r.height / 2) {
      lines.push(line.trim());
      line = '';
    }
    if (r.height > 0 && (!Number.isFinite(top) || r.top - top > r.height / 2)) top = r.top;
    line += text.data[i];
  }
  if (line.trim()) lines.push(line.trim());
  // The card clamps at four rows (-webkit-line-clamp).
  return lines.slice(0, 4);
}

/**
 * Everything about the name's setting that the style panel decides, read off
 * the mounted card's computed style - ui/mobile-header.ts writes the face,
 * weight, axes and dials inline, and resolving them any other way would be a
 * second copy of that module. Null when the card is not mounted (culled, or a
 * Feed board, which has no title card), and the painter falls back to the
 * stylesheet's defaults.
 */
function readTitleSet(it: Item): TitleSet | null {
  const node = document.querySelector<HTMLElement>(`.item[data-id="${CSS.escape(it.id)}"] .title-name`);
  const card = node?.parentElement;
  if (!node || !card || !(card.offsetWidth > 0)) return null;
  const cs = getComputedStyle(node);
  const px = parseFloat(cs.fontSize) || 0;
  if (!(px > 0)) return null;
  const lines = liveLines(node);
  if (!lines?.length) return null;
  const lh = parseFloat(cs.lineHeight);
  const ls = parseFloat(cs.letterSpacing);
  return {
    lines,
    font: `${cs.fontStyle} ${cs.fontWeight} {SIZE}px ${cs.fontFamily}`,
    color: cs.color,
    opacity: parseFloat(cs.opacity) || 1,
    tracking: Number.isFinite(ls) ? ls / px : 0,
    leading: Number.isFinite(lh) ? lh / px : null,
    size: px / card.offsetWidth,
    stretch: parseFloat(cs.getPropertyValue('--mobile-title-stretch')) || 1,
    offset: parseFloat(cs.getPropertyValue('--mobile-title-offset')) || 0,
  };
}

/**
 * The title card: the board's name on a 3:2 card of paper.
 *
 * It fell through to paintMedia() before, which looks for a picture and then
 * for the item's `name` - a title item has neither, its words being
 * board.title - so every export carried an empty box where the name was.
 * Drawn to canvas.css: centred 3:2 card, --paper-card with a hairline, the
 * name centred in it with the masthead's padding (0.2em over, 0.45em under),
 * nudged by the offset and stretched by the height dial about 50% 52%.
 */
function paintTitle({ ctx, it, w, h, look, scale }: Paint) {
  const ch = cardHeight(it, w, h);
  const r = Math.min(look.radius * scale, w / 2, ch / 2);
  ctx.save();
  cardFace(ctx, w, ch, look, scale);
  if (look.detail !== 'full' || !board.title) { ctx.restore(); return; }

  roundRect(ctx, -w / 2, -ch / 2, w, ch, r);
  ctx.clip();
  const set = readTitleSet(it);
  const size = (set?.size ?? 0.13) * w;
  ctx.font = set ? set.font.replace('{SIZE}', String(size)) : `700 ${size}px ${look.display}`;
  ctx.fillStyle = set?.color ?? look.ink;
  ctx.globalAlpha = set?.opacity ?? 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(set?.tracking ?? 0) * size}px`;
  const lines = set?.lines ?? [board.title];
  const m = ctx.measureText('Hg');
  const ascent = m.fontBoundingBoxAscent || size * 0.8;
  const descent = m.fontBoundingBoxDescent || size * 0.2;
  // `line-height: normal` is the face's own ascent and descent.
  const lh = set?.leading ? set.leading * size : ascent + descent;
  const boxH = lines.length * lh + size * 0.65;
  const boxTop = -boxH / 2;
  ctx.translate(0, ch * (set?.offset ?? 0) / 100);
  const origin = boxTop + boxH * 0.52;
  ctx.translate(0, origin);
  ctx.scale(1, set?.stretch ?? 1);
  ctx.translate(0, -origin);
  const half = (lh - ascent - descent) / 2;
  lines.forEach((line, i) => {
    ctx.fillText(line, 0, boxTop + size * 0.2 + i * lh + half + ascent);
  });
  ctx.restore();
}

const painterFor = (it: Item): Painter => PAINTERS[it.type] || paintMedia;

/**
 * One card. An export on an engine that can (canCapture() in ui/capture.ts:
 * Chromium) draws the card from its own DOM; a thumbnail, Safari, Firefox, a
 * sticker, a model or a card whose capture failed gets its painter.
 */
async function drawCard(p: Paint) {
  if (p.look.detail === 'full' && await drawCaptured(p.ctx, p.it, p.w, p.h)) return;
  await painterFor(p.it)(p);
}

/** A swatch: a card holding a rounded chip of the colour, and its hex under it. */
function paintSwatch({ ctx, it, w, h, look, scale }: Paint) {
  const hex = typeof it.meta?.hex === 'string' && it.meta.hex ? it.meta.hex : '#888888';
  ctx.save();
  cardFace(ctx, w, h, look, scale);
  const pad = Math.min(w, h) * 0.08;
  const label = look.detail === 'full' ? Math.min(h * 0.22, 12 * scale * 1.9) : 0;
  ctx.fillStyle = hex;
  roundRect(ctx, -w / 2 + pad, -h / 2 + pad, w - pad * 2, h - pad * 2 - label,
    Math.max(0, Math.min(look.radius * scale, w / 2, h / 2) - pad / 2));
  ctx.fill();
  if (label) {
    ctx.fillStyle = look.ink2;
    ctx.font = `500 ${label * 0.55}px ${look.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(hex.toUpperCase(), 0, h / 2 - pad / 2 - label / 2, w - pad * 2);
  }
  ctx.restore();
}

/** The site's own name out of an address - www. and the scheme gone. */
const hostOf = (url: unknown) => {
  try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return ''; }
};

/**
 * A link: its picture when it has one; otherwise the card as cards.css draws
 * it - the site's name set large and faint across the face, and a pill at
 * the foot with a globe and the domain.
 */
async function paintLink(p: Paint) {
  if (pixelHash(p.it)) { await paintMedia(p); return; }
  const { ctx, it, w, h, look, scale } = p;
  const host = hostOf(it.meta?.url) || (it.name || '').trim();
  ctx.save();
  cardFace(ctx, w, h, look, scale);
  if (look.detail !== 'full' || !host) { ctx.restore(); return; }
  clipFace(ctx, w, h, look, scale);
  const word = host.split('.').slice(-2, -1)[0] || host;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = Math.min(h * 0.38, w * 0.9);
  ctx.font = `700 ${size}px ${look.display}`;
  const wide = ctx.measureText(word).width;
  if (wide > w * 0.86) size *= w * 0.86 / wide;
  ctx.font = `700 ${size}px ${look.display}`;
  ctx.fillStyle = look.ink;
  ctx.globalAlpha = 0.1;
  ctx.fillText(word, 0, -h * 0.06);
  ctx.globalAlpha = 1;
  const t = Math.min(12 * scale, h * 0.09);
  ctx.font = `500 ${t}px ${look.body}`;
  const label = host.length > 40 ? host.slice(0, 39) + '…' : host;
  const pillW = Math.min(w * 0.86, ctx.measureText(label).width + t * 3.2);
  const pillH = t * 2;
  const py = h / 2 - pillH - t * 0.9;
  ctx.fillStyle = look.paper2;
  roundRect(ctx, -pillW / 2, py, pillW, pillH, pillH / 2);
  ctx.fill();
  // The globe: a circle, its equator and one meridian.
  const gx = -pillW / 2 + t * 1.15, gy = py + pillH / 2, gr = t * 0.42;
  ctx.strokeStyle = look.ink2;
  ctx.lineWidth = Math.max(0.75, t * 0.09);
  ctx.beginPath();
  ctx.arc(gx, gy, gr, 0, Math.PI * 2);
  ctx.moveTo(gx - gr, gy);
  ctx.lineTo(gx + gr, gy);
  ctx.moveTo(gx + gr * 0.45, gy - gr * 0.9);
  ctx.ellipse(gx, gy, gr * 0.45, gr, 0, -Math.PI / 2, Math.PI * 1.5);
  ctx.stroke();
  ctx.fillStyle = look.ink2;
  ctx.textAlign = 'left';
  ctx.fillText(label, gx + gr + t * 0.5, gy, pillW - t * 2.4);
  ctx.restore();
}

/**
 * A text file: its name, and then the file's own words in the mono face, as
 * far down the card as they go. A Markdown or CSV file is rendered on the
 * board; here it is its source, which says the same and asks no second engine.
 */
async function paintText(p: Paint) {
  const { ctx, it, w, h, look, scale } = p;
  ctx.save();
  cardFace(ctx, w, h, look, scale);
  if (look.detail !== 'full') { ctx.restore(); return; }
  clipFace(ctx, w, h, look, scale);
  const pad = Math.min(14 * scale, Math.min(w, h) * 0.1);
  const name = (it.name || '').trim();
  let y = -h / 2 + pad;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  if (name) {
    const size = 13 * scale;
    ctx.fillStyle = look.ink;
    ctx.font = `600 ${size}px ${look.display}`;
    ctx.fillText(name, -w / 2 + pad, y, w - pad * 2);
    y += size * 1.7;
  }
  const blob = it.asset?.hash ? getAsset(it.asset.hash)?.blob : null;
  let body = '';
  try { body = blob ? await blob.slice(0, 4096).text() : ''; } catch { body = ''; }
  if (body) {
    const size = 10.5 * scale;
    ctx.fillStyle = look.ink2;
    ctx.font = `400 ${size}px ${look.mono}`;
    const lh = size * 1.45;
    wrapText(ctx, body.replace(/\r/g, '').replace(/\t/g, '  '), w - pad * 2, lh,
      { x: -w / 2 + pad, y, lines: Math.floor((h / 2 - pad - y) / lh) });
  }
  ctx.restore();
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
  roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(look.noteRadius * scale, w / 2, h / 2));
  // Low opacity: the paper at 60% and the words solid, as cards.css draws it.
  const alpha = ctx.globalAlpha;
  if (itemFaded(it)) ctx.globalAlpha = alpha * 0.6;
  ctx.fill();
  ctx.globalAlpha = alpha;
  if (look.detail !== 'full') return;

  // The lines as the note sets them (cards.css .note-rich): its face, a title
  // size and a body size scaled by each line's own step, title lines in ink
  // and the rest in ink-2, 8px between lines, placed top, middle or bottom.
  // One style a line - its first run's - rather than a second text engine.
  const rich = normalizeNoteRich(isRecord(it.meta?.rich) ? it.meta.rich : null, it.meta?.text ?? noteWords(it.meta));
  const lines = richLines(rich).map(runs => ({
    text: runs.map(r => r.text).join(''),
    title: runs.length > 0 && runs.every(r => r.title),
    font: runs[0]?.font ?? rich.font,
    size: runs[0]?.size ?? rich.size,
  })).filter((l, i, all) => l.text.trim() || (i > 0 && i < all.length - 1));
  if (!lines.some(l => l.text.trim())) return;
  const faceOf = (f: NoteFont) => (f === 'sheet' ? look.display : NOTE_FONTS[f]);
  // --note-pad: a sixth of half the shorter side, between 9 and 20.
  const pad = Math.min(20, Math.max(9, Math.min(it.w, it.h) / 2 * 0.167)) * scale;
  const maxW = w - pad * 2;
  ctx.save();
  roundRect(ctx, -w / 2, -h / 2, w, h, 0);
  ctx.clip();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const set = lines.map(l => {
    const px = (l.title ? look.noteTitle : 13) * l.size * scale;
    const font = `${l.title ? 700 : 400} ${px}px ${faceOf(l.font)}`;
    ctx.font = font;
    const rows: string[] = [];
    for (const para of l.text.split('\n')) {
      let row = '';
      for (const word of para.split(/(\s+)/)) {
        const trial = row + word;
        if (row.trim() && ctx.measureText(trial).width > maxW) { rows.push(row.trimEnd()); row = word.trimStart(); }
        else row = trial;
      }
      rows.push(row);
    }
    return { ...l, font, px, lh: px * (l.title ? 1.2 : 1.4), rows };
  });
  const gap = 8 * scale;
  const total = set.reduce((n, l) => n + l.rows.length * l.lh, 0) + gap * (set.length - 1);
  const room = h - pad * 2;
  let y = -h / 2 + pad + (rich.valign === 'middle' ? Math.max(0, (room - total) / 2)
    : rich.valign === 'bottom' ? Math.max(0, room - total) : 0);
  for (const l of set) {
    ctx.font = l.font;
    ctx.fillStyle = l.title ? look.ink : look.ink2;
    for (const row of l.rows) {
      if (y + l.lh > h / 2 - pad + l.lh * 0.25) break;
      ctx.fillText(row, -w / 2 + pad, y + (l.lh - l.px) / 2, maxW);
      y += l.lh;
    }
    y += gap;
  }
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
    // The tier's corner, square at Harsh, as every card wears it.
    const radius = Math.min(look.radius * scale, w / 2, h / 2);
    ctx.save();
    if (!bare) {
      roundRect(ctx, -w / 2, -h / 2, w, h, radius);
      ctx.clip();
    }
    const contain = fitMode(it) === 'contain';
    // A Softish print: the card is the mat, and the picture sits in a window
    // above the chin - the same cut quality.css makes, off the same numbers.
    const print = isPrint(it);
    const m = Math.min(w, h);
    const mat = print ? PRINT_MAT * m : 0, chin = print ? PRINT_CHIN * m : 0;
    const pw = w - 2 * mat, ph = h - mat - chin;
    // The card behind a print or a contained picture, so letterboxed bands are
    // the card, not a hole. Never behind a cut-out - those bands are the empty
    // rectangle it exists to remove.
    if ((print || contain) && !bare) {
      ctx.fillStyle = look.card;
      ctx.fillRect(-w / 2, -h / 2, w, h);
    }
    ctx.translate(0, (mat - chin) / 2);
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
    const bw = quarter ? ph : pw, bh = quarter ? pw : ph;
    // The letterbox as the board draws it where blur is on: the picture again,
    // blurred and dimmed, under the whole one (.pic-well in items.css).
    if (contain && !bare && look.detail === 'full') {
      ctx.save();
      ctx.beginPath();
      ctx.rect(-bw / 2, -bh / 2, bw, bh);
      ctx.clip();
      ctx.filter = `blur(${m * 0.06}px) brightness(0.72) saturate(1.1)`;
      drawFitted(ctx, img, it, bw * 1.3, bh * 1.3, 'cover');
      ctx.restore();
    }
    const filter = look.detail === 'full' ? adjustFilter(it) : null;
    if (filter) ctx.filter = filter;
    drawFitted(ctx, img, it, bw, bh);
    if (filter) ctx.filter = 'none';
    ctx.restore();
    // A print's name is on its chin. Every other picture's plate shows only
    // under the pointer (media.css), so a still picture of the board has none.
    if (look.detail === 'full' && print) printCaption(ctx, it, w, h, chin, look, scale);
    return;
  }

  // No picture: a card face with its name, which covers audio without art,
  // archives and any named file card.
  ctx.save();
  cardFace(ctx, w, h, look, scale);
  const label = (it.name || '').slice(0, 120);
  if (!label) { ctx.restore(); return; }
  clipFace(ctx, w, h, look, scale);
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
 * A print's name, written on its chin as the board writes it there: centred,
 * no plate (quality.css, the .item-label rule at Softish).
 */
function printCaption(
  ctx: CanvasRenderingContext2D, it: Item, w: number, h: number, chin: number,
  look: Look, scale: number,
) {
  const name = (it.name || '').trim();
  if (!name) return;
  const m = Math.min(w, h);
  const size = Math.min(Math.max(11 * scale, m * 0.045), 20 * scale);
  if (size < 5) return;
  ctx.save();
  ctx.fillStyle = look.ink;
  ctx.font = `500 ${size}px ${look.display}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, 0, h / 2 - chin / 2, w - 2 * PRINT_MAT * m);
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
  mode = fitMode(it),
) {
  const { src, iw, ih } = img;
  if (!iw || !ih) return;
  const crop = img.cropped ? null : itemCrop(it);
  const sx0 = crop ? crop.x * iw : 0;
  const sy0 = crop ? crop.y * ih : 0;
  const sw0 = crop ? crop.w * iw : iw;
  const sh0 = crop ? crop.h * ih : ih;

  if (mode === 'contain') {
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
  // A sheet put away is not in the picture either — `paper` still names a size
  // while it is down, so the id alone no longer answers this. Nor is one the
  // export box was asked to leave out (look.sheet).
  const mm = s.paperShow && look.sheet ? paperMm(s.paper, s.paperLandscape) : null;
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
 * The paper's texture - the board's own tile, laid the way the board lays it.
 *
 * It used to be a speckle invented here, random flecks over everything,
 * which looked like static and nothing like the embossed stock on screen.
 * So this restates base.css's `#grain` rule rather than imitating its look:
 * the same image, TILE world units square and anchored at the world origin
 * (canvas/grain.ts), multiplied in at 0.8 x --grain. And it is drawn where
 * the layer sits - on the ground, under the lattice and every card, since
 * #grain comes before #viewport in index.html and neither has a z-index.
 *
 * The image's address is read off the live layer's computed style, so the
 * stylesheet stays the one place it is written and the bundle's location
 * never enters into it.
 */
const GRAIN_TILE = 512;   // world units - canvas/grain.ts's TILE, base.css's 512px
const GRAIN_ALPHA = 0.8;  // base.css: opacity calc(0.8 * var(--grain) ...)

async function paintGrain(
  ctx: CanvasRenderingContext2D, look: Look, project: Project, scale: number, W: number, H: number,
) {
  const strength = look.grain * GRAIN_ALPHA;
  if (!(strength > 0.002)) return;
  const layer = document.getElementById('grain');
  const url = layer ? getComputedStyle(layer).backgroundImage.match(/url\(["']?([^"')]+)["']?\)/)?.[1] : null;
  const img = await loadImage(url ?? null);
  if (!img || !img.naturalWidth) return;
  const pattern = ctx.createPattern(img, 'repeat');
  if (!pattern) return;
  const at = project(0, 0);
  const k = (GRAIN_TILE * scale) / img.naturalWidth;
  pattern.setTransform(new DOMMatrix([k, 0, 0, k, at.x, at.y]));
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = Math.min(1, strength);
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// The render
// ---------------------------------------------------------------------------

/** Everything about the picture that is arithmetic, settled before a canvas exists. */
type Plan = {
  items: Item[];
  /** The items' own bounding box, before the margin. */
  b: { x0: number, y0: number, x1: number, y1: number };
  /** The clear frame around them, in world units. */
  margin: number;
  /** Canvas pixels per world unit, after both ceilings. */
  scale: number;
  w: number;
  h: number;
  /** What `scale` works out as in dots per inch - what was asked for, or less. */
  ppi: number;
};

/**
 * How big this board comes out at these options, and at what resolution.
 *
 * Pulled out of the render so the export box can show the answer beside the
 * controls without drawing anything, and so the two can never disagree about
 * it. Null when the board is empty, which is what both callers do nothing on.
 */
function planRender(detail: Detail, opts: ExportOpts, maxEdge: number): Plan | null {
  const only = opts.only ? new Set(opts.only) : null;
  // The lines follow: paintWeb() draws a connection only between two of these.
  const items = only ? drawable().filter(i => only.has(i.id)) : drawable();
  const b = itemBounds(items);
  if (!b) return null;

  // A thumbnail keeps the old flat margin and the old question - draw the
  // board at its own size, shrunk to fit. An export measures both in the
  // world: a margin in millimetres of board, a scale in dots per inch of it.
  const full = detail === 'full';
  const margin = full ? toUnits(Math.max(0, opts.margin), board.settings.scale) : MARGIN;
  const worldW = (b.x1 - b.x0) + margin * 2;
  const worldH = (b.y1 - b.y0) + margin * 2;
  const want = full ? pixelsPerUnit(opts.ppi, board.settings.scale) : 1;
  const scale = exportScale(worldW, worldH, maxEdge, areaBudget(worldW, worldH, maxEdge, want), want);
  return {
    items, b, margin, scale,
    w: Math.max(1, Math.ceil(worldW * scale)),
    h: Math.max(1, Math.ceil(worldH * scale)),
    ppi: ppiOf(scale, board.settings.scale),
  };
}

/**
 * The picture these options would produce, for the box that offers them -
 * pixels, dots per inch, and whether a ceiling took the resolution down.
 * Null on an empty board.
 */
export function exportSize(opts: ExportOpts) {
  const plan = planRender('full', opts, MAX_EDGE);
  if (!plan) return null;
  const want = pixelsPerUnit(opts.ppi, board.settings.scale);
  return {
    w: plan.w,
    h: plan.h,
    ppi: plan.ppi,
    // A hair of slack: `want` and `scale` are the same arithmetic when
    // nothing binds, but only to the last bit of a float.
    capped: plan.scale < want * 0.9999,
  };
}

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
async function renderBoardCanvas(detail: Detail, opts: ExportOpts, maxEdge = MAX_EDGE, cards = true) {
  const plan = planRender(detail, opts, maxEdge);
  if (!plan) return null;
  const { items, b, margin, scale, w: W, h: H } = plan;

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

  const look = readLook(detail, opts);
  const project: Project = (x, y) => ({
    x: ((x - b.x0) + margin) * scale,
    y: ((b.y1 - y) + margin) * scale,
  });

  ctx.fillStyle = look.paper;
  ctx.fillRect(0, 0, W, H);
  // On the ground, under the lattice and the cards - where the layer sits.
  await paintGrain(ctx, look, project, scale, W, H);

  paintGrid(ctx, look, project, {
    x0: b.x0 - margin, y0: b.y0 - margin, x1: b.x1 + margin, y1: b.y1 + margin,
  }, scale);
  paintPaper(ctx, look, project, scale);
  paintWeb(ctx, look, items, project, scale);

  const ordered = [...items].sort((p, q) => (p.z || 0) - (q.z || 0));
  paintShadows(ctx, look, ordered, project, scale, W, H);
  const stage = document.createElement('canvas');
  // `cards` false is the ground alone - everything under the cards, for boardSvg().
  for (const it of cards ? ordered : []) {
    const at = project(it.x, it.y);
    const w = it.w * scale;
    const h = it.h * scale;
    const turn = turnOf(it, look);
    ctx.save();
    ctx.translate(at.x, at.y);
    if (turn) ctx.rotate(turn * Math.PI / 180);
    // A turned card is painted upright on the stage and set down turned, as
    // one picture. Painted straight onto the turned canvas, each of its layers
    // - the photograph, the plate across its foot - clipped and smoothed the
    // same slanted edge separately, and the paper showed through between them
    // as a pale fringe. A sticker is one fill and a fence one stroke, with no
    // layers to part, so both still draw directly.
    //
    // Staged at twice the size and brought down as it is turned: at 1:1 the
    // turn is a second resampling on top of the painter's own, and a
    // photograph's lettering went visibly soft. Halving while turning is a
    // downsample, which keeps it. Not past STAGE_MAX, where it stays 1:1.
    const stageIt = turn && it.type !== 'sticker' && it.type !== 'fence' && w >= 1 && h >= 1;
    const k = stageIt && w * h * STAGE_OVER * STAGE_OVER <= STAGE_MAX ? STAGE_OVER : 1;
    const sctx = stageIt ? setStage(stage, w * k, h * k) : null;
    if (sctx) {
      await drawCard({ ctx: sctx, it, w: w * k, h: h * k, look, scale: scale * k });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(stage, -stage.width / 2 / k, -stage.height / 2 / k, stage.width / k, stage.height / k);
    } else {
      await drawCard({ ctx, it, w, h, look, scale });
    }
    ctx.restore();
  }
  // Let go of the stage's pixels - a card at 300 ppi can be tens of megabytes.
  stage.width = stage.height = 0;

  return { canvas, w: W, h: H, ppi: plan.ppi };
}

/**
 * The board as 4:4:4 JPEG bytes, or null. Through ui/jpeg.ts rather than
 * toBlob() for the sampling - see EXPORT_DEFAULTS - with the ppi written into
 * the file so it opens at the size it was drawn for.
 */
async function boardJpeg(opts: ExportOpts) {
  const shot = await renderBoardCanvas('full', opts);
  const ctx = shot?.canvas.getContext('2d');
  if (!shot || !ctx) return null;
  const bytes = await encodeJpeg(ctx.getImageData(0, 0, shot.w, shot.h),
    { quality: opts.quality * 100, ppi: shot.ppi });
  return { bytes, w: shot.w, h: shot.h, ppi: shot.ppi };
}

/**
 * The export as the box previews it: the same 'full' render under the same
 * options, held to `maxEdge` so it is quick to redraw on every change. Only
 * the resolution differs from the file - margin, marks, texture and the
 * page's proportions are the real ones. Null on an empty board.
 */
export async function boardPreview(opts: ExportOpts, maxEdge: number) {
  const shot = await renderBoardCanvas('full', opts, maxEdge);
  return shot?.canvas ?? null;
}

/**
 * The board as a JPEG blob, or null.
 *
 * JPEG rather than PNG since the export grew a resolution: an A4 board at
 * 300 ppi is nine megapixels of photographs, and as a PNG that is tens of
 * megabytes for a picture with no transparency in it - the paper is filled
 * first, edge to edge.
 */
export async function boardImage(opts: ExportOpts) {
  const jpeg = await boardJpeg(opts);
  return jpeg ? new Blob([jpeg.bytes], { type: 'image/jpeg' }) : null;
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
  const shot = await renderBoardCanvas('thumb', EXPORT_DEFAULTS, max * 4);
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

/**
 * The board as an SVG file, or null: the ground as one picture at the
 * options' resolution, and every card over it as its own markup
 * (captureCards() in ui/capture.ts) - words stay words, sharp at any zoom and
 * selectable in a browser. A card that cannot be captured, or every card on
 * an engine that cannot capture, is its painter's picture instead. The
 * markup is HTML inside foreignObject, which browsers draw and most drawing
 * programs do not; the export box says so.
 */
export async function boardSvg(opts: ExportOpts) {
  const plan = planRender('full', opts, MAX_EDGE);
  const ground = await renderBoardCanvas('full', opts, MAX_EDGE, false);
  if (!plan || !ground) return null;
  const { items, b, margin, scale } = plan;
  const look = readLook('full', opts);
  const ordered = [...items].sort((p, q) => (p.z || 0) - (q.z || 0));
  const captured = await captureCards(ordered, scale);
  const cards: SvgCard[] = [];
  for (const it of ordered) {
    const at = { x: (it.x - b.x0) + margin, y: (b.y1 - it.y) + margin, w: it.w, h: it.h, turn: turnOf(it, look) };
    const markup = captured?.cards.get(it.id);
    if (markup) { cards.push({ ...at, markup }); continue; }
    // Painted at the export's resolution, upright; the file turns it.
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(it.w * scale));
    c.height = Math.max(1, Math.ceil(it.h * scale));
    const ctx = c.getContext('2d');
    if (!ctx) continue;
    ctx.translate(c.width / 2, c.height / 2);
    await painterFor(it)({ ctx, it, w: c.width, h: c.height, look, scale });
    cards.push({ ...at, picture: c.toDataURL('image/png') });
  }
  const worldW = ground.w / scale, worldH = ground.h / scale;
  const mm = (units: number) => units / clampScale(board.settings.scale);
  const svg = boardSvgText({
    w: worldW, h: worldH, mmW: mm(worldW), mmH: mm(worldH), rootAttrs: rootAttrs(),
    bodyClass: captured?.bodyClass ?? '', css: captured?.css ?? '',
    ground: ground.canvas.toDataURL('image/jpeg', opts.quality), cards,
  });
  return new Blob([svg], { type: 'image/svg+xml' });
}

/** The board as a one-page PDF blob, or null. */
export async function boardPdf(opts: ExportOpts) {
  const jpeg = await boardJpeg(opts);
  return jpeg ? buildPdf(jpeg.bytes, jpeg.w, jpeg.h, jpeg.ppi) : null;
}

/** PostScript points to the inch - the PDF's one unit of length. */
const PT_PER_INCH = 72;

/**
 * A single-page PDF wrapping one JPEG, written by hand.
 *
 * Five objects (catalog, pages, page, image, one-line content stream) plus a
 * cross-reference table. The JPEG rides in verbatim under /DCTDecode, which
 * is why the canvas is encoded as JPEG here and not PNG - a PDF speaks JPEG
 * directly, where PNG would need decoding and re-deflating.
 *
 * The page is the board's real size: `ppi` is the resolution the picture was
 * drawn at, so w/ppi inches across. Before the export had a resolution the
 * page was the pixel count in points, which printed a sheet of A4 drawn at
 * 300 ppi as a poster four times too wide. Exported for the test.
 */
// The buffer is named in the array types below because a Blob part has to be
// one that is not shared: a Uint8Array over a SharedArrayBuffer is not a
// BlobPart, and `Uint8Array` alone leaves which one it is open.
export function buildPdf(jpeg: Uint8Array<ArrayBuffer>, w: number, h: number, ppi: number) {
  // Two decimals of a point is a few thousandths of a millimetre - past it
  // the numbers are noise that some readers print in full.
  const perPx = PT_PER_INCH / (ppi > 0 ? ppi : PT_PER_INCH);
  const pw = +(w * perPx).toFixed(2);
  const ph = +(h * perPx).toFixed(2);
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
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}]`
    + ` /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);

  offsets[4] = len;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h}`
    + ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`
    + ` /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push('\nendstream\nendobj\n');

  // The image XObject is a unit square; this stretches it over the page.
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
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
