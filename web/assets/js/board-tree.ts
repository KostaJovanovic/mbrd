// The boards inside the board: every child board's document by id, flat, as
// the file holds them, and the path from the top board to the level on screen.
// Data only - entering and leaving are state.ts's, the file is storage/mbrd.ts's
// (research/boards-in-boards-2026-10-07.md). Below board-schema.ts, which
// writes the whole tree out wherever in it the board on screen is.

import { isRecord, itemHashes, uid } from './util.ts';

/** One board's document, as serializeBoard() writes it and a file holds it. */
export type BoardDoc = Record<string, unknown>;

/** Past these the menu entries that make more are absent, and a file
 *  claiming more is read up to them. */
export const MAX_CHILD_BOARDS = 200;
export const MAX_DEPTH = 8;

/** An id that can name a directory: what uid() makes, and nothing else. */
export const CHILD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Every child of the open file, a grandchild's too, by id. The one on screen
 *  is here as it was when it was entered; the live one is `board`. */
const children = new Map<string, BoardDoc>();

/** The ids from the top board down to the level on screen. Empty at the top. */
const path: string[] = [];

/** The top board's document while a child is on screen, else null. */
let top: BoardDoc | null = null;

/** Which way the level on screen is changing, while it changes; null for a
 *  board arriving whole. A 'board:load' listener that is about the file -
 *  its name, its picture, its save button - asks this and stays put. */
let swap: 'in' | 'out' | null = null;
export const levelSwap = () => swap;

/** Run a level change with levelSwap() answering `dir` throughout. */
export function swapping(dir: 'in' | 'out', run: () => void) {
  swap = dir;
  try { run(); } finally { swap = null; }
}

/** Replace the tree with the one a file or a session brought: `raw` is a
 *  board's `boards`, id to document. Anything that is not one is dropped, and
 *  past MAX_CHILD_BOARDS the rest are left out and counted. */
export function setChildren(raw: unknown): number {
  children.clear();
  path.length = 0;
  top = null;
  if (!isRecord(raw)) return 0;
  let dropped = 0;
  for (const [id, doc] of Object.entries(raw)) {
    if (!CHILD_ID.test(id) || !isRecord(doc)) { dropped++; continue; }
    if (children.size >= MAX_CHILD_BOARDS) { dropped++; continue; }
    children.set(id, doc);
  }
  return dropped;
}

/** Every child document, the one on screen included as `live` says it is now. */
export function childDocs(live: BoardDoc | null = null): Record<string, BoardDoc> | null {
  if (!children.size) return null;
  const out: Record<string, BoardDoc> = {};
  for (const [id, doc] of children) out[id] = doc;
  const here = path[path.length - 1];
  // The picture is taken on the way out, so a save made inside keeps the last.
  const thumb = here ? children.get(here)?.thumb : undefined;
  if (here && live) out[here] = thumb ? { ...live, thumb } : live;
  return out;
}

export const hasChildren = () => children.size > 0;
export const childCount = () => children.size;
export const childDoc = (id: string): BoardDoc | undefined => children.get(id);

/** Put a child's document in, new or changed. */
export function putChild(id: string, doc: BoardDoc) {
  if (CHILD_ID.test(id)) children.set(id, doc);
}

export function dropChild(id: string) {
  children.delete(id);
}

/** The level on screen: the ids from the top, a copy. */
export const boardPath = (): string[] => path.slice();
export const atTop = () => !path.length;
export const topDoc = () => top;

/** Going in: the level being left, as a document, is kept where it belongs. */
export function pushLevel(id: string, leaving: BoardDoc) {
  const here = path[path.length - 1];
  if (here) children.set(here, leaving);
  else top = leaving;
  path.push(id);
}

/** Coming out: the child on screen is kept, and the document of the level
 *  above handed back to be loaded. Null at the top. */
export function popLevel(leaving: BoardDoc): BoardDoc | null {
  const here = path.pop();
  if (!here) return null;
  children.set(here, leaving);
  const above = path[path.length - 1];
  if (above) return children.get(above) ?? null;
  const doc = top;
  top = null;
  return doc;
}

/** The ids a board's own board cards name: its children, one level down. */
export function childIdsOf(doc: { items?: unknown, trash?: unknown }): string[] {
  const out: string[] = [];
  const items: unknown[] = Array.isArray(doc.items) ? doc.items : [];
  const trash: unknown[] = Array.isArray(doc.trash) ? doc.trash : [];
  for (const raw of [...items, ...trash.map(t => (isRecord(t) ? t.item : null))]) {
    if (!isRecord(raw) || raw.type !== 'board' || !isRecord(raw.meta)) continue;
    const id = raw.meta.board;
    if (typeof id === 'string' && CHILD_ID.test(id)) out.push(id);
  }
  return out;
}

/**
 * Of `docs`, the ones a board card reaches from `root`, a card in a bin
 * included. What a save keeps: a child whose card was undone away, or whose
 * card left with an emptied bin, is not written, and so ends with the save.
 */
export function reachable(root: BoardDoc, docs: Record<string, BoardDoc>): Record<string, BoardDoc> {
  const out: Record<string, BoardDoc> = {};
  const queue = childIdsOf(root);
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const doc = docs[id];
    if (!doc || id in out) continue;
    out[id] = doc;
    queue.push(...childIdsOf(doc));
  }
  return out;
}

/** Documents by id, as a copy or a dropped file carries them. */
export type Docs = Record<string, BoardDoc>;

/** A file's `boards` as documents: the entries a child could be, nothing else. */
export function docsOf(raw: Record<string, unknown>): Docs {
  const out: Docs = {};
  for (const [id, doc] of Object.entries(raw)) if (CHILD_ID.test(id) && isRecord(doc)) out[id] = doc;
  return out;
}

/** The documents under these board cards, every level down: what a copy of
 *  the cards has to carry to outlive the file it was made in. */
export function subtreeOf(items: readonly unknown[]): Docs {
  const out: Docs = {};
  const queue = childIdsOf({ items });
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const doc = children.get(id);
    if (!doc || id in out) continue;
    out[id] = structuredClone(doc);
    queue.push(...childIdsOf(doc));
  }
  return out;
}

/** Every content hash the cards of these documents name, bin included. */
export function docsHashes(docs: Docs): string[] {
  const out: string[] = [];
  for (const doc of Object.values(docs)) {
    const items: unknown[] = Array.isArray(doc.items) ? doc.items : [];
    const trash: unknown[] = Array.isArray(doc.trash) ? doc.trash : [];
    for (const raw of [...items, ...trash.map(t => (isRecord(t) ? t.item : null))]) {
      if (!isRecord(raw)) continue;
      const hash = isRecord(raw.asset) && typeof raw.asset.hash === 'string' ? raw.asset.hash : undefined;
      out.push(...itemHashes({ asset: { hash }, meta: isRecord(raw.meta) ? raw.meta : null }));
    }
  }
  return out;
}

/**
 * A copy of the child `id` and everything under it, put in the tree under new
 * ids, its own board cards re-pointed at their copies. `from` is where the
 * documents come from - a clipboard, a dropped file - and the tree is asked
 * when it has no answer. Null when there is no such child or the file is full:
 * the card then says its board is missing, which is the truth.
 */
export function cloneChild(id: string, from: Docs | null = null, seen = new Set<string>()): string | null {
  const doc = from?.[id] ?? children.get(id);
  if (!doc || seen.has(id) || children.size >= MAX_CHILD_BOARDS) return null;
  seen.add(id);
  const copy = structuredClone(doc);
  const items: unknown[] = Array.isArray(copy.items) ? copy.items : [];
  const trash: unknown[] = Array.isArray(copy.trash) ? copy.trash : [];
  for (const raw of [...items, ...trash.map(t => (isRecord(t) ? t.item : null))]) {
    if (!isRecord(raw) || raw.type !== 'board' || !isRecord(raw.meta)) continue;
    const under = raw.meta.board;
    if (typeof under !== 'string') continue;
    raw.meta.board = cloneChild(under, from, seen) ?? under;
  }
  const fresh = uid('b');
  children.set(fresh, copy);
  return fresh;
}

/** Every document in the tree other than the level on screen - what a sweep
 *  or a bin being emptied must leave the bytes of. */
export function otherLevels(): BoardDoc[] {
  const here = path[path.length - 1];
  const out: BoardDoc[] = [];
  if (top) out.push(top);
  for (const [id, doc] of children) if (id !== here) out.push(doc);
  return out;
}
