// What is inside an archive dropped on the board: ZIP, TAR, gzip, 7z and RAR,
// read into one flat list of files and their paths. ZIP goes through the
// bounds-checked reader in storage/zip.ts and TAR through the one below; gzip
// through the browser's own DecompressionStream; 7z, RAR and any ZIP the hand
// reader refuses through the vendored libarchive.js, loaded on the first archive
// that needs it. A ceiling throws Oversize (consent.ts) for the caller to lift.

import { extOf } from '../util.ts';
import { oversize, isOversize, mb } from '../consent.ts';
import { readZip, LIMITS } from '../storage/zip.ts';

/** One file out of an archive: where it sat, and its bytes. */
export type ArchiveFile = { path: string, data: Blob };

/** One thing at one level of a tree, in the order it first appears. */
export type Child =
  | { kind: 'file', path: string, name: string }
  | { kind: 'folder', path: string, name: string, count: number };

const td = new TextDecoder();

/** Leaves an archive carries for the system that made it, not for the person. */
const JUNK = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

/**
 * A path out of an archive, made plain: forward slashes, no leading slash or
 * drive, no `.` segments. Null for a path that climbs (`..`) and for the
 * files macOS and Windows leave behind, which nobody put in on purpose.
 */
export function cleanPath(raw: string): string | null {
  const parts = raw.replace(/\\/g, '/').replace(/^[a-z]:/i, '')
    .split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.includes('..') || parts.includes('__MACOSX')) return null;
  const leaf = parts[parts.length - 1];
  if (JUNK.has(leaf.toLowerCase()) || leaf.startsWith('._')) return null;
  return parts.join('/');
}

/**
 * What sits directly under `prefix` (`''`, or a folder path ending in `/`):
 * each file there, and each folder once, with the count of files anywhere
 * under it. In the order each first appears, which is the archive's own.
 */
export function children(paths: string[], prefix = ''): Child[] {
  const out: Child[] = [];
  const folders = new Map<string, { kind: 'folder', path: string, name: string, count: number }>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const cut = rest.indexOf('/');
    if (cut < 0) {
      if (rest) out.push({ kind: 'file', path, name: rest });
      continue;
    }
    const name = rest.slice(0, cut);
    let folder = folders.get(name);
    if (!folder) {
      folder = { kind: 'folder', path: `${prefix}${name}/`, name, count: 0 };
      folders.set(name, folder);
      out.push(folder);
    }
    folder.count++;
  }
  return out;
}

/**
 * Every file in an archive, by the extension of `name`. Paths are cleaned
 * (cleanPath()), and a path written twice keeps its last bytes - how a TAR
 * records an update - in the place it first appeared.
 */
export async function readArchive(file: Blob, name: string, lift = false): Promise<ArchiveFile[]> {
  if (!lift && file.size > LIMITS.archive) {
    throw oversize('archive-bytes',
      `This archive is ${mb(file.size)}, past the ${mb(LIMITS.archive)} one is normally opened at.`);
  }
  const ext = extOf(name);
  let files: ArchiveFile[];
  if (ext === 'zip') files = await readZipFiles(file, name, lift);
  else if (ext === 'tar') files = await readTar(file, lift);
  else if (ext === 'gz' || ext === 'tgz') files = await readGzip(file, name, lift);
  else if (ext === '7z' || ext === 'rar') files = await readLibarchive(file, name, lift);
  else throw new Error(`${name} is not an archive this can open`);
  const kept = new Map<string, Blob>();
  for (const { path, data } of files) {
    const clean = cleanPath(path);
    if (clean) kept.set(clean, data);
  }
  return [...kept].map(([path, data]) => ({ path, data }));
}

async function readZipFiles(file: Blob, name: string, lift: boolean): Promise<ArchiveFile[]> {
  try {
    const entries = await readZip(file, { lift });
    return [...entries].map(([path, data]) => ({ path, data: new Blob([data]) }));
  } catch (err) {
    // A ceiling is a question for the caller. Anything else may be a ZIP the
    // hand reader does not take - ZIP64, or a method other than deflate -
    // and libarchive reads those. When it cannot either, the first reason
    // is the one worth showing.
    if (isOversize(err)) throw err;
    try {
      return await readLibarchive(file, name, lift);
    } catch {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// TAR
// ---------------------------------------------------------------------------

const BLOCK = 512;
/** A GNU long name or a pax header is a path, not content. */
const META_MAX = 1 << 20;

/** A NUL-terminated field of a header. */
function field(h: Uint8Array, at: number, len: number) {
  const raw = h.subarray(at, at + len);
  const end = raw.indexOf(0);
  return td.decode(end < 0 ? raw : raw.subarray(0, end));
}

/** An octal number field, or GNU base-256 when its first byte has the high bit. */
function octal(h: Uint8Array, at: number, len: number, what: string) {
  if (h[at] & 0x80) {
    let n = h[at] & 0x7f;
    for (let i = 1; i < len; i++) n = n * 256 + h[at + i];
    if (!Number.isSafeInteger(n)) throw new Error(`Corrupt archive: ${what} is too large to be real`);
    return n;
  }
  const text = field(h, at, len).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error(`Corrupt archive: ${what} is not a number`);
  return text ? parseInt(text, 8) : 0;
}

/** The header checksum: every byte summed, with its own field read as spaces. */
function checksumOk(h: Uint8Array) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  return sum === octal(h, 148, 8, 'a header checksum');
}

/** The value of one key in a pax extended header (`<len> key=value\n` records). */
function paxValue(text: string, key: string) {
  for (const record of text.split('\n')) {
    const m = /^\d+ ([^=]+)=(.*)$/.exec(record);
    if (m && m[1] === key) return m[2];
  }
  return null;
}

/**
 * The files in a TAR, each a slice of the archive rather than a copy. Every
 * size is checked against the end of the file before it is used, and each
 * header against its checksum, so a truncated or crafted archive is refused
 * rather than read short. Directories, links and devices are skipped.
 */
export async function readTar(file: Blob, lift = false): Promise<ArchiveFile[]> {
  const out: ArchiveFile[] = [];
  let p = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (p + BLOCK <= file.size) {
    const h = new Uint8Array(await file.slice(p, p + BLOCK).arrayBuffer());
    // Two zero blocks end the archive; one is enough to stop reading.
    if (h.every(b => b === 0)) break;
    if (!checksumOk(h)) throw new Error('Corrupt archive: a header fails its checksum');
    const size = octal(h, 124, 12, 'an entry size');
    const start = p + BLOCK;
    if (start + size > file.size) throw new Error('Corrupt archive: an entry runs past the end of the file');
    // A NUL type is a file written before the type byte had letters.
    const type = String.fromCharCode(h[156] || 48);
    if (type === 'L' || type === 'x') {
      if (size > META_MAX) throw new Error('Corrupt archive: a header names a path longer than any file has');
      const text = td.decode(new Uint8Array(await file.slice(start, start + size).arrayBuffer()));
      if (type === 'L') longName = text.replace(/\0+$/, '');
      else paxPath = paxValue(text, 'path');
    } else {
      if (type === '0' || type === '7') {
        if (!lift && out.length >= LIMITS.entries) {
          throw oversize('archive-entries',
            `This archive holds more than ${LIMITS.entries.toLocaleString()} files, past what one is normally opened with.`);
        }
        const base = field(h, 0, 100);
        const prefix = field(h, 257, 6).startsWith('ustar') ? field(h, 345, 155) : '';
        const path = paxPath ?? longName ?? (prefix ? `${prefix}/${base}` : base);
        out.push({ path, data: file.slice(start, start + size) });
      }
      // A long name or a pax path belongs to the one entry after it.
      longName = null;
      paxPath = null;
    }
    p = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

// ---------------------------------------------------------------------------
// gzip
// ---------------------------------------------------------------------------

/**
 * A gzip stream, inflated with a ceiling on what comes out. Streamed so the
 * ceiling stops the inflate itself, rather than judging it after it is paid.
 */
async function gunzip(file: Blob, name: string, lift: boolean): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack gzip');
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (!lift && n > LIMITS.total) {
        throw oversize('inflated-bytes',
          `${name} unpacks to more than ${mb(LIMITS.total)}, past what is opened at once.`);
      }
      if (!lift && n > LIMITS.ratioFloor && n / Math.max(1, file.size) > LIMITS.ratio) {
        throw oversize('entry-ratio',
          `${name} is ${mb(file.size)} packed and unpacks past ${mb(n)} - it expands `
          + `${Math.round(n / Math.max(1, file.size))} times over.`);
      }
      parts.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (isOversize(err)) throw err;
    throw new Error(`${name} is not gzip, or it is damaged`);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** A `.tar.gz` or `.tgz` is a TAR inside; any other `.gz` is one file. */
async function readGzip(file: Blob, name: string, lift: boolean): Promise<ArchiveFile[]> {
  const bytes = await gunzip(file, name, lift);
  const blob = new Blob([bytes]);
  const inner = /\.tgz$/i.test(name) ? name.replace(/\.tgz$/i, '.tar') : name.replace(/\.gz$/i, '');
  const ustar = bytes.length > 262 && td.decode(bytes.subarray(257, 262)) === 'ustar';
  if (extOf(inner) === 'tar' || ustar) return readTar(blob, lift);
  return [{ path: inner.split(/[\\/]/).pop() || 'file', data: blob }];
}

// ---------------------------------------------------------------------------
// 7z and RAR, through libarchive.js
// ---------------------------------------------------------------------------

// Exported for tests/archive-vendor.test.js to hold against the shipped files.
export const LIBARCHIVE_VERSION = '2.0.2';
const LIB_DIR = './assets/vendor/libarchive/';
// Named here rather than in a Worker() call so tests/csp.test.js reads the one
// path _headers exempts: the worker compiles libarchive.wasm, which the page's
// policy does not allow.
const WORKER_URL = './assets/vendor/libarchive/worker-bundle.js';

/** Against document.baseURI, so import() and the worker agree on the path. */
const libURL = (path: string) => new URL(path, document.baseURI).href;

/** One entry as the library's worker lists it. */
type LibEntry = { path?: unknown, type?: unknown, size?: unknown, fileData?: unknown };
/** The part of the library's reader used here. */
type LibReader = {
  client: { listFiles(): Promise<LibEntry[]>, extractFiles(): Promise<LibEntry[]> },
  close(): Promise<void>,
};
type LibArchive = { Archive: { open(file: File): Promise<LibReader> } };

let lib: Promise<LibArchive> | null = null;

function loadLib(): Promise<LibArchive> {
  lib ??= import(/* @vite-ignore */ libURL(LIB_DIR + 'libarchive.js')).then(mod => {
    mod.Archive.init({ workerUrl: libURL(WORKER_URL) });
    return mod;
  });
  // A failed load is not remembered, so the next archive tries again.
  lib.catch(() => { lib = null; });
  return lib;
}

/**
 * Every file in an archive libarchive reads. Its worker's flat list is used,
 * not the reader's tree: the tree is built by assigning each path segment as
 * a key of a plain object, so an entry named `__proto__/x` would write onto
 * Object.prototype in this page. The list is checked against the ceilings
 * before anything is extracted.
 */
async function readLibarchive(file: Blob, name: string, lift: boolean): Promise<ArchiveFile[]> {
  const { Archive } = await loadLib();
  const archive = await Archive.open(file instanceof File ? file : new File([file], name));
  try {
    const listed = (await archive.client.listFiles()).filter(e => e.type === 'FILE');
    if (!lift && listed.length > LIMITS.entries) {
      throw oversize('archive-entries',
        `This archive holds ${listed.length.toLocaleString()} files, past the ${LIMITS.entries.toLocaleString()} one is normally opened with.`);
    }
    let total = 0;
    for (const entry of listed) {
      const size = Number(entry.size) || 0;
      if (!lift && size > LIMITS.entry) {
        throw oversize('entry-bytes',
          `"${String(entry.path)}" inside this archive is ${mb(size)} unpacked, past the ${mb(LIMITS.entry)} one file is normally given.`);
      }
      total += size;
    }
    if (!lift && total > LIMITS.total) {
      throw oversize('inflated-bytes',
        `This archive unpacks to ${mb(total)}, past the ${mb(LIMITS.total)} opened at once.`);
    }
    const out: ArchiveFile[] = [];
    for (const entry of await archive.client.extractFiles()) {
      if (entry.type !== 'FILE' || typeof entry.path !== 'string') continue;
      // Each entry's bytes arrive in a buffer of their own, copied off the wasm heap.
      const data = entry.fileData;
      const bytes = data instanceof ArrayBuffer ? data
        : data instanceof Uint8Array && data.buffer instanceof ArrayBuffer
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : null;
      if (bytes) out.push({ path: entry.path, data: new Blob([bytes]) });
    }
    return out;
  } finally {
    await archive.close();
  }
}
