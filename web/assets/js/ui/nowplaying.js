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
  nowPlaying, onNowPlaying, clearNowPlaying,
  getVolume, onVolume, setVolume, volumeLocked,
  bindScrub, clock, PLAY_ICON, PAUSE_ICON,
  queueNext, queuePrev, toggleShuffle, cycleRepeat, queueState, onQueue,
} from '../canvas/audio.js';
import { board } from '../state.js';
import { setLens, currentLens } from './board-view.js';
import { togglePlayerWindow } from './playlist.js';
import { baseName, clamp } from '../util.js';

let bar = null, caption = null, controls = null, volume = null, closeBtn = null;
// The seek line, its ends' times, and the play button - the bar's own transport,
// bound to whatever element is playing (a card's <audio>, or the shared queue).
let seekWrap = null, lineEl = null, elapsedEl = null, totalEl = null, playBtn = null;
// The wave's own svg and path, sized to the bar's pixel width so the frequency
// does not stretch with it - see sizeWave() and the WAVE_HALF note above.
let waveSvg = null, wavePathEl = null;
// The playlist controls: prev/next/shuffle/repeat, shown only while the queue is
// the sound. Play sits among them but is always shown.
let shuffleBtn = null, repeatBtn = null;
// The playback follow loop and the current seek handler, per bound element.
let frame = 0;
let seekTo = null;

const PREV_ICON = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 3.5h1.4v9H4.5z"/><path d="M12 3.9v8.2L6.3 8z"/></svg>';
const NEXT_ICON = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M10.1 3.5h1.4v9h-1.4z"/><path d="M4 3.9v8.2L9.7 8z"/></svg>';
const SHUFFLE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5h2.5L11 11.5h3"/><path d="M2 11.5h2.5l2-2.2"/><path d="M9.5 6.7 11 4.5"/><path d="M12.2 2.8 14 4.5l-1.8 1.7"/><path d="M12.2 9.8 14 11.5l-1.8 1.7"/></svg>';
const REPEAT_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6V5.2A1.7 1.7 0 0 1 6.2 3.5H12"/><path d="m10.3 1.8 1.9 1.7-1.9 1.7"/><path d="M11.5 10v.8a1.7 1.7 0 0 1-1.7 1.7H4"/><path d="m5.7 14.2-1.9-1.7 1.9-1.7"/></svg>';
const REPEAT_ONE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6V5.2A1.7 1.7 0 0 1 6.2 3.5H12"/><path d="m10.3 1.8 1.9 1.7-1.9 1.7"/><path d="M11.5 10v.8a1.7 1.7 0 0 1-1.7 1.7H4"/><path d="m5.7 14.2-1.9-1.7 1.9-1.7"/><text x="8" y="10.2" font-size="6" fill="currentColor" stroke="none" text-anchor="middle">1</text></svg>';
// A little list with a play triangle: the way in to the full player.
const LIST_ICON = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2" y="3.2" width="8" height="1.6" rx="0.8"/><rect x="2" y="7.2" width="8" height="1.6" rx="0.8"/><rect x="2" y="11.2" width="5" height="1.6" rx="0.8"/><path d="M11.4 7v5l3.3-2.5z"/></svg>';

// A sine drawn in the seek line's own pixels, 8 tall (centre line at 4), so its
// wavelength is the same on a narrow phone bar and a wide desktop one. The bug
// this replaces was a path in a fixed 0..100 viewBox stretched to the element
// width, which made the frequency a function of how wide the bar happened to be -
// wide bars drew slow rolling swells, narrow ones a tight ripple. The wave svg's
// viewBox is sized to the measured pixel width instead (see sizeWave), so one user
// unit is one pixel and WAVE_HALF is a real, constant half-period.
//
// Drawn with the stroke unscaled so it stays thin however wide the bar is; shown
// only at the soft end of the whimsy axis, where the seek is a Material-style wave
// rather than a straight line.
//
// WAVE_HALF is a half period in px (smaller = higher frequency); the path runs two
// whole periods past the width so the slow leftward scroll (the np-wave animation
// in the CSS) has crest to bring in from the right without a gap - it translates by
// one period (2 * WAVE_HALF, kept in step with the keyframe there) and loops, which
// is seamless because the wave repeats.
const WAVE_HALF = 7;
function buildWavePath(width) {
  let d = 'M0 4';
  let up = true;
  for (let x = 0; x < width + 4 * WAVE_HALF; x += WAVE_HALF) {
    d += ` Q${x + WAVE_HALF / 2} ${up ? 2 : 6} ${x + WAVE_HALF} 4`;
    up = !up;
  }
  return d;
}

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
  controls = bar.querySelector('.np-controls');
  seekWrap = bar.querySelector('.np-seek');
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

  // The controls on the right, in order: a Playlist button, then shuffle, prev,
  // play, next, repeat, then volume and close (already in the markup). Play is
  // always shown; the four playlist buttons show only while the queue is the sound -
  // CSS keys that off the .is-queue class paintQueue() sets. All inserted before the
  // volume.
  const before = controls.querySelector('.np-volume') || closeBtn;
  // The way in to the full player: the Playlist lens on a Mobile board (a second
  // press steps back to the Feed), the floating window on the Desktop.
  const listBtn = ctlBtn('np-list', 'Open the playlist', LIST_ICON, openPlaylist);
  shuffleBtn = ctlBtn('np-shuffle', 'Shuffle', SHUFFLE_ICON, toggleShuffle);
  const prevBtn = ctlBtn('np-prev', 'Previous', PREV_ICON, queuePrev);
  playBtn = ctlBtn('np-play', 'Play', PLAY_ICON, togglePlay);
  const nextBtn = ctlBtn('np-next', 'Next', NEXT_ICON, queueNext);
  repeatBtn = ctlBtn('np-repeat', 'Repeat', REPEAT_ICON, cycleRepeat);
  for (const b of [listBtn, shuffleBtn, prevBtn, playBtn, nextBtn, repeatBtn]) {
    controls.insertBefore(b, before);
  }
  onQueue(paintQueue);

  // The seek line under both rows: a muted base, an accent fill clipped to the
  // played fraction (--np-progress), and the times at its ends. The fill carries
  // both a straight line and a wave; the CSS shows one per whimsy tier.
  seekWrap.innerHTML =
    '<span class="np-time np-elapsed">0:00</span>'
    + '<div class="np-line" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0">'
    +   '<svg class="np-line-svg" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">'
    +     '<path class="np-line-base" d="M0 4H100" vector-effect="non-scaling-stroke"/></svg>'
    +   '<div class="np-line-fill">'
    +     '<svg class="np-line-svg" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">'
    +       '<path class="np-fill-line" d="M0 4H100" vector-effect="non-scaling-stroke"/></svg>'
    // The wave lives in its own svg, whose viewBox is sized to the bar's pixel width
    // (sizeWave) so its wavelength does not stretch with the bar. It is wrapped in a
    // group so its two transforms do not fight: the path carries the leftward scroll
    // (an animation on transform), the group carries the flatten-when-paused (a
    // transition on transform). One element cannot do both, since a running animation
    // owns the whole transform. The `d` is filled in by sizeWave once there is a width.
    +     '<svg class="np-line-svg np-wave-svg" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">'
    +       '<g class="np-wave-scale"><path class="np-fill-wave" vector-effect="non-scaling-stroke"/></g></svg>'
    // Two closes, not one: the first ends .np-line-fill, the second ends .np-line
    // itself. With only one, .np-line stayed open and the .np-total span below
    // parsed as a child of the scrubber - landing at its top-left, the length
    // sitting on top of the seek line instead of after it.
    +   '</div></div>'
    + '<span class="np-time np-total">0:00</span>';
  lineEl = seekWrap.querySelector('.np-line');
  elapsedEl = seekWrap.querySelector('.np-elapsed');
  totalEl = seekWrap.querySelector('.np-total');
  waveSvg = seekWrap.querySelector('.np-wave-svg');
  wavePathEl = seekWrap.querySelector('.np-fill-wave');
  sizeWave();
  // The bar's width follows the window and the two time labels, both of which
  // change without a track change, so the wave is re-laid whenever the line
  // resizes rather than only when a track is bound.
  if (typeof ResizeObserver === 'function') new ResizeObserver(sizeWave).observe(lineEl);
  bindScrub(lineEl, clientX => seekTo?.(clientX));

  // The keys the canvas also wants. A bar you can reach with Tab must not also
  // nudge the selection behind it; the seek line answers the arrows itself.
  bar.addEventListener('keydown', e => {
    if (e.key === 'Escape') { close(); e.stopPropagation(); }
  });
  lineEl.addEventListener('keydown', onSeekKey);

  onNowPlaying(show);
  show(nowPlaying());
}

/**
 * Put a track in the bar, or take the bar away.
 *
 * Re-bound per track rather than repointed: the fill, the times and the play icon
 * are driven off the element that is playing, and swapping the element underneath
 * a live follow loop would leave the last track's listeners on the new one.
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

  bind(current.el);
  caption.textContent = name(current.item);
  caption.title = current.item.name || '';
  paintQueue();
  raise();
  // The bar was display:none until raise(), where the line read zero width and
  // the ResizeObserver had nothing to size against; now it has a box.
  sizeWave();
}

/**
 * Size the wave's viewBox to the seek line's pixel width and lay the path across
 * it, so one user unit is one pixel and the wavelength (2 * WAVE_HALF) is the same
 * at every bar width. Runs on build, on every resize of the line, and each time a
 * track is shown - the bar is display:none until then, where the width reads zero.
 */
function sizeWave() {
  if (!waveSvg || !wavePathEl || !lineEl) return;
  const w = Math.round(lineEl.clientWidth);
  if (w < 1) return;
  waveSvg.setAttribute('viewBox', `0 0 ${w} 8`);
  wavePathEl.setAttribute('d', buildWavePath(w));
}

/**
 * Drive the bar off one element: the play button, the seek line and the times.
 *
 * A frame loop moves the fill while it plays (timeupdate fires four times a
 * second, nowhere near enough for a line that should glide); the events cover a
 * seek, a stall or a currentTime written from elsewhere. Its listeners are on an
 * AbortController so teardown() drops them in one call.
 */
function bind(sound) {
  abort = new AbortController();
  const signal = abort.signal;

  const paint = () => {
    const dur = sound.duration || 0;
    const cur = sound.currentTime || 0;
    lineEl.style.setProperty('--np-progress', (dur ? clamp(cur / dur, 0, 1) : 0).toFixed(4));
    elapsedEl.textContent = clock(cur);
    totalEl.textContent = clock(dur);
    lineEl.setAttribute('aria-valuemax', Math.round(dur));
    lineEl.setAttribute('aria-valuenow', Math.round(cur));
    lineEl.setAttribute('aria-valuetext', `${clock(cur)} of ${clock(dur)}`);
  };
  const follow = () => { paint(); frame = sound.paused ? 0 : requestAnimationFrame(follow); };
  const setIcon = () => {
    const playing = !sound.paused;
    // .is-paused stops the wave scrolling and flattens it to a straight line; the
    // CSS animates both back when it comes off.
    bar.classList.toggle('is-paused', !playing);
    playBtn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  };

  const on = (type, fn) => sound.addEventListener(type, fn, { signal });
  on('play', () => { setIcon(); if (!frame) frame = requestAnimationFrame(follow); });
  on('pause', () => { setIcon(); paint(); });
  on('loadedmetadata', paint);
  on('timeupdate', paint);
  on('seeked', paint);

  seekTo = clientX => {
    if (!sound.duration) return;
    const box = lineEl.getBoundingClientRect();
    if (!box.width) return;
    sound.currentTime = clamp((clientX - box.left) / box.width, 0, 1) * sound.duration;
    paint();
  };

  setIcon();
  paint();
  if (!sound.paused && !frame) frame = requestAnimationFrame(follow);
}

/** The seek line's keyboard: arrows nudge, Home/End jump, space plays. */
function onSeekKey(e) {
  const sound = nowPlaying()?.el;
  if (!sound) return;
  const step = e.shiftKey ? 1 : 5;
  const set = to => { if (sound.duration) sound.currentTime = clamp(to, 0, sound.duration); };
  switch (e.key) {
    case 'ArrowRight': case 'ArrowUp': set(sound.currentTime + step); break;
    case 'ArrowLeft': case 'ArrowDown': set(sound.currentTime - step); break;
    case 'Home': set(0); break;
    case 'End': set(sound.duration); break;
    case ' ': case 'Enter': togglePlay(); break;
    default: return;
  }
  e.preventDefault();
  e.stopPropagation();
}

/**
 * Open the full player. On a Mobile board that is the Playlist lens - and a second
 * press, while it is up, steps back to the Feed; on the Desktop it is the floating
 * window, toggled open and shut.
 */
function openPlaylist() {
  if (board.layoutMode === 'mobile') setLens(currentLens() === 'playlist' ? 'feed' : 'playlist');
  else togglePlayerWindow();
}

/** Play or pause whatever the bar is bound to. */
function togglePlay() {
  const sound = nowPlaying()?.el;
  if (!sound) return;
  if (sound.paused) sound.play().catch(() => {});
  else sound.pause();
}

/** Build one round icon button for the controls cluster. */
function ctlBtn(className, label, icon, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'np-qbtn ' + className;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.innerHTML = icon;
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Show the playlist controls only while the queue is what is playing, and reflect
 * the shuffle and repeat modes on their buttons (repeat has three states, so its
 * glyph carries the "one" case).
 */
function paintQueue() {
  if (!bar) return;
  const { shuffle, repeat, active } = queueState();
  // The four playlist buttons live in the flow always; CSS hides them off this
  // class, so play stays put between prev and next rather than shifting when they
  // come and go.
  bar.classList.toggle('is-queue', active);
  shuffleBtn.setAttribute('aria-pressed', String(shuffle));
  repeatBtn.setAttribute('aria-pressed', String(repeat !== 'off'));
  repeatBtn.innerHTML = repeat === 'one' ? REPEAT_ONE_ICON : REPEAT_ICON;
  repeatBtn.setAttribute('aria-label',
    repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat all' : 'Repeat');
  repeatBtn.title = repeatBtn.getAttribute('aria-label');
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
  seekTo = null;
  if (frame) { cancelAnimationFrame(frame); frame = 0; }
  lineEl?.style.setProperty('--np-progress', '0');
  if (elapsedEl) elapsedEl.textContent = '0:00';
  if (totalEl) totalEl.textContent = '0:00';
  if (playBtn) { playBtn.innerHTML = PLAY_ICON; playBtn.setAttribute('aria-label', 'Play'); }
}

/**
 * What to call it. baseName() drops the extension, the same reading the trash
 * list takes - "Interview 3" and not "Interview 3.m4a", because the card beside
 * it does not say the extension either.
 */
function name(item) {
  const title = item.meta?.trackTitle
    || (item.name ? baseName(item.name) || item.name : (item.type === 'video' ? 'Video' : 'Audio'));
  return item.meta?.artist ? `${title} — ${item.meta.artist}` : title;
}
