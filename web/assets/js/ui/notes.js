// Editing a sticky note, and keeping it big enough to hold what it says.
//
// A note is drawn as two fields - a title and a body, split on the first
// newline (see renderers.js/note) - but it is stored as one string and edited
// as one thing: focus moves between the two without ever leaving the note, and
// the pair commits once, on the way out.
//
// Two rules keep the text and the box agreed with each other:
//
//   the text can never be longer than NOTE_MAX
//   the box can never be shorter than the text needs
//
// The second is enforced from both directions - the note grows as you type,
// and a resize drag stops at the height the text requires - so there is no
// state in which a note is hiding something.

import { byId, bus, markDirty, setItemText, NOTE_MAX } from '../state.js';
import { nodeFor } from '../canvas/items.js';

/**
 * Height this note needs, in world px, for its text at `width`.
 *
 * Wrapping depends on the width, so a resize has to ask about the width it is
 * *proposing*, not the one on screen. The measurement is destructive-then-
 * restored: the body is normally a flex child stretched to fill the card, and
 * a stretched element reports its box rather than its content, so it is
 * briefly released to its natural height to be measured.
 */
export function noteHeight(id, width) {
  const el = nodeFor(id);
  const card = el?.querySelector('.card');
  const body = card?.querySelector('.note-body');
  if (!card || !body) return 0;

  const prevWidth = el.style.width;
  if (width != null) el.style.width = width.toFixed(2) + 'px';
  const prevFlex = body.style.flex;
  const prevHeight = body.style.height;
  body.style.flex = '0 0 auto';
  body.style.height = 'auto';

  const cs = getComputedStyle(card);
  const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const head = card.querySelector('.note-title');
  const need = Math.ceil(padding + (head?.offsetHeight || 0) + body.offsetHeight);

  body.style.flex = prevFlex;
  body.style.height = prevHeight;
  if (width != null) el.style.width = prevWidth;
  return need;
}

/**
 * Grow a note to fit its text. Never shrinks: a note you deliberately made
 * roomy should stay roomy when you delete a line, and the resize floor below
 * already stops you from making one too small by hand.
 *
 * Not undoable, on purpose - the same reasoning as adoptAspect() in
 * renderers.js. It is part of the text arriving, not an edit of its own, and
 * an undo entry per keystroke would bury the edit it belongs to.
 */
export function growNote(id) {
  const it = byId(id);
  if (!it || it.type !== 'note') return;
  const need = noteHeight(id, it.w);
  if (!need || need <= it.h) return;
  it.h = need;
  bus.emit('geom', [id]);
  markDirty();
}

/** The shortest a note may be dragged at `width` - the height its text needs. */
export const noteFloor = (id, width) => noteHeight(id, width);

/**
 * Turn a note into two editable fields until focus leaves it.
 *
 * Both fields are live at once and the note commits on focusout, not on blur:
 * moving from the title to the body blurs the title, and committing there
 * would end the edit halfway through it.
 */
export function editNote(id) {
  const item = byId(id);
  const node = nodeFor(id);
  if (!item || item.type !== 'note' || !node) return;
  const card = node.querySelector('.card');
  const head = card?.querySelector('.note-title');
  const body = card?.querySelector('.note-body');
  if (!head || !body) return;

  node.classList.add('is-editing');
  for (const field of [head, body]) {
    // plaintext-only keeps pasted markup out of a note; not every engine has it.
    try { field.contentEditable = 'plaintext-only'; }
    catch { field.contentEditable = 'true'; }
    if (!field.isContentEditable) field.contentEditable = 'true';
  }

  const read = () => (head.innerText + '\n' + body.innerText).replace(/\n+$/, '');

  // beforeinput, not a check after the fact: refusing the keystroke leaves the
  // caret where it was, where truncating afterwards would move it and quietly
  // eat whatever the paste was meant to add.
  const onBeforeInput = e => {
    if (e.inputType.startsWith('delete') || e.inputType === 'historyUndo') return;
    const adding = (e.data ?? e.dataTransfer?.getData('text/plain') ?? '').length || 1;
    const selected = String(getSelection()).length;
    if (read().length - selected + adding > NOTE_MAX) e.preventDefault();
  };

  const onInput = () => growNote(id);

  const onKey = e => {
    e.stopPropagation();                    // the canvas must not see Delete/space
    if (e.key === 'Escape') { finish(); return; }
    // Enter in the title is "done with the title", not a line break: the title
    // is one line by definition, and a second one in it would silently become
    // the first line of the body on the next render anyway.
    if (e.key === 'Enter' && e.target === head) {
      e.preventDefault();
      caretToStart(body);
    }
  };

  // focusout fires before the new element takes focus, so relatedTarget is
  // where focus is *going* - the one moment we can tell "moved to the body"
  // from "left the note entirely".
  const onFocusOut = e => {
    if (card.contains(e.relatedTarget)) return;
    finish();
  };

  let done = false;
  function finish() {
    if (done) return;
    done = true;
    card.removeEventListener('beforeinput', onBeforeInput);
    card.removeEventListener('input', onInput);
    card.removeEventListener('keydown', onKey);
    card.removeEventListener('focusout', onFocusOut);
    head.contentEditable = 'false';
    body.contentEditable = 'false';
    node.classList.remove('is-editing');
    setItemText(id, read());
    growNote(id);
  }

  card.addEventListener('beforeinput', onBeforeInput);
  card.addEventListener('input', onInput);
  card.addEventListener('keydown', onKey);
  card.addEventListener('focusout', onFocusOut);
  caretToEnd(head);
}

function caretToEnd(el) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function caretToStart(el) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
