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
} from '../state.ts';
import { assetURL } from '../storage/assets.ts';
import { extOf, baseName, formatBytes, el } from '../util.ts';
import { noteWords } from '../canvas/note-model.ts';
import { toast } from '../notify.ts';
import {
  STICKER_SPRITE, STICKER_VIEWBOX, DEFAULT_SHAPE, stickerShape, stickerTint,
} from '../stickers/catalogue.ts';
import type { Viewport } from '../canvas/viewport.ts';
import type { Item, TrashEntry } from '../board-model.ts';

// The panel's nodes, taken once in initTrash(). Everything below reads them
// with `!`: they are static markup in index.html, initTrash() returns early
// when the two that matter are missing, and nothing else here runs before it.
let vp: Viewport | null = null;
let panel: HTMLElement | null = null;
let button: HTMLElement | null = null;
let list: HTMLElement | null = null;
let none: HTMLElement | null = null;
let hint: HTMLElement | null = null;
// A <button> in index.html, which is what makes `disabled` mean anything.
let emptyBtn: HTMLButtonElement | null = null;
let titleRestore: HTMLElement | null = null;
let ghost: HTMLElement | null = null;

export function initTrash(viewport: Viewport) {
  vp = viewport;
  panel = el('bin-panel');
  button = el('bin-btn');
  list = el('bin-list');
  none = el('bin-none');
  hint = el('bin-hint');
  // SAFETY: #bin-empty is a <button> in index.html; the null is kept and every
  // read of `emptyBtn` in this file goes through `?.`, so a page without the
  // bin leaves it inert rather than throwing at init.
  emptyBtn = el('bin-empty') as HTMLButtonElement | null;
  titleRestore = el('title-restore');
  // All five that this module then dereferences with `!`, not the two.
  //
  // The comment above says the file "returns early when the two that matter are
  // missing" and that everything below reads its nodes with `!` on that
  // strength - but four more were taken and asserted: a missing #bin-list or
  // #bin-empty threw here at boot, which takes the whole app down rather than
  // the bin. Either the guard covers what the assertions claim or the
  // assertions are wishes; this is the smaller of the two repairs.
  //
  // #title-restore stays optional and keeps its `?.`, which is not a third
  // policy: it is genuinely conditional markup, present only while a board can
  // have lost its title card.
  if (!panel || !button || !list || !none || !hint || !emptyBtn) return;

  button.addEventListener('click', () => {
    if (selection.size) {
      setOpen(false);
      removeItems([...selection]);
      return;
    }
    setOpen(panel!.hidden);
  });
  emptyBtn!.addEventListener('click', emptyTrash);
  // Bring the deleted title card back. restoreTitleCard() emits 'trash', so the
  // paint below hides this button again on its own.
  titleRestore?.addEventListener('click', () => restoreTitleCard());
  list!.addEventListener('pointerdown', startDrag);
  list!.addEventListener('keydown', restoreByKey);

  // Clicking the board puts the panel away. Not a scrim and not focus-based:
  // the board stays fully live while the bin is open, and dismissing has to
  // cost exactly one click wherever that click lands.
  document.getElementById('viewport')!.addEventListener('pointerdown', () => setOpen(false));

  bus.on('trash', paint);
  bus.on('board:load', paint);
  bus.on('selection', paintButton);
  // A full bin drops its oldest to make room (state.js TRASH_LIMIT); say so, since
  // those entries are past getting back by any other means.
  bus.on('trash:evicted', n => toast(
    n === 1 ? 'Bin full — dropped the oldest item' : `Bin full — dropped the ${n} oldest items`));
  // And the other end of the same idea: emptying the bin now deletes the files
  // rather than only the entries, so it is worth saying what went and how much
  // came back. The count is of *files* - notes, swatches and stickers empty out
  // of the bin as they always did, since there were never any bytes to delete.
  // See emptyTrash() in trash.ts, which decides both numbers.
  bus.on('trash:purged', ({ items, bytes }) => toast(
    `Deleted ${items} ${items === 1 ? 'file' : 'files'} for good${bytes ? ` — ${formatBytes(bytes)} freed` : ''}`));
  paint();
}

function setOpen(want: boolean) {
  panel!.hidden = !want;
  button!.setAttribute('aria-expanded', String(!!want));
  paintTitleRestore();
}

/**
 * The title card's restore button rides the bin panel: it is offered only while
 * the bin is open (that is what "opening the trash" reveals it) and only while
 * the card is actually gone.
 */
function paintTitleRestore() {
  if (!titleRestore) return;
  titleRestore.hidden = panel!.hidden || !isTitleHidden();
}

function paint() {
  const entries = board.trash;
  button!.classList.toggle('has-things', entries.length > 0);
  paintButton();
  emptyBtn!.disabled = !entries.length;
  none!.hidden = entries.length > 0;
  hint!.hidden = entries.length === 0;

  list!.replaceChildren();
  for (const entry of entries) list!.append(binRow(entry));
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
  button!.setAttribute('aria-label', name);
  button!.title = name;
}

function binRow(entry: TrashEntry) {
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
  const url = item.asset?.hash ? assetURL(item.asset.hash) : null;
  if (item.type === 'image' && url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.draggable = false;
    thumb.append(img);
  } else if (item.type === 'note') {
    // The note's own first line, so a wall of notes is still tellable apart.
    thumb.classList.add('is-note');
    thumb.textContent = noteText(item).split('\n')[0].slice(0, 12) || 'note';
  } else if (item.type === 'sticker') {
    // The shape itself, which is the only thing that tells one binned sticker
    // from another - the name is "Star" and so is the next one's. Its own tint,
    // too: a red heart and a gold one are the same shape and not the same
    // sticker. items.css owns both, off the same data-tint the board uses.
    // `meta` is open, so the shape it carries is narrowed here rather than
    // trusted - stickerShape() answers null for anything not in the catalogue,
    // including a value that is not a string at all.
    const shape = stickerShape(item.meta?.shape)?.id ?? DEFAULT_SHAPE;
    thumb.classList.add('is-sticker');
    // Built rather than written. The markup this replaced interpolated two
    // values out of an item's open `meta` into an attribute inside a string
    // handed to innerHTML - and `meta` is whatever a .mbrd said it was. Both
    // are narrowed a line above, so nothing was actually getting through, but
    // "safe because of a guard three lines up" is the arrangement the rule in
    // CLAUDE.md exists to refuse: a tree built with createElementNS has no
    // escaping to get right and cannot be got wrong by a later edit to
    // stickerTint(). The same five lines canvas/renderers.ts's sticker() uses,
    // which is the fifth place that builds one of these.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'sticker-art');
    svg.setAttribute('viewBox', STICKER_VIEWBOX);
    svg.setAttribute('aria-hidden', 'true');
    svg.dataset.tint = String(stickerTint(item.meta?.tint, shape));
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `${STICKER_SPRITE}#${shape}`);
    svg.append(use);
    thumb.append(svg);
  } else if (item.type === 'gone') {
    // A tombstone, which is in the bin only while an undo of the emptying keeps
    // it there. There is nothing to preview and no extension worth printing -
    // the file it names was destroyed, and badging the square "JPG" would be the
    // panel offering back something that cannot come back. See RENDERERS.gone.
    thumb.classList.add('is-gone');
    thumb.textContent = 'gone';
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

/**
 * A note's words - canvas/note-model.ts's reading, not this file's.
 *
 * It was `meta.text` raw, which carries the `# ` and `## ` that let a note
 * round-trip as plaintext, so a note with a heading sat in the bin as
 * "# Kitchen". The marker is storage, not something the person who typed the
 * heading should be shown.
 */
function noteText(item: Item): string {
  return noteWords(item.meta);
}

function label(item: Item): string {
  // Before the filename branch, for the same reason: baseName() would cut
  // "example.com" back to "example".
  if (item.type === 'link') {
    // `meta` is open, so the url is whatever the file carried. The String() is
    // the coercion textContent would have done to it a line later anyway; the
    // truthiness chain is the one this line always had.
    const url = item.meta?.url;
    return item.name || (url ? String(url) : '') || 'link';
  }
  if (item.name) return baseName(item.name) || item.name;
  if (item.type === 'note') return noteText(item).split('\n')[0] || 'Empty note';
  return item.type;
}

/** Coarse and relative - the exact minute a thing was binned is never the question. */
function ago(at: number) {
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
function restoreByKey(e: KeyboardEvent) {
  if (e.key !== 'Enter' && e.key !== ' ' && e.code !== 'Space') return;
  // SAFETY: the listener is on #bin-list, so the target of a key inside it is
  // an element - the optional call is the guard it always was for anything else.
  const line = (e.target as Element).closest?.<HTMLElement>('.bin-item');
  if (!line) return;
  e.preventDefault();
  // Every .bin-item is built by binRow() below, which writes the id onto it.
  const back = restoreItems([line.dataset.id!], vp!.toWorld(innerWidth / 2, innerHeight / 2));
  if (!back.length) return;
  select(back.map((i: Item) => i.id));
  setOpen(board.trash.length > 0);
}

function startDrag(e: PointerEvent) {
  if (e.button !== 0) return;
  // SAFETY: as in the key handler above - this listener is on #bin-list, so a
  // press delivered to it landed on an element inside it.
  const line = (e.target as Element).closest<HTMLElement>('.bin-item');
  if (!line) return;
  // As above: binRow() writes the id onto every row it makes.
  const id = line.dataset.id!;
  const entry = board.trash.find(t => t.item.id === id);
  if (!entry) return;

  e.preventDefault();
  line.setPointerCapture?.(e.pointerId);
  line.classList.add('is-lifting');
  ghost = makeGhost(entry.item);
  moveGhost(e.clientX, e.clientY);

  const onMove = (ev: PointerEvent) => moveGhost(ev.clientX, ev.clientY);

  // Taken off the window, because that is where they are put - see the note at
  // the foot of this function.
  const unwire = () => {
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('pointercancel', onCancel);
    line.classList.remove('is-lifting');
  };

  const onUp = (ev: PointerEvent) => {
    unwire();
    dropGhost();

    // Let go over the panel itself and nothing happens - that is a cancel, and
    // the item stays in the bin rather than being flung somewhere arbitrary.
    if (panel!.contains(document.elementFromPoint(ev.clientX, ev.clientY))) return;

    const at = vp!.toWorld(ev.clientX, ev.clientY);
    const back = restoreItems([id], at);
    if (!back.length) return;
    select(back.map((i: Item) => i.id));
    setOpen(board.trash.length > 0);
  };

  const onCancel = () => {
    unwire();
    dropGhost();
  };

  // On the window, not on the row.
  //
  // paint() calls list.replaceChildren() on every 'trash' and 'board:load'
  // emit, and this drag ends by restoring an item - which emits both. A row
  // detached mid-gesture took its three listeners with it: onUp never fired,
  // #bin-ghost was left following the pointer with nothing to dismiss it, and
  // the row it came from no longer existed. The same reasoning the pointer
  // pipeline gives for capture, applied to a list that rebuilds itself.
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  addEventListener('pointercancel', onCancel);
}

function makeGhost(item: Item) {
  const node = document.createElement('div');
  node.id = 'bin-ghost';
  const url = item.asset?.hash ? assetURL(item.asset.hash) : null;
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

function moveGhost(x: number, y: number) {
  if (!ghost) return;
  ghost.style.left = x + 'px';
  ghost.style.top = y + 'px';
}

function dropGhost() {
  ghost?.remove();
  ghost = null;
}
