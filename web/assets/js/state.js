// Central board state + selection + command-based undo/redo.
//
// Everything that mutates the board goes through here and emits an event, so
// the renderer, HUD and sidebar stay in sync without knowing about each other.
//
// Events:
//   items      - the item list itself changed (add/remove/reorder)
//   geom       - existing items moved/resized (payload: array of ids)
//   item       - one item's content/name changed (payload: id)
//   selection  - the selection set changed
//   settings   - a setting changed (payload: key)
//   layout     - desktop/mobile geometry profile changed (payload: mode)
//   board      - a whole new board was loaded, or the title/dirty flag changed
//   trash      - something was thrown away, restored, or purged

import { clamp, emitter, uid, isFamily, isHash, itemHashes, toast } from './util.js';
// Pure geometry, shared with the canvas and the input layer so that "where is
// this item and what does it cover" has exactly one answer in this app. Kept
// at the top level rather than under canvas/ because it depends on nothing and
// belongs to no one layer - see geometry.js.
import {
  itemBounds, overlapFraction, latticeBox, cellInset, MIN_SIZE, MAX_SIZE,
} from './geometry.js';
// The board's link to real-world sizes. Pure arithmetic with no state of its
// own, at the same level as geometry.js and imported here for the same reason:
// the default belongs with the rest of the defaults, and the clamp has to run
// on every board that arrives from a file.
import { DEFAULT_SCALE, clampScale, PAPERS } from './measure.js';
import { splitAppearance, mergeAppearance } from './layout-settings.js';
// Downward: the catalogue is pure - geometry.js and nothing else - and this is
// the one thing state needs from it, which of the two lists a stored
// arrangement id belongs to. See tests/layers.test.js, where it is BASE.
import { mobileArrangement } from './arrange/arrangements.js';
// The floor this file stands on. Both were declared here until state.js was
// split; they are re-exported below under exactly their old names, because
// "state.js is the only door" is a rule about where mutations go and not about
// which file a symbol happens to be declared in. See board-store.js.
import { bus, selection, isDirty, markDirty, resetDirty } from './board-store.js';
import {
  commit, undo, redo, historyState, clearHistory,
} from './history.js';

export { bus, selection, isDirty, markDirty };
export { commit, undo, redo, historyState };

// The board's shape and its index, one level down - see board-model.js. The
// first group is re-exported because callers have always imported these from
// state.js; the second is this file's own working set, internals of the model
// that the mutation rules above them are written in terms of.
import {
  NOTE_MAX, DEFAULT_MOBILE_HEADER, DEFAULT_SETTINGS, BOARD_MODES, BOARD_TITLE_MAX,
  MOBILE_COLUMNS, MOBILE_COLUMN_OPTIONS, MOBILE_TOP_ROWS, MOBILE_MIN_ROWS,
  MOBILE_BOTTOM_ROWS, MOBILE_APPEARANCE_VARS, cleanBoardTitleDraft, cleanBoardTitle,
  defaultBoardTitle, isDefaultTitle, mobileColumnCount, board, TITLE_ID, byId,
  topZ, makeItem,
} from './board-model.js';
import {
  cloneSettings, layoutSettingsOf, settingsFor, defaultLayoutSettings,
  dedupeIds, MAX_ITEMS,
} from './board-model.js';

// Stuckness, one level down - see sticky.js. Questions about geometry; the
// mutations that act on their answers are here.
import {
  STICK_MIN, stuckTo, wouldStick, restick, forgetSticks, seedSticks,
  stuckPlacement, isRider, attachRiders, stuckFollowers,
} from './sticky.js';

// Where everything is - see layout.js. The Mobile pack, the two geometry
// profiles and the undoable geometry writes, which had to move as one piece
// because the pack and the profiles call each other.
import {
  SNAP_KEYS, activateLayoutSettings, applyGeom, baseStep, captureLayout, captureLayoutSettings, commitGeom, completeLayout, fitBoardMode, forgetPresnap, geometryOf, layoutMap, mobileBoardWidth, normalizeLayout, placeMobileItems, repackMobileBoard, snapshotGeom, usableMemo, writeLayout,
} from './layout.js';

// Z-order - see stacking.js. Sticky notes are ordered against their host rather
// than against the board, which is why this is not a sort by z.
export { raiseSelection, lowerSelection, stackOrder, visualStackOrder, stackLayerIds, selectionHasStackOverlap } from './stacking.js';

// Re-exported, not used here: these four are the layout module's public face
// and callers have always reached for them through state.js.
export {
  setBoardMode, mobileBoardTop, mobileBoardBottom, mobileBoardWorldWidth,
} from './layout.js';

export { baseStep, snapshotGeom, applyGeom, commitGeom, placeMobileItems, mobileBoardWidth };

export {
  STICK_MIN, stuckTo, wouldStick, restick, forgetSticks,
  stuckPlacement, isRider, stuckFollowers,
};

export {
  NOTE_MAX, DEFAULT_MOBILE_HEADER, DEFAULT_SETTINGS, BOARD_MODES, BOARD_TITLE_MAX,
  MOBILE_COLUMNS, MOBILE_COLUMN_OPTIONS, MOBILE_TOP_ROWS, MOBILE_MIN_ROWS,
  MOBILE_BOTTOM_ROWS, MOBILE_APPEARANCE_VARS, cleanBoardTitleDraft, cleanBoardTitle,
  defaultBoardTitle, isDefaultTitle, mobileColumnCount, board, TITLE_ID, byId,
  topZ, makeItem,
};



// The filename an asset first arrived under lives in the asset registry, which
// sits *above* state in the layering - storage depends on state, not the other
// way. So renameItem's oldest fallback is injected here rather than imported:
// main.js wires this to storage/assets.js at startup. Left unset - in a test,
// or before wiring - the fallback just skips to the item's current name, which
// is the same answer the registry gives for an asset it has never seen. See
// AUD-12.
let assetName = () => undefined;
export function setAssetNameLookup(fn) {
  assetName = typeof fn === 'function' ? fn : () => undefined;
}


// ---------------------------------------------------------------------------
// Item mutations (all undoable)
// ---------------------------------------------------------------------------

export function addItems(items, label = 'Add', options = {}) {
  // The stack is dealt here rather than left to makeItem().
  //
  // makeItem() defaults `z` to topZ() + 1, which reads the *live* board - and
  // the batch is not on it yet. So a group added in one call every one of them
  // read the same number and landed on a single layer. One flat layer is a
  // stacking order nobody chose, and two things went wrong on top of it:
  // duplicating a pile came back flat, defeating the sort in itemsIn() that
  // exists for exactly that reason, and stuckTo() - which needs a *strictly*
  // lower z - stopped recognising the pair. Copy a photo with a note on it and
  // the copied note was not stuck to the copied photo; it silently attached
  // itself to whatever else happened to be underneath.
  //
  // An explicit z is still honoured, because loadBoard() and the bin restore
  // items that already have one and must come back exactly where they were.
  let z = topZ();
  let added = items.map(partial =>
    makeItem(partial.z != null ? partial : { ...partial, z: ++z }));
  if (options.avoidOverlap && board.layoutMode === 'mobile') {
    added = placeMobileItems(added);
  } else {
    added = added.map(item => fitBoardMode(onLattice(item)));
  }
  commit(label,
    () => { const fresh = added.filter(a => !byId(a.id));
            board.items.push(...fresh);
            bus.emit('items', { added: fresh.map(a => a.id), removed: [] }); },
    () => { const ids = new Set(added.map(a => a.id));
            board.items = board.items.filter(i => !ids.has(i.id));
            ids.forEach(id => selection.delete(id));
            bus.emit('items', { added: [], removed: [...ids] }); bus.emit('selection'); },
    // Retains every item it added - a folder drop is the heavy case.
    added.length);
  return added;
}

/**
 * A new item laid on the lattice, if the board is snapped.
 *
 * Without this, snapping only governed items that were already on the board
 * when it was switched on, plus anything dragged afterwards - so a snapped
 * board grew a photograph at 320x240 sitting a few pixels off every line it was
 * meant to sit on, and the only way to line it up was to switch snapping off
 * and on again. Arriving is a placement like any other.
 *
 * Sizes as well as positions, because a box on the lattice that is not a whole
 * number of cells is only snapped along two of its four edges, and it is the
 * ragged right and bottom that a person actually sees.
 *
 * The presnap memo is what makes this reversible: unsnapAll() puts every item
 * carrying one back to the geometry it had before the lattice, and an imported
 * item that never had a life before the lattice would otherwise be stranded at
 * its snapped size when snapping is turned off. An existing memo is left alone
 * - a duplicated or pasted item brings its own, and it is a memo of life before
 * the *first* snap, not of the copy's.
 */
function onLattice(it) {
  if (!board.settings.snap) return it;
  const box = latticeBox(it, baseStep());
  if (box.x === it.x && box.y === it.y && box.w === it.w && box.h === it.h) return it;
  return {
    ...it,
    x: box.x, y: box.y, w: box.w, h: box.h,
    meta: it.meta?.presnap
      ? it.meta
      : { ...it.meta, presnap: { x: it.x, y: it.y, w: it.w, h: it.h } },
  };
}

/**
 * How many things the bin holds before the oldest start falling out the
 * bottom. A bin is a safety net, not an archive - and every entry pins its
 * asset's bytes into the saved file, so an unbounded one would quietly make a
 * board grow forever as you worked on it.
 */
const TRASH_LIMIT = 60;

export function removeItems(ids, label = 'Delete') {
  const set = new Set(ids);
  // Keep the original index so undo restores z-order position, not just the item.
  const removed = board.items
    .map((item, index) => ({ item, index }))
    .filter(r => set.has(r.item.id));
  if (!removed.length) return;
  // The Desktop title card does not go to the bin - it is a singleton the board
  // is meant to have, so it is hidden and offered back by its own restore button
  // (see ui/trash.js) rather than filed among thrown-away items. Only the rest
  // are binned; deleting the title also flips the flag, and undo flips it back.
  const titleGone = removed.some(r => r.item.type === 'title');
  const wasHidden = board.titleHidden;
  // Ghost cards are not binned either, for a different reason than the title
  // card: they are hints rather than anything of the user's, so a thrown-away
  // one is finished rather than filed. Deleting one by hand is a dismissal like
  // any other - see dismissGhosts() - and it does not come back.
  const binned = removed
    .filter(r => r.item.type !== 'title' && r.item.type !== 'ghost')
    .map(r => ({ item: r.item, at: Date.now() }));
  const binIds = new Set(binned.map(b => b.item.id));
  // What this delete pushed out the bottom of the bin, so undo can put it back.
  //
  // Truncating used to be a one-liner on the grounds that the entries falling
  // out are older than the delete and so belong to no undo entry being replayed
  // - which is true and beside the point. They were still in the bin before
  // this command ran and gone after it, which makes them part of what it did.
  // On a full bin, deleting one item and immediately undoing it left the bin
  // one entry short for good, and the entry that vanished was the oldest thing
  // in there: the one furthest past the point of being able to get it back any
  // other way.
  let evicted = [];
  commit(label,
    () => { board.items = board.items.filter(i => !set.has(i.id));
            set.forEach(id => selection.delete(id));
            if (titleGone) board.titleHidden = true;
            board.trash.unshift(...binned);
            evicted = board.trash.splice(TRASH_LIMIT);   // [] while under the limit
            bus.emit('items', { added: [], removed: [...set] });
            bus.emit('selection'); bus.emit('trash'); },
    () => { for (const r of removed) board.items.splice(r.index, 0, r.item);
            board.titleHidden = wasHidden;
            board.trash = board.trash.filter(t => !binIds.has(t.item.id));
            // Back on the end, which is where they were: the entries this
            // command added went on the front, and undo has just taken them off.
            board.trash.push(...evicted);
            evicted = [];
            bus.emit('items', { added: removed.map(r => r.item.id), removed: [] });
            bus.emit('trash'); },
    // Pins every removed item. Not the trash entries this evicts as well:
    // `evicted` is filled by the redo above, which commit() has not run yet
    // when this argument is evaluated - and it is bounded by TRASH_LIMIT
    // anyway, so counting it would change nothing worth the wrong number.
    removed.length);
}

/**
 * The Desktop title card: its fixed geometry and the two helpers that keep it a
 * singleton. Defined here, below the item plumbing, so it can lean on makeItem.
 */
// Four grid spaces wide at the default 64px grid step, and 3:2 tall (256 * 2/3
// = 170.67) - the Mobile masthead's own aspect (MOBILE_HEADER_ASPECT). The card
// visual is held to an exact 3:2 in CSS; this is the item's footprint. Snapping
// rounds it up to whole cells (4x3 = 256x192), and the card stays 3:2 and
// top-aligned inside, so the extra height falls as slack below it.
const TITLE_SIZE = Object.freeze({ w: 256, h: 171 });
// Top-centre, above where a fresh board's items land: x centres it (item x is
// the box centre), +y is up (world plane), so this sits the card over the origin.
// One grid space (64) higher than it first sat, to clear the content below it.
const TITLE_DEFAULT_POS = Object.freeze({ x: 0, y: 244 });

function makeTitleItem(at = null) {
  return makeItem({
    id: TITLE_ID,
    type: 'title',
    x: at?.x ?? TITLE_DEFAULT_POS.x,
    y: at?.y ?? TITLE_DEFAULT_POS.y,
    w: TITLE_SIZE.w,
    h: TITLE_SIZE.h,
  });
}

/**
 * Put the title card on the board if it belongs there and is missing. Board
 * hydration, not a user edit: no commit, no history - it runs on load and at
 * startup, the same way default settings are simply present. A board that threw
 * the card away (titleHidden) keeps it away.
 */
export function ensureTitleCard() {
  if (board.titleHidden) return;
  if (board.items.some(i => i.type === 'title')) return;
  board.items.push(makeTitleItem());
}

/** Whether the Desktop title card is currently thrown away (bin shows its button). */
export const isTitleHidden = () => !!board.titleHidden;

/**
 * Send the title card back to its default spot (top-centre). The card is a
 * movable singleton with no other way home short of deleting and restoring it,
 * so this is its "Reset size" - one undoable step, and a no-op if it is already
 * there. Uses the same geometry funnel a drag does, so it snaps and round-trips
 * like any move.
 */
export function resetTitlePosition() {
  const item = board.items.find(i => i.type === 'title');
  if (!item) return;
  if (item.x === TITLE_DEFAULT_POS.x && item.y === TITLE_DEFAULT_POS.y) return;
  const before = snapshotGeom([item.id]);
  applyGeom([{ id: item.id, x: TITLE_DEFAULT_POS.x, y: TITLE_DEFAULT_POS.y,
               w: item.w, h: item.h, rot: item.rot, z: item.z }]);
  commitGeom('Reset title position', before, [item.id]);
}

/**
 * Bring the title card back from its deleted state - the bin's restore button.
 * Undoable, unlike ensureTitleCard(): this is a user action, so it earns a
 * history step the way restoring a binned item does.
 */
export function restoreTitleCard(at = null) {
  if (!board.titleHidden && board.items.some(i => i.type === 'title')) return;
  const item = makeTitleItem(at);
  commit('Restore title',
    () => { board.titleHidden = false;
            if (!board.items.some(i => i.id === item.id)) board.items.push(item);
            bus.emit('items', { added: [item.id], removed: [] });
            bus.emit('trash'); },
    () => { board.titleHidden = true;
            board.items = board.items.filter(i => i.id !== item.id);
            selection.delete(item.id);
            bus.emit('items', { added: [], removed: [item.id] });
            bus.emit('selection'); bus.emit('trash'); });
}

/**
 * Ghost cards: the three hints a brand-new board opens with.
 *
 * A blank board cannot say what to do with itself, so it is handed three cards
 * that do - drop things here, drag to move around, add a note. The moment real
 * content arrives they leave, and that board never shows them again.
 *
 * They are furniture, not content, and the difference is enforced at exactly
 * three places rather than by a special case sprinkled everywhere:
 *
 *   1. serializeBoard() strips them, so no .mbrd ever carries one and the
 *      format does not have to learn the type;
 *   2. dismissGhosts() is hydration, not a command - no commit, no history -
 *      which is what makes their leaving survive an undo of the very import
 *      that triggered it;
 *   3. removeItems() does not bin them, the way it does not bin the title card.
 *
 * Everything else about a ghost is an ordinary card: it is selectable,
 * draggable, resizable and rotatable, its geometry travels in board.layouts,
 * and Mobile packs it into a column like anything else. That is deliberate -
 * the alternative was a separate overlay layer outside board.items, which
 * would have meant a second gesture pipeline beside canvas/input.js for the
 * sake of three cards.
 *
 * What each one *says* is not decided here. state.js has no business holding
 * user-facing prose, so an item carries only its key in meta.hint and
 * canvas/ghosts.js maps that to words and pixels.
 */
export const GHOST_IDS = Object.freeze([
  '__ghost_drop__', '__ghost_move__', '__ghost_note__', '__ghost_whimsy__',
]);

// The one hint that is a control rather than a sentence. Named here because the
// Mobile column orders itself around it; canvas/ghosts.js exports the same
// string as DIAL for the renderer, which is the layer that knows what it means.
const DIAL_HINT = 'whimsy';

// Keyed by id so the two stay in step, and ordered the way they are read.
//
// Every number here is a whole number of grid spaces at the default 64 step,
// and that is the point rather than a coincidence. A snapped board (which is
// what Harsh means on Desktop) lays a box on the lattice by rounding its sides
// to whole cells and its low edges to lines, so geometry that is *already*
// there survives the trip unchanged - the cards look the same snapped and
// unsnapped, and the layout below is the layout in both. Written at the sizes
// that fit a paragraph after rounding, not the sizes that read best before it:
// 216x144 rounded down to 187x123 and clipped its own copy.
//
// 4:3 rather than the title card's 3:2, because a card three cells tall is the
// smallest one the longest hint fits in. The title card snaps to 4x3 as well,
// so on the board that most people see the whole set matches anyway. Fixed
// rather than a starting size, since a ghost carries no resize grips (see
// setGrips in canvas/items.js); canvas/renderers.js defaultSize() names the
// same box.
//
// The positions sit below TITLE_DEFAULT_POS so a fresh board reads top to
// bottom: name, then the dial, then what to do. +y is up.
//
// They are a cascade rather than a row, and each one is placed against the two
// beside it rather than on a line: down and to the right from the drop card,
// past the dial, with the move card dropped below and back to the left. A row
// of three is a table of contents, and this is a board - the first thing it
// says about itself is that things sit where they were put. Every centre is
// still a whole number of grid spaces, so a snapped board keeps the
// arrangement exactly; see the note above.
//
// `mspan` and `mrows` are the box the same card takes on Mobile, where it is
// packed into a column rather than placed: a fraction of the board's width, and
// a whole number of grid rows. A fraction rather than a column count because
// the Mobile board is eight columns by default and six by setting, so "half the
// width" survives that change and "four cells" does not - at six columns it
// would be two thirds of the board and two cards would no longer sit side by
// side. Rows are cells outright, since the row height is the step either way.
const GHOSTS = Object.freeze([
  { id: GHOST_IDS[0], hint: 'drop', x: -320, y:   96, w: 256, h: 192, mspan: 0.5, mrows: 2 },
  { id: GHOST_IDS[1], hint: 'move', x:  -64, y: -160, w: 256, h: 192, mspan: 0.5, mrows: 2 },
  { id: GHOST_IDS[2], hint: 'note', x:  320, y:  -32, w: 256, h: 192, mspan: 0.5, mrows: 2 },
  // The odd one out: a control rather than a sentence, so it is 4:1 on Desktop -
  // four grid spaces by one. Parked under the title card and in the gap the
  // cascade leaves between the drop card and the note card: the title's lower
  // edge is at 158.5 (130.56 once the board is snapped) and this spans 0 to 64.
  //
  // On Mobile it takes the full width and two rows - the whole top of the column
  // over two half-width hints - so the one control on the board is the one card
  // that never shares a row.
  //
  // And untaped, because it is the one hint that stays an ordinary card at every
  // tier: a torn scrap is a fine thing to write on and a poor thing to mount a
  // working control in, and half a strip of tape across a slider is worse. The
  // rest of that decision is in app.css, which keeps the Softish page treatment
  // off this hint; the tape is the half that has to be refused here, since it is
  // rolled at minting rather than drawn from the tier.
  { id: GHOST_IDS[3], hint: 'whimsy', x: 0, y: 32, w: 256, h: 64,
    mspan: 1, mrows: 2, tape: false },
]);

/**
 * Where the strips of tape holding a hint down are stuck, at Softish.
 *
 * One or two per card, each straddling a different edge at an angle. Rolled
 * once, here, and carried in the item - *not* decided when the card is drawn.
 * canvas/items.js throws a culled card's node away and rebuilds it from nothing
 * when it comes back on screen, so a placement chosen at render time would put
 * the tape somewhere new every time the board panned past it. Random for each
 * board, and then fixed for that board's life.
 *
 * `pos` is a percentage along the chosen edge, kept well inside the corners so
 * a strip never hangs off one. `rot` is the angle it was pressed down at,
 * relative to that edge. Lengths are world px, the unit the card is sized in.
 *
 * `rand` is injectable so a test can pin the roll.
 */
const TAPE_EDGES = ['top', 'right', 'bottom', 'left'];

export function tapeFor(rand = Math.random) {
  // Two often enough to be a pattern, one often enough that the trio is not a
  // set of matching parcels.
  const count = rand() < 0.45 ? 2 : 1;
  const edges = [...TAPE_EDGES];
  const out = [];
  for (let i = 0; i < count; i++) {
    // Different edges, so two strips on one card never sit on top of each other.
    const edge = edges.splice(Math.floor(rand() * edges.length), 1)[0];
    out.push({
      edge,
      pos: Math.round(24 + rand() * 52),
      rot: Math.round((rand() * 18 - 9) * 10) / 10,
      len: Math.round(56 + rand() * 42),
    });
  }
  return out;
}

/** Whether the board holds anything the user put there. */
export function hasContent() {
  return board.items.some(i => i.type !== 'title' && i.type !== 'ghost');
}

/** Whether any ghost card is currently on the board. */
export const hasGhosts = () => board.items.some(i => i.type === 'ghost');

// Session-scoped and deliberately never written anywhere. Its whole job is the
// undo case: content arrives, the ghosts go, and undoing that import must not
// bring them back. A board:new clears it (a new board earns its hints again);
// a board:load sets it from whether the arriving board already has content.
let ghostsDismissed = false;

/**
 * Put the ghost cards on the board if it has earned them - board hydration, not
 * a user edit, so no commit and no history. Runs at startup and on load, the
 * same way ensureTitleCard() does and for the same reason.
 *
 * A board with any content at all, or one already dismissed this session, gets
 * nothing.
 */
export function ensureGhostCards() {
  if (ghostsDismissed || hasContent() || hasGhosts()) return;
  const step = baseStep();
  // Mobile is a column, and the layout above is a Desktop arrangement: four
  // cards spread across nine hundred world units, on a board 512 wide. Seeding
  // straight into it put two of them off the side of the frame entirely. So the
  // same fork addItems() makes for an import - pack them into the feed when
  // Mobile is the live layout, lay them on the lattice when Desktop is.
  //
  // It has to happen here rather than being left to the mode switch, because a
  // phone never makes that switch: it opens in Mobile, and completeLayout() only
  // fills in a profile that is *not* the live one. The hints are the one thing
  // on the board that can be born into a layout nobody switched to.
  if (board.layoutMode === 'mobile') {
    // Sized against the column rather than carried over from Desktop: the dial
    // takes the whole width, the hints half of it, and both are two rows tall.
    // placeMobileItems() takes it from here - it fits, packs and (if the Mobile
    // profile is snapped, which it is by default) lays each one on the lattice.
    const width = mobileBoardWidth(step);
    // The dial goes first, under the masthead, which is where it sits on Desktop
    // too - directly below the title card. The packer takes the order it is
    // given, and a stable sort keeps the three hints in reading order behind it.
    const order = [...GHOSTS].sort((a, b) =>
      Number(b.hint === DIAL_HINT) - Number(a.hint === DIAL_HINT));
    const fresh = order.map(g => makeItem({
      id: g.id, type: 'ghost', x: 0, y: 0, w: width * g.mspan, h: g.mrows * step,
      meta: { hint: g.hint, tape: g.tape === false ? [] : tapeFor() },
    }));
    board.items.push(...placeMobileItems(fresh));
    return;
  }
  for (const g of GHOSTS) {
    // Laid on the lattice on the way in, exactly as an imported item is by
    // onLattice(). The positions above are written for an unsnapped board, and a
    // snapped one is a different board: its cards sit flush in cells, and four
    // that arrived at their own coordinates would be the only things on it that
    // did not. This is the hydration path rather than the import path, so it
    // does no commit and keeps no presnap memo - a hint is never unsnapped back
    // to anything, because it is never saved and never survives content
    // arriving.
    //
    // The step is the board's own, not 64: gridStep is a setting, and hardcoding
    // geometry that happens to be whole cells at the default would come apart
    // the moment somebody moved it.
    const box = board.settings.snap ? latticeBox(g, step) : g;
    board.items.push(makeItem({
      id: g.id, type: 'ghost', x: box.x, y: box.y, w: box.w, h: box.h,
      meta: { hint: g.hint, tape: g.tape === false ? [] : tapeFor() },
    }));
  }
}

/**
 * Take the ghost cards off the board for good.
 *
 * No commit on purpose - see the note above. Returns the ids it removed so the
 * caller can animate them out; an empty array means there was nothing to do,
 * which is the common case once a board is in use.
 */
export function dismissGhosts() {
  ghostsDismissed = true;
  const gone = board.items.filter(i => i.type === 'ghost').map(i => i.id);
  if (!gone.length) return gone;
  board.items = board.items.filter(i => i.type !== 'ghost');
  let dropped = false;
  for (const id of gone) if (selection.delete(id)) dropped = true;
  bus.emit('items', { added: [], removed: gone });
  if (dropped) bus.emit('selection');
  return gone;
}

/**
 * Reset the latch for a board that is arriving. `content` is whether that board
 * has any of its own - a board with things on it is dismissed before it is even
 * drawn, so its first edit does not try to sweep hints that were never there.
 */
export function resetGhostLatch(content = false) {
  ghostsDismissed = !!content;
}

/**
 * Take things back out of the bin.
 *
 * `at` is where the item should land - the point it was dropped on when it was
 * dragged out of the bin panel. Without one it goes back exactly where it was
 * deleted from, which is what the bin's own Restore does.
 *
 * Restored items are stacked on top rather than returned to their old z: they
 * were absent while everything else moved on, and coming back underneath a
 * pile is the same as not coming back.
 */
export function restoreItems(ids, at = null, label = 'Restore') {
  const set = new Set(ids);
  const entries = board.trash.filter(t => set.has(t.item.id));
  if (!entries.length) return [];
  let z = topZ();
  const items = entries.map(e => fitBoardMode({
    ...e.item,
    ...(at ? { x: at.x, y: at.y } : null),
    z: ++z,
  }));
  const back = new Set(items.map(i => i.id));
  commit(label,
    () => { const fresh = items.filter(i => !byId(i.id));
            board.items.push(...fresh);
            board.trash = board.trash.filter(t => !set.has(t.item.id));
            bus.emit('items', { added: fresh.map(i => i.id), removed: [] });
            bus.emit('trash'); },
    () => { board.items = board.items.filter(i => !back.has(i.id));
            back.forEach(id => selection.delete(id));
            board.trash.unshift(...entries);
            bus.emit('items', { added: [], removed: [...back] });
            bus.emit('selection'); bus.emit('trash'); });
  return items;
}

/** Throw the bin out. Undoable - emptying it by accident is a bad afternoon. */
export function emptyTrash() {
  if (!board.trash.length) return;
  const held = board.trash;
  commit('Empty trash',
    () => { board.trash = []; bus.emit('trash'); },
    () => { board.trash = held; bus.emit('trash'); });
}

// ---------------------------------------------------------------------------
// Snapping the whole board
// ---------------------------------------------------------------------------

/**
 * Turning snapping on lays every item on the lattice at once, rather than only
 * governing the next thing you drag - so the board *looks* snapped the moment
 * the setting is on, which is the only way a grid reads as a grid.
 *
 * Turning it off puts everything back. That needs the old geometry kept
 * somewhere, and it goes in `meta.presnap` on the item: per item, so an item
 * touched during a snapped session can drop its own memo without affecting the
 * rest, and serialised with the board, so the promise survives a save and a
 * reload rather than lasting only as long as the tab.
 *
 * Two consequences worth being explicit about:
 *
 * - **The step is the base step, not the one on screen.** `gridStep()` picks a
 *   spacing from the current zoom so the lattice never becomes a fill, which is
 *   right for something drawn and wrong for something stored: snapping at 20%
 *   zoom would otherwise commit a board to a coarser geometry than snapping at
 *   100%, and the same click would do two different things depending on how far
 *   out you happened to be.
 * - **Edges land on the lattice, not centres**, and the arithmetic is latticeBox() in
 *   geometry.js, shared with the gestures in canvas/input.js so that laying the
 *   board out and then dragging one item across it agree about where things go.
 *   What makes a snapped board look snapped is items sitting flush in cells; an
 *   item whose size is an odd number of cells therefore ends up with its centre
 *   on a half-step, which is correct and is not a rounding error.
 */
function snapAll() {
  const step = baseStep();
  const before = [], after = [];
  for (const it of board.items) {
    const pre = it.meta?.presnap || null;
    before.push({ id: it.id, x: it.x, y: it.y, w: it.w, h: it.h, pre });

    const box = latticeBox(it, step);
    after.push({
      id: it.id,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      // A board snapped, unsnapped and snapped again remembers the first
      // position, not the second - the memo is of life before the lattice.
      pre: pre || { x: it.x, y: it.y, w: it.w, h: it.h },
    });
  }
  applySnapState(before, after, 'Snap to grid');
}

/**
 * Re-assert the geometry rules that can drift from their rendered result.
 *
 * A reload is not an edit by itself. Snapping only records history and dirties
 * the board when it actually repairs a box; the final event also makes every
 * renderer re-read positions when nothing in the data needed changing.
 */
export function recheckBoardGeometry() {
  if (board.settings.snap) snapAll();
  const ids = board.items.map(item => item.id);
  if (ids.length) bus.emit('geom', ids);
}

/** Put back what snapAll() remembered, for everything still carrying a memo. */
function unsnapAll() {
  const before = [], after = [];
  for (const it of board.items) {
    // Checked rather than trusted: a memo arrives from a .mbrd like everything
    // else, and a hand-edited one holding a string would write it straight onto
    // the item's geometry. A memo that does not describe a box is no memo.
    const pre = usableMemo(it.meta?.presnap);
    if (!pre) { forgetPresnap(it); continue; }
    before.push({ id: it.id, x: it.x, y: it.y, w: it.w, h: it.h, pre });
    after.push({ id: it.id, x: pre.x, y: pre.y, w: pre.w, h: pre.h, pre: null });
  }
  applySnapState(before, after, 'Leave the grid');
}


function applySnapState(before, after, label) {
  const moved = after.some((a, i) =>
    SNAP_KEYS.some(k => a[k] !== before[i][k]) || !!a.pre !== !!before[i].pre);
  if (!moved) return;
  writeSnapState(after);
  commit(label, () => writeSnapState(after), () => writeSnapState(before));
}

function writeSnapState(list) {
  const ids = [];
  for (const g of list) {
    const it = byId(g.id);
    if (!it) continue;
    const next = fitBoardMode({ ...it, ...g });
    for (const k of SNAP_KEYS) it[k] = next[k];
    if (g.pre) it.meta = { ...it.meta, presnap: g.pre };
    else forgetPresnap(it);
    ids.push(g.id);
  }
  if (ids.length) bus.emit('geom', ids);
}

function itemsIn(ids) {
  const set = ids instanceof Set ? ids : new Set(ids);
  // The title card is a board-bound singleton: it cannot be copied, cut,
  // duplicated or pasted. Excluded here - the one funnel all four go through
  // (copy, cut, duplicate; paste reads the clipboard this fills) - so a group
  // that happens to include it simply leaves it behind rather than the whole
  // operation refusing.
  return board.items
    .filter(i => set.has(i.id) && i.type !== 'title')
    .sort((a, b) => (a.z || 0) - (b.z || 0));
}

/**
 * The copy that Duplicate and Paste both make: everything about an item except
 * its identity and its place in the stack.
 *
 * `id` and `z` are left off so makeItem() mints a fresh id and puts the copy on
 * top. The asset is copied by *reference*, never by bytes: assets are keyed by
 * content hash and the packer writes each hash once, so duplicating a 40 MB
 * video costs nothing on disk. meta is shallow-copied because every field in it
 * is a scalar - text, tint, mime, size and the rest.
 */
function cloneItem(i, dx = 0, dy = 0) {
  return {
    type: i.type,
    x: i.x + dx,
    y: i.y + dy,
    w: i.w, h: i.h, rot: i.rot,
    name: i.name,
    asset: i.asset ? { ...i.asset } : null,
    meta: { ...i.meta },
  };
}

/** Copy items, offset a little so the copy is visibly on top of the original. */
export function duplicateItems(ids, offset = { x: 28, y: -28 }) {
  const src = itemsIn(ids);
  if (!src.length) return [];
  const copies = src.map(i => cloneItem(i, offset.x, offset.y));
  return addItems(copies, copies.length > 1 ? `Duplicate ${copies.length} items` : 'Duplicate');
}

// ---------------------------------------------------------------------------
// The internal clipboard
//
// Items are held here rather than pushed onto the system clipboard, because an
// item is not text. It can reference an embedded asset of any size, which has
// no honest text/plain form and which round-tripping through the system
// clipboard would make us re-encode and re-hash on every paste - where a copy
// held in memory shares the original's asset hash for free, exactly as
// Duplicate does. What does go out to the system clipboard is a readable
// summary, so that copying a sticky note and pasting it into a text editor
// gives you its words.
// ---------------------------------------------------------------------------

const clipboard = { items: [], text: '', pastes: 0 };

export const clipboardSize = () => clipboard.items.length;

/** The box the clipboard's contents were copied from, or null when it is empty. */
export const clipboardBounds = () => itemBounds(clipboard.items);

/**
 * Whether the text the system clipboard is offering is the text *we* put there.
 *
 * This is the one question that decides a paste, and the browser gives no way
 * to ask it directly: two clipboards exist - ours and the machine's - and
 * nothing reports which of them was filled more recently. So a copy leaves a
 * receipt. The exact string handed to the system clipboard is remembered here,
 * and a paste that arrives carrying it is a paste of our own copy: nothing has
 * been copied anywhere else since. A paste carrying anything else means the
 * user has been somewhere else and copied something there, and that newer thing
 * is what they mean by Ctrl+V.
 *
 * The receipt is the summary text itself rather than a hidden token, so that
 * what lands in a text editor is clean. The cost is a collision no wider than
 * copying a note, going away, copying that same text back verbatim from
 * somewhere else, and returning - which yields a copy of the note instead of a
 * new note of the same words, and is not a bad answer to a question nobody can
 * answer correctly.
 */
export function clipboardHasOurs(systemText) {
  return !!clipboard.items.length && !!clipboard.text && systemText === clipboard.text;
}

/**
 * Take a copy of some items. Not a board mutation, so nothing to undo.
 *
 * Returns the text the caller should hand to the system clipboard, or '' when
 * there was nothing to copy. That half is the caller's, because only a real
 * `copy`/`cut` event may write to the system clipboard synchronously.
 */
export function copyItems(ids) {
  const text = take(ids);
  if (text) toast(`Copied ${count(clipboard.items.length)}`);
  return text;
}

/**
 * The copy itself, without the receipt.
 *
 * Cut takes exactly this copy but has something else to say about it, and two
 * toasts in the same turn are not two messages - the second replaces the first
 * inside a frame, so all the user sees is the last one and all the first one
 * did was reset the fade.
 */
function take(ids) {
  const src = itemsIn(ids);
  if (!src.length) return '';
  clipboard.items = src.map(i => cloneItem(i));
  clipboard.pastes = 0;
  clipboard.text = summarise(src);
  return clipboard.text;
}

/** "1 item" / "3 items", for the three clipboard receipts. */
const count = n => `${n} item${n === 1 ? '' : 's'}`;

/**
 * Copy, then delete: one undo entry, because removeItems() is the only half
 * that touched the board. Cut items go to the bin like any other delete, so a
 * cut you never paste is still recoverable.
 *
 * The one of the three that genuinely needed saying out loud: copy and paste
 * both leave something on screen to look at, where cut makes things disappear
 * and looks identical to having pressed delete by mistake. Naming the bin is
 * the useful half of the message - it is the difference between "gone" and
 * "over there".
 */
export function cutItems(ids) {
  const doomed = itemsIn(ids).map(i => i.id);
  const text = take(doomed);
  if (!text) return '';
  removeItems(doomed, doomed.length > 1 ? `Cut ${doomed.length} items` : 'Cut');
  toast(`Cut ${count(doomed.length)} to the bin`);
  return text;
}

/**
 * What a copied selection says on the system clipboard. A note gives up its
 * text, a link its address, and everything else its name - in each case the
 * only part of that item which means anything outside this app. A link's name
 * would be the wrong half here: it is a label, editable and often nothing like
 * the URL, and a link copied out of the board is copied in order to be pasted
 * somewhere that wants the address. The bracketed count is the fallback for a
 * selection with nothing to say - an unnamed photo - because the receipt above
 * only works while the string is never empty.
 */
function summarise(src) {
  const lines = src.map(i => (i.type === 'note' ? i.meta.text
                            : i.type === 'link' ? i.meta.url
                            : i.name) || '').filter(Boolean);
  if (lines.length) return lines.join('\n\n');
  return `[mbrd: ${src.length} item${src.length === 1 ? '' : 's'}]`;
}

/**
 * How far each paste steps off the one before it. The same offset Duplicate
 * uses - up and to the right, where a copy lands on a physical desk.
 */
const PASTE_STEP = { x: 28, y: -28 };

/**
 * Put the internal clipboard on the board.
 *
 * `at` is an optional world point to centre the pasted group on. The caller
 * passes one only when the place the copy was taken from is off screen;
 * otherwise it passes nothing and the copy lands beside its original. Pasting
 * in place is what makes copy/paste usable as "another one of these": the pair
 * appears side by side where you can compare them. It is only when the original
 * is somewhere you are not looking that the middle of the screen beats it,
 * because a paste that lands off screen is indistinguishable from one that did
 * nothing at all.
 *
 * Either way the step accumulates across pastes of the same clipboard, so the
 * second Ctrl+V clears the first instead of hiding underneath it.
 */
export function pasteItems(at = null) {
  if (!clipboard.items.length) return [];
  const n = clipboard.pastes++;
  let dx, dy;
  if (at) {
    // n rather than n + 1, so the first paste at a given point lands *on* it
    // and only the ones after it fan out.
    const b = itemBounds(clipboard.items);
    dx = at.x - (b.x0 + b.x1) / 2 + n * PASTE_STEP.x;
    dy = at.y - (b.y0 + b.y1) / 2 + n * PASTE_STEP.y;
  } else {
    dx = (n + 1) * PASTE_STEP.x;
    dy = (n + 1) * PASTE_STEP.y;
  }
  const copies = clipboard.items.map(i => cloneItem(i, dx, dy));
  const added = addItems(copies, copies.length > 1 ? `Paste ${copies.length} items` : 'Paste');
  // Worth saying even though the copies are visible: a paste that lands under
  // the pointer looks like a paste, but one that fanned out from an original
  // off the edge of the screen can put every copy somewhere you are not
  // looking, and then a working paste and a dead key are the same event.
  toast(`Pasted ${count(added.length)}`);
  return added;
}


export function setItemText(id, text) {
  const it = byId(id);
  if (it?.type === 'note') text = text.slice(0, NOTE_MAX);
  if (!it || it.meta.text === text) return;
  const prev = it.meta.text;
  commit('Edit note',
    () => { byId(id).meta.text = text; bus.emit('item', id); },
    () => { byId(id).meta.text = prev; bus.emit('item', id); });
}

/**
 * Commit a note's formatted content - the structured `meta.rich` and the
 * plaintext `meta.text` it flattens to - as one undoable step, so a single Ctrl+Z
 * takes back the whole edit rather than the two halves separately. A no-op when
 * neither half moved, which is what keeps closing an editor you only looked at
 * from spending a history slot. `rich` is trusted to be normalised by the caller
 * (canvas/notes.js), and `text` is capped here the way setItemText caps its own.
 */
export function setNoteContent(id, rich, text) {
  const it = byId(id);
  if (!it || it.type !== 'note') return;
  text = String(text ?? '').slice(0, NOTE_MAX);
  const prevRich = it.meta.rich;
  const prevText = it.meta.text;
  if (prevText === text && JSON.stringify(prevRich) === JSON.stringify(rich)) return;
  const write = (t, r) => {
    const m = byId(id).meta;
    m.text = t;
    if (r === undefined) delete m.rich;
    else m.rich = r;
    bus.emit('item', id);
  };
  commit('Edit note', () => write(text, rich), () => write(prevText, prevRich));
}

/**
 * Turn one item into an item of another kind, as a single undoable step.
 *
 * The item is replaced rather than edited, and the replacement is minted with
 * a fresh id. That is not bookkeeping. canvas/items.js caches one node per id
 * and writes the type onto that node when it is *built*, and the stylesheet
 * keys off it - so an item that changed type under a node that stayed would go
 * on wearing the old type's clothes until something unrelated forced a
 * rebuild. Retiring the id retires the node with it, which is the only way to
 * get an honest one back without reaching into the renderer from here.
 *
 * Position, rotation and stacking carry over unless `next` overrules them:
 * this is the same thing seen differently, and it should not move or change
 * places in the pile. The selection follows the swap in both directions, so
 * whichever of the pair is on the board is the one that is selected, and an
 * undo hands the original back ready to be dragged rather than anonymous.
 *
 * The slot to write into is found by identity when the command runs, not by an
 * index captured while it is being built. Undo may be pressed three edits
 * later, by which time a position recorded now is pointing at somebody else.
 */
export function retypeItem(id, next, label = 'Change item') {
  const old = byId(id);
  if (!old) return null;
  const item = makeItem({ x: old.x, y: old.y, rot: old.rot, z: old.z, ...next });
  const swap = (out, into) => {
    const at = board.items.indexOf(out);
    if (at < 0) return;
    board.items.splice(at, 1, into);
    if (selection.delete(out.id)) selection.add(into.id);
    bus.emit('items', { added: [into.id], removed: [out.id] });
    bus.emit('selection');
  };
  commit(label, () => swap(old, item), () => swap(item, old));
  return item;
}

/**
 * Call an item something else.
 *
 * An empty name never sticks. A picture wears its name on the caption plate
 * that build() only draws `if (item.name)`, so clearing it would take away the
 * very handle you renamed it by and leave the item anonymous with no way back -
 * a one-way door, on the one edit people make by accident most. Blank therefore
 * means "put it back", and what goes back is the name the file arrived under:
 * the asset registry has held it since the import and a .mbrd carries it, so it
 * is still there a month later. An item with no asset behind it keeps the name
 * it had, and only one that never had a name can come out of this without one -
 * which costs it nothing, because it had no plate to lose.
 */
/**
 * Rename an item, or clear the name to get the original filename back.
 *
 * The fallback order is the point. `meta.origName` is written at import and
 * travels in board.json, so it survives a save and reopen; the asset registry's
 * copy is the older path and only holds for assets registered this session,
 * because the archive carries bytes and hashes but no filenames. Consulting
 * only the registry meant that after a round trip, clearing the name of a
 * renamed item handed back the *renamed* value - the original had nowhere to
 * have been kept.
 */
export function renameItem(id, name) {
  const it = byId(id);
  if (!it) return;
  const next = String(name ?? '').trim() ||
               it.meta?.origName ||
               (it.asset && assetName(it.asset.hash)) || it.name;
  if (it.name === next) return;
  const prev = it.name;
  commit('Rename',
    () => { byId(id).name = next; bus.emit('item', id); },
    () => { byId(id).name = prev; bus.emit('item', id); });
}

/**
 * Give an item a picture of its own, or take it away with a null.
 *
 * A card that is not itself a picture - a sound file, a text file, a named
 * card for something the browser cannot draw - has nothing to look at on a
 * board, and a board is looked at from a distance where a name is not legible.
 * So any of them can carry one: an album cover, a diagram, a frame grabbed by
 * hand. The picture is an ordinary asset, hashed and deduped like every other,
 * which is what makes "the same cover on nine tracks" cost one file.
 *
 * Only the *reference* is undoable. The bytes stay in the registry either way,
 * because undo has to be able to put the picture back and the autosave sweep
 * is what eventually collects anything no item points at.
 */
export function setItemCover(id, hash) {
  const it = byId(id);
  if (!it) return;
  const next = isHash(hash) ? hash : null;
  const prev = isHash(it.meta?.cover) ? it.meta.cover : null;
  if (next === prev) return;
  const write = value => {
    const item = byId(id);
    if (!item) return;
    if (value) item.meta = { ...item.meta, cover: value };
    else { const { cover, ...rest } = item.meta || {}; item.meta = rest; }
    bus.emit('item', id);
  };
  commit(next ? 'Set picture' : 'Remove picture', () => write(next), () => write(prev));
}

/**
 * Attach the hundred-pixel copy the board draws when it is zoomed out.
 *
 * Not undoable, and unlike setItemCover() that is not an oversight. A cover is
 * a choice somebody made about what a card looks like; a thumbnail is a derived
 * copy of the picture the item already holds, and there is no state of the
 * board in which having one is a change worth being able to take back. Made at
 * import (import/drop.js) and repaired by the optimiser (optimize/optimize.js);
 * absent simply means the card draws full size at every zoom.
 *
 * Marks the board dirty, because the id has to be saved - the bytes are pinned
 * by itemHashes() and would otherwise be swept the next time the autosave
 * collected whatever nothing points at.
 */
export function setItemThumb(id, hash) {
  const it = byId(id);
  if (!it || !isHash(hash) || it.meta?.thumb === hash) return;
  it.meta = { ...it.meta, thumb: hash };
  bus.emit('item', id);
  markDirty();
}

/**
 * Point a run of items at smaller copies of their own files, reversibly.
 *
 * One commit for the whole board rather than one per card, because that is what
 * the gesture was: you asked to optimise a board, and one Ctrl+Z has to undo a
 * board. Two hundred separate entries would also be two hundred of the history
 * limit, which is to say the rest of the session's undo thrown away to record a
 * single button press.
 *
 * Each swap is `{ id, asset, cover }` - either field may be absent, and an
 * absent one is left exactly as it was. Items that were *considered* and left
 * alone belong in the list too, with neither field: they still get marked, and
 * marking them is the whole point of listing them.
 *
 * The id that was there goes into `meta.was` / `meta.wasCover`, and that is not
 * bookkeeping for undo's sake: undo closes over the old ids already. It is for
 * the *autosave sweep*, which deletes any bytes no item claims and would
 * otherwise collect the originals the moment the board saved itself - leaving an
 * undo entry that could only put back a hash with nothing behind it. See
 * referencedHashes() in storage/storage.js, and packBoard() in storage/mbrd.js,
 * which drops both fields on the way into a .mbrd so an export carries the small
 * files alone.
 *
 * `meta.opt` is the other half: the ids this item held when the optimiser last
 * looked at it. A second run compares against it and skips what it finds, which
 * is what keeps a re-encode from happening twice - once for the wasted minute,
 * and once because a lossy format encoded from its own output is a second
 * generation of loss for no gain. It is written *inside the commit*, so undoing
 * an optimisation takes the mark back with it and the restored originals are
 * offered again. Hashes rather than a flag, so replacing an item's picture by
 * hand also un-marks it, without anything having to remember to.
 */
export function swapAssets(swaps, label = 'Optimize board') {
  const list = (swaps || []).filter(s => s && byId(s.id));
  if (!list.length) return 0;

  const before = list.map(({ id }) => {
    const it = byId(id);
    return { id, asset: it.asset ? { ...it.asset } : null, meta: { ...it.meta } };
  });

  // A run that found nothing worth rewriting still learned something, and the
  // marks are how it remembers - but they are bookkeeping about work done, not
  // a change to the board, so they go on outside the undo stack. Committing
  // them would put an entry on the history that looks like nothing happened,
  // because nothing did, and spend one of the steps the user has left.
  const swapping = list.some(({ id, asset, cover }) => {
    const it = byId(id);
    return (isHash(asset) && it.asset?.hash && asset !== it.asset.hash) ||
           (isHash(cover) && isHash(it.meta?.cover) && cover !== it.meta.cover);
  });
  if (!swapping) {
    for (const { id } of list) {
      const it = byId(id);
      // No event: nothing about the item is drawn differently for having been
      // looked at, and a rebuild per card would be a flicker for nothing.
      if (it) it.meta = { ...it.meta, opt: [...itemHashes(it)] };
    }
    markDirty();
    return 0;
  }

  const forward = () => {
    for (const { id, asset, cover } of list) {
      const it = byId(id);
      if (!it) continue;
      const meta = { ...it.meta };
      if (isHash(asset) && it.asset?.hash && asset !== it.asset.hash) {
        // Only the first swap records an original. Optimising twice must not
        // leave `was` pointing at the *previous* optimisation, or undoing once
        // would restore a file that is itself already re-encoded.
        if (!isHash(meta.was)) meta.was = it.asset.hash;
        it.asset = { ...it.asset, hash: asset };
      }
      if (isHash(cover) && isHash(meta.cover) && cover !== meta.cover) {
        if (!isHash(meta.wasCover)) meta.wasCover = meta.cover;
        meta.cover = cover;
      }
      it.meta = meta;
      // Marked last, so what is recorded is what the item ended up holding.
      meta.opt = [...itemHashes(it)];
      bus.emit('item', id);
    }
  };

  const back = () => {
    for (const snap of before) {
      const it = byId(snap.id);
      if (!it) continue;
      it.asset = snap.asset ? { ...snap.asset } : null;
      it.meta = { ...snap.meta };
      bus.emit('item', snap.id);
    }
  };

  commit(label, forward, back);
  return list.length;
}

/**
 * Let go of the files the optimiser replaced.
 *
 * Undoable in the sense that matters - the *board* is unchanged either way, so
 * this is not on the history at all. What it changes is what the next autosave
 * sweep is allowed to collect: with `was` gone, nothing claims the originals and
 * the browser gets the space back. It is a one-way door and the caller says so
 * before opening it.
 */
export function discardOriginals() {
  let n = 0;
  for (const it of board.items) {
    if (!isHash(it.meta?.was) && !isHash(it.meta?.wasCover)) continue;
    const { was, wasCover, ...rest } = it.meta;
    it.meta = rest;
    n++;
  }
  if (n) markDirty();
  return n;
}

/** How many items are still holding a pre-optimisation original. */
export const originalsHeld = () =>
  board.items.filter(it => isHash(it.meta?.was) || isHash(it.meta?.wasCover)).length;

/**
 * Which way up a model file is read.
 *
 * 'z' or 'y'. Anything else clears the override and hands the decision back to
 * the format's own default, which is what a board that has never been told
 * carries - see defaultUpAxis() in mesh.js.
 *
 * Its own setter rather than a general "write anything into meta", for the same
 * reason setItemCover has one: `meta` is the open field precisely because
 * nothing polices it, and the two things in there that this app itself reads
 * are better off with a door each than with a hole.
 *
 * Undoable, because it is a visible change to an item and every other visible
 * change to an item is.
 */
export function setItemUpAxis(id, axis) {
  const it = byId(id);
  if (!it) return;
  const next = axis === 'z' || axis === 'y' ? axis : null;
  const prev = it.meta?.upAxis === 'z' || it.meta?.upAxis === 'y' ? it.meta.upAxis : null;
  if (next === prev) return;
  const write = value => {
    const item = byId(id);
    if (!item) return;
    if (value) item.meta = { ...item.meta, upAxis: value };
    else { const { upAxis, ...rest } = item.meta || {}; item.meta = rest; }
    bus.emit('item', id);
  };
  commit('Turn model upright', () => write(next), () => write(prev));
}

/**
 * One image or video's own fit, overriding the board-wide default. 'cover' fills
 * and crops, 'contain' fits the whole picture in; both are explicit, so once set
 * the card no longer follows the board default (that is what an override is for).
 * Undoable and emits 'item', which rebuilds the node so canvas/renderers.js's
 * fitMode() reads the new value - the same shape setItemUpAxis uses.
 */
export function setItemFit(id, fit) {
  const it = byId(id);
  if (!it || (it.type !== 'image' && it.type !== 'video')) return;
  const next = fit === 'cover' || fit === 'contain' ? fit : null;
  const prev = it.meta?.fit === 'cover' || it.meta?.fit === 'contain' ? it.meta.fit : null;
  if (next === prev) return;
  const write = value => {
    const item = byId(id);
    if (!item) return;
    if (value) item.meta = { ...item.meta, fit: value };
    else { const { fit: _drop, ...rest } = item.meta || {}; item.meta = rest; }
    bus.emit('item', id);
  };
  commit('Fit media', () => write(next), () => write(prev));
}

/**
 * The still a model card shows instead of running WebGL, and the angle it was
 * taken from.
 *
 * Deliberately *not* undoable, which is the one decision here worth arguing.
 * Everything else that writes to `meta` is a thing somebody did; this is the
 * app putting the kettle on. Taking a fresh photograph of a model you just
 * turned is not an edit to step back through, and if it were, Ctrl+Z would walk
 * you backwards through a stack of pictures of the same object rather than
 * through the work you were doing.
 *
 * It still marks the board dirty, because the bytes it points at have to be
 * saved or the next open has a card pointing at nothing.
 */
export function setModelShot(id, { hash, ink, view } = {}) {
  const it = byId(id);
  if (!it || it.type !== 'model') return;
  const meta = { ...it.meta };
  if (isHash(hash)) meta.shot = hash; else delete meta.shot;
  // What the model was shaded in when the picture was taken. A model with no
  // colours of its own is drawn in the board's ink, so a change of palette
  // leaves every still a shade out of date - and this is what lets the card
  // notice. Absent means the model brought its own colours and never goes stale.
  if (typeof ink === 'string' && ink) meta.shotInk = ink; else delete meta.shotInk;
  if (view && typeof view === 'object') {
    meta.view = { yaw: +view.yaw || 0, pitch: +view.pitch || 0, zoom: +view.zoom || 1 };
  }
  it.meta = meta;
  markDirty();
  bus.emit('item', id);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function select(ids, additive = false) {
  if (!additive) selection.clear();
  for (const id of ids) selection.add(id);
  bus.emit('selection');
}

export function clearSelection() {
  if (!selection.size) return;
  selection.clear();
  bus.emit('selection');
}

/** Remove one item from the current selection, leaving the rest intact. */
export function deselect(id) {
  if (!selection.delete(id)) return false;
  bus.emit('selection');
  return true;
}

export function selectAll() {
  select(board.items.map(i => i.id));
}

// ---------------------------------------------------------------------------
// Settings + whole-board replacement
// ---------------------------------------------------------------------------

export function setSetting(key, value) {
  // Paper is Desktop-only, and this is where that is actually enforced: the
  // fixup in activateLayoutSettings() runs once, at the moment of the switch,
  // so without this a later write would put a sheet on the Mobile board.
  if (board.layoutMode === 'mobile' &&
      ['paper', 'paperLandscape', 'paperResize'].includes(key)) return;
  if (key === 'mobileColumns') {
    if (board.layoutMode !== 'mobile') return;
    value = mobileColumnCount(value);
  }
  if (key === 'mobileHeader') {
    // Board-level and editable from either layout: the Mobile masthead and the
    // Desktop title card share this one style.
    value = normalizeMobileHeader(value);
    if (JSON.stringify(board.mobileHeader) === JSON.stringify(value)) return;
    board.mobileHeader = value;
    markDirty();
    bus.emit('settings', key);
    return;
  }
  if (key === 'mediaFit') {
    // Board-level, like mobileHeader: one value for both layouts, so it lives on
    // the board rather than in the per-layout settings the rest of this writes.
    const next = normalizeMediaFit(value);
    if (board.mediaFit === next) return;
    board.mediaFit = next;
    markDirty();
    bus.emit('settings', key);
    return;
  }
  if (key === 'paletteSources') {
    // Board-level too, and read by ui/appearance.js's palette extraction.
    const next = normalizePaletteSources(value);
    if (board.paletteSources === next) return;
    board.paletteSources = next;
    markDirty();
    bus.emit('settings', key);
    return;
  }
  if (key === 'fonts') {
    const fonts = normalizeFonts(value);
    board.settings.fonts = fonts;
    board.layoutSettings.desktop.fonts = cloneSettings({ fonts }).fonts;
    board.layoutSettings.mobile.fonts = cloneSettings({ fonts }).fonts;
    markDirty();
    bus.emit('settings', key);
    return;
  }
  if (key === 'appearance') {
    setAppearance(value);
    return;
  }
  if (board.settings[key] === value) return;
  board.settings[key] = value;
  // Snapping is not only a rule for the next drag - it moves the board. Done
  // here rather than at the checkbox because the whimsy axis flips this setting
  // too (Harsh means snapped), and both routes have to behave the same.
  if (key === 'snap') value ? snapAll() : unsnapAll();
  // The gap is baked into where the packer put things, so on Mobile it is not a
  // rule for the next import - it moves the column that is already there. On
  // Desktop it is exactly a rule for the next import, and nothing moves until
  // Rearrange is pressed. Same setting, and the difference is the layout's.
  if (key === 'mobileColumns' ||
      (key === 'spacing' && board.layoutMode === 'mobile')) repackMobileBoard();
  board.layoutSettings[board.layoutMode] = layoutSettingsOf(board.settings);
  markDirty();
  bus.emit('settings', key);
}

/** Replace the shared color/whimsy half and the active layout's local look. */
export function setAppearance(appearance) {
  const { shared, local } = splitAppearance(appearance);
  board.sharedAppearance = cloneSettings({ appearance: shared }).appearance;
  board.settings.appearance = mergeAppearance(board.sharedAppearance, local);
  board.layoutSettings[board.layoutMode] = layoutSettingsOf(board.settings);
  markDirty();
  bus.emit('settings', 'appearance');
}

export function setArrangement(name) {
  if (board.arrangement === name) return;
  board.arrangement = name;
  board.arrangements[board.layoutMode] = name;
  markDirty();
  bus.emit('settings', 'arrangement');
}

export function setTitle(title) {
  board.title = cleanBoardTitle(title) || 'Untitled board';
  bus.emit('board');
}

/**
 * Replace the whole board (open / new). Clears selection and history.
 *
 * Two steps, and the split is the whole of it: normalise() builds a complete
 * replacement board out of the incoming data and cannot throw, then the
 * assignments below swap it in with nothing left that can fail between them.
 *
 * It used to assign field by field straight from `data`, which was fine right
 * up until one of those fields was not the shape it looked like. `board.json`
 * arrives parsed but unvalidated - it is JSON from a file this app did not
 * necessarily write - and `(data.items || []).map(...)` throws on anything that
 * is not an array. By then the title, the view, the settings and the
 * arrangement had already been replaced, so a board that failed to open left
 * the user looking at their own items under someone else's title, with no way
 * back: there is no undo across a load, by design. Half a board is the one
 * outcome an open must not have.
 */
export function loadBoard(data) {
  const layoutMode = board.layoutMode;
  const next = normalizeBoard(data);
  board.title = next.title;
  board.view = next.view;
  board.sharedAppearance = next.sharedAppearance;
  board.layoutSettings = next.layoutSettings;
  board.arrangements = next.arrangements;
  board.layouts = next.layouts;
  board.mobileHeader = next.mobileHeader;
  board.titleHidden = next.titleHidden;
  board.mediaFit = next.mediaFit;
  board.paletteSources = next.paletteSources;
  board.trash = next.trash;
  board.layoutMode = layoutMode;
  // Nothing that arrives from outside is allowed to be a ghost. serializeBoard()
  // never writes one, so a file carrying the type was hand-made or came from a
  // future the app does not have; either way a hint the board did not mint is
  // one nothing would ever clear, since a board holding it is not empty. Dropped
  // here rather than trusted, which is the same treatment every other field in
  // normalizeBoard() gets.
  board.items = next.items.filter(i => i.type !== 'ghost');
  // The latch travels with the board, not the session: one that arrives with
  // content has already been past this point, and one that arrives empty earns
  // its hints. See ensureGhostCards(), which main.js calls on 'board:load'.
  resetGhostLatch(board.items.some(i => i.type !== 'title'));
  // The Desktop title card is seeded by the app (main.js, on 'board:load'), not
  // here: keeping loadBoard() free of it lets state tests load and serialise a
  // board of exactly the items they gave it. See ensureTitleCard().
  // Before completeLayout(): the Mobile carry below asks stuckTo() where each
  // note belongs, so the memo has to hold *this* board's answers, not the last
  // board's. Seeding also drops the old board's ids, which two files can share.
  seedSticks();
  activateLayoutSettings(layoutMode);
  writeLayout(completeLayout(layoutMode));
  selection.clear();
  clearHistory();
  // The clipboard cannot cross a board. Opening one calls clearAssets(), so a
  // copy taken from the old board would paste an item whose asset hash no
  // longer resolves to any bytes - a card with a hole in it, which is worse
  // than a Ctrl+V that politely does nothing.
  clipboard.items = [];
  clipboard.text = '';
  clipboard.pastes = 0;
  resetDirty();
  // 'board:load' is the "everything was replaced" signal - distinct from
  // 'board', which also fires for a title change or a dirty-flag flip and so
  // must never be treated as a reason to reset the view.
  bus.emit('board:load');
  bus.emit('board');
  // No delta on purpose: a load replaces everything, and there is no add/remove
  // list that captures "the board you had is gone". A payloadless 'items' is the
  // agreed signal for "membership changed, extent unknown - rescan the board",
  // which every delta-aware listener already falls back to.
  bus.emit('items');
  bus.emit('selection');
  bus.emit('trash');
}

/**
 * A whole board, built from whatever arrived, with no way to fail.
 *
 * Every container is checked for the shape it is about to be used as rather
 * than assumed, so a hand-written or truncated board.json degrades to defaults
 * one field at a time instead of throwing half-way through a load.
 */
function normalizeBoard(data) {
  const src = data && typeof data === 'object' ? data : {};
  const rawSettings = src.settings && typeof src.settings === 'object' ? src.settings : {};
  const desktopSettings = normalizeSettings(rawSettings, 'desktop');
  // The Mobile profile, as far as it can be read out of a Desktop-shaped file.
  //
  // Spacing is zeroed on the way through and that is a migration, not a rule:
  // top-level `settings` describes Desktop (see docs/mbrd-format.md), so a file
  // with no Mobile record of its own would hand the column Desktop's 12 - and
  // for every board written before Mobile had a gap at all, zero is what it was
  // actually saved looking like. A file that *does* carry a Mobile record keeps
  // whatever gap that record names; normalizeLayoutSettings() spreads the
  // record over this, so the record wins wherever it has an opinion.
  const mobileSettings = { ...normalizeSettings(rawSettings, 'mobile'), spacing: 0 };
  const { shared: sharedAppearance } = splitAppearance(desktopSettings.appearance);
  const items = (Array.isArray(src.items) ? src.items : [])
    .filter(it => it && typeof it === 'object')
    .slice(0, MAX_ITEMS);
  const trash = (Array.isArray(src.trash) ? src.trash : [])
    .filter(t => t && t.item && typeof t.item === 'object')
    .slice(0, TRASH_LIMIT);
  // One id space across the live board and the bin: a restored item must not
  // collide with a live one.
  const ids = new Set();
  const normalizedItems = dedupeIds(items.map(makeItem), ids);
  const rawLayouts = src.layouts && typeof src.layouts === 'object' ? src.layouts : {};
  const desktopRecord = layoutRecord(rawLayouts.desktop);
  const mobileRecord = layoutRecord(rawLayouts.mobile);
  const desktop = normalizeLayout(desktopRecord.items, normalizedItems);
  const mobile = normalizeLayout(mobileRecord.items, normalizedItems);
  const desktopById = layoutMap(desktop);
  const legacyArrangement = typeof src.arrangement === 'string' && src.arrangement
    ? src.arrangement : 'spiral';

  return {
    title: cleanBoardTitle(src.title) || 'Untitled board',
    view: {
      pan: { x: +src.view?.pan?.x || 0, y: +src.view?.pan?.y || 0 },
      zoom: +src.view?.zoom || 1,
    },
    // Board-level now; a file written before it moved here carries the style
    // under settings.mobileHeader, so that is the fallback source.
    mobileHeader: normalizeMobileHeader(src.mobileHeader ?? rawSettings.mobileHeader),
    titleHidden: !!src.titleHidden,
    mediaFit: normalizeMediaFit(src.mediaFit),
    paletteSources: normalizePaletteSources(src.paletteSources),
    sharedAppearance,
    layoutSettings: {
      desktop: desktopRecord.settings
        ? normalizeLayoutSettings(desktopRecord.settings, 'desktop', desktopSettings)
        : layoutSettingsOf(desktopSettings),
      mobile: mobileRecord.settings
        ? normalizeLayoutSettings(mobileRecord.settings, 'mobile', mobileSettings)
        : layoutSettingsOf(mobileSettings),
    },
    arrangements: {
      desktop: desktopRecord.arrangement || legacyArrangement,
      mobile: mobileRecord.arrangement || legacyArrangement,
    },
    layouts: {
      // `items` remains the Desktop-compatible representation. A file written
      // before profiles existed therefore already contains its desktop layout,
      // and an older reader opening a new file still sees the desktop board.
      desktop: normalizedItems.map(it => desktopById.get(it.id) || geometryOf(it)),
      mobile,
    },
    items: normalizedItems,
    trash: dedupeIds(trash.map(t => makeItem(t.item)), ids)
      .map((item, i) => ({ item, at: +trash[i].at || 0 })),
  };
}

function layoutRecord(raw) {
  if (Array.isArray(raw)) return { items: raw, settings: null, arrangement: '' };
  if (!raw || typeof raw !== 'object') return { items: [], settings: null, arrangement: '' };
  return {
    items: Array.isArray(raw.items) ? raw.items : [],
    settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : null,
    arrangement: typeof raw.arrangement === 'string' && raw.arrangement
      ? raw.arrangement : '',
  };
}

function normalizeLayoutSettings(raw, mode, fallback) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const base = settingsFor(layoutSettingsOf(fallback), {});
  const baseLook = base.appearance || {};
  const sourceLook = source.appearance && typeof source.appearance === 'object'
    ? source.appearance : {};
  return layoutSettingsOf(normalizeSettings({
    ...base,
    ...source,
    appearance: {
      ...baseLook,
      ...sourceLook,
      vars: { ...(baseLook.vars || {}), ...(sourceLook.vars || {}) },
    },
  }, mode));
}

function normalizeSettings(raw, mode) {
  const settings = raw && typeof raw === 'object' ? raw : {};
  const appearance = settings.appearance && typeof settings.appearance === 'object'
    ? settings.appearance : {};
  const vars = {
    ...(mode === 'mobile' ? MOBILE_APPEARANCE_VARS : {}),
    ...(appearance.vars && typeof appearance.vars === 'object' ? appearance.vars : {}),
  };
  return {
    ...DEFAULT_SETTINGS,
    snap: mode === 'mobile',
    ...settings,
    mobileColumns: mode === 'mobile'
      ? mobileColumnCount(settings.mobileColumns ?? MOBILE_COLUMNS)
      : DEFAULT_SETTINGS.mobileColumns,
    appearance: {
      ...(appearance.whimsy != null ? { whimsy: appearance.whimsy } : {}),
      palette: typeof appearance.palette === 'string' ? appearance.palette : '',
      vars,
      ...(appearance.auto === false ? { auto: false } : {}),
      ...(appearance.derived === true && Object.keys(vars).length ? { derived: true } : {}),
    },
    // Both names and hashes become declarations or asset paths downstream.
    fonts: normalizeFonts(settings.fonts),
    scale: clampScale(settings.scale),
    units: settings.units === 'imperial' ? 'imperial' : 'metric',
    paper: PAPERS.some(p => p.id === settings.paper) ? settings.paper : '',
    paperLandscape: !!settings.paperLandscape,
    paperResize: !!settings.paperResize,
  };
}

/**
 * The faces a board carries, reduced to the ones it may.
 *
 * `{ hash, family }` and nothing else - the hash names bytes in the asset store
 * and the family becomes a CSS family name, so a bad one of either is a bad
 * declaration or a dangling reference. Filtered entry by entry rather than
 * rejected wholesale, which is how everything else in this function behaves: a
 * board carrying four faces and one broken record should open with four.
 *
 * Capped, because this list is walked by the packer and registered against the
 * document, and neither wants a thousand entries out of a hand-written file.
 */
function normalizeFonts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    if (!isHash(f.hash) || seen.has(f.hash) || !isFamily(f.family)) continue;
    seen.add(f.hash);
    const font = { hash: f.hash, family: f.family };
    const axes = normalizeFontAxes(f.axes);
    if (axes.length) font.axes = axes;
    out.push(font);
    if (out.length >= MAX_FONTS) break;
  }
  return out;
}

/** Variable axes a font record may carry from its OpenType `fvar` table. */
function normalizeFontAxes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const axis of raw) {
    const tag = typeof axis?.tag === 'string' ? axis.tag : '';
    const min = +axis?.min, max = +axis?.max, fallback = +axis?.default;
    if (!/^[A-Za-z0-9 ]{4}$/.test(tag) || seen.has(tag)) continue;
    if (![min, max, fallback].every(Number.isFinite) || !(max > min)) continue;
    seen.add(tag);
    out.push({ tag, min, default: clamp(fallback, min, max), max });
    if (out.length >= MAX_FONT_AXES) break;
  }
  return out;
}

/** The Mobile title style, held to values its controls and CSS can represent. */
/** The board-wide media fit, defaulting to fit (contain) - fill is opt-in. */
function normalizeMediaFit(value) {
  return value === 'cover' ? 'cover' : 'contain';
}

/**
 * How many pictures the palette reads: [1, 24], or 0 for every one of them.
 *
 * Zero is past the top of the dial rather than below its bottom - the slider's
 * last stop reads "Every photo" - and it is stored as 0 because a number cannot
 * say "all" and the alternative was a second key saying it instead. 24 is the
 * highest *count* the sampler defaults to (MAX_SOURCES); asking for all of them
 * lifts that, which is the whole of what this option does.
 */
function normalizePaletteSources(value) {
  const n = Math.round(+value);
  if (!Number.isFinite(n)) return 12;
  return n === 0 ? 0 : Math.max(1, Math.min(24, n));
}

function normalizeMobileHeader(raw) {
  const header = raw && typeof raw === 'object' ? raw : {};
  const axes = {};
  if (header.axes && typeof header.axes === 'object') {
    for (const [tag, value] of Object.entries(header.axes)) {
      if (!/^[A-Za-z0-9 ]{4}$/.test(tag) || !Number.isFinite(+value)) continue;
      axes[tag] = +value;
      if (Object.keys(axes).length >= MAX_FONT_AXES) break;
    }
  }
  return {
    font: header.font === '' || isFamily(header.font) ? header.font : '',
    size: clamp(+header.size || DEFAULT_MOBILE_HEADER.size, 7, 24),
    // Half height to five times it. The top of that range already fills the
    // band and spills past what its overflow will show, which is a thing
    // somebody may well want on a title page; the floor is a floor because a
    // scaleY heading for 0 erases the name rather than styling it.
    stretch: clamp(+header.stretch || DEFAULT_MOBILE_HEADER.stretch, 50, 500),
    // 100 is `normal` - the face's own line height. See the default above.
    leading: clamp(+header.leading || DEFAULT_MOBILE_HEADER.leading, 60, 250),
    weight: clamp(Math.round(+header.weight || DEFAULT_MOBILE_HEADER.weight), 1, 1000),
    // Signed, so `|| 0` cannot swallow a real value - only 0 itself falls back
    // to 0, which is where it belongs. Half the band either way is enough to sit
    // the name against the top or bottom edge; further only pushes it out under
    // the band's own overflow clip.
    offset: clamp(Number.isFinite(+header.offset) ? +header.offset : 0, -50, 50),
    italic: !!header.italic,
    // Absent means on. Every board written before this setting existed wrapped
    // its name, and !!undefined would quietly turn that off for all of them.
    wrap: header.wrap !== false,
    axes,
  };
}

/** Matches MAX_FONTS in ui/fonts.js - the two are one limit in two layers. */
const MAX_FONTS = 8;
const MAX_FONT_AXES = 16;

/** The serialisable board, exactly as it lands in board.json. */
export function serializeBoard() {
  captureLayout();
  captureLayoutSettings();
  // Ghost cards never reach a file. They are onboarding hints the app puts on a
  // blank board, not anything of the user's, and a .mbrd carrying three of them
  // would hand them to whoever opened it - on a board that is by then no longer
  // empty, so nothing would ever take them away again. Stripping here rather
  // than at each of the three sinks below is what keeps the format from having
  // to know the type exists at all.
  const ghost = new Set(board.items.filter(i => i.type === 'ghost').map(i => i.id));
  const real = ghost.size ? board.items.filter(i => !ghost.has(i.id)) : board.items;
  const shed = list => (ghost.size ? list.filter(g => !ghost.has(g.id)) : list);
  const desktop = shed(completeLayout('desktop'));
  const mobile = shed(completeLayout('mobile'));
  const desktopSettings = settingsFor(board.layoutSettings.desktop, board.sharedAppearance);
  const desktopById = layoutMap(desktop);
  const itemIn = (item, geometry) => {
    const meta = { ...item.meta };
    if (geometry?.presnap) meta.presnap = { ...geometry.presnap };
    else delete meta.presnap;
    // Stamp the durable stick record. Measured now from live geometry, not read
    // from a stale field, so the file records where the note actually sits; a
    // load seeds the memo back from it. Null is a real answer and is kept.
    if (item.type === 'note') meta.stuckTo = stuckTo(item)?.id ?? null;
    return { ...item, ...(geometry || null), meta };
  };
  return {
    title: board.title,
    view: { pan: { ...board.view.pan }, zoom: board.view.zoom },
    // Board-level: the one style behind the Mobile masthead and the Desktop
    // title card. Also mirrored into settings below (see desktopSettings) so a
    // reader predating the move still finds it.
    mobileHeader: normalizeMobileHeader(board.mobileHeader),
    titleHidden: !!board.titleHidden,
    mediaFit: normalizeMediaFit(board.mediaFit),
    paletteSources: normalizePaletteSources(board.paletteSources),
    // Legacy readers see the Desktop half, matching the Desktop geometry kept in
    // items. New readers use each layout record below.
    settings: { ...desktopSettings, mobileHeader: normalizeMobileHeader(board.mobileHeader) },
    arrangement: board.arrangements.desktop,
    // Desktop stays in the traditional item fields for readers predating
    // profiles. New readers take the active geometry from `layouts`.
    items: real.map(item => serializeItem(itemIn(item, desktopById.get(item.id)))),
    layouts: {
      desktop: {
        items: desktop.map(serializeGeometry),
        settings: cloneSettings(board.layoutSettings.desktop),
        arrangement: board.arrangements.desktop,
      },
      mobile: {
        items: mobile.map(serializeGeometry),
        settings: cloneSettings(board.layoutSettings.mobile),
        arrangement: board.arrangements.mobile,
      },
    },
    // The bin travels with the board. Saving is the moment a board becomes a
    // file you might not open again for a month, and a bin that emptied itself
    // at exactly that moment would be a trapdoor rather than a safety net.
    trash: board.trash.map(t => ({ at: t.at, item: serializeItem(t.item) })),
  };
}

const serializeItem = i => ({
  id: i.id, type: i.type,
  x: round(i.x), y: round(i.y), w: round(i.w), h: round(i.h),
  rot: round(i.rot), z: i.z,
  name: i.name, asset: i.asset, meta: i.meta,
});

const serializeGeometry = geometry => ({
  id: geometry.id,
  x: round(geometry.x), y: round(geometry.y),
  w: round(geometry.w), h: round(geometry.h),
  rot: round(geometry.rot), z: geometry.z,
  ...(geometry.presnap ? {
    presnap: {
      x: round(geometry.presnap.x), y: round(geometry.presnap.y),
      w: round(geometry.presnap.w), h: round(geometry.presnap.h),
    },
  } : {}),
});

const round = n => Math.round(n * 100) / 100;
