// Folding one board into another: the id remap, the relations that travel with
// it, and where the arrivals land.
//
// This is the *plan* only. Nothing here touches the live board, nothing commits,
// nothing announces - it takes a normalised incoming board and the ids already
// spoken for, and hands back a set of items and relations that can be pushed
// onto the board as one undoable step. state.ts's mergeBoard() does the pushing.
//
// Pure, and in the base tier for a reason that is not tidiness: the id remap is
// the part of this feature that fails silently. A collision handled wrongly does
// not throw - it produces a board where a merged note is stuck to one of *your*
// photographs, or where a connection you drew now points at a card that arrived
// from somebody else's file. There is no visual difference between "it worked"
// and "it silently attached to the wrong thing", so the only way to know is to
// be able to hammer it in a test with colliding ids, self-referential relations
// and a tour naming a binned card. That needs a function with no board in it.
//
// ── What merging is not ──
//
// It is not Open. Open replaces, and so runs inside withFreshAssets(), which
// sets the current board's assets aside and swaps them atomically. A merge is
// *additive*: the incoming assets are registered alongside the ones already
// there, and because every asset is named by the SHA-256 of its own bytes, two
// boards that share a photograph share one entry for free. putAsset() answers
// with the existing entry for a hash it already holds, so the dedupe costs
// nothing and needs no bookkeeping here.
//
// ── The five places an id appears ──
//
// An item's `id` is the obvious one. The other four are references *to* an id,
// and every one of them has to be rewritten in step or it silently points at
// whatever card now happens to own the old string:
//
//   board.connections   pairs of ids, plus optional per-line meta
//   board.audioOrder    the Playlist's hand-arranged order
//   board.tour          the ordered stops
//   meta.stuckTo        which card a sticky note is pinned to
//   meta.fence          which region an item belongs to
//
// The last two are the ones that break quietly, and they are the reason this
// module has a test of its own. A merged note whose `stuckTo` still names an id
// that now belongs to a different card on the host board is not an error - it is
// a note that sticks to the wrong photograph, and moves with it, and nothing
// anywhere says so.
//
// What is deliberately *not* remapped: `meta.cover`, `meta.shot`, `meta.thumb`
// and `meta.preview`. Those are content hashes, not item ids - they name bytes
// in the asset store, which is exactly the thing two boards are allowed to
// share.

import { dedupeIds } from './board-model.ts';
import type { Board, Connection, Item } from './board-model.ts';
import { itemBounds } from './geometry.ts';
import { isRecord } from './util.ts';

/** The gap left between the host board and the block arriving beside it. */
const SEAM = 96;

/** What state.ts's mergeBoard() is handed: items to add, relations to append. */
export type MergePlan = {
  items: Item[],
  connections: Connection[],
  audioOrder: string[],
  tour: string[],
};

/**
 * Work out what folding `incoming` into a board holding `taken` ids would mean.
 *
 * `taken` is the host's live ids **and the bin's**. The bin matters: a restored
 * card comes back with the id it had, so an arrival that took that string would
 * collide the moment somebody dragged the old card out of the trash - which is
 * the kind of bug that turns up a week later with no way to trace it.
 *
 * `at` is where the block should be centred, or null to place it beside what is
 * already there. Handed in rather than computed, so the caller can drop a board
 * where the pointer is if it ever wants to.
 */
export function planMerge(
  incoming: Pick<Board, 'items' | 'connections' | 'audioOrder' | 'tour'>,
  taken: Iterable<string>,
  hostItems: Iterable<{ x: number, y: number, w: number, h: number, rot: number }> = [],
  at: { x: number, y: number } | null = null,
): MergePlan {
  // Captured before the rename, because dedupeIds() mutates `id` in place. The
  // list is what it was called; the item is what it became.
  const items = incoming.items;
  const was = items.map(i => i.id);
  dedupeIds(items, new Set(taken));

  // old -> new, for the ids that actually moved. An entry per renamed item only,
  // so the common case of two boards with no ids in common builds nothing and
  // every lookup below falls through to the id it was given.
  const moved = new Map<string, string>();
  items.forEach((it, i) => { if (was[i] !== it.id) moved.set(was[i], it.id); });
  const now = (id: string) => moved.get(id) ?? id;

  // Only ids this file is actually bringing. A relation naming something that
  // was not in the incoming board is a dangling reference in *that* file, and
  // carrying it over would make it dangle here - where it would eventually
  // resolve, wrongly, against a host card that happens to share the string.
  //
  // Tested against the ids the file *arrived* with, not against the ids it
  // leaves with. Those are different sets the moment dedupeIds() renames
  // anything, and the difference is a hole: host owns `a`, the incoming file
  // has an image `a` and a note whose meta.stuckTo says `a~2`, naming nothing.
  // dedupeIds renames the image to `a~2` - so `a~2` is now in the outgoing set,
  // the dangling reference matches it, and the note is pinned to a card it was
  // never on. Verified against planMerge(); the rename is exactly what makes
  // the collision, so the busier the host board the likelier it is.
  //
  // `was` is the arriving set, so a reference is kept only when the file it
  // came from really contained that id - and is then put through the rename.
  const arriving = new Set(was);

  for (const it of items) {
    if (!isRecord(it.meta)) continue;
    // Rewritten in place: these items were made by normalizeBoard() a moment ago
    // out of a file, and nothing else holds them.
    const stuck = it.meta.stuckTo;
    if (typeof stuck === 'string') {
      // A host id that the arrival cannot legitimately name. Dropping the key
      // sends the question back to the measurement, which is what an absent
      // stuckTo already means - see sticky.ts. Better a note that re-measures
      // than a note pinned to a stranger.
      if (arriving.has(stuck)) it.meta.stuckTo = now(stuck);
      else delete it.meta.stuckTo;
    }
    const fence = it.meta.fence;
    if (typeof fence === 'string') {
      if (arriving.has(fence)) it.meta.fence = now(fence);
      else delete it.meta.fence;
    }
  }

  place(items, hostItems, at);

  return {
    items,
    // Filtered on the arriving id and then renamed, in that order - the same
    // rule as the two meta keys above, and for the same reason. Testing
    // `arriving.has(now(id))` asked whether the *result* of the rename names
    // something, which a dangling reference can satisfy by colliding with a
    // card the rename just created.
    connections: incoming.connections
      .filter(c => arriving.has(c[0]) && arriving.has(c[1]))
      .map(c => (c.length > 2 ? [now(c[0]), now(c[1]), c[2]] : [now(c[0]), now(c[1])]) as Connection),
    audioOrder: incoming.audioOrder.filter(id => arriving.has(id)).map(now),
    tour: incoming.tour.filter(id => arriving.has(id)).map(now),
  };
}

/**
 * Move the whole arriving block clear of what is already on the board.
 *
 * **One offset for all of them, not a fresh layout**, and that is the decision
 * this function exists to make. A board somebody composed is a composition: the
 * spacing, the pairings and the things deliberately overlapping are the work.
 * Running the arrivals through arrange() would produce a tidier board and throw
 * away the thing being merged - so the block keeps its own internal geometry
 * exactly, and only moves.
 *
 * To the right of the host with a seam, because a board grows rightward and
 * downward in every layout this app deals, and because "beside" is the one
 * placement that needs no explanation when you look at the result.
 *
 * Degenerate incoming boards - every item at one point, or a single card - are
 * not a special case here: they have bounds too, and they land beside the host
 * like anything else.
 */
function place(
  items: Item[],
  hostItems: Iterable<{ x: number, y: number, w: number, h: number, rot: number }>,
  at: { x: number, y: number } | null,
) {
  const block = itemBounds(items);
  if (!block) return;
  const host = itemBounds(hostItems);
  // Where the block's own centre should end up: beside the host, or wherever the
  // caller asked. An empty host board is the easy case - the arrival is the
  // board, so it stays where its file put it.
  const target = at ?? (host
    ? { x: host.x1 + SEAM + (block.x1 - block.x0) / 2, y: (host.y0 + host.y1) / 2 }
    : null);
  if (!target) return;
  const dx = target.x - (block.x0 + block.x1) / 2;
  const dy = target.y - (block.y0 + block.y1) / 2;
  if (!dx && !dy) return;
  for (const it of items) { it.x += dx; it.y += dy; }
}
