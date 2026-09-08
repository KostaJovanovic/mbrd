// A stack of the exclusive right-side panels, so they hide and come back rather
// than replacing each other.
//
// The header edit bar and the sticker drawer dock on the same right edge and
// only one can hold it. Opening the second hides the first; closing it brings
// the first back where it was - the one underneath is waiting, not gone.
//
// Those two are the whole membership: registerPanel() is called once each, in
// ui/mobile-header.ts and ui/sticker-window.ts. The Playlist player left when it
// stopped being docked - a Desktop window, a Mobile lens, neither taking the
// right edge - and ui/playlist.ts imports resetPanels() alone.
//
// It owns no DOM. Each panel registers open and close and reports when it
// becomes visible or closes; that keeps the stack and the screen in step. A
// `busy` guard stops the echo: a panel the coordinator closed to make way for
// another still reports "I closed", which is the coordinator's doing, not a
// user action.

/** What one panel has to be able to do to take part. */
interface PanelDriver {
  open: () => void;
  close: () => void;
}

/** name -> { open, close } */
const reg = new Map<string, PanelDriver>();
/** Open panels, oldest first; the last is the one on screen. */
const stack: string[] = [];
/** True while the coordinator is itself opening or closing a panel. */
let busy = false;

/** Teach the stack how to drive one panel. Called once, at the panel's init. */
export function registerPanel(name: string, open: () => void, close: () => void): void {
  reg.set(name, { open, close });
}

/**
 * A panel became visible. Hide whoever was on screen (remembering it) and put
 * this one on top. A no-op when this panel is already top - reopening the
 * visible one must not hide it from itself.
 */
export function panelShown(name: string): void {
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
export function panelHidden(name: string): void {
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
export function resetPanels(): void {
  stack.length = 0;
}
