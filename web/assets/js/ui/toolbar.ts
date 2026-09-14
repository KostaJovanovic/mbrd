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
    // SAFETY: the listener is on #toolbar, and a click is dispatched at an element under it.
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
  bus.on('layout', () => { setOpen(false); setArmed(false); scheduleFit(); });
  // Items changed — drop pick (cheaper than checking whether it survived).
  bus.on('items', () => setPick(null));

  // The room changes with the window, with a panel opening at either side,
  // and with the look (faces and letter-spacing change the words' width).
  addEventListener('resize', scheduleFit);
  const panels = new MutationObserver(scheduleFit);
  for (const id of ['sidebar', 'header-panel']) {
    const panel = document.getElementById(id);
    if (panel) panels.observe(panel, { attributes: true, attributeFilter: ['class'] });
  }
  bus.on('settings', scheduleFit);
  document.fonts?.ready?.then(scheduleFit).catch(() => {});
  scheduleFit();

  // Crossing the phone width moves the bar between the top and the foot.
  // Set in the change event, which runs before that frame's style, so the
  // slide never starts; the fade in chrome.css runs instead.
  matchMedia(PHONE).addEventListener('change', relay);
  bar!.addEventListener('animationend', e => {
    if (e.animationName === 'toolbar-relaid') bar!.classList.remove('is-relaid');
  });
}

let relayTimer = 0;

function relay(): void {
  if (!bar) return;
  bar.classList.add('is-relaid');
  // Also on a timer: where animations are off, animationend never comes, and
  // the class left on would switch the panel slide off for good.
  clearTimeout(relayTimer);
  relayTimer = setTimeout(() => bar?.classList.remove('is-relaid'), 1000);
}

// ---------------------------------------------------------------------------
// Fitting the room
// ---------------------------------------------------------------------------

/**
 * How much of the bar fits the room it is centred in, above phone width
 * (research/rapid-fixes-2026-09-14.md, R11): every tool with its word, then
 * icons only, then Colour, Link and Stickers behind More. A measure rather
 * than a breakpoint: the room moves with the window and with a panel at
 * either side, and a width written against today's tools is wrong the next
 * time one is added. The room is the bar's max-width (chrome.css).
 */
const FITS = ['full', 'icons', 'more'];
/** The phone's layout, where the bar is the Add handle at the foot instead. */
const PHONE = '(max-width: 700px)';

let fitFrame = 0;

function scheduleFit(): void {
  if (fitFrame || typeof requestAnimationFrame !== 'function') return;
  fitFrame = requestAnimationFrame(() => { fitFrame = 0; fitBar(); });
}

function fitBar(): void {
  if (!bar) return;
  if (matchMedia(PHONE).matches) {
    delete bar.dataset.fit;
    return;
  }
  const room = parseFloat(getComputedStyle(bar).maxWidth);
  for (const fit of FITS) {
    bar.dataset.fit = fit;
    // The bar clips what does not fit, so its scroll width is what it wants.
    if (!(room > 0) || bar.scrollWidth <= room + 0.5) return;
  }
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
export const isArmed = () => armed;
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
