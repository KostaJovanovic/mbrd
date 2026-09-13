// Badge for joins that cannot be drawn. When the router cannot connect two cards
// without crossing a third, no line is drawn (see Seg.blocked in canvas/web.ts);
// instead one badge — at most — appears on the card caught in the most failed
// joins. Clicking it lists the pairs that cannot be joined; clicking an entry
// frames that pair. Mirrors ui/conn-chip.ts: a body-level node positioned from
// vp.toScreen, rebuilt only when the blocked set changes, repositioned on view move.

import { byId, select } from '../state.ts';
import { openAnchored } from './menu.ts';
import { onBlockedJoinsChange, blockedJoins } from '../canvas/web.ts';
import type { BlockedJoin } from '../canvas/web.ts';
import type { Box } from '../geometry.ts';
import { travelMs } from '../canvas/viewport.ts';
import type { Viewport } from '../canvas/viewport.ts';

let vp: Viewport | null = null;
let node: HTMLButtonElement | null = null;
/** The badge's own size, measured once per build — see place(). */
let size = { w: 0, h: 0 };
/** What the badge is drawn for: the anchor card and the pairs it lists. */
let sig = '';

export function initJoinBadge(viewport: Viewport | null): void {
  vp = viewport;
  // Two sources, both needed: the blocked set changes on a reroute, and a pan or
  // zoom moves the anchor card under a badge whose data did not change.
  onBlockedJoinsChange(syncJoinBadge);
  vp?.onChange(syncJoinBadge);
  addEventListener('resize', syncJoinBadge);
}

/** Card name for the list, matching the tour's convention. */
function nameOf(id: string): string {
  return (byId(id)?.name || '').trim() || 'Untitled';
}

/** The card to badge and the pairs to list, or null when nothing is blocked. */
function pick(pairs: BlockedJoin[]): { anchor: string, pairs: BlockedJoin[] } | null {
  const live = pairs.filter(p => byId(p.a) && byId(p.b));
  if (!live.length) return null;
  // The card in the most failed joins wears the one badge.
  const count = new Map<string, number>();
  for (const p of live) {
    count.set(p.a, (count.get(p.a) || 0) + 1);
    count.set(p.b, (count.get(p.b) || 0) + 1);
  }
  let anchor = live[0].a, best = -1;
  for (const [id, n] of count) if (n > best) { best = n; anchor = id; }
  return { anchor, pairs: live };
}

/** Show, move or hide the badge from what the board currently says. Total, and a
 *  cheap return when nothing is blocked — every event above points straight at it. */
export function syncJoinBadge(): void {
  if (!vp) return;
  const picked = pick(blockedJoins());
  if (!picked) { closeJoinBadge(); return; }
  const next = picked.anchor + '\0' + picked.pairs.map(p => p.a + '>' + p.b).join('\0');
  if (next !== sig) { build(picked.anchor, picked.pairs); sig = next; }
  place(picked.anchor);
}

/** Take the badge away. Nothing to remember: the next one is built from the board. */
function closeJoinBadge(): void {
  node?.remove();
  node = null;
  sig = '';
}

function build(anchor: string, pairs: BlockedJoin[]): void {
  node?.remove();
  const el = document.createElement('button');
  el.id = 'join-badge';
  el.type = 'button';
  const many = pairs.length > 1;
  const msg = many ? `${pairs.length} joins could not be made` : 'A join could not be made';
  el.setAttribute('aria-label', msg);
  el.title = msg;
  // A "?" mark, the corner icon the spec asked for — no glyph in icons.svg fits.
  el.textContent = '?';
  el.addEventListener('click', () => openList(el, pairs));
  document.body.append(el);
  node = el;
  // Measured once, hidden, so place() never forces layout mid-pan (as conn-chip does).
  size = { w: el.offsetWidth, h: el.offsetHeight };
}

/** The popup: one entry per pair, framing both cards when chosen. */
function openList(el: HTMLElement, pairs: BlockedJoin[]): void {
  const entries = pairs.map(p => ({
    label: `${nameOf(p.a)} ↔ ${nameOf(p.b)}`,
    icon: 'i-fit-card',
    action: () => frame(p.a, p.b),
  }));
  openAnchored(el.getBoundingClientRect(), entries, {
    label: 'Cards that cannot be joined', owner: el, focus: true,
  });
}

/** Select the pair and pan/zoom so both cards that could not be joined are in view. */
function frame(a: string, b: string): void {
  if (!vp) return;
  const items: Box[] = [];
  const ids: string[] = [];
  for (const id of [a, b]) {
    const it = byId(id);
    if (it) { items.push(it); ids.push(id); }
  }
  if (!items.length) return;
  select(ids);
  vp.fit(items, 120, travelMs());
}

/** Pin the badge just outside the anchor card's top-right corner; hide it off-screen. */
function place(anchor: string): void {
  if (!node || !vp) return;
  const item = byId(anchor);
  if (!item) { node.hidden = true; return; }
  // item.x/y is the card centre in world (y-up); the top-right corner is +half each.
  const at = vp.toScreen(item.x + item.w / 2, item.y + item.h / 2);
  const off = at.x < -40 || at.y < -40 || at.x > innerWidth + 40 || at.y > innerHeight + 40;
  node.hidden = off;
  if (off) return;
  node.style.left = (at.x - size.w / 2) + 'px';
  node.style.top = (at.y - size.h / 2) + 'px';
}
