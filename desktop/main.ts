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
//
// ── The frame the app draws itself ──
//
// A native caption bar is the one rectangle in the window that obeys none of
// the board's palette, none of its corners and none of its whimsy dial. So the
// window has no title bar and web/assets/js/ui/window-chrome.ts draws one - the
// same strip of the app's own paper, in the app's own hairline, following the
// same look a board file carries.
//
// Three platforms, two options, and the difference is not a preference:
//
//   macOS    titleBarStyle 'hidden', which keeps the traffic lights. A Mac app
//            without them reads as broken and full-screen keeps working.
//            trafficLightPosition sets them inside the drawn bar rather than in
//            the window's own corner - see the note on that line.
//   Windows  the same option, which on Windows removes the caption and leaves
//            the frame's shadow and resize borders in place.
//   Linux    `frame: false`. titleBarStyle is macOS and Windows only there, and
//            setting it alone would leave a Linux build with its native bar.
//
// What is knowingly given up on Windows is the Snap Layouts flyout, which the
// system offers over a maximise button it can identify - and it can only
// identify one drawn by `titleBarOverlay`, which is the system's buttons in two
// colours rather than the app's. Snap by keyboard and by drag-to-edge are
// untouched. The three window commands go through `cmds` like every other
// user-facing action; this process only ever receives the request.
//
// ── The icon ──
//
// electron-builder already puts one on the installer, the executable and the
// .mbrd association, and none of that reaches a window. The taskbar button, the
// Alt-Tab card and the Linux window manager read the *window's* icon, and a
// BrowserWindow given none carries Electron's atom - so every unpackaged run,
// which is every run a person tests from desktop.bat, looks like a different
// application from the one it builds into.
//
// Set here rather than only in the packer, and read from `icons/` by path, so
// packaged and unpackaged windows carry the same picture. That is what puts
// `icons/` in electron-builder.yml's `files` list: without it the asar has no
// such directory and a packaged Linux window falls back to the atom again.
//
// macOS is the exception at both ends. It ignores a BrowserWindow icon
// entirely - the dock reads the bundle, which is the .icns electron-builder
// already ships - so the only gap there is an unpackaged run, and `dock.setIcon`
// below closes that one.
//
// **Generated, not drawn.** web/assets/img/icon.svg is where the icon is
// designed and `node tools/gen-desktop-icons.mjs` renders the three files.
// Editing anything under desktop/icons/ by hand is editing a build artefact.

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import type { BrowserWindowConstructorOptions, IpcMainEvent } from 'electron';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { registerSchemes, serveWeb, APP_INDEX, APP_ORIGIN, APP_PATCH } from './protocol.ts';
import { initLog, log } from './log.ts';
import { installMenu } from './menu.ts';
import * as store from './store.ts';
import * as files from './files.ts';
// The three native answers. Each is imported for its `available()` and loads
// its own heavy dependency on first use - see the note in each file: sharp and
// onnxruntime-node are tens of megabytes of binary, and loading them at startup
// would cost every launch for a feature most sessions never touch.
import * as ffmpeg from './native/ffmpeg.ts';
import * as matte from './native/matte.ts';
import * as decode from './native/decode.ts';
import * as updates from './updates.ts';

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

/**
 * Files the OS asked for before there was a window to hand them to.
 *
 * macOS fires `open-file` for a double-clicked document and it can arrive
 * *before* `ready` - which is the one ordering in this file that cannot be
 * rearranged away, because the event is how the app learns why it was launched.
 * Held here and delivered once the renderer says it is listening.
 */
const pending: string[] = [];

/**
 * What a portable copy had to say about where its data went, if anything.
 *
 * Read by the renderer once, at boot, so it can toast. Empty on every ordinary
 * run, which is most of them.
 */
let startupNote = '';

/**
 * A copy that keeps its data beside itself, and the one way that fails.
 *
 * The installer writes a `portable` marker next to the executable when somebody
 * chose that branch - see installer.nsh, which also says what portable promises
 * and therefore gives up. This is the app's half: put userData in `data/` next
 * to the exe, so the folder is the whole of the app and a USB stick carries it
 * off intact.
 *
 * **On a read-only medium it falls back and says so**, which is plan §1's
 * decision. A CD, a write-protected stick, a folder under Program Files that a
 * standard user cannot write to - all of them are ordinary, and none of them
 * should be a copy that refuses to start. The data goes where Electron would
 * have put it and one toast names the folder, so somebody who came back to an
 * empty board knows why.
 *
 * Runs before `ready`, because `app.setPath('userData', ...)` after that point
 * is ignored - the session has already been created against the old one.
 */
function claimPortableData(): void {
  const beside = dirname(app.getPath('exe'));
  if (!existsSync(join(beside, 'portable'))) return;
  const data = join(beside, 'data');
  try {
    mkdirSync(data, { recursive: true });
    // `recursive: true` does not fail on a read-only medium until something is
    // actually written, so the directory being there is not yet proof it can be
    // used. One probe file is.
    const probe = join(data, '.writable');
    writeFileSync(probe, '');
    unlinkSync(probe);
    app.setPath('userData', data);
  } catch (err) {
    startupNote = 'This folder cannot be written to, so mbrd is keeping your '
      + 'boards in ' + app.getPath('userData') + ' for this run.';
    // Not through log(), which has no file yet: initLog() runs after `ready`
    // and this runs before it. Said again there, once there is somewhere to
    // say it.
    console.warn('[mbrd] portable data folder refused:', err);
  }
}

function main(): void {
  claimPortableData();
  registerSchemes();

  // Registered before `ready` for the reason above. `preventDefault` is
  // required or macOS treats the event as unhandled.
  app.on('open-file', (event, path) => {
    event.preventDefault();
    handOver([path]);
  });

  // Windows and Linux instead: a second launch with a file on its command line.
  // The lock was taken at the top of this file, so the second process is
  // already on its way out; this is where its argument arrives.
  app.on('second-instance', (_event, argv) => {
    const win = current();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    handOver(boardsIn(argv));
  });

  app.whenReady().then(async () => {
    initLog();
    // The dock, on macOS only, and only when there is no bundle to read one
    // from. A packaged copy already carries the .icns and setting it again here
    // would be this process overriding the thing it was installed with.
    if (process.platform === 'darwin' && !app.isPackaged) {
      app.dock?.setIcon(join(__dirname, '..', 'icons', 'icon.png'));
    }
    // Said again now there is a file to say it in - see claimPortableData(),
    // which runs before the log exists.
    if (startupNote) log('warn', 'portable fallback', { note: startupNote });
    serveWeb();
    wireStore();
    wireFiles();
    wireApp();
    wireNative();
    installMenu(cmd => current()?.webContents.send('app:command', cmd));
    // Before the window, so the shelf's file rows are already vouched for when
    // the page asks whether their files still exist - see files.ts's `known`.
    await vouchShelf();
    // Not awaited and not allowed to delay a window: a `.trash-` directory is
    // bytes nobody can reach, left behind by a wipe whose delete failed after
    // its rename had already emptied the store.
    void store.sweepTrash();
    // The first launch's own command line, which is neither of the two events
    // above: double-clicking a .mbrd when the app is *not* running starts it
    // with the path in argv and fires nothing.
    handOver(boardsIn(process.argv));
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

/**
 * The app's icon on disk, as a path.
 *
 * `__dirname` is dist/, so this walks up to the package root - which is
 * `desktop/` unpackaged and `app.asar` packaged. One expression covers both,
 * which is the whole reason the file is read by path rather than bundled.
 *
 * The .ico on Windows and not the .png: an .ico carries 16, 24, 32, 48, 64 and
 * 256 as separate drawings, and Windows asks for the small ones constantly - in
 * the taskbar, in Alt-Tab, in the title of a dialog. Handed one 512px PNG it
 * downscales, and the strokes of this icon go to mud at 16px.
 */
function iconPath(): string {
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return join(__dirname, '..', 'icons', file);
}

function createWindow(): BrowserWindow {
  const options: BrowserWindowConstructorOptions = {
    width: 1280,
    height: 840,
    minWidth: 480,
    minHeight: 400,
    // The board paints its own background before anything else; a white flash
    // in front of it is the one frame that says "web page" out loud.
    backgroundColor: '#000000',
    show: false,
    // No caption bar anywhere; the page draws one. See the head of this file
    // for why Linux takes the other option rather than the same one. Both
    // branches carry a property, which is what keeps this one a spread and the
    // two platform lines below plain statements.
    ...(process.platform === 'linux'
      ? { frame: false }
      : { titleBarStyle: 'hidden' as const }),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Relative to dist/, which is where both bundles land - see the build
      // script in package.json.
      preload: join(__dirname, 'preload.js'),
    },
  };

  if (process.platform === 'darwin') {
    // macOS keeps its traffic lights, so they are placed rather than left in
    // the corner. 18 across, and 10 down centres the 12px cluster in the 32px
    // bar the page draws - --frame-bar-h in chrome.css, and the two numbers
    // have to be changed together. They used to sit a whole row lower, level
    // with the app's own controls, back when there was no bar to be inside.
    options.trafficLightPosition = { x: 18, y: 10 };
  } else {
    // The taskbar button and the Alt-Tab card. See the head of this file for
    // why macOS is absent from this and what stands in for it there.
    options.icon = iconPath();
  }

  const win = new BrowserWindow(options);

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
  //
  // The changelog is the one exception, and it is answered rather than allowed.
  // See openChangelog() for why a window is the right answer and why this one
  // must not simply go there.
  win.webContents.on('will-navigate', (event, url) => {
    if (url === APP_PATCH || url === APP_PATCH + '.html') {
      event.preventDefault();
      openChangelog();
      return;
    }
    if (url.startsWith(APP_ORIGIN + '/')) return;
    event.preventDefault();
    log('warn', 'refused a navigation', { url });
  });

  // Reload, bound here rather than left to the menu, because this window has no
  // menu bar to carry an accelerator.
  //
  // Measured on Windows: `Menu.getApplicationMenu()` holds the View menu and its
  // Reload row with CmdOrCtrl+R on it, and `win.isMenuBarVisible()` is false -
  // the caption went and the menu bar went with it. An accelerator on a menu bar
  // that is not drawn is an accelerator nothing presses, and the failure is
  // silent in the worst way: the row is in the menu, it works when clicked, and
  // the keystroke does nothing. Every *other* accelerator in menu.ts survives
  // that only because canvas/input.ts binds the same keys inside the page.
  //
  // `before-input-event` is the renderer's own input path, so it fires with or
  // without a menu bar. Kept off macOS, where the application menu is the
  // system's, is always there, and already delivers this - two handlers would
  // reload twice.
  if (process.platform !== 'darwin') {
    win.webContents.on('before-input-event', (event, input) => {
      const reload = input.key.toLowerCase() === 'r' && (input.control || input.meta);
      if (input.type !== 'keyDown' || !reload || input.alt || input.shift) return;
      event.preventDefault();
      win.webContents.reload();
    });
  }

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
  // Per window, not in wireApp(): these are subscriptions on this window's own
  // events, and a second window in one session needs its own set.
  reportFrame(win);
  // Anything the OS handed over before there was a window. The page waits for
  // its own boot to finish before opening one, so this only has to wait for a
  // renderer that can receive a message.
  win.webContents.once('did-finish-load', () => {
    void deliver();
    // After the board is on screen, not before it. The first thing a launch
    // should do is show a board; a network call in front of that is a network
    // call the person waits through.
    updates.watchForUpdates();
  });
  win.loadURL(APP_INDEX).catch(err => log('error', 'could not load the app', err));
  return win;
}

/** The changelog window, while there is one. At most one is ever open. */
let changelog: BrowserWindow | null = null;

/**
 * The changelog, in a window of its own with the system's own caption on it.
 *
 * On the web the What Changed row navigates the page - commands/view.ts argues
 * that at length, and the argument holds there. It does not hold here, for a
 * reason that is about this shell and not about the changelog: **web/patch.html
 * carries none of the app's furniture and loads no bundle.** It is index.html's
 * head and the prose, nothing else. So it has no #window-drag and no
 * #window-controls, and ui/window-chrome.ts is not there to unhide them - which
 * in a window whose caption bar was taken away means a document with no way to
 * be moved, minimised or closed except the keyboard. Navigating in place would
 * have turned one blank screen into a stuck one.
 *
 * So this window keeps the frame the main one gives up. That is the honest shape
 * anyway: the changelog is a document, and a document window with the system's
 * caption on it is what every desktop already knows how to close. The board
 * stays where it was in the window behind, which is the one thing the web
 * version had to give up to avoid a flashing tab.
 *
 * No preload, and that is deliberate rather than an omission. The ports exist so
 * a *board* can reach the disk, the store and the native helpers; the changelog
 * asks for none of it and a page that runs no bundle has nothing to call them
 * with. The window is sandboxed, isolated, and can navigate nowhere but itself.
 */
function openChangelog(): void {
  if (changelog && !changelog.isDestroyed()) {
    if (changelog.isMinimized()) changelog.restore();
    changelog.focus();
    return;
  }

  const options: BrowserWindowConstructorOptions = {
    width: 760,
    height: 900,
    minWidth: 360,
    minHeight: 320,
    // Overridden by the page's own <title> the moment it commits. Set anyway,
    // because the taskbar button exists before that and an untitled one reads
    // as a window that failed to open.
    title: 'What Changed',
    backgroundColor: '#000000',
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  };
  if (process.platform !== 'darwin') options.icon = iconPath();

  const win = new BrowserWindow(options);
  changelog = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { changelog = null; });

  // No menu bar on this one. It has a frame, so unlike the main window it would
  // be given the application menu - and every row in that menu acts on the
  // board, which is in the other window. installMenu() sends to
  // `getAllWindows()[0]`, so those rows would reach past this window to a board
  // the reader cannot see acting on it.
  if (process.platform !== 'darwin') win.setMenu(null);

  // Which leaves this window with no accelerator at all, so the two a document
  // window is expected to answer are bound by hand.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const close = input.key === 'Escape'
      || (input.key.toLowerCase() === 'w' && (input.control || input.meta));
    if (!close) return;
    event.preventDefault();
    win.close();
  });

  // The same two doors as the main window, and shut the same way. The changelog
  // is prose with links in it, so this one is load-bearing rather than
  // theoretical: a link to a repository or a licence belongs in the reader's
  // browser and not in a window of this app wearing this app's origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(safeProtocol(url))) {
      shell.openExternal(url).catch(err => log('warn', 'could not open a link', { url, err: String(err) }));
    } else {
      log('warn', 'refused to open a link', { url });
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url === APP_PATCH || url === APP_PATCH + '.html') return;
    event.preventDefault();
    log('warn', 'refused a navigation from the changelog', { url });
  });

  win.loadURL(APP_PATCH).catch(err => log('error', 'could not load the changelog', err));
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
// Open-with
// ---------------------------------------------------------------------------

/**
 * The boards on a command line, and nothing else that happens to be on it.
 *
 * argv carries the executable, Electron's own switches, and in development the
 * `.` that named the app directory. Filtering on the extension rather than
 * taking the last argument is what keeps `--inspect` or a stray flag from being
 * read as a file - and a file that is not a `.mbrd` is not something this app
 * opens as a board anyway.
 */
function boardsIn(argv: readonly string[]): string[] {
  return argv.filter(arg => /\.mbrd$/i.test(arg) && !arg.startsWith('-'));
}

/**
 * Read the files and hand them to the page, once there is a page.
 *
 * Held rather than dropped when the window is not up yet: on macOS this is
 * routinely called before `ready`, and on every OS the first launch reads argv
 * before the renderer has finished booting. The renderer's own side waits for
 * `started` too - see main.ts in web/ - so a file handed over during the
 * session restore is opened after it rather than racing it.
 */
function handOver(paths: string[]): void {
  if (!paths.length) return;
  pending.push(...paths);
  void deliver();
}

async function deliver(): Promise<void> {
  const win = current();
  if (!win || !pending.length) return;
  const paths = pending.splice(0, pending.length);
  try {
    const handed = await Promise.all(paths.map(p => files.read(vouched(p))));
    win.webContents.send('app:open-files', handed);
    log('info', 'handed over', { paths });
  } catch (err) {
    log('error', 'could not open a file the OS handed over', { paths, err: String(err) });
  }
}

/**
 * A path the OS gave us is a path this process produced.
 *
 * files.ts refuses anything it did not vouch for, which is the whole of "a
 * renderer cannot name a path" - and an argument on our own command line, or a
 * document the Finder double-clicked, is as much this process's own as a dialog
 * result. Vouching for it here is where that claim is made, in one place, where
 * it can be read.
 */
function vouched(path: string): string {
  files.vouch(path);
  return path;
}

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

  // What the title bar says, and on macOS what the proxy icon points at and
  // whether the close button has a dot in it. Reported by storage.ts whenever
  // the document, the board's name or the dirty flag changes.
  ipcMain.on('app:document', (_e, state: unknown) => showDocument(state));

  // Anything the shell needs to tell the person that the page could not have
  // known. One string, read once at boot, empty on every ordinary run.
  ipcMain.handle('app:startupNotes', () => startupNote);

  // The updater's two questions. `check` is also what the renderer calls at
  // boot, so an update found before the window existed is not lost.
  ipcMain.handle('updates:check', () => updates.check());
  ipcMain.on('updates:install', () => updates.install());

  // The three the drawn title bar asks for. Each acts on **the window that
  // asked**, found from the sender, rather than on current(): with two windows
  // open on macOS a close routed by position would shut the wrong board, and
  // the difference is invisible in the one-window case every test runs in.
  //
  // `close()` and not `destroy()`. The close is the same close the system menu
  // and Cmd-W make, so holdCloseForFlush() below still holds it open until the
  // page has finished writing - a button that skipped that would be the one way
  // out of this app that loses the last sentence of a note.
  ipcMain.on('window:minimize', e => asker(e)?.minimize());
  ipcMain.on('window:maximize', e => {
    const win = asker(e);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window:close', e => asker(e)?.close());
}

/** The window an IPC message came from, or null if it has already gone. */
const asker = (e: IpcMainEvent) => BrowserWindow.fromWebContents(e.sender);

/**
 * Tell the page what shape the window is in, whenever that changes.
 *
 * The drawn title bar has one glyph that is not an action - the maximise button
 * shows a restore mark while the window is maximised - and there is no way to
 * read that from inside the page. It also hides itself in full screen, where
 * the system draws its own way out.
 *
 * Pushed rather than asked, and pushed on the same channel for all four events,
 * because the page wants the *state* and not the transition: a renderer that
 * had to keep a tally of maximises and unmaximises would drift the first time
 * the window manager did one of them on its own - which Windows does on every
 * drag to the top edge, and macOS does on every green-button zoom.
 */
function reportFrame(win: BrowserWindow): void {
  const send = () => {
    // A window mid-close has a destroyed webContents and sending to it throws.
    if (win.isDestroyed()) return;
    win.webContents.send('app:frame', {
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
    });
  };
  // Four calls rather than a loop over the names: BrowserWindow's `on` is a
  // wall of per-event overloads, and a union of event names picks the last one
  // and fails to typecheck. Written out, each resolves on its own.
  win.on('maximize', send);
  win.on('unmaximize', send);
  win.on('enter-full-screen', send);
  win.on('leave-full-screen', send);
  // The first one, on the load rather than on an event: a window restored from
  // a previous session can arrive already maximised, and without this its
  // button would draw the maximise mark until somebody pressed it.
  win.webContents.on('did-finish-load', send);
}

/**
 * The native side of the four ports that have one.
 *
 * Every handler answers `null` where it cannot help, which is the whole
 * protocol: the renderer asks first and falls through, so a build with no
 * ffmpeg beside it is a slower desktop rather than a broken one. The two
 * `available` channels exist so the renderer can *offer* a feature - the
 * Optimise row's video branch - rather than offering it and then failing.
 */
function wireNative(): void {
  ipcMain.handle('native:can', () => ({
    transcode: ffmpeg.available(),
    matte: matte.available(),
  }));
  ipcMain.handle('native:firstFrame', (_e, bytes: unknown) =>
    bytes instanceof ArrayBuffer ? ffmpeg.firstFrame(bytes) : null);
  ipcMain.handle('native:transcode', (_e, bytes: unknown, opts: unknown) => {
    if (!(bytes instanceof ArrayBuffer)) return null;
    // SAFETY: what arrives is two optional numbers from the renderer, and
    // ffmpeg.ts clamps both before they reach a command line - see the Math.max
    // on each. The assertion names a shape whose every field is already treated
    // as untrusted on the far side.
    return ffmpeg.transcode(bytes, (opts ?? {}) as ffmpeg.TranscodeOpts);
  });
  ipcMain.handle('native:matte', (_e, input: unknown) =>
    input instanceof Float32Array ? matte.matte(input) : null);
  ipcMain.handle('native:decode', (_e, bytes: unknown, name: unknown) =>
    bytes instanceof ArrayBuffer && typeof name === 'string' ? decode.decode(bytes, name) : null);
}

/** The document, in the window's furniture. */
function showDocument(state: unknown): void {
  const win = current();
  if (!win || !state || typeof state !== 'object') return;
  // SAFETY: the truthy-object test on the line above is the check, and every
  // field below is read as `unknown` and narrowed before use - this arrives
  // from the renderer, which is exactly the boundary main does not trust.
  const { title, name, path, dirty } = state as {
    title?: unknown, name?: unknown, path?: unknown, dirty?: unknown,
  };

  // The file's name leads where there is one, because on the desktop the file
  // *is* the board and the file name is what the person will look for in a
  // folder. The board's own title follows it, and is the whole of the title on
  // a board that has never been saved.
  const file = typeof name === 'string' ? name : '';
  const board = typeof title === 'string' && title ? title : 'Untitled board';
  const mark = dirty === true ? '• ' : '';
  win.setTitle(mark + (file ? `${file} — ${board}` : board) + ' — mbrd');

  if (process.platform !== 'darwin') return;
  // macOS says both of these in its own furniture rather than in the text: the
  // proxy icon is the file, draggable out of the title bar, and the dot in the
  // close button is the unsaved mark. Setting them is what makes the window
  // read as a document window rather than a page.
  win.setRepresentedFilename(typeof path === 'string' ? path : '');
  win.setDocumentEdited(dirty === true);
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
