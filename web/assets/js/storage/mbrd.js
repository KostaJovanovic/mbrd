// The .mbrd container: a ZIP holding a manifest, the board, and every asset's
// bytes, so a board is one self-contained file you can email or drop back in.
//
//   myboard.mbrd            (ZIP, renamed)
//   |- manifest.json        { format, version, app, created, modified, title }
//   |- board.json           { view, settings, arrangement, items[], trash[] }
//   |- assets/<hash>.<ext>  embedded bytes, deduped by content hash
//   |- notes/<slug>--<id>.md    one sticky note, as Markdown
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
  // Binned items count as referenced. Their bytes are the whole reason the bin
  // is worth anything after a save - dropping them would leave the panel
  // listing things that can no longer come back.
  const referenced = [...boardData.items, ...(boardData.trash || []).map(t => t.item)];
  for (const item of referenced) {
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

  // Every sticky note also goes in as a file you can read without this app.
  for (const item of referenced) {
    if (item.type !== 'note') continue;
    entries.push({ name: noteFile(item), data: enc.encode(noteMarkdown(item)), compress: true });
  }

  return { blob: await writeZip(entries, { date: now, mime: MIME }), manifest };
}

// ---------------------------------------------------------------------------
// Notes as Markdown
//
// A note is one string in board.json and that is still where it is *edited*
// from - but board.json is a machine's file, and a sticky note is the one kind
// of thing on a board that is purely the user's own writing. So each one is
// written out again as its own .md: unzip a .mbrd and your notes are a folder
// of readable files, greppable, diffable, openable in anything.
//
// The named half of the filename is for you and the id half is for the reader
// below, which is why both are there. Unpack prefers the .md over the copy in
// board.json, so editing one of those files by hand and reopening the board
// does what you would expect it to do.
// ---------------------------------------------------------------------------

const NOTES_DIR = 'notes/';

function noteFile(item) {
  const first = (item.meta?.text || '').split('\n')[0];
  const slug = first.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'note';
  // Two dashes: the slug has had its own runs collapsed to one, and a uid
  // carries a single dash, so this separator appears nowhere else in the name.
  return `${NOTES_DIR}${slug}--${item.id}.md`;
}

/** First line as a heading, the rest as the body. */
function noteMarkdown(item) {
  const [title, ...rest] = (item.meta?.text || '').split('\n');
  const head = title.trim();
  const body = rest.join('\n').trim();
  return (head ? '# ' + head + '\n' : '') + (body ? '\n' + body + '\n' : '');
}

/**
 * ...and back. Tolerant on the way in, because by design these are files a
 * person may have typed into: the heading marker is optional, so is the blank
 * line under it, and trailing whitespace is nobody's content.
 */
function parseNote(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const title = (lines.shift() || '').replace(/^#+\s*/, '').trim();
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return [title, ...lines].join('\n').replace(/\n+$/, '');
}

/** The id a note file was written for, or null if this is not one of ours. */
function noteId(name) {
  if (!name.startsWith(NOTES_DIR) || !name.endsWith('.md')) return null;
  const stem = name.slice(NOTES_DIR.length, -'.md'.length);
  const cut = stem.lastIndexOf('--');
  return cut === -1 ? null : stem.slice(cut + 2) || null;
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

  // Notes come back from their own files, which outrank the copy in
  // board.json - see the block above packBoard's note writer.
  const notes = new Map();
  for (const item of board.items || []) if (item.type === 'note') notes.set(item.id, item);
  for (const t of board.trash || []) if (t?.item?.type === 'note') notes.set(t.item.id, t.item);
  for (const [name, bytes] of files) {
    const id = noteId(name);
    const item = id && notes.get(id);
    if (!item) continue;
    item.meta = { ...item.meta, text: parseNote(dec.decode(bytes)) };
  }

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
