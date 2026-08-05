// Right-click menu.
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

let node = null;
let vp = null;
let cmds = null;
// Whatever had the keyboard when the menu opened, so it can be given back.
let opener = null;

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
}

/**
 * Open the menu for a right-click at (clientX, clientY).
 * `itemId` is the item under the cursor, or null for bare canvas.
 */
export function openContextMenu(clientX, clientY, itemId, selectionSize) {
  // After the close, not before it: a second right-click while a menu is up
  // has the old menu holding focus, and close() has just handed it back to
  // whatever owned it first. That is the element this menu owes it to as well.
  close();
  opener = document.activeElement;
  const at = vp.toWorld(clientX, clientY);
  const entries = !itemId ? canvasEntries(at)
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

function itemEntries(id, count, at) {
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
  // layer and does not make these actions useful by itself.
  const stackable = cmds.selectionHasStackOverlap();
  return [
    // First, and only on a note: right-clicking the one item type you can
    // actually type into should offer to type into it before anything else.
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
    // Above the upright toggle would put the rare fix in front of the ordinary
    // gesture; below it, this is the last thing on the model's own group.
    { label: 'Rotate model', icon: 'i-rotate', hidden: !turnable,
      action: () => cmds.rotateModel(id) },
    { sep: true, hidden: !editable && !renamable && !coverable && !covered && !fittable && !flippable && !turnable },
    // The other mirrored pair: one card and one arrow, turned over.
    { label: 'Bring to front', icon: 'i-front', hidden: !stackable, action: () => cmds.raise() },
    { label: 'Send to back', icon: 'i-back', hidden: !stackable, action: () => cmds.lower() },
    // The way back from a corner dragged too far. With the stacking pair rather
    // than in the group above, because those are all edits to what a card *is*
    // and this is one to how it sits on the board - the same kind of thing as
    // raising it or zooming to it. Works on a group: unlike renaming or setting
    // a picture, "put these back to their own size" means one thing for nine
    // cards as clearly as for one.
    { label: many ? `Reset ${count} sizes` : 'Reset size', icon: 'i-reset-size',
      action: () => cmds.resetSize() },
    // A region right-clicked by its name plate - which is the only part of one a
    // press can land on - arranges what is inside it. Single-item, because with a
    // group selected "these" is the group and this row is about one region's
    // contents; the row below still covers that case.
    { label: 'Rearrange fence', icon: 'i-rearrange', hidden: many || !cmds.isFenceItem(id),
      action: () => cmds.rearrangeFence(id) },
    // The board's arrangement, applied to these and nowhere else. Only offered
    // for a group, because one card has nothing to be arranged against - and it
    // says "these" rather than "everything" because that is the difference:
    // the selection is relaid about its own centre and the rest of the board
    // does not move. The whole-board one is on the canvas menu.
    { label: `Rearrange these ${count}`, icon: 'i-rearrange', hidden: !many,
      action: () => cmds.rearrangeSelection() },
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
    { label: 'Zoom to it', icon: 'i-zoom-to', accel: 'dbl-click',
      action: () => cmds.zoomToSelection(), hidden: many },
    { label: 'Zoom to them', icon: 'i-zoom-to',
      action: () => cmds.zoomToSelection(), hidden: !many },
    { sep: true },
    { label: 'Add a note here', icon: 'i-pen', action: () => cmds.addNoteAt(at) },
    { sep: true },
    { label: `Delete ${what}`, icon: 'i-delete', accel: 'Del', danger: true,
      action: () => cmds.deleteSelection() },
  ];
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

function render(entries, clientX, clientY) {
  node = document.createElement('div');
  node.id = 'ctx-menu';
  node.setAttribute('role', 'menu');
  node.setAttribute('aria-label', 'Board actions');
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
    if (entry.icon) btn.append(icon(entry.icon));

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
    btn.addEventListener('click', () => {
      close();
      entry.action();
    });
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
  // Flip rather than clamp when there isn't room: a menu pinned to the edge
  // ends up under the cursor, and the first entry gets clicked by accident.
  const x = clientX + width + pad > innerWidth ? Math.max(pad, clientX - width) : clientX;
  const y = clientY + height + pad > innerHeight ? Math.max(pad, clientY - height) : clientY;
  node.style.left = Math.round(x) + 'px';
  node.style.top = Math.round(y) + 'px';
  node.style.visibility = '';
  node.focus({ preventScroll: true });
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
