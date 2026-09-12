// Audio card control strip: play button, waveform bars, and clock. Replaces the
// unstyled native <audio controls>. In canvas/ (not media/) because it imports
// state.ts and storage — media/transport.ts holds only the stateless primitives
// (bindScrub, clock, glyphs). One caller: canvas/renderers.ts.

import { clamp } from '../util.ts';
import { bus, selection } from '../state.ts';
import {
  PAUSE_ICON, PLAY_ICON, bindScrub, clock, reportPlayError,
} from '../media/transport.ts';
import { nowPlaying } from './audio.ts';
import type { Track } from './playlist-queue.ts';
import { playTrack } from './playlist-queue.ts';
import type { Measurable } from './waveform.ts';
import { peaks, resample } from './waveform.ts';

/** Screen px per bar, near enough - a bar plus its gap. */
const BAR_PITCH = 5;
const MIN_BARS = 10;

/** Structural type: enough to measure (waveform), start (playlist-queue), and identify. */
export type TransportItem = Measurable & Track;


/**
 * Build the play button, waveform bars, and clock for one audio item.
 * Two stacked bar lanes (base + accent) — the accent is clip-revealed for a
 * smooth fill. Bars are mirrored about centre (symmetric waveform).
 */
export function buildTransport(
  item: TransportItem,
  sound: HTMLMediaElement,
): HTMLDivElement {
  const transport = document.createElement('div');
  transport.className = 'transport';

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'play';
  play.setAttribute('aria-label', 'Play');
  play.innerHTML = PLAY_ICON;

  const wave = document.createElement('div');
  wave.className = 'wave';
  // role="slider" needs tabIndex + aria-value* to be operable, not just announced.
  wave.setAttribute('role', 'slider');
  wave.setAttribute('aria-label', 'Seek');
  wave.setAttribute('aria-valuemin', '0');
  /** Disable seek when stopped — no pointer, no tab, no aria. */
  const setSeekable = (on: boolean) => {
    wave.tabIndex = on ? 0 : -1;
    wave.setAttribute('aria-disabled', String(!on));
  };
  setSeekable(false);
  const lanes: HTMLElement[] = [];
  const base = lane('wave-base');
  const fill = lane('wave-fill');
  lanes.push(base, fill);
  wave.append(base, fill);

  const time = document.createElement('span');
  time.className = 'transport-time';
  time.textContent = '0:00';

  transport.append(play, wave, time);

  let values: number[] | null = null;   // the stored readings, once they arrive
  let builtFor = 0;                     // the width the current bars were drawn for

  const barCount = () => {
    const w = wave.clientWidth || parseFloat(getComputedStyle(wave).width) || 0;
    return Math.max(MIN_BARS, Math.round(w / BAR_PITCH));
  };

  const drawBars = () => {
    const w = wave.clientWidth;
    if (!w || !values) return;
    const heights = resample(values, barCount());
    for (const el of lanes) {
      el.replaceChildren(...heights.map(v => {
        const bar = document.createElement('i');
        // Floor at 7% so silence is a thin line, not a gap.
        bar.style.height = Math.max(7, Math.round(v * 100)) + '%';
        return bar;
      }));
    }
    builtFor = w;
    paint();
  };

  // Debounce text/aria writes to once per second — only the clip fill moves each frame.
  let lastSec = -1;
  let lastMax = -1;
  const paint = () => {
    const at = sound.duration ? clamp(sound.currentTime / sound.duration, 0, 1) : 0;
    // Clip reveals shaped ink — cheaper than resizing individual bars.
    fill.style.clipPath = `inset(0 ${((1 - at) * 100).toFixed(3)}% 0 0)`;
    const max = Math.round(sound.duration || 0);
    if (max !== lastMax) {
      lastMax = max;
      wave.setAttribute('aria-valuemax', String(max));
    }
    const sec = Math.round(sound.currentTime || 0);
    if (sec !== lastSec) {
      lastSec = sec;
      // Show duration when stopped, position when playing.
      time.textContent = clock(sound.currentTime || sound.duration || 0);
      wave.setAttribute('aria-valuenow', String(sec));
      wave.setAttribute('aria-valuetext',
        `${clock(sound.currentTime || 0)} of ${clock(sound.duration || 0)}`);
    }
  };

  // rAF loop for smooth fill — timeupdate (~4 Hz) is too coarse.
  let frame = 0;
  const follow = () => {
    paint();
    frame = sound.paused ? 0 : requestAnimationFrame(follow);
  };

  peaks(item).then(v => { values = v; drawBars(); });

  // Wait for real width before first draw — detached elements measure zero, and
  // cached peaks() can resolve before attachment. Once drawn, resizes handled by deselect.
  const watch = new ResizeObserver(() => {
    if (builtFor || !wave.clientWidth || !values) return;
    drawBars();
    watch.disconnect();
  });
  watch.observe(wave);

  play.addEventListener('click', () => {
    // Toggle pause if already playing; otherwise start via the shared queue.
    if (nowPlaying()?.el === sound) {
      if (sound.paused) sound.play().catch(reportPlayError); else sound.pause();
    } else {
      playTrack(item, 'board');
    }
  });
  const on = (type: string, fn: () => void) => sound.addEventListener(type, fn);

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
  // Duration can arrive late or be corrected (raw AAC, headerless MP3).
  on('durationchange', paint);
  // Catches playhead moves outside the rAF loop (pause-seek, stall, external set).
  on('timeupdate', paint);
  on('seeked', paint);
  on('ended', () => { sound.currentTime = 0; paint(); });

  // Catch up if sound is already playing (missed the 'play' event).
  if (!sound.paused) {
    transport.classList.add('is-playing');
    setSeekable(true);
    play.innerHTML = PAUSE_ICON;
    play.setAttribute('aria-label', 'Pause');
    frame = requestAnimationFrame(follow);
  }
  paint();

  bindScrub(wave, clientX => {
    // Only while playing — paused scrub conflicts with card dragging.
    if (sound.paused) return;
    if (!sound.duration) return;
    const box = wave.getBoundingClientRect();
    if (!box.width) return;
    sound.currentTime = clamp((clientX - box.left) / box.width, 0, 1) * sound.duration;
    paint();
  });

  /** Seek by `secs`, or to an absolute point when `to` is given. */
  const seekBy = (secs: number, to: number | null = null) => {
    if (sound.paused) return;
    if (!sound.duration) return;
    const next = to != null ? to : sound.currentTime + secs;
    sound.currentTime = clamp(next, 0, sound.duration);
    paint();
  };

  // Slider keyboard: arrows ±5s (±1s with Shift), Page ±30s, Home/End, Space.
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
    e.stopPropagation();
  });

  // Redraw bars on deselect (width may have changed), not during drag.
  // `.closest('.item')` = alive check; `.item` not isConnected because
  // buildContent composes while detached.
  const alive = () => !!wave.closest('.item');
  // Typed explicitly — handler references its own unsubscribe (tsc cycle).
  const off: () => void = bus.on('selection', () => {
    if (!alive()) { off(); return; }
    if (selection.has(item.id)) return;
    if (wave.clientWidth && wave.clientWidth !== builtFor) drawBars();
  });
  // Explicit teardown — the alive check only fires on next selection change.
  // SAFETY: _offSelection written here, read only by releaseTransports().
  (transport as TransportNode)._offSelection = off;

  return transport;
}

/** A built strip, with the way to stop it listening hung off it. */
type TransportNode = HTMLElement & { _offSelection?: () => void };

/** Unsubscribe all transports inside `el`. Called by discard(), not cull. */
export function releaseTransports(el: Element): void {
  for (const strip of el.querySelectorAll<TransportNode>('.transport')) {
    strip._offSelection?.();
    strip._offSelection = undefined;
  }
}

function lane(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'wave-lane ' + className;
  return el;
}
