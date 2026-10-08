// Credits sheet. Borrows #ask's dressing (same paper, hairline, radius) but
// not dialog.ts's queue — this asks nothing and resolves nothing. Faces are
// committed images, not fetched from GitHub. Its folds (More, and each block
// under Made with) open and close in motion, at the whimsy level's own pace.

import { el, readToken } from '../util.ts';
import { VERSION } from '../version.js';
import { baseMs, reducedMotion } from '../canvas/viewport.ts';

// Wired on first open — most sessions never open this sheet.
let wired = false;

/** Open the credits sheet. Idempotent; safe without a document. */
export function openCredits(): void {
  if (typeof document === 'undefined') return;
  // SAFETY: #credits is the <dialog> in index.html. The showModal duck-type test below
  // rejects anything else, a missing <dialog> included.
  const dlg = el('credits') as HTMLDialogElement | null;
  if (!dlg || typeof dlg.showModal !== 'function') return;

  if (!wired) {
    // Click on the ::backdrop (target === dlg) closes the sheet.
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    el('credits-close')?.addEventListener('click', () => dlg.close());
    // Which mbrd this is, beside its licence. The markup carries no number of
    // its own, so it can never name a version the app is not.
    const version = dlg.querySelector('.credits-version');
    if (version) version.textContent = VERSION;
    // The summary's own toggle is taken over, so a fold can move: the browser's
    // flips in one frame, and a fold closing has to stay open until it is shut.
    dlg.addEventListener('click', e => {
      if (!(e.target instanceof Element)) return;
      const summary = e.target.closest('summary');
      const fold = summary?.parentElement;
      if (!(fold instanceof HTMLDetailsElement) || summary !== fold.querySelector(':scope > summary')) return;
      e.preventDefault();
      // In motion, a press turns it round; at rest, it flips.
      const now = moving.get(fold);
      const opening = now ? !now.opening : !fold.open;
      // The blocks are one at a time - done here rather than with <details name>,
      // which would shut the other in a single frame.
      if (opening && fold.classList.contains('credits-dep')) {
        for (const other of dlg.querySelectorAll<HTMLDetailsElement>('.credits-dep')) {
          if (other !== fold && (other.open || moving.get(other)?.opening)) swing(other, false);
        }
      }
      swing(fold, opening);
    });
    wired = true;
  }

  if (!dlg.open) dlg.showModal();
}

/** A fold in motion, and which way it is going. */
const moving = new WeakMap<HTMLDetailsElement, { opening: boolean, runs: Animation[] }>();

/**
 * Open or close a <details> in motion: its height from wherever it is on
 * screen to where it is going, and what it holds fading and settling in with
 * it. A press mid-way turns it round from the height it has reached, so the
 * fold never jumps. Under reduced motion only the fade is kept.
 */
function swing(fold: HTMLDetailsElement, open: boolean) {
  const was = moving.get(fold);
  // Where it is now, read before anything is cancelled - the presentation
  // value, which is what a reversal has to start from.
  const from = fold.getBoundingClientRect().height;
  for (const run of was?.runs ?? []) run.cancel();
  if (!was && fold.open === open) return;

  // Where it is going: measured by putting it there for a moment, inside one
  // frame, so nothing is painted in between.
  fold.open = open;
  const to = fold.getBoundingClientRect().height;
  fold.open = true;

  const ms = baseMs();
  const easing = readToken('--ease') || 'ease';
  const held = [...fold.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.tagName !== 'SUMMARY');
  const runs: Animation[] = [];
  const still = reducedMotion();
  if (!still) {
    fold.style.overflow = 'hidden';
    runs.push(fold.animate({ height: [`${from}px`, `${to}px`] }, { duration: ms, easing }));
  }
  // The contents arrive a beat behind the room made for them, and leave first.
  for (const c of held) {
    runs.push(c.animate(
      open
        ? { opacity: [0, 1], translate: still ? ['0 0', '0 0'] : ['0 -4px', '0 0'] }
        : { opacity: [1, 0], translate: still ? ['0 0', '0 0'] : ['0 0', '0 -4px'] },
      { duration: open ? ms : ms * 0.6, easing, delay: open && !still ? ms * 0.15 : 0, fill: 'backwards' },
    ));
  }
  const entry = { opening: open, runs };
  moving.set(fold, entry);
  void Promise.all(runs.map(r => r.finished)).then(() => {
    if (moving.get(fold) !== entry) return;
    moving.delete(fold);
    fold.open = open;
    fold.style.overflow = '';
  }, () => { /* cancelled by a press that turned it round */ });
}
