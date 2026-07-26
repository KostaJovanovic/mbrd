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
// Kept in its own module rather than in util.js beside toast(), even though the
// two are the same kind of thing - a small piece of interface anything may
// reach for. toast() says something and returns; this one asks something and
// waits, which is a different enough contract to be worth its own file and its
// own name. Like toast(), it reaches for `document` only inside a function, so
// storage.js can import it and stay loadable without a browser.

const DEFAULTS = { title: 'Are you sure?', body: '', go: 'Yes', cancel: 'Cancel', keep: '' };

/** Nothing is open twice: a second ask() while one is up waits for it. */
let current = null;

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
 */
export async function ask(opts = {}) {
  if (typeof document === 'undefined') return 'cancel';
  const el = document.getElementById('ask');
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

function openWith(el, o) {
  const title = document.getElementById('ask-title');
  const body = document.getElementById('ask-body');
  const go = document.getElementById('ask-go');
  const cancel = document.getElementById('ask-cancel');
  const keep = document.getElementById('ask-keep');

  title.textContent = o.title;
  body.textContent = o.body;
  body.hidden = !o.body;
  go.textContent = o.go;
  cancel.textContent = o.cancel;
  keep.textContent = o.keep;
  // The third way is optional, and a button with no words in it is still a
  // button you can tab to and press.
  keep.hidden = !o.keep;

  return new Promise(resolve => {
    let answer = 'cancel';

    const close = choice => {
      answer = choice;
      el.close();
    };
    const onGo = () => close('go');
    const onCancel = () => close('cancel');
    const onKeep = () => close('keep');

    // Clicking the backdrop. A <dialog> fills the top layer, so a click that
    // lands on the element itself rather than on anything inside it landed
    // outside the panel - which is what ::backdrop actually is here.
    const onClick = e => { if (e.target === el) close('cancel'); };

    // Escape, which the browser handles by firing this and closing on its own.
    const onCancelEvent = () => { answer = 'cancel'; };

    const onClose = () => {
      go.removeEventListener('click', onGo);
      cancel.removeEventListener('click', onCancel);
      keep.removeEventListener('click', onKeep);
      el.removeEventListener('click', onClick);
      el.removeEventListener('cancel', onCancelEvent);
      el.removeEventListener('close', onClose);
      resolve(answer);
    };

    go.addEventListener('click', onGo);
    cancel.addEventListener('click', onCancel);
    keep.addEventListener('click', onKeep);
    el.addEventListener('click', onClick);
    el.addEventListener('cancel', onCancelEvent);
    el.addEventListener('close', onClose);

    el.showModal();
    // Focus lands on the harmless button, never on the destructive one. The
    // dialog can arrive under a finger already on its way to Enter - it is
    // opened by a keyboard shortcut as often as by a click - and the difference
    // between the two buttons is a board.
    cancel.focus();
  });
}
