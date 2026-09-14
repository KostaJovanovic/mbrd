// Playlist queue: next/prev/shuffle/repeat over audio tracks. One shared
// element plays the current track; when the track has a visible card, it uses
// that card's own <audio> instead (so waveform/seek work). Sits on top of
// canvas/audio.ts's exclusivity invariant — no DOM of its own.

import type { Item } from '../board-model.ts';
import { readPref, writePref } from '../prefs.ts';
import { assetURL } from '../storage/assets.ts';
import { reportPlayError } from '../media/transport.ts';
import { toast } from '../notify.ts';
import { shuffle } from '../util.ts';
import {
  claimPlayer, nowPlaying, onPlayerReleased, ownerOf,
  registerPlayer, registeredPlayers, setNowPlaying,
} from './audio.ts';

/**
 * Shuffle and repeat are the listener's, not the board's.
 *
 * Kept in prefs rather than in the .mbrd, and that is the same argument
 * canvas/audio.ts makes one file over for the volume: how you like to listen is
 * a property of the room you are sitting in, and writing it into the file would
 * mean opening somebody else's board silently changed how yours plays - or, the
 * other way round, that sending a board to somebody sent your shuffle setting
 * with it. No schema change, and nothing here ever calls markDirty().
 *
 * They survive a board load for the same reason: clearQueue() empties the list,
 * and the list is what changed. The mode is not part of it.
 */
const SHUFFLE_KEY = 'mbrd.shuffle';
const REPEAT_KEY = 'mbrd.repeat';

/** 'off' for anything the store does not hold or a build wrote and this one does not know. */
function readRepeat(): RepeatMode {
  const v = readPref(REPEAT_KEY);
  return v === 'all' || v === 'one' ? v : 'off';
}

/**
 * The one field of a board item the queue reads.
 *
 * This was a narrow structural type - `{ asset }` and nothing else - written
 * while there was no shared `Item` to name, on the argument that a queue should
 * not assert a shape it does not use. `board-model.ts` states that shape now, so
 * the argument has expired: what this queue holds *is* a board item, it arrives
 * from the board, and two names for one thing is how they drift apart. The
 * alias stays because the queue's own vocabulary is worth keeping at its
 * signatures - a track is what a queue holds - but there is one definition
 * underneath it.
 */
export type Track = Item;

/** off, wrap the list, or hold on the one track. */
export type RepeatMode = 'off' | 'all' | 'one';

/** What onQueue() subscribers are told, which is only that something moved. */
export interface QueueSnapshot {
  shuffle: boolean;
  repeat: RepeatMode;
  active: boolean;
  length: number;
  /**
   * Where we are in the *list*, not in the play order: `queuePos` mapped back
   * through `queueOrder`, and -1 when nothing is loaded.
   *
   * The mapping is the whole of why it is a field rather than something a
   * transport works out. Under shuffle, `queuePos` is a position in a permuted
   * index list and means nothing to anybody looking at the rows; what a reader
   * wants is "the fourth of twelve", counted down the list they can see.
   *
   * It is what greys prev and next at the ends and what the lens transport
   * prints as "4 of 12". Deliberately not an "up next" - a queue under shuffle
   * has a next track and printing it invites the question of why it is not the
   * row below, which is a question with a long answer and no useful one.
   */
  index: number;
  /**
   * Whether the current track was started *as a list* - from a playlist row, or
   * from the lens's Play or Shuffle - rather than from a card on the board.
   *
   * The distinction is the difference between two things somebody meant. A row
   * in a list is a place in a sequence: pressing it says play from here, and the
   * track after it is the one below, which you can see. A card on a board is one
   * object among two hundred: pressing it says play *this*, and the board has no
   * "after this" - the next track would be whichever card the list order happens
   * to put next, chosen by nobody and probably somewhere else on the canvas.
   *
   * So it decides two things, and they are the same fact seen twice: whether an
   * ended track hands over (advanceQueue), and whether the now-playing bar shows
   * a Next button (ui/nowplaying.ts). A bar offering Next for a clip that will
   * not advance on its own would be offering a move into a list nobody opened.
   */
  fromList: boolean;
}

let queueItems: Track[] = [];   // the audio items, in list order
/**
 * Tracks the list holds but next and previous step over: the ones hidden from
 * the Playlist. Held rather than dropped, because a card on the board still
 * plays through playTrack() and would find nothing to play.
 */
let skipped = new Set<Track>();
let queueOrder: number[] = [];  // indices into queueItems, in play order (shuffled or not)
let queuePos = -1;              // where we are within queueOrder
/**
 * How the current track was started. See `fromList` on the snapshot.
 *
 * True by default so that everything which does not say - a test, the lens's
 * own Play, a queueNext() - keeps the queue's plain behaviour, and only the one
 * caller that knows it is a card says otherwise.
 */
let fromList = true;
let shuffleOn = readPref(SHUFFLE_KEY) === '1';
let repeatMode: RepeatMode = readRepeat();
/** The one shared <audio>, for tracks with no card on screen. */
let player: HTMLAudioElement | null = null;
// The element the queue is driving right now. See the header: this is a card's
// own <audio> whenever the track has a card, and the shared player otherwise.
let queuePlayerEl: HTMLMediaElement | null = null;
const queueWatchers = new Set<() => void>();

/** Told when the queue's shape or mode changes (the bar repaints its buttons). */
export function onQueue(fn: () => void): () => boolean {
  queueWatchers.add(fn);
  return () => queueWatchers.delete(fn);
}
function notifyQueue(): void { for (const fn of queueWatchers) fn(); }

/** Whether `el` is the element the queue is currently driving (shared or a card's). */
export const isQueuePlayer = (el: unknown): boolean => !!queuePlayerEl && el === queuePlayerEl;

/** Shuffle mode, repeat mode, and whether the queue is the current sound. */
export function queueState(): QueueSnapshot {
  // Guarded on both ends rather than indexed straight: queuePos is -1 before
  // anything has been started, and queueOrder is rebuilt whenever the list or
  // the shuffle changes, so a stale position is a real state rather than a
  // theoretical one.
  const at = queuePos >= 0 && queuePos < queueOrder.length ? queueOrder[queuePos] : -1;
  // Counted over what the list offers: a skipped track is not "13 of 12".
  const index = at < 0 || skipped.has(queueItems[at]) ? -1
    : queueItems.slice(0, at).filter(it => !skipped.has(it)).length;
  return {
    shuffle: shuffleOn,
    repeat: repeatMode,
    active: !!queuePlayerEl && nowPlaying()?.el === queuePlayerEl,
    length: queueItems.length - skipped.size,
    index,
    fromList,
  };
}

/**
 * The element to play `item` through: its card's own <audio> when that card is on
 * the board, else the shared player. Reusing the card's element is what lets a track
 * started from the board keep its live waveform while the queue advances it.
 */
function playerFor(item: Track): HTMLMediaElement {
  // SAFETY: registeredPlayers() answers the elements canvas/transport.ts
  // registered, and it registers the <audio> and <video> a card was built with -
  // both HTMLMediaElement. The assertion is the element type of the iterable,
  // which the registry's own signature has not been annotated to say.
  for (const el of registeredPlayers() as Iterable<HTMLMediaElement>) {
    if (el !== player && ownerOf(el) === item) return el;
  }
  return ensurePlayer();
}

/** Advance when the queue's current element ends, wherever that element lives. */
function queueEnded(): void { deadRun = 0; advanceQueue(true); }
let endedBound: HTMLMediaElement | null = null;

/**
 * Move on from a track this browser will not decode, rather than stopping on it.
 *
 * Every engine refuses part of the catalogue and no two refuse the same part -
 * an AC-3, a DTS, a WMA or an AIFF plays in one browser each. Before this, a
 * queue that reached one simply stopped: the element errored, nothing was
 * listening, and the playlist sat on a track making no sound with no way to
 * know why. A track that cannot be played has not begun, so the honest thing is
 * the same as the thing done for a file whose asset has gone missing, which is
 * to step past it.
 *
 * The counter is what stops that becoming a loop. A queue of twenty AC-3 tracks
 * would otherwise skip through all twenty, wrap round under repeat 'all', and
 * do it again forever - so a run of refusals as long as the queue itself gives
 * up and says so once. It resets the moment anything actually plays.
 *
 * The card says its own half of this; see markUnplayable() in
 * canvas/renderers.ts. This is the queue's half, and the two are independent -
 * a track skipped here may not be on screen at all.
 */
let deadRun = 0;

function queueRefused(this: HTMLMediaElement): void {
  const code = this.error?.code || 0;
  // Decode and unsupported-source. An abort is somebody else's doing and a
  // network error on a blob URL is a missing asset - neither is "this engine
  // cannot read this format", and skipping over either would hide a real fault.
  if (code !== 3 && code !== 4) return;
  if (++deadRun >= Math.max(1, queueOrder.length)) {
    deadRun = 0;
    toast('Nothing in this queue plays in this browser');
    return;
  }
  advanceQueue(true);
}

/**
 * Drop what this file holds on an element that is being destroyed.
 *
 * Registered at load rather than wired from main.ts, for the reason
 * onPlayerReleased()'s own comment gives: there is one queue and one thing to
 * clean up, so this is not a decision about assembly that a boot sequence should
 * be able to get wrong. Without it, endedBound keeps an orphaned element and its
 * 'ended' listener alive until the next startCurrent() or clearQueue() happens
 * to run.
 */
onPlayerReleased((el: HTMLMediaElement) => {
  if (endedBound === el) {
    el.removeEventListener('ended', queueEnded);
    el.removeEventListener('error', queueRefused);
    endedBound = null;
  }
  if (queuePlayerEl === el) queuePlayerEl = null;
});

function ensurePlayer(): HTMLAudioElement {
  if (player) return player;
  player = new Audio();
  player.preload = 'metadata';
  // Registered once - not per track - so its 'play' hook and volume wiring are
  // set a single time. The owner is updated per track in startCurrent(). The
  // ended -> advance hook is no longer here: it rides on whichever element is the
  // queue's current voice (see startCurrent), because that may be a card's <audio>.
  registerPlayer(player);
  return player;
}

/**
 * Set the tracks the queue runs through, keeping the current one's place.
 *
 * Called by the feed whenever the playlist's order changes. It does not start or
 * stop anything - only what next/previous will reach. `skip` names tracks in
 * `items` that stay playable by name and are never reached by stepping.
 */
export function setQueue(items: readonly Track[] | null | undefined,
  skip: readonly Track[] = []): void {
  queueItems = Array.isArray(items) ? items.slice() : [];
  const held = new Set(queueItems);
  skipped = new Set(skip.filter(it => held.has(it)));
  rebuildOrder();
  notifyQueue();
}

/** The next position after `pos` that stepping may land on, or -1. */
function reachAfter(pos: number): number {
  for (let p = pos + 1; p < queueOrder.length; p += 1) {
    if (!skipped.has(queueItems[queueOrder[p]])) return p;
  }
  return -1;
}

/** The nearest position before `pos` that stepping may land on, or -1. */
function reachBefore(pos: number): number {
  for (let p = Math.min(pos, queueOrder.length) - 1; p >= 0; p -= 1) {
    if (!skipped.has(queueItems[queueOrder[p]])) return p;
  }
  return -1;
}

function rebuildOrder(): void {
  const current = nowPlaying();
  const playing = current?.el === queuePlayerEl ? current.item : null;
  queueOrder = queueItems.map((_, i) => i);
  if (shuffleOn) {
    // The shared unbiased shuffle (util.ts); the current track is pulled to the
    // front below so it does not jump away from what is playing.
    shuffle(queueOrder);
  }
  if (playing) {
    // SAFETY: `playing` is an item off the board and Track is the narrower shape
    // the queue reads one through. indexOf() compares by identity and answers -1
    // for anything it does not hold, which the line below is written for - so a
    // wrong assertion here would find nothing rather than find the wrong track.
    const idx = queueItems.indexOf(playing as Track);
    // Only when it is still in the list. `indexOf` answers -1 for a track that
    // has been deleted, and writing that into `queuePos` made the *next* thing
    // to end restart the queue at track one: advanceQueue() read `-1 >= length
    // - 1` as false, stepped to 0, and played the first track. On Mobile that
    // is the ordinary path, because the queue plays through the shared element
    // and deleting a card there never releases a registered player.
    //
    // Left where it was instead. `queuePos` still points at the slot the gone
    // track occupied, which is the slot its neighbour has now moved into - so
    // ending advances to what came after it, which is what "next" means.
    if (idx >= 0) {
      const at = queueOrder.indexOf(idx);
      if (at > 0 && shuffleOn) { queueOrder.splice(at, 1); queueOrder.unshift(idx); }
      queuePos = queueOrder.indexOf(idx);
    } else {
      queuePos = Math.min(queuePos, queueOrder.length - 1);
    }
  }
}

/**
 * Start playing a specific item, if it is in the queue.
 *
 * `from` is where the press came from, and it is the whole of what tells a list
 * apart from a board - see `fromList` on the snapshot for what turns on it. It
 * defaults to 'list' because a list is what this function was written for: the
 * rows, the lens's Play and its Shuffle all mean the same thing by it, and the
 * one caller that means something else - a card's own play button, in
 * canvas/transport.ts - is the one that passes 'board'.
 */
export function playTrack(item: Track, from: 'list' | 'board' = 'list'): void {
  const idx = queueItems.indexOf(item);
  if (idx < 0) return;
  queuePos = queueOrder.indexOf(idx);
  fromList = from === 'list';
  startCurrent();
}

/**
 * Start whatever `queuePos` points at.
 *
 * `skips` is how many tracks this call has already stepped past, and it is what
 * stops a queue whose assets have gone from either stalling or spinning. A
 * track whose bytes are missing used to return here in silence, *after*
 * queuePos had been advanced: playback simply stopped, nothing was announced,
 * and notifyQueue() was never reached so no transport repainted. A queue that
 * skips a hole is what every player does; the counter is the bound, because a
 * queue where every asset has gone would otherwise walk itself forever.
 */
function startCurrent(skips = 0): void {
  const item: Track | undefined = queueItems[queueOrder[queuePos]];
  const url: string | null = item?.asset?.hash ? assetURL(item.asset.hash) : null;
  if (!url) {
    if (skips >= queueOrder.length) { notifyQueue(); return; }
    let next = reachAfter(queuePos);
    if (next < 0 && repeatMode === 'all') next = reachAfter(-1);
    if (next < 0) { notifyQueue(); return; }
    queuePos = next;
    startCurrent(skips + 1);
    return;
  }
  const el = playerFor(item);
  if (el === player) {
    // The shared element holds whatever it last played; point it at this track.
    if (el.currentSrc !== url && el.src !== url) el.src = url;
    else el.currentTime = 0;
  } else {
    // A card's own element. It holds its src already unless the renderer parked
    // it - on an engine that rations decoders an audio card is mounted with
    // `data-src` and no source at all, so a whole board of them holds none.
    // This is the only place such an element is ever started, which is what
    // makes one line here the whole of the attach. See the audio renderer.
    if (!el.src && el.dataset.src) el.src = el.dataset.src;
    // Start it from the top.
    el.currentTime = 0;
  }
  // The ended -> advance hook follows the current voice: bound to this element while
  // it is the one playing, moved off it when the queue steps to another.
  // The refusal hook rides with it: both are "this track is over", one because
  // it finished and one because it never started. See queueRefused().
  if (endedBound && endedBound !== el) {
    endedBound.removeEventListener('ended', queueEnded);
    endedBound.removeEventListener('error', queueRefused);
  }
  if (endedBound !== el) {
    el.addEventListener('ended', queueEnded);
    el.addEventListener('error', queueRefused);
    endedBound = el;
  }
  queuePlayerEl = el;
  claimPlayer(el, item);
  setNowPlaying({ el, item });
  // Reported, not swallowed - see reportPlayError(). This is the line every
  // playlist Play press ends at, so an empty catch here meant pressing Play
  // with autoplay blocked did nothing whatever, with nothing in the console.
  // The resolve half is the run counter's reset: a track that actually started
  // is proof this browser is not simply refusing everything in the queue. See
  // queueRefused().
  el.play().then(() => { deadRun = 0; }, reportPlayError);
  notifyQueue();
}

/**
 * The next track (or previous), respecting shuffle and repeat.
 *
 * Either one makes this a list. A skip is somebody stepping *through* something,
 * which is a thing you can only be doing to a sequence - so a track that began
 * as a card on the board and was then skipped past carries on as a queue, and
 * the one after it follows. See `fromList`.
 */
export function queueNext(): void { fromList = true; advanceQueue(false); }
export function queuePrev(): void {
  if (!queueItems.length) return;
  // Within the first few seconds prev restarts the track, as every player does;
  // past that it steps back.
  if (queuePlayerEl && queuePlayerEl.currentTime > 3) { queuePlayerEl.currentTime = 0; return; }
  let prev = reachBefore(queuePos);
  if (prev < 0) prev = reachBefore(queueOrder.length);
  if (prev < 0) return;
  fromList = true;
  queuePos = prev;
  startCurrent();
}

/**
 * Whether a track that has ended may start the next one *anyway*.
 *
 * Injected by the interface (ui/nowplaying.ts/playlistOpen) rather than asked
 * for, because the answer is "is the playlist on screen" and this module sits
 * below ui/ - the same one-way seam setAssetNameLookup and setPrompt take, kept
 * that way by tests/layers.test.js. Unset - in a test, or before the bar is
 * wired - means yes, so the queue's own behaviour is the default and the gate is
 * something the interface adds.
 *
 * "Anyway" is the word that changed. This used to be the only thing that decided
 * a hand-over, so a track started from a *playlist row* stopped dead at the end
 * if the window had been closed in the meantime - which is a list that is not a
 * list. The first question is now how the track was started (`fromList`), and
 * this is the second: a track started from a card does not run on into the
 * board's other audio, unless the list is on screen, where the next track is
 * something you can see coming and stop.
 */
let advanceGate: (() => boolean) | null = null;
export const setAdvanceGate = (fn: (() => boolean) | null | undefined): void => {
  advanceGate = typeof fn === 'function' ? fn : null;
};

/**
 * Move on. `auto` is an ended track handing over versus a Next press.
 *
 * repeat 'one' replays the same track only when it ended on its own - a Next
 * press still moves on. At the end of the list, repeat 'all' wraps; otherwise an
 * automatic end stops and a Next press wraps.
 *
 * And an automatic hand-over needs one of two things to be true: the track was
 * started as a list, or the gate above agrees that the list is on screen. Only
 * the automatic one: a Next press is somebody asking, and the whole point of
 * both tests is the difference between playback you asked for and playback that
 * happened to you.
 *
 * It sits *after* the repeat-'one' branch on purpose - repeating one track is not
 * moving on to another, it is an instruction already given about the track you
 * chose, and revoking it here would make a setting mean different things
 * depending on which window was up.
 */
function advanceQueue(auto: boolean): void {
  if (!queueItems.length) return;
  if (auto && repeatMode === 'one') { startCurrent(); return; }
  if (auto && !fromList && advanceGate && !advanceGate()) return;
  let next = reachAfter(queuePos);
  if (next < 0) {
    if (repeatMode === 'all' || !auto) next = reachAfter(-1);
    if (next < 0) return;
  }
  queuePos = next;
  startCurrent();
}

export function toggleShuffle(): void {
  shuffleOn = !shuffleOn;
  writePref(SHUFFLE_KEY, shuffleOn ? '1' : '0');
  rebuildOrder();
  notifyQueue();
}

/** off -> all -> one -> off. */
export function cycleRepeat(): void {
  repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
  writePref(REPEAT_KEY, repeatMode);
  notifyQueue();
}

/**
 * Empty the queue and silence its player.
 *
 * For a board being replaced: its tracks are about to leave and their asset URLs
 * are revoked, so the shared element must let go of the one it holds. Clears the
 * now-playing entry if the queue was the sound.
 */
export function clearQueue(): void {
  const voice = queuePlayerEl;
  if (endedBound) {
    endedBound.removeEventListener('ended', queueEnded);
    endedBound.removeEventListener('error', queueRefused);
    endedBound = null;
  }
  if (voice) voice.pause();
  if (player) { player.pause(); player.removeAttribute('src'); }
  queueItems = [];
  skipped = new Set();
  queueOrder = [];
  queuePos = -1;
  // Back to the default, with the track that was started from a card. The next
  // board's first press decides this again.
  fromList = true;
  if (nowPlaying()?.el === voice) setNowPlaying(null);
  queuePlayerEl = null;
  notifyQueue();
}
