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
//   wheel ....................... zoom to cursor;  shift+wheel pans horizontally
//   two fingers ................. pan + pinch zoom

import { clamp } from '../util.js';
import {
  board, byId, selection, select, deselect, clearSelection, topZ, stackOrder,
  snapshotGeom, applyGeom, commitGeom, bus, stuckFollowers, stuckPlacement, wouldStick,
  copyItems, cutItems, pasteItems, clipboardSize, clipboardBounds, clipboardHasOurs,
  baseStep,
} from '../state.js';
import { zoomMs } from './viewport.js';
import { itemInRect, latticeBox, latticeLow, cellInset, MIN_SIZE, MAX_SIZE } from '../geometry.js';
import { itemIdFromEvent, ensureMounted, nodeFor, sync as syncItems, editItemName } from './items.js';
import { noteFloor } from './notes.js';

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
  // Where the cursor is, and where it was when the last copy was taken - the
  // two halves of "has the pointer moved since?", which is what decides where
  // a paste lands. Both null on a touch device, and a null falls back to the
  // old behaviour rather than guessing.
  let hover = null;
  let copiedFrom = null;
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
  // A pointer resting on an unpicked item - see needsTapFirst(). The gesture is
  // a pan; this is what lets the lift still count as a tap if it never moved.
  let armSelect = null;
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = 0; pressAt = null; };

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
    g = { kind: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: e.shiftKey };
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
    const hit = board.items
      .filter(i => itemInRect(i, x0, y0, x1, y1))
      .map(i => i.id);
    select(hit, g.additive);
  }

  function startMove(e, id) {
    // Whatever is stuck to the selection comes with it. Worked out once, here,
    // and then held for the length of the gesture: recomputing it per frame
    // would let notes latch on and fall off as the drag swept the selection
    // across other items, so the group you picked up would not be the group you
    // put down. What is stuck when you take hold is what travels.
    const moving = [...selection, ...stuckFollowers(selection)];
    // Snapshotted here, before anything is touched, so the raise below rides
    // along in the same undo entry as the move it belongs to.
    const before = snapshotGeom(moving);
    const start = vp.toWorld(e.clientX, e.clientY);
    g = {
      kind: 'move', id, moving, before, start,
      // The sides come along as well as the corner: snapping puts the lead's low
      // edges on lines, and an edge is its centre less half its size.
      origin: before.map(b => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h })),
      moved: false,
      // What the pointer has hold of, as against what it is towing. Only these
      // ask again what they are stuck to when the drag ends - a note carried
      // across the board by the photo underneath it has not moved relative to
      // anything, and re-parenting it would take apart the pile you built by
      // moving it. See restick() in state.js.
      driven: [...selection],
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
    for (const sid of stackOrder(ids)) byId(sid).z = ++z;
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
    // Snapshotted into `before` so one undo puts the whole group back, but
    // deliberately left out of `driven`: a note that kept its place on the card
    // has not changed what it is stuck to, so it must not be re-measured on
    // release - the same reasoning startMove() gives for a towed follower.
    const riders = stuckFollowers([id]);
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

    const target = e.target instanceof Element ? e.target : null;
    const grip = target?.closest('.grip') || null;
    const id = itemIdFromEvent(e.target);
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

    if (spaceDown || e.button === 1) {
      e.preventDefault();
      startPan(e);
    } else if (grip && id) {
      // A grip press is only a candidate. Waiting for movement lets the
      // southeast target double as the menu button it visually shares a corner
      // with, and avoids touching snapped geometry on a plain tap.
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
    } else if (id && needsTapFirst(id)) {
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
      startPan(e);
    } else if (id) {
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (additive) select([id], true);
      else if (!selection.has(id)) select([id]);
      startMove(e, id);
    } else if (e.shiftKey || e.ctrlKey || e.metaKey) {
      startMarquee(e);
    } else {
      if (selection.size) clearSelection();
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
    if (e.pointerType !== 'touch') hover = { x: e.clientX, y: e.clientY };
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
      if (!g.moved) raiseToFront(g.moving);
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
      const lead = g.origin.find(o => o.id === g.id) || g.origin[0];
      const low = { x: lead.x + dx - lead.w / 2, y: lead.y + dy - lead.h / 2 };
      let sx = snapLow(low.x) - low.x;
      let sy = snapLow(low.y) - low.y;
      // A dragged note that would stick: show its would-be host wearing the
      // selection ring so the target is unmistakable before release, and - when
      // snapping is on - let the note land exactly where it was let go rather
      // than on the nearest grid line, since it is being stuck to that host and a
      // sticky that jumps a few pixels off the picture reads as a refusal. Only
      // the note being dragged is measured; everything else keeps snapping.
      const leadItem = byId(g.id);
      const host = leadItem?.type === 'note'
        ? wouldStick({ x: lead.x + dx, y: lead.y + dy, w: leadItem.w, h: leadItem.h }, g.id)
        : null;
      showStickTarget(host);
      if (board.settings.snap && host) {
        sx = 0;
        sy = 0;
      }
      applyGeom(g.origin.map(o => {
        const it = byId(o.id);
        return { id: o.id, x: o.x + dx + sx, y: o.y + dy + sy, w: it.w, h: it.h, rot: it.rot, z: it.z };
      }));
      return;
    }

    if (g.kind === 'resize') {
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
      // A note may not be dragged smaller than its own text. The floor is
      // measured at the width being proposed, not the one on screen, because
      // narrowing a note rewraps it and makes it *taller* - so pulling a side
      // in can push the bottom out, which is the honest answer.
      //
      // This runs after the limits above and is allowed to overrule the ceiling
      // on the way up, because a note taller than MAX_SIZE is only unusual
      // whereas a note with its last paragraph cut off is wrong. It can only
      // ever raise the height, so it never threatens the floor.
      const it = byId(g.id);
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
    const unpick = e.type === 'pointerup' && g.kind === 'move' && !g.moved
      ? g.id
      : null;
    finishGesture();
    if (unpick) deselect(unpick);
    if (thrown) vp.glide(thrown.vx, thrown.vy);
    if (tap) lastEmptyTap = tap;
    setPanCursor();
  };
  el.addEventListener('pointerup', endPointer);
  el.addEventListener('pointercancel', endPointer);

  function finishGesture() {
    if (!g) return;
    if (g.kind === 'marquee') marquee.hidden = true;
    if (g.kind === 'move' && g.moved) commitGeom('Move', g.before, g.driven);
    if (g.kind === 'resize') commitGeom('Resize', g.before, g.driven);
    g.node?.classList.remove('is-resizing');
    el.classList.remove('is-panning');
    showStickTarget(null);
    g = null;
    syncItems();
  }

  /** Drop the gesture without committing (used when a pinch takes over). */
  function abortGesture() {
    if (!g) return;
    if (g.kind === 'move' && g.moved) commitGeom('Move', g.before, g.driven);
    if (g.kind === 'resize') commitGeom('Resize', g.before, g.driven);
    if (g.kind === 'marquee') marquee.hidden = true;
    g.node?.classList.remove('is-resizing');
    el.classList.remove('is-panning');
    showStickTarget(null);
    g = null;
  }

  // The item a dragged note would stick to on release, wearing the selection
  // ring while it is aimed at. Only one at a time; cleared when the drag ends.
  let stickTargetId = null;
  function showStickTarget(host) {
    const id = host?.id ?? null;
    if (id === stickTargetId) return;
    if (stickTargetId) nodeFor(stickTargetId)?.classList.remove('is-stick-target');
    stickTargetId = id;
    if (id) nodeFor(id)?.classList.add('is-stick-target');
  }

  // ---- wheel ------------------------------------------------------------

  el.addEventListener('wheel', e => {
    e.preventDefault();
    // deltaMode 1 = lines, 2 = pages: normalise to something pixel-ish.
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vp.height : 1;
    // Mobile is a fixed-width feed: the wheel follows the only axis that
    // remains navigable instead of changing its locked-to-width zoom.
    if (vp.isMobile) {
      vp.panByScreen(0, -e.deltaY * scale);
      return;
    }
    if (e.shiftKey && !e.ctrlKey) {
      vp.panByScreen(-e.deltaY * scale, 0);
      return;
    }
    const dy = e.deltaY * scale;
    vp.zoomAt(e.clientX, e.clientY, Math.exp(-clamp(dy, -400, 400) * 0.0016));
  }, { passive: false });

  // ---- double click -----------------------------------------------------

  // Double click no longer touches the zoom - not on empty space (it used to fit
  // the whole board) and not on a card (it used to zoom to that card). The one
  // meaning left is opening a note to edit, which is not a zoom and stays. Zoom
  // to fit is still on the F key and in the menu.
  el.addEventListener('dblclick', e => {
    const id = itemIdFromEvent(e.target);
    if (!id) return;
    if (byId(id)?.type === 'note') cmds.editNote(id);
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
      case 'Delete': case 'Backspace': cmds.deleteSelection(); e.preventDefault(); break;
      // One item only: a rename has to put the caret somewhere, and a group
      // selection has no single name to put it in.
      case 'F2': if (selection.size === 1) { editItemName([...selection][0]); e.preventDefault(); } break;
      case '0': cmds.recenter(); break;
      case 'f': case 'F': cmds.fit(); break;
      case '+': case '=': vp.zoomBy(1.25, zoomMs()); break;
      case '-': case '_': vp.zoomBy(1 / 1.25, zoomMs()); break;
      case 'Escape': clearSelection(); cmds.closeSidebar(); break;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown':
        nudge(e);
        break;
    }
  });

  addEventListener('keyup', e => {
    if (e.code === 'Space') { spaceDown = false; setPanCursor(); }
  });
  // A blur (alt-tab) never delivers the keyup, which would leave pan mode stuck.
  addEventListener('blur', () => { spaceDown = false; setPanCursor(); });

  function nudge(e) {
    if (!selection.size) return;
    e.preventDefault();
    const sx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const sy = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    // The arrow keys are a drag by another route, so they carry the same stuck
    // notes. No z-bump here: a nudge does not raise anything, and the pair are
    // already in the right order relative to each other.
    const before = snapshotGeom([...selection, ...stuckFollowers(selection)]);
    const { dx, dy } = nudgeBy(sx, sy, e.shiftKey, before);
    if (!dx && !dy) return;
    applyGeom(before.map(b => ({ ...b, x: b.x + dx, y: b.y + dy })));
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
    copiedFrom = hover;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', text);
  });

  addEventListener('cut', e => {
    if (!canClip(e)) return;
    const text = cutItems(selection);
    if (!text) return;
    copiedFrom = hover;
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
   * How far the cursor has to have travelled since the copy before the paste
   * follows it, in screen pixels. Small, because moving the mouse at all is
   * already deliberate; not zero, because a mouse drifts a pixel or two under
   * a hand that is only reaching for Ctrl+V, and a paste that jumped for that
   * would be worse than one that never followed at all.
   */
  const MOVED_ENOUGH = 24;

  /**
   * Where a paste should land, in three cases.
   *
   * Under the cursor, if the cursor has gone somewhere since the copy was
   * taken. Moving the mouse and then pasting is the plainest way there is of
   * saying "put it here", and it costs nothing to answer.
   *
   * Otherwise nothing, meaning "beside the original" - unless the box the copy
   * came from is nowhere in view, in which case the middle of the screen,
   * because a paste you cannot see is indistinguishable from one that failed.
   *
   * A device with no cursor never reaches the first case: `hover` stays null,
   * and the other two are what it had before.
   */
  function pasteAt() {
    if (hover && copiedFrom && Math.hypot(hover.x - copiedFrom.x, hover.y - copiedFrom.y) > MOVED_ENOUGH) {
      return vp.toWorld(hover.x, hover.y);
    }
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
