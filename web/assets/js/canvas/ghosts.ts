// Ghost card copy and lifecycle. state.ts owns the items; this owns the words
// and the dismissal. Rows with `desktop: true` are hidden on mobile by CSS.

import { bus, dismissGhosts, hasContent, hasGhosts, isNotFoundBoard } from '../state.ts';

export type HintRow = {
  icon: string;
  label: string;
  desktop?: true;
};

export type Hint = {
  title: string;
  line?: string;
  rows?: readonly HintRow[];
  href?: string;
  go?: string;
};

export type HintKey = 'drop' | 'move' | 'formats' | 'whimsy' | 'gone' | 'back';

export const HINTS: Readonly<Record<HintKey, Hint>> = Object.freeze({
  drop: {
    title: 'A surface for thinking',
    rows: [
      { icon: 'i-move', label: 'Drag or two fingers to pan' },
      { icon: 'i-zoom-in', label: 'Wheel or pinch to zoom' },
      { icon: 'i-select-all', label: 'Shift-drag to select', desktop: true },
    ],
  },
  move: {
    title: 'Whatever you\'re gathering',
    rows: [
      { icon: 'i-plus', label: 'Drop files anywhere' },
      { icon: 'i-link', label: 'Add a link' },
      { icon: 'i-pen', label: 'Write a note' },
    ],
  },
  formats: {
    title: 'Almost anything you have',
    rows: [
      { icon: 'i-picture', label: 'Images, video, audio, 3D' },
      { icon: 'i-edit-text', label: 'PDFs, documents, code' },
      { icon: 'i-music', label: 'Music becomes a playlist' },
    ],
  },
  whimsy: {
    title: 'Whimsy',
    line: 'Playful, or plain.',
  },

  gone: {
    title: '404',
    line: 'Nothing of ours lives at that address. This board is blank and it is not yours - nothing on it is saved, and your own is exactly where you left it.',
  },
  back: {
    title: 'Back to the board',
    line: 'Open the app at its own address. Your last board comes back with it.',
    href: '/',
    go: 'Open mbrd',
  },
});

/** The hint whose card holds a control rather than a paragraph. */
export const DIAL = 'whimsy';

/**
 * The names of the three whimsy stops, printed under the dial.
 *
 * The same three words the sidebar prints under the same slider, because it is
 * the same slider - see ui/settings-schema.ts, where the panel's copy of this
 * list lives. Duplicated rather than imported: the list is owned by ui/, which
 * canvas/ may not reach into, and three words are a cheaper duplicate than a
 * new module in the base layer. Whichever way it were shared, the panel and the
 * card would still have to be changed together, so the trailing full stop on
 * "Harsh." is kept exactly - it is the joke the panel already tells.
 */
export const STOPS: readonly string[] = Object.freeze(['Softish', 'Middle', 'Harsh.']);

/** The stop name for a level, for the value a screen reader reads out. */
export const stopName = (level: number): string => STOPS[level] || STOPS[1];

/**
 * The key an item actually resolves to, falling back to the first hint.
 *
 * The test is on the entry, not on the key, and the cast says only that: a key
 * out of a file is checked by what it looks up rather than by its spelling.
 */
export const hintKey = (key: string | undefined): HintKey => {
  // SAFETY: both assertions are the lookup, which is the paragraph above - the
  // key is checked by what it finds in HINTS rather than by its spelling, and a
  // key that finds nothing takes 'drop'. The first cast is only what lets an
  // arbitrary string be looked up at all.
  return HINTS[key as HintKey] ? key as HintKey : 'drop';
};

/**
 * A strip of tape as state.ts's tapeFor() places it: an edge, how far along it,
 * an optional turn and a length in px. `edge` stays a plain string because it
 * arrives from a stored board and tapeStyle() falls back rather than refuses.
 */
export type Tape = { edge: string; pos: number; rot?: number; len: number };

/** The same strip as CSS wants it: two percentages, an angle and a length. */
export type TapeStyle = { x: string; y: string; rot: string; len: string };

/**
 * Where one strip of tape sits, as the four numbers CSS needs.
 *
 * The placement (see tapeFor in state.ts) names an edge and a percentage along
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
export function tapeStyle(t: Tape): TapeStyle {
  const pos = `${t.pos}%`;
  const along: Record<string, [string, string]> =
    { top: [pos, '0%'], bottom: [pos, '100%'], left: ['0%', pos], right: ['100%', pos] };
  const [x, y] = along[t.edge] || along.top;
  const turn = t.edge === 'left' || t.edge === 'right' ? 90 : 0;
  return { x, y, rot: `${(t.rot || 0) + turn}deg`, len: `${t.len}px` };
}

/** Copy for a ghost item, falling back to the first hint for an unknown key. */
export function hintFor(key: string | undefined): Hint {
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
 * a delta naming the removed ids, and canvas/items.ts already flies out every
 * node in a removed delta - so a ghost exits with the same whimsy feel as any
 * deleted card (fall / dissolve / shatter) without a line here asking for it.
 * The one thing that has to be true for that is that the emit carries the ids,
 * which is why dismissGhosts() returns them rather than emitting bare.
 */
/**
 * The command surface, handed in rather than imported.
 *
 * The dial on the fourth card changes the whimsy level, and that lives in
 * ui/appearance.ts - which this file may not import, since canvas/ sits below
 * ui/ and tests/layers.test.js enforces it. main.ts owns `cmds` and hands it
 * down here, the same move it makes for storage's confirmation prompt
 * (setPrompt). So the dial drives the one command surface everything else does.
 */
type GhostCommands = { setWhimsy?: (level: number) => void };

let cmds: GhostCommands | null = null;

/** Move the whole interface along the whimsy axis, from the card's dial. */
const setWhimsyLevel = (level: number) => cmds?.setWhimsy?.(level);

/**
 * Put a dial on a level: the thumb, and the word a screen reader reads out.
 *
 * The printed stops are what a sighted user reads and are hidden from the
 * accessibility tree, so the name has to reach the input itself - otherwise the
 * dial announces "1 of 2", which names nothing. Same move ui/mobile-header.ts
 * makes on the weight dial.
 */
function showLevel(dial: HTMLInputElement, level: string) {
  if (dial.value !== level) dial.value = level;
  dial.setAttribute('aria-valuetext', stopName(+level));
}

/**
 * Keep every mounted dial showing the level the interface is actually at.
 *
 * The level can be moved from the settings panel as well as from this card, and
 * an <input> that has drifted from the thing it controls is worse than no input
 * at all. Rather than have ui/appearance.ts learn about a card it cannot see,
 * this watches the one thing it already writes on every change: data-whimsy on
 * <html>. canvas/grid.ts reads the same attribute for the same reason.
 *
 * One observer for the app, not one per card - there are at most a handful of
 * dials and they are gone the moment the board has anything on it.
 */
function watchWhimsy() {
  if (typeof MutationObserver !== 'function') return;
  const root = document.documentElement;
  new MutationObserver(() => {
    const level = root.dataset.whimsy ?? '1';
    for (const dial of document.querySelectorAll<HTMLInputElement>('.ghost-dial input'))
      showLevel(dial, level);
  }).observe(root, { attributes: true, attributeFilter: ['data-whimsy'] });
}

/** Wire a freshly built dial: drive the axis, and keep its own valuetext true. */
export function bindDial(dial: HTMLInputElement): void {
  showLevel(dial, dial.value);
  // Once per element. RENDERERS.ghost binds the slider it has just built, and
  // ui/feed.ts binds it again after calling that same builder - so on the Feed
  // every move of the dial called setWhimsyLevel() twice. A flag on the node
  // rather than a set here, for the reason canvas/stills.ts gives about the
  // still twin's URL: the node is what goes away.
  if (dial.dataset.dialBound) return;
  dial.dataset.dialBound = '1';
  dial.addEventListener('input', () => {
    showLevel(dial, dial.value);
    setWhimsyLevel(+dial.value);
  });
}

export function initGhosts(commands: GhostCommands | null | undefined): void {
  cmds = commands || null;
  watchWhimsy();
  bus.on('items', () => {
    // dismissGhosts() emits 'items' itself, so this runs again immediately -
    // and stops here, because by then there are no ghosts left. That is the
    // whole re-entrancy story; it is one level deep and it terminates.
    if (!hasGhosts() || !hasContent()) return;
    // The not-found set is not swept. A hint is earned away by doing the thing
    // it describes; these are a statement about the address, and one of them is
    // the way off it. See isNotFoundBoard() in state.ts for the whole argument.
    if (isNotFoundBoard()) return;
    dismissGhosts();
  });
}
