// window.mbrdDesktop for the Android shell: desktop/preload.ts for Capacitor.
// MbrdShell.java injects the bundle at document start, for the app origin, so
// the bridge exists before main.ts reads it. Nothing here is a security check:
// a crafted file that finds an XSS can call the Java plugins directly, so every
// check lives in them. stage-web.mjs bundles this file and adds the guard.

import type { Bridge } from '../../web/assets/js/platform/electron.ts';
import { BOOT } from './boot.ts';
import * as boards from './boards.ts';
import * as files from './files.ts';
import * as lifecycle from './lifecycle.ts';
import { call, listen } from './native.ts';
import { installDownloads, installShare } from './share.ts';
import * as store from './store.ts';

/** The states MbrdUpdate.java says, as platform.ts's UpdateOfferState names them. */
const UPDATE_STATES = ['available', 'ready', 'downloading', 'failed', 'said'] as const;

/** The desktop's shape at `bridge: 3`, and the two keys a branch that must not
 * run on a phone can test. tests/mobile-bridge.test.js holds the keys in step. */
type AndroidBridge = Bridge & { shell: 'capacitor', platform: 'android' };

/** A call the Java plugins answer from group N (native FFmpeg) of
 * research/old/apps-tasks-2026-09-13.md. Until then it refuses, and every caller
 * in platform/electron.ts already has a path for a refusal. */
const notYet = (what: string) => (): Promise<never> =>
  Promise.reject(new Error(`the Android shell cannot ${what} yet`));

const api: AndroidBridge = {
  bridge: 3,
  shell: 'capacitor',
  platform: 'android',

  store: Object.freeze({
    get: store.get,
    set: store.set,
    del: store.del,
    keys: store.keys,
    clear: store.clear,
    getMany: store.getMany,
    setMany: store.setMany,
    delMany: store.delMany,
  }),

  files: Object.freeze({
    pickOpen: files.pickOpen,
    pickSave: files.pickSave,
    pickImport: files.pickImport,
    write: files.write,
    append: files.append,
    tail: files.tail,
    read: files.read,
    exists: files.exists,
  }),

  // The boards folder, MbrdRoot's: Documents/mbrd with the storage grant.
  boards: Object.freeze({
    list: boards.list,
    create: boards.create,
    rename: boards.rename,
    trash: boards.trash,
    reveal: boards.reveal,
  }),

  native: Object.freeze({
    // An answer, not a refusal: with no native FFmpeg the phone runs the web
    // path, as the website does on the same phone.
    can: () => Promise.resolve({ transcode: false, matte: false }),
    firstFrame: notYet('read a clip natively'),
    transcode: notYet('convert a clip natively'),
    matte: notYet('cut out a picture natively'),
    decode: notYet('decode a picture natively'),
  }),

  // MbrdUpdate.java says everything on the page, never in a dialog: an offer
  // for the sidebar's Update row, and a passing answer to a check ("said")
  // for the page's toast. A build with no update feed (mobile.bat) says that
  // updates are off. Any other state takes the row away.
  updates: Object.freeze({
    check: () => call<void>('MbrdShell', 'checkUpdates'),
    onOffer: fn => listen('MbrdShell', 'update', data => {
      // SAFETY: the object MbrdShell's offer listener builds, read as optional.
      const o = (data ?? {}) as { state?: unknown, version?: unknown, progress?: unknown, note?: unknown };
      const state = UPDATE_STATES.find(s => s === o.state);
      fn(state ? {
        state,
        version: typeof o.version === 'string' ? o.version : '',
        progress: typeof o.progress === 'number' ? o.progress : 0,
        note: typeof o.note === 'string' ? o.note : '',
      } : null);
    }),
    install: () => call<void>('MbrdShell', 'installUpdate'),
  }),

  // Google Drive's sign-in, in Android's own account sheet (MbrdAuth.java).
  // Google finds the Android client by the package name and the signing key,
  // so only the scope goes across.
  auth: Object.freeze({
    google: req => call<{ token: string, expiresIn: number }>('MbrdAuth', 'google', { scope: req.scope }),
  }),

  // Where the boards are, when they are not in Documents/mbrd (plan §5.4).
  startupNotes: () => call<{ note?: string }>('MbrdShell', 'startupNotes').then(r => r.note ?? ''),
  // A phone has no title bar to name the board in.
  setDocument: () => {},
  relaunch: () => location.reload(),
  // Run on pause, as the desktop runs it before a close.
  onClose: lifecycle.onClose,
  // "Open with" and "Share to".
  onOpenFiles: lifecycle.onOpenFiles,
  // The desktop's menu sends commands. A phone has no menu of its own.
  onCommand: () => {},
  onBack: lifecycle.onBack,
};

// Read once, so a debuggable build says so in the WebView console.
if (!BOOT.packaged) console.info(`[mbrd] Android shell ${BOOT.version ?? ''}, debug build`);

installShare();
installDownloads();
lifecycle.installBack();

Object.defineProperty(window, 'mbrdDesktop', {
  value: Object.freeze(api),
  writable: false,
  configurable: false,
  enumerable: false,
});
