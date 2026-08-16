// In-memory asset registry: content hash -> bytes + a lazily-created object URL.
//
// Items never hold a Blob or a URL, only `{ hash, embedded: true }`. Everything
// that needs the actual data (renderers, the .mbrd packer, IndexedDB autosave)
// comes through here, which is what makes dedupe-by-content free: the same photo
// dropped twice is one entry and one object URL.

import { sha256 } from '../crypto.ts';
import { extOf } from '../util.ts';

/**
 * One registered asset: the bytes, and the object URL once something has asked
 * for one.
 *
 * `url` is null until assetURL() mints it and null again after a real pagehide
 * revokes it - see initAssets(), where the difference between "never made one"
 * and "made one and it is dead" is the whole point of writing the field back.
 */
export type Asset = {
  blob: Blob,
  url: string | null,
  mime: string,
  ext: string,
  size: number,
  name: string,
};

/** What a caller may say about an asset that the blob itself does not carry. */
type AssetMeta = Partial<Pick<Asset, 'mime' | 'ext' | 'name'>>;

/** hash -> { blob, url, mime, ext, size, name } */
const store = new Map<string, Asset>();

/**
 * The asset registered under a hash, or undefined for one that is not here.
 *
 * The parameter admits the two spellings of "no hash" because that is how it is
 * called: `getAsset(item.asset?.hash)` for an item that may carry no asset, and
 * `getAsset(thumbSource(it))` for a lookup that answers null. "There is nothing
 * under that hash" is the answer both want.
 *
 * SAFETY: a Map lookup does not care what it is handed - a key that cannot be
 * in the map finds nothing, which is the same undefined a missing hash gives.
 * The cast only satisfies the signature; nothing is written through it.
 */
export function getAsset(hash: string | null | undefined) {
  // SAFETY: see above.
  return store.get(hash as string);
}
export function allAssets() { return store; }

/**
 * How much the registry is holding, and in how many files.
 *
 * A total rather than a map, because the only question anybody asks of the whole
 * store is how big it is - the Debug fold's "what this board weighs" row, and
 * nothing else. Callers had to reduce over allAssets() to get it, which is the
 * same three lines written at the call site and one more place that has to know
 * an Asset carries `size`.
 *
 * `size` is the blob's own length, so this is the bytes on disk before the ZIP
 * deflates them - which is the honest number for "what is in memory", and an
 * over-estimate of what a saved .mbrd will weigh.
 */
export function assetBytes() {
  let bytes = 0;
  for (const a of store.values()) bytes += a.size;
  return { bytes, count: store.size };
}

/** Object URL for an asset, created on first use and reused after. */
export function assetURL(hash: string): string | null {
  const a = store.get(hash);
  if (!a) return null;
  if (!a.url) a.url = URL.createObjectURL(a.blob);
  return a.url;
}

/** Register a blob under a known hash (used when unpacking a .mbrd). */
export function putAsset(hash: string, blob: Blob, meta: AssetMeta = {}): Asset {
  const existing = store.get(hash);
  if (existing) return existing;
  const entry: Asset = {
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
export async function addFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await sha256(buf);
  if (!store.has(hash)) {
    const ext = extOf(file.name);
    // An <img> renders a blob: URL by the blob's own MIME, and an SVG served with
    // an empty type does not render at all. Some sources hand an .svg over with
    // no File.type, so it is inferred from the extension here - narrowly, for the
    // one format where the type is load-bearing rather than a hint.
    const mime = file.type || (ext === 'svg' ? 'image/svg+xml' : '');
    // `file.slice()` rather than `new Blob([buf])`, and the difference is a whole
    // second copy of the file in memory. What arrived is already a Blob; the only
    // reason a new one was ever built is the `mime` above, which sometimes has to
    // differ from the File's own - and slice() with a content type is exactly
    // "the same bytes, relabelled", with no copy. It matters here rather than
    // anywhere: six imports run at once and each one is holding `buf` already.
    putAsset(hash, mime === file.type ? file : file.slice(0, file.size, mime), {
      mime,
      ext,
      name: file.name,
    });
  }
  return hash;
}

/** Read an asset back as text - used by the text renderer. */
export async function readText(hash: string, limit = 20000): Promise<string> {
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
