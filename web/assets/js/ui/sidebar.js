// The slide-in sidebar: board actions, import, arrangement, view toggles.
// It only reads state and calls commands - all the actual work lives elsewhere.

import { board, bus, markDirty, setSetting, setArrangement, setTitle } from '../state.js';
import { ARRANGEMENTS } from '../arrange/arrangements.js';
import { VERSION } from '../version.js';
import { el, readPref, writePref } from '../util.js';
import { itemBounds } from '../geometry.js';
import { toUnits, formatLength, paperMm, PAPERS } from '../measure.js';

let sidebar, menuBtn;
const MODE_PREF = 'mbrd.boardMode';

export function initSidebar(cmds) {
  sidebar = el('sidebar');
  menuBtn = el('menu-btn');

  menuBtn.addEventListener('click', () => (isOpen() ? close() : open()));
  el('side-close').addEventListener('click', close);

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
  cmds.setBoardMode(readPref(MODE_PREF, 'desktop'));

  // --- arrangement ---
  const arrSel = el('arrangement');
  for (const a of ARRANGEMENTS) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.label;
    arrSel.append(opt);
  }
  arrSel.value = board.arrangement;
  arrSel.addEventListener('change', () => setArrangement(arrSel.value));

  const spacing = el('spacing');
  const spacingOut = el('spacing-out');
  const showSpacing = () => { spacingOut.textContent = spacing.value + 'px'; };
  spacing.value = board.settings.spacing;
  showSpacing();
  spacing.addEventListener('input', () => {
    showSpacing();
    setSetting('spacing', +spacing.value);
  });

  // --- view toggles ---
  bindCheck('opt-grid', 'grid');
  bindCheck('opt-axes', 'axes');
  bindCheck('opt-snap', 'snap');
  bindCheck('opt-hud', 'hud');

  wirePaper();
  wireScale();
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

function bindCheck(id, key) {
  const box = el(id);
  box.checked = !!board.settings[key];
  box.addEventListener('change', () => setSetting(key, box.checked));
}

/**
 * The sheet picker and its two orientation buttons.
 *
 * The sizes are built from PAPERS rather than listed in the markup, the same
 * way the arrangement menu is built from ARRANGEMENTS: a size that exists in
 * the menu and not in the renderer - or the reverse - is a bug that can only
 * happen if the list is written down twice.
 *
 * Orientation is a pair of buttons rather than a checkbox saying "landscape",
 * because both states are equally ordinary and a checkbox makes one of them the
 * default and the other the deviation. It is a radio group in behaviour, drawn
 * with aria-pressed so the pressed one reads as the current state to a screen
 * reader as well as to the eye.
 */
function wirePaper() {
  const pick = el('opt-paper');
  for (const p of PAPERS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    pick.append(opt);
  }
  pick.addEventListener('change', () => setSetting('paper', pick.value));
  bindCheck('opt-paper-resize', 'paperResize');

  for (const btn of el('paper-orient').querySelectorAll('[data-orient]')) {
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
 * The one control here that is still a control.
 *
 * `settings.scale` used to have a number field in this section - "one grid
 * square is [6.4] cm" - and it is gone, replaced by the paper outline's corner
 * grips. The field was a workaround for the same problem the sheet now solves
 * properly: scale is world units per millimetre, a quantity nobody has an
 * intuition about, so it has to be set by matching something rather than by
 * being typed. A grid square was the best reference available before there was
 * a sheet of paper on the board; a sheet of A4 is a better one, because it is
 * an object people have held rather than a spacing they have configured, and
 * because dragging it is one gesture against the actual photographs instead of
 * a number typed and then checked.
 *
 * So what remains is the unit family, which is a display setting and nothing
 * more - it changes how every measurement is *said* and no geometry at all.
 */
function wireScale() {
  const units = el('opt-units');
  units.addEventListener('change', () => setSetting('units', units.value));
}

/**
 * Rename the board by typing in its name.
 *
 * `change` rather than `input`, so a rename is one undoable event and one dirty
 * flag rather than one per keystroke - it fires on Enter and on blur, and only
 * when the value actually moved.
 *
 * The field edits `board.title` and paint() now shows `board.title`, where it
 * used to prefer the open file's name. Those two only ever differed by an
 * extension - opening a .mbrd sets the title from the file's stem - right up
 * until somebody renames one, which is the whole of this feature. Preferring
 * the file name would have made the field look broken: you type, and the old
 * name stays on screen.
 *
 * setTitle() is deliberately not the thing that marks the board dirty. It is
 * also called by the save picker, straight after a save, where re-dirtying the
 * board it has just cleaned would be wrong.
 */
function wireTitle() {
  const input = el('board-title');
  input.addEventListener('change', () => {
    const next = input.value.trim();
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

/** The title as the field holds it: empty for a board that has no name yet. */
const titleValue = () => (board.title === 'Untitled board' ? '' : board.title);

/** Push state back into the controls (after opening a board, or an undo). */
function paint() {
  const title = el('board-title');
  // Never while it is being typed into: 'board' fires on every dirty-flag flip,
  // and rewriting the field mid-word would move the caret to the end of it.
  if (document.activeElement !== title) title.value = titleValue();
  el('arrangement').value = board.arrangement;
  el('spacing').value = board.settings.spacing;
  el('spacing-out').textContent = board.settings.spacing + 'px';
  const mobile = board.layoutMode === 'mobile';
  const mode = el('board-mode');
  mode.setAttribute('aria-pressed', String(mobile));
  mode.title = mobile ? 'Switch to the Desktop arrangement' : 'Switch to the Mobile arrangement';
  el('board-mode-hint').textContent = mobile
    ? 'Mobile is six spaces wide, starts ten above 0,0, and continues downward.'
    : 'Desktop is the free two-dimensional arrangement.';
  const fit = sidebar.querySelector('[data-cmd="fit"]');
  if (fit) fit.textContent = mobile ? 'Back to top' : 'Zoom to fit';
  for (const [id, key] of [['opt-grid', 'grid'], ['opt-axes', 'axes'], ['opt-snap', 'snap'], ['opt-hud', 'hud']]) {
    el(id).checked = !!board.settings[key];
  }

  paintSheet();

  el('opt-units').value = board.settings.units;
  // The sentence under the controls is what makes the scale legible: it states
  // it against the biggest reference the board has, so a mistake of a factor of
  // ten shows up as "this board is forty metres across" rather than hiding in a
  // decimal nobody was going to check.
  el('scale-hint').textContent = board.items.length
    ? `Everything on this board fits in ${formatLength(spread(), board.settings.scale, board.settings.units)}.`
    : 'Drop something in, then measure the board from it.';
}

/**
 * The sheet controls, and the sentence that makes them mean something.
 *
 * The hint gives the sheet's size in *board units*, which is the one number
 * that connects this section to the one above it. A page is only useful as a
 * boundary if the scale is right, and "A4 is 210 x 297 units across" is how you
 * catch a scale that is out by a factor of ten - the sheet either swallows the
 * whole board or vanishes into a card, and the number says which before you
 * have to go and look.
 */
function paintSheet() {
  const s = board.settings;
  el('opt-paper').value = s.paper;
  el('opt-paper-resize').checked = !!s.paperResize;
  for (const btn of el('paper-orient').querySelectorAll('[data-orient]')) {
    btn.setAttribute('aria-pressed', String((btn.dataset.orient === 'landscape') === !!s.paperLandscape));
  }
  const mm = paperMm(s.paper, s.paperLandscape);
  // The invitation to drag is only printed when dragging is switched on. A hint
  // describing a gesture the corners will not answer is worse than no hint.
  const drag = s.paperResize
    ? ' Drag a corner to match it against the board - that is what sets the scale.'
    : '';
  el('paper-hint').textContent = mm
    ? `${Math.round(toUnits(mm.w, s.scale))} × ${Math.round(toUnits(mm.h, s.scale))} px, centred on 0,0.${drag}`
    : 'Outlines a sheet in the middle of the board, at the size it really is.';
}

/** The long side of the box round every item - the board's own extent. */
function spread() {
  const box = itemBounds(board.items);
  return box ? Math.max(box.x1 - box.x0, box.y1 - box.y0) : 0;
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

const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
