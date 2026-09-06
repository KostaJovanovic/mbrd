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

import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { registerSchemes, serveWeb, APP_INDEX, APP_ORIGIN } from './protocol.ts';
import { initLog, log } from './log.ts';

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

  app.whenReady().then(() => {
    initLog();
    serveWeb();
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

  win.loadURL(APP_INDEX).catch(err => log('error', 'could not load the app', err));
  return win;
}

/** The scheme of a URL, or nothing where it is not a URL at all. */
function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}
