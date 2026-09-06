// The recovery store, as a directory of files.
//
// storage/idb.ts is a port - eight functions over four named stores - and this
// is its second implementation. `userData/store/<store>/<key>`, one file per
// key, which is why the desktop's crash snapshots and shelf survive things
// Chromium's IndexedDB partition does not: that partition is the browser's to
// evict, and app data is not.
//
// The three rules below are the contract idb.ts's own header states. Two of
// them are things this backend *cannot* do as well as a database, said out loud
// so nobody relies on them; the third is a thing it must do exactly as well,
// because something upstream depends on it.
//
// ── The batch forms may tear ──
//
// A database writes a batch in one transaction and this writes N files. A crash
// between two of them lands three of five. That is safe, and only because of an
// order somebody already argued: writeSnapshot() in session.ts writes the
// assets first, the snapshot second, and sweeps last, so a half-finished write
// is never a snapshot pointing at bytes that are not there - the worst it
// leaves is an asset nobody references yet, which is what the sweep is for.
//
// ── clear() may not tear ──
//
// This one is not covered by that argument, because the argument is about
// writes. clearAllData() drops the write latch, drains the writer, and
// *surfaces a failed wipe* rather than reloading over it - that was PERSIST-03,
// and the failure it prevents is a person being told everything was deleted
// while some of it was not.
//
// A recursive delete cannot promise that: one locked file on Windows and the
// store is half erased with no way to say so honestly. So clear() is a
// **rename**. The directory moves aside in one atomic operation and a new empty
// one takes its place; the bytes are then deleted at leisure, and a delete that
// fails leaves a `.trash-` directory rather than a half-wiped store. A clear
// that throws on the rename has not happened. One that throws after it has, and
// says so by resolving.
//
// main.ts sweeps leftover `.trash-` directories on boot, which is where a
// failed delete is eventually collected.
//
// ── Keys are lowercase, and short ──
//
// A key becomes a filename here, and two filesystems this app ships on -
// NTFS and APFS - fold case, so `Abc` and `abc` would be one file where
// IndexedDB has two. Every key the app writes today is already safe (hex
// digests out of crypto.ts, `uid()` strings, a handful of fixed names) so this
// costs nothing now; it is here for the next key somebody adds, where the
// failure would otherwise be two boards quietly sharing a row.
//
// The length cap is the other filesystem limit: a path component may not exceed
// 255 bytes on any of the three, and percent-encoding can triple a character.
// 200 encoded bytes is the ceiling, which no current key comes near.

import { app } from 'electron';
import { mkdir, readdir, readFile, rename, rm, writeFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './log.ts';
// The envelope format, split out so it can be tested with nothing installed -
// see tests/desktop-store-format.test.js. It is pure and knows nothing about
// where a file goes.
import { encode, decode } from './format.mts';

/** The four stores, spelled out because idb.ts spells them out. */
const STORES = ['kv', 'assets', 'library', 'matte'] as const;
export type StoreName = (typeof STORES)[number];

const MAX_KEY_BYTES = 200;

function root(): string {
  return join(app.getPath('userData'), 'store');
}

function dirOf(store: string): string {
  // SAFETY: the assertion is only to let a `readonly string[]` be searched for
  // an arbitrary string, and the throw on the next half of the line is what the
  // search decides. Nothing downstream sees the widened type.
  if (!STORES.includes(store as StoreName)) throw new Error('unknown store: ' + store);
  return join(root(), store);
}

/**
 * A key as a filename.
 *
 * `encodeURIComponent` and then the four characters it leaves alone that
 * Windows refuses - `*`, `?`, `<`, `>` are not in its safe set anyway, but `!`,
 * `'`, `(`, `)`, `~` are, and none of them is a problem; what is left to handle
 * is that a name may not *end* in a dot or a space on Windows, which encoding
 * does not fix. So a trailing dot is encoded too.
 */
function fileFor(store: string, key: unknown): string {
  if (typeof key !== 'string') {
    throw new Error('this store keys by string; got ' + typeof key);
  }
  if (key !== key.toLowerCase()) {
    throw new Error('keys must be lowercase here - NTFS and APFS fold case: ' + key);
  }
  const encoded = encodeURIComponent(key).replace(/\.$/, '%2E');
  if (Buffer.byteLength(encoded) > MAX_KEY_BYTES) {
    throw new Error(`key is ${Buffer.byteLength(encoded)} bytes encoded, over the ${MAX_KEY_BYTES} ceiling`);
  }
  if (!encoded) throw new Error('an empty key has no filename');
  return join(dirOf(store), encoded);
}

const keyOf = (file: string) => decodeURIComponent(file);

/**
 * Write, then move into place.
 *
 * A partial file is worse than a missing one everywhere in this store: a
 * truncated snapshot is a board that comes back wrong, where an absent one is a
 * board that comes back as it was two minutes ago. `rename` within a directory
 * is atomic on every filesystem here, so a reader sees the old bytes or the new
 * ones and never half of either.
 */
async function writeAtomic(file: string, data: Buffer | string): Promise<void> {
  const tmp = file + '.tmp';
  await writeFile(tmp, data);
  await rename(tmp, file);
}

async function readValue(file: string): Promise<unknown> {
  let raw: Buffer;
  try {
    raw = await readFile(file);
  } catch {
    // Absent is undefined, which is what idbGet() promises.
    return undefined;
  }
  try {
    return decode(raw);
  } catch (err) {
    // Present but unreadable: a truncated write from a crash, or a store
    // somebody edited by hand. Undefined is the same answer a missing key
    // gives - every caller already checks what came back - but it is worth a
    // line, because a store full of these is a different problem from an empty
    // one.
    log('warn', 'a stored value could not be read', { file, err: String(err) });
    return undefined;
  }
}

async function writeValue(file: string, value: unknown): Promise<void> {
  await writeAtomic(file, encode(value));
}

async function ensure(store: string): Promise<string> {
  const dir = dirOf(store);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function get(store: string, key: unknown): Promise<unknown> {
  await ensure(store);
  return readValue(fileFor(store, key));
}

export async function set(store: string, key: unknown, value: unknown): Promise<void> {
  await ensure(store);
  await writeValue(fileFor(store, key), value);
}

export async function del(store: string, key: unknown): Promise<void> {
  await ensure(store);
  await unlink(fileFor(store, key)).catch(() => {});
}

export async function keys(store: string): Promise<string[]> {
  await ensure(store);
  const names = await readdir(dirOf(store));
  // `.tmp` is a write that has not landed yet and is not a key. One file per
  // key, so nothing else needs filtering.
  return names.filter(n => !n.endsWith('.tmp')).map(keyOf);
}

/**
 * Empty a store, atomically. See the header: this is a rename, not a delete.
 */
export async function clear(store: string): Promise<void> {
  const dir = await ensure(store);
  const aside = `${dir}.trash-${Date.now()}`;
  // The one operation that decides whether the wipe happened. If this throws,
  // nothing moved and the caller is told - which is what clearAllData() needs
  // in order to report a failed wipe rather than reload over it.
  await rename(dir, aside);
  await mkdir(dir, { recursive: true });
  // Past this line the store *is* empty as far as anything can see, so a
  // failure here is rubbish on disk rather than data that survived a wipe. Boot
  // sweeps what is left.
  rm(aside, { recursive: true, force: true })
    .catch(err => log('warn', 'a cleared store was not deleted', { aside, err: String(err) }));
}

export async function getMany(store: string, list: unknown[]): Promise<unknown[]> {
  await ensure(store);
  return Promise.all(list.map(k => readValue(fileFor(store, k))));
}

export async function setMany(store: string, entries: [unknown, unknown][]): Promise<void> {
  await ensure(store);
  // One message in, one answer out, and the writes in parallel. The renderer
  // already treats a batch as one round trip; making it N round trips would put
  // the bridge's latency on every asset of a board.
  await Promise.all(entries.map(([k, v]) => writeValue(fileFor(store, k), v)));
}

export async function delMany(store: string, list: unknown[]): Promise<void> {
  await ensure(store);
  await Promise.all(list.map(k => del(store, k)));
}

/**
 * Collect what a failed wipe left behind. Called once at boot.
 *
 * Not urgent and not allowed to delay anything: a `.trash-` directory is bytes
 * nobody can reach, and the only cost of leaving one for a session is disk.
 */
export async function sweepTrash(): Promise<void> {
  try {
    const base = root();
    await mkdir(base, { recursive: true });
    for (const name of await readdir(base)) {
      if (!name.includes('.trash-')) continue;
      const path = join(base, name);
      // A directory rather than a file that happens to be named like one.
      if (!(await stat(path)).isDirectory()) continue;
      await rm(path, { recursive: true, force: true });
      log('info', 'collected a cleared store', { name });
    }
  } catch (err) {
    log('warn', 'could not sweep the store', err);
  }
}
