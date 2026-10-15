// The tour's mutations: which cards a board's tour stops at, in what order,
// with what said at each. Base layer beside connections.ts and trash.ts, and
// re-exported by state.ts, which stays the only door. Must never import
// state.ts (tests/layers.test.js). Playing a tour is ui/tour.ts, editing one
// is ui/tour-edit.ts; this is only the list.

import { board, isFurniture, normalizeTour } from './board-model.ts';
import type { Item, TourStop } from './board-model.ts';
import { bus, markDirty } from './board-store.ts';
import { commit } from './history.ts';
import { stuckTo } from './sticky.ts';

/**
 * Every id this board still answers for: what is on it, plus what is in the bin.
 *
 * The union board-schema.ts writes the tour and the playlist order against, and
 * the reason it is a union: a card in the bin can come back, and its place in
 * an ordering has to come back with it. A pruner that only knows about live
 * items turns "delete a card" into "and forget where it stood", quietly and
 * permanently, on the next unrelated edit.
 */
export const filedIds = () => new Set([
  ...board.items.map(i => i.id),
  ...board.trash.map(t => t.item.id),
]);

/**
 * The board's tour: which cards it stops at, in order.
 *
 * Off the undo stack, exactly like setAudioOrder() in state.ts and for the
 * argument that one makes - a tour is a way of *reading* the board rather than
 * a change to what is on it, and a Ctrl+Z that walked back through stop-list
 * edits would step over the real work done between them. The stops are cards
 * that already exist; nothing here creates, moves or deletes anything.
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
 * The two halves of a merge (mergeBoard() in state.ts) each need this and they
 * need it to be the same thing, which is why it is a function rather than the
 * two one-liners the flat list allowed. A stop emptied by the removal goes with
 * the cards - the alone alternative is a stop the camera has nothing to fly to,
 * and it would survive every later normalise because there is nothing wrong
 * with its shape.
 */
export function dropFromTour(tour: TourStop[], ids: Set<string>): TourStop[] {
  return tour
    .map(stop => ({ ...stop, cards: stop.cards.filter(id => !ids.has(id)) }))
    .filter(stop => stop.cards.length);
}
