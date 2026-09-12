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
  // Duck-type check: missing <dialog> support falls through to 'cancel'.
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

function openWith(el: HTMLDialogElement, o: AskSettled): Promise<Answer | string | null> {
  // All six child elements live inside #ask in index.html.
  const title = document.getElementById('ask-title')!;
  const body = document.getElementById('ask-body')!;
  const go = document.getElementById('ask-go')!;
  const cancel = document.getElementById('ask-cancel')!;
  const keep = document.getElementById('ask-keep')!;
  // The <input> inside #ask — same markup block as the elements above.
  const field = document.getElementById('ask-field') as HTMLInputElement;

  // setMarked: textContent + the app name in its typeface (see wordmark.ts).
  setMarked(title, o.title);
  setMarked(body, o.body);
  body.hidden = !o.body;
  setMarked(go, o.go);
  setMarked(cancel, o.cancel);
  setMarked(keep, o.keep);
  // Keep button hidden when unused.
  keep.hidden = !o.keep;

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

  return new Promise<Answer | string | null>(resolve => {
    let answer: Answer = 'cancel';

    const close = (choice: Answer) => {
      answer = choice;
      // Single exit path for all five ways to close.
      cue('pick');
      el.close();
    };
    const onGo = () => close('go');
    const onCancel = () => close('cancel');
    const onKeep = () => close('keep');

    // Click on the <dialog> itself (not a child) = backdrop = cancel.
    const onClick = (e: MouseEvent) => { if (e.target === el) close('cancel'); };

    // Escape handled by the browser's cancel→close sequence; answer is already 'cancel'.
    // Enter in the field acts as go.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); close('go'); } };

    const onClose = () => {
      go.removeEventListener('click', onGo);
      cancel.removeEventListener('click', onCancel);
      keep.removeEventListener('click', onKeep);
      field.removeEventListener('keydown', onKey);
      el.removeEventListener('click', onClick);
      el.removeEventListener('close', onClose);
      // Field question → typed string or null; button question → Answer.
      resolve(o.field ? (answer === 'go' ? field.value.trim() : null) : answer);
    };

    go.addEventListener('click', onGo);
    cancel.addEventListener('click', onCancel);
    keep.addEventListener('click', onKeep);
    field.addEventListener('keydown', onKey);
    el.addEventListener('click', onClick);
    el.addEventListener('close', onClose);

    el.showModal();
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
      cancel.focus();
    }
  });
}
