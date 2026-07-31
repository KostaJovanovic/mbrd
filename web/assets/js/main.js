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
  setItemUpAxis, setItemFit, historyState, baseStep, mobileBoardWidth, mobileBoardTop,
  mobileBoardBottom, placeMobileItems, setTitle, markDirty,
  recheckBoardGeometry, cleanBoardTitle, cleanBoardTitleDraft, isDefaultTitle,
  setBoardMode as selectBoardMode, setAssetNameLookup,
  isRider, stuckTo, stuckPlacement,
  ensureTitleCard, restoreTitleCard, isTitleHidden, resetTitlePosition, TITLE_ID,
  ensureGhostCards, hasGhosts, GHOST_IDS,
} from './state.js';
import { latticeBox, itemBounds } from './geometry.js';
import { defaultUpAxis, meshKind } from './mesh.js';
import {
  Viewport, MIN_ZOOM, MAX_ZOOM, BASE_ZOOM, zoomMs, travelMs, mobilePerfFlags,
} from './canvas/viewport.js';
import { paintGrid, resetGridInk } from './canvas/grid.js';
import { initPaper, paintPaper } from './canvas/paper.js';
import { initMobileFrame, paintMobileFrame } from './canvas/mobile-frame.js';
import { initItems, resetItems, cullProfile, viewStats } from './canvas/items.js';
import { isTurning, resetModels, rotateModel } from './canvas/model.js';
import { initWeb } from './canvas/web.js';
import { initGhosts } from './canvas/ghosts.js';
import { initStills } from './canvas/stills.js';
import { initInput } from './canvas/input.js';
import { initDrop, pickFiles, pickCover, addNote } from './import/drop.js';
import { arrange, mobileOrder } from './arrange/arrangements.js';
import { defaultSize, measureSize } from './canvas/renderers.js';
import {
  initStorage, restoreSession, saveBoard, exportBoard, openBoard, newBoard, openFile, autosave,
  clearAllData, setPrompt,
} from './storage/storage.js';
import { flushNoteEdit, noteFloor } from './canvas/notes.js';
import { initAssets, getAsset } from './storage/assets.js';
import { initSidebar, close as closeSidebar } from './ui/sidebar.js';
import { buildPanel } from './ui/panel.js';
import { armQuality, watchQuality } from './ui/quality.js';
import { clearQualityOverrides } from './quality.js';
import { initMenu, openContextMenu, close as closeMenu } from './ui/menu.js';
import { initSearch, open as openSearch } from './ui/search.js';
import { initIdle } from './ui/idle.js';
import { initScaleBar } from './ui/scalebar.js';
import { initTrash } from './ui/trash.js';
import { initAppearance, resetAppearance, setWhimsy } from './ui/appearance.js';
import { initFonts } from './ui/fonts.js';
import {
  initMobileHeaderEditor, openPanel as openHeaderPanel, closePanel as closeHeaderPanel,
  isPanelOpen as isHeaderPanelOpen,
} from './ui/mobile-header.js';
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
  // Hints are left where they are. An arrangement is a statement about how the
  // board's contents relate, and three cards that are about to leave are not
  // contents - dealing them slots would also scatter them out of reading order.
  rearrange: () => rearrange(board.items.filter(i => i.type !== 'ghost')),
  // The whimsy axis, as a command so the dial on the fourth hint card can drive
  // it - that card is built under canvas/, which cannot import ui/appearance.js.
  setWhimsy: level => setWhimsy(level),
  rearrangeSelection: () => rearrange(board.items.filter(i => selection.has(i.id))),
  // The Desktop title card's pen: opens the same style panel the Mobile masthead
  // uses. Routed through cmds so canvas/input.js (which has no business importing
  // a ui/ module) can trigger it off the pen hit.
  editTitle: () => (isHeaderPanelOpen() ? closeHeaderPanel() : openHeaderPanel()),
  // Inline rename of the board name on the card: the T button, a double-click, or
  // F2. Routed through cmds so canvas/input.js can reach it off those gestures.
  editTitleText: () => editTitleCard(),
  restoreTitle: () => restoreTitleCard(),
  // The title card's own right-click menu keys off this - it is a singleton with
  // a different set of actions (no copy, no duplicate; edit its style, reset it).
  isTitleCard: id => byId(id)?.type === 'title',
  resetTitlePosition: () => resetTitlePosition(),
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
  // The title card is left out on Mobile for the same reason canvas/items.js
  // does not mount it there: it is not on that board. Fitting the view to a card
  // nobody can see - parked above the column by completeLayout() - would zoom
  // out to make room for nothing.
  fit: () => vp.fit(
    board.items.filter(i => board.layoutMode !== 'mobile' || i.type !== 'title'),
    80, travelMs()),
  recenter: () => vp.recenter(travelMs()),
  // Dev: paint the resize corner grab zones, which have no ink of their own, so
  // their reach can be checked by eye (see [data-debug-grips] in app.css). A
  // toggle that reflects on its own sidebar button; also on mbrd.debugGrips()
  // and the #grips URL. Grips only show on a selected card, so select one first.
  debugGrips: () => {
    const on = document.documentElement.toggleAttribute('data-debug-grips');
    document.querySelector('[data-cmd="debug-grips"]')?.setAttribute('aria-pressed', String(on));
    return on;
  },
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
  // Hands every quality flag back to the dial. The same way back Appearance's
  // fold keeps, for the same reason: a panel of overrides with no way home is a
  // panel you stop touching.
  resetQuality: () => {
    clearQualityOverrides();
    toast('Quality back to the dial');
  },
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

  // Fill (crop to the card) or fit (whole picture in) - only photos and videos.
  // itemFit reports the *effective* fit (the item's own override, else the
  // board-wide default), which is what the menu ticks; setItemFit pins it.
  canSetFit: id => {
    const type = byId(id)?.type;
    return type === 'image' || type === 'video';
  },
  itemFit: id => {
    const own = byId(id)?.meta?.fit;
    if (own === 'cover' || own === 'contain') return own;
    return board.mediaFit === 'contain' ? 'contain' : 'cover';
  },
  setItemFit: (id, fit) => setItemFit(id, fit),

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
initAppearance({ onChange: () => { resetGridInk(); paintGrid(vp); } });
initAudio();
bus.on('layout', () => syncBoardMode(true));
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
initDrop(vp);
// Hand storage the confirmation prompt it cannot import (ui sits above storage
// - AUD-12): the discard-unsaved and clear-everything dialogs.
setPrompt(ask);
initStorage();

// The grid is screen-space, so it repaints on every view change. Two tiers are
// four CSS gradients; Harsh draws its lattice, but only over the canvas, which
// is the viewport - so both are bounded by the screen rather than the board.
//
// A dev-only profiler for the view-change frame, exposed as `mbrd.perf`.
//
// The point it measures is the whole premise of the grid performance work: on a
// pan or zoom, how much of a frame is paintGrid() and how much is everything
// else? `mbrd.perf.on()`, pan/zoom for a few seconds, `mbrd.perf.report()`. It
// holds no browser globals and does no work until turned on - the caller above
// reads `.active` and skips the two performance.now() marks when it is off, so
// there is nothing to pay for on a board that never opens the console.
const viewPerf = (() => {
  let on = false, raf = 0, lastRaf = 0, moved = false;
  // An on-screen readout, built lazily the first time it is asked for. The
  // point of it is the phone: a device with no console the median frame rate can
  // be read off, so a real touch device can be measured on the glass instead of
  // over a debugging cable. Desktop gets it too - a live number beside the
  // gesture is worth more than one printed after it.
  let hud = null, hudText = null, hudAt = 0;
  // JS cost of the main.js view listener, per view frame.
  let gridMs = 0, restMs = 0, frames = 0, worstFrame = 0;
  // True frame cadence: the interval between animation frames, but recorded only
  // on frames where the view actually moved (a sample() landed since the last
  // rAF). Idle frames between two gestures would otherwise read as enormous
  // stalls and drown the real in-motion cadence - which was the trap in the
  // first cut of this. Held as raw intervals so report() can take percentiles;
  // the median is the honest frame rate, the tail is the jank.
  const gaps = [];
  const CAP = 8000;                 // ~a minute of 120fps motion; then it wraps
  const reset = () => {
    gridMs = restMs = frames = worstFrame = 0; gaps.length = 0; lastRaf = 0; moved = false;
    cullProfile.reset();
  };
  const pct = (sorted, p) => sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
  /**
   * How far a gap is off the display's own beat, in frames.
   *
   * A gap is never a free quantity: the compositor hands over on a refresh or
   * it does not, so every interval is a whole number of them and the whole
   * distribution lands on multiples of one. Anything that is *not* near a
   * multiple did not come from a missed refresh, which is why it is counted
   * separately below.
   */
  const OFF_BEAT = 0.25;
  /** Below this a gap is a normal frame and no question is being asked of it. */
  const A_FRAME = 1.15;

  const stats = () => {
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = pct(sorted, 0.5) || 0;
    const janks = median ? gaps.filter(g => g > median * 1.5).length : 0;
    // The display's fastest interval, as this run actually saw it - not as the
    // device claims and not as the median says.
    //
    // The median is the wrong number to measure jank against on a phone, and
    // reading a run against it is what nearly cost a day. These panels change
    // refresh rate on their own: 120Hz under the finger, 60 when the system
    // decides otherwise. A run that spends part of itself at 60 has a median
    // pulled towards 16.7ms, so genuinely dropped frames stop looking dropped -
    // and, worse the other way, a clean stretch at 60Hz scores as jank against
    // a 120Hz median while nothing was missed at all.
    //
    // So the beat is taken from the fast end of the run instead: the 5th
    // percentile is the interval the panel manages when it is trying, robust
    // against the one or two impossibly short gaps a timer can produce.
    const base = pct(sorted, 0.05) || median;
    // ...and the tail is expressed in that beat. Two beats is deliberately kept
    // apart from three: a two-beat gap is exactly what a drop to 60Hz looks
    // like on a 120Hz panel and cannot be told from one missed refresh by any
    // arithmetic on this data, so it is reported and not accused. Three or more
    // is past anything a refresh-rate change explains, and is the honest count
    // of frames this app actually lost.
    const twos = base ? gaps.filter(g => g >= base * 1.5 && g < base * 2.5).length : 0;
    const overs = base ? gaps.filter(g => g >= base * 2.5).length : 0;
    // Gaps that are not a whole number of beats at all. A panel that stepped to
    // some third rate - 90Hz is 1.33 beats of 120 - lands here rather than in
    // the two counts above, which is the point: it is the one shape in the data
    // that says the beat itself moved. Overlaps `twos`/`overs` by design.
    const off = base ? gaps.filter(g => {
      const f = g / base;
      return f > A_FRAME && Math.abs(f - Math.round(f)) > OFF_BEAT;
    }).length : 0;
    return { sorted, median, janks, base, twos, overs, off };
  };
  /**
   * Which run this is, named as the address that produces it.
   *
   * Derived from the flags rather than from the hash, because the console can
   * set them too - and a console that has set two at once gets both names and
   * no address, which is the honest answer to "which run is this".
   */
  const runLabel = () => {
    const off = [
      mobilePerfFlags.legacyVars && 'legacy',
      !mobilePerfFlags.chrome && 'nochrome',
      !mobilePerfFlags.gridPos && 'nogrid',
    ].filter(Boolean);
    const runs = { legacy: 1, nochrome: 2, nogrid: 3 };
    if (!off.length) return '#perf shipped';
    return off.length === 1 ? `#perf${runs[off[0]]} ${off[0]}` : off.join(' ');
  };

  /**
   * The whole reading as one line, which is the shape it is wanted in.
   *
   * Four runs are compared against each other, so four of these stack into
   * something readable with no editing, and each carries the address that
   * reproduces it and the board it was taken on - two readings only compare if
   * they were the same board in the same mode.
   */
  const summary = () => {
    const { sorted, median, base, twos, overs, off } = stats();
    if (!gaps.length) return `${runLabel()} — no motion sampled`;
    const m = viewStats();
    const cullAvg = cullProfile.runs ? cullProfile.ms / cullProfile.runs : 0;
    const fullPct = cullProfile.runs ? 100 * cullProfile.fullSyncs / cullProfile.runs : 0;
    const share = k => (100 * k / gaps.length).toFixed(1) + '%';
    return [
      runLabel(),
      `${board.layoutMode} ${board.items.length} items`,
      `fps ${(1000 / median).toFixed(1)}`,
      `beat ${base.toFixed(1)}ms`,
      // The two counts that replaced a jank percentage measured against a
      // median the panel is free to move - see stats().
      `2f ${share(twos)}`,
      `3f+ ${share(overs)}`,
      `offbeat ${share(off)}`,
      `worst ${pct(sorted, 1).toFixed(0)}ms`,
      `n ${gaps.length}`,
      `cull ${cullAvg.toFixed(2)}ms`,
      `full ${fullPct.toFixed(0)}%`,
      `mnt ${m.mounted}`,
      `vid ${m.videos}`,
      `img ${(m.imgBytes / 1048576).toFixed(0)}MB`,
    ].join('  ');
  };

  /**
   * Put a string on the clipboard on a device that has no console and,
   * usually, no secure context either.
   *
   * navigator.clipboard is the right answer and is the one that will not be
   * there: the phone reaches this board over the LAN at http://192.168.x.x, and
   * the Clipboard API is gated on a secure context, so the whole namespace is
   * undefined on exactly the device this button exists for. execCommand is
   * deprecated and works there, which is the trade - and it is tried first, for
   * the reason written against it below.
   *
   * And when neither lands, the text is put in a selectable box instead and the
   * user copies it by hand. A dev tool that says "copied" without copying is
   * worse than one that hands you the text.
   */
  const copyText = text => {
    // execCommand first, and synchronously, which is the whole point of the
    // order. Both paths need the tap that is still in progress, and awaiting
    // the Clipboard API's rejection would spend it: by the time the promise
    // settles the gesture is no longer the transient activation execCommand
    // asks for, so the fallback would fail on precisely the device it exists
    // for. Nothing is awaited before the attempt that has to work.
    try {
      const box = document.createElement('textarea');
      box.value = text;
      // Off-screen but focusable, and readOnly so a phone does not open its
      // keyboard over the readout on the way past.
      box.readOnly = true;
      box.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
      document.body.append(box);
      box.select();
      box.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      box.remove();
      if (ok) return Promise.resolve(true);
    } catch { /* deprecated, and one day gone - the API below is the future */ }
    try {
      if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text).then(() => true, () => false);
      }
    } catch { /* no secure context: there is nothing left to try */ }
    return Promise.resolve(false);
  };

  const showHud = () => {
    if (hud) return;
    hud = document.createElement('div');
    hud.id = 'perf-hud';
    hud.style.cssText =
      'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:99999;'
      + 'font:600 13px/1.3 ui-monospace,monospace;padding:6px 10px;border-radius:8px;'
      + 'background:rgba(0,0,0,.8);color:#0f0;pointer-events:none;white-space:pre;text-align:center';
    // The figures and the button are two children now, because the readout is
    // rewritten four times a second and a button inside that string would be
    // destroyed on the next repaint.
    hudText = document.createElement('div');
    hudText.textContent = 'perf — move the board';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'copy';
    // The panel is inert to the pointer - it sits over the board and must not
    // catch a drag meant for it - so the one thing that is not gets it back.
    // 32px of height because this is tapped with a thumb.
    copy.style.cssText =
      'pointer-events:auto;margin-top:5px;width:100%;min-height:32px;'
      + 'font:inherit;color:inherit;background:rgba(255,255,255,.12);'
      + 'border:1px solid currentColor;border-radius:6px;cursor:pointer';
    copy.addEventListener('click', async () => {
      const text = summary();
      const ok = await copyText(text);
      copy.textContent = ok ? 'copied' : 'select and copy ↓';
      // Nothing could reach the clipboard, so hand over the text instead.
      if (!ok) hudText.textContent = text;
      setTimeout(() => { copy.textContent = 'copy'; }, 1500);
    });
    hud.append(hudText, copy);
    document.body.appendChild(hud);
  };
  const hideHud = () => { hud?.remove(); hud = hudText = null; };
  const paintHud = now => {
    if (!hud || now - hudAt < 250) return;   // four updates a second is plenty
    hudAt = now;
    const { median, base, twos, overs, off } = stats();
    if (!gaps.length) return;
    // A second line for what the frame rate cannot say on a panel that changes
    // its own refresh rate: the beat this run was actually delivered on, and
    // the tail counted in it - see stats(). `2f` is the ambiguous column and
    // `3f+` the accusing one.
    //
    // A third for what no frame rate can show: the cull's own per-frame cost
    // (the zoom-out hot path) and what is mounted right now - live node and
    // video counts and the decoded-image megabytes, which is the budget an
    // iPhone runs out of when the whole board is framed.
    //
    // A fourth saying which run this is. Every one of these numbers is read off
    // the glass, and a column of figures with no note of which switch was
    // thrown is a column of figures that has to be taken again. The board and
    // its size are here for the same reason: two runs only compare if they were
    // the same board in the same mode.
    const cullAvg = cullProfile.runs ? cullProfile.ms / cullProfile.runs : 0;
    const m = viewStats();
    const share = k => (100 * k / gaps.length).toFixed(1);
    hudText.textContent =
      `${(1000 / median).toFixed(0)} fps   beat ${base.toFixed(1)}ms   n ${gaps.length}\n`
      + `2f ${share(twos)}%   3f+ ${share(overs)}%   offbeat ${share(off)}%\n`
      + `cull ${cullAvg.toFixed(2)}ms   mnt ${m.mounted}  vid ${m.videos}  img ${(m.imgBytes / 1048576).toFixed(0)}MB\n`
      + `${board.layoutMode} ${board.items.length} items   ${runLabel()}`;
  };
  const tick = now => {
    if (!on) return;
    // Only a moved frame counts. requestAnimationFrame still fires at the
    // display rate on an idle board, and those intervals are not what we are
    // measuring - the question is how fast frames come while something is
    // actually happening.
    if (lastRaf && moved) {
      if (gaps.length >= CAP) gaps.shift();
      gaps.push(now - lastRaf);
    }
    lastRaf = now;
    moved = false;
    paintHud(now);
    raf = requestAnimationFrame(tick);
  };
  return {
    get active() { return on; },
    /** @param overlay  false to skip the on-screen readout (console only). */
    on(overlay = true) {
      // Arming an armed profiler starts the counters again and nothing else.
      // It used to start a second rAF loop as well, which sampled every frame
      // twice - and re-arming is the normal case now that switching runs is a
      // change of hash rather than a reload.
      const already = on;
      reset(); on = true; cullProfile.on = true;
      if (overlay) showHud();
      if (!already) raf = requestAnimationFrame(tick);
      console.log('[perf] on — pan/zoom continuously, then mbrd.perf.report()');
    },
    off() { on = false; cullProfile.on = false; if (raf) cancelAnimationFrame(raf); raf = 0; hideHud(); console.log('[perf] off'); },
    /**
     * The three Mobile kill switches, as one call - see mobilePerfFlags.
     *
     * `mbrd.perf.mobile({ legacyVars: true })` and so on. The class is here
     * rather than in the module because hiding the chrome is a stylesheet's job
     * and skipping the writes is the module's; both hang off the one flag.
     *
     * Returns the resulting flags, which is what makes this usable from a phone
     * - there is no console to read a global out of, so the call has to answer.
     */
    mobile(patch = {}) {
      Object.assign(mobilePerfFlags, patch);
      document.documentElement.classList.toggle(
        'perf-no-mobile-chrome', !mobilePerfFlags.chrome);
      vp.apply();
      return { ...mobilePerfFlags };
    },
    /** JS timings for one view frame, in ms: grid paint and the rest. */
    sample(grid, rest) {
      gridMs += grid; restMs += rest; frames++; moved = true;
      const f = grid + rest;
      if (f > worstFrame) worstFrame = f;
    },
    report() {
      if (!gaps.length) { console.log('[perf] no motion sampled — mbrd.perf.on(), then pan'); return null; }
      const { sorted, median, janks, base, twos, overs, off } = stats();
      const mem = viewStats();
      const share = k => +(100 * k / gaps.length).toFixed(1);
      const r = {
        // Which board and which layout, because two runs of this are only
        // comparable if they were the same board in the same mode - and the
        // Mobile work is measured by exactly that comparison.
        boardMode: board.layoutMode,
        items: board.items.length,
        motionFrames: gaps.length,
        fpsMedian: +(1000 / median).toFixed(1),
        fpsP95Low: +(1000 / pct(sorted, 0.95)).toFixed(1),   // the slow tail
        worstFrameGapMs: +pct(sorted, 1).toFixed(1),
        // The tail against the beat this run was delivered on rather than
        // against its own median, because the panel moves the median - see
        // stats(). Two beats is the ambiguous column: on a 120Hz panel it is
        // both "one frame missed" and "the display stepped down to 60", and no
        // arithmetic on this data separates them. Three or more is past what a
        // refresh-rate change explains and is the honest count of lost frames.
        beatMs: +base.toFixed(2),
        twoBeatPct: share(twos),
        threePlusBeatPct: share(overs),
        offBeatPct: share(off),   // the beat itself moved: 90Hz is 1.33 of 120
        // Kept for continuity with readings taken before the beat existed, and
        // not to be trusted on a variable-refresh display: it is measured
        // against the median, which such a display is free to move under it.
        jankPct: +(100 * janks / gaps.length).toFixed(1),
        // The listener's own JS share, for contrast - this is what the grid
        // rewrite would have touched, and it is tiny.
        jsGridAvgMs: frames ? +(gridMs / frames).toFixed(3) : null,
        jsRestAvgMs: frames ? +(restMs / frames).toFixed(3) : null,
        jsWorstFrameMs: +worstFrame.toFixed(3),
        // The cull the grid profiler never saw: its per-frame cost, and how often
        // a frame fell through to a full sync() (near 100% while zooming out).
        cullAvgMs: cullProfile.runs ? +(cullProfile.ms / cullProfile.runs).toFixed(3) : null,
        cullFullSyncPct: cullProfile.runs
          ? +(100 * cullProfile.fullSyncs / cullProfile.runs).toFixed(1) : null,
        // What is mounted at report time - the memory budget, not the frame time.
        mountedNodes: mem.mounted,
        liveVideos: mem.videos,
        decodedImgMB: +(mem.imgBytes / 1048576).toFixed(1),
      };
      console.table(r);
      // The same reading as the HUD's copy button puts on the clipboard, so a
      // run taken at the desk and a run taken on the glass are written the same
      // way and stack into one table.
      console.log(summary());
      return r;
    },
    /** The one-line reading, for a console that would rather have the string. */
    line: () => summary(),
  };
})();

// The view is board state and is saved with the board, but it changes on every
// frame of a pan - so it is written here on each change and *announced* on a
// trailing timer. Without the announcement nothing scheduled an autosave, and a
// board closed after nothing but panning came back at the view it had before,
// which is not where the user left it. Without the timer, every pan would queue
// a snapshot per frame.
let viewSettle = 0;
// Everything the view-change frame does after the grid. Named so the profiler
// below can time the grid alone against the rest without duplicating it.
const afterGrid = () => {
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
  if (!viewPerf.active) { paintGrid(vp); afterGrid(); return; }
  const t0 = performance.now();
  paintGrid(vp);
  const t1 = performance.now();
  afterGrid();
  viewPerf.sample(t1 - t0, performance.now() - t1);
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
    // Back to 100%, without moving the view.
    case 'reset': vp.viewTo(vp.pan, BASE_ZOOM, travelMs()); break;
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
  // The one place the scale becomes a percentage. vp.zoom is the true
  // world-to-screen scale; BASE_ZOOM is the scale the corner calls 100%.
  const pct = (vp.zoom / BASE_ZOOM) * 100;
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
  // An empty board - only the title card, which is furniture rather than
  // content - opens at the origin at 100%, where a fresh board should. Fitting
  // the title card alone would frame that one card and read as "this is all
  // there is", which is exactly what a blank board is trying not to say.
  if (!vp.isMobile && board.items.every(it => it.type === 'title')) return vp.recenter(0);
  // Capped at 100%: a small board opens at actual size, not magnified. A board
  // bigger than the window still zooms out to frame it - see fit()'s maxZoom.
  vp.fit(board.items, 80, 0, BASE_ZOOM);
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
 * The band itself is positioned by canvas/mobile-frame.js, off the same view
 * change everything else in screen space paints on, so this is the only part
 * that needs saying here. Written whatever the mode: a header that is
 * display:none has nothing to gain from being stale when Mobile is switched
 * back on.
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
  header.toggleAttribute('data-untitled', isDefaultTitle(board.title));
  // The Desktop title card carries the same name. It is not inline-editable, so
  // no caret guard is needed - just keep it current and dim it while untitled,
  // the way the masthead's [data-untitled] rule does.
  const card = document.querySelector('.item[data-type="title"] .title-name');
  if (card) {
    // Not over an inline rename in progress on the card, the same caret guard the
    // masthead gets above: rewriting the text mid-word would take the caret with it.
    if (!card.isContentEditable) card.textContent = board.title;
    card.classList.toggle('is-untitled', isDefaultTitle(board.title));
  }
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
  editBoardName(el('mobile-board-title'));
}

/**
 * Inline rename of the board name, on the Desktop title card: the same editor
 * the masthead uses, pointed at the card's own name node. Reached by the card's
 * T button, a double-click on the card, or F2 while it is selected.
 */
function editTitleCard() {
  editBoardName(document.querySelector('.item[data-type="title"] .title-name'));
}

/**
 * The shared inline board-name editor. `field` is whichever element shows the
 * name - the Mobile masthead or the Desktop card - and both edit board.title and
 * repaint through paintMobileTitle, which keeps the two in step.
 */
function editBoardName(field) {
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
  // Focus on the next frame, not now. On the Desktop card this opens from the
  // T button's pointerdown, and the <button> then takes focus itself on the click
  // that follows - which would blur the field the instant it was focused, run
  // finish(), and close the editor. That is exactly why a single click used to
  // open the rename and shut it again, needing a second. Focusing past the click
  // lets the field win. Harmless on the masthead tap, which has no button to
  // steal from. Selected rather than merely focused: a rename usually replaces
  // the name, and an untitled board is holding a placeholder nobody typed.
  requestAnimationFrame(() => {
    if (done) return;
    field.focus();
    const range = document.createRange();
    range.selectNodeContents(field);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
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
  paintMobileFrame();
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
  // Hints are not things. A blank board that announced "3 things" would be
  // counting its own scaffolding, and the number is meant to answer "how much
  // have I put here" - which on a new board is none.
  const n = board.items.reduce((t, i) => t + (i.type === 'ghost' ? 0 : 1), 0);
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

  // A stuck note is not laid out; it rides its host to the host's new slot and
  // keeps its place on it. So a pinned sticky stays pinned through a Rearrange,
  // and a note whose host is not in this set rides a host that does not move -
  // and so does not move either. Everything else is arranged as before.
  // The title card takes a slot like any other: Rearrange gives it a place in
  // the layout and sizes it to the lattice on a snapped board, so cards no
  // longer land on top of it and it moves with the rest.
  const riders = items.filter(isRider);
  const free = items.filter(it => !isRider(it));
  const beforeAll = snapshotGeom(items.map(i => i.id));
  // Nothing to lay out - the whole set was followers. There is no arrangement of
  // riders alone; they stay on their hosts.
  if (!free.length) return;

  const at = whole ? { x: 0, y: 0 } : middleOf(free);
  const before = snapshotGeom(free.map(i => i.id));
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
  const order = shuffle(free.map((_, i) => i));

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
  const snapDesktop = board.settings.snap && !mobile;
  const sized = snapDesktop
    ? free.map(it => { const b = latticeBox(it, step); return { w: b.w, h: b.h }; })
    : null;
  const laid = order.map(i => (sized ? { ...free[i], ...sized[i] } : free[i]));
  const seed = (Math.random() * 0xffffffff) >>> 0;

  let placed;
  if (mobile) {
    // A column has no slots to deal, so none of the above applies: the packer
    // decides where every card goes and the arrangement decides only what order
    // it meets them in. `free` rather than `laid`, and that is the point of the
    // fork - the shuffle above exists to re-deal a set of 2D slots, and dealt
    // into a Mobile order it would scramble the very sequence the order just
    // chose. See MOBILE_ARRANGEMENTS in arrange/arrangements.js.
    placed = mobileOrder(free, { name: board.arrangement, seed });
    const moving = new Set(free.map(item => item.id));
    // Riders are not obstacles - they overlap their host and would wall it off.
    const obstacles = whole ? [] : board.items.filter(item =>
      !moving.has(item.id) && !isRider(item));
    // Rearrangement changes order and position, not the sizes already visible
    // on this layout. In particular, do not rebuild them from meta.presnap:
    // that is the geometry to restore when snapping is disabled, not a sizing
    // source for every later press of Rearrange.
    placed = placeMobileItems(placed, obstacles, { preserveSize: true });
  } else {
    const spots = arrange(laid, {
      name: board.arrangement,
      center: at,
      spacing: board.settings.spacing,
      // Snapping reserves whole cells so the per-item lattice snap below cannot
      // round two tight cards into an overlap - see arrange()/toCells.
      cellStep: snapDesktop ? step : 0,
      seed,
    });
    placed = laid.map((item, slot) => ({
      ...item,
      x: spots[slot].x,
      y: spots[slot].y,
    }));
  }
  // spots came back in shuffled order, so each one goes to the item that was
  // in that slot, not to the item at the same index in board.items.
  const target = new Array(free.length);
  if (mobile) {
    const byItem = new Map(placed.map(item => [item.id, item]));
    free.forEach((item, i) => { target[i] = byItem.get(item.id); });
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

  // Hosts are now at their new slots; carry each rider to its host and keep the
  // offset it had. Read the host's *old* geometry from the pre-move snapshot (so
  // the offset is the one the author set) and its new geometry live. In passes,
  // so a note stuck to a note follows only once its own host has moved.
  if (riders.length) {
    const beforeById = new Map(beforeAll.map(g => [g.id, g]));
    const pending = new Set(riders.map(r => r.id));
    for (let grew = true; grew && pending.size;) {
      grew = false;
      for (const note of riders) {
        if (!pending.has(note.id)) continue;
        const host = stuckTo(note);
        if (!host) { pending.delete(note.id); continue; }
        if (pending.has(host.id)) continue;         // host is a rider, not moved yet
        const hostSrc = beforeById.get(host.id) || byId(host.id);
        const pos = stuckPlacement(note, hostSrc, byId(host.id));
        applyGeom([{ id: note.id, x: pos.x, y: pos.y }]);
        pending.delete(note.id);
        grew = true;
      }
    }
  }

  // driven = the free items only. Each was placed, none towed, so each of those
  // notes asks again what it landed on. Riders are left out on purpose: they kept
  // their host, so re-measuring them onto whatever they now sit beside would be
  // the one thing that could tear a pinned pile apart.
  commitGeom(whole ? 'Rearrange' : `Rearrange ${items.length} items`,
    beforeAll, free.map(g => g.id), mobile ? { preservePresnap: true } : {});
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
// `mbrd.cmds.fit()` to drive the app, `mbrd.vp` for the coordinate model,
// `mbrd.perf.on()` to profile the pan/zoom frame, `mbrd.debugGrips()` to see the
// resize hitboxes.
window.mbrd = { board, bus, vp, cmds, selection, perf: viewPerf, debugGrips: cmds.debugGrips };

// A phone has no console to type mbrd.perf.on() into, so the profiler can be
// armed from the URL as well: open the board at `.../#perf` on the device and
// the on-screen readout comes up on its own. Harmless anywhere else. The grip
// overlay rides the same trick with `#grips`.
//
// The three Mobile kill switches ride it too, because they are for exactly the
// device that cannot be typed into - see mobilePerfFlags in canvas/viewport.js.
// One run is one digit:
//
//   #perf    what shipped
//   #perf1   the five #viewport custom properties written again
//   #perf2   the Mobile sheet and masthead gone entirely
//   #perf3   the lattice's background-position write skipped
//
// A digit rather than a word, because this is typed with a thumb on the device
// being measured and between two runs exactly one character changes.
//
// Re-read on hashchange as well as at boot, which is the point of the digit
// being at the end: a hash edit does not reload, so the run changes while the
// board, the mounted set and every decoded image stay exactly as they were.
// Two readings taken that way differ by the switch and by nothing else, which
// is more than can be said for two readings either side of a reload. Arming an
// already-armed profiler restarts its counters, so each run is measured clean.
const armPerf = () => {
  const run = location.hash.match(/perf(\d)?/);
  if (!run) { if (viewPerf.active) viewPerf.off(); return; }
  viewPerf.mobile({
    legacyVars: run[1] === '1',
    chrome: run[1] !== '2',
    gridPos: run[1] !== '3',
  });
  viewPerf.on();
};
armPerf();
addEventListener('hashchange', armPerf);
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
