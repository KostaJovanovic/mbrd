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
// WebCodecs plus ninety lines of Ogg writes the Opus (picture.js, opus.js), so
// the whole feature runs with nothing downloaded.
//
// Video is left alone. Shrinking a clip is the one thing the browser cannot do
// itself - it needs ffmpeg, a 30 MB single-threaded wasm encoder that pins a
// core for the length of the clip - and for a board you look at that is not a
// trade worth making. Clips stay exactly the file that was dropped; a still
// poster for one the browser cannot even open is a separate, lighter job
// (firstFrame in media.js), not part of optimising.

import { board, byId, swapAssets, setItemThumb, setItemPoster, removeItems } from '../state.js';
import { addFile, getAsset } from '../storage/assets.js';
import { formatBytes, itemHashes, extOf } from '../util.js';
import { PHOTO_EXTS, AUDIO_EXTS, VIDEO_EXTS, SVG_EXTS } from '../import/formats.js';
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
  const plan = { pictures: [], sounds: [], skipped: [], empty: [], done: 0, total: 0, posters: 0 };

  for (const item of board.items) {
    // Files with no bytes in them, which is the one case here that is a removal
    // rather than a re-encode. An empty file cannot be made smaller and can
    // never draw anything: what it leaves is a card claiming to be a photograph
    // with a permanent hole where the picture goes. They arrive from an import
    // that let one through (a zero-byte file with a MIME type on it is a file
    // as far as the picker is concerned) and from archives written around one.
    //
    // Per item and not per hash, unlike everything below. Every empty file in
    // existence hashes to the same digest, so a board with five of them has one
    // hash on five cards - and deduplicating by hash would clean exactly one of
    // them and quietly leave the other four.
    const emptyAsset = !!item.asset?.hash && getAsset(item.asset.hash)?.size === 0;
    const emptyCover = !!item.meta?.cover && getAsset(item.meta.cover)?.size === 0;
    if (emptyAsset || emptyCover) {
      plan.empty.push({
        id: item.id, asset: emptyAsset, cover: emptyCover,
        name: item.name || getAsset(item.asset?.hash)?.name || '',
      });
    }

    // Clips with nothing to show yet. Counted rather than bucketed with the
    // rest, because this is not a file to be rewritten - the clip is left
    // exactly as it is and a still is cut *beside* it. It is here so the dialog
    // knows a board of nothing but video still has work on it: without this,
    // the one board that most needs the stills is the board the button says
    // there is nothing to do on. See backfillPosters().
    if (item.type === 'video' && item.asset?.hash && !(item.meta?.cover && getAsset(item.meta.cover))) {
      plan.posters++;
    }
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
      // Bucketed above, as a removal. Not counted here as well: an encoder
      // would be handed nothing, and a dialog promising to shrink a file whose
      // size is already zero is a promise it cannot keep.
      if (!asset.size) continue;
      if (marked.has(hash)) { plan.done++; continue; }
      plan.total += asset.size;
      const isCover = hash !== item.asset?.hash;
      const name = asset.name || item.name || '';
      const kind = mediaKind({
        mime: asset.mime || '',
        ext: extOf(name) || item.meta?.ext || extOf(item.name) || '',
        type: item.type,
        isCover,
      });
      const entry = { hash, size: asset.size, name, isCover, kind };
      if (kind === 'image') plan.pictures.push(entry);
      else if (kind === 'audio') plan.sounds.push(entry);
      // Video is bucketed with the skips - counted so a dialog can say how many
      // clips it is leaving alone, but never encoded. See the module note.
      else plan.skipped.push(entry);
    }
  }
  return plan;
}

/**
 * Which of the three encoders a file belongs to, or null to leave it alone.
 *
 * Extension leads over MIME for the audio/video split, and that is the whole
 * point of this: an AAC track in an MP4 container is routinely handed over as
 * `audio/mp4`, `video/mp4`, or nothing at all, and the last two used to send it
 * to the ffmpeg-only video branch or to the skip pile - so a board of AAC music
 * "optimised" without touching a single sound. A `.m4a`/`.aac` extension says
 * "sound" plainly where the MIME is at best ambiguous, and the browser decodes
 * it to Opus with nothing downloaded (see opus.js). MIME still has the first
 * word for pictures, where it is reliable and an extension often absent.
 *
 * A cover is always a picture: it rides on an audio card, so the parent item's
 * type describes the sound and not the art - hence `isCover` never falls through
 * to the type check.
 */
function mediaKind({ mime, ext, type, isCover }) {
  if (/^image\//i.test(mime) || SVG_EXTS.has(ext) || PHOTO_EXTS.has(ext)) return 'image';
  if (ext && AUDIO_EXTS.has(ext)) return 'audio';
  if (ext && VIDEO_EXTS.has(ext)) return 'video';
  if (/^audio\//i.test(mime)) return 'audio';
  if (/^video\//i.test(mime)) return 'video';
  if (!isCover && (type === 'audio' || type === 'video' || type === 'image')) return type;
  return null;
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
 * The rewriting touches the board exactly once, at the end, in a single undoable
 * commit - see swapAssets(). Half an optimisation is not a state the board
 * should ever be observed in.
 *
 * Clearing out the empty files is the one thing that stands outside that, as its
 * own commit before any of this runs. It is a different act - taking away what
 * was never content, rather than rewriting what is - and the note over it says
 * why the two should not share a Ctrl+Z.
 */
export async function runOptimize({ onProgress = () => {} } = {}) {
  const plan = planOptimize();

  // The empty files, before anything else runs.
  //
  // A card whose own file has no bytes in it goes entirely - the card, not just
  // the reference. There is nothing on it: no picture, no sound, no text, and
  // no way for any of those to arrive later. What was left when this only
  // cleared the reference was a card that had stopped claiming to be a file and
  // still sat on the board taking up room, which is the hole without even the
  // explanation for it.
  //
  // Its own commit rather than folded into the swap at the end, and that is a
  // deliberate departure from the one-commit rule below. The two are different
  // acts: one clears out what was never content, the other rewrites what is.
  // Undoing an optimisation should not resurrect four broken cards, and one
  // Ctrl+Z that did both would be a step nobody could describe.
  //
  // They go to the bin like any other delete, so this is recoverable past the
  // undo as well - which is the whole reason it is allowed to be a delete.
  const doomed = plan.empty.filter(e => e.asset).map(e => e.id);
  if (doomed.length) {
    removeItems(doomed, doomed.length > 1
      ? `Remove ${doomed.length} empty files` : 'Remove empty file');
  }

  const jobs = [...plan.pictures, ...plan.sounds];
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
      const smaller = await encodeOne(asset, job);
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
  // Empty *covers*, which are the other half of the empty-file story and are
  // not a delete: the card has a real file on it and only its picture is the
  // hollow one, so it loses the picture and keeps everything else. `null` is the
  // third thing a swap can say - drop this reference - beside a hash (replace
  // it) and nothing at all (leave it alone). See swapAssets() in state.js.
  //
  // Read off the live board rather than off the plan, because the cards whose
  // own file was empty have already gone by now.
  const hollowCover = new Set(
    plan.empty.filter(e => e.cover).map(e => e.id).filter(id => byId(id)));
  const swaps = [];
  for (const item of board.items) {
    const asset = replacement.get(item.asset?.hash);
    const cover = hollowCover.has(item.id) ? null : replacement.get(item.meta?.cover);
    // `!== undefined`, not truthiness: null is a real instruction here, and the
    // falsy test this used to be would have skipped every cover being dropped.
    if (asset !== undefined || cover !== undefined || itemHashes(item).some(h => looked.has(h))) {
      swaps.push({ id: item.id, asset, cover });
    }
  }
  report.emptied = plan.empty.length;
  report.items = swapAssets(swaps);
  // Items whose picture is not the picture it was a moment ago. Their old
  // thumbnail is a thumbnail of bytes that no longer exist on this card.
  const restaged = new Set(swaps.filter(s => s.asset).map(s => s.id));
  report.thumbs = await backfillThumbs(restaged, onProgress);
  report.posters = await backfillPosters(onProgress);
  return report;
}

/**
 * Give every video on the board a still of its own first frame, if it has none.
 *
 * The same repair backfillThumbs() is, for the same reason: import makes these
 * now, so a board built since they existed finds nothing here and pays one pass
 * over the item list. It is here for the board saved before that - where every
 * video card is a black rectangle on a phone, because the mobile path attaches
 * no source until the clip is tapped and so has no frame to paint.
 *
 * Not keyed to the optimiser's swaps the way thumbnails are. A poster is cut
 * from the clip's own first frame and the optimiser never rewrites a clip -
 * video is deliberately left alone, see the module note - so the bytes a poster
 * was cut from are the bytes the item still holds. There is nothing to restage.
 *
 * Only ever adds. setItemPoster() refuses an item that already carries a
 * picture, so a cover somebody chose by hand survives this untouched.
 */
async function backfillPosters(onProgress) {
  const wanted = board.items.filter(it =>
    it.type === 'video' && it.asset?.hash && !(it.meta?.cover && getAsset(it.meta.cover)));
  if (!wanted.length) return 0;

  // Loaded here rather than at the top of the file: it reaches for `document`
  // inside the call, but it also drags the whole renderer module in, and this
  // pass does nothing at all on the boards that already have their posters.
  const { videoFrame } = await import('../canvas/renderers.js');

  let made = 0, n = 0;
  for (const item of wanted) {
    onProgress({ done: n, total: wanted.length, name: item.name || '', phase: 'posters' });
    n++;
    const asset = getAsset(item.asset.hash);
    if (!asset) continue;
    try {
      const frame = await videoFrame(asset.blob);
      if (!frame) continue;
      const hash = await addFile(new File([frame.blob], 'poster.webp', { type: 'image/webp' }));
      setItemPoster(item.id, hash);
      made++;
    } catch (err) {
      // One clip that will not give up a frame is not a failed pass. It stays
      // the card it already was.
      console.warn('[mbrd] no poster for', item.name || item.id, err);
    }
  }
  return made;
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
 * Pictures and sound are the browser's own job and are always available, so this
 * needs nothing loaded and nothing off the network. A file whose only encoder
 * would be ffmpeg - a video, or sound on a browser too old for WebCodecs Opus -
 * returns null and is left exactly as it was.
 */
async function encodeOne(asset, job) {
  // job.kind is the category planOptimize() resolved (see mediaKind), not a
  // second read of asset.mime - so the AAC that reached the sound bucket by its
  // extension is encoded as sound rather than being re-doubted here.
  if (job.kind === 'image') {
    return shrinkPicture(asset.blob, {
      // A cover is drawn at a fraction of the card it sits on, so it gets the
      // smaller ceiling. It is never dropped - see the module note.
      maxSide: job.isCover ? MAX_SIDE_COVER : MAX_SIDE,
      quality: QUALITY,
    });
  }
  // No WebCodecs Opus means no sound encoder at all now - a browser old enough
  // that this is theoretical. Left alone rather than downloaded for.
  if (job.kind === 'audio' && opusAvailable()) return toOpus(asset.blob, await carried(asset));
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
  if (!small) return { tags, cover: art };
  // shrinkPicture already decoded the cover to resize it; carry its dimensions
  // through so pictureBlock does not decode the same image a second time.
  return {
    tags,
    cover: new File([small.blob], 'cover.jpg', { type: 'image/jpeg' }),
    coverW: small.width, coverH: small.height,
  };
}

/** The old name with the new extension - `holiday.png` becomes `holiday.webp`. */
function renameFor(name, mime) {
  const ext = { 'image/webp': 'webp', 'audio/ogg': 'opus', 'video/webm': 'webm' }[mime] || 'bin';
  const stem = String(name || 'file').replace(/\.[^.]*$/, '') || 'file';
  return `${stem}.${ext}`;
}

/** "3 files, 41.2 MB smaller" - the sentence the toast says afterwards. */
export function describeSaving(report) {
  // The derived passes on their own still count as work done, and saying so
  // matters on the one board where it is the only thing that happened: an old
  // board of already-small pictures, where the honest report used to be
  // "nothing was worth shrinking" while two hundred thumbnails had just been
  // cut. Video stills are the same case - the optimiser never touches a clip's
  // bytes, so on a board of video they are the *whole* of what it did.
  const derived = [
    report.thumbs && `${report.thumbs} thumbnail${report.thumbs === 1 ? '' : 's'} made`,
    report.posters && `${report.posters} video still${report.posters === 1 ? '' : 's'} taken`,
    // A removal, not a saving, so it is named here rather than folded into the
    // byte count: dropping a file of zero bytes frees zero bytes, and reporting
    // it as space saved would be arithmetic nobody can check.
    report.emptied && `${report.emptied} empty file${report.emptied === 1 ? '' : 's'} removed`,
  ].filter(Boolean).join(', ');
  if (!report.changed) return derived || 'Nothing on this board was worth shrinking';
  const saved = report.before - report.after;
  return `${report.changed} file${report.changed === 1 ? '' : 's'} rewritten, ` +
    `${formatBytes(saved)} smaller` +
    (derived ? `, ${derived}` : '') +
    (report.failed ? ` - ${report.failed} could not be read` : '');
}

/** The weight of everything the board is carrying, for the dialog's first line. */
export const boardWeight = () => planOptimize().total;

/** Whether an item still holds bytes this replaced. Used by the menu. */
export const wasOptimized = id => !!byId(id)?.meta?.was;
