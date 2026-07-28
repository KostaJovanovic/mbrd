// Tiny IndexedDB wrapper for the working-state cache.
//
// Two stores: `kv` holds the board snapshot and bookkeeping, `assets` holds the
// raw Blobs keyed by content hash. This is the crash-recovery layer only - the
// durable artefact is always the .mbrd file the user saves.

const DB_NAME = 'mbrd';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets');
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab opening a newer schema version blocks on any connection
      // still holding the old one. Step aside and drop the cached handle so the
      // next operation reconnects, instead of deadlocking that upgrade forever.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    // A permanently rejected dbPromise would poison every later operation, so
    // clear it on failure: the connection is worth retrying (private-mode
    // toggles, transient quota, a blocking sibling tab that later closes).
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => {
      dbPromise = null;
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
function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    let settled = false;
    const fail = err => { if (!settled) { settled = true; reject(err); } };
    const req = fn(t.objectStore(store));
    if (req) {
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
