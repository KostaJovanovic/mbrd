// The board as a whole: a left drag on open board pans, snapping rounds a drop
// to the lattice, Escape unwinds one layer at a time, cards culled off screen
// come back as they were, and Rearrange keeps the cards under the title card.

import {
  test, expect, sticker, note, item, view, selected, toClient, drag, frames, settle, cmd,
} from './harness.js';

test('a left drag on open board pans', async ({ app }) => {
  await sticker(app, -300, -150);
  const before = await view(app);
  const from = await toClient(app, 250, -50);
  await drag(app, from, { x: from.x - 90, y: from.y + 30 });
  const after = await view(app);
  expect(after.x).toBeCloseTo(before.x + 90 / before.zoom, 0);
  expect(after.y).toBeCloseTo(before.y + 30 / before.zoom, 0);
});

test('with snapping on, a drop moves a card by whole cells', async ({ app }) => {
  await app.evaluate(() => window.mbrd.cmds.setSetting('snap', true));
  const id = await note(app, 0, -150, 'snap');
  const start = await item(app, id);
  const step = await app.evaluate(() => window.mbrd.board.settings.gridStep || 64);
  const at = await toClient(app, start.x, start.y);
  const landed = [];
  for (const [dx, dy] of [[100, 0], [37, 81], [-150, -20]]) {
    await drag(app, at, { x: at.x + dx, y: at.y + dy });
    landed.push(await item(app, id));
    await cmd(app, 'undo');
    await settle(app);
  }
  // The card itself may start off the lattice; every drop lands on it, so the
  // drops differ from each other by whole cells.
  for (const it of landed.slice(1)) {
    expect(Math.abs((it.x - landed[0].x) % step)).toBeCloseTo(0, 6);
    expect(Math.abs((it.y - landed[0].y) % step)).toBeCloseTo(0, 6);
  }
  expect(new Set(landed.map(it => `${it.x},${it.y}`)).size, 'three different cells').toBe(3);
});

test('Escape closes the menu first and keeps the selection, then clears it', async ({ app }) => {
  const id = await note(app, 0, -150, 'esc');
  const at = await toClient(app, 0, -150);
  await app.mouse.click(at.x, at.y);
  await app.mouse.click(at.x, at.y, { button: 'right' });
  await expect(app.locator('#ctx-menu')).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(app.locator('#ctx-menu')).toBeHidden();
  expect(await selected(app)).toEqual([id]);
  await app.keyboard.press('Escape');
  await frames(app);
  expect(await selected(app)).toEqual([]);
});

test('a card culled off screen comes back as it was', async ({ app }) => {
  const id = await note(app, 0, -150, 'still here');
  const card = app.locator(`#world .item[data-id="${id}"]`);
  await expect(card).toHaveCount(1);
  const home = await view(app);
  await app.evaluate(() => window.mbrd.vp.setView({ x: 200_000, y: 200_000 }));
  await expect(card).toHaveCount(0, { timeout: 10_000 });
  await app.evaluate(v => window.mbrd.vp.setView({ x: v.x, y: v.y }, v.zoom), home);
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('still here');
  expect(await item(app, id)).toMatchObject({ x: 0, y: -150 });
});

test('Rearrange with "keep cards below the title card" hangs the block under the title', async ({ app }) => {
  await app.evaluate(() => window.mbrd.cmds.setSetting('belowTitle', 'on'));
  // Spiral, the default: a disc, which hung by its rounded top was a cone.
  expect(await app.evaluate(() => window.mbrd.board.arrangement)).toBe('spiral');
  for (const [x, y] of [[-500, 300], [400, 400], [-200, -300], [300, -200], [0, 600], [600, 0]]) {
    await note(app, x, y, `card ${x},${y}`);
  }
  for (let k = 0; k < 14; k++) await sticker(app, -700 + k * 100, -700);
  await cmd(app, 'rearrange');
  const out = await app.evaluate(() => {
    const ext = it => {
      const r = ((it.rot || 0) * Math.PI) / 180;
      const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
      return { hw: (it.w * c + it.h * s) / 2, hh: (it.w * s + it.h * c) / 2 };
    };
    const title = window.mbrd.board.items.find(it => it.type === 'title');
    const cards = window.mbrd.board.items.filter(it => it.type === 'note' || it.type === 'sticker');
    const tops = cards.map(it => it.y + ext(it).hh);
    const lefts = cards.map(it => it.x - ext(it).hw);
    const rights = cards.map(it => it.x + ext(it).hw);
    const top = Math.max(...tops);
    // The first row: the cards whose top edge is within 80 of the block's.
    const row = cards.filter((_, k) => tops[k] > top - 80);
    return {
      foot: title.y - ext(title).hh,
      titleX: title.x,
      top,
      middle: (Math.min(...lefts) + Math.max(...rights)) / 2,
      firstRow: (Math.max(...row.map(it => it.x + ext(it).hw)) - Math.min(...row.map(it => it.x - ext(it).hw)))
        / (Math.max(...rights) - Math.min(...lefts)),
      step: window.mbrd.board.settings.gridStep || 64,
    };
  });
  // Every card below the title's foot.
  expect(out.top).toBeLessThanOrEqual(out.foot);
  // The block starts one grid step under the foot, with no gap beyond that...
  expect(out.foot - out.top).toBeLessThanOrEqual(out.step * 1.5);
  // ...is centred under the title...
  expect(Math.abs(out.middle - out.titleX)).toBeLessThanOrEqual(out.step);
  // ...and its top is cut flat, not the point of a disc.
  expect(out.firstRow).toBeGreaterThanOrEqual(0.5);
});
