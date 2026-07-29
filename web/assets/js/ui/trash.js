// The bin: what you deleted, and the way back.
//
// Deleting on this board used to be recoverable only through undo, which is a
// stack - it can only give you back the *last* thing, and only if you have not
// done anything since. A bin is the other model: everything you threw away,
// kept, in no particular relation to what you did afterwards, taken back one
// at a time whenever you notice you want it.
//
// Coming back is a drag rather than a Restore button on purpose. A deleted item
// remembers where it used to be, but that spot is usually the reason it was
// deleted - the board has moved on and grown into the gap. Dragging says where
// it goes now, in one gesture, and lands it there.
//
// The drag is plain pointer events, not HTML5 drag-and-drop: the board already
// owns the native drop channel for files, and a synthetic one would have to
// serialise an item through a DataTransfer just to hand it back to the same
// page it started on.

import {
  board, bus, selection, removeItems, restoreItems, emptyTrash, select,
  restoreTitleCard, isTitleHidden,
} from '../state.js';
import { assetURL } from '../storage/assets.js';
import { extOf, baseName, el } from '../util.js';

let vp = null;
let panel, button, list, none, hint, emptyBtn, titleRestore;
let ghost = null;

export function initTrash(viewport) {
  vp = viewport;
  panel = el('bin-panel');
  button = el('bin-btn');
  list = el('bin-list');
  none = el('bin-none');
  hint = el('bin-hint');
  emptyBtn = el('bin-empty');
  titleRestore = el('title-restore');
  if (!panel || !button) return;

  button.addEventListener('click', () => {
    if (selection.size) {
      setOpen(false);
      removeItems([...selection]);
      return;
    }
    setOpen(panel.hidden);
  });
  emptyBtn.addEventListener('click', emptyTrash);
  // Bring the deleted title card back. restoreTitleCard() emits 'trash', so the
  // paint below hides this button again on its own.
  titleRestore?.addEventListener('click', () => restoreTitleCard());
  list.addEventListener('pointerdown', startDrag);
  list.addEventListener('keydown', restoreByKey);

  // Clicking the board puts the panel away. Not a scrim and not focus-based:
  // the board stays fully live while the bin is open, and dismissing has to
  // cost exactly one click wherever that click lands.
  document.getElementById('viewport').addEventListener('pointerdown', () => setOpen(false));

  bus.on('trash', paint);
  bus.on('board:load', paint);
  bus.on('selection', paintButton);
  paint();
}

function setOpen(want) {
  panel.hidden = !want;
  button.setAttribute('aria-expanded', String(!!want));
  paintTitleRestore();
}

/**
 * The title card's restore button rides the bin panel: it is offered only while
 * the bin is open (that is what "opening the trash" reveals it) and only while
 * the card is actually gone.
 */
function paintTitleRestore() {
  if (!titleRestore) return;
  titleRestore.hidden = panel.hidden || !isTitleHidden();
}

function paint() {
  const entries = board.trash;
  button.classList.toggle('has-things', entries.length > 0);
  paintButton();
  emptyBtn.disabled = !entries.length;
  none.hidden = entries.length > 0;
  hint.hidden = entries.length === 0;

  list.replaceChildren();
  for (const entry of entries) list.append(binRow(entry));
  paintTitleRestore();
}

function paintButton() {
  const entries = board.trash;
  // The button carries its state as colour alone, which a screen reader cannot
  // see, so the name has to carry the same fact in words - and it may as well
  // carry the exact number while it is there, since that is the one thing the
  // muted-or-not look genuinely cannot say.
  const name = selection.size
    ? `Delete ${selection.size} selected ${selection.size === 1 ? 'item' : 'items'}`
    : entries.length
    ? `Trash, ${entries.length} ${entries.length === 1 ? 'item' : 'items'}`
    : 'Trash, empty';
  button.setAttribute('aria-label', name);
  button.title = name;
}

function binRow(entry) {
  const item = entry.item;
  const node = document.createElement('div');
  node.className = 'bin-item';
  node.dataset.id = item.id;
  node.title = 'Drag onto the board to put it back, or press Enter';
  // Reachable and operable without a pointer. Deleting was already a keystroke;
  // until this, taking something back was a drag and nothing else, so a
  // keyboard or screen-reader user could empty the bin and never look inside it.
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.setAttribute('aria-label', `Restore ${label(item)}`);

  const thumb = document.createElement('div');
  thumb.className = 'bin-thumb';
  const url = item.asset && assetURL(item.asset.hash);
  if (item.type === 'image' && url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.draggable = false;
    thumb.append(img);
  } else if (item.type === 'note') {
    // The note's own first line, so a wall of notes is still tellable apart.
    thumb.classList.add('is-note');
    thumb.textContent = (item.meta?.text || '').split('\n')[0].slice(0, 12) || 'note';
  } else if (item.type === 'link') {
    // A link's name is a hostname, not a filename, and extOf() reads the last
    // dot in it - so "example.com" came out as a card badged "com" filed under
    // "example". Neither half of the filename convention applies here.
    thumb.textContent = 'link';
  } else {
    thumb.textContent = extOf(item.name) || item.type;
  }

  const name = document.createElement('div');
  name.className = 'bin-name';
  name.textContent = label(item);

  const when = document.createElement('div');
  when.className = 'bin-when';
  when.textContent = ago(entry.at);

  node.append(thumb, name, when);
  return node;
}

function label(item) {
  // Before the filename branch, for the same reason: baseName() would cut
  // "example.com" back to "example".
  if (item.type === 'link') return item.name || item.meta?.url || 'link';
  if (item.name) return baseName(item.name) || item.name;
  if (item.type === 'note') return (item.meta?.text || '').split('\n')[0] || 'Empty note';
  return item.type;
}

/** Coarse and relative - the exact minute a thing was binned is never the question. */
function ago(at) {
  if (!at) return '';
  const secs = Math.max(0, (Date.now() - at) / 1000);
  if (secs < 60) return 'now';
  if (secs < 3600) return Math.floor(secs / 60) + 'm';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h';
  return Math.floor(secs / 86400) + 'd';
}

// ---------------------------------------------------------------------------
// Dragging one back out
// ---------------------------------------------------------------------------

/**
 * Enter or Space on a bin row puts that item back.
 *
 * It lands in the middle of the view rather than where it was deleted from,
 * which is the same judgement the drag makes: the old spot is usually the
 * reason it was thrown away, and the board has grown into the gap since. The
 * middle of what you are looking at is the keyboard's answer to "say where".
 */
function restoreByKey(e) {
  if (e.key !== 'Enter' && e.key !== ' ' && e.code !== 'Space') return;
  const line = e.target.closest?.('.bin-item');
  if (!line) return;
  e.preventDefault();
  const back = restoreItems([line.dataset.id], vp.toWorld(innerWidth / 2, innerHeight / 2));
  if (!back.length) return;
  select(back.map(i => i.id));
  setOpen(board.trash.length > 0);
}

function startDrag(e) {
  if (e.button !== 0) return;
  const line = e.target.closest('.bin-item');
  if (!line) return;
  const id = line.dataset.id;
  const entry = board.trash.find(t => t.item.id === id);
  if (!entry) return;

  e.preventDefault();
  line.setPointerCapture?.(e.pointerId);
  line.classList.add('is-lifting');
  ghost = makeGhost(entry.item);
  moveGhost(e.clientX, e.clientY);

  const onMove = ev => moveGhost(ev.clientX, ev.clientY);

  const onUp = ev => {
    line.removeEventListener('pointermove', onMove);
    line.removeEventListener('pointerup', onUp);
    line.removeEventListener('pointercancel', onCancel);
    line.classList.remove('is-lifting');
    dropGhost();

    // Let go over the panel itself and nothing happens - that is a cancel, and
    // the item stays in the bin rather than being flung somewhere arbitrary.
    if (panel.contains(document.elementFromPoint(ev.clientX, ev.clientY))) return;

    const at = vp.toWorld(ev.clientX, ev.clientY);
    const back = restoreItems([id], at);
    if (!back.length) return;
    select(back.map(i => i.id));
    setOpen(board.trash.length > 0);
  };

  const onCancel = () => {
    line.removeEventListener('pointermove', onMove);
    line.removeEventListener('pointerup', onUp);
    line.removeEventListener('pointercancel', onCancel);
    line.classList.remove('is-lifting');
    dropGhost();
  };

  line.addEventListener('pointermove', onMove);
  line.addEventListener('pointerup', onUp);
  line.addEventListener('pointercancel', onCancel);
}

function makeGhost(item) {
  const node = document.createElement('div');
  node.id = 'bin-ghost';
  const url = item.asset && assetURL(item.asset.hash);
  if (item.type === 'image' && url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    node.append(img);
  } else {
    node.style.background = 'var(--note-1)';
  }
  document.body.append(node);
  return node;
}

function moveGhost(x, y) {
  if (!ghost) return;
  ghost.style.left = x + 'px';
  ghost.style.top = y + 'px';
}

function dropGhost() {
  ghost?.remove();
  ghost = null;
}
