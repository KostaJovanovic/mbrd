// The slide-in sidebar: opening it, closing it, and the four things inside it
// that are not a row in a table.
//
// The controls themselves moved out. ui/settings-schema.js describes them and
// ui/panel.js builds them, which is what took this file from "every setting,
// wired by id" down to the panel as an object: the sheet's open state, the one
// delegated click that reaches the command surface, the gesture that isolates a
// slider under a finger, and the paper orientation pair. The name field is the
// fourth thing here and the one this file no longer implements - it wires and
// paints ui/board-title.js's, because the masthead's panel has the same field
// and one rename must show in both.
//
// Paper orientation stays here rather than in the table because it is not a
// value being set: choosing an orientation with no sheet up also puts a sheet
// up, which is a rule about paper. The table can say what a control *is*; this
// is a thing one control *does*.

import { board, bus, setSetting } from '../state.js';
import { VERSION } from '../version.js';
import { el, readPref, writePref } from '../util.js';
import { buildPanel, paintPanel } from './panel.js';
import { paintTitleField, wireTitleField } from './board-title.js';

let sidebar, menuBtn;
let sliderFocus;
const MODE_PREF = 'mbrd.boardMode';
const MOBILE_LAYOUT_QUERY = '(max-width: 700px)';

/** Match the same narrow-screen breakpoint used by the CSS. */
export function mobileLayoutDetected(media = query => globalThis.matchMedia?.(query)) {
  return typeof media === 'function' && !!media(MOBILE_LAYOUT_QUERY)?.matches;
}

/**
 * Temporarily isolate one range control while a finger is moving it.
 *
 * Kept independent of event registration so the pointer lifecycle stays
 * headless-testable. Delegation in initSidebar means controls built at runtime
 * are covered without maintaining a second list of sliders here.
 */
export function createMobileSliderFocus(root, {
  isMobile = mobileLayoutDetected,
} = {}) {
  let active = null;
  let pointerId = null;

  const restore = () => {
    active?.classList.remove('is-slider-active');
    root.classList.remove('is-slider-focus');
    active = null;
    pointerId = null;
  };

  const clear = () => restore();

  const begin = (target, id = null) => {
    if (!isMobile() || !target?.matches?.('input[type="range"]')) return false;
    active?.classList.remove('is-slider-active');
    active = target;
    pointerId = id;
    active.classList.add('is-slider-active');
    root.classList.add('is-slider-focus');
    return true;
  };

  const end = (id = null) => {
    if (!active) return false;
    if (pointerId !== null && id !== null && pointerId !== id) return false;
    restore();
    return true;
  };

  return { begin, end, clear };
}

export function initSidebar(cmds) {
  sidebar = el('sidebar');
  menuBtn = el('menu-btn');
  sliderFocus = createMobileSliderFocus(sidebar);

  menuBtn.addEventListener('click', () => (isOpen() ? close() : open()));
  el('side-close').addEventListener('click', close);

  sidebar.addEventListener('pointerdown', e => {
    sliderFocus.begin(e.target, e.pointerId);
  });
  const endSliderFocus = e => sliderFocus.end(e.pointerId);
  globalThis.addEventListener('pointerup', endSliderFocus);
  globalThis.addEventListener('pointercancel', endSliderFocus);
  sidebar.addEventListener('lostpointercapture', endSliderFocus, true);

  // Every action button in the panel is a data-cmd; the map is the whole API.
  sidebar.addEventListener('click', e => {
    const btn = e.target.closest('[data-cmd]');
    if (!btn) return;
    const fn = cmds[camel(btn.dataset.cmd)];
    if (fn) fn();
  });

  // The file carries both arrangements, while each device remembers which one
  // it wants to work in. This lets the same board open Mobile on a phone and
  // Desktop on a laptop without either save changing the other's preference.
  const detected = mobileLayoutDetected() ? 'mobile' : 'desktop';
  cmds.setBoardMode(readPref(MODE_PREF, detected));

  wirePaperOrientation();
  wireTitleField(el('board-title'));

  el('version').textContent = 'v' + VERSION;

  bus.on('board', paint);
  bus.on('settings', paint);
  bus.on('layout', mode => {
    writePref(MODE_PREF, mode);
    paint();
  });
  // The Feed and Playlist buttons show which lens is up, and a lens switch is the
  // one change that moves that without a layout or a setting behind it.
  bus.on('lens', paint);
  paint();
  restoreOpen();
}

/**
 * The two orientation buttons.
 *
 * A radio group in behaviour, drawn with aria-pressed so the pressed one reads
 * as the current state to a screen reader as well as to the eye - the panel
 * paints that; this is only what a press means.
 */
function wirePaperOrientation() {
  const row = document.getElementById('paper-orient');
  if (!row) return;
  for (const btn of row.querySelectorAll('[data-orient]')) {
    btn.addEventListener('click', () => {
      // Choosing an orientation with no sheet chosen would be setting a state
      // nothing can show, so it puts a sheet up as well. A4 because it is the
      // one everybody means by "a page", and because the alternative - a dead
      // button until a dropdown two rows up has been touched - is worse.
      if (!board.settings.paper) setSetting('paper', 'a4');
      setSetting('paperLandscape', btn.dataset.orient === 'landscape');
    });
  }
}

/** Push state back into the controls (after opening a board, or an undo). */
function paint() {
  // The name field's behaviour lives in ui/board-title.js now - the masthead's
  // panel grew a second one, and one rename showing up in both is only true
  // while there is one implementation of it.
  paintTitleField(el('board-title'));
  paintPanel();
}

// Deliberately non-modal: no scrim, nothing disabled behind it. The board keeps
// panning, zooming, accepting drops and responding to keys while the panel is
// open, so you can leave it open and keep working - which is also why the open
// state is worth remembering across reloads. It follows the user rather than
// the board, so it lives in localStorage and not in the .mbrd: how you like to
// work is not a property of someone else's moodboard.
const OPEN_KEY = 'mbrd.sidebar';

const isOpen = () => sidebar?.classList.contains('is-open');

export function open() {
  setOpen(true);
}

export function close() {
  if (!sidebar) return;
  sliderFocus?.clear();
  setOpen(false);
}

function setOpen(want, remember = true) {
  sidebar.classList.toggle('is-open', want);
  sidebar.setAttribute('aria-hidden', String(!want));
  menuBtn.setAttribute('aria-expanded', String(want));
  if (!remember) return;
  writePref(OPEN_KEY, want ? '1' : '0');
}

/** Reopen the panel on load, without playing the slide-in for it. */
function restoreOpen() {
  if (readPref(OPEN_KEY) !== '1') return;
  // Already-open is a fact about the page, not a thing that just happened, so
  // it should not animate. One frame with the transition off is enough.
  sidebar.style.transition = 'none';
  setOpen(true, false);
  requestAnimationFrame(() => { sidebar.style.transition = ''; });
}

/** Build the panel's DOM. Called before the modules that reach into it. */
export { buildPanel };

const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
