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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    if (req) {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } else {
      t.oncomplete = () => resolve();
    }
  }));
}

export const idbGet = (store, key) => tx(store, 'readonly', s => s.get(key));
export const idbSet = (store, key, value) => tx(store, 'readwrite', s => s.put(value, key));
export const idbDel = (store, key) => tx(store, 'readwrite', s => s.delete(key));
export const idbKeys = store => tx(store, 'readonly', s => s.getAllKeys());
export const idbClear = store => tx(store, 'readwrite', s => s.clear());

/** True when IndexedDB is usable at all (private modes can refuse it). */
export async function idbAvailable() {
  try { await open(); return true; } catch { return false; }
}
