// The board's shape: what a board is, what an item is, and what the defaults
// are when a file does not say.
//
// The second floor under state.ts (see board-store.ts for the first). state.ts
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
// Everything is re-exported by state.ts under its old name, so no caller knows
// this file exists.
//
// ── The Item type ──
//
// Before these existed, `board.items` inferred as `never[]` from the empty
// literal in the default board, so every property access on an item anywhere in
// the app was a hard error and every module that walks the board was blocked
// behind this one file. Modules were starting to grow private re-declarations
// of an item to get around it - one of them said so in its own header and asked
// to be deleted once this existed. Two or three of those and "what an item is"
// would have had no single answer, which is the thing this module exists to be.
//
// So the shape is stated here first, ahead of the rest of the file. The
// eleven fields are exactly what board-schema.ts's serializeItem writes, which
// is the authoritative list: a field not written to a .mbrd is not part of an
// item, it is something a subsystem hangs off one.
//
// `meta` is deliberately NOT a discriminated union on `type`. It is tempting -
// a note's meta and a sticker's meta share almost nothing - but it would be a
// promise this codebase does not keep: meta is where every subsystem parks what
// it needs (fit, cover, tint, upAxis, rich, presnap…), the reader accepts
// whatever a file carries, and several keys are written for types that are not
// supposed to have them. A union would be checked at the door and wrong
// underneath, which is worse than an honest `unknown` at each key that the
// reader has to narrow. Narrow it where you use it; that is where the knowledge
// actually is.

/** Every type classify() can produce, and the whole of what RENDERERS answers. */
export type ItemType =
  | 'image' | 'video' | 'audio' | 'note' | 'link' | 'text' | 'model'
  | 'title' | 'ghost' | 'swatch' | 'sticker' | 'fence' | 'generic';

/**
 * The bytes an item points at, or null for one that is only geometry and text.
 * `hash` names the content in the asset store; `family` is the format catalogue
 * entry. See the note above normalizeAssets() in board-schema.ts.
 */
export type ItemAsset = { hash: string; family?: string } | null;

/** See the paragraph above: unknown per key on purpose, narrowed at the use. */
export type ItemMeta = Record<string, unknown>;

export type Item = {
  id: string;
  type: ItemType;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  z: number;
  name: string;
  asset: ItemAsset;
  meta: ItemMeta;
};

/** Which of the two geometry profiles is being talked about. */
export type LayoutMode = 'desktop' | 'mobile';

/**
 * One item's place in one layout - see layout.ts, which owns every rule about
 * these. `presnap` is where the item was before the grid took it, kept so
 * turning snapping off puts it back rather than leaving it on the lattice.
 */
export type Geometry = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  z: number;
  presnap?: { x: number, y: number, w: number, h: number };
};

/** A face this board carries, and the axes its `fvar` declares. */
export type FontAxis = { tag: string, min: number, default: number, max: number };
export type FontSpec = { hash: string, family: string, axes?: FontAxis[], variable?: true };

/**
 * The board's own settings, per layout profile.
 *
 * Every field is stated, and the type is closed on purpose - but note what the
 * reader actually enforces: normalizeSettings() in board-schema.ts spreads a
 * file's `settings` over the defaults and then re-validates only the fields
 * that reach a stylesheet, a filename or the geometry (scale, units, paper,
 * fonts, appearance, mobileColumns). The flags are carried as they arrived. So
 * this type describes what the app writes rather than everything a hand-edited
 * file can put there, and a reader of one of the flags should treat it the way
 * the code already does - as a truthiness test rather than as a boolean.
 */
export type BoardSettings = {
  grid: boolean;
  axes: boolean;
  snap: boolean;
  web: boolean;
  hud: boolean;
  gridStyle: string;
  gridStep: number;
  mobileColumns: number;
  spacing: number;
  scale: number;
  units: string;
  paper: string;
  paperLandscape: boolean;
  paperResize: boolean;
  appearance: Look;
  fonts: FontSpec[];
  /** Where a file written before the masthead moved board-level carries it. */
  mobileHeader?: MobileHeader;
};

/** The Mobile masthead's typography. See DEFAULT_MOBILE_HEADER below. */
export type MobileHeader = {
  font: string;
  size: number;
  stretch: number;
  leading: number;
  weight: number;
  offset: number;
  italic: boolean;
  wrap: boolean;
  axes: Record<string, number>;
};

/** How one connection is drawn, when it is drawn as anything but a plain line. */
export type ConnMeta = {
  dir?: string;
  style?: string;
  color?: string;
  weight?: string;
  label?: string;
};

/** A line between two cards: the pair, and optionally how it looks. */
export type Connection = [string, string] | [string, string, ConnMeta];

export type Board = {
  title: string;
  view: { pan: { x: number, y: number }, zoom: number };
  sharedAppearance: Look;
  layoutSettings: Record<LayoutMode, BoardSettings>;
  settings: BoardSettings;
  arrangement: string;
  arrangements: Record<LayoutMode, string>;
  layoutMode: LayoutMode;
  layouts: Record<LayoutMode, Geometry[]>;
  items: Item[];
  mobileHeader: MobileHeader;
  titleHidden: boolean;
  mediaFit: string;
  paletteSources: number;
  connections: Connection[];
  audioOrder: string[];
  trash: TrashEntry[];
};

/**
 * One thing in the bin: the item as it was, and when it went in.
 *
 * Here rather than in ui/trash.ts because the bin is part of the board's shape -
 * it is serialised, it is held to TRASH_LIMIT below, and both the runtime bin
 * and the file reader build these. Two modules were about to spell it out
 * privately, which is the drift the Item note above exists to stop.
 */
export type TrashEntry = { item: Item; at: number };

import { uid, isHash, isRecord } from './util.ts';
import { MIN_SIZE, MAX_SIZE } from './geometry.ts';
import { DEFAULT_SCALE } from './measure.ts';
import { splitAppearance, mergeAppearance } from './layout-settings.ts';
import type { Look } from './layout-settings.ts';
import { bus } from './board-store.ts';

/** The longest a sticky note may be. Enforced at every door onto the board. */
export const NOTE_MAX = 512;

// `size` is the type's size, as a percentage of the strip's own width - see
// #mobile-board-title in canvas.css. `stretch` is a percentage of that size taken
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

export const DEFAULT_SETTINGS: BoardSettings = {
  grid: true,
  axes: true,
  snap: false,
  // Whether the connections between cards are drawn. Desktop-only and
  // layout-local. **On** to begin with, where the automatic web this replaced
  // was off, and the two defaults answer different questions: a web nobody
  // asked for appearing over a board somebody had just made was an imposition,
  // and a line you drew by hand and cannot see is a bug. One checkbox away in
  // View either way.
  //
  // Still called `web`, deliberately. It is the key an older build reads to
  // decide whether to draw anything at all between cards, and renaming it would
  // open every board that had the web switched on with nothing between them.
  // See canvas/web.js, which kept its name for the same reason.
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

export const BOARD_MODES: LayoutMode[] = ['desktop', 'mobile'];
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
export function cleanBoardTitleDraft(value: unknown) {
  const title = typeof value === 'string' ? value : '';
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
export function cleanBoardTitle(value: unknown) {
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
export function isDefaultTitle(title: string) {
  return title === 'Untitled board' || AUTO_TITLE.test(title);
}

export function cloneSettings(settings: BoardSettings): BoardSettings {
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

export function layoutSettingsOf(settings: BoardSettings): BoardSettings {
  const cloned = cloneSettings(settings);
  const { local } = splitAppearance(cloned.appearance);
  cloned.appearance = local;
  return cloned;
}

export function settingsFor(layoutSettings: BoardSettings, sharedAppearance: Look): BoardSettings {
  const cloned = cloneSettings(layoutSettings);
  cloned.appearance = mergeAppearance(sharedAppearance, cloned.appearance);
  return cloned;
}

export function defaultLayoutSettings(mode: LayoutMode): BoardSettings {
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
export function mobileColumnCount(value: unknown = board.settings.mobileColumns) {
  const n = Number(value);
  return MOBILE_COLUMN_OPTIONS.includes(n) ? n : MOBILE_COLUMNS;
}

const initialSharedAppearance = splitAppearance(DEFAULT_SETTINGS.appearance).shared;
const initialLayoutSettings = {
  desktop: defaultLayoutSettings('desktop'),
  mobile: defaultLayoutSettings('mobile'),
};

export const board: Board = {
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
  // Named rather than left to infer. The default board is empty, so an
  // unannotated literal makes `board.items` a never[] - which is not "we do not
  // know yet", it is a positive claim that nothing can be in it, and it lands as
  // an error at every module that walks the board rather than here. The two
  // annotations are erased; see the Item note at the top of this file.
  items: [] as Item[],
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
  // Lines somebody drew between two cards. Pairs of item ids, unordered - a
  // connection has two ends and no direction, which is why there are no
  // arrowheads and why the key below sorts before it compares.
  //
  // Top-level rather than inside a layout, and that is the one structural
  // decision here: a connection is between *items*, items are shared across
  // Desktop and Mobile, and only geometry is per-layout. Filing them under a
  // layout would mean a board connected on the desktop opened unconnected on a
  // phone and then lost the connections the next time it was saved from one.
  connections: [],
  // The order the Playlist plays the board's audio in, as a list of item ids.
  // Top-level for the same reason as connections: it is an ordering of *items*,
  // items are shared across Desktop and Mobile, and a per-layout copy would let a
  // playlist re-sorted on a phone come back scrambled on a laptop. Additive with
  // an empty default, so it costs no .mbrd version bump - a track with no entry
  // sorts by the board's arrangement, and an older reader drops the key on save.
  audioOrder: [],
  // Thrown away but not gone. Entries are { item, at }, newest first.
  trash: [] as TrashEntry[],
};

/**
 * The unordered key for a pair. `a-b` and `b-a` are one connection.
 *
 * A NUL separator, escaped rather than typed: a literal one makes every tool
 * that sniffs for it - ripgrep, git diff, half the editors in existence -
 * decide the file is binary and stop showing it. Same byte, same behaviour, and
 * the file stays readable. uid() cannot produce one, and an id out of somebody
 * else's board.json is held to a string and a length by makeItem(), which is
 * where that guarantee lives rather than here.
 *
 * canvas/web.js kept a private `keyOf` that was this line character for
 * character, with no import, and keyed its whole segment cache on it. Two
 * spellings of one key is a cache that half-misses the day either changes; it
 * imports this now, through state.js.
 */
export const pairKey = (a: string, b: string) => (a < b ? a + '\0' + b : b + '\0' + a);

/**
 * The most connections a board may carry.
 *
 * Lower than MAX_ITEMS on purpose, even though a complete graph over 20,000
 * cards would be two hundred million pairs: this is the number a *file* is
 * allowed to declare, and every entry costs a segment to route and a subpath to
 * draw. Two thousand is far past any board a person draws by hand and past
 * anything the generator makes from a selection, and it is finite, which is the
 * property that matters when the list arrives from outside. See AUD-07.
 */
export const MAX_CONNECTIONS = 2000;

/**
 * A connection's optional third element: how it is drawn.
 *
 * A bare `[a, b]` is the connection it always was - undirected, plain, unlabelled
 * - and stays exactly that on disk. When somebody gives one a direction, a line
 * style or a label, the settings ride in a third slot, `[a, b, {dir, style,
 * label}]`. Additive on purpose: an older reader ignores the extra element, and
 * a connection left at its defaults carries no third element at all, so nothing
 * about the common case changes and no .mbrd version bump is owed.
 *
 * `dir` is read relative to the stored order of the pair: 'fwd' points the arrow
 * at `b`, 'back' at `a`, 'both' at each end. That the pair is otherwise unordered
 * is why the order the file happens to carry is kept rather than sorted here -
 * pairKey() does the sorting it needs for the dedup key without disturbing it.
 *
 * `color` and `weight` are the same bargain again, and they are the reason a
 * board can say that two lines mean different things. Both are **names, never
 * values**: a colour is 'leaf', not a hex triple, and it is resolved to a token
 * by one CSS rule per name in canvas.css. That is not tidiness. This object
 * arrives out of a file somebody else wrote, and a value that reaches a stroke
 * is a value that reaches the CSSOM - the same reason ui/look.js holds its
 * tokens to an alphabet. A closed list cannot carry a url() into a stylesheet.
 */
export const CONN_DIRECTIONS = ['none', 'fwd', 'back', 'both'];
export const CONN_STYLES = ['solid', 'dashed', 'dotted'];
/** 'line' is the board's own grey - the default, and what a plain pair draws. */
export const CONN_COLORS = ['line', 'accent', 'warm', 'leaf', 'danger'];
export const CONN_WEIGHTS = ['fine', 'normal', 'bold'];
export const CONN_LABEL_MAX = 60;
const DIR_SET = new Set(CONN_DIRECTIONS);
const STYLE_SET = new Set(CONN_STYLES);
const COLOR_SET = new Set(CONN_COLORS);
const WEIGHT_SET = new Set(CONN_WEIGHTS);

/**
 * Whether one of the closed lists above holds this value. The typeof is what
 * a Set of strings cannot say about something out of a file, and it changes no
 * answer: a Set of strings never held a number.
 */
const inSet = (set: Set<string>, v: unknown): v is string =>
  typeof v === 'string' && set.has(v);

/** A connection's display settings, kept to the known values, or null if plain. */
export function connMeta(raw: unknown): ConnMeta | null {
  if (!isRecord(raw)) return null;
  const out: ConnMeta = {};
  // Defaults are omitted, not stored: a connection at 'none'/'solid'/no-label is
  // a bare pair, which is what keeps an ordinary board's connections `[a, b]`.
  if (inSet(DIR_SET, raw.dir) && raw.dir !== 'none') out.dir = raw.dir;
  if (inSet(STYLE_SET, raw.style) && raw.style !== 'solid') out.style = raw.style;
  if (inSet(COLOR_SET, raw.color) && raw.color !== 'line') out.color = raw.color;
  if (inSet(WEIGHT_SET, raw.weight) && raw.weight !== 'normal') out.weight = raw.weight;
  if (typeof raw.label === 'string') {
    const label = raw.label.replace(/\s+/g, ' ').trim().slice(0, CONN_LABEL_MAX);
    if (label) out.label = label;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The connections a board may keep, out of whatever arrived.
 *
 * Total, like everything else that reads a file here: a malformed entry is
 * dropped rather than throwing part-way through a load.
 *
 * `live` is the set of ids the pair may name - the board's items *and* the
 * bin's. The bin is what makes that union right rather than generous: a
 * connection to a card that has been thrown away has to survive a save and a
 * reload, or restoring the card would bring back an item with its lines
 * quietly missing. Anything naming neither is pruned, because nothing in the
 * app could ever make it mean something again.
 */
export function normalizeConnections(raw: unknown, live?: Set<string> | null): Connection[] {
  if (!Array.isArray(raw)) return [];
  const out: Connection[] = [];
  const seen = new Set();
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const [a, b] = pair;
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) continue;
    // A card joined to itself is not a connection, it is a dot.
    if (a === b) continue;
    if (live && (!live.has(a) || !live.has(b))) continue;
    const key = pairKey(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    // The third element, when there is one, is validated down to the known
    // values and dropped entirely when it says nothing a default would not.
    const meta = connMeta(pair[2]);
    out.push(meta ? [a, b, meta] : [a, b]);
    if (out.length >= MAX_CONNECTIONS) break;
  }
  return out;
}

/**
 * The Playlist's saved order, out of whatever arrived: a flat list of item ids.
 *
 * Total like the rest of the file readers - a non-string or a duplicate is
 * dropped rather than throwing. Held to `live` (the board's ids and the bin's,
 * same union connections use) so an id for a card that no longer exists cannot
 * pin a gap in the order; the Playlist then intersects this with the audio it
 * actually has and appends anything new in arrangement order, so a list that
 * still names a since-deleted or since-retyped card is self-healing rather than
 * wrong. Not filtered to audio here: this layer does not know an item's type,
 * and applyAudioOrder() does that filtering where it does.
 */
export function normalizeAudioOrder(raw: unknown, live?: Set<string> | null): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set();
  for (const id of raw) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    if (live && !live.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/**
 * The Desktop title card is a singleton, so it carries a fixed id rather than a
 * minted one - its geometry then travels in board.layouts like any item's, and
 * a delete-then-restore lands the same card back rather than a new one.
 */
export const TITLE_ID = '__title__';

/**
 * The two types the app puts on a board itself: the Desktop title card and the
 * onboarding hints. Furniture, not anything of the user's.
 *
 * Named once and imported, because "is this something somebody put here?" is
 * asked from four modules and was spelled out at each of them - which is how the
 * HUD came to count the title card while hasContent() did not, and how a sticky
 * note came to be able to stick to it. A fifth furniture type would otherwise
 * have to find all four sites again.
 *
 * Only for the sites that mean *both*. Places that exclude one on purpose - the
 * Mobile packer, which packs hints and parks the title card; the clipboard,
 * which refuses the title card alone; serializeBoard(), which strips hints alone
 * - are asking a different question and keep their own test.
 */
// `unknown` in rather than a shape, and the same for the two predicates below.
// These three are asked of items, of half-built items on their way in from a
// file, and of the private box-shaped types two command modules still declare
// for themselves - and a parameter naming any one of those shapes refuses the
// others. The isRecord() guard is what `it?.type` was already doing for every
// argument any caller passes; it differs only for a non-object, which none does.
export const isFurniture = (it: unknown) =>
  isRecord(it) && (it.type === 'title' || it.type === 'ghost');

/**
 * Something the user put on this board *as content*, which is a narrower
 * question than isFurniture()'s and needs its own name.
 *
 * A fence is not furniture - nobody but the user ever makes one - and it is not
 * content either. It is a line drawn around content, so counting it answers "how
 * much have I put here" with a number that includes the boxes; and a board
 * holding nothing but fences is a board holding nothing, which is exactly the
 * board that should still be showing its hints.
 *
 * Named here beside isFurniture() and for the same stated reason: that one
 * exists because "is this something somebody put here?" was spelled out at four
 * sites and drifted, which is how the HUD came to count the title card while
 * hasContent() did not. This is the second half of that question, so it gets the
 * same treatment before it has a chance to drift too.
 */
export const isContent = (it: unknown) =>
  isRecord(it) && !isFurniture(it) && it.type !== 'fence';

/**
 * May a connection have this item as an end - and, the same list for the same
 * reason, does the router have to route around it?
 *
 * Two exclusions and they are unrelated. A hint card relates to nothing: it is
 * talking to the person rather than to the board, and serializeBoard() strips
 * it, so a line drawn to one could not survive a save even if it could be
 * drawn. A sticker is the other end of the same idea - it is a *remark about*
 * the card underneath it, and a line from a star to a photograph is a line from
 * a thing to what it already says. It is not an obstacle either: decoration
 * lying on a picture should not push a route around itself.
 *
 * Note what this is deliberately *not*: isContent(). That one refuses the title
 * card and fences, which are both perfectly good things for a line to reach and
 * to bend around, and the two questions only look alike. They were nearly one
 * predicate, and the loose sticker is the case that would have gone wrong -
 * a loose sticker is a member of the fence it is standing in, so a shared test
 * would have taken it out of the fence to keep it out of the web.
 */
export const isJoinEnd = (it: unknown) =>
  isRecord(it) && it.type !== 'ghost' && it.type !== 'sticker';


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
let itemIndex: Map<string, Item> | null = null;

export function byId(id: string): Item | undefined {
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

/**
 * Drop the index without announcing anything.
 *
 * The lazy rebuild above is keyed to the *announcement*, which is right for every
 * ordinary mutation: the array is edited in place and the emit follows in the
 * same tick, so nothing reads between the two. loadBoard() is the exception. It
 * replaces board.items outright and then runs a whole layout pass - place the
 * arriving items, restick every note to its host, complete the other profile -
 * before it emits, and every byId() in that pass would otherwise be answered
 * from the *previous* board. On matching ids that is silent (a note stuck to the
 * old board's card, laid out against the old card's geometry); on ids the new
 * board does not carry it is a TypeError inside the load, which leaves the board
 * half-swapped.
 *
 * So this exists to be called in the same breath as the assignment, and nothing
 * may sit between them. A null check at the reading end would have papered over
 * the throwing half and left the silent half exactly as it was.
 */
export function dropIdIndex() { itemIndex = null; }

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
function coord(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, -COORD_MAX), COORD_MAX) : 0;
}

/** A positive size within the item bounds, or `fallback`. Rejects <=0 and Infinity. */
function size(v: unknown, fallback: number) {
  const n = Number(v);
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
 * How many things the bin holds before the oldest start falling out the
 * bottom. A bin is a safety net, not an archive - and every entry pins its
 * asset's bytes into the saved file, so an unbounded one would quietly make a
 * board grow forever as you worked on it.
 *
 * Here rather than beside the bin's own mutations, because it is read from two
 * directions that must not import each other: the runtime bin truncates to it
 * on every delete, and the file reader slices an arriving `trash` array to it
 * before anything else looks at the entries. Both are rules about the shape a
 * board may have, which is what this module is.
 */
export const TRASH_LIMIT = 60;

/**
 * Force item ids unique, regenerating collisions deterministically.
 *
 * A duplicate id conflicts with the renderer's module-level Map, selection,
 * byId()'s first-match, and DOM identity - two cards that are meant to be
 * distinct become one. Regenerated by suffix rather than uid() so a given file
 * always loads the same way. `seen` is shared across the live items and the bin
 * so a restored item can never land on a live id.
 */
export function dedupeIds(list: Item[], seen: Set<string>): Item[] {
  for (const it of list) {
    if (!seen.has(it.id)) { seen.add(it.id); continue; }
    // Room reserved for the suffix, rather than truncating after it is added.
    // The cap is what made this loop non-terminating: an id already 64 characters
    // long, truncated back to 64 characters, is the same string every time round,
    // so `seen` rejected every candidate and the load hung the tab. Ids are
    // capped at 64 by makeItem() and research/docs/mbrd-format.md declares 64 legal, so a
    // file can reach here with two of them. 58 + '~' + five digits stays inside
    // the cap for every k the loop can reach.
    const stem = it.id.slice(0, 58);
    let k = 2, next;
    do { next = stem + '~' + k++; } while (seen.has(next) && k < 1e5);
    // An adversarial file could still fill that space. Determinism is the point
    // of the suffix and it is worth giving up only here, at the end of a range no
    // real board reaches, rather than spinning.
    if (seen.has(next)) next = uid();
    it.id = next;
    seen.add(next);
  }
  return list;
}

export function makeItem(partial: Record<string, unknown>): Item {
  let meta: ItemMeta = isRecord(partial.meta) ? partial.meta : {};
  // The one funnel every item passes through on its way onto the board, which
  // makes it the place to hold a note to its ceiling. The editor enforces the
  // same limit while you type; this catches the other doors - an older .mbrd,
  // and a notes/*.md someone edited by hand outside the app.
  if ((partial.type || 'generic') === 'note' && typeof meta.text === 'string' && meta.text.length > NOTE_MAX) {
    meta = { ...meta, text: meta.text.slice(0, NOTE_MAX) };
  }
  return {
    id: typeof partial.id === 'string' && partial.id ? partial.id.slice(0, 64) : uid(),
    // Cast, and the one place in this file where the type is wider than what is
    // checked: a file may name a type this build has never heard of, and the
    // name is carried rather than rewritten - classify() and RENDERERS fall back
    // to the generic card at the draw, so the board opens and a save gives the
    // file its own word back. ItemType is therefore what the *app* produces, not
    // an assertion about every string a document can hold.
    type: (typeof partial.type === 'string' && partial.type ? partial.type : 'generic') as ItemType,
    x: coord(partial.x),
    y: coord(partial.y),
    w: size(partial.w, 240),
    h: size(partial.h, 180),
    rot: Number.isFinite(Number(partial.rot)) ? Number(partial.rot) : 0,
    z: partial.z != null && Number.isFinite(Number(partial.z)) ? Number(partial.z) : topZ() + 1,
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
const META_HASHES = ['cover', 'shot', 'thumb', 'preview'];

function normalizeMeta(meta: ItemMeta): ItemMeta {
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
 *
 * Two casts, and they say the same thing twice: ItemAsset above describes the
 * embedded form - `{ hash, family }` - and the reserved external form is not in
 * it. Widening the type would put `hash` in doubt at every one of the several
 * dozen `item.asset?.hash` reads in the app, over a form nothing in it reads
 * yet, so the narrower type stays and the two returns below say what they are.
 * tests/state-clipboard.test.js pins the carry-through; when something starts
 * *reading* the external form, that is the moment ItemAsset should grow a
 * second member and these should go.
 */
function normalizeAsset(asset: unknown): ItemAsset {
  if (!isRecord(asset)) return null;
  // The whole object, not a rebuilt one: `family` and anything else a newer
  // build wrote alongside the hash travels with it.
  if (isHash(asset.hash)) return asset as ItemAsset;
  return asset.external ? { external: asset.external } as unknown as ItemAsset : null;
}
