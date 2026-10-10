// The S box: every command in the app, searched by name where the pointer is,
// as Fusion's S key does. Built fresh on each open from the places the app
// already lists what it can do - the right-click menus (so the selection's own
// rows lead, and a row its menu would hide is absent), the toolbar with its
// flyouts, the sidebar's schema and what is built into its slots, the buttons
// on screen, and APP below for the few commands only a key or the desktop's
// menu bar reached. Drawn by ui/menu.ts, ranked by ui/palette-match.ts. No
// document reach at import.

import { board, selection } from '../state.ts';
import { runCommand } from '../notify.ts';
import { isDesktop } from '../platform/platform.ts';
import { contextEntries, openSearchMenu } from './menu.ts';
import type { MenuEntry, MenuCommands } from './menu.ts';
import { FLYOUTS } from './flyout.ts';
import type { FlyoutCommands } from './flyout.ts';
import { MORE_TOOLS } from './toolbar.ts';
import { SECTIONS, TABS, sectionVisible, controlVisible } from './settings-schema.ts';
import type { ButtonSpec, Control, Ctx, PickerControl, RangeControl } from './settings-schema.ts';
import { open as openSidebar } from './sidebar.ts';
import { revealControl } from './panel.ts';
import { dedupe, flatten, parsePoint, rank, rowKey } from './palette-match.ts';
import type { Row } from './palette-match.ts';

/** Void as ToolbarCommands has it: a command may hand back a promise, which runCommand() reads. */
type Fn = (...args: never[]) => void;
/** The command table: the two menus' interfaces, and every other entry by name. */
type PaletteCommands =MenuCommands & FlyoutCommands & {
  [name: string]: Fn | undefined,
  moveTo?: (x?: number, y?: number) => void,
};

let cmds: PaletteCommands | null = null;

/** Called once by main.ts. Before it the S key opens nothing. */
export function initPalette(commands: PaletteCommands) { cmds = commands; }

/**
 * How near each source is to what is in hand. The selection's rows outrank an
 * equal match on the board's, the board's the tools', and the settings come
 * last: they are the most rows and the least often the answer.
 */
const W = { selection: 3, here: 2, screen: 1.5, tools: 1.5, app: 1.2, settings: 1 };

/** Rows drawn at once. The box is for finding one thing, so it shows the best few. */
const SHOWN = 10;

/** Open the box at a point in the window: the pointer, or the middle of the board. */
export function openPalette(clientX: number, clientY: number) {
  if (!cmds) return;
  const rows = dedupe(gather(clientX, clientY));
  const before = recent();
  openSearchMenu(clientX, clientY, query => {
    const found = rank(rows, query, before, SHOWN).map(shown);
    const at = board.layoutMode === 'mobile' ? null : parsePoint(query);
    return at ? [moveRow(at), ...found.slice(0, SHOWN - 1)] : found;
  }, { label: 'Every command', placeholder: 'Search every command' });
}

/** Two numbers typed are a point, and the first row goes there. */
function moveRow(at: { x: number, y: number }): MenuEntry {
  return {
    label: `Move to ${at.x}, ${at.y}`, icon: 'i-move', hint: 'View',
    action: () => runCommand(cmds!.moveTo?.(at.x, at.y), 'Move'),
  };
}

/** A row as the menu draws it: where it lives under its name, and remembered when used. */
function shown(row: Row): MenuEntry {
  const { action } = row.entry;
  return {
    ...row.entry,
    hint: row.path.join(' › '),
    action: action && (() => { remember(row.key); action(); }),
  };
}

// ---------------------------------------------------------------------------
// What was used last
// ---------------------------------------------------------------------------

/**
 * This session's, held in memory and never stored: a reload starts the list
 * empty. What was used an hour ago in another sitting is not what is in hand.
 */
const RECENT_MAX = 8;
let used: string[] = [];

const recent = () => used;

function remember(key: string) {
  used = [key, ...used.filter(k => k !== key)].slice(0, RECENT_MAX);
}

// ---------------------------------------------------------------------------
// Where the rows come from
// ---------------------------------------------------------------------------

function gather(x: number, y: number): Row[] {
  const mobile = board.layoutMode === 'mobile';
  const picked = [...selection];
  const marked = cmds!.activeConnection?.();
  const menus = contextEntries(x, y, picked[0] ?? null, picked.length,
    { mobile, line: isLine(marked) ? marked : null });
  return [
    ...flatten(menus.selection, [picked.length > 1 ? `${picked.length} selected` : 'Selection'], W.selection),
    ...flatten(menus.here, [mobile ? 'Feed' : 'Board'], W.here),
    ...toolRows(),
    ...screenRows(),
    ...appRows(),
    ...settingRows({ mobile, patch: false }),
  ];
}

const isLine = (v: unknown): v is { a: string, b: string } =>
  typeof v === 'object' && v !== null && 'a' in v && typeof v.a === 'string'
  && 'b' in v && typeof v.b === 'string';

const row = (entry: MenuEntry, path: string[], weight: number, choice = false): Row =>
  ({ entry, path, weight, choice, key: rowKey(path, entry.label ?? '') });

/** A row that runs a cmds entry by name, or none where this build has no such entry. */
function cmdRow(label: string, cmd: string, path: string[], weight: number,
  extra: Pick<MenuEntry, 'icon' | 'accel' | 'check' | 'danger'> = {}): Row[] {
  const fn = cmds![cmd];
  if (typeof fn !== 'function') return [];
  return [row({ label, ...extra, action: () => runCommand(fn(), label) }, path, weight)];
}

/** data-cmd="reset-scale" -> cmds.resetScale, the panel's and the toolbar's mapping. */
const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * A button's name and key, out of its aria-label or title: "Find something
 * Ctrl+K" is the name, two spaces, then the key. A parenthesis after the name
 * is a note for the tooltip, not part of it.
 */
function named(btn: HTMLElement): { name: string, accel: string } {
  const [name = '', rest = ''] = (btn.getAttribute('aria-label') || btn.title || btn.textContent || '')
    .trim().split(/\s{2,}/);
  return { name: name.replace(/\s*\(.*$/, '').trim(), accel: rest && !rest.startsWith('(') ? rest : '' };
}

const iconOf = (btn: Element) => btn.querySelector('use')?.getAttribute('href')?.split('#')[1];

function pressedOf(btn: Element): boolean | undefined {
  const pressed = btn.getAttribute('aria-pressed');
  return pressed === null ? undefined : pressed === 'true';
}

/**
 * The toolbar's tools this layout shows, read off the bar as its right-click
 * menu reads them, each pressing its own button; a tool's flyout under its
 * name; and the More menu's tools, which the bar may be showing already.
 */
function toolRows(): Row[] {
  const out: Row[] = [];
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#toolbar-tools [data-cmd]')) {
    const cmd = btn.dataset.cmd!;
    if (cmd === 'more-tools' || btn.hidden || btn.disabled) continue;
    if (!btn.hasAttribute('data-more') && getComputedStyle(btn).display === 'none') continue;
    const short = btn.querySelector('span')?.textContent?.trim() ?? '';
    const { name, accel } = named(btn);
    const label = name || short;
    if (!label) continue;
    out.push({ ...row({ label, icon: iconOf(btn), accel, check: pressedOf(btn), action: () => btn.click() },
      ['Tools'], W.tools), also: short });
    const fly = FLYOUTS[cmd];
    if (fly) out.push(...flatten(fly(cmds!), ['Tools', short || label], W.tools, true));
  }
  for (const t of MORE_TOOLS) if (!t.when || t.when()) out.push(...cmdRow(t.label, t.cmd, ['Tools'], W.tools, { icon: t.icon }));
  return out;
}

/** The furniture's own buttons and sliders, and the word each is filed under. */
const SCREEN: readonly (readonly [selector: string, where: string])[] = [
  ['#drawer-btn', 'Drawer'], ['#history-ctl button', 'History'], ['#zoom-ctl button', 'Zoom'],
  ['#timeline-strip button', 'Timeline'], ['#nowplaying button', 'Player'],
  ['#nowplaying input[type="range"]', 'Player'], ['#mobile-board-header button', 'Board'],
];

/** What of those is on screen and can be used now - read off the page, so it is what shows. */
function screenRows(): Row[] {
  const out: Row[] = [];
  for (const [selector, where] of SCREEN) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (!el.getClientRects().length) continue;
      if (el instanceof HTMLInputElement) {
        const label = el.getAttribute('aria-label');
        if (label) out.push(slider(label, el, [where], W.screen));
        continue;
      }
      if (el instanceof HTMLButtonElement && el.disabled) continue;
      const { name, accel } = named(el);
      if (name) {
        out.push(row({ label: name, icon: iconOf(el), accel, check: pressedOf(el), action: () => el.click() },
          [where], W.screen));
      }
    }
  }
  return out;
}

/** A slider row over a range input another module listens to, moved as a hand would move it. */
function slider(label: string, input: HTMLInputElement, path: string[], weight: number): Row {
  return row({ label, range: {
    min: Number(input.min) || 0, max: Number(input.max) || 100, step: Number(input.step) || 1,
    get: () => Number(input.value),
    set: v => { input.value = String(v); input.dispatchEvent(new Event('input', { bubbles: true })); },
  } }, path, weight);
}

/**
 * The commands no menu, tool or panel row reaches: a key's, or the desktop
 * menu bar's. tests/palette.test.js holds every row of that bar to being
 * somewhere in the box, this list or another source.
 */
const APP: readonly {
  label: string, cmd: string, place: string, icon?: string, accel?: string, when?: () => boolean,
}[] = [
  { place: 'Edit', label: 'Duplicate', cmd: 'duplicate', icon: 'i-duplicate', accel: 'Ctrl D',
    when: () => selection.size > 0 },
  { place: 'Edit', label: 'Gather and fence', cmd: 'gatherAndFence', icon: 'i-fence',
    when: () => selection.size > 1 },
  { place: 'Edit', label: 'Bring back the title card', cmd: 'restoreTitle', icon: 'i-restore',
    when: () => !!board.titleHidden },
  // The Find tool is the canvas's; the Feed reaches the same search from here.
  { place: 'Edit', label: 'Find on the board', cmd: 'find', icon: 'i-find', accel: 'Ctrl K',
    when: () => board.layoutMode === 'mobile' },
  { place: 'View', label: 'Zoom to 100% here', cmd: 'zoomActual', icon: 'i-zoom-in', accel: '1',
    when: () => board.layoutMode !== 'mobile' },
  { place: 'View', label: 'Move to a point…', cmd: 'moveTo', icon: 'i-move',
    when: () => board.layoutMode !== 'mobile' },
  { place: 'File', label: 'Export a copy…', cmd: 'exportAs', icon: 'i-download', when: isDesktop },
  { place: 'File', label: 'Optimise the board…', cmd: 'optimize' },
  { place: 'Help', label: 'Keyboard shortcuts', cmd: 'shortcuts', accel: '?' },
  { place: 'Help', label: 'Credits', cmd: 'credits', icon: 'i-info' },
  { place: 'Help', label: 'Take the tour of mbrd', cmd: 'appTour' },
  { place: 'Help', label: 'Open the example board', cmd: 'exampleBoard' },
];

function appRows(): Row[] {
  const out = APP.filter(a => !a.when || a.when())
    .flatMap(a => cmdRow(a.label, a.cmd, [a.place], W.app, { icon: a.icon, accel: a.accel }));
  out.push(row({ label: 'Settings', icon: 'i-gear', action: openSidebar }, ['View'], W.app));
  // The right-click menu offers this only to a finger, and the box is opened
  // from a keyboard, so it would never be here. Named as that menu names it.
  const picking = cmds!.multiSelect();
  out.push(row({ label: picking ? 'Done selecting' : 'Select multiple', icon: 'i-select-all',
    check: picking, action: () => cmds!.toggleMultiSelect() }, ['Edit'], W.app));
  return out;
}

// ---------------------------------------------------------------------------
// The sidebar, from its schema
// ---------------------------------------------------------------------------

/** Every control the panel would show in this layout, as rows, under Settings and its heading. */
function settingRows(ctx: Ctx): Row[] {
  const out: Row[] = [];
  for (const s of SECTIONS) {
    if (!sectionVisible(s, ctx)) continue;
    const tab = TABS.find(t => t.id === s.tab)?.label ?? '';
    const path = ['Settings', tab, s.title || s.fold || ''].filter(Boolean);
    for (const c of s.controls) {
      if (controlVisible(c, ctx) && !c.idle?.(ctx)) out.push(...controlRows(c, path, ctx));
    }
  }
  return out;
}

function controlRows(c: Control, path: string[], ctx: Ctx): Row[] {
  const el = c.id ? document.getElementById(c.id) : null;
  switch (c.type) {
    case 'check': {
      const { get, set } = c;
      if (!get || !set) return [];
      const on = get();
      return [row({ label: c.label, check: on, action: () => set(!on) }, path, W.settings)];
    }
    case 'range': return rangeRows(c, el, path);
    case 'picker': return pickerRows(c, el, path, ctx);
    case 'buttons': return c.buttons.flatMap(b => buttonRows(b, path, ctx));
    // The board's name: the field itself, with the caret in it.
    case 'text': return el ? [row({ label: `Change the ${(c.ariaLabel || 'text').toLowerCase()}`, icon: 'i-rename',
      action: () => reveal(el) }, path, W.settings)] : [];
    case 'slot': return el ? slotRows(el, path) : [];
    default: return [];
  }
}

/**
 * A dial whose stops have names is a choice among them, one row each, the way
 * Whimsy reads Softish, Middle and Harsh; any other is a slider row. An
 * `external` one belongs to the module that listens to its input, which is
 * moved as a hand would move it.
 */
function rangeRows(c: RangeControl, el: HTMLElement | null, path: string[]): Row[] {
  const input = el instanceof HTMLInputElement ? el : null;
  if (input && !onPanel(input)) return [];
  const get = c.external ? (input ? () => Number(input.value) : null) : c.get;
  if (!get) return [];
  if (c.stops?.length) {
    const now = get();
    return c.stops.map((stop, i) => row({ label: stop, check: now === i, action: () => setRange(c, input, i, true) },
      [...path, c.label], W.settings, true));
  }
  if (c.external && input) return [slider(c.label, input, path, W.settings)];
  return [row({ label: c.label, range: {
    min: c.min ?? 0, max: c.max ?? 100, step: c.step ?? 1, unit: c.unit, get,
    set: v => setRange(c, input, v, false),
  } }, path, W.settings)];
}

function setRange(c: RangeControl, input: HTMLInputElement | null, v: number, settle: boolean) {
  if (!c.external && c.set) {
    c.set(v);
    if (input) input.value = String(v);
    return;
  }
  if (!input) return;
  input.value = String(v);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  // A pick is a release: Whimsy files its one Timeline step on `change`.
  if (settle) input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** A picker's options, each picked as its own menu picks it (buildPicker() in ui/panel.ts). */
function pickerRows(c: PickerControl, el: HTMLElement | null, path: string[], ctx: Ctx): Row[] {
  const now = el?.dataset.value ?? c.get?.() ?? '';
  return (c.options?.(ctx) ?? []).map(o => row({
    label: o.label,
    swatchEnd: c.swatches?.(o.value),
    check: o.value === now,
    action: () => {
      if (el) {
        el.dataset.value = o.value;
        el.dispatchEvent(new CustomEvent('repaint'));
        el.dispatchEvent(new CustomEvent('pick', { detail: o.value }));
      }
      c.set?.(o.value);
    },
  }, [...path, c.label], W.settings, true));
}

function buttonRows(b: ButtonSpec, path: string[], ctx: Ctx): Row[] {
  if ((b.when && !b.when(ctx)) || b.idle?.(ctx)) return [];
  // Two sections each have a Reset; the box names which.
  const said = b.says?.(ctx) ?? b.label;
  const label = said === 'Reset' && path.length > 2 ? `Reset ${path[path.length - 1].toLowerCase()}` : said;
  const where = b.cmd ? `[data-cmd="${b.cmd}"]` : b.orient ? `[data-orient="${b.orient}"]` : '';
  const node = where ? document.querySelector<HTMLElement>(`#sidebar ${where}`) : null;
  const check = b.pressed ? b.pressed(ctx) : node ? pressedOf(node) : undefined;
  const danger = b.className === 'danger' || undefined;
  if (b.cmd) return cmdRow(label, camel(b.cmd), path, W.settings, { check, danger });
  return node ? [row({ label, check, action: () => node.click() }, path, W.settings)] : [];
}

/**
 * What another module built into a slot - the faces, the pigment tokens, the
 * dropped fonts - read off the panel: a slider moves where it is, anything
 * else is shown in the panel with the keyboard on it, and a loose button is pressed.
 */
function slotRows(slot: HTMLElement, path: string[]): Row[] {
  if (!onPanel(slot)) return [];
  const out: Row[] = [];
  for (const field of slot.querySelectorAll<HTMLElement>('label.field')) {
    if (!onPanel(field)) continue;
    const head = field.firstElementChild;
    const name = (head?.querySelector('span') ?? head)?.textContent?.trim();
    if (!name) continue;
    const range = field.querySelector<HTMLInputElement>('input[type="range"]');
    const target = range ?? field.querySelector<HTMLElement>('button, input, select');
    if (range) out.push(slider(name, range, path, W.settings));
    else if (target) out.push(row({ label: `${name}…`, action: () => reveal(target) }, path, W.settings));
  }
  for (const btn of slot.querySelectorAll<HTMLButtonElement>('button')) {
    if (btn.closest('label.field') || btn.disabled || !onPanel(btn)) continue;
    const { name } = named(btn);
    if (name) out.push(row({ label: name, action: () => btn.click() }, path, W.settings));
  }
  return out;
}

/** Whether a panel element is shown on its tab - hidden tabs aside, which are a page away, not gone. */
function onPanel(el: Element): boolean {
  for (let at: Element | null = el; at && !at.classList.contains('side-panel'); at = at.parentElement) {
    if (at instanceof HTMLElement && at.hidden) return false;
  }
  return true;
}

function reveal(el: HTMLElement) {
  openSidebar();
  revealControl(el);
}
