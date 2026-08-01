// One renderer per item type: classification, a default size, and the DOM that
// goes inside a card. Adding a new type means adding an entry to RENDERERS and
// a branch in classify() - nothing else in the app needs to know about it.

import { extOf, baseName, formatBytes } from '../util.js';
import { assetURL, getAsset, readText } from '../storage/assets.js';
import { byId, bus, markDirty, board, NOTE_MAX, isDefaultTitle } from '../state.js';
import { latticeBox } from '../geometry.js';
import { describeExt, PHOTO_EXTS, AUDIO_EXTS, VIDEO_EXTS, SVG_EXTS } from '../import/formats.js';
import { buildTransport, registerPlayer } from './audio.js';
import { buildVideoPlayer } from './video.js';
import { onTouch } from './viewport.js';
import { embedFor, embedOffer } from './embed.js';
import { buildModelCard } from './model.js';
import { hintFor, hintKey, tapeStyle, bindDial, STOPS, DIAL } from './ghosts.js';
import { ensureDisplay, displayURLReady } from './display.js';
import { meshKind } from '../mesh.js';


/**
 * How much of a text file a card shows.
 *
 * The same number readText() defaults to, named here because this is where it
 * means something: a card is a preview on a board, not a viewer. Past this the
 * body is marked clipped so the card can say so rather than appearing to be
 * the whole file.
 */
const TEXT_PREVIEW = 20000;

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml',
  'ini', 'cfg', 'conf', 'toml', 'js', 'mjs', 'ts', 'jsx', 'tsx', 'css', 'scss',
  'html', 'htm', 'py', 'rb', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'cs',
  'java', 'kt', 'swift', 'php', 'sh', 'bat', 'ps1', 'sql', 'srt', 'vtt',
]);

/**
 * Item type for a dropped File. MIME first, extension as the fallback.
 *
 * Only four things actually render today - picture, moving picture, sound,
 * text - because those are what a browser can draw with no help. Everything
 * else becomes a named card; formats.js knows what ~1350 extensions *are*, so
 * a .sldprt says "SolidWorks" rather than "file". Real viewers for the rest
 * can slot in later without this routing changing.
 */
export function classify(file) {
  const mime = (file.type || '').toLowerCase();
  const ext = extOf(file.name);
  if (mime.startsWith('image/') || SVG_EXTS.has(ext)) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  // Before the text branch, not after it. An .obj and a .gltf are both plain
  // text and arrive as `text/plain` from half the systems that hand them over,
  // so testing MIME first would route every model a person owns to the text
  // renderer and print its vertex list.
  if (meshKind(file.name)) return 'model';
  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  // The catalog's sets are broader than the MIME types a browser bothers to
  // set - .jxl, .avif and friends often arrive with an empty file.type.
  if (PHOTO_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'generic';
}

/**
 * Starting size in world units. Media items refine this once they load.
 *
 * Every box here except the two noted below was taken in by a fifth on each
 * side - a dropped folder arrived too heavy, each card claiming more of the
 * board than the glance it is worth. Card type stays fixed while the box
 * shrinks, so a smaller card is genuinely a smaller card and not a scaled
 * photograph of one; that is the point, but it does mean the head of a card
 * (badge, name, size) now costs proportionally more of it, which is why the
 * two types whose whole value is the body they show are left alone.
 */
export function defaultSize(type) {
  switch (type) {
    case 'image':   return { w: 256, h: 192 };
    case 'video':   return { w: 288, h: 162 };
    case 'audio':   return { w: 264, h: 157 };
    // Not shrunk. A text card is a wall of words at a fixed size, so taking a
    // fifth off each side would show a third less of the file - the one thing
    // the card is for.
    case 'text':    return { w: 300, h: 360 };
    // Square-ish, because a model has no aspect of its own until it is read -
    // it is framed from its bounding sphere, so it fills whatever box it gets.
    case 'model':   return { w: 224, h: 224 };
    // Square: a sticky comes off a square pad. Small, too - a note is an
    // annotation on the board, not a thing on it, and at the old 240 it
    // outweighed most of the photos it was written about. Well clear of
    // MIN_SIZE (48) in canvas/input.js, so the resize floor is unchanged.
    // Already the small one, and left at 120 while everything around it came
    // down - the gap it was written to hold has simply closed a little.
    case 'note':    return { w: 120, h: 120 };
    // Wide and short: an address is a wide thing, and there is no body under
    // it - a link card is a name, a URL, and nothing else.
    case 'link':    return { w: 256, h: 106 };
    // Four grid spaces wide and 3:2 tall (256 * 2/3 = 170.67) - the masthead's
    // aspect. Matches TITLE_SIZE in state.js, where the singleton is minted; the
    // card visual is held to an exact 3:2 in CSS and snapping adds slack below.
    case 'title':   return { w: 256, h: 171 };
    // Four grid spaces by three at the default step, so a snapped board lays it
    // down exactly where it already is. Fixed: a ghost has no resize grips
    // (canvas/items.js), so this is not a starting size the way every box above
    // it is - it is the size. Matches GHOSTS in state.js, where they are minted
    // and where the reasoning lives.
    case 'ghost':   return { w: 256, h: 192 };
    default:        return { w: 200, h: 112 };
  }
}

/**
 * True size for a file, measured *before* it becomes an item.
 *
 * This has to happen up front: the arrangement engine reserves a cell per item,
 * so if a portrait photo only discovered it was portrait after the layout ran,
 * it would grow past its cell and sit on its neighbours. Measuring first makes
 * every layout exact. Falls back to the placeholder size if the media can't be
 * decoded - adoptAspect() then picks it up later, capped so it can't overflow.
 */
export async function measureSize(type, file) {
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
      ? { ...fitToBox('image', natural.w, natural.h), measured: true, decodable: true }
      : { ...box, decodable: true };
  }
  try {
    const natural = type === 'image' ? await imageSize(file) : await videoSize(file);
    // An image the browser cannot decode (HEIC, JXL, camera RAW) is reported
    // so the importer can fall back to a named card instead of a broken <img>.
    if (!natural) return { ...box, decodable: false };
    return { ...fitToBox(type, natural.w, natural.h), measured: true, decodable: true };
  } catch {
    return { ...box, decodable: false };
  }
}

/** An SVG, by MIME or by extension - the same either/or classify() uses. */
function isSvgImage(file) {
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
async function svgSize(file) {
  const text = (await file.text()).slice(0, 4096);
  const tag = text.match(/<svg\b[^>]*>/i)?.[0] || '';
  const w = parseFloat(tag.match(/\bwidth\s*=\s*["']?\s*([\d.]+)\s*(?:px)?["'\s>]/i)?.[1]);
  const h = parseFloat(tag.match(/\bheight\s*=\s*["']?\s*([\d.]+)\s*(?:px)?["'\s>]/i)?.[1]);
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
 * fact by a different path (see import/drop.js). Both have to land on the same
 * arithmetic or the same clip would be a different size depending on which route
 * discovered its shape.
 */
export function fitToBox(type, w, h) {
  const box = defaultSize(type);
  if (!(w > 0 && h > 0)) return box;
  const area = box.w * box.h;
  const ratio = w / h;
  return { w: Math.round(Math.sqrt(area * ratio)), h: Math.round(Math.sqrt(area / ratio)) };
}

async function imageSize(file) {
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

function videoSize(file) {
  const url = URL.createObjectURL(file);
  return new Promise(resolve => {
    const v = document.createElement('video');
    // Never let one unreadable file stall a whole drop.
    const done = size => { clearTimeout(timer); v.removeAttribute('src'); URL.revokeObjectURL(url); resolve(size); };
    const timer = setTimeout(() => done(null), 2000);
    v.preload = 'metadata';
    v.muted = true;
    v.addEventListener('loadedmetadata', () => done(v.videoWidth ? { w: v.videoWidth, h: v.videoHeight } : null), { once: true });
    v.addEventListener('error', () => done(null), { once: true });
    v.src = url;
  });
}

/**
 * How wide a video's own first frame is kept.
 *
 * A poster is drawn full-bleed at card size, so it wants more than a cover's 600
 * corner-thumbnail ceiling and much less than the clip's own resolution - a 4K
 * phone video's first frame is a three-megabyte JPEG nobody needs to see a
 * still of. 640 covers a mobile card at two device pixels per point and a
 * desktop card at one, which is the whole job.
 */
const POSTER_SIDE = 640;

/** How long a frame grab may take before the clip is left without one. */
const POSTER_MS = 6000;

/**
 * The first frame of a clip, as a WebP blob, or null.
 *
 * This exists because of what a video card looks like before it is played. On a
 * touch device the source is deliberately held back until the first tap - see
 * the video renderer, and the decoder ceiling that forces it - so a clip with
 * nothing to show is a black rectangle with a play button on it. The desktop
 * path gets a frame for free by loading metadata at `#t=0.1`; the mobile path
 * loads nothing at all, and so has to be *given* a picture at import.
 *
 * The browser's own decoder does the work, which is the point: the ffmpeg
 * poster path in optimize/media.js is thirty megabytes off a CDN and is only
 * reached for a clip this browser cannot open at all. A clip it *can* open
 * needs none of that - it needs a seek and a drawImage.
 *
 * Everything here degrades to null, and null is not a failure: it means the
 * card is exactly what it was before any of this existed. The refusals worth
 * naming are a decoder that will not seek without playback (older iOS), a clip
 * whose first frame is genuinely black, and a browser that will not write WebP.
 * The blank check is deliberately crude - a solid-colour frame compresses to
 * almost nothing - because storing a black rectangle as a picture of a black
 * rectangle is strictly worse than storing no picture.
 */
export function videoFrame(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  return new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.pause?.();
      v.removeAttribute('src');
      v.load?.();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), POSTER_MS);

    // Muted and inline are not cosmetic: an unmuted video may not be allowed to
    // play at all without a gesture, and on iOS a video that has never played
    // draws as a transparent rectangle onto a canvas however far it has seeked.
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.addEventListener('error', () => done(null), { once: true });

    v.addEventListener('loadedmetadata', () => {
      if (!v.videoWidth) return done(null);
      // A hair past zero rather than zero. Plenty of clips open on a frame of
      // black - a fade-in, a slate - and the first tenth of a second is far
      // enough in to have a picture while still being "the start of the clip".
      const at = Number.isFinite(v.duration) && v.duration > 0
        ? Math.min(0.1, v.duration / 2)
        : 0.1;
      // Some decoders will not produce a frame for a video that has never run,
      // and answer a seek with the poster-frame nothing. Starting it and
      // stopping it immediately costs a few milliseconds and is what makes this
      // work on the devices the whole feature is for. Failure is ignored: where
      // play() is refused, the seek alone is usually enough.
      v.play().then(() => v.pause(), () => {}).finally(() => { v.currentTime = at; });
    }, { once: true });

    const grab = () => { capture(v).then(done, () => done(null)); };
    // requestVideoFrameCallback fires when a frame has actually been presented,
    // which 'seeked' does not promise - it says the seek finished, not that
    // there is anything on the element yet.
    if (typeof v.requestVideoFrameCallback === 'function') {
      v.addEventListener('seeked', () => v.requestVideoFrameCallback(grab), { once: true });
    } else {
      v.addEventListener('seeked', grab, { once: true });
    }

    v.src = url;
  });
}

/** Draw whatever the element is showing into a capped WebP. */
async function capture(v) {
  const scale = Math.min(1, POSTER_SIDE / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.max(1, Math.round(v.videoWidth * scale));
  const h = Math.max(1, Math.round(v.videoHeight * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(v, 0, 0, w, h);
  const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.72 });
  // The same trap the picture shrinker guards - a browser that cannot write
  // WebP hands back a PNG - plus the blank frame described above. 2 KB is well
  // under any real photograph at this size and well over any flat colour.
  if (!out || out.type.toLowerCase() !== 'image/webp' || out.size < 2048) return null;
  return { blob: out, w: v.videoWidth, h: v.videoHeight };
}

/** Build the inner DOM for an item. Async content fills itself in afterwards. */
export function buildContent(item) {
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
  if (cover && content.classList?.contains('card')) {
    content.classList.add('has-cover');
    content.prepend(cover);
  }
  return content;
}

/**
 * The picture an item was given, or null. See setItemCover() in state.js.
 *
 * Null when the hash names nothing, which is a real state and not a fault: a
 * board can be opened from a .mbrd whose assets are still being registered, and
 * a card with no cover is what it looked like before anyway. The alternative -
 * an <img> with no src - is a broken-image icon on a card that was fine.
 */
function coverEl(item) {
  const url = item.meta?.cover ? assetURL(item.meta.cover) : null;
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

// ---------------------------------------------------------------------------
// Sticky-note formatting model
//
// A note used to be a title and a body split on the first newline. It is now a
// short run of formatted blocks - a heading, a subheading, paragraphs - each
// with its own alignment, over a note-level font, size and vertical placement.
//
// The structured form lives in `meta.rich`; `meta.text` stays the one plaintext
// value, Markdown-flavoured (`# ` heading, `## ` subheading), so search, linkify
// and older readers keep working and a note round-trips through a reader that
// has never heard of `meta.rich`. When both are present `meta.rich` is the truth
// and `meta.text` is what it flattens to.
//
// Everything here is pure and free of the DOM on purpose (barring the two
// element builders at the end): the renderer, the editor (canvas/notes.js) and
// the tests all read the one model through these functions.
// ---------------------------------------------------------------------------

export const NOTE_TAGS = ['h1', 'h2', 'p'];
export const NOTE_ALIGNS = ['left', 'center', 'right'];
export const NOTE_VALIGNS = ['top', 'middle', 'bottom'];

/**
 * The font families a note may wear, as an allowlist. The value reaches the DOM
 * as a `font-family` string, so it is only ever chosen from this table and never
 * taken from a file - the same rule the token allowlist keeps for the board.
 */
export const NOTE_FONTS = {
  sheet: 'var(--font-display)',
  sans: 'system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
};
export const NOTE_FONT_KEYS = Object.keys(NOTE_FONTS);

/** Size is a multiplier on the note's own zoom-scaled type, not an absolute. */
export const NOTE_SIZE_MIN = 0.7;
export const NOTE_SIZE_MAX = 1.8;
export const NOTE_SIZE_STEP = 0.1;

const clampSize = n =>
  Math.min(NOTE_SIZE_MAX, Math.max(NOTE_SIZE_MIN, Number.isFinite(+n) ? +n : 1));

/** The Markdown marker a tag writes at the head of its line. */
export const NOTE_MARKER = { h1: '# ', h2: '## ', p: '' };

/** The block a single line of Markdown-ish text describes, given its position. */
function lineToBlock(line, index) {
  if (line.startsWith('## ')) return { tag: 'h2', align: 'left', text: line.slice(3) };
  if (line.startsWith('# ')) return { tag: 'h1', align: 'left', text: line.slice(2) };
  // No marker: the first line is the note's title, as it always was, so a note
  // written before meta.rich existed still reads titled. The rest is body.
  return { tag: index === 0 ? 'h1' : 'p', align: 'left', text: line };
}

/** Blocks from the plaintext fallback - a legacy note, or an older reader's file. */
export function parseNoteText(text) {
  const lines = String(text ?? '').split('\n');
  return lines.map(lineToBlock);
}

/** One clean block, or null to drop it. */
function normalizeBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    tag: NOTE_TAGS.includes(raw.tag) ? raw.tag : 'p',
    align: NOTE_ALIGNS.includes(raw.align) ? raw.align : 'left',
    // One line per block: a stray newline in stored text would otherwise smuggle
    // a second, unstyled line into a block the editor cannot address.
    text: typeof raw.text === 'string' ? raw.text.replace(/\n/g, ' ') : '',
  };
}

/**
 * The formatting model for a note: `meta.rich` when it is well-formed, otherwise
 * parsed back from `meta.text`. Always returns a usable object with at least one
 * block, so the renderer and the editor never have to branch on absence. The
 * total text is held to NOTE_MAX here as well as in the editor, so a hand-edited
 * file cannot get a novel onto a sticky.
 */
export function normalizeNoteRich(rich, text = '') {
  let blocks = Array.isArray(rich?.blocks)
    ? rich.blocks.map(normalizeBlock).filter(Boolean)
    : parseNoteText(text);
  if (!blocks.length) blocks = [{ tag: 'h1', align: 'left', text: '' }];
  // Trim from the end until the flattened text fits, keeping at least one block.
  let budget = NOTE_MAX;
  blocks = blocks.filter((b, i) => {
    const cost = NOTE_MARKER[b.tag].length + b.text.length + (i ? 1 : 0);
    if (budget <= 0 && i) return false;
    budget -= cost;
    return true;
  });
  if (budget < 0) {
    const last = blocks[blocks.length - 1];
    last.text = last.text.slice(0, Math.max(0, last.text.length + budget));
  }
  return {
    font: NOTE_FONT_KEYS.includes(rich?.font) ? rich.font : 'sheet',
    size: clampSize(rich?.size),
    valign: NOTE_VALIGNS.includes(rich?.valign) ? rich.valign : 'top',
    blocks,
  };
}

/**
 * The plaintext a rich model flattens to - the Markdown that lands in meta.text.
 * Font, size, alignment and vertical placement have no plaintext form and are
 * simply absent from it; that is the deal meta.text makes to stay portable.
 */
export function flattenNoteRich(rich) {
  return normalizeNoteRich(rich).blocks
    .map(b => NOTE_MARKER[b.tag] + b.text)
    .join('\n');
}

/** Write a note's board-wide look onto its rich wrapper (font, size, vAlign). */
export function applyNoteStyle(wrap, rich) {
  wrap.style.fontFamily = NOTE_FONTS[rich.font];
  wrap.style.setProperty('--note-scale', rich.size);
  wrap.dataset.font = rich.font;
  wrap.dataset.valign = rich.valign;
}

/** One block as an editable line element. */
export function buildNoteLine(block) {
  const line = document.createElement('div');
  line.className = `note-line note-${block.tag} al-${block.align}`;
  line.textContent = block.text;
  return line;
}

const RENDERERS = {
  image(item) {
    const img = document.createElement('img');
    img.alt = item.name || '';
    img.decoding = 'async';
    img.draggable = false;
    img.addEventListener('load', () => adoptAspect(item, img.naturalWidth, img.naturalHeight), { once: true });
    // The picture is mounted at a bounded display resolution, not the native
    // original: a full-res <img> is tens of megabytes of decode held for a
    // card a few hundred pixels wide, and a whole board of them mounted at once
    // (zoom-out) is what crashes Safari on a phone. canvas/display.js makes a
    // card-sized copy once per session, serialized so only one full decode is
    // ever live, and the original stays in the asset store for export/optimize.
    //
    // Animated and vector pictures keep the original - a downscaled GIF is a
    // still, and an SVG is already resolution-free, so neither wants a raster
    // copy. Those, and any picture whose copy is not made yet, fall back to the
    // original URL; while a copy renders the card shows its thumbnail if it has
    // one (set on the twin below), never the full-res original.
    const hash = item.asset?.hash;
    const vector = (getAsset(hash)?.mime || '').toLowerCase().includes('svg');
    if (hash && !isAnimated(item) && !vector) {
      const ready = displayURLReady(hash);
      if (ready) {
        img.src = ready;
      } else {
        const thumb = item.meta?.thumb && assetURL(item.meta.thumb);
        if (thumb) img.src = thumb;   // crisp-enough stand-in while the copy renders
        ensureDisplay(hash).then(u => { if (u && img.isConnected) img.src = u; });
      }
    } else {
      const url = hash && assetURL(hash);
      if (url) img.src = url;
    }

    // Both kinds of picture can travel with a twin, and the twin works the
    // same way either way: a sibling <img class="still"> that app.css shows
    // instead of this one once #world is marked zoomed-out. Two sources for
    // it, and they are the two halves of the same idea.
    //
    // An animation's twin is shot live by canvas/stills.js, because what
    // should freeze is the frame that was on screen - not frame one.
    //
    // A still photograph's twin is the hundred-pixel copy made at import
    // (see thumbFor() in import/drop.js). It is the cheap half of the feature:
    // zoomed out past the rung, a board of two hundred photographs draws two
    // hundred hundred-pixel WebPs instead of two hundred full-size decodes,
    // at a size where the difference is not visible because a card is under a
    // hundred pixels wide there.
    //
    // Never both. An animated file with a thumbnail would have stills.js
    // overwrite the thumbnail's src on the first pass, so the thumbnail is
    // simply not made for one - makeThumb() refuses animated input.
    const animated = isAnimated(item);
    const thumb = !animated && item.meta?.thumb && assetURL(item.meta.thumb);
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
   * board that will not stop talking. See canvas/video.js for the controls,
   * which is also where this is registered for the global volume and for the
   * one-clip-at-a-time rule the audio cards already follow.
   */
  video(item) {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.playsInline = true;
    v.draggable = false;
    v.addEventListener('loadedmetadata', () => adoptAspect(item, v.videoWidth, v.videoHeight), { once: true });
    // A frame pulled out of the file at import, for a clip this browser cannot
    // open at all - H.265 is the case, see firstFrame() in optimize/media.js.
    // Set as the poster rather than drawn as a card cover, because a video *is*
    // its picture: the card then shows the clip, full bleed and the right shape,
    // instead of the black rectangle a refused codec leaves behind. It costs
    // nothing on a clip the browser can play, since the first frame it decodes
    // paints straight over the poster.
    const poster = item.meta?.cover ? assetURL(item.meta.cover) : null;
    if (poster) v.poster = poster;
    const url = item.asset && assetURL(item.asset.hash);
    if (onTouch()) {
      // On a touch device the source is held back until the first play. A <video>
      // with a src (even preload=metadata, even just to paint a poster frame)
      // holds a decoder, and iOS rations simultaneous video decoders hard - a
      // board of parked clips all mounted at once, which is what zooming out
      // does, exceeds the ceiling and crashes the tab. Parked here, a clip is an
      // inert element with no decoder; buildVideoPlayer attaches the source on
      // the first toggle. A poster shows the frame meanwhile if the clip has one;
      // without one the card is its play button over black until tapped.
      v.preload = 'none';
      if (url) v.dataset.src = url;
    } else {
      v.preload = 'metadata';
      // #t=0.1 pulls a real frame as the poster instead of a black rectangle.
      if (url) v.src = url + '#t=0.1';
    }
    // A fragment so both land as siblings inside .item-body, the same way an
    // animated picture travels with its still.
    const pair = document.createDocumentFragment();
    pair.append(v, buildVideoPlayer(item, v));
    return pair;
  },

  /**
   * A player the board owns, rather than the browser's grey plastic one.
   *
   * The <audio> element is still what plays the sound - it handles streaming,
   * seeking and codecs, and nothing here would be improved by reimplementing
   * that - but it is kept out of the layout entirely and driven by the button
   * and the bars. See canvas/audio.js for the waveform and the global volume.
   */
  audio(item) {
    const card = cardShell(item, 'audio');
    card.classList.add('card-audio');

    const sound = document.createElement('audio');
    sound.preload = 'metadata';
    const url = item.asset && assetURL(item.asset.hash);
    if (url) sound.src = url;
    registerPlayer(sound, item);

    card.append(buildTransport(item, sound), sound);
    return card;
  },

  /**
   * A note is a short run of formatted lines - a heading, a subheading,
   * paragraphs - each an editable block with its own alignment, laid out in a
   * `.note-rich` column that carries the note's font, size and vertical
   * placement. The model is normalizeNoteRich(): meta.rich when it is there,
   * meta.text parsed back when it is not, so a legacy note still reads titled.
   * canvas/notes.js edits the same blocks and writes both halves back.
   */
  note(item) {
    const card = document.createElement('div');
    card.className = 'card';
    const rich = normalizeNoteRich(item.meta.rich, item.meta.text);
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
   * name, canvas/items.js editing .card-name in place exactly as it does on
   * every other card. What a name can never do is hide where the link goes:
   * the address under it is drawn from the URL and from nothing else, so a
   * card called "the good one" still says out loud that it leads to
   * example.com.
   *
   * classify() is not involved and never will be - it sorts *files*, and a
   * link arrives as text, from a paste (import/drop.js) or from a sticky note
   * that turned out to hold nothing else (canvas/notes.js).
   */
  link(item) {
    const card = document.createElement('div');
    card.className = 'card card-link';

    const icon = document.createElement('div');
    icon.className = 'card-icon';
    icon.textContent = 'link';

    // Validated again here rather than trusted from meta, every render. A
    // .mbrd is a file anyone can edit by hand, and this is the one place in
    // the app where a string out of one would otherwise become something the
    // browser navigates to. A URL that fails the check renders as inert text:
    // the card still shows what it is holding, and none of it is clickable.
    const u = linkURL(item.meta.url);
    const label = item.name || (u ? linkName(u) : '') || item.meta.url || 'link';

    const name = document.createElement(u ? 'a' : 'div');
    name.className = 'card-name';
    name.textContent = label;
    if (u) {
      // Assigned as properties on a real element and only after the scheme
      // check above - never assembled into markup, which is what keeps this
      // app free of anything that would need a sanitiser.
      name.href = u.href;
      name.target = '_blank';
      // noreferrer keeps this board's address off the other end's logs, and
      // noopener is the load-bearing half: without it the page that opens gets
      // a live handle on this one through window.opener and can navigate the
      // board out from under you. Current engines imply it for target=_blank
      // and it is written out anyway, because "implied" is not a guarantee to
      // rest a cross-origin boundary on.
      name.rel = 'noopener noreferrer';
      // Anchors drag themselves. On a board that means a link ghost trailing
      // off the card where the gesture should simply do nothing - the same
      // reason the picture and video renderers turn it off.
      name.draggable = false;
      // The whole address, for the one that was too long to print.
      name.title = u.href;
      name.addEventListener('click', e => {
        // Two reasons to swallow a click, both of them about this element
        // being more than an anchor. F2 turns it into a field (see
        // editItemName in canvas/items.js) and a click meant to place the
        // caret must not also open the page; and a double click is a zoom-to-
        // fit on the canvas, which arriving through an anchor would be two
        // clicks and so two tabs.
        if (e.detail > 1 || name.closest('.is-editing')) e.preventDefault();
      });
    }

    card.append(icon, name);

    // The links that can be more than a link. The offer only - see
    // canvas/embed.js for why nothing is loaded until it is taken.
    const spec = u && embedFor(u);
    if (spec) {
      card.classList.add('card-embed');
      card.dataset.provider = spec.provider;
      card.append(embedOffer(item, spec, card));
    }

    const dest = u ? linkDest(u) : '';
    // Left off when it would only repeat the name - a bare hostname with
    // nothing after it, which is what most pasted links are. `www.` is the one
    // difference that does not count as one, being the only thing linkName()
    // ever drops.
    if (dest && dest !== label && dest !== 'www.' + label) {
      const meta = document.createElement('div');
      meta.className = 'card-meta';
      meta.textContent = dest;
      card.append(meta);
    }
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
   */
  text(item) {
    const card = document.createElement('div');
    card.className = 'card';

    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = baseName(item.name) || item.name || 'untitled';

    // .card-text was already in app.css, waiting - monospaced, pre-wrapped, and
    // masked to a fade at the bottom so a long file ends by trailing off rather
    // than by being chopped. It had no markup to style until now.
    //
    // <pre> and textContent, never innerHTML: most of what classify() routes
    // here is source, config or tabular data whose whitespace is its shape,
    // and .html and .svg are both on the list of things that land here.
    const body = document.createElement('pre');
    body.className = 'card-text';

    card.append(name, body);

    const hash = item.asset?.hash;
    if (!hash) return card;

    readText(hash, TEXT_PREVIEW).then(text => {
      // The card can be rebuilt or culled while the read is in flight, and
      // writing into a node nothing will ever show is wasted work.
      if (!card.closest('.item')) return;
      body.textContent = text;
      // Said out loud rather than left to the fade, which looks identical
      // whether the file ended or the preview did.
      if (text.length >= TEXT_PREVIEW) {
        const more = document.createElement('div');
        more.className = 'card-meta';
        more.textContent = `first ${formatBytes(TEXT_PREVIEW)} shown`;
        card.append(more);
      }
    }).catch(() => { body.textContent = ''; });

    return card;
  },

  /**
   * A model, turned over on the card. See canvas/model.js - the geometry is
   * read there, the drawing happens there, and this is only the routing.
   */
  model(item) {
    return buildModelCard(item);
  },

  /**
   * The Desktop title card: the board's name, set in the shared masthead style.
   *
   * Bare on purpose - no `.card` shell, so no paper, no border, no cover - it is
   * the same styled name the Mobile masthead shows, only movable. This renderer
   * builds the structure and writes the current name; the typography (face,
   * size, weight, axes) is painted by ui/mobile-header.js, which owns that style
   * for both the masthead and this card and is the only layer that can resolve a
   * board's own font faces. A singleton kept out of classify() - it is never a
   * dropped file - and desktop-only, gated at mount in canvas/items.js.
   */
  title(item) {
    const card = document.createElement('div');
    card.className = 'title-card';
    const name = document.createElement('div');
    name.className = 'title-name';
    name.textContent = board.title;
    // Dim an unnamed board here, not only in main.js's paintMobileTitle: this
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
   * Structure only. What it says comes from canvas/ghosts.js (the item carries
   * a key, not prose - see the note there), and what it looks like is entirely
   * app.css: a dashed outline at Middle and Harsh, a page torn out of a pad and
   * taped down at Softish - except for the dial, which stays an ordinary card at
   * every tier. Nothing here reads the whimsy level to draw with, because
   * nothing here needs to - the level is on <html> as data-whimsy and CSS can
   * see it. The dial reads it, but as a value to show, not as a look.
   *
   * classify() is not involved and never will be. That function routes dropped
   * *files*, and no file is ever a hint; these are minted by state.js on an
   * empty board and by nothing else.
   */
  ghost(item) {
    // A fragment, not a card, and that is load-bearing. At Softish the card is
    // perforated by a CSS mask, and a mask applies to an element's descendants
    // as well as to itself - tape drawn inside the card would be punched full
    // of the same holes. So the strips are siblings of the card, and both land
    // in .item-body together. items.js appends whatever this returns, and
    // append() spreads a fragment, so nothing there had to change.
    const frag = document.createDocumentFragment();
    const card = document.createElement('div');
    card.className = 'card ghost-card';
    // The key reaches the DOM as well as the words, because Softish gives each
    // hint a torn silhouette of its own and CSS has to be able to tell them
    // apart. It cannot do that by position: these are children of #world
    // alongside the web, the shadow layer and the title card, so :nth-child
    // counts things that are not cards and hands two hints the same outline.
    const key = hintKey(item.meta?.hint);
    card.dataset.hint = key;
    const { title, line } = hintFor(item.meta?.hint);
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
      // canvas/input.js let the press through - its widget branch names `input`
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
      // The level the interface is at, read off the attribute ui/appearance.js
      // writes - the same source watchWhimsy() keeps this in step with.
      slider.value = document.documentElement.dataset.whimsy ?? '1';
      slider.setAttribute('aria-label', title);

      // The stops, built the way ui/panel.js builds them: names rather than a
      // <datalist>, which Chromium ignores on a painted track and Firefox draws
      // as ticks whose ends vanish into the rounded ends of it. Hidden from the
      // accessibility tree, because the same three words reach a screen reader
      // through the dial's own aria-valuetext (see bindDial).
      //
      // Under the track, the same way round as the panel: the name of the axis
      // over it, the names of its three stops under it.
      const stops = document.createElement('span');
      stops.className = 'field-stops';
      // The id is a styling hook as much as a target for aria-describedby: each
      // name is set in the face of the tier it names, and app.css reaches both
      // whimsy rows - this one and the panel's #whimsy-stop-labels - through one
      // block. Safe as an id because a board carries at most one dial card.
      stops.id = 'ghost-whimsy-stops';
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
    } else {
      const body = document.createElement('div');
      body.className = 'ghost-line';
      body.textContent = line;
      card.append(body);
    }
    frag.append(card);

    // Built at every tier and shown only at Softish (app.css hides it
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

  generic(item) {
    return cardShell(item, extOf(item.name) || 'file');
  },
};

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
export const hasRenderer = type => Object.hasOwn(RENDERERS, type);

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
export function linkURL(text) {
  const s = String(text ?? '').trim();
  if (!s || /\s/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.hostname ? u : null;
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
export function linkDraft(u) {
  const size = defaultSize('link');
  return { type: 'link', name: linkName(u), w: size.w, h: size.h, meta: { url: u.href } };
}

/** What a link is called before anybody renames it: the site it points at. */
function linkName(u) {
  // `www.` is the one part of a hostname that identifies nothing - it is a
  // convention about a server, not about whose site this is - and the address
  // line below keeps it anyway, so nothing is being hidden by dropping it here.
  return u.hostname.replace(/^www\./, '');
}

/**
 * Where the link actually goes, spelled out under its name.
 *
 * https earns no room, being the expectation; anything else is worth the eight
 * characters it costs to say so, because http is the one difference between
 * these two cards that a reader would want to know about. The rest is the
 * hostname, then the path - the identity first and the detail after it. A lone
 * `/` is dropped: it is punctuation the parser adds, not something anyone typed.
 */
function linkDest(u) {
  const tail = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
  return (u.protocol === 'https:' ? '' : u.protocol + '//') + u.host + tail;
}

/**
 * Whether a picture moves. GIF and APNG announce themselves in the type or the
 * extension; an animated WebP does not, and telling one from a still WebP means
 * parsing the container - so it is left out rather than guessed at.
 */
function isAnimated(item) {
  const mime = (item.meta?.mime || '').toLowerCase();
  const ext = (item.meta?.ext || extOf(item.name) || '').toLowerCase();
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
function titleOf(item) {
  const stem = baseName(item.name) || item.name || '';
  return stem.replace(/^[\s._-]+|[\s._-]+$/g, '') || stem || 'untitled';
}

function cardShell(item, kind) {
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
  const ext = (item.meta.ext || extOf(item.name) || '').replace(/^\./, '');
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
function adoptAspect(item, nw, nh) {
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
    const box = latticeBox({ x: live.x, y: live.y, w, h }, board.settings.gridStep > 0 ? board.settings.gridStep : 64);
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
export function fitMode(item) {
  if (item.type !== 'image' && item.type !== 'video') return 'contain';
  const own = item.meta?.fit;
  if (own === 'cover' || own === 'contain') return own;
  return board.mediaFit === 'contain' ? 'contain' : 'cover';
}
