// Boot: build the viewport, wire every subsystem to it, restore the last
// session, and expose the command set the sidebar and keyboard both drive.

import { toast } from './util.js';
import { VERSION } from './version.js';
import {
  board, bus, selection, selectAll, removeItems, setSetting,
  snapshotGeom, applyGeom, commitGeom, undo, redo, byId,
  raiseSelection, lowerSelection, duplicateItems, select,
} from './state.js';
import { Viewport, MIN_ZOOM, MAX_ZOOM, zoomMs, travelMs } from './canvas/viewport.js';
import { paintGrid } from './canvas/grid.js';
import { initItems, resetItems, nodeFor } from './canvas/items.js';
import { initWeb } from './canvas/web.js';
import { initStills } from './canvas/stills.js';
import { initInput } from './canvas/input.js';
import { initDrop, pickFiles, addNote } from './import/drop.js';
import { arrange } from './arrange/arrangements.js';
import {
  initStorage, restoreSession, saveBoard, openBoard, newBoard, openFile,
} from './storage/storage.js';
import { initSidebar, close as closeSidebar } from './ui/sidebar.js';
import { initMenu, openContextMenu, close as closeMenu } from './ui/menu.js';
import { initTrash } from './ui/trash.js';
import { initAppearance, resetAppearance } from './ui/appearance.js';
import { initAudio } from './ui/audio.js';
import { editNote, growNote } from './ui/notes.js';

const el = id => document.getElementById(id);

const vp = new Viewport(el('viewport'), el('world'), el('axis-x'), el('axis-y'), el('origin-mark'));

// ---------------------------------------------------------------------------
// Commands - the single surface the sidebar buttons and the keyboard share.
// data-cmd="save-as" resolves to cmds.saveAs, and so on.
// ---------------------------------------------------------------------------

const cmds = {
  new: () => newBoard(),
  open: () => openBoard(),
  save: () => saveBoard(),
  saveAs: () => saveBoard({ pickNew: true }),

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
  getSetting: key => board.settings[key],
  toggleSetting: key => setSetting(key, !board.settings[key]),
};

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

initAppearance();
initAudio();
initSidebar(cmds);
initItems(el('world'), vp);
initWeb(el('world'));
initStills(el('world'), vp);
initInput(vp, cmds);
initMenu(vp, cmds);
initTrash(vp);
initDrop(vp);
initStorage();

// The grid is screen-space, so it repaints on every view change - cheap: it is
// four CSS gradients, not a canvas.
vp.onChange(() => {
  paintGrid(vp);
  board.view.pan = { x: vp.pan.x, y: vp.pan.y };
  board.view.zoom = vp.zoom;
  paintZoom();
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
  resetItems();
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
  if (board.arrangement === 'free') {
    toast('Free keeps every position - pick another layout to rearrange');
    return;
  }
  const before = snapshotGeom(items.map(i => i.id));

  // Every layout is a pure function of the order it is handed, so feeding it
  // the item list twice puts everything back exactly where it already was -
  // and a button called "Rearrange everything" that does nothing the second
  // time you press it reads as broken. The shuffle is what makes it a
  // rearrangement rather than a re-application: same layout, items dealt into
  // it in a fresh order.
  const order = items.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const spots = arrange(order.map(i => items[i]), {
    name: board.arrangement,
    center: { x: 0, y: 0 },
    spacing: board.settings.spacing,
    // Scatter picks its own points from a seed. Left to itself it would hand
    // back the same disc every time and the shuffle would only permute items
    // between fixed spots; a fresh seed makes it a genuinely new scatter.
    seed: (Math.random() * 0xffffffff) >>> 0,
  });
  // spots came back in shuffled order, so each one goes to the item that was
  // in that slot, not to the item at the same index in board.items.
  const target = new Array(items.length);
  order.forEach((itemIndex, slot) => { target[itemIndex] = spots[slot]; });
  applyGeom(before.map((g, i) => ({ ...g, x: target[i].x, y: target[i].y })));
  commitGeom('Rearrange', before);
  vp.fit(board.items, 80, travelMs());
}

// A console handle, deliberately public: `mbrd.board` to inspect state,
// `mbrd.cmds.fit()` to drive the app, `mbrd.vp` for the coordinate model.
window.mbrd = { board, bus, vp, cmds, selection };

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

(async function start() {
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
if ('launchQueue' in window) {
  launchQueue.setConsumer(async ({ files }) => {
    if (!files?.length) return;
    try { await openFile(await files[0].getFile(), files[0]); }
    catch (err) { console.warn('[mbrd] launch file:', err); }
  });
}

if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('[mbrd] sw:', err));
  });
}
