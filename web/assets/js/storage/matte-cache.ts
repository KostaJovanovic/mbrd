// Cache for matted (cut-out) display copies — the u2netp run is expensive.
// Key = content hash + variant string. Index enables eviction without
// reading every blob. Nothing throws; quota full = cache miss.

import { idbGet, idbSet, idbKeys, idbClear, idbSetMany, idbDelMany } from './idb.ts';

const STORE = 'matte';

/** The one record that is not a picture. Not hex, so no key can collide. */
const INDEX_KEY = '#index';

/** Count cap + byte cap together: count alone risks quota, bytes alone risks
 *  an index too large to read cheaply. Both are generous — a miss just re-derives. */
const CAP_ENTRIES = 200;
const CAP_BYTES = 64 * 1024 * 1024;

/** Debounce for index reorder writes. Hits come in bursts at board load;
 *  coalescing avoids one IDB transaction per card. Only order is at stake. */
const FLUSH_MS = 2000;

/** One index entry: key, content hash, byte size. Exported for evict(). */
export type Entry = { k: string, h: string, n: number };

/** In-memory index, oldest first. null = not yet loaded (reconcile pending);
 *  [] = loaded and empty. */
let index: Entry[] | null = null;
let loading: Promise<Entry[]> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Parse a stored index record. Unrecognised shape → empty (reconcile wipes
 *  the orphaned blobs, so a schema change just costs one slow board load). */
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
    // Keys only — never read the blobs for reconciliation.
    const present = new Set<string>();
    for (const key of await idbKeys(STORE)) if (typeof key === 'string') present.add(key);
    present.delete(INDEX_KEY);
    const kept: Entry[] = [];
    for (const e of listed) {
      if (!present.delete(e.k)) continue;  // listed, not there: drop the entry
      kept.push(e);
    }
    // Orphaned blobs (write landed, index write didn't). Not awaited — a
    // board mount is waiting and a failed cleanup retries next session.
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

/** Evict oldest entries until both caps hold. Mutates in place (it *is* the
 *  index). Exported for tests. The `> 1` guard keeps the just-pushed entry
 *  even if it alone exceeds the byte cap — avoids write-then-delete. */
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

/** Cached cut-out, or null. A hit promotes the entry to newest (LRU, not
 *  LRW) — a daily board survives experiments. Reorder flushed on debounce. */
export async function loadMatte(hash: string, variant: string): Promise<Blob | null> {
  const key = hash + variant;
  try {
    const list = await ensureIndex();
    const at = list.findIndex(e => e.k === key);
    if (at < 0) return null;
    const found = await idbGet(STORE, key);
    if (!(found instanceof Blob)) {
      // Gone under us — forget it rather than retry every mount.
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

/** Persist a cut-out. Blob + index in one transaction; eviction is separate.
 *  On failure (likely quota), the in-memory entry is removed so we don't
 *  re-read a blob that was never written. Never throws. */
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
  // Cancel debounced flush — this write subsumes it, and a flush mid-transaction
  // would race with the index we're about to write.
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

/** Remove all cached cut-outs for these content hashes (bin-empty path).
 *  A cut-out *is* the picture minus background — must not outlive the original. */
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
  // Blobs first — an index-only write would leave pictures on disk unreachable
  // but present, which is the outcome this function exists to prevent.
  try {
    await idbDelMany(STORE, gone);
    await idbSet(STORE, INDEX_KEY, { v: 1, list });
  } catch { /* they go with the next reconcile, or the next clear */ }
}

/** Wipe every cached cut-out. Lets failures through (unlike the rest of this
 *  module) because the caller must not paper over a failed wipe. In-memory
 *  list cleared first so reconcile catches uncommitted blobs next session. */
export async function clearMatteCache(): Promise<void> {
  cancel();
  index = [];
  await idbClear(STORE);
}
