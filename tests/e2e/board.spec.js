// The four flows the unit suite structurally cannot see.
//
// Every case here goes through `window.mbrd`, the console handle main.js
// exposes deliberately (`mbrd.board`, `mbrd.vp`, `mbrd.cmds`). That is not a
// test back door - it is a shipped feature, and using it here means these
// assertions read the same state a person poking at the console would.
//
// What is deliberately NOT asserted: pixels. A screenshot diff of a board whose
// whole point is a hand-tuned look would fail on every palette change and teach
// everyone to ignore it. These assert behaviour - the view moved, the item
// exists, the board came back - and leave the look to eyes.

import { test, expect } from '@playwright/test';

/** The app is up once the boot cover has gone and the console handle exists. */
async function ready(page) {
  await page.goto('/');
  await page.waitForFunction(() => !!window.mbrd?.vp, null, { timeout: 15_000 });
  // The splash removes itself a frame after the board is drawn.
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 10_000 });
}

test.describe('the canvas', () => {
  test('pans with a drag on empty space and zooms with the wheel', async ({ page }) => {
    await ready(page);

    const before = await page.evaluate(() => ({ ...window.mbrd.vp.pan, zoom: window.mbrd.vp.zoom }));

    // Middle-drag, which pans from anywhere - see the gesture map at the top of
    // canvas/input.js. A left-drag would be the more obvious gesture and is the
    // wrong one to write here: a fresh board opens with the title card and the
    // three hint cards around the origin, so a left-drag from the middle of the
    // viewport grabs a card and moves *it*, which is correct behaviour and not
    // what this case is about.
    const box = await page.locator('#viewport').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(box.x + box.width / 2 - 160, box.y + box.height / 2 - 90, { steps: 12 });
    await page.mouse.up({ button: 'middle' });

    const panned = await page.evaluate(() => ({ ...window.mbrd.vp.pan }));
    expect(panned.x).not.toBeCloseTo(before.x, 1);

    // Wheel zoom is to the cursor, so the zoom must change and the view with it.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(400);          // the zoom animates
    const zoomed = await page.evaluate(() => window.mbrd.vp.zoom);
    expect(zoomed).toBeGreaterThan(before.zoom);
  });

  test('a note can be added, selected and deleted, and undo brings it back', async ({ page }) => {
    await ready(page);

    // By id, not by count, and that is the point of writing it this way: the
    // first thing of the user's to land on a blank board sweeps the three hint
    // cards with it (dismissGhosts, canvas/ghosts.js), so the board gets
    // *smaller* on the add. Counting would assert the scaffolding, not the note.
    const id = await page.evaluate(() => window.mbrd.cmds.addNote()?.id
      ?? window.mbrd.board.items[window.mbrd.board.items.length - 1].id);
    await expect
      .poll(() => page.evaluate(i => !!window.mbrd.board.items.find(x => x.id === i), id))
      .toBe(true);
    // And the hints are gone, which is the behaviour the count would have hidden.
    await expect
      .poll(() => page.evaluate(() => window.mbrd.board.items.some(i => i.type === 'ghost')))
      .toBe(false);

    await page.evaluate(i => window.mbrd.cmds.selectAll() || i, id);
    await page.evaluate(() => window.mbrd.cmds.deleteSelection());
    await expect
      .poll(() => page.evaluate(i => !!window.mbrd.board.items.find(x => x.id === i), id))
      .toBe(false);

    // Undo is a stack of commands, each carrying its own inverse - so the item
    // comes back with its id, not as a fresh one.
    await page.evaluate(() => window.mbrd.cmds.undo());
    await expect
      .poll(() => page.evaluate(i => !!window.mbrd.board.items.find(x => x.id === i), id))
      .toBe(true);
  });
});

test.describe('storage', () => {
  test('a board survives a refresh through IndexedDB', async ({ page }) => {
    await ready(page);

    // Something identifiable, then let the autosave land.
    const title = 'e2e-' + (await page.evaluate(() => window.mbrd.board.items.length));
    await page.evaluate(t => {
      window.mbrd.cmds.addNote();
      window.mbrd.board.title = t;
      window.mbrd.bus.emit('board');
    }, title);
    const count = await page.evaluate(() => window.mbrd.board.items.length);

    // autosave() is the same call the pagehide handler makes.
    await page.evaluate(() => window.mbrd.board && window.mbrd.cmds.save?.());
    await page.waitForTimeout(500);

    await page.reload();
    await page.waitForFunction(() => !!window.mbrd?.vp, null, { timeout: 15_000 });

    await expect
      .poll(() => page.evaluate(() => window.mbrd.board.items.length), { timeout: 10_000 })
      .toBe(count);
  });
});

test.describe('the shell', () => {
  test('boots with a clean console', async ({ page }) => {
    // The one assertion that would have caught the main.js split going wrong,
    // and the reason this file exists at all: every module resolving is not the
    // same as every module running.
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));

    await ready(page);
    await page.waitForTimeout(1000);

    expect(errors, `console errors on boot:\n${errors.join('\n')}`).toEqual([]);
  });
});
