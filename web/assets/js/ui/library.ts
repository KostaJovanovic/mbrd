// Board switcher UI: a grid of saved boards (title + thumbnail) over the
// library index. Storage logic is in storage/storage.ts and storage/library.ts.
// Renders from the index alone — boards are unpacked only when opened.

import {
  listLibrary, switchBoard, newBoard, deleteLibraryBoard, ensureCurrentOnShelf,
  openCloudBoard, relocateLibraryBoard,
} from '../storage/storage.ts';
import { platform, fileNameOf } from '../platform/platform.ts';
import { toast } from '../notify.ts';
import { markClosed } from '../util.ts';
import { ask } from './dialog.ts';
import { icon } from './menu.ts';
import { connectCloud } from './cloud-connect.ts';
import type { LibraryEntry } from '../storage/library.ts';
import type { RemoteBoard } from '../storage/cloud/sync.ts';

type ShelfEntry = LibraryEntry & { current: boolean };

let root: HTMLDivElement | null = null;

function ago(at: number) {
  if (!at) return '';
  const s = (Date.now() - at) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}

let opener: HTMLElement | null = null;

function closeLibrary() {
  if (!root) return;
  const held = root.contains(document.activeElement);
  root.remove();
  root = null;
  removeEventListener('keydown', onKey, true);
  const back = opener;
  opener = null;
  // Restore focus only if the shelf had it — otherwise the browser is placing it.
  if (held && back?.isConnected) back.focus({ preventScroll: true });
}

function onKey(e: KeyboardEvent) {
  if (!root) return;
  if (e.key === 'Escape') { e.stopPropagation(); markClosed(e); closeLibrary(); return; }
  // Manual tab trap — not a <dialog> so showModal() inertness is unavailable.
  if (e.key !== 'Tab') return;
  const stops = [...root.querySelectorAll<HTMLElement>(
    'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), '
    + 'textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')];
  if (!stops.length) return;
  const first = stops[0], last = stops[stops.length - 1];
  const on = document.activeElement;
  if (!root.contains(on)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
  if (!e.shiftKey && on === last) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && on === first) { e.preventDefault(); last.focus(); }
}

// Serialise storage moves — pack/unpack are slow and must not double-fire.
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
  //
  // SAFETY: the same claim ui/menu.ts makes about the same read - what holds
  // the keyboard on this page is a button, a field or the board, all of them
  // HTMLElements, and focus() is the only thing ever asked of what comes back.
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
  // Stamped once, here, and read by both of the things this render starts in
  // the background - the cloud listing and the foot. Incrementing it inside
  // either would invalidate the other, which is a bug that renders as a foot
  // that never appears.
  const mine = ++renderToken;
  // The board on screen has a row before the list is drawn, even if it has never
  // been switched away from. Without this the shelf held only boards you had
  // *left*, so a browser that had never switched showed "No other boards yet"
  // while looking straight at one. See ensureCurrentOnShelf() in
  // storage/storage.ts, which is a no-op on every visit after the first.
  await ensureCurrentOnShelf().catch(() => {});
  if (!root) return;   // closed while we were writing
  const boards = await listLibrary().catch(() => []);
  // Closed while we were reading, or asked to draw again since - the second is
  // new with the token and covers a delete pressed twice quickly, where the
  // slower of two renders would otherwise finish last and win.
  if (!root || mine !== renderToken) return;
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
  // the shelf. No thumbnail is passed anywhere here any more - stashCurrent()
  // takes its own through the injection main.ts wires. See setBoardThumb().
  fresh.addEventListener('click', () => guard(async () => {
    await newBoard();
    closeLibrary();
  }));
  // The app's own cross, from the sprite, rather than the `×` character this
  // used to set in 22px type. It was the only close in the app not drawn from
  // icons.svg, so it was the only one whose weight and proportion came from
  // whatever face the reader happens to have - and the only one a palette or a
  // whimsy tier could not reach. See research/design-audit-2026-08-25.md, B1.
  const shut = document.createElement('button');
  shut.type = 'button';
  shut.className = 'library-close';
  shut.setAttribute('aria-label', 'Close the board list');
  shut.title = 'Close the board list';
  shut.append(icon('i-close'));
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

  panel.append(head, grid, foot());
  root.append(panel);

  // And the cloud, after the paint rather than before it. Deliberately not
  // awaited: this is a round trip to somebody else's server, and the shelf is
  // the boards *this browser* is holding - they are already known and there is
  // no reason for a person opening the switcher to look at nothing while Drive
  // is asked about the rest. What arrives, arrives into the grid that is
  // already on screen.
  void addCloudBoards(grid);
}

// ---------------------------------------------------------------------------
// The other shelf — boards in Drive merged by id (the same ensureBoardId()
// mint). Best-effort: unsigned / offline / no credentials leaves the local
// shelf exactly as drawn.
// ---------------------------------------------------------------------------

/**
 * A token identifying the render this belongs to.
 *
 * The panel can be re-rendered (a delete) or closed while Drive is being asked,
 * and a listing that came back for a grid nobody is looking at must not append
 * cards to it. Compared rather than aborted: there is no fetch to cancel that
 * would not also need an AbortController threaded through the provider
 * interface for one caller.
 */
let renderToken = 0;

/** The provider, if this build has one and somebody is signed in to it. */
async function connectedProvider() {
  const { shareProvider } = await import('../storage/cloud/cloud.ts');
  const provider = shareProvider('gdrive');
  return provider?.signedIn() ? provider : null;
}

async function addCloudBoards(grid: HTMLElement) {
  const mine = renderToken;
  let boards: RemoteBoard[];
  try {
    const provider = await connectedProvider();
    if (!provider) return;
    const { remoteBoards } = await import('../storage/cloud/sync.ts');
    boards = await remoteBoards(provider);
  } catch (err) {
    // Said to the console and not to the person. They asked to see their
    // boards, and they are looking at them; a red toast over a shelf that
    // drew correctly would report a failure of something they did not ask for.
    console.warn('[mbrd] could not list cloud boards:', err);
    return;
  }
  if (mine !== renderToken || !grid.isConnected) return;

  const known = new Set<string>();
  for (const card of grid.querySelectorAll<HTMLElement>('[data-board]')) {
    known.add(card.dataset.board!);
  }

  for (const b of boards) {
    if (known.has(b.boardId)) {
      // On both shelves: one card, wearing the mark. The local row is the one
      // drawn, because it has the thumbnail and the title and this has neither.
      const on = grid.querySelector(`[data-board="${CSS.escape(b.boardId)}"] .library-open`);
      on?.append(cloudMark());
      continue;
    }
    // The empty note goes the moment there is anything to show, including when
    // the only thing to show came from Drive - otherwise a second machine with
    // nothing of its own reads "No other boards yet" over a grid of boards.
    grid.querySelector('.library-empty')?.remove();
    grid.append(cloudCard(b));
  }
}

/** The corner glyph that says "this one is in Drive too". */
function cloudMark() {
  const mark = document.createElement('span');
  mark.className = 'library-cloud';
  mark.title = 'Also kept in Google Drive';
  mark.append(icon('i-cloud'));
  return mark;
}

/**
 * A board that is in Drive and not on this machine.
 *
 * It has no thumbnail and no title, and neither is an oversight to fix here:
 * both live inside the packed board, and reading them would mean downloading
 * every board in the account to draw a list of them. The card says what is
 * actually known - that there is a board, and when it last changed - and the
 * title arrives with the board when it is opened.
 */
function cloudCard(b: RemoteBoard) {
  const el = document.createElement('div');
  el.className = 'library-card is-cloud';
  el.dataset.board = b.boardId;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'library-open';

  const thumb = document.createElement('div');
  thumb.className = 'library-thumb';
  thumb.append(icon('i-cloud'));
  const name = document.createElement('div');
  name.className = 'library-name';
  name.textContent = 'In Drive only';
  const when = document.createElement('div');
  when.className = 'library-when';
  when.textContent = ago(Date.parse(b.modifiedTime) || 0);
  open.append(thumb, name, when);
  open.addEventListener('click', () => guard(async () => {
    if (await openCloudBoard(b)) closeLibrary();
  }));
  el.append(open);
  return el;
}

/**
 * The foot of the panel: the one place the shelf mentions the cloud unprompted.
 *
 * **Bottom right, quiet, and only when there is something to offer.** It is an
 * invitation and not an error - somebody opening the board switcher wanted the
 * board switcher - so it sits where the eye lands last, under everything it is
 * talking about, and it is absent entirely once an account is attached. A
 * standing "Signed in" badge would be a status line nobody needs on a panel
 * that is about boards.
 *
 * Absent too where the build carries no cloud identifiers, on the schema's own
 * rule: offering to connect to something that cannot be connected to is worse
 * than saying nothing. canShareLink() answers that from two constants with no
 * network code behind it.
 *
 * The foot is built synchronously and filled in after, because whether somebody
 * is *signed in* cannot be answered without loading the provider module and
 * this function has to return an element now. An empty foot renders as nothing:
 * it carries no border and no padding of its own until it has a child.
 */
function foot() {
  const bar = document.createElement('div');
  bar.className = 'library-foot';
  void (async () => {
    const mine = renderToken;
    const { canShareLink } = await import('../storage/cloud/provider.ts');
    if (!canShareLink()) return;
    if (await connectedProvider()) return;
    if (mine !== renderToken || !bar.isConnected) return;

    const note = document.createElement('span');
    note.className = 'library-foot-note';
    note.textContent = 'Boards from your other machines';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'library-connect';
    go.append(icon('i-cloud'), document.createTextNode('Connect Google Drive'));
    // The shared implementation, the same one the Sync section's Connect button
    // reaches - not a second dialog written here. The press on this button *is*
    // the user gesture the popup needs, which is why the panel is left standing
    // rather than closed first: closing it would move focus and spend the
    // activation before connectCloud() ever asks its question.
    //
    // Redrawn only on success, and the whole panel rather than the foot: a
    // sign-in means there are cloud boards to go and fetch, which is render()'s
    // job and not this listener's.
    go.addEventListener('click', () => {
      void connectCloud('gdrive').then(on => { if (on) return render(); });
    });
    bar.append(note, go);
  })();
  return bar;
}

function card(b: ShelfEntry) {
  const el = document.createElement('div');
  el.className = 'library-card' + (b.current ? ' is-current' : '');
  // How the cloud listing finds its match. A library row's id and a board's
  // folder name in Drive are the same value - see the note over addCloudBoards.
  el.dataset.board = b.id;

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

  // A row that is a file says which file, under the title. Desktop only: `path`
  // is never set on the web, so every branch below is absent there rather than
  // conditional. See the field's own note in storage/library.ts.
  if (b.path) {
    const file = document.createElement('div');
    file.className = 'library-file';
    file.textContent = fileNameOf(b.path);
    // The full path is worth having but not worth the width - a card is one
    // line of small text wide, and the folder is the half you would lose.
    file.title = b.path;
    open.insertBefore(file, when);
    // Asked after the card is on screen, not before it is built. Checking every
    // row's file first would hold the whole shelf behind a burst of filesystem
    // calls, and the answer for all but the broken ones is yes - so the card is
    // drawn as usual and repainted in the one case that is not.
    void platform.files.exists({ name: fileNameOf(b.path), path: b.path }).then(there => {
      if (there) return;
      el.classList.add('is-missing');
      when.textContent = 'Moved or deleted';
      // Not disabled and not removed. The row is still the record that this
      // board exists somewhere, and Locate is the only thing that can repair
      // it - deleting the row would throw away the title and the thumbnail as
      // well as the pointer.
      const find = document.createElement('button');
      find.type = 'button';
      find.className = 'library-locate';
      find.textContent = 'Locate';
      find.addEventListener('click', () => guard(async () => {
        if (await relocateLibraryBoard(b.id)) await render();
      }));
      el.append(find);
    }, () => {});
  }

  if (!b.current) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'library-del';
    del.setAttribute('aria-label', 'Delete this board');
    del.title = 'Delete this board';
    // The sprite's cross, like the close beside it and every other cross in the
    // app. It set the `×` character, which is a different shape at a different
    // weight in whatever face the reader has.
    del.append(icon('i-close'));
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
