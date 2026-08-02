// The board's name, in the two places it is shown and edited.
//
// One editor, two hosts: the Mobile masthead and the Desktop title card. They
// are the same string and the same edit, so they are one module - keeping the
// two in step was the whole reason this was written once rather than twice.
//
// Lifted out of main.js unchanged. Reached from `cmds` (the T button, F2, a
// double-click on the card) and from the masthead tap wired below.

import { el } from '../util.js';
import {
  board, bus, setTitle, markDirty,
  cleanBoardTitle, cleanBoardTitleDraft, isDefaultTitle,
} from '../state.js';

/**
 * A tap on the name, told apart from a drag across it.
 *
 * Not a `click` listener, and that is the whole of this. A press anywhere the
 * canvas considers empty - which the masthead is, since it is not a card and
 * not one of the widgets input.js knows by name - has #viewport take pointer
 * capture on the way down and start a pan. Capture retargets the rest of the
 * gesture, the compatibility mouse events with it, so the lift is delivered to
 * the viewport and the name is never clicked at all. It looked like the rename
 * had simply stopped working.
 *
 * So the two ends are heard separately: the press on the name itself, the lift
 * on the window in the capture phase, which runs before the viewport's own
 * handlers and cannot be redirected. The name is left out of input.js's widget
 * list deliberately - a third of the screen that cannot be dragged is worse
 * than no shortcut at all - so the slop below is what separates the two: a
 * finger that travelled was panning, and a pan must not open an editor when it
 * happens to stop where it started.
 */
const TITLE_TAP_SLOP = 6;
let titleTap = null;

/** Wire the masthead tap and subscribe the repaint. Called once, from main.js. */
export function initBoardTitle() {
  el('mobile-board-title').addEventListener('pointerdown', e => {
    // Already editing: the caret owns the pointer, and re-entering the edit
    // would reselect the whole name out from under somebody aiming at one word
    // of it.
    titleTap = e.currentTarget.isContentEditable
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
 * The name across the Mobile masthead.
 *
 * The band itself is positioned by canvas/mobile-frame.js, off the same view
 * change everything else in screen space paints on, so this is the only part
 * that needs saying here. Written whatever the mode: a header that is
 * display:none has nothing to gain from being stale when Mobile is switched
 * back on.
 *
 * A board with no name of its own still gets its page - see the [data-untitled]
 * rule in the stylesheets for why it is dressed down rather than left blank.
 */
export function paintMobileTitle() {
  const header = el('mobile-board-header');
  if (!header) return;
  const field = el('mobile-board-title');
  // Never over a rename in progress. 'board' fires on every dirty-flag flip as
  // well as on a real rename, and rewriting the field mid-word would take the
  // caret with it - the same guard the sidebar's name field keeps.
  if (!field.isContentEditable) field.textContent = board.title;
  header.toggleAttribute('data-untitled', isDefaultTitle(board.title));
  // The Desktop title card carries the same name. It is not inline-editable, so
  // no caret guard is needed - just keep it current and dim it while untitled,
  // the way the masthead's [data-untitled] rule does.
  const card = document.querySelector('.item[data-type="title"] .title-name');
  if (card) {
    // Not over an inline rename in progress on the card, the same caret guard the
    // masthead gets above: rewriting the text mid-word would take the caret with it.
    if (!card.isContentEditable) card.textContent = board.title;
    card.classList.toggle('is-untitled', isDefaultTitle(board.title));
  }
}

/**
 * Rename the board by tapping its name on the masthead.
 *
 * The same bargain a sticky note and an item's caption strike - see
 * editItemName() in canvas/items.js, which this follows down to the Escape
 * handling: the edit happens where you are already looking rather than in a
 * dialog thrown over the top of it, and on a phone the sidebar's name field is
 * three taps away behind a menu.
 *
 * A tap rather than a double click. The masthead is not a card, nothing else
 * can be done to it, and there is no drag or selection for a single tap to be
 * competing with - so the cheapest gesture is free to be the one that works.
 * Panning is not competing either: the field only takes the pointer while it is
 * standing still, and once it is editable input.js recognises a contenteditable
 * and leaves the gesture alone.
 */
export function editMobileTitle() {
  editBoardName(el('mobile-board-title'));
}

/**
 * Inline rename of the board name, on the Desktop title card: the same editor
 * the masthead uses, pointed at the card's own name node. Reached by the card's
 * T button, a double-click on the card, or F2 while it is selected.
 */
export function editTitleCard() {
  editBoardName(document.querySelector('.item[data-type="title"] .title-name'));
}

/**
 * The shared inline board-name editor. `field` is whichever element shows the
 * name - the Mobile masthead or the Desktop card - and both edit board.title and
 * repaint through paintMobileTitle, which keeps the two in step.
 */
function editBoardName(field) {
  if (!field || field.isContentEditable) return;

  // plaintext-only keeps pasted markup out of a name; not every engine has it.
  try { field.contentEditable = 'plaintext-only'; }
  catch { field.contentEditable = 'true'; }
  if (!field.isContentEditable) field.contentEditable = 'true';
  // The stored name, not the shown one - they are the same string today, and
  // this is the line that keeps them the same if the masthead ever dresses it.
  field.textContent = board.title;

  let done = false;
  let keep = true;

  const onKey = e => {
    e.stopPropagation();          // the canvas must not see Delete, space or Escape
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
    else if (e.key === 'Escape') { keep = false; finish(); }
  };

  const onInput = () => {
    // innerText omits a trailing space in a contenteditable. Reading it here
    // made the sanitizer erase the separator before a second word could start;
    // textContent keeps the character that the editor actually owns.
    const clean = cleanBoardTitleDraft(field.textContent);
    if (clean === field.textContent) return;
    field.textContent = clean;
    const caret = document.createRange();
    caret.selectNodeContents(field);
    caret.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(caret);
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
  // Focus on the next frame, not now. On the Desktop card this opens from the
  // T button's pointerdown, and the <button> then takes focus itself on the click
  // that follows - which would blur the field the instant it was focused, run
  // finish(), and close the editor. That is exactly why a single click used to
  // open the rename and shut it again, needing a second. Focusing past the click
  // lets the field win. Harmless on the masthead tap, which has no button to
  // steal from. Selected rather than merely focused: a rename usually replaces
  // the name, and an untitled board is holding a placeholder nobody typed.
  requestAnimationFrame(() => {
    if (done) return;
    field.focus();
    const range = document.createRange();
    range.selectNodeContents(field);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
}
