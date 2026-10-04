import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDoubleTap, needsSelectionBeforeMove, repeatsLongPressContextMenu,
  releasePointerSafely, capturePointerSafely, resizeHandleAction, shortcutsSuppressed,
  liftWithButtonsHeld, readWheel, resetWheelKind, WHEEL_NOTCH, WHEEL_STREAM_MS,
  carryFloor, carryHold, carryPlace, drewRectangle, marqueeHit,
  GESTURE_MOVES, gestureTransition, pressIntent,
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

test('a mouse lift ends the press only when no button is left down', () => {
  const up = (buttons, pointerType = 'mouse') => ({ type: 'pointerup', pointerType, buttons });
  // A right button let go while the left one still drags: not an end.
  assert.equal(liftWithButtonsHeld(up(1)), true);
  // A chord whose last release is the right or an aux button: nothing is held,
  // so this lift ends the drag, whatever `button` it reports.
  assert.equal(liftWithButtonsHeld(up(0)), false);
  assert.equal(liftWithButtonsHeld(up(4, 'pen')), true);
  // A finger and a cancel always end what they had.
  assert.equal(liftWithButtonsHeld(up(1, 'touch')), false);
  assert.equal(liftWithButtonsHeld({ type: 'pointercancel', pointerType: 'mouse', buttons: 1 }), false);
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

// A fence keeps cards at the same fraction of the region until a wall reaches
// one, and then the wall pushes it. carryPlace() is where a card goes;
// carryFloor() is where the region stops shrinking.

const BOX = { x: 0, y: 0, w: 1000, h: 1000, plate: 0 };
const hold = (card, box = BOX) => carryHold({ rot: 0, ...card }, box);

test('a region with nothing in it has no floor', () => {
  assert.deepEqual(carryFloor(BOX, []), { w: 0, h: 0 });
  assert.deepEqual(carryFloor(BOX, null), { w: 0, h: 0 });
});

test('a card keeps its fraction of the box until a wall reaches it', () => {
  const h = hold({ x: 250, y: 0, w: 200, h: 100 });
  // Halved from the west: the fraction alone puts it at 125 + 0, inside.
  assert.deepEqual(carryPlace({ x: 250, y: 0, w: 500, h: 1000, plate: 0 }, h), { x: 375, y: 0 });
  // Pulled in from the west to 800 wide: the fraction puts it at 300, still clear.
  assert.deepEqual(carryPlace({ x: 100, y: 0, w: 800, h: 1000, plate: 0 }, h), { x: 300, y: 0 });
  // Squeezed to 300 wide on the right: pushed to 400 - 100 by the east wall.
  assert.deepEqual(carryPlace({ x: 350, y: 0, w: 300, h: 1000, plate: 0 }, h), { x: 400, y: 0 });
});

test('a pushed card goes back to its spot when the wall moves away', () => {
  const h = hold({ x: 400, y: 0, w: 100, h: 100 });
  const squeezed = carryPlace({ x: 0, y: 0, w: 400, h: 1000, plate: 0 }, h);
  assert.equal(squeezed.x, 150);              // pushed off its 160 by the wall at 200
  // The same grip, the wall back out where it was: the card is where it began.
  assert.deepEqual(carryPlace(BOX, h), { x: 400, y: 0 });
});

test('the top wall is the underside of the name plate', () => {
  const box = { ...BOX, plate: 60 };
  const h = hold({ x: 0, y: 380, w: 100, h: 100 }, box);
  // Pulling the bottom edge up to 800 tall: the fraction says 404, but the
  // plate's underside is still at 500 - 60, so it rests at 390.
  assert.deepEqual(carryPlace({ x: 0, y: 100, w: 1000, h: 800, plate: 60 }, h), { x: 0, y: 390 });
});

test('a card that already hung out keeps hanging out by as much, never jumping', () => {
  const h = hold({ x: 480, y: 0, w: 100, h: 100 });
  assert.equal(h.out.e, 30);
  assert.deepEqual(carryPlace(BOX, h), { x: 480, y: 0 });
});

test('the floor is the largest card, with the plate on top, capped at the start', () => {
  const holds = [hold({ x: 0, y: 0, w: 300, h: 100 }), hold({ x: 200, y: 200, w: 100, h: 250 })];
  assert.deepEqual(carryFloor({ ...BOX, plate: 40 }, holds), { w: 300, h: 290 });
  // A card bigger than the region asks for no growth.
  assert.deepEqual(carryFloor({ ...BOX, w: 200 }, holds).w, 200);
});

// A band catches a card by overlap but a fence only by covering it - one rule
// for both meant every band drawn inside a region also caught the region.

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
// "Exactly one gesture is active at a time" is what input.ts exists to
// protect; it used to rest on every branch of a giant pointerdown/pointermove
// remembering to keep it. A runner cannot press a pointer, so this checks the
// transition rule those branches follow instead - the illegal cases matter
// more than the legal ones, since a bag of booleans had no opinion on them.

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
  // A grip press waits until the pointer travels, which keeps a plain tap on
  // a corner from touching snapped geometry - so `resize` always goes through
  // `press`.
  assert.equal(gestureTransition('press', 'resize'), 'resize');
  assert.equal(gestureTransition('idle', 'resize'), null);
  assert.equal(gestureTransition('move', 'resize'), null);
  assert.equal(gestureTransition('pan', 'resize'), null);
});

test('a waiting press becomes the band or the resize, and nothing else', () => {
  // The two intents `press` carries: a grip, or the second tap of a
  // double-tap. Neither can turn into a pan or a move.
  assert.equal(gestureTransition('press', 'marquee'), 'marquee');
  assert.equal(gestureTransition('press', 'pan'), null);
  assert.equal(gestureTransition('press', 'move'), null);
  assert.equal(gestureTransition('press', 'pinch'), null);
});

test('a second finger drops the gesture rather than converting it', () => {
  // "A second finger always wins": the drag aborts uncommitted and the pinch
  // enters from idle, rather than converting a pan straight into a pinch and
  // leaving its geometry neither committed nor put back.
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
  // A middle-button press mid-drag used to replace the standing gesture in
  // place, with no commit or cleanup - still the pipeline's bug, but the
  // machine now says so.
  assert.equal(gestureTransition('move', 'pan'), null);
  assert.equal(gestureTransition('move', 'marquee'), null);
  assert.equal(gestureTransition('marquee', 'move'), null);
  assert.equal(gestureTransition('resize', 'move'), null);
});

test('a gesture cannot be released twice', () => {
  // finishGesture()/abortGesture() both return early with nothing standing,
  // so the machine is never asked this. If it is, they've drifted apart.
  assert.equal(gestureTransition('idle', 'idle'), null);
});

test('the machine answers rubbish without throwing', () => {
  // A wedged pointer is worse than a wrong answer, so nothing here may throw
  // - including on inherited property names, which a bare lookup would turn
  // into a call on undefined.
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

test('taking capture survives a pointer that has already gone', () => {
  // setPointerCapture() throws NotFoundError for a pointer that left the
  // glass between the event queuing and the handler running; called bare,
  // that race threw out of pointerdown before the gesture was entered,
  // leaving a press that selected a card and then did nothing.
  const gone = {
    setPointerCapture: () => { throw new DOMException('Invalid pointer id', 'NotFoundError'); },
  };
  assert.equal(capturePointerSafely(gone, 7), false);
  assert.equal(capturePointerSafely(null, 7), false);
  assert.equal(capturePointerSafely({}, 7), false);

  let asked = null;
  assert.equal(capturePointerSafely({ setPointerCapture: id => { asked = id; } }, 9), true);
  assert.equal(asked, 9);

  // A failure that isn't the race is still a failure - same line
  // releasePointerSafely() draws, so the two can't drift.
  assert.throws(() => capturePointerSafely({
    setPointerCapture: () => { throw new TypeError('not a DOMException'); },
  }, 7), TypeError);
});

test('every pointer the pipeline tracks is one it can take capture of', async () => {
  // The pinch leak: onDown returned for `pointers.size === 2` before the line
  // that takes capture, so only the first finger was ever captured. Lift the
  // second finger over the toolbar or window edge and its pointerup missed
  // #viewport, so endPointer never ran and the id stayed in `pointers`
  // forever - every later single-finger press then entered a phantom pinch.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/assets/js/canvas/input.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  assert.ok(!/\bel\.setPointerCapture\(/.test(src),
    'input.ts takes capture directly again - use capturePointerSafely()');
  // One per branch that returns before the shared line: the two-finger pinch,
  // the third finger, and the ordinary press.
  const takes = src.match(/capturePointerSafely\(el,/g) || [];
  assert.ok(takes.length >= 3,
    `only ${takes.length} capture sites - a branch that adds to \`pointers\` and returns early is leaking again`);
});

test('a drag with nothing to carry is not entered at all', async () => {
  // The wedge: a pinned sticker on a locked photo passed the press check as
  // unlocked, then startMove()'s filters resolved it to its locked host and
  // dropped it - `origin` came out empty, and the first move past the slop
  // threw on `lead.x`, wedging the pipeline until the button came up.
  //
  // Read off the source since the pipeline is a closure over #viewport with
  // no browser here. Asserts the shape of the repair: startMove() may answer
  // "nothing to take hold of", and the press branch checks for it.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/assets/js/canvas/input.ts', import.meta.url), 'utf8');
  assert.match(src, /function startMove\([^)]*\): MoveGesture \| null/,
    'startMove() can no longer say there is nothing to pick up');
  assert.match(src, /if \(!before\.length\) return null;/,
    'startMove() builds a gesture out of an empty snapshot again');
  // The id's local name isn't the point (it's `cardId` in the cascade now) -
  // what matters is that the call's result is checked.
  assert.match(src, /const move = startMove\(e, \w+\);[\s\S]{0,400}?if \(!move\) startPan\(e\);/,
    'the press branch stopped checking whether startMove() found anything');
});

// ---------------------------------------------------------------------------
// Telling a touchpad from a mouse wheel
// ---------------------------------------------------------------------------
//
// One event, two devices, opposite meanings - a heuristic, so its cases are
// written down rather than trusted. `at` (the event's timeStamp) matters as
// much as the deltas: the answer latches for a burst, so a fast swipe isn't
// re-read as a wheel halfway through.

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
  // The case this was written for: a laptop swipe used to zoom the board,
  // throwing away its sideways half entirely.
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
  // A swipe starts slow, so its first event reads as a pad. What follows can
  // be as fast as any wheel notch and must not be re-read, or the board
  // zooms mid-scroll.
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

  // Compared per unit of delta, over a notch big enough to be a zoom. A past
  // version compared against a notch of -6, under WHEEL_NOTCH, so that notch
  // always classified 'pan' and the assertion passed on the wrong disjunct
  // even if the pinch rate had dropped below the wheel's.
  resetWheelKind();
  const notch = wheel({ deltaY: -240, timeStamp: 9_000 });
  assert.equal(notch.kind, 'zoom', 'the fixture has to clear WHEEL_NOTCH to be a zoom at all');
  const per = (action, dy) => (action.factor - 1) / Math.abs(dy);
  assert.ok(per(pinch, 6) > per(notch, 240),
    `a pinch unit is worth ${per(pinch, 6)} and a wheel unit ${per(notch, 240)} - `
    + 'at the wheel rate a pinch across the whole pad would move almost nothing');

  // A pinch does not latch: it also looks like ctrl+wheel on a real mouse,
  // and a modifier must not change what the next plain notch means.
  resetWheelKind();
  wheel({ deltaY: -6, ctrlKey: true, timeStamp: 1_000 });
  assert.equal(wheel({ deltaY: 100, timeStamp: 1_020 }).kind, 'zoom');
});

test('Control held on the keyboard pans up and down, where a pinch zooms', () => {
  // ctrlKey arrives on both. The third argument is the Control key the page
  // saw pressed, which a pinch never sends.
  const held = (props = {}) => readWheel({
    deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: true, shiftKey: false, timeStamp: 0, ...props,
  }, 800, true);
  const notch = held({ deltaY: 100, timeStamp: 1_000 });
  assert.deepEqual([notch.kind, notch.dx, notch.dy, notch.factor], ['pan', 0, 100, 1],
    'a wheel notch with Control down moves the board down, and zooms nothing');
  resetWheelKind();
  assert.equal(held({ deltaY: 3, deltaMode: 1, timeStamp: 5_000 }).dy, 48, 'Firefox counts in lines');
  resetWheelKind();
  assert.equal(held({ deltaX: 30, timeStamp: 7_000 }).dy, 30, 'a sideways delta goes onto the vertical');

  // The same event with no key down is a pinch.
  resetWheelKind();
  assert.equal(wheel({ deltaY: 100, ctrlKey: true, timeStamp: 9_000 }).kind, 'zoom');

  // And it leaves the device alone: the next plain notch is a zoom.
  resetWheelKind();
  held({ deltaY: 100, timeStamp: 11_000 });
  assert.equal(wheel({ deltaY: 100, timeStamp: 11_020 }).kind, 'zoom');
});

// ---------------------------------------------------------------------------
// The two preferences (controls.ts), read at the end of the same pipeline
// ---------------------------------------------------------------------------

// `held` is the Control key the page saw pressed, the third argument - which a
// pinch never sends and a person choosing Ctrl+wheel always does.
const prefWheel = (prefs, props = {}, held = false) => readWheel({
  deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, shiftKey: false, timeStamp: 0, ...props,
}, 800, held, prefs);

test('reversing the zoom turns a notch round and leaves a pinch alone', () => {
  const REVERSE = { mode: 'zoom', reverse: true };
  // Down the page zooms *in* once it is reversed - the one thing the
  // preference is for.
  assert.ok(prefWheel(REVERSE, { deltaY: 100 }).factor > 1);
  resetWheelKind();
  assert.ok(prefWheel(REVERSE, { deltaY: -100, timeStamp: 5_000 }).factor < 1);

  // A pinch is a fact about the hand, not a convention: fingers apart is
  // closer in whatever the wheel has been set to.
  resetWheelKind();
  const pinch = prefWheel(REVERSE, { deltaY: -6, ctrlKey: true, timeStamp: 9_000 });
  assert.equal(pinch.kind, 'zoom');
  assert.ok(pinch.factor > 1, 'the pinch must not be reversed with the wheel');
});

test('in scroll mode a notch pans and Control is what zooms', () => {
  const SCROLL = { mode: 'scroll', reverse: false };
  const notch = prefWheel(SCROLL, { deltaY: 100 });
  assert.deepEqual([notch.kind, notch.dx, notch.dy, notch.factor], ['pan', 0, 100, 1],
    'the notch that zooms by default moves the board instead');

  // Control held on the keyboard - which in the default mode pans up and down.
  resetWheelKind();
  const zoomed = prefWheel(SCROLL, { deltaY: 100, ctrlKey: true, timeStamp: 5_000 }, true);
  assert.equal(zoomed.kind, 'zoom');
  assert.ok(zoomed.factor < 1, 'down the page is still out');

  // A pad keeps its own gesture in both modes: a swipe pans, in both axes.
  resetWheelKind();
  const swipe = prefWheel(SCROLL, { deltaX: -8, deltaY: 6, timeStamp: 9_000 });
  assert.equal(swipe.kind, 'pan');
  assert.deepEqual([swipe.dx, swipe.dy], [-8, 6]);

  // And a pinch still zooms, at the pinch's own rate - the mode changes what a
  // wheel means, never what fingers mean.
  resetWheelKind();
  assert.ok(prefWheel(SCROLL, { deltaY: -6, ctrlKey: true, timeStamp: 13_000 }).factor > 1);
});

test('the two preferences compose, and a pad zoom under Control is not read at the wheel rate', () => {
  // Reversed *and* in scroll mode: Control down the page zooms in.
  const both = { mode: 'scroll', reverse: true };
  assert.ok(prefWheel(both, { deltaY: 100, ctrlKey: true }, true).factor > 1);

  // A pad burst with Control genuinely held reads as 'pan' by device, so the
  // zoom it is asked for takes the pinch coefficient. At the wheel's, six
  // pixels of finger travel would move the board by nothing anybody could see.
  resetWheelKind();
  const pad = prefWheel({ mode: 'scroll', reverse: false },
    { deltaY: -6, ctrlKey: true, timeStamp: 5_000 }, true);
  assert.equal(pad.kind, 'zoom');
  assert.ok(pad.factor > 1.05, `a pad pinch-by-Control moved by ${pad.factor}`);
});

test('always-zoom makes every plain scroll a zoom, and leaves the explicit gestures alone', () => {
  const ALL = { mode: 'zoom-all', reverse: false };
  // A swipe that would have panned, fractions and sideways and all.
  const swipe = prefWheel(ALL, { deltaX: -8, deltaY: 6.625 });
  assert.equal(swipe.kind, 'zoom');
  assert.ok(swipe.factor < 1, 'down the page is still out');

  // Shift still pans across, Control held still pans down, a pinch still zooms.
  resetWheelKind();
  assert.equal(prefWheel(ALL, { deltaY: 12, shiftKey: true, timeStamp: 5_000 }).kind, 'pan');
  resetWheelKind();
  assert.equal(prefWheel(ALL, { deltaY: 100, ctrlKey: true, timeStamp: 9_000 }, true).kind, 'pan');
  resetWheelKind();
  assert.ok(prefWheel(ALL, { deltaY: -6, ctrlKey: true, timeStamp: 13_000 }).factor > 1);
});

// ---------------------------------------------------------------------------
// The hi-res wheel on Linux: one detent as several identical fractional deltas
// (research/old/linux-wheel-2026-09-20.md). The shape is reasoned, not recorded.
// ---------------------------------------------------------------------------

function burst(deltas, gap = 2) {
  resetWheelKind();
  return deltas.map((deltaY, i) => wheel({ deltaY, timeStamp: 1_000 + i * gap }));
}

test('a hi-res detent is taken back from the pad and zoomed', () => {
  // 53px a detent, in eighths: 6.625 each.
  const out = burst(times(8, 6.625));
  const first = out.findIndex(w => w.kind === 'zoom');
  assert.equal(first, 6, 'it turns on the event that carries it past a notch');
  assert.ok(out.slice(0, first).every(w => w.kind === 'pan'), 'a pad until then');
  assert.deepEqual(out[first].undo, { dx: 0, dy: 6.625 * 6 },
    'and exactly what it panned is handed back');
  assert.ok(Math.abs(out[first].factor - Math.exp(-6.625 * 7 * 0.0016)) < 1e-12,
    'the zoom is the whole detent so far, not the last eighth');
  assert.equal(out[7].kind, 'zoom', 'the rest of the burst stays a wheel');
  assert.equal(out[7].undo, undefined, 'and hands nothing back twice');
});

test('a swipe summing to the same distance in varying steps still pans', () => {
  // The guard doing its job: a finger never repeats a fractional delta exactly.
  const out = burst([5.5, 6.25, 6.75, 7, 6.5, 7.25, 7.5, 6.25]);
  assert.ok(out.every(w => w.kind === 'pan'));
  assert.ok(out.every(w => w.undo === undefined));
});

test('a detent is not read into a slow burst, a sideways one, or a single event', () => {
  assert.ok(burst(times(8, 6.625), 8).every(w => w.kind === 'pan'), 'too slow to be one detent');
  resetWheelKind();
  wheel({ deltaX: 1, deltaY: 6.625, timeStamp: 1_000 });
  for (let i = 1; i < 8; i++) {
    assert.equal(wheel({ deltaY: 6.625, timeStamp: 1_000 + i * 2 }).kind, 'pan', 'moved sideways once');
  }
  assert.ok(burst([WHEEL_NOTCH - 0.5]).every(w => w.kind === 'pan'), 'one event proves nothing');
});

test('in scroll mode a recognised detent keeps panning, with nothing to undo', () => {
  resetWheelKind();
  const SCROLL = { mode: 'scroll', reverse: false };
  const out = times(8, 6.625).map((deltaY, i) => prefWheel(SCROLL, { deltaY, timeStamp: 1_000 + i * 2 }));
  assert.ok(out.every(w => w.kind === 'pan' && w.undo === undefined));
});

test('one enormous delta zooms no more than a notch and a little', () => {
  // An unfocused window's notches, coalesced into one event.
  const w = wheel({ deltaY: -1_000 });
  assert.equal(w.kind, 'zoom');
  assert.ok(w.factor <= 1.25, `zoomed ${w.factor}x in one event`);
});

// A swipe, as a burst of events a few milliseconds apart - the lean is
// measured over a gesture, not one event. Returns the last event's result.
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
  // Recorded case: a curved downward swipe arrived as 5257px vertical against
  // 973px sideways, four events in five carrying no sideways at all - the
  // platform reported a fifth of what the fingers actually did.
  const out = swipe([...times(40, [0, 15]), [13, 15]]);
  assert.equal(out.kind, 'pan');
  assert.ok(out.dx > 13 * 2, `a withheld sideways step is lifted, got ${out.dx}`);
  assert.equal(out.dy, 15, 'and the axis carrying the swipe is left exactly alone');
});

test('a swipe delivered whole is left alone, however lopsided', () => {
  // Two swipes the platform reports faithfully in both axes - one even, one
  // lopsided - and the measure must leave both alone. Reading lopsidedness
  // itself as evidence of withholding used to multiply a sideways flick's
  // little drift by nearly three and slide the board out from under it.
  const even = swipe(times(40, [19, 13]));
  assert.deepEqual([even.dx, even.dy], [19, 13]);

  const flick = swipe(times(36, [22, 1.5]));
  assert.deepEqual([flick.dx, flick.dy], [22, 1.5]);
});

test('a swipe the platform railed outright cannot be rescued', () => {
  // Straight sideways reports vertical as exactly zero, and no multiple of
  // zero is a lean - the limit of what this can do. Shift is the answer.
  const out = swipe(times(30, [25, 0]));
  assert.equal(out.dy, 0);
  assert.equal(out.dx, 25, 'the axis that did arrive is not amplified either');
});

test('nothing is lifted on the strength of one event', () => {
  // Both measures start out saying "delivered whole", so evidence of a rail
  // must accumulate - a swipe's opening is where it's thinnest.
  const first = swipe([[0, 15]]);
  assert.deepEqual([first.dx, first.dy], [0, 15]);
  const second = swipe([[0, 15], [4, 15]]);
  assert.ok(second.dx < 4 * 1.5, `barely touched this early, got ${second.dx}`);
});

test('a lump released in one event is not multiplied into a jerk', () => {
  // Needs no cap: a delta the driver held back raises its own axis's measure
  // as it lands, taking the lift off the very event that would have jerked.
  const lump = swipe([...times(40, [0, 15]), [48, 15]]);
  const trickle = swipe([...times(40, [0, 15]), [6, 15]]);
  assert.ok(lump.dx >= 48, 'never less than the platform reported');
  assert.ok(lump.dx / 48 < trickle.dx / 6,
    `the lump is lifted proportionally less than the trickle, ${lump.dx} vs ${trickle.dx}`);
});

test('the lean is measured over a burst and forgotten with it', () => {
  // A gesture, then a pause, then a gesture the other way. Carrying the first
  // one's shape into the second lifts the wrong axis until the measure
  // catches up.
  //
  // Lopsided on purpose: an even 20-by-20 fixture passed on a tie, since
  // `axisX < axisY` is false either way and never exercised the presence
  // measures a rail drives to near zero. One unit of difference is enough to
  // name a minor axis and see them.
  swipe(times(40, [0, 15]));
  const later = wheel({ deltaX: 20, deltaY: 21, timeStamp: 90_000 });
  assert.deepEqual([later.dx, later.dy], [20, 21], 'the new swipe starts even');
});

test('shift is the way across a railed pad, from either device', () => {
  // The platform decides which axis you meant at the start of a two-finger
  // swipe and suppresses the other until you lift, so a gesture starting
  // straight down reports deltaX of exactly zero forever. Shift moves the
  // whole delta onto the horizontal - the one way across from inside the rail.
  const railed = wheel({ deltaY: 12, shiftKey: true });
  assert.equal(railed.kind, 'pan');
  assert.deepEqual([railed.dx, railed.dy], [12, 0]);

  // Some browsers do the swap themselves; doing it twice would undo it.
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
  // Shift overrides what a wheel event does, applied after the device is
  // decided, not as part of deciding it - latching it would keep panning the
  // board after the key was released.
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
// riskiest arithmetic in the file had no coverage while trivial predicates
// around it had plenty. Taking step and seam as arguments is what freed them.
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
  // The edge is quantised, not the extent - rounding the width would leave
  // both edges off the lattice, since the pinned edge was never on it.
  const centre = 100, extent = 150;
  for (const sign of [1, -1]) {
    for (const travel of [-40, -7, 0, 3, 41, 90]) {
      const size = resizeAxisOn(sign, centre, extent, travel, true, STEP, INSET);
      if (size === MIN_SIZE || size === MAX_SIZE) continue;   // clamped, not snapped
      const anchor = centre - sign * extent / 2;
      const edge = anchor + sign * size;
      // The moving edge sits a seam short of its line one way and a seam
      // past it the other - what the signed bias is for.
      const k = (edge + sign * INSET) / STEP;
      assert.ok(Math.abs(k - Math.round(k)) < 1e-9,
        `sign ${sign} travel ${travel}: the edge landed at ${edge}, off the lattice`);
    }
  }
});

test('the size limits hold even where one step spans the whole band', () => {
  // The case the closing clamp exists for: a step coarser than the
  // floor-to-ceiling range leaves no grid line to land on legally.
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
  // The "flush already" branch's tolerance: board coordinates come from
  // divisions and accumulated drags, so an item on a line is routinely at
  // 3.9999999 cells rather than 4. Without ON_LINE the key reads as a no-op.
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
  // Right goes to the next line up, left to the one just below - both under a
  // full cell, since the item was between them.
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

// ---------------------------------------------------------------------------
// What a press means
// ---------------------------------------------------------------------------
//
// The eight branches of the pointerdown cascade. Before pressIntent() existed
// the decision was interleaved with the select, capture and enter() each
// branch performs, so the only way to know what a press does was to press
// one. Every case below comes from that handler's own comments.

/** A press on bare board with a mouse, nothing held, nothing selected. */
const press = (over = {}) => ({
  pointerType: 'mouse',
  button: 0,
  additive: false,
  spaceDown: false,
  onWidget: false,
  onGrip: false,
  onCard: null,
  locked: false,
  pinned: false,
  needsTapFirst: false,
  wasSelected: false,
  selectionSize: 0,
  doubleTapDrag: false,
  isMobile: false,
  touring: false,
  viewOnly: false,
  ...over,
});

test('every press pans while the Timeline plays', () => {
  // The board is read-only then, and pan and zoom are all it keeps: a card, a
  // grip, a control in a card and a modified press all pan.
  const pan = { kind: 'pan', middle: false };
  assert.deepEqual(pressIntent(press({ viewOnly: true })), pan);
  assert.deepEqual(pressIntent(press({ viewOnly: true, onCard: 'a', wasSelected: true })), pan);
  assert.deepEqual(
    pressIntent(press({ viewOnly: true, onCard: 'a', onGrip: true, wasSelected: true, selectionSize: 1 })), pan);
  assert.deepEqual(pressIntent(press({ viewOnly: true, onCard: 'a', onWidget: true })), pan);
  assert.deepEqual(pressIntent(press({ viewOnly: true, additive: true })), pan);
  assert.deepEqual(pressIntent(press({ viewOnly: true, doubleTapDrag: true, pointerType: 'touch' })), pan);
  assert.deepEqual(pressIntent(press({ viewOnly: true, button: 1 })), { kind: 'pan', middle: true });
});

test('a press on bare board clears and pans; a modified one bands', () => {
  assert.deepEqual(pressIntent(press()), { kind: 'empty' });
  assert.deepEqual(pressIntent(press({ additive: true })), { kind: 'marquee' });
});

test('a widget inside a card owns the press, unless the press means pan', () => {
  // Capturing on a scrubber would redirect every following move to #viewport
  // and leave the scrubber dead.
  assert.deepEqual(pressIntent(press({ onWidget: true, onCard: 'a' })), { kind: 'widget' });
  // Space and the middle button mean pan from anywhere, including from over one.
  assert.deepEqual(pressIntent(press({ onWidget: true, spaceDown: true })),
    { kind: 'pan', middle: false });
  assert.deepEqual(pressIntent(press({ onWidget: true, button: 1 })),
    { kind: 'pan', middle: true });
});

test('nothing on the board moves or pans while a tour is running', () => {
  // The board is being shown, not worked on: a nudged photo during a
  // presentation is a mistake that gets saved.
  assert.deepEqual(pressIntent(press({ touring: true, onCard: 'a' })), { kind: 'frozen' });
  // Including by its corners - grips still on screen from before the tour
  // started must not resize it either.
  assert.deepEqual(
    pressIntent(press({ touring: true, onCard: 'a', onGrip: true, wasSelected: true, selectionSize: 1 })),
    { kind: 'frozen' });
  // And including under a finger, which would otherwise take the two-step gate.
  assert.deepEqual(
    pressIntent(press({ touring: true, onCard: 'a', pointerType: 'touch', needsTapFirst: true })),
    { kind: 'frozen' });
  // Space and the middle button drive the board, so the freeze is above them
  // too - unlike the widget branch, which is above the freeze.
  assert.deepEqual(pressIntent(press({ touring: true, onCard: 'a', spaceDown: true })),
    { kind: 'frozen' });
  assert.deepEqual(pressIntent(press({ touring: true, button: 1 })), { kind: 'frozen' });
  assert.deepEqual(pressIntent(press({ touring: true, onCard: 'a', onWidget: true })),
    { kind: 'widget' });
  // Bare board is frozen too; that press still walks the tour on, but is
  // answered on the lift (tourClick in input.ts), and no longer pans.
  assert.deepEqual(pressIntent(press({ touring: true })), { kind: 'frozen' });
  assert.deepEqual(pressIntent(press({ touring: true, additive: true })), { kind: 'frozen' });
});

test('a grip is a resize only with one card picked or none', () => {
  const grip = { onGrip: true, onCard: 'a', wasSelected: true };
  assert.deepEqual(pressIntent(press({ ...grip, selectionSize: 1 })),
    { kind: 'resize', id: 'a' });
  assert.deepEqual(pressIntent(press({ ...grip, selectionSize: 0 })),
    { kind: 'resize', id: 'a' });
  // With more than one selected it's not a resize at all - a corner drag has
  // no defined meaning across a selection, so it just picks it up.
  assert.deepEqual(pressIntent(press({ ...grip, selectionSize: 2 })),
    { kind: 'move', id: 'a', additive: false, wasSelected: true });
});

test('a locked card has no grips and does not move', () => {
  // It still selects - menu, name, colour and unlock are one click away.
  // Only the grab is gone; the press pans as bare board does.
  assert.deepEqual(
    pressIntent(press({ onCard: 'a', locked: true, onGrip: true, wasSelected: true })),
    { kind: 'lockedPan', id: 'a', additive: false, wasSelected: true },
  );
});

test('a pinned sticky has no grips, and a press on one takes its host', () => {
  // Its size is the card it's fixed to, so the grip press isn't a resize -
  // it falls through to the move below and takes hold of the host
  // (dragRoot, sticky.ts). Not lockedPan: a pinned sticky moves with its host.
  assert.deepEqual(
    pressIntent(press({ onCard: 'a', pinned: true, onGrip: true, wasSelected: true })),
    { kind: 'move', id: 'a', additive: false, wasSelected: true },
  );
  // And the two refusals do not collapse into one: a locked card still pans.
  assert.deepEqual(
    pressIntent(press({ onCard: 'a', pinned: true, locked: true, onGrip: true })),
    { kind: 'lockedPan', id: 'a', additive: false, wasSelected: false },
  );
});

test('an unpicked card is the two-step gate under a finger and on Mobile', () => {
  const unpicked = { onCard: 'a', needsTapFirst: true };
  // A finger navigates more than it drags, so this pans now, selects on lift.
  assert.deepEqual(pressIntent(press({ ...unpicked, pointerType: 'touch' })),
    { kind: 'tapGate', id: 'a', additive: false });
  // The Mobile board is scrolled far more than it's rearranged, whatever the
  // pointer is.
  assert.deepEqual(pressIntent(press({ ...unpicked, isMobile: true })),
    { kind: 'tapGate', id: 'a', additive: false });
  // A mouse on the Desktop board has no such tension: a left press is a grab.
  assert.deepEqual(pressIntent(press(unpicked)),
    { kind: 'move', id: 'a', additive: false, wasSelected: false });
});

test('a picked card moves under a finger without the gate', () => {
  assert.deepEqual(
    pressIntent(press({ onCard: 'a', pointerType: 'touch', wasSelected: true })),
    { kind: 'move', id: 'a', additive: false, wasSelected: true },
  );
});

test('the second tap of a touch double tap is a band, not a pan', () => {
  assert.deepEqual(pressIntent(press({ pointerType: 'touch', doubleTapDrag: true })),
    { kind: 'marqueeDrag' });
  // But a grip still wins it - the cascade decides corners before double taps.
  assert.deepEqual(
    pressIntent(press({ doubleTapDrag: true, onGrip: true, onCard: 'a' })),
    { kind: 'resize', id: 'a' },
  );
});

test('what the lift needs to tell a selection edit from a pick is carried', () => {
  // `additive`/`wasSelected` let endPointer() decide whether a modified press
  // that didn't move should drop the card again.
  assert.deepEqual(
    pressIntent(press({ onCard: 'a', additive: true, wasSelected: true })),
    { kind: 'move', id: 'a', additive: true, wasSelected: true },
  );
});

test('space beats every branch below it', () => {
  // "middle-drag or space+drag ... pan, from anywhere" - the gesture map at
  // the head of the module.
  for (const over of [
    { onCard: 'a' }, { onGrip: true, onCard: 'a' }, { onCard: 'a', needsTapFirst: true },
    { doubleTapDrag: true }, { additive: true }, { onCard: 'a', locked: true },
  ]) {
    assert.equal(pressIntent(press({ ...over, spaceDown: true })).kind, 'pan',
      `space did not win over ${JSON.stringify(over)}`);
  }
});
