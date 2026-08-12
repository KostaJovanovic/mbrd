// @ts-nocheck - TypeScript migration debt, not a judgement about this file.
//
// The tree was renamed from .js to .ts mechanically, which moved 104 modules in
// one step and annotated none of them. This module is carried unchecked so that
// npm run typecheck stays green and keeps meaning something, rather than going
// red and being ignored. Converting this module IS deleting this block and
// fixing what tsc then says - tests/ts-debt.test.js holds the count and lets it
// only fall.
// In-memory asset registry: content hash -> bytes + a lazily-created object URL.
//
// Items never hold a Blob or a URL, only `{ hash, embedded: true }`. Everything
// that needs the actual data (renderers, the .mbrd packer, IndexedDB autosave)
// comes through here, which is what makes dedupe-by-content free: the same photo
// dropped twice is one entry and one object URL.

import { sha256 } from '../crypto.ts';
import { extOf } from '../util.ts';

/** hash -> { blob, url, mime, ext, size, name } */
const store = new Map();

export function getAsset(hash) { return store.get(hash); }
export function allAssets() { return store; }

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
    const ext = extOf(file.name);
    // An <img> renders a blob: URL by the blob's own MIME, and an SVG served with
    // an empty type does not render at all. Some sources hand an .svg over with
    // no File.type, so it is inferred from the extension here - narrowly, for the
    // one format where the type is load-bearing rather than a hint.
    const mime = file.type || (ext === 'svg' ? 'image/svg+xml' : '');
    putAsset(hash, new Blob([buf], { type: mime }), {
      mime,
      ext,
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

/**
 * Release the object URLs when the document goes away.
 *
 * They die with the document anyway; this is for the long-lived PWA session -
 * open all day, several boards - where nothing else would ever hand them back.
 *
 * `persisted` is the whole subtlety. A pagehide that reports it is going into
 * the back/forward cache is not a teardown at all: the document is frozen with
 * its DOM intact and may be handed back whole, every <img> still pointing at
 * the blob: URL it was built with. Revoking on the way into that cache breaks
 * every one of them, and the breakage only shows up on the way *back*, which
 * is the hardest place to notice it. So a persisted hide releases nothing.
 *
 * When it is a real teardown the URLs go, and the cached string goes with
 * them. Leaving a revoked URL in the entry would make assetURL() keep handing
 * out a dead address for the rest of the session, since it only mints a new
 * one when the field is empty - which is the same broken picture by a slower
 * route.
 *
 * Registered from main.js rather than on import: a module that reaches for a
 * browser global the moment it loads cannot be loaded anywhere else, and this
 * one is imported by state.js and so by everything.
 */
export function initAssets() {
  addEventListener('pagehide', event => {
    if (event.persisted) return;
    for (const a of store.values()) {
      if (!a.url) continue;
      URL.revokeObjectURL(a.url);
      a.url = null;
    }
  });
}
