// In-memory asset registry: content hash -> blob + lazy object URL.
// Items reference assets by hash only; all actual data lookups go through here,
// giving free content-based dedup.

import { sha256 } from '../crypto.ts';
import { extOf } from '../util.ts';

// `url` is null until assetURL() mints it, and null again after pagehide revokes it.
export type Asset = {
  blob: Blob,
  url: string | null,
  mime: string,
  ext: string,
  size: number,
  name: string,
};

type AssetMeta = Partial<Pick<Asset, 'mime' | 'ext' | 'name'>>;

const store = new Map<string, Asset>();

// Accepts null/undefined so callers can pass item.asset?.hash directly.
export function getAsset(hash: string | null | undefined) {
  return store.get(hash as string); // SAFETY: miss on null/undefined is the desired result
}
export function allAssets() { return store; }

// Total bytes in memory (pre-deflate) and file count.
export function assetBytes() {
  let bytes = 0;
  for (const a of store.values()) bytes += a.size;
  return { bytes, count: store.size };
}

// Object URL for an asset, created on first call and reused after.
export function assetURL(hash: string): string | null {
  const a = store.get(hash);
  if (!a) return null;
  if (!a.url) a.url = URL.createObjectURL(a.blob);
  return a.url;
}

// Register a blob under a known hash (used by .mbrd unpack).
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

// Hash a File/Blob and register it. Same bytes -> same hash.
export async function addFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await sha256(buf);
  if (!store.has(hash)) {
    const ext = extOf(file.name);
    // SVG blob URLs need an explicit MIME or <img> will not render them.
    const mime = file.type || (ext === 'svg' ? 'image/svg+xml' : '');
    // slice() relabels the MIME without copying bytes (unlike new Blob([buf])).
    putAsset(hash, mime === file.type ? file : file.slice(0, file.size, mime), {
      mime,
      ext,
      name: file.name,
    });
  }
  return hash;
}

// Wrap a derived picture blob as a correctly-typed File.
// The MIME must match the actual encoding or blob-URL <img> will not render
// (Safari never encodes WebP, so it hands back PNG with no type).
export function derivedFile(blob: Blob, stem: string): File {
  const type = /^image\/[a-z0-9.+-]+$/i.test(blob.type) ? blob.type.toLowerCase() : 'image/webp';
  return new File([blob], `${stem}.${type.slice('image/'.length)}`, { type });
}

// Read an asset as text (used by the text renderer).
export async function readText(hash: string, limit = 20000): Promise<string> {
  const a = store.get(hash);
  if (!a) return '';
  const slice = a.blob.size > limit ? a.blob.slice(0, limit) : a.blob;
  return slice.text();
}

// Drop everything and revoke all object URLs (board close/open).
export function clearAssets() {
  for (const a of store.values()) if (a.url) URL.revokeObjectURL(a.url);
  store.clear();
}

// Deleted items keep their assets for undo; clearAssets() frees them on board close.

// Remove specific assets (bin empty). Returns hash -> size for the tombstone.
// Called via main.ts injection because storage/ cannot be imported from the base layer.
export function forgetAssets(hashes: Iterable<string>): Map<string, number> {
  const freed = new Map<string, number>();
  for (const hash of hashes) {
    const a = store.get(hash);
    if (!a) continue;
    // Revoke before delete or the URL outlives its only reference.
    if (a.url) URL.revokeObjectURL(a.url);
    freed.set(hash, a.size);
    store.delete(hash);
  }
  return freed;
}

// Revoke object URLs on real pagehide (not bfcache).
// Skips persisted hides: revoking into bfcache breaks every <img> on restore.
// Registered from main.ts to keep this module loadable outside a browser.
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
