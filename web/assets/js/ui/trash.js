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

import { board, bus, restoreItems, emptyTrash, select } from '../state.js';
import { assetURL } from '../storage/assets.js';
import { extOf, baseName } from '../util.js';

const el = id => document.getElementById(id);

let vp = null;
let panel, button, list, none, hint, emptyBtn, count;
let ghost = null;

export function initTrash(viewport) {
  vp = viewport;
  panel = el('bin-panel');
  button = el('bin-btn');
  list = el('bin-list');
  none = el('bin-none');
  hint = el('bin-hint');
  emptyBtn = el('bin-empty');
  count = el('bin-count');
  if (!panel || !button) return;

  button.addEventListener('click', () => setOpen(panel.hidden));
  emptyBtn.addEventListener('click', emptyTrash);
  list.addEventListener('pointerdown', startDrag);

  // Clicking the board puts the panel away. Not a scrim and not focus-based:
  // the board stays fully live while the bin is open, and dismissing has to
  // cost exactly one click wherever that click lands.
  document.getElementById('viewport').addEventListener('pointerdown', () => setOpen(false));

  bus.on('trash', paint);
  bus.on('board:load', paint);
  paint();
}

export const closeTrash = () => setOpen(false);

function setOpen(want) {
  panel.hidden = !want;
  button.setAttribute('aria-expanded', String(!!want));
}

function paint() {
  const entries = board.trash;
  count.textContent = entries.length;
  count.hidden = !entries.length;
  button.classList.toggle('has-things', entries.length > 0);
  emptyBtn.disabled = !entries.length;
  none.hidden = entries.length > 0;
  hint.hidden = entries.length === 0;

  list.replaceChildren();
  for (const entry of entries) list.append(binRow(entry));
}

function binRow(entry) {
  const item = entry.item;
  const node = document.createElement('div');
  node.className = 'bin-item';
  node.dataset.id = item.id;
  node.title = 'Drag onto the board to put it back';

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
