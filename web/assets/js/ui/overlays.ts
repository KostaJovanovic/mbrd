// The two things the app says over the top of everything else.
//
// A toast and the waiting strip. They came out of util.ts, where they were the
// only code in the file that touched a document - which meant forty-four
// modules, most of which want clamp() and nothing more, imported two overlay
// renderers, and the file that called itself "small shared helpers,
// deliberately dependency-free" was the app's only DOM dependency below ui/.
//
// The two of them divide one job cleanly, and that division is the reason they
// share a file rather than being two:
//
//   a toast is a *receipt*  - it arrives after the fact, says what happened,
//                             and goes
//   the strip is a *state*  - it is up for exactly as long as the app cannot
//                             answer, and it says what is being waited on
//
// Which is why they can be on screen at once and why neither replaces the
// other. Both read ids that index.html declares (#toast, #busy, #busy-label,
// #busy-count, #busy-fill, #busy-cancel) and both are styled by
// assets/css/overlays.css; the two constants below that pair with a CSS
// duration say so where they sit.
//
// ── Nobody imports this ──
//
// Except main.ts, once, to hand the pair to notify.ts. Everything that has
// something to say - the importer, the packer, the optimiser, the mutation
// door, the clipboard - calls notify.ts's toast()/busy(), which forwards here
// if an interface was ever wired and does nothing if it was not. That is not
// ceremony: most of those callers are in the base layer or in storage/, and
// tests/layers.test.js fails outright on a base -> ui or storage -> ui import.
// The seam is what lets the message travel down the graph while the rendering
// stays up it.
//
// So do not import { toast } from here to save a hop. The hop is the layering.
//
// ── Nothing here runs at import time ──
//
// Every id is read inside a function, on the call that needs it, and never
// cached. tests/imports.test.js requires that of every module but the three it
// names, and there is a second reason beyond the rule: these two are the app's
// way of reporting that something went wrong, which makes them the worst
// possible thing to have failed during boot. A lookup deferred to the moment of
// use cannot be a lookup that ran before the element existed.
//
// ── What must not move in here ──
//
// Dialogs. ui/dialog.ts owns anything that asks a question and waits for an
// answer; these two never ask and never block. A confirm() that grew a toast's
// styling would be a modal nobody could tell was modal.
//
// Long-lived status. Neither of these is a place to park a message that should
// still be true in a minute - the toast fades and the strip is tied to a live
// job. A persistent condition belongs in the interface that owns it.

import { setOverlays } from '../notify.ts';
import type { BusyJob, BusyOptions, ToastKind } from '../notify.ts';

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

/**
 * How long a toast takes to fade, paired with the `transition` on .toast-line in
 * overlays.css. A line is only removed once the fade has run - removing it on
 * the old schedule would cut the fade off at its first frame.
 */
const TOAST_FADE_MS = 300;

/**
 * The most lines kept on screen at once.
 *
 * They stack rather than replace one another, so a sequence - "Loading the
 * encoder…", then what it did - can be read in order instead of the last word
 * wiping out the one that explained it. A cap so a burst (an import that touches
 * forty files) cannot paper the screen; the oldest drops when a new one would
 * push past it.
 */
const TOAST_MAX = 5;

/** One-line status message at the foot of the screen. Newest at the bottom. */
export function toast(msg: string, kind: ToastKind = ''): void {
  const host = document.getElementById('toast');
  if (!host) return;
  // A line of its own rather than the host's text, so a new message rises under
  // the last instead of overwriting it. The host is a bottom-anchored column, so
  // appending puts the newest at the foot and lifts the older ones above it.
  const line = document.createElement('div');
  line.className = kind === 'error' ? 'toast-line is-error' : 'toast-line';
  line.textContent = msg;
  host.append(line);
  // Over the cap: the oldest goes at once, before it has finished its own life.
  while (host.children.length > TOAST_MAX && host.firstChild) host.firstChild.remove();
  // Each line keeps its own clock - errors linger, the rest are receipts - and
  // fades then removes itself. A line dropped early by the cap is already off the
  // DOM, so remove() on it is a harmless no-op when the timer comes round.
  setTimeout(() => {
    line.classList.add('is-going');
    setTimeout(() => line.remove(), TOAST_FADE_MS);
  }, kind === 'error' ? 6000 : 2600);
}

// ---------------------------------------------------------------------------
// The waiting strip
// ---------------------------------------------------------------------------

/**
 * How long a job must last before it is worth mentioning.
 *
 * Most imports are one small file and finish inside a frame or two. Showing a
 * panel for those would be a flash of furniture rather than information, and a
 * flash reads as a fault. Anything under this simply happens.
 */
const BUSY_SHOW_MS = 180;

/**
 * And how long it stays once it has appeared.
 *
 * The pair matters more than either number. Without a floor, a job that crosses
 * the delay by a hair puts the strip up and takes it away in the same breath -
 * which is the flash the delay was there to prevent, arriving by the other
 * door.
 */
const BUSY_MIN_MS = 450;

interface Job {
  label: string;
  done: number;
  total: number;
  live: boolean;
  onCancel: (() => void) | null;
}

/** Live jobs, oldest first. The newest one gets to say what it is doing. */
const busyJobs: Job[] = [];
let busyShowTimer = 0;
let busyHideTimer = 0;
let busyShownAt = 0;
/**
 * Whether the strip is meant to be up, tracked separately from the class that
 * puts it up.
 *
 * The class is applied a frame after the decision, so that the panel has a
 * previous state to animate from. A job that ends inside that frame would find
 * no class to remove and leave the pending frame to raise a strip that nothing
 * is left to lower - a spinner that never stops, over a board that is perfectly
 * idle. The flag is what that frame checks.
 */
let busyOpen = false;
/** The cancel button's one click listener is attached lazily, once. */
let busyCancelWired = false;

/**
 * Say that something is being waited on. Returns the handle that ends it.
 *
 * Jobs stack rather than replace: two things running at once keep the strip up
 * until both are done, and the strip shows the most recent, because that is the
 * one whose progress is still changing.
 *
 * `end()` is idempotent, so a `finally` that runs twice cannot leave the count
 * below zero - which would strand the strip open for the rest of the session.
 */
export function busy(label = 'Working', { onCancel = null }: BusyOptions = {}): BusyJob {
  const job: Job = { label, done: 0, total: 0, live: true, onCancel };
  busyJobs.push(job);
  busySchedule();
  return {
    label(text: string) { job.label = text || job.label; busyPaint(); },
    step(done: number, total: number) { job.done = done; job.total = total; busyPaint(); },
    end() {
      if (!job.live) return;
      job.live = false;
      const i = busyJobs.indexOf(job);
      if (i >= 0) busyJobs.splice(i, 1);
      busySchedule();
    },
  };
}

function busySchedule(): void {
  if (busyJobs.length) {
    clearTimeout(busyHideTimer);
    busyPaint();
    if (busyOpen || busyShowTimer) return;
    busyShowTimer = setTimeout(() => {
      busyShowTimer = 0;
      if (!busyJobs.length) return;
      busyOpen = true;
      busyShownAt = Date.now();
      busyPaint();
      const node = document.getElementById('busy');
      if (node) node.hidden = false;
      // Same one-frame gap the threads in canvas/web.ts need: an element that
      // arrives and is told its target in the same tick has nothing to
      // interpolate from, so the entrance simply does not play.
      requestAnimationFrame(() => {
        if (busyOpen && node) node.classList.add('is-up');
      });
    }, BUSY_SHOW_MS);
    return;
  }

  // Nothing left to wait for.
  clearTimeout(busyShowTimer);
  busyShowTimer = 0;
  if (!busyOpen) return;
  const shown = Date.now() - busyShownAt;
  if (shown >= BUSY_MIN_MS) busyClose();
  else busyHideTimer = setTimeout(busyClose, BUSY_MIN_MS - shown);
}

function busyClose(): void {
  busyOpen = false;
  const node = document.getElementById('busy');
  if (!node) return;
  node.classList.remove('is-up');
  // Left in the tree until the exit has run, then taken out of the accessibility
  // tree properly rather than merely being transparent.
  busyHideTimer = setTimeout(() => { if (!busyOpen) node.hidden = true; }, 260);
}

function busyPaint(): void {
  const node = document.getElementById('busy');
  if (!node || !busyOpen) return;
  const job = busyJobs[busyJobs.length - 1];
  if (!job) return;
  const label = document.getElementById('busy-label');
  const count = document.getElementById('busy-count');
  const fill = document.getElementById('busy-fill');
  if (label) label.textContent = busyJobs.length > 1 ? `${job.label} (+${busyJobs.length - 1})` : job.label;
  const known = job.total > 0;
  if (count) count.textContent = known ? `${job.done}/${job.total}` : '';
  // Two different bars sharing one element. Determinate is a width this code
  // sets; indeterminate is a transform a stylesheet animates - and it has to be
  // the stylesheet, because the work being waited on is often synchronous and
  // would sit on any animation this thread was running. A compositor-driven
  // slide keeps moving while the main thread hashes a video; a rAF loop stops
  // dead at exactly the moment somebody is looking at it for reassurance.
  node.classList.toggle('is-counting', known);
  if (fill && known) fill.style.width = Math.round(100 * Math.min(1, job.done / job.total)) + '%';
  else if (fill) fill.style.width = '';
  // A cancel button, only for a job that offered one (the top job speaks, as with
  // the label). Wired once to whatever job is on top when it is pressed.
  const cancel = document.getElementById('busy-cancel');
  if (cancel) {
    if (!busyCancelWired) {
      cancel.addEventListener('click', () => busyJobs[busyJobs.length - 1]?.onCancel?.());
      busyCancelWired = true;
    }
    cancel.hidden = !job.onCancel;
  }
}

/**
 * Hand the pair to notify.ts, which is how every layer below this one reaches
 * them. Called from main.ts before anything can have something to say.
 */
export function initOverlays(): void {
  setOverlays({ toast, busy });
}
