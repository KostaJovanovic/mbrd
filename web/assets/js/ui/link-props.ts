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
import { linkURL, linkTyped } from '../canvas/links.ts';
import { toast } from '../notify.ts';
import { onTouch } from '../canvas/viewport.ts';
import { openModal } from './dialog.ts';
import { copyText } from '../util.ts';

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

  // Grow the address field to its content: reset to auto so scrollHeight
  // measures the text, not the last height, then take that. CSS max-height
  // caps it at four lines and scrolls past them. Setting .style is fine under
  // the CSP - only a style attribute in markup is not.
  const autosize = () => {
    urlField.style.height = 'auto';
    urlField.style.height = `${urlField.scrollHeight}px`;
  };

  const closed = openModal(el, (signal, close) => {
    // Copy takes what is in the box now, edited or not - the field is the
    // truth on screen. A blank field copies nothing.
    copy.addEventListener('click', () => {
      const text = urlField.value.trim();
      if (!text) return;
      void copyText(text).then(ok => { if (ok) toast('Link copied'); });
    }, { signal });

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

    go.addEventListener('click', e => { e.preventDefault(); save(); }, { signal });
    cancel.addEventListener('click', close, { signal });
    // Enter in either field saves rather than adding a line: a URL has no
    // legitimate newline, so the textarea's wrapping stays soft (visual only).
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
    nameField.addEventListener('keydown', onKey, { signal });
    urlField.addEventListener('keydown', onKey, { signal });
    urlField.addEventListener('input', autosize, { signal });
  });
  // Now the field is laid out, size it to the address it opened with.
  autosize();
  // Touch: focus the dialog, not a field, so the keyboard does not spring up
  // before a tap. Desktop: the name field, the first thing to edit.
  if (onTouch()) { el.tabIndex = -1; el.focus(); } else nameField.focus();
  await closed;
  showing = false;
}
