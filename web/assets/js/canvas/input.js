// Pointer + keyboard gestures for the canvas.
//
// One Pointer Events pipeline handles mouse, pen and touch. Exactly one gesture
// is active at a time (`g`), and a second finger always wins - it cancels an
// in-progress drag and takes over as a pinch, which is what makes two-finger
// pan/zoom feel right on a phone.
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

import { clamp } from '../util.js';
import {
  board, byId, selection, select, deselect, clearSelection, topZ, stackOrder,
  snapshotGeom, applyGeom, commitGeom, bus, stuckFollowers, stuckPlacement, wouldStick,
  travelling, isFence, dragRoot, isPinned, isSticky, resettle,
  copyItems, cutItems, pasteItems, clipboardSize, clipboardBounds, clipboardHasOurs,
  baseStep,
} from '../state.js';
import { zoomMs } from './viewport.js';
import {
  itemInRect, itemWithinRect, rotatedExtents,
  latticeBox, latticeLow, cellInset, MIN_SIZE, MAX_SIZE,
} from '../geometry.js';
import {
  itemIdFromEvent, ensureMounted, nodeFor, sync as syncItems, editItemName, showStickTarget,
} from './items.js';
import { noteFloor } from './notes.js';
import { queryRect } from './spatial.js';

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

/** Whether two touch points form the two taps of one deliberate gesture. */
export function isDoubleTap(previous, current) {
  if (!previous || !current) return false;
  const elapsed = current.at - previous.at;
  return elapsed >= 0 && elapsed <= DOUBLE_TAP_MS
    && Math.hypot(current.x - previous.x, current.y - previous.y) <= DOUBLE_TAP_SLOP;
}

/** A selected item is the only item a drag may move. */
export function needsSelectionBeforeMove(selected, id) {
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
export function shortcutsSuppressed(defaultPrevented, overlayOwnsKeyboard) {
  return !!(defaultPrevented || overlayOwnsKeyboard);
}

/** Whether a native contextmenu repeats the menu a touch hold already opened. */
export function repeatsLongPressContextMenu(opened, event) {
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
export function drewRectangle(box, zoom, slop = MARQUEE_DRAWN) {
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
export function marqueeHit(it, x0, y0, x1, y1) {
  return isFence(it)
    ? itemWithinRect(it, x0, y0, x1, y1)
    : itemInRect(it, x0, y0, x1, y1);
}

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
export function carryFloor(box, holds) {
  if (!holds?.length) return { w: 0, h: 0 };
  const axis = (side, at, half) => {
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
export function resizeHandleAction(start, current) {
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
export const UNRAIL_GAIN = 3;

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

/** The device this burst of wheel events is being read as, and when it last spoke. */
let wheelKind = 'zoom';
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
export function resetWheelKind() {
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
function unrail(dx, dy) {
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
  const lift = v => v + clamp(v * boost, -UNRAIL_CAP, UNRAIL_CAP);
  return minorIsX ? { dx: lift(dx), dy } : { dx, dy: lift(dy) };
}

/** Which device a single event looks like it came from, read cold. */
function classifyWheel(e, dx, dy) {
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
export function readWheel(e, pageHeight = 800) {
  const scale = e.deltaMode === 1 ? WHEEL_LINE : e.deltaMode === 2 ? pageHeight : 1;
  const dx = (e.deltaX || 0) * scale;
  const dy = (e.deltaY || 0) * scale;
  const zoom = rate => Math.exp(-clamp(dy, -WHEEL_MAX_STEP, WHEEL_MAX_STEP) * rate);

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
export function releasePointerSafely(element, pointerId) {
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

// MIN_SIZE and MAX_SIZE are the resize limits, in world units, and they live in
// geometry.js - a resize handle stopped being the only thing that sets a size
// when snapping learned to lay the whole board onto the lattice. The reasoning
// behind both numbers is written there. The floor's job here is the one it has
// always had: the eight grips are sized in screen pixels, so as an item shrinks
// they crowd it rather than shrinking with it. The ceiling's is the drag that
// leaves the window at high zoom - without a stop, one flick could carry an
// item to a size that makes Fit frame the board at nothing.

export function initInput(vp, cmds) {
  const el = vp.el;
  const marquee = document.getElementById('marquee');

  /** pointerId -> latest client position, for multi-touch bookkeeping. */
  const pointers = new Map();
  let g = null;            // the active gesture
  let spaceDown = false;
  // Linux/X11 pastes the primary selection on a middle click. A middle *click*
  // here should still paste - that is the platform's paste gesture - but a middle
  // *drag* means "pan", and the paste it fires on release would dump the
  // selection into the note being edited or the board's paste-to-import. So the
  // press is tracked, and only a drag (moved past the slop) arms the guard that
  // swallows the release paste (below). midDownAt is the press origin; midDragged
  // is set once it travels far enough to be a pan and not a click.
  let midButtonDown = false;
  let midDownAt = null;
  let midDragged = false;
  // Where the cursor is - a paste lands under it. Null on a touch device, where
  // pasteAt falls back to placing beside the original rather than guessing.
  let hover = null;
  // A long press is the touch equivalent of a right-click, and without it the
  // context menu is unreachable with a finger - which is where duplicate,
  // delete, send to back and rename live. Held here rather than inside the
  // gesture, because it has to survive the gesture being replaced (a second
  // finger arriving) and be cancelled by it.
  let pressTimer = 0;
  let pressAt = null;
  let longPressMenu = null;
  let lastEmptyTap = null;
  let emptyTapCandidate = null;
  // The previous tap on the title card, so a second one within the double-tap
  // window opens its inline rename. Read here in the pointer pipeline rather than
  // through a dblclick listener because #viewport takes pointer capture on press
  // and that retargets the compatibility mouse events to the viewport - the same
  // reason the masthead reads its taps directly (see editBoardName in main.js).
  let lastTitleTap = null;
  // A pointer resting on an unpicked item - see needsTapFirst(). The gesture is
  // a pan; this is what lets the lift still count as a tap if it never moved.
  let armSelect = null;
  // A press on a card's own surface, still eligible to count as a tap.
  //
  // Separate from armSelect because the two cover different halves of the same
  // gesture: armSelect only exists on the pan-then-select path (touch, or an
  // unpicked card), where a mouse press on a card starts a move outright. A tap
  // is a tap either way, so this is set on both and cleared by the same slop.
  //
  // Only a playing video does anything with it - see pauseOnTap(). Kept general
  // in name rather than called videoTap, because what it records is a fact
  // about the gesture and not about what happens to be under it.
  let cardTap = null;
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = 0; pressAt = null; };

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
  const pauseOnTap = id => {
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
  const needsTapFirst = id => needsSelectionBeforeMove(selection, id);

  // ---- helpers ----------------------------------------------------------

  /** A low edge onto the lattice, or left alone when snapping is off. */
  const snapLow = v => (board.settings.snap ? latticeLow(v, stepNow()) : v);

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
  const ontoLattice = box => latticeBox(box, stepNow());

  /**
   * The seam a snapped item leaves at each of its four edges, in world units.
   *
   * Every edge carries the same one - see CELL_GAP in geometry.js - so the space
   * between two neighbours is two halves of a seam rather than one whole one.
   * The sign is what differs: a low edge sits a seam *past* its grid line and a
   * high edge a seam short of the next, which is why the snapping below still
   * has to know which edge the pointer is holding.
   */
  const insetNow = () => (board.settings.snap ? cellInset(stepNow()) : 0);

  /**
   * One axis of a resize: the extent it should end up with, given the box the
   * gesture started from and how far the pointer has travelled along that axis.
   *
   * `sign` is +1 when the handle drags the high edge (east, or north - world y
   * points up), -1 for the low one, and 0 for an axis the handle does not
   * touch, whose extent comes back untouched.
   *
   * Snapping quantises the *moving edge's world position*, not the extent.
   * Rounding a width to the step would leave both edges off the lattice, since
   * the pinned edge was never on it to begin with; it is the edge the pointer
   * is actually holding that has to land on a grid line for the result to sit
   * flush against the dots on screen. The extent then falls out of the distance
   * back to the edge that stayed put, which is why the anchor is derived here
   * rather than the size being adjusted afterwards.
   *
   * `bias` is the seam, signed, and it is what makes the two directions
   * different. A high edge belongs a seam short of its line, so the seam is added
   * before the rounding and taken off after; a low edge belongs a seam past its
   * line, so the same happens the other way about. Both by half the old seam, so
   * two neighbours stand exactly as far apart as they always did while a single
   * item now sits centred in its cells instead of shoved into a corner of them.
   *
   * The limits are applied before the snap so the rounding is handed an edge
   * that is already legal, and repaired after it by stepping one grid line the
   * other way: rounding can only move the edge by half a step, so one line
   * always brings it back inside, and the answer is still on the lattice rather
   * than parked at a bare limit that no grid line passes through. The closing
   * clamp is what actually guarantees the range - it has to hold even where the
   * step is coarser than the whole band between floor and ceiling, and a floor
   * that only usually holds is the same collapsed item it exists to prevent.
   */
  function resizeAxis(sign, centre, extent, travel) {
    if (!sign) return extent;
    let size = clamp(extent + sign * travel, MIN_SIZE, MAX_SIZE);
    if (board.settings.snap) {
      const anchor = centre - sign * extent / 2;
      const step = stepNow();
      const bias = sign * insetNow();
      const edge = k => sign * (k * step - bias - anchor);
      const k = Math.round((anchor + sign * size + bias) / step);
      size = edge(k);
      if (size < MIN_SIZE) size = edge(k + sign);
      else if (size > MAX_SIZE) size = edge(k - sign);
    }
    return clamp(size, MIN_SIZE, MAX_SIZE);
  }

  function setPanCursor() {
    el.classList.toggle('can-pan', spaceDown && !g);
  }

  function startPan(e) {
    g = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
    // Only a finger throws the board - see flingFrom(). A mouse drag stops
    // where the button came up, which is what every desk-bound tool does and
    // what a pointer that can be held perfectly still makes possible.
    if (e.pointerType === 'touch') g.track = [];
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

  function trackPan(g, e) {
    g.track.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    // Anything older than the window can no longer be the start of the throw.
    // One at a time from the front: the array only ever holds a few events.
    while (g.track.length > 2 && e.timeStamp - g.track[0].t > FLING_WINDOW_MS) g.track.shift();
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
  function flingFrom(g, at) {
    if (!g.track || g.track.length < 2) return null;
    const last = g.track[g.track.length - 1];
    if (at - last.t > FLING_IDLE_MS) return null;
    const first = g.track[0];
    const dt = (last.t - first.t) / 1000;
    if (!(dt > 0)) return null;
    return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
  }

  function startMarquee(e) {
    const p = vp.toWorld(e.clientX, e.clientY);
    // An additive (Shift) band tracks the enclosed set both ways: the selection
    // it started from is frozen here and re-unioned with the currently enclosed
    // items every frame, so a card the band grew over and then left is released
    // again. Without the frozen base, select(ids, true) only ever adds, and the
    // live selection becomes the union of every position the band ever held.
    g = {
      kind: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y,
      additive: e.shiftKey, base: e.shiftKey ? [...selection] : null,
    };
    marquee.hidden = false;
    drawMarquee();
  }

  function drawMarquee() {
    // The screen's top-left corner is the world's (min x, *max* y) - world y
    // points up.
    const a = vp.toScreen(Math.min(g.x0, g.x1), Math.max(g.y0, g.y1));
    const b = vp.toScreen(Math.max(g.x0, g.x1), Math.min(g.y0, g.y1));
    marquee.style.left = a.x + 'px';
    marquee.style.top = a.y + 'px';
    marquee.style.width = (b.x - a.x) + 'px';
    marquee.style.height = (b.y - a.y) + 'px';
  }

  function applyMarquee() {
    const x0 = Math.min(g.x0, g.x1), x1 = Math.max(g.x0, g.x1);
    const y0 = Math.min(g.y0, g.y1), y1 = Math.max(g.y0, g.y1);
    // The band is a world rectangle, so the spatial index narrows the field to
    // the cells it overlaps instead of hit-testing the whole board every move.
    // queryRect is a superset (a cell is wider than the band's edge), so the
    // precise marqueeHit still runs - it just runs over a handful, not O(board).
    const hit = [];
    for (const id of queryRect({ x0, y0, x1, y1 })) {
      const it = byId(id);
      if (it && marqueeHit(it, x0, y0, x1, y1)) hit.push(id);
    }
    // Additive: replace the live selection with base + enclosed each frame, so
    // the enclosed set tracks the band in both directions (see startMarquee).
    if (g.additive) select([...new Set([...g.base, ...hit])]);
    else select(hit);
  }

  function startMove(e, id) {
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
    const roots = [...new Set([...selection].map(sid => dragRoot(byId(sid))?.id ?? sid))];
    // Whatever is stuck to the selection comes with it, and whatever is fenced
    // by it. Worked out once, here, and then held for the length of the gesture:
    // recomputing it per frame would let notes latch on and fall off as the drag
    // swept the selection across other items, so the group you picked up would
    // not be the group you put down. What is stuck when you take hold is what
    // travels. See travelling() in layout.js, where the fixed point is worked out.
    const moving = travelling(roots);
    // Snapshotted here, before anything is touched, so the raise below rides
    // along in the same undo entry as the move it belongs to.
    const before = snapshotGeom(moving);
    const start = vp.toWorld(e.clientX, e.clientY);
    g = {
      // `id` is what the pointer landed on and `lead` is what it has hold of -
      // the same thing except on a pinned item. The lift keeps `id`, because a
      // modified click peels the card you clicked; the drag arithmetic and the
      // stick preview read `lead`, because those are about the thing moving.
      kind: 'move', id, lead: dragRoot(byId(id))?.id ?? id, moving, before, start,
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
    };
    for (const sid of moving) ensureMounted(sid);
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
  function raiseToFront(ids) {
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

  function startResize(e, id, corner, origin = null) {
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
    const box = board.settings.snap
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
    const followers = riders.map(rid => {
      const r = byId(rid);
      return { id: rid, box: { x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot, z: r.z } };
    });
    for (const rid of riders) ensureMounted(rid);
    g = {
      kind: 'resize', id, corner, node,
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
    };
  }

  // ---- pointer pipeline -------------------------------------------------

  el.addEventListener('pointerdown', e => {
    if (e.button > 1 && e.pointerType === 'mouse') return;   // right/aux: leave alone
    // A hand on the board stops the board, before anything else is decided.
    // That is true of a glide let go of a moment ago and of a commanded flight
    // to Home or to Fit alike: catching a moving board has to work the first
    // time, not on the first frame it is dragged - a finger put down to stop
    // something is often a finger that then does not move at all.
    vp.stopAnim();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // A second finger always converts the gesture into a pinch.
    if (pointers.size === 2) {
      cancelPress();
      emptyTapCandidate = null;
      lastEmptyTap = null;
      armSelect = null;
      cardTap = null;
      abortGesture();
      const [a, b] = [...pointers.values()];
      g = {
        kind: 'pinch',
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
      return;
    }
    if (pointers.size > 2) return;

    let target = e.target instanceof Element ? e.target : null;
    let grip = target?.closest('.grip') || null;
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
      if (lastTitleTap && now - lastTitleTap.at <= DOUBLE_TAP_MS
          && Math.hypot(e.clientX - lastTitleTap.x, e.clientY - lastTitleTap.y) <= DOUBLE_TAP_SLOP) {
        lastTitleTap = null;
        cmds.editTitleText?.();
        pointers.delete(e.pointerId);
        return;
      }
      lastTitleTap = { x: e.clientX, y: e.clientY, at: now };
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
      && isDoubleTap(lastEmptyTap, tap);
    if (e.pointerType === 'touch') {
      if (doubleTapDrag || id || widget) lastEmptyTap = null;
      emptyTapCandidate = !doubleTapDrag && !id && !widget
        ? { pointerId: e.pointerId, x: e.clientX, y: e.clientY }
        : null;
    }

    if (widget && !spaceDown && e.button !== 1) {
      if (id) select([id]);
      pointers.delete(e.pointerId);
      return;
    }

    el.setPointerCapture(e.pointerId);

    // Whatever this press turns out to be, it is not the line that was marked -
    // the one branch below that disagrees says so itself, by marking one again.
    cmds.clearActiveConnection?.();

    if (spaceDown || e.button === 1) {
      if (e.button === 1) {
        midButtonDown = true;
        midDragged = false;
        midDownAt = { x: e.clientX, y: e.clientY };
      }
      e.preventDefault();
      startPan(e);
    } else if (grip && id && selection.size <= 1) {
      // A grip press is only a candidate. Waiting for movement keeps a plain tap
      // on a corner from touching snapped geometry, and leaves the tap free to
      // mean select rather than a zero-distance resize.
      //
      // Resize is a single-card operation: it drives one item's geometry off one
      // grip, and there is no defined answer for what a corner drag means across
      // a whole selection. So with more than one card selected a grip press is
      // not a resize at all - it falls through to the move branch below and picks
      // the selection up, the same as a press anywhere else on the card.
      g = {
        kind: 'resize-pending',
        id,
        corner: grip.dataset.g,
        x: e.clientX,
        y: e.clientY,
        node: target.closest('.item'),
      };
    } else if (doubleTapDrag) {
      // Wait for movement before showing or applying the marquee. A plain double
      // tap does nothing now (it used to fit the board); holding and dragging the
      // second tap turns into select.
      const p = vp.toWorld(e.clientX, e.clientY);
      g = { kind: 'touch-marquee', clientX: e.clientX, clientY: e.clientY, x0: p.x, y0: p.y };
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
      armSelect = {
        pointerId: e.pointerId,
        id,
        x: e.clientX,
        y: e.clientY,
        additive: e.shiftKey || e.ctrlKey || e.metaKey,
      };
      cardTap = { pointerId: e.pointerId, id, x: e.clientX, y: e.clientY, slop: TAP_MOVE_SLOP };
      startPan(e);
    } else if (id) {
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      const held = selection.has(id);
      if (additive) select([id], true);
      else if (!held) select([id]);
      cardTap = { pointerId: e.pointerId, id, x: e.clientX, y: e.clientY, slop: DRAG_SLOP };
      startMove(e, id);
      // Carried on the gesture so the lift can tell a selection edit from a
      // pick - see `unpick` in endPointer(). A modified press means "toggle
      // this card", and whether the lift should drop it again depends on what
      // the press found, not on how big the selection ended up.
      g.additive = additive;
      g.wasSelected = held;
    } else if (e.shiftKey || e.ctrlKey || e.metaKey) {
      startMarquee(e);
    } else {
      if (selection.size) clearSelection();
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
      pressAt = { x: e.clientX, y: e.clientY, id };
      pressTimer = setTimeout(() => {
        const p = pressAt;
        cancelPress();
        if (!p) return;
        emptyTapCandidate = null;
        lastEmptyTap = null;
        armSelect = null;
        cardTap = null;
        // Whatever the finger had started - a move, a pan, a marquee - it was
        // not that. Dropped rather than committed, since nothing moved.
        abortGesture();
        longPressMenu = { x: p.x, y: p.y, at: performance.now() };
        openMenuAt(p.x, p.y, p.id);
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
    if (emptyTapCandidate?.pointerId === e.pointerId
        && Math.hypot(e.clientX - emptyTapCandidate.x, e.clientY - emptyTapCandidate.y) > TAP_MOVE_SLOP) {
      emptyTapCandidate = null;
      lastEmptyTap = null;
    }
    // The same slop, for the same reason: a finger that has travelled this far
    // was panning, and a pan must not leave a selection behind it.
    if (armSelect?.pointerId === e.pointerId
        && Math.hypot(e.clientX - armSelect.x, e.clientY - armSelect.y) > TAP_MOVE_SLOP) {
      armSelect = null;
    }
    // And a card that has been dragged was not tapped. Its own slop, carried on
    // the record, because the two paths that set it disagree about how far a
    // press may wander and still be a press - and both are right. On the pan
    // path nothing under the finger moves until the lift, so it gets the same
    // generous TAP_MOVE_SLOP the selection does, for the same finger-wobble
    // reason. On the move path the card is already following the pointer at
    // DRAG_SLOP, and a gesture that visibly moved a card should not also have
    // paused it.
    if (cardTap?.pointerId === e.pointerId
        && Math.hypot(e.clientX - cardTap.x, e.clientY - cardTap.y) > cardTap.slop) {
      cardTap = null;
    }
    // A finger that has travelled is dragging, not pressing. The same slop the
    // move gesture uses, so the two agree about when a press has become a drag.
    if (pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > DRAG_SLOP) {
      cancelPress();
      if (e.pointerType === 'touch') lastEmptyTap = null;
    }
    if (!g) return;

    if (g.kind === 'resize-pending') {
      const pending = g;
      const action = resizeHandleAction(
        { x: pending.x, y: pending.y },
        { x: e.clientX, y: e.clientY },
      );
      if (action !== 'resize') return;
      cancelPress();
      startResize(e, pending.id, pending.corner, pending);
    }

    if (g.kind === 'pinch') {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      vp.panByScreen(mid.x - g.mid.x, mid.y - g.mid.y);
      vp.zoomAt(mid.x, mid.y, dist / g.dist);
      g.dist = dist;
      g.mid = mid;
      return;
    }

    if (g.kind === 'pan') {
      vp.panByScreen(e.clientX - g.lastX, e.clientY - g.lastY);
      g.lastX = e.clientX;
      g.lastY = e.clientY;
      if (g.track) trackPan(g, e);
      // Once a middle-button pan clears the slop it is a drag, not a click, so
      // the release paste is the pan's and gets swallowed rather than pasted.
      if (midButtonDown && !midDragged && midDownAt
          && Math.hypot(e.clientX - midDownAt.x, e.clientY - midDownAt.y) > DRAG_SLOP) {
        midDragged = true;
      }
      return;
    }

    if (g.kind === 'touch-marquee') {
      if (Math.hypot(e.clientX - g.clientX, e.clientY - g.clientY) <= DRAG_SLOP) return;
      const p = vp.toWorld(e.clientX, e.clientY);
      g = { kind: 'marquee', x0: g.x0, y0: g.y0, x1: p.x, y1: p.y, additive: false };
      marquee.hidden = false;
      drawMarquee();
      applyMarquee();
      return;
    }

    if (g.kind === 'marquee') {
      const p = vp.toWorld(e.clientX, e.clientY);
      g.x1 = p.x; g.y1 = p.y;
      drawMarquee();
      applyMarquee();
      return;
    }

    if (g.kind === 'move') {
      const p = vp.toWorld(e.clientX, e.clientY);
      const dx = p.x - g.start.x, dy = p.y - g.start.y;
      if (!g.moved && Math.hypot(dx * vp.zoom, dy * vp.zoom) < DRAG_SLOP) return;
      // The press has become a drag. Raise now, so the stack change belongs to
      // the move that is about to be committed - see raiseToFront.
      if (!g.moved) {
        raiseToFront(g.moving);
        // The pointer is captured by #viewport, so the cursor is #viewport's
        // however far the card under it wants a grabbing hand. Mark the viewport
        // for the length of the drag - see #viewport.is-moving in the CSS.
        el.classList.add('is-moving');
      }
      g.moved = true;
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
      const lead = g.origin.find(o => o.id === g.lead) || g.origin[0];
      const low = { x: lead.x + dx - lead.w / 2, y: lead.y + dy - lead.h / 2 };
      let sx = snapLow(low.x) - low.x;
      let sy = snapLow(low.y) - low.y;
      // A dragged note that would stick: show its would-be host wearing the
      // selection ring so the target is unmistakable before release, and - when
      // snapping is on - let the note land exactly where it was let go rather
      // than on the nearest grid line, since it is being stuck to that host and a
      // sticky that jumps a few pixels off the picture reads as a refusal. Only
      // the note being dragged is measured; everything else keeps snapping.
      //
      // g.lead, not g.id: a press on a pinned star is dragging the photograph,
      // and the photograph is not looking for a host. Asking about the star
      // would light up whatever it is about to be carried over.
      const leadItem = byId(g.lead);
      const host = isSticky(leadItem)
        ? wouldStick(
          { x: lead.x + dx, y: lead.y + dy, w: leadItem.w, h: leadItem.h }, g.lead, leadItem)
        : null;
      showStickTarget(host);
      if (board.settings.snap && host) {
        sx = 0;
        sy = 0;
      }
      // flatMap rather than map: g.origin was taken when the gesture began, and
      // an item can leave the board mid-drag - deleted from the bin, undone, or
      // swapped out wholesale by a load. Dropping it here rather than reading w
      // off undefined is the same call applyGeom() and snapshotGeom() already
      // make; the gesture then simply carries what is left.
      applyGeom(g.origin.flatMap(o => {
        const it = byId(o.id);
        return it
          ? [{ id: o.id, x: o.x + dx + sx, y: o.y + dy + sy, w: it.w, h: it.h, rot: it.rot, z: it.z }]
          : [];
      }));
      return;
    }

    if (g.kind === 'resize') {
      // The card being resized can leave the board mid-gesture - deleted from
      // the bin, undone, or swapped out wholesale by a load. Checked at the head
      // of the branch rather than at the note-floor read below, which was the
      // first line to touch it and threw; abortGesture() commits whatever the
      // gesture had already done and lets go, which is what a release would have
      // done a moment later anyway.
      const it = byId(g.id);
      if (!it) { abortGesture(); return; }
      const p = vp.toWorld(e.clientX, e.clientY);
      const dx = p.x - g.start.x, dy = p.y - g.start.y;
      // Zero on an axis the handle does not touch: dragging the east edge must
      // leave the height alone, where a corner moves both.
      const c = g.corner;
      const signX = c.includes('e') ? 1 : c.includes('w') ? -1 : 0;
      // 'n' is the +y side of the item, because world y points up.
      const signY = c.includes('n') ? 1 : c.includes('s') ? -1 : 0;
      let w = resizeAxis(signX, g.box.x, g.box.w, dx);
      let h = resizeAxis(signY, g.box.y, g.box.h, dy);
      // Apply the card and carry its stuck notes with it. Each note is placed at
      // the fraction of the card it held when the drag began (g.box is that start
      // box), so a note near a moving edge is dragged along by that edge and none
      // is left hanging off the shrunk card. No followers -> a plain one-item write.
      const applyResize = host => {
        if (!g.followers.length) return applyGeom([host]);
        const riders = g.followers.map(f => {
          const at = stuckPlacement(f.box, g.box, host);
          return { id: f.id, x: at.x, y: at.y, w: f.box.w, h: f.box.h, rot: f.box.rot, z: f.box.z };
        });
        applyGeom([host, ...riders]);
      };
      if (g.lockAspect !== e.shiftKey) {          // XOR: shift inverts the default
        // The dragged side leads and the other follows it at the picture's own
        // proportion. The side you are watching move is the right one to lead:
        // it is the one being aimed.
        const ratio = g.box.w / g.box.h;
        if (Math.abs(w - g.box.w) > Math.abs(h - g.box.h)) h = w / ratio;
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
        if (board.settings.snap) {
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
      if (g.holds) {
        const floor = carryFloor(g.box, g.holds);
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
        let floor = noteFloor(g.id, w);
        // Up to the next whole cell rather than to the bare floor, so the one
        // height this file sets from something other than the pointer still
        // leaves the note sitting in the grid. Up and never down: rounding to
        // the nearest line could land under the floor, which is the one thing
        // the floor is for - and for the same reason it is not capped at
        // MAX_SIZE, which the floor is already allowed to overrule.
        if (board.settings.snap) {
          // A whole number of cells less a seam at each end - the same shape
          // latticeSide() gives, rounded up rather than to the nearest.
          const step = stepNow(), gap = 2 * insetNow();
          floor = Math.ceil((floor + gap) / step) * step - gap;
        }
        if (floor > h) {
          h = floor;
          // The height was forced, so the aspect lock no longer holds and the
          // centre has to be recomputed from the height we actually got.
          if (!signY) return applyResize({ id: g.id, x: g.box.x + signX * (w - g.box.w) / 2, y: g.box.y, w, h, rot: it.rot, z: it.z });
        }
      }
      // The opposite edge stays put, so the centre shifts by half the growth -
      // and on the axis an edge handle doesn't touch, signY is 0 and the item
      // grows symmetrically about its centre, which is what an aspect-locked
      // side drag should do.
      applyResize({
        id: g.id,
        x: g.box.x + signX * (w - g.box.w) / 2,
        y: g.box.y + signY * (h - g.box.h) / 2,
        w, h, rot: it.rot, z: it.z,
      });
    }
  });

  const endPointer = e => {
    // The middle-button paste fires on the *release* (mouseup/click), which
    // lands in the same task as this pointerup - so clearing the guard now would
    // uncover the very paste it exists to catch. Defer the clear to the next task
    // instead, past the click that carries the paste.
    if (e.button === 1) setTimeout(() => { midButtonDown = false; }, 0);
    const tap = e.type === 'pointerup' && emptyTapCandidate?.pointerId === e.pointerId
      ? { x: emptyTapCandidate.x, y: emptyTapCandidate.y, at: e.timeStamp }
      : null;
    if (emptyTapCandidate?.pointerId === e.pointerId) emptyTapCandidate = null;
    // The lift that turns a held-still press into a pick. pointerup only: a
    // pointercancel is the system taking the gesture away - a notification
    // shade, a call - and nothing a person did.
    if (armSelect?.pointerId === e.pointerId) {
      if (e.type === 'pointerup') select([armSelect.id], armSelect.additive);
      armSelect = null;
    }
    // pointerup only, like the pick above and for the same reason: a
    // pointercancel is the system taking the gesture away, not a person
    // finishing one.
    if (cardTap?.pointerId === e.pointerId) {
      if (e.type === 'pointerup') pauseOnTap(cardTap.id);
      cardTap = null;
    }
    cancelPress();
    pointers.delete(e.pointerId);
    releasePointerSafely(el, e.pointerId);
    if (!g) return;
    if (g.kind === 'pinch' && pointers.size >= 1) {
      // One finger lifted mid-pinch: fall back to a pan with the survivor.
      //
      // No `track`, so this pan cannot throw the board. Lifting one finger of a
      // pinch is how a pinch ends, and the survivor is usually still travelling
      // outwards from the zoom rather than pushing the board anywhere - so a
      // throw here would be the board running off on its own after a gesture
      // that was about the zoom. A finger that then deliberately drags is a
      // finger that can lift and start again.
      const [p] = [...pointers.values()];
      g = { kind: 'pan', lastX: p.x, lastY: p.y };
      return;
    }
    // Read while the gesture is still standing, spent once it is not.
    // pointerup only: a pointercancel is the system taking the gesture away, and
    // a board that carried on gliding after a notification pulled the finger off
    // it would be moving on nobody's instruction.
    const thrown = e.type === 'pointerup' && g.kind === 'pan'
      ? flingFrom(g, e.timeStamp)
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
    const unpick = e.type === 'pointerup' && g.kind === 'move' && !g.moved
        && (g.additive ? g.wasSelected : selection.size > 1)
      ? g.id
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
    const banded = e.type === 'pointerup' && g.kind === 'marquee'
        && drewRectangle(g, vp.zoom)
      ? {
        x0: Math.min(g.x0, g.x1), y0: Math.min(g.y0, g.y1),
        x1: Math.max(g.x0, g.x1), y1: Math.max(g.y0, g.y1),
      }
      : null;
    finishGesture();
    if (unpick) deselect(unpick);
    if (banded) cmds.fencePrompt(e.clientX, e.clientY, banded);
    if (thrown) vp.glide(thrown.vx, thrown.vy);
    if (tap) lastEmptyTap = tap;
    setPanCursor();
  };
  el.addEventListener('pointerup', endPointer);
  el.addEventListener('pointercancel', endPointer);

  /**
   * Commit whatever the gesture earned and release its DOM marks. The one place
   * the commit rules (a moved move, any resize) and the cleanup (marquee, the
   * resizing/panning/moving classes, the stick target) live, so finishGesture
   * and abortGesture cannot drift apart.
   */
  function releaseGesture() {
    // A drop that found a host is the way back from Unstick, and it is the only
    // way back - there is no "stick to this card" menu entry, because putting it
    // on the card is already how you say that. In front of the commit, not
    // inside it, so undo restores the flag instead of re-deriving it; resettle()
    // in state.js argues the whole of it. Only on a gesture that moved, so a
    // plain click on a loose note cannot quietly re-pin it.
    if (g.kind === 'move' && g.moved) {
      resettle(g.driven);
      commitGeom('Move', g.before, g.driven);
    }
    if (g.kind === 'resize') commitGeom('Resize', g.before, g.driven);
    if (g.kind === 'marquee') marquee.hidden = true;
    g.node?.classList.remove('is-resizing');
    el.classList.remove('is-panning', 'is-moving');
    showStickTarget(null);
    g = null;
  }

  function finishGesture() {
    if (!g) return;
    releaseGesture();
    syncItems();
  }

  /** Drop the gesture without committing (used when a pinch takes over). */
  function abortGesture() {
    if (!g) return;
    releaseGesture();
  }

  // The stick-target ring moved to canvas/items.js, which owns the nodes it
  // marks. It was a closure in here while a note drag was the only thing that
  // could aim at a host; a shape dragged out of the sticker window aims at one
  // too, and ui/sticker-window.js cannot reach into this function.

  // ---- wheel ------------------------------------------------------------

  // ---- what a swipe actually delivered ----------------------------------
  //
  // The wheel handler is the only place in this file that guesses at hardware,
  // and the guess cannot be checked by reading the code: a two-finger scroll is
  // *railed* by the platform - the axis you set off in is decided before the
  // page is told anything - so the numbers that arrive are the only evidence of
  // what the pad and the driver between them did with the gesture.
  //
  // Summarised per gesture rather than printed per event. A swipe is forty
  // events and the question is never about one of them: it is "did the sideways
  // half arrive at all, and in what shape?" - nothing, a trickle, or the
  // hundred-pixel lumps a non-precision horizontal wheel sends. Those are three
  // different faults with three different fixes, and one line each tells them
  // apart. Off unless asked for: cmds.debugWheel(), or open the board on #wheel.
  let swipe = null;
  let swipeTimer = 0;
  function noteWheel(e, kind) {
    if (!document.documentElement.hasAttribute('data-debug-wheel')) return;
    swipe ??= { n: 0, x: 0, y: 0, sideways: 0, biggest: 0 };
    swipe.n++;
    swipe.x += Math.abs(e.deltaX);
    swipe.y += Math.abs(e.deltaY);
    if (e.deltaX) swipe.sideways++;
    swipe.biggest = Math.max(swipe.biggest, Math.abs(e.deltaX));
    clearTimeout(swipeTimer);
    swipeTimer = setTimeout(() => {
      const s = swipe;
      swipe = null;
      console.info(`[mbrd] swipe: ${s.n} events, read as ${kind}. `
        + `Down the page ${Math.round(s.y)}px, across ${Math.round(s.x)}px `
        + `in ${s.sideways} of them, biggest single sideways step ${Math.round(s.biggest)}px.`);
    }, WHEEL_STREAM_MS + 100);
  }

  el.addEventListener('wheel', e => {
    e.preventDefault();
    const w = readWheel(e, vp.height);
    noteWheel(e, w.kind);
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
    const id = itemIdFromEvent(e.target);
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
  });

  // ---- keyboard ---------------------------------------------------------

  const typingInto = t =>
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
  const nativeKeyTarget = t =>
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
        clearSelection();
        cmds.clearActiveConnection?.();
        cmds.closeSidebar();
        break;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown':
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
  addEventListener('blur', () => { spaceDown = false; midButtonDown = false; setPanCursor(); });

  // Swallow the primary-selection paste a middle *drag* fires on release. Capture
  // phase and window-wide, so it runs before the note editor's own paste and the
  // board's paste-to-import below and can stop both. Only when the middle press
  // became a pan: a plain middle click still pastes, and an ordinary Ctrl+V is
  // untouched.
  addEventListener('paste', e => {
    if (!(midButtonDown && midDragged)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  function nudge(e) {
    if (!selection.size) return;
    e.preventDefault();
    const sx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const sy = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    // The arrow keys are a drag by another route, so they carry the same stuck
    // notes and the same fenced cards. No z-bump here: a nudge does not raise
    // anything, and the pair are already in the right order relative to each
    // other.
    const before = snapshotGeom(travelling(selection));
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
   * How far one press of an arrow key moves the selection.
   *
   * Snapped and unsnapped are two different questions rather than one question
   * with a different step size, which is the thing this used to get wrong: it
   * added a fixed distance either way, so on a snapped board every arrow key
   * took the item straight off the lattice that dragging it had just put it on,
   * and the only way to line it up again was to pick it up with the mouse.
   *
   * Snapped, the answer is a grid line rather than a distance - the next one
   * along in the direction pressed. An item that is already flush moves exactly
   * one cell; one that is not is pulled onto the lattice by the first press and
   * then moves a cell at a time like everything else. Deriving it from lines
   * rather than from a delta is also what makes the two agree at any zoom: the
   * lattice on screen coarsens as you pull back, and a distance computed from
   * the old step would land between the dots you are looking at.
   *
   * One delta for the whole selection, taken from the lead - the same bargain
   * the drag makes. Snapping each item to its own nearest line would collapse a
   * carefully spaced group onto the grid the first time somebody tapped an
   * arrow key, which is a rearrangement rather than a nudge.
   */
  function nudgeBy(sx, sy, far, before) {
    if (!board.settings.snap) {
      const step = far ? stepNow() : 1;
      return { dx: sx * step, dy: sy * step };
    }
    const step = stepNow();
    const inset = cellInset(step);
    const cells = far ? NUDGE_LEAP : 1;
    const lead = before.find(b => selection.has(b.id)) || before[0];
    // The item's *low edges* land on the lattice, not its centre - see the move
    // gesture above for why, and snapAll() in state.js for the arrangement this
    // is keeping rather than imposing. Measured from the seam rather than from
    // the line, so "flush already" means the same thing here as it does there.
    const axis = (sign, low) => {
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
  const canClip = e => !typingInto(e.target) && !!selection.size;

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
  function pasteAt() {
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
    // Some touch engines synthesize this before our hold timer, others after.
    // Whichever arrives first owns the gesture; cancelling here prevents the
    // other path from closing and rebuilding the same menu a moment later.
    cancelPress();
    armSelect = null;
    cardTap = null;
    abortGesture();
    if (repeatsLongPressContextMenu(longPressMenu, {
      x: e.clientX,
      y: e.clientY,
      at: performance.now(),
    })) {
      longPressMenu = null;
      return;
    }
    longPressMenu = null;
    openMenuAt(e.clientX, e.clientY, itemIdFromEvent(e.target));
  });

  function openMenuAt(x, y, id) {
    // Opening outside the selection retargets it, the way every file manager
    // behaves; opening inside one leaves the group intact.
    if (id && !selection.has(id)) select([id]);
    if (!id) clearSelection();
    cmds.contextMenu(x, y, id, selection.size);
  }
}
