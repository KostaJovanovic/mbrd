// The shell. One window, one board, and a security boundary that is Electron's
// defaults with nothing loosened.
//
// This file is deliberately small and deliberately dull. Everything the app
// does is in web/, unchanged, running in the same Chromium it runs in on the
// web; what is here is the answer to seven questions a browser tab used to
// answer on its own, and the argument for each of them is in
// web/assets/js/platform/platform.ts rather than here.
//
// ── The boundary, stated so nobody loosens one for convenience ──
//
//   contextIsolation: true    the preload's world and the page's world are
//                             separate, so nothing the page defines can reach
//                             anything the preload holds.
//   sandbox: true             the renderer is an ordinary web page in an OS
//                             sandbox. This is also why the preload bundle is
//                             CommonJS: Electron does not run an ESM preload in
//                             the sandbox, which is a build failure that looks
//                             like a blank window.
//   nodeIntegration: false    there is no `require` in the page.
//
// The bridge is a contextBridge object of named functions and nothing else. No
// `ipcRenderer` is handed through, because handing it through would hand the
// page every channel this process listens on rather than the four it means to
// offer.
//
// **A renderer cannot name a path.** Every path in this process comes from a
// dialog this process opened, from argv, from the OS's open-file event, or from
// the store directory. That is the invariant the later groups add functions
// under, and it is why `store` is keyed by store-and-key rather than by
// filename.
//
// ── Links ──
//
// Every outbound anchor in the app already goes through `target=_blank` with
// `noopener`, so there is exactly one place to intercept: the window-open
// handler denies everything and hands http(s) to the system browser. A second
// BrowserWindow is never created - a link that opened a chromeless Electron
// window would be a browser with no address bar, which is the shape of every
// phishing frame ever built.

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { registerSchemes, serveWeb, APP_INDEX, APP_ORIGIN } from './protocol.ts';
import { initLog, log } from './log.ts';
import * as store from './store.ts';
import * as files from './files.ts';

/**
 * One instance, one window, one board.
 *
 * Taken before anything else, because the whole point is to lose the race
 * early: a second launch has to hand its file over and quit before it opens a
 * window of its own. What it does with the lock is wired in group F; refusing
 * to start twice is wanted from the first build, since two copies of this app
 * would be two writers over one recovery store.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main(): void {
  registerSchemes();

  app.whenReady().then(async () => {
    initLog();
    serveWeb();
    wireStore();
    wireFiles();
    wireApp();
    // Before the window, so the shelf's file rows are already vouched for when
    // the page asks whether their files still exist - see files.ts's `known`.
    await vouchShelf();
    // Not awaited and not allowed to delay a window: a `.trash-` directory is
    // bytes nobody can reach, left behind by a wipe whose delete failed after
    // its rename had already emptied the store.
    void store.sweepTrash();
    createWindow();

    // macOS keeps the process alive with no windows, and clicking the dock icon
    // is how a window comes back. Not a second board - the same one, because
    // one window is one board and the shelf is where the others are.
    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) createWindow();
    });
  }).catch(err => log('error', 'startup failed', err));

  // Everywhere but macOS, the last window closing is the app closing. On macOS
  // it is not, and pretending otherwise is the single most common way a ported
  // application feels wrong there.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 480,
    minHeight: 400,
    // The board paints its own background before anything else; a white flash
    // in front of it is the one frame that says "web page" out loud.
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Relative to dist/, which is where both bundles land - see the build
      // script in package.json.
      preload: join(__dirname, 'preload.js'),
    },
  });

  // Shown on first paint rather than immediately, so the window arrives with
  // the board in it. `show: false` plus this is Electron's own answer to the
  // white rectangle that otherwise appears for a few hundred milliseconds.
  win.once('ready-to-show', () => win.show());

  // Denied by default, both ways in. `openExternal` gets http and https only:
  // every other scheme is somebody else's protocol handler, and handing an
  // arbitrary URL to the OS is how a link becomes a command line.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(safeProtocol(url))) {
      shell.openExternal(url).catch(err => log('warn', 'could not open a link', { url, err: String(err) }));
    } else {
      log('warn', 'refused to open a link', { url });
    }
    return { action: 'deny' };
  });

  // The other way in: a navigation of the window itself. The app is a single
  // page and never navigates, so anything here is a link that got past the
  // handler above or a document doing something it should not.
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(APP_ORIGIN + '/')) return;
    event.preventDefault();
    log('warn', 'refused a navigation', { url });
  });

  // No <webview> anywhere in this app, so the only correct number of them is
  // zero. Denied rather than configured, because a webview that is configured
  // is a webview somebody may reach for.
  win.webContents.on('will-attach-webview', event => {
    event.preventDefault();
    log('warn', 'refused a webview');
  });

  // The renderer's console into the log file, errors and warnings only. A
  // tester's window has no DevTools open and this is the whole of what "it did
  // not work" can be turned into afterwards. Anything below `warning` would be
  // the app's ordinary chatter and would bury it - and a CSP violation, which
  // is the failure this shell is most likely to introduce, arrives as an error.
  //
  // The event object rather than the four positional arguments: Electron
  // deprecated the old signature, and the levels are names now rather than
  // numbers, which is the whole reason the old one was easy to get wrong.
  win.webContents.on('console-message', event => {
    if (event.level !== 'error' && event.level !== 'warning') return;
    log(event.level === 'error' ? 'error' : 'warn', 'renderer: ' + event.message,
      { source: event.sourceId, line: event.lineNumber });
  });

  holdCloseForFlush(win);
  win.loadURL(APP_INDEX).catch(err => log('error', 'could not load the app', err));
  return win;
}

/**
 * Hold the close until the page says it has finished writing.
 *
 * This is the one thing a browser tab could never do, and the reason the
 * lifecycle port exists. On the web the same handler runs on `pagehide`, where
 * it cannot be awaited: the flush is started and the page goes away, and a note
 * being typed when the tab closed is a note whose last sentence is gone.
 *
 * The ceiling is the other half. A renderer that is wedged - a broken build, an
 * infinite loop in a save - must not produce a window that cannot be shut, so
 * after ten seconds this closes anyway and says so in the log. Ten because the
 * thing being waited for is one snapshot write to local disk, which is
 * milliseconds; anything approaching the ceiling is a fault, not a slow board.
 */
function holdCloseForFlush(win: BrowserWindow): void {
  let flushed = false;

  const letGo = () => {
    if (flushed) return;
    flushed = true;
    // `close()` again rather than `destroy()`: the handler below stands aside
    // once `flushed` is set, so this is an ordinary close and every other
    // listener still runs.
    win.close();
  };

  ipcMain.on('app:close-now', letGo);

  win.on('close', event => {
    if (flushed) return;
    event.preventDefault();
    win.webContents.send('app:close-requested');
    setTimeout(() => {
      if (flushed) return;
      log('warn', 'the page did not finish flushing in 10s; closing anyway');
      letGo();
    }, 10_000);
  });

  // The listener is the window's, so it goes when the window does. Without
  // this, a second window in one session - macOS's dock-icon reopen - would
  // leave the first one's handler answering for it.
  win.on('closed', () => ipcMain.removeListener('app:close-now', letGo));
}

/** The scheme of a URL, or nothing where it is not a URL at all. */
function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

/** The window a dialog should hang off, or null before there is one. */
const current = () => BrowserWindow.getAllWindows()[0] ?? null;

// ---------------------------------------------------------------------------
// The bridge's other half
// ---------------------------------------------------------------------------

/**
 * Every handler is registered once, at `ready`, and answers whatever arrives.
 *
 * The validation is inside the modules rather than here - store.ts refuses a
 * key that is not a lowercase string, files.ts refuses a path this process did
 * not produce - because that is where the reason for each rule is written. A
 * gate here would be a second list to keep in step with them.
 */
function wireStore(): void {
  ipcMain.handle('store:get', (_e, s: string, k: string) => store.get(s, k));
  ipcMain.handle('store:set', (_e, s: string, k: string, v: unknown) => store.set(s, k, v));
  ipcMain.handle('store:del', (_e, s: string, k: string) => store.del(s, k));
  ipcMain.handle('store:keys', (_e, s: string) => store.keys(s));
  ipcMain.handle('store:clear', (_e, s: string) => store.clear(s));
  ipcMain.handle('store:getMany', (_e, s: string, ks: unknown[]) => store.getMany(s, ks));
  ipcMain.handle('store:setMany', (_e, s: string, es: [unknown, unknown][]) => store.setMany(s, es));
  ipcMain.handle('store:delMany', (_e, s: string, ks: unknown[]) => store.delMany(s, ks));
}

function wireFiles(): void {
  ipcMain.handle('files:pickOpen', () => files.pickOpen(current()));
  ipcMain.handle('files:pickSave', (_e, suggested: unknown) => files.pickSave(current(), suggested));
  ipcMain.handle('files:pickImport', () => files.pickImport(current()));
  ipcMain.handle('files:write', (_e, path: unknown, data: unknown) => files.write(path, data));
  ipcMain.handle('files:read', (_e, path: unknown) => files.read(path));
  ipcMain.handle('files:exists', (_e, path: unknown) => files.exists(path));
}

function wireApp(): void {
  // "Start over" on this shell. clearAllData() has already wiped the store and
  // is asking for a first run, which in a page is a reload and here is a new
  // process - there is nothing to reload.
  ipcMain.on('app:relaunch', () => {
    log('info', 'relaunching');
    app.relaunch();
    app.exit(0);
  });
}

/**
 * Trust the paths the shelf already holds.
 *
 * files.ts refuses any path this process did not produce, which is the whole of
 * "a renderer cannot name a path" - but the shelf's file rows outlive the
 * process that made them, so on the second launch every one of them is a path
 * no dialog here opened. They come out of userData, which this process owns, so
 * reading them here and vouching for them is the same claim the dialog makes,
 * one source later.
 *
 * Read through store.ts rather than by hand, so there is one answer to where
 * the index lives. A failure is a shelf whose file rows all show as missing,
 * which is legible and repairable with Locate - not a reason to refuse to boot.
 */
async function vouchShelf(): Promise<void> {
  try {
    const index = await store.get('kv', 'library-index');
    if (!Array.isArray(index)) return;
    let n = 0;
    for (const row of index) {
      if (row && typeof row === 'object' && 'path' in row) {
        // SAFETY: the two tests on the line above are the check - a truthy
        // object that has the key - and the asserted shape says `unknown` for
        // the value, which is what it is. vouch() ignores a non-string.
        files.vouch((row as { path?: unknown }).path);
        n++;
      }
    }
    if (n) log('info', 'shelf file rows vouched for', { n });
  } catch (err) {
    log('warn', 'could not read the shelf index', err);
  }
}
