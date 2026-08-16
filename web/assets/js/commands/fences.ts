// The fences half of the command surface: drawing a region round some cards.
//
// Two ways in - a rubber band, and the group menu - and one thing they do, so
// the making of a fence is here once rather than in each of them. What differs
// is only what each is allowed to ask for: the band may draw an empty region
// because it has a rectangle, the menu may not because it has nothing to draw.
//
// One contiguous run of the object in commands.ts, lifted whole, plus the four
// helpers that only this run used. See commands/file.ts for why the five runs
// became five files.
//
// ── Where the rest of a fence lives ──
//
// Membership is fences.ts at the top level, and it is *measured* rather than
// stored - a card is in a region because it is inside the rectangle. The
// geometry (fenceBox, itemBounds) is geometry.ts. The offer that appears beside
// the pointer is ui/fence-prompt.ts. What is here is the policy: when there is
// something worth offering, what a fence would be drawn round, and the three
// details of making one that are load-bearing rather than taste.
//
// ── What must not move in here ──
//
// The measurement. If this file ever recorded which cards are in a fence, undo
// would need help it currently does not: taking the fence away leaves the cards
// exactly where they are, and that is only true because nothing wrote anything
// down.
//
// Desktop-only is checked here and enforced in fences.ts, and both halves are
// deliberate - see fenceable().

import { toast } from '../notify.ts';
import {
  addItems, baseStep, board, byId, fenceAt, fenceBox, fenceFollowers, fenceOf,
  isFence, isFurniture, isRider, nextFenceName, select, selection,
} from '../state.ts';
import { itemBounds, MAX_SIZE, MIN_SIZE } from '../geometry.ts';
import { editItemName } from '../canvas/items.ts';
import { openFencePrompt } from '../ui/fence-prompt.ts';
import { rearrange } from '../ui/board-actions.ts';

/** A world-space rectangle, as the marquee hands one over. */
interface Band {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Enough of an item for everything in this file. */
interface Boxed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z?: number;
}

/** What a fence would be drawn round: the selection, less the furniture. */
const fenced = (): Boxed[] =>
  board.items.filter((i: Boxed) => selection.has(i.id) && !isFurniture(i));

/**
 * The one region these items are all already in, or null.
 *
 * A band drawn inside a fence is the ordinary way to get at some of what is in
 * it - pick out four of the twelve and move them - and the offer has no business
 * appearing over that. The grouping it proposes is one the board already has:
 * every card it would enclose is enclosed now, by a region drawn round them for
 * that very reason, so accepting would draw a second boundary exactly where the
 * first one already is. And the cost of asking is not nothing, because the button
 * lands beside the pointer, which is where the hand is about to reach for the
 * cards it just selected.
 *
 * Only when they *share* one. Cards caught from two different regions, or some
 * loose and some not, are a grouping the board does not have yet, so the offer
 * stands - as it does when the band swallowed the fence itself (a region drawn
 * round a region is a real thing to want, and the fence is then one of the caught
 * items, whose own fence is not it).
 *
 * What this gives up is making a *nested* region by banding part of one, and that
 * is the trade: it is much the rarer gesture, and it keeps its other way in - the
 * group menu's Fence these, which asks in so many words rather than by guessing
 * from a rectangle. Suppressing an offer is not removing a command.
 *
 * Exported and re-exported from commands.ts, which is where its test still
 * imports it from: it is a decision rather than a wire, and the only piece of
 * the fence run that can be checked without a board on screen.
 */
export function sharedFence(items: Boxed[]): Boxed | null {
  if (!items.length) return null;
  const first = fenceOf(items[0]);
  return first && items.every(it => fenceOf(it)?.id === first.id) ? first : null;
}

/**
 * Desktop only, because membership is measured on Desktop geometry and nowhere
 * else (see fences.js). A fence made on a phone would have Mobile geometry, no
 * Desktop record to measure against, and no way to acquire one - it would open
 * on a laptop owning nothing.
 */
function fenceable(): boolean {
  if (board.layoutMode !== 'mobile') return true;
  toast('Fences are a canvas thing');
  return false;
}

/**
 * The rectangle a fence would take right now, from a drawn band or without one.
 *
 * Named because two callers need the same answer and one of them is only
 * looking: the offer draws this faintly where the fence would land, and drawing
 * anything else there would be a promise the accept does not keep.
 */
const wouldFence = (rect: Band | null) => fenceBox(rect, itemBounds(fenced()), baseStep());

/**
 * Put a fence over `rect` (a world-space `{x0,y0,x1,y1}`, or null), the current
 * selection, or both.
 *
 * Three details are load-bearing rather than taste:
 *
 * The fence takes a z **below** every card it encloses. Not for painting - every
 * fence is behind every card by band now, see visualStackOrder() - but because
 * raising a fence carries its members and walks them in raw z order, so being the
 * lowest thing in its own layer is what keeps it under them within it. An empty
 * one goes behind the whole board, since anything at all might be dragged into it
 * later and there is no smaller answer.
 *
 * Membership is not recorded here, and there is nothing to record: the cards are
 * inside the rectangle, so they are in the fence, and that stays true because it
 * is measured rather than stored. Which is also why undo needs no help - taking
 * the fence away leaves the cards exactly where they are.
 *
 * The name field opens straight away, in an animation frame so the card exists to
 * open it on, and over a default name rather than an empty plate - the field
 * opens with its text *selected*, so typing replaces the default and pressing
 * Escape keeps it. An unnamed fence is a box; the name is the whole reason to
 * draw one, and asking for it later means never.
 */
function drawFence(rect: Band | null): void {
  const inside = fenced();
  const box = wouldFence(rect);
  if (!box) return;
  // An item is bounded to MAX_SIZE like everything else, and makeItem() clamps
  // silently. A fence clamped down is the one shape whose clamping changes what
  // it *means* - it would come out smaller than what it was drawn to hold - so
  // this says so instead of drawing a lie.
  if (box.w > MAX_SIZE || box.h > MAX_SIZE) {
    toast('Those are too far apart to fence');
    return;
  }
  const under = inside.length ? inside : board.items.filter((i: Boxed) => !isFurniture(i));
  const [fence] = addItems([{
    type: 'fence',
    name: nextFenceName(),
    x: box.x, y: box.y, w: box.w, h: box.h,
    z: Math.min(0, ...under.map(i => i.z || 0)) - 1,
  }], 'Add a fence');
  if (!fence) return;
  select([fence.id]);
  requestAnimationFrame(() => editItemName(fence.id));
}

export function fenceCommands() {
  return {
    /**
     * Draw a fence around what is selected, with no rectangle to go on.
     *
     * The menu's way in, and the one that survives a selection built by
     * shift-clicking, where there is no band to catch the answer. Two or more,
     * because with nothing drawn the selection is the whole of the instruction
     * and one card is not a group - the band has no such rule, since a rectangle
     * round one photograph is still a region somebody drew.
     */
    fenceSelection: () => {
      if (!fenceable()) return;
      if (fenced().length < 2) {
        toast('Pick two or more cards to fence');
        return;
      }
      drawFence(null);
    },

    /**
     * Offer to fence what a rubber band just caught, beside the pointer that let
     * it go. canvas/input.js calls this at the end of every marquee; the policy
     * for whether there is anything worth offering is here rather than there,
     * because it is a question about the board and not about the gesture.
     *
     * A band that caught nothing is still an offer - that is the empty fence you
     * could not make before, and Fences' own way of making one - but only above a
     * size, since a band flicked across empty board is how the selection gets
     * cleared and an offer after every one of those would be an interruption.
     * With something caught there is no floor: the contents set the size.
     *
     * And nothing at all when the band only picked out part of a region that
     * already exists - see sharedFence(). Note where that test sits: after the
     * empty-band case, so a rectangle drawn on a fence's bare face still offers
     * the nested region it is plainly asking for, and only a band that *caught
     * cards* is read as reaching into one.
     */
    fencePrompt: (x: number, y: number, rect: Band) => {
      if (board.layoutMode === 'mobile') return;
      const inside = fenced();
      const count = inside.length;
      if (!count && (rect.x1 - rect.x0 < MIN_SIZE || rect.y1 - rect.y0 < MIN_SIZE)) return;
      if (sharedFence(inside)) return;
      openFencePrompt(x, y, count, wouldFence(rect), () => {
        if (fenceable()) drawFence(rect);
      });
    },

    /**
     * The smallest region a world point is inside, or null. The menu's question,
     * asked once when it opens: a right-click inside a region should offer to
     * arrange *that*, not the board it is drawn on.
     */
    fenceUnder: (at: { x: number; y: number }) => {
      if (board.layoutMode === 'mobile') return null;
      // SAFETY: fenceAt() answers an Item, and Boxed is the narrower shape this
      // file reads one through - an id and a rectangle. The `?.` covers the
      // miss; nothing is written through the view.
      return (fenceAt(at.x, at.y) as Boxed | null)?.id ?? null;
    },

    /** Is this item a region? The menu's other way in - by its name plate. */
    isFenceItem: (id: string) => isFence(byId(id)),

    /**
     * Lay one region's contents out again, in masonry, and close it around them.
     *
     * Masonry whatever the board is set to, and that is a claim about what a
     * region is for. The board's arrangement is a statement about the board -
     * a spiral, a ring, cards thrown down - and it is chosen for the shape of the
     * *whole*. A region is a shelf: what you want inside one is everything
     * visible at once with nothing wasted between, which is the one thing masonry
     * is better at than any of the others. It is also the only layout here that
     * reads as filling a rectangle rather than as occupying a space.
     *
     * The whole subtree rather than the direct members, because a nested region
     * has to arrive with its own cards - fenceFollowers() is that set, and
     * rearrange() then lays out only what the outer region holds directly and
     * carries the rest (see its `carried`).
     */
    rearrangeFence: (id: string) => {
      const fence = byId(id);
      if (!isFence(fence)) return;
      if (!fenceable()) return;
      const inside = fenceFollowers([id]).map(byId).filter(it => !!it);
      if (inside.filter(i => !isRider(i)).length < 2) {
        toast('Put two or more cards in it first');
        return;
      }
      rearrange(inside, {
        name: 'masonry',
        center: { x: fence.x, y: fence.y },
        enclose: id,
        label: 'Rearrange fence',
      });
    },
  };
}
