// The bin: delete, restore, and empty. Three exit routes: ordinary items are
// binned (oldest-first, up to TRASH_LIMIT), the title card is hidden (not
// binned), and ghosts are dismissed (not binned). emptyTrash() is the only
// action that destroys bytes — it tombstones items and rewrites the ledger.
// Connections are not touched — a pair naming a deleted item just stops drawing.
// Keepsakes (isKeepsake(): the cleaning card) are exempt from the cap and from
// emptying, which is the whole of the drawer's Special view being permanent.
// BASE layer — does not import state.ts.

import { bus, selection } from './board-store.ts';
import { commit, dropStacks } from './history.ts';
import { cue } from './cuelume/engine.ts';
import { board, byId, topZ, makeItem, TRASH_LIMIT } from './board-model.ts';
import type { Item, TrashEntry } from './board-model.ts';
import { stuckTo, isSticky, stuckPlacement } from './sticky.ts';
import { refenceArrivals } from './fences.ts';
import { fitBoardMode } from './layout.ts';
import { heldHashes, isRecord, extOf } from './util.ts';
// emptyTrash() rewrites the ledger's copies via this.
import { rewriteRecorded } from './timeline.ts';
import { clippedItems } from './clipboard.ts';
import { otherLevels } from './board-tree.ts';

/**
 * **The two things the drawer keeps for good.** A cleaning card (type `card`,
 * the one the simulator leaves behind - canvas/spotless.ts) records a board
 * somebody cleaned once and cannot be made again; the title card is not binned
 * at all, only hidden. Both are shown in the drawer's Special view.
 *
 * Kept means two exemptions, both here: a keepsake never counts against
 * TRASH_LIMIT and is never evicted by it, and emptyTrash() leaves it where it
 * is. Everything else about it is an ordinary bin entry - it is restored by the
 * same drag, and undo sees the same steps.
 */
export const isKeepsake = (item: Item) => item.type === 'card';

/**
 * Drop the oldest ordinary entries past the cap and answer them, for undo.
 *
 * Replaces `board.trash.splice(TRASH_LIMIT)`: keepsakes are skipped in the
 * count as well as in the eviction, so a drawer holding ten cleaning cards
 * still holds a full TRASH_LIMIT of ordinary things beside them. Order is
 * otherwise untouched - a keepsake stays where it was thrown away.
 */
function evictOverLimit(): TrashEntry[] {
  const out: TrashEntry[] = [];
  let ordinary = 0;
  board.trash = board.trash.filter(entry => {
    if (isKeepsake(entry.item)) return true;
    if (++ordinary <= TRASH_LIMIT) return true;
    out.push(entry);
    return false;
  });
  return out;
}

/**
 * After a delete: what to say about the cap. An eviction is said as one; a
 * delete that took nothing out but left the bin exactly full is the warning
 * before the first one, since the next delete is where somebody loses a card.
 * Outside the commit closures, so undo and redo never re-announce.
 */
function announceLimit(evicted: TrashEntry[]) {
  if (evicted.length) bus.emit('trash:evicted', evicted.length);
  else if (board.trash.filter(t => !isKeepsake(t.item)).length === TRASH_LIMIT) bus.emit('trash:full');
}

/**
 * Collect transitive riders for a delete. Returns added ids and a host map
 * (noteId -> hostId). The host map is stamped as meta.stuckOf on binned copies
 * so restoreItems() can rebuild the pile — geometry is unmeasurable in the bin.
 */
function riderCascade(ids: Iterable<string>) {
  const going = new Set(ids);
  // Multi-pass: a note on a note joins only after its host. Dependency order
  // so restoreItems() can place the pile in one sweep.
  const out: string[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const it of board.items) {
      if (!isSticky(it) || going.has(it.id)) continue;
      const on = stuckTo(it);
      if (!on || !going.has(on.id)) continue;
      going.add(it.id);
      out.push(it.id);
      grew = true;
    }
  }
  // Build host map over the finished set.
  const host = new Map<string, string>();
  for (const it of board.items) {
    if (!going.has(it.id) || !isSticky(it)) continue;
    const on = stuckTo(it);
    if (on && going.has(on.id)) host.set(it.id, on.id);
  }
  return { ids: out, host };
}

/**
 * Meta keys that belong to the clip, not the card. These travel with the clip
 * on freeze/restore; everything else (tags, crop, anchor) stays on the card.
 */
const CLIP_META = [
  'mime', 'ext', 'size', 'duration', 'cover', 'thumb', 'preview', 'gif',
  'sized', 'origName', 'mtime', 'opt', 'was', 'wasCover',
];

/** `meta` less the clip's own keys - what a card keeps across the swap. */
function withoutClipMeta(meta: Item['meta']): Item['meta'] {
  const out = { ...meta };
  for (const key of CLIP_META) delete out[key];
  return out;
}

/** Only the clip's own keys, which is the half that travels with it. */
function clipMetaOf(meta: Item['meta']): Item['meta'] {
  const out: Item['meta'] = {};
  for (const key of CLIP_META) if (key in meta) out[key] = meta[key];
  return out;
}

/**
 * Splice `into` where `out` sits, preserving z-order position. Selection
 * follows. False if `out` is not on the board (stale replay).
 */
function swapItem(out: Item, into: Item): boolean {
  const at = board.items.indexOf(out);
  if (at < 0) return false;
  board.items.splice(at, 1, into);
  if (selection.delete(out.id)) selection.add(into.id);
  return true;
}

/** The live card a frozen clip came off, or null if not a clip / card deleted. */
function clipHome(item: Item): Item | null {
  const of = item.meta?.clipOf;
  return typeof of === 'string' ? byId(of) ?? null : null;
}

/** clipHome() for the panel — returns the id, not the item. */
export function clipHomeId(item: Item): string | null {
  return clipHome(item)?.id ?? null;
}

/**
 * The host this rider was stuck to when binned (meta.stuckOf). Stamped at
 * delete time because stickiness is unmeasurable in the bin. Null if not a
 * rider or host already restored/emptied.
 */
function stuckOfId(item: Item): string | null {
  const of = item.meta?.stuckOf;
  return typeof of === 'string' ? of : null;
}

/** stuckOfId() for the drawer — only returns a host still in the bin. */
export function stuckHostId(item: Item): string | null {
  const of = stuckOfId(item);
  return of && board.trash.some(t => t.item.id === of) ? of : null;
}

/**
 * Bin-side riderCascade: transitive riders via meta.stuckOf stamps. Returns
 * entries in dependency order so restoreItems() can place each against its host.
 */
function ridersInBin(chosen: TrashEntry[]) {
  const going = new Set(chosen.map(e => e.item.id));
  const out: TrashEntry[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const t of board.trash) {
      if (going.has(t.item.id)) continue;
      const on = stuckOfId(t.item);
      if (!on || !going.has(on)) continue;
      going.add(t.item.id);
      out.push(t);
      grew = true;
    }
  }
  return out;
}

/**
 * Bin the video, keep the still frame. The card is replaced (new id retires the
 * canvas node); the clip keeps the original id in the bin. `hash`/`facts` are
 * the caller's because this layer cannot read the asset registry.
 */
export function freezeClip(
  id: string, hash: string, facts: Record<string, unknown> = {},
): Item | null {
  const clip = byId(id);
  if (!clip || clip.type !== 'video') return null;
  // Card geometry and name carry over; clip-specific meta is stripped.
  const picture = makeItem({
    ...clip,
    id: null,
    type: 'image',
    asset: { hash, embedded: true },
    meta: { ...withoutClipMeta(clip.meta), ...facts },
  });
  const entry: TrashEntry = {
    item: makeItem({ ...clip, meta: { ...clip.meta, clipOf: picture.id } }),
    at: Date.now(),
  };
  // Track evicted entries so undo can restore them.
  let evicted: TrashEntry[] = [];
  commit('Keep this frame',
    () => { if (!swapItem(clip, picture)) return;
            board.trash.unshift(entry);
            evicted = evictOverLimit();
            bus.emit('items', { added: [picture.id], removed: [clip.id] });
            bus.emit('selection'); bus.emit('trash'); },
    () => { if (!swapItem(picture, clip)) return;
            board.trash = board.trash.filter(t => t.item.id !== clip.id);
            board.trash.push(...evicted);
            bus.emit('items', { added: [clip.id], removed: [picture.id] });
            bus.emit('selection'); bus.emit('trash'); });
  // Outside the closure: undo/redo re-run closures with their own cues.
  announceLimit(evicted);
  cue('fall');
  return picture;
}

export function removeItems(ids: Iterable<string>, label = 'Delete') {
  // Cascade folded in so delete + riders share one undo entry.
  const cascade = riderCascade(ids);
  const set = new Set([...ids, ...cascade.ids]);
  // Keep original index so undo restores z-order position.
  const removed: { item: Item, index: number }[] = [];
  board.items.forEach((item, index) => {
    if (set.has(item.id)) removed.push({ item, index });
  });
  if (!removed.length) return;
  // Title card is hidden, not binned — it has its own restore button.
  const titleGone = removed.some(r => r.item.type === 'title');
  const wasHidden = board.titleHidden;
  // Ghosts are dismissed, not binned. Rider copies get meta.stuckOf stamped
  // for restore; originals in `removed` are what undo splices back.
  const binned = removed
    .filter(r => r.item.type !== 'title' && r.item.type !== 'ghost')
    .map(r => {
      const on = cascade.host.get(r.item.id);
      const item = on
        ? makeItem({ ...r.item, meta: { ...r.item.meta, stuckOf: on } })
        : r.item;
      return { item, at: Date.now() };
    });
  const binIds = new Set(binned.map(b => b.item.id));
  // Evicted entries are part of what the delete did — undo restores them.
  let evicted: TrashEntry[] = [];
  commit(label,
    () => { board.items = board.items.filter(i => !set.has(i.id));
            set.forEach(id => selection.delete(id));
            if (titleGone) board.titleHidden = true;
            board.trash.unshift(...binned);
            evicted = evictOverLimit();   // [] while under the limit
            bus.emit('items', { added: [], removed: [...set] });
            bus.emit('selection'); bus.emit('trash'); },
    () => { for (const r of removed) board.items.splice(r.index, 0, r.item);
            // A fence coming back must be noticed by items it now contains.
            refenceArrivals(removed.map(r => r.item));
            board.titleHidden = wasHidden;
            board.trash = board.trash.filter(t => !binIds.has(t.item.id));
            // Evicted entries go back on the end where they were.
            board.trash.push(...evicted);
            evicted = [];
            bus.emit('items', { added: removed.map(r => r.item.id), removed: [] });
            bus.emit('trash'); },
    // Weight: removed count. Evicted not included (not yet filled).
    removed.length);
  // Outside the closure: undo/redo re-run closures and must not re-announce.
  announceLimit(evicted);
  cue('fall');
}

/**
 * Restore items from the bin. `at` is the drop point (null = original position),
 * or a point for each id, worked out by a caller that placed them clear of the
 * board. Frozen clips go back onto their card via clipHome(). Riders are
 * restored with their hosts via stuckPlacement(). All stacked on top (old z is stale).
 */
export function restoreItems(
  ids: Iterable<string>,
  at: { x: number, y: number } | ReadonlyMap<string, { x: number, y: number }> | null = null,
  label = 'Restore',
) {
  const picked = new Set(ids);
  const chosen = board.trash.filter(t => picked.has(t.item.id));
  if (!chosen.length) return [];
  // Hosts first, riders after — placement loop depends on this order.
  const entries = [...chosen, ...ridersInBin(chosen)];
  const set = new Set(entries.map(e => e.item.id));
  // Split: clips go home onto their card, everything else lands on the board.
  const homing = entries
    .map(e => ({ entry: e, home: clipHome(e.item) }))
    .filter((r): r is { entry: TrashEntry, home: Item } => !!r.home);
  const arriving = entries.filter(e => !clipHome(e.item));
  // Reverse of freezeClip: clip gets card's current geometry/name, card's non-clip meta.
  const rehomes = homing.map(({ entry, home }) => {
    const meta = { ...entry.item.meta };
    delete meta.clipOf;
    return {
      home,
      item: makeItem({
        ...entry.item,
        x: home.x, y: home.y, w: home.w, h: home.h, rot: home.rot, z: home.z,
        name: home.name,
        meta: { ...withoutClipMeta(home.meta), ...clipMetaOf(meta) },
      }),
    };
  });
  let z = topZ();
  // Old and new boxes for riders to be placed via stuckPlacement().
  const was = new Map<string, Item>();
  const now = new Map<string, Item>();
  const items: Item[] = [];
  for (const e of arriving) {
    const on = stuckOfId(e.item);
    const hostWas = on ? was.get(on) : null;
    const hostNow = on ? now.get(on) : null;
    // Place on its host if co-restoring, else at drop point, else original spot.
    const drop = at instanceof Map ? at.get(e.item.id) ?? null : at;
    const where = hostWas && hostNow ? stuckPlacement(e.item, hostWas, hostNow) : drop;
    // Drop the drawer-only stuckOf link — live geometry takes over on the board.
    const meta = { ...e.item.meta };
    delete meta.stuckOf;
    // SAFETY: the spread below makes a copy of an Item, and fitBoardMode() returns that copy
    // or a spread of it with new numbers.
    const item = fitBoardMode({
      ...e.item,
      ...(where ? { x: where.x, y: where.y } : null),
      z: ++z,
      meta,
    }) as Item;
    was.set(e.item.id, e.item);
    now.set(item.id, item);
    items.push(item);
  }
  const back = new Set(items.map(i => i.id));
  const all = [...items, ...rehomes.map(r => r.item)];
  commit(label,
    () => { const fresh = items.filter(i => !byId(i.id));
            board.items.push(...fresh);
            const swapped = rehomes.filter(r => swapItem(r.home, r.item));
            // Fences arriving need refencing; rehomed clips keep their card's membership.
            refenceArrivals(items);
            board.trash = board.trash.filter(t => !set.has(t.item.id));
            bus.emit('items', {
              added: [...fresh.map(i => i.id), ...swapped.map(r => r.item.id)],
              removed: swapped.map(r => r.home.id),
            });
            bus.emit('selection'); bus.emit('trash'); },
    () => { board.items = board.items.filter(i => !back.has(i.id));
            back.forEach(id => selection.delete(id));
            const swapped = rehomes.filter(r => swapItem(r.item, r.home));
            board.trash.unshift(...entries);
            bus.emit('items', {
              added: swapped.map(r => r.home.id),
              removed: [...back, ...swapped.map(r => r.item.id)],
            });
            bus.emit('selection'); bus.emit('trash'); });
  // Cue outside the closure — undo/redo have their own cues.
  cue('rise');
  return all;
}

// ---------------------------------------------------------------------------
// Emptying — the only action that destroys bytes
// ---------------------------------------------------------------------------
//
// Purges assets and replaces items (including ledger copies) with tombstones
// so history never points at dead blob URLs. Items with no file content (notes,
// swatches, stickers) come back whole.

/**
 * Injected purge function (hash set -> hash->bytes-freed map). Unwired = no-op.
 * Returns sizes because the registry entry is the only place the size exists.
 */
type AssetPurge = (hashes: Set<string>) => Map<string, number>;

let purgeAssets: AssetPurge = () => new Map();
export function setAssetPurge(fn: AssetPurge | null | undefined) {
  purgeAssets = typeof fn === 'function' ? fn : () => new Map();
}

/**
 * All content hashes an item claims, the optimiser's originals included
 * (heldHashes()). Takes unknown because ledger entries are JSON, not Items.
 */
function allHashes(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  // SAFETY: lets untyped JSON reach heldHashes(). isRecord() above, and it
  // reads each field through ?. and keeps only non-empty strings.
  return heldHashes(raw as { asset?: { hash?: string } | null, meta?: Record<string, unknown> | null });
}

/**
 * Replace an item with a tombstone: geometry and name stay, everything else
 * (including all of meta) is replaced by {type, ext, bytes}. Takes a loose
 * record so ledger copies use the same function.
 */
function tombstoneRecord(item: Record<string, unknown>, bytes: number) {
  const meta = isRecord(item.meta) ? item.meta : {};
  const name = typeof item.name === 'string' ? item.name : '';
  const ext = typeof meta.ext === 'string' && meta.ext ? meta.ext : extOf(name);
  return {
    id: item.id,
    type: 'gone',
    x: item.x, y: item.y, w: item.w, h: item.h, rot: item.rot, z: item.z,
    name,
    asset: null,
    meta: {
      gone: {
        // Preserved as-is — a newer build's type is better than "generic".
        type: typeof item.type === 'string' && item.type ? item.type : 'generic',
        ext,
        bytes,
      },
    },
  };
}

/** The same, as something that can go straight back on the board. */
const tombstone = (item: Item, bytes: number): Item => makeItem(tombstoneRecord(item, bytes));

/**
 * Purge all bin entries. File-backed items become tombstones; notes/swatches/
 * stickers/links come back whole on undo. Step order below is load-bearing.
 */
export function emptyTrash() {
  // Keepsakes are not emptied and do not make the drawer worth emptying: a
  // drawer holding nothing but cleaning cards has nothing to throw out.
  const going = board.trash.filter(entry => !isKeepsake(entry.item));
  const keeping = board.trash.filter(entry => isKeepsake(entry.item));
  if (!going.length) return;
  // 1. Hashes still claimed by live items or by a keepsake — do not purge these.
  const kept = new Set<string>();
  for (const it of board.items) for (const hash of allHashes(it)) kept.add(hash);
  for (const entry of keeping) for (const hash of allHashes(entry.item)) kept.add(hash);
  // A cut card waits here to be pasted, and would paste with no bytes.
  for (const it of clippedItems()) for (const hash of allHashes(it)) kept.add(hash);
  // Every other board in the file: the store is one for the whole tree, so a
  // picture this bin let go of may still be on a card a level up or down.
  for (const doc of otherLevels()) {
    for (const it of Array.isArray(doc.items) ? doc.items : []) for (const hash of allHashes(it)) kept.add(hash);
    for (const t of Array.isArray(doc.trash) ? doc.trash : []) {
      for (const hash of allHashes(isRecord(t) ? t.item : null)) kept.add(hash);
    }
  }
  const doomed = new Set<string>();
  for (const entry of going) {
    for (const hash of allHashes(entry.item)) if (!kept.has(hash)) doomed.add(hash);
  }

  // 2. Purge bytes (must happen before anything is rewritten — sizes come from the registry).
  const freed = purgeAssets(doomed);
  let bytes = 0;
  for (const size of freed.values()) bytes += size;
  // Tombstone only where bytes were actually freed, not merely named.
  const weigh = (item: unknown) =>
    allHashes(item).reduce((sum, hash) => sum + (freed.get(hash) || 0), 0);
  const purged = (item: unknown) => allHashes(item).some(hash => freed.has(hash));

  // 3. Replace bin entries *before* commit() — commit snapshots board.trash, so
  //    the step must see tombstones, not originals.
  let entombed = 0;
  const stones = board.trash.map(entry => {
    if (isKeepsake(entry.item) || !purged(entry.item)) return entry;
    entombed += 1;
    return { at: entry.at, item: tombstone(entry.item, weigh(entry.item)) };
  });
  board.trash = stones;

  // 4. Rewrite ledger copies — without this, steps still claim the purged bytes.
  rewriteRecorded(item => (purged(item) ? tombstoneRecord(item, weigh(item)) : null));

  commit('Empty trash',
    // The keepsakes stay, in the order they were in. Undo puts the rest back
    // around them, which is what `stones` already is.
    () => { board.trash = board.trash.filter(entry => isKeepsake(entry.item)); bus.emit('trash'); },
    () => { board.trash = stones; bus.emit('trash'); });
  // The closures below this one hold the cards with their purged hashes: two
  // undos would put an empty card back. The ledger was rewritten to tombstones
  // above, and undo falls through to it once the stacks are gone.
  if (freed.size) dropStacks();
  // Outside the closure: undo/redo re-run closures, this fires once.
  if (entombed) bus.emit('trash:purged', { items: entombed, bytes });
}
