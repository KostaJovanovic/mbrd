// The scrubber, as a shape three different players share.
//
// At the soft end of the whimsy axis a seek line is not a line, it is a
// Material-style wave that scrolls slowly leftward through the played part.
// It started on the now-playing bar. It is here because three scrubbers draw
// it now - that bar, the playlist window's transport, and the plain line a
// video card carries - and they sit in three different layers (ui/, ui/ and
// canvas/), so the only place all three can reach is below all of them.
//
// It lived in util.ts until this split, which is the thing worth naming: a
// waveform SVG builder is not a "small shared helper", and forty-four modules
// were importing one to reach clamp(). What they have in common is a *medium*,
// not a size, so the directory is media/ and the module is named for the part
// of a player this is - the transport - rather than for the file it left.
//
// ── How much of the control strip landed here, and why not all of it ──
//
// Track D of the refactor plan said canvas/audio.ts's transport block belonged
// down beside this. Most of it does not, and the sentence that decided it is the
// one this header carried while the move was still hypothetical: *nothing here
// should acquire an import that would block it - in particular not state.ts. A
// transport is told what to draw; it does not ask the board what is playing.*
//
// buildTransport() asks. It reads `bus` and `selection` to know a card has been
// let go of, measures the file through canvas/waveform.ts (which reaches
// storage/ and marks the board dirty), starts playback through the queue, and
// complains through notify.ts. Four dependencies, three of them upward of this
// tier. So it stayed in canvas/, as canvas/transport.ts, whose header carries
// the full argument - and what came down here is exactly the part that keeps
// this module's promise:
//
//   bindScrub()   listeners on an element it is handed. No lookup, no document.
//   clock()       seconds -> m:ss. Arithmetic on a number.
//   PLAY_ICON     two strings of SVG. Every character written above.
//   PAUSE_ICON
//
// which is the same test everything else in this file passes, and the reason the
// split is a real one rather than a rename: these four are what a *second* kind
// of player would reuse, and buildTransport is the one this app happens to have.
//
// ── What must not move in here ──
//
// The audio *analysis*. The waveform DSP that turns a decoded buffer into peaks
// is arithmetic over sample data with no interface in it at all, and pairing it
// with a control strip would recreate the mixture this split exists to undo. It
// is canvas/waveform.ts, which says the same thing back.
//
// ── The geometry, and the bug it replaced ──
//
// A sine drawn in the line's *own pixels*, 8 tall with the centre at 4, so its
// wavelength is the same on a narrow phone bar and a wide desktop window. What
// this shape replaces was a path in a fixed 0..100 viewBox stretched to the
// element width, which made the frequency a function of how wide the line
// happened to be - wide ones drew slow rolling swells, narrow ones a tight
// ripple, and neither was what anybody drew. Each caller sizes its svg's viewBox
// to the measured pixel width, so one user unit is one pixel and WAVE_HALF is a
// real, constant half-period.
//
// Which is also why the played part cannot be a scaled bar. Two of these three
// used to be a div with `transform: scaleX(progress)`, and a wave scaled
// horizontally is a wave whose frequency changes as it plays. The played part is
// revealed with a clip instead, so the wave itself never moves and only how much
// of it can be seen does.
//
// ── On innerHTML ──
//
// seekInnerHTML() returns markup as a string and its callers assign it. That is
// allowed here and nowhere near a foreign document: every character of it is
// written above, and the one substitution is a class prefix each caller passes
// as a literal it wrote itself. A prefix that ever came from a file, a filename
// or a board would make this the wrong shape of function, and the fix then would
// be to build the nodes rather than to escape the string.

/** A half period in px. Smaller is a higher frequency. */
export const WAVE_HALF = 7;

/**
 * The path, run two whole periods past `width` so the leftward scroll has crest
 * to bring in from the right without a gap: it translates by one period
 * (2 * WAVE_HALF, kept in step with the keyframe in the CSS) and loops, which is
 * seamless because the wave repeats.
 */
export function wavePath(width: number): string {
  let d = 'M0 4';
  let up = true;
  for (let x = 0; x < width + 4 * WAVE_HALF; x += WAVE_HALF) {
    d += ` Q${x + WAVE_HALF / 2} ${up ? 2 : 6} ${x + WAVE_HALF} 4`;
    up = !up;
  }
  return d;
}

/**
 * The markup every wavy scrubber has inside it, as an HTML string.
 *
 * `p` is the class prefix, because the three callers keep their own names
 * (`np-`, `pw-`, `vt-`) and their own stylesheets. What is shared is the
 * *shape*: a base line clipped to the part past the playhead, and a fill clipped
 * to the part before it carrying both a straight line and a wave, of which the
 * CSS shows one per whimsy tier.
 *
 * The wave is wrapped in a group so its two transforms do not fight - the path
 * carries the scroll (an animation) and the group the flatten-when-paused (a
 * transition), and one element cannot do both, since a running animation owns
 * the whole transform. Its `d` is empty until the caller measures a width.
 */
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

/**
 * Lay the wave across a line that has just been measured. Safe to call before
 * there is a box - a zero-width line simply keeps the path it had.
 *
 * The three elements are handed in rather than looked up, which is what keeps
 * this module off `document` entirely: each caller already holds its own nodes
 * under its own class prefix, and a query in here would have to know all three
 * naming schemes.
 */
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

/**
 * Make a seek track draggable, not merely clickable.
 *
 * Shared, because there are three of these - the card's waveform, the video
 * card's line, and whichever of the two the now-playing bar is showing - and a
 * scrub that behaved differently depending on which one you had hold of would be
 * three controls wearing one costume.
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
 *
 * The element is handed in, like everything else here. That is what keeps this
 * off `document` and out of any one caller's naming scheme.
 */
export function bindScrub(el: HTMLElement, seekTo: (clientX: number) => void): void {
  el.addEventListener('pointerdown', e => {
    el.setPointerCapture(e.pointerId);
    seekTo(e.clientX);
    e.stopPropagation();
  });
  el.addEventListener('pointermove', e => {
    if (el.hasPointerCapture(e.pointerId)) seekTo(e.clientX);
  });
}

/* The two glyphs every transport in the app draws. Strings rather than a
   <symbol> in assets/icons.svg because they are set with innerHTML on a button
   that swaps between them on every play and pause, where a <use href> would be a
   second document fetch on the first press; and because canvas/video.js draws
   the same two triangles, and a video transport that invented its own play glyph
   would be a second visual language for the same verb on the same board. */
export const PLAY_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3.4l7.5 4.6L5 12.6z"/></svg>';
export const PAUSE_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.6 3.2h2.6v9.6H4.6zM8.8 3.2h2.6v9.6H8.8z"/></svg>';

/** m:ss. Hours are possible and would be a strange thing to pin to a board. */
export function clock(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
