// Plan for folding one board into another: id remap, relation rewrite, placement.
// Pure — nothing here touches the live board. state.ts mergeBoard() applies it.
// Id refs live in connections, audioOrder, tour, stuckTo, fence — all remapped.
// meta.cover/shot/thumb/preview are content hashes, not ids — left alone.

import { dedupeIds } from './board-model.ts';
import type { Board, Connection, Item, TourStop } from './board-model.ts';
import { itemBounds } from './geometry.ts';
import { isRecord } from './util.ts';

const SEAM = 96;

export type MergePlan = {
  items: Item[],
  connections: Connection[],
  audioOrder: string[],
  tour: TourStop[],
};

// `taken` must include the bin — a restored card reclaims its old id.
export function planMerge(
  incoming: Pick<Board, 'items' | 'connections' | 'audioOrder' | 'tour'>,
  taken: Iterable<string>,
  hostItems: Iterable<{ x: number, y: number, w: number, h: number, rot: number }> = [],
  at: { x: number, y: number } | null = null,
): MergePlan {
  const items = incoming.items;
  const was = items.map(i => i.id);
  dedupeIds(items, new Set(taken));

  const moved = new Map<string, string>();
  items.forEach((it, i) => { if (was[i] !== it.id) moved.set(was[i], it.id); });
  const now = (id: string) => moved.get(id) ?? id;

  // Filter on pre-rename ids — post-rename ids could match a dangling ref
  // that collided with a renamed card.
  const arriving = new Set(was);

  for (const it of items) {
    if (!isRecord(it.meta)) continue;
    const stuck = it.meta.stuckTo;
    if (typeof stuck === 'string') {
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
    connections: incoming.connections
      .filter(c => arriving.has(c[0]) && arriving.has(c[1]))
      .map(c => {
        return (c.length > 2
          ? [now(c[0]), now(c[1]), c[2]]
          : [now(c[0]), now(c[1])]) as Connection;
      }),
    audioOrder: incoming.audioOrder.filter(id => arriving.has(id)).map(now),
    tour: incoming.tour
      .map(stop => ({ ...stop, cards: stop.cards.filter(id => arriving.has(id)).map(now) }))
      .filter(stop => stop.cards.length),
  };
}

// Translate the arriving block beside the host. Preserves internal geometry.
function place(
  items: Item[],
  hostItems: Iterable<{ x: number, y: number, w: number, h: number, rot: number }>,
  at: { x: number, y: number } | null,
) {
  const block = itemBounds(items);
  if (!block) return;
  const host = itemBounds(hostItems);
  const target = at ?? (host
    ? { x: host.x1 + SEAM + (block.x1 - block.x0) / 2, y: (host.y0 + host.y1) / 2 }
    : null);
  if (!target) return;
  const dx = target.x - (block.x0 + block.x1) / 2;
  const dy = target.y - (block.y0 + block.y1) / 2;
  if (!dx && !dy) return;
  for (const it of items) { it.x += dx; it.y += dy; }
}
