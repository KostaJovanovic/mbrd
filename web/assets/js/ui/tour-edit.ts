// Building the tour: a mode over the board, not a panel beside it.
//
// ui/tour.ts *runs* a tour and this file *writes* one. Both are the board taken
// over for a while and both look the same doing it - the chrome goes, one bar
// comes up along the foot, and what is left on screen is the board.
//
// ── It was a panel, and being a panel was the problem ──
//
// The first version of this was a list in the Board tab: an Add button, a row
// per stop, drag to reorder. Everything about a tour that is an *order* was
// right there and everything about it that is a *board* was somewhere else -
// you picked cards on the board, read their names in a panel, and the panel
// covered the third of the board you were picking from. Ordering a tour is one
// job done in two places, with the cards on one side and their numbers on the
// other.
//
// So the editor is on the board now, in two pieces:
//
//   - **the mark on each card** - the square in its top-right corner. A number
//     if the card is at that stop, a "+" if it is not, and pressing it is what
//     puts a card on the tour or takes it off. Drawn by canvas/items.ts, which
//     owns the nodes and rebuilds them as the view moves; this file only says
//     what each one should read. See setTourMarks() there.
//   - **the bar along the foot** - what a mark cannot say: the order, as a row
//     of stops that can be dragged past each other, and the caption.
//
// The sidebar keeps the one button that opens this and nothing else. Once the
// mode is on, the panel is hidden with the rest of the chrome (:root.is-tour-edit
// in chrome.css) - which is the point: the board is the thing being ordered, so
// the board is what you should be able to see.
//
// ── The bar is built the way every other surface in this app is built ──
//
// It was not, and it showed. The shape here is the Timeline strip's, one edge
// over, because that is the nearest thing in the app to this: a bar pinned to
// the foot of the window with a head, a row of steps and a line about them.
//
//   - **A head row: what this is, on the left, and the way out on the right.**
//     Every surface in the app that can be closed puts its cross at the top
//     right - #side-close, #header-close, .tl-close, #viewer-close - and this
//     one had it at the bottom right on the reasoning that the tour bar's is at
//     the end of its row. The tour bar has *one* row, so its end and its top
//     right are the same place; on a three-row panel they are not, and the
//     convention is the top right.
//   - **The two verbs are one pair.** Add stop and Take the tour are the same
//     shape, the same height and the same border, and differ only in that the
//     one you press over and over carries the accent. That is .btn-row in
//     sidebar.css - the pair this feature already has in the Board tab - and it
//     is what makes two buttons read as two answers to one question rather than
//     as two unrelated controls that happen to be nearby.
//
// ── The rows never change size ──
//
// It was one row that grew a second one when a stop was pressed, and whose Add
// button was labelled with a whole sentence that changed length on every press
// - so the row of stops slid sideways under the pointer while you were dragging
// one of them, and the whole bar jumped a line taller when you touched a chip.
// A surface you are aiming at must not move because of something you did
// somewhere else on it, and both rows exist at a fixed height for that reason
// alone. The second one carries the caption when a stop is pointed at and a line
// of hints when none is, which is the same box saying whichever of the two there
// is something to say.
//
// The stops are on the **left** of the top row and the verbs on the right, for
// the same reason: the strip starts at a fixed edge, so nothing a button does to
// its own width can move a chip somebody is reaching for.
//
// ── The number on a chip is the order it was ADDED in, not where it sits ──
//
// **This is settled. Do not change it back.** It has been reverted twice by
// somebody reasoning from first principles about two numbers meaning two things,
// and both times it made the row useless, so the reasoning is written out here
// in full.
//
// A square numbered by its own position in a row drawn in that order reads
// 1 2 3 4 5 before you touch it and 1 2 3 4 5 after. Drag the third chip to the
// front and *nothing on screen changes* - the squares are identical, so the one
// thing this row exists to let you do is the one thing it cannot show you having
// done. There is no fix for that inside the "number = position" rule, because a
// label derived from the position cannot report on the position.
//
// So a stop is named when it is made and keeps that name while it moves. After a
// drag the row reads 3 1 2 4 5, and that disagreement between the names and the
// order they are lying in *is the feedback*.
//
// Yes, this is a different number from the one the card wears in its corner, and
// that is correct: the card answers "when is this photograph seen", which is a
// position and has to be, and the chip answers "which stop is this", which is a
// name. The bar and the board are asking two different questions. The tooltip on
// each chip says the position out loud for anyone who wants both.
//
// What a square cannot say - which photograph is stop 4 - the *board* says, and
// says it better than any chip could: hover the bar and every card on the tour
// wears its number across it (see peek()).
//
// ── Grouping is still the selection ──
//
// A card's mark makes a stop of its own card. Several cards *framed together*
// are one stop, and the way to say so is to select them and press Add - the
// selection the board already has, from a marquee, a shift-click or a tap. That
// is why this mode still needs no gesture of its own and cannot fight the one
// pipeline in canvas/input.ts: the two ways in are a button inside a card, which
// that pipeline already treats as a widget, and a selection somebody made with
// the tools that were always there.
//
// ── Editing is a mode, and it is this module's alone ──
//
// `editing` lives here and nowhere else. It is not on the board (it is not
// something a file should remember) and not in prefs (it is not a preference).
// The class on <html> is written from here and read only by chrome.css.

import { MAX_TOUR_CAPTION } from '../board-model.ts';
import {
  addTourStop, board, bus, byId, canTour, joinTourStops, moveTourStop,
  removeTourCards, select, selection, setTourCaption, splitTourStop,
} from '../state.ts';
import { openAnchored } from './menu.ts';
import type { MenuEntry } from './menu.ts';
import { paintTourMarks, setTourMarks } from '../canvas/items.ts';
import { previewStop, startTour, tourActive } from './tour.ts';

/** The bar, built once by initTourEdit(). */
let host: HTMLElement | null = null;

/** Whether the mode is on. See the head of this file. */
let editing = false;

/**
 * The stop the second row is pointed at, or -1.
 *
 * A tour has one caption per stop and the bar has room for one caption, so the
 * bar shows the caption of whichever chip was last pressed. Not a selection in
 * any sense the rest of the app means it - it is which stop the one text field
 * is aimed at - and it is cleared when the mode ends.
 */
let current = -1;

/** The chip being dragged, or -1. One at a time, like every gesture in the app. */
let dragging = -1;

/**
 * What each stop is *called*, as card id -> number, and the next number to give.
 *
 * The order the stops were added in - see the head of this file for why that and
 * not the order they are lying in, and do not undo it.
 *
 * Kept here and not on the board, and thrown away when the mode opens. A name
 * for a stop is editor bookkeeping in exactly the sense ui/tour.ts's `at` is: a
 * file remembering that this stop was made fourth would be a file remembering
 * how somebody worked rather than what they made. The cost is that the names
 * start again at 1 each time the mode is opened, which is honest - it is a
 * session's worth of history and it says so by resetting.
 */
const serials = new Map<string, number>();
let nextSerial = 1;

export function tourEditing() { return editing; }

export function initTourEdit() {
  // Built here rather than declared in index.html, unlike the tour bar next to
  // it. That one is markup with an id and this one is a bar whose every child
  // is a stop that does not exist until somebody makes one - there would be
  // nothing in the markup but the empty box. It costs the entry in
  // tests/element-ids.test.js's JS_BUILT table that the tour bar's comment
  // declines to pay, and that is the right way round for these two.
  host = document.createElement('div');
  host.id = 'tour-editor';
  host.hidden = true;
  document.body.append(host);
  // The marks on the cards. canvas/items.ts draws them and asks this back - see
  // the block above applyTourMark() there for why a mark cannot simply be
  // written onto the nodes from here.
  setTourMarks({ markFor, press });
  // The peek: a pointer over the bar lays the order out on the board itself -
  // see :root.is-tour-peek in item-chrome.css. A class rather than a selector,
  // because there is no selector that could do it: the bar is a child of <body>
  // and the cards are inside #viewport, so the only combinator that connects
  // them is a sibling one and those look forward from the wrong element.
  //
  // pointerenter/leave rather than over/out: these two do not fire again for
  // every chip and every button inside the bar, which the bubbling pair would.
  host.addEventListener('pointerenter', () => peek(true));
  host.addEventListener('pointerleave', () => peek(false));
  // Every way the bar can go stale. `tour` is the list itself; `items` is a card
  // being deleted or restored under it, which changes what a stop resolves to
  // without changing board.tour; `selection` is the Add button and the hint
  // line, and it is the noisiest of the three by a long way - hence the early
  // return in paint() when the mode is off.
  bus.on('tour', paint);
  bus.on('items', paint);
  bus.on('selection', paint);
  bus.on('board:load', () => {
    editing = false;
    serials.clear();
    nextSerial = 1;
    paint();
  });
  // A tour that starts ends the mode. The two hide the same chrome and both
  // want the foot of the screen, and a tour is what you build one of these for.
  bus.on('tour:at', () => { if (tourActive() && editing) editing = false; paint(); });
  paint();
}

/** Open or shut the editor. The sidebar's one button, and the bar's cross. */
export function toggleTourEdit() {
  editing = !editing;
  // Names start again with the mode - see `serials`. On the way in rather than
  // on the way out, so a tour opened for the first time reads 1 2 3 along the
  // row and only starts disagreeing with its own order once somebody has moved
  // something, which is when the disagreement means anything.
  if (editing) { serials.clear(); nextSerial = 1; }
  paint();
}

/**
 * Lay the order out over the cards, or take it back off.
 *
 * Guarded on `editing` as well as on the pointer, because the bar takes 200ms to
 * leave and a pointer resting on it while somebody closes the mode would
 * otherwise hold the board under a veil with nothing on screen explaining it.
 */
function peek(on: boolean) {
  document.documentElement.classList.toggle('is-tour-peek', on && editing);
}

/**
 * End the mode if it is on, and say whether it was.
 *
 * The same shape stopTour() has and for the same caller: Escape in
 * canvas/input.ts tries the temporary states outermost first, and each one
 * answers whether it took the press.
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
 * Anything canTour() refuses wears nothing at all, rather than a "+" that would
 * do nothing when pressed - the title card on every board, and every sticker and
 * note lying on a card. That second one is most of what a busy board is covered
 * in, and a "+" on each of them would be an invitation on top of a photograph to
 * make a stop of the sticker instead of the picture.
 */
function markFor(id: string): number | null {
  if (!editing || !canTour(byId(id))) return null;
  const at = stopOf(id);
  return at < 0 ? 0 : at + 1;
}

/** Which stop this card is at, or -1. */
const stopOf = (id: string) => board.tour.findIndex(stop => stop.cards.includes(id));

/**
 * A mark pressed: on the tour, off it.
 *
 * The card alone in both directions. A "+" makes a stop of one card, never of
 * the selection it happens to be in - grouping is the bar's Add, which says so
 * in its own tooltip - and a number takes that card off, leaving the rest of its
 * stop framed together (see removeTourCards() in state.ts).
 */
function press(id: string) {
  if (stopOf(id) >= 0) { removeTourCards([id]); return; }
  if (addTourStop([id])) current = board.tour.length - 1;
  paint();
}

/**
 * What the selection is, as far as the tour is concerned.
 *
 * Everything canTour() refuses is dropped first, because addTourStop() will drop
 * it too - and a button that counted the stickers in a marquee and then made a
 * stop of three cards while saying six would be lying about what it did.
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
 * The bar's one verb, in whichever direction the selection is pointing.
 *
 * Add and Remove are the same act with a sign, so they are the same button: it
 * works on the selection, and what it offers is whatever the selection is not
 * already. Cards that are all on the tour can only be taken off; anything else
 * is an add of the ones that are not on it yet.
 */
function addOrCut() {
  const { on, off } = pickedCards();
  // Deliberately silent when nothing happens: the button is only pressable with
  // something selected, so what is left is a selection holding nothing but
  // furniture, and a toast explaining that would be an apology for a press that
  // could not have been meant.
  if (off.length) {
    if (addTourStop(off)) current = board.tour.length - 1;
  } else {
    removeTourCards(on);
  }
  paint();
}

/**
 * What a stop is called: its cards, named.
 *
 * The same shortening the tour bar makes (see stopLabel() in ui/tour.ts) and it
 * is deliberately not shared with it - the bar has a line of a fixed width and
 * this is a chip in a scrolling strip. What they share is the rule, which is
 * that a card with no name of its own is "Untitled" rather than blank: a chip
 * with nothing on it cannot be told from a chip that failed to draw.
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
 * The whole bar, rebuilt.
 *
 * Rebuilt rather than reconciled: it is a handful of chips on the longest tour
 * anybody builds by hand, and a diff would be more code than the thing it is
 * optimising. What a rebuild must not do is take the caret out of a caption
 * somebody is typing in, and there are two halves to that. The caption commits
 * on `change` (blur, Enter) rather than on `input`, so the repaint that follows
 * a write happens after the field has given up focus - and a repaint caused by
 * something else entirely, a card arriving or a selection changing, puts the
 * caret back where it was (see readCaret).
 */
function paint() {
  if (!host) return;
  // Everything that is not the board, out of the way - the same list a running
  // tour hides, and the same argument. See chrome.css.
  document.documentElement.classList.toggle('is-tour-edit', editing);
  // The button that opened this, told what it did. Written from here rather than
  // read from a predicate in the schema, because the panel repaints on four bus
  // events and none of them is "the editor opened" - see the row's own comment
  // in ui/settings-schema.ts.
  document.querySelector('[data-cmd="tour-edit"]')?.setAttribute('aria-pressed', String(editing));
  paintTourMarks();
  if (!editing) { shut(); return; }

  const caret = readCaret();
  host.textContent = '';
  host.hidden = false;
  if (current >= board.tour.length) current = board.tour.length - 1;

  // Named once for the whole bar, so the chips and the number beside the caption
  // agree about which stop is being pointed at - see stopNames().
  const names = stopNames();
  host.append(headRow(), stripRow(names), footRow(names));

  if (caret) {
    const cap = host.querySelector<HTMLInputElement>('.tour-cap');
    cap?.focus();
    cap?.setSelectionRange(caret.start, caret.end);
  }
  // A frame between the unhide and the class, or the entrance has nothing to run
  // from: an element going from display:none straight to its final state is a
  // jump rather than a transition. The same two-step the tour bar and the player
  // both use. Harmless on the repaints, where the class is already on.
  requestAnimationFrame(() => { if (editing) host?.classList.add('is-up'); });
}

/** The way out: down under the edge, and emptied once it is gone. */
function shut() {
  // Before the early return, not after it: the mode can end with the pointer
  // still on the bar, and the veil has to come off whether or not there was a
  // bar left to hide.
  peek(false);
  if (!host || host.hidden) return;
  current = -1;
  host.classList.remove('is-up');
  const bar = host;
  // Guarded on `editing`, or a mode turned straight back on inside the window
  // would be hidden by the timer belonging to the one before it. Emptied here
  // rather than above, so the exit has something to run on.
  setTimeout(() => { if (!editing) { bar.hidden = true; bar.textContent = ''; } }, 200);
}

/**
 * The head: what this bar is, how much of it there is, and the way out.
 *
 * The Timeline strip's head, one edge over - a title, a quiet line of state
 * beside it, and the cross at the right. Every closable surface in this app puts
 * its cross there and this one is not going to be the exception.
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
  // Nothing at all when there is nothing on the tour: the head has already said
  // "no stops yet" and the hint below says what to do about it, and a third
  // sentence between them saying the same thing again would be the bar
  // apologising for being empty.
  if (board.tour.length) row.append(chips(names));
  return row;
}

/**
 * The foot row: what is said at the stop being pointed at, or what can be done.
 *
 * One box at a fixed height holding whichever of the two there is something to
 * say. A caption field standing empty and disabled for the whole session would
 * be the loudest thing on the bar, for the one part of a stop that is optional;
 * a row that appears and disappears would make the bar jump a line taller every
 * time somebody pressed a chip. The hints are what the space is worth when there
 * is no caption to write, and they are the only place the three gestures this
 * mode hides - drag, right-click, the mark on a card - are written down.
 */
function footRow(names: number[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tour-row tour-foot-row';
  row.append(current >= 0 ? captionField(current, names[current]) : hint());

  // The two verbs, side by side and the same shape - see the head of this file.
  // One question, two answers: put something on the tour, or go and read it.
  const acts = document.createElement('div');
  acts.className = 'tour-acts';

  const { on, off } = pickedCards();
  const cutting = !!on.length && !off.length;
  const n = cutting ? on.length : off.length;
  // Two words and a count, and the count is a pill rather than part of the
  // sentence. The label used to be the whole sentence - "Add 3 cards as one
  // stop" - which is better English and made the button change width on every
  // selection. The sentence is in the tooltip, where being long costs nothing.
  const add = textButton(
    'tour-add is-primary',
    cutting ? 'Remove' : 'Add stop',
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
  // The mode ends only if the tour actually started - startTour() declines on
  // Mobile and on an empty list, and closing on a toast would leave somebody
  // looking at a board with no way back to the editor but the panel.
  play.addEventListener('click', () => { if (startTour()) { editing = false; paint(); } });
  acts.append(play);

  row.append(acts);
  return row;
}

/** What is said at the stop the bar is pointed at. */
function captionField(i: number, name: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'tour-cap-wrap';

  // The chip's name and not the place, or pressing the chip marked 3 would put
  // a 1 beside the field and it would look like it belonged to something else.
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
  // On `change` and not on `input` - see paint().
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
// What the row can do to a stop that dragging it cannot: take a group apart, or
// put two of them together. Both are edits to *what a stop is* rather than to
// where it sits, and the row's one gesture is already spoken for by where.
//
// A menu and not two more buttons on the chip. A chip is small, three controls
// on each would be a toolbar per stop, and both commands are ones somebody
// reaches for occasionally and knows they want - which is the whole test for a
// menu rather than a control on the surface. The foot row says out loud that the
// menu is there, because a right-click nobody is told about is a feature nobody
// has.
//
// ui/menu.ts renders it, because there is one menu implementation in this app
// and this is not the second. openAnchored() rather than the cursor door: the
// chip is a button, the menu belongs under it, and the anchored path is the one
// that flips a panel above its anchor when the anchor is on a bar at the foot of
// the window - which every chip in this row is.

/** The rows for one stop. Only what applies to this one is in the list. */
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
    icon: 'i-close', danger: true, action: () => { removeTourCards(cards); paint(); } },
  ];
}

/** Break this stop up, and keep the foot row pointing where it was. */
function splitAt(i: number) {
  const k = board.tour[i]?.cards.length ?? 0;
  if (k < 2) return;
  // Everything after it moves down by the pieces it gained. The stop itself
  // keeps its index, and the caption went to the first piece - see
  // splitTourStop() - so a foot row open on it is still open on it.
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
 * One pass over the list rather than a lookup per chip, because the answer for
 * one stop depends on the ones before it: two stops must never wear the same
 * name, and they can ask for the same one. A card keeps its name when it is
 * taken off a stop, so a card pulled out of stop "3" and added again as a stop
 * of its own arrives asking to be called 3 while the stop it left still is.
 * `used` is what settles that - the stop that reaches the name first keeps it
 * and the other is given a fresh one.
 *
 * A stop is named after whichever of its cards already has a name, and then
 * every card in it is stamped with that name. Which means a group survives
 * losing cards, a split gives the first piece the old name and the rest new
 * ones, and a join keeps the earlier of the two.
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
  // One listener for the whole row rather than three per chip - the chips are
  // rebuilt on every paint and each one would otherwise carry its own set into
  // the garbage.
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
    // dropAt() answers a *boundary* in the row as it is drawn - "between these
    // two chips" - and moveTourStop() takes an index into the list with the
    // dragged stop already out of it. Dragging forwards, those differ by one:
    // pulling stop 1 of [a b c] into the gap between b and c is boundary 2 and
    // index 1, and handing the boundary straight to the door drops it at the
    // end instead. The two are the same going backwards, where nothing before
    // the gap has been removed.
    const to = dropAt(list, e.clientX, e.clientY);
    const at = to > from ? to - 1 : to;
    // The foot row follows whatever it was pointed at, rather than staying on an
    // index that now holds a different stop.
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
  // Everything the square itself cannot hold: where this stop actually comes in
  // the tour - the square carries its *name*, see the head of this file - which
  // cards are at it, how many, and the two gestures.
  const what = cards.length > 1
    ? `${cards.length} cards framed together - ${stopLabel(cards)}`
    : stopLabel(cards);
  b.title = `Stop ${i + 1} of ${board.tour.length}: ${what}`
    + '\nDrag to reorder, right-click to split or join';
  b.setAttribute('aria-label', `Stop ${i + 1}: ${what}`);
  // On the button rather than on the <li> around it. A drag started from inside
  // a draggable ancestor is the browser's guess; a draggable button is the
  // thing under the pointer saying so itself, and it is what the drop
  // arithmetic below measures.
  b.draggable = true;
  b.addEventListener('dragstart', e => {
    dragging = i;
    // Firefox will not start a drag without data on it, and the payload is never
    // read: what is being dragged is a chip of this row, which `dragging` says.
    e.dataTransfer?.setData('text/plain', String(i));
  });
  // Pressing a stop flies the camera to it without starting a tour, which is the
  // only way to check that a stop frames what it was meant to frame while you
  // are still building it - and points the foot row at it.
  //
  // It also *selects* its cards, and that is what makes one verb enough. Taking
  // a whole stop off the tour is then the same press as taking any other
  // selection off: a stop is reached the way everything else in this mode is
  // reached, by having its cards selected.
  b.addEventListener('click', () => {
    current = i;
    previewStop(i);
    select(cards);
    paint();
  });
  // Right-click: what a stop *is*, rather than where it sits - see chipEntries().
  // preventDefault because this bar is not the canvas, and without it the
  // browser's own menu would open over ours.
  b.addEventListener('contextmenu', e => {
    e.preventDefault();
    // Under the chip and kept inside the bar, which is what `bounds` is for: a
    // panel belonging to a button on a strip should not hang off the end of it.
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

  // Grouped stops are drawn as a stack rather than counted - see .is-group in
  // chrome.css. A number inside a square that already holds a number is two
  // numbers in twenty pixels; a second square behind it says "more than one
  // card" without asking anybody to read anything, and the tooltip has the
  // count for when the answer matters.
  b.classList.toggle('is-group', cards.length > 1);
  b.textContent = String(name);
  li.append(b);
  return li;
}

/**
 * Which gap a drop at this point is in, as a boundary in the block as drawn.
 *
 * 0 is before the first chip and `length` is after the last, which is what the
 * line drawn by markDrop() means and *not* what moveTourStop() takes - see the
 * conversion in the drop handler.
 *
 * **Two dimensions, because the block wraps.** It read the x alone while the
 * strip was one scrolling line, and on a wrapped block that answers by the
 * column a chip happens to be in rather than by its place in the order: dropping
 * at the left of the second line landed before the *first* chip of the first,
 * because that one is also on the left. So the y decides the line first and the
 * x only decides within it.
 *
 * Three cases, in this order. Above a chip's box entirely: the point is on an
 * earlier line than that chip, and every chip from here on is later - so this is
 * the gap. Inside its line and left of its middle: the ordinary answer. Neither:
 * keep looking, which walks off the end of a line into the first chip of the
 * next and answers there, and off the end of the block into `length`.
 *
 * Measured off the live boxes rather than off a stored width, because the chips
 * are named and no two are the same width.
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
