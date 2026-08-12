// The cards a board with nothing on it puts there itself: the four onboarding
// hints, and the two a board opened at an address that does not exist carries
// instead.
//
// This is *content and policy*, and it spent a long time inside state.js
// because the things it does - pushing items onto the board, taking them off
// again - look like mutations. They are not. Every function here is board
// hydration: no commit, no history, no undo entry, because none of it is
// anything the user did. A hint appearing is the app noticing the board is
// empty, and a hint leaving is the app noticing it no longer is. Undo has
// nothing to say about either, which is exactly why they cannot go through the
// ordinary mutation door - and why they were the wrong tenant for the file that
// *is* that door.
//
// Ghost cards are furniture, not content, and the difference is enforced at
// exactly three places rather than by a special case sprinkled everywhere:
//
//   1. serializeBoard() strips them (board-schema.js), so no .mbrd ever carries
//      one and the format does not have to learn the type;
//   2. dismissGhosts() is hydration, not a command - no commit, no history -
//      which is what makes their leaving survive an undo of the very import
//      that triggered it;
//   3. removeItems() does not bin them, the way it does not bin the title card.
//
// Everything else about a ghost is an ordinary card: it is selectable,
// draggable, resizable and rotatable, its geometry travels in board.layouts,
// and Mobile packs it into a column like anything else. That is deliberate -
// the alternative was a separate overlay layer outside board.items, which would
// have meant a second gesture pipeline beside canvas/input.js for the sake of
// three cards.
//
// **What each card says is not decided here.** This module holds ids, boxes and
// the key in `meta.hint`; canvas/ghosts.js maps that key to words and pixels.
// The split is worth keeping: a module at this level has no business holding
// user-facing prose, and the geometry below has to be reasoned about in grid
// spaces rather than in sentences.
//
// The two module-level latches are session-scoped and deliberately never
// written anywhere. They are the whole reason this is a module with state
// rather than a table of constants, and they are why it must sit *below*
// state.js: loadBoard() resets one of them on every board that arrives, and a
// module state.js imports cannot import state.js back.
//
// Nothing here imports state.js - see tests/layers.test.js, where this is BASE.

import { latticeBox } from './geometry.js';
import { bus, selection } from './board-store.js';
import { board, makeItem, isContent, dropIdIndex } from './board-model.js';
// Placement, which is the whole of what seeding a hint is once its box is
// known. Both layouts are reachable from here because a hint is the one item
// that can be born into a layout nobody switched to - see ensureGhostCards().
import {
  baseStep, captureLayout, mobileBoardWidth, placeMobileItems,
} from './layout.js';

/**
 * Ghost cards: the four hints a brand-new board opens with.
 *
 * A blank board cannot say what to do with itself, so it is handed cards that
 * do - drop things here, drag to move around, add a note. The moment real
 * content arrives they leave, and that board never shows them again.
 */
export const GHOST_IDS = Object.freeze([
  '__ghost_drop__', '__ghost_move__', '__ghost_note__', '__ghost_whimsy__',
]);

// The one hint that is a control rather than a sentence. Named here because the
// Mobile column orders itself around it; canvas/ghosts.js exports the same
// string as DIAL for the renderer, which is the layer that knows what it means.
const DIAL_HINT = 'whimsy';

// Keyed by id so the two stay in step, and ordered the way they are read.
//
// Every number here is a whole number of grid spaces at the default 64 step,
// and that is the point rather than a coincidence. A snapped board (which is
// what Harsh means on Desktop) lays a box on the lattice by rounding its sides
// to whole cells and its low edges to lines, so geometry that is *already*
// there survives the trip unchanged - the cards look the same snapped and
// unsnapped, and the layout below is the layout in both. Written at the sizes
// that fit a paragraph after rounding, not the sizes that read best before it:
// 216x144 rounded down to 187x123 and clipped its own copy.
//
// 4:3 rather than the title card's 3:2, because a card three cells tall is the
// smallest one the longest hint fits in. The title card snaps to 4x3 as well,
// so on the board that most people see the whole set matches anyway. Fixed
// rather than a starting size, since a ghost carries no resize grips (see
// setGrips in canvas/items.js); canvas/renderers.js defaultSize() names the
// same box.
//
// The positions sit below TITLE_DEFAULT_POS so a fresh board reads top to
// bottom: name, then the dial, then what to do. +y is up.
//
// They are a cascade rather than a row, and each one is placed against the two
// beside it rather than on a line: down and to the right from the drop card,
// past the dial, with the move card dropped below and back to the left. A row
// of three is a table of contents, and this is a board - the first thing it
// says about itself is that things sit where they were put. Every centre is
// still a whole number of grid spaces, so a snapped board keeps the
// arrangement exactly; see the note above.
//
// `mspan` and `mrows` are the box the same card takes on Mobile, where it is
// packed into a column rather than placed: a fraction of the board's width, and
// a whole number of grid rows. A fraction rather than a column count because
// the Mobile board is eight columns by default and six by setting, so "half the
// width" survives that change and "four cells" does not - at six columns it
// would be two thirds of the board and two cards would no longer sit side by
// side. Rows are cells outright, since the row height is the step either way.
const HINT_GHOSTS = Object.freeze([
  { id: GHOST_IDS[0], hint: 'drop', x: -320, y:   96, w: 256, h: 192, mspan: 0.5, mrows: 2 },
  { id: GHOST_IDS[1], hint: 'move', x:  -64, y: -160, w: 256, h: 192, mspan: 0.5, mrows: 2 },
  { id: GHOST_IDS[2], hint: 'note', x:  320, y:  -32, w: 256, h: 192, mspan: 0.5, mrows: 2 },
  // The odd one out: a control rather than a sentence, so it is 4:1 on Desktop -
  // four grid spaces by one. Parked under the title card and in the gap the
  // cascade leaves between the drop card and the note card: the title's lower
  // edge is at 158.5 (130.56 once the board is snapped) and this spans 0 to 64.
  //
  // On Mobile it takes the full width and two rows - the whole top of the column
  // over two half-width hints - so the one control on the board is the one card
  // that never shares a row.
  //
  // And untaped, because it is the one hint that stays an ordinary card at every
  // tier: a torn scrap is a fine thing to write on and a poor thing to mount a
  // working control in, and half a strip of tape across a slider is worse. The
  // rest of that decision is in the CSS, which keeps the Softish page treatment
  // off this hint; the tape is the half that has to be refused here, since it is
  // rolled at minting rather than drawn from the tier.
  { id: GHOST_IDS[3], hint: 'whimsy', x: 0, y: 32, w: 256, h: 64,
    mspan: 1, mrows: 2, tape: false },
]);

/**
 * The other set of hints: what a board opened at an address that does not exist
 * says instead.
 *
 * The app is its own 404 page. A bad URL is served the app with a 404 status
 * (see serve.py, and 404.html for a static host), main.js sees that it is not
 * at the root and opens a blank board without restoring the session - so what
 * the visitor gets is an ordinary empty board, and the cards that an empty board
 * always carries are the ones telling them what happened.
 *
 * Two, and neither is a hint's box. The onboarding set is four equal cards in a
 * cascade because it is four equal things to learn and no one of them is the
 * point; this is one statement and one way out, so it is one large card and one
 * small one beside it. Three of the first draft's cards said in sequence what
 * the first one here says at once, which on a board reads as an argument being
 * made rather than an answer being given.
 *
 * Every number is a whole count of grid spaces at the default 64 step - see the
 * note on the hints above for why that matters at all, and it matters here for
 * the same reason: a snapped board must not rearrange them. The rule is on the
 * *low edges*, not the centres, because that is what the lattice rounds; the two
 * cards below are 256 and 192 tall, so they cannot share a centre line and both
 * satisfy it, and they are laid out from their lower edges instead.
 *
 *   gone  448x256 at (-160, -64)  spans x -384..64,  y -192..64
 *   back  256x192 at ( 256, -96)  spans x  128..384, y -192..0
 *
 * The 64-unit channel between them is the same gap the toolbar and the panel
 * keep; the pair spans -384..384, centred under the title card at x 0; their
 * lower edges are flush at -192; and both sit clear of TITLE_DEFAULT_POS above -
 * the title card's lower edge is at 160 and the taller of these two tops out at
 * 64.
 *
 * Both numbers were off by a half-step when this was written - the big card's
 * left edge landed at -416 and the small one's lower edge at -160 - so a snapped
 * board slid each of them 32 units and the arrangement described here was not
 * the one on screen. tests/state-ghosts.test.js now asserts the invariant rather
 * than the prose claiming it.
 */
export const NOTFOUND_IDS = Object.freeze([
  '__ghost_gone__', '__ghost_back__',
]);

const NOTFOUND = Object.freeze([
  // The big one. Seven cells by four rather than the hint's four by three,
  // because it carries a number set at sixty-odd pixels (see the data-hint rule
  // in items.css) over a paragraph, and a hint's box fits neither.
  { id: NOTFOUND_IDS[0], hint: 'gone', x: -160, y: -64, w: 448, h: 256, mspan: 1, mrows: 3 },
  // The small one, and the only card in either set you press rather than read.
  // Full width on Mobile as well: the card you act on does not share a row, the
  // same call the dial makes at the top of the hints' column.
  { id: NOTFOUND_IDS[1], hint: 'back', x:  256, y: -96, w: 256, h: 192, mspan: 1, mrows: 2 },
]);

/**
 * Where the strips of tape holding a hint down are stuck, at Softish.
 *
 * One or two per card, each straddling a different edge at an angle. Rolled
 * once, here, and carried in the item - *not* decided when the card is drawn.
 * canvas/items.js throws a culled card's node away and rebuilds it from nothing
 * when it comes back on screen, so a placement chosen at render time would put
 * the tape somewhere new every time the board panned past it. Random for each
 * board, and then fixed for that board's life.
 *
 * `pos` is a percentage along the chosen edge, kept well inside the corners so
 * a strip never hangs off one. `rot` is the angle it was pressed down at,
 * relative to that edge. Lengths are world px, the unit the card is sized in.
 *
 * `rand` is injectable so a test can pin the roll.
 */
const TAPE_EDGES = ['top', 'right', 'bottom', 'left'];

export function tapeFor(rand = Math.random) {
  // Two often enough to be a pattern, one often enough that the trio is not a
  // set of matching parcels.
  const count = rand() < 0.45 ? 2 : 1;
  const edges = [...TAPE_EDGES];
  const out = [];
  for (let i = 0; i < count; i++) {
    // Different edges, so two strips on one card never sit on top of each other.
    const edge = edges.splice(Math.floor(rand() * edges.length), 1)[0];
    out.push({
      edge,
      pos: Math.round(24 + rand() * 52),
      rot: Math.round((rand() * 18 - 9) * 10) / 10,
      len: Math.round(56 + rand() * 42),
    });
  }
  return out;
}

/**
 * Whether the board holds anything the user put there *as content*.
 *
 * isContent() rather than !isFurniture(), which is the same rule the HUD count
 * asks - see board-model.js. A board holding nothing but fences is a board
 * holding nothing: the regions are drawn around content, so with no content in
 * them there is nothing to be drawn around, and the hints have not been earned
 * away yet.
 */
export function hasContent() {
  return board.items.some(isContent);
}

/** Whether any ghost card is currently on the board. */
export const hasGhosts = () => board.items.some(i => i.type === 'ghost');

// Session-scoped and deliberately never written anywhere. Its whole job is the
// undo case: content arrives, the ghosts go, and undoing that import must not
// bring them back. A board:new clears it (a new board earns its hints again);
// a board:load sets it from whether the arriving board already has content.
let ghostsDismissed = false;

/**
 * Whether the cards on this board are the not-found set rather than the hints.
 *
 * Session-scoped like the latch above, and read by canvas/ghosts.js, which
 * sweeps the hints the moment real content lands. These must not be swept. A
 * hint is earned away - you have dropped something, so you no longer need
 * telling that you can - but the not-found cards are not advice, they are the
 * only statement on the page that the address was wrong, and one of them is the
 * only way off it. Dropping a photograph onto a board that cannot save it is
 * exactly the moment the warning has to still be there.
 */
let notFoundBoard = false;

/** Whether this board was opened at an address the app does not have. */
export const isNotFoundBoard = () => notFoundBoard;

/**
 * Stop being one: the visitor has put something on the board, so it is a board
 * now and not a message. main.js owns the rest of that handover - the address,
 * the stored session and the writer - and this is the latch it clears on the
 * way through, which lets canvas/ghosts.js sweep the two cards the way it
 * sweeps any hint that has been earned away.
 */
export function leaveNotFoundBoard() {
  notFoundBoard = false;
}

/**
 * Put the ghost cards on the board if it has earned them - board hydration, not
 * a user edit, so no commit and no history. Runs at startup and on load, the
 * same way ensureTitleCard() does and for the same reason.
 *
 * A board with any content at all, or one already dismissed this session, gets
 * nothing.
 *
 * `notFound` swaps the set for the one a board opened at a dead address carries
 * - same geometry, different words, and one card fewer. It is a parameter and
 * not a second function because everything below it is about *placing* cards,
 * which is identical for both sets and was not worth saying twice.
 *
 * Returns the ids it seeded, so the caller can mount them without having to
 * know which set it asked for. An empty array means the board had not earned
 * them, which is the common case.
 */
export function ensureGhostCards({ notFound = false } = {}) {
  if (ghostsDismissed || hasContent() || hasGhosts()) return [];
  notFoundBoard = notFound;
  const GHOSTS = notFound ? NOTFOUND : HINT_GHOSTS;
  const seeded = GHOSTS.map(g => g.id);
  const step = baseStep();
  // Mobile is a column, and the layout above is a Desktop arrangement: four
  // cards spread across nine hundred world units, on a board 512 wide. Seeding
  // straight into it put two of them off the side of the frame entirely. So the
  // same fork addItems() makes for an import - pack them into the feed when
  // Mobile is the live layout, lay them on the lattice when Desktop is.
  //
  // It has to happen here rather than being left to the mode switch, because a
  // phone never makes that switch: it opens in Mobile, and completeLayout() only
  // fills in a profile that is *not* the live one. The hints are the one thing
  // on the board that can be born into a layout nobody switched to.
  if (board.layoutMode === 'mobile') {
    // Sized against the column rather than carried over from Desktop: the dial
    // takes the whole width, the hints half of it, and both are two rows tall.
    // placeMobileItems() takes it from here - it fits, packs and (if the Mobile
    // profile is snapped, which it is by default) lays each one on the lattice.
    const width = mobileBoardWidth(step);
    // The dial goes first, under the masthead, which is where it sits on Desktop
    // too - directly below the title card. The packer takes the order it is
    // given, and a stable sort keeps the three hints in reading order behind it.
    const order = [...GHOSTS].sort((a, b) =>
      Number(b.hint === DIAL_HINT) - Number(a.hint === DIAL_HINT));
    const fresh = order.map(g => makeItem({
      id: g.id, type: 'ghost', x: 0, y: 0, w: width * g.mspan, h: g.mrows * step,
      meta: { hint: g.hint, tape: g.tape === false ? [] : tapeFor() },
    }));
    board.items.push(...placeMobileItems(fresh));
    return seeded;
  }
  for (const g of GHOSTS) {
    // Laid on the lattice on the way in, exactly as an imported item is by
    // onLattice(). The positions above are written for an unsnapped board, and a
    // snapped one is a different board: its cards sit flush in cells, and four
    // that arrived at their own coordinates would be the only things on it that
    // did not. This is the hydration path rather than the import path, so it
    // does no commit and keeps no presnap memo - a hint is never unsnapped back
    // to anything, because it is never saved and never survives content
    // arriving.
    //
    // The step is the board's own, not 64: gridStep is a setting, and hardcoding
    // geometry that happens to be whole cells at the default would come apart
    // the moment somebody moved it.
    const box = board.settings.snap ? latticeBox(g, step) : g;
    board.items.push(makeItem({
      id: g.id, type: 'ghost', x: box.x, y: box.y, w: box.w, h: box.h,
      meta: { hint: g.hint, tape: g.tape === false ? [] : tapeFor() },
    }));
  }
  return seeded;
}

/**
 * Take the ghost cards off the board for good.
 *
 * No commit on purpose - see the note above. Returns the ids it removed so the
 * caller can animate them out; an empty array means there was nothing to do,
 * which is the common case once a board is in use.
 */
export function dismissGhosts() {
  ghostsDismissed = true;
  const gone = board.items.filter(i => i.type === 'ghost').map(i => i.id);
  if (!gone.length) return gone;
  board.items = board.items.filter(i => i.type !== 'ghost');
  let dropped = false;
  for (const id of gone) if (selection.delete(id)) dropped = true;
  bus.emit('items', { added: [], removed: gone });
  if (dropped) bus.emit('selection');
  return gone;
}

/**
 * Reset the latch for a board that is arriving. `content` is whether that board
 * has any of its own - a board with things on it is dismissed before it is even
 * drawn, so its first edit does not try to sweep hints that were never there.
 */
export function resetGhostLatch(content = false) {
  ghostsDismissed = !!content;
}

/**
 * Mint the hint cards again for the layout that is now live.
 *
 * The one thing on the board that cannot carry two layout profiles. Every other
 * item is completed into the profile it is missing from (completeLayout), but a
 * hint is seeded straight into whichever layout happened to be live when the
 * board turned out to be empty - sized against the Mobile column or laid on the
 * Desktop lattice by ensureGhostCards()'s own fork - and it was never in
 * board.layouts at all, because it is never saved. So a switch carried the
 * column's sizes and places onto the canvas: four cards at strip width, stacked
 * one under the other in the middle of an infinite board.
 *
 * Re-minting rather than teaching them to travel, because they are the cheapest
 * items in the app: no content, no history, no file, dismissed the moment
 * anything real arrives. Throwing them away and asking for them again is less
 * code than a migration and cannot drift from the seeding rule, since it *is*
 * the seeding rule.
 *
 * The latch is untouched, which is the whole reason this is not dismiss +
 * ensure: dismissGhosts() means "the user has seen these and is done with
 * them", and a layout switch is not that. Returns the ids now on the board, or
 * an empty array on a board that had none - the common case, and one press of
 * this costs one scan of the item list.
 */
export function reseedGhostCards() {
  if (!hasGhosts()) return [];
  const gone = board.items.filter(i => i.type === 'ghost').map(i => i.id);
  board.items = board.items.filter(i => i.type !== 'ghost');
  for (const id of gone) selection.delete(id);
  dropIdIndex();
  const seeded = ensureGhostCards();
  // The ids are stable - HINT_GHOSTS names them - so the profile just written by
  // completeLayout() is still holding the places these cards had a moment ago,
  // under the same ids. Recapturing the live layout is what puts the fresh ones
  // in; it is a no-op for everything else on the board, since writeLayout() has
  // just handed every other item exactly what this would write back.
  captureLayout();
  bus.emit('items', { added: seeded, removed: gone });
  return seeded;
}
