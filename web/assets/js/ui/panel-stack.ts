// Exclusive right-side panel stack. Header edit bar and sticker drawer
// share one edge; opening one hides the other, closing it restores.
// Owns no DOM — each panel registers open/close callbacks. The `busy`
// guard prevents echo when the coordinator itself closes a panel.

/** A panel's open/close callbacks. */
interface PanelDriver {
  open: () => void;
  close: () => void;
}

/** name → { open, close } */
const reg = new Map<string, PanelDriver>();
/** Open panels, oldest first; the last is the one on screen. */
const stack: string[] = [];
/** True while the coordinator is itself opening or closing a panel. */
let busy = false;

/** Register one panel. Called once at init. */
export function registerPanel(name: string, open: () => void, close: () => void): void {
  reg.set(name, { open, close });
}

/** A panel appeared. Hides the current top (remembering it) and pushes this one. */
export function panelShown(name: string): void {
  if (busy) return;
  const top = stack[stack.length - 1];
  if (top === name) return;
  if (top) { busy = true; reg.get(top)?.close(); busy = false; }
  const j = stack.indexOf(name);
  if (j >= 0) stack.splice(j, 1);
  stack.push(name);
}

/** A panel closed. Restores the one beneath it if it was on top. */
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

/** Clear the stack on board swap. */
export function resetPanels(): void {
  stack.length = 0;
}
