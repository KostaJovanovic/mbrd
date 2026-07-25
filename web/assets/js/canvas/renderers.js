// One renderer per item type: classification, a default size, and the DOM that
// goes inside a card. Adding a new type means adding an entry to RENDERERS and
// a branch in classify() - nothing else in the app needs to know about it.

import { extOf, baseName, formatBytes } from '../util.js';
import { assetURL, getAsset, readText } from '../storage/assets.js';
import { byId, bus, markDirty } from '../state.js';
import { describeExt, PHOTO_EXTS, AUDIO_EXTS, VIDEO_EXTS, SVG_EXTS } from './formats.js';
import { buildTransport, registerPlayer } from '../ui/audio.js';


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
    // Wide and short: an address is a wide thing, and there is no body under
    // it - a link card is a name, a URL, and nothing else.
    case 'link':    return { w: 320, h: 132 };
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
    if (!isAnimated(item)) return img;

    // An animated picture travels with a twin that canvas/stills.js paints a
    // frame into when the board is zoomed out. Empty and hidden until then;
    // the pair is returned as a fragment so both land as siblings inside
    // .item-body and pick up the same sizing rules.
    img.dataset.gif = '';
    const still = document.createElement('img');
    still.className = 'still';
    still.alt = '';
    still.decoding = 'async';
    still.draggable = false;
    const pair = document.createDocumentFragment();
    pair.append(img, still);
    return pair;
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

  /**
   * A player the board owns, rather than the browser's grey plastic one.
   *
   * The <audio> element is still what plays the sound - it handles streaming,
   * seeking and codecs, and nothing here would be improved by reimplementing
   * that - but it is kept out of the layout entirely and driven by the button
   * and the bars. See ui/audio.js for the waveform and the global volume.
   */
  audio(item) {
    const card = cardShell(item, 'audio');
    card.classList.add('card-audio');

    const sound = document.createElement('audio');
    sound.preload = 'metadata';
    const url = item.asset && assetURL(item.asset.hash);
    if (url) sound.src = url;
    registerPlayer(sound);

    card.append(buildTransport(item, sound), sound);
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
   * that turned out to hold nothing else (ui/notes.js).
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

  generic(item) {
    return cardShell(item, extOf(item.name) || 'file');
  },
};

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
