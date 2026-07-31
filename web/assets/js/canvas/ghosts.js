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
  // The fourth card is a control, not a sentence: it carries the whimsy dial
  // itself, and it prints neither of these. The three stop names under the dial
  // are the whole card - a heading over a row that already reads Softish /
  // Middle / Harsh. says nothing twice - so the title goes to the input as its
  // accessible name instead, and the line is here only because every hint has
  // the same shape and nothing downstream should have to check.
  whimsy: {
    title: 'Whimsy',
    line: 'Playful, or plain.',
  },
});

/** The hint whose card holds a control rather than a paragraph. */
export const DIAL = 'whimsy';

/**
 * The names of the three whimsy stops, printed under the dial.
 *
 * The same three words the sidebar prints under the same slider, because it is
 * the same slider - see ui/settings-schema.js, where the panel's copy of this
 * list lives. Duplicated rather than imported: the list is owned by ui/, which
 * canvas/ may not reach into, and three words are a cheaper duplicate than a
 * new module in the base layer. Whichever way it were shared, the panel and the
 * card would still have to be changed together, so the trailing full stop on
 * "Harsh." is kept exactly - it is the joke the panel already tells.
 */
export const STOPS = Object.freeze(['Softish', 'Middle', 'Harsh.']);

/** The stop name for a level, for the value a screen reader reads out. */
export const stopName = level => STOPS[level] || STOPS[1];

/** The key an item actually resolves to, falling back to the first hint. */
export const hintKey = key => (HINTS[key] ? key : 'drop');

/**
 * Where one strip of tape sits, as the four numbers CSS needs.
 *
 * The placement (see tapeFor in state.js) names an edge and a percentage along
 * it; this turns that into a point in the card's box and an angle. The strip is
 * centred on that point - `translate(-50%, -50%)` in the stylesheet - so half of
 * it is on the card and half is off, which is the only arrangement that reads as
 * tape rather than as a printed band.
 *
 * The two vertical edges add a quarter turn, because a strip laid down the side
 * of a page runs with the side.
 *
 * Pure, so tests can check the geometry without a DOM.
 */
export function tapeStyle(t) {
  const pos = `${t.pos}%`;
  const along = { top: [pos, '0%'], bottom: [pos, '100%'], left: ['0%', pos], right: ['100%', pos] };
  const [x, y] = along[t.edge] || along.top;
  const turn = t.edge === 'left' || t.edge === 'right' ? 90 : 0;
  return { x, y, rot: `${(t.rot || 0) + turn}deg`, len: `${t.len}px` };
}

/** Copy for a ghost item, falling back to the first hint for an unknown key. */
export function hintFor(key) {
  return HINTS[hintKey(key)];
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
/**
 * The command surface, handed in rather than imported.
 *
 * The dial on the fourth card changes the whimsy level, and that lives in
 * ui/appearance.js - which this file may not import, since canvas/ sits below
 * ui/ and tests/layers.test.js enforces it. main.js owns `cmds` and hands it
 * down here, the same move it makes for storage's confirmation prompt
 * (setPrompt). So the dial drives the one command surface everything else does.
 */
let cmds = null;

/** Move the whole interface along the whimsy axis, from the card's dial. */
export const setWhimsyLevel = level => cmds?.setWhimsy?.(level);

/**
 * Put a dial on a level: the thumb, and the word a screen reader reads out.
 *
 * The printed stops are what a sighted user reads and are hidden from the
 * accessibility tree, so the name has to reach the input itself - otherwise the
 * dial announces "1 of 2", which names nothing. Same move ui/mobile-header.js
 * makes on the weight dial.
 */
function showLevel(dial, level) {
  if (dial.value !== level) dial.value = level;
  dial.setAttribute('aria-valuetext', stopName(+level));
}

/**
 * Keep every mounted dial showing the level the interface is actually at.
 *
 * The level can be moved from the settings panel as well as from this card, and
 * an <input> that has drifted from the thing it controls is worse than no input
 * at all. Rather than have ui/appearance.js learn about a card it cannot see,
 * this watches the one thing it already writes on every change: data-whimsy on
 * <html>. canvas/grid.js reads the same attribute for the same reason.
 *
 * One observer for the app, not one per card - there are at most a handful of
 * dials and they are gone the moment the board has anything on it.
 */
function watchWhimsy() {
  if (typeof MutationObserver !== 'function') return;
  const root = document.documentElement;
  new MutationObserver(() => {
    const level = root.dataset.whimsy ?? '1';
    for (const dial of document.querySelectorAll('.ghost-dial input')) showLevel(dial, level);
  }).observe(root, { attributes: true, attributeFilter: ['data-whimsy'] });
}

/** Wire a freshly built dial: drive the axis, and keep its own valuetext true. */
export function bindDial(dial) {
  showLevel(dial, dial.value);
  dial.addEventListener('input', () => {
    showLevel(dial, dial.value);
    setWhimsyLevel(+dial.value);
  });
}

export function initGhosts(commands) {
  cmds = commands || null;
  watchWhimsy();
  bus.on('items', () => {
    // dismissGhosts() emits 'items' itself, so this runs again immediately -
    // and stops here, because by then there are no ghosts left. That is the
    // whole re-entrancy story; it is one level deep and it terminates.
    if (!hasGhosts() || !hasContent()) return;
    dismissGhosts();
  });
}
