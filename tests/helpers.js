// Shared test helpers. Tests import real modules from web/ under `node --test`.
// Browser globals are stubbed here, not in the modules themselves.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

import { linkedSheets } from '../tools/gen-shell.mjs';

/** Repo root, from tests/ */
export const ROOT = resolve(import.meta.dirname, '..');
export const WEB = join(ROOT, 'web');
export const JS = join(WEB, 'assets', 'js');

/** Licence manifest under .github/, shared by four tests. */
export const THIRD_PARTY = join(ROOT, '.github', 'THIRD-PARTY.md');

/** Every file under `dir` matching one of `exts`, as paths relative to `from`. */
export function walk(dir, exts, from = WEB) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, exts, from));
      continue;
    }
    if (exts.some(e => entry.endsWith(e))) {
      // Forward slashes: these are compared against URLs in sw.js, not paths.
      out.push(relative(from, full).split(sep).join('/'));
    }
  }
  return out;
}

export const read = path => readFileSync(path, 'utf8');

/** App stylesheets in cascade order, read from index.html's links. Excludes
 * tokens.css and fonts.css, the property table and the @font-face set. */
export const APP_CSS_ORDER = linkedSheets(readFileSync(join(WEB, 'index.html'), 'utf8'))
  .filter(name => name !== 'tokens.css' && name !== 'fonts.css');

export const appCss = () => APP_CSS_ORDER
  .map(name => readFileSync(join(WEB, 'assets', 'css', name), 'utf8'))
  .join('\n');

/** Board item with geometry defaults. Tests override only what they test. */
export function item(props = {}) {
  return { id: 'i1', type: 'generic', x: 0, y: 0, w: 100, h: 100, rot: 0, z: 1, name: '', asset: null, meta: {}, ...props };
}

/** Deterministic bytes, so a failure is reproducible rather than a one-off. */
export function bytes(n, seed = 1) {
  const out = new Uint8Array(n);
  let h = seed >>> 0;
  for (let i = 0; i < n; i++) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
    out[i] = h & 0xff;
  }
  return out;
}

/** Bytes that compress hard - a run of one value. For ratio/bomb tests. */
export const zeros = n => new Uint8Array(n);

/** Next microtask. The fake below is asynchronous the way IndexedDB is. */
export const soon = fn => Promise.resolve().then(fn);

/** In-memory StoreBackend (the idb.ts contract, not the database itself).
 * Use this for tests of session.ts, library.ts, matte-cache.ts.
 * Separate Map per store name. stats.writes counts landed keys. */
export function memoryStore() {
  const stores = new Map();
  const of = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const stats = { writes: 0, deletes: 0 };
  const backend = {
    get: async (s, k) => of(s).get(k),
    set: async (s, k, v) => { stats.writes++; of(s).set(k, v); },
    del: async (s, k) => { stats.deletes++; of(s).delete(k); },
    keys: async s => [...of(s).keys()],
    clear: async s => { of(s).clear(); },
    getMany: async (s, keys) => keys.map(k => of(s).get(k)),
    setMany: async (s, entries) => {
      for (const [k, v] of entries) { stats.writes++; of(s).set(k, v); }
      return [];
    },
    delMany: async (s, keys) => {
      for (const k of keys) { stats.deletes++; of(s).delete(k); }
      return [];
    },
  };
  backend.stores = stores;
  backend.stats = stats;
  return backend;
}

/** Fake indexedDB with controllable transaction outcome (complete/abort/error).
 * `openFailures` exercises the reconnect path. Shared by idb and matte-cache tests. */
export function fakeIndexedDB({ txOutcome = 'complete', openFailures = 0 } = {}) {
  const data = new Map();
  let remainingFailures = openFailures;
  // Transaction count lets tests assert batch calls are one round trip.
  const stats = { transactions: 0 };

  function makeRequest(result) {
    const t = makeRequest.tx;
    // Transaction commits after the last request, not the first.
    t.pending++;
    const r = {};
    soon(() => {
      r.result = result;
      r.onsuccess && r.onsuccess();
      // Outcome fires after request success — the abort case catches early-resolve bugs.
      soon(() => {
        if (--t.pending > 0) return;
        if (txOutcome === 'abort') { t.error = new Error('aborted'); t.onabort && t.onabort(); }
        else if (txOutcome === 'error') { t.error = new Error('tx error'); t.onerror && t.onerror(); }
        else t.oncomplete && t.oncomplete();
      });
    });
    return r;
  }

  return {
    open() {
      const req = {};
      soon(() => {
        if (remainingFailures > 0) {
          remainingFailures--;
          req.error = new Error('open failed');
          req.onerror && req.onerror();
          return;
        }
        const store = {
          put(v, k) { data.set(k, v); return makeRequest(v); },
          get(k) { return makeRequest(data.get(k)); },
          delete(k) { data.delete(k); return makeRequest(undefined); },
          clear() { data.clear(); return makeRequest(undefined); },
          getAllKeys() { return makeRequest([...data.keys()]); },
        };
        const db = {
          objectStoreNames: { contains: () => true },
          createObjectStore() {},
          close() {},
          transaction() {
            stats.transactions++;
            const t = { objectStore: () => store, pending: 0 };
            makeRequest.tx = t;
            return t;
          },
        };
        req.result = db;
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
    stats,
  };
}

/** A 64-char hex hash from a readable label. Shape only — use realHash() when
 * content must match. */
export const hash = label => {
  const hex = [...label].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return (hex + 'f'.repeat(64)).slice(0, 64);
};

/** The actual SHA-256 of some bytes, for the paths that verify content. */
export async function realHash(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
