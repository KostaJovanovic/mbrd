// The bar along the foot: what is playing, and the controls for it.
//
// A board is a wall of clips you can only operate by looking at them. The
// transport is drawn on the card, so steering away from the card takes the
// pause button with it - and on an infinite canvas "away" is one flick. This is
// the transport again, pinned to the glass, so the thing making a noise can
// always be stopped by whoever is listening to it.
//
// Audio and video both. A video that has left the screen is still running, and
// whether the thing you can hear also had a picture is not a reason to withhold
// a pause button for it - if anything the case is stronger, since a clip you
// cannot see is one you cannot reach for. What differs is only the notation:
// video gets the plain line its own card carries and audio gets the measured
// waveform, which is buildTransport's `line` option and nothing more.
//
// It is deliberately not a second player. The <audio> in the card is still the
// engine; this binds a second buildTransport() to that same element, so the card
// and the bar are two views of one clip and stay in step without a line of
// syncing code between them. Seek from either and both move, because there is
// only one thing to move.
//
// Two rAF loops run while a clip plays, one per view. That is the price of not
// writing a second transport with its own idea of what a waveform looks like,
// and it is one loop for one clip - the exclusive-playback rule in
// canvas/audio.js means there is never a second.
//
// What keeps the sound going once the card is gone is not here: it is
// sounding() in canvas/items.js, which exempts a playing card from the cull.
// Removing a media element from the document pauses it, so without that the bar
// would be a remote for something the browser had already stopped.
//
// It stays through a pause. A paused track is still the track you were
// listening to, and a bar that vanished the moment you stopped it would mean
// finding the card again to start it back up - which is the problem this exists
// to solve. It goes when you close it, or when the clip itself goes away.
//
// It also stays while the sidebar is open, alone among the corner furniture.
// The bin and the add bar act on the board the panel is covering, so they have
// nothing to do while it is up; a player does not stop being a player because
// somebody opened the settings, and hiding it meant the only way to silence a
// track was to close the panel you had just gone to. The CSS moves it clear of
// the panel rather than taking it away - see the #sidebar.is-open rule there.
//
// Arriving and leaving are CSS, and the only reason this file knows about them
// is [hidden]: display:none leaves no box for a transition to happen in, so the
// element has to come out of it a frame before it rises, and go into it a fade
// after it has gone. raise() and hide() are those two orderings and nothing
// else - what the movement looks like is four custom properties per whimsy
// tier, at the foot of the CSS.

import {
  buildTransport, nowPlaying, onNowPlaying, clearNowPlaying,
  getVolume, onVolume, setVolume, volumeLocked,
} from '../canvas/audio.js';
import { baseName } from '../util.js';

let bar = null, caption = null, slot = null, volume = null, closeBtn = null;

/** The transport currently in the bar, and the way to take it back apart. */
let shown = null;      // the item it was built for
let abort = null;      // its listeners on the <audio>

/**
 * The exit, in flight: the function that calls it off, or 0.
 *
 * [hidden] is display:none, so a bar that took it the moment a track ended
 * would vanish rather than leave - there would be no box left for the fade to
 * happen in. So the class comes off first, the CSS plays, and only then does
 * the element go. Held here because a track starting mid-fade has to be able to
 * call the whole thing off, rather than let it finish and hide the bar it has
 * just filled.
 */
let leaving = 0;

/**
 * Long enough for any tier's exit, which is --dur-fast even at the slow end.
 *
 * A backstop rather than the timing: transitionend is what normally ends the
 * exit. It is here because that event is not guaranteed - a bar that is already
 * display:none for some other reason never transitions, and a bar left at
 * opacity 0 with pointer-events still on would be a row of invisible buttons
 * over the board.
 */
const EXIT_CAP = 600;

export function initNowPlaying() {
  bar = document.getElementById('nowplaying');
  if (!bar) return;
  caption = bar.querySelector('.np-name');
  slot = bar.querySelector('.np-transport');
  volume = bar.querySelector('#np-volume');
  closeBtn = bar.querySelector('.np-close');

  // The same iPhone Safari case the sidebar's slider makes: writes to media
  // volume are ignored there, so a slider that appeared to set it would be a
  // lie. The sidebar replaces itself with the instruction; there is no room for
  // a sentence down here, so this simply goes.
  if (volumeLocked()) {
    volume?.closest('.np-volume')?.remove();
    volume = null;
  } else if (volume) {
    const paint = () => {
      const pct = Math.round(getVolume() * 100);
      if (volume.value !== String(pct)) volume.value = String(pct);
      volume.setAttribute('aria-valuetext', pct + '%');
    };
    paint();
    onVolume(paint);
    volume.addEventListener('input', () => setVolume(+volume.value / 100));
  }

  closeBtn?.addEventListener('click', close);

  // The keys the canvas also wants. A bar you can reach with Tab must not also
  // nudge the selection behind it, and the transport inside makes the same
  // bargain for the arrows - see the keydown handler in canvas/audio.js.
  bar.addEventListener('keydown', e => {
    if (e.key === 'Escape') { close(); e.stopPropagation(); }
  });

  onNowPlaying(show);
  show(nowPlaying());
}

/**
 * Put a track in the bar, or take the bar away.
 *
 * Rebuilt per track rather than repointed, because a transport is built around
 * one element and one set of readings; a bar that swapped the <audio> underneath
 * a live waveform would be drawing the last file's shape over this one's sound.
 */
function show(current) {
  if (!bar) return;
  if (!current) { hide(); return; }
  if (current.item === shown) return;

  // Whatever was on its way out is not going any more - the box it was leaving
  // is about to hold a different track.
  cancelExit();
  teardown();
  shown = current.item;

  abort = new AbortController();
  slot.replaceChildren(
    buildTransport(current.item, current.el, {
      signal: abort.signal,
      // Not `.item` - there is no card here. Alive for exactly as long as this
      // is the transport the bar is showing.
      alive: () => shown === current.item,
      // A line for video, the measured waveform for audio - the same pair the
      // two card types already show, so the bar never draws a clip in a
      // notation its own card does not use. buildTransport says what it costs
      // to measure a video instead.
      line: current.item.type === 'video',
    }),
  );
  caption.textContent = name(current.item);
  caption.title = current.item.name || '';
  raise();
}

/**
 * Out of display:none and into place, in that order and not in one go.
 *
 * A transition needs two computed styles to run between, and an element that
 * was display:none has no first one - set both in the same frame and the
 * browser has nothing to animate from, so the bar would appear at full opacity
 * with no arrival at all. Reading offsetWidth is what forces the intermediate
 * style to be resolved; it is the one place in this file where a layout flush
 * is the point rather than the cost.
 */
function raise() {
  bar.hidden = false;
  void bar.offsetWidth;
  bar.classList.add('is-up');
}

/**
 * Stop what is playing and put the bar away. Both, because either alone is half
 * an answer to a close button on a player.
 *
 * It goes through canvas/audio.js rather than calling hide() here, and that is
 * not ceremony: the record of what is playing has to be let go of too, or the
 * next press of that same card's play button announces a track that is already
 * on record and the bar never comes back. Clearing it comes back round as
 * show(null), which is the one path that hides this thing.
 */
function close() {
  nowPlaying()?.el?.pause();
  clearNowPlaying();
}

/**
 * Play the exit, then clear up behind it.
 *
 * The transport stays in the bar for the length of the fade. Emptying it first
 * would show the bar going blank and *then* leaving, which reads as two events
 * where there is one.
 */
function hide() {
  if (!bar || bar.hidden) { teardown(); return; }
  if (leaving) return;                 // already on its way

  bar.classList.remove('is-up');

  // One property, or this fires once per transitioned property and finishes on
  // whichever of opacity and transform the engine happens to end first.
  const onEnd = e => { if (e.target === bar && e.propertyName === 'opacity') done(); };
  const done = () => { cancelExit(); bar.hidden = true; teardown(); };

  bar.addEventListener('transitionend', onEnd);
  const timer = setTimeout(done, EXIT_CAP);
  leaving = () => {
    clearTimeout(timer);
    bar.removeEventListener('transitionend', onEnd);
    leaving = 0;
  };
}

/**
 * Call off an exit in flight.
 *
 * Both halves, and the listener is the half that matters. A timer left running
 * would hide a bar that had come back; a `transitionend` left attached is
 * worse, because the next thing it hears is the *entry* fade finishing, and it
 * would take the bar away at the exact moment it finished arriving.
 */
function cancelExit() {
  if (leaving) leaving();
}

function teardown() {
  abort?.abort();
  abort = null;
  shown = null;
  slot?.replaceChildren();
}

/**
 * What to call it. baseName() drops the extension, the same reading the trash
 * list takes - "Interview 3" and not "Interview 3.m4a", because the card beside
 * it does not say the extension either.
 */
function name(item) {
  if (item.name) return baseName(item.name) || item.name;
  return item.type === 'video' ? 'Video' : 'Audio';
}
