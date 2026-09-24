// Quick-edit chip that floats over the marked connection line. Carries the two
// cycled settings (arrows, dash), label, remove, and a "More" button to the
// full right-click menu. Anchored to the line's midpoint; dismissed when the
// mark clears. Repositioned on every paint/view change, rebuilt only when a
// different line is marked; its settings repaint in place.

import { icon } from './menu.ts';
import { activeConnectionAnchor, onActiveConnectionMove } from '../canvas/web.ts';
import type { Viewport } from '../canvas/viewport.ts';

/** Re-exported for callers that name the connection types. */
export type { ConnDir, ConnStyle } from '../board-model.ts';
import type { ConnDir, ConnStyle, ConnMeta } from '../board-model.ts';
import { CONN_DIRECTIONS, CONN_STYLES } from '../board-model.ts';

/** A pair of card ids, which is what a connection is. */
interface Conn {
  a: string;
  b: string;
}

/**
 * The commands this chip presses.
 *
 * Handed in by initConnChip() rather than imported, for the reason at the top
 * of the file; named here rather than taken from commands.ts because that
 * module imports this one and the arrow may only go one way.
 */
export interface ConnChipCommands {
  activeConnection?: () => Conn | null;
  connectionStyle: (a: string, b: string) => ConnMeta | null;
  setConnectionStyle: (a: string, b: string, patch: ConnMeta) => boolean;
  editConnectionLabel: (a: string, b: string) => void;
  deleteActiveConnection: () => boolean;
  contextMenu: (x: number, y: number, id: string | null, count: number) => void;
}

/* The cycles the two cycling buttons walk, in the order the menu lists them -
   which is board-model.ts's order, because these are that list. Copying it here
   was how the two could come to differ; reading it means a direction added
   there appears in this cycle without anybody remembering to. */
const DIRS: readonly ConnDir[] = CONN_DIRECTIONS;
const STYLES: readonly ConnStyle[] = CONN_STYLES;

// `satisfies` rather than an annotation, here and in the three below: the check
// that every ConnDir has a row is the whole point of naming the type, and an
// annotation buys that at the price of forgetting which four strings these are.
const DIR_ICON = {
  none: 'i-connect', fwd: 'i-arrow-fwd', back: 'i-arrow-back', both: 'i-arrow-both',
} satisfies Record<ConnDir, string>;
const DIR_TITLE = {
  none: 'No arrows', fwd: 'Arrow one end', back: 'Arrow other end', both: 'Arrows both ends',
} satisfies Record<ConnDir, string>;
const STYLE_ICON = {
  solid: 'i-line-solid', dashed: 'i-line-dashed', dotted: 'i-line-dotted',
} satisfies Record<ConnStyle, string>;
const STYLE_TITLE = {
  solid: 'Solid line', dashed: 'Dashed line', dotted: 'Dotted line',
} satisfies Record<ConnStyle, string>;

let cmds: ConnChipCommands | null = null;
let vp: Viewport | null = null;
let node: HTMLDivElement | null = null;
/** The chip's own size, measured once per build - see place(). */
let size = { w: 0, h: 0 };
/** The line the chip is built for: its two card ids. */
let pair = '';
/** The two cycling buttons and the label button, repainted in place. Built
 *  once per line: a rebuild replays the entrance and drops keyboard focus,
 *  which made every press of a cycle blink the chip. */
let dirBtn: HTMLButtonElement | null = null;
let styleBtn: HTMLButtonElement | null = null;
let labelBtn: HTMLButtonElement | null = null;
/** Where the line's midpoint last landed on screen, for the menu this opens. */
let anchor = { x: 0, y: 0 };

export function initConnChip(commands: ConnChipCommands, viewport: Viewport | null): void {
  cmds = commands;
  vp = viewport;
  // Two sources, and both are needed. A paint of the marked line covers an edit,
  // a reroute and a card being dragged; a view change covers a pan or a zoom,
  // which paint() deliberately returns from without redrawing while the screen
  // stays inside the rectangle it last culled against.
  onActiveConnectionMove(syncConnChip);
  vp?.onChange(syncConnChip);
  addEventListener('resize', syncConnChip);
}

/**
 * Show, move or hide the chip, from whatever the board currently says.
 *
 * Total, and called far more often than it does anything: with no line marked
 * it is two reads and a return, which is what lets every one of the events
 * above point straight at it rather than each deciding whether it applies.
 */
export function syncConnChip(): void {
  if (!cmds || !vp) return;
  const conn = cmds.activeConnection?.();
  const at = conn ? activeConnectionAnchor() : null;
  if (!conn || !at) { closeConnChip(); return; }

  const meta: ConnMeta = cmds.connectionStyle(conn.a, conn.b) || {};
  const next = `${conn.a}\0${conn.b}`;
  if (next !== pair) { build(conn); pair = next; }
  paint(meta.dir || 'none', meta.style || 'solid', !!meta.label);
  place(at);
}

/** Take the chip away. Nothing to remember: the next one is built from the board. */
function closeConnChip(): void {
  node?.remove();
  node = null;
  pair = '';
  dirBtn = styleBtn = labelBtn = null;
}

function build(conn: Conn): void {
  node?.remove();
  node = document.createElement('div');
  node.id = 'conn-chip';
  // Not a toolbar and not a menu: a small group of buttons about one thing.
  // Named so a screen reader says what it is before it says what is in it.
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', 'Connection');

  const set = (patch: ConnMeta) => cmds!.setConnectionStyle(conn.a, conn.b, patch);
  // Read at the press, not at the build: the chip outlives a change now.
  const now = () => cmds!.connectionStyle(conn.a, conn.b) || {};
  // Cycled rather than chosen. Four arrow states and three dashes are short
  // enough rings to walk by pressing, and pressing the thing you are looking at
  // to see the next state is the whole reason a chip beats a menu for these
  // two. The icon is the current state, so the button is also the readout.
  const nextIn = <T>(ring: readonly T[], now: T): T => ring[(ring.indexOf(now) + 1) % ring.length];

  // Placeholder faces: paint() runs straight after, before the frame is drawn.
  dirBtn = button(DIR_ICON.none, DIR_TITLE.none, () => set({ dir: nextIn(DIRS, now().dir || 'none') }));
  styleBtn = button(STYLE_ICON.solid, STYLE_TITLE.solid, () => set({ style: nextIn(STYLES, now().style || 'solid') }));
  labelBtn = button('i-style', 'Add a label', () => cmds!.editConnectionLabel(conn.a, conn.b));
  node.append(
    dirBtn,
    styleBtn,
    labelBtn,
    // Everything this does not carry, in the place that does carry it. Opened at
    // the *line* rather than at the chip, because the menu finds what a
    // right-click is about by hit-testing the point it was opened at - and the
    // point the chip is pinned to is a point on the line.
    button('i-more', 'More', () => cmds!.contextMenu(anchor.x, anchor.y, null, 0)),
    button('i-delete', 'Remove connection', () => cmds!.deleteActiveConnection(), true),
  );

  // Measured hidden and once, because place() runs on every frame of a pan and
  // a rectangle read there would be a layout flush per frame for a box whose
  // size only changes when this function runs.
  node.style.visibility = 'hidden';
  document.body.append(node);
  const rect = node.getBoundingClientRect();
  size = { w: rect.width, h: rect.height };
  node.style.visibility = '';
}

function button(name: string, title: string, action: () => void, danger = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = title;
  // The label is the title, said out loud: every one of these is an icon, and
  // an icon has no accessible name of its own.
  b.setAttribute('aria-label', title);
  if (danger) b.className = 'is-danger';
  b.append(icon(name));
  b.addEventListener('click', () => action());
  return b;
}

/** Show the line's current settings on the chip, without rebuilding it. */
function paint(dir: ConnDir, style: ConnStyle, labelled: boolean): void {
  relabel(dirBtn, DIR_ICON[dir], DIR_TITLE[dir]);
  relabel(styleBtn, STYLE_ICON[style], STYLE_TITLE[style]);
  relabel(labelBtn, 'i-style', labelled ? 'Change label' : 'Add a label');
}

/** One button's icon and name, rewritten only when they changed. */
function relabel(b: HTMLButtonElement | null, name: string, title: string): void {
  if (!b || (b.dataset.icon === name && b.title === title)) return;
  b.dataset.icon = name;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.replaceChildren(icon(name));
}

/**
 * Put the chip over the middle of the line.
 *
 * Above it by a gap, so it never covers what it is about, and flipped below
 * rather than clamped when there is no room - the same rule ui/menu.ts and the
 * fence offer follow, and for the same reason: a popup pinned to the top edge
 * ends up under the pointer and gets pressed by accident. Clamped sideways,
 * where there is nothing to flip about.
 */
function place(at: { x: number; y: number }): void {
  if (!node) return;
  const p = vp!.toScreen(at.x, at.y);
  anchor = { x: p.x, y: p.y };
  const gap = 16;
  const pad = 8;
  let y = p.y - gap - size.h;
  if (y < pad) y = p.y + gap;
  const x = Math.min(Math.max(pad, p.x - size.w / 2), innerWidth - size.w - pad);
  node.style.left = Math.round(x) + 'px';
  node.style.top = Math.round(y) + 'px';
  // Hidden when the line it belongs to is not on screen. The clamp above keeps
  // the chip inside the window whatever the anchor is - which is right while
  // the line is visible and wrong the moment it is not: panning the marked line
  // off to the left parked the chip against the screen edge, editing a
  // connection nobody could see. The chip is a label on a thing, so it goes
  // where the thing is or it goes away. Visibility rather than `hidden`:
  // display:none and back restarts the entrance, so a line panned back into
  // view popped its chip again.
  const off = p.x < -pad || p.y < -pad
    || p.x > innerWidth + pad || p.y > innerHeight + pad;
  node.style.visibility = off ? 'hidden' : '';
}
