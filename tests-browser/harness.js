// The suite's fixture and helpers. `test` hands each spec a booted app with
// a fresh profile and fails it on any console error or uncaught exception, as
// tools/smoke.mjs does. Helpers drive the board through real input and read
// it back through window.mbrd, the console handle main.ts documents.

import { createRequire } from 'node:module';

const require = createRequire(new URL('../desktop/package.json', import.meta.url));
const base = require('@playwright/test');

export const expect = base.expect;

// Headless runners have no audio device, which is not the app's problem.
const IGNORED = /AudioContext|audio device/i;

export const test = base.test.extend({
  app: async ({ page }, use) => {
    const problems = [];
    page.on('console', m => {
      if (m.type() === 'error' && !IGNORED.test(m.text())) problems.push(`console: ${m.text()}`);
    });
    page.on('pageerror', e => problems.push(`uncaught: ${e.stack || e.message}`));
    await boot(page);
    await use(page);
    expect(problems, 'no console error and no uncaught exception').toEqual([]);
  },
});

/** Load the app and wait until start() has put a board on screen. A fresh
 *  profile's is the first run's: the title card and the hint cards, which
 *  leave by themselves when the first card arrives (canvas/ghosts.ts). */
export async function boot(page) {
  await page.goto('/');
  await page.waitForFunction(() => !!window.mbrd?.board && !document.getElementById('splash')
    && window.mbrd.board.items.length > 0);
}

/** Every card on the board, as plain data. */
export const items = page => page.evaluate(() =>
  window.mbrd.board.items.map(it => ({ id: it.id, type: it.type, x: it.x, y: it.y, w: it.w, h: it.h })));

export const item = (page, id) => page.evaluate(id => {
  const it = window.mbrd.board.items.find(i => i.id === id);
  return it && { id: it.id, type: it.type, x: it.x, y: it.y, w: it.w, h: it.h };
}, id);

export const view = page => page.evaluate(() =>
  ({ x: window.mbrd.vp.pan.x, y: window.mbrd.vp.pan.y, zoom: window.mbrd.vp.zoom }));

export const selected = page => page.evaluate(() => [...window.mbrd.selection]);

/** A world point as page (client) coordinates. */
export const toClient = (page, x, y) => page.evaluate(([x, y]) => {
  const vp = window.mbrd.vp;
  const s = vp.toScreen(x, y);
  return { x: s.x + vp.left, y: s.y + vp.top };
}, [x, y]);

/** Run a command off window.mbrd.cmds and wait for the frame after it. */
export async function cmd(page, name, ...args) {
  const out = await page.evaluate(([name, args]) => window.mbrd.cmds[name](...args), [name, args]);
  await frames(page);
  return out;
}

/** Wait `n` animation frames in the page. */
export const frames = (page, n = 2) => page.evaluate(n => new Promise(done => {
  const step = k => (k ? requestAnimationFrame(() => step(k - 1)) : done());
  step(n);
}), n);

/** Wait until no card is mid-slide: undo, rearrange and the rest animate
 *  the DOM after the board has already changed. */
export const settle = page => page.waitForFunction(() =>
  document.getAnimations().every(a => a.playState !== 'running'
    || !(a.effect?.target instanceof Element && a.effect.target.closest('#world'))));

/** Ids added by `act`, an async function that adds cards. */
export async function added(page, act) {
  const before = new Set((await items(page)).map(i => i.id));
  await act();
  await frames(page);
  return (await items(page)).filter(i => !before.has(i.id)).map(i => i.id);
}

/** A sticker at a world point; the cheapest card that needs no file. */
export async function sticker(page, x, y) {
  const [id] = (await added(page, () => cmd(page, 'addStickerAt', 'star', { x, y })))
    .filter(id => !id.startsWith('__'));
  // The hint cards fly off on the first card; wait until they are gone.
  await page.waitForFunction(() => !document.querySelector('#world .item[data-id^="__ghost"]'));
  return id;
}

/** A note at a world point, written in the composer and kept (Escape there
 *  discards it). Notes join and resize, which stickers do not. */
export async function note(page, x, y, text = 'note') {
  const [id] = (await added(page, async () => {
    await page.evaluate(at => window.mbrd.cmds.addNoteAt(at), { x, y });
    await page.locator('#compose[open]').waitFor();
    await page.keyboard.type(text);
    await page.locator('#compose-go').click();
    await page.waitForFunction(() => !document.querySelector('#compose[open]'));
  })).filter(id => !id.startsWith('__'));
  await page.waitForFunction(() => !document.querySelector('#world .item[data-id^="__ghost"]'));
  return id;
}

/** Press, move in steps, release, with the mouse. `button` is left, right or middle. */
export async function drag(page, from, to, { button = 'left', steps = 12, modifiers = [] } = {}) {
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up({ button });
  for (const key of modifiers) await page.keyboard.up(key);
  await frames(page);
}
