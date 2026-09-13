// An Electron accelerator string as a person reads it, for the menu panel.
// Split before the names are mapped, so 'CmdOrCtrl+Plus' keeps its plus sign:
// FileAnalyser's accel.js swaps Plus for '+' first and then splits it away.

/** macOS writes modifiers as symbols with nothing between them. */
const MAC_KEYS: Record<string, string> = {
  Cmd: '⌘', Command: '⌘', Ctrl: '⌃', Control: '⌃',
  Alt: '⌥', Option: '⌥', Shift: '⇧',
};

/** 'CmdOrCtrl+Shift+S' -> 'Ctrl+Shift+S', or on macOS the symbols run together. */
export function accelLabel(accel: string, isMac: boolean): string {
  if (!accel) return '';
  const parts = accel.split('+').map(part => {
    if (part === 'CmdOrCtrl' || part === 'CommandOrControl') return isMac ? 'Cmd' : 'Ctrl';
    if (part === 'Plus') return '+';
    return part;
  });
  return isMac ? parts.map(part => MAC_KEYS[part] ?? part).join('') : parts.join('+');
}
