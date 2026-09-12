// The ground: grid, grain, paper sheet and Mobile frame — the four layers
// under the cards. One repaint call and one look-cache invalidation, so
// callers do not duplicate the sequence or miss a reset.

import { paintGrid, resetGridInk } from './grid.ts';
import { paintGrain, resetGrain } from './grain.ts';
import { paintPaper } from './paper.ts';
import { paintMobileFrame } from './mobile-frame.ts';
import { resetModelInk } from './model.ts';
import type { Viewport } from './viewport.ts';

/** Paint every layer under the cards. Each sub-painter early-returns if off. */
export function repaintGround(vp: Viewport): void {
  paintGrid(vp);
  paintGrain(vp);
  paintPaper();
  paintMobileFrame();
}

/** Invalidate cached getComputedStyle readings. Call before repaint on look change. */
export function forgetLookInk(): void {
  resetGridInk();
  resetModelInk();
  resetGrain();
}
