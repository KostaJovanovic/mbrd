// A dropped upload goes on from the last byte that landed
// (research/rapid-fixes-2026-09-14.md, R13). Against a fake of Drive's
// resumable-session protocol on a stubbed fetch: a session URI, 308 with a
// Range header for each chunk, the same 308 for a status query, and the file
// id once the last byte lands. The drop is a fetch that rejects, which is
// what a browser does when the connection goes.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { googleDrive } from '../web/assets/js/storage/cloud/google.ts';

const MB = 1024 * 1024;
const SESSION = 'https://www.googleapis.com/upload/session/1';

let realFetch;
let realStorage;
let realTimeout;

beforeEach(() => {
  realFetch = globalThis.fetch;
  realStorage = globalThis.sessionStorage;
  realTimeout = globalThis.setTimeout;
  // The waits between tries add up to half a minute. The order is what is
  // under test, not the clock.
  globalThis.setTimeout = fn => { queueMicrotask(fn); return 0; };
  // A signed-in tab: the grant the provider recalls from sessionStorage.
  const grant = JSON.stringify({ token: 't', expiresAt: Date.now() + 3600e3 });
  globalThis.sessionStorage = {
    getItem: key => (key === 'mbrd.cloud.gdrive' ? grant : null),
    setItem() {},
    removeItem() {},
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.sessionStorage = realStorage;
  globalThis.setTimeout = realTimeout;
  googleDrive.signOut();
});

/**
 * Drive, as far as an upload sees it. `drops` is the set of chunk PUTs (by
 * count, from 1) that reject without an answer, and `offline` how many status
 * queries after a drop reject too.
 */
function fakeDrive({ drops = [], offline = 0, size }) {
  const got = { bytes: 0, begun: 0, chunks: 0, queries: 0, starts: [], published: 0 };
  let down = 0;
  globalThis.fetch = async (url, init = {}) => {
    const range = init.headers?.['Content-Range'] || '';
    if (/uploadType=resumable/.test(url)) {
      got.begun++;
      return new Response(null, { status: 200, headers: { location: SESSION } });
    }
    if (/\/permissions$/.test(url)) {
      got.published++;
      return new Response('{}', { status: 200 });
    }
    assert.equal(url, SESSION);
    if (range.startsWith('bytes */')) {
      got.queries++;
      if (down > 0) { down--; throw new TypeError('Failed to fetch'); }
      if (got.bytes === size) return new Response(JSON.stringify({ id: 'file1' }), { status: 200 });
      const headers = got.bytes ? { range: `bytes=0-${got.bytes - 1}` } : {};
      return new Response(null, { status: 308, headers });
    }
    const [, from, to] = /bytes (\d+)-(\d+)\//.exec(range).map(Number);
    got.chunks++;
    got.starts.push(from);
    if (drops.includes(got.chunks)) {
      // Half the chunk landed before the line went.
      got.bytes = from + Math.floor((to + 1 - from) / 2);
      down = offline;
      throw new TypeError('Failed to fetch');
    }
    assert.equal(from, got.bytes, 'a chunk starts where the session ends');
    got.bytes = to + 1;
    if (got.bytes === size) return new Response(JSON.stringify({ id: 'file1' }), { status: 200 });
    return new Response(null, { status: 308, headers: { range: `bytes=0-${got.bytes - 1}` } });
  };
  return got;
}

const blobOf = size => new Blob([new Uint8Array(size)]);

test('a dropped chunk goes on from the bytes Drive holds, in the same session', async () => {
  const size = 20 * MB;
  const got = fakeDrive({ drops: [2], size });
  const seen = [];
  const id = await googleDrive.upload(blobOf(size), 'board.mbrd', sent => seen.push(sent));

  assert.equal(id, 'file1');
  assert.equal(got.begun, 1, 'one session, not a second upload from zero');
  assert.equal(got.bytes, size);
  // Chunk 2 dropped half way; the next PUT starts at the half, not at 8 MB.
  assert.equal(got.starts[2], 8 * MB + 4 * MB);
  assert.equal(got.published, 1);
  assert.equal(seen.at(-1), size);
});

test('a status query that finds the line still down waits and asks again', async () => {
  const size = 10 * MB;
  const got = fakeDrive({ drops: [1], offline: 1, size });
  const id = await googleDrive.upload(blobOf(size), 'board.mbrd', () => {});
  assert.equal(id, 'file1');
  assert.equal(got.begun, 1);
  assert.equal(got.queries, 2);
});

test('a second try with the same pack resumes the first one\'s session', async () => {
  // Every chunk after the first drops, and so does every query: the first try
  // gives up. The second finds the session with 4 MB in it and sends the rest.
  const size = 12 * MB;
  const blob = blobOf(size);
  const got = fakeDrive({ drops: [1], offline: 99, size });
  await assert.rejects(googleDrive.upload(blob, 'board.mbrd', () => {}), /did not come back/);
  assert.equal(got.bytes, 4 * MB);

  const again = fakeDrive({ size });
  // The fake starts empty; put back what the first session holds.
  again.bytes = 4 * MB;
  const id = await googleDrive.upload(blob, 'board.mbrd', () => {});
  assert.equal(id, 'file1');
  assert.equal(again.begun, 0, 'no new session');
  assert.deepEqual(again.starts, [4 * MB], 'the rest, in one chunk from where it stopped');
  assert.equal(again.bytes, size);
});

test('an answer that is not a fault ends the upload at once', async () => {
  const size = 1 * MB;
  globalThis.fetch = async url => {
    if (/uploadType=resumable/.test(url)) {
      return new Response(null, { status: 200, headers: { location: SESSION } });
    }
    return new Response(JSON.stringify({ error: { message: 'The user has exceeded their Drive storage quota' } }),
      { status: 403 });
  };
  await assert.rejects(googleDrive.upload(blobOf(size), 'board.mbrd', () => {}), /storage quota/);
});
