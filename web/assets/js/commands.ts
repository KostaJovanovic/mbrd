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
//
// ── Five of it are in commands/ ──
//
// createCommands() had grown to ~830 lines in one object literal - five
// unrelated subjects with no boundary between them but a `// ---` comment. The
// runs were already contiguous, so each of them is now a file under commands/
// and a `() => ({ ... })` factory spread back into the object below:
//
//   commands/file.ts        new, open, the library, save, the three ways out,
//                           the two derived artefacts, the optimiser
//   commands/connections.ts the tool, the generator, the mark, the four edits
//   commands/fences.ts      the band's offer, the menu's way in, the region
//   commands/view.ts        the lenses, the camera, the chrome resets - the one
//                           of the five that needs `vp`
//   commands/item-meta.ts   the ~20 can*/setter pairs the right-click menu asks
//
// What stayed here is what nothing else could hold: the things that put
// something new on the board, the selection-wide actions, the title card, the
// arrangements, and the four entries that call `cmds` back (moreTools,
// addNoteAt). The merge is a spread, so this hands out the same object with the
// same keys - which is what makes the `data-cmd` contract in index.html, and
// tests/settings-panel.js's check of it, indifferent to the whole change.

import { toast } from './notify.ts';
import {
  board, selection, selectAll, removeItems, setSetting, undo, redo, byId,
  raiseSelection, lowerSelection, selectionHasStackOverlap,
  duplicateItems, select,
  setBoardMode as selectBoardMode,
  restoreTitleCard, resetTitlePosition,
  isFurniture, isRider, isFence, isLocked, setArrangement,
  addItems,
  snapshotGeom, applyGeom, commitGeom,
} from './state.ts';
import { alignTargets, distributeTargets, separateOverlaps } from './geometry.ts';
// Still needed here for zoomToSelection, which is a selection-wide action and
// stayed put; the rest of the camera went to commands/view.ts with it.
import { travelMs } from './canvas/viewport.ts';
import { pickFiles, addNote, addSwatch, addLink, addSticker } from './import/drop.ts';
import { linkURL, SWATCH_DEFAULT, defaultSize } from './canvas/renderers.ts';
import { samplePixels, dominantColors } from './ui/pigments.ts';
import { arrange } from './arrange/arrangements.ts';
import { ask } from './ui/dialog.ts';
import { pickColor } from './ui/color-picker.ts';
import { getAsset, assetURL } from './storage/assets.ts';
import { close as closeSidebar } from './ui/sidebar.ts';
import { closeToolbar } from './ui/toolbar.ts';
import { openContextMenu, openAnchored } from './ui/menu.ts';
import { open as openSearch } from './ui/search.ts';
import { toggleStickerWindow } from './ui/sticker-window.ts';
import {
  openPanel as openHeaderPanel, closePanel as closeHeaderPanel,
  isPanelOpen as isHeaderPanelOpen,
} from './ui/mobile-header.ts';
import { composeNote, editNote } from './canvas/notes.ts';
import { editTitleCard } from './ui/board-title.ts';
import { armClear, rearrange } from './ui/board-actions.ts';
import { fileCommands } from './commands/file.ts';
import { connectionCommands } from './commands/connections.ts';
import { fenceCommands, sharedFence } from './commands/fences.ts';
import { viewCommands } from './commands/view.ts';
import { itemMetaCommands } from './commands/item-meta.ts';
import type { CommandViewport } from './commands/view.ts';
import type { ViewPerf } from './perf/view-perf.ts';
import type { Item, ItemMeta } from './board-model.ts';
import type { Point } from './arrange/arrangements.ts';

// The one piece of the fence run that is a decision rather than a wire, and the
// only one testable without a board on screen. Re-exported by name from where it
// now lives, so tests/fences.test.js keeps the import it always had - the same
// idiom state.ts uses, and for the same reason: an export that stops existing
// should break loudly here rather than quietly at a call site.
export { sharedFence };

/**
 * An address somebody typed, which is a narrower thing than an address that
 * arrived.
 *
 * linkURL() is strict on purpose and stays strict everywhere else: it decides
 * what a *paste* meant, and there `example.com/things` is a sentence fragment
 * as easily as an address - so guessing `https://` at it would silently rewrite
 * what somebody wrote. See its own note.
 *
 * Here the intent is not in doubt. The user pressed a button called Add a link
 * and typed into a box that says `https://example.com` under the caret; there
 * is no second reading of what they meant, and refusing `example.com` because
 * it lacks four characters the placeholder is already showing is the app being
 * pedantic about a question it has the answer to. So the scheme is filled in
 * once, and only when there is none - anything already carrying one is handed
 * to linkURL() untouched and lives or dies by its verdict.
 *
 * Exported for its test and for no other caller: it is the one piece of this
 * file that is a decision rather than a wire, and the only piece that can be
 * checked without a viewport.
 */
export function linkTyped(text: string) {
  const direct = linkURL(text);
  if (direct) return direct;
  // A scheme is what the URL grammar says it is, not the presence of `://`.
  // That shortcut let `mailto:a@b.c` through the guard and came back out as
  // `https://mailto:a@b.c/` - an address nobody typed, pointing nowhere, on a
  // card claiming to be a link to it. Anything already carrying a scheme has
  // had its answer from linkURL() and keeps it.
  return /^[a-z][a-z0-9+.-]*:/i.test(text.trim()) ? null : linkURL('https://' + text.trim());
}

/**
 * The half of the Viewport this file asks for, on top of the half
 * commands/view.ts asks for.
 *
 * Structural for the reason CommandViewport gives: naming a whole Viewport here
 * would be asserting a shape this file does not use, and the seam is what lets
 * a test drive these commands with five fields rather than a canvas. What is
 * added is the centre of the view in world coordinates - the point every "add
 * a thing" command drops onto - and the fit() a selection is zoomed with.
 */
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
  /**
   * The frame profiler, made in main.ts against the live Viewport. Injected
   * rather than imported for the plain reason that it is an *instance* - there
   * is one per session and it closes over the viewport it times.
   */
  perf: ViewPerf;
}

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
export function createCommands(vp: CommandsViewport, { resetAppearance, setWhimsy, perf }: CommandDeps) {
  /**
   * The board's settings as a plain bag of keys, which is what the three
   * settings doors below need.
   *
   * BoardSettings is a closed type and these three take the key as a bare
   * string: it arrives from a `data-cmd` button, from the flyout's slider, or
   * from `mbrd.cmds.setSetting()` in the console, and setSetting() in state.ts
   * is what decides whether it names anything. A key that names nothing reads
   * as undefined, which is what `unknown` already says.
   *
   * A function rather than a binding: `board.settings` is *replaced* on a layout
   * switch (activateLayoutSettings), so a copy taken once would go stale.
   */
  const settingsBag = (): Record<string, unknown> => board.settings;

  const cmds = {
    ...fileCommands(),

    addFiles: () => pickFiles(),
    // The three that are typed rather than dropped all ask the same way. What
    // they have in common is that pressing the tool is not the whole of the
    // action - there is a word, a colour or an address still to come - and the
    // dialog is where it comes, so nothing lands on the board until there is
    // something to put on it. Cancelling leaves no card behind to tidy up.
    //
    // The note is the one of the three that is not a question, because there is
    // no answer a box could take: it is written on the sticky itself, in front
    // of the board, and dropped. See composeNote() - the item is real from the
    // first keystroke and the editor is the ordinary one, so what is being
    // written on behaves like a note for the plain reason that it is one.
    //
    // It is handed *how* to make the note rather than a note, because taking one
    // back needs the command that made it, and holding that command is easier
    // than reasoning about where it ended up in the history.
    //
    // `tint` is the one thing this takes, and it arrives from the toolbar's
    // hover flyout - the four sheets of note paper, which had no way of being
    // chosen before. Omitted is the whole of the old behaviour: addNote() in
    // import/drop.js cycles NOTE_TINTS when it is given nothing, and the
    // toolbar's click handler calls every command with no arguments, so a plain
    // press of the Note button is unchanged by construction.
    addNote: (tint?: number) => composeNote(
      () => addNote(vp.toWorld(vp.left + vp.cx, vp.top + vp.cy), '', tint)),
    // A colour of your own, chosen before the card exists. The well on the card
    // is a real colour input and still is, so this is not the only way to set
    // one - but arriving grey and waiting to be told meant every swatch was two
    // actions, and SWATCH_DEFAULT is what the picker opens on rather than what
    // the board gets.
    //
    // Asked through pickColor() rather than ask(), which is the difference
    // between choosing the colour in this app and choosing it in a system panel
    // drawn over it. See the head of ui/color-picker.js.
    addSwatch: async () => {
      const picked = await pickColor({ title: 'Add a colour', go: 'Add', value: SWATCH_DEFAULT });
      if (!picked) return;
      addSwatch(vp.toWorld(vp.left + vp.cx, vp.top + vp.cy), picked);
    },
    // The same card, for a colour that has already been chosen - the toolbar's
    // hover flyout offers the board's own pigments, and picking one of those is
    // not a question to open a dialog about. The dialog is still the row at the
    // foot of that flyout, and still the plain click on the button.
    addSwatchOf: (hex: string) => addSwatch(vp.toWorld(vp.left + vp.cx, vp.top + vp.cy), hex),
    // A card for somewhere else, typed rather than dropped. Nothing is fetched:
    // a link card is a name and an address until somebody clicks it, and that
    // stays true however the address arrived.
    addLink: async () => {
      const typed = await ask({
        title: 'Add a link',
        go: 'Add',
        field: { placeholder: 'https://example.com', type: 'url' },
      });
      // null is every way out of the dialog, including an empty box.
      if (!typed) return;
      const url = linkTyped(typed);
      if (!url) { toast('That is not an address this can open', 'error'); return; }
      addLink(vp.toWorld(vp.left + vp.cx, vp.top + vp.cy), url);
    },
    // Pull a picture's own colours off it and drop them beside it as swatches.
    //
    // The same read the Dynamic palette does - the hue vote in ui/pigments.js -
    // but of this one image rather than the whole board, and stopped a step
    // early so each swatch is a colour the picture actually holds. The swatches
    // are laid in a little masonry block centred on the image and land as one
    // undo step; each remembers the image it came from in meta.from, which is a
    // plain id and so survives the meta normaliser (only cover/shot/thumb hashes
    // are stripped). A picture with no colour worth taking says so and adds none.
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
      // x and y are placeholders: arrange() returns one point per item and the
      // sweep below writes both of them before addItems() ever sees the array.
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

    // Two commands rather than one that reads the selection, so that neither can
    // lie about what it is going to touch: the sidebar button says "Rearrange
    // everything" and does, whatever happens to be selected at the time.
    // Hints are left where they are. An arrangement is a statement about how the
    // board's contents relate, and three cards that are about to leave are not
    // contents - dealing them slots would also scatter them out of reading order.
    rearrange: () => rearrange(board.items.filter(i => i.type !== 'ghost')),
    // Which layout the board is in, and the way to change it from the toolbar's
    // hover flyout. Two writes on one press, deliberately: the layout is a
    // property of the board that outlives the press - the panel's own hint says
    // new drops use it - so picking Masonry and watching nothing move would be
    // the button lying about what it just did, and picking Masonry without the
    // setting following would leave the flyout and the panel disagreeing about
    // what this board's layout is.
    //
    // Only the second half is on the undo stack. setArrangement is off it by
    // design (see state.js) and rearrange files its own geometry entry, so one
    // Ctrl+Z puts the cards back and leaves the board set to the layout you
    // asked for - which is the right half to keep, since the setting is a
    // statement of intent and the positions are the thing you might regret.
    arrangement: () => board.arrangement,
    arrangeAs: (name: string) => {
      setArrangement(name);
      rearrange(board.items.filter(i => i.type !== 'ghost'));
    },
    // The whimsy axis, as a command so the dial on the fourth hint card can drive
    // it - that card is built under canvas/, which cannot import ui/appearance.js.
    setWhimsy: (level: number | string) => setWhimsy(level),
    rearrangeSelection: () => rearrange(board.items.filter(i => selection.has(i.id))),
    /** Whether Rearrange selection would do anything - the flyout greys it out. */
    hasSelection: () => selection.size > 0,

    // Line the selection up, or space it out evenly. A family of small commands
    // rather than a mode or a mystery drag: each names exactly the edge or axis
    // it touches, so the menu row and the undo entry read the same word. The
    // three-call shape - snapshot, apply live, commit - is the same one every
    // geometry gesture uses (see resetTitlePosition), which is what makes a
    // tidy-up one undo step and re-snaps it onto the lattice when snapping is on.
    //
    // Furniture and regions are left out for the reason rearrange leaves hints
    // out: a hint card is talking to the person, and a fence is a container whose
    // edges mean membership - neither is a card in a row being straightened. The
    // pure arithmetic is in geometry.js; this only reads the selection and files
    // the result. Mobile has no free positions to line up, so it declines.
    alignSelection: (edge: string) => {
      if (board.layoutMode === 'mobile') { toast('Aligning is a canvas thing'); return; }
      // Pinned items are out for the same reason furniture and fences are: this
      // straightens a row of cards, and a sticky fixed to one of them is not a
      // card in that row. Lining it up would peel it off the photograph it was
      // pressed onto - and it comes along anyway, at its own fraction of a host
      // the sweep did move.
      //
      // And locked cards, which is the one exclusion here that is a promise
      // rather than a judgement: a lock means the geometry does not change, and
      // an Align that quietly moved a locked card would be the exception that
      // makes the whole feature untrustworthy. They drop out of the overlap
      // sweep below with everything else that is excluded, so a straightened
      // row can be laid across a locked card - which is the honest outcome of
      // "this one does not move" and the same thing furniture already does.
      const items = board.items.filter(i =>
        selection.has(i.id) && !isFurniture(i) && !isFence(i) && !isRider(i) && !isLocked(i));
      if (items.length < 2) { toast('Pick two or more cards to line up'); return; }
      const ids = items.map(i => i.id);
      const labels: Record<string, string> = {
        left: 'Align left', right: 'Align right', hcenter: 'Align centre',
        top: 'Align top', bottom: 'Align bottom', vcenter: 'Align middle' };
      const label = labels[edge] || 'Align';
      // Lining up on a shared edge stacks everything into one band across the
      // other axis, so cards that were apart there now sit on top of each other.
      // Spread them back out along that axis - the horizontal edges share an x,
      // so they separate on y, and the vertical edges the other way round. A
      // sweep, not a repack: only a run that would collide is opened up.
      const spread = edge === 'top' || edge === 'bottom' || edge === 'vcenter' ? 'x' : 'y';
      const targets = separateOverlaps(alignTargets(items, edge), items, spread, board.settings.spacing || 0);
      const before = snapshotGeom(ids);
      applyGeom(targets);
      commitGeom(label, before, ids);
    },
    distributeSelection: (axis: 'x' | 'y') => {
      if (board.layoutMode === 'mobile') { toast('Spacing out is a canvas thing'); return; }
      // Riders out, as in alignSelection above and for the same reason.
      const items = board.items.filter(i =>
        selection.has(i.id) && !isFurniture(i) && !isFence(i) && !isRider(i) && !isLocked(i));
      if (items.length < 3) { toast('Pick three or more cards to space out'); return; }
      const ids = items.map(i => i.id);
      const before = snapshotGeom(ids);
      applyGeom(distributeTargets(items, axis));
      commitGeom(axis === 'x' ? 'Distribute across' : 'Distribute down', before, ids);
    },

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
    isTitleCard: (id: string) => byId(id)?.type === 'title',
    resetTitlePosition: () => resetTitlePosition(),
    // A string rather than a LayoutMode, because of where it comes from: the
    // sidebar calls this with what readPref() gave back on the way up, which is
    // whatever was in localStorage and may be nothing at all. setBoardMode() in
    // layout.ts is what decides whether it names a profile - it answers false
    // for anything that does not - so the check lives there rather than being
    // asserted here about a value this file has not seen.
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

    selectAll,
    undo, redo,
    deleteSelection: () => {
      if (!selection.size) return;
      removeItems([...selection]);
    },
    // Escape means "put the sheets away", and there are three of them now - the
    // main panel, the masthead's, and the toolbar's own drawer on a phone. One
    // command rather than three, because the key that closes a panel should not
    // have to be told which panel is up. Still named for the sidebar, which is
    // what the keyboard binds to and what it means to whoever presses it.
    closeSidebar: () => { closeSidebar(); closeHeaderPanel(); closeToolbar(); },
    editNote,

    // --- right-click menu ---
    contextMenu: (x: number, y: number, id: string | null, count: number,
      opts?: { mobile?: boolean }) => openContextMenu(x, y, id, count, opts),
    selectionHasStackOverlap,
    raise: raiseSelection,
    lower: lowerSelection,
    duplicate: () => {
      const copies = duplicateItems(selection);
      if (copies.length) select(copies.map((i: Item) => i.id));
    },
    zoomToSelection: () => {
      const items = board.items.filter(i => selection.has(i.id));
      if (items.length) vp.fit(items, 120, travelMs());
    },
    // The point is nullable because ui/menu.ts's MenuCommands says it is: the
    // menu builds "Add a note here" from the point it was opened at, and the one
    // surface with no point of its own - the Feed, where a note would be packed
    // into a column rather than placed - drops the row instead of passing none.
    // So this is the unreachable half of that contract, written down rather than
    // left to throw inside addNote() if it ever stops being unreachable.
    addNoteAt: (at: Point | null) => {
      if (!at) return;
      const item = addNote(at);
      requestAnimationFrame(() => cmds.editNote(item.id));
    },
    /**
     * Press a sticker onto the board at a world point.
     *
     * The one door onto the type, and everything that places one goes through
     * it: the window's pointer drag, its tap-to-arm, and - until either of
     * those exists - `mbrd.cmds.addStickerAt('s-star', mbrd.vp.centre())` from
     * the console. A drop that lands over a card sticks to it and is pinned
     * immediately, which is not special-cased anywhere: addItems() puts the
     * sticker on top, and the ordinary measurement does the rest.
     */
    addStickerAt: (shape: string, at: Point, tint?: string) => addSticker(shape, at, tint),
    /**
     * The toolbar's Stickers button. A tool that opens a drawer rather than one
     * that makes something: which shape it is *is* the whole of the decision,
     * so there is no default sticker the way there is a default note.
     */
    stickers: () => toggleStickerWindow(),
    /**
     * The phone's More button: the three creation tools that no longer fit the
     * bar, as a menu hanging off the one that replaced them.
     *
     * A menu and not a second tier, because that is what ui/menu.js is for and
     * there is exactly one of it in this app - openAnchored() is how a menu that
     * is not at a cursor gets opened. Not a FLYOUTS entry either: those open on
     * hover and this is a tap, on the one layout that has no hover at all.
     *
     * It reads the button out of the document rather than being handed it,
     * because a command takes no arguments from the toolbar - ui/toolbar.js
     * calls every one of them bare. The rect is captured at open time, so the
     * drawer closing underneath (which it does, after every command) leaves the
     * menu where it was rather than dragging it down.
     */
    moreTools: () => {
      const btn = document.querySelector('#toolbar [data-cmd="more-tools"]');
      if (!btn) return;
      openAnchored(btn.getBoundingClientRect(), [
        { label: 'Add a colour', icon: 'i-swatch', action: () => cmds.addSwatch() },
        { label: 'Add a link', icon: 'i-link', action: () => cmds.addLink() },
        { label: 'Stickers', icon: 'i-sticker', action: () => cmds.stickers() },
      ], { label: 'More tools' });
    },
    // --- one card at a time: the can*/setter pairs the menu reads ---
    ...itemMetaCommands(),

    // On the command surface as well as on Ctrl+K, because a keyboard shortcut
    // nothing mentions is a feature only the person who wrote it has.
    find: () => openSearch(),
    getSetting: (key: string) => settingsBag()[key],
    toggleSetting: (key: string) => setSetting(key, !settingsBag()[key]),
    // The dial's half of the pair. The panel writes settings through
    // ui/settings-schema.js, which imports setSetting straight; the flyout's
    // Spacing slider is outside that schema and goes through here.
    setSetting: (key: string, value: unknown) => setSetting(key, value),
  };

  return cmds;
}
