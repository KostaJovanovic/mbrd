// @ts-nocheck - TypeScript migration debt, not a judgement about this file.
//
// The tree was renamed from .js to .ts mechanically, which moved 104 modules in
// one step and annotated none of them. This module is carried unchecked so that
// npm run typecheck stays green and keeps meaning something, rather than going
// red and being ignored. Converting this module IS deleting this block and
// fixing what tsc then says - tests/ts-debt.test.js holds the count and lets it
// only fall.
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

import { toast, busy } from './notify.ts';
import { DEFAULT_SCALE } from './measure.ts';
import {
  board, selection, selectAll, removeItems, setSetting, undo, redo, byId,
  raiseSelection, lowerSelection, selectionHasStackOverlap,
  duplicateItems, select, setItemCover, setItemUpAxis, setItemFit, setStickerTint,
  setBoardMode as selectBoardMode,
  restoreTitleCard, resetTitlePosition,
  addConnections, clearConnections, updateConnection, connectionMeta, toggleConnection,
  isFurniture, isRider, unstickItems, isJoinEnd, setArrangement,
  addItems, baseStep, isFence, fenceAt, fenceBox, fenceFollowers, fenceOf, nextFenceName,
  snapshotGeom, applyGeom, commitGeom,
} from './state.ts';
import { itemBounds, MAX_SIZE, MIN_SIZE, alignTargets, distributeTargets, separateOverlaps } from './geometry.ts';
import { editItemName } from './canvas/items.ts';
// The spanning tree, which used to be the web and is now the generator behind
// "Join these" - see cmds.connectSelection and the header of web-graph.js.
import { threads } from './web-graph.ts';
import { defaultUpAxis, meshKind } from './mesh.ts';
import { travelMs } from './canvas/viewport.ts';
import { isTurning, rotateModel } from './canvas/model.ts';
import {
  connectionAt, activeConnection, setActiveConnection, clearActiveConnection,
} from './canvas/web.ts';
import { pickFiles, pickCover, addNote, addSwatch, addLink, addSticker } from './import/drop.ts';
import { stickerTint } from './stickers/catalogue.ts';
import { linkURL, SWATCH_DEFAULT, defaultSize } from './canvas/renderers.ts';
import { samplePixels, dominantColors } from './ui/pigments.ts';
import { arrange } from './arrange/arrangements.ts';
import { ask } from './ui/dialog.ts';
// The editor that follows the marked line. Kept true from here for the two
// moves that change the mark without redrawing it - see pickConnection.
import { syncConnChip } from './ui/conn-chip.ts';
import { pickColor } from './ui/color-picker.ts';
import { exportBoard, openBoard, newBoard, shareBoard, saveBlob } from './storage/storage.ts';
import { boardPng, boardPdf } from './ui/snapshot.ts';
import { openLibrary } from './ui/library.ts';
import { getAsset, assetURL } from './storage/assets.ts';
import { close as closeSidebar } from './ui/sidebar.ts';
import { closeToolbar, setArmed, connectArmed, connectTap } from './ui/toolbar.ts';
import { clearQualityOverrides } from './quality.ts';
import { openContextMenu, openAnchored } from './ui/menu.ts';
import { openViewer, canView } from './ui/viewer.ts';
import { openFencePrompt } from './ui/fence-prompt.ts';
import { open as openSearch } from './ui/search.ts';
import { openCredits } from './ui/credits.ts';
import { setLens, currentLens } from './ui/board-view.ts';
import { togglePlayerWindow } from './ui/playlist.ts';
import { toggleStickerWindow } from './ui/sticker-window.ts';
import { togglePlayback } from './canvas/audio.ts';
import {
  openPanel as openHeaderPanel, closePanel as closeHeaderPanel,
  isPanelOpen as isHeaderPanelOpen,
} from './ui/mobile-header.ts';
import { composeNote, editNote } from './canvas/notes.ts';
import { paintZoom, zoomText } from './ui/hud.ts';
import { editTitleCard } from './ui/board-title.ts';
import {
  saveWithCooldown, armClear, resetSize, rearrange,
  reloadBoard, restartApp, scaleFromItem,
} from './ui/board-actions.ts';

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
export function linkTyped(text) {
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
 * Make sure the board is showing its connections, before drawing one.
 *
 * The migration nobody would otherwise notice. `settings.web` defaults to on
 * now, but a board saved by any earlier build carries an explicit `false` -
 * every board that never had the automatic web switched on does - and absence
 * of the key is the only case the new default reaches. Without this, somebody
 * on an existing board would press Join, pick two cards, and be shown nothing:
 * the connection is there, the setting is hiding it, and there is no way to
 * guess that from the screen.
 *
 * So arming the tool, or asking the generator for a set, turns the switch on.
 * You cannot ask for a line to be drawn and mean "but not shown", and the
 * checkbox is still one click away in View for anyone who wants them hidden
 * afterwards. Silent because it is not a decision - it is the tool refusing to
 * be pressed into doing nothing visible.
 */
function showConnections() {
  if (board.settings.web === false) setSetting('web', true);
}

/**
 * What may carry a line, out of some set of items.
 *
 * Furniture is out because a hint card relates to nothing - it is talking to
 * the person, not to the board - and the title card is the board's name. Riders
 * are out because a stuck note is part of the card it is pinned to, and the web
 * layer will not draw a line to one anyway. Fences are out because a line to a
 * region is a line to no particular card, and the generator would spend edges
 * joining boxes to the things already inside them.
 *
 * One predicate rather than three copies of it: both doors into the generator
 * ask the same question, and so does the tool when it reads the selection.
 */
const joinable = items =>
  items.filter(i => !isFurniture(i) && !isRider(i) && !isFence(i) && isJoinEnd(i));

/**
 * Run the generator over a pool of cards and say what it drew.
 *
 * The spanning tree that used to *be* the web, turned into real connections -
 * the same ones a hand would have drawn, editable and removable one at a time
 * afterwards. One undo entry for the set, because you asked for a set.
 *
 * The graph works in the same plane the cards do; y is not flipped for it the
 * way canvas/web.js flips it to draw, because a reflection cannot turn a
 * non-crossing set into a crossing one and the tree is the same tree.
 */
function joinAll(pool, label = 'Join cards') {
  showConnections();
  const pts = pool.map(i => ({ id: i.id, x: i.x, y: i.y, w: i.w, h: i.h, rot: i.rot || 0 }));
  const made = addConnections(
    threads(pts).map(([a, b]) => [pts[a].id, pts[b].id]),
    label);
  toast(made
    ? `Joined ${made} pair${made === 1 ? '' : 's'}`
    : 'Those are already joined');
  return made;
}

// ---------------------------------------------------------------------------
// Fences
//
// Two ways in - a rubber band, and the group menu - and one thing they do, so
// the making of a fence is here once rather than in each of them. What differs
// is only what each is allowed to ask for: the band may draw an empty region
// because it has a rectangle, the menu may not because it has nothing to draw.
// ---------------------------------------------------------------------------

/** What a fence would be drawn round: the selection, less the furniture. */
const fenced = () => board.items.filter(i => selection.has(i.id) && !isFurniture(i));

/**
 * The one region these items are all already in, or null.
 *
 * A band drawn inside a fence is the ordinary way to get at some of what is in
 * it - pick out four of the twelve and move them - and the offer has no business
 * appearing over that. The grouping it proposes is one the board already has:
 * every card it would enclose is enclosed now, by a region drawn round them for
 * that very reason, so accepting would draw a second boundary exactly where the
 * first one already is. And the cost of asking is not nothing, because the button
 * lands beside the pointer, which is where the hand is about to reach for the
 * cards it just selected.
 *
 * Only when they *share* one. Cards caught from two different regions, or some
 * loose and some not, are a grouping the board does not have yet, so the offer
 * stands - as it does when the band swallowed the fence itself (a region drawn
 * round a region is a real thing to want, and the fence is then one of the caught
 * items, whose own fence is not it).
 *
 * What this gives up is making a *nested* region by banding part of one, and that
 * is the trade: it is much the rarer gesture, and it keeps its other way in - the
 * group menu's Fence these, which asks in so many words rather than by guessing
 * from a rectangle. Suppressing an offer is not removing a command.
 */
export function sharedFence(items) {
  if (!items.length) return null;
  const first = fenceOf(items[0]);
  return first && items.every(it => fenceOf(it)?.id === first.id) ? first : null;
}

/**
 * Desktop only, because membership is measured on Desktop geometry and nowhere
 * else (see fences.js). A fence made on a phone would have Mobile geometry, no
 * Desktop record to measure against, and no way to acquire one - it would open
 * on a laptop owning nothing.
 */
function fenceable() {
  if (board.layoutMode !== 'mobile') return true;
  toast('Fences are a canvas thing');
  return false;
}

/**
 * Put a fence over `rect` (a world-space `{x0,y0,x1,y1}`, or null), the current
 * selection, or both.
 *
 * Three details are load-bearing rather than taste:
 *
 * The fence takes a z **below** every card it encloses. Not for painting - every
 * fence is behind every card by band now, see visualStackOrder() - but because
 * raising a fence carries its members and walks them in raw z order, so being the
 * lowest thing in its own layer is what keeps it under them within it. An empty
 * one goes behind the whole board, since anything at all might be dragged into it
 * later and there is no smaller answer.
 *
 * Membership is not recorded here, and there is nothing to record: the cards are
 * inside the rectangle, so they are in the fence, and that stays true because it
 * is measured rather than stored. Which is also why undo needs no help - taking
 * the fence away leaves the cards exactly where they are.
 *
 * The name field opens straight away, in an animation frame so the card exists to
 * open it on, and over a default name rather than an empty plate - the field
 * opens with its text *selected*, so typing replaces the default and pressing
 * Escape keeps it. An unnamed fence is a box; the name is the whole reason to
 * draw one, and asking for it later means never.
 */
/**
 * The rectangle a fence would take right now, from a drawn band or without one.
 *
 * Named because two callers need the same answer and one of them is only
 * looking: the offer draws this faintly where the fence would land, and drawing
 * anything else there would be a promise the accept does not keep.
 */
const wouldFence = rect => fenceBox(rect, itemBounds(fenced()), baseStep());

function drawFence(rect) {
  const inside = fenced();
  const box = wouldFence(rect);
  if (!box) return;
  // An item is bounded to MAX_SIZE like everything else, and makeItem() clamps
  // silently. A fence clamped down is the one shape whose clamping changes what
  // it *means* - it would come out smaller than what it was drawn to hold - so
  // this says so instead of drawing a lie.
  if (box.w > MAX_SIZE || box.h > MAX_SIZE) {
    toast('Those are too far apart to fence');
    return;
  }
  const under = inside.length ? inside : board.items.filter(i => !isFurniture(i));
  const [fence] = addItems([{
    type: 'fence',
    name: nextFenceName(),
    x: box.x, y: box.y, w: box.w, h: box.h,
    z: Math.min(0, ...under.map(i => i.z || 0)) - 1,
  }], 'Add a fence');
  if (!fence) return;
  select([fence.id]);
  requestAnimationFrame(() => editItemName(fence.id));
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
/**
 * A download name for a board's derived PNG/PDF, from its title. Held to word
 * characters, spaces and dashes - the artefact carries the board's name, not its
 * punctuation, and it is a filename bound for a dozen different filesystems.
 */
function boardArtefactName(ext) {
  const base = (board.title || '').replace(/[^\w -]+/g, '').trim().slice(0, 60) || 'board';
  return `${base}.${ext}`;
}

export function createCommands(vp, { resetAppearance, setWhimsy }) {
  const cmds = {
    new: () => newBoard(),
    open: () => openBoard(),
    // The board library - several boards kept in this browser, not just the one
    // the session slot holds. Opens the switcher (ui/library.js); the storage
    // behind it is in storage/library.js. Distinct from New, which still guards
    // the single session slot by offering to export first: the library's own New
    // has the shelf to set the old board on, so it never has to ask.
    library: () => openLibrary(),
    save: () => saveWithCooldown(),
    export: () => exportBoard(),
    exportAs: () => exportBoard({ pickNew: true }),
    // The mobile face of Export: the same packed .mbrd, handed to the OS share
    // sheet instead of a download folder a phone has no good way to reach. Falls
    // back to Export where files cannot be shared - see shareBoard().
    share: () => shareBoard(),
    // A picture of the board, for showing rather than reopening. A moodboard
    // exists to be presented, and until these two the only thing that left mbrd
    // was a .mbrd only mbrd can read. The board is composited onto a canvas
    // (ui/snapshot.js) - not the live DOM, which taints the canvas the moment it
    // holds a picture - and handed out as a PNG, or wrapped in a one-page PDF for
    // printing. Both are derived artefacts, never .mbrd: their own types, their
    // own filenames, and they never touch the file handle Export remembers.
    exportImage: async () => {
      const job = busy('Drawing the board');
      try {
        const blob = await boardPng();
        if (!blob) { toast('There is nothing on the board to save yet'); return; }
        saveBlob(blob, boardArtefactName('png'));
        toast('Saved a picture of the board');
      } catch (err) {
        console.error(err);
        toast('Could not draw the board: ' + err.message, 'error');
      } finally { job.end(); }
    },
    exportPdf: async () => {
      const job = busy('Drawing the board');
      try {
        const blob = await boardPdf();
        if (!blob) { toast('There is nothing on the board to save yet'); return; }
        saveBlob(blob, boardArtefactName('pdf'));
        toast('Saved a PDF of the board');
      } catch (err) {
        console.error(err);
        toast('Could not draw the board: ' + err.message, 'error');
      } finally { job.end(); }
    },
    // Strictly asked for, never automatic - see optimize/optimize.js. Loaded on
    // demand as well as run on demand: the encoder behind it is thirty megabytes
    // and a board of photographs never needs it.
    optimize: () => import('./optimize/ui.ts').then(m => m.optimizeBoard()),
    discardOriginals: () => import('./optimize/ui.ts').then(m => m.discardOptimizeOriginals()),

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
    addNote: tint => composeNote(
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
    addSwatchOf: hex => addSwatch(vp.toWorld(vp.left + vp.cx, vp.top + vp.cy), hex),
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
    canExtractSwatches: id => {
      const it = byId(id);
      return !!(it && it.type === 'image' && it.asset?.hash && getAsset(it.asset.hash));
    },
    extractSwatches: async id => {
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
      const partials = hexes.map(h => ({
        type: 'swatch', name: h.toUpperCase(),
        w: size.w, h: size.h, meta: { hex: h, from: id },
      }));
      const spots = arrange(partials, {
        name: 'masonry',
        center: { x: it.x, y: it.y + it.h / 2 + size.h },
        spacing: board.settings.spacing,
      });
      spots.forEach((p, i) => { partials[i].x = p.x; partials[i].y = p.y; });
      const made = addItems(partials, 'Extract palette');
      select(made.map(m => m.id));
    },
    // --- connections ---
    // The one tool on the bar that is a mode. Pressing it arms; pressing it
    // again, or Escape, puts it down. What a press on the board then means is
    // ui/toolbar.js's connectStep(), and canvas/input.js asks through the two
    // below rather than importing a ui/ module it has no business importing -
    // the same seam the title card's pen and the whimsy dial already use.
    connect: () => {
      if (board.layoutMode === 'mobile') {
        toast('Connections are a canvas thing');
        return;
      }
      if (connectArmed()) { setArmed(false); return; }
      // A selection made before the tool was pressed is already an answer to
      // "which cards", and the tool used to throw it away and ask again. So it
      // is read once, here, at the moment of arming - not on every press, which
      // would make what a click means depend on what happened to be picked
      // three clicks ago.
      //
      // Two selected or twenty is the generator's question, not the tool's, so
      // it goes straight to joinAll: you pointed at a set and asked for it to be
      // joined, and the answer is a set of lines in one undoable step. Exactly
      // one selected is half a pair, so it becomes the picked end and the next
      // card you press completes it.
      //
      // Armed either way, and that is the point of doing it here rather than in
      // a separate command: what follows the join is more joining, on the same
      // board, with the same tool already in your hand.
      const picked = joinable(board.items.filter(i => selection.has(i.id)));
      setArmed(true, picked.length === 1 ? picked[0].id : null);
      showConnections();
      if (picked.length > 1) { joinAll(picked); return; }
      toast(picked.length
        ? 'Now pick the card to join that one to'
        : 'Pick two cards to join them. Same two again to part them.');
    },
    connectArmed,
    connectTap,
    // Give a connection a direction, a line style or a label.
    //
    // No button, like connectSelection below and for the same reason its comment
    // gives: editing a line means first pointing at one, and this app leaves
    // connections deliberately un-hit-testable (see toggleConnection in
    // state.js - the machinery a selectable line needs was judged too much for
    // it). So this is the door a keyboard binding or a future menu row would bind
    // to, and today it is reached from the console handle:
    //
    //   mbrd.cmds.setConnectionStyle(a, b, { dir: 'fwd', style: 'dashed', label: 'leads to' })
    //
    // where a and b are the two card ids. `dir` is one of none/fwd/back/both,
    // read against the pair's stored order; `style` one of solid/dashed/dotted;
    // `label` any short string, '' to clear it. A patch that names only some of
    // the three leaves the rest as they were.
    setConnectionStyle: (a, b, patch) => {
      if (!updateConnection(a, b, patch || {})) {
        toast('There is no connection between those two cards');
        return false;
      }
      showConnections();
      return true;
    },
    connectionStyle: (a, b) => connectionMeta(a, b),
    // The menu's way in: the connection whose line runs under a right-click, or
    // null. This is the hit-test toggleConnection's note said it was avoiding -
    // kept as small as that note asked, a walk over the routed points web.js
    // already holds rather than a selection model or a per-line element. Only on
    // the canvas, where a press lands on the board rather than on a card.
    connectionUnder: at => (board.layoutMode === 'mobile' ? null : connectionAt(at.x, at.y)),
    // Draw-or-part again, from the menu rather than the tool: the pair is joined,
    // so toggling parts them. Its own undo entry, like the tool's.
    removeConnection: (a, b) => { toggleConnection(a, b); },
    // ---- the line the board is pointing at ----
    //
    // A press on a line marks it, and the mark is what gives Delete something to
    // delete that is not a card. The hit-test is connectionUnder's, the mark
    // lives in canvas/web.js beside the hover it is the deliberate half of, and
    // it is deliberately not part of the selection - see the note over
    // activeConnection() there.
    //
    // Returns whether a line was found, which is what lets the press path tell a
    // click on a connection from a click on bare board. Called with nothing
    // under the pointer it clears the mark, so one call covers both.
    pickConnection: at => {
      const hit = board.layoutMode === 'mobile' ? null : connectionAt(at.x, at.y);
      setActiveConnection(hit ? hit.a : null, hit ? hit.b : null);
      // setActiveConnection redraws the mark, and the chip follows the mark - so
      // this is only here for the press that lands on nothing while nothing was
      // marked, which changes neither and would leave a stale chip up.
      syncConnChip();
      return !!hit;
    },
    activeConnection: () => activeConnection(),
    clearActiveConnection: () => { clearActiveConnection(); syncConnChip(); },
    // Delete's half. Answers whether there was one, so the key can fall through
    // to deleting the selection when there was not.
    deleteActiveConnection: () => {
      const at = activeConnection();
      if (!at) return false;
      clearActiveConnection();
      toggleConnection(at.a, at.b);
      return true;
    },
    // The label is the one connection setting that is not a choice from a short
    // list, so it is asked for rather than picked. null is every way out of the
    // box including an empty one; the way to clear a label is the menu's Remove
    // label, which sets it to '' through the same door.
    editConnectionLabel: async (a, b) => {
      const current = connectionMeta(a, b)?.label || '';
      const typed = await ask({
        title: 'Connection label',
        go: 'Set',
        field: { value: current, placeholder: 'e.g. leads to', maxLength: 60 },
      });
      if (typed === null) return;
      updateConnection(a, b, { label: typed });
      showConnections();
    },
    clearConnectionLabel: (a, b) => { updateConnection(a, b, { label: '' }); showConnections(); },
    // Every line off the board at once. In the panel's Debug fold rather than on
    // the toolbar: the way to remove one connection is to draw over it, and this
    // is the board-wide broom you want after trying the generator somewhere you
    // did not mean to. Undoable, so it says what it did rather than asking first.
    clearConnections: () => {
      const gone = clearConnections();
      toast(gone
        ? `Removed ${gone} connection${gone === 1 ? '' : 's'}`
        : 'There are no connections on this board');
    },
    /**
     * Join these for me.
     *
     * The spanning tree that used to *be* the web, run once on demand and
     * turned into real connections - the same ones a hand would have drawn,
     * editable and removable one at a time afterwards. Over the selection when
     * there is one worth calling a selection, over the whole board otherwise,
     * which is the same "everything, whatever happens to be picked" split
     * rearrange/rearrangeSelection already make.
     *
     * **No button**, and it no longer needs one for the case it was written for:
     * pressing the connector tool with two or more cards selected runs the same
     * generator over them, which is the shape somebody who has just picked a set
     * of cards actually reaches for. What survives here is the *whole board*
     * half - the thing you do once to a board rather than a tool you reach for,
     * which sat on the toolbar as a seventh segment that made the bar read as a
     * menu. The console handle is a shipped feature, and this is still the door
     * a keyboard binding or a menu row would bind to if either ever wants it.
     *
     * It is also the migration. A board that had the automatic web switched on
     * lost it the day connections became a stored list; this is how it comes
     * back, as something that can then be argued with.
     *
     * What is left out - furniture, riders, fences - is `joinable`'s answer, and
     * the same one the tool gets when it reads the selection.
     */
    connectSelection: () => {
      if (board.layoutMode === 'mobile') {
        toast('Connections are a canvas thing');
        return;
      }
      const pool = joinable(board.items.filter(i =>
        selection.size < 2 || selection.has(i.id)));
      if (pool.length < 2) {
        toast('Pick two or more cards, or put something on the board');
        return;
      }
      joinAll(pool);
    },

    /**
     * Draw a fence around what is selected, with no rectangle to go on.
     *
     * The menu's way in, and the one that survives a selection built by
     * shift-clicking, where there is no band to catch the answer. Two or more,
     * because with nothing drawn the selection is the whole of the instruction
     * and one card is not a group - the band has no such rule, since a rectangle
     * round one photograph is still a region somebody drew.
     */
    fenceSelection: () => {
      if (!fenceable()) return;
      if (fenced().length < 2) {
        toast('Pick two or more cards to fence');
        return;
      }
      drawFence(null);
    },

    /**
     * Offer to fence what a rubber band just caught, beside the pointer that let
     * it go. canvas/input.js calls this at the end of every marquee; the policy
     * for whether there is anything worth offering is here rather than there,
     * because it is a question about the board and not about the gesture.
     *
     * A band that caught nothing is still an offer - that is the empty fence you
     * could not make before, and Fences' own way of making one - but only above a
     * size, since a band flicked across empty board is how the selection gets
     * cleared and an offer after every one of those would be an interruption.
     * With something caught there is no floor: the contents set the size.
     *
     * And nothing at all when the band only picked out part of a region that
     * already exists - see sharedFence(). Note where that test sits: after the
     * empty-band case, so a rectangle drawn on a fence's bare face still offers
     * the nested region it is plainly asking for, and only a band that *caught
     * cards* is read as reaching into one.
     */
    fencePrompt: (x, y, rect) => {
      if (board.layoutMode === 'mobile') return;
      const inside = fenced();
      const count = inside.length;
      if (!count && (rect.x1 - rect.x0 < MIN_SIZE || rect.y1 - rect.y0 < MIN_SIZE)) return;
      if (sharedFence(inside)) return;
      openFencePrompt(x, y, count, wouldFence(rect), () => {
        if (fenceable()) drawFence(rect);
      });
    },

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
    arrangeAs: name => {
      setArrangement(name);
      rearrange(board.items.filter(i => i.type !== 'ghost'));
    },
    // The whimsy axis, as a command so the dial on the fourth hint card can drive
    // it - that card is built under canvas/, which cannot import ui/appearance.js.
    setWhimsy: level => setWhimsy(level),
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
    alignSelection: edge => {
      if (board.layoutMode === 'mobile') { toast('Aligning is a canvas thing'); return; }
      // Pinned items are out for the same reason furniture and fences are: this
      // straightens a row of cards, and a sticky fixed to one of them is not a
      // card in that row. Lining it up would peel it off the photograph it was
      // pressed onto - and it comes along anyway, at its own fraction of a host
      // the sweep did move.
      const items = board.items.filter(i =>
        selection.has(i.id) && !isFurniture(i) && !isFence(i) && !isRider(i));
      if (items.length < 2) { toast('Pick two or more cards to line up'); return; }
      const ids = items.map(i => i.id);
      const label = { left: 'Align left', right: 'Align right', hcenter: 'Align centre',
        top: 'Align top', bottom: 'Align bottom', vcenter: 'Align middle' }[edge] || 'Align';
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
    distributeSelection: axis => {
      if (board.layoutMode === 'mobile') { toast('Spacing out is a canvas thing'); return; }
      // Riders out, as in alignSelection above and for the same reason.
      const items = board.items.filter(i =>
        selection.has(i.id) && !isFurniture(i) && !isFence(i) && !isRider(i));
      if (items.length < 3) { toast('Pick three or more cards to space out'); return; }
      const ids = items.map(i => i.id);
      const before = snapshotGeom(ids);
      applyGeom(distributeTargets(items, axis));
      commitGeom(axis === 'x' ? 'Distribute across' : 'Distribute down', before, ids);
    },

    /**
     * The smallest region a world point is inside, or null. The menu's question,
     * asked once when it opens: a right-click inside a region should offer to
     * arrange *that*, not the board it is drawn on.
     */
    fenceUnder: at => (board.layoutMode === 'mobile' ? null : fenceAt(at.x, at.y)?.id ?? null),

    /** Is this item a region? The menu's other way in - by its name plate. */
    isFenceItem: id => isFence(byId(id)),

    /**
     * Lay one region's contents out again, in masonry, and close it around them.
     *
     * Masonry whatever the board is set to, and that is a claim about what a
     * region is for. The board's arrangement is a statement about the board -
     * a spiral, a ring, cards thrown down - and it is chosen for the shape of the
     * *whole*. A region is a shelf: what you want inside one is everything
     * visible at once with nothing wasted between, which is the one thing masonry
     * is better at than any of the others. It is also the only layout here that
     * reads as filling a rectangle rather than as occupying a space.
     *
     * The whole subtree rather than the direct members, because a nested region
     * has to arrive with its own cards - fenceFollowers() is that set, and
     * rearrange() then lays out only what the outer region holds directly and
     * carries the rest (see its `carried`).
     */
    rearrangeFence: id => {
      const fence = byId(id);
      if (!isFence(fence)) return;
      if (!fenceable()) return;
      const inside = fenceFollowers([id]).map(byId).filter(Boolean);
      if (inside.filter(i => !isRider(i)).length < 2) {
        toast('Put two or more cards in it first');
        return;
      }
      rearrange(inside, {
        name: 'masonry',
        center: { x: fence.x, y: fence.y },
        enclose: id,
        label: 'Rearrange fence',
      });
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
    isTitleCard: id => byId(id)?.type === 'title',
    resetTitlePosition: () => resetTitlePosition(),
    setBoardMode: mode => selectBoardMode(mode),
    toggleBoardMode: () => {
      const next = board.layoutMode === 'mobile' ? 'desktop' : 'mobile';
      if (!selectBoardMode(next)) return;
      toast(next === 'mobile'
        ? 'Feed: images, video & audio, vertical scroll'
        : 'Back to the canvas');
    },

    /**
     * The two mobile boards, each its own sidebar button.
     *
     * Feed is the masonry wall of everything; Playlist is the audio player. On the
     * canvas, Feed takes the whole board into its mobile view and Playlist opens
     * the floating window over the canvas instead - a player, not a takeover. Once
     * in the mobile view the pair are a switch between the two lenses, and pressing
     * the one already up steps back out to the canvas, which is the only way back
     * now that the old single toggle is gone. setLens before the mode switch so
     * entering the mobile view lands on the lens that was asked for.
     */
    /**
     * The third segment of the View row: back to the freeform board.
     *
     * Idempotent, unlike the two below it, and that is the whole of the
     * difference. Feed and Playlist are toggles - pressing the lens you are
     * already on steps back out to the canvas, which is the only way back now
     * that the old single toggle is gone - so neither can be the button that
     * *names* the canvas. This one can: pressed from the canvas it does nothing,
     * pressed from either lens it comes back. selectBoardMode() already returns
     * false for a mode that is live, so the toast is only for a real crossing.
     */
    canvas: () => {
      if (selectBoardMode('desktop')) toast('Back to the canvas');
    },
    feed: () => {
      if (board.layoutMode === 'mobile') {
        if (currentLens() === 'feed') { selectBoardMode('desktop'); toast('Back to the canvas'); }
        else setLens('feed');
        return;
      }
      setLens('feed');
      selectBoardMode('mobile');
    },
    playlist: () => {
      if (board.layoutMode === 'mobile') {
        if (currentLens() === 'playlist') { selectBoardMode('desktop'); toast('Back to the canvas'); }
        else setLens('playlist');
        return;
      }
      togglePlayerWindow();
    },
    // Space, from the canvas key handler: play or pause the current track. Returns
    // whether it did - false when nothing is loaded, so Space falls back to pan.
    playPause: () => togglePlayback(),
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
    // Dev: print what each swipe of a touchpad actually delivered - see the
    // wheel handler in canvas/input.js. The same shape as the grip overlay: an
    // attribute that module reads, a button that reflects it, and mbrd.debugWheel()
    // or the #wheel URL for the console.
    //
    // This one exists because the wheel handler is the only place in the app
    // that guesses at hardware, and the guess cannot be checked by reading it.
    // A two-finger scroll is railed by the platform before the page ever sees
    // it, and whether the sideways half arrives as nothing, as a trickle or in
    // hundred-pixel lumps decides which fix is the right one - a question only
    // the machine under the hand can answer.
    debugWheel: () => {
      const on = document.documentElement.toggleAttribute('data-debug-wheel');
      document.querySelector('[data-cmd="debug-wheel"]')?.setAttribute('aria-pressed', String(on));
      toast(on ? 'Swipe the board - each gesture prints to the console' : 'Wheel logging off');
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
    // Escape means "put the sheets away", and there are three of them now - the
    // main panel, the masthead's, and the toolbar's own drawer on a phone. One
    // command rather than three, because the key that closes a panel should not
    // have to be told which panel is up. Still named for the sidebar, which is
    // what the keyboard binds to and what it means to whoever presses it.
    closeSidebar: () => { closeSidebar(); closeHeaderPanel(); closeToolbar(); },
    editNote,

    // --- right-click menu ---
    contextMenu: (x, y, id, count, opts) => openContextMenu(x, y, id, count, opts),
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
    addStickerAt: (shape, at, tint) => addSticker(shape, at, tint),
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
    /**
     * One item, full size, on either layout.
     *
     * Routed through cmds so canvas/input.js can reach it off a double-click
     * without importing a ui/ module, which is the arrow this file exists to
     * turn around. The Feed calls openViewer() directly - it is a ui/ module
     * itself and a tile tap is not a command anybody would bind.
     */
    openViewer: id => { if (canView(id)) openViewer(id); },
    canViewItem: id => canView(id),
    canEditNote: id => byId(id)?.type === 'note',
    /**
     * Is there anything in the selection that is stuck to a host?
     *
     * Stuck, not pinned - isRider() rather than isPinned(). An item dropped
     * three seconds ago is stuck and has not set yet (see sticky.js), and
     * Unstick during that window is a real thing to want: it is how you say
     * "leave this here but do not fix it", without waiting for it to fix itself
     * so that you can unfix it.
     *
     * The selection rather than the item under the cursor, because Unstick acts
     * on the selection - "these nine are all stuck to that photograph and I
     * want them off it" is the same sentence for one as for nine.
     */
    canUnstick: () => board.items.some(i => selection.has(i.id) && isRider(i)),
    /**
     * The sticker colour row: is this one item a sticker, what colour is it,
     * and set it.
     *
     * Single-item, like the picture and fit rows above and for the same reason
     * - it is an edit to one thing, and the menu has nowhere to show a tick for
     * nine stickers that are three different colours.
     */
    canTintSticker: id => byId(id)?.type === 'sticker',
    stickerTintOf: id => {
      const it = byId(id);
      return it ? stickerTint(it.meta?.tint, it.meta?.shape) : 1;
    },
    setStickerTint: (id, tint) => setStickerTint(id, tint),
    /**
     * Take the selection off whatever it is stuck to and leave it where it is.
     *
     * The only way off a host that is not dropping the item on something else,
     * and deliberately without a matching "stick to this card": putting it on
     * the card is already how you say that, and a menu entry for it would be a
     * second vocabulary for a gesture that works.
     */
    unstick: () => unstickItems([...selection]),
    resetSize,
    // Album art, and nothing else. A cover is the picture a card that cannot be
    // looked at borrows so it can be recognised from across the board, and in
    // practice that card is a track: the art usually arrives inside the file
    // (import/artwork.js), and this is how one that came without any gets it.
    // Offering the same thing on a note or a link put a picture behind words
    // that were already legible, which is a card wearing a costume rather than
    // a card that has something to show.
    //
    // The model is deliberately wider than the offer - setItemCover() dresses
    // any card, and state.js says why - so a picture an older build put on
    // something else still draws. canClearCover is how it comes back off.
    canCoverItem: id => byId(id)?.type === 'audio',
    itemHasCover: id => !!byId(id)?.meta?.cover,
    // Anything already wearing one, except a video: a video's cover is the
    // poster frame the importer grabs and the optimiser repairs, not a choice
    // somebody made, and taking it away would only mean the board makes it again.
    canClearCover: id => {
      const it = byId(id);
      return !!it?.meta?.cover && it.type !== 'video';
    },
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
    // The dial's half of the pair. The panel writes settings through
    // ui/settings-schema.js, which imports setSetting straight; the flyout's
    // Spacing slider is outside that schema and goes through here.
    setSetting: (key, value) => setSetting(key, value),
  };

  return cmds;
}
