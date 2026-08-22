// A card that is only ever seen by somebody who went looking for the edge.
//
// The board is unbounded and the arithmetic under it is not. Past 2^23 world
// units a 32-bit float - which is what the compositor holds the world's
// transform in, whatever this file does - can no longer tell one pixel from the
// next, and everything out there starts to drift and shimmer. That is the real
// boundary of the board, and it was found the way boundaries are found: by
// somebody panning for a laugh until the picture came apart.
//
// The board is not clamped, deliberately. Clamping would trade a place nobody
// reaches for the word "infinite", and the word is worth more. So instead the
// boundary is marked. Go far enough and there is something there.
//
// Three things this is not, each of them on purpose:
//
//   Not an item. It is never in board.items, so it is not saved, not exported,
//   not selectable, not deleted, not swept up by Rearrange or framed by Fit. A
//   board that has been out here is byte-for-byte a board that has not.
//   #origin-mark is the precedent - furniture on the board that is not of it.
//
//   Not screen-pinned. It is placed in #world at real world coordinates and
//   left there, so it pans and zooms like anything else and you can look away
//   from it and come back. A plaque that followed the viewport would be a
//   notification wearing a card's clothes.
//
//   Not persisted. It is placed at the point where the crossing happened and
//   forgotten on reload. Storing it would mean putting it in the board file,
//   which is the first thing on this list.
//
// It does not stay for the session either. Pan until it has left the screen and
// it is taken down, and a fresh one can be earned - but only by going back
// inside the circle and setting out again, because placement fires on the
// crossing and not on the state of being past it. See `armed`, which is what
// keeps a reset from immediately becoming another placement.
//
// Placed *at* the crossing rather than at fixed coordinates, because a single
// card at one spot on an infinite plane is not an easter egg, it is a secret
// nobody can be told about without ruining it. The distance is the achievement;
// where you were pointed when you got there is not.

import { el } from '../util.ts';
import type { Viewport } from './viewport.ts';

/**
 * How far out the card waits, in world units.
 *
 * 2^23 and not a round number, because it is not a taste: it is the last
 * magnitude at which a 32-bit float still resolves single units, and so the
 * last place a card can be put and still be drawn where it was put. One tier
 * further and the marker would suffer the thing it is there to mark.
 */
export const FAR = 2 ** 23;   // 8,388,608

/** How far from the origin a view is, for the one comparison this file makes. */
export const distance = (x: number, y: number) => Math.hypot(x, y);

/**
 * Whether a view has reached the edge.
 *
 * Split out and exported so the test asserts against the rule rather than
 * against a copy of the number, the bargain MIN_PX and MAX_PX make in grid.ts.
 */
export const isFarOut = (x: number, y: number) => distance(x, y) >= FAR;

// The words on the card. One string, one place, so that changing what it says
// is changing what it says and nothing else.
const LINES = [
  'You are eight million pixels from anywhere.',
  'Past here the numbers stop being able to tell one pixel from the next, '
  + 'and the board starts to come apart. Nothing is stopping you.',
];

/** The card, once it exists. Null until somebody earns it. */
let card: HTMLElement | null = null;

/** Where it stands, in world units. Null exactly when `card` is. */
let at: { x: number; y: number } | null = null;

/**
 * Whether a crossing would place a card, as opposed to merely being far out.
 *
 * The card is taken down once it has been panned off screen, and without this
 * flag that would be a loop rather than a reset: "off screen" is reached while
 * still well outside the circle, so the next frame would find the view far out
 * with no card and put another one at the new centre. Twenty frames later it is
 * a plaque bolted to the middle of the screen that teleports as you pan - which
 * is the one thing this file's header says it is not.
 *
 * So placement is edge-triggered rather than level-triggered: it fires on the
 * *crossing* of the boundary and not on the state of being past it, and the
 * only thing that re-arms it is going back inside. Earning it twice means
 * coming home and setting out again, which is the right price.
 */
let armed = false;

/**
 * Start watching the viewport for the crossing.
 *
 * Takes the viewport rather than reaching for it, and does nothing at import
 * time, so this module loads in a test with no document - the rule every module
 * here follows and tests/imports.test.js enforces.
 *
 * Returns the unsubscribe the caller may keep; main.ts does not, because this
 * lives as long as the board does.
 */
export function initFarLands(vp: Viewport) {
  return vp.onChange(v => {
    if (card) {
      // Taken down the moment it is no longer on screen, rather than left
      // standing. The whole of it has to have gone: a card half out of frame is
      // one the eye is still following, and removing it then is a card that
      // vanishes while being looked at.
      if (!onScreen(v)) clear();
      return;
    }
    if (!isFarOut(v.pan.x, v.pan.y)) { armed = true; return; }
    if (!armed) return;
    at = { x: v.pan.x, y: v.pan.y };
    card = build(at.x, at.y);
    armed = false;
  });
}

/**
 * Whether any part of a card standing at `at` is still inside `rect`.
 *
 * Box against box on both axes, rather than a distance from the view's centre.
 * The difference only shows up off the axes, which is the half of the board
 * that never gets tried: leave along x and the two agree, leave cornerways and
 * a radius says "gone" while two thirds of the card is still on screen. The
 * board is a plane and the card is a rectangle, so the test is a rectangle one.
 *
 * Pure, and exported for that reason - it is the half of the take-down rule
 * that can be checked without a browser, and the half worth checking.
 */
export function boxInView(
  at: { x: number; y: number },
  rect: { x0: number; y0: number; x1: number; y1: number },
  w = W, h = H,
) {
  return at.x + w / 2 >= rect.x0 && at.x - w / 2 <= rect.x1
      && at.y + h / 2 >= rect.y0 && at.y - h / 2 <= rect.y1;
}

/** Whether any part of the card is still inside the view. */
function onScreen(vp: Viewport) {
  return !!at && boxInView(at, vp.visibleRect(0));
}

/** Take the card off the board, leaving the arming alone. */
function clear() {
  card?.remove();
  card = null;
  at = null;
}

/** The card's size in world units. Wide enough for the second line to breathe. */
const W = 420, H = 240;

/**
 * Build the card and put it on the board at a world point.
 *
 * Positioned by the same arithmetic every item uses - left is `x - w/2` and top
 * is `-y - h/2`, the vertical flip included, because #world lays its children
 * out at cssY = -worldY. Doing it the item way rather than inventing a second
 * convention is what keeps it sitting still next to everything else during a
 * pan.
 *
 * Written with createElement and textContent throughout. There is no user data
 * here and so nothing to escape, but the rule in this codebase is that nothing
 * builds a tree from a string, and a decorative exception is how that stops
 * being the rule.
 */
function build(x: number, y: number) {
  const world = el('world');
  if (!world) return null;

  const node = document.createElement('div');
  node.id = 'far-lands';
  // Out of the accessibility tree entirely. It is a joke about floating point
  // for somebody who panned here on purpose, not something a screen reader
  // should announce to somebody who arrived with a keyboard.
  node.setAttribute('aria-hidden', 'true');
  node.style.left = (x - W / 2).toFixed(2) + 'px';
  node.style.top = (-y - H / 2).toFixed(2) + 'px';
  node.style.width = W + 'px';
  node.style.height = H + 'px';

  for (const line of LINES) {
    const p = document.createElement('p');
    p.textContent = line;
    node.append(p);
  }

  world.append(node);
  return node;
}

/**
 * Forget everything, including the arming.
 *
 * For tests and for loading a different board - the point it was placed at
 * belongs to the session that went there, and leaving it behind would put one
 * board's easter egg on another board's paper. Unlike clear(), this also drops
 * the arming, so a board that opens already past the circle does not hand out a
 * card for a journey nobody made.
 */
export function resetFarLands() {
  clear();
  armed = false;
}
