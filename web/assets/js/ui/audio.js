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
import { markDirty } from '../state.js';

const VOLUME_KEY = 'mbrd.volume';
/** Loud enough to hear on laptop speakers, quiet enough not to make you jump. */
export const DEFAULT_VOLUME = 0.6;
/** How many bars a waveform is drawn with. */
const BARS = 48;

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
  if (Array.isArray(cached) && cached.length === BARS) return cached;

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
    const per = Math.max(1, Math.floor(data.length / BARS));
    const out = [];
    let loudest = 0;
    for (let b = 0; b < BARS; b++) {
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
  for (let i = 0; i < BARS; i++) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h |= 0;
    // Swelled towards the middle, so it reads as a clip rather than as noise.
    const envelope = 0.55 + 0.45 * Math.sin((i / (BARS - 1)) * Math.PI);
    out.push(Math.round(((0.25 + ((h >>> 0) % 1000) / 1000 * 0.75) * envelope) * 100) / 100);
  }
  return out;
}

export const BAR_COUNT = BARS;
