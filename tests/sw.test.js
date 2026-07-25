// The service worker's precache list must match what is actually on disk.
//
// SHELL is hand-maintained, and it had already rotted: it listed 2 of the 7
// bundled .woff2 files, and the 5 it omitted included Geist - which tokens.css
// sets as --font-body in every look, and as --font-display *and* Geist Mono as
// --font-mono at the plain end of the whimsy axis. So an offline launch, the
// one thing the service worker exists for, rendered the entire interface in
// fallback faces. Nothing failed loudly; you only see it if you specifically
// go offline and look.
//
// A list a person has to remember to update is a list that will drift again,
// so this asserts it instead of trusting it. Both directions matter: an
// omission is a shell that boots wrong, and a stale entry is a cache.add()
// that 404s on install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

import { WEB, read, walk } from './helpers.js';

const sw = read(join(WEB, 'sw.js'));

/**
 * The SHELL array's entries. Read out of the source rather than by importing
 * sw.js, which is a service-worker script and references `self` at module
 * scope - there is nothing to gain from standing up a fake worker global just
 * to read a list of strings.
 */
const shellUrls = (() => {
  const block = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(block, 'could not find the SHELL array in sw.js');
  return [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
})();

/** ...minus the bare navigation entry, which is not a file on disk. */
const shell = shellUrls.filter(p => p !== './');

test('SHELL lists every asset that ships', () => {
  const onDisk = [
    ...walk(join(WEB, 'assets', 'js'), ['.js']),
    ...walk(join(WEB, 'assets', 'css'), ['.css']),
    ...walk(join(WEB, 'assets', 'fonts'), ['.woff2']),
  ];
  const listed = new Set(shell.map(p => p.replace(/^\.\//, '')));
  const missing = onDisk.filter(f => !listed.has(f));
  assert.deepEqual(missing, [], `not precached, so unavailable offline:\n  ${missing.join('\n  ')}`);
});

test('SHELL has no entries pointing at files that are gone', () => {
  const stale = shell.filter(p => !existsSync(join(WEB, p.replace(/^\.\//, ''))));
  assert.deepEqual(stale, [], `listed in SHELL but not on disk:\n  ${stale.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// Install and activate, actually run
//
// The list checks above prove that the paths in SHELL exist in the repository.
// They say nothing about what happens when one of them fails to *fetch* - which
// is the case that matters, because activate deletes every older cache. A
// worker that installs with a half-filled cache does not merely fail to
// improve the offline shell; it destroys the last complete one and puts an
// incomplete one in its place, at the moment the network is already unreliable.
//
// So the two handlers are run here against a fake Cache Storage. It is a small
// amount of scaffolding for a behaviour that has no other way of being seen.
// ---------------------------------------------------------------------------

/**
 * Load sw.js into a sandbox and hand back its registered handlers, along with
 * the fake cache storage it wrote to.
 *
 * `fails` names the URLs whose fetch should reject, standing in for one bad
 * response during an update.
 */
function runWorker({ fails = [], existing = [] } = {}) {
  const store = new Map(existing.map(name => [name, new Map([['seed', 'seed']])]));
  const caches = {
    open: async name => {
      if (!store.has(name)) store.set(name, new Map());
      const entries = store.get(name);
      return {
        add: async url => {
          if (fails.includes(url)) throw new Error(`404 ${url}`);
          entries.set(url, 'response');
        },
      };
    },
    keys: async () => [...store.keys()],
    delete: async name => store.delete(name),
  };

  const handlers = new Map();
  const self = {
    location: { hostname: 'mbrd.example', origin: 'https://mbrd.example' },
    addEventListener: (type, fn) => handlers.set(type, fn),
    skipWaiting: async () => { self.skipped = true; },
    clients: { claim: async () => {} },
    skipped: false,
  };

  const sandbox = { self, caches, console, URL, fetch: async () => ({}) };
  sandbox.addEventListener = self.addEventListener;
  vm.createContext(sandbox);
  vm.runInContext(sw, sandbox, { filename: 'sw.js' });

  /** Run one handler and await whatever it passed to waitUntil. */
  const fire = async type => {
    let waited = Promise.resolve();
    await handlers.get(type)({ waitUntil: p => { waited = p; } });
    return waited;
  };

  return { store, self, fire };
}

const CURRENT = (() => {
  const m = sw.match(/const VERSION = '([^']+)'/);
  assert.ok(m, 'could not find VERSION in sw.js');
  return m[1];
})();

test('the cache version stays inside this app\'s namespace', () => {
  // activate deletes every cache starting with PREFIX. A VERSION that did not
  // start with it would delete *itself* on the next activation and leave the
  // app with no shell at all - and save.bat rewrites VERSION by regex on every
  // commit, so the two really can part company.
  const prefix = sw.match(/const PREFIX = '([^']+)'/);
  assert.ok(prefix, 'could not find PREFIX in sw.js');
  assert.ok(CURRENT.startsWith(prefix[1]), `${CURRENT} is outside the ${prefix[1]} namespace`);
});

test('save.bat can still find the version line to bump', () => {
  // The cache epoch is what ships fresh code to an already-installed client.
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
  const { store, self, fire } = runWorker({ fails: ['./assets/js/main.js'] });
  await assert.rejects(fire('install'));
  assert.equal(store.has(CURRENT), false, 'a partial cache must not be left behind');
  assert.equal(self.skipped, false, 'a failed install must not take over');
});

/**
 * One update, the way a browser runs it: activate only happens if install
 * resolved. That conditional is the entire safety property, so a test that
 * fires the two handlers unconditionally would be testing nothing.
 */
async function update(worker) {
  try { await worker.fire('install'); } catch { return false; }
  await worker.fire('activate');
  return true;
}

test('a failed install leaves the previous shell alone', async () => {
  // The whole point, and the reason the two halves have to be run together.
  // Installing per-entry made a bad response *succeed*, which let activate run,
  // which deleted the last complete shell and left the partial one serving the
  // app offline. Failing the install stops the sequence at the first step.
  const worker = runWorker({ fails: ['./index.html'], existing: ['mbrd-v1'] });
  assert.equal(await update(worker), false, 'a shell entry that 404s must fail the install');
  assert.ok(worker.store.has('mbrd-v1'), 'the last known-good shell was destroyed');
});

test('a complete update does replace the previous shell', async () => {
  // The other direction, so the test above cannot be satisfied by a worker
  // that simply never cleans up.
  const worker = runWorker({ existing: ['mbrd-v1'] });
  assert.equal(await update(worker), true);
  assert.deepEqual([...worker.store.keys()], [CURRENT]);
});

test('activate clears older shells but nothing outside this app', async () => {
  // Cache Storage is origin-wide. Deleting by "not the current version" took
  // any other app served from the same host down with it.
  const { store, fire } = runWorker({ existing: ['mbrd-v1', 'mbrd-v2', 'someone-else-v3'] });
  await fire('activate');
  assert.deepEqual([...store.keys()].sort(), ['someone-else-v3']);
});

test('the dev-host test still matches the one in util.js', () => {
  // sw.js cannot import util.js, so the two carry the same regex by hand and
  // say so in comments. If one is edited the other has to move with it, and
  // the failure mode otherwise is a service worker that caches the dev server.
  const util = read(join(WEB, 'assets', 'js', 'util.js'));
  const pattern = /\^\(10\\\.\|192\\\.168\\\.\|172\\\.\(1\[6-9\]\|2\\d\|3\[01\]\)\\\.\)/;
  assert.match(sw, pattern, 'sw.js lost its LAN-host test');
  assert.match(util, pattern, 'util.js lost its LAN-host test');
});
