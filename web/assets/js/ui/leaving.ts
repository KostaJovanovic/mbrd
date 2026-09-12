// A confirmation before any external link leaves the board. Every http(s) link
// on the platform - a link card, a Feed tile, a rendered markdown link, a credit
// in the About sheet - passes through here first, so a click never navigates
// away from mbrd without a say. Same-origin links (in-page routing, #anchors)
// pass straight through: this is about leaving, not moving inside the board.
//
// Two doors. Anchors are caught board-wide by a capture-phase listener, so no
// call site needs changing. Anything that opens a link in script instead of a
// real <a> (the Feed tile's window.open) calls openExternal() directly.

import { ask } from './dialog.ts';

/**
 * Confirm, then open a URL in a new tab. The one programmatic exit for an
 * external link. A bad URL, or a decline, opens nothing.
 */
export async function openExternal(url: string): Promise<void> {
  let host: string;
  try { host = new URL(url).host.replace(/^www\./, ''); } catch { return; }
  const answer = await ask({
    title: 'Leave mbrd?',
    body: `This opens ${host} in a new tab.`,
    go: 'Open link', cancel: 'Stay',
    // Not danger-styled: leaving is ordinary, not destructive.
    danger: false,
  });
  if (answer === 'go') window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Whether a click on an anchor is one we intercept: an external http(s) address,
 * not being edited in place. Same-origin and non-web schemes (mailto:, tel:) are
 * left to the browser.
 */
function externalHref(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const a = target.closest('a[href]');
  if (!(a instanceof HTMLAnchorElement)) return null;
  // A link name being renamed in place is a caret target, not a destination.
  if (a.closest('.is-editing')) return null;
  let u: URL;
  try { u = new URL(a.href); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.host === location.host) return null;
  return u.href;
}

/**
 * Intercept every click on an external link, board-wide. Capture phase, so it
 * runs before the anchor's own handler and before the browser navigates: it
 * cancels the default and routes through openExternal instead. Middle-click
 * (auxclick) too, which would otherwise open a background tab past the prompt.
 * Added once, from main.ts.
 */
export function initLeaveGuard(): void {
  const guard = (e: MouseEvent) => {
    // Left or middle press only; a right-click is the menu, not a follow.
    if (e.button !== 0 && e.button !== 1) return;
    if (e.defaultPrevented) return;
    const href = externalHref(e.target);
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    openExternal(href);
  };
  document.addEventListener('click', guard, true);
  document.addEventListener('auxclick', guard, true);
}
