// Quality dial wiring. quality.ts is the setting; this connects it to the DOM.
// armQuality() writes the level onto <html> (safe before board is up).
// watchQuality() subscribes to changes (needs canvas/items.ts initialised).
// A change does a full remount — shadows and display sizes are decided at build time.

import { bus } from '../state.ts';
import { initQuality, onQuality, qualityLevel, quality } from '../quality.ts';
import { resetItems } from '../canvas/items.ts';
import { refreshStills } from '../canvas/stills.ts';
import { refreshHires } from '../canvas/hires.ts';
import { paintPanel } from './panel.ts';

export function armQuality() {
  initQuality();
  paintLevel();
}

export function watchQuality() {
  onQuality(() => {
    paintLevel();
    resetItems();
    refreshStills();
    // resetItems() rebuilds every card on its display copy, so the sweep's
    // zoom/count guard has to be told the answer it cached is stale.
    refreshHires();
    bus.emit('settings', 'web');
    paintPanel();
  });
}

// Individual flags so CSS can override per-flag (e.g. shadows on Light).
function paintLevel() {
  const root = document.documentElement;
  root.dataset.quality = qualityLevel();
  root.dataset.qShadows = quality.shadows ? 'on' : 'off';
  root.dataset.qBlur = quality.blur ? 'on' : 'off';
  root.dataset.qAnim = quality.anim ? 'on' : 'off';
  root.dataset.qGrain = quality.grain ? 'on' : 'off';
}
