// Board title — one editor, two hosts (mobile masthead + desktop title
// card). Here rather than sidebar.ts so the sanitizer and commit-on-change
// rule stay in one place.

import { el, makeEditable, markClosed, selectContents, caretToEnd } from '../util.ts';
import {
  board, bus, setTitle, markDirty,
  cleanBoardTitle, cleanBoardTitleDraft, isDefaultTitle,
} from '../state.ts';

/**
 * A tap on the name, told apart from a drag across it.
 *
 * Not a `click` listener: the masthead is empty canvas to input.ts, so
 * #viewport captures the pointer and starts a pan on press, and the click
 * never fires there. So press and lift are heard separately here, and the
 * slop below tells a stationary tap from a pan that stopped where it started.
 */
const TITLE_TAP_SLOP = 6;
/** The press half of a tap in flight: which pointer, and where it went down. */
let titleTap: { id: number, x: number, y: number } | null = null;

/** Wire the masthead tap and subscribe the repaint. Called once, from main.ts. */
export function initBoardTitle() {
  // #mobile-board-title and #mobile-board-header are static markup in
  // index.html; an absent one is a broken build, not a state to paint around.
  el('mobile-board-title')!.addEventListener('pointerdown', e => {
    // Already editing: don't reselect the whole name out from under someone
    // aiming at one word.
    // SAFETY: currentTarget is the field itself, #mobile-board-title, an <h2> in index.html.
    titleTap = (e.currentTarget as HTMLElement).isContentEditable
      ? null
      : { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointerup', e => {
    const tap = titleTap;
    titleTap = null;
    if (!tap || e.pointerId !== tap.id) return;
    if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TITLE_TAP_SLOP) return;
    editMobileTitle();
  }, true);
  window.addEventListener('pointercancel', () => { titleTap = null; }, true);

  bus.on('board', paintMobileTitle);
  bus.on('board:load', paintMobileTitle);
  paintMobileTitle();
}

/**
 * The name across the Mobile masthead. The band itself is positioned by
 * canvas/mobile-frame.ts; this just keeps the text current, in any mode, so
 * a display:none header isn't stale when Mobile switches back on. See the
 * [data-untitled] stylesheet rule for how an unnamed board is dressed down.
 */
export function paintMobileTitle() {
  const header = el('mobile-board-header');
  if (!header) return;
  const field = el('mobile-board-title')!;
  // Never over a rename in progress. 'board' fires on every dirty-flag flip as
  // well as on a real rename, and rewriting the field mid-word would take the
  // caret with it - the same guard the sidebar's name field keeps.
  if (!field.isContentEditable) field.textContent = board.title;
  header.toggleAttribute('data-untitled', isDefaultTitle(board.title));
  // The Desktop title card carries the same name. It is not inline-editable, so
  // no caret guard is needed - just keep it current and dim it while untitled,
  // the way the masthead's [data-untitled] rule does.
  const card = document.querySelector<HTMLElement>('.item[data-type="title"] .title-name');
  if (card) {
    // Not over an inline rename in progress on the card, the same caret guard the
    // masthead gets above: rewriting the text mid-word would take the caret with it.
    if (!card.isContentEditable) card.textContent = board.title;
    card.classList.toggle('is-untitled', isDefaultTitle(board.title));
  }
}

/**
 * Rename the board by typing in a panel's name field.
 *
 * `change` rather than `input`, so a rename is one undoable event and one
 * dirty flag rather than one per keystroke.
 *
 * Edits `board.title` directly rather than preferring the open file's name -
 * the two only differ once somebody renames a board opened from a .mbrd,
 * which is the whole point of the feature.
 *
 * setTitle() deliberately doesn't mark the board dirty itself: the save
 * picker also calls it, right after a save, where re-dirtying would be wrong.
 *
 * Takes the element rather than an id because the two callers own their own
 * markup: the sidebar's field from the settings schema, the masthead's
 * written out in index.html.
 */
export function wireTitleField(input: HTMLInputElement | null) {
  if (!input) return;
  input.addEventListener('input', () => {
    const clean = cleanBoardTitleDraft(input.value);
    if (clean !== input.value) input.value = clean;
  });
  input.addEventListener('change', () => {
    const next = cleanBoardTitle(input.value);
    if (next === titleValue()) return;
    setTitle(next);
    markDirty();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    // Put the old name back before the global handler blurs us, so escaping
    // out of a half-typed name leaves the board called what it was called.
    else if (e.key === 'Escape') input.value = titleValue();
  });
}

/** The title as a field holds it: empty for a board still on its auto name, so
 *  the name shows through as the faint italic placeholder rather than as a
 *  value nobody typed. */
const titleValue = () => (isDefaultTitle(board.title) ? '' : board.title);

/**
 * Push the current name back into a panel's field - after opening a board, an
 * undo, or a rename made anywhere else, which is the case that matters now that
 * there is more than one field: typing in one must show up in the other.
 */
export function paintTitleField(input: HTMLInputElement | null) {
  if (!input) return;
  // Never while it is being typed into: 'board' fires on every dirty-flag flip,
  // and rewriting the field mid-word would move the caret to the end.
  if (document.activeElement !== input) input.value = titleValue();
  // The auto name lives in the placeholder, so an unnamed board shows its date
  // faint and italic and a click starts from an empty field rather than from
  // text to delete.
  input.placeholder = isDefaultTitle(board.title) ? board.title : 'Untitled board';
}

/**
 * Rename the board by tapping its name on the masthead - the same bargain as
 * editItemName() in canvas/items.ts: edit in place rather than in a dialog,
 * since the sidebar's name field is three taps away behind a menu on a phone.
 * A tap, not a double click, since nothing else competes for it; panning
 * doesn't compete either, since the field only grabs the pointer once still.
 */
function editMobileTitle() {
  editBoardName(el('mobile-board-title'));
}

/**
 * Inline rename of the board name, on the Desktop title card: the same editor
 * the masthead uses, pointed at the card's own name node. Reached by the card's
 * T button, a double-click on the card, or F2 while it is selected.
 */
export function editTitleCard() {
  editBoardName(document.querySelector<HTMLElement>('.item[data-type="title"] .title-name'));
}

/**
 * The shared inline board-name editor. `field` is whichever element shows the
 * name - the Mobile masthead or the Desktop card - and both edit board.title and
 * repaint through paintMobileTitle, which keeps the two in step.
 */
function editBoardName(node: HTMLElement | null) {
  if (!node || node.isContentEditable) return;
  // Held as a const so the guard above still counts inside the handlers below:
  // a parameter is a mutable binding and the narrowing would not follow it in.
  const field = node;

  makeEditable(field);
  // The stored name, not the shown one - they are the same string today, and
  // this is the line that keeps them the same if the masthead ever dresses it.
  field.textContent = board.title;

  let done = false;
  let keep = true;

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();          // the canvas must not see Delete, space or Escape
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
    else if (e.key === 'Escape') { keep = false; markClosed(e); finish(); }
  };

  const onInput = () => {
    // innerText omits a trailing space in a contenteditable. Reading it here
    // made the sanitizer erase the separator before a second word could start;
    // textContent keeps the character that the editor actually owns.
    const clean = cleanBoardTitleDraft(field.textContent);
    if (clean === field.textContent) return;
    field.textContent = clean;
    // The caret jumped to the front when textContent was rewritten; put it back
    // at the end so typing continues where it left off.
    caretToEnd(field);
  };

  function finish() {
    if (done) return;
    done = true;
    // Read before the teardown: innerText is what the field renders, and a name
    // is one line, so a pasted paragraph is flattened rather than refused.
    const typed = cleanBoardTitle(field.innerText);
    field.removeEventListener('keydown', onKey);
    field.removeEventListener('input', onInput);
    field.removeEventListener('blur', finish);
    offRebuild?.();
    offRebuild = null;
    field.contentEditable = 'false';
    field.blur();
    // Put the stored name back first. A name that comes back unchanged commits
    // nothing and emits nothing, and without this the half-typed text would
    // simply stay on screen.
    paintMobileTitle();
    if (!keep || typed === board.title) return;
    setTitle(typed);
    // setTitle() deliberately does not dirty the board - it is also called by
    // the save picker - so the rename says so itself, as the sidebar's field
    // does.
    markDirty();
    paintMobileTitle();
  }

  field.addEventListener('keydown', onKey);
  field.addEventListener('input', onInput);
  field.addEventListener('blur', finish);
  // The case none of the three listeners above can see: the node going away
  // underneath the edit. On Desktop `field` is inside the title card, which
  // canvas/items.ts culls and rebuilds on scroll-out, a quality/whimsy change,
  // or any 'items' emit - a rebuilt card is a new node, so finish() would
  // never run and the typed name would vanish silently. Commits rather than
  // cancels: the letters were typed on purpose, a remount isn't a change of
  // mind. Masthead markup is never culled, so this only ever bit the card.
  let offRebuild: (() => void) | null = bus.on('items', () => {
    if (!done && !field.isConnected) finish();
  });
  // Next frame, not now: on the Desktop card this opens from the T button's
  // pointerdown, and the button would then steal focus on the click that
  // follows, blurring and closing the editor before it could be typed in.
  // Selected rather than merely focused, since a rename usually replaces the
  // whole name.
  requestAnimationFrame(() => {
    if (done) return;
    field.focus();
    selectContents(field);
  });
}
