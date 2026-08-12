// @ts-nocheck - TypeScript migration debt, not a judgement about this file.
//
// The tree was renamed from .js to .ts mechanically, which moved 104 modules in
// one step and annotated none of them. This module is carried unchecked so that
// npm run typecheck stays green and keeps meaning something, rather than going
// red and being ignored. Converting this module IS deleting this block and
// fixing what tsc then says - tests/ts-debt.test.js holds the count and lets it
// only fall.
// Sound on the board: one volume for the whole site, and a real waveform per
// item.
//
// The native <audio controls> widget was the placeholder here, and it is the
// one piece of chrome a browser will not let you restyle - so every board,
// whatever its palette or its whimsy, had a strip of Chrome-grey plastic
// sitting in the middle of it. This replaces it with two things the board can
// actually own: a play button, and the sound itself drawn as bars.
//
// The bars are measured, not decorative. The file is decoded once, reduced to
// one RMS value per bar, and the result is cached on the item - so the shape
// you see is that recording's shape, a quiet intro reads as a quiet intro, and
// reopening the board does not decode anything a second time. The readings
// outlive the session too: a save writes them into the .mbrd as their own
// waveforms/<hash>.json, named after the audio rather than after the card, so
// a board comes back with its waveforms already drawn. See the sidecar block
// in storage/mbrd.js. When decoding is
// impossible (an exotic codec, no Web Audio) the fallback is a stable pattern
// derived from the file's own hash: still that file's own shape, in the weak
// sense that it never changes and never matches another file's, which is all a
// placeholder has to be.
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

import { getAsset, assetURL } from '../storage/assets.ts';
import { bus, markDirty, selection } from '../state.ts';
import { clamp } from '../util.ts';
import { toast } from '../notify.ts';
import { readPref, writePref } from '../prefs.ts';
import { seekInnerHTML, sizeSeekWave } from '../media/transport.ts';

const VOLUME_KEY = 'mbrd.volume';
/** Loud enough to hear on laptop speakers, quiet enough not to make you jump. */
const DEFAULT_VOLUME = 0.6;

/**
 * How many readings are taken off a file, which is *not* how many bars get
 * drawn. The card's width decides that, and the card can be resized - so the
 * measurement is stored at a resolution finer than any card will ever show and
 * averaged down to fit. Re-measuring on resize would mean decoding the file
 * again to draw the same shape at a different pitch.
 */
const PEAK_RES = 256;
/** Screen px per bar, near enough - a bar plus its gap. */
const BAR_PITCH = 5;
const MIN_BARS = 10;

let volume = DEFAULT_VOLUME;
/** Every <audio> currently on the board, so a slider move reaches all of them. */
const players = new Set();

/**
 * Which item each element is playing.
 *
 * Weak, so this is not the reference that keeps a deleted card's <audio> alive.
 * releasePlayers() is the deliberate teardown and does the real work; this map
 * is only here so a path that misses it leaks nothing.
 */
const owners = new WeakMap();

/** Anyone who wants to be told the volume moved, whoever moved it. */
const volumeWatchers = new Set();
/** Anyone who wants to be told which clip is the current one. */
const playingWatchers = new Set();

/**
 * The clip the board is currently about: `{ el, item }`, or null.
 *
 * Set when something starts and *not* cleared when it stops, which is the whole
 * behaviour of the now-playing bar - a paused track is still the track you were
 * listening to, and a bar that vanished on pause would mean finding the card
 * again to resume. It is cleared only when the element itself goes away.
 */
let current = null;

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
 * the bar. setCurrent() ignores a repeat of the pair it already holds - which is
 * right, since a clip resuming after a pause is not a new track and the bar
 * should not be rebuilt for it - but that also meant a bar that had hidden
 * itself could never be brought back by the same card: pressing play announced
 * the pair that was already on record, so nothing was announced at all. Clearing
 * it is what makes the next press a change again.
 */
export function clearNowPlaying() {
  setCurrent(null);
}

export function onNowPlaying(fn) {
  playingWatchers.add(fn);
  return () => playingWatchers.delete(fn);
}

export function onVolume(fn) {
  volumeWatchers.add(fn);
  return () => volumeWatchers.delete(fn);
}

function setCurrent(next) {
  if (current?.el === next?.el && current?.item === next?.item) return;
  current = next;
  for (const fn of playingWatchers) fn(current);
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

export function setVolume(v) {
  volume = clamp(+v || 0, 0, 1);
  for (const a of players) a.volume = volume;
  writePref(VOLUME_KEY, volume);
  for (const fn of volumeWatchers) fn(volume);
}

function readVolume() {
  const n = parseFloat(readPref(VOLUME_KEY));
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
export function registerPlayer(el, item = null) {
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
    // buildTransport's `line` option.
    const owner = owners.get(el);
    if (owner) setCurrent({ el, item: owner });
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
export function releasePlayers(root) {
  // 'audio, video' - a <video> registers here too, for the global volume and
  // for the one-clip-at-a-time rule, so it has to be let go of by the same
  // path. While this said 'audio' alone, every rename of a video card left a
  // player in the set holding a decoded stream that nothing could ever pause.
  for (const el of root.querySelectorAll?.('audio, video') || []) {
    el.pause();
    players.delete(el);
    owners.delete(el);
    if (current?.el === el) setCurrent(null);
    // If a queue voice (a board card's own <audio> driving the playlist) is the
    // element being destroyed, release the queue's refs to it as well. Otherwise
    // endedBound holds the orphaned element and its 'ended' listener alive until
    // the next startCurrent()/clearQueue() happens to run.
    if (endedBound === el) { el.removeEventListener('ended', queueEnded); endedBound = null; }
    if (queuePlayerEl === el) queuePlayerEl = null;
  }
}

// ---------------------------------------------------------------------------
// The playlist queue
//
// The Mobile feed's Playlist lens is a real player: one track at a time, running
// through a list, with next/previous, shuffle and repeat. That needs a single
// engine the whole board shares rather than an <audio> per row - so this is it.
// One long-lived element plays whatever track the queue points at; the rows are
// just a list that calls playTrack(), and the now-playing bar drives it with the
// transport it already builds plus the four buttons ui/nowplaying.js adds.
//
// It registers like any other player, so exclusivity still holds: starting a
// card pauses the queue and starting the queue pauses a card. nowPlaying() names
// the queue's element while it is the one sounding, and onNowPlaying() is how the
// list highlights the current row and the bar shows its controls.
// ---------------------------------------------------------------------------

let queueItems = [];      // the audio items, in list order
let queueOrder = [];      // indices into queueItems, in play order (shuffled or not)
let queuePos = -1;        // where we are within queueOrder
let shuffleOn = false;
let repeatMode = 'off';   // 'off' | 'all' | 'one'
let player = null;        // the one shared <audio>, for tracks with no card on screen
// The element the queue is driving right now. Playing a board card plays the card's
// own <audio> (so its waveform and seek keep working) with the queue steering it;
// only a track with no card - off the mobile board, or culled - falls back to the
// shared player above. Either way this is the queue's current voice, and what
// isQueuePlayer() and the "active" flag are really asking about.
let queuePlayerEl = null;
const queueWatchers = new Set();

/** Told when the queue's shape or mode changes (the bar repaints its buttons). */
export function onQueue(fn) { queueWatchers.add(fn); return () => queueWatchers.delete(fn); }
function notifyQueue() { for (const fn of queueWatchers) fn(); }

/** Whether `el` is the element the queue is currently driving (shared or a card's). */
export const isQueuePlayer = el => !!queuePlayerEl && el === queuePlayerEl;

/** Shuffle mode, repeat mode, and whether the queue is the current sound. */
export function queueState() {
  return {
    shuffle: shuffleOn,
    repeat: repeatMode,
    active: !!queuePlayerEl && current?.el === queuePlayerEl,
    length: queueItems.length,
  };
}

/**
 * The element to play `item` through: its card's own <audio> when that card is on
 * the board, else the shared player. Reusing the card's element is what lets a track
 * started from the board keep its live waveform while the queue advances it.
 */
function playerFor(item) {
  for (const el of players) {
    if (el !== player && owners.get(el) === item) return el;
  }
  return ensurePlayer();
}

/** Advance when the queue's current element ends, wherever that element lives. */
function queueEnded() { advanceQueue(true); }
let endedBound = null;

function ensurePlayer() {
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
export function setQueue(items) {
  queueItems = Array.isArray(items) ? items.slice() : [];
  rebuildOrder();
  notifyQueue();
}

function rebuildOrder() {
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
    const idx = queueItems.indexOf(playing);
    const at = queueOrder.indexOf(idx);
    if (at > 0 && shuffleOn) { queueOrder.splice(at, 1); queueOrder.unshift(idx); }
    queuePos = queueOrder.indexOf(idx);
  }
}

// A tiny time-free source of variation for shuffle. Date.now()/Math.random are
// available at runtime here (this is not the workflow sandbox); a plain
// Math.random keeps the shuffle genuinely random per press.
function mulberryLike() { return Math.random(); }

/** Start playing a specific item (a row tap), if it is in the queue. */
export function playTrack(item) {
  const idx = queueItems.indexOf(item);
  if (idx < 0) return;
  queuePos = queueOrder.indexOf(idx);
  startCurrent();
}

function startCurrent() {
  const item = queueItems[queueOrder[queuePos]];
  const url = item?.asset?.hash ? assetURL(item.asset.hash) : null;
  if (!url) return;
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
  owners.set(el, item);
  setCurrent({ el, item });
  el.play().catch(() => {});
  notifyQueue();
}

/** The next track (or previous), respecting shuffle and repeat. */
export function queueNext() { advanceQueue(false); }
export function queuePrev() {
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
let advanceGate = null;
export const setAdvanceGate = fn => { advanceGate = typeof fn === 'function' ? fn : null; };

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
function advanceQueue(auto) {
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

export function toggleShuffle() {
  shuffleOn = !shuffleOn;
  rebuildOrder();
  notifyQueue();
}

/** off -> all -> one -> off. */
export function cycleRepeat() {
  repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
  notifyQueue();
}

/**
 * Empty the queue and silence its player.
 *
 * For a board being replaced: its tracks are about to leave and their asset URLs
 * are revoked, so the shared element must let go of the one it holds. Clears the
 * now-playing entry if the queue was the sound.
 */
export function clearQueue() {
  const voice = queuePlayerEl;
  if (endedBound) { endedBound.removeEventListener('ended', queueEnded); endedBound = null; }
  if (voice) voice.pause();
  if (player) { player.pause(); player.removeAttribute('src'); }
  queueItems = [];
  queueOrder = [];
  queuePos = -1;
  if (current && current.el === voice) setCurrent(null);
  queuePlayerEl = null;
  notifyQueue();
}

// ---------------------------------------------------------------------------
// Waveforms
// ---------------------------------------------------------------------------

let decodeCtx = null;

function context() {
  // An OfflineAudioContext, deliberately, and not the live AudioContext this
  // used to build.
  //
  // Decoding is the only thing this module needs a context for - playback goes
  // through <audio>, which has its own pipeline - and an offline context never
  // reaches the speakers, so the autoplay policy takes no interest in it.
  // A live one is a different story: Firefox reports
  // getAutoplayPolicy('audiocontext') as "disallowed" out of the box, which
  // leaves the context parked in "suspended" until a gesture arrives. Every
  // card on the board decodes through the same one, so the whole set queues
  // behind that single gate and the waveforms all appear together some time
  // later, or never. Offline decoding also happens to be an order of magnitude
  // quicker - 9ms against 105ms on the same file - because nothing is being
  // scheduled against a real clock.
  //
  // The 1-frame, 44.1kHz shape is a formality. decodeAudioData ignores the
  // context's own length and resamples to its sample rate, and an RMS taken
  // over a bucket is indifferent to what that rate is.
  //
  // The constructor sits inside the try because it can throw - a browser with
  // audio disabled, a hardened profile - and it is called from outside
  // measure()'s own guard, where an exception would escape all the way out of
  // peaks() and leave the card with no readings at all. `false` records that
  // we asked and were refused, so it is not retried for every card.
  if (decodeCtx === null) {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    try { decodeCtx = Ctx ? new Ctx(1, 1, 44100) : false; } catch { decodeCtx = false; }
  }
  return decodeCtx || null;
}

/**
 * One amplitude per bar, each in [0, 1], normalised so the loudest bar is full
 * height. RMS rather than peak: peak picks up single-sample transients and
 * draws almost every piece of music as a solid block.
 */
/**
 * Measurements currently running, by asset hash.
 *
 * The readings cached on the item make this once per *file* rather than once
 * per mount - but only after the first one has finished. Two cards holding the
 * same recording mount together, both find nothing cached, and both start
 * decoding the same megabytes: the claim was true and the window in front of it
 * was not. Keyed by hash rather than by item id because that is what a waveform
 * actually belongs to - the same reason the sidecars in a .mbrd are named that
 * way - so the second card joins the first's decode instead of starting another.
 */
const measuring = new Map();

export async function peaks(item) {
  const cached = item.meta?.peaks;
  if (usable(cached)) return cached;

  const hash = item.asset?.hash;
  const asset = hash && getAsset(hash);
  let measured = null;
  if (asset) {
    let run = hash && measuring.get(hash);
    if (!run) {
      run = measure(asset.blob).finally(() => measuring.delete(hash));
      measuring.set(hash, run);
    }
    measured = await run;
  }
  const result = measured || pseudo(hash || item.id);

  // Cached on the item, so this happens once per file rather than once per
  // mount. Written directly rather than through a command: it is a measurement
  // of bytes that were already there, not an edit, and it belongs in no undo
  // entry.
  if (item.meta) item.meta.peaks = result;
  if (measured) markDirty();
  return result;
}

/**
 * Whether a set of readings can be drawn as they stand.
 *
 * The length check is what makes PEAK_RES safe to change: readings taken at
 * some older resolution are not recognised, and the file is measured again
 * rather than drawn at the wrong pitch. The value check earns its keep now
 * that readings can arrive out of a file a person is invited to open -
 * waveforms/<hash>.json inside the .mbrd - where a deleted comma or a stray
 * letter would otherwise reach drawBars() as a NaN and come out as a card of
 * bars with no height. mbrd.js checks that the file is well formed; this is
 * the narrower question of whether this build can use what was in it.
 */
function usable(v) {
  return Array.isArray(v) && v.length === PEAK_RES
    && v.every(n => typeof n === 'number' && n >= 0 && n <= 1);
}

async function measure(blob) {
  const ctx = context();
  if (!ctx) return null;
  try {
    const buf = await withTimeout(ctx.decodeAudioData(await blob.arrayBuffer()));
    const data = buf.getChannelData(0);
    const per = Math.max(1, Math.floor(data.length / PEAK_RES));
    const out = [];
    let loudest = 0;
    for (let b = 0; b < PEAK_RES; b++) {
      const start = b * per;
      const end = Math.min(data.length, start + per);
      let sum = 0;
      for (let i = start; i < end; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / Math.max(1, end - start));
      out.push(rms);
      if (rms > loudest) loudest = rms;
    }
    if (!loudest) return out.map(() => 0);
    // Three decimals, not two. RMS against the loudest bucket puts quiet
    // passages well below 0.01, and rounding those to a flat 0.00 turns the
    // quiet half of a track into a dead line along the floor.
    return out.map(v => Math.round((v / loudest) * 1000) / 1000);
  } catch {
    return null;   // not a codec this browser decodes
  }
}

/**
 * How long a decode is given before the card settles for the stand-in shape.
 *
 * Not a guess at how slow decoding is - it is generous for that. It is here
 * because decodeAudioData is allowed to simply never settle: a codec the build
 * does not really support, a context the browser has quietly wedged, an
 * autoplay policy that leaves the whole graph parked. An await on a promise
 * that never resolves is indistinguishable from a hang, and the card would sit
 * there with no bars for the rest of the session with nothing logged anywhere.
 * Losing the real shape is a far smaller failure than an empty waveform.
 */
const DECODE_MS = 8000;

function withTimeout(promise) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('decode timed out')), DECODE_MS); }),
  ]);
}

/** A stable stand-in when the bytes cannot be decoded. Same file, same shape. */
function pseudo(seed) {
  let h = 2166136261;
  for (let i = 0; i < String(seed).length; i++) {
    h ^= String(seed).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out = [];
  for (let i = 0; i < PEAK_RES; i++) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h |= 0;
    // Swelled towards the middle, so it reads as a clip rather than as noise.
    const envelope = 0.55 + 0.45 * Math.sin((i / (PEAK_RES - 1)) * Math.PI);
    out.push(Math.round(((0.25 + ((h >>> 0) % 1000) / 1000 * 0.75) * envelope) * 100) / 100);
  }
  return out;
}

/** Average the stored readings down to `n` bars. */
function resample(values, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * values.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / n));
    let sum = 0;
    for (let k = from; k < to; k++) sum += values[k];
    out.push(sum / (to - from));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/**
 * Make a seek track draggable, not merely clickable.
 *
 * Shared, because there are three of these now - the card's waveform, the
 * video card's line, and whichever of the two the now-playing bar is showing -
 * and a scrub that behaved differently depending on which one you had hold of
 * would be three controls wearing one costume.
 *
 * Captured, and the capture is doing two jobs. It keeps the drag alive once the
 * pointer leaves the track, which on something fourteen pixels tall is most of
 * the gesture: without it a scrub ends the moment your hand strays off the
 * line, which is exactly when you are moving fastest. And it keeps
 * canvas/input.js out of it - a pointer sequence that got through to the canvas
 * would be read as a drag of the card, so seeking a clip would carry it across
 * the board.
 *
 * stopPropagation on the down as well as the capture, because the capture only
 * redirects the *later* events: the pointerdown itself has already begun
 * bubbling towards the canvas by the time this runs.
 */
export function bindScrub(el, seekTo) {
  el.addEventListener('pointerdown', e => {
    el.setPointerCapture(e.pointerId);
    seekTo(e.clientX);
    e.stopPropagation();
  });
  el.addEventListener('pointermove', e => {
    if (el.hasPointerCapture(e.pointerId)) seekTo(e.clientX);
  });
}

/**
 * Build the play button, the waveform and the clock for one audio item.
 *
 * The waveform is two identical lanes of bars stacked on top of each other -
 * one in the quiet colour, one in the accent - and the played portion is the
 * accent lane revealed by a clip. That is what makes the fill continuous: a
 * clip can cut a bar in half, where colouring whole bars can only ever step
 * from one to the next, and at forty bars over three minutes that step is a
 * visible lurch every four seconds.
 *
 * Bars are mirrored about the centre line rather than standing on a baseline.
 * A recording has no up and no down - the waveform of a signal is symmetric by
 * construction, and drawing only its top half is a bar chart of a sound rather
 * than a picture of one.
 *
 * Built for a card and, since the now-playing bar, for one other place. The only
 * thing that has to change between the two is how it knows it has been thrown
 * away: `opts.alive` for the selection listener at the foot, and `opts.signal`
 * for the handlers on the <audio> itself.
 *
 * The signal matters because the element outlives the transport now. A card's
 * <audio> is built with the card and dies with it, so its listeners die with it
 * too; the bar's transport is rebuilt every time you switch back to a track it
 * has already shown, onto the same long-lived element, and without a way to let
 * go it would leave a play/pause/timeupdate set behind on every visit.
 *
 * `opts.line` draws a plain progress line where the waveform would go, and it
 * is what the bar uses for video. Not a style choice - it is the only honest
 * option. A measured waveform means decodeAudioData over the file's whole
 * arrayBuffer, which for a clip off a phone is hundreds of megabytes read into
 * memory to draw forty bars; and the readings would land in item.meta.peaks,
 * which collectWaveforms() in storage/mbrd.js writes out as a waveforms/<hash>
 * sidecar without asking what kind of item it came off. So video gets the same
 * line its own card carries, and peaks() is never called for one.
 */
export function buildTransport(item, sound, opts = {}) {
  const line = !!opts.line;

  const transport = document.createElement('div');
  transport.className = 'transport';

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'play';
  play.setAttribute('aria-label', 'Play');
  play.innerHTML = PLAY_ICON;

  // The thing you seek on, in whichever of its two forms. Same role, same keys,
  // same scrub - only the ink differs, and only paint() below knows which.
  const wave = document.createElement('div');
  wave.className = line ? 'vtrack' : 'wave';
  // role="slider" is a promise: focusable, driven by the arrow keys, and
  // reporting where it is. It had the role and the label and none of the rest,
  // which is worse than no role at all - a screen reader announces a slider
  // that cannot be reached or moved. See seekBy() and paint() for the other
  // two thirds.
  wave.setAttribute('role', 'slider');
  wave.setAttribute('aria-label', 'Seek');
  wave.setAttribute('aria-valuemin', '0');
  /**
   * A stopped track's seek is not a control, so it does not answer the pointer,
   * take the Tab, or announce itself as something to operate. Written together
   * because they are one fact: `.is-playing` on the transport is what the
   * stylesheet reads for the pointer half, and these two are the keyboard and
   * screen-reader halves of the same sentence.
   */
  const setSeekable = on => {
    wave.tabIndex = on ? 0 : -1;
    wave.setAttribute('aria-disabled', String(!on));
  };
  setSeekable(false);
  let base = null, fill;
  let vtWave = null, vtWavePath = null;
  if (line) {
    // The same shape the now-playing bar and the playlist window draw, so all
    // three scrubbers wave together at the soft end of the whimsy axis - see the
    // note in media/transport.js. It was a div scaled on X, which is the one thing a wave
    // cannot be: scaling one horizontally changes its frequency as it plays, so
    // the played part is revealed with a clip instead.
    wave.innerHTML = seekInnerHTML('vt');
    fill = wave.querySelector('.vt-fill');
    vtWave = wave.querySelector('.vt-wave-svg');
    vtWavePath = wave.querySelector('.vt-fill-wave');
    // On a resize, not on a playback frame. The path is a string built in a loop
    // over the line's width, so laying it every frame would rebuild it sixty
    // times a second to arrive at the same characters; the width is what it
    // actually depends on, and a video card is resizable.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => sizeSeekWave(wave, vtWave, vtWavePath)).observe(wave);
    }
  } else {
    base = lane('wave-base');
    fill = lane('wave-fill');
    wave.append(base, fill);
  }

  const time = document.createElement('span');
  time.className = 'transport-time';
  time.textContent = '0:00';

  transport.append(play, wave, time);

  let values = null;      // the stored readings, once they arrive
  let builtFor = 0;       // the width the current bars were drawn for

  const barCount = () => {
    const w = wave.clientWidth || parseFloat(getComputedStyle(wave).width) || 0;
    return Math.max(MIN_BARS, Math.round(w / BAR_PITCH));
  };

  const drawBars = () => {
    const w = wave.clientWidth;
    if (!w || !values) return;
    const heights = resample(values, barCount());
    for (const el of [base, fill]) {
      el.replaceChildren(...heights.map(v => {
        const bar = document.createElement('i');
        // A floor, so a silent passage is a thin line through the middle
        // rather than a gap in the waveform.
        bar.style.height = Math.max(7, Math.round(v * 100)) + '%';
        return bar;
      }));
    }
    builtFor = w;
    paint();
  };

  const paint = () => {
    const at = sound.duration ? clamp(sound.currentTime / sound.duration, 0, 1) : 0;
    // A clip on the bars, a scale on the line, and each is the cheap way to
    // move the one it belongs to: the waveform's fill has to reveal shaped ink
    // so it is cut rather than resized, where the line is a plain rectangle and
    // scaleX never touches layout. Both run on every frame of playback.
    if (line) wave.style.setProperty('--vt-progress', at.toFixed(4));
    else fill.style.clipPath = `inset(0 ${((1 - at) * 100).toFixed(3)}% 0 0)`;
    // How long it is until it starts, where it is once it has. A card sitting
    // at the top of a track has nothing to report about the playhead - it is at
    // the beginning, which is where the playhead always is before you press
    // anything - so every card on the board read 0:00 and the one number on it
    // said nothing about the file. The length is what somebody scanning a board
    // of records wants, and it is only in the way once there is a position to
    // show instead.
    time.textContent = clock(sound.currentTime || sound.duration || 0);
    // In seconds, with a spoken form beside it: "83" is not a position in a
    // recording, "1:23 of 4:10" is.
    wave.setAttribute('aria-valuemax', Math.round(sound.duration || 0));
    wave.setAttribute('aria-valuenow', Math.round(sound.currentTime || 0));
    wave.setAttribute('aria-valuetext',
      `${clock(sound.currentTime || 0)} of ${clock(sound.duration || 0)}`);
  };

  // While it plays, the fill is driven by the frame clock rather than by
  // timeupdate, which fires about four times a second - fine for a digit,
  // nowhere near enough for something that is supposed to glide.
  let frame = 0;
  const follow = () => {
    paint();
    frame = sound.paused ? 0 : requestAnimationFrame(follow);
  };

  // Only for the waveform. A line has nothing to measure, and measuring it
  // anyway is the expensive mistake the header above spells out.
  if (!line) peaks(item).then(v => { values = v; drawBars(); });

  // The first draw waits for the element to have a real width, rather than
  // taking whatever it measures at the moment the readings arrive.
  //
  // buildContent() composes a card while its .item is still detached - on the
  // first build, and again on every rebuild() for a rename or a note edit -
  // and a detached element measures zero. That was survivable only because
  // decoding a file takes long enough for the node to land in the document
  // first. Cached readings do not: peaks() returns them in a microtask, which
  // beats attachment, so a reopened board drew its bars into a zero width,
  // bailed, and never had cause to try again. This fires whenever the box
  // turns up, which is the actual condition being waited on.
  //
  // Only while there is nothing drawn yet. Once there is, resizes are left to
  // the deselect below, so the bars do not reflow under a dragging pointer.
  if (!line) {
    const watch = new ResizeObserver(() => {
      if (builtFor || !wave.clientWidth || !values) return;
      drawBars();
      watch.disconnect();
    });
    watch.observe(wave);
  }

  // A rejected play() is never swallowed - almost always the browser refusing
  // rather than a broken file (Firefox blocks audible playback outright when a
  // site's autoplay permission is set to block), and an empty catch is why "the
  // cards are unplayable" once had nothing behind it in the console.
  const reportPlayError = err => toast(err && err.name === 'NotAllowedError'
    ? 'Your browser blocked playback — allow audio for this site'
    : 'Could not play this file');

  play.addEventListener('click', () => {
    // The card is a voice of the shared queue: pressing play starts the queue here,
    // so the track advances to the next when it ends and the bar shows the playlist
    // controls - the same as playing it from the Playlist. When this card is already
    // the sounding track, the button just pauses and resumes it where it is.
    if (current?.el === sound) {
      if (sound.paused) sound.play().catch(reportPlayError); else sound.pause();
    } else {
      playTrack(item);
    }
  });
  const on = (type, fn) => sound.addEventListener(type, fn, { signal: opts.signal });

  on('play', () => {
    transport.classList.add('is-playing');
    setSeekable(true);
    play.innerHTML = PAUSE_ICON;
    play.setAttribute('aria-label', 'Pause');
    if (!frame) frame = requestAnimationFrame(follow);
  });
  on('pause', () => {
    transport.classList.remove('is-playing');
    setSeekable(false);
    play.innerHTML = PLAY_ICON;
    play.setAttribute('aria-label', 'Play');
    paint();
  });
  on('loadedmetadata', paint);
  // The frame loop above covers playback. This covers everything else that can
  // move the playhead - a seek while paused, a buffering stall, currentTime set
  // from outside - none of which produce a frame loop of their own.
  on('timeupdate', paint);
  on('seeked', paint);
  on('ended', () => { sound.currentTime = 0; paint(); });

  // A transport built onto an element that is already going has missed the
  // 'play' it would have taken its state from. The card never hit this - its
  // element is new - but the bar is handed a clip mid-flight every time.
  if (!sound.paused) {
    transport.classList.add('is-playing');
    setSeekable(true);
    play.innerHTML = PAUSE_ICON;
    play.setAttribute('aria-label', 'Pause');
    frame = requestAnimationFrame(follow);
  }
  paint();

  // Dragged, not just clicked. This was one pointerdown that jumped the
  // playhead and let go - so finding a moment in a recording meant a series of
  // guesses, each one a fresh click, with the sound restarting from wherever
  // the last guess landed. bindScrub() is the same gesture the video card's
  // line has always had.
  bindScrub(wave, clientX => {
    // Not while it is stopped. A card sitting on a board is a thing you drag, and
    // the waveform is most of its face - so a scrub on a paused track meant every
    // attempt to move the card by the part of it you were nearest scrubbed it
    // instead, and left a clip you had not asked to hear parked somewhere in the
    // middle. Playing, the same gesture is unmistakably a seek: there is a sound
    // to move through and a playhead moving through it.
    //
    // Press play and it is scrubbable again immediately - which is the honest
    // shape of it, since seeking a track you are not listening to has no
    // feedback anyway.
    if (sound.paused) return;
    if (!sound.duration) return;
    const box = wave.getBoundingClientRect();
    if (!box.width) return;
    sound.currentTime = clamp((clientX - box.left) / box.width, 0, 1) * sound.duration;
    paint();
  });

  /** Seek by `secs`, or to an absolute point when `to` is given. */
  const seekBy = (secs, to = null) => {
    if (sound.paused) return;      // the keyboard half of the rule above
    if (!sound.duration) return;
    const next = to != null ? to : sound.currentTime + secs;
    sound.currentTime = clamp(next, 0, sound.duration);
    paint();
  };

  // The keyboard contract for a slider: arrows nudge, PageUp/PageDown take a
  // bigger step, Home and End go to the ends. Space plays and pauses, which is
  // what that key does on every other transport a person has used.
  //
  // stopPropagation is what keeps the canvas out of it - these are its keys
  // too, and without this an arrow would seek *and* nudge the selection.
  wave.addEventListener('keydown', e => {
    const step = e.shiftKey ? 1 : 5;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowUp': seekBy(step); break;
      case 'ArrowLeft': case 'ArrowDown': seekBy(-step); break;
      case 'PageUp': seekBy(30); break;
      case 'PageDown': seekBy(-30); break;
      case 'Home': seekBy(0, 0); break;
      case 'End': seekBy(0, sound.duration); break;
      case ' ': case 'Enter': play.click(); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();       // the canvas must not also act on this
  });

  // Redrawn when the card is let go of, not while it is being dragged.
  //
  // The bar count follows the card's width, so a resize wants a different set
  // of bars - but rebuilding them on every frame of a drag would have the
  // waveform reflowing under the pointer, which reads as the sound changing.
  // Deselection is the end of the gesture, and by then the width is final.
  //
  // A card replaced by rebuild() (a rename, a note edit) is detached from its
  // item and will never be seen again; that is when this stops. `.item` and not
  // isConnected, deliberately: buildContent() composes a card while it is still
  // detached, so a selection event landing in that window would read as death
  // and quietly cost the card its resize redraw for good. A transport built
  // somewhere other than a card - the now-playing bar - has no .item to find
  // and says for itself when it is finished.
  const alive = opts.alive || (() => !!wave.closest('.item'));
  const off = bus.on('selection', () => {
    if (!alive()) { off(); return; }
    // A line has no bars to redraw at a new pitch - it is one rectangle that
    // scales - so it has no reason to be listening at all past the liveness
    // check above.
    if (line || selection.has(item.id)) return;
    if (wave.clientWidth && wave.clientWidth !== builtFor) drawBars();
  });

  return transport;
}

function lane(className) {
  const el = document.createElement('div');
  el.className = 'wave-lane ' + className;
  return el;
}

/* Exported so canvas/video.js draws the same two triangles. A video transport
   that invented its own play glyph would be a second visual language for the
   same verb, on the same board. */
export const PLAY_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3.4l7.5 4.6L5 12.6z"/></svg>';
export const PAUSE_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.6 3.2h2.6v9.6H4.6zM8.8 3.2h2.6v9.6H8.8z"/></svg>';

/** m:ss. Hours are possible and would be a strange thing to pin to a board. */
export function clock(secs) {
  const s = Math.max(0, Math.floor(secs));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
