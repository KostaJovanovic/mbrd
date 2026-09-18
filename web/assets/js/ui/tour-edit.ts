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

/** The chip being dragged, or -1. One at a time, like every gesture in the app. */
let dragging = -1;

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
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `assets/icons.svg#${icon}`);
  svg.append(use);
  btn.append(svg);
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
  if (!editing) { shut(); return; }

  const caret = readCaret();
  host.textContent = '';
  host.hidden = false;
  if (current >= board.tour.length) current = board.tour.length - 1;

  // Named once for the whole bar, so chips and the caption number agree - see stopNames().
  const names = stopNames();
  host.append(headRow(), stripRow(names), footRow(names));

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
  board.tour.forEach((stop, i) => list.append(chip(stop.cards, i, names[i])));
  // One listener for the whole row, not three per chip - chips are rebuilt every paint.
  list.addEventListener('dragover', e => {
    if (dragging < 0) return;
    e.preventDefault();
    markDrop(list, e.clientX, e.clientY);
  });
  list.addEventListener('drop', e => {
    if (dragging < 0) return;
    e.preventDefault();
    const from = dragging;
    dragging = -1;
    // dropAt() answers a *boundary* as drawn; moveTourStop() takes an index
    // with the dragged stop already removed. Dragging forward those differ
    // by one - handing the boundary straight to moveTourStop() would drop
    // one slot too far.
    const to = dropAt(list, e.clientX, e.clientY);
    const at = to > from ? to - 1 : to;
    // The foot row follows whatever it was pointed at.
    if (current === from) current = at;
    else if (current > from && current <= at) current -= 1;
    else if (current < from && current >= at) current += 1;
    moveTourStop(from, at);
  });
  list.addEventListener('dragend', () => { dragging = -1; paint(); });
  return list;
}

/** One stop: the name it was given when it was made, and where it now sits. */
function chip(cards: string[], i: number, name: number): HTMLLIElement {
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
  // On the button, not the <li>: a draggable button is the thing under the
  // pointer saying so itself, which the drop arithmetic below relies on.
  b.draggable = true;
  b.addEventListener('dragstart', e => {
    dragging = i;
    // Firefox needs data on the drag; the payload itself is never read.
    e.dataTransfer?.setData('text/plain', String(i));
  });
  // Pressing a stop flies the camera to it without starting a tour - the
  // only way to check a stop frames what it should while still building it -
  // and points the foot row at it.
  //
  // It also *selects* its cards, which is what makes one verb enough: taking
  // a whole stop off is the same press as taking any selection off.
  b.addEventListener('click', () => {
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
 * Which gap a drop at this point is in, as a boundary in the block as drawn.
 * 0 is before the first chip, `length` after the last - what markDrop()'s
 * line means, *not* what moveTourStop() takes (see the drop handler).
 *
 * **Two dimensions, because the block wraps.** X alone answered by column
 * once the row wrapped - dropping left on line two landed before the
 * *first* chip of line one, both being on the left. Y picks the line
 * first, x only decides within it. Measured off live boxes, not a stored
 * width - chips are named and no two are the same width.
 */
function dropAt(list: HTMLElement, x: number, y: number): number {
  const items = [...list.children];
  for (let i = 0; i < items.length; i++) {
    const box = items[i].getBoundingClientRect();
    if (y < box.top) return i;
    if (y <= box.bottom && x < box.left + box.width / 2) return i;
  }
  return items.length;
}

/** The line showing where a drop would land. */
function markDrop(list: HTMLElement, x: number, y: number) {
  const to = dropAt(list, x, y);
  [...list.children].forEach((li, i) => {
    li.classList.toggle('drop-before', i === to);
    li.classList.toggle('drop-after', i === to - 1 && to === list.children.length);
  });
}
