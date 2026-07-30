// What the ghost cards say, and when they go.
//
// state.js owns the three items themselves - their ids, their geometry and the
// fact that they exist at all (see ensureGhostCards there, and the note above it
// for why they are real items rather than an overlay). This file owns the two
// things that are not state's business: the words, and the moment.
//
// The split is the layering rule doing its job. state.js sits below the canvas
// and has no business holding user-facing prose, so an item carries only a key
// in meta.hint - 'drop', 'move', 'note' - and the mapping from key to sentence
// lives up here beside the renderer that draws it.
//
// Note what is *not* here: the exit. That was expected to be a third job and
// turned out to need no code at all - see initGhosts() at the foot of the file.
//
// The copy is deliberately layout-neutral. Desktop and Mobile share items and
// differ in everything spatial, and these cards are shown in both, so a hint
// that says "wheel to zoom" would be wrong on a phone and one that says "pinch"
// would be wrong on a laptop. Each line therefore names the *outcome* and lets
// both input pipelines be a way of reaching it. The gestures behind them are the
// ones in canvas/input.js's header - it is the map, and this is a paraphrase of
// it that has to stay true.

import { bus, dismissGhosts, hasContent, hasGhosts } from '../state.js';

/**
 * The three hints, keyed by the meta.hint their item carries.
 *
 * A title and one line. The title has to survive being read at a glance and
 * from across a zoomed-out board; the line is for someone who has actually
 * stopped to look. Anything longer stops being a hint and starts being a manual
 * pinned to the board.
 */
export const HINTS = Object.freeze({
  drop: {
    title: 'Drop anything',
    line: 'Pictures, video, sound, text, 3D models. Straight onto the board, from anywhere.',
  },
  move: {
    title: 'Move around',
    line: 'Drag the board to travel. Zoom to see more of it. It does not end.',
  },
  note: {
    title: 'Write a note',
    line: 'Add one from the sidebar, then type. It grows to fit what it says.',
  },
});

/** Copy for a ghost item, falling back to the first hint for an unknown key. */
export function hintFor(key) {
  return HINTS[key] || HINTS.drop;
}

/**
 * Watch for the board's first real content and sweep the hints when it lands.
 *
 * One subscriber on 'items' rather than a call at each door. A ghost has to go
 * when a file is dropped, when a note is added, when something is pasted, when
 * the bin gives something back, when a whole arrangement is imported - and
 * every one of those already ends in an 'items' emit. Hunting them down
 * individually is how one of them gets missed.
 *
 * Leaving is not this file's job either, as it turns out. dismissGhosts() emits
 * a delta naming the removed ids, and canvas/items.js already flies out every
 * node in a removed delta - so a ghost exits with the same whimsy feel as any
 * deleted card (fall / dissolve / shatter) without a line here asking for it.
 * The one thing that has to be true for that is that the emit carries the ids,
 * which is why dismissGhosts() returns them rather than emitting bare.
 */
export function initGhosts() {
  bus.on('items', () => {
    // dismissGhosts() emits 'items' itself, so this runs again immediately -
    // and stops here, because by then there are no ghosts left. That is the
    // whole re-entrancy story; it is one level deep and it terminates.
    if (!hasGhosts() || !hasContent()) return;
    dismissGhosts();
  });
}
