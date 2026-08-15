// The ground: everything on the board that is not an item.
//
// The grid, the grain, the paper sheet and the Mobile frame are four painters
// with nothing in common except that they are all *under* the cards, and that
// they always run together. This module is the one call that runs them, and the
// one call that gives back what they resolved out of the look.
//
// ── Why it exists ──
//
// It was two sequences copied by hand. main.ts and ui/board-actions.ts each held
// the same four paints in the same order - boot and Reload board are the same
// instruction to the same surface - and ui/board-actions.ts's header had already
// named the fix: "the shape that would fix it is a repaintBoard() owned by
// canvas/ - one call standing for the four paints that always run together - and
// every import added here makes that shape more expensive to reach, because it
// is one more caller to find." This is that function. The knowledge of which
// four, and in which order, is now in one place instead of two.
//
// The reset half is the more interesting one, because the copies had already
// come apart. Three callers each held their own list:
//
//   main.ts, on 'board:load'   resetGridInk
//   ui/board-actions.ts        resetGridInk + resetModelInk
//   main.ts, on a look change  resetGridInk + resetModelInk + resetGrain
//
// Those are three answers to one question. Each of the three modules caches a
// value it read out of the look with getComputedStyle - the grid's colours and
// dot size, the ink a model card's still is stamped in, whether --grain resolves
// to anything at all - and each exports a reset whose own comment is some
// wording of *the look changed*. canvas/model.ts's says it outright: "The twin
// of resetGridInk()." Twins that two of the three callers only had one of.
//
// So forgetLookInk() is all three, and the two sites that were missing one are
// fixed by arriving here rather than by being edited. Opening a board that
// brings its own look now gives back the model ink and the grain strength along
// with the grid's colours, where before it gave back only the grid's and left
// every model card stamped in the colour of the board you had open before.
//
// ── What is deliberately not here ──
//
// **resetItems, resetModels and resetWeb.** They look like they belong - Reload
// board calls all three next to the two above - but they answer a different
// question. Forgetting an ink is giving back a *cached reading of the look*, and
// it costs nothing: the next paint reads it again. Rebuilding the item layer
// throws away every mounted node, and whether that is owed depends on what
// happened, not on the look. 'board:load' rebuilds items and models because the
// items are different ones and does *not* reset the web, because loadBoard()
// emits 'board:load' and canvas/web.ts is subscribed to it; Reload board resets
// the web precisely because nothing about the items changed and a stored route
// would otherwise survive the one command whose job is to put a drifted board
// right. Those two callers differ because the two situations differ, which is
// the opposite of the ink lists, where they differed because nobody had checked.
// Folding them in here would have made one of the two wrong.
//
// **vp.apply().** Both callers do it after the four paints, and neither does it
// *because* of them - the camera is not part of the ground.
//
// ── What this module may not become ──
//
// A place to hang "everything the board does on a big change". It has exactly
// two exports and both are named after a question rather than after a moment;
// the moment a third arrives called something like refreshEverything(), the
// callers stop being able to say what they meant and this is main.ts again with
// a different name on it.

import { paintGrid, resetGridInk } from './grid.ts';
import { paintGrain, resetGrain } from './grain.ts';
import { paintPaper } from './paper.ts';
import { paintMobileFrame } from './mobile-frame.ts';
import { resetModelInk } from './model.ts';
import type { Viewport } from './viewport.ts';

/**
 * Paint every layer under the cards.
 *
 * The order is the one both callers already used and it is not arbitrary: the
 * grid is a screen-space layer on #viewport, the grain sits over it, the paper
 * outline is drawn against the same origin, and the Mobile frame is placed last
 * because it is the only one of the four that is a sheet rather than a wash and
 * has to land on top of what it frames.
 *
 * Cheap enough to be the answer to "something changed and I am not sure what":
 * the grid early-returns when the setting is off, the grain when the token
 * resolves to nothing, and both of the last two when their layout is not the
 * one on screen.
 */
export function repaintGround(vp: Viewport): void {
  paintGrid(vp);
  paintGrain(vp);
  paintPaper();
  paintMobileFrame();
}

/**
 * Give back every value the ground resolved out of the look.
 *
 * Call it whenever the look changes underneath the board - a slider drag, a
 * palette, a board arriving with its own tokens - and before the repaint that
 * follows. Three module-level caches, all of them a getComputedStyle nobody
 * wants to pay for per frame, all of them stale for the same reason.
 *
 * Idempotent and free. It nulls three variables; nothing is read back until
 * something paints, so calling it and then not painting costs nothing and
 * painting without having called it is the bug it exists to prevent.
 */
export function forgetLookInk(): void {
  resetGridInk();
  resetModelInk();
  resetGrain();
}
