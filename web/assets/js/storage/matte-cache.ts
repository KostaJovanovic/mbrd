// Cut-out pictures, kept across reloads.
//
// canvas/display.ts makes a display copy of every picture on the board and holds
// it for the session. That is the right lifetime for a copy that costs one
// decode and one encode - a hundred milliseconds behind a thumbnail nobody
// watches - and it is the wrong lifetime for a copy that ran a neural network to
// exist. A matted card is a 320x320 pass through u2netp on the wasm backend
// (canvas/matte.ts), single-threaded and serialized against every other matted
// card, and the first one on a page also pays for fetching, parsing and
// compiling eleven megabytes of runtime. Session-only meant a board of ten
// cut-outs re-derived all ten, in order, on every single load, forever, and
// arrived at bytes identical to the ones it threw away the last time.
//
// So the matted copies - and **only** the matted ones - are written here and
// read back on the next load. The line is drawn at "did a model run": a shrunk
// or cropped or turned copy is cheap enough that persisting it would trade real
// disk against work already hidden behind the card's thumbnail, and a photo
// board's display copies are a large fraction of the board's own size again.
//
// ── The key is everything that changed the pixels ──
//
// A cache that serves the wrong picture is worse than one that misses, and every
// miss here is only slow. So the caller composes the key out of the content
// hash and a `variant` string carrying every input that moves a pixel - the
// crop, the quarter turn, the sharpness ceiling, the encoder quality, the model
// and runtime versions, and a revision it can bump by hand. That composition
// lives in canvas/display.ts, which is where those numbers are; this module
// never parses the string it is handed. The hash is passed separately, so that
// forgetMatte() can find every variant of a picture without this file having to
// know the caller's spelling.
//
// ── The index, and why the store is not enough ──
//
// IndexedDB can list keys cheaply and cannot list sizes at all, so an eviction
// policy over the store alone would have to read every Blob back to find out
// what it is holding. Instead one record under `#index` carries `{key, hash,
// bytes}` per entry, oldest first, and eviction walks it. `#` is not hex, so it
// cannot collide with a key that starts with a content hash.
//
// The index is a hint and the store is the truth, which is what makes every way
// this can go wrong self-healing:
//
//   - a blob written whose index write was lost is an orphan, and the reconcile
//     on first use deletes it;
//   - an index entry whose blob is gone is dropped on the same pass;
//   - two tabs writing the index race, and the loser's additions become orphans
//     collected next session.
//
// Nothing here ever throws. A browser in private mode, a database that will not
// open, a quota that is full: each answers "no cached copy", and the caller
// derives the picture the way it did before this file existed.

import { idbGet, idbSet, idbKeys, idbClear, idbSetMany, idbDelMany } from './idb.ts';

const STORE = 'matte';

/** The one record that is not a picture. Not hex, so no key can collide. */
const INDEX_KEY = '#index';

/**
 * The caps, and why there are two.
 *
 * A count alone would let a board of large cut-outs fill the origin's quota; a
 * byte total alone would let a thousand tiny ones make the index itself the
 * expensive thing to read. Neither number is precious - the cost of being wrong
 * is one cut-out derived again - so they are set where a working board fits
 * comfortably inside them and a year of abandoned experiments does not.
 */
const CAP_ENTRIES = 200;
const CAP_BYTES = 64 * 1024 * 1024;

/**
 * How long a read may sit on an unwritten index before it is flushed.
 *
 * A hit reorders the index and nothing else, and a board load is a burst of
 * them. Writing on each would put one transaction per card behind the mount they
 * are meant to be making cheaper, so they are coalesced into a single small
 * write - the blobs are already on disk and only their order is at stake.
 */
const FLUSH_MS = 2000;

/**
 * One cached picture, as the index knows it: its key, its origin, its size.
 *
 * Exported because evict() is, and a function whose parameter cannot be named is
 * a function nobody outside can hold correctly.
 */
export type Entry = { k: string, h: string, n: number };

/**
 * The index in memory, oldest first, or null before it has been read.
 *
 * Null and empty are different: null means the store has not been looked in yet
 * and the reconcile below still has to run, empty means it has and there is
 * nothing in it.
 */
let index: Entry[] | null = null;
let loading: Promise<Entry[]> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * The index as it was written, if it was written by a build that agrees with
 * this one.
 *
 * Anything unrecognisable reads as empty, which is not a data loss: the
 * reconcile that follows finds every blob unlisted and deletes it, so a schema
 * change here is a wipe of derived bytes and one slow board load. That is the
 * whole reason the version lives in the record rather than in the store name.
 */
function readIndex(raw: unknown): Entry[] {
  if (!raw || typeof raw !== 'object') return [];
  if (!('v' in raw) || !('list' in raw)) return [];
  if (raw.v !== 1 || !Array.isArray(raw.list)) return [];
  const rows: unknown[] = raw.list;
  const out: Entry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (!('k' in row) || !('h' in row) || !('n' in row)) continue;
    const { k, h, n } = row;
    if (typeof k !== 'string' || typeof h !== 'string') continue;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) continue;
    out.push({ k, h, n });
  }
  return out;
}

/** The index, read and reconciled against the store once per session. */
function ensureIndex(): Promise<Entry[]> {
  if (index) return Promise.resolve(index);
  if (!loading) loading = load().finally(() => { loading = null; });
  return loading;
}

async function load(): Promise<Entry[]> {
  let listed: Entry[] = [];
  try {
    listed = readIndex(await idbGet(STORE, INDEX_KEY));
    // Keys only - the point of the index is not to have to read the blobs.
    const present = new Set<string>();
    for (const key of await idbKeys(STORE)) if (typeof key === 'string') present.add(key);
    present.delete(INDEX_KEY);
    const kept: Entry[] = [];
    for (const e of listed) {
      if (!present.delete(e.k)) continue;  // listed, not there: drop the entry
      kept.push(e);
    }
    // Whatever is left in `present` is a blob nothing can reach: a write whose
    // index write never landed, or another tab's addition that this tab's index
    // overwrote. Not awaited - a board mount is waiting on this, and a
    // collection that fails simply runs again next session.
    if (present.size) void idbDelMany(STORE, [...present]).catch(() => {});
    listed = kept;
  } catch {
    // No database, no store, no permission. Every call below then works against
    // an empty list and writes that fail, which is exactly "no cache".
    listed = [];
  }
  index = listed;
  return listed;
}

/**
 * Drop the oldest entries until both caps hold, and say what was dropped.
 *
 * Mutates the list it is given, because the list *is* the index - the caller
 * writes it back in the same transaction as the picture that pushed it over.
 * Exported for tests: the arithmetic is the whole of the eviction policy, and it
 * is the one part of this module that can be checked without a database.
 *
 * The `> 1` guard keeps the entry just pushed even if it alone is over the byte
 * cap. Writing a picture and deleting it in the next breath is a cache that
 * cannot cache; a single 1280px cut-out is nowhere near this number anyway, and
 * if one ever is, the next write evicts it normally.
 */
export function evict(list: Entry[]): string[] {
  let bytes = 0;
  for (const e of list) bytes += e.n;
  const gone: string[] = [];
  while (list.length > CAP_ENTRIES || (bytes > CAP_BYTES && list.length > 1)) {
    const oldest = list.shift();
    if (!oldest) break;
    bytes -= oldest.n;
    gone.push(oldest.k);
  }
  return gone;
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flush(); }, FLUSH_MS);
}

function cancel() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
}

/** Write the order back. A failure loses the order, never a picture. */
async function flush(): Promise<void> {
  if (!index) return;
  try {
    await idbSet(STORE, INDEX_KEY, { v: 1, list: index });
  } catch { /* the order is a hint; the blobs are what matter */ }
}

/**
 * The cached cut-out for a variant, or null for anything at all going wrong.
 *
 * A hit moves the entry to the newest end, so eviction is least-recently-*used*
 * rather than least-recently-written - the difference between a board you open
 * every day surviving and it being aged out by one afternoon of experiments.
 * That reorder is only written back on the debounce above.
 */
export async function loadMatte(hash: string, variant: string): Promise<Blob | null> {
  const key = hash + variant;
  try {
    const list = await ensureIndex();
    const at = list.findIndex(e => e.k === key);
    if (at < 0) return null;
    const found = await idbGet(STORE, key);
    if (!(found instanceof Blob)) {
      // Listed and not there. Deleted under us, or written by a build that put
      // something else here. Forget it rather than ask again every mount.
      list.splice(at, 1);
      schedule();
      return null;
    }
    const [entry] = list.splice(at, 1);
    list.push(entry);
    schedule();
    return found;
  } catch {
    return null;
  }
}

/**
 * Keep a cut-out for the next load. Never throws, and never reports.
 *
 * The picture and the index go in one transaction, so a commit means both or
 * neither and the reconcile has nothing to clean up on the ordinary path. The
 * eviction that follows is separate and may fail on its own; that leaves
 * orphans, which is what the reconcile is for.
 *
 * On any failure - a full quota is the likely one - the entry is taken back out
 * of the in-memory list, so this session does not spend a read per mount asking
 * for bytes that were never written.
 */
export async function saveMatte(hash: string, variant: string, blob: Blob): Promise<void> {
  const key = hash + variant;
  const entry: Entry = { k: key, h: hash, n: blob.size };
  let list: Entry[];
  try {
    list = await ensureIndex();
  } catch {
    return;
  }
  const at = list.findIndex(e => e.k === key);
  if (at >= 0) list.splice(at, 1);
  list.push(entry);
  const doomed = evict(list);
  // The pending reorder is in the write below, so the timer has nothing left to
  // say. Cancelled after the list is final and before the await, so a flush
  // cannot fire mid-transaction and write a list this one is about to replace.
  cancel();
  try {
    await idbSetMany(STORE, [[key, blob], [INDEX_KEY, { v: 1, list }]]);
  } catch {
    const mine = list.indexOf(entry);
    if (mine >= 0) list.splice(mine, 1);
    return;
  }
  if (doomed.length) await idbDelMany(STORE, doomed).catch(() => {});
}

/**
 * Throw away every cached cut-out of these pictures.
 *
 * For emptying the bin, which is the one action that means *these bytes are
 * finished with* rather than *this card is off the board* - see forgetAssets()
 * in storage/assets.ts. A cut-out is the picture with its background taken off,
 * so leaving one behind after the original was deleted is leaving the picture
 * behind, and that is the half a derived cache is easiest to get wrong.
 */
export async function forgetMatte(hashes: Iterable<string>): Promise<void> {
  const doomed = new Set(hashes);
  if (!doomed.size) return;
  let list: Entry[];
  try {
    list = await ensureIndex();
  } catch {
    return;
  }
  const gone: string[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (!doomed.has(list[i].h)) continue;
    gone.push(list[i].k);
    list.splice(i, 1);
  }
  if (!gone.length) return;
  cancel();
  // The blobs first. The index is only a way of finding them, so an index write
  // that lands without the deletes would leave the pictures on disk and unlisted
  // - reachable by nothing, but still there, which is the one outcome this
  // function exists to prevent.
  try {
    await idbDelMany(STORE, gone);
    await idbSet(STORE, INDEX_KEY, { v: 1, list });
  } catch { /* they go with the next reconcile, or the next clear */ }
}

/**
 * Every cached cut-out, gone.
 *
 * Called by clearSession() beside the `kv` and `assets` wipes, which puts it on
 * both New and Clear everything. New does not strictly need it - these are
 * derived bytes for assets that wipe names - but Clear everything does, and it
 * must not be the kind of thing somebody has to remember: a cut-out of a
 * photograph left in this browser after the person asked for everything gone is
 * that photograph, still here.
 *
 * Unlike everything else in this module it lets a failure through, because its
 * caller is the one that must not paper over a failed wipe. The in-memory list
 * is emptied first either way: if the clear did not commit, the blobs are
 * unlisted rather than unwritten, and the next session's reconcile deletes them.
 */
export async function clearMatteCache(): Promise<void> {
  cancel();
  index = [];
  await idbClear(STORE);
}
