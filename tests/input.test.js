import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDoubleTap, needsSelectionBeforeMove, repeatsLongPressContextMenu,
  releasePointerSafely, resizeHandleAction, shortcutsSuppressed,
  readWheel, resetWheelKind, WHEEL_NOTCH, WHEEL_STREAM_MS,
  carryFloor, drewRectangle, marqueeHit,
  GESTURE_MOVES, gestureTransition,
  resizeAxisOn, nudgeDelta,
} from '../web/assets/js/canvas/input.ts';
import { cellInset, MIN_SIZE, MAX_SIZE } from '../web/assets/js/geometry.ts';

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

// ---------------------------------------------------------------------------
// The gesture machine
// ---------------------------------------------------------------------------
//
// "Exactly one gesture is active at a time" is the property the whole input
// module exists to protect, and until the modes were written down it was
// asserted nowhere - it was kept by every branch of a 230-line pointerdown and a
// 270-line pointermove remembering to. A runner cannot press a pointer, so what
// it can check is the rule those branches follow: which mode may become which.
//
// The illegal cases below matter more than the legal ones. Every one of them was
// reachable in the old shape, because a bag of booleans has no opinion about
// which combinations exist.

const MODES = ['idle', 'press', 'pan', 'pinch', 'marquee', 'move', 'resize'];

test('the table covers every mode and names no others', () => {
  assert.deepEqual(Object.keys(GESTURE_MOVES).sort(), [...MODES].sort());
  for (const [from, tos] of Object.entries(GESTURE_MOVES)) {
    for (const to of tos) {
      assert.ok(MODES.includes(to), `${from} -> ${to} names a mode that does not exist`);
      assert.notEqual(from, to, `${from} -> ${from} is a gesture re-entering itself`);
    }
  }
});

test('a press decides between the five things a press can be', () => {
  // The five branches of onDown(), and nothing else may follow an idle pointer.
  assert.equal(gestureTransition('idle', 'pan'), 'pan');
  assert.equal(gestureTransition('idle', 'marquee'), 'marquee');
  assert.equal(gestureTransition('idle', 'move'), 'move');
  assert.equal(gestureTransition('idle', 'press'), 'press');
  assert.equal(gestureTransition('idle', 'pinch'), 'pinch');
});

test('a resize only ever begins from a press that crossed the slop', () => {
  // A grip press waits: it is a candidate until the pointer travels, which is
  // what keeps a plain tap on a corner from touching snapped geometry. So there
  // is no way into `resize` that does not go through `press`.
  assert.equal(gestureTransition('press', 'resize'), 'resize');
  assert.equal(gestureTransition('idle', 'resize'), null);
  assert.equal(gestureTransition('move', 'resize'), null);
  assert.equal(gestureTransition('pan', 'resize'), null);
});

test('a waiting press becomes the band or the resize, and nothing else', () => {
  // The two intents `press` carries - a grip, and the second tap of a touch
  // double-tap. It cannot turn into a pan or a move on the way.
  assert.equal(gestureTransition('press', 'marquee'), 'marquee');
  assert.equal(gestureTransition('press', 'pan'), null);
  assert.equal(gestureTransition('press', 'move'), null);
  assert.equal(gestureTransition('press', 'pinch'), null);
});

test('a second finger drops the gesture rather than converting it', () => {
  // This is what "a second finger always wins" means mechanically: the drag is
  // aborted - uncommitted, since nothing was finished - and the pinch is entered
  // from idle. A pan that turned straight into a pinch would be a move whose
  // geometry was never committed and never put back.
  assert.equal(gestureTransition('pan', 'pinch'), null);
  assert.equal(gestureTransition('move', 'pinch'), null);
  assert.equal(gestureTransition('marquee', 'pinch'), null);
  assert.equal(gestureTransition('resize', 'pinch'), null);
});

test('lifting one finger of a pinch leaves the survivor panning', () => {
  assert.equal(gestureTransition('pinch', 'pan'), 'pan');
  // And it is the only standing gesture that may become another one directly:
  // every other way into a pan is a fresh press.
  for (const from of MODES.filter(m => m !== 'idle' && m !== 'pinch')) {
    assert.equal(gestureTransition(from, 'pan'), null,
      `${from} -> pan is not a move this pipeline makes`);
  }
});

test('every gesture can end, and only by ending', () => {
  for (const from of MODES.filter(m => m !== 'idle')) {
    assert.equal(gestureTransition(from, 'idle'), 'idle', `${from} must be releasable`);
  }
  // A press on the middle button in the middle of a left-drag used to replace
  // the standing gesture where it lay - no commit, no cleanup. It is still the
  // pipeline's own bug to fix; what changed is that the machine now says so.
  assert.equal(gestureTransition('move', 'pan'), null);
  assert.equal(gestureTransition('move', 'marquee'), null);
  assert.equal(gestureTransition('marquee', 'move'), null);
  assert.equal(gestureTransition('resize', 'move'), null);
});

test('a gesture cannot be released twice', () => {
  // finishGesture() and abortGesture() both return early when nothing is
  // standing, so the machine is never asked to do this. If it ever is, the pair
  // have drifted apart and something committed a gesture that was already gone.
  assert.equal(gestureTransition('idle', 'idle'), null);
});

test('the machine answers rubbish without throwing', () => {
  // The only caller is a pointer handler. A wedged pointer is a worse failure
  // than a wrong answer, so nothing here may throw - inherited property names
  // included, which is what a bare lookup would have turned into a call on
  // undefined.
  assert.equal(gestureTransition('nonsense', 'pan'), null);
  assert.equal(gestureTransition('idle', 'nonsense'), null);
  assert.equal(gestureTransition('toString', 'pan'), null);
  assert.equal(gestureTransition('idle', 'toString'), null);
  assert.equal(gestureTransition(undefined, undefined), null);
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
  //
  // Compared per unit of delta, over a notch big enough to *be* a zoom. It used
  // to read `pinch.factor > notch.factor || notch.kind === 'pan'` against a
  // notch of -6 - and |6| is under WHEEL_NOTCH, so that notch is classified
  // 'pan' every time and the right-hand disjunct carried the assertion by
  // itself. The pinch rate could have been dropped below the wheel's and this
  // went on passing.
  resetWheelKind();
  const notch = wheel({ deltaY: -240, timeStamp: 9_000 });
  assert.equal(notch.kind, 'zoom', 'the fixture has to clear WHEEL_NOTCH to be a zoom at all');
  const per = (action, dy) => (action.factor - 1) / Math.abs(dy);
  assert.ok(per(pinch, 6) > per(notch, 240),
    `a pinch unit is worth ${per(pinch, 6)} and a wheel unit ${per(notch, 240)} - `
    + 'at the wheel rate a pinch across the whole pad would move almost nothing');

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

// ---------------------------------------------------------------------------
// The two rules that used to be unreachable
//
// resizeAxisOn() and nudgeDelta() were closures inside initInput(), so the
// snap-anchor derivation and the "flush already" branch - the two riskiest
// pieces of arithmetic in the file - had no coverage at all, while every
// trivial predicate around them had plenty. They take their step and seam as
// arguments now, which was the whole of what kept them inside.
// ---------------------------------------------------------------------------

const STEP = 64;
const INSET = cellInset(STEP);

test('an axis the handle does not touch comes back untouched', () => {
  assert.equal(resizeAxisOn(0, 100, 250, 999, true, STEP, INSET), 250);
  assert.equal(resizeAxisOn(0, 100, 250, 999, false, STEP, INSET), 250);
});

test('unsnapped, the extent follows the pointer exactly', () => {
  assert.equal(resizeAxisOn(1, 0, 200, 37, false, STEP, 0), 237);
  assert.equal(resizeAxisOn(-1, 0, 200, 37, false, STEP, 0), 163,
    'dragging the low edge outward shortens by the same travel');
});

test('snapped, it is the moving edge that lands on a grid line', () => {
  // The rule the docstring turns on: the *edge* is quantised, not the extent.
  // A width rounded to the step would leave both edges off the lattice, since
  // the pinned edge was never on it.
  const centre = 100, extent = 150;
  for (const sign of [1, -1]) {
    for (const travel of [-40, -7, 0, 3, 41, 90]) {
      const size = resizeAxisOn(sign, centre, extent, travel, true, STEP, INSET);
      if (size === MIN_SIZE || size === MAX_SIZE) continue;   // clamped, not snapped
      const anchor = centre - sign * extent / 2;
      const edge = anchor + sign * size;
      // The moving edge sits a seam short of its line going one way and a seam
      // past it going the other, which is what the signed bias is for.
      const k = (edge + sign * INSET) / STEP;
      assert.ok(Math.abs(k - Math.round(k)) < 1e-9,
        `sign ${sign} travel ${travel}: the edge landed at ${edge}, off the lattice`);
    }
  }
});

test('the size limits hold even where one step spans the whole band', () => {
  // The closing clamp, and the case it exists for: a step coarser than the
  // range between floor and ceiling leaves no grid line inside it, so the
  // repair by one line cannot land legally and the clamp has to.
  const huge = MAX_SIZE * 4;
  for (const sign of [1, -1]) {
    for (const travel of [-1e6, -100, 100, 1e6]) {
      const size = resizeAxisOn(sign, 0, 200, travel, true, huge, cellInset(huge));
      assert.ok(size >= MIN_SIZE && size <= MAX_SIZE,
        `sign ${sign} travel ${travel} gave ${size}, outside [${MIN_SIZE}, ${MAX_SIZE}]`);
    }
  }
});

test('a resize can never collapse an item or run it past the ceiling', () => {
  for (const sign of [1, -1]) {
    for (const snap of [true, false]) {
      for (const travel of [-1e9, 1e9]) {
        const size = resizeAxisOn(sign, 0, 200, travel, snap, STEP, INSET);
        assert.ok(size >= MIN_SIZE && size <= MAX_SIZE, `${sign} ${snap} ${travel}: ${size}`);
      }
    }
  }
});

test('unsnapped, a bare arrow key moves one unit and shift moves a step', () => {
  const lead = { x: 0, y: 0, w: 100, h: 100 };
  assert.deepEqual(nudgeDelta(1, 0, false, lead, false, STEP, INSET), { dx: 1, dy: 0 });
  assert.deepEqual(nudgeDelta(0, -1, false, lead, false, STEP, INSET), { dx: 0, dy: -1 });
  assert.deepEqual(nudgeDelta(1, 0, true, lead, false, STEP, INSET), { dx: STEP, dy: 0 });
});

test('snapped and already flush, an arrow key moves exactly one cell', () => {
  // The "flush already" branch, and the tolerance it needs: a board's
  // coordinates come out of divisions and accumulated drags, so an item on a
  // line is routinely at 3.9999999 cells rather than 4. Without ON_LINE the
  // next line along is the one it is standing on, which reads as a key that
  // did nothing.
  const low = 4 * STEP + INSET;
  for (const drift of [0, 1e-9, -1e-9]) {
    const lead = { x: low + drift + 50, y: 0, w: 100, h: 100 };
    const { dx } = nudgeDelta(1, 0, false, lead, true, STEP, INSET);
    assert.ok(Math.abs(dx - STEP) < 1e-6, `drift ${drift} moved by ${dx}, not one cell`);
  }
});

test('snapped and adrift, the first press comes aboard rather than overshooting', () => {
  const lead = { x: 4 * STEP + INSET + 20 + 50, y: 0, w: 100, h: 100 };
  const right = nudgeDelta(1, 0, false, lead, true, STEP, INSET);
  const left = nudgeDelta(-1, 0, false, lead, true, STEP, INSET);
  // Right goes to the next line up, left to the one just below - both less than
  // a full cell away, because the item was between them.
  assert.ok(right.dx > 0 && right.dx < STEP, `came aboard by ${right.dx}`);
  assert.ok(left.dx < 0 && left.dx > -STEP, `came aboard by ${left.dx}`);
  // And having come aboard, it is on the lattice.
  const after = lead.x - lead.w / 2 + right.dx;
  const k = (after - INSET) / STEP;
  assert.ok(Math.abs(k - Math.round(k)) < 1e-9, 'the first press did not land on a line');
});

test('shift on a snapped board is a decade of cells, not a step', () => {
  const lead = { x: 4 * STEP + INSET + 50, y: 0, w: 100, h: 100 };
  const { dx } = nudgeDelta(1, 0, true, lead, true, STEP, INSET);
  assert.ok(Math.abs(dx - 10 * STEP) < 1e-6, `shift moved ${dx}, not ten cells`);
});

test('an axis with no direction pressed does not move', () => {
  const lead = { x: 37, y: 91, w: 100, h: 100 };
  assert.deepEqual(nudgeDelta(0, 0, false, lead, true, STEP, INSET), { dx: 0, dy: 0 });
  assert.equal(nudgeDelta(1, 0, false, lead, true, STEP, INSET).dy, 0);
});
