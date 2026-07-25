// In-memory asset registry: content hash -> bytes + a lazily-created object URL.
//
// Items never hold a Blob or a URL, only `{ hash, embedded: true }`. Everything
// that needs the actual data (renderers, the .mbrd packer, IndexedDB autosave)
// comes through here, which is what makes dedupe-by-content free: the same photo
// dropped twice is one entry and one object URL.

import { sha256, extOf } from '../util.js';

/** hash -> { blob, url, mime, ext, size, name } */
const store = new Map();

export function hasAsset(hash) { return store.has(hash); }
export function getAsset(hash) { return store.get(hash); }
export function allAssets() { return store; }
export function assetCount() { return store.size; }

/** Object URL for an asset, created on first use and reused after. */
export function assetURL(hash) {
  const a = store.get(hash);
  if (!a) return null;
  if (!a.url) a.url = URL.createObjectURL(a.blob);
  return a.url;
}

/** Register a blob under a known hash (used when unpacking a .mbrd). */
export function putAsset(hash, blob, meta = {}) {
  const existing = store.get(hash);
  if (existing) return existing;
  const entry = {
    blob,
    url: null,
    mime: meta.mime || blob.type || 'application/octet-stream',
    ext: meta.ext || '',
    size: blob.size,
    name: meta.name || '',
  };
  store.set(hash, entry);
  return entry;
}

/** Hash a File/Blob and register it. Returns the hash (same bytes -> same hash). */
export async function addFile(file) {
  const buf = await file.arrayBuffer();
  const hash = await sha256(buf);
  if (!store.has(hash)) {
    putAsset(hash, new Blob([buf], { type: file.type || '' }), {
      mime: file.type || '',
      ext: extOf(file.name),
      name: file.name,
    });
  }
  return hash;
}

/** Read an asset back as text - used by the text renderer. */
export async function readText(hash, limit = 20000) {
  const a = store.get(hash);
  if (!a) return '';
  const slice = a.blob.size > limit ? a.blob.slice(0, limit) : a.blob;
  return slice.text();
}

/** Drop everything and release the object URLs (board close / open). */
export function clearAssets() {
  for (const a of store.values()) if (a.url) URL.revokeObjectURL(a.url);
  store.clear();
}

// Deleted items keep their assets alive on purpose: undo has to be able to put
// the item back, and a save only ever writes the hashes the live items still
// reference. Assets are released wholesale by clearAssets() on board close.

// Object URLs die with the document anyway, but revoking on unload keeps
// long-lived PWA sessions (open all day, many boards) from leaking.
addEventListener('pagehide', () => {
  for (const a of store.values()) if (a.url) URL.revokeObjectURL(a.url);
});
