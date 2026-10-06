// Fence commands: rubber-band and group-menu paths to drawing a region, and
// the ungroup that takes one away.
// Membership is measured (fences.ts), not stored, so undo needs no help.
// Desktop-only: fences have no Mobile geometry to measure against.

import { toast } from '../notify.ts';
import {
  addItems, anchorQuietly, baseStep, board, byId, fenceAt, fenceBox, fenceFollowers, fenceOf,
  isFence, isFurniture, isRider, nextFenceName, select, selection, startFresh,
  isRolled, setFenceRolled, setFenceTint, commit, lastCommand, takeBack, removeItems,
} from '../state.ts';
import { itemBounds, MAX_SIZE, MIN_SIZE } from '../geometry.ts';
import { editItemName } from '../canvas/items.ts';
import { openFencePrompt } from '../ui/fence-prompt.ts';
import { rearrange } from '../ui/board-actions.ts';
import { canvasOnly } from './view.ts';

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
  canvasOnly('Fences are a canvas thing');
  return false;
}

// The rectangle a fence would occupy.
const wouldFence = (rect: Band | null) => fenceBox(rect, itemBounds(fenced()), baseStep());

// A clamped fence would be smaller than what it was drawn to hold.
const tooFar = (box: { w: number, h: number }) => box.w > MAX_SIZE || box.h > MAX_SIZE;

// Create a fence over rect/selection. z goes below enclosed cards so
// raising the fence carries them correctly. Answers the new fence's id.
function addFence(rect: Band | null): string | null {
  const inside = fenced();
  const box = wouldFence(rect);
  if (!box || tooFar(box)) return null;
  const under = inside.length ? inside : board.items.filter((i: Boxed) => !isFurniture(i));
  const [fence] = addItems([{
    type: 'fence',
    name: nextFenceName(),
    x: box.x, y: box.y, w: box.w, h: box.h,
    z: Math.min(0, ...under.map(i => i.z || 0)) - 1,
  }], 'Add a fence');
  return fence?.id ?? null;
}

// Free for now, so it can be moved into place, then anchored so clicks on
// cards inside it do not drag the fence. See the fresh-fence clock in sticky.ts.
// Opens the name editor immediately.
function welcomeFence(id: string) {
  startFresh(id, () => anchorQuietly(id));
  select([id]);
  requestAnimationFrame(() => editItemName(id));
}

function drawFence(rect: Band | null): void {
  const box = wouldFence(rect);
  if (box && tooFar(box)) { offerGather(); return; }
  const id = addFence(rect);
  if (id) welcomeFence(id);
}

/** Too far apart to fence where they are: offered the gather, never refused. */
function offerGather() {
  toast('Those are too far apart to fence where they are', '',
    { label: 'Gather and fence', run: gatherAndFence });
}

/**
 * Lay the selection out about its middle (masonry), then fence it, as one undo
 * step. Each half commits as it always does; both are then withdrawn and
 * committed again together, so Ctrl+Z takes back the fence and the gather at
 * once.
 */
function gatherAndFence() {
  if (!fenceable()) return;
  const items = fenced().map(i => byId(i.id)).filter(it => !!it);
  if (!items.length) return;
  const was = lastCommand();
  rearrange(items, { name: 'masonry', label: 'Gather' });
  const gathered = lastCommand();
  const id = addFence(null);
  const made = lastCommand();
  if (!id || !made || made === gathered) {
    if (gathered !== was) takeBack(gathered);
    toast('Even gathered, those will not fit in one fence');
    return;
  }
  if (gathered && gathered !== was) {
    takeBack(made);
    takeBack(gathered);
    commit('Gather and fence',
      () => { gathered.redo(); made.redo(); },
      () => { made.undo(); gathered.undo(); },
      gathered.weight + made.weight);
  }
  welcomeFence(id);
}

export function fenceCommands() {
  return {
    // Menu path: fence the selection. One card is a region too, as the band
    // already allows.
    fenceSelection: () => {
      if (!fenceable()) return;
      if (!fenced().length) {
        toast('Pick a card to fence');
        return;
      }
      drawFence(null);
    },
    gatherAndFence: () => gatherAndFence(),

    // Ctrl+Shift+G, ungroup: the fence round each picked card taken away, or
    // the picked fence itself, and what stood in it left where it was and
    // picked. Membership is measured, so removing the fence is the whole of it.
    unfenceSelection: () => {
      if (!fenceable()) return;
      const gone = new Set<string>();
      for (const id of selection) {
        const it = byId(id);
        const fence = isFence(it) ? it : fenceOf(it);
        if (fence) gone.add(fence.id);
      }
      if (!gone.size) {
        toast('Nothing picked is in a fence');
        return;
      }
      const inside = fenceFollowers(gone).filter(id => {
        const it = byId(id);
        return !!it && !gone.has(id) && !isRider(it);
      });
      removeItems(gone, gone.size === 1 ? 'Remove a fence' : `Remove ${gone.size} fences`);
      select(inside);
    },

    // Marquee path: offer a fence beside the pointer after a rubber band.
    // Suppressed for tiny empty bands and for subsets of an existing fence.
    fencePrompt: (x: number, y: number, rect: Band) => {
      if (board.layoutMode === 'mobile') return;
      const inside = fenced();
      const count = inside.length;
      if (!count && (rect.x1 - rect.x0 < MIN_SIZE || rect.y1 - rect.y0 < MIN_SIZE)) return;
      if (sharedFence(inside)) return;
      openFencePrompt(x, y, count, () => {
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

    /** The fence's colour: a note sheet 1-4, or 0 for the plain well. */
    fenceTintOf: (id: string) => {
      const fence = byId(id);
      const tint = isFence(fence) ? fence.meta?.tint : 0;
      return typeof tint === 'number' ? tint : 0;
    },
    setFenceTint: (id: string, tint: number) => setFenceTint(id, tint),

    /** Is this fence rolled up to its name bar? */
    isRolledFence: (id: string) => isRolled(byId(id)),
    setFenceRolled: (id: string, rolled: boolean) => setFenceRolled(id, rolled),

    // Rearrange a fence's contents in masonry inside it. The fence keeps its
    // size; cards that do not fit overlap rather than spill out.
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
        within: id,
        label: 'Rearrange fence',
      });
    },
  };
}
