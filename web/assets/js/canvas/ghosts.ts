// What the ghost cards say, and when they go.
//
// state.js owns the three items themselves - their ids, their geometry and the
// fact that they exist at all (see ensureGhostCards there, and the note above it
// for why they are real items rather than an overlay). This file owns the two
// things that are not state's business: the words, and the moment.
//
// The split is the layering rule doing its job. state.js sits below the canvas
// and has no business holding user-facing prose, so an item carries only a key
// in meta.hint - 'drop', 'move', 'formats' - and the mapping from key to sentence
// lives up here beside the renderer that draws it.
//
// Note what is *not* here: the exit. That was expected to be a third job and
// turned out to need no code at all - see initGhosts() at the foot of the file.
//
// The copy is deliberately layout-neutral. Desktop and Mobile share items and
// differ in everything spatial, and these cards are shown in both, so a hint
// that says "wheel to zoom" would be wrong on a phone and one that says "pinch"
// would be wrong on a laptop.
//
// The three hints are legends rather than paragraphs - three icons with a few
// words beside each - and that is a form which cannot name the outcome and duck
// the gesture the way a sentence can. So each row names both registers at once
// ("Wheel or pinch to zoom"), the move ui/settings-schema.js's KEYS table
// already makes with its 'two fingers' row; and a row with no touch form carries
// `desktop`, which ghosts.css hides under data-board-mode="mobile". A phone is
// never shown a gesture it cannot make.
//
// The prose left in the file is the not-found pair, and it stays prose because
// it is not instruction. A card saying that the address is dead and that the
// visitor's own board has not been touched has nothing to draw and everything
// to say.
//
// The gestures behind all of it are the ones in canvas/input.js's header - it is
// the map, and this is a paraphrase of it that has to stay true.

import { bus, dismissGhosts, hasContent, hasGhosts, isNotFoundBoard } from '../state.ts';

/**
 * One row of the legend a hint may print in place of a paragraph: a `<symbol>`
 * in web/assets/icons.svg, and the few words that stand beside it.
 *
 * `desktop` marks a row naming something a phone cannot do. Two lists - one per
 * layout - would be the obvious alternative and is the wrong one: the item is
 * the same item in both modes and the card is rebuilt on a layout switch, so a
 * flag CSS can act on keeps one list and one source of truth. See the head of
 * the file.
 */
export type HintRow = {
  icon: string;
  label: string;
  desktop?: true;
};

/**
 * One card's copy. `href`/`go` are the link card's alone - every hint has the
 * same shape so nothing downstream has to check, which is why they are optional
 * here rather than a second type.
 *
 * `line` and `rows` are the two registers a hint can be in, and a hint is in
 * exactly one of them: a paragraph you read, or a legend you look at. The
 * renderer prints whichever it finds.
 */
export type Hint = {
  title: string;
  line?: string;
  rows?: readonly HintRow[];
  href?: string;
  go?: string;
};

/** The keys a ghost item's `meta.hint` may name - the two sets, in one union. */
export type HintKey = 'drop' | 'move' | 'formats' | 'whimsy' | 'gone' | 'back';

/**
 * The three hints, keyed by the meta.hint their item carries.
 *
 * A title and three rows. The title has to survive being read at a glance and
 * from across a zoomed-out board; the rows under it are for someone who has
 * actually stopped to look. Anything longer stops being a hint and starts being
 * a manual pinned to the board.
 *
 * Three is the ceiling rather than the shape, and a card is welcome to run to
 * two: a row added to square up a set is the manual arriving one line at a
 * time. All three happen to have three today.
 *
 * They were paragraphs, and the change is that discipline taken one step
 * further rather than a different one. A sentence explaining that the surface
 * pans and zooms is read once and by nobody; four words beside a mark are read
 * at a glance and are the answer to the question the card is actually being
 * asked. The three cards are the three questions, in the order they come up:
 * where am I, how do things get here, and what is it willing to take.
 *
 * The glyphs are the app's own, which is most of what makes a row worth
 * drawing - i-plus is the Files tool on the toolbar, i-pen is Note, i-link is
 * Link - so a row is a picture of the button it names, and
 * the board is teaching its own chrome. No glyph appears on two cards: a mark
 * meaning one thing here and another thing four hundred pixels away is worse
 * than no mark.
 */
export const HINTS: Readonly<Record<HintKey, Hint>> = Object.freeze({
  drop: {
    title: 'A surface for thinking',
    // Three, and in the order somebody meets them: you move before you scale,
    // and you gather things up only once there is something to gather. A fourth
    // row would be the manual this card exists not to be - the whole legend,
    // sixteen rows of it, is in the panel already (KEYS in
    // ui/settings-schema.js) and this is the doorway to it, not a copy.
    rows: [
      { icon: 'i-move', label: 'Drag or two fingers to pan' },
      { icon: 'i-zoom-in', label: 'Wheel or pinch to zoom' },
      // No touch form: a marquee on a screen is a double-tap and then a drag,
      // which cannot be said in four words and is not the gesture anybody needs
      // told on a phone. Hidden there rather than reworded. See HintRow.
      { icon: 'i-select-all', label: 'Shift-drag to select', desktop: true },
    ],
  },
  move: {
    title: 'Whatever you\'re gathering',
    // The line here used to be the list - images, video, music, documents, 3D
    // files, notes - and a list is the wrong shape for this card twice over. It
    // is longer than anybody reads standing at a blank board, and it is the
    // next card's job now.
    //
    // What is left is the three things you can make: the first three creation
    // tools on the toolbar, in the toolbar's own order and wearing the toolbar's
    // own glyphs. Colour and Stickers are the two left out, and they are the two
    // that mean nothing on a board with nothing on it yet.
    rows: [
      { icon: 'i-plus', label: 'Drop files anywhere' },
      { icon: 'i-link', label: 'Add a link' },
      { icon: 'i-pen', label: 'Write a note' },
    ],
  },
  formats: {
    title: 'Almost anything you have',
    // The first two rows are what the board *draws*, which is the branches of
    // classify() in canvas/renderers.js and nothing else - so they move when
    // that function does and are wrong the moment they do not.
    //
    // The third is the one row on any of these cards that is a promise rather
    // than an instruction, and it earns the space the count row did not: audio
    // is the one thing on that list which stops being a card once there is more
    // than one of it. The board becomes a player - ui/playlist.js, the sidebar
    // window on Desktop and the Feed's second lens on Mobile - and a player is
    // not a thing anybody guesses a pinboard has. Where it opens from is left
    // out on purpose: two layouts, two answers, and neither is any use until
    // there is a song on the board.
    rows: [
      { icon: 'i-picture', label: 'Images, video, audio, 3D' },
      { icon: 'i-edit-text', label: 'PDFs, documents, code' },
      { icon: 'i-music', label: 'Music becomes a playlist' },
    ],
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

  // The other set: what an empty board says when it was opened at an address
  // that does not exist. state.js seeds these instead of the three above when
  // main.js boots into not-found (see NOTFOUND there); nothing else about the
  // board differs, which is the point - the app is its own 404 page, and a 404
  // here is an ordinary blank board that knows why it is blank.
  //
  // Two cards, not three, and the same shape as a hint only on paper: the title
  // here is the number itself, and items.css sets it at sixty-odd pixels for
  // this key alone. Everything else follows the hints' discipline - a head that
  // survives a glance, one line for whoever stopped to read.
  //
  // The second sentence is the one that earns the card. A visitor who has a
  // board of their own is looking at a blank one, and needs telling in words
  // that this is not it and that theirs has not been touched; without that, the
  // most reasonable thing to think is that the app has just lost their work.
  gone: {
    title: '404',
    line: 'Nothing of ours lives at that address. This board is blank and it is not yours - nothing on it is saved, and your own is exactly where you left it.',
  },
  // The way back, and the one card in either set that is a link rather than a
  // sentence. `href` is what the renderer switches on; the dial does the same
  // thing through DIAL, and for the same reason - a hint you use rather than
  // read. canvas/input.js already names `a` in its widget branch, so the press
  // reaches the link instead of starting a drag on the card.
  back: {
    title: 'Back to the board',
    line: 'Open the app at its own address. Your last board comes back with it.',
    href: '/',
    // The button says something other than the card's own title, which it would
    // otherwise borrow. A heading and the control under it reading the same
    // four words is the card saying one thing twice - the same objection the
    // dial's note makes about printing a title over a row already labelled
    // Softish / Middle / Harsh.
    go: 'Open mbrd',
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
 * A strip of tape as state.js's tapeFor() places it: an edge, how far along it,
 * an optional turn and a length in px. `edge` stays a plain string because it
 * arrives from a stored board and tapeStyle() falls back rather than refuses.
 */
export type Tape = { edge: string; pos: number; rot?: number; len: number };

/** The same strip as CSS wants it: two percentages, an angle and a length. */
export type TapeStyle = { x: string; y: string; rot: string; len: string };

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
type GhostCommands = { setWhimsy?: (level: number) => void };

let cmds: GhostCommands | null = null;

/** Move the whole interface along the whimsy axis, from the card's dial. */
const setWhimsyLevel = (level: number) => cmds?.setWhimsy?.(level);

/**
 * Put a dial on a level: the thumb, and the word a screen reader reads out.
 *
 * The printed stops are what a sighted user reads and are hidden from the
 * accessibility tree, so the name has to reach the input itself - otherwise the
 * dial announces "1 of 2", which names nothing. Same move ui/mobile-header.js
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
    // the way off it. See isNotFoundBoard() in state.js for the whole argument.
    if (isNotFoundBoard()) return;
    dismissGhosts();
  });
}
