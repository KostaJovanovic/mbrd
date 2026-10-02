// Internal clipboard: holds copied items in memory (not the system clipboard)
// so assets share hashes for free, and - through an injected carry - the bytes
// those hashes name, so a copy survives a board switch. A readable summary goes
// to the system clipboard. Everything here is non-undoable, non-saved module
// state — the board-mutating half (paste, cut) stays behind the commit() door
// in state.ts. Nothing here imports state.ts (BASE layer).

import { toast } from './notify.ts';
import { itemBounds } from './geometry.ts';
import { board } from './board-model.ts';
import type { Connection, Item } from './board-model.ts';
import { uid } from './util.ts';

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

/** The lines that run between two of these cards, and none that leave the set. */
export function linksAmong(ids: readonly string[]): Connection[] {
  const set = new Set(ids);
  return board.connections.filter(c => set.has(c[0]) && set.has(c[1]));
}

/** A draft that already has the id it will be added under. */
export type IdDraft = ItemDraft & { id: string };

/**
 * Copies of a group with fresh ids, and its lines re-pointed at them - what
 * Duplicate and Paste add, so a photo comes with its notes and their joins.
 * `from[i]` is the id `drafts[i]` was copied from.
 *
 * The two meta references that name another card are re-pointed too, or
 * dropped when that card stayed behind: a copied note whose `stuckTo` still
 * named the original photo reloads stuck to it, across the board from itself.
 * planMerge() in merge.ts does the same to a board folded in.
 */
export function relink(
  drafts: readonly ItemDraft[], from: readonly string[], links: readonly Connection[],
  dx = 0, dy = 0,
): { items: IdDraft[], links: Connection[] } {
  const now = new Map(from.map(id => [id, uid()]));
  const items = drafts.map((d, i) => {
    const copy: IdDraft = { ...cloneItem(d, dx, dy), id: now.get(from[i]) ?? uid() };
    for (const key of ['stuckTo', 'fence']) {
      const ref = copy.meta[key];
      if (typeof ref !== 'string') continue;
      const to = now.get(ref);
      if (to) copy.meta[key] = to;
      else delete copy.meta[key];
    }
    return copy;
  });
  return {
    items,
    links: links.flatMap((c): Connection[] => {
      const a = now.get(c[0]), b = now.get(c[1]);
      if (!a || !b) return [];
      const meta = c[2];
      return [meta ? [a, b, structuredClone(meta)] : [a, b]];
    }),
  };
}

/**
 * What lets a copy outlive its board: the bytes the copied cards name, held
 * beside them.
 *
 * The drafts hold hashes, and the registry they resolve in (storage/assets.ts)
 * is emptied by every board load - so without this a copy on one board pasted
 * nothing on the next, though the item menu's own comment had always said "on
 * any board". `hold` takes the bytes when the copy is made; `restore` puts any
 * the registry has lost back before a paste lands, so the cards arrive whole.
 *
 * Injected, because storage/ sits above this module (the same seam as
 * setAssetNameLookup() in state.ts). **Unwired, the clipboard cannot cross a
 * board** and onBoardLoad() empties it as it always did: a paste of hashes
 * nothing can resolve is a board with holes in it.
 *
 * The cost is memory. Held Blobs stay alive until the next copy replaces them,
 * which for a copied clip is the clip - the same bargain the bin makes for a
 * deleted one, and released at the next Ctrl+C.
 */
export type ByteCarry = {
  hold: (items: readonly ItemDraft[]) => HeldBytes,
  restore: (held: HeldBytes) => void,
};

/** One file's bytes as the carry keeps them - the registry's own fields,
 *  restated here because storage/ is above this module. */
export type HeldAsset = { blob: Blob, mime?: string, ext?: string, name?: string };

/** What `hold` answers and `restore` takes: the bytes, by hash. */
export type HeldBytes = ReadonlyMap<string, HeldAsset>;

let carry: ByteCarry | null = null;
export function setClipboardCarry(c: ByteCarry | null) { carry = c; }

/** Last copied items. `from` is the id each was copied from and `links` the
 *  lines between them, in those ids; `pastes` offsets each successive paste to
 *  fan them out; `held` is the carry's answer for them, their bytes. */
type Clipboard = {
  items: ItemDraft[], from: string[], links: Connection[],
  text: string, pastes: number, held: HeldBytes | null,
};

const clipboard: Clipboard = { items: [], from: [], links: [], text: '', pastes: 0, held: null };

export const clipboardSize = () => clipboard.items.length;

/** What is held, read-only. emptyTrash() keeps the bytes these name. */
export const clippedItems = (): readonly ItemDraft[] => clipboard.items;

/** The box the clipboard's contents were copied from, or null when it is empty. */
export const clipboardBounds = () => itemBounds(clipboard.items);

/** Empty it. */
export function clearClipboard() {
  clipboard.items = [];
  clipboard.from = [];
  clipboard.links = [];
  clipboard.text = '';
  clipboard.pastes = 0;
  clipboard.held = null;
}

/**
 * A board arrived. With a carry the copy survives it, fanning out afresh from
 * the first paste; without one its hashes resolve to nothing there, so it goes.
 */
export function clipboardOnBoardLoad() {
  if (carry) clipboard.pastes = 0;
  else clearClipboard();
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
  clipboard.from = src.map(i => i.id);
  // Copied now, not at paste: a line removed after the copy was in the copy.
  clipboard.links = structuredClone(linksAmong(clipboard.from));
  clipboard.pastes = 0;
  clipboard.text = summarise(src);
  clipboard.held = carry ? carry.hold(clipboard.items) : null;
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
 * Returns copies with fresh ids and the lines between them — the caller
 * commits both to the board, as one step.
 */
export function pasteCopies(at: { x: number, y: number } | null = null) {
  if (!clipboard.items.length) return { items: [], links: [] };
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
  // Before the copies exist, so a renderer that draws them finds their bytes.
  if (carry && clipboard.held) carry.restore(clipboard.held);
  return relink(clipboard.items, clipboard.from, clipboard.links, dx, dy);
}
