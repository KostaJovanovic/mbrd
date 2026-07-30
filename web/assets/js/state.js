// Central board state + selection + command-based undo/redo.
//
// Everything that mutates the board goes through here and emits an event, so
// the renderer, HUD and sidebar stay in sync without knowing about each other.
//
// Events:
//   items      - the item list itself changed (add/remove/reorder)
//   geom       - existing items moved/resized (payload: array of ids)
//   item       - one item's content/name changed (payload: id)
//   selection  - the selection set changed
//   settings   - a setting changed (payload: key)
//   layout     - desktop/mobile geometry profile changed (payload: mode)
//   board      - a whole new board was loaded, or the title/dirty flag changed
//   trash      - something was thrown away, restored, or purged

import { clamp, emitter, uid, isFamily, isHash, itemHashes, toast } from './util.js';
// Pure geometry, shared with the canvas and the input layer so that "where is
// this item and what does it cover" has exactly one answer in this app. Kept
// at the top level rather than under canvas/ because it depends on nothing and
// belongs to no one layer - see geometry.js.
import {
  itemBounds, overlapFraction, latticeBox, cellInset, MIN_SIZE, MAX_SIZE,
} from './geometry.js';
// The board's link to real-world sizes. Pure arithmetic with no state of its
// own, at the same level as geometry.js and imported here for the same reason:
// the default belongs with the rest of the defaults, and the clamp has to run
// on every board that arrives from a file.
import { DEFAULT_SCALE, clampScale, PAPERS } from './measure.js';
import { splitAppearance, mergeAppearance } from './layout-settings.js';

export const bus = emitter();

// The filename an asset first arrived under lives in the asset registry, which
// sits *above* state in the layering - storage depends on state, not the other
// way. So renameItem's oldest fallback is injected here rather than imported:
// main.js wires this to storage/assets.js at startup. Left unset - in a test,
// or before wiring - the fallback just skips to the item's current name, which
// is the same answer the registry gives for an asset it has never seen. See
// AUD-12.
let assetName = () => undefined;
export function setAssetNameLookup(fn) {
  assetName = typeof fn === 'function' ? fn : () => undefined;
}

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

function cloneSettings(settings) {
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

function layoutSettingsOf(settings) {
  const cloned = cloneSettings(settings);
  const { local } = splitAppearance(cloned.appearance);
  cloned.appearance = local;
  return cloned;
}

function settingsFor(layoutSettings, sharedAppearance) {
  const cloned = cloneSettings(layoutSettings);
  cloned.appearance = mergeAppearance(sharedAppearance, cloned.appearance);
  return cloned;
}

function defaultLayoutSettings(mode) {
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

export const selection = new Set();

let dirty = false;
export const isDirty = () => dirty;
export function markDirty(v = true) {
  if (dirty === v) return;
  dirty = v;
  bus.emit('board');
}

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
const MAX_ITEMS = 20000;

/**
 * Force item ids unique, regenerating collisions deterministically.
 *
 * A duplicate id conflicts with the renderer's module-level Map, selection,
 * byId()'s first-match, and DOM identity - two cards that are meant to be
 * distinct become one. Regenerated by suffix rather than uid() so a given file
 * always loads the same way. `seen` is shared across the live items and the bin
 * so a restored item can never land on a live id.
 */
function dedupeIds(list, seen) {
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

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const undoStack = [];
const redoStack = [];
const HISTORY_LIMIT = 200;

/**
 * What each half of the history would do next, by name, or null for nothing.
 *
 * The labels are the ones commit() was given - "Add 3 items", "Nudge",
 * "Optimize" - so a control built on this can say what it is about to take
 * back rather than only whether it can.
 */
export const historyState = () => ({
  undo: undoStack.at(-1)?.label || null,
  redo: redoStack.at(-1)?.label || null,
});

/**
 * The stacks changed.
 *
 * Its own event rather than something riding on 'board', and it has to be:
 * markDirty() only emits when dirtiness *changes*, so on an already-dirty board
 * - which is every board after the first edit - it goes quiet, and anything
 * watching for history through it would light up once and then never move
 * again.
 */
const historyChanged = () => bus.emit('history');

/** Run `redo` now and remember how to reverse it. */
export function commit(label, redo, undo) {
  redo();
  undoStack.push({ label, redo, undo });
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  markDirty();
  historyChanged();
}

export function undo() {
  const cmd = undoStack.pop();
  if (!cmd) return false;
  cmd.undo();
  redoStack.push(cmd);
  markDirty();
  historyChanged();
  return true;
}

export function redo() {
  const cmd = redoStack.pop();
  if (!cmd) return false;
  cmd.redo();
  undoStack.push(cmd);
  markDirty();
  historyChanged();
  return true;
}

function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  historyChanged();
}

// ---------------------------------------------------------------------------
// Item mutations (all undoable)
// ---------------------------------------------------------------------------

export function addItems(items, label = 'Add', options = {}) {
  // The stack is dealt here rather than left to makeItem().
  //
  // makeItem() defaults `z` to topZ() + 1, which reads the *live* board - and
  // the batch is not on it yet. So a group added in one call every one of them
  // read the same number and landed on a single layer. One flat layer is a
  // stacking order nobody chose, and two things went wrong on top of it:
  // duplicating a pile came back flat, defeating the sort in itemsIn() that
  // exists for exactly that reason, and stuckTo() - which needs a *strictly*
  // lower z - stopped recognising the pair. Copy a photo with a note on it and
  // the copied note was not stuck to the copied photo; it silently attached
  // itself to whatever else happened to be underneath.
  //
  // An explicit z is still honoured, because loadBoard() and the bin restore
  // items that already have one and must come back exactly where they were.
  let z = topZ();
  let added = items.map(partial =>
    makeItem(partial.z != null ? partial : { ...partial, z: ++z }));
  if (options.avoidOverlap && board.layoutMode === 'mobile') {
    added = placeMobileItems(added);
  } else {
    added = added.map(item => fitBoardMode(onLattice(item)));
  }
  commit(label,
    () => { const fresh = added.filter(a => !byId(a.id));
            board.items.push(...fresh);
            bus.emit('items', { added: fresh.map(a => a.id), removed: [] }); },
    () => { const ids = new Set(added.map(a => a.id));
            board.items = board.items.filter(i => !ids.has(i.id));
            ids.forEach(id => selection.delete(id));
            bus.emit('items', { added: [], removed: [...ids] }); bus.emit('selection'); });
  return added;
}

const MOBILE_PACK_EPSILON = 1e-9;

/** Number of Mobile grid cells needed to contain one unrotated side. */
function mobileCellSpan(side, step, maximum = Number.POSITIVE_INFINITY) {
  const seam = 2 * cellInset(step);
  return Math.min(
    Math.max(Math.ceil((side + seam) / step - MOBILE_PACK_EPSILON), 1),
    maximum,
  );
}

/** First full grid row below every item that is staying where it is. */
function mobilePackStartRow(obstacles, step) {
  const bounds = itemBounds(obstacles);
  if (!bounds) return 0;
  return Math.max(
    0,
    Math.ceil((MOBILE_TOP_ROWS * step - bounds.y0) / step - MOBILE_PACK_EPSILON),
  );
}

/** Compact row-major packing into the selected Mobile occupancy grid. */
function packMobileGrid(items, obstacles, step, columns) {
  const occupied = new Set();
  const startRow = mobilePackStartRow(obstacles, step);
  const inset = cellInset(step);
  const open = (col, row, cols, rows) => {
    for (let y = row; y < row + rows; y++) {
      for (let x = col; x < col + cols; x++) {
        if (occupied.has(`${x}:${y}`)) return false;
      }
    }
    return true;
  };
  const claim = (col, row, cols, rows) => {
    for (let y = row; y < row + rows; y++) {
      for (let x = col; x < col + cols; x++) occupied.add(`${x}:${y}`);
    }
  };

  return items.map(item => {
    const cols = mobileCellSpan(item.w, step, columns);
    const rows = mobileCellSpan(item.h, step);
    let row = startRow;
    let col = 0;
    let found = false;
    while (!found) {
      for (col = 0; col <= columns - cols; col++) {
        if (open(col, row, cols, rows)) {
          found = true;
          break;
        }
      }
      if (!found) row++;
    }
    claim(col, row, cols, rows);
    const left = (-columns / 2 + col) * step;
    const top = (MOBILE_TOP_ROWS - row) * step;
    return {
      ...item,
      // Anchor the visible box, not its centre, to the cell seam. Centring an
      // off-lattice size inside its claimed span can leave either edge a pixel
      // across a grid or board rule; the top-left seam is deterministic and
      // keeps the whole box inside the cells it owns.
      x: left + inset + item.w / 2,
      y: top - inset - item.h / 2,
      rot: 0,
    };
  });
}

/**
 * Append items to Mobile as a compact selected-width grid without overlap.
 *
 * The incoming order still comes from the selected arrangement. Each item's
 * fitted dimensions become a rectangular cell span, then a row-major first-fit
 * search puts compatible spans beside one another before moving downward.
 * Existing items set the first available row, so imports and partial
 * rearrangements stay below content that was not part of the operation.
 *
 * Snapped and unsnapped geometry are packed separately. The snapped copy uses
 * the lattice's normal inset seam; its presnap memo therefore restores another
 * collision-free grid layout if the user later turns snapping off.
 */
export function placeMobileItems(items, obstacles = board.items, options = {}) {
  const step = options.step > 0 ? options.step : baseStep();
  const snap = options.snap ?? board.settings.snap;
  const preserveSize = options.preserveSize === true;
  const columns = mobileColumnCount(options.columns ?? board.settings.mobileColumns);
  const clean = item => {
    const presnap = usableMemo(item.meta?.presnap);
    const { presnap: _oldPresnap, ...meta } = item.meta || {};
    const source = presnap ? { ...item, ...presnap } : item;
    return fitMobile({ ...source, meta, rot: 0 }, true, step, columns);
  };
  const rawItems = items.map(clean);
  const rawObstacles = obstacles.map(item => {
    const pre = usableMemo(item.meta?.presnap);
    return fitMobile(pre ? { ...item, ...pre } : item, false, step, columns);
  });
  const raw = packMobileGrid(rawItems, rawObstacles, step, columns);
  if (!snap) return raw;

  const liveItems = preserveSize
    ? items.map(item => {
        const { presnap: _oldPresnap, ...meta } = item.meta || {};
        return fitMobile({ ...item, meta, rot: 0 }, true, step, columns);
      })
    : rawItems.map(item => {
        const box = latticeBox(item, step);
        return fitMobile({ ...item, w: box.w, h: box.h }, false, step, columns);
      });
  const liveObstacles = obstacles.map(item => fitMobile(item, false, step, columns));
  return packMobileGrid(liveItems, liveObstacles, step, columns).map((item, index) => ({
    ...item,
    meta: {
      ...item.meta,
      presnap: {
        x: raw[index].x,
        y: raw[index].y,
        w: raw[index].w,
        h: raw[index].h,
      },
    },
  }));
}

/** Reflow the live Mobile board after its column count changes. */
function repackMobileBoard() {
  if (!board.items.length) return;
  const ordered = [...board.items].sort((a, b) =>
    b.y - a.y || a.x - b.x || a.id.localeCompare(b.id));
  const before = snapshotGeom(ordered.map(item => item.id));
  // Stuck notes ride their host through a reflow instead of being repacked into
  // their own column slot; they keep their size and follow the host to its new
  // place. See attachRiders().
  // The Desktop title card is not part of the Mobile board at all: it is neither
  // packed into a column nor an obstacle for what is, and applyGeom below leaves
  // its geometry untouched (it never lands in `target`).
  const packable = ordered.filter(it => !isRider(it) && it.type !== 'title');
  const riders = ordered.filter(isRider);
  const target = new Map(placeMobileItems(packable, []).map(item => [item.id, item]));
  attachRiders(riders, target, (note, hostSrc, hostDst) => {
    const at = stuckPlacement(note, hostSrc, hostDst);
    return { ...note, x: at.x, y: at.y };
  });
  applyGeom(before.map(geometry => {
    const item = target.get(geometry.id);
    if (!item) return geometry;          // a rider whose host vanished: leave it
    return {
      ...geometry,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      rot: item.rot,
      presnap: item.meta?.presnap ? { ...item.meta.presnap } : null,
    };
  }));
  commitGeom('Change Mobile grid width', before, ordered.map(item => item.id), {
    preservePresnap: true,
  });
}

/**
 * Whatever the lattice is measured in, with the fallback in one place.
 *
 * The *base* step, never the on-screen one. gridStep() in canvas/grid.js picks
 * a spacing from the zoom so the dots never become a fill, which is right for
 * something drawn and wrong for something stored - see snapAll() below.
 *
 * Exported because main.js's Rearrange lays the whole board out at once and has
 * to size the slots on the same lattice snapAll() would - and a second copy of
 * `gridStep > 0 ? gridStep : 64` in another file is how the two would come to
 * disagree about a board whose step is missing.
 */
export function baseStep() {
  return board.settings.gridStep > 0 ? board.settings.gridStep : 64;
}

/**
 * A new item laid on the lattice, if the board is snapped.
 *
 * Without this, snapping only governed items that were already on the board
 * when it was switched on, plus anything dragged afterwards - so a snapped
 * board grew a photograph at 320x240 sitting a few pixels off every line it was
 * meant to sit on, and the only way to line it up was to switch snapping off
 * and on again. Arriving is a placement like any other.
 *
 * Sizes as well as positions, because a box on the lattice that is not a whole
 * number of cells is only snapped along two of its four edges, and it is the
 * ragged right and bottom that a person actually sees.
 *
 * The presnap memo is what makes this reversible: unsnapAll() puts every item
 * carrying one back to the geometry it had before the lattice, and an imported
 * item that never had a life before the lattice would otherwise be stranded at
 * its snapped size when snapping is turned off. An existing memo is left alone
 * - a duplicated or pasted item brings its own, and it is a memo of life before
 * the *first* snap, not of the copy's.
 */
function onLattice(it) {
  if (!board.settings.snap) return it;
  const box = latticeBox(it, baseStep());
  if (box.x === it.x && box.y === it.y && box.w === it.w && box.h === it.h) return it;
  return {
    ...it,
    x: box.x, y: box.y, w: box.w, h: box.h,
    meta: it.meta?.presnap
      ? it.meta
      : { ...it.meta, presnap: { x: it.x, y: it.y, w: it.w, h: it.h } },
  };
}

/**
 * How many things the bin holds before the oldest start falling out the
 * bottom. A bin is a safety net, not an archive - and every entry pins its
 * asset's bytes into the saved file, so an unbounded one would quietly make a
 * board grow forever as you worked on it.
 */
const TRASH_LIMIT = 60;

export function removeItems(ids, label = 'Delete') {
  const set = new Set(ids);
  // Keep the original index so undo restores z-order position, not just the item.
  const removed = board.items
    .map((item, index) => ({ item, index }))
    .filter(r => set.has(r.item.id));
  if (!removed.length) return;
  // The Desktop title card does not go to the bin - it is a singleton the board
  // is meant to have, so it is hidden and offered back by its own restore button
  // (see ui/trash.js) rather than filed among thrown-away items. Only the rest
  // are binned; deleting the title also flips the flag, and undo flips it back.
  const titleGone = removed.some(r => r.item.type === 'title');
  const wasHidden = board.titleHidden;
  const binned = removed
    .filter(r => r.item.type !== 'title')
    .map(r => ({ item: r.item, at: Date.now() }));
  const binIds = new Set(binned.map(b => b.item.id));
  // What this delete pushed out the bottom of the bin, so undo can put it back.
  //
  // Truncating used to be a one-liner on the grounds that the entries falling
  // out are older than the delete and so belong to no undo entry being replayed
  // - which is true and beside the point. They were still in the bin before
  // this command ran and gone after it, which makes them part of what it did.
  // On a full bin, deleting one item and immediately undoing it left the bin
  // one entry short for good, and the entry that vanished was the oldest thing
  // in there: the one furthest past the point of being able to get it back any
  // other way.
  let evicted = [];
  commit(label,
    () => { board.items = board.items.filter(i => !set.has(i.id));
            set.forEach(id => selection.delete(id));
            if (titleGone) board.titleHidden = true;
            board.trash.unshift(...binned);
            evicted = board.trash.splice(TRASH_LIMIT);   // [] while under the limit
            bus.emit('items', { added: [], removed: [...set] });
            bus.emit('selection'); bus.emit('trash'); },
    () => { for (const r of removed) board.items.splice(r.index, 0, r.item);
            board.titleHidden = wasHidden;
            board.trash = board.trash.filter(t => !binIds.has(t.item.id));
            // Back on the end, which is where they were: the entries this
            // command added went on the front, and undo has just taken them off.
            board.trash.push(...evicted);
            evicted = [];
            bus.emit('items', { added: removed.map(r => r.item.id), removed: [] });
            bus.emit('trash'); });
}

/**
 * The Desktop title card: its fixed geometry and the two helpers that keep it a
 * singleton. Defined here, below the item plumbing, so it can lean on makeItem.
 */
// Four grid spaces wide at the default 64px grid step, and 3:2 tall (256 * 2/3
// = 170.67) - the Mobile masthead's own aspect (MOBILE_HEADER_ASPECT). The card
// visual is held to an exact 3:2 in CSS; this is the item's footprint. Snapping
// rounds it up to whole cells (4x3 = 256x192), and the card stays 3:2 and
// top-aligned inside, so the extra height falls as slack below it.
const TITLE_SIZE = Object.freeze({ w: 256, h: 171 });
// Top-centre, above where a fresh board's items land: x centres it (item x is
// the box centre), +y is up (world plane), so this sits the card over the origin.
// One grid space (64) higher than it first sat, to clear the content below it.
const TITLE_DEFAULT_POS = Object.freeze({ x: 0, y: 244 });

function makeTitleItem(at = null) {
  return makeItem({
    id: TITLE_ID,
    type: 'title',
    x: at?.x ?? TITLE_DEFAULT_POS.x,
    y: at?.y ?? TITLE_DEFAULT_POS.y,
    w: TITLE_SIZE.w,
    h: TITLE_SIZE.h,
  });
}

/**
 * Put the title card on the board if it belongs there and is missing. Board
 * hydration, not a user edit: no commit, no history - it runs on load and at
 * startup, the same way default settings are simply present. A board that threw
 * the card away (titleHidden) keeps it away.
 */
export function ensureTitleCard() {
  if (board.titleHidden) return;
  if (board.items.some(i => i.type === 'title')) return;
  board.items.push(makeTitleItem());
}

/** Whether the Desktop title card is currently thrown away (bin shows its button). */
export const isTitleHidden = () => !!board.titleHidden;

/**
 * Send the title card back to its default spot (top-centre). The card is a
 * movable singleton with no other way home short of deleting and restoring it,
 * so this is its "Reset size" - one undoable step, and a no-op if it is already
 * there. Uses the same geometry funnel a drag does, so it snaps and round-trips
 * like any move.
 */
export function resetTitlePosition() {
  const item = board.items.find(i => i.type === 'title');
  if (!item) return;
  if (item.x === TITLE_DEFAULT_POS.x && item.y === TITLE_DEFAULT_POS.y) return;
  const before = snapshotGeom([item.id]);
  applyGeom([{ id: item.id, x: TITLE_DEFAULT_POS.x, y: TITLE_DEFAULT_POS.y,
               w: item.w, h: item.h, rot: item.rot, z: item.z }]);
  commitGeom('Reset title position', before, [item.id]);
}

/**
 * Bring the title card back from its deleted state - the bin's restore button.
 * Undoable, unlike ensureTitleCard(): this is a user action, so it earns a
 * history step the way restoring a binned item does.
 */
export function restoreTitleCard(at = null) {
  if (!board.titleHidden && board.items.some(i => i.type === 'title')) return;
  const item = makeTitleItem(at);
  commit('Restore title',
    () => { board.titleHidden = false;
            if (!board.items.some(i => i.id === item.id)) board.items.push(item);
            bus.emit('items', { added: [item.id], removed: [] });
            bus.emit('trash'); },
    () => { board.titleHidden = true;
            board.items = board.items.filter(i => i.id !== item.id);
            selection.delete(item.id);
            bus.emit('items', { added: [], removed: [item.id] });
            bus.emit('selection'); bus.emit('trash'); });
}

/**
 * Take things back out of the bin.
 *
 * `at` is where the item should land - the point it was dropped on when it was
 * dragged out of the bin panel. Without one it goes back exactly where it was
 * deleted from, which is what the bin's own Restore does.
 *
 * Restored items are stacked on top rather than returned to their old z: they
 * were absent while everything else moved on, and coming back underneath a
 * pile is the same as not coming back.
 */
export function restoreItems(ids, at = null, label = 'Restore') {
  const set = new Set(ids);
  const entries = board.trash.filter(t => set.has(t.item.id));
  if (!entries.length) return [];
  let z = topZ();
  const items = entries.map(e => fitBoardMode({
    ...e.item,
    ...(at ? { x: at.x, y: at.y } : null),
    z: ++z,
  }));
  const back = new Set(items.map(i => i.id));
  commit(label,
    () => { const fresh = items.filter(i => !byId(i.id));
            board.items.push(...fresh);
            board.trash = board.trash.filter(t => !set.has(t.item.id));
            bus.emit('items', { added: fresh.map(i => i.id), removed: [] });
            bus.emit('trash'); },
    () => { board.items = board.items.filter(i => !back.has(i.id));
            back.forEach(id => selection.delete(id));
            board.trash.unshift(...entries);
            bus.emit('items', { added: [], removed: [...back] });
            bus.emit('selection'); bus.emit('trash'); });
  return items;
}

/** Throw the bin out. Undoable - emptying it by accident is a bad afternoon. */
export function emptyTrash() {
  if (!board.trash.length) return;
  const held = board.trash;
  commit('Empty trash',
    () => { board.trash = []; bus.emit('trash'); },
    () => { board.trash = held; bus.emit('trash'); });
}

const GEOM_KEYS = ['x', 'y', 'w', 'h', 'rot', 'z'];

/** The fixed width of the Mobile board in world units. */
export function mobileBoardWidth(
  step = baseStep(),
  columns = mobileColumnCount(),
) {
  return mobileColumnCount(columns) * step;
}

/**
 * The Mobile board's width read from the Mobile layout's own settings, whatever
 * layout is on screen.
 *
 * mobileBoardWidth() above answers for the *active* layout - its grid step and
 * its column count - which while Desktop shows is the Desktop grid and the
 * Desktop mobileColumns default (6, not the Mobile 8). The Desktop title card
 * needs the true Mobile figure: the masthead caps its font at 96px against this
 * width, so a card measuring 6x64=384 skipped the cap the 8x64=512 masthead
 * hits, ran its text larger, and wrapped sooner than the masthead. Read-only -
 * it does not touch the Mobile board. Same profile read repackMobileBoard makes.
 */
export function mobileBoardWorldWidth() {
  const profile = board.layoutSettings.mobile || defaultLayoutSettings('mobile');
  const step = profile.gridStep > 0 ? profile.gridStep : DEFAULT_SETTINGS.gridStep;
  return mobileColumnCount(profile.mobileColumns) * step;
}

/** The highest world-space edge of the Mobile board. */
export function mobileBoardTop(step = baseStep()) {
  return MOBILE_TOP_ROWS * step;
}

/**
 * The content-sized lower edge of the Mobile board.
 *
 * A new or sparse board is still twenty-five rows tall. Once an item reaches
 * below that minimum, the board grows just far enough to keep fifteen clear
 * rows beneath its lowest rendered edge.
 */
export function mobileBoardBottom(items = board.items) {
  const step = baseStep();
  const minimum = mobileBoardTop() - MOBILE_MIN_ROWS * step;
  const bounds = itemBounds(items);
  return bounds ? Math.min(minimum, bounds.y0 - MOBILE_BOTTOM_ROWS * step) : minimum;
}

const geometryOf = it => {
  const out = { id: it.id };
  for (const key of GEOM_KEYS) out[key] = it[key];
  const presnap = usableMemo(it.meta?.presnap);
  if (presnap) out.presnap = { ...presnap };
  return out;
};

function normalizeLayout(raw, items) {
  if (!Array.isArray(raw)) return [];
  const ids = new Set(items.map(it => it.id));
  const seen = new Set();
  const out = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object' || !ids.has(value.id) || seen.has(value.id)) continue;
    if (!GEOM_KEYS.every(key => Number.isFinite(+value[key]))) continue;
    const w = Math.min(Math.max(+value.w, MIN_SIZE), MAX_SIZE);
    const h = Math.min(Math.max(+value.h, MIN_SIZE), MAX_SIZE);
    out.push({
      id: value.id,
      x: +value.x, y: +value.y, w, h,
      rot: +value.rot, z: +value.z,
      ...(usableMemo(value.presnap) ? { presnap: { ...value.presnap } } : {}),
    });
    seen.add(value.id);
  }
  return out;
}

function layoutMap(layout) {
  return new Map((layout || []).map(geometry => [geometry.id, geometry]));
}

/** Keep an item inside the selected-width Mobile strip. */
function fitMobile(
  it,
  scaleHeight = false,
  step = baseStep(),
  columns = mobileColumnCount(),
) {
  const width = mobileBoardWidth(step, columns);
  const inset = cellInset(step);
  const contentWidth = Math.max(MIN_SIZE, width - 2 * inset);
  const oldWidth = Math.min(Math.max(Number.isFinite(it.w) ? it.w : MIN_SIZE, MIN_SIZE), MAX_SIZE);
  const ratio = oldWidth > contentWidth ? contentWidth / oldWidth : 1;
  const w = Math.min(oldWidth, contentWidth);
  const h0 = Math.min(Math.max(Number.isFinite(it.h) ? it.h : MIN_SIZE, MIN_SIZE), MAX_SIZE);
  const h = scaleHeight ? Math.max(MIN_SIZE, h0 * ratio) : h0;
  const half = w / 2;
  const x = Math.min(
    Math.max(Number.isFinite(it.x) ? it.x : 0, -width / 2 + inset + half),
    width / 2 - inset - half,
  );
  const y0 = Number.isFinite(it.y) ? it.y : 0;
  const y = Math.min(y0, mobileBoardTop(step) - inset - h / 2);
  return { ...it, x, y, w, h };
}

const fitBoardMode = (it, scaleHeight = false) =>
  board.layoutMode === 'mobile' ? fitMobile(it, scaleHeight) : it;

/**
 * Complete one profile for every live item.
 *
 * New items have no geometry in the inactive profile yet. Desktop inherits the
 * place where the item was added; Mobile appends it below the existing feed so
 * switching modes never drops a new card on top of an old one.
 */
function completeLayout(mode) {
  const map = layoutMap(board.layouts[mode]);
  if (mode === 'mobile') {
    const profile = board.layoutSettings.mobile || defaultLayoutSettings('mobile');
    const step = profile.gridStep > 0 ? profile.gridStep : DEFAULT_SETTINGS.gridStep;
    const columns = mobileColumnCount(profile.mobileColumns);
    const known = [];
    const missing = [];
    // A note stuck to something on the board rides it into the column rather than
    // being packed as a card of its own, so a pinned sticky stays pinned when the
    // board reflows for Mobile. It is neither packed nor an obstacle; its place is
    // derived from the host once the host has one. A note whose host is gone falls
    // through to being packed like anything else.
    const riders = [];
    for (const it of board.items) {
      // The Desktop title card carries no Mobile place - keep whatever geometry
      // it had (never rendered on Mobile) and take it out of the packing sweep.
      if (it.type === 'title') { map.set(it.id, map.get(it.id) || geometryOf(it)); continue; }
      if (isRider(it)) { riders.push(it); continue; }
      const saved = map.get(it.id);
      if (!saved) {
        missing.push(it);
        continue;
      }
      const presnap = saved.presnap;
      const geometry = {
        ...geometryOf(fitMobile(saved, false, step, columns)),
        ...(presnap ? { presnap: { ...presnap } } : {}),
      };
      map.set(it.id, geometry);
      known.push({
        ...it,
        ...geometry,
        meta: geometry.presnap
          ? { ...it.meta, presnap: { ...geometry.presnap } }
          : it.meta,
      });
    }
    const packed = placeMobileItems(missing, known, {
      step,
      snap: profile.snap,
      columns,
    });
    for (const item of packed) map.set(item.id, geometryOf(item));
    const stranded = attachRiders(riders, map, (note, hostSrc, hostDst) => {
      const at = stuckPlacement(note, hostSrc, hostDst);
      return geometryOf({ ...fitMobile(note, false, step, columns), x: at.x, y: at.y });
    });
    // A rider whose host never resolved - deleted, or a stuck-to-stuck cycle -
    // is packed after all, so it is at least visible somewhere.
    if (stranded.size) {
      const rest = riders.filter(r => stranded.has(r.id));
      const extra = placeMobileItems(rest, [...known, ...packed], {
        step, snap: profile.snap, columns,
      });
      for (const item of extra) map.set(item.id, geometryOf(item));
    }
    const out = board.items.map(item => map.get(item.id));
    board.layouts.mobile = out;
    return out;
  }

  const out = [];
  for (const it of board.items) {
    let geometry = map.get(it.id);
    if (!geometry) geometry = geometryOf(it);
    out.push(geometry);
  }
  board.layouts[mode] = out;
  return out;
}

function captureLayout(mode = board.layoutMode) {
  board.layouts[mode] = board.items.map(geometryOf);
}

/** Save the active layout's private settings and refresh the shared look. */
function captureLayoutSettings(mode = board.layoutMode) {
  const { shared } = splitAppearance(board.settings.appearance);
  board.sharedAppearance = cloneSettings({ appearance: shared }).appearance;
  board.layoutSettings[mode] = layoutSettingsOf(board.settings);
  board.arrangements[mode] = board.arrangement;
}

/** Make one layout's settings and arrangement the live compatibility surface. */
function activateLayoutSettings(mode) {
  if (mode === 'mobile') {
    // '' rather than 'none': that is what DEFAULT_SETTINGS holds, what the
    // select's None option carries, and what PAPERS has no entry for. A second
    // spelling would read as truthy everywhere `settings.paper` is tested.
    board.layoutSettings.mobile.paper = '';
    board.layoutSettings.mobile.paperLandscape = false;
    board.layoutSettings.mobile.paperResize = false;
    board.layoutSettings.mobile.spacing = 0;
  }
  const fonts = (board.layoutSettings.desktop.fonts || [])
    .map(font => ({ ...font }));
  board.layoutSettings.desktop.fonts = fonts.map(font => ({ ...font }));
  board.layoutSettings.mobile.fonts = fonts.map(font => ({ ...font }));
  const profile = board.layoutSettings[mode] || defaultLayoutSettings(mode);
  board.layoutSettings[mode] = cloneSettings(profile);
  board.settings = settingsFor(profile, board.sharedAppearance);
  board.arrangement = board.arrangements[mode] || 'spiral';
}

function writeLayout(layout) {
  const map = layoutMap(layout);
  const ids = [];
  for (const it of board.items) {
    const saved = map.get(it.id);
    if (!saved) continue;
    const next = fitBoardMode({ ...it, ...saved });
    for (const key of GEOM_KEYS) it[key] = next[key];
    if (saved.presnap) it.meta = { ...it.meta, presnap: { ...saved.presnap } };
    else forgetPresnap(it);
    ids.push(it.id);
  }
  if (ids.length) bus.emit('geom', ids);
}

/**
 * Switch which geometry profile is live.
 *
 * Content and the board-wide color identity never move. Geometry, arrangement,
 * and every other setting are exchanged as one profile. History is cleared
 * because neither geometry nor setting undo may replay into the other layout.
 */
export function setBoardMode(mode) {
  if (!BOARD_MODES.includes(mode) || mode === board.layoutMode) return false;
  captureLayout();
  captureLayoutSettings();
  const generated = mode === 'mobile' && !(board.layouts.mobile || []).length && board.items.length;
  board.layoutMode = mode;
  activateLayoutSettings(mode);
  writeLayout(completeLayout(mode));
  clearHistory();
  if (generated) markDirty();
  bus.emit('layout', mode);
  bus.emit('settings', 'profile');
  return true;
}

/** Geometry snapshot for a set of ids - the before/after pair of a drag. */
export function snapshotGeom(ids) {
  return [...ids].map(id => {
    const it = byId(id);
    if (!it) return null;
    const g = { id };
    for (const k of GEOM_KEYS) g[k] = it[k];
    const presnap = usableMemo(it.meta?.presnap);
    g.presnap = presnap ? { ...presnap } : null;
    return g;
  }).filter(Boolean);
}

/** Write a geometry snapshot back onto the items (live, not undoable). */
export function applyGeom(snap) {
  const ids = [];
  for (const g of snap) {
    const it = byId(g.id);
    if (!it) continue;
    const next = fitBoardMode({ ...it, ...g });
    for (const k of GEOM_KEYS) it[k] = next[k];
    if ('presnap' in g) {
      const presnap = usableMemo(g.presnap);
      if (presnap) it.meta = { ...it.meta, presnap: { ...presnap } };
      else forgetPresnap(it);
    }
    ids.push(g.id);
  }
  bus.emit('geom', ids);
}

/**
 * Close a live drag/resize into one undo entry. `before` is the snapshot taken
 * when the gesture started; the current geometry becomes the redo state.
 */
export function commitGeom(label, before, driven, options = {}) {
  let after = snapshotGeom(before.map(b => b.id));
  const changed = after.some((a, i) => GEOM_KEYS.some(k => a[k] !== before[i][k]));
  if (!changed) return;
  // What the gesture actually had hold of, as opposed to what came along for
  // the ride. Only these ask again where they are stuck; see restick(). Left
  // out entirely by callers that move things without anybody touching them -
  // Bring to front, the embed's fit - which change no note's position relative
  // to anything and so change no answer.
  if (driven) restick(driven);
  // Placed by hand while snapping was on: this *is* where the item belongs
  // now, so it gives up its memory of where it sat before the board was laid
  // on the lattice. Turning snapping off later leaves it exactly here.
  if (board.settings.snap && !options.preservePresnap) {
    for (let i = 0; i < after.length; i++) {
      if (GEOM_KEYS.some(k => after[i][k] !== before[i][k])) forgetPresnap(byId(after[i].id));
    }
    after = snapshotGeom(before.map(b => b.id));
  }
  commit(label, () => applyGeom(after), () => applyGeom(before));
}

// ---------------------------------------------------------------------------
// Snapping the whole board
// ---------------------------------------------------------------------------

/**
 * Turning snapping on lays every item on the lattice at once, rather than only
 * governing the next thing you drag - so the board *looks* snapped the moment
 * the setting is on, which is the only way a grid reads as a grid.
 *
 * Turning it off puts everything back. That needs the old geometry kept
 * somewhere, and it goes in `meta.presnap` on the item: per item, so an item
 * touched during a snapped session can drop its own memo without affecting the
 * rest, and serialised with the board, so the promise survives a save and a
 * reload rather than lasting only as long as the tab.
 *
 * Two consequences worth being explicit about:
 *
 * - **The step is the base step, not the one on screen.** `gridStep()` picks a
 *   spacing from the current zoom so the lattice never becomes a fill, which is
 *   right for something drawn and wrong for something stored: snapping at 20%
 *   zoom would otherwise commit a board to a coarser geometry than snapping at
 *   100%, and the same click would do two different things depending on how far
 *   out you happened to be.
 * - **Edges land on the lattice, not centres**, and the arithmetic is latticeBox() in
 *   geometry.js, shared with the gestures in canvas/input.js so that laying the
 *   board out and then dragging one item across it agree about where things go.
 *   What makes a snapped board look snapped is items sitting flush in cells; an
 *   item whose size is an odd number of cells therefore ends up with its centre
 *   on a half-step, which is correct and is not a rounding error.
 */
function snapAll() {
  const step = baseStep();
  const before = [], after = [];
  for (const it of board.items) {
    const pre = it.meta?.presnap || null;
    before.push({ id: it.id, x: it.x, y: it.y, w: it.w, h: it.h, pre });

    const box = latticeBox(it, step);
    after.push({
      id: it.id,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      // A board snapped, unsnapped and snapped again remembers the first
      // position, not the second - the memo is of life before the lattice.
      pre: pre || { x: it.x, y: it.y, w: it.w, h: it.h },
    });
  }
  applySnapState(before, after, 'Snap to grid');
}

/**
 * Re-assert the geometry rules that can drift from their rendered result.
 *
 * A reload is not an edit by itself. Snapping only records history and dirties
 * the board when it actually repairs a box; the final event also makes every
 * renderer re-read positions when nothing in the data needed changing.
 */
export function recheckBoardGeometry() {
  if (board.settings.snap) snapAll();
  const ids = board.items.map(item => item.id);
  if (ids.length) bus.emit('geom', ids);
}

/** Put back what snapAll() remembered, for everything still carrying a memo. */
function unsnapAll() {
  const before = [], after = [];
  for (const it of board.items) {
    // Checked rather than trusted: a memo arrives from a .mbrd like everything
    // else, and a hand-edited one holding a string would write it straight onto
    // the item's geometry. A memo that does not describe a box is no memo.
    const pre = usableMemo(it.meta?.presnap);
    if (!pre) { forgetPresnap(it); continue; }
    before.push({ id: it.id, x: it.x, y: it.y, w: it.w, h: it.h, pre });
    after.push({ id: it.id, x: pre.x, y: pre.y, w: pre.w, h: pre.h, pre: null });
  }
  applySnapState(before, after, 'Leave the grid');
}

const SNAP_KEYS = ['x', 'y', 'w', 'h'];

function applySnapState(before, after, label) {
  const moved = after.some((a, i) =>
    SNAP_KEYS.some(k => a[k] !== before[i][k]) || !!a.pre !== !!before[i].pre);
  if (!moved) return;
  writeSnapState(after);
  commit(label, () => writeSnapState(after), () => writeSnapState(before));
}

function writeSnapState(list) {
  const ids = [];
  for (const g of list) {
    const it = byId(g.id);
    if (!it) continue;
    const next = fitBoardMode({ ...it, ...g });
    for (const k of SNAP_KEYS) it[k] = next[k];
    if (g.pre) it.meta = { ...it.meta, presnap: g.pre };
    else forgetPresnap(it);
    ids.push(g.id);
  }
  if (ids.length) bus.emit('geom', ids);
}

function forgetPresnap(it) {
  if (!it?.meta || !('presnap' in it.meta)) return;
  const { presnap, ...rest } = it.meta;
  it.meta = rest;
}

/** A memo is four finite numbers with a size that is actually a size. */
function usableMemo(pre) {
  if (!pre || typeof pre !== 'object') return null;
  const ok = SNAP_KEYS.every(k => Number.isFinite(pre[k]));
  if (!ok || pre.w < MIN_SIZE || pre.h < MIN_SIZE || pre.w > MAX_SIZE || pre.h > MAX_SIZE) return null;
  return { x: pre.x, y: pre.y, w: pre.w, h: pre.h };
}

function bottomZ() {
  return board.items.reduce((m, i) => Math.min(m, i.z || 0), 0);
}

export function raiseSelection() {
  const layer = stackLayerIds(selection);
  const before = snapshotGeom(layer);
  if (!before.length) return;
  let z = topZ();
  // Walk in current stacking order so a multi-selection and every sticky layer
  // keep their internal arrangement instead of being reshuffled by Set
  // iteration order.
  for (const id of stackOrder(layer)) byId(id).z = ++z;
  bus.emit('geom', layer);
  commitGeom('Bring to front', before);
}

export function lowerSelection() {
  const layer = stackLayerIds(selection);
  const before = snapshotGeom(layer);
  if (!before.length) return;
  let z = bottomZ();
  for (const id of stackOrder(layer).reverse()) byId(id).z = --z;
  bus.emit('geom', layer);
  commitGeom('Send to back', before);
}

/** The given ids, sorted bottom-to-top by their current z. */
export function stackOrder(ids) {
  return [...ids].sort((a, b) => (byId(a)?.z || 0) - (byId(b)?.z || 0));
}

/**
 * The visual stack, bottom-to-top, with each sticky chain kept as one layer and
 * every note lifted above everything that is not a note.
 *
 * A sticky note is a mark laid *on* the board's contents - a caption, a flag, a
 * scrap - so it is never buried by the picture it annotates or by anything else;
 * only another note may sit over it. The two bands are presentation alone. Raw z
 * still records the host-below-note order that lets a board rediscover sticky
 * relations after loading (see measureStick), so the band is not written back
 * into z and nothing about stickiness changes. And because Bring-to-front /
 * Send-to-back move an item by its raw z, splitting the visible stack into these
 * bands is exactly what makes those actions reorder a note among notes and a
 * non-note among non-notes without either ever crossing into the other's band.
 *
 * Within each band the group order is kept, so a note still sits above the very
 * host it is stuck to, and a pile of notes keeps the order it was laid down in.
 */
export function visualStackOrder() {
  const order = stackGroups().flatMap(group => group.items);
  const notes = [], rest = [];
  for (const item of order) (item.type === 'note' ? notes : rest).push(item.id);
  return [...rest, ...notes];
}

/**
 * Expand ids to every member of their sticky layers, in visual stack order.
 *
 * This goes both directions. Selecting a host includes all its notes; selecting
 * one of those notes also includes the host and its sibling notes for a z-order
 * change, even though an ordinary spatial move may still peel that note away.
 */
export function stackLayerIds(ids) {
  const wanted = new Set([...ids].map(id => byId(id)).filter(Boolean).map(stackRoot).map(item => item.id));
  if (!wanted.size) return [];
  return stackGroups()
    .filter(group => wanted.has(group.root.id))
    .flatMap(group => group.items.map(item => item.id));
}

/**
 * Whether a z-order action could change what the current layer covers.
 *
 * Overlap within a sticky layer does not count: the note and host deliberately
 * cover one another and already move through the external stack as one object.
 */
export function selectionHasStackOverlap(ids = selection) {
  const selected = new Set(stackLayerIds(ids));
  if (!selected.size) return false;
  const inside = board.items.filter(item => selected.has(item.id));
  const outside = board.items.filter(item => !selected.has(item.id));
  return inside.some(a => outside.some(b => overlapFraction(a, b) > 0));
}

/** The bottom-most non-sticky ancestor that owns an item's external layer. */
function stackRoot(item) {
  let root = item;
  const seen = new Set();
  while (root?.type === 'note' && !seen.has(root.id)) {
    seen.add(root.id);
    const host = stuckTo(root);
    if (!host) break;
    root = host;
  }
  return root;
}

/** Sticky layers ordered externally by their root, internally by raw z. */
function stackGroups() {
  const boardOrder = new Map(board.items.map((item, index) => [item.id, index]));
  const groups = new Map();
  for (const item of board.items) {
    const root = stackRoot(item);
    let group = groups.get(root.id);
    if (!group) {
      group = { root, items: [] };
      groups.set(root.id, group);
    }
    group.items.push(item);
  }
  const compare = (a, b) =>
    (a.z || 0) - (b.z || 0) || boardOrder.get(a.id) - boardOrder.get(b.id);
  for (const group of groups.values()) group.items.sort(compare);
  return [...groups.values()].sort((a, b) => compare(a.root, b.root));
}

/**
 * The live items behind a set of ids, bottom-to-top.
 *
 * Sorted, because a copy of several things has to be laid down in the order
 * they were stacked in: addItems() gives each new item the next z as it goes,
 * so handing it the group in board order rather than stacking order would
 * reshuffle a carefully arranged pile every time it was duplicated.
 */
function itemsIn(ids) {
  const set = ids instanceof Set ? ids : new Set(ids);
  // The title card is a board-bound singleton: it cannot be copied, cut,
  // duplicated or pasted. Excluded here - the one funnel all four go through
  // (copy, cut, duplicate; paste reads the clipboard this fills) - so a group
  // that happens to include it simply leaves it behind rather than the whole
  // operation refusing.
  return board.items
    .filter(i => set.has(i.id) && i.type !== 'title')
    .sort((a, b) => (a.z || 0) - (b.z || 0));
}

/**
 * The copy that Duplicate and Paste both make: everything about an item except
 * its identity and its place in the stack.
 *
 * `id` and `z` are left off so makeItem() mints a fresh id and puts the copy on
 * top. The asset is copied by *reference*, never by bytes: assets are keyed by
 * content hash and the packer writes each hash once, so duplicating a 40 MB
 * video costs nothing on disk. meta is shallow-copied because every field in it
 * is a scalar - text, tint, mime, size and the rest.
 */
function cloneItem(i, dx = 0, dy = 0) {
  return {
    type: i.type,
    x: i.x + dx,
    y: i.y + dy,
    w: i.w, h: i.h, rot: i.rot,
    name: i.name,
    asset: i.asset ? { ...i.asset } : null,
    meta: { ...i.meta },
  };
}

/** Copy items, offset a little so the copy is visibly on top of the original. */
export function duplicateItems(ids, offset = { x: 28, y: -28 }) {
  const src = itemsIn(ids);
  if (!src.length) return [];
  const copies = src.map(i => cloneItem(i, offset.x, offset.y));
  return addItems(copies, copies.length > 1 ? `Duplicate ${copies.length} items` : 'Duplicate');
}

// ---------------------------------------------------------------------------
// The internal clipboard
//
// Items are held here rather than pushed onto the system clipboard, because an
// item is not text. It can reference an embedded asset of any size, which has
// no honest text/plain form and which round-tripping through the system
// clipboard would make us re-encode and re-hash on every paste - where a copy
// held in memory shares the original's asset hash for free, exactly as
// Duplicate does. What does go out to the system clipboard is a readable
// summary, so that copying a sticky note and pasting it into a text editor
// gives you its words.
// ---------------------------------------------------------------------------

const clipboard = { items: [], text: '', pastes: 0 };

export const clipboardSize = () => clipboard.items.length;

/** The box the clipboard's contents were copied from, or null when it is empty. */
export const clipboardBounds = () => itemBounds(clipboard.items);

/**
 * Whether the text the system clipboard is offering is the text *we* put there.
 *
 * This is the one question that decides a paste, and the browser gives no way
 * to ask it directly: two clipboards exist - ours and the machine's - and
 * nothing reports which of them was filled more recently. So a copy leaves a
 * receipt. The exact string handed to the system clipboard is remembered here,
 * and a paste that arrives carrying it is a paste of our own copy: nothing has
 * been copied anywhere else since. A paste carrying anything else means the
 * user has been somewhere else and copied something there, and that newer thing
 * is what they mean by Ctrl+V.
 *
 * The receipt is the summary text itself rather than a hidden token, so that
 * what lands in a text editor is clean. The cost is a collision no wider than
 * copying a note, going away, copying that same text back verbatim from
 * somewhere else, and returning - which yields a copy of the note instead of a
 * new note of the same words, and is not a bad answer to a question nobody can
 * answer correctly.
 */
export function clipboardHasOurs(systemText) {
  return !!clipboard.items.length && !!clipboard.text && systemText === clipboard.text;
}

/**
 * Take a copy of some items. Not a board mutation, so nothing to undo.
 *
 * Returns the text the caller should hand to the system clipboard, or '' when
 * there was nothing to copy. That half is the caller's, because only a real
 * `copy`/`cut` event may write to the system clipboard synchronously.
 */
export function copyItems(ids) {
  const text = take(ids);
  if (text) toast(`Copied ${count(clipboard.items.length)}`);
  return text;
}

/**
 * The copy itself, without the receipt.
 *
 * Cut takes exactly this copy but has something else to say about it, and two
 * toasts in the same turn are not two messages - the second replaces the first
 * inside a frame, so all the user sees is the last one and all the first one
 * did was reset the fade.
 */
function take(ids) {
  const src = itemsIn(ids);
  if (!src.length) return '';
  clipboard.items = src.map(i => cloneItem(i));
  clipboard.pastes = 0;
  clipboard.text = summarise(src);
  return clipboard.text;
}

/** "1 item" / "3 items", for the three clipboard receipts. */
const count = n => `${n} item${n === 1 ? '' : 's'}`;

/**
 * Copy, then delete: one undo entry, because removeItems() is the only half
 * that touched the board. Cut items go to the bin like any other delete, so a
 * cut you never paste is still recoverable.
 *
 * The one of the three that genuinely needed saying out loud: copy and paste
 * both leave something on screen to look at, where cut makes things disappear
 * and looks identical to having pressed delete by mistake. Naming the bin is
 * the useful half of the message - it is the difference between "gone" and
 * "over there".
 */
export function cutItems(ids) {
  const doomed = itemsIn(ids).map(i => i.id);
  const text = take(doomed);
  if (!text) return '';
  removeItems(doomed, doomed.length > 1 ? `Cut ${doomed.length} items` : 'Cut');
  toast(`Cut ${count(doomed.length)} to the bin`);
  return text;
}

/**
 * What a copied selection says on the system clipboard. A note gives up its
 * text, a link its address, and everything else its name - in each case the
 * only part of that item which means anything outside this app. A link's name
 * would be the wrong half here: it is a label, editable and often nothing like
 * the URL, and a link copied out of the board is copied in order to be pasted
 * somewhere that wants the address. The bracketed count is the fallback for a
 * selection with nothing to say - an unnamed photo - because the receipt above
 * only works while the string is never empty.
 */
function summarise(src) {
  const lines = src.map(i => (i.type === 'note' ? i.meta.text
                            : i.type === 'link' ? i.meta.url
                            : i.name) || '').filter(Boolean);
  if (lines.length) return lines.join('\n\n');
  return `[mbrd: ${src.length} item${src.length === 1 ? '' : 's'}]`;
}

/**
 * How far each paste steps off the one before it. The same offset Duplicate
 * uses - up and to the right, where a copy lands on a physical desk.
 */
const PASTE_STEP = { x: 28, y: -28 };

/**
 * Put the internal clipboard on the board.
 *
 * `at` is an optional world point to centre the pasted group on. The caller
 * passes one only when the place the copy was taken from is off screen;
 * otherwise it passes nothing and the copy lands beside its original. Pasting
 * in place is what makes copy/paste usable as "another one of these": the pair
 * appears side by side where you can compare them. It is only when the original
 * is somewhere you are not looking that the middle of the screen beats it,
 * because a paste that lands off screen is indistinguishable from one that did
 * nothing at all.
 *
 * Either way the step accumulates across pastes of the same clipboard, so the
 * second Ctrl+V clears the first instead of hiding underneath it.
 */
export function pasteItems(at = null) {
  if (!clipboard.items.length) return [];
  const n = clipboard.pastes++;
  let dx, dy;
  if (at) {
    // n rather than n + 1, so the first paste at a given point lands *on* it
    // and only the ones after it fan out.
    const b = itemBounds(clipboard.items);
    dx = at.x - (b.x0 + b.x1) / 2 + n * PASTE_STEP.x;
    dy = at.y - (b.y0 + b.y1) / 2 + n * PASTE_STEP.y;
  } else {
    dx = (n + 1) * PASTE_STEP.x;
    dy = (n + 1) * PASTE_STEP.y;
  }
  const copies = clipboard.items.map(i => cloneItem(i, dx, dy));
  const added = addItems(copies, copies.length > 1 ? `Paste ${copies.length} items` : 'Paste');
  // Worth saying even though the copies are visible: a paste that lands under
  // the pointer looks like a paste, but one that fanned out from an original
  // off the edge of the screen can put every copy somewhere you are not
  // looking, and then a working paste and a dead key are the same event.
  toast(`Pasted ${count(added.length)}`);
  return added;
}

// ---------------------------------------------------------------------------
// Sticky notes that stick
//
// A note is stuck to whatever it is lying on, and a stuck note travels with its
// host. Nothing about that is stored *in the board file*: stuckness is a fact
// about where two things are, and a file that also recorded it could disagree
// with its own geometry - a hazard with no upside, since the geometry is right
// there and the answer falls out of it.
//
// It is not recomputed on demand either, and that is the part worth naming. The
// relation is worked out from live geometry the first time anything asks, and
// then *remembered* until the note itself is handled. Which means moving a
// photo, resizing it, or dropping something else on top of it cannot quietly
// re-parent the notes lying on it - the pile you built stays the pile you
// built. Only picking up the note itself asks the question again.
//
// The memo is a runtime Map, not a field. A board that has just loaded has an
// empty one and answers every question by measuring, which is exactly what the
// old always-measure version did, so a .mbrd needs no new key and one written
// by an older version is not missing anything.
// ---------------------------------------------------------------------------

/**
 * How much of a note has to be over an item before it counts as stuck.
 *
 * A twentieth of the note. Low on purpose: a sticky pressed onto the corner of
 * a photograph is stuck to that photograph, and anybody who put it there thinks
 * so. The floor exists to rule out the note that merely *touches* while it is
 * being dragged past, which at zero would grab a host for one frame and let go
 * again.
 */
export const STICK_MIN = 0.05;

/**
 * noteId -> hostId or null. Null is a real answer, "measured, and it is stuck to
 * nothing", and it has to survive as one: falling through to a fresh
 * measurement every time would make a loose note the one case that *does* get
 * re-parented by things moving underneath it.
 */
const sticks = new Map();

/**
 * The item a sticky note is stuck to, or null.
 *
 * Measured by area: more than STICK_MIN of the note's own surface lying over
 * the item. Area rather than the note's centre or its top corners, because
 * those are questions about three particular points and this is a question
 * about a sheet of paper lying on something - a note overlapping a photo's
 * corner by a third of itself is obviously stuck to it, and no test of the
 * centre will ever say so.
 *
 * Only notes stick, and only to something below them in the stack. A note
 * hidden behind the thing it claims to be stuck to would be a relationship
 * nobody could see, and being seen is the whole of the point. It costs nothing
 * to arrange, either: startMove() lifts whatever you drag to the top, so a note
 * dropped onto a photo is already above it. Where several candidates qualify -
 * a note on a note on a photo - the nearest one underneath wins, so a pile
 * hangs together in the order it was laid down.
 */
export function stuckTo(note) {
  if (!note || note.type !== 'note') return null;
  if (sticks.has(note.id)) {
    const id = sticks.get(note.id);
    if (id === null) return null;
    const host = byId(id);
    // A remembered host that is no longer on the board - deleted, or undone
    // back out of existence. Measuring again is the lesser evil: the note did
    // not move, so the rule says leave it, but leaving it means a note that can
    // never stick to anything again until somebody happens to drag it.
    if (host) return host;
    sticks.delete(note.id);
  }
  const host = measureStick(note);
  sticks.set(note.id, host ? host.id : null);
  return host;
}

function measureStick(note) {
  let best = null;
  for (const it of board.items) {
    if (it.id === note.id || (it.z || 0) >= (note.z || 0)) continue;
    if (best && (it.z || 0) < (best.z || 0)) continue;
    if (overlapFraction(note, it) > STICK_MIN) best = it;
  }
  return best;
}

/**
 * The item a prospective note box would stick to if let go as given, or null.
 *
 * The same rule as measureStick - the topmost item more than STICK_MIN covered -
 * but asked of a box that is not on the board yet, so a drag can decide to skip
 * the grid *before* it commits the move. No z compare is needed: startMove()
 * raised the dragged note to the top when the gesture began, so every other item
 * is already below it, and the box carries no z to compare anyway.
 */
export function wouldStick(box, excludeId) {
  let best = null;
  for (const it of board.items) {
    if (it.id === excludeId) continue;
    if (best && (it.z || 0) < (best.z || 0)) continue;
    if (overlapFraction(box, it) > STICK_MIN) best = it;
  }
  return best;
}

/**
 * Forget what these notes were stuck to, so the next question measures again.
 *
 * Called with the ids a gesture *drove* - what the pointer or the arrow keys
 * actually had hold of - and never with the followers those ids dragged along.
 * That distinction is the feature: a note carried across the board by the photo
 * underneath it has not been moved relative to anything and must not be
 * re-parented, while a note you picked up and put down has been, and must.
 */
export function restick(ids) {
  for (const id of ids) sticks.delete(id);
}

/** Nothing on the old board is a fact about the new one. */
export const forgetSticks = () => sticks.clear();

/**
 * Seed the memo from what a loaded board wrote down.
 *
 * Stickiness is measured, not stored, everywhere *inside* a session - but a
 * pixel of geometry drift across a save/reload, or a Mobile layout that parked a
 * note a hair off its host, could drop the overlap under STICK_MIN and lose a
 * relationship the author plainly made. `meta.stuckTo` is the durable record
 * (stamped at serialize time); seeding it here makes the saved answer win over a
 * fresh measurement, while an older board with no such key measures as before.
 * A null is kept as the real answer "loose", exactly as the memo treats it.
 */
function seedSticks() {
  sticks.clear();
  for (const it of board.items) {
    if (it.type === 'note' && it.meta && 'stuckTo' in it.meta) {
      sticks.set(it.id, it.meta.stuckTo ?? null);
    }
  }
}

/**
 * Where a note sits relative to its host, as a fraction of the host's size.
 *
 * Fractions rather than world units so the offset survives the host being a
 * different size in the other layout: a note pinned to a photo's top-left stays
 * at its top-left when Mobile shrinks the photo to fit a column. Read live at
 * the moment a layout is generated, never stored - the current geometry is the
 * truth, and freezing an offset would fight a note dragged around its host.
 */
function stuckOffset(note, host) {
  return { fx: (note.x - host.x) / (host.w || 1), fy: (note.y - host.y) / (host.h || 1) };
}

/**
 * The centre a stuck note takes in a target layout: its host's place there, plus
 * the offset it holds in the source layout. `hostSrc`/`hostDst` are the same host
 * measured in the two layouts.
 */
export function stuckPlacement(note, hostSrc, hostDst) {
  const off = stuckOffset(note, hostSrc);
  return { x: hostDst.x + off.fx * hostDst.w, y: hostDst.y + off.fy * hostDst.h };
}

/** A note stuck to something still on the board - one that rides, not packs. */
export function isRider(it) {
  return it.type === 'note' && !!stuckTo(it);
}

/**
 * Place each rider on its host inside a target layout, in passes so a note stuck
 * to a note resolves only once its own host has a place. `place` is the target
 * geometry map, keyed by id; `build(note, hostSrc, hostDst)` returns the entry to
 * store. Returns the ids that never resolved - a deleted host, or a cycle - for
 * the caller to fall back on. hostSrc is read live (the source layout); hostDst
 * is the host's entry in `place`.
 */
function attachRiders(riders, place, build) {
  const pending = new Set(riders.map(r => r.id));
  for (let grew = true; grew && pending.size;) {
    grew = false;
    for (const note of riders) {
      if (!pending.has(note.id)) continue;
      const host = stuckTo(note);
      if (!host) { pending.delete(note.id); continue; }
      if (pending.has(host.id)) continue;        // host is a rider, not placed yet
      const hostDst = place.get(host.id);
      if (!hostDst) continue;                     // host not laid out yet this pass
      place.set(note.id, build(note, byId(host.id), hostDst));
      pending.delete(note.id);
      grew = true;
    }
  }
  return pending;
}

/**
 * The ids of the notes that have to come along when `ids` are moved.
 *
 * Transitive, so a note stuck to a note stuck to a photo travels with the
 * photo: a pile of stickies on a picture reads as one object, and having to
 * move it in two goes would be the surprise. The walk cannot loop - being stuck
 * requires a lower z, which makes the relation a strict order - but each note
 * leaves the pool as it joins, so termination is a property here rather than an
 * assumption about z.
 *
 * Anything already moving is left out, which is what keeps this from fighting a
 * multi-select drag: a note selected alongside its host is moved once, by the
 * selection, instead of once by the selection and again as a follower.
 */
export function stuckFollowers(ids) {
  const moving = new Set(ids);
  const pool = board.items.filter(i => i.type === 'note' && !moving.has(i.id));
  const out = [];
  // Passes rather than one sweep: a note can only join once whatever it is
  // stuck to has joined, and the pool is in no particular order.
  for (let grew = true; grew;) {
    grew = false;
    for (let n = pool.length - 1; n >= 0; n--) {
      const host = stuckTo(pool[n]);
      if (!host || !moving.has(host.id)) continue;
      moving.add(pool[n].id);
      out.push(pool[n].id);
      pool.splice(n, 1);
      grew = true;
    }
  }
  return out;
}

/**
 * How much a sticky note holds. A sticky is a thought you can take in at a
 * glance - past a couple of hundred characters it is a document, and it wants
 * to be a text file on the board instead. Enforced here as well as in the
 * editor, so a paste, an import or an older .mbrd cannot get around it.
 */
export const NOTE_MAX = 512;

export function setItemText(id, text) {
  const it = byId(id);
  if (it?.type === 'note') text = text.slice(0, NOTE_MAX);
  if (!it || it.meta.text === text) return;
  const prev = it.meta.text;
  commit('Edit note',
    () => { byId(id).meta.text = text; bus.emit('item', id); },
    () => { byId(id).meta.text = prev; bus.emit('item', id); });
}

/**
 * Commit a note's formatted content - the structured `meta.rich` and the
 * plaintext `meta.text` it flattens to - as one undoable step, so a single Ctrl+Z
 * takes back the whole edit rather than the two halves separately. A no-op when
 * neither half moved, which is what keeps closing an editor you only looked at
 * from spending a history slot. `rich` is trusted to be normalised by the caller
 * (canvas/notes.js), and `text` is capped here the way setItemText caps its own.
 */
export function setNoteContent(id, rich, text) {
  const it = byId(id);
  if (!it || it.type !== 'note') return;
  text = String(text ?? '').slice(0, NOTE_MAX);
  const prevRich = it.meta.rich;
  const prevText = it.meta.text;
  if (prevText === text && JSON.stringify(prevRich) === JSON.stringify(rich)) return;
  const write = (t, r) => {
    const m = byId(id).meta;
    m.text = t;
    if (r === undefined) delete m.rich;
    else m.rich = r;
    bus.emit('item', id);
  };
  commit('Edit note', () => write(text, rich), () => write(prevText, prevRich));
}

/**
 * Turn one item into an item of another kind, as a single undoable step.
 *
 * The item is replaced rather than edited, and the replacement is minted with
 * a fresh id. That is not bookkeeping. canvas/items.js caches one node per id
 * and writes the type onto that node when it is *built*, and the stylesheet
 * keys off it - so an item that changed type under a node that stayed would go
 * on wearing the old type's clothes until something unrelated forced a
 * rebuild. Retiring the id retires the node with it, which is the only way to
 * get an honest one back without reaching into the renderer from here.
 *
 * Position, rotation and stacking carry over unless `next` overrules them:
 * this is the same thing seen differently, and it should not move or change
 * places in the pile. The selection follows the swap in both directions, so
 * whichever of the pair is on the board is the one that is selected, and an
 * undo hands the original back ready to be dragged rather than anonymous.
 *
 * The slot to write into is found by identity when the command runs, not by an
 * index captured while it is being built. Undo may be pressed three edits
 * later, by which time a position recorded now is pointing at somebody else.
 */
export function retypeItem(id, next, label = 'Change item') {
  const old = byId(id);
  if (!old) return null;
  const item = makeItem({ x: old.x, y: old.y, rot: old.rot, z: old.z, ...next });
  const swap = (out, into) => {
    const at = board.items.indexOf(out);
    if (at < 0) return;
    board.items.splice(at, 1, into);
    if (selection.delete(out.id)) selection.add(into.id);
    bus.emit('items', { added: [into.id], removed: [out.id] });
    bus.emit('selection');
  };
  commit(label, () => swap(old, item), () => swap(item, old));
  return item;
}

/**
 * Call an item something else.
 *
 * An empty name never sticks. A picture wears its name on the caption plate
 * that build() only draws `if (item.name)`, so clearing it would take away the
 * very handle you renamed it by and leave the item anonymous with no way back -
 * a one-way door, on the one edit people make by accident most. Blank therefore
 * means "put it back", and what goes back is the name the file arrived under:
 * the asset registry has held it since the import and a .mbrd carries it, so it
 * is still there a month later. An item with no asset behind it keeps the name
 * it had, and only one that never had a name can come out of this without one -
 * which costs it nothing, because it had no plate to lose.
 */
/**
 * Rename an item, or clear the name to get the original filename back.
 *
 * The fallback order is the point. `meta.origName` is written at import and
 * travels in board.json, so it survives a save and reopen; the asset registry's
 * copy is the older path and only holds for assets registered this session,
 * because the archive carries bytes and hashes but no filenames. Consulting
 * only the registry meant that after a round trip, clearing the name of a
 * renamed item handed back the *renamed* value - the original had nowhere to
 * have been kept.
 */
export function renameItem(id, name) {
  const it = byId(id);
  if (!it) return;
  const next = String(name ?? '').trim() ||
               it.meta?.origName ||
               (it.asset && assetName(it.asset.hash)) || it.name;
  if (it.name === next) return;
  const prev = it.name;
  commit('Rename',
    () => { byId(id).name = next; bus.emit('item', id); },
    () => { byId(id).name = prev; bus.emit('item', id); });
}

/**
 * Give an item a picture of its own, or take it away with a null.
 *
 * A card that is not itself a picture - a sound file, a text file, a named
 * card for something the browser cannot draw - has nothing to look at on a
 * board, and a board is looked at from a distance where a name is not legible.
 * So any of them can carry one: an album cover, a diagram, a frame grabbed by
 * hand. The picture is an ordinary asset, hashed and deduped like every other,
 * which is what makes "the same cover on nine tracks" cost one file.
 *
 * Only the *reference* is undoable. The bytes stay in the registry either way,
 * because undo has to be able to put the picture back and the autosave sweep
 * is what eventually collects anything no item points at.
 */
export function setItemCover(id, hash) {
  const it = byId(id);
  if (!it) return;
  const next = isHash(hash) ? hash : null;
  const prev = isHash(it.meta?.cover) ? it.meta.cover : null;
  if (next === prev) return;
  const write = value => {
    const item = byId(id);
    if (!item) return;
    if (value) item.meta = { ...item.meta, cover: value };
    else { const { cover, ...rest } = item.meta || {}; item.meta = rest; }
    bus.emit('item', id);
  };
  commit(next ? 'Set picture' : 'Remove picture', () => write(next), () => write(prev));
}

/**
 * Attach the hundred-pixel copy the board draws when it is zoomed out.
 *
 * Not undoable, and unlike setItemCover() that is not an oversight. A cover is
 * a choice somebody made about what a card looks like; a thumbnail is a derived
 * copy of the picture the item already holds, and there is no state of the
 * board in which having one is a change worth being able to take back. Made at
 * import (import/drop.js) and repaired by the optimiser (optimize/optimize.js);
 * absent simply means the card draws full size at every zoom.
 *
 * Marks the board dirty, because the id has to be saved - the bytes are pinned
 * by itemHashes() and would otherwise be swept the next time the autosave
 * collected whatever nothing points at.
 */
export function setItemThumb(id, hash) {
  const it = byId(id);
  if (!it || !isHash(hash) || it.meta?.thumb === hash) return;
  it.meta = { ...it.meta, thumb: hash };
  bus.emit('item', id);
  markDirty();
}

/**
 * Point a run of items at smaller copies of their own files, reversibly.
 *
 * One commit for the whole board rather than one per card, because that is what
 * the gesture was: you asked to optimise a board, and one Ctrl+Z has to undo a
 * board. Two hundred separate entries would also be two hundred of the history
 * limit, which is to say the rest of the session's undo thrown away to record a
 * single button press.
 *
 * Each swap is `{ id, asset, cover }` - either field may be absent, and an
 * absent one is left exactly as it was. Items that were *considered* and left
 * alone belong in the list too, with neither field: they still get marked, and
 * marking them is the whole point of listing them.
 *
 * The id that was there goes into `meta.was` / `meta.wasCover`, and that is not
 * bookkeeping for undo's sake: undo closes over the old ids already. It is for
 * the *autosave sweep*, which deletes any bytes no item claims and would
 * otherwise collect the originals the moment the board saved itself - leaving an
 * undo entry that could only put back a hash with nothing behind it. See
 * referencedHashes() in storage/storage.js, and packBoard() in storage/mbrd.js,
 * which drops both fields on the way into a .mbrd so an export carries the small
 * files alone.
 *
 * `meta.opt` is the other half: the ids this item held when the optimiser last
 * looked at it. A second run compares against it and skips what it finds, which
 * is what keeps a re-encode from happening twice - once for the wasted minute,
 * and once because a lossy format encoded from its own output is a second
 * generation of loss for no gain. It is written *inside the commit*, so undoing
 * an optimisation takes the mark back with it and the restored originals are
 * offered again. Hashes rather than a flag, so replacing an item's picture by
 * hand also un-marks it, without anything having to remember to.
 */
export function swapAssets(swaps, label = 'Optimize board') {
  const list = (swaps || []).filter(s => s && byId(s.id));
  if (!list.length) return 0;

  const before = list.map(({ id }) => {
    const it = byId(id);
    return { id, asset: it.asset ? { ...it.asset } : null, meta: { ...it.meta } };
  });

  // A run that found nothing worth rewriting still learned something, and the
  // marks are how it remembers - but they are bookkeeping about work done, not
  // a change to the board, so they go on outside the undo stack. Committing
  // them would put an entry on the history that looks like nothing happened,
  // because nothing did, and spend one of the steps the user has left.
  const swapping = list.some(({ id, asset, cover }) => {
    const it = byId(id);
    return (isHash(asset) && it.asset?.hash && asset !== it.asset.hash) ||
           (isHash(cover) && isHash(it.meta?.cover) && cover !== it.meta.cover);
  });
  if (!swapping) {
    for (const { id } of list) {
      const it = byId(id);
      // No event: nothing about the item is drawn differently for having been
      // looked at, and a rebuild per card would be a flicker for nothing.
      if (it) it.meta = { ...it.meta, opt: [...itemHashes(it)] };
    }
    markDirty();
    return 0;
  }

  const forward = () => {
    for (const { id, asset, cover } of list) {
      const it = byId(id);
      if (!it) continue;
      const meta = { ...it.meta };
      if (isHash(asset) && it.asset?.hash && asset !== it.asset.hash) {
        // Only the first swap records an original. Optimising twice must not
        // leave `was` pointing at the *previous* optimisation, or undoing once
        // would restore a file that is itself already re-encoded.
        if (!isHash(meta.was)) meta.was = it.asset.hash;
        it.asset = { ...it.asset, hash: asset };
      }
      if (isHash(cover) && isHash(meta.cover) && cover !== meta.cover) {
        if (!isHash(meta.wasCover)) meta.wasCover = meta.cover;
        meta.cover = cover;
      }
      it.meta = meta;
      // Marked last, so what is recorded is what the item ended up holding.
      meta.opt = [...itemHashes(it)];
      bus.emit('item', id);
    }
  };

  const back = () => {
    for (const snap of before) {
      const it = byId(snap.id);
      if (!it) continue;
      it.asset = snap.asset ? { ...snap.asset } : null;
      it.meta = { ...snap.meta };
      bus.emit('item', snap.id);
    }
  };

  commit(label, forward, back);
  return list.length;
}

/**
 * Let go of the files the optimiser replaced.
 *
 * Undoable in the sense that matters - the *board* is unchanged either way, so
 * this is not on the history at all. What it changes is what the next autosave
 * sweep is allowed to collect: with `was` gone, nothing claims the originals and
 * the browser gets the space back. It is a one-way door and the caller says so
 * before opening it.
 */
export function discardOriginals() {
  let n = 0;
  for (const it of board.items) {
    if (!isHash(it.meta?.was) && !isHash(it.meta?.wasCover)) continue;
    const { was, wasCover, ...rest } = it.meta;
    it.meta = rest;
    n++;
  }
  if (n) markDirty();
  return n;
}

/** How many items are still holding a pre-optimisation original. */
export const originalsHeld = () =>
  board.items.filter(it => isHash(it.meta?.was) || isHash(it.meta?.wasCover)).length;

/**
 * Which way up a model file is read.
 *
 * 'z' or 'y'. Anything else clears the override and hands the decision back to
 * the format's own default, which is what a board that has never been told
 * carries - see defaultUpAxis() in mesh.js.
 *
 * Its own setter rather than a general "write anything into meta", for the same
 * reason setItemCover has one: `meta` is the open field precisely because
 * nothing polices it, and the two things in there that this app itself reads
 * are better off with a door each than with a hole.
 *
 * Undoable, because it is a visible change to an item and every other visible
 * change to an item is.
 */
export function setItemUpAxis(id, axis) {
  const it = byId(id);
  if (!it) return;
  const next = axis === 'z' || axis === 'y' ? axis : null;
  const prev = it.meta?.upAxis === 'z' || it.meta?.upAxis === 'y' ? it.meta.upAxis : null;
  if (next === prev) return;
  const write = value => {
    const item = byId(id);
    if (!item) return;
    if (value) item.meta = { ...item.meta, upAxis: value };
    else { const { upAxis, ...rest } = item.meta || {}; item.meta = rest; }
    bus.emit('item', id);
  };
  commit('Turn model upright', () => write(next), () => write(prev));
}

/**
 * One image or video's own fit, overriding the board-wide default. 'cover' fills
 * and crops, 'contain' fits the whole picture in; both are explicit, so once set
 * the card no longer follows the board default (that is what an override is for).
 * Undoable and emits 'item', which rebuilds the node so canvas/renderers.js's
 * fitMode() reads the new value - the same shape setItemUpAxis uses.
 */
export function setItemFit(id, fit) {
  const it = byId(id);
  if (!it || (it.type !== 'image' && it.type !== 'video')) return;
  const next = fit === 'cover' || fit === 'contain' ? fit : null;
  const prev = it.meta?.fit === 'cover' || it.meta?.fit === 'contain' ? it.meta.fit : null;
  if (next === prev) return;
  const write = value => {
    const item = byId(id);
    if (!item) return;
    if (value) item.meta = { ...item.meta, fit: value };
    else { const { fit: _drop, ...rest } = item.meta || {}; item.meta = rest; }
    bus.emit('item', id);
  };
  commit('Fit media', () => write(next), () => write(prev));
}

/**
 * The still a model card shows instead of running WebGL, and the angle it was
 * taken from.
 *
 * Deliberately *not* undoable, which is the one decision here worth arguing.
 * Everything else that writes to `meta` is a thing somebody did; this is the
 * app putting the kettle on. Taking a fresh photograph of a model you just
 * turned is not an edit to step back through, and if it were, Ctrl+Z would walk
 * you backwards through a stack of pictures of the same object rather than
 * through the work you were doing.
 *
 * It still marks the board dirty, because the bytes it points at have to be
 * saved or the next open has a card pointing at nothing.
 */
export function setModelShot(id, { hash, ink, view } = {}) {
  const it = byId(id);
  if (!it || it.type !== 'model') return;
  const meta = { ...it.meta };
  if (isHash(hash)) meta.shot = hash; else delete meta.shot;
  // What the model was shaded in when the picture was taken. A model with no
  // colours of its own is drawn in the board's ink, so a change of palette
  // leaves every still a shade out of date - and this is what lets the card
  // notice. Absent means the model brought its own colours and never goes stale.
  if (typeof ink === 'string' && ink) meta.shotInk = ink; else delete meta.shotInk;
  if (view && typeof view === 'object') {
    meta.view = { yaw: +view.yaw || 0, pitch: +view.pitch || 0, zoom: +view.zoom || 1 };
  }
  it.meta = meta;
  markDirty();
  bus.emit('item', id);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function select(ids, additive = false) {
  if (!additive) selection.clear();
  for (const id of ids) selection.add(id);
  bus.emit('selection');
}

export function clearSelection() {
  if (!selection.size) return;
  selection.clear();
  bus.emit('selection');
}

/** Remove one item from the current selection, leaving the rest intact. */
export function deselect(id) {
  if (!selection.delete(id)) return false;
  bus.emit('selection');
  return true;
}

export function selectAll() {
  select(board.items.map(i => i.id));
}

// ---------------------------------------------------------------------------
// Settings + whole-board replacement
// ---------------------------------------------------------------------------

export function setSetting(key, value) {
  // Paper is Desktop-only, and this is where that is actually enforced: the
  // fixup in activateLayoutSettings() runs once, at the moment of the switch,
  // so without this a later write would put a sheet on the Mobile board.
  if (board.layoutMode === 'mobile' &&
      ['paper', 'paperLandscape', 'paperResize', 'spacing'].includes(key)) return;
  if (key === 'mobileColumns') {
    if (board.layoutMode !== 'mobile') return;
    value = mobileColumnCount(value);
  }
  if (key === 'mobileHeader') {
    // Board-level and editable from either layout: the Mobile masthead and the
    // Desktop title card share this one style.
    value = normalizeMobileHeader(value);
    if (JSON.stringify(board.mobileHeader) === JSON.stringify(value)) return;
    board.mobileHeader = value;
    markDirty();
    bus.emit('settings', key);
    return;
  }
  if (key === 'mediaFit') {
    // Board-level, like mobileHeader: one value for both layouts, so it lives on
    // the board rather than in the per-layout settings the rest of this writes.
    const next = normalizeMediaFit(value);
    if (board.mediaFit === next) return;
    board.mediaFit = next;
    markDirty();
    bus.emit('settings', key);
    return;
  }
  if (key === 'paletteSources') {
    // Board-level too, and read by ui/appearance.js's palette extraction.
    const next = normalizePaletteSources(value);
    if (board.paletteSources === next) return;
    board.paletteSources = next;
    markDirty();
    bus.emit('settings', key);
    return;
  }
  if (key === 'fonts') {
    const fonts = normalizeFonts(value);
    board.settings.fonts = fonts;
    board.layoutSettings.desktop.fonts = cloneSettings({ fonts }).fonts;
    board.layoutSettings.mobile.fonts = cloneSettings({ fonts }).fonts;
    markDirty();
    bus.emit('settings', key);
    return;
  }
  if (key === 'appearance') {
    setAppearance(value);
    return;
  }
  if (board.settings[key] === value) return;
  board.settings[key] = value;
  // Snapping is not only a rule for the next drag - it moves the board. Done
  // here rather than at the checkbox because the whimsy axis flips this setting
  // too (Harsh means snapped), and both routes have to behave the same.
  if (key === 'snap') value ? snapAll() : unsnapAll();
  if (key === 'mobileColumns') repackMobileBoard();
  board.layoutSettings[board.layoutMode] = layoutSettingsOf(board.settings);
  markDirty();
  bus.emit('settings', key);
}

/** Replace the shared color/whimsy half and the active layout's local look. */
export function setAppearance(appearance) {
  const { shared, local } = splitAppearance(appearance);
  board.sharedAppearance = cloneSettings({ appearance: shared }).appearance;
  board.settings.appearance = mergeAppearance(board.sharedAppearance, local);
  board.layoutSettings[board.layoutMode] = layoutSettingsOf(board.settings);
  markDirty();
  bus.emit('settings', 'appearance');
}

export function setArrangement(name) {
  if (board.arrangement === name) return;
  board.arrangement = name;
  board.arrangements[board.layoutMode] = name;
  markDirty();
  bus.emit('settings', 'arrangement');
}

export function setTitle(title) {
  board.title = cleanBoardTitle(title) || 'Untitled board';
  bus.emit('board');
}

/**
 * Replace the whole board (open / new). Clears selection and history.
 *
 * Two steps, and the split is the whole of it: normalise() builds a complete
 * replacement board out of the incoming data and cannot throw, then the
 * assignments below swap it in with nothing left that can fail between them.
 *
 * It used to assign field by field straight from `data`, which was fine right
 * up until one of those fields was not the shape it looked like. `board.json`
 * arrives parsed but unvalidated - it is JSON from a file this app did not
 * necessarily write - and `(data.items || []).map(...)` throws on anything that
 * is not an array. By then the title, the view, the settings and the
 * arrangement had already been replaced, so a board that failed to open left
 * the user looking at their own items under someone else's title, with no way
 * back: there is no undo across a load, by design. Half a board is the one
 * outcome an open must not have.
 */
export function loadBoard(data) {
  const layoutMode = board.layoutMode;
  const next = normalizeBoard(data);
  board.title = next.title;
  board.view = next.view;
  board.sharedAppearance = next.sharedAppearance;
  board.layoutSettings = next.layoutSettings;
  board.arrangements = next.arrangements;
  board.layouts = next.layouts;
  board.items = next.items;
  board.mobileHeader = next.mobileHeader;
  board.titleHidden = next.titleHidden;
  board.mediaFit = next.mediaFit;
  board.paletteSources = next.paletteSources;
  board.trash = next.trash;
  board.layoutMode = layoutMode;
  // The Desktop title card is seeded by the app (main.js, on 'board:load'), not
  // here: keeping loadBoard() free of it lets state tests load and serialise a
  // board of exactly the items they gave it. See ensureTitleCard().
  // Before completeLayout(): the Mobile carry below asks stuckTo() where each
  // note belongs, so the memo has to hold *this* board's answers, not the last
  // board's. Seeding also drops the old board's ids, which two files can share.
  seedSticks();
  activateLayoutSettings(layoutMode);
  writeLayout(completeLayout(layoutMode));
  selection.clear();
  clearHistory();
  // The clipboard cannot cross a board. Opening one calls clearAssets(), so a
  // copy taken from the old board would paste an item whose asset hash no
  // longer resolves to any bytes - a card with a hole in it, which is worse
  // than a Ctrl+V that politely does nothing.
  clipboard.items = [];
  clipboard.text = '';
  clipboard.pastes = 0;
  dirty = false;
  // 'board:load' is the "everything was replaced" signal - distinct from
  // 'board', which also fires for a title change or a dirty-flag flip and so
  // must never be treated as a reason to reset the view.
  bus.emit('board:load');
  bus.emit('board');
  // No delta on purpose: a load replaces everything, and there is no add/remove
  // list that captures "the board you had is gone". A payloadless 'items' is the
  // agreed signal for "membership changed, extent unknown - rescan the board",
  // which every delta-aware listener already falls back to.
  bus.emit('items');
  bus.emit('selection');
  bus.emit('trash');
}

/**
 * A whole board, built from whatever arrived, with no way to fail.
 *
 * Every container is checked for the shape it is about to be used as rather
 * than assumed, so a hand-written or truncated board.json degrades to defaults
 * one field at a time instead of throwing half-way through a load.
 */
function normalizeBoard(data) {
  const src = data && typeof data === 'object' ? data : {};
  const rawSettings = src.settings && typeof src.settings === 'object' ? src.settings : {};
  const desktopSettings = normalizeSettings(rawSettings, 'desktop');
  const mobileSettings = normalizeSettings(rawSettings, 'mobile');
  const { shared: sharedAppearance } = splitAppearance(desktopSettings.appearance);
  const items = (Array.isArray(src.items) ? src.items : [])
    .filter(it => it && typeof it === 'object')
    .slice(0, MAX_ITEMS);
  const trash = (Array.isArray(src.trash) ? src.trash : [])
    .filter(t => t && t.item && typeof t.item === 'object')
    .slice(0, TRASH_LIMIT);
  // One id space across the live board and the bin: a restored item must not
  // collide with a live one.
  const ids = new Set();
  const normalizedItems = dedupeIds(items.map(makeItem), ids);
  const rawLayouts = src.layouts && typeof src.layouts === 'object' ? src.layouts : {};
  const desktopRecord = layoutRecord(rawLayouts.desktop);
  const mobileRecord = layoutRecord(rawLayouts.mobile);
  const desktop = normalizeLayout(desktopRecord.items, normalizedItems);
  const mobile = normalizeLayout(mobileRecord.items, normalizedItems);
  const desktopById = layoutMap(desktop);
  const legacyArrangement = typeof src.arrangement === 'string' && src.arrangement
    ? src.arrangement : 'spiral';

  return {
    title: cleanBoardTitle(src.title) || 'Untitled board',
    view: {
      pan: { x: +src.view?.pan?.x || 0, y: +src.view?.pan?.y || 0 },
      zoom: +src.view?.zoom || 1,
    },
    // Board-level now; a file written before it moved here carries the style
    // under settings.mobileHeader, so that is the fallback source.
    mobileHeader: normalizeMobileHeader(src.mobileHeader ?? rawSettings.mobileHeader),
    titleHidden: !!src.titleHidden,
    mediaFit: normalizeMediaFit(src.mediaFit),
    paletteSources: normalizePaletteSources(src.paletteSources),
    sharedAppearance,
    layoutSettings: {
      desktop: desktopRecord.settings
        ? normalizeLayoutSettings(desktopRecord.settings, 'desktop', desktopSettings)
        : layoutSettingsOf(desktopSettings),
      mobile: mobileRecord.settings
        ? normalizeLayoutSettings(mobileRecord.settings, 'mobile', mobileSettings)
        : layoutSettingsOf(mobileSettings),
    },
    arrangements: {
      desktop: desktopRecord.arrangement || legacyArrangement,
      mobile: mobileRecord.arrangement || legacyArrangement,
    },
    layouts: {
      // `items` remains the Desktop-compatible representation. A file written
      // before profiles existed therefore already contains its desktop layout,
      // and an older reader opening a new file still sees the desktop board.
      desktop: normalizedItems.map(it => desktopById.get(it.id) || geometryOf(it)),
      mobile,
    },
    items: normalizedItems,
    trash: dedupeIds(trash.map(t => makeItem(t.item)), ids)
      .map((item, i) => ({ item, at: +trash[i].at || 0 })),
  };
}

function layoutRecord(raw) {
  if (Array.isArray(raw)) return { items: raw, settings: null, arrangement: '' };
  if (!raw || typeof raw !== 'object') return { items: [], settings: null, arrangement: '' };
  return {
    items: Array.isArray(raw.items) ? raw.items : [],
    settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : null,
    arrangement: typeof raw.arrangement === 'string' && raw.arrangement
      ? raw.arrangement : '',
  };
}

function normalizeLayoutSettings(raw, mode, fallback) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const base = settingsFor(layoutSettingsOf(fallback), {});
  const baseLook = base.appearance || {};
  const sourceLook = source.appearance && typeof source.appearance === 'object'
    ? source.appearance : {};
  return layoutSettingsOf(normalizeSettings({
    ...base,
    ...source,
    appearance: {
      ...baseLook,
      ...sourceLook,
      vars: { ...(baseLook.vars || {}), ...(sourceLook.vars || {}) },
    },
  }, mode));
}

function normalizeSettings(raw, mode) {
  const settings = raw && typeof raw === 'object' ? raw : {};
  const appearance = settings.appearance && typeof settings.appearance === 'object'
    ? settings.appearance : {};
  const vars = {
    ...(mode === 'mobile' ? MOBILE_APPEARANCE_VARS : {}),
    ...(appearance.vars && typeof appearance.vars === 'object' ? appearance.vars : {}),
  };
  return {
    ...DEFAULT_SETTINGS,
    snap: mode === 'mobile',
    ...settings,
    mobileColumns: mode === 'mobile'
      ? mobileColumnCount(settings.mobileColumns ?? MOBILE_COLUMNS)
      : DEFAULT_SETTINGS.mobileColumns,
    appearance: {
      ...(appearance.whimsy != null ? { whimsy: appearance.whimsy } : {}),
      palette: typeof appearance.palette === 'string' ? appearance.palette : '',
      vars,
      ...(appearance.auto === false ? { auto: false } : {}),
      ...(appearance.derived === true && Object.keys(vars).length ? { derived: true } : {}),
    },
    // Both names and hashes become declarations or asset paths downstream.
    fonts: normalizeFonts(settings.fonts),
    scale: clampScale(settings.scale),
    units: settings.units === 'imperial' ? 'imperial' : 'metric',
    paper: PAPERS.some(p => p.id === settings.paper) ? settings.paper : '',
    paperLandscape: !!settings.paperLandscape,
    paperResize: !!settings.paperResize,
  };
}

/**
 * The faces a board carries, reduced to the ones it may.
 *
 * `{ hash, family }` and nothing else - the hash names bytes in the asset store
 * and the family becomes a CSS family name, so a bad one of either is a bad
 * declaration or a dangling reference. Filtered entry by entry rather than
 * rejected wholesale, which is how everything else in this function behaves: a
 * board carrying four faces and one broken record should open with four.
 *
 * Capped, because this list is walked by the packer and registered against the
 * document, and neither wants a thousand entries out of a hand-written file.
 */
function normalizeFonts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    if (!isHash(f.hash) || seen.has(f.hash) || !isFamily(f.family)) continue;
    seen.add(f.hash);
    const font = { hash: f.hash, family: f.family };
    const axes = normalizeFontAxes(f.axes);
    if (axes.length) font.axes = axes;
    out.push(font);
    if (out.length >= MAX_FONTS) break;
  }
  return out;
}

/** Variable axes a font record may carry from its OpenType `fvar` table. */
function normalizeFontAxes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const axis of raw) {
    const tag = typeof axis?.tag === 'string' ? axis.tag : '';
    const min = +axis?.min, max = +axis?.max, fallback = +axis?.default;
    if (!/^[A-Za-z0-9 ]{4}$/.test(tag) || seen.has(tag)) continue;
    if (![min, max, fallback].every(Number.isFinite) || !(max > min)) continue;
    seen.add(tag);
    out.push({ tag, min, default: clamp(fallback, min, max), max });
    if (out.length >= MAX_FONT_AXES) break;
  }
  return out;
}

/** The Mobile title style, held to values its controls and CSS can represent. */
/** The board-wide media fit, defaulting to fit (contain) - fill is opt-in. */
function normalizeMediaFit(value) {
  return value === 'cover' ? 'cover' : 'contain';
}

/** How many pictures the palette reads, clamped to [1, 24] (see MAX_SOURCES). */
function normalizePaletteSources(value) {
  const n = Math.round(+value);
  return Number.isFinite(n) ? Math.max(1, Math.min(24, n)) : 12;
}

function normalizeMobileHeader(raw) {
  const header = raw && typeof raw === 'object' ? raw : {};
  const axes = {};
  if (header.axes && typeof header.axes === 'object') {
    for (const [tag, value] of Object.entries(header.axes)) {
      if (!/^[A-Za-z0-9 ]{4}$/.test(tag) || !Number.isFinite(+value)) continue;
      axes[tag] = +value;
      if (Object.keys(axes).length >= MAX_FONT_AXES) break;
    }
  }
  return {
    font: header.font === '' || isFamily(header.font) ? header.font : '',
    size: clamp(+header.size || DEFAULT_MOBILE_HEADER.size, 7, 24),
    // Half height to five times it. The top of that range already fills the
    // band and spills past what its overflow will show, which is a thing
    // somebody may well want on a title page; the floor is a floor because a
    // scaleY heading for 0 erases the name rather than styling it.
    stretch: clamp(+header.stretch || DEFAULT_MOBILE_HEADER.stretch, 50, 500),
    // 100 is `normal` - the face's own line height. See the default above.
    leading: clamp(+header.leading || DEFAULT_MOBILE_HEADER.leading, 60, 250),
    weight: clamp(Math.round(+header.weight || DEFAULT_MOBILE_HEADER.weight), 1, 1000),
    // Signed, so `|| 0` cannot swallow a real value - only 0 itself falls back
    // to 0, which is where it belongs. Half the band either way is enough to sit
    // the name against the top or bottom edge; further only pushes it out under
    // the band's own overflow clip.
    offset: clamp(Number.isFinite(+header.offset) ? +header.offset : 0, -50, 50),
    italic: !!header.italic,
    // Absent means on. Every board written before this setting existed wrapped
    // its name, and !!undefined would quietly turn that off for all of them.
    wrap: header.wrap !== false,
    axes,
  };
}

/** Matches MAX_FONTS in ui/fonts.js - the two are one limit in two layers. */
const MAX_FONTS = 8;
const MAX_FONT_AXES = 16;

/** The serialisable board, exactly as it lands in board.json. */
export function serializeBoard() {
  captureLayout();
  captureLayoutSettings();
  const desktop = completeLayout('desktop');
  const mobile = completeLayout('mobile');
  const desktopSettings = settingsFor(board.layoutSettings.desktop, board.sharedAppearance);
  const desktopById = layoutMap(desktop);
  const itemIn = (item, geometry) => {
    const meta = { ...item.meta };
    if (geometry?.presnap) meta.presnap = { ...geometry.presnap };
    else delete meta.presnap;
    // Stamp the durable stick record. Measured now from live geometry, not read
    // from a stale field, so the file records where the note actually sits; a
    // load seeds the memo back from it. Null is a real answer and is kept.
    if (item.type === 'note') meta.stuckTo = stuckTo(item)?.id ?? null;
    return { ...item, ...(geometry || null), meta };
  };
  return {
    title: board.title,
    view: { pan: { ...board.view.pan }, zoom: board.view.zoom },
    // Board-level: the one style behind the Mobile masthead and the Desktop
    // title card. Also mirrored into settings below (see desktopSettings) so a
    // reader predating the move still finds it.
    mobileHeader: normalizeMobileHeader(board.mobileHeader),
    titleHidden: !!board.titleHidden,
    mediaFit: normalizeMediaFit(board.mediaFit),
    paletteSources: normalizePaletteSources(board.paletteSources),
    // Legacy readers see the Desktop half, matching the Desktop geometry kept in
    // items. New readers use each layout record below.
    settings: { ...desktopSettings, mobileHeader: normalizeMobileHeader(board.mobileHeader) },
    arrangement: board.arrangements.desktop,
    // Desktop stays in the traditional item fields for readers predating
    // profiles. New readers take the active geometry from `layouts`.
    items: board.items.map(item => serializeItem(itemIn(item, desktopById.get(item.id)))),
    layouts: {
      desktop: {
        items: desktop.map(serializeGeometry),
        settings: cloneSettings(board.layoutSettings.desktop),
        arrangement: board.arrangements.desktop,
      },
      mobile: {
        items: mobile.map(serializeGeometry),
        settings: cloneSettings(board.layoutSettings.mobile),
        arrangement: board.arrangements.mobile,
      },
    },
    // The bin travels with the board. Saving is the moment a board becomes a
    // file you might not open again for a month, and a bin that emptied itself
    // at exactly that moment would be a trapdoor rather than a safety net.
    trash: board.trash.map(t => ({ at: t.at, item: serializeItem(t.item) })),
  };
}

const serializeItem = i => ({
  id: i.id, type: i.type,
  x: round(i.x), y: round(i.y), w: round(i.w), h: round(i.h),
  rot: round(i.rot), z: i.z,
  name: i.name, asset: i.asset, meta: i.meta,
});

const serializeGeometry = geometry => ({
  id: geometry.id,
  x: round(geometry.x), y: round(geometry.y),
  w: round(geometry.w), h: round(geometry.h),
  rot: round(geometry.rot), z: geometry.z,
  ...(geometry.presnap ? {
    presnap: {
      x: round(geometry.presnap.x), y: round(geometry.presnap.y),
      w: round(geometry.presnap.w), h: round(geometry.presnap.h),
    },
  } : {}),
});

const round = n => Math.round(n * 100) / 100;
