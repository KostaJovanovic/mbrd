// Pointer + keyboard gestures for the canvas. One pipeline, one active
// gesture at a time (enter() is the only writer, GESTURE_MOVES the legal
// table). Not to be split — a second pipeline reintroduces its bugs.
// Pure deciders (readWheel, gestureTransition, pressIntent) are exported
// for tests; the doing stays inside initInput().

import { capturePointerSafely, clamp, hasOwn, markClosed, releasePointerSafely } from '../util.ts';
import { cue } from '../cuelume/engine.ts';
import {
  board, byId, selection, select, deselect, clearSelection, isMultiSelect, topZ, stackOrder,
  snapshotGeom, applyGeom, commitGeom, bus, stuckFollowers, stuckPlacement, wouldStick,
  rolledAway, rolledFences, fenceOf,
  travelling, isFence, isLocked, dragRoot, isPinned, isSticky, stuckTo, resettle,
  copyItems, cutItems, pasteItems, clipboardSize, clipboardBounds, clipboardHasOurs,
  baseStep, timelinePlaying, fenceAt, lastCommand,
  duplicateInPlace, takeBack, commit,
} from '../state.ts';
import type { Command } from '../state.ts';
import type { Item } from '../board-model.ts';
import { baseMs, reducedMotion, zoomMs } from './viewport.ts';
import type { Viewport } from './viewport.ts';
import {
  itemInRect, itemWithinRect, rotatedExtents,
  latticeBox, latticeLow, latticePicture, cellInset, MIN_SIZE, MAX_SIZE, CARD_FLOOR_CELLS,
} from '../geometry.ts';
import type { Box, Bounds, Point } from '../geometry.ts';
import {
  itemIdFromEvent, ensureMounted, nodeFor, sync as syncItems, editItemName, showStickTarget,
  setDragging, barHeight, refreshRings, setPressing, seenPlaces, slideFrom,
} from './items.ts';
import { noteFloor } from './notes.ts';
import { leanAtSize, itemAccessibleName } from './item-dom.ts';
import { linkURL } from './links.ts';
import { isPicture, cardRatio } from './picture-shape.ts';
import { embedFor, embedFloor } from './embed.ts';
import { queryRect, queryAround } from './spatial.ts';
import { holdRoutes } from './web.ts';
import { startEdgePan } from './edge-pan.ts';
import { penOn, setPen, beginStroke, extendStroke, endStroke, dropStroke } from './pen.ts';
import { isDesktop } from '../platform/platform.ts';
import { DEFAULT_WHEEL, wheelPrefs } from '../controls.ts';
import type { WheelPrefs } from '../controls.ts';

const DRAG_SLOP = 3;      // screen px before a press becomes a drag
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_SLOP = 28;
const TAP_MOVE_SLOP = 12;
/** Cards per drop worth a sound of their own: what cuelume/engine.ts fits in
 *  its 80ms lookahead at 12ms apart. More would share an instant, inaudibly,
 *  and cost Web Audio nodes on a 500-card drop. */
const TAP_BURST = 7;
// A resting finger means "show me the menu" after this; both mobile platforms
// use the same interval.
const LONG_PRESS_MS = 480;
// How long a held card waits before it starts to shrink: past a quick tap, so
// a tap never twitches. .item.is-pressing's 360ms scale is the rest of the hold.
const PRESS_SHOW_MS = 120;
const LONG_PRESS_CONTEXT_GUARD_MS = 900;
const LONG_PRESS_CONTEXT_GUARD_PX = 24;

// Controls a corner grip may overlap but must hand the press back to rather
// than resize over. Not full-card surfaces (a model stage, a picture, a note's
// body): a corner over those is meant to resize. See onDown().
const GRIP_YIELD = 'button, a[href], input, .wave';

// Types the three-by-two cell floor (CARD_FLOOR_CELLS) does not bind: sized by
// content (note, text), their own aspect (title, swatch, sticker, drawing), no
// grips (ghost), or their own floor (fence, carryFloor). See onMove().
const NO_GRID_FLOOR = new Set<string>([
  'note', 'text', 'title', 'swatch', 'sticker', 'ghost', 'fence', 'drawing',
]);

/** A geometry snapshot, typed off the function so the type does not need a
 *  second import edge past state.ts. */
type GeomSnap = ReturnType<typeof snapshotGeom>[number];

/** A place the pointer was, and when: what every timing window here compares. */
export type TapPoint = { x: number, y: number, at: number };

/** Whether two touch points form the two taps of one deliberate gesture. */
export function isDoubleTap(
  previous: TapPoint | null | undefined,
  current: TapPoint | null | undefined,
): boolean {
  if (!previous || !current) return false;
  const elapsed = current.at - previous.at;
  return elapsed >= 0 && elapsed <= DOUBLE_TAP_MS
    && Math.hypot(current.x - previous.x, current.y - previous.y) <= DOUBLE_TAP_SLOP;
}

/** A selected item is the only item a drag may move. */
export function needsSelectionBeforeMove(selected: ReadonlySet<string>, id: string): boolean {
  return !selected.has(id);
}

/** Whether a canvas shortcut must stand down: the event was already handled
 *  (the context menu's capture listener) or an overlay owns the keyboard. */
export function shortcutsSuppressed(
  defaultPrevented: boolean,
  overlayOwnsKeyboard: boolean,
): boolean {
  return !!(defaultPrevented || overlayOwnsKeyboard);
}

/** A mouse or pen pointerup that leaves a button down ends nothing (endPointer).
 *  Asks `buttons`, never `button`: a chord's last release can be any button. */
export function liftWithButtonsHeld(
  e: { type: string, pointerType: string, buttons: number },
): boolean {
  return e.type === 'pointerup' && (e.pointerType === 'mouse' || e.pointerType === 'pen')
    && e.buttons !== 0;
}

/** How hard a stroke is pressed. Only a stylus says: a mouse reports 0.5 while
 *  pressed and a finger whatever its screen likes, so both are read as 0.5,
 *  which strokes.ts draws at the width the size says. */
function pressureOf(e: { pointerType: string, pressure: number }): number {
  return e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
}

/** The keys that still work while the Timeline plays: they move the view or
 *  close something. See the keydown handler. */
const VIEW_KEYS = new Set(['0', '1', 'f', 'F', '+', '=', '-', '_', 'z', 'Z', 'Home', 'Escape']);

/** Ctrl with one of these is the board's zoom, not the page's - see the keydown handler. */
const ZOOM_KEYS = new Set(['+', '=', '-', '_', '0']);

/** A pause this long ends a run of nudges, so a run is one undo step. Key
 *  repeat is 30-50ms, and careful tapping stays well inside a second. */
const NUDGE_RUN_MS = 1000;

// ---------------------------------------------------------------------------
// What a press means — pure decision, handler does the doing. Branch order
// matches the handler's; each turns on facts a headless test can state.
// ---------------------------------------------------------------------------

/** What a press turns out to be — one variant per branch of the cascade. */
export type PressIntent =
  | { kind: 'widget' }
  | { kind: 'zoomBox' }
  | { kind: 'pan', middle: boolean }
  | { kind: 'frozen' }
  | { kind: 'resize', id: string }
  | { kind: 'marqueeDrag' }
  | { kind: 'tapGate', id: string, additive: boolean }
  | { kind: 'move', id: string, additive: boolean, wasSelected: boolean }
  | { kind: 'lockedPan', id: string, additive: boolean, wasSelected: boolean }
  | { kind: 'marquee' }
  | { kind: 'empty' };

/** Facts the press cascade reads — named by question, not by source. */
export type PressFacts = {
  pointerType: string;
  button: number;
  /** shift, ctrl, meta, or multi-select mode, which the cascade treats alike. */
  additive: boolean;
  /** `additive` comes from multi-select mode alone, no key held. A drag on bare
   *  board then pans rather than bands, so picking works across a big board;
   *  the double-tap swipe still draws the band. */
  picking?: boolean;
  spaceDown: boolean;
  /** Z held on a canvas board: a primary press draws the box to zoom into. */
  zoomBox?: boolean;
  /** A control inside a card: a scrubber, a button, a note being edited. */
  onWidget: boolean;
  /** A resize handle, after the corner-yield look-through. */
  onGrip: boolean;
  /** The item under the point, or null for bare board. */
  onCard: string | null;
  /** Is that card's geometry pinned - `meta.locked`? */
  locked: boolean;
  /** A sticky stuck to a host and past its settle. Unlike `locked` (immovable,
   *  the press pans), it moves with its host, so only a grip press is refused
   *  and falls through to mean what any other press means. */
  pinned: boolean;
  /** Is it unpicked, so a drag would have to select it first? */
  needsTapFirst: boolean;
  /** Is it already in the selection? */
  wasSelected: boolean;
  selectionSize: number;
  /** The second tap of a touch double tap on empty board. */
  doubleTapDrag: boolean;
  isMobile: boolean;
  /** A tour is running: the board is shown, not worked on, so nothing moves,
   *  resizes or drives the view. */
  touring: boolean;
  /** Is the Timeline playing? The board is read-only then, and a press pans. */
  viewOnly: boolean;
};

/**
 * Ten branches in the handler's order — each step is load-bearing.
 * 0 Z zoom box (it only moves the view, so ahead of every claim but a tour's),
 * 1 widget (not with space/middle), 2 frozen tour, 3 space/middle pan,
 * 4 grip resize (single selection only), 5 double-tap marquee,
 * 6 touch tap-gate, 7 card move/locked-pan, 8 modified band, 9 empty.
 */
export function pressIntent(f: PressFacts): PressIntent {
  const middle = f.button === 1;
  if (f.zoomBox && f.button === 0 && !f.touring) return { kind: 'zoomBox' };
  // The Timeline replay owns the board: every press pans, card controls
  // included. Pan rather than frozen, because the view is still the reader's.
  if (f.viewOnly) return { kind: 'pan', middle };
  if (f.onWidget && !f.spaceDown && !middle) return { kind: 'widget' };
  // A tour freezes everything, view included: its stops are framed shots, and
  // panning off one leaves no way back. Above the grip and pan branches for that.
  if (f.touring) return { kind: 'frozen' };
  if (f.spaceDown || middle) return { kind: 'pan', middle };
  if (f.onGrip && f.onCard && f.selectionSize <= 1 && !f.locked && !f.pinned) {
    return { kind: 'resize', id: f.onCard };
  }
  if (f.doubleTapDrag) return { kind: 'marqueeDrag' };
  if (f.onCard && f.needsTapFirst && (f.pointerType === 'touch' || f.isMobile)) {
    return { kind: 'tapGate', id: f.onCard, additive: f.additive };
  }
  if (f.onCard) {
    // The card branches carry the id in their type, so nothing downstream asserts it.
    const carried = { id: f.onCard, additive: f.additive, wasSelected: f.wasSelected };
    return f.locked ? { kind: 'lockedPan', ...carried } : { kind: 'move', ...carried };
  }
  if (f.additive && !f.picking) return { kind: 'marquee' };
  return { kind: 'empty' };
}

/** Whether a native contextmenu repeats the menu a touch hold already opened. */
export function repeatsLongPressContextMenu(
  opened: TapPoint | null | undefined,
  event: TapPoint | null | undefined,
): boolean {
  if (!opened || !event) return false;
  const elapsed = event.at - opened.at;
  return elapsed >= 0 && elapsed <= LONG_PRESS_CONTEXT_GUARD_MS
    && Math.hypot(event.x - opened.x, event.y - opened.y) <= LONG_PRESS_CONTEXT_GUARD_PX;
}

// Screen pixels of diagonal before a band counts as a drawn rectangle rather
// than a modified click (which starts a zero-size marquee and means "clear the
// selection"). Above DRAG_SLOP, so a wobbly click selects without being offered
// a fence.
const MARQUEE_DRAWN = 16;

/** Did this marquee draw a rectangle, or was it a modified click? */
export function drewRectangle(
  box: Bounds | null | undefined,
  zoom: number,
  slop = MARQUEE_DRAWN,
): boolean {
  if (!box) return false;
  return Math.hypot((box.x1 - box.x0) * zoom, (box.y1 - box.y0) * zoom) >= slop;
}

/**
 * Is this item caught by a band over `[x0,x1] x [y0,y1]`?
 *
 * A card by overlap, a fence only when covered outright. A fence's face takes
 * no presses, so a band across it is drawn inside the region, not aimed at it;
 * by overlap, every band inside a region would catch the region too.
 */
export function marqueeHit(
  it: Box & { type?: string },
  x0: number, y0: number, x1: number, y1: number,
): boolean {
  return isFence(it)
    ? itemWithinRect(it, x0, y0, x1, y1)
    : itemInRect(it, x0, y0, x1, y1);
}

/**
 * One card's claim on the region that carries it, frozen at grip time: the
 * fraction of the box it sits at, its half-extents, which do not change, and
 * how far it already hung past each wall (`out`, zero when it was inside). The
 * top wall is the underside of the fence's name plate.
 */
export type CarryHold = {
  fx: number, fy: number, hw: number, hh: number,
  out: { w: number, e: number, s: number, n: number },
};

/** A fence's box mid-resize, and the height of its name plate. */
type CarryRoom = { x: number, y: number, w: number, h: number, plate: number };

/** Where a card was when the grip was taken, read as a CarryHold. */
export function carryHold(card: Box, box: CarryRoom): CarryHold {
  const { hw, hh } = rotatedExtents(card);
  const past = (v: number) => Math.max(v, 0);
  return {
    fx: (card.x - box.x) / (box.w || 1),
    fy: (card.y - box.y) / (box.h || 1),
    hw, hh,
    out: {
      w: past((box.x - box.w / 2) - (card.x - hw)),
      e: past((card.x + hw) - (box.x + box.w / 2)),
      s: past((box.y - box.h / 2) - (card.y - hh)),
      n: past((card.y + hh) - (box.y + box.h / 2 - box.plate)),
    },
  };
}

/**
 * Where a held card goes in the box a resize has reached. It keeps its
 * fraction of the box - pulling a region in gathers its cards, pushing it out
 * spreads them - until a wall reaches it, and then the wall pushes it along
 * instead. Read from the grip each frame, never from the last frame, so a card
 * a wall pushed goes back to its own spot when the wall moves away again.
 *
 * A card that hung out of the fence when the grip was taken may keep hanging
 * out by as much, so touching a grip never jumps it. A box too small to hold a
 * card on an axis centres it there; carryFloor() keeps that from happening.
 */
export function carryPlace(box: CarryRoom, hold: CarryHold): Point {
  const along = (at: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : clamp(at, lo, hi));
  return {
    x: along(box.x + hold.fx * box.w,
      box.x - box.w / 2 + hold.hw - hold.out.w, box.x + box.w / 2 - hold.hw + hold.out.e),
    y: along(box.y + hold.fy * box.h,
      box.y - box.h / 2 + hold.hh - hold.out.s, box.y + box.h / 2 - box.plate - hold.hh + hold.out.n),
  };
}

/**
 * The smallest a fence may be dragged: big enough for its largest card on
 * each axis, with the plate on top. Cards are pushed by the walls rather than
 * stopping them (carryPlace), so this is the only limit left - past it a card
 * would have to be outside. Zeroes when the fence holds nothing.
 *
 * Capped at the size the drag started from, so a fence already too small for
 * what it holds does not snap open the moment a grip is touched.
 */
export function carryFloor(
  box: { w: number, h: number, plate?: number },
  holds: readonly CarryHold[] | null | undefined,
): { w: number, h: number } {
  if (!holds?.length) return { w: 0, h: 0 };
  let w = 0, h = 0;
  for (const p of holds) {
    w = Math.max(w, 2 * p.hw - p.out.w - p.out.e);
    h = Math.max(h, 2 * p.hh - p.out.s - p.out.n + (box.plate ?? 0));
  }
  return { w: Math.min(box.w, w), h: Math.min(box.h, h) };
}

/** Whether a grip press has moved far enough to resize. A tap on a grip does
 *  nothing, so it never snaps or commits geometry. */
export function resizeHandleAction(
  start: Point | null | undefined,
  current: Point | null | undefined,
): 'wait' | 'resize' {
  if (!start || !current) return 'wait';
  return Math.hypot(current.x - start.x, current.y - start.y) >= DRAG_SLOP
    ? 'resize'
    : 'wait';
}

// ---------------------------------------------------------------------------
// The wheel that is not always a wheel — touchpad scroll vs mouse zoom.
// No API says which device sent the event, so this is a heuristic:
// ctrlKey with no Control key down = pinch (reliable), deltaMode = mouse,
// fractional dx = pad.
// Answer is latched per burst so a fast swipe inherits the slow start.
// ---------------------------------------------------------------------------

/** Pixels one line of a deltaMode 1 event is taken to be. */
const WHEEL_LINE = 16;

/** A single step at least this large is a wheel notch: under every mouse (100
 *  in Chrome and Safari, 120 on some Windows drivers; Firefox uses deltaMode 1),
 *  over anything a swipe opens with. */
export const WHEEL_NOTCH = 40;

/** How long after one wheel event another still belongs to the same gesture. */
export const WHEEL_STREAM_MS = 200;

/** Zoom per unit of delta. A notch is ~100 at once; a pinch is a stream of
 *  single figures and would barely move at the wheel's rate. */
const WHEEL_ZOOM_RATE = 0.0016;
const PINCH_ZOOM_RATE = 0.01;

/** The most one event may be worth, so a flung pad cannot jump the view. An
 *  unfocused window on Linux coalesces notches into one delta; at this cap that
 *  is about 1.2x, a single Windows notch. */
const WHEEL_MAX_STEP = 120;

/**
 * How soon a hi-res wheel must complete a detent to be read as one. Chromium on
 * Linux (Wayland, or libinput 1.19+) splits a detent into equal fractional
 * deltas (53 * v/120 px), which classifyWheel() cannot tell from a pad; the run
 * of identical deltas is the tell. 24ms was too short for a slow hand. Long
 * enough for a deliberate notch, short enough that a crawling pad never makes
 * one. Reasoned, not measured.
 */
const HIRES_DETENT_MS = 250;

/** The most fragments one event may carry when the browser coalesces a detent. */
const HIRES_MAX_COALESCED = 4;

/**
 * How much of a lean is handed back when the platform rails a swipe. Measured:
 * a curved swipe arrived as 5257px down and 973px across, the across in only 75
 * of 349 events. Three brings it back to about half. Only touches an axis the
 * platform is withholding (unrail()), and cannot rescue one railed outright,
 * which reports exactly zero. The one number to turn if it feels wrong.
 */
const UNRAIL_GAIN = 3;

/** The most one event may be boosted by, in pixels. What the platform reported
 *  passes untouched; this bounds the addition, so a delta the driver released
 *  in one lump does not become a sideways jerk. */
const UNRAIL_CAP = 40;

/** How quickly the running measures of a gesture follow it. */
const AXIS_EASE = 0.15;

/** The two devices a wheel event may come from: a pad pans, a wheel zooms. */
export type WheelKind = 'pan' | 'zoom';

/** The part of a WheelEvent this reads, structural so a test can pass six numbers. */
export type WheelSample = {
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  ctrlKey: boolean,
  shiftKey: boolean,
  timeStamp: number,
};

/** What one wheel event asks for. `undo` is the pan a burst made before it
 *  turned out to be a hi-res wheel; the caller gives it back in the same frame. */
export type WheelAction = {
  kind: WheelKind, dx: number, dy: number, factor: number, undo?: Delta,
};

/** The device this burst of wheel events is being read as, and when it last spoke. */
let wheelKind: WheelKind = 'zoom';
let wheelAt = -Infinity;

/** The burst as detent() sees it. `burstStep` is the fragment every event has
 *  carried a whole number of, NaN once ruled out; `panX`/`panY` are what the
 *  burst panned, which `undo` hands back. */
let burstAt = -Infinity;
let burstDy = 0;
let burstCount = 0;
let burstStep = NaN;
let panX = 0;
let panY = 0;

/** The last recognised detent's fragment, so the next burst opening with it is
 *  a wheel from its first event. NaN until seen; lasts the session. */
let hiresStep = NaN;

/** How much each axis has been moving, over this burst alone. */
let axisX = 0;
let axisY = 0;

/** How often each axis arrives at all, over this burst. Start at 1 so a swipe
 *  is never lifted on thin evidence; a gated axis falls within ~0.1s. */
let seenX = 1;
let seenY = 1;

/** Forget the current burst. For tests only: the live way a burst ends is
 *  WHEEL_STREAM_MS with no event. */
export function resetWheelKind(): void {
  wheelKind = 'zoom';
  wheelAt = -Infinity;
  axisX = axisY = 0;
  seenX = seenY = 1;
  burstAt = -Infinity;
  burstDy = burstCount = panX = panY = 0;
  burstStep = hiresStep = NaN;
}

/**
 * Give back the part of a lean the platform kept.
 *
 * Decided by how often the minor axis arrives, not by its size, because a rail
 * zeroes events. Recorded from one pad:
 *
 *   railed   5257px down, 973px across, the across in  75 of 349 events
 *   free      791px down, 1147px across, the across in  58 of  59 events
 *
 * By ratio the two look alike, and lifting a free swipe's drift slides the
 * board from under the hand. The gain rides on the gaps: none missing, nothing
 * added; four in five missing, nearly UNRAIL_GAIN. Measured over the burst, as
 * one event cannot tell a rail from a straight moment.
 */
/** A drag delta after the rail has taken its share of it. */
type Delta = { dx: number, dy: number };

function unrail(dx: number, dy: number): Delta {
  axisX += (Math.abs(dx) - axisX) * AXIS_EASE;
  axisY += (Math.abs(dy) - axisY) * AXIS_EASE;
  seenX += ((dx ? 1 : 0) - seenX) * AXIS_EASE;
  seenY += ((dy ? 1 : 0) - seenY) * AXIS_EASE;

  // Whichever axis is carrying less of the gesture is the one a rail would be
  // holding back. Magnitude answers that; presence answers whether it is.
  const minorIsX = axisX < axisY;
  const gated = 1 - (minorIsX ? seenX : seenY);
  if (gated <= 0) return { dx, dy };

  const boost = (UNRAIL_GAIN - 1) * gated;
  const lift = (v: number) => v + clamp(v * boost, -UNRAIL_CAP, UNRAIL_CAP);
  return minorIsX ? { dx: lift(dx), dy } : { dx, dy: lift(dy) };
}

/**
 * Whether `v` is a whole number of `step`s, one to HIRES_MAX_COALESCED of them.
 * The tolerance is for 53/120, which no float holds exactly; a NaN step is
 * never matched.
 */
function fragments(v: number, step: number): boolean {
  const k = v / step;
  const whole = Math.round(k);
  return whole >= 1 && whole <= HIRES_MAX_COALESCED && Math.abs(k - whole) < 1e-6;
}

/** The only shape a hi-res detent fragment comes in: fractional, straight up
 *  or down, nothing held. A whole fragment is a full detent, already a notch. */
function fragmentLike(e: WheelSample, dx: number, dy: number): boolean {
  return e.deltaMode === 0 && !e.shiftKey && !e.ctrlKey && dx === 0 && !Number.isInteger(dy);
}

/** Which device a single event looks like it came from, read cold. */
function classifyWheel(e: WheelSample, dx: number, dy: number): WheelKind {
  if (e.deltaMode !== 0) return 'zoom';
  // A wheel already recognised this session, opening a new burst the way its
  // detents do.
  if (fragmentLike(e, dx, dy) && fragments(Math.abs(dy), hiresStep)) return 'zoom';
  // Sideways at all, or in fractions: a wheel can do neither - except a hi-res
  // one on Linux, which detent() catches on the way past.
  if (dx !== 0 || !Number.isInteger(dy)) return 'pan';
  return Math.abs(dy) < WHEEL_NOTCH ? 'pan' : 'zoom';
}

/**
 * Whether this event completes a hi-res detent in a burst read as a pad. All
 * four: fresh (HIRES_DETENT_MS), never sideways or modified, two or more events
 * each a whole number of one fractional step (a busy browser coalesces 6.625
 * into 13.25), and past a notch together. No finger holds to one fraction, so a
 * pad never qualifies. If Chromium changes, this stops firing and 'zoom-all' is
 * the way out.
 */
function detent(e: WheelSample, dx: number, dy: number, at: number): boolean {
  const first = burstCount === 0;
  burstCount += 1;
  const size = Math.abs(dy);
  // The step is the smaller of the two whenever one is a multiple of the other,
  // so a burst that opens on a coalesced pair still finds its fragment. NaN
  // fails both, so a burst ruled out stays ruled out.
  burstStep = !fragmentLike(e, dx, dy) ? NaN
    : first ? size
    : fragments(size, burstStep) ? burstStep
    : fragments(burstStep, size) ? size
    : NaN;
  if (Number.isNaN(burstStep)) return false;
  burstDy += dy;
  const found = burstCount >= 2 && at - burstAt <= HIRES_DETENT_MS && Math.abs(burstDy) >= WHEEL_NOTCH;
  if (found) hiresStep = burstStep;
  return found;
}

/**
 * What a wheel event is asking for: `pan` by (dx, dy), or `zoom` by `factor`.
 *
 * Deltas come out in pixels whatever the deltaMode. Engines report a pinch as
 * a wheel event with ctrlKey and no key down; `ctrlHeld` (the caller watches the
 * key) tells a real Control apart, which pans vertically as Shift does sideways.
 * A pinch always zooms and never latches the device.
 *
 * A two-finger scroll is railed: committed to one axis, the other arrives as
 * exactly zero and cannot be recovered; merely leaning, it is attenuated and
 * unrail() gives it back. Shift moves the whole delta sideways, the way out of
 * a hard rail and the old mouse convention in one rule.
 *
 * Modifiers apply after the device is latched, so holding Shift on a mouse does
 * not latch the burst into pan. `prefs` (controls.ts) is read last: in `zoom`
 * and `scroll` a pad swipe still pans; `zoom-all` overrides the device, for a
 * wheel that cannot be told from a pad.
 */
export function readWheel(
  e: WheelSample, pageHeight = 800, ctrlHeld = false, prefs: WheelPrefs = DEFAULT_WHEEL,
): WheelAction {
  const scale = e.deltaMode === 1 ? WHEEL_LINE : e.deltaMode === 2 ? pageHeight : 1;
  const dx = (e.deltaX || 0) * scale;
  const dy = (e.deltaY || 0) * scale;
  // `reverse` is the wheel's only: a notch's direction is a convention, a
  // pinch's is a fact about the hand.
  const zoom = (rate: number, reverse = false, d = dy) =>
    Math.exp(-clamp(d, -WHEEL_MAX_STEP, WHEEL_MAX_STEP) * (reverse ? -rate : rate));

  if (e.ctrlKey && !ctrlHeld) return { kind: 'zoom', dx, dy, factor: zoom(PINCH_ZOOM_RATE) };

  const at = e.timeStamp || 0;
  const fresh = at - wheelAt > WHEEL_STREAM_MS;
  if (fresh) {
    burstAt = at;
    burstDy = burstCount = panX = panY = 0;
    burstStep = NaN;
  }
  let kind = fresh ? classifyWheel(e, dx, dy) : wheelKind;
  // The one way a burst changes device after it has started, and only towards
  // the wheel - see detent().
  const relatched = kind === 'pan' && detent(e, dx, dy, at);
  if (relatched) kind = 'zoom';
  // The presence measures too, or a railed burst's low seenX/seenY would
  // amplify the next free swipe until the ease caught up.
  if (fresh) { axisX = axisY = 0; seenX = seenY = 1; }
  wheelKind = kind;
  wheelAt = at;

  // `dx || dy`: some browsers already turn Shift+scroll sideways.
  if (e.shiftKey) return { kind: 'pan', dx: dx || dy, dy: 0, factor: 1 };
  // A held Control (a pinch returned above). In `scroll` mode it zooms, at the
  // rate of the device the burst is read as.
  if (e.ctrlKey) {
    return prefs.mode === 'scroll'
      ? { kind: 'zoom', dx, dy,
          factor: zoom(kind === 'zoom' ? WHEEL_ZOOM_RATE : PINCH_ZOOM_RATE, prefs.reverse) }
      : { kind: 'pan', dx: 0, dy: dy || dx, factor: 1 };
  }

  // `kind` is the device; the preference decides what it means.
  if (prefs.mode === 'zoom-all') {
    return { kind: 'zoom', dx, dy, factor: zoom(WHEEL_ZOOM_RATE, prefs.reverse) };
  }
  if (kind === 'zoom') {
    if (prefs.mode === 'scroll') return { kind: 'pan', dx, dy, factor: 1 };
    if (!relatched) return { kind, dx, dy, factor: zoom(WHEEL_ZOOM_RATE, prefs.reverse) };
    // The whole detent so far is the zoom, and what it already panned goes back.
    const undo = { dx: panX, dy: panY };
    panX = panY = 0;
    return { kind, dx, dy, factor: zoom(WHEEL_ZOOM_RATE, prefs.reverse, burstDy), undo };
  }
  const moved = unrail(dx, dy);
  panX += moved.dx;
  panY += moved.dy;
  return { kind, ...moved, factor: 1 };
}

/** How far apart two top edges can be and still be read as one row, in world units. */
const WALK_ROW = 96;

/**
 * The order Tab walks the cards in: reading order, rows from the top and each
 * row left to right. A row is a band of top edges, so cards a few pixels out of
 * line still read as one. Pure, for tests/input.test.js.
 */
export function walkOrder<T extends { id: string, x: number, y: number, w: number, h: number }>(items: readonly T[]): T[] {
  // World y points up, so the top edge is the centre plus half the height.
  const top = (i: T) => i.y + i.h / 2;
  const left = (i: T) => i.x - i.w / 2;
  const down = [...items].sort((a, b) => top(b) - top(a));
  // A row runs while a top edge is within WALK_ROW of the row's first, so
  // there is no band boundary for two neighbours to fall either side of.
  const rows: T[][] = [];
  for (const item of down) {
    const last = rows[rows.length - 1];
    if (last && top(last[0]) - top(item) <= WALK_ROW) last.push(item);
    else rows.push([item]);
  }
  return rows.flatMap(r => r.sort((a, b) => left(a) - left(b) || (a.id < b.id ? -1 : 1)));
}

/**
 * The card Alt+arrow moves to from `from`: the nearest whose centre lies that
 * way, `dx`/`dy` a unit step in world space (y up, so Up is dy = 1). A card
 * inside the quarter that opens that way is preferred over one merely on that
 * side, and sideways distance costs double, so the step goes to the card that
 * reads as next in that direction rather than the closest one off at an angle.
 * Null at the edge of the board. Pure, for tests/input.test.js.
 */
export function nearestCard<T extends { id: string, x: number, y: number }>(
  from: { x: number, y: number }, cards: readonly T[], dx: number, dy: number,
): T | null {
  let best: T | null = null;
  let bestScore = Infinity;
  for (const card of cards) {
    const vx = card.x - from.x, vy = card.y - from.y;
    const along = vx * dx + vy * dy;
    if (along <= 0) continue;
    const across = Math.abs(vx * dy - vy * dx);
    // Outside the quarter: still reachable, but only after everything inside it.
    const score = along + 2 * across + (across > along ? 1e9 : 0);
    if (score < bestScore) { best = card; bestScore = score; }
  }
  return best;
}

/** Cells shift+arrow covers on a snapped board, where a bare arrow is already one. */
const NUDGE_LEAP = 10;

/** How close to a grid line counts as on it, in cells. Coordinates drift to
 *  3.9999999, and without this the "next line along" is the one it is on. */
const ON_LINE = 1e-6;

/**
 * One axis of a resize: the extent to end up with, given the start box and the
 * pointer's travel along the axis. `sign` is +1 for the high edge (east, or
 * north: world y points up), -1 for the low, 0 for an untouched axis. `snap` is
 * the grip's, not the board's (startResize()).
 *
 * Snapping rounds the moving edge's world position, not the extent, since the
 * pinned edge may be off the lattice; the extent is the distance back to it.
 * `inset` is the seam: a high edge sits a seam short of its line, a low edge a
 * seam past, so an item centres in its cells.
 *
 * Limits apply before the snap and are repaired after by one line the other way
 * (rounding moves at most half a step). The closing clamp holds even where a
 * step is coarser than the whole floor-to-ceiling band.
 */
export function resizeAxisOn(
  sign: number, centre: number, extent: number, travel: number,
  snap: boolean, step: number, inset: number,
) {
  if (!sign) return extent;
  let size = clamp(extent + sign * travel, MIN_SIZE, MAX_SIZE);
  if (snap) {
    const anchor = centre - sign * extent / 2;
    const bias = sign * inset;
    const edge = (k: number) => sign * (k * step - bias - anchor);
    const k = Math.round((anchor + sign * size + bias) / step);
    size = edge(k);
    if (size < MIN_SIZE) size = edge(k + sign);
    else if (size > MAX_SIZE) size = edge(k - sign);
  }
  return clamp(size, MIN_SIZE, MAX_SIZE);
}

/**
 * How far one arrow press moves the selection. Unsnapped, a distance. Snapped,
 * the next grid line along: a flush item moves one cell, an adrift one comes
 * onto the lattice first. A fixed distance would knock a snapped item off the
 * lattice. One delta for the whole selection, from `lead`, as the drag does, so
 * a spaced group is not collapsed onto the grid.
 */
export function nudgeDelta(
  sx: number, sy: number, far: boolean, lead: { x: number, y: number, w: number, h: number },
  snap: boolean, step: number, inset: number,
) {
  if (!snap) {
    const by = far ? step : 1;
    return { dx: sx * by, dy: sy * by };
  }
  const cells = far ? NUDGE_LEAP : 1;
  // Low edges land on the lattice, measured from the seam, as in the move
  // gesture and snapAll().
  const axis = (sign: number, low: number) => {
    if (!sign) return 0;
    const k = (low - inset) / step;
    const near = Math.round(k);
    const next = Math.abs(k - near) < ON_LINE
      ? near + sign                                   // flush already: move on
      : (sign > 0 ? Math.ceil(k) : Math.floor(k));    // adrift: come aboard
    return (next + sign * (cells - 1)) * step + inset - low;
  };
  return { dx: axis(sx, lead.x - lead.w / 2), dy: axis(sy, lead.y - lead.h / 2) };
}

// ---------------------------------------------------------------------------
// The gesture machine
// ---------------------------------------------------------------------------
//
// Eight modes: idle, press, pan, pinch, marquee, move, resize, stroke.
// Table-driven so tests/input.test.js can verify legal transitions
// without pressing a pointer. A second finger always aborts the live
// gesture first (landing in idle), then enters pinch from there.
/** Every gesture mode. String union, not enum (erasableSyntaxOnly). */
export type GestureMode = 'idle' | 'press' | 'pan' | 'pinch' | 'marquee' | 'move' | 'resize' | 'stroke';

export const GESTURE_MOVES = {
  // A press decides between five things - see onDown() - or, in drawing mode,
  // is a stroke from the moment it lands.
  idle: ['pan', 'marquee', 'move', 'press', 'pinch', 'stroke'],
  // The slop is crossed and the press becomes what it was waiting to be, or the
  // finger lifts and it was nothing.
  press: ['resize', 'marquee', 'idle'],
  pan: ['idle'],
  // One finger of a pinch lifts: the survivor carries on as a pan.
  pinch: ['pan', 'idle'],
  marquee: ['idle'],
  move: ['idle'],
  resize: ['idle'],
  stroke: ['idle'],
} satisfies Record<GestureMode, readonly GestureMode[]>;

/**
 * The mode `from` reaches when asked for `to`, or null if that is not a legal
 * move. Total even on junk names, since a wedged pointer is worse than a wrong
 * one; hasOwn, because `GESTURE_MOVES['toString']` is a prototype function.
 */
export function gestureTransition(
  from: string | undefined,
  to: string | undefined,
): GestureMode | null {
  // SAFETY: neither name is trusted: `key` is checked with hasOwn and `want` is
  // looked for in the list that answered, so a non-mode takes the null.
  const key = from as GestureMode;
  // Annotated: the literal rows' union would narrow includes()'s argument to never.
  const legal: readonly GestureMode[] | null =
    hasOwn(GESTURE_MOVES, key) ? GESTURE_MOVES[key] : null;
  // SAFETY: as at `key`.
  const want = to as GestureMode;
  return legal?.includes(want) ? want : null;
}

// MIN_SIZE and MAX_SIZE (geometry.ts) are the resize limits: the grips are
// screen-sized and crowd a tiny item, and an unbounded drag at high zoom could
// make Fit frame the board at nothing.

// ---------------------------------------------------------------------------
// What each mode carries
// ---------------------------------------------------------------------------
//
// One variant per mode, so no branch can read a field of another mode. `press`
// is two variants, told apart by `intent`.

/** Nothing is happening - and still an object. See `gesture` in initInput(). */
type IdleGesture = { mode: 'idle' };

/** A grip press, waiting to see whether the pointer travels. */
type ResizePress = {
  mode: 'press',
  intent: 'resize',
  id: string,
  // Which of the eight, off the handle's own data-g.
  corner: string | undefined,
  x: number,
  y: number,
  node: Element | null,
};

/** The second tap of a touch double-tap, waiting to become a band. */
type MarqueePress = {
  mode: 'press',
  intent: 'marquee',
  clientX: number,
  clientY: number,
  x0: number,
  y0: number,
};

/** Where a panning finger was, and when - see trackPan() and flingFrom(). */
type PanSample = { x: number, y: number, t: number };

type PanGesture = {
  mode: 'pan',
  lastX: number,
  lastY: number,
  // Only a finger throws the board, so only a finger keeps a track: no track is
  // "this pan cannot fling". See startPan().
  track?: PanSample[],
};

/** `raw` is the zoom the fingers are asking for, unclamped - see Viewport.pinchTo(). */
type PinchGesture = { mode: 'pinch', dist: number, mid: Point, raw: number };

type MarqueeGesture = {
  mode: 'marquee',
  x0: number, y0: number, x1: number, y1: number,
  additive: boolean,
  // The selection the band started from. Non-null exactly when `additive` is
  // (startMarquee() sets both); applyMarquee() relies on it.
  base: string[] | null,
  // Drawn with Z held: a box to zoom into, which selects nothing - see zoomInto().
  zoom?: boolean,
};

/** One item's place and size when the drag began. */
type MoveOrigin = { id: string, x: number, y: number, w: number, h: number };

type MoveGesture = {
  mode: 'move',
  id: string,
  lead: string,
  moving: string[],
  before: GeomSnap[],
  start: Point,
  origin: MoveOrigin[],
  // The lead's start geometry, found once from `origin`.
  leadOrigin: MoveOrigin,
  moved: boolean,
  driven: string[],
  // Whether this drag lands on the lattice, frozen at the press so toggling
  // snapping mid-drag cannot split the drag's cards. See snapLowFor().
  snap: boolean,
  // What the press found, read at the lift (`unpick` in endPointer()). The only
  // fields enter() does not lay down.
  additive?: boolean,
  wasSelected?: boolean,
  // Alt held at the press, on a mouse: the drag carries a copy and leaves the
  // originals. `copied` is the Duplicate entry once the copy is made, at the
  // slop, so the release can fold it and the move into one step.
  alt?: boolean,
  copied?: Command | null,
};

/** One item's whole geometry, which is what a resize writes for each of them. */
type ResizeTarget = {
  id: string, x: number, y: number, w: number, h: number, rot: number, z: number,
};

/** A rider a resize carries, and the box it is being carried from. */
type ResizeFollower = { id: string, box: Omit<ResizeTarget, 'id'> };

type ResizeGesture = {
  mode: 'resize',
  id: string,
  corner: string | undefined,
  node: Element | null,
  before: GeomSnap[],
  followers: ResizeFollower[],
  driven: string[],
  start: Point,
  /** `rot` the angle at the press, which a sticker comes back to - see leanAtSize(). */
  box: { x: number, y: number, w: number, h: number, rot?: number },
  // A fence's carry, and null for everything else - see carryPlace(). One per
  // card standing in the fence itself; `carried` maps every follower to the
  // index of the card it goes with (itself, its host, or the nested fence it is
  // in), or -1 for one that keeps its plain fraction.
  holds: CarryHold[] | null,
  carried: number[] | null,
  plate: number,
  lockAspect: boolean,
  // A picture card's own proportion, held whatever Shift says; null otherwise,
  // or before the picture is measured (its box is held instead).
  picture: number | null,
  // The lattice size a held proportion last landed on, null until it has.
  cells: { w: number, h: number } | null,
  // Whether this grip snaps, frozen at the press. See startResize().
  snap: boolean,
};

/** A pen stroke (canvas/pen.ts holds its points). `stylus` is whether a
 *  pen is drawing it, which is when a resting palm is ignored. */
type StrokeGesture = { mode: 'stroke', pointerId: number, stylus: boolean };

/** The one gesture, whichever mode it is in. */
type Gesture =
  | IdleGesture | ResizePress | MarqueePress | PanGesture
  | PinchGesture | MarqueeGesture | MoveGesture | ResizeGesture | StrokeGesture;

/** The variant - or, for `press`, the two variants - that answer to `mode`. */
type GestureOf<M extends GestureMode> = Extract<Gesture, { mode: M }>;

/** A gesture's fields without `mode`, as enter() takes them. Distributive,
 *  since Omit over a union keeps only the shared keys. */
type GestureData<G> = G extends Gesture ? Omit<G, 'mode'> : never;

/** Pointer state that is not a gesture: each outlives one. See their bindings
 *  in initInput(). */
type MidPaste = { down: boolean, at: Point | null, dragged: boolean };

type Hold = {
  timer: ReturnType<typeof setTimeout> | 0,
  /** Puts the held card's shrink on after a moment's stillness - setPressing(). */
  press: ReturnType<typeof setTimeout> | 0,
  at: (Point & { id: string | null }) | null,
  menu: TapPoint | null,
};

type Taps = {
  arm: (Point & { pointerId: number, id: string, additive: boolean }) | null,
  card: (Point & { pointerId: number, id: string, slop: number }) | null,
  empty: (Point & { pointerId: number }) | null,
  lastEmpty: TapPoint | null,
  lastTitle: TapPoint | null,
};

/** The commands this pipeline uses, handed in by main.ts because canvas/ may
 *  not import ui/. Optional members are called with `?.`. */
type InputCommands = {
  selectAll(): void,
  undo(): void,
  redo(): void,
  duplicate(): void,
  save(): void,
  saveAs(): void,
  export(): void,
  open(): void,
  deleteSelection(): void,
  recenter(): void,
  fit(): void,
  /** Whether a sheet was open, or the connector tool armed. */
  closeSidebar(): boolean,
  editNote(id: string): void,
  editConnectionLabel(a: string, b: string): void,
  fencePrompt(x: number, y: number, rect: Bounds): void,
  contextMenu(x: number, y: number, id: string | null, count: number,
    opts?: { touch?: boolean }): void,
  /** The S box (ui/palette.ts), at a point in the window or the board's middle. */
  palette?(x?: number, y?: number): void,
  // The flag is read from state.ts; this is only Escape's way out.
  toggleMultiSelect?(): void,
  /** Turn the multi-select mode on with this card added - a hold on a second card. */
  holdToPick?(id: string): void,
  connectTap?(id: string | null, sticky?: boolean): boolean,
  connectionUnder?(at: Point): { a: string, b: string } | null,
  /** Whether there was a line under the point to mark. */
  pickConnection?(at: Point): boolean | void,
  /** Whether a line was marked. */
  clearActiveConnection?(): boolean,
  deleteActiveConnection?(): boolean,
  editTitle?(): void,
  editTitleText?(): void,
  editFontText?(id: string): void,
  openViewer?(id: string): void,
  playPause?(): boolean,
  /** Open the sidebar on the keyboard legend - the '?' key. */
  shortcuts?(): void,
  /** Shift+F and 1: frame the selection, and 100% where the view is. */
  zoomToSelection?(): void,
  zoomActual?(): void,
  // The single keys: N, J, L, ] and [, and Ctrl+G. Each is the command its
  // menu row or toolbar button already runs.
  addNoteAt?(at: Point | null): void,
  connect?(): void,
  /** D: drawing mode on or off - the toolbar's Draw button. */
  draw?(): void,
  /** Double-click or Enter on a board card: into the board it holds. */
  openBoard?(id: string): void,
  /** A drag held over a board card and let go: these cards inside it. */
  dropIntoBoard?(ids: readonly string[], cardId: string): void,
  /** Alt+Shift+Up: back out to the board holding this one. */
  canLeaveBoard?(): boolean,
  leaveBoard?(): Promise<void>,
  toggleAnchor?(): void,
  raise?(): void,
  lower?(): void,
  fenceSelection?(): void,
  /** Ctrl+Shift+G: ungroup - the fence round the selection taken away. */
  unfenceSelection?(): void,
  // The tour's keys, answering whether they took the press.
  tourStop?(): boolean,
  tourStep?(delta: number): boolean,
  tourEditStop?(): boolean,
  // A click on bare board is the next stop while a tour runs (tourClick).
  inTour?(): boolean,
  // The tour editor: cards hold still, and Delete takes the picked stop off
  // the tour rather than binning a card.
  tourEditing?(): boolean,
  tourEditDelete?(): boolean,
  // The konami easter egg (ui/clean/). cleanFeed sees every key and answers
  // true on the one that opens it; the rest let the mode own the keyboard, and
  // cleanEscape puts the tool down before it asks to leave.
  cleanFeed?(key: string): boolean,
  cleanActive?(): boolean,
  cleanKey?(key: string): boolean,
  cleanSpace?(down: boolean): void,
  cleanEscape?(): boolean,
};

export function initInput(vp: Viewport, cmds: InputCommands): void {
  const el = vp.el;
  // Declared in index.html; absent is a broken build, not a state to recover from.
  const marquee = document.getElementById('marquee')!;

  /** pointerId -> latest client position, for multi-touch bookkeeping. */
  const pointers = new Map<number, Point>();

  /**
   * The one gesture: its mode and that mode's working state. Never null (idle
   * is `{ mode: 'idle' }`). Only enter() assigns it, replacing the whole object,
   * so an ended gesture's fields cannot leak into the next. The current mode's
   * own fields are mutated freely; `mode` has one writer.
   */
  let gesture: Gesture = { mode: 'idle' };

  /**
   * Move into `mode`, carrying `data` as its state. An illegal transition warns
   * and proceeds: refusing would wedge a real hand, which is worse.
   *
   * Known bug reaching the warning: a middle press during a left drag lands in
   * the pan branch over a standing move, dropping it with no commit.
   */
  function enter<M extends GestureMode>(
    mode: M,
    // Optional only for `idle`; every other mode's data is required.
    data?: GestureData<GestureOf<M>>,
  ): GestureOf<M> {
    if (!gestureTransition(gesture.mode, mode)) {
      console.warn(`[mbrd] input: ${gesture.mode} -> ${mode} is not a gesture this pipeline makes`);
    }
    // SAFETY: `data` is the variant minus `mode`, checked at the call; tsc only
    // cannot fold the generic spread back into the union member.
    const next = { mode, ...data } as GestureOf<M>;
    gesture = next;
    // Set here, the only door between modes, so every way out of a pan or a
    // move clears them: whether a Mobile board's edges clamp or resist, and
    // whether line routes are held until the drop (holdRoutes() in canvas/web.ts).
    vp.dragging = mode === 'pan';
    holdRoutes(mode === 'move');
    return next;
  }

  let spaceDown = false;
  // The Control key, pressed on the keyboard. A pinch sets ctrlKey on its
  // wheel events without one, so this is how readWheel() tells them apart.
  let ctrlDown = false;
  // Z held: the zoom box is armed, the way Space arms the pan. Cleared on the
  // keyup and on a blur, as Space is.
  let zDown = false;
  /**
   * A right press: a drag pans, a click opens the menu. Outlives the gesture
   * because `contextmenu` arrives on the press on macOS and Linux and after the
   * lift on Windows. `owed` is a menu that came on the press and waits for the
   * lift; `hit` is read at the press, before capture retargets the event.
   */
  let rightPress: { pointerId: number, x: number, y: number, hit: string | null,
    dragged: boolean, owed: boolean } | null = null;
  /** When a right drag ended, so Windows' contextmenu after its lift is swallowed. */
  let rightDragAt = 0;
  // A middle click pastes the primary selection on Linux/X11, which should
  // still work, but a middle drag pans and its release paste must be swallowed.
  // Outlives the gesture: the paste arrives a task after the pan ends.
  const midPaste: MidPaste = { down: false, at: null, dragged: false };
  // Where the cursor is, for a paste to land under. Null on touch.
  let hover: Point | null = null;
  // A long press is touch's right-click. Outside the gesture so a second
  // finger can replace the gesture and still cancel it. `menu` is the menu a
  // hold opened, so a native contextmenu after it is not taken for a new one.
  const hold: Hold = { timer: 0, press: 0, at: null, menu: null };
  // A touch press on bare board clears the selection on the lift, not the
  // press, because the same press may become the hold that opens the board
  // menu for that selection. Null on a mouse, which clears on the press.
  let clearOnLift: number | null = null;
  /** Where a bare-board press began with two or more cards picked. A group is
   *  costly to rebuild, so it clears only on a tap; a press that travels
   *  past the slop calls it off. */
  let clearIfStill: { x: number, y: number } | null = null;
  /** A press inside a fence, with nothing picked, that picks the fence if it
   *  lifts where it went down. The body refuses the pointer (fences.css) so a
   *  drag pans or bands; only the name bar moves a fence. */
  let fenceIfStill: { pointerId: number, x: number, y: number } | null = null;
  /** A press that walks a tour on if it lifts within TAP_MOVE_SLOP: a click off
   *  any card is "next stop", while a drag still pans. Coexists with the pan. */
  let tourClick: { pointerId: number, x: number, y: number } | null = null;
  // Presses that may still be taps, and taps just past. Not modes: they
  // coexist with a live gesture, and the last two outlive it.
  //
  //   arm ......... resting on an unpicked item (needsTapFirst()); the gesture
  //                 is a pan, and an unmoved lift still counts as a tap.
  //   card ........ a press on a card's surface, on either path; only a playing
  //                 video uses it (pauseOnTap()).
  //   empty ....... a touch on bare board, maybe the first of a double tap.
  //   lastEmpty ... that tap, waiting for its second.
  //   lastTitle ... the last tap on the title card, for double-tap rename. Not a
  //                 dblclick listener, since pointer capture retargets those.
  const taps: Taps = { arm: null, card: null, empty: null, lastEmpty: null, lastTitle: null };
  const cancelPress = () => {
    clearTimeout(hold.timer);
    clearTimeout(hold.press);
    hold.timer = hold.press = 0;
    hold.at = null;
    setPressing(null);
  };

  /** A tap on a playing video pauses it. Pause only: a tap also selects, and a
   *  toggle would start a video every time it was picked up. */
  const pauseOnTap = (id: string) => {
    const item = byId(id);
    if (item?.type !== 'video') return;
    const media = nodeFor(id)?.querySelector('video');
    if (media && !media.paused) media.pause();
  };

  /** Whether a press on this item pans rather than picks it up. Moving takes
   *  select then drag, so panning over a card never rearranges the board. */
  const needsTapFirst = (id: string) => needsSelectionBeforeMove(selection, id);

  // ---- helpers ----------------------------------------------------------

  /** A low edge onto the lattice when `snap`, which a drag freezes at its start. */
  const snapLowFor = (v: number, snap: boolean) => (snap ? latticeLow(v, stepNow()) : v);

  // The lattice at 100%, never the zoom-coarsened dots on screen (gridStep()),
  // or an item dragged at one zoom would sit off its lines at another.
  const stepNow = () => baseStep();

  /** A box laid on the lattice as snapAll() lays the board: position and size
   *  both, since an edge on a line with a side 1.5 cells long still misses. */
  const ontoLattice = (box: Box) => latticeBox(box, stepNow());

  /**
   * The seam a snapped item leaves at each edge (CELL_GAP in geometry.ts): a
   * low edge sits a seam past its line, a high edge a seam short. `snap` is
   * passed, not read, so the seam and the step come from the one decision a
   * grip freezes at the press; read live, toggling snap mid-resize put edges
   * one seam off the lattice.
   */
  const insetFor = (snap: boolean) => (snap ? cellInset(stepNow()) : 0);

  /** A pixel floor (a note's text, embedFloor) rounded up to a whole cell when
   *  snapping, so the floored size stays on the lattice. */
  const snapFloorUp = (floor: number, snap: boolean) => {
    if (!snap) return floor;
    const step = stepNow(), gap = 2 * insetFor(snap);
    return Math.ceil((floor + gap) / step) * step - gap;
  };

  /** The cards a fence carries through a resize, put back on the lattice by
   *  their low edges. A stuck note takes its host's shift, so it stays put on it. */
  function snapCarried(riders: ResizeTarget[]) {
    const byRider = new Map(riders.map(r => [r.id, r]));
    const shifts = new Map<string, Point>();
    const shiftOf = (r: ResizeTarget): Point => {
      const known = shifts.get(r.id);
      if (known) return known;
      // Held at nothing while the host is asked, so a loop of notes ends here.
      shifts.set(r.id, { x: 0, y: 0 });
      const host = stuckTo(byId(r.id));
      const carrier = host ? byRider.get(host.id) : undefined;
      const low = { x: r.x - r.w / 2, y: r.y - r.h / 2 };
      const shift = carrier
        ? shiftOf(carrier)
        : { x: snapLowFor(low.x, true) - low.x, y: snapLowFor(low.y, true) - low.y };
      shifts.set(r.id, shift);
      return shift;
    };
    for (const r of riders) {
      const shift = shiftOf(r);
      r.x += shift.x;
      r.y += shift.y;
    }
  }

  /** resizeAxisOn() against this board's step and seam. */
  const resizeAxis = (
    sign: number, centre: number, extent: number, travel: number, snap: boolean,
  ) => resizeAxisOn(sign, centre, extent, travel, snap, stepNow(), insetFor(snap));

  function setPanCursor() {
    // Not during a tour, where nothing pans.
    el.classList.toggle(
      'can-pan', spaceDown && gesture.mode === 'idle' && !cmds.inTour?.(),
    );
    // Z held: the magnifier, the whole time the box is armed or being drawn.
    el.classList.toggle('can-zoom', zoomArmed());
  }

  /** Whether a press now draws a zoom box. Not on the Feed, whose zoom is locked to its width. */
  const zoomArmed = () => zDown && !spaceDown && !vp.isMobile && !vp.zoomLocked && !cmds.inTour?.();

  /**
   * The end of a Z press: a box drawn frames that box, and a click zooms in by
   * two about the point - out with Alt, as every zoom tool since Photoshop's.
   */
  function zoomInto(band: MarqueeGesture, clientX: number, clientY: number, out: boolean) {
    if (drewRectangle(band, vp.zoom)) {
      const x0 = Math.min(band.x0, band.x1), x1 = Math.max(band.x0, band.x1);
      const y0 = Math.min(band.y0, band.y1), y1 = Math.max(band.y0, band.y1);
      vp.fit([{ x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 }], 0, zoomMs());
    } else {
      vp.zoomAnimAt(clientX, clientY, out ? 0.5 : 2, zoomMs());
    }
  }

  function startPan(e: PointerEvent) {
    const pan = enter('pan', { lastX: e.clientX, lastY: e.clientY });
    // Only a finger throws the board (flingFrom()); a mouse stops where it lifts.
    if (e.pointerType === 'touch') pan.track = [];
    el.classList.add('is-panning');
  }

  /** The window a flick's speed is measured over. The last event alone is a
   *  pixel over a millisecond, pure noise; this averages it out while still
   *  describing the throw, not the whole drag. */
  const FLING_WINDOW_MS = 90;
  /** A finger that has been still this long before lifting is not throwing. */
  const FLING_IDLE_MS = 70;

  // Takes the track, not the pan: only a finger's pan has one.
  function trackPan(track: PanSample[], e: PointerEvent) {
    track.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    while (track.length > 2 && e.timeStamp - track[0].t > FLING_WINDOW_MS) track.shift();
  }

  /** The speed to hand the board as the finger leaves, or null if it paused
   *  before lifting (it placed the board). A slow drag is caught by glide()'s floor. */
  function flingFrom(pan: PanGesture, at: number) {
    if (!pan.track || pan.track.length < 2) return null;
    const last = pan.track[pan.track.length - 1];
    if (at - last.t > FLING_IDLE_MS) return null;
    const first = pan.track[0];
    const dt = (last.t - first.t) / 1000;
    if (!(dt > 0)) return null;
    return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
  }

  function startMarquee(e: PointerEvent) {
    const p = vp.toWorld(e.clientX, e.clientY);
    // An additive band freezes the selection it started from and re-unions it
    // with what it encloses each frame, so a card the band leaves is released.
    const band = enter('marquee', {
      x0: p.x, y0: p.y, x1: p.x, y1: p.y,
      additive: e.shiftKey, base: e.shiftKey ? [...selection] : null,
    });
    marquee.hidden = false;
    drawMarquee(band);
    // On the press too, so a still modified click and a wobbly one agree.
    applyMarquee(band);
  }

  function drawMarquee(band: MarqueeGesture) {
    // Screen top-left is world (min x, max y): world y points up.
    const a = vp.toScreen(Math.min(band.x0, band.x1), Math.max(band.y0, band.y1));
    const b = vp.toScreen(Math.max(band.x0, band.x1), Math.min(band.y0, band.y1));
    marquee.style.left = a.x + 'px';
    marquee.style.top = a.y + 'px';
    marquee.style.width = (b.x - a.x) + 'px';
    marquee.style.height = (b.y - a.y) + 'px';
  }

  function applyMarquee(band: MarqueeGesture) {
    if (band.zoom) return;
    const x0 = Math.min(band.x0, band.x1), x1 = Math.max(band.x0, band.x1);
    const y0 = Math.min(band.y0, band.y1), y1 = Math.max(band.y0, band.y1);
    // The spatial index narrows the field to a superset; marqueeHit decides.
    const hit: string[] = [];
    // A card folded away in a rolled-up fence is out of sight, so out of reach.
    const rolled = rolledFences();
    for (const id of queryRect({ x0, y0, x1, y1 })) {
      const it = byId(id);
      if (it && !rolledAway(it, rolled) && marqueeHit(it, x0, y0, x1, y1)) hit.push(id);
    }
    // `base!`: an additive band always has one (startMarquee()).
    if (band.additive) select([...new Set([...band.base!, ...hit])]);
    else select(hit);
  }

  /**
   * Take hold of what the press landed on, or null if nothing can be held: a
   * pinned sticker on a locked photograph resolves to the locked root and is
   * dropped. The caller then pans, as a press on the photograph does; an empty
   * move used to throw on every pointermove and wedge the pipeline.
   */
  function startMove(e: PointerEvent, id: string, own = false): MoveGesture | null {
    // The top of the pile an id sits in, or the id itself. `own` (Alt on a
    // stuck note) takes the note itself off its host.
    const rootOf = (sid: string) => {
      const it = byId(sid);
      return it && !own ? dragRoot(it).id : sid;
    };
    // A press on a pinned item drags its host, the pile as one object, as the
    // hover lift already shows. The selection is not touched: clicking a
    // pinned star still selects the star, for its menu and Delete.
    //
    // Across the whole selection, deduped. Locked cards drop out here rather
    // than at the press, so a mixed selection still moves its free cards; a
    // press on a locked card itself pans (onDown()).
    const roots = [...new Set([...selection].map(rootOf))].filter(sid => !isLocked(byId(sid)));
    // What is stuck to or fenced by the roots, fixed for the whole gesture so
    // notes do not latch on and off mid-drag (travelling() in layout.ts). Not
    // filtered for locks again: a locked card in a dragged fence goes with it.
    const moving = travelling(roots);
    // Before anything is touched, so the raise shares the move's undo entry.
    const before = snapshotGeom(moving);
    // Tested on `before`: snapshotGeom() answers only for ids still on the board.
    if (!before.length) return null;
    const start = vp.toWorld(e.clientX, e.clientY);
    const lead = rootOf(id);
    // Sizes too: snapping puts the lead's low edges on lines.
    const origin = before.map(b => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h }));
    const leadOrigin = origin.find(o => o.id === lead) || origin[0];
    const move = enter('move', {
      // `id` is what was pressed (a modified click peels it); `lead` is what is
      // held (the drag and stick preview read it). They differ on a pinned item.
      id, lead, moving, before, start,
      // Frozen here, like the grip's - see MoveGesture.snap.
      snap: board.settings.snap,
      origin,
      leadOrigin,
      moved: false,
      // Only the roots re-ask what they are stuck to on release (restick() in
      // state.ts); towed items have not moved relative to their hosts.
      driven: roots,
    });
    for (const sid of moving) ensureMounted(sid);
    // Returned so onDown() can write what the press found onto it.
    return move;
  }

  /** Alt+drag: copy what is held in place and drag the copies, so the
   *  originals keep their lines, tour stops and playlist places. The release
   *  folds copy and move into one undo step (releaseGesture()). */
  function carryCopies(drag: MoveGesture) {
    const was = lastCommand();
    const copyOf = duplicateInPlace(drag.driven);
    const made = lastCommand();
    if (!copyOf.size || made === was) return;
    const to = (id: string) => copyOf.get(id) ?? id;
    drag.copied = made;
    drag.id = to(drag.id);
    drag.lead = to(drag.lead);
    drag.driven = drag.driven.map(to);
    drag.moving = drag.moving.map(to);
    drag.before = snapshotGeom(drag.moving);
    drag.origin = drag.before.map(b => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h }));
    drag.leadOrigin = drag.origin.find(o => o.id === drag.lead) || drag.origin[0];
    for (const sid of drag.moving) ensureMounted(sid);
    select([...selection].map(to));
  }

  /** Bring the gesture's items to the front, on the first movement past the
   *  slop rather than the press, so a plain click never changes z without an
   *  undo entry. */
  function raiseToFront(ids: string[]) {
    // Bottom-to-top, so a stuck note stays above its host and stays stuck.
    let z = topZ();
    // Guarded: an id may have been deleted elsewhere since the press.
    for (const sid of stackOrder(ids)) { const it = byId(sid); if (it) it.z = ++z; }
    bus.emit('geom', ids);
  }

  function startResize(
    e: PointerEvent,
    id: string,
    corner: string | undefined,
    origin: ResizePress | null = null,
  ) {
    const it = byId(id);
    if (!it) return;
    const before = snapshotGeom([id]);
    // Marked so its corner marks stay swollen through the drag; hover fails
    // once capture moves to #viewport.
    const node = origin?.node
      || (e.target instanceof Element ? e.target.closest('.item') : null);
    node?.classList.add('is-resizing');
    // A sticky lying on something is sized off the lattice: it belongs to its
    // host, and a snapped corner would pull it off. stuckTo(), not isPinned(),
    // so a sticker still settling counts. Frozen with the grip.
    const snap = board.settings.snap && !stuckTo(it);
    // Squared onto the lattice first, so the edge left behind is on a line too
    // and the result is whole cells. After `before`, so one undo restores it.
    const box = snap
      ? ontoLattice(it)
      : { x: it.x, y: it.y, w: it.w, h: it.h };
    if (box.x !== it.x || box.y !== it.y || box.w !== it.w || box.h !== it.h) {
      applyGeom([{ id, ...box, rot: it.rot, z: it.z }]);
    }
    // Riders keep their fractional spot through the resize (stuckPlacement per
    // frame): notes stuck to a card, and the contents of a fence, which gather
    // and spread as it is pulled in and out. travelling() for a fence, so a note
    // on a card inside comes too, the same set a move would carry. Desktop
    // only: on Mobile a band's cards sit below it, not inside.
    //
    // In `before` for one undo, but not `driven`: riders kept their place, so
    // their stick is not re-measured on release.
    const riders = isFence(it) && board.layoutMode !== 'mobile'
      ? travelling([id]).filter(rid => rid !== id)
      : stuckFollowers([id]);
    // `byId(rid)!`: read off the live board on the line above.
    const followers: ResizeFollower[] = riders.map(rid => {
      const r = byId(rid)!;
      return { id: rid, box: { x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot, z: r.z } };
    });
    for (const rid of riders) ensureMounted(rid);
    // A fence keeps its own cards inside its walls (CarryHold), frozen with the
    // grip. A card's stuck notes have no walls: a sticky may hang over an edge.
    // Anything nested goes with the card or fence it belongs to.
    const carrying = isFence(it) && board.layoutMode !== 'mobile';
    const plate = carrying ? barHeight(id) : 0;
    let holds: CarryHold[] | null = null;
    let carried: number[] | null = null;
    if (carrying) {
      const room = { x: it.x, y: it.y, w: it.w, h: it.h, plate };
      const index = new Map<string, number>();
      const list: CarryHold[] = [];
      for (const f of followers) {
        const r = byId(f.id);
        if (!r || stuckTo(r) || fenceOf(r)?.id !== id) continue;
        index.set(f.id, list.length);
        list.push(carryHold(f.box, room));
      }
      // Bounded: a sticky and a fence chain are both strict orders, so the walk
      // ends at a card in this fence or at nothing, and never loops.
      const rootOf = (fid: string) => {
        let at = byId(fid);
        for (let k = 0; at && k < 64; k++) {
          const hit = index.get(at.id);
          if (hit !== undefined) return hit;
          at = stuckTo(at) ?? fenceOf(at) ?? undefined;
        }
        return -1;
      };
      holds = list;
      carried = followers.map(f => rootOf(f.id));
    }
    enter('resize', {
      id, corner, node,
      before: followers.length ? before.concat(snapshotGeom(riders)) : before,
      followers,
      // A resize changes overlap, so the item re-asks its stick; riders do not.
      driven: [id],
      start: vp.toWorld(origin?.x ?? e.clientX, origin?.y ?? e.clientY),
      box: { x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot || 0 },
      holds, carried, plate,
      // Only a picture locks its aspect by default, and Shift does not free it:
      // its card is its picture's shape (picture-shape.ts). Everything else
      // locks with Shift. On the grid the pair lands on the nearest whole cells.
      lockAspect: isPicture(it),
      picture: isPicture(it) ? cardRatio(it) : null,
      cells: null,
      snap,
    });
  }

  // ---- pointer pipeline -------------------------------------------------

  el.addEventListener('pointerdown', e => {
    // A right press pans or opens the menu (rightPress). Only from idle (a
    // chorded right button arrives as a pointermove), and not in a tour, the
    // cleaning mode, or a text field, which own their right-click.
    if (e.button === 2 && e.pointerType === 'mouse' && gesture.mode === 'idle'
        && !pointers.size && !cmds.inTour?.() && !cmds.cleanActive?.()
        && !(e.target instanceof Element && e.target.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]'))) {
      vp.onPress();
      rightDragAt = 0;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      rightPress = {
        pointerId: e.pointerId, x: e.clientX, y: e.clientY,
        hit: itemIdFromEvent(e.target instanceof Element ? e.target : null), dragged: false, owed: false,
      };
      capturePointerSafely(el, e.pointerId);
      return;
    }
    // Right/aux: leave alone. A pen's barrel button is its right-click.
    if (e.button > 1 && (e.pointerType === 'mouse' || e.pointerType === 'pen')) return;
    // A palm resting while a stylus draws is ignored entirely, so it cannot pinch.
    if (e.pointerType === 'touch' && gesture.mode === 'stroke' && gesture.stylus) return;
    // A hand on the board stops a glide or a flight at once, even a finger that
    // never moves. Not in a tour, whose view is the tour's.
    if (!cmds.inTour?.()) vp.onPress();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Two fingers in a tour do not pinch. Captured, so the lift still removes
    // the pointer (see below).
    if (pointers.size >= 2 && cmds.inTour?.()) {
      capturePointerSafely(el, e.pointerId);
      return;
    }

    // A second finger drops the standing gesture to idle, then pinches.
    if (pointers.size === 2) {
      cancelPress();
      taps.empty = null;
      taps.lastEmpty = null;
      taps.arm = null;
      taps.card = null;
      // A pinch is a zoom, and a zoom is not an answer about what is selected.
      clearOnLift = null;
      abortGesture();
      // Captured, or its lift over other chrome never reaches endPointer(), the
      // id leaks in `pointers`, and every later tap pinches.
      capturePointerSafely(el, e.pointerId);
      const [a, b] = [...pointers.values()];
      enter('pinch', {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        raw: vp.zoom,
      });
      return;
    }
    // A third finger: captured for the same leak.
    if (pointers.size > 2) {
      capturePointerSafely(el, e.pointerId);
      return;
    }

    let target = e.target instanceof Element ? e.target : null;
    // An HTMLElement for `dataset.g`, which names the corner (item-dom.ts).
    let grip = target?.closest<HTMLElement>('.grip') || null;
    // A corner grip paints over the card, so look past it: if a GRIP_YIELD
    // control is under the point, it takes the press.
    if (grip) {
      for (const node of document.elementsFromPoint(e.clientX, e.clientY)) {
        if (!(node instanceof Element) || node.classList.contains('grip')) continue;
        if (node.closest(GRIP_YIELD)) { grip = null; target = node; }
        break;
      }
    }
    const id = itemIdFromEvent(target);
    // Play on the Timeline: the four claims below all edit, so none is asked.
    const viewOnly = timelinePlaying();
    // The armed connector tool: a press picks an end and claims the gesture,
    // ahead of every branch, widgets included. One branch, not a second
    // pipeline, so picking completes on the press. Shift keeps the tool armed
    // for the next pair (ui/toolbar.ts); read off the event, since pressIntent()
    // has not run.
    if (!viewOnly && cmds.connectTap?.(id, e.shiftKey)) {
      pointers.delete(e.pointerId);
      return;
    }
    // Drawing mode (canvas/pen.ts): a press anywhere draws, from the press with
    // no slop, so a dot is a stroke. Space, middle and two fingers still move
    // the board.
    if (!viewOnly && penOn() && e.button === 0 && !spaceDown
        && !cmds.inTour?.() && !cmds.tourEditing?.()) {
      e.preventDefault();
      capturePointerSafely(el, e.pointerId);
      cmds.clearActiveConnection?.();
      enter('stroke', { pointerId: e.pointerId, stylus: e.pointerType === 'pen' });
      beginStroke(vp.toWorld(e.clientX, e.clientY), pressureOf(e), id, e.timeStamp);
      return;
    }
    // The title card's pen opens the style panel and claims the press, ahead of
    // the widget branch, which would only select the card.
    if (!viewOnly && target?.closest('.item-pen')) {
      cmds.editTitle?.();
      pointers.delete(e.pointerId);
      return;
    }
    // A double tap on the title card edits its name; the first tap selects as usual.
    if (!viewOnly && id && byId(id)?.type === 'title') {
      const now = e.timeStamp;
      const last = taps.lastTitle;
      if (last && now - last.at <= DOUBLE_TAP_MS
          && Math.hypot(e.clientX - last.x, e.clientY - last.y) <= DOUBLE_TAP_SLOP) {
        taps.lastTitle = null;
        cmds.editTitleText?.();
        pointers.delete(e.pointerId);
        return;
      }
      taps.lastTitle = { x: e.clientX, y: e.clientY, at: now };
    } else {
      // Any other press in between breaks the double tap.
      taps.lastTitle = null;
    }
    // A control inside a card owns the gesture, uncaptured, or capture would
    // leave it dead. A bare <video> is not one (dragging the picture drags the
    // card); .model-stage is (a drag turns the model).
    const widget = target?.closest('audio, video[controls], input, button, a, .wave, .model-stage, [contenteditable="true"], [contenteditable="plaintext-only"]');
    const tap = { x: e.clientX, y: e.clientY, at: e.timeStamp };
    const doubleTapDrag = e.pointerType === 'touch' && !id && !widget
      && isDoubleTap(taps.lastEmpty, tap);
    if (e.pointerType === 'touch') {
      if (doubleTapDrag || id || widget) taps.lastEmpty = null;
      taps.empty = !doubleTapDrag && !id && !widget
        ? { pointerId: e.pointerId, x: e.clientX, y: e.clientY }
        : null;
    }
    // The primary button only: right opens the tour's menu, middle pastes.
    tourClick = cmds.inTour?.() && e.button === 0 && !id && !widget
      ? { pointerId: e.pointerId, x: e.clientX, y: e.clientY }
      : null;

    // Decided once by pressIntent(); everything below only performs it.
    const intent = pressIntent({
      pointerType: e.pointerType,
      button: e.button,
      // Multi-select mode reads as a held modifier.
      additive: e.shiftKey || e.ctrlKey || e.metaKey || isMultiSelect(),
      picking: isMultiSelect() && !(e.shiftKey || e.ctrlKey || e.metaKey),
      spaceDown,
      zoomBox: zoomArmed() && e.pointerType !== 'touch',
      onWidget: !!widget,
      onGrip: !!grip,
      onCard: id,
      // The tour editor holds every card as if anchored.
      locked: !!id && (isLocked(byId(id)) || !!cmds.tourEditing?.()),
      // isPinned(), not stuckTo(): a settling sticker keeps its grips, by the
      // same clock canvas/items.ts draws them by.
      pinned: !!id && isPinned(byId(id)),
      needsTapFirst: !!id && needsTapFirst(id),
      wasSelected: !!id && selection.has(id),
      selectionSize: selection.size,
      doubleTapDrag,
      isMobile: vp.isMobile,
      touring: !!cmds.inTour?.(),
      viewOnly,
    });

    // The pick sound, for every press that takes hold of a card, grips and
    // widgets included. A gated first tap sounds on the lift (endPointer()).
    if (intent.kind === 'widget' || intent.kind === 'resize'
        || intent.kind === 'move' || intent.kind === 'lockedPan') {
      cue('pick');
    }

    if (intent.kind === 'widget') {
      // A tour mark on a card already in the selection speaks for the whole
      // selection (ui/tour-edit.ts press()), so its press must leave it whole.
      const forSelection = !!widget?.closest('.tour-mark') && !!id && selection.has(id);
      if (id && !forSelection) select([id]);
      pointers.delete(e.pointerId);
      return;
    }

    capturePointerSafely(el, e.pointerId);

    // Any press unmarks the marked line; the branch that wants one marks it again.
    cmds.clearActiveConnection?.();

    if (intent.kind === 'zoomBox') {
      // A band that selects nothing; zoomInto() acts on the lift.
      e.preventDefault();
      const p = vp.toWorld(e.clientX, e.clientY);
      const band = enter('marquee', {
        x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: false, base: null, zoom: true,
      });
      marquee.hidden = false;
      drawMarquee(band);
    } else if (intent.kind === 'frozen') {
      // Does nothing, but stays captured: the lift walks the tour (tourClick)
      // and a hold opens its menu. preventDefault stops a text selection or drag.
      e.preventDefault();
    } else if (intent.kind === 'pan') {
      if (intent.middle) {
        midPaste.down = true;
        midPaste.dragged = false;
        midPaste.at = { x: e.clientX, y: e.clientY };
      }
      e.preventDefault();
      startPan(e);
    } else if (intent.kind === 'resize') {
      // Only a candidate until it moves past the slop, so a tap on a corner
      // never touches geometry. A multi-selection never gets here: a grip press
      // on one moves the group (pressIntent()).
      enter('press', {
        intent: 'resize',
        id: intent.id,
        // 'resize' implies onGrip, so `grip` is set.
        corner: grip!.dataset.g,
        x: e.clientX,
        y: e.clientY,
        node: target?.closest('.item') ?? null,
      });
    } else if (intent.kind === 'marqueeDrag') {
      // Wait for movement; a plain double tap does nothing.
      const p = vp.toWorld(e.clientX, e.clientY);
      enter('press', {
        intent: 'marquee', clientX: e.clientX, clientY: e.clientY, x0: p.x, y0: p.y,
      });
    } else if (intent.kind === 'tapGate') {
      // Touch, or the mobile layout: a finger navigates more than it drags, so a
      // press on an unpicked card pans and selects on the lift. A desktop mouse
      // grabs at once (the move branch). Nothing is selected yet, so a drag
      // leaves the board as a press on empty space would.
      taps.arm = {
        pointerId: e.pointerId,
        id: intent.id,
        x: e.clientX,
        y: e.clientY,
        additive: intent.additive,
      };
      taps.card = {
        pointerId: e.pointerId, id: intent.id, x: e.clientX, y: e.clientY, slop: TAP_MOVE_SLOP,
      };
      startPan(e);
    } else if (intent.kind === 'move' || intent.kind === 'lockedPan') {
      const { id: cardId, additive, wasSelected: held } = intent;
      if (additive) select([cardId], true);
      else if (!held) select([cardId]);
      taps.card = {
        pointerId: e.pointerId, id: cardId, x: e.clientX, y: e.clientY, slop: DRAG_SLOP,
      };
      // A locked card is selected (its menu and unlock stay one click away) but
      // the press pans, as on bare board: a locked backdrop photo must not
      // swallow every press meant for the board. Not an early return, so the
      // hold below can still open its menu on a phone.
      if (intent.kind === 'lockedPan') {
        startPan(e);
      } else {
        // Alt on a mouse: a stuck note comes off its card, anything else is
        // carried as a copy.
        const alt = e.altKey && e.pointerType === 'mouse';
        const pressed = byId(cardId);
        const pull = alt && !!pressed && isPinned(pressed);
        const move = startMove(e, cardId, pull);
        // Nothing to carry (a pinned item on a locked host): pan. See startMove().
        if (!move) startPan(e);
        else {
          move.alt = alt && !pull;
          // What the press found, so the lift can tell a toggle from a pick
          // (`unpick` in endPointer()).
          move.additive = additive;
          move.wasSelected = held;
        }
      }
    } else if (intent.kind === 'marquee') {
      startMarquee(e);
    } else {
      // In multi-select mode bare board never clears the group: building one
      // across a big board means panning between its cards.
      clearIfStill = null;
      // Only with nothing selected: a tap that puts a selection down is spent.
      fenceIfStill = !selection.size && !isMultiSelect() && !tourClick && e.button === 0
        ? { pointerId: e.pointerId, x: e.clientX, y: e.clientY }
        : null;
      if (isMultiSelect()) clearOnLift = null;
      // A group survives a pan, from any pointer: only a tap puts it down.
      else if (selection.size > 1) {
        clearOnLift = e.pointerId;
        clearIfStill = { x: e.clientX, y: e.clientY };
      }
      // Touch defers it to the lift so a hold can cancel it - see clearOnLift.
      else if (e.pointerType === 'touch') clearOnLift = selection.size ? e.pointerId : null;
      else if (selection.size) clearSelection();
      // A press on a connection marks it (for Delete) and still pans. A line is
      // nearer than the fence it crosses.
      if (cmds.pickConnection?.(vp.toWorld(e.clientX, e.clientY))) fenceIfStill = null;
      startPan(e);
    }

    // The long press, armed after the early returns. A drag (pointermove) or a
    // lift (endPointer) cancels it.
    if (e.pointerType === 'touch' && pointers.size === 1) {
      hold.at = { x: e.clientX, y: e.clientY, id };
      hold.timer = setTimeout(() => {
        const p = hold.at;
        cancelPress();
        if (!p) return;
        taps.empty = null;
        taps.lastEmpty = null;
        taps.arm = null;
        taps.card = null;
        // The press that opens the menu is not the tap that clears the board,
        // picks a fence, or walks a tour on.
        clearOnLift = null;
        fenceIfStill = null;
        tourClick = null;
        // Whatever the finger started was not that; nothing moved.
        abortGesture();
        hold.menu = { x: p.x, y: p.y, at: performance.now() };
        openMenuAt(p.x, p.y, p.id, true);
      }, LONG_PRESS_MS);
      // After a moment's stillness the held card shrinks toward the menu, so a
      // working hold shows. Not under reduced motion.
      if (id && baseMs() > 0 && !reducedMotion()) {
        hold.press = setTimeout(() => { hold.press = 0; setPressing(id); }, PRESS_SHOW_MS);
      }
    }
    setPanCursor();
  });

  el.addEventListener('pointermove', e => {
    // Hover, before the guard drops unpressed pointers. Mirrored on the
    // viewport for drop.ts's paste.
    if (e.pointerType !== 'touch') hover = vp.cursor = { x: e.clientX, y: e.clientY };
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (taps.empty?.pointerId === e.pointerId
        && Math.hypot(e.clientX - taps.empty.x, e.clientY - taps.empty.y) > TAP_MOVE_SLOP) {
      taps.empty = null;
      taps.lastEmpty = null;
    }
    // A press on bare board under a group that has become a pan keeps the group.
    if (clearOnLift === e.pointerId && clearIfStill
        && Math.hypot(e.clientX - clearIfStill.x, e.clientY - clearIfStill.y) > TAP_MOVE_SLOP) {
      clearOnLift = null;
      clearIfStill = null;
    }
    // A press that travelled was a pan or a band, never a click on the fence.
    if (fenceIfStill?.pointerId === e.pointerId
        && Math.hypot(e.clientX - fenceIfStill.x, e.clientY - fenceIfStill.y) > TAP_MOVE_SLOP) {
      fenceIfStill = null;
    }
    // Nor the tour's next-stop click.
    if (tourClick?.pointerId === e.pointerId
        && Math.hypot(e.clientX - tourClick.x, e.clientY - tourClick.y) > TAP_MOVE_SLOP) {
      tourClick = null;
    }
    // A pan must not leave a selection behind it.
    if (taps.arm?.pointerId === e.pointerId
        && Math.hypot(e.clientX - taps.arm.x, e.clientY - taps.arm.y) > TAP_MOVE_SLOP) {
      taps.arm = null;
    }
    // A dragged card was not tapped. Its own slop: generous on the pan path,
    // DRAG_SLOP on the move path, where the card already follows the pointer.
    if (taps.card?.pointerId === e.pointerId
        && Math.hypot(e.clientX - taps.card.x, e.clientY - taps.card.y) > taps.card.slop) {
      taps.card = null;
    }
    // A travelled finger is dragging, not holding; the move gesture's slop.
    if (hold.at && Math.hypot(e.clientX - hold.at.x, e.clientY - hold.at.y) > DRAG_SLOP) {
      cancelPress();
      if (e.pointerType === 'touch') taps.lastEmpty = null;
    }
    // A travelled right press is a pan, and owes no menu.
    if (rightPress?.pointerId === e.pointerId && !rightPress.dragged
        && Math.hypot(e.clientX - rightPress.x, e.clientY - rightPress.y) > DRAG_SLOP) {
      rightPress.dragged = true;
      rightPress.owed = false;
      enter('pan', { lastX: rightPress.x, lastY: rightPress.y });
      el.classList.add('is-panning');
    }
    if (gesture.mode === 'idle') return;

    // Coalesced points too, so a quick stroke is a curve, not a polygon.
    if (gesture.mode === 'stroke') {
      if (e.pointerId !== gesture.pointerId) return;
      const passed = e.getCoalescedEvents?.() ?? [];
      for (const c of passed.length ? passed : [e]) {
        extendStroke(vp.toWorld(c.clientX, c.clientY), pressureOf(c));
      }
      return;
    }

    // One branch per mode. This one falls through on purpose: the event that
    // starts the resize also applies its first step.
    if (gesture.mode === 'press' && gesture.intent === 'resize') {
      const pending = gesture;
      const action = resizeHandleAction(
        { x: pending.x, y: pending.y },
        { x: e.clientX, y: e.clientY },
      );
      if (action !== 'resize') return;
      cancelPress();
      // If the card has gone, nothing is entered and the press stands to the lift.
      startResize(e, pending.id, pending.corner, pending);
    }

    if (gesture.mode === 'pinch') {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      vp.panByScreen(mid.x - gesture.mid.x, mid.y - gesture.mid.y);
      // The fingers' own total, so past a limit the board gives a little and
      // comes back as they do, rather than stopping dead under them.
      gesture.raw *= dist / gesture.dist;
      vp.pinchTo(mid.x, mid.y, gesture.raw);
      gesture.dist = dist;
      gesture.mid = mid;
      return;
    }

    if (gesture.mode === 'pan') {
      vp.panByScreen(e.clientX - gesture.lastX, e.clientY - gesture.lastY);
      gesture.lastX = e.clientX;
      gesture.lastY = e.clientY;
      if (gesture.track) trackPan(gesture.track, e);
      // A middle pan past the slop: its release paste will be swallowed.
      if (midPaste.down && !midPaste.dragged && midPaste.at
          && Math.hypot(e.clientX - midPaste.at.x, e.clientY - midPaste.at.y) > DRAG_SLOP) {
        midPaste.dragged = true;
      }
      return;
    }

    if (gesture.mode === 'press' && gesture.intent === 'marquee') {
      if (Math.hypot(e.clientX - gesture.clientX, e.clientY - gesture.clientY) <= DRAG_SLOP) return;
      const p = vp.toWorld(e.clientX, e.clientY);
      // Additive only in the multi-select mode, where nothing on bare board
      // may drop the group - a swipe adds to it, the way Shift's band does.
      const picking = isMultiSelect();
      const band = enter('marquee', {
        x0: gesture.x0, y0: gesture.y0, x1: p.x, y1: p.y,
        additive: picking, base: picking ? [...selection] : null,
      });
      marquee.hidden = false;
      drawMarquee(band);
      applyMarquee(band);
      followEdge(e);
      return;
    }

    track(e.clientX, e.clientY, e.shiftKey, e.altKey);
    followEdge(e);
  });

  /** One step of a marquee, move or resize at this screen point. Separate so
   *  the edge loop can rerun it while the board pans under a still pointer
   *  (followEdge()). */
  function track(clientX: number, clientY: number, shiftKey: boolean, altKey = false) {
    if (gesture.mode === 'marquee') {
      const p = vp.toWorld(clientX, clientY);
      gesture.x1 = p.x; gesture.y1 = p.y;
      drawMarquee(gesture);
      applyMarquee(gesture);
      return;
    }

    if (gesture.mode === 'move') {
      // Bound, so the narrowing holds inside callbacks.
      const drag = gesture;
      const p = vp.toWorld(clientX, clientY);
      let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx * vp.zoom, dy * vp.zoom) < DRAG_SLOP) return;
      // Shift during the drag holds it to the longer axis. Read per move: Shift
      // at the press means additive, and a moved drag never peels, so the two
      // meanings cannot meet.
      const axis = shiftKey ? (Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y') : null;
      if (axis === 'x') dy = 0;
      if (axis === 'y') dx = 0;
      // The press has become a drag.
      if (!drag.moved) {
        // Alt+drag copies here, at the slop, so an Alt-click makes nothing.
        if (drag.alt) carryCopies(drag);
        raiseToFront(drag.moving);
        // Capture makes the cursor #viewport's, so mark it for the grabbing hand.
        el.classList.add('is-moving');
        setDragging(drag.moving, true);
      }
      drag.moved = true;
      // Only the lead snaps; the rest keep their offsets, so a group moves rigidly.
      // Its low edges land on the lattice, not its centre, which for an odd
      // width sits half a cell off by construction; edges are what snapAll() aligns.
      const lead = drag.leadOrigin;
      const low = { x: lead.x + dx - lead.w / 2, y: lead.y + dy - lead.h / 2 };
      // The held axis does not snap: that sideways step is what Shift forbids.
      let sx = axis === 'y' ? 0 : snapLowFor(low.x, drag.snap) - low.x;
      let sy = axis === 'x' ? 0 : snapLowFor(low.y, drag.snap) - low.y;
      // A dragged sticky that would stick: ring its would-be host, and skip the
      // snap so it lands where it was let go. Asked of `lead`, not `id` (a
      // pinned star drags its photograph), and only of nearby cards.
      const leadItem = byId(drag.lead);
      const at = isSticky(leadItem)
        ? { x: lead.x + dx, y: lead.y + dy, w: leadItem.w, h: leadItem.h }
        : null;
      const host = at ? wouldStick(at, drag.lead, leadItem, queryAround(at)) : null;
      // Not a copy: an Alt+drag's copy is its own step, and into is another.
      holdInto(host || drag.alt ? null : boardCardAt(p, drag.moving));
      showStickTarget(host ?? (into?.armed ? byId(into.id) : null));
      if (drag.snap && host) {
        sx = 0;
        sy = 0;
      }
      // flatMap: an item may leave the board mid-drag; carry what is left.
      applyGeom(drag.origin.flatMap(o => {
        const it = byId(o.id);
        return it
          ? [{ id: o.id, x: o.x + dx + sx, y: o.y + dy + sy, w: it.w, h: it.h, rot: it.rot, z: it.z }]
          : [];
      }));
      return;
    }

    if (gesture.mode === 'resize') {
      // The card may leave the board mid-gesture: commit what was done and let go.
      const grip = gesture;
      const it = byId(grip.id);
      if (!it) { abortGesture(); return; }
      const p = vp.toWorld(clientX, clientY);
      const dx = p.x - grip.start.x, dy = p.y - grip.start.y;
      // Zero on an axis the handle does not touch: dragging the east edge must
      // leave the height alone, where a corner moves both.
      // `corner!`: item-dom.ts writes data-g on every grip it builds, so a
      // handle without one is a broken build. Read as an empty string instead,
      // both signs would be zero and the drag would quietly do nothing, which
      // is a worse way to find out.
      const c = grip.corner!;
      const signX = c.includes('e') ? 1 : c.includes('w') ? -1 : 0;
      // 'n' is the +y side of the item, because world y points up.
      const signY = c.includes('n') ? 1 : c.includes('s') ? -1 : 0;
      // XOR: shift inverts the default - except on a picture, which is always held.
      const picture = isPicture(it);
      const locked = picture || grip.lockAspect !== shiftKey;
      // Alt: from the centre, as in every drawing program - the far side moves
      // as far as the one in the hand, so the size changes by twice the travel
      // and the centre stays put. Off the lattice, which a fixed centre cannot
      // land both edges on.
      const centred = altKey;
      const snap = grip.snap && !centred;
      const reach = centred ? 2 : 1;
      // A held proportion reads the pointer unsnapped and lands on the lattice
      // once, at the end of its branch: sides snapped first are steps, and the
      // proportion built from steps jumps a cell at a time.
      let w = resizeAxis(signX, grip.box.x, grip.box.w, dx * reach, snap && !locked);
      let h = resizeAxis(signY, grip.box.y, grip.box.h, dy * reach, snap && !locked);
      // Apply the card and carry its stuck notes with it. Each note is placed at
      // the fraction of the card it held when the drag began (grip.box is that
      // start box), so a note near a moving edge is dragged along by that edge and
      // none is left hanging off the shrunk card. No followers -> a plain
      // one-item write.
      const applyResize = (host: ResizeTarget) => {
        if (!grip.followers.length) return applyGeom([host]);
        const room = { ...host, plate: grip.plate };
        const riders = grip.followers.map((f, k) => {
          let at = stuckPlacement(f.box, grip.box, host);
          // A wall that reached the card it goes with pushes it, and it by the same.
          const root = grip.carried?.[k] ?? -1;
          if (root >= 0 && grip.holds) {
            const hold = grip.holds[root];
            const put = carryPlace(room, hold);
            at = {
              x: at.x + put.x - (host.x + hold.fx * host.w),
              y: at.y + put.y - (host.y + hold.fy * host.h),
            };
          }
          return { id: f.id, x: at.x, y: at.y, w: f.box.w, h: f.box.h, rot: f.box.rot, z: f.box.z };
        });
        // A fence resized on the grid lands what it carries on the grid too.
        if (grip.holds && grip.snap) snapCarried(riders);
        applyGeom([host, ...riders]);
      };
      if (locked) {
        const ratio = grip.picture || grip.box.w / grip.box.h;
        if (signX && signY) {
          // A corner: the pointer projected onto the diagonal it moves along,
          // the nearest box of the proportion to where the hand is. It used to
          // be whichever side had moved further leading the other, which on
          // any drag that was not a clean diagonal handed the lead back and
          // forth frame to frame, and the card jumped between two sizes.
          const k = (w * ratio + h) / (ratio * ratio + 1);
          w = k * ratio;
          h = k;
        } else if (signX) h = w / ratio;   // an edge: the dragged side leads
        else w = h * ratio;
        // The follower can land outside a limit the dragged side never reached,
        // and clamping only the offender would change the ratio - the single
        // thing this branch exists to hold. So the pair is rescaled together.
        // Shrink first and grow second, so that on the extreme shape where both
        // limits bind at once it is the floor that survives: a box too large is
        // a nuisance, a box too small cannot be grabbed to undo it.
        // Where the hand is, before any limit: the stickiness below measures from
        // here. Measured from the clamped box, a hand past the floor never got
        // clearly nearer the smaller cells, and a 2:3 photo held at 3x5 could not
        // go back to the 3x4 it was placed at.
        const hand = { w, h };
        let k = Math.min(1, MAX_SIZE / Math.max(w, h));
        k = Math.max(k, MIN_SIZE / Math.min(w, h));
        // A picture's card floor too, for the same reason: the floor further
        // down lifts one side at a time.
        if (picture) {
          const step = stepNow(), seam = 2 * insetFor(grip.snap);
          k = Math.max(k, (CARD_FLOOR_CELLS.w * step - seam) / w,
            (CARD_FLOOR_CELLS.h * step - seam) / h);
        }
        w *= k;
        h *= k;
        // Both sides back onto the lattice afterwards, because a proportion is
        // a real number and the grid is not: the follower came out of a
        // division and would otherwise be the one side of the box left hanging
        // between two lines, which is exactly the thing that made a photograph
        // impossible to fit. The shape is then kept as closely as whole cells
        // allow - within half a cell of the picture's own - and the grid wins
        // the remainder. Snapping is off most of the time and this does
        // nothing then; the proportion is exact again the moment it is.
        if (snap) {
          // A picture takes the nearby cells nearest its shape rather than each
          // side's own nearest (latticePicture in geometry.ts).
          const step = stepNow();
          let lattice: { w: number, h: number } = picture
            ? latticePicture({ x: 0, y: 0, w, h }, ratio, step)
            : ontoLattice({ x: 0, y: 0, w, h });
          // With a little stickiness: the cells in hand are kept until the
          // pointer is clearly nearer the next ones, so a hand resting near
          // the line between two sizes does not flick the card between them.
          const held = grip.cells;
          if (held && (held.w !== lattice.w || held.h !== lattice.h)
            && Math.hypot(hand.w - lattice.w, hand.h - lattice.h) + 0.3 * step
              > Math.hypot(hand.w - held.w, hand.h - held.h)) {
            lattice = held;
          }
          grip.cells = { w: lattice.w, h: lattice.h };
          w = lattice.w;
          h = lattice.h;
        }
      }
      // A fence may not be dragged smaller than its largest card. Its walls push
      // the cards along rather than stopping at them (carryPlace), so this is
      // the one size past which a card would have to be outside. See carryFloor().
      if (grip.holds) {
        const floor = carryFloor({ ...grip.box, plate: grip.plate }, grip.holds);
        w = Math.max(w, floor.w);
        h = Math.max(h, floor.h);
      }
      // A note may not be dragged smaller than its own text. The floor is
      // measured at the width being proposed, not the one on screen, because
      // narrowing a note rewraps it and makes it *taller* - so pulling a side
      // in can push the bottom out, which is the honest answer.
      //
      // This runs after the limits above and is allowed to overrule the ceiling
      // on the way up, because a note taller than MAX_SIZE is only unusual
      // whereas a note with its last paragraph cut off is wrong. It can only
      // ever raise the height, so it never threatens the floor.
      if (it.type === 'note') {
        let floor = noteFloor(grip.id, w);
        // Up to the next whole cell rather than to the bare floor, so the one
        // height this file sets from something other than the pointer still
        // leaves the note sitting in the grid. Up and never down: rounding to
        // the nearest line could land under the floor, which is the one thing
        // the floor is for - and for the same reason it is not capped at
        // MAX_SIZE, which the floor is already allowed to overrule.
        floor = snapFloorUp(floor, grip.snap);
        // Raising `h` is the whole of it, and the fall-through below places the
        // note from whatever `h` ended up as.
        //
        // There was a `if (!signY) return applyResize(...)` here, under a
        // comment saying the centre "has to be recomputed from the height we
        // actually got". It computed the same six values as the fall-through:
        // with signY at 0, `grip.box.y + signY * (h - grip.box.h) / 2` *is*
        // `grip.box.y`, and x, w, h, rot and z were identical expressions. A
        // branch that says it does something the code it skips does anyway is
        // worse than no branch - the next person changes one of the two.
        if (floor > h) h = floor;
      }
      // Every card sits at least three cells across and two down - a floor on
      // the grid, scaled by the board's step so a coarser board keeps its cards
      // proportionate rather than tiny. The exempt types (NO_GRID_FLOOR) are
      // sized by what they carry, not by the grid. The player floor below is
      // larger and overrules this by the same Math.max.
      if (!NO_GRID_FLOOR.has(it.type)) {
        // The footprint of whole cells: `cells*step` less a seam at each end when
        // snapping, which is exactly the lattice side those cells occupy, so the
        // floor is itself a grid size and a snapped card rests flush on it rather
        // than a seam off. Off the grid the seam is zero and it is the raw cells.
        const step = stepNow(), seam = 2 * insetFor(grip.snap);
        w = Math.max(w, CARD_FLOOR_CELLS.w * step - seam);
        h = Math.max(h, CARD_FLOOR_CELLS.h * step - seam);
      }
      // A player card may not be dragged below the player it holds. Under the
      // width the player draws a sideways scrollbar this app cannot reach across
      // its origin; under the height it is clipped. The floor is the same box
      // fitToPlayer grows a taken card up to (embedFloor, canvas/embed.ts), so a
      // card cannot be shrunk into the state that opening it would have to undo.
      if (it.type === 'link') {
        const spec = embedFor(linkURL(it.meta?.url));
        if (spec) {
          const floor = embedFloor(spec);
          // Up to the next whole cell when snapping, so the player's minimum is a
          // grid size rather than a few pixels off one - see snapFloorUp().
          w = Math.max(w, snapFloorUp(floor.w, grip.snap));
          h = Math.max(h, snapFloorUp(floor.h, grip.snap));
        }
      }
      // The opposite edge stays put, so the centre shifts by half the growth -
      // and on the axis an edge handle doesn't touch, signY is 0 and the item
      // grows symmetrically about its centre, which is what an aspect-locked
      // side drag should do. From the centre, both edges move and it stays.
      const shift = centred ? 0 : 1;
      applyResize({
        id: grip.id,
        x: grip.box.x + shift * signX * (w - grip.box.w) / 2,
        y: grip.box.y + shift * signY * (h - grip.box.h) / 2,
        // A sticker grown past the size a card may lean at lies flat, as the
        // card does, and takes its own angle back if it comes inside again.
        w, h, rot: leanAtSize({ ...it, w, h }, grip.box.rot ?? it.rot), z: it.z,
      });
    }
  }

  // A move, a band or a grip held near the edge of the room the board is seen
  // in pans the board (canvas/edge-pan.ts), and each step runs track() again at
  // the still pointer, so what is carried stays under it. Started once the drag
  // is under way with one pointer down, and stopped in releaseGesture(), the one
  // way back to idle.
  let lastDrag: { x: number, y: number, shift: boolean, alt: boolean } | null = null;
  let stopEdge: (() => void) | null = null;

  // A drag held over a board card: after HOLD_INTO_MS still over it the card
  // wears the target ring, and a release there sends what is carried inside
  // (cmds.dropIntoBoard) instead of moving it. `armed` is the ring being up.
  let into: { id: string, armed: boolean } | null = null;
  let intoTimer = 0;
  const HOLD_INTO_MS = 700;
  const forgetInto = () => {
    clearTimeout(intoTimer);
    into = null;
  };
  /** The board card under the pointer, not one of those being carried. */
  const boardCardAt = (p: Point, carried: readonly string[]) => {
    if (!cmds.dropIntoBoard) return null;
    for (const id of queryAround({ x: p.x, y: p.y, w: 1, h: 1 })) {
      const it = byId(id);
      if (it?.type !== 'board' || carried.includes(id)) continue;
      if (Math.abs(p.x - it.x) <= it.w / 2 && Math.abs(p.y - it.y) <= it.h / 2) return it;
    }
    return null;
  };
  const holdInto = (card: Item | null) => {
    if (card?.id === into?.id) return;
    forgetInto();
    if (!card) return;
    const held = { id: card.id, armed: false };
    into = held;
    intoTimer = window.setTimeout(() => {
      held.armed = true;
      showStickTarget(byId(held.id));
    }, HOLD_INTO_MS);
  };
  function followEdge(e: PointerEvent) {
    lastDrag = { x: e.clientX, y: e.clientY, shift: e.shiftKey, alt: e.altKey };
    if (stopEdge || pointers.size !== 1) return;
    if (gesture.mode !== 'marquee' && gesture.mode !== 'resize'
      && !(gesture.mode === 'move' && gesture.moved)) return;
    stopEdge = startEdgePan(vp, {
      point: () => lastDrag,
      onPan: () => { if (lastDrag) track(lastDrag.x, lastDrag.y, lastDrag.shift, lastDrag.alt); },
    });
  }

  const endPointer = (e: PointerEvent) => {
    // The mirror of onDown's first line, and it was missing.
    //
    // A right or aux button on a mouse is left alone on the way down - it never
    // enters `pointers` and never starts anything. Its *release* arrived here
    // anyway, and this function does not ask which button it is: it deleted
    // pointerId 1 (a mouse is one pointer, whatever its buttons), released
    // capture, and finishGesture() committed the half-finished move with the
    // left button still held. Every movement after that was dropped by the
    // `!pointers.has()` guard, so the card stopped dead under the hand and the
    // undo entry recorded where it happened to be.
    //
    // `buttons` is the whole test: a pointerup while any button is still down is
    // not the end of anything. `button` is not asked, because a chord that ends
    // on the right or an aux button reports that button on the last release, and
    // skipping it left the card following a cursor with no button held.
    if (liftWithButtonsHeld(e)) return;
    // A right press: a drag was a pan, and ends as one below; a click opens
    // the menu that a contextmenu on the press left owed (macOS, Linux). On
    // Windows the contextmenu follows this lift - see that listener.
    if (rightPress?.pointerId === e.pointerId) {
      const press = rightPress;
      rightPress = null;
      if (press.dragged) rightDragAt = performance.now();
      else if (press.owed && e.type === 'pointerup') openMenuAt(press.x, press.y, press.hit);
    }
    // Whether this pointer is one the pipeline was tracking. Read before the
    // delete below, because that is what the answer is about.
    //
    // A press that landed on a widget - a scrubber, a play button - takes its
    // own pointer back out of `pointers` and never captures, precisely so the
    // widget can have it. Lifting that finger then ran the whole tail of this
    // function and ended whatever *other* finger was doing: touch a waveform
    // with one hand, pan with the other, lift the first, and the board froze.
    const owned = pointers.has(e.pointerId);
    // The middle-button paste fires on the *release* (mouseup/click), which
    // lands in the same task as this pointerup - so clearing the guard now would
    // uncover the very paste it exists to catch. Defer the clear to the next task
    // instead, past the click that carries the paste.
    if (e.button === 1) setTimeout(() => { midPaste.down = false; }, 0);
    // `let`: a tap that put a selection down is spent on that, and does not
    // become the first half of a double tap - see the clear below.
    let tap = e.type === 'pointerup' && taps.empty?.pointerId === e.pointerId
      ? { x: taps.empty.x, y: taps.empty.y, at: e.timeStamp }
      : null;
    if (taps.empty?.pointerId === e.pointerId) taps.empty = null;
    // The lift that turns a held-still press into a pick. pointerup only: a
    // pointercancel is the system taking the gesture away - a notification
    // shade, a call - and nothing a person did.
    if (taps.arm?.pointerId === e.pointerId) {
      if (e.type === 'pointerup') {
        // Unconditional, like the mouse branch above: the cue answers the tap
        // and not what the tap turned out to change.
        select([taps.arm.id], taps.arm.additive);
        cue('pick');
      }
      taps.arm = null;
    }
    // pointerup only, like the pick above and for the same reason: a
    // pointercancel is the system taking the gesture away, not a person
    // finishing one.
    if (taps.card?.pointerId === e.pointerId) {
      if (e.type === 'pointerup') pauseOnTap(taps.card.id);
      taps.card = null;
    }
    // The click that walks the tour on - see tourClick. pointerup only, unlike
    // the deselect below it: a pointercancel is the system taking the gesture
    // away, and a tour that stepped because a notification arrived would be
    // moving on nobody's instruction. Cleared either way, so a cancelled press
    // cannot be spent by the next lift.
    if (tourClick?.pointerId === e.pointerId) {
      tourClick = null;
      // Answered through the same door Escape and the arrows use, which returns
      // whether it took the press. Nothing is done with the answer here: this
      // press was a click on bare board during a tour, and if the tour ended
      // underneath it there is nothing else it could have meant either.
      if (e.type === 'pointerup') cmds.tourStep?.(1);
    }
    // The deselect a touch press on bare board put off - see clearOnLift. Spent
    // whichever way the press ended, cancel included: the press was still a
    // hand put on empty board, and the only thing that ever calls it off is the
    // hold, which does so where it opens the menu.
    if (clearOnLift === e.pointerId) {
      clearOnLift = null;
      clearIfStill = null;
      // A tap that deselected did something, so a second tap after it is a
      // fresh first tap and not the start of a double-tap-drag selection.
      if (selection.size) { clearSelection(); tap = null; }
    }
    // The click on a fence's body - see fenceIfStill. pointerup only, and only
    // while one finger is down: a lift that ends a pinch was not a click. The
    // tap stays a first tap, so a double-tap-drag inside a fence still draws a
    // band, which replaces the fence with the cards it catches.
    if (fenceIfStill?.pointerId === e.pointerId) {
      const at = fenceIfStill;
      fenceIfStill = null;
      if (e.type === 'pointerup' && pointers.size === 1 && !selection.size) {
        const fence = fenceBodyAt(at.x, at.y);
        if (fence) { select([fence]); cue('pick'); }
      }
    }
    cancelPress();
    pointers.delete(e.pointerId);
    releasePointerSafely(el, e.pointerId);
    // A pinch let go past a zoom limit comes back to it, once the last finger is
    // off: the survivor of a pinch pans, and its first move would stop a settle.
    if (!pointers.size) vp.settleZoom(e.clientX, e.clientY);
    // Every clause above is about the *pointer* and holds whatever the gesture
    // is - including when there is none, which is why they run before this.
    if (gesture.mode === 'idle') return;
    // ...and everything below is about the gesture, which this pointer has to
    // own to end. See `owned`.
    if (!owned) return;
    if (gesture.mode === 'pinch' && pointers.size >= 2) {
      // A third finger lifted, and two are still down: this is still a pinch.
      //
      // It used to fall into the pan below. `pointerdown` adds every pointer
      // before returning for `size > 2`, so a third finger was tracked without
      // changing the mode; lifting it left two, satisfied `size >= 1`, and
      // entered a pan whose `lastX/lastY` were one of the two. Both fingers
      // then fed the same pan and the board jumped back and forth by the
      // distance between them on every event - with no way back, because the
      // table has no pan -> pinch edge and only a press enters a pinch.
      //
      // Re-seated rather than left alone: the pinch was measured against a pair
      // that may have included the finger just lifted, and carrying that
      // baseline forward would jump the zoom by the difference.
      const [a, b] = [...pointers.values()];
      gesture.dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      gesture.mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return;
    }
    if (gesture.mode === 'pinch' && pointers.size === 1) {
      // One finger lifted mid-pinch: fall back to a pan with the survivor.
      //
      // No `track`, so this pan cannot throw the board. Lifting one finger of a
      // pinch is how a pinch ends, and the survivor is usually still travelling
      // outwards from the zoom rather than pushing the board anywhere - so a
      // throw here would be the board running off on its own after a gesture
      // that was about the zoom. A finger that then deliberately drags is a
      // finger that can lift and start again.
      const [p] = [...pointers.values()];
      enter('pan', { lastX: p.x, lastY: p.y });
      return;
    }
    // Read while the gesture is still standing, spent once it is not.
    // pointerup only: a pointercancel is the system taking the gesture away, and
    // a board that carried on gliding after a notification pulled the finger off
    // it would be moving on nobody's instruction.
    const thrown = e.type === 'pointerup' && gesture.mode === 'pan'
      ? flingFrom(gesture, e.timeStamp)
      : null;
    // A selected item is armed for movement on press. If the pointer never
    // crossed the drag slop, the second click was a toggle instead: remove only
    // that item so a group can be peeled back one card at a time.
    //
    // Only when there is a group to peel. On a lone selection this fired on
    // every tap of the one selected card, so a tap that meant "keep this one"
    // read as "drop it" - and reselecting then took a second tap. A single
    // selection is cleared by tapping empty space, not by tapping itself.
    //
    // A modified press answers this for itself instead. Ctrl-clicking an
    // unselected card had just added it, and the group-size test then took it
    // straight back off again on the lift - so Ctrl+click appeared to do
    // nothing at all unless you dragged, which is what made it stick. What the
    // press found is the whole story: a card that was already in the selection
    // is peeled, a card that was not stays added.
    const unpick = e.type === 'pointerup' && gesture.mode === 'move' && !gesture.moved
        && (gesture.additive ? gesture.wasSelected : selection.size > 1)
      ? gesture.id
      : null;
    // A rectangle dragged round some cards is "these belong together" said in the
    // one gesture on the board that already means it, so the offer to make it a
    // fence goes where the band was let go. Read here, while the gesture still
    // stands, and acted on below once it does not - the offer is about the board
    // as it now is, and finishGesture() is what settles that.
    //
    // pointerup only, like the pick and the throw above: a pointercancel is the
    // system taking the gesture away, and answering a question nobody finished
    // asking is worse than not offering. cmds owns whether there is anything
    // worth offering; all this knows is that a rectangle was drawn.
    // A Z box is a zoom and never a fence.
    const zoomed = e.type === 'pointerup' && gesture.mode === 'marquee' && gesture.zoom
      ? gesture
      : null;
    const banded = e.type === 'pointerup' && gesture.mode === 'marquee' && !gesture.zoom
        && drewRectangle(gesture, vp.zoom)
      ? {
        x0: Math.min(gesture.x0, gesture.x1), y0: Math.min(gesture.y0, gesture.y1),
        x1: Math.max(gesture.x0, gesture.x1), y1: Math.max(gesture.y0, gesture.y1),
      }
      : null;
    finishGesture();
    if (unpick) deselect(unpick);
    if (banded) cmds.fencePrompt(e.clientX, e.clientY, banded);
    if (zoomed) zoomInto(zoomed, e.clientX, e.clientY, e.altKey);
    if (thrown) vp.glide(thrown.vx, thrown.vy);
    if (tap) taps.lastEmpty = tap;
    setPanCursor();
  };
  el.addEventListener('pointerup', endPointer);
  el.addEventListener('pointercancel', endPointer);

  /**
   * Commit whatever the gesture earned, release its DOM marks and go back to
   * idle. The one place the commit rules (a moved move, any resize) and the
   * cleanup (marquee, the resizing/panning/moving classes, the stick target)
   * live, so finishGesture and abortGesture cannot drift apart - and the one
   * door back to `idle`, which is what makes "released exactly once" checkable:
   * a second release would be idle -> idle, which the table refuses.
   */
  function releaseGesture(commit = true) {
    // The edge loop is the drag's, and every drag ends here - see followEdge().
    stopEdge?.();
    stopEdge = null;
    lastDrag = null;
    // A stroke lands or is let go. The pen keeps its own clock for the burst
    // rule, and performance.now() is the clock event timestamps are on.
    if (gesture.mode === 'stroke') {
      if (commit) endStroke(performance.now());
      else dropStroke();
    }
    // A drop that found a host is the way back from Unstick, and it is the only
    // way back - there is no "stick to this card" menu entry, because putting it
    // on the card is already how you say that. In front of the commit, not
    // inside it, so undo restores the flag instead of re-deriving it; resettle()
    // in state.ts argues the whole of it. Only on a gesture that moved, so a
    // plain click on a loose note cannot quietly re-pin it.
    // Let go over a board card held long enough: inside it, as one step, and
    // not a move on this board first - the cards go back where they were
    // picked up from, unrecorded, and leave from there.
    const intoCard = into?.armed ? into.id : null;
    forgetInto();
    if (commit && intoCard && gesture.mode === 'move' && gesture.moved && !gesture.copied) {
      applyGeom(gesture.before);
      setDragging(gesture.moving, false);
      cmds.dropIntoBoard?.(gesture.moving, intoCard);
      el.classList.remove('is-panning', 'is-moving');
      showStickTarget(null);
      enter('idle');
      return;
    }
    if (commit) {
      if (gesture.mode === 'move' && gesture.moved) {
        resettle(gesture.driven);
        commitGeom('Move', gesture.before, gesture.driven);
        foldCopy(gesture);
      }
      if (gesture.mode === 'resize') commitGeom('Resize', gesture.before, gesture.driven);
      // A card landing, and a band closing on something. Both here rather than
      // at their own ends of the pipeline, because this is the one door back to
      // idle - so a gesture cannot be released twice and be heard twice.
      //
      // **One cue per card, not one per gesture.** This said "forty cards land
      // as forty taps" directly above a line that fired exactly once however
      // many were being dragged, which is the comment describing the intention
      // and the code doing something else. `driven` is the set the drag
      // actually moved, so a five-card drop is five taps and a one-card drop is
      // one.
      //
      // Capped, and this is the one cap in the feature - it is here because past
      // it nothing is being lost. cuelume/engine.ts spaces cues twelve
      // milliseconds apart up to an eighty-millisecond lookahead and then lets
      // them pile; a pile is a set of transients starting on the same sample,
      // which is the one thing established to be unhearable as separate events.
      // So beyond seven or so the extra calls buy no sound and cost four Web
      // Audio nodes each - and dragging a five-hundred-card selection is a
      // thing somebody can do.
      if (gesture.mode === 'move' && gesture.moved) {
        for (let i = Math.min(gesture.driven.length, TAP_BURST); i > 0; i--) cue('tap');
      }
      // A resize that reached the pipeline changed the card - the grip press
      // waits out the slop before it becomes one, so there is no zero-distance
      // resize to guard against. It landed too, and was silent for no reason
      // beyond having been left off the line above.
      if (gesture.mode === 'resize') cue('tap');
      // Nothing while the band is being dragged, and nothing when it closes on
      // empty board: a marquee that selected nothing is a click on the
      // background, and the app has no news for that.
      if (gesture.mode === 'marquee' && !gesture.zoom && selection.size) cue('sweep');
    } else if (gesture.mode === 'move' || gesture.mode === 'resize') {
      // Put it back, which is what "abort" has always said and never done.
      //
      // Both callers of the dropping path are the gesture being *taken away*
      // rather than finished: a second finger landing mid-drag, which the
      // header describes as dropping the standing gesture and entering a pinch
      // from idle, and the native context menu opening over one. Committing
      // there left the card wherever the hand happened to be when it was
      // interrupted, with a `Move` on the undo stack that nobody performed -
      // and on a phone the interruption is the *first* frame of a pinch, so
      // zooming with a card under the fingers rearranged the board.
      //
      // The snapshot is the gesture's own `before`, which is what commitGeom()
      // would have used as the undo state; applyGeom() writes it back live and
      // records nothing, so the history is left exactly as the press found it.
      // Slid home rather than cut there, since a card that teleports out from
      // under the finger reads as lost. Short, as the way back is.
      const seen = seenPlaces(gesture.before.map(b => b.id));
      applyGeom(gesture.before);
      slideFrom(seen, reducedMotion() ? 0 : baseMs());
      // An Alt+drag taken away takes its copy with it, entry and all.
      if (gesture.mode === 'move' && gesture.copied) {
        setDragging(gesture.moving, false);
        takeBack(gesture.copied);
        select([...selection].filter(id => !!byId(id)));
      }
    }
    if (gesture.mode === 'marquee') marquee.hidden = true;
    // Both modes that carry a node: `resize`, and the `press` that was on its way
    // to one. Neither of the others has the field, which is the shape of the
    // gesture object doing the discriminating for us - and `in` is that sentence
    // said so that the typechecker reads it too, rather than a mode list here
    // that would have to be kept level with the two declarations.
    if ('node' in gesture) {
      gesture.node?.classList.remove('is-resizing');
      refreshRings();
    }
    if (gesture.mode === 'move' && gesture.moved) setDragging(gesture.moving, false);
    el.classList.remove('is-panning', 'is-moving');
    showStickTarget(null);
    enter('idle');
  }

  /**
   * An Alt+drag's copy and its move, as one undo step. Each committed as it
   * always does; both are withdrawn and committed again together, so one Ctrl+Z
   * takes the copy away rather than first putting it back on its original.
   */
  function foldCopy(drag: MoveGesture) {
    const made = drag.copied;
    if (!made) return;
    const moved = lastCommand();
    // Let go where it was picked up: no move, so no copy either - a card
    // stacked exactly on its twin is one nobody could see to delete.
    if (!moved || moved === made) {
      takeBack(made);
      select([...selection].filter(id => !!byId(id)));
      return;
    }
    if (!takeBack(moved)) return;
    if (!takeBack(made)) return;
    const n = drag.driven.length;
    commit(n === 1 ? 'Copy by dragging' : `Copy ${n} by dragging`,
      () => { made.redo(); moved.redo(); },
      () => { moved.undo(); made.undo(); },
      made.weight + moved.weight);
    select(drag.driven.filter(id => !!byId(id)));
  }

  function finishGesture() {
    if (gesture.mode === 'idle') return;
    releaseGesture();
    syncItems();
  }

  /**
   * Drop the gesture without committing (used when a pinch takes over).
   *
   * It now does. This called releaseGesture() unchanged, so "abort" committed
   * the move or the resize exactly as finishGesture() would - the header of
   * this file argues at length that a second finger *drops* what was standing,
   * and the code did the opposite.
   *
   * syncItems() runs here as it does after a finish, because putting the
   * geometry back is itself a change the cards have to be redrawn from - the
   * only difference between the two paths is which state that is.
   */
  function abortGesture() {
    if (gesture.mode === 'idle') return;
    releaseGesture(false);
    syncItems();
  }

  /**
   * Escape's half of the abort: a drag, a grip or a band taken back mid-air.
   *
   * Only the gestures that change the board. A pan and a pinch move the view,
   * which has no "before" worth returning to, so Escape mid-pan falls through to
   * its ordinary chain. A band selects as it grows, so its abort also hands back
   * the selection it started from - an additive band froze that as `base`, and
   * a plain one started from nothing.
   *
   * The pointer is still down and still captured. That is fine: once the
   * gesture is idle, pointermove and pointerup both return at their idle guard,
   * so the lift that follows finds nothing to finish.
   */
  function cancelGesture() {
    const g = gesture;
    if (g.mode !== 'move' && g.mode !== 'resize' && g.mode !== 'marquee' && g.mode !== 'press'
      && g.mode !== 'stroke') return false;
    // A zoom box selected nothing, so there is nothing to hand back.
    const base = g.mode === 'marquee' && !g.zoom ? g.base ?? [] : null;
    abortGesture();
    if (base) select(base);
    return true;
  }

  // The stick-target ring moved to canvas/items.ts, which owns the nodes it
  // marks. It was a closure in here while a note drag was the only thing that
  // could aim at a host; a shape dragged out of the sticker window aims at one
  // too, and ui/sticker-window.ts cannot reach into this function.

  // The band is a world rectangle drawn in screen pixels, so it has to be
  // redrawn when the mapping between the two changes. Nothing here listened to
  // the view, and the wheel handler has no gesture guard: draw a band with
  // Ctrl held, scroll, and the board zoomed underneath while #marquee kept its
  // old screen box until the next pointermove. The *selection* was right the
  // whole time - the anchor is stored in world space - so it was only ever the
  // drawn rectangle that lied, which is the kind of thing nobody reports and
  // everybody notices.
  vp.onChange(() => { if (gesture.mode === 'marquee') drawMarquee(gesture); });

  // ---- wheel ------------------------------------------------------------

  el.addEventListener('wheel', e => {
    // The wheel's half of the widget rule, and it was missing entirely.
    //
    // preventDefault() ran first and unconditionally, so a wheel over a note
    // being edited, over a <video controls> volume strip, or over any card body
    // that overflows was swallowed and turned into a board zoom - the listener
    // is on #viewport and everything is a descendant of it. The pointer
    // pipeline has said for a long time which elements own their own gestures;
    // this is the same list, asked the same question.
    //
    // Narrower than the pointer list on purpose: .model-stage and .wave claim a
    // *drag* because a drag on them means something, and neither has anything
    // to do with a wheel - a wheel there is a zoom like anywhere else. What is
    // left is the two that genuinely scroll.
    const over = e.target instanceof Element
      ? e.target.closest('video[controls], [contenteditable="true"], [contenteditable="plaintext-only"]')
      : null;
    if (over) return;
    e.preventDefault();
    // The wheel's half of the tour freeze - see pressIntent(). After
    // preventDefault and not before it: returning bare would hand the notch
    // back to the page and scroll the document behind the board.
    if (cmds.inTour?.()) return;
    const w = readWheel(e, vp.height, ctrlDown, wheelPrefs());
    // Mobile is a fixed-width feed with one navigable axis, so everything that
    // arrives moves the feed along it - a sideways swipe and a Shift+wheel
    // included, since neither has anywhere else to go. A pinch too: there is
    // nothing for it to do against a zoom locked to the width.
    if (vp.isMobile) {
      vp.panByScreen(0, -(w.dy || w.dx));
      return;
    }
    // Two fingers on a pad, in whichever direction they went - and Shift+wheel,
    // which readWheel() has already turned into the same thing. The board
    // follows the fingers, which is the opposite sign to the scroll they
    // describe.
    if (w.kind === 'pan') {
      vp.panByScreen(-w.dx, -w.dy);
      return;
    }
    // A hi-res wheel that panned for a moment before it was recognised - see
    // detent(). Undone in the same frame as the zoom, so it is never painted.
    if (w.undo) vp.panByScreen(w.undo.dx, w.undo.dy);
    vp.zoomAt(e.clientX, e.clientY, w.factor);
  }, { passive: false });

  // ---- double click -----------------------------------------------------

  // Double click no longer touches the zoom - not on empty space (it used to fit
  // the whole board) and not on a card (it used to zoom to that card). The one
  // meaning left is opening a note to edit, which is not a zoom and stays. Zoom
  // to fit is still on the F key and in the menu.
  el.addEventListener('dblclick', e => {
    // A tour and its editor show the board rather than work on it: no viewer,
    // no note editor, no rename. Nor does the Timeline while it plays.
    if (cmds.inTour?.() || cmds.tourEditing?.() || timelinePlaying()) return;
    // The multi-select mode is picking cards, and a double tap there is two
    // picks - the card in and out again - never the viewer or an editor.
    if (isMultiSelect()) return;
    // The point, not the target - and that is not a preference.
    //
    // onDown captures the pointer on #viewport (el.setPointerCapture, above), and
    // while a capture is set the browser targets the *compatibility* mouse events
    // at the capture element rather than at whatever is under the pointer. So
    // every dblclick that reaches this listener arrives with e.target === el, and
    // itemIdFromEvent() - which walks up from the target looking for a .item -
    // could only ever answer null. Double-clicking a photograph fell straight
    // into the "not on a card" branch below and did nothing.
    //
    // A note escaped it, which is why this went unnoticed: a contenteditable is
    // caught by the `widget` branch in onDown, which returns before the capture
    // is taken - so on the one type where the gesture had a visible answer, the
    // target was real and the answer arrived.
    //
    // elementFromPoint() asks the question the target was meant to answer: what
    // is under this pointer. The event target is still tried first, so nothing
    // that already worked starts going through a hit test to get the same answer.
    const id = itemIdFromEvent(e.target)
      ?? itemIdFromEvent(document.elementFromPoint(e.clientX, e.clientY));
    // Not on a card: it may be on a line, and a label is the thing a line is
    // most often opened to be given. The same gesture a note answers with its
    // editor, asked of the other thing on the board that carries words.
    if (!id) {
      const conn = cmds.connectionUnder?.(vp.toWorld(e.clientX, e.clientY));
      if (conn) cmds.editConnectionLabel(conn.a, conn.b);
      return;
    }
    if (byId(id)?.type === 'note') cmds.editNote(id);
    // A double-click on the title card renames the board inline, the same as its
    // T button - the one gesture besides the note edit that survives here.
    else if (byId(id)?.type === 'title') cmds.editTitleText?.();
    // A font card is written on too: its specimen text is editable, so a
    // double-click opens it rather than the viewer.
    else if (byId(id)?.type === 'font') cmds.editFontText?.(id);
    // A board card opens the board it holds - a file manager's folder.
    else if (byId(id)?.type === 'board') cmds.openBoard?.(id);
    // And on anything else it opens the item full size. A double-click on a file
    // is what every file manager in existence means by "open it", and until the
    // viewer existed this gesture had nothing to do on a photograph - which is
    // most of what a board holds. The note and the title card keep theirs: both
    // are things you write on, and editing is the nearer meaning of the two.
    else cmds.openViewer?.(id);
  });

  // ---- keyboard ---------------------------------------------------------

  const typingInto = (t: EventTarget | null): t is HTMLElement =>
    t instanceof HTMLElement &&
    (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

  /**
   * Something that answers to the keyboard on its own.
   *
   * Space activates a focused button and a focused link, and the canvas took
   * that key unconditionally - so tabbing to Save and pressing Space entered
   * pan mode instead of saving, and preventDefault() meant the button never
   * heard about it. A keyboard user could reach every control in the sidebar
   * and operate none of them.
   */
  const nativeKeyTarget = (t: EventTarget | null) =>
    t instanceof HTMLElement && !!t.closest('button, a[href], summary, [role="button"]');

  // A modal dialog or the context menu owns the keyboard while it is up, and the
  // canvas shortcuts must not fire behind it. Pressing ArrowRight on a dialog's
  // Cancel button used to nudge the selected card behind the still-open dialog;
  // Delete with the context menu up removed the selection under it. The menu's
  // own capture listener preventDefault-s the keys it handles (Arrow, Escape),
  // which `defaultPrevented` catches; this covers the rest, and the dialog.
  // See AUD-08.
  const overlayOwnsKeyboard = () =>
    !!document.querySelector('dialog[open]') || !!document.getElementById('ctx-menu');

  /** A tour, or the editor that builds one: the board is being shown, and the
   *  keys that would change it stand down. The arrows and Escape answer both. */
  const onlyLooking = () => !!(cmds.inTour?.() || cmds.tourEditing?.());

  // ---- the keyboard's way to a card ----------------------------------------
  //
  // The board is one tab stop. With the focus on it, Tab and Shift+Tab select
  // the next and previous card in reading order, bring it into view and say
  // what it is; Enter, the arrows, Delete and the Menu key then act on it as
  // they already did. Past the last card, Tab leaves as it would anywhere, and
  // Escape then Tab leaves at once. A selection rather than a roving tabindex:
  // the ring is already the focus mark, and a board can hold thousands of cards
  // that would each be a tab stop.
  el.tabIndex = 0;
  el.setAttribute('role', 'application');
  el.setAttribute('aria-roledescription', 'board');
  el.setAttribute('aria-label', 'Board. Tab and Shift+Tab step through the cards, Alt and an arrow go to the next card that way, Enter opens one, Escape then Tab leaves the board.');
  const spoken = document.createElement('div');
  spoken.className = 'vh';
  spoken.setAttribute('aria-live', 'polite');
  document.body.append(spoken);
  /** Escape was pressed on the board: the next Tab is the page's. */
  let leaving = false;
  el.addEventListener('blur', () => { leaving = false; });

  function walkCards(e: KeyboardEvent): boolean {
    if (e.target !== el || vp.isMobile || onlyLooking()) return false;
    if (leaving) { leaving = false; return false; }
    const rolled = rolledFences();
    const cards = walkOrder(board.items.filter(i => i.type !== 'ghost' && !rolledAway(i, rolled)));
    if (!cards.length) return false;
    const at = selection.size === 1 ? cards.findIndex(c => selection.has(c.id)) : -1;
    const next = at < 0 ? (e.shiftKey ? cards.length - 1 : 0) : at + (e.shiftKey ? -1 : 1);
    if (next < 0 || next >= cards.length) return false;
    const card = cards[next];
    focusCard(card);
    spoken.textContent = `${itemAccessibleName(card)}, ${next + 1} of ${cards.length}`;
    return true;
  }

  /** Select a card and bring it into view when any of it is off the screen, at the zoom already set. */
  function focusCard(card: Item) {
    select([card.id]);
    const a = vp.toScreen(card.x - card.w / 2, card.y + card.h / 2);
    const b = vp.toScreen(card.x + card.w / 2, card.y - card.h / 2);
    if (a.x < vp.left || a.y < vp.top || b.x > vp.left + vp.width || b.y > vp.top + vp.height) {
      vp.centreOn({ x: card.x, y: card.y }, baseMs());
    }
  }

  /**
   * Alt+arrow: to the nearest card that way (nearestCard()), from the one
   * selected, or from the middle of the screen when none is. The plain arrows
   * stay the nudge. Only with the focus on the board or on nothing, since on
   * the web Alt+Left anywhere else is the browser's Back.
   */
  function stepCards(e: KeyboardEvent): boolean {
    if ((e.target !== el && e.target !== document.body) || vp.isMobile || onlyLooking()) return false;
    const rolled = rolledFences();
    const cards = board.items.filter(i => i.type !== 'ghost' && !rolledAway(i, rolled));
    const here = selection.size === 1 ? cards.find(c => selection.has(c.id)) : undefined;
    const from = here ?? vp.toWorld(vp.left + vp.width / 2, vp.top + vp.height / 2);
    const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const dy = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    const card = nearestCard(from, cards.filter(c => c !== here), dx, dy);
    if (!card) {
      spoken.textContent = 'No card that way';
      return true;
    }
    focusCard(card);
    spoken.textContent = itemAccessibleName(card);
    return true;
  }

  addEventListener('keydown', e => {
    // Before every early return: the wheel asks about the key wherever the focus is.
    if (e.key === 'Control') ctrlDown = true;
    if (typingInto(e.target)) {
      if (e.key === 'Escape') { markClosed(e); e.target.blur(); }
      return;
    }
    if (shortcutsSuppressed(e.defaultPrevented, overlayOwnsKeyboard())) return;

    // While it is up, the mode owns the keyboard: digits pick a tool, Escape
    // walks its own chain (here rather than in the one below), and nothing else
    // reaches a board that is meant to be frozen.
    if (cmds.cleanActive?.()) {
      if (e.key === 'Escape') { if (cmds.cleanEscape?.()) markClosed(e); return; }
      // Space is hold-to-pan on a board and stays hold-to-pan in there, which
      // is the one thing the mode borrows rather than reinventing.
      if (e.code === 'Space') { cmds.cleanSpace?.(true); e.preventDefault(); return; }
      // The code is still listened for in here: typed again, it lets the robot
      // vacuum loose. None of its keys is a digit, so it never picks a tool.
      if (cmds.cleanFeed?.(e.key)) { e.preventDefault(); return; }
      if (cmds.cleanKey?.(e.key)) e.preventDefault();
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    // While the Timeline plays only the keys that move the view, Escape, and
    // Ctrl+S, which saves the board as it stands in the replay.
    if (timelinePlaying() && (mod
      ? !(e.key.toLowerCase() === 's' || ZOOM_KEYS.has(e.key))
      : !(VIEW_KEYS.has(e.key) || e.code === 'Space'))) return;

    // The konami code, one key at a time. The matcher is pure and lives in
    // ui/clean/, which this module may not import - so it is reached through
    // cmds, like everything else over the layering line.
    //
    // Below the guard above on purpose. A replay drives the board on its own
    // clock and a tour drives the camera on another; the egg freezes the cards
    // and takes the screen, and two of those running at once is three owners of
    // one board. cleanFeed refuses in both, and answers true only on the press
    // that actually opened something.
    if (cmds.cleanFeed?.(e.key)) { e.preventDefault(); return; }

    // Let a focused control have its own keys. The shortcuts with a modifier
    // are still ours - Ctrl+S means save wherever the focus happens to be.
    if (!mod && nativeKeyTarget(e.target) && (e.code === 'Space' || e.key === 'Enter')) return;

    if (e.code === 'Space' && !spaceDown) {
      // Space is the play/pause key of every media player, so when there is a
      // track loaded it toggles that; only with nothing playing does it fall back
      // to the canvas's own hold-to-pan. cmds.playPause() reports which happened.
      if (cmds.playPause?.()) { e.preventDefault(); return; }
      spaceDown = true;
      setPanCursor();
      e.preventDefault();
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); cmds.selectAll(); return; }
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? cmds.redo() : cmds.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); cmds.redo(); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); cmds.duplicate(); return; }
    // Ctrl+S is the cheap one - keep this, in the browser. Ctrl+Shift+S is the
    // deliberate one, and writes a file.
    //
    // On the desktop both mean something slightly different, because Save is
    // the file there: Ctrl+S writes it and Ctrl+Shift+S asks where. Export
    // keeps its own place on the native menu rather than a keystroke, which is
    // where a "write me a copy" belongs once Save is no longer a browser thing.
    //
    // This handler stays on the desktop and is not gated on !isDesktop(). The
    // native menu carries the same accelerators, and whether Electron delivers
    // the keydown to the page *as well as* firing the menu differs by OS - that
    // is the open question in the plan's §12, and it is answered by pressing
    // the keys on each OS after the menu exists, not by guessing here. Both
    // roads end at the same cmds entry, so a double-fire is a duplicate save
    // and not a wrong one.
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!e.shiftKey) cmds.save();
      else if (isDesktop()) cmds.saveAs();
      else cmds.export();
      return;
    }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); cmds.open(); return; }
    // Ctrl+G: group, in every editor that has groups - a fence round the
    // selection, which is this board's word for one. The browser's own Ctrl+G
    // (find next) has nothing to find on a board. Ctrl+Shift+G ungroups.
    if (mod && e.key.toLowerCase() === 'g' && !onlyLooking()) {
      e.preventDefault();
      if (!selection.size) return;
      if (e.shiftKey) cmds.unfenceSelection?.();
      else cmds.fenceSelection?.();
      return;
    }
    // Ctrl with + - 0: the board's zoom, as in every canvas editor, and not the
    // page's - the same steps as + and - alone, and 100% as 1 is. The Feed keeps
    // the browser's, having no zoom of its own. Not with Alt, which with Ctrl is
    // AltGr on half the keyboards in Europe.
    if (mod && !e.altKey && ZOOM_KEYS.has(e.key) && !vp.isMobile) {
      e.preventDefault();
      if (e.key === '0') cmds.zoomActual?.();
      else vp.zoomBy(e.key === '+' || e.key === '=' ? 1.25 : 1 / 1.25, zoomMs());
      return;
    }
    if (mod) return;

    switch (e.key) {
      case 'Delete': case 'Backspace':
        // The tour editor first: there Delete means the picked stop.
        if (cmds.tourEditDelete?.()) { e.preventDefault(); break; }
        // With a line marked and no cards selected, Delete means the line. The
        // order is the honest one: a selection is a louder statement of intent
        // than a mark left by the last press, so cards win whenever there are
        // any, and the command answers false when there is no line to remove.
        if (!selection.size && cmds.deleteActiveConnection?.()) { e.preventDefault(); break; }
        cmds.deleteSelection();
        e.preventDefault();
        break;
      // One item only: a rename has to put the caret somewhere, and a group
      // selection has no single name to put it in.
      case 'F2': if (selection.size === 1 && !cmds.inTour?.() && !cmds.tourEditing?.()) {
        const only = [...selection][0];
        // The title card has no item name of its own - F2 renames the board on
        // it, the same as its T button, where every other card edits its caption.
        if (byId(only)?.type === 'title') cmds.editTitleText?.();
        // A font card has no caption to rename - its editable words are the
        // specimen, so F2 opens that instead of a no-op on a missing name.
        else if (byId(only)?.type === 'font') cmds.editFontText?.(only);
        else editItemName(only);
        e.preventDefault();
      } break;
      // By e.key, not e.code: '?' is Shift+/ on most layouts and somewhere else
      // on the rest, and the character is what the legend promises.
      case '?': if (!cmds.inTour?.() && !cmds.tourEditing?.()) {
        cmds.shortcuts?.();
        e.preventDefault();
      } break;
      // The tools and rows that had no key. Each says so on its menu row and in
      // the legend; none while a tour shows the board or its editor picks.
      // Canvas only, as their menu rows are: the Feed has no "here" to write a
      // note at, no anchor to hold and no stack to reorder.
      case 'n': case 'N': if (!onlyLooking() && !vp.isMobile) {
        // At the pointer, where "here" is, as the menu's Add a note here does.
        const at = hover ? vp.toWorld(hover.x, hover.y) : vp.centreWorld();
        cmds.addNoteAt?.(at);
        e.preventDefault();
      } break;
      case 'j': case 'J': if (!onlyLooking()) { cmds.connect?.(); e.preventDefault(); } break;
      // The pen: on, and off again. Canvas only, as its toolbar button is.
      case 'd': case 'D': if (!onlyLooking() && !vp.isMobile && !e.repeat) { cmds.draw?.(); e.preventDefault(); } break;
      // Every command by name, at the pointer - the S box. With cards selected
      // too: what it offers first is what they can do. Prevented, or the S
      // would be typed into the field the keydown has just focused.
      case 's': case 'S': if (!onlyLooking() && !e.repeat) {
        cmds.palette?.(hover?.x, hover?.y);
        e.preventDefault();
      } break;
      case 'l': case 'L': if (!onlyLooking() && !vp.isMobile && selection.size) { cmds.toggleAnchor?.(); e.preventDefault(); } break;
      case ']': if (!onlyLooking() && !vp.isMobile && selection.size) { cmds.raise?.(); e.preventDefault(); } break;
      case '[': if (!onlyLooking() && !vp.isMobile && selection.size) { cmds.lower?.(); e.preventDefault(); } break;
      // Enter opens a lone selected card the way a double-click does - the
      // keyboard's way to the viewer, the note editor and the title's rename.
      // A focused button took its own Enter above (nativeKeyTarget).
      case 'Enter': if (selection.size === 1 && !onlyLooking() && !isMultiSelect()) {
        const only = [...selection][0];
        const type = byId(only)?.type;
        if (type === 'note') cmds.editNote(only);
        else if (type === 'title') cmds.editTitleText?.();
        else if (type === 'font') cmds.editFontText?.(only);
        else if (type === 'board') cmds.openBoard?.(only);
        else cmds.openViewer?.(only);
        e.preventDefault();
      } break;
      // Tab walks the cards while the board itself has the focus - see walkCards().
      case 'Tab': if (walkCards(e)) e.preventDefault(); break;
      // The Menu key and Shift+F10, the keyboard's right-click. Without these
      // every card action was a mouse action: Find could select a card and
      // nothing could then reach its menu, though the menu itself is walked
      // with the arrows once it is open.
      case 'ContextMenu': case 'F10':
        if (e.key === 'F10' && !e.shiftKey) break;
        e.preventDefault();
        menuFromKeys();
        break;
      // Home is this board's word for the middle at 100%, so the key goes there too.
      case '0': case 'Home': cmds.recenter(); e.preventDefault(); break;
      case '1': cmds.zoomActual?.(); break;
      // Held, the zoom box: a drag frames the box, a click zooms in, Alt+click
      // out. Armed as Space is, and let go on the keyup or a blur.
      case 'z': case 'Z':
        zDown = true;
        setPanCursor();
        e.preventDefault();
        break;
      // Shift+F frames what is selected; F, and Shift+F with nothing selected,
      // the whole board.
      case 'f': case 'F':
        if (e.shiftKey && selection.size) cmds.zoomToSelection?.();
        else cmds.fit();
        break;
      case '+': case '=': vp.zoomBy(1.25, zoomMs()); break;
      case '-': case '_': vp.zoomBy(1 / 1.25, zoomMs()); break;
      case 'Escape': {
        // A gesture in progress is the innermost temporary state of all: the
        // cards go back to where the hand picked them up, and nothing records.
        if (cancelGesture()) { markClosed(e); break; }
        // Drawing mode next: the pen is put down, and only that.
        if (penOn()) { setPen({ on: false }); markClosed(e); break; }
        // The cleaning simulator is not in this chain: while it is up it owns
        // the keyboard outright and answers Escape above, before the switch.
        // A running tour first: Escape is the way out of every temporary state
        // in this app, and while the bar is up the tour is the outermost of them.
        // It answers false when there is none, so the ordinary three still run.
        if (cmds.tourStop?.()) { markClosed(e); break; }
        // Then the mode that builds one, which hides the same chrome and is the
        // next temporary state in. Above the pick mode below it because it is
        // the outer of the two: the marks on the cards are what Escape is most
        // likely being pressed at.
        if (cmds.tourEditStop?.()) { markClosed(e); break; }
        // And the pick mode next, for the same reason and with the same shape:
        // it is a temporary state, so Escape ends it - and only it, keeping the
        // group the mode was for. A second Escape then clears that group, which
        // is Escape meaning what it always did one layer further in.
        if (isMultiSelect()) { cmds.toggleMultiSelect?.(); markClosed(e); break; }
        // On the board itself, Escape is also the way off it: the next Tab
        // leaves for the page rather than walking the cards again.
        if (e.target === el) leaving = true;
        // All three run, and the mark says whether any had something to close.
        const selected = selection.size > 0;
        clearSelection();
        const marked = cmds.clearActiveConnection?.() === true;
        if (cmds.closeSidebar() || selected || marked) markClosed(e);
        break;
      }
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown':
        // Alt+Shift+Up: out of a board inside this one, to the board holding it.
        // Not Alt+Up alone, which is the card-to-card step below.
        if (e.altKey && e.shiftKey && !mod && e.key === 'ArrowUp' && cmds.canLeaveBoard?.()) {
          void cmds.leaveBoard?.();
          e.preventDefault();
          break;
        }
        // Alt moves the focus to the next card that way; the plain arrows nudge.
        if (e.altKey && !mod) {
          if (stepCards(e)) e.preventDefault();
          break;
        }
        // The tour owns the arrows while it is up - stepping a reading is what
        // they mean there - and it says so by answering true, including at the
        // last stop. Falls through to the nudge otherwise. Left/Up go back and
        // Right/Down go on, which is the reading order on both axes.
        if (cmds.tourStep?.(e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1)) {
          e.preventDefault();
          break;
        }
        nudge(e);
        break;
    }
  });

  addEventListener('keyup', e => {
    if (e.code === 'Space') cmds.cleanSpace?.(false);
    if (e.code === 'Space') { spaceDown = false; setPanCursor(); }
    if (e.key === 'Control') ctrlDown = false;
    // By the code as well as the key: let go with Alt held, a Mac reports the
    // key as an Ω.
    if (e.code === 'KeyZ' || e.key.toLowerCase() === 'z') { zDown = false; setPanCursor(); }
  });
  // A blur (alt-tab) never delivers the keyup, which would leave pan mode stuck.
  // A pointercancel likewise reports no button, so the middle-button guard is
  // cleared here too rather than trusting the lift to carry it.
  addEventListener('blur', () => {
    spaceDown = false; ctrlDown = false; zDown = false; midPaste.down = false; setPanCursor();
    // The cleaning mode keeps its own Space, fed from the keyup above.
    cmds.cleanSpace?.(false);
  });

  // Swallow the primary-selection paste a middle *drag* fires on release. Capture
  // phase and window-wide, so it runs before the note editor's own paste and the
  // board's paste-to-import below and can stop both. Only when the middle press
  // became a pan: a plain middle click still pastes, and an ordinary Ctrl+V is
  // untouched.
  addEventListener('paste', e => {
    // While the Timeline plays nothing is pasted onto the board, ours or the
    // import's (import/drop.ts), which this capture runs ahead of. A field
    // still takes its paste.
    if (timelinePlaying() && !typingInto(e.target)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      bus.emit('readonly');
      return;
    }
    if (!(midPaste.down && midPaste.dragged)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  function nudge(e: KeyboardEvent) {
    if (!selection.size) return;
    e.preventDefault();
    const sx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const sy = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    // The arrow keys are a drag by another route, so they carry the same stuck
    // notes and the same fenced cards. No z-bump here: a nudge does not raise
    // anything, and the pair are already in the right order relative to each
    // other.
    // Locked out, on the same terms as a drag: the arrow keys are a drag by
    // another route, so a lock that held one and not the other would be a lock
    // that depends on which hand you used. As there, a locked card is held only
    // against being moved itself; inside a moving fence it goes with the fence.
    const before = snapshotGeom(travelling([...selection].filter(id => !isLocked(byId(id)))));
    if (!before.length) return;
    const { dx, dy } = nudgeBy(sx, sy, e.shiftKey, before);
    if (!dx && !dy) return;
    // The one door where "immovable" answers differently: an arrow key on a
    // pinned item unsticks it and nudges *it*, rather than redirecting to its
    // host the way a pointer drag does. The keyboard is the fine-positioning
    // tool - it is how you place a sticker exactly - and having a left arrow
    // move a photograph would be a very large effect from a very small key.
    //
    // Note what it leaves behind: the item stays loose afterwards, indefinitely,
    // until the next *pointer* drag drops it on a host. That asymmetry is the
    // design and not an oversight - see resettle() in state.ts, which is
    // deliberately not called from here.
    //
    // Written into the applied snapshot rather than onto the item, because these
    // snapshots carry the flag (see snapshotGeom) and applyGeom would otherwise
    // write the old value straight back over it. The `before` pair still holds
    // the pinned state, which is what undo puts back.
    applyGeom(before.map(b => ({
      ...b,
      x: b.x + dx,
      y: b.y + dy,
      // Only what the keys drove. A follower towed along by a nudged host has
      // not been unstuck, the same way it has not been unstuck by a drag.
      loose: b.loose || (selection.has(b.id) && isPinned(byId(b.id))),
    })));
    // A held arrow is one act, so it is one undo: each press folds into the
    // last while nothing else has been committed, the selection is the same,
    // and the presses keep coming. Two seconds held was forty entries before,
    // and a long enough nudge pushed real work off the bottom of the stack.
    const key = [...selection].sort().join(' ');
    const now = e.timeStamp;
    const run = lastNudge && lastNudge.cmd === lastCommand() && lastNudge.key === key
      && now - lastNudge.at < NUDGE_RUN_MS ? lastNudge.cmd : null;
    const cmd = commitGeom('Nudge', before, [...selection], { fold: run });
    lastNudge = cmd ? { cmd, key, at: now } : null;
  }

  /**
   * The menu a right-click would open, opened from the keyboard: the card's
   * menu over the selected card, or the board's at the middle of the view.
   *
   * The key also makes the engine send a native `contextmenu` at whatever has
   * focus, which is usually <body> rather than the board - so the listener on
   * #viewport never sees it, and the browser's own menu would come up over
   * ours. The one that follows is swallowed at the window, once.
   */
  function menuFromKeys() {
    if (cmds.tourEditing?.()) return;
    const id = selection.size ? [...selection][selection.size - 1] : null;
    const box = id ? nodeFor(id)?.getBoundingClientRect() : null;
    const x = box ? box.left + box.width / 2 : vp.left + vp.cx;
    const y = box ? box.top + Math.min(box.height / 2, 48) : vp.top + vp.cy;
    swallowNativeMenu = true;
    setTimeout(() => { swallowNativeMenu = false; }, 500);
    cmds.contextMenu(x, y, box ? id : null, box ? selection.size : 0);
  }
  let swallowNativeMenu = false;
  addEventListener('contextmenu', e => {
    // The one Windows sends after a right drag's lift, at wherever it ended -
    // over the sidebar too, where the board's listener would never see it.
    if (rightDragAt && performance.now() - rightDragAt < 500) {
      rightDragAt = 0;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!swallowNativeMenu) return;
    swallowNativeMenu = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  /** The nudge the next press may fold into - see nudge(). */
  let lastNudge: { cmd: NonNullable<ReturnType<typeof lastCommand>>, key: string, at: number } | null = null;

  /**
   * How far one press of an arrow key moves the selection, on this board.
   *
   * The lead is picked here - the selection is the closure's - and the
   * arithmetic is nudgeDelta() at module scope, where the reasoning lives.
   */
  function nudgeBy(sx: number, sy: number, far: boolean, before: GeomSnap[]) {
    const step = stepNow();
    const lead = before.find(b => selection.has(b.id)) || before[0];
    return nudgeDelta(sx, sy, far, lead, board.settings.snap, step, cellInset(step));
  }

  // ---- clipboard --------------------------------------------------------
  //
  // The real copy/cut/paste events, not a Ctrl+C branch in the keydown handler
  // above, and two things follow from that. A `copy` handler is the only place
  // the system clipboard can be written synchronously and without asking
  // permission, which is what lets a copy leave the receipt that decides the
  // next paste (see clipboardHasOurs in state.ts). And the browser only sends
  // these where they belong, so a note being edited or a name being typed keeps
  // the browser's own copy and paste for nothing - the same bargain the
  // `widget` branch in pointerdown makes for the pointer.
  //
  // import/drop.ts listens for `paste` too, to bring images, files and text in
  // from outside. This one is registered first, because main.ts calls
  // initInput() before initDrop(), and stops the event dead the moment it
  // claims it - so exactly one of the two ever acts on a given paste.

  /** A clipboard gesture is ours only when the canvas, not a field, has focus.
   *  An open dialog is not the canvas either: behind the viewer, Ctrl+C took the
   *  card instead of the text selected in it, and Ctrl+X deleted the card. */
  const canClip = (e: ClipboardEvent) =>
    !typingInto(e.target) && !overlayOwnsKeyboard() && !!selection.size;

  addEventListener('copy', e => {
    if (!canClip(e)) return;
    const text = copyItems(selection);
    if (!text) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', text);
  });

  addEventListener('cut', e => {
    if (!canClip(e) || timelinePlaying()) return;
    const text = cutItems(selection);
    if (!text) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', text);
  });

  addEventListener('paste', e => {
    if (typingInto(e.target) || !clipboardSize()) return;
    // A paste aimed into a dialog is not the board's, or copied cards land behind it unseen.
    if (e.target instanceof Element && e.target.closest('dialog')) return;
    const text = e.clipboardData?.getData('text/plain') || '';
    const files = e.clipboardData?.files;
    // Ours wins in two cases and no others. Either the system clipboard still
    // carries the receipt our copy left on it, meaning nothing has been copied
    // anywhere since - or it carries nothing at all, which is what a browser
    // that refused to let us write the receipt looks like, and is anyway the
    // one situation where a paste can mean nothing else. Anything else on it
    // was put there after our copy, and the newer thing is the one meant.
    if (!clipboardHasOurs(text) && (files?.length || text.trim())) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const copies = pasteItems(pasteAt());
    // Selected afterwards, so the copies are what a following nudge, drag or
    // second Ctrl+D acts on - and so the eye is told where the paste landed.
    if (copies.length) select(copies.map(i => i.id));
  });

  /**
   * Where a paste should land, in two cases.
   *
   * Under the cursor, whenever there is one. The cursor is where the eye is and
   * where "here" means, so every paste follows it - Ctrl+V, the menu, a middle
   * click - rather than second-guessing from how far the mouse has moved.
   *
   * Otherwise - a device with no cursor, where `hover` stays null - nothing,
   * meaning "beside the original", unless the box the copy came from is nowhere
   * in view, in which case the middle of the screen, because a paste you cannot
   * see is indistinguishable from one that failed.
   */
  function pasteAt(): Point | null {
    if (hover) return vp.toWorld(hover.x, hover.y);
    const box = clipboardBounds();
    const r = vp.visibleRect(0);
    const inView = box && box.x1 >= r.x0 && box.x0 <= r.x1 &&
                          box.y1 >= r.y0 && box.y0 <= r.y1;
    return inView ? null : vp.centreWorld();
  }

  // The canvas owns the right-click slot: a board's useful actions are spatial,
  // and the browser's menu can't express any of them.
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    // A right press still down (macOS, Linux): whether it was a click is the
    // lift's to say, so the menu is owed rather than opened - see rightPress.
    if (rightPress) {
      if (!rightPress.dragged) rightPress.owed = true;
      return;
    }
    // Read before cancelPress() takes it away. `hold.at` is set on a touch press
    // and on no other, so it is this listener's only way of telling the engines
    // that synthesize a contextmenu out of a long press from a right-click on a
    // mouse - and the two owe the selection different things (see openMenuAt).
    const held = !!hold.at;
    if (held) clearOnLift = null;
    // Some touch engines synthesize this before our hold timer, others after.
    // Whichever arrives first owns the gesture; cancelling here prevents the
    // other path from closing and rebuilding the same menu a moment later.
    cancelPress();
    taps.arm = null;
    taps.card = null;
    // The same four the hold timer drops, and for the same reason: on the
    // engines that synthesize this event *instead of* letting our timer fire,
    // this listener is the long press. Leaving the two empty-tap records
    // standing left the press that opened a menu seeded as the first half of a
    // double tap, so the tap that dismissed the menu could come back as a
    // marquee.
    taps.empty = null;
    taps.lastEmpty = null;
    // The press that opened the tour's menu is not also a step - see tourClick.
    tourClick = null;
    abortGesture();
    if (repeatsLongPressContextMenu(hold.menu, {
      x: e.clientX,
      y: e.clientY,
      at: performance.now(),
    })) {
      hold.menu = null;
      return;
    }
    hold.menu = null;
    openMenuAt(e.clientX, e.clientY, itemIdFromEvent(e.target), held);
  });

  /**
   * `touch` is the hold, and it changes two things about the menu it opens.
   *
   * It holds the selection: on a mouse, opening the menu on bare board is a
   * click on nothing and says so, and the selection goes. A finger has no second
   * button, so the same gesture is the only way to reach this menu at all and
   * cannot also mean "and drop what I picked" - see clearOnLift for the other
   * half of that.
   *
   * And it is passed on to the menu, which draws one row - Select multiple - for
   * a finger and not for a pointer that has a Shift key beside it.
   */
  function openMenuAt(x: number, y: number, hit: string | null, touch = false) {
    // Every row on it edits or starts something, and the Timeline is playing.
    if (timelinePlaying()) return;
    // A finger holding a second card while one is picked is building a group,
    // not asking for a menu: the multi-select mode comes on with that card in
    // it. Here rather than at the hold timer, so the engines whose own long
    // press arrives as the contextmenu above answer the same way.
    if (touch && hit && selection.size && !selection.has(hit) && !isMultiSelect() && cmds.holdToPick) {
      cmds.holdToPick(hit);
      return;
    }
    // A fence's body lets presses through to the board (fences.css), so a
    // press inside one finds no item. Its menu is found by where the press is.
    const id = hit ?? fenceBodyAt(x, y);
    // `touch` is the same fact twice: the menu keeps the selection (below), and
    // the menu itself is told, because one of its rows is the finger's answer to
    // a Shift key and has no business on a menu a mouse opened.
    const keep = touch;
    // Opening outside the selection retargets it, the way every file manager
    // behaves; opening inside one leaves the group intact.
    if (id && !selection.has(id)) select([id], isMultiSelect());
    if (!id && !keep && !isMultiSelect()) clearSelection();
    cmds.contextMenu(x, y, id, selection.size, { touch });
  }

  /**
   * The innermost fence whose open body is under this screen point, or null.
   * Not a rolled fence, which draws only its bar, nor one folded away inside
   * one. Desktop layout only, as every containment answer is.
   */
  function fenceBodyAt(x: number, y: number): string | null {
    if (board.layoutMode === 'mobile') return null;
    const p = vp.toWorld(x, y);
    const rolled = rolledFences();
    return fenceAt(p.x, p.y, f => f.meta?.rolled !== true && !rolledAway(f, rolled))?.id ?? null;
  }
}
