// Multi-step board commands delegated from commands.ts: save cooldown,
// reset size, clear-everything guard, rearrange, reload, restart, scale.
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
  declareOp,
  type GeomPatch,
} from '../state.ts';
import { latticeBox, itemBounds, pictureShape, rotatedExtents } from '../geometry.ts';
import { travelMs } from '../canvas/viewport.ts';
import { repaintGround, forgetLookInk } from '../canvas/ground.ts';
import { barHeight, resetItems } from '../canvas/items.ts';
import { resetWeb } from '../canvas/web.ts';
import { resetModels } from '../canvas/model.ts';
import { flushNoteEdit, noteFloor } from '../canvas/notes.ts';
import { getAsset } from '../storage/assets.ts';
import { saveBoard, exportBoard, autosave, clearAllData } from '../storage/storage.ts';
import { defaultSize, measureSize, pictureRatio, fitMode } from '../canvas/renderers.ts';
import { arrange, mobileOrder } from '../arrange/arrangements.ts';
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
  enclose?: string;
  label?: string;
};

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
    const { w } = size;
    let { h } = size;
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
 * The boxes that bring photo and video cards to their pictures' proportions,
 * for Fit: the shorter side stays and the longer follows (pictureShape in
 * geometry.ts). Centres and turns stay, as Reset size keeps them. Only cards
 * whose box changes come back, as whole rows for applyGeom().
 *
 * Desktop only. The Feed already draws a Fit tile at its picture's shape
 * (ratioOf in ui/feed.ts), and the Mobile board is a packed grid, where a card
 * that grows lands on its neighbours. Anchored cards keep their size, as they
 * do under Reset size.
 *
 * One card at a time on purpose: each is a decode, and a whole board of them
 * at once would hold every picture in memory together.
 */
export async function fitShapes(items: Item[]): Promise<GeomPatch[]> {
  if (board.layoutMode === 'mobile') return [];
  const sizes = new Map<string, { w: number, h: number }>();
  for (const it of items) {
    if (isLocked(it)) continue;
    const ratio = await pictureRatio(it);
    // Read again after the wait, which can let the card move, resize or go.
    const live = byId(it.id);
    if (!ratio || !live) continue;
    const shape = pictureShape(live, ratio);
    const box = board.settings.snap ? latticeBox({ ...live, ...shape }, baseStep()) : shape;
    const w = Math.round(box.w), h = Math.round(box.h);
    if (w !== live.w || h !== live.h) sizes.set(live.id, { w, h });
  }
  // Built after the last wait, so every row holds where each card is now.
  // presnap goes on a snapped board, as commitGeom() drops it for a resize:
  // the memo holds the card's old shape.
  const snap = board.settings.snap;
  return snapshotGeom([...sizes.keys()]).map(g => ({
    ...g, ...sizes.get(g.id), presnap: snap ? null : g.presnap,
  }));
}

/**
 * Every picture showing Fit, brought back to its own proportion. The repair half
 * of the Fill switch, and Reload board is where it runs.
 *
 * A Fit card is *meant* to be the shape of what it holds, and several things can
 * leave it something else: a corner dragged out of shape (free on the grid - see
 * lockAspect in canvas/input.ts), a picture whose bytes could not be measured
 * when it landed so adoptAspect() never fired, a board written by an older
 * version, a file replaced under a card that kept the old one's box. None of
 * those announce themselves; what you see is a picture with paper round it.
 *
 * `fitMode()` rather than the Fill switch's own filter: this asks what each card
 * is actually showing, so a single picture set to Fit on a Fill board is included
 * and one set to Fill on a Fit board is left alone.
 *
 * Idempotent, which is what makes it safe on a path somebody can press twice.
 * pictureShape() of a box that is already the picture's shape is that box, and on
 * a snapped board the lattice pass lands on the same cells a second time - so a
 * board that is already right records no step and says so by being silent.
 *
 * Deliberately not part of opening a board. It overrules a framing somebody may
 * have chosen by hand, and doing that uninvited, on every load, would be a repair
 * nobody asked for; here it is the button's whole job.
 */
async function refitPictures() {
  const showing = board.items.filter(it =>
    (it.type === 'image' || it.type === 'video') && fitMode(it) === 'contain');
  if (!showing.length) return;
  const rows = await fitShapes(showing);
  if (!rows.length) return;
  const before = snapshotGeom(rows.map(g => g.id));
  applyGeom(rows);
  // Undoable, unlike the rest of Reload board. The others put back a truth the
  // board had already agreed to; this one changes boxes, and a person who
  // framed a picture by hand must be able to say no.
  commitGeom('Fit photos & videos', before, rows.map(g => g.id));
  toast(rows.length === 1 ? 'One picture refitted' : `${rows.length} pictures refitted`);
}

/** Bumped by each press of the Fill switch, so a slow Fit cannot land after a later Fill. */
let mediaFitRun = 0;

/**
 * The board-wide Fill switch. Off brings every card that follows the board's
 * default to its picture's shape, in the same step as the switch, so one Undo
 * puts both back. On changes no box, because Fill crops to any shape.
 */
export async function setMediaFit(fill: boolean) {
  const run = ++mediaFitRun;
  const prev = board.mediaFit;
  if (fill || prev === 'contain') {
    setSetting('mediaFit', fill ? 'cover' : 'contain');
    return;
  }
  const followers = board.items.filter(i => (i.type === 'image' || i.type === 'video')
    && i.meta?.fit !== 'cover' && i.meta?.fit !== 'contain');
  const shape = await fitShapes(followers);
  if (run !== mediaFitRun) return;
  if (!shape.length) {
    setSetting('mediaFit', 'contain');
    return;
  }
  const before = snapshotGeom(shape.map(g => g.id));
  commit('Fit photos & videos',
    () => { setSetting('mediaFit', 'contain'); applyGeom(shape); },
    () => { setSetting('mediaFit', prev); applyGeom(before); });
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
  // board is rebuilt and usable while it runs, and it announces itself when it
  // lands - which is also why its toast is separate from this one.
  void refitPictures();
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
 * center, enclose (fence to resize around the result), label.
 *
 * This block used to sit above obstacleBox(), which was inserted underneath it
 * by a half-finished edit, so the function it documents had no documentation
 * and the one it did not had two.
 */
export function rearrange(items: Item[], options: RearrangeOptions = {}) {
  if (!items.length) return;
  const whole = items.length === board.items.length;
  const mobile = board.layoutMode === 'mobile';
  const enclosing = options.enclose ? byId(options.enclose) : null;

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
  // The region joins the snapshot when there is one, so closing it around the
  // result is inside the same undo entry as the layout that made it necessary.
  //
  // SAFETY: as above - see GeomRow.
  const beforeAll = snapshotGeom(
    enclosing ? [...items.map(i => i.id), enclosing.id] : items.map(i => i.id)) as GeomRow[];
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
  // it is the room the layout is happening in. That includes the one being
  // closed around the result, which is about to be resized to fit it - counting
  // it would push a region's own contents out of the region. Read here, with
  // parentOf above, because fenceOf() measures against live geometry.
  const around = new Set<string>();
  for (const it of items) {
    for (let f = fenceOf(it); f && !around.has(f.id); f = fenceOf(f)) around.add(f.id);
  }
  // Riders are never obstacles: a note sits on its host, so counting one would
  // wall off the card it is stuck to with a box that is already inside it.
  const anchored = board.items.filter(it =>
    held.has(it.id) && !isRider(it) && !around.has(it.id));

  const at = options.center ?? (whole ? { x: 0, y: 0 } : middleOf(free));
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
    });
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

  // The region closes around what it now holds, measured from where the cards
  // actually landed rather than from where the layout meant to put them - the
  // lattice pass and the rider pass both ran in between. A step of margin, the
  // same one a fence is drawn with, so the cards are inside it rather than flush
  // against it.
  //
  // Driven, unlike the carried contents: its edges are what membership means, so
  // a region that changed size is the one thing that has to ask again - the rule
  // commitGeom() already states for a resize.
  const closing: string[] = [];
  if (enclosing) {
    // items are already the live board items - see rearrange()'s signature - so
    // itemBounds() takes them directly rather than round-tripping through byId.
    const box = fenceBox(null, itemBounds(items), step);
    if (box) {
      applyGeom([{ id: enclosing.id, ...box, rot: enclosing.rot, z: enclosing.z }]);
      // Then again, with room at the top for the name. A fence's plate lies
      // across the top of its box, so a block closed to a step of margin puts
      // its first row under the region's own name - which is the one thing on a
      // fence you have to be able to read.
      //
      // Twice rather than once because the plate's height depends on the width
      // the region has just been given (the name is set at 2.8cqi of it), and the
      // write above is what makes that width real: 'geom' places nodes
      // synchronously, so the measurement below is of the plate that will
      // actually be drawn. Both writes land before the commit, so it is still
      // one undo.
      //
      // Only here, and not where a fence is *made*. There the rectangle is one
      // somebody drew, and taking it exactly as drawn is the promise fenceBox()
      // makes; here the cards were put where they are by this function a moment
      // ago, so where they sit under the plate is ours to answer for.
      const plate = barHeight(enclosing.id);
      if (plate > 0) {
        // World y points up, so the top edge is y + h/2: the extra height is all
        // added above, and nothing that was inside moves.
        applyGeom([{
          id: enclosing.id, x: box.x, y: box.y + plate / 2,
          w: box.w, h: box.h + plate, rot: enclosing.rot, z: enclosing.z,
        }]);
      }
      closing.push(enclosing.id);
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
  // Not declared for a region's rearrangement, and that is deliberate rather
  // than an omission: `enclose` closes a fence around the result inside the same
  // commit, so re-running the layout alone would move the cards and leave the
  // region where it was. A fence rearrangement stays sealed until the op carries
  // the enclosing too.
  if (!options.enclose) {
    declareOp('arrange', {
      ids: items.map(i => i.id),
      name: options.name || board.arrangement,
    });
  }
  commitGeom(options.label || (whole ? 'Rearrange' : `Rearrange ${items.length} items`),
    beforeAll, [...free.map(g => g.id), ...closing], mobile ? { preservePresnap: true } : {});
  // A whole-board layout rebuilds around the origin, so the view has to follow
  // it there or the rearrangement happens off screen. Free is the exception:
  // it shakes each item where it stands, and flying to fit the whole board
  // afterwards would move things on screen far more than the shake did -
  // hiding the change inside a much larger one.
  if (whole && (mobile || board.arrangement !== 'free')) vp!.fit(board.items, 80, travelMs());
}

/** The centre of what a set of items covers. */
function middleOf(items: Item[]) {
  // itemBounds() answers null for an empty list and only for that; the one
  // caller has already returned when its list is empty.
  const b = itemBounds(items)!;
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
}
