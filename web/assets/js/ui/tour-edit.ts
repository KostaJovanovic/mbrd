// Tour editor — a mode over the board (marks on cards + bar along the
// foot). Chip numbers are add-order, not position — settled, reverted
// twice, do not change. `editing` lives only in this module.

import { MAX_TOUR_CAPTION } from '../board-model.ts';
import {
  addTourStop, board, bus, byId, canTour, joinTourStops, moveTourStop,
  removeTourCards, removeTourStop, select, selection, setTourCaption, splitTourStop, undo,
} from '../state.ts';
import { toast } from '../notify.ts';
import { openAnchored } from './menu.ts';
import type { MenuEntry } from './menu.ts';
import { paintTourMarks, setSpot, setTourMarks } from '../canvas/items.ts';
import { baseMs, reducedMotion } from '../canvas/viewport.ts';
import { cue } from '../cuelume/engine.ts';
import { icon as iconOf, markClosed, readToken } from '../util.ts';
import { previewStop, startTour, tourActive } from './tour.ts';

/** The bar, built once by initTourEdit(). */
let host: HTMLElement | null = null;

/** Whether the mode is on. See the head of this file. */
let editing = false;

/**
 * The stop the second row is pointed at, or -1. Not a selection in the
 * board's sense - just which stop the one caption field is aimed at.
 * Cleared when the mode ends.
 */
let current = -1;

/**
 * A chip being pressed or dragged, or null. One at a time, like every gesture
 * in the app. Positions are viewport boxes measured once at the lift, when the
 * list scrolled `scroll` - see placeHeld() for how a scroll since is folded in.
 */
type ChipDrag = {
  list: HTMLElement;
  li: HTMLElement;
  pointerId: number;
  from: number;
  to: number;
  // The press point, less any offset the chip was drawn at when it was caught.
  x0: number;
  y0: number;
  lastX: number;
  lastY: number;
  lifted: boolean;
  boxes: DOMRect[];
  bounds: DOMRect | null;
  scroll: number;
};
let drag: ChipDrag | null = null;
/** Set by a drag's release, so the click that follows does not also preview the stop. */
let swallowClick = false;
/** How far a press travels before it is a drag: under it, a press is a click. */
const DRAG_SLOP = 4;

/**
 * What each stop is *called*: card id -> number, and the next number to give.
 * The order stops were added in (see head of file for why, and don't revert).
 *
 * Kept here, not on the board, and reset when the mode opens - a name for a
 * stop is editor bookkeeping, not something a file should remember. Names
 * restarting at 1 each session is honest: it's a session's worth of history.
 */
const serials = new Map<string, number>();
let nextSerial = 1;

export function tourEditing() { return editing; }

export function initTourEdit() {
  // Built here, not declared in index.html like the tour bar: every child of
  // this bar is a stop that doesn't exist yet. Costs the JS_BUILT entry in
  // tests/element-ids.test.js the tour bar's markup comment avoids.
  host = document.createElement('div');
  host.id = 'tour-editor';
  host.hidden = true;
  document.body.append(host);
  // The marks on the cards. canvas/items.ts draws them and asks this back -
  // see applyTourMark() there for why the mark can't be written from here.
  setTourMarks({ markFor, press, hover: id => peekStop(id ? stopOf(id) : -1) });
  // The peek: pointer over the bar lays the order onto the board itself - see
  // :root.is-tour-peek in item-chrome.css. A class rather than a selector,
  // since the bar is a child of <body> and the cards are inside #viewport -
  // no combinator connects them the right way.
  //
  // pointerenter/leave, not over/out: those don't refire per chip and button.
  host.addEventListener('pointerenter', () => peek(true));
  host.addEventListener('pointerleave', () => peek(false));
  // Right-click off the chips: the bar's own verbs. A chip opens its own menu
  // first and says so with preventDefault(); the caption field keeps the
  // browser's, which is where paste and spelling live.
  host.addEventListener('contextmenu', e => {
    if (e.defaultPrevented || !editing) return;
    if (e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    openAnchored({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY },
      barEntries(), { label: 'Tour' });
  });
  // Every way the bar can go stale: `tour` (the list), `items` (a card
  // deleted/restored under it), `selection` (Add button + hint line, the
  // noisiest - hence the early return in paint() when the mode is off).
  bus.on('tour', paint);
  bus.on('items', paint);
  bus.on('selection', paint);
  bus.on('board:load', () => {
    editing = false;
    serials.clear();
    nextSerial = 1;
    paint();
  });
  // A tour that starts ends the mode - both want the foot of the screen, and
  // a tour is what this bar builds.
  bus.on('tour:at', () => { if (tourActive() && editing) editing = false; paint(); });
  paint();
}

/** Open or shut the editor. The sidebar's one button, and the bar's cross. */
export function toggleTourEdit() {
  editing = !editing;
  // Names restart with the mode, on the way in - so a first-time tour reads
  // 1 2 3 and only disagrees with itself once something's actually moved.
  if (editing) { serials.clear(); nextSerial = 1; }
  paint();
}

/**
 * Lay the order out over the cards, or take it back off. Guarded on
 * `editing` too: the bar takes 200ms to leave, and a resting pointer while
 * the mode closes should not hold the board under a veil.
 */
function peek(on: boolean) {
  document.documentElement.classList.toggle('is-tour-peek', on && editing);
}

/** The stop a chip or a card's number is lighting, or -1. */
let peeking = -1;

/**
 * Light one stop's cards and fade the rest, connections included, while the
 * pointer is on its chip or on one of its cards' numbers. -1 puts the board
 * back. Compared first, since the marks report on every pointerover.
 */
function peekStop(i: number) {
  const want = editing && board.tour[i] ? i : -1;
  if (want === peeking) return;
  peeking = want;
  document.documentElement.classList.toggle('is-stop-peek', want >= 0);
  setSpot(want >= 0 ? board.tour[want].cards : null);
}

/**
 * End the mode if it is on, and say whether it was - same shape as
 * stopTour(), for the same caller: Escape in canvas/input.ts tries temporary
 * states outermost first.
 */
export function stopTourEdit() {
  if (!editing) return false;
  editing = false;
  paint();
  return true;
}

// ---- what the marks on the cards say, and what pressing one does ----------

/**
 * The number this card wears, `0` for the "+", or null for no mark.
 *
 * Anything canTour() refuses wears nothing - the title card, every sticker
 * and note lying on a photograph. A "+" on those would invite making a stop
 * of the sticker instead of the picture underneath.
 */
function markFor(id: string): number | null {
  if (!editing || !canTour(byId(id))) return null;
  const at = stopOf(id);
  return at < 0 ? 0 : at + 1;
}

/** Which stop this card is at, or -1. */
const stopOf = (id: string) => board.tour.findIndex(stop => stop.cards.includes(id));

/**
 * A mark pressed: on the tour, off it. On a card in a selection of several it
 * speaks for the selection - a "+" makes one stop of the selected cards not on
 * the tour yet, and a number takes the selected cards in that stop off it. On
 * any other card, the card alone.
 */
function press(id: string) {
  const group = selection.has(id) && selection.size > 1 ? [...selection] : [id];
  const at = stopOf(id);
  if (at >= 0) { removeTourCards(group.filter(g => stopOf(g) === at)); return; }
  if (addTourStop(group)) current = board.tour.length - 1;
  paint();
}

/**
 * What the selection is, as far as the tour is concerned. Everything
 * canTour() refuses is dropped first, since addTourStop() would drop it too.
 */
function pickedCards(): { on: string[], off: string[] } {
  const on: string[] = [];
  const off: string[] = [];
  for (const id of selection) {
    if (!canTour(byId(id))) continue;
    (stopOf(id) >= 0 ? on : off).push(id);
  }
  return { on, off };
}

/**
 * The bar's one verb, in whichever direction the selection points. Add and
 * Remove are the same act with a sign: cards all on the tour can only come
 * off; anything else adds what's not on it yet.
 */
function addOrCut() {
  const { on, off } = pickedCards();
  // Deliberately silent when nothing happens - the button's only pressable
  // with a selection, so an empty result means furniture was selected.
  if (off.length) {
    if (addTourStop(off)) current = board.tour.length - 1;
  } else {
    removeTourCards(on);
  }
  paint();
}

/**
 * What a stop is called: its cards, named. Deliberately not shared with the
 * tour bar's own shortening (stopLabel() in ui/tour.ts) - different widths -
 * but sharing the rule that a nameless card reads "Untitled" rather than blank.
 */
function stopLabel(cards: string[]): string {
  const names = cards
    .map(id => byId(id))
    .filter(item => !!item)
    .map(item => (item.name || '').trim() || 'Untitled');
  if (!names.length) return 'Nothing left here';
  return names.length > 2 ? `${names[0]} +${names.length - 1}` : names.join(', ');
}

/** A button with an icon and a label a screen reader gets. */
function iconButton(className: string, icon: string, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.append(iconOf(icon));
  return btn;
}

/** A plain text button in the bar. */
function textButton(className: string, label: string, title: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = label;
  btn.title = title;
  return btn;
}

// ---- the bar --------------------------------------------------------------

/** Where the caret is in the caption field, when that is where the caret is. */
type Caret = { start: number, end: number };

function readCaret(): Caret | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement) || !el.classList.contains('tour-cap')) return null;
  return { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
}

/**
 * The whole bar, rebuilt - a handful of chips at most, so a diff would cost
 * more than it saves. Must not steal focus from a caption someone's typing:
 * the caption commits on `change` (not `input`), so a self-triggered
 * repaint happens after the field's blurred, and a repaint from elsewhere
 * restores the caret (see readCaret).
 */
function paint() {
  if (!host) return;
  // Everything that isn't the board, out of the way - same list a running tour hides.
  document.documentElement.classList.toggle('is-tour-edit', editing);
  // The button that opened this, told what it did - written here since none
  // of the four bus events this repaints on is "the editor opened".
  for (const btn of document.querySelectorAll('[data-cmd="tour-edit"]')) {
    btn.setAttribute('aria-pressed', String(editing));
  }
  paintTourMarks();
  // The chips a drag holds are about to be thrown away: it ends where it is.
  if (drag) abandonDrag();
  if (!editing) { shut(); return; }

  const caret = readCaret();
  // A long tour scrolls its chips; a press selects and repaints, which would
  // put the block back at its start and the pressed chip maybe out of sight.
  const scroll = host.querySelector('.tour-chips')?.scrollTop ?? 0;
  host.textContent = '';
  host.hidden = false;
  if (current >= board.tour.length) current = board.tour.length - 1;

  // Named once for the whole bar, so chips and the caption number agree - see stopNames().
  const names = stopNames();
  host.append(headRow(), stripRow(names), footRow(names));
  const chipList = host.querySelector('.tour-chips');
  if (chipList && scroll) chipList.scrollTop = scroll;

  if (caret) {
    const cap = host.querySelector<HTMLInputElement>('.tour-cap');
    cap?.focus();
    cap?.setSelectionRange(caret.start, caret.end);
  }
  // A frame between unhide and the class, or there's nothing to transition from.
  requestAnimationFrame(() => { if (editing) host?.classList.add('is-up'); });
}

/** The way out: down under the edge, and emptied once it is gone. */
function shut() {
  // Before the early return: the mode can end with the pointer still on the
  // bar, and the veil must come off regardless of whether a bar remains.
  peek(false);
  peekStop(-1);
  if (!host || host.hidden) return;
  current = -1;
  host.classList.remove('is-up');
  const bar = host;
  // Guarded on `editing`, or a mode reopened inside this window gets hidden
  // by the previous close's own timer.
  setTimeout(() => { if (!editing) { bar.hidden = true; bar.textContent = ''; } }, 200);
}

/**
 * The head: what this bar is, how much of it there is, and the way out - the
 * Timeline strip's head, one edge over.
 */
function headRow(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tour-row tour-head-row';

  const title = document.createElement('span');
  title.className = 'tour-title';
  title.textContent = 'Tour';
  row.append(title);

  const count = document.createElement('span');
  count.className = 'tour-count';
  const n = board.tour.length;
  count.textContent = !n ? 'no stops yet' : n === 1 ? '1 stop' : `${n} stops`;
  row.append(count);

  const close = iconButton('tour-close', 'i-close', 'Stop editing the tour  Esc');
  close.addEventListener('click', () => { editing = false; paint(); });
  row.append(close);
  return row;
}

/** The middle row: the tour itself, and nothing else. */
function stripRow(names: number[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tour-row tour-strip-row';
  // Nothing at all when the tour is empty - the head already said so and the
  // hint below covers it; a third sentence would be piling on.
  if (board.tour.length) row.append(chips(names));
  return row;
}

/**
 * The foot row: what is said at the stop being pointed at, or what can be
 * done. One fixed-height box holding whichever applies, so the bar's height
 * doesn't jump on every chip press. The hints here are the only place the
 * mode's hidden gestures (drag, right-click, the card mark) are written down.
 */
function footRow(names: number[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tour-row tour-foot-row';
  row.append(current >= 0 ? captionField(current, names[current]) : hint());

  // Two verbs, side by side and same shape - one question, two answers: put
  // something on the tour, or go read it.
  const acts = document.createElement('div');
  acts.className = 'tour-acts';

  const { on, off } = pickedCards();
  const cutting = !!on.length && !off.length;
  const n = cutting ? on.length : off.length;
  // Count as a pill, not folded into the label - a sentence label ("Add 3
  // cards as one stop") changed width on every selection; it lives in the
  // tooltip instead. "Take off", not "Remove" - three of four places already
  // said "take off" (mark, tooltip, chip menu) and it's the better word: a
  // stop leaves a tour, but the card doesn't stop existing.
  const add = textButton(
    'tour-add is-primary',
    cutting ? 'Take off' : 'Add stop',
    !n ? 'Select cards on the board, then add them as a stop'
      : cutting
        ? 'Take these off the tour - a stop they leave empty goes with them'
        : n > 1
          ? `${n} cards, framed together as one stop`
          : 'This card, as a stop of its own',
  );
  add.disabled = !n;
  add.classList.toggle('is-cut', cutting);
  if (n) {
    const pill = document.createElement('span');
    pill.className = 'tour-add-n';
    pill.textContent = String(n);
    add.append(pill);
  }
  add.addEventListener('click', addOrCut);
  acts.append(add);

  const play = textButton('tour-play', 'Take the tour',
    board.tour.length ? `${board.tour.length} stops, in order` : 'Add a stop first');
  play.disabled = !board.tour.length;
  // Ends the mode only if the tour actually started - startTour() declines
  // on Mobile and on an empty list.
  play.addEventListener('click', () => { if (startTour()) { editing = false; paint(); } });
  acts.append(play);

  row.append(acts);
  return row;
}

/** What is said at the stop the bar is pointed at. */
function captionField(i: number, name: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'tour-cap-wrap';

  // The chip's name, not the position - otherwise pressing chip 3 would show
  // a 1 beside the field.
  const n = document.createElement('span');
  n.className = 'tour-cap-n';
  n.textContent = String(name);
  wrap.append(n);

  const cap = document.createElement('input');
  cap.type = 'text';
  cap.className = 'tour-cap';
  cap.value = board.tour[i]?.caption || '';
  cap.maxLength = MAX_TOUR_CAPTION;
  cap.placeholder = `Say something about stop ${i + 1}`;
  cap.setAttribute('aria-label', `What is said at stop ${i + 1} of ${board.tour.length}`);
  cap.autocomplete = 'off';
  cap.spellcheck = false;
  // On `change`, not `input` - see paint().
  cap.addEventListener('change', () => setTourCaption(i, cap.value));
  wrap.append(cap);
  return wrap;
}

/** What can be done here, when there is no caption to write. */
function hint(): HTMLElement {
  const p = document.createElement('p');
  p.className = 'tour-hint';
  const { off } = pickedCards();
  p.textContent = off.length > 1
    ? `Add makes one stop of all ${off.length} - they are framed and seen together`
    : board.tour.length
      ? 'Press a stop to caption it · drag to reorder · right-click one to split or join'
      : 'Press the + on a card to make it a stop, or select several and add them as one';
  return p;
}

// ---- the chip's own menu -------------------------------------------------
//
// What the row can do that dragging can't: take a group apart, or merge two.
// Both edit *what a stop is*, not where it sits, so they get a menu rather
// than more buttons crowding a small chip - openAnchored(), since ui/menu.ts
// is the one menu implementation and this isn't a second. The foot row's
// hint says the menu exists, so the right-click isn't a hidden feature.

/**
 * The rows for one stop. Only what applies to this one is in the list. The
 * one place these are offered: a running tour's bar used to carry them as
 * icon buttons, and a tour being shown is not the moment to rebuild it.
 */
function chipEntries(i: number, name: number): MenuEntry[] {
  const cards = board.tour[i]?.cards ?? [];
  const last = board.tour.length - 1;
  return [
    { label: `Split stop ${name} into ${cards.length}`, icon: 'i-distribute-h',
      hidden: cards.length < 2, action: () => splitAt(i) },
    { label: 'Join with the stop before', icon: 'i-arrow-back',
      hidden: i <= 0, action: () => joinAt(i - 1) },
    { label: 'Join with the stop after', icon: 'i-arrow-fwd',
      hidden: i >= last, action: () => joinAt(i) },
    { sep: true },
    { label: 'Show this stop', icon: 'i-fit-card', action: () => previewStop(i) },
    { sep: true },
    { label: cards.length > 1 ? `Take these ${cards.length} cards off the tour`
      : 'Take this card off the tour',
    icon: 'i-close', danger: true,
    action: () => { removeTourCards(board.tour[i]?.cards ?? []); paint(); } },
  ];
}

/** The bar's right-click rows, off the chips: its two buttons and its cross. */
function barEntries(): MenuEntry[] {
  const { on, off } = pickedCards();
  const cutting = !!on.length && !off.length;
  const n = cutting ? on.length : off.length;
  return [
    {
      label: cutting ? 'Take off the tour' : n > 1 ? `Add ${n} cards as one stop` : 'Add stop',
      disabled: !n,
      action: addOrCut,
    },
    {
      label: 'Take the tour',
      disabled: !board.tour.length,
      action: () => { if (startTour()) { editing = false; paint(); } },
    },
    { sep: true },
    { label: 'Stop editing the tour', action: () => { editing = false; paint(); } },
  ];
}

/**
 * Delete with a stop picked in the bar: the stop comes off the tour and its
 * cards stay on the board - one undo step, and the toast carries the Undo.
 * With the editor up and no stop picked, Delete does nothing: nothing here
 * bins a card. Answers whether it took the key, which is whether the editor
 * is up.
 */
export function deleteStop(): boolean {
  if (!editing) return false;
  if (!board.tour[current]) return true;
  const name = stopNames()[current];
  removeTourStop(current);
  current = -1;
  select([]);
  paint();
  toast(`Stop ${name} removed`, '', { label: 'Undo', run: undo });
  return true;
}

/** Break this stop up, and keep the foot row pointing where it was. */
function splitAt(i: number) {
  const k = board.tour[i]?.cards.length ?? 0;
  if (k < 2) return;
  // Everything after it moves down by the pieces gained; the stop keeps its
  // index (the caption goes to the first piece, see splitTourStop()).
  if (current > i) current += k - 1;
  splitTourStop(i);
  paint();
}

/** Join this stop to the one after it, and follow the foot row across. */
function joinAt(i: number) {
  if (!board.tour[i] || !board.tour[i + 1]) return;
  if (current === i + 1) current = i;
  else if (current > i + 1) current -= 1;
  joinTourStops(i);
  paint();
}

/**
 * What each stop is called, in the tour's current order. See `serials`.
 *
 * One pass, not a per-chip lookup: two stops must never share a name, but
 * they can both ask for the same one (a card taken off stop "3" and re-added
 * as its own stop also wants to be called 3). `used` settles it - whichever
 * reaches the name first keeps it. A stop is named after any card that
 * already has a name, then every card in it is stamped with that name - so
 * a group survives losing cards, a split gives the old name to the first
 * piece, and a join keeps the earlier name.
 */
function stopNames(): number[] {
  const used = new Set<number>();
  return board.tour.map(stop => {
    let name = 0;
    for (const id of stop.cards) {
      const had = serials.get(id);
      if (had && !used.has(had)) { name = had; break; }
    }
    if (!name) name = nextSerial++;
    used.add(name);
    for (const id of stop.cards) serials.set(id, name);
    return name;
  });
}

/** The order, as a row of stops that can be dragged past each other. */
function chips(names: number[]): HTMLElement {
  const list = document.createElement('ol');
  list.className = 'tour-chips';
  board.tour.forEach((stop, i) => list.append(chip(stop.cards, i, names[i], list)));
  return list;
}

/** One stop: the name it was given when it was made, and where it now sits. */
function chip(cards: string[], i: number, name: number, list: HTMLElement): HTMLLIElement {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tour-chip';
  if (i === current) b.classList.add('is-current');
  // Everything the square can't hold: actual position (the square carries
  // its *name*), which cards, how many, and the two gestures.
  const what = cards.length > 1
    ? `${cards.length} cards framed together - ${stopLabel(cards)}`
    : stopLabel(cards);
  b.title = `Stop ${i + 1} of ${board.tour.length}: ${what}`
    + '\nDrag to reorder, right-click to split or join';
  b.setAttribute('aria-label', `Stop ${i + 1}: ${what}`);
  // The chip itself is what is held - see armDrag().
  b.addEventListener('pointerdown', e => armDrag(e, list, li, i));
  // Pressing a stop flies the camera to it without starting a tour - the
  // only way to check a stop frames what it should while still building it -
  // and points the foot row at it.
  //
  // It also *selects* its cards, which is what makes one verb enough: taking
  // a whole stop off is the same press as taking any selection off.
  b.addEventListener('click', () => {
    if (swallowClick) return;
    current = i;
    previewStop(i);
    select(cards);
    paint();
  });
  // The pointer on a chip lights its cards on the board.
  b.addEventListener('pointerenter', () => peekStop(i));
  b.addEventListener('pointerleave', () => peekStop(-1));
  // Right-click: what a stop *is*, not where it sits - see chipEntries().
  b.addEventListener('contextmenu', e => {
    e.preventDefault();
    // Kept inside the bar via `bounds` - a panel on a foot-bar button
    // shouldn't hang off the end of it.
    const box = b.getBoundingClientRect();
    const bar = host?.getBoundingClientRect();
    openAnchored({
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      bounds: bar && { left: bar.left, right: bar.right },
    }, chipEntries(i, name), { label: `Stop ${name}` });
  });

  // Grouped stops draw as a stack, not a count - see .is-group in chrome.css.
  // A number-on-a-number is two numbers in twenty pixels; a stacked square
  // says "more than one card" without asking anyone to read it, and the
  // tooltip has the exact count.
  b.classList.toggle('is-group', cards.length > 1);
  b.textContent = String(name);
  li.append(b);
  return li;
}

/**
 * Which gap a point is in, as a boundary in the block as drawn. 0 is before
 * the first chip, `length` after the last - *not* what moveTourStop() takes
 * (see placeHeld()).
 *
 * **Two dimensions, because the block wraps.** X alone answered by column
 * once the row wrapped - dropping left on line two landed before the
 * *first* chip of line one, both being on the left. Y picks the line
 * first, x only decides within it. Measured off the boxes taken at the lift,
 * not live ones: the chips making way are drawn away from their slots.
 */
function dropAt(boxes: DOMRect[], x: number, y: number): number {
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (y < box.top) return i;
    if (y <= box.bottom && x < box.left + box.width / 2) return i;
  }
  return boxes.length;
}

// ---- drag to reorder -----------------------------------------------------
//
// The Playlist's gesture (ui/playlist.ts), on a wrapping row: the held chip
// lifts and follows the pointer on `translate`, and the chips it passes slide
// into each other's slots, which across a line end is a move in both axes.
// The DOM is left alone until the release, when moveTourStop() rebuilds the
// bar and the chip at its new index settles from where it was let go.

/** The `translate` an element is drawn at right now, transitions and animations included. */
function drawnAt(el: Element): { x: number, y: number } {
  const [x = '0', y = '0'] = getComputedStyle(el).translate.split(' ');
  return { x: Number.parseFloat(x) || 0, y: Number.parseFloat(y) || 0 };
}

/** A press on a chip: a click until it travels DRAG_SLOP, a drag after. */
function armDrag(e: PointerEvent, list: HTMLElement, li: HTMLElement, i: number) {
  if (drag || e.button !== 0) return;
  drag = {
    list, li, pointerId: e.pointerId, from: i, to: i,
    x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastY: e.clientY,
    lifted: false, boxes: [], bounds: null, scroll: 0,
  };
  // On the window: the rebuild after a drop takes the chip, and its capture, away.
  addEventListener('pointermove', onDragMove);
  addEventListener('pointerup', onDragEnd);
  addEventListener('pointercancel', onDragEnd);
}

function onDragMove(e: PointerEvent) {
  const d = drag;
  if (!d || e.pointerId !== d.pointerId) return;
  d.lastX = e.clientX;
  d.lastY = e.clientY;
  if (!d.lifted) {
    if (Math.hypot(d.lastX - d.x0, d.lastY - d.y0) < DRAG_SLOP) return;
    lift(d);
  }
  placeHeld(d);
}

function onDragEnd(e: PointerEvent) {
  if (drag && e.pointerId === drag.pointerId) finishDrag(e.type === 'pointerup');
}

// Escape puts the chip back; it flies home from where it is drawn.
function onDragKey(e: KeyboardEvent) {
  if (!drag?.lifted || e.key !== 'Escape') return;
  // Before canvas/input.ts, whose Escape would close the editor.
  e.stopPropagation();
  markClosed(e);
  finishDrag(false);
}

/** Past the slop: measure the row at rest and pick the chip up. */
function lift(d: ChipDrag) {
  d.lifted = true;
  const items = [...d.list.children].filter((c): c is HTMLElement => c instanceof HTMLElement);
  // Caught mid-settle, the chip stays where it is drawn rather than snapping
  // to its slot under the pointer.
  const live = drawnAt(d.li);
  d.x0 -= live.x;
  d.y0 -= live.y;
  for (const li of items) {
    for (const run of li.getAnimations()) run.cancel();
    li.style.translate = '';
  }
  d.boxes = items.map(li => li.getBoundingClientRect());
  d.bounds = d.list.getBoundingClientRect();
  d.scroll = d.list.scrollTop;
  d.list.classList.add('is-sorting');
  d.li.classList.add('is-dragging');
  // Captured, so the chips passed under the pointer do not each peek their stop.
  try { d.li.querySelector('button')?.setPointerCapture(d.pointerId); } catch { /* the pointer has gone */ }
  addEventListener('keydown', onDragKey, true);
  cue('pick');
}

/** Draw the held chip under the pointer and open the gap where it would land. */
function placeHeld(d: ChipDrag) {
  const { boxes, from } = d;
  const home = boxes[from];
  // A scroll since the lift moved the block, and the held chip with it.
  const shift = d.list.scrollTop - d.scroll;
  let dx = d.lastX - d.x0;
  let dy = d.lastY - d.y0 + shift;
  // Kept inside the block: past its edge the overflow would cut the chip off.
  if (d.bounds) {
    const b = d.bounds;
    dx = Math.min(Math.max(dx, b.left - home.left), b.right - home.right);
    dy = Math.min(Math.max(dy, b.top + shift - home.top), b.bottom + shift - home.bottom);
  }
  d.li.style.translate = `${dx}px ${dy}px`;
  // dropAt() answers a boundary as drawn; moveTourStop() takes an index with
  // the held stop already removed, which past `from` is one less.
  const at = dropAt(boxes, home.left + home.width / 2 + dx, home.top + home.height / 2 + dy);
  const to = at > from ? at - 1 : at;
  if (to === d.to) return;
  d.to = to;
  // Each chip between the two places takes its neighbour's slot.
  const items = [...d.list.children].filter((c): c is HTMLElement => c instanceof HTMLElement);
  items.forEach((li, i) => {
    if (i === from) return;
    const slot = i > from && i <= to ? i - 1 : i < from && i >= to ? i + 1 : i;
    const sx = boxes[slot].left - boxes[i].left;
    const sy = boxes[slot].top - boxes[i].top;
    li.style.translate = slot === i ? '' : `${sx}px ${sy}px`;
  });
}

/** Put the held chip down in its gap, or back where it was, and let it settle. */
function finishDrag(commit: boolean) {
  const d = drag;
  if (!d) return;
  abandonDrag();
  if (!d.lifted) return;
  // The click after this release is the drag's, not a press on the stop.
  swallowClick = true;
  setTimeout(() => { swallowClick = false; }, 0);
  const { li, list, from } = d;
  const to = commit ? d.to : from;
  // Where it is drawn, and the lift it is drawn with, before any of it goes.
  const was = li.getBoundingClientRect();
  const lifted = getComputedStyle(li);
  const lifting = { scale: lifted.scale, rotate: lifted.rotate };
  if (to !== from) {
    // The foot row follows whatever it was pointed at.
    if (current === from) current = to;
    else if (current > from && current <= to) current -= 1;
    else if (current < from && current >= to) current += 1;
    cue('tap');
    // Rebuilds the bar (paint()), which is the drop.
    moveTourStop(from, to);
    const landed = host?.querySelector('.tour-chips')?.children[to];
    if (landed instanceof HTMLElement) settle(landed, was, lifting);
    return;
  }
  // Nothing moved: every chip goes home from where it is drawn.
  const items = [...list.children].filter((c): c is HTMLElement => c instanceof HTMLElement);
  const offsets = items.map(drawnAt);
  list.classList.remove('is-sorting');
  li.classList.remove('is-dragging');
  items.forEach((el, i) => {
    el.style.translate = '';
    if (el !== li) slideHome(el, offsets[i]);
  });
  settle(li, was, lifting);
}

/** End the gesture's bookkeeping, with no motion: the bar is about to be rebuilt, or the release animates itself. */
function abandonDrag() {
  const d = drag;
  if (!d) return;
  drag = null;
  removeEventListener('pointermove', onDragMove);
  removeEventListener('pointerup', onDragEnd);
  removeEventListener('pointercancel', onDragEnd);
  removeEventListener('keydown', onDragKey, true);
}

/** --dur-base in ms, or 0 where motion is off. */
const motionMs = () => (reducedMotion() ? 0 : baseMs());

/** The dropped chip eases into its slot from the box it was let go at. */
function settle(el: HTMLElement, was: DOMRect, lifting: { scale: string, rotate: string }) {
  const ms = motionMs();
  if (!(ms > 0) || typeof el.animate !== 'function') return;
  const now = el.getBoundingClientRect();
  // Centres, since the lift scales the chip about its own.
  const dx = was.left + was.width / 2 - (now.left + now.width / 2);
  const dy = was.top + was.height / 2 - (now.top + now.height / 2);
  // Above its neighbours until it lands (chrome.css).
  el.classList.add('is-settling');
  const run = el.animate([
    { translate: `${dx}px ${dy}px`, scale: lifting.scale, rotate: lifting.rotate },
    { translate: '0 0', scale: '1', rotate: '0deg' },
  ], { duration: ms, easing: readToken('--ease-back') || 'ease' });
  const done = () => el.classList.remove('is-settling');
  run.addEventListener('finish', done);
  run.addEventListener('cancel', done);
}

/** A chip that made way, back into its own slot. */
function slideHome(el: HTMLElement, from: { x: number, y: number }) {
  const ms = motionMs();
  if (!(ms > 0) || (Math.abs(from.x) < 1 && Math.abs(from.y) < 1) || typeof el.animate !== 'function') return;
  el.animate([{ translate: `${from.x}px ${from.y}px` }, { translate: '0 0' }],
    { duration: ms, easing: readToken('--ease') || 'ease' });
}
