// The Drawer: what you deleted, kept as cards on a shelf.
//
// Deleting on this board used to be recoverable only through undo, which is a
// stack - it can only give you back the *last* thing, and only if you have not
// done anything since. A drawer is the other model: everything you threw away,
// kept, in no particular relation to what you did afterwards, taken back one at
// a time whenever you notice you want it.
//
// ── Why it is a window of cards and not a list of rows ──
//
// This was a list: a 38px thumbnail, a filename and an age, in a popover pinned
// over the corner. The thumbnail was a lookup written here - a photograph's own
// bytes, a clip's poster, three letters of an extension for everything else -
// which meant the panel had a second, poorer opinion about what every kind of
// card looks like, and that opinion drifted from the board's every time a
// renderer changed. A note in the drawer was twelve characters of its first
// line in a grey square; on the board it is words on a coloured pad in the face
// it was written in.
//
// So the drawer draws the real thing. buildItem() (canvas/item-dom.ts) is the
// board's own card builder and it is what fills every slot here - the same
// body, the same caption, the same pad colour, the same lean off square. There
// is no second drawing of a card in this app, and there is no longer a table
// here saying what a video looks like.
//
// It is a floating window rather than a popover for the reason the sticker pad
// is one: it is a drawer of things that are not on the board, you work out of it
// for a while, and a panel welded over the corner you are trying to drop onto is
// in the way exactly when it is being used. It shares its move and resize
// gestures with the pad and the player outright (ui/float-window.ts).
//
// Three cards to a row, on shelves. The shelf is not decoration: a grid that
// reflows to whatever the window is wide would give the same drawer a different
// arrangement at every size, and the point of a shelf is that a thing stays
// where you put it. So the rows are dealt in threes here rather than left to
// auto-fill, and the ledge is drawn under each one.
//
// ── A pile is one card, not three ──
//
// Deleting a photograph with two notes stuck to it files three entries, because
// three things left the board (riderCascade, trash.ts). It should not put three
// cards on the shelf. What was thrown away was *the photograph with its notes on
// it*, it comes back out as that in one drag (restoreItems rebuilds the pile),
// and a shelf showing the note twice - once floating on its own and once on the
// picture it is stuck to - describes a drawer nobody has.
//
// So a slot holds a pile: the host and everything stamped `stuckOf` onto it,
// drawn where they sat on it. It is the same arithmetic the board uses and not a
// second opinion about where a note goes - each card is given its real world box
// relative to the pile's, and the whole pile is scaled into the slot as one
// picture, so the note is the share of the photograph it always was. The stage
// is fitted to the pile's *bounding* box rather than the host's, so a sticker
// hanging off a corner is on the shelf rather than clipped at its edge.
//
// A rider whose host is not in the drawer - taken back out, or emptied - gets a
// slot of its own, which is the honest picture: it is on its own now.
//
// ── Liveness: on screen, and what the quality dial allows ──
//
// A card is the real card, which for a clip means a decoder and for a model a
// WebGL context. The bin holds up to sixty entries (TRASH_LIMIT), and sixty of
// those mounted at once is the thing that kills a phone - so a slot builds its
// card when it scrolls into the window and gives it back when it scrolls out,
// which is the same bargain canvas/items.ts's culling makes with the board, and
// it hands content back through that module's own releaseCardContent() rather
// than through a second spelling of it here.
//
// The dial moves two numbers: how many cards may be built in one frame
// (quality.build, the board's BUILD_BUDGET), and how far ahead of the scroll a
// slot is allowed to mount. And on Light - the stop that turns motion off - a
// mounted card is hushed: any <video> or <audio> in it is stopped and its source
// taken away, so what is left is the poster the card was already showing. A
// still of a clip is what a drawer full of clips should cost on a tired phone.
//
// ── Coming back ──
//
// A drag rather than a Restore button, and that is the same judgement it always
// was: a deleted item remembers where it used to be, but that spot is usually
// the reason it was deleted - the board has moved on and grown into the gap.
// Dragging says where it goes now, in one gesture, and lands it there. The one
// exception is a frozen clip, which has a card on the board waiting for it and
// so has nothing to be asked; that one is a click. Enter or Space is the
// keyboard's answer and lands in the middle of the view.
//
// The drag is plain pointer events, not HTML5 drag-and-drop: the board already
// owns the native drop channel for files, and a synthetic one would have to
// serialise an item through a DataTransfer just to hand it back to the same page
// it started on.
//
// Nothing here touches `document` at import time - every reach is inside
// initDrawer() or a handler that runs after it.

import {
  board, bus, selection, removeItems, restoreItems, emptyTrash, select,
  restoreTitleCard, isTitleHidden, clipHomeId, stuckHostId,
} from '../state.ts';
import { formatBytes, div, el } from '../util.ts';
import { buildItem, restingTilt, kindName } from '../canvas/item-dom.ts';
import { releaseCardContent } from '../canvas/items.ts';
import { noteWords } from '../canvas/note-model.ts';
import { toast } from '../notify.ts';
import { cue } from '../cuelume/engine.ts';
import { quality, onQuality } from '../quality.ts';
import { ask } from './dialog.ts';
// The menu's icon builder, for the two marks in this window's header. It builds
// the <use> with createElementNS, which is what keeps innerHTML out of a module
// that draws items out of a .mbrd somebody else wrote - see tests/drawer.test.js.
import { icon } from './menu.ts';
import { makeWindowDrag, makeWindowResize } from './float-window.ts';
import type { Viewport } from '../canvas/viewport.ts';
import type { Item, TrashEntry } from '../board-model.ts';

/** How many cards to a shelf. See the header: dealt, not reflowed. */
const PER_SHELF = 3;

/**
 * The box a card is fitted into on a shelf, in screen pixels.
 *
 * Small enough that three fit across the window at its narrowest, which is the
 * arithmetic worth writing down once: the resize floor is 320 and a phone gets
 * `100vw - 24`, so the tightest case is a 320px screen - 24px of body padding
 * and two 10px gaps leaves 252, which is three columns of 84.
 *
 * A fixed pair rather than a share of the column, so pulling the window wider
 * gives the shelf air instead of enlarging what is on it. Three cards to a shelf
 * is what the shelf *is*; how big a card is is a fact about the card.
 */
const SLOT_W = 84;
const SLOT_H = 90;

/** The same, for the copy that follows the pointer - larger, because it is one. */
const GHOST_W = 132;
const GHOST_H = 132;

/** A world-space box in the sense the CSS uses: left, top and a size. */
type Box = { l: number, t: number, w: number, h: number };

/**
 * What a pile takes up on the board, in the coordinates a card is laid out in.
 *
 * The board's own reading, from placeBox() (canvas/items.ts): an item's `x`/`y`
 * name its *centre*, and world y points up while CSS top points down - hence the
 * negation. Getting either wrong here would go unnoticed on a pile of one, which
 * is why it is written once and used for both cases.
 *
 * The union rather than the host's box alone, because a sticker is stuck near a
 * corner as often as in the middle and half of it hangs off. Fitting the host
 * would put that half outside the slot.
 */
function pileBox(pile: Pile): Box {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const { item } of pile) {
    l = Math.min(l, item.x - item.w / 2);
    r = Math.max(r, item.x + item.w / 2);
    t = Math.min(t, -item.y - item.h / 2);
    b = Math.max(b, -item.y + item.h / 2);
  }
  return { l, t, w: Math.max(1, r - l), h: Math.max(1, b - t) };
}

/**
 * Size a stage to hold one pile, and tell the pile how to draw itself into it.
 *
 * **The cards are scaled, not resized, and that is the whole of this function.**
 * Handing a 256x192 photograph a 90x68 box instead would lay every world-space
 * thing on it out against the smaller number: the caption plate along its foot
 * is a fixed 12px of type (item-chrome.css, deliberately off the chrome scale
 * because it zooms with the board), so a plate that is a seventh of a card on
 * the board becomes a third of one here, and a note's words - set at the size
 * somebody chose - arrive clipped rather than small. What is wanted is the card
 * the board would draw, further away.
 *
 * So each .item keeps its own world size and its own world position within the
 * pile, and it is the *pile* that takes the `scale` - one number for all of
 * them, which is what keeps a note the share of its photograph that it is on the
 * board. The stage takes the scaled result as its actual width and height, since
 * a transform changes what is painted and not what is laid out. The pile is
 * pinned by its centre rather than its corner because `scale` turns about the
 * centre by default.
 *
 * Written on the stage whether or not anything is mounted in it, which is what
 * keeps the shelves from jumping about as slots scroll in and out.
 */
function standPile(stage: HTMLElement, box: Box, boxW: number, boxH: number) {
  const k = Math.min(boxW / box.w, boxH / box.h);
  stage.style.width = (box.w * k).toFixed(1) + 'px';
  stage.style.height = (box.h * k).toFixed(1) + 'px';
  stage.style.setProperty('--pile-w', box.w.toFixed(1) + 'px');
  stage.style.setProperty('--pile-h', box.h.toFixed(1) + 'px');
  stage.style.setProperty('--card-k', k.toFixed(4));
}

/**
 * Put one card where it sits inside its pile.
 *
 * placeBox() (canvas/items.ts) with the pile's own corner taken off, and it is
 * deliberately the same four numbers plus the same three `--half-*` properties:
 * CSS can cap a border-radius at half the shorter side but cannot read the
 * capped result back, so the rings and plates that have to trace the corner the
 * browser actually drew are handed the number from here. Without them a card in
 * the drawer rounds off differently from the same card on the board.
 *
 * The rotation too, which the shelf used to drop: a note turned twenty degrees
 * on the board is turned twenty degrees on the picture it is stuck to, and a
 * pile that quietly straightened its riders would be drawing a pile nobody made.
 * The resting lean is separate and rides along on its own - `--item-tilt` is a
 * `rotate` rather than part of this transform, which is the whole reason a card
 * keeps leaning once it has left the canvas.
 */
function placeInPile(el: HTMLElement, item: Item, box: Box) {
  el.style.left = (item.x - item.w / 2 - box.l).toFixed(2) + 'px';
  el.style.top = (-item.y - item.h / 2 - box.t).toFixed(2) + 'px';
  el.style.width = item.w.toFixed(2) + 'px';
  el.style.height = item.h.toFixed(2) + 'px';
  el.style.setProperty('--half-min', (Math.min(item.w, item.h) / 2).toFixed(2) + 'px');
  el.style.setProperty('--half-w', (item.w / 2).toFixed(2) + 'px');
  el.style.setProperty('--half-h', (item.h / 2).toFixed(2) + 'px');
  if (item.rot) el.style.transform = `rotate(${-item.rot}deg)`;
}

/**
 * How far a press may wander and still count as a click rather than a drag.
 *
 * Only the slots that have a home read it - see onUp() in startDrag(). Four
 * pixels rather than the board's own DRAG_SLOP, because this is a small target
 * in a window and the two gestures it separates are not near each other: a drag
 * out of the drawer crosses the window's edge, and a click does not move at all.
 */
const TAP_SLOP = 4;

let vp: Viewport | null = null;
/** The corner button. Static markup in index.html; null on a page without it. */
let button: HTMLElement | null = null;

/** The window element, or null when it is closed. */
let win: HTMLElement | null = null;
/** The scrolling region inside it. */
let body: HTMLElement | null = null;
/** The Empty button and the title card's way back, repainted as the bin changes. */
let emptyBtn: HTMLButtonElement | null = null;
let titleRestore: HTMLButtonElement | null = null;
/** The move and resize grabs' detaches, called on close. */
let detachGrabs: (() => void)[] = [];

let ghost: HTMLElement | null = null;

/**
 * A host entry and everything stuck to it, in the order they are drawn - the
 * host first, then its riders up the z-order, which is how the board stacks them.
 * A pile of one is the ordinary case and is not a special one anywhere below.
 */
type Pile = TrashEntry[];

/**
 * One pile's place on a shelf. `stage` is the box that holds the built cards and
 * keeps the slot's height whether or not any are in it - see mount().
 */
type Slot = { pile: Pile, el: HTMLElement, stage: HTMLElement, live: boolean };
let slots: Slot[] = [];

/** Which slots have scrolled in and are waiting for a frame to be built in. */
let pending: Slot[] = [];
let building = 0;
let watcher: IntersectionObserver | null = null;

export function initDrawer(viewport: Viewport) {
  vp = viewport;
  button = el('drawer-btn');
  if (!button) return;

  button.addEventListener('click', () => {
    // The button is two things, and which one it is depends on whether anything
    // is selected. With a selection it is the delete key with a picture on it;
    // with none it is the way into what you have already deleted.
    if (selection.size) {
      closeDrawer();
      removeItems([...selection]);
      return;
    }
    if (win) closeDrawer(); else openDrawer();
  });

  // A board swap takes the window with it, for the reason the sticker pad gives:
  // everything else on screen is torn down, and a window left floating over a
  // board that no longer exists is the one thing that would look like a bug.
  bus.on('board:load', () => { closeDrawer(); paintButton(); });
  bus.on('trash', () => { paintButton(); if (win) fill(); });
  bus.on('selection', paintButton);

  // Escape closes it. Not in the capture phase, unlike the sticker pad's disarm:
  // there is no mode to get out of here, so this must not take the key from a
  // dialog or a menu that is genuinely on top of the drawer.
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !win) return;
    closeDrawer();
  });

  // A full bin drops its oldest to make room (TRASH_LIMIT in board-model.ts); say
  // so, since those entries are past getting back by any other means.
  bus.on('trash:evicted', n => toast(
    n === 1 ? 'Drawer full — dropped the oldest item' : `Drawer full — dropped the ${n} oldest items`));
  // And the other end of the same idea: emptying the drawer deletes the files
  // rather than only the entries, so it is worth saying what went and how much
  // came back. The count is of *files* - notes, swatches and stickers empty out
  // of the drawer as they always did, since there were never any bytes to
  // delete. See emptyTrash() in trash.ts, which decides both numbers.
  bus.on('trash:purged', ({ items, bytes }) => toast(
    `Deleted ${items} ${items === 1 ? 'file' : 'files'} for good${bytes ? ` — ${formatBytes(bytes)} freed` : ''}`));

  // The dial moves what a slot is allowed to mount and how far ahead of the
  // scroll it may do it, and both are read when the window is built - so a
  // change while it is open is answered by building it again. It happens when
  // somebody moves a slider, which is rare and visible; the same trade
  // ui/quality.ts makes for the board.
  onQuality(() => { if (win) fill(); });

  paintButton();
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

function openDrawer() {
  if (win) return;
  win = div('drawer-window');
  win.id = 'drawer-window';
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-label', 'Drawer');

  const head = div('drawer-head');
  const title = div('drawer-title');
  title.textContent = 'Drawer';
  const spacer = div('drawer-spacer');

  // The Desktop title card, when it has been thrown away, is not filed here
  // among ordinary items - it is a singleton the board is meant to have, and it
  // has no card to put on a shelf. So it gets its own way back, in the header,
  // and only while it is actually gone. restoreTitleCard() emits 'trash', so the
  // repaint that follows hides this button again on its own.
  titleRestore = document.createElement('button');
  titleRestore.type = 'button';
  titleRestore.className = 'drawer-title-back';
  titleRestore.append(icon('i-title'), document.createTextNode('Title card'));
  titleRestore.title = 'Bring back the title card';
  titleRestore.setAttribute('aria-label', 'Bring back the title card');
  titleRestore.addEventListener('click', () => { cue('pick'); restoreTitleCard(); });

  emptyBtn = document.createElement('button');
  emptyBtn.type = 'button';
  emptyBtn.className = 'drawer-empty';
  emptyBtn.textContent = 'Empty';
  emptyBtn.title = 'Throw it all out — the files go for good';
  emptyBtn.addEventListener('click', confirmEmpty);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'drawer-close';
  close.setAttribute('aria-label', 'Close the drawer');
  close.append(icon('i-close'));
  close.addEventListener('click', () => { cue('pick'); closeDrawer(); });

  head.append(title, spacer, titleRestore, emptyBtn, close);
  detachGrabs.push(makeWindowDrag(win, head));

  body = div('drawer-body');
  body.addEventListener('pointerdown', startDrag);
  body.addEventListener('keydown', restoreByKey);
  win.append(head, body);

  const resize = div('drawer-resize');
  resize.setAttribute('aria-hidden', 'true');
  win.append(resize);
  // 320 across, not the sticker pad's 260: a shelf is three cards wide whatever
  // the window is, and a window that cannot fit three has broken the one promise
  // this drawer makes. See #drawer-window's own width in drawer.css.
  detachGrabs.push(makeWindowResize(win, resize, { minW: 320, minH: 220 }));

  document.body.append(win);
  fill();
  button?.setAttribute('aria-expanded', 'true');

  // Up into place next frame - it needs two computed styles to run between for
  // the transition to take, the same as the sticker pad and the player window.
  requestAnimationFrame(() => win?.classList.add('is-open'));
}

/** The slide-out backstop, so a close that never sees transitionend finishes. */
let exitTimer = 0;

function closeDrawer() {
  if (!win) return;
  const node = win;
  win = null;
  body = null;
  emptyBtn = null;
  titleRestore = null;
  // Take the move/resize grab listeners off window before the element goes.
  detachGrabs.forEach(fn => fn());
  detachGrabs = [];
  // And every mounted card's decoder, picture and model stage. The element is
  // still in the document for the length of the slide-out below, so this is what
  // decides when those are handed back rather than the removal.
  clearShelves();
  node.classList.remove('is-open');
  clearTimeout(exitTimer);
  const done = () => { clearTimeout(exitTimer); node.remove(); };
  node.addEventListener('transitionend', e => { if (e.propertyName === 'transform') done(); }, { once: true });
  exitTimer = setTimeout(done, 500);
  button?.setAttribute('aria-expanded', 'false');
}

function paintButton() {
  if (!button) return;
  const entries = board.trash;
  button.classList.toggle('has-things', entries.length > 0);
  // The button carries its state as colour alone, which a screen reader cannot
  // see, so the name has to carry the same fact in words - and it may as well
  // carry the exact number while it is there, since that is the one thing the
  // muted-or-not look genuinely cannot say.
  const name = selection.size
    ? `Delete ${selection.size} selected ${selection.size === 1 ? 'item' : 'items'}`
    : entries.length
    ? `Drawer, ${entries.length} ${entries.length === 1 ? 'item' : 'items'}`
    // "Nothing in it" rather than "empty". The pattern is `Drawer, <state>` and
    // every other state is a count, but "empty" is also the verb for what the
    // button inside the window does - so read aloud after the word "button", or
    // read in a tooltip beside a control that really can empty the drawer, it
    // was an instruction rather than a reading.
    : 'Drawer, nothing in it';
  button.setAttribute('aria-label', name);
  button.title = name;
}

// ---------------------------------------------------------------------------
// The shelves
// ---------------------------------------------------------------------------

/**
 * Build the whole body: the shelves, or the line that says there is nothing in
 * here.
 *
 * Rebuilt whole rather than patched, for the reason the sticker pad's own body
 * is: an entry arriving or leaving changes which shelf every later card is on,
 * so keeping the existing nodes in step would mean moving most of them anyway.
 * It happens on a delete or a restore, not on a frame.
 */
function fill() {
  if (!body) return;
  clearShelves();
  body.replaceChildren();

  const entries = board.trash;
  if (emptyBtn) emptyBtn.disabled = !entries.length;
  if (titleRestore) titleRestore.hidden = !isTitleHidden();

  if (!entries.length) {
    const none = div('drawer-none');
    none.textContent = 'Nothing thrown away yet.';
    body.append(none);
    return;
  }

  const stacked = piles(entries);
  for (let i = 0; i < stacked.length; i += PER_SHELF) {
    const shelf = div('drawer-shelf');
    for (const pile of stacked.slice(i, i + PER_SHELF)) {
      const slot = makeSlot(pile);
      slots.push(slot);
      shelf.append(slot.el);
    }
    body.append(shelf);
  }

  const hint = div('drawer-hint');
  hint.textContent = 'Drag a card back onto the board.';
  body.append(hint);

  watch();
}

/**
 * Gather the drawer's entries into the piles they were thrown away as.
 *
 * Two passes and a walk. The first deals a slot to every entry that is nobody's
 * rider - either it was never stuck to anything, or what it was stuck to has
 * since been taken back out - and that pass is what fixes the order on the
 * shelves: a pile stands where its host stands in the drawer, so the newest
 * thing thrown away is still the first thing on the first shelf.
 *
 * The second walks each rider up its `stuckOf` chain to the pile it belongs to,
 * because a sticker may be stuck to a note that is itself stuck to the
 * photograph and only the photograph has a slot. The step cap is the length of
 * the drawer, which no honest chain can exceed and a cycle would: stuckHostId()
 * reads a stamp out of a file this app need not have written.
 *
 * Riders are sorted by z afterwards rather than left in drawer order. The drawer
 * is a delete's order, which is board order, which is *usually* the stacking
 * order - and "usually" is not good enough for the one thing this decides, which
 * is which of two overlapping notes is on top.
 */
function piles(entries: TrashEntry[]): Pile[] {
  const out: Pile[] = [];
  const home = new Map<string, Pile>();
  for (const entry of entries) {
    if (stuckHostId(entry.item)) continue;
    const pile = [entry];
    home.set(entry.item.id, pile);
    out.push(pile);
  }
  const at = new Map(entries.map(e => [e.item.id, e.item]));
  for (const entry of entries) {
    let on = stuckHostId(entry.item);
    if (!on) continue;
    for (let step = 0; on && !home.has(on) && step < entries.length; step++) {
      const host = at.get(on);
      on = host ? stuckHostId(host) : null;
    }
    // A chain that named nothing with a slot is a stamp this app did not write.
    // The entry keeps a slot of its own, which is what it would have had if the
    // stamp were absent - a drawer that silently drops a card is worse than one
    // that shows a note on its own.
    const pile = on ? home.get(on) : null;
    if (pile) pile.push(entry);
    else out.push([entry]);
  }
  // The host stays first whatever its z - it is the pile's identity, not merely
  // its bottom card, and everything below reads pile[0] for the id, the age and
  // the name. Only the riders are ordered against each other.
  for (const pile of out) {
    const riders = pile.splice(1).sort((a, b) => a.item.z - b.item.z);
    pile.push(...riders);
  }
  return out;
}

function makeSlot(pile: Pile): Slot {
  const entry = pile[0];
  const item = entry.item;
  const node = div('drawer-slot');
  node.dataset.id = item.id;
  // A clip frozen off a card that is still on the board has exactly one place to
  // go, so it is the one slot here that does not need to be told where - see the
  // header of restoreItems() in trash.ts, and `home` in startDrag() below, which
  // is what makes the click work. Everything else keeps the drag, and the words
  // keep saying so.
  const home = clipHomeId(item);
  if (home) node.dataset.home = home;
  node.title = home
    ? 'Click to put it back on its card'
    : 'Drag onto the board to put it back, or press Enter';
  // Reachable and operable without a pointer. Deleting was already a keystroke;
  // without this, taking something back would be a drag and nothing else, so a
  // keyboard or screen-reader user could empty the drawer and never look inside.
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  // What is stuck to it is named rather than left to be inferred from a picture,
  // which is the one thing a screen reader cannot take from this slot: without
  // it, a photograph with two notes on it and a photograph with none read the
  // same, and taking one back would bring two things nobody was told about.
  const riders = pile.length - 1;
  node.setAttribute('aria-label', riders
    ? `Restore ${label(item)}, with ${riders} ${riders === 1 ? 'thing' : 'things'} stuck to it`
    : `Restore ${label(item)}`);

  // The box the pile stands in, at the size it will be whether or not the cards
  // are mounted in it - which is what keeps the shelves from jumping about as
  // slots scroll in and out.
  const stage = div('drawer-card');
  standPile(stage, pileBox(pile), SLOT_W, SLOT_H);

  const when = div('drawer-when');
  when.textContent = ago(entry.at);

  node.append(stage, when);
  return { pile, el: node, stage, live: false };
}

/**
 * Watch the slots against the window's own scrolling box.
 *
 * `root` is the body rather than the viewport: what matters is whether a card
 * has scrolled into the drawer, and every slot is inside the browser's viewport
 * the whole time the window is open.
 */
function watch() {
  watcher?.disconnect();
  if (!body) return;
  // How far ahead of the scroll a card is allowed to be built. The dial's own
  // trade, in the one unit this module has to spend: at Full a screenful of
  // margin means a scroll arrives at cards that are already drawn, and at Light
  // nothing is built until it is actually being looked at.
  const ahead = quality.motion ? '220px' : '0px';
  watcher = new IntersectionObserver(seen => {
    for (const e of seen) {
      const slot = slots.find(s => s.el === e.target);
      if (!slot) continue;
      if (e.isIntersecting) queue(slot);
      else { drop(slot); pending = pending.filter(p => p !== slot); }
    }
  }, { root: body, rootMargin: `${ahead} 0px` });
  for (const slot of slots) watcher.observe(slot.el);
}

/**
 * Ask for a slot to be built, at the dial's pace.
 *
 * quality.build is the board's own per-frame ceiling (BUILD_BUDGET in
 * canvas/items.ts) and it is the right number here for the same reason: a fast
 * scroll through sixty entries otherwise builds every card it passes, and the
 * ones it passed are discarded a frame later having cost a decode each.
 */
function queue(slot: Slot) {
  if (slot.live || pending.includes(slot)) return;
  pending.push(slot);
  if (building) return;
  building = requestAnimationFrame(drain);
}

function drain() {
  building = 0;
  for (let n = 0; n < quality.build && pending.length; n++) {
    // SAFETY: the loop only runs while `pending` has something in it.
    mount(pending.shift()!);
  }
  if (pending.length) building = requestAnimationFrame(drain);
}

function mount(slot: Slot) {
  if (slot.live) return;
  slot.live = true;
  slot.stage.replaceChildren(buildPile(slot.pile, pileBox(slot.pile)));
}

/**
 * The cards themselves, in one wrapper that carries the pile's world box.
 *
 * The wrapper is what takes the scale, so the stage can be sized in screen
 * pixels while everything inside it stays in the coordinates the board laid it
 * out in - see standPile(). It is also what the drag ghost clones, which is why
 * it is a node rather than a loop written twice.
 */
function buildPile(pile: Pile, box: Box) {
  const wrap = div('drawer-pile');
  for (const { item } of pile) {
    const card = buildItem(item, restingTilt(item), false);
    placeInPile(card, item, box);
    if (!quality.motion) hush(card);
    wrap.append(card);
  }
  return wrap;
}

/** Hand a slot's card back: the node, and everything its contents hold on to. */
function drop(slot: Slot) {
  if (!slot.live) return;
  slot.live = false;
  releaseCardContent(slot.stage);
  slot.stage.replaceChildren();
}

function clearShelves() {
  watcher?.disconnect();
  watcher = null;
  cancelAnimationFrame(building);
  building = 0;
  pending = [];
  for (const slot of slots) drop(slot);
  slots = [];
}

/**
 * Take the moving parts out of a card, leaving what it was already showing.
 *
 * What Light means for a drawer. A clip's card is a poster with a player over
 * it, and the poster is the part worth keeping: dropping the source stops the
 * decoder from ever being allocated for a card nobody is going to press, and
 * what is left on the shelf is a still of the shot. It is the media half of
 * releaseCardContent() (canvas/items.ts), applied at build time rather than at
 * discard time - the other half of that function is about handing back things a
 * mounted card has already taken, which is exactly what this is stopping from
 * being taken.
 *
 * Also run over the drag ghost, whatever the dial says. A clone of a mounted
 * <video> is a second decoder for an element that exists for the length of a
 * gesture, and there is nothing to see in it that the still does not show.
 */
function hush(card: HTMLElement) {
  for (const m of card.querySelectorAll<HTMLMediaElement>('video, audio')) {
    m.pause();
    m.removeAttribute('src');
    m.load?.();
  }
}

/**
 * A note's words - canvas/note-model.ts's reading, not this file's.
 *
 * `meta.text` raw carries the `# ` and `## ` that let a note round-trip as
 * plaintext, so a note with a heading would be announced as "# Kitchen". The
 * marker is storage, not something the person who typed the heading should hear.
 */
function noteText(item: Item): string {
  return noteWords(item.meta);
}

/** What this card is called, for the slot's accessible name. */
function label(item: Item): string {
  if (item.type === 'link') {
    // `meta` is open, so the url is whatever the file carried. The String() is
    // the coercion textContent would have done to it anyway.
    const url = item.meta?.url;
    return item.name || (url ? String(url) : '') || 'link';
  }
  if (item.name) return item.name;
  if (item.type === 'note') return noteText(item).split('\n')[0] || 'Empty note';
  // A nameless item stands under what it is.
  return kindName(item);
}

/** Coarse and relative - the exact minute a thing was binned is never the question. */
function ago(at: number) {
  if (!at) return '';
  const secs = Math.max(0, (Date.now() - at) / 1000);
  if (secs < 60) return 'now';
  if (secs < 3600) return Math.floor(secs / 60) + 'm';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h';
  return Math.floor(secs / 86400) + 'd';
}

// ---------------------------------------------------------------------------
// Emptying it
// ---------------------------------------------------------------------------

/**
 * The one question this module asks.
 *
 * Emptying used to be a single press, and it is the only control in the app that
 * destroys bytes: purgeAssets() deletes the files and rewrites the ledger's
 * copies of them, so the undo that follows gives back the *record* of what was
 * there - a tombstone card - and not the photograph. That is worth a sentence
 * before it happens rather than a toast afterwards.
 *
 * The count is of everything in the drawer, because that is what the person is
 * looking at. How much of it was a file, and how many bytes came back, is what
 * the 'trash:purged' toast says once it is known - see emptyTrash().
 */
async function confirmEmpty() {
  const n = board.trash.length;
  if (!n) return;
  const answer = await ask({
    title: 'Empty the drawer?',
    body: `${n === 1 ? 'The one thing' : `All ${n} things`} in here would go, and the files with them. `
      + 'Undo gives back a record of what was thrown away, not the files themselves.',
    go: 'Empty it',
    danger: true,
  });
  if (answer !== 'go') return;
  cue('fall');
  emptyTrash();
}

// ---------------------------------------------------------------------------
// Taking one back out
// ---------------------------------------------------------------------------

/**
 * Enter or Space on a slot puts that card back.
 *
 * It lands in the middle of the view rather than where it was deleted from,
 * which is the same judgement the drag makes: the old spot is usually the reason
 * it was thrown away, and the board has grown into the gap since. The middle of
 * what you are looking at is the keyboard's answer to "say where".
 */
function restoreByKey(e: KeyboardEvent) {
  if (e.key !== 'Enter' && e.key !== ' ' && e.code !== 'Space') return;
  // SAFETY: the listener is on the window's body, so the target of a key inside
  // it is an element - the optional call is the guard it always was for anything
  // else.
  const slot = (e.target as Element).closest?.<HTMLElement>('.drawer-slot');
  if (!slot) return;
  e.preventDefault();
  // Every .drawer-slot is built by makeSlot() above, which writes the id onto it.
  land([slot.dataset.id!], vp!.toWorld(innerWidth / 2, innerHeight / 2));
}

function startDrag(e: PointerEvent) {
  if (e.button !== 0) return;
  // SAFETY: as in the key handler above - this listener is on the window's body,
  // so a press delivered to it landed on an element inside it.
  const slot = (e.target as Element).closest<HTMLElement>('.drawer-slot');
  if (!slot) return;
  // As above: makeSlot() writes the id onto every slot it makes.
  const id = slot.dataset.id!;
  const entry = board.trash.find(t => t.item.id === id);
  if (!entry) return;

  // **Nothing is decided here, and no preventDefault.** The press has not become
  // a drag yet and it may never - it may be a tap, and on a phone it is far more
  // often the start of a scroll. A slot is most of a shelf and a shelf is most of
  // the window, so a slot that swallowed its press the moment it arrived would be
  // a drawer that cannot be scrolled with a finger at all: `touch-action: pan-y`
  // in drawer.css leaves the vertical direction to the browser, and taking the
  // event here would take it back again.
  //
  // What that costs is one thing, worth naming: a drag out of the window that
  // begins by travelling *straight down* is a scroll instead, and arrives here as
  // a pointercancel. Every other direction is a drag. The board is above and to
  // the right of this window on both layouts, so the gesture somebody actually
  // makes is not the one being given up.
  let lifted = false;

  const lift = (ev: PointerEvent) => {
    lifted = true;
    slot.setPointerCapture?.(ev.pointerId);
    slot.classList.add('is-lifting');
    // The window steps back rather than closing, unlike the sticker pad's. The
    // pad places one shape and is done; this is a drawer you unpack, and closing
    // it on the first card would mean reopening it for the second. Faded, not
    // hidden - a drop let go over it is still a cancel, and it has to be visible
    // enough to aim away from.
    win?.classList.add('is-lifting');
    ghost = makeGhost(slot);
  };

  const onMove = (ev: PointerEvent) => {
    if (!lifted) {
      if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) <= TAP_SLOP) return;
      lift(ev);
    }
    moveGhost(ev.clientX, ev.clientY);
  };

  // Taken off the window, because that is where they are put - see the note at
  // the foot of this function.
  const unwire = () => {
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('pointercancel', onCancel);
    slot.classList.remove('is-lifting');
    win?.classList.remove('is-lifting');
  };

  const onUp = (ev: PointerEvent) => {
    unwire();
    dropGhost();

    // A press that never went anywhere, on a slot that knows where it belongs.
    //
    // This is the click, and it is written here rather than as a `click`
    // listener because the gesture is already being watched: the tap is the
    // degenerate case of the drag, and reading it off the same pointer sequence
    // is what makes "did this move?" one question with one answer.
    //
    // Only the slots with a home, and that is the whole of why a click is safe to
    // add at all. The header argues that coming back is a drag because a deleted
    // item's old spot is usually the reason it was deleted and only a drag can
    // say where it goes now. A frozen clip has no such question - its card is on
    // the board, in front of the person clicking - so the gesture that would
    // answer it has nothing to answer.
    const home = !!slot.dataset.home;

    // Let go over the window itself and nothing happens - that is a cancel, and
    // the card stays in the drawer rather than being flung somewhere arbitrary.
    // Unless it is that tap, which is a press and a release in the same place
    // and so is *always* over the window.
    if (win?.contains(document.elementFromPoint(ev.clientX, ev.clientY))) {
      if (lifted || !home) return;
    }

    // A clip going home ignores the drop point - restoreItems() puts it back on
    // its own card, wherever that card is now. Handing one over anyway would be
    // a coordinate nothing reads.
    land([id], home ? null : vp!.toWorld(ev.clientX, ev.clientY));
  };

  const onCancel = () => {
    unwire();
    dropGhost();
  };

  // On the window, not on the slot.
  //
  // fill() replaces the whole body on every 'trash' emit, and this drag ends by
  // restoring an item - which emits one. A slot detached mid-gesture took its
  // three listeners with it: onUp never fired, the ghost was left following the
  // pointer with nothing to dismiss it, and the slot it came from no longer
  // existed. The same reasoning the pointer pipeline gives for capture, applied
  // to a list that rebuilds itself.
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  addEventListener('pointercancel', onCancel);
}

/** Put these back, select them, and shut the drawer if that emptied it. */
function land(ids: string[], at: { x: number, y: number } | null) {
  const back = restoreItems(ids, at);
  if (!back.length) return;
  cue('arrive');
  select(back.map((i: Item) => i.id));
  if (!board.trash.length) closeDrawer();
}

/**
 * The thing under the pointer while a card is being carried back to the board.
 *
 * A copy of the pile itself, because that is what is being carried - the drawer
 * spent its whole design on showing the real thing and a generic square under
 * the pointer would take it back at the one moment it matters most. The notes
 * come along in the picture for the same reason they come along in the restore:
 * what is being placed is the photograph with its notes on it, and a ghost
 * showing the bare card would be promising a different drop. Hushed on the way
 * past whatever the dial says: a clone of a mounted <video> is a second decoder
 * for an element that exists for the length of a drag.
 */
function makeGhost(slot: HTMLElement) {
  const node = div('drawer-ghost');
  node.id = 'drawer-ghost';
  const found = slots.find(s => s.el === slot);
  const pile = slot.querySelector<HTMLElement>('.drawer-pile');
  if (found && pile) {
    // SAFETY: cloneNode is typed as returning a Node whatever it was called on;
    // `pile` is the HTMLElement the querySelector above found, and a deep copy
    // of an element is an element.
    const copy = pile.cloneNode(true) as HTMLElement;
    hush(copy);
    const stage = div('drawer-ghost-card');
    standPile(stage, pileBox(found.pile), GHOST_W, GHOST_H);
    stage.append(copy);
    node.append(stage);
  }
  document.body.append(node);
  return node;
}

function moveGhost(x: number, y: number) {
  if (!ghost) return;
  ghost.style.left = x + 'px';
  ghost.style.top = y + 'px';
}

function dropGhost() {
  if (ghost) releaseCardContent(ghost);
  ghost?.remove();
  ghost = null;
}
