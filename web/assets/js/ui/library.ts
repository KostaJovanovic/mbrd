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
  listLibrary, switchBoard, newBoard, deleteLibraryBoard, ensureCurrentOnShelf,
} from '../storage/storage.ts';
import { toast } from '../notify.ts';
import { ask } from './dialog.ts';
import type { LibraryEntry } from '../storage/library.ts';

/** A shelf row as the switcher sees it - the index entry, plus "is this the one on screen". */
type ShelfEntry = LibraryEntry & { current: boolean };

let root: HTMLDivElement | null = null;

/** Human "when", for a board's card. */
function ago(at: number) {
  if (!at) return '';
  const s = (Date.now() - at) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}

/** Whatever had the keyboard when the shelf opened, so it can be given back. */
let opener: HTMLElement | null = null;

function closeLibrary() {
  if (!root) return;
  const held = root.contains(document.activeElement);
  root.remove();
  root = null;
  removeEventListener('keydown', onKey, true);
  const back = opener;
  opener = null;
  // Only when the shelf actually had it: closing on a press elsewhere means the
  // browser is about to place focus itself, and taking it back would fight
  // that. The same rule ui/menu.ts's close() states.
  if (held && back?.isConnected) back.focus({ preventScroll: true });
}

function onKey(e: KeyboardEvent) {
  if (!root) return;
  if (e.key === 'Escape') { e.stopPropagation(); closeLibrary(); return; }
  // The Tab trap `aria-modal="true"` was promising and nothing was keeping.
  //
  // This panel is a div on the body, not a <dialog> - so nothing outside it is
  // inert, and a keyboard walked straight out of a thing that had announced
  // itself as modal, into a board it could not see and could still delete
  // cards on. showModal() would give the trap for nothing, and is not
  // available here: the shelf is drawn under the same overlay stack as the
  // viewer and the tour, and a top-layer dialog would sit above all of them.
  if (e.key !== 'Tab') return;
  const stops = [...root.querySelectorAll<HTMLElement>(
    'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), '
    + 'textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')];
  if (!stops.length) return;
  const first = stops[0], last = stops[stops.length - 1];
  const on = document.activeElement;
  // Wrapped by hand at both ends, and also for a focus that has already
  // escaped - which is the state the panel opens in until the line in
  // openLibrary() below places it.
  if (!root.contains(on)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
  if (!e.shiftKey && on === last) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && on === first) { e.preventDefault(); last.focus(); }
}

/**
 * A busy guard around the storage moves, which are slow (pack, unpack, a thumb
 * render) and must not run twice from a double press. The panel is closed on the
 * ones that change the board on screen, and re-rendered on delete.
 */
let busy = false;
async function guard(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  try { await fn(); }
  catch (err) { console.error(err); toast('Something went wrong with that board', 'error'); }
  finally { busy = false; }
}

export async function openLibrary() {
  if (typeof document === 'undefined') return;
  closeLibrary();
  // Read before the panel exists, so it is the button that opened the shelf and
  // not something inside it.
  opener = document.activeElement as HTMLElement | null;

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
  // Focus in, once there is something to focus. A panel that says aria-modal
  // and leaves the keyboard behind it announces itself to a screen reader and
  // then reads out the page underneath.
  root?.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
}

async function render() {
  if (!root) return;
  // The board on screen has a row before the list is drawn, even if it has never
  // been switched away from. Without this the shelf held only boards you had
  // *left*, so a browser that had never switched showed "No other boards yet"
  // while looking straight at one. See ensureCurrentOnShelf() in
  // storage/storage.ts, which is a no-op on every visit after the first.
  await ensureCurrentOnShelf().catch(() => {});
  if (!root) return;   // closed while we were writing
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
  // newBoard(), which is now the only New: the top-level one and the library's
  // collapsed into it when Open and New started filing the outgoing board on
  // the shelf. No thumbnail is passed any anywhere here any more - stashCurrent()
  // takes its own through the injection main.ts wires. See setBoardThumb().
  fresh.addEventListener('click', () => guard(async () => {
    await newBoard();
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

function card(b: ShelfEntry) {
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
    if (await switchBoard(b.id)) closeLibrary();
  }));
  el.append(open);

  if (!b.current) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'library-del';
    del.setAttribute('aria-label', 'Delete this board');
    del.textContent = '×';
    // Asked for, because there is nothing behind it. The bin covers items, not
    // boards: deleteLibraryBoard() drops the packed blob and its index row, and
    // there is no undo, no restore and no second copy. This is a 22px glyph in
    // the corner of a card whose whole face is the Open button, so the gesture
    // that opens a board and the gesture that destroys one are half a
    // centimetre apart on a phone.
    //
    // One dialog rather than clear-data's three-press arming: this is one
    // board, not everything, and the board's own name in the question is what
    // makes the answer informed. Every accidental way out of ask() - Escape,
    // the backdrop, the close button - is 'cancel'.
    del.addEventListener('click', () => guard(async () => {
      const answer = await ask({
        title: 'Delete this board?',
        body: `"${b.title || 'Untitled board'}" will be removed from the shelf. `
          + 'This cannot be undone, and the bin does not hold boards.',
        go: 'Delete',
        danger: true,
      });
      if (answer !== 'go') return;
      await deleteLibraryBoard(b.id);
      await render();
    }));
    el.append(del);
  }
  return el;
}
