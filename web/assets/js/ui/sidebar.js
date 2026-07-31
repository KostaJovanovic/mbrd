// The slide-in sidebar: opening it, closing it, and the four things inside it
// that are not a row in a table.
//
// The controls themselves moved out. ui/settings-schema.js describes them and
// ui/panel.js builds them, which is what took this file from "every setting,
// wired by id" down to the panel as an object: the sheet's open state, the one
// delegated click that reaches the command surface, the gesture that isolates a
// slider under a finger, the board's name, and the paper orientation pair.
//
// Paper orientation stays here rather than in the table because it is not a
// value being set: choosing an orientation with no sheet up also puts a sheet
// up, which is a rule about paper. The table can say what a control *is*; this
// is a thing one control *does*.

import {
  board, bus, markDirty, setSetting, setTitle, cleanBoardTitle,
  cleanBoardTitleDraft, isDefaultTitle,
} from '../state.js';
import { VERSION } from '../version.js';
import { el, readPref, writePref } from '../util.js';
import { buildPanel, paintPanel } from './panel.js';

let sidebar, menuBtn;
let sliderFocus;
const MODE_PREF = 'mbrd.boardMode';
const MOBILE_LAYOUT_QUERY = '(max-width: 700px)';

/** Match the same narrow-screen breakpoint used by app.css. */
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
  wireTitle();

  el('version').textContent = 'v' + VERSION;

  bus.on('board', paint);
  bus.on('settings', paint);
  bus.on('layout', mode => {
    writePref(MODE_PREF, mode);
    paint();
  });
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

/**
 * Rename the board by typing in its name.
 *
 * `change` rather than `input`, so a rename is one undoable event and one dirty
 * flag rather than one per keystroke - it fires on Enter and on blur, and only
 * when the value actually moved.
 *
 * The field edits `board.title` and paint() shows `board.title`, where it used
 * to prefer the open file's name. Those two only ever differed by an extension -
 * opening a .mbrd sets the title from the file's stem - right up until somebody
 * renames one, which is the whole of this feature. Preferring the file name
 * would have made the field look broken: you type, and the old name stays on
 * screen.
 *
 * setTitle() is deliberately not the thing that marks the board dirty. It is
 * also called by the save picker, straight after a save, where re-dirtying the
 * board it has just cleaned would be wrong.
 */
function wireTitle() {
  const input = el('board-title');
  input.addEventListener('input', () => {
    const clean = cleanBoardTitleDraft(input.value);
    if (clean !== input.value) input.value = clean;
  });
  input.addEventListener('change', () => {
    const next = cleanBoardTitle(input.value);
    if (next === titleValue()) return;
    setTitle(next);
    markDirty();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    // Put the old name back before the global handler blurs us, so escaping
    // out of a half-typed name leaves the board called what it was called.
    else if (e.key === 'Escape') input.value = titleValue();
  });
}

/** The title as the field holds it: empty for a board still on its auto name,
 *  so the name shows through as the faint italic placeholder rather than as a
 *  value nobody typed. */
const titleValue = () => (isDefaultTitle(board.title) ? '' : board.title);

/** Push state back into the controls (after opening a board, or an undo). */
function paint() {
  const title = el('board-title');
  if (title) {
    // Never while it is being typed into: 'board' fires on every dirty-flag
    // flip, and rewriting the field mid-word would move the caret to the end.
    if (document.activeElement !== title) title.value = titleValue();
    // The auto name lives in the placeholder, so an unnamed board shows its
    // date faint and italic and a click starts from an empty field rather than
    // from text to delete.
    title.placeholder = isDefaultTitle(board.title) ? board.title : 'Untitled board';
  }
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
