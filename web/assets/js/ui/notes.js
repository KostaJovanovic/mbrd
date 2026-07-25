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
//
// One note stops being a note. If what it says turns out to be an address and
// nothing else, it becomes a link item as the edit closes - see linkify()
// below, which is as much about the moment the check runs as about the check.

import { byId, bus, markDirty, setItemText, retypeItem, NOTE_MAX } from '../state.js';
import { nodeFor } from '../canvas/items.js';
import { linkURL, linkDraft } from '../import/renderers.js';

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
  const head = card.querySelector('.note-title');
  // Every band between the top of the card and the bottom of the text: the
  // card's own padding, the title, the flex gap the card puts *between* its
  // children, and the body. Leaving the gap out cost exactly one gap of
  // height, which showed up as the last line of a note sliced through the
  // middle - enough to look like a rendering fault rather than a bad sum.
  const gap = head && body ? (parseFloat(cs.rowGap) || 0) : 0;
  const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  // offsetHeight is a rounded integer, so it can sit a fraction under the real
  // height; ceil plus a pixel keeps a descender off the edge.
  const need = Math.ceil(padding + (head?.offsetHeight || 0) + gap + body.offsetHeight) + 1;

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

  // How much room is left, shown only while the note is being written. A limit
  // you cannot see is indistinguishable from a broken keyboard: onBeforeInput
  // refuses the keystroke outright at the ceiling, so without this the note
  // simply stops accepting letters with nothing on screen to say why.
  const counter = document.createElement('div');
  counter.className = 'note-count';
  node.append(counter);
  const countLeft = () => {
    const left = NOTE_MAX - read().length;
    counter.textContent = left + ' left';
    // Quiet until it is nearly gone, at which point it is the only warning
    // there is going to be.
    counter.classList.toggle('is-low', left <= 40);
  };

  const onInput = () => { growNote(id); countLeft(); };

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
    counter.remove();
    node.classList.remove('is-editing');
    const text = read();
    if (linkify(id, text)) return;
    setItemText(id, text);
    growNote(id);
  }

  card.addEventListener('beforeinput', onBeforeInput);
  card.addEventListener('input', onInput);
  card.addEventListener('keydown', onKey);
  card.addEventListener('focusout', onFocusOut);
  countLeft();
  caretToEnd(head);
}

/**
 * A note written down to nothing but a URL is a link, and this is where it
 * becomes one. Returns whether it did.
 *
 * *When* matters more than what. The check runs from finish() - once, as the
 * edit is put away - and never from the input handler, because watching a note
 * dissolve into a link card as you type the last character of an address would
 * be the app taking the pen out of your hand mid-sentence. Waiting until you
 * have stepped away from the note makes the conversion something you finished
 * rather than something that happened to you, and one Ctrl+Z puts the sticky
 * back exactly as it was.
 *
 * It fires nowhere else, either. A note that already held nothing but a URL -
 * loaded from a .mbrd saved before links existed, or restored from the bin -
 * is left alone, because rewriting somebody's saved file on the way in is the
 * same surprise arriving at a worse moment. Only an edit you just made can
 * convert the thing you just edited.
 *
 * The typed text is never committed on its way past. One edit, one undo entry:
 * undoing the conversion gives back the note as it stood before the edit
 * started, not a half-way note that only ever existed in the DOM.
 *
 * The link takes the note's place, its position and its place in the stack -
 * but the link's own default size, because a sticky is square in order to hold
 * a paragraph and this holds two lines.
 *
 * Stickiness is read from live geometry rather than stored, so it needs no
 * repair: notes stuck *to* this one are stuck to a link now and go on
 * travelling with it, since a host may be anything. What does end is the other
 * direction - only notes stick, so a note that was riding on a photo stops
 * riding on it the moment it becomes a link. That is the honest outcome and
 * not an oversight: it is no longer a sticky, and a link card lying on a photo
 * is a card lying on a photo.
 */
function linkify(id, text) {
  const url = linkURL(text);
  if (!url) return false;
  retypeItem(id, linkDraft(url), 'Turn note into link');
  return true;
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
