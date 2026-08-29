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
import { stuckTo, isSticky, stuckPlacement } from './sticky.ts';
import { refenceArrivals } from './fences.ts';
import { fitBoardMode } from './layout.ts';
import { itemHashes, isRecord, extOf } from './util.ts';
// The ledger's own copies of every item, which emptying the bin has to reach -
// see entombRecorded() at the foot of this file. history.ts already imports it;
// the arrow from here points the same way and there is nothing pointing back.
import { rewriteRecorded } from './timeline.ts';

/**
 * Everything that goes with a delete: every sticky - sticker or note - stuck, at
 * any depth, to something being removed, and what each is stuck to.
 *
 * ── Why notes travel too, having once not ──
 *
 * This took stickers alone, and the argument was that the two things are two: a
 * star on a photograph is a remark *about* that photograph and means nothing
 * once it is gone, whereas a note is something you wrote, and losing it to a
 * delete you aimed at a picture would be the app throwing away your words.
 *
 * The first half of that still holds and the second turned out to be an argument
 * about a different app. Nothing here loses a note - a delete files it in the
 * drawer, which is the whole reason the drawer exists - and it comes back out
 * with its host, on its host, because of the `stuckOf` link below. What the old
 * rule actually produced was a note left hovering over the gap where its card
 * used to be, re-measured against whatever happened to be underneath, and stuck
 * to *that* instead. The pile you built came apart at the one moment you were
 * least likely to be watching, and the words were not saved by it - they were
 * merely left somewhere else, wearing a new host.
 *
 * The rule is now the one the rest of the app already states: a stuck thing
 * travels with what it is stuck to. It is what a drag does (stuckFollowers), it
 * is what a layout does (attachRiders), and a delete was the one door that read
 * it differently.
 *
 * ── The map ──
 *
 * The host is returned alongside, because it is known *here* and nowhere later:
 * stuckness is measured off live geometry (sticky.ts), and a moment after this
 * the pile is in the drawer where there is no geometry to measure. removeItems()
 * stamps it onto the binned copy as `meta.stuckOf`, and restoreItems() reads it
 * back. Same shape as `clipOf` further down: a link between two drawer entries,
 * written at one door and read at the other, meaningless anywhere else.
 *
 * **The map is measured over everything that is going, not over what the walk
 * added**, and the two are different exactly when the delete already named the
 * whole pile - Select All, or a marquee round a photograph and its notes. The
 * walk finds nothing to add there, because there is nothing left to add; if the
 * stamp were a by-product of the walk, a board deleted in one press would arrive
 * in the drawer as loose cards while the same board deleted card by card arrived
 * as piles. Nothing about that fails - it is two shelves that disagree about what
 * a pile is, depending on how the delete was made.
 */
function riderCascade(ids: Iterable<string>) {
  const going = new Set(ids);
  // Passes, like stuckFollowers(): a note on a note can only join once the one
  // underneath it has, and board.items is in no particular order. `out` is
  // therefore in dependency order - a host is always pushed before its riders -
  // which is what restoreItems() relies on to place a pile back in one sweep.
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
  // One sweep over the finished set, once nothing more can join it. A sticky
  // whose host is also going is a rider whichever of the two got it here.
  const host = new Map<string, string>();
  for (const it of board.items) {
    if (!going.has(it.id) || !isSticky(it)) continue;
    const on = stuckTo(it);
    if (on && going.has(on.id)) host.set(it.id, on.id);
  }
  return { ids: out, host };
}

/**
 * The `meta` keys that belong to the *clip* rather than to the card it is on.
 *
 * Freezing a clip and bringing it back are one edit in two directions, and this
 * list is what moves in each: everything here comes off the card when the clip
 * goes to the bin and back onto it when the clip comes home. Everything not
 * here - the tags, the fit, the crop, the anchor, the sticky memo, the note a
 * fence keeps - stays on the card throughout, because it is a fact about the
 * card and the card never left.
 *
 * Written out rather than derived, and it is deliberately wider than
 * META_HASHES (board-model.ts). The hashes are the pictures a clip carries; the
 * rest are what it *is* - its type, its extension, its byte count, how long it
 * runs, and the optimiser's memo of which copy is which. A card wearing a still
 * has its own answers to all of those and must not be left claiming the clip's.
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
 * Put one item in the board's place of another, in the pile position the first
 * one held.
 *
 * retypeItem()'s swap (state.ts), which the two below need and cannot import -
 * state.ts is above this file, not below it. The splice rather than a
 * filter-and-push is what keeps the z-order *position*: the card is the same
 * card seen differently and has no business jumping to the top of the pile.
 *
 * The selection follows, in both directions, so whichever of the pair is on the
 * board is the one that is selected. False when the item is not there, which is
 * a replay against a board that has moved on and a reason to do nothing.
 */
function swapItem(out: Item, into: Item): boolean {
  const at = board.items.indexOf(out);
  if (at < 0) return false;
  board.items.splice(at, 1, into);
  if (selection.delete(out.id)) selection.add(into.id);
  return true;
}

/**
 * The card a binned clip came off, if it is still on the board.
 *
 * `meta.clipOf` is written by freezeClip() below and read by restoreItems(),
 * and those two are its only readers - it is a link between a bin entry and a
 * live card and means nothing to anything else. An id, so it survives a save
 * and reopen the way `stuckTo` does.
 *
 * Null covers two different situations that want the same answer: a bin entry
 * that is not a frozen clip at all, and one whose card has since been deleted.
 * Both mean "there is nowhere for this to go back to", and restoreItems() then
 * hands it back as an ordinary card, which is what it was before it was frozen.
 */
function clipHome(item: Item): Item | null {
  const of = item.meta?.clipOf;
  return typeof of === 'string' ? byId(of) ?? null : null;
}

/**
 * The same question, for the panel: does this bin entry have a card to go back
 * to?
 *
 * The panel needs it to say so - a row that goes home on a click cannot look
 * like the rows that only come back by being dragged somewhere - and it has no
 * business knowing that the link is spelled `meta.clipOf`. The id rather than
 * the item, because that is all a caller above this layer can use.
 */
export function clipHomeId(item: Item): string | null {
  return clipHome(item)?.id ?? null;
}

/**
 * The drawer entry this one was stuck to when the two went in together, if it is
 * still in the drawer.
 *
 * `meta.stuckOf` is the second link of the same kind as `clipOf` above, and it
 * exists for the same reason that one does: a relation between two things in the
 * drawer cannot be *measured* while they are in there. Stuckness is geometry
 * (sticky.ts is emphatic that it is never stored as a relation inside the board
 * file), and geometry is exactly what a drawer entry has stopped taking part in
 * - a note and the photograph under it are two entries with two old coordinates
 * and nothing underneath either of them.
 *
 * So it is written at the one moment it is known - the delete, where both are
 * still on the board and riderCascade() has just measured it - and read at the
 * one moment it is wanted, which is the restore. In between it is inert. It is
 * dropped on the way back out (see restoreItems), because on the board the
 * measurement is the truth again and a stale id would be a second opinion.
 *
 * A string that names nothing is the ordinary case rather than a fault: it means
 * the host has already been taken back out, or emptied, or was the title card,
 * which never goes in the drawer at all. All of them mean the same thing here -
 * this one comes back on its own, wherever it is put.
 */
function stuckOfId(item: Item): string | null {
  const of = item.meta?.stuckOf;
  return typeof of === 'string' ? of : null;
}

/**
 * The same question, for the drawer: which entry is this one sitting on?
 *
 * clipHomeId()'s counterpart, and it exists for the counterpart reason. The
 * drawer draws a pile as one card on the shelf rather than as three cards that
 * happen to be adjacent, which means it has to know which entries belong to
 * which - and it has no more business knowing that the link is spelled
 * `meta.stuckOf` than the panel had knowing about `meta.clipOf`.
 *
 * Null when the stamp names nothing that is still in the drawer, which is the
 * ordinary case rather than a fault - the host has been taken back out, or
 * emptied. It means what it means everywhere else in this file: this one is on
 * its own now, and the drawer gives it a shelf slot of its own.
 */
export function stuckHostId(item: Item): string | null {
  const of = stuckOfId(item);
  return of && board.trash.some(t => t.item.id === of) ? of : null;
}

/**
 * The drawer entries that have to come back with these: everything stuck, at any
 * depth, to something being restored.
 *
 * riderCascade()'s other half, and deliberately the same shape - passes over the
 * pool until nothing more joins, so a sticker on a note on a photograph comes
 * back with the photograph and comes back *after* the note it is stuck to. That
 * ordering is not incidental: restoreItems() places each rider against a host it
 * has already placed, and a pile handed back in the wrong order would put a
 * sticker where its note used to be.
 *
 * The one difference is what it measures with. The cascade asks live geometry
 * because the pile is still on the board; this asks the stamp that cascade left,
 * because it is not. Nothing else about a drawer entry could answer it.
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
 * Throw the clip away and keep the frame that was on it.
 *
 * The fourth route out, after the three the header names, and the one that is
 * not really a delete at all: the card stays exactly where it is, wearing the
 * still it was showing, and the *video* is what goes to the bin. A clip that
 * was worth keeping as a picture and is not worth thirty megabytes is the whole
 * case - a board of them opens instantly and weighs what a board of photographs
 * weighs - and it is a case nothing else here answers, since deleting the card
 * takes the picture with it.
 *
 * `hash` is the frozen frame, already in the asset registry, and `facts` are
 * that picture's own mime, ext and size. Both are the caller's because this
 * file sits under storage/ and may not look in the registry itself - the same
 * arrangement setItemPoster()'s `dangling` argument is built on. See keepFrame()
 * in commands/item-meta.ts, which is the only caller and is where the frame is
 * cut.
 *
 * **The card is replaced rather than edited**, which is retypeItem()'s
 * reasoning and not a choice made again here: canvas/items.ts writes the type
 * onto a node when it *builds* it and caches that node by id, so a card that
 * changed type under a node that stayed would go on wearing the old type's
 * clothes. Retiring the id retires the node. The clip keeps the original id and
 * takes it to the bin, which is the tidier half of the same swap - the thing
 * that left the board is the thing that keeps the identity it had while it was
 * on it, and the bin's one id space (dedupeIds, board-schema.ts) never sees two.
 *
 * One history entry for both halves, like removeItems() above and for the same
 * reason: this is one thing somebody did, and an undo that gave back the clip
 * but left the still on the board would be a board with the clip in two places.
 */
export function freezeClip(
  id: string, hash: string, facts: Record<string, unknown> = {},
): Item | null {
  const clip = byId(id);
  if (!clip || clip.type !== 'video') return null;
  // Everything the card is, minus everything the clip was. Geometry, name,
  // rotation and pile position all carry over untouched: it is the same card.
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
  // As in removeItems(): what this pushed out the bottom of the bin, so undo
  // can put it back. A clip is the largest thing anybody bins, so a board where
  // this is used often is exactly the board that reaches TRASH_LIMIT.
  let evicted: TrashEntry[] = [];
  commit('Keep this frame',
    () => { if (!swapItem(clip, picture)) return;
            board.trash.unshift(entry);
            evicted = board.trash.splice(TRASH_LIMIT);
            bus.emit('items', { added: [picture.id], removed: [clip.id] });
            bus.emit('selection'); bus.emit('trash'); },
    () => { if (!swapItem(picture, clip)) return;
            board.trash = board.trash.filter(t => t.item.id !== clip.id);
            board.trash.push(...evicted);
            bus.emit('items', { added: [clip.id], removed: [picture.id] });
            bus.emit('selection'); bus.emit('trash'); });
  // Outside the closure, for the reason removeItems() gives: undo and redo
  // re-run it and have cues of their own.
  if (evicted.length) bus.emit('trash:evicted', evicted.length);
  cue('fall');
  return picture;
}

export function removeItems(ids: Iterable<string>, label = 'Delete') {
  // One undo entry for the cascade and the delete that caused it, which is the
  // whole reason it is folded in here rather than run by the caller: Ctrl+Z
  // brings the photograph and its stickers back together, and nobody has to
  // press it twice.
  const cascade = riderCascade(ids);
  const set = new Set([...ids, ...cascade.ids]);
  // Keep the original index so undo restores z-order position, not just the item.
  // One pass that pushes only the matches, rather than a wrapper per board item
  // and a filter after: a delete of three cards off a 20,000-card board built
  // 20,000 throwaway objects to keep three.
  const removed: { item: Item, index: number }[] = [];
  board.items.forEach((item, index) => {
    if (set.has(item.id)) removed.push({ item, index });
  });
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
  // The drawer's copy, which for a rider is a *copy* rather than the item
  // itself: the pile relation is stamped onto it so restoreItems() can rebuild
  // the pile, and the board's own object has no business carrying a link that
  // only means anything inside the drawer. `removed` still holds the originals,
  // which is what undo splices back - so undoing a delete puts the board exactly
  // as it was, unstamped, and the measurement speaks again.
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
 *
 * ── The one entry that does not land anywhere ──
 *
 * A clip frozen by freezeClip() went to the bin off a card that is *still on the
 * board*, wearing the frame it was showing. It has a home, so `at` is not a
 * question anybody has to answer for it - and neither is the drag the panel's
 * header argues for, whose whole point is that a deleted item's old spot is
 * usually the reason it was deleted. That reasoning does not reach this case:
 * nothing was deleted, the gap was never left, and the still standing in the gap
 * is the thing being replaced. So a frozen clip goes back onto its card, at that
 * card's size and place, and `at` is ignored.
 *
 * If the card has since been deleted there is no home, clipHome() answers null,
 * and the entry comes back as an ordinary video card the way it always would
 * have. That is the honest fallback rather than a refusal: the clip is still a
 * clip, and the bin is still the only place it exists.
 *
 * ── The entries nobody asked for ──
 *
 * A card that went in with a pile of stickies on it comes back out with them.
 * `ids` is what was dragged, clicked or picked; ridersInBin() is everything
 * stuck to it that went in at the same time, and the two are restored as one
 * thing under one history entry - the same bargain removeItems() makes with the
 * same pile in the other direction, so that undoing either takes one press.
 *
 * They are not placed independently. `at` says where the *host* goes, and each
 * rider is put back on it at the fraction of it that it held - stuckPlacement(),
 * the same arithmetic a layout uses to carry a note onto its host's new box - so
 * a photograph dropped anywhere on the board arrives with its notes where they
 * were on it, at whatever size the board mode gives it.
 */
export function restoreItems(ids: Iterable<string>, at: { x: number, y: number } | null = null, label = 'Restore') {
  const picked = new Set(ids);
  const chosen = board.trash.filter(t => picked.has(t.item.id));
  if (!chosen.length) return [];
  // Hosts first, riders after - which is the order ridersInBin() hands back and
  // the order the placement loop below depends on, since a rider is placed
  // against a host that has already been placed.
  const entries = [...chosen, ...ridersInBin(chosen)];
  const set = new Set(entries.map(e => e.item.id));
  // Split before anything is built, because the two halves are built
  // differently: one is placed on the board and one takes a card's place.
  const homing = entries
    .map(e => ({ entry: e, home: clipHome(e.item) }))
    .filter((r): r is { entry: TrashEntry, home: Item } => !!r.home);
  const arriving = entries.filter(e => !clipHome(e.item));
  // The clip, wearing everything the card learned while it was away. Geometry
  // and name are the card's - it may have been moved, resized or renamed since -
  // and so is every `meta` key that is not the clip's own. The swap is
  // freezeClip()'s in reverse, down to retiring the still's id with its node.
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
  // The box each entry had in the drawer, and the box it has now - one pair per
  // id, so a rider can be measured against its host in both. Only hosts are ever
  // looked up, but every arrival is recorded because a rider may be one: a note
  // with a sticker on it is both at once.
  const was = new Map<string, Item>();
  const now = new Map<string, Item>();
  const items: Item[] = [];
  for (const e of arriving) {
    const on = stuckOfId(e.item);
    const hostWas = on ? was.get(on) : null;
    const hostNow = on ? now.get(on) : null;
    // Three answers, in order of how much is known. On its host, if the host is
    // coming back in this same restore. Otherwise wherever the drag let go. And
    // failing both - a keyboard restore, or a rider whose host is not coming -
    // exactly where it was deleted from, which is what this always did.
    const where = hostWas && hostNow ? stuckPlacement(e.item, hostWas, hostNow) : at;
    // The link is drawer-only and is dropped on the way out, for the reason
    // stuckOfId() gives: on the board the geometry is the truth again, and a
    // stale id sitting in `meta` would be a second opinion about the same
    // question that nothing re-measures.
    const meta = { ...e.item.meta };
    delete meta.stuckOf;
    // SAFETY: fitBoardMode() clamps numbers on the object it is given and hands
    // the same object back - it adds and removes nothing - so a copy of an Item
    // comes out an Item. The spread above is what makes it a copy. Same
    // assertion, and the same reason for it, as fitOnto() in layout.ts.
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
            // The third door a fence can come back through, and it needs the
            // same notice as the other two. See refenceArrivals(). Note that a
            // fence dragged out of the bin lands where the drag put it, not
            // where it was deleted from, so what it now holds is a fresh
            // question in the strongest sense. A rehomed clip is not asked: it
            // is standing exactly where the still it replaced stood, so its
            // membership is whatever that card's was.
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
  // The other direction of the same door, and the same recipe with its glide
  // the other way up. See removeItems() above for why it is out here.
  cue('rise');
  return all;
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
