// One track at a time, running through a list.
//
// The Mobile feed's Playlist lens is a real player: next, previous, shuffle,
// repeat, and a track that hands over to the following one when it ends. That
// needs a single engine the whole board shares rather than an <audio> per row -
// so this is it. One long-lived element plays whatever track the queue points
// at; the rows are just a list that calls playTrack(), and the now-playing bar
// drives it with the transport canvas/transport.js builds plus the four buttons
// ui/nowplaying.js adds.
//
// It registers like any other player, so exclusivity still holds: starting a
// card pauses the queue and starting the queue pauses a card. nowPlaying() names
// the queue's element while it is the one sounding, and onNowPlaying() is how
// the list highlights the current row and the bar shows its controls.
//
// ── Why this is a file and not a section ──
//
// It is one *policy* about what plays next, sitting on canvas/audio.js's
// invariant that only one thing plays at all. The two were interleaved in one
// module and read as one subject, which they are not: the invariant is not
// negotiable and this is a set of choices - that prev restarts a track within
// three seconds, that shuffle keeps the current track at the front, that repeat
// cycles off/all/one. Anything importing the engine used to have to take all of
// that with it.
//
// ── The current voice, and why it is not always the shared element ──
//
// Playing a board card plays that card's own <audio>, with the queue steering
// it, so its waveform and its seek keep working; only a track with no card on
// screen - off the mobile board, or culled - falls back to the shared element
// this file makes. That is what queuePlayerEl means, and it is what
// isQueuePlayer() and queueState().active are really asking about.
//
// Which is also why the teardown is a subscription rather than a call. The
// element the queue is driving may be a card's, and a card can be thrown away
// underneath it: canvas/audio.js announces every release through
// onPlayerReleased() and this drops its two references when the element it hears
// about is the one it holds. The reverse - the engine reaching in here - is the
// import that would make these two files a cycle, and the cycle would be true.
//
// ── What must not move in here ──
//
// The exclusivity rule, the volume, and the record of what is playing. Those are
// properties of the device and belong to every player on the board, queue or
// not; a second copy of any of them in here would be a second answer to a
// question that has one.
//
// Nor any DOM. The rows, the buttons and the transport are ui/playlist.js and
// canvas/transport.js. This module has an <audio> and no elements - the shared
// player is not a node anybody sees, it is a decoder with a volume.

import type { Item } from '../board-model.ts';
import { readPref, writePref } from '../prefs.ts';
import { assetURL } from '../storage/assets.ts';
import { reportPlayError } from '../media/transport.ts';
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
}

let queueItems: Track[] = [];   // the audio items, in list order
let queueOrder: number[] = [];  // indices into queueItems, in play order (shuffled or not)
let queuePos = -1;              // where we are within queueOrder
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
  return {
    shuffle: shuffleOn,
    repeat: repeatMode,
    active: !!queuePlayerEl && nowPlaying()?.el === queuePlayerEl,
    length: queueItems.length,
    // Guarded on both ends rather than indexed straight: queuePos is -1 before
    // anything has been started, and queueOrder is rebuilt whenever the list or
    // the shuffle changes, so a stale position is a real state rather than a
    // theoretical one.
    index: queuePos >= 0 && queuePos < queueOrder.length ? queueOrder[queuePos] : -1,
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
function queueEnded(): void { advanceQueue(true); }
let endedBound: HTMLMediaElement | null = null;

/**
 * Drop what this file holds on an element that is being destroyed.
 *
 * Registered at load rather than wired from main.js, for the reason
 * onPlayerReleased()'s own comment gives: there is one queue and one thing to
 * clean up, so this is not a decision about assembly that a boot sequence should
 * be able to get wrong. Without it, endedBound keeps an orphaned element and its
 * 'ended' listener alive until the next startCurrent() or clearQueue() happens
 * to run.
 */
onPlayerReleased((el: HTMLMediaElement) => {
  if (endedBound === el) { el.removeEventListener('ended', queueEnded); endedBound = null; }
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
 * stop anything - only what next/previous will reach.
 */
export function setQueue(items: readonly Track[] | null | undefined): void {
  queueItems = Array.isArray(items) ? items.slice() : [];
  rebuildOrder();
  notifyQueue();
}

function rebuildOrder(): void {
  const current = nowPlaying();
  const playing = current?.el === queuePlayerEl ? current.item : null;
  queueOrder = queueItems.map((_, i) => i);
  if (shuffleOn) {
    // Fisher-Yates, but keep the current track at the front so shuffle does not
    // jump away from what is playing.
    for (let i = queueOrder.length - 1; i > 0; i--) {
      const j = Math.floor(mulberryLike() * (i + 1));
      [queueOrder[i], queueOrder[j]] = [queueOrder[j], queueOrder[i]];
    }
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

// A tiny time-free source of variation for shuffle. Date.now()/Math.random are
// available at runtime here (this is not the workflow sandbox); a plain
// Math.random keeps the shuffle genuinely random per press.
function mulberryLike(): number { return Math.random(); }

/** Start playing a specific item (a row tap), if it is in the queue. */
export function playTrack(item: Track): void {
  const idx = queueItems.indexOf(item);
  if (idx < 0) return;
  queuePos = queueOrder.indexOf(idx);
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
    const last = queuePos >= queueOrder.length - 1;
    if (last && repeatMode !== 'all') { notifyQueue(); return; }
    queuePos = last ? 0 : queuePos + 1;
    startCurrent(skips + 1);
    return;
  }
  const el = playerFor(item);
  if (el === player) {
    // The shared element holds whatever it last played; point it at this track.
    if (el.currentSrc !== url && el.src !== url) el.src = url;
    else el.currentTime = 0;
  } else {
    // A card's own element, already holding its src; start it from the top.
    el.currentTime = 0;
  }
  // The ended -> advance hook follows the current voice: bound to this element while
  // it is the one playing, moved off it when the queue steps to another.
  if (endedBound && endedBound !== el) endedBound.removeEventListener('ended', queueEnded);
  if (endedBound !== el) { el.addEventListener('ended', queueEnded); endedBound = el; }
  queuePlayerEl = el;
  claimPlayer(el, item);
  setNowPlaying({ el, item });
  // Reported, not swallowed - see reportPlayError(). This is the line every
  // playlist Play press ends at, so an empty catch here meant pressing Play
  // with autoplay blocked did nothing whatever, with nothing in the console.
  el.play().catch(reportPlayError);
  notifyQueue();
}

/** The next track (or previous), respecting shuffle and repeat. */
export function queueNext(): void { advanceQueue(false); }
export function queuePrev(): void {
  if (!queueItems.length) return;
  // Within the first few seconds prev restarts the track, as every player does;
  // past that it steps back.
  if (queuePlayerEl && queuePlayerEl.currentTime > 3) { queuePlayerEl.currentTime = 0; return; }
  queuePos = queuePos <= 0 ? queueOrder.length - 1 : queuePos - 1;
  startCurrent();
}

/**
 * Whether a track that has ended may start the next one.
 *
 * Injected by the interface (ui/nowplaying.js/playlistOpen) rather than asked
 * for, because the answer is "is the playlist on screen" and this module sits
 * below ui/ - the same one-way seam setAssetNameLookup and setPrompt take, kept
 * that way by tests/layers.test.js. Unset - in a test, or before the bar is
 * wired - means yes, so the queue's own behaviour is the default and the gate is
 * something the interface adds.
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
 * And an automatic hand-over needs the gate above to agree. Only the automatic
 * one: a Next press is somebody asking, and the whole point of the gate is the
 * difference between playback you asked for and playback that happened to you.
 * It sits *after* the repeat-'one' branch on purpose - repeating one track is not
 * moving on to another, it is an instruction already given about the track you
 * chose, and revoking it here would make a setting mean different things
 * depending on which window was up.
 */
function advanceQueue(auto: boolean): void {
  if (!queueItems.length) return;
  if (auto && repeatMode === 'one') { startCurrent(); return; }
  if (auto && advanceGate && !advanceGate()) return;
  const last = queuePos >= queueOrder.length - 1;
  if (last) {
    if (repeatMode === 'all' || !auto) queuePos = 0;
    else return;
  } else {
    queuePos += 1;
  }
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
  if (endedBound) { endedBound.removeEventListener('ended', queueEnded); endedBound = null; }
  if (voice) voice.pause();
  if (player) { player.pause(); player.removeAttribute('src'); }
  queueItems = [];
  queueOrder = [];
  queuePos = -1;
  if (nowPlaying()?.el === voice) setNowPlaying(null);
  queuePlayerEl = null;
  notifyQueue();
}
