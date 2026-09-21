// Photo and video cards keep their picture's shape. Off the grid a card *is*
// its picture's proportion - a Softish photo is a print, whose window is - and
// on the grid it is the nearest whole cells, with the picture inside it.
// A reshape keeps each card's centre and area and is no history step of its
// own: it is derived from the picture, the tier and the grid.

import {
  board, bus, byId, applyGeom, baseStep, markDirty, isLocked, isRider, stuckTo,
  stuckPlacement, itemBare, setLatticeShape,
} from '../state.ts';
import { latticeBox, latticePicture, pictureBox, printRatio } from '../geometry.ts';
import type { Item } from '../board-model.ts';
import { pictureRatio } from './renderers.ts';

export const isPicture = (it: Item | null | undefined): it is Item =>
  !!it && (it.type === 'image' || it.type === 'video');

/** Whether the board is at Softish, read off the page the look was applied to. */
const softish = () =>
  typeof document !== 'undefined' && document.documentElement.dataset.whimsy === '0';

/** A photograph drawn as a print: Softish, a still, with its card. */
export const isPrint = (it: Item) => it.type === 'image' && !itemBare(it) && softish();

/** Each card's picture proportion, as last measured - for a grip, which cannot wait. */
const ratios = new Map<string, number>();

/**
 * The proportion the card itself should have, or null before its picture has
 * been measured. A print's is taller than its picture by the chin.
 */
export function cardRatio(it: Item) {
  const r = ratios.get(it.id);
  if (!r) return null;
  return isPrint(it) ? printRatio(r) : r;
}

/** Within a pixel on both sides is the shape: rounding is not a reason to move. */
const settled = (it: Item, w: number, h: number) =>
  Math.abs(it.w - w) < 1 && Math.abs(it.h - h) < 1;

type Row = { id: string, x: number, y: number, w: number, h: number };

/**
 * Bring `items` to their pictures' shapes. Off the grid every card is checked,
 * which is idempotent and so safe to run on any excuse. On the grid a card is
 * only refitted when `grid` says a thing changed that the lattice has to be
 * asked about again (a tier switch), because a lattice box of a lattice box is
 * not always the same box, and a pass that ran on every event would walk.
 *
 * Not on the Feed, whose tiles are drawn at their pictures' shape anyway, and
 * never an anchored card, which keeps its size as it does under Reset size.
 */
export function conformPictures(items: Item[], grid = false) {
  // One pass at a time: two overlapping would each write boxes read before the
  // other's landed.
  queue = queue.then(() => conform(items, grid)).catch(err => {
    console.warn('[mbrd] picture shapes', err);
  });
  return queue;
}

let queue: Promise<void> = Promise.resolve();

async function conform(items: Item[], grid: boolean) {
  if (board.layoutMode === 'mobile') return;
  for (const it of items) {
    if (!isPicture(it)) continue;
    const ratio = await pictureRatio(it);
    if (ratio) ratios.set(it.id, ratio);
  }
  // Everything below reads the board after the last wait, which can have let a
  // card move, resize or go.
  const snap = !!board.settings.snap;
  const rows: Row[] = [];
  for (const it of items) {
    const live = byId(it.id);
    const ratio = ratios.get(it.id);
    if (!ratio || !isPicture(live)) continue;
    if (isLocked(live) || (snap && !grid)) continue;
    const card = isPrint(live) ? printRatio(ratio) : ratio;
    const shape = pictureBox(live, card);
    const box = snap
      ? latticePicture({ x: live.x, y: live.y, ...shape }, card, baseStep())
      : { x: live.x, y: live.y, w: Math.round(shape.w), h: Math.round(shape.h) };
    if (settled(live, box.w, box.h) && box.x === live.x && box.y === live.y) continue;
    rows.push({ id: live.id, ...box });
  }
  if (!rows.length) return;
  // What is stuck to a reshaped card keeps its place on it, as under a resize.
  const moved = new Map(rows.map(r => [r.id, r]));
  const riders: Row[] = [];
  for (const it of board.items) {
    const host = isRider(it) ? stuckTo(it) : null;
    const dst = host && moved.get(host.id);
    if (!host || !dst || moved.has(it.id)) continue;
    riders.push({ id: it.id, ...stuckPlacement(it, host, dst), w: it.w, h: it.h });
  }
  applyGeom([...rows, ...riders]);
  markDirty();
}

/** Every picture on the board. */
export const conformAll = (grid = false) =>
  conformPictures(board.items.filter(isPicture), grid);

/** The tier the boxes were last fitted for; null until a board has been seen. */
let wasPrint: boolean | null = null;

/** A tier switch that crosses Softish refits every card, the snapped ones too. */
function checkTier() {
  const now = softish();
  if (now === wasPrint) return;
  const first = wasPrint === null;
  wasPrint = now;
  conformAll(!first);
}

export function initPictureShapes() {
  // Snapping the board on finds a picture the cells nearest its shape. A box
  // already on the lattice is left to latticeBox(), which keeps it, so a
  // re-snap (Reload board) cannot walk a card from one best fit to the next.
  setLatticeShape((it, step) => {
    const card = isPicture(it) ? cardRatio(it) : null;
    if (!card) return null;
    const plain = latticeBox(it, step);
    if (plain.w === it.w && plain.h === it.h) return null;
    return latticePicture(it, card, step);
  });
  // Deferred, because the look reaches the page from a listener on the same
  // events (ui/appearance.ts), which may run after this one.
  const tier = () => queueMicrotask(checkTier);
  bus.on('settings', key => {
    if (key === 'appearance') tier();
    // Leaving the grid hands back the boxes the lattice took, which were made at
    // whatever tier the board had then.
    else if (key === 'snap') conformAll();
  });
  bus.on('board', tier);
  // A board that arrives is fitted as it is.
  bus.on('board:load', () => {
    wasPrint = null;
    ratios.clear();
    tier();
  });
  bus.on('items', change => {
    conformPictures((change?.added || []).map(id => byId(id)).filter(isPicture));
  });
  // A crop, a turn, a new file under the card, a cut-out: each can change the shape.
  bus.on('item', id => {
    const it = byId(id);
    if (isPicture(it)) conformPictures([it]);
  });
  tier();
}
