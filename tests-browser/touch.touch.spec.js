// Touch on an emulated phone (the `touch` project): the Feed it boots into,
// and the canvas switched to by hand, with one-finger pans, the tap a card
// needs before it moves, and two-finger pinches including a finger lifted and
// put back mid-pinch. Real touch events through CDP, since Playwright's own
// touchscreen only taps.

import { test, expect, sticker, item, view, toClient, frames } from './harness.js';

/** A CDP touch driver: each call takes a list of points, one per finger down. */
async function fingers(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })),
  });
  return {
    start: points => send('touchStart', points),
    end: () => send('touchEnd', []),
    /** Glide every finger from `from` to `to` in `steps`. */
    async glide(from, to, steps = 10) {
      for (let k = 1; k <= steps; k++) {
        await send('touchMove', from.map((p, i) => ({
          x: p.x + (to[i].x - p.x) * k / steps, y: p.y + (to[i].y - p.y) * k / steps })));
        await frames(page, 1);
      }
    },
  };
}

test('a phone opens on the Feed', async ({ app }) => {
  expect(await app.evaluate(() => window.mbrd.board.layoutMode)).toBe('mobile');
});

test.describe('the canvas on a phone', () => {
  test.beforeEach(async ({ app }) => {
    await app.evaluate(() => window.mbrd.cmds.setBoardMode('desktop'));
    await app.waitForFunction(() => window.mbrd.board.layoutMode === 'desktop');
    await frames(app);
  });

  test('one finger on empty board pans', async ({ app }) => {
    const touch = await fingers(app);
    const before = await view(app);
    const from = { x: 200, y: 600 };
    await touch.start([from]);
    await touch.glide([from], [{ x: 260, y: 500 }]);
    await touch.end();
    await frames(app);
    const after = await view(app);
    expect(after.x).not.toBeCloseTo(before.x, 0);
    expect(after.y).not.toBeCloseTo(before.y, 0);
  });

  test('a card moves under a finger once it has been tapped', async ({ app }) => {
    const id = await sticker(app, 0, -100);
    const at = await toClient(app, 0, -100);
    await app.touchscreen.tap(at.x, at.y);
    await frames(app);
    const touch = await fingers(app);
    await touch.start([at]);
    await touch.glide([at], [{ x: at.x + 60, y: at.y + 40 }]);
    await touch.end();
    await frames(app);
    const moved = await item(app, id);
    expect(moved.x).toBeGreaterThan(10);
  });

  test('two fingers pinch to zoom', async ({ app }) => {
    const touch = await fingers(app);
    const before = await view(app);
    const a = { x: 150, y: 450 };
    const b = { x: 240, y: 450 };
    await touch.start([a, b]);
    await touch.glide([a, b], [{ x: 90, y: 450 }, { x: 300, y: 450 }]);
    await touch.end();
    await app.waitForTimeout(400);
    expect((await view(app)).zoom).toBeGreaterThan(before.zoom * 1.3);
  });

  test('a finger lifted and put back mid-pinch does not throw the view', async ({ app }) => {
    // Synthetic pointer events: CDP cannot lift one finger of two (a shorter
    // point list releases nothing, and a known id only moves).
    const finger = (type, id, x, y) => app.evaluate(([type, id, x, y]) => {
      document.elementFromPoint(x, y).dispatchEvent(new PointerEvent(type, {
        pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y,
        bubbles: true, cancelable: true, composed: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      }));
    }, [type, id, x, y]);
    await finger('pointerdown', 1, 150, 450);
    await finger('pointerdown', 2, 240, 450);
    for (let k = 1; k <= 5; k++) await finger('pointermove', 2, 240 + k * 10, 450);
    await frames(app);
    const mid = await view(app);
    await finger('pointerup', 2, 290, 450);
    await finger('pointerdown', 3, 200, 480);
    await frames(app);
    const back = await view(app);
    // The second finger landing re-seats the pinch; nothing jumps.
    expect(Math.abs(back.zoom - mid.zoom) / mid.zoom).toBeLessThan(0.02);
    expect(Math.abs(back.x - mid.x) * back.zoom).toBeLessThan(2);
    // And the new pair pinches from there.
    await finger('pointermove', 3, 200, 560);
    await frames(app);
    expect((await view(app)).zoom).toBeGreaterThan(back.zoom);
    await finger('pointerup', 3, 200, 560);
    await finger('pointerup', 1, 150, 450);
  });
});
