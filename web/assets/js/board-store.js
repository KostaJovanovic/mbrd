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

import { emitter } from './util.js';

/**
 * The one bus. Every board mutation announces on it and no subsystem calls
 * another directly.
 *
 * Events:
 *   items      - the item list itself changed (payload: { added, removed } ids)
 *   geom       - existing items moved/resized (payload: array of ids)
 *   item       - one item's content/name changed (payload: id)
 *   selection  - the selection set changed
 *   settings   - a setting changed (payload: key)
 *   layout     - desktop/mobile geometry profile changed (payload: mode)
 *   board      - a whole new board was loaded, or the title/dirty flag changed
 *   board:load - a board finished loading
 *   board:new  - the board was started over
 *   trash      - something was thrown away, restored, or purged
 *   history    - the undo or redo stack changed
 */
export const bus = emitter();

/**
 * What is selected, by id. A live Set rather than a snapshot: the selection is
 * read on hot paths (every drag frame asks what it is moving) and copying it
 * per read would be the wrong trade.
 */
export const selection = new Set();

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
export function select(ids, additive = false) {
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
export function deselect(id) {
  if (!selection.delete(id)) return false;
  bus.emit('selection');
  return true;
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
