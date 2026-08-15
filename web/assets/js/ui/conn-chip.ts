// The small editor that follows the line you pressed.
//
// A connection could be edited exactly one way - right-click it - and pressing
// one now marks it (see activeConnection in canvas/web.js). This is what the
// mark is worth: five buttons over the middle of the marked line, so the two
// things people change constantly are one press away rather than behind the
// mouse button most people never use on the one element on the board with no
// other affordance.
//
// It is deliberately **not** the editor. The right-click menu is complete -
// direction, style, colour, weight, label, remove - and a second complete
// editor is two places to change the same five settings and two places for them
// to disagree about what they are called. So this carries the two that are
// cycled rather than chosen (arrows, dash), the one that is typed (label), the
// one that is final (remove), and a way through to the rest. Colour and weight
// are not here on purpose: they are a choice from a list, which is what a menu
// is for.
//
// Anchored to the line's own midpoint rather than to the pointer, which is the
// difference between this and ui/fence-prompt.js and the reason it does not
// withdraw by distance: that one answers a gesture that has just finished and
// must cost nothing to walk away from, and this one belongs to a thing that is
// still marked. It goes when the mark goes - a press anywhere else, Escape, or
// the line being removed - all of which happen through canvas/input.js and
// cmds, so there is no dismissal logic of its own here at all.
//
// One at a time, and rebuilt only when the line or its settings change: the
// chip is repositioned on every paint of the line it is pinned to and on every
// view change, and re-placing a node is a style write where rebuilding it is
// five elements and five listeners.

// The menu's icon builder, for the menu's icons. The two are the same actions
// wearing the same marks, and a chip that drew its own arrows would be a second
// visual language for one feature.
import { icon } from './menu.ts';
// Where the marked line is, and when it has moved. Imported rather than pushed
// in by main.js because the chip is *about* that line - it has nothing to draw
// without it - and ui/ reaching into canvas/ is the direction the layering
// allows (ui/toolbar.js does the same for the draft).
import { activeConnectionAnchor, onActiveConnectionMove } from '../canvas/web.ts';
import type { Viewport } from '../canvas/viewport.ts';

/**
 * The two settings this chip cycles, and what a pair carries - all four taken
 * from board-model.ts rather than spelled again here.
 *
 * They were spelled again here, and it was not a stylistic slip: board-model
 * declared these as `string`, and a chip cannot build a Record<string, icon>,
 * so the only way to have the tables below was to re-state the lists. The two
 * then disagreed - board-model said `string`, this file said a union - and the
 * disagreement showed up as a type error where the two met in main.ts, which is
 * how it was found. board-model states the unions now, struck from the same
 * arrays connMeta() validates against, so there is one list again.
 *
 * Re-exported because this chip's own callers name them.
 */
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
 * of the file; named here rather than taken from commands.js because that
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

const DIR_ICON: Record<ConnDir, string> = {
  none: 'i-connect', fwd: 'i-arrow-fwd', back: 'i-arrow-back', both: 'i-arrow-both',
};
const DIR_TITLE: Record<ConnDir, string> = {
  none: 'No arrows', fwd: 'Arrow one end', back: 'Arrow other end', both: 'Arrows both ends',
};
const STYLE_ICON: Record<ConnStyle, string> = {
  solid: 'i-line-solid', dashed: 'i-line-dashed', dotted: 'i-line-dotted',
};
const STYLE_TITLE: Record<ConnStyle, string> = {
  solid: 'Solid line', dashed: 'Dashed line', dotted: 'Dotted line',
};

let cmds: ConnChipCommands | null = null;
let vp: Viewport | null = null;
let node: HTMLDivElement | null = null;
/** The chip's own size, measured once per build - see place(). */
let size = { w: 0, h: 0 };
/** What the chip is currently drawn for: the pair and the two settings it shows. */
let sig = '';
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
  const dir = meta.dir || 'none';
  const style = meta.style || 'solid';
  const next = `${conn.a}\0${conn.b}\0${dir}\0${style}\0${meta.label || ''}`;
  if (next !== sig) { build(conn, dir, style, !!meta.label); sig = next; }
  place(at);
}

/** Take the chip away. Nothing to remember: the next one is built from the board. */
function closeConnChip(): void {
  node?.remove();
  node = null;
  sig = '';
}

function build(conn: Conn, dir: ConnDir, style: ConnStyle, labelled: boolean): void {
  node?.remove();
  node = document.createElement('div');
  node.id = 'conn-chip';
  // Not a toolbar and not a menu: a small group of buttons about one thing.
  // Named so a screen reader says what it is before it says what is in it.
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', 'Connection');

  const set = (patch: ConnMeta) => cmds!.setConnectionStyle(conn.a, conn.b, patch);
  // Cycled rather than chosen. Four arrow states and three dashes are short
  // enough rings to walk by pressing, and pressing the thing you are looking at
  // to see the next state is the whole reason a chip beats a menu for these
  // two. The icon is the current state, so the button is also the readout.
  const nextIn = <T>(ring: readonly T[], now: T): T => ring[(ring.indexOf(now) + 1) % ring.length];

  node.append(
    button(DIR_ICON[dir], DIR_TITLE[dir], () => set({ dir: nextIn(DIRS, dir) })),
    button(STYLE_ICON[style], STYLE_TITLE[style], () => set({ style: nextIn(STYLES, style) })),
    button('i-style', labelled ? 'Change label' : 'Add a label',
      () => cmds!.editConnectionLabel(conn.a, conn.b)),
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

/**
 * Put the chip over the middle of the line.
 *
 * Above it by a gap, so it never covers what it is about, and flipped below
 * rather than clamped when there is no room - the same rule ui/menu.js and the
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
  // where the thing is or it goes away.
  const off = p.x < -pad || p.y < -pad
    || p.x > innerWidth + pad || p.y > innerHeight + pad;
  node.hidden = off;
}
