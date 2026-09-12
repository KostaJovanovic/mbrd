// The corner readouts and three control clusters on the glass: zoom
// percentage/buttons, undo/redo, the coordinate/size readout, autosave mark,
// and the snap flag published to CSS. Routes clicks through `cmds` rather
// than state directly, so keyboard, menu and these buttons agree. `vp`/`cmds`
// are injected by initHud() to avoid an import cycle with commands.ts.

import { el } from '../util.ts';
import { cue } from '../cuelume/engine.ts';
import { formatLength, formatSize } from '../measure.ts';
import { board, bus, selection, byId, historyState, isContent } from '../state.ts';
import { MIN_ZOOM, MAX_ZOOM, BASE_ZOOM, zoomMs, travelMs } from '../canvas/viewport.ts';
import type { Viewport } from '../canvas/viewport.ts';

/** The three Viewport fields this module reads, beside its methods. Now
 *  restates what Viewport itself declares; could be removed. */
type HudViewport = Viewport & {
  pan: { x: number, y: number },
  zoom: number,
  zoomLocked: boolean,
};

/** The command surface, as this module sees it: names it presses, nothing
 *  else - same bargain as ui/toolbar.ts. */
export interface HudCommands {
  fit: () => void;
  recenter: () => void;
  lockZoom: () => void;
  undo: () => void;
  redo: () => void;
}

const ZOOM_STEP = 1.3;
/** The autosave mark's dwell. Restarted rather than stacked - see below. */
const SAVED_MS = 1500;

// el() below is read with `!`: these ids are static markup in index.html, so
// an absent one is a broken build, not a state to handle. Same reasoning for
// the `e.target as Element` casts in the delegated handlers below - the
// click target is always an Element, closest() just checks an ancestor.
let vp: HudViewport | null = null;
/** The readout last written, so a pan does not rewrite it sixty times a second. */
let zoomShown = '';
/** The same for the coordinate pair, which fires at the pointer's rate. */
let xyShown = '';
let savedTimer = 0;

/** Wire the glass controls and subscribe the readouts. Called once from
 *  main.ts, after the viewport exists and the panel is built. */
export function initHud(viewport: HudViewport, cmds: HudCommands) {
  vp = viewport;

  el('zoom-ctl')!.addEventListener('click', e => {
    // SAFETY: see the note above `vp` - click target is always an Element.
    const btn = (e.target as Element).closest<HTMLElement>('[data-zoom]');
    if (!btn) return;
    cue('pick');
    switch (btn.dataset.zoom) {
      case 'in':    vp!.zoomBy(ZOOM_STEP, zoomMs()); break;
      case 'out':   vp!.zoomBy(1 / ZOOM_STEP, zoomMs()); break;
      // Back to 100%, without moving the view.
      case 'reset': vp!.viewTo(vp!.pan, BASE_ZOOM, travelMs()); break;
      case 'fit':   cmds.fit(); break;
      case 'home':  cmds.recenter(); break;
      case 'lock':  cmds.lockZoom(); break;
    }
  });

  // The phone's add bar used to be wired here with its own data-add switch.
  // It moved to ui/toolbar.ts as ordinary data-cmd buttons; the one-off is gone.

  // Undo/redo live here, not ui/drawer.ts: they share the corner with the bin
  // but not its subject. Routed through cmds, not state's undo() directly, so
  // keyboard, context menu and these buttons all press the same button.
  el('history-ctl')!.addEventListener('click', e => {
    // SAFETY: as at the zoom controls above.
    const btn = (e.target as Element).closest<HTMLElement>('[data-history]');
    if (!btn) return;
    // Press sound here; history.ts plays `fall`/`rise` for the result - the
    // same two-sound shape every other button on the glass has.
    cue('pick');
    if (btn.dataset.history === 'undo') cmds.undo(); else cmds.redo();
  });

  /**
   * The autosave, acknowledged with a quiet mark, not a toast - saves happen
   * about once a second, and a toast per save would talk over the work just
   * to say nothing is wrong. Timer restarts rather than stacks, so a run of
   * edits holds the mark up instead of flickering once per save.
   */
  bus.on('autosaved', () => {
    const mark = el('saved')!;
    mark.classList.add('is-on');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => mark.classList.remove('is-on'), SAVED_MS);
  });

  bus.on('history', paintHistory);
  // A board arriving replaces the stacks wholesale (clearHistory() announces
  // it), but 'board:load' also covers a fresh New.
  bus.on('board:load', paintHistory);
  paintHistory();

  bus.on('items', paintCount);
  // Right-hand slot is count or selected item's size, so all three things
  // that can change which applies repaint it: items, selection, measurement.
  bus.on('selection', paintCount);
  bus.on('geom', paintCount);
  bus.on('settings', paintCount);

  el('viewport')!.addEventListener('pointermove', e => {
    const p = vp!.toWorld(e.clientX, e.clientY);
    const { scale, units } = board.settings;
    const text =
      `${px(p.x)}, ${px(p.y)} px · ${formatLength(p.x, scale, units)}, ${formatLength(p.y, scale, units)}`;
    // Keyed and returned like paintZoom() below. Fires at pointer rate (up to
    // 100/s on a trackpad); most events match the already-rounded string, so
    // skip the layout write when nothing changed.
    if (text === xyShown) return;
    xyShown = text;
    el('hud-xy')!.textContent = text;
  }, { passive: true });
}

/**
 * What undo/redo can do, and what they would do. The label matters, not just
 * the enabled state - "Undo Add 3 items" lets you confirm it's the action
 * you meant before pressing it.
 */
function paintHistory() {
  const state = historyState();
  for (const btn of el('history-ctl')!.querySelectorAll<HTMLButtonElement>('[data-history]')) {
    // Markup carries exactly two values; reading "not undo" as redo mirrors
    // the click handler above.
    const kind = btn.dataset.history === 'undo' ? 'undo' : 'redo';
    const label = state[kind];
    btn.disabled = !label;
    const verb = kind === 'undo' ? 'Undo' : 'Redo';
    const keys = kind === 'undo' ? 'Ctrl+Z' : 'Ctrl+Shift+Z';
    btn.title = label ? `${verb} ${label}  ${keys}` : `Nothing to ${kind}`;
  }
}

/** The zoom as the corner prints it. Its own function because the lock's toast
 *  quotes the same number, and two roundings of one value is two answers. */
export function zoomText() {
  // The one place the scale becomes a percentage. vp.zoom is the true
  // world-to-screen scale; BASE_ZOOM is the scale the corner calls 100%.
  const pct = (vp!.zoom / BASE_ZOOM) * 100;
  // Below 10% a rounded percentage flickers between 6 and 7 as you pinch, so
  // give the small end a decimal instead.
  return (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%';
}

export function paintZoom(force = false) {
  const text = zoomText();
  const fixed = vp!.isMobile;
  const locked = vp!.zoomLocked || fixed;
  // Locked, the two ends stop being the reason a button is dead - the lock is.
  const maxed = locked || vp!.zoom >= MAX_ZOOM - 1e-6;
  const mined = locked || vp!.zoom <= MIN_ZOOM + 1e-9;
  // Runs on every view change, but a pan can't move the zoom, so most calls
  // during a drag match the key already on screen - skip the write.
  //
  // Buttons are in the key, not just the readout, because the readout is
  // rounded and they aren't: near the floor it reads "2.0%" well before
  // arriving, so text alone would leave a button enabled past its limit.
  const key = text + (maxed ? '+' : '') + (mined ? '-' : '') +
    (vp!.zoomLocked ? 'L' : '') + (fixed ? 'M' : '');
  if (key === zoomShown && !force) return;
  zoomShown = key;
  el('zoom-level')!.textContent = text;
  for (const btn of el('zoom-ctl')!.querySelectorAll<HTMLButtonElement>('[data-zoom]')) {
    if (btn.dataset.zoom === 'in') btn.disabled = maxed;
    if (btn.dataset.zoom === 'out') btn.disabled = mined;
    // The readout is a button too (resets to 100%), so it's dead under the
    // lock like its neighbors. Fit and recenter stay live - under a held
    // zoom they're journeys, not zooms, and still useful when you're lost.
    if (btn.dataset.zoom === 'reset') btn.disabled = locked;
  }
  // Both are <button>s in index.html; asserted below since `disabled` on
  // anything else would fail silently rather than as a type error.
  const fit = el('zoom-ctl')!.querySelector<HTMLButtonElement>('[data-zoom="fit"]')!;
  fit.title = fixed ? 'Back to the top  F'
    : locked ? 'Bring everything into view  F' : 'Zoom to fit  F';
  fit.setAttribute('aria-label', fixed ? 'Back to the top'
    : locked ? 'Bring everything into view' : 'Zoom to fit');
  // SAFETY: #zoom-lock is a <button>, like the ids read with `!` above -
  // typed here because `disabled` needs it.
  const lock = el('zoom-lock') as HTMLButtonElement;
  lock.disabled = fixed;
  lock.setAttribute('aria-pressed', String(vp!.zoomLocked));
  lock.setAttribute('aria-label', fixed ? 'Zoom fixed to Mobile board width'
    : vp!.zoomLocked ? 'Unlock zoom' : 'Lock zoom');
  lock.title = fixed ? `Mobile board always fits its ${board.settings.mobileColumns}-column width`
    : vp!.zoomLocked ? `Zoom held at ${text}` : 'Lock the zoom';
}

/**
 * Snapping, published to CSS. A snapped board stands its cards square - a
 * stylesheet decision, not a renderer's, so the flag goes on the root
 * element like data-palette and data-whimsy.
 */
export function paintSnap() {
  document.documentElement.toggleAttribute('data-snap', !!board.settings.snap);
}

/**
 * Both readings, always: board units first (what a nudge moves, what the
 * grid counts) then the real measurement (what you'd hold a tape to). The
 * physical reading briefly replaced raw units when scale shipped, but hiding
 * the board's own coordinates made the app lie about what it is.
 */
const px = (n: number) => Math.round(n);

/**
 * The right-hand half of the readout: how many things, or - when exactly one is
 * selected - how big that one is.
 *
 * One, not many: the size of a single item is a fact about a thing you are
 * looking at, and the combined size of nine is a fact about a bounding box
 * nobody drew. The count comes back the moment the selection is anything else,
 * so the slot never goes empty.
 */
export function paintCount() {
  // The single-selection readout first, so its early return does not pay for the
  // whole-board count below - which it never uses.
  if (selection.size === 1) {
    const it = byId([...selection][0]);
    if (it) {
      const { scale, units } = board.settings;
      el('hud-count')!.textContent =
        `${px(it.w)} × ${px(it.h)} px · ${formatSize(it.w, it.h, scale, units)}`;
      return;
    }
  }
  // Furniture is not things, and neither is a fence. A blank board that
  // announced "3 things" would be counting its own scaffolding, and the number
  // is meant to answer "how much have I put here" - which on a new board is
  // none. The hints were excluded here from the start and the Desktop title card
  // was not, so every count on Desktop read one high and a brand-new board
  // opened saying "1 thing"; isContent() is hasContent()'s own rule, asked from
  // one place so a fourth type cannot drift apart from it again.
  const n = board.items.reduce((t, i) => t + (isContent(i) ? 1 : 0), 0);
  el('hud-count')!.textContent = n === 0 ? 'nothing yet' : n + (n === 1 ? ' thing' : ' things');
}
