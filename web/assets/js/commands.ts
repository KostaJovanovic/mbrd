// Command surface: the single set of user-facing actions. Sidebar buttons,
// keyboard, context menu, glass controls, and console all drive one object.
// Factory (not module-level) because it closes over Viewport built at boot.
// Split into commands/{file,connections,fences,view,item-meta}.ts and spread
// back in. What stays here: board additions, selection-wide actions, title card,
// arrangements.

import { toast } from './notify.ts';
import {
  board, selection, selectAll, removeItems, setSetting, undo, redo, byId,
  raiseSelection, lowerSelection, selectionHasStackOverlap,
  duplicateItems, select,
  isMultiSelect, setMultiSelect,
  copyItems, pasteItems, clipboardSize, canCopyItems,
  setBoardMode as selectBoardMode,
  restoreTitleCard, resetTitlePosition,
  isFurniture, isRider, isFence, isLocked, setArrangement,
  addItems,
  snapshotGeom, applyGeom, commitGeom,
  declareOp, registerOp,
} from './state.ts';
import { alignTargets, distributeTargets, separateOverlaps } from './geometry.ts';
// Needed here for zoomToSelection; the rest of the camera is in commands/view.ts.
import { travelMs } from './canvas/viewport.ts';
import { pickFiles, addNote, addSwatch, addLink, addSticker, addStyleTile } from './import/drop.ts';
import { linkURL, linkTyped, SWATCH_DEFAULT, defaultSize } from './canvas/renderers.ts';
import { youTubeId } from './canvas/embed.ts';
import { openViewer } from './ui/viewer.ts';
import { openExternal } from './ui/leaving.ts';
import { samplePixels, dominantColors } from './ui/pigments.ts';
import { arrange } from './arrange/arrangements.ts';
import { ask } from './ui/dialog.ts';
import { pickColor } from './ui/color-picker.ts';
import { getAsset, assetURL } from './storage/assets.ts';
import { close as closeSidebar, open as openSidebar, isOpen as isSidebarOpen } from './ui/sidebar.ts';
import { revealFold } from './ui/panel.ts';
import { closeToolbar, isOpen as isToolbarOpen, isArmed as isConnectorArmed } from './ui/toolbar.ts';
import { openContextMenu, openAnchored, justDismissed, close as closeMenu } from './ui/menu.ts';
import { tourEditing } from './ui/tour-edit.ts';
import { tourActive } from './ui/tour.ts';
import { startClean, cleanActive, cleanKey, cleanSpace, cleanEscape, releaseRobot } from './ui/clean/clean.ts';
import { konamiMatcher, tapMatcher } from './ui/clean/konami.ts';
import { open as openSearch, close as closeSearch } from './ui/search.ts';
import { toggleStickerWindow, closeStickerWindow } from './ui/sticker-window.ts';
import { closeDrawer } from './ui/drawer.ts';
import { resetPanels } from './ui/panel-stack.ts';
import {
  openPanel as openHeaderPanel, closePanel as closeHeaderPanel,
  isPanelOpen as isHeaderPanelOpen,
} from './ui/mobile-header.ts';
import { composeNote, editNoteInComposer } from './canvas/notes.ts';
import { editFontText } from './canvas/items.ts';
import { editLinkProps } from './ui/link-props.ts';
import { editTitleCard } from './ui/board-title.ts';
import { armClear, rearrange } from './ui/board-actions.ts';
import { fileCommands } from './commands/file.ts';
import { connectionCommands } from './commands/connections.ts';
import { fenceCommands, sharedFence } from './commands/fences.ts';
import { viewCommands } from './commands/view.ts';
import { itemMetaCommands } from './commands/item-meta.ts';
import type { CommandViewport } from './commands/view.ts';
import type { ViewPerf } from './perf/view-perf.ts';
import type { BenchOptions, BenchResult } from './perf/bench.ts';
import type { Item, ItemMeta } from './board-model.ts';
import type { Point } from './arrange/arrangements.ts';

// Re-exported so tests/fences.test.js keeps its import.
export { sharedFence };
// linkTyped now lives beside linkURL in renderers.ts; re-exported so
// tests/toolbar.test.js and any other caller keep importing it from here.
export { linkTyped };

/** One matcher of each for the session, at module scope so a half-typed code or
 *  a half-drummed run of taps survives whatever rebuilds the command table.
 *  See cleanFeed and cleanTap below. */
const konami = konamiMatcher();
const taps = tapMatcher();

/**
 * Everything open, closed, as the cleaning game comes up: its intro is played
 * to an empty screen and the game to a bare board. Closed rather than hidden,
 * unlike a tour. The panel stack goes first, or closing the top one would open
 * the one under it again. Answers true so it can end the chain that opened it.
 */
function clearStage(): true {
  resetPanels();
  closeMenu();
  closeSearch();
  closeStickerWindow();
  closeDrawer();
  closeSidebar();
  closeHeaderPanel();
  closeToolbar();
  return true;
}

/** Structural viewport subset this file needs — view centre for "add" commands, fit() for zoom. */
export interface CommandsViewport extends CommandViewport {
  toWorld(x: number, y: number): Point;
  left: number;
  top: number;
  cx: number;
  cy: number;
}

/** What main.ts injects, of which commands/view.ts takes the first. */
export interface CommandDeps {
  resetAppearance: () => void;
  setWhimsy: (level: number | string) => void;
  /** Frame profiler instance, injected because it closes over the live viewport. */
  perf: ViewPerf;
  /**
   * The benchmark's screen (ui/bench-view.ts), injected because it is built
   * from these commands. Absent in a test, where both rows answer nothing.
   */
  bench?: {
    open(): void,
    run(opts?: BenchOptions): Promise<BenchResult | null>,
  };
}

/**
 * Layout operations by id — split from commands so the timeline can re-run
 * them on the same cards. declareOp() before mutating registers the step as
 * editable; forgetting it locks the step on the strip.
 */
function layoutItems(ids: string[]) {
  const wanted = new Set(ids);
  return board.items.filter(i => wanted.has(i.id));
}

function alignIds(ids: string[], edge: string, label = 'Align') {
  const items = layoutItems(ids);
  if (items.length < 2) return;
  const spread = edge === 'top' || edge === 'bottom' || edge === 'vcenter' ? 'x' : 'y';
  const targets = separateOverlaps(
    alignTargets(items, edge), items, spread, board.settings.spacing || 0);
  const before = snapshotGeom(ids);
  declareOp('align', { ids, edge });
  applyGeom(targets);
  commitGeom(label, before, ids);
}

function distributeIds(ids: string[], axis: 'x' | 'y') {
  const items = layoutItems(ids);
  if (items.length < 3) return;
  const before = snapshotGeom(ids);
  declareOp('distribute', { ids, axis });
  applyGeom(distributeTargets(items, axis));
  commitGeom(axis === 'x' ? 'Distribute across' : 'Distribute down', before, ids);
}

/** Register runners so the timeline can replay these ops. Runners mutate without committing. */
function registerLayoutOps() {
  const asIds = (value: unknown): string[] =>
    (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  registerOp('align', params => alignIds(asIds(params.ids), String(params.edge || 'left')));
  registerOp('distribute', params =>
    distributeIds(asIds(params.ids), params.axis === 'y' ? 'y' : 'x'));
  // Arrangements are pure and reproducible — re-running one yields the same positions.
  registerOp('arrange', params => {
    const items = layoutItems(asIds(params.ids));
    if (items.length) rearrange(items, { name: params.name ? String(params.name) : undefined });
  });
}

/** Build the command surface. Deps injected to avoid importing ui/appearance.ts (touches DOM at import). */
export function createCommands(vp: CommandsViewport, { resetAppearance, setWhimsy, perf, bench }: CommandDeps) {
  registerLayoutOps();
  // Function, not binding — board.settings is replaced on layout switch.
  const settingsBag = (): Record<string, unknown> => board.settings;

  const cmds = {
    ...fileCommands(),

    addFiles: () => pickFiles(),
    // composeNote() — item is real from the first keystroke; cancelling takes it
    // back. `tint` from the toolbar flyout; omitted cycles NOTE_TINTS.
    addNote: (tint?: number) => composeNote(
      () => addNote(vp.toWorld(vp.left + vp.cx, vp.top + vp.cy), '', tint)),
    // Pick a colour before the card exists, via the in-app picker.
    addSwatch: async () => {
      const picked = await pickColor({ title: 'Add a colour', go: 'Add', value: SWATCH_DEFAULT });
      if (!picked) return;
      addSwatch(vp.toWorld(vp.left + vp.cx, vp.top + vp.cy), picked);
    },
    // Shortcut for the toolbar flyout's pigment swatches — no dialog needed.
    addSwatchOf: (hex: string) => addSwatch(vp.toWorld(vp.left + vp.cx, vp.top + vp.cy), hex),
    /** Add a style tile card. Selection curates the picture strip; empty = largest pictures. */
    addStyleTile: () => addStyleTile(vp.toWorld(vp.left + vp.cx, vp.top + vp.cy), selection),
    // Typed link — nothing is fetched until the card is clicked.
    addLink: async () => {
      const typed = await ask({
        title: 'Add a link',
        go: 'Add',
        field: { placeholder: 'https://example.com', type: 'url' },
      });
      // null = cancelled or empty.
      if (!typed) return;
      const url = linkTyped(typed);
      if (!url) { toast('That is not an address this can open', 'error'); return; }
      addLink(vp.toWorld(vp.left + vp.cx, vp.top + vp.cy), url);
    },
    /** The address a link card points at, or null for anything that is not a
     *  link carrying a valid http(s) URL. Guards the menu's Properties row. */
    linkURLOf: (id: string) => {
      const it = byId(id);
      if (!it || it.type !== 'link') return null;
      const u = linkURL(it.meta?.url);
      return u ? u.href : null;
    },
    /** Open the link card's properties: its name and address, edited or copied
     *  in one box. The whole flow lives in ui/link-props.ts (editLinkProps). */
    linkProps: (id: string) => editLinkProps(id),
    /** Right-click "Open" on a link. A YouTube link opens the viewer, which
     *  draws its player; every other link opens in a new tab, through the leave
     *  guard. YouTube is the one link that can be framed (see canvas/embed.ts),
     *  so it is the one that becomes an embed rather than a visit. */
    openLink: (id: string) => {
      const it = byId(id);
      if (!it || it.type !== 'link') return;
      const u = linkURL(it.meta?.url);
      if (!u) return;
      if (youTubeId(u)) openViewer(id);
      else void openExternal(u.href);
    },
    // Extract dominant colours from a picture and add them as swatch cards.
    canExtractSwatches: (id: string) => {
      const it = byId(id);
      return !!(it && it.type === 'image' && it.asset?.hash && getAsset(it.asset.hash));
    },
    extractSwatches: async (id: string) => {
      const it = byId(id);
      const hash = it?.asset?.hash;
      if (!hash) return;
      const url = assetURL(hash);
      if (!url) return;
      const [chunk] = await samplePixels([url], 1);
      if (!chunk) { toast('Could not read colours from that picture', 'error'); return; }
      const hexes = dominantColors(chunk, 5);
      if (!hexes.length) { toast('That picture has no colour worth taking'); return; }
      const size = defaultSize('swatch');
      // x/y placeholders — overwritten by arrange() below.
      const partials = hexes.map((h: string) => {
        const meta: ItemMeta = { hex: h, from: id };
        return {
          type: 'swatch', name: h.toUpperCase(), x: 0, y: 0,
          w: size.w, h: size.h, meta,
        };
      });
      const spots = arrange(partials, {
        name: 'masonry',
        center: { x: it.x, y: it.y + it.h / 2 + size.h },
        spacing: board.settings.spacing,
      });
      spots.forEach((p, i) => { partials[i].x = p.x; partials[i].y = p.y; });
      const made = addItems(partials, 'Extract palette');
      select(made.map((m: Item) => m.id));
    },
    // --- connections ---
    ...connectionCommands(),

    // --- fences ---
    ...fenceCommands(),

    clearData: () => armClear(),

    // The easter egg behind the konami code (ui/clean/). Six entries and no
    // markup anywhere references them, which is the whole of "hidden" here -
    // an entry in this object carries no metadata to hide it with. Routed
    // through cmds rather than listeners of their own so the one keydown in
    // canvas/input.ts stays the only one in the app, and so the sidebar's tap
    // is a command like every other thing a press in the sidebar does.
    // Both matchers are held here rather than in input.ts because canvas/ may
    // not import ui/. Each answers true only on the press that both completes
    // the run and opens something - on an empty board there is nothing to
    // clean, so the keys fall through and mean what they always did.
    // The tour guards stay here as well as in startClean(): the matcher is fed
    // either way, so a code typed across the end of a tour is not half-eaten.
    //
    // Typed again with the mode already up, the same code lets the robot vacuum
    // loose instead - the second secret inside the first. That is why this is
    // also fed while the mode owns the keyboard (canvas/input.ts).
    cleanFeed: (key: string) => {
      if (!konami(key)) return false;
      if (cleanActive()) return releaseRobot();
      return !tourActive() && !tourEditing() && startClean() && clearStage();
    },
    // Seven taps on the wordmark, the way in on a phone. The sidebar is closed
    // first: it is the whole screen at that width and the board is behind it.
    cleanTap: () => {
      if (!taps(performance.now())) return false;
      if (cleanActive()) return releaseRobot();
      closeSidebar();
      return startClean() && clearStage();
    },
    cleanActive: () => cleanActive(),
    cleanKey: (key: string) => cleanKey(key),
    cleanSpace: (down: boolean) => cleanSpace(down),
    cleanEscape: () => cleanEscape(),

    // Two commands (all vs selection) so each is honest about what it touches.
    // Ghosts excluded — they are about to leave and should not get slots.
    rearrange: () => rearrange(board.items.filter(i => i.type !== 'ghost')),
    // Set layout and rearrange in one press. Only the rearrange is on the undo
    // stack — the setting is intent, the positions are what you might regret.
    arrangement: () => board.arrangement,
    arrangeAs: (name: string) => {
      setArrangement(name);
      rearrange(board.items.filter(i => i.type !== 'ghost'));
    },
    // Command route so canvas/ (hint card dial) can set whimsy without importing ui/.
    setWhimsy: (level: number | string) => setWhimsy(level),
    rearrangeSelection: () => rearrange(board.items.filter(i => selection.has(i.id))),
    /** Whether Rearrange selection would do anything - the flyout greys it out. */
    hasSelection: () => selection.size > 0,

    // Align / distribute: furniture, fences, riders, and locked items excluded.
    // Mobile declines (no free positions).
    alignSelection: (edge: string) => {
      if (board.layoutMode === 'mobile') { toast('Aligning is a canvas thing'); return; }
      // Riders come along at their own offset; locked items must not move.
      const items = board.items.filter(i =>
        selection.has(i.id) && !isFurniture(i) && !isFence(i) && !isRider(i) && !isLocked(i));
      if (items.length < 2) { toast('Pick two or more cards to line up'); return; }
      const ids = items.map(i => i.id);
      const labels: Record<string, string> = {
        left: 'Align left', right: 'Align right', hcenter: 'Align centre',
        top: 'Align top', bottom: 'Align bottom', vcenter: 'Align middle' };
      const label = labels[edge] || 'Align';
      // separateOverlaps spreads collisions along the perpendicular axis.
      alignIds(ids, edge, label);
    },
    distributeSelection: (axis: 'x' | 'y') => {
      if (board.layoutMode === 'mobile') { toast('Spacing out is a canvas thing'); return; }
      // Same exclusions as alignSelection.
      const items = board.items.filter(i =>
        selection.has(i.id) && !isFurniture(i) && !isFence(i) && !isRider(i) && !isLocked(i));
      if (items.length < 3) { toast('Pick three or more cards to space out'); return; }
      distributeIds(items.map(i => i.id), axis);
    },

    // Routed through cmds so canvas/input.ts can open it without importing ui/.
    editTitle: () => (isHeaderPanelOpen() ? closeHeaderPanel() : openHeaderPanel()),
    // Inline rename (T / double-click / F2). Routed for canvas/input.ts.
    editTitleText: () => editTitleCard(),
    restoreTitle: () => restoreTitleCard(),
    // Title card has its own context menu (no copy/duplicate; edit style, reset).
    isTitleCard: (id: string) => byId(id)?.type === 'title',
    resetTitlePosition: () => resetTitlePosition(),
    // String because it comes from localStorage — setBoardMode() validates.
    setBoardMode: (mode: string | null) => selectBoardMode(mode),
    toggleBoardMode: () => {
      const next = board.layoutMode === 'mobile' ? 'desktop' : 'mobile';
      if (!selectBoardMode(next)) return;
      toast(next === 'mobile'
        ? 'Feed: images, video & audio, vertical scroll'
        : 'Back to the canvas');
    },

    // --- the lenses, the camera, the chrome resets ---
    ...viewCommands(vp, { resetAppearance, perf }),

    // The benchmark (perf/bench.ts). The Debug row asks which board; the
    // console form takes the options and answers the file's own object.
    runBenchmark: () => bench?.open(),
    bench: (opts?: BenchOptions) => (bench ? bench.run(opts) : Promise.resolve(null)),

    selectAll,
    // Touch multi-select toggle. Turning off keeps the selection intact.
    multiSelect: isMultiSelect,
    toggleMultiSelect: () => {
      const on = !isMultiSelect();
      setMultiSelect(on);
      // Standing mark synced off the bus in main.ts so every exit clears it.
      // The Feed has no drag, so the second sentence is the canvas's alone.
      if (on) toast(board.layoutMode === 'mobile' ? 'Tap cards to add them.'
        : 'Tap cards to add them. Drag a selected one to move them all.');
    },
    undo, redo,
    deleteSelection: () => {
      if (!selection.size) return;
      removeItems([...selection]);
    },
    // Closes all three panels (sidebar, header, toolbar drawer), and answers
    // whether any was open or the connector armed, for Escape's mark.
    closeSidebar: () => {
      const open = isSidebarOpen() || isHeaderPanelOpen() || isToolbarOpen() || isConnectorArmed();
      closeSidebar();
      closeHeaderPanel();
      closeToolbar();
      return open;
    },
    // '?' and the desktop's Help row. The legend stays where it is, folded at
    // the foot of the System tab; this is the way to it.
    shortcuts: () => {
      openSidebar();
      revealFold('system', 'keys-fold');
    },
    // Open the note composer dialog (falls back to on-board editor without <dialog>).
    editNote: (id: string) => editNoteInComposer(id),
    // Edit a font card's specimen text inline on the board.
    editFontText: (id: string) => editFontText(id),

    // --- right-click menu ---
    contextMenu: (x: number, y: number, id: string | null, count: number,
      opts?: { mobile?: boolean, touch?: boolean, selectAll?: () => void }) => {
      // No card menus in the tour editor: a card there is picked, not worked on.
      if (id && tourEditing()) return;
      openContextMenu(x, y, id, count, opts);
    },
    selectionHasStackOverlap,
    raise: raiseSelection,
    lower: lowerSelection,
    duplicate: () => {
      const copies = duplicateItems(selection);
      if (copies.length) select(copies.map((i: Item) => i.id));
    },
    // Menu copy — uses async clipboard API (no ClipboardEvent available from a menu).
    // Internal clipboard always filled; system write may be refused silently.
    copy: () => {
      const text = copyItems(selection);
      if (text) navigator.clipboard?.writeText(text).catch(() => {});
    },
    // null = Feed (no cursor point); pasteItems() places beside the original.
    paste: (at: Point | null) => {
      const copies = pasteItems(at);
      // Select copies so a following nudge/drag acts on them.
      if (copies.length) select(copies.map((i: Item) => i.id));
    },
    canPaste: () => clipboardSize() > 0,
    canCopy: () => canCopyItems(selection),
    zoomToSelection: () => {
      const items = board.items.filter(i => selection.has(i.id));
      if (items.length) vp.fit(items, 120, travelMs());
    },
    // null guard for the Feed (no point); composeNote takes back empty notes.
    addNoteAt: (at: Point | null) => {
      if (!at) return;
      composeNote(() => addNote(at));
    },
    /** Place a sticker at a world point. Sticks to whatever it lands on via ordinary measurement. */
    addStickerAt: (shape: string, at: Point, tint?: string) => addSticker(shape, at, tint),
    /** Open the sticker picker — shape selection is the decision, unlike notes. */
    stickers: () => toggleStickerWindow(),
    /** Mobile "More" menu — the creation tools that don't fit the bar. */
    moreTools: () => {
      const btn = document.querySelector('#toolbar [data-cmd="more-tools"]');
      if (!btn) return;
      // Second tap closes — menu already dismissed by its own outside-press listener.
      if (justDismissed(btn)) return;
      openAnchored(btn.getBoundingClientRect(), [
        { label: 'Add a colour', icon: 'i-swatch', action: () => cmds.addSwatch() },
        { label: 'Add a link', icon: 'i-link', action: () => cmds.addLink() },
        { label: 'Stickers', icon: 'i-sticker', action: () => cmds.stickers() },
      // focus: true — opened by a press, not a hover.
      ], { label: 'More tools', owner: btn, focus: true });
    },
    // --- one card at a time: the can*/setter pairs the menu reads ---
    ...itemMetaCommands(),

    // Second tap on Find closes it (see open() in ui/search.ts).
    find: () => openSearch(document.querySelector('#toolbar [data-cmd="find"]')),
    getSetting: (key: string) => settingsBag()[key],
    // Typed readers for UI controls — getSetting returns unknown (fine for console).
    settingOn: (key: string) => !!settingsBag()[key],
    settingNumber: (key: string) => {
      const value = settingsBag()[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    },
    toggleSetting: (key: string) => setSetting(key, !settingsBag()[key]),
    // For the flyout's Spacing slider (outside the settings schema).
    setSetting: (key: string, value: unknown) => setSetting(key, value),
  };

  return cmds;
}
