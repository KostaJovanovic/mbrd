// Boot: build the viewport, wire every subsystem, restore the session, hand
// out the command set. Init order is load-bearing and tested by
// tests/boot-order.test.js — moving or adding a call means updating that test.
// One of three modules allowed to touch browser globals at import time.

import { el, rafThrottle, wasClosed, itemHashes } from './util.ts';
import { toast } from './notify.ts';
import { initErrors, setBoardProbe, reportCaught } from './errors.ts';
import { setRiskPrompt } from './consent.ts';
// The Electron adapter — window.mbrdDesktop is read only in this file.
import { platform, isDesktop, refForHandle, setPlatform, setUpdateOffer } from './platform/platform.ts';
import { electronPlatform, electronStore } from './platform/electron.ts';
import type { Bridge } from './platform/electron.ts';
import type { ShareProvider } from './storage/cloud/provider.ts';
import type { SyncStop } from './storage/cloud/sync.ts';
import { setStoreBackend } from './storage/idb.ts';
import { initOverlays } from './ui/overlays.ts';
import { initLeaveGuard } from './ui/leaving.ts';
import { initTimeline } from './ui/timeline-view.ts';
import { ask } from './ui/dialog.ts';
import { VERSION } from './version.js';
import {
  board, bus, selection, select, byId, setAssetNameLookup, setAssetPurge, setClipboardCarry, isMultiSelect,
  ensureTitleCard, isTitleHidden, TITLE_ID, setTitle,
  ensureGhostCards, reseedGhostCards, hasContent, dismissGhosts,
  leaveNotFoundBoard, isContent, markBenchBoard,
  defaultBoardTitle,
  goTo, timelineSteps, timelineStale, lastCommand,
} from './state.ts';
import { freezePrefs } from './prefs.ts';
import { homePath, isPatchPage, isNotFoundPage, isBenchPage, openingFace, openingShare } from './page.ts';
import { Viewport, travelMs } from './canvas/viewport.ts';
import { setMissingCheck } from './canvas/item-dom.ts';
import { paintGrid, paintGridOnView } from './canvas/grid.ts';
import { initGrain, paintGrain } from './canvas/grain.ts';
import { initFarLands } from './canvas/farlands.ts';
import { initClean, dealSong } from './ui/clean/clean.ts';
import { initPaper } from './canvas/paper.ts';
import { initMobileFrame } from './canvas/mobile-frame.ts';
import { repaintGround, forgetLookInk } from './canvas/ground.ts';
import { initItems, resetItems, setUnpack, setRetryPicture, setSpotlessSong } from './canvas/items.ts';
import { resetModels } from './canvas/model.ts';
import { initWeb, joinDump } from './canvas/web.ts';
import { initGhosts } from './canvas/ghosts.ts';
import { initStills } from './canvas/stills.ts';
import { initHires } from './canvas/hires.ts';
import { initInput } from './canvas/input.ts';
import { initPictureShapes } from './canvas/picture-shape.ts';
import { initDrop, importFiles, setImportPrompt, setImportRevealer, noteToFile, retryPicture } from './import/drop.ts';
import { unpackItem } from './import/unpack.ts';
import {
  initStorage, restoreSession, openFile, autosave, setPrompt, setBoardThumb,
  suspendCache, resetSessionLatches, failHandover, boardSafety, openSharedBoard,
  boardSyncState, pushBoardToCloud, adoptFolder, saveDocument, compactDocument,
  refreshBoardThumb, boardFolder, setShowItems,
} from './storage/storage.ts';
import { looksLikeMbrd } from './storage/mbrd.ts';
import { boardThumb } from './ui/snapshot.ts';
import { flushNoteEdit, growNote, setNoteMenu, setNoteOverflow, fitsNote, unfileNote } from './canvas/notes.ts';
import type { NoteEntrance } from './canvas/notes.ts';
import { setMarkdownRenderer, setEmbedEnrich } from './canvas/renderers.ts';
import { enrichEmbed } from './canvas/embed-meta.ts';
import { renderMarkdown } from './ui/markdown.ts';
import { enableMath } from './ui/math.ts';
import { initAssets, getAsset, forgetAssets, putAsset } from './storage/assets.ts';
import type { Asset } from './storage/assets.ts';
import { forgetDisplay } from './canvas/display.ts';
import { initSidebar } from './ui/sidebar.ts';
import { buildPanel, paintPanel } from './ui/panel.ts';
import { armQuality, watchQuality } from './ui/quality.ts';
import { initMenu, isMenuOpen, openAnchored, justDismissed } from './ui/menu.ts';
import { initFencePrompt } from './ui/fence-prompt.ts';
import { initConnChip } from './ui/conn-chip.ts';
import { initSearch } from './ui/search.ts';
import { initIdle } from './ui/idle.ts';
import { initBackfill } from './optimize/backfill.ts';
import { initScaleBar } from './ui/scalebar.ts';
import { initDrawer } from './ui/drawer.ts';
import { initNowPlaying } from './ui/nowplaying.ts';
import { initToolbar } from './ui/toolbar.ts';
import { initFlyouts } from './ui/flyout.ts';
import { initStickerWindow } from './ui/sticker-window.ts';
import { initAppearance, resetLook, setWhimsy } from './ui/appearance.ts';
import { initFonts } from './ui/fonts.ts';
import { initMobileHeaderEditor, isPanelOpen as isHeaderPanelOpen, closePanel as closeHeaderPanel, styleFeedMasthead } from './ui/mobile-header.ts';
import { initAudio } from './canvas/audio.ts';
import { cue, initCuelume, setCueLog, cueLog, dumpCueLog, soundLevel, setSoundLevel } from './cuelume/engine.ts';
import { initFeed, revealInFeed } from './ui/feed.ts';
import { initViewer, openViewer, flushEditor, holdTyping, setRevealInFeed } from './ui/viewer.ts';
import { initDarkroom } from './ui/darkroom.ts';
import { initInventory } from './ui/inventory.ts';
import { initPlaylist } from './ui/playlist.ts';
import { initTour } from './ui/tour.ts';
import { initTourEdit } from './ui/tour-edit.ts';

import { createCommands } from './commands.ts';
import { createViewPerf, initPerfHash } from './perf/view-perf.ts';
import { createBench } from './perf/bench.ts';
import { buildStandardBoard } from './perf/bench-board.ts';
import { initBenchView } from './ui/bench-view.ts';
import { initBoardView, openingView, syncBoardMode, syncMobileBoardBounds } from './ui/board-view.ts';
import { initHud, paintZoom, paintSnap, paintTilt, paintCount } from './ui/hud.ts';
import { initBoardTitle } from './ui/board-title.ts';
import { initBoardActions, resetSave } from './ui/board-actions.ts';

// First: wire the toast overlay so every module below can report errors.
// Until this call, notify.ts forwards to nobody and messages are lost.

initOverlays();

// Every external link, board-wide, confirms before it leaves mbrd. A capture
// listener on the document, so it covers link cards, the Feed, rendered markdown
// and the credits without any of them wiring it up. Cheap and page-agnostic.
initLeaveGuard();

// The only read of window.mbrdDesktop. Before anything touches the store —
// a backend swapped after the first read would mix two stores.
const bridge = window.mbrdDesktop;
if (bridge) {
  setPlatform(electronPlatform(bridge));
  setStoreBackend(electronStore(bridge));
  // Shell startup messages (e.g. portable fallback path). Not awaited.
  void bridge.startupNotes()
    .then(note => { if (note) toast(note); })
    .catch(() => {});
}

/** Page type, resolved once. Constants because a navigation replaces the document. */
const isPatch = isPatchPage();
const notFound = isNotFoundPage();
// The benchmark's own boot (#bench): a generated board that belongs to nobody.
const benchPage = isBenchPage();

// Before initSidebar() — no preference writes on the changelog page, and none
// from the benchmark, whose switches must not outlive it.
if (isPatch || benchPage) freezePrefs();
// Before anything can write: every writer asks this latch (onboarding.ts).
if (benchPage) markBenchBoard();

// After initOverlays() so error toasts have a channel. The probe lets errors.ts
// report whether unsaved work exists without importing storage.
initErrors();
setBoardProbe(boardSafety);

// Catch-all: a throw before `started` is assigned leaves #splash covering
// the error toast. This removes it so the failure can be read.
addEventListener('error', () => dismissSplash());

// Non-null: these ids are in index.html's static markup.
const vp = new Viewport(el('viewport')!, el('world')!, el('origin-mark')!);

// Viewport-only modules, before anything calls into them.
// appearance is injected into createCommands() to keep commands.ts DOM-free.
initBoardView(vp);
initBoardActions(vp);
// Profiler created here so cmds can arm it from the Debug fold.
const viewPerf = createViewPerf(vp);
// The Look tab's Reset takes the picture count back with the look.
// The benchmark's screen is built from cmds, so cmds reaches it late.
const cmds = createCommands(vp, {
  resetAppearance: resetLook, setWhimsy, perf: viewPerf,
  bench: { open: () => benchView.open(), run: opts => benchView.run(opts) },
});
const benchView = initBenchView({
  bench: createBench({
    vp, cmds, perf: viewPerf,
    glass: bridge?.bench?.frames ?? null,
    platform: bridge ? (bridge.shell === 'capacitor' ? 'android' : 'desktop') : 'web',
    buildBoard: buildStandardBoard,
  }),
  // Into bench/ in the boards folder where the shell can; a download (or, on
  // an older shell, a save picker) where it cannot.
  save: async (name, json) => {
    if (bridge?.bench) return bridge.bench.save(name, json);
    await platform.files.write({ name }, new Blob([json], { type: 'application/json' }));
    return name;
  },
  standardPage: benchPage,
});

// Native menu maps command names to cmds. Optional chaining guards against an
// older shell naming a command this build removed.
// After start(), as a handed-over file waits: a row pressed on /patch brings
// the board back, and its command must not land on a board a restore replaces.
bridge?.onCommand(name => {
  // SAFETY: runtime typeof check before calling.
  const run = (cmds as Record<string, unknown>)[name];
  if (typeof run !== 'function') {
    console.warn('[mbrd] the menu asked for a command that is not here:', name);
    return;
  }
  void started.then(() => run(), () => run());
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

initAssets();
// Injected: storage sits above state. Fallback for renameItem() when a name is cleared.
setAssetNameLookup((hash: string) => getAsset(hash)?.name);
// Injected for the same reason: the clipboard's bytes, held from the copy so a
// paste on the next board brings its pictures (clipboard.ts). itemHashes() is
// the walk the packer uses, so no class of reference is left behind.
setClipboardCarry({
  hold: items => {
    const held = new Map<string, Asset>();
    for (const it of items) {
      for (const hash of itemHashes(it)) {
        const asset = getAsset(hash);
        if (asset) held.set(hash, asset);
      }
    }
    return held;
  },
  restore: held => {
    for (const [hash, a] of held) putAsset(hash, a.blob, { mime: a.mime, ext: a.ext, name: a.name });
  },
});
// Which cards name a file the registry does not hold, for the mark that says
// so (canvas/item-dom.ts) - the same itemHashes() walk as the carry above.
setMissingCheck(it => itemHashes(it).some(hash => !getAsset(hash)));
// "Show them" from a layer below the viewport (storage/session.ts).
bus.on('reveal', ids => {
  const items = board.items.filter(i => ids.includes(i.id));
  if (!items.length) return;
  select(items.map(i => i.id));
  if (!vp.isMobile) vp.fit(items, 120, travelMs());
});
// Purge seam for emptying the bin — clears both the asset registry and display cache.
setAssetPurge((hashes: Set<string>) => {
  forgetDisplay(hashes);
  return forgetAssets(hashes);
});
// A note written past the sheet limit becomes a .md document — injected
// because making one hashes a file, and canvas/ may not import import/. One
// that outgrew itself mid-sentence opens in the editor, growing out of the note,
// and turns back into it if written back down to fit before the editor closes.
setNoteOverflow(async (id, markdown, open) => {
  const held = open ? holdTyping(open.stay?.host) : null;
  const note = byId(id);
  const was = lastCommand();
  const made = await noteToFile(id, markdown, !!open);
  // The step that made the document, which turning back takes back.
  const turned = lastCommand() === was ? null : lastCommand();
  const back = note && made
    ? { fits: fitsNote, back: (md: string, before: string, into: NoteEntrance) => void unfileNote(made, note, turned, md, before, into) }
    : undefined;
  if (made && open) openViewer(made, { ...open, held, edit: true, note: back, over: open.stay?.go });
  else held?.take();
  return !!made;
});
// Note toolbar menu — injected because canvas/ may not import ui/.
setNoteMenu((anchor, rows, current, pick) => {
  // Second press closes instead of reopening — menu already shut by outside-press.
  if (justDismissed(anchor)) return;
  openAnchored(anchor.getBoundingClientRect(), rows.map(row => ({
    label: row.label,
    swatch: row.swatch,
    check: row.value === current,
    action: () => pick(row.value),
  })), {
    // Label from the button's own aria-label — two buttons share this menu.
    label: anchor.getAttribute('aria-label') || 'Font',
    focus: true,
    // Disambiguates which button owns this menu instance.
    owner: anchor,
  });
});
// Markdown renderer injected into canvas/ (layering: ui/ above canvas/).
setMarkdownRenderer(renderMarkdown);
// Formulas typeset by KaTeX from here on; unwired (a test, the patch page) they stay their TeX.
enableMath();
// The one hook that fetches: a Spotify card fills in its title and cover on
// load if it has none. Unwired (a test) this never runs and nothing is fetched.
if (!isPatch) setEmbedEnrich(enrichEmbed);
// Before anything reads a quality flag.
armQuality();
// Interface sounds (Web Audio blips, not content playback). Before buildPanel()
// so the Sounds dial reads the stored level. Skipped on /patch.
if (!isPatch) initCuelume();
// Panel DOM, before modules that reach into it by id.
buildPanel();
// Before initAppearance so type menus have the board's fonts already.
initFonts(vp);
// Harsh grid marks are drawn (not CSS gradients), so appearance changes must
// flush the resolved colour caches and repaint grid + grain.
initAppearance({
  onChange: () => {
    forgetLookInk(); paintGrid(vp); paintGrain(vp);
  },
});
initGrain(vp);
// Board-edge warning mark.
initFarLands(vp);
initAudio();
// Reseed hints on layout change (layout.ts may not import state.ts) and
// repaint grain (Desktop/Mobile use different surfaces).
bus.on('layout', () => { reseedGhostCards(); syncBoardMode(true); paintGrain(vp); });
syncBoardMode();
initSidebar(cmds, vp);
// What the phone's updater says. An offer shows as the sidebar's first row,
// wired after buildPanel(), which built the row. A passing answer to Check for
// updates is the page's own toast, never a pop-up of the system's
// (research/old/done-2026-09-15.md, R7). The desktop never calls it.
// An offer also toasts once, because the row on its own is not an answer: it
// is the top of the Board tab, Check for updates is a button on the System
// tab, and on a phone the press closes the panel - so the whole reply to
// "check for updates" landed somewhere nobody was looking. The toast carries
// the row's own press as its button, so the update can be taken from where the
// news arrives. A download's progress ticks repeat the same state and version,
// and only the first of them says anything. Any other repeat is an answer to
// Check for updates - an update found and downloaded at start, asked for again
// - and must be said again, or the press looks like it did nothing.
let saidOffer = '';
platform.updates.onOffer(offer => {
  if (offer?.state === 'said') {
    if (offer.note) toast(offer.note);
    return;
  }
  setUpdateOffer(offer);
  paintPanel();
  const news = offer ? `${offer.state} ${offer.version}` : '';
  if (offer?.state === 'downloading' && news === saidOffer) return;
  saidOffer = news;
  // 'downloading' is already counting on the row, so it offers no button.
  if (offer?.note) {
    toast(offer.note, offer.state === 'failed' ? 'error' : '',
      offer.state === 'downloading' ? undefined : { label: 'Update', run: () => { void cmds.installUpdate(); } });
  }
});
initMobileHeaderEditor(vp);
initItems(el('world')!, vp);
// Photo cards follow their pictures' shapes, and a print's at Softish.
initPictureShapes();
initWeb(el('world')!, vp);
// The konami-code easter egg (ui/clean/). Nothing happens until the code is
// typed; this only hands it the camera and wires its bar.
initClean(vp);
// Sweeps hint cards on first real content. After initItems so nodes are mounted.
// cmds passed because canvas/ may not import ui/ (whimsy dial on the hint card).
initGhosts(cmds);
initStills(el('world')!, vp);
// Swaps a plain photo card to its full original when zoomed past the ~1024px
// display copy, and back to the copy when zoomed out. The high-zoom opposite of
// initStills; both hang off vp.onChange.
initHires(el('world')!, vp);
// After initItems + initStills: quality changes remount every card.
watchQuality();
initScaleBar(vp);
// The paper sheet is also a drag control, not just a drawing.
initPaper(vp);
// Mobile sheet and masthead, painted off the same viewport event.
initMobileFrame(vp);
// Feed (masonry wall) and Playlist (audio player), each with own bus wiring.
initFeed(vp, cmds, styleFeedMasthead);
initPlaylist(vp, cmds, styleFeedMasthead);
// Full-size viewer. Reads board + assets directly; no viewport needed.
initViewer(cmds);
// Crop + adjustment dials. Same as viewer: opened by id, writes through state.ts.
initDarkroom();
// Inventory (board contents + sizes). Takes vp for the camera.
initInventory(vp);
// Before initInput so arrow/Escape keys have a tour runner to query.
initTour(vp);
// After buildPanel(), which creates the slot this fills.
initTourEdit();
initInput(vp, cmds);
initMenu(vp, cmds);
// Fence prompt after rubber-band selection.
initFencePrompt(vp);
initSearch(vp, revealInFeed);
setRevealInFeed(revealInFeed);
// Skipped on /patch: idle fade would hide the only controls on a prose page.
// And on #bench, where a fade landing mid-scenario would be measured.
if (!isPatch && !benchPage) initIdle(vp);
// Skipped on /patch: backfill writes to the board, which the changelog must not.
// And on #bench: its work in the background would be in every scenario's frames.
if (!isPatch && !benchPage) initBackfill();
initDrawer(vp);
// After initAudio() so the slider shows the stored volume.
initNowPlaying();
// After the player — CSS sibling combinator requires this DOM order.
// Takes cmds: Play frames the board after every step it draws.
initTimeline(cmds);
initDrop(vp);
// Unzip and Open on a card. Injected: canvas/ may not reach import/.
setUnpack(id => { void unpackItem(id); });
// Retry on a picture that came in as a named card, the same way.
setRetryPicture(id => { void retryPicture(id); });
// The song button on the Spotless card, the same way and for the same reason.
setSpotlessSong(id => { void dealSong(id); });
// HUD (zoom cluster, undo/redo, readouts). After buildPanel() and cmds.
initHud(vp, cmds);
// Toolbar: buttons are data-cmd, needs cmds.
initToolbar(cmds);
// Flyouts behind toolbar buttons. After toolbar + initMenu().
initFlyouts(cmds);
// Sticker pad. After toolbar (which opens it). Needs vp for world-space drop.
initStickerWindow(vp, cmds);
// Connection action chip. Needs vp for screen position of the line.
initConnChip(cmds, vp);
// Board name on masthead + Desktop title card.
initBoardTitle();
// Injected: ui sits above storage. Clear-everything dialog.
setPrompt(ask);
// Import confirmation. danger: false — opening a file is not destructive.
setImportPrompt(opts => ask({ ...opts, danger: false }));
// The import summary's "Show them": wholly outside the view, then framed.
setImportRevealer({
  offScreen: items => {
    const r = vp.visibleRect();
    return items.every(i => i.x + i.w / 2 < r.x0 || i.x - i.w / 2 > r.x1
      || i.y + i.h / 2 < r.y0 || i.y - i.h / 2 > r.y1);
  },
  show: ids => {
    const items = board.items.filter(i => ids.includes(i.id));
    if (items.length) vp.fit(items, 120, travelMs());
  },
});
// A merge's receipt flies to the merged block the same way.
setShowItems(ids => {
  const items = board.items.filter(i => ids.includes(i.id));
  if (items.length) vp.fit(items, 120, travelMs());
});
// Size ceiling prompt (consent.ts). Three answers: yes / yes-to-all / no.
// Unwired default is allow (deliberate — see consent.ts).
setRiskPrompt(async opts => {
  const answer = await ask({ ...opts, keep: 'Allow all', danger: false });
  return answer === 'go' ? 'go' : answer === 'keep' ? 'all' : 'no';
});
// Board thumbnail — injected because import paths sit below ui/.
setBoardThumb(boardThumb);
initStorage();

// ---------------------------------------------------------------------------
// The view-change frame
// ---------------------------------------------------------------------------

// View is saved with the board but changes every pan frame. Written immediately,
// announced on a trailing 400ms timer so autosave fires without per-frame snapshots.
let viewSettle = 0;
// Named so the profiler can time the grid separately.
const afterGrid = () => {
  // Inside the profiled listener so the grain repaint lands in restMs.
  paintGrain(vp);
  board.view.pan = { x: vp.pan.x, y: vp.pan.y };
  board.view.zoom = vp.zoom;
  paintZoom();
  clearTimeout(viewSettle);
  // 'view' not 'settings', and not markDirty() — panning is not editing.
  viewSettle = setTimeout(() => bus.emit('view'), 400);
};
vp.onChange(() => {
  // paintGridOnView (not paintGrid): skips repaint when the grid moved less than 1 device px.
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
  // Appearance changes invalidate the grid's resolved colour caches.
  if (key === 'appearance') forgetLookInk();
  if (key === 'gridStep' || key === 'mobileColumns') syncBoardMode();
  paintGrid(vp);
  if (key === 'hud') el('hud')!.hidden = !board.settings.hud;
  if (key === 'snap') paintSnap();
  if (key === 'tilt') paintTilt();
});

// Close title-card editor when the card is deselected (Desktop only).
bus.on('selection', () => {
  if (board.layoutMode !== 'mobile' && isHeaderPanelOpen() && !selection.has(TITLE_ID)) {
    closeHeaderPanel();
  }
});
// Sync is-picking class from the flag on every selection event (three exit paths).
bus.on('selection', () => {
  document.documentElement.classList.toggle('is-picking', isMultiSelect());
});
bus.on('items', syncMobileBoardBounds);
bus.on('geom', syncMobileBoardBounds);

// Arriving notes need measuring. Ids are gathered across emits and grown in one
// rAF pass — rafThrottle alone would drop all but the last emit's arrivals.
let toGrow: Set<string> | null = new Set();
const growArrivals = rafThrottle(() => {
  const ids = toGrow;
  toGrow = new Set();
  // Delta names arrivals; null (board load) grows all notes.
  if (ids) {
    for (const id of ids) if (byId(id)?.type === 'note') growNote(id);
  } else {
    for (const it of board.items) if (it.type === 'note') growNote(it.id);
  }
});
bus.on('items', delta => {
  if (delta && delta.added) {
    // null means full sweep — adding more ids changes nothing.
    if (toGrow) for (const id of delta.added) toGrow.add(id);
  } else {
    toGrow = null;
  }
  growArrivals();
});
bus.on('board:load', () => {
  // loadBoard() omits the title card so tests can load exact item sets.
  ensureTitleCard();
  // Same: hints seeded here, not in loadBoard().
  ensureGhostCards();
  // New board may bring its own look — flush resolved colour caches.
  forgetLookInk();
  resetItems();
  // Old board's asset hashes are gone.
  resetModels();
  syncBoardMode();
  // No grow-all: the payloadless 'items' emit after loadBoard() handles it.
  openingView();
  el('hud')!.hidden = !board.settings.hud;
  paintSnap();
  paintTilt();
  paintCount();
  // A different board has never been saved.
  resetSave();
});

/** `mbrd` console handle + `launchQueue` PWA file-handling (not in lib.dom yet). */
declare global {
  // eslint-disable-next-line no-var
  var launchQueue: {
    setConsumer(consumer: (params: { files?: FileSystemFileHandle[] }) => void): void;
  } | undefined;
  interface Window {
    mbrd: typeof handle;
    /** Desktop shell bridge, if present. Only read from this file. */
    mbrdDesktop?: Bridge;
  }
}

// Console handle: board, bus, vp, cmds, selection, perf, debugGrips, joins, sound.
// sound.log() transcripts every cue — its value is the lines that are missing.
const handle = {
  board, bus, vp, cmds, selection, perf: viewPerf,
  debugGrips: cmds.debugGrips,
  joins: joinDump,
  sound: {
    log: setCueLog,
    dump: dumpCueLog,
    entries: cueLog,
    level: soundLevel,
    setLevel: setSoundLevel,
  },
};
window.mbrd = handle;

// URL-armed profiler (#perf) and grip overlay (#grips) — only way in on mobile.
initPerfHash(viewPerf);
if (location.hash.includes('grips')) cmds.debugGrips();

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Flush in-flight note edits + autosave on page close. Latched until start()
// finishes restoreSession() — without that, a close during the IDB read would
// autosave the blank default over the real board and sweep its assets.
// Wired through lifecycle port so the desktop can await the flush before quit.
let sessionReady = false;
const markSessionReady = () => { sessionReady = true; };
const flushEdits = async () => {
  if (!sessionReady) return;
  flushNoteEdit();
  // A document open in the editor, written into the board before the board is.
  await flushEditor();
  await autosave().catch(() => {});
  // The board's picture as it is leaving, into its file, so the board list
  // shows it next time. Apps only: a browser tab hides on every tab switch.
  if (boardFolder()) await refreshBoardThumb().catch(() => {});
  // The board's file too, on a desktop with a boards folder. A no-op elsewhere.
  await saveDocument().catch(() => {});
  // Going away is the quietest moment there is: see compactDocument().
  await compactDocument().catch(() => {});
};
platform.lifecycle.onCloseRequested(flushEdits);

// A minute with no edit is the other quiet moment. Armed by a load too, so a
// board opened only to look at still gets its dead bytes dropped.
const QUIET_MS = 60_000;
let quietTimer = 0;
for (const evt of ['items', 'geom', 'item', 'settings', 'board', 'trash', 'board:load'] as const) {
  bus.on(evt, () => {
    clearTimeout(quietTimer);
    quietTimer = window.setTimeout(() => void compactDocument().catch(() => {}), QUIET_MS);
  });
}

/**
 * Hand a not-found board over to a real one when the user drops content.
 * Restores the stored session first, then re-adds the dropped items on top —
 * without that, autosave would overwrite their board with the blank.
 * Order: detach listener → restore → re-add → resetSessionLatches (last,
 * because it re-enables writes and the board underneath must be real by then).
 */
async function leaveNotFound() {
  bus.off('items', onFirstContent);
  leaveNotFoundBoard();
  // Close composer before board replacement — its card lives outside #world.
  flushNoteEdit();
  history.replaceState(null, '', homePath() + location.search + location.hash);
  // Capture items before restore — restoreSession() replaces board.items and
  // a second drop during the IDB read would be lost without this snapshot.
  const held = board.items;
  const had = await restoreSession();
  const mine = held.filter(isContent);
  if (had) {
    // Bypass addItems() — handover is not an undoable edit.
    board.items.push(...mine);
    bus.emit('items', { added: mine.map(i => i.id), removed: [] });
    toast('Moved to your board');
  } else {
    // No stored board — clear the "Not found" title.
    setTitle(defaultBoardTitle());
  }
  dismissGhosts();
  resetSessionLatches();
  // Force-save now — the board has never been on disk and the tab may close.
  autosave().catch(() => {});
}

/** Bound once — removed inside leaveNotFound() to prevent re-entry. */
const onFirstContent = () => {
  if (!hasContent()) return;
  // Must catch: a throw after replaceState() would leave the writer suspended
  // with the address already corrected, silently losing all further edits.
  leaveNotFound().catch(e => {
    failHandover();
    reportCaught(e, 'the move to your own board');
  });
};

const started = (async function start() {
  // Suspend writes for not-found, patch and bench pages — a board that is not
  // the user's must never autosave over the stored one.
  const notTheirs = notFound || isPatch || benchPage;
  if (notTheirs) suspendCache();
  const restored = notTheirs ? false : await restoreSession();
  // Session restored — safe to autosave on close now.
  markSessionReady();
  // The desktop's boards folder: every board a file, moved there on the first
  // start. Not awaited, and every write and shelving waits for it. Before the
  // share link below, which shelves. Does nothing on the web.
  if (!notTheirs) void adoptFolder();
  // First blank session never calls loadBoard(), so seed the title card here.
  if (isPatch) {
    // Named so the panel's Board tab has something to show.
    setTitle('Patch notes');
  } else if (benchPage) {
    // No hints: the board is generated a moment from now, and loadBoard()
    // would only take them off again. See the benchmark's start below.
    setTitle('Benchmark');
  } else if (!restored) {
    // Through setTitle() so both title card and masthead hear it.
    if (notFound) setTitle('Not found');
    ensureTitleCard();
    const ghosts = ensureGhostCards({ notFound });
    const seeded = [
      ...(isTitleHidden() ? [] : [TITLE_ID]),
      ...ghosts,
    ];
    if (seeded.length) bus.emit('items', { added: seeded, removed: [] });
    // First blank session never calls loadBoard(), so cue 'arrive' manually.
    // Not on not-found — a wrong address is not an arrival.
    if (!notFound) cue('arrive');
    // After seeding — mounting cards emits 'items' and would re-enter.
    if (notFound) bus.on('items', onFirstContent);
  }
  // A reload opens at the newest step. The file keeps the playhead where it
  // stood, so a board left after a few undos came back that many steps back,
  // with the newest steps ahead of it. Not on a stale history, which replays
  // nothing, and not on opening a file, which is not a reload.
  if (restored && !timelineStale()) goTo(timelineSteps().length);
  // Restore the URL-requested lens (e.g. #timeline). After session, before
  // openingView() — mobile reframes the view and an earlier read would be lost.
  const face = notTheirs ? null : openingFace();
  if (face) cmds[face]();
  openingView();
  // Open a ?s= share link. Not awaited — the fetch is a network hop and must
  // not block first paint. A failed fetch leaves the local board intact.
  if (!notTheirs) openIncomingShare();
  // After session — needs a real board. Writer is suspended on not-found/patch/bench.
  if (!notTheirs) initCloudSync();
  if (restored) toast('Restored your last board');
  el('hud')!.hidden = !board.settings.hud;
  paintSnap();
  paintTilt();
  repaintGround(vp);
  paintCount();
  vp.apply();
  console.log('[mbrd] v' + VERSION + ' ready');
  warnMissingCapabilities();
})();

/**
 * Push to cloud on autosave. Stops on any failure (expired token, network,
 * conflict) and tells the user once — retry needs a gesture anyway. Being
 * offline is the exception: it waits for the connection instead.
 * Latch is per-board, cleared on board:load / board:new, and by the gesture:
 * a push that lands (Sync now) or a sign-in (syncResumes() in cloud/sync.ts).
 */
let syncStopped: SyncStop | null = null;

function initCloudSync() {
  // Reset latch when a different board arrives.
  for (const arrival of ['board:load', 'board:new'] as const) {
    bus.on(arrival, () => {
      syncStopped = null;
      // Re-read sync state for the new board and repaint the panel.
      void boardSyncState().then(() => paintPanel()).catch(() => {});
    });
  }
  /**
   * Offline is a wait, not a failure. A push that cannot reach the network
   * latched "Cloud sync stopped" in red, and nothing came back for it when the
   * connection did. So: say it once, quietly, and push again on `online`. Only
   * when the browser reports itself offline - a conflict, or a failure while
   * online, still latches.
   */
  let waiting = false;
  const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
  const waitForLine = () => {
    if (waiting) return;
    waiting = true;
    toast('Offline — this board will sync when the connection is back');
    addEventListener('online', () => { waiting = false; push(); }, { once: true });
  };
  const push = () => {
    let at: number | null = null;
    let provider: ShareProvider | null = null;
    const stop = () => { syncStopped = { at, signedIn: !!provider?.signedIn() }; };
    void (async () => {
      const state = await boardSyncState();
      if (!state) return;
      if (offline()) { waitForLine(); return; }
      at = state.at;
      const { shareProvider } = await import('./storage/cloud/cloud.ts');
      provider = shareProvider(state.provider);
      if (syncStopped) {
        const { syncResumes } = await import('./storage/cloud/sync.ts');
        if (!syncResumes(syncStopped, at, !!provider?.signedIn())) return;
        syncStopped = null;
      }
      // No token: expired, or never given in this tab. Stop and say so once.
      if (!provider?.signedIn()) {
        stop();
        // The press is the gesture a sign-in window needs.
        toast('Signed out of Drive — this board is not syncing', '',
          { label: 'Connect', run: () => { void cmds.connectGdrive(); } });
        return;
      }
      const out = await pushBoardToCloud();
      if (!out.ok) {
        stop();
        toast('This board changed somewhere else — press Sync now to sort it out', 'error');
      }
    })().catch(err => {
      // The line went down mid-push: the same wait as above, not a stop.
      if (offline()) { waitForLine(); return; }
      stop();
      console.warn('[mbrd] cloud sync stopped:', err);
      toast('Cloud sync stopped — press Sync now to try again', 'error');
    });
  };
  bus.on('autosaved', push);
}

/**
 * Open the board a ?s= share link names. Clears the param from the URL first
 * (replaceState) so a reload does not re-fetch. No retry — a revoked or
 * deleted link will not improve on a second attempt.
 */
function openIncomingShare(): void {
  const raw = openingShare();
  if (!raw) return;
  void (async () => {
    const { parseShareRef } = await import('./storage/cloud/provider.ts');
    const ref = parseShareRef(raw);
    if (!ref) {
      toast('That share link is not one this app can read', 'error');
      return;
    }
    try {
      history.replaceState(null, '', homePath() + location.hash);
    } catch (err) {
      // Non-fatal: a reload just re-opens it; openFile() shelves what was there.
      console.warn('[mbrd] could not clear the share link from the address', err);
    }
    await openSharedBoard(ref);
  })().catch(err => reportCaught(err, 'the shared board'));
}

/**
 * Floor check for Safari 16.4+ baseline. Logs degraded features; toasts only
 * for the hard failure (no DecompressionStream = cannot open .mbrd files).
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
 * Remove the boot splash one frame later (rAF) so the board has painted.
 * Timer backs up transitionend — a backgrounded tab may never fire it.
 */
function dismissSplash() {
  const splash = el('splash');
  if (!splash) return;
  // #load in the URL holds the splash indefinitely (dev switch for the animation).
  if (location.hash.includes('load')) return;
  requestAnimationFrame(() => {
    splash.classList.add('is-done');
    const drop = () => splash.remove();
    splash.addEventListener('transitionend', drop, { once: true });
    setTimeout(drop, 1200);
  });
}
// Both arms: a failed boot still has to dismiss the splash.
started.then(dismissSplash, dismissSplash);
// The #bench boot builds its board and runs, once the page is up and the
// splash is on its way out - the splash's own fade must not be in a scenario.
if (benchPage) void started.then(() => benchView.boot());

// PWA file handler (manifest.json file_handlers). Waits for start() so the
// session restore finishes before the file open — without that the two race.
if ('launchQueue' in window) {
  launchQueue!.setConsumer(async ({ files }) => {
    if (!files?.length) return;
    try {
      await started;
      await openFile(await files[0].getFile(), refForHandle(files[0]));
    } catch (err) { console.warn('[mbrd] launch file:', err); }
  });
}

// Files a shell hands over: a double-click, argv or macOS open-file on the
// desktop, "Open with" and "Share to" on Android. Same wait-for-start rule as
// the PWA path above. A board opens. Everything else lands as cards in the
// middle of the view, as a picked file does in import/drop.ts.
platform.lifecycle.onOpenFiles(files => {
  if (!files.length) return;
  const boardFile = files.find(f => looksLikeMbrd(f.file));
  const content = files.filter(f => !looksLikeMbrd(f.file)).map(f => f.file);
  void (async () => {
    try {
      await started;
      if (boardFile) await openFile(boardFile.file, boardFile.ref);
      if (content.length) await importFiles(content, vp.toWorld(vp.left + vp.cx, vp.top + vp.cy));
    } catch (err) { console.warn('[mbrd] open file:', err); }
  })();
});

// The phone's Back - the Android shell's, or a phone browser's through webBack()
// in platform.ts: close the top layer as Escape would, and answer whether
// anything closed. A menu is above everything, a modal dialog above the rest.
// A synthetic key does not close a <dialog>, so its cancel event is sent here,
// as the browser sends it for Escape. The other layers answer the Escape itself
// and mark it (markClosed in util.ts).
platform.lifecycle.onBack(() => {
  const dialogs = document.querySelectorAll('dialog[open]');
  const top = dialogs[dialogs.length - 1];
  if (top instanceof HTMLDialogElement && !isMenuOpen()) {
    if (top.dispatchEvent(new Event('cancel', { cancelable: true }))) top.close();
    return true;
  }
  const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(esc);
  return wasClosed(esc);
});

if (!isDesktop() && 'serviceWorker' in navigator) {
  // New worker mid-session = fresh deploy. Toast "reload to update" rather than
  // reloading under the user. Silent on the first-ever install.
  const announce = (fresh: ServiceWorker | null) => {
    if (!fresh) return;
    const say = () => {
      if (fresh.state === 'installed' && navigator.serviceWorker.controller) {
        // The button, because an installed copy has no address bar to reload
        // from. restart() stores the board before it reloads.
        toast('New version ready — reload to update', '',
          { label: 'Reload', run: () => { void cmds.restart(); } });
      }
    };
    // Both: a worker already in `waiting` won't fire another statechange.
    say();
    fresh.addEventListener('statechange', say);
  };
  const registerWorker = () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => announce(reg.installing));
      // Catch an already-in-progress update that 'updatefound' missed.
      announce(reg.installing ?? reg.waiting);
    }).catch(err => console.warn('[mbrd] sw:', err));
  };
  // Defer to 'load' so registration does not compete with first paint.
  // Falls back to immediate if the event already fired.
  if (document.readyState === 'complete') registerWorker();
  else addEventListener('load', registerWorker);
}
