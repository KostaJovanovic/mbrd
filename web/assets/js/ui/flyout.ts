// Toolbar hover flyouts. Dwell on Arrange/Note/Colour to see choices; the
// click is untouched (still the default action). Uses openAnchored() from
// menu.ts for placement and interaction. Touch excluded per event (pointerType),
// not per device — (hover:hover) was wrong for tablet-mode laptops.

import { openAnchored, close, setMenuCloseHook } from './menu.ts';
import type { MenuEntry } from './menu.ts';
import { el } from '../util.ts';
import { ARRANGEMENTS } from '../arrange/arrangements.ts';
import { NOTE_TINTS } from '../import/drop.ts';
import { swatchHex } from '../canvas/renderers.ts';

/** Hover dwell before opening. Prevents accidental opens while crossing the bar. */
const DWELL = 180;

/** Grace period after leaving — longer than dwell so clipping a corner does not close. */
const LINGER = 250;

/** Command surface for the three flyout builders. Own type (not imported from
 * commands.ts) because commands.ts imports this module. */
export interface FlyoutCommands {
  arrangement: () => string;
  arrangeAs: (id: string) => void;
  hasSelection: () => boolean;
  rearrangeSelection: () => void;
  nudgeBoard: () => void;
  nudgeSelection: () => void;
  joinableSelected: () => number;
  selectionLineCount: () => number;
  connectionCount: () => number;
  connectSelection: () => void;
  joinEverything: () => void;
  removeSelectionConnections: () => void;
  clearConnections: () => void;
  settingNumber: (key: string) => number | undefined;
  setSetting: (key: string, value: unknown) => void;
  addNote: (tint: number) => void;
  addSwatch: () => void;
  addSwatchOf: (hex: string) => void;
}

let cmds: FlyoutCommands | null = null;
let bar: HTMLElement | null = null;
/** The button whose flyout is up, or null. */
let openFor: HTMLElement | null = null;
let openTimer = 0;
let closeTimer = 0;

/** data-cmd → entry builder. Builders are pure (take cmds) for testability. */
export const FLYOUTS: Record<string, (cmds: FlyoutCommands) => MenuEntry[]> = {
  rearrange: arrangeEntries,
  'add-note': noteEntries,
  'add-swatch': colourEntries,
  connect: joinEntries,
};

export function initFlyouts(commands: FlyoutCommands) {
  cmds = commands;
  bar = el('toolbar');
  if (!bar) return;

  // Mark flyout buttons for a11y. Driven by FLYOUTS so a new entry needs no markup change.
  for (const cmd of Object.keys(FLYOUTS)) {
    const btn = bar.querySelector(`[data-cmd="${cmd}"]`);
    btn?.setAttribute('aria-haspopup', 'menu');
    btn?.setAttribute('aria-expanded', 'false');
  }

  // Menu can close externally — keep aria-expanded in sync.
  setMenuCloseHook(() => {
    openFor?.setAttribute('aria-expanded', 'false');
    openFor = null;
  });

  // ArrowDown opens with focus (standard menu-button pattern).
  bar.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown') return;
    // SAFETY: the listener is on #toolbar, so the target is a node in it. closest?.() skips a non-Element.
    const btn = (e.target as Element).closest?.<HTMLElement>('[data-cmd]');
    if (!btn || !FLYOUTS[btn.dataset.cmd!]) return;
    e.preventDefault();
    open(btn, true);
  });

  // One window-level pointerover (bubbles, unlike pointerenter) — checks both bar and panel.
  addEventListener('pointerover', onOver);
  // Pointer leaving the window entirely — no over fires, so close on leave.
  // An out with nowhere to go is that leave: pointerleave does not bubble and
  // never reaches window. Not touch, whose every lift is an out to nowhere.
  document.addEventListener('pointerout', e => {
    if (!e.relatedTarget && e.pointerType !== 'touch' && openFor) later();
  });
}

function onOver(e: PointerEvent) {
  // Per-gesture touch exclusion.
  if (e.pointerType === 'touch') return;

  // Inside the panel or a submenu (sibling #ctx-child, not descendant) — hold it open.
  // SAFETY: closest?.() is an optional call, so a target that is not an Element reads as a miss.
  if ((e.target as Element).closest?.('#ctx-menu, #ctx-child')) { hold(); return; }

  // SAFETY: as above.
  const btn = (e.target as Element).closest?.<HTMLElement>('#toolbar [data-cmd]');
  if (btn && FLYOUTS[btn.dataset.cmd!]) {
    hold();
    if (btn === openFor) return;
    // Already open bar → swap at once (no dwell, no entrance).
    open(btn, false, openFor ? 0 : DWELL, !!openFor);
    return;
  }

  // Elsewhere — close after grace period.
  clearTimeout(openTimer);
  openTimer = 0;
  if (openFor) later();
}

/** Cancel a pending close - the pointer is somewhere that keeps the panel. */
function hold() {
  clearTimeout(closeTimer);
  closeTimer = 0;
}

/** Start the grace period. Idempotent: an already-running one is left alone. */
function later() {
  if (closeTimer) return;
  closeTimer = setTimeout(() => { closeTimer = 0; close(); }, LINGER);
}

/**
 * Open a tool's flyout at once and focused, for a right-click (ui/toolbar.ts).
 * False for a tool with none, or before initFlyouts().
 */
export function openFlyout(btn: HTMLElement): boolean {
  if (!cmds || !bar || !btn.dataset.cmd || !FLYOUTS[btn.dataset.cmd]) return false;
  hold();
  open(btn, true);
  return true;
}

/** Open a flyout. delay=0 for keyboard/swap, DWELL for first hover; instant
 *  for a swap, since one panel replacing another has nothing to arrive from. */
function open(btn: HTMLElement, focus: boolean, delay = 0, instant = false) {
  clearTimeout(openTimer);
  if (delay) {
    openTimer = setTimeout(() => open(btn, focus), delay);
    return;
  }
  openTimer = 0;

  // Bar edge (not button edge) — avoids a 1px dead zone from the hairline.
  const box = btn.getBoundingClientRect();
  const barBox = bar!.getBoundingClientRect();
  // top: button's (needed for above-flip). bottom: bar's (avoids hairline gap).
  // bounds: bar edges (clamp panel within bar). left/right: button's (for origin).
  const rect = {
    left: box.left,
    right: box.right,
    top: box.top,
    bottom: barBox.bottom,
    bounds: { left: barBox.left, right: barBox.right },
  };
  const label = btn.querySelector('span')?.textContent?.trim() || 'Menu';
  openAnchored(rect, FLYOUTS[btn.dataset.cmd!](cmds!), { label, focus, instant });
  openFor = btn;
  btn.setAttribute('aria-expanded', 'true');
}

// ---------------------------------------------------------------------------
// The three lists
// ---------------------------------------------------------------------------

/**
 * The Join tool's one-shot rows, beside the tool itself (a press still arms
 * it): the spanning tree over the selection or the board, and the two ways to
 * take lines away. Each row only when it has something to act on.
 */
function joinEntries(cmds: FlyoutCommands): MenuEntry[] {
  const picked = cmds.joinableSelected();
  const lines = cmds.selectionLineCount();
  const all = cmds.connectionCount();
  return [
    { label: `Join the ${picked} selected`, icon: 'i-connect', hidden: picked < 2,
      action: () => cmds.connectSelection() },
    { label: 'Join everything', icon: 'i-connect', action: () => cmds.joinEverything() },
    { sep: true, hidden: !all },
    { label: lines === 1 ? 'Remove 1 connection' : `Remove ${lines} connections`, icon: 'i-delete',
      hidden: !lines, action: () => cmds.removeSelectionConnections() },
    { label: 'Remove all connections', icon: 'i-delete', hidden: !all,
      action: () => cmds.clearConnections() },
  ];
}

/** Layout choices from ARRANGEMENTS, plus spacing slider. Desktop only (Arrange is data-desktop). */
export function arrangeEntries(cmds: FlyoutCommands) {
  const now = cmds.arrangement();
  return [
    ...ARRANGEMENTS.map(a => ({
      label: a.label,
      icon: 'i-rearrange',
      check: now === a.id,
      action: () => cmds.arrangeAs(a.id),
    })),
    { sep: true },
    // Hidden when no selection — menu fits what you are holding.
    { label: 'Rearrange selection', icon: 'i-select-all',
      hidden: !cmds.hasSelection(), action: () => cmds.rearrangeSelection() },
    // Overlaps pushed apart, the layout kept - the gentler of the two.
    { label: 'Nudge board', icon: 'i-nudge', action: () => cmds.nudgeBoard() },
    { label: 'Nudge selection', icon: 'i-nudge',
      hidden: !cmds.hasSelection(), action: () => cmds.nudgeSelection() },
    // The gap the layouts pack at. Live, and it does not lay the board out on
    // its own - Desktop's spacing is a rule the next Rearrange uses, which is
    // what the panel's own hint says - so moving it and then picking a layout
    // is the order this is meant to be used in.
    { label: 'Spacing',
      range: {
        min: 0, max: 200, step: 4, unit: 'px',
        get: () => cmds.settingNumber('spacing') ?? 0,
        set: (v: number) => cmds.setSetting('spacing', v),
      } },
  ];
}

/**
 * The pad, as four sheets you can take one off.
 *
 * Named for the pigment each is mixed from rather than for the colour it comes
 * out as, and that is the same decision tokens.css made one layer down: a note
 * is `color-mix(--accent-warm 34%, --paper-card)`, so on a board that has taken
 * its palette from its photographs the first sheet is not yellow and calling it
 * Yellow would be this menu describing a board that is not on the screen. The
 * chip beside each row is the actual colour, drawn from the same token, so the
 * naming carries none of the weight.
 */
export function noteEntries(cmds: FlyoutCommands) {
  const NAMES = ['Warm', 'Accent', 'Green', 'Pale'];
  return Array.from({ length: NOTE_TINTS }, (_, i) => ({
    label: NAMES[i] || `Sheet ${i + 1}`,
    swatch: `var(--note-${i + 1})`,
    action: () => cmds.addNote(i + 1),
  }));
}

/**
 * The board's own pigments, as swatch cards - and the picker, still.
 *
 * The same five the connection palette offers (connectionColorEntries in
 * ui/menu.ts) and the same words for them, because they are the same five
 * colours and a board should not have two vocabularies for its own paint. What
 * makes this worth having over the picker is that these follow the board: on
 * one that has coloured itself from its pictures, these are that board's
 * colours, and dropping one next to the pictures it came from is a swatch that
 * means something.
 */
const PIGMENTS = [
  ['--accent', 'Accent'],
  ['--accent-warm', 'Warm'],
  ['--accent-deep', 'Deep'],
  ['--leafy', 'Green'],
  ['--ink', 'Ink'],
];

export function colourEntries(cmds: FlyoutCommands) {
  return [
    ...PIGMENTS.map(([token, label]) => ({
      label,
      swatch: `var(${token})`,
      action: () => cmds.addSwatchOf(tokenHex(token)),
    })),
    { sep: true },
    { label: 'Pick a colour...', icon: 'i-swatch', action: () => cmds.addSwatch() },
  ];
}

/**
 * A custom property, as the `#rrggbb` a swatch card stores.
 *
 * Through a probe element rather than getPropertyValue, and that is the whole
 * reason this function exists: reading the property back gives its *specified*
 * text, so a token written as `color-mix(in srgb, ...)` - which several of
 * these are, on several of the themes - comes out as that string and is not a
 * colour anything can store. Painting it and reading `color` makes the engine
 * do the resolving, which is the same trick boardInk() uses in canvas/model.ts.
 *
 * swatchHex() has the last word, so anything that still fails to resolve lands
 * on SWATCH_DEFAULT rather than writing nonsense into a board file.
 */
function tokenHex(token: string) {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:fixed;left:-9999px;width:0;height:0';
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return computedHex(color);
}

/**
 * A computed `color` as `#rrggbb`. `rgb()` channels run 0-255, but a token
 * mixed `in srgb` computes to `color(srgb r g b)` with channels 0-1, which
 * read as 0-255 made the Harsh "Ink" swatch black. Any other space is left to
 * swatchHex(), which answers SWATCH_DEFAULT.
 */
export function computedHex(color: string) {
  const srgb = /^color\(\s*srgb\s/i.test(color);
  if (!srgb && !/^rgba?\(/i.test(color)) return swatchHex(color);
  const m = color.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi);
  if (!m || m.length < 3) return swatchHex(color);
  const scale = srgb ? 255 : 1;
  const hex = m.slice(0, 3)
    .map(n => Math.max(0, Math.min(255, Math.round(Number(n) * scale))).toString(16).padStart(2, '0'))
    .join('');
  return swatchHex('#' + hex);
}
