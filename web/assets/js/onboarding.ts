// Ghost cards for empty boards (onboarding hints) and 404 boards.
// Board hydration only — no commit, no history, no undo.
// Ghost cards are stripped by serializeBoard() and never saved.

import { latticeBox } from './geometry.ts';
import { bus, selection } from './board-store.ts';
import { board, makeItem, isContent, dropIdIndex } from './board-model.ts';
import {
  baseStep, captureLayout, mobileBoardWidth, placeMobileItems,
} from './layout.ts';

export const GHOST_IDS = Object.freeze([
  '__ghost_drop__', '__ghost_move__', '__ghost_formats__', '__ghost_whimsy__',
]);

const DIAL_HINT = 'whimsy';

// All positions are whole grid-step multiples so snapping does not move them.
// mspan/mrows: Mobile column fraction and row count.
type GhostSpec = {
  id: string, hint: string,
  x: number, y: number, w: number, h: number,
  mspan: number, mrows: number,
  tape?: boolean,
};

const HINT_GHOSTS: readonly GhostSpec[] = Object.freeze([
  { id: GHOST_IDS[0], hint: 'drop', x: -320, y:   96, w: 256, h: 192, mspan: 0.5, mrows: 2 },
  { id: GHOST_IDS[1], hint: 'move', x:  -64, y: -160, w: 256, h: 192, mspan: 0.5, mrows: 2 },
  { id: GHOST_IDS[2], hint: 'formats', x:  320, y:  -32, w: 256, h: 192, mspan: 0.5, mrows: 2 },
  // Untaped — a working control, not a scrap to write on.
  { id: GHOST_IDS[3], hint: 'whimsy', x: 0, y: 32, w: 256, h: 64,
    mspan: 1, mrows: 2, tape: false },
]);

// 404 board: one explanatory card + one link back.
export const NOTFOUND_IDS = Object.freeze([
  '__ghost_gone__', '__ghost_back__',
]);

const NOTFOUND: readonly GhostSpec[] = Object.freeze([
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
 * canvas/items.ts throws a culled card's node away and rebuilds it from nothing
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

export function hasContent() {
  return board.items.some(isContent);
}

export const hasGhosts = () => board.items.some(i => i.type === 'ghost');

// Undo must not re-show ghosts — once dismissed, stays dismissed for the session.
let ghostsDismissed = false;

// Not-found cards must survive content drops — they are the only way back.
let notFoundBoard = false;

export const isNotFoundBoard = () => notFoundBoard;

export function leaveNotFoundBoard() {
  notFoundBoard = false;
}

// Seed ghost cards if the board is empty. Returns seeded ids ([] if none).
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
      meta: { hint: g.hint, span: g.mspan, tape: g.tape === false ? [] : tapeFor() },
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
      // `span` travels even on the Desktop path, where nothing reads it. A board
      // seeded on a laptop is opened on a phone, and the Feed is what needs the
      // number - deriving it back out of a Desktop box would mean guessing at
      // the column width the hint was never sized against. See fillHint().
      meta: { hint: g.hint, span: g.mspan, tape: g.tape === false ? [] : tapeFor() },
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
