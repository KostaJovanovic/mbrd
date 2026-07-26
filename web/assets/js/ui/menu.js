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

// Reached straight rather than through cmds, which every other entry here goes
// by. Renaming *is* the name drawn on the item, so the affordance lives with
// the code that draws it, and routing it through the command surface would add
// a second name for it and nothing else. canvas/notes.js takes the same
// shortcut to the same module for the same reason.
import { canRenameItem, editItemName } from '../canvas/items.js';

let node = null;
let vp = null;
let cmds = null;

export function initMenu(viewport, commands) {
  vp = viewport;
  cmds = commands;

  // Close on anything that would make the anchor point meaningless.
  addEventListener('pointerdown', e => {
    if (node && !node.contains(e.target)) close();
  }, true);
  addEventListener('wheel', close, { passive: true });
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
  node?.remove();
  node = null;
}

/**
 * Open the menu for a right-click at (clientX, clientY).
 * `itemId` is the item under the cursor, or null for bare canvas.
 */
export function openContextMenu(clientX, clientY, itemId, selectionSize) {
  close();
  const at = vp.toWorld(clientX, clientY);
  const entries = itemId
    ? itemEntries(itemId, selectionSize, at)
    : canvasEntries(at);
  render(entries, clientX, clientY);
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
  // A card that is not itself a picture can be given one. Single-item, like the
  // two above: a file dialog answers with one file, and there is no sensible
  // reading of "set the picture" for a group of nine.
  const coverable = !many && cmds.canCoverItem(id);
  const covered = coverable && cmds.itemHasCover(id);
  const flippable = !many && cmds.canFlipUpAxis(id);
  // A model card is a photograph of a model until somebody asks for the model.
  // Single-item for the same reason as the rest: you turn one thing over.
  const turnable = !many && cmds.canRotateModel(id);
  return [
    // First, and only on a note: right-clicking the one item type you can
    // actually type into should offer to type into it before anything else.
    { label: 'Edit text', accel: 'dbl-click', hidden: !editable,
      action: () => cmds.editNote(id) },
    // No ellipsis: nothing opens. The name goes editable where it already sits.
    { label: 'Rename', accel: 'F2', hidden: !renamable, action: () => editItemName(id) },
    // Ellipsis: a file dialog opens.
    { label: covered ? 'Change picture…' : 'Set a picture…', hidden: !coverable,
      action: () => cmds.setCover(id) },
    { label: 'Remove picture', hidden: !covered, action: () => cmds.clearCover(id) },
    // OBJ says nothing about which way is up and both readings are common, so
    // the format's default is a guess. This is the way out of a wrong one - and
    // it is on the item rather than in Appearance because a board can hold a
    // Z-up scan and a Y-up export at the same time.
    { label: 'Turn it upright', hidden: !flippable,
      action: () => cmds.flipUpAxis(id) },
    // Above the upright toggle would put the rare fix in front of the ordinary
    // gesture; below it, this is the last thing on the model's own group.
    { label: 'Rotate model', hidden: !turnable, action: () => cmds.rotateModel(id) },
    { sep: true, hidden: !editable && !renamable && !coverable && !flippable && !turnable },
    { label: 'Bring to front', action: () => cmds.raise() },
    { label: 'Send to back', action: () => cmds.lower() },
    { sep: true },
    { label: `Duplicate ${what}`, accel: 'Ctrl D', action: () => cmds.duplicate() },
    { label: 'Zoom to it', accel: 'dbl-click', action: () => cmds.zoomToSelection(), hidden: many },
    { label: 'Zoom to them', action: () => cmds.zoomToSelection(), hidden: !many },
    { sep: true },
    { label: 'Add a note here', action: () => cmds.addNoteAt(at) },
    { sep: true },
    { label: `Delete ${what}`, accel: 'Del', danger: true, action: () => cmds.deleteSelection() },
  ];
}

function canvasEntries(at) {
  return [
    { label: 'Add a note here', action: () => cmds.addNoteAt(at) },
    { label: 'Add files…', action: () => cmds.addFiles() },
    { sep: true },
    { label: 'Find…', accel: 'Ctrl K', action: () => cmds.find() },
    { label: 'Select all', accel: 'Ctrl A', action: () => cmds.selectAll() },
    { label: 'Rearrange everything', action: () => cmds.rearrange() },
    { sep: true },
    { label: 'Zoom to fit', accel: 'F', action: () => cmds.fit() },
    { label: 'Back to 0,0', accel: '0', action: () => cmds.recenter() },
    { sep: true },
    { label: 'Snap to grid', check: cmds.getSetting('snap'), action: () => cmds.toggleSetting('snap') },
    { label: 'Show grid', check: cmds.getSetting('grid'), action: () => cmds.toggleSetting('grid') },
  ];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(entries, clientX, clientY) {
  node = document.createElement('div');
  node.id = 'ctx-menu';
  node.setAttribute('role', 'menu');

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

    const label = document.createElement('span');
    label.textContent = entry.label;
    btn.append(label);

    if (entry.accel) {
      const accel = document.createElement('kbd');
      accel.textContent = entry.accel;
      btn.append(accel);
    }
    btn.addEventListener('click', () => {
      close();
      entry.action();
    });
    node.append(btn);
  }

  // Measure off-screen, then place - the menu's size depends on its entries.
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
}

function moveFocus(step) {
  const items = [...node.querySelectorAll('.ctx-item')];
  if (!items.length) return;
  const at = items.indexOf(document.activeElement);
  const next = at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
  items[next].focus();
}
