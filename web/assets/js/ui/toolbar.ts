// Toolbar: data-cmd dispatch, mobile drawer, and the connector tool's armed
// state. A completed pair disarms (Shift to stay armed). cmds is injected
// because commands.ts imports this module — the arrow may only go one way.

import { el } from '../util.ts';
import { board, bus, isJoinEnd, toggleConnection } from '../state.ts';
import { toast, runCommand } from '../notify.ts';
import { cue } from '../cuelume/engine.ts';
import { setConnectPick } from '../canvas/items.ts';
// Draft line from the picked card — same state as the ring.
import { setDraftFrom } from '../canvas/web.ts';

/** data-cmd="add-files" -> cmds.addFiles. The panel's own mapping. */
const camel = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Command lookup by name — same shape sidebar.ts uses. */
export interface ToolbarCommands {
  [name: string]: ((...args: never[]) => void) | undefined;
}

let bar: HTMLElement | null = null;
let toggle: HTMLElement | null = null;

export function initToolbar(cmds: ToolbarCommands): void {
  bar = el('toolbar');
  toggle = el('toolbar-toggle');

  // Both ids from index.html.
  toggle!.addEventListener('click', () => setOpen(!isOpen()));

  bar!.addEventListener('click', e => {
    const btn = (e.target as Element).closest<HTMLElement>('[data-cmd]');
    if (!btn) return;
    const fn = cmds[camel(btn.dataset.cmd!)];
    if (!fn) return;
    cue('pick');
    runCommand(fn(), btn.getAttribute('aria-label') || (btn.textContent || '').trim() || 'That');
    // more-tools opens a menu hanging off the bar — closing the drawer would orphan it.
    if (btn.dataset.cmd === 'more-tools') return;
    // Close drawer after action. After fn() so arming the connector is not mistaken for disarming.
    setOpen(false);
  });

  // New board or layout change: close drawer and disarm.
  bus.on('board:load', () => { setOpen(false); setArmed(false); });
  bus.on('layout', () => { setOpen(false); setArmed(false); });
  // Items changed — drop pick (cheaper than checking whether it survived).
  bus.on('items', () => setPick(null));
}

export const isOpen = () => !!bar?.classList.contains('is-open');

/** Open/close the mobile drawer. Class + aria-expanded always written together. */
export function setOpen(open: boolean): void {
  if (!bar) return;
  bar.classList.toggle('is-open', !!open);
  toggle!.setAttribute('aria-expanded', String(!!open));
}

/** Escape's half. See cmds.closeSidebar - one key, every sheet that is up, and
 *  the tool put back down. Escape is the way out of a mode; it has to be. */
export const closeToolbar = () => { setOpen(false); setArmed(false); };

// ---------------------------------------------------------------------------
// The connector tool
// ---------------------------------------------------------------------------

/** Whether a press on a card means "connect this" rather than "select this". */
let armed = false;
/** The first end, once one has been chosen. Null between pairs. */
let pick: string | null = null;

/** Result of one connect press. Fields are interdependent — see connectStep(). */
export type ConnectStep = {
  pick: string | null;
  connect: [string, string] | null;
  refused: boolean;
  disarm: boolean;
};

/** Pure state machine for one connect press. Five cases: pick, join, same-card
 * clear, empty-canvas clear, unjoinable refuse. `sticky` = Shift keeps the tool
 * armed after a completed pair. `joinable` false keeps the pick (unlike null id
 * which clears it). */
export function connectStep(
  from: string | null,
  id: string | null,
  joinable = true,
  sticky = false,
): ConnectStep {
  if (!id) return { pick: null, connect: null, refused: false, disarm: false };
  // Unjoinable check before from===id: a sticker cannot have been a valid pick.
  if (!joinable) return { pick: from, connect: null, refused: true, disarm: false };
  if (!from) return { pick: id, connect: null, refused: false, disarm: false };
  if (from === id) return { pick: null, connect: null, refused: false, disarm: false };
  // Completed pair disarms (unless sticky). Works for both make and unmake.
  return { pick: null, connect: [from, id], refused: false, disarm: !sticky };
}

/** Arm/disarm. `from` pre-seeds the pick when arming (selected card). */
export function setArmed(on: boolean, from: string | null = null): void {
  armed = !!on;
  setPick(armed ? from : null);
  bar?.querySelector('[data-cmd="connect"]')?.setAttribute('aria-pressed', String(armed));
  // Board-wide cursor via class on <html>, like data-snap and data-whimsy.
  document.documentElement.classList.toggle('is-connecting', armed);
}

export const connectArmed = () => armed;

function setPick(id: string | null): void {
  pick = id || null;
  setConnectPick(pick);
  setDraftFrom(pick);
}

/** Handle a board press while armed. Returns true if the connector consumed it.
 * `sticky` = Shift held (keeps the tool armed after a pair). */
export function connectTap(id: string | null, sticky = false): boolean {
  if (!armed) return false;
  const next = connectStep(pick, id, !id || canJoin(id), sticky);
  setPick(next.pick);
  if (next.refused) toast('A sticker is already a remark about the card under it');
  if (next.connect) toggleConnection(next.connect[0], next.connect[1]);
  // Disarm after the line is drawn — setArmed clears the pick.
  if (next.disarm) setArmed(false);
  // True even on refusal — the press belongs to the connector, not to selection.
  return true;
}

/** Can a line reach this id? Matches what the draw path in web.ts filters.
 * isRider excluded — sticking is temporary, refusal here would be permanent. */
function canJoin(id: string): boolean {
  return isJoinEnd(board.items.find(i => i.id === id));
}
