// The .mbrd container: a ZIP holding a manifest, the board, and every asset's
// bytes, so a board is one self-contained file you can email or drop back in.
//
//   myboard.mbrd            (ZIP, renamed)
//   |- manifest.json        { format, version, app, created, modified, title }
//   |- board.json           { view, settings, arrangement, items[] }
//   |- assets/<hash>.<ext>  embedded bytes, deduped by content hash
//   \- thumbnails/<hash>.webp   (reserved; not written yet)
//
// Items reference bytes as `asset: { hash, embedded: true }`. The schema also
// reserves `asset: { external: { path } }` for a later link-instead-of-embed
// setting - unpack tolerates it, pack simply has no bytes to write for it.

import { writeZip, readZip } from './zip.js';
import { getAsset, putAsset } from './assets.js';
import { VERSION } from '../version.js';

export const FORMAT = 'mbrd';
export const FORMAT_VERSION = 1;
export const MIME = 'application/vnd.mbrd+zip';

const enc = new TextEncoder();
const dec = new TextDecoder();
const json = obj => enc.encode(JSON.stringify(obj, null, 2));

/**
 * Pack a serialised board plus the assets it references into a .mbrd Blob.
 * Only hashes still referenced by an item are written, so deleting an item and
 * saving actually shrinks the file.
 */
export async function packBoard(boardData, { created = null } = {}) {
  const now = new Date();
  const manifest = {
    format: FORMAT,
    version: FORMAT_VERSION,
    app: 'mbrd ' + VERSION,
    created: created || now.toISOString(),
    modified: now.toISOString(),
    title: boardData.title || 'Untitled board',
  };

  const entries = [
    { name: 'manifest.json', data: json(manifest), compress: true },
    { name: 'board.json', data: json(boardData), compress: true },
  ];

  const seen = new Set();
  for (const item of boardData.items) {
    const hash = item.asset?.hash;
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    const asset = getAsset(hash);
    if (!asset) {
      console.warn('[mbrd] missing bytes for asset', hash, '- skipping');
      continue;
    }
    const ext = asset.ext ? '.' + asset.ext : '';
    entries.push({
      name: `assets/${hash}${ext}`,
      data: new Uint8Array(await asset.blob.arrayBuffer()),
      // Media is already compressed; deflating it burns time for ~0 bytes.
      compress: shouldCompress(asset.mime, asset.ext),
    });
  }

  return { blob: await writeZip(entries, { date: now, mime: MIME }), manifest };
}

/**
 * Read a .mbrd Blob. Registers every embedded asset in the asset store and
 * returns `{ manifest, board }` ready for state.loadBoard().
 */
export async function unpackBoard(blob) {
  const files = await readZip(blob);

  const boardBytes = files.get('board.json');
  if (!boardBytes) throw new Error('Not an .mbrd file (no board.json inside)');

  let manifest = {};
  const manifestBytes = files.get('manifest.json');
  if (manifestBytes) {
    try { manifest = JSON.parse(dec.decode(manifestBytes)); } catch { /* keep going */ }
  }
  if (manifest.format && manifest.format !== FORMAT) {
    throw new Error(`Unknown board format "${manifest.format}"`);
  }
  if (manifest.version > FORMAT_VERSION) {
    console.warn('[mbrd] file was written by a newer version; loading anyway');
  }

  const board = JSON.parse(dec.decode(boardBytes));
  if (manifest.title && !board.title) board.title = manifest.title;

  for (const [name, bytes] of files) {
    if (!name.startsWith('assets/')) continue;
    const file = name.slice('assets/'.length);
    const dot = file.lastIndexOf('.');
    const hash = dot > 0 ? file.slice(0, dot) : file;
    const ext = dot > 0 ? file.slice(dot + 1) : '';
    // Copy out of the archive buffer: subarrays keep the whole ZIP alive.
    putAsset(hash, new Blob([bytes.slice()], { type: mimeFor(ext) }), { ext, mime: mimeFor(ext) });
  }

  return { manifest, board };
}

/** Cheap sniff so a wrong-extension drop fails with a useful message. */
export function looksLikeMbrd(file) {
  return /\.mbrd$/i.test(file.name) || file.type === MIME;
}

const ALREADY_COMPRESSED = /^(image\/(?!svg|bmp|x-)|video\/|audio\/)|zip|gzip|compressed/i;
const RAW_EXT = new Set(['bmp', 'svg', 'txt', 'md', 'json', 'csv', 'xml', 'html', 'wav', 'tif', 'tiff']);

function shouldCompress(mime, ext) {
  if (RAW_EXT.has((ext || '').toLowerCase())) return true;
  if (mime && ALREADY_COMPRESSED.test(mime)) return false;
  return true;
}

// Blob type is what drives <img>/<video>/<audio> playback, and the ZIP does not
// carry MIME types - so it is rebuilt from the extension on the way back in.
const MIME_BY_EXT = {
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

function mimeFor(ext) {
  return MIME_BY_EXT[(ext || '').toLowerCase()] || '';
}
