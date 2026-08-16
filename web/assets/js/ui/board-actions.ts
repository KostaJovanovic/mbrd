// The commands that needed more than a one-liner.
//
// Everything `cmds` delegates to rather than inlines: the save button's
// cooldown, "Reset size", the three-press guard in front of Clear everything,
// Rearrange, Reload board, Restart, and Scale from item. They were the second
// half of main.js and they belong together for one reason - each is a whole
// small policy about a single control, written down where the control's
// behaviour can be read in one sitting rather than inferred from a handler.
//
// Nothing here is wired to an element. These are called by commands.js, and the
// two paint functions are called by their own state machines. `vp` is handed in
// by initBoardActions() so nothing touches a browser global at import time.
//
// ── This was a second wiring point, and it is narrower now ──
//
// Worth knowing before adding to it. main.ts is the wiring point by design and
// says so; this file used to reach into ten different modules under canvas/ from
// a module in ui/, which was the widest reach anywhere in that directory and
// wider than main.ts's own. That was not an accident of growth - it is what
// these commands are. Reset size has to ask the renderers what a default size
// is; Scale from item has to reach the asset registry. Each import is the
// shortest honest path from one control to the thing it changes.
//
// The one that was not was the ground. A Rearrange has to settle the geometry
// and then repaint the grid, the grain, the paper outline and the Mobile frame,
// and something had to hold the knowledge of which four - which meant this file
// held it, and so did main.ts, in the same order, copied. That is
// canvas/ground.ts now: repaintGround() and forgetLookInk(), two calls where
// there were seven imports and two hand-kept sequences, and the reach is seven
// canvas/ modules rather than ten.
//
// So the rule this header used to end on still stands, one module further out:
// before importing an eighth canvas/ module, check whether what you want is
// something canvas/ should be answering in one call.

import { shuffle, isRecord } from '../util.ts';
import { toast } from '../notify.ts';
import { cue } from '../cuelume/engine.ts';
import { formatLength, scaleFrom, MM_PER_INCH } from '../measure.ts';
import { ask } from './dialog.ts';
import {
  board, bus, selection, setSetting, byId,
  snapshotGeom, applyGeom, commitGeom, baseStep,
  recheckBoardGeometry, placeMobileItems,
  isRider, stuckTo, stuckPlacement, isFence, isLocked, fenceOf, fenceBox,
  declareOp,
  type GeomPatch,
} from '../state.ts';
import { latticeBox, itemBounds, rotatedExtents } from '../geometry.ts';
import { travelMs } from '../canvas/viewport.ts';
// The four layers under the cards, and the three caches they resolve out of the
// look - one call each, rather than the seven imports and two hand-copied
// sequences that used to be here. See the head of canvas/ground.ts.
import { repaintGround, forgetLookInk } from '../canvas/ground.ts';
import { barHeight, resetItems } from '../canvas/items.ts';
import { resetWeb } from '../canvas/web.ts';
import { resetModels } from '../canvas/model.ts';
import { flushNoteEdit, noteFloor } from '../canvas/notes.ts';
import { getAsset } from '../storage/assets.ts';
import { saveBoard, exportBoard, autosave, clearAllData } from '../storage/storage.ts';
import { defaultSize, measureSize } from '../canvas/renderers.ts';
import { arrange, mobileOrder } from '../arrange/arrangements.ts';
import type { Obstacle } from '../arrange/arrangements.ts';
import { syncBoardMode } from './board-view.ts';
import type { Item, Geometry } from '../board-model.ts';
import type { Point } from '../geometry.ts';
import type { Viewport } from '../canvas/viewport.ts';

/**
 * canvas/viewport.ts still carries its migration pragma, so the class type it
 * exports has the methods but not the fields the constructor assigns - the same
 * intersection ui/hud.ts and ui/fence-prompt.ts make, for the same reason. These
 * are the fields the ground's painters read off the viewport this module hands
 * repaintGround(); the intersection comes out the day that module is annotated.
 */
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

/**
 * One row of a geometry snapshot, as snapshotGeom() actually answers.
 *
 * layout.ts still carries its migration pragma too, and there the loss is not
 * fields a constructor assigned but fields a *loop* did: the six geometry keys
 * are copied in by iterating GEOM_KEYS, which publishes none of them, so tsc
 * infers the row as `{ id }` alone and the array as possibly holding nulls -
 * which the function's own trailing .filter(Boolean) has already removed. This
 * names what is really there. It comes out the day layout.ts is annotated.
 *
 * SAFETY: this covers the three `as GeomRow[]` below, which are one claim said
 * three times - that snapshotGeom() fills in the six geometry keys and returns
 * no nulls. Both halves are read off its body, not assumed: the keys come from
 * the GEOM_KEYS loop and the nulls from its own filter.
 */
type GeomRow = Omit<Geometry, 'presnap'> & {
  presnap: { x: number, y: number, w: number, h: number } | null;
  loose: boolean;
};

/** The four options rearrange() takes - see the note above it. */
type RearrangeOptions = {
  /** the layout, overriding the board's own */
  name?: string;
  /** where to lay out about, overriding the two rules rearrange() states */
  center?: Point;
  /** a fence id to close around the result, inside the same commit */
  enclose?: string;
  /** the undo entry's label, overriding the one rearrange() picks */
  label?: string;
};

// Non-null asserted at every use below rather than guarded: main.ts calls
// initBoardActions() before any command can run, so a null here would be a
// wiring bug and not a state to write a fallback for.
let vp: ActionsViewport | null = null;

export function initBoardActions(viewport: ActionsViewport) {
  vp = viewport;
}

// ---------------------------------------------------------------------------
// Save, and the cooldown in front of it
// ---------------------------------------------------------------------------

/**
 * Save, then stand down for half a minute.
 *
 * Saving writes the whole board - every asset, every note - into IndexedDB, and
 * on a board of photographs that is real work. The button invites repetition in
 * a way the work does not deserve: it is the one control whose effect is
 * invisible, so the honest response to "did that save?" is to press it again,
 * and a few of those in a row is the same megabytes written three times while
 * the board stutters.
 *
 * A cooldown answers the question the second press was asking. The button says
 * how long ago it saved, which is the information that was missing - not a
 * refusal so much as a receipt that stays up.
 *
 * Only the button. The autosave debounce behind every edit is untouched: that
 * is the board's own safety net and rate-limiting it would be rate-limiting the
 * thing that stops work being lost. This governs a human pressing a control,
 * which is the only place repetition is a problem.
 */
const SAVE_COOLDOWN_MS = 30_000;
let saveReadyAt = 0;
let saveTick = 0;
let saving = false;

export async function saveWithCooldown() {
  // Two guards, not one. The cooldown is the deliberate half; `saving` covers
  // the gap the cooldown cannot, which is the double click that arrives while
  // the first write is still in flight and before there is anything to cool
  // down from.
  if (saving || saveReadyAt > Date.now()) return;
  saving = true;
  paintSave();
  let ok = false;
  try {
    ok = await saveBoard();
  } catch (err) {
    // A rejection is a failed save, not a broken button.
    //
    // There was no catch, and the shape of the damage is worth writing down:
    // `finally` cleared `saving`, the throw then skipped every line after it,
    // and the button was left disabled reading "Saving..." with no saveTick
    // interval to repaint it - for the rest of the session, on the one control
    // that stops work being lost. Plus an unhandled rejection in the console
    // saying nothing about where it came from.
    //
    // That saveBoard() can reject is not hypothetical: runSaves() in
    // storage/session.ts has try/finally and no catch, and four call sites
    // around it defend against exactly this.
    console.warn('[mbrd] save failed', err);
    ok = false;
  } finally {
    saving = false;
  }
  // A failure is not a save and there is nothing to stand down from. Whatever
  // went wrong is worth another try immediately - it may be a permission that
  // has just been granted.
  if (!ok) { paintSave(); return; }
  // The one thing in the app worth a sound of its own that is not a change to
  // the board: work is safe. Whatever saveBoard() toasted says the same thing a
  // beat later and says so on top of this, which is two things having happened.
  cue('done');
  saveReadyAt = Date.now() + SAVE_COOLDOWN_MS;
  clearInterval(saveTick);
  saveTick = setInterval(paintSave, 1000);
  paintSave();
}

/** Back to an ordinary Save button, cooldown abandoned. Used by a board load. */
export function resetSave() {
  saveReadyAt = 0;
  clearInterval(saveTick);
  saveTick = 0;
  paintSave();
}

function paintSave() {
  // A `data-cmd` is always on a button: the toolbar's are `<button data-cmd>` in
  // index.html and the panel's are made by buildButtons() in ui/panel.ts, which
  // sets the attribute on a <button> it just created. Same for paintClear().
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
  // Counting up rather than down, because what somebody wants to know is how
  // stale the save is, not how long until a button will let them press it.
  btn.textContent = `Saved ${SAVE_COOLDOWN_MS / 1000 - left}s ago`;
  btn.title = 'Everything is already written. Edits keep saving on their own.';
}

// ---------------------------------------------------------------------------
// Clear everything - the countdown in front of the dialog
// ---------------------------------------------------------------------------

/**
 * Presses left before "Clear everything" asks its real question, and how long
 * a half-finished countdown survives.
 *
 * The button wipes the browser's copy of the board, everything in it and the
 * look with it, and it sits in the same panel as Save and Optimize, a row away
 * from buttons that are safe to press out of curiosity. A confirmation dialog
 * on the first press is not much of a gate either: a dialog that appears is a
 * dialog that gets dismissed, and the one that matters looks like all the
 * others. So the press is spent before the question is asked - three of them,
 * counted down on the button's own face, and the fourth opens the dialog.
 *
 * Ten seconds of quiet puts it back. Somebody who armed it and walked away has
 * not half-agreed to anything, and coming back to a button already holding "1"
 * would be the worst state this could leave behind.
 */
const CLEAR_PRESSES = 3;
const CLEAR_IDLE_MS = 10000;

let clearLeft = 0;
let clearTimer = 0;

/**
 * One press of "Clear everything": count it, and open the dialog once the
 * countdown is spent.
 */
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

/** Back to an ordinary button, countdown abandoned. */
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
  // The number is presses remaining, not a clock: a countdown in seconds would
  // be a button that fires itself, which is the one thing this must never do.
  btn.textContent = `Press ${clearLeft} more time${clearLeft === 1 ? '' : 's'}`;
  btn.title = 'Then it will ask, and then it will wipe this browser’s copy.';
  btn.dataset.arming = '';
}

// ---------------------------------------------------------------------------
// Size, scale, and putting the board back together
// ---------------------------------------------------------------------------

/**
 * Every selected item back to the size it came in at.
 *
 * The size an item is *born* at, which is not its file's pixel dimensions:
 * measureSize() gives each type a standard area and lets the media supply only
 * the aspect, so a 6000px photograph and a 400px one arrive as cards of the
 * same weight and the board stays a board. Reproducing that here rather than
 * remembering it on the item is what makes this survive a `.mbrd` written by an
 * older version, and what stops a second field having to be kept true through
 * every crop, cover swap and optimise.
 *
 * Centres and rotations are kept. A reset is an answer to "I dragged this
 * corner and now it is wrong", and moving the card while fixing its size would
 * be answering a question nobody asked.
 *
 * Measured from the bytes, so it is asynchronous, and the whole selection is
 * measured before anything moves: half a group resized is not a state the board
 * should be seen in, and it would be one undo step per item to get out of.
 */
export async function resetSize() {
  // Fences sit this one out. "Reset size" restores the size a card was born at,
  // and a fence was born at whatever size it was drawn - it has no natural one,
  // because its size *is* what it means. Handing it a default would shrink a
  // region down to a small box and drop everything in it, which is the same
  // silent loss the resize grips now floor against; there is no floor to apply
  // here, since the whole action is "go back to a size of your own".
  // And so does anything locked: this writes w and h, which is geometry, and a
  // lock is a promise about geometry whatever the route to it.
  const items = board.items.filter(i => selection.has(i.id) && !isFence(i) && !isLocked(i));
  if (!items.length) return;

  const step = baseStep();
  const sized = await Promise.all(items.map(async it => {
    const blob = getAsset(it.asset?.hash)?.blob;
    // measureSize only reads the file for the two types with an aspect of their
    // own; everything else answers from the type alone, so a card whose bytes
    // have gone still resets.
    // The asset store keeps a Blob and measureSize() asks for a File. Safe
    // because the two members it reads that a Blob does not carry are read
    // defensively: `file.name` only ever reaches extOf(), whose parameter
    // defaults to '' for exactly this, and only after `file.type` - which every
    // Blob has, and which putAsset() fills from the file it was made of - has
    // already answered for an SVG. Nothing is constructed here to make the types
    // agree, because that would be a different measurement.
    //
    // SAFETY: measureSize() takes a File because that is what the import path
    // hands it; what it actually reads is the Blob half - bytes and a type -
    // and a File is a Blob with a name. Nothing here reads the name.
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
 * constraints, cached model renderings, and geometry that no longer agrees
 * with an enabled snap lattice.
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
  // See resetWeb().
  resetWeb();
  syncBoardMode();
  bus.emit('items');
  bus.emit('selection');
  bus.emit('settings', 'reload');
  repaintGround(vp!);
  vp!.apply();
  toast('Board reloaded');
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
  location.reload();
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
 * Lay `items` out again under the board's current arrangement.
 *
 * The whole board or a selection of it, and the difference is more than which
 * ids move. A rearrangement of everything is entitled to rebuild the board
 * around the origin and fly the view to it, because there is nothing else on
 * the board to be in the way. A rearrangement of nine cards is not: those nine
 * are somewhere for a reason, the rest of the board is around them, and hauling
 * them to 0,0 would be a move you did not ask for wearing a layout's clothes.
 * So a subset is relaid about its own centre and covers its own ground, and the
 * view stays where it is - the cards rearrange in front of you, which is the
 * plainest feedback there is and the reason a Fit would only get in the way.
 *
 * Four options, three of them a region's (see cmds.rearrangeFence):
 *
 *   name     the layout, overriding the board's own. A region gets masonry
 *            whatever the board is set to, because the board's arrangement is a
 *            statement about the board.
 *   center   where to lay it out about, overriding the two rules above. A
 *            region is relaid about *itself*, not about the middle of whatever
 *            happens to be in it - the region is the thing that is staying put.
 *   enclose  a fence id to close around the result, inside the same commit. The
 *            layout is not bounded by anything, so its block can come out wider
 *            or narrower than the region it was made for; a region that ended up
 *            not holding its own contents would then have them measured out of
 *            it. So the rectangle follows the cards, which is also the shape a
 *            fence is made with in the first place - see fenceBox().
 *   label    the undo entry's words, overriding the ones picked below. The
 *            fourth, and it was in neither of the two places this option set is
 *            written down - the type said three and so did this list, while the
 *            field sat between them.
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
  // The title card takes a slot like any other: Rearrange gives it a place in
  // the layout and sizes it to the lattice on a snapped board, so cards no
  // longer land on top of it and it moves with the rest.
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
  // The seed changes where the slots are (see arrangements.js). Without it the
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
    // chose. See MOBILE_ARRANGEMENTS in arrange/arrangements.js.
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
        // Non-null: `host` came back from stuckTo(), which only ever names an
        // item that is on the board this instant.
        const hostSrc = beforeById.get(host.id) || byId(host.id)!;
        const pos = stuckPlacement(note, hostSrc, byId(host.id)!);
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
    const box = fenceBox(null, itemBounds(items.map(i => byId(i.id)).filter(it => !!it)), step);
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
