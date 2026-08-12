import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDoubleTap, needsSelectionBeforeMove, repeatsLongPressContextMenu,
  releasePointerSafely, resizeHandleAction, shortcutsSuppressed,
  readWheel, resetWheelKind, WHEEL_NOTCH, WHEEL_STREAM_MS,
  carryFloor, drewRectangle, marqueeHit,
} from '../web/assets/js/canvas/input.ts';

test('double taps match within the touch timing and distance windows', () => {
  const first = { x: 100, y: 200, at: 1_000 };

  assert.equal(isDoubleTap(first, { x: 120, y: 210, at: 1_320 }), true);
  assert.equal(isDoubleTap(first, { x: 100, y: 200, at: 1_351 }), false);
  assert.equal(isDoubleTap(first, { x: 129, y: 200, at: 1_200 }), false);
});

test('double taps reject missing or backwards samples', () => {
  assert.equal(isDoubleTap(null, { x: 0, y: 0, at: 1 }), false);
  assert.equal(isDoubleTap({ x: 0, y: 0, at: 2 }, { x: 0, y: 0, at: 1 }), false);
});

test('an item must already be selected before a drag may move it', () => {
  const selected = new Set(['picked']);
  assert.equal(needsSelectionBeforeMove(selected, 'picked'), false);
  assert.equal(needsSelectionBeforeMove(selected, 'resting'), true);
});

test('canvas shortcuts stand down when handled or an overlay owns the keyboard', () => {
  // Nothing in the way: the shortcut runs.
  assert.equal(shortcutsSuppressed(false, false), false);
  // Already handled - e.g. the context menu's capture listener took the arrow key.
  assert.equal(shortcutsSuppressed(true, false), true);
  // A modal dialog or the open menu owns the keyboard.
  assert.equal(shortcutsSuppressed(false, true), true);
});

test('a native context menu does not reopen a freshly opened touch menu', () => {
  const opened = { x: 100, y: 200, at: 1_000 };
  assert.equal(repeatsLongPressContextMenu(opened, { x: 108, y: 207, at: 1_700 }), true);
  assert.equal(repeatsLongPressContextMenu(opened, { x: 108, y: 207, at: 1_901 }), false);
  assert.equal(repeatsLongPressContextMenu(opened, { x: 130, y: 200, at: 1_100 }), false);
});

test('a shift-click that never moved is not a rectangle somebody drew', () => {
  // startMarquee() runs on the press, so this shape is a real gesture: it means
  // "clear the selection", and the fence offer must not follow it.
  assert.equal(drewRectangle({ x0: 40, y0: 40, x1: 40, y1: 40 }, 1), false);
  assert.equal(drewRectangle(null, 1), false);
});

test('a rectangle is judged on the screen, not on the board', () => {
  const band = { x0: 0, y0: 0, x1: 100, y1: 100 };
  // The same world rectangle, zoomed right out: a flick of the wrist, and no
  // more an act of enclosure than the click above.
  assert.equal(drewRectangle(band, 1), true);
  assert.equal(drewRectangle(band, 0.05), false);
});

test('a thin band across a row of cards still counts', () => {
  // Height near zero is a perfectly ordinary way to sweep one row, so the test
  // is the diagonal rather than either side on its own.
  assert.equal(drewRectangle({ x0: 0, y0: 0, x1: 400, y1: 2 }, 1), true);
});

test('a rectangle counts whichever corner it was dragged from', () => {
  assert.equal(drewRectangle({ x0: 200, y0: 200, x1: 0, y1: 0 }, 1), true);
});

// A fence carries what is inside it when it is resized, the way a card carries
// the notes stuck to it - so nothing can be left outside by a moving edge, and
// the floor that used to say so is gone. What is left is a different question
// with the same shape: a card keeps its *fraction* of the region but not its
// size, so past a point the cards are at the right places and hanging over the
// border anyway. carryFloor() is where the region stops shrinking.

const BOX = { x: 0, y: 0, w: 1000, h: 1000 };

test('a region with nothing in it has no floor', () => {
  assert.deepEqual(carryFloor(BOX, []), { w: 0, h: 0 });
  assert.deepEqual(carryFloor(BOX, null), { w: 0, h: 0 });
});

test('the floor is what it takes for the card to still fit', () => {
  // A card at a quarter of the way out has a quarter of the width between it and
  // the border, so 100 of half-width needs 100 / (0.5 - 0.25) = 400.
  assert.equal(carryFloor(BOX, [{ fx: 0.25, fy: 0, hw: 100, hh: 10 }]).w, 400);
  // Dead centre it only has to be as wide as the card itself.
  assert.equal(carryFloor(BOX, [{ fx: 0, fy: 0, hw: 60, hh: 10 }]).w, 120);
  // Both signs read the same - the fraction is a distance from the middle.
  assert.equal(carryFloor(BOX, [{ fx: -0.25, fy: 0, hw: 100, hh: 10 }]).w, 400);
});

// 0.5 - 0.4 is not 0.1 in binary, and this is a division by it.
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test('the two axes are answered independently', () => {
  const floor = carryFloor(BOX, [{ fx: 0.25, fy: 0.4, hw: 100, hh: 50 }]);
  near(floor.w, 400);
  near(floor.h, 500);                       // 50 / (0.5 - 0.4)
});

test('the card with the least room to spare sets it', () => {
  const holds = [
    { fx: 0.1, fy: 0, hw: 40, hh: 10 },     // 50
    { fx: 0.4, fy: 0, hw: 60, hh: 10 },     // 600
    { fx: 0.2, fy: 0, hw: 30, hh: 10 },     // 100
  ];
  near(carryFloor(BOX, holds).w, 600);
});

test('a card already hanging out cannot prise the region open', () => {
  // At or past the halfway fraction no width fits it, so the sum is an infinity -
  // and the cap turns that into "this one does not shrink" rather than a grip
  // that snaps the region open the moment it is touched.
  assert.equal(carryFloor(BOX, [{ fx: 0.5, fy: 0, hw: 10, hh: 10 }]).w, 1000);
  assert.equal(carryFloor(BOX, [{ fx: 0.9, fy: 0, hw: 10, hh: 10 }]).w, 1000);
  // And an ordinary card that would ask for more than the region already is.
  assert.equal(carryFloor(BOX, [{ fx: 0.45, fy: 0, hw: 400, hh: 10 }]).w, 1000);
});

test('the floor never asks for growth', () => {
  // Every case above is capped, so a grip can always be dragged outwards and a
  // region can never widen on its own from being grabbed.
  const holds = [{ fx: 0.49, fy: 0.49, hw: 500, hh: 500 }];
  const floor = carryFloor(BOX, holds);
  assert.ok(floor.w <= BOX.w);
  assert.ok(floor.h <= BOX.h);
});

// A band catches a card by overlap and a fence only by covering it. A fence is
// always larger than what is drawn inside it, so one rule for both meant every
// band drawn within a region also caught the region.

const card = extra => ({ type: 'photo', x: 0, y: 0, w: 100, h: 100, ...extra });
const fence = extra => ({ type: 'fence', x: 0, y: 0, w: 1000, h: 800, ...extra });

test('a band drawn inside a fence catches the cards and not the fence', () => {
  // A small band well within the region: it overlaps the fence, and that is
  // exactly the reading this rule refuses.
  assert.equal(marqueeHit(card({ x: 120, y: 60 }), 100, 40, 200, 90), true);
  assert.equal(marqueeHit(fence(), 100, 40, 200, 90), false);
});

test('a band round the whole fence takes it', () => {
  assert.equal(marqueeHit(fence(), -600, -500, 600, 500), true);
  // And one that leaves a single edge out does not - to take a region, enclose it.
  assert.equal(marqueeHit(fence(), -600, -500, 499, 500), false);
});

test('a card is still caught by the corner it pokes into a band', () => {
  // The overlap rule the union in fenceBox() exists to cover: unchanged.
  assert.equal(marqueeHit(card({ x: 140, y: 0 }), 0, -50, 100, 50), true);
});

test('a tap on a resize handle waits until it crosses the drag slop', () => {
  const start = { x: 100, y: 200 };
  assert.equal(resizeHandleAction(start, { x: 102, y: 201 }), 'wait');
  assert.equal(resizeHandleAction(start, null), 'wait');
});

test('dragging a resize handle past the slop starts a resize', () => {
  const start = { x: 100, y: 200 };
  assert.equal(resizeHandleAction(start, { x: 103, y: 200 }), 'resize');
  assert.equal(resizeHandleAction(start, { x: 120, y: 230 }), 'resize');
});

test('a pointer invalidated during capture release is already released', () => {
  const stale = {
    hasPointerCapture: () => true,
    releasePointerCapture: () => {
      throw new DOMException('Invalid pointer id', 'NotFoundError');
    },
  };

  assert.equal(releasePointerSafely(stale, 7), false);
});

// ---------------------------------------------------------------------------
// Telling a touchpad from a mouse wheel
// ---------------------------------------------------------------------------
//
// One event, two devices, opposite meanings - a heuristic, so the cases it has
// to get right are written down rather than trusted. `at` is the event's
// timeStamp and matters as much as the deltas: the answer is latched for the
// length of a burst, which is what stops a fast swipe being re-read as a wheel
// halfway through.

const wheel = (props = {}) => readWheel({
  deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, shiftKey: false, timeStamp: 0, ...props,
});

beforeEach(() => resetWheelKind());

test('a mouse wheel still zooms, whatever it counts in', () => {
  // Chrome and Safari: a hundred pixels a notch. Firefox: three lines.
  assert.equal(wheel({ deltaY: 100 }).kind, 'zoom');
  assert.equal(wheel({ deltaY: -120, timeStamp: 5_000 }).kind, 'zoom');
  assert.equal(wheel({ deltaY: 3, deltaMode: 1, timeStamp: 10_000 }).kind, 'zoom');
  // Down the page zooms out, up zooms in, and both come back as a factor.
  assert.ok(wheel({ deltaY: 100, timeStamp: 20_000 }).factor < 1);
  assert.ok(wheel({ deltaY: -100, timeStamp: 30_000 }).factor > 1);
});

test('two fingers on a pad pan, in both axes at once', () => {
  // The case this was written for: a swipe on a laptop used to zoom the board,
  // and its sideways half was thrown away entirely.
  const w = wheel({ deltaX: -8, deltaY: 6 });
  assert.equal(w.kind, 'pan');
  assert.deepEqual([w.dx, w.dy], [-8, 6], 'both axes survive');
  assert.equal(w.factor, 1, 'and nothing is zoomed');

  // The three ways a pad gives itself away, each on its own.
  resetWheelKind();
  assert.equal(wheel({ deltaX: 4 }).kind, 'pan', 'sideways at all');
  resetWheelKind();
  assert.equal(wheel({ deltaY: 2.5 }).kind, 'pan', 'in fractions of a pixel');
  resetWheelKind();
  assert.equal(wheel({ deltaY: WHEEL_NOTCH - 1 }).kind, 'pan', 'in steps under a notch');
  resetWheelKind();
  assert.equal(wheel({ deltaY: WHEEL_NOTCH }).kind, 'zoom', 'and a notch is a notch');
});

test('a burst keeps the device it started as', () => {
  // A swipe starts slow, so its first event is small and reads as a pad. What
  // follows can be as fast and as square as any wheel notch and must not be
  // re-read: the board would zoom in the middle of somebody scrolling it.
  assert.equal(wheel({ deltaY: 3, timeStamp: 1_000 }).kind, 'pan');
  assert.equal(wheel({ deltaY: 100, timeStamp: 1_040 }).kind, 'pan');
  assert.equal(wheel({ deltaY: 220, timeStamp: 1_080 }).kind, 'pan');

  // And the burst ends when the hand stops, not on a timer since it began.
  const after = 1_080 + WHEEL_STREAM_MS + 1;
  assert.equal(wheel({ deltaY: 100, timeStamp: after }).kind, 'zoom');
});

test('a pinch zooms from either device, and takes nothing with it', () => {
  // Every engine reports a touchpad pinch as a wheel event with ctrlKey set.
  const pinch = wheel({ deltaY: -6, ctrlKey: true, timeStamp: 1_000 });
  assert.equal(pinch.kind, 'zoom');
  assert.ok(pinch.factor > 1, 'fingers apart is closer in');

  // Worth more per unit than a wheel notch: the two devices count in different
  // sizes, and at the wheel's rate a pinch would move almost nothing.
  resetWheelKind();
  const notch = wheel({ deltaY: -6, timeStamp: 9_000 });
  assert.ok(pinch.factor > notch.factor || notch.kind === 'pan');

  // And a pinch does not latch: it is also what ctrl+wheel on a real mouse
  // looks like, and a modifier must not change what the next plain notch means.
  resetWheelKind();
  wheel({ deltaY: -6, ctrlKey: true, timeStamp: 1_000 });
  assert.equal(wheel({ deltaY: 100, timeStamp: 1_020 }).kind, 'zoom');
});

// A swipe, as a burst of events a few milliseconds apart - which is the only
// way to exercise the lean, since it is measured over a gesture and not read off
// one event. Returns what the last event came out as.
function swipe(steps) {
  resetWheelKind();
  let out;
  steps.forEach(([deltaX, deltaY], i) => {
    out = wheel({ deltaX, deltaY, timeStamp: 1_000 + i * 8 });
  });
  return out;
}

const times = (n, step) => Array.from({ length: n }, () => step);

test('an axis the platform is withholding is given back', () => {
  // The recorded case: a swipe down the board with a curve in it arrived as
  // 5257px of vertical against 973px of sideways, four events in five carrying
  // no sideways at all. The fingers went one way and the platform reported a
  // fifth of it, which is what "it takes over too much" is.
  const out = swipe([...times(40, [0, 15]), [13, 15]]);
  assert.equal(out.kind, 'pan');
  assert.ok(out.dx > 13 * 2, `a withheld sideways step is lifted, got ${out.dx}`);
  assert.equal(out.dy, 15, 'and the axis carrying the swipe is left exactly alone');
});

test('a swipe delivered whole is left alone, however lopsided', () => {
  // Both from the same pad within a minute of each other, and this is the pair
  // the measure has to tell apart. 791 by 1147 with the sideways half in 58 of
  // 59 events, and 54 by 793 with it in all 36: the platform is reporting what
  // the fingers did in both, so a hand on either must feel nothing added. Only
  // the second is lopsided, which is exactly why lopsidedness cannot be the
  // test - reading it that way multiplied a sideways flick's little drift by
  // nearly three and slid the board out from under the gesture.
  const even = swipe(times(40, [19, 13]));
  assert.deepEqual([even.dx, even.dy], [19, 13]);

  const flick = swipe(times(36, [22, 1.5]));
  assert.deepEqual([flick.dx, flick.dy], [22, 1.5]);
});

test('a swipe the platform railed outright cannot be rescued', () => {
  // Straight sideways reports vertical of exactly zero - not a small number, a
  // zero - and no multiple of zero is a lean. Said out loud because it is the
  // limit of what this can do, and Shift is the answer instead.
  const out = swipe(times(30, [25, 0]));
  assert.equal(out.dy, 0);
  assert.equal(out.dx, 25, 'the axis that did arrive is not amplified either');
});

test('nothing is lifted on the strength of one event', () => {
  // Both measures start out saying "delivered whole", so evidence of a rail has
  // to accumulate before anything is handed back. The opening of a swipe is
  // where the evidence is thinnest and a wrong answer is most visible.
  const first = swipe([[0, 15]]);
  assert.deepEqual([first.dx, first.dy], [0, 15]);
  const second = swipe([[0, 15], [4, 15]]);
  assert.ok(second.dx < 4 * 1.5, `barely touched this early, got ${second.dx}`);
});

test('a lump released in one event is not multiplied into a jerk', () => {
  // The failure mode a cap on top would have been for, and it needs none: a
  // delta the driver held back raises its own axis's measure as it lands, which
  // levels the two and takes the lift off the very event that would have jerked.
  const lump = swipe([...times(40, [0, 15]), [48, 15]]);
  const trickle = swipe([...times(40, [0, 15]), [6, 15]]);
  assert.ok(lump.dx >= 48, 'never less than the platform reported');
  assert.ok(lump.dx / 48 < trickle.dx / 6,
    `the lump is lifted proportionally less than the trickle, ${lump.dx} vs ${trickle.dx}`);
});

test('the lean is measured over a burst and forgotten with it', () => {
  // A gesture, then a pause, then a gesture the other way. Carrying the first
  // one's shape into the second lifts the wrong axis for as long as it takes the
  // measure to catch up - which is the whole of the first swipe on that pad.
  //
  // Lopsided on purpose. This used to be 20 by 20, which passed on a tie: with
  // equal magnitudes `axisX < axisY` is false either way, so the reset of those
  // two was enough and the presence measures - the ones the gain actually reads,
  // and the ones a rail drives to nearly zero - were never asked about. One unit
  // of difference is enough to name a minor axis and so to see them.
  swipe(times(40, [0, 15]));
  const later = wheel({ deltaX: 20, deltaY: 21, timeStamp: 90_000 });
  assert.deepEqual([later.dx, later.dy], [20, 21], 'the new swipe starts even');
});

test('shift is the way across a railed pad, from either device', () => {
  // The platform decides at the start of a two-finger swipe which axis you
  // meant and suppresses the other until you lift, so a gesture that begins
  // straight down reports deltaX of exactly zero however far sideways the
  // fingers then go. Shift moves the whole delta onto the horizontal, which is
  // the one way across that works from inside the rail.
  const railed = wheel({ deltaY: 12, shiftKey: true });
  assert.equal(railed.kind, 'pan');
  assert.deepEqual([railed.dx, railed.dy], [12, 0]);

  // Some browsers do the swap themselves on the way past. Doing it twice would
  // put the movement back where it started.
  resetWheelKind();
  const swapped = wheel({ deltaX: 12, deltaY: 0, shiftKey: true, timeStamp: 5_000 });
  assert.deepEqual([swapped.dx, swapped.dy], [12, 0]);

  // And the same key over a real wheel, which is what it has always done.
  resetWheelKind();
  const mouse = wheel({ deltaY: 100, shiftKey: true, timeStamp: 10_000 });
  assert.equal(mouse.kind, 'pan');
  assert.deepEqual([mouse.dx, mouse.dy], [100, 0]);
});

test('holding shift does not leave a mouse latched into panning', () => {
  // Shift is an override on what a wheel event *does*, applied after the device
  // is decided and never as part of deciding it. Latching it would mean the
  // notch after somebody let go of the key scrolled the board instead of
  // zooming it, for as long as they kept scrolling.
  assert.equal(wheel({ deltaY: 100, shiftKey: true, timeStamp: 1_000 }).kind, 'pan');
  assert.equal(wheel({ deltaY: 100, timeStamp: 1_040 }).kind, 'zoom');
});

test('lines and pages are turned into pixels before anything reads them', () => {
  // deltaMode 1 is lines and 2 is pages, and the page height is the caller's to
  // know. Nothing downstream should have to ask which unit it was handed.
  assert.equal(wheel({ deltaY: 3, deltaMode: 1 }).dy, 48);
  assert.equal(readWheel(
    { deltaX: 0, deltaY: 1, deltaMode: 2, ctrlKey: false, timeStamp: 50_000 }, 900).dy, 900);
});

test('safe pointer release does not hide ordinary programming errors', () => {
  const broken = {
    hasPointerCapture: () => true,
    releasePointerCapture: () => {
      throw new Error('broken release implementation');
    },
  };

  assert.throws(() => releasePointerSafely(broken, 7), /broken release implementation/);
});
