// The Timeline: the step ledger, drawn.
//
// timeline.js keeps every change to the board as a record and can put the board
// at any point in them. This is the only thing in the app that shows that, and
// for now it is the only thing that lets you go somewhere other than one step
// back - undo and redo reach the ledger through history.js, a step at a time.
//
// **Two faces, one module.** On a wide window the Timeline is a strip along the
// foot, fitted into the gap between the two clusters of chrome that already
// live there. On a narrow one it is a sheet: a column of rows, newest at the
// top, each carrying the icon and the sentence the strip puts on a mark and its
// hover. The file used to be called timeline-strip.js and was hidden below
// 720px by a `display: none` in timeline.css, which was a decision about the
// *strip* - a horizontal list of three thousand steps on a 430px screen is not
// a feature - taken as if it were a decision about the feature. The history is
// not desktop-only: it drives undo everywhere, and a phone should be able to
// look at it.
//
// The two share everything that is not layout: the KINDS table, sentenceFor(),
// the icon, goTo(), the trim offer and the naming. That sharing is the whole
// reason they are one module rather than two - a second table of past-tense
// verbs would be two vocabularies for one ledger, disagreeing by the second
// time somebody adds a command. It is also why this file cannot be split the
// obvious way: a strip module and a sheet module would have to import each
// other, and tests/layers.js forbids the cycle.
//
// **Two controls on the strip, and the split is the design.** Left-click a step
// and the board goes there. Right-click one that carries a *rule* - an align, a
// distribute, an arrange - and choose a different rule; the step is rewritten
// and everything after it replays on top of the new answer.
//
// Right-click does nothing on a step that carries only a difference, and that
// is not a gap. A sealed step says "this card was at 40 and is now at 80", and
// there is nothing in that sentence to edit. Which commands carry a rule is a
// list that grows one at a time - see registerLayoutOps() in commands.ts.
//
// The sheet has no second control: a phone has no right-click, and the rows
// that carry a rule are a minority of a list somebody is scrolling with a
// thumb. Rewriting a step stays where the pointer is.
//
// Four states have to be legible without a legend, which is the whole design
// problem of both faces: where the marker is, which steps are ahead of it,
// which are sealed, and which are broken. See timeline.css, where each is one
// rule.

import { bus } from '../board-store.ts';
import { toast } from '../notify.ts';
import { el, formatBytes } from '../util.ts';
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
 * The row a delegated click landed on, by selector, or null.
 *
 * Three listeners in this file are delegated - the dots and the sheet rows are
 * rebuilt on every change, so a listener each would be hundreds thrown away per
 * click - and all three began with the same two casts.
 */
// SAFETY: these listeners are on elements inside #timeline-strip and the sheet,
// so a click delivered to one landed on an element in this document. `target` is
// typed EventTarget only because an event can come off a worker or a socket, and
// none of those reach a DOM listener. The optional chain covers the null.
const rowUnder = (event: Event, selector: string) =>
  (event.target as HTMLElement | null)?.closest<HTMLElement>(selector);

let strip: HTMLElement | null = null;
let track: HTMLElement | null = null;
let where: HTMLElement | null = null;
let nameButton: HTMLElement | null = null;
/** Whether the strip is up. Not read off the DOM: see closeStrip(). */
let open = false;

/**
 * How many steps are drawn at once, in either face.
 *
 * A ceiling rather than a window: past this many, the Timeline shows the newest
 * and says so in the head. Three thousand buttons is three thousand event
 * targets and a scroll bar measured in atoms, and the far end of a long history
 * is exactly the part nobody is aiming at with a mouse. The number a person
 * actually wants there is a date filter, which is phase 5.
 */
const MAX_DOTS = 400;

/**
 * Which face this window gets.
 *
 * **720px, and it must agree with the media query at the foot of
 * timeline.css** - that rule is the belt for a window narrowed while the strip
 * was already up, and this is the decision itself. Width alone, and no touch
 * condition: a desktop window dragged to 500px has the same problem a phone has
 * - there is no gap left between the two clusters of chrome to fit a scale
 * into - and the person who dragged it there is not helped by a strip they
 * cannot read.
 *
 * Made lazily and then read live, the shape canvas/viewport.ts uses for the
 * same reason: nothing in a module may touch the browser at import time, and
 * the answer has to follow a window being resized rather than be decided at
 * boot.
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
 * **Keyed on the label commit() was given**, which is the app's own finite
 * vocabulary rather than anything a person can type. Where a label is built
 * with a count on the end - `Rearrange 14 items`, `Unstick 3 items` - the first
 * word is what is matched, which is why the lookup below tries the whole string
 * and then the first word.
 *
 * The icon is a symbol in web/assets/icons.svg, reached by name. A misspelled
 * id there fails silently on screen - no warning, no failed request, just a hole
 * - but not silently in the suite: tests/icons.test.js checks every reference in
 * the tree against the sprite and every symbol in the sprite against the
 * references, in both directions.
 *
 * The verb is past tense throughout, because a step is a thing that happened.
 * A strip that says *Move* reads as a button that will move something.
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
  // Keyed off the commit labels in setItemsLocked (state.ts), which is where
  // the two strings are written and where the note about the word lives.
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
 * A name somebody gave the point wins outright - that is the whole reason to
 * name one, and *Before the redesign* is a better thing to read than *Moved 6
 * cards* whatever the step happened to be.
 *
 * Two cards or more are counted rather than listed. A run collapses every move
 * of the same card into one step, so a step touching six is genuinely a thing
 * done to six, and naming the first of them would be picking one at random.
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
  // The bus first and outside the guard below, because the sheet is a <dialog>
  // that this function does not touch: a build with the strip's markup missing
  // must still redraw an open sheet.
  bus.on('history', renderOpen);
  bus.on('board:load', renderOpen);
  // A window narrowed while the strip is up. The stylesheet takes the strip off
  // the screen at the same breakpoint, but a hidden element still carries
  // .is-up - and the rule that steps the player over the strip is written
  // against that class, so the player would go on standing over nothing.
  // Closing it is also the honest answer to what happened: the strip is not the
  // face this width wears.
  onNarrow();
  narrow?.addEventListener('change', event => { if (event.matches) closeStrip(); });
  strip = document.getElementById('timeline-strip');
  if (!strip) return;
  track = strip.querySelector('.tl-track');
  where = strip.querySelector('.tl-where');
  nameButton = strip.querySelector('.tl-name');
  nameButton?.addEventListener('click', () => { void namePoint(); });
  strip.querySelector('.tl-close')?.addEventListener('click', () => closeStrip());
  // Delegated, because the dots are rebuilt on every change and a listener per
  // dot would be four hundred of them thrown away per click.
  track?.addEventListener('click', event => {
    const dot = rowUnder(event, '.tl-step');
    if (!dot?.dataset.at) return;
    goTo(Number(dot.dataset.at));
  });
  // Right-click edits, where there is a rule to edit. A second control rather
  // than a mode: left is *take me there*, which is what the strip is mostly for,
  // and right is *do this differently*, which is the same gesture that opens
  // every other menu in the app.
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
 * Redraw whichever face is up, and neither when neither is.
 *
 * What 'history' and 'board:load' land on. The first covers a commit, an undo,
 * a redo and a jump - anything that moves the marker or the list; the second
 * covers a whole new board arriving with a history of its own.
 */
function renderOpen() {
  if (open) render();
  if (sheet?.open) renderSheet();
}

/**
 * The Timeline, opened or dismissed - and the one place that decides which face
 * this window gets.
 *
 * A toggle rather than an open on both sides, because it is a surface you
 * consult and put away rather than a screen you go to. The sheet is modal and
 * has its own ways out, so the toggle is mostly the strip's; a second press of
 * the same control while the sheet is up should still close it.
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
  // Two frames: [hidden] to false and the class in the same tick would give the
  // browser one style to compute and no transition to run. The same two-step
  // every other entering surface in this app does.
  requestAnimationFrame(() => requestAnimationFrame(() => strip?.classList.add('is-up')));
  measure();
  document.addEventListener('keydown', onKey);
}

function closeStrip() {
  if (!strip || !open) return;
  open = false;
  strip.classList.remove('is-up');
  document.removeEventListener('keydown', onKey);
  // Hidden at the end of the exit rather than at the start of it, or the bar
  // would vanish instead of leaving. The flag above is what the rest of the
  // module reads, so nothing waits on this.
  const done = () => { if (!open && strip) strip.hidden = true; };
  strip.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 400);
}

/**
 * Escape closes it, and only when nothing else wants the key.
 *
 * A dialog is modal and takes the key itself, so the check is for the two
 * non-modal things that also close on Escape and are above this one in the
 * order somebody would expect: an open menu, and a tour.
 */
function onKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  if (document.querySelector('.menu:not([hidden]), #tour:not([hidden])')) return;
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

  // createElement throughout, never innerHTML. A step's label is the app's own
  // string today and will be somebody's version name tomorrow, and the rule in
  // this codebase is that the escaping problem is solved by not having one.
  track.replaceChildren();
  const shown = steps.length > MAX_DOTS ? steps.slice(-MAX_DOTS) : steps;
  const offset = steps.length - shown.length;

  // The start dot only when the start is what is being shown. The strip drew it
  // unconditionally, so on a history past MAX_DOTS the leftmost dot claimed to
  // be the beginning of the board while the dot beside it was step 2,601 - two
  // marks a thousand steps apart, drawn touching. The sheet has always omitted
  // it on a truncated list for exactly this reason.
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
 * **Absent rather than greyed at the start of the board**, which is the rule
 * the settings panel states and this obeys: there is no step at 0 to name - the
 * starting state is not something that was *done* - and a button that cannot
 * work is a worse answer than no button. Absent on a stale history for the same
 * reason nothing else on the Timeline works there.
 *
 * The word changes because the act does: naming a point that already has a name
 * is renaming it, and a control that says Name over a point called *Before the
 * redesign* is one that looks like it will make a second one.
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
 * nameStep() names where the marker is, which is the whole of what a named
 * point means: a landmark you can come back to. So this is one control in each
 * head rather than a per-row action - a row action would have to move the board
 * to the row before it could name it, which is a jump somebody asked for by
 * pressing something that said *name*.
 *
 * **This is the caller nameStep() had been waiting for.** It is what a saved
 * board version became: the versions feature carried a ring of whole copies of
 * the board and named them, and it went in v0.198 because the ledger already
 * holds the way back - a name on a step is the same landmark for the cost of a
 * string. The naming went with it and had to come back somewhere, and here is
 * the room the landmarks are in.
 *
 * The sheet is modal, so it goes down before the question and comes back up
 * after it: two modal dialogs at once is a focus trap fighting a focus trap,
 * and coming back up is what puts the new name in front of the person who just
 * typed it. The strip is not modal and stays exactly where it was.
 */
async function namePoint() {
  const at = timelineAt();
  if (!at || timelineStale()) return;
  const step = timelineSteps()[at - 1];
  // Refused rather than optional-chained. `step` was guarded with `?.` for the
  // name and then handed to sentenceFor(), which reads `step.name` unguarded -
  // so the one branch the `?.` admits is the one that throws two lines later.
  // There is no step to name at that point anyway, which is what the guard
  // above already says about `at === 0`.
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
  // null is every way out of the question; an empty box is an answer, and the
  // answer it gives is "take the name off this one" - which is the only way
  // back from a name somebody no longer wants.
  if (given !== null) nameStep(given);
  if (wasSheet) openSheet();
}

/**
 * The trim offer, when there is one.
 *
 * **An offer that appears where the thing it is about is**, rather than a dialog
 * that interrupts a save. A history is somebody's record of their own work, and
 * a modal asking to throw part of it away while they were trying to do something
 * else is the app being anxious at them. Here it is a line at the top of the
 * strip, visible only when they have opened the strip, saying how big the
 * history is and offering to fold the old part in.
 *
 * Absent entirely below the threshold, and absent above it when nothing is
 * foldable - a history whose oldest step is named, or recent, has nothing to
 * offer and a greyed button saying so would be worse than silence. The size
 * still shows, because "this board carries 4 MB of history" is worth knowing
 * even when the answer is that none of it can go.
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
 * The trim offer as an element, or null when there is nothing to offer - built
 * here rather than placed here, because both faces want it and neither wants it
 * in the same slot. The strip hangs it under the track; the sheet puts it
 * between the list and the buttons.
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
    // The two reasons, said together rather than worked out, because which one
    // applies is not something the reader should have to deduce from dates.
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
    // trimTimeline() announces on the bus, which redraws whichever face is up;
    // this is the belt for the one it did not, since a fold that offered nothing
    // still leaves this row saying how big the history is.
    renderOpen();
  });
  row.append(button);
  return row;
}

type Step = ReturnType<typeof timelineSteps>[number];

/**
 * What can be changed about the step at `index`, as menu rows.
 *
 * **The whole of the editing surface, and deliberately a small one.** Each row
 * is one alternative value for the one parameter that step has worth changing;
 * choosing it rewrites the step and replays everything after it. There is no
 * form, no free text and no numeric field, because the three converted commands
 * have between them one parameter each and the honest interface for "one of
 * six" is six rows.
 *
 * A step with no rule gets no rows and the menu does not open - which is what
 * makes a sealed step legible as sealed by trying it, rather than only by the
 * shape of its dot.
 *
 * The tables are here rather than beside the commands, and that is a real cost
 * worth naming: the six align edges are spelled in commands.ts as labels and
 * again here as choices, and the day a seventh is added they will disagree. The
 * fix is for registerOp() to carry a parameter description, which is worth
 * writing when there are more than three ops - not before.
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
    // Read from the catalogue rather than listed, because that one *is* the
    // list - arrange/arrangements.ts is where an arrangement is added, and a
    // second copy here would be a menu that quietly stopped offering the newest
    // one.
    rows: [],
  },
};

function editEntries(index: number): MenuEntry[] {
  const step = timelineSteps()[index];
  if (!step || !stepEditable(step)) return [];
  const spec = CHOICES[step.op!.name];
  if (!spec) return [];
  // The catalogue for the board this actually is. It offered ARRANGEMENTS
  // unconditionally, so on a Mobile board the step editor listed shapes a
  // column cannot make - and since a Mobile Rearrange step records a Mobile id
  // like `fit`, nothing matched and no row was ticked. Choosing "Spiral" then
  // wrote `spiral`, which mobileArrangement() silently coerced back to `fit`:
  // a menu whose entries do nothing, above a menu with no current entry.
  // ui/settings-schema.ts forks on the same question.
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
  // The title is still the whole of the affordance. The glyph says what *kind*
  // of thing happened, which is what makes a long strip skimmable; it cannot say
  // which card it happened to, and that is the half hovering supplies.
  button.title = position === at ? `${label}  (where you are)` : label;
  button.setAttribute('role', 'option');
  button.setAttribute('aria-selected', String(position === at));
  button.setAttribute('aria-label', label);
  if (position === at) button.classList.add('is-at');
  if (position > at) button.classList.add('is-ahead');
  if (step) {
    // Sealed is the default and the majority: a square dot for a step that
    // carries a difference, a round one for a step that carries a rule you can
    // change. That is the distinction the strip has to make legible without a
    // legend, because it is the difference between a right-click that offers
    // something and one that does nothing.
    if (stepEditable(step)) button.classList.add('is-ruled');
    else button.classList.add('is-sealed');
    if (step.broken) button.classList.add('is-broken');
    if (step.name) button.classList.add('is-named');
  }
  const dot = document.createElement('span');
  dot.className = 'tl-dot';
  // The start of the board keeps a plain mark. It is not something that was
  // done, so there is no verb to draw, and the one place on the strip that is a
  // *position* rather than an event should not look like an event.
  if (step) dot.append(icon(kindOf(step.label).icon));
  button.append(dot);
  return button;
}

// icon() is borrowed from ui/menu.ts, which exports it for exactly this - a
// local copy landed an <svg> in the HTML namespace and rendered nothing.

// ── The sheet ──────────────────────────────────────────────────────────────
//
// The same ledger, turned ninety degrees. A <dialog> built by this module and
// opened from the same cmd, which is ui/inventory.ts's arrangement and is
// copied here on purpose: that sheet already solves being a report on both
// layouts, and a second solution to it would be a second thing to keep working.
//
// **A row is a sentence and a time**, and the sentence is exactly the one the
// strip puts in a mark's hover - same KINDS table, same describeStep(), same
// past tense. A phone has no hover, so what the strip hides until you point at
// it is what the sheet is made of.
//
// Newest at the top, which is the one place the two faces disagree about order.
// A strip is a scale and a scale runs left to right whatever is on it; a list
// on a phone is scrolled with a thumb from the top, and the step somebody wants
// is nearly always one of the last few they took.
//
// Wired on first open rather than at init, the bargain ui/inventory.ts and
// ui/credits.ts both make: listeners on a sheet most sessions never open do not
// need to exist before it is asked for.

let sheet: HTMLDialogElement | null = null;
let sheetList: HTMLElement | null = null;
let sheetWhere: HTMLElement | null = null;
let sheetTrim: HTMLElement | null = null;
let sheetName: HTMLElement | null = null;
let sheetWired = false;

/** Open the sheet. Idempotent; safe without a document. */
function openSheet() {
  if (typeof document === 'undefined') return;
  // SAFETY: the duck type on the next line is the runtime half of the claim
  // that this is a <dialog> in index.html, and is what makes a browser without
  // one - or a page that does not carry the sheet - fall out here rather than
  // throw. Same shape as openInventory().
  const dlg = el('timeline-sheet') as HTMLDialogElement | null;
  if (!dlg || typeof dlg.showModal !== 'function') return;
  sheet = dlg;
  sheetList = el('tl-sheet-list');
  sheetWhere = el('tl-sheet-where');
  sheetTrim = el('tl-sheet-trim');
  sheetName = el('tl-sheet-name');

  if (!sheetWired) {
    sheetWired = true;
    // Click outside to close: the sheet fills its own dialog, so a press whose
    // target is the dialog itself landed on the backdrop.
    dlg.addEventListener('click', event => { if (event.target === dlg) dlg.close(); });
    el('tl-sheet-close')?.addEventListener('click', () => dlg.close());
    sheetName?.addEventListener('click', () => { void namePoint(); });
    // Delegated, for the reason the track's listener is: the rows are rebuilt
    // on every change to the ledger, and a listener per row would be four
    // hundred of them thrown away per tap.
    sheetList?.addEventListener('click', event => {
      const row = rowUnder(event, '.tl-go');
      if (!row?.dataset.at) return;
      // The board first and the sheet after it: goTo() announces, and a modal
      // still up while the board rearranges behind it is a change nobody sees.
      // Closing is the point of the tap rather than a tidiness - the row was a
      // way *to* the board.
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

  // createElement throughout, never innerHTML - a step's name is a string
  // somebody typed, and the rule in this codebase is that the escaping problem
  // is solved by not having one.
  const shown = steps.length > MAX_DOTS ? steps.slice(-MAX_DOTS) : steps;
  const offset = steps.length - shown.length;
  const rows: HTMLElement[] = [];
  for (let index = shown.length - 1; index >= 0; index -= 1) {
    rows.push(rowFor(shown[index], offset + index + 1, at));
  }
  // The start of the board goes last, and only when the whole history is on
  // screen. A truncated list does not reach back that far, and a row calling
  // itself the beginning at the foot of the newest four hundred would be a lie
  // that also takes you somewhere you did not ask to go.
  if (!offset) rows.push(rowFor(null, 0, at));
  sheetList.replaceChildren(...rows);

  sheetWhere.textContent = stale
    ? 'This history does not match this board'
    : `${at} of ${steps.length}` + (offset ? ` (newest ${shown.length})` : '');
  showNameButton(sheetName, steps, at, stale);
  const trim = trimRow();
  sheetTrim?.replaceChildren(...(trim ? [trim] : []));
  // The row the board is standing on, brought into view. Opening a sheet on a
  // history of four hundred steps otherwise starts wherever the scroller
  // happens to be, which is the top - and the top is the newest step, which is
  // only where you are if you have not gone back.
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
  // Where the board is, said to a screen reader. aria-current rather than the
  // strip's aria-selected, because this list is not a listbox: see the note in
  // index.html. Written only on the row it is true of - aria-current="false" on
  // three hundred rows is three hundred announcements of nothing.
  if (position === at) go.setAttribute('aria-current', 'true');

  const mark = document.createElement('span');
  mark.className = 'tl-mark';
  // The start of the board carries no glyph, for the reason the strip's first
  // dot carries none: it is a position rather than an event, and there is no
  // verb to draw.
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
 * When a step happened, as short as it can be said.
 *
 * The clock alone for today, the date in front of it for anything older. A
 * column of identical dates down a history made in one sitting is a column of
 * noise, and the question a time answers on this list is "was this before or
 * after lunch" rather than "which day was this".
 *
 * Through the browser's own formatter, unlike board-model.ts's month names -
 * that one writes a *title* that goes into a file and has to read the same
 * everywhere it is opened, and this is a label on a screen belonging to whoever
 * is looking at it.
 */
function whenOf(stamp: number): string {
  if (!stamp) return '';
  const then = new Date(stamp);
  const time = then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (then.toDateString() === new Date().toDateString()) return time;
  return `${then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}
