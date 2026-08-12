// The quality dial, connected to the things it moves.
//
// quality.js is the setting; this is the wiring. Two halves, and the split is
// about when each can run:
//
//   armQuality()   reads the saved level and writes it onto <html>, which is
//                  what the [data-quality] blocks in tokens.css and the CSS key
//                  off. Called before the panel is painted, so a phone left on
//                  Light does not flash a blurred, shadowed board first. The
//                  inline script in index.html does the same thing one moment
//                  earlier, for the same reason it already does it for whimsy.
//
//   watchQuality() subscribes to changes. Called after canvas/items.js is up,
//                  because a change has to rebuild the board and resetItems()
//                  needs the shadow layer it makes.
//
// A change is answered with a full remount rather than with seven surgical
// updates, and that is deliberate. Two of the flags are decided at build time -
// whether a card gets a shadow twin at all, and what long edge its display copy
// was made at - so nothing short of building the cards again can honour them.
// resetItems() already clears the display cache on the way through, which is
// also what stops a copy made at 1024px being served forever after the dial goes
// back up. It happens when somebody moves a dial, which is rare and visible.

import { bus } from '../state.ts';
import { initQuality, onQuality, qualityLevel, quality } from '../quality.ts';
import { resetItems } from '../canvas/items.ts';
import { refreshStills } from '../canvas/stills.ts';
import { paintPanel } from './panel.ts';

/** Read the setting and put it on <html>. Safe to call before the board is up. */
export function armQuality() {
  initQuality();
  paintLevel();
}

/** Answer every later change. Needs canvas/items.js to have been initialised. */
export function watchQuality() {
  onQuality(() => {
    paintLevel();
    resetItems();
    refreshStills();
    // canvas/web.js rebuilds on this key and nothing else does work for it, so
    // it is the honest signal that the threads may have come or gone.
    bus.emit('settings', 'web');
    paintPanel();
  });
}

/**
 * The level, and the three flags CSS can act on by itself.
 *
 * Written out one attribute each rather than left to the level, because a flag
 * can be pinned by hand: somebody on Light who wants their shadows back has to
 * outrank the stop they are standing on, and `[data-q-shadows="on"]` does that
 * where a level attribute cannot. The stylesheets carry a
 * `:not([data-q-shadows])` twin of each rule for the moment before this runs,
 * when the inline guard in index.html has set the level and nothing else.
 */
function paintLevel() {
  const root = document.documentElement;
  root.dataset.quality = qualityLevel();
  root.dataset.qShadows = quality.shadows ? 'on' : 'off';
  root.dataset.qBlur = quality.blur ? 'on' : 'off';
  root.dataset.qAnim = quality.anim ? 'on' : 'off';
}
