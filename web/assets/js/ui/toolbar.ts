// Toolbar: data-cmd dispatch, mobile drawer, the fit to its room (and the
// morph between fits), and the connector tool's armed state. A completed pair
// disarms (Shift to stay armed). cmds is injected because commands.ts imports
// this module — the arrow may only go one way.

import { el, readToken } from '../util.ts';
import { board, bus, isJoinEnd, toggleConnection } from '../state.ts';
import { toast, runCommand } from '../notify.ts';
import { cue } from '../cuelume/engine.ts';
import { setConnectPick } from '../canvas/items.ts';
// Draft line from the picked card — same state as the ring.
import { setDraftFrom } from '../canvas/web.ts';
import { openAnchored } from './menu.ts';
import type { MenuEntry } from './menu.ts';
import { openFlyout } from './flyout.ts';

/** data-cmd="add-files" -> cmds.addFiles. The panel's own mapping. */
const camel = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Command lookup by name — same shape sidebar.ts uses. */
export interface ToolbarCommands {
  [name: string]: ((...args: never[]) => void) | undefined;
}

let bar: HTMLElement | null = null;
let toggle: HTMLElement | null = null;
/** The row of tools inside the bar - what a fit measures and a morph moves. */
let tools: HTMLElement | null = null;

export function initToolbar(cmds: ToolbarCommands): void {
  bar = el('toolbar');
  toggle = el('toolbar-toggle');
  tools = el('toolbar-tools');

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

  // Right-click: a tool with a flyout opens it, at once and without the
  // hover; anywhere else on the bar, every tool as a row, the ones folded
  // behind More included.
  bar!.addEventListener('contextmenu', e => {
    e.preventDefault();
    // SAFETY: as the click listener above.
    const btn = (e.target as Element).closest<HTMLElement>('[data-cmd]');
    if (btn && openFlyout(btn)) return;
    openAnchored({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY },
      toolEntries(), { label: 'Tools' });
  });

  // New board or layout change: close drawer and disarm.
  bus.on('board:load', () => { setOpen(false); setArmed(false); });
  bus.on('layout', () => { setOpen(false); setArmed(false); scheduleFit(); });
  // Items changed — drop pick (cheaper than checking whether it survived).
  bus.on('items', () => setPick(null));

  // The room changes with the window, with a panel opening at either side,
  // and with the look (faces and letter-spacing change the words' width).
  addEventListener('resize', () => { holdStill(); scheduleFit(); });
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

/**
 * The tools as menu rows, read off the bar so a new button is a new row with
 * no edit here. A row presses its button, so it goes through the one dispatch
 * above. More is left out, since its tools are rows already, and so is a tool
 * this layout hides (data-desktop on a phone).
 */
function toolEntries(): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const btn of tools?.querySelectorAll<HTMLButtonElement>('[data-cmd]') ?? []) {
    if (btn.dataset.cmd === 'more-tools' || btn.hidden || btn.disabled) continue;
    if (!btn.hasAttribute('data-more') && getComputedStyle(btn).display === 'none') continue;
    const label = btn.querySelector('span')?.textContent?.trim();
    if (!label) continue;
    const icon = btn.querySelector('use')?.getAttribute('href')?.split('#')[1];
    const pressed = btn.getAttribute('aria-pressed');
    entries.push({
      label,
      icon,
      check: pressed === null ? undefined : pressed === 'true',
      action: () => btn.click(),
    });
  }
  return entries;
}

let relayTimer = 0;
let resizeTimer = 0;

/**
 * The bar's slide (chrome.css) is for a panel coming in at its side. A window
 * being dragged moves the room many times a second, and every move restarted
 * the slide from wherever the last one had got to, so the bar trailed the
 * window and stepped after it. While the window is changing size the bar
 * follows it exactly, and the slide comes back once it has been still a moment.
 */
function holdStill(): void {
  if (!bar) return;
  bar.classList.add('is-resizing');
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => bar?.classList.remove('is-resizing'), 200);
}

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
 * (research/old/done-2026-09-15.md, R11): every tool with its word, then
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
  if (!bar || !tools) return;
  const moving = morphs.some(a => a.playState === 'running');
  if (matchMedia(PHONE).matches) {
    settleFit();
    delete bar.dataset.fit;
    return;
  }
  const was = bar.dataset.fit;
  // Where the bar and its tools are drawn now, a morph still running included -
  // read before the measure below moves anything. Nothing to morph from on the
  // first fit or coming up from the phone. A window being dragged morphs too:
  // the step flips once as the edge crosses it, and every frame after that
  // picks the morph up from the frame on screen (below), so it settles while
  // the bar follows the window rather than trailing after it.
  const from = was ? drawn(bar, tools) : null;
  // At rest, the row's width rather than the bar's: a panel that has just
  // opened has already narrowed max-width, so the bar reads clamped before any
  // frame was drawn that way. Mid-morph, the bar's own width is the frame.
  if (from && !moving) from.width = tools.getBoundingClientRect().width;
  // Stopped before the measure, which has to read the layout, not a morph's frame.
  settleFit();
  const room = parseFloat(getComputedStyle(bar).maxWidth);
  for (const fit of FITS) {
    bar.dataset.fit = fit;
    // The bar clips what does not fit, so its scroll width is what it wants.
    if (!(room > 0) || bar.scrollWidth <= room + 0.5) break;
  }
  // A morph cut short by a fit that lands on the same step carries on from
  // where it was drawn, rather than snapping to its end.
  if (from && (bar.dataset.fit !== was || moving)) morph(bar, tools, from);
}

/** One tool's centre, from the middle of the row, and whether its word shows. */
type Place = { x: number, word: boolean };
/** The bar as drawn at one moment: its width, and where each tool on it sits. */
type Drawn = { width: number, at: Map<HTMLElement, Place> };

/** The pieces of the running morph, so the next fit can stop them before it measures. */
let morphs: Animation[] = [];

function settleFit(): void {
  for (const a of morphs) a.cancel();
  morphs = [];
}

/**
 * Read off the drawn boxes, so a morph mid-flight reads as the frame on screen.
 * Centres are taken from the middle of the row rather than from the window: the
 * bar is centred on a `left` a panel may be sliding, and the row is centred in
 * the bar throughout a morph, so the middle is the one point that holds still.
 */
function drawn(b: HTMLElement, row: HTMLElement): Drawn {
  const box = row.getBoundingClientRect();
  const mid = box.left + box.width / 2;
  const at = new Map<HTMLElement, Place>();
  for (const btn of row.children) {
    // A tool the step hides (display: none) has no place to come from or go to.
    if (!(btn instanceof HTMLElement) || !btn.getClientRects().length) continue;
    const r = btn.getBoundingClientRect();
    const word = btn.querySelector('span');
    at.set(btn, { x: r.left + r.width / 2 - mid, word: !!word?.getClientRects().length });
  }
  return { width: b.getBoundingClientRect().width, at };
}

/** --dur-base in ms, or 0 where Animations are off (the quality dial writes 0.01ms). */
function baseMs(): number {
  const raw = readToken('--dur-base');
  const n = parseFloat(raw) || 0;
  const ms = raw.endsWith('ms') ? n : n * 1000;
  return ms >= 1 ? ms : 0;
}

/**
 * The step between two fits, drawn rather than cut. The bar's width runs from
 * what was drawn to what fits, on the tier's own --dur-base and --ease - the
 * pair its `left` slides on (chrome.css), so a panel opening moves and narrows
 * the bar as one motion: long and soft at Softish, brisk at the middle, and at
 * Harsh a plain ease over a sixth of a second. Each tool glides from where it
 * was; a word coming back, or More, fades in behind the movement rather than
 * landing on it. A word going leaves at once - it has no box left to fade.
 *
 * Width rather than a transform, because the pill cannot take one: scaleX
 * would drag its corners, seams and ring (#zoom-ctl scales glyphs, not
 * buttons, for the same reason), and the bar already lays out on every frame
 * of its `left` slide. max-width and justify-content ride in the same
 * keyframes, so they are the morph's for exactly as long as it runs: the wider
 * end is drawn whole, and the row stays centred in a bar narrower or wider
 * than it.
 *
 * Reduced motion keeps the fades and drops the movement. Animations off on the
 * quality dial plays nothing.
 */
function morph(b: HTMLElement, row: HTMLElement, from: Drawn): void {
  const ms = baseMs();
  if (!ms) return;
  const to = drawn(b, row);
  // Not even the last step fits: the row is clipped at rest, and a morph that
  // centred it would jump back at the end.
  if (row.getBoundingClientRect().width > to.width + 0.5) return;
  const opts: KeyframeAnimationOptions = { duration: ms, easing: readToken('--ease') || 'ease' };
  const run = (target: Element, frames: Keyframe[]) => { morphs.push(target.animate(frames, opts)); };
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    if (Math.abs(to.width - from.width) > 0.5) {
      const held = { maxWidth: 'none', justifyContent: 'center' };
      run(b, [{ width: `${from.width}px`, ...held }, { width: `${to.width}px`, ...held }]);
    }
    for (const [btn, { x }] of to.at) {
      const was = from.at.get(btn);
      if (was && Math.abs(was.x - x) > 0.5) run(btn, [{ translate: `${was.x - x}px 0` }, { translate: '0 0' }]);
    }
  }
  for (const [btn, { word }] of to.at) {
    const was = from.at.get(btn);
    const arriving = !was ? btn : word && !was.word ? btn.querySelector('span') : null;
    if (arriving) run(arriving, [{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }]);
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
