// The slide-in sidebar: board actions, import, arrangement, view toggles.
// It only reads state and calls commands - all the actual work lives elsewhere.

import { board, bus, setSetting, setArrangement } from '../state.js';
import { ARRANGEMENTS } from '../arrange/arrangements.js';
import { canPickFiles, currentFileName } from '../storage/storage.js';
import { VERSION } from '../version.js';

const el = id => document.getElementById(id);

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

  const gridStyle = el('opt-gridstyle');
  gridStyle.value = board.settings.gridStyle;
  gridStyle.addEventListener('change', () => setSetting('gridStyle', gridStyle.value));

  el('version').textContent = 'v' + VERSION;
  el('save-hint').textContent = canPickFiles()
    ? 'Save writes straight back to the same .mbrd.'
    : 'No file picker in this browser — Save sends you a .mbrd, and Open takes it back.';

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

/** Push state back into the controls (after opening a board, or an undo). */
function paint() {
  const name = currentFileName();
  const title = name || board.title;
  // An unnamed board reads as an aside, not a filename.
  el('board-title').innerHTML = '';
  const node = title === 'Untitled board' ? document.createElement('em') : document.createElement('span');
  node.textContent = title;
  el('board-title').append(node);
  el('arrangement').value = board.arrangement;
  el('opt-gridstyle').value = board.settings.gridStyle;
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

export const isOpen = () => sidebar?.classList.contains('is-open');

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
  try { localStorage.setItem(OPEN_KEY, want ? '1' : '0'); } catch { /* private mode */ }
}

/** Reopen the panel on load, without playing the slide-in for it. */
function restoreOpen() {
  let want = false;
  try { want = localStorage.getItem(OPEN_KEY) === '1'; } catch { /* private mode */ }
  if (!want) return;
  // Already-open is a fact about the page, not a thing that just happened, so
  // it should not animate. One frame with the transition off is enough.
  sidebar.style.transition = 'none';
  setOpen(true, false);
  requestAnimationFrame(() => { sidebar.style.transition = ''; });
}

const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
