// Timeline drawn - the step ledger from timeline.ts, docked along the foot of
// the window on every width, the way a CAD history bar is: the board ends above
// it rather than under it. Its height is --dock, which #viewport and every piece
// of bottom-anchored furniture add to their inset. Play on the left, one mark
// per step in the middle with a playhead in the gap after the step shown and a
// page-drawn scrollbar above, and the rest behind a gear.

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
  timelineBytes, trimmable, trimTimeline, describeStep, nameStep,
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
/** Set while the replay moves the marker, so its own step does not pause it. */
let stepping = false;

/** The two faces of the play button. Named constants, so tests/icons.test.js reads both. */
const PLAY = { icon: 'i-tl-play', said: 'Play the history' };
const PAUSE = { icon: 'i-tl-pause', said: 'Pause' };

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
  'Rearrange': { icon: 'i-rearrange', said: 'Rearranged' },
  'Align': { icon: 'i-align-left', said: 'Aligned' },
  'Distribute': { icon: 'i-distribute-h', said: 'Distributed' },
  'Connect': { icon: 'i-connect', said: 'Joined' },
  'Edit note': { icon: 'i-edit-text', said: 'Wrote in' },
  'Edit connection': { icon: 'i-connect', said: 'Changed the join on' },
  'Remove connection': { icon: 'i-connect', said: 'Unjoined' },
  'Recolour swatch': { icon: 'i-swatch', said: 'Recoloured' },
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

export function initTimeline() {
  // The bus first and outside the guard below, like every init here.
  bus.on('history', () => {
    // A change that is not the replay's own step - an edit, an undo - stops it.
    if (playing && !stepping) pause();
    if (open) render();
  });
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
    if (!dot?.dataset.at) return;
    goTo(Number(dot.dataset.at));
  });
  track?.addEventListener('keydown', stepKeys);
  // Right-click edits, where there is a rule to edit: left is *take me
  // there*, right is *do this differently*, the same gesture every other
  // menu in the app opens with.
  track?.addEventListener('contextmenu', event => {
    const dot = rowUnder(event, '.tl-step');
    if (!dot?.dataset.at) return;
    const index = Number(dot.dataset.at) - 1;
    const entries = editEntries(index);
    if (!entries.length) return;
    event.preventDefault();
    openAnchored(dot.getBoundingClientRect(), entries, { label: 'Change this step' });
  });
  track?.addEventListener('scroll', () => { placeMarker(); paintScroll(); }, { passive: true });
  wireMarker();
  wireScroll();
  // A press anywhere but the play button pauses a replay.
  document.addEventListener('pointerdown', event => {
    if (!playing) return;
    if (event.target instanceof Node && playButton?.contains(event.target)) return;
    pause();
  }, true);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { writeDock(); placeMarker(); paintScroll(); }).observe(strip);
  }
  // On from now on, off to begin with on a phone, then whatever was last chosen here.
  const saved = readPref(PREF);
  if (saved === null ? !phone() : saved === '1') openBar();
}

/** Is the bar up? What the panel's Show timeline box starts from. */
export const timelineShown = () => open;

/** The Timeline button: up or down, remembered on this device. */
export function toggleTimeline() {
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
  if (timelineStale()) return;
  const at = timelineAt();
  const last = timelineSteps().length;
  const target = event.key === 'ArrowLeft' ? at - 1
    : event.key === 'ArrowRight' ? at + 1
      : event.key === 'Home' ? 0
        : event.key === 'End' ? last
          : null;
  if (target === null) return;
  event.preventDefault();
  pause();
  if (target >= 0 && target <= last && target !== at) goTo(target);
  // render() rebuilt the marks, so the focus goes to the one the board is at.
  track?.querySelector<HTMLElement>('.tl-step.is-at')?.focus();
}

/** Replay from here to the newest step, or from the start when there is nothing ahead. */
function play() {
  if (!timelineSteps().length) return;
  if (timelineAt() >= timelineSteps().length) advance(0);
  playing = window.setInterval(() => {
    const at = timelineAt();
    if (at < timelineSteps().length) advance(at + 1);
    if (timelineAt() >= timelineSteps().length) pause();
  }, STEP_MS);
  paintPlay();
}

function advance(target: number) {
  stepping = true;
  try { goTo(target); } finally { stepping = false; }
}

function pause() {
  if (!playing) return;
  clearInterval(playing);
  playing = 0;
  paintPlay();
}

function paintPlay() {
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
  keepInView(track.querySelector<HTMLElement>('.tl-step.is-at'));
  placeMarker();
  paintScroll();
}

/**
 * Scroll the steps so the one the board stands on shows, and the playhead in
 * the gap after it. scrollIntoView() stopped at the mark's own edge, which
 * left the playhead behind the newest step just out of view.
 */
function keepInView(dot: HTMLElement | null) {
  if (!dot || !track) return;
  const view = track.getBoundingClientRect();
  const left = dot.getBoundingClientRect().left;
  const right = gapAfter(dot) + PLAYHEAD_ROOM;
  if (right > view.right) track.scrollLeft += right - view.right;
  else if (left < view.left) track.scrollLeft -= view.left - left;
}

/** Half the playhead's flag, so the whole flag shows past the gap's middle. */
const PLAYHEAD_ROOM = 5;

/**
 * The playhead, in the gap after the step the board stands on, so the mark to
 * its left is the last step shown. Hidden when that gap is scrolled away.
 */
function placeMarker() {
  if (!marker || !track || !rail) return;
  const dot = track.querySelector<HTMLElement>('.tl-step.is-at');
  if (!dot) { marker.hidden = true; return; }
  const box = rail.getBoundingClientRect();
  const x = gapAfter(dot) - box.left;
  marker.hidden = x < 0 || x > box.width;
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
 * system's grey slab under the marks (research/rapid-fixes-2026-09-14.md,
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
    const move = (e: PointerEvent) => { list.scrollLeft = start + (e.clientX - from) * rate; };
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
    list.scrollTo({ left: share * list.scrollWidth - list.clientWidth / 2, behavior: 'smooth' });
  });
  // A wheel turns the steps sideways: there is no system bar to aim at now.
  list.addEventListener('wheel', event => {
    if (event.deltaX || !event.deltaY || list.scrollWidth <= list.clientWidth) return;
    event.preventDefault();
    list.scrollLeft += event.deltaY;
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
    if (timelineStale() || event.button !== 0) return;
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
 * Give the point the board is standing on a name, and only that point.
 * nameStep() names where the marker is. A name on a step is a landmark, and
 * keeps it from being folded away when an old history is trimmed.
 */
async function namePoint() {
  const at = timelineAt();
  if (!at || timelineStale()) return;
  const step = timelineSteps()[at - 1];
  if (!step) return;
  const named = !!step.name;
  const given = await ask({
    title: named ? 'Rename this point' : 'Name this point',
    body: 'A name makes this step a landmark on the Timeline, and keeps it from'
      + ' being folded away when an old history is trimmed.',
    go: named ? 'Rename' : 'Name it',
    field: { value: step.name || '', placeholder: sentenceFor(step), maxLength: 120 },
  });
  // An empty box is an answer: "take the name off this one".
  if (given !== null) nameStep(given);
}

/**
 * Behind the gear: naming the point the board stands on, how big the history
 * is, the trim, and Hide timeline. The trim folds steps older than 30 days
 * into the starting state, never across a named point, and says so rather
 * than disappearing when there is nothing to fold.
 *
 * The name row is absent at the start of the board, where there is no step
 * to name, and on a stale history, where nothing here works. Its word
 * changes because the act does: naming a named point is renaming it.
 */
function gearEntries(): MenuEntry[] {
  const steps = timelineSteps();
  const at = timelineAt();
  const count = trimmable();
  const rows: MenuEntry[] = [];
  if (at && !timelineStale()) {
    rows.push({
      label: steps[at - 1]?.name ? 'Rename this point' : 'Name this point',
      action: () => { void namePoint(); },
    });
  }
  rows.push({
    label: `${steps.length} step${steps.length === 1 ? '' : 's'}, ${formatBytes(timelineBytes())}`,
    disabled: true,
  });
  rows.push(count
    ? {
      label: `Fold in ${count} step${count === 1 ? '' : 's'} older than 30 days`,
      action: () => {
        const went = trimTimeline();
        if (went) toast(`Folded ${went} step${went === 1 ? '' : 's'} into the starting state`);
        if (open) render();
      },
    }
    : { label: 'Nothing older than 30 days to fold in', disabled: true });
  // The Timeline row in the View menu and in the panel brings it back.
  rows.push({ sep: true }, { label: 'Hide timeline', action: () => { if (open) toggleTimeline(); } });
  return rows;
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
