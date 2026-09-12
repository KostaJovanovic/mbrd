// The link card Properties dialog. One box for a link card's two editable
// facts: the name shown on its chip, and the address it points at - which can
// also be copied out. Save writes both (setLinkURL + renameItem, each
// undoable); an address that will not parse keeps the box open with a note.
//
// Its own <dialog> (#link-props in index.html), not ask(): ask() holds one
// field, this holds two plus a Copy action. Reaches document only inside
// editLinkProps(), so nothing here runs at import - the seam commands.ts uses
// to call it without ui/ importing commands.ts back.

import { byId, renameItem, setLinkURL } from '../state.ts';
import { linkURL, linkTyped } from '../canvas/renderers.ts';
import { toast } from '../notify.ts';
import { cue } from '../cuelume/engine.ts';
import { onTouch } from '../canvas/viewport.ts';

// One at a time: a second call while the box is up is ignored, not stacked.
let showing = false;

/**
 * Open the Properties box for one link card. Resolves when it closes, however
 * it closes. A missing <dialog>, a non-link item, or no document (test/node)
 * all resolve without doing anything.
 */
export async function editLinkProps(id: string): Promise<void> {
  if (typeof document === 'undefined') return;
  const it = byId(id);
  if (!it || it.type !== 'link') return;
  // SAFETY: #link-props is a static <dialog> in index.html; the showModal guard
  // below also rules out a browser with no <dialog> support.
  const el = document.getElementById('link-props') as HTMLDialogElement | null;
  if (!el || typeof el.showModal !== 'function') return;

  // Every control is a static node in index.html's #link-props block. Narrowed
  // by instanceof rather than asserted, so lost markup bails instead of throwing.
  const nameField = document.getElementById('lp-name');
  const urlField = document.getElementById('lp-url');
  const copy = document.getElementById('lp-copy');
  const go = document.getElementById('lp-go');
  const cancel = document.getElementById('lp-cancel');
  if (!(nameField instanceof HTMLInputElement) || !(urlField instanceof HTMLTextAreaElement)
      || !copy || !go || !cancel) return;

  if (showing) return;
  showing = true;

  nameField.value = it.name ?? '';
  // The parser's own serialisation when the stored value parses; the raw
  // string otherwise, so a hand-written file's odd address is still shown.
  urlField.value = linkURL(it.meta?.url)?.href
    ?? (typeof it.meta?.url === 'string' ? it.meta.url : '');

  await new Promise<void>(resolve => {
    const close = () => { cue('pick'); el.close(); };

    // Copy takes what is in the box now, edited or not - the field is the
    // truth on screen. A blank field copies nothing.
    const onCopy = () => {
      const text = urlField.value.trim();
      if (!text) return;
      navigator.clipboard?.writeText(text).then(() => toast('Link copied'), () => {});
    };

    // Save validates the address first and, on a bad one, keeps the box open
    // rather than closing on edits the user cannot see were rejected.
    const save = () => {
      const url = linkTyped(urlField.value);
      if (!url) { toast('That is not an address this can open', 'error'); urlField.focus(); return; }
      // Two choices, two undoable writes: where it points, and what it is called.
      setLinkURL(id, url.href);
      renameItem(id, nameField.value);
      close();
    };

    // Grow the address field to its content: reset to auto so scrollHeight
    // measures the text, not the last height, then take that. CSS max-height
    // caps it at four lines and scrolls past them. Setting .style is fine under
    // the CSP - only a style attribute in markup is not.
    const autosize = () => {
      urlField.style.height = 'auto';
      urlField.style.height = `${urlField.scrollHeight}px`;
    };

    const onGo = (e: Event) => { e.preventDefault(); save(); };
    const onCancel = () => close();
    // A click on the <dialog> itself (the backdrop), not a child, cancels.
    const onClick = (e: MouseEvent) => { if (e.target === el) close(); };
    // Enter in either field saves; Escape is the browser's own cancel→close.
    // Enter saves rather than adding a line: a URL has no legitimate newline,
    // so the textarea's wrapping stays soft (visual only). Escape is the
    // browser's own cancel→close.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };

    const onClose = () => {
      copy.removeEventListener('click', onCopy);
      go.removeEventListener('click', onGo);
      cancel.removeEventListener('click', onCancel);
      el.removeEventListener('click', onClick);
      nameField.removeEventListener('keydown', onKey);
      urlField.removeEventListener('keydown', onKey);
      urlField.removeEventListener('input', autosize);
      el.removeEventListener('close', onClose);
      showing = false;
      resolve();
    };

    copy.addEventListener('click', onCopy);
    go.addEventListener('click', onGo);
    cancel.addEventListener('click', onCancel);
    el.addEventListener('click', onClick);
    nameField.addEventListener('keydown', onKey);
    urlField.addEventListener('keydown', onKey);
    urlField.addEventListener('input', autosize);
    el.addEventListener('close', onClose);

    el.showModal();
    // Now the field is laid out, size it to the address it opened with.
    autosize();
    // Touch: focus the dialog, not a field, so the keyboard does not spring up
    // before a tap. Desktop: the name field, the first thing to edit.
    if (onTouch()) { el.tabIndex = -1; el.focus(); } else nameField.focus();
  });
}
