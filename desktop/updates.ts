// Updates from the public release repo. A port of FileAnalyser's
// desktop/updater.mjs: one request to GitHub's API gives the latest tag, each
// file's URL and the SHA-256 GitHub computed for it. A download that does not
// match its digest never takes over, and a release with no digest never
// installs. No electron-updater, no latest.yml. A dev copy never checks.
// Every answer goes to the title bar's Update button, never a native dialog. A
// check finds a new version, and a press on Update downloads it, then installs
// it (research/rapid-fixes-2026-09-14.md, R3).

import { app, net, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { log } from './log.ts';
import type { UpdateOffer } from './chrome/bridge.ts';

// The source repo is private, and GitHub answers its releases with a 404 to
// anybody signed out. research/old/apps-2026-09-13.md §1 #31.
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

/** The first look waits for start-up to settle. After that the clock looks
 *  every hour and checks when the last check is a day old, so a laptop asleep
 *  for a week checks within the hour it wakes, and a restart does not check
 *  again. The time of the last check is kept in the data folder. */
const FIRST_CHECK_MS = 20 * 1000;
const LOOK_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a passing answer ("Up to date") stays on the button. */
const PASSING_MS = 5000;

/** How this copy was installed, and so what an update can do to it. */
export type Kind = 'dev' | 'installer' | 'appimage' | 'manual';

/** What main.ts hands over: whether this copy is portable, and where to
 *  announce an update (the title bar's button). */
export interface UpdateOptions {
  portable: boolean;
  announce: (offer: UpdateOffer | null) => void;
}

interface Asset { name: string, url: string, digest: string }
interface Release { version: string, assets: Asset[] }

/** The fields read from GitHub's answer. Each is checked where it is read. */
interface ApiRelease { tag_name?: unknown, assets?: unknown }
interface ApiAsset { name?: unknown, digest?: unknown, browser_download_url?: unknown }

let kind: Kind = 'dev';
let portableCopy = false;
let started = false;
/** A check or a download is running. */
let busy = false;
/** Help > Check for updates was chosen, so the running check answers aloud. */
let asked = false;
/** The newer release this copy can install, found by the last check. */
let pending: { version: string, asset: Asset } | null = null;
/** A downloaded update waiting to take over, or null. */
let ready: { version: string, file: string } | null = null;
/** The installer was started, so quitting must not start it twice. */
let launched = false;
/** What the title bar's button says for good, or null for no button. */
let offered: UpdateOffer | null = null;
/** A passing answer's timer. When it runs out the button goes back to `offered`. */
let passing: ReturnType<typeof setTimeout> | null = null;
let announce: (offer: UpdateOffer | null) => void = () => {};

/** Put a lasting state on the button. */
function publish(offer: UpdateOffer | null): void {
  if (passing) clearTimeout(passing);
  passing = null;
  offered = offer;
  announce(offer);
}

/** Put a passing answer on the button, and after `ms` go back to what it said.
 *  With no `ms` it stays until the next answer replaces it. */
function say(offer: UpdateOffer, ms = 0): void {
  if (passing) clearTimeout(passing);
  passing = null;
  announce(offer);
  if (ms) passing = setTimeout(() => { passing = null; announce(offered); }, ms);
}

/** The button's state, for a title bar that loads after the answer came. */
export const currentOffer = (): UpdateOffer | null => offered;

const stampFile = () => join(app.getPath('userData'), 'update-check.json');

/** When the last check got an answer, in ms since the epoch. 0 when never. */
function lastCheck(): number {
  try {
    const at = Number(JSON.parse(readFileSync(stampFile(), 'utf8'))?.at);
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

function stamp(): void {
  try {
    writeFileSync(stampFile(), JSON.stringify({ at: Date.now() }));
  } catch (err) {
    log('warn', 'could not note the update check', { err: errorText(err) });
  }
}

/** A day since the last answer, or a clock set back past it. */
const due = () => {
  const since = Date.now() - lastCheck();
  return since >= DAY_MS || since < 0;
};

/**
 * How this copy was installed.
 *
 * `installer` is the Windows install, whose uninstaller sits beside the exe:
 * a press on Update downloads the new installer, which runs silently as the
 * app closes and starts the new version. `appimage` is Linux: the new file
 * takes the old one's place. `manual` only announces a new version: a
 * portable copy, a copy the Linux .deb installed (root owns its folder), and
 * macOS, where an app with no Developer ID signature cannot install one.
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
  announce = opts.announce;
  log('info', 'updates', { kind });
  if (kind === 'dev') return;
  if (kind === 'installer') {
    tidy(downloadDir(), true);
    // A download that finished as the window was closing still installs,
    // silently, without starting the app again.
    app.on('will-quit', () => runInstaller(false));
  }
  const image = process.env.APPIMAGE;
  if (kind === 'appimage' && image) {
    for (const stale of [image + '.new', image + '.new.part']) tidy(stale);
  }
  const look = () => { if (due()) void check(false); };
  setTimeout(look, FIRST_CHECK_MS);
  setInterval(look, LOOK_MS).unref();
}

/** Remove what an earlier update left, and never fail the start for it. The
 *  installer that has just updated this copy starts it again before it exits,
 *  so its own file can still be locked here (EBUSY on Windows), and a throw
 *  here is an uncaught exception in main. The next start tries again. */
function tidy(path: string, recursive = false): void {
  try {
    rmSync(path, { recursive, force: true });
  } catch (err) {
    log('warn', 'could not remove an old update file', { path, err: String(err) });
  }
}

/**
 * The title bar's Update button. A press does what the button says: download
 * the update then install it, open the download page for a copy that cannot
 * replace itself, or try again after a failure. The install quits, and the
 * quit writes the board to its file first (holdCloseForFlush in main.ts), so
 * nothing asks about saving.
 */
export function clickUpdate(): void {
  if (!offered || busy) return;
  if (offered.state === 'manual') {
    shell.openExternal(DOWNLOAD_PAGE).catch(err => log('warn', 'could not open the download page', { err: String(err) }));
    return;
  }
  if (offered.state !== 'available' && offered.state !== 'failed') return;
  // A failed download tries the download again. A failed check has nothing
  // to download yet, so it checks again.
  if (pending) void downloadAndInstall(pending);
  else void check(true);
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

/** Download a release asset to `dest`, hashing as it streams, and report how
 *  much has come, in whole percent steps. Nothing lands at `dest` unless the
 *  SHA-256 matches the digest GitHub gives for the file. */
async function download(asset: Asset, dest: string, onProgress: (share: number) => void): Promise<void> {
  const want = /^sha256:([0-9a-f]{64})$/.exec(asset.digest);
  if (!want) throw new Error('the release gives no SHA-256 for ' + asset.name);
  const res = await net.fetch(asset.url);
  if (!res.ok || !res.body) throw new Error('the download failed: ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  mkdirSync(dirname(dest), { recursive: true });
  const part = dest + '.part';
  const hash = createHash('sha256');
  const out = createWriteStream(part);
  let got = 0;
  let told = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      got += value.byteLength;
      const share = total ? Math.min(1, got / total) : 0;
      if (share - told >= 0.01) {
        told = share;
        onProgress(share);
      }
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
async function fetchUpdate(version: string, asset: Asset, onProgress: (share: number) => void): Promise<void> {
  if (kind === 'installer') {
    const file = join(downloadDir(), asset.name);
    await download(asset, file, onProgress);
    ready = { version, file };
    return;
  }
  // Beside the running AppImage, so the rename below stays on one disk. Linux
  // lets a running file be replaced: this copy keeps running from the old one
  // until it quits.
  const target = process.env.APPIMAGE;
  if (!target) throw new Error('APPIMAGE is not set');
  const next = target + '.new';
  await download(asset, next, onProgress);
  chmodSync(next, 0o755);
  renameSync(next, target);
  ready = { version, file: target };
}

/** The press on Update: download with the button counting, then install. */
async function downloadAndInstall(want: { version: string, asset: Asset }): Promise<void> {
  busy = true;
  const v = label(want.version);
  const counting = (progress: number) => publish({
    state: 'downloading', version: want.version, progress,
    note: `Downloading mbrd ${v}. mbrd saves the board and restarts into it when the download is done.`,
  });
  counting(0);
  try {
    await fetchUpdate(want.version, want.asset, counting);
    log('info', 'an update is ready', { version: want.version });
    publish({ state: 'installing', version: want.version, note: `Restarting into mbrd ${v}` });
    install();
  } catch (err) {
    log('info', 'update download did not complete', { err: errorText(err) });
    publish({
      state: 'failed', version: want.version,
      note: `mbrd ${v} did not download: ${errorText(err).slice(0, 200)}. Press to try again.`,
    });
  } finally {
    busy = false;
  }
}

/** Put the downloaded update in place and restart into it. */
function install(): void {
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

/** What a copy that cannot replace itself tells somebody to do. */
function manualHow(version: string): string {
  const out = `mbrd ${label(version)} is out.`;
  if (process.platform === 'darwin') {
    return `${out} Press to open the download page, then drag the new copy into Applications. Your boards and settings stay.`;
  }
  if (portableCopy) {
    return `${out} Press to open the download page, run the new Windows file, choose Portable, and pick this folder. The data folder in it keeps the shelf and the recovery store.`;
  }
  return `${out} This copy cannot replace itself. Press to open the download page.`;
}

async function check(manual: boolean): Promise<void> {
  if (kind === 'dev') {
    if (manual) {
      say({ state: 'dev', version: '', note: 'This copy runs the code in the desktop folder, so there is nothing to update.' }, PASSING_MS);
    }
    return;
  }
  // The button already says what there is, and a new check adds nothing.
  if (manual && offered && offered.state !== 'failed') return;
  if (manual) {
    asked = true;
    say({ state: 'checking', version: '', note: 'Looking for a newer version' });
  }
  // A running check answers the question too, now that it has been asked.
  if (busy) return;
  busy = true;
  try {
    const rel = await latestRelease();
    stamp();
    if (!newer(rel.version, app.getVersion())) {
      if (asked) say({ state: 'current', version: '', note: `Version ${label(app.getVersion())} is the latest release.` }, PASSING_MS);
      return;
    }
    if (kind === 'installer' || kind === 'appimage') {
      const want = ASSET[kind];
      const asset = rel.assets.find(a => want.match.test(a.name));
      if (!asset) throw new Error('the release has no ' + want.name);
      pending = { version: rel.version, asset };
      publish({
        state: 'available', version: rel.version,
        note: `mbrd ${label(rel.version)} is out. Press to download it. mbrd then saves the board and restarts into it.`,
      });
      return;
    }
    publish({ state: 'manual', version: rel.version, note: manualHow(rel.version) });
  } catch (err) {
    // A background failure (offline, GitHub down) stays silent, and the next
    // check tries again.
    log('info', 'update check did not complete', { err: errorText(err) });
    if (asked) {
      publish({
        state: 'failed', version: '',
        note: `mbrd could not check for updates. Check the connection. ${errorText(err).slice(0, 200)}. Press to try again.`,
      });
    }
  } finally {
    busy = false;
    asked = false;
  }
}
