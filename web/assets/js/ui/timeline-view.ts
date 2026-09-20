// Timeline drawn - the step ledger from timeline.ts, docked along the foot of
// the window on every width, the way a CAD history bar is: the board ends above
// it rather than under it. Its height is --dock, which #viewport and every piece
// of bottom-anchored furniture add to their inset. Play on the left, one mark
// per step in the middle with a playhead in the gap after the step shown and a
// page-drawn scrollbar above, and the rest behind a gear and the right-click.

import { bus } from '../board-store.ts';
import { toast } from '../notify.ts';
import { formatBytes } from '../util.ts';
import { readPref, writePref } from '../prefs.ts';
import { ARRANGEMENTS, MOBILE_ARRANGEMENTS } from '../arrange/arrangements.ts';
import { openAnchored, menuButton, icon } from './menu.ts';
import type { MenuEntry } from './menu.ts';
import { ask } from './dialog.ts';
import {
  board,
  timelineSteps, timelineAt, timelineStale, goTo, editStep, stepEditable,
  timelineBytes, trimmable, trimTimeline, describeStep, nameStep, deleteTimeline,
  deleteStep, deleteAhead, setTimelinePlaying,
} from '../state.ts';

/**
 * The row a delegated click landed on, by selector, or null. The listeners
 * here are delegated (the marks are rebuilt on every change) and share this cast.
 */
// SAFETY: these listeners are on elements inside #timeline-strip, so `target`
// came off this document; the optional chain covers null.
const rowUnder = (event: Event, selector: string) =>
  (event.target as HTMLElement | null)?.closest<HTMLElement>(selector);

let strip: HTMLElement | null = null;
let track: HTMLElement | null = null;
let rail: HTMLElement | null = null;
let marker: HTMLElement | null = null;
let where: HTMLElement | null = null;
let scrollBar: HTMLElement | null = null;
let thumb: HTMLElement | null = null;
let playButton: HTMLButtonElement | null = null;
/** Whether the bar is up. */
let open = false;

/**
 * Whether the bar is up, per device rather than per board: whether a screen
 * has the room for it is a fact about the screen. Absent means never chosen.
 */
const PREF = 'mbrd.timeline';

/**
 * How many steps are drawn at once. A ceiling, not a window: past this the
 * newest are shown. Three thousand buttons is three thousand event targets,
 * and the far end of a long history is the part nobody aims a mouse at.
 */
const MAX_DOTS = 400;

/** Play replays the history at three and a half steps a second (R33). */
const STEP_MS = Math.round(1000 / 3.5);
/** The replay's timer, or 0 when nothing is playing. */
let playing = 0;

/**
 * What goes inert while Play runs: the tools that edit the board. Find stays,
 * since it only flies the view. The gear goes too, in paintPlay().
 */
const LOCKED = '#toolbar [data-cmd]:not([data-cmd="find"]), #history-ctl, #drawer-btn, #mobile-header-edit-btn';

/** The two faces of the play button. Named constants, so tests/icons.test.js reads both. */
const PLAY = { icon: 'i-tl-play', said: 'Play the history' };
const PAUSE = { icon: 'i-tl-pause', said: 'Pause' };

/**
 * The command surface, as this module sees it: one camera move, pressed after
 * every step a replay draws. Injected like ui/hud.ts's, to keep commands.ts out
 * of this module's imports — and it is `cmds.fit` rather than `vp.fit` so the
 * replay frames the board exactly as the F key does, Mobile's parked title card
 * excluded and all.
 */
export interface TimelineCommands {
  fit: () => void;
}

let cmds: TimelineCommands | null = null;

/** A phone, for the one decision made on it: the bar starts closed there. */
const phone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches;

/**
 * What each kind of step looks like, and how it reads in the past tense.
 *
 * **Keyed on the label commit() was given**, the app's own finite
 * vocabulary. Where a label carries a count (`Rearrange 14 items`) only the
 * first word is matched, so the lookup tries the whole string then the
 * first word. The icon is a symbol in web/assets/icons.svg, reached by name
 * - tests/icons.test.js checks both directions.
 */
const KINDS: Record<string, { icon: string, said: string }> = {
  'Add': { icon: 'i-plus', said: 'Added' },
  'Move': { icon: 'i-move', said: 'Moved' },
  'Nudge': { icon: 'i-move', said: 'Nudged' },
  'Resize': { icon: 'i-expand', said: 'Resized' },
  'Reset': { icon: 'i-reset-size', said: 'Reset the size of' },
  'Delete': { icon: 'i-delete', said: 'Deleted' },
  'Cut': { icon: 'i-delete', said: 'Cut' },
  'Restore': { icon: 'i-restore', said: 'Restored' },
  'Empty': { icon: 'i-delete', said: 'Emptied the bin' },
  'Duplicate': { icon: 'i-duplicate', said: 'Duplicated' },
  'Paste': { icon: 'i-paste', said: 'Pasted' },
  'Rename': { icon: 'i-rename', said: 'Renamed' },
  // renameBoard() and commitHeader() in state.ts.
  'Rename board': { icon: 'i-rename', said: 'Renamed the board' },
  'Edit header': { icon: 'i-style', said: 'Restyled the header' },
  // commitAppearance() in state.ts, from the Whimsy slider.
  'Whimsy': { icon: 'i-style', said: 'Changed the whimsy' },
  'Rearrange': { icon: 'i-rearrange', said: 'Rearranged' },
  'Align': { icon: 'i-align-left', said: 'Aligned' },
  'Distribute': { icon: 'i-distribute-h', said: 'Distributed' },
  'Connect': { icon: 'i-connect', said: 'Joined' },
  'Edit note': { icon: 'i-edit-text', said: 'Wrote in' },
  'Edit connection': { icon: 'i-connect', said: 'Changed the join on' },
  'Remove connection': { icon: 'i-connect', said: 'Unjoined' },
  'Recolour swatch': { icon: 'i-swatch', said: 'Recoloured' },
  // setItemFaded() in state.ts, from a sticky's menu.
  'Low opacity': { icon: 'i-low-opacity', said: 'Faded' },
  'Full opacity': { icon: 'i-low-opacity', said: 'Unfaded' },
  // Keyed off the commit labels in setItemsLocked (state.ts), where the two
  // strings are written and the note about the word lives.
  'Anchor': { icon: 'i-anchor', said: 'Anchored' },
  'Unanchor': { icon: 'i-anchor-off', said: 'Unanchored' },
  'Tag': { icon: 'i-tag', said: 'Tagged' },
  'Untag': { icon: 'i-tag', said: 'Untagged' },
  'Unstick': { icon: 'i-snap', said: 'Unstuck' },
  'Bring': { icon: 'i-front', said: 'Brought to the front' },
  'Send': { icon: 'i-back', said: 'Sent to the back' },
  'Stickers': { icon: 'i-sticker', said: 'Added a sticker' },
  // replaceItem() in state.ts, from import/unpack.ts.
  'Unzip': { icon: 'i-arrow-up', said: 'Unzipped' },
  'Open folder': { icon: 'i-arrow-up', said: 'Opened' },
};

/** The one every step that is none of the above falls back to. */
const PLAIN = { icon: 'i-pen', said: 'Changed' };

const kindOf = (label: string) =>
  KINDS[label] || KINDS[label.split(' ')[0]] || PLAIN;

/**
 * One step as a sentence: what was done, to what.
 *
 * A name somebody gave the point wins outright. Two cards or more are
 * counted rather than listed - a run collapses every move of the same card
 * into one step, so naming just the first of six would be arbitrary.
 */
function sentenceFor(step: Step): string {
  if (step.name) return step.name;
  const { said } = kindOf(step.label);
  const { count, name } = describeStep(step);
  if (!count) return said;
  if (count > 1) return `${said} ${count} cards`;
  return name ? `${said} ${name}` : said;
}

export function initTimeline(commands: TimelineCommands) {
  cmds = commands;
  // The bus first and outside the guard below, like every init here.
  // Only Pause stops a replay, besides its own last step and a board that goes:
  // nothing can edit the board while it runs (see paintPlay()).
  bus.on('history', () => { if (open) render(); });
  bus.on('readonly', refuseEdit);
  bus.on('board:load', () => {
    pause();
    if (open) render();
  });
  strip = document.getElementById('timeline-strip');
  if (!strip) return;
  track = strip.querySelector('.tl-track');
  rail = strip.querySelector('.tl-rail');
  marker = strip.querySelector('.tl-marker');
  where = strip.querySelector('.tl-where');
  scrollBar = strip.querySelector('.tl-scroll');
  thumb = strip.querySelector('.tl-thumb');
  playButton = strip.querySelector<HTMLButtonElement>('[data-tl="play"]');
  playButton?.addEventListener('click', () => {
    if (timelineStale()) return;
    if (playing) pause();
    else play();
  });
  const gear = strip.querySelector<HTMLButtonElement>('.tl-gear');
  if (gear) {
    menuButton(gear, () => openAnchored(gear.getBoundingClientRect(), gearEntries(), { label: 'Timeline' }));
  }
  // Delegated: the marks are rebuilt on every change.
  track?.addEventListener('click', event => {
    const dot = rowUnder(event, '.tl-step');
    // Not while Play runs, which only Pause stops.
    if (!dot?.dataset.at || playing) return;
    goTo(Number(dot.dataset.at));
  });
  track?.addEventListener('keydown', stepKeys);
  // Right-click is the app's menu everywhere on the bar, never the browser's:
  // on a mark, what can be done to that step; anywhere else, the gear's rows.
  // Left is *take me there*, right is *do something to it*.
  strip.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (playing) return;
    const dot = rowUnder(event, '.tl-step');
    if (dot?.dataset.at) {
      openAnchored(dot.getBoundingClientRect(), stepEntries(Number(dot.dataset.at)), { label: 'Step' });
      return;
    }
    const { clientX: x, clientY: y } = event;
    openAnchored({ left: x, right: x, top: y, bottom: y }, gearEntries(), { label: 'Timeline' });
  });
  // A finger's pan and a trackpad's sideways swipe scroll natively, held to
  // whole steps here.
  track?.addEventListener('scroll', () => { scrollToStep(track!.scrollLeft, false); placeMarker(); paintScroll(); }, { passive: true });
  wireMarker();
  wireScroll();
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { writeDock(); fitView(); placeMarker(); paintScroll(); }).observe(strip);
  }
  // On from now on, off to begin with on a phone, then whatever was last chosen here.
  const saved = readPref(PREF);
  if (saved === null ? !phone() : saved === '1') openBar();
}

/** Is the bar up? What the panel's Show timeline box starts from. */
export const timelineShown = () => open;

/** The Timeline button: up or down, remembered on this device. */
export function toggleTimeline() {
  // The bar holds Pause, the one way to stop a replay, so it stays while one runs.
  if (playing) {
    paintToggle();
    toast('Pause the timeline before you hide it');
    return;
  }
  if (open) closeBar();
  else openBar();
  writePref(PREF, open ? '1' : '0');
}

function openBar() {
  if (!strip || open) return;
  open = true;
  strip.hidden = false;
  render();
  writeDock();
  paintToggle();
}

function closeBar() {
  if (!strip || !open) return;
  pause();
  open = false;
  strip.hidden = true;
  writeDock();
  paintToggle();
}

/** The bar's height as --dock, or nothing when it is down. */
function writeDock() {
  const root = document.documentElement;
  if (open && strip) root.style.setProperty('--dock', `${Math.round(strip.getBoundingClientRect().height)}px`);
  else root.style.removeProperty('--dock');
}

/** Whichever Timeline buttons are on screen say whether the bar is up, and so
 *  does the panel's box: the panel repaints on nothing the bar announces. */
function paintToggle() {
  for (const button of document.querySelectorAll('[data-cmd="timeline"]')) {
    button.setAttribute('aria-pressed', String(open));
  }
  const box = document.getElementById('opt-timeline');
  if (box instanceof HTMLInputElement) box.checked = open;
}

/**
 * The arrow keys walk the history from a focused mark, since the bar keeps no
 * step buttons: Left and Right one step, Home and End to either end.
 */
function stepKeys(event: KeyboardEvent) {
  if (timelineStale() || playing) return;
  const at = timelineAt();
  const last = timelineSteps().length;
  const target = event.key === 'ArrowLeft' ? at - 1
    : event.key === 'ArrowRight' ? at + 1
      : event.key === 'Home' ? 0
        : event.key === 'End' ? last
          : null;
  if (target === null) return;
  event.preventDefault();
  if (target >= 0 && target <= last && target !== at) goTo(target);
  // render() rebuilt the marks, so the focus goes to the one the board is at.
  // It is in view already (fitView), and a focus that scrolled would land
  // between two steps.
  track?.querySelector<HTMLElement>('.tl-step.is-at')?.focus({ preventScroll: true });
}

/**
 * Frame the board the replay has just drawn. Every step, because a history
 * builds a board up: framed once at the start, the last hour of work happens
 * off the edge of the window, and a replay nobody can see is no replay.
 *
 * The move is animated and outlasts the step (travelMs is 400ms against
 * STEP_MS's 286), which is the point — vp.fit reads the pan it interrupts as
 * its own start, so the camera eases the whole way rather than cutting on every
 * mark. A step that leaves the bounds alone costs nothing: viewTo returns
 * without animating when the target is where the view already is.
 */
const frameBoard = () => cmds?.fit();

/** Replay from here to the newest step, or from the start when there is nothing ahead. */
function play() {
  if (!timelineSteps().length) return;
  if (timelineAt() >= timelineSteps().length) goTo(0);
  frameBoard();
  playing = window.setInterval(() => {
    const at = timelineAt();
    if (at < timelineSteps().length) goTo(at + 1);
    frameBoard();
    if (timelineAt() >= timelineSteps().length) pause();
  }, STEP_MS);
  setTimelinePlaying(true);
  paintPlay();
}

function pause() {
  if (!playing) return;
  clearInterval(playing);
  playing = 0;
  setTimelinePlaying(false);
  paintPlay();
}

/** An edit the replay refused (history.ts), said once in a while, not per try. */
let refusedAt = 0;
function refuseEdit() {
  const now = Date.now();
  if (now - refusedAt < 2500) return;
  refusedAt = now;
  toast('The board cannot change while the timeline plays. Press Pause first.');
}

function paintPlay() {
  // The board is read-only while Play runs, and so is the chrome that edits
  // it, and the gear, whose rows would stop or rewrite the replay.
  document.documentElement.classList.toggle('is-replaying', !!playing);
  for (const el of document.querySelectorAll(LOCKED)) el.toggleAttribute('inert', !!playing);
  const gear = strip?.querySelector<HTMLButtonElement>('.tl-gear');
  if (gear) gear.disabled = !!playing;
  if (!playButton) return;
  const face = playing ? PAUSE : PLAY;
  playButton.replaceChildren(icon(face.icon));
  playButton.title = face.said;
  playButton.setAttribute('aria-label', face.said);
  playButton.setAttribute('aria-pressed', String(!!playing));
}

function render() {
  if (!strip || !track || !where) return;
  const steps = timelineSteps();
  const at = timelineAt();
  const stale = timelineStale();
  strip.classList.toggle('is-stale', stale);

  // createElement throughout, never innerHTML - a step's label is a string
  // and the escaping problem is solved by not having one.
  track.replaceChildren();
  const shown = steps.length > MAX_DOTS ? steps.slice(-MAX_DOTS) : steps;
  const offset = steps.length - shown.length;

  // The start mark only when the start is what's shown - otherwise the
  // leftmost mark would claim to be the beginning while sitting a thousand
  // steps from its neighbour.
  if (!offset) track.append(dotFor(null, 0, at, 'Where this board started'));
  shown.forEach((step, index) => {
    const position = offset + index + 1;
    track!.append(dotFor(step, position, at, sentenceFor(step)));
  });

  // Words only on a stale history. The step count ("5 of 8") went in R33:
  // the playhead says where the board stands, and the marks say how many.
  where.textContent = stale ? 'Does not match' : '';
  where.title = stale ? 'This history does not match this board' : '';
  // Nothing to play with no steps, and nothing works on a stale history.
  if (playButton) playButton.disabled = stale || !steps.length;
  fitView();
  placeMarker();
  paintScroll();
}

/**
 * One mark and the gap after it: the distance the steps scroll by. The track
 * moves by whole steps only and is sized to whole steps (fitView), so no mark
 * is ever drawn cut at either end of it. 0 while the bar is down.
 */
function pitch(): number {
  const dot = track?.querySelector<HTMLElement>('.tl-step');
  if (!track || !dot?.offsetWidth) return 0;
  return dot.offsetWidth + (parseFloat(getComputedStyle(track).columnGap) || 0);
}

/**
 * Scroll to the whole step nearest `left`. With `hold`, only as far as the step
 * the board stands on allows, so it stays in view: every scroll the page makes
 * itself holds, on a render, a new step, a replay and a resize. The reader's own
 * scrolls - the scrollbar, the wheel, a swipe - do not, or the bar could not
 * reach the old steps; the next change of step brings the view back.
 */
function scrollToStep(left: number, hold = true) {
  if (!track) return;
  const p = pitch();
  if (!p) { track.scrollLeft = left; return; }
  const room = track.scrollWidth - track.clientWidth;
  let to = Math.round(left / p) * p;
  const dot = hold ? track.querySelector<HTMLElement>('.tl-step.is-at') : null;
  if (dot) {
    const index = [...track.children].indexOf(dot);
    const fits = Math.max(1, Math.round(track.clientWidth / p));
    to = Math.max((index - fits + 1) * p, Math.min(index * p, to));
  }
  to = Math.max(0, Math.min(room, to));
  if (track.scrollLeft !== to) track.scrollLeft = to;
}

/**
 * Size the track, and the scrollbar over it, to as many whole steps as the bar
 * has room for, and bring the step the board stands on into view. On every
 * render and every change of the bar's width: a narrower window takes steps
 * off the view, never the one the board is at.
 */
function fitView() {
  if (!track || !rail || !scrollBar) return;
  const p = pitch();
  if (!p) return;
  const width = `${Math.max(1, Math.floor(rail.clientWidth / p)) * p}px`;
  track.style.width = width;
  scrollBar.style.width = width;
  // Where it is, held to the current step: the playhead's gap after the last
  // whole step is inside the view, because the view is whole steps wide.
  scrollToStep(track.scrollLeft);
}

/**
 * The playhead, in the gap after the step the board stands on, so the mark to
 * its left is the last step shown. Hidden when that gap is scrolled away. The
 * track starts at the rail's left edge and may stop short of its right.
 */
function placeMarker() {
  if (!marker || !track || !rail) return;
  const dot = track.querySelector<HTMLElement>('.tl-step.is-at');
  if (!dot) { marker.hidden = true; return; }
  const box = rail.getBoundingClientRect();
  const x = gapAfter(dot) - box.left;
  marker.hidden = x < 0 || x > track.clientWidth;
  marker.style.left = `${x}px`;
}

/** The screen x of the middle of the gap after a mark: where the playhead stands for it. */
function gapAfter(dot: HTMLElement): number {
  const right = dot.getBoundingClientRect().right;
  const next = dot.nextElementSibling;
  if (next) return (right + next.getBoundingClientRect().left) / 2;
  const gap = track ? parseFloat(getComputedStyle(track).columnGap) || 0 : 0;
  return right + gap / 2;
}

/** The narrowest the scrollbar's thumb is drawn, in pixels, so it stays a thing to hold. */
const MIN_THUMB = 24;

/**
 * The scrollbar over the steps, drawn by the page. The track's own is hidden:
 * the website drew a styled one, and the desktop app on Windows drew the
 * system's grey slab under the marks (research/old/done-2026-09-15.md,
 * R1). This one is the same everywhere, and sits above the marks.
 */
function paintScroll() {
  if (!track || !scrollBar || !thumb) return;
  const room = track.scrollWidth - track.clientWidth;
  scrollBar.classList.toggle('is-idle', room < 1);
  if (room < 1) return;
  const bar = scrollBar.clientWidth;
  const size = Math.max(MIN_THUMB, bar * track.clientWidth / track.scrollWidth);
  thumb.style.width = `${size}px`;
  thumb.style.transform = `translateX(${(bar - size) * track.scrollLeft / room}px)`;
}

/**
 * The scrollbar's three ways in: drag the thumb, press the bar beside it to
 * bring that part into view, or turn a mouse wheel over the steps.
 */
function wireScroll() {
  const bar = scrollBar;
  const grip = thumb;
  const list = track;
  if (!bar || !grip || !list) return;
  grip.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    grip.classList.add('is-dragging');
    const from = event.clientX;
    const start = list.scrollLeft;
    // Pixels of track per pixel of thumb travel.
    const rate = (list.scrollWidth - list.clientWidth) / Math.max(1, bar.clientWidth - grip.offsetWidth);
    const move = (e: PointerEvent) => { scrollToStep(start + (e.clientX - from) * rate, false); };
    const up = () => {
      grip.classList.remove('is-dragging');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  bar.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target === grip) return;
    const box = bar.getBoundingClientRect();
    const share = (event.clientX - box.left) / Math.max(1, box.width);
    scrollToStep(share * list.scrollWidth - list.clientWidth / 2, false);
  });
  // A wheel turns the steps sideways, a whole step at a time: there is no
  // system bar to aim at now. A trackpad's small turns add up to a step; a
  // line (Firefox's wheel notch) is a step.
  let spun = 0;
  list.addEventListener('wheel', event => {
    if (event.deltaX || !event.deltaY || list.scrollWidth <= list.clientWidth) return;
    event.preventDefault();
    const p = pitch();
    if (!p) return;
    spun += event.deltaMode === 1 ? event.deltaY * p : event.deltaY;
    const by = Math.trunc(spun / p);
    if (!by) return;
    spun -= by * p;
    scrollToStep(list.scrollLeft + by * p, false);
  }, { passive: false });
}

/**
 * Dragging the marker goes to the step nearest the pointer, a frame at a
 * time. The marker snaps to each step as the board arrives there, since
 * render() puts it back over the step it stands on.
 */
function wireMarker() {
  const handle = marker;
  if (!handle) return;
  handle.addEventListener('pointerdown', event => {
    if (timelineStale() || playing || event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('is-dragging');
    let frame = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const at = nearestStep(e.clientX);
        if (at !== null && at !== timelineAt()) goTo(at);
      });
    };
    const up = () => {
      cancelAnimationFrame(frame);
      handle.classList.remove('is-dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

/** The position whose playhead gap is nearest a screen x, or null with no mark drawn. */
function nearestStep(x: number): number | null {
  if (!track) return null;
  let best: number | null = null;
  let gap = Infinity;
  for (const dot of track.querySelectorAll<HTMLElement>('.tl-step')) {
    const d = Math.abs(gapAfter(dot) - x);
    if (d < gap) { gap = d; best = Number(dot.dataset.at); }
  }
  return best;
}

/**
 * Give the step at `position` a name - the point the board stands on, from
 * the gear, or any mark, from its right-click. A name on a step is a
 * landmark, and keeps it from being folded away when an old history is trimmed.
 */
async function namePoint(position = timelineAt()) {
  if (!position || timelineStale()) return;
  const step = timelineSteps()[position - 1];
  if (!step) return;
  const named = !!step.name;
  const given = await ask({
    title: named ? 'Rename this point' : 'Name this point',
    body: 'A name makes this step a landmark on the Timeline, and keeps it from'
      + ' being folded away when an old history is trimmed.',
    go: named ? 'Rename' : 'Name it',
    field: { value: step.name || '', placeholder: sentenceFor(step), maxLength: 120 },
  });
  // An empty box is an answer: "take the name off this one". The step is
  // found again by id: the history can change while the dialog is open.
  if (given === null) return;
  const index = timelineSteps().indexOf(step);
  if (index >= 0) nameStep(given, index);
}

/**
 * What the right-click on a mark offers: go there, change its rule where it
 * has one, name it, delete it. The start mark is a position, not a step, so
 * it has only the first. A stale history offers nothing that changes it.
 */
function stepEntries(position: number): MenuEntry[] {
  const at = timelineAt();
  const stale = timelineStale();
  const step = position ? timelineSteps()[position - 1] : null;
  const edits = step && !stale ? editEntries(position - 1) : [];
  const entries: MenuEntry[] = [{
    label: position ? 'Go to this step' : 'Go to the start',
    disabled: position === at || stale,
    action: () => { goTo(position); },
  }];
  if (edits.length) entries.push({ sep: true }, ...edits);
  if (!step || stale) return entries;
  entries.push(
    { sep: true },
    { label: step.name ? 'Rename this step' : 'Name this step', action: () => { void namePoint(position); } },
    {
      label: 'Delete this step',
      danger: true,
      action: () => {
        const index = timelineSteps().indexOf(step);
        if (index >= 0 && deleteStep(index)) toast('Step deleted');
      },
    },
  );
  return entries;
}

/**
 * Behind the gear: the things to do first, together, and then how big the
 * history is, as a line to read under them. The acts are naming the point the
 * board stands on, the trim, deleting the steps ahead of it, deleting the
 * whole history, and Hide timeline. A right-click off the marks opens these too.
 *
 * The name row is absent at the start of the board, where there is no step
 * to name, and on a stale history, where nothing here works. Its word
 * changes because the act does: naming a named point is renaming it. The
 * trim folds steps older than 30 days into the starting state, never across
 * a named point, and is absent when there is nothing that old to fold. The
 * steps ahead are absent at the newest step and on a stale history. Delete
 * timeline is absent with no steps, and works on a stale history, which is the one
 * thing still worth doing with it.
 */
function gearEntries(): MenuEntry[] {
  const steps = timelineSteps();
  const at = timelineAt();
  const count = trimmable();
  const ahead = steps.length - at;
  return [
    {
      label: steps[at - 1]?.name ? 'Rename this point' : 'Name this point',
      hidden: !at || timelineStale(),
      action: () => { void namePoint(); },
    },
    {
      label: `Fold in ${count} step${count === 1 ? '' : 's'} older than 30 days`,
      hidden: !count,
      action: () => {
        const went = trimTimeline();
        if (went) toast(`Folded ${went} step${went === 1 ? '' : 's'} into the starting state`);
        if (open) render();
      },
    },
    {
      label: `Delete ${ahead} step${ahead === 1 ? '' : 's'} after this point`,
      danger: true,
      hidden: !ahead || timelineStale(),
      action: () => { void deleteFuture(); },
    },
    { label: 'Delete timeline', danger: true, hidden: !steps.length, action: () => { void deleteHistory(); } },
    // Show timeline in the panel brings it back, and the toast says where, since
    // a bar that goes from its own menu leaves nothing on screen to find it by.
    {
      label: 'Hide timeline',
      action: () => {
        if (!open) return;
        toggleTimeline();
        toast('Timeline hidden - Show timeline in the sidebar brings it back');
      },
    },
    { sep: true },
    {
      label: `${steps.length} step${steps.length === 1 ? '' : 's'}, ${formatBytes(timelineBytes())}`,
      disabled: true,
    },
  ];
}

/**
 * Delete the whole history, after asking: the board as it stands becomes the
 * start, and the steps, their names and the undo stack all go. The board
 * itself does not change.
 */
async function deleteHistory() {
  const answer = await ask({
    title: 'Delete the timeline?',
    body: 'You are about to delete your entire timeline. There is no going back. Are you sure?',
    go: "Yes, I'm sure",
  });
  if (answer !== 'go') return;
  pause();
  deleteTimeline();
  toast('Timeline deleted');
}

/**
 * Delete every step after the point the board stands on, after asking. The
 * board does not change; what goes is the way forward from it.
 */
async function deleteFuture() {
  const ahead = timelineSteps().length - timelineAt();
  if (ahead <= 0) return;
  const answer = await ask({
    title: 'Delete the steps after this point?',
    body: `The ${ahead === 1 ? 'step' : `${ahead} steps`} after this point will be deleted.`
      + ' The board stays as it is now. There is no going back.',
    go: 'Delete',
  });
  if (answer !== 'go') return;
  pause();
  const went = deleteAhead();
  if (went) toast(`Deleted ${went} step${went === 1 ? '' : 's'}`);
}

type Step = ReturnType<typeof timelineSteps>[number];

/**
 * What can be changed about the step at `index`, as menu rows.
 *
 * **A small editing surface, deliberately.** Each row is one alternative
 * value for the one parameter worth changing; choosing it rewrites the
 * step and replays everything after it. No form, no free text - the honest
 * interface for "one of six" is six rows. A step with no rule gets no rows
 * and the menu doesn't open. The tables live here rather than beside the
 * commands, a real duplication worth fixing only past three ops needing it.
 */
const CHOICES: Record<string, { key: string, rows: { value: string, label: string }[] }> = {
  align: {
    key: 'edge',
    rows: [
      { value: 'left', label: 'Align left' },
      { value: 'hcenter', label: 'Align centre' },
      { value: 'right', label: 'Align right' },
      { value: 'top', label: 'Align top' },
      { value: 'vcenter', label: 'Align middle' },
      { value: 'bottom', label: 'Align bottom' },
    ],
  },
  distribute: {
    key: 'axis',
    rows: [
      { value: 'x', label: 'Space out across' },
      { value: 'y', label: 'Space out down' },
    ],
  },
  arrange: {
    key: 'name',
    // Read from the catalogue rather than listed - arrange/arrangements.ts
    // is the list, and a copy here would silently miss the newest entry.
    rows: [],
  },
};

function editEntries(index: number): MenuEntry[] {
  const step = timelineSteps()[index];
  if (!step || !stepEditable(step)) return [];
  const spec = CHOICES[step.op!.name];
  if (!spec) return [];
  // The catalogue for the board this actually is: offering ARRANGEMENTS
  // unconditionally listed shapes a Mobile column can't make, and since a
  // Mobile step records a Mobile id like `fit`, nothing matched - choosing
  // "Spiral" wrote `spiral`, which mobileArrangement() silently coerced back
  // to `fit`. ui/settings-schema.ts forks on the same question.
  const catalogue = board.layoutMode === 'mobile' ? MOBILE_ARRANGEMENTS : ARRANGEMENTS;
  const rows = spec.rows.length
    ? spec.rows
    : catalogue.map(a => ({ value: a.id, label: a.label }));
  const current = String(step.op!.params[spec.key] ?? '');
  return rows.map(row => ({
    label: row.label,
    check: row.value === current,
    action: () => { editStep(index, { [spec.key]: row.value }); },
  }));
}

function dotFor(step: Step | null, position: number, at: number, label: string) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tl-step';
  button.dataset.at = String(position);
  // The title is the whole of what a mark says beyond its glyph: which card,
  // and when - the sheet that used to list the times is gone.
  const when = step ? whenOf(step.at) : '';
  button.title = (position === at ? `${label}  (where you are)` : label) + (when ? `  ${when}` : '');
  button.setAttribute('role', 'option');
  button.setAttribute('aria-selected', String(position === at));
  button.setAttribute('aria-label', label);
  if (position === at) button.classList.add('is-at');
  if (position > at) button.classList.add('is-ahead');
  if (step) {
    // Sealed is the default: a square mark carries a difference, a round one
    // carries an editable rule - the distinction between a right-click that
    // does something and one that doesn't.
    if (stepEditable(step)) button.classList.add('is-ruled');
    else button.classList.add('is-sealed');
    if (step.broken) button.classList.add('is-broken');
    if (step.name) button.classList.add('is-named');
  }
  const dot = document.createElement('span');
  dot.className = 'tl-dot';
  // The start of the board keeps a plain mark - a position, not an event,
  // so no verb to draw.
  if (step) dot.append(icon(kindOf(step.label).icon));
  button.append(dot);
  return button;
}

// icon() is borrowed from ui/menu.ts, which exports it for exactly this - a
// local copy landed an <svg> in the HTML namespace and rendered nothing.

/**
 * When a step happened, as short as it can be said. Clock alone for today,
 * date in front for older. Through the browser's own formatter: this is a
 * label for whoever is looking at the screen, not something written to a file.
 */
function whenOf(stamp: number): string {
  if (!stamp) return '';
  const then = new Date(stamp);
  const time = then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (then.toDateString() === new Date().toDateString()) return time;
  return `${then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}
