// One renderer per item type: classification, a default size, and the DOM that
// goes inside a card. Adding a new type means adding an entry to RENDERERS and
// a branch in classify() - nothing else in the app needs to know about it.

import { extOf, baseName, formatBytes } from '../util.js';
import { assetURL, getAsset, readText } from '../storage/assets.js';
import { byId, bus, markDirty } from '../state.js';
import { describeExt, PHOTO_EXTS, AUDIO_EXTS, VIDEO_EXTS, SVG_EXTS } from './formats.js';

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
  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  // The catalog's sets are broader than the MIME types a browser bothers to
  // set - .jxl, .avif and friends often arrive with an empty file.type.
  if (PHOTO_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'generic';
}

/** Starting size in world units. Media items refine this once they load. */
export function defaultSize(type) {
  switch (type) {
    case 'image':   return { w: 320, h: 240 };
    case 'video':   return { w: 360, h: 203 };
    case 'audio':   return { w: 330, h: 196 };
    case 'text':    return { w: 300, h: 360 };
    // Square: a sticky comes off a square pad.
    case 'note':    return { w: 240, h: 240 };
    default:        return { w: 250, h: 140 };
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
  try {
    const natural = type === 'image' ? await imageSize(file) : await videoSize(file);
    // An image the browser cannot decode (HEIC, JXL, camera RAW) is reported
    // so the importer can fall back to a named card instead of a broken <img>.
    if (!natural) return { ...box, decodable: false };
    // Preserve the placeholder's area, adopt the real aspect ratio.
    const area = box.w * box.h;
    const ratio = natural.w / natural.h;
    return {
      w: Math.round(Math.sqrt(area * ratio)),
      h: Math.round(Math.sqrt(area / ratio)),
      measured: true,
      decodable: true,
    };
  } catch {
    return { ...box, decodable: false };
  }
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
  return fn(item);
}

const RENDERERS = {
  image(item) {
    const img = document.createElement('img');
    img.alt = item.name || '';
    img.decoding = 'async';
    img.draggable = false;
    img.addEventListener('load', () => adoptAspect(item, img.naturalWidth, img.naturalHeight), { once: true });
    const url = item.asset && assetURL(item.asset.hash);
    if (url) img.src = url;
    return img;
  },

  video(item) {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.playsInline = true;
    v.loop = true;
    v.muted = true;
    v.draggable = false;
    v.addEventListener('loadedmetadata', () => adoptAspect(item, v.videoWidth, v.videoHeight), { once: true });
    const url = item.asset && assetURL(item.asset.hash);
    // #t=0.1 pulls a real frame as the poster instead of a black rectangle.
    if (url) v.src = url + '#t=0.1';
    return v;
  },

  audio(item) {
    const card = cardShell(item, 'audio');
    const a = document.createElement('audio');
    a.controls = true;
    a.preload = 'metadata';
    const url = item.asset && assetURL(item.asset.hash);
    if (url) a.src = url;
    card.append(a);
    return card;
  },

  text(item) {
    const card = cardShell(item, extOf(item.name) || 'text');
    const pre = document.createElement('div');
    pre.className = 'card-text';
    pre.textContent = '';
    card.append(pre);
    if (item.asset) {
      readText(item.asset.hash, 8000)
        .then(t => { pre.textContent = t; })
        .catch(() => { pre.textContent = '(unreadable)'; });
    }
    return card;
  },

  /**
   * A note is two fields, not one: its first line is a title, set bigger and
   * bolder and ruled off from the rest.
   *
   * They are separate elements rather than a ::first-line on one field,
   * because ::first-line accepts no border - and because it styles the first
   * *rendered* line, so a long opening sentence would have had its first
   * visual row promoted to a title halfway through a word. The split is on the
   * newline, which is where the author put it.
   *
   * meta.text stays the single stored value, title and body joined by that
   * newline; ui/notes.js is what splits and rejoins it.
   */
  note(item) {
    const card = document.createElement('div');
    card.className = 'card';
    const [title, ...rest] = (item.meta.text || '').split('\n');

    const head = document.createElement('div');
    head.className = 'note-title';
    head.textContent = title || '';

    const body = document.createElement('div');
    body.className = 'note-body';
    body.textContent = rest.join('\n');

    card.append(head, body);
    return card;
  },

  generic(item) {
    return cardShell(item, extOf(item.name) || 'file');
  },
};

/** Icon badge + name + size - the shared head of every non-visual card. */
function cardShell(item, kind) {
  const card = document.createElement('div');
  card.className = 'card';

  const icon = document.createElement('div');
  icon.className = 'card-icon';
  icon.textContent = kind;

  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = baseName(item.name) || item.name || 'untitled';

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const asset = item.asset && getAsset(item.asset.hash);
  // Prefer what the format catalog knows the file *is* over its MIME type,
  // which is usually blank for anything interesting.
  const known = describeExt(item.meta.ext || extOf(item.name));
  const what = known ? `${known.label} · ${known.categoryLabel}` : item.meta.mime;
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

  live.w = Math.round(w);
  live.h = Math.round(h);
  bus.emit('geom', [live.id]);
  markDirty();
}

/** Object-fit for a type. Media fills its card; anything else is contained. */
export function fitMode(type) {
  return type === 'image' || type === 'video' ? 'cover' : 'contain';
}
