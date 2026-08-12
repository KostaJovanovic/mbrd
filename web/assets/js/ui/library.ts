// @ts-nocheck - TypeScript migration debt, not a judgement about this file.
//
// The tree was renamed from .js to .ts mechanically, which moved 104 modules in
// one step and annotated none of them. This module is carried unchecked so that
// npm run typecheck stays green and keeps meaning something, rather than going
// red and being ignored. Converting this module IS deleting this block and
// fixing what tsc then says - tests/ts-debt.test.js holds the count and lets it
// only fall.
// The board switcher: the shelf of boards this browser is keeping, drawn.
//
// The storage half is in storage/storage.js and storage/library.js; this is only
// the face of it - a grid of the saved boards, each a thumbnail and a title,
// click one to open it, with a New board that keeps the current one. It renders
// from the library index alone (title and thumbnail live there), so opening the
// switcher unpacks nothing; a board's megabytes are read only when it is opened.
//
// A self-contained overlay rather than the ask() dialog, because that one is a
// question with buttons and this is a gallery. It reaches for `document` only
// inside a function, like the rest of the interface, so it stays importable
// without a browser.

import {
  listLibrary, switchBoard, newLibraryBoard, deleteLibraryBoard,
} from '../storage/storage.ts';
import { boardThumb } from './snapshot.ts';
import { toast } from '../notify.ts';

let root = null;

/** Human "when", for a board's card. */
function ago(at) {
  if (!at) return '';
  const s = (Date.now() - at) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}

export function isLibraryOpen() { return !!root; }

export function closeLibrary() {
  if (!root) return;
  root.remove();
  root = null;
  removeEventListener('keydown', onKey, true);
}

function onKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeLibrary(); }
}

/**
 * A busy guard around the storage moves, which are slow (pack, unpack, a thumb
 * render) and must not run twice from a double press. The panel is closed on the
 * ones that change the board on screen, and re-rendered on delete.
 */
let busy = false;
async function guard(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); }
  catch (err) { console.error(err); toast('Something went wrong with that board', 'error'); }
  finally { busy = false; }
}

export async function openLibrary() {
  if (typeof document === 'undefined') return;
  closeLibrary();

  root = document.createElement('div');
  root.id = 'library';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Your boards');
  // A press on the backdrop, but not on the panel, closes it - the same harmless
  // way out every overlay here offers.
  root.addEventListener('pointerdown', e => { if (e.target === root) closeLibrary(); });

  document.body.append(root);
  addEventListener('keydown', onKey, true);
  await render();
}

async function render() {
  if (!root) return;
  const boards = await listLibrary().catch(() => []);
  if (!root) return;   // closed while we were reading
  root.replaceChildren();

  const panel = document.createElement('div');
  panel.className = 'library-panel';

  const head = document.createElement('div');
  head.className = 'library-head';
  const title = document.createElement('h2');
  title.textContent = 'Your boards';
  const spacer = document.createElement('div');
  spacer.className = 'library-spacer';
  const fresh = document.createElement('button');
  fresh.type = 'button';
  fresh.className = 'library-new';
  fresh.textContent = 'New board';
  fresh.addEventListener('click', () => guard(async () => {
    const thumb = await boardThumb().catch(() => null);
    await newLibraryBoard(thumb);
    closeLibrary();
  }));
  const shut = document.createElement('button');
  shut.type = 'button';
  shut.className = 'library-close';
  shut.setAttribute('aria-label', 'Close');
  shut.textContent = '×';
  shut.addEventListener('click', closeLibrary);
  head.append(title, spacer, fresh, shut);

  const grid = document.createElement('div');
  grid.className = 'library-grid';
  if (!boards.length) {
    const empty = document.createElement('p');
    empty.className = 'library-empty';
    empty.textContent = 'No other boards yet. New board keeps this one and starts a fresh one beside it.';
    grid.append(empty);
  }
  for (const b of boards) grid.append(card(b));

  panel.append(head, grid);
  root.append(panel);
}

function card(b) {
  const el = document.createElement('div');
  el.className = 'library-card' + (b.current ? ' is-current' : '');

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'library-open';
  open.disabled = !!b.current;

  const thumb = document.createElement('div');
  thumb.className = 'library-thumb';
  if (b.thumb) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = b.thumb;
    thumb.append(img);
  }
  const name = document.createElement('div');
  name.className = 'library-name';
  name.textContent = b.title || 'Untitled board';
  const when = document.createElement('div');
  when.className = 'library-when';
  when.textContent = b.current ? 'On screen now' : ago(b.at);
  open.append(thumb, name, when);
  open.addEventListener('click', () => guard(async () => {
    const shot = await boardThumb().catch(() => null);
    if (await switchBoard(b.id, shot)) closeLibrary();
  }));
  el.append(open);

  if (!b.current) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'library-del';
    del.setAttribute('aria-label', 'Delete this board');
    del.textContent = '×';
    del.addEventListener('click', () => guard(async () => {
      await deleteLibraryBoard(b.id);
      await render();
    }));
    el.append(del);
  }
  return el;
}
