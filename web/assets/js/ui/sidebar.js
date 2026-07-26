// The slide-in sidebar: board actions, import, arrangement, view toggles.
// It only reads state and calls commands - all the actual work lives elsewhere.

import { board, bus, markDirty, setSetting, setArrangement, setTitle } from '../state.js';
import { ARRANGEMENTS } from '../arrange/arrangements.js';
import { VERSION } from '../version.js';
import { el, readPref, writePref } from '../util.js';

let sidebar, menuBtn;

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

  wireTitle();

  el('version').textContent = 'v' + VERSION;

  bus.on('board', paint);
  bus.on('settings', paint);
  paint();
  restoreOpen();
}

function bindCheck(id, key) {
  const box = el(id);
  box.checked = !!board.settings[key];
  box.addEventListener('change', () => setSetting(key, box.checked));
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
  for (const [id, key] of [['opt-grid', 'grid'], ['opt-axes', 'axes'], ['opt-snap', 'snap'], ['opt-hud', 'hud']]) {
    el(id).checked = !!board.settings[key];
  }
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
