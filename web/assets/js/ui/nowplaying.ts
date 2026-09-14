// Now-playing bar along the foot — pins a transport to the glass so
// whatever is making noise can always be stopped. Not a second player:
// builds its strip over the card's own <audio>/<video> via bindScrub(),
// so card and bar stay in step with no sync code.

import {
  nowPlaying, onNowPlaying, clearNowPlaying,
  getVolume, onVolume, setVolume, sliderToVolume, volumeToSlider, volumeLocked,
} from '../canvas/audio.ts';
import { onQueue, queueNext, queueState, setAdvanceGate } from '../canvas/playlist-queue.ts';
import { bindScrub, clock, PAUSE_ICON, PLAY_ICON } from '../media/transport.ts';
import { board, setBoardMode } from '../state.ts';
import { onNarrowScreen } from '../canvas/viewport.ts';
import { tickSlider } from './controls.ts';
import { setLens, currentLens } from './board-view.ts';
import { togglePlayerWindow, isPlayerWindowOpen } from './playlist.ts';
import { baseName, clamp, markClosed } from '../util.ts';
import { seekInnerHTML, sizeSeekWave, reportPlayError } from '../media/transport.ts';
import type { NowPlaying } from '../canvas/audio.ts';
import type { Item } from '../board-model.ts';

// The bar and everything in it, taken once in initNowPlaying(). Read with `!`
// rather than guarded again, since every path that reads one is reached from
// that function or from an event bound inside it.
let bar: HTMLElement | null = null;
let caption: HTMLElement | null = null;
let controls: HTMLElement | null = null;
let volume: HTMLInputElement | null = null;
let closeBtn: HTMLElement | null = null;
// The seek line, its ends' times, and the play button - the bar's own
// transport, bound to whatever element is playing.
let seekWrap: HTMLElement | null = null;
let lineEl: HTMLElement | null = null;
let elapsedEl: HTMLElement | null = null;
let totalEl: HTMLElement | null = null;
let playBtn: HTMLElement | null = null;
/** The skip, which is only there while there is a list to skip through. */
let nextBtn: HTMLElement | null = null;
/** The way to the playlist, which a clip playing on its card is not in. */
let listBtn: HTMLElement | null = null;
// The wave's own svg and path, sized to the bar's pixel width so the
// frequency does not stretch with it - see sizeWave().
let waveSvg: SVGSVGElement | null = null;
let wavePathEl: SVGPathElement | null = null;
// The playback follow loop and the current seek handler, per bound element.
let frame = 0;
let seekTo: ((clientX: number) => void) | null = null;

// A little list with a play triangle: the way in to the full player.
const LIST_ICON = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2" y="3.2" width="8" height="1.6" rx="0.8"/><rect x="2" y="7.2" width="8" height="1.6" rx="0.8"/><rect x="2" y="11.2" width="5" height="1.6" rx="0.8"/><path d="M11.4 7v5l3.3-2.5z"/></svg>';
// Skip: a triangle against a bar, the shape every transport draws for it.
const NEXT_ICON = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 3.5v9l7-4.5z"/><rect x="11.6" y="3.5" width="1.6" height="9" rx="0.8"/></svg>';


/** The transport currently in the bar, and the way to take it back apart. */
let shown: Item | null = null;      // the item it was built for
let boundEl: HTMLMediaElement | null = null;   // and the element it is driving
let abort: AbortController | null = null;      // its listeners on the <audio>

/**
 * The exit, in flight: the function that calls it off, or 0.
 *
 * [hidden] is display:none, so hiding immediately would leave no box for a
 * fade to happen in - the class comes off first, CSS plays, then the element
 * goes. Held here so a track starting mid-fade can call the whole thing off
 * rather than let it finish and hide the bar it just filled.
 */
let leaving: (() => void) | 0 = 0;

/**
 * Long enough for any tier's exit (--dur-fast even at the slow end).
 *
 * A backstop, not the timing - transitionend normally ends the exit, but is
 * not guaranteed (e.g. a bar already display:none for another reason), and a
 * bar stuck at opacity 0 with pointer-events on would be invisible buttons
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
  // Handed to tickSlider() like every range in the app; it runs 0-100 in ones
  // and the helper will decline it (a hundred ticks in one drag is a buzz).
  tickSlider(volume);
  closeBtn = bar.querySelector('.np-close');

  // The same iPhone Safari case the sidebar's slider makes: writes to media
  // volume are ignored there, so the slider is removed rather than lie.
  if (volumeLocked()) {
    volume?.closest('.np-volume')?.remove();
    volume = null;
  } else if (volume) {
    // Held as a const so narrowing survives inside the closures below - the
    // module binding `volume` is reassigned on the other branch.
    const slider = volume;
    // Both halves go through the curve in canvas/audio.ts (position is not
    // amplitude); the two mappers are exact inverses so the thumb never
    // walks under a drag. The value announced to a screen reader is the
    // position, since that's what's on screen and being moved.
    const paint = () => {
      const pct = Math.round(volumeToSlider(getVolume()) * 100);
      if (slider.value !== String(pct)) slider.value = String(pct);
      slider.setAttribute('aria-valuetext', pct + '%');
    };
    paint();
    onVolume(paint);
    slider.addEventListener('input', () => setVolume(sliderToVolume(+slider.value / 100)));
  }

  closeBtn?.addEventListener('click', close);

  // Two clusters, split by what each acts on. The lead (left, both rows) is
  // Play/pause and Next: the one control anyone comes here to press, sized
  // and placed to say so. The cluster (right) is playlist/volume/close - the
  // three things that are not this track.
  //
  // Previous is deliberately absent: Next says "carry on without me", which
  // is what a bar over a board is for; a Previous button would make the bar
  // a place to steer from, and steering wants the list in front of you.

  // The way in to the full player: the Playlist lens on a narrow screen, the
  // floating window where there is room for one.
  listBtn = ctlBtn('np-qbtn np-list', 'Open the playlist', LIST_ICON, openPlaylist);
  // Before the volume, already in the markup along with close - so built and
  // written halves interleave in one order.
  controls!.insertBefore(listBtn, controls!.querySelector('.np-volume') || closeBtn);

  playBtn = ctlBtn('np-play', 'Play', PLAY_ICON, togglePlay);
  nextBtn = ctlBtn('np-qbtn np-next', 'Next track', NEXT_ICON, queueNext);
  const lead = document.createElement('div');
  lead.className = 'np-lead';
  lead.append(playBtn, nextBtn);
  // First child of the bar, which chrome.css's grid puts down the left of
  // both rows - prepended because everything that varies with what is
  // playing is built here, and Next varies the most (see paintNext()).
  bar.prepend(lead);
  // Whether Next belongs on the bar is a question about the queue, re-asked
  // whenever the queue moves, on a track change, and when the playlist opens
  // or shuts from this bar.
  onQueue(paintNext);
  paintNext();

  // A track that ends hands over to the next only while the playlist is up -
  // see playlistOpen(). By injection, not import: canvas/audio.ts sits below
  // ui/ and may not reach back up (tests/layers.test.js enforces this).
  setAdvanceGate(playlistOpen);

  // The seek line under both rows: a muted base, an accent fill clipped to
  // the played fraction (--np-progress), times at its ends. The line itself
  // is seekInnerHTML's, shared with the playlist window and video card so all
  // three scrubbers are one shape - see media/transport.ts. Only the two time
  // labels are the bar's own.
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
  // The bar's width follows the window and the two time labels, both of
  // which can change without a track change, so re-lay on resize too.
  if (typeof ResizeObserver === 'function') new ResizeObserver(sizeWave).observe(lineEl!);
  bindScrub(lineEl!, (clientX: number) => seekTo?.(clientX));

  // The keys the canvas also wants. A bar reachable by Tab must not also
  // nudge the selection behind it; the seek line answers the arrows itself.
  bar.addEventListener('keydown', e => {
    if (e.key === 'Escape') { markClosed(e); close(); e.stopPropagation(); }
  });
  lineEl!.addEventListener('keydown', onSeekKey);

  onNowPlaying(show);
  show(nowPlaying());
}

/**
 * Put a track in the bar, or take the bar away.
 *
 * Re-bound per track rather than repointed: swapping the element underneath
 * a live follow loop would leave the last track's listeners on the new one.
 */
function show(current: NowPlaying | null) {
  if (!bar) return;
  if (!current) { hide(); return; }
  // The element, not just the item: one track can play through two different
  // elements over its life (a shared <audio> while its card is culled, the
  // card's own once it mounts). Without this test, pressing that card's play
  // button kept every listener and `seekTo` on the element exclusivity had
  // just paused - the bar showed 0:00 and Play while sound played elsewhere,
  // and scrubbing seeked something silent.
  if (current.item === shown && current.el === boundEl) return;

  // Whatever was leaving is not going any more - the box it was leaving is
  // about to hold a different track.
  cancelExit();
  teardown();
  shown = current.item;
  boundEl = current.el;

  bind(current.el);
  caption!.textContent = name(current.item);
  caption!.title = current.item.name || '';
  // A video is not in the playlist, so a way there from its bar leads nowhere.
  listBtn!.hidden = current.item.type === 'video';
  paintNext();
  raise();
  // The bar was display:none until raise(), where the line had zero width;
  // now it has a box to size against.
  sizeWave();
}

/** The bar's half of the shared sizer - see sizeSeekWave in media/transport.ts. */
function sizeWave() { sizeSeekWave(lineEl!, waveSvg, wavePathEl); }

/**
 * Drive the bar off one element: the play button, the seek line and the
 * times.
 *
 * A frame loop moves the fill while playing (timeupdate is only 4/sec,
 * nowhere near enough for a line that should glide); the events cover a
 * seek, a stall, or currentTime written elsewhere. Listeners are on an
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
    // .is-paused stops the wave scrolling and flattens it; CSS animates both
    // back when it comes off.
    bar!.classList.toggle('is-paused', !playing);
    playBtn!.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    playBtn!.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  };

  const on = (type: string, fn: () => void) => sound.addEventListener(type, fn, { signal });
  on('play', () => { setIcon(); if (!frame) frame = requestAnimationFrame(follow); });
  on('pause', () => { setIcon(); paint(); });
  on('loadedmetadata', paint);
  // See canvas/transport.ts: a guessed duration is corrected by its own
  // event and nothing else while paused.
  on('durationchange', paint);
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
 * Whether the bar carries a Next button - whether what's playing is running
 * through a list.
 *
 * Three conditions: the queue has to be what's sounding (a video card
 * isn't), there has to be more than one track to move to, and the track was
 * either started *as* a list or the list is on screen - the same pair
 * advanceQueue() in canvas/playlist-queue.ts asks to decide whether to
 * advance. Agreement is the point: a Next button on a track that will stop
 * dead would promise a queue that isn't there.
 */
function paintNext() {
  if (!nextBtn) return;
  const q = queueState();
  nextBtn.hidden = !(q.active && q.length > 1 && (q.fromList || playlistOpen()));
}

/**
 * Open the full player: the Playlist lens on a narrow screen, the floating
 * window where there is room for one - and on a Mobile board that isn't
 * narrow, the lens too, since a window would float over a surface that
 * already has the list. Same reading cmds.playlist takes.
 *
 * The toggle differs on the lens: this button steps back to Feed rather than
 * doing nothing, since it's this bar's button and a way back out is what
 * it's for.
 */
function openPlaylist() {
  if (board.layoutMode === 'mobile') {
    setLens(currentLens() === 'playlist' ? 'feed' : 'playlist');
  } else if (onNarrowScreen()) {
    // Off the canvas and into the lens. setLens first, so the mode switch
    // lands on the lens asked for rather than whichever was last up.
    setLens('playlist');
    setBoardMode('mobile');
  } else {
    togglePlayerWindow();
  }
  paintNext();
}

/**
 * Whether that full player is up right now - the other half of
 * openPlaylist(), spanning the same two cases (a lens on Mobile, a window on
 * Desktop) since "is it open" is a different module's question in each.
 *
 * Read by the queue's hand-over rule: a track that ends only starts the next
 * one while this is true, since with the list visible the next track is one
 * you can see coming and stop, and with it shut the bar is a remote for one
 * clip.
 *
 * Read at the moment a track ends, not when one starts, so closing the
 * playlist mid-track stops the queue at the end of it and opening it
 * mid-track lets it carry on.
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

/**
 * Build one round icon button.
 *
 * `className` is the whole list rather than a suffix on `np-qbtn`, since the
 * play button is the lead, not one of the quiet ones, with its own size and
 * colour that a shared class would then have to out-specify.
 */
function ctlBtn(className: string, label: string, icon: string, onClick: () => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.innerHTML = icon;
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Out of display:none and into place, in that order and not in one go.
 *
 * A transition needs two computed styles to run between, and a display:none
 * element has no first one - setting both in the same frame gives the
 * browser nothing to animate from. Reading offsetWidth forces the
 * intermediate style to resolve; the one place in this file a layout flush
 * is the point rather than the cost.
 */
function raise() {
  bar!.hidden = false;
  void bar!.offsetWidth;
  bar!.classList.add('is-up');
}

/**
 * Stop what is playing and put the bar away. Both, because either alone is
 * half an answer to a close button on a player.
 *
 * Goes through canvas/audio.ts rather than calling hide() directly: the
 * record of what is playing has to be cleared too, or the next press of that
 * card's play button announces a track already on record and the bar never
 * comes back. Clearing it comes back round as show(null).
 */
function close() {
  nowPlaying()?.el?.pause();
  clearNowPlaying();
}

/**
 * Play the exit, then clear up behind it. The transport stays in the bar for
 * the length of the fade - emptying it first would read as two events
 * (going blank, then leaving) instead of one.
 */
function hide() {
  if (!bar || bar.hidden) { teardown(); return; }
  if (leaving) return;                 // already on its way

  bar.classList.remove('is-up');

  // One property, or this fires once per transitioned property and finishes
  // on whichever of opacity/transform the engine ends first.
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
 * Call off an exit in flight. The listener half matters most: left attached,
 * the next thing it hears is the *entry* fade finishing, which would hide
 * the bar the instant it finished arriving.
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
  // Nothing is playing, so there is nothing to be next after - paintNext()
  // brings it back on the next track's show().
  if (nextBtn) nextBtn.hidden = true;
}

/**
 * What to call it. baseName() drops the extension, the same reading the
 * trash list takes, since the card beside it does not say the extension
 * either.
 */
function name(item: Item): string {
  // Metadata off a file, so held to being text - `meta` promises nothing
  // about what is under a key.
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const title = str(item.meta?.trackTitle)
    || (item.name ? baseName(item.name) || item.name : (item.type === 'video' ? 'Video' : 'Audio'));
  const artist = str(item.meta?.artist);
  return artist ? `${title} — ${artist}` : title;
}
