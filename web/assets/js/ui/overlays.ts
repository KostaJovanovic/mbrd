// Toast (receipt — says what happened, then fades) and busy strip
// (state — up while a job runs). Wired into notify.ts by main.ts so
// lower layers can show messages without importing ui/.
// IDs are read lazily — nothing touches document at import time.

import { setOverlays } from '../notify.ts';
import { fastMs, reducedMotion } from '../canvas/viewport.ts';
import type { BusyJob, BusyOptions, ToastAction, ToastKind } from '../notify.ts';

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

/** Fade duration — must match .toast-line transition in status.css. */
const TOAST_FADE_MS = 300;

/** Cap on stacked toast lines — oldest drops when exceeded. */
const TOAST_MAX = 5;

/** One-line status message at the foot of the screen. Newest at the bottom. */
export function toast(msg: string, kind: ToastKind = '', action?: ToastAction): void {
  const host = document.getElementById('toast');
  if (!host) return;
  const line = document.createElement('div');
  line.className = kind === 'error' ? 'toast-line is-error' : 'toast-line';
  line.textContent = msg;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-act';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { restack(host, () => line.remove()); action.run(); });
    line.append(btn);
  }
  restack(host, () => host.append(line));
  // Past the cap the oldest fade as an expiring line does, rather than vanish.
  const live = host.querySelectorAll<HTMLElement>('.toast-line:not(.is-going)');
  for (let i = 0; i < live.length - TOAST_MAX; i++) retire(host, live[i]);
  // A toast with a way back stays as long as an error, to leave time to press it.
  const ms = kind === 'error' || action ? 6000 : 2600;
  if (action) holdWhileUsed(host, line, ms);
  else setTimeout(() => retire(host, line), ms);
}

/** After the pointer or focus leaves a held toast, how long it stays. */
const TOAST_LINGER_MS = 2000;

/**
 * Retire a toast with a button after `ms`, but never while the pointer is on
 * it or focus is in it - a bare timer took the Undo away from under a hand
 * that was reaching for it, or from a keyboard that had just tabbed to it.
 * Leaving starts a short linger rather than the whole wait again.
 */
function holdWhileUsed(host: HTMLElement, line: HTMLElement, ms: number): void {
  let timer = 0;
  let over = false;
  const arm = (wait: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!over && !line.contains(document.activeElement)) retire(host, line); }, wait);
  };
  const leave = () => {
    // focusout fires before the next element has focus; wait a tick to read it.
    setTimeout(() => {
      if (!over && !line.contains(document.activeElement)) arm(TOAST_LINGER_MS);
    });
  };
  line.addEventListener('pointerenter', () => { over = true; clearTimeout(timer); });
  line.addEventListener('pointerleave', () => { over = false; leave(); });
  line.addEventListener('focusin', () => clearTimeout(timer));
  line.addEventListener('focusout', leave);
  arm(ms);
}

/** Fade a line out, then take it away with the stack closing over it. */
function retire(host: HTMLElement, line: HTMLElement): void {
  if (line.classList.contains('is-going')) return;
  line.classList.add('is-going');
  setTimeout(() => restack(host, () => line.remove()), TOAST_FADE_MS);
}

/**
 * Change the stack and let the lines that stay move to their new places
 * rather than jump there. The column is anchored at the foot, so every
 * arrival shoved the others up by a line in one frame. Measured before and
 * after, then played back as a `translate` - the property, so it composes with
 * the line's own tilt and its `rise` entrance, both on `transform`.
 */
function restack(host: HTMLElement, change: () => void): void {
  // SAFETY: #toast holds only the .toast-line divs toast() appends.
  const lines = [...host.children] as HTMLElement[];
  const before = lines.map(el => el.getBoundingClientRect().top);
  change();
  if (reducedMotion() || typeof host.animate !== 'function') return;
  const easing = getComputedStyle(document.documentElement).getPropertyValue('--ease').trim() || 'ease-out';
  lines.forEach((el, i) => {
    if (!el.isConnected) return;
    const dy = before[i] - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) return;
    el.animate([{ translate: `0 ${dy}px` }, { translate: '0 0' }], { duration: fastMs(), easing });
  });
}

// ---------------------------------------------------------------------------
// The waiting strip
// ---------------------------------------------------------------------------

/** Delay before showing — avoids flash for sub-frame jobs. */
const BUSY_SHOW_MS = 180;

/** Minimum display time once shown — prevents flash from jobs barely over BUSY_SHOW_MS. */
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
// Tracked separately from the CSS class — the class is applied one frame
// later for animation, so a job ending in that frame needs the flag.
let busyOpen = false;
/** Cancel listener wired lazily, once. */
let busyCancelWired = false;

/** Start a busy job. Jobs stack; strip stays until all end. end() is idempotent. */
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
      // One-frame gap so the entrance animation has a previous state.
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
  // Hidden after exit animation finishes, not just made transparent. The exit
  // is --dur-fast (status.css), 190ms at the slowest tier.
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
  // Determinate: width set here. Indeterminate: CSS animation (compositor-driven
  // so it moves even during synchronous work).
  node.classList.toggle('is-counting', known);
  if (fill && known) fill.style.width = Math.round(100 * Math.min(1, job.done / job.total)) + '%';
  else if (fill) fill.style.width = '';
  const cancel = document.getElementById('busy-cancel');
  if (cancel) {
    if (!busyCancelWired) {
      cancel.addEventListener('click', () => busyJobs[busyJobs.length - 1]?.onCancel?.());
      busyCancelWired = true;
    }
    cancel.hidden = !job.onCancel;
  }
}

/** Wire toast/busy into notify.ts for cross-layer access. */
export function initOverlays(): void {
  setOverlays({ toast, busy });
}
