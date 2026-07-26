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
// Sound and moving pictures go through ffmpeg, which is a separate module and a
// separate 30MB - see media.js - and this file works without it: a board of
// photographs optimises with nothing loaded but the browser's own codecs.

import { board, byId, swapAssets } from '../state.js';
import { addFile, getAsset } from '../storage/assets.js';
import { formatBytes, itemHashes } from '../util.js';
import { shrinkPicture, MAX_SIDE, MAX_SIDE_COVER, QUALITY } from './picture.js';

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
  const plan = { pictures: [], sounds: [], videos: [], skipped: [], total: 0 };

  for (const item of board.items) {
    for (const hash of itemHashes(item)) {
      if (seen.has(hash)) continue;
      const asset = getAsset(hash);
      if (!asset) continue;
      seen.add(hash);
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

  const swaps = [];
  for (const item of board.items) {
    const asset = replacement.get(item.asset?.hash);
    const cover = replacement.get(item.meta?.cover);
    if (asset || cover) swaps.push({ id: item.id, asset, cover });
  }
  report.items = swapAssets(swaps);
  return report;
}

/**
 * One file, by kind.
 *
 * Pictures are the browser's own job and always available. Sound and video are
 * handed to whatever the caller passed in as `encodeMedia` - ffmpeg, loaded on
 * demand - and where that is absent they are simply left alone, which is what
 * keeps this module usable with nothing downloaded.
 */
function encodeOne(asset, job, encodeMedia) {
  const mime = asset.mime || '';
  if (/^image\//i.test(mime)) {
    return shrinkPicture(asset.blob, {
      // A cover is drawn at a fraction of the card it sits on, so it gets the
      // smaller ceiling. It is never dropped - see the module note.
      maxSide: job.isCover ? MAX_SIDE_COVER : MAX_SIDE,
      quality: QUALITY,
    });
  }
  if (!encodeMedia) return Promise.resolve(null);
  if (/^audio\//i.test(mime)) return encodeMedia(asset, 'audio');
  if (/^video\//i.test(mime)) return encodeMedia(asset, 'video');
  return Promise.resolve(null);
}

/** The old name with the new extension - `holiday.png` becomes `holiday.webp`. */
function renameFor(name, mime) {
  const ext = { 'image/webp': 'webp', 'audio/ogg': 'opus', 'video/webm': 'webm' }[mime] || 'bin';
  const stem = String(name || 'file').replace(/\.[^.]*$/, '') || 'file';
  return `${stem}.${ext}`;
}

/** "3 files, 41.2 MB smaller" - the sentence the toast says afterwards. */
export function describeSaving(report) {
  if (!report.changed) return 'Nothing on this board was worth shrinking';
  const saved = report.before - report.after;
  return `${report.changed} file${report.changed === 1 ? '' : 's'} rewritten, ` +
    `${formatBytes(saved)} smaller` +
    (report.failed ? ` - ${report.failed} could not be read` : '');
}

/** The weight of everything the board is carrying, for the dialog's first line. */
export const boardWeight = () => planOptimize().total;

/** Whether an item still holds bytes this replaced. Used by the menu. */
export const wasOptimized = id => !!byId(id)?.meta?.was;
