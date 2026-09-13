// Fence commands: rubber-band and group-menu paths to drawing a region.
// Membership is measured (fences.ts), not stored, so undo needs no help.
// Desktop-only: fences have no Mobile geometry to measure against.

import { toast } from '../notify.ts';
import {
  addItems, baseStep, board, byId, fenceAt, fenceBox, fenceFollowers, fenceOf,
  isFence, isFurniture, isRider, nextFenceName, select, selection,
} from '../state.ts';
import { itemBounds, MAX_SIZE, MIN_SIZE } from '../geometry.ts';
import { editItemName } from '../canvas/items.ts';
import { openFencePrompt } from '../ui/fence-prompt.ts';
import { rearrange } from '../ui/board-actions.ts';

/** A world-space rectangle from the marquee. */
interface Band {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** An id and a box. */
interface Boxed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z?: number;
}

/** The selection, less furniture. */
const fenced = (): Boxed[] =>
  board.items.filter((i: Boxed) => selection.has(i.id) && !isFurniture(i));

/**
 * The one fence all these items share, or null. Suppresses the fence
 * offer when a band only selected part of a region that already exists.
 */
export function sharedFence(items: Boxed[]): Boxed | null {
  if (!items.length) return null;
  const first = fenceOf(items[0]);
  return first && items.every(it => fenceOf(it)?.id === first.id) ? first : null;
}

// Desktop only: fences have no Mobile geometry to measure against.
function fenceable(): boolean {
  if (board.layoutMode !== 'mobile') return true;
  toast('Fences are a canvas thing');
  return false;
}

// The rectangle a fence would occupy; the offer preview and the accept share it.
const wouldFence = (rect: Band | null) => fenceBox(rect, itemBounds(fenced()), baseStep());

// Create a fence over rect/selection. z goes below enclosed cards so
// raising the fence carries them correctly. Opens the name editor immediately.
function drawFence(rect: Band | null): void {
  const inside = fenced();
  const box = wouldFence(rect);
  if (!box) return;
  // A clamped fence would be smaller than what it was drawn to hold.
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
    // Anchored so clicks on cards inside it do not drag the fence.
    meta: { locked: true },
  }], 'Add a fence');
  if (!fence) return;
  select([fence.id]);
  requestAnimationFrame(() => editItemName(fence.id));
}

export function fenceCommands() {
  return {
    // Menu path: fence the selection (requires 2+, since there is no band).
    fenceSelection: () => {
      if (!fenceable()) return;
      if (fenced().length < 2) {
        toast('Pick two or more cards to fence');
        return;
      }
      drawFence(null);
    },

    // Marquee path: offer a fence beside the pointer after a rubber band.
    // Suppressed for tiny empty bands and for subsets of an existing fence.
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

    /** The innermost fence containing this point, or null. */
    fenceUnder: (at: { x: number; y: number }) => {
      if (board.layoutMode === 'mobile') return null;
      // SAFETY: fenceAt() returns Item | null, and every Item has the id and box that Boxed names.
      return (fenceAt(at.x, at.y) as Boxed | null)?.id ?? null;
    },

    /** Is this item a fence? */
    isFenceItem: (id: string) => isFence(byId(id)),

    // Rearrange a fence's contents in masonry and close it around them.
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
