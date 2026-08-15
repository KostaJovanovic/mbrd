// Video posters, one frame at a time, while nothing else is happening.
//
// A clip with no picture is a black rectangle with a play button on it, and on
// a phone it stays that way until it is tapped: the mobile path attaches no
// source to a parked <video> at all (see the renderer, and the decoder ceiling
// that forces it), so there is no frame for the card to paint. Import grabs one
// for every clip that arrives, which leaves two boards that never get them - one
// saved before posters existed, and one whose clips came in from a build that
// could not decode them.
//
// The repair for those already exists inside the optimiser, and needing to run
// the optimiser is the problem. Optimise is a *modal* act: a dialog, a progress
// bar, minutes of the machine at full tilt, and an undo entry at the end of it.
// Nothing about giving a clip a still of itself is like that. It is derived
// output, it is never undoable, it cannot make the board worse, and it is
// wanted on precisely the boards where sitting through the optimiser is least
// appealing - the big ones. So it happens by itself, slowly, in the background.
//
// **Slowly is the design and not a compromise.** One clip at a time, a rest
// between them, and only in an idle window: the cost of this feature is a
// decode that has to compete with the board being drawn, and losing that
// competition is a scroll that stutters. There is no deadline - a board finishes
// its posters over a minute or over a session, and either is fine, because what
// it is racing is somebody zooming out, which they may not do today.
//
// Three things stop it dead rather than slow it down:
//
//   - **a hidden tab**, because requestVideoFrameCallback does not fire in one.
//     A grab there does not run slowly, it *times out*, six seconds at a time,
//     and would mark every clip on the board as one that cannot give up a frame.
//   - **a clip that has already refused**, for the session. H.265 from a phone
//     is the common case and no amount of asking again will decode it - that is
//     what the ffmpeg path in optimize/media.js is for, and it is thirty
//     megabytes and needs to be asked for.
//   - **nothing left to do**, which is the normal state of a board built since
//     import started making these. The scan is a filter over the item list.
//
// The thumbnail comes with the poster, deliberately. A poster is what the card
// draws close up and the hundred-pixel thumbnail is what it draws zoomed out, so
// a clip given one and not the other is fixed at one distance and still blank at
// the other - which is exactly the state the optimiser used to leave a board in
// by cutting thumbnails before it made posters.

import { board, bus, byId, setItemPoster, setItemThumb } from '../state.ts';
import { addFile, getAsset } from '../storage/assets.ts';
import { videoFrame } from '../canvas/poster.ts';
import { makeThumb } from './picture.ts';
import type { Item } from '../board-model.ts';

/** How long after a board arrives before the first grab is attempted. */
const SETTLE_MS = 6000;
/** The rest between two clips. Long enough that this is never the busy thing. */
const GAP_MS = 1500;
/** How long to wait for a genuine idle window before taking one anyway. */
const IDLE_MS = 4000;

/** Clips that have refused a frame this session - see the head of this file. */
const refused = new Set<string>();

let timer = 0;
/** A grab in flight. One at a time, always. */
let busy = false;
/** Whether initBackfill() has run, so the bus is not wired twice. */
let wired = false;

/**
 * Start the trickle, and keep it fed.
 *
 * `items` is the event a dropped clip arrives on, and it fires for every kind of
 * change to the item list - so this is armed far more often than there is work,
 * which is why arming is cheap and idempotent: a timer that is already set is
 * left alone, and the scan that follows is a filter that finds nothing on a
 * board with all its posters.
 */
export function initBackfill(): void {
  if (wired) return;
  wired = true;
  // A new board is a new set of clips, and a clip that refused on the last one
  // may well be a different file with the same id in a different board.
  bus.on('board:load', () => { refused.clear(); arm(SETTLE_MS); });
  bus.on('items', () => arm(GAP_MS));
  // Coming back to the tab is when a grab can work again - see the head of this
  // file on why one in a hidden tab does not merely run slower.
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') arm(GAP_MS);
  });
  arm(SETTLE_MS);
}

/** Ask for another pass in `ms`, unless one is already coming. */
function arm(ms: number): void {
  if (timer || busy) return;
  timer = setTimeout(() => { timer = 0; void pass(); }, ms);
}

/**
 * One clip: its own first frame, saved as the picture the card draws.
 *
 * Everything in here is allowed to come to nothing. A clip that cannot be
 * decoded, a board that was closed while the frame was being cut, an item
 * deleted from under it - all of them end with the card exactly as it was,
 * which is the state this whole module is an improvement on rather than a
 * replacement for.
 */
async function pass(): Promise<void> {
  if (busy || document.visibilityState !== 'visible') return;
  const item = nextWanted();
  if (!item) return;

  busy = true;
  try {
    await idleWindow();
    // Re-read: the wait above is real time, and the item may have been deleted
    // or given a picture by an import or an optimiser run in the middle of it.
    const fresh = byId(item.id);
    if (!fresh || !wantsPoster(fresh)) return;
    // A clip whose bytes are not in the registry - an item restored from an
    // archive that was missing its file. Refused rather than skipped, and that
    // is not a detail: nextWanted() picks the first clip that still wants a
    // poster, so anything this loop can decline to fix without saying so is a
    // clip it will pick again in a second and a half, for as long as the board
    // is open. Every road out of here either fixes the item or refuses it.
    const asset = getAsset(fresh.asset?.hash);
    if (!asset) { refused.add(fresh.id); return; }

    const frame = await videoFrame(asset.blob);
    if (!frame) { refused.add(fresh.id); return; }
    const hash = await addFile(new File([frame.blob], 'poster.webp', { type: 'image/webp' }));
    setItemPoster(fresh.id, hash);
    // setItemPoster is allowed to decline - it refuses to overwrite a picture,
    // and it validates the hash - so this asks whether it took rather than
    // assuming. The same argument as the asset above: a write that quietly did
    // nothing would be this clip, again, in a second and a half.
    const after = byId(fresh.id);
    if (after && wantsPoster(after)) { refused.add(fresh.id); return; }
    // From the poster rather than from the clip, which is the only source there
    // is: the thumbnail is a hundred-pixel copy of the picture the card draws,
    // and for a video that picture is the frame just cut. No width hint, and it
    // does not want one - the blob is 640px at the widest (POSTER_SIDE), and
    // decoding that to a hundred is not the full-resolution decode the hint
    // exists to avoid.
    const small = await makeThumb(frame.blob);
    if (small) setItemThumb(fresh.id, await addFile(
      new File([small.blob], 'thumb.webp', { type: 'image/webp' })));
  } catch (err) {
    // One clip that will not give up a frame is not a failure worth telling
    // anybody about - nobody asked for this pass. It is logged because a board
    // where *every* clip lands here is worth being able to see in a console.
    refused.add(item.id);
    console.warn('[mbrd] no poster for', item.name || item.id, err);
  } finally {
    busy = false;
    arm(GAP_MS);
  }
}

/** Does this clip still want a still? */
function wantsPoster(it: Item): boolean {
  return it.type === 'video'
    && !!it.asset?.hash
    && !refused.has(it.id)
    // The same test the optimiser's own pass makes: a hash whose bytes went
    // away - an item restored from an archive that was missing a file - counts
    // as no picture, or it would never be repaired.
    && !(typeof it.meta?.cover === 'string' && getAsset(it.meta.cover));
}

/** The next clip with no picture, or null when the board is done. */
function nextWanted(): Item | null {
  return board.items.find(wantsPoster) || null;
}

/**
 * Wait for a moment when the browser has nothing better to do.
 *
 * With a timeout, so a board being panned continuously for a minute still gets
 * its posters - the idle callback would otherwise never fire, and "when you stop
 * moving" is not a promise this can keep on a board somebody is working on. On a
 * browser with no requestIdleCallback (Safari was the last, and is not any more)
 * this is a plain gap, which is the same bargain one step cruder.
 */
function idleWindow(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: IDLE_MS });
    } else {
      setTimeout(resolve, 0);
    }
  });
}
