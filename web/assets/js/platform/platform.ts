// Platform abstraction: six members for the questions a native shell answers
// differently from a browser tab. "Desktop" means "a native shell is wired":
// Electron, or the Android shell (mobile/bridge/), which sets the same bridge.
// The window's frame is not a member. Unwired is the web. setPlatform() wires a
// shell. The bridge global is read only in main.ts; this module never touches it.

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

/** File I/O port. Plan §4 *files*. */
export interface FilesPort {
  /** Whether a real save-file picker exists (false on Safari/Firefox). */
  canPick(): boolean;
  pickOpen(spec: PickSpec): Promise<{ file: File, ref: DocumentRef }>;
  pickSave(suggested: string, spec: PickSpec): Promise<DocumentRef>;
  /** Write bytes. Atomic on desktop; streams or downloads on web. */
  write(ref: DocumentRef, blob: Blob): Promise<void>;
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
  /** Desktop only: files opened via argv, double-click, or second launch. */
  onOpenFiles(fn: (files: OpenedFile[]) => void): void;
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
  /** Start a check. The shell answers in its own dialogs, so nothing comes back. */
  check(): Promise<void>;
}

/** What the shell is told about the document on screen. */
export interface DocumentState {
  title: string;
  ref: DocumentRef | null;
  dirty: boolean;
}

/** The whole of what a shell answers. */
export interface Platform {
  files: FilesPort;
  lifecycle: LifecyclePort;
  native: NativePort;
  updates: UpdatesPort;
  /** Tell the shell what is on screen. No-op on web. */
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

const canPick = () => hasWindow() && typeof window.showSaveFilePicker === 'function';

const webFiles: FilesPort = {
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
    const writable = await handle.createWritable();
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
};

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
};

const web: Platform = {
  files: webFiles,
  lifecycle: webLifecycle,
  native: webNative,
  updates: webUpdates,
  setDocument: () => {},
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
  setDocument(state) { current.setDocument(state); },
  relaunch() { current.relaunch(); },
};
