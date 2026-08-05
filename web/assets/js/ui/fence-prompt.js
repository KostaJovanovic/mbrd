// The offer that follows a rubber band: "make these a fence?"
//
// Stardock's Fences puts a small button under the cursor the moment you finish
// dragging a rectangle on the desktop, and it is the right shape for this because
// the gesture has already been made. Dragging a band round five photographs is
// somebody saying *these five*, in the only gesture on the board that already
// means it; a menu asking about it afterwards makes them say it twice. So the
// rectangle is the question and this is the answer, offered where their hand
// already is and taken away when they move on.
//
// Which is the whole design constraint: an offer nobody accepted must cost
// nothing. A modal would have to be dismissed, a toolbar button would sit there
// being ignored, and a menu entry is the thing this replaces. This appears
// beside the cursor, and walking away from it *is* declining it - see reach
// below. Nothing is selected, nothing is changed, and no key has to be pressed.
//
// One at a time, built fresh on each open, torn down on close: the same
// arrangement ui/menu.js uses, for the same reason - the label depends on what
// the band caught, and there is nothing worth keeping hidden between two of them.

// The menu's icon builder, for the menu's icon. This module wears .ctx-item and
// takes the menu's stock; wearing the row and then not the mark on it would
// have made the offer read as a lesser copy of the entry it stands in for.
import { icon } from './menu.js';

/**
 * How far the pointer may stray before the offer is withdrawn, in CSS pixels.
 *
 * ~2.5cm at CSS's nominal 96dpi, which is the middle of the range Fences itself
 * uses. Measured from the popup's *edges* rather than from where it was opened,
 * so the button is its own dead zone and moving towards it can never dismiss it -
 * a threshold measured from the anchor point would shrink as the pointer crossed
 * the button, which is the one direction that must be safe.
 *
 * A nominal centimetre is not a real one on a scaled display, and that is fine:
 * this is a comfortable arm's reach, not a measurement. The board's own scale
 * bar is the thing here that has to be honest about millimetres.
 */
export const REACH = 95;

/** The offer's wording. Plural, singular, and the empty region get their own. */
export function fencePromptLabel(count) {
  if (!count) return 'Fence this area';
  if (count === 1) return 'Fence this one';
  return `Fence these ${count}`;
}

/**
 * Is (x, y) further than `reach` from the rectangle?
 *
 * Distance to the *box*, which is zero anywhere inside it: each axis contributes
 * only its own overshoot, so a pointer level with the button and off to one side
 * is judged by that sideways distance alone rather than by a diagonal to the
 * nearest corner. The corner distance would make the popup harder to keep alive
 * from above and below than from either side, for no reason a user could see.
 */
export function outOfReach(rect, x, y, reach) {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy) > reach;
}

let node = null;
let ghost = null;
let box = null;
let vp = null;
let offView = null;

export function initFencePrompt(viewport) {
  vp = viewport;

  // Withdrawn by distance, and by everything that makes the spot it is pinned to
  // stop meaning what it meant. The pointer rule is the mouse's; the rest are
  // what a touch board has instead, since a finger that has lifted never moves.
  addEventListener('pointermove', e => {
    if (!node || !box) return;
    // A pointer that is *down* is in the middle of doing something else - a pan,
    // a second band - and that gesture's own dismissal is the pointerdown below.
    // Judging it by distance as well would withdraw the offer halfway through a
    // drag that started on top of it.
    if (e.buttons) return;
    if (outOfReach(box, e.clientX, e.clientY, REACH)) close();
  }, { passive: true });
  addEventListener('pointerdown', e => {
    if (node && !node.contains(e.target)) close();
  }, true);
  addEventListener('keydown', e => {
    if (node && e.key === 'Escape') { e.stopPropagation(); close(); }
  }, true);
  addEventListener('resize', close);
  addEventListener('blur', close);
}

export function close() {
  node?.remove();
  ghost?.remove();
  node = null;
  ghost = null;
  box = null;
  offView?.();
  offView = null;
}

/**
 * The region the offer is about, drawn faintly where it would land.
 *
 * The band is gone by the time the offer is up - it is the marquee's, and the
 * marquee ends with the gesture - so without this the question "fence these 5?"
 * is asked about an area nobody can see any more, and the answer is a rectangle
 * that arrives where you have to take it on trust.
 *
 * It shows the **fence's** box and not the band's, and that is the point of
 * putting it here rather than leaving the marquee up: the two are not the same
 * rectangle. A marquee catches what it overlaps, so a card can be caught with
 * half of it outside the band, and the fence opens unioned out to hold what it
 * was drawn to hold (fenceBox). Leaving the band up would have promised the
 * smaller of the two.
 *
 * Screen space, converted once. The offer closes on any view change, so the
 * board cannot move under this while it is up, and a rectangle that cannot go
 * stale does not need to be re-placed on a frame.
 */
function drawGhost(world) {
  if (!vp?.el || !world) return null;
  const el = document.createElement('div');
  el.id = 'fence-ghost';
  el.setAttribute('aria-hidden', 'true');
  // World y points up and CSS y points down, so the top-left corner is the one
  // at +h/2.
  const at = vp.toScreen(world.x - world.w / 2, world.y + world.h / 2);
  el.style.left = `${Math.round(at.x)}px`;
  el.style.top = `${Math.round(at.y)}px`;
  el.style.width = `${Math.round(world.w * vp.zoom)}px`;
  el.style.height = `${Math.round(world.h * vp.zoom)}px`;
  vp.el.append(el);
  return el;
}

/**
 * Offer to fence `count` items, beside the pointer at (clientX, clientY), with
 * `world` shown faintly where the fence would land.
 *
 * `action` is run on the press. The caller keeps hold of what a fence would be
 * drawn over, and hands the box in already worked out, so this module still
 * never learns what a fence is - it is a button with a label, a rectangle to
 * draw and one thing to do.
 */
export function openFencePrompt(clientX, clientY, count, world, action) {
  close();

  // Before the button, so the offer is never the thing painted under: the two go
  // up in the same frame and the button is placed beside the pointer, which is
  // usually just inside the region it is asking about.
  ghost = drawGhost(world);

  node = document.createElement('div');
  node.id = 'fence-prompt';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ctx-item';
  // Icon then label, in that order and in a <span> - .ctx-item is a three
  // column grid, and a bare text node would take the icon's column instead of
  // the label's.
  btn.append(icon('i-fence'));
  const label = document.createElement('span');
  label.textContent = fencePromptLabel(count);
  btn.append(label);
  btn.addEventListener('click', () => {
    close();
    action();
  });
  node.append(btn);

  // Measure hidden, then place - the width depends on the wording. Down and to
  // the right of the release point by a hair, so the offer is beside the cursor
  // rather than under it, and flipped rather than clamped at an edge for the
  // reason ui/menu.js gives: a popup pinned to the edge ends up under the
  // pointer, and gets pressed by accident.
  node.style.visibility = 'hidden';
  document.body.append(node);
  const { width, height } = node.getBoundingClientRect();
  const gap = 12;
  const pad = 8;
  const x = clientX + gap + width + pad > innerWidth
    ? Math.max(pad, clientX - gap - width) : clientX + gap;
  const y = clientY + gap + height + pad > innerHeight
    ? Math.max(pad, clientY - gap - height) : clientY + gap;
  node.style.left = Math.round(x) + 'px';
  node.style.top = Math.round(y) + 'px';
  node.style.visibility = '';
  box = node.getBoundingClientRect();

  // The board moving under a popup pinned to the screen is the same problem the
  // context menu closes on a wheel for, and a pan or a fling is the commoner way
  // to cause it here: the rectangle this offer is about would slide out from
  // under its own button. Unsubscribed on close, so a board being panned with no
  // offer up pays nothing.
  offView = vp?.onChange(close) || null;
}
