// The seven questions the browser used to answer on its own.
//
// A desktop build of this app is not a different app. `state.ts`, the .mbrd
// schema, the renderers, the input pipeline and the whole of canvas/ and ui/
// are the same code running in the same Chromium, and the bundle the shell
// loads is the same web/assets/app.js. What changes is smaller than it looks -
// seven questions the page never had to ask because a browser tab was always
// the answer:
//
//   where do a file's bytes come from   <input type=file>, drop, File System
//                                       Access  ->  a native dialog and a path
//   where does Save go                  IndexedDB  ->  the .mbrd on disk
//   where does recovery go              IndexedDB  ->  app data, written by the
//                                       main process (that one is idb.ts's
//                                       setStoreBackend(), not a port here)
//   what happens on close               pagehide, unawaitable  ->  a close held
//                                       open until the flush resolves
//   how does a link open                target=_blank  ->  shell.openExternal
//   where does heavy work run           wasm in a worker  ->  a native process
//   how does the app update             the service worker  ->  electron-updater
//
// Each of those is a port below, and the argument for every one of them is in
// `research/electron-2026-09-06.md` §4. Links are the exception and are not a
// port at all: the shell intercepts window.open in its own process and nothing
// in web/ changes, which is why there are six ports for seven questions.
//
// ── Unwired is the web ──
//
// This is the shape the codebase already takes five times - setOverlays(),
// setPrompt(), setRiskPrompt(), setAssetNameLookup(), setNoteMenu(). A module
// low in the graph exports a setter and a default that does the ordinary
// thing; main.ts wires the other implementation once; nothing below main.ts
// learns which one it got.
//
// The bargain here is stricter than "unwired is harmless", which is what
// notify.ts settles for. **Unwired is the web behaviour, exactly.** Every
// default in this file is the code that ran before the file existed, moved
// rather than rewritten, because the desktop work has to leave a browser
// visitor with an app that is byte-for-byte the one they had. It is also what
// keeps storage/, import/ and canvas/ loadable in `node --test` with no
// browser: nothing here reads `window` or `document` while the module body
// runs, only inside a function, and tests/imports.test.js is the guard.
//
// ── What must not move in here ──
//
// The bridge. `window.mbrdDesktop` is read in exactly one place in this tree,
// which is main.ts, and it is handed to electronPlatform() as an *argument*.
// This module does not know the desktop exists; it knows there is a Platform
// and that it might have been given one. A `typeof window.mbrdDesktop` test in
// here would make every module below main.ts depend on a global that only one
// of two shells defines, and the whole point of the injection is that they
// cannot tell.
//
// Nor a capability guess. isDesktop() answers whether a platform was wired,
// not whether some API happens to be present. Feature tests belong at the
// place the feature is used - canPick() below is one, and it is a question
// about *this browser*, asked of the port so the desktop can answer it too.

/**
 * A file the app has open, or is about to write.
 *
 * Deliberately not a handle. On the web this wraps a FileSystemFileHandle, on
 * the desktop it is a real path, and in Safari it is neither - so the thing
 * `storage.ts` holds is the *document*, and how to write it is the port's
 * problem. `path` is desktop-only and is the field the shelf's file rows and
 * the title bar read; nothing on the web ever sets it.
 */
export interface DocumentRef {
  /** The file name, with extension. The only field both shells always have. */
  name: string;
  /** Absolute path. Desktop only - absent means "there is no path for this". */
  path?: string;
}

/**
 * What a picker will accept, in the File System Access API's own shape.
 *
 * Handed in rather than known here, and that is layering rather than taste:
 * the .mbrd MIME type is `storage/mbrd.ts`'s, this module sits underneath
 * storage/, and a copy of that string down here would be the second place it
 * is written. So the port knows how to open a picker and the caller knows what
 * a board is - which is also why the desktop adapter can pass the same list
 * straight to Electron's dialog filters.
 */
export interface PickerType {
  description?: string;
  accept: Record<string, string[]>;
}

/**
 * What a picker will accept, in both spellings the web needs.
 *
 * Two strings rather than one because the two fallbacks take different shapes -
 * the File System Access API wants `types`, a hidden `<input>` wants an
 * `accept` attribute - and neither is derivable from the other without this
 * module guessing. `.mbrd` is an extension no operating system has heard of and
 * iOS resolves an accept list to UTIs rather than matching strings, which is
 * why the attribute is wider than the types and why the caller writes it out.
 * `mode` is the owner's name, for the one hidden input this app has.
 */
export interface PickSpec {
  types: PickerType[];
  accept: string;
  mode: string;
}

/** Where a file's bytes come from and where they go. Plan §4 *files*. */
export interface FilesPort {
  /**
   * Whether a real picker exists, as opposed to a download.
   *
   * The web's `canPickFiles()`, asked of the port. Safari and Firefox have no
   * File System Access API and answer false, which is what puts Export on the
   * download path; the desktop always answers true. It is a synchronous
   * question because the call sites branch on it before they serialise
   * anything - see the ordering argument above the picker in `exportBoard()`.
   */
  canPick(): boolean;
  /** Choose a file to open. Rejects `AbortError` when dismissed. */
  pickOpen(spec: PickSpec): Promise<{ file: File, ref: DocumentRef }>;
  /** Choose where to write. Rejects `AbortError` when dismissed. */
  pickSave(suggested: string, spec: PickSpec): Promise<DocumentRef>;
  /**
   * Write bytes to the document.
   *
   * Atomic on the desktop - a temp file and a rename. On the web it streams to
   * the handle the ref wraps, or falls back to a download under `ref.name`
   * where there is no handle, which is every browser `canPick()` says false
   * for and also a ref that outlived its page.
   */
  write(ref: DocumentRef, blob: Blob): Promise<void>;
  /**
   * Choose pictures, clips and documents to add. Rejects `AbortError`.
   *
   * Desktop only, and unusually for this file the web default is not the web
   * behaviour - it is a rejection. Adding files on the web is `import/drop.ts`'s
   * own flow over the one hidden `<input>`, which knows about drag state, the
   * paste path and the `dataset.mode` handshake, and routing it through a port
   * would be a second opener for a thing that already has exactly one. The
   * desktop needs this because a native dialog hands back paths, which that
   * flow has nowhere to put.
   */
  pickImport(spec: PickSpec): Promise<File[]>;
  /**
   * Read the document back. Desktop only, and the other half of a path row.
   *
   * The shelf's file rows keep no copy of the board, so opening one is a read
   * of the path. On the web this rejects and is never called: a row there has
   * no path, and a browser cannot open a file nobody just handed it.
   */
  read(ref: DocumentRef): Promise<File>;
  /**
   * Whether the document is still where it was.
   *
   * For the shelf's missing-file state, which only the desktop has: a row
   * pointing at a path is greyed when the file has moved. The web answers true
   * always - a handle the browser gave back is as good as it gets, and there
   * is no path to have gone stale.
   */
  exists(ref: DocumentRef): Promise<boolean>;
}

/**
 * A file the shell handed over, and what it was on disk if the shell knows.
 *
 * Two fields rather than a bare File, because "open this" and "this is the
 * document you now have open" are different claims and only the desktop can
 * make the second. A `ref` with a path means Save writes back to that file; a
 * null one means the app was handed bytes and nothing more, which is what a
 * browser's file handler gives it.
 */
export interface OpenedFile {
  file: File;
  ref: DocumentRef | null;
}

/** Closing, quitting, and being handed a file. Plan §4 *lifecycle*. */
export interface LifecyclePort {
  /**
   * Run this before the app goes away.
   *
   * The desktop holds the window's close until the promise resolves, which is
   * the thing a browser tab could never offer. The web registers the same
   * function on `pagehide` and `visibilitychange` and cannot await it, which
   * is exactly the behaviour it had before this port existed.
   */
  onCloseRequested(fn: () => Promise<void> | void): void;
  /**
   * The app was asked to open these - a second launch, a double-clicked file,
   * argv. Takes the place of `launchQueue`, which never fires under the
   * desktop's own scheme. Never called on the web.
   */
  onOpenFiles(fn: (files: OpenedFile[]) => void): void;
}

/** Options for a native transcode. Empty on the web, which never calls it. */
export interface TranscodeOpts {
  /** Longest edge in pixels; the clip is left alone if it is already under. */
  maxEdge?: number;
  /** Target bitrate in bits per second. */
  bitrate?: number;
}

/**
 * Heavy work with a native answer. Plan §4 *native*, §6 for the detail.
 *
 * **Every method answers `null` where there is no native side, and every
 * caller already has a path behind it** - the wasm decoder, the ONNX worker,
 * the browser's own image decode. That is the whole protocol: ask first, fall
 * through on null. A port that threw, or that had to be feature-tested before
 * being called, would put a desktop branch in four modules that currently have
 * none.
 */
export interface NativePort {
  /** A poster frame for a clip the browser cannot decode. */
  firstFrame(bytes: ArrayBuffer, name: string): Promise<Blob | null>;
  /** Shrink a clip. Desktop only - the web dropped this and §6 says why. */
  transcode(bytes: ArrayBuffer, name: string, opts: TranscodeOpts): Promise<Blob | null>;
  /** u2netp on a native runtime. Same Float32Array in and out as the worker. */
  matte(rgb: Float32Array, w: number, h: number): Promise<Float32Array | null>;
  /** Decode HEIC and the other formats no browser opens. */
  decode(bytes: ArrayBuffer, name: string): Promise<ImageBitmap | null>;
}

/** What an available update is. `null` from check() means "none". */
export interface UpdateInfo {
  version: string;
  /**
   * Whether it can install itself. False on a portable copy and on an unsigned
   * macOS build, where the honest offer is a link to the release page rather
   * than a button that cannot work. Plan §1.
   */
  canInstall: boolean;
}

/** Plan §4 *updates*. Replaces the service worker's "new version" toast. */
export interface UpdatesPort {
  check(): Promise<UpdateInfo | null>;
  /** Arm the downloaded update. It lands on quit; nothing restarts under a person. */
  install(): void;
}

/** The whole of what a shell answers. */
export interface Platform {
  files: FilesPort;
  lifecycle: LifecyclePort;
  native: NativePort;
  updates: UpdatesPort;
  /**
   * Start again from nothing.
   *
   * `location.reload()` on the web, and on the desktop a relaunch of the
   * process - which is what "first run again" means where there is no page to
   * reload. Both callers are wipes: `clearAllData()` and `reloadBoard()`.
   */
  relaunch(): void;
}

// ---------------------------------------------------------------------------
// The web defaults
// ---------------------------------------------------------------------------

/**
 * The File System Access API, which lib.dom does not declare.
 *
 * Moved here from storage.ts with the picker code it describes. Only the two
 * entry points this file calls and only the fields it passes - a wider guess
 * would be this module asserting a shape for an API it asks two things of.
 * Both are optional because the whole of canPick() is whether they are there:
 * Safari and Firefox have neither, and the download path exists for that.
 */
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

/**
 * The one throw every picker makes when it is dismissed.
 *
 * `isAbort()` in storage.ts is the reader of this, and it tests `err.name`
 * rather than the constructor - so a plain Error with the name set is as good
 * as a DOMException here and needs no `DOMException` to exist, which it may
 * not in every runtime the base layer is loaded in.
 */
function abort(what: string): Error {
  const err = new Error(what);
  err.name = 'AbortError';
  return err;
}

/**
 * Whether there is a window at all.
 *
 * Inside a function, never at module scope: `node --test` imports this file
 * with no browser, and tests/imports.test.js holds the rule that no module
 * touches a browser global while its body runs.
 */
const hasWindow = () => typeof window !== 'undefined';

/**
 * The handle a web DocumentRef wraps, kept beside the ref rather than in it.
 *
 * A DocumentRef is a plain `{ name, path? }` because that is what crosses the
 * bridge, gets written into the recovery store, and is read by the shelf - and
 * a FileSystemFileHandle is none of those things. So the handle lives here,
 * keyed by the ref, and a ref that outlives the page it was made in simply has
 * no handle any more and falls back to a download. That is today's behaviour
 * on a reload, unchanged.
 */
const handles = new WeakMap<DocumentRef, FileSystemFileHandle>();

/** Wrap a handle as a ref, remembering the handle. */
function refFor(handle: FileSystemFileHandle): DocumentRef {
  const ref: DocumentRef = { name: handle.name };
  handles.set(ref, handle);
  return ref;
}

/**
 * The same wrapper, for a handle this module did not open.
 *
 * One caller: `launchQueue`, which is the PWA's own file-handling entry point
 * and hands the page a FileSystemFileHandle directly. That handle is as good as
 * one from the picker - Save can write back through it - and without this it
 * would be dropped on the floor and "Open with mbrd" would stop being able to
 * save over the file it opened.
 *
 * Exported rather than a port method because it is not a question either shell
 * answers: the desktop has no launchQueue and never calls it.
 */
export function refForHandle(handle: FileSystemFileHandle): DocumentRef {
  return refFor(handle);
}

const canPick = () => hasWindow() && typeof window.showSaveFilePicker === 'function';

const webFiles: FilesPort = {
  canPick,

  async pickOpen(spec: PickSpec) {
    if (hasWindow() && typeof window.showOpenFilePicker === 'function') {
      const [handle] = await window.showOpenFilePicker({ types: spec.types, multiple: false });
      if (!handle) throw abort('Nothing picked');
      return { file: await handle.getFile(), ref: refFor(handle) };
    }
    const [file] = await viaInput(spec, false);
    // A dismissed dialog is an AbortError here and a null from viaInput(),
    // because the two doors into this function report it differently and the
    // callers may only learn one of them. This is the seam that makes them one.
    if (!file) throw abort('Nothing picked');
    // No handle: this browser cannot write back to what it just read, so the
    // ref carries a name and nothing else and write() will download. That is
    // Safari's Export today, unchanged.
    return { file, ref: { name: file.name } };
  },

  async pickSave(suggested: string, spec: PickSpec) {
    if (!canPick()) throw abort('No file picker in this browser');
    // Non-null: canPick() is the test for exactly this function and was asked
    // one line above.
    return refFor(await window.showSaveFilePicker!({ suggestedName: suggested, types: spec.types }));
  },

  async write(ref: DocumentRef, blob: Blob) {
    const handle = handles.get(ref);
    if (!handle) {
      download(blob, ref.name);
      return;
    }
    const writable = await handle.createWritable();
    // Piped rather than handed over whole. The archive packBoard() returns is a
    // composition of the assets' own Blobs (see writeZip), so it is a
    // description of a file rather than a file in memory - and pipeTo pulls it
    // a chunk at a time, which is the only way that stays true all the way to
    // the disk. pipeTo closes the destination on its own.
    await blob.stream().pipeTo(writable);
  },

  // Nothing on the web calls this - see the interface. Rejecting as dismissed
  // rather than resolving empty, so a caller that reaches it by mistake stops
  // rather than quietly adding no files.
  pickImport: async () => { throw abort('Adding files is import/drop.ts on the web'); },

  read: async () => { throw abort('A browser cannot open a file by name'); },

  exists: async () => true,
};

/**
 * The last segment of a path, on either shell's separator.
 *
 * Here rather than at the two call sites - the shelf's file rows and the grid
 * that draws them - because a `path` is the one field in this app whose spelling
 * depends on the operating system, and one wrong split is a row labelled
 * `C:\Users\...\board.mbrd`. Windows accepts both separators, so both are.
 */
export const fileNameOf = (path: string) => path.split(/[\\/]/).pop() || path;

/**
 * The download, which is what "write a file" means without a picker.
 *
 * Kept here rather than left in storage.ts because it is the other half of
 * write(): a browser that cannot pick a location can still put a file in the
 * downloads folder, and every caller that used to know the difference now asks
 * the port instead.
 */
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Revoke late: Safari needs the URL to survive the click turn.
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

/**
 * The fallback file chooser, for browsers with no File System Access API.
 *
 * Moved here from storage.ts whole, because it is the *other* implementation of
 * pickOpen() and the two belong in one place. Everything it argues still holds.
 *
 * Cancellation is the awkward part. A native file dialog that is dismissed
 * fires no `change`, so this promise used to simply never settle - and because
 * the hidden <input> is shared with Add files, it was also left holding
 * `.mbrd` and `multiple = false` for whatever came next. Modern engines fire
 * `cancel` for exactly this; the focus fallback covers the ones that do not, so
 * every exit restores the input and resolves.
 */
function viaInput(spec: PickSpec, multiple: boolean) {
  return new Promise<File[]>(resolve => {
    // #file-input is the one hidden <input type="file"> in index.html, shared
    // with Add files - see the dataset.mode note below. Absent, this whole
    // fallback has nothing to click, which is a broken build rather than a
    // state to recover from.
    // SAFETY: #file-input is the one <input type="file"> in index.html - the
    // same element import/drop.ts reaches for, and the paragraph above says why
    // an absent one is a broken build rather than a state to recover from.
    const input = document.getElementById('file-input') as HTMLInputElement;
    const prevAccept = input.accept;
    // The accept list is the caller's, and its own comment says why it is wider
    // than the File System Access types beside it.
    input.accept = spec.accept;
    input.multiple = multiple;
    // Say whose picker this is rather than saying nothing. import/drop.js
    // listens on the same input and stands down on a mode it does not own - it
    // used to stand down on the *absence* of one, which is the same thing only
    // while every other opener remembers to clear it. Naming the owner makes
    // that guard positive at both ends.
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
    // Focus returns to the window the moment the dialog closes either way, so
    // this has to give `change` a turn to land before deciding it was a
    // cancellation. Harmless where `cancel` already fired: finish() is once.
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
    // Both, and the pair is the point: visibilitychange is the reliable one -
    // a phone discarding the page may never run pagehide - and pagehide is the
    // one that fires on an ordinary close. Neither can be awaited, which is
    // the difference the desktop closes. Moved from main.ts unchanged.
    addEventListener('pagehide', () => { void fn(); });
    addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void fn();
    });
  },
  // Never called on the web: `launchQueue` is still main.ts's own block and
  // says so there. This exists so the desktop has somewhere to deliver.
  onOpenFiles: () => {},
};

const webNative: NativePort = {
  firstFrame: async () => null,
  transcode: async () => null,
  matte: async () => null,
  decode: async () => null,
};

const webUpdates: UpdatesPort = {
  // The service worker is the web's updater and it lives in main.ts. Answering
  // null is not "no update", it is "not this port's question".
  check: async () => null,
  install: () => {},
};

const web: Platform = {
  files: webFiles,
  lifecycle: webLifecycle,
  native: webNative,
  updates: webUpdates,
  relaunch: () => { location.reload(); },
};

// ---------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------

let current: Platform = web;
let wired = false;

/**
 * Hand the app a shell. main.ts calls this once, with the Electron adapter,
 * and nothing else calls it outside a test.
 *
 * `null` puts the web defaults back, which is what a test that wired a fake
 * wants in its teardown - and it also unsets isDesktop(), so the two can never
 * disagree about which shell is running.
 */
export function setPlatform(p: Platform | null | undefined): void {
  current = p ?? web;
  wired = !!p;
}

/**
 * Whether a shell was wired. False in a browser and false in a test.
 *
 * The one thing call sites are allowed to branch on, and it is a question
 * about *wiring*, not about capability: "is Save a file on disk", "is the
 * service worker ours to register", "does the shelf have paths in it". A
 * question about what this particular browser can do is canPick()'s, or a
 * null from a native port, and asking this instead would make a Chromium with
 * File System Access and a desktop build indistinguishable.
 */
export function isDesktop(): boolean {
  return wired;
}

/**
 * The ports, always the current ones.
 *
 * Getters rather than a snapshot, because callers hold this at module scope -
 * `import { platform } from '.../platform.ts'` runs long before main.ts wires
 * anything, and a plain object copied at import time would freeze every caller
 * onto the web defaults. Reading through here means the wiring can happen at
 * any point in boot and every call site after it sees the shell.
 */
export const platform: Readonly<Platform> = {
  get files() { return current.files; },
  get lifecycle() { return current.lifecycle; },
  get native() { return current.native; },
  get updates() { return current.updates; },
  relaunch() { current.relaunch(); },
};
