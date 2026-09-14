// Electron adapter: translates a Bridge object into the six Platform ports.
// Reads no global -- main.ts hands the bridge in as an argument.
// Blobs do not cross IPC; this seam converts ArrayBuffer+mime both ways.

import type {
  Platform, FilesPort, LifecyclePort, NativePort, UpdatesPort,
  DocumentRef, OpenedFile, PickSpec, TranscodeOpts, BoardFolder, FolderBoard,
} from './platform.ts';
// StoreBackend is not imported: platform/ sits below storage/ in the layer
// graph, so electronStore() is checked structurally at the wiring point.

/** What `desktop/preload.ts` exposes. Written here to avoid cross-package import. */
export interface Bridge {
  bridge: number;
  /** Set by the Android shell ('capacitor'), absent on the desktop. */
  shell?: string;
  store: {
    get(store: string, key: string): Promise<unknown>;
    set(store: string, key: string, value: unknown): Promise<void>;
    del(store: string, key: string): Promise<void>;
    keys(store: string): Promise<string[]>;
    clear(store: string): Promise<void>;
    getMany(store: string, keys: string[]): Promise<unknown[]>;
    setMany(store: string, entries: [string, unknown][]): Promise<void>;
    delMany(store: string, keys: string[]): Promise<void>;
  };
  files: {
    pickOpen(): Promise<HandedFile | null>;
    pickSave(suggested: string): Promise<{ name: string, path: string } | null>;
    pickImport(): Promise<HandedFile[]>;
    write(path: string, data: ArrayBuffer): Promise<void>;
    read(path: string): Promise<HandedFile>;
    exists(path: string): Promise<boolean>;
  };
  /** The boards folder. The Android shell answers list() with null, because
   *  its folder is MbrdRoot's and it keeps no list of its own yet. */
  boards: {
    list(): Promise<{ folder: string, files: FolderBoard[] } | null>;
    create(suggested: string, data: ArrayBuffer): Promise<{ name: string, path: string }>;
    rename(path: string, suggested: string): Promise<{ name: string, path: string } | null>;
    trash(path: string): Promise<void>;
    reveal(): Promise<void>;
  };
  native: {
    can(): Promise<{ transcode: boolean, matte: boolean }>;
    firstFrame(bytes: ArrayBuffer): Promise<Uint8Array | null>;
    transcode(bytes: ArrayBuffer, opts: unknown): Promise<Uint8Array | null>;
    matte(input: Float32Array): Promise<Float32Array | null>;
    decode(bytes: ArrayBuffer, name: string): Promise<Uint8Array | null>;
  };
  updates: {
    check(): Promise<void>;
  };
  startupNotes(): Promise<string>;
  setDocument(state: { title: string, name: string | null, path: string | null, dirty: boolean }): void;
  relaunch(): void;
  onClose(fn: () => Promise<void>): void;
  onOpenFiles(fn: (files: HandedFile[]) => void): void;
  onCommand(fn: (cmd: string) => void): void;
  /** Set by the Android shell, whose Back button asks `fn` first. */
  onBack?(fn: () => boolean): void;
}

/** A file the main process read: bytes, name, and path. */
export interface HandedFile {
  name: string;
  path: string;
  data: ArrayBuffer;
}

/** Tagged wrapper so the far side can tell a Blob from a JSON value. */
interface Bytes {
  __bytes: true;
  data: ArrayBuffer;
  mime?: string;
}

const isBytes = (v: unknown): v is Bytes =>
  // SAFETY: a non-null object, read for one field that is compared, not trusted.
  !!v && typeof v === 'object' && (v as Bytes).__bytes === true;

/** Dismissed-picker error. */
function abort(what: string): Error {
  const err = new Error(what);
  err.name = 'AbortError';
  return err;
}

const fileOf = (h: HandedFile) => new File([h.data], h.name);
const refOf = (h: { name: string, path: string }): DocumentRef => ({ name: h.name, path: h.path });

/** Recursively convert Blobs to `{ __bytes, data, mime }` for IPC. */
async function down(value: unknown): Promise<unknown> {
  if (value instanceof Blob) {
    return { __bytes: true, data: await value.arrayBuffer(), mime: value.type } satisfies Bytes;
  }
  if (Array.isArray(value)) return Promise.all(value.map(down));
  if (isPlain(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = await down(v);
    return out;
  }
  return value;
}

/** Reverse: bytes wrappers back to Blobs. */
function up(value: unknown): unknown {
  if (isBytes(value)) return new Blob([value.data], { type: value.mime || '' });
  if (Array.isArray(value)) return value.map(up);
  if (isPlain(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = up(v);
    return out;
  }
  return value;
}

/** Only plain objects are safe to walk; Date, Map, TypedArray etc. are not. */
function isPlain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Assert string key; non-strings would break the file backend's naming. */
function k(key: unknown): string {
  if (typeof key !== 'string') throw new Error('the desktop store keys by string');
  return key;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** idb.ts's eight functions, backed by files. Wired separately in main.ts. */
export function electronStore(bridge: Bridge) {
  return {
    get: async (store: string, key: unknown) => up(await bridge.store.get(store, k(key))),
    set: async (store: string, key: unknown, value: unknown) =>
      bridge.store.set(store, k(key), await down(value)),
    del: (store: string, key: unknown) => bridge.store.del(store, k(key)),
    keys: (store: string) => bridge.store.keys(store),
    clear: (store: string) => bridge.store.clear(store),
    getMany: async (store: string, list: unknown[]) =>
      (await bridge.store.getMany(store, list.map(k))).map(up),
    setMany: async (store: string, entries: [unknown, unknown][]) => {
      // SAFETY: k() returns a string or throws, so each literal is a real pair.
      // The assertion keeps the tuple type an array literal would widen away.
      const packed = await Promise.all(
        entries.map(async ([key, value]) => [k(key), await down(value)] as [string, unknown]));
      return bridge.store.setMany(store, packed);
    },
    delMany: (store: string, list: unknown[]) => bridge.store.delMany(store, list.map(k)),
  };
}

// ---------------------------------------------------------------------------
// The ports
// ---------------------------------------------------------------------------

function electronFolder(bridge: Bridge): BoardFolder {
  return {
    list: () => bridge.boards.list(),
    create: async (suggested, blob) =>
      refOf(await bridge.boards.create(suggested, await blob.arrayBuffer())),
    async rename(ref, suggested) {
      if (!ref.path) return null;
      const moved = await bridge.boards.rename(ref.path, suggested);
      return moved ? refOf(moved) : null;
    },
    async trash(ref) {
      if (ref.path) await bridge.boards.trash(ref.path);
    },
    reveal: () => bridge.boards.reveal(),
  };
}

function electronFiles(bridge: Bridge): FilesPort {
  return {
    folder: electronFolder(bridge),
    canPick: () => true,

    async pickOpen(_spec: PickSpec) {
      const handed = await bridge.files.pickOpen();
      if (!handed) throw abort('Nothing picked');
      return { file: fileOf(handed), ref: refOf(handed) };
    },

    async pickSave(suggested: string, _spec: PickSpec) {
      const ref = await bridge.files.pickSave(suggested);
      if (!ref) throw abort('Nothing picked');
      return refOf(ref);
    },

    async write(ref: DocumentRef, blob: Blob) {
      // No path: prompt for one rather than downloading silently.
      const target = ref.path ?? (await bridge.files.pickSave(ref.name))?.path;
      if (!target) throw abort('Nothing picked');
      await bridge.files.write(target, await blob.arrayBuffer());
    },

    async pickImport(_spec: PickSpec) {
      return (await bridge.files.pickImport()).map(fileOf);
    },

    async read(ref: DocumentRef) {
      if (!ref.path) throw abort('That document has no file');
      return fileOf(await bridge.files.read(ref.path));
    },

    async exists(ref: DocumentRef) {
      if (!ref.path) return true;
      return bridge.files.exists(ref.path);
    },
  };
}

function electronLifecycle(bridge: Bridge): LifecyclePort {
  return {
    onCloseRequested(fn) {
      // Main holds the close until this resolves; a throw still lets it close.
      bridge.onClose(async () => {
        try {
          await fn();
        } catch (err) {
          console.warn('[mbrd] close handler:', err);
        }
      });
    },
    onOpenFiles(fn) {
      bridge.onOpenFiles(handed => {
        fn(handed.map((h): OpenedFile => ({ file: fileOf(h), ref: refOf(h) })));
      });
    },
    onBack(fn) {
      bridge.onBack?.(fn);
    },
  };
}

/** Native port. Null on failure; callers always have a fallback. */
function electronNative(bridge: Bridge): NativePort {
  // Asked once at boot; false until the answer arrives (safe default).
  let canTranscode = false;
  bridge.native.can()
    .then(can => { canTranscode = can.transcode; })
    .catch(() => { /* an older shell with no such channel; false stands */ });

  // Copy into an unshared ArrayBuffer; Node's Buffer may share its allocation.
  const bytesToBlob = (data: Uint8Array | null, type: string): Blob | null => {
    if (!data?.length) return null;
    const buffer = new ArrayBuffer(data.length);
    new Uint8Array(buffer).set(data);
    return new Blob([buffer], { type });
  };

  // Collapse failures to null: callers do not distinguish can't from won't.
  const quiet = async <T>(work: Promise<T>): Promise<T | null> => {
    try {
      return await work;
    } catch (err) {
      console.warn('[mbrd] the shell could not do that natively:', err);
      return null;
    }
  };

  return {
    canTranscode: () => canTranscode,

    firstFrame: async (bytes: ArrayBuffer) =>
      bytesToBlob(await quiet(bridge.native.firstFrame(bytes)), 'image/png'),

    transcode: async (bytes: ArrayBuffer, _name: string, opts: TranscodeOpts) =>
      bytesToBlob(await quiet(bridge.native.transcode(bytes, opts)), 'video/mp4'),

    matte: async (input: Float32Array) => quiet(bridge.native.matte(input)),

    decode: async (bytes: ArrayBuffer, name: string) => {
      const png = bytesToBlob(await quiet(bridge.native.decode(bytes, name)), 'image/png');
      if (!png) return null;
      // ImageBitmap cannot cross IPC; PNG bytes travel instead.
      return createImageBitmap(png);
    },
  };
}

/** Update port. The shell answers in its own dialogs. */
function electronUpdates(bridge: Bridge): UpdatesPort {
  return {
    check: () => bridge.updates.check().catch(() => {}),
  };
}

/** Assemble all ports from a bridge. Called once from main.ts. */
export function electronPlatform(bridge: Bridge): Platform {
  return {
    files: electronFiles(bridge),
    lifecycle: electronLifecycle(bridge),
    native: electronNative(bridge),
    updates: electronUpdates(bridge),
    setDocument: state => bridge.setDocument({
      title: state.title,
      name: state.ref?.name ?? null,
      path: state.ref?.path ?? null,
      dirty: state.dirty,
    }),
    relaunch: () => bridge.relaunch(),
  };
}
