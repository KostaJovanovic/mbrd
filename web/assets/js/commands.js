// The command surface - the single set of user-facing actions.
//
// Sidebar buttons (`data-cmd="reset-appearance"` resolves to
// cmds.resetAppearance), the keyboard, the context menu, the glass controls and
// the console handle all drive this one object. **A new user-facing action is an
// entry here, not a second event listener**, which is the whole reason it is a
// module of its own rather than a literal in the middle of the boot.
//
// It is also the seam canvas/ uses to reach things it may not import: the title
// card's pen and its inline rename are both `cmds` entries because
// canvas/input.js has no business importing a ui/ module, and the whimsy dial on
// the fourth hint card is one because canvas/ghosts.js has the same problem.
//
// A factory rather than a module-level object: it closes over the Viewport,
// which is built at boot, and nothing here may touch a browser global at import
// time (tests/imports.test.js).

import { toast } from './util.js';
import { DEFAULT_SCALE } from './measure.js';
import {
  board, selection, selectAll, removeItems, setSetting, undo, redo, byId,
  raiseSelection, lowerSelection, selectionHasStackOverlap,
  duplicateItems, select, setItemCover, setItemUpAxis, setItemFit,
  setBoardMode as selectBoardMode,
  restoreTitleCard, resetTitlePosition,
} from './state.js';
import { defaultUpAxis, meshKind } from './mesh.js';
import { travelMs } from './canvas/viewport.js';
import { isTurning, rotateModel } from './canvas/model.js';
import { pickFiles, pickCover, addNote } from './import/drop.js';
import { exportBoard, openBoard, newBoard } from './storage/storage.js';
import { getAsset } from './storage/assets.js';
import { close as closeSidebar } from './ui/sidebar.js';
import { clearQualityOverrides } from './quality.js';
import { openContextMenu } from './ui/menu.js';
import { open as openSearch } from './ui/search.js';
import { openCredits } from './ui/credits.js';
import {
  openPanel as openHeaderPanel, closePanel as closeHeaderPanel,
  isPanelOpen as isHeaderPanelOpen,
} from './ui/mobile-header.js';
import { editNote } from './canvas/notes.js';
import { paintZoom, zoomText } from './ui/hud.js';
import { editTitleCard } from './ui/board-title.js';
import {
  saveWithCooldown, armClear, resetSize, rearrange,
  reloadBoard, restartApp, scaleFromItem,
} from './ui/board-actions.js';

/**
 * Build the command surface for this session.
 *
 * `resetAppearance` and `setWhimsy` are injected rather than imported, in the
 * same shape and for the same reason as setAssetNameLookup() and setPrompt():
 * ui/appearance.js is one of the three modules that touch a browser global at
 * import time, so importing it here would make *this* module unloadable without
 * a DOM and cost the fourth exemption in tests/imports.test.js. main.js already
 * imports it and is already exempt, so the pair comes in from there.
 *
 * @param vp    the live Viewport. Several commands are journeys rather than
 *              state changes, and those are the ones that need it.
 * @param deps  { resetAppearance, setWhimsy } from ui/appearance.js.
 */
export function createCommands(vp, { resetAppearance, setWhimsy }) {
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
    // their reach can be checked by eye (see [data-debug-grips] in canvas.css). A
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
    // Who made this. A command rather than a listener on the footer button, for
    // the reason every other action here is one: the sidebar knows about data-cmd
    // and about nothing else, so this is the only wiring the panel needs.
    credits: () => openCredits(),

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

  return cmds;
}
