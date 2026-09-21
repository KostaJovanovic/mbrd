// Event bus, selection set, dirty flag — the three primitives state.ts
// stands on. Nothing here imports above it; everything is re-exported
// by state.ts. `board` itself stays out — data with defaults belongs
// in board-model.ts, not under the bus.

import { emitter } from './util.ts';

/** Every event the bus carries. void = no payload. Typed so an emit of
 *  something unlisted fails to compile. See payloads in the type below. */
export type BusEvents = {
  items: { added: string[], removed: string[] } | undefined,
  geom: string[],
  item: string,
  selection: void,
  settings: string,
  layout: string,
  lens: string,
  board: void,
  'board:load': void,
  'board:new': void,
  view: void,
  trash: void,
  'trash:evicted': number,
  /** A delete that filled the bin: the next one drops the oldest. */
  'trash:full': void,
  'trash:purged': { items: number, bytes: number },
  history: void,
  /** An edit refused because the Timeline is playing (history.ts commit()). */
  readonly: void,
  connections: void,
  autosaved: void,
  filter: void,
  audioOrder: string[],
  // board-model.ts's TourStop, spelled out rather than imported: this module
  // is below that one, and even a type-only import back would be an edge to
  // tests/layers.test.js (which reads the specifier, not the keyword).
  tour: { cards: string[], caption?: string }[],
  'tour:at': number,
  fonts: void,
  'fonts:add': File[],
  imported: { id: string }[],
  'feed:masthead': boolean,
};

/**
 * The one bus. Every board mutation announces on it and no subsystem calls
 * another directly.
 */
export const bus = emitter<BusEvents>();

/**
 * What is selected, by id. A live Set rather than a snapshot: read on hot
 * paths (every drag frame asks what it's moving), so copying per read
 * would be the wrong trade.
 */
export const selection = new Set<string>();

/**
 * The three writes to that Set that announce themselves. Live beside the Set
 * rather than in state.ts because they're not board mutations - nothing is
 * dirtied, nothing to undo - so they never needed the mutation door.
 *
 * Callers wanting a *quiet* write (no announcement) still write to the Set
 * directly - loadBoard() and a command's undo half both do. That's why these
 * are three small functions rather than a Set wrapper: the quiet path must
 * stay available.
 *
 * `selectAll()` isn't here - it needs the item list from board-model.ts,
 * which imports this module - so it stays in state.ts as a one-liner over this.
 */
export function select(ids: Iterable<string>, additive = false) {
  if (!additive) selection.clear();
  for (const id of ids) selection.add(id);
  bus.emit('selection');
}

export function clearSelection() {
  if (!selection.size) return;
  selection.clear();
  bus.emit('selection');
}

/** Remove one item from the current selection, leaving the rest intact. */
export function deselect(id: string) {
  if (!selection.delete(id)) return false;
  bus.emit('selection');
  return true;
}

/**
 * Whether a tap adds to the selection instead of replacing it. Not board
 * state (nothing dirtied, nothing to undo, deliberately not saved), but it
 * changes what the three writers above mean, so it lives beside them.
 *
 * **Exists because a finger has no Shift key.** A phone's only other ways to
 * hold more than one card are a drag band or Select all, neither of which can
 * say "these four" - so this mode lets a tap-per-card gesture work without
 * breaking a normal tap's one-card meaning.
 *
 * While on: a tap toggles instead of replacing, and a pan/bare tap/menu no
 * longer clears the selection. Otherwise unchanged - drag, pan, pinch all work
 * as before. Ends from its menu row, Escape, or a board loading underneath it.
 */
let multiSelect = false;

export const isMultiSelect = () => multiSelect;

export function setMultiSelect(on: boolean) {
  const next = !!on;
  if (multiSelect === next) return;
  multiSelect = next;
  // On 'selection' rather than a new event: every listener that cares about
  // one cares about the other.
  bus.emit('selection');
}

/**
 * Put the mode down without announcing it, for loadBoard()'s reset - it's
 * mid-replace here, and an early event would have listeners paint against an
 * unfinished board. loadBoard() emits 'selection' itself at the end instead.
 */
export function resetMultiSelect() { multiSelect = false; }

/**
 * Which tags the board is being filtered to, or an empty set for "everything".
 *
 * Here beside the selection because it is the same kind of thing and wants the
 * same two neighbours: a live Set of strings, read on the paint path, changed
 * by a menu, announced on the bus. It is **not board state** - nothing about
 * the board changes, nothing is dirtied, there is nothing to undo - which is
 * exactly the argument the selection's three writers make a few lines up.
 *
 * **Deliberately not saved.** A filter that survived into the .mbrd would mean
 * opening a board and finding two thirds of it faded out, with the reason
 * recorded in a file you cannot see and a control you have not found yet. The
 * cost of not saving it is that a filter has to be set again after a reload,
 * which is a second of work and is never a surprise.
 *
 * It **dims rather than hides**, and that is the whole design: every card stays
 * where it is, stays selectable, stays draggable and stays in every count the
 * app reports. So there is no state in which the board is lying to you about
 * what is on it - which is what a filter that removed cards would be, on a
 * surface whose entire promise is that it shows you your things.
 *
 * A card matches when it carries *any* of the filtered tags rather than all of
 * them. Any is what a person building up a filter means - each tag added shows
 * more, which is legible while clicking - where all narrows to nothing by the
 * third click and looks broken.
 */
export const tagFilter = new Set<string>();

export function setTagFilter(tags: Iterable<string>) {
  const next = [...new Set(tags)].filter(Boolean).sort();
  if (next.length === tagFilter.size && next.every(t => tagFilter.has(t))) return;
  tagFilter.clear();
  for (const t of next) tagFilter.add(t);
  bus.emit('filter');
}

/**
 * Whether the board holds changes that are not in a file.
 *
 * Emits only when the answer *changes*, which is what keeps a drag from
 * announcing "unsaved" sixty times a second - and is also why history has its
 * own event rather than riding on this one: on an already-dirty board, which is
 * every board after the first edit, this goes quiet.
 */
let dirty = false;
export const isDirty = () => dirty;
export function markDirty(v = true) {
  if (dirty === v) return;
  dirty = v;
  bus.emit('board');
}

/**
 * Put the flag down without announcing it, for a caller that is about to
 * announce something larger.
 *
 * loadBoard() is the caller and the only one. It replaces the board wholesale
 * and then emits 'board' itself, unconditionally, because everything about the
 * board is new - so markDirty(false) there would either be a second 'board' on
 * the same tick or, on a board that happened to be clean already, nothing at
 * all. Neither is what the flag needs to say. Kept separate rather than folded
 * into markDirty as an option, so the quiet write has to be asked for by name.
 */
export function resetDirty() {
  dirty = false;
}
