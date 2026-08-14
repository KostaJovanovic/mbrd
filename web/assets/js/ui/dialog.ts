// The one question this app stops to ask.
//
// It replaces confirm(), which was wrong here for three reasons. It is drawn by
// the browser, so a board set in whatever palette and whimsy level you chose is
// interrupted by a grey system box. It puts "localhost:6273 says" above the
// sentence, which is the browser disclaiming the words rather than the app
// saying them. And it offers exactly two answers to a question that has three -
// the useful one being "no, let me keep this first", which confirm() cannot
// express and which is the answer most people actually want.
//
// Kept in its own module rather than in ui/overlays.js beside toast(), even though the
// two are the same kind of thing - a small piece of interface anything may
// reach for. toast() says something and returns; this one asks something and
// waits, which is a different enough contract to be worth its own file and its
// own name. Like toast(), it reaches for `document` only inside a function, so
// storage.js can import it and stay loadable without a browser.

/** Which button was pressed, for the question that has buttons. */
export type Answer = 'go' | 'keep' | 'cancel';

/** The one box, for the question that has one. All of it is optional. */
export interface AskField {
  value?: string;
  placeholder?: string;
  type?: string;
  maxLength?: number;
}

/** What a caller may ask for. Everything falls back to DEFAULTS. */
export interface AskOptions {
  title?: string;
  body?: string;
  go?: string;
  cancel?: string;
  keep?: string;
  field?: AskField | null;
  /**
   * Whether the `go` button wears the danger dressing.
   *
   * Defaults to "yes, unless there is a field", which is what this dialog did
   * for as long as every question it asked was destructive - clear everything,
   * discard unsaved work. It is a parameter now because there is a question
   * that is neither: a .mbrd has been dropped on a board and the two answers
   * are Open and Merge. Neither is destructive, both are ordinary, and a red
   * button would be the dialog telling somebody to be careful about a choice
   * they can undo.
   */
  danger?: boolean;
}

/** The same, once the defaults have been folded in - nothing is missing here. */
type AskSettled = Required<Omit<AskOptions, 'field' | 'danger'>>
  & { field: AskField | null, danger?: boolean };

const DEFAULTS: Omit<AskSettled, 'danger'> = { title: 'Are you sure?', body: '', go: 'Yes', cancel: 'Cancel', keep: '', field: null };

/** Nothing is open twice: a second ask() while one is up waits for it. */
let current: Promise<Answer | string | null> | null = null;

/**
 * Ask, and resolve to which button was pressed: 'go', 'keep' or 'cancel'.
 *
 * Escape, the backdrop and the close button are all 'cancel', because the one
 * thing that must be true of a destructive question is that every accidental
 * way out of it is the harmless answer.
 *
 * Without a document - node, a test - this resolves to 'cancel' rather than
 * throwing. Same bargain toast() makes, with the safe default chosen
 * deliberately: an unanswerable question about discarding somebody's work is
 * answered "don't".
 *
 * **With a `field`** the contract changes, and it changes on purpose rather
 * than by accident: the question is no longer "which of these" but "what", so
 * it resolves to the trimmed string that was typed, or to null for every way
 * out. A caller that passes a field knows it passed one, and null reads as "no
 * answer" in a way that a 'cancel' string sitting where a number should be does
 * not. `field` is `{ value, placeholder, type, maxLength }`, all optional.
 *
 * `type` is the input's type, so `'color'` makes this a colour picker rather
 * than a box - the same question shape either way, answered by pointing instead
 * of typing. A colour input always holds a value, so that question cannot be
 * answered blank; every way out of it is still null.
 *
 * A note is not asked for here, and was for a day. A note has a pad colour, a
 * shape, headings, an alignment, a font and a size, and a box that answers with
 * a string can express none of them - so what came back was a note that behaved
 * like a note everywhere except where it was written. See composeNote() in
 * canvas/notes.js: it puts the real editor in a dialog rather than describing a
 * second one here.
 */
// The two contracts the note above describes, said in the signature: without a
// field this answers with a button, with one it answers with what was typed.
export function ask(opts?: AskOptions & { field?: null }): Promise<Answer>;
export function ask(opts: AskOptions & { field: AskField }): Promise<string | null>;
export async function ask(opts: AskOptions = {}): Promise<Answer | string | null> {
  if (typeof document === 'undefined') return 'cancel';
  // #ask is a <dialog> in index.html; the duck-type check below is the runtime
  // half of that claim, and is what makes a browser without <dialog> fall out
  // here rather than throw.
  const el = document.getElementById('ask') as HTMLDialogElement | null;
  if (!el || typeof el.showModal !== 'function') return 'cancel';

  // Queued rather than stacked. Two modals open at once is a focus trap fighting
  // another focus trap, and there is no question here worth asking twice.
  while (current) await current;

  const o = { ...DEFAULTS, ...opts };
  const done = openWith(el, o);
  current = done;
  try {
    return await done;
  } finally {
    current = null;
  }
}

function openWith(el: HTMLDialogElement, o: AskSettled): Promise<Answer | string | null> {
  // index.html declares all six inside #ask itself, which ask() has already
  // found; this module has always read them straight through, and an absent one
  // is a broken build rather than a state to recover from.
  const title = document.getElementById('ask-title')!;
  const body = document.getElementById('ask-body')!;
  const go = document.getElementById('ask-go')!;
  const cancel = document.getElementById('ask-cancel')!;
  const keep = document.getElementById('ask-keep')!;
  const field = document.getElementById('ask-field') as HTMLInputElement;

  title.textContent = o.title;
  body.textContent = o.body;
  body.hidden = !o.body;
  go.textContent = o.go;
  cancel.textContent = o.cancel;
  keep.textContent = o.keep;
  // The third way is optional, and a button with no words in it is still a
  // button you can tab to and press.
  keep.hidden = !o.keep;

  field.hidden = !o.field;
  // type before value: an input reads its value through whatever type it
  // currently has, and a colour input handed '' while it is still a text box
  // sanitises the assignment to #000000 rather than to what was asked for.
  field.type = o.field?.type ?? 'text';
  field.value = o.field?.value ?? '';
  field.placeholder = o.field?.placeholder ?? '';
  // A ceiling where the caller has one, and none where it does not - the shared
  // element outlives every question asked through it, so a limit left behind by
  // the last one would silently cut the next.
  if (o.field?.maxLength) field.maxLength = o.field.maxLength;
  else field.removeAttribute('maxlength');
  // A question that wants something typed is not a destructive one - nothing
  // has been decided by the time it opens - so the "go" button loses the danger
  // dressing it wears for the delete-everything cases this dialog was built
  // for. Leaving it red would make "what size is this?" look like a threat.
  // Destructive unless the caller says otherwise, and never on a question with
  // a box in it - "what size is this?" was never a threat. See AskOptions.danger.
  go.classList.toggle('danger', o.danger ?? !o.field);

  return new Promise<Answer | string | null>(resolve => {
    let answer: Answer = 'cancel';

    const close = (choice: Answer) => {
      answer = choice;
      el.close();
    };
    const onGo = () => close('go');
    const onCancel = () => close('cancel');
    const onKeep = () => close('keep');

    // Clicking the backdrop. A <dialog> fills the top layer, so a click that
    // lands on the element itself rather than on anything inside it landed
    // outside the panel - which is what ::backdrop actually is here.
    const onClick = (e: MouseEvent) => { if (e.target === el) close('cancel'); };

    // Escape, which the browser handles by firing this and closing on its own.
    const onCancelEvent = () => { answer = 'cancel'; };

    // Enter in the field is the same press as the go button. Without it the
    // only way to answer a one-box question is to reach for the mouse, having
    // just been typing.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); close('go'); } };

    const onClose = () => {
      go.removeEventListener('click', onGo);
      cancel.removeEventListener('click', onCancel);
      keep.removeEventListener('click', onKeep);
      field.removeEventListener('keydown', onKey);
      el.removeEventListener('click', onClick);
      el.removeEventListener('cancel', onCancelEvent);
      el.removeEventListener('close', onClose);
      // A field question answers with what was typed; a button question answers
      // with which button. See the note on ask().
      resolve(o.field ? (answer === 'go' ? field.value.trim() : null) : answer);
    };

    go.addEventListener('click', onGo);
    cancel.addEventListener('click', onCancel);
    keep.addEventListener('click', onKeep);
    field.addEventListener('keydown', onKey);
    el.addEventListener('click', onClick);
    el.addEventListener('cancel', onCancelEvent);
    el.addEventListener('close', onClose);

    el.showModal();
    // Focus lands on the harmless button, never on the destructive one. The
    // dialog can arrive under a finger already on its way to Enter - it is
    // opened by a keyboard shortcut as often as by a click - and the difference
    // between the two buttons is a board.
    //
    // Unless there is a field, where the whole point is to type: nothing is
    // destroyed by this kind of question, and landing on Cancel would mean
    // every use of it began with a click into the box.
    if (o.field) field.focus();
    else cancel.focus();
  });
}
