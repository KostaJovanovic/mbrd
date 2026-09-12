// Custom title bar for the frameless desktop shell. Two hidden elements in
// index.html — the drag bar and three caption buttons — unhidden when
// platform.frame.own() is true. Controls under the bar stay pressable via
// no-drag on body (see chrome.css). is-framed / is-fullscreen on <html>.

import { el } from '../util.ts';
import { board, bus, isDirty } from '../state.ts';
import { platform } from '../platform/platform.ts';
import { runCommand } from '../notify.ts';

/** data-cmd="window-close" -> cmds.windowClose. The toolbar's own mapping. */
const camel = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Command lookup by name — same shape toolbar.ts uses. */
export interface WindowCommands {
  [name: string]: ((...args: never[]) => void) | undefined;
}

/** Board name + dirty dot, mirroring the OS title. Listens to both board and
 * board:load so renames, dirty-flag flips, and loads all update it. */
function watchTitle(title: HTMLElement): void {
  const paint = (): void => {
    title.textContent = board.title || 'Untitled board';
    title.toggleAttribute('data-dirty', isDirty());
  };
  bus.on('board', paint);
  bus.on('board:load', paint);
  paint();
}

export function initWindowChrome(cmds: WindowCommands): void {
  // Web: return immediately — elements ship hidden in index.html.
  if (!platform.frame.own()) return;

  const root = document.documentElement;
  root.classList.add('is-framed');

  const band = el('window-drag');
  const controls = el('window-controls');
  // Drag band shows on all platforms including macOS.
  band!.hidden = false;
  // macOS already has traffic lights — hide the custom buttons there.
  controls!.hidden = platform.frame.systemLeft();
  // Same corner conflict — hide the mark on macOS too.
  el('window-mark')!.hidden = platform.frame.systemLeft();
  watchTitle(el('window-title')!);

  controls!.addEventListener('click', e => {
    // Delegate: find the nearest [data-cmd] ancestor.
    const btn = (e.target as Element).closest<HTMLElement>('[data-cmd]');
    if (!btn) return;
    const fn = cmds[camel(btn.dataset.cmd!)];
    if (!fn) return;
    // Via runCommand so a thrown error surfaces instead of looking like a dead button.
    runCommand(fn(), btn.getAttribute('aria-label') || 'That');
  });

  // Window state pushed by the shell — renderer must not keep its own tally.
  platform.frame.onState(state => {
    controls!.classList.toggle('is-maximized', !!state.maximized);
    // Full screen hides the bar — the system draws its own way out.
    root.classList.toggle('is-fullscreen', !!state.fullScreen);
  });
}
