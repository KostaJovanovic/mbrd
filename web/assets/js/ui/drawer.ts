// Drawer — deleted items as cards on a shelf, built with buildItem().
// Three per shelf, dealt not reflowed. Piles are one slot. Items return
// by drag, not button. Mounts lazily on scroll-into-view.

import {
  board, bus, selection, removeItems, restoreItems, emptyTrash, select,
  restoreTitleCard, isTitleHidden, clipHomeId, stuckHostId,
} from '../state.ts';
import { formatBytes, div, el, markClosed } from '../util.ts';
import { buildItem, restingTilt, kindName } from '../canvas/item-dom.ts';
import { releaseCardContent } from '../canvas/items.ts';
import { startEdgePan } from '../canvas/edge-pan.ts';
import { noteWords } from '../canvas/note-model.ts';
import { toast } from '../notify.ts';
import { cue } from '../cuelume/engine.ts';
import { quality, onQuality } from '../quality.ts';
import { ask } from './dialog.ts';
// Icon builder for this window's header marks; uses createElementNS, keeping
// innerHTML out of a module that draws items from a .mbrd someone else wrote.
import { icon } from './menu.ts';
import { makeWindowDrag, makeWindowResize } from './float-window.ts';
import type { Viewport } from '../canvas/viewport.ts';
import type { Item, TrashEntry } from '../board-model.ts';
import { shownName } from '../board-model.ts';

/** How many cards to a shelf. See the header: dealt, not reflowed. */
const PER_SHELF = 3;

/**
 * The box a card is fitted into on a shelf, in screen pixels. Sized so three
 * fit across the narrowest window: 320px floor, minus 24px padding and two
 * 10px gaps, is three columns of 84. Fixed, not a share of the column - so a
 * wider window gives the shelf air instead of enlarging the cards.
 */
const SLOT_W = 84;
const SLOT_H = 90;

/** The same, for the copy that follows the pointer - larger, because it is one. */
const GHOST_W = 132;
const GHOST_H = 132;

/** A world-space box in the sense the CSS uses: left, top and a size. */
type Box = { l: number, t: number, w: number, h: number };

/**
 * What a pile takes up on the board, in the coordinates a card is laid out
 * in - placeBox()'s reading (canvas/items.ts): `x`/`y` name an item's centre,
 * and world y points up while CSS top points down, hence the negation.
 *
 * Union of every item's box, not just the host's: a sticker stuck near a
 * corner hangs half off it, and fitting the host alone would clip that half.
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
 * **The cards are scaled, not resized** - resizing would lay fixed-size
 * things (the caption plate, a note's own font size) out against the smaller
 * box and clip them instead of shrinking them. So each item keeps its own
 * world size and position within the pile, and the *pile* takes one `scale`
 * for all of them - the card the board would draw, just further away.
 *
 * The stage's width/height are the scaled result (a transform only repaints,
 * it doesn't relayout), written whether or not anything is mounted, which is
 * what keeps shelves from jumping as slots scroll in and out.
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
 * Put one card where it sits inside its pile - placeBox() (canvas/items.ts)
 * with the pile's corner subtracted, same four numbers and `--half-*`
 * properties: CSS can cap a border-radius at half the shorter side but can't
 * read that capped value back, so anything tracing the drawn corner needs it
 * from here.
 *
 * Rotation carries over too - a note turned on the board stays turned on its
 * pile. `--item-tilt` rides separately as its own `rotate`, which is why a
 * card keeps its resting lean once it's left the canvas.
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
 * How far a press may wander and still count as a click, not a drag - see
 * onUp() in startDrag(). Smaller than the board's own DRAG_SLOP: this is a
 * small target and the two gestures aren't near each other anyway.
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
 * A host entry and everything stuck to it, host first then riders by
 * z-order (how the board stacks them). A pile of one is the ordinary case.
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
    // Two roles depending on selection: with one, this is delete-with-a-
    // picture-on-it; with none, it opens what's already been deleted.
    if (selection.size) {
      closeDrawer();
      removeItems([...selection]);
      return;
    }
    if (win) closeDrawer(); else openDrawer();
  });

  // A board swap closes the window too, same reason as the sticker pad: a
  // window floating over a board that no longer exists would look like a bug.
  bus.on('board:load', () => { closeDrawer(); paintButton(); });
  bus.on('trash', () => { paintButton(); if (win) fill(); });
  bus.on('selection', paintButton);

  // Escape closes it, not in the capture phase (unlike the sticker pad's
  // disarm) - no mode to get out of, so a dialog on top gets the key first.
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !win) return;
    markClosed(e);
    closeDrawer();
  });

  // A full bin drops its oldest to make room (TRASH_LIMIT in board-model.ts); say
  // so, since those entries are past getting back by any other means.
  bus.on('trash:evicted', n => toast(
    n === 1 ? 'Drawer full — dropped the oldest item' : `Drawer full — dropped the ${n} oldest items`));
  // Emptying deletes files, not just entries, so it's worth saying what went.
  // Count is of *files* only - notes/swatches/stickers had no bytes to begin
  // with. See emptyTrash() in trash.ts.
  bus.on('trash:purged', ({ items, bytes }) => toast(
    `Deleted ${items} ${items === 1 ? 'file' : 'files'} for good${bytes ? ` — ${formatBytes(bytes)} freed` : ''}`));

  // Quality settings are read when the window is built, so a change while
  // it's open (rare, visible) is answered by rebuilding - same trade
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

  // The title card, when thrown away, isn't filed among ordinary items - it's
  // a singleton with no shelf card, so it gets its own way back in the
  // header, shown only while actually gone. restoreTitleCard() emits 'trash',
  // which hides this button again on its own.
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
  // 320 across, not the sticker pad's 260: a shelf is always three cards
  // wide, and a narrower window breaks that promise. See drawer.css.
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
  // And every mounted card's decoder, picture and model stage - handed back
  // here, not on removal, since the element stays in the document through
  // the slide-out below.
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
  // The button's state is colour alone, invisible to a screen reader, so the
  // name spells it out in words - and may as well carry the exact count too.
  const name = selection.size
    ? `Delete ${selection.size} selected ${selection.size === 1 ? 'item' : 'items'}`
    : entries.length
    ? `Drawer, ${entries.length} ${entries.length === 1 ? 'item' : 'items'}`
    // "Nothing in it", not "empty" - "empty" is also the verb the Empty
    // button performs, so it read as an instruction rather than a state.
    : 'Drawer, nothing in it';
  button.setAttribute('aria-label', name);
  button.title = name;
}

// ---------------------------------------------------------------------------
// The shelves
// ---------------------------------------------------------------------------

/**
 * Build the whole body: the shelves, or the "nothing in here" line. Rebuilt
 * whole, not patched - an entry arriving or leaving reshuffles which shelf
 * every later card is on, so patching would move most nodes anyway.
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
 * First pass deals a slot to every entry that is nobody's rider, fixing
 * shelf order to drawer order. Second pass walks each rider up its `stuckOf`
 * chain to the pile it belongs to (a sticker may be stuck to a note stuck to
 * a photograph). Step-capped at the drawer's length, since a cycle would
 * otherwise loop forever on a stamp this app need not have written.
 *
 * Riders are then sorted by z rather than left in drawer order, since board
 * order is only *usually* stacking order - not good enough for deciding
 * which of two overlapping notes is on top.
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
    // A chain naming nothing with a slot is a stamp this app didn't write -
    // give the entry its own slot rather than silently dropping it.
    const pile = on ? home.get(on) : null;
    if (pile) pile.push(entry);
    else out.push([entry]);
  }
  // Host stays first regardless of z - it's the pile's identity (id, age,
  // name all read pile[0]). Only riders are ordered against each other.
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
  // A frozen clip has exactly one place to go, so it's the one slot that
  // doesn't need to be told where - see restoreItems() (trash.ts) and `home`
  // in startDrag(), which is what makes the click work.
  const home = clipHomeId(item);
  if (home) node.dataset.home = home;
  node.title = home
    ? 'Click to put it back on its card'
    : 'Drag onto the board to put it back, or press Enter';
  // Reachable without a pointer - deleting is a keystroke, and without this,
  // taking something back would be drag-only.
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  // What's stuck to it is named explicitly, since a screen reader can't infer
  // it from the picture - without this a photo with two notes and one with
  // none would read the same.
  const riders = pile.length - 1;
  node.setAttribute('aria-label', riders
    ? `Restore ${label(item)}, with ${riders} ${riders === 1 ? 'thing' : 'things'} stuck to it`
    : `Restore ${label(item)}`);

  // Sized whether or not the cards are mounted, so shelves don't jump as
  // slots scroll in and out.
  const stage = div('drawer-card');
  standPile(stage, pileBox(pile), SLOT_W, SLOT_H);

  const when = div('drawer-when');
  when.textContent = ago(entry.at);

  node.append(stage, when);
  return { pile, el: node, stage, live: false };
}

/**
 * Watch the slots against the window's own scrolling box. `root` is the
 * body, not the viewport: what matters is scrolling into the drawer, and
 * every slot is already inside the browser's viewport.
 */
function watch() {
  watcher?.disconnect();
  if (!body) return;
  // How far ahead of scroll a card may build, the same at every stop: the
  // pace is quality.build's to ration (drain() below). It used to be nothing
  // whenever Animated GIFs was off, which is Light - so every card was built
  // as it scrolled into view and dropped the moment it left, popping in and
  // out on the device least able to afford the rebuilds.
  const ahead = '220px';
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
 * Ask for a slot to be built, at the dial's pace. quality.build is the
 * board's own per-frame ceiling (BUILD_BUDGET, canvas/items.ts) - without it,
 * a fast scroll through sixty entries builds and immediately discards every
 * card it passes.
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
 * The cards themselves, in one wrapper that takes the pile's `scale` (see
 * standPile()), so the stage stays in screen pixels while its contents stay
 * in board coordinates. A node, not a loop written twice, because the drag
 * ghost clones this same wrapper.
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
 * What Light means for a drawer: dropping a clip's <video> source stops its
 * decoder from ever being allocated, leaving just its poster. The media half
 * of releaseCardContent() (canvas/items.ts), applied at build time rather
 * than discard time.
 *
 * Also run over the drag ghost regardless of the dial - a cloned <video> is
 * a second decoder for an element that only exists for a gesture.
 */
function hush(card: HTMLElement) {
  for (const m of card.querySelectorAll<HTMLMediaElement>('video, audio')) {
    m.pause();
    m.removeAttribute('src');
    m.load?.();
  }
}

/**
 * A note's words, via canvas/note-model.ts's reading - not raw `meta.text`,
 * which keeps the `# `/`## ` markers that let a note round-trip as plaintext
 * and shouldn't be read aloud as "# Kitchen".
 */
function noteText(item: Item): string {
  return noteWords(item.meta);
}

/** What this card is called, for the slot's accessible name. */
function label(item: Item): string {
  if (item.type === 'link') {
    // `meta` is open, so url is whatever the file carried; String() is the
    // coercion textContent would do anyway.
    const url = item.meta?.url;
    return item.name || (url ? String(url) : '') || 'link';
  }
  if (shownName(item)) return shownName(item);
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
 * The one question this module asks. Emptying is the only control in the app
 * that destroys bytes: purgeAssets() deletes files for good, so undo only
 * gives back a tombstone record, not the photograph - worth a sentence
 * before it happens, not a toast after. Count is of everything in the
 * drawer; how much was a file is what 'trash:purged' says (see emptyTrash()).
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
 * Enter or Space on a slot puts that card back, in the middle of the view
 * rather than where it was deleted from - the same judgement the drag makes,
 * answered for a keyboard.
 */
function restoreByKey(e: KeyboardEvent) {
  if (e.key !== 'Enter' && e.key !== ' ' && e.code !== 'Space') return;
  // SAFETY: listener is on the window's body, so the key's target is an
  // element; `?.` guards the rest as usual.
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

  // **Nothing is decided here, and no preventDefault.** The press may be a
  // tap, or - far more often on a phone - the start of a scroll. Swallowing
  // it immediately would break `touch-action: pan-y` (drawer.css), which
  // leaves vertical scrolling to the browser.
  //
  // Cost: a drag starting *straight down* reads as a scroll (pointercancel)
  // rather than a drag. Every other direction still works, and the board
  // sits above/right of this window, so that's not the gesture people use.
  let lifted = false;
  // Where the pointer last was, for the edge loop, which pans the board while
  // the card is held at an edge. Held still over this window, where a drop is
  // a cancel and there is no board to see.
  let at = { x: e.clientX, y: e.clientY };
  let stopEdge: (() => void) | null = null;
  const overWindow = () => !!win?.contains(document.elementFromPoint(at.x, at.y));

  const lift = (ev: PointerEvent) => {
    lifted = true;
    slot.setPointerCapture?.(ev.pointerId);
    slot.classList.add('is-lifting');
    // Steps back rather than closing (unlike the sticker pad, which places
    // one shape and is done). Faded, not hidden - a drop over it is still a
    // cancel, and it needs to stay visible enough to aim away from.
    win?.classList.add('is-lifting');
    ghost = makeGhost(slot);
    // Not until the pointer has come out onto the board: this window stands on
    // the edge of the screen.
    if (vp) {
      stopEdge = startEdgePan(vp, { point: () => (overWindow() ? null : at), needsEntry: true });
    }
  };

  const onMove = (ev: PointerEvent) => {
    at = { x: ev.clientX, y: ev.clientY };
    if (!lifted) {
      if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) <= TAP_SLOP) return;
      lift(ev);
    }
    moveGhost(ev.clientX, ev.clientY);
  };

  // Taken off the window - see the note at the foot of this function.
  const unwire = () => {
    stopEdge?.();
    stopEdge = null;
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('pointercancel', onCancel);
    slot.classList.remove('is-lifting');
    win?.classList.remove('is-lifting');
  };

  const onUp = (ev: PointerEvent) => {
    unwire();
    dropGhost();

    // A press that never went anywhere, on a slot that knows where it
    // belongs - the click. Written here, not as a `click` listener, since
    // the tap is the degenerate case of the same drag gesture.
    //
    // Only slots with a home: a frozen clip's card is already on the board,
    // so there's no "where does it go" question for a click to skip.
    const home = !!slot.dataset.home;

    // Letting go over the window is a cancel - the card stays put, unless
    // it's the tap (press and release in the same place, always over the
    // window).
    if (win?.contains(document.elementFromPoint(ev.clientX, ev.clientY))) {
      if (lifted || !home) return;
    }

    // A clip going home ignores the drop point - restoreItems() puts it
    // back on its own card, wherever that is now.
    land([id], home ? null : vp!.toWorld(ev.clientX, ev.clientY));
  };

  const onCancel = () => {
    unwire();
    dropGhost();
  };

  // On the window, not the slot: fill() rebuilds the whole body on 'trash',
  // which this drag's own restore emits - a slot detached mid-gesture used
  // to take its listeners with it, leaving the ghost stuck following the
  // pointer with nothing to dismiss it.
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
 * The thing under the pointer while a card is carried back to the board - a
 * copy of the pile itself, since that's what's being carried and a generic
 * square would misrepresent the drop. Hushed regardless of the dial: a
 * cloned <video> is a second decoder for something that exists for a drag.
 */
function makeGhost(slot: HTMLElement) {
  const node = div('drawer-ghost');
  node.id = 'drawer-ghost';
  const found = slots.find(s => s.el === slot);
  const pile = slot.querySelector<HTMLElement>('.drawer-pile');
  if (found && pile) {
    // SAFETY: cloneNode is typed to return Node regardless; a deep copy of
    // an element is still an element.
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
