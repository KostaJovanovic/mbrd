// What survives: a board autosaved into the browser comes back after a reload,
// and a board exported to a .mbrd file opens again from it. WebKit's Windows
// build cannot keep a Blob in IndexedDB, which every save here needs, so these
// run in Chromium and Firefox only; Safari itself has no such limit.

import { readFile } from 'node:fs/promises';
import { test, expect, boot, sticker, note, items, item, frames, cmd } from './harness.js';

test.skip(({ browserName }) => browserName === 'webkit', 'Playwright WebKit on Windows stores no Blob in IndexedDB');

/** The ids the browser's session slot holds now (storage/session.ts). */
const storedIds = page => page.evaluate(() => new Promise((ok, fail) => {
  const open = indexedDB.open('mbrd');
  open.onerror = () => fail(open.error);
  open.onsuccess = () => {
    const req = open.result.transaction('kv').objectStore('kv').get('session');
    req.onerror = () => fail(req.error);
    req.onsuccess = () => {
      open.result.close();
      ok((req.result?.board?.items ?? []).map(it => it.id));
    };
  };
}));

test('a board comes back after a reload', async ({ app }) => {
  const a = await sticker(app, -150, -150);
  const b = await note(app, 150, -150, 'kept');
  await app.evaluate(() => { window.mbrd.board.title = 'Reload trip'; });
  await cmd(app, 'undo');
  await cmd(app, 'redo');
  // Autosave runs a few seconds after a committed change; wait for it rather
  // than for a fixed time.
  await expect.poll(() => storedIds(app), { timeout: 30_000 }).toEqual(expect.arrayContaining([a, b]));
  await app.reload();
  await boot(app);
  expect(await item(app, a)).toMatchObject({ x: -150, y: -150 });
  expect(await item(app, b)).toBeTruthy();
  expect(await app.evaluate(() => window.mbrd.board.title)).toBe('Reload trip');
});

test('a board exported to .mbrd opens again from the file', async ({ app }, info) => {
  // No File System Access pickers: export downloads and open reads an <input>,
  // the path Firefox and Safari take anyway, and the one a test can answer.
  await app.addInitScript(() => {
    delete window.showSaveFilePicker;
    delete window.showOpenFilePicker;
  });
  await app.reload();
  await boot(app);

  const a = await sticker(app, -150, -150);
  const b = await note(app, 150, -150, 'round trip');
  await app.evaluate(() => { window.mbrd.board.title = 'Round trip'; });
  const before = (await items(app)).filter(it => it.id === a || it.id === b);

  const saving = app.waitForEvent('download');
  await app.evaluate(() => { void window.mbrd.cmds.export(); });
  const download = await saving;
  expect(download.suggestedFilename()).toMatch(/\.mbrd$/);
  const file = info.outputPath(download.suggestedFilename());
  await download.saveAs(file);
  expect((await readFile(file)).subarray(0, 2).toString()).toBe('PK');

  // A different board on screen, then the file opened over it.
  await app.evaluate(() => window.mbrd.cmds.new());
  await frames(app);
  expect(await item(app, a)).toBeUndefined();
  const choosing = app.waitForEvent('filechooser');
  await app.evaluate(() => { void window.mbrd.cmds.open(); });
  await (await choosing).setFiles(file);
  await expect.poll(() => item(app, a)).toBeTruthy();
  const after = (await items(app)).filter(it => it.id === a || it.id === b);
  expect(after).toEqual(before);
  expect(await app.evaluate(() => window.mbrd.board.title)).toBe('Round trip');
});
