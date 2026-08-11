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

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // `blocked` is not the end of an open request - it means "waiting on the
    // other connections", and success can still follow once they close. So the
    // promise below is settled at most once, and a connection that arrives
    // after we have already given up is closed rather than kept: nobody is
    // holding it, and an idle connection nobody owns is itself what blocks the
    // next tab's upgrade. Unreachable while DB_VERSION stays 1 - no open ever
    // needs a version change - and here for the first bump that changes it.
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
      db.onversionchange = () => { db.close(); dbPromise = null; };
      if (settled) { db.close(); return; }
      settled = true;
      resolve(db);
    };
    // A permanently rejected dbPromise would poison every later operation, so
    // clear it on failure: the connection is worth retrying (private-mode
    // toggles, transient quota, a blocking sibling tab that later closes).
    req.onerror = () => {
      dbPromise = null;
      if (settled) return;
      settled = true;
      reject(req.error);
    };
    // Reject rather than wait: a save that hangs until another tab happens to
    // close is worse than one that fails and says so, and dropping dbPromise
    // means the next operation simply tries again.
    req.onblocked = () => {
      dbPromise = null;
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
function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    let settled = false;
    const fail = err => { if (!settled) { settled = true; reject(err); } };
    const req = fn(t.objectStore(store));
    if (Array.isArray(req)) {
      // Results in the order the requests were issued, filled as they succeed
      // and handed over only at oncomplete like everything else here.
      const out = new Array(req.length);
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

export const idbGet = (store, key) => tx(store, 'readonly', s => s.get(key));
export const idbSet = (store, key, value) => tx(store, 'readwrite', s => s.put(value, key));
export const idbDel = (store, key) => tx(store, 'readwrite', s => s.delete(key));
export const idbKeys = store => tx(store, 'readonly', s => s.getAllKeys());
export const idbClear = store => tx(store, 'readwrite', s => s.clear());

// The batch forms. Empty in, empty out, without opening a transaction to do
// nothing - the autosave sweep reaches all three of these on a board where
// nothing changed, which is most of the time.

/** Values for `keys`, in that order. A missing key reads as undefined. */
export const idbGetMany = (store, keys) =>
  keys.length ? tx(store, 'readonly', s => keys.map(k => s.get(k))) : Promise.resolve([]);

/** Write `[key, value]` pairs. All of them land, or none do. */
export const idbSetMany = (store, entries) =>
  entries.length ? tx(store, 'readwrite', s => entries.map(([k, v]) => s.put(v, k))) : Promise.resolve([]);

export const idbDelMany = (store, keys) =>
  keys.length ? tx(store, 'readwrite', s => keys.map(k => s.delete(k))) : Promise.resolve([]);
