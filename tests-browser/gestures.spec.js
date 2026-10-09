// Canvas gestures with a mouse, wheel and keyboard: move, the slop that keeps
// a click a click, Alt-copy, marquee, pan by middle and right press, zoom about
// the cursor, resize grips, nudging and the Escape chain. Positions are read
// back through window.mbrd; the input is real.

import {
  test, expect, sticker, note, item, items, view, selected, toClient, drag, frames, cmd,
} from './harness.js';

test('a dragged card moves by the pointer and comes back on one undo', async ({ app }) => {
  const id = await sticker(app, -200, -150);
  const at = await toClient(app, -200, -150);
  const { zoom } = await view(app);
  await drag(app, at, { x: at.x + 120, y: at.y + 60 });
  const moved = await item(app, id);
  expect(moved.x).toBeCloseTo(-200 + 120 / zoom, 0);
  // World y runs up, screen y down.
  expect(moved.y).toBeCloseTo(-150 - 60 / zoom, 0);
  await cmd(app, 'undo');
  expect(await item(app, id)).toMatchObject({ x: -200, y: -150 });
});

test('a press that wanders less than the slop is a click, not a move', async ({ app }) => {
  const id = await sticker(app, 0, -150);
  await cmd(app, 'selectAll');
  await app.keyboard.press('Escape');
  const at = await toClient(app, 0, -150);
  await drag(app, at, { x: at.x + 2, y: at.y + 1 }, { steps: 2 });
  expect(await item(app, id)).toMatchObject({ x: 0, y: -150 });
  expect(await selected(app)).toEqual([id]);
});

test('Alt-drag leaves the card and drops a copy, undone in one step', async ({ app }) => {
  const id = await sticker(app, -100, -150);
  const before = (await items(app)).length;
  const at = await toClient(app, -100, -150);
  await drag(app, at, { x: at.x + 150, y: at.y }, { modifiers: ['Alt'] });
  const after = await items(app);
  expect(after.length).toBe(before + 1);
  expect(await item(app, id)).toMatchObject({ x: -100, y: -150 });
  const copy = after.find(it => it.type === 'sticker' && it.id !== id);
  expect(copy.x).toBeGreaterThan(-100 + 100);
  await cmd(app, 'undo');
  expect((await items(app)).length).toBe(before);
});

test('a shift-drag over empty board selects what it encloses', async ({ app }) => {
  const a = await sticker(app, -250, -200);
  const b = await sticker(app, -100, -200);
  const c = await sticker(app, 250, -200);
  await app.keyboard.press('Escape');
  await drag(app, await toClient(app, -320, -120), await toClient(app, -30, -280), { modifiers: ['Shift'] });
  const got = await selected(app);
  expect(got).toEqual(expect.arrayContaining([a, b]));
  expect(got).not.toContain(c);
});

test('Escape clears the selection, and a click on empty board does too', async ({ app }) => {
  await sticker(app, 0, -150);
  await cmd(app, 'selectAll');
  expect((await selected(app)).length).toBeGreaterThan(0);
  await app.keyboard.press('Escape');
  await frames(app);
  expect(await selected(app)).toEqual([]);
  await cmd(app, 'selectAll');
  const empty = await toClient(app, 250, -50);
  expect(await app.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('#viewport, .item')?.id,
    empty), 'the point is open board').toBe('viewport');
  await app.mouse.click(empty.x, empty.y);
  await frames(app);
  expect(await selected(app)).toEqual([]);
});

for (const button of ['middle', 'right']) {
  test(`a ${button} drag pans the view and moves no card`, async ({ app }) => {
    const id = await sticker(app, 0, -150);
    const before = await view(app);
    const at = await toClient(app, 0, -150);
    await drag(app, at, { x: at.x + 80, y: at.y + 40 }, { button });
    const after = await view(app);
    expect(after.x).toBeCloseTo(before.x - 80 / before.zoom, 0);
    expect(after.y).toBeCloseTo(before.y + 40 / before.zoom, 0);
    expect(await item(app, id)).toMatchObject({ x: 0, y: -150 });
    // A right drag that panned opens no menu at the end of it.
    expect(await app.locator('.ctx-menu:visible, .menu:visible').count()).toBe(0);
  });
}

test('a right click that does not move opens the card menu', async ({ app }) => {
  await sticker(app, 0, -150);
  const at = await toClient(app, 0, -150);
  await app.mouse.click(at.x, at.y, { button: 'right' });
  await expect(app.locator('[role="menu"]:visible').first()).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(app.locator('[role="menu"]:visible')).toHaveCount(0);
});

test('the wheel zooms about the cursor', async ({ app }) => {
  const at = { x: 900, y: 300 };
  const under = await app.evaluate(({ x, y }) => window.mbrd.vp.toWorld(x, y), at);
  const before = await view(app);
  await app.mouse.move(at.x, at.y);
  await app.mouse.wheel(0, -120);
  await expect.poll(async () => (await view(app)).zoom).toBeGreaterThan(before.zoom);
  // Settled: the zoom animates.
  await app.waitForTimeout(500);
  const still = await app.evaluate(({ x, y }) => window.mbrd.vp.toWorld(x, y), at);
  expect(still.x).toBeCloseTo(under.x, 0);
  expect(still.y).toBeCloseTo(under.y, 0);
});

test('a selected card grows from its corner grip', async ({ app }) => {
  // A note: stickers keep their aspect.
  const id = await note(app, 0, -150);
  await app.keyboard.press('Escape');
  const box = await item(app, id);
  const corner = await toClient(app, box.x + box.w / 2, box.y - box.h / 2);
  await app.mouse.click(corner.x - 20, corner.y - 20);
  await frames(app);
  const grip = app.locator(`.item[data-id="${id}"] > .grip[data-g="se"]`);
  await expect(grip).toHaveCount(1);
  const g = await grip.boundingBox();
  await drag(app, { x: g.x + g.width / 2, y: g.y + g.height / 2 },
    { x: g.x + g.width / 2 + 100, y: g.y + g.height / 2 + 60 });
  const grown = await item(app, id);
  expect(grown.w).toBeGreaterThan(box.w + 50);
  expect(grown.h).toBeGreaterThan(box.h + 20);
  await cmd(app, 'undo');
  expect(await item(app, id)).toMatchObject({ w: box.w, h: box.h });
});

test('arrow presses nudge a card and fold into one undo step', async ({ app }) => {
  const id = await sticker(app, 0, -150);
  await app.mouse.click(...Object.values(await toClient(app, 0, -150)));
  for (let k = 0; k < 4; k++) await app.keyboard.press('ArrowRight');
  await frames(app);
  const moved = await item(app, id);
  expect(moved.x).toBeGreaterThan(0);
  await cmd(app, 'undo');
  expect(await item(app, id)).toMatchObject({ x: 0, y: -150 });
});

test('Delete removes the selection and undo brings it back', async ({ app }) => {
  const id = await sticker(app, 0, -150);
  await app.mouse.click(...Object.values(await toClient(app, 0, -150)));
  await app.keyboard.press('Delete');
  await frames(app);
  expect(await item(app, id)).toBeUndefined();
  await cmd(app, 'undo');
  expect(await item(app, id)).toBeTruthy();
});

test('two selected cards connect, and the join survives undo and redo', async ({ app }) => {
  // Notes: a sticker is a mark and takes no line.
  const a = await note(app, -200, -150, 'one');
  const b = await note(app, 200, -150, 'two');
  const pa = await toClient(app, -200, -150);
  const pb = await toClient(app, 200, -150);
  await app.mouse.click(pa.x, pa.y);
  await app.keyboard.down('Shift');
  await app.mouse.click(pb.x, pb.y);
  await app.keyboard.up('Shift');
  expect((await selected(app)).sort()).toEqual([a, b].sort());
  await cmd(app, 'connectSelection');
  const joined = () => app.evaluate(([a, b]) => window.mbrd.board.connections
    .some(c => (c[0] === a && c[1] === b) || (c[0] === b && c[1] === a)), [a, b]);
  expect(await joined()).toBe(true);
  await cmd(app, 'undo');
  expect(await joined()).toBe(false);
  await cmd(app, 'redo');
  expect(await joined()).toBe(true);
});

// Known bug from the 2026-10-08 survey (canvas/input.ts): a middle press during
// a left drag pans over the move and never commits it. Unskip once fixed.
test.fixme('a middle press mid-drag still commits the move', async ({ app }) => {
  const id = await sticker(app, 0, -150);
  const at = await toClient(app, 0, -150);
  await app.mouse.move(at.x, at.y);
  await app.mouse.down();
  await app.mouse.move(at.x + 100, at.y, { steps: 8 });
  await app.mouse.down({ button: 'middle' });
  await app.mouse.up({ button: 'middle' });
  await app.mouse.up();
  await frames(app);
  expect((await item(app, id)).x).toBeGreaterThan(50);
});
