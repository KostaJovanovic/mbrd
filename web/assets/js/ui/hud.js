// The corner readouts and the three control clusters on the glass.
//
// Everything the board says about itself without being asked: the zoom
// percentage and its buttons, the undo/redo pair and what they would undo, the
// coordinate and size readout, the autosave mark, and the snap flag published
// to CSS. Lifted out of main.js as one piece because it is one piece - every
// function here writes to `#hud` or to a control beside it, and nothing here
// decides anything.
//
// The three click surfaces live here rather than in ui/sidebar.js because they
// are chrome on the glass and not part of the panel, and they all route through
// `cmds` rather than calling state directly - the keyboard, the context menu and
// these buttons press the same button.
//
// `vp` and `cmds` are handed in by initHud() rather than imported: the viewport
// because it is built at boot, and the command surface because commands.js
// imports *this* module (for paintZoom) and the arrow may only go one way.

import { el } from '../util.js';
import { formatLength, formatSize } from '../measure.js';
import { board, bus, selection, byId, historyState, isFurniture } from '../state.js';
import { MIN_ZOOM, MAX_ZOOM, BASE_ZOOM, zoomMs, travelMs } from '../canvas/viewport.js';

const ZOOM_STEP = 1.3;
/** The autosave mark's dwell. Restarted rather than stacked - see below. */
const SAVED_MS = 1500;

let vp = null;
/** The readout last written, so a pan does not rewrite it sixty times a second. */
let zoomShown = '';
let savedTimer = 0;

/**
 * Wire the glass controls and subscribe the readouts.
 *
 * Called once, from main.js, after the viewport exists and the panel has been
 * built. Everything it touches is static markup in index.html.
 */
export function initHud(viewport, cmds) {
  vp = viewport;

  el('zoom-ctl').addEventListener('click', e => {
    const btn = e.target.closest('[data-zoom]');
    if (!btn) return;
    switch (btn.dataset.zoom) {
      case 'in':    vp.zoomBy(ZOOM_STEP, zoomMs()); break;
      case 'out':   vp.zoomBy(1 / ZOOM_STEP, zoomMs()); break;
      // Back to 100%, without moving the view.
      case 'reset': vp.viewTo(vp.pan, BASE_ZOOM, travelMs()); break;
      case 'fit':   cmds.fit(); break;
      case 'home':  cmds.recenter(); break;
      case 'lock':  cmds.lockZoom(); break;
    }
  });

  // The phone's add bar (index.html, and the width query in the stylesheets).
  // Wired here beside the zoom controls rather than in ui/sidebar.js, because it
  // is chrome on the glass and not part of the panel - the same reason those
  // are here.
  el('add-bar').addEventListener('click', e => {
    const btn = e.target.closest('[data-add]');
    if (!btn) return;
    if (btn.dataset.add === 'note') cmds.addNote();
    else cmds.addFiles();
  });

  // Undo and redo on the glass, next to the bin. Here beside the zoom controls
  // and the add bar rather than in ui/trash.js: they share that corner but not
  // its subject, and the bin module has no business knowing about the history.
  //
  // Through cmds, not through state's undo() directly - the keyboard, the
  // context menu and these three now all press the same button.
  el('history-ctl').addEventListener('click', e => {
    const btn = e.target.closest('[data-history]');
    if (!btn) return;
    if (btn.dataset.history === 'undo') cmds.undo(); else cmds.redo();
  });

  /**
   * The autosave, acknowledged.
   *
   * A mark rather than a toast, and that is the whole design decision here. The
   * board saves itself about once a second while you are working, and a toast
   * per save would be the interface talking over the work continuously to
   * report that nothing is wrong. This appears where the board's other state
   * lives, says one word, and leaves.
   *
   * The timer is restarted rather than stacked, so a run of edits holds the
   * mark up throughout instead of flickering once per save.
   */
  bus.on('autosaved', () => {
    const mark = el('saved');
    mark.classList.add('is-on');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => mark.classList.remove('is-on'), SAVED_MS);
  });

  bus.on('history', paintHistory);
  // A board arriving replaces the stacks wholesale, and clearHistory() announces
  // that - but 'board:load' is also what a fresh New has to be heard through.
  bus.on('board:load', paintHistory);
  paintHistory();

  bus.on('items', paintCount);
  // The readout's right-hand slot is the count *or* the selected item's real
  // size, so the three things that can change which of those it is all repaint
  // it: what is on the board, what is picked, and how the board is measured.
  bus.on('selection', paintCount);
  bus.on('geom', paintCount);
  bus.on('settings', paintCount);

  el('viewport').addEventListener('pointermove', e => {
    const p = vp.toWorld(e.clientX, e.clientY);
    const { scale, units } = board.settings;
    el('hud-xy').textContent =
      `${px(p.x)}, ${px(p.y)} px · ${formatLength(p.x, scale, units)}, ${formatLength(p.y, scale, units)}`;
  }, { passive: true });
}

/**
 * What the pair can do, and what it would do.
 *
 * The label is the point of naming it rather than only enabling it: "Undo Add 3
 * items" tells you whether the thing you are about to take back is the thing
 * you meant, which on a board where the last four actions were drags is the
 * only way to know without trying it.
 */
export function paintHistory() {
  const state = historyState();
  for (const btn of el('history-ctl').querySelectorAll('[data-history]')) {
    const kind = btn.dataset.history;
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
  const pct = (vp.zoom / BASE_ZOOM) * 100;
  // Below 10% a rounded percentage flickers between 6 and 7 as you pinch, so
  // give the small end a decimal instead.
  return (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%';
}

export function paintZoom(force = false) {
  const text = zoomText();
  const fixed = vp.isMobile;
  const locked = vp.zoomLocked || fixed;
  // Locked, the two ends stop being the reason a button is dead - the lock is.
  const maxed = locked || vp.zoom >= MAX_ZOOM - 1e-6;
  const mined = locked || vp.zoom <= MIN_ZOOM + 1e-9;
  // This runs on every view change, and a pan is a view change that cannot
  // possibly have moved the zoom - so on the whole of a drag the answer is the
  // corner already on screen, and writing it again is a layout per frame for
  // nothing.
  //
  // The two buttons are in the key rather than behind the readout, because the
  // readout is rounded and they are not: the last hundredth of the way to the
  // floor reads as 2.0% for a while before it arrives, and hanging their state
  // off the text alone would leave the button enabled at the end of its travel.
  const key = text + (maxed ? '+' : '') + (mined ? '-' : '') +
    (vp.zoomLocked ? 'L' : '') + (fixed ? 'M' : '');
  if (key === zoomShown && !force) return;
  zoomShown = key;
  el('zoom-level').textContent = text;
  for (const btn of el('zoom-ctl').querySelectorAll('[data-zoom]')) {
    if (btn.dataset.zoom === 'in') btn.disabled = maxed;
    if (btn.dataset.zoom === 'out') btn.disabled = mined;
    // The readout is a button too - it goes back to 100% - so under the lock it
    // is as dead as the two beside it, and says so rather than sitting there
    // looking pressable. Fit and Back to 0,0 stay live: with the zoom held they
    // are journeys rather than zooms, which is still the thing you want when
    // you have lost the board at a magnification you have chosen to keep.
    if (btn.dataset.zoom === 'reset') btn.disabled = locked;
  }
  const fit = el('zoom-ctl').querySelector('[data-zoom="fit"]');
  fit.title = fixed ? 'Back to the top  F'
    : locked ? 'Bring everything into view  F' : 'Zoom to fit  F';
  fit.setAttribute('aria-label', fixed ? 'Back to the top'
    : locked ? 'Bring everything into view' : 'Zoom to fit');
  const lock = el('zoom-lock');
  lock.disabled = fixed;
  lock.setAttribute('aria-pressed', String(vp.zoomLocked));
  lock.setAttribute('aria-label', fixed ? 'Zoom fixed to Mobile board width'
    : vp.zoomLocked ? 'Unlock zoom' : 'Lock zoom');
  lock.title = fixed ? `Mobile board always fits its ${board.settings.mobileColumns}-column width`
    : vp.zoomLocked ? `Zoom held at ${text}` : 'Lock the zoom';
}

/**
 * Snapping, published to CSS.
 *
 * The setting has a look as well as a behaviour: a snapped board stands its
 * cards up square, because a lattice is about edges and a lean spoils the one
 * thing lining everything up was for. That is a stylesheet's decision to make,
 * not a renderer's, so the flag goes on the root element and the stylesheets
 * take it from there - the same shape as data-palette and data-whimsy.
 */
export function paintSnap() {
  document.documentElement.toggleAttribute('data-snap', !!board.settings.snap);
}

/**
 * Both readings, always, in that order.
 *
 * Board units first and the real measurement after, because they answer two
 * different questions and neither replaces the other. The units are what the
 * board is actually made of - what a nudge moves, what the grid step counts,
 * what a size typed anywhere else in the app means - and for a board that is
 * not about physical objects they are the only meaningful number there is. The
 * real measurement is the one you can hold a tape up to.
 *
 * They were briefly not both here: the physical reading replaced the raw floats
 * when the scale feature went in, on the argument that an offset from an origin
 * nobody chose tells you nothing. That was half right. Rounded and labelled,
 * the raw pair is the board's own coordinate system, and hiding it made the app
 * lie about what it is - a canvas of unitless floats with a lens over it.
 */
const px = n => Math.round(n);

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
  // Furniture is not things. A blank board that announced "3 things" would be
  // counting its own scaffolding, and the number is meant to answer "how much
  // have I put here" - which on a new board is none. The hints were excluded
  // here from the start and the Desktop title card was not, so every count on
  // Desktop read one high and a brand-new board opened saying "1 thing";
  // isFurniture() is hasContent()'s own rule, asked from one place so a fourth
  // type cannot drift apart from it again.
  const n = board.items.reduce((t, i) => t + (isFurniture(i) ? 0 : 1), 0);
  if (selection.size === 1) {
    const it = byId([...selection][0]);
    if (it) {
      const { scale, units } = board.settings;
      el('hud-count').textContent =
        `${px(it.w)} × ${px(it.h)} px · ${formatSize(it.w, it.h, scale, units)}`;
      return;
    }
  }
  el('hud-count').textContent = n === 0 ? 'nothing yet' : n + (n === 1 ? ' thing' : ' things');
}
