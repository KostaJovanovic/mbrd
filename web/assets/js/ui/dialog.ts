// Modal dialog replacing confirm(). Three answers (go / keep / cancel), styled
// to the board, no "localhost says". Reaches document only inside ask(), so
// storage.ts can import it without a browser.

import { setMarked } from './wordmark.ts';
import { cue } from '../cuelume/engine.ts';
import { onTouch } from '../canvas/viewport.ts';

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
  /** Whether `go` is styled as danger. Defaults to true unless a field is present. */
  danger?: boolean;
}

/** The same, once the defaults have been folded in - nothing is missing here. */
type AskSettled = Required<Omit<AskOptions, 'field' | 'danger'>>
  & { field: AskField | null, danger?: boolean };

const DEFAULTS: Omit<AskSettled, 'danger'> = { title: 'Are you sure?', body: '', go: 'Yes', cancel: 'Cancel', keep: '', field: null };

/** Nothing is open twice: a second ask() while one is up waits for it. */
let current: Promise<Answer | string | null> | null = null;

/** Show the dialog. Without a field: resolves to 'go' | 'keep' | 'cancel'.
 * With a field: resolves to the trimmed input string, or null on any exit.
 * No document (test/node) resolves to 'cancel'. */
export function ask(opts?: AskOptions & { field?: null }): Promise<Answer>;
export function ask(opts: AskOptions & { field: AskField }): Promise<string | null>;
export async function ask(opts: AskOptions = {}): Promise<Answer | string | null> {
  if (typeof document === 'undefined') return 'cancel';
  // SAFETY: #ask is a <dialog> in index.html. The showModal duck-type test below sends a
  // browser without <dialog> support to 'cancel'.
  const el = document.getElementById('ask') as HTMLDialogElement | null;
  if (!el || typeof el.showModal !== 'function') return 'cancel';

  // Serialise: two competing focus traps is a trap.
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

/** How a box departs from the usual, for the one that does. */
export interface ModalOptions {
  /** No 'pick' cue on the way out. */
  quiet?: boolean;
  /** True while a click on the backdrop must not close the box. */
  hold?: () => boolean;
}

/**
 * Show a <dialog> modally; resolves when it closes, however it closes.
 *
 * Owns what every box here did the same way by hand: the cue on the way out, a
 * click on the <dialog> itself (the backdrop, not a child) cancelling, and
 * taking every listener down again. `wire` adds the box's own listeners and
 * passes `signal` to each, so none can outlive the box; `close` is the one exit
 * for its buttons. Escape is the browser's own cancel→close and needs nothing.
 *
 * The box is open by the time this returns, so a caller focuses or measures
 * after the call and awaits the promise after that.
 */
export function openModal(
  el: HTMLDialogElement,
  wire: (signal: AbortSignal, close: () => void) => void,
  { quiet = false, hold = () => false }: ModalOptions = {},
): Promise<void> {
  return new Promise<void>(resolve => {
    const life = new AbortController();
    const { signal } = life;
    const close = () => {
      if (!quiet) cue('pick');
      el.close();
    };
    el.addEventListener('click', e => { if (e.target === el && !hold()) close(); }, { signal });
    el.addEventListener('close', () => { life.abort(); resolve(); }, { signal });
    wire(signal, close);
    el.showModal();
  });
}

async function openWith(el: HTMLDialogElement, o: AskSettled): Promise<Answer | string | null> {
  // All six child elements live inside #ask in index.html.
  const title = document.getElementById('ask-title')!;
  const body = document.getElementById('ask-body')!;
  const go = document.getElementById('ask-go')!;
  const cancel = document.getElementById('ask-cancel')!;
  const keep = document.getElementById('ask-keep')!;
  // SAFETY: #ask-field is the <input> inside #ask in index.html, the same markup block as
  // the elements above.
  const field = document.getElementById('ask-field') as HTMLInputElement;

  // setMarked: textContent + the app name in its typeface (see wordmark.ts).
  setMarked(title, o.title);
  setMarked(body, o.body);
  body.hidden = !o.body;
  setMarked(go, o.go);
  setMarked(cancel, o.cancel);
  setMarked(keep, o.keep);
  // Keep button hidden when unused, and Cancel when a question passes '' for
  // it: Escape and the backdrop still answer 'cancel'.
  keep.hidden = !o.keep;
  cancel.hidden = !o.cancel;

  field.hidden = !o.field;
  // Set type before value — a colour input sanitises '' to #000000 otherwise.
  field.type = o.field?.type ?? 'text';
  field.value = o.field?.value ?? '';
  field.placeholder = o.field?.placeholder ?? '';
  // Shared element outlives each question — clear stale maxLength.
  if (o.field?.maxLength) field.maxLength = o.field.maxLength;
  else field.removeAttribute('maxlength');
  // Danger styling: on by default for button questions, off for field questions.
  go.classList.toggle('danger', o.danger ?? !o.field);

  // Escape and the backdrop leave this at 'cancel'. A getter, because tsc
  // narrows a `let` to its initial value and cannot see the closure set it.
  let answer: Answer = 'cancel';
  const answered = (): Answer => answer;
  const closed = openModal(el, (signal, close) => {
    const pick = (choice: Answer) => () => { answer = choice; close(); };
    go.addEventListener('click', pick('go'), { signal });
    cancel.addEventListener('click', pick('cancel'), { signal });
    keep.addEventListener('click', pick('keep'), { signal });
    // Enter in the field acts as go.
    field.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); pick('go')(); }
    }, { signal });
  });
  // Focus: field → the input; touch → the dialog itself (no highlighted
  // button on a device with no Enter key); desktop → cancel (safe default
  // against an accidental Enter that would destroy work).
  if (o.field) {
    field.focus();
  } else if (onTouch()) {
    // -1 makes focus() work but keeps it out of the tab order.
    el.tabIndex = -1;
    el.focus();
  } else {
    // With no Cancel, the answer that is not `go`: the safer of the two.
    (cancel.hidden ? (keep.hidden ? go : keep) : cancel).focus();
  }
  await closed;
  // Field question → typed string or null; button question → Answer.
  return o.field ? (answered() === 'go' ? field.value.trim() : null) : answered();
}
