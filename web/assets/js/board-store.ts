// The three primitives everything else in the board layer is built on: the
// event bus, the selection set, and whether there is anything unsaved.
//
// This exists to give state.js a floor to stand on. state.js is the app's one
// mutation door and it grew to hold about ten separate concerns - history,
// stacking, sticky relations, the clipboard, the Mobile pack, serialization -
// each of which is a module waiting to be lifted out. None of them can be,
// while the things they all reach for (the bus to announce on, the dirty flag
// to raise, the selection to read) live in the file being split: a module
// lifted out would have to import state.js, and state.js would have to import
// it back.
//
// So these move down first. Nothing here imports anything above it, which is
// what makes it safe for a module at any level to depend on. Everything is
// re-exported by state.js under its old name, because "state.js is the only
// door" is a rule about where mutations go, not about which file the symbol is
// declared in, and no caller should have to care that it moved.
//
// What does *not* belong here: the board itself. `board` is data with a shape,
// defaults, and a hundred rules about how it may change, and putting it under
// the bus would make this the god-module instead of state.js.

import { emitter } from './util.ts';

/**
 * Every event the one bus carries, and what a handler of it is handed.
 *
 * The list used to be the prose comment that is still half of it below, and the
 * prose had drifted: it named eleven events and the app emits twenty-one. As a
 * type it cannot drift, because an emit of something not on it does not compile
 * - which is the whole reason to write it down twice over.
 *
 * `void` means the event carries nothing and the handler takes no argument.
 * `items` is the one payload that is genuinely optional: the fine-grained
 * announcement says which ids arrived and which left, and the wholesale one -
 * a board load, a reload - says only that the list is not what it was.
 *
 * Ids, not items, everywhere it can be. This module is the bottom of the graph
 * and may not import board-model.ts (which imports *this*, for the bus), so
 * `imported` is stated structurally: anything with an id answers it, which is
 * what an Item is for this purpose.
 *
 *   items         - the item list itself changed
 *   geom          - existing items moved or resized
 *   item          - one item's content or name changed
 *   selection     - the selection set changed
 *   settings      - a setting changed (payload: which)
 *   layout        - desktop/mobile geometry profile changed (payload: mode)
 *   lens          - the mobile lens changed: the Feed or the Playlist
 *   board         - a whole new board was loaded, or the title/dirty flag changed
 *   board:load    - a board finished loading
 *   board:new     - the board was started over
 *   view          - the viewport settled after a pan or a zoom
 *   trash         - something was thrown away, restored, or purged
 *   trash:evicted - the bin overflowed and dropped its oldest (payload: how many)
 *   history       - the undo or redo stack changed
 *   connections   - board.connections changed
 *   autosaved     - the session was written to IndexedDB
 *   filter        - the tag filter changed
 *   audioOrder    - the playlist order changed
 *   tour          - the tour's stops changed
 *   tour:at       - the tour moved to a stop, or ended (payload: the index, or -1)
 *   fonts         - the board's face list changed
 *   fonts:add     - fonts were dropped in and want loading (payload: the files)
 *   imported      - an import finished (payload: what it brought)
 *   feed:masthead - the Feed's masthead scrolled in or out of view
 */
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
  history: void,
  connections: void,
  autosaved: void,
  filter: void,
  audioOrder: string[],
  tour: string[],
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
 * What is selected, by id. A live Set rather than a snapshot: the selection is
 * read on hot paths (every drag frame asks what it is moving) and copying it
 * per read would be the wrong trade.
 */
export const selection = new Set<string>();

/**
 * The three writes to that Set that announce themselves.
 *
 * They live beside it rather than in state.js because they are not board
 * mutations: nothing about the board changes, nothing is dirtied and there is
 * nothing to undo - which is exactly why they never needed the mutation door in
 * the first place. What they do need is the Set and the bus, and both are here.
 *
 * Callers that hold the Set directly and want *no* announcement still write to
 * it themselves - loadBoard() clears it in the middle of replacing everything
 * and emits 'selection' once at the end with the rest, and a command's undo half
 * drops ids while it is already emitting. That is deliberate and is why these
 * are three small functions rather than a wrapper around the Set: the quiet
 * write has to stay available, and making it impossible would mean an event per
 * id on every delete.
 *
 * `selectAll()` is not here, and cannot be: it needs the item list, which lives
 * in board-model.js, which imports this module. It stays in state.js as a
 * one-liner over this.
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
