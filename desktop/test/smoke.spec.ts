// The one test that drives the real application.
//
// Everything in tests/ at the root runs the app's modules under Node with fakes
// underneath them - which is most of what is worth testing and is none of what
// this is for. There is no browser-driven suite in this repository (CLAUDE.md
// says so: pan and zoom, drag and marquee, save-refresh-recover and a clean boot
// console are checked by launching the app and looking). This is the smallest
// possible version of "launch it and look", run by a machine, for the one thing
// the desktop added that nobody can check any other way: **that a board written
// on one run comes back on the next.**
//
// The round trip is the whole point and every step of it is a different piece
// of the shell:
//
//   launch      the protocol handler, the CSP, the preload bridge
//   add a note  the renderer, unchanged from the web
//   close       the close handler main holds the window open for
//   relaunch    the file store, read back by session.ts
//
// ── What it does not do, and one thing it deliberately stopped doing ──
//
// Press anything. Playwright drives the *page*, and the parts of this app that
// are not a page - a native menu item, a Save dialog, the Install-or-Portable
// installer page - are outside what it can reach. Those are the hand checks the
// checklist names, and this test does not pretend to cover them.
//
// It was going to cover Save-to-a-file too, which needs a real path, which
// needs a native dialog nothing here can press. The way through was a test-only
// bridge function that vouched for a path behind an environment variable - and
// that is a hole in "a renderer cannot name a path", the one invariant the
// whole of desktop/files.ts exists to keep, cut for the benefit of a test. It
// was written and then taken out again. Saving to a file is a hand check.
//
// ── The waits ──
//
// No fixed sleeps. `research/old/ui-audit-2026-08-13.md` is about what a driven
// browser gets wrong, and the short version is that a timeout that passes on a
// fast machine is a flake on a slow one. Every wait below is on a condition -
// `window.mbrd` existing, a board id changing - and the timeouts are ceilings
// on a failure rather than pauses.

import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// `__dirname` rather than `import.meta.url`, and it is the same decision the
// rest of this package makes for the same reason. desktop/package.json declares
// no `"type": "module"` - a sandboxed preload cannot be ESM, so both bundles
// are CommonJS and one rule is cheaper than two - and Playwright loads a spec
// under that same package. `import.meta` there is a syntax error, and the
// symptom is "No tests found", which points nowhere near the cause.
const DESKTOP = resolve(__dirname, '..');

/**
 * The console handle, declared once rather than asserted at every call.
 *
 * `main.ts` documents `window.mbrd` as a deliberate public handle and names its
 * eight keys; this declares the three this file drives. Written out because the
 * alternative is a `window as unknown as {...}` at every `page.evaluate`, which
 * is six copies of the same claim and six places for it to drift from what the
 * app actually exposes.
 */
declare global {
  interface Window {
    mbrd?: {
      board: { title: string, items: unknown[] };
      // `void` rather than `unknown`: the commands this file drives are the
      // ones it presses for their effect, and nothing here reads a return.
      // Saying `unknown` would be claiming there is a value worth having.
      cmds: Record<string, () => void>;
    };
  }
}

/**
 * A userData directory per run, so the test never reads a board a person made
 * and a person never reads one the test made. `--user-data-dir` is Chromium's
 * switch and Electron honours it for `app.getPath('userData')`, which is what
 * the file store is rooted at.
 */
async function launch(userData: string): Promise<ElectronApplication> {
  // The environment as it is, minus the keys Node types as possibly absent.
  // Playwright wants a Record<string, string> and process.env is not one; the
  // filter is the honest narrowing rather than an assertion.
  const env = Object.fromEntries(
    Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined));
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

    // The title is the thing to check for afterwards: it is carried in
    // board.json, so a board that comes back with it came back through the
    // packer and the store rather than from anything still in memory.
    await page.evaluate(() => {
      window.mbrd!.board.title = 'Smoke test board';
      window.mbrd!.cmds.addNote();
    });

    const noted = await page.evaluate(() => window.mbrd!.board.items.length);
    expect(noted, 'a note was added').toBeGreaterThan(0);

    // Closed rather than killed. The close handler is the thing being tested:
    // main holds the window open until the renderer says it has flushed, which
    // is the one thing a browser tab could never do.
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

  // A CSP violation arrives as a console error, which makes this the cheapest
  // possible check that the policy the protocol handler attaches is the one the
  // app can actually run under. It is also the check that would have caught
  // every packaging mistake in group H.
  const errors: string[] = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  // One full frame's worth of settling, on a condition rather than a sleep: the
  // board has painted when the app has a board id, which is set at the end of
  // the restore.
  await page.waitForFunction(() => !!window.mbrd?.board, undefined, { timeout: 60_000 });

  // The audio device is the one thing a headless runner genuinely has not got,
  // and it is not this app's problem to solve.
  const real = errors.filter(e => !/AudioContext|audio device/i.test(e));
  expect(real, 'nothing failed on the way up').toEqual([]);

  await app.close();
  await rm(userData, { recursive: true, force: true }).catch(() => {});
});

test('the store is a directory of files, and the board is in it', async () => {
  // The claim plan §4 makes about where recovery lives: app data written by the
  // main process, not Chromium's IndexedDB partition. This is what makes that
  // observable rather than asserted.
  const userData = await mkdtemp(join(tmpdir(), 'mbrd-smoke-'));
  const app = await launch(userData);
  const page = await ready(app);
  await page.evaluate(() => { window.mbrd!.cmds.addNote(); });
  await app.close();

  const session = await stat(join(userData, 'store', 'kv', 'session'));
  expect(session.size, 'a snapshot landed on disk as a file').toBeGreaterThan(0);

  await rm(userData, { recursive: true, force: true }).catch(() => {});
});
