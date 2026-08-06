// One renderer per item type: classification, a default size, and the DOM that
// goes inside a card. Adding a new type means adding an entry to RENDERERS and
// a branch in classify() - nothing else in the app needs to know about it.
//
// Both of those still live here, deliberately, because they are the pair a new
// type touches and splitting them would double that. What moved out is what was
// never type dispatch: canvas/note-model.js has the sticky-note formatting
// model (pure, and read by the editor as much as by the renderer) and
// canvas/poster.js the video first-frame grab. Both are re-exported below so no
// caller had to learn they moved.

import { extOf, baseName, formatBytes } from '../util.js';
import { assetURL, getAsset, readText } from '../storage/assets.js';
import { byId, bus, markDirty, board, isDefaultTitle, setSwatchHex } from '../state.js';
import { latticeBox } from '../geometry.js';
import { describeExt, PHOTO_EXTS, AUDIO_EXTS, VIDEO_EXTS, SVG_EXTS } from '../import/formats.js';
import { buildTransport, registerPlayer } from './audio.js';
import { buildVideoPlayer, POSTER_TIME } from './video.js';
import { onTouch } from './viewport.js';
import { embedFor, embedOffer } from './embed.js';
import { buildModelCard } from './model.js';
import { hintFor, hintKey, tapeStyle, bindDial, STOPS, DIAL } from './ghosts.js';
import { ensureDisplay, displayURLReady } from './display.js';
import { meshKind } from '../mesh.js';
import { normalizeNoteRich, applyNoteStyle, buildNoteLine } from './note-model.js';

// The façade: both moved out of this file, and every caller still asks here.
// Written out rather than as a star re-export for the reason state.js is - a
// name that goes missing should break loudly at the import, not quietly at
// runtime.
export {
  NOTE_TAGS, NOTE_ALIGNS, NOTE_VALIGNS, NOTE_FONTS, NOTE_FONT_KEYS,
  NOTE_SIZE_MIN, NOTE_SIZE_MAX, NOTE_SIZE_STEP, NOTE_MARKER,
  parseNoteText, normalizeNoteRich, flattenNoteRich, applyNoteStyle,
  buildNoteLine,
} from './note-model.js';
export { videoFrame } from './poster.js';


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
    // A colour and its number, and nothing else - so it is sized like the note
    // next to it rather than like a card with a body. Two grid spaces square at
    // the default step, plus the row the hex is printed in.
    case 'swatch':  return { w: 128, h: 148 };
    default:        return { w: 200, h: 112 };
  }
}

/**
 * What a swatch starts as.
 *
 * A grey, and deliberately not a colour. The whole content of a swatch is the
 * colour you chose, so any preset here would be the app putting a colour it
 * invented on somebody's board and calling it theirs. Mid grey is the absence
 * of a choice, and it is the one value that reads as "this is waiting for you"
 * rather than as a decision already made.
 */
export const SWATCH_DEFAULT = '#8a8a8a';

/**
 * A swatch's colour, held to what it has to be.
 *
 * `#rrggbb` lowercase and nothing else, because two different things need it in
 * exactly that form: `<input type="color">` refuses anything shorter or named,
 * and the stylesheet interpolates it straight into a custom property. `meta` is
 * the open field and this one arrives from a .mbrd like everything else, so it
 * is checked here rather than trusted - the same bargain normalizeAsset() makes
 * one layer down.
 *
 * The three-digit form is folded out rather than rejected. Nobody typed it into
 * the picker, but somebody may well have typed it into a file by hand, and
 * `#f00` is not a broken colour - it is the same colour written shorter.
 */
export function swatchHex(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s.slice(1).replace(/./g, c => c + c);
  return SWATCH_DEFAULT;
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
    // same way either way: a sibling <img class="still"> that the CSS shows
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
      // The fragment pulls a real frame as the poster instead of a black
      // rectangle. Named, because it leaves every parked clip on the board
      // sitting at a currentTime that is not zero, and two other places have to
      // know that in order to tell a parked clip from a played one.
      if (url) v.src = url + '#t=' + POSTER_TIME;
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

    // .card-text was already in items.css, waiting - monospaced, pre-wrapped, and
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
  title(_item) {
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
   * items.css: a dashed outline at Middle and Harsh, a page torn out of a pad and
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
    const { title, line, href, go: goes } = hintFor(item.meta?.hint);
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
      // name is set in the face of the tier it names, and the CSS reaches both
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
   * It is also why nothing had to change in canvas/input.js. That pipeline
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
  swatch(item) {
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

    const show = value => {
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
  fence(_item) {
    const card = document.createElement('div');
    card.className = 'card fence-card';
    return card;
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
