// File-backed store mirroring idb.ts's four stores. One file per key
// under userData/store/. Survives eviction Chromium's IndexedDB does not.
// clear() is atomic (rename, not recursive delete). Keys lowercase/short.

import { app } from 'electron';
import { mkdir, readdir, readFile, rename, rm, writeFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './log.ts';
// Pure envelope format, split out for testing without Electron.
import { encode, decode } from './format.mts';

/** The four stores, spelled out because idb.ts spells them out. */
const STORES = ['kv', 'assets', 'library', 'matte'] as const;
export type StoreName = (typeof STORES)[number];

const MAX_KEY_BYTES = 200;

function root(): string {
  return join(app.getPath('userData'), 'store');
}

function dirOf(store: string): string {
  // SAFETY: widened for the includes() lookup only; a name outside STORES throws here.
  if (!STORES.includes(store as StoreName)) throw new Error('unknown store: ' + store);
  return join(root(), store);
}

/** Key → filename. Percent-encoded, plus trailing dot (Windows forbids it). */
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

/** Write to .tmp then rename — atomic within a directory. A truncated file is
 * worse than a missing one (missing = last snapshot; truncated = corruption). */
async function writeAtomic(file: string, data: Uint8Array | string): Promise<void> {
  const tmp = file + '.tmp';
  await writeFile(tmp, data);
  await rename(tmp, file);
}

async function readValue(file: string): Promise<unknown> {
  let raw: Buffer;
  try {
    raw = await readFile(file);
  } catch {
    // Absent → undefined (matches idbGet contract).
    return undefined;
  }
  try {
    return decode(raw);
  } catch (err) {
    // Unreadable (crash truncation, hand-edit). Log so a store full of these
    // is visible; return undefined like a missing key.
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
  // .tmp files are in-flight writes, not keys.
  return names.filter(n => !n.endsWith('.tmp')).map(keyOf);
}

/** Empty a store atomically via rename (see header). */
export async function clear(store: string): Promise<void> {
  const dir = await ensure(store);
  const aside = `${dir}.trash-${Date.now()}`;
  // Atomic: if rename throws, nothing moved and the caller knows.
  await rename(dir, aside);
  await mkdir(dir, { recursive: true });
  // Delete at leisure — failure leaves rubbish, not surviving data. Boot sweeps.
  rm(aside, { recursive: true, force: true })
    .catch(err => log('warn', 'a cleared store was not deleted', { aside, err: String(err) }));
}

export async function getMany(store: string, list: unknown[]): Promise<unknown[]> {
  await ensure(store);
  return Promise.all(list.map(k => readValue(fileFor(store, k))));
}

export async function setMany(store: string, entries: [unknown, unknown][]): Promise<void> {
  await ensure(store);
  // Writes in parallel — the renderer treats a batch as one round trip.
  await Promise.all(entries.map(([k, v]) => writeValue(fileFor(store, k), v)));
}

export async function delMany(store: string, list: unknown[]): Promise<void> {
  await ensure(store);
  await Promise.all(list.map(k => del(store, k)));
}

/** Sweep .trash-* directories left by a failed wipe. Called once at boot. */
export async function sweepTrash(): Promise<void> {
  try {
    const base = root();
    await mkdir(base, { recursive: true });
    for (const name of await readdir(base)) {
      if (!name.includes('.trash-')) continue;
      const path = join(base, name);
      // Must be a directory, not a file.
      if (!(await stat(path)).isDirectory()) continue;
      await rm(path, { recursive: true, force: true });
      log('info', 'collected a cleared store', { name });
    }
  } catch (err) {
    log('warn', 'could not sweep the store', err);
  }
}
