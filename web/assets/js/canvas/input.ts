// Pointer + keyboard gestures for the canvas.
//
// One Pointer Events pipeline handles mouse, pen and touch. Exactly one gesture
// is active at a time, and a second finger always wins - it cancels an
// in-progress drag and takes over as a pinch, which is what makes two-finger
// pan/zoom feel right on a phone.
//
// That "exactly one" used to be a promise every branch had to keep on its own:
// a nullable `g` plus a bag of booleans beside it, whose legal combinations
// existed only in the author's head. It is structural now. There is a single
// `gesture` object with a `mode` field - idle, press, pan, pinch, marquee, move,
// resize - the data each gesture needs hangs off that object, and enter() is the
// only thing in the file that writes `mode`. Entering a mode replaces the whole
// object, so no field of the gesture just ended can be read by the next one, and
// there is no second gesture for a branch to forget about. The legal moves are
// GESTURE_MOVES, one table, below; enter() checks itself against it.
//
// Gesture map:
//   left-drag empty space ....... pan            (an infinite board pans more than it marquees)
//   shift / ctrl + drag empty ... marquee select
//   double-tap + drag empty ..... marquee select on touch
//   middle-drag or space+drag ... pan, from anywhere
//   drag an item ................ move the whole selection, plus anything stuck to it
//   drag a corner grip .......... resize freely;  shift holds the proportion
//   drag an edge grip ........... resize that axis alone, media included
//   wheel ....................... zoom to cursor
//   two fingers on a touchpad ... pan in both axes;  pinch zooms to the cursor
//   shift + wheel or scroll ..... pan sideways, out of the platform's axis rail
//   two fingers on a screen ..... pan + pinch zoom
//
// What is a mode and what is not. A mode is a thing the pointer is *doing*, and
// the test is whether two of them could be true at once: if they could, one of
// them was never a mode. So the seven kinds the pipeline already had became the
// seven modes (`resize-pending` and `touch-marquee` are the one `press` mode,
// told apart by `intent` - both are a press waiting out the slop to find out
// what it is), and everything that outlives or straddles a gesture stayed
// outside it:
//
//   spaceDown ....... a modifier key. It is held *across* gestures and decides
//                     what the next press means; folding it into the mode would
//                     make "space is down while panning" unsayable.
//   hover ........... where the cursor is. True of a pointer that is doing
//                     nothing at all, which is the opposite of a mode.
//   pointers ........ which pointers are down. The machine is driven by this,
//                     not the same fact as what the machine is in.
//   taps ............ the presses that may still turn out to be taps (`arm`,
//                     `card`, `empty`) and the taps just past (`lastEmpty`,
//                     `lastTitle`). Every one of these coexists with a live
//                     gesture - the whole point of the pan-then-select gate is
//                     that a pan is running while a selection is still pending -
//                     and the last two outlive it by design, since a double tap
//                     is two gestures. Five closure variables, one record.
//   hold ............ the long-press timer, its origin, and the menu it opened.
//                     Deliberately outside the gesture: it has to survive the
//                     gesture being replaced by a second finger and cancel it.
//                     Three closure variables, one record.
//   midPaste ........ the X11 primary-selection guard. Outlives the gesture on
//                     purpose - the paste it swallows arrives a task *after* the
//                     pan that armed it. Three closure variables, one record.

import { clamp } from '../util.ts';
import {
  board, byId, selection, select, deselect, clearSelection, isMultiSelect, topZ, stackOrder,
  snapshotGeom, applyGeom, commitGeom, bus, stuckFollowers, stuckPlacement, wouldStick,
  travelling, isFence, isLocked, dragRoot, isPinned, isSticky, stuckTo, resettle,
  copyItems, cutItems, pasteItems, clipboardSize, clipboardBounds, clipboardHasOurs,
  baseStep,
} from '../state.ts';
import { zoomMs } from './viewport.ts';
import type { Viewport } from './viewport.ts';
import {
  itemInRect, itemWithinRect, rotatedExtents,
  latticeBox, latticeLow, cellInset, MIN_SIZE, MAX_SIZE,
} from '../geometry.ts';
import type { Box, Bounds, Point } from '../geometry.ts';
import {
  itemIdFromEvent, ensureMounted, nodeFor, sync as syncItems, editItemName, showStickTarget,
} from './items.ts';
import { noteFloor } from './notes.ts';
import { queryRect } from './spatial.ts';

const DRAG_SLOP = 3;      // screen px before a press becomes a drag
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_SLOP = 28;
const TAP_MOVE_SLOP = 12;
// How long a finger has to rest before the press means "show me the menu".
// Long enough not to fire on a slow tap, short enough to feel deliberate;
// it is the interval both mobile platforms use for the same gesture.
const LONG_PRESS_MS = 480;
const LONG_PRESS_CONTEXT_GUARD_MS = 900;
const LONG_PRESS_CONTEXT_GUARD_PX = 24;

// Controls a straddling corner hitbox can cover and must hand the press back to,
// rather than resize over: buttons (play, mute, the big video play), a link's
// anchor, the two scrubbers, a text field. Deliberately *not* the full-card
// surfaces - a model stage, a picture, a note's editable body fill the card
// corner to corner, and a corner over those is meant to resize. See onDown().
const GRIP_YIELD = 'button, a[href], input, .wave, .vtrack';

/**
 * A geometry snapshot as state.ts hands one back.
 *
 * Named off the function rather than imported from layout.ts, where the type is
 * declared: state.ts re-exports snapshotGeom as a value and not as a type, and
 * reaching past the one door for the type alone would be a second edge in the
 * graph for a single idea.
 */
type GeomSnap = ReturnType<typeof snapshotGeom>[number];

/**
 * A place the pointer was, and when it was there.
 *
 * The shape every timing window in this file compares - a double tap, the
 * native context menu that repeats a hold, the tap that may still be the first
 * half of something.
 */
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

/**
 * Whether a global canvas shortcut must stand down for this keystroke.
 *
 * True when the event was already handled (the context menu's capture listener
 * preventDefault-s the keys it acts on) or an overlay owns the keyboard - a
 * modal dialog or the open menu. Extracted from the keydown handler so the rule
 * itself is testable without a DOM. See AUD-08.
 */
export function shortcutsSuppressed(
  defaultPrevented: boolean,
  overlayOwnsKeyboard: boolean,
): boolean {
  return !!(defaultPrevented || overlayOwnsKeyboard);
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
// drew, rather than a click that happened to be modified. A shift-click on empty
// board starts a marquee of zero size (startMarquee runs on the press, not on the
// first movement), and that gesture means "clear the selection", not "here is a
// region" - so the offer that follows a band has to be able to tell them apart.
// Comfortably above DRAG_SLOP: crossing the slop makes it a drag, this makes it
// a rectangle, and the gap is the small deliberate band where a wobbly click
// selects things without also being asked about fencing them.
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
 * A card by overlap and a fence only by being covered outright, and the
 * asymmetry is the fence's own. It is the one item whose face takes no presses -
 * items.css hands them straight through to whatever is underneath - so a band
 * swept across that face is a band drawn *inside* the region rather than one
 * aimed at it. And a fence is always larger than what is drawn inside it, so
 * under one rule for both, every band within a region caught the region: the
 * offer that follows counted it, the fence it drew was unioned out to swallow
 * the parent it was drawn inside, and dragging what the band caught towed the
 * whole region. To take a fence, put the band round it - or press its name.
 */
export function marqueeHit(
  // A box and which kind of thing it is, which is the whole of what the two
  // rules read - the same bargain commands/fences.ts's `Boxed` makes, and what
  // lets a test hand this a rectangle rather than a whole board item.
  it: Box & { type?: string },
  x0: number, y0: number, x1: number, y1: number,
): boolean {
  return isFence(it)
    ? itemWithinRect(it, x0, y0, x1, y1)
    : itemInRect(it, x0, y0, x1, y1);
}

/**
 * One card's claim on the region that carries it: the fraction of the box it
 * sits at, frozen at grip time, and its half-extents, which do not change.
 */
export type CarryHold = { fx: number, fy: number, hw: number, hh: number };

/**
 * The smallest a fence may be dragged while its contents still *fit* inside it -
 * `{ w, h }`, or zeroes when it holds nothing.
 *
 * The carry is what makes this a different sum from the floor it replaces. Every
 * card in a region keeps its fraction of the box (stuckPlacement), so no card can
 * be left outside by a moving edge - but a card is a box and not a point, and its
 * size does not shrink with the region. Past a certain width the cards are still
 * at the right fractions and hanging over the border anyway, which is the same
 * "a region that visibly does not hold its contents" the old floor was for, and
 * the reason one is still needed at all.
 *
 * `holds` are `{ fx, fy, hw, hh }`: the fraction of the box each card sits at,
 * frozen at grip time, and its half-extents, which do not change. A card at
 * fraction fx has its far edge at `w * |fx| + hw`, and that has to stay inside
 * `w / 2` - so `w >= hw / (0.5 - |fx|)`, and the binding card is whichever asks
 * for the most. No corner arithmetic anywhere: the fraction is preserved whatever
 * edge is dragged, so the floor is a fact about the box's size alone.
 *
 * Capped at the size the drag started from, and for the same reason as before: a
 * card can already be hanging out of a fence - it joined by its centre, and
 * nothing has had to move it since - and an uncapped floor would then be larger
 * than the fence, so touching a grip would snap the region open to swallow it. A
 * card at or past the halfway fraction can never fit, and the cap is what turns
 * that from an infinity into "this one will not shrink".
 */
export function carryFloor(
  box: { w: number, h: number },
  holds: readonly CarryHold[] | null | undefined,
): { w: number, h: number } {
  if (!holds?.length) return { w: 0, h: 0 };
  const axis = (side: number, at: (p: CarryHold) => number, half: (p: CarryHold) => number) => {
    let want = 0;
    for (const p of holds) {
      const room = 0.5 - Math.abs(at(p));
      want = Math.max(want, room > 0 ? half(p) / room : Infinity);
    }
    return Math.min(side, want);
  };
  return {
    w: axis(box.w, p => p.fx, p => p.hw),
    h: axis(box.h, p => p.fy, p => p.hh),
  };
}

/**
 * Decide whether a press on a resize grip is still a tap or has become a drag.
 *
 * A grip waits for real movement before a resize starts, which keeps a plain tap
 * from snapping or committing geometry. A tap that never crosses the slop does
 * nothing - the three-dot menu that a southeast tap used to open is gone, and
 * the context menu is reached by right-click or long-press instead.
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
// The wheel that is not always a wheel
// ---------------------------------------------------------------------------
//
// A touchpad and a mouse wheel arrive at the same event and mean opposite
// things. Two fingers moved across a pad is a *scroll* - the board should
// follow the fingers, in both axes - while a notch of a wheel is the zoom this
// app has always had. There is no API that says which device sent an event, and
// no plan to add one, so this is a heuristic; what makes it tolerable is that
// both answers are ordinary board gestures, so being wrong is annoying and
// never destructive.
//
// Three signals, in order of how much they can be trusted:
//
//   ctrlKey     A pinch. Every engine reports one as a wheel event with the
//               control key set and nobody's hand anywhere near control, which
//               is a hack of long standing and is also completely reliable - it
//               is the only pinch notification a page gets from a touchpad.
//   deltaMode   Lines or pages. No touchpad reports either; it is a mouse, or
//               it is Firefox reporting a mouse.
//   the deltas  A pad moves sideways and in fractions of a pixel. A wheel is a
//               column of whole notches: dx is exactly zero and dy arrives in
//               steps of 100 or 120, or 3 lines.
//
// The last one is the fuzzy one, and it is fuzziest at the *start* of a swipe,
// which is where a mistake is most visible. So the answer is latched for the
// length of a gesture: wheel events come in bursts a few milliseconds apart, and
// a device does not change hands mid-burst. A swipe starts slow - the first
// event of one is small and gets classified correctly - and every event behind
// it inherits that answer however fast the fingers get.

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
 * Two numbers because the two devices count in different units. A wheel notch
 * is a hundred at a time and wants a small coefficient; a pinch is a stream of
 * single figures describing how far the fingers moved, and at the wheel's rate
 * it would take a pinch across the whole pad to change anything.
 */
const WHEEL_ZOOM_RATE = 0.0016;
const PINCH_ZOOM_RATE = 0.01;

/** The most one event may be worth, so a flung pad cannot jump the view. */
const WHEEL_MAX_STEP = 400;

/**
 * How much of the lean is handed back when the platform rails a swipe.
 *
 * Measured rather than picked. A swipe down this board with a deliberate curve
 * in it arrived as 5257px of vertical and 973px of sideways, the sideways half
 * present in only 75 of its 349 events - the fingers went one way and the
 * platform reported a fifth of it. Three brings that back to roughly half, which
 * is a swipe that goes where it was aimed without the board sliding out from
 * under the hand.
 *
 * It only ever touches an axis the platform is *withholding* - see unrail() - so
 * a swipe delivered whole is left alone however lopsided it is. And it cannot
 * rescue one railed outright: straight sideways reports vertical of exactly
 * zero, and no multiple of zero is a lean.
 *
 * This is the one number to turn if it feels wrong.
 */
const UNRAIL_GAIN = 3;

/**
 * The most one event may be *boosted* by, in pixels.
 *
 * Not a cap on the movement - what the platform reported always passes through
 * untouched, so this can never take away a step the fingers earned. It bounds
 * the invention on top, because a delta the driver held back and released in one
 * lump (48px against a 15px-per-event swipe, in the recording) would otherwise
 * be multiplied into a visible sideways jerk.
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
 * Structural rather than `WheelEvent` for the reason the pure helpers above are
 * structural: the classification is the one part of this module a runner with
 * no browser can exercise, and it is exercised by handing it six numbers.
 */
export type WheelSample = {
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  ctrlKey: boolean,
  shiftKey: boolean,
  timeStamp: number,
};

/** What one wheel event is asking for - see readWheel(). */
export type WheelAction = { kind: WheelKind, dx: number, dy: number, factor: number };

/** The device this burst of wheel events is being read as, and when it last spoke. */
let wheelKind: WheelKind = 'zoom';
let wheelAt = -Infinity;

/** How much each axis has been moving, over this burst alone. */
let axisX = 0;
let axisY = 0;

/**
 * How often each axis arrives at all, over this burst alone.
 *
 * Both start at 1 - honest until proven otherwise - so a swipe is never lifted
 * on the strength of its first event or two, which is where the evidence is
 * thinnest and a wrong answer is most visible. A gated axis falls away from 1
 * within about a tenth of a second and stays down; an axis the platform is
 * reporting properly never leaves it.
 */
let seenX = 1;
let seenY = 1;

/**
 * Forget the current burst.
 *
 * **Nothing under web/ calls this** - it exists for tests, which need a known
 * starting point between cases and cannot reach four module-level numbers any
 * other way. Kept rather than deleted because the alternative is each case
 * opening with a synthetic gap in `timeStamp`, which is the same reset written
 * less legibly forty times over; said out loud here because it has now been
 * mistaken twice for the live way out of a burst. The live way is the gap:
 * WHEEL_STREAM_MS with no event.
 */
export function resetWheelKind(): void {
  wheelKind = 'zoom';
  wheelAt = -Infinity;
  axisX = axisY = 0;
  seenX = seenY = 1;
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
function unrail(dx: number, dy: number): { dx: number, dy: number } {
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
  // Sideways at all, or in fractions: a wheel can do neither.
  if (dx !== 0 || !Number.isInteger(dy)) return 'pan';
  return Math.abs(dy) < WHEEL_NOTCH ? 'pan' : 'zoom';
}

/**
 * What a wheel event is asking for: `pan` by (dx, dy), or `zoom` by `factor`.
 *
 * Deltas come out in pixels whatever the event counted in, so the caller never
 * has to know about deltaMode. A pinch is always a zoom and never latches the
 * device - somebody holding control over a real wheel is asking for the same
 * thing, and letting that decide what the next plain notch means would be a
 * modifier key with an after-effect.
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
 * go of the key.
 */
export function readWheel(e: WheelSample, pageHeight = 800): WheelAction {
  const scale = e.deltaMode === 1 ? WHEEL_LINE : e.deltaMode === 2 ? pageHeight : 1;
  const dx = (e.deltaX || 0) * scale;
  const dy = (e.deltaY || 0) * scale;
  const zoom = (rate: number) => Math.exp(-clamp(dy, -WHEEL_MAX_STEP, WHEEL_MAX_STEP) * rate);

  if (e.ctrlKey) return { kind: 'zoom', dx, dy, factor: zoom(PINCH_ZOOM_RATE) };

  const at = e.timeStamp || 0;
  const fresh = at - wheelAt > WHEEL_STREAM_MS;
  const kind = fresh ? classifyWheel(e, dx, dy) : wheelKind;
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

  if (kind === 'zoom') return { kind, dx, dy, factor: zoom(WHEEL_ZOOM_RATE) };
  return { kind, ...unrail(dx, dy), factor: 1 };
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
  // gesture for why, and snapAll() in state.js for the arrangement this is
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
// Every mode the one gesture can be in, and every move between them the pipeline
// below actually makes. Written down as a table for two reasons: it is the only
// place the legal set exists (it used to exist in the reader's head, spread over
// a 230-line pointerdown and a 270-line pointermove), and it is pure, so the
// rule can be tested by a runner that cannot press a pointer - which is the
// whole of what tests/input.test.js can reach of this module.
//
//   idle ..... nothing is happening. Not "no gesture object": the object is
//              always there, and this is what it says when the pointer is up.
//   press .... a press has landed on something that needs the drag slop before
//              it can say what it is - a resize grip, or the second tap of a
//              touch double-tap. `intent` says which it will become.
//   pan ...... the board is following the pointer.
//   pinch .... two fingers, panning and zooming together.
//   marquee .. a band is being dragged over the board.
//   move ..... the selection is following the pointer.
//   resize ... one card's geometry is following one grip.
//
// pinch is a mode the pipeline genuinely has and the plan's list did not name:
// two fingers are not one of the six, and the code has carried a `pinch` kind
// since the gesture existed.
//
// Note what is *not* in the table: there is no pan -> pinch, no move -> pinch,
// no marquee -> pinch. A second finger arriving does not convert a live gesture;
// it aborts it first (abortGesture, which lands in idle) and then enters pinch
// from there. That is what "a second finger always wins" means mechanically -
// the drag is dropped rather than committed - and leaving those edges out is
// what makes the guard in enter() able to catch an abort somebody forgot.
//
// Nor is there idle -> idle. finishGesture() and abortGesture() both return
// early when there is nothing standing, so the machine is never asked; an
// attempt would mean a gesture was released twice.
/**
 * Every mode the one gesture can be in.
 *
 * A union of string literals and deliberately not an enum: `erasableSyntaxOnly`
 * is on because Node strips types natively and an enum would need code
 * generated, which would make the suite unrunnable without a loader. See
 * tsconfig.json. It is also the discriminant of the Gesture union below, which
 * is what makes `gesture.mode === 'move'` narrow to the fields a move has.
 */
export type GestureMode = 'idle' | 'press' | 'pan' | 'pinch' | 'marquee' | 'move' | 'resize';

export const GESTURE_MOVES: Record<GestureMode, readonly GestureMode[]> = {
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
};

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
  const key = from as GestureMode;
  const legal = Object.hasOwn(GESTURE_MOVES, key) ? GESTURE_MOVES[key] : null;
  const want = to as GestureMode;
  return legal?.includes(want) ? want : null;
}

// MIN_SIZE and MAX_SIZE are the resize limits, in world units, and they live in
// geometry.js - a resize handle stopped being the only thing that sets a size
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
  // A fence's carry, and null for everything else - see carryFloor().
  holds: CarryHold[] | null,
  lockAspect: boolean,
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
 * The commands this pipeline reaches for, handed in rather than imported.
 *
 * canvas/ may not import ui/ (tests/layers.test.js), and half of what a gesture
 * ends in - the menu, the fence offer, the note editor, the viewer - lives up
 * there. main.js owns the one command surface and hands it down, which is the
 * same move ghosts.ts and every ui/ module makes. Optional members are the ones
 * this file already calls with `?.`: a board with no connections, no viewer and
 * no player is a board this module still drives.
 */
type InputCommands = {
  selectAll(): void,
  undo(): void,
  redo(): void,
  duplicate(): void,
  save(): unknown,
  export(): unknown,
  open(): unknown,
  deleteSelection(): void,
  recenter(): void,
  fit(): void,
  closeSidebar(): void,
  editNote(id: string): unknown,
  editConnectionLabel(a: string, b: string): unknown,
  fencePrompt(x: number, y: number, rect: Bounds): void,
  contextMenu(x: number, y: number, id: string | null, count: number,
    opts?: { touch?: boolean }): void,
  // Read straight from state.ts on the pointer path - the flag is state, not a
  // command - so what is wanted here is only the way *out*, for Escape.
  toggleMultiSelect?(): unknown,
  connectTap?(id: string | null): boolean,
  connectionUnder?(at: Point): { a: string, b: string } | null,
  pickConnection?(at: Point): unknown,
  clearActiveConnection?(): unknown,
  deleteActiveConnection?(): boolean,
  editTitle?(): unknown,
  editTitleText?(): unknown,
  openViewer?(id: string): unknown,
  playPause?(): boolean,
  // The tour's two keys, in the shape the three above use: the command answers
  // whether it took the press. See the Escape and arrow cases below.
  tourStop?(): boolean,
  tourStep?(delta: number): boolean,
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
    const next = { mode, ...data } as GestureOf<M>;
    gesture = next;
    return next;
  }

  let spaceDown = false;
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
  const midPaste: { down: boolean, at: Point | null, dragged: boolean } =
    { down: false, at: null, dragged: false };
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
  const hold: {
    timer: ReturnType<typeof setTimeout> | 0,
    at: (Point & { id: string | null }) | null,
    menu: TapPoint | null,
  } = { timer: 0, at: null, menu: null };
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
  //                 editBoardName in main.js).
  const taps: {
    arm: (Point & { pointerId: number, id: string, additive: boolean }) | null,
    card: (Point & { pointerId: number, id: string, slop: number }) | null,
    empty: (Point & { pointerId: number }) | null,
    lastEmpty: TapPoint | null,
    lastTitle: TapPoint | null,
  } = { arm: null, card: null, empty: null, lastEmpty: null, lastTitle: null };
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
  // spacing on screen. gridStep() in grid.js coarsens the *drawn* dots as you
  // zoom out so they never become a fill, but a gesture must land on the same
  // lattice snapAll()/onLattice() use however far the board is zoomed, or an
  // item dragged at one zoom would sit off the lines it snapped to at another.
  const stepNow = () => baseStep();

  /**
   * A box laid on the lattice - see latticeBox() in geometry.js.
   *
   * The same shape snapAll() in state.js gives the board when snapping is
   * switched on, and deliberately so: that is the arrangement everything here
   * then has to preserve. An item is flush in the grid only when *both* halves
   * hold, the position and the size - an edge on a line is not enough if the
   * side is one and a half cells long, because then the opposite edge is off by
   * half a cell whatever you do to the position.
   */
  const ontoLattice = (box: Box) => latticeBox(box, stepNow());

  /**
   * The seam a snapped item leaves at each of its four edges, in world units.
   *
   * Every edge carries the same one - see CELL_GAP in geometry.js - so the space
   * between two neighbours is two halves of a seam rather than one whole one.
   * The sign is what differs: a low edge sits a seam *past* its grid line and a
   * high edge a seam short of the next, which is why the snapping below still
   * has to know which edge the pointer is holding.
   */
  /**
   * ...for a gesture that says whether it is snapping.
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
   * One axis of a resize, against this board's current step and seam.
   *
   * The arithmetic is resizeAxisOn() at module scope; this is the two readings
   * that make it about *this* board. See the note there for why it moved.
   */
  const resizeAxis = (
    sign: number, centre: number, extent: number, travel: number, snap: boolean,
  ) => resizeAxisOn(sign, centre, extent, travel, snap, stepNow(), insetFor(snap));

  function setPanCursor() {
    el.classList.toggle('can-pan', spaceDown && gesture.mode === 'idle');
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
    for (const id of queryRect({ x0, y0, x1, y1 })) {
      const it = byId(id);
      if (it && marqueeHit(it, x0, y0, x1, y1)) hit.push(id);
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
    // travels. See travelling() in layout.js, where the fixed point is worked out.
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
    const move = enter('move', {
      // `id` is what the pointer landed on and `lead` is what it has hold of -
      // the same thing except on a pinned item. The lift keeps `id`, because a
      // modified click peels the card you clicked; the drag arithmetic and the
      // stick preview read `lead`, because those are about the thing moving.
      id, lead: rootOf(id), moving, before, start,
      // Frozen here, like the grip's - see MoveGesture.snap.
      snap: board.settings.snap,
      // The sides come along as well as the corner: snapping puts the lead's low
      // edges on lines, and an edge is its centre less half its size.
      origin: before.map(b => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h })),
      moved: false,
      // What the pointer has hold of, as against what it is towing. Only these
      // ask again what they are stuck to when the drag ends - a note carried
      // across the board by the photo underneath it has not moved relative to
      // anything, and re-parenting it would take apart the pile you built by
      // moving it. See restick() in state.js.
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
      // What the region has to stay big enough to hold: where each card sits as
      // a fraction of it, and how much room that card takes. Frozen with the
      // grip, like everything else here, so a drag that grows past a card and
      // comes back is not held open by something it has not formally picked up -
      // membership is not re-measured until the release. See carryFloor().
      //
      // Only the fence's own carry has one. A card being resized under its stuck
      // notes has never had a floor and does not want one: a sticky hanging over
      // the edge of a photograph is a sticky, not a mistake.
      holds: isFence(it) && board.layoutMode !== 'mobile'
        ? followers.map(f => {
          const { hw, hh } = rotatedExtents(f.box);
          return {
            fx: (f.box.x - it.x) / (it.w || 1),
            fy: (f.box.y - it.y) / (it.h || 1),
            hw, hh,
          };
        })
        : null,
      // Nothing is aspect-locked by default any more, media included. A corner
      // used to hold a photograph's proportion and let shift free it, on the
      // reasoning that the shape a picture arrived in is the shape it wants -
      // which is true of the *picture* and not of the box it is shown in. The
      // body is object-fit: cover, so a box in a new proportion crops rather
      // than stretches: what a corner drag actually chooses is framing, and a
      // grip that refuses to give you the framing you are dragging towards is
      // a grip that fights you. It also cost the same thing an edge drag cost
      // before it was freed - a photograph could not be landed on the lattice
      // by its corner, because the followed side came out of a division.
      //
      // Shift is the lock now, at both ends and for everything: on a corner it
      // holds the proportion, on an edge it holds it and scales the whole
      // picture from that side. The way back from a box dragged out of shape is
      // Ctrl+Z, or "Reset size", which restores the size it was born at.
      //
      // Kept as a field rather than folded into the XOR below because it is the
      // *default* for this grip, and a future one may well want its own.
      lockAspect: false,
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
    vp.stopAnim();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

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
    if (cmds.connectTap?.(id)) {
      pointers.delete(e.pointerId);
      return;
    }
    // The title card's pen. Caught before the generic widget branch below (a
    // button would otherwise just select the card): it opens the shared style
    // panel and claims the whole press, so the card underneath neither drags nor
    // deselects. Selection is left as-is - the pen only exists while selected.
    if (target?.closest('.item-pen')) {
      cmds.editTitle?.();
      pointers.delete(e.pointerId);
      return;
    }
    // The title card's T button, caught the same way: it drops into inline rename
    // of the board name and claims the press, so the card neither drags nor
    // deselects underneath it.
    if (target?.closest('.item-rename')) {
      cmds.editTitleText?.();
      pointers.delete(e.pointerId);
      return;
    }
    // Double-tap the title card itself → edit its name, the same as its T button.
    // A second press within the double-tap window that has not wandered claims the
    // gesture: no capture, no move, just the editor. The first press falls through
    // and selects as usual, recording itself for the second to match against.
    if (id && byId(id)?.type === 'title') {
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
    // .vtrack is the video scrubber; a video's own <video> is deliberately not
    // in this list, because the picture is the card and dragging it has to drag
    // the card. Only the transport laid over it claims the gesture.
    // .model-stage is the 3D canvas: a drag on it turns the model over, so it
    // has to claim the gesture the way the audio scrubber does, or the card
    // would move out from under the hand instead.
    const widget = target?.closest('audio, video[controls], input, button, a, .wave, .vtrack, .model-stage, [contenteditable="true"], [contenteditable="plaintext-only"]');
    const tap = { x: e.clientX, y: e.clientY, at: e.timeStamp };
    const doubleTapDrag = e.pointerType === 'touch' && !id && !widget
      && isDoubleTap(taps.lastEmpty, tap);
    if (e.pointerType === 'touch') {
      if (doubleTapDrag || id || widget) taps.lastEmpty = null;
      taps.empty = !doubleTapDrag && !id && !widget
        ? { pointerId: e.pointerId, x: e.clientX, y: e.clientY }
        : null;
    }

    if (widget && !spaceDown && e.button !== 1) {
      if (id) select([id]);
      pointers.delete(e.pointerId);
      return;
    }

    capturePointerSafely(el, e.pointerId);

    // Whatever this press turns out to be, it is not the line that was marked -
    // the one branch below that disagrees says so itself, by marking one again.
    cmds.clearActiveConnection?.();

    if (spaceDown || e.button === 1) {
      if (e.button === 1) {
        midPaste.down = true;
        midPaste.dragged = false;
        midPaste.at = { x: e.clientX, y: e.clientY };
      }
      e.preventDefault();
      startPan(e);
    } else if (grip && id && selection.size <= 1 && !isLocked(byId(id))) {
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
        id,
        corner: grip.dataset.g,
        x: e.clientX,
        y: e.clientY,
        // `?.` rather than a bare read: a grip only exists because `target` did
        // (it came off target.closest), so this can never be the null branch.
        node: target?.closest('.item') ?? null,
      });
    } else if (doubleTapDrag) {
      // Wait for movement before showing or applying the marquee. A plain double
      // tap does nothing now (it used to fit the board); holding and dragging the
      // second tap turns into select.
      const p = vp.toWorld(e.clientX, e.clientY);
      enter('press', {
        intent: 'marquee', clientX: e.clientX, clientY: e.clientY, x0: p.x, y0: p.y,
      });
    } else if (id && needsTapFirst(id) && (e.pointerType === 'touch' || vp.isMobile)) {
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
        id,
        x: e.clientX,
        y: e.clientY,
        // The mode reads as a modifier held down, here and in the branch below,
        // and that is the whole of what it does to a press on a card: the tap
        // that would have replaced the selection adds to it instead. Everything
        // that follows - the peel on a second tap, the drag that moves the
        // group - already worked that way for Shift and needs nothing new.
        additive: e.shiftKey || e.ctrlKey || e.metaKey || isMultiSelect(),
      };
      taps.card = { pointerId: e.pointerId, id, x: e.clientX, y: e.clientY, slop: TAP_MOVE_SLOP };
      startPan(e);
    } else if (id) {
      const additive = e.shiftKey || e.ctrlKey || e.metaKey || isMultiSelect();
      const held = selection.has(id);
      if (additive) select([id], true);
      else if (!held) select([id]);
      taps.card = { pointerId: e.pointerId, id, x: e.clientX, y: e.clientY, slop: DRAG_SLOP };
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
      if (isLocked(byId(id))) {
        startPan(e);
      } else {
        const move = startMove(e, id);
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
    } else if (e.shiftKey || e.ctrlKey || e.metaKey) {
      startMarquee(e);
    } else {
      // Nothing a press on bare board does clears the group while the mode is
      // on - not a pan, not a tap. That is the half of it a person can feel:
      // building a group of nine on a board bigger than the screen means panning
      // between them, and a pan that cost you the nine is the mode failing at
      // the one thing it exists for. The way out is the row that turned it on,
      // Escape, or tapping the cards back off.
      if (isMultiSelect()) clearOnLift = null;
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
        // The press that opens the menu is not the tap that clears the board.
        clearOnLift = null;
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
    // Mirrored onto the viewport so the import layer's paste (drop.js), which
    // has no view into this module's `hover`, can land under the cursor too.
    if (e.pointerType !== 'touch') hover = vp.cursor = { x: e.clientX, y: e.clientY };
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (taps.empty?.pointerId === e.pointerId
        && Math.hypot(e.clientX - taps.empty.x, e.clientY - taps.empty.y) > TAP_MOVE_SLOP) {
      taps.empty = null;
      taps.lastEmpty = null;
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
      return;
    }

    if (gesture.mode === 'marquee') {
      const p = vp.toWorld(e.clientX, e.clientY);
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
      const p = vp.toWorld(e.clientX, e.clientY);
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx * vp.zoom, dy * vp.zoom) < DRAG_SLOP) return;
      // The press has become a drag. Raise now, so the stack change belongs to
      // the move that is about to be committed - see raiseToFront.
      if (!drag.moved) {
        raiseToFront(drag.moving);
        // The pointer is captured by #viewport, so the cursor is #viewport's
        // however far the card under it wants a grabbing hand. Mark the viewport
        // for the length of the drag - see #viewport.is-moving in the CSS.
        el.classList.add('is-moving');
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
      const lead = drag.origin.find(o => o.id === drag.lead) || drag.origin[0];
      const low = { x: lead.x + dx - lead.w / 2, y: lead.y + dy - lead.h / 2 };
      let sx = snapLowFor(low.x, drag.snap) - low.x;
      let sy = snapLowFor(low.y, drag.snap) - low.y;
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
      const leadItem = byId(drag.lead);
      const host = isSticky(leadItem)
        ? wouldStick(
          { x: lead.x + dx, y: lead.y + dy, w: leadItem.w, h: leadItem.h },
          drag.lead, leadItem)
        : null;
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
      const p = vp.toWorld(e.clientX, e.clientY);
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
      let w = resizeAxis(signX, grip.box.x, grip.box.w, dx, grip.snap);
      let h = resizeAxis(signY, grip.box.y, grip.box.h, dy, grip.snap);
      // Apply the card and carry its stuck notes with it. Each note is placed at
      // the fraction of the card it held when the drag began (grip.box is that
      // start box), so a note near a moving edge is dragged along by that edge and
      // none is left hanging off the shrunk card. No followers -> a plain
      // one-item write.
      const applyResize = (host: ResizeTarget) => {
        if (!grip.followers.length) return applyGeom([host]);
        const riders = grip.followers.map(f => {
          const at = stuckPlacement(f.box, grip.box, host);
          return { id: f.id, x: at.x, y: at.y, w: f.box.w, h: f.box.h, rot: f.box.rot, z: f.box.z };
        });
        applyGeom([host, ...riders]);
      };
      if (grip.lockAspect !== e.shiftKey) {       // XOR: shift inverts the default
        // The dragged side leads and the other follows it at the picture's own
        // proportion. The side you are watching move is the right one to lead:
        // it is the one being aimed.
        const ratio = grip.box.w / grip.box.h;
        if (Math.abs(w - grip.box.w) > Math.abs(h - grip.box.h)) h = w / ratio;
        else w = h * ratio;
        // The follower can land outside a limit the dragged side never reached,
        // and clamping only the offender would change the ratio - the single
        // thing this branch exists to hold. So the pair is rescaled together.
        // Shrink first and grow second, so that on the extreme shape where both
        // limits bind at once it is the floor that survives: a box too large is
        // a nuisance, a box too small cannot be grabbed to undo it.
        let k = Math.min(1, MAX_SIZE / Math.max(w, h));
        k = Math.max(k, MIN_SIZE / Math.min(w, h));
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
          const lattice = ontoLattice({ x: 0, y: 0, w, h });
          w = lattice.w;
          h = lattice.h;
        }
      }
      // A fence may not be dragged smaller than what it is carrying. The cards
      // keep their fractions whatever happens here, so this is not about losing
      // one - it is about a region drawn too small to hold what is standing in
      // it, whose cards would hang over the border while the memo still called
      // them members. See carryFloor(), which is the whole of the arithmetic.
      if (grip.holds) {
        const floor = carryFloor(grip.box, grip.holds);
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
        if (grip.snap) {
          // A whole number of cells less a seam at each end - the same shape
          // latticeSide() gives, rounded up rather than to the nearest.
          // The grip's frozen answer, not the live setting - see insetFor().
          const step = stepNow(), gap = 2 * insetFor(grip.snap);
          floor = Math.ceil((floor + gap) / step) * step - gap;
        }
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
  });

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
    // `buttons` covers the same ground from the other side, for a chorded press
    // this branch does not name: a pointerup while any button is still down is
    // not the end of anything.
    if (e.type === 'pointerup' && (e.pointerType === 'mouse' || e.pointerType === 'pen')
      && (e.button > 1 || e.buttons !== 0)) return;
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
    const tap = e.type === 'pointerup' && taps.empty?.pointerId === e.pointerId
      ? { x: taps.empty.x, y: taps.empty.y, at: e.timeStamp }
      : null;
    if (taps.empty?.pointerId === e.pointerId) taps.empty = null;
    // The lift that turns a held-still press into a pick. pointerup only: a
    // pointercancel is the system taking the gesture away - a notification
    // shade, a call - and nothing a person did.
    if (taps.arm?.pointerId === e.pointerId) {
      if (e.type === 'pointerup') select([taps.arm.id], taps.arm.additive);
      taps.arm = null;
    }
    // pointerup only, like the pick above and for the same reason: a
    // pointercancel is the system taking the gesture away, not a person
    // finishing one.
    if (taps.card?.pointerId === e.pointerId) {
      if (e.type === 'pointerup') pauseOnTap(taps.card.id);
      taps.card = null;
    }
    // The deselect a touch press on bare board put off - see clearOnLift. Spent
    // whichever way the press ended, cancel included: the press was still a
    // hand put on empty board, and the only thing that ever calls it off is the
    // hold, which does so where it opens the menu.
    if (clearOnLift === e.pointerId) {
      clearOnLift = null;
      if (selection.size) clearSelection();
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
    // A drop that found a host is the way back from Unstick, and it is the only
    // way back - there is no "stick to this card" menu entry, because putting it
    // on the card is already how you say that. In front of the commit, not
    // inside it, so undo restores the flag instead of re-deriving it; resettle()
    // in state.js argues the whole of it. Only on a gesture that moved, so a
    // plain click on a loose note cannot quietly re-pin it.
    if (commit) {
      if (gesture.mode === 'move' && gesture.moved) {
        resettle(gesture.driven);
        commitGeom('Move', gesture.before, gesture.driven);
      }
      if (gesture.mode === 'resize') commitGeom('Resize', gesture.before, gesture.driven);
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

  // The stick-target ring moved to canvas/items.js, which owns the nodes it
  // marks. It was a closure in here while a note drag was the only thing that
  // could aim at a host; a shape dragged out of the sticker window aims at one
  // too, and ui/sticker-window.js cannot reach into this function.

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
    const w = readWheel(e, vp.height);
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
    vp.zoomAt(e.clientX, e.clientY, w.factor);
  }, { passive: false });

  // ---- double click -----------------------------------------------------

  // Double click no longer touches the zoom - not on empty space (it used to fit
  // the whole board) and not on a card (it used to zoom to that card). The one
  // meaning left is opening a note to edit, which is not a zoom and stays. Zoom
  // to fit is still on the F key and in the menu.
  el.addEventListener('dblclick', e => {
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

  addEventListener('keydown', e => {
    if (typingInto(e.target)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (shortcutsSuppressed(e.defaultPrevented, overlayOwnsKeyboard())) return;
    const mod = e.ctrlKey || e.metaKey;

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
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (e.shiftKey) cmds.export(); else cmds.save();
      return;
    }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); cmds.open(); return; }
    if (mod) return;

    switch (e.key) {
      case 'Delete': case 'Backspace':
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
      case 'F2': if (selection.size === 1) {
        const only = [...selection][0];
        // The title card has no item name of its own - F2 renames the board on
        // it, the same as its T button, where every other card edits its caption.
        if (byId(only)?.type === 'title') cmds.editTitleText?.();
        else editItemName(only);
        e.preventDefault();
      } break;
      case '0': cmds.recenter(); break;
      case 'f': case 'F': cmds.fit(); break;
      case '+': case '=': vp.zoomBy(1.25, zoomMs()); break;
      case '-': case '_': vp.zoomBy(1 / 1.25, zoomMs()); break;
      case 'Escape':
        // A running tour first: Escape is the way out of every temporary state
        // in this app, and while the bar is up the tour is the outermost of them.
        // It answers false when there is none, so the ordinary three still run.
        if (cmds.tourStop?.()) break;
        // And the pick mode next, for the same reason and with the same shape:
        // it is a temporary state, so Escape ends it - and only it, keeping the
        // group the mode was for. A second Escape then clears that group, which
        // is Escape meaning what it always did one layer further in.
        if (isMultiSelect()) { cmds.toggleMultiSelect?.(); break; }
        clearSelection();
        cmds.clearActiveConnection?.();
        cmds.closeSidebar();
        break;
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
    if (e.code === 'Space') { spaceDown = false; setPanCursor(); }
  });
  // A blur (alt-tab) never delivers the keyup, which would leave pan mode stuck.
  // A pointercancel likewise reports no button, so the middle-button guard is
  // cleared here too rather than trusting the lift to carry it.
  addEventListener('blur', () => { spaceDown = false; midPaste.down = false; setPanCursor(); });

  // Swallow the primary-selection paste a middle *drag* fires on release. Capture
  // phase and window-wide, so it runs before the note editor's own paste and the
  // board's paste-to-import below and can stop both. Only when the middle press
  // became a pan: a plain middle click still pastes, and an ordinary Ctrl+V is
  // untouched.
  addEventListener('paste', e => {
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
    // design and not an oversight - see resettle() in state.js, which is
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
    commitGeom('Nudge', before, [...selection]);
  }

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
  // next paste (see clipboardHasOurs in state.js). And the browser only sends
  // these where they belong, so a note being edited or a name being typed keeps
  // the browser's own copy and paste for nothing - the same bargain the
  // `widget` branch in pointerdown makes for the pointer.
  //
  // import/drop.js listens for `paste` too, to bring images, files and text in
  // from outside. This one is registered first, because main.js calls
  // initInput() before initDrop(), and stops the event dead the moment it
  // claims it - so exactly one of the two ever acts on a given paste.

  /** A clipboard gesture is ours only when the canvas, not a field, has focus. */
  const canClip = (e: ClipboardEvent) => !typingInto(e.target) && !!selection.size;

  addEventListener('copy', e => {
    if (!canClip(e)) return;
    const text = copyItems(selection);
    if (!text) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', text);
  });

  addEventListener('cut', e => {
    if (!canClip(e)) return;
    const text = cutItems(selection);
    if (!text) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', text);
  });

  addEventListener('paste', e => {
    if (typingInto(e.target) || !clipboardSize()) return;
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
  function openMenuAt(x: number, y: number, id: string | null, touch = false) {
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
}
