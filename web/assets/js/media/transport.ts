// Scrubber shape shared by three players (now-playing, playlist, video card).
// Must never import state.ts. Wave drawn in real pixels (constant frequency);
// played portion is a clip, not scaleX, so it never distorts.

import { toast } from '../notify.ts';

/** A half period in px. Smaller is a higher frequency. */
export const WAVE_HALF = 7;

/** Two extra periods past `width` so the leftward scroll loops without a gap. */
function wavePath(width: number): string {
  let d = 'M0 4';
  let up = true;
  for (let x = 0; x < width + 4 * WAVE_HALF; x += WAVE_HALF) {
    d += ` Q${x + WAVE_HALF / 2} ${up ? 2 : 6} ${x + WAVE_HALF} 4`;
    up = !up;
  }
  return d;
}

/** Scrubber inner HTML. `p` is the class prefix (`np-`, `pw-`, `vt-`).
 *  The path carries the scroll animation; a pause cross-fades the wave's svg into the
 *  straight one on opacity (chrome.css). The group no longer carries a flatten. */
export function seekInnerHTML(p: string): string {
  return (
    `<svg class="${p}-svg" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">`
    + `<path class="${p}-base" d="M0 4H100" vector-effect="non-scaling-stroke"/></svg>`
    + `<div class="${p}-fill">`
    +   `<svg class="${p}-svg" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">`
    +     `<path class="${p}-fill-line" d="M0 4H100" vector-effect="non-scaling-stroke"/></svg>`
    +   `<svg class="${p}-svg ${p}-wave-svg" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">`
    +     `<g class="${p}-wave-scale"><path class="${p}-fill-wave" vector-effect="non-scaling-stroke"/></g></svg>`
    + `</div>`
  );
}

/** Size the wave SVG to match a measured line. No-op when width < 1. */
export function sizeSeekWave(
  lineEl: Element | null | undefined,
  waveSvg: Element | null | undefined,
  wavePathEl: Element | null | undefined,
): void {
  if (!lineEl || !waveSvg || !wavePathEl) return;
  const w = Math.round(lineEl.clientWidth);
  if (w < 1) return;
  waveSvg.setAttribute('viewBox', `0 0 ${w} 8`);
  wavePathEl.setAttribute('d', wavePath(w));
}

/** Pointer-capture drag on a seek track. Capture keeps drag alive outside the thin track
 *  and stops canvas/input.ts reading it as a card drag. stopPropagation on down too —
 *  capture only redirects later events. */
export function bindScrub(el: HTMLElement, seekTo: (clientX: number) => void): void {
  el.addEventListener('pointerdown', e => {
    // Before capture — setPointerCapture can throw NotFoundError for a dead pointer.
    seekTo(e.clientX);
    e.stopPropagation();
    // The line thickens while held (chrome.css): under a thumb nothing else shows it caught.
    el.classList.add('is-scrubbing');
    try { el.setPointerCapture(e.pointerId); } catch { /* the pointer has gone */ }
  });
  el.addEventListener('pointermove', e => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    // Captured move still bubbles — stop it reaching the canvas.
    e.stopPropagation();
    seekTo(e.clientX);
  });
  const release = () => el.classList.remove('is-scrubbing');
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('lostpointercapture', release);
}

/* Play/pause glyphs as strings — swapped via innerHTML, not <use> (avoids fetch on first press). */
export const PLAY_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3.4l7.5 4.6L5 12.6z"/></svg>';
export const PAUSE_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.6 3.2h2.6v9.6H4.6zM8.8 3.2h2.6v9.6H8.8z"/></svg>';

/**
 * How long the track runs, where the engine and the file disagree.
 *
 * `stated` is the file's own answer - ADTS frames counted one by one, or a
 * container's duration field (import/containers.ts) - and it wins, because for
 * a stream with no container the engine is guessing: it reads the first frame's
 * bitrate and divides the file by it. A raw .aac whose first frame is a 9-byte
 * silent one reads as 7319 minutes in Firefox and as 97 in Chromium, against a
 * true 95. Only `duration` is wrong in either: `currentTime` counts decoded
 * samples and a seek lands where it was asked to, so a position needs no
 * correction and none is applied here.
 */
// `stated` is unknown rather than a number because it arrives from an item's
// meta, which is a Record<string, unknown> — the narrowing belongs here, once.
export function trackLength(sound: HTMLMediaElement, stated: unknown): number {
  if (typeof stated === 'number' && Number.isFinite(stated) && stated > 0) return stated;
  const engine = sound.duration;
  return Number.isFinite(engine) && engine > 0 ? engine : 0;
}

/** m:ss. Hours are possible and would be a strange thing to pin to a board. */
export function clock(secs: number): string {
  // Not Math.max alone — Math.floor(NaN) is NaN, so clamp lets it through.
  if (!Number.isFinite(secs)) return '0:00';
  const s = Math.max(0, Math.floor(secs));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** Toast for a rejected play() — almost always the browser blocking autoplay, not a broken file. */
export function reportPlayError(err: { name?: string } | null | undefined): void {
  toast(err && err.name === 'NotAllowedError'
    ? 'Your browser blocked playback — allow audio for this site'
    : 'Could not play this file');
}
