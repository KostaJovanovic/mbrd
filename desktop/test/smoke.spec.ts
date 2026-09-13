// Smoke test: launch the real Electron app, write a board, relaunch, verify
// it came back. Covers the protocol handler, CSP, preload bridge, close flush,
// and file store round trip. The changelog test checks extensionless /patch
// resolution. No fixed sleeps — every wait is on a condition, timeouts are
// ceilings. Native dialogs and Save-to-file are hand checks, not driven here.
// Pages are found by URL: the window's own contents is the title bar, the
// board is a view in it, and the menu panel is a hidden window of its own.

import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// __dirname not import.meta.url: package is CJS (preload cannot be ESM).
const DESKTOP = resolve(__dirname, '..');

/** The subset of window.mbrd this file drives (board + cmds). */
declare global {
  interface Window {
    mbrd?: {
      board: { title: string, items: unknown[] };
      // void: commands are pressed for effect, return is not read.
      cmds: Record<string, () => void>;
    };
  }
}

/** Fresh userData per run so the test and real boards never mix. */
async function launch(userData: string): Promise<ElectronApplication> {
  // Playwright wants Record<string, string>; filter out undefined values.
  const env = Object.fromEntries(
    Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined));
  // Electron-based editors set this, making the binary boot as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({ args: [DESKTOP, `--user-data-dir=${userData}`], env });
}

// protocol.ts's APP_INDEX and APP_CHROME. Written out: importing protocol.ts
// here would import Electron into the test runner.
const BOARD_URL = 'app://mbrd/index.html';
const BAR_URL = 'app://mbrd/__chrome/titlebar.html';
const PATCH_URL = 'app://mbrd/patch';

/** The page whose URL starts with `prefix`, once there is one. */
async function pageAt(app: ElectronApplication, prefix: string): Promise<Page> {
  const find = () => app.windows().find(p => p.url().startsWith(prefix));
  await expect.poll(() => !!find(), { timeout: 60_000, message: `a page at ${prefix}` }).toBe(true);
  const page = find();
  if (!page) throw new Error(`the page at ${prefix} went away`);
  return page;
}

/** The console handle main.ts documents, once the app has finished booting. */
async function ready(app: ElectronApplication) {
  const page = await pageAt(app, BOARD_URL);
  await page.waitForFunction(() => !!window.mbrd, undefined, { timeout: 60_000 });
  return page;
}

test('a board written on one run comes back on the next', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'mbrd-smoke-'));

  try {
    // ── Run one ───────────────────────────────────────────────────────────
    let app = await launch(userData);
    let page = await ready(app);

    // Title is in board.json — surviving a relaunch proves the store round trip.
    await page.evaluate(() => {
      window.mbrd!.board.title = 'Smoke test board';
      window.mbrd!.cmds.addNote();
    });

    const noted = await page.evaluate(() => window.mbrd!.board.items.length);
    expect(noted, 'a note was added').toBeGreaterThan(0);

    // Close (not kill) — tests the flush-before-close handler in main.
    await app.close();

    // ── Run two ───────────────────────────────────────────────────────────
    app = await launch(userData);
    page = await ready(app);

    const restored = await page.evaluate(() => ({
      title: window.mbrd!.board.title,
      items: window.mbrd!.board.items.length,
    }));

    expect(restored.title, 'the board came back by name').toBe('Smoke test board');
    expect(restored.items, 'and with what was on it').toBeGreaterThan(0);

    await app.close();
  } finally {
    await rm(userData, { recursive: true, force: true }).catch(() => {});
  }
});

test('the window boots with no error in the renderer', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'mbrd-smoke-'));
  const app = await launch(userData);
  const page = await ready(app);

  // CSP violations surface as console errors — cheapest check that the policy works.
  const errors: string[] = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  // Wait on a condition (board exists), not a fixed sleep.
  await page.waitForFunction(() => !!window.mbrd?.board, undefined, { timeout: 60_000 });

  // Headless runners have no audio device — not this app's problem.
  const real = errors.filter(e => !/AudioContext|audio device/i.test(e));
  expect(real, 'nothing failed on the way up').toEqual([]);

  await app.close();
  await rm(userData, { recursive: true, force: true }).catch(() => {});
});

test('the title bar is its own page, and draws the menus', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'mbrd-smoke-'));
  const app = await launch(userData);
  await ready(app);
  const bar = await pageAt(app, BAR_URL);

  // Four titles means the chrome preload, the menu-model IPC and the bar's
  // script all ran under the CSP.
  await expect(bar.locator('.tb-menu')).toHaveCount(4, { timeout: 30_000 });
  // The board's furniture is not in the bar, and the bar is not in the board.
  expect(await bar.evaluate(() => !!document.getElementById('sidebar')), 'no board in the bar').toBe(false);

  await app.close();
  await rm(userData, { recursive: true, force: true }).catch(() => {});
});

test('the store is a directory of files, and the board is in it', async () => {
  // Verifies the store is real files in userData, not Chromium's IndexedDB.
  const userData = await mkdtemp(join(tmpdir(), 'mbrd-smoke-'));
  const app = await launch(userData);
  const page = await ready(app);
  await page.evaluate(() => { window.mbrd!.cmds.addNote(); });
  await app.close();

  const session = await stat(join(userData, 'store', 'kv', 'session'));
  expect(session.size, 'a snapshot landed on disk as a file').toBeGreaterThan(0);

  await rm(userData, { recursive: true, force: true }).catch(() => {});
});

test('What Changed shows the changelog in the board window, and the board comes back', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'mbrd-smoke-'));
  const app = await launch(userData);
  let board = await ready(app);
  // Visible ones only: the hidden menu panel is a window too, built after the
  // board's first load, so on a slow runner it can arrive between the counts.
  const windows = () => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter(w => w.isVisible()).length);
  const before = await windows();
  await board.evaluate(() => {
    window.mbrd!.board.title = 'Changelog trip';
    window.mbrd!.cmds.addNote();
  });

  // Drive the command programmatically — menu rows cannot be pressed by Playwright.
  await board.evaluate(() => { window.mbrd!.cmds.patchNotes(); });
  const notes = await pageAt(app, PATCH_URL);
  // The protocol handler resolved the extensionless /patch to patch.html.
  await expect(notes.locator('h1')).toHaveText('Patch notes');
  // In place, under the same bar: no window more than before.
  expect(await windows(), 'no second window').toBe(before);
  await pageAt(app, BAR_URL);

  // "Back to the board" (href="/"). main flushed the board before it left,
  // so it comes back by name and with its note.
  await notes.click('a.pn-back');
  board = await ready(app);
  const back = await board.evaluate(() => ({
    title: window.mbrd!.board.title,
    items: window.mbrd!.board.items.length,
  }));
  expect(back.title, 'the board came back by name').toBe('Changelog trip');
  expect(back.items, 'and with its note').toBeGreaterThan(0);

  // A close from the changelog does not wait for a flush that nothing answers.
  await board.evaluate(() => { window.mbrd!.cmds.patchNotes(); });
  await pageAt(app, PATCH_URL);
  const closing = Date.now();
  await app.close();
  expect(Date.now() - closing, 'the window closed without the 10 s wait').toBeLessThan(5_000);

  await rm(userData, { recursive: true, force: true }).catch(() => {});
});

test('the panel offers Check for updates, and not Get the app', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'mbrd-smoke-'));
  const app = await launch(userData);
  const board = await ready(app);

  // A row the `when` test hides carries `hidden` on its .btn-row.
  const rows = await board.evaluate(() => {
    const shown = (cmd: string) => {
      const row = document.querySelector(`[data-cmd="${cmd}"]`)?.closest<HTMLElement>('.btn-row');
      return !!row && !row.hidden;
    };
    return { check: shown('check-updates'), get: shown('get-app') };
  });
  expect(rows.check, 'Check for updates is in the panel').toBe(true);
  expect(rows.get, 'Get the app is not').toBe(false);

  await app.close();
  await rm(userData, { recursive: true, force: true }).catch(() => {});
});
