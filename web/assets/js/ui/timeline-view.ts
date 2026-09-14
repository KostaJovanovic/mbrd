// Timeline drawn - the step ledger from timeline.ts, docked along the foot of
// the window on every width, the way a CAD history bar is: the board ends above
// it rather than under it. Its height is --dock, which #viewport and every piece
// of bottom-anchored furniture add to their inset. Transport on the left, one
// mark per step and a marker to drag in the middle, size and trim behind a gear.

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
let nameButton: HTMLElement | null = null;
let playButton: HTMLElement | null = null;
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

/** Play replays the history at two steps a second. */
const STEP_MS = 500;
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
  nameButton = strip.querySelector('.tl-name');
  playButton = strip.querySelector('[data-tl="play"]');
  nameButton?.addEventListener('click', () => { void namePoint(); });
  const gear = strip.querySelector<HTMLButtonElement>('.tl-gear');
  if (gear) {
    menuButton(gear, () => openAnchored(gear.getBoundingClientRect(), gearEntries(), { label: 'Timeline' }));
  }
  strip.querySelector('.tl-transport')?.addEventListener('click', event => {
    const go = rowUnder(event, '[data-tl]')?.dataset.tl;
    if (go) transport(go);
  });
  // Delegated: the marks are rebuilt on every change.
  track?.addEventListener('click', event => {
    const dot = rowUnder(event, '.tl-step');
    if (!dot?.dataset.at) return;
    goTo(Number(dot.dataset.at));
  });
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
  track?.addEventListener('scroll', placeMarker, { passive: true });
  wireMarker();
  // A press anywhere but the play button pauses a replay.
  document.addEventListener('pointerdown', event => {
    if (!playing) return;
    if (event.target instanceof Node && playButton?.contains(event.target)) return;
    pause();
  }, true);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { writeDock(); placeMarker(); }).observe(strip);
  }
  // On from now on, off to begin with on a phone, then whatever was last chosen here.
  const saved = readPref(PREF);
  if (saved === null ? !phone() : saved === '1') openBar();
}

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

/** Whichever Timeline buttons are on screen say whether the bar is up. */
function paintToggle() {
  for (const button of document.querySelectorAll('[data-cmd="timeline"]')) {
    button.setAttribute('aria-pressed', String(open));
  }
}

/** First, back, play, forward, last. */
function transport(go: string) {
  if (timelineStale()) return;
  if (go === 'play') {
    if (playing) pause();
    else play();
    return;
  }
  pause();
  const at = timelineAt();
  const last = timelineSteps().length;
  const target = go === 'first' ? 0 : go === 'back' ? at - 1 : go === 'forward' ? at + 1 : last;
  if (target >= 0 && target <= last && target !== at) goTo(target);
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

  where.textContent = stale ? 'Does not match' : `${at} of ${steps.length}`;
  where.title = stale ? 'This history does not match this board'
    : offset ? `The newest ${shown.length} are shown` : '';
  showNameButton(steps, at, stale);
  paintTransport(at, steps.length, stale);
  // The step the board stands on, in view.
  track.querySelector('.is-at')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  placeMarker();
}

/** Nothing to go back to at the start, nothing ahead at the newest step. */
function paintTransport(at: number, last: number, stale: boolean) {
  if (!strip) return;
  const off: Record<string, boolean> = {
    first: stale || at === 0,
    back: stale || at === 0,
    play: stale || !last,
    forward: stale || at >= last,
    last: stale || at >= last,
  };
  for (const button of strip.querySelectorAll<HTMLButtonElement>('.tl-transport [data-tl]')) {
    button.disabled = !!off[button.dataset.tl || ''];
  }
}

/** The marker over the step the board stands on, or hidden when that step is scrolled away. */
function placeMarker() {
  if (!marker || !track || !rail) return;
  const dot = track.querySelector<HTMLElement>('.tl-step.is-at');
  if (!dot) { marker.hidden = true; return; }
  const mark = dot.getBoundingClientRect();
  const box = rail.getBoundingClientRect();
  const x = mark.left + mark.width / 2 - box.left;
  marker.hidden = x < 0 || x > box.width;
  marker.style.left = `${x}px`;
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

/** The position of the mark nearest a screen x, or null with none drawn. */
function nearestStep(x: number): number | null {
  if (!track) return null;
  let best: number | null = null;
  let gap = Infinity;
  for (const dot of track.querySelectorAll<HTMLElement>('.tl-step')) {
    const r = dot.getBoundingClientRect();
    const d = Math.abs(r.left + r.width / 2 - x);
    if (d < gap) { gap = d; best = Number(dot.dataset.at); }
  }
  return best;
}

/**
 * The naming control. **Absent, not greyed, at the start of the board**:
 * there is no step at 0 to name. Absent on a stale history for the same
 * reason nothing else here works there. The word changes because the act
 * does: naming an already-named point is renaming it.
 */
function showNameButton(steps: Step[], at: number, stale: boolean) {
  if (!nameButton) return;
  nameButton.hidden = at === 0 || stale;
  const said = steps[at - 1]?.name ? 'Rename this point' : 'Name this point';
  nameButton.title = said;
  nameButton.setAttribute('aria-label', said);
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
 * Behind the gear: how big the history is, and the trim. The trim folds
 * steps older than 30 days into the starting state, never across a named
 * point, and says so rather than disappearing when there is nothing to fold.
 */
function gearEntries(): MenuEntry[] {
  const steps = timelineSteps().length;
  const count = trimmable();
  const size: MenuEntry = {
    label: `${steps} step${steps === 1 ? '' : 's'}, ${formatBytes(timelineBytes())}`,
    disabled: true,
  };
  if (!count) return [size, { label: 'Nothing older than 30 days to fold in', disabled: true }];
  return [size, {
    label: `Fold in ${count} step${count === 1 ? '' : 's'} older than 30 days`,
    action: () => {
      const went = trimTimeline();
      if (went) toast(`Folded ${went} step${went === 1 ? '' : 's'} into the starting state`);
      if (open) render();
    },
  }];
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
