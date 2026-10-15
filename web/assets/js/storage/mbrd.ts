// The .mbrd container — a ZIP holding manifest.json, board.json, the history
// in timeline/, and content-addressed assets/, notes/, waveforms/, and its
// picture for a list of boards. One self-contained file. Items reference bytes as `asset: { hash, embedded: true }`.

import { appendZip, layoutFromTail, readZip, readZipBlob, writeZip, writeZipLayout } from './zip.ts';
import type { ZipEntry, ZipLayout } from './zip.ts';
import { getAsset, putAsset } from './assets.ts';
import type { Asset } from './assets.ts';
import { sha256 } from '../crypto.ts';
// Aliased — this module has its own fileKey() and nameOf().
import { withLift, fileKey as consentKey, nameOf as blobName } from '../consent.ts';
import { isHash, isRecord, itemHashes } from '../util.ts';
// Read from stored document, not live ledger — must match what the file carries.
import { timelineHashes } from '../timeline.ts';
import { VERSION } from '../version.js';
// Pure functions of the format's Markdown flavour — needed for sidecar reconciliation.
import { parseNoteText, flattenNoteRich } from '../canvas/note-model.ts';
import type { Item, TrashEntry, FontSpec } from '../board-model.ts';
import { MAX_CHILD_BOARDS } from '../board-tree.ts';

const FORMAT = 'mbrd';
const FORMAT_VERSION = 1;
export const MIME = 'application/vnd.mbrd+zip';

/** Features a reader must support to open the file safely. Unlike `version`
 *  (which no reader actually refuses), an unsupported `requires` entry makes
 *  the reader refuse rather than silently drop unknown fields. A file names
 *  only what it uses, so one that uses nothing still says `[]`.
 *
 *  `boards`: boards inside the board, under boards/<id>/. A reader without it
 *  would open the top board and, on its next save, write the file back without
 *  the children - the one loss the format may not allow, and what this gate
 *  was put in for. A file with no child does not say it, and opens anywhere. */
const SUPPORTED_FEATURES: ReadonlySet<string> = new Set<string>(['boards']);

/** Where each board inside the board lives, by id. Flat: a grandchild is
 *  `boards/<id>/` too, so a path never grows with the depth. */
const BOARDS_DIR = 'boards/';
const CHILD_DOC = /^boards\/([A-Za-z0-9_-]{1,64})\/board\.json$/;

const ASSETS_DIR = 'assets/';

// Hash shape (util.ts/isHash) enforced in both directions: it is interpolated
// into ZIP paths, so a malformed id like `../escape` would be a path traversal.
// Also load-bearing for dedup, waveform sidecars, and the autosave sweep.

/** Extensions we will put in a path. Long enough for `jpeg`, `webm`, `tiff`. */
const ASSET_EXT = /^[a-z0-9]{1,12}$/;

/** Ids safe in a filename. uid() always produces one; anything else loses its
 *  readable .md sidecar rather than naming a file. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// Two directions, two types. Out: serializeBoard() guarantees real Items.
// In: a .mbrd is a renamed ZIP anyone can edit — fields are `unknown`,
// narrowed at each use; only hashes/extensions/bytes are checked strictly.
// ---------------------------------------------------------------------------

/** The board as serializeBoard() hands it over, of which the packer reads four. */
export type PackedBoard = {
  title?: string;
  items: Item[];
  trash?: TrashEntry[];
  settings?: { fonts?: FontSpec[] };
  /**
   * The step ledger, as board-schema.ts writes it. `unknown` on purpose: this
   * module asks it for asset ids and nothing else, and timelineHashes() is the
   * only thing that reads its shape.
   */
  timeline?: unknown;
  /** The boards inside this one, by id, each in this same shape plus its own
   *  picture as a data URL. Only ever on the top board. */
  boards?: Record<string, unknown>;
};

/** A board inside the board, as the packer takes it. */
type PackedChild = PackedBoard & { thumb?: string | null };

/** The children worth writing: an id that can name a directory, a document
 *  with a list of items, and no more than MAX_CHILD_BOARDS of them. */
function childrenOf(boardData: PackedBoard): [string, PackedChild][] {
  if (!isRecord(boardData.boards)) return [];
  const out: [string, PackedChild][] = [];
  for (const [id, doc] of Object.entries(boardData.boards)) {
    if (!SAFE_ID.test(id) || !isRecord(doc) || !Array.isArray(doc.items)) continue;
    // SAFETY: a child is serializeLevel()'s document, as the top board is, or
    // a cloud copy of one - the same shape packBoard() has always trusted the
    // top's to be. The two checks above are what the loops below lean on.
    out.push([id, doc as PackedChild]);
    if (out.length >= MAX_CHILD_BOARDS) break;
  }
  return out;
}

/** One item out of a file, before anything has held it to a shape. */
type FileItem = Record<string, unknown>;

/**
 * A board out of a file, ditto. `items` and `trash` are declared as arrays
 * because the loops below iterate them exactly as this module always has: a
 * file whose `items` is not a list throws here rather than being quietly read
 * as an empty board, which is the difference between "this file is broken" and
 * "here is your board, with nothing on it".
 */
type FileBoard = {
  title?: unknown,
  items?: unknown[],
  trash?: unknown[],
  boards?: Record<string, FileBoard & { thumb?: string | null, timeline?: unknown }>,
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const json = (obj: unknown) => enc.encode(JSON.stringify(obj, null, 2));

/** Every asset hash the board references (items, bin, fonts, timeline).
 *  Used by cloud sync. Kept in sync with packBoard() via tests/mbrd.test.js —
 *  shared code was rejected because pack needs labels, error handling and
 *  fatal/non-fatal distinction this function does not.
 *  Malformed hashes skipped (not thrown) — refusing to sync a whole board over
 *  one bad id would strand it. */
export function boardAssetHashes(boardData: PackedBoard): Set<string> {
  const out = new Set<string>();
  // Every level of the tree, as the packer walks it: a child's pictures are in
  // the one shared assets/, and a sync that skipped them would bring the board
  // back on another machine with holes in it.
  for (const level of [boardData, ...childrenOf(boardData).map(([, doc]) => doc)]) {
    for (const item of [...level.items, ...(level.trash || []).map(t => t.item)]) {
      for (const hash of itemHashes(item)) if (isHash(hash)) out.add(hash);
    }
    for (const font of level.settings?.fonts || []) {
      if (isHash(font?.hash)) out.add(font.hash);
    }
    for (const hash of timelineHashes(level.timeline)) if (isHash(hash)) out.add(hash);
  }
  return out;
}

/**
 * Pack a serialised board plus the assets it references into a .mbrd Blob.
 * Only hashes still referenced by an item are written, so deleting an item and
 * saving actually shrinks the file.
 */
export async function packBoard(boardData: PackedBoard, opts: PackOptions = {}) {
  const { entries, manifest, now } = await boardEntries(boardData, opts);
  return { blob: await writeZip(entries, { date: now, mime: MIME }), manifest };
}

/**
 * A save to the board's own file. Whole, or - given `prior`, where the last
 * write to that file left each entry - only what changed, as a tail for the
 * shell to append (appendZip() in zip.ts). `appended` says which `blob` is.
 *
 * An asset's name carries its hash, so the same name is the same bytes and it
 * is never read to be compared. The rest are small and compared by checksum.
 * The file is written whole again when more than half of it would be dead
 * bytes: that save costs a whole write, and gives the space back.
 *
 * An asset the file already holds keeps the name it is held under (heldNames).
 */
export async function packBoardFile(
  boardData: PackedBoard, { prior = null, ...opts }: PackOptions & { prior?: ZipLayout | null } = {},
) {
  const { entries, manifest, now } = await boardEntries(boardData, opts);
  const zip = { date: now, mime: MIME };
  if (prior) {
    const { tail, layout, waste } = await appendZip(heldNames(entries, prior), prior, name => name.startsWith(ASSETS_DIR), zip);
    if (waste * 2 <= layout.size) return { blob: tail, manifest, layout, appended: true };
  }
  const { blob, layout } = await writeZipLayout(entries, zip);
  return { blob, manifest, layout, appended: false };
}

/**
 * Asset entries renamed to the name the file already holds their bytes under.
 *
 * An asset's name is a readable slug and its hash, and only the hash is read
 * back: unpackBoard() drops the slug. So a card with no name of its own, saved
 * from a board that was opened from its file, comes out under a bare hash
 * where the file says `20250702-152212--<hash>`. appendZip() matches by name,
 * saw a new entry, and wrote the picture again. A 388 MB board opened on a
 * phone and saved once grew to 653 MB: 140 pictures written twice, every byte
 * of them identical, and the first copy left dead.
 *
 * The bytes are the hash's, so the name they are already under is as good as
 * any. A slug gone stale by a rename stays until the file is next written
 * whole, which is cosmetic - the slug is for a person unzipping the file.
 */
function heldNames(entries: ZipEntry[], prior: ZipLayout): ZipEntry[] {
  const held = new Map<string, string>();
  for (const name of prior.records.keys()) {
    const id = assetId(name);
    if (id) held.set(id, name);
  }
  return entries.map(entry => {
    const id = assetId(entry.name);
    const was = id && held.get(id);
    return was && was !== entry.name ? { ...entry, name: was } : entry;
  });
}

/** An asset entry's identity: its hash and extension, without the slug. Null for anything else. */
function assetId(name: string): string | null {
  if (!name.startsWith(ASSETS_DIR)) return null;
  const file = name.slice(ASSETS_DIR.length);
  const sep = file.lastIndexOf('--');
  const tail = sep >= 0 ? file.slice(sep + 2) : file;
  const dot = tail.lastIndexOf('.');
  const hash = dot > 0 ? tail.slice(0, dot) : tail;
  return isHash(hash) ? tail.toLowerCase() : null;
}

/** `thumb` is the board's picture as a data URL, boardThumb()'s answer. */
type PackOptions = { created?: string | null, allowMissing?: boolean, thumb?: string | null };

/** Every entry a .mbrd of this board holds, in the order they are written. */
async function boardEntries(
  boardData: PackedBoard,
  { created = null, allowMissing = false, thumb = null }: PackOptions = {},
) {
  const now = new Date();
  const children = childrenOf(boardData);
  const manifest = {
    format: FORMAT,
    version: FORMAT_VERSION,
    app: 'mbrd ' + VERSION,
    created: created || now.toISOString(),
    modified: now.toISOString(),
    title: boardData.title || 'Untitled board',
    // Always present (even empty) so every implementer sees it exists, and
    // naming only what this file uses. See SUPPORTED_FEATURES.
    requires: children.length ? ['boards'] : [],
  };

  // Every level of the tree, the top first. Binned items count — without their
  // bytes the bin lists things that can no longer be restored.
  const { boards: _children, ...topData } = boardData;
  const levels: { prefix: string, data: PackedBoard, thumb: string | null }[] = [
    { prefix: '', data: topData, thumb: null },
    ...children.map(([id, { thumb: picture = null, ...data }]) =>
      ({ prefix: `${BOARDS_DIR}${id}/`, data, thumb: picture })),
  ];
  const referenced = levels.flatMap(({ data }) => [
    ...data.items,
    ...(data.trash || []).map(t => t.item),
  ]);

  // Before serialisation — waveform peaks are stripped from board.json when
  // they get their own sidecar file. One waveforms/ for the whole tree, like assets/.
  const waveforms = collectWaveforms(referenced);

  const entries: ZipEntry[] = [
    // First entry, stored, no extra field — MIME at fixed offset (ODF/EPUB
    // convention) so file(1) can identify a .mbrd. Written for other software;
    // this reader trusts manifest.format, not this entry.
    { name: 'mimetype', data: enc.encode(MIME), compress: false },
    { name: 'manifest.json', data: json(manifest), compress: true },
  ];
  for (const { prefix, data } of levels) {
    // The history goes in its own files, so board.json stays the board.
    const ledger = timelineFiles(data.timeline);
    const doc = withoutPeaks(data, waveforms);
    if (ledger) delete doc.timeline;
    entries.push({ name: `${prefix}board.json`, data: json(doc), compress: true });
    if (ledger) {
      entries.push({ name: prefix + TIMELINE_BASE, data: ledger.base, compress: true });
      for (const [name, bytes] of ledger.pieces) entries.push({ name: prefix + name, data: bytes, compress: true });
    }
  }

  // Gather all referenced assets before writing. Fatal on missing — a board
  // with a hole must not claim success (used to silently export holes).
  const missing = [];
  const seen = new Set();
  // First-reference label captured here — by write time the naming item is
  // out of reach. Fixed order keeps archives reproducible.
  const assets: { hash: string, asset: Asset, label: string }[] = [];
  for (const item of referenced) {
    // An item can reference multiple hashes (own asset + cover).
    for (const hash of itemHashes(item)) {
      if (seen.has(hash)) continue;
      seen.add(hash);
      // This is where the hash becomes a path — must be valid.
      if (!isHash(hash)) {
        throw new Error(
          `"${nameOf(item, String(hash))}" has a malformed content id. ` +
          'Nothing was written - the board is unchanged.'
        );
      }
      const asset = getAsset(hash);
      if (asset) assets.push({ hash, asset, label: assetLabel(item, asset) });
      else missing.push(nameOf(item, hash));
    }
  }

  // Fonts — missing is non-fatal (degrades to fallback stack, same as any
  // machine that never had the face).
  for (const font of levels.flatMap(({ data }) => data.settings?.fonts || [])) {
    if (!isHash(font?.hash) || seen.has(font.hash)) continue;
    seen.add(font.hash);
    const asset = getAsset(font.hash);
    // Family name, not filename (Inter.woff2 on disk is often a long variant name).
    if (asset) assets.push({ hash: font.hash, asset, label: font.family || '' });
  }

  // Timeline assets — a step that deleted a photo is the only thing naming it.
  // Missing is non-fatal: a step can reference bytes the optimiser discarded,
  // and refusing to export the board over a history entry would be backwards.
  for (const hash of levels.flatMap(({ data }) => [...timelineHashes(data.timeline)])) {
    if (!isHash(hash) || seen.has(hash)) continue;
    seen.add(hash);
    const asset = getAsset(hash);
    // No item to ask — stored filename is all we have.
    if (asset) assets.push({ hash, asset, label: assetLabel(null, asset) });
  }

  // `allowMissing` is for the shelf only. An export must refuse on missing
  // assets, but shelving (called by Open/New/Switch) must not — one lost photo
  // used to take the whole board hostage with no escape except Clear everything.
  // A shelf copy one picture short is worth more than no copy at all.
  if (missing.length && !allowMissing) {
    const shown = missing.slice(0, 3).join(', ');
    const rest = missing.length > 3 ? ` and ${missing.length - 3} more` : '';
    throw new Error(
      `${missing.length} item${missing.length === 1 ? '' : 's'} ` +
      `${missing.length === 1 ? 'has' : 'have'} no stored data (${shown}${rest}). ` +
      'Nothing was written - the board is unchanged.'
    );
  }

  for (const { hash, asset, label } of assets) {
    const ext = ASSET_EXT.test((asset.ext || '').toLowerCase()) ? '.' + asset.ext.toLowerCase() : '';
    // Slug for human readability when unzipped; hash for the reader.
    const slug = slugify(label);
    entries.push({
      name: `${ASSETS_DIR}${slug ? slug + '--' : ''}${hash}${ext}`,
      // Pass Blob, not bytes — avoids loading every asset into memory at once.
      data: asset.blob,
      // Media is already compressed; deflating it burns time for ~0 bytes.
      compress: shouldCompress(asset.mime, asset.ext),
    });
  }

  // Sticky notes as readable .md sidecars, each in its own board's notes/.
  // Unsafe ids skip the sidecar — board.json always has the text.
  for (const { prefix, data } of levels) {
    for (const item of [...data.items, ...(data.trash || []).map(t => t.item)]) {
      if (item.type !== 'note' || !SAFE_ID.test(item.id)) continue;
      entries.push({ name: prefix + noteFile(item), data: enc.encode(noteMarkdown(item)), compress: true });
    }
  }

  // ...and every waveform that has been measured, one per audio file.
  for (const [hash, peaks] of waveforms) {
    entries.push({ name: waveformFile(hash), data: enc.encode(waveformJSON(peaks)), compress: true });
  }

  // Each child's picture of itself, for the card that opens it.
  for (const { prefix, thumb: picture } of levels) {
    const entry = prefix ? thumbnailEntry(picture, prefix) : null;
    if (entry) entries.push(entry);
  }

  // The picture last, so a whole write puts it beside the directory and a list
  // of boards reads it from the file's end (thumbnailFromTail()).
  const picture = thumbnailEntry(thumb);
  if (picture) entries.push(picture);

  return { entries, manifest, now };
}

// ---------------------------------------------------------------------------
// The thumbnail: the board's own picture, for a list of boards to show
// without opening one. Optional, and a reader that ignores it loses nothing.
// ---------------------------------------------------------------------------

/** The name the picture goes under, by its type. */
const THUMB_NAMES: Record<string, string> = {
  'image/webp': 'thumbnail.webp',
  'image/jpeg': 'thumbnail.jpg',
};

/** A 360px picture is tens of KB. Past this it is not one, and is not read. */
const THUMB_MAX = 512 * 1024;

function thumbnailEntry(url: string | null, prefix = ''): ZipEntry | null {
  const m = /^data:(image\/(?:webp|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url || '');
  if (!m) return null;
  const bytes = fromBase64(m[2]);
  if (bytes.length > THUMB_MAX || thumbType(bytes) !== m[1]) return null;
  // Stored: a WebP or a JPEG does not deflate, and a stored entry is what
  // thumbnailFromTail() can lift straight out of the bytes.
  return { name: prefix + THUMB_NAMES[m[1]], data: bytes, compress: false };
}

/** The picture's type from its own first bytes, never from its name: the
 *  answer becomes a data URL, and only these two are let through. */
function thumbType(b: Uint8Array): string | null {
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}

/** A picture out of a file as a data URL for an <img>, or null. */
function thumbnailUrl(bytes: Uint8Array): string | null {
  if (bytes.length > THUMB_MAX) return null;
  const type = thumbType(bytes);
  return type ? `data:${type};base64,${toBase64(bytes)}` : null;
}

function thumbnailIn(files: Map<string, Uint8Array>, prefix = ''): string | null {
  for (const name of Object.values(THUMB_NAMES)) {
    const bytes = files.get(prefix + name);
    if (bytes) return thumbnailUrl(bytes);
  }
  return null;
}

/**
 * The picture out of a board's last bytes, for a list that must not read whole
 * files. `tail` and `size` as layoutFromTail() takes them. Answers the picture;
 * or, when `tail` does not reach it, how many bytes from the end it does; or
 * null for a file with none, or one whose bytes do not add up. A stored entry
 * only - this module writes it stored, and one rezipped deflated goes without.
 */
export function thumbnailFromTail(tail: Uint8Array, size: number): string | number | null {
  const layout = layoutFromTail(tail, size);
  if (layout === null || typeof layout === 'number') return layout;
  for (const name of Object.values(THUMB_NAMES)) {
    const rec = layout.records.get(name);
    if (!rec) continue;
    if (rec.method !== 0 || rec.csize > THUMB_MAX) return null;
    const base = size - tail.length;
    if (rec.offset < base) return size - rec.offset;
    const at = rec.offset - base;
    if (at + 30 > tail.length) return null;
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    if (view.getUint32(at, true) !== 0x04034b50) return null;
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    if (start + rec.csize > tail.length) return null;
    return thumbnailUrl(tail.subarray(start, start + rec.csize));
  }
  return null;
}

function toBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The note's text from meta, narrowed once for the three readers below. */
const noteTextOf = (item: Item) => (typeof item.meta?.text === 'string' ? item.meta.text : '');

/** Human label for an item in error messages: name > note text > hash prefix. */
function nameOf(item: Item, hash: string) {
  if (item.name) return item.name;
  if (item.type === 'note') {
    const first = noteTextOf(item).split('\n')[0].trim();
    if (first) return `note "${first.slice(0, 24)}"`;
  }
  return `${item.type || 'item'} ${hash.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Notes as Markdown — each note gets a .md sidecar (readable, greppable).
// Unpack prefers the sidecar over board.json, so hand-edits round-trip.
// ---------------------------------------------------------------------------

const NOTES_DIR = 'notes/';

/** As long as a slug may be, in either directory. Long enough to be a sentence. */
const SLUG_MAX = 48;

/** Lowercase, hyphenated slug for ZIP entry names. Allow-list only (a-z, 0-9,
 *  dash) — the result is interpolated into paths, so no traversal by construction.
 *  Shared by note sidecars and asset names so `--` separator stays unambiguous. */
function slugify(text: string, fallback = '') {
  return (text || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    // The slice can land mid-run and leave the dash it cut through behind.
    .replace(/-+$/, '') || fallback;
}

/** Label for an asset entry: card name (user's rename wins) > stored filename. */
const assetLabel = (item: Item | null, asset: Asset) => {
  const label = item?.name || asset.name || '';
  const ext = (asset.ext || '').toLowerCase();
  // Drop the extension that the entry will get anyway (avoid `photo-jpg--hash.jpg`).
  // Matched against the asset's own ext, not a pattern — avoids eating "Notes v1.2".
  return ext && label.toLowerCase().endsWith('.' + ext)
    ? label.slice(0, -(ext.length + 1)) : label;
};

function noteFile(item: Item) {
  // `--` separator: slug has single dashes only, uid has one dash.
  const first = noteTextOf(item).split('\n')[0];
  return `${NOTES_DIR}${slugify(first, 'note')}--${item.id}.md`;
}

/** First line as heading, rest as body. Skips `# ` prefix when the line
 *  already has one (rich notes store their own markers). */
function noteMarkdown(item: Item) {
  const [title, ...rest] = noteTextOf(item).split('\n');
  const head = title.trim();
  const marker = /^#+\s/.test(head) ? '' : '# ';
  const body = rest.join('\n').trim();
  return (head ? marker + head + '\n' : '') + (body ? '\n' + body + '\n' : '');
}

/** Parse a note sidecar back. Tolerant — heading marker is optional, blank
 *  line under it optional, trailing whitespace stripped. The `# ` marker is
 *  preserved (not stripped) so rich note reconciliation does not rebuild blocks
 *  on a plain round-trip (stripping it destroyed alignment and wash keys). */
function parseNote(text: string) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const title = (lines.shift() || '').trim();
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return [title, ...lines].join('\n').replace(/\n+$/, '');
}

/** The id a note file was written for, or null if this is not one of ours.
 *  `prefix` is the board's directory, empty for the top board. */
function noteId(name: string, prefix = '') {
  const dir = prefix + NOTES_DIR;
  if (!name.startsWith(dir) || !name.endsWith('.md')) return null;
  const stem = name.slice(dir.length, -'.md'.length);
  const cut = stem.lastIndexOf('--');
  return cut === -1 ? null : stem.slice(cut + 2) || null;
}

// ---------------------------------------------------------------------------
// Waveforms as sidecars — keyed by audio hash (not card id), one file per
// distinct audio. JSON (text deflates nearly as well as binary: 582 vs 426 B,
// and readability is the point of a ZIP-as-folder format). Sidecar outranks
// board.json; board.json copy stripped (withoutPeaks). Unreadable sidecar →
// re-measure from audio (a few hundred ms), never fatal.
// ---------------------------------------------------------------------------

const WAVES_DIR = 'waveforms/';

/** Collect hash→peaks, one per distinct audio. First valid set wins. */
function collectWaveforms(items: Item[]) {
  const out = new Map<string, number[]>();
  for (const item of items) {
    const hash = item?.asset?.hash;
    if (!hash || out.has(hash)) continue;
    const peaks = item.meta?.peaks;
    if (isReadings(peaks)) out.set(hash, peaks);
  }
  return out;
}

/**
 * The board as it goes into board.json: the same data, minus the readings that
 * are being written out beside it.
 *
 * Driven by the same map the files are written from, so the two can never
 * drift into a board that dropped its readings without a file to find them in.
 * Copies rather than edits - `meta` here is the live object off the item, and
 * packing a board is not allowed to change it.
 */
function withoutPeaks(boardData: PackedBoard, waveforms: Map<string, number[]>) {
  const strip = (item: Item) => {
    if (!item?.meta) return item;
    // The same question twice below, asked once: whether this item's bytes are
    // getting a sidecar. An item with no hash at all is not, which is what
    // has(undefined) always answered.
    const hash = item.asset?.hash;
    const sidecar = !!hash && waveforms.has(hash);
    // The optimiser's originals. They are kept in the browser so that undoing an
    // optimisation has something to put back (see swapAssets in state.ts), but
    // an export is the thing the optimising was *for* - the archive carries the
    // small copies alone, and a `was` spelled into it would name bytes the
    // packer never wrote. Dropped here rather than at the item, so a board that
    // has been exported still has its undo.
    const drop = 'was' in item.meta || 'wasCover' in item.meta;
    if (!drop && !sidecar) return item;
    const { peaks, was, wasCover, ...meta } = item.meta;
    // Only the readings that were actually written to a sidecar come out; a
    // board whose audio has no waveform file keeps them inline as before.
    if (!sidecar && item.meta.peaks) meta.peaks = item.meta.peaks;
    return { ...item, meta };
  };
  const out = { ...boardData, items: boardData.items.map(strip) };
  if (boardData.trash) out.trash = boardData.trash.map(t => ({ ...t, item: strip(t.item) }));
  return out;
}

const waveformFile = (hash: string) => `${WAVES_DIR}${hash}.json`;

/** The hash a waveform file was written for, or null if this is not one. */
function waveformHash(name: string) {
  if (!name.startsWith(WAVES_DIR) || !name.endsWith('.json')) return null;
  const hash = name.slice(WAVES_DIR.length, -'.json'.length);
  // Content id must be a valid hash, same rule as assets/.
  return isHash(hash) ? hash : null;
}

/** Hand-formatted JSON (16 per row for visual scanning). `res` = count,
 *  so a deleted row is caught on read (header/body disagree → dropped). */
function waveformJSON(peaks: number[]) {
  const rows = [];
  for (let i = 0; i < peaks.length; i += 16) rows.push('    ' + peaks.slice(i, i + 16).join(', '));
  return `{\n  "res": ${peaks.length},\n  "peaks": [\n${rows.join(',\n')}\n  ]\n}\n`;
}

/** ...and back, or null for anything that is not a set of readings. */
function parseWaveform(text: string): number[] | null {
  try {
    const data: unknown = JSON.parse(text);
    // Anything that is not an object answers no readings, which is what
    // `data?.peaks` said before there was a type to say it in.
    if (!isRecord(data)) return null;
    const peaks = data.peaks;
    if (!isReadings(peaks) || data.res !== peaks.length) return null;
    return peaks;
  } catch {
    return null;
  }
}

/** Plausible readings: normalised [0,1] numbers, 2–4096 long. Resolution is
 *  canvas/audio.ts's business; ceiling only prevents absurd hand-edited files. */
function isReadings(v: unknown): v is number[] {
  return Array.isArray(v) && v.length >= 2 && v.length <= 4096
    && v.every(n => typeof n === 'number' && n >= 0 && n <= 1);
}

// ---------------------------------------------------------------------------
// The timeline in its own files. timeline/base.json holds everything but the
// steps - the board before step 0, the marker, the fingerprint - plus how many
// steps there are. The steps are in pieces, timeline/steps-<k>.jsonl, one step
// to a line, oldest first. The files outrank a `timeline` in board.json, which
// is where a file from before them keeps it. Unreadable → no past.
// ---------------------------------------------------------------------------

const TIMELINE_BASE = 'timeline/base.json';
/** The one file the steps were in before the pieces (v0.464 and older). Still read. */
const TIMELINE_STEPS = 'timeline/steps.jsonl';
const TIMELINE_PIECE = /^timeline\/steps-(\d{1,7})\.jsonl$/;

/**
 * Steps to a piece.
 *
 * A save appends only the entries that changed (packBoardFile()), and the
 * history in one file was one entry that changed on every save: the whole of it
 * written again each time, a third of a megabyte near the step cap, and the
 * copy before left dead in the file. Piece k holds steps k*500 to k*500+499,
 * counted over the ledger's whole life (`first` is how many were folded away),
 * so a new step rewrites the last piece only, and a fold the first.
 */
const STEPS_PER_PIECE = 500;

/** The ledger as its files - base.json and the pieces - or null when there is none to write. */
function timelineFiles(timeline: unknown) {
  if (!isRecord(timeline) || !Array.isArray(timeline.steps)) return null;
  const { steps, ...head } = timeline;
  const first = Number.isSafeInteger(head.first) && Number(head.first) > 0 ? Number(head.first) : 0;
  const pieces = new Map<string, string[]>();
  steps.forEach((step, i) => {
    const name = `timeline/steps-${Math.floor((first + i) / STEPS_PER_PIECE)}.jsonl`;
    let lines = pieces.get(name);
    if (!lines) pieces.set(name, lines = []);
    lines.push(JSON.stringify(step) + '\n');
  });
  return {
    base: json({ ...head, count: steps.length }),
    pieces: [...pieces].map(([name, lines]) => [name, enc.encode(lines.join(''))] as const),
  };
}

/**
 * ...and back to the one object adoptTimeline() reads, or null.
 *
 * A line that will not parse stays in the list as null, and a lost tail adds
 * one, so the ledger is shorter than it says. adoptTimeline() marks such a
 * history stale rather than replaying steps that are not all there.
 */
function readTimelineFiles(files: Map<string, Uint8Array>, prefix = '') {
  const head = files.get(prefix + TIMELINE_BASE);
  if (!head) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(dec.decode(head)); } catch { return null; }
  if (!isRecord(parsed)) return null;
  const { count, ...rest } = parsed;
  const steps: unknown[] = [];
  // The pieces in their order, or the one file an older save wrote. A piece
  // missing from the middle leaves fewer steps than `count`, which is stale.
  const pieces = [...files.keys()]
    .filter(name => name.startsWith(prefix))
    .map(name => [name, TIMELINE_PIECE.exec(name.slice(prefix.length))?.[1]] as const)
    .filter((p): p is readonly [string, string] => p[1] !== undefined)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map(([name]) => files.get(name));
  const bodies = pieces.length ? pieces : [files.get(prefix + TIMELINE_STEPS)];
  for (const body of bodies) {
    for (const line of body ? dec.decode(body).split('\n') : []) {
      if (!line.trim()) continue;
      try { steps.push(JSON.parse(line)); } catch { steps.push(null); }
    }
  }
  if (typeof count === 'number' && count > steps.length) steps.push(null);
  return { ...rest, steps };
}

// Old `versions/<id>.json` entries (removed in v0.198) are silently skipped —
// they match no loop below, so the board opens without that history.

/** All items (board + bin). Sidecar readers need both — binned items keep
 *  their notes and waveforms until the bin is emptied. */
function* allItems(board: FileBoard): Generator<FileItem> {
  // isRecord where this used to be a bare truthiness test. Every reader below
  // asks an object question of what comes out - a type, a hash, a meta - and a
  // string or a number in the items array answers none of them either way.
  for (const item of board.items || []) if (isRecord(item)) yield item;
  for (const t of board.trash || []) if (isRecord(t) && isRecord(t.item)) yield t.item;
}

/** Note sidecars outrank board.json. Keyed by item id from the filename, in
 *  the board's own notes/ - `prefix` is its directory, empty for the top. */
function readNotes(board: FileBoard, files: Map<string, Uint8Array>, prefix: string) {
  const notes = new Map<unknown, FileItem>();
  for (const item of allItems(board)) if (item.type === 'note') notes.set(item.id, item);
  for (const [name, bytes] of files) {
    const id = noteId(name, prefix);
    const item = id && notes.get(id);
    if (!item) continue;
    const text = parseNote(dec.decode(bytes));
    const meta: Record<string, unknown> = { ...(isRecord(item.meta) ? item.meta : null), text };
    item.meta = meta;
    // Rebuild rich blocks from sidecar text when they disagree — stale rich
    // used to show old words on screen while Find matched the new ones.
    // Re-derived (not dropped) so the note keeps formatting metadata.
    const rich = meta.rich;
    if (isRecord(rich) && flattenNoteRich(rich) !== text) {
      meta.rich = { ...rich, blocks: parseNoteText(text) };
    }
  }
}

/** The type a stored asset entry is kept as, or null for any other entry. */
function assetType(name: string) {
  if (!name.startsWith(ASSETS_DIR)) return null;
  const dot = name.lastIndexOf('.');
  return dot > name.lastIndexOf('/') ? mimeFor(name.slice(dot + 1)) : '';
}

/**
 * Read a .mbrd Blob. Registers every embedded asset in the asset store and
 * returns `{ manifest, board }` ready for state.loadBoard().
 *
 * `owned` is a Blob the app holds and nothing else can change - a board the
 * shell read for it - whose pictures are then kept as slices of it rather than
 * copied out (readZipBlob()). Never a File from a picker or a drop.
 */
export async function unpackBoard(blob: Blob, { owned = false }: { owned?: boolean } = {}) {
  // Read, and if oversized, ask the user and retry with `lift`. Keyed by name
  // + size so a declined board does not re-prompt in the same session.
  const name = blobName(blob, 'This board');
  const read = async (lifted: boolean) => owned
    ? readZipBlob(blob, { lift: lifted, keep: assetType })
    : { files: await readZip(blob, { lift: lifted }), blobs: new Map<string, Blob>() };
  const { files, blobs } = await withLift(read, consentKey(blob), name, 'Open it');

  // The `mimetype` entry, when it leads the archive, names what this is. Another
  // ZIP-based format renamed to .mbrd (an EPUB, an ODF document) says so there
  // and is refused by name. A file with no `mimetype` first - every board
  // written before the entry existed, or one rezipped by another tool - is
  // judged by what follows, as it always was.
  const [first] = files.keys();
  const mime = files.get('mimetype');
  if (first === 'mimetype' && mime && dec.decode(mime).trim() !== MIME) {
    throw new Error('This is not an mbrd board (its mimetype says it is something else)');
  }
  const boardBytes = files.get('board.json');
  if (!boardBytes) throw new Error('This is not an mbrd board (no board.json inside)');

  // Read manifest one key at a time — non-object is treated as empty.
  let manifest: Record<string, unknown> = {};
  const manifestBytes = files.get('manifest.json');
  if (manifestBytes) {
    try {
      const parsed: unknown = JSON.parse(dec.decode(manifestBytes));
      if (isRecord(parsed)) manifest = parsed;
    } catch { /* keep going */ }
  }
  if (manifest.format && manifest.format !== FORMAT) {
    throw new Error(`Unknown board format "${String(manifest.format)}"`);
  }
  // Number() for loose comparison — hand-written `"2"` still warns.
  if (Number(manifest.version) > FORMAT_VERSION) {
    console.warn('[mbrd] file was written by a newer version; loading anyway');
  }
  // Unsupported features → refuse rather than silently drop data.
  // Non-strings ignored (a number names no feature).
  const required = (Array.isArray(manifest.requires) ? manifest.requires : [])
    .filter((f): f is string => typeof f === 'string' && !SUPPORTED_FEATURES.has(f));
  if (required.length) {
    throw new Error(
      `This board needs ${required.length === 1 ? 'a feature' : 'features'} this ` +
      `version of mbrd does not have (${required.slice(0, 3).join(', ')}). ` +
      'Nothing was opened - update mbrd and try again.'
    );
  }

  // Parse and type-check board.json (a string or null here used to silently
  // produce a blank board or a bare TypeError).
  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(boardBytes));
  } catch {
    throw new Error('The board inside this file is not readable (board.json will not parse)');
  }
  if (!isRecord(parsed)) throw new Error('The board inside this file is not a board (board.json is not an object)');
  // SAFETY: isRecord() above. FileBoard types items and trash as unknown[], and allItems()
  // isRecord-filters every element of both.
  const board = parsed as FileBoard;
  if (manifest.title && !board.title) board.title = manifest.title;

  // The timeline's own files outrank board.json, as the sidecars below do.
  const timeline = readTimelineFiles(files);
  if (timeline) parsed.timeline = timeline;
  readNotes(board, files, '');
  // Never from board.json: a `boards` key there is not this format's.
  delete board.boards;

  // The boards inside this one, each read as the top is, from its directory.
  // A child whose board.json will not parse is left out and said so; the board
  // card that names it then shows it missing rather than the file failing.
  const children: NonNullable<FileBoard['boards']> = {};
  let unread = 0;
  let count = 0;
  for (const name of files.keys()) {
    const id = CHILD_DOC.exec(name)?.[1];
    if (!id) continue;
    if (++count > MAX_CHILD_BOARDS) { unread++; continue; }
    const prefix = `${BOARDS_DIR}${id}/`;
    const bytes = files.get(name);
    let doc: unknown = null;
    try { if (bytes) doc = JSON.parse(dec.decode(bytes)); } catch { doc = null; }
    if (!isRecord(doc) || !Array.isArray(doc.items)) { unread++; continue; }
    // SAFETY: isRecord() and Array.isArray() above; every reader below
    // isRecord-filters what it takes out of items and trash, as for the top.
    const child = doc as NonNullable<FileBoard['boards']>[string];
    const history = readTimelineFiles(files, prefix);
    if (history) child.timeline = history;
    readNotes(child, files, prefix);
    child.thumb = thumbnailIn(files, prefix);
    delete child.boards;
    children[id] = child;
  }
  if (unread) console.warn(`[mbrd] ${unread} board${unread === 1 ? '' : 's'} inside this file could not be read`);
  const levels: FileBoard[] = [board, ...Object.values(children)];
  if (Object.keys(children).length) board.boards = children;

  // Waveforms the same, but one file can answer for several cards: the sidecar
  // is named after the audio, and every card holding that audio wants it - on
  // any level, since waveforms/ is shared as assets/ is.
  const waves = new Map<unknown, FileItem[]>();
  for (const item of levels.flatMap(level => [...allItems(level)])) {
    const asset = item.asset;
    const hash = isRecord(asset) ? asset.hash : undefined;
    if (!hash) continue;
    let holders = waves.get(hash);
    if (!holders) waves.set(hash, holders = []);
    holders.push(item);
  }
  for (const [name, bytes] of files) {
    const hash = waveformHash(name);
    const holders = hash && waves.get(hash);
    if (!holders) continue;
    const peaks = parseWaveform(dec.decode(bytes));
    if (!peaks) {
      // Non-fatal — falls back to board.json or re-measuring.
      console.warn('[mbrd] unreadable waveform', name, '- will re-measure');
      continue;
    }
    for (const item of holders) item.meta = { ...(isRecord(item.meta) ? item.meta : null), peaks };
  }

  // Assets last, strictly validated — this is where archive names become
  // trusted identities. Hash must match content (see HASH comment above).
  const registered = new Set<string>();
  const entries: [string, Uint8Array | Blob][] = [...files, ...blobs];
  for (const [name, data] of entries) {
    if (!name.startsWith(ASSETS_DIR)) continue;
    const file = name.slice(ASSETS_DIR.length);
    // Slug (before `--`) is discarded — it is for human readers only.
    // Content id (after `--`) is what becomes the identity.
    const sep = file.lastIndexOf('--');
    const tail = sep >= 0 ? file.slice(sep + 2) : file;
    const dot = tail.lastIndexOf('.');
    const hash = dot > 0 ? tail.slice(0, dot) : tail;
    const ext = dot > 0 ? tail.slice(dot + 1).toLowerCase() : '';
    if (!isHash(hash) || (ext && !ASSET_EXT.test(ext))) {
      throw new Error(`Not a readable .mbrd: "${name}" is not a valid asset path`);
    }
    // One hash, one file — duplicates would make the result order-dependent.
    if (registered.has(hash)) {
      throw new Error(`Not a readable .mbrd: content ${hash.slice(0, 8)} is stored twice`);
    }
    // Verify content matches its claimed hash — the only enforcement of
    // content addressing (dedup, waveforms, sweep all depend on it). A kept
    // slice is read for it one picture at a time.
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    if (await sha256(bytes) !== hash) {
      throw new Error(`"${name}" does not contain the data its name claims`);
    }
    registered.add(hash);
    // A slice of an owned archive is kept as it is. Bytes are copied out of
    // the archive buffer: subarrays keep the whole ZIP alive.
    const kept = data instanceof Blob ? data : new Blob([bytes.slice()], { type: mimeFor(ext) });
    putAsset(hash, kept, { ext, mime: mimeFor(ext) });
  }

  return { manifest, board, thumb: thumbnailIn(files) };
}

/** Cheap sniff so a wrong-extension drop fails with a useful message. */
export function looksLikeMbrd(file: File) {
  return /\.mbrd$/i.test(file.name) || file.type === MIME;
}

const ALREADY_COMPRESSED = /^(image\/(?!svg|bmp|x-)|video\/|audio\/)|zip|gzip|compressed/i;
const RAW_EXT = new Set(['bmp', 'svg', 'txt', 'md', 'json', 'csv', 'xml', 'html', 'wav', 'tif', 'tiff']);

/** Already-compressed font formats (WOFF/WOFF2 use Brotli/zlib internally).
 *  TTF/OTF deliberately excluded — deflate halves their uncompressed tables. */
const SELF_COMPRESSED_EXT = new Set(['woff', 'woff2']);

function shouldCompress(mime: string, ext: string) {
  const lower = (ext || '').toLowerCase();
  if (RAW_EXT.has(lower)) return true;
  if (SELF_COMPRESSED_EXT.has(lower)) return false;
  if (mime && ALREADY_COMPRESSED.test(mime)) return false;
  return true;
}

// MIME rebuilt from extension on unpack — ZIP does not carry MIME types.
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  ogv: 'video/ogg', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  xml: 'application/xml', html: 'text/html', css: 'text/css', js: 'text/javascript',
  pdf: 'application/pdf', zip: 'application/zip',
};

export function mimeFor(ext: string) {
  return MIME_BY_EXT[(ext || '').toLowerCase()] || '';
}
