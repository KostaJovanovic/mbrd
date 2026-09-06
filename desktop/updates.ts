// New versions, and the two shapes that can take.
//
// On the web the service worker is the updater: a new build ships, the worker
// self-promotes, and main.ts toasts "reload to update". There is no worker
// here - it is deliberately not registered on the desktop - so this is the same
// sentence with a different mechanism behind it.
//
// ── Install on quit, never under a person ──
//
// electron-updater can download in the background and stage the installer for
// the next quit, which is the whole of what this does. The alternative is an
// app that restarts itself, and this one is a canvas somebody is in the middle
// of moving things around on: a restart under a hand is a lost gesture at best.
// So the toast says "v0.281 will install when you quit" and then nothing
// happens until they quit.
//
// ── Two copies cannot update themselves, and they are told so ──
//
// A **portable** copy: electron-updater replaces an *installed* application,
// and portable's whole promise is that it wrote nothing an installer could
// replace. See installer.nsh, which is where that promise is kept.
//
// An **unsigned macOS** build: Squirrel.Mac refuses an unsigned update outright.
// Not a policy this app chose - Apple's - and it stands until there is a
// Developer ID.
//
// Both get a notice with a link to the release page instead of a button that
// cannot work. `canInstall: false` is how that is said, and the renderer draws
// the difference.
//
// ── Never in a dev run ──
//
// The first line of check() is `app.isPackaged`. desktop/package.json carries
// version 0.0.0 on purpose - the release workflow stamps the real one - so an
// unpackaged run would find every release on GitHub newer than itself and
// offer to install it over a working tree. That is the plan's §12 note and it
// is one line here.

import { app, BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { log } from './log.ts';

/** What the renderer is told. The same shape platform.ts's UpdateInfo has. */
export interface Available {
  version: string;
  canInstall: boolean;
}

/** Six hours. Long enough to be invisible, short enough to matter in a day. */
const EVERY_MS = 6 * 60 * 60 * 1000;

let found: Available | null = null;
let armed = false;

/**
 * Whether this copy can replace itself.
 *
 * Portable is the marker beside the executable - the same file main.ts reads to
 * decide where its data goes. macOS is signed or it is not, and an unpackaged
 * build is neither: `app.isPackaged` is false in development, where there is
 * nothing to update and no honest version to compare.
 */
function canInstall(): boolean {
  if (!app.isPackaged) return false;
  if (existsSync(join(dirname(app.getPath('exe')), 'portable'))) return false;
  // Signed or not. There is no API for "is this signed" that does not shell out
  // to codesign, so this is the build-time answer: the workflow sets it when it
  // has an identity to sign with, and until then macOS is notice-only.
  if (process.platform === 'darwin' && !process.env.MBRD_SIGNED) return false;
  return true;
}

/**
 * Start looking. Called once, after the window is up.
 *
 * After rather than before, because the first thing a launch should do is show
 * a board, and a network call at boot is a network call in front of that.
 */
export function watchForUpdates(): void {
  if (armed) return;
  armed = true;
  void check();
  const timer = setInterval(() => void check(), EVERY_MS);
  // Unref'd so a timer cannot be the reason a process refuses to exit. The app
  // quitting matters more than a check that was about to happen.
  timer.unref?.();
}

/** What is available, or null. Safe to call at any time and from anywhere. */
export async function check(): Promise<Available | null> {
  if (!app.isPackaged) return null;
  try {
    // Imported here rather than at the top, on the same terms as the native
    // modules: electron-updater pulls in a certificate chain and an HTTP stack
    // that a launch which never checks does not need.
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.autoDownload = canInstall();
    autoUpdater.autoInstallOnAppQuit = canInstall();
    autoUpdater.logger = null;

    const result = await autoUpdater.checkForUpdates();
    const version = result?.updateInfo?.version;
    if (!version || version === app.getVersion()) return null;

    found = { version, canInstall: canInstall() };
    log('info', 'an update is available', found);
    // Told once it is actually here, on a copy that can install it: a toast
    // saying "will install when you quit" before the bytes have arrived is a
    // promise the app might not keep.
    if (!found.canInstall) announce(found);
    else autoUpdater.once('update-downloaded', () => announce(found));
    return found;
  } catch (err) {
    // A check that fails is not news. No network, a rate limit, a release with
    // no assets for this platform - none of them is something to interrupt
    // somebody about, and the next check is six hours away.
    log('info', 'update check did not complete', { err: String(err) });
    return null;
  }
}

/** Arm the staged installer. It lands on the next quit and not before. */
export function install(): void {
  if (!found?.canInstall) return;
  void (async () => {
    const { autoUpdater } = await import('electron-updater');
    // `isSilent` true, `isForceRunAfter` false: the person asked for the update
    // and did not ask to be restarted into it.
    autoUpdater.quitAndInstall(true, false);
  })();
}

function announce(update: Available | null): void {
  if (!update) return;
  BrowserWindow.getAllWindows()[0]?.webContents.send('app:update', update);
}
