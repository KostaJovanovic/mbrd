// Pointer + keyboard gestures for the canvas. One pipeline, one active
// gesture at a time (enter() is the only writer, GESTURE_MOVES the legal
// table). Not to be split — a second pipeline reintroduces its bugs.
// Pure deciders (readWheel, gestureTransition, pressIntent) are exported
// for tests; the doing stays inside initInput().

import { clamp, hasOwn, markClosed } from '../util.ts';
import { cue } from '../cuelume/engine.ts';
import {
  board, byId, selection, select, deselect, clearSelection, isMultiSelect, topZ, stackOrder,
  snapshotGeom, applyGeom, commitGeom, bus, stuckFollowers, stuckPlacement, wouldStick,
  rolledAway, rolledFences, fenceOf,
  travelling, isFence, isLocked, dragRoot, isPinned, isSticky, stuckTo, resettle,
  copyItems, cutItems, pasteItems, clipboardSize, clipboardBounds, clipboardHasOurs,
  baseStep, timelinePlaying, fenceAt, lastCommand,
} from '../state.ts';
import { zoomMs } from './viewport.ts';
import type { Viewport } from './viewport.ts';
import {
  itemInRect, itemWithinRect, rotatedExtents,
  latticeBox, latticeLow, latticePicture, cellInset, MIN_SIZE, MAX_SIZE, CARD_FLOOR_CELLS,
} from '../geometry.ts';
import type { Box, Bounds, Point } from '../geometry.ts';
import {
  itemIdFromEvent, ensureMounted, nodeFor, sync as syncItems, editItemName, showStickTarget,
  setDragging, barHeight,
} from './items.ts';
import { noteFloor } from './notes.ts';
import { linkURL } from './renderers.ts';
import { isPicture, cardRatio } from './picture-shape.ts';
import { embedFor, embedFloor } from './embed.ts';
import { queryRect, queryAround } from './spatial.ts';
import { holdRoutes } from './web.ts';
import { startEdgePan } from './edge-pan.ts';
import { isDesktop } from '../platform/platform.ts';
import { DEFAULT_WHEEL, wheelPrefs } from '../controls.ts';
import type { WheelPrefs } from '../controls.ts';

const DRAG_SLOP = 3;      // screen px before a press becomes a drag
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_SLOP = 28;
const TAP_MOVE_SLOP = 12;
/** Cards per drop worth a sound of their own. Seven is what cuelume/engine.ts
 *  can lay out in its 80ms lookahead at 12ms apart; beyond that, transients
 *  would share an instant and one sample, so the cap costs nothing audible
 *  and saves Web Audio nodes on a drop that can be 500 cards. */
const TAP_BURST = 7;
// How long a finger has to rest before the press means "show me the menu".
// Long enough not to fire on a slow tap, short enough to feel deliberate;
// it is the interval both mobile platforms use for the same gesture.
const LONG_PRESS_MS = 480;
const LONG_PRESS_CONTEXT_GUARD_MS = 900;
const LONG_PRESS_CONTEXT_GUARD_PX = 24;

// Controls a straddling corner hitbox can cover and must hand the press back
// to, rather than resize over: buttons (play, mute, the big video play), a
// link's anchor, the audio card's waveform, a text field. *Not* the full-card
// surfaces - a model stage, a picture, a note's editable body fill the card
// corner to corner, and a corner over those is meant to resize. See onDown().
const GRIP_YIELD = 'button, a[href], input, .wave';

// Item types the card grid floor (CARD_FLOOR_CELLS) does not bind: a note and a
// text card are walls of words sized by their content, a title is a masthead
// with its own aspect, a swatch is a colour chip, a sticker is a mark, a ghost
// is a drag preview with no grips, and a fence carries its own floor
// (carryFloor). Everything else is a card and may not be dragged below three
// cells across by two down. See the resize floor in onMove().
const NO_GRID_FLOOR = new Set<string>([
  'note', 'text', 'title', 'swatch', 'sticker', 'ghost', 'fence',
]);

/** A geometry snapshot as state.ts hands one back. Named off the function
 *  rather than imported from layout.ts, since state.ts re-exports
 *  snapshotGeom only as a value - reaching past the one door for the type
 *  alone would add a second edge in the graph for a single idea. */
type GeomSnap = ReturnType<typeof snapshotGeom>[number];

/** A place the pointer was, and when. The shape every timing window in this
 *  file compares: a double tap, the native context menu repeating a hold,
 *  a tap that may still be the first half of something. */
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

/** Whether a global canvas shortcut must stand down for this keystroke: the
 *  event was already handled (context menu's capture listener preventDefault-s
 *  its keys) or an overlay owns the keyboard (modal, open menu). Out of the
 *  keydown handler so it's testable without a DOM. See AUD-08. */
export function shortcutsSuppressed(
  defaultPrevented: boolean,
  overlayOwnsKeyboard: boolean,
): boolean {
  return !!(defaultPrevented || overlayOwnsKeyboard);
}

/** A mouse or pen pointerup that leaves a button down ends nothing - see
 *  endPointer. Asks `buttons` only, never `button`: the last release of a chord
 *  can be the right or an aux button. Out of the handler so a test can state it. */
export function liftWithButtonsHeld(
  e: { type: string, pointerType: string, buttons: number },
): boolean {
  return e.type === 'pointerup' && (e.pointerType === 'mouse' || e.pointerType === 'pen')
    && e.buttons !== 0;
}

/** The keys that still work while the Timeline plays: they move the view or
 *  close something. See the keydown handler. */
const VIEW_KEYS = new Set(['0', '1', 'f', 'F', '+', '=', '-', '_', 'Escape']);

/** How long a pause ends a run of nudges. A key held down repeats every 30-50
 *  ms; somebody tapping an arrow to place a card exactly taps well inside a
 *  second. A press later than this starts a step of its own. */
const NUDGE_RUN_MS = 1000;

// ---------------------------------------------------------------------------
// What a press means — pure decision, handler does the doing. Branch order
// matches the handler's; each turns on facts a headless test can state.
// ---------------------------------------------------------------------------

/** What a press turns out to be — one variant per branch of the cascade. */
export type PressIntent =
  | { kind: 'widget' }
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
  /** shift, ctrl, meta, or multi-select mode - the four the cascade treats
   *  identically. A fact here, not a call inside the cascade, so pressIntent()
   *  stays a function of its argument alone. */
  additive: boolean;
  spaceDown: boolean;
  /** A control inside a card: a scrubber, a button, a note being edited. */
  onWidget: boolean;
  /** A resize handle, after the corner-yield look-through. */
  onGrip: boolean;
  /** The item under the point, or null for bare board. */
  onCard: string | null;
  /** Is that card's geometry pinned - `meta.locked`? */
  locked: boolean;
  /** Is it a sticky fixed to a host, stuck and past its settle? A pinned
   *  note/sticker's place and size are already its host's, so this is a
   *  different refusal than `locked`: a locked card is immovable and the
   *  press pans like bare board; a pinned sticky moves with its host, so a
   *  grip press on one falls through to mean what any other press means. */
  pinned: boolean;
  /** Is it unpicked, so a drag would have to select it first? */
  needsTapFirst: boolean;
  /** Is it already in the selection? */
  wasSelected: boolean;
  selectionSize: number;
  /** The second tap of a touch double tap on empty board. */
  doubleTapDrag: boolean;
  isMobile: boolean;
  /** Is a tour running? The board is being shown, not worked on: nothing
   *  moves, resizes, is picked up, or drives the view (see branch below). A
   *  fact here for the same reason as `additive`. */
  touring: boolean;
  /** Is the Timeline playing? The board is read-only then, and a press pans. */
  viewOnly: boolean;
};

/**
 * Nine branches in the handler's order — each step is load-bearing.
 * 1 widget (not with space/middle), 2 frozen tour, 3 space/middle pan,
 * 4 grip resize (single selection only), 5 double-tap marquee,
 * 6 touch tap-gate, 7 card move/locked-pan, 8 modified band, 9 empty.
 */
export function pressIntent(f: PressFacts): PressIntent {
  const middle = f.button === 1;
  // While the Timeline plays, the board changes under the replay and nothing
  // else may change it: every press pans, a control in a card included. Pan,
  // not frozen, because unlike a tour the view is the reader's.
  if (f.viewOnly) return { kind: 'pan', middle };
  if (f.onWidget && !f.spaceDown && !middle) return { kind: 'widget' };
  // While a tour runs the board is frozen: a press takes hold of nothing and
  // drives nothing. Above the grip branch as well as the move one, so a card
  // selected when the tour started cannot be resized by its corners either -
  // and above the space-and-middle pan, because the stops are framed shots and
  // a viewer who has panned off one has no way back but the next stop. Not a
  // lockedPan: that says cards may not move and leaves the view to whoever
  // pressed hardest.
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
    // The four card branches carry the id rather than leaving the caller to
    // reach for it again - the same string the facts arrived with. A branch
    // that only exists because there *was* a card says so in its own type, so
    // nothing downstream has to assert it.
    const carried = { id: f.onCard, additive: f.additive, wasSelected: f.wasSelected };
    return f.locked ? { kind: 'lockedPan', ...carried } : { kind: 'move', ...carried };
  }
  if (f.additive) return { kind: 'marquee' };
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

// Screen pixels of diagonal before a rubber band counts as a rectangle somebody
// drew, rather than a click that happened to be modified. A shift-click on
// empty board starts a marquee of zero size (startMarquee runs on the press,
// not on the first movement), and that gesture means "clear the selection", not
// "here is a region" - so the offer that follows a band has to tell them apart.
// Comfortably above DRAG_SLOP: crossing the slop makes it a drag, this makes it
// a rectangle, and the gap is the band where a wobbly click selects things
// without also being asked about fencing them.
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
 * A card by overlap, a fence only by being covered outright. The asymmetry is
 * the fence's own: it is the one item whose face takes no presses - items.css
 * hands them through to whatever is underneath - so a band swept across that
 * face is drawn *inside* the region rather than aimed at it. A fence is always
 * larger than what is drawn inside it, so under one rule for both, every band
 * within a region caught the region: the offer that follows counted it, the
 * fence it drew was unioned out to swallow the parent it was drawn inside, and
 * dragging what the band caught towed the whole region. To take a fence, put
 * the band round it - or press its name.
 */
export function marqueeHit(
  // A box and which kind of thing it is - the whole of what the two rules read,
  // the same bargain commands/fences.ts's `Boxed` makes, and what lets a test
  // hand this a rectangle rather than a whole board item.
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

/**
 * Decide whether a press on a resize grip is still a tap or has become a drag.
 *
 * A grip waits for real movement before a resize starts, which keeps a plain
 * tap from snapping or committing geometry. A tap that never crosses the slop
 * does nothing; the context menu is reached by right-click or long-press.
 */
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

/**
 * How large a single step has to be before it is taken for a wheel notch.
 *
 * Under every mouse in use: 100 in Chrome and Safari, 120 with some Windows
 * drivers, 3 lines in Firefox (which is deltaMode 1 and never reaches this).
 * Over anything a swipe opens with.
 */
export const WHEEL_NOTCH = 40;

/** How long after one wheel event another still belongs to the same gesture. */
export const WHEEL_STREAM_MS = 200;

/**
 * How much of a zoom one unit of delta is worth, per source.
 *
 * Two numbers because the devices count in different units. A wheel notch is a
 * hundred at a time and wants a small coefficient; a pinch is a stream of
 * single figures describing how far the fingers moved, and at the wheel's rate
 * it would take a pinch across the whole pad to change anything.
 */
const WHEEL_ZOOM_RATE = 0.0016;
const PINCH_ZOOM_RATE = 0.01;

/**
 * The most one event may be worth, so a flung pad cannot jump the view.
 *
 * One notch and a little. A window that is not focused gets its notches
 * coalesced into one large delta (seen on Linux), and at 400 that was 1.9x an
 * event; at this it is about 1.2x, the same as a single Windows notch.
 */
const WHEEL_MAX_STEP = 120;

/**
 * How soon a hi-res wheel has to deliver a detent for it to be read as one.
 *
 * Chromium on Linux (Wayland, or X11 with libinput 1.19 or later) breaks one
 * detent into several fractional deltas of the same size, 53 * v/120 px each,
 * which classifyWheel() cannot tell from a pad. The run of identical deltas is
 * the tell, and it has to arrive quickly. **Reasoned, not measured** - see
 * research/old/linux-wheel-2026-09-20.md.
 */
const HIRES_BURST_MS = 24;

/**
 * How much of the lean is handed back when the platform rails a swipe.
 *
 * Measured, not picked. A swipe down this board with a curve in it arrived as
 * 5257px of vertical and 973px of sideways, the sideways half present in only
 * 75 of its 349 events - the fingers went one way and the platform reported a
 * fifth of it. Three brings that back to roughly half: a swipe that goes where
 * it was aimed without the board sliding out from under the hand.
 *
 * It only touches an axis the platform is *withholding* - see unrail() - so a
 * swipe delivered whole is left alone however lopsided it is. It cannot rescue
 * one railed outright: straight sideways reports vertical of exactly zero, and
 * no multiple of zero is a lean.
 *
 * This is the one number to turn if it feels wrong.
 */
const UNRAIL_GAIN = 3;

/**
 * The most one event may be *boosted* by, in pixels.
 *
 * Not a cap on the movement - what the platform reported passes through
 * untouched, so this can never take away a step the fingers earned. It bounds
 * the invention on top: a delta the driver held back and released in one lump
 * (48px against a 15px-per-event swipe, in the recording) would otherwise be
 * multiplied into a visible sideways jerk.
 */
const UNRAIL_CAP = 40;

/** How quickly the running measures of a gesture follow it. */
const AXIS_EASE = 0.15;

/**
 * The two devices one wheel event can be coming from, and so the two things it
 * can be asking for. See readWheel(), which is where the guess is made.
 */
export type WheelKind = 'pan' | 'zoom';

/**
 * The little of a WheelEvent any of this reads.
 *
 * Structural rather than `WheelEvent`, for the pure helpers' reason: the
 * classification is the one part of this module a runner with no browser can
 * exercise, and it is exercised by handing it six numbers.
 */
export type WheelSample = {
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  ctrlKey: boolean,
  shiftKey: boolean,
  timeStamp: number,
};

/**
 * What one wheel event is asking for - see readWheel().
 *
 * `undo` is the pan this burst already made before it turned out to be a hi-res
 * wheel, in the same sign as `dx` / `dy`. The caller gives it back before the
 * zoom, in the same frame, so the board never shows the in-between position.
 */
export type WheelAction = {
  kind: WheelKind, dx: number, dy: number, factor: number, undo?: Delta,
};

/** The device this burst of wheel events is being read as, and when it last spoke. */
let wheelKind: WheelKind = 'zoom';
let wheelAt = -Infinity;

/**
 * What the burst looks like to the hi-res detent rule - see detent().
 *
 * `step` is the one |dy| every event so far has carried, or NaN once two have
 * differed or anything else ruled the burst out. `panX` / `panY` are what the
 * plain events of the burst actually panned, which is what `undo` hands back.
 */
let burstAt = -Infinity;
let burstDy = 0;
let burstCount = 0;
let burstStep = NaN;
let panX = 0;
let panY = 0;

/** How much each axis has been moving, over this burst alone. */
let axisX = 0;
let axisY = 0;

/**
 * How often each axis arrives at all, over this burst alone.
 *
 * Both start at 1 - honest until proven otherwise - so a swipe is never lifted
 * on its first event or two, where the evidence is thinnest and a wrong answer
 * is most visible. A gated axis falls away from 1 within about a tenth of a
 * second and stays down; an axis the platform reports properly never leaves it.
 */
let seenX = 1;
let seenY = 1;

/**
 * Forget the current burst.
 *
 * **Nothing under web/ calls this** - it exists for tests, which need a known
 * starting point between cases and cannot reach four module-level numbers any
 * other way. The alternative is each case opening with a synthetic gap in
 * `timeStamp`, the same reset written less legibly forty times over. Said out
 * loud because it has been mistaken twice for the live way out of a burst. The
 * live way is the gap: WHEEL_STREAM_MS with no event.
 */
export function resetWheelKind(): void {
  wheelKind = 'zoom';
  wheelAt = -Infinity;
  axisX = axisY = 0;
  seenX = seenY = 1;
  burstAt = -Infinity;
  burstDy = burstCount = panX = panY = 0;
  burstStep = NaN;
}

/**
 * Give back the part of a lean the platform kept.
 *
 * The measure that decides this is *how often the minor axis arrives*, and not
 * how big it is when it does. Those are two different questions and only the
 * first one is evidence of a rail. Recorded on this machine, from the same pad
 * within a minute of each other:
 *
 *   railed   5257px down, 973px across, the across in  75 of 349 events
 *   free      791px down, 1147px across, the across in  58 of  59 events
 *
 * The second is a swipe the platform is reporting faithfully - every event
 * carries both axes, and a hand on that gesture must feel nothing added. Reading
 * the *ratio* cannot tell it from the first: a sideways flick with a little
 * drift in it looks as lopsided as a vertical swipe with the sideways half
 * confiscated, and lifting the drift is the board sliding out from under you.
 * Reading how often the axis shows up tells them apart exactly, because that is
 * the thing the rail actually does - it zeroes events.
 *
 * So the gain rides on the gaps: none, and nothing happens; four events in five
 * missing, and the axis is lifted by nearly UNRAIL_GAIN. What the platform
 * reported is always added to, never replaced - this may hand back movement the
 * driver kept, and can never take away a step the fingers earned.
 *
 * A measure of the burst rather than of one event, necessarily: a single event
 * carrying no sideways is what four out of five look like from inside a rail and
 * also what a perfectly straight moment of a free swipe looks like.
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

/** Which device a single event looks like it came from, read cold. */
function classifyWheel(e: WheelSample, dx: number, dy: number): WheelKind {
  if (e.deltaMode !== 0) return 'zoom';
  // Sideways at all, or in fractions: a wheel can do neither - except a hi-res
  // one on Linux, which detent() catches on the way past.
  if (dx !== 0 || !Number.isInteger(dy)) return 'pan';
  return Math.abs(dy) < WHEEL_NOTCH ? 'pan' : 'zoom';
}

/**
 * Whether this event completes a hi-res wheel detent in a burst read as a pad.
 *
 * All four at once: the burst is fresh (HIRES_BURST_MS), it has never moved
 * sideways or carried a modifier, it is two or more events of exactly the same
 * fractional size, and together they are past a notch. A finger does not repeat a
 * fractional delta to the bit and a swipe starts slow, so a touchpad never
 * satisfies all four - which is what makes this safe to ship unmeasured. If
 * Chromium delivers a detent some other way the rule simply never fires, and
 * the 'zoom-all' preference is what carries the fix.
 */
function detent(e: WheelSample, dx: number, dy: number, at: number): boolean {
  // Fractional too: 53 * v/120 is whole only at a full detent, which
  // classifyWheel() already reads as a notch, and a pad at a steady speed can
  // repeat a whole number of pixels.
  const plain = e.deltaMode === 0 && !e.shiftKey && !e.ctrlKey && dx === 0
    && !Number.isInteger(dy);
  const first = burstCount === 0;
  burstCount += 1;
  // NaN compares unequal to everything, and the count has moved past the first
  // event, so a burst ruled out stays ruled out.
  if (!plain || (!first && Math.abs(dy) !== burstStep)) {
    burstStep = NaN;
    return false;
  }
  if (first) burstStep = Math.abs(dy);
  burstDy += dy;
  return burstCount >= 2 && at - burstAt <= HIRES_BURST_MS && Math.abs(burstDy) >= WHEEL_NOTCH;
}

/**
 * What a wheel event is asking for: `pan` by (dx, dy), or `zoom` by `factor`.
 *
 * Deltas come out in pixels whatever the event counted in, so the caller never
 * has to know about deltaMode. A pinch is always a zoom and never latches the
 * device. Every engine reports a pinch as a wheel event with ctrlKey set and
 * no key pressed, and `ctrlHeld` is what tells the two apart: the caller
 * watches the Control key itself, and a Control that is really held pans up
 * and down, the vertical twin of Shift below.
 *
 * A two-finger scroll is *railed*, and the rail comes in two strengths. A swipe
 * committed to one axis has the other suppressed outright - straight sideways
 * arrives with `deltaY` of exactly zero, and nothing here can invent a movement
 * the page was never told about. A swipe that merely *leans* is only attenuated,
 * and that one unrail() gives back.
 *
 * Shift is the way out of the hard case: it moves the whole delta onto the
 * horizontal whichever axis the pad is willing to report on, so there is one way
 * across that works from inside a vertical rail without changing grip.
 *
 * It is the same key that has always panned a mouse wheel sideways, and reading
 * both here rather than at the call site is what makes them one rule.
 *
 * Applied *after* the device is latched, never as part of it: a mouse user
 * holding Shift is asking for a pan and is still holding a mouse, and letting
 * that answer stand would zoom-lock into pan for the next notch after they let
 * go of the key. Control is applied at the same point for the same reason.
 *
 * `prefs` is the person's answer to what the wheel is *for* (controls.ts), and
 * it is read as late as possible - after the device, after the modifiers. The
 * device question has one right answer and the preference cannot change it: a
 * pad two-finger swipe pans in `zoom` and `scroll`, because a swipe that zoomed
 * would be a setting that broke a gesture nobody asked about. `zoom-all` is the
 * one that asks: it exists for a wheel that cannot be told from a pad, and it is
 * the person saying which it is. Defaulted, so every caller
 * that does not care, tests included, gets the board's own convention.
 */
export function readWheel(
  e: WheelSample, pageHeight = 800, ctrlHeld = false, prefs: WheelPrefs = DEFAULT_WHEEL,
): WheelAction {
  const scale = e.deltaMode === 1 ? WHEEL_LINE : e.deltaMode === 2 ? pageHeight : 1;
  const dx = (e.deltaX || 0) * scale;
  const dy = (e.deltaY || 0) * scale;
  // `reverse` is the wheel's own, never a pinch's: which way a notch turns is a
  // convention somebody disagrees with, and which way fingers move apart is a
  // fact about the hand. Reversing both would make the preference unusable on a
  // laptop that has each.
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
  // Both pairs, not just the magnitudes. seenX/seenY are the presence measures
  // the unrail gain reads, and they are the half that persists: a burst the
  // platform railed drives the gated axis down to near zero, and leaving it
  // there meant the *next* free swipe on the same pad opened amplified by up to
  // UNRAIL_CAP per event until the ease walked it back. Both measures start at
  // "delivered whole", which is what fresh means.
  if (fresh) { axisX = axisY = 0; seenX = seenY = 1; }
  wheelKind = kind;
  wheelAt = at;

  // `dx || dy`, so this is right whether or not the browser did it already -
  // several of them turn Shift+scroll into a horizontal delta on the way past,
  // and swapping a second time would put it back where it started.
  if (e.shiftKey) return { kind: 'pan', dx: dx || dy, dy: 0, factor: 1 };
  // A held Control, and not a pinch, which returned above. In `scroll` mode it
  // is the zoom - the whole point of that mode - and at whichever rate the
  // device is being read as, since Control on a pad still arrives as a stream
  // of single figures and the wheel's coefficient would move almost nothing.
  if (e.ctrlKey) {
    return prefs.mode === 'scroll'
      ? { kind: 'zoom', dx, dy,
          factor: zoom(kind === 'zoom' ? WHEEL_ZOOM_RATE : PINCH_ZOOM_RATE, prefs.reverse) }
      : { kind: 'pan', dx: 0, dy: dy || dx, factor: 1 };
  }

  // `kind` is the device; what it is taken to mean is the preference. In
  // `scroll` mode a notch pans the board instead - a pad was already panning
  // and keeps doing exactly that, unrail and all. `zoom-all` is the other place
  // the two come apart: it overrides the device, which is all it is for.
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

/**
 * Release capture without trusting a separate hasPointerCapture() check.
 *
 * Capture is implicitly released when a pointer ends. Some engines can report
 * it as held and then invalidate the pointer before releasePointerCapture()
 * runs, so the check and release are necessarily one guarded operation.
 */
export function releasePointerSafely(
  // Structural, and only the two methods this actually calls: what the pipeline
  // hands it is #viewport, and what the suite hands it is a stub that throws on
  // release, which is the whole case being covered.
  element: {
    hasPointerCapture?: (pointerId: number) => boolean,
    releasePointerCapture?: (pointerId: number) => void,
  } | null | undefined,
  pointerId: number,
): boolean {
  if (!element?.releasePointerCapture) return false;
  try {
    if (element.hasPointerCapture && !element.hasPointerCapture(pointerId)) {
      return false;
    }
    element.releasePointerCapture(pointerId);
    return true;
  } catch (error) {
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
      return false;
    }
    throw error;
  }
}

/**
 * Take capture without letting a refusal take the press down with it.
 *
 * The other half of releasePointerSafely() above, and it exists for the same
 * reason: `setPointerCapture` throws `NotFoundError` for a pointer that is no
 * longer active, which is a race nothing in here can rule out - a finger that
 * left the glass between the event being queued and the handler running. It was
 * called bare, so that race threw out of `pointerdown` before the gesture was
 * entered, leaving a press that selected a card and then did nothing at all.
 *
 * Structural for the same reason as its partner: the pipeline hands it
 * #viewport and the suite hands it a stub.
 */
export function capturePointerSafely(
  element: { setPointerCapture?: (pointerId: number) => void } | null | undefined,
  pointerId: number,
): boolean {
  if (!element?.setPointerCapture) return false;
  try {
    element.setPointerCapture(pointerId);
    return true;
  } catch (error) {
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
      return false;
    }
    throw error;
  }
}

/**
 * How many cells shift+arrow covers on a snapped board.
 *
 * Shift has to keep meaning "further", and on a snapped board one cell is
 * already what a bare arrow does - so it becomes a decade of them rather than
 * the grid step it means when nothing is snapped.
 */
const NUDGE_LEAP = 10;

/**
 * How close to a grid line still counts as being on it, in cells.
 *
 * A board's coordinates come out of divisions and accumulated drags, so an item
 * sitting exactly on a line is routinely at 3.9999999 cells rather than 4. That
 * matters here and nowhere else: the direction logic below asks "which line is
 * the next one along", and without a tolerance the answer for 3.9999999 going
 * right is the line it is already on, which reads as an arrow key that did
 * nothing.
 */
const ON_LINE = 1e-6;

/**
 * One axis of a resize: the extent it should end up with, given the box the
 * gesture started from and how far the pointer has travelled along that axis.
 *
 * Up here with the other pure rules, and for the same reason. Every other rule
 * in this file that is a function of its arguments alone - isDoubleTap,
 * drewRectangle, marqueeHit, carryFloor, resizeHandleAction, gestureTransition,
 * readWheel, releasePointerSafely - was deliberately hoisted so tests/input.test.js
 * could reach it. These two were the exceptions, and they were the two riskiest
 * pieces of arithmetic in the file: the anchor derivation below and the "flush
 * already" branch in nudgeDelta() had no coverage at all while every trivial
 * predicate around them had plenty. `step` and `inset` are passed in rather than
 * read, which is the whole of what kept them inside the closure.
 *
 * `sign` is +1 when the handle drags the high edge (east, or north - world y
 * points up), -1 for the low one, and 0 for an axis the handle does not touch,
 * whose extent comes back untouched.
 *
 * `snap` is the *grip's*, not the board's: a sticky lying on something is sized
 * off the lattice however the board is set - see startResize().
 *
 * Snapping quantises the *moving edge's world position*, not the extent.
 * Rounding a width to the step would leave both edges off the lattice, since
 * the pinned edge was never on it to begin with; it is the edge the pointer is
 * actually holding that has to land on a grid line for the result to sit flush
 * against the dots on screen. The extent then falls out of the distance back to
 * the edge that stayed put, which is why the anchor is derived here rather than
 * the size being adjusted afterwards.
 *
 * `inset` is the seam, and its sign is what makes the two directions different.
 * A high edge belongs a seam short of its line, so the seam is added before the
 * rounding and taken off after; a low edge belongs a seam past its line, so the
 * same happens the other way about. Both by half the old seam, so two
 * neighbours stand exactly as far apart as they always did while a single item
 * now sits centred in its cells instead of shoved into a corner of them.
 *
 * The limits are applied before the snap so the rounding is handed an edge that
 * is already legal, and repaired after it by stepping one grid line the other
 * way: rounding can only move the edge by half a step, so one line always
 * brings it back inside, and the answer is still on the lattice rather than
 * parked at a bare limit that no grid line passes through. The closing clamp is
 * what actually guarantees the range - it has to hold even where the step is
 * coarser than the whole band between floor and ceiling, and a floor that only
 * usually holds is the same collapsed item it exists to prevent.
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
 * How far one press of an arrow key moves the selection.
 *
 * Snapped and unsnapped are two different questions rather than one question
 * with a different step size, which is the thing this used to get wrong: it
 * added a fixed distance either way, so on a snapped board every arrow key took
 * the item straight off the lattice that dragging it had just put it on, and
 * the only way to line it up again was to pick it up with the mouse.
 *
 * Snapped, the answer is a grid line rather than a distance - the next one
 * along in the direction pressed. An item that is already flush moves exactly
 * one cell; one that is not is pulled onto the lattice by the first press and
 * then moves a cell at a time like everything else. Deriving it from lines
 * rather than from a delta is also what makes the two agree at any zoom: the
 * lattice on screen coarsens as you pull back, and a distance computed from the
 * old step would land between the dots you are looking at.
 *
 * One delta for the whole selection, taken from `lead` - the same bargain the
 * drag makes. Snapping each item to its own nearest line would collapse a
 * carefully spaced group onto the grid the first time somebody tapped an arrow
 * key, which is a rearrangement rather than a nudge.
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
  // The item's *low edges* land on the lattice, not its centre - see the move
  // gesture for why, and snapAll() in state.ts for the arrangement this is
  // keeping rather than imposing. Measured from the seam rather than from the
  // line, so "flush already" means the same thing here as it does there.
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
// Seven modes: idle, press, pan, pinch, marquee, move, resize.
// Table-driven so tests/input.test.js can verify legal transitions
// without pressing a pointer. A second finger always aborts the live
// gesture first (landing in idle), then enters pinch from there.
/** Every gesture mode. String union, not enum (erasableSyntaxOnly). */
export type GestureMode = 'idle' | 'press' | 'pan' | 'pinch' | 'marquee' | 'move' | 'resize';

export const GESTURE_MOVES = {
  // A press decides between five things - see onDown().
  idle: ['pan', 'marquee', 'move', 'press', 'pinch'],
  // The slop is crossed and the press becomes what it was waiting to be, or the
  // finger lifts and it was nothing.
  press: ['resize', 'marquee', 'idle'],
  pan: ['idle'],
  // One finger of a pinch lifts: the survivor carries on as a pan.
  pinch: ['pan', 'idle'],
  marquee: ['idle'],
  move: ['idle'],
  resize: ['idle'],
} satisfies Record<GestureMode, readonly GestureMode[]>;

/**
 * The mode a gesture in `from` reaches by being asked for `to`, or null when
 * that is not a move this pipeline makes.
 *
 * Total, and total on rubbish too: an unknown mode name on either side is not a
 * legal move rather than a throw, because the one caller is a pointer handler
 * and a wedged pointer is a worse failure than a wrong one. hasOwn rather than a
 * bare lookup for exactly that reason - `GESTURE_MOVES['toString']` is a
 * function off the prototype, and calling .includes on it would be the throw
 * this promises not to do.
 */
export function gestureTransition(
  from: string | undefined,
  to: string | undefined,
): GestureMode | null {
  // Two casts, and the two lookups are what make them hold. Nothing here trusts
  // either name: hasOwn decides whether `from` is one of the seven keys, and
  // includes decides whether `to` is one of the modes on that key's list, so a
  // string that is neither takes the null branch like any other non-mode. An
  // absent argument goes the same way - Object.hasOwn(table, undefined) is
  // false, which is the totality this promises without a check of its own.
  // SAFETY: both assertions in this function are the paragraph above - neither
  // name is trusted. `key` is asked of the table through hasOwn and `want` is
  // looked for in the list that answered, so a string that is not a mode takes
  // the null. The casts are only what lets a string be looked up at all.
  const key = from as GestureMode;
  // Annotated because GESTURE_MOVES keeps its literal rows: a lookup on it
  // answers a union of seven tuples, and asking that union whether it includes
  // an arbitrary mode narrows the argument to `never`. The list is read here as
  // what it is for - the modes reachable from one state.
  const legal: readonly GestureMode[] | null =
    hasOwn(GESTURE_MOVES, key) ? GESTURE_MOVES[key] : null;
  // SAFETY: as at `key` above - `want` is looked for in the list `key` answered,
  // and a string that is not on it takes the null.
  const want = to as GestureMode;
  return legal?.includes(want) ? want : null;
}

// MIN_SIZE and MAX_SIZE are the resize limits, in world units, and they live in
// geometry.ts - a resize handle stopped being the only thing that sets a size
// when snapping learned to lay the whole board onto the lattice. The reasoning
// behind both numbers is written there. The floor's job here is the one it has
// always had: the eight grips are sized in screen pixels, so as an item shrinks
// they crowd it rather than shrinking with it. The ceiling's is the drag that
// leaves the window at high zoom - without a stop, one flick could carry an
// item to a size that makes Fit frame the board at nothing.

// ---------------------------------------------------------------------------
// What each mode carries
// ---------------------------------------------------------------------------
//
// One variant per mode, discriminated on `mode`. This is the type-level half of
// what the table above says in prose: the fields a gesture has are the fields of
// the mode it is in, and no branch can read one belonging to a mode it is not -
// which is the same promise "entering a mode replaces the whole object" makes at
// runtime, made twice. `press` is two variants rather than one, told apart by
// `intent` a level further down, for exactly the reason the table gives: both
// are a press waiting out the slop to find out what it is.

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

type PinchGesture = { mode: 'pinch', dist: number, mid: Point };

type MarqueeGesture = {
  mode: 'marquee',
  x0: number, y0: number, x1: number, y1: number,
  additive: boolean,
  // The selection the band started from, frozen. Non-null exactly when
  // `additive` is - startMarquee() is the one place that makes both, off the
  // same shift key - which the type cannot say and applyMarquee() relies on.
  base: string[] | null,
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
  // The lead's start geometry, resolved once from `origin` when the drag is
  // taken. Neither `origin` nor `lead` is reassigned after that, so the snap
  // arithmetic reads this rather than re-finding it every frame.
  leadOrigin: MoveOrigin,
  moved: boolean,
  driven: string[],
  // Whether this drag lands on the lattice, decided once when it is taken - the
  // same freeze a resize grip makes, and for the same reason. It was read live
  // every frame, so toggling snapping mid-drag changed the rule under the hand
  // and the cards already placed by this drag disagreed with the ones still
  // moving. See snapLowFor().
  snap: boolean,
  // What the press that started this found, written on once by that press and
  // read by the lift - see `unpick` in endPointer(). Optional because they are
  // the only two fields of a mode that enter() does not lay down.
  additive?: boolean,
  wasSelected?: boolean,
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
  box: { x: number, y: number, w: number, h: number },
  // A fence's carry, and null for everything else - see carryPlace(). One per
  // card standing in the fence itself; `carried` maps every follower to the
  // index of the card it goes with (itself, its host, or the nested fence it is
  // in), or -1 for one that keeps its plain fraction.
  holds: CarryHold[] | null,
  carried: number[] | null,
  plate: number,
  lockAspect: boolean,
  // A picture card's own proportion, which the grip holds whatever Shift says;
  // null on everything else, and on a picture not yet measured, whose box is
  // held instead.
  picture: number | null,
  // The lattice size a held proportion last landed on, null until it has.
  cells: { w: number, h: number } | null,
  // Whether this grip lands on the lattice at all. The board setting, less the
  // one exception - a sticky lying on something - decided once when the grip is
  // taken. See the note at startResize().
  snap: boolean,
};

/** The one gesture, whichever mode it is in. */
type Gesture =
  | IdleGesture | ResizePress | MarqueePress | PanGesture
  | PinchGesture | MarqueeGesture | MoveGesture | ResizeGesture;

/** The variant - or, for `press`, the two variants - that answer to `mode`. */
type GestureOf<M extends GestureMode> = Extract<Gesture, { mode: M }>;

/**
 * The fields a gesture carries, without the `mode` that names it: what enter()
 * is handed. Distributive on purpose - a plain Omit over a union keeps only the
 * keys every member shares, which for `press` would be `intent` and nothing
 * else.
 */
type GestureData<G> = G extends Gesture ? Omit<G, 'mode'> : never;

/**
 * The three pieces of pointer state that are not a gesture.
 *
 * Named up here with the gesture types rather than left inline at their
 * bindings, because that is the distinction they exist to draw: a Gesture is
 * one at a time and is replaced wholesale, and each of these outlives one. See
 * the paragraphs above each binding in initInput() for what they are for.
 */
type MidPaste = { down: boolean, at: Point | null, dragged: boolean };

type Hold = {
  timer: ReturnType<typeof setTimeout> | 0,
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

/**
 * The commands this pipeline reaches for, handed in rather than imported.
 *
 * canvas/ may not import ui/ (tests/layers.test.js), and half of what a gesture
 * ends in - the menu, the fence offer, the note editor, the viewer - lives up
 * there. main.ts owns the one command surface and hands it down, which is the
 * same move ghosts.ts and every ui/ module makes. Optional members are the ones
 * this file already calls with `?.`: a board with no connections, no viewer and
 * no player is a board this module still drives.
 */
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
  // Read straight from state.ts on the pointer path - the flag is state, not a
  // command - so what is wanted here is only the way *out*, for Escape.
  toggleMultiSelect?(): void,
  /** Turn the multi-select mode on with this card added - a hold on a second card. */
  holdToPick?(id: string): void,
  connectTap?(id: string | null, sticky?: boolean): boolean,
  connectionUnder?(at: Point): { a: string, b: string } | null,
  pickConnection?(at: Point): void,
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
  toggleAnchor?(): void,
  raise?(): void,
  lower?(): void,
  fenceSelection?(): void,
  // The tour's two keys, in the shape the three above use: the command answers
  // whether it took the press. See the Escape and arrow cases below.
  tourStop?(): boolean,
  tourStep?(delta: number): boolean,
  // And the mode that *builds* a tour, which Escape ends in the same shape and
  // one layer in from a running one.
  tourEditStop?(): boolean,
  // And whether one is running, which the *pointer* half needs rather than the
  // keys: a click on bare board means the next stop while a tour is up and
  // means deselect the rest of the time - see tourClick.
  inTour?(): boolean,
  // The editor's two: whether it is up (cards hold still and nothing is
  // written on), and Delete, which there takes the picked stop off the tour
  // and never bins a card. Answers whether it took the key.
  tourEditing?(): boolean,
  tourEditDelete?(): boolean,
  // The konami easter egg (ui/clean/), reached only through here because this
  // module may not import ui/. cleanFeed takes every key and answers true on
  // the one that opened it; the other three are how the mode, once up, owns
  // the keyboard. cleanEscape is a chain rather than a leave - it puts the tool
  // down first, and asks before it ever shuts the mode.
  cleanFeed?(key: string): boolean,
  cleanActive?(): boolean,
  cleanKey?(key: string): boolean,
  cleanSpace?(down: boolean): void,
  cleanEscape?(): boolean,
};

export function initInput(vp: Viewport, cmds: InputCommands): void {
  const el = vp.el;
  // Declared in index.html; an absent one is a broken build rather than a state
  // to recover from - the same thing import/drop.ts says about its overlay.
  const marquee = document.getElementById('marquee')!;

  /** pointerId -> latest client position, for multi-touch bookkeeping. */
  const pointers = new Map<number, Point>();

  /**
   * The one gesture. `mode` is which of GESTURE_MOVES' modes it is in, and every
   * other field on the object is that mode's own working state - the marquee's
   * corners, the move's snapshot, the resize's start box.
   *
   * Never null: `{ mode: 'idle' }` is what "nothing is happening" looks like, so
   * every read is a question about the mode rather than a null check that a new
   * branch can forget. Only enter() assigns it, and entering replaces the object
   * whole, which is the mechanism behind "exactly one gesture at a time": the
   * fields of the gesture just ended cannot be read by the one that follows,
   * because they are not there any more. Mutating the *current* mode's own
   * fields is ordinary and happens all over the pipeline (`moved` on a drag, the
   * band's corners); it is `mode` that has exactly one writer.
   */
  let gesture: Gesture = { mode: 'idle' };

  /**
   * Move into `mode`, carrying `data` as its state.
   *
   * The guard reports rather than refuses. A transition this file does not
   * expect is a bug in this file, and the console is where a bug belongs - but
   * the alternative, refusing the move, would leave a real hand mid-drag in a
   * mode the rest of the pipeline has already stopped believing in, and a wedged
   * pointer is a far worse failure than a wrong mode. So it warns and proceeds:
   * the table is a description that checks itself, not a lock.
   *
   * One path can reach the warning with a real hand on it, and it is a bug this
   * change deliberately did not fix: pressing the middle button in the middle of
   * a left-drag is not an aux button (so onDown does not stand down) and does not
   * add a pointer (a mouse is one pointer), so it lands in the pan branch on top
   * of a standing move. That replaced the gesture where it lay before this table
   * existed - no commit, no cleanup - and it still does. What is new is that it
   * now says so out loud instead of leaving a card mid-drag with no undo entry.
   */
  function enter<M extends GestureMode>(
    mode: M,
    // Optional only because `idle` carries nothing; every other mode's data is
    // required by GestureData, which is what makes a half-built gesture a type
    // error rather than a field read as undefined three branches later.
    data?: GestureData<GestureOf<M>>,
  ): GestureOf<M> {
    if (!gestureTransition(gesture.mode, mode)) {
      console.warn(`[mbrd] input: ${gesture.mode} -> ${mode} is not a gesture this pipeline makes`);
    }
    // The cast is the spread. `mode` and every field of `data` together are
    // exactly the variant `mode` names - that is what GestureData is - but a
    // spread of a generic comes back to tsc as an intersection it will not fold
    // into the union member. The argument types are where the check happens.
    //
    // SAFETY: `data` is GestureData<GestureOf<M>>, which is the named variant
    // minus its `mode` - so putting `mode` back is exactly the variant again.
    // The check happened at the call, where M was fixed.
    const next = { mode, ...data } as GestureOf<M>;
    gesture = next;
    // The viewport's one fact about the hand: is a finger dragging the board
    // right now. It decides whether a Mobile board's edges clamp or resist, and
    // it is written here rather than at the four call sites that start and end a
    // pan because this is the pipeline's only door between modes - so every path
    // out of `pan`, including a pinch stealing it and a pointercancel, clears it
    // for free. Anything that is not a pan is not a finger dragging the board.
    vp.dragging = mode === 'pan';
    // And the lines' one fact about it: while a card is in the hand no route is
    // recalculated, and the drop recalculates them all - see holdRoutes() in
    // canvas/web.ts. Here for the same reason: every way out of `move` passes.
    holdRoutes(mode === 'move');
    return next;
  }

  let spaceDown = false;
  // The Control key, pressed on the keyboard. A pinch sets ctrlKey on its
  // wheel events without one, so this is how readWheel() tells them apart.
  let ctrlDown = false;
  // Linux/X11 pastes the primary selection on a middle click. A middle *click*
  // here should still paste - that is the platform's paste gesture - but a middle
  // *drag* means "pan", and the paste it fires on release would dump the
  // selection into the note being edited or the board's paste-to-import. So the
  // press is tracked, and only a drag (moved past the slop) arms the guard that
  // swallows the release paste (below). `at` is the press origin; `dragged` is
  // set once it travels far enough to be a pan and not a click.
  //
  // Not part of the gesture, and it could not be: the paste it exists to swallow
  // arrives a task *after* the pan that armed it has been released.
  const midPaste: MidPaste = { down: false, at: null, dragged: false };
  // Where the cursor is - a paste lands under it. Null on a touch device, where
  // pasteAt falls back to placing beside the original rather than guessing.
  let hover: Point | null = null;
  // A long press is the touch equivalent of a right-click, and without it the
  // context menu is unreachable with a finger - which is where duplicate,
  // delete, send to back and rename live. Held here rather than inside the
  // gesture, because it has to survive the gesture being replaced (a second
  // finger arriving) and be cancelled by it.
  //
  // `menu` is the menu a hold opened, kept so the native contextmenu some touch
  // engines fire afterwards can be told from a fresh right-click.
  const hold: Hold = { timer: 0, at: null, menu: null };
  // The pointer id of a touch press on bare board that owes the selection a
  // clear, spent on the lift. Null on a mouse, which clears on the press as it
  // always has.
  //
  // A finger cannot right-click: the hold *is* the menu, and the hold starts
  // with a press on the board. Clearing on that press meant that on a phone the
  // only gesture that opens the board menu was also the gesture that threw away
  // the group you were about to open it for - and a group assembled by tapping
  // cards one at a time on a phone is the most expensive thing on the board to
  // rebuild. So the clear waits, and the hold cancels it.
  //
  // Deferred rather than made conditional on movement, so everything else about
  // this press means what it did: a tap on bare board still deselects, a pan
  // still lands with nothing selected. Only the moment moves, from the press to
  // the lift.
  let clearOnLift: number | null = null;
  /**
   * Where a press on bare board began, when it held two or more cards picked.
   * A group is the expensive selection to rebuild, and a board bigger than the
   * screen is looked around by dragging it - so for a group the clear is a
   * *tap's* alone, and a press that travels past the slop calls it off. One
   * card keeps the old rule: a pan still lands with nothing selected.
   */
  let clearIfStill: { x: number, y: number } | null = null;
  /**
   * A press that may still turn out to be the click that walks a tour on.
   *
   * While a tour is running, a click on anything that is not a card means "next
   * stop" - the same click a slide deck answers, and the reason the tour needs
   * no chrome beyond its bar. On a card it means nothing at all: the card is
   * what is being shown, and a press on the thing you are pointing at should
   * not skip past it.
   *
   * Recorded on the press and spent on the lift rather than answered on the
   * press, because a press on bare board is also how the board is panned, and a
   * tour that jumped a stop every time somebody dragged the view an inch would
   * be unusable. TAP_MOVE_SLOP is the same threshold the touch records above use
   * for the same question, so "a click" means one thing in this file.
   *
   * Not a gesture and not a mode - it coexists with the pan the press started,
   * exactly as `taps.arm` coexists with one. The pipeline is untouched.
   */
  let tourClick: { pointerId: number, x: number, y: number } | null = null;
  // The presses that may still turn out to be taps, and the taps just past.
  //
  // None of these is a mode: every one of them coexists with a live gesture -
  // that is the whole point of the pan-then-select gate, which runs a pan while a
  // selection is still pending - and the last two outlive it, since a double tap
  // is two gestures with a gap in the middle.
  //
  //   arm ......... a pointer resting on an unpicked item - see needsTapFirst().
  //                 The gesture is a pan; this is what lets the lift still count
  //                 as a tap if it never moved.
  //   card ........ a press on a card's own surface, still eligible to count as
  //                 a tap. Separate from `arm` because the two cover different
  //                 halves of the same gesture: `arm` only exists on the
  //                 pan-then-select path (touch, or an unpicked card), where a
  //                 mouse press on a card starts a move outright. A tap is a tap
  //                 either way, so this is set on both and cleared by the same
  //                 slop. Only a playing video does anything with it - see
  //                 pauseOnTap(). Kept general in name rather than called
  //                 videoTap, because what it records is a fact about the
  //                 gesture and not about what happens to be under it.
  //   empty ....... a touch on bare board that has not yet wandered, and so may
  //                 still become the first half of a double tap.
  //   lastEmpty ... the tap that did, waiting for its second.
  //   lastTitle ... the previous tap on the title card, so a second one within
  //                 the double-tap window opens its inline rename. Read here in
  //                 the pointer pipeline rather than through a dblclick listener
  //                 because #viewport takes pointer capture on press and that
  //                 retargets the compatibility mouse events to the viewport -
  //                 the same reason the masthead reads its taps directly (see
  //                 editBoardName in main.ts).
  const taps: Taps = { arm: null, card: null, empty: null, lastEmpty: null, lastTitle: null };
  const cancelPress = () => { clearTimeout(hold.timer); hold.timer = 0; hold.at = null; };

  /**
   * A tap on a playing video stops it.
   *
   * The transport's small play button used to be the only way to pause, which
   * put a 25px target on a bar that fades out until you point at the card,
   * while the picture - the obvious thing to press - did nothing at all. So the
   * picture is the pause now.
   *
   * Pause only, never play. A tap is also how a card gets selected, and a tap
   * that toggled would mean you could not pick up a video without starting it;
   * the big button over the poster frame is the play, and it is only in the way
   * while the clip is stopped, which is exactly when it is wanted. So a paused
   * card behaves as any other card does, and a playing one has its whole face
   * as a stop button.
   */
  const pauseOnTap = (id: string) => {
    const item = byId(id);
    if (item?.type !== 'video') return;
    const media = nodeFor(id)?.querySelector('video');
    if (media && !media.paused) media.pause();
  };

  /**
   * Whether a pointer landing on this item should pan the board rather than
   * pick the item up.
   *
   * Moving is always a two-step action: first select, then drag. That keeps a
   * navigation gesture from quietly rearranging the board merely because it
   * began over a card. A tap still selects on lift; movement cancels that
   * pending selection and remains a pan.
   */
  const needsTapFirst = (id: string) => needsSelectionBeforeMove(selection, id);

  // ---- helpers ----------------------------------------------------------

  /**
   * A low edge onto the lattice, or left alone when the gesture is not snapping.
   *
   * `snap` is passed rather than read, so that a drag can hold the answer it
   * started with - see MoveGesture.snap and insetFor().
   */
  const snapLowFor = (v: number, snap: boolean) => (snap ? latticeLow(v, stepNow()) : v);

  // The base lattice - the grid as it stands at 100% - never the zoom-tiered
  // spacing on screen. gridStep() in grid.ts coarsens the *drawn* dots as you
  // zoom out so they never become a fill, but a gesture must land on the same
  // lattice snapAll()/onLattice() use however far the board is zoomed, or an
  // item dragged at one zoom would sit off the lines it snapped to at another.
  const stepNow = () => baseStep();

  /**
   * A box laid on the lattice - see latticeBox() in geometry.ts.
   *
   * The same shape snapAll() in state.ts gives the board when snapping is
   * switched on, and deliberately so: that is the arrangement everything here
   * then has to preserve. An item is flush in the grid only when *both* halves
   * hold, the position and the size - an edge on a line is not enough if the
   * side is one and a half cells long, because then the opposite edge is off by
   * half a cell whatever you do to the position.
   */
  const ontoLattice = (box: Box) => latticeBox(box, stepNow());

  /**
   * The seam a snapped item leaves at each of its four edges, in world units,
   * for a gesture that says whether it is snapping.
   *
   * Every edge carries the same one - see CELL_GAP in geometry.ts - so the space
   * between two neighbours is two halves of a seam rather than one whole one.
   * The sign is what differs: a low edge sits a seam *past* its grid line and a
   * high edge a seam short of the next, which is why the snapping below still
   * has to know which edge the pointer is holding.
   *
   * `snap` is passed rather than read off `board.settings`, and that is the bug
   * this parameter closes. A resize grip decides `snap` once when it is taken,
   * deliberately (see startResize) - the seam was read live, so toggling
   * snapping mid-resize left the edge quantising to `step` with the seam
   * dropped to zero, which puts every snapped edge one `cellInset` off the
   * lattice the rest of the board is laid on. The step and the seam are two
   * halves of one lattice and have to come from one decision.
   */
  const insetFor = (snap: boolean) => (snap ? cellInset(stepNow()) : 0);

  /**
   * A minimum side raised so it does not fight the grid. A floor measured in
   * pixels - a note's text, a player's frame (embedFloor) - rarely lands on a
   * grid line, so `Math.max(snappedSide, floor)` bumps a snapped edge a few
   * pixels off the lattice and the card rests between two cells. Rounded to the
   * next whole cell instead (the same `cells*step - seam` shape latticeSide()
   * gives, up rather than to the nearest, since down could fall under the
   * floor), the floored size is itself a lattice size and stays flush. Off the
   * grid the floor is returned untouched.
   */
  const snapFloorUp = (floor: number, snap: boolean) => {
    if (!snap) return floor;
    const step = stepNow(), gap = 2 * insetFor(snap);
    return Math.ceil((floor + gap) / step) * step - gap;
  };

  /**
   * The cards a fence carries through a resize, put on the lattice. The carry
   * places each at its fraction of the fence, which lands between lines, so on
   * a snapped board every card left the grid it stood on. Each now snaps its own
   * low edges, as a dragged card does. A note stuck to a card takes its host's
   * shift instead, so it stays where it was on the card.
   */
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

  /**
   * One axis of a resize, against this board's current step and seam.
   *
   * The arithmetic is resizeAxisOn() at module scope; this is the two readings
   * that make it about *this* board. See the note there for why it moved.
   */
  const resizeAxis = (
    sign: number, centre: number, extent: number, travel: number, snap: boolean,
  ) => resizeAxisOn(sign, centre, extent, travel, snap, stepNow(), insetFor(snap));

  function setPanCursor() {
    // Not while a tour runs: space is held down and nothing pans, and an open
    // hand promising a drag that will not happen is worse than no cursor at all.
    el.classList.toggle(
      'can-pan', spaceDown && gesture.mode === 'idle' && !cmds.inTour?.(),
    );
  }

  function startPan(e: PointerEvent) {
    const pan = enter('pan', { lastX: e.clientX, lastY: e.clientY });
    // Only a finger throws the board - see flingFrom(). A mouse drag stops
    // where the button came up, which is what every desk-bound tool does and
    // what a pointer that can be held perfectly still makes possible.
    if (e.pointerType === 'touch') pan.track = [];
    el.classList.add('is-panning');
  }

  /**
   * The last few positions a panning finger passed through, and when.
   *
   * A flick's speed cannot be read off the final pointermove: the last event
   * before a lift is often a stray pixel or two over a millisecond, which is
   * either a stationary finger or one moving at two thousand pixels a second
   * depending on which side of the noise it fell. So the speed is measured
   * across a window of the recent past instead, which is long enough to average
   * the jitter out and short enough that it is still describing the throw rather
   * than the whole drag.
   */
  const FLING_WINDOW_MS = 90;
  /** A finger that has been still this long before lifting is not throwing. */
  const FLING_IDLE_MS = 70;

  // The track, rather than the pan that owns it - the same move drawMarquee()
  // and applyMarquee() make with the band, and for the same reason: only a
  // finger's pan has one, and a signature that names the array cannot be handed
  // a mouse pan that has nothing to push onto.
  function trackPan(track: PanSample[], e: PointerEvent) {
    track.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    // Anything older than the window can no longer be the start of the throw.
    // One at a time from the front: the array only ever holds a few events.
    while (track.length > 2 && e.timeStamp - track[0].t > FLING_WINDOW_MS) track.shift();
  }

  /**
   * The speed to hand the board as the finger leaves it, or null for a lift
   * that was not a throw.
   *
   * Two ways to be not a throw, and they are different. A finger that paused
   * before lifting has placed the board somewhere deliberately, and carrying on
   * would take it back off the spot it was just put on - so the gap between the
   * last movement and the lift is what disqualifies that one. A finger that was
   * moving slowly the whole way is caught by glide()'s own floor instead.
   */
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
    // An additive (Shift) band tracks the enclosed set both ways: the selection
    // it started from is frozen here and re-unioned with the currently enclosed
    // items every frame, so a card the band grew over and then left is released
    // again. Without the frozen base, select(ids, true) only ever adds, and the
    // live selection becomes the union of every position the band ever held.
    const band = enter('marquee', {
      x0: p.x, y0: p.y, x1: p.x, y1: p.y,
      additive: e.shiftKey, base: e.shiftKey ? [...selection] : null,
    });
    marquee.hidden = false;
    drawMarquee(band);
    // Applied on the press, not only on the first movement past it.
    //
    // MARQUEE_DRAWN's note says a shift-click on empty board "starts a marquee
    // of zero size ... and that gesture means 'clear the selection'". It did
    // not: applyMarquee() was reached only from pointermove, so a perfectly
    // still modified click selected nothing and deselected nothing, while one
    // pixel of wobble cleared the board. Running it here makes the still click
    // and the wobbly one the same gesture, which is the rule as written - a
    // zero-size band encloses nothing, so a plain one clears and an additive
    // one leaves the base it froze exactly where it was.
    applyMarquee(band);
  }

  // The band, passed in rather than read off `gesture`, so that these two say in
  // their signature what the pipeline has to be in for them to mean anything.
  function drawMarquee(band: MarqueeGesture) {
    // The screen's top-left corner is the world's (min x, *max* y) - world y
    // points up.
    const a = vp.toScreen(Math.min(band.x0, band.x1), Math.max(band.y0, band.y1));
    const b = vp.toScreen(Math.max(band.x0, band.x1), Math.min(band.y0, band.y1));
    marquee.style.left = a.x + 'px';
    marquee.style.top = a.y + 'px';
    marquee.style.width = (b.x - a.x) + 'px';
    marquee.style.height = (b.y - a.y) + 'px';
  }

  function applyMarquee(band: MarqueeGesture) {
    const x0 = Math.min(band.x0, band.x1), x1 = Math.max(band.x0, band.x1);
    const y0 = Math.min(band.y0, band.y1), y1 = Math.max(band.y0, band.y1);
    // The band is a world rectangle, so the spatial index narrows the field to
    // the cells it overlaps instead of hit-testing the whole board every move.
    // queryRect is a superset (a cell is wider than the band's edge), so the
    // precise marqueeHit still runs - it just runs over a handful, not O(board).
    const hit: string[] = [];
    // A card folded away in a rolled-up fence is out of sight, so out of reach.
    const rolled = rolledFences();
    for (const id of queryRect({ x0, y0, x1, y1 })) {
      const it = byId(id);
      if (it && !rolledAway(it, rolled) && marqueeHit(it, x0, y0, x1, y1)) hit.push(id);
    }
    // Additive: replace the live selection with base + enclosed each frame, so
    // the enclosed set tracks the band in both directions (see startMarquee).
    // `base!`: the two are made together in startMarquee() off the one shift
    // key, so an additive band always has the selection it started from.
    if (band.additive) select([...new Set([...band.base!, ...hit])]);
    else select(hit);
  }

  /**
   * Take hold of what the press landed on, or null if there is nothing to hold.
   *
   * Null is not a formality. The press branch below checks `isLocked` on the
   * item under the pointer, and the two filters in here then resolve every
   * selected id to the top of its pile and drop the locked ones - so a *pinned*
   * sticker sitting on a locked photograph passes the press check as an
   * unlocked sticker and comes out of here as nothing at all. That used to
   * build a `move` with an empty `origin`, and the first movement past the slop
   * threw on `lead.x` inside the handler, before applyGeom, with the gesture
   * still standing and capture still held: every subsequent pointermove threw
   * again until the button came up. One press wedged the pipeline.
   *
   * The caller pans instead, which is what a press on the locked photograph
   * itself already does - so the two presses that mean the same thing now
   * behave the same way.
   */
  function startMove(e: PointerEvent, id: string): MoveGesture | null {
    // The top of the pile an id sits in, or the id itself when it sits in none
    // and when the board no longer has it. Written out rather than
    // `dragRoot(byId(sid))?.id ?? sid`, which said the same thing by leaning on
    // dragRoot() being total on a missing item.
    const rootOf = (sid: string) => {
      const it = byId(sid);
      return it ? dragRoot(it).id : sid;
    };
    // A pinned item is not what a press on it takes hold of - its host is. The
    // pile reads as one object under the pointer: press the photograph or press
    // the star lying on it, and the photograph moves with the star riding along.
    // That is already what the hover lift promises (setHoverGroup() lifts the
    // whole pile), so this brings the drag into line with the lift rather than
    // inventing a rule.
    //
    // **The selection is deliberately not touched.** Clicking a pinned star
    // still selects the star, so its own menu, its colour and Delete all still
    // reach it - it just drags the photograph. Those two coming apart, what you
    // have selected and what you are moving, is the one genuinely new idea in
    // this change, and it is why the redirect lives here and not in the
    // selection code a few lines up the call.
    //
    // Mapped across the whole selection rather than off `id` alone, so a
    // multi-select holding a pinned item and something else drives both roots;
    // dedupe, because two stickers on one photo resolve to the same root.
    // Locked cards are not picked up, and they are dropped here rather than at
    // the press so that a mixed selection still works: press one of six cards
    // where two are locked and the other four move, which is what somebody who
    // locked two of them meant. A press *on* a locked card never reaches this
    // function at all - see the move branch of onDown(), where it pans instead.
    const roots = [...new Set([...selection].map(rootOf))].filter(sid => !isLocked(byId(sid)));
    // Whatever is stuck to the selection comes with it, and whatever is fenced
    // by it. Worked out once, here, and then held for the length of the gesture:
    // recomputing it per frame would let notes latch on and fall off as the drag
    // swept the selection across other items, so the group you picked up would
    // not be the group you put down. What is stuck when you take hold is what
    // travels. See travelling() in layout.ts, where the fixed point is worked out.
    // Filtered again on the way out, and not only on the way in: travelling()
    // adds what is stuck to the selection and what is fenced by it, so a locked
    // card inside a fence that is being dragged would otherwise be carried by
    // the fence. A lock that holds against a direct drag and yields to an
    // indirect one is not a lock.
    const moving = travelling(roots).filter(sid => !isLocked(byId(sid)));
    // Snapshotted here, before anything is touched, so the raise below rides
    // along in the same undo entry as the move it belongs to.
    const before = snapshotGeom(moving);
    // Before anything is entered, because there is nothing to enter. See the
    // docstring: this is the pinned-sticker-on-a-locked-card case, and every
    // line below assumes at least one thing is being carried. Tested on
    // `before` rather than on `moving`, because `origin` is built out of it and
    // `origin[0]` is the value that was undefined - snapshotGeom() answers only
    // for ids the board still has, so the two can differ.
    if (!before.length) return null;
    const start = vp.toWorld(e.clientX, e.clientY);
    const lead = rootOf(id);
    // The sides come along as well as the corner: snapping puts the lead's low
    // edges on lines, and an edge is its centre less half its size.
    const origin = before.map(b => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h }));
    const leadOrigin = origin.find(o => o.id === lead) || origin[0];
    const move = enter('move', {
      // `id` is what the pointer landed on and `lead` is what it has hold of -
      // the same thing except on a pinned item. The lift keeps `id`, because a
      // modified click peels the card you clicked; the drag arithmetic and the
      // stick preview read `lead`, because those are about the thing moving.
      id, lead, moving, before, start,
      // Frozen here, like the grip's - see MoveGesture.snap.
      snap: board.settings.snap,
      origin,
      leadOrigin,
      moved: false,
      // What the pointer has hold of, as against what it is towing. Only these
      // ask again what they are stuck to when the drag ends - a note carried
      // across the board by the photo underneath it has not moved relative to
      // anything, and re-parenting it would take apart the pile you built by
      // moving it. See restick() in state.ts.
      //
      // The roots, not the selection: a pinned star did not move relative to the
      // photograph under it, the photograph moved, so the star must not be
      // re-measured on release. It is a towed follower now, whatever the
      // selection says.
      driven: roots,
    });
    for (const sid of moving) ensureMounted(sid);
    // Handed back so the press that started it can write what it found onto the
    // standing gesture - see the move branch of onDown().
    return move;
  }

  /**
   * Bring the gesture's items to the front. Called on the first movement past
   * the slop, not on the press that started it.
   *
   * It used to happen in startMove(), which meant a plain click reordered the
   * board. Nothing committed it, because only a gesture that actually moved
   * gets a history entry - so clicking an item changed its z with no undo entry
   * to reverse it and no markDirty() to say the board had changed. The change
   * was real and the record of it was not: a later unrelated save would write it
   * out, and closing the tab straight after would lose it, and either way the
   * user had done nothing but click.
   *
   * Deferring it costs nothing visible. The slop is three pixels, so anything
   * that is a drag raises before it has visibly moved, and anything that is a
   * click leaves the stack exactly as it found it.
   */
  function raiseToFront(ids: string[]) {
    // Bottom-to-top rather than in selection order, so the group keeps its
    // internal stacking. That is what leaves a stuck note still above the thing
    // it is stuck to when the pair lands, and so still stuck.
    let z = topZ();
    // Guarded, like stackOrder()'s own byId(a)?.z a few lines up. `ids` is the
    // selection as it was when the gesture began, and a delete arriving from
    // anywhere else - the bin, an undo, a paste replacing the board - can leave
    // an id in it that the board no longer has.
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
    // The card being resized, so its corner marks can stay swollen for the
    // length of the drag. Hover alone will not do it: the pointer is captured by
    // #viewport the moment this starts, and it leaves the handle behind as soon
    // as the corner moves - so the mark would thin out under a hand that is
    // still dragging it.
    const node = origin?.node
      || (e.target instanceof Element ? e.target.closest('.item') : null);
    node?.classList.add('is-resizing');
    // A sticky lying on something is sized off the lattice, and this is the one
    // decision that says so - everything below reads `snap` off the grip rather
    // than off the board. It is the same exception the move gesture makes for a
    // note being dropped onto a host: a sticky belongs to the picture under it
    // and not to the grid, so a corner that jumped to the nearest line would
    // pull it off the thing it is stuck to, which reads as a refusal. Its host
    // is on the lattice; the sticky sits where it was put.
    //
    // stuckTo() rather than isPinned(): a sticker dropped three seconds ago is
    // lying on the photograph whatever the settle clock says, and a grip taken
    // during that window must not square it up either.
    //
    // Decided once, with the grip, like everything else here - a note dragged
    // off its host mid-resize would otherwise start snapping halfway through.
    const snap = board.settings.snap && !stuckTo(it);
    // Squared up before the drag begins, if snapping is on and this box was
    // never on the lattice - a photograph imported at its own proportions, a
    // paste, anything a layout placed. Everything below rounds the edge under
    // the pointer to a line, and that only yields a whole number of cells if the
    // edge left behind is on one too; without this the far side is off by
    // whatever fraction the picture happened to arrive at and the item can never
    // sit flush however carefully it is dragged.
    //
    // Done here rather than on arrival because a resize is where it shows and
    // where it is asked for, and because `before` above was taken first - so the
    // correction is inside the same undo entry as the drag that prompted it, and
    // one Ctrl+Z puts back the picture's own shape.
    const box = snap
      ? ontoLattice(it)
      : { x: it.x, y: it.y, w: it.w, h: it.h };
    if (box.x !== it.x || box.y !== it.y || box.w !== it.w || box.h !== it.h) {
      applyGeom([{ id, ...box, rot: it.rot, z: it.z }]);
    }
    // Notes stuck to this card ride the resize. Shrinking a photo under a sticky
    // used to leave the note hanging in mid-air - still "stuck" by the record but
    // no longer physically over the card. Each follower is carried at the same
    // fractional spot on the card (stuckPlacement, per frame below), so the edge
    // that moves takes the note with it and it stays on the card.
    //
    // A fence carries what is inside it on exactly the same terms, and it is the
    // same sentence one relation over: a card is *in* a region the way a sticky is
    // *on* a card, so pulling a region in gathers its cards and pushing it out
    // spreads them. What it replaces is a floor that stopped the drag when the
    // rectangle reached its contents - which was the honest answer while the
    // contents stood still, and is no answer at all once they move, because
    // nothing can be left behind by an edge that brings it along.
    //
    // travelling() rather than the members alone, because a note stuck to a card
    // inside the region has to come too and neither relation can see that on its
    // own. It is the same set a *move* of this fence would carry, which is the
    // point: growing and dragging a region should not disagree about what is in
    // it. Fractional placement moves a nested fence without resizing it, so a
    // nested region's own cards spread further than it does and some may be
    // re-measured out of it on release - the honest cost of not scaling a whole
    // subtree, and the release re-measures anyway.
    //
    // Desktop only. On Mobile a band is one row of a packed column and its cards
    // are underneath rather than inside it, so there is no fraction of it for
    // them to hold - the same rule commitGeom() states about membership there.
    //
    // Snapshotted into `before` so one undo puts the whole group back, but
    // deliberately left out of `driven`: a note that kept its place on the card
    // has not changed what it is stuck to, so it must not be re-measured on
    // release - the same reasoning startMove() gives for a towed follower.
    const riders = isFence(it) && board.layoutMode !== 'mobile'
      ? travelling([id]).filter(rid => rid !== id)
      : stuckFollowers([id]);
    // `byId(rid)!`: `riders` was read off the live board on the line above and
    // nothing between the two can have taken an item off it. This is the one
    // place in the file where that holds - the move gesture's own `origin` is
    // re-read a frame at a time and is guarded for exactly that reason.
    const followers: ResizeFollower[] = riders.map(rid => {
      const r = byId(rid)!;
      return { id: rid, box: { x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot, z: r.z } };
    });
    for (const rid of riders) ensureMounted(rid);
    // What the region has to keep inside its walls: each card standing in the
    // fence itself, where it sits as a fraction of it, and how much room it
    // takes. Frozen with the grip, like everything else here, so a drag that
    // grows past a card and comes back is not held open by something it has not
    // formally picked up - membership is not re-measured until the release.
    //
    // Only the fence's own carry has these. A card being resized under its
    // stuck notes has never had walls and does not want them: a sticky hanging
    // over the edge of a photograph is a sticky, not a mistake. A note on a card
    // in the fence, or a card in a fence inside it, goes with the card or fence
    // it belongs to, so a wall pushing a card pushes its sticky too.
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
      // Resizing a note changes how much of it is over what it is lying on, so
      // it is as much a reason to ask again as moving it is. Only the resized
      // item is driven; its riders keep their stick (see above).
      driven: [id],
      start: vp.toWorld(origin?.x ?? e.clientX, origin?.y ?? e.clientY),
      box: { x: it.x, y: it.y, w: it.w, h: it.h },
      holds, carried, plate,
      // Nothing but a picture is aspect-locked by default. Shift is the lock for
      // everything else, at both ends: on a corner it holds the proportion, on
      // an edge it holds it and scales from that side. Kept as a field rather
      // than folded into the XOR below because it is the *default* for this
      // grip, and a future one may well want its own.
      //
      // A photo or video is not steered by Shift at all: its card is its
      // picture's shape (canvas/picture-shape.ts), and a free corner would only
      // put paper round it or cut it. On the grid the aspect branch lands the
      // pair on whole cells, as near the shape as they allow, and the picture
      // sits inside them.
      lockAspect: isPicture(it),
      picture: isPicture(it) ? cardRatio(it) : null,
      cells: null,
      snap,
    });
  }

  // ---- pointer pipeline -------------------------------------------------

  el.addEventListener('pointerdown', e => {
    // Right/aux: leave alone. Pen as well as mouse, which it did not used to be.
    // A stylus barrel button arrives as `button === 2` with `pointerType ===
    // 'pen'`, fell through this line, took capture, selected the card and
    // started a move - and then the contextmenu handler dropped the gesture
    // under it. A barrel press is the pen's right-click and means what a
    // right-click means. Touch is left out because a touch has no aux button to
    // report; `button` is 0 for every finger.
    if (e.button > 1 && (e.pointerType === 'mouse' || e.pointerType === 'pen')) return;
    // A hand on the board stops the board, before anything else is decided.
    // That is true of a glide let go of a moment ago and of a commanded flight
    // to Home or to Fit alike: catching a moving board has to work the first
    // time, not on the first frame it is dragged - a finger put down to stop
    // something is often a finger that then does not move at all.
    // Not in a tour: the view is the tour's there (see pressIntent), and a tap
    // on a card left the camera stopped between two stops.
    if (!cmds.inTour?.()) vp.onPress();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Two fingers during a tour are not a pinch, for the reason pressIntent()
    // gives one branch down: while the board is being read the view is the
    // tour's, and a pinch is the one gesture that drives it without a press
    // intent to refuse. Captured and returned exactly as a third finger is, so
    // that this pointer can still be taken back out of `pointers` on its lift -
    // see the leak the capture below was added for.
    if (pointers.size >= 2 && cmds.inTour?.()) {
      capturePointerSafely(el, e.pointerId);
      return;
    }

    // A second finger always converts the gesture into a pinch - by dropping
    // whatever was standing (abortGesture, which lands in idle) and entering the
    // pinch from there, never by converting one live gesture into another. That
    // is why GESTURE_MOVES has no pan -> pinch edge to travel along.
    if (pointers.size === 2) {
      cancelPress();
      taps.empty = null;
      taps.lastEmpty = null;
      taps.arm = null;
      taps.card = null;
      // A pinch is a zoom, and a zoom is not an answer about what is selected.
      clearOnLift = null;
      abortGesture();
      // The second finger is captured too, and that is not tidiness. Only the
      // first pointer was ever captured, because this branch returns before the
      // setPointerCapture() further down - so lifting the second finger over
      // the toolbar, over the sidebar, or off the window edge delivered its
      // `pointerup` to that element rather than to a descendant of #viewport,
      // endPointer() never ran, and the id stayed in `pointers` for the life of
      // the page. Every later single-finger press then found `pointers.size ===
      // 2`, entered a pinch against a coordinate belonging to a finger that was
      // no longer there, and a plain tap panned and zoomed the board.
      capturePointerSafely(el, e.pointerId);
      const [a, b] = [...pointers.values()];
      enter('pinch', {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      });
      return;
    }
    // A third finger changes no mode, but it is in `pointers` and it has to be
    // possible to take it back out - same leak, one finger further along.
    if (pointers.size > 2) {
      capturePointerSafely(el, e.pointerId);
      return;
    }

    let target = e.target instanceof Element ? e.target : null;
    // Typed as an HTMLElement for its `dataset`, which is where the handle
    // names which of the eight corners it is - see item-dom.ts, which builds
    // them all and writes data-g on each.
    let grip = target?.closest<HTMLElement>('.grip') || null;
    // A corner hitbox straddles the corner and paints over the card (z-index 2),
    // so a press on a control tucked into a corner - a play button, a scrubber, a
    // link - arrives as the grip. Look past it: if the real element under the
    // point is one of those controls, yield the corner and let the control take
    // the press. Not the full-card surfaces (a model stage, a picture): a corner
    // over those is meant to resize. Below the chrome rung the hitbox is clipped
    // to outside the card (see .grip::before), so it covers no control there and
    // this never fires - the on-card move behaviour is the CSS clip's, not this.
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
    // The connector tool, when it is armed. A press picks an end instead of
    // selecting one, and claims the whole gesture: no capture, no drag, nothing
    // deselected underneath. Caught before every branch below - including the
    // widget one - because while the tool is out, a press on a card means
    // connect it whether or not that card happens to have a scrubber on it.
    //
    // This is the only mode in the app, and it is one branch in the existing
    // pipeline rather than a second pipeline, which is the whole of why picking
    // an end completes on the press and never becomes a drag. cmds.connectTap
    // answers false on every ordinary board, so what this costs the hot path is
    // one boolean.
    //
    // The Shift key goes with it, and this is the only place that has it: a pair
    // completed with Shift held keeps the tool armed for the next one, which is
    // the run of joins that used to be the default (see ui/toolbar.ts). Read off
    // the event rather than off `intent`, because the connector is answered
    // before pressIntent() ever runs - the additive flag it would fold Shift
    // into is about selection, and while the tool is out this press is not.
    if (!viewOnly && cmds.connectTap?.(id, e.shiftKey)) {
      pointers.delete(e.pointerId);
      return;
    }
    // The title card's pen. Caught before the generic widget branch below (a
    // button would otherwise just select the card): it opens the shared style
    // panel and claims the whole press, so the card underneath neither drags nor
    // deselects. Selection is left as-is - the pen only exists while selected.
    if (!viewOnly && target?.closest('.item-pen')) {
      cmds.editTitle?.();
      pointers.delete(e.pointerId);
      return;
    }
    // The title card's T button, caught the same way: it drops into inline rename
    // of the board name and claims the press, so the card neither drags nor
    // deselects underneath it.
    if (!viewOnly && target?.closest('.item-rename')) {
      cmds.editTitleText?.();
      pointers.delete(e.pointerId);
      return;
    }
    // Double-tap the title card itself → edit its name, the same as its T button.
    // A second press within the double-tap window that has not wandered claims the
    // gesture: no capture, no move, just the editor. The first press falls through
    // and selects as usual, recording itself for the second to match against.
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
      // Spent by a press anywhere else, the way lastEmpty is a few lines down.
      // Without this, tapping the title, then a photograph, then the title again
      // - all inside the 350 ms window and within the slop of the *first* tap -
      // matched, and a board that was never double-tapped dropped into its
      // rename. A double tap is two presses in a row, not two presses with a
      // press between them.
      taps.lastTitle = null;
    }
    // A real control inside a card (the audio scrubber, a note being edited)
    // owns the whole gesture: no capture, no drag. Capturing here would redirect
    // every following pointermove to #viewport and leave the scrubber dead.
    // A video's own <video> is deliberately not in this list, because the
    // picture is the card and dragging it has to drag the card; the two buttons
    // laid over it are, as buttons.
    // .model-stage is the 3D canvas: a drag on it turns the model over, so it
    // has to claim the gesture the way the audio scrubber does, or the card
    // would move out from under the hand instead.
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
    // The click that walks a running tour on - see tourClick. The primary
    // button only: the secondary one opens the tour's own menu (ui/menu.ts) and
    // the middle one is a paste, and neither is somebody asking for the next
    // stop. Every pointer type, because a tour shown on a tablet is still a
    // tour; on touch this is the same tap that would have cleared the selection,
    // and during a tour there is nothing selected to clear.
    tourClick = cmds.inTour?.() && e.button === 0 && !id && !widget
      ? { pointerId: e.pointerId, x: e.clientX, y: e.clientY }
      : null;

    // What this press is, decided in one place off facts a test can state - see
    // pressIntent() above. Everything below performs the answer; nothing below
    // re-decides it.
    const intent = pressIntent({
      pointerType: e.pointerType,
      button: e.button,
      // The multi-select mode reads as a modifier held down, and that is the
      // whole of what it does to a press on a card: the tap that would have
      // replaced the selection adds to it instead. Everything that follows -
      // the peel on a second tap, the drag that moves the group - already
      // worked that way for Shift and needs nothing new. It belongs in the
      // facts and not in pressIntent(), which reads no state and is testable
      // for exactly that reason.
      additive: e.shiftKey || e.ctrlKey || e.metaKey || isMultiSelect(),
      spaceDown,
      onWidget: !!widget,
      onGrip: !!grip,
      onCard: id,
      // The tour editor holds every card as if anchored: a press picks it, a
      // drag pans, and no grip resizes - the board is being ordered, not moved.
      locked: !!id && (isLocked(byId(id)) || !!cmds.tourEditing?.()),
      // isPinned(), not stuckTo(): a sticker dropped three seconds ago is still
      // lying loose on its host and is still the thing you reached for, so its
      // grips are still its own. It is the same clock canvas/items.ts draws them
      // by, asked at the same moment, so the handles on screen and the handles
      // this will honour are one answer.
      pinned: !!id && isPinned(byId(id)),
      needsTapFirst: !!id && needsTapFirst(id),
      wasSelected: !!id && selection.has(id),
      selectionSize: selection.size,
      doubleTapDrag,
      isMobile: vp.isMobile,
      // The same question tourClick asks two blocks up, at the same moment and
      // through the same door - one press, one answer about what is running.
      touring: !!cmds.inTour?.(),
      viewOnly,
    });

    // Every press that takes hold of a card, said once here rather than in each
    // branch that performs one.
    //
    // It was in the `move` branch alone, and the branches around it are the
    // reason that read as the app skipping presses. A grip press is `resize`,
    // and a card that has just been dropped is a card that is *selected*, so its
    // grips are showing - which means dragging the same card over and over lands
    // on a grip about as often as not, and both the press and the release were
    // silent. A press on a control inside a card is `widget`, and that was
    // silent too while still selecting the card underneath.
    //
    // `pan` and `empty` are not here because they take hold of nothing, and
    // `tapGate` is not because a gated first tap has not taken hold yet - it
    // sounds on the lift, in endPointer(), which is where it becomes a pick.
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

    // Whatever this press turns out to be, it is not the line that was marked -
    // the one branch below that disagrees says so itself, by marking one again.
    cmds.clearActiveConnection?.();

    if (intent.kind === 'frozen') {
      // A tour is running and this press does nothing - see pressIntent(). Not
      // an early return: the pointer is captured above so that the lift reaches
      // this module (that lift is what walks the tour on - see tourClick), and
      // the long-press arming at the foot of the function is how a finger opens
      // the tour's own menu. preventDefault stops the browser filling the gap
      // with a text selection or an image drag, which is all a frozen press
      // could otherwise turn into.
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
      // A grip press is only a candidate. Waiting for movement keeps a plain tap
      // on a corner from touching snapped geometry, and leaves the tap free to
      // mean select rather than a zero-distance resize.
      //
      // Resize is a single-card operation: it drives one item's geometry off one
      // grip, and there is no defined answer for what a corner drag means across
      // a whole selection. So with more than one card selected a grip press is
      // not a resize at all - it falls through to the move branch below and picks
      // the selection up, the same as a press anywhere else on the card.
      //
      // `press` with an intent, rather than a mode of its own: this and the
      // double-tap band below are the same shape of thing - a press that has
      // landed and is waiting out the slop to find out what it is - and `intent`
      // is which of the two it will become.
      enter('press', {
        intent: 'resize',
        id: intent.id,
        // pressIntent() only answers 'resize' when onGrip was true, and onGrip
        // is this element - so the branch itself is what makes this non-null.
        corner: grip!.dataset.g,
        x: e.clientX,
        y: e.clientY,
        // `?.` rather than a bare read: a grip only exists because `target` did
        // (it came off target.closest), so this can never be the null branch.
        node: target?.closest('.item') ?? null,
      });
    } else if (intent.kind === 'marqueeDrag') {
      // Wait for movement before showing or applying the marquee. A plain double
      // tap does nothing now (it used to fit the board); holding and dragging the
      // second tap turns into select.
      const p = vp.toWorld(e.clientX, e.clientY);
      enter('press', {
        intent: 'marquee', clientX: e.clientX, clientY: e.clientY, x0: p.x, y0: p.y,
      });
    } else if (intent.kind === 'tapGate') {
      // Touch, or the mobile layout whatever the pointer. A finger - and the
      // mobile board, which is a vertical feed you scroll far more than you
      // rearrange - navigates more than it drags, so a press on an unpicked card
      // pans and selects on lift: the two-step gate that keeps a scroll from
      // quietly dragging a card.
      //
      // A mouse on the desktop board has no such tension: a left press on a card
      // is a grab, and waiting for a select-then-drag felt broken. So there the
      // pointer falls through to the move branch below, which selects and picks
      // the card up at once.
      //
      // Pan now, decide on the lift. Nothing is selected here: a press that
      // turns into a drag has to leave the board exactly as a press on empty
      // space would, or the gate would still be moving the selection about.
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
      // No cue here: it is said once for all four card branches, above.
      taps.card = {
        pointerId: e.pointerId, id: cardId, x: e.clientX, y: e.clientY, slop: DRAG_SLOP,
      };
      // A locked card is not something the pointer can take hold of, so the
      // press does what a press on bare board does and pans. Note what is above
      // this line and therefore still happens: the card is *selected*, so its
      // menu, its name, its colour, Delete and the unlock that undoes all this
      // are all still one click away. Only the grab is gone.
      //
      // Panning rather than doing nothing is the whole feel of the feature. The
      // case lock exists for is a backdrop photograph under the cards somebody
      // is arranging, and there every press meant for the board lands on it; a
      // locked card that swallowed those presses would be worse than the
      // unlocked one, not better.
      //
      // Not an early return, which would fall past the long-press arming at the
      // foot of this function - and on a phone that hold is the *only* way to
      // reach a locked card's menu, which is where the unlock is.
      if (intent.kind === 'lockedPan') {
        startPan(e);
      } else {
        const move = startMove(e, cardId);
        // Nothing to carry - a pinned item whose host is locked. The press
        // means what a press on that host means, so it pans. See startMove().
        if (!move) startPan(e);
        else {
          // Carried on the gesture so the lift can tell a selection edit from a
          // pick - see `unpick` in endPointer(). A modified press means "toggle
          // this card", and whether the lift should drop it again depends on
          // what the press found, not on how big the selection ended up.
          //
          // Written straight onto the standing gesture, which startMove() hands
          // back: it is the `move` mode's own state, and only `mode` itself has
          // to go through enter().
          move.additive = additive;
          move.wasSelected = held;
        }
      }
    } else if (intent.kind === 'marquee') {
      startMarquee(e);
    } else {
      // Nothing a press on bare board does clears the group while the mode is
      // on - not a pan, not a tap. That is the half of it a person can feel:
      // building a group of nine on a board bigger than the screen means panning
      // between them, and a pan that cost you the nine is the mode failing at
      // the one thing it exists for. The way out is the row that turned it on,
      // Escape, or tapping the cards back off.
      clearIfStill = null;
      if (isMultiSelect()) clearOnLift = null;
      // A group survives a pan, from any pointer: only a tap puts it down.
      else if (selection.size > 1) {
        clearOnLift = e.pointerId;
        clearIfStill = { x: e.clientX, y: e.clientY };
      }
      // Touch defers it to the lift so a hold can cancel it - see clearOnLift.
      else if (e.pointerType === 'touch') clearOnLift = selection.size ? e.pointerId : null;
      else if (selection.size) clearSelection();
      // A press on bare board that happens to land on a connection points at
      // that connection instead of at nothing - which is what the line lighting
      // up under the pointer has been promising all along, and what gives Delete
      // something to remove that is not a card. It still pans: pointing at a
      // line is a click, and this press may yet become a drag.
      cmds.pickConnection?.(vp.toWorld(e.clientX, e.clientY));
      startPan(e);
    }

    // Armed after the gesture, so the early returns above - a widget claiming
    // the press, a second finger - never reach it. It waits out the whole
    // duration and then checks that the press is still a press: a drag cancels
    // it from pointermove, and lifting cancels it from endPointer.
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
        // nor the click that walks a tour on.
        clearOnLift = null;
        tourClick = null;
        // Whatever the finger had started - a move, a pan, a marquee - it was
        // not that. Dropped rather than committed, since nothing moved.
        abortGesture();
        hold.menu = { x: p.x, y: p.y, at: performance.now() };
        openMenuAt(p.x, p.y, p.id, true);
      }, LONG_PRESS_MS);
    }
    setPanCursor();
  });

  el.addEventListener('pointermove', e => {
    // Before the gesture guard below, which drops every pointer that is not
    // pressed - and a hovering mouse is exactly that. Touch is excluded
    // because a finger that is not down is not anywhere.
    // Mirrored onto the viewport so the import layer's paste (drop.ts), which
    // has no view into this module's `hover`, can land under the cursor too.
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
    // And the same slop again for the tour's click: a pointer that has gone
    // this far was moving the board, not asking for the next stop.
    if (tourClick?.pointerId === e.pointerId
        && Math.hypot(e.clientX - tourClick.x, e.clientY - tourClick.y) > TAP_MOVE_SLOP) {
      tourClick = null;
    }
    // The same slop, for the same reason: a finger that has travelled this far
    // was panning, and a pan must not leave a selection behind it.
    if (taps.arm?.pointerId === e.pointerId
        && Math.hypot(e.clientX - taps.arm.x, e.clientY - taps.arm.y) > TAP_MOVE_SLOP) {
      taps.arm = null;
    }
    // And a card that has been dragged was not tapped. Its own slop, carried on
    // the record, because the two paths that set it disagree about how far a
    // press may wander and still be a press - and both are right. On the pan
    // path nothing under the finger moves until the lift, so it gets the same
    // generous TAP_MOVE_SLOP the selection does, for the same finger-wobble
    // reason. On the move path the card is already following the pointer at
    // DRAG_SLOP, and a gesture that visibly moved a card should not also have
    // paused it.
    if (taps.card?.pointerId === e.pointerId
        && Math.hypot(e.clientX - taps.card.x, e.clientY - taps.card.y) > taps.card.slop) {
      taps.card = null;
    }
    // A finger that has travelled is dragging, not pressing. The same slop the
    // move gesture uses, so the two agree about when a press has become a drag.
    if (hold.at && Math.hypot(e.clientX - hold.at.x, e.clientY - hold.at.y) > DRAG_SLOP) {
      cancelPress();
      if (e.pointerType === 'touch') taps.lastEmpty = null;
    }
    if (gesture.mode === 'idle') return;

    // The branches are the modes, in the order they were always tested in. The
    // one that does not end in a return is deliberate: a grip press that crosses
    // the slop starts the resize and then falls through to the resize branch
    // below, so the event that decided it also applies its first step.
    if (gesture.mode === 'press' && gesture.intent === 'resize') {
      const pending = gesture;
      const action = resizeHandleAction(
        { x: pending.x, y: pending.y },
        { x: e.clientX, y: e.clientY },
      );
      if (action !== 'resize') return;
      cancelPress();
      // Leaves the machine in `resize` - unless the card has gone, in which case
      // startResize() returns without entering and the press stands until the
      // finger lifts, which is what it did before.
      startResize(e, pending.id, pending.corner, pending);
    }

    if (gesture.mode === 'pinch') {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      vp.panByScreen(mid.x - gesture.mid.x, mid.y - gesture.mid.y);
      vp.zoomAt(mid.x, mid.y, dist / gesture.dist);
      gesture.dist = dist;
      gesture.mid = mid;
      return;
    }

    if (gesture.mode === 'pan') {
      vp.panByScreen(e.clientX - gesture.lastX, e.clientY - gesture.lastY);
      gesture.lastX = e.clientX;
      gesture.lastY = e.clientY;
      if (gesture.track) trackPan(gesture.track, e);
      // Once a middle-button pan clears the slop it is a drag, not a click, so
      // the release paste is the pan's and gets swallowed rather than pasted.
      if (midPaste.down && !midPaste.dragged && midPaste.at
          && Math.hypot(e.clientX - midPaste.at.x, e.clientY - midPaste.at.y) > DRAG_SLOP) {
        midPaste.dragged = true;
      }
      return;
    }

    if (gesture.mode === 'press' && gesture.intent === 'marquee') {
      if (Math.hypot(e.clientX - gesture.clientX, e.clientY - gesture.clientY) <= DRAG_SLOP) return;
      const p = vp.toWorld(e.clientX, e.clientY);
      const band = enter('marquee', {
        // `base` null and not absent: this band is never additive, so nothing
        // reads it - but a mode's fields are laid down whole by enter(), and a
        // marquee with no `base` at all would be the one exception.
        x0: gesture.x0, y0: gesture.y0, x1: p.x, y1: p.y, additive: false, base: null,
      });
      marquee.hidden = false;
      drawMarquee(band);
      applyMarquee(band);
      followEdge(e);
      return;
    }

    track(e.clientX, e.clientY, e.shiftKey);
    followEdge(e);
  });

  /**
   * One step of a marquee, a move or a resize, with the pointer at this screen
   * point. The tail of the pointermove handler, and a function of its own so
   * the edge loop can run it again at a still pointer while the board pans
   * under it - see followEdge().
   */
  function track(clientX: number, clientY: number, shiftKey: boolean) {
    if (gesture.mode === 'marquee') {
      const p = vp.toWorld(clientX, clientY);
      gesture.x1 = p.x; gesture.y1 = p.y;
      drawMarquee(gesture);
      applyMarquee(gesture);
      return;
    }

    if (gesture.mode === 'move') {
      // Bound once, like `pending` and `grip` in the branches either side. The
      // reads below happen inside callbacks (`find`, `flatMap`) as well as out
      // of them, and a name that is the move says the same thing in both.
      const drag = gesture;
      const p = vp.toWorld(clientX, clientY);
      let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx * vp.zoom, dy * vp.zoom) < DRAG_SLOP) return;
      // Shift held during the drag keeps it to one axis, whichever the hand has
      // gone further along from the start - and lets go the moment Shift does.
      // Read per move, never at the press: Shift *at the press* is the additive
      // pick (pressIntent), and a drag that moved never peels on the lift, so
      // the two meanings of one key cannot meet.
      const axis = shiftKey ? (Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y') : null;
      if (axis === 'x') dy = 0;
      if (axis === 'y') dx = 0;
      // The press has become a drag. Raise now, so the stack change belongs to
      // the move that is about to be committed - see raiseToFront.
      if (!drag.moved) {
        raiseToFront(drag.moving);
        // The pointer is captured by #viewport, so the cursor is #viewport's
        // however far the card under it wants a grabbing hand. Mark the viewport
        // for the length of the drag - see #viewport.is-moving in the CSS.
        el.classList.add('is-moving');
        // And the cards themselves are picked up - the lift and lean items.css
        // gives .is-dragging, which nothing used to set.
        setDragging(drag.moving, true);
      }
      drag.moved = true;
      // Snap the dragged item; everything else keeps its offset from it, so a
      // multi-selection moves rigidly instead of collapsing onto the grid.
      //
      // The item's *low edges* land on the lattice, not its centre. Centres were the
      // obvious thing to round and the wrong one: an item an odd number of cells
      // wide has its centre half a cell off the lattice by construction - that
      // is what being an odd width means - so rounding the centre to a line
      // pushed both its sides half a cell off instead. Edges are also what
      // snapAll() lines up when snapping is switched on, so this is the same
      // arrangement being kept rather than a second one being imposed.
      const lead = drag.leadOrigin;
      const low = { x: lead.x + dx - lead.w / 2, y: lead.y + dy - lead.h / 2 };
      // The held axis does not snap either: a card that started off the lattice
      // would otherwise step sideways onto it, which is the one move Shift says
      // not to make.
      let sx = axis === 'y' ? 0 : snapLowFor(low.x, drag.snap) - low.x;
      let sy = axis === 'x' ? 0 : snapLowFor(low.y, drag.snap) - low.y;
      // A dragged note that would stick: show its would-be host wearing the
      // selection ring so the target is unmistakable before release, and - when
      // snapping is on - let the note land exactly where it was let go rather
      // than on the nearest grid line, since it is being stuck to that host and a
      // sticky that jumps a few pixels off the picture reads as a refusal. Only
      // the note being dragged is measured; everything else keeps snapping.
      //
      // The gesture's `lead`, not its `id`: a press on a pinned star is dragging
      // the photograph, and the photograph is not looking for a host. Asking
      // about the star would light up whatever it is about to be carried over.
      // Only the cards the spatial index holds around the note are asked, not
      // the whole board on every move (research/old/done-2026-09-15.md, R23).
      const leadItem = byId(drag.lead);
      const at = isSticky(leadItem)
        ? { x: lead.x + dx, y: lead.y + dy, w: leadItem.w, h: leadItem.h }
        : null;
      const host = at ? wouldStick(at, drag.lead, leadItem, queryAround(at)) : null;
      showStickTarget(host);
      if (drag.snap && host) {
        sx = 0;
        sy = 0;
      }
      // flatMap rather than map: `origin` was taken when the gesture began, and
      // an item can leave the board mid-drag - deleted from the bin, undone, or
      // swapped out wholesale by a load. Dropping it here rather than reading w
      // off undefined is the same call applyGeom() and snapshotGeom() already
      // make; the gesture then simply carries what is left.
      applyGeom(drag.origin.flatMap(o => {
        const it = byId(o.id);
        return it
          ? [{ id: o.id, x: o.x + dx + sx, y: o.y + dy + sy, w: it.w, h: it.h, rot: it.rot, z: it.z }]
          : [];
      }));
      return;
    }

    if (gesture.mode === 'resize') {
      // The card being resized can leave the board mid-gesture - deleted from
      // the bin, undone, or swapped out wholesale by a load. Checked at the head
      // of the branch rather than at the note-floor read below, which was the
      // first line to touch it and threw; abortGesture() commits whatever the
      // gesture had already done and lets go, which is what a release would have
      // done a moment later anyway.
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
      // A held proportion reads the pointer unsnapped and lands on the lattice
      // once, at the end of its branch: sides snapped first are steps, and the
      // proportion built from steps jumps a cell at a time.
      let w = resizeAxis(signX, grip.box.x, grip.box.w, dx, grip.snap && !locked);
      let h = resizeAxis(signY, grip.box.y, grip.box.h, dy, grip.snap && !locked);
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
        if (grip.snap) {
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
            && Math.hypot(w - lattice.w, h - lattice.h) + 0.3 * step > Math.hypot(w - held.w, h - held.h)) {
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
      // side drag should do.
      applyResize({
        id: grip.id,
        x: grip.box.x + signX * (w - grip.box.w) / 2,
        y: grip.box.y + signY * (h - grip.box.h) / 2,
        w, h, rot: it.rot, z: it.z,
      });
    }
  }

  // A move, a band or a grip held near the edge of the room the board is seen
  // in pans the board (canvas/edge-pan.ts), and each step runs track() again at
  // the still pointer, so what is carried stays under it. Started once the drag
  // is under way with one pointer down, and stopped in releaseGesture(), the one
  // way back to idle.
  let lastDrag: { x: number, y: number, shift: boolean } | null = null;
  let stopEdge: (() => void) | null = null;
  function followEdge(e: PointerEvent) {
    lastDrag = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
    if (stopEdge || pointers.size !== 1) return;
    if (gesture.mode !== 'marquee' && gesture.mode !== 'resize'
      && !(gesture.mode === 'move' && gesture.moved)) return;
    stopEdge = startEdgePan(vp, {
      point: () => lastDrag,
      onPan: () => { if (lastDrag) track(lastDrag.x, lastDrag.y, lastDrag.shift); },
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
    cancelPress();
    pointers.delete(e.pointerId);
    releasePointerSafely(el, e.pointerId);
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
    const banded = e.type === 'pointerup' && gesture.mode === 'marquee'
        && drewRectangle(gesture, vp.zoom)
      ? {
        x0: Math.min(gesture.x0, gesture.x1), y0: Math.min(gesture.y0, gesture.y1),
        x1: Math.max(gesture.x0, gesture.x1), y1: Math.max(gesture.y0, gesture.y1),
      }
      : null;
    finishGesture();
    if (unpick) deselect(unpick);
    if (banded) cmds.fencePrompt(e.clientX, e.clientY, banded);
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
    // A drop that found a host is the way back from Unstick, and it is the only
    // way back - there is no "stick to this card" menu entry, because putting it
    // on the card is already how you say that. In front of the commit, not
    // inside it, so undo restores the flag instead of re-deriving it; resettle()
    // in state.ts argues the whole of it. Only on a gesture that moved, so a
    // plain click on a loose note cannot quietly re-pin it.
    if (commit) {
      if (gesture.mode === 'move' && gesture.moved) {
        resettle(gesture.driven);
        commitGeom('Move', gesture.before, gesture.driven);
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
      if (gesture.mode === 'marquee' && selection.size) cue('sweep');
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
      applyGeom(gesture.before);
    }
    if (gesture.mode === 'marquee') marquee.hidden = true;
    // Both modes that carry a node: `resize`, and the `press` that was on its way
    // to one. Neither of the others has the field, which is the shape of the
    // gesture object doing the discriminating for us - and `in` is that sentence
    // said so that the typechecker reads it too, rather than a mode list here
    // that would have to be kept level with the two declarations.
    if ('node' in gesture) gesture.node?.classList.remove('is-resizing');
    if (gesture.mode === 'move' && gesture.moved) setDragging(gesture.moving, false);
    el.classList.remove('is-panning', 'is-moving');
    showStickTarget(null);
    enter('idle');
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
    if (g.mode !== 'move' && g.mode !== 'resize' && g.mode !== 'marquee' && g.mode !== 'press') return false;
    const base = g.mode === 'marquee' ? g.base ?? [] : null;
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
    if (timelinePlaying() && (mod ? e.key.toLowerCase() !== 's' : !(VIEW_KEYS.has(e.key) || e.code === 'Space'))) return;

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
    // (find next) has nothing to find on a board.
    if (mod && e.key.toLowerCase() === 'g' && !onlyLooking()) {
      e.preventDefault();
      if (selection.size) cmds.fenceSelection?.();
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
        const at = hover ? vp.toWorld(hover.x, hover.y) : vp.toWorld(vp.left + vp.cx, vp.top + vp.cy);
        cmds.addNoteAt?.(at);
        e.preventDefault();
      } break;
      case 'j': case 'J': if (!onlyLooking()) { cmds.connect?.(); e.preventDefault(); } break;
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
        else cmds.openViewer?.(only);
        e.preventDefault();
      } break;
      // The Menu key and Shift+F10, the keyboard's right-click. Without these
      // every card action was a mouse action: Find could select a card and
      // nothing could then reach its menu, though the menu itself is walked
      // with the arrows once it is open.
      case 'ContextMenu': case 'F10':
        if (e.key === 'F10' && !e.shiftKey) break;
        e.preventDefault();
        menuFromKeys();
        break;
      case '0': cmds.recenter(); break;
      case '1': cmds.zoomActual?.(); break;
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
        // All three run, and the mark says whether any had something to close.
        const selected = selection.size > 0;
        clearSelection();
        const marked = cmds.clearActiveConnection?.() === true;
        if (cmds.closeSidebar() || selected || marked) markClosed(e);
        break;
      }
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown':
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
  });
  // A blur (alt-tab) never delivers the keyup, which would leave pan mode stuck.
  // A pointercancel likewise reports no button, so the middle-button guard is
  // cleared here too rather than trusting the lift to carry it.
  addEventListener('blur', () => {
    spaceDown = false; ctrlDown = false; midPaste.down = false; setPanCursor();
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
    // that depends on which hand you used.
    const before = snapshotGeom(travelling(selection).filter(id => !isLocked(byId(id))));
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
    return inView ? null : vp.toWorld(vp.left + vp.cx, vp.top + vp.cy);
  }

  // The canvas owns the right-click slot: a board's useful actions are spatial,
  // and the browser's menu can't express any of them.
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
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
