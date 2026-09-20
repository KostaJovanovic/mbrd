// Internal clipboard: holds copied items in memory (not the system clipboard)
// so assets share hashes for free. A readable summary goes to the system
// clipboard. Everything here is non-undoable, non-saved module state — the
// board-mutating half (paste, cut) stays behind the commit() door in state.ts.
// Nothing here imports state.ts (BASE layer).

import { toast } from './notify.ts';
import { itemBounds } from './geometry.ts';
import { board } from './board-model.ts';
import type { Item } from './board-model.ts';

/** A colour to the system clipboard, said in a toast when it lands. */
export function copyHex(hex: string) {
  navigator.clipboard?.writeText(hex).then(() => toast(`Copied ${hex}`), () => {});
}

/**
 * Whether an item may be copied, cut or duplicated. Two never are: the title
 * card, which is a singleton, and the card a cleaned board leaves behind
 * (canvas/spotless.ts), which is earned - a copy of it is one nobody earned.
 */
export const copyable = (i: Item) => i.type !== 'title' && i.type !== 'card';

/** Items for a copy-shaped operation, z-sorted, the uncopyable left out. */
export function itemsIn(ids: Iterable<string>) {
  const set = ids instanceof Set ? ids : new Set(ids);
  return board.items
    .filter(i => set.has(i.id) && copyable(i))
    .sort((a, b) => (a.z || 0) - (b.z || 0));
}

/** An item before it is placed on a board — id and z are filled in by makeItem(). */
export type ItemDraft = Omit<Item, 'id' | 'z'>;

/**
 * Clone an item without id or z (makeItem() mints those). Asset copied by
 * reference (content-hashed). Meta deep-cloned via structuredClone — a shallow
 * spread shared nested objects like crop, adjust, rich.
 */
export function cloneItem(i: ItemDraft, dx = 0, dy = 0): ItemDraft {
  return {
    type: i.type,
    x: i.x + dx,
    y: i.y + dy,
    w: i.w, h: i.h, rot: i.rot,
    name: i.name,
    asset: i.asset ? { ...i.asset } : null,
    meta: structuredClone(i.meta),
  };
}

/** Last copied items. `pastes` offsets each successive paste to fan them out. */
type Clipboard = { items: ItemDraft[], text: string, pastes: number };

const clipboard: Clipboard = { items: [], text: '', pastes: 0 };

export const clipboardSize = () => clipboard.items.length;

/** The box the clipboard's contents were copied from, or null when it is empty. */
export const clipboardBounds = () => itemBounds(clipboard.items);

/** Clear on board load — assets from the old board no longer resolve. */
export function clearClipboard() {
  clipboard.items = [];
  clipboard.text = '';
  clipboard.pastes = 0;
}

/**
 * Whether the system clipboard text matches our receipt — i.e. nothing else
 * has been copied since our last copy. The receipt is the summary text itself
 * (no hidden token), so pasting into a text editor stays clean.
 */
export function clipboardHasOurs(systemText: string) {
  return !!clipboard.items.length && !!clipboard.text && systemText === clipboard.text;
}

/** Copy items and return the summary text for the system clipboard ('' if empty). */
export function copyItems(ids: Iterable<string>) {
  const text = takeItems(itemsIn(ids));
  if (text) toast(`Copied ${itemCount(clipboard.items.length)}`);
  return text;
}

/** Store the copy without toasting — cut calls this and toasts separately. */
export function takeItems(src: Item[]) {
  if (!src.length) return '';
  clipboard.items = src.map(i => cloneItem(i));
  clipboard.pastes = 0;
  clipboard.text = summarise(src);
  return clipboard.text;
}

/** "1 item" / "3 items", for the three clipboard receipts. */
export const itemCount = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

/** System clipboard text: note text, link URL, or name. Fallback: bracketed count. */
function summarise(src: Item[]) {
  const lines = src.map(i => (i.type === 'note' ? i.meta.text
                            : i.type === 'link' ? i.meta.url
                            : i.name) || '').filter(Boolean);
  if (lines.length) return lines.join('\n\n');
  return `[mbrd: ${src.length} item${src.length === 1 ? '' : 's'}]`;
}

/** Offset per paste — up and right, like placing a copy on a desk. */
const PASTE_STEP = { x: 28, y: -28 };

/**
 * Items for a paste, offset from the original (or centred on `at` if the
 * original is off screen). Step accumulates so successive pastes fan out.
 * Returns copies — the caller commits them to the board.
 */
export function pasteCopies(at: { x: number, y: number } | null = null) {
  if (!clipboard.items.length) return [];
  const n = clipboard.pastes++;
  let dx, dy;
  if (at) {
    // n not n+1 — first paste lands on the point, subsequent ones fan out.
    // Non-null: empty list returned early above.
    const b = itemBounds(clipboard.items)!;
    dx = at.x - (b.x0 + b.x1) / 2 + n * PASTE_STEP.x;
    dy = at.y - (b.y0 + b.y1) / 2 + n * PASTE_STEP.y;
  } else {
    dx = (n + 1) * PASTE_STEP.x;
    dy = (n + 1) * PASTE_STEP.y;
  }
  return clipboard.items.map(i => cloneItem(i, dx, dy));
}
