// The internal clipboard: what a copy of an item is, what is currently held,
// and the receipt that tells our own paste from somebody else's.
//
// Items are held here rather than pushed onto the system clipboard, because an
// item is not text. It can reference an embedded asset of any size, which has
// no honest text/plain form and which round-tripping through the system
// clipboard would make us re-encode and re-hash on every paste - where a copy
// held in memory shares the original's asset hash for free, exactly as
// Duplicate does. What does go out to the system clipboard is a readable
// summary, so that copying a sticky note and pasting it into a text editor
// gives you its words.
//
// **The seam with state.js is "does it touch the board".** Everything in here
// reads the board and writes only to the module-level `clipboard` object, which
// is not board state: it is not saved, not undoable, and not part of any file.
// So copying is entirely here, and the two commands that put something on the
// board or take something off it - paste and cut - stay behind the mutation
// door and call in. That is not a compromise made to satisfy the layering; it
// is the layering noticing a real distinction. A copy is a thing you did to the
// clipboard. A paste is a thing you did to the board, and it has to be one
// undoable command with a label and a history entry like every other.
//
// itemsIn() and cloneItem() live here rather than beside the mutations because
// they are what a *copy* is, and all four copy-shaped operations - copy, cut,
// duplicate, paste - are written in terms of them. Duplicate never touches the
// clipboard and still imports both, which is the tell that they belong to the
// idea of copying rather than to this object.
//
// What must not move in here: anything that calls commit(). There is nothing to
// undo about a clipboard - Ctrl+Z after a copy has to step over it and take
// back whatever edit came before, because the clipboard is not part of what the
// board looks like.
//
// Nothing here imports state.js - see tests/layers.test.js, where this is BASE.

import { toast } from './notify.ts';
import { itemBounds } from './geometry.ts';
import { board } from './board-model.ts';
import type { Item } from './board-model.ts';

/**
 * The items a copy-shaped operation is actually about, z-sorted.
 *
 * The title card is a board-bound singleton: it cannot be copied, cut,
 * duplicated or pasted. Excluded here - the one funnel all four go through
 * (copy, cut, duplicate; paste reads the clipboard this fills) - so a group
 * that happens to include it simply leaves it behind rather than the whole
 * operation refusing.
 */
export function itemsIn(ids: Iterable<string>) {
  const set = ids instanceof Set ? ids : new Set(ids);
  return board.items
    .filter(i => set.has(i.id) && i.type !== 'title')
    .sort((a, b) => (a.z || 0) - (b.z || 0));
}

/**
 * An item on its way onto a board and not yet on one: everything except the two
 * fields the board itself decides. makeItem() fills both in.
 */
export type ItemDraft = Omit<Item, 'id' | 'z'>;

/**
 * The copy that Duplicate and Paste both make: everything about an item except
 * its identity and its place in the stack.
 *
 * `id` and `z` are left off so makeItem() mints a fresh id and puts the copy on
 * top. The asset is copied by *reference*, never by bytes: assets are keyed by
 * content hash and the packer writes each hash once, so duplicating a 40 MB
 * video costs nothing on disk.
 *
 * meta is copied all the way down, and the shallow spread it used to get was
 * defended with "every field in it is a scalar", which has not been true for a
 * long time: `crop`, `adjust`, `flip`, `view`, `presnap`, `rich`, `tags` and
 * `opt` are all objects or arrays, and a shallow copy handed the duplicate the
 * *same* ones. Nothing bit today only because every writer replaces the key
 * rather than reaching into it - which is a convention, held by nobody, in a
 * bag of values whose whole point is that anything may be put in it. One
 * in-place edit anywhere and a change to a note's blocks or a photo's crop
 * would have shown up on a copy made a week earlier.
 *
 * structuredClone rather than a hand-written walk: meta is written to
 * board.json, so everything in it is data by construction, and a copy that
 * knows the shapes would be a second place to teach every time one is added.
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

/**
 * What was last copied, and how many times it has been pasted.
 *
 * `pastes` is the offset counter, not a statistic: each paste lands the cards a
 * little further from the last so a repeated Ctrl+V fans them out rather than
 * stacking them into one shape.
 */
type Clipboard = { items: ItemDraft[], text: string, pastes: number };

const clipboard: Clipboard = { items: [], text: '', pastes: 0 };

export const clipboardSize = () => clipboard.items.length;

/** The box the clipboard's contents were copied from, or null when it is empty. */
export const clipboardBounds = () => itemBounds(clipboard.items);

/**
 * Forget everything held. The clipboard cannot cross a board: opening one calls
 * clearAssets(), so a copy taken from the old board would paste an item whose
 * asset hash no longer resolves to any bytes - a card with a hole in it, which
 * is worse than a Ctrl+V that politely does nothing. loadBoard() is the caller
 * and the only one.
 */
export function clearClipboard() {
  clipboard.items = [];
  clipboard.text = '';
  clipboard.pastes = 0;
}

/**
 * Whether the text the system clipboard is offering is the text *we* put there.
 *
 * This is the one question that decides a paste, and the browser gives no way
 * to ask it directly: two clipboards exist - ours and the machine's - and
 * nothing reports which of them was filled more recently. So a copy leaves a
 * receipt. The exact string handed to the system clipboard is remembered here,
 * and a paste that arrives carrying it is a paste of our own copy: nothing has
 * been copied anywhere else since. A paste carrying anything else means the
 * user has been somewhere else and copied something there, and that newer thing
 * is what they mean by Ctrl+V.
 *
 * The receipt is the summary text itself rather than a hidden token, so that
 * what lands in a text editor is clean. The cost is a collision no wider than
 * copying a note, going away, copying that same text back verbatim from
 * somewhere else, and returning - which yields a copy of the note instead of a
 * new note of the same words, and is not a bad answer to a question nobody can
 * answer correctly.
 */
export function clipboardHasOurs(systemText: string) {
  return !!clipboard.items.length && !!clipboard.text && systemText === clipboard.text;
}

/**
 * Take a copy of some items. Not a board mutation, so nothing to undo.
 *
 * Returns the text the caller should hand to the system clipboard, or '' when
 * there was nothing to copy. That half is the caller's, because only a real
 * `copy`/`cut` event may write to the system clipboard synchronously.
 */
export function copyItems(ids: Iterable<string>) {
  const text = takeItems(itemsIn(ids));
  if (text) toast(`Copied ${itemCount(clipboard.items.length)}`);
  return text;
}

/**
 * The copy itself, without the receipt - given items already resolved and
 * z-sorted.
 *
 * Cut takes exactly this copy but has something else to say about it, and two
 * toasts in the same turn are not two messages - the second replaces the first
 * inside a frame, so all the user sees is the last one and all the first one
 * did was reset the fade. So cut resolves its own items (it needs them for the
 * delete as well), calls this, and toasts once itself.
 */
export function takeItems(src: Item[]) {
  if (!src.length) return '';
  clipboard.items = src.map(i => cloneItem(i));
  clipboard.pastes = 0;
  clipboard.text = summarise(src);
  return clipboard.text;
}

/** "1 item" / "3 items", for the three clipboard receipts. */
export const itemCount = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

/**
 * What a copied selection says on the system clipboard. A note gives up its
 * text, a link its address, and everything else its name - in each case the
 * only part of that item which means anything outside this app. A link's name
 * would be the wrong half here: it is a label, editable and often nothing like
 * the URL, and a link copied out of the board is copied in order to be pasted
 * somewhere that wants the address. The bracketed count is the fallback for a
 * selection with nothing to say - an unnamed photo - because the receipt above
 * only works while the string is never empty.
 */
function summarise(src: Item[]) {
  const lines = src.map(i => (i.type === 'note' ? i.meta.text
                            : i.type === 'link' ? i.meta.url
                            : i.name) || '').filter(Boolean);
  if (lines.length) return lines.join('\n\n');
  return `[mbrd: ${src.length} item${src.length === 1 ? '' : 's'}]`;
}

/**
 * How far each paste steps off the one before it. The same offset Duplicate
 * uses - up and to the right, where a copy lands on a physical desk.
 */
const PASTE_STEP = { x: 28, y: -28 };

/**
 * The items a paste would add, offset for this press, and the counter advanced.
 *
 * `at` is an optional world point to centre the pasted group on. The caller
 * passes one only when the place the copy was taken from is off screen;
 * otherwise it passes nothing and the copy lands beside its original. Pasting
 * in place is what makes copy/paste usable as "another one of these": the pair
 * appears side by side where you can compare them. It is only when the original
 * is somewhere you are not looking that the middle of the screen beats it,
 * because a paste that lands off screen is indistinguishable from one that did
 * nothing at all.
 *
 * Either way the step accumulates across pastes of the same clipboard, so the
 * second Ctrl+V clears the first instead of hiding underneath it.
 *
 * Returns the copies rather than adding them: putting an item on the board is
 * one undoable command and that belongs to the mutation door. An empty
 * clipboard returns [] and does not advance the counter, so a dead Ctrl+V does
 * not silently push the next real one further away.
 */
export function pasteCopies(at: { x: number, y: number } | null = null) {
  if (!clipboard.items.length) return [];
  const n = clipboard.pastes++;
  let dx, dy;
  if (at) {
    // n rather than n + 1, so the first paste at a given point lands *on* it
    // and only the ones after it fan out.
    // Non-null: itemBounds() answers null only for an empty list, and the line
    // at the top of this function returned on exactly that.
    const b = itemBounds(clipboard.items)!;
    dx = at.x - (b.x0 + b.x1) / 2 + n * PASTE_STEP.x;
    dy = at.y - (b.y0 + b.y1) / 2 + n * PASTE_STEP.y;
  } else {
    dx = (n + 1) * PASTE_STEP.x;
    dy = (n + 1) * PASTE_STEP.y;
  }
  return clipboard.items.map(i => cloneItem(i, dx, dy));
}
