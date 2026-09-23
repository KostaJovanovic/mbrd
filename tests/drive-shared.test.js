// The list behind Shared links (research/old/done-2026-09-15.md, R13):
// what it asks Drive for, and the order it hands back. A share names no
// parent and so lands at the top of My Drive, where the only other thing of
// this app's is the mbrd folder the synced boards live in.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { googleDrive } from '../web/assets/js/storage/cloud/google.ts';

let realFetch;
let realStorage;

beforeEach(() => {
  realFetch = globalThis.fetch;
  realStorage = globalThis.sessionStorage;
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
  googleDrive.signOut();
});

test('shared links are the files at the top of the Drive, not the folders, newest first', async () => {
  let asked = '';
  globalThis.fetch = async url => {
    asked = new URL(url).searchParams.get('q');
    return new Response(JSON.stringify({ files: [
      { id: 'old', name: 'Old.mbrd', modifiedTime: '2026-01-02T10:00:00.000Z' },
      { id: 'new', name: 'New.mbrd', modifiedTime: '2026-09-01T10:00:00.000Z' },
    ] }), { status: 200 });
  };

  const files = await googleDrive.store.shared();
  assert.match(asked, /'root' in parents/);
  assert.match(asked, /trashed = false/);
  assert.match(asked, /mimeType != 'application\/vnd\.google-apps\.folder'/);
  assert.deepEqual(files.map(f => f.id), ['new', 'old']);
});

test('a folder listing follows every page, so board.json past the first is found', async () => {
  // One page is 1000 files. A board folder holds one file per asset, and a
  // push that missed board.json on page two made a second one.
  const tokens = [];
  globalThis.fetch = async url => {
    const params = new URL(url).searchParams;
    assert.match(params.get('fields'), /nextPageToken/);
    const token = params.get('pageToken');
    tokens.push(token);
    const body = token === 'p2'
      ? { files: [{ id: 'b', name: 'board.json', modifiedTime: '2026-09-01T10:00:00.000Z' }] }
      : { files: [{ id: 'a', name: 'x.png', modifiedTime: '2026-09-01T10:00:00.000Z' }], nextPageToken: 'p2' };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const files = await googleDrive.store.list('folder');
  assert.deepEqual(tokens, [null, 'p2']);
  assert.deepEqual(files.map(f => f.id), ['a', 'b']);
});

test('stopping a share moves the file to the trash rather than deleting it', async () => {
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url, method: init.method, body: JSON.parse(init.body) };
    return new Response('{}', { status: 200 });
  };
  await googleDrive.store.trash('abc');
  assert.equal(sent.method, 'PATCH');
  assert.match(sent.url, /\/drive\/v3\/files\/abc$/);
  assert.deepEqual(sent.body, { trashed: true });
});
