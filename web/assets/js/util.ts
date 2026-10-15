// Small shared helpers: here if most of the graph wants it and it is short.
// Dependency-free except errors.ts (for emitter's catch). Document access
// (el, readToken) happens inside the call, not at import time, so everything
// that imports this stays loadable outside a browser.

import { reportCaught } from './errors.ts';

export const clamp = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v;

/**
 * Positive remainder. Keeps tiled background offsets inside 32-bit LayoutUnit
 * range. Branched (not the one-liner) to avoid floating-point drift on in-range values.
 */
export function wrap(n: number, tile: number) {
  const r = n % tile;
  // -0 from `%` on negative whole multiples — normalize to 0.
  if (r === 0) return 0;
  if (r > 0) return r;
  // A small negative remainder + tile can round to exactly `tile`.
  const up = r + tile;
  return up < tile ? up : 0;
}

/**
 * The Escape presses that closed something. Every Escape handler marks the
 * event when it closes a layer, and Android's Back (main.ts) sends an Escape
 * and reads the mark. Not preventDefault(): timeline-view.ts and canvas/input.ts
 * stand down on a prevented Escape, so that signal would change the keyboard.
 */
const closedBy = new WeakSet<Event>();
export const markClosed = (e: Event) => { closedBy.add(e); };
export const wasClosed = (e: Event) => closedBy.has(e);

/** The element with this id, or null. Every module wants this and no other. */
export const el = (id: string) => document.getElementById(id);

/** Create an element, optionally with a class. */
export function makeEl<K extends keyof HTMLElementTagNameMap>(
  tag: K, className = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** A `<div>` with a class - the commonest makeEl(), spelled once for its callers. */
export const div = (className = '') => makeEl('div', className);

/**
 * Put a string on the clipboard, answering whether it landed. Never throws.
 *
 * navigator.clipboard is gated on a secure context, so on a phone reaching the
 * dev server at http://192.168.x.x the whole namespace is undefined. There the
 * deprecated execCommand('copy') still works, and it runs synchronously, while
 * the press that asked is still the transient activation it needs. Where the
 * API exists it is used alone: falling back after its rejection would come
 * too late for execCommand anyway. The fallback hands focus and the selection
 * back, so copying from an editor does not leave its caret behind.
 */
export function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => false);
    }
  } catch { /* fall through to the old way */ }
  const focused = document.activeElement;
  const sel = getSelection();
  const ranges = sel ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i)) : [];
  const box = document.createElement('textarea');
  let ok = false;
  try {
    box.value = text;
    // Off-screen but focusable, and readOnly so a phone does not open its
    // keyboard on the way past.
    box.readOnly = true;
    box.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
    document.body.append(box);
    box.select();
    box.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch { /* deprecated, and one day gone */ }
  // Removed in a finally: an engine that has dropped execCommand throws, and
  // would otherwise leave one orphan <textarea> per press.
  finally {
    box.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    if (sel && ranges.length) { sel.removeAllRanges(); for (const r of ranges) sel.addRange(r); }
  }
  return Promise.resolve(ok);
}

/** Give a non-button element role, tabIndex, and click/Enter/Space handling. */
export function actAsButton(node: HTMLElement, onActivate: () => void, role = 'button') {
  node.setAttribute('role', role);
  node.tabIndex = 0;
  node.addEventListener('click', onActivate);
  node.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); }
  });
}

/** Set contentEditable, preferring plaintext-only with fallback to true. */
export function makeEditable(node: HTMLElement) {
  try { node.contentEditable = 'plaintext-only'; }
  catch { node.contentEditable = 'true'; }
  if (!node.isContentEditable) node.contentEditable = 'true';
}

/** Select the entire contents of a node so the first keystroke replaces them. */
export function selectContents(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The same, then collapsed to the end: a caret after the last character. */
export function caretToEnd(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const sel = getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Read a CSS custom property from :root, trimmed. Not cached — tokens change
 * under the whimsy dial and palette. Not free (style flush) — do not call per frame.
 */
export const readToken = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Any CSS colour as `#rrggbb`, or null. Here rather than in ui/ because the
 * style tile's swatches (canvas/items.ts) copy a token's hex, and so does the
 * Pigment picker.
 */
export function toHex(value: string): string | null {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + [...v.slice(1)].map(c => c + c).join('').toLowerCase();
  // Percentages would NaN under .map(Number) — fall through to canvas instead.
  const m = v.match(/^rgba?\(([^)]+)\)$/i);
  if (m && !m[1].includes('%')) {
    const [r, g, b] = m[1].split(/[\s,/]+/).map(Number);
    if ([r, g, b].every(Number.isFinite)) {
      return '#' + [r, g, b].map(n => clamp(Math.round(n || 0), 0, 255).toString(16).padStart(2, '0')).join('');
    }
  }
  // Everything else: round-trip through a canvas.
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#000';
    ctx.fillStyle = v;
    const out = ctx.fillStyle;
    return typeof out === 'string' && /^#[0-9a-f]{6}$/i.test(out) ? out.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Fisher-Yates in place. `rnd` accepts a seeded generator for reproducible shuffles. */
export function shuffle<T>(arr: T[], rnd: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

let _seq = 0;
export function uid(prefix = 'i') {
  // Monotonic + random: unique inside a session and across merged boards.
  return prefix + (++_seq).toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * Minimal typed event bus. Handlers never throw into the emitter — caught
 * errors go to reportCaught() (one toast per distinct fault, safe on hot paths).
 */
export type Emitter<E = Record<string, unknown>> = {
  on<K extends keyof E & string>(evt: K, fn: (payload: E[K]) => void): () => void,
  off<K extends keyof E & string>(evt: K, fn: (payload: E[K]) => void): void,
  emit<K extends keyof E & string>(evt: K, payload?: E[K]): void,
};

export function emitter<E = Record<string, unknown>>(): Emitter<E> {
  // `never` parameter is the common supertype of all handler signatures.
  const map = new Map<string, Set<(payload: never) => void>>();
  return {
    on(evt, fn) {
      (map.get(evt) || map.set(evt, new Set()).get(evt)!).add(fn);
      return () => map.get(evt)!.delete(fn);
    },
    off(evt, fn) { map.get(evt)?.delete(fn); },
    emit(evt, payload) {
      for (const fn of map.get(evt) || []) {
        try {
          // SAFETY: on() files each handler under the event it was typed for, so fn takes E[evt].
          (fn as (payload?: E[typeof evt]) => void)(payload);
        }
        catch (e) { reportCaught(e, 'handler for "' + evt + '"'); }
      }
    },
  };
}

/** Collapse repeated calls into one per animation frame. */
export function rafThrottle<A extends unknown[]>(fn: (...args: A) => void) {
  let id = 0;
  let lastArgs: A | null = null;
  return function (...args: A) {
    lastArgs = args;
    if (id) return;
    id = requestAnimationFrame(() => { id = 0; fn(...lastArgs!); });
  };
}

export function extOf(name = '') {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function baseName(name = '') {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function formatBytes(n: number) {
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
}

/** Non-null, non-array object guard. Arrays excluded — callers read named keys, not elements. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Own-property test via prototype — Safari 15.4+ has hasOwn, older WebKit does not. */
export const hasOwn = <T extends object>(table: T, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(table, key);

/** Whether a value is a 64-char hex string (sha256 content id shape). */
export const isHash = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/** Safe CSS font family name: alphanumeric + space/dash/underscore, max 40 chars. */
export const isFamily = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/.test(v);

/**
 * The meta keys that hold one content id. makeItem() (board-model.ts) drops a
 * malformed value under any of them, and state.ts's replaceOldVersions() remaps
 * them, both from this list, so a key added here reaches every walk.
 */
export const META_HASH_KEYS: readonly string[] = [
  'cover', 'shot', 'thumb', 'preview', 'art',
  // The baked ~1024px display copy (optimize/picture.ts, import/drop.ts). A
  // derived asset like the thumb, so it packs and syncs by the same walk.
  'display',
  // The file a picture was decoded from, kept beside it: the .heic or the
  // camera RAW a card's WebP was made out of (import/drop.ts). Packed and
  // synced like any other reference, and dropped by the optimiser, which is
  // the one thing on the board that deliberately throws an original away.
  'source',
  // Legacy key — nothing writes it but old boards still carry it.
  'poster',
  // A folder card out of an archive points into it (import/unpack.ts).
  'archive',
];

/** The optimiser's memo of what it replaced, so undo can put it back. Not in
 *  itemHashes(): exports carry only the small copies. Every store that must
 *  keep bytes alive for undo or the timeline reads these too (heldHashes()). */
export const ORIGINAL_HASH_KEYS: readonly string[] = ['was', 'wasCover'];

type HashBearer = { asset?: { hash?: string } | null, meta?: Record<string, unknown> | null } | null | undefined;

const presentHashes = (list: unknown[]) =>
  list.filter((h): h is string => typeof h === 'string' && h.length > 0);

/**
 * All content hashes an item claims: its asset, every META_HASH_KEYS entry
 * and a folder's listed files. Filtered for presence only — validity is the
 * packer's job. Structurally typed so board-model.ts need not be imported.
 *
 * This is the one list every asset walk is built on: storage/mbrd.ts's
 * boardAssetHashes() and timeline.ts's timelineHashes() both come through here,
 * so a class of reference added in this array reaches the cloud-sync upload for
 * free - which is why meta.art (a link card's fetched album cover) is here and
 * not only where it is written.
 */
export const itemHashes = (item: HashBearer): string[] =>
  presentHashes([
    item?.asset?.hash,
    ...META_HASH_KEYS.map(key => item?.meta?.[key]),
    // A folder dropped from the disk lists its own files: what the card holds
    // until it is opened, so they pack and sync with it.
    ...(Array.isArray(item?.meta?.files) ? item.meta.files.map(f => (isRecord(f) ? f.hash : null)) : []),
  ]);

/** The optimiser originals an item still names (ORIGINAL_HASH_KEYS). */
export const originalHashes = (item: HashBearer): string[] =>
  presentHashes(ORIGINAL_HASH_KEYS.map(key => item?.meta?.[key]));

/** Every hash whose bytes must stay stored for this item: what it shows and
 *  packs, plus the originals an undo or a timeline step would put back. */
export const heldHashes = (item: HashBearer): string[] =>
  [...itemHashes(item), ...originalHashes(item)];

/**
 * What a card arrived as, which is not always what it holds.
 *
 * A HEIC or a camera RAW imported since the decoders landed keeps its *picture*
 * at asset.hash and the file it was made from at meta.source - so meta.ext says
 * `webp`, and origName is the only place the .heic or the sensor is still
 * named. Boards written before that, and every other format, answer from
 * meta.ext exactly as they always did. Both shapes have to read for as long as
 * old boards open, which is why this is one function and not a condition
 * written out at each of its callers.
 *
 * Lowercased, like extOf(). Empty string when there is nothing to go on.
 */
export const cameFrom = (
  item: { name?: string, meta?: Record<string, unknown> | null } | null | undefined,
): string => {
  const meta = item?.meta;
  if (typeof meta?.source === 'string' && meta.source
    && typeof meta.origName === 'string' && meta.origName) {
    return extOf(meta.origName);
  }
  const ext = typeof meta?.ext === 'string' && meta.ext ? meta.ext : extOf(item?.name);
  return ext.toLowerCase();
};

/**
 * Whether this is a dev server (localhost/LAN). Memoised — deferred to first
 * call so util.ts stays loadable without a browser. Also the anchor half of
 * sw.test.js's parity check (sw.js carries the same regex).
 */
let devHost: boolean | null = null;

export function isDev() {
  if (devHost === null) {
    const h = location.hostname;
    devHost = h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' ||
              /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(h);
  }
  return devHost;
}

