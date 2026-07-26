// Trimming a board down to what a board actually needs.
//
// Strictly asked for. Nothing here runs on import, on save, or on a timer -
// it is a menu item, it says what it is about to do, and it is one Ctrl+Z away
// from being undone. That is the whole shape of the feature and the reason it
// is allowed to be lossy at all: a moodboard is a thing you look at, and a
// lossless master of a song nobody is mastering, or a 6000px photograph on a
// card drawn at 300, is weight the board carries for nothing.
//
// What it will not do:
//   - touch anything it cannot make meaningfully smaller (see WORTH_IT in
//     picture.js). A re-encode that saves four percent is a generation of
//     quality spent on a rounding error.
//   - throw the originals away. They stay in the browser under `meta.was` until
//     you say otherwise, which is what makes the undo real rather than nominal.
//   - lose the pictures inside things. Album art and card covers are shrunk to
//     a card's worth of pixels, never dropped.
//
// Pictures and sound are the browser's own work - a canvas writes the WebP, and
// WebCodecs plus ninety lines of Ogg writes the Opus (picture.js, opus.js).
// Only video needs ffmpeg, which is a separate module and a separate 30 MB -
// see media.js - and this file works entirely without it.

import { board, byId, swapAssets, setItemThumb } from '../state.js';
import { addFile, getAsset } from '../storage/assets.js';
import { formatBytes, itemHashes } from '../util.js';
import { coverArt, audioTags } from '../import/artwork.js';
import { shrinkPicture, makeThumb, MAX_SIDE, MAX_SIDE_COVER, QUALITY } from './picture.js';
import { toOpus, opusAvailable } from './opus.js';

/**
 * What optimising this board would do, without doing any of it.
 *
 * Two things come back: what is on the board, bucketed by what would happen to
 * it, and the weight of each bucket. That is enough for a dialog to tell the
 * truth before anything is touched - and the sizes are exact, because every
 * asset is already in memory.
 */
export function planOptimize() {
  const seen = new Set();
  const plan = { pictures: [], sounds: [], videos: [], skipped: [], done: 0, total: 0 };

  for (const item of board.items) {
    // What this item held the last time the optimiser looked at it. Matching
    // bytes are done with - see swapAssets() in state.js. Skipping them is not
    // only about the wasted minute: re-encoding a WebP or an Opus stream from
    // its own output is a second generation of loss bought for nothing.
    const marked = new Set(item.meta?.opt || []);
    for (const hash of itemHashes(item)) {
      if (seen.has(hash)) continue;
      // A thumbnail is already the smallest this app knows how to make: a
      // hundred pixels of WebP at quality 0.5, cut by makeThumb(). Counting it
      // here would put a second entry on the dialog for every photograph on the
      // board, promise to shrink two hundred files, and then shrink none of
      // them - shrinkPicture() refuses a WebP already inside the ceiling. It is
      // derived output, not content, and the optimiser's business is content.
      if (hash === item.meta?.thumb) continue;
      const asset = getAsset(hash);
      if (!asset) continue;
      seen.add(hash);
      if (marked.has(hash)) { plan.done++; continue; }
      plan.total += asset.size;
      const isCover = hash !== item.asset?.hash;
      const entry = { hash, size: asset.size, name: asset.name || item.name || '', isCover };
      const mime = asset.mime || '';
      if (/^image\//i.test(mime)) plan.pictures.push(entry);
      else if (/^audio\//i.test(mime)) plan.sounds.push(entry);
      else if (/^video\//i.test(mime)) plan.videos.push(entry);
      else plan.skipped.push(entry);
    }
  }
  return plan;
}

/**
 * Do it.
 *
 * `onProgress({ done, total, name })` is called as each file is finished, so a
 * dialog can say which one it is on - a board of forty photographs is several
 * seconds of work and a frozen window is indistinguishable from a broken one.
 *
 * Every file is done one at a time and awaited. Running them concurrently would
 * be faster on paper and is the wrong shape here: each one holds a full decoded
 * bitmap, and eight of those at once on a board of large photographs is how you
 * find the tab's memory ceiling.
 *
 * The board itself is touched exactly once, at the end, in a single undoable
 * commit - see swapAssets(). Half an optimisation is not a state the board
 * should ever be observed in.
 */
export async function runOptimize({ onProgress = () => {}, encodeMedia = null } = {}) {
  const plan = planOptimize();
  const jobs = [...plan.pictures, ...plan.sounds, ...plan.videos];
  // hash -> the hash of the smaller file that replaces it. One entry per set of
  // bytes, not per card, so nine tracks sharing one cover re-encode it once.
  const replacement = new Map();
  const report = { done: 0, changed: 0, before: 0, after: 0, failed: 0, skipped: 0 };

  let n = 0;
  for (const job of jobs) {
    onProgress({ done: n, total: jobs.length, name: job.name });
    n++;
    const asset = getAsset(job.hash);
    if (!asset) { report.skipped++; continue; }
    try {
      const smaller = await encodeOne(asset, job, encodeMedia);
      report.done++;
      if (!smaller) { report.skipped++; continue; }
      const hash = await addFile(new File(
        [smaller.blob], renameFor(asset.name || job.name, smaller.blob.type), { type: smaller.blob.type },
      ));
      // The new bytes hashed to the old id: the file was already exactly this.
      // Nothing to swap, and swapping would leave `was` pointing at itself.
      if (hash === job.hash) { report.skipped++; continue; }
      replacement.set(job.hash, hash);
      report.changed++;
      report.before += asset.size;
      report.after += smaller.blob.size;
    } catch (err) {
      // One unreadable file is not a failed optimisation. It stays as it is and
      // is counted, and the rest of the board still gets smaller.
      console.warn('[mbrd] could not optimize', job.name || job.hash, err);
      report.failed++;
    }
  }
  onProgress({ done: jobs.length, total: jobs.length, name: '' });

  // Everything that was looked at goes to swapAssets(), not only what changed:
  // an item it decided to leave alone has still been decided about, and saying
  // so is what stops the next run deciding it all over again.
  const looked = new Set(jobs.map(j => j.hash));
  const swaps = [];
  for (const item of board.items) {
    const asset = replacement.get(item.asset?.hash);
    const cover = replacement.get(item.meta?.cover);
    if (asset || cover || itemHashes(item).some(h => looked.has(h))) {
      swaps.push({ id: item.id, asset, cover });
    }
  }
  report.items = swapAssets(swaps);
  // Items whose picture is not the picture it was a moment ago. Their old
  // thumbnail is a thumbnail of bytes that no longer exist on this card.
  const restaged = new Set(swaps.filter(s => s.asset).map(s => s.id));
  report.thumbs = await backfillThumbs(restaged, onProgress);
  return report;
}

/**
 * Give every photograph on the board a thumbnail, if it has not got one.
 *
 * Import makes these, so on a board built since they existed this finds
 * nothing and costs one pass over the item list. It is here for the two cases
 * that import cannot cover: a board saved before thumbnails existed, and a
 * picture whose bytes were just replaced by the optimiser above - the thumbnail
 * is keyed to the *item*, but its source is whatever the item now holds, and
 * re-encoding a photograph without re-cutting its thumbnail would leave the
 * zoomed-out view showing a copy of the old one.
 *
 * Runs after swapAssets(), deliberately: that is the commit that decides what
 * each item's bytes finally are, and cutting thumbnails from anything earlier
 * would be cutting them from bytes that are about to be replaced.
 *
 * Not undoable, and it does not need to be. A thumbnail is a derived copy that
 * nothing but the renderer reads; adding one changes what the board *shows* at
 * one zoom and nothing about what it *is*. The undo entry that matters - the
 * asset swap - is already closed above.
 */
async function backfillThumbs(restaged, onProgress) {
  const wanted = board.items.filter(it => {
    if (it.type !== 'image' || !it.asset?.hash) return false;
    // Its picture was just rewritten, so whatever thumbnail it has is of the
    // old bytes. Re-cut regardless of what it already holds.
    if (restaged.has(it.id)) return true;
    // Present and still pointing at real bytes. A hash whose asset went away -
    // an item restored from a board whose archive was missing a file - counts
    // as absent, or it would never be repaired.
    return !(it.meta?.thumb && getAsset(it.meta.thumb));
  });
  if (!wanted.length) return 0;

  let made = 0, n = 0;
  for (const item of wanted) {
    onProgress({ done: n, total: wanted.length, name: item.name || '', phase: 'thumbs' });
    n++;
    const asset = getAsset(item.asset.hash);
    if (!asset) continue;
    try {
      const small = await makeThumb(asset.blob);
      if (!small) continue;
      const hash = await addFile(new File([small.blob], 'thumb.webp', { type: 'image/webp' }));
      setItemThumb(item.id, hash);
      made++;
    } catch (err) {
      // One picture that will not decode is not a failed pass. It keeps drawing
      // full size at every zoom, which is exactly what it did before.
      console.warn('[mbrd] no thumbnail for', item.name || item.id, err);
    }
  }
  return made;
}

/**
 * One file, by kind.
 *
 * Pictures and sound are the browser's own job and are always available. Only
 * video is handed to whatever the caller passed in as `encodeMedia` - ffmpeg,
 * loaded on demand - and where that is absent it is simply left alone, which is
 * what keeps this module usable with nothing downloaded.
 *
 * Sound still falls back to ffmpeg when it is here and WebCodecs is not, which
 * is a browser old enough that it is a theoretical case rather than a real one.
 */
async function encodeOne(asset, job, encodeMedia) {
  const mime = asset.mime || '';
  if (/^image\//i.test(mime)) {
    return shrinkPicture(asset.blob, {
      // A cover is drawn at a fraction of the card it sits on, so it gets the
      // smaller ceiling. It is never dropped - see the module note.
      maxSide: job.isCover ? MAX_SIDE_COVER : MAX_SIDE,
      quality: QUALITY,
    });
  }
  if (/^audio\//i.test(mime)) {
    if (opusAvailable()) return toOpus(asset.blob, await carried(asset));
    return encodeMedia ? encodeMedia(asset, 'audio') : null;
  }
  if (/^video\//i.test(mime) && encodeMedia) return encodeMedia(asset, 'video');
  return null;
}

/**
 * What comes with a track: its tags, and its cover shrunk to a cover's size.
 *
 * The art is re-encoded rather than carried across whole, because a 3 MB
 * gatefold scan inside a 3 MB song is the greater half of what was meant to be
 * optimised away - and it is written as JPEG rather than WebP because this copy
 * is for whatever opens the file outside this app, and a WebP in a comment
 * header is a picture some players will not draw.
 */
async function carried(asset) {
  const tags = await audioTags(asset.blob).catch(() => []);
  const art = await coverArt(asset.blob).catch(() => null);
  if (!art) return { tags };
  const small = await shrinkPicture(art, {
    maxSide: MAX_SIDE_COVER, quality: QUALITY, type: 'image/jpeg',
  }).catch(() => null);
  return { tags, cover: small ? new File([small.blob], 'cover.jpg', { type: 'image/jpeg' }) : art };
}

/** The old name with the new extension - `holiday.png` becomes `holiday.webp`. */
function renameFor(name, mime) {
  const ext = { 'image/webp': 'webp', 'audio/ogg': 'opus', 'video/webm': 'webm' }[mime] || 'bin';
  const stem = String(name || 'file').replace(/\.[^.]*$/, '') || 'file';
  return `${stem}.${ext}`;
}

/** "3 files, 41.2 MB smaller" - the sentence the toast says afterwards. */
export function describeSaving(report) {
  // Thumbnails on their own still count as work done, and saying so matters on
  // the one board where it is the only thing that happened: an old board of
  // already-small pictures, where the honest report used to be "nothing was
  // worth shrinking" while two hundred thumbnails had just been cut.
  const thumbs = report.thumbs
    ? `${report.thumbs} thumbnail${report.thumbs === 1 ? '' : 's'} made`
    : '';
  if (!report.changed) return thumbs || 'Nothing on this board was worth shrinking';
  const saved = report.before - report.after;
  return `${report.changed} file${report.changed === 1 ? '' : 's'} rewritten, ` +
    `${formatBytes(saved)} smaller` +
    (thumbs ? `, ${thumbs}` : '') +
    (report.failed ? ` - ${report.failed} could not be read` : '');
}

/** The weight of everything the board is carrying, for the dialog's first line. */
export const boardWeight = () => planOptimize().total;

/** Whether an item still holds bytes this replaced. Used by the menu. */
export const wasOptimized = id => !!byId(id)?.meta?.was;
