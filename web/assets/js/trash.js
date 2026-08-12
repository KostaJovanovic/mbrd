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
// What is deliberately *not* here: any bookkeeping about connections. A pair
// naming a deleted item is simply not drawn, and the item coming back brings
// its lines with it because they never left - see the head of connections.js.
// Undoing a delete must give back exactly the board that was there, and the
// cheapest way to promise that is to have taken nothing else away.
//
// Nothing here imports state.js - see tests/layers.test.js, where this is BASE.

import { bus, selection } from './board-store.js';
import { commit } from './history.js';
import { board, byId, topZ, TRASH_LIMIT } from './board-model.js';
import { stuckTo } from './sticky.js';
import { refenceArrivals } from './fences.js';
import { fitBoardMode } from './layout.js';

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
function stickerCascade(ids) {
  const going = new Set(ids);
  const out = [];
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

export function removeItems(ids, label = 'Delete') {
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
