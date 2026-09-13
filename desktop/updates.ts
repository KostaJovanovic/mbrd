// Updates from the public release repo, answered in native dialogs. A port of
// FileAnalyser's desktop/updater.mjs: one request to GitHub's API gives the
// latest tag, each file's URL and the SHA-256 GitHub computed for it. A download
// that does not match its digest never takes over, and a release with no digest
// never installs. No electron-updater, no latest.yml. A dev copy never checks.

import { app, dialog, net, shell } from 'electron';
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { log } from './log.ts';

// The source repo is private, and GitHub answers its releases with a 404 to
// anybody signed out. research/apps-2026-09-13.md §1 #31.
const OWNER = 'KostaJovanovic';
const REPO = 'mbrd-release';
/** The one page every build can be downloaded from. */
export const DOWNLOAD_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

/** A release file's name ends in the version (mbrd-Windows-0.302.0.exe), so a
 *  file is found by the part before it. The unversioned name still matches. */
export const INSTALLER_ASSET = /^mbrd-Windows(-\d+(\.\d+)*)?\.exe$/;
export const APPIMAGE_ASSET = /^mbrd-linux-x64(-\d+(\.\d+)*)?\.AppImage$/;

const ASSET = {
  installer: { name: 'mbrd-Windows-<version>.exe', match: INSTALLER_ASSET },
  appimage: { name: 'mbrd-linux-x64-<version>.AppImage', match: APPIMAGE_ASSET },
};

/** The first check waits for start-up to settle, then one runs every six hours. */
const FIRST_CHECK_MS = 20 * 1000;
const EVERY_MS = 6 * 60 * 60 * 1000;

/** How this copy was installed, and so what an update can do to it. */
export type Kind = 'dev' | 'installer' | 'appimage' | 'manual';

/** What main.ts hands over: the board window, and whether this copy is portable. */
export interface UpdateOptions {
  window: () => BrowserWindow | null;
  portable: boolean;
}

interface Asset { name: string, url: string, digest: string }
interface Release { version: string, assets: Asset[] }

/** The fields read from GitHub's answer. Each is checked where it is read. */
interface ApiRelease { tag_name?: unknown, assets?: unknown }
interface ApiAsset { name?: unknown, digest?: unknown, browser_download_url?: unknown }

let kind: Kind = 'dev';
let portableCopy = false;
let getWindow: () => BrowserWindow | null = () => null;
let started = false;
let busy = false;
/** A downloaded update waiting to take over, or null. */
let ready: { version: string, file: string } | null = null;
/** The installer was started, so quitting must not start it twice. */
let launched = false;
/** Versions the user answered "Later" to. The automatic check stays quiet about
 *  them for the rest of the session. The menu entry still reports them. */
const declined = new Set<string>();

/**
 * How this copy was installed.
 *
 * `installer` is the Windows install, whose uninstaller sits beside the exe:
 * the new installer downloads in the background and runs silently when the app
 * quits, or at once on "Restart now". `appimage` is Linux: the new file takes
 * the old one's place. `manual` only announces a new version: a portable copy,
 * and macOS, where an app with no Developer ID signature cannot install one.
 */
export function installKind(portable: boolean): Kind {
  if (!app.isPackaged) return 'dev';
  if (process.platform === 'win32') {
    if (portable) return 'manual';
    // A portable copy has no uninstaller, and must not be "updated" by an
    // installer that would put a second copy somewhere else. electron-builder
    // names it "Uninstall ${productName}.exe", and productName is app.getName().
    const uninstaller = join(dirname(app.getPath('exe')), `Uninstall ${app.getName()}.exe`);
    return existsSync(uninstaller) ? 'installer' : 'manual';
  }
  if (process.platform === 'linux' && process.env.APPIMAGE) return 'appimage';
  return 'manual';
}

/** Start the automatic checks. main.ts calls it once the board has painted. */
export function startUpdates(opts: UpdateOptions): void {
  // macOS makes a new window on a dock click, and the checks must not arm twice.
  if (started) return;
  started = true;
  portableCopy = opts.portable;
  kind = installKind(portableCopy);
  getWindow = opts.window;
  log('info', 'updates', { kind });
  if (kind === 'dev') return;
  if (kind === 'installer') {
    rmSync(downloadDir(), { recursive: true, force: true });
    // "Later" still installs: the downloaded installer runs as the app closes,
    // silently, without starting the app again.
    app.on('will-quit', () => runInstaller(false));
  }
  const image = process.env.APPIMAGE;
  if (kind === 'appimage' && image) {
    for (const stale of [image + '.new', image + '.new.part']) rmSync(stale, { force: true });
  }
  setTimeout(() => void check(false), FIRST_CHECK_MS);
  setInterval(() => void check(false), EVERY_MS).unref();
}

/** Help > Check for updates, and the panel row. Unlike the automatic check, it always answers. */
export function checkForUpdates(): Promise<void> {
  return check(true);
}

/** '0.302.0' -> '0.302', the label the app shows. */
const label = (v: string) => v.replace(/\.0$/, '');

/** True when version `a` is newer than `b`, compared number by number. */
function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

const downloadDir = () => join(app.getPath('temp'), 'mbrd-update');

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function latestRelease(): Promise<Release> {
  const res = await net.fetch(API, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error('GitHub answered ' + res.status);
  const body: unknown = await res.json();
  if (!body || typeof body !== 'object') throw new Error('GitHub answered with no release');
  // SAFETY: a non-null object, and every field of ApiRelease is unknown and checked below.
  const rel = body as ApiRelease;
  const assets: Asset[] = [];
  for (const entry of Array.isArray(rel.assets) ? rel.assets : []) {
    if (!entry || typeof entry !== 'object') continue;
    // SAFETY: a non-null object, and every field of ApiAsset is unknown and checked below.
    const { name, digest, browser_download_url: url } = entry as ApiAsset;
    if (typeof name !== 'string' || typeof url !== 'string') continue;
    assets.push({ name, url, digest: typeof digest === 'string' ? digest : '' });
  }
  const tag = typeof rel.tag_name === 'string' ? rel.tag_name : '';
  return { version: tag.replace(/^v/, ''), assets };
}

/** Download a release asset to `dest`, hashing as it streams. Nothing lands at
 *  `dest` unless the SHA-256 matches the digest GitHub gives for the file. */
async function download(asset: Asset, dest: string): Promise<void> {
  const want = /^sha256:([0-9a-f]{64})$/.exec(asset.digest);
  if (!want) throw new Error('the release gives no SHA-256 for ' + asset.name);
  const res = await net.fetch(asset.url);
  if (!res.ok || !res.body) throw new Error('the download failed: ' + res.status);
  mkdirSync(dirname(dest), { recursive: true });
  const part = dest + '.part';
  const hash = createHash('sha256');
  const out = createWriteStream(part);
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      if (!out.write(value)) await new Promise<void>(resolve => out.once('drain', () => resolve()));
    }
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.end(() => resolve());
    });
  } catch (err) {
    out.destroy();
    rmSync(part, { force: true });
    throw err;
  }
  if (hash.digest('hex') !== want[1]) {
    rmSync(part, { force: true });
    throw new Error('the download does not match its SHA-256');
  }
  rmSync(dest, { force: true });
  renameSync(part, dest);
}

/** Fetch the update for a self-updating copy, and leave it ready to take over.
 *  `asset.name` matched ASSET's pattern, so it carries no path separator. */
async function fetchUpdate(version: string, asset: Asset): Promise<void> {
  if (kind === 'installer') {
    const file = join(downloadDir(), asset.name);
    await download(asset, file);
    ready = { version, file };
    return;
  }
  // Beside the running AppImage, so the rename below stays on one disk. Linux
  // lets a running file be replaced: this copy keeps running from the old one
  // until it quits.
  const target = process.env.APPIMAGE;
  if (!target) throw new Error('APPIMAGE is not set');
  const next = target + '.new';
  await download(asset, next);
  chmodSync(next, 0o755);
  renameSync(next, target);
  ready = { version, file: target };
}

function runInstaller(restart: boolean): void {
  if (kind !== 'installer' || !ready || launched) return;
  launched = true;
  const args = ['/S', '--updated'];
  if (restart) args.push('--force-run');
  log('info', 'running the update installer', { version: ready.version, restart });
  spawn(ready.file, args, { detached: true, stdio: 'ignore' })
    .on('error', err => log('error', 'the update installer did not start', { err: String(err) }))
    .unref();
}

async function check(manual: boolean): Promise<void> {
  if (kind === 'dev') {
    if (manual) tell('Updates are off in a development copy', 'This copy runs the code in the desktop folder, so there is nothing to update.');
    return;
  }
  if (ready) {
    if (manual) offerRestart();
    return;
  }
  if (busy) {
    if (manual) tell('mbrd is already checking for an update', 'Try again in a moment.');
    return;
  }
  busy = true;
  try {
    const rel = await latestRelease();
    if (!newer(rel.version, app.getVersion())) {
      if (manual) tell('mbrd is up to date', `Version ${label(app.getVersion())} is the latest release.`);
      return;
    }
    if (kind === 'installer' || kind === 'appimage') {
      const want = ASSET[kind];
      const asset = rel.assets.find(a => want.match.test(a.name));
      if (!asset) throw new Error('the release has no ' + want.name);
      if (manual) tell(`mbrd ${label(rel.version)} is downloading`, 'A message offers a restart as soon as the download is done.');
      await fetchUpdate(rel.version, asset);
      log('info', 'an update is ready', { version: rel.version });
      offerRestart();
      return;
    }
    if (manual || !declined.has(rel.version)) offerDownload(rel.version);
  } catch (err) {
    // A background failure (offline, GitHub down, a bad download) stays
    // silent, and the next check tries again.
    log('info', 'update check did not complete', { err: errorText(err) });
    if (manual) {
      tell('mbrd could not update',
        'Check the connection, then try again.\n\n' + errorText(err).slice(0, 300));
    }
  } finally {
    busy = false;
  }
}

function show(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const win = getWindow();
  const opts: MessageBoxOptions = { type: 'info', title: 'mbrd', noLink: true, ...options };
  const shown = win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
  return shown.catch(() => ({ response: -1, checkboxChecked: false }));
}

function tell(message: string, detail: string): void {
  void show({ message, detail, buttons: ['Close'] });
}

function offerRestart(): void {
  if (!ready) return;
  void show({
    message: `mbrd ${label(ready.version)} is ready`,
    detail: kind === 'installer'
      ? 'Restart now to finish the update, or keep working and it installs when you quit.'
      : 'Restart now to start the new version, or keep working and it starts next time.',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  }).then(r => {
    if (r.response !== 0) return;
    if (kind === 'installer') {
      // The installer waits for this copy to close, installs, then starts the
      // new version (--force-run).
      runInstaller(true);
    } else {
      // relaunch starts the new file once this process has gone, so the two
      // never meet at the single-instance lock.
      app.relaunch({ execPath: process.env.APPIMAGE, args: [] });
    }
    app.quit();
  });
}

function offerDownload(version: string): void {
  let how: string;
  if (process.platform === 'darwin') {
    how = 'Download it, then drag it into Applications to replace this copy. Your boards and settings stay.';
  } else if (portableCopy) {
    how = 'Download the new Windows file, run it, choose Portable, and pick this folder. The data folder in it keeps the shelf and the recovery store.';
  } else {
    how = 'This copy cannot replace itself. Download the new version and use it in place of this one.';
  }
  void show({
    message: `mbrd ${label(version)} is out`,
    detail: how,
    buttons: ['Open the download page', 'Later'],
    defaultId: 0,
    cancelId: 1,
  }).then(r => {
    if (r.response === 0) {
      shell.openExternal(DOWNLOAD_PAGE).catch(err => log('warn', 'could not open the download page', { err: String(err) }));
    } else {
      declined.add(version);
    }
  });
}
