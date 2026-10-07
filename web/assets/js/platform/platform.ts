// Platform abstraction: six members for the questions a native shell answers
// differently from a browser tab. "Desktop" means "a native shell is wired":
// Electron, or the Android shell (mobile/bridge/), which sets the same bridge.
// The window's frame is not a member. Unwired is the web. setPlatform() wires a
// shell. The bridge global is read only in main.ts; this module never touches it.

import { readPref, writePref } from '../prefs.ts';

/** A file the app has open. `path` is desktop-only; the web uses a handle. */
export interface DocumentRef {
  name: string;
  /** Absolute path, desktop only. */
  path?: string;
}

/** What a picker will accept, in the File System Access API's shape. */
export interface PickerType {
  description?: string;
  accept: Record<string, string[]>;
}

/** Both spellings of an accept list: `types` for FSAA, `accept` for `<input>`. */
export interface PickSpec {
  types: PickerType[];
  accept: string;
  mode: string;
}

/** A board file in the shell's boards folder. `at` is when it last changed. */
export interface FolderBoard {
  name: string;
  path: string;
  at: number;
}

/** The boards folder, where a shell keeps one, and every board is a file in it. */
export interface BoardFolder {
  /** The folder and its boards. Null where the shell keeps no folder. */
  list(): Promise<{ folder: string, files: FolderBoard[] } | null>;
  /** A new board file, under the first free name like `suggested`. */
  create(suggested: string, blob: Blob): Promise<DocumentRef>;
  /** Rename a board in the folder. Null for a file elsewhere, which keeps its name. */
  rename(ref: DocumentRef, suggested: string): Promise<DocumentRef | null>;
  /** Move a board in the folder to the bin. */
  trash(ref: DocumentRef): Promise<void>;
  /** Open the folder in the system's file manager. */
  reveal(): Promise<void>;
}

/** File I/O port. Plan §4 *files*. */
export interface FilesPort {
  /** The boards folder. Null on the web, where a board lives in the browser. */
  folder: BoardFolder | null;
  /** Whether a real save-file picker exists (false on Safari/Firefox). */
  canPick(): boolean;
  pickOpen(spec: PickSpec): Promise<{ file: File, ref: DocumentRef }>;
  pickSave(suggested: string, spec: PickSpec): Promise<DocumentRef>;
  /** Write bytes. Atomic on desktop; streams or downloads on web. */
  write(ref: DocumentRef, blob: Blob): Promise<void>;
  /**
   * Desktop only: add `blob` to the end of the file, which must be `at` bytes
   * long - a save's tail (appendZip() in storage/zip.ts). Throws, leaving the
   * file as it was, when the file has changed length since. Absent on the
   * web, where a board is always written whole.
   */
  append?(ref: DocumentRef, blob: Blob, at: number): Promise<void>;
  /**
   * A shell only: the file's length, and its last `length` bytes (all of it
   * when shorter) - the ZIP directory, which the first append of a session
   * reads the file's layout from (layoutFromTail() in storage/zip.ts).
   */
  tail?(ref: DocumentRef, length: number): Promise<{ size: number, bytes: Uint8Array }>;
  /** Desktop only: choose files to add. Web uses import/drop.ts instead. */
  pickImport(spec: PickSpec): Promise<File[]>;
  /** Desktop only: read a document back by path. */
  read(ref: DocumentRef): Promise<File>;
  /** Whether the file still exists at its path. Web always returns true. */
  exists(ref: DocumentRef): Promise<boolean>;
}

/** A file handed over. `ref` with a path means Save writes back to it. */
export interface OpenedFile {
  file: File;
  ref: DocumentRef | null;
}

/** Close/quit and file-open events. Plan §4 *lifecycle*. */
export interface LifecyclePort {
  /** Register a flush to run before the app goes away. Desktop awaits it. */
  onCloseRequested(fn: () => Promise<void> | void): void;
  /** A shell only: files opened via argv, double-click, a second launch, or
   *  Android's "Open with" and "Share to". */
  onOpenFiles(fn: (files: OpenedFile[]) => void): void;
  /** The phone's Back button. `fn` closes the top layer and answers whether
   *  it closed anything. The Android shell sends its own; a phone's browser or
   *  installed PWA gets webBack(); the desktop has no Back to send. */
  onBack(fn: () => boolean): void;
}

/** Options for a native transcode. */
export interface TranscodeOpts {
  maxEdge?: number;
  bitrate?: number;
}

/** Native-process work. Every method returns null when unavailable; callers fall back. */
export interface NativePort {
  firstFrame(bytes: ArrayBuffer, name: string): Promise<Blob | null>;
  /** Synchronous: whether the UI should offer clip shrinking at all. */
  canTranscode(): boolean;
  transcode(bytes: ArrayBuffer, name: string, opts: TranscodeOpts): Promise<Blob | null>;
  /** u2netp background removal. 1x3x320x320 tensor in and out. */
  matte(input: Float32Array): Promise<Float32Array | null>;
  decode(bytes: ArrayBuffer, name: string): Promise<ImageBitmap | null>;
}

/** Update port. Plan §4 *updates*. */
export interface UpdatesPort {
  /** Start a check. The answer comes back through onOffer on the phone, and
   *  on the desktop's title bar, so the promise carries nothing. */
  check(): Promise<void>;
  /** True where the answer is the page's to show (Android), so the press is
   *  acknowledged on the page before the answer arrives. */
  readonly answersOnPage: boolean;
  /** What the shell's updater says for the page to show (Android), or null. */
  onOffer(fn: (offer: UpdateOffer | null) => void): void;
  /** Put the offered update in place. The caller saves the board first. */
  install(): Promise<void>;
  /** Tell the shell whether its own daily check may run. The check on request
   *  (Help, the panel row) runs either way. */
  setAuto(on: boolean): void;
}

/** Per device, never in a board: whether to look for an update by itself. */
const AUTO_UPDATES_KEY = 'mbrd.updates.auto';

/** Whether the shell checks for updates by itself. On unless turned off. */
export const autoUpdatesOn = (): boolean => readPref(AUTO_UPDATES_KEY) !== '0';

/** The panel's switch: remembered here and handed to the shell at once. */
export function setAutoUpdates(on: boolean): void {
  writePref(AUTO_UPDATES_KEY, on ? '1' : '0');
  current.updates.setAuto(on);
}

/** What the phone's updater says (MbrdUpdate.java). The first four are an
 *  offer, which the sidebar's Update row shows: `available` (a press
 *  downloads it, then installs it), `ready` (downloaded and checked, so a
 *  press installs it), `downloading` (counting `progress` from 0 to 1) and
 *  `failed` (a press tries again). `said` is a passing answer to Check for
 *  updates, such as "mbrd is up to date", shown in the page's toast and not
 *  kept. `note` is the whole sentence. */
export type UpdateOfferState = 'available' | 'ready' | 'downloading' | 'failed' | 'said';

export interface UpdateOffer {
  state: UpdateOfferState;
  version: string;
  progress: number;
  note: string;
}

const OFFER_STATES = new Set<string>(['available', 'ready', 'downloading', 'failed']);

let heldOffer: UpdateOffer | null = null;

/** The update the sidebar's Update row offers, or null for no row. */
export const updateOffer = (): UpdateOffer | null => heldOffer;

/** main.ts writes what the shell announced. A passing answer does not touch the row. */
export function setUpdateOffer(offer: UpdateOffer | null): void {
  if (offer?.state === 'said') return;
  heldOffer = offer && OFFER_STATES.has(offer.state) && typeof offer.version === 'string'
    ? { state: offer.state, version: offer.version, progress: Number(offer.progress) || 0, note: String(offer.note ?? '') }
    : null;
}

/** Sign-in port: Google Drive's, where the page cannot open a popup of its
 *  own. The desktop denies the popup and serves app://, which Google does not
 *  know, and Android serves https://app. */
export interface AuthPort {
  /** Which Google OAuth client this shell signs in with. */
  googleClient: 'web' | 'desktop' | 'android';
  /** Sign in outside the page. The web never calls it: google.ts opens its popup. */
  google(req: GoogleSignIn): Promise<GoogleGrant>;
}

/** The desktop's client, and the one scope. Android sends only the scope:
 *  Google finds its client by the app's package name and signature. */
export interface GoogleSignIn {
  clientId: string;
  clientSecret: string;
  scope: string;
}

export interface GoogleGrant {
  token: string;
  /** Seconds. */
  expiresIn: number;
}

/** What the shell is told about the document on screen. */
export interface DocumentState {
  title: string;
  ref: DocumentRef | null;
  dirty: boolean;
  /** Whether the board is one somebody made - named, or with something on it.
   *  The web tab names only such a board; see webSetDocument(). */
  owned?: boolean;
}

/** The whole of what a shell answers. */
export interface Platform {
  files: FilesPort;
  lifecycle: LifecyclePort;
  native: NativePort;
  updates: UpdatesPort;
  auth: AuthPort;
  /** Tell the shell what is on screen. On the web, the tab's title. */
  setDocument(state: DocumentState): void;
  /** Reload on web; relaunch the process on desktop. */
  relaunch(): void;
}

// ---------------------------------------------------------------------------
// The web defaults
// ---------------------------------------------------------------------------

/** File System Access API surface, undeclared in lib.dom. */
interface FilePickerOptions {
  suggestedName?: string;
  types?: { description?: string, accept: Record<string, string[]> }[];
  multiple?: boolean;
}

declare global {
  interface Window {
    showSaveFilePicker?: (opts?: FilePickerOptions) => Promise<FileSystemFileHandle>;
    showOpenFilePicker?: (opts?: FilePickerOptions) => Promise<FileSystemFileHandle[]>;
  }
}

/** Dismissed-picker error. Callers test `err.name === 'AbortError'`. */
function abort(what: string): Error {
  const err = new Error(what);
  err.name = 'AbortError';
  return err;
}

// Deferred: node --test imports this with no browser.
const hasWindow = () => typeof window !== 'undefined';

// Handle kept beside the ref: refs cross the bridge and serialise; handles do not.
const handles = new WeakMap<DocumentRef, FileSystemFileHandle>();

function refFor(handle: FileSystemFileHandle): DocumentRef {
  const ref: DocumentRef = { name: handle.name };
  handles.set(ref, handle);
  return ref;
}

/** For launchQueue: wrap a handle the PWA was handed so Save can write through it. */
export function refForHandle(handle: FileSystemFileHandle): DocumentRef {
  return refFor(handle);
}

/**
 * Cleared the first time the platform hands back a handle it will not let us
 * write - see write(). A picker that cannot write is worse than no picker: it
 * creates the file before it refuses, so every export leaves another empty one
 * behind. After the first refusal the export is a download from the start.
 *
 * A reload asks again, which is the right amount of memory for this: the cost
 * of being wrong is exports that download rather than write through a handle,
 * and that is the path Safari and Firefox take on every save already.
 */
let pickerWrites = true;

const canPick = () => pickerWrites && hasWindow() && typeof window.showSaveFilePicker === 'function';

const webFiles: FilesPort = {
  folder: null,
  canPick,

  async pickOpen(spec: PickSpec) {
    if (!hasWindow()) throw abort('No file picker here');
    if (typeof window.showOpenFilePicker === 'function') {
      const [handle] = await window.showOpenFilePicker({ types: spec.types, multiple: false });
      if (!handle) throw abort('Nothing picked');
      return { file: await handle.getFile(), ref: refFor(handle) };
    }
    const [file] = await viaInput(spec, false);
    if (!file) throw abort('Nothing picked');
    // No handle: write() will fall back to download (Safari/Firefox).
    return { file, ref: { name: file.name } };
  },

  async pickSave(suggested: string, spec: PickSpec) {
    if (!canPick()) throw abort('No file picker in this browser');
    return refFor(await window.showSaveFilePicker!({ suggestedName: suggested, types: spec.types }));
  },

  async write(ref: DocumentRef, blob: Blob) {
    const handle = handles.get(ref);
    if (!handle) {
      download(blob, ref.name);
      return;
    }
    // A picker that opens is not a promise that the file can be written.
    // Samsung Internet on Android answers showSaveFilePicker, hands back a real
    // handle, and creates the file - then refuses createWritable() with "not
    // allowed by the user agent or the platform in the current context". What
    // the export left behind was a zero-byte file in Downloads, an error toast
    // and no board. The download below is the same answer this port already
    // gives a browser with no picker at all, so the save lands either way.
    //
    // Only around createWritable(), which throws before anything is written. A
    // failure part-way through the stream has already touched the file, and
    // quietly writing a second copy beside a half-written one would hide it.
    let writable;
    try {
      writable = await handle.createWritable();
    } catch {
      pickerWrites = false;
      download(blob, ref.name);
      return;
    }
    // pipeTo streams chunks rather than buffering; it closes the destination.
    await blob.stream().pipeTo(writable);
  },

  pickImport: async () => { throw abort('Adding files is import/drop.ts on the web'); },
  read: async () => { throw abort('A browser cannot open a file by name'); },
  exists: async () => true,
};

/** Last segment of a path, splitting on both `/` and `\`. */
export const fileNameOf = (path: string) => path.split(/[\\/]/).pop() || path;

/** Trigger a download, the fallback when there is no File System Access API. */
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Revoke late: Safari needs the URL to survive the click turn.
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

/** Fallback picker via the hidden `<input>`. Resolves empty on dismiss. */
function viaInput(spec: PickSpec, multiple: boolean) {
  return new Promise<File[]>(resolve => {
    // SAFETY: index.html carries <input id="file-input" type="file">, and
    // tests/element-ids.test.js holds that id in both directions.
    const input = document.getElementById('file-input') as HTMLInputElement;
    const prevAccept = input.accept;
    input.accept = spec.accept;
    input.multiple = multiple;
    // import/drop.ts stands down on a mode it does not own.
    input.dataset.mode = spec.mode;

    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      removeEventListener('focus', onFocus);
      input.accept = prevAccept;
      input.multiple = true;
      input.value = '';
      delete input.dataset.mode;
      resolve(files);
    };
    const picked = () => [...input.files ?? []];
    const onChange = () => finish(picked());
    const onCancel = () => finish([]);
    // Focus fires before `change`; the delay lets change land first.
    const onFocus = () => setTimeout(() => finish(picked()), 300);

    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    addEventListener('focus', onFocus, { once: true });
    input.click();
  });
}

const webLifecycle: LifecyclePort = {
  onCloseRequested(fn) {
    if (!hasWindow()) return;
    // Both: visibilitychange is reliable on phones; pagehide on desktop close.
    addEventListener('pagehide', () => { void fn(); });
    addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void fn();
    });
  },
  onOpenFiles: () => {},
  onBack: webBack,
};

/**
 * Back on a phone's browser, or the PWA installed from it, closes the menu or
 * dialog on top before it leaves the app - the Android shell's rule, which
 * before this left the page on the first press with a menu still open.
 *
 * Only where a Back button is the way out: a coarse pointer, or the installed
 * app. A desktop browser's Back is a navigation and is left alone.
 *
 * One history entry stands guard over the page, and popping it is the Back.
 * A Back that found nothing to close is passed on with history.back(), so it
 * still leaves. Re-armed on the next press or key: an entry pushed with no
 * user activation behind it is one Chrome's Back skips, so arming from inside
 * the Back itself would arm nothing.
 *
 * Not CloseWatcher, though it is the platform's own "Back closes this": it
 * answers the Escape key as well, and an Escape with nothing open would then
 * be passed on to history.back() and leave the app.
 */
function webBack(fn: () => boolean) {
  if (!hasWindow() || typeof history === 'undefined' || typeof matchMedia !== 'function') return;
  if (!matchMedia('(pointer: coarse)').matches && !matchMedia('(display-mode: standalone)').matches) return;
  let armed = false;
  const onUse = () => {
    if (armed) return;
    armed = true;
    history.pushState({ mbrdBack: true }, '');
  };
  addEventListener('pointerdown', onUse, true);
  addEventListener('keydown', onUse, true);
  // Popped off the guard entry: the state under it is not ours. Landing *on*
  // it (Forward, or Back from a #fragment) is a navigation, not the Back.
  // SAFETY: history.state is any; only the one flag pushed above is read off it.
  addEventListener('popstate', e => {
    if (!armed || (e.state as { mbrdBack?: boolean } | null)?.mbrdBack) return;
    armed = false;
    if (!fn()) history.back();
  });
}

const webNative: NativePort = {
  canTranscode: () => false,
  firstFrame: async () => null,
  transcode: async () => null,
  matte: async () => null,
  decode: async () => null,
};

// The web's updater is the service worker (main.ts), so a check does nothing.
const webUpdates: UpdatesPort = {
  check: async () => {},
  answersOnPage: false,
  onOffer: () => {},
  install: async () => {},
  setAuto: () => {},
};

const webAuth: AuthPort = {
  googleClient: 'web',
  google: () => Promise.reject(new Error('the page signs in through its own popup')),
};

/** The page's own title, kept for a board nobody has made anything of yet. */
let staticTitle: string | null = null;

/**
 * The tab says which board it is, so two tabs or a long tab strip can be told
 * apart. An empty board with a generated name keeps the page's own title: it
 * is what a search engine and a first visit read, and "New board Oct 2" is
 * not a name anybody gave.
 */
function webSetDocument(state: DocumentState) {
  if (!hasWindow() || typeof document === 'undefined') return;
  staticTitle ??= document.title;
  document.title = state.owned && state.title ? `${state.title} — mbrd` : staticTitle;
}

const web: Platform = {
  files: webFiles,
  lifecycle: webLifecycle,
  native: webNative,
  updates: webUpdates,
  auth: webAuth,
  setDocument: webSetDocument,
  relaunch: () => { location.reload(); },
};

// ---------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------

let current: Platform = web;
let wired = false;

/** Wire a shell. null restores web defaults. Called once from main.ts. */
export function setPlatform(p: Platform | null | undefined): void {
  current = p ?? web;
  wired = !!p;
}

/** Whether a shell was wired. A wiring question, not a capability test. */
export function isDesktop(): boolean {
  return wired;
}

// Getters: callers import at module scope before setPlatform() runs.
export const platform: Readonly<Platform> = {
  get files() { return current.files; },
  get lifecycle() { return current.lifecycle; },
  get native() { return current.native; },
  get updates() { return current.updates; },
  get auth() { return current.auth; },
  setDocument(state) { current.setDocument(state); },
  relaunch() { current.relaunch(); },
};
