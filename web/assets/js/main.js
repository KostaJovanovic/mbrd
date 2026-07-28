// Boot: build the viewport, wire every subsystem to it, restore the last
// session, and expose the command set the sidebar and keyboard both drive.

import { toast, el, shuffle } from './util.js';
import { formatLength, formatSize, scaleFrom, DEFAULT_SCALE, MM_PER_INCH } from './measure.js';
import { ask } from './ui/dialog.js';
import { VERSION } from './version.js';
import {
  board, bus, selection, selectAll, removeItems, setSetting,
  snapshotGeom, applyGeom, commitGeom, undo, redo, byId,
  raiseSelection, lowerSelection, selectionHasStackOverlap,
  duplicateItems, select, setItemCover,
  setItemUpAxis, historyState, baseStep, mobileBoardWidth, mobileBoardTop,
  mobileBoardBottom, placeMobileItems, setTitle, markDirty,
  recheckBoardGeometry, cleanBoardTitle, cleanBoardTitleDraft,
  setBoardMode as selectBoardMode, setAssetNameLookup,
} from './state.js';
import { latticeBox, itemBounds } from './geometry.js';
import { defaultUpAxis, meshKind } from './mesh.js';
import { Viewport, MIN_ZOOM, MAX_ZOOM, zoomMs, travelMs } from './canvas/viewport.js';
import { paintGrid, resetGridInk } from './canvas/grid.js';
import { initPaper, paintPaper } from './canvas/paper.js';
import { initItems, resetItems } from './canvas/items.js';
import { isTurning, resetModels, rotateModel } from './canvas/model.js';
import { initWeb } from './canvas/web.js';
import { initStills } from './canvas/stills.js';
import { initInput } from './canvas/input.js';
import { initDrop, pickFiles, pickCover, addNote } from './import/drop.js';
import { arrange } from './arrange/arrangements.js';
import { defaultSize, measureSize } from './canvas/renderers.js';
import {
  initStorage, restoreSession, saveBoard, exportBoard, openBoard, newBoard, openFile, autosave,
  clearAllData, setPrompt,
} from './storage/storage.js';
import { flushNoteEdit, noteFloor } from './canvas/notes.js';
import { initAssets, getAsset } from './storage/assets.js';
import { initSidebar, close as closeSidebar } from './ui/sidebar.js';
import { initMenu, openContextMenu, close as closeMenu } from './ui/menu.js';
import { initSearch, open as openSearch } from './ui/search.js';
import { initIdle } from './ui/idle.js';
import { initScaleBar } from './ui/scalebar.js';
import { initTrash } from './ui/trash.js';
import { initAppearance, resetAppearance } from './ui/appearance.js';
import { initFonts } from './ui/fonts.js';
import { initMobileHeaderEditor, closePanel as closeHeaderPanel } from './ui/mobile-header.js';
import { initAudio } from './canvas/audio.js';
import { editNote, growNote } from './canvas/notes.js';

const vp = new Viewport(el('viewport'), el('world'), el('origin-mark'));

// ---------------------------------------------------------------------------
// Commands - the single surface the sidebar buttons and the keyboard share.
// data-cmd="reset-appearance" resolves to cmds.resetAppearance, and so on.
// ---------------------------------------------------------------------------

const cmds = {
  new: () => newBoard(),
  open: () => openBoard(),
  save: () => saveWithCooldown(),
  export: () => exportBoard(),
  exportAs: () => exportBoard({ pickNew: true }),
  // Strictly asked for, never automatic - see optimize/optimize.js. Loaded on
  // demand as well as run on demand: the encoder behind it is thirty megabytes
  // and a board of photographs never needs it.
  optimize: () => import('./optimize/ui.js').then(m => m.optimizeBoard()),
  discardOriginals: () => import('./optimize/ui.js').then(m => m.discardOptimizeOriginals()),

  addFiles: () => pickFiles(),
  addNote: () => {
    const item = addNote(vp.toWorld(vp.left + vp.cx, vp.top + vp.cy));
    requestAnimationFrame(() => cmds.editNote(item.id));
  },

  clearData: () => armClear(),

  // Two commands rather than one that reads the selection, so that neither can
  // lie about what it is going to touch: the sidebar button says "Rearrange
  // everything" and does, whatever happens to be selected at the time.
  rearrange: () => rearrange(board.items),
  rearrangeSelection: () => rearrange(board.items.filter(i => selection.has(i.id))),
  setBoardMode: mode => selectBoardMode(mode),
  toggleBoardMode: () => {
    const next = board.layoutMode === 'mobile' ? 'desktop' : 'mobile';
    if (!selectBoardMode(next)) return;
    toast(next === 'mobile'
      ? `Mobile board: ${board.settings.mobileColumns} columns, vertical scroll`
      : 'Desktop board');
  },
  scaleFromItem,
  // Resetting the sheet's size and resetting the board's scale are the same
  // act: the sheet is drawn at whatever A4 works out to under the current
  // scale, so there is nothing else its size could be stored in. Named for the
  // scale rather than for the paper because it also puts the readout, the
  // scale bar and every item's measurement back.
  resetScale: () => {
    if (board.settings.scale === DEFAULT_SCALE) return;
    setSetting('scale', DEFAULT_SCALE);
    toast('Back to the default size');
  },
  fit: () => vp.fit(board.items, 80, travelMs()),
  recenter: () => vp.recenter(travelMs()),
  // Hold the magnification where it is. A command rather than two lines in the
  // click handler, because that is what a user-facing action is here - the one
  // surface a key binding or a menu row would bind to if either ever wants it.
  lockZoom: () => {
    if (vp.isMobile) {
      toast(`Mobile zoom follows the ${board.settings.mobileColumns}-column width`);
      return;
    }
    vp.zoomLocked = !vp.zoomLocked;
    paintZoom(true);
    toast(vp.zoomLocked ? `Zoom locked at ${zoomText()}` : 'Zoom unlocked');
  },
  resetAppearance,
  reload: reloadBoard,
  restart: () => restartApp(),

  selectAll,
  undo, redo,
  deleteSelection: () => {
    if (!selection.size) return;
    removeItems([...selection]);
  },
  // Escape means "put the sheets away", and there are two of them now - the
  // main panel and the masthead's. One command rather than two, because the key
  // that closes a panel should not have to be told which panel is up.
  closeSidebar: () => { closeSidebar(); closeHeaderPanel(); },
  editNote,

  // --- right-click menu ---
  contextMenu: (x, y, id, count) => openContextMenu(x, y, id, count),
  selectionHasStackOverlap,
  raise: raiseSelection,
  lower: lowerSelection,
  duplicate: () => {
    const copies = duplicateItems(selection);
    if (copies.length) select(copies.map(i => i.id));
  },
  zoomToSelection: () => {
    const items = board.items.filter(i => selection.has(i.id));
    if (items.length) vp.fit(items, 120, travelMs());
  },
  addNoteAt: at => {
    const item = addNote(at);
    requestAnimationFrame(() => cmds.editNote(item.id));
  },
  canEditNote: id => byId(id)?.type === 'note',
  resetSize,
  // Image and video cards are already a picture; everything else can be given
  // one. Asked of the item rather than of the renderer because this is about
  // what the card *is*, not about which module happens to draw it.
  canCoverItem: id => {
    const type = byId(id)?.type;
    return !!type && type !== 'image' && type !== 'video';
  },
  itemHasCover: id => !!byId(id)?.meta?.cover,
  setCover: id => pickCover(id),
  clearCover: id => setItemCover(id, null),

  // Only models, and only the formats where the answer is not already written
  // down: glTF fixes Y-up in its spec, so offering to argue with it would be
  // offering to break it.
  canFlipUpAxis: id => {
    const it = byId(id);
    if (it?.type !== 'model') return false;
    const kind = meshKind(getAsset(it.asset?.hash)?.name || it.name || '');
    return kind === 'obj' || kind === 'stl';
  },
  flipUpAxis: id => {
    const it = byId(id);
    if (!it) return;
    const kind = meshKind(getAsset(it.asset?.hash)?.name || it.name || '');
    // Written out rather than toggled between "set" and "unset", so the board
    // records the reading it is actually using. A .mbrd that says nothing means
    // "whatever this version guesses", and a guess that changed between
    // versions would silently lie a model down that somebody had stood up.
    const now = it.meta?.upAxis === 'z' || it.meta?.upAxis === 'y'
      ? it.meta.upAxis : defaultUpAxis(kind);
    setItemUpAxis(id, now === 'z' ? 'y' : 'z');
    toast(now === 'z' ? 'Read as Y-up' : 'Read as Z-up');
  },
  // Every model card is a photograph of itself until this is asked for - see
  // canvas/model.js. Offered on any model, including one that has never been
  // photographed and is already live: the entry is how somebody learns the card
  // can be turned at all, and asking for it while it is already turning is a
  // no-op rather than a wrong answer. Not offered on a card that is mid-turn,
  // which would be a menu item that does nothing visible.
  canRotateModel: id => byId(id)?.type === 'model' && !isTurning(id),
  rotateModel: id => {
    rotateModel(id);
    toast('Drag the model to turn it. It settles when you click away.');
  },

  // On the command surface as well as on Ctrl+K, because a keyboard shortcut
  // nothing mentions is a feature only the person who wrote it has.
  find: () => openSearch(),
  getSetting: key => board.settings[key],
  toggleSetting: key => setSetting(key, !board.settings[key]),
};

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

initAssets();
// Hand state the asset registry's filename lookup, which it cannot import
// (storage sits above state - AUD-12). This is the original-filename fallback
// renameItem() uses when a name is cleared.
setAssetNameLookup(hash => getAsset(hash)?.name);
// Before initAppearance, so the type menus are built once with the board's own
// faces already in them rather than built empty and rebuilt a tick later.
initFonts();
// The grid's marks at Harsh are drawn rather than composed from gradients, so
// unlike every other tier they cannot follow a custom property on their own -
// see canvas/grid.js. Every edit to a look hands the resolved colours back and
// repaints; the other tiers repaint for nothing, which is four gradients.
initAppearance({ onChange: () => { resetGridInk(); paintGrid(vp); } });
initAudio();
bus.on('layout', () => syncBoardMode(true));
syncBoardMode();
initSidebar(cmds);
initMobileHeaderEditor(vp);
initItems(el('world'), vp);
initWeb(el('world'), vp);
initStills(el('world'), vp);
initScaleBar(vp);
// Its own listeners rather than a call from the paint block below: the sheet is
// also a control - it is dragged by the corners to set the board's scale - so
// it owns an event surface as well as a drawing, the way every other init* does.
initPaper(vp);
initInput(vp, cmds);
initMenu(vp, cmds);
initSearch(vp);
initIdle(vp);
initTrash(vp);
initDrop(vp);
// Hand storage the confirmation prompt it cannot import (ui sits above storage
// - AUD-12): the discard-unsaved and clear-everything dialogs.
setPrompt(ask);
initStorage();

// The grid is screen-space, so it repaints on every view change. Two tiers are
// four CSS gradients; Harsh draws its lattice, but only over the canvas, which
// is the viewport - so both are bounded by the screen rather than the board.
//
// The view is board state and is saved with the board, but it changes on every
// frame of a pan - so it is written here on each change and *announced* on a
// trailing timer. Without the announcement nothing scheduled an autosave, and a
// board closed after nothing but panning came back at the view it had before,
// which is not where the user left it. Without the timer, every pan would queue
// a snapshot per frame.
let viewSettle = 0;
vp.onChange(() => {
  paintGrid(vp);
  board.view.pan = { x: vp.pan.x, y: vp.pan.y };
  board.view.zoom = vp.zoom;
  paintZoom();
  clearTimeout(viewSettle);
  // Its own event rather than 'settings', which several modules repaint on -
  // and deliberately not markDirty(): looking around a board is not editing it,
  // and a pan that raised "unsaved changes" on the way out would be a lie.
  viewSettle = setTimeout(() => bus.emit('view'), 400);
});

// ---------------------------------------------------------------------------
// Corner zoom controls
// ---------------------------------------------------------------------------

const ZOOM_STEP = 1.3;

el('zoom-ctl').addEventListener('click', e => {
  const btn = e.target.closest('[data-zoom]');
  if (!btn) return;
  switch (btn.dataset.zoom) {
    case 'in':    vp.zoomBy(ZOOM_STEP, zoomMs()); break;
    case 'out':   vp.zoomBy(1 / ZOOM_STEP, zoomMs()); break;
    // 1:1, without moving the view.
    case 'reset': vp.viewTo(vp.pan, 1, travelMs()); break;
    case 'fit':   cmds.fit(); break;
    case 'home':  cmds.recenter(); break;
    case 'lock':  cmds.lockZoom(); break;
  }
});

// The phone's add bar (index.html, and the width query in app.css). Wired here
// beside the zoom controls rather than in ui/sidebar.js, because it is chrome on
// the glass and not part of the panel - the same reason those are here.
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
// Through cmds, not through state's undo() directly - the keyboard, the context
// menu and these three now all press the same button.
el('history-ctl').addEventListener('click', e => {
  const btn = e.target.closest('[data-history]');
  if (!btn) return;
  if (btn.dataset.history === 'undo') cmds.undo(); else cmds.redo();
});

/**
 * What the pair can do, and what it would do.
 *
 * The label is the point of naming it rather than only enabling it: "Undo Add 3
 * items" tells you whether the thing you are about to take back is the thing
 * you meant, which on a board where the last four actions were drags is the
 * only way to know without trying it.
 */
function paintHistory() {
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
/**
 * The autosave, acknowledged.
 *
 * A mark rather than a toast, and that is the whole design decision here. The
 * board saves itself about once a second while you are working, and a toast per
 * save would be the interface talking over the work continuously to report that
 * nothing is wrong. This appears where the board's other state lives, says one
 * word, and leaves.
 *
 * The timer is restarted rather than stacked, so a run of edits holds the mark
 * up throughout instead of flickering once per save.
 */
const SAVED_MS = 1500;
let savedTimer = 0;
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

/** The readout last written, so a pan does not rewrite it sixty times a second. */
let zoomShown = '';

/** The zoom as the corner prints it. Its own function because the lock's toast
 *  quotes the same number, and two roundings of one value is two answers. */
function zoomText() {
  const pct = vp.zoom * 100;
  // Below 10% a rounded percentage flickers between 6 and 7 as you pinch, so
  // give the small end a decimal instead.
  return (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%';
}

function paintZoom(force = false) {
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

bus.on('settings', key => {
  // The whimsy slider arrives here, and it moves the grid's colours as well as
  // its mark - so the resolved copy the Harsh crosses hold has to go back.
  if (key === 'appearance') resetGridInk();
  if (key === 'gridStep' || key === 'mobileColumns') syncBoardMode();
  paintGrid(vp);
  if (key === 'hud') el('hud').hidden = !board.settings.hud;
  if (key === 'snap') paintSnap();
});

/**
 * Snapping, published to CSS.
 *
 * The setting has a look as well as a behaviour: a snapped board stands its
 * cards up square, because a lattice is about edges and a lean spoils the one
 * thing lining everything up was for. That is a stylesheet's decision to make,
 * not a renderer's, so the flag goes on the root element and app.css takes it
 * from there - the same shape as data-palette and data-whimsy.
 */
function paintSnap() {
  document.documentElement.toggleAttribute('data-snap', !!board.settings.snap);
}

bus.on('items', paintCount);
// The readout's right-hand slot is the count *or* the selected item's real
// size, so the three things that can change which of those it is all repaint
// it: what is on the board, what is picked, and how the board is measured.
bus.on('selection', paintCount);
bus.on('geom', paintCount);
bus.on('items', syncMobileBoardBounds);
bus.on('geom', syncMobileBoardBounds);
bus.on('settings', paintCount);
// A note can arrive with text already in it - pasted, duplicated, or loaded
// from a file saved before it grew - so it is sized for what it says as soon
// as it has a node to measure.
bus.on('items', delta => requestAnimationFrame(() => {
  // Only a note new to the board needs measuring - the rest already fit what
  // they say. The delta names the arrivals; with none (a load) every note is new
  // here, so all of them are grown. This used to re-grow every note on the board
  // on every add, remove or reorder, which is the O(n)-per-event this delta ends.
  if (delta && delta.added) {
    for (const id of delta.added) if (byId(id)?.type === 'note') growNote(id);
  } else {
    for (const it of board.items) if (it.type === 'note') growNote(it.id);
  }
}));
bus.on('board:load', () => {
  // A board can bring its own look, applied without going through persist() -
  // so this is the other door the grid's colours change behind.
  resetGridInk();
  resetItems();
  // Parsed geometry is keyed by asset hash and the old board's assets are gone.
  resetModels();
  syncBoardMode();
  requestAnimationFrame(() => {
    for (const it of board.items) if (it.type === 'note') growNote(it.id);
  });
  openingView();
  el('hud').hidden = !board.settings.hud;
  paintSnap();
  paintCount();
  // A different board has never been saved, whatever the last one's button
  // said. Leaving the countdown up would be the new board claiming a write that
  // happened to something else.
  resetSave();
});

/**
 * How a board is framed the moment it appears, wherever it came from - a
 * restored session, a file opened, a file dropped on the window.
 *
 * Fit, not the stored view. A saved pan and zoom is a record of where somebody
 * was standing when they stopped, and that is not the same question as where
 * to start: it can be a corner, a single card filling the screen, or - after a
 * board is opened on a narrower screen than it was saved on - somewhere off the
 * edge of everything, which reads as an empty board with the work missing.
 * Framing the whole thing always answers "what is on here", and getting back to
 * a detail is one gesture away.
 *
 * fit() falls back to the origin at 1:1 by itself when there is nothing to
 * frame, so a brand new board still opens where a new board should.
 *
 * ms = 0 deliberately: the travel animation is for a Fit somebody *asked* for,
 * where the movement says which way the board went. There is nothing to travel
 * from at load.
 */
function openingView() {
  vp.fit(board.items, 80, 0);
}

/**
 * Publish the active geometry profile to the viewport and CSS. The choice is a
 * local device preference; state.js keeps both arrangements in the board.
 */
function syncBoardMode(frame = false) {
  document.documentElement.dataset.boardMode = board.layoutMode;
  vp.setBoardMode(
    board.layoutMode,
    mobileBoardWidth(),
    mobileBoardTop(),
    mobileBoardBottom(),
  );
  if (frame) openingView();
}

/**
 * The name across the Mobile masthead.
 *
 * The band itself is positioned entirely in CSS, off the custom properties the
 * viewport already publishes, so this is the only part that needs saying in
 * JavaScript. Written whatever the mode: a header that is display:none has
 * nothing to gain from being stale when Mobile is switched back on.
 *
 * A board with no name of its own still gets its page - see the [data-untitled]
 * rule in app.css for why it is dressed down rather than left blank.
 */
function paintMobileTitle() {
  const header = el('mobile-board-header');
  if (!header) return;
  const field = el('mobile-board-title');
  // Never over a rename in progress. 'board' fires on every dirty-flag flip as
  // well as on a real rename, and rewriting the field mid-word would take the
  // caret with it - the same guard the sidebar's name field keeps.
  if (!field.isContentEditable) field.textContent = board.title;
  header.toggleAttribute('data-untitled', board.title === 'Untitled board');
}

/**
 * Rename the board by tapping its name on the masthead.
 *
 * The same bargain a sticky note and an item's caption strike - see
 * editItemName() in canvas/items.js, which this follows down to the Escape
 * handling: the edit happens where you are already looking rather than in a
 * dialog thrown over the top of it, and on a phone the sidebar's name field is
 * three taps away behind a menu.
 *
 * A tap rather than a double click. The masthead is not a card, nothing else
 * can be done to it, and there is no drag or selection for a single tap to be
 * competing with - so the cheapest gesture is free to be the one that works.
 * Panning is not competing either: the field only takes the pointer while it is
 * standing still, and once it is editable input.js recognises a contenteditable
 * and leaves the gesture alone.
 */
function editMobileTitle() {
  const field = el('mobile-board-title');
  if (!field || field.isContentEditable) return;

  // plaintext-only keeps pasted markup out of a name; not every engine has it.
  try { field.contentEditable = 'plaintext-only'; }
  catch { field.contentEditable = 'true'; }
  if (!field.isContentEditable) field.contentEditable = 'true';
  // The stored name, not the shown one - they are the same string today, and
  // this is the line that keeps them the same if the masthead ever dresses it.
  field.textContent = board.title;

  let done = false;
  let keep = true;

  const onKey = e => {
    e.stopPropagation();          // the canvas must not see Delete, space or Escape
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
    else if (e.key === 'Escape') { keep = false; finish(); }
  };

  const onInput = () => {
    // innerText omits a trailing space in a contenteditable. Reading it here
    // made the sanitizer erase the separator before a second word could start;
    // textContent keeps the character that the editor actually owns.
    const clean = cleanBoardTitleDraft(field.textContent);
    if (clean === field.textContent) return;
    field.textContent = clean;
    const caret = document.createRange();
    caret.selectNodeContents(field);
    caret.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(caret);
  };

  function finish() {
    if (done) return;
    done = true;
    // Read before the teardown: innerText is what the field renders, and a name
    // is one line, so a pasted paragraph is flattened rather than refused.
    const typed = cleanBoardTitle(field.innerText);
    field.removeEventListener('keydown', onKey);
    field.removeEventListener('input', onInput);
    field.removeEventListener('blur', finish);
    field.contentEditable = 'false';
    field.blur();
    // Put the stored name back first. A name that comes back unchanged commits
    // nothing and emits nothing, and without this the half-typed text would
    // simply stay on screen.
    paintMobileTitle();
    if (!keep || typed === board.title) return;
    setTitle(typed);
    // setTitle() deliberately does not dirty the board - it is also called by
    // the save picker - so the rename says so itself, as the sidebar's field
    // does.
    markDirty();
    paintMobileTitle();
  }

  field.addEventListener('keydown', onKey);
  field.addEventListener('input', onInput);
  field.addEventListener('blur', finish);
  // Selected rather than merely focused: a rename usually replaces the name,
  // and an untitled board is holding a placeholder nobody typed.
  field.focus();
  const range = document.createRange();
  range.selectNodeContents(field);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * A tap on the name, told apart from a drag across it.
 *
 * Not a `click` listener, and that is the whole of this. A press anywhere the
 * canvas considers empty - which the masthead is, since it is not a card and
 * not one of the widgets input.js knows by name - has #viewport take pointer
 * capture on the way down and start a pan. Capture retargets the rest of the
 * gesture, the compatibility mouse events with it, so the lift is delivered to
 * the viewport and the name is never clicked at all. It looked like the rename
 * had simply stopped working.
 *
 * So the two ends are heard separately: the press on the name itself, the lift
 * on the window in the capture phase, which runs before the viewport's own
 * handlers and cannot be redirected. The name is left out of input.js's widget
 * list deliberately - a third of the screen that cannot be dragged is worse
 * than no shortcut at all - so the slop below is what separates the two: a
 * finger that travelled was panning, and a pan must not open an editor when it
 * happens to stop where it started.
 */
const TITLE_TAP_SLOP = 6;
let titleTap = null;

el('mobile-board-title').addEventListener('pointerdown', e => {
  // Already editing: the caret owns the pointer, and re-entering the edit would
  // reselect the whole name out from under somebody aiming at one word of it.
  titleTap = e.currentTarget.isContentEditable
    ? null
    : { id: e.pointerId, x: e.clientX, y: e.clientY };
});
window.addEventListener('pointerup', e => {
  const tap = titleTap;
  titleTap = null;
  if (!tap || e.pointerId !== tap.id) return;
  if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TITLE_TAP_SLOP) return;
  editMobileTitle();
}, true);
window.addEventListener('pointercancel', () => { titleTap = null; }, true);

bus.on('board', paintMobileTitle);
bus.on('board:load', paintMobileTitle);
paintMobileTitle();

/** Follow the lowest Mobile item without resetting or reframing the view. */
function syncMobileBoardBounds() {
  if (board.layoutMode !== 'mobile') return;
  vp.setMobileBounds(mobileBoardWidth(), mobileBoardTop(), mobileBoardBottom());
}

/**
 * Rebuild the live board without replacing its state or clearing its history.
 *
 * This is the deliberate repair path for stale DOM measurements, viewport
 * constraints, cached model renderings, and geometry that no longer agrees
 * with an enabled snap lattice.
 */
function reloadBoard() {
  flushNoteEdit();
  recheckBoardGeometry();
  resetGridInk();
  resetModels();
  resetItems();
  syncBoardMode();
  bus.emit('items');
  bus.emit('selection');
  bus.emit('settings', 'reload');
  paintGrid(vp);
  paintPaper();
  vp.apply();
  toast('Board reloaded');
}

/**
 * Start the page over.
 *
 * The refresh a phone does not have. Pull-to-refresh is off by design - the page
 * does not scroll and `overscroll-behavior: none` in app.css sees to the rest,
 * because every downward swipe on this board is a pan - and added to a home
 * screen there is no address bar to reload from either. Without a button, a
 * phone has no way back to a fresh page at all, which is the way to pick up a
 * new version of the app and the way out of any state the repair paths below do
 * not cover.
 *
 * Not the same act as "Reload board", and deliberately named apart from it:
 * that one rebuilds the live board in place and keeps the session, the history
 * and the view. This throws the page away, so the undo history goes with it and
 * the board comes back through restoreSession().
 *
 * Which is why the write comes first and the reload only follows a write that
 * worked. The autosave debounce is armed by every edit and a reload does not
 * run it; pressing this a second after typing would otherwise lose that second.
 * A save that fails asks before going anywhere - the answer to "your last edits
 * are not stored" is not to reload on top of them.
 */
async function restartApp() {
  flushNoteEdit();
  if (!(await autosave())) {
    const answer = await ask({
      title: 'Restart anyway?',
      body: 'This board could not be stored in this browser, so reloading the '
        + 'page would come back to the last snapshot that was. Export it to a '
        + 'file first if you want to keep what is on screen.',
      keep: board.items.length ? 'Export first' : '',
      cancel: 'Cancel',
      go: 'Restart anyway',
    });
    if (answer === 'cancel') return false;
    if (answer === 'keep') return (await exportBoard()) ? restartApp() : false;
  }
  location.reload();
  return true;
}

/**
 * Tell the board how big one thing really is, and every other measurement on it
 * follows.
 *
 * The way a board about real objects actually gets calibrated. A scale in world
 * units per millimetre is not a number anybody holds an opinion about; "that
 * chair is 80 cm wide" is. One known object is enough, because the board's
 * geometry is already internally consistent - it only ever needed one anchor to
 * the world.
 *
 * Width rather than height, and always: it is the dimension a person quotes for
 * furniture, prints, screens and doors alike, and asking for whichever is
 * longer would mean the question changing shape depending on what was selected.
 */
async function scaleFromItem() {
  if (selection.size !== 1) {
    toast('Select one item whose real width you know');
    return;
  }
  const it = byId([...selection][0]);
  if (!it) return;
  const { scale, units } = board.settings;
  const unit = units === 'imperial' ? 'inches' : 'centimetres';
  const answer = await ask({
    title: 'How wide is it really?',
    body: `Right now “${it.name || 'this item'}” measures ` +
      `${formatLength(it.w, scale, units)}. Say what it is in real life, in ${unit}, ` +
      'and the whole board is measured from it.',
    field: { value: '', placeholder: units === 'imperial' ? 'e.g. 31.5' : 'e.g. 80' },
    cancel: 'Cancel',
    go: 'Set the scale',
  });
  if (answer === 'cancel' || answer == null) return;
  const said = parseFloat(answer);
  if (!(said > 0)) { toast('That is not a width', 'error'); return; }
  const mm = said * (units === 'imperial' ? MM_PER_INCH : 10);
  setSetting('scale', scaleFrom(it.w, mm));
  toast(`Measured from ${it.name || 'that item'}`);
}

el('viewport').addEventListener('pointerdown', () => closeMenu());

el('viewport').addEventListener('pointermove', e => {
  const p = vp.toWorld(e.clientX, e.clientY);
  const { scale, units } = board.settings;
  el('hud-xy').textContent =
    `${px(p.x)}, ${px(p.y)} px · ${formatLength(p.x, scale, units)}, ${formatLength(p.y, scale, units)}`;
}, { passive: true });

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
function paintCount() {
  const n = board.items.length;
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

// ---------------------------------------------------------------------------
// Commands that need more than a one-liner
// ---------------------------------------------------------------------------

/**
 * Save, then stand down for half a minute.
 *
 * Saving writes the whole board - every asset, every note - into IndexedDB, and
 * on a board of photographs that is real work. The button invites repetition in
 * a way the work does not deserve: it is the one control whose effect is
 * invisible, so the honest response to "did that save?" is to press it again,
 * and a few of those in a row is the same megabytes written three times while
 * the board stutters.
 *
 * A cooldown answers the question the second press was asking. The button says
 * how long ago it saved, which is the information that was missing - not a
 * refusal so much as a receipt that stays up.
 *
 * Only the button. The autosave debounce behind every edit is untouched: that
 * is the board's own safety net and rate-limiting it would be rate-limiting the
 * thing that stops work being lost. This governs a human pressing a control,
 * which is the only place repetition is a problem.
 */
const SAVE_COOLDOWN_MS = 30_000;
let saveReadyAt = 0;
let saveTick = 0;
let saving = false;

async function saveWithCooldown() {
  // Two guards, not one. The cooldown is the deliberate half; `saving` covers
  // the gap the cooldown cannot, which is the double click that arrives while
  // the first write is still in flight and before there is anything to cool
  // down from.
  if (saving || saveReadyAt > Date.now()) return;
  saving = true;
  paintSave();
  let ok = false;
  try {
    ok = await saveBoard();
  } finally {
    saving = false;
  }
  // A failure is not a save and there is nothing to stand down from. Whatever
  // went wrong is worth another try immediately - it may be a permission that
  // has just been granted.
  if (!ok) { paintSave(); return; }
  saveReadyAt = Date.now() + SAVE_COOLDOWN_MS;
  clearInterval(saveTick);
  saveTick = setInterval(paintSave, 1000);
  paintSave();
}

/**
 * Every selected item back to the size it came in at.
 *
 * The size an item is *born* at, which is not its file's pixel dimensions:
 * measureSize() gives each type a standard area and lets the media supply only
 * the aspect, so a 6000px photograph and a 400px one arrive as cards of the
 * same weight and the board stays a board. Reproducing that here rather than
 * remembering it on the item is what makes this survive a `.mbrd` written by an
 * older version, and what stops a second field having to be kept true through
 * every crop, cover swap and optimise.
 *
 * Centres and rotations are kept. A reset is an answer to "I dragged this
 * corner and now it is wrong", and moving the card while fixing its size would
 * be answering a question nobody asked.
 *
 * Measured from the bytes, so it is asynchronous, and the whole selection is
 * measured before anything moves: half a group resized is not a state the board
 * should be seen in, and it would be one undo step per item to get out of.
 */
async function resetSize() {
  const items = board.items.filter(i => selection.has(i.id));
  if (!items.length) return;

  const step = baseStep();
  const sized = await Promise.all(items.map(async it => {
    const blob = getAsset(it.asset?.hash)?.blob;
    // measureSize only reads the file for the two types with an aspect of their
    // own; everything else answers from the type alone, so a card whose bytes
    // have gone still resets.
    const size = blob
      ? await measureSize(it.type, blob).catch(() => defaultSize(it.type))
      : defaultSize(it.type);
    let { w, h } = size;
    // A note may not be smaller than its own text - the same floor the resize
    // grips respect. Measured at the width being proposed, because narrowing a
    // note rewraps it and makes it taller.
    if (it.type === 'note') h = Math.max(h, noteFloor(it.id, w));
    // On a snapped board the size the item was born at is not on the lattice,
    // and a card that came back off the grid would be a fix that broke
    // something else. Same pass Rearrange makes, for the same reason.
    return board.settings.snap ? latticeBox({ ...it, w, h }, step) : { w, h };
  }));

  const before = snapshotGeom(items.map(i => i.id));
  // Tested before anything is applied, so a run that changes nothing leaves no
  // history entry behind - an undo step that restores the state it was already
  // in is a step somebody has to press twice to get anywhere. Said out loud for
  // the same reason: a menu item that does nothing is indistinguishable from
  // one that is broken.
  if (before.every((g, i) => g.w === sized[i].w && g.h === sized[i].h)) {
    toast(items.length === 1 ? 'That is already its own size' : 'Those are already their own size');
    return;
  }
  applyGeom(before.map((g, i) => ({ ...g, w: sized[i].w, h: sized[i].h })));
  commitGeom(items.length === 1 ? 'Reset size' : `Reset ${items.length} sizes`,
    before, items.map(i => i.id));
}

/** Back to an ordinary Save button, cooldown abandoned. Used by a board load. */
function resetSave() {
  saveReadyAt = 0;
  clearInterval(saveTick);
  saveTick = 0;
  paintSave();
}

function paintSave() {
  const btn = document.querySelector('[data-cmd="save"]');
  if (!btn) return;
  if (saving) {
    btn.disabled = true;
    btn.textContent = 'Saving…';
    return;
  }
  const left = Math.ceil((saveReadyAt - Date.now()) / 1000);
  if (left <= 0) {
    clearInterval(saveTick);
    saveTick = 0;
    btn.disabled = false;
    btn.textContent = 'Save';
    btn.removeAttribute('title');
    return;
  }
  btn.disabled = true;
  // Counting up rather than down, because what somebody wants to know is how
  // stale the save is, not how long until a button will let them press it.
  btn.textContent = `Saved ${SAVE_COOLDOWN_MS / 1000 - left}s ago`;
  btn.title = 'Everything is already written. Edits keep saving on their own.';
}

// ---------------------------------------------------------------------------
// Clear everything - the countdown in front of the dialog
// ---------------------------------------------------------------------------

/**
 * Presses left before "Clear everything" asks its real question, and how long
 * a half-finished countdown survives.
 *
 * The button wipes the browser's copy of the board, everything in it and the
 * look with it, and it sits in the same panel as Save and Optimize, a row away
 * from buttons that are safe to press out of curiosity. A confirmation dialog
 * on the first press is not much of a gate either: a dialog that appears is a
 * dialog that gets dismissed, and the one that matters looks like all the
 * others. So the press is spent before the question is asked - three of them,
 * counted down on the button's own face, and the fourth opens the dialog.
 *
 * Ten seconds of quiet puts it back. Somebody who armed it and walked away has
 * not half-agreed to anything, and coming back to a button already holding "1"
 * would be the worst state this could leave behind.
 */
const CLEAR_PRESSES = 3;
const CLEAR_IDLE_MS = 10000;

let clearLeft = 0;
let clearTimer = 0;

/**
 * One press of "Clear everything": count it, and open the dialog once the
 * countdown is spent.
 */
function armClear() {
  if (clearLeft > 0) clearLeft -= 1;
  else clearLeft = CLEAR_PRESSES;

  clearTimeout(clearTimer);
  if (clearLeft <= 0) {
    resetClear();
    return clearAllData();
  }
  clearTimer = setTimeout(resetClear, CLEAR_IDLE_MS);
  paintClear();
  return undefined;
}

/** Back to an ordinary button, countdown abandoned. */
function resetClear() {
  clearLeft = 0;
  clearTimeout(clearTimer);
  clearTimer = 0;
  paintClear();
}

function paintClear() {
  const btn = document.querySelector('[data-cmd="clear-data"]');
  if (!btn) return;
  if (clearLeft <= 0) {
    btn.textContent = 'Clear everything';
    btn.removeAttribute('title');
    delete btn.dataset.arming;
    return;
  }
  // The number is presses remaining, not a clock: a countdown in seconds would
  // be a button that fires itself, which is the one thing this must never do.
  btn.textContent = `Press ${clearLeft} more time${clearLeft === 1 ? '' : 's'}`;
  btn.title = 'Then it will ask, and then it will wipe this browser’s copy.';
  btn.dataset.arming = '';
}

/**
 * Lay `items` out again under the board's current arrangement.
 *
 * The whole board or a selection of it, and the difference is more than which
 * ids move. A rearrangement of everything is entitled to rebuild the board
 * around the origin and fly the view to it, because there is nothing else on
 * the board to be in the way. A rearrangement of nine cards is not: those nine
 * are somewhere for a reason, the rest of the board is around them, and hauling
 * them to 0,0 would be a move you did not ask for wearing a layout's clothes.
 * So a subset is relaid about its own centre and covers its own ground, and the
 * view stays where it is - the cards rearrange in front of you, which is the
 * plainest feedback there is and the reason a Fit would only get in the way.
 */
function rearrange(items) {
  if (!items.length) return;
  const whole = items.length === board.items.length;
  const mobile = board.layoutMode === 'mobile';
  const at = whole ? { x: 0, y: 0 } : middleOf(items);
  const before = snapshotGeom(items.map(i => i.id));

  // Two things vary here, and neither is enough on its own.
  //
  // The shuffle changes which item lands in which slot. Without it a layout is
  // a pure function of the list it is handed, so feeding it the same board
  // twice puts everything back exactly where it already was - and a button
  // called "Rearrange everything" that does nothing the second time you press
  // it reads as broken.
  //
  // The seed changes where the slots are (see arrangements.js). Without it the
  // board comes back in the identical shape with the cards swapped around,
  // which from any distance is the same picture - and zoomed out far enough to
  // see a whole rearrangement at once, cards are shapes and not subjects.
  const order = shuffle(items.map((_, i) => i));

// On a snapped board a rearrangement is a *re-lay*, sizes included. Placing
  // cards on the lattice and leaving them at 320x240 is the thing snapping is
  // for and does not do: the edges still miss every line, and the one gesture
  // that touches the whole board at once is the natural place to fix it.
  //
  // Sized before the layout runs rather than after, and that ordering is the
  // whole of it. The arrangements read each item's w and h to decide how much
  // room its slot needs, so resizing afterwards would hand a spiral built for
  // 320-wide cards a board of 340-wide ones - a layout with its spacing quietly
  // spent. Sizing first means the engine is laying out the cards that will
  // actually exist.
  // Sizes only. latticeBox() answers with a whole box, and the position half of
  // that answer is where the item *already* is - so spreading the whole thing
  // over a freshly chosen slot puts every card back exactly where it started,
  // which is a Rearrange button that does nothing at all.
  const step = baseStep();
  const sized = board.settings.snap && !mobile
    ? items.map(it => { const b = latticeBox(it, step); return { w: b.w, h: b.h }; })
    : null;
  const laid = order.map(i => (sized ? { ...items[i], ...sized[i] } : items[i]));

  const spots = arrange(laid, {
    name: board.arrangement,
    center: at,
    spacing: mobile ? 0 : board.settings.spacing,
    seed: (Math.random() * 0xffffffff) >>> 0,
  });
  let placed = laid.map((item, slot) => ({
    ...item,
    x: spots[slot].x,
    y: spots[slot].y,
  }));
  if (mobile) {
    const moving = new Set(items.map(item => item.id));
    const obstacles = whole ? [] : board.items.filter(item => !moving.has(item.id));
    // The chosen arrangement still decides reading order on a narrow board:
    // turn its slots into top-to-bottom, then left-to-right order before the
    // Mobile packer fits that sequence into the selected-width lattice.
    placed.sort((a, b) => b.y - a.y || a.x - b.x || a.id.localeCompare(b.id));
    // Rearrangement changes order and position, not the sizes already visible
    // on this layout. In particular, do not rebuild them from meta.presnap:
    // that is the geometry to restore when snapping is disabled, not a sizing
    // source for every later press of Rearrange.
    placed = placeMobileItems(placed, obstacles, { preserveSize: true });
  }
  // spots came back in shuffled order, so each one goes to the item that was
  // in that slot, not to the item at the same index in board.items.
  const target = new Array(items.length);
  if (mobile) {
    const byItem = new Map(placed.map(item => [item.id, item]));
    items.forEach((item, i) => { target[i] = byItem.get(item.id); });
  } else {
    order.forEach((itemIndex, slot) => { target[itemIndex] = placed[slot]; });
  }
  applyGeom(before.map((g, i) => {
    const at = {
      ...g,
      x: target[i].x,
      y: target[i].y,
      ...(mobile ? {
        w: target[i].w,
        h: target[i].h,
        rot: target[i].rot,
        presnap: target[i].meta?.presnap
          ? { ...target[i].meta.presnap }
          : null,
      } : {}),
    };
    if (!sized) return at;
    // Through latticeBox a second time, now with the slot the engine chose and
    // the size it laid out for. The sizes are already on the lattice and it
    // leaves them there; what this pass is for is the position, which an
    // arrangement had no reason to land on a line.
    return { ...at, ...latticeBox({ ...at, ...sized[i] }, step) };
  }));
  // Every item was placed by this, none of them towed - so every note asks
  // again what it landed on. A rearrangement that left the old piles recorded
  // would have notes travelling with photographs they are now nowhere near.
  commitGeom(whole ? 'Rearrange' : `Rearrange ${items.length} items`,
    before, before.map(g => g.id), mobile ? { preservePresnap: true } : {});
  // A whole-board layout rebuilds around the origin, so the view has to follow
  // it there or the rearrangement happens off screen. Free is the exception:
  // it shakes each item where it stands, and flying to fit the whole board
  // afterwards would move things on screen far more than the shake did -
  // hiding the change inside a much larger one.
  if (whole && (mobile || board.arrangement !== 'free')) vp.fit(board.items, 80, travelMs());
}

/** The centre of what a set of items covers. */
function middleOf(items) {
  const b = itemBounds(items);
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
}

// A console handle, deliberately public: `mbrd.board` to inspect state,
// `mbrd.cmds.fit()` to drive the app, `mbrd.vp` for the coordinate model.
window.mbrd = { board, bus, vp, cmds, selection };

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// A note being written is the one piece of board state that is not in `board`
// yet: its text lives in contenteditable DOM until the blur that ends the edit.
// So the page going away has to close the editor first, or the snapshot behind
// it saves the note's new *height* with its old text - and a tab that is closed
// or reclaimed mid-sentence loses the sentence.
//
// visibilitychange is the reliable one - a phone discarding the page may never
// run pagehide - and both are cheap, because flushNoteEdit() does nothing at
// all unless a note is actually open.
const flushEdits = () => { if (flushNoteEdit()) autosave().catch(() => {}); };
addEventListener('pagehide', flushEdits);
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushEdits();
});

const started = (async function start() {
  const restored = await restoreSession();
  openingView();
  if (restored) toast('Restored your last board');
  el('hud').hidden = !board.settings.hud;
  paintSnap();
  paintGrid(vp);
  paintPaper();
  paintCount();
  vp.apply();
  console.log('[mbrd] v' + VERSION + ' ready');
  warnMissingCapabilities();
})();

/**
 * A quiet floor check, run once the board is up (Safari audit S4).
 *
 * The app has a modern baseline: it opens a .mbrd by inflating deflate-raw
 * streams, asks its one question through <dialog>.showModal(), and paints its
 * palette with color-mix() - and below roughly Safari 16.4 one or more of those
 * is missing. This does not block the app. Most of it still runs, and a person
 * on an old browser told "unsupported" and shown nothing is worse off than one
 * with a degraded board. So it names what will actually break, once, in the
 * console and - for the one hard failure - a toast, so a later error reads as
 * expected rather than as a bug.
 *
 * The one hard failure is file interchange: a modern .mbrd deflates its entries
 * and there is no JavaScript inflate fallback, so a browser without
 * DecompressionStream('deflate-raw') cannot open boards from a newer one. The
 * rest degrade inside optional paths and are logged, not toasted.
 */
function warnMissingCapabilities() {
  let inflate = false;
  try { inflate = typeof DecompressionStream === 'function' && !!new DecompressionStream('deflate-raw'); }
  catch { inflate = false; }

  const degraded = [];
  if (typeof HTMLDialogElement === 'undefined' ||
      typeof HTMLDialogElement.prototype.showModal !== 'function') degraded.push('modal dialogs');
  if (typeof OffscreenCanvas === 'undefined') degraded.push('image optimisation and thumbnails');
  if (!(window.CSS && CSS.supports && CSS.supports('color', 'color-mix(in srgb, red, blue)'))) degraded.push('the full palette');

  if (!inflate || degraded.length) {
    console.warn('[mbrd] below the supported floor (Safari 16.4+). Unavailable: ' +
      [...(inflate ? [] : ['opening .mbrd files from a newer browser']), ...degraded].join(', ') +
      '. See docs/browser-support.md.');
  }
  if (!inflate) {
    toast('This browser can’t open .mbrd files made by a newer one — update it, or use the latest Safari, Chrome or Firefox.', 'error');
  }
}

// Installed as a PWA, "Open with mbrd" on a .mbrd hands us the file here
// (manifest.json file_handlers). The desktop equivalent lands in M4 via Tauri.
//
// Waits for start(), which is the whole of the fix. Both of these load a board
// and both register assets, and start() yields at its first await - so the OS
// handing over a file while IndexedDB was still being read had the two racing:
// whichever loadBoard() finished last won the board, while the asset registry
// ended up holding an interleaving of both. Restoring first and then opening
// over the top is the same result the user would get by opening the file
// themselves, which is what they asked for.
if ('launchQueue' in window) {
  launchQueue.setConsumer(async ({ files }) => {
    if (!files?.length) return;
    try {
      await started;
      await openFile(await files[0].getFile(), files[0]);
    } catch (err) { console.warn('[mbrd] launch file:', err); }
  });
}

if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('[mbrd] sw:', err));
  });
}
