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
// reopening the board does not decode anything a second time. When decoding is
// impossible (an exotic codec, no Web Audio) the fallback is a stable pattern
// derived from the file's own hash: still that file's own shape, in the weak
// sense that it never changes and never matches another file's, which is all a
// placeholder has to be.
//
// Volume is deliberately one global rather than per item. It is a property of
// the room you are sitting in, not of any one clip, and a board with six clips
// on it would otherwise mean six sliders to turn down.

import { getAsset } from '../storage/assets.js';
import { bus, markDirty, selection } from '../state.js';

const VOLUME_KEY = 'mbrd.volume';
/** Loud enough to hear on laptop speakers, quiet enough not to make you jump. */
export const DEFAULT_VOLUME = 0.6;

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

export function initAudio() {
  const stored = readVolume();
  volume = stored;

  const input = document.getElementById('opt-volume');
  const out = document.getElementById('opt-volume-out');
  if (!input) return;
  input.value = String(Math.round(volume * 100));
  if (out) out.textContent = Math.round(volume * 100) + '%';
  input.addEventListener('input', () => {
    setVolume(+input.value / 100);
    if (out) out.textContent = Math.round(volume * 100) + '%';
  });
}

export function setVolume(v) {
  volume = Math.max(0, Math.min(1, +v || 0));
  for (const a of players) a.volume = volume;
  try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* private mode */ }
}

export const getVolume = () => volume;

function readVolume() {
  try {
    const n = parseFloat(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

/**
 * Put an <audio> under the global volume.
 *
 * The set holds every player ever built, including ones whose item has since
 * been deleted - a few dozen dead references, against the alternative of
 * teaching items.js to tell this module when a node is culled. Culling detaches
 * nodes and puts them back; unregistering on detach would silently drop a
 * player out of the volume control for the rest of the session.
 */
export function registerPlayer(el) {
  el.volume = volume;
  players.add(el);
}

// ---------------------------------------------------------------------------
// Waveforms
// ---------------------------------------------------------------------------

let audioCtx = null;

function context() {
  // Created suspended and never resumed: decodeAudioData does not need a
  // running context, and starting one without a user gesture is refused
  // anyway. Playback goes through <audio>, which has no such restriction.
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = Ctx ? new Ctx() : null;
  }
  return audioCtx;
}

/**
 * One amplitude per bar, each in [0, 1], normalised so the loudest bar is full
 * height. RMS rather than peak: peak picks up single-sample transients and
 * draws almost every piece of music as a solid block.
 */
export async function peaks(item) {
  const cached = item.meta?.peaks;
  if (Array.isArray(cached) && cached.length === PEAK_RES) return cached;

  const asset = item.asset && getAsset(item.asset.hash);
  const measured = asset ? await measure(asset.blob) : null;
  const result = measured || pseudo(item.asset?.hash || item.id);

  // Cached on the item, so this happens once per file rather than once per
  // mount. Written directly rather than through a command: it is a measurement
  // of bytes that were already there, not an edit, and it belongs in no undo
  // entry.
  if (item.meta) item.meta.peaks = result;
  if (measured) markDirty();
  return result;
}

async function measure(blob) {
  const ctx = context();
  if (!ctx) return null;
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
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
    return out.map(v => Math.round((v / loudest) * 100) / 100);
  } catch {
    return null;   // not a codec this browser decodes
  }
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
 */
export function buildTransport(item, sound) {
  const transport = document.createElement('div');
  transport.className = 'transport';

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'play';
  play.setAttribute('aria-label', 'Play');
  play.innerHTML = PLAY_ICON;

  const wave = document.createElement('div');
  wave.className = 'wave';
  wave.setAttribute('role', 'slider');
  wave.setAttribute('aria-label', 'Seek');
  const base = lane('wave-base');
  const fill = lane('wave-fill');
  wave.append(base, fill);

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
    const at = sound.duration ? sound.currentTime / sound.duration : 0;
    fill.style.clipPath = `inset(0 ${((1 - at) * 100).toFixed(3)}% 0 0)`;
    time.textContent = clock(sound.currentTime || 0);
  };

  // While it plays, the fill is driven by the frame clock rather than by
  // timeupdate, which fires about four times a second - fine for a digit,
  // nowhere near enough for something that is supposed to glide.
  let frame = 0;
  const follow = () => {
    paint();
    frame = sound.paused ? 0 : requestAnimationFrame(follow);
  };

  peaks(item).then(v => { values = v; drawBars(); });

  play.addEventListener('click', () => {
    if (sound.paused) sound.play().catch(() => {});
    else sound.pause();
  });
  sound.addEventListener('play', () => {
    transport.classList.add('is-playing');
    play.innerHTML = PAUSE_ICON;
    play.setAttribute('aria-label', 'Pause');
    if (!frame) frame = requestAnimationFrame(follow);
  });
  sound.addEventListener('pause', () => {
    transport.classList.remove('is-playing');
    play.innerHTML = PLAY_ICON;
    play.setAttribute('aria-label', 'Play');
    paint();
  });
  sound.addEventListener('loadedmetadata', paint);
  // The frame loop above covers playback. This covers everything else that can
  // move the playhead - a seek while paused, a buffering stall, currentTime set
  // from outside - none of which produce a frame loop of their own.
  sound.addEventListener('timeupdate', paint);
  sound.addEventListener('seeked', paint);
  sound.addEventListener('ended', () => { sound.currentTime = 0; paint(); });

  wave.addEventListener('pointerdown', e => {
    if (!sound.duration) return;
    const box = wave.getBoundingClientRect();
    sound.currentTime = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * sound.duration;
    paint();
  });

  // Redrawn when the card is let go of, not while it is being dragged.
  //
  // The bar count follows the card's width, so a resize wants a different set
  // of bars - but rebuilding them on every frame of a drag would have the
  // waveform reflowing under the pointer, which reads as the sound changing.
  // Deselection is the end of the gesture, and by then the width is final.
  const off = bus.on('selection', () => {
    // A card replaced by rebuild() (a rename, a note edit) is detached from
    // its item and will never be seen again; that is when this stops.
    if (!wave.closest('.item')) { off(); return; }
    if (selection.has(item.id)) return;
    if (wave.clientWidth && wave.clientWidth !== builtFor) drawBars();
  });

  return transport;
}

function lane(className) {
  const el = document.createElement('div');
  el.className = 'wave-lane ' + className;
  return el;
}

const PLAY_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3.4l7.5 4.6L5 12.6z"/></svg>';
const PAUSE_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.6 3.2h2.6v9.6H4.6zM8.8 3.2h2.6v9.6H8.8z"/></svg>';

/** m:ss. Hours are possible and would be a strange thing to pin to a board. */
function clock(secs) {
  const s = Math.max(0, Math.floor(secs));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
