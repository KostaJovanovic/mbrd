// Sound on the board: one volume for the whole site, one clip at a time, and
// the answer to "what is playing".
//
// This is what is left of the file that used to be all of the audio - the
// engine, the playlist queue, the waveform decoder and the control strip in one
// place, at a thousand lines. The other three are now:
//
//   canvas/playlist-queue.ts   the queue the Playlist lens runs through
//   canvas/waveform.ts         decode -> one RMS reading per bar
//   canvas/transport.ts        the play button, the bars and the clock
//   media/transport.ts         the parts of that strip with no dependencies
//                              at all - the scrub gesture, the two glyphs, m:ss
//
// and every one of them depends on this rather than the other way round, which
// is the property that made the split worth making: the engine is the thing with
// no opinion about playlists, waveforms or buttons, and it was the thing nobody
// could import without taking all three.
//
// ── What this owns ──
//
// Volume is deliberately one global rather than per item. It is a property of
// the room you are sitting in, not of any one clip, and a board with six clips
// on it would otherwise mean six sliders to turn down. The value is held here
// and handed out through getVolume()/onVolume(); the one slider that writes it
// is on the now-playing bar, and it is a slider rather than the owner of the
// number precisely so that where the control lives stays somebody else's
// decision. It has moved once already - it was a row in the sidebar - and this
// file did not have to change for it.
//
// This file also answers "what is playing", because it is the only place that
// can. The exclusive-playback listener below already hears every start on every
// element, by any route, which is exactly the question ui/nowplaying.js asks.
// Deliberately not on the `bus`: what is coming out of the speakers is a fact
// about this device at this moment, not a property of the board, and it belongs
// in a .mbrd no more than the volume does.
//
// ── What must not move back in ──
//
// Anything that builds a node. The whole reason the native <audio controls>
// widget was replaced is that a browser will not let you restyle it, and what
// replaced it is a card's worth of DOM - which is canvas/transport.ts's job and
// not this one. A module that owns the elements *and* draws them is the module
// this used to be.
//
// Nor the queue. The queue is one policy about what plays next, out of several
// this app could have had; the exclusivity rule below is the invariant every one
// of them would have to obey. Keeping the invariant under the policy is what
// lets releasePlayers() below stay the single teardown path - see the release
// listeners, which are how the queue is told without this file having to know
// there is one.

import { clamp } from '../util.ts';
import { readPref, writePref } from '../prefs.ts';
import type { Item } from '../board-model.ts';

/**
 * <audio> or <video>, always both. A video card registers here for the global
 * volume and for the one-clip-at-a-time rule, and every path below that says
 * "player" means either of them - see releasePlayers() on what it cost when one
 * of them said 'audio' alone.
 */
export type Player = HTMLMediaElement;

/** The clip the board is currently about: the element, and what it is playing. */
export type NowPlaying = { el: Player; item: Item };

const VOLUME_KEY = 'mbrd.volume';
/** Loud enough to hear on laptop speakers, quiet enough not to make you jump. */
const DEFAULT_VOLUME = 0.6;

let volume = DEFAULT_VOLUME;
/** Every <audio> currently on the board, so a slider move reaches all of them. */
const players = new Set<Player>();

/**
 * Which item each element is playing.
 *
 * Weak, so this is not the reference that keeps a deleted card's <audio> alive.
 * releasePlayers() is the deliberate teardown and does the real work; this map
 * is only here so a path that misses it leaks nothing.
 */
const owners = new WeakMap<Player, Item>();

/** Anyone who wants to be told the volume moved, whoever moved it. */
const volumeWatchers = new Set<(v: number) => void>();
/** Anyone who wants to be told which clip is the current one. */
const playingWatchers = new Set<(now: NowPlaying | null) => void>();

/**
 * Anyone who has their own references to an element being destroyed.
 *
 * The queue is the only subscriber and this exists because of the direction of
 * the split: canvas/playlist-queue.ts holds two references to whichever element
 * it is currently driving - the 'ended' listener that advances it, and the
 * element itself - and both have to be dropped when a card is thrown away.
 * releasePlayers() used to reach in and clear them, because they were fields of
 * this same file; a module that imported the queue back to do it now would be a
 * cycle, and the cycle would be saying something true, that the engine depends
 * on the policy running on top of it.
 *
 * So it is announced instead, in the same shape as onVolume() and onNowPlaying()
 * beside it. The queue subscribes when it loads rather than being wired from
 * main.ts, which is deliberate: this is not a choice about how the app is
 * assembled - there is exactly one queue and it has exactly one thing to clean
 * up - and a boot sequence that has to remember it would be a boot sequence that
 * can forget it.
 */
const releaseWatchers = new Set<(el: Player) => void>();

/**
 * The clip the board is currently about: `{ el, item }`, or null.
 *
 * Set when something starts and *not* cleared when it stops, which is the whole
 * behaviour of the now-playing bar - a paused track is still the track you were
 * listening to, and a bar that vanished on pause would mean finding the card
 * again to resume. It is cleared only when the element itself goes away.
 */
let current: NowPlaying | null = null;

export const nowPlaying = () => current;
export const getVolume = () => volume;

/**
 * Play or pause whatever is currently the sound. Returns whether it did anything -
 * false when nothing is loaded, so a caller (the Space key) can fall back to its
 * own use of the key when there is no track to toggle.
 */
export function togglePlayback() {
  const el = current?.el;
  if (!el) return false;
  if (el.paused) el.play().catch(() => {}); else el.pause();
  return true;
}

/**
 * Let go of the current track without touching the element it names.
 *
 * What "close the player" means, and it has to be said here rather than done in
 * the bar. setNowPlaying() ignores a repeat of the pair it already holds - which is
 * right, since a clip resuming after a pause is not a new track and the bar
 * should not be rebuilt for it - but that also meant a bar that had hidden
 * itself could never be brought back by the same card: pressing play announced
 * the pair that was already on record, so nothing was announced at all. Clearing
 * it is what makes the next press a change again.
 */
export function clearNowPlaying() {
  setNowPlaying(null);
}

export function onNowPlaying(fn: (now: NowPlaying | null) => void) {
  playingWatchers.add(fn);
  return () => playingWatchers.delete(fn);
}

export function onVolume(fn: (v: number) => void) {
  volumeWatchers.add(fn);
  return () => volumeWatchers.delete(fn);
}

/** Told when an element is torn down, so its own references can go with it. */
export function onPlayerReleased(fn: (el: Player) => void) {
  releaseWatchers.add(fn);
  return () => releaseWatchers.delete(fn);
}

/**
 * Announce the current clip. Exported for the queue, which is the only thing
 * besides registerPlayer() below that knows a track has changed before the
 * element does - it points a long-lived element at a new file, and the pair
 * `{ el, item }` moves without any event firing on the element itself.
 */
export function setNowPlaying(next: NowPlaying | null): void {
  if (current?.el === next?.el && current?.item === next?.item) return;
  current = next;
  for (const fn of playingWatchers) fn(current);
}

/** Every element currently under the global volume, in registration order. */
export const registeredPlayers = () => players.values();

/** What `el` is playing, or undefined. There is no way back from an element otherwise. */
export const ownerOf = (el: Player) => owners.get(el);

/** Say that `el` is now playing `item`. What the queue does as it repoints a player. */
export function claimPlayer(el: Player, item: Item | null | undefined): void {
  if (item) owners.set(el, item);
}

/**
 * Take the stored volume up, before anything can be built against it.
 *
 * All this does now. The sidebar used to carry the slider and this used to wire
 * it, but the control moved to the now-playing bar - a volume dial is reached
 * for while something is playing, and that is exactly when the bar is up, where
 * in the panel it was two clicks away from the sound it was about. Still called
 * from main.js and still called first, because ui/nowplaying.js paints its
 * slider from getVolume() on the way up.
 */
export function initAudio() {
  volume = readVolume();
}

/**
 * Whether this engine ignores writes to media volume (iPhone Safari).
 *
 * Set a probe element's volume away from full and read it straight back: a
 * browser that honours the property returns what was written, one that locks it
 * to the hardware returns 1. Synchronous by spec - the volume attribute is not
 * async - so no clip has to exist or play for this to be true.
 *
 * What it is for: a slider that writes volume where the write is ignored is a
 * lie - it would read "20%" while every clip plays at the system level (Safari
 * audit S2). ui/nowplaying.js takes its slider off rather than show one. iPadOS
 * gained script-controlled volume in Safari 26, so this only fires where it
 * genuinely cannot work.
 */
export function volumeLocked() {
  try {
    const probe = new Audio();
    probe.volume = 0.5;
    return probe.volume === 1;
  } catch {
    return false;   // no Audio constructor to probe with: leave the control as it was
  }
}

export function setVolume(v: number): void {
  volume = clamp(+v || 0, 0, 1);
  for (const a of players) a.volume = volume;
  writePref(VOLUME_KEY, volume);
  for (const fn of volumeWatchers) fn(volume);
}

function readVolume() {
  // readPref answers null for a key that was never written, and parseFloat was
  // stringifying that to "null" and getting NaN. The empty string is the same
  // NaN with nothing to work out.
  const n = parseFloat(readPref(VOLUME_KEY) ?? '');
  return Number.isFinite(n) ? clamp(n, 0, 1) : DEFAULT_VOLUME;
}

/**
 * Put an <audio> under the global volume.
 *
 * The set deliberately survives culling: culling detaches a node and puts it
 * back, and unregistering on detach would silently drop a player out of the
 * volume control for the rest of the session. What it must not survive is a
 * node being *destroyed* - see releasePlayers, and canvas/items.js/discard for
 * the one place that tells the difference.
 *
 * `item` is what the element is playing, and it is taken rather than looked up
 * because there is no way back from a media element to a board item - the card
 * around it is the only link, and the card is exactly what stops being reachable
 * when this matters. Optional so a caller with nothing to say can say nothing;
 * an element with no item simply never becomes the current one.
 */
export function registerPlayer(el: Player, item: Item | null = null): void {
  el.volume = volume;
  players.add(el);
  if (item) owners.set(el, item);

  // One clip at a time. A board is a wall of things you are looking at
  // together, and two of them talking over each other is not a mix, it is a
  // mess - so starting one stops whatever else was going.
  //
  // Hung on the element's own 'play' event rather than on the play button,
  // because the button is not the only way playback starts: a seek on a paused
  // clip, a media key, the OS notification controls, and anything added later
  // all arrive here and nowhere else. Elements whose card has since been
  // deleted are still in the set and are simply already paused, so the loop
  // does not need to know about them.
  el.addEventListener('play', () => {
    for (const other of players) {
      // One clip at a time, and the one you left goes back to its start: this is a
      // player, not a set of bookmarks. Pausing a different track and returning to
      // it should begin it again, not resume it mid-way - so the clip that yields
      // is rewound here as it is stopped. The same clip paused and resumed in place
      // never passes through here (nothing else started), so that still continues.
      if (other !== el && !other.paused) { other.pause(); other.currentTime = 0; }
    }
    // Hung on the same event and for the same reason it is: this is the one
    // place that hears a start however it was started, so it is the one place
    // that can answer what the current clip is. Video as well as audio - a clip
    // that has left the screen is still running, and the argument for being able
    // to stop the thing you can hear does not turn on whether it also had a
    // picture. The bar draws it as a line rather than a waveform; see
    // buildTransport's `line` option in canvas/transport.js.
    const owner = owners.get(el);
    if (owner) setNowPlaying({ el, item: owner });
  });
}

/**
 * Let go of every player inside a card that is being thrown away.
 *
 * The set used to hold every <audio> ever built, on the reasoning that a few
 * dead references were cheaper than teaching items.js about node lifetimes.
 * That estimate only held while nodes were rare. A rename or a note edit
 * rebuilds a card's whole content, so editing one audio card ten times left
 * ten players in here, and every one of them still owned a decoded stream and
 * still got iterated on every volume change and every play.
 *
 * Paused on the way out as well: an element with no card is an element nobody
 * can stop, and the exclusive-playback loop above only pauses things it can
 * still see.
 *
 * And the one thing that clears the current track. This is the only event that
 * means the element is finished with - a rename rebuilds a card's content and
 * orphans its <audio>, a delete throws the card away - and without it the bar
 * would sit there holding a node no longer attached to anything, offering a
 * play button that would start a clip with no card behind it.
 */
export function releasePlayers(root: Element): void {
  // 'audio, video' - a <video> registers here too, for the global volume and
  // for the one-clip-at-a-time rule, so it has to be let go of by the same
  // path. While this said 'audio' alone, every rename of a video card left a
  // player in the set holding a decoded stream that nothing could ever pause.
  for (const el of root.querySelectorAll?.<Player>('audio, video') || []) {
    el.pause();
    players.delete(el);
    owners.delete(el);
    if (current?.el === el) setNowPlaying(null);
    // Last, and after the current track is cleared, because that is the order
    // this ran in while the queue's two fields were fields of this file. A queue
    // voice being destroyed has an 'ended' listener and a reference to release;
    // otherwise nothing is listening and this costs an empty loop.
    for (const fn of releaseWatchers) fn(el);
  }
}
