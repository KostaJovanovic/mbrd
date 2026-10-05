// Central board state + selection + command-based undo/redo. Everything
// that mutates the board goes through here and emits an event (items,
// geom, item, selection, settings, layout, board, trash, connections),
// so renderer/HUD/sidebar stay in sync without knowing each other.

import { isHash, isRecord, itemHashes } from './util.ts';
import { toast } from './notify.ts';
import { cue } from './cuelume/engine.ts';
import { latticeBox } from './geometry.ts';
import { splitAppearance, mergeAppearance } from './layout-settings.ts';
import {
  normalizeBoard, normalizeFonts, normalizeMediaFit, normalizeMobileHeader,
  normalizePaletteSources, serializeBoard,
} from './board-schema.ts';

export { serializeBoard };

import {
  GHOST_IDS, NOTFOUND_IDS, tapeFor, hasContent, hasGhosts, isNotFoundBoard,
  leaveNotFoundBoard, ensureGhostCards, dismissGhosts, resetGhostLatch,
  reseedGhostCards, isBenchBoard, markBenchBoard, notUsersBoard,
} from './onboarding.ts';

export {
  GHOST_IDS, NOTFOUND_IDS, tapeFor, hasContent, hasGhosts, isNotFoundBoard,
  leaveNotFoundBoard, ensureGhostCards, dismissGhosts, resetGhostLatch,
  reseedGhostCards, isBenchBoard, markBenchBoard, notUsersBoard,
};

import {
  clipboardBounds, clipboardHasOurs, clipboardOnBoardLoad, clipboardSize,
  copyItems as copyExactly, itemCount, itemsIn, linksAmong, pasteCopies, relink,
  setClipboardCarry, takeItems,
} from './clipboard.ts';

export { clipboardBounds, clipboardHasOurs, clipboardSize, setClipboardCarry };

/**
 * Copy these and everything that travels with them - the notes stuck on, a
 * fence's contents - with the lines between them. The same set a drag carries,
 * so Ctrl+C on a photo takes its notes the way picking it up would.
 */
export const copyItems = (ids: Iterable<string>) => copyExactly(travelling(ids));

/** Whether any of these may be copied, cut or duplicated - see copyable(). */
export const canCopyItems = (ids: Iterable<string>) => itemsIn(ids).length > 0;

import {
  removeItems, restoreItems, emptyTrash, setAssetPurge, freezeClip, clipHomeId,
  stuckHostId, isKeepsake,
} from './trash.ts';

export {
  removeItems, restoreItems, emptyTrash, setAssetPurge, freezeClip, clipHomeId,
  stuckHostId, isKeepsake,
};
import {
  bus, selection, isDirty, markDirty, resetDirty,
  select, clearSelection, deselect, tagFilter, setTagFilter,
  isMultiSelect, setMultiSelect, resetMultiSelect,
} from './board-store.ts';
import {
  commit, commitFolded, undo, redo, historyState, historyDepth, historyWeight,
  clearHistory, dropStacks, lastCommand, takeBack, undoAction,
} from './history.ts';
import type { Command } from './history.ts';
import {
  adoptTimeline, timelineSteps, timelineAt, timelineStale, timelineHashes, goTo,
  nameStep, declareOp, registerOp, editStep, rebuildFrom, stepEditable,
  timelineBytes, trimmable, trimTimeline, TRIM_BYTES, TRIM_DAYS, deleteStep, deleteAhead,
  deleteStepUndoably, stepCards,
  replayTo, serializeTimeline, describeStep, timelinePlaying, setTimelinePlaying,
  rewriteRecorded,
} from './timeline.ts';

export {
  timelinePlaying, setTimelinePlaying,
  timelineSteps, timelineAt, timelineStale, timelineHashes, replayTo, goTo,
  nameStep, declareOp, registerOp, editStep, rebuildFrom, stepEditable,
  timelineBytes, trimmable, trimTimeline, TRIM_BYTES, TRIM_DAYS, deleteStep, deleteAhead,
  deleteStepUndoably, stepCards, serializeTimeline, describeStep,
};

export { bus, selection, isDirty, markDirty, select, clearSelection, deselect };
export { tagFilter, setTagFilter };
export { isMultiSelect, setMultiSelect };
export { commit, undo, redo, historyState, historyDepth, historyWeight, lastCommand, takeBack, undoAction };
export type { Command };

/**
 * Forget the whole history: the board as it stands becomes the start of a new
 * one. The undo stack goes with it, since every entry on it undoes a step that
 * is gone. Dirty, so the next save writes the board without the old ledger.
 */
export function deleteTimeline() {
  clearHistory();
  markDirty();
}

/**
 * Let go of the bytes of every earlier version, and leave the history that
 * named them standing.
 *
 * The ledger held the file as it used to be; it gets the file as the card has
 * it now. Stepping back to before an Optimize still shows that moment - the
 * same cards, in the same places, named and arranged as they were - drawn with
 * today's pictures. The alternative was deleting the timeline outright, which
 * is a steep price for space.
 *
 * Per card and per field, because the card is the only thing that knows what
 * replaced what: a recorded `asset.hash` becomes that card's `asset.hash`, a
 * recorded `meta.display` its display copy, and a field the card no longer has
 * at all - the .dng an Optimize threw away - is dropped rather than left
 * pointing somewhere wrong. A card gone from the board *and* the drawer has
 * nothing to answer with, and needs none: emptyTrash() is the only thing that
 * destroys a card's bytes, and it leaves a tombstone holding no files at all.
 *
 * Call `discardOriginals()` first, so the live cards have stopped naming what
 * is going; the recorded copies are stripped of `was`/`wasCover` here.
 *
 * The undo stack goes with it - its closures describe a board where those
 * bytes still existed, which is what dropStacks() is for. The timeline does
 * not go, and that is the whole point.
 */
export function replaceOldVersions(doomed: Set<string>): number {
  if (!doomed.size) return 0;
  const now = new Map<string, Item>();
  for (const item of board.items) now.set(item.id, item);
  for (const entry of board.trash) now.set(entry.item.id, entry.item);
  const count = rewriteRecorded(rec => remapRecorded(rec, now, doomed));
  if (count) { dropStacks(); markDirty(); }
  return count;
}

/**
 * The meta keys that name a file, for the walk above. `was` and `wasCover` are
 * in it because they name the very thing being let go: a recorded copy that
 * kept them would point the sweep at bytes that no longer exist.
 */
const RECORDED_HASH_KEYS = [
  'cover', 'shot', 'thumb', 'preview', 'art', 'display', 'source', 'poster',
  'archive', 'was', 'wasCover',
];

/** One recorded item, with today's files in place of the doomed ones. Null
 *  when it names none of them - rewriteRecorded() leaves those untouched. */
function remapRecorded(
  rec: Record<string, unknown>, now: Map<string, Item>, doomed: Set<string>,
): Record<string, unknown> | null {
  const live = now.get(typeof rec.id === 'string' ? rec.id : '');
  const fresh = (hash: unknown): hash is string =>
    typeof hash === 'string' && !!hash && !doomed.has(hash);
  let changed = false;

  // The picture itself. With no card to ask, the reference goes rather than
  // dangles - the renderer draws a card with no file, not a broken one.
  let asset = rec.asset;
  if (isRecord(asset) && typeof asset.hash === 'string' && doomed.has(asset.hash)) {
    const hash = live?.asset?.hash;
    asset = fresh(hash) ? { ...asset, hash } : null;
    changed = true;
  }

  const meta = isRecord(rec.meta) ? { ...rec.meta } : null;
  if (meta) {
    for (const key of RECORDED_HASH_KEYS) {
      if (typeof meta[key] !== 'string' || !doomed.has(meta[key])) continue;
      const hash = live?.meta?.[key];
      if (fresh(hash)) meta[key] = hash;
      else delete meta[key];
      changed = true;
    }
    // A folder card's listing, matched by path: the one thing about an entry
    // that survives a re-import. An entry with no match is dropped, the same
    // answer as a field the card no longer has.
    const files = Array.isArray(meta.files) ? meta.files : null;
    if (files?.some(f => isRecord(f) && typeof f.hash === 'string' && doomed.has(f.hash))) {
      const byPath = new Map<string, string>();
      const listed = Array.isArray(live?.meta?.files) ? live.meta.files : [];
      for (const f of listed) {
        if (isRecord(f) && typeof f.path === 'string' && fresh(f.hash)) byPath.set(f.path, f.hash);
      }
      meta.files = files.flatMap(f => {
        if (!isRecord(f) || typeof f.hash !== 'string' || !doomed.has(f.hash)) return [f];
        const hash = byPath.get(typeof f.path === 'string' ? f.path : '');
        return hash ? [{ ...f, hash }] : [];
      });
      changed = true;
    }
  }

  if (!changed) return null;
  const out: Record<string, unknown> = { ...rec, asset };
  if (meta) out.meta = meta;
  return out;
}

import {
  NOTE_MAX, NOTE_SHEET_MAX, DEFAULT_MOBILE_HEADER, DEFAULT_SETTINGS, BOARD_MODES, BOARD_TITLE_MAX,
  MOBILE_COLUMNS, MOBILE_COLUMN_OPTIONS, MOBILE_TOP_ROWS, MOBILE_MIN_ROWS,
  MOBILE_BOTTOM_ROWS, MOBILE_APPEARANCE_VARS, cleanBoardTitleDraft, cleanBoardTitle,
  defaultBoardTitle, isDefaultTitle, mobileColumnCount, board, TITLE_ID, byId,
  topZ, makeItem, isFurniture, isContent, isJoinEnd, trackTitle, noteNameOf,
} from './board-model.ts';
import {
  cloneSettings, layoutSettingsOf, dropIdIndex,
  MAX_CONNECTIONS, pairKey, normalizeAudioOrder, CONN_DIRECTIONS, CONN_STYLES,
} from './board-model.ts';
import {
  isLocked, isFiltered, itemCrop, itemAdjust, adjustFilter, itemFlip, flipTransform,
  itemRotate, itemMatte, itemBare, itemFaded,
  itemTags, boardTags, cleanTag,
  normalizeTour, TAGS_PER_ITEM, TAG_MAX, MIN_CROP,
} from './board-model.ts';
import type { Connection, Item, MobileHeader, TourStop } from './board-model.ts';
import type { MergePlan } from './merge.ts';

export { MAX_CONNECTIONS, pairKey, CONN_DIRECTIONS, CONN_STYLES };
export { isLocked, isFiltered, itemCrop, itemAdjust, adjustFilter, itemFlip, flipTransform };
export { itemRotate, itemMatte, itemBare, itemFaded };
export { itemTags, boardTags, cleanTag };
export { TAGS_PER_ITEM, TAG_MAX, MIN_CROP };

import {
  areConnected, connectedTo, toggleConnection, addConnections, clearConnections,
  removeConnectionsOf, updateConnection, connectionMeta,
} from './connections.ts';

export {
  areConnected, connectedTo, toggleConnection, addConnections, clearConnections,
  removeConnectionsOf, updateConnection, connectionMeta,
};

import {
  STICK_MIN, stuckTo, wouldStick, restick, seedSticks,
  stuckPlacement, isRider, stuckFollowers, isPinned, dragRoot, hostUnder, isSticky,
  startSettling, isSettling, settlesIn, SETTLE_MS, startFresh,
} from './sticky.ts';

import {
  isFence, fenceOf, fenceAt, fenceMembers, fenceFollowers, refence, refenceAround,
  refenceArrivals, seedFences, fenceBox, nextFenceName, mobileRuns,
  isRolled, rolledFences, rolledAway,
} from './fences.ts';

import { stickerTint } from './stickers/catalogue.ts';

import {
  activateLayoutSettings, applyGeom, baseStep, commitGeom, completeLayout, fitBoardMode, mobileBoardWidth, placeMobileItems, recheckBoardGeometry, repackMobileBoard, snapAll, snapshotGeom, travelling, unsnapAll, writeLayout,
} from './layout.ts';

export { recheckBoardGeometry };

export { raiseSelection, lowerSelection, stackOrder, visualStackOrder, stackLayerIds, selectionHasStackOverlap } from './stacking.ts';

export {
  setBoardMode, mobileBoardTop, mobileBoardBottom, mobileBoardWorldWidth, setLatticeShape,
} from './layout.ts';

export { baseStep, snapshotGeom, applyGeom, commitGeom, placeMobileItems, mobileBoardWidth, travelling };
export type { GeomPatch } from './layout.ts';

export {
  STICK_MIN, stuckTo, wouldStick, restick,
  stuckPlacement, isRider, stuckFollowers, isPinned, dragRoot, isSticky,
  startSettling, isSettling, settlesIn, SETTLE_MS, startFresh,
};

export {
  isFence, fenceOf, fenceAt, fenceMembers, fenceFollowers, refence, refenceAround,
  fenceBox, nextFenceName, mobileRuns, isRolled, rolledFences, rolledAway,
};

export {
  NOTE_MAX, NOTE_SHEET_MAX, DEFAULT_MOBILE_HEADER, DEFAULT_SETTINGS, BOARD_MODES, BOARD_TITLE_MAX,
  MOBILE_COLUMNS, MOBILE_COLUMN_OPTIONS, MOBILE_TOP_ROWS, MOBILE_MIN_ROWS,
  MOBILE_BOTTOM_ROWS, MOBILE_APPEARANCE_VARS, cleanBoardTitleDraft, cleanBoardTitle,
  defaultBoardTitle, isDefaultTitle, mobileColumnCount, board, TITLE_ID, byId,
  topZ, makeItem, isFurniture, isContent, isJoinEnd, trackTitle,
};



/** Injected by main.ts — asset registry is above state in the layer graph. */
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
  options: { avoidOverlap?: boolean, links?: readonly Connection[] } = {},
) {
  // Lines between the arrivals (Duplicate, Paste), in the same step: undo takes
  // the cards, and a second commit for their lines would be a step that undid
  // nothing visible once they were gone.
  const room = Math.max(0, MAX_CONNECTIONS - board.connections.length);
  const links = (options.links ?? []).slice(0, room);
  // Assign ascending z — a batch all reading topZ() would land flat.
  // Explicit z is honoured (loadBoard, bin restore need exact positions).
  let z = topZ();
  let added = items.map(partial =>
    makeItem(partial.z != null ? partial : { ...partial, z: ++z }));
  if (options.avoidOverlap && board.layoutMode === 'mobile') {
    added = placeMobileItems(added);
  } else {
    added = added.map(item => fitBoardMode(onLattice(item)));
  }
  // Fence membership recalc in redo — undo is a removal, which self-heals.
  commit(label,
    () => { const fresh = added.filter(a => !byId(a.id));
            board.items.push(...fresh);
            refenceArrivals(added);
            bus.emit('items', { added: fresh.map(a => a.id), removed: [] });
            if (links.length) {
              board.connections = [...board.connections, ...links];
              bus.emit('connections');
            } },
    () => { const ids = new Set(added.map(a => a.id));
            board.items = board.items.filter(i => !ids.has(i.id));
            ids.forEach(id => selection.delete(id));
            bus.emit('items', { added: [], removed: [...ids] }); bus.emit('selection');
            if (links.length) {
              board.connections = board.connections.filter(c => !ids.has(c[0]) && !ids.has(c[1]));
              bus.emit('connections');
            } },
    added.length + links.length);
  return added;
}

/**
 * One card out and what it held in, as one undo step: Unzip and Open
 * (import/unpack.ts). The card leaves the board rather than going to the bin,
 * since what it held is on the board in its place, and undo puts it back where
 * it was in the stack. Positions come from the caller - a spiral round the card
 * on the canvas, the card's own place in the column on the Feed.
 */
export function replaceItem(id: string, items: Record<string, unknown>[], label: string) {
  const index = board.items.findIndex(i => i.id === id);
  if (index < 0) return [];
  const card = board.items[index];
  let z = topZ();
  const added = items.map(partial => fitBoardMode(onLattice(makeItem({ ...partial, z: ++z }))));
  commit(label,
    () => { board.items = board.items.filter(i => i.id !== id);
            selection.delete(id);
            const fresh = added.filter(a => !byId(a.id));
            board.items.push(...fresh);
            refenceArrivals(added);
            bus.emit('items', { added: fresh.map(a => a.id), removed: [id] });
            bus.emit('selection'); },
    () => { const ids = new Set(added.map(a => a.id));
            board.items = board.items.filter(i => !ids.has(i.id));
            ids.forEach(i => selection.delete(i));
            board.items.splice(Math.min(index, board.items.length), 0, card);
            refenceArrivals([card]);
            bus.emit('items', { added: [id], removed: [...ids] });
            bus.emit('selection'); },
    added.length + 1);
  return added;
}

/**
 * Snap a new item to the lattice if the board is snapped. Saves a presnap memo
 * so unsnapAll() can restore original geometry. Sticky items that would attach
 * to a host skip the snap — they belong at their stick point, not the grid.
 */
function onLattice(it: Item): Item {
  if (!board.settings.snap) return it;
  if (isSticky(it) && !it.meta?.loose && wouldStick(it, it.id, it)) return it;
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

// Title card geometry — 4 grid cells wide, 3:2 aspect (matches MOBILE_HEADER_ASPECT).
const TITLE_SIZE = Object.freeze({ w: 256, h: 171 });
// Top-centre above origin.
const TITLE_DEFAULT_POS = Object.freeze({ x: 0, y: 244 });

function makeTitleItem(at: { x?: number, y?: number } | null = null) {
  return makeItem({
    id: TITLE_ID,
    type: 'title',
    x: at?.x ?? TITLE_DEFAULT_POS.x,
    y: at?.y ?? TITLE_DEFAULT_POS.y,
    w: TITLE_SIZE.w,
    h: TITLE_SIZE.h,
    // Anchored by default — clicks pass through to pan, Rearrange skips it.
    // Only for new cards; boards from files keep whatever they saved.
    meta: { locked: true },
  });
}

/** Hydrate the title card if not hidden and not already present. No undo. */
export function ensureTitleCard() {
  if (board.titleHidden) return;
  if (board.items.some(i => i.type === 'title')) return;
  board.items.push(makeTitleItem());
}

/** Whether the Desktop title card is currently thrown away (bin shows its button). */
export const isTitleHidden = () => !!board.titleHidden;

/**
 * The title card as it would come back, for anything that has to *draw* it while
 * it is hidden - the drawer's Special shelf, which shows the card itself rather
 * than a stand-in for it. Not on the board, not added to it, and not the item
 * restoreTitleCard() makes: a fresh copy each call, to be rendered and dropped.
 */
export const titleCardShape = (): Item => makeTitleItem();

/** Reset the title card to top-centre. Undoable, no-op if already there. */
export function resetTitlePosition() {
  const item = board.items.find(i => i.type === 'title');
  if (!item) return;
  if (item.x === TITLE_DEFAULT_POS.x && item.y === TITLE_DEFAULT_POS.y) return;
  const before = snapshotGeom([item.id]);
  applyGeom([{ id: item.id, x: TITLE_DEFAULT_POS.x, y: TITLE_DEFAULT_POS.y,
               w: item.w, h: item.h, rot: item.rot, z: item.z }]);
  commitGeom('Reset title position', before, [item.id]);
}

/** Restore the title card from the bin, at a drop point or where it belongs.
 *  Undoable. `at` is a world point - the drawer drags it back like any card. */
export function restoreTitleCard(at: { x: number, y: number } | null = null) {
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
 * Copy items, offset a little so the copy is visibly on top of the original.
 * What travels with them comes too, and the lines between them - see copyItems().
 */
export function duplicateItems(ids: Iterable<string>, offset = { x: 28, y: -28 }) {
  const src = itemsIn(travelling(ids));
  if (!src.length) return [];
  const from = src.map(i => i.id);
  const { items, links } = relink(src, from, linksAmong(from), offset.x, offset.y);
  return addItems(items, items.length > 1 ? `Duplicate ${items.length} items` : 'Duplicate',
    { links });
}

/**
 * Alt+drag's copy: duplicateItems() with no offset, so each copy sits exactly
 * on its original, answering which copy is which original's. itemsIn() and
 * addItems() both keep the stacking order, which is what pairs them.
 */
export function duplicateInPlace(ids: Iterable<string>): Map<string, string> {
  const list = [...ids];
  const src = itemsIn(travelling(list));
  const made = duplicateItems(list, { x: 0, y: 0 });
  const out = new Map<string, string>();
  src.forEach((it, i) => { if (made[i]) out.set(it.id, made[i].id); });
  return out;
}

// ---------------------------------------------------------------------------
// Clipboard commands that touch the board (cut + paste)
// ---------------------------------------------------------------------------

/** Copy then delete. Cut items go to the bin (recoverable). */
export function cutItems(ids: Iterable<string>) {
  // takeItems() instead of copyItems() to avoid a double-toast. travelling()
  // for the same set a copy takes: a paste that brought the notes back while
  // the cut left them on the board would be the notes twice.
  const src = itemsIn(travelling(ids));
  const text = takeItems(src);
  if (!text) return '';
  const doomed = src.map(i => i.id);
  removeItems(doomed, doomed.length > 1 ? `Cut ${doomed.length} items` : 'Cut');
  toast(`Cut ${itemCount(doomed.length)} to the bin`, '', undoAction());
  return text;
}

/** Paste the internal clipboard. `at` optionally centres the group. */
export function pasteItems(at: { x: number, y: number } | null = null) {
  const { items: copies, links } = pasteCopies(at);
  if (!copies.length) return [];
  const added = addItems(copies, copies.length > 1 ? `Paste ${copies.length} items` : 'Paste',
    { links });
  // Said even though the copies are visible: a paste fanned out from an
  // original off the edge of the screen can put every copy somewhere you are
  // not looking, and then a working paste and a dead key look the same.
  toast(`Pasted ${itemCount(added.length)}`);
  return added;
}


/**
 * A note's name is its first line, capped and without its heading mark - the
 * copy Search reads (ui/search.ts). Taken at creation (import/drop.ts) and
 * re-taken on every edit, or Find keeps showing the title the note had when it
 * was made. noteNameOf() in board-model.ts, shared by both.
 */
const noteName = noteNameOf;

/*
 * There is no plain-text `setItemText(id, text)` door, and there must not be.
 * It wrote `meta.text` and re-derived the name without touching `meta.rich`,
 * so on a formatted note the structured and flat halves disagreed - the desync
 * storage/mbrd.ts repairs on the way in. Every note edit goes through
 * setNoteContent(), which writes both halves in one commit; the two tests that
 * covered the old door now drive setNoteContent() with no `rich`.
 */

/**
 * Recolour a swatch: its `meta.hex` and the name it wears, as one step.
 *
 * The two are one fact. A swatch has no name of its own to lose - it is a
 * colour and the number for it - so the number *is* the name, which makes it
 * findable in the palette (ui/search.ts reads names) and puts something
 * readable on the system clipboard when one is copied (summarise(), above,
 * falls back to the name for every type but note and link). One commit for the
 * same reason applySnapState() uses one: one act by the user is one Ctrl+Z,
 * and a state where the two disagree is one nobody could produce by hand.
 *
 * The value arrives from an `<input type="color">`, which can only hand over
 * `#rrggbb` - but it also arrives from a .mbrd, so it goes through the same
 * gate the renderer reads it back through. That gate is canvas/renderers.ts,
 * which sits *above* this file, so the check is repeated in miniature rather
 * than imported: six hex digits or nothing happens. A bad value is dropped,
 * not stored and corrected on the way out - the board should not hold a colour
 * it will not show.
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
    // may carry no hex - and setting the key to `undefined` rather than
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
 * Whether two note block models say the same thing, field by field like the
 * other same*() helpers here. JSON.stringify on both depended on key order,
 * and serialised the whole model twice on every editor commit to ask.
 */
function sameRich(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isRecord(a) || !isRecord(b)) return false;
  if (a.font !== b.font || a.size !== b.size || a.valign !== b.valign) return false;
  const x = a.blocks;
  const y = b.blocks;
  if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
  return x.every((block: unknown, i) => {
    const other: unknown = y[i];
    return isRecord(block) && isRecord(other) && block.tag === other.tag &&
      block.align === other.align && block.text === other.text && block.wash === other.wash &&
      sameRuns(block.runs, other.runs);
  });
}

/** Two lines' runs, field by field - a restyle changes these and nothing else. */
function sameRuns(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((run: unknown, i) => {
    const other: unknown = b[i];
    return isRecord(run) && isRecord(other) && run.text === other.text && run.title === other.title &&
      run.font === other.font && run.size === other.size && run.wash === other.wash;
  });
}

/**
 * Commit a note's formatted content - the structured `meta.rich` and the
 * plaintext `meta.text` it flattens to - as one undoable step, so a single
 * Ctrl+Z takes back the whole edit rather than the two halves separately. A
 * no-op when neither half moved, so closing an editor you only looked at
 * spends no history slot. `rich` is trusted to be normalised by the caller
 * (canvas/notes.ts), and `text` is capped here at NOTE_MAX - this is the only
 * door that writes a note's words, so the cap has nowhere else to be.
 */
export function setNoteContent(id: string, rich: unknown, text: unknown) {
  const it = byId(id);
  if (!it || it.type !== 'note') return;
  // Its own binding rather than back over the parameter, so the pair below
  // writes the capped string rather than whatever arrived.
  const next = String(text ?? '').slice(0, NOTE_MAX);
  const prevRich = it.meta.rich;
  const prevText = it.meta.text;
  const prevName = it.name;
  if (prevText === next && sameRich(prevRich, rich)) return;
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
 * Point a text item at new bytes - the text editor's save (ui/editor/). Same
 * id, so the card rebuilds in place rather than being replaced. The old bytes
 * stay reachable through the timeline, which keeps every hash a past step
 * refers to; not meta.was, which is the optimizer's "original" and would be
 * offered for deletion. `session` is what the previous save of this editing
 * session returned: while it is still the top of the undo stack this save
 * folds into it, so one opening of the editor is one step.
 */
export function setItemText(id: string, hash: unknown, session: Command | null = null): Command | null {
  const it = byId(id);
  if (!it || !isHash(hash) || !it.asset?.hash || it.asset.hash === hash) return session;
  const was = { ...it.asset };
  const now = { ...it.asset, hash };
  const write = (asset: typeof was) => {
    const x = byId(id);
    if (!x) return;
    x.asset = { ...asset };
    bus.emit('item', id);
  };
  return commitFolded(session, 'Edit document', () => write(now), () => write(was));
}

/**
 * Replace an item with a new one (fresh id) when its type changes. New id
 * forces the renderer to rebuild the node. Position/z carry over unless
 * `next` overrules them. Selection follows the swap.
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
    carryRelations(out.id, into.id);
    bus.emit('items', { added: [into.id], removed: [out.id] });
    bus.emit('selection');
  };
  commit(label, () => swap(old, item), () => swap(item, old));
  return item;
}

/**
 * Point every relation that names `from` at `to`: the connections, the tour,
 * the playlist and a sticky stuck to it. A retype is the same card under a
 * fresh id, and the save prunes a relation whose id is gone.
 */
function carryRelations(from: string, to: string) {
  const swap = (id: string) => (id === from ? to : id);
  board.connections = board.connections.map(c => {
    if (c[0] !== from && c[1] !== from) return c;
    // SAFETY: each branch rebuilds the arm c has - length > 2 means c[2] is its ConnMeta.
    return (c.length > 2 ? [swap(c[0]), swap(c[1]), c[2]] : [swap(c[0]), swap(c[1])]) as Connection;
  });
  board.tour = board.tour.map(stop =>
    (stop.cards.includes(from) ? { ...stop, cards: stop.cards.map(swap) } : stop));
  board.audioOrder = board.audioOrder.map(swap);
  for (const it of board.items) {
    if (it.meta?.stuckTo === from) it.meta = { ...it.meta, stuckTo: to };
  }
  bus.emit('connections');
  bus.emit('audioOrder', board.audioOrder);
  bus.emit('tour', board.tour);
}

/**
 * Rename an item. Empty name falls back to meta.origName, then the asset
 * registry, then the current name — so clearing restores the original filename.
 * `blank` keeps an empty name empty instead: the text editor's untitled document.
 */
export function renameItem(id: string, name: unknown, { blank = false } = {}) {
  const it = byId(id);
  if (!it) return;
  const orig = typeof it.meta?.origName === 'string' ? it.meta.origName : '';
  const next = String(name ?? '').trim() || (blank ? '' :
               orig ||
               (it.asset?.hash ? assetName(it.asset.hash) : '') || it.name);
  if (it.name === next) return;
  const prev = it.name;
  commit('Rename',
    () => { byId(id)!.name = next; bus.emit('item', id); },
    () => { byId(id)!.name = prev; bus.emit('item', id); });
}

/**
 * One undoable write to one key of one item's `meta`. Validates both the new
 * and old value with the same rule (so the no-op check is honest even on hand-
 * written files). Null removes the key. `same` defaults to Object.is; callers
 * with object values pass a structural comparator.
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

/** Set or remove an item's cover picture. Only the reference is undoable. */
export function setItemCover(id: string, hash: unknown) {
  patchMeta(id, 'cover', hash,
    next => (next ? 'Set picture' : 'Remove picture'),
    value => (isHash(value) ? value : null));
}

/** Change where a link card points. Undoable - the address is a choice, unlike
 *  a fetched title. Validated as a non-empty string here; the caller (commands.ts
 *  editLink) has already run it through linkTyped/linkURL, so what arrives is a
 *  parsed href. The card re-renders off the new URL: watermark, mark and chip.
 *  The fetched title and cover were the old address's, and setEmbedMeta() only
 *  fills a card that lacks a title, so they go in the same step and come back
 *  with its undo. */
export function setLinkURL(id: string, url: unknown) {
  const it = byId(id);
  if (!it) return;
  const valid = (value: unknown) => (typeof value === 'string' && value ? value : null);
  const next = valid(url);
  const prev = valid(it.meta?.url);
  if (next === prev) return;
  const was = { url: prev, title: it.meta?.title, art: it.meta?.art };
  const write = (fields: Record<string, unknown>) => {
    const item = byId(id);
    if (!item) return;
    const { url: _url, title: _title, art: _art, ...rest } = item.meta || {};
    item.meta = rest;
    for (const [key, value] of Object.entries(fields)) if (value != null) item.meta[key] = value;
    bus.emit('item', id);
  };
  commit('Edit link', () => write({ url: next }), () => write(was));
}

/** Set the custom specimen text on a font card, or clear it back to the face's
 *  own name. Undoable - the words are a choice. Empty (or all whitespace) drops
 *  the key, so the renderer falls back to the family name. */
export function setFontText(id: string, text: unknown) {
  patchMeta(id, 'text', text, 'Edit specimen',
    value => (typeof value === 'string' && value.trim() ? value : null));
}

/** Attach a zoomed-out thumbnail. Not undoable (derived data, not a choice). */
export function setItemThumb(id: string, hash: unknown) {
  const it = byId(id);
  if (!it || !isHash(hash) || it.meta?.thumb === hash) return;
  it.meta = { ...it.meta, thumb: hash };
  bus.emit('item', id);
  markDirty();
}

/**
 * Note a baked ~1024px display copy on a photo (meta.display) - the backfill for
 * boards written before it existed (optimize/picture.ts bakeDisplayFor, the Feed,
 * the canvas card). Silent by design: no event and *no dirty flag*, so opening an
 * old board and scrolling it never looks edited. A save that happens for any other
 * reason bakes what is here; until then it lives in memory and is regenerated
 * near-viewport next session. Rides the asset walk (itemHashes) so a save carries
 * it everywhere - unlike setItemThumb, which is a change the user is told about.
 */
export function noteDisplay(id: string, hash: unknown) {
  const it = byId(id);
  if (!it || !isHash(hash) || it.meta?.display === hash) return;
  it.meta = { ...it.meta, display: hash };
}

/**
 * Store a fetched embed's song title and album-art hash on a link card. Not
 * undoable: it is fetched fact, not a choice the user made, the same footing as
 * a thumbnail (setItemThumb above). meta.art rides the asset walk (itemHashes,
 * util.ts) so cloud sync keeps the cover; meta.title is plain text. Written by
 * canvas/embed-meta.ts, the one place in the app that reaches the network to
 * decorate a card - guarded so it only ever runs for a card that lacks a title.
 */
export function setEmbedMeta(id: string, patch: { title?: unknown; art?: unknown }) {
  const it = byId(id);
  if (!it) return;
  const title = typeof patch.title === 'string' && patch.title ? patch.title : null;
  const art = isHash(patch.art) ? patch.art : null;
  const setsTitle = title !== null && it.meta?.title !== title;
  const setsArt = art !== null && it.meta?.art !== art;
  if (!setsTitle && !setsArt) return;
  const next = { ...it.meta };
  if (setsTitle) next.title = title;
  if (setsArt) next.art = art;
  it.meta = next;
  bus.emit('item', id);
  markDirty();
}

/**
 * Set a video poster (first frame) if the item has no cover. Not undoable.
 * `dangling` overrides the refusal when the existing cover hash has no bytes
 * behind it (repair path — state.ts cannot check the registry itself).
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
 * Batch-swap items to optimised copies. One undo for the whole board.
 * Each swap: hash replaces, null removes, absent = leave alone.
 * Originals go to meta.was/wasCover so the autosave sweep keeps them for undo.
 * meta.opt records what was optimised — prevents re-encoding on a second run.
 */
export type AssetSwap = {
  id: string,
  asset?: string | null,
  cover?: string | null,
  // The new asset is a plain picture that draws itself - a RAW, developed and
  // shrunk. Its stand-ins go with the old bytes, and ext/mime follow the new.
  plain?: { ext: string, mime: string },
  // Forget meta.source: the .heic or the camera RAW a card's picture was
  // decoded from at import. The one original this does not move to meta.was,
  // because there is nothing to come back for - the card has drawn the
  // decoded picture since the day it arrived. Undo restores the reference like
  // any other field, so the bytes leave on the first save after that.
  dropSource?: boolean,
};

export function swapAssets(swaps: AssetSwap[] | null | undefined, label = 'Optimize board') {
  const list = (swaps || []).filter(s => s && byId(s.id));
  if (!list.length) return 0;

  const before = list.map(({ id }) => {
    const it = byId(id)!;
    return { id, asset: it.asset ? { ...it.asset } : null, meta: { ...it.meta } };
  });

  // No actual swaps → mark items as seen outside the undo stack.
  const swapping = list.some(({ id, asset, cover, dropSource }) => {
    const it = byId(id)!;
    return (isHash(asset) && it.asset?.hash && asset !== it.asset.hash) ||
           (isHash(cover) && isHash(it.meta?.cover) && cover !== it.meta.cover) ||
           (asset === null && !!it.asset) ||
           (cover === null && isHash(it.meta?.cover)) ||
           // Throwing an original away is a change, and an undoable one, even
           // on a card whose picture was already small enough to keep.
           (!!dropSource && isHash(it.meta?.source));
  });
  if (!swapping) {
    for (const { id } of list) {
      const it = byId(id);
      if (it) it.meta = { ...it.meta, opt: [...itemHashes(it)] };
    }
    markDirty();
    return 0;
  }

  const forward = () => {
    for (const { id, asset, cover, plain, dropSource } of list) {
      const it = byId(id);
      if (!it) continue;
      const meta = { ...it.meta };
      // Before the branches below, and unconditional on whether the picture
      // itself changed: a card already inside the ceiling still gives back the
      // whole weight of the file it was decoded from.
      if (dropSource) delete meta.source;
      // null = remove reference. Original pinned by `was` for undo.
      if (asset === null && it.asset?.hash) {
        if (!isHash(meta.was)) meta.was = it.asset.hash;
        it.asset = null;
      } else if (isHash(asset) && it.asset?.hash && asset !== it.asset.hash) {
        // Only the first swap records the original.
        if (!isHash(meta.was)) meta.was = it.asset.hash;
        it.asset = { ...it.asset, hash: asset };
        // The old preview and display copy stay on the undo step's before
        // side, which is what keeps their bytes (timelineHashes).
        if (plain) {
          delete meta.preview;
          delete meta.display;
          delete meta.demosaiced;
          meta.ext = plain.ext;
          meta.mime = plain.mime;
        }
      }
      if (cover === null && isHash(meta.cover)) {
        if (!isHash(meta.wasCover)) meta.wasCover = meta.cover;
        delete meta.cover;
      } else if (isHash(cover) && isHash(meta.cover) && cover !== meta.cover) {
        if (!isHash(meta.wasCover)) meta.wasCover = meta.cover;
        meta.cover = cover;
      }
      it.meta = meta;
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
 * Let go of the files the optimiser replaced: the bytes meta.was and
 * meta.wasCover keep so that undoing an Optimize can put the old picture back.
 *
 * Undoable in the sense that matters - the *board* is unchanged either way, so
 * this is not on the history at all. What it changes is what the next autosave
 * sweep is allowed to collect: those two keys are not in itemHashes(), which
 * drives the packer, but referencedHashes() (storage/session.ts) keeps them on
 * purpose, so they outlive the undo that wanted them unless something says
 * otherwise. This is that something. It is a one-way door and the caller says
 * so before opening it.
 *
 * The drawer as well as the board, because a binned card carries its memo too
 * and can be restored. Returns the hashes let go, for the caller that frees
 * them - see replaceOldVersions(), which is the other half of the same act.
 */
export function discardOriginals(): string[] {
  const gone: string[] = [];
  const strip = (it: Item | null | undefined) => {
    if (!it?.meta || (!isHash(it.meta.was) && !isHash(it.meta.wasCover))) return;
    const { was, wasCover, ...rest } = it.meta;
    if (isHash(was)) gone.push(was);
    if (isHash(wasCover)) gone.push(wasCover);
    it.meta = rest;
  };
  for (const it of board.items) strip(it);
  for (const entry of board.trash) strip(entry.item);
  if (gone.length) markDirty();
  return gone;
}

/** How many items are still holding a pre-optimisation original. */
export const originalsHeld = () =>
  board.items.filter(it => isHash(it.meta?.was) || isHash(it.meta?.wasCover)).length;

/**
 * Which way up a model file is read.
 *
 * 'z' or 'y'. Anything else clears the override and hands the decision back to
 * the format's own default, which is what a board that has never been told
 * carries - see defaultUpAxis() in mesh.ts.
 *
 * Its own setter rather than a general "write anything into meta", for the same
 * reason setItemCover has one: `meta` is the open field precisely because
 * nothing polices it, and the two things in there that this app itself reads
 * are better off with a door each than with a hole.
 *
 * Undoable, because it is a visible change to an item and every other visible
 * change to an item is.
 *
 * **The photograph goes with it.** A model card is a WebP of itself nearly all
 * the time (canvas/model.ts), and standing the model up is the one edit that
 * turns that picture into a picture of something else - the part is lying on its
 * side in it, and nothing about writing `upAxis` makes the card notice. Dropping
 * the reference sends the card back to live geometry, which re-reads the mesh
 * under the new axis and photographs it again on the way past; that is the same
 * route a palette change takes, and it is why nothing here has to know how a
 * still is made.
 *
 * Written by hand rather than through patchMeta() for that second key alone, and
 * in **one** commit with the axis: a history entry that put the old reading back
 * and left the new photograph would show a model standing up in a picture of it
 * lying down. The bytes stay in the registry either way - undo has to be able to
 * put the picture back, and the autosave sweep is what eventually collects
 * anything no item points at, exactly as for setItemCover() above.
 */
export function setItemUpAxis(id: string, axis: unknown) {
  const it = byId(id);
  if (!it) return;
  const pick = oneOf('z', 'y');
  const next = pick(axis);
  const prev = pick(it.meta?.upAxis);
  if (Object.is(next, prev)) return;
  // shotInk travels with the shot in both directions: it is only ever read
  // beside one, so leaving it behind would be a note about a photograph that no
  // longer exists, and dropping it on the way back would make a still that has
  // gone stale look current.
  const shot = it.meta?.shot;
  const shotInk = it.meta?.shotInk;
  const write = (up: unknown, keep: unknown, ink: unknown) => {
    const item = byId(id);
    if (!item) return;
    const meta = { ...item.meta };
    if (up == null) delete meta.upAxis; else meta.upAxis = up;
    if (keep == null) delete meta.shot; else meta.shot = keep;
    if (ink == null) delete meta.shotInk; else meta.shotInk = ink;
    item.meta = meta;
    bus.emit('item', id);
  };
  commit('Turn model upright',
    () => write(next, null, null),
    () => write(prev, shot, shotInk));
}

/**
 * Per-item fit override (cover/contain): how the picture meets its grid cells.
 * Undoable. Changes no box - see fitMode() in canvas/renderers.ts.
 */
export function setItemFit(id: string, fit: unknown) {
  const it = byId(id);
  if (!it || (it.type !== 'image' && it.type !== 'video')) return;
  patchMeta(id, 'fit', fit, 'Fit media', oneOf('cover', 'contain'));
}

/**
 * Toggle the card (paper/shadow) off an item — for cut-outs and models.
 * Only image, note, model. The box stays for hit-testing and selection.
 */
export function setItemBare(id: string, bare: unknown) {
  const it = byId(id);
  if (!it || (it.type !== 'image' && it.type !== 'note' && it.type !== 'model')) return;
  // Only stored when true — false is the default and not worth a byte per card.
  patchMeta(id, 'bare', bare ? true : null,
    (next: unknown) => (next ? 'Take the card off' : 'Put the card back'),
    v => (v === true ? true : null));
}

/**
 * Draw a sticky's paper at 60%, its words solid. Notes only - the row that took "No card"'s
 * place on them. Stored only when true, like `bare`.
 */
export function setItemFaded(id: string, faded: unknown) {
  if (byId(id)?.type !== 'note') return;
  patchMeta(id, 'faded', faded ? true : null,
    (next: unknown) => (next ? 'Low opacity' : 'Full opacity'),
    v => (v === true ? true : null));
}

/**
 * A text document that is ASCII art, which the viewer shows unwrapped - set in
 * the editor. Any item with a file may carry it; only text reads it. Stored
 * only when true, like `bare`.
 */
export function setItemAscii(id: string, ascii: unknown) {
  if (!byId(id)?.asset?.hash) return;
  patchMeta(id, 'ascii', ascii ? true : null,
    (next: unknown) => (next ? 'ASCII art' : 'Not ASCII art'),
    v => (v === true ? true : null));
}

/** Sticker colour override. Clamped to the palette that exists. */
export function setStickerTint(id: string, tint: unknown) {
  const it = byId(id);
  if (!it || it.type !== 'sticker') return;
  patchMeta(id, 'tint', tint, 'Sticker colour',
    value => stickerTint(value, it.meta?.shape));
}

/** A fence's colour: a note sheet 1-4, or 0 to take it off. The same range
 *  noteTint() reads (canvas/note-model.ts), written out because state.ts sits
 *  under the canvas. */
export function setFenceTint(id: string, tint: unknown) {
  if (!isFence(byId(id))) return;
  patchMeta(id, 'tint', tint, 'Fence colour',
    value => (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4
      ? value : null));
}

/** A note's sheet, 1-4, after it was written - the same range setFenceTint()
 *  takes, less the 0: a note always sits on one sheet or another. */
export function setNoteTint(id: string, tint: unknown) {
  if (byId(id)?.type !== 'note') return;
  patchMeta(id, 'tint', tint, 'Note colour',
    value => (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4
      ? value : null));
}

/** Roll a fence up to its name bar, or down again. Stored only when rolled. */
export function setFenceRolled(id: string, rolled: boolean) {
  if (!isFence(byId(id))) return;
  patchMeta(id, 'rolled', rolled ? true : null,
    (next: unknown) => (next ? 'Roll up fence' : 'Roll down fence'),
    v => (v === true ? true : null));
}

/** Roll down every fence that hides this item. Find's way to a folded card. */
export function unrollFor(id: string) {
  const rolled = rolledFences();
  let fence = fenceOf(byId(id));
  for (let depth = 0; fence && depth < 64; depth++) {
    if (rolled.has(fence.id)) setFenceRolled(fence.id, false);
    fence = fenceOf(fence);
  }
}

/**
 * Anchor/unanchor items (fix geometry). One undo for the whole set.
 * Excludes ghosts (app-owned) and riders (placed from their host).
 */
export function setItemsLocked(ids: Iterable<string>, locked: boolean) {
  const affected = [...new Set(ids)].filter(id => {
    const it = byId(id);
    return !!it && it.type !== 'ghost' && !isRider(it) && !!it.meta.locked !== locked;
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
  // "Anchor"/"Unanchor" — the menu's word, not the stored key (meta.locked).
  commit((locked ? 'Anchor' : 'Unanchor') + many,
    () => write(locked), () => write(!locked));
}

/**
 * A new fence anchoring itself (the fresh-fence clock in sticky.ts). Not an
 * undo step: nobody did it, so Ctrl+Z must not be spent taking it back.
 */
export function anchorQuietly(id: string) {
  const it = byId(id);
  if (!it || it.meta.locked) return;
  it.meta = { ...it.meta, locked: true };
  bus.emit('item', id);
  markDirty();
}

/** Set or clear an image's crop (four fractions of the source). */
export function setItemCrop(id: string, crop: unknown) {
  const it = byId(id);
  // Images only — video has no decoded bitmap to crop outside playback.
  if (!it || it.type !== 'image') return;
  patchMeta(id, 'crop', crop, next => (next ? 'Crop' : 'Undo crop'),
    value => itemCrop({ meta: { crop: value } }), sameRect);
}

/** Two crop rectangles, or two absences, are the same crop. */
const sameRect = (a: unknown, b: unknown) => {
  if (!isRecord(a) || !isRecord(b)) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
};

/** Brightness/contrast/saturation. Partial: each dial writes its own key. */
export function setItemAdjust(id: string, adjust: unknown) {
  const it = byId(id);
  if (!it || (it.type !== 'image' && it.type !== 'video')) return;
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
 * Which quarter turn one picture is hung at: 90, 180, 270, or null for none.
 *
 * Pictures only, on exactly the terms setItemFlip() above gives - the darkroom
 * is the only door and canEditPicture() will not open it on a clip, so a wider
 * guard here would be a door onto a room with no handle. Widen both together or
 * neither.
 *
 * The validator is itemRotate(), which rounds to the nearest quarter and folds
 * a full turn back to nothing, so what reaches the file is what every reader
 * gets back out of it. Same comparator as any other scalar - Object.is, which is
 * patchMeta()'s default - because two turns are the same turn when the numbers
 * are, and both sides have already been through the validator.
 */
export function setItemRotate(id: string, rotate: unknown) {
  const it = byId(id);
  if (!it || it.type !== 'image') return;
  patchMeta(id, 'rotate', rotate, next => (next ? 'Turn picture' : 'Unturn picture'),
    value => itemRotate({ meta: { rotate: value } }));
}

/**
 * Whether one picture is shown with its background taken out.
 *
 * Pictures only, for the reason the turn above is. itemMatte() is the validator
 * and answers a boolean, so anything truthy stores as the flag and anything else
 * removes the key - which is why the call below normalises to `true` or `null`
 * rather than passing a caller's value through. `false` would be a key that says
 * the default.
 *
 * **This one costs real work on every consumer, unlike the other four**, and it
 * is worth knowing where: the cut is a neural network over the pixels
 * (canvas/matte.ts), so it happens where the display copy is made and again at
 * export, and on the main thread both times. Writing it is still one meta key
 * and one undo entry, which is what keeps it the same kind of thing as the crop
 * from here.
 */
export function setItemMatte(id: string, matte: unknown) {
  const it = byId(id);
  if (!it || it.type !== 'image') return;
  patchMeta(id, 'matte', matte ? true : null,
    next => (next ? 'Remove background' : 'Restore background'),
    value => itemMatte({ meta: { matte: value } }));
}

/**
 * Put a developed RAW on its card, with the thumbnail and display copy cut
 * from it. One undo entry, and Undo puts back exactly what was there.
 *
 * Where it goes depends on which shape the card is in, which is what
 * `asItsFile` says. A RAW imported since the importer started developing them
 * already holds a picture at asset.hash and the sensor at meta.source, so the
 * full develop *replaces the file* and meta.source is untouched - the sensor
 * stays until the optimiser throws it away. On a board written before that,
 * the RAW is still the file and the developed picture goes where the camera's
 * own preview was.
 *
 * `demosaiced` is what stops the menu offering it twice, in both shapes.
 */
export function setItemDemosaiced(id: string, picture: {
  picture: unknown, thumb?: unknown, display?: unknown, mime?: unknown, asItsFile?: boolean,
}) {
  const it = byId(id);
  if (!it || it.type !== 'image' || !isHash(picture.picture)) return;
  const beforeMeta: Record<string, unknown> = { ...it.meta };
  const beforeAsset = it.asset ? { ...it.asset } : null;
  const after: Record<string, unknown> = { ...it.meta, demosaiced: true };
  // Copies of the picture that was there are not copies of this one.
  delete after.thumb;
  delete after.display;
  if (isHash(picture.thumb)) after.thumb = picture.thumb;
  if (isHash(picture.display)) after.display = picture.display;
  const mime = typeof picture.mime === 'string' ? picture.mime : '';
  if (picture.asItsFile) {
    after.mime = mime;
    if (mime.startsWith('image/')) after.ext = mime.slice('image/'.length);
    // The card's file is the picture now; there is no stand-in left to keep.
    delete after.preview;
  } else {
    after.preview = picture.picture;
  }
  const write = (meta: typeof beforeMeta, asset: typeof beforeAsset) => {
    const item = byId(id);
    if (!item) return;
    item.meta = { ...meta };
    if (asset) item.asset = { ...asset };
    bus.emit('item', id);
  };
  // SAFETY: isHash(picture.picture) is the guard this function opens with, and
  // nothing below reassigns it.
  const afterAsset = picture.asItsFile && beforeAsset
    ? { ...beforeAsset, hash: picture.picture as string } : beforeAsset;
  commit('Demosaic',
    () => write(after, afterAsset),
    () => write(beforeMeta, beforeAsset));
}

/** Two axis maps with the same tags and values, whatever order those were written in. */
const sameAxes = (a: Record<string, number>, b: Record<string, number>) => {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every(tag => a[tag] === b[tag]);
};

/**
 * Two Mobile headers are the same header.
 *
 * Field by field, not by serialisation, and the axes map by tag and value:
 * normalizeMobileHeader() builds `axes` by Object.entries iteration, so two
 * equal maps written by different palettes or read from different files can
 * carry their tags in different orders. Compared as JSON that reads as a change,
 * and the change would re-emit and re-dirty for nothing - the false negative
 * ui/look.ts documents, here on the door the masthead sliders write through.
 */
const sameHeader = (a: MobileHeader, b: MobileHeader) =>
  a.font === b.font && a.size === b.size && a.stretch === b.stretch
  && a.leading === b.leading && a.weight === b.weight && a.offset === b.offset
  && a.italic === b.italic && a.wrap === b.wrap && sameAxes(a.axes, b.axes);

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
// The two mutations that own meta.loose - see the header of sticky.ts for what
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
  // the same question, and the settling block in sticky.ts.
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
 * Called with the ids a *pointer* gesture drove, from canvas/input.ts, and only
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

// select(), clearSelection() and deselect() moved down to board-store.ts, which
// owns the Set they write to - see the note beside them there. This one stayed:
// it needs the item list, and board-model.ts sits *above* board-store.ts in the
// graph, so the module holding the selection cannot ask what is on the board.
export function selectAll() {
  // Not what a rolled-up fence has folded away: Delete after Ctrl+A must not
  // take cards nobody can see.
  const rolled = rolledFences();
  select(board.items.filter(i => !rolledAway(i, rolled)).map(i => i.id));
}

// ---------------------------------------------------------------------------
// Settings + whole-board replacement
// ---------------------------------------------------------------------------

export function setSetting(key: string, value: unknown) {
  // Paper is Desktop-only, and this is where that is actually enforced: the
  // fixup in activateLayoutSettings() runs once, at the moment of the switch,
  // so without this a later write would put a sheet on the Mobile board.
  if (board.layoutMode === 'mobile' &&
      ['paperShow', 'paper', 'paperLandscape', 'paperResize'].includes(key)) return;
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
    if (sameHeader(board.mobileHeader, header)) return;
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
    // Board-level too, and read by ui/appearance.ts's palette extraction.
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
export function setTour(stops: unknown) {
  board.tour = normalizeTour(stops, filedIds());
  markDirty();
  bus.emit('tour', board.tour);
}

/** Every card the tour already stops at, whichever stop it is in. */
const tourCards = () => new Set(board.tour.flatMap(stop => stop.cards));

/**
 * May this item be a stop on the tour?
 *
 * Two refusals, and one rule about them rather than three copies of it: the door
 * that adds a stop (below), the runner that resolves one (stops() in
 * ui/tour.ts) and the editor that marks the cards (markFor() in ui/tour-edit.ts)
 * all have to agree, and they used to agree by each spelling out the same test.
 *
 * **Furniture.** The title card and the hint cards are the app's own scenery,
 * not things somebody put on the board.
 *
 * **Anything stuck to a host.** A sticker or a note lying on a card is part of
 * that card - it travels with it, it is dragged by it, and the camera framing
 * "the sticker" would be framing the photograph underneath it at a tighter zoom
 * and calling it a different stop. Being *on* a card is what these are for, so
 * the one thing a tour can honestly stop at is the card.
 *
 * stuckTo() and not isPinned(), which is the same question behind a ten-second
 * settle clock. That clock is for *grips* - a sticker dropped three seconds ago
 * is still the thing you reached for, so it keeps its handles - and it has no
 * business here: a stop that could be made for ten seconds after a drop and not
 * afterwards is a rule nobody could learn.
 *
 * A card that becomes stuck while it is already on the tour keeps its place in
 * board.tour and is skipped everywhere it is read, which is exactly what happens
 * to a card in the bin. Unstick it and its stop comes back.
 */
export function canTour(item: Item | null | undefined): boolean {
  return !!item && !isFurniture(item) && !stuckTo(item);
}

/**
 * Add one stop holding everything in `ids`, at the end of the tour.
 *
 * The everyday door, and the one the editor's Add button presses over a
 * selection. Six selected cards make **one** stop rather than six, because
 * that is the whole of what a group is for - the alternative is reachable by
 * adding them one at a time, and the reverse is not reachable at all if this
 * flattened.
 *
 * Board stacking order rather than selection order, for the reason the old
 * member door gave: a selection iterates in whichever order it was built, and
 * "these three, framed together" has no order anybody meant. Within one stop it
 * only decides which card the fit starts from, and across a marquee it is the
 * difference between a stop that reads as the block it is and one that does
 * not.
 *
 * Anything canTour() refuses is dropped here without a word - a marquee over a
 * photograph and the three stickers lying on it is a marquee somebody drew round
 * one thing, and it makes a stop of the photograph.
 *
 * Cards already on the tour are dropped rather than moved: a card is at exactly
 * one stop (see normalizeTour), and silently pulling one out of stop 2 because
 * it was in a marquee for stop 7 is not something anybody asked for. Returns
 * how many cards the new stop holds, so the caller can say nothing happened.
 */
export function addTourStop(ids: Iterable<string>): number {
  const wanted = new Set(ids);
  if (!wanted.size) return 0;
  const already = tourCards();
  const cards = board.items
    .filter(i => wanted.has(i.id) && !already.has(i.id) && canTour(i))
    .map(i => i.id);
  if (!cards.length) return 0;
  setTour([...board.tour, { cards }]);
  return cards.length;
}

/**
 * Take *cards* off the tour, wherever they are - the mirror of addTourStop().
 *
 * Cards and not stops, and the editor needs both doors. A mark sits on one card
 * and can only honestly mean that card: pressing the "3" on one photograph of a
 * stop holding three of them must leave the other two framed together, or the
 * mark would be a stop-delete button wearing a card's clothes. A stop emptied by
 * the removal goes with it - see dropFromTour(), which is the same rule the
 * merge halves use and is shared with them for that reason.
 *
 * Takes a list for the same reason addTourStop() does: the bar's button works on
 * the selection, and a loop of single removals would be a write, a normalise and
 * an event per card.
 *
 * Cards that are not on the tour are ignored, and silently: this is reachable
 * from a mark drawn against a list that has changed under it.
 */
export function removeTourCards(ids: Iterable<string>) {
  const wanted = new Set(ids);
  if (!wanted.size) return;
  if (!board.tour.some(stop => stop.cards.some(id => wanted.has(id)))) return;
  setTour(dropFromTour(board.tour, wanted));
}

/**
 * Take one whole stop off the tour, as one undo step - the tour editor's
 * Delete. The other tour edits here are not history entries; this one is,
 * because Delete is the key that removes things and an undo is expected of it.
 * The cards stay on the board.
 */
export function removeTourStop(index: number): boolean {
  const stop = board.tour[index];
  if (!stop) return false;
  // Only this stop moves, never a captured whole tour: the other tour edits are
  // off the stack, and writing a copy back would undo them with it. A card is at
  // one stop, so its cards find the stop again wherever the list has moved it.
  const cards = new Set(stop.cards);
  commit('Remove stop',
    () => setTour(dropFromTour(board.tour, cards)),
    () => {
      const held = tourCards();
      const back = { ...stop, cards: stop.cards.filter(id => !held.has(id)) };
      if (!back.cards.length) return;
      const at = Math.min(index, board.tour.length);
      setTour([...board.tour.slice(0, at), back, ...board.tour.slice(at)]);
    });
  return true;
}

/**
 * Break one grouped stop into a stop per card, where it stands.
 *
 * The exact reverse of adding several cards at once, and the reason both exist:
 * a group is a decision - these three are framed together and seen as one - and
 * a decision that can only be made and never unmade is one people stop making.
 * Before this, undoing a group meant taking all three cards off the tour and
 * putting them back one at a time, in the right places.
 *
 * The caption goes to the first of the new stops and to none of the others. It
 * was written about a group that no longer exists, so copying it onto every
 * piece would put the same sentence on the bar three stops running; dropping it
 * would throw away something somebody typed. The first is the one the tour still
 * reaches at the moment the old stop did.
 *
 * A stop of one card is already split and is a no-op, not a throw.
 */
export function splitTourStop(index: number) {
  const stop = board.tour[index];
  if (!stop || stop.cards.length < 2) return;
  const pieces: TourStop[] = stop.cards.map((id, i) => (
    i === 0 && stop.caption ? { cards: [id], caption: stop.caption } : { cards: [id] }
  ));
  setTour([...board.tour.slice(0, index), ...pieces, ...board.tour.slice(index + 1)]);
}

/**
 * Join a stop to the one after it, making one stop of the two.
 *
 * `index` and `index + 1`, rather than a pair of indices, because the two have
 * to be neighbours for the result to mean anything: a stop is a place in a
 * reading, and joining the second to the seventh would have to move one of them
 * as well as merge them, which is two acts wearing one name. Joining a run of
 * four is this three times, and each press leaves a list somebody can look at.
 *
 * Cards in order, first stop's then second's, each group keeping the order it
 * had. Not re-sorted into board order the way addTourStop() does it - that one
 * is turning a *selection*, which has no order anybody meant, into a stop; this
 * one is merging two lists that were each already decided.
 *
 * The caption is the first one there is. Two captions cannot both survive a
 * merge, and the earlier stop is the one whose place in the tour the join keeps.
 */
export function joinTourStops(index: number) {
  const a = board.tour[index];
  const b = board.tour[index + 1];
  if (!a || !b) return;
  const caption = a.caption || b.caption;
  const joined: TourStop = caption
    ? { cards: [...a.cards, ...b.cards], caption }
    : { cards: [...a.cards, ...b.cards] };
  setTour([...board.tour.slice(0, index), joined, ...board.tour.slice(index + 2)]);
}

/**
 * Move a stop to another place in the order - what the editor's drag writes.
 *
 * `to` is the index the stop should end up at in the list as the user sees it,
 * which is why the removal happens before the insertion rather than after: a
 * stop dragged from 1 to 4 lands at 4 of the *remaining* list, and computing it
 * the other way round puts it one short of where the cursor was.
 */
export function moveTourStop(from: number, to: number) {
  const stop = board.tour[from];
  if (!stop) return;
  const rest = board.tour.filter((_, i) => i !== from);
  const at = Math.min(Math.max(Math.trunc(to) || 0, 0), rest.length);
  rest.splice(at, 0, stop);
  setTour(rest);
}

/**
 * What is said at a stop, or nothing.
 *
 * Written through setTour() like every other edit here, so the caption goes
 * through the same normaliser the file reader uses - one place decides what a
 * caption may be, and an empty one is a stop with no caption rather than a stop
 * with an empty one.
 */
export function setTourCaption(index: number, caption: string) {
  const stop = board.tour[index];
  if (!stop) return;
  const next: TourStop[] = board.tour.map((s, i) => (i === index ? { ...s, caption } : s));
  setTour(next);
}

/**
 * The tour with a set of cards taken out of it, stop by stop.
 *
 * The two halves of a merge each need this and they need it to be the same
 * thing, which is why it is a function rather than the two one-liners the flat
 * list allowed. A stop emptied by the removal goes with the cards - the alone
 * alternative is a stop the camera has nothing to fly to, and it would survive
 * every later normalise because there is nothing wrong with its shape.
 */
function dropFromTour(tour: TourStop[], ids: Set<string>): TourStop[] {
  return tour
    .map(stop => ({ ...stop, cards: stop.cards.filter(id => !ids.has(id)) }))
    .filter(stop => stop.cards.length);
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
  const { connections, audioOrder, tour } = plan;
  // planMerge() places the block beside the host in Canvas terms, which on the
  // Feed is outside the column: there the arrivals are packed below, as a drop is.
  const items = board.layoutMode === 'mobile' ? placeMobileItems(plan.items) : plan.items;
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
    board.tour = [...dropFromTour(board.tour, ids), ...tour];
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
    board.tour = dropFromTour(board.tour, ids);
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

/** Rename the board by hand: one undo, and one Timeline step for a run of
 *  renames. setTitle() stays quiet for the app's own writes (the save picker, a load). */
export function renameBoard(title: unknown) {
  const next = cleanBoardTitle(title) || 'Untitled board';
  const prev = board.title;
  if (next === prev) return;
  commit('Rename board', () => setTitle(next), () => setTitle(prev));
}

/**
 * Change the look as one step. `from` is the look before a drag began, for a
 * panel that showed the drag live: the step runs from where it started. Emits
 * 'board', which is what ui/appearance.ts repaints the look from on an undo.
 */
export function commitAppearance(next: unknown, from: unknown = structuredClone(board.settings.appearance),
  label = 'Whimsy') {
  const write = (look: unknown) => () => { setAppearance(look); bus.emit('board'); };
  commit(label, write(next), write(from), 1, write(from));
}

/**
 * Restyle the header - the Feed's masthead and the Canvas title card - as one
 * step. `from` is the style before a slider drag began, for a panel that wrote
 * the drag live: the step then runs from where the drag started, so a drag is
 * one step, as a move is, and a run of them folds into one on the Timeline.
 */
export function commitHeader(next: unknown, from: MobileHeader = board.mobileHeader) {
  const header = normalizeMobileHeader(next);
  const write = (value: MobileHeader) => () => setSetting('mobileHeader', value);
  if (sameHeader(from, header)) { write(header)(); return; }
  commit('Edit header', write(header), write(from), 1, write(from));
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
  board.hadMusic = next.hadMusic;
  board.extra = next.extra;
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
  // answers about the board that just left. See dropIdIndex() in board-model.ts.
  dropIdIndex();
  // The latch travels with the board, not the session: one that arrives with
  // content has already been past this point, and one that arrives empty earns
  // its hints. See ensureGhostCards(), which main.ts calls on 'board:load'.
  //
  // isContent(), not `type !== 'title'`: fences are furniture too, so a board of
  // nothing but regions is a board with nothing in it and has not earned its
  // hints away. This is the same question hasContent() asks, and it drifted from
  // it when fences arrived.
  resetGhostLatch(board.items.some(isContent));
  // The Desktop title card is seeded by the app (main.ts, on 'board:load'), not
  // here: keeping loadBoard() free of it lets state tests load and serialise a
  // board of exactly the items they gave it. See ensureTitleCard().
  // Before completeLayout(): the Mobile carry below asks stuckTo() where each
  // note belongs, so the memo has to hold *this* board's answers, not the last
  // board's. Seeding also drops the old board's ids, which two files can share.
  seedSticks();
  // And the same for fences, for a stronger version of the same reason: a board
  // opened straight into Mobile cannot measure membership at all until somebody
  // switches modes, so meta.fence is the only thing that knows. See fences.ts.
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
  // The clipboard crosses a board only with its bytes - see clipboardOnBoardLoad().
  clipboardOnBoardLoad();
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
  // a sound at all, which cuelume/engine.ts asks about before every cue. The
  // restored session is exactly that page.
  cue('arrive');
}

