// The .mbrd container: a ZIP holding a manifest, the board, and every asset's
// bytes, so a board is one self-contained file you can email or drop back in.
//
//   myboard.mbrd            (ZIP, renamed)
//   |- manifest.json        { format, version, app, created, modified, title }
//   |- board.json           { view, settings, arrangement, items[], trash[] }
//   |- assets/<hash>.<ext>  embedded bytes, deduped by content hash
//   |- notes/<slug>--<id>.md    one sticky note, as Markdown
//   |- waveforms/<hash>.json    one audio file's measured readings
//   \- thumbnails/<hash>.webp   (reserved; not written yet)
//
// Items reference bytes as `asset: { hash, embedded: true }`. The schema also
// reserves `asset: { external: { path } }` for a later link-instead-of-embed
// setting - unpack tolerates it, pack simply has no bytes to write for it.

import { writeZip, readZip } from './zip.ts';
import type { ZipEntry } from './zip.ts';
import { getAsset, putAsset } from './assets.ts';
import { sha256 } from '../crypto.ts';
import { isHash, isRecord, itemHashes } from '../util.ts';
import { VERSION } from '../version.js';
// The note text model, and the only thing this module takes from canvas/. Both
// are pure functions of a string - the format's own Markdown flavour, which the
// renderer happens to also be the main reader of - and the sidecar reconciliation
// in unpackBoard() cannot be written without them. Copying twenty lines of block
// splitting in here to avoid the import would give the format a second answer to
// what `# ` means, which is the one thing worth avoiding more than the edge.
import { parseNoteText, flattenNoteRich } from '../canvas/note-model.ts';
import type { Item, TrashEntry, FontSpec } from '../board-model.ts';

export const FORMAT = 'mbrd';
export const FORMAT_VERSION = 1;
export const MIME = 'application/vnd.mbrd+zip';

const ASSETS_DIR = 'assets/';

/**
 * What a content id is allowed to be, enforced in both directions.
 *
 * A hash is not just a label here - it is interpolated into a path, both on the
 * way out (`assets/<hash>.<ext>`) and on the way back in, and a ZIP entry name
 * is a string that some other program will eventually treat as a filename. A
 * board claiming a hash of `../escape` opened perfectly happily and then packed
 * back out as `assets/../escape.bin`: harmless to this app, which never writes
 * the archive to disk, and a directory traversal in any extractor that does.
 *
 * The shape is also the load-bearing half of content addressing. Dedup, the
 * waveform sidecars and the autosave sweep all assume a hash names its bytes
 * and nothing else, so an id that was never a digest quietly breaks three
 * things that look unrelated.
 *
 * The shape itself is util.js/isHash, which is also what state.js holds items
 * to on the way in - the two ends of the same rule.
 */

/** Extensions we will put in a path. Long enough for `jpeg`, `webm`, `tiff`. */
const ASSET_EXT = /^[a-z0-9]{1,12}$/;

/**
 * Ids safe to spell inside a filename. `uid()` always produces one; anything
 * that does not is something a hand-written board.json invented, and it loses
 * its readable .md rather than being allowed to name a file (see noteFile).
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// The two directions, as two types
//
// They are deliberately not the same type. On the way *out* the board has just
// come through board-schema.ts/serializeBoard(), so every item is a real Item
// and this module may read `meta.text` and `asset.hash` as the app spells them.
// On the way *in* nothing has validated anything yet - a .mbrd is a renamed ZIP
// anybody can hand-edit, and normalizeBoard() is the thing that holds it to a
// shape, several steps later. So the reader's view of a board is `unknown` per
// field, narrowed at each use; what this module *does* check strictly is the
// part it turns into an identity - hashes, extensions and the bytes under them.
// ---------------------------------------------------------------------------

/** The board as serializeBoard() hands it over, of which the packer reads four. */
export type PackedBoard = {
  title?: string;
  items: Item[];
  trash?: TrashEntry[];
  settings?: { fonts?: FontSpec[] };
};

/** One item out of a file, before anything has held it to a shape. */
type FileItem = Record<string, unknown>;

/**
 * A board out of a file, ditto. `items` and `trash` are declared as arrays
 * because the loops below iterate them exactly as this module always has: a
 * file whose `items` is not a list throws here rather than being quietly read
 * as an empty board, which is the difference between "this file is broken" and
 * "here is your board, with nothing on it".
 */
type FileBoard = { title?: unknown, items?: unknown[], trash?: unknown[] };

const enc = new TextEncoder();
const dec = new TextDecoder();
const json = (obj: unknown) => enc.encode(JSON.stringify(obj, null, 2));

/**
 * Pack a serialised board plus the assets it references into a .mbrd Blob.
 * Only hashes still referenced by an item are written, so deleting an item and
 * saving actually shrinks the file.
 */
export async function packBoard(
  boardData: PackedBoard,
  { created = null }: { created?: string | null } = {},
) {
  const now = new Date();
  const manifest = {
    format: FORMAT,
    version: FORMAT_VERSION,
    app: 'mbrd ' + VERSION,
    created: created || now.toISOString(),
    modified: now.toISOString(),
    title: boardData.title || 'Untitled board',
  };

  // Binned items count as referenced. Their bytes are the whole reason the bin
  // is worth anything after a save - dropping them would leave the panel
  // listing things that can no longer come back.
  const referenced = [...boardData.items, ...(boardData.trash || []).map(t => t.item)];

  // Gathered before board.json is serialised, because those are not two
  // decisions but one: a hash whose readings get a file of their own is a hash
  // whose readings come out of the board. See the waveform block below.
  const waveforms = collectWaveforms(referenced);

  const entries: ZipEntry[] = [
    { name: 'manifest.json', data: json(manifest), compress: true },
    { name: 'board.json', data: json(withoutPeaks(boardData, waveforms)), compress: true },
  ];

  // Every distinct hash the board refers to, in one pass, before a single byte
  // is written.
  //
  // The check has to come first and it has to be fatal. This used to warn to
  // the console and carry on, which meant a board missing an asset packed
  // *successfully*: the .mbrd was written, "Exported" appeared, the board was
  // marked clean - and the file had a hole in it where a photograph should
  // have been. Every signal the user had said the work was safe. A refused
  // export leaves them with the board still open and still dirty, which is the
  // honest answer and the recoverable one.
  const missing = [];
  const seen = new Set();
  const assets = [];
  for (const item of referenced) {
    // Plural: an item can name two lots of bytes, its own and the picture it
    // was given (see setItemCover in state.js). Both have to be in the archive
    // or the board comes back with a card that has lost its cover.
    for (const hash of itemHashes(item)) {
      if (seen.has(hash)) continue;
      seen.add(hash);
      // Checked here as well as on the way in, because this is the line that
      // turns a hash into a path. Nothing this app produces can fail it.
      if (!isHash(hash)) {
        throw new Error(
          `"${nameOf(item, String(hash))}" has a malformed content id. ` +
          'Nothing was written - the board is unchanged.'
        );
      }
      const asset = getAsset(hash);
      if (asset) assets.push({ hash, asset });
      else missing.push(nameOf(item, hash));
    }
  }

  // The faces the board is set in, which are the one lot of bytes no item names.
  //
  // Missing here is not fatal, and that is the difference from the loop above.
  // A photograph whose bytes are gone is a hole in the board where a picture
  // should be; a face whose bytes are gone is a board that opens in the
  // fallback stack, which is exactly what happens on any machine that never had
  // the face - so the archive is written without it and the look degrades the
  // way it was always going to degrade.
  for (const font of boardData.settings?.fonts || []) {
    if (!isHash(font?.hash) || seen.has(font.hash)) continue;
    seen.add(font.hash);
    const asset = getAsset(font.hash);
    if (asset) assets.push({ hash: font.hash, asset });
  }

  if (missing.length) {
    const shown = missing.slice(0, 3).join(', ');
    const rest = missing.length > 3 ? ` and ${missing.length - 3} more` : '';
    throw new Error(
      `${missing.length} item${missing.length === 1 ? '' : 's'} ` +
      `${missing.length === 1 ? 'has' : 'have'} no stored data (${shown}${rest}). ` +
      'Nothing was written - the board is unchanged.'
    );
  }

  for (const { hash, asset } of assets) {
    const ext = ASSET_EXT.test((asset.ext || '').toLowerCase()) ? '.' + asset.ext.toLowerCase() : '';
    entries.push({
      name: `${ASSETS_DIR}${hash}${ext}`,
      // The Blob itself, not its bytes. This loop used to be an await-in-loop of
      // arrayBuffer() calls that ended with every asset on the board resident at
      // once - and then writeZip held each payload a second time until the final
      // Blob was assembled, so a board's worth of video was two boards' worth of
      // heap. writeZip takes a Blob and never reads it whole; see its header.
      data: asset.blob,
      // Media is already compressed; deflating it burns time for ~0 bytes.
      compress: shouldCompress(asset.mime, asset.ext),
    });
  }

  // Every sticky note also goes in as a file you can read without this app.
  // A note whose id could not be spelled in a filename simply does not get one:
  // the .md is a convenience copy, the text itself is in board.json either way,
  // and unpack already falls back to it where no sidecar exists.
  for (const item of referenced) {
    if (item.type !== 'note' || !SAFE_ID.test(item.id)) continue;
    entries.push({ name: noteFile(item), data: enc.encode(noteMarkdown(item)), compress: true });
  }

  // ...and every waveform that has been measured, one per audio file.
  for (const [hash, peaks] of waveforms) {
    entries.push({ name: waveformFile(hash), data: enc.encode(waveformJSON(peaks)), compress: true });
  }

  return { blob: await writeZip(entries, { date: now, mime: MIME }), manifest };
}

/**
 * What to call an item in an error the user has to act on. Its name if it has
 * one, the first words of a note if it does not, and the bare hash only as a
 * last resort - "3 items have no stored data (photo.jpg, ...)" is something
 * you can go and look for on the board; a list of SHA-256 digests is not.
 */
/**
 * A note's own words, as this file may spell them into a filename, a heading or
 * an error. `meta` is `unknown` per key by design (see board-model.ts) and the
 * three readers below all want the same string, so the narrowing is done once
 * here: anything that is not text reads as none, which is what every one of
 * them already falls back to for a note that has not been written in yet.
 */
const noteTextOf = (item: Item) => (typeof item.meta?.text === 'string' ? item.meta.text : '');

function nameOf(item: Item, hash: string) {
  if (item.name) return item.name;
  if (item.type === 'note') {
    const first = noteTextOf(item).split('\n')[0].trim();
    if (first) return `note "${first.slice(0, 24)}"`;
  }
  return `${item.type || 'item'} ${hash.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Notes as Markdown
//
// A note is one string in board.json and that is still where it is *edited*
// from - but board.json is a machine's file, and a sticky note is the one kind
// of thing on a board that is purely the user's own writing. So each one is
// written out again as its own .md: unzip a .mbrd and your notes are a folder
// of readable files, greppable, diffable, openable in anything.
//
// The named half of the filename is for you and the id half is for the reader
// below, which is why both are there. Unpack prefers the .md over the copy in
// board.json, so editing one of those files by hand and reopening the board
// does what you would expect it to do.
// ---------------------------------------------------------------------------

const NOTES_DIR = 'notes/';

function noteFile(item: Item) {
  const first = noteTextOf(item).split('\n')[0];
  const slug = first.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'note';
  // Two dashes: the slug has had its own runs collapsed to one, and a uid
  // carries a single dash, so this separator appears nowhere else in the name.
  return `${NOTES_DIR}${slug}--${item.id}.md`;
}

/**
 * First line as a heading, the rest as the body.
 *
 * The marker is not added when the line already carries one. meta.text has been
 * Markdown-flavoured since meta.rich arrived - a block writes its own `# ` or
 * `## ` - so prefixing unconditionally exported a rich note's first line as
 * `# # buy the smaller one`. Harmless coming back, since parseNote() eats a run
 * of hashes, and wrong in the file, which is the half a person reads.
 */
function noteMarkdown(item: Item) {
  const [title, ...rest] = noteTextOf(item).split('\n');
  const head = title.trim();
  const marker = /^#+\s/.test(head) ? '' : '# ';
  const body = rest.join('\n').trim();
  return (head ? marker + head + '\n' : '') + (body ? '\n' + body + '\n' : '');
}

/**
 * ...and back. Tolerant on the way in, because by design these are files a
 * person may have typed into: the heading marker is optional, so is the blank
 * line under it, and trailing whitespace is nobody's content.
 */
function parseNote(text: string) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const title = (lines.shift() || '').replace(/^#+\s*/, '').trim();
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return [title, ...lines].join('\n').replace(/\n+$/, '');
}

/** The id a note file was written for, or null if this is not one of ours. */
function noteId(name: string) {
  if (!name.startsWith(NOTES_DIR) || !name.endsWith('.md')) return null;
  const stem = name.slice(NOTES_DIR.length, -'.md'.length);
  const cut = stem.lastIndexOf('--');
  return cut === -1 ? null : stem.slice(cut + 2) || null;
}

// ---------------------------------------------------------------------------
// Waveforms as sidecars
//
// Drawing an audio card's bars means decoding the entire file - a few hundred
// milliseconds for a long track, times every audio card on the board, all at
// once on the way in. What comes out of that is tiny: a couple of hundred RMS
// readings in [0, 1], which is why canvas/audio.js caches them on the item, and
// why they have been riding along inside board.json. This gives them a file,
// for the reason notes have one and for a second reason of their own.
//
// They are keyed by the hash of the audio, not by the id of the card. A
// waveform is a property of a recording rather than of the thing showing it -
// drop the same clip on the board twice and the two cards are the same shape,
// once - and assets/ is already named by content hash, so this is not a new
// naming scheme, it is the one already in the archive.
//
// JSON, and the size argument against it turns out not to survive contact
// with the ZIP. Packed 16-bit samples would be 512 bytes against 1858 of text,
// which sounds decisive until both go through deflate: 426 against 582. Three
// decimal digits and a comma are a six-character alphabet, and that is exactly
// the redundancy deflate exists to remove, so the whole saving is 156 bytes -
// per audio file, beside the megabytes of audio it was measured from. (Eight
// bits per sample would beat it properly, at a resolution of 1/255, which is
// four times coarser than the thousandths measure() goes out of its way to
// keep - see the note about quiet passages there.)
//
// So the readable form costs a rounding error, and readable is the point of a
// container that is a folder of files: a few hundred numbers laid out sixteen
// to a line is something a person can open, diff, and edit, and this format's
// whole pitch is that you can unzip it and find your work in there.
//
// Because the file is now the copy, the copy in board.json goes - see
// withoutPeaks(). Storing it twice would have been the same bytes for nothing
// and two places to disagree. Reading back is the notes rule again: the
// sidecar outranks board.json where there is one, board.json still works where
// there is not (a board written before this existed), and a file that has been
// truncated or typed into is ignored rather than fatal - the card can always
// fall back to measuring the audio again, which is what it did before any of
// this was here.
// ---------------------------------------------------------------------------

const WAVES_DIR = 'waveforms/';

/**
 * The readings to write, hash -> peaks, one entry per distinct audio file.
 *
 * First valid set wins. Two cards on the same hash should hold the same
 * readings - they were measured from the same bytes - and where they somehow
 * do not, one file per hash is the answer that keeps being true afterwards:
 * on the way back in both cards are given the file's.
 */
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
    // optimisation has something to put back (see swapAssets in state.js), but
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
  // Same rule as assets/: this half of the name is a content id, and one that
  // is not shaped like one belongs to no recording we could be holding.
  return isHash(hash) ? hash : null;
}

/**
 * Hand-laid out rather than run through JSON.stringify, which would give
 * either one unreadable line or one number per line for several hundred lines.
 * Sixteen to a row makes it a block of sixteen columns you can scan down and
 * see the shape in, the quiet stretches showing up as runs of leading zeros.
 * It is still perfectly ordinary JSON either way.
 *
 * `res` is the count again, in the one place a reader looks first. It also
 * catches the edit that deletes a row: a file whose header and body disagree
 * is a file that has lost something, and is dropped on the way in.
 */
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

/**
 * Whether something is a plausible set of readings, in the loose sense this
 * layer can judge: normalised amplitudes, none of them a string, a NaN or a
 * negative number. Deliberately not a check for one exact length - the
 * resolution is canvas/audio.js's business, and a board written at some other one
 * should arrive there to be rejected on its own terms rather than be thrown
 * away here. The ceiling is only so that a hand-written file cannot ask this
 * to carry a million numbers around.
 */
function isReadings(v: unknown): v is number[] {
  return Array.isArray(v) && v.length >= 2 && v.length <= 4096
    && v.every(n => typeof n === 'number' && n >= 0 && n <= 1);
}

/**
 * Every item in a just-parsed board, on the board and in the bin alike. The
 * sidecar readers all want both: a note or a waveform belonging to something
 * you threw away is still yours until the bin is emptied.
 */
function* allItems(board: FileBoard): Generator<FileItem> {
  // isRecord where this used to be a bare truthiness test. Every reader below
  // asks an object question of what comes out - a type, a hash, a meta - and a
  // string or a number in the items array answers none of them either way.
  for (const item of board.items || []) if (isRecord(item)) yield item;
  for (const t of board.trash || []) if (isRecord(t) && isRecord(t.item)) yield t.item;
}

/**
 * Read a .mbrd Blob. Registers every embedded asset in the asset store and
 * returns `{ manifest, board }` ready for state.loadBoard().
 */
export async function unpackBoard(blob: Blob) {
  const files = await readZip(blob);

  const boardBytes = files.get('board.json');
  if (!boardBytes) throw new Error('Not an .mbrd file (no board.json inside)');

  // Whatever the file says, read one key at a time. A manifest that is not an
  // object at all is the same as no manifest, which is what reading `.format`
  // off a number always came to.
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
  // Number() rather than a typeof guard, to keep the loose comparison this has
  // always made: a hand-written `"version": "2"` still warns, and every value
  // that is not a number at all is NaN, which is false against anything.
  if (Number(manifest.version) > FORMAT_VERSION) {
    console.warn('[mbrd] file was written by a newer version; loading anyway');
  }

  const board: FileBoard = JSON.parse(dec.decode(boardBytes));
  if (manifest.title && !board.title) board.title = manifest.title;

  // Notes come back from their own files, which outrank the copy in
  // board.json - see the block above packBoard's note writer.
  //
  // Keyed by whatever the file called the item, which is not necessarily a
  // string: the lookup is by the id spelled in a sidecar's filename, so an item
  // whose id is not one simply never matches.
  const notes = new Map<unknown, FileItem>();
  for (const item of allItems(board)) if (item.type === 'note') notes.set(item.id, item);
  for (const [name, bytes] of files) {
    const id = noteId(name);
    const item = id && notes.get(id);
    if (!item) continue;
    const text = parseNote(dec.decode(bytes));
    const meta: Record<string, unknown> = { ...(isRecord(item.meta) ? item.meta : null), text };
    item.meta = meta;
    // The .md outranks board.json, and meta.rich is *part of* board.json. Left
    // alone it kept winning on screen while meta.text took the edit, so a
    // hand-edited note came back showing the old words while Find matched the
    // new ones - and the next keystroke in the editor flattened the stale rich
    // back over text and destroyed the edit for good.
    //
    // Re-derived rather than dropped: the sidecar carries words, not looks, so
    // the note keeps its face, its size and its vertical placement and only the
    // blocks are rebuilt. Nothing happens when the two already agree, which is
    // every file this app wrote.
    const rich = meta.rich;
    if (isRecord(rich) && flattenNoteRich(rich) !== text) {
      meta.rich = { ...rich, blocks: parseNoteText(text) };
    }
  }

  // Waveforms the same, but one file can answer for several cards: the sidecar
  // is named after the audio, and every card holding that audio wants it.
  const waves = new Map<unknown, FileItem[]>();
  for (const item of allItems(board)) {
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
      // Nothing to fail over. The card falls back to whatever board.json gave
      // it and, failing that, to measuring the audio again - slower by a few
      // hundred milliseconds, which is the entire stake here.
      console.warn('[mbrd] unreadable waveform', name, '- will re-measure');
      continue;
    }
    for (const item of holders) item.meta = { ...(isRecord(item.meta) ? item.meta : null), peaks };
  }

  // Assets last, and strictly. Everything above reads content out of the
  // archive; this is the part that takes a name *from* the archive and lets it
  // become an identity the rest of the app trusts - so the name has to be
  // exactly the one this format defines, and the bytes have to be the ones the
  // name claims. See the HASH comment above for what the loose version cost.
  const registered = new Set<string>();
  for (const [name, bytes] of files) {
    if (!name.startsWith(ASSETS_DIR)) continue;
    const file = name.slice(ASSETS_DIR.length);
    const dot = file.lastIndexOf('.');
    const hash = dot > 0 ? file.slice(0, dot) : file;
    const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : '';
    if (!isHash(hash) || (ext && !ASSET_EXT.test(ext))) {
      throw new Error(`Not a readable .mbrd: "${name}" is not a valid asset path`);
    }
    // One hash, one file. Two entries for the same content under different
    // extensions would leave which bytes you get down to directory order.
    if (registered.has(hash)) {
      throw new Error(`Not a readable .mbrd: content ${hash.slice(0, 8)} is stored twice`);
    }
    // The name says what these bytes are; this is the only thing that checks
    // whether that is true. Without it the archive gets to choose an id
    // independently of the content, which is precisely what content addressing
    // is supposed to make impossible - and dedup, waveform sidecars and the
    // autosave sweep all key off that promise.
    if (await sha256(bytes) !== hash) {
      throw new Error(`"${name}" does not contain the data its name claims`);
    }
    registered.add(hash);
    // Copy out of the archive buffer: subarrays keep the whole ZIP alive.
    putAsset(hash, new Blob([bytes.slice()], { type: mimeFor(ext) }), { ext, mime: mimeFor(ext) });
  }

  return { manifest, board };
}

/** Cheap sniff so a wrong-extension drop fails with a useful message. */
export function looksLikeMbrd(file: File) {
  return /\.mbrd$/i.test(file.name) || file.type === MIME;
}

const ALREADY_COMPRESSED = /^(image\/(?!svg|bmp|x-)|video\/|audio\/)|zip|gzip|compressed/i;
const RAW_EXT = new Set(['bmp', 'svg', 'txt', 'md', 'json', 'csv', 'xml', 'html', 'wav', 'tif', 'tiff']);

function shouldCompress(mime: string, ext: string) {
  if (RAW_EXT.has((ext || '').toLowerCase())) return true;
  if (mime && ALREADY_COMPRESSED.test(mime)) return false;
  return true;
}

// Blob type is what drives <img>/<video>/<audio> playback, and the ZIP does not
// carry MIME types - so it is rebuilt from the extension on the way back in.
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

function mimeFor(ext: string) {
  return MIME_BY_EXT[(ext || '').toLowerCase()] || '';
}
