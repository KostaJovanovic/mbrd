// Every setting in the side panel applies: each checkbox, range and picker,
// worked by hand, changes what the app keeps (the board's settings, the
// stored preferences) or what the page draws (the root element's attributes
// and custom properties). A control that changes none of them does nothing.

import { test, expect, boot, sticker, frames } from './harness.js';

/** Everything a setting could reasonably write, as one comparable string. */
const state = page => page.evaluate(() => {
  const root = document.documentElement;
  const board = window.mbrd.board;
  return JSON.stringify({
    settings: board.settings,
    arrangement: board.arrangement,
    look: board.sharedAppearance,
    title: board.mobileHeader,
    mode: board.layoutMode,
    stored: Object.fromEntries(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)])),
    attrs: [...root.attributes].map(a => `${a.name}=${a.value}`).sort(),
    body: document.body.className,
    sound: window.mbrd.sound.level(),
  });
});

/** Which control a locator is, for the failure message. */
const nameOf = control => control.evaluate(el => el.id || el.getAttribute('aria-label')
  || el.closest('label, .row, [class*="row"]')?.textContent?.trim().slice(0, 60) || el.outerHTML.slice(0, 80));

async function openTab(page, tab) {
  const toggle = page.locator('#menu-btn');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.locator(`#tab-${tab}`).click();
  const panel = page.locator(`#panel-${tab}`);
  await expect(panel).toBeVisible();
  // Every fold open, so the advanced rows are reachable too.
  for (const fold of await panel.locator('details:not([open]) > summary').all()) {
    if (await fold.isVisible()) await fold.click();
  }
  return panel;
}

for (const tab of ['board', 'look', 'system']) {
  test(`every control on the ${tab} tab changes something`, async ({ app }) => {
    // A card on the board: some rows only show over a board with content.
    await sticker(app, 0, -150);
    const panel = await openTab(app, tab);
    const dead = [];
    let worked = 0;

    for (const box of await panel.locator('input[type="checkbox"]').all()) {
      if (!(await box.isVisible()) || !(await box.isEnabled())) continue;
      const before = await state(app);
      await box.click();
      await frames(app);
      if ((await state(app)) === before) dead.push(`checkbox ${await nameOf(box)}`);
      else worked++;
      // Put back, so the next control starts from the defaults.
      if (await box.isVisible() && await box.isEnabled()) await box.click();
      await frames(app);
    }

    for (const range of await panel.locator('input[type="range"]').all()) {
      if (!(await range.isVisible()) || !(await range.isEnabled())) continue;
      const before = await state(app);
      const { min, max, value } = await range.evaluate(r => ({ min: r.min, max: r.max, value: r.value }));
      await range.focus();
      await app.keyboard.press(value === max ? 'Home' : 'End');
      await frames(app);
      if ((await state(app)) === before) dead.push(`range ${await nameOf(range)} (${min}..${max} from ${value})`);
      else worked++;
    }

    // Pickers: a button with no command that opens ui/menu.ts's panel; pick a
    // row not checked. Found by what a press does, since they carry no
    // aria-haspopup to find them by.
    const menu = app.locator('#ctx-menu[role="menu"]');
    for (const picker of await panel.locator('button:not([data-cmd])').all()) {
      if (!(await picker.isVisible()) || !(await picker.isEnabled())) continue;
      const before = await state(app);
      await picker.click();
      if (!(await menu.isVisible({ timeout: 1000 }).catch(() => false))) {
        await app.waitForTimeout(300);
        if (!(await menu.isVisible())) {
          await app.keyboard.press('Escape');
          await openTab(app, tab);
          continue;
        }
      }
      const other = menu.locator('[role="menuitemcheckbox"][aria-checked="false"], [role="menuitemradio"][aria-checked="false"]');
      if (!(await other.count())) { await app.keyboard.press('Escape'); continue; }
      const name = await nameOf(picker);
      const reloads = app.waitForEvent('framenavigated', { timeout: 1500 }).then(() => true, () => false);
      // The last: the palette's first row is Dynamic, which on a board with no
      // pictures is already in force and has nothing to change.
      await other.last().click();
      // A few choices reload the app to take effect; it comes back with them.
      if (await reloads) await boot(app);
      await frames(app);
      if ((await state(app)) === before) dead.push(`picker ${name}`);
      else worked++;
      await openTab(app, tab);
    }

    test.info().annotations.push({ type: 'controls', description: `${worked} worked on ${tab}` });
    expect(worked, 'some controls were found and worked').toBeGreaterThan(0);
    expect(dead, 'controls that changed nothing').toEqual([]);
  });
}
