// Board shape: types, defaults, and the id index. Data and validation only -
// no mutations, no bus.emit() beyond the index invalidator.
// Re-exported by state.ts; callers import from there.
//
// `meta` is Record<string, unknown> on purpose - narrow at the use site.

// `gone` = tombstone after bin purge (see trash.ts).
export type ItemType =
  | 'image' | 'video' | 'audio' | 'note' | 'link' | 'text' | 'model'
  | 'title' | 'ghost' | 'swatch' | 'sticker' | 'fence' | 'style-tile'
  | 'font' | 'gone' | 'archive' | 'folder' | 'generic';

// Second arm is the reserved link-instead-of-embed form (no local bytes).
export type ItemAsset =
  | { hash: string; family?: string }
  | { hash?: undefined; external: unknown }
  | null;

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

export type LayoutMode = 'desktop' | 'mobile';

// `presnap` = position before grid snapping, for restoring on snap-off.
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

export type FontAxis = { tag: string, min: number, default: number, max: number };
export type FontSpec = { hash: string, family: string, axes?: FontAxis[], variable?: true };

// Closed type describing what the app writes; flags are truthiness-tested.
export type BoardSettings = {
  grid: boolean;
  axes: boolean;
  snap: boolean;
  web: boolean;
  hud: boolean;
  tilt: boolean;
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
  mobileHeader?: MobileHeader;
};

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

export type ConnMeta = {
  dir?: ConnDir;
  style?: ConnStyle;
  color?: ConnColor;
  weight?: ConnWeight;
  label?: string;
};

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
  tour: TourStop[];
  trash: TrashEntry[];
  /** Music has been on this board at some point. Never cleared: it is what
   *  shows the sidebar's Playlist button. See ui/playlist.ts. */
  hadMusic: boolean;
  /** Top-level board.json keys this build does not know, carried untouched
   *  so a newer build's fields survive this one's save. Never read here. */
  extra: Record<string, unknown>;
};

// Stored versions (v0.197) were replaced by the timeline. Old files that
// carry the key are silently dropped on load.

export type TrashEntry = { item: Item; at: number };

import { uid, isHash, isRecord, baseName } from './util.ts';
import { MIN_SIZE, MAX_SIZE } from './geometry.ts';
import { DEFAULT_SCALE } from './measure.ts';
import { splitAppearance, mergeAppearance } from './layout-settings.ts';
import type { Look } from './layout-settings.ts';
import { bus, tagFilter } from './board-store.ts';

export const NOTE_MAX = 512;

// `size` as % of strip width, `stretch` as vertical scale (100=normal),
// `leading` as line-height (100=normal, else multiplier e.g. 140=1.4).
export const DEFAULT_MOBILE_HEADER = Object.freeze({
  font: '',
  size: 13,
  stretch: 100,
  leading: 100,
  weight: 700,
  offset: 0, // % of band height; 0 = centred
  italic: false,
  // A new board's name stays on one line. board-schema.ts reads a header
  // written before this setting existed as wrapped, as it was drawn.
  wrap: false,
  axes: Object.freeze({}),
});

export const DEFAULT_SETTINGS: BoardSettings = {
  grid: true,
  axes: true,
  snap: false,
  // Named `web` for backward compat with older builds.
  web: true,
  hud: false,
  // Cards rest at the tier's lean. False stands them square (Look, Tilt cards).
  tilt: true,
  gridStyle: 'dots',
  gridStep: 64,
  mobileColumns: 6, // desktop compat value; mobile overrides to 8
  spacing: 12,
  scale: DEFAULT_SCALE,
  units: 'metric',
  paper: '',
  paperLandscape: false,
  paperResize: false,
  appearance: { palette: '', vars: {} },
  fonts: [],
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

// Keeps one trailing space so typing a second word works.
export function cleanBoardTitleDraft(value: unknown) {
  const title = typeof value === 'string' ? value : '';
  return title
    .replace(/\s+/g, ' ')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trimStart()
    .slice(0, BOARD_TITLE_MAX);
}

// Portable filename: strips Windows-forbidden chars and device names.
export function cleanBoardTitle(value: unknown) {
  let title = cleanBoardTitleDraft(value)
    .trim()
    .replace(/[. ]+$/g, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) {
    title = ('_' + title).slice(0, BOARD_TITLE_MAX);
  }
  return title;
}

// Fixed month names so the title is locale-independent and testable.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function defaultBoardTitle(now = new Date()) {
  return `New board ${MONTHS[now.getMonth()]} ${now.getDate()}`;
}

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

// Mutable singleton. Mutating outside the commit path is a bug;
// layers.test.js bounds which modules can reach it.
export const board: Board = {
  title: defaultBoardTitle(),
  view: { pan: { x: 0, y: 0 }, zoom: 1 },
  sharedAppearance: initialSharedAppearance,
  layoutSettings: initialLayoutSettings,
  settings: settingsFor(initialLayoutSettings.desktop, initialSharedAppearance),
  arrangement: 'spiral',
  arrangements: { desktop: 'spiral', mobile: 'spiral' },
  // Local UI state, not saved to board.json.
  layoutMode: 'desktop',
  layouts: { desktop: [], mobile: [] },
  // SAFETY: assertion prevents never[] inference from the empty literal.
  items: [] as Item[],
  mobileHeader: DEFAULT_MOBILE_HEADER,
  titleHidden: false,
  mediaFit: 'contain',
  paletteSources: 12,
  connections: [],
  audioOrder: [],
  // SAFETY: assertion prevents never[] inference.
  tour: [] as TourStop[],
  // SAFETY: assertion prevents never[] inference.
  trash: [] as TrashEntry[],
  hadMusic: false,
  // SAFETY: an empty object is a valid Record<string, unknown>; the assertion only stops {} being inferred.
  extra: {} as Record<string, unknown>,
};

// NUL-separated, sorted so a-b and b-a are one key.
export const pairKey = (a: string, b: string) => (a < b ? a + '\0' + b : b + '\0' + a);

export const MAX_CONNECTIONS = 2000;

// `dir` is relative to pair order: 'fwd' = arrow at b, 'back' = at a.
// Colors/weights are names, not values - resolved to CSS tokens in canvas.css.
export const CONN_DIRECTIONS = ['none', 'fwd', 'back', 'both'] as const;
export const CONN_STYLES = ['solid', 'dashed', 'dotted'] as const;
const CONN_COLORS = ['line', 'accent', 'warm', 'leaf', 'danger'] as const;
const CONN_WEIGHTS = ['fine', 'normal', 'bold'] as const;

export type ConnDir = typeof CONN_DIRECTIONS[number];
export type ConnStyle = typeof CONN_STYLES[number];
export type ConnColor = typeof CONN_COLORS[number];
export type ConnWeight = typeof CONN_WEIGHTS[number];

const CONN_LABEL_MAX = 60;
const DIR_SET: ReadonlySet<ConnDir> = new Set(CONN_DIRECTIONS);
const STYLE_SET: ReadonlySet<ConnStyle> = new Set(CONN_STYLES);
const COLOR_SET: ReadonlySet<ConnColor> = new Set(CONN_COLORS);
const WEIGHT_SET: ReadonlySet<ConnWeight> = new Set(CONN_WEIGHTS);

// SAFETY: widens the set to accept unknown, not the value.
const inSet = <T extends string>(set: ReadonlySet<T>, v: unknown): v is T =>
  typeof v === 'string' && (set as ReadonlySet<string>).has(v);

export function connMeta(raw: unknown): ConnMeta | null {
  if (!isRecord(raw)) return null;
  const out: ConnMeta = {};
  // Defaults omitted so ordinary connections stay as bare [a, b] pairs.
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

// `live` includes the bin so connections to trashed items survive restore.
export function normalizeConnections(raw: unknown, live?: Set<string> | null): Connection[] {
  if (!Array.isArray(raw)) return [];
  const out: Connection[] = [];
  const seen = new Set();
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const [a, b] = pair;
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) continue;
    if (a === b) continue;
    if (live && (!live.has(a) || !live.has(b))) continue;
    const key = pairKey(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = connMeta(pair[2]);
    out.push(meta ? [a, b, meta] : [a, b]);
    if (out.length >= MAX_CONNECTIONS) break;
  }
  return out;
}

export const normalizeAudioOrder = normalizeIdList;

// `caption` absent rather than empty when unset.
export type TourStop = { cards: string[], caption?: string };

export const MAX_TOUR_CAPTION = 140;

// Accepts three shapes: flat strings, nested arrays, or {cards, caption} objects.
// Deduped across the whole tour.
export function normalizeTour(raw: unknown, live?: Set<string> | null): TourStop[] {
  if (!Array.isArray(raw)) return [];
  const out: TourStop[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const stop = normalizeTourStop(entry, live, seen);
    if (stop) out.push(stop);
    if (seen.size >= MAX_ITEMS) break;
  }
  return out;
}

function normalizeTourStop(entry: unknown, live: Set<string> | null | undefined,
  seen: Set<string>): TourStop | null {
  const raw = typeof entry === 'string' ? [entry]
    : Array.isArray(entry) ? entry
    : isRecord(entry) ? entry.cards
    : null;
  if (!Array.isArray(raw)) return null;
  const cards: string[] = [];
  for (const id of raw) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    if (live && !live.has(id)) continue;
    seen.add(id);
    cards.push(id);
    if (seen.size >= MAX_ITEMS) break;
  }
  if (!cards.length) return null;
  const caption = isRecord(entry) && typeof entry.caption === 'string'
    ? entry.caption.replace(/\s+/g, ' ').trim().slice(0, MAX_TOUR_CAPTION)
    : '';
  return caption ? { cards, caption } : { cards };
}

function normalizeIdList(raw: unknown, live?: Set<string> | null): string[] {
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

export const TITLE_ID = '__title__';

// Title card and onboarding hints. Takes `unknown` so half-built items work too.
export const isFurniture = (it: unknown) =>
  isRecord(it) && (it.type === 'title' || it.type === 'ghost');

// Not furniture and not a fence.
export const isContent = (it: unknown) =>
  isRecord(it) && !isFurniture(it) && it.type !== 'fence';

// Excludes ghosts (stripped on save) and stickers (decoration, not obstacles).
export const isJoinEnd = (it: unknown) =>
  isRecord(it) && it.type !== 'ghost' && it.type !== 'sticker';

// Returns '' when untitled - callers supply their own placeholder.
export function trackTitle(it: unknown): string {
  if (!isRecord(it)) return '';
  const tagged = it.meta && isRecord(it.meta) ? it.meta.trackTitle : null;
  if (typeof tagged === 'string' && tagged) return tagged;
  const name = typeof it.name === 'string' ? it.name : '';
  return baseName(name) || name;
}

// Geometry only: locked items still accept rename, delete, connect, etc.
// A press on a locked card pans the board instead of moving it.
export const isLocked = (it: unknown) => isRecord(it) && !!it.meta
  && isRecord(it.meta) && !!it.meta.locked;

// Fractions of source (0..1), not pixels - survives re-encode.
// Null for full-frame or degenerate rectangles.
export function itemCrop(it: unknown): { x: number, y: number, w: number, h: number } | null {
  if (!isRecord(it) || !isRecord(it.meta)) return null;
  const raw = it.meta.crop;
  if (!isRecord(raw)) return null;
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
  let x = num(raw.x), y = num(raw.y), w = num(raw.w), h = num(raw.h);
  if (!(x >= 0) || !(y >= 0) || !(w > 0) || !(h > 0)) return null;
  x = Math.min(x, 1); y = Math.min(y, 1);
  w = Math.min(w, 1 - x); h = Math.min(h, 1 - y);
  if (w < MIN_CROP || h < MIN_CROP) return null;
  if (x <= 0 && y <= 0 && w >= 1 && h >= 1) return null;
  return { x, y, w, h };
}

export const MIN_CROP = 0.02;

// Multipliers around 1 (0..2), applied as CSS filter. Null when all neutral.
export function itemAdjust(it: unknown): { brightness: number, contrast: number, saturation: number } | null {
  if (!isRecord(it) || !isRecord(it.meta)) return null;
  const raw = it.meta.adjust;
  if (!isRecord(raw)) return null;
  const one = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(2, Math.max(0, n)) : 1;
  };
  const out = {
    brightness: one(raw.brightness),
    contrast: one(raw.contrast),
    saturation: one(raw.saturation),
  };
  if (out.brightness === 1 && out.contrast === 1 && out.saturation === 1) return null;
  return out;
}

// Shared by canvas/item-dom.ts and ui/snapshot.ts.
export function adjustFilter(it: unknown): string | null {
  const a = itemAdjust(it);
  return a
    ? `brightness(${a.brightness}) contrast(${a.contrast}) saturate(${a.saturation})`
    : null;
}

// Two independent booleans. CSS transform, not baked into the display copy.
// Null when neither axis is on.
export function itemFlip(it: unknown): { x: boolean, y: boolean } | null {
  if (!isRecord(it) || !isRecord(it.meta)) return null;
  const raw = it.meta.flip;
  if (!isRecord(raw)) return null;
  const out = { x: !!raw.x, y: !!raw.y };
  return out.x || out.y ? out : null;
}

export function flipTransform(it: unknown): string | null {
  const f = itemFlip(it);
  return f ? `scale(${f.x ? -1 : 1}, ${f.y ? -1 : 1})` : null;
}

// Baked into display copy (unlike flip) because a quarter turn swaps the box.
// Applied after crop, before mirror. Rounded to nearest 90.
export function itemRotate(it: unknown): 90 | 180 | 270 | null {
  if (!isRecord(it) || !isRecord(it.meta)) return null;
  const n = Number(it.meta.rotate);
  if (!Number.isFinite(n)) return null;
  // Double modulo because JS % can return negative.
  const q = ((Math.round(n / 90) * 90) % 360 + 360) % 360;
  return q === 90 || q === 180 || q === 270 ? q : null;
}

// Baked into the display copy (no CSS equivalent).
export function itemMatte(it: unknown): boolean {
  if (!isRecord(it) || !isRecord(it.meta)) return false;
  return !!it.meta.matte;
}

// Card paint hidden, hit-test box stays. See items.css.
export function itemBare(it: unknown): boolean {
  if (!isRecord(it) || !isRecord(it.meta)) return false;
  return !!it.meta.bare;
}

// A sticky drawn at half strength, paper and words together. See cards.css.
export function itemFaded(it: unknown): boolean {
  if (!isRecord(it) || !isRecord(it.meta)) return false;
  return !!it.meta.faded;
}

export const TAG_MAX = 24;
export const TAGS_PER_ITEM = 12;

// Allow-list: letters, digits, marks, space/underscore/hyphen. Lowercased.
export function cleanTag(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[^\p{L}\p{N}\p{M} _-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, TAG_MAX);
}

// Sorted and deduped after cleaning.
export function itemTags(it: unknown): string[] {
  if (!isRecord(it) || !isRecord(it.meta)) return [];
  const raw = it.meta.tags;
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const t of raw) {
    const tag = cleanTag(t);
    if (tag) out.add(tag);
    if (out.size >= TAGS_PER_ITEM) break;
  }
  return [...out].sort();
}

// Matches ANY of the filtered tags. Furniture never dimmed.
export const isFiltered = (it: unknown) => {
  if (!tagFilter.size || isFurniture(it)) return false;
  return !itemTags(it).some(t => tagFilter.has(t));
};

export function boardTags(): { tag: string, count: number }[] {
  const counts = new Map<string, number>();
  for (const it of board.items) {
    if (!isContent(it)) continue;
    for (const tag of itemTags(it)) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts].map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// Lazy index, dropped on 'items' event and rebuilt on next read.
// Stays valid across drags (geom events do not change membership).
let itemIndex: Map<string, Item> | null = null;

export function byId(id: string): Item | undefined {
  if (!itemIndex) {
    itemIndex = new Map();
    for (const item of board.items) itemIndex.set(item.id, item);
  }
  return itemIndex.get(id);
}

bus.on('items', () => { itemIndex = null; });

// Called by loadBoard() right after replacing board.items, before the layout pass.
export function dropIdIndex() { itemIndex = null; }

export function topZ() {
  return board.items.reduce((m, i) => Math.max(m, i.z || 0), 0);
}

// Total: coerces every field, cannot throw. Used by the file reader.
const COORD_MAX = 1e7;

function coord(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, -COORD_MAX), COORD_MAX) : 0;
}

function size(v: unknown, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, MIN_SIZE), MAX_SIZE) : fallback;
}

export const MAX_ITEMS = 20000;

// Shared by the runtime bin and the file reader.
export const TRASH_LIMIT = 60;

// Deterministic suffix so a given file always loads the same way.
export function dedupeIds(list: Item[], seen: Set<string>): Item[] {
  for (const it of list) {
    if (!seen.has(it.id)) { seen.add(it.id); continue; }
    // 58 + '~' + digits stays within the 64-char id cap.
    const stem = it.id.slice(0, 58);
    let k = 2, next;
    do { next = stem + '~' + k++; } while (seen.has(next) && k < 1e5);
    if (seen.has(next)) next = uid();
    it.id = next;
    seen.add(next);
  }
  return list;
}

export function makeItem(partial: Record<string, unknown>): Item {
  let meta: ItemMeta = isRecord(partial.meta) ? partial.meta : {};
  if ((partial.type || 'generic') === 'note' && typeof meta.text === 'string' && meta.text.length > NOTE_MAX) {
    meta = { ...meta, text: meta.text.slice(0, NOTE_MAX) };
  }
  return {
    id: typeof partial.id === 'string' && partial.id ? partial.id.slice(0, 64) : uid(),
    // SAFETY: unknown types carried through; RENDERERS falls back to generic.
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

// Must match itemHashes() in util.ts.
// `archive` is the file a folder card points into (import/unpack.ts).
const META_HASHES = ['cover', 'shot', 'thumb', 'preview', 'poster', 'archive'];

// For PDFs, RAWs, PSDs, etc. the displayed picture is meta.preview, not asset.hash.
export function shownHash(item: Item): string | null {
  const preview = item.meta?.preview;
  if (typeof preview === 'string' && preview) return preview;
  return item.asset?.hash || null;
}

function normalizeMeta(meta: ItemMeta): ItemMeta {
  let out = meta;
  for (const key of META_HASHES) {
    if (!(key in out) || isHash(out[key])) continue;
    const { [key]: _drop, ...rest } = out;
    out = rest;
  }
  // A dropped folder's files, each a path and a content id. An entry missing
  // either is dropped rather than repaired: its path becomes a card's name and
  // its id an archive path, and there is nothing to repair either from.
  if ('files' in out) {
    const files = Array.isArray(out.files) ? out.files : [];
    out = { ...out, files: files.filter(f => isRecord(f) && typeof f.path === 'string' && isHash(f.hash)) };
  }
  return out;
}

function normalizeAsset(asset: unknown): ItemAsset {
  if (!isRecord(asset)) return null;
  if (isHash(asset.hash)) {
    // SAFETY: isHash() validates the one required field of the embedded arm.
    return asset as ItemAsset;
  }
  return asset.external ? { external: asset.external } : null;
}
