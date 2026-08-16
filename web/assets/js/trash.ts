// The bin: deleting, restoring, and emptying it.
//
// One concern that sat in two non-contiguous blocks of state.js, which is
// usually the sign that it was never really one of that file's. The bin is not
// a place items go on their way out - it *is* where a deleted item lives, it
// travels in the saved file (see board-schema.js), and its bound is part of the
// board's shape (TRASH_LIMIT, in board-model.js beside MAX_ITEMS). Delete and
// restore are two directions of one door, and they were four hundred lines
// apart.
//
// **Three kinds of item leave by three different routes, and that is the whole
// of the complexity here.**
//
//   - Ordinary items are binned, oldest-first, up to the limit.
//   - The Desktop title card is not binned: it is a singleton the board is
//     meant to have, so it is hidden and offered back by its own restore button
//     (ui/trash.js) rather than filed among thrown-away things.
//   - Ghost cards are not binned either, for a different reason: they are hints
//     rather than anything of the user's, so a thrown-away one is finished
//     rather than filed. Deleting one by hand is a dismissal like any other -
//     see dismissGhosts() in onboarding.js - and it does not come back.
//
// **Eviction is part of what a delete did.** Truncating the bin used to be a
// one-liner on the grounds that entries falling out the bottom are older than
// the delete and so belong to no undo entry being replayed - which is true and
// beside the point. They were in the bin before the command ran and gone after
// it. See the note inside removeItems(), which is the bug that argument caused.
//
// **Emptying it is the one door out of the app**, and the only place anything
// here destroys rather than files. Everything above this line is reversible by
// three different routes; emptyTrash() deletes the bytes, rewrites the ledger's
// copies of the items that named them, and leaves a tombstone card in the place
// of each - the name, the kind of file, the size. The argument is at length
// over that function, because it is the one thing in this module that cannot be
// taken back.
//
// What is deliberately *not* here: any bookkeeping about connections. A pair
// naming a deleted item is simply not drawn, and the item coming back brings
// its lines with it because they never left - see the head of connections.js.
// Undoing a delete must give back exactly the board that was there, and the
// cheapest way to promise that is to have taken nothing else away.
//
// Nothing here imports state.js - see tests/layers.test.js, where this is BASE.

import { bus, selection } from './board-store.ts';
import { commit } from './history.ts';
import { cue } from './cuelume/engine.ts';
import { board, byId, topZ, makeItem, TRASH_LIMIT } from './board-model.ts';
import type { Item, TrashEntry } from './board-model.ts';
import { stuckTo } from './sticky.ts';
import { refenceArrivals } from './fences.ts';
import { fitBoardMode } from './layout.ts';
import { itemHashes, isRecord, extOf } from './util.ts';
// The ledger's own copies of every item, which emptying the bin has to reach -
// see entombRecorded() at the foot of this file. history.ts already imports it;
// the arrow from here points the same way and there is nothing pointing back.
import { rewriteRecorded } from './timeline.ts';

/**
 * The stickers that go with a delete: everything of type `sticker` stuck, at
 * any depth, to something being removed.
 *
 * **Two rules rather than one, and they are two because the things are two.** A
 * star on a photograph is a remark *about* that photograph and means nothing
 * once it is gone; a note is something you wrote, and losing it to a delete you
 * aimed at a picture would be the app throwing away your words. So notes keep
 * today's behaviour exactly - left on the board, re-measured against whatever
 * is underneath - and only stickers follow.
 *
 * The walk collects stickers alone, which is also what cuts it short at the
 * first surviving host: a sticker on a *note* on a deleted photograph stays,
 * because the note it is stuck to stays and the note never joins the going set
 * for the sticker to follow it through. The naive version - stuckFollowers()
 * and then a filter - takes that sticker too, because the note is a follower
 * even though it is not being deleted.
 */
function stickerCascade(ids: Iterable<string>) {
  const going = new Set(ids);
  const out: string[] = [];
  // Passes, like stuckFollowers(): a sticker on a sticker can only join once
  // the one underneath it has, and board.items is in no particular order.
  for (let grew = true; grew;) {
    grew = false;
    for (const it of board.items) {
      if (it.type !== 'sticker' || going.has(it.id)) continue;
      const host = stuckTo(it);
      if (!host || !going.has(host.id)) continue;
      going.add(it.id);
      out.push(it.id);
      grew = true;
    }
  }
  return out;
}

export function removeItems(ids: Iterable<string>, label = 'Delete') {
  // One undo entry for the cascade and the delete that caused it, which is the
  // whole reason it is folded in here rather than run by the caller: Ctrl+Z
  // brings the photograph and its stickers back together, and nobody has to
  // press it twice.
  const set = new Set([...ids, ...stickerCascade(ids)]);
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
  let evicted: TrashEntry[] = [];
  commit(label,
    () => { board.items = board.items.filter(i => !set.has(i.id));
            set.forEach(id => selection.delete(id));
            if (titleGone) board.titleHidden = true;
            board.trash.unshift(...binned);
            evicted = board.trash.splice(TRASH_LIMIT);   // [] while under the limit
            bus.emit('items', { added: [], removed: [...set] });
            bus.emit('selection'); bus.emit('trash'); },
    () => { for (const r of removed) board.items.splice(r.index, 0, r.item);
            // A fence coming back has to be noticed by what it comes back
            // around; see refenceArrivals(). The redo half is the delete, and a
            // fence leaving heals itself.
            refenceArrivals(removed.map(r => r.item));
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
  // commit() has now run the do half once, so `evicted` holds what this delete
  // pushed off the bottom of a full bin. Say so - those entries are past the point
  // of getting back. Fired here, not inside the closure, so undo/redo replays (which
  // re-run the closure) do not re-announce it. A UI module toasts (ui/trash.js);
  // state does not reach for the DOM itself.
  if (evicted.length) bus.emit('trash:evicted', evicted.length);
  // Out here rather than inside the closure, for the reason the line above is:
  // undo and redo re-run the closure, and they have their own cues (history.js).
  // A delete that also sounded from in there would say two things at once.
  cue('fall');
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
export function restoreItems(ids: Iterable<string>, at: { x: number, y: number } | null = null, label = 'Restore') {
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
            // The third door a fence can come back through, and it needs the
            // same notice as the other two. See refenceArrivals(). Note that a
            // fence dragged out of the bin lands where the drag put it, not
            // where it was deleted from, so what it now holds is a fresh
            // question in the strongest sense.
            refenceArrivals(items);
            board.trash = board.trash.filter(t => !set.has(t.item.id));
            bus.emit('items', { added: fresh.map(i => i.id), removed: [] });
            bus.emit('trash'); },
    () => { board.items = board.items.filter(i => !back.has(i.id));
            back.forEach(id => selection.delete(id));
            board.trash.unshift(...entries);
            bus.emit('items', { added: [], removed: [...back] });
            bus.emit('selection'); bus.emit('trash'); });
  // The other direction of the same door, and the same recipe with its glide
  // the other way up. See removeItems() above for why it is out here.
  cue('rise');
  return items;
}

// ---------------------------------------------------------------------------
// Emptying it, which is the one thing in this app that destroys something
// ---------------------------------------------------------------------------
//
// Everything else that removes a card leaves the bytes exactly where they were.
// Undo can put the card back, the bin can put it back, and the step ledger can
// put it back after a refresh - so an asset stays in the registry until the
// board closes, and the three readers of the reference union (the packer, the
// autosave sweep, ui/inventory.ts) each know to keep whatever any of those
// three still names.
//
// Emptying the bin is the one action that means *finished with*. Until this it
// did not act like one: it cleared board.trash and left every photograph in the
// registry, still written into every .mbrd, still swept as live - because the
// step that deleted the card names it on its before side, and that is what
// stepping back is for. So a board somebody had cleaned out went on weighing
// what it weighed before they cleaned it, and the only way to actually get rid
// of a file was to never let it onto the board.
//
// **What is left behind is a card, not a hole.** The alternative - drop the
// bytes and leave the item naming them - is worse than doing nothing: the step
// still replays, the card still mounts, and what it mounts is a dead blob URL.
// A hole in a history is indistinguishable from a bug. So the item is replaced
// everywhere it is written down by a tombstone that says what was there - its
// name, the kind of file it was, and how big it used to be - which is a thing
// the board can draw and a person can read. See RENDERERS.gone.

/**
 * Throw specific bytes away, from whoever holds the registry.
 *
 * Injected, never imported: storage/assets.ts sits above the base layer and
 * this module is in it (tests/layers.test.js, whose DEBT map is empty and may
 * only shrink). The same one-way seam as setOverlays(), setAssetNameLookup()
 * and setNoteMenu(); main.ts introduces the two.
 *
 * The answer is `hash -> bytes freed`, because the size printed on a tombstone
 * exists in exactly one place - the registry entry being deleted - and asking
 * for it afterwards is asking a question about something that no longer exists.
 *
 * **Unwired it frees nothing and says so**, by answering an empty map, and that
 * is the honest default rather than a convenient one: nothing is tombstoned,
 * the bin empties the way it always did, and a test with no registry in scope
 * gets the old behaviour instead of a board full of cards claiming their
 * pictures were destroyed.
 */
type AssetPurge = (hashes: Set<string>) => Map<string, number>;

let purgeAssets: AssetPurge = () => new Map();
export function setAssetPurge(fn: AssetPurge | null | undefined) {
  purgeAssets = typeof fn === 'function' ? fn : () => new Map();
}

/**
 * Every content id one item is a claim on: its own bytes, the pictures made
 * from them, and the optimiser's memo of what it replaced.
 *
 * `itemHashes()` is the first two and is shared with the packer and the sweep,
 * which is where it belongs - a list of "what this item points at" written down
 * twice is how a second id comes to be missed. `was` and `wasCover` are not on
 * it on purpose: they drive the *export*, and an export carries the small copies
 * alone. Here they count twice over, being both bytes this item is the only
 * claim on and the largest thing the bin is holding - the untouched original.
 *
 * Takes `unknown`, because half of what this file asks about is an item as a
 * step wrote it down: JSON, never an Item, and every field of it `unknown`.
 * Everything not a non-empty string is dropped, which is what makes the answer
 * safe to hand to a registry that keys on digests.
 */
function allHashes(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  // SAFETY: itemHashes() is structurally typed and reads two optional fields,
  // neither of which it trusts - it filters for truthiness and the caller here
  // filters for a string. The assertion is only what lets an untyped record be
  // passed at all; nothing is written through it.
  const item = raw as { asset?: { hash?: string } | null, meta?: Record<string, unknown> | null };
  const meta = isRecord(raw.meta) ? raw.meta : null;
  return [...itemHashes(item), meta?.was, meta?.wasCover]
    .filter((h): h is string => typeof h === 'string' && !!h);
}

/**
 * What is left of an item once its bytes are gone: eleven fields down to the
 * seven that are still true.
 *
 * The geometry stays, whole, because a tombstone is drawn where the picture was
 * - scrub back through a delete and the card is the size and shape of the thing
 * that used to be there, in its place, rather than a default rectangle wandering
 * in from the side. The name stays because it is the name, and it is what the
 * strip prints when it describes the step (see describeStep in timeline.ts).
 *
 * **Everything else goes, including all of `meta`.** That is the point rather
 * than tidiness: `meta` is where the crop, the cover, the thumbnail, the
 * preview and the optimiser's memo live, and every one of them is a second name
 * for bytes that have just been deleted. What replaces it is one key holding
 * the three facts a person would want - what kind of thing this was, what
 * extension it had, and what it weighed - and nothing that could ever resolve
 * to a file again.
 *
 * Takes a loose record rather than an Item so that the ledger's copies, which
 * are JSON and were never Items, go through the same function. There is no
 * second spelling of what a tombstone is.
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
        // What it was. Carried as the string the item had rather than checked
        // against a list, for the reason makeItem() carries an unknown type: a
        // board written by a newer build can hold a kind this one never heard
        // of, and "a card that was something" is more honest than "generic".
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
 * Throw the bin out, and the files in it with it.
 *
 * Still undoable, and it gives back exactly what still exists: the entries come
 * back, in their order, as the tombstones the purge made of them. Anything that
 * was never a file - a note, a swatch, a sticker, a link - comes back *whole*,
 * because nothing of it was destroyed and marking it deleted would be the app
 * throwing away somebody's words to make a rule look uniform.
 *
 * The order of the four steps below is the whole of the correctness here.
 */
export function emptyTrash() {
  if (!board.trash.length) return;
  // 1. What the board still claims. A photograph dropped twice is one asset and
  //    two cards (dedupe by content), so a picture in the bin whose bytes a live
  //    card is also standing on must not be touched - and neither must the
  //    optimiser's memo of an original a live card can still be reverted to.
  const kept = new Set<string>();
  for (const it of board.items) for (const hash of allHashes(it)) kept.add(hash);
  // Nothing else needs adding here. The other two claims on an asset are the
  // bin, which is what is being emptied, and the ledger, which is rewritten
  // below rather than consulted - a step naming a photograph is a reason to
  // change the step, not a reason to keep the photograph. Board fonts are not
  // reachable: every hash below comes off an item that was in the bin.
  const doomed = new Set<string>();
  for (const entry of board.trash) {
    for (const hash of allHashes(entry.item)) if (!kept.has(hash)) doomed.add(hash);
  }

  // 2. The bytes. Done before anything is written down, because the sizes only
  //    exist while the registry still holds them.
  const freed = purgeAssets(doomed);
  let bytes = 0;
  for (const size of freed.values()) bytes += size;
  // What one card weighed, and whether anything of it was actually destroyed.
  //
  // Asked of `freed` rather than of `doomed`, and the difference is the whole
  // of what a tombstone means: **one is put down where bytes went, never where
  // bytes were merely named.** A hash the registry did not have frees nothing -
  // a board opened from a snapshot whose assets did not survive, or, more to
  // the point, an unwired seam in a test - and marking those items deleted
  // would be the app claiming to have destroyed something it never held. It
  // would also rewrite the ledger, irreversibly, for no gain at all.
  const weigh = (item: unknown) =>
    allHashes(item).reduce((sum, hash) => sum + (freed.get(hash) || 0), 0);
  const purged = (item: unknown) => allHashes(item).some(hash => freed.has(hash));

  // 3. The bin itself, **before the commit and outside it**, which is the one
  //    line here that breaks the ordinary rule about writing to the board only
  //    through commit() - and has to. commit() photographs the board on either
  //    side of the change it is given, so the before-side of this step is
  //    whatever board.trash holds when it is called. Assign the tombstones
  //    inside the closure and that photograph is of the originals: the step
  //    would name every hash just deleted, the sweep would keep bytes that are
  //    gone, and undo would hand back cards pointing at nothing. Assigning here
  //    means the step records tombstones going to nothing, which is the truth.
  //    Nothing is announced in between - the commit on the next line does that.
  let entombed = 0;
  const stones = board.trash.map(entry => {
    if (!purged(entry.item)) return entry;
    entombed += 1;
    return { at: entry.at, item: tombstone(entry.item, weigh(entry.item)) };
  });
  board.trash = stones;

  // 4. And every copy the ledger holds, for the same reason and with the same
  //    replacement. This is the half that makes the deletion real: without it
  //    the steps still name the bytes, the autosave sweep still keeps them, and
  //    the .mbrd still carries them - the board would have been emptied in the
  //    interface and nowhere else.
  rewriteRecorded(item => (purged(item) ? tombstoneRecord(item, weigh(item)) : null));

  commit('Empty trash',
    () => { board.trash = []; bus.emit('trash'); },
    () => { board.trash = stones; bus.emit('trash'); });
  // Out here rather than in the closure, the same rule removeItems() states for
  // 'trash:evicted': undo and redo re-run the closure, and this is a thing that
  // happened once. A UI module toasts it (ui/trash.ts); state does not reach for
  // the DOM itself.
  if (entombed) bus.emit('trash:purged', { items: entombed, bytes });
}
