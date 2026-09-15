// One renderer per item type: classification, a default size, and the DOM
// that goes inside a card. Adding a new type means one entry in RENDERERS and
// one branch in classify() - nothing else needs to know. note-model.ts (the
// sticky-note model) and poster.ts (the video frame grab) moved out but are
// re-exported below so no caller had to learn they moved.

import { cue } from '../cuelume/engine.ts';
import { extOf, baseName, formatBytes, hasOwn, isRecord } from '../util.ts';
import { shownHash, type Item, type ItemType } from '../board-model.ts';
import { assetURL, getAsset, readText } from '../storage/assets.ts';
import { noPreview } from '../notify.ts';
import {
  byId, bus, markDirty, board, isDefaultTitle, itemCrop, itemRotate, itemMatte,
  setSwatchHex, baseStep, noteDisplay,
} from '../state.ts';
import { bakeDisplayFor } from '../optimize/picture.ts';
import { latticeBox } from '../geometry.ts';
import {
  describeExt, formatName, PHOTO_EXTS, AUDIO_EXTS, VIDEO_EXTS, SVG_EXTS,
} from '../import/formats.ts';
import { registerPlayer } from './audio.ts';
import { buildTransport } from './transport.ts';
import { clock } from '../media/transport.ts';
import { buildVideoPlayer, POSTER_TIME } from './video.ts';
import { rationsDecoders } from './viewport.ts';
import { embedFor, embedFloor, embedOffer } from './embed.ts';
import { brandFor, siteName } from './brands.ts';
import type { Brand } from './brands.ts';
import { buildModelCard } from './model.ts';
import { hintFor, hintKey, tapeStyle, bindDial, STOPS, DIAL } from './ghosts.ts';
import { ensureDisplay, displayURLReady, bakedServes } from './display.ts';
import { meshKind } from '../mesh.ts';
import { faceName, pixelHash, TILE_SWATCHES } from '../style-tile.ts';
import { normalizeNoteRich, applyNoteStyle, buildNoteLine } from './note-model.ts';
import type { NoteRichInput } from './note-model.ts';
import {
  stickerArt, DEFAULT_SHAPE, stickerShape, stickerTint,
} from '../stickers/catalogue.ts';

// The façade: parseNoteText and its two normalisers moved to note-model.ts,
// and tests/renderers.test.js still asks for them here. Named rather than a
// star re-export, for the reason state.ts is - a name that goes missing should
// break loudly at the import, not quietly at runtime.
export {
  parseNoteText, normalizeNoteRich, flattenNoteRich,
} from './note-model.ts';
export { videoFrame, videoDrawsBlank, pictureIsFlat } from './poster.ts';


/** How much of a text file a card shows - readText()'s own default. Past this
 *  the body is marked clipped, so the card says so instead of looking whole. */
const TEXT_PREVIEW = 20000;

/** A meta value read as the string it's meant to be, or ''. `meta` is unknown
 *  per key on purpose (ItemMeta in board-model.ts); narrowed once here, to ''
 *  rather than null so the `||` chains below still read. */
const metaStr = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A card's box in world units - what defaultSize() and fitToBox() answer. */
export type Size = { w: number; h: number };

/** What measureSize() answers: a box, whether the browser could decode the
 *  file, and whether the box is the file's own dimensions or the type's
 *  placeholder. `measured` is optional because the fallback paths return the
 *  placeholder and say nothing about it - what import/drop.ts reads it for. */
export type MeasuredSize = Size & { decodable: boolean; measured?: boolean; natural?: Size };

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml',
  'ini', 'cfg', 'conf', 'toml', 'js', 'mjs', 'ts', 'jsx', 'tsx', 'css', 'scss',
  'html', 'htm', 'py', 'rb', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'cs',
  'java', 'kt', 'swift', 'php', 'sh', 'bat', 'ps1', 'sql', 'srt', 'vtt',
]);

/** The extensions read as prose rather than shown as source. Shared by three
 *  surfaces (the viewer, the Feed tile, the card below) that can't import one
 *  another (canvas/ may not import ui/, tests/layers.test.js), so it lives
 *  under all three rather than risk one drifting out of step. */
export const MARKDOWN = new Set(['md', 'markdown', 'mdown', 'mkd']);

/** How a card draws Markdown, handed in rather than imported: the parser is
 *  ui/markdown.ts and this file is canvas/, the one direction layering
 *  refuses. Same shape as setNoteMenu(), setOverlays(), setAssetNameLookup() -
 *  main.ts wires it. **Unwired, a `.md` card shows its source** (old
 *  behaviour, not a failure), so this module still builds with no DOM. */
export type MarkdownRenderer = (src: string) => DocumentFragment;

let renderMd: MarkdownRenderer | null = null;

export function setMarkdownRenderer(fn: MarkdownRenderer | null | undefined) {
  renderMd = typeof fn === 'function' ? fn : null;
}

/**
 * The one hook that reaches the network: fetch a Spotify card's title and cover
 * and store them (canvas/embed-meta.ts), handed in rather than imported for the
 * same reason the Markdown renderer is - to keep this module loadable with no
 * DOM and no network in a test. **Unwired it is a no-op**, which is what lets a
 * test build a link card without a request going out, and is also the whole of
 * the local-first default: a board with this line un-run fetches nothing and
 * shows the card exactly as it was stored. main.ts wires it.
 */
export type EmbedEnrich = (item: Item) => void;

let enrich: EmbedEnrich = () => {};

export function setEmbedEnrich(fn: EmbedEnrich | null | undefined) {
  enrich = typeof fn === 'function' ? fn : () => {};
}

/** Kick off the enrichment for a link that is a player. Exported so the Feed's
 *  own tile builder (ui/feed.ts) reaches the same hook the card does. */
export function enrichEmbedCard(item: Item) {
  enrich(item);
}

/**
 * The faint provider watermark behind the offer: the provider word stretched to
 * fill the inner margin exactly, both axes. Fixed sizes cannot - the fraction of
 * the box a word fills differs by whimsy face - so it is an SVG whose viewBox is
 * set to the word's real ink box (fitMark), and preserveAspectRatio="none" fills
 * that box. Upper-cased here; text-transform does not reach SVG text reliably.
 */
function providerMark(provider: string) {
  // A div sized to the inner margin, with the SVG filling it at 100% x 100%.
  // The SVG cannot size itself off `inset` alone - it keeps an intrinsic height
  // and sits short - so the div is the box and the SVG is told to fill it.
  const box = document.createElement('div');
  box.className = 'embed-mark';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const t = document.createElementNS(SVG_NS, 'text');
  t.textContent = provider.toUpperCase();
  svg.append(t);
  box.append(svg);
  fitMark(svg, t);
  return box;
}

/**
 * The watermark as the brand logo itself, stretched to fill (brands.ts mark).
 * The same faint inset box as the text mark, but a fixed 0 0 24 24 viewBox with
 * preserveAspectRatio="none" - so it needs no fitMark, and the logo fills the
 * inner margins the way the word would. Drawn in the board ink (currentColor).
 */
function providerLogoMark(brand: Brand) {
  const box = document.createElement('div');
  box.className = 'embed-mark';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', brand.path);
  p.setAttribute('fill', 'currentColor');
  svg.append(p);
  box.append(svg);
  return box;
}

/**
 * The specimen on a font card: one line, in the face itself, sized to fill the
 * card. Drawn as SVG text and fitted with fitMark() the way the provider
 * watermark is - but "meet", not "none", so the letters keep their true
 * proportions instead of being stretched to the box. That is the whole point of
 * a specimen: it has to show the face, not a distortion of it. No JS on resize
 * or zoom - the viewBox scales with the element, so it fits at every size the
 * grips and the board give it.
 */
function fontSpecimenMark(text: string, family: string) {
  const box = document.createElement('div');
  box.className = 'font-specimen';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('aria-hidden', 'true');
  const t = document.createElementNS(SVG_NS, 'text');
  t.textContent = text;
  // The registered face, set from script (a markup style attribute is barred by
  // the CSP; this is not). The family is isFamily()-clean before it is stored.
  if (family) t.style.fontFamily = `"${family}", system-ui, sans-serif`;
  svg.append(t);
  box.append(svg);
  fitMark(svg, t);
  return box;
}

// One offscreen 2D context for measuring the cap band; lazily made and guarded
// so the module still loads where there is no canvas (a headless test).
let markCtx: CanvasRenderingContext2D | null | undefined;
function measureCtx(): CanvasRenderingContext2D | null {
  if (markCtx !== undefined) return markCtx;
  try { markCtx = document.createElement('canvas').getContext('2d'); }
  catch { markCtx = null; }
  return markCtx;
}

/**
 * Set the mark's viewBox to the word's real ink box, so preserveAspectRatio=
 * "none" stretches the ink to fill the element on both axes with no padding.
 *
 * Two rendering engines disagree about a font's ink, each in one direction, and
 * neither alone fills every face in Firefox (measured, pixel-scanned):
 *
 * - getBBox is the SVG's own geometry, but Firefox returns the *advance* box, so
 *   a static face's trailing side bearing shows as right-side padding.
 * - canvas actualBoundingBox is tight ink for a static face, but overshoots a
 *   *variable* face (Fraunces, the default display face): its measureText does
 *   not apply the 40px optical size the SVG renders at, so its ink runs wide and
 *   the mark sat 21px short on the right.
 *
 * The true edge is the tighter of the two: max() of the left edges, min() of the
 * right edges. That fills Fraunces, Playfair, Geist, Georgia and Arial to <=1px
 * each. The vertical span is the canvas cap band [-ascent, descent] - the caps,
 * not Firefox's taller line box - about the baseline at y=0 (no y on the text).
 * The two share one scale: same computed face, same font-size.
 *
 * Re-run on fonts.ready (the first reading can be a fallback face); guarded for
 * a headless test, where getBBox throws / there is no canvas and it is unsized.
 */
function fitOne(svg: SVGSVGElement, t: SVGTextElement) {
  const ctx = measureCtx();
  const word = t.textContent || '';
  if (!ctx || !word) return;
  let b: DOMRect;
  try { b = t.getBBox(); } catch { return; }
  if (!(b.width > 0)) return;
  const cs = getComputedStyle(t);
  if (!cs.fontSize || cs.fontSize === '0px') return;
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const m = ctx.measureText(word);
  const left = Math.max(b.x, -m.actualBoundingBoxLeft);
  const right = Math.min(b.x + b.width, m.actualBoundingBoxRight);
  const top = -m.actualBoundingBoxAscent;
  const width = right - left;
  const height = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  if (width > 0 && height > 0)
    svg.setAttribute('viewBox', `${left} ${top} ${width} ${height}`);
}

function fitMark(svg: SVGSVGElement, t: SVGTextElement) {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fitOne(svg, t));
  else fitOne(svg, t);
  document.fonts?.ready.then(() => fitOne(svg, t)).catch(() => {});
}

/**
 * Re-fit every mounted watermark to the current display face. Called from
 * ui/appearance.ts apply() on any look change: a whimsy or display-font switch
 * changes --font-display under a card whose viewBox was measured for the old
 * face, and nothing rebuilds the card DOM. A no-op where no mark is mounted.
 */
export function refitEmbedMarks() {
  for (const box of document.querySelectorAll('.embed-mark')) {
    const svg = box.querySelector('svg');
    const t = box.querySelector('text');
    if (svg && t) fitMark(svg, t);
  }
}

/** Item type for a dropped File. MIME first, extension as the fallback. Only
 *  four things render natively - picture, moving picture, sound, text.
 *  Everything else becomes a named card; formats.ts knows what ~1350
 *  extensions *are*, so a .sldprt says "SolidWorks" rather than "file". */
/** The files that land as an archive card with an Unzip button (import/archive.ts reads them). */
export const ARCHIVE_EXTS = new Set(['zip', 'tar', 'tgz', 'gz', '7z', 'rar']);

export function classify(file: File): ItemType {
  const mime = (file.type || '').toLowerCase();
  const ext = extOf(file.name);
  if (mime.startsWith('image/') || SVG_EXTS.has(ext)) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  // Before the text branch: .obj and .gltf arrive as text/plain from half the
  // systems that hand them over, so testing MIME first would print a vertex list.
  if (meshKind(file.name)) return 'model';
  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  // By extension alone: a ZIP's MIME is spelled four ways and a 7z's hardly
  // ever, and a .docx is a ZIP that is not an archive to anybody who has one.
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  // The catalog's sets are broader than what a browser bothers to set as MIME -
  // .jxl, .avif and friends often arrive with an empty file.type.
  if (PHOTO_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'generic';
}

/** Starting size in world units. Media items refine this once they load. Every
 *  box but the two noted below was taken in a fifth on each side - a dropped
 *  folder arrived too heavy - while type stays fixed, so the head (badge,
 *  name, size) costs proportionally more; the two types whose value is the
 *  body they show are left alone. */
export function defaultSize(type: string): Size {
  switch (type) {
    case 'image':   return { w: 256, h: 192 };
    case 'video':   return { w: 288, h: 162 };
    case 'audio':   return { w: 264, h: 157 };
    // Not shrunk: a text card is a wall of words, and a fifth off each side
    // would show a third less of the file - what it's for.
    case 'text':    return { w: 300, h: 360 };
    // Square-ish: a model has no aspect of its own until read - it's framed
    // from its bounding sphere, so it fills whatever box it gets.
    case 'model':   return { w: 224, h: 224 };
    // Square, off a square pad. Small: a note is an annotation, not a thing on
    // the board, and at the old 240 it outweighed the photos it annotated.
    // Left at 120 (well clear of MIN_SIZE 48 in canvas/input.ts) while
    // everything around it came down.
    case 'note':    return { w: 120, h: 120 };
    // Square and *fixed*, not a fraction of whatever it lands on - else the
    // same star comes out three sizes on three photographs. Smaller than a
    // note: a note is written, a sticker is a mark. 72 (a quarter off the
    // original 96) still clears MIN_SIZE (48); resize grips cover the rest.
    case 'sticker': return { w: 72, h: 72 };
    // Wide and short: an address is a wide thing, and there's no body under it
    // - a link card is a name, a URL, and nothing else. Four cells wide by two
    // tall (256x128), the card grid floor, so a link is born at its own minimum
    // rather than a hair under it. See CARD_FLOOR_CELLS in geometry.ts.
    case 'link':    return { w: 256, h: 128 };
    // Four grid spaces wide, 3:2 tall (256 * 2/3 = 170.67) - the masthead's
    // aspect. Matches TITLE_SIZE in state.ts; CSS holds the visual to exact 3:2.
    case 'title':   return { w: 256, h: 171 };
    // Four grid spaces by three at the default step, so a snapped board lays
    // it where it already is. Fixed - a ghost has no resize grips
    // (canvas/items.ts) - matching GHOSTS in state.ts, where it's minted.
    case 'ghost':   return { w: 256, h: 192 };
    // A colour and its number - sized like the note beside it, not like a
    // card with a body. Two grid spaces square plus the row the hex prints in.
    case 'swatch':  return { w: 128, h: 148 };
    // A specimen of a dropped face. Landscape so a big "Aa" sits across the
    // card with the family name beneath it - it is a look at the letterforms,
    // not a thing with an aspect of its own. Born on the board, never dropped:
    // classify() never returns 'font' (fonts are diverted to faces in drop.ts),
    // so this box is reached only through addFontCard().
    case 'font':    return { w: 200, h: 176 };
    // Four grid spaces wide, a little over five tall. Portrait: three bands
    // stacked (pictures, pigments, faces) each want the card's full width.
    case 'style-tile': return { w: 256, h: 328 };
    // A named card with room under the name for its one button, clear of the
    // caption plate at the foot. Three grid spaces tall.
    case 'archive':
    case 'folder':  return { w: 200, h: 192 };
    default:        return { w: 200, h: 112 };
  }
}

/** What a swatch starts as: a grey, not a colour. The content of a swatch is
 *  the colour you chose, so any preset would be the app inventing one and
 *  calling it yours; mid grey reads as no choice yet, not a decision made. */
export const SWATCH_DEFAULT = '#8a8a8a';

/**
 * Write the two face names into a style tile, in the faces themselves.
 *
 * The one part of the card that cannot be a `var()` and so cannot follow the
 * look on its own: swatches re-resolve their token on every paint, but a *name*
 * is text and has to be written.
 *
 * Exported because canvas/items.ts calls it again when the look changes (the
 * settings listener there). Safe on a non-tile card and on a half-built tile:
 * it writes whatever `.style-tile-face` nodes it finds.
 */
export function paintStyleTileFaces(root: HTMLElement): void {
  for (const face of root.querySelectorAll<HTMLElement>('.style-tile-face')) {
    const token = face.dataset.token || '';
    // 'Default' rather than an empty row: a board on the stock face has one, and
    // a blank line under the palette reads as a tile that failed to draw.
    face.textContent = (token && faceName(token)) || 'Default';
  }
}

/**
 * A swatch's colour, held to what it has to be.
 *
 * `#rrggbb` lowercase and nothing else: `<input type="color">` refuses anything
 * shorter or named, and the stylesheet interpolates it into a custom property.
 * It arrives from a .mbrd through the open `meta` field, so it is checked here
 * rather than trusted - the bargain normalizeAsset() makes one layer down.
 *
 * The three-digit form is folded out rather than rejected: somebody may have
 * typed it into a file by hand, and `#f00` is the same colour written shorter.
 */
export function swatchHex(raw: unknown): string {
  const s = String(raw ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s.slice(1).replace(/./g, c => c + c);
  return SWATCH_DEFAULT;
}

/**
 * True size for a file, measured *before* it becomes an item.
 *
 * Up front, because the arrangement engine reserves a cell per item: a portrait
 * photo that discovered it was portrait after the layout ran would grow past
 * its cell onto its neighbours. Falls back to the placeholder size if the media
 * cannot be decoded - adoptAspect() picks it up later, capped so it cannot
 * overflow.
 *
 * `natural` is the file's own pixel dimensions, carried alongside the world box
 * because fitToBox() throws them away - it answers how much *board* an item
 * takes, area-preserving, saying nothing about pixel count. makeThumb() needs
 * the pixels to decide whether to ask the decoder for a downscaled bitmap, and
 * measuring twice to find out would defeat the point.
 */
export async function measureSize(type: string, file: File): Promise<MeasuredSize> {
  const box = defaultSize(type);
  if (type !== 'image' && type !== 'video') return { ...box, decodable: true };
  // SVG is vector, so it is measured from its own markup rather than by decoding
  // it. Two reasons this is not just an optimisation: it can never be a decode
  // bomb (there are no pixels to allocate), and Firefox refuses to decode a
  // viewBox-only SVG at all - createImageBitmap and <img>.decode both reject -
  // so a decode probe would report it undecodable and the importer would drop it
  // to a named card. It is always an image; a size it does not declare just
  // leaves it at the placeholder box, which an <img> scales it into.
  if (type === 'image' && isSvgImage(file)) {
    const natural = await svgSize(file).catch(() => null);
    return natural
      ? { ...fitToBox('image', natural.w, natural.h), measured: true, decodable: true, natural }
      : { ...box, decodable: true };
  }
  try {
    const natural = type === 'image' ? await imageSize(file) : await videoSize(file);
    // An image the browser cannot decode (HEIC, JXL, camera RAW) is reported
    // so the importer can fall back to a named card instead of a broken <img>.
    if (!natural) return { ...box, decodable: false };
    return { ...fitToBox(type, natural.w, natural.h), measured: true, decodable: true, natural };
  } catch {
    return { ...box, decodable: false };
  }
}

/**
 * The proportion (w/h) of the picture a photo or video card shows, with its
 * crop and quarter turn, or null when nothing can be measured. Fit brings a
 * card to it (fitShapes in ui/board-actions.ts).
 *
 * Read off the smallest copy that is exact: a photo's display copy (uncropped,
 * 1024 on the long side), a video's poster frame, and the file itself only
 * when neither is there. Not the thumbnail: at 100 wide, its rounding shows as
 * a band of paper on a large card. The crop and the turn are arithmetic here,
 * because the display copy that carries them lives only in this session.
 */
export async function pictureRatio(item: Item): Promise<number | null> {
  if (item.type !== 'image' && item.type !== 'video') return null;
  const video = item.type === 'video';
  const stills = video ? [metaStr(item.meta?.cover)] : [metaStr(item.meta?.display), shownHash(item)];
  let size: Size | null = null;
  for (const hash of stills) {
    size = await naturalSize('image', hash);
    if (size) break;
  }
  if (!size && video) size = await naturalSize('video', item.asset?.hash);
  if (!size) return null;
  const crop = itemCrop(item);
  const ratio = crop ? (size.w * crop.w) / (size.h * crop.h) : size.w / size.h;
  const rot = itemRotate(item);
  return rot === 90 || rot === 270 ? 1 / ratio : ratio;
}

/** Pixel sizes by content id. A hash names its bytes, so an answer never goes stale. */
const naturalSizes = new Map<string, Size | null>();

async function naturalSize(type: string, hash: string | null | undefined): Promise<Size | null> {
  if (!hash) return null;
  if (naturalSizes.has(hash)) return naturalSizes.get(hash) ?? null;
  const blob = getAsset(hash)?.blob;
  if (!blob) return null;
  // SAFETY: measureSize() reads the type and the bytes. Its one name read, in isSvgImage(), goes
  // through extOf(), which takes the absent name of a Blob as ''. resetSize() passes a Blob the same way.
  const size = (await measureSize(type, blob as File).catch(() => null))?.natural ?? null;
  naturalSizes.set(hash, size);
  return size;
}

/** An SVG, by MIME or by extension - the same either/or classify() uses. */
function isSvgImage(file: File): boolean {
  return (file.type || '').toLowerCase() === 'image/svg+xml'
    || SVG_EXTS.has(extOf(file.name));
}

/**
 * An SVG's intrinsic size from its own root tag, without a decoder: explicit
 * width/height when they are plain numbers, else the last two numbers of the
 * viewBox. Null when neither is usable (percentages, missing) - the caller then
 * keeps the placeholder box. Text and regex only, so it runs anywhere a File
 * does and cannot be refused the way a decode can.
 */
async function svgSize(file: File): Promise<Size | null> {
  // Sliced before it is decoded, not after. `file.text()` on a 200 MB .svg
  // allocated about 400 MB as UTF-16 - during *import measurement*, on a file
  // that was then thrown away except for its first four kilobytes. Slicing the
  // Blob first is the same answer, bounded.
  const text = await file.slice(0, 4096).text();
  const tag = text.match(/<svg\b[^>]*>/i)?.[0] || '';
  // parseFloat('') is NaN, which is exactly what an absent capture already gave
  // it - the `?? ''` is that same non-answer in a form parseFloat's type takes.
  const w = parseFloat(tag.match(/\bwidth\s*=\s*["']?\s*([\d.]+)\s*(?:px)?["'\s>]/i)?.[1] ?? '');
  const h = parseFloat(tag.match(/\bheight\s*=\s*["']?\s*([\d.]+)\s*(?:px)?["'\s>]/i)?.[1] ?? '');
  if (w > 0 && h > 0) return { w, h };
  const vb = tag.match(/\bviewBox\s*=\s*["']\s*[-\d.eE]+[\s,]+[-\d.eE]+[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)/i);
  if (vb) {
    const vw = parseFloat(vb[1]);
    const vh = parseFloat(vb[2]);
    if (vw > 0 && vh > 0) return { w: vw, h: vh };
  }
  return null;
}

/**
 * A type's placeholder box, reshaped to a known aspect ratio without changing
 * how much of the board it takes up.
 *
 * Area-preserving rather than width- or height-preserving, so a portrait clip
 * and a landscape one that arrive together read as the same *amount* of thing,
 * which is what makes a mixed drop lay out evenly.
 *
 * Split out of measureSize() because the ratio does not always come from the
 * browser. A video this browser cannot open has no dimensions to offer - but a
 * frame pulled out of it with ffmpeg does, and that frame is measured after the
 * fact by a different path (see import/drop.ts). Both have to land on the same
 * arithmetic or the same clip would be a different size depending on which route
 * discovered its shape.
 */
export function fitToBox(type: string, w: number, h: number): Size {
  const box = defaultSize(type);
  if (!(w > 0 && h > 0)) return box;
  const area = box.w * box.h;
  const ratio = w / h;
  return { w: Math.round(Math.sqrt(area * ratio)), h: Math.round(Math.sqrt(area / ratio)) };
}

async function imageSize(file: File): Promise<Size | null> {
  // createImageBitmap avoids putting anything in the DOM, and reports the
  // orientation-corrected dimensions.
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      const size = { w: bmp.width, h: bmp.height };
      bmp.close?.();
      return size;
    } catch { /* SVG and a few exotic formats: fall through to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { w: img.naturalWidth, h: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function videoSize(file: File): Promise<Size | null> {
  const url = URL.createObjectURL(file);
  return new Promise(resolve => {
    const v = document.createElement('video');
    // Never let one unreadable file stall a whole drop.
    const done = (size: Size | null) => { clearTimeout(timer); v.removeAttribute('src'); URL.revokeObjectURL(url); resolve(size); };
    const timer = setTimeout(() => done(null), 2000);
    v.preload = 'metadata';
    v.muted = true;
    v.addEventListener('loadedmetadata', () => done(v.videoWidth ? { w: v.videoWidth, h: v.videoHeight } : null), { once: true });
    v.addEventListener('error', () => done(null), { once: true });
    v.src = url;
  });
}

/** Build the inner DOM for an item. Async content fills itself in afterwards. */
export function buildContent(item: Item) {
  const fn = RENDERERS[item.type] || RENDERERS.generic;
  const content = fn(item);
  // Any card may carry a chosen picture, and it is attached here rather than in
  // each renderer so that a type added later gets it for free - the same reason
  // adding a type is meant to be one entry in RENDERERS and nothing else.
  //
  // The test is for a `.card`, which quietly says the right thing: the only two
  // renderers that do not return one are image and video, and they hand back a
  // fragment because they *are* the picture. Giving those a cover as well would
  // be a picture in front of a picture.
  const cover = coverEl(item);
  // `in` rather than `classList?.`: the two renderers that hand back a fragment
  // have no classList at all, which is the same falsy answer optional chaining
  // was reaching for.
  if (cover && 'classList' in content && content.classList.contains('card')) {
    content.classList.add('has-cover');
    content.prepend(cover);
  }
  return content;
}

/**
 * The picture an item was given, or null. See setItemCover() in state.ts.
 *
 * Null when the hash names nothing, which is a real state and not a fault: a
 * board can be opened from a .mbrd whose assets are still being registered, and
 * a card with no cover is what it looked like before anyway. The alternative -
 * an <img> with no src - is a broken-image icon on a card that was fine.
 */
function coverEl(item: Item) {
  const cover = metaStr(item.meta?.cover);
  const url = cover ? assetURL(cover) : null;
  if (!url) return null;
  const img = document.createElement('img');
  img.className = 'card-cover';
  // Decorative: the card's name is right beside it and says the same thing, so
  // announcing the picture as well would read the card out twice.
  img.alt = '';
  img.decoding = 'async';
  img.draggable = false;
  img.src = url;
  return img;
}

/**
 * Say on the card that this engine will not play what the card is holding, and
 * take away the button that was pretending otherwise.
 *
 * Every browser refuses part of this app's own format catalogue and no two
 * refuse the same part: nothing but Safari opens AC-3, DTS or an AIFF; Chrome
 * and Firefox decline AVI, WMV, FLV and the MPEG program streams a camcorder
 * writes; HEVC in an .mp4 plays on the phone that shot it and on nothing else.
 * Until now all of those mounted a player like any other clip, and pressing it
 * did nothing at all - no sound, no error, no explanation, and a running time
 * of 0:00 because the element never loaded enough to have one.
 *
 * The element is what decides, not a table of what each engine supports. Those
 * tables are wrong within a version or two, they are wrong per platform for the
 * same version - Chrome on Windows plays what Chrome on Linux will not,
 * because half of this is the operating system's decoders - and `canPlayType`
 * answers "maybe" for most of what is actually in question. An `error` event
 * with a code of 3 or 4 is the engine saying it outright.
 *
 * The other two codes are not this. An abort is somebody navigating away, and a
 * network error on a blob URL is the asset going missing - a different fault
 * with a different fix, and saying "this browser cannot play it" over either
 * would send somebody looking for a codec they already have.
 *
 * What stays on the card is everything that was already true: the poster frame
 * pulled out of the clip at import, the cover art out of the track's tags, the
 * name, the size, and the duration read out of the container by
 * import/containers.ts - which is precisely the case that reader exists for.
 * The card becomes an honest still of a thing this browser will not play,
 * rather than a broken player.
 */
function markUnplayable(media: HTMLMediaElement, item: Item) {
  const code = media.error?.code || 0;
  // 3 is MEDIA_ERR_DECODE, 4 is MEDIA_ERR_SRC_NOT_SUPPORTED.
  if (code !== 3 && code !== 4) return;
  const host = media.closest<HTMLElement>('.item');
  const body = media.parentElement;
  if (!host || !body || body.querySelector('.media-dead')) return;
  host.classList.add('is-unplayable');
  const note = document.createElement('div');
  note.className = 'media-dead';
  // The extension and not a codec name, because the extension is what somebody
  // has in their folder and what they would search for. The same choice
  // cardShell() makes a few lines down the card, and for the same reason.
  const ext = (metaStr(item.meta?.ext) || extOf(item.name) || '').replace(/^\./, '');
  // And how long it runs, when the item knows - which for exactly these formats
  // it usually does, because import/containers.ts read it out of the header
  // rather than asking the decoder that is refusing to open the file. It is the
  // one fact the hidden transport was carrying that is worth keeping.
  const secs = item.meta?.duration;
  const words = ext ? `This browser cannot play ${ext.toUpperCase()}` : 'This browser cannot play this file';
  note.textContent = typeof secs === 'number' && secs > 0
    ? `${words} · ${clock(secs)}`
    : words;
  // Appended last, which keeps `video + .still` adjacent - items.css pairs the
  // two with a sibling combinator and swaps them at the far zoom rung.
  body.append(note);
}

const RENDERERS = {
  image(item: Item) {
    const img = document.createElement('img');
    img.alt = item.name || '';
    img.decoding = 'async';
    img.draggable = false;
    img.addEventListener('load', () => adoptAspect(item, img.naturalWidth, img.naturalHeight), { once: true });
    // The picture is mounted at a bounded display resolution, not the native
    // original: a full-res <img> is tens of megabytes of decode held for a
    // card a few hundred pixels wide, and a whole board of them mounted at once
    // (zoom-out) is what crashes Safari on a phone. canvas/display.ts makes a
    // card-sized copy once per session, serialized so only one full decode is
    // ever live, and the original stays in the asset store for export/optimize.
    //
    // Animated and vector pictures keep the original - a downscaled GIF is a
    // still, and an SVG is already resolution-free, so neither wants a raster
    // copy. Those, and any picture whose copy is not made yet, fall back to the
    // original URL; while a copy renders the card shows its thumbnail if it has
    // one (set on the twin below), never the full-res original.
    // The preview, when the original is a picture the browser cannot decode
    // (HEIC, RAW): asset.hash still names the untouched original for export and
    // for the day a decoder lands, but the pixels drawn here are the camera's
    // own embedded JPEG - see import/preview.ts and meta.preview in drop.ts.
    // shownHash(), which is that rule written once - see board-model.ts. This
    // file had it right and the Feed did not, which is exactly what two copies
    // of a rule are for.
    const hash = shownHash(item);
    const vector = (getAsset(hash)?.mime || '').toLowerCase().includes('svg');
    // The crop rides down into the display copy, which is what applies it - see
    // the Crop note in canvas/display.ts. Nothing else in this function changes
    // for a cropped card, and that is the point of doing it there: the copy is
    // already the cropped picture by the time object-fit, the aspect adopted on
    // load and the far-zoom twin get hold of it.
    //
    // The quarter turn and the background removal ride down with it, on exactly
    // those terms and for exactly that reason - a turn swaps the box and a matte
    // is pixels, and neither is something this function should be teaching
    // object-fit about. See itemRotate() in board-model.ts.
    const crop = itemCrop(item);
    const rot = itemRotate(item);
    const matte = itemMatte(item);
    // Whether the copy is the only picture that would be right here. A card with
    // none of the three can show its thumbnail and can fall back to the original
    // while the copy renders; a card with any of them cannot, because both of
    // those are the untouched file.
    const edited = !!(crop || rot || matte);
    // An `<img>` that will not load says nothing: it draws its own alt text and
    // fires an event nobody was listening for. Answered rather than only
    // reported - a display copy that will not decode is this app's own derived
    // file, and the original beside it in the store is very likely fine. Only
    // when that refuses too is it worth a line, and one line covers a board of
    // them - see noPreview().
    img.addEventListener('error', () => {
      const raw = hash ? assetURL(hash) : null;
      if (raw && img.src !== raw) { img.src = raw; return; }
      noPreview('card', 'this browser would not draw the picture');
    });
    if (hash && !isAnimated(item) && !vector) {
      // A plain photo is tagged so canvas/hires.ts swaps in the original once the
      // card is zoomed past the copy's ~1024px. An edited card cannot be: its
      // display copy is the crop/turn/cut-out, and the original is the untouched
      // file, so there is nothing to sharpen up to.
      if (!edited) img.dataset.hiresHash = hash;
      // The baked copy carried in the .mbrd (meta.display), the sharp layer with
      // no decode - only for a plain card, since the baked copy is uncropped, and
      // only while the sharpness dial asks for no more than it holds.
      const useBaked = !edited && bakedServes();
      const displayHash = useBaked ? metaStr(item.meta?.display) : '';
      const baked = displayHash ? assetURL(displayHash) : null;
      const ready = displayURLReady(hash, crop, rot, matte);
      if (baked) {
        img.src = baked;
      } else if (ready) {
        img.src = ready;
      } else {
        const thumbHash = metaStr(item.meta?.thumb);
        const thumb = thumbHash && assetURL(thumbHash);
        // The thumbnail is the whole picture, so on an edited card it is a
        // stand-in for something else - it would show the full frame, the wrong
        // way up, with its background still on it, and then snap to the detail.
        // Better to show nothing for the moment it takes.
        if (thumb && !edited) img.src = thumb;   // crisp-enough stand-in while the copy renders
        // **A copy that could not be made falls back to the original.** Without
        // it this card ends with no `src` at all, which is an `<img>` drawing its
        // own alt text. `!img.src` alongside isConnected saves work on a
        // discarded card without leaving a live one blank.
        const done = (src: string | null) => {
          if (src && (img.isConnected || !img.src)) img.src = src;
        };
        if (!useBaked) {
          // The exact edit state, or a plain copy sharper than the baked one,
          // from the runtime cache - never baked.
          ensureDisplay(hash, crop, rot, matte).then(u => done(u || assetURL(hash)));
        } else {
          // A plain card on a board with nothing baked (an old board). One decode
          // both shows the 1024 copy and stores it as meta.display, so a later
          // save persists it (noteDisplay is silent - no dirty flag).
          bakeDisplayFor(hash).then(dhash => {
            if (dhash) noteDisplay(item.id, dhash);
            done((dhash && assetURL(dhash)) || assetURL(hash));
          });
        }
      }
    } else {
      const url = hash && assetURL(hash);
      if (url) img.src = url;
    }

    // Both kinds of picture can travel with a twin, and the twin works the
    // same way either way: a sibling <img class="still"> that the CSS shows
    // instead of this one once #world is marked zoomed-out. Two sources for
    // it, and they are the two halves of the same idea.
    //
    // An animation's twin is shot live by canvas/stills.ts, because what
    // should freeze is the frame that was on screen - not frame one.
    //
    // A still photograph's twin is the hundred-pixel copy made at import
    // (see thumbFor() in import/drop.ts). It is the cheap half of the feature:
    // zoomed out past the rung, a board of two hundred photographs draws two
    // hundred hundred-pixel WebPs instead of two hundred full-size decodes,
    // at a size where the difference is not visible because a card is under a
    // hundred pixels wide there.
    //
    // **Not on an edited card**, and this is the same sentence as the one at the
    // stand-in above, finally applied in both places. The thumbnail is the
    // untouched whole picture: on a cropped, turned or matted card it shows the
    // full frame, the wrong way up, with its background still on. As a stand-in
    // that was already refused; as the far-zoom twin it was mounted anyway, so a
    // cut-out card grew its background back the moment you zoomed out and lost
    // it again on the way in. One rule, two places, and only one of them had it.
    //
    // What that costs is the far-zoom saving, on edited cards only: such a card
    // keeps its display copy up instead of swapping to a hundred-pixel file. The
    // copy is already bounded by the sharpness ceiling rather than being the
    // original, so this is a smaller decode held, not an unbounded one - and the
    // alternative is a second derived picture per edited card, which is a real
    // piece of machinery to build for a board with many of them. The correct
    // picture first.
    //
    // The CSS is what makes an absent twin safe: the swap is written as
    // `img:not(.still):has(+ .still.is-ready)`, so a card with no ready sibling
    // simply keeps showing its own picture at every zoom. See items.css.
    //
    // Never both. An animated file with a thumbnail would have stills.ts
    // overwrite the thumbnail's src on the first pass, so the thumbnail is
    // simply not made for one - makeThumb() refuses animated input.
    const animated = isAnimated(item);
    const thumbHash = metaStr(item.meta?.thumb);
    const thumb = !animated && !edited && thumbHash && assetURL(thumbHash);
    if (!animated && !thumb) return img;

    if (animated) img.dataset.gif = '';
    const still = document.createElement('img');
    still.className = 'still';
    still.alt = '';
    still.decoding = 'async';
    still.draggable = false;
    // is-ready gates the swap, and it is set on load rather than here for both
    // sources alike: the attribute lands at once but the bytes still have to
    // decode, and swapping early shows a blank square where the picture was.
    if (thumb) {
      still.addEventListener('load', () => still.classList.add('is-ready'), { once: true });
      still.src = thumb;
    }
    const pair = document.createDocumentFragment();
    pair.append(img, still);
    return pair;
  },

  /**
   * A moving picture, with the board's own transport laid over it.
   *
   * Neither muted nor looping any more, and both of those were doing damage.
   * Muted is what a browser makes you be in order to autoplay, and nothing
   * here autoplays - playback starts from a click - so it bought nothing and
   * cost the sound. Looping suits a silent GIF and not a clip with audio in
   * it: an eight-second loop with a voice on it is not ambience, it is a
   * board that will not stop talking. See canvas/video.ts for the controls,
   * which is also where this is registered for the global volume and for the
   * one-clip-at-a-time rule the audio cards already follow.
   */
  video(item: Item) {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.playsInline = true;
    v.draggable = false;
    v.addEventListener('loadedmetadata', () => adoptAspect(item, v.videoWidth, v.videoHeight), { once: true });
    // Not `{ once: true }`: a clip parked with `preload='none'` on iOS fails
    // when it is first tapped rather than when it mounts, and a clip that fails
    // twice has the same one thing to say each time. markUnplayable() is idempotent.
    v.addEventListener('error', () => markUnplayable(v, item));
    // A frame pulled out of the file at import - and, failing that, by the
    // optimiser or the idle backfill. Set as the poster rather than drawn as a
    // card cover, because a video *is* its picture: the card then shows the clip,
    // full bleed and the right shape, instead of the blank rectangle a clip with
    // no frame decoded leaves behind. It costs nothing on a clip the browser can
    // play and has mounted, since the first frame it decodes paints over it.
    //
    // Three keys, not one, and the thumbnail behind them. setItemPoster() writes
    // `cover`, older boards carry `poster` or `shot`, and thumbSource() in
    // optimize/optimize.ts has read all three for as long as they have existed -
    // so a board whose clips predate the current key had a picture the optimiser
    // could see and the card could not. The hundred-pixel thumbnail is the last
    // resort and a real one: blown up to card size it is soft, and soft is a
    // great deal closer to the clip than an empty rectangle is.
    const posterHash = ['cover', 'poster', 'shot', 'thumb']
      .map(key => metaStr(item.meta?.[key]))
      .find(hash => hash && getAsset(hash));
    const poster = posterHash ? assetURL(posterHash) : null;
    if (poster) v.poster = poster;
    const url = item.asset?.hash ? assetURL(item.asset.hash) : null;
    if (rationsDecoders()) {
      // On an engine that rations decoders the source is held back until the
      // first play. A <video> with a src (even preload=metadata, even just to
      // paint a poster frame) holds a decoder, and iOS rations simultaneous
      // video decoders hard - a board of parked clips all mounted at once,
      // which is what zooming out does, exceeds the ceiling and crashes the tab.
      // Parked here, a clip is an inert element with no decoder;
      // buildVideoPlayer attaches the source on the first toggle. A poster shows
      // the frame meanwhile if the clip has one; without one the card is its
      // play button over black until tapped.
      //
      // rationsDecoders() and not onTouch(): see the note on it. An iPad with a
      // keyboard folded on has iPadOS's ration and a pointer that is no longer
      // coarse, and this guard was switching itself off there.
      v.preload = 'none';
      if (url) v.dataset.src = url;
    } else {
      v.preload = 'metadata';
      // The fragment pulls a real frame as the poster instead of a black
      // rectangle. Named, because it leaves every parked clip on the board
      // sitting at a currentTime that is not zero, and two other places have to
      // know that in order to tell a parked clip from a played one.
      //
      // **Firefox does not implement media fragments**, and this is where "video
      // thumbnails do not work on Firefox" came from. There the `#t=` is dropped
      // on the floor, `preload='metadata'` fetches the header and paints nothing,
      // and the card is a black rectangle - which the poster asset set above
      // covers, but only for a clip that got one. So the frame this line asks
      // for is asked for again as an ordinary seek, which every engine has.
      //
      // Guarded on `currentTime === 0` so it is a no-op wherever the fragment
      // was honoured, and on the duration so a clip shorter than the poster time
      // is left where it is. Both readings then park at POSTER_TIME, which is
      // the state canvas/items.ts reads to tell a parked clip from a played one.
      if (url) {
        v.src = url + '#t=' + POSTER_TIME;
        v.addEventListener('loadedmetadata', () => {
          if (v.currentTime === 0 && v.duration > POSTER_TIME) v.currentTime = POSTER_TIME;
        }, { once: true });
      }
    }
    // The twin, and it is the same twin a photograph carries: zoomed out past
    // the detail rung the board draws hundred-pixel copies instead of the real
    // thing, and a clip is the heaviest thing on the board to be drawing the
    // real thing of.
    //
    // This is the half of that feature video never had. Both ends of it were
    // built - import cuts a thumbnail from a clip's poster, the optimiser and the
    // idle backfill repair the ones that are missing - and nothing ever mounted
    // one, so every clip on a board zoomed right out stayed a live <video>
    // holding a decoder to paint something 80px wide. The rules that swap them
    // are in items.css beside the picture's.
    //
    // Not while it is playing: that swap is in the CSS too, because a clip you
    // zoom away from mid-play should keep showing the picture it is making.
    const twinHash = metaStr(item.meta?.thumb);
    const twinURL = twinHash && getAsset(twinHash) ? assetURL(twinHash) : null;
    let still: HTMLImageElement | null = null;
    if (twinURL) {
      still = document.createElement('img');
      still.className = 'still';
      still.alt = '';
      still.decoding = 'async';
      still.draggable = false;
      // is-ready gates the swap for the reason it does on a picture: the src
      // lands at once and the bytes still have to decode, and swapping early
      // shows an empty square where the clip was.
      still.addEventListener('load', () => still?.classList.add('is-ready'), { once: true });
      still.src = twinURL;
    }

    // A fragment so all of them land as siblings inside .item-body, the same way
    // an animated picture travels with its still. The twin goes directly after
    // the <video> because the CSS pairs them with `+`.
    const pair = document.createDocumentFragment();
    pair.append(v);
    if (still) pair.append(still);
    pair.append(buildVideoPlayer(item, v));
    return pair;
  },

  /**
   * A player the board owns, rather than the browser's grey plastic one.
   *
   * The <audio> element is still what plays the sound - it handles streaming,
   * seeking and codecs, and nothing here would be improved by reimplementing
   * that - but it is kept out of the layout entirely and driven by the button
   * and the bars. See canvas/audio.ts for the waveform and the global volume.
   */
  audio(item: Item) {
    const card = cardShell(item, 'audio');
    card.classList.add('card-audio');

    const sound = document.createElement('audio');
    const url = item.asset?.hash ? assetURL(item.asset.hash) : null;
    // The same parking the video renderer does, and for the same reason - it
    // was simply never extended here. A <audio> holding a src holds a decoder
    // too, and a board laid out for a phone can mount a column of clips at
    // once. Cheaper per element than video, which is why this is caution rather
    // than a crash being fixed, but the asymmetry between the two renderers was
    // an oversight rather than a decision.
    //
    // The source is attached at the one place a card's own element is ever
    // started - startCurrent() in canvas/playlist-queue.ts - so unlike video
    // there is no second entry point to keep in step. The waveform is unaffected
    // either way: canvas/waveform.ts decodes the asset's bytes through an
    // OfflineAudioContext and never asks the element for anything.
    if (rationsDecoders()) {
      sound.preload = 'none';
      if (url) sound.dataset.src = url;
    } else {
      sound.preload = 'metadata';
      if (url) sound.src = url;
    }
    registerPlayer(sound, item);
    // The same admission the video renderer makes, and the case is wider here:
    // a .ac3, a .dts, a .wma and an .aiff all play in one engine each, and the
    // card for one of them was a play button that did nothing over a waveform
    // that never drew. See markUnplayable().
    sound.addEventListener('error', () => markUnplayable(sound, item));

    card.append(buildTransport(item, sound), sound);
    return card;
  },

  /**
   * A note is a short run of formatted lines - a heading, a subheading,
   * paragraphs - each an editable block with its own alignment, laid out in a
   * `.note-rich` column that carries the note's font, size and vertical
   * placement. The model is normalizeNoteRich(): meta.rich when it is there,
   * meta.text parsed back when it is not, so a legacy note still reads titled.
   * canvas/notes.ts edits the same blocks and writes both halves back.
   */
  note(item: Item) {
    const card = document.createElement('div');
    card.className = 'card';
    // meta is unknown per key: a `rich` that is not an object is no rich model,
    // and normalizeNoteRich() reads null and a malformed value the same way.
    const rawRich = item.meta.rich;
    // SAFETY: the `typeof rawRich === 'object'` on the line below is the check,
    // and normalizeNoteRich() reads a malformed value and a null the same way -
    // so the assertion only gets the value through the door, and what is inside
    // it is validated block by block there.
    const rich = normalizeNoteRich(
      rawRich && typeof rawRich === 'object' ? rawRich as NoteRichInput : null, item.meta.text);
    const wrap = document.createElement('div');
    wrap.className = 'note-rich';
    applyNoteStyle(wrap, rich);
    for (const block of rich.blocks) wrap.append(buildNoteLine(block));
    card.append(wrap);
    return card;
  },

  /**
   * A link card: a name you can click, and under it the address it leads to.
   *
   * The only item whose subject is not on the board at all, and the card says
   * so without going and looking. Nothing is fetched - no page title, no
   * favicon, no preview image - because a board is local-first and has to be
   * the same board with the network off, and a request sent to decorate this
   * card would tell whoever answered it that this board holds a link to them.
   * The hostname is an honest identity that is already in hand.
   *
   * The name doubles as the anchor, because the line you read should be the
   * line you can click, and it is item.name - so a renamed link keeps its new
   * name, canvas/items.ts editing .card-name in place exactly as it does on
   * every other card. What a name can never do is hide where the link goes:
   * the address under it is drawn from the URL and from nothing else, so a
   * card called "the good one" still says out loud that it leads to
   * example.com.
   *
   * classify() is not involved and never will be - it sorts *files*, and a
   * link arrives as text, from a paste (import/drop.ts) or from a sticky note
   * that turned out to hold nothing else (canvas/notes.ts).
   */
  link(item: Item) {
    const card = document.createElement('div');
    card.className = 'card card-link';

    // Validated again here rather than trusted from meta, every render. A
    // .mbrd is a file anyone can edit by hand, and this is the one place in
    // the app where a string out of one would otherwise become something the
    // browser navigates to. A URL that fails the check renders as inert text:
    // the card still shows what it is holding, and none of it is clickable.
    const u = linkURL(item.meta.url);

    // A link that is a player is drawn as one from the first frame: no address,
    // no anchor, just the provider's name faint behind the offer to press. The
    // reason it carries no link of its own is that the player, once loaded,
    // carries the site's own - so a second one here would be redundant, and its
    // absence is what leaves the whole card grabbable (an <a> is a widget the
    // drag gesture steps around - canvas/input.ts). The faint name doubles as
    // the drag handle once the frame is in and eating every pointer over it.
    const spec = u && embedFor(u);
    if (spec) {
      card.classList.add('card-embed');
      card.dataset.provider = spec.provider;
      // The provider's name, faint, filling the width behind the offer. Drawn
      // as SVG text with a textLength so it fills exactly on every whimsy face -
      // a fixed font-size cannot, the display faces differ in glyph advance and
      // one that fits softish overflows the next.
      card.append(providerMark(spec.provider));
      // The song, at the top left: its fetched title once stored, the site
      // until then. Doubles as the drag handle once the player is in and eating
      // every pointer over the frame (embed.ts keeps this element on open).
      const title = document.createElement('div');
      title.className = 'embed-title';
      title.textContent = metaStr(item.meta.title) || item.name || linkName(u) || spec.provider;
      card.append(title, embedOffer(item, spec, card));
      // On load if missing: fetch the title and cover and store them
      // (embed-meta.ts, wired in main.ts). A no-op until wired, so a test that
      // builds this card reaches no network.
      enrich(item);
      return card;
    }

    // Not a player, but a card in the same family. The site name fills the width
    // behind a chip that is the link itself - the site's own mark, or a globe,
    // beside the address - so a plain link reads like the others rather than as
    // a bare line of text. The one thing here that is not on the board already:
    // the mark, and it is a bundled brand SVG (canvas/brands.ts), never a
    // favicon fetched per domain, so the card is the same with the network off.
    if (u) {
      const brand = brandFor(u);
      card.classList.add('card-embed');
      card.dataset.provider = 'link';
      // The watermark: the brand name filling the width, or - for a one-glyph
      // name like X, where the serif letter is not the mark anyone knows - the
      // logo itself, stretched the same way (brands.ts mark).
      const mark = brand?.mark
        ? providerLogoMark(brand)
        : providerMark(brand?.label ?? siteName(u));
      card.append(mark, linkChip(item, u));
      return card;
    }

    // No valid URL: inert. The card still shows what it holds, and none of it is
    // clickable - the one place a hand-edited .mbrd string could otherwise reach
    // an href, refused by rendering it as text.
    const icon = document.createElement('div');
    icon.className = 'card-icon';
    icon.textContent = 'link';
    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = item.name || metaStr(item.meta.url) || 'link';
    card.append(icon, name);
    return card;
  },

  /**
   * A text file, shown as text.
   *
   * classify() has returned 'text' for some fifty extensions since the day it
   * was written, defaultSize() has had a 300x360 for it, readText() was added
   * and documented as "used by the text renderer", and the README lists text
   * as one of the four things that renders. There was no entry here, so every
   * .txt, .md and .csv fell through to the generic card - a name and a byte
   * count, for a file whose entire content the browser could have drawn.
   *
   * Bounded by readText's own limit rather than trusting the file: a card on a
   * board is a preview, and a 40 MB log has no business being turned into DOM
   * to be looked at from across an infinite canvas.
   *
   * Markdown is the exception and reads as prose, the same split the viewer and
   * the Feed tile make and by the same test - the extension, and only the
   * extension. A `.md` is the one text format people write in order to be read,
   * and a card showing its hashes and asterisks is showing the scaffolding
   * instead of the building. Everything else classify() routes here is source,
   * config or tabular data, and stays source.
   */
  text(item: Item) {
    const card = document.createElement('div');
    card.className = 'card';

    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = baseName(item.name) || item.name || 'untitled';

    // Captured once rather than read again when the file arrives: the renderer
    // is wired at boot and never swapped, but the element below is built for one
    // of the two answers and the fill has to be the same answer.
    const md = MARKDOWN.has(metaStr(item.meta.ext)) ? renderMd : null;

    // .card-text was already in items.css, waiting - monospaced, pre-wrapped, and
    // masked to a fade at the bottom so a long file ends by trailing off rather
    // than by being chopped. It had no markup to style until now. .card-md is
    // its prose twin, sharing the box and the fade.
    //
    // <pre> and textContent, never innerHTML: most of what classify() routes
    // here is source, config or tabular data whose whitespace is its shape,
    // and .html is on the list of things that land here. The Markdown branch
    // holds the same line from the other side - ui/markdown.ts builds trees out
    // of createElement and createTextNode and touches innerHTML nowhere, so raw
    // HTML inside a `.md` comes out as the characters it is made of.
    //
    // (It said ".html and .svg". An SVG is routed to `image` by classify() two
    // hundred lines up and has been for a long time, so half the justification
    // for this rule named a file type that never reaches it. The rule is right
    // for the half that is true, and it would still be right for one file.)
    const body = document.createElement(md ? 'div' : 'pre');
    body.className = md ? 'card-md' : 'card-text';

    card.append(name, body);

    const hash = item.asset?.hash;
    if (!hash) return card;

    readText(hash, TEXT_PREVIEW).then(text => {
      // The card can be rebuilt or culled while the read is in flight, and
      // writing into a node nothing will ever show is wasted work.
      if (!card.closest('.item')) return;
      if (md) body.append(md(text));
      else body.textContent = text;
      // Said out loud rather than left to the fade, which looks identical
      // whether the file ended or the preview did.
      //
      // Measured against the *file*, not against the decoded string.
      // readText() slices the blob at TEXT_PREVIEW bytes and `text.length`
      // counts UTF-16 code units, so for any file that is not pure ASCII the
      // string is shorter than the limit and the notice never appeared - a
      // truncated preview presented as the whole file, which is the one thing
      // this line exists to prevent.
      if ((getAsset(hash)?.blob.size ?? 0) > TEXT_PREVIEW) {
        const more = document.createElement('div');
        more.className = 'card-meta';
        more.textContent = `first ${formatBytes(TEXT_PREVIEW)} shown`;
        card.append(more);
      }
    }).catch(() => { body.textContent = ''; });

    return card;
  },

  /**
   * A model, turned over on the card. See canvas/model.ts - the geometry is
   * read there, the drawing happens there, and this is only the routing.
   */
  model(item: Item) {
    return buildModelCard(item);
  },

  /**
   * The Desktop title card: the board's name, set in the shared masthead style.
   *
   * Bare on purpose - no `.card` shell, so no paper, no border, no cover - it is
   * the same styled name the Mobile masthead shows, only movable. This renderer
   * builds the structure and writes the current name; the typography (face,
   * size, weight, axes) is painted by ui/mobile-header.ts, which owns that style
   * for both the masthead and this card and is the only layer that can resolve a
   * board's own font faces. A singleton kept out of classify() - it is never a
   * dropped file - and desktop-only, gated at mount in canvas/items.ts.
   */
  title(_item: Item) {
    const card = document.createElement('div');
    card.className = 'title-card';
    const name = document.createElement('div');
    name.className = 'title-name';
    name.textContent = board.title;
    // Dim an unnamed board here, not only in main.ts's paintMobileTitle: this
    // runs on every build, so the card keeps its quiet grey across an unmount and
    // remount (a layout switch to Mobile and back) where paintMobileTitle - which
    // fires on 'board', not on the rebuild - would not reapply it.
    name.classList.toggle('is-untitled', isDefaultTitle(board.title));
    card.append(name);
    return card;
  },

  /**
   * A ghost card: one of the three hints a brand-new board opens with.
   *
   * Structure only. What it says comes from canvas/ghosts.ts (the item carries
   * a key, not prose - see the note there), and what it looks like is entirely
   * items.css: a dashed outline at Middle and Harsh, a page torn out of a pad and
   * taped down at Softish - except for the dial, which stays an ordinary card at
   * every tier. Nothing here reads the whimsy level to draw with, because
   * nothing here needs to - the level is on <html> as data-whimsy and CSS can
   * see it. The dial reads it, but as a value to show, not as a look.
   *
   * classify() is not involved and never will be. That function routes dropped
   * *files*, and no file is ever a hint; these are minted by state.ts on an
   * empty board and by nothing else.
   */
  ghost(item: Item) {
    // A fragment, not a card, and that is load-bearing. At Softish the card is
    // perforated by a CSS mask, and a mask applies to an element's descendants
    // as well as to itself - tape drawn inside the card would be punched full
    // of the same holes. So the strips are siblings of the card, and both land
    // in .item-body together. items.ts appends whatever this returns, and
    // append() spreads a fragment, so nothing there had to change.
    const frag = document.createDocumentFragment();
    const card = document.createElement('div');
    card.className = 'card ghost-card';
    // The key reaches the DOM as well as the words, because Softish gives each
    // hint a torn silhouette of its own and CSS has to be able to tell them
    // apart. It cannot do that by position: these are children of #world
    // alongside the web, the shadow layer and the title card, so :nth-child
    // counts things that are not cards and hands two hints the same outline.
    const key = hintKey(metaStr(item.meta?.hint));
    card.dataset.hint = key;
    const { title, line, rows, href, go: goes } = hintFor(metaStr(item.meta?.hint));
    // Every hint but the dial prints its title here, at the head of the card and
    // ranged left. The dial prints its own, inside the row and centred over the
    // track - see below.
    if (key !== DIAL) {
      const head = document.createElement('div');
      head.className = 'ghost-title';
      head.textContent = title;
      card.append(head);
    }

    if (key === DIAL) {
      // A hint you operate rather than read. The range input is what makes
      // canvas/input.ts let the press through - its widget branch names `input`
      // outright, so a drag on the thumb moves the thumb and not the card.
      //
      // .field is the sidebar's own form row, borrowed whole rather than
      // imitated: the track, the lozenge thumb, the stop names underneath and
      // the way all three answer the whimsy axis are one block of CSS in the
      // panel's section, and a second copy of it here would be a second thing to
      // remember. This is the same slider, so it is the same class.
      //
      // The head is .field's own as well, and it carries the title instead of
      // the card printing one: a card's title is ranged left at the top of it,
      // and what this one wants is the word centred over the track it names,
      // with the three stops under it. `is-dial` is that centring.
      const row = document.createElement('div');
      row.className = 'ghost-dial field is-dial';
      const head = document.createElement('span');
      head.textContent = title;
      row.append(head);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '2';
      slider.step = '1';
      // The level the interface is at, read off the attribute ui/appearance.ts
      // writes - the same source watchWhimsy() keeps this in step with.
      slider.value = document.documentElement.dataset.whimsy ?? '1';
      slider.setAttribute('aria-label', title);
      // The detent tick, inline rather than through ui/controls.ts's
      // tickSlider(). That helper is where every other slider in the app gets
      // this, and this one cannot have it: canvas/ may not import ui/, which
      // tests/layers.test.js enforces and architecture.md calls a layering
      // regression rather than a style note. What tickSlider() computes is
      // whether a slider has few enough stops to be worth marking, and this one
      // has three, written two lines up - so the arithmetic it exists for has
      // no work to do here and only the listener is copied.
      let ticked = slider.value;
      slider.addEventListener('input', () => {
        if (slider.value === ticked) return;
        ticked = slider.value;
        cue('pick');
      });

      // The stops, built the way ui/panel.ts builds them: names rather than a
      // <datalist>, which Chromium ignores on a painted track and Firefox draws
      // as ticks whose ends vanish into the rounded ends of it. Hidden from the
      // accessibility tree, because the same three words reach a screen reader
      // through the dial's own aria-valuetext (see bindDial).
      //
      // Under the track, the same way round as the panel: the name of the axis
      // over it, the names of its three stops under it.
      const stops = document.createElement('span');
      // The styling hook is a *class* now, and the id is only the target for
      // aria-describedby. It was one hardcoded id doing both jobs, under a
      // comment saying "safe as an id because a board carries at most one dial
      // card" - which stopped being true when ui/feed.ts started calling this
      // same builder: with the Feed up and the canvas card mounted the document
      // held two elements with that id, and the Feed slider's aria-describedby
      // resolved to the canvas's node. quality.css reaches both whimsy rows
      // through .whimsy-stops and #whimsy-stop-labels.
      stops.className = 'field-stops whimsy-stops';
      stops.id = `ghost-whimsy-stops-${item.id}`;
      stops.setAttribute('aria-hidden', 'true');
      for (const name of STOPS) {
        const stop = document.createElement('span');
        stop.textContent = name;
        stops.append(stop);
      }
      slider.setAttribute('aria-describedby', stops.id);
      row.append(slider, stops);

      bindDial(slider);
      card.append(row);
    } else if (rows) {
      // A legend rather than a paragraph, which is what all three hints print;
      // the prose branch below is the not-found pair's. Icons are built the
      // long way here for the reason
      // canvas/item-dom.ts's anchor badge is: ui/menu.ts's icon() is the helper
      // every other module reaches for and canvas/ may not import ui/.
      //
      // .ico is base.css's, plain screen pixels - which on a card is what is
      // wanted, since the whole card is inside the board transform and a 16px
      // glyph there zooms with the words beside it.
      const list = document.createElement('div');
      list.className = 'ghost-keys';
      for (const { icon, label, desktop } of rows) {
        const row = document.createElement('div');
        row.className = 'ghost-key';
        // Named rather than hidden here: Mobile and Desktop share the item, the
        // card is rebuilt on a layout switch either way, and a row that CSS can
        // drop is one list instead of two. See HintRow in canvas/ghosts.ts.
        if (desktop) row.dataset.only = 'desktop';
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'ico');
        // The words beside it say the same thing, so announcing the glyph as
        // well reads the row out twice.
        svg.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS(SVG_NS, 'use');
        use.setAttribute('href', `assets/icons.svg#${icon}`);
        svg.append(use);
        const word = document.createElement('span');
        word.textContent = label;
        row.append(svg, word);
        list.append(row);
      }
      card.append(list);
    } else {
      const body = document.createElement('div');
      body.className = 'ghost-line';
      body.textContent = line ?? '';
      card.append(body);
      // A hint carrying an href is one you follow. Only the not-found set has
      // one today - the way back off a dead address - and it is built here
      // rather than being a fourth branch because it is still a line of prose;
      // the anchor sits under it as the thing you press. The href comes from
      // the hint, never from the item, so nothing a board could carry can put a
      // link on a card.
      if (href) {
        const go = document.createElement('a');
        go.className = 'ghost-go';
        go.href = href;
        go.textContent = goes || title;
        card.append(go);
      }
    }
    frag.append(card);

    // Built at every tier and shown only at Softish (the CSS hides it
    // otherwise), so sliding the whimsy dial does not have to rebuild a card.
    for (const t of Array.isArray(item.meta?.tape) ? item.meta.tape : []) {
      const strip = document.createElement('div');
      strip.className = 'ghost-tape';
      const { x, y, rot, len } = tapeStyle(t);
      strip.style.setProperty('--t-x', x);
      strip.style.setProperty('--t-y', y);
      strip.style.setProperty('--t-rot', rot);
      strip.style.setProperty('--t-len', len);
      frag.append(strip);
    }
    return frag;
  },

  /**
   * A colour, and the number for it.
   *
   * The third item type with no source file behind it, after the note and the
   * link, and the only one whose whole content is a single value. So the card
   * *is* the editor: the well is a real `<input type="color">` rather than a
   * div with a picker bolted to it, which buys the platform's own colour dialog,
   * the eyedropper where there is one, and keyboard reachability, for nothing.
   *
   * It is also why nothing had to change in canvas/input.ts. That pipeline
   * already yields a press to a native widget - GRIP_YIELD names `input`
   * outright, which is what lets the whimsy dial on the fourth hint card work -
   * so pressing the well opens the picker instead of dragging the card, and
   * pressing anywhere else on it drags as usual.
   *
   * Two events, two jobs. `input` fires continuously while the picker is open
   * and only repaints, so the card follows the cursor through the dialog; only
   * `change`, which fires when the dialog closes, reaches the board - otherwise
   * dragging across a colour wheel would push a hundred entries onto the undo
   * stack for one decision.
   */
  swatch(item: Item) {
    const card = document.createElement('div');
    card.className = 'card swatch-card';
    const hex = swatchHex(item.meta?.hex);

    const well = document.createElement('input');
    well.type = 'color';
    well.className = 'swatch-well';
    well.value = hex;
    well.setAttribute('aria-label', 'Swatch colour');

    const code = document.createElement('div');
    code.className = 'swatch-hex';

    const show = (value: string) => {
      // The colour reaches the stylesheet as a property rather than as an
      // inline background, so items.css decides what is done with it - the well
      // is a colour field at one whimsy tier and a chip on a card at another,
      // and a renderer that wrote `background` would have settled that here.
      card.style.setProperty('--swatch', value);
      code.textContent = value.toUpperCase();
    };
    show(hex);

    well.addEventListener('input', () => show(swatchHex(well.value)));
    well.addEventListener('change', () => setSwatchHex(item.id, well.value));

    card.append(well, code);
    return card;
  },

  /**
   * A specimen of a face the board carries. Dropping a font registers it (a
   * menu entry, in ui/fonts.ts) and, from the same place, drops this card so
   * the letterforms are on the board rather than only in a menu.
   *
   * The family is read off asset.family - the name document.fonts was actually
   * given, which uniqueFamily() may have numbered. The face itself is
   * registered by ui/fonts.ts; this layer cannot reach it (canvas <- ui), so
   * the specimen names the family and lets the cascade match it. It resolves
   * when the face loads and repaints on its own - no listener here.
   */
  font(item: Item) {
    const card = document.createElement('div');
    card.className = 'card font-card';
    const family = fontFamilyOf(item);
    const custom = metaStr(item.meta?.text);
    // The specimen spells the face's own name by default, or whatever the reader
    // typed in its place. Double-click edits it (canvas/input.ts -> notes/font).
    const specimenText = custom || family || titleOf(item);

    card.append(fontSpecimenMark(specimenText, family));

    // A caption naming the face - but only when the specimen is not already its
    // name, or it would print the family twice. Not a .card-name: the family
    // follows asset.family, not the item's editable title.
    if (custom && family) {
      const name = document.createElement('div');
      name.className = 'font-name';
      name.textContent = family;
      card.append(name);
    }
    return card;
  },

  /**
   * The board's own look, as a card on the board: pictures, pigments, faces.
   *
   * This was a 1500x1000 canvas that you saved as a PNG. Making it a card
   * changed what belongs on it, and the two things that came off are the point
   * of the redesign rather than economies:
   *
   *   - **the board's name and the date.** A printed tile needed them because
   *     it was leaving; a card sitting on the board it describes is under the
   *     title card already, and repeating the name is a caption on a caption.
   *   - **a fourth picture.** See TILE_IMAGES. The board is right there behind
   *     it, so the strip is a reminder of the register rather than a contact
   *     sheet standing in for pictures the reader cannot see.
   *
   * **Live, and live without re-rendering.** The swatches are not painted the
   * colours the palette held when the card was made - each one is handed
   * `var(--accent)` and so on as the *value* of its own property, so the
   * stylesheet resolves it against :root every time it paints. Change the
   * palette, or the whimsy dial, and every tile on the board follows in the
   * same frame, with no listener and nothing to invalidate. Only the two face
   * names are text this has to write, and canvas/items.ts refreshes those when
   * the look changes - see repaintStyleTiles().
   *
   * The pictures are *recorded*, not recomputed. `meta.shots` holds the ids the
   * tile was made from, chosen once by tilePictures() when the card was added,
   * so the card means the same thing after a reload and after the board has
   * moved on. A tile that re-picked its own strip on every draw would reshuffle
   * itself whenever anything was dropped, and would describe the board as it is
   * now rather than as it was when you asked - which is the opposite of what a
   * summary on a board is for. An id whose picture has since gone simply drops
   * out of the strip.
   */
  'style-tile'(item: Item) {
    const card = document.createElement('div');
    card.className = 'card style-tile-card';

    // The strip. Cover-cropped into equal boxes on purpose, the same choice the
    // printed tile made: a style tile is about the palette and the register,
    // and three photographs at their own aspect ratios would be a contact sheet.
    const strip = document.createElement('div');
    strip.className = 'style-tile-strip';
    const shots = Array.isArray(item.meta?.shots) ? item.meta.shots : [];
    for (const id of shots) {
      const picture = typeof id === 'string' ? byId(id) : null;
      const hash = picture ? pixelHash(picture) : null;
      const url = hash ? assetURL(hash) : null;
      if (!url) continue;
      const shot = document.createElement('div');
      shot.className = 'style-tile-shot';
      // A property rather than a background, for the reason the swatch gives:
      // items.css decides what is done with it, and a renderer that wrote
      // `background` would have settled that here.
      shot.style.setProperty('--shot', `url("${url}")`);
      strip.append(shot);
    }

    // Eight named swatches in two rows of four, each its own chip with a small
    // label. Buttons, so canvas/input.ts takes a press on one as a widget's and
    // never starts a drag: hovering one shows its hex and a click copies it,
    // both answered by canvas/items.ts's delegated listeners.
    const band = document.createElement('div');
    band.className = 'style-tile-swatches';
    for (const { token, name } of TILE_SWATCHES) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'style-tile-swatch';
      swatch.dataset.token = token;
      swatch.setAttribute('aria-label', `Copy the ${name} colour`);
      const chip = document.createElement('span');
      chip.className = 'style-tile-chip';
      // The indirection that makes this live: the property holds a reference to
      // the token, not the token's current value, so it re-resolves on paint.
      chip.style.setProperty('--chip', `var(${token})`);
      const label = document.createElement('span');
      label.className = 'style-tile-name';
      label.textContent = name;
      // Filled on hover, from the token as it is then.
      const hex = document.createElement('span');
      hex.className = 'style-tile-hex';
      swatch.append(chip, label, hex);
      band.append(swatch);
    }

    const type = document.createElement('div');
    type.className = 'style-tile-type';
    for (const token of ['--font-display', '--font-body']) {
      const face = document.createElement('div');
      face.className = 'style-tile-face';
      face.dataset.token = token;
      // Set in itself, which is the whole reason for printing a face rather
      // than listing it.
      face.style.setProperty('--face', `var(${token})`);
      type.append(face);
    }

    card.append(strip, band, type);
    paintStyleTileFaces(card);
    return card;
  },


  /**
   * A sticker: one shape out of web/assets/stickers.svg, and nothing else.
   *
   * **No `.card` wrapper**, and that is the whole design rather than an
   * omission. Everything else here hands back a card because everything else
   * *is* one - a thing with an edge, a caption and a place to put a picture. A
   * sticker is a shape lying on a picture, and a shape in a bordered box is a
   * card with a star in it, which is a different object.
   *
   * It also means buildContent()'s cover test - `content.classList.contains('card')`
   * - declines to attach a cover here, which is correct and is already how
   * image and video behave. A sticker with a photograph behind it is not a
   * thing.
   *
   * The shape is checked against the catalogue rather than trusted, because the
   * value goes straight into a `<use href>` and arrives from a .mbrd that
   * anybody can edit by hand. An unknown id draws *nothing* - no warning, no
   * failed request, just a hole where the sticker was - so an unknown one falls
   * back to the first shape in the catalogue and the card is at least a
   * sticker. The tint goes through the same gate and onto the artwork itself,
   * which is where items.css reads it from in all five places a sticker is
   * drawn - here, the pad, the pad's drag ghost, a Mobile feed tile and the
   * bin. A colour is not written into a style attribute; the stylesheet keeps
   * the say in what a sticker looks like.
   */
  sticker(item: Item) {
    const shape = stickerShape(item.meta?.shape) ? item.meta.shape : DEFAULT_SHAPE;
    // The wrapper (class, viewBox so the shape scales to the item's size rather
    // than its authored one, aria-hidden) is stickerArt() in the catalogue now.
    const svg = stickerArt(String(shape));
    // stickerTint() answers a tint number; a dataset value is a string, and
    // String() is the conversion the assignment was making unsaid.
    svg.dataset.tint = String(stickerTint(item.meta?.tint, shape));
    return svg;
  },

  /**
   * A fence: a labelled region, and the emptiest renderer here.
   *
   * There is nothing to draw inside one, which is the point - a fence is a
   * boundary and a name, and what fills it is the board showing through. The
   * label is the ordinary `.item-bar` every card carries, moved to the top edge
   * by items.css; building a second caption here would have meant a second thing
   * for a rename to keep in step.
   *
   * The interior does not take presses (items.css again). A fence is large, and
   * a large card that swallowed clicks would end "drag empty space to pan"
   * everywhere inside it - on an infinite canvas, that is most of the gestures
   * somebody has. So the bar is the whole of the fence's hit area: press it to
   * select, drag it to move the region and everything in it, and the resize
   * grips appear on selection like they do for anything else.
   */
  fence(_item: Item) {
    const card = document.createElement('div');
    card.className = 'card fence-card';
    return card;
  },

  /**
   * A tombstone: what is drawn where a file used to be, once the bin was
   * emptied on it.
   *
   * The only card in here that is a record of an absence rather than a picture
   * of something, and the only one nothing on the board can create - it is made
   * by emptyTrash() (trash.ts) and by nothing else, which is why classify()
   * knows nothing about it and never will. Where it turns up is the history: a
   * step that deleted a photograph still replays, and what it now puts back is
   * this rather than a card pointing at bytes that were destroyed. It also
   * turns up in the bin itself for exactly as long as an undo of the emptying
   * keeps it there.
   *
   * Everything it prints comes off `meta.gone`, which is the whole of what was
   * kept: what kind of thing this was, what extension it had, and what it
   * weighed. There is no asset to ask - that is the point of the card - so
   * cardShell() is not reused here even though the head is the same three
   * lines: it reads the registry for the size, and the registry is exactly what
   * no longer has an answer.
   */
  gone(item: Item) {
    const card = document.createElement('div');
    card.className = 'card gone-card';
    card.append(binArt());

    const kicker = document.createElement('div');
    kicker.className = 'card-icon';
    // `meta` is open, so both reads are narrowed rather than trusted - the same
    // treatment every other renderer in this file gives it.
    const raw = item.meta?.gone;
    const gone: Record<string, unknown> = isRecord(raw) ? raw : {};
    const kind = metaStr(gone.type);
    // 'generic' is the classifier's word for "a file, and nothing more is
    // known", which is a sentence about the code rather than about the thing.
    // Something was known, though: the tombstone kept the extension, two lines
    // down, so the catalogue can say what the file had been - "Deleted
    // SolidWorks part" over "Deleted file". The plain word is what is left when
    // there was no extension either.
    const word = !kind || kind === 'generic'
      ? formatName(gone.ext) || 'file'
      : kind;
    kicker.textContent = `Deleted ${word}`;

    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = titleOf(item);

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const ext = metaStr(gone.ext).replace(/^\./, '');
    const bytes = Number(gone.bytes);
    // The same order and the same separator as cardShell()'s foot, so a
    // tombstone reads as the card it replaced rather than as a different kind
    // of object. A size of zero prints nothing: it means the bytes were already
    // missing when the bin was emptied, and "0 B" would be a claim about the
    // file rather than about what is known of it.
    meta.textContent = [bytes > 0 && formatBytes(bytes), ext && ext.toUpperCase()]
      .filter(Boolean).join(' · ');

    card.append(kicker, name, meta);
    return card;
  },

  generic(item: Item) {
    return cardShell(item, extOf(item.name) || 'file');
  },

  /** An archive, dropped whole: its name, and Unzip. See import/unpack.ts. */
  archive(item: Item) {
    return packCard(item, 'archive', 'Unzip', null);
  },

  /** A folder out of an archive or off the disk: its name, how many files, and Open. */
  folder(item: Item) {
    const count = Number(item.meta?.count) || 0;
    return packCard(item, 'folder', 'Open', count ? `${count} file${count === 1 ? '' : 's'}` : '');
  },
};

/**
 * The card an archive or a folder wears: the named card every file wears, and
 * one button under it that gives the card over to what it holds. The press is
 * delegated - canvas/items.ts on the board, ui/feed.ts on the Feed - so a card
 * rebuilt by the cull carries no listener of its own. `foot` replaces the size
 * line when the card has no file of its own to weigh.
 */
const UNPACK = { icon: 'i-arrow-up' };

function packCard(item: Item, kind: string, verb: string, foot: string | null) {
  const card = cardShell(item, kind);
  card.classList.add('pack-card');
  if (foot !== null) {
    const meta = card.querySelector('.card-meta');
    if (meta) meta.textContent = foot;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'card-unpack';
  button.setAttribute('aria-label', `${verb} ${titleOf(item)}`);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `assets/icons.svg#${UNPACK.icon}`);
  svg.append(use);
  const word = document.createElement('span');
  word.textContent = verb;
  button.append(svg, word);
  card.append(button);
  return card;
}

/**
 * The bin, drawn: a can with its lid tipped off it.
 *
 * Built rather than referenced out of icons.svg, and the two are not the same
 * kind of thing. That sprite is chrome - sixteen-pixel glyphs for buttons and
 * menu rows, drawn to be read at one size next to a word. This is the *subject*
 * of a card, the way a sticker's shape is: it fills the space a photograph used
 * to fill, at whatever size the photograph was, so it is drawn for that job and
 * lives beside the renderer that is the only thing which will ever use it.
 *
 * The lid is off rather than on, tilted away from the can, because a shut bin
 * is a place things are kept and an open one is a place they have gone from -
 * which is the entire difference this card is trying to say. Geometry in
 * attributes, colour in items.css: a `style` attribute is refused by the CSP
 * (see CLAUDE.md), and what a card is coloured is the stylesheet's say anyway.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

function binArt() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'gone-bin');
  svg.setAttribute('viewBox', '0 0 24 24');
  // Decorative. The card says "Deleted image" in words directly underneath, so
  // announcing the drawing as well would read the card out twice.
  svg.setAttribute('aria-hidden', 'true');
  const path = (d: string, cls: string) => {
    const node = document.createElementNS(SVG_NS, 'path');
    node.setAttribute('d', d);
    node.setAttribute('class', cls);
    svg.append(node);
    return node;
  };
  // The can: a tapered body with a rounded foot.
  path('M6.3 9.4h11.4l-1 11.1a2.1 2.1 0 0 1-2.1 1.9H9.4a2.1 2.1 0 0 1-2.1-1.9z', 'gone-body');
  // The lid, lifted clear and set down at an angle across the top of it.
  path('M3.9 7.4 19.3 4.3l.5 2.4L4.4 9.8z', 'gone-lid');
  // And its handle, riding the same tilt.
  path('M9.6 5.6 9.2 3.5a1.1 1.1 0 0 1 .9-1.3l3-.6a1.1 1.1 0 0 1 1.3.9l.4 2.1', 'gone-grip');
  // Two ribs down the inside, which is what stops the body reading as a bucket.
  path('M10.4 12.6v6.1M13.6 12.6v6.1', 'gone-ribs');
  return svg;
}

/**
 * Whether a type has a renderer of its own rather than falling back to the
 * generic card.
 *
 * Exported for tests/renderers.test.js, which asserts that everything
 * classify() can return has one. That check is here because its absence is
 * exactly how the text renderer went missing: classify() routed fifty
 * extensions to 'text', defaultSize() sized it, the README advertised it, and
 * nothing anywhere noticed that RENDERERS had no such key. Nothing failed -
 * the files just quietly came out as generic cards.
 */
export const hasRenderer = (type: string) => hasOwn(RENDERERS, type);

/**
 * The URL behind a link item, or null for anything that is not one.
 *
 * Strict on purpose, rather than helpful. A string qualifies only if the URL
 * parser accepts the whole of it and what came out was http or https, so
 * `www.example.com` and `example.com/things` are text and stay text: deciding
 * they meant `http://` is a guess, and a guess of that kind silently rewrites
 * what somebody wrote. Whitespace anywhere disqualifies it too, because
 * `have a look at https://example.com` is a sentence about a link rather than
 * a link - and both places that call this mean "this and nothing else".
 *
 * The scheme test is the security half, and an allowlist of exactly two is the
 * only shape of it that cannot be argued around. `javascript:` runs code in
 * this page with this page's privileges; `data:` carries a whole document that
 * arrives with no origin to be judged by; `file:` reaches into the machine.
 * None of the three may ever reach an href.
 *
 * The hostname test never fires as things stand - http and https are "special"
 * schemes and the parser will not hand back one of those without a host. It is
 * written down anyway, because the line under it feeds an href and a guarantee
 * an href rests on should be stated where it is relied on rather than inferred
 * from what a parser happens to do.
 */
export function linkURL(text: unknown): URL | null {
  const s = String(text ?? '').trim();
  if (!s || /\s/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.hostname ? u : null;
}

/**
 * Parse a typed address. Unlike linkURL(), prepends `https://` when no scheme
 * is present — intent is unambiguous from an "Add a link" or Properties box.
 * Lives here beside linkURL so the address parsing has one home; commands.ts
 * and the Properties dialog (ui/link-props.ts) both read it without either
 * importing the other.
 */
export function linkTyped(text: string): URL | null {
  const direct = linkURL(text);
  if (direct) return direct;
  // Already has a scheme (including mailto: etc.) — don't double-prefix.
  return /^[a-z][a-z0-9+.-]*:/i.test(text.trim()) ? null : linkURL('https://' + text.trim());
}

/**
 * The item a URL becomes, shared by both doors a link comes in through - a
 * paste onto the board and a sticky note that turns out to hold nothing but an
 * address - so that the two produce the same thing rather than two things that
 * merely look alike.
 *
 * meta.url is stored as the parser's own serialisation rather than as typed,
 * so the string the card later hands to an href has already been through a URL
 * parser once before it gets there.
 */
export function linkDraft(u: URL) {
  const size = defaultSize('link');
  // A player comes in at the size it would grow to on open (embedFloor), not the
  // smaller link default it would then have to jump up from - so a pasted
  // Spotify track lands at the player's minimum and never gets in undersized.
  // Per axis, so YouTube (fluid, no width floor) keeps the wider link default.
  const spec = embedFor(u);
  if (spec) {
    const floor = embedFloor(spec);
    return {
      type: 'link', name: linkName(u), meta: { url: u.href },
      w: Math.max(size.w, floor.w), h: Math.max(size.h, floor.h),
    };
  }
  return { type: 'link', name: smartLinkName(u), w: size.w, h: size.h, meta: { url: u.href } };
}

/**
 * What a link is called before anybody renames it. The site by default, but a
 * couple of sites carry the useful name in the address itself: a Steam store URL
 * spells the game in its slug, a Reddit URL spells the subreddit. Reading it off
 * the path fetches nothing and is exact, so the chip says "ULTRAKILL" or "r/pics"
 * rather than the bare host. A rename still overrides it (it becomes item.name).
 */
function smartLinkName(u: URL): string {
  return steamGame(u) ?? redditSub(u) ?? linkName(u);
}

// The game a Steam store link points at: the slug after /app/<id>/, underscores
// back to spaces, capped so a long title does not push the chip past the card.
function steamGame(u: URL): string | null {
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'store.steampowered.com' && host !== 'steamcommunity.com') return null;
  const m = /\/app\/\d+\/([^/]+)/.exec(u.pathname);
  if (!m) return null;
  try { return decodeURIComponent(m[1]).replace(/[_+]/g, ' ').trim().slice(0, 20); }
  catch { return m[1].replace(/[_+]/g, ' ').slice(0, 20); }
}

// The subreddit a Reddit link is under: /r/<name>. Null for a user page or the
// front page, which fall back to the host.
function redditSub(u: URL): string | null {
  const host = u.hostname.replace(/^(www|old|new|np)\./, '').toLowerCase();
  if (host !== 'reddit.com') return null;
  const m = /^\/r\/([^/]+)/i.exec(u.pathname);
  return m ? `r/${m[1]}` : null;
}

/** What a link is called before anybody renames it: the site it points at. */
function linkName(u: URL): string {
  // `www.` is the one part of a hostname that identifies nothing - it is a
  // convention about a server, not about whose site this is - and the address
  // line below keeps it anyway, so nothing is being hidden by dropping it here.
  return u.hostname.replace(/^www\./, '');
}


/**
 * The offer chip on a plain link card: the site's mark, then the address, as one
 * anchor in the middle of the card. The same shape as a player's offer button
 * (embed.ts offerButton) so the two families match, but an <a> rather than a
 * button - a link's press is to open the page, not to swap in a frame.
 *
 * The text sits in a .card-name span so F2 renames it in place (canvas/items.ts
 * editItemName reads .card-name, and writing item.name over it must not wipe the
 * mark beside it). The click swallow is the anchor's, for the same two reasons
 * the old link name had: a caret placed while editing must not also navigate,
 * and a double click is the canvas zoom, not two opened tabs.
 */
function linkChip(item: Item, u: URL): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'embed-go';
  a.dataset.provider = 'link';
  // Set as properties on a real element, only after linkURL()'s scheme check -
  // never assembled into markup, which is what keeps this app sanitiser-free.
  a.href = u.href;
  a.target = '_blank';
  // noopener is load-bearing: without it the opened page gets a window.opener
  // handle on the board and can navigate it away. noreferrer keeps the board's
  // address off the far end's logs. Both written out, not left to be implied.
  a.rel = 'noopener noreferrer';
  a.draggable = false;
  a.title = u.href;
  const span = document.createElement('span');
  span.className = 'card-name';
  span.textContent = item.name || smartLinkName(u);
  a.append(linkGlyph(u), span);
  a.addEventListener('click', (e: MouseEvent) => {
    if (e.detail > 1 || a.closest('.is-editing')) e.preventDefault();
  });
  return a;
}

/** The mark for the chip: a known site's bundled logo in its own colour, or a
 *  plain globe drawn in the board ink for a site with no mark (brands.ts).
 *  Exported so the Feed's link tile (ui/feed.ts) draws the same mark the canvas
 *  card does. */
export function linkGlyph(u: URL): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'embed-brand');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const brand = brandFor(u);
  if (brand) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', brand.path);
    p.setAttribute('fill', brand.color || 'currentColor');
    svg.append(p);
    return svg;
  }
  // Globe: circle, equator, meridian - stroked in the ink, no fill.
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '9');
  const equator = document.createElementNS(SVG_NS, 'path');
  equator.setAttribute('d', 'M3 12h18');
  const meridian = document.createElementNS(SVG_NS, 'ellipse');
  meridian.setAttribute('cx', '12'); meridian.setAttribute('cy', '12');
  meridian.setAttribute('rx', '4'); meridian.setAttribute('ry', '9');
  svg.append(circle, equator, meridian);
  return svg;
}

/**
 * Whether a picture moves. GIF and APNG announce themselves in the type or the
 * extension; an animated WebP does not, and telling one from a still WebP means
 * parsing the container - so it is left out rather than guessed at.
 */
function isAnimated(item: Item) {
  const mime = metaStr(item.meta?.mime).toLowerCase();
  const ext = (metaStr(item.meta?.ext) || extOf(item.name) || '').toLowerCase();
  return mime === 'image/gif' || mime === 'image/apng' || ext === 'gif' || ext === 'apng';
}

/** Icon badge + name + size - the shared head of every non-visual card. */
/**
 * What to print as a card's title.
 *
 * The extension goes, as it always did, and so does whatever punctuation the
 * name ended on once it has. Files come off a phone, a downloader or a ripper
 * ending in an underscore, a dash or a run of dots - "001 - Clairo - Hello_" -
 * and a trailing separator is not part of anybody's title; it is the seam where
 * the extension used to be, or where a character the filesystem would not take
 * got replaced. Leading ones go for the same reason.
 *
 * Only the edges. Separators *inside* the name are how the person who saved it
 * wrote it down, and are none of this function's business.
 */
function titleOf(item: Item) {
  const stem = baseName(item.name) || item.name || '';
  return stem.replace(/^[\s._-]+|[\s._-]+$/g, '') || stem || 'untitled';
}

/** The registered family a font card should paint in, or '' if it has none.
 *  `'family' in` narrows off the reserved external-asset arm, which has no
 *  family; the type guard covers a hand-edited .mbrd that wrote a non-string. */
export function fontFamilyOf(item: Item): string {
  const asset = item.asset;
  if (asset && 'family' in asset && typeof asset.family === 'string') return asset.family;
  return '';
}

function cardShell(item: Item, kind: string) {
  const card = document.createElement('div');
  card.className = 'card';

  const icon = document.createElement('div');
  icon.className = 'card-icon';
  icon.textContent = kind;

  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = titleOf(item);

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const asset = item.asset && getAsset(item.asset.hash);
  // The extension, not the family and its category. Those two were printed
  // together and on a great many files they say the same thing twice - "Sound ·
  // Audio" on every mp3, over a kicker already reading AUDIO. The format is the
  // part that is not already on the card: what kind of thing this is has been
  // said by the kicker, the icon and the shape of the card itself.
  //
  // The family label is the fallback rather than the first choice, for the
  // extensions the catalog knows by name but that mean nothing read aloud, and
  // the MIME type is the last resort it always was.
  const ext = (metaStr(item.meta.ext) || extOf(item.name) || '').replace(/^\./, '');
  const known = describeExt(ext);
  const what = ext ? ext.toUpperCase() : (known ? known.label : item.meta.mime);
  meta.textContent = [asset && formatBytes(asset.size), what].filter(Boolean).join(' · ');

  card.append(icon, name, meta);
  return card;
}

/**
 * Resize an item to its media's real aspect ratio, once, on first load. Keeps
 * the placeholder's area so a portrait photo doesn't land as a letterboxed
 * landscape box. Not undoable on purpose - it's part of arriving, not an edit.
 *
 * The long side is capped at the placeholder's own long side. Without that, a
 * 1:3 panorama would grow past the cell the arrangement reserved for it *after*
 * the layout ran, and land on its neighbours. Capping also keeps a wall of
 * mixed-aspect photos at a consistent visual weight.
 */
function adoptAspect(item: Item, nw: number, nh: number) {
  if (!nw || !nh) return;
  const live = byId(item.id);
  if (!live || live.meta.sized) return;
  live.meta.sized = true;

  const ratio = nw / nh;
  const area = live.w * live.h;
  const cap = Math.max(live.w, live.h);
  let w = Math.sqrt(area * ratio);
  let h = Math.sqrt(area / ratio);
  const over = Math.max(w, h) / cap;
  if (over > 1) { w /= over; h /= over; }

  // Back onto the lattice if the board is snapped. addItems() already put this
  // item in a cell on the way in; without this, the one class of media that
  // could not be measured before it landed would quietly step off the grid a
  // moment later, in front of the person who just dropped it.
  if (board.settings.snap) {
    const box = latticeBox({ x: live.x, y: live.y, w, h }, baseStep());
    w = box.w; h = box.h;
  }

  live.w = Math.round(w);
  live.h = Math.round(h);
  bus.emit('geom', [live.id]);
  markDirty();
}

/**
 * Object-fit for an item. Only photos and videos are steerable: they take their
 * own meta.fit if it is set, otherwise the board-wide default (board.mediaFit),
 * otherwise fill. Everything else is always contained, as it has always been.
 */
export function fitMode(item: Item) {
  if (item.type !== 'image' && item.type !== 'video') return 'contain';
  const own = item.meta?.fit;
  if (own === 'cover' || own === 'contain') return own;
  return board.mediaFit === 'contain' ? 'contain' : 'cover';
}
