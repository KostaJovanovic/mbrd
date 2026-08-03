import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDoubleTap, needsSelectionBeforeMove, repeatsLongPressContextMenu,
  releasePointerSafely, resizeHandleAction, shortcutsSuppressed,
  readWheel, resetWheelKind, WHEEL_NOTCH, WHEEL_STREAM_MS,
} from '../web/assets/js/canvas/input.js';

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
  // one's shape into the second would lift the wrong axis for as long as it took
  // the measure to catch up.
  swipe(times(40, [0, 15]));
  const later = wheel({ deltaX: 20, deltaY: 20, timeStamp: 90_000 });
  assert.deepEqual([later.dx, later.dy], [20, 20], 'the new swipe starts even');
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
