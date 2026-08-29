// Shared bits for the test suite.
//
// The app has no build step and no dependencies, and neither does this. Tests
// import the real modules out of web/ and run them under `node --test`.
//
// Anything a module needs from the browser is stubbed here rather than in the
// module itself: the point of the refactor that introduced these tests was to
// stop browser globals being reached for at import time, not to start writing
// the app around a test runner.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

/** Repo root, from tests/ */
export const ROOT = resolve(import.meta.dirname, '..');
export const WEB = join(ROOT, 'web');
export const JS = join(WEB, 'assets', 'js');

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

/**
 * The app's stylesheets in cascade order, concatenated - what used to be
 * app.css before it was split by subsystem.
 *
 * A test asserting that some rule exists is asking about the app's CSS, not
 * about which of eight files a rule happens to live in. Reading them as one
 * string keeps such a test true when a rule moves between subsystems, and stops
 * the split from being a thing every future assertion has to know about.
 *
 * The order is index.html's, which is the cascade - so a test that cares about
 * *precedence* (quality.css wins on document order, not specificity) still gets
 * an honest answer.
 *
 * tokens.css and fonts.css are deliberately out: they are the property table
 * and the @font-face set, and a test wanting either should say so.
 */
export const APP_CSS_ORDER = [
  'base.css', 'canvas.css',
  'items.css', 'ghosts.css', 'fences.css', 'media.css', 'cards.css',
  'item-chrome.css',
  'sidebar.css', 'chrome.css',
  'drawer.css', 'menu.css', 'library.css', 'status.css', 'dialog.css',
  'viewer.css', 'color-picker.css', 'sticker-pad.css',
  'mobile.css', 'timeline.css', 'quality.css',
];

export const appCss = () => APP_CSS_ORDER
  .map(name => readFileSync(join(WEB, 'assets', 'css', name), 'utf8'))
  .join('\n');

/**
 * A board item, with the defaults the geometry helpers assume. Tests override
 * only the fields they care about, which keeps a case about rotation from
 * being buried in eight irrelevant properties.
 */
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

/**
 * A fake `indexedDB` that lets a test dictate how the transaction ends.
 *
 * `txOutcome` is one of 'complete' | 'abort' | 'error'. `openFailures` is how
 * many times `open()` should fail before it starts succeeding, which is what
 * exercises the reconnect path.
 *
 * Here rather than in tests/idb.test.js, where it was written, because a second
 * suite now needs one: storage/matte-cache.ts is a cache over this database and
 * cannot be tested against a stub of itself. Two copies of a fake is two
 * definitions of what IndexedDB does, and they would disagree the first time one
 * of them was taught something.
 *
 * One `data` Map behind every store name, which is enough for both callers and
 * is the one way this is not the real thing: a test that needs two stores to be
 * genuinely separate has to say so here first.
 */
export function fakeIndexedDB({ txOutcome = 'complete', openFailures = 0 } = {}) {
  const data = new Map();
  let remainingFailures = openFailures;
  // How many transactions the fake has opened, so a test can assert that a
  // batch call really is one round trip and not a loop wearing a new name.
  const stats = { transactions: 0 };

  function makeRequest(result) {
    const t = makeRequest.tx;
    // A transaction ends once, after the last request in it has succeeded - the
    // real thing commits when its request queue drains, and a fake that ended
    // after the *first* one would let a broken batch look like a working one.
    t.pending++;
    const r = {};
    soon(() => {
      r.result = result;
      r.onsuccess && r.onsuccess();
      // Only after request success does the transaction reach its outcome. An
      // early-resolving wrapper would have already resolved by now - that is
      // exactly the bug the abort case catches.
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

/**
 * A content id of the right *shape*, from a short readable label.
 *
 * Tests used to write hashes as 'abc123', which read nicely and hid the fact
 * that a hash is a 64-character hex digest that the storage layer now checks
 * before letting it name a file. `hash('photo')` keeps a case readable while
 * being something the app would accept.
 *
 * Shape only - these do not digest to anything. Where the *content* has to
 * match the id, use realHash().
 */
export const hash = label => {
  const hex = [...label].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return (hex + 'f'.repeat(64)).slice(0, 64);
};

/** The actual SHA-256 of some bytes, for the paths that verify content. */
export async function realHash(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
