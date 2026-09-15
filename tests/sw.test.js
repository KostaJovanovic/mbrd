// The service worker's precache list must match what is actually on disk.
// SHELL is hand-maintained and had already rotted: it listed 2 of 7 bundled
// .woff2 files, and the missing ones included faces tokens.css depends on -
// so offline launches rendered the whole interface in fallback faces,
// silently. Asserted in both directions: an omission boots wrong, a stale
// entry 404s on install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

import { WEB, read, walk } from './helpers.js';

const sw = read(join(WEB, 'sw.js'));

/**
 * The SHELL array's entries, read out of the source rather than by
 * importing sw.js - it references `self` at module scope, and standing up
 * a fake worker global just to read a list of strings gains nothing.
 */
const shellUrls = (() => {
  const block = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(block, 'could not find the SHELL array in sw.js');
  return [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
})();

/** ...minus the bare navigation entry, which is not a file on disk. */
const shell = shellUrls.filter(p => p !== './');

test('SHELL lists every asset that ships', () => {
  // Every shipped stylesheet and face is precached - nothing is fetched on
  // demand any more, so a missing entry boots wrong offline, full stop.
  //
  // assets/js modules are deliberately NOT walked here: the app is
  // TypeScript now and the page loads the one esbuild bundle, not the
  // sources. Walking them would assert that ninety-odd files nothing
  // requests are precached - the wrong test, failing on every new module.
  const onDisk = [
    ...walk(join(WEB, 'assets', 'css'), ['.css']),
    ...walk(join(WEB, 'assets', 'fonts'), ['.woff2']),
  ];
  const listed = new Set(shell.map(p => p.replace(/^\.\//, '')));
  const missing = onDisk.filter(f => !listed.has(f));
  assert.deepEqual(missing, [], `not precached, so unavailable offline:\n  ${missing.join('\n  ')}`);

  // The two JavaScript files the browser really asks for. The media worker
  // is fetched by URL at runtime rather than imported, so it sits outside
  // the bundle and needs its own cache entry.
  assert.ok(listed.has('assets/app.js'),
    'the bundle is the app - without it an offline launch has no JavaScript at all');
  assert.ok(listed.has('assets/js/optimize/media-worker.js'),
    'the media worker is fetched by URL, so the bundle does not carry it');
});

test('SHELL carries no TypeScript source', () => {
  // A .ts path here would be a cache.add() for a file no browser can execute
  // - the mistake of re-adding the old module list by hand after the bundle
  // replaced it.
  const sources = shell.filter(p => p.endsWith('.ts'));
  assert.deepEqual(sources, [], `sources are not shipped assets:\n  ${sources.join('\n  ')}`);
});

test('SHELL has no entries pointing at files that are gone', () => {
  const stale = shell.filter(p => !existsSync(join(WEB, p.replace(/^\.\//, ''))));
  assert.deepEqual(stale, [], `listed in SHELL but not on disk:\n  ${stale.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// Install and activate, actually run
//
// The checks above prove SHELL's paths exist; they say nothing about a
// failed *fetch* - and activate deletes every older cache, so a half-filled
// install does not just fail to improve the shell, it destroys the last
// complete one. Run here against a fake Cache Storage, since there is no
// other way to see this.
// ---------------------------------------------------------------------------

/**
 * Load sw.js into a sandbox and hand back its registered handlers, along
 * with the fake cache storage it wrote to. `fails` names URLs whose fetch
 * should reject, standing in for one bad response during an update.
 */
function runWorker({ fails = [], existing = [], seed = {},
  net = async () => ({ ok: true, type: 'basic', body: 'network', clone() { return { body: 'network' }; } }),
} = {}) {
  const store = new Map(existing.map(name => [name, new Map([['seed', 'seed']])]));
  // Preload named caches with url->response entries, for the runtime-fetch
  // tests: sets up an *unrelated* origin cache holding the same URL.
  for (const [name, entries] of Object.entries(seed)) store.set(name, new Map(entries));
  const keyOf = x => (typeof x === 'string' ? x : x.url);
  const caches = {
    open: async name => {
      if (!store.has(name)) store.set(name, new Map());
      const entries = store.get(name);
      return {
        add: async url => {
          if (fails.includes(url)) throw new Error(`404 ${url}`);
          entries.set(url, 'response');
        },
        match: async x => entries.get(keyOf(x)),
        put: async (x, res) => { entries.set(keyOf(x), res); },
      };
    },
    keys: async () => [...store.keys()],
    delete: async name => store.delete(name),
    // Present but poisoned: the runtime path must never reach for the
    // origin-wide match. Throws if the fix regresses to caches.match().
    match: async () => { throw new Error('runtime lookup must be scoped to the version cache'); },
  };

  const handlers = new Map();
  const self = {
    location: { hostname: 'mbrd.example', origin: 'https://mbrd.example' },
    addEventListener: (type, fn) => handlers.set(type, fn),
    skipWaiting: async () => { self.skipped = true; },
    clients: { claim: async () => {} },
    skipped: false,
  };

  const sandbox = { self, caches, console, URL, fetch: net };
  sandbox.addEventListener = self.addEventListener;
  vm.createContext(sandbox);
  vm.runInContext(sw, sandbox, { filename: 'sw.js' });

  /** Run one handler and await whatever it passed to waitUntil. */
  const fire = async type => {
    let waited = Promise.resolve();
    await handlers.get(type)({ waitUntil: p => { waited = p; } });
    return waited;
  };

  /** Fire the fetch handler for one request; return the response it answered. */
  const fireFetch = async request => {
    let response, waited = Promise.resolve();
    handlers.get('fetch')({
      request: { method: 'GET', ...request },
      respondWith: p => { response = p; },
      waitUntil: p => { waited = p; },
    });
    const res = await response;
    await waited;
    return res;
  };

  return { store, self, fire, fireFetch };
}

const CURRENT = (() => {
  const m = sw.match(/const VERSION = '([^']+)'/);
  assert.ok(m, 'could not find VERSION in sw.js');
  return m[1];
})();

test('the cache version stays inside this app\'s namespace', () => {
  // activate deletes every cache starting with PREFIX. A VERSION outside it
  // would delete *itself* on the next activation - and save.bat rewrites
  // VERSION by regex on every commit, so the two really can part company.
  const prefix = sw.match(/const PREFIX = '([^']+)'/);
  assert.ok(prefix, 'could not find PREFIX in sw.js');
  assert.ok(CURRENT.startsWith(prefix[1]), `${CURRENT} is outside the ${prefix[1]} namespace`);
});

test('save.bat can still find the version line to bump', () => {
  // If this stops matching, every release silently keeps serving the old shell.
  assert.match(sw, /const VERSION = 'mbrd-v\d+';/,
    "save.bat rewrites this exact line - see its sw.js replace");
});

test('a complete install fills the cache and takes over', async () => {
  const { store, self, fire } = runWorker();
  await fire('install');
  assert.equal(store.get(CURRENT).size, shellUrls.length);
  assert.equal(self.skipped, true, 'a good install should skipWaiting');
});

test('one failed shell entry fails the whole install', async () => {
  const { store, self, fire } = runWorker({ fails: ['./assets/app.js'] });
  await assert.rejects(fire('install'));
  assert.equal(store.has(CURRENT), false, 'a partial cache must not be left behind');
  assert.equal(self.skipped, false, 'a failed install must not take over');
});

/**
 * One update, the way a browser runs it: activate only happens if install
 * resolved. Firing both unconditionally would test nothing.
 */
async function update(worker) {
  try { await worker.fire('install'); } catch { return false; }
  await worker.fire('activate');
  return true;
}

test('a failed install leaves the previous shell alone', async () => {
  // Installing per-entry made a bad response *succeed*, letting activate
  // delete the last complete shell and serve the partial one offline.
  // Failing the install stops the sequence at the first step.
  const worker = runWorker({ fails: ['./index.html'], existing: ['mbrd-v1'] });
  assert.equal(await update(worker), false, 'a shell entry that 404s must fail the install');
  assert.ok(worker.store.has('mbrd-v1'), 'the last known-good shell was destroyed');
});

test('a complete update does replace the previous shell', async () => {
  // So the test above cannot be satisfied by a worker that never cleans up.
  const worker = runWorker({ existing: ['mbrd-v1'] });
  assert.equal(await update(worker), true);
  assert.deepEqual([...worker.store.keys()], [CURRENT]);
});

test('activate clears older shells but nothing outside this app', async () => {
  // Cache Storage is origin-wide: deleting by "not the current version"
  // would take any other app on the same host down with it.
  const { store, fire } = runWorker({ existing: ['mbrd-v1', 'mbrd-v2', 'someone-else-v3'] });
  await fire('activate');
  assert.deepEqual([...store.keys()].sort(), ['someone-else-v3']);
});

// ---------------------------------------------------------------------------
// Runtime fetch, scoped to the active cache (AUD-14)
//
// Cache Storage is origin-wide, so a global caches.match() could answer with
// a response another app - or an older shell - left behind. The fake caches
// above throws from its global match(), so a regression fails loudly here.
// ---------------------------------------------------------------------------

test('a runtime hit comes from this version cache, not an unrelated one', async () => {
  const url = 'https://mbrd.example/assets/js/app.js';
  const { fireFetch } = runWorker({
    seed: {
      [CURRENT]: [[url, { ok: true, type: 'basic', body: 'ours' }]],
      'someone-else-v9': [[url, { body: 'theirs' }]],
    },
  });
  const res = await fireFetch({ url });
  assert.equal(res.body, 'ours', 'answered from the wrong cache');
});

test('a runtime miss goes to the network and is cached under this version only', async () => {
  const url = 'https://mbrd.example/assets/js/new.js';
  const { store, fireFetch } = runWorker({
    seed: { 'someone-else-v9': [[url, { body: 'stale' }]] },
  });
  const res = await fireFetch({ url });
  assert.equal(res.body, 'network', 'a miss must not answer from an unrelated cache');
  assert.equal(store.get(CURRENT).get(url).body, 'network', 'the put must land in the version cache');
  assert.equal(store.get('someone-else-v9').get(url).body, 'stale', 'the other cache is left untouched');
});

test('the dev-host test still matches the one in util.js', () => {
  // sw.js cannot import util.ts, so both carry the same regex by hand. If
  // one is edited without the other, a service worker starts caching the dev server.
  const util = read(join(WEB, 'assets', 'js', 'util.ts'));
  const pattern = /\^\(10\\\.\|192\\\.168\\\.\|172\\\.\(1\[6-9\]\|2\\d\|3\[01\]\)\\\.\|169\\\.254\\\.\)/;
  assert.match(sw, pattern, 'sw.js lost its LAN-host test');
  assert.match(util, pattern, 'util.js lost its LAN-host test');
});
