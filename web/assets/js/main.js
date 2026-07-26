// Boot: build the viewport, wire every subsystem to it, restore the last
// session, and expose the command set the sidebar and keyboard both drive.

import { toast, el, shuffle } from './util.js';
import { formatLength, formatSize, scaleFrom, DEFAULT_SCALE, MM_PER_INCH } from './measure.js';
import { ask } from './ui/dialog.js';
import { VERSION } from './version.js';
import {
  board, bus, selection, selectAll, removeItems, setSetting,
  snapshotGeom, applyGeom, commitGeom, undo, redo, byId,
  raiseSelection, lowerSelection, duplicateItems, select, setItemCover,
  setItemUpAxis, historyState, baseStep,
} from './state.js';
import { latticeBox } from './geometry.js';
import { defaultUpAxis, meshKind } from './import/mesh.js';
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
  clearAllData,
} from './storage/storage.js';
import { flushNoteEdit, noteFloor } from './canvas/notes.js';
import { initAssets, getAsset } from './storage/assets.js';
import { initSidebar, close as closeSidebar } from './ui/sidebar.js';
import { initMenu, openContextMenu, close as closeMenu } from './ui/menu.js';
import { initSearch, open as openSearch } from './ui/search.js';
import { initKonami } from './ui/konami.js';
import { initIdle } from './ui/idle.js';
import { initScaleBar } from './ui/scalebar.js';
import { initTrash } from './ui/trash.js';
import { initAppearance, resetAppearance } from './ui/appearance.js';
import { initFonts } from './ui/fonts.js';
import { initAudio } from './canvas/audio.js';
import { editNote, growNote } from './canvas/notes.js';

const vp = new Viewport(el('viewport'), el('world'), el('axis-x'), el('axis-y'), el('origin-mark'));

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

  clearData: () => clearAllData(),

  rearrange,
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
  resetAppearance,

  selectAll,
  undo, redo,
  deleteSelection: () => {
    if (!selection.size) return;
    removeItems([...selection]);
  },
  closeSidebar,
  editNote,

  // --- right-click menu ---
  contextMenu: (x, y, id, count) => openContextMenu(x, y, id, count),
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
// Before initAppearance, so the type menus are built once with the board's own
// faces already in them rather than built empty and rebuilt a tick later.
initFonts();
// The grid's marks at Harsh are drawn rather than composed from gradients, so
// unlike every other tier they cannot follow a custom property on their own -
// see canvas/grid.js. Every edit to a look hands the resolved colours back and
// repaints; the other tiers repaint for nothing, which is four gradients.
initAppearance({ onChange: () => { resetGridInk(); paintGrid(vp); } });
initAudio();
initSidebar(cmds);
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
initKonami();
initIdle(vp);
initTrash(vp);
initDrop(vp);
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

function paintZoom() {
  const pct = vp.zoom * 100;
  // Below 10% a rounded percentage flickers between 6 and 7 as you pinch, so
  // give the small end a decimal instead.
  const text = (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%';
  const maxed = vp.zoom >= MAX_ZOOM - 1e-6;
  const mined = vp.zoom <= MIN_ZOOM + 1e-9;
  // This runs on every view change, and a pan is a view change that cannot
  // possibly have moved the zoom - so on the whole of a drag the answer is the
  // corner already on screen, and writing it again is a layout per frame for
  // nothing.
  //
  // The two buttons are in the key rather than behind the readout, because the
  // readout is rounded and they are not: the last hundredth of the way to the
  // floor reads as 2.0% for a while before it arrives, and hanging their state
  // off the text alone would leave the button enabled at the end of its travel.
  const key = text + (maxed ? '+' : '') + (mined ? '-' : '');
  if (key === zoomShown) return;
  zoomShown = key;
  el('zoom-level').textContent = text;
  for (const btn of el('zoom-ctl').querySelectorAll('[data-zoom]')) {
    if (btn.dataset.zoom === 'in') btn.disabled = maxed;
    if (btn.dataset.zoom === 'out') btn.disabled = mined;
  }
}

bus.on('settings', key => {
  // The whimsy slider arrives here, and it moves the grid's colours as well as
  // its mark - so the resolved copy the Harsh crosses hold has to go back.
  if (key === 'appearance') resetGridInk();
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
bus.on('settings', paintCount);
// A note can arrive with text already in it - pasted, duplicated, or loaded
// from a file saved before it grew - so it is sized for what it says as soon
// as it has a node to measure.
bus.on('items', () => requestAnimationFrame(() => {
  for (const it of board.items) if (it.type === 'note') growNote(it.id);
}));
bus.on('board:load', () => {
  // A board can bring its own look, applied without going through persist() -
  // so this is the other door the grid's colours change behind.
  resetGridInk();
  resetItems();
  // Parsed geometry is keyed by asset hash and the old board's assets are gone.
  resetModels();
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

function rearrange() {
  const items = board.items;
  if (!items.length) return;
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
  const sized = board.settings.snap
    ? items.map(it => { const b = latticeBox(it, step); return { w: b.w, h: b.h }; })
    : null;
  const laid = order.map(i => (sized ? { ...items[i], ...sized[i] } : items[i]));

  const spots = arrange(laid, {
    name: board.arrangement,
    center: { x: 0, y: 0 },
    spacing: board.settings.spacing,
    seed: (Math.random() * 0xffffffff) >>> 0,
  });
  // spots came back in shuffled order, so each one goes to the item that was
  // in that slot, not to the item at the same index in board.items.
  const target = new Array(items.length);
  order.forEach((itemIndex, slot) => { target[itemIndex] = spots[slot]; });
  applyGeom(before.map((g, i) => {
    const at = { ...g, x: target[i].x, y: target[i].y };
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
  commitGeom('Rearrange', before, before.map(g => g.id));
  // Every other layout rebuilds the board around the origin, so the view has
  // to follow it there or the rearrangement happens off screen. Free is the
  // exception: it shakes each item where it stands, and flying to fit the
  // whole board afterwards would move things on screen far more than the
  // shake did - hiding the change inside a much larger one.
  if (board.arrangement !== 'free') vp.fit(board.items, 80, travelMs());
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
})();

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
