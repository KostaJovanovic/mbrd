// Cover art for a track that brought none, from Last.fm.
//
// Most audio arrives with a picture in its tags and import/artwork.js digs it
// out. Plenty does not - a rip, a bounce out of a DAW, anything that has been
// through a converter that dropped the frames - and those land as a plain card
// with a filename on it, on a board whose whole job is to be looked at.
//
// This is the second of exactly two places in mbrd that talks to a third party
// (canvas/embed.js is the other), and it is built to the same terms:
//
//   - **Off unless you turn it on.** There is no key by default and no request
//     without one. A board opened on a machine that never set one behaves
//     exactly as it did before this file existed.
//   - **The key is yours, not the board's.** It lives in localStorage and is
//     never written into a .mbrd, because a board is a thing you send to
//     somebody and an API key is not a thing you send to somebody.
//   - **It says only what it must.** An artist and an album name go out. No
//     bytes of the file, no filename, no board, no identifier - and the request
//     carries `referrerpolicy=no-referrer` for the same reason link cards do.
//   - **Failing is normal.** No key, no tags, no network, no match, a rate
//     limit, a CORS refusal: every one of them answers null and the card is the
//     plain card it would have been anyway. Nothing here is allowed to make an
//     import fail.
//
// One request per album rather than per track, which matters more than it
// sounds: dropping a twelve-track album is one lookup, not twelve, and the
// second through twelfth tracks get their cover out of a map.

import { audioTags } from './artwork.js';
import { readPref, writePref, extOf } from '../util.js';

/** Where the key lives. A user preference, deliberately not board state. */
const KEY_PREF = 'mbrd.lastfm';

/**
 * A Last.fm key is 32 hex characters. Checked before it is used, so a
 * half-pasted one fails here rather than as a puzzling 403 per track.
 */
const KEY_SHAPE = /^[0-9a-f]{32}$/i;

export const lastfmKey = () => {
  const k = String(readPref(KEY_PREF) || '').trim();
  return KEY_SHAPE.test(k) ? k : '';
};

export const setLastfmKey = k => {
  const s = String(k || '').trim();
  writePref(KEY_PREF, KEY_SHAPE.test(s) ? s : '');
  return KEY_SHAPE.test(s);
};

/** Whether a lookup would do anything at all. The one gate every caller uses. */
export const lastfmOn = () => !!lastfmKey();

/**
 * The biggest cover worth taking. Last.fm's largest is around 300px and this is
 * far above it - the cap is here so a redirect to something enormous cannot
 * quietly put megabytes in a .mbrd, not because the art is expected to be big.
 */
const MAX_ART = 4 * 1024 * 1024;

/** How long a lookup may take before the import stops waiting for it. */
const TIMEOUT_MS = 6000;

/**
 * Albums already asked about this session, as name -> Promise<File|null>.
 *
 * The promise and not the answer, so twelve tracks of one album that are
 * imported concurrently *share* the one in-flight request rather than each
 * finding the cache still empty and firing its own. Negative results are cached
 * too: an album Last.fm does not know is not going to be known on track nine.
 */
const asked = new Map();

/** Deliberately not cleared on board load - it is a cache of the internet. */
export const forgetLastfm = () => asked.clear();

/**
 * The cover for one audio file, as a File, or null.
 *
 * The File is shaped for addFile() in storage/assets.js, the same as the one
 * import/artwork.js returns, so the caller cannot tell where a cover came from
 * and does not have to care.
 */
export async function lastfmArt(file) {
  if (!lastfmOn()) return null;
  const q = await describe(file);
  if (!q) return null;
  const cacheKey = (q.album ? 'a\n' : 't\n') + q.artist.toLowerCase() + '\n'
    + (q.album || q.track).toLowerCase();
  if (!asked.has(cacheKey)) asked.set(cacheKey, lookup(q).catch(() => null));
  return asked.get(cacheKey);
}

/**
 * What to ask about: an artist plus either an album or a track.
 *
 * The tags first, because they are what the file says about itself. The
 * filename second, and only for the artist/title pair - "Artist - Title.mp3" is
 * the one filename convention widespread enough to read, and a file with no
 * tags at all is exactly the file most likely to have no picture either, so
 * skipping it would skip most of the cases this exists for.
 */
async function describe(file) {
  const tags = new Map(await audioTags(file));
  const artist = pick(tags, 'ALBUMARTIST') || pick(tags, 'ARTIST');
  const album = pick(tags, 'ALBUM');
  const track = pick(tags, 'TITLE');
  if (artist && (album || track)) return { artist, album, track };

  const stem = String(file?.name || '').slice(0, -(extOf(file?.name || '').length + 1) || undefined);
  // An en or em dash as readily as a hyphen: the separator a music player wrote
  // is whichever one it felt like.
  const m = /^\s*(.{1,120}?)\s+[-–—]\s+(.{1,120}?)\s*$/.exec(stem);
  if (!m) return null;
  // A leading track number is part of the filing, not part of the artist.
  const left = m[1].replace(/^\d{1,3}[\s.\-_]+/, '').trim();
  return left && m[2] ? { artist: left, album: '', track: m[2] } : null;
}

const pick = (tags, k) => String(tags.get(k) || '').trim();

/** The one request, and the one that follows it if there is a picture to get. */
async function lookup(q) {
  const url = new URL('https://ws.audioscrobbler.com/2.0/');
  // Set through URLSearchParams, so a name carrying an ampersand or a hash is
  // encoded rather than becoming a second parameter.
  url.searchParams.set('method', q.album ? 'album.getinfo' : 'track.getInfo');
  url.searchParams.set('api_key', lastfmKey());
  url.searchParams.set('format', 'json');
  url.searchParams.set('autocorrect', '1');
  url.searchParams.set('artist', q.artist);
  if (q.album) url.searchParams.set('album', q.album);
  else url.searchParams.set('track', q.track);

  const res = await get(url.href);
  if (!res?.ok) return null;
  const data = await res.json();
  const src = imageURL(data?.album?.image || data?.track?.album?.image);
  if (!src) return null;

  const art = await get(src);
  if (!art?.ok) return null;
  const blob = await art.blob();
  if (!blob.size || blob.size > MAX_ART || !blob.type.startsWith('image/')) return null;
  // Named for where it came from, because the asset registry keeps the name and
  // it is the only place the provenance of a picture is ever recorded.
  return new File([blob], 'cover-lastfm' + (extFor(blob.type) || '.jpg'), { type: blob.type });
}

/**
 * The largest usable image in Last.fm's array.
 *
 * They return the same picture at five sizes, in ascending order, and a stock
 * placeholder star for anything they have no art for - which comes back as a
 * URL like every other and would otherwise be pasted onto the card as though it
 * were a cover. The empty-string entries are the ones they have nothing for.
 */
function imageURL(list) {
  if (!Array.isArray(list)) return '';
  for (let i = list.length - 1; i >= 0; i--) {
    const src = String(list[i]?.['#text'] || '').trim();
    if (!src || !src.startsWith('https://')) continue;
    if (/2a96cbd8b46e442fc41c2b86b821562f/.test(src)) continue;   // their "no image" star
    return src;
  }
  return '';
}

const extFor = mime => ({
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
}[mime] || '');

/**
 * A request that cannot hang and cannot throw.
 *
 * `no-referrer` keeps the board's own address out of their logs, and omitting
 * credentials means no cookie anybody has for last.fm rides along - this is a
 * lookup, not a session.
 */
async function get(href) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
  try {
    return await fetch(href, {
      signal: stop.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'force-cache',
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
