// A stack of the exclusive right-side panels, so they hide and come back rather
// than just replacing each other.
//
// The Playlist player and the header edit bar dock on the same right edge and only
// one can hold it. Opening the second hides the first; closing the second brings
// the first back exactly where it was. That "come back" is the difference between
// this and a plain close-on-open: the panels form a stack, and the one underneath
// is waiting, not gone.
//
// It owns no DOM. Each panel registers how to open and close itself and reports
// when it has become visible or has closed; this drives those two callbacks to keep
// the stack and the screen in step. A `busy` guard stops the echo - when the
// coordinator closes one panel to make way for another, that panel's own "I closed"
// report is the coordinator's doing, not a user action, so it is ignored.

/** name -> { open, close } */
const reg = new Map();
/** The panels currently open, oldest first; the last is the one on screen. */
const stack = [];
/** True while the coordinator is itself opening or closing a panel. */
let busy = false;

/** Teach the stack how to drive one panel. Called once, at the panel's init. */
export function registerPanel(name, open, close) {
  reg.set(name, { open, close });
}

/**
 * A panel has just become visible. Hide whoever was on screen (remembering it) and
 * put this one on top. A no-op when this panel is already the top - reopening the
 * visible one must not hide it from itself.
 */
export function panelShown(name) {
  if (busy) return;
  const top = stack[stack.length - 1];
  if (top === name) return;
  if (top) { busy = true; reg.get(top)?.close(); busy = false; }
  const j = stack.indexOf(name);
  if (j >= 0) stack.splice(j, 1);
  stack.push(name);
}

/**
 * A panel has closed. Drop it from the stack, and if it was the one on screen, bring
 * back the one that was under it. A panel closed while already hidden (it was not the
 * top) just leaves the stack quietly.
 */
export function panelHidden(name) {
  if (busy) return;
  const i = stack.lastIndexOf(name);
  if (i < 0) return;
  const wasTop = i === stack.length - 1;
  stack.splice(i, 1);
  if (!wasTop) return;
  const top = stack[stack.length - 1];
  if (top) { busy = true; reg.get(top)?.open(); busy = false; }
}

/** Forget everything is open - for a board swap, where every panel is torn down. */
export function resetPanels() {
  stack.length = 0;
}
