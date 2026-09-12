// Smoke test: launch the real Electron app, write a board, relaunch, verify
// it came back. Covers the protocol handler, CSP, preload bridge, close flush,
// and file store round trip. The changelog test checks extensionless /patch
// resolution. No fixed sleeps — every wait is on a condition, timeouts are
// ceilings. Native dialogs and Save-to-file are hand checks, not driven here.

import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
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

/** The console handle main.ts documents, once the app has finished booting. */
async function ready(app: ElectronApplication) {
  const page = await app.firstWindow();
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

test('What Changed opens the changelog in a window of its own', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'mbrd-smoke-'));
  const app = await launch(userData);
  const board = await ready(app);

  // Drive the command programmatically — menu rows cannot be pressed by Playwright.
  await board.evaluate(() => { window.mbrd!.cmds.patchNotes(); });
  const notes = await app.waitForEvent('window', { timeout: 30_000 });
  await notes.waitForLoadState('domcontentloaded');

  // The whole point: protocol handler resolved extensionless /patch to patch.html.
  await expect(notes.locator('h1')).toHaveText('Patch notes');

  // Board stays open — this is a second window, not a navigation.
  expect(await board.evaluate(() => !!window.mbrd), 'the board stayed put').toBe(true);

  // Second press reuses the window, no stack.
  await board.evaluate(() => { window.mbrd!.cmds.patchNotes(); });
  const open = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  expect(open, 'the second press focused the window it already had').toBe(2);

  // "Back to the board" (href="/") — main closes this window.
  // Poll window count: the close event does not fire for main-initiated closes.
  await notes.click('a[href="/"]');
  await expect.poll(() => app.windows().length, { timeout: 10_000 }).toBe(1);
  expect(await board.evaluate(() => !!window.mbrd), 'and the board is what is left').toBe(true);

  await app.close();
  await rm(userData, { recursive: true, force: true }).catch(() => {});
});
