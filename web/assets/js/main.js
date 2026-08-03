// Boot: build the viewport, wire every subsystem to it, restore the last
// session, and hand out the command set the sidebar and keyboard both drive.
//
// The wiring point and nothing else. What used to live here has moved out to
// the modules that own it - `commands.js` has the command surface,
// `ui/hud.js` the corner readouts, `ui/board-title.js` the board's name,
// `ui/board-actions.js` the commands that needed more than a one-liner,
// `ui/board-view.js` the framing, `perf/view-perf.js` the profiler. What is
// left is the order things are brought up in, the subscriptions that cross
// subsystems, and the lifecycle.
//
// The init order below is load-bearing and is commented where it is. This is
// one of only three modules allowed to touch a browser global at import time
// (tests/imports.test.js); everything it calls exports an init*() for exactly
// that reason.

import { toast, el } from './util.js';
import { ask } from './ui/dialog.js';
import { VERSION } from './version.js';
import {
  board, bus, selection, byId, setAssetNameLookup,
  ensureTitleCard, isTitleHidden, TITLE_ID,
  ensureGhostCards, hasGhosts, GHOST_IDS,
} from './state.js';
import { Viewport } from './canvas/viewport.js';
import { paintGrid, paintGridOnView, resetGridInk } from './canvas/grid.js';
import { initGrain, paintGrain, resetGrain } from './canvas/grain.js';
import { initPaper, paintPaper } from './canvas/paper.js';
import { initMobileFrame, paintMobileFrame } from './canvas/mobile-frame.js';
import { initItems, resetItems } from './canvas/items.js';
import { resetModels, resetModelInk } from './canvas/model.js';
import { initWeb } from './canvas/web.js';
import { initGhosts } from './canvas/ghosts.js';
import { initStills } from './canvas/stills.js';
import { initInput } from './canvas/input.js';
import { initDrop } from './import/drop.js';
import {
  initStorage, restoreSession, openFile, autosave, setPrompt,
} from './storage/storage.js';
import { flushNoteEdit, growNote } from './canvas/notes.js';
import { initAssets, getAsset } from './storage/assets.js';
import { initSidebar } from './ui/sidebar.js';
import { buildPanel } from './ui/panel.js';
import { armQuality, watchQuality } from './ui/quality.js';
import { initMenu, close as closeMenu } from './ui/menu.js';
import { initSearch } from './ui/search.js';
import { initIdle } from './ui/idle.js';
import { initScaleBar } from './ui/scalebar.js';
import { initTrash } from './ui/trash.js';
import { initNowPlaying } from './ui/nowplaying.js';
import { initToolbar } from './ui/toolbar.js';
import { initAppearance, resetAppearance, setWhimsy } from './ui/appearance.js';
import { initFonts } from './ui/fonts.js';
import { initMobileHeaderEditor, isPanelOpen as isHeaderPanelOpen, closePanel as closeHeaderPanel } from './ui/mobile-header.js';
import { initAudio } from './canvas/audio.js';

import { createCommands } from './commands.js';
import { createViewPerf, initPerfHash } from './perf/view-perf.js';
import { initBoardView, openingView, syncBoardMode, syncMobileBoardBounds } from './ui/board-view.js';
import { initHud, paintZoom, paintSnap, paintCount } from './ui/hud.js';
import { initBoardTitle } from './ui/board-title.js';
import { initBoardActions, resetSave } from './ui/board-actions.js';

const vp = new Viewport(el('viewport'), el('world'), el('origin-mark'));

// The three modules that only need the viewport handed to them, before anything
// that calls into them. None of these touches the DOM.
//
// ui/appearance.js is handed to createCommands() rather than imported by it:
// appearance is one of the three modules allowed a browser global at import
// time, and commands.js importing it would make that module unloadable without
// a DOM. The same injection shape as setAssetNameLookup() and setPrompt() below.
initBoardView(vp);
initBoardActions(vp);
const cmds = createCommands(vp, { resetAppearance, setWhimsy });

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

initAssets();
// Hand state the asset registry's filename lookup, which it cannot import
// (storage sits above state - AUD-12). This is the original-filename fallback
// renameItem() uses when a name is cleared.
setAssetNameLookup(hash => getAsset(hash)?.name);
// The saved quality level onto <html>, before anything reads a flag off it.
// The inline guard in index.html has already done this for the stylesheet; this
// is the module half, and it is also what fills `quality` for canvas/*.
armQuality();
// The panel's DOM, before every module that reaches into it by id:
// ui/appearance.js takes the whimsy slider, the palette menu and three hosts,
// canvas/audio.js takes the volume slider, and ui/sidebar.js takes the board
// name. None of them should have to learn that the panel is generated now.
buildPanel();
// Before initAppearance, so the type menus are built once with the board's own
// faces already in them rather than built empty and rebuilt a tick later.
initFonts();
// The grid's marks at Harsh are drawn rather than composed from gradients, so
// unlike every other tier they cannot follow a custom property on their own -
// see canvas/grid.js. Every edit to a look hands the resolved colours back and
// repaints; the other tiers repaint for nothing, which is four gradients.
// resetGrain for the same reason one line up: --grain is a token, and the layer
// caches whether it resolves to anything rather than asking per frame. Then a
// paint, because a look that turns the grain back on has a layer standing at
// whatever position it was left at when it went transparent.
initAppearance({
  // resetModelInk for the third: an uncoloured model card's still is stamped
  // with the ink it was drawn in, and a slider drag commits no setting - so
  // without this the cards compare against a stale colour for the whole gesture.
  onChange: () => {
    resetGridInk(); resetModelInk(); paintGrid(vp); resetGrain(); paintGrain(vp);
  },
});
initGrain(vp);
initAudio();
// paintGrain too: the two layouts keep their stock on different surfaces - the
// full-bleed layer on Desktop, the sheet itself on Mobile - so a mode switch
// hands the grain to an element that has never been placed. See canvas/grain.js.
bus.on('layout', () => { syncBoardMode(true); paintGrain(vp); });
syncBoardMode();
initSidebar(cmds);
initMobileHeaderEditor(vp);
initItems(el('world'), vp);
initWeb(el('world'), vp);
// One 'items' subscriber that sweeps the hint cards the first time the board
// holds anything of the user's. After initItems, so the nodes it animates out
// are mounted by the time it can fire. `cmds` is handed down because the fourth
// hint carries the whimsy dial, and canvas/ may not reach into ui/ to set it.
initGhosts(cmds);
initStills(el('world'), vp);
// After both of those: moving the dial remounts every card (the shadow twin and
// the display copy's size are decided at build time) and asks the freeze
// question again, so it needs the two modules that answer.
watchQuality();
initScaleBar(vp);
// Its own listeners rather than a call from the paint block below: the sheet is
// also a control - it is dragged by the corners to set the board's scale - so
// it owns an event surface as well as a drawing, the way every other init* does.
initPaper(vp);
// The Mobile sheet and masthead, which are screen-space chrome like the paper
// sheet and are painted off the same event for the same reason.
initMobileFrame(vp);
initInput(vp, cmds);
initMenu(vp, cmds);
initSearch(vp);
initIdle(vp);
initTrash(vp);
// After initAudio(), which is what reads the stored volume - the bar's slider
// paints itself from that value on the way up.
initNowPlaying();
initDrop(vp);
// The glass: the zoom cluster, undo/redo, and the readouts. After buildPanel()
// (its controls are in the static markup, but the save button it does not own
// is not) and after cmds exists, which it is handed.
initHud(vp, cmds);
// The toolbar, which is the other half of that glass and used to be two lines
// inside initHud() as the phone's add bar. Handed cmds for the same reason: its
// buttons are data-cmd and nothing else.
initToolbar(cmds);
// The board's name, on the masthead and on the Desktop card.
initBoardTitle();
// Hand storage the confirmation prompt it cannot import (ui sits above storage
// - AUD-12): the discard-unsaved and clear-everything dialogs.
setPrompt(ask);
initStorage();

// ---------------------------------------------------------------------------
// The view-change frame
// ---------------------------------------------------------------------------

// The grid is screen-space, so it repaints on every view change. Two tiers are
// four CSS gradients; Harsh draws its lattice, but only over the canvas, which
// is the viewport - so both are bounded by the screen rather than the board.
const viewPerf = createViewPerf(vp);

// The view is board state and is saved with the board, but it changes on every
// frame of a pan - so it is written here on each change and *announced* on a
// trailing timer. Without the announcement nothing scheduled an autosave, and a
// board closed after nothing but panning came back at the view it had before,
// which is not where the user left it. Without the timer, every pan would queue
// a snapshot per frame.
let viewSettle = 0;
// Everything the view-change frame does after the grid. Named so the profiler
// can time the grid alone against the rest without duplicating it.
const afterGrid = () => {
  // Inside the profiled listener rather than on a subscription of its own, and
  // that is the whole reason it is called from here. canvas/grain.js registers
  // before this file does, so a self-subscribed paint would run ahead of the
  // t0 below and land in neither half of the sample - the one full-screen
  // re-raster on the pan path would have been the one thing mbrd.perf could not
  // see. It belongs in restMs.
  paintGrain(vp);
  board.view.pan = { x: vp.pan.x, y: vp.pan.y };
  board.view.zoom = vp.zoom;
  paintZoom();
  clearTimeout(viewSettle);
  // Its own event rather than 'settings', which several modules repaint on -
  // and deliberately not markDirty(): looking around a board is not editing it,
  // and a pan that raised "unsaved changes" on the way out would be a lie.
  viewSettle = setTimeout(() => bus.emit('view'), 400);
};
vp.onChange(() => {
  // The fast path a shipped board always takes: one boolean read, then the same
  // work as ever. The performance.now() pair only runs once the dev handle asks
  // for it, so profiling costs nothing until turned on.
  // paintGridOnView, not paintGrid: on this one path a view change that moves
  // the grid less than a device pixel would repaint it into the same picture.
  // Every other caller here means "the grid itself changed" and calls paintGrid.
  if (!viewPerf.active) { paintGridOnView(vp); afterGrid(); return; }
  const t0 = performance.now();
  paintGridOnView(vp);
  const t1 = performance.now();
  afterGrid();
  viewPerf.sample(t1 - t0, performance.now() - t1);
});

// ---------------------------------------------------------------------------
// Subscriptions that cross subsystems
// ---------------------------------------------------------------------------

bus.on('settings', key => {
  // The whimsy slider arrives here, and it moves the grid's colours as well as
  // its mark - so the resolved copy the Harsh crosses hold has to go back.
  if (key === 'appearance') resetGridInk();
  if (key === 'gridStep' || key === 'mobileColumns') syncBoardMode();
  paintGrid(vp);
  if (key === 'hud') el('hud').hidden = !board.settings.hud;
  if (key === 'snap') paintSnap();
});

// The title card's edit menu is that card's own: deselect the card and the panel
// styling it closes with it. Desktop only - on Mobile the same panel belongs to
// the masthead and has no selection to follow.
bus.on('selection', () => {
  if (board.layoutMode !== 'mobile' && isHeaderPanelOpen() && !selection.has(TITLE_ID)) {
    closeHeaderPanel();
  }
});
bus.on('items', syncMobileBoardBounds);
bus.on('geom', syncMobileBoardBounds);
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
  // Seed the Desktop title card before the board is drawn. state.loadBoard()
  // deliberately leaves it out (so its own tests load an exact item set); the
  // app adds it here, and the payloadless 'items' emit that follows loadBoard()
  // mounts it. A board that carries or deleted its card is left untouched.
  ensureTitleCard();
  // And the hint cards, on the same terms and for the same reason: state.js
  // keeps loadBoard() free of both so its own tests can load and serialise an
  // exact item set. A board arriving with anything on it gets none - the latch
  // was set from its contents inside loadBoard().
  ensureGhostCards();
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

el('viewport').addEventListener('pointerdown', () => closeMenu());

// A console handle, deliberately public: `mbrd.board` to inspect state,
// `mbrd.cmds.fit()` to drive the app, `mbrd.vp` for the coordinate model,
// `mbrd.perf.on()` to profile the pan/zoom frame, `mbrd.debugGrips()` to see the
// resize hitboxes.
window.mbrd = { board, bus, vp, cmds, selection, perf: viewPerf, debugGrips: cmds.debugGrips };

// The profiler can be armed from the URL as well as from the console, which is
// the only way in on a phone - see initPerfHash. The grip overlay rides the same
// trick with `#grips`.
initPerfHash(viewPerf);
if (location.hash.includes('grips')) cmds.debugGrips();

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
// run pagehide. Both are cheap: flushNoteEdit() does nothing unless a note is
// open, and autosave() is a no-op when nothing has changed since the last write.
// The unconditional autosave matters now the background save is a 20s interval
// rather than a per-edit debounce - without it, a tab closed mid-interval would
// lose up to 20s of edits.
const flushEdits = () => { flushNoteEdit(); autosave().catch(() => {}); };
addEventListener('pagehide', flushEdits);
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushEdits();
});

const started = (async function start() {
  const restored = await restoreSession();
  // A restored or freshly-opened board runs ensureTitleCard() inside loadBoard();
  // the very first blank session never calls loadBoard, so seed the title card
  // here and mount it. initItems() has already run (module top), so its 'items'
  // listener is live and this renders the card without a reload.
  if (!restored) {
    ensureTitleCard();
    ensureGhostCards();
    const seeded = [
      ...(isTitleHidden() ? [] : [TITLE_ID]),
      ...(hasGhosts() ? GHOST_IDS : []),
    ];
    if (seeded.length) bus.emit('items', { added: seeded, removed: [] });
  }
  openingView();
  if (restored) toast('Restored your last board');
  el('hud').hidden = !board.settings.hud;
  paintSnap();
  paintGrid(vp);
  paintGrain(vp);
  paintPaper();
  paintMobileFrame();
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

/**
 * Take the boot cover off (index.html), now that there is a board under it.
 *
 * One frame later, not immediately: start() has just written the items, the
 * grid and the grain into the DOM and none of it has been painted yet, so
 * fading on this turn would uncover the same empty room the cover exists to
 * hide. A single rAF is enough - the fade itself is 400ms and the paint lands
 * inside it either way.
 *
 * The node is removed rather than left at opacity 0. It is fixed and
 * full-screen, so what it leaves behind is a compositing layer over the whole
 * board for the life of the session, and `transitionend` is not guaranteed to
 * arrive - a tab backgrounded mid-fade never fires it - hence the timer as
 * well. Both paths call remove(), which is safe twice.
 */
function dismissSplash() {
  const splash = el('splash');
  if (!splash) return;
  // #load holds the cover up indefinitely so the boot animation can be watched
  // at leisure - it is on screen for well under a second in the normal case,
  // which is not long enough to judge it. A dev switch in the same shape as
  // #grips and #perf, and like them it is not a state the app can reach on its
  // own: it is in the URL, so the way out is the URL. Nothing dismisses it -
  // deliberately, since a cover that lets go on a stray click or keypress is
  // one that ends the moment you lean on the desk to look at it.
  if (location.hash.includes('load')) return;
  requestAnimationFrame(() => {
    splash.classList.add('is-done');
    const drop = () => splash.remove();
    splash.addEventListener('transitionend', drop, { once: true });
    setTimeout(drop, 1200);
  });
}
// Both arms, deliberately: a boot that threw still has to give the page back.
// Whatever went wrong, the board underneath is more use than a cover nobody
// can dismiss - and the console already carries the failure.
started.then(dismissSplash, dismissSplash);

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
