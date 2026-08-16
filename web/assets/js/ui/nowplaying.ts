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
// waveform. This used to point at buildTransport's `line` option for that, an
// option nothing ever passed and which is now gone; the bar draws both forms
// itself, out of the pieces named in the paragraph below.
//
// It is deliberately not a second player. The <audio> in the card is still the
// engine; this builds its own strip over that same element - bindScrub() and
// clock() from media/transport.ts, not a second buildTransport() - so the card
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
} from '../canvas/audio.ts';
import { setAdvanceGate } from '../canvas/playlist-queue.ts';
import { bindScrub, clock, PAUSE_ICON, PLAY_ICON } from '../media/transport.ts';
import { board } from '../state.ts';
import { tickSlider } from './controls.ts';
import { setLens, currentLens } from './board-view.ts';
import { togglePlayerWindow, isPlayerWindowOpen } from './playlist.ts';
import { baseName, clamp } from '../util.ts';
import { seekInnerHTML, sizeSeekWave, reportPlayError } from '../media/transport.ts';
import type { NowPlaying } from '../canvas/audio.ts';
import type { Item } from '../board-model.ts';

// The bar and everything in it, taken once in initNowPlaying(). It returns
// early without #nowplaying, and every path below that reads one of these is
// reached either from that function or from an event bound inside it - which is
// why they are read with `!` rather than guarded a second time.
let bar: HTMLElement | null = null;
let caption: HTMLElement | null = null;
let controls: HTMLElement | null = null;
let volume: HTMLInputElement | null = null;
let closeBtn: HTMLElement | null = null;
// The seek line, its ends' times, and the play button - the bar's own transport,
// bound to whatever element is playing (a card's <audio>, or the shared queue).
let seekWrap: HTMLElement | null = null;
let lineEl: HTMLElement | null = null;
let elapsedEl: HTMLElement | null = null;
let totalEl: HTMLElement | null = null;
let playBtn: HTMLElement | null = null;
// The wave's own svg and path, sized to the bar's pixel width so the frequency
// does not stretch with it - see sizeWave() and the WAVE_HALF note above.
let waveSvg: SVGSVGElement | null = null;
let wavePathEl: SVGPathElement | null = null;
// The playback follow loop and the current seek handler, per bound element.
let frame = 0;
let seekTo: ((clientX: number) => void) | null = null;

// A little list with a play triangle: the way in to the full player.
const LIST_ICON = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2" y="3.2" width="8" height="1.6" rx="0.8"/><rect x="2" y="7.2" width="8" height="1.6" rx="0.8"/><rect x="2" y="11.2" width="5" height="1.6" rx="0.8"/><path d="M11.4 7v5l3.3-2.5z"/></svg>';


/** The transport currently in the bar, and the way to take it back apart. */
let shown: Item | null = null;      // the item it was built for
let boundEl: HTMLMediaElement | null = null;   // and the element it is driving
let abort: AbortController | null = null;      // its listeners on the <audio>

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
let leaving: (() => void) | 0 = 0;

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
  // #np-volume is the range input in the bar's markup.
  volume = bar.querySelector<HTMLInputElement>('#np-volume');
  // Handed over like every range in the app. It runs 0 to 100 in ones, so
  // tickSlider() will decline it - a hundred ticks across one drag is a buzz,
  // not a dial. Wired anyway so the rule is *every slider*, with the helper
  // making the judgement rather than this file making an exception.
  tickSlider(volume);
  closeBtn = bar.querySelector('.np-close');

  // The same iPhone Safari case the sidebar's slider makes: writes to media
  // volume are ignored there, so a slider that appeared to set it would be a
  // lie. The sidebar replaces itself with the instruction; there is no room for
  // a sentence down here, so this simply goes.
  if (volumeLocked()) {
    volume?.closest('.np-volume')?.remove();
    volume = null;
  } else if (volume) {
    // Held as a const so the `else if (volume)` above still counts inside the
    // two closures: the module binding is reassigned on the branch beside this
    // one, so the narrowing would not follow it in.
    const slider = volume;
    const paint = () => {
      const pct = Math.round(getVolume() * 100);
      if (slider.value !== String(pct)) slider.value = String(pct);
      slider.setAttribute('aria-valuetext', pct + '%');
    };
    paint();
    onVolume(paint);
    slider.addEventListener('input', () => setVolume(+slider.value / 100));
  }

  closeBtn?.addEventListener('click', close);

  // ---------------------------------------------------------------------------
  // Four things, and that is the whole bar: the playlist, play/pause, the
  // volume, close.
  //
  // It used to carry seven. Shuffle, previous, next and repeat made it a second
  // copy of a transport that already exists in the playlist window, next to the
  // list those four act on - and prev and next beside a name with nothing else on
  // screen are two buttons that move you through something you cannot see. Those
  // went; they are one press away, on the surface that has the list.
  //
  // The volume did not, and the difference is what it is a property *of*. Prev
  // and next act on a list, so they belong with the list. A level is a property
  // of the room, not of the queue - it is what you reach for while something is
  // playing, which is exactly when this bar is up, and putting it a window away
  // means opening a window to turn a noise down.
  //
  // Close stays for a third reason again. It is not a transport control - it is
  // how the bar is dismissed, and it is the only way; a player with no way to put
  // it away is furniture.
  // ---------------------------------------------------------------------------
  // Both inserted before the volume, which is already in the markup along with
  // close - so the built and the written halves interleave in one order.
  const before = controls!.querySelector('.np-volume') || closeBtn;
  // The way in to the full player: the Playlist lens on a Mobile board (a second
  // press steps back to the Feed), the floating window on the Desktop.
  const listBtn = ctlBtn('np-list', 'Open the playlist', LIST_ICON, openPlaylist);
  playBtn = ctlBtn('np-play', 'Play', PLAY_ICON, togglePlay);
  for (const b of [listBtn, playBtn]) controls!.insertBefore(b, before);

  // A track that ends hands over only while the playlist is up - see
  // playlistOpen(). By injection rather than an import, because canvas/audio.js
  // sits below ui/ and may not reach back up into it; the same seam
  // setAssetNameLookup and setPrompt use, and tests/layers.test.js is what keeps
  // it one-way.
  setAdvanceGate(playlistOpen);

  // The seek line under both rows: a muted base, an accent fill clipped to the
  // played fraction (--np-progress), and the times at its ends. The fill carries
  // both a straight line and a wave; the CSS shows one per whimsy tier.
  // The line itself is seekInnerHTML's, shared with the playlist window and the
  // video card so all three scrubbers are one shape - see media/transport.js.
  // Only the two time labels either side of it are the bar's own.
  seekWrap!.innerHTML =
    '<span class="np-time np-elapsed">0:00</span>'
    + '<div class="np-line" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0">'
    +   seekInnerHTML('np-line')
    + '</div>'
    + '<span class="np-time np-total">0:00</span>';
  lineEl = seekWrap!.querySelector('.np-line');
  elapsedEl = seekWrap!.querySelector('.np-elapsed');
  totalEl = seekWrap!.querySelector('.np-total');
  waveSvg = seekWrap!.querySelector('.np-line-wave-svg');
  wavePathEl = seekWrap!.querySelector('.np-line-fill-wave');
  sizeWave();
  // The bar's width follows the window and the two time labels, both of which
  // change without a track change, so the wave is re-laid whenever the line
  // resizes rather than only when a track is bound.
  if (typeof ResizeObserver === 'function') new ResizeObserver(sizeWave).observe(lineEl!);
  bindScrub(lineEl!, (clientX: number) => seekTo?.(clientX));

  // The keys the canvas also wants. A bar you can reach with Tab must not also
  // nudge the selection behind it; the seek line answers the arrows itself.
  bar.addEventListener('keydown', e => {
    if (e.key === 'Escape') { close(); e.stopPropagation(); }
  });
  lineEl!.addEventListener('keydown', onSeekKey);

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
function show(current: NowPlaying | null) {
  if (!bar) return;
  if (!current) { hide(); return; }
  // The element as well as the item, which ui/playlist.ts has always compared
  // and this did not.
  //
  // One track can be playing through two different elements over its life: the
  // queue uses a shared <audio> while a card is culled, and the card's own the
  // moment it mounts. Pressing that card's play button fires setNowPlaying()
  // with the same item and a different element, and the early return here kept
  // every listener, the rAF and `seekTo` on the element the exclusivity rule in
  // canvas/audio.ts had just paused and rewound. The bar drew 0:00, showed
  // Play while sound was coming out of the other one, and scrubbing seeked
  // something silent.
  if (current.item === shown && current.el === boundEl) return;

  // Whatever was on its way out is not going any more - the box it was leaving
  // is about to hold a different track.
  cancelExit();
  teardown();
  shown = current.item;
  boundEl = current.el;

  bind(current.el);
  caption!.textContent = name(current.item);
  caption!.title = current.item.name || '';
  raise();
  // The bar was display:none until raise(), where the line read zero width and
  // the ResizeObserver had nothing to size against; now it has a box.
  sizeWave();
}

/** The bar's half of the shared sizer - see sizeSeekWave in media/transport.js. */
function sizeWave() { sizeSeekWave(lineEl!, waveSvg, wavePathEl); }

/**
 * Drive the bar off one element: the play button, the seek line and the times.
 *
 * A frame loop moves the fill while it plays (timeupdate fires four times a
 * second, nowhere near enough for a line that should glide); the events cover a
 * seek, a stall or a currentTime written from elsewhere. Its listeners are on an
 * AbortController so teardown() drops them in one call.
 */
function bind(sound: HTMLMediaElement) {
  abort = new AbortController();
  const signal = abort.signal;

  const paint = () => {
    const dur = sound.duration || 0;
    const cur = sound.currentTime || 0;
    lineEl!.style.setProperty('--np-progress', (dur ? clamp(cur / dur, 0, 1) : 0).toFixed(4));
    elapsedEl!.textContent = clock(cur);
    totalEl!.textContent = clock(dur);
    lineEl!.setAttribute('aria-valuemax', String(Math.round(dur)));
    lineEl!.setAttribute('aria-valuenow', String(Math.round(cur)));
    lineEl!.setAttribute('aria-valuetext', `${clock(cur)} of ${clock(dur)}`);
  };
  const follow = () => { paint(); frame = sound.paused ? 0 : requestAnimationFrame(follow); };
  const setIcon = () => {
    const playing = !sound.paused;
    // .is-paused stops the wave scrolling and flattens it to a straight line; the
    // CSS animates both back when it comes off.
    bar!.classList.toggle('is-paused', !playing);
    playBtn!.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    playBtn!.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  };

  const on = (type: string, fn: () => void) => sound.addEventListener(type, fn, { signal });
  on('play', () => { setIcon(); if (!frame) frame = requestAnimationFrame(follow); });
  on('pause', () => { setIcon(); paint(); });
  on('loadedmetadata', paint);
  on('timeupdate', paint);
  on('seeked', paint);

  seekTo = (clientX: number) => {
    if (!sound.duration) return;
    const box = lineEl!.getBoundingClientRect();
    if (!box.width) return;
    sound.currentTime = clamp((clientX - box.left) / box.width, 0, 1) * sound.duration;
    paint();
  };

  setIcon();
  paint();
  if (!sound.paused && !frame) frame = requestAnimationFrame(follow);
}

/** The seek line's keyboard: arrows nudge, Home/End jump, space plays. */
function onSeekKey(e: KeyboardEvent) {
  const sound = nowPlaying()?.el;
  if (!sound) return;
  const step = e.shiftKey ? 1 : 5;
  const set = (to: number) => { if (sound.duration) sound.currentTime = clamp(to, 0, sound.duration); };
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

/**
 * Whether that full player is up right now.
 *
 * The other half of openPlaylist(), and it has to span the same two answers for
 * the same reason: the full player is a lens on a Mobile board and a floating
 * window on the Desktop, and "is it open" is a different question of a different
 * module in each case. This file is where both are already known.
 *
 * What reads it is the queue's hand-over rule - a track that ends only starts
 * the next one while this is true. The argument is that unattended playback is
 * a thing you asked for or a thing that happened to you, and the list being on
 * screen is the difference: with it up, the next track is the one you can see
 * coming and stop. With it shut, the bar is a remote for one clip, and a board
 * that quietly moves on to another track twenty minutes after you stopped
 * looking is a board making noise on its own account.
 *
 * Note it is read at the moment a track ends, not when one starts - so closing
 * the playlist mid-track is enough to stop the queue at the end of it, and
 * opening it mid-track is enough to let it carry on. There is nothing to arm.
 */
const playlistOpen = () => (board.layoutMode === 'mobile'
  ? currentLens() === 'playlist'
  : isPlayerWindowOpen());

/** Play or pause whatever the bar is bound to. */
function togglePlay() {
  const sound = nowPlaying()?.el;
  if (!sound) return;
  if (sound.paused) sound.play().catch(reportPlayError);
  else sound.pause();
}

/** Build one round icon button for the controls cluster. */
function ctlBtn(className: string, label: string, icon: string, onClick: () => void) {
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
  bar!.hidden = false;
  void bar!.offsetWidth;
  bar!.classList.add('is-up');
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
  const onEnd = (e: TransitionEvent) => { if (e.target === bar && e.propertyName === 'opacity') done(); };
  const done = () => { cancelExit(); bar!.hidden = true; teardown(); };

  bar!.addEventListener('transitionend', onEnd);
  const timer = setTimeout(done, EXIT_CAP);
  leaving = () => {
    clearTimeout(timer);
    bar!.removeEventListener('transitionend', onEnd);
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
  boundEl = null;
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
function name(item: Item): string {
  // The two tags come out of a file's own metadata, so they are held to being
  // text here - `meta` promises nothing about what is under a key.
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const title = str(item.meta?.trackTitle)
    || (item.name ? baseName(item.name) || item.name : (item.type === 'video' ? 'Video' : 'Audio'));
  const artist = str(item.meta?.artist);
  return artist ? `${title} — ${artist}` : title;
}
