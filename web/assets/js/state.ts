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
//   connections- a line between two cards was drawn or removed. Its own event
//                rather than riding on 'items', which was tempting and wrong:
//                every subscriber to that one would repaint for a change that
//                moved nothing and added nothing.

import { isHash, isRecord, itemHashes } from './util.ts';
import { toast } from './notify.ts';
import { cue } from './cuelume/engine.ts';
// Pure geometry, shared with the canvas and the input layer so that "where is
// this item and what does it cover" has exactly one answer in this app. Kept
// at the top level rather than under canvas/ because it depends on nothing and
// belongs to no one layer - see geometry.js.
import { latticeBox } from './geometry.ts';
import { splitAppearance, mergeAppearance } from './layout-settings.ts';
// The .mbrd format, one level down - see board-schema.js. Everything about the
// shape of a file, in both directions: what an arriving board is held to and
// what a saved one is written as. serializeBoard() is re-exported below under
// its old name; the four normalizers are this file's own working set, since
// setSetting() writes the same board-level fields the reader validates and the
// two must agree on what a legal value is.
import {
  normalizeBoard, normalizeFonts, normalizeMediaFit, normalizeMobileHeader,
  normalizePaletteSources, serializeBoard,
} from './board-schema.ts';

export { serializeBoard };

// The cards an empty board puts on itself, one level down - see onboarding.js.
// Hydration rather than mutation: no commit, no history, and two session
// latches that must survive an undo of the import that cleared them. Every name
// is re-exported below, because callers have always reached them through here.
import {
  GHOST_IDS, NOTFOUND_IDS, tapeFor, hasContent, hasGhosts, isNotFoundBoard,
  leaveNotFoundBoard, ensureGhostCards, dismissGhosts, resetGhostLatch,
  reseedGhostCards,
} from './onboarding.ts';

export {
  GHOST_IDS, NOTFOUND_IDS, tapeFor, hasContent, hasGhosts, isNotFoundBoard,
  leaveNotFoundBoard, ensureGhostCards, dismissGhosts, resetGhostLatch,
  reseedGhostCards,
};

// The internal clipboard, one level down - see clipboard.js. Nothing in it
// touches the board, which is exactly why it could go: the clipboard is not
// board state, it is not saved and there is nothing about it to undo. The two
// commands that *do* touch the board - cut and paste - stayed here.
import {
  clearClipboard, clipboardBounds, clipboardHasOurs, clipboardSize, cloneItem,
  copyItems, itemCount, itemsIn, pasteCopies, takeItems,
} from './clipboard.ts';

export { clipboardBounds, clipboardHasOurs, clipboardSize, copyItems };

// The bin, one level down - see trash.js. Delete and restore are two directions
// of one door and they sat four hundred lines apart in here; the bin's bound is
// in board-model.js beside MAX_ITEMS, because it is part of the board's shape
// and the file reader applies it too.
// setAssetPurge is the seam emptying it needs: the bin destroys the files it
// was holding, and the registry that holds them is a layer above this one.
// main.ts wires it, the same shape as setAssetNameLookup() below.
import { removeItems, restoreItems, emptyTrash, setAssetPurge } from './trash.ts';

export { removeItems, restoreItems, emptyTrash, setAssetPurge };
// Downward: the catalogue is pure - geometry.js and nothing else - and this is
// the one thing state needs from it, which of the two lists a stored
// arrangement id belongs to. See tests/layers.test.js, where it is BASE.
// The floor this file stands on. Both were declared here until state.js was
// split; they are re-exported below under exactly their old names, because
// "state.js is the only door" is a rule about where mutations go and not about
// which file a symbol happens to be declared in. See board-store.js.
import {
  bus, selection, isDirty, markDirty, resetDirty,
  select, clearSelection, deselect, tagFilter, setTagFilter,
  isMultiSelect, setMultiSelect, resetMultiSelect,
} from './board-store.ts';
import {
  commit, undo, redo, historyState, historyDepth, historyWeight,
  clearHistory, lastCommand, takeBack,
} from './history.ts';
// The step ledger, one level down again - see timeline.js. Nothing above this
// file drives it: commit() records, undo() and redo() move the marker, and what
// is re-exported here is the reading half plus the two doors a *file* needs.
import {
  adoptTimeline, timelineSteps, timelineAt, timelineStale, timelineHashes, goTo,
  nameStep, declareOp, registerOp, editStep, rebuildFrom, stepEditable,
  timelineBytes, trimmable, trimTimeline, TRIM_BYTES, TRIM_DAYS,
  replayTo, serializeTimeline, describeStep,
} from './timeline.ts';

export {
  timelineSteps, timelineAt, timelineStale, timelineHashes, replayTo, goTo,
  nameStep, declareOp, registerOp, editStep, rebuildFrom, stepEditable,
  timelineBytes, trimmable, trimTimeline, TRIM_BYTES, TRIM_DAYS,
  serializeTimeline, describeStep,
};

export { bus, selection, isDirty, markDirty, select, clearSelection, deselect };
export { tagFilter, setTagFilter };
export { isMultiSelect, setMultiSelect };
export { commit, undo, redo, historyState, historyDepth, historyWeight, lastCommand, takeBack };

// The board's shape and its index, one level down - see board-model.js. The
// first group is re-exported because callers have always imported these from
// state.js; the second is this file's own working set, internals of the model
// that the mutation rules above them are written in terms of.
import {
  NOTE_MAX, DEFAULT_MOBILE_HEADER, DEFAULT_SETTINGS, BOARD_MODES, BOARD_TITLE_MAX,
  MOBILE_COLUMNS, MOBILE_COLUMN_OPTIONS, MOBILE_TOP_ROWS, MOBILE_MIN_ROWS,
  MOBILE_BOTTOM_ROWS, MOBILE_APPEARANCE_VARS, cleanBoardTitleDraft, cleanBoardTitle,
  defaultBoardTitle, isDefaultTitle, mobileColumnCount, board, TITLE_ID, byId,
  topZ, makeItem, isFurniture, isContent, isJoinEnd, trackTitle,
} from './board-model.ts';
import {
  cloneSettings, layoutSettingsOf, dropIdIndex,
  MAX_CONNECTIONS, pairKey, normalizeAudioOrder, CONN_DIRECTIONS, CONN_STYLES,
} from './board-model.ts';
// The five readers the per-item settings below are written in terms of. Each is
// the *same* function the file reader and every consumer uses, which is what
// keeps "what this app will store" and "what a reader will get back" one answer
// rather than two that agree today - see setItemCrop().
import {
  isLocked, isFiltered, itemCrop, itemAdjust, adjustFilter, itemFlip, flipTransform,
  itemTags, boardTags, cleanTag,
  normalizeTour, TAGS_PER_ITEM, TAG_MAX, MIN_CROP,
} from './board-model.ts';
import type { Item } from './board-model.ts';
import type { MergePlan } from './merge.ts';

export { MAX_CONNECTIONS, pairKey, CONN_DIRECTIONS, CONN_STYLES };
export { isLocked, isFiltered, itemCrop, itemAdjust, adjustFilter, itemFlip, flipTransform };
export { itemTags, boardTags, cleanTag };
export { TAGS_PER_ITEM, TAG_MAX, MIN_CROP };

// Every write to board.connections, one level down - see connections.js. The
// shape of a connection stayed in board-model.js and the pruning stayed in
// board-schema.js; what moved is the mutation half, which is all of it that had
// to sit beside commit(). Re-exported by name: callers have always drawn and
// parted lines through state.js.
import {
  areConnected, connectedTo, toggleConnection, addConnections, clearConnections,
  updateConnection, connectionMeta,
} from './connections.ts';

export {
  areConnected, connectedTo, toggleConnection, addConnections, clearConnections,
  updateConnection, connectionMeta,
};

// Stuckness, one level down - see sticky.js. Questions about geometry; the
// mutations that act on their answers are here.
import {
  STICK_MIN, stuckTo, wouldStick, restick, forgetSticks, seedSticks,
  stuckPlacement, isRider, stuckFollowers, isPinned, dragRoot, hostUnder, isSticky,
  startSettling, isSettling, settlesIn, SETTLE_MS,
} from './sticky.ts';

// Fence membership, one level down - see fences.js. Same bargain as sticky.js:
// a question about where two things are, measured and remembered here, acted on
// there.
import {
  isFence, fenceOf, fenceAt, fenceMembers, fenceFollowers, refence, refenceAround,
  refenceArrivals, forgetFences, seedFences, fenceBox, nextFenceName,
} from './fences.ts';

// The sticker catalogue - a leaf module of plain data, imported here for the
// one thing a mutator has to do with it: hold an arriving tint to the palette
// that exists.
import { stickerTint } from './stickers/catalogue.ts';

// Where everything is - see layout.js. The Mobile pack, the two geometry
// profiles and the undoable geometry writes, which had to move as one piece
// because the pack and the profiles call each other.
import {
  activateLayoutSettings, applyGeom, baseStep, commitGeom, completeLayout, fitBoardMode, mobileBoardWidth, placeMobileItems, recheckBoardGeometry, repackMobileBoard, snapAll, snapshotGeom, travelling, unsnapAll, writeLayout,
} from './layout.ts';

// Board-wide snapping moved down with the rest of the geometry writes - see the
// tail of layout.js. setSetting() still owns the `snap` key and hands the value
// over; snapAll/unsnapAll take the flag as well as the sweep, because the two
// are one command (an undo that put the board back and left the checkbox ticked
// was the bug that made them one).
export { recheckBoardGeometry };

// Z-order - see stacking.js. Sticky notes are ordered against their host rather
// than against the board, which is why this is not a sort by z.
export { raiseSelection, lowerSelection, stackOrder, visualStackOrder, stackLayerIds, selectionHasStackOverlap } from './stacking.ts';

// Re-exported, not used here: these four are the layout module's public face
// and callers have always reached for them through state.js.
export {
  setBoardMode, mobileBoardTop, mobileBoardBottom, mobileBoardWorldWidth,
} from './layout.ts';

export { baseStep, snapshotGeom, applyGeom, commitGeom, placeMobileItems, mobileBoardWidth, travelling };
// applyGeom()'s argument type, through the same door as applyGeom itself: a
// caller in ui/ that builds a patch has to be able to name what it is building,
// and layout.ts is below the line ui/ may import from.
export type { GeomPatch } from './layout.ts';

export {
  STICK_MIN, stuckTo, wouldStick, restick, forgetSticks,
  stuckPlacement, isRider, stuckFollowers, isPinned, dragRoot, isSticky,
  startSettling, isSettling, settlesIn, SETTLE_MS,
};

export {
  isFence, fenceOf, fenceAt, fenceMembers, fenceFollowers, refence, refenceAround,
  forgetFences, fenceBox, nextFenceName,
};

export {
  NOTE_MAX, DEFAULT_MOBILE_HEADER, DEFAULT_SETTINGS, BOARD_MODES, BOARD_TITLE_MAX,
  MOBILE_COLUMNS, MOBILE_COLUMN_OPTIONS, MOBILE_TOP_ROWS, MOBILE_MIN_ROWS,
  MOBILE_BOTTOM_ROWS, MOBILE_APPEARANCE_VARS, cleanBoardTitleDraft, cleanBoardTitle,
  defaultBoardTitle, isDefaultTitle, mobileColumnCount, board, TITLE_ID, byId,
  topZ, makeItem, isFurniture, isContent, isJoinEnd, trackTitle,
};



// The filename an asset first arrived under lives in the asset registry, which
// sits *above* state in the layering - storage depends on state, not the other
// way. So renameItem's oldest fallback is injected here rather than imported:
// main.js wires this to storage/assets.js at startup. Left unset - in a test,
// or before wiring - the fallback just skips to the item's current name, which
// is the same answer the registry gives for an asset it has never seen. See
// AUD-12.
/** The filename an asset arrived under, from whoever holds the registry. */
type AssetNameLookup = (hash: string) => string | undefined;

let assetName: AssetNameLookup = () => undefined;
export function setAssetNameLookup(fn: AssetNameLookup | null | undefined) {
  assetName = typeof fn === 'function' ? fn : () => undefined;
}


// ---------------------------------------------------------------------------
// Item mutations (all undoable)
// ---------------------------------------------------------------------------

export function addItems(
  items: Record<string, unknown>[],
  label = 'Add',
  options: { avoidOverlap?: boolean } = {},
) {
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
  // A fence arriving changes what everything under it belongs to, and only this
  // says so - see refenceArrivals(). In the redo half rather than beside it, for
  // the reason commitGeom() gives at length: commit() runs redo immediately, so
  // this covers the first add and every redo after it, while the undo half is a
  // removal, which heals on its own.
  commit(label,
    () => { const fresh = added.filter(a => !byId(a.id));
            board.items.push(...fresh);
            refenceArrivals(added);
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
function onLattice(it: Item): Item {
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

function makeTitleItem(at: { x?: number, y?: number } | null = null) {
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

/** Copy items, offset a little so the copy is visibly on top of the original. */
export function duplicateItems(ids: Iterable<string>, offset = { x: 28, y: -28 }) {
  const src = itemsIn(ids);
  if (!src.length) return [];
  const copies = src.map(i => cloneItem(i, offset.x, offset.y));
  return addItems(copies, copies.length > 1 ? `Duplicate ${copies.length} items` : 'Duplicate');
}

// ---------------------------------------------------------------------------
// The two clipboard commands that touch the board
//
// Everything else about the clipboard is in clipboard.js: what is held, what a
// copy of an item is, the receipt that tells our own paste from somebody
// else's. These two are here because they are board mutations - one deletes and
// one adds - and every board mutation is one undoable command with a label,
// which is what this file is for. See the head of clipboard.js for the seam.
// ---------------------------------------------------------------------------

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
export function cutItems(ids: Iterable<string>) {
  // Resolved once and reused for both the copy and the delete, rather than
  // letting copyItems() resolve them again - two full board filters + sorts.
  // That is also why this calls takeItems() rather than copyItems(): the latter
  // toasts, and two toasts in the same turn are not two messages, since the
  // second replaces the first inside a frame.
  const src = itemsIn(ids);
  const text = takeItems(src);
  if (!text) return '';
  const doomed = src.map(i => i.id);
  removeItems(doomed, doomed.length > 1 ? `Cut ${doomed.length} items` : 'Cut');
  toast(`Cut ${itemCount(doomed.length)} to the bin`);
  return text;
}

/**
 * Put the internal clipboard on the board.
 *
 * `at` is an optional world point to centre the pasted group on - see
 * pasteCopies(), which owns that arithmetic and the step that accumulates
 * across repeated pastes. This half is the undoable one: one command, one
 * label, one Ctrl+Z for the whole group however many items it holds.
 */
export function pasteItems(at: { x: number, y: number } | null = null) {
  const copies = pasteCopies(at);
  if (!copies.length) return [];
  const added = addItems(copies, copies.length > 1 ? `Paste ${copies.length} items` : 'Paste');
  // Worth saying even though the copies are visible: a paste that lands under
  // the pointer looks like a paste, but one that fanned out from an original
  // off the edge of the screen can put every copy somewhere you are not
  // looking, and then a working paste and a dead key are the same event.
  toast(`Pasted ${itemCount(added.length)}`);
  return added;
}


/**
 * A note's name is its first line, capped - the copy Search reads (ui/search.js).
 * It is taken at creation (import/drop.js) and has to be re-taken on every edit,
 * or Find keeps matching and showing the title the note had when it was made.
 */
const noteName = (text: string) => text.split('\n')[0].slice(0, 40) || 'Note';

export function setItemText(id: string, text: string) {
  const it = byId(id);
  if (it?.type === 'note') text = text.slice(0, NOTE_MAX);
  if (!it || it.meta.text === text) return;
  const prev = it.meta.text;
  const isNote = it.type === 'note';
  const prevName = it.name;
  const nextName = isNote ? noteName(text) : it.name;
  commit('Edit note',
    () => { const x = byId(id); if (!x) return; x.meta.text = text; x.name = nextName; bus.emit('item', id); },
    () => { const x = byId(id); if (!x) return; x.meta.text = prev; x.name = prevName; bus.emit('item', id); });
}

/**
 * Recolour a swatch: its `meta.hex` and the name it wears, as one step.
 *
 * The two are one fact. A swatch has no name of its own to lose - it is a
 * colour and the number for it - so the number *is* the name, which is what
 * makes a swatch findable in the palette (ui/search.js reads names) and what
 * puts something readable on the system clipboard when one is copied
 * (summarise(), above, falls back to the name for every type but note and
 * link). Writing them in one commit is the same reasoning applySnapState() uses
 * for the snap flag and the geometry: one act by the user should be one Ctrl+Z,
 * and a state where the two disagree is one nobody could have produced by hand.
 *
 * The value arrives from an `<input type="color">`, which can only ever hand
 * over `#rrggbb` - but it also arrives from a .mbrd, so it goes through the
 * same gate the renderer reads it back through rather than being trusted here.
 * That gate is canvas/renderers.js, which sits *above* this file, so the check
 * is repeated in miniature rather than imported: six hex digits or nothing
 * happens. A bad value is dropped, not stored and quietly corrected on the way
 * out - the board should not hold a colour it will not show.
 */
export function setSwatchHex(id: string, hex: unknown) {
  const it = byId(id);
  if (!it || it.type !== 'swatch') return;
  const next = String(hex ?? '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(next)) return;
  const prevHex = it.meta?.hex;
  const prevName = it.name;
  if (prevHex === next) return;
  const write = (value: unknown, name: string) => {
    const item = byId(id);
    if (!item) return;
    // Undefined is a real previous value - a swatch out of a hand-written file
    // may carry no hex at all - and setting the key to `undefined` rather than
    // removing it would leave the board holding a field it does not have. Same
    // shape setItemCover() uses to take a picture away.
    if (value === undefined) { const { hex: _drop, ...rest } = item.meta || {}; item.meta = rest; }
    else item.meta = { ...item.meta, hex: value };
    item.name = name;
    bus.emit('item', id);
  };
  commit('Recolour swatch',
    () => write(next, next.toUpperCase()),
    () => write(prevHex, prevName));
}

/**
 * Commit a note's formatted content - the structured `meta.rich` and the
 * plaintext `meta.text` it flattens to - as one undoable step, so a single Ctrl+Z
 * takes back the whole edit rather than the two halves separately. A no-op when
 * neither half moved, which is what keeps closing an editor you only looked at
 * from spending a history slot. `rich` is trusted to be normalised by the caller
 * (canvas/notes.js), and `text` is capped here the way setItemText caps its own.
 */
export function setNoteContent(id: string, rich: unknown, text: unknown) {
  const it = byId(id);
  if (!it || it.type !== 'note') return;
  // Into its own binding rather than back over the parameter, so what the pair
  // below writes is the capped string rather than whatever arrived.
  const next = String(text ?? '').slice(0, NOTE_MAX);
  const prevRich = it.meta.rich;
  const prevText = it.meta.text;
  const prevName = it.name;
  if (prevText === next && JSON.stringify(prevRich) === JSON.stringify(rich)) return;
  const write = (t: string, r: unknown, nm: string) => {
    const x = byId(id);
    if (!x) return;
    const m = x.meta;
    m.text = t;
    if (r === undefined) delete m.rich;
    else m.rich = r;
    x.name = nm;
    bus.emit('item', id);
  };
  // `text` has been through String() above, so it is one; the two previous
  // values came off the item's meta, which is unknown per key by design.
  const wasText = typeof prevText === 'string' ? prevText : '';
  const wasName = typeof prevName === 'string' ? prevName : '';
  commit('Edit note',
    () => write(next, rich, noteName(next)),
    () => write(wasText, prevRich, wasName));
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
export function retypeItem(
  id: string, next: Record<string, unknown>, label = 'Change item',
) {
  const old = byId(id);
  if (!old) return null;
  const item = makeItem({ x: old.x, y: old.y, rot: old.rot, z: old.z, ...next });
  const swap = (out: Item, into: Item) => {
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
export function renameItem(id: string, name: unknown) {
  const it = byId(id);
  if (!it) return;
  // The two fallbacks are strings or nothing: `origName` is `unknown` per key
  // like every meta field (see board-model.ts), and the registry answers
  // undefined for an asset it has never seen.
  const orig = typeof it.meta?.origName === 'string' ? it.meta.origName : '';
  const next = String(name ?? '').trim() ||
               orig ||
               (it.asset?.hash ? assetName(it.asset.hash) : '') || it.name;
  if (it.name === next) return;
  const prev = it.name;
  // byId() again inside the pair, and non-null: the item was on the board when
  // this was built, and a command whose item has gone is not replayed - the
  // removal that took it away is the entry above this one in the history.
  commit('Rename',
    () => { byId(id)!.name = next; bus.emit('item', id); },
    () => { byId(id)!.name = prev; bus.emit('item', id); });
}

/**
 * One undoable write to one key of one item's `meta`.
 *
 * Four setters below were the same fourteen lines with the key name changed -
 * cover, upAxis, fit and tint. The tell was setItemFit(), which had to rename
 * its destructured key to `fit: _drop` to keep the removal branch from
 * shadowing its own parameter: a rename that only exists because the shape was
 * copied rather than shared.
 *
 * `validate` is what each caller keeps for itself, and it is the only part that
 * genuinely differed. It runs twice - over the arriving value and over what the
 * item already holds - so the *same* rule decides both, which is what makes the
 * no-op check honest: a board out of a hand-written file may be carrying a
 * value this app would refuse, and comparing a validated `next` against a raw
 * `prev` would record a history entry for a change that never happened. Null
 * means "no value", and writing one removes the key rather than setting it to
 * null: the board should not hold a field it does not have.
 *
 * `label` may be a function of the validated value, for the one setter whose
 * two directions are different acts - setting a picture and removing one.
 *
 * `same` is how "no change" is decided, and it defaults to Object.is because
 * every value this started with was a scalar. Two of the later ones - a crop
 * rectangle and the three picture adjustments - are validated into fresh
 * objects, which are never identical however equal they are, so those hand in a
 * comparator of their own. Passing the comparator rather than canonicalising to
 * a string keeps the stored value the shape the rest of the app reads.
 *
 * The **type** guard stays at each call site rather than folding in here. It is
 * a different question: a validator says whether a value is legal, and the
 * guard says whether this item is the kind of thing the setting is about, and
 * running them together would let a bad value on the right kind of item look
 * like the wrong kind of item.
 *
 * The item is looked up again inside the write rather than captured, because
 * undo may be pressed long after the item was replaced - see retypeItem().
 *
 * Deliberately **not** used by setItemThumb() or setItemPoster(). Those two are
 * non-undoable on purpose and their headers say why; folding them in would make
 * the shared shape decide something it has no business deciding.
 *
 * Generic in what the validator answers, which is the one type here worth
 * naming. `raw` is unknown because it comes off a file or a console, but what
 * comes *out* of the validator is the setting's own type, and `label` and
 * `same` are both handed it - so a caller whose validator answers a tint and
 * whose comparison expects a rectangle is a mistake this signature catches.
 */
function patchMeta<T>(
  id: string,
  key: string,
  raw: unknown,
  label: string | ((next: T) => string),
  validate: (value: unknown) => T,
  same: (a: T, b: T) => boolean = Object.is,
) {
  const it = byId(id);
  if (!it) return;
  const next = validate(raw);
  const prev = validate(it.meta?.[key]);
  if (same(next, prev)) return;
  const write = (value: unknown) => {
    const item = byId(id);
    if (!item) return;
    if (value == null) { const { [key]: _drop, ...rest } = item.meta || {}; item.meta = rest; }
    else item.meta = { ...item.meta, [key]: value };
    bus.emit('item', id);
  };
  commit(typeof label === 'function' ? label(next) : label,
    () => write(next), () => write(prev));
}

/** A validator over a closed set: the value, or null for anything else. */
const oneOf = (...allowed: unknown[]) =>
  (value: unknown) => (allowed.includes(value) ? value : null);

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
 * Wider than what the interface offers on purpose. The right-click menu asks
 * for a picture on a track and nowhere else (canCoverItem, commands.js), and
 * the importer sets one from a file's own art or a video's poster frame - but
 * a cover put on any card by an older build, or by the console, is a valid
 * board and draws. Narrowing this as well would turn those into a repair job.
 *
 * Only the *reference* is undoable. The bytes stay in the registry either way,
 * because undo has to be able to put the picture back and the autosave sweep
 * is what eventually collects anything no item points at.
 */
export function setItemCover(id: string, hash: unknown) {
  patchMeta(id, 'cover', hash,
    next => (next ? 'Set picture' : 'Remove picture'),
    value => (isHash(value) ? value : null));
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
export function setItemThumb(id: string, hash: unknown) {
  const it = byId(id);
  if (!it || !isHash(hash) || it.meta?.thumb === hash) return;
  it.meta = { ...it.meta, thumb: hash };
  bus.emit('item', id);
  markDirty();
}

/**
 * Give a video the frame it was cut from, if it has nothing to show yet.
 *
 * The same slot as setItemCover(), and deliberately not the same function. A
 * poster is derived output the way a thumbnail is - the clip's own first frame,
 * cut so a card is a picture of itself rather than a black rectangle before it
 * is played - so it is not undoable, for exactly the reasons spelled out above
 * setItemThumb(). Made at import (import/drop.js) and repaired by the optimiser
 * for boards saved before posters existed.
 *
 * The refusal is the important half: a clip that already carries a cover keeps
 * it, whether that came from a previous cut or from somebody choosing a picture
 * by hand. This can add a picture to a card that has none; it can never replace
 * one, which is what keeps a non-undoable write safe to make.
 *
 * `dangling` is the one exception, and it is not a loosening of that rule - it
 * is the rule applied to what a cover *is*. A hash whose bytes are not in the
 * registry is not a picture, it is a reference to one: it draws nothing, and an
 * item restored from an archive that was missing a file carries one. Left
 * refused, such a card could never be repaired by anything - not by import, not
 * by the optimiser, not by the idle backfill - because all three ask "has it got
 * a cover" of the *hash* while the card on screen stays blank. Both repair
 * passes already establish the difference with getAsset() before they cut a
 * frame, which is why the caller says so rather than this asking: state.ts sits
 * under storage/ and may not look in the registry itself (tests/layers.test.js).
 */
export function setItemPoster(id: string, hash: unknown, dangling = false) {
  const it = byId(id);
  if (!it || !isHash(hash)) return;
  if (isHash(it.meta?.cover) && !dangling) return;
  it.meta = { ...it.meta, cover: hash };
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
 * Each swap is `{ id, asset, cover }`, and each field says one of three things:
 * a hash replaces what is there, `null` takes the reference away, and absent
 * leaves it exactly as it was. Items that were *considered* and left alone
 * belong in the list too, with neither field: they still get marked, and
 * marking them is the whole point of listing them.
 *
 * `null` is what the optimiser does with a file of zero bytes. That is a
 * removal rather than a re-encode - there is nothing to shrink and nothing to
 * draw - and it goes through here rather than through its own command so that a
 * run is still one undoable step, which is the promise below.
 *
 * One item's exchange, as the optimiser hands it over: the card, the bytes it
 * should point at now, and the picture it should wear. A hash swaps it, null
 * takes it away, and anything else - the field left out entirely - leaves that
 * half of the item alone.
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
export type AssetSwap = { id: string, asset?: string | null, cover?: string | null };

export function swapAssets(swaps: AssetSwap[] | null | undefined, label = 'Optimize board') {
  const list = (swaps || []).filter(s => s && byId(s.id));
  if (!list.length) return 0;

  // Non-null throughout this function: the filter above kept only swaps whose
  // item is on the board, and nothing between here and the commit removes one.
  const before = list.map(({ id }) => {
    const it = byId(id)!;
    return { id, asset: it.asset ? { ...it.asset } : null, meta: { ...it.meta } };
  });

  // A run that found nothing worth rewriting still learned something, and the
  // marks are how it remembers - but they are bookkeeping about work done, not
  // a change to the board, so they go on outside the undo stack. Committing
  // them would put an entry on the history that looks like nothing happened,
  // because nothing did, and spend one of the steps the user has left.
  const swapping = list.some(({ id, asset, cover }) => {
    const it = byId(id)!;
    return (isHash(asset) && it.asset?.hash && asset !== it.asset.hash) ||
           (isHash(cover) && isHash(it.meta?.cover) && cover !== it.meta.cover) ||
           (asset === null && !!it.asset) ||
           (cover === null && isHash(it.meta?.cover));
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
      // null means take the reference away rather than point it somewhere else.
      // The bytes are still pinned by `was` for as long as the undo can reach
      // them, exactly as a re-encode pins its original - the sweep would
      // otherwise collect them the next time the board saved, and undo would
      // hand back a hash with nothing behind it.
      if (asset === null && it.asset?.hash) {
        if (!isHash(meta.was)) meta.was = it.asset.hash;
        it.asset = null;
      } else if (isHash(asset) && it.asset?.hash && asset !== it.asset.hash) {
        // Only the first swap records an original. Optimising twice must not
        // leave `was` pointing at the *previous* optimisation, or undoing once
        // would restore a file that is itself already re-encoded.
        if (!isHash(meta.was)) meta.was = it.asset.hash;
        it.asset = { ...it.asset, hash: asset };
      }
      if (cover === null && isHash(meta.cover)) {
        if (!isHash(meta.wasCover)) meta.wasCover = meta.cover;
        delete meta.cover;
      } else if (isHash(cover) && isHash(meta.cover) && cover !== meta.cover) {
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
export function setItemUpAxis(id: string, axis: unknown) {
  patchMeta(id, 'upAxis', axis, 'Turn model upright', oneOf('z', 'y'));
}

/**
 * One image or video's own fit, overriding the board-wide default. 'cover' fills
 * and crops, 'contain' fits the whole picture in; both are explicit, so once set
 * the card no longer follows the board default (that is what an override is for).
 * Undoable and emits 'item', which rebuilds the node so canvas/renderers.js's
 * fitMode() reads the new value - the same shape setItemUpAxis uses.
 */
export function setItemFit(id: string, fit: unknown) {
  const it = byId(id);
  if (!it || (it.type !== 'image' && it.type !== 'video')) return;
  patchMeta(id, 'fit', fit, 'Fit media', oneOf('cover', 'contain'));
}

/**
 * One image's card, on or off. True means *draw no card*: no paper, no
 * hairline, no shadow - just the picture.
 *
 * For a cut-out. A logo, a leaf, an arrow saved with a transparent background
 * was cut out precisely so it would sit *on* the board rather than in a box, and
 * the box was being drawn round its bounding rectangle, which for a cut-out is
 * mostly empty. The result is a frame round nothing with a picture somewhere
 * inside it.
 *
 * Nothing new is being drawn here: a sticker has had no card since stickers
 * existed. This is the flag that says which of the two an image is, and it is a
 * flag rather than a guess because the guess belongs at import (see drop.js) and
 * has to be overridable. Whatever the person chooses wins and is what gets
 * saved.
 *
 * **Images only, and that is the type guard rather than an accident.** A note
 * without its paper is text lying on the board with nothing holding it, and a
 * video without its card loses the surface its controls sit on.
 *
 * The card that is removed is the *paint*. The box stays exactly where it was:
 * hit-testing, the marquee, the selection ring and the resize grips all measure
 * that rectangle, and an item you cannot select or resize would be a worse bug
 * than the one this fixes.
 */
export function setItemBare(id: string, bare: unknown) {
  const it = byId(id);
  // The two types that have a card to lose - see canSetBare() in
  // commands/item-meta.ts, which is the same list and says why. Guarded here as
  // well because this is the door: a `bare` flag on a sticker or a fence would
  // be a byte in the file that nothing draws and nothing can take off again.
  if (!it || (it.type !== 'image' && it.type !== 'note')) return;
  // Stored only when true, which is what the null branch of patchMeta's write()
  // is for: `bare: false` on every ordinary photograph would be a byte per card
  // in every file to say that nothing is unusual.
  patchMeta(id, 'bare', bare ? true : null,
    (next: unknown) => (next ? 'Remove card' : 'Restore card'), v => (v === true ? true : null));
}

/**
 * One sticker's colour. The palette is an override of the shape's own default,
 * not a lottery - see the head of stickers/catalogue.js on why a heart is born
 * red rather than taking whatever came next off a cycle.
 *
 * Held to the palette that exists on the way in, because the value ends up as a
 * data-tint attribute the stylesheet keys eight rules off, and a number outside
 * that set is a sticker with no colour at all. Emits 'item', which rebuilds the
 * node - the same shape setItemFit uses, and the tint is read on the way out of
 * canvas/items.js rather than by the renderer.
 */
export function setStickerTint(id: string, tint: unknown) {
  const it = byId(id);
  if (!it || it.type !== 'sticker') return;
  // The one validator that always answers, so the removal branch of patchMeta()
  // is unreachable here: a sticker with no tint of its own is a sticker wearing
  // its shape's default, which is a colour and not an absence.
  patchMeta(id, 'tint', tint, 'Sticker colour',
    value => stickerTint(value, it.meta?.shape));
}

/**
 * Fix a selection's geometry in place, or let it go again.
 *
 * One history entry for the whole set, the shape unstickItems() uses and for
 * the same reason: locking nine cards is one thing somebody did, and nine
 * entries would make Ctrl+Z walk back through them one at a time.
 *
 * Written on any *type*: a fence, a note, a sticker and a photograph are all
 * things somebody may want to stop moving, so there is no narrowing by type
 * here. The two exclusions are about the item's situation rather than its kind.
 *
 * Furniture, which has no menu to ask from and whose geometry the app owns.
 *
 * And a **rider** - a note or a sticker stuck to a host - which has no geometry
 * of its own to fix: it is placed from its host every time the host moves. A
 * drag carries the riders of what it picked up and then drops the anchored ones
 * out of the travelling set, so an anchored sticky was left behind by the very
 * card it is stuck to. The exclusion is at this door as well as in lockable()
 * (commands/item-meta.ts), which is where the note explaining it lives, because
 * the menu row is not the only caller: lockSelection() hands over the whole
 * selection, so a photograph picked with its own sticky would otherwise anchor
 * both. Same rule at the door as in the offer - the arrangement setItemsTagged()
 * and taggable() already use.
 *
 * What a lock actually stops is in isLocked()'s note in board-model.ts: the
 * geometry, and nothing else. This function is the only writer.
 */
export function setItemsLocked(ids: Iterable<string>, locked: boolean) {
  const affected = [...new Set(ids)].filter(id => {
    const it = byId(id);
    return !!it && !isFurniture(it) && !isRider(it) && !!it.meta.locked !== locked;
  });
  if (!affected.length) return;
  const write = (on: boolean) => {
    for (const id of affected) {
      const it = byId(id);
      if (!it) continue;
      if (on) it.meta = { ...it.meta, locked: true };
      else { const { locked: _drop, ...rest } = it.meta || {}; it.meta = rest; }
      bus.emit('item', id);
    }
  };
  const many = affected.length > 1 ? ` ${affected.length} items` : '';
  // The words a person reads in the Timeline and in the undo toast, so they are
  // the menu's words - Anchor, not Lock. `meta.locked` above is the stored key
  // and stays: it is in every .mbrd ever written. See the note beside the menu
  // row in ui/menu.ts for why the label moved and the key did not, and
  // HISTORY_ICONS in ui/timeline-view.ts, which is keyed off these two strings
  // and has to be changed in step with them.
  commit((locked ? 'Anchor' : 'Unanchor') + many,
    () => write(locked), () => write(!locked));
}

/**
 * One picture's crop rectangle, or null to show the whole of it again.
 *
 * Four fractions of the source - see itemCrop() in board-model.ts for why
 * fractions and not pixels, and for why this never touches the bytes. The
 * validator is itemCrop() itself rather than a private copy, so the value that
 * reaches the file is exactly the value every reader will get back out of it;
 * it takes an item-shaped thing, so the raw rectangle is wrapped in one.
 *
 * Emits 'item', which rebuilds the card - the same route setItemFit() takes,
 * and the crop is applied one layer further down when the display copy is made
 * rather than by any renderer.
 */
export function setItemCrop(id: string, crop: unknown) {
  const it = byId(id);
  // Pictures only, where the three adjustments below take video too. The
  // asymmetry is not a policy, it is what the two are made of: an adjustment is
  // a CSS filter and the compositor will grade a video frame as happily as a
  // still, while a crop is a rectangle drawn out of a decoded bitmap and there
  // is no decoded bitmap for a clip until it is playing. Cropping video wants a
  // second mechanism, not a wider guard here.
  if (!it || it.type !== 'image') return;
  patchMeta(id, 'crop', crop, next => (next ? 'Crop' : 'Undo crop'),
    value => itemCrop({ meta: { crop: value } }), sameRect);
}

/** Two crop rectangles, or two absences, are the same crop. */
const sameRect = (a: unknown, b: unknown) => {
  if (!isRecord(a) || !isRecord(b)) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
};

/**
 * One picture's brightness, contrast and saturation, or null to put it back.
 *
 * Partial: what arrives is spread over what the item already carries, so the
 * three dials in the panel can each write their own without reading the other
 * two. itemAdjust() then decides whether what came out is an adjustment at all,
 * and a set that is neutral on all three removes the key rather than storing
 * three ones.
 */
export function setItemAdjust(id: string, adjust: unknown) {
  const it = byId(id);
  if (!it || (it.type !== 'image' && it.type !== 'video')) return;
  // The incoming set is hoisted out of the literal rather than spread through a
  // ternary: `adjust` is whatever a caller passed, and naming the non-record
  // case is what says out loud that it contributes nothing.
  const patch = isRecord(adjust) ? adjust : {};
  const merged = adjust == null ? null : {
    ...(itemAdjust(it) || { brightness: 1, contrast: 1, saturation: 1 }),
    ...patch,
  };
  patchMeta(id, 'adjust', merged, next => (next ? 'Adjust picture' : 'Reset picture'),
    value => itemAdjust({ meta: { adjust: value } }), sameAdjust);
}

/** Two adjustment sets, or two absences, are the same adjustment. */
const sameAdjust = (a: unknown, b: unknown) => {
  if (!isRecord(a) || !isRecord(b)) return a === b;
  return a.brightness === b.brightness && a.contrast === b.contrast
    && a.saturation === b.saturation;
};

/**
 * Which way round one picture is hung: mirrored left to right, top to bottom,
 * both, or neither.
 *
 * Pictures only, the same guard setItemCrop() carries and not the wider one the
 * grade carries - but for the opposite reason. A mirror is a transform and the
 * compositor would turn a video frame as happily as a still; what stops it is
 * that there is nowhere to ask from. The darkroom is the only surface that
 * writes this and canEditPicture() will not open it on a clip, so a guard that
 * allowed video would be a door onto a room with no handle. Widen both together
 * or neither.
 *
 * Whole, not partial, where setItemAdjust() above merges: the two toggles read
 * the live value and hand back both axes, because unlike three sliders in three
 * places they are two buttons in one row looking at one picture.
 */
export function setItemFlip(id: string, flip: unknown) {
  const it = byId(id);
  if (!it || it.type !== 'image') return;
  patchMeta(id, 'flip', flip, next => (next ? 'Mirror picture' : 'Unmirror picture'),
    value => itemFlip({ meta: { flip: value } }), sameFlip);
}

/** Two mirrors, or two absences, are the same mirror. */
const sameFlip = (a: unknown, b: unknown) => {
  if (!isRecord(a) || !isRecord(b)) return a === b;
  return a.x === b.x && a.y === b.y;
};

/**
 * The tags on a set of items, added or removed across the whole selection.
 *
 * One entry for the set, like setItemsLocked() above: "tag these nine kitchen"
 * is one act. Adding is a union and removing is a difference, so tagging a
 * selection where three items already carry the tag adds it to the other six
 * and leaves those three alone rather than toggling them off - a toggle over a
 * mixed selection has no answer anybody means.
 *
 * The undo direction restores each item's own previous list rather than
 * reversing the operation, because the two are not the same where an item
 * already had the tag.
 */
export function setItemsTagged(ids: Iterable<string>, tag: unknown, on: boolean) {
  const clean = cleanTag(tag);
  if (!clean) return;
  const before = new Map<string, string[]>();
  for (const id of new Set(ids)) {
    const it = byId(id);
    if (!it || !isContent(it)) continue;
    const tags = itemTags(it);
    if (tags.includes(clean) === on) continue;
    if (on && tags.length >= TAGS_PER_ITEM) continue;
    before.set(id, tags);
  }
  if (!before.size) return;
  const write = (next: boolean) => {
    for (const [id, was] of before) {
      const it = byId(id);
      if (!it) continue;
      // A union, not an append. `was` is the tag list as it stood when the
      // command was built, and on an Untag that list already contains the tag -
      // so `[...was, clean]` on the redo direction of an undo wrote it twice.
      // itemTags() dedupes on read, which is why nothing looked wrong; the
      // duplicate still consumed a slot against TAGS_PER_ITEM and still landed
      // in the file.
      const tags = next
        ? [...new Set([...was, clean])].sort()
        : was.filter(t => t !== clean);
      if (tags.length) it.meta = { ...it.meta, tags };
      else { const { tags: _drop, ...rest } = it.meta || {}; it.meta = rest; }
      bus.emit('item', id);
    }
  };
  const many = before.size > 1 ? ` ${before.size} items` : '';
  commit((on ? 'Tag' : 'Untag') + many, () => write(on), () => write(!on));
}

// ---------------------------------------------------------------------------
// Unsticking
//
// The two mutations that own meta.loose - see the header of sticky.js for what
// the flag means and why it is the one piece of stickiness that is stored.
// They are a pair and they are asymmetric on purpose: one is a menu entry, the
// other is a consequence of a gesture, and only the first is worth a history
// entry of its own.
// ---------------------------------------------------------------------------

/**
 * "Unstick" - the only way off a host that is not dropping the item somewhere
 * else. Sets the flag on everything given that is actually pinned.
 *
 * Its own history entry, unlike the clearing half below, because it is the
 * whole of what the person did: they opened a menu and asked for this, and
 * nothing else happened that it could ride along inside.
 *
 * The undo direction just removes the flag and lets the measurement speak
 * again. It cannot get a different answer than it had: nothing moved, so
 * whatever the item was lying on it is still lying on.
 */
export function unstickItems(ids: Iterable<string>) {
  // isRider, not isPinned: an item dropped three seconds ago is stuck and has
  // not set yet, and unsticking it then is the whole point of being able to -
  // it is how you keep it from ever pinning. See cmds.canUnstick, which asks
  // the same question, and the settling block in sticky.js.
  const affected = [...new Set(ids)].filter(id => {
    const it = byId(id);
    return !!it && isRider(it);
  });
  if (!affected.length) return;
  const write = (loose: boolean) => {
    for (const id of affected) {
      const it = byId(id);
      if (!it) continue;
      if (loose) it.meta = { ...it.meta, loose: true };
      else { const { loose: _drop, ...rest } = it.meta || {}; it.meta = rest; }
    }
    // The memo still holds the host each of these was stuck to, and the flag is
    // read in front of it rather than instead of it - so putting the flag back
    // has to send the question to the measurement again.
    restick(affected);
    // Nothing moved. 'geom' is still the right announcement: what changed is
    // what travels when the host does, which is a fact about position, and it
    // is the event the renderers already listen to for exactly that.
    bus.emit('geom', affected);
  };
  commit(affected.length > 1 ? `Unstick ${affected.length} items` : 'Unstick',
    () => write(true), () => write(false));
}

/**
 * The way back: a drop that found a host un-looses what it dropped.
 *
 * Called with the ids a *pointer* gesture drove, from canvas/input.js, and only
 * when the gesture actually moved something. Not from commitGeom(), and that is
 * the distinction the whole design rests on:
 *
 * - It must not run on undo or redo. commitGeom() re-asks restick() inside the
 *   committed pair, deliberately, because a note put back by the history has
 *   moved and its memo must not outlive the geometry that justified it. This is
 *   the opposite kind of thing - a decision, not a measurement - so replaying it
 *   would mean undo could never restore "loose" at all. It runs once, in front
 *   of the commit, and the before/after snapshot pair carries it in both
 *   directions from there (see snapshotGeom, which records the flag).
 * - It must not run on the arrow keys. Those *set* the flag, and the item they
 *   set it on is almost always still over its old host - so a resettle on the
 *   same gesture would take it straight back off again. The asymmetry is the
 *   design: the keyboard positions a loose item and leaves it loose, however
 *   long that takes, and only a pointer drop puts it back on a card.
 *
 * No commit of its own, and no 'geom' either: the caller commits a moment later
 * and announces the whole gesture at once.
 */
export function resettle(ids: Iterable<string>) {
  const cleared: string[] = [];
  for (const id of ids) {
    const it = byId(id);
    // hostUnder(), not stuckTo(): the flag being decided here is exactly what
    // stuckTo() refuses to look past.
    if (!it?.meta?.loose || !hostUnder(it)) continue;
    const { loose: _drop, ...rest } = it.meta;
    it.meta = rest;
    cleared.push(id);
  }
  if (cleared.length) restick(cleared);
  return cleared;
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
export function setModelShot(
  id: string,
  { hash, ink, view }: { hash?: unknown, ink?: unknown, view?: unknown } = {},
) {
  const it = byId(id);
  if (!it || it.type !== 'model') return;
  const meta = { ...it.meta };
  if (isHash(hash)) meta.shot = hash; else delete meta.shot;
  // What the model was shaded in when the picture was taken. A model with no
  // colours of its own is drawn in the board's ink, so a change of palette
  // leaves every still a shade out of date - and this is what lets the card
  // notice. Absent means the model brought its own colours and never goes stale.
  if (typeof ink === 'string' && ink) meta.shotInk = ink; else delete meta.shotInk;
  if (isRecord(view)) {
    meta.view = {
      yaw: Number(view.yaw) || 0,
      pitch: Number(view.pitch) || 0,
      zoom: Number(view.zoom) || 1,
    };
  }
  it.meta = meta;
  markDirty();
  bus.emit('item', id);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

// select(), clearSelection() and deselect() moved down to board-store.js, which
// owns the Set they write to - see the note beside them there. This one stayed:
// it needs the item list, and board-model.js sits *above* board-store.js in the
// graph, so the module holding the selection cannot ask what is on the board.
export function selectAll() {
  select(board.items.map(i => i.id));
}

// ---------------------------------------------------------------------------
// Settings + whole-board replacement
// ---------------------------------------------------------------------------

export function setSetting(key: string, value: unknown) {
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
    // Into its own binding rather than back over the parameter: what the board
    // takes is the normalised header, and normalizeMobileHeader() is what says
    // so - the value that arrived is still whatever a panel or a file handed in.
    const header = normalizeMobileHeader(value);
    if (JSON.stringify(board.mobileHeader) === JSON.stringify(header)) return;
    board.mobileHeader = header;
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
    // Through the live settings rather than a bare `{ fonts }`: cloneSettings
    // takes a whole settings record and only the deep copy of the list is read
    // back out, which is all this line ever wanted from it.
    board.layoutSettings.desktop.fonts = cloneSettings({ ...board.settings, fonts }).fonts;
    board.layoutSettings.mobile.fonts = cloneSettings({ ...board.settings, fonts }).fonts;
    markDirty();
    bus.emit('settings', key);
    return;
  }
  if (key === 'appearance') {
    setAppearance(value);
    return;
  }
  // The key arrives as a bare string - from a `data-cmd`, from the panel's
  // schema, from the console - and setting a name BoardSettings does not have
  // is a write nobody can read back. The bag is the same object either way; see
  // the note over cmds.getSetting in commands.ts.
  const settings: Record<string, unknown> = board.settings;
  if (settings[key] === value) return;
  // Snapping is not only a rule for the next drag - it moves the board. Done
  // here rather than at the checkbox because the whimsy axis flips this setting
  // too (Harsh means snapped), and both routes have to behave the same.
  //
  // The whole key is handed over, write included: the flag belongs inside the
  // command the geometry pushes, so that one Ctrl+Z takes back both halves of
  // what one click did. writeSnapSetting() does everything this function's tail
  // would have done, which is why this returns rather than falling through.
  if (key === 'snap') {
    // The flag the two sweeps write back is the boolean the checkbox meant,
    // which is what `value ?` was already asking of whatever arrived.
    const on = !!value;
    on ? snapAll(on) : unsnapAll(on);
    return;
  }
  settings[key] = value;
  // The gap is baked into where the packer put things, so on Mobile it is not a
  // rule for the next import - it moves the column that is already there. On
  // Desktop it is exactly a rule for the next import, and nothing moves until
  // Rearrange is pressed. Same setting, and the difference is the layout's.
  if (key === 'mobileColumns' ||
      (key === 'spacing' && board.layoutMode === 'mobile')) repackMobileBoard();
  board.layoutSettings[board.layoutMode] = layoutSettingsOf(board.settings);
  markDirty();
  bus.emit('settings', key);
  // Every boolean board setting is a switch, and this is the one door all of
  // them come through - the grid, the axes, the readout, the twenty in the
  // panel. One line here rather than a cue at each checkbox, for the same
  // reason this function exists at all. `off` is `on`'s recipe with the glide
  // inverted, so the two are audibly a pair rather than two similar noises.
  //
  // Below the early return above, so a setting written to the value it already
  // held stays silent: pressing a toggle that was already on is not a toggle.
  if (typeof value === 'boolean') cue(value ? 'on' : 'off');
}

/** Replace the shared color/whimsy half and the active layout's local look. */
export function setAppearance(appearance: unknown) {
  // The same test splitAppearance() makes of its own argument, said at the
  // door: a look that is not an object is no look, and both ends agree on it.
  const { shared, local } = splitAppearance(isRecord(appearance) ? appearance : {});
  // Through the live settings, as in setSetting's fonts branch above.
  board.sharedAppearance = cloneSettings({ ...board.settings, appearance: shared }).appearance;
  board.settings.appearance = mergeAppearance(board.sharedAppearance, local);
  board.layoutSettings[board.layoutMode] = layoutSettingsOf(board.settings);
  markDirty();
  bus.emit('settings', 'appearance');
}

export function setArrangement(name: string) {
  if (board.arrangement === name) return;
  board.arrangement = name;
  board.arrangements[board.layoutMode] = name;
  markDirty();
  bus.emit('settings', 'arrangement');
}

/**
 * The order the Playlist plays the board's audio in, set by dragging a track to
 * a new place. A list of ids, held to the board's live items and saved with it.
 *
 * Off the undo stack, like setArrangement above: reordering a playlist is a
 * preference about how it reads, not an edit to the board's content, and a Ctrl+Z
 * that walked back through drag positions would step over the work between them.
 * Its own 'audioOrder' event so the Playlist repaints without every 'items'
 * listener waking for something only it cares about.
 */
export function setAudioOrder(ids: unknown) {
  board.audioOrder = normalizeAudioOrder(ids, filedIds());
  markDirty();
  bus.emit('audioOrder', board.audioOrder);
}

/**
 * Every id this board still answers for: what is on it, plus what is in the bin.
 *
 * The union board-schema.ts writes the tour and the playlist order against, and
 * the reason it is a union: a card in the bin can come back, and its place in
 * an ordering has to come back with it. A pruner that only knows about live
 * items turns "delete a card" into "and forget where it stood", quietly and
 * permanently, on the next unrelated edit.
 */
const filedIds = () => new Set([
  ...board.items.map(i => i.id),
  ...board.trash.map(t => t.item.id),
]);

/**
 * The board's tour: which cards it stops at, in order.
 *
 * Off the undo stack, exactly like setAudioOrder() above and for the argument
 * that one makes - a tour is a way of *reading* the board rather than a change
 * to what is on it, and a Ctrl+Z that walked back through stop-list edits would
 * step over the real work done between them. The stops are cards that already
 * exist; nothing here creates, moves or deletes anything.
 *
 * Held to the board-plus-bin union, the same one board-schema.ts writes with.
 *
 * It used to prune against the live board alone, and the comment here argued
 * that the asymmetry was deliberate: a *file* must keep a stop whose card is in
 * the bin, while a tour being played must not stop at a card that is not there.
 * The second half is true and is not this function's job - ui/tour.ts's stops()
 * resolves board.tour through byId() on every read for exactly that reason, and
 * says so. What pruning here actually did was destroy the first half: delete a
 * card, then make any later edit to the tour, and the deleted card's place is
 * gone from board.tour and from the file, so restoring it out of the bin no
 * longer brings its stop back. Nothing said so and nothing could be undone -
 * this is off the undo stack.
 */
export function setTour(ids: unknown) {
  board.tour = normalizeTour(ids, filedIds());
  markDirty();
  bus.emit('tour', board.tour);
}

/**
 * Put a set of items on the end of the tour, or take them off it.
 *
 * The everyday door - the menu's "Add to tour" over a selection - where
 * setTour() is the wholesale one the tour panel's reordering uses. Adding keeps
 * the board's own stacking order for the items being added, so "select six
 * cards and add them" produces a tour in the order they sit rather than in
 * whatever order the selection happens to iterate.
 */
export function setTourMembers(ids: Iterable<string>, on: boolean) {
  const wanted = new Set(ids);
  if (!wanted.size) return;
  const current = board.tour;
  if (!on) {
    setTour(current.filter(id => !wanted.has(id)));
    return;
  }
  const adding = board.items
    .filter(i => wanted.has(i.id) && !current.includes(i.id) && !isFurniture(i))
    .map(i => i.id);
  if (!adding.length) return;
  setTour([...current, ...adding]);
}

/**
 * Fold a planned merge onto the board, in one undoable step.
 *
 * `addItems()` would have covered the items and nothing else: the three
 * relation lists are written by setters that are deliberately *off* the undo
 * stack (see setAudioOrder and setTour above), so a merge built out of the
 * existing doors would undo the arrival and leave its connections, its playlist
 * order and its tour stops behind, pointing at cards that are no longer there.
 * They would then be pruned on the next save, quietly, and a redo would bring
 * the items back without them.
 *
 * So it is one commit whose two halves are symmetrical: push the items and
 * append the relations, or drop exactly those again. Appended rather than
 * merged, in the arriving file's own order - a merge is one board arriving
 * beside another, not two orders being interleaved, and there is no reading of
 * "these nine tracks belong between your fourth and fifth" that anybody means.
 *
 * `weight` is the item count, which is what the history evicts on - see
 * commit()'s fourth argument. A merge can be the largest single entry the stack
 * ever holds, so it has to declare what it is holding.
 *
 * Nothing here validates: planMerge() in merge.ts has already remapped every id
 * and dropped every relation that named something it is not bringing.
 */
export function mergeBoard(plan: MergePlan, label = 'Merge board') {
  const { items, connections, audioOrder, tour } = plan;
  if (!items.length) return 0;
  const ids = new Set(items.map(i => i.id));
  const keys = new Set(connections.map(c => pairKey(c[0], c[1])));
  const write = () => {
    // Filtered on the way in for the reason addItems() filters: commit() runs
    // the redo half immediately and again on every redo, and an item already on
    // the board must not be pushed twice.
    const fresh = items.filter(i => !byId(i.id));
    board.items.push(...fresh);
    board.connections = board.connections
      .filter(c => !keys.has(pairKey(c[0], c[1])))
      .concat(connections);
    board.audioOrder = [...board.audioOrder.filter(id => !ids.has(id)), ...audioOrder];
    board.tour = [...board.tour.filter(id => !ids.has(id)), ...tour];
    refenceArrivals(items);
    bus.emit('items', { added: fresh.map(i => i.id), removed: [] });
    bus.emit('connections');
    bus.emit('audioOrder', board.audioOrder);
    bus.emit('tour', board.tour);
  };
  const undo = () => {
    board.items = board.items.filter(i => !ids.has(i.id));
    board.connections = board.connections.filter(c => !keys.has(pairKey(c[0], c[1])));
    board.audioOrder = board.audioOrder.filter(id => !ids.has(id));
    board.tour = board.tour.filter(id => !ids.has(id));
    ids.forEach(id => selection.delete(id));
    bus.emit('items', { added: [], removed: [...ids] });
    bus.emit('selection');
    bus.emit('connections');
    bus.emit('audioOrder', board.audioOrder);
    bus.emit('tour', board.tour);
  };
  commit(label, write, undo, items.length);
  return items.length;
}

export function setTitle(title: unknown) {
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
export function loadBoard(data: unknown) {
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
  board.connections = next.connections;
  board.audioOrder = next.audioOrder;
  board.tour = next.tour;
  // A filter is about the tags of the board that set it, and the board leaving
  // took those with it. Left standing, opening a second board would fade most
  // of it out for a reason that is no longer on screen anywhere. Not saved
  // either - see tagFilter in board-store.ts.
  setTagFilter([]);
  board.layoutMode = layoutMode;
  // Nothing that arrives from outside is allowed to be a ghost. serializeBoard()
  // never writes one, so a file carrying the type was hand-made or came from a
  // future the app does not have; either way a hint the board did not mint is
  // one nothing would ever clear, since a board holding it is not empty. Dropped
  // here rather than trusted, which is the same treatment every other field in
  // normalizeBoard() gets.
  board.items = next.items.filter(i => i.type !== 'ghost');
  // In the same breath as the assignment, and nothing may go between them.
  // byId()'s index is otherwise dropped on the 'items' event at the foot of this
  // function, which is right for every ordinary mutation and wrong for exactly
  // this one: everything below - seedSticks(), completeLayout(), the Mobile
  // carry - reads the board through byId(), and until the index is dropped it
  // answers about the board that just left. See dropIdIndex() in board-model.js.
  dropIdIndex();
  // The latch travels with the board, not the session: one that arrives with
  // content has already been past this point, and one that arrives empty earns
  // its hints. See ensureGhostCards(), which main.js calls on 'board:load'.
  //
  // isContent(), not `type !== 'title'`: fences are furniture too, so a board of
  // nothing but regions is a board with nothing in it and has not earned its
  // hints away. This is the same question hasContent() asks, and it drifted from
  // it when fences arrived.
  resetGhostLatch(board.items.some(isContent));
  // The Desktop title card is seeded by the app (main.js, on 'board:load'), not
  // here: keeping loadBoard() free of it lets state tests load and serialise a
  // board of exactly the items they gave it. See ensureTitleCard().
  // Before completeLayout(): the Mobile carry below asks stuckTo() where each
  // note belongs, so the memo has to hold *this* board's answers, not the last
  // board's. Seeding also drops the old board's ids, which two files can share.
  seedSticks();
  // And the same for fences, for a stronger version of the same reason: a board
  // opened straight into Mobile cannot measure membership at all until somebody
  // switches modes, so meta.fence is the only thing that knows. See fences.js.
  seedFences();
  activateLayoutSettings(layoutMode);
  writeLayout(completeLayout(layoutMode));
  selection.clear();
  // The mode the selection was being built in goes with it. A board arriving
  // under a mode that says "a tap adds to the group" would open with no group
  // and that rule still standing, which is the one state it can never be
  // explained from - nothing on screen is what turned it on. Quietly, like the
  // clear above it: the 'selection' at the foot of this function is the one
  // announcement a load makes about either.
  resetMultiSelect();
  clearHistory();
  // After clearHistory(), which resets the ledger to this board as its starting
  // point - so a file that carries a timeline replaces that reset, and one that
  // does not is left with a fresh ledger over the board it just loaded. Both
  // are right; the order is what makes them so.
  //
  // isRecord() rather than a cast: `data` is whatever was in the file, and
  // adoptTimeline() checks its own fingerprint against the board that has by
  // now been built - so a timeline that does not describe this board is marked
  // stale here rather than believed.
  adoptTimeline(isRecord(data) ? data.timeline : null, data);
  // The clipboard cannot cross a board - see clearClipboard() for why.
  clearClipboard();
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
  bus.emit('connections');
  // Somewhere has been arrived at. Silent for the board that arrives at boot,
  // and not by a check here: a page that has not been touched yet may not make
  // a sound at all, which cuelume/engine.js asks about before every cue. The
  // restored session is exactly that page.
  cue('arrive');
}

