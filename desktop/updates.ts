// Auto-updates via electron-updater — downloads in the background,
// installs on quit. Portable copies and unsigned macOS builds get a
// release-page link instead. Skipped when !app.isPackaged.

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

/** Whether this copy can self-update (not portable, not unsigned macOS, not dev). */
function canInstall(): boolean {
  if (!app.isPackaged) return false;
  if (existsSync(join(dirname(app.getPath('exe')), 'portable'))) return false;
  // Build-time flag — no runtime API for "is this signed" without codesign.
  if (process.platform === 'darwin' && !process.env.MBRD_SIGNED) return false;
  return true;
}

/** Start checking. Called once, after the window is up (no network at boot). */
export function watchForUpdates(): void {
  if (armed) return;
  armed = true;
  void check();
  const timer = setInterval(() => void check(), EVERY_MS);
  // Unref'd so the timer cannot prevent exit.
  timer.unref?.();
}

/** What is available, or null. Safe to call at any time and from anywhere. */
export async function check(): Promise<Available | null> {
  if (!app.isPackaged) return null;
  try {
    // Lazy import — electron-updater is heavy (cert chain + HTTP stack).
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.autoDownload = canInstall();
    autoUpdater.autoInstallOnAppQuit = canInstall();
    autoUpdater.logger = null;

    const result = await autoUpdater.checkForUpdates();
    const version = result?.updateInfo?.version;
    if (!version || version === app.getVersion()) return null;

    found = { version, canInstall: canInstall() };
    log('info', 'an update is available', found);
    // Non-installable copies are told immediately; installable ones wait for download.
    if (!found.canInstall) announce(found);
    else autoUpdater.once('update-downloaded', () => announce(found));
    return found;
  } catch (err) {
    // Failed checks are not worth interrupting for — next check is 6 hours away.
    log('info', 'update check did not complete', { err: String(err) });
    return null;
  }
}

/** Arm the staged installer. It lands on the next quit and not before. */
export function install(): void {
  if (!found?.canInstall) return;
  void (async () => {
    const { autoUpdater } = await import('electron-updater');
    // Silent, no force-restart — the user chose to quit, not to be restarted.
    autoUpdater.quitAndInstall(true, false);
  })();
}

function announce(update: Available | null): void {
  if (!update) return;
  BrowserWindow.getAllWindows()[0]?.webContents.send('app:update', update);
}
