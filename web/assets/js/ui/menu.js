// Right-click menu - and, through openAnchored(), the renderer every other menu
// in the app is drawn by.
//
// The canvas already suppresses the browser's own menu (input.js), because a
// board's useful actions are all spatial - "put a note *here*", "zoom to
// *this*" - and a generic browser menu can't express any of them. The world
// point under the cursor is captured when the menu opens and handed to the
// action, so "Add a note here" means here even after the menu has closed.
//
// One menu exists at a time. It is built fresh on each open rather than kept
// hidden, so entries can be enabled, checked or omitted per context.
//
// ── The renderer, and who else uses it ──
//
// render() below is the whole of what a menu is here: an array of plain entry
// objects in, a placed panel out, with the arrow keys walking it and initMenu's
// listeners closing it on every event that would make its anchor a lie. The
// toolbar's hover flyouts (ui/flyout.js) are the same panel opened under a
// button instead of at a cursor, and they are drawn through openAnchored()
// rather than through a second implementation - which is why the entry
// vocabulary grew `swatch` and `range` rows that no right-click fold uses yet.
//
// The single `node` is right for both. A right-click and a hover flyout cannot
// be up at once: the capture-phase pointerdown that closes on an outside press
// fires before either could open the other.
//
// Every entry carries an `icon`, naming a <symbol> in assets/icons.svg - the
// same file the toolbar and the rest of the chrome draw from, so an action that
// appears in two places wears one face. All of them, deliberately: a menu with
// icons on the half of it somebody thought worth marking reads as a menu with
// pieces missing, and the eye stops using the column as a column. Where an
// action is already on the toolbar the entry names that toolbar icon and no
// second drawing exists (Add files, Add a note, Find, Rearrange, Zoom to fit).

// Reached straight rather than through cmds, which every other entry here goes
// by. Renaming *is* the name drawn on the item, so the affordance lives with
// the code that draws it, and routing it through the command surface would add
// a second name for it and nothing else. canvas/notes.js takes the same
// shortcut to the same module for the same reason.
import { canRenameItem, editItemName } from '../canvas/items.js';
import { STICKER_TINT_NAMES } from '../stickers/catalogue.js';

let node = null;
let vp = null;
let cmds = null;
// Whatever had the keyboard when the menu opened, so it can be given back.
let opener = null;
// The anchor the menu was opened at, kept so a drill-down submenu re-renders in
// the same place rather than jumping to wherever the pointer has drifted. The
// options go with it for the same reason: a fold opened inside a flyout must
// still hang below the bar and must still not grab the keyboard.
let lastX = 0, lastY = 0;
let lastOpts = {};

/**
 * Told after every close, whoever caused it.
 *
 * One hook and not a list, because there is one thing that needs to hear this:
 * the toolbar owes its button an aria-expanded, and the panel can go without
 * ui/flyout.js being the one to take it - Escape, a press on the board, a
 * right-click somewhere else. A second subscriber would mean this module
 * growing a subscription list for an audience of one.
 */
let onClose = null;
export function setMenuCloseHook(fn) { onClose = fn; }

export function initMenu(viewport, commands) {
  vp = viewport;
  cmds = commands;

  // Close on anything that would make the anchor point meaningless. Both
  // pointer and wheel let the menu's own scroller through: a menu too tall for
  // the window scrolls (see render), and closing on the wheel that scrolls it
  // would make the entries past the fold unreachable with a mouse.
  addEventListener('pointerdown', e => {
    if (node && !node.contains(e.target)) close();
  }, true);
  addEventListener('wheel', e => {
    if (node && !node.contains(e.target)) close();
  }, { passive: true, capture: true });
  // Capture, because a scroll does not bubble. The board itself does not
  // scroll today, so this is the surrounding page moving under a menu that is
  // pinned to the window - the anchor point would be a lie afterwards.
  addEventListener('scroll', e => {
    if (node && !node.contains(e.target)) close();
  }, true);
  addEventListener('resize', close);
  addEventListener('blur', close);
  addEventListener('keydown', e => {
    if (!node) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(e.key === 'ArrowDown' ? 1 : -1);
    }
  }, true);
}

export function close() {
  if (!node) return;
  // Read before the node goes: removing the element that holds focus drops the
  // keyboard on <body>, and the board's shortcuts go with it.
  const held = node.contains(document.activeElement);
  node.remove();
  node = null;
  const back = opener;
  opener = null;
  // Only when the menu actually had focus. Closing on a pointerdown elsewhere
  // means the browser is about to decide where focus goes on its own, and
  // taking it back first would fight that.
  if (held && back?.isConnected) back.focus({ preventScroll: true });
  // Last, and after the node has gone: the flyout driver writes aria-expanded
  // back onto its button from here, and it must not be able to see a panel that
  // is on its way out as one that is still up.
  onClose?.();
}

/**
 * The same panel, hung under an element instead of dropped at a cursor.
 *
 * `rect` is the anchor's getBoundingClientRect(). The toolbar's flyouts are the
 * only caller (ui/flyout.js); everything about the panel below this line is the
 * right-click menu's, which is the point.
 *
 * `focus` is false for a hover, and that is not a detail: a panel that took the
 * keyboard because a pointer drifted over a button would move the caret out of
 * whatever was being typed. The keyboard route (ArrowDown on the button) passes
 * true and gets the ordinary behaviour.
 */
export function openAnchored(rect, entries, { label = 'Menu', focus = false } = {}) {
  close();
  opener = document.activeElement;
  render(entries, rect.left, rect.bottom, { anchor: rect, label, focus, flyout: true });
}

/**
 * Open the menu for a right-click at (clientX, clientY).
 * `itemId` is the item under the cursor, or null for bare canvas.
 *
 * `mobile` is the Feed asking rather than the canvas, and it changes two things.
 * The item menu drops its spatial rows (see itemEntries), and a press on
 * anything that is not a tile opens nothing at all - the canvas menu below is
 * half zoom and half board-wide placement, and the Feed can honour neither.
 */
export function openContextMenu(clientX, clientY, itemId, selectionSize, { mobile = false } = {}) {
  if (mobile) {
    if (!itemId) return;
    close();
    opener = document.activeElement;
    // No `at`: the only row that reads it is "Add a note here", and that is one
    // of the rows the Feed drops. The wall has no *here* to add anything at.
    render(itemEntries(itemId, 1, null, true), clientX, clientY);
    return;
  }
  // After the close, not before it: a second right-click while a menu is up
  // has the old menu holding focus, and close() has just handed it back to
  // whatever owned it first. That is the element this menu owes it to as well.
  close();
  opener = document.activeElement;
  const at = vp.toWorld(clientX, clientY);
  // A right-click that lands on a connection line, on bare board, is about that
  // line: open its editor directly rather than a fold down the board menu. Only
  // when nothing else is under the cursor - over a card the press is the card's.
  const conn = !itemId ? cmds.connectionUnder(at) : null;
  const entries = conn ? connectionEntries(conn)
    : !itemId ? canvasEntries(at)
    // The title card is a singleton with its own short menu - never the group
    // menu's copy/duplicate/cover/stack actions. Only when it is the whole
    // selection; right-clicked inside a larger group it takes the group menu,
    // where it is already excluded from copy and duplicate (see itemsIn).
    : selectionSize <= 1 && cmds.isTitleCard(itemId) ? titleEntries(itemId, at)
    : itemEntries(itemId, selectionSize, at);
  render(entries, clientX, clientY);
}

/**
 * The Desktop title card's menu. It is the board's name made movable, not a
 * copyable card: no Duplicate, no Copy, no picture or stacking. Editing its
 * style is the pen's action, offered here too; Reset position is its way home
 * (it is a movable singleton); Delete hides it, and the bin's restore button
 * brings it back.
 */
function titleEntries(_id, _at) {
  return [
    { label: 'Edit style', icon: 'i-style', action: () => cmds.editTitle() },
    { label: 'Reset position', icon: 'i-reset-position', action: () => cmds.resetTitlePosition() },
    { sep: true },
    { label: 'Zoom to it', icon: 'i-zoom-to', action: () => cmds.zoomToSelection() },
    { sep: true },
    { label: 'Delete', icon: 'i-delete', accel: 'Del', danger: true,
      action: () => cmds.deleteSelection() },
  ];
}

// ---------------------------------------------------------------------------
// Entry sets
// ---------------------------------------------------------------------------

/**
 * The menu for a card, on either board.
 *
 * `mobile` is the Feed asking, and it takes rows away rather than adding any.
 * About a third of what follows is spatial - z-order, sizes, zoom, a note placed
 * *here*, a fence - and the Feed is a wall that throws every computed position
 * away, so those rows would either do nothing visible or quietly rearrange the
 * canvas from a surface that cannot show the canvas. The rest is about what the
 * card *is*, and all of it means exactly the same thing on both boards.
 *
 * Gated as a flag on the rows rather than as a second entry list, which was the
 * alternative and the worse one: two lists of the same menu drift the first time
 * only one of them is edited, and one ui/menu.js for every menu in the app is
 * the whole arrangement here.
 */
function itemEntries(id, count, at, mobile = false) {
  const many = count > 1;
  const what = many ? `${count} items` : 'item';
  // Both are single-item edits: they act on the one thing under the cursor, and
  // there is nowhere sensible to put the caret when a whole group is selected.
  const editable = !many && cmds.canEditNote(id);
  const renamable = !many && canRenameItem(id);
  // A track can be given a picture - see canCoverItem, which is where the rule
  // and the reason for it live. Single-item, like the two above: a file dialog
  // answers with one file, and there is no sensible reading of "set the
  // picture" for a group of nine.
  const coverable = !many && cmds.canCoverItem(id);
  // Asked separately rather than read off `coverable`, so a picture an older
  // build allowed onto a note or a link is still one click from coming off. A
  // card that cannot be given one can still be wearing one.
  const covered = !many && cmds.canClearCover(id);
  // Photos and videos can fill their card (crop) or fit inside it (letterbox),
  // overriding the board-wide default for this one card. Single-item, like the
  // cover actions above and for the same reason: it is an edit to one picture.
  const fittable = !many && cmds.canSetFit(id);
  const fills = fittable && cmds.itemFit(id) === 'cover';
  const flippable = !many && cmds.canFlipUpAxis(id);
  // A model card is a photograph of a model until somebody asks for the model.
  // Single-item for the same reason as the rest: you turn one thing over.
  const turnable = !many && cmds.canRotateModel(id);
  // Z-order only has a visible meaning where this selection's sticky layer
  // crosses another layer. A note covering its own host is intentionally one
  // layer and does not make these actions useful by itself. Never on the Feed,
  // where nothing overlaps anything: the wall is packed, not stacked.
  const stackable = !mobile && cmds.selectionHasStackOverlap();
  // Anything in the selection fixed to a host. Asked of the selection rather
  // than of the item under the cursor, like the stacking pair above and unlike
  // the edit group before them: taking nine stickies off one photograph means
  // exactly what taking one off means.
  const unstickable = !mobile && cmds.canUnstick();
  // A picture can hand over its own colours as swatches. Single-item, like the
  // cover and fit actions above: it reads the one image under the cursor, and
  // "the colours of these nine" is not a thing a person means.
  const swatchable = !many && cmds.canExtractSwatches(id);
  // A sticker's colour, as a fold rather than eight rows in the main column.
  // Single-item, like the picture and fit rows: it is an edit to one shape.
  const tintable = !many && cmds.canTintSticker(id);
  // Anything with something worth seeing full size. Single-item: the viewer
  // shows one thing, which is the whole of what it is for.
  const viewable = !many && cmds.canViewItem(id);
  return [
    // First of all, because on a wall of thumbnails it is the thing you most
    // often want and the one row that was not reachable any other way. Above
    // Edit text and not below it: a note is the one type where both apply, and
    // there the editor is the nearer meaning - which is why this row carries no
    // accelerator on a note, since the double-click belongs to the other one.
    { label: 'Open', icon: 'i-expand', accel: editable ? '' : 'dbl-click',
      hidden: !viewable, action: () => cmds.openViewer(id) },
    // Only on a note: right-clicking the one item type you can actually type
    // into should offer to type into it before anything else on the card.
    { label: 'Edit text', icon: 'i-edit-text', accel: 'dbl-click', hidden: !editable,
      action: () => cmds.editNote(id) },
    { label: 'Rename', icon: 'i-rename', accel: 'F2', hidden: !renamable,
      action: () => editItemName(id) },
    { label: covered ? 'Change picture' : 'Set a picture', icon: 'i-picture',
      hidden: !coverable, action: () => cmds.setCover(id) },
    { label: 'Remove picture', icon: 'i-picture-off', hidden: !covered,
      action: () => cmds.clearCover(id) },
    // A radio pair drawn as two ticked entries: the current fit reads checked,
    // the other is the one click to switch to it. The icons are a mirrored
    // pair, arrows out and arrows in, so the column says "one or the other"
    // before the tick says which.
    { label: 'Fill the card', icon: 'i-fill', check: fills, hidden: !fittable,
      action: () => cmds.setItemFit(id, 'cover') },
    { label: 'Fit in the card', icon: 'i-fit-card', check: fittable && !fills,
      hidden: !fittable, action: () => cmds.setItemFit(id, 'contain') },
    // OBJ says nothing about which way is up and both readings are common, so
    // the format's default is a guess. This is the way out of a wrong one - and
    // it is on the item rather than in Appearance because a board can hold a
    // Z-up scan and a Y-up export at the same time.
    { label: 'Turn it upright', icon: 'i-upright', hidden: !flippable,
      action: () => cmds.flipUpAxis(id) },
    // A photo's own palette, dropped beside it as swatches. On the image's own
    // group with the picture and fit rows, because it is one more thing you do
    // to a picture rather than to the board.
    { label: 'Extract palette', icon: 'i-swatch', hidden: !swatchable,
      action: () => cmds.extractSwatches(id) },
    // Above the upright toggle would put the rare fix in front of the ordinary
    // gesture; below it, this is the last thing on the model's own group.
    { label: 'Rotate model', icon: 'i-rotate', hidden: !turnable,
      action: () => cmds.rotateModel(id) },
    // Every shape can take every tint, so this is the whole palette on every
    // sticker rather than a set that varies by shape. It is an override: the
    // shape arrived wearing the colour it wore in the pad, and the tick shows
    // which one it is on now.
    { label: 'Colour', icon: 'i-swatch', hidden: !tintable,
      sub: tintable ? stickerTintEntries(id) : undefined },
    { sep: true, hidden: !editable && !renamable && !coverable && !covered && !fittable && !flippable && !turnable && !swatchable && !tintable },
    // The other mirrored pair: one card and one arrow, turned over.
    { label: 'Bring to front', icon: 'i-front', hidden: !stackable, action: () => cmds.raise() },
    { label: 'Send to back', icon: 'i-back', hidden: !stackable, action: () => cmds.lower() },
    // Off its host and left exactly where it is. A stuck note is *pinned* - a
    // drag on it moves the card underneath it instead - so this is the only way
    // out that is not dropping it somewhere else, and the menu is the only place
    // it can be. An open padlock rather than a pin, because the entry is the act
    // of letting go and the badge on the card is already the pin.
    //
    // With the stacking pair for the reason the row below gives: it is about how
    // a card sits on the board rather than about what the card is.
    { label: many ? 'Unstick these' : 'Unstick', icon: 'i-lock-open',
      hidden: !unstickable, action: () => cmds.unstick() },
    // The way back from a corner dragged too far. With the stacking pair rather
    // than in the group above, because those are all edits to what a card *is*
    // and this is one to how it sits on the board - the same kind of thing as
    // raising it or zooming to it. Works on a group: unlike renaming or setting
    // a picture, "put these back to their own size" means one thing for nine
    // cards as clearly as for one.
    // Not on the Feed: a tile's size is the packer's, computed from the column
    // count and the item's aspect, so putting a card back to "its own size"
    // changes a number that surface never draws.
    { label: many ? `Reset ${count} sizes` : 'Reset size', icon: 'i-reset-size',
      hidden: mobile, action: () => cmds.resetSize() },
    // A region right-clicked by its name plate - which is the only part of one a
    // press can land on - arranges what is inside it. Single-item, because with a
    // group selected "these" is the group and this row is about one region's
    // contents; the row below still covers that case.
    { label: 'Rearrange fence', icon: 'i-rearrange',
      hidden: mobile || many || !cmds.isFenceItem(id),
      action: () => cmds.rearrangeFence(id) },
    // The board's arrangement, applied to these and nowhere else. Only offered
    // for a group, because one card has nothing to be arranged against - and it
    // says "these" rather than "everything" because that is the difference:
    // the selection is relaid about its own centre and the rest of the board
    // does not move. The whole-board one is on the canvas menu.
    { label: `Rearrange these ${count}`, icon: 'i-rearrange', hidden: !many,
      action: () => cmds.rearrangeSelection() },
    // Straighten or space out, one fold deeper. A group only, like Rearrange -
    // one card has no edge to line up against - and behind one row because eight
    // ways to tidy would swamp the menu the moment two cards were picked. See
    // alignDistributeEntries().
    { label: 'Align & distribute', icon: 'i-align-center', hidden: !many,
      sub: alignDistributeEntries() },
    // Beside Rearrange because it is the other answer to the same question -
    // "these belong together". Rearrange says so by moving them; a fence says so
    // by drawing a line round them and leaving them where they are. Group only,
    // for the reason above: one card has nothing to be grouped with.
    //
    // The second surface, not the only one: a rubber band offers this for itself
    // as it is let go (ui/fence-prompt.js), which is the gesture people reach for
    // and the one Fences itself uses. This is what is left for a selection built
    // by shift-clicking, where there is no band to catch the answer - so it stays
    // even though the band is now the ordinary way in.
    { label: `Fence these ${count}`, icon: 'i-fence', hidden: !many,
      action: () => cmds.fenceSelection() },
    // On both menus, and on this one deliberately: a right-click is the way
    // back to the board's own actions from wherever the pointer happens to be,
    // and having to first find empty ground to ask for a reload would be the
    // menu being precious about which surface it was opened on.
    { label: 'Reload board', icon: 'i-reload', action: () => cmds.reload() },
    { sep: true },
    { label: `Duplicate ${what}`, icon: 'i-duplicate', accel: 'Ctrl D',
      action: () => cmds.duplicate() },
    // The zoom pair and "here" are the two most spatial rows on the menu, and
    // the Feed has neither a zoom nor a here: it is a packed wall, so a note
    // placed at the point somebody pressed would be picked up by the packer and
    // put wherever the column had room. Add is on the toolbar there, which is
    // the surface that means "somewhere on this board" rather than "at this
    // spot" - and that is the only promise the Feed can keep.
    { label: 'Zoom to it', icon: 'i-zoom-to', accel: 'dbl-click',
      action: () => cmds.zoomToSelection(), hidden: mobile || many },
    { label: 'Zoom to them', icon: 'i-zoom-to',
      action: () => cmds.zoomToSelection(), hidden: mobile || !many },
    { sep: true, hidden: mobile },
    { label: 'Add a note here', icon: 'i-pen', hidden: mobile,
      action: () => cmds.addNoteAt(at) },
    { sep: true },
    { label: `Delete ${what}`, icon: 'i-delete', accel: 'Del', danger: true,
      action: () => cmds.deleteSelection() },
  ];
}

/**
 * The align/distribute fold. Six edges to line up on and two axes to space
 * along - the whole of geometry.js's alignTargets/distributeTargets, one row
 * each, in reading order: the horizontal edges, the vertical edges, then the
 * two distributions. Each closes the menu and files one undo step through the
 * command, so it reads and undoes as the single tidy-up it is.
 */
function alignDistributeEntries() {
  return [
    { label: 'Align left', icon: 'i-align-left', action: () => cmds.alignSelection('left') },
    { label: 'Align centre', icon: 'i-align-center', action: () => cmds.alignSelection('hcenter') },
    { label: 'Align right', icon: 'i-align-right', action: () => cmds.alignSelection('right') },
    { sep: true },
    { label: 'Align top', icon: 'i-align-top', action: () => cmds.alignSelection('top') },
    { label: 'Align middle', icon: 'i-align-middle', action: () => cmds.alignSelection('vcenter') },
    { label: 'Align bottom', icon: 'i-align-bottom', action: () => cmds.alignSelection('bottom') },
    { sep: true },
    { label: 'Distribute across', icon: 'i-distribute-h', action: () => cmds.distributeSelection('x') },
    { label: 'Distribute down', icon: 'i-distribute-v', action: () => cmds.distributeSelection('y') },
  ];
}

/**
 * The connection editor's fold, for a line the right-click landed on. Direction
 * and style are each a short radio of ticked rows; the label is asked for, since
 * it is the one setting that is not a choice from a list. Every row files one
 * undo step through cmds.setConnectionStyle. "One end" and "other end" rather
 * than a card's name, because the pair is unordered and neither end has a name a
 * person would recognise - the two simply point opposite ways.
 */
function connectionEntries(conn) {
  const meta = cmds.connectionStyle(conn.a, conn.b) || {};
  const dir = meta.dir || 'none';
  const style = meta.style || 'solid';
  const color = meta.color || 'line';
  const weight = meta.weight || 'normal';
  const set = patch => cmds.setConnectionStyle(conn.a, conn.b, patch);
  return [
    { label: 'No arrows', icon: 'i-connect', check: dir === 'none', action: () => set({ dir: 'none' }) },
    { label: 'Arrow one end', icon: 'i-arrow-fwd', check: dir === 'fwd', action: () => set({ dir: 'fwd' }) },
    { label: 'Arrow other end', icon: 'i-arrow-back', check: dir === 'back', action: () => set({ dir: 'back' }) },
    { label: 'Arrows both ends', icon: 'i-arrow-both', check: dir === 'both', action: () => set({ dir: 'both' }) },
    { sep: true },
    { label: 'Solid line', icon: 'i-line-solid', check: style === 'solid', action: () => set({ style: 'solid' }) },
    { label: 'Dashed line', icon: 'i-line-dashed', check: style === 'dashed', action: () => set({ style: 'dashed' }) },
    { label: 'Dotted line', icon: 'i-line-dotted', check: style === 'dotted', action: () => set({ style: 'dotted' }) },
    { sep: true },
    // Colour and weight go one fold deeper, where direction and style stay on
    // the face of the menu. Not a judgement about which matters more: arrows and
    // dashes are four and three rows, and colour and weight are five and three
    // more, which would make this the longest menu in the app for a right-click
    // on a hairline. The two that change what a line *says* are here; the two
    // that change what it looks like are one press away.
    { label: 'Colour', icon: 'i-swatch', sub: connectionColorEntries(conn, color) },
    { label: 'Weight', icon: 'i-line-solid', sub: connectionWeightEntries(conn, weight) },
    { sep: true },
    { label: meta.label ? 'Change label' : 'Add a label', icon: 'i-style',
      action: () => cmds.editConnectionLabel(conn.a, conn.b) },
    { label: 'Remove label', icon: 'i-style', hidden: !meta.label,
      action: () => cmds.clearConnectionLabel(conn.a, conn.b) },
    { sep: true },
    { label: 'Remove connection', icon: 'i-delete', danger: true,
      action: () => cmds.removeConnection(conn.a, conn.b) },
  ];
}

/**
 * The eight colours a sticker may be set to.
 *
 * The names come from the catalogue rather than being spelled out here, so the
 * words and the tokens they describe are one list - the same bargain the
 * connection palette below makes with canvas.css, one relation over. The
 * numbers are what reaches meta.tint and items.css, and nothing but the index
 * ties them together, which is exactly why the list has one home.
 */
function stickerTintEntries(id) {
  const now = cmds.stickerTintOf(id);
  return STICKER_TINT_NAMES.map((text, i) => ({
    label: text,
    icon: 'i-swatch',
    check: now === i + 1,
    action: () => cmds.setStickerTint(id, i + 1),
  }));
}

/**
 * The colours a line may be given, and the one fold in this file whose rows are
 * a palette rather than a list of behaviours.
 *
 * Names, not values - see connMeta() in board-model.js. What each name looks
 * like is one rule in canvas.css, which is what keeps a board file from being
 * able to name a colour the stylesheet did not choose. The board's own grey is
 * first because it is the default and the way back to it.
 */
function connectionColorEntries(conn, color) {
  const set = patch => cmds.setConnectionStyle(conn.a, conn.b, patch);
  return [
    ['line', 'Board grey'], ['accent', 'Accent'], ['warm', 'Warm'],
    ['leaf', 'Green'], ['danger', 'Red'],
  ].map(([name, text]) => ({
    label: text, icon: 'i-swatch', check: color === name, action: () => set({ color: name }),
  }));
}

/** How heavy a line is drawn, relative to the board's own weight. */
function connectionWeightEntries(conn, weight) {
  const set = patch => cmds.setConnectionStyle(conn.a, conn.b, patch);
  return [['fine', 'Fine'], ['normal', 'Normal'], ['bold', 'Bold']].map(([name, text]) => ({
    label: text, icon: 'i-line-solid', check: weight === name, action: () => set({ weight: name }),
  }));
}

function canvasEntries(at) {
  // A press inside a region falls through to the board - the fence's face takes
  // no pointer, which is what keeps panning and banding working inside one - so
  // this menu is what a right-click *in* a region opens, and the board is not
  // what it is about. "Rearrange everything" would be the loudest possible
  // reading of a click aimed at one shelf. It swaps for that shelf instead, and
  // only swaps: there is one row either way, because the two are the same
  // question asked of different scopes.
  const fence = cmds.fenceUnder(at);
  return [
    { label: 'Add a note here', icon: 'i-pen', action: () => cmds.addNoteAt(at) },
    { label: 'Add files', icon: 'i-plus', action: () => cmds.addFiles() },
    { sep: true },
    { label: 'Find', icon: 'i-find', accel: 'Ctrl K', action: () => cmds.find() },
    { label: 'Select all', icon: 'i-select-all', accel: 'Ctrl A',
      action: () => cmds.selectAll() },
    fence
      ? { label: 'Rearrange fence', icon: 'i-rearrange',
        action: () => cmds.rearrangeFence(fence) }
      : { label: 'Rearrange everything', icon: 'i-rearrange',
        action: () => cmds.rearrange() },
    { label: 'Reload board', icon: 'i-reload', action: () => cmds.reload() },
    { sep: true },
    { label: 'Zoom to fit', icon: 'i-fit', accel: 'F', action: () => cmds.fit() },
    { label: 'Back to 0,0', icon: 'i-home', accel: '0', action: () => cmds.recenter() },
    { sep: true },
    // The board's own two marks: the lattice, and the lattice with a card
    // locked onto it. The tick that says which way they are set is a separate
    // mark on the other edge of the row - see render().
    { label: 'Snap to grid', icon: 'i-snap', check: cmds.getSetting('snap'),
      action: () => cmds.toggleSetting('snap') },
    { label: 'Show grid', icon: 'i-grid', check: cmds.getSetting('grid'),
      action: () => cmds.toggleSetting('grid') },
  ];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Replace the open menu's contents in place, keeping the same anchor and the
 * same owed-keyboard. The drill-down's one primitive: `render` builds a fresh
 * node, so the old one is dropped first - but without close()'s focus hand-back,
 * because the menu is not closing, it is turning a page.
 */
function swap(entries) {
  // A page turn keeps whatever the outgoing page had. It matters for the one
  // caller that opens without the keyboard: a flyout drilled into by hand
  // should not suddenly start swallowing arrow keys, and one drilled into from
  // the keyboard must not drop them.
  const held = !!node && node.contains(document.activeElement);
  if (node) { node.remove(); node = null; }
  render(entries, lastX, lastY, { ...lastOpts, focus: lastOpts.focus || held });
}

/** A child menu, fronted by the row that walks back to its parent. */
function subMenu(sub, parent) {
  return [{ label: 'Back', icon: 'i-chevron-left', to: parent }, { sep: true }, ...sub];
}

function render(entries, clientX, clientY, opts = {}) {
  lastX = clientX;
  lastY = clientY;
  lastOpts = opts;
  node = document.createElement('div');
  node.id = 'ctx-menu';
  node.setAttribute('role', 'menu');
  node.setAttribute('aria-label', opts.label || 'Board actions');
  // A hover flyout is the same panel wearing a different corner: it hangs off
  // the bar rather than floating free, so the top of it is square. One class,
  // because everything else about it is the menu's.
  if (opts.flyout) node.classList.add('is-flyout');
  // Focusable but not tabbable: the menu takes the keyboard when it opens, so
  // a screen reader announces it and Escape and the arrows have somewhere to
  // land. The entries themselves are what Tab and the arrows then walk.
  node.tabIndex = -1;

  for (const entry of entries) {
    if (entry.hidden) continue;
    if (entry.sep) {
      const hr = document.createElement('div');
      hr.className = 'ctx-sep';
      node.append(hr);
      continue;
    }
    // A dial rather than an action, and the one row here that is not a button.
    // It has to stay put while it is being dragged - a slider that closed the
    // menu on its first pointerdown would be unusable - so it is not in the
    // arrow-key walk and it does not close anything. Live: the value is written
    // on every input event, because a spacing you cannot see change is a
    // spacing you set by guessing.
    if (entry.range) {
      node.append(rangeRow(entry));
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.className = 'ctx-item';
    if (entry.danger) btn.classList.add('is-danger');
    if (entry.check != null) {
      btn.classList.add('is-toggle');
      btn.classList.toggle('is-checked', !!entry.check);
      btn.setAttribute('role', 'menuitemcheckbox');
      btn.setAttribute('aria-checked', String(!!entry.check));
    }

    // The icon first, and always - the row is a grid of three columns and this
    // is the first of them, so an entry that somehow had none would still line
    // its label up with the others rather than sliding under their icons.
    //
    // A `swatch` takes that column instead, for the rows whose subject *is* a
    // colour. The sticker tints get away with a grey i-swatch on all eight
    // because each one is named - Red, Amber, Terracotta - and the word does the
    // work. Four sheets of note paper have no such names, and "Yellow" beside a
    // grey icon is a menu asking you to take its word for it.
    if (entry.swatch) btn.append(chip(entry.swatch));
    else if (entry.icon) btn.append(icon(entry.icon));

    const label = document.createElement('span');
    label.textContent = entry.label;
    btn.append(label);

    if (entry.accel) {
      const accel = document.createElement('kbd');
      accel.textContent = entry.accel;
      btn.append(accel);
    }
    // The tick, on the trailing edge rather than in front of the label.
    //
    // It used to be a ::before on the label, holding a 15px column open so a
    // toggle's words did not jump sideways when it flipped on. That column is
    // the icon's now, and the two cannot share it: an icon that vanished when
    // its setting came on would be the noisiest thing in the menu. So the mark
    // moved to where the accel keys sit - which is free on both toggles, since
    // neither Snap to grid nor Show grid has a shortcut - and it is drawn from
    // the same sprite as everything else, rather than being the one glyph in
    // the row set in a typeface.
    if (entry.check != null) btn.append(icon('i-check', 'ctx-tick'));
    // Three kinds of row. A `sub` opens a child menu in place; a `to` is the
    // Back row that returns to a parent menu; everything else runs its action
    // and closes. The two navigators re-render rather than fly a second panel
    // out - the flat renderer, the keyboard walk and the placement all already
    // work, and a drill-down reuses every bit of it.
    if (entry.sub || entry.to) {
      btn.setAttribute('aria-haspopup', 'menu');
      if (entry.sub) btn.append(icon('i-chevron-right', 'ctx-chevron'));
      btn.addEventListener('click', () => swap(entry.sub ? subMenu(entry.sub, entries) : entry.to));
    } else {
      btn.addEventListener('click', () => {
        close();
        entry.action();
      });
    }
    node.append(btn);
  }

  // Measure off-screen, then place - the menu's size depends on its entries.
  // The height read here is already capped by the max-height in overlays.css,
  // so a menu with more entries than the window is tall scrolls rather than
  // running off the bottom: the flip below can only work with a box that fits.
  node.style.visibility = 'hidden';
  document.body.append(node);
  const { width, height } = node.getBoundingClientRect();
  const pad = 8;
  let x, y;
  if (opts.anchor) {
    // Hung off a button, so the horizontal rule the cursor case uses is wrong:
    // it *clamps* rather than flips, because a flyout that jumped to the far
    // side of its button would leave the pointer outside itself and close again
    // on the way in.
    x = Math.min(Math.max(pad, clientX), Math.max(pad, innerWidth - width - pad));
    // Vertically it hangs below and flips above when below will not fit.
    //
    // It used to hang below unconditionally, on the argument that the toolbar is
    // pinned to the top of the window so below is the only side there is. That
    // was true while the desktop bar's three hover flyouts were the only
    // callers. The phone's More button is on a bar pinned to the *bottom*, and
    // a menu hung under it went off the screen - the third row was simply not
    // there. The panel is adjacent to its button either way, so the pointer-path
    // argument above is untouched by this.
    //
    // The anchor's own box, not clientY, is what it flips about: above means
    // above the *button*, and hanging a panel over the thing it belongs to is
    // how you lose track of which one it belongs to.
    const above = opts.anchor.top - height - pad;
    y = (clientY + height + pad > innerHeight && above >= pad) ? above : clientY;
  } else {
    // Flip rather than clamp when there isn't room: a menu pinned to the edge
    // ends up under the cursor, and the first entry gets clicked by accident.
    x = clientX + width + pad > innerWidth ? Math.max(pad, clientX - width) : clientX;
    y = clientY + height + pad > innerHeight ? Math.max(pad, clientY - height) : clientY;
  }
  node.style.left = Math.round(x) + 'px';
  node.style.top = Math.round(y) + 'px';
  node.style.visibility = '';
  // A hover must not take the keyboard - see openAnchored. Everything else
  // does, and the default is the context menu's because that is the caller
  // that has always been here.
  if (opts.focus !== false) node.focus({ preventScroll: true });
}

/**
 * A slider row. `entry.range` is `{min, max, step, unit, get, set}`.
 *
 * A <label> and not a menuitem: it is a dial, and announcing it as one of a
 * menu's actions would be a lie to a screen reader and would put it in the
 * arrow-key walk, where Left and Right belong to the slider itself.
 */
function rangeRow(entry) {
  const { min, max, step, unit = '', get, set } = entry.range;
  const row = document.createElement('label');
  row.className = 'ctx-range';

  const name = document.createElement('span');
  name.textContent = entry.label;
  row.append(name);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(get());
  row.append(slider);

  const read = document.createElement('output');
  read.textContent = slider.value + unit;
  row.append(read);

  slider.addEventListener('input', () => {
    read.textContent = slider.value + unit;
    set(Number(slider.value));
  });
  return row;
}

/**
 * A colour, drawn as a colour, in the column the icons use.
 *
 * A <span> with a background rather than a filled i-swatch, because the sprite
 * symbol is a drawing of a paint chip and the drawing is not the point - the
 * colour is. Sized to the icons beside it so the column stays a column.
 */
function chip(color) {
  const dot = document.createElement('span');
  dot.className = 'ctx-chip';
  dot.style.background = color;
  return dot;
}

/**
 * One icon from assets/icons.svg, as the same wrapper index.html uses.
 *
 * Exported for ui/fence-prompt.js, which borrows this menu's row and now
 * borrows its icons too - the offer under the band and the `Fence these 5`
 * entry are one action met in two places, and this is what keeps them one
 * drawing rather than two that have to be remembered together.
 *
 * createElementNS and not innerHTML: SVG elements are not HTML elements, and an
 * <svg> written into innerHTML on an HTML parent is parsed into the HTML
 * namespace, where it is markup that looks right and draws nothing.
 *
 * The path is relative to the document, which is safe here in a way it would
 * not be in an app that routes: nothing in this codebase calls pushState, and a
 * fragment cannot move the base a relative URL is resolved against.
 */
export function icon(name, extra) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', extra ? `ico ${extra}` : 'ico');
  // The label beside it already says what it is. An icon that announced itself
  // as well would have a screen reader read every entry twice.
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `assets/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

function moveFocus(step) {
  const items = [...node.querySelectorAll('.ctx-item')];
  if (!items.length) return;
  const at = items.indexOf(document.activeElement);
  const next = at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
  items[next].focus();
}
