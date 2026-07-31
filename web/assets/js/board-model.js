// The board's shape: what a board is, what an item is, and what the defaults
// are when a file does not say.
//
// The second floor under state.js (see board-store.js for the first). state.js
// is the app's one mutation door and it grew to hold about ten concerns; the
// obstacle to lifting any of them out was that they all reach for the same two
// things - the bus, and the board itself. The bus went down first. This is the
// board, and with it the index every one of those concerns looks items up
// through.
//
// Data and validation only. Nothing here mutates the board or announces
// anything: no commit(), no bus.emit() beyond the index invalidator, no undo.
// That is the line that keeps this a floor rather than a second god-module -
// the moment a rule about *how* the board may change lands here, the split has
// gone backwards.
//
// Everything is re-exported by state.js under its old name, so no caller knows
// this file exists.

import { uid, isHash } from './util.js';
import { MIN_SIZE, MAX_SIZE } from './geometry.js';
import { DEFAULT_SCALE, clampScale, PAPERS } from './measure.js';
import { splitAppearance, mergeAppearance } from './layout-settings.js';
import { mobileArrangement } from './arrange/arrangements.js';
import { bus } from './board-store.js';

/** The longest a sticky note may be. Enforced at every door onto the board. */
export const NOTE_MAX = 512;

// `size` is the type's size, as a percentage of the strip's own width - see
// #mobile-board-title in app.css. `stretch` is a percentage of that size taken
// vertically only: 100 is the face as drawn, 160 is the same letters a little
// over half again as tall and exactly as wide. Two numbers rather than one
// because they are two questions - how big the name is set, and how tall the
// letters stand in it - and a single control could only ever answer the first.
// `leading` is the line height, and 100 is not "one em" - it is `normal`, the
// face's own ascent and descent, which is what the masthead is set in until
// somebody says otherwise. Off that stop the number is a straight multiple of
// the font size, so 140 is 1.4. The one value that cannot be dialled is the
// face's normal expressed as a number, because no face publishes it.
export const DEFAULT_MOBILE_HEADER = Object.freeze({
  font: '',
  size: 13,
  stretch: 100,
  leading: 100,
  weight: 700,
  // Nudge up or down the band, as a percentage of the band's own height so the
  // move keeps its proportion whatever the font size is. 0 is centred.
  offset: 0,
  italic: false,
  // On, because a name that runs off the side of the board is a name nobody can
  // read. Off is for the case the wrap cannot answer: a long name set as one
  // line on purpose, running to the board's edges and clipped by the band.
  wrap: true,
  axes: Object.freeze({}),
});

export const DEFAULT_SETTINGS = {
  grid: true,
  axes: true,
  snap: false,
  // The relationship web behind the cards. Desktop-only and layout-local, on by
  // default; an older board with no such key reads as on - see canvas/web.js.
  web: true,
  // Off to begin with. It is a working instrument - where the pointer is, how
  // big the selected thing is - and a board you have just opened is a thing you
  // are looking at rather than working on. The scale bar covers the question a
  // first glance actually has, and this is one checkbox away in View.
  hud: false,
  gridStyle: 'dots',   // the only style; kept so old .mbrd files still load
  gridStep: 64,        // world px between minor grid lines, before zoom quantisation
  // Desktop's inert compatibility value. Mobile profiles override this to the
  // eight-space default below, while still accepting an explicit six.
  mobileColumns: 6,
  // Gap used by the arrangement engine. 12 rather than the 32 it was: a
  // moodboard is a board of things read against each other, and a third of a
  // card's width of empty paper between every pair is the layout arguing that
  // they are separate. Close enough to compare, far enough that the edges still
  // read as edges - and the slider is right there for anyone who disagrees.
  spacing: 12,
  // What the board's coordinates mean in the world: world units per millimetre,
  // and which family of unit names to say it in. Geometry never reads either -
  // they are a lens over numbers that were always unitless. See measure.js.
  scale: DEFAULT_SCALE,
  units: 'metric',     // or 'imperial'
  // A sheet of standard paper outlined around the origin, sized through the
  // scale above - see canvas/paper.js. An id out of PAPERS, or '' for none.
  // Two flat keys rather than one { size, landscape } object, because
  // setSetting() compares with === and no two objects are ever equal: an object
  // here would emit on every write and never on the one that mattered.
  paper: '',
  paperLandscape: false,
  // Whether the sheet carries the four grips that resize it. Off, because
  // resizing it is not resizing it: the sheet is always exactly A4, and what
  // the drag moves is the board's scale - every measurement on the board at
  // once. That is a deliberate act, not something to leave armed on the corners
  // of a rectangle somebody put up to check a layout against.
  paperResize: false,
  appearance: { palette: '', vars: {} },
  fonts: [],           // faces dropped onto this board - see ui/fonts.js
};

export const BOARD_MODES = ['desktop', 'mobile'];
export const BOARD_TITLE_MAX = 32;
export const MOBILE_COLUMNS = 8;
export const MOBILE_COLUMN_OPTIONS = [6, 8];
export const MOBILE_TOP_ROWS = 6;
export const MOBILE_MIN_ROWS = 25;
export const MOBILE_BOTTOM_ROWS = 15;
export const MOBILE_APPEARANCE_VARS = Object.freeze({
  '--grid-alpha': '0.20',
  '--grid-dot': '1px',
});

/**
 * Clean a title while somebody is still typing it.
 *
 * Keep one trailing space: removing it on every input event makes entering a
 * second word impossible. Final-only filename rules live in cleanBoardTitle().
 */
export function cleanBoardTitleDraft(value) {
  let title = typeof value === 'string' ? value : '';
  return title
    .replace(/\s+/g, ' ')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trimStart()
    .slice(0, BOARD_TITLE_MAX);
}

/**
 * A short board name that can also be used as a portable filename stem.
 *
 * Windows has the narrowest ordinary filename alphabet, so its forbidden
 * punctuation and device names define the shared rule. Spaces remain readable
 * on the board; storage.js changes them to underscores only in exported files.
 */
export function cleanBoardTitle(value) {
  let title = cleanBoardTitleDraft(value)
    .trim()
    .replace(/[. ]+$/g, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) {
    title = ('_' + title).slice(0, BOARD_TITLE_MAX);
  }
  return title;
}

/**
 * The name a brand-new board is born with.
 *
 * A dated "New board Jul 28" rather than the bare "Untitled board" sentinel, so
 * a board reads as itself in the file list from the moment it exists instead of
 * sharing one anonymous name with every other fresh board. 'Untitled board'
 * stays the single value that means *no* title - the placeholder, and the
 * fallback for a loaded file that carries none.
 *
 * Three-letter months, written out rather than taken from toLocaleDateString,
 * so the name does not shift with the browser's locale and a test can pin it
 * with a fixed date.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function defaultBoardTitle(now = new Date()) {
  return `New board ${MONTHS[now.getMonth()]} ${now.getDate()}`;
}

/**
 * Whether a title is one nobody has actually typed - the bare sentinel or a
 * `defaultBoardTitle()` a fresh board was handed. The interface treats these as
 * "unnamed": the sidebar field stays empty and shows the name as a faint,
 * italic placeholder instead of a value, and the Mobile header dims it. Rename
 * to anything else and it reads as a real name.
 */
const AUTO_TITLE = new RegExp(`^New board (?:${MONTHS.join('|')}) \\d{1,2}$`);
export function isDefaultTitle(title) {
  return title === 'Untitled board' || AUTO_TITLE.test(title);
}

export function cloneSettings(settings) {
  return {
    ...settings,
    appearance: {
      ...(settings?.appearance || {}),
      vars: { ...(settings?.appearance?.vars || {}) },
    },
    fonts: Array.isArray(settings?.fonts)
      ? settings.fonts.map(font => {
          const copy = { ...font };
          if (Array.isArray(font?.axes) && font.axes.length) {
            copy.axes = font.axes.map(axis => ({ ...axis }));
          } else {
            delete copy.axes;
          }
          return copy;
        })
      : [],
  };
}

export function layoutSettingsOf(settings) {
  const cloned = cloneSettings(settings);
  const { local } = splitAppearance(cloned.appearance);
  cloned.appearance = local;
  return cloned;
}

export function settingsFor(layoutSettings, sharedAppearance) {
  const cloned = cloneSettings(layoutSettings);
  cloned.appearance = mergeAppearance(sharedAppearance, cloned.appearance);
  return cloned;
}

export function defaultLayoutSettings(mode) {
  return layoutSettingsOf({
    ...DEFAULT_SETTINGS,
    snap: mode === 'mobile',
    spacing: mode === 'mobile' ? 0 : DEFAULT_SETTINGS.spacing,
    mobileColumns: mode === 'mobile' ? MOBILE_COLUMNS : DEFAULT_SETTINGS.mobileColumns,
    appearance: {
      palette: '',
      vars: mode === 'mobile' ? { ...MOBILE_APPEARANCE_VARS } : {},
    },
    fonts: [],
  });
}

/** The only supported Mobile strip widths, with eight as the safe fallback. */
export function mobileColumnCount(value = board.settings.mobileColumns) {
  return MOBILE_COLUMN_OPTIONS.includes(+value) ? +value : MOBILE_COLUMNS;
}

const initialSharedAppearance = splitAppearance(DEFAULT_SETTINGS.appearance).shared;
const initialLayoutSettings = {
  desktop: defaultLayoutSettings('desktop'),
  mobile: defaultLayoutSettings('mobile'),
};

export const board = {
  title: defaultBoardTitle(),
  view: { pan: { x: 0, y: 0 }, zoom: 1 },
  // Both containers rebuilt rather than spread through: DEFAULT_SETTINGS holds
  // them by reference, and a board mutating one in place would be editing the
  // defaults every later board is built from.
  sharedAppearance: initialSharedAppearance,
  layoutSettings: initialLayoutSettings,
  settings: settingsFor(initialLayoutSettings.desktop, initialSharedAppearance),
  arrangement: 'spiral',
  arrangements: { desktop: 'spiral', mobile: 'spiral' },
  // The mode is local UI state and is deliberately omitted from board.json:
  // a phone remembers Mobile and a laptop remembers Desktop without the last
  // device to save forcing its choice onto the other. `layouts` is the part
  // that travels - two sets of geometry over one shared set of items.
  layoutMode: 'desktop',
  layouts: { desktop: [], mobile: [] },
  items: [],
  // The board name's typography, styled by ui/mobile-header.js. Board-level
  // rather than per-layout on purpose: the Mobile masthead and the Desktop
  // title card (type 'title') are one identity set in one place, so a change
  // on either shows on both. Older .mbrd files carry it under settings; load
  // reads that as the fallback.
  mobileHeader: DEFAULT_MOBILE_HEADER,
  // The Desktop title card is present by default; deleting it sets this rather
  // than filing it in the bin - see removeItems() and ui/trash.js's restore
  // button. Persisted, so a board opens the way it was left.
  titleHidden: false,
  // How photos and videos sit in their cards board-wide: 'contain' (the default)
  // fits the whole picture inside and letterboxes; 'cover' fills the card and
  // crops. Board-level, not per-layout, because it is a property of the media
  // rather than of a device's view. A single item can override it from its own
  // meta.fit - see fitMode() in canvas/renderers.js.
  mediaFit: 'contain',
  // How many of the board's pictures the "take colours from pictures" palette is
  // read from, newest first. Board-level like the palette itself (colour is
  // shared across layouts), and clamped to [1, 24] - the 24 mirrors MAX_SOURCES
  // in ui/pigments.js, the absolute ceiling the sampler enforces. Default 12,
  // the count the feature used before it was made a dial.
  paletteSources: 12,
  // Thrown away but not gone. Entries are { item, at }, newest first.
  trash: [],
};

/**
 * The Desktop title card is a singleton, so it carries a fixed id rather than a
 * minted one - its geometry then travels in board.layouts like any item's, and
 * a delete-then-restore lands the same card back rather than a new one.
 */
export const TITLE_ID = '__title__';


/**
 * id -> item, an index beside board.items rather than a replacement for it.
 *
 * byId was an O(n) `find`, and it is called on the hot paths - once per moved id
 * per frame down the drag/`geom` route, and from the command surface all over -
 * so on a board of a couple of thousand items it walked the whole array tens of
 * times a frame to answer a question a Map answers in one step.
 *
 * The map is rebuilt lazily rather than patched at every mutation site, which is
 * what keeps it honest: board.items is a mutable exported singleton pushed,
 * spliced and filtered from eight places, and a hand-maintained index is one
 * missed site away from returning a stale object. Instead the index is dropped
 * whenever the *membership* of the board can have changed - the `items` event,
 * which every add/remove/replace/load emits - and rebuilt on the next read. The
 * events that fire far more often, `geom` while dragging, do not touch
 * membership: the same item objects move, so the index stays valid across a
 * whole drag and byId is O(1) for its entire length, which is the case this is
 * for. Order-independent by construction - a stale read cannot happen because a
 * listener ran before this invalidator, since the map simply rebuilds on demand.
 */
let itemIndex = null;

export function byId(id) {
  if (!itemIndex) {
    itemIndex = new Map();
    for (const item of board.items) itemIndex.set(item.id, item);
  }
  return itemIndex.get(id);
}

// Membership changed, so the index no longer describes the board. Dropped, not
// rebuilt: the next byId() pays for it, and a burst of mutations in one tick
// (a multi-item paste, a load) then rebuilds once rather than once per item.
bus.on('items', () => { itemIndex = null; });

export function topZ() {
  return board.items.reduce((m, i) => Math.max(m, i.z || 0), 0);
}

/**
 * Normalise a partial item into the full persisted shape.
 *
 * Total, deliberately: it is handed objects straight out of somebody else's
 * board.json, and it must not be able to throw part-way through rebuilding a
 * board - see loadBoard. Every field is coerced rather than trusted, and a
 * value that cannot be coerced falls back to the default for its slot.
 */
/**
 * The furthest from the origin an item may sit, per axis.
 *
 * World space is float and centred, so there is no natural bound - but a value
 * out of a file is not trusted, and `+partial.x || 0` used to let `Infinity`
 * straight through (it is truthy). One infinite coordinate poisons every bounds,
 * fit and transform calculation that later touches it. Ten million world units
 * is far past any real board and finite. See AUD-07.
 */
const COORD_MAX = 1e7;

/** A finite coordinate in range, or 0. Rejects Infinity, NaN and out-of-range. */
function coord(v) {
  const n = +v;
  return Number.isFinite(n) ? Math.min(Math.max(n, -COORD_MAX), COORD_MAX) : 0;
}

/** A positive size within the item bounds, or `fallback`. Rejects <=0 and Infinity. */
function size(v, fallback) {
  const n = +v;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, MIN_SIZE), MAX_SIZE) : fallback;
}

/**
 * The most items a loaded board may carry. A file that respects the ZIP byte
 * limit can still declare an enormous `items` array - JSON is cheap - and every
 * entry becomes a DOM cost and an autosave cost. Trash shares the runtime bin's
 * own limit (TRASH_LIMIT). See AUD-07.
 */
export const MAX_ITEMS = 20000;

/**
 * Force item ids unique, regenerating collisions deterministically.
 *
 * A duplicate id conflicts with the renderer's module-level Map, selection,
 * byId()'s first-match, and DOM identity - two cards that are meant to be
 * distinct become one. Regenerated by suffix rather than uid() so a given file
 * always loads the same way. `seen` is shared across the live items and the bin
 * so a restored item can never land on a live id.
 */
export function dedupeIds(list, seen) {
  for (const it of list) {
    if (!seen.has(it.id)) { seen.add(it.id); continue; }
    let k = 2, next;
    do { next = (it.id + '~' + k++).slice(0, 64); } while (seen.has(next));
    it.id = next;
    seen.add(next);
  }
  return list;
}

export function makeItem(partial) {
  let meta = partial.meta && typeof partial.meta === 'object' ? partial.meta : {};
  // The one funnel every item passes through on its way onto the board, which
  // makes it the place to hold a note to its ceiling. The editor enforces the
  // same limit while you type; this catches the other doors - an older .mbrd,
  // and a notes/*.md someone edited by hand outside the app.
  if ((partial.type || 'generic') === 'note' && typeof meta.text === 'string' && meta.text.length > NOTE_MAX) {
    meta = { ...meta, text: meta.text.slice(0, NOTE_MAX) };
  }
  return {
    id: typeof partial.id === 'string' && partial.id ? partial.id.slice(0, 64) : uid(),
    type: typeof partial.type === 'string' && partial.type ? partial.type : 'generic',
    x: coord(partial.x),
    y: coord(partial.y),
    w: size(partial.w, 240),
    h: size(partial.h, 180),
    rot: Number.isFinite(+partial.rot) ? +partial.rot : 0,
    z: partial.z != null && Number.isFinite(+partial.z) ? +partial.z : topZ() + 1,
    name: typeof partial.name === 'string' ? partial.name.slice(0, 260) : '',
    asset: normalizeAsset(partial.asset),
    meta: normalizeMeta(meta),
  };
}

/**
 * `meta` is the open field - anything a renderer wants to remember about an
 * item lives in it and nothing here reads most of it. The content ids are the
 * exception, because they are *second* names for bytes: they get spelled into
 * an archive path by storage/mbrd.js and they decide what the autosave sweep is
 * allowed to delete. So each goes through the same gate item.asset.hash does,
 * and one that is not a digest is dropped rather than carried.
 *
 * The list is the same one itemHashes() in util.js reports, less the item's own
 * asset. Anything added there wants adding here too.
 */
const META_HASHES = ['cover', 'shot', 'thumb'];

function normalizeMeta(meta) {
  let out = meta;
  for (const key of META_HASHES) {
    if (!(key in out) || isHash(out[key])) continue;
    const { [key]: _drop, ...rest } = out;
    out = rest;
  }
  return out;
}

/**
 * An item's link to its bytes, or null.
 *
 * The hash is checked for shape here rather than only where it is used, because
 * of what it becomes downstream: storage/mbrd.js spells it into an archive path
 * and the asset store treats it as an identity. An id that is not a digest can
 * never resolve to bytes anyway - dropping it leaves a card that shows as a
 * plain one, which is honest, where keeping it leaves a board that also cannot
 * be exported. `external` is the reserved link-instead-of-embed form and has no
 * hash to check; it is carried through untouched.
 */
function normalizeAsset(asset) {
  if (!asset || typeof asset !== 'object') return null;
  if (isHash(asset.hash)) return asset;
  return asset.external ? { external: asset.external } : null;
}
