// @ts-nocheck - TypeScript migration debt, not a judgement about this file.
//
// The tree was renamed from .js to .ts mechanically, which moved 104 modules in
// one step and annotated none of them. This module is carried unchecked so that
// npm run typecheck stays green and keeps meaning something, rather than going
// red and being ignored. Converting this module IS deleting this block and
// fixing what tsc then says - tests/ts-debt.test.js holds the count and lets it
// only fall.
// The Mobile strip's sheet and masthead, in screen space.
//
// Both used to be positioned by canvas/viewport.js, from five custom properties
// written onto #viewport on every frame of every scroll. #viewport is an
// ancestor of #world, and custom properties are inherited, so changing one of
// them invalidated the computed style of the whole subtree - every mounted card
// and everything inside it. That is the same cost --iz is documented as
// carrying in viewport.js, paid on the one layout that has no zoom at all and
// therefore never writes --iz. Two elements read those properties; the entire
// board paid for them.
//
// So nothing here touches #viewport. The two elements are treated differently
// because they move differently:
//
//   The sheet does not move. It spans the whole board, which on a long feed is
//   tens of thousands of pixels tall, so scrolling through the middle of one
//   leaves both of its ends off screen and what is actually visible is a band
//   of constant width at a constant x running the full height of the window -
//   the same rectangle, frame after frame. Clipping it to the viewport and
//   comparing against what was last written therefore costs nothing on the
//   frames that matter and writes only at the two ends. canvas/grid.js's
//   inkBox()/placeInk() pair is the same idea for the lattice, including
//   squaring off the radius on an edge that has scrolled away, and this follows
//   it deliberately rather than inventing a second way to say it.
//
//   The masthead does move, for as long as it is on screen, and there is no
//   caching that away. But it is small and bounded - mobileHeaderHeight() is
//   the board width over 1.5 - so it can be promoted and moved by transform,
//   which is a compositor move rather than a layout.
//
// The surround tint moved out of here entirely. It used to be a 100vmax spread
// box-shadow on the sheet, which meant a full-screen repaint every time the
// sheet moved; it is now #mobile-surround, a static wash under an opaque sheet.
// The picture is identical - a shadow is clipped to outside its element's
// border box, radius included, and a wash covered by an opaque rounded sheet is
// clipped to exactly the same place - and this one never moves.

import { mobilePerfFlags } from './viewport.ts';

let vp = null;
let frameEl = null;
let mastEl = null;

/** What was last written, so a scroll through the middle of a board writes none. */
let lastSheet = '';
let lastMast = '';
/**
 * ...and the masthead's travel, which starts as null rather than as the empty
 * string. The empty string is a real value here - it is what an off-screen
 * masthead is written as - so a cache that began at it would skip the first
 * pass over a board opened anywhere but the top stop, and leave the band
 * standing at the top of the window with no transform on it.
 */
let lastShift = null;
/** Whether the last pass was a Mobile one, so leaving the mode drops the cache. */
let wasMobile = null;

export function initMobileFrame(viewport) {
  vp = viewport || null;
  if (!vp || !vp.el) return;
  // Queried off the viewport rather than the document, and tolerant of their
  // absence, for the same reason canvas/grid.js's ensureCanvas() is: the render
  // harnesses mount a bare #viewport without the rest of the page around it.
  // #mobile-surround needs no reference at all - it is a static wash that canvas.css
  // shows in Mobile and hides everywhere else, and no frame ever touches it.
  frameEl = vp.el.querySelector(':scope > #mobile-board-frame');
  mastEl = vp.el.querySelector(':scope > #mobile-board-header');
  if (!frameEl || !mastEl) return;
  // Straight onto the change event rather than through a throttle of its own -
  // the event is already emitted from inside the viewport's rAF, so this paints
  // on the same frame the grid and the axes do. See the same note in paper.js.
  vp.onChange(draw);
  draw();
}

/** Exported for main.js's boot sequence, which paints once before the first frame. */
export const paintMobileFrame = () => draw();

function draw() {
  if (!vp || !frameEl || !mastEl) return;

  if (!vp.isMobile) {
    // The CSS hides all three off Mobile, so there is nothing to undo - only a
    // cache to drop, so that coming back writes the geometry afresh rather than
    // trusting numbers taken before the mode changed.
    if (wasMobile !== false) { wasMobile = false; lastSheet = lastMast = ''; lastShift = null; }
    return;
  }
  wasMobile = true;

  // The upper bound on what any of this can be costing - see mobilePerfFlags.
  // main.js's setter adds the class that hides the two elements; this skips the
  // writes that would otherwise still be happening behind it.
  if (!mobilePerfFlags.chrome) return;

  const r = vp.mobileScreenRect();
  const headerH = vp.mobileHeaderPx();

  // The dev A/B for what this module replaced. Off in every shipped board.
  if (mobilePerfFlags.legacyVars) {
    vp.el.style.setProperty('--mobile-board-left', `${r.left}px`);
    vp.el.style.setProperty('--mobile-board-width', `${r.width}px`);
    vp.el.style.setProperty('--mobile-board-top', `${r.top}px`);
    vp.el.style.setProperty('--mobile-board-bottom', `${r.bottom}px`);
    vp.el.style.setProperty('--mobile-header-height', `${headerH}px`);
  }

  paintSheet(r);
  paintMasthead(r, headerH);
}

/**
 * The sheet's box on the screen, clipped to the window.
 *
 * Clipped rather than left to overflow, because the whole point is that the
 * answer stops changing: an unclipped sheet is a box whose top edge moves with
 * every frame of a scroll, and a clipped one is the same rectangle for the
 * whole middle of a board. The browser was throwing the overflow away anyway -
 * #viewport carries `contain: layout paint` - so nothing is lost by not
 * describing it.
 *
 * Only a real board edge is rounded. When an edge has scrolled outside the
 * window the box must stay square there instead of inventing a second pair of
 * corners; this is the rule inkBox() states for the lattice, and the two have
 * to agree or the sheet and the marks drawn on it round differently.
 *
 * Pure, and exported, because the two stops and the middle are three different
 * answers with three different roundings and that is worth asserting without
 * standing up a browser to look at it.
 */
export function sheetBox(r, width, height) {
  const x = Math.max(0, r.left);
  const y = Math.max(0, r.top);
  return {
    x,
    y,
    w: Math.max(0, Math.min(width, r.left + r.width) - x),
    h: Math.max(0, Math.min(height, r.bottom) - y),
    topRadius: r.top >= 0 ? 'var(--radius)' : '0px',
    bottomRadius: r.bottom <= height ? 'var(--radius)' : '0px',
  };
}

/**
 * Where the masthead stands, and whether it is worth writing at all.
 *
 * The band sits on the board's top edge, so its own top is that edge less its
 * height. Nothing is written once it has scrolled away: a transform on a hidden
 * layer is still a transform the compositor has to carry, and the masthead is
 * off screen for all but the first screenful of a long board.
 *
 * Pure for the same reason as sheetBox() - "does the band go away when it
 * leaves the screen" is a question with a right answer at each end of a board.
 */
export function mastShift(r, headerH, height) {
  const bottom = r.top;
  const visible = bottom > 0 && bottom - headerH < height;
  return { visible, y: bottom - headerH };
}

function paintSheet(r) {
  const box = sheetBox(r, vp.width, vp.height);
  const next = `${box.x},${box.y},${box.w},${box.h},${box.topRadius},${box.bottomRadius}`;
  if (next === lastSheet) return;
  lastSheet = next;

  frameEl.style.left = `${box.x}px`;
  frameEl.style.top = `${box.y}px`;
  frameEl.style.width = `${box.w}px`;
  frameEl.style.height = `${box.h}px`;
  frameEl.style.borderRadius =
    `${box.topRadius} ${box.topRadius} ${box.bottomRadius} ${box.bottomRadius}`;
}

/**
 * The masthead, moved by transform on a layer of its own.
 *
 * Its width, height and the two custom properties #mobile-board-title reads are
 * written onto the masthead itself rather than onto #viewport. The title is a
 * child of it, so inheritance still reaches - and #viewport goes back to being
 * something a view frame never writes to, which is the point of the file.
 *
 * The geometry is cached separately from the travel because they change on
 * completely different clocks: the size answers to the window and the board's
 * column count, the position to every frame of a scroll.
 */
function paintMasthead(r, headerH) {
  const box = `${r.left},${r.width},${headerH}`;
  if (box !== lastMast) {
    lastMast = box;
    mastEl.style.left = `${r.left}px`;
    mastEl.style.width = `${r.width}px`;
    mastEl.style.height = `${headerH}px`;
    mastEl.style.setProperty('--mobile-board-width', `${r.width}px`);
    mastEl.style.setProperty('--mobile-header-height', `${headerH}px`);
  }

  const { visible, y } = mastShift(r, headerH, vp.height);
  const shift = visible ? `translateY(${y.toFixed(2)}px)` : '';
  if (shift === lastShift) return;
  lastShift = shift;
  mastEl.style.visibility = visible ? '' : 'hidden';
  if (visible) mastEl.style.transform = shift;
}
