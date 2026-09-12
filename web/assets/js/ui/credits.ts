// Credits sheet. Borrows #ask's dressing (same paper, hairline, radius) but
// not dialog.ts's queue — this asks nothing and resolves nothing. Faces are
// committed images, not fetched from GitHub.

import { el } from '../util.ts';

// Wired on first open — most sessions never open this sheet.
let wired = false;

/** Open the credits sheet. Idempotent; safe without a document. */
export function openCredits(): void {
  if (typeof document === 'undefined') return;
  // Duck-type check — safe if <dialog> is absent.
  const dlg = el('credits') as HTMLDialogElement | null;
  if (!dlg || typeof dlg.showModal !== 'function') return;

  if (!wired) {
    // Click on the ::backdrop (target === dlg) closes the sheet.
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    el('credits-close')?.addEventListener('click', () => dlg.close());
    wired = true;
  }

  if (!dlg.open) dlg.showModal();
}
