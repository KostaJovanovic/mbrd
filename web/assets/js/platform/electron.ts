// The Electron shell, as this app's six ports.
//
// One function of a bridge object, and that is the whole design. `electron.ts`
// reads no global, imports nothing but its neighbour, and would run against any
// object of the right shape - which is what lets it be tested with a fake and
// what keeps the rule the plan is built on: **`window.mbrdDesktop` is read in
// exactly one place in this tree**, and that place is `main.ts`, which hands
// the object in here as an argument.
//
// If this module reached for the global itself, every module below main.ts
// would depend on a name that only one of two shells defines, and the whole
// point of the injection is that they cannot tell.
//
// ── Blobs do not cross the bridge ──
//
// Electron's IPC is structured clone, which handles ArrayBuffer and does not
// handle Blob. So the conversion is here, both directions, at exactly this
// seam - and nowhere else. `session.ts` puts a Blob into `idbSet` and gets a
// Blob back out of `idbGet`, unchanged and unaware, because this file turns
// each one into bytes on the way down and back into a Blob on the way up.
//
// The MIME type travels with it. A Blob whose type was lost comes back as
// `application/octet-stream`, and `storage/assets.ts` renders an asset by its
// blob's own type - so losing it turns every picture on a restored board into a
// download prompt. That is why the wrapper carries a `mime` field rather than
// just bytes.
//
// ── What this file does not do ──
//
// Decide anything. Every question - is this a desktop, should Save write a
// file, is this row a path row - is answered upstream by `isDesktop()` or by
// the shape of the data. This is a translation layer: bytes to Blobs, a
// callback registration to an IPC listener, a rejection shape to another
// rejection shape. A branch in here would be a second place the desktop's
// behaviour is decided.

import type {
  Platform, FilesPort, LifecyclePort, NativePort, UpdatesPort,
  DocumentRef, OpenedFile, PickSpec, TranscodeOpts, UpdateInfo,
} from './platform.ts';
// Note what is *not* imported here: `StoreBackend` from storage/idb.ts.
//
// It would be a type-only import, erased before anything runs, but
// tests/layers.test.js reads the specifier and not its erasure - and it is
// right to: a rule that made an exception for `import type` would be a rule
// somebody has to check the spelling of. platform/ is BASE and storage/ sits
// above it, so the edge is an inversion however little of it survives to
// runtime.
//
// So electronStore() below is checked structurally instead, at the one place
// the two layers legitimately meet: `setStoreBackend(electronStore(bridge))` in
// main.ts, which is above both and is where every other injection in this app
// is wired. A method renamed on one side fails there.

/**
 * What `desktop/preload.ts` exposes. Structural, not nominal.
 *
 * Declared here rather than imported from `desktop/` because the two are
 * separate packages with separate tsconfigs, and a web module importing across
 * that line would drag Node's types into a browser-only compilation - which is
 * the thing the root tsconfig's `types: []` exists to prevent. So the shape is
 * written twice, once on each side, and the bridge version below is what
 * catches them drifting.
 */
export interface Bridge {
  bridge: number;
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
  relaunch(): void;
  onClose(fn: () => Promise<void>): void;
  onOpenFiles(fn: (files: HandedFile[]) => void): void;
}

/** A file main read for us: bytes, and what it was called and where. */
export interface HandedFile {
  name: string;
  path: string;
  data: ArrayBuffer;
}

/**
 * The wrapper a Blob travels as.
 *
 * A tagged object rather than a bare ArrayBuffer, because the store holds both
 * kinds - JSON values and Blobs - and the far side has to be able to tell them
 * apart without guessing from the type. `desktop/store.ts` reads the same tag.
 */
interface Bytes {
  __bytes: true;
  data: ArrayBuffer;
  mime?: string;
}

// SAFETY: the truthy-object guard comes first, so the property read is off an
// object, and the tag is compared rather than trusted - a value that is not a
// wrapper compares false rather than throwing.
const isBytes = (v: unknown): v is Bytes =>
  !!v && typeof v === 'object' && (v as Bytes).__bytes === true;

/** The one throw a dismissed dialog makes, in the shape every caller reads. */
function abort(what: string): Error {
  const err = new Error(what);
  err.name = 'AbortError';
  return err;
}

const fileOf = (h: HandedFile) => new File([h.data], h.name);
const refOf = (h: { name: string, path: string }): DocumentRef => ({ name: h.name, path: h.path });

/**
 * Blobs to bytes, wherever they are in the value.
 *
 * **Not just at the top, and that is the whole of this function.** The `assets`
 * store holds `{ blob, ext, mime, name }` - a Blob one level down inside an
 * ordinary object - while `library` holds a packed Blob directly. A converter
 * that only looked at the top handled the second and quietly wrecked the first:
 * `JSON.stringify` turns a Blob into `{}`, so every asset landed on disk as
 * `{"blob":{},"ext":"png",...}` and came back as an item with no picture in it.
 * It was found by running the shell and looking at the file, which is the only
 * way it *could* be found - nothing throws, and restoreSession() reports it as
 * "N items came back without their data", which reads like a corrupt store
 * rather than a bug in the bridge.
 *
 * Arrays and plain objects are walked; everything else is passed through. No
 * cycle guard, deliberately: what goes into this store is a board snapshot and
 * an asset record, both acyclic by construction, and structured clone across
 * the bridge would refuse a cycle anyway. A guard here would be a defence
 * against a value this store cannot hold.
 */
async function down(value: unknown): Promise<unknown> {
  if (value instanceof Blob) {
    // The type travels with the bytes. storage/assets.ts renders an asset by
    // its blob's own MIME, so a Blob that came back as application/octet-stream
    // would turn every picture on a restored board into a download prompt.
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

/** The same walk, back. */
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

/**
 * An object worth walking into, as opposed to one that would be damaged by it.
 *
 * The prototype test rather than `typeof === 'object'`: a Date, a Map, a
 * TypedArray and a Blob are all objects, and rebuilding one of them field by
 * field turns it into something else. Only a literal is walked.
 */
function isPlain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Keys are strings here and `IDBValidKey` elsewhere.
 *
 * Every caller in this app passes a string. Anything else is a caller that
 * would break the file backend's naming rules, so it is refused at the seam
 * rather than stringified into a filename nobody meant.
 */
function k(key: unknown): string {
  if (typeof key !== 'string') throw new Error('the desktop store keys by string');
  return key;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * `idb.ts`'s eight functions, over files in the app's own data directory.
 *
 * Separate from the Platform below and wired separately in `main.ts`, because
 * `idb.ts` had its own setter before any of this existed - it was already a
 * port, which is the cheapest thing about the whole desktop plan.
 */
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
      // One message with every pair on it, not one per key. The renderer
      // already treats a batch as a single round trip, and turning it into N
      // would put the bridge's latency on every asset of a board.
      // SAFETY: the assertion names the tuple an array literal of two elements
      // would otherwise widen to `(string | unknown)[]`. Both elements are
      // produced on this line - k() has already refused a non-string key - so
      // there is no value being claimed about, only a shape being kept.
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

function electronFiles(bridge: Bridge): FilesPort {
  return {
    // Always. The desktop has a real dialog, which is what this question means.
    canPick: () => true,

    async pickOpen(_spec: PickSpec) {
      // The spec is the web's two spellings of an accept list and neither is
      // what a native dialog wants - main builds its own filters, from the
      // generated catalogue, because it is the side that has to name
      // extensions to the operating system.
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
      // A ref with no path is "there is no document here" - saveBlob()'s
      // derived artefacts, a PNG or a PDF of the board. On the web that is a
      // download; here it is a dialog, because a desktop app that dropped a
      // file into the downloads folder without asking would be a browser
      // wearing a window.
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
      // A ref with no path is one this shell did not make - a web ref restored
      // from an older store, or a derived artefact. There is nothing to check
      // and nothing to repair, so it answers the way the web does.
      if (!ref.path) return true;
      return bridge.files.exists(ref.path);
    },
  };
}

function electronLifecycle(bridge: Bridge): LifecyclePort {
  return {
    onCloseRequested(fn) {
      // The thing a browser tab could never do. Main holds the window's close
      // until this resolves, so the flush actually finishes rather than racing
      // the page going away - and `closeNow` is inside the same call, so a
      // handler that throws still lets the window close. A shell that could not
      // be quit because a save failed would be worse than a lost save.
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
  };
}

/**
 * Still null, all four of them.
 *
 * Group G is what fills these in - ffmpeg, onnxruntime-node, sharp - and until
 * then the desktop takes the same wasm and browser paths the web does. That is
 * why the protocol is "answer null and let the caller fall through": a shell
 * with no native side is not a broken shell, it is a slower one.
 */
function electronNative(_bridge: Bridge): NativePort {
  return {
    firstFrame: async () => null,
    transcode: async (_bytes: ArrayBuffer, _name: string, _opts: TranscodeOpts) => null,
    matte: async () => null,
    decode: async () => null,
  };
}

/** Group I. Until then the desktop is told about no updates, which is honest. */
function electronUpdates(_bridge: Bridge): UpdatesPort {
  return {
    check: async (): Promise<UpdateInfo | null> => null,
    install: () => {},
  };
}

/** The shell, assembled. `main.ts` calls this once with the bridge. */
export function electronPlatform(bridge: Bridge): Platform {
  return {
    files: electronFiles(bridge),
    lifecycle: electronLifecycle(bridge),
    native: electronNative(bridge),
    updates: electronUpdates(bridge),
    relaunch: () => bridge.relaunch(),
  };
}
