// @ts-nocheck - TypeScript migration debt, not a judgement about this file.
//
// The tree was renamed from .js to .ts mechanically, which moved 104 modules in
// one step and annotated none of them. This module is carried unchecked so that
// npm run typecheck stays green and keeps meaning something, rather than going
// red and being ignored. Converting this module IS deleting this block and
// fixing what tsc then says - tests/ts-debt.test.js holds the count and lets it
// only fall.
// Who made this, and the one screen that says so.
//
// The credit used to be a single anchor at the quiet end of the sidebar footer.
// That is the right *place* for it and the wrong amount of room: one word and a
// link, with nowhere to put a second name and nothing either person would say.
// This is the same corner promoted to a sheet - opened deliberately, read in a
// second, and shut by every key that shuts anything else.
//
// It borrows #ask's dressing rather than inventing its own, and that is the
// whole of the design: the same paper, hairline, ogee radius and lift budget
// every other surface uses, so the one moment the board steps aside it still
// looks like the board. What it does not borrow is dialog.js's *contract*.
// ask() resolves to an answer and queues behind itself, because a question two
// callers ask at once is a focus trap fighting a focus trap. This one asks
// nothing, resolves to nothing, and the worst a second open can do is find it
// already open - so it is a plain module beside that one rather than a fourth
// mode inside it.
//
// The faces are files under assets/img, taken off GitHub once and committed,
// not <img src="https://github.com/..."> read at open time. Fetching them would
// make this the fourth thing in the app that talks to somebody else's server,
// and the first to do it for decoration - on the screen about the people who
// wrote the rule. See "Three things that reach outside" in CLAUDE.md.

import { el } from '../util.ts';

// Wired on first open rather than at init, because the listeners below are two
// clicks on a sheet most sessions never open, and nothing here has to exist
// before it is asked for. The markup does - it is in index.html for the same
// reason #ask's is.
let wired = false;

/** Open the credits sheet. Idempotent; safe without a document. */
export function openCredits() {
  if (typeof document === 'undefined') return;
  const dlg = el('credits');
  if (!dlg || typeof dlg.showModal !== 'function') return;

  if (!wired) {
    // A <dialog> in the top layer fills the screen, so a click that lands on
    // the element itself rather than on anything inside it landed on what is
    // drawn as ::backdrop. Same test dialog.js makes.
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    el('credits-close')?.addEventListener('click', () => dlg.close());
    wired = true;
  }

  if (!dlg.open) dlg.showModal();
}
