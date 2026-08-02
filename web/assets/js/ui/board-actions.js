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

import { toast, shuffle } from '../util.js';
import { formatLength, scaleFrom, MM_PER_INCH } from '../measure.js';
import { ask } from './dialog.js';
import {
  board, bus, selection, setSetting, byId,
  snapshotGeom, applyGeom, commitGeom, baseStep,
  recheckBoardGeometry, placeMobileItems,
  isRider, stuckTo, stuckPlacement,
} from '../state.js';
import { latticeBox, itemBounds } from '../geometry.js';
import { travelMs } from '../canvas/viewport.js';
import { paintGrid, resetGridInk } from '../canvas/grid.js';
import { paintGrain } from '../canvas/grain.js';
import { paintPaper } from '../canvas/paper.js';
import { paintMobileFrame } from '../canvas/mobile-frame.js';
import { resetItems } from '../canvas/items.js';
import { resetModels, resetModelInk } from '../canvas/model.js';
import { flushNoteEdit, noteFloor } from '../canvas/notes.js';
import { getAsset } from '../storage/assets.js';
import { saveBoard, exportBoard, autosave, clearAllData } from '../storage/storage.js';
import { defaultSize, measureSize } from '../canvas/renderers.js';
import { arrange, mobileOrder } from '../arrange/arrangements.js';
import { syncBoardMode } from './board-view.js';

let vp = null;

export function initBoardActions(viewport) {
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
  } finally {
    saving = false;
  }
  // A failure is not a save and there is nothing to stand down from. Whatever
  // went wrong is worth another try immediately - it may be a permission that
  // has just been granted.
  if (!ok) { paintSave(); return; }
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
  const btn = document.querySelector('[data-cmd="save"]');
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
  const btn = document.querySelector('[data-cmd="clear-data"]');
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
  const items = board.items.filter(i => selection.has(i.id));
  if (!items.length) return;

  const step = baseStep();
  const sized = await Promise.all(items.map(async it => {
    const blob = getAsset(it.asset?.hash)?.blob;
    // measureSize only reads the file for the two types with an aspect of their
    // own; everything else answers from the type alone, so a card whose bytes
    // have gone still resets.
    const size = blob
      ? await measureSize(it.type, blob).catch(() => defaultSize(it.type))
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

  const before = snapshotGeom(items.map(i => i.id));
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
  resetGridInk();
  resetModelInk();
  resetModels();
  resetItems();
  syncBoardMode();
  bus.emit('items');
  bus.emit('selection');
  bus.emit('settings', 'reload');
  paintGrid(vp);
  paintGrain(vp);
  paintPaper();
  paintMobileFrame();
  vp.apply();
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
export async function restartApp() {
  flushNoteEdit();
  if (!(await autosave())) {
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
 */
export function rearrange(items) {
  if (!items.length) return;
  const whole = items.length === board.items.length;
  const mobile = board.layoutMode === 'mobile';

  // A stuck note is not laid out; it rides its host to the host's new slot and
  // keeps its place on it. So a pinned sticky stays pinned through a Rearrange,
  // and a note whose host is not in this set rides a host that does not move -
  // and so does not move either. Everything else is arranged as before.
  // The title card takes a slot like any other: Rearrange gives it a place in
  // the layout and sizes it to the lattice on a snapped board, so cards no
  // longer land on top of it and it moves with the rest.
  const riders = items.filter(isRider);
  const free = items.filter(it => !isRider(it));
  const beforeAll = snapshotGeom(items.map(i => i.id));
  // Nothing to lay out - the whole set was followers. There is no arrangement of
  // riders alone; they stay on their hosts.
  if (!free.length) return;

  const at = whole ? { x: 0, y: 0 } : middleOf(free);
  const before = snapshotGeom(free.map(i => i.id));
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
  const sized = snapDesktop
    ? free.map(it => { const b = latticeBox(it, step); return { w: b.w, h: b.h }; })
    : null;
  const laid = order.map(i => (sized ? { ...free[i], ...sized[i] } : free[i]));
  const seed = (Math.random() * 0xffffffff) >>> 0;

  let placed;
  if (mobile) {
    // A column has no slots to deal, so none of the above applies: the packer
    // decides where every card goes and the arrangement decides only what order
    // it meets them in. `free` rather than `laid`, and that is the point of the
    // fork - the shuffle above exists to re-deal a set of 2D slots, and dealt
    // into a Mobile order it would scramble the very sequence the order just
    // chose. See MOBILE_ARRANGEMENTS in arrange/arrangements.js.
    placed = mobileOrder(free, { name: board.arrangement, seed });
    const moving = new Set(free.map(item => item.id));
    // Riders are not obstacles - they overlap their host and would wall it off.
    const obstacles = whole ? [] : board.items.filter(item =>
      !moving.has(item.id) && !isRider(item));
    // Rearrangement changes order and position, not the sizes already visible
    // on this layout. In particular, do not rebuild them from meta.presnap:
    // that is the geometry to restore when snapping is disabled, not a sizing
    // source for every later press of Rearrange.
    placed = placeMobileItems(placed, obstacles, { preserveSize: true });
  } else {
    const spots = arrange(laid, {
      name: board.arrangement,
      center: at,
      spacing: board.settings.spacing,
      // Snapping reserves whole cells so the per-item lattice snap below cannot
      // round two tight cards into an overlap - see arrange()/toCells.
      cellStep: snapDesktop ? step : 0,
      seed,
    });
    placed = laid.map((item, slot) => ({
      ...item,
      x: spots[slot].x,
      y: spots[slot].y,
    }));
  }
  // spots came back in shuffled order, so each one goes to the item that was
  // in that slot, not to the item at the same index in board.items.
  const target = new Array(free.length);
  if (mobile) {
    const byItem = new Map(placed.map(item => [item.id, item]));
    free.forEach((item, i) => { target[i] = byItem.get(item.id); });
  } else {
    order.forEach((itemIndex, slot) => { target[itemIndex] = placed[slot]; });
  }
  applyGeom(before.map((g, i) => {
    const at = {
      ...g,
      x: target[i].x,
      y: target[i].y,
      ...(mobile ? {
        w: target[i].w,
        h: target[i].h,
        rot: target[i].rot,
        presnap: target[i].meta?.presnap
          ? { ...target[i].meta.presnap }
          : null,
      } : {}),
    };
    if (!sized) return at;
    // Through latticeBox a second time, now with the slot the engine chose and
    // the size it laid out for. The sizes are already on the lattice and it
    // leaves them there; what this pass is for is the position, which an
    // arrangement had no reason to land on a line.
    return { ...at, ...latticeBox({ ...at, ...sized[i] }, step) };
  }));

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
        const hostSrc = beforeById.get(host.id) || byId(host.id);
        const pos = stuckPlacement(note, hostSrc, byId(host.id));
        applyGeom([{ id: note.id, x: pos.x, y: pos.y }]);
        pending.delete(note.id);
        grew = true;
      }
    }
  }

  // driven = the free items only. Each was placed, none towed, so each of those
  // notes asks again what it landed on. Riders are left out on purpose: they kept
  // their host, so re-measuring them onto whatever they now sit beside would be
  // the one thing that could tear a pinned pile apart.
  commitGeom(whole ? 'Rearrange' : `Rearrange ${items.length} items`,
    beforeAll, free.map(g => g.id), mobile ? { preservePresnap: true } : {});
  // A whole-board layout rebuilds around the origin, so the view has to follow
  // it there or the rearrangement happens off screen. Free is the exception:
  // it shakes each item where it stands, and flying to fit the whole board
  // afterwards would move things on screen far more than the shake did -
  // hiding the change inside a much larger one.
  if (whole && (mobile || board.arrangement !== 'free')) vp.fit(board.items, 80, travelMs());
}

/** The centre of what a set of items covers. */
function middleOf(items) {
  const b = itemBounds(items);
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
}
