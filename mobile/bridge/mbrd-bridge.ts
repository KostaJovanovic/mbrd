// window.mbrdDesktop for the Android shell: desktop/preload.ts for Capacitor.
// MbrdShell.java injects the bundle at document start, for the app origin, so
// the bridge exists before main.ts reads it. Nothing here is a security check:
// a crafted file that finds an XSS can call the Java plugins directly, so every
// check lives in them. stage-web.mjs bundles this file and adds the guard.

import type { Bridge } from '../../web/assets/js/platform/electron.ts';
import { BOOT } from './boot.ts';
import * as files from './files.ts';
import * as lifecycle from './lifecycle.ts';
import { call } from './native.ts';
import { installDownloads, installShare } from './share.ts';
import * as store from './store.ts';

/** The desktop's shape at `bridge: 3`, and the two keys a branch that must not
 * run on a phone can test. tests/mobile-bridge.test.js holds the keys in step. */
type AndroidBridge = Bridge & { shell: 'capacitor', platform: 'android' };

/** A call the Java plugins answer from group N (native FFmpeg) or O (updates)
 * of research/apps-tasks-2026-09-13.md. Until then it refuses, and every
 * caller in platform/electron.ts already has a path for a refusal. */
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
    read: files.read,
    exists: files.exists,
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

  updates: Object.freeze({
    check: notYet('check for updates'),
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
lifecycle.installBars();

Object.defineProperty(window, 'mbrdDesktop', {
  value: Object.freeze(api),
  writable: false,
  configurable: false,
  enumerable: false,
});
