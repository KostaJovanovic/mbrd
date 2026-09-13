// Timeline drawn — the step ledger from timeline.ts, shown. Wide window
// gets a strip along the foot; narrow gets a sheet. One module so the
// two faces share KINDS, sentenceFor(), goTo(), trim. Left-click to go;
// right-click a rule-carrying step to edit it. Four visual states per
// step: marker, ahead, sealed, broken (see timeline.css).

import { bus } from '../board-store.ts';
import { toast } from '../notify.ts';
import { el, formatBytes, markClosed } from '../util.ts';
import { ARRANGEMENTS, MOBILE_ARRANGEMENTS } from '../arrange/arrangements.ts';
import { openAnchored, icon } from './menu.ts';
import type { MenuEntry } from './menu.ts';
import { ask } from './dialog.ts';
import {
  board,
  timelineSteps, timelineAt, timelineStale, goTo, editStep, stepEditable,
  timelineBytes, trimmable, trimTimeline, TRIM_BYTES, describeStep, nameStep,
} from '../state.ts';

/**
 * The row a delegated click landed on, by selector, or null. Three listeners
 * here are delegated (dots/rows are rebuilt on every change) and share this cast.
 */
// SAFETY: these listeners are on elements inside #timeline-strip and the
// sheet, so `target` came off this document; the optional chain covers null.
const rowUnder = (event: Event, selector: string) =>
  (event.target as HTMLElement | null)?.closest<HTMLElement>(selector);

let strip: HTMLElement | null = null;
let track: HTMLElement | null = null;
let where: HTMLElement | null = null;
let nameButton: HTMLElement | null = null;
/** Whether the strip is up. Not read off the DOM: see closeStrip(). */
let open = false;

/**
 * How many steps are drawn at once, in either face. A ceiling, not a window:
 * past this the newest are shown and the head says so. Three thousand
 * buttons is three thousand event targets, and the far end of a long history
 * is exactly the part nobody aims a mouse at.
 */
const MAX_DOTS = 400;

/**
 * Which face this window gets. **720px, and it must agree with the media
 * query at the foot of timeline.css** - that rule is the belt for a window
 * narrowed while the strip is up; this is the decision itself. Width alone,
 * no touch condition, since a desktop window dragged to 500px has the same
 * problem a phone has. Made lazily and read live, like canvas/viewport.ts.
 */
let narrow: MediaQueryList | null = null;
function onNarrow(): boolean {
  if (typeof matchMedia !== 'function') return false;
  narrow ??= matchMedia('(max-width: 720px)');
  return narrow.matches;
}

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
  // The bus first and outside the guard below: a build with the strip's
  // markup missing must still redraw an open sheet.
  bus.on('history', renderOpen);
  bus.on('board:load', renderOpen);
  // A window narrowed while the strip is up keeps .is-up (CSS just hides it),
  // so the player-over-strip rule would still be in effect over nothing.
  // Closing it is also the honest answer to what happened.
  onNarrow();
  narrow?.addEventListener('change', event => { if (event.matches) closeStrip(); });
  strip = document.getElementById('timeline-strip');
  if (!strip) return;
  track = strip.querySelector('.tl-track');
  where = strip.querySelector('.tl-where');
  nameButton = strip.querySelector('.tl-name');
  nameButton?.addEventListener('click', () => { void namePoint(); });
  strip.querySelector('.tl-close')?.addEventListener('click', () => closeStrip());
  // Delegated: the dots are rebuilt on every change.
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
}

/**
 * Redraw whichever face is up, and neither when neither is. What 'history'
 * (a commit, undo, redo or jump) and 'board:load' (a whole new history) land on.
 */
function renderOpen() {
  if (open) render();
  if (sheet?.open) renderSheet();
}

/**
 * The Timeline, opened or dismissed - and the one place that decides which
 * face this window gets. A toggle rather than an open on both sides: it's a
 * surface you consult and put away. A second press while the sheet is up
 * should still close it.
 */
export function toggleTimeline() {
  if (onNarrow()) {
    if (sheet?.open) sheet.close();
    else openSheet();
    return;
  }
  if (open) closeStrip();
  else openStrip();
}

function openStrip() {
  if (!strip || open) return;
  open = true;
  strip.hidden = false;
  render();
  // Two frames: hidden->false and the class in the same tick would leave no
  // transition to run. Same two-step every other entering surface uses.
  requestAnimationFrame(() => requestAnimationFrame(() => strip?.classList.add('is-up')));
  measure();
  document.addEventListener('keydown', onKey);
}

function closeStrip() {
  if (!strip || !open) return;
  open = false;
  strip.classList.remove('is-up');
  document.removeEventListener('keydown', onKey);
  // Hidden at the end of the exit, or the bar vanishes instead of leaving.
  const done = () => { if (!open && strip) strip.hidden = true; };
  strip.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 400);
}

/**
 * Escape closes it, only when nothing else wants the key: an open menu or a
 * tour, both non-modal and above this one in priority.
 */
function onKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  if (document.querySelector('.menu:not([hidden]), #tour:not([hidden])')) return;
  markClosed(event);
  closeStrip();
  event.preventDefault();
}

/** Tell the stylesheet how tall the strip is, so the player can step over it. */
function measure() {
  if (!strip) return;
  const height = strip.getBoundingClientRect().height;
  if (height) strip.style.setProperty('--tl-h', `${Math.round(height)}px`);
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

  // The start dot only when the start is what's shown - otherwise the
  // leftmost dot would claim to be the beginning while sitting a thousand
  // steps from its neighbour.
  if (!offset) track.append(dotFor(null, 0, at, 'Where this board started'));
  shown.forEach((step, index) => {
    const position = offset + index + 1;
    track!.append(dotFor(step, position, at, sentenceFor(step)));
  });

  where.textContent = stale
    ? 'This history does not match this board'
    : `${at} of ${steps.length}` + (offset ? ` (newest ${shown.length})` : '');
  showNameButton(nameButton, steps, at, stale);
  renderTrim();
  measure();
}

/**
 * The naming control, in whichever head it is sitting in.
 *
 * **Absent, not greyed, at the start of the board**: there is no step at 0
 * to name. Absent on a stale history for the same reason nothing else on the
 * Timeline works there. The word changes because the act does: naming an
 * already-named point is renaming it.
 */
function showNameButton(button: HTMLElement | null, steps: Step[], at: number, stale: boolean) {
  if (!button) return;
  button.hidden = at === 0 || stale;
  const said = steps[at - 1]?.name ? 'Rename this point' : 'Name this point';
  button.title = said;
  button.setAttribute('aria-label', said);
  if (button.dataset.words !== undefined) button.textContent = said;
}

/**
 * Give the point the board is standing on a name, and only that point.
 *
 * nameStep() names where the marker is - one control in each head rather
 * than a per-row action, since a row action would have to jump there first.
 *
 * **This is the caller nameStep() had been waiting for**: a saved board
 * version used to carry a whole copy of the board; it went in v0.198 since
 * the ledger already holds the way back - a name on a step is the same
 * landmark for the cost of a string. The sheet closes before the question
 * and reopens after (two modals would fight); the strip stays put.
 */
async function namePoint() {
  const at = timelineAt();
  if (!at || timelineStale()) return;
  const step = timelineSteps()[at - 1];
  // Refused rather than optional-chained: sentenceFor() reads step.name
  // unguarded two lines later, and there's nothing to name at at===0 anyway.
  if (!step) return;
  const named = !!step.name;
  const wasSheet = !!sheet?.open;
  if (wasSheet) sheet!.close();
  const given = await ask({
    title: named ? 'Rename this point' : 'Name this point',
    body: 'A name makes this step a landmark on the Timeline, and keeps it from'
      + ' being folded away when an old history is trimmed.',
    go: named ? 'Rename' : 'Name it',
    field: { value: step.name || '', placeholder: sentenceFor(step), maxLength: 120 },
  });
  // An empty box is an answer: "take the name off this one".
  if (given !== null) nameStep(given);
  if (wasSheet) openSheet();
}

/**
 * The trim offer, when there is one.
 *
 * **Appears where the thing it's about is**, not a dialog interrupting a
 * save - a modal asking to discard part of somebody's history mid-task would
 * be the app being anxious at them. Absent below the threshold, and absent
 * above it when nothing is foldable (oldest step named or recent) since a
 * greyed button offering nothing is worse than silence.
 */
function renderTrim() {
  if (!strip) return;
  const existing = strip.querySelector<HTMLElement>('.tl-trim');
  const row = trimRow();
  if (!row) { existing?.remove(); return; }
  if (existing) existing.replaceWith(row);
  else strip.append(row);
}

/**
 * The trim offer as an element, or null - built here rather than placed
 * here since both faces want it in a different slot (under the track vs.
 * between the list and the buttons).
 */
function trimRow(): HTMLElement | null {
  const bytes = timelineBytes();
  if (bytes < TRIM_BYTES) return null;
  const row = document.createElement('div');
  row.className = 'tl-trim';
  const said = document.createElement('span');
  said.textContent = `This history is ${formatBytes(bytes)}.`;
  row.append(said);
  const count = trimmable();
  if (!count) {
    const why = document.createElement('span');
    why.className = 'tl-trim-why';
    // Both reasons said together, since which applies isn't for the reader to deduce.
    why.textContent = ' Nothing older than 30 days can go without crossing a'
      + ' named point.';
    row.append(why);
    return row;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tl-trim-go';
  button.textContent = `Fold in ${count} step${count === 1 ? '' : 's'} older than 30 days`;
  button.addEventListener('click', () => {
    const went = trimTimeline();
    if (went) toast(`Folded ${went} step${went === 1 ? '' : 's'} into the starting state`);
    // trimTimeline() announces on the bus already; this is the belt for the
    // case it offered nothing but this row still needs its size updated.
    renderOpen();
  });
  row.append(button);
  return row;
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
  // The title is still the whole affordance: the glyph says what *kind* of
  // thing happened; hovering supplies which card.
  button.title = position === at ? `${label}  (where you are)` : label;
  button.setAttribute('role', 'option');
  button.setAttribute('aria-selected', String(position === at));
  button.setAttribute('aria-label', label);
  if (position === at) button.classList.add('is-at');
  if (position > at) button.classList.add('is-ahead');
  if (step) {
    // Sealed is the default: a square dot carries a difference, a round one
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

// ── The sheet ──────────────────────────────────────────────────────────────
//
// The same ledger, turned ninety degrees. A <dialog> built here and opened
// from the same cmd, copying ui/inventory.ts's arrangement on purpose - a
// second solution to "report on both layouts" is a second thing to keep
// working.
//
// **A row is a sentence and a time**, the same sentence the strip puts in a
// mark's hover. Newest at the top - the one place the two faces disagree:
// a strip runs left to right, a phone list scrolls from the top and the
// wanted step is nearly always one of the last few taken.
//
// Wired on first open, not at init - the bargain ui/inventory.ts and
// ui/credits.ts both make.

let sheet: HTMLDialogElement | null = null;
let sheetList: HTMLElement | null = null;
let sheetWhere: HTMLElement | null = null;
let sheetTrim: HTMLElement | null = null;
let sheetName: HTMLElement | null = null;
let sheetWired = false;

/** Open the sheet. Idempotent; safe without a document. */
function openSheet() {
  if (typeof document === 'undefined') return;
  // SAFETY: the duck type here is the runtime half of "this is a <dialog> in
  // index.html" - same shape as openInventory().
  const dlg = el('timeline-sheet') as HTMLDialogElement | null;
  if (!dlg || typeof dlg.showModal !== 'function') return;
  sheet = dlg;
  sheetList = el('tl-sheet-list');
  sheetWhere = el('tl-sheet-where');
  sheetTrim = el('tl-sheet-trim');
  sheetName = el('tl-sheet-name');

  if (!sheetWired) {
    sheetWired = true;
    // Click outside to close: the sheet fills its dialog, so a press on the
    // dialog itself is the backdrop.
    dlg.addEventListener('click', event => { if (event.target === dlg) dlg.close(); });
    el('tl-sheet-close')?.addEventListener('click', () => dlg.close());
    sheetName?.addEventListener('click', () => { void namePoint(); });
    // Delegated, same reason as the track's listener.
    sheetList?.addEventListener('click', event => {
      const row = rowUnder(event, '.tl-go');
      if (!row?.dataset.at) return;
      // The board first, sheet after: goTo() announces, and a modal still up
      // while the board rearranges behind it is a change nobody sees.
      goTo(Number(row.dataset.at));
      dlg.close();
    });
  }
  renderSheet();
  if (!dlg.open) dlg.showModal();
}

function renderSheet() {
  if (!sheet || !sheetList || !sheetWhere) return;
  const steps = timelineSteps();
  const at = timelineAt();
  const stale = timelineStale();
  sheet.classList.toggle('is-stale', stale);

  // createElement throughout, never innerHTML - a step's name is typed text.
  const shown = steps.length > MAX_DOTS ? steps.slice(-MAX_DOTS) : steps;
  const offset = steps.length - shown.length;
  const rows: HTMLElement[] = [];
  for (let index = shown.length - 1; index >= 0; index -= 1) {
    rows.push(rowFor(shown[index], offset + index + 1, at));
  }
  // The start of the board goes last, only when the whole history is shown -
  // a truncated list doesn't reach back that far.
  if (!offset) rows.push(rowFor(null, 0, at));
  sheetList.replaceChildren(...rows);

  sheetWhere.textContent = stale
    ? 'This history does not match this board'
    : `${at} of ${steps.length}` + (offset ? ` (newest ${shown.length})` : '');
  showNameButton(sheetName, steps, at, stale);
  const trim = trimRow();
  sheetTrim?.replaceChildren(...(trim ? [trim] : []));
  // The row the board is standing on, brought into view - otherwise a sheet
  // of 400 steps opens at the top, which is the newest, not necessarily here.
  sheetList.querySelector('.is-at .tl-go')?.scrollIntoView({ block: 'nearest' });
}

/** One step as a row: what it was, to what, and when. */
function rowFor(step: Step | null, position: number, at: number): HTMLElement {
  const row = document.createElement('li');
  row.className = 'tl-row';
  if (position === at) row.classList.add('is-at');
  if (position > at) row.classList.add('is-ahead');
  if (step?.broken) row.classList.add('is-broken');
  if (step?.name) row.classList.add('is-named');

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'tl-go';
  go.dataset.at = String(position);
  // aria-current, not the strip's aria-selected: this list isn't a listbox
  // (see index.html). Written only where true - 300 "false" rows is noise.
  if (position === at) go.setAttribute('aria-current', 'true');

  const mark = document.createElement('span');
  mark.className = 'tl-mark';
  // The start of the board carries no glyph, same reason as the strip's first dot.
  if (step) mark.append(icon(kindOf(step.label).icon));

  const said = document.createElement('span');
  said.className = 'tl-said';
  said.textContent = step ? sentenceFor(step) : 'Where this board started';

  const when = document.createElement('span');
  when.className = 'tl-when';
  when.textContent = step ? whenOf(step.at) : '';

  go.append(mark, said, when);
  row.append(go);
  return row;
}

/**
 * When a step happened, as short as it can be said. Clock alone for today,
 * date in front for older - a column of identical dates is noise, and the
 * question here is "before or after lunch", not "which day".
 *
 * Through the browser's own formatter, unlike board-model.ts's month names:
 * that one writes into a file read everywhere, this is a label for whoever
 * is looking at the screen.
 */
function whenOf(stamp: number): string {
  if (!stamp) return '';
  const then = new Date(stamp);
  const time = then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (then.toDateString() === new Date().toDateString()) return time;
  return `${then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}
