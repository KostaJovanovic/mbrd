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
  reseedGhostCards,
} from './onboarding.ts';

export {
  GHOST_IDS, NOTFOUND_IDS, tapeFor, hasContent, hasGhosts, isNotFoundBoard,
  leaveNotFoundBoard, ensureGhostCards, dismissGhosts, resetGhostLatch,
  reseedGhostCards,
};

import {
  clearClipboard, clipboardBounds, clipboardHasOurs, clipboardSize, cloneItem,
  copyItems, itemCount, itemsIn, pasteCopies, takeItems,
} from './clipboard.ts';

export { clipboardBounds, clipboardHasOurs, clipboardSize, copyItems };

import {
  removeItems, restoreItems, emptyTrash, setAssetPurge, freezeClip, clipHomeId,
  stuckHostId,
} from './trash.ts';

export {
  removeItems, restoreItems, emptyTrash, setAssetPurge, freezeClip, clipHomeId,
  stuckHostId,
};
import {
  bus, selection, isDirty, markDirty, resetDirty,
  select, clearSelection, deselect, tagFilter, setTagFilter,
  isMultiSelect, setMultiSelect, resetMultiSelect,
} from './board-store.ts';
import {
  commit, undo, redo, historyState, historyDepth, historyWeight,
  clearHistory, lastCommand, takeBack,
} from './history.ts';
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
import {
  isLocked, isFiltered, itemCrop, itemAdjust, adjustFilter, itemFlip, flipTransform,
  itemRotate, itemMatte, itemBare,
  itemTags, boardTags, cleanTag,
  normalizeTour, TAGS_PER_ITEM, TAG_MAX, MIN_CROP,
} from './board-model.ts';
import type { Item, MobileHeader, TourStop } from './board-model.ts';
import type { MergePlan } from './merge.ts';

export { MAX_CONNECTIONS, pairKey, CONN_DIRECTIONS, CONN_STYLES };
export { isLocked, isFiltered, itemCrop, itemAdjust, adjustFilter, itemFlip, flipTransform };
export { itemRotate, itemMatte, itemBare };
export { itemTags, boardTags, cleanTag };
export { TAGS_PER_ITEM, TAG_MAX, MIN_CROP };

import {
  areConnected, connectedTo, toggleConnection, addConnections, clearConnections,
  updateConnection, connectionMeta,
} from './connections.ts';

export {
  areConnected, connectedTo, toggleConnection, addConnections, clearConnections,
  updateConnection, connectionMeta,
};

import {
  STICK_MIN, stuckTo, wouldStick, restick, seedSticks,
  stuckPlacement, isRider, stuckFollowers, isPinned, dragRoot, hostUnder, isSticky,
  startSettling, isSettling, settlesIn, SETTLE_MS, startFresh,
} from './sticky.ts';

import {
  isFence, fenceOf, fenceAt, fenceMembers, fenceFollowers, refence, refenceAround,
  refenceArrivals, seedFences, fenceBox, nextFenceName,
} from './fences.ts';

import { stickerTint } from './stickers/catalogue.ts';

import {
  activateLayoutSettings, applyGeom, baseStep, commitGeom, completeLayout, fitBoardMode, mobileBoardWidth, placeMobileItems, recheckBoardGeometry, repackMobileBoard, snapAll, snapshotGeom, travelling, unsnapAll, writeLayout,
} from './layout.ts';

export { recheckBoardGeometry };

export { raiseSelection, lowerSelection, stackOrder, visualStackOrder, stackLayerIds, selectionHasStackOverlap } from './stacking.ts';

export {
  setBoardMode, mobileBoardTop, mobileBoardBottom, mobileBoardWorldWidth,
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
  fenceBox, nextFenceName,
};

export {
  NOTE_MAX, DEFAULT_MOBILE_HEADER, DEFAULT_SETTINGS, BOARD_MODES, BOARD_TITLE_MAX,
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
  options: { avoidOverlap?: boolean } = {},
) {
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
            bus.emit('items', { added: fresh.map(a => a.id), removed: [] }); },
    () => { const ids = new Set(added.map(a => a.id));
            board.items = board.items.filter(i => !ids.has(i.id));
            ids.forEach(id => selection.delete(id));
            bus.emit('items', { added: [], removed: [...ids] }); bus.emit('selection'); },
    added.length);
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

/** Restore the title card from the bin. Undoable. */
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
// Clipboard commands that touch the board (cut + paste)
// ---------------------------------------------------------------------------

/** Copy then delete. Cut items go to the bin (recoverable). */
export function cutItems(ids: Iterable<string>) {
  // takeItems() instead of copyItems() to avoid a double-toast.
  const src = itemsIn(ids);
  const text = takeItems(src);
  if (!text) return '';
  const doomed = src.map(i => i.id);
  removeItems(doomed, doomed.length > 1 ? `Cut ${doomed.length} items` : 'Cut');
  toast(`Cut ${itemCount(doomed.length)} to the bin`);
  return text;
}

/** Paste the internal clipboard. `at` optionally centres the group. */
export function pasteItems(at: { x: number, y: number } | null = null) {
  const copies = pasteCopies(at);
  if (!copies.length) return [];
  const added = addItems(copies, copies.length > 1 ? `Paste ${copies.length} items` : 'Paste');
  // Said even though the copies are visible: a paste fanned out from an
  // original off the edge of the screen can put every copy somewhere you are
  // not looking, and then a working paste and a dead key look the same.
  toast(`Pasted ${itemCount(added.length)}`);
  return added;
}


/**
 * A note's name is its first line, capped - the copy Search reads
 * (ui/search.ts). Taken at creation (import/drop.ts) and re-taken on every
 * edit, or Find keeps showing the title the note had when it was made.
 */
const noteName = (text: string) => text.split('\n')[0].slice(0, 40) || 'Note';

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
    bus.emit('items', { added: [into.id], removed: [out.id] });
    bus.emit('selection');
  };
  commit(label, () => swap(old, item), () => swap(item, old));
  return item;
}

/**
 * Rename an item. Empty name falls back to meta.origName, then the asset
 * registry, then the current name — so clearing restores the original filename.
 */
export function renameItem(id: string, name: unknown) {
  const it = byId(id);
  if (!it) return;
  const orig = typeof it.meta?.origName === 'string' ? it.meta.origName : '';
  const next = String(name ?? '').trim() ||
               orig ||
               (it.asset?.hash ? assetName(it.asset.hash) : '') || it.name;
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
 *  parsed href. The card re-renders off the new URL: watermark, mark and chip. */
export function setLinkURL(id: string, url: unknown) {
  patchMeta(id, 'url', url, 'Edit link',
    value => (typeof value === 'string' && value ? value : null));
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
export type AssetSwap = { id: string, asset?: string | null, cover?: string | null };

export function swapAssets(swaps: AssetSwap[] | null | undefined, label = 'Optimize board') {
  const list = (swaps || []).filter(s => s && byId(s.id));
  if (!list.length) return 0;

  const before = list.map(({ id }) => {
    const it = byId(id)!;
    return { id, asset: it.asset ? { ...it.asset } : null, meta: { ...it.meta } };
  });

  // No actual swaps → mark items as seen outside the undo stack.
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
      // null = remove reference. Original pinned by `was` for undo.
      if (asset === null && it.asset?.hash) {
        if (!isHash(meta.was)) meta.was = it.asset.hash;
        it.asset = null;
      } else if (isHash(asset) && it.asset?.hash && asset !== it.asset.hash) {
        // Only the first swap records the original.
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

/** Per-item fit override (cover/contain). Undoable. */
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

/** Sticker colour override. Clamped to the palette that exists. */
export function setStickerTint(id: string, tint: unknown) {
  const it = byId(id);
  if (!it || it.type !== 'sticker') return;
  patchMeta(id, 'tint', tint, 'Sticker colour',
    value => stickerTint(value, it.meta?.shape));
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
  // a sound at all, which cuelume/engine.ts asks about before every cue. The
  // restored session is exactly that page.
  cue('arrive');
}

