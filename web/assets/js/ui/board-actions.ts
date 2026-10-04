// Multi-step board commands delegated from commands.ts: save cooldown,
// reset size, clear-everything guard, rearrange, nudge, reload, restart, scale.
// Called by commands.ts, never wired to elements directly. vp is injected
// by initBoardActions() so nothing touches the DOM at import time.

import { shuffle, isRecord } from '../util.ts';
import { toast } from '../notify.ts';
import { cue } from '../cuelume/engine.ts';
import { formatLength, scaleFrom, MM_PER_INCH } from '../measure.ts';
import { ask } from './dialog.ts';
import {
  board, bus, selection, setSetting, byId, commit,
  snapshotGeom, applyGeom, commitGeom, baseStep,
  recheckBoardGeometry, placeMobileItems,
  isRider, stuckTo, stuckPlacement, isFence, isLocked, fenceOf, fenceBox,
  declareOp, undoAction,
  type GeomPatch,
} from '../state.ts';
import { latticeBox, itemBounds, rotatedExtents, pictureBox } from '../geometry.ts';
import { conformAll, cardRatio, isPicture } from '../canvas/picture-shape.ts';
import { travelMs } from '../canvas/viewport.ts';
import { repaintGround, forgetLookInk } from '../canvas/ground.ts';
import { barHeight, resetItems, seenPlaces, slideFrom } from '../canvas/items.ts';
import { resetWeb } from '../canvas/web.ts';
import { resetModels } from '../canvas/model.ts';
import { flushNoteEdit, noteFloor } from '../canvas/notes.ts';
import { flushEditor } from './viewer.ts';
import { getAsset } from '../storage/assets.ts';
import { saveBoard, exportBoard, autosave, clearAllData } from '../storage/storage.ts';
import { defaultSize, measureSize } from '../canvas/renderers.ts';
import { arrange, mobileOrder } from '../arrange/arrangements.ts';
import { nudgeApart } from '../arrange/nudge.ts';
import type { Obstacle } from '../arrange/arrangements.ts';
import { syncBoardMode } from './board-view.ts';
import type { Item, Geometry } from '../board-model.ts';
import type { Point } from '../geometry.ts';
import type { Viewport } from '../canvas/viewport.ts';
import { platform } from '../platform/platform.ts';

// Fields viewport.ts does not yet export due to migration pragma.
type ActionsViewport = Viewport & {
  el: HTMLElement;
  width: number;
  height: number;
  zoom: number;
  pan: { x: number; y: number };
  left: number;
  top: number;
  moving: boolean;
};

// What snapshotGeom() actually returns (layout.ts pragma hides the geom keys).
type GeomRow = Omit<Geometry, 'presnap'> & {
  presnap: { x: number, y: number, w: number, h: number } | null;
  loose: boolean;
};

type RearrangeOptions = {
  name?: string;
  center?: Point;
  /** A fence to lay out inside, at the size it already is. */
  within?: string;
  label?: string;
};

/** A fence's room for cards: inside its margin and under its name plate. */
function fenceRoom(fence: Item) {
  const pad = baseStep();
  const plate = barHeight(fence.id);
  const x0 = fence.x - fence.w / 2 + pad, x1 = fence.x + fence.w / 2 - pad;
  // World y points up: the plate is along the top edge.
  const y0 = fence.y - fence.h / 2 + pad, y1 = fence.y + fence.h / 2 - plate - pad;
  return { x0, x1, y0: Math.min(y0, y1), y1: Math.max(y0, y1) };
}

/**
 * Pull laid-out cards in towards the middle of `room` until every one is
 * inside it, keeping their order. Spots only, never sizes: a fence too small
 * for its cards gets them overlapping rather than shrunk or spilled out.
 */
function squeezeInto(laid: { w: number, h: number }[], spots: Point[], room: { x0: number, x1: number, y0: number, y1: number }) {
  const axis = (lo: number, hi: number, at: (i: number) => number, half: (i: number) => number, put: (i: number, v: number) => void) => {
    let c0 = Infinity, c1 = -Infinity, reach = 0;
    spots.forEach((_, i) => { c0 = Math.min(c0, at(i)); c1 = Math.max(c1, at(i)); reach = Math.max(reach, half(i)); });
    // The span the centres may use so the widest card still clears both walls.
    const free0 = lo + reach, free1 = hi - reach;
    const mid = (lo + hi) / 2;
    const span = c1 - c0;
    if (c0 >= free0 && c1 <= free1) return;
    const k = span > 0 ? Math.max(free1 - free0, 0) / span : 0;
    const from = (c0 + c1) / 2;
    spots.forEach((_, i) => put(i, mid + (Math.min(k, 1)) * (at(i) - from)));
  };
  axis(room.x0, room.x1, i => spots[i].x, i => laid[i].w / 2, (i, v) => { spots[i].x = v; });
  axis(room.y0, room.y1, i => spots[i].y, i => laid[i].h / 2, (i, v) => { spots[i].y = v; });
}

let vp: ActionsViewport | null = null;

export function initBoardActions(viewport: ActionsViewport) {
  vp = viewport;
}

// ---------------------------------------------------------------------------
// Save, and the cooldown in front of it
// ---------------------------------------------------------------------------

// Save cooldown: the button shows time-since-save instead of allowing repeats.
// Autosave is unaffected; only the manual button is rate-limited.
const SAVE_COOLDOWN_MS = 30_000;
let saveReadyAt = 0;
let saveTick = 0;
let saving = false;

export async function saveWithCooldown() {
  if (saving || saveReadyAt > Date.now()) return;
  saving = true;
  paintSave();
  let ok = false;
  try {
    ok = await saveBoard();
  } catch (err) {
    console.warn('[mbrd] save failed', err);
    ok = false;
  } finally {
    saving = false;
  }
  if (!ok) { paintSave(); return; }
  cue('done');
  saveReadyAt = Date.now() + SAVE_COOLDOWN_MS;
  clearInterval(saveTick);
  saveTick = setInterval(paintSave, 1000);
  paintSave();
}

export function resetSave() {
  saveReadyAt = 0;
  clearInterval(saveTick);
  saveTick = 0;
  paintSave();
}

function paintSave() {
  const btn = document.querySelector<HTMLButtonElement>('[data-cmd="save"]');
  if (!btn) return;
  if (saving) {
    btn.disabled = true;
    btn.textContent = 'Saving…';
    return;
  }
  const left = Math.ceil((saveReadyAt - Date.now()) / 1000);
  if (left <= 0) {
    clearInterval(saveTick);
    saveTick = 0;
    btn.disabled = false;
    btn.textContent = 'Save';
    btn.removeAttribute('title');
    return;
  }
  btn.disabled = true;
  // Count up: "how stale" is more useful than "how long until enabled".
  btn.textContent = `Saved ${SAVE_COOLDOWN_MS / 1000 - left}s ago`;
  btn.title = 'Everything is already written. Edits keep saving on their own.';
}

// ---------------------------------------------------------------------------
// Clear everything - the countdown in front of the dialog
// ---------------------------------------------------------------------------

// Three presses before the dialog opens; 10s idle resets the count.
const CLEAR_PRESSES = 3;
const CLEAR_IDLE_MS = 10000;

let clearLeft = 0;
let clearTimer = 0;

export function armClear() {
  if (clearLeft > 0) clearLeft -= 1;
  else clearLeft = CLEAR_PRESSES;

  clearTimeout(clearTimer);
  if (clearLeft <= 0) {
    resetClear();
    return clearAllData();
  }
  clearTimer = setTimeout(resetClear, CLEAR_IDLE_MS);
  paintClear();
  return undefined;
}

function resetClear() {
  clearLeft = 0;
  clearTimeout(clearTimer);
  clearTimer = 0;
  paintClear();
}

function paintClear() {
  const btn = document.querySelector<HTMLButtonElement>('[data-cmd="clear-data"]');
  if (!btn) return;
  if (clearLeft <= 0) {
    btn.textContent = 'Clear everything';
    btn.removeAttribute('title');
    delete btn.dataset.arming;
    return;
  }
  btn.textContent = `Press ${clearLeft} more time${clearLeft === 1 ? '' : 's'}`;
  btn.title = 'Then it will ask, and then it will wipe this browser’s copy.';
  btn.dataset.arming = '';
}

// ---------------------------------------------------------------------------
// Size, scale, and putting the board back together
// ---------------------------------------------------------------------------

// Reset selected items to their born-at size (measureSize, not pixel dims).
// Centres and rotations are kept. Async because it reads bytes for aspect.
export async function resetSize() {
  // Fences have no natural size; locked items must not move.
  const items = board.items.filter(i => selection.has(i.id) && !isFence(i) && !isLocked(i));
  if (!items.length) return;

  const step = baseStep();
  const sized = await Promise.all(items.map(async it => {
    const blob = getAsset(it.asset?.hash)?.blob;
    // SAFETY: measureSize() reads the type and bytes. Its one name read, in isSvgImage(), goes
    // through extOf(), which takes the absent name of a Blob as ''.
    const size = blob
      ? await measureSize(it.type, blob as File).catch(() => defaultSize(it.type))
      : defaultSize(it.type);
    // A photograph's born-at size is its picture's; its card's may be a print's.
    const card = isPicture(it) ? cardRatio(it) : null;
    let { w, h } = card ? pictureBox(size, card) : size;
    w = Math.round(w);
    h = Math.round(h);
    // A note may not be smaller than its own text - the same floor the resize
    // grips respect. Measured at the width being proposed, because narrowing a
    // note rewraps it and makes it taller.
    if (it.type === 'note') h = Math.max(h, noteFloor(it.id, w));
    // On a snapped board the size the item was born at is not on the lattice,
    // and a card that came back off the grid would be a fix that broke
    // something else. Same pass Rearrange makes, for the same reason.
    return board.settings.snap ? latticeBox({ ...it, w, h }, step) : { w, h };
  }));

  // SAFETY: the cast is what GeomRow is for - see its note.
  const before = snapshotGeom(items.map(i => i.id)) as GeomRow[];
  // Tested before anything is applied, so a run that changes nothing leaves no
  // history entry behind - an undo step that restores the state it was already
  // in is a step somebody has to press twice to get anywhere. Said out loud for
  // the same reason: a menu item that does nothing is indistinguishable from
  // one that is broken.
  if (before.every((g, i) => g.w === sized[i].w && g.h === sized[i].h)) {
    toast(items.length === 1 ? 'That is already its own size' : 'Those are already their own size');
    return;
  }
  applyGeom(before.map((g, i) => ({ ...g, w: sized[i].w, h: sized[i].h })));
  commitGeom(items.length === 1 ? 'Reset size' : `Reset ${items.length} sizes`,
    before, items.map(i => i.id));
}

/**
 * The board-wide Fill switch: whether a picture on the grid crops to its cells
 * or fits inside them. Changes no box - off the grid a card is its picture's
 * shape either way (canvas/picture-shape.ts), and on it the cells are the box.
 * One step, so Undo takes it back.
 */
export function setMediaFit(fill: boolean) {
  const prev = board.mediaFit;
  const next = fill ? 'cover' : 'contain';
  if (prev === next) return;
  commit(fill ? 'Fill grid cells' : 'Fit in grid cells',
    () => setSetting('mediaFit', next), () => setSetting('mediaFit', prev));
}

/**
 * Tell the board how big one thing really is, and every other measurement on it
 * follows.
 *
 * The way a board about real objects actually gets calibrated. A scale in world
 * units per millimetre is not a number anybody holds an opinion about; "that
 * chair is 80 cm wide" is. One known object is enough, because the board's
 * geometry is already internally consistent - it only ever needed one anchor to
 * the world.
 *
 * Width rather than height, and always: it is the dimension a person quotes for
 * furniture, prints, screens and doors alike, and asking for whichever is
 * longer would mean the question changing shape depending on what was selected.
 */
export async function scaleFromItem() {
  if (selection.size !== 1) {
    toast('Select one item whose real width you know');
    return;
  }
  const it = byId([...selection][0]);
  if (!it) return;
  const { scale, units } = board.settings;
  const unit = units === 'imperial' ? 'inches' : 'centimetres';
  const answer = await ask({
    title: 'How wide is it really?',
    body: `Right now “${it.name || 'this item'}” measures ` +
      `${formatLength(it.w, scale, units)}. Say what it is in real life, in ${unit}, ` +
      'and the whole board is measured from it.',
    field: { value: '', placeholder: units === 'imperial' ? 'e.g. 31.5' : 'e.g. 80' },
    cancel: 'Cancel',
    go: 'Set the scale',
  });
  if (answer === 'cancel' || answer == null) return;
  const said = parseFloat(answer);
  if (!(said > 0)) { toast('That is not a width', 'error'); return; }
  const mm = said * (units === 'imperial' ? MM_PER_INCH : 10);
  setSetting('scale', scaleFrom(it.w, mm));
  toast(`Measured from ${it.name || 'that item'}`);
}

/**
 * Rebuild the live board without replacing its state or clearing its history.
 *
 * This is the deliberate repair path for stale DOM measurements, viewport
 * constraints, cached model renderings, geometry that no longer agrees with an
 * enabled snap lattice, and a Fit picture whose card is no longer its shape.
 */
export function reloadBoard() {
  flushNoteEdit();
  recheckBoardGeometry();
  forgetLookInk();
  resetModels();
  resetItems();
  // The lines between cards, and this one is not covered by the 'items' emit
  // below. That rebuilds the web, but build() keeps a stored route for as long
  // as its two ends have not moved - so a route that came out wrong would
  // survive the one command whose whole job is to put a drifted board right.
  resetWeb();
  syncBoardMode();
  bus.emit('items');
  bus.emit('selection');
  bus.emit('settings', 'reload');
  repaintGround(vp!);
  vp!.apply();
  toast('Board reloaded');
  // Last, and not awaited: every other repair here is arithmetic on numbers the
  // board already holds, where this one reads pictures back off the disk. The
  // board is rebuilt and usable while it runs. On the grid too, which is the
  // one pass that asks the lattice again.
  void conformAll(true);
}

/**
 * Start the page over.
 *
 * The refresh a phone does not have. Pull-to-refresh is off by design - the page
 * does not scroll and `overscroll-behavior: none` in the stylesheets sees to the
 * rest, because every downward swipe on this board is a pan - and added to a
 * home screen there is no address bar to reload from either. Without a button, a
 * phone has no way back to a fresh page at all, which is the way to pick up a
 * new version of the app and the way out of any state the repair paths below do
 * not cover.
 *
 * Not the same act as "Reload board", and deliberately named apart from it:
 * that one rebuilds the live board in place and keeps the session, the history
 * and the view. This throws the page away, so the undo history goes with it and
 * the board comes back through restoreSession().
 *
 * Which is why the write comes first and the reload only follows a write that
 * worked. The autosave debounce is armed by every edit and a reload does not
 * run it; pressing this a second after typing would otherwise lose that second.
 * A save that fails asks before going anywhere - the answer to "your last edits
 * are not stored" is not to reload on top of them.
 */
export async function restartApp(): Promise<boolean> {
  flushNoteEdit();
  await flushEditor();
  // A rejection is a failed autosave, and a failed autosave is exactly the case
  // the dialog below exists for - so it is caught rather than allowed to walk
  // out of the function. It used to walk out, which made Restart do nothing at
  // all: no dialog, no reload, one unhandled rejection. On a phone this is the
  // only way back to a fresh page, per this function's own header.
  const stored = await autosave().catch(err => {
    console.warn('[mbrd] autosave failed before restart', err);
    return false;
  });
  if (!stored) {
    const answer = await ask({
      title: 'Restart anyway?',
      body: 'This board could not be stored in this browser, so reloading the '
        + 'page would come back to the last snapshot that was. Export it to a '
        + 'file first if you want to keep what is on screen.',
      keep: board.items.length ? 'Export first' : '',
      cancel: 'Cancel',
      go: 'Restart anyway',
    });
    if (answer === 'cancel') return false;
    if (answer === 'keep') return (await exportBoard()) ? restartApp() : false;
  }
  // See clearAllData() in storage/session.ts: a reload is what "restart" means
  // in a page, and a process relaunch is what it means in the shell.
  platform.relaunch();
  return true;
}

// ---------------------------------------------------------------------------
// Rearrange
// ---------------------------------------------------------------------------

/**
 * A card that is staying put, as the arrangement engine reads one.
 *
 * The box you can see, so a turned card is kept clear of by the rectangle it
 * actually covers rather than by its unturned one - arrange() takes a plain
 * `{x, y, w, h}` and has no idea anything on a board can be at an angle.
 *
 * `step` is the lattice, or 0 when nothing is being snapped, and passing it is
 * not tidiness. arrange() reserves whole cells for what it lays out (`cellStep`,
 * and toCells() there) and rearrange() then snaps each result to the lattice; an
 * obstacle measured off its raw rectangle can be cleared by half a cell and have
 * that half cell rounded straight back, which is the same overlap cellStep
 * exists to rule out arriving from the other side. Measured on the lattice, the
 * two round the same way and a card can at worst come to rest in the cell next
 * door.
 */
function obstacleBox(item: Item, step: number): Obstacle {
  const box = step > 0 ? latticeBox(item, step) : item;
  // The snapped box with the item's own angle: latticeBox() lays out the
  // unturned sides, and the extents of those sides at that angle contain the
  // card whichever way round the two are asked.
  const { hw, hh } = rotatedExtents({ ...box, rot: item.rot });
  return { x: box.x, y: box.y, w: 2 * hw, h: 2 * hh };
}

/**
 * Lay `items` out again. A subset relays about its own centre (not the
 * origin) and the view stays put. Options: name (layout override),
 * center, within (fence to lay out inside, at its own size), label.
 *
 * This block used to sit above obstacleBox(), which was inserted underneath it
 * by a half-finished edit, so the function it documents had no documentation
 * and the one it did not had two.
 */
export function rearrange(items: Item[], options: RearrangeOptions = {}) {
  if (!items.length) return;
  const whole = items.length === board.items.length;
  const mobile = board.layoutMode === 'mobile';

  // A stuck note is not laid out; it rides its host to the host's new slot and
  // keeps its place on it. So a pinned sticky stays pinned through a Rearrange,
  // and a note whose host is not in this set rides a host that does not move -
  // and so does not move either. Everything else is arranged as before.
  // The title card is not singled out here and takes a slot like any other -
  // but it arrives anchored (makeTitleItem in state.ts), so in practice it falls
  // out into `held` below with every other anchored card and the board is laid
  // out around it where it stands. That is the same end the old special case was
  // after, "cards no longer land on top of it", reached through the anchor
  // rather than through a rule of its own; unanchor it from its menu and it
  // takes a slot and moves with the rest again.
  const riders = items.filter(isRider);
  // A fenced card is not laid out either, and rides its fence the way a sticky
  // rides its card. A fence is one object - that is what fenceFollowers() says
  // about dragging one, and a layout has no business disagreeing - so the region
  // takes a slot at its own size and its contents keep their places inside it.
  //
  // Laid out flat, they did not: an arrangement dealt every fence a slot as
  // though it were a card and scattered its cards to slots of their own, and
  // since membership is measured and not stored, what came back was whatever
  // happened to land inside whichever rectangle. One press of "Rearrange
  // everything" took every grouping on the board apart and made new ones out of
  // the pieces. Carried instead, membership is untouched by construction.
  //
  // Read once, before anything moves, because fenceOf() measures against live
  // geometry when it has no memo - and by the second pass below the fences have
  // moved. Only a fence that is itself in this set carries: rearranging nine
  // cards that happen to sit in a fence nobody selected is a request to lay out
  // those nine, and they are laid out.
  const parentOf = new Map(items.map(it => [it.id, fenceOf(it)?.id ?? null]));
  const inSet = new Set(items.map(it => it.id));
  // Mobile has its own answer and it is a better one: packRuns() lays the whole
  // column out in runs, a band and then the cards under it, so every fenced card
  // has to be in the list it is handed. See placeMobileItems().
  const carried = mobile ? [] : items.filter(it => {
    const parent = parentOf.get(it.id);
    return !isRider(it) && !isLocked(it) && parent != null && inSet.has(parent);
  });
  const carriedIds = new Set(carried.map(it => it.id));
  // Locked cards are dealt no slot and carried by nothing, so a rearrangement
  // lays the rest of the board out around them and they stay exactly where they
  // were. That is the strongest thing a lock does - Rearrange is the one command
  // that moves everything at once, and it is the accident lock is usually
  // bought for.
  //
  // Excluded here rather than at the two call sites in commands.ts, so that
  // `whole` above is still read off the list that came in: "Rearrange
  // everything" on a board with one locked card is still a rearrangement of
  // everything, and still rebuilds about the origin and flies the view there.
  // Filtering earlier would have made one locked card silently turn it into the
  // subset behaviour, which is a different command wearing the same name.
  const free = items.filter(it => !isRider(it) && !isLocked(it) && !carriedIds.has(it.id));
  // SAFETY: as above - see GeomRow.
  const beforeAll = snapshotGeom(items.map(i => i.id)) as GeomRow[];
  // Where the cards on screen stand now, so they can slide to their slots
  // below rather than jump there. Read before anything moves.
  const seen = seenPlaces(items.map(i => i.id));
  // Nothing to lay out - the whole set was followers. There is no arrangement of
  // riders alone; they stay on their hosts. A fence's contents cannot empty this
  // on their own: containment is a strict order, so the outermost fence in any
  // chain has nothing in this set to be carried by, and is free.
  if (!free.length) return;

  // What the layout has to keep off, and the reason it needs telling.
  //
  // An anchored card was left out of `free` precisely so that it would not move
  // - and the layout, knowing nothing about it, went on dealing a slot where it
  // stands. The lock held the geometry and lost the picture: the card stayed
  // exactly where it was, under whatever the rearrangement put on top of it,
  // which is the opposite of what anybody anchors a card for.
  //
  // Anchored, *or carried by something anchored*. A card in an anchored region
  // is carried by a fence that has not moved, so its translation is zero and it
  // is standing just as still as the fence is - see the carry pass below.
  const held = new Set(board.items.filter(isLocked).map(it => it.id));
  for (let grew = true; grew;) {
    grew = false;
    for (const it of carried) {
      const parent = parentOf.get(it.id);
      if (held.has(it.id) || !parent || !held.has(parent)) continue;
      held.add(it.id);
      grew = true;
    }
  }
  // A region that *contains* what is being laid out is not something to avoid:
  // it is the room the layout is happening in - counting it would push a
  // region's own contents out of the region. Read here, with
  // parentOf above, because fenceOf() measures against live geometry.
  const around = new Set<string>();
  for (const it of items) {
    for (let f = fenceOf(it); f && !around.has(f.id); f = fenceOf(f)) around.add(f.id);
  }
  // Riders are never obstacles: a note sits on its host, so counting one would
  // wall off the card it is stuck to with a box that is already inside it.
  const anchored = board.items.filter(it =>
    held.has(it.id) && !isRider(it) && !around.has(it.id));

  const host = options.within ? byId(options.within) : null;
  const room = host && isFence(host) ? fenceRoom(host) : null;
  const at = room ? { x: (room.x0 + room.x1) / 2, y: (room.y0 + room.y1) / 2 }
    : options.center ?? (whole ? { x: 0, y: 0 } : middleOf(free));
  // SAFETY: as above - see GeomRow.
  const before = snapshotGeom(free.map(i => i.id)) as GeomRow[];
  // Two things vary here, and neither is enough on its own.
  //
  // The shuffle changes which item lands in which slot. Without it a layout is
  // a pure function of the list it is handed, so feeding it the same board
  // twice puts everything back exactly where it already was - and a button
  // called "Rearrange everything" that does nothing the second time you press
  // it reads as broken.
  //
  // The seed changes where the slots are (see arrangements.ts). Without it the
  // board comes back in the identical shape with the cards swapped around,
  // which from any distance is the same picture - and zoomed out far enough to
  // see a whole rearrangement at once, cards are shapes and not subjects.
  const order = shuffle(free.map((_, i) => i));

  // On a snapped board a rearrangement is a *re-lay*, sizes included. Placing
  // cards on the lattice and leaving them at 320x240 is the thing snapping is
  // for and does not do: the edges still miss every line, and the one gesture
  // that touches the whole board at once is the natural place to fix it.
  //
  // Sized before the layout runs rather than after, and that ordering is the
  // whole of it. The arrangements read each item's w and h to decide how much
  // room its slot needs, so resizing afterwards would hand a spiral built for
  // 320-wide cards a board of 340-wide ones - a layout with its spacing quietly
  // spent. Sizing first means the engine is laying out the cards that will
  // actually exist.
  // Sizes only. latticeBox() answers with a whole box, and the position half of
  // that answer is where the item *already* is - so spreading the whole thing
  // over a freshly chosen slot puts every card back exactly where it started,
  // which is a Rearrange button that does nothing at all.
  const step = baseStep();
  const snapDesktop = board.settings.snap && !mobile;
  // A fence keeps the size it was drawn at, the same exemption resetSize() makes
  // and for the same reason with one more on top: a region has no natural size,
  // and rounding this one to whole cells could pull an edge in past a card whose
  // centre was sitting within half a cell of it - which would drop that card out
  // of the fence silently, on a gesture that is not about membership at all.
  const sized = snapDesktop
    ? free.map(it => {
        if (isFence(it)) return { w: it.w, h: it.h };
        const b = latticeBox(it, step);
        return { w: b.w, h: b.h };
      })
    : null;
  const laid = order.map(i => (sized ? { ...free[i], ...sized[i] } : free[i]));
  const seed = (Math.random() * 0xffffffff) >>> 0;

  let placed: Item[];
  if (mobile) {
    // A column has no slots to deal, so none of the above applies: the packer
    // decides where every card goes and the arrangement decides only what order
    // it meets them in. `free` rather than `laid`, and that is the point of the
    // fork - the shuffle above exists to re-deal a set of 2D slots, and dealt
    // into a Mobile order it would scramble the very sequence the order just
    // chose. See MOBILE_ARRANGEMENTS in arrange/arrangements.ts.
    // SAFETY: the cast holds because mobileOrder() hands back the very items it
    // was given, in a new order - ArrangeItem is only the narrower shape it
    // reads them through, and every ORDERS entry is a permutation of its input.
    placed = mobileOrder(free, { name: board.arrangement, seed }) as Item[];
    const moving = new Set(free.map(item => item.id));
    // Riders are not obstacles - they overlap their host and would wall it off.
    const obstacles = whole ? [] : board.items.filter(item =>
      !moving.has(item.id) && !isRider(item) && !held.has(item.id));
    // The column tells the two apart, which Desktop has no need to. An anchored
    // card holds its own cells and the pack flows round it from the top; the
    // rest of the board sets the first row the pack may use, so a partial
    // rearrangement still appends below what it is not touching. Pushing the
    // whole column below an anchored card - the one thing an obstacle does -
    // would hang the board under a hole whenever the anchor sat near the foot of
    // it. See packMobileGrid().
    // Rearrangement changes order and position, not the sizes already visible
    // on this layout. In particular, do not rebuild them from meta.presnap:
    // that is the geometry to restore when snapping is disabled, not a sizing
    // source for every later press of Rearrange.
    placed = placeMobileItems(placed, obstacles, { preserveSize: true, blockers: anchored });
  } else {
    const spots = arrange(laid, {
      name: options.name || board.arrangement,
      center: at,
      spacing: board.settings.spacing,
      // Snapping reserves whole cells so the per-item lattice snap below cannot
      // round two tight cards into an overlap - see arrange()/toCells.
      cellStep: snapDesktop ? step : 0,
      seed,
      obstacles: anchored.map(item => obstacleBox(item, snapDesktop ? step : 0)),
      width: room ? room.x1 - room.x0 : undefined,
    });
    if (room) squeezeInto(laid, spots, room);
    placed = laid.map((item, slot) => ({
      ...item,
      x: spots[slot].x,
      y: spots[slot].y,
    }));
  }
  // spots came back in shuffled order, so each one goes to the item that was
  // in that slot, not to the item at the same index in board.items.
  const target: Item[] = new Array(free.length);
  if (mobile) {
    const byItem = new Map(placed.map(item => [item.id, item]));
    // Asserted rather than guarded: placeMobileItems() answers for every item it
    // was handed, and a miss would be read a few lines below as target[i].x on
    // nothing - so a fallback here would only move the same bug further off.
    free.forEach((item, i) => { target[i] = byItem.get(item.id)!; });
  } else {
    order.forEach((itemIndex, slot) => { target[itemIndex] = placed[slot]; });
  }
  applyGeom(before.map((g, i) => {
    // ItemMeta is unknown per key, so the memo is read out and asked whether it
    // is an object before it is copied. The truthy test this replaces let a memo
    // that was not one through to be spread into a shape with no x on it;
    // applyGeom() runs the same value past usableMemo() either way, so what
    // reaches the board is unchanged.
    const memo = target[i].meta?.presnap;
    // A patch that always carries a position: GeomPatch has x and y optional
    // because most of its callers omit them, and latticeBox() below wants a
    // whole rectangle. The intersection is what says this one never omits them.
    const at: GeomPatch & { x: number, y: number } = { ...g, x: target[i].x, y: target[i].y };
    // Mobile carries the size and the memo across as well; Desktop moves the
    // card and leaves both alone. Written rather than spread through a ternary
    // because applyGeom() tells a `presnap` that is absent from one that is
    // explicitly null - the first leaves the memo, the second forgets it.
    if (mobile) {
      at.w = target[i].w;
      at.h = target[i].h;
      at.rot = target[i].rot;
      at.presnap = isRecord(memo) ? { ...memo } : null;
    }
    if (!sized) return at;
    // Through latticeBox a second time, now with the slot the engine chose and
    // the size it laid out for. The sizes are already on the lattice and it
    // leaves them there; what this pass is for is the position, which an
    // arrangement had no reason to land on a line.
    const box = latticeBox({ ...at, ...sized[i] }, step);
    // A fence takes the position and declines the size, which is the exemption
    // above seen at the other end: latticeBox() answers with a whole box, and
    // half of that answer is the rounding this one item does not want.
    return isFence(free[i])
      ? { ...at, x: box.x, y: box.y }
      : { ...at, ...box };
  }));

  // Fences are at their new slots; carry their contents by the same translation,
  // which is what keeps a region a region. The offset each card held is kept
  // exactly - not the fractional placement a rider gets, because a fence is not
  // resized here and a region's contents are arranged relative to each other,
  // not spread across a plate.
  //
  // In passes, like the riders below and for the same reason one level further
  // out: a fence inside a fence is carried too, and can only carry its own
  // contents once it has been carried itself.
  if (carried.length) {
    const beforeById = new Map(beforeAll.map(g => [g.id, g]));
    const pending = new Set(carriedIds);
    for (let grew = true; grew && pending.size;) {
      grew = false;
      for (const it of carried) {
        if (!pending.has(it.id)) continue;
        // Non-null: `carried` is exactly the items whose parentOf entry is an id
        // that is itself in this set - see the filter that built it.
        const fenceId = parentOf.get(it.id)!;
        if (pending.has(fenceId)) continue;        // its fence has not moved yet
        const src = beforeById.get(fenceId);
        const now = byId(fenceId);
        const was = beforeById.get(it.id);
        if (src && now && was) {
          applyGeom([{ id: it.id, x: was.x + (now.x - src.x), y: was.y + (now.y - src.y) }]);
        }
        pending.delete(it.id);
        grew = true;
      }
    }
  }

  // Hosts are now at their new slots; carry each rider to its host and keep the
  // offset it had. Read the host's *old* geometry from the pre-move snapshot (so
  // the offset is the one the author set) and its new geometry live. In passes,
  // so a note stuck to a note follows only once its own host has moved.
  if (riders.length) {
    const beforeById = new Map(beforeAll.map(g => [g.id, g]));
    const pending = new Set(riders.map(r => r.id));
    for (let grew = true; grew && pending.size;) {
      grew = false;
      for (const note of riders) {
        if (!pending.has(note.id)) continue;
        const host = stuckTo(note);
        if (!host) { pending.delete(note.id); continue; }
        if (pending.has(host.id)) continue;         // host is a rider, not moved yet
        // `host` itself, not byId(host.id): stuckTo() already returned the live
        // item, so the round trip bought nothing and only risked going out of
        // date - the argument is on stuckTo()'s note in sticky.ts. The pre-move
        // snapshot is preferred for the offset the author set; the live host is
        // both the fallback and the new geometry.
        const hostSrc = beforeById.get(host.id) || host;
        const pos = stuckPlacement(note, hostSrc, host);
        applyGeom([{ id: note.id, x: pos.x, y: pos.y }]);
        pending.delete(note.id);
        grew = true;
      }
    }
  }

  // driven = the free items only. Each was placed, none towed, so each of those
  // notes asks again what it landed on. Riders are left out on purpose: they kept
  // their host, so re-measuring them onto whatever they now sit beside would be
  // the one thing that could tear a pinned pile apart. A fence's contents are out
  // for the same reason and it is the whole of the fix above: they were carried,
  // they have not moved relative to anything, and a card that asked again here
  // would be asking about a board it did not travel across. The fences themselves
  // are driven, so a region dealt a slot inside a larger one nests as it should.
  // What this step is a case of, so the history strip can offer to run it again
  // under a different arrangement. The cards it was given and the layout it used
  // are the whole of the rule; everything above this line is that rule being
  // worked out. See registerLayoutOps() in commands.ts.
  //
  // Not declared for a region's rearrangement: the op carries no `within`, so
  // replaying it would lay the cards out about their own middle and ignore the
  // walls. A fence rearrangement stays sealed until the op carries the room.
  if (!options.within) {
    declareOp('arrange', {
      ids: items.map(i => i.id),
      name: options.name || board.arrangement,
    });
  }
  const done = commitGeom(options.label || (whole ? 'Rearrange' : `Rearrange ${items.length} items`),
    beforeAll, free.map(g => g.id), mobile ? { preservePresnap: true } : {});
  // A receipt with an Undo, since a whole board laid out anew is the change
  // most worth taking back at once - and the view is about to fly off it.
  if (done) toast(`Rearranged ${free.length} item${free.length === 1 ? '' : 's'}`, '', undoAction());
  slideFrom(seen, travelMs());
  // A whole-board layout rebuilds around the origin, so the view has to follow
  // it there or the rearrangement happens off screen. Free is the exception:
  // it shakes each item where it stands, and flying to fit the whole board
  // afterwards would move things on screen far more than the shake did -
  // hiding the change inside a much larger one.
  if (whole && (mobile || board.arrangement !== 'free')) vp!.fit(board.items, 80, travelMs());
}

// ---------------------------------------------------------------------------
// Nudge
// ---------------------------------------------------------------------------

/** Most clearance a nudge leaves between cards. Spacing is a layout's rule,
 *  and a wide one would turn a nudge into a spread. */
const NUDGE_GAP_MAX = 24;

/**
 * Push every card off whatever it overlaps by as little as it takes, keeping
 * the board's shape - unlike Rearrange, which lays it out anew.
 *
 * The same followers as rearrange(): a stuck note rides its host, a locked card
 * stands still and is cleared off, and a fence is one object to its siblings.
 * Inside a fence its contents are nudged among themselves first, innermost
 * fence first, and a fence they no longer fit in grows to hold them - so the
 * box its parent then clears is the one it will really have. A fence never
 * shrinks, and a locked one never grows.
 */
export function nudgeBoard() {
  if (board.layoutMode === 'mobile') { toast('The feed never overlaps'); return; }
  const items = board.items.filter(it => it.type !== 'ghost' && !isRider(it));
  if (items.length < 2) { toast('Nothing on this board overlaps'); return; }
  const step = baseStep();
  const snap = !!board.settings.snap;
  const gap = snap ? 0 : Math.min(board.settings.spacing, NUDGE_GAP_MAX);

  // Read once, before anything moves - fenceOf() measures live geometry.
  const parentOf = new Map(items.map(it => [it.id, fenceOf(it)?.id ?? null]));
  const groups = new Map<string | null, Item[]>();
  for (const it of items) {
    const p = parentOf.get(it.id) ?? null;
    (groups.get(p) || groups.set(p, []).get(p)!).push(it);
  }
  const depth = (id: string | null): number => {
    let d = 0;
    for (let at = id; at; at = parentOf.get(at) ?? null) d++;
    return d;
  };
  // Live boxes as the solve goes: a fence's carry moves its contents by the
  // same amount, so the levels below it stay solved.
  const box = new Map(items.map(it => [it.id, { x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot }]));
  const carry = (id: string, dx: number, dy: number) => {
    for (const child of groups.get(id) || []) {
      const b = box.get(child.id)!;
      b.x += dx; b.y += dy;
      if (isFence(child)) carry(child.id, dx, dy);
    }
  };
  const solveBox = (it: Item) => {
    const b = box.get(it.id)!;
    const room = snap ? latticeBox(b, step) : b;
    const { hw, hh } = rotatedExtents({ ...room, rot: b.rot });
    // The lattice box can sit off the card's own centre; it is solved there
    // and the card takes the same move.
    return { x: room.x, y: room.y, w: 2 * hw, h: 2 * hh, fixed: isLocked(it) };
  };
  const solve = (members: Item[]) => {
    const boxes = members.map(solveBox);
    const out = nudgeApart(boxes, { gap, step: snap ? step : 0 });
    members.forEach((it, k) => {
      const dx = out[k].x - boxes[k].x, dy = out[k].y - boxes[k].y;
      if (!dx && !dy) return;
      const b = box.get(it.id)!;
      b.x += dx; b.y += dy;
      if (isFence(it)) carry(it.id, dx, dy);
    });
  };

  const fences = [...groups.keys()].filter((id): id is string => id !== null)
    .sort((a, b) => depth(b) - depth(a));
  for (const id of fences) {
    const members = groups.get(id)!;
    solve(members);
    const fence = byId(id);
    if (!fence || isLocked(fence)) continue;
    const f = box.get(id)!;
    const need = fenceBox(null, itemBounds(members.map(m => box.get(m.id)!)), step);
    if (!need) continue;
    const x0 = Math.min(f.x - f.w / 2, need.x - need.w / 2), x1 = Math.max(f.x + f.w / 2, need.x + need.w / 2);
    const y0 = Math.min(f.y - f.h / 2, need.y - need.h / 2), y1 = Math.max(f.y + f.h / 2, need.y + need.h / 2);
    Object.assign(f, { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 });
  }
  solve(groups.get(null) || []);

  const changed = items.filter(it => {
    const b = box.get(it.id)!;
    return b.x !== it.x || b.y !== it.y || b.w !== it.w || b.h !== it.h;
  });
  if (!changed.length) { toast('Nothing on this board overlaps'); return; }
  const riders = board.items.filter(isRider);
  // SAFETY: as in rearrange() - see GeomRow.
  const before = snapshotGeom([...changed, ...riders].map(it => it.id)) as GeomRow[];
  const seen = seenPlaces(before.map(g => g.id));
  applyGeom(changed.map(it => {
    const b = box.get(it.id)!;
    return { id: it.id, x: b.x, y: b.y, w: b.w, h: b.h };
  }));
  // Each rider follows its host at the offset it had, in passes so a note on a
  // note waits for its own host - the same walk rearrange() makes.
  const beforeById = new Map(before.map(g => [g.id, g]));
  const pending = new Set(riders.map(r => r.id));
  for (let grew = true; grew && pending.size;) {
    grew = false;
    for (const note of riders) {
      if (!pending.has(note.id)) continue;
      const host = stuckTo(note);
      if (!host) { pending.delete(note.id); continue; }
      if (pending.has(host.id)) continue;
      const pos = stuckPlacement(beforeById.get(note.id) || note, beforeById.get(host.id) || host, host);
      applyGeom([{ id: note.id, x: pos.x, y: pos.y }]);
      pending.delete(note.id);
      grew = true;
    }
  }
  const done = commitGeom('Nudge board', before, changed.map(it => it.id));
  if (done) toast(`Nudged ${changed.length} item${changed.length === 1 ? '' : 's'} apart`, '', undoAction());
  slideFrom(seen, travelMs());
}

/** The centre of what a set of items covers. */
function middleOf(items: Item[]) {
  // itemBounds() answers null for an empty list and only for that; the one
  // caller has already returned when its list is empty.
  const b = itemBounds(items)!;
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
}
