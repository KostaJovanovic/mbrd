// Tiny IndexedDB wrapper for the working-state cache.
//
// Two stores: `kv` holds the board snapshot and bookkeeping, `assets` holds the
// raw Blobs keyed by content hash. This is the crash-recovery layer only - the
// durable artefact is always the .mbrd file the user saves.

const DB_NAME = 'mbrd';
// v2 adds the `library` store. Purely additive - the upgrade below only creates
// stores that are absent, so an existing `kv`/`assets` database keeps every byte
// it had and simply gains an empty third store. See storage/library.js.
const DB_VERSION = 2;

/**
 * The three stores this database has, spelled out rather than left as `string`.
 *
 * Every store is created in the upgrade below, so the set is closed and a typo
 * in a caller is a compile error rather than a transaction that throws
 * NotFoundError at the moment somebody tries to save.
 */
export type StoreName = 'kv' | 'assets' | 'library';

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Which open() the cached promise belongs to.
 *
 * Every way a connection ends drops the cache so the next call reconnects, and
 * some of those arrive late - a `close` event for a handle that was replaced
 * two reconnects ago. Without the stamp, that late arrival throws away a
 * perfectly good current connection, and on a bad day the two take turns.
 */
let generation = 0;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const mine = ++generation;
  const forget = () => { if (generation === mine) dbPromise = null; };
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // `blocked` is not the end of an open request - it means "waiting on the
    // other connections", and success can still follow once they close. So the
    // promise below is settled at most once, and a connection that arrives
    // after we have already given up is closed rather than kept: nobody is
    // holding it, and an idle connection nobody owns is itself what blocks the
    // next tab's upgrade. Reachable since DB_VERSION went to 2: a tab still
    // holding a v1 connection blocks this open until it closes.
    let settled = false;
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets');
      // The board library: one packed .mbrd blob per saved board, keyed by board
      // id. Self-contained, so it never touches the `assets` store the live board
      // is swept against - a board in here survives regardless of what the active
      // board's autosave deletes.
      if (!db.objectStoreNames.contains('library')) db.createObjectStore('library');
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab opening a newer schema version blocks on any connection
      // still holding the old one. Step aside and drop the cached handle so the
      // next operation reconnects, instead of deadlocking that upgrade forever.
      db.onversionchange = () => { db.close(); forget(); };
      // The connection ending without this tab asking. Storage eviction and
      // "Clear site data" from another tab both force-close every open handle,
      // and nothing else here would notice: the promise stays cached and
      // resolves forever to a dead connection, every db.transaction() throws
      // InvalidStateError, and storage/session.js latches cacheOk = false on the
      // first of those - so nothing is saved again for the rest of the session
      // on a browser where reconnecting would have worked immediately.
      db.onclose = forget;
      if (settled) { db.close(); return; }
      settled = true;
      resolve(db);
    };
    // A permanently rejected dbPromise would poison every later operation, so
    // clear it on failure: the connection is worth retrying (private-mode
    // toggles, transient quota, a blocking sibling tab that later closes).
    req.onerror = () => {
      forget();
      if (settled) return;
      settled = true;
      reject(req.error);
    };
    // Reject rather than wait: a save that hangs until another tab happens to
    // close is worse than one that fails and says so, and dropping dbPromise
    // means the next operation simply tries again.
    req.onblocked = () => {
      forget();
      if (settled) return;
      settled = true;
      reject(req.error || new Error('IndexedDB open blocked by another tab'));
    };
  });
  return dbPromise;
}

// Resolve from `transaction.oncomplete`, never from `request.onsuccess`. A put,
// delete or clear reports request success once the operation is *accepted*; the
// transaction can still abort afterwards. Resolving early would let the caller
// (autosave, cache sweep, "clear everything") treat not-yet-durable bytes as
// saved. The request result is captured and handed back only once the whole
// transaction commits. Reads take the same path - completion follows success,
// so the captured value is ready.
// `fn` may issue one request or an array of them. Many requests in one
// transaction is the whole point of the batch calls below: a transaction is not
// free - it is opened, scheduled and committed - and doing one per asset made
// putting a photo board away a few hundred sequential round trips, each waiting
// on the last because the caller awaited it. Issued together they are one
// commit, and IndexedDB was built to be driven this way.
/**
 * The four members of a request this module touches, named structurally rather
 * than as `IDBRequest<unknown>`.
 *
 * IDBRequest is invariant in its result - its handlers carry a `this` of the
 * same type - so an IDBRequest<IDBValidKey> from put() is not an
 * IDBRequest<unknown>, and a union of the latter would reject every call below.
 * This says what the body actually needs, which every request satisfies
 * whatever it resolves to.
 */
type PendingRequest = {
  result: unknown,
  error: DOMException | null,
  onsuccess: ((ev: Event) => void) | null,
  onerror: ((ev: Event) => void) | null,
};

/** What `fn` may issue: one request, or a batch of them. */
type Issued = PendingRequest | PendingRequest[];

/**
 * The value a caller gets back, worked out from what `fn` issued: the request's
 * own result for one, an array of them for a batch. The two shapes are the two
 * branches of the body, restated so the callers below need no cast.
 */
type ResultOf<F extends Issued> =
  F extends IDBRequest<infer R>[] ? R[] :
  F extends IDBRequest<infer R> ? R : unknown;

/**
 * One transaction, on whatever connection is current.
 *
 * Split from tx() so the retry below can run the same thing twice without the
 * two spellings ever drifting.
 */
function once<F extends Issued>(
  store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => F,
): Promise<unknown> {
  return open().then(db => new Promise<unknown>((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result: unknown;
    let settled = false;
    const fail = (err: unknown) => { if (!settled) { settled = true; reject(err); } };
    // Annotated rather than inferred so the Array.isArray branch below narrows
    // to a concrete request type instead of to a piece of the generic.
    const req: Issued = fn(t.objectStore(store));
    if (Array.isArray(req)) {
      // Results in the order the requests were issued, filled as they succeed
      // and handed over only at oncomplete like everything else here.
      const out: unknown[] = new Array(req.length);
      req.forEach((r, i) => {
        r.onsuccess = () => { out[i] = r.result; };
        r.onerror = () => fail(r.error);
      });
      result = out;
    } else if (req) {
      req.onsuccess = () => { result = req.result; };
      req.onerror = () => fail(req.error);
    }
    t.oncomplete = () => { if (!settled) { settled = true; resolve(result); } };
    t.onerror = () => fail(t.error);
    t.onabort = () => fail(t.error);
  }));
}

/**
 * Whether a failure is the connection being gone rather than the work being
 * wrong.
 *
 * db.transaction() on a closed handle throws InvalidStateError, and that is the
 * whole shape: nothing about the store, the key or the value is at fault, and
 * the same call on a fresh connection succeeds.
 */
function deadHandle(err: unknown): boolean {
  // SAFETY: the two tests on the same line are the check - a truthy object is
  // the only thing this reads a `name` off, and the property is declared
  // optional so a DOMException without one compares false rather than throwing.
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'InvalidStateError';
}

/**
 * A transaction, with one reconnect if the connection died under it.
 *
 * Exactly one. A retry loop on a database that is genuinely gone is a page that
 * hangs instead of one that says so, and every caller here already treats a
 * rejection as an answer. What this buys is the case the loop would not help
 * with anyway: the handle was force-closed - storage eviction, "Clear site
 * data" in another tab - open() has already dropped it (see db.onclose), and
 * the second attempt opens a new one and does the work. Without it, the first
 * save after an eviction latched cacheOk = false and nothing was written again
 * for the rest of the session.
 *
 * Re-issuing `fn` is safe because there is nothing to re-issue *into*: the
 * first attempt threw before a transaction existed, so no request was accepted
 * and no half-write is being repeated.
 */
function tx<F extends Issued>(
  store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => F,
): Promise<ResultOf<F>> {
  // SAFETY: `result` is exactly what the requests `fn` issued produced, and
  // ResultOf<F> is the same two-way branch the body of once() takes - one
  // request's result, or an array of them in issue order.
  return once(store, mode, fn).catch(err => {
    if (!deadHandle(err)) throw err;
    dbPromise = null;
    return once(store, mode, fn);
  }) as Promise<ResultOf<F>>;
}

/**
 * The value stored under `key`, or undefined if there is none.
 *
 * `unknown` rather than a shape: what comes out was written by some build of
 * this app, possibly an older one, and deciding whether it is recognisable is
 * the reader's job. Every caller already checks - Array.isArray, instanceof
 * Blob, a version field - and this is the type saying they must.
 */
export const idbGet = (store: StoreName, key: IDBValidKey): Promise<unknown> =>
  tx(store, 'readonly', s => s.get(key));
export const idbSet = (store: StoreName, key: IDBValidKey, value: unknown) =>
  tx(store, 'readwrite', s => s.put(value, key));
export const idbDel = (store: StoreName, key: IDBValidKey) =>
  tx(store, 'readwrite', s => s.delete(key));
export const idbKeys = (store: StoreName): Promise<IDBValidKey[]> =>
  tx(store, 'readonly', s => s.getAllKeys());
export const idbClear = (store: StoreName) => tx(store, 'readwrite', s => s.clear());

// The batch forms. Empty in, empty out, without opening a transaction to do
// nothing - the autosave sweep reaches all three of these on a board where
// nothing changed, which is most of the time.

/** Values for `keys`, in that order. A missing key reads as undefined. */
export const idbGetMany = (store: StoreName, keys: IDBValidKey[]): Promise<unknown[]> =>
  keys.length ? tx(store, 'readonly', s => keys.map(k => s.get(k))) : Promise.resolve([]);

/** Write `[key, value]` pairs. All of them land, or none do. */
export const idbSetMany = (store: StoreName, entries: [IDBValidKey, unknown][]) =>
  entries.length ? tx(store, 'readwrite', s => entries.map(([k, v]) => s.put(v, k))) : Promise.resolve([]);

export const idbDelMany = (store: StoreName, keys: IDBValidKey[]) =>
  keys.length ? tx(store, 'readwrite', s => keys.map(k => s.delete(k))) : Promise.resolve([]);
