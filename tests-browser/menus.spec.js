// Every menu opens: the card, title, empty-board and selection menus by right
// click, each of their submenus by hover, the toolbar's flyouts, and the menu
// from the keyboard. ui/menu.ts draws all of them into #ctx-menu and #ctx-child.

import { test, expect, sticker, note, toClient, frames } from './harness.js';

const menu = page => page.locator('#ctx-menu[role="menu"]');
const child = page => page.locator('#ctx-child[role="menu"]');

/** Open each submenu row of the open menu in turn; its labels and how many rows it had. */
async function walkSubmenus(page) {
  const rows = menu(page).locator('[aria-haspopup="menu"]');
  const n = await rows.count();
  const seen = [];
  for (let k = 0; k < n; k++) {
    const row = rows.nth(k);
    if (!(await row.isVisible())) continue;
    await row.hover();
    await expect(child(page), `the submenu under "${await row.innerText()}"`).toBeVisible();
    expect(await child(page).locator('[role^="menuitem"]').count()).toBeGreaterThan(0);
    seen.push((await row.innerText()).trim());
  }
  return seen;
}

async function rightClick(page, x, y) {
  const at = await toClient(page, x, y);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expect(menu(page)).toBeVisible();
  expect(await menu(page).locator('[role^="menuitem"]').count()).toBeGreaterThan(0);
}

async function closeMenu(page) {
  await page.keyboard.press('Escape');
  await expect(menu(page)).toBeHidden();
  await frames(page);
}

test('the card menu and its submenus open', async ({ app }) => {
  await note(app, 0, -150, 'menu');
  await rightClick(app, 0, -150);
  expect((await walkSubmenus(app)).length, 'a note menu has submenus').toBeGreaterThan(0);
  await closeMenu(app);
});

test('the sticker menu opens', async ({ app }) => {
  await sticker(app, 0, -150);
  await rightClick(app, 0, -150);
  await walkSubmenus(app);
  await closeMenu(app);
});

test('the title card menu opens', async ({ app }) => {
  const title = await app.evaluate(() => {
    const t = window.mbrd.board.items.find(it => it.type === 'title');
    return { x: t.x, y: t.y };
  });
  await rightClick(app, title.x, title.y);
  await walkSubmenus(app);
  await closeMenu(app);
});

test('the empty-board menu and its submenus open', async ({ app }) => {
  await sticker(app, -300, -150);
  await rightClick(app, 250, -50);
  await walkSubmenus(app);
  await closeMenu(app);
});

test('the menu for a selection of several opens', async ({ app, browserName }) => {
  // In Playwright's Firefox a pointerleave from the whole menu follows the
  // pointerenter on "Select" by 3ms, which cancels the row's 90ms dwell
  // (ui/menu.ts), so its submenu never opens. Not yet checked in a real Firefox.
  test.fixme(browserName === 'firefox', 'Select submenu does not open on hover in Firefox');
  await note(app, -200, -150, 'one');
  await note(app, 200, -150, 'two');
  await app.evaluate(() => window.mbrd.cmds.selectAll());
  await rightClick(app, -200, -150);
  await walkSubmenus(app);
  await closeMenu(app);
});

test('Shift+F10 opens the menu for the selected card', async ({ app }) => {
  const at = await toClient(app, 0, -150);
  await note(app, 0, -150, 'keys');
  await app.mouse.click(at.x, at.y);
  await app.keyboard.press('Shift+F10');
  await expect(menu(app)).toBeVisible();
  await closeMenu(app);
});

test('each toolbar flyout opens from a right click on its tool', async ({ app }) => {
  // FLYOUTS in ui/flyout.ts, marked for assistive tech by initFlyouts().
  const tools = app.locator('#toolbar [data-cmd][aria-haspopup="menu"]');
  const n = await tools.count();
  expect(n).toBeGreaterThanOrEqual(3);
  for (let k = 0; k < n; k++) {
    const tool = tools.nth(k);
    if (!(await tool.isVisible())) continue;
    await tool.click({ button: 'right' });
    await expect(menu(app), `the flyout of ${await tool.getAttribute('data-cmd')}`).toBeVisible();
    await closeMenu(app);
  }
});
