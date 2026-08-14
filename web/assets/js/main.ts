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

import { el } from './util.ts';
import { toast } from './notify.ts';
import { initErrors, setBoardProbe } from './errors.ts';
import { initOverlays } from './ui/overlays.ts';
import { ask } from './ui/dialog.ts';
import { VERSION } from './version.js';
import {
  board, bus, selection, byId, setAssetNameLookup,
  ensureTitleCard, isTitleHidden, TITLE_ID, setTitle,
  ensureGhostCards, reseedGhostCards, hasContent, dismissGhosts,
  leaveNotFoundBoard, isContent,
  defaultBoardTitle,
} from './state.ts';
import { freezePrefs } from './prefs.ts';
import { homePath, isPatchPage, isNotFoundPage, openingFace } from './page.ts';
import { Viewport } from './canvas/viewport.ts';
import { paintGrid, paintGridOnView, resetGridInk } from './canvas/grid.ts';
import { initGrain, paintGrain, resetGrain } from './canvas/grain.ts';
import { initPaper, paintPaper } from './canvas/paper.ts';
import { initMobileFrame, paintMobileFrame } from './canvas/mobile-frame.ts';
import { initItems, resetItems } from './canvas/items.ts';
import { resetModels, resetModelInk } from './canvas/model.ts';
import { initWeb } from './canvas/web.ts';
import { initGhosts } from './canvas/ghosts.ts';
import { initStills } from './canvas/stills.ts';
import { initInput } from './canvas/input.ts';
import { initDrop } from './import/drop.ts';
import {
  initStorage, restoreSession, openFile, autosave, setPrompt, suspendCache,
  resetSessionLatches, boardSafety,
} from './storage/storage.ts';
import { flushNoteEdit, growNote } from './canvas/notes.ts';
import { initAssets, getAsset } from './storage/assets.ts';
import { initSidebar } from './ui/sidebar.ts';
import { buildPanel } from './ui/panel.ts';
import { armQuality, watchQuality } from './ui/quality.ts';
import { initMenu } from './ui/menu.ts';
import { initFencePrompt } from './ui/fence-prompt.ts';
import { initConnChip } from './ui/conn-chip.ts';
import { initSearch } from './ui/search.ts';
import { initIdle } from './ui/idle.ts';
import { initScaleBar } from './ui/scalebar.ts';
import { initTrash } from './ui/trash.ts';
import { initNowPlaying } from './ui/nowplaying.ts';
import { initToolbar } from './ui/toolbar.ts';
import { initFlyouts } from './ui/flyout.ts';
import { initStickerWindow } from './ui/sticker-window.ts';
import { initAppearance, resetAppearance, setWhimsy } from './ui/appearance.ts';
import { initFonts } from './ui/fonts.ts';
import { initMobileHeaderEditor, isPanelOpen as isHeaderPanelOpen, closePanel as closeHeaderPanel, styleFeedMasthead } from './ui/mobile-header.ts';
import { initAudio } from './canvas/audio.ts';
import { initFeed } from './ui/feed.ts';
import { initViewer } from './ui/viewer.ts';
import { initPlaylist } from './ui/playlist.ts';

import { createCommands } from './commands.ts';
import { createViewPerf, initPerfHash } from './perf/view-perf.ts';
import { initBoardView, openingView, syncBoardMode, syncMobileBoardBounds } from './ui/board-view.ts';
import { initHud, paintZoom, paintSnap, paintCount } from './ui/hud.ts';
import { initBoardTitle } from './ui/board-title.ts';
import { initBoardActions, resetSave } from './ui/board-actions.ts';

// Before anything else in this file, and before anything it imports can run:
// the toast and the waiting strip are how the app reports that something went
// wrong, which makes them the worst possible thing to wire late. notify.ts is
// the door every layer below ui/ says things through - it has to be, since a
// base or storage module importing ui/overlays.js is a layering inversion
// (tests/layers.test.js) - and until this call it forwards to nobody and every
// message is silently dropped. Same injection shape as setAssetNameLookup() and
// setPrompt() below; this one goes first because a lost toast is not an error,
// it is worse, it is nothing at all.

initOverlays();

/**
 * Which of the three pages this is, worked out once at the top and then only
 * read.
 *
 * The two questions - is this the changelog, is this an address the app does
 * not have - used to be derived here, in two IIFEs over document.baseURI. They
 * moved to page.ts when the changelog grew the app's real sidebar: the panel
 * has to know (it greys what needs a board) and so do the three View commands
 * (on the changelog they are the way back), and neither may import main.ts.
 * What that costs a reader is stated in the branch at the foot of this file and
 * in freezePrefs(): their session is never loaded, never written, and no
 * preference they nudge while reading is kept.
 *
 * Constants rather than calls, because a navigation would take the whole
 * document with it: within one run these are facts, not readings.
 */
const isPatch = isPatchPage();
const notFound = isNotFoundPage();

// Before initSidebar() below, which reads the stored layout mode and puts it
// back through the bus - a preference write. Nothing a visitor does while
// reading the changelog may change what they own; suspendCache() in start() is
// the other half of the same promise.
if (isPatch) freezePrefs();

// And immediately after it, for the same reason one step further on: an
// exception that reaches the top of the stack, or a promise nobody was waiting
// on, has no other way of being seen by the person it happened to. Everything
// below this line - the viewport against real elements, every init*() in the
// wiring block, the session restore - is inside its reach, which is the whole
// point of it going second. See errors.ts; the toast it raises goes out through
// the channel the line above just wired, so the order of these two is the order
// they have to be in.
//
// The probe is what makes the message worth reading: storage/session.ts holds
// the latches that know whether the autosave covered the last edit, and this
// hands that question over without errors.ts ever learning what a save is.
initErrors();
setBoardProbe(boardSafety);

// Every `el(...)!` in this file is one of the ids index.html declares. They are
// part of the page's own markup rather than anything the app puts there, so an
// absent one is a broken build and not a state to recover from - the same call
// the rest of the app makes, and the same non-null it makes it with.
const vp = new Viewport(el('viewport')!, el('world')!, el('origin-mark')!);

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
setAssetNameLookup((hash: string) => getAsset(hash)?.name);
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
// And the hint cards are minted again for the layout that is now live. They are
// the one thing on an empty board that cannot carry two geometry profiles: every
// real item is completed into the profile it is missing from, but a hint is
// seeded straight into whichever layout was live when the board turned out to be
// empty, and is never in board.layouts at all because it is never saved. So a
// switch used to drag the column's sizes onto the canvas - four cards at strip
// width, stacked down the middle of an infinite board.
//
// Here rather than inside setBoardMode(), for the reason ensureGhostCards() is
// called from this file at all: layout.js is a floor under state.js and may not
// import it back, and seeding a hint is a state write. main.js already owns both
// of the other seeding sites.
bus.on('layout', () => { reseedGhostCards(); syncBoardMode(true); paintGrain(vp); });
syncBoardMode();
initSidebar(cmds);
initMobileHeaderEditor(vp);
initItems(el('world')!, vp);
initWeb(el('world')!, vp);
// One 'items' subscriber that sweeps the hint cards the first time the board
// holds anything of the user's. After initItems, so the nodes it animates out
// are mounted by the time it can fire. `cmds` is handed down because the fourth
// hint carries the whimsy dial, and canvas/ may not reach into ui/ to set it.
initGhosts(cmds);
initStills(el('world')!, vp);
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
// The Mobile Playlist lens - a native-scrolling audio player shown over the
// board's two mobile faces. The Feed is the masonry wall on #mobile-feed; the
// Playlist is the audio player, filling #mobile-playlist as the Mobile board's
// second lens and doubling as the floating window on the Desktop board. Each owns
// its own surface and bus wiring, so its build is driven by the
// 'layout'/'lens'/'board:load' events rather than by these lines, which only hand
// each the DOM and the shared masthead styler.
initFeed(vp, cmds, styleFeedMasthead);
initPlaylist(vp, cmds, styleFeedMasthead);
// One item, full size, on both layouts. Takes nothing: it reads the board and
// the asset store directly and is opened by id, so there is no viewport and no
// command surface in it - see the head of the module.
initViewer();
initInput(vp, cmds);
initMenu(vp, cmds);
// The offer that follows a rubber band. Takes the viewport and not cmds: the
// action is handed in when the offer is made, so it never needs the command
// surface - see the head of the module.
initFencePrompt(vp);
initSearch(vp);
// Not on the changelog. The idle fade exists to get the board's furniture out
// of the way of the board - fifteen still seconds and the chrome steps back so
// what you are looking at is what you made. /patch has nothing behind the
// chrome to look at: it is a page of prose, and reading a page of prose is
// fifteen still seconds by definition. What it faded there was the one control
// the page has, and a faded control takes pointer-events: none with it - so the
// menu button went and the sidebar could not be opened at all. See the same
// trap, from the other side, in research/ui-audit-2026-08-13.md.
if (!isPatch) initIdle(vp);
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
// What is behind three of those buttons, shown by hovering them. After the
// toolbar because it marks the bar's own markup with aria-haspopup, and after
// initMenu() because the panel it opens is that module's and the close hook it
// registers would otherwise be overwritten on init.
initFlyouts(cmds);
// The sticker pad. After the toolbar, because the toolbar is what opens it, and
// handed both the viewport and cmds: it turns a pointer position into a world
// point itself (a drag ends over the board, not over a button) and then presses
// the ordinary command with it.
initStickerWindow(vp, cmds);
// The five buttons that follow a marked connection. After the toolbar because
// it is the same kind of thing - chrome over the board driven by cmds - and it
// needs the viewport to know where on the screen the line it is pinned to is.
initConnChip(cmds, vp);
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
  if (key === 'hud') el('hud')!.hidden = !board.settings.hud;
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
  // No grow-all here: loadBoard() emits a payloadless 'items' right after this,
  // whose else-branch above already re-grows every note in one rAF pass. Doing it
  // in both places sized every note on the board twice on each load.
  openingView();
  el('hud')!.hidden = !board.settings.hud;
  paintSnap();
  paintCount();
  // A different board has never been saved, whatever the last one's button
  // said. Leaving the countdown up would be the new board claiming a write that
  // happened to something else.
  resetSave();
});

/**
 * The two globals this file is the only writer or reader of.
 *
 * `mbrd` is the console handle below - declared here rather than in a .d.ts
 * because this is the line that creates it, and a global whose only assignment
 * and only declaration are three lines apart cannot drift. Its type is read off
 * the object itself, so adding a key to the handle needs nothing here.
 *
 * `launchQueue` is the PWA file-handling entry point (see the block at the foot
 * of this file). It is not in lib.dom yet; only the two members used are named,
 * because a wider guess would be a claim about an API this app only ever asks
 * one thing of.
 */
declare global {
  // eslint-disable-next-line no-var
  var launchQueue: {
    setConsumer(consumer: (params: { files?: FileSystemFileHandle[] }) => void): void;
  } | undefined;
  interface Window { mbrd: typeof handle }
}

// A console handle, deliberately public: `mbrd.board` to inspect state,
// `mbrd.cmds.fit()` to drive the app, `mbrd.vp` for the coordinate model,
// `mbrd.perf.on()` to profile the pan/zoom frame, `mbrd.debugGrips()` to see the
// resize hitboxes, `mbrd.debugWheel()` to print what a touchpad swipe delivered.
const handle = {
  board, bus, vp, cmds, selection, perf: viewPerf,
  debugGrips: cmds.debugGrips, debugWheel: cmds.debugWheel,
};
window.mbrd = handle;

// The profiler can be armed from the URL as well as from the console, which is
// the only way in on a phone - see initPerfHash. The grip overlay and the swipe
// log ride the same trick with `#grips` and `#wheel`.
initPerfHash(viewPerf);
if (location.hash.includes('grips')) cmds.debugGrips();
if (location.hash.includes('wheel')) cmds.debugWheel();

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

/**
 * The moment a not-found board stops being one.
 *
 * A blank board at a dead address is a message, and a message you have started
 * dropping things onto is a board. So the first piece of real content hands the
 * whole thing over: the address becomes the app's own, the two cards are swept
 * the way any earned-away hint is, and the writer comes back on.
 *
 * The order below is the entire correctness argument, so:
 *
 * 1. The stored session is read FIRST, and what the visitor just made is put
 *    back on top of it. This is the part that would be easy to get wrong and
 *    expensive to get wrong: the not-found board never loaded their board, so
 *    simply switching the writer back on would autosave a board containing one
 *    dropped photograph over a board containing everything they own. Loading
 *    theirs and re-adding the new items means the drop lands on their board -
 *    which is also, as it happens, what somebody who dropped a file on mbrd
 *    was expecting to happen.
 * 2. The listener is detached before any of it, because restoreSession() emits
 *    'items' itself and would otherwise re-enter this on its way through.
 * 3. resetSessionLatches() is last. It is the one that undoes the suspendCache()
 *    at boot, and nothing may be written until the board underneath is the real
 *    one.
 *
 * replaceState rather than assign: a navigation would throw away the very thing
 * that triggered the handover. The address is corrected in place, so a reload
 * from here is an ordinary load of an ordinary board, and the wrong URL is not
 * left in the history for the back button to find.
 */
async function leaveNotFound() {
  bus.off('items', onFirstContent);
  leaveNotFoundBoard();
  // Before anything replaces the board, because an open composer holds its card
  // outside #world: resetItems() would call el.remove() on a node living in
  // #compose-mount, the blur re-parents it inside the browser's own removal
  // step, and the throw takes the rest of the handover with it. This is the same
  // synchronous close the way out of the page uses.
  flushNoteEdit();
  history.replaceState(null, '', homePath() + location.search + location.hash);
  // Everything the visitor has put here, collected *after* the await and not
  // before. On this board that is all there is: the title card is furniture and
  // the two cards are ghosts, so isContent() names exactly the new items and
  // nothing else - but restoreSession() yields for a chunked asset read that can
  // run for hundreds of milliseconds, and a second file dropped inside that
  // window would otherwise go down with loadBoard()'s wholesale reassignment of
  // board.items, undo entry and all. `held` keeps the pre-load array, which
  // loadBoard() replaces rather than mutates, so late arrivals are still in it.
  const held = board.items;
  const had = await restoreSession();
  const mine = held.filter(isContent);
  if (had) {
    // Straight onto the restored board, at the coordinates they already have.
    //
    // Not through addItems(), which commits - and the handover is not an edit
    // somebody made, so it has no business in the undo history. And not nudged
    // clear of what is already there either, which was tried and taken out
    // again: two notes added on an ordinary board land on exactly the same
    // spot, so an arrival sitting on top of a card is not a handover artefact,
    // it is what this app does. Inventing a rule here that the board itself
    // does not have would make the wrong-URL path the odd one out.
    board.items.push(...mine);
    bus.emit('items', { added: mine.map(i => i.id), removed: [] });
    toast('Moved to your board');
  } else {
    // No stored board to merge into, so nothing overwrote the name the way
    // loadBoard() does on the other branch. Left alone 'Not found' persists: the
    // writer is about to come back on, that name fails isDefaultTitle(), and the
    // board is called it on the title card, in the masthead and in the file
    // Export would write.
    setTitle(defaultBoardTitle());
  }
  dismissGhosts();
  resetSessionLatches();
  // And write it, rather than leaving it to the next edit or the 20s tick.
  //
  // This is the one moment the board is at its most fragile: the visitor is
  // three seconds into a page they arrived at by mistake, the odds of them
  // closing the tab are high, and until this line runs there is a board in
  // memory that has never been on disk. The commit that brought them here
  // requested a save of its own, but that request was made while the writer was
  // still suspended and its cooldown then holds the next one off for seconds.
  // So the handover commits itself.
  autosave().catch(() => {});
}

/** Bound once so it can be taken off again inside the handover. */
const onFirstContent = () => { if (hasContent()) leaveNotFound(); };

const started = (async function start() {
  // Before anything can fire a write. A not-found boot opens a blank board, and
  // a blank board that autosaved would be the app quietly replacing whatever
  // the visitor already had with nothing - the one outcome a wrong URL must not
  // have. So the writer is stopped first and the session is never read: their
  // board is not loaded here, not shown here, and cannot be lost here.
  //
  // The changelog is as much a stranger to the session as a dead address is:
  // the page shows a document, the board behind it is hidden by patch.css and
  // stays empty, and the visitor's own board is neither loaded nor shown nor -
  // above all - written over. It seeds no title card and no hints either: those
  // are furniture for an empty board somebody is about to use, and this is a
  // board nobody is looking at.
  if (notFound || isPatch) suspendCache();
  const restored = (notFound || isPatch) ? false : await restoreSession();
  // A restored or freshly-opened board runs ensureTitleCard() inside loadBoard();
  // the very first blank session never calls loadBoard, so seed the title card
  // here and mount it. initItems() has already run (module top), so its 'items'
  // listener is live and this renders the card without a reload.
  if (isPatch) {
    // The board behind the changelog stays empty - it is hidden, and nothing is
    // going to be dropped on it - but it is still named, because the panel's
    // Board tab shows that name in its field and an unnamed board would put the
    // date there instead.
    setTitle('Patch notes');
  } else if (!restored) {
    // The board's own name says it too, on the title card and in the Mobile
    // masthead - the two places the board names itself. Through setTitle() so
    // both hear about it; it marks nothing dirty, and the writer is off anyway.
    if (notFound) setTitle('Not found');
    ensureTitleCard();
    const ghosts = ensureGhostCards({ notFound });
    const seeded = [
      ...(isTitleHidden() ? [] : [TITLE_ID]),
      ...ghosts,
    ];
    if (seeded.length) bus.emit('items', { added: seeded, removed: [] });
    // Armed after the seeding, not before: mounting the cards emits 'items'
    // itself, and a listener watching for the first content would have fired on
    // the message announcing the message. hasContent() would have said no and
    // it would have been harmless, but arming after the board is standing is
    // the version that stays harmless when the seeding changes.
    if (notFound) bus.on('items', onFirstContent);
  }
  // Which of the board's three faces the URL asked for, which is the far end of
  // goHome() in page.ts: the changelog's View row cannot switch a lens, because
  // on that page there is no board to switch, so it navigates and leaves the
  // face behind as a fragment for this line to pick up.
  //
  // After the session, because a lens belongs to a board and until the line
  // above there was none. Before openingView(), because entering the mobile
  // layout reframes the view itself and a frame taken first would be thrown
  // away. Not on the two boards nobody owns - a dead address and the changelog
  // both open a board that is not the visitor's, and neither has a face worth
  // asking for.
  const face = (notFound || isPatch) ? null : openingFace();
  if (face) cmds[face]();
  openingView();
  if (restored) toast('Restored your last board');
  el('hud')!.hidden = !board.settings.hud;
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
      '. See research/docs/browser-support.md.');
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
  // Non-null because the line above is the feature test: the global is declared
  // optional since a browser without it has no such name at all, which is also
  // why the test is `in window` rather than a read of the binding.
  launchQueue!.setConsumer(async ({ files }) => {
    if (!files?.length) return;
    try {
      await started;
      await openFile(await files[0].getFile(), files[0]);
    } catch (err) { console.warn('[mbrd] launch file:', err); }
  });
}

if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      // A new worker installing while a page is already controlled means a fresh
      // build shipped mid-session. sw.js self-promotes (skipWaiting + claim), so
      // the code swaps under the running tab; tell the user rather than reload out
      // from under them (jarring mid-import or mid-edit). Guarded on an existing
      // controller so the first-ever install stays silent.
      reg.addEventListener('updatefound', () => {
        const fresh = reg.installing;
        if (!fresh) return;
        fresh.addEventListener('statechange', () => {
          if (fresh.state === 'installed' && navigator.serviceWorker.controller) {
            toast('New version ready — reload to update');
          }
        });
      });
    }).catch(err => console.warn('[mbrd] sw:', err));
  });
}
