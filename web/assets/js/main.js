// Boot: build the viewport, wire every subsystem to it, restore the last
// session, and expose the command set the sidebar and keyboard both drive.

import { toast, el, shuffle } from './util.js';
import { VERSION } from './version.js';
import {
  board, bus, selection, selectAll, removeItems, setSetting,
  snapshotGeom, applyGeom, commitGeom, undo, redo, byId,
  raiseSelection, lowerSelection, duplicateItems, select, setItemCover,
} from './state.js';
import { Viewport, MIN_ZOOM, MAX_ZOOM, zoomMs, travelMs } from './canvas/viewport.js';
import { paintGrid, resetGridInk } from './canvas/grid.js';
import { initItems, resetItems } from './canvas/items.js';
import { resetModels } from './canvas/model.js';
import { initWeb } from './canvas/web.js';
import { initStills } from './canvas/stills.js';
import { initInput } from './canvas/input.js';
import { initDrop, pickFiles, pickCover, addNote } from './import/drop.js';
import { arrange } from './arrange/arrangements.js';
import {
  initStorage, restoreSession, saveBoard, exportBoard, openBoard, newBoard, openFile, autosave,
} from './storage/storage.js';
import { flushNoteEdit } from './canvas/notes.js';
import { initAssets } from './storage/assets.js';
import { initSidebar, close as closeSidebar } from './ui/sidebar.js';
import { initMenu, openContextMenu, close as closeMenu } from './ui/menu.js';
import { initSearch, open as openSearch } from './ui/search.js';
import { initTrash } from './ui/trash.js';
import { initAppearance, resetAppearance } from './ui/appearance.js';
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
  save: () => saveBoard(),
  export: () => exportBoard(),
  exportAs: () => exportBoard({ pickNew: true }),

  addFiles: () => pickFiles(),
  addNote: () => {
    const item = addNote(vp.toWorld(vp.left + vp.cx, vp.top + vp.cy));
    requestAnimationFrame(() => cmds.editNote(item.id));
  },

  rearrange,
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
initInput(vp, cmds);
initMenu(vp, cmds);
initSearch(vp);
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

function paintZoom() {
  const pct = vp.zoom * 100;
  // Below 10% a rounded percentage flickers between 6 and 7 as you pinch, so
  // give the small end a decimal instead.
  el('zoom-level').textContent = (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%';
  for (const btn of el('zoom-ctl').querySelectorAll('[data-zoom]')) {
    if (btn.dataset.zoom === 'in') btn.disabled = vp.zoom >= MAX_ZOOM - 1e-6;
    if (btn.dataset.zoom === 'out') btn.disabled = vp.zoom <= MIN_ZOOM + 1e-9;
  }
}

bus.on('settings', key => {
  // The whimsy slider arrives here, and it moves the grid's colours as well as
  // its mark - so the resolved copy the Harsh crosses hold has to go back.
  if (key === 'appearance') resetGridInk();
  paintGrid(vp);
  if (key === 'hud') el('hud').hidden = !board.settings.hud;
});

bus.on('items', paintCount);
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
  vp.setView(board.view.pan, board.view.zoom);
  el('hud').hidden = !board.settings.hud;
  paintCount();
});

el('viewport').addEventListener('pointerdown', () => closeMenu());

el('viewport').addEventListener('pointermove', e => {
  const p = vp.toWorld(e.clientX, e.clientY);
  el('hud-xy').textContent = `${Math.round(p.x)}, ${Math.round(p.y)}`;
}, { passive: true });

function paintCount() {
  const n = board.items.length;
  el('hud-count').textContent = n === 0 ? 'nothing yet' : n + (n === 1 ? ' thing' : ' things');
}

// ---------------------------------------------------------------------------
// Commands that need more than a one-liner
// ---------------------------------------------------------------------------

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
  const spots = arrange(order.map(i => items[i]), {
    name: board.arrangement,
    center: { x: 0, y: 0 },
    spacing: board.settings.spacing,
    seed: (Math.random() * 0xffffffff) >>> 0,
  });
  // spots came back in shuffled order, so each one goes to the item that was
  // in that slot, not to the item at the same index in board.items.
  const target = new Array(items.length);
  order.forEach((itemIndex, slot) => { target[itemIndex] = spots[slot]; });
  applyGeom(before.map((g, i) => ({ ...g, x: target[i].x, y: target[i].y })));
  commitGeom('Rearrange', before);
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
  if (restored) {
    vp.setView(board.view.pan, board.view.zoom);
    toast('Restored your last board');
  } else {
    vp.recenter();
  }
  el('hud').hidden = !board.settings.hud;
  paintGrid(vp);
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
