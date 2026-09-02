// Keeping a board in the cloud: what gets uploaded, and what does not.
//
// Against a fake store rather than a network, which the plan for this feature
// asked for in as many words - "the provider modules should be pure enough to
// test against a fake, and the upload path should be the only thing that is
// not". The fake below is forty lines and implements the whole CloudStore
// contract, which is itself the argument for the contract being that small.
//
// The two properties worth more than the rest of this file together:
//
//   - **a re-sync uploads board.json and nothing else.** That is the entire
//     reason this feature splits a board into files instead of pushing the
//     .mbrd the share path already builds. If it ever stops being true, syncing
//     a board of video re-uploads hundreds of megabytes every ten minutes and
//     the feature is worse than useless - and nothing about the app would look
//     wrong, which is exactly the kind of regression a test has to hold.
//   - **a remote nobody here wrote is a conflict, not an overwrite.** Item
//     positions are absolute and there is no merge, so the only safe answer to
//     "two machines edited this" is to stop and ask. The dangerous direction is
//     silent success.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  adoptedRow, pullBoard, pushBoard, remoteBoards,
} from '../web/assets/js/storage/cloud/sync.ts';
import { getAsset, putAsset, clearAssets } from '../web/assets/js/storage/assets.ts';
import { item, realHash } from './helpers.js';

const enc = new TextEncoder();

/**
 * A Drive made of Maps.
 *
 * Faithful about the three things the engine actually reasons over: names are
 * unique per folder only by convention, `modifiedTime` moves on every write, and
 * a `put` with a file id replaces rather than adding. It counts writes per name,
 * which is how the "uploaded once, ever" property is asserted.
 */
function fakeStore() {
  let nextId = 1;
  /** id -> { id, name, parent, blob, modifiedTime } */
  const files = new Map();
  const writes = new Map();
  let clock = 0;

  const stamp = () => new Date(1700000000000 + (++clock) * 1000).toISOString();

  const store = {
    async folder(name, parent) {
      for (const f of files.values()) {
        if (f.name === name && f.parent === parent && f.folder) return f.id;
      }
      const id = `f${nextId++}`;
      files.set(id, { id, name, parent, folder: true, modifiedTime: stamp() });
      return id;
    },
    async list(folder) {
      return [...files.values()]
        .filter(f => f.parent === folder)
        .map(({ id, name, modifiedTime }) => ({ id, name, modifiedTime }));
    },
    async put(folder, name, blob, replacing) {
      writes.set(name, (writes.get(name) || 0) + 1);
      if (replacing && files.has(replacing)) {
        const f = files.get(replacing);
        files.set(replacing, { ...f, blob, modifiedTime: stamp() });
        return replacing;
      }
      const id = `x${nextId++}`;
      files.set(id, { id, name, parent: folder, blob, modifiedTime: stamp() });
      return id;
    },
    async fetch(id) {
      const f = files.get(id);
      if (!f) throw new Error('no such file');
      return f.blob;
    },
  };

  return {
    provider: { id: 'gdrive', label: 'Google Drive', store },
    files,
    /** How many times bytes were written under a name. */
    writes: name => writes.get(name) || 0,
    /** Somebody else's machine writing board.json under our feet. */
    touchBoard(folder) {
      for (const f of files.values()) {
        if (f.parent === folder && f.name === 'board.json') {
          files.set(f.id, { ...f, modifiedTime: stamp() });
          return;
        }
      }
      throw new Error('no board.json to touch');
    },
  };
}

async function stubAsset(body, ext = 'png') {
  const data = enc.encode(body);
  const id = await realHash(data);
  putAsset(id, new Blob([data], { type: 'image/png' }), { ext, mime: 'image/png', name: `${body}.${ext}` });
  return id;
}

const boardWith = (hashes, extra = {}) => ({
  title: 'Synced board',
  settings: {},
  items: hashes.map((hash, n) => item({ id: `i${n}`, asset: { hash, embedded: true }, name: `p${n}.png` })),
  trash: [],
  ...extra,
});

// ---------------------------------------------------------------------------
// Pushing
// ---------------------------------------------------------------------------

test('a first push writes every asset and the board', async () => {
  clearAssets();
  const drive = fakeStore();
  const a = await stubAsset('one');
  const b = await stubAsset('two');

  const out = await pushBoard(drive.provider, 'brd1', boardWith([a, b]));
  assert.ok(out.ok);
  assert.equal(out.uploaded, 2);
  assert.equal(drive.writes(`${a}.png`), 1);
  assert.equal(drive.writes(`${b}.png`), 1);
  assert.equal(drive.writes('board.json'), 1);
  // The row the caller has to persist, with the folder it found and the time the
  // store reported *after* the write - never a local clock.
  assert.equal(out.row.provider, 'gdrive');
  assert.ok(out.row.folder);
  assert.ok(out.row.seen);
});

test('a second push re-uploads the board and not one asset', async () => {
  // The property the whole split-by-hash design exists for.
  clearAssets();
  const drive = fakeStore();
  const a = await stubAsset('one');
  const b = await stubAsset('two');

  const first = await pushBoard(drive.provider, 'brd1', boardWith([a, b]));
  assert.ok(first.ok);
  const second = await pushBoard(drive.provider, 'brd1', boardWith([a, b]), { known: first.row });

  assert.ok(second.ok);
  assert.equal(second.uploaded, 0, 'an unchanged asset was uploaded twice');
  assert.equal(drive.writes(`${a}.png`), 1);
  assert.equal(drive.writes(`${b}.png`), 1);
  assert.equal(drive.writes('board.json'), 2, 'the board itself must be rewritten every time');
});

test('a new asset on a synced board is the only thing that goes up', async () => {
  clearAssets();
  const drive = fakeStore();
  const a = await stubAsset('one');
  const first = await pushBoard(drive.provider, 'brd1', boardWith([a]));
  assert.ok(first.ok);

  const b = await stubAsset('two');
  const second = await pushBoard(drive.provider, 'brd1', boardWith([a, b]), { known: first.row });
  assert.ok(second.ok);
  assert.equal(second.uploaded, 1);
  assert.equal(drive.writes(`${a}.png`), 1);
  assert.equal(drive.writes(`${b}.png`), 1);
});

test('board.json is written after the assets, never before', async () => {
  // The only durability guarantee this design has: a push that dies part way
  // leaves the previous board.json in place, so the remote is a complete older
  // board rather than a newer one pointing at bytes that are not there.
  clearAssets();
  const drive = fakeStore();
  const a = await stubAsset('one');
  const order = [];
  const realPut = drive.provider.store.put;
  drive.provider.store.put = async (...args) => { order.push(args[1]); return realPut(...args); };

  await pushBoard(drive.provider, 'brd1', boardWith([a]));
  assert.deepEqual(order, [`${a}.png`, 'board.json']);
});

test('progress counts files, and ends on the total it promised', async () => {
  clearAssets();
  const drive = fakeStore();
  const a = await stubAsset('one');
  const b = await stubAsset('two');
  const steps = [];
  await pushBoard(drive.provider, 'brd1', boardWith([a, b]), {
    onProgress: (done, total) => steps.push([done, total]),
  });
  // Two assets plus the board, and the last call is always done === total, which
  // is what stops a strip sitting at 90% after a job that finished.
  assert.deepEqual(steps.at(-1), [3, 3]);
  assert.ok(steps.every(([done, total]) => done <= total));
});

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

test('a remote written since we last saw it is a conflict, and uploads nothing', async () => {
  clearAssets();
  const drive = fakeStore();
  const a = await stubAsset('one');
  const first = await pushBoard(drive.provider, 'brd1', boardWith([a]));
  assert.ok(first.ok);

  drive.touchBoard(first.row.folder);

  const b = await stubAsset('two');
  const second = await pushBoard(drive.provider, 'brd1', boardWith([a, b]), { known: first.row });
  assert.equal(second.ok, false);
  assert.equal(second.conflict, true);
  assert.ok(second.theirs, 'the caller needs their timestamp to say when');
  // Nothing was written, in either sense: the new asset did not go up and
  // board.json was not replaced.
  assert.equal(drive.writes(`${b}.png`), 0);
  assert.equal(drive.writes('board.json'), 1);
});

test('force overwrites, and re-establishes the baseline', async () => {
  clearAssets();
  const drive = fakeStore();
  const a = await stubAsset('one');
  const first = await pushBoard(drive.provider, 'brd1', boardWith([a]));
  assert.ok(first.ok);
  drive.touchBoard(first.row.folder);

  const forced = await pushBoard(drive.provider, 'brd1', boardWith([a]), {
    known: first.row, force: true,
  });
  assert.ok(forced.ok);
  assert.notEqual(forced.row.seen, first.row.seen, 'the baseline must move on');

  // And the next ordinary push is no longer a conflict, because the baseline is
  // current again. A force that did not update `seen` would conflict forever.
  const after = await pushBoard(drive.provider, 'brd1', boardWith([a]), { known: forced.row });
  assert.ok(after.ok);
});

test('a board already up there that this machine has never pushed is a conflict', async () => {
  // The second machine, opening a board it has a local copy of and has never
  // synced. Overwriting silently is exactly the case the check exists for.
  clearAssets();
  const drive = fakeStore();
  const a = await stubAsset('one');
  await pushBoard(drive.provider, 'brd1', boardWith([a]));

  const fresh = await pushBoard(drive.provider, 'brd1', boardWith([a]), { known: null });
  assert.equal(fresh.ok, false);
  assert.equal(fresh.conflict, true);
});

// ---------------------------------------------------------------------------
// Pulling
// ---------------------------------------------------------------------------

test('a pull brings back the board and registers the bytes it names', async () => {
  clearAssets();
  const drive = fakeStore();
  const a = await stubAsset('one');
  const b = await stubAsset('two');
  const pushed = await pushBoard(drive.provider, 'brd1', boardWith([a, b]));
  assert.ok(pushed.ok);

  // A different machine: same remote, nothing in the asset store.
  clearAssets();
  assert.equal(getAsset(a), undefined);

  const [remote] = await remoteBoards(drive.provider);
  assert.equal(remote.boardId, 'brd1');

  const { board, seen } = await pullBoard(drive.provider, remote);
  assert.equal(board.title, 'Synced board');
  assert.equal(board.items.length, 2);
  assert.ok(seen);
  // The bytes, and the extension that tells a renderer what they are - dropping
  // it is how an imported picture ends up as a blob: URL nothing will draw.
  assert.ok(getAsset(a));
  assert.equal(getAsset(a).ext, 'png');
  assert.equal(getAsset(a).mime, 'image/png');
  assert.equal(await getAsset(a).blob.text(), 'one');
});

test('a pull does not re-download bytes this browser already holds', async () => {
  clearAssets();
  const drive = fakeStore();
  const a = await stubAsset('one');
  const pushed = await pushBoard(drive.provider, 'brd1', boardWith([a]));
  assert.ok(pushed.ok);

  let fetched = 0;
  const realFetch = drive.provider.store.fetch;
  drive.provider.store.fetch = async id => { fetched++; return realFetch(id); };

  const [remote] = await remoteBoards(drive.provider);
  await pullBoard(drive.provider, remote);
  // board.json and nothing else: the asset is already in the store, which is the
  // ordinary case of reopening your own board on the machine that made it.
  assert.equal(fetched, 1);
});

test('a pull takes bytes off the outgoing board instead of fetching them', async () => {
  // The board swap empties the asset store before the pull, so without `reuse`
  // reopening your own synced board re-downloads every photograph on it - not
  // because the browser lacked them, but because nothing could reach them. The
  // stash is handed in by withFreshAssets(); this is the half that uses it.
  clearAssets();
  const drive = fakeStore();
  const a = await stubAsset('one');
  const b = await stubAsset('two');
  const pushed = await pushBoard(drive.provider, 'brd1', boardWith([a, b]));
  assert.ok(pushed.ok);

  // What withFreshAssets() would have set aside, and then the empty store the
  // pull actually runs against.
  const stash = new Map([[a, getAsset(a)], [b, getAsset(b)]]);
  clearAssets();

  let fetched = 0;
  const realFetch = drive.provider.store.fetch;
  drive.provider.store.fetch = async id => { fetched++; return realFetch(id); };

  const [remote] = await remoteBoards(drive.provider);
  await pullBoard(drive.provider, remote, { reuse: stash });

  assert.equal(fetched, 1, 'only board.json should have been fetched');
  // Moved across whole: the bytes, and the extension a renderer needs to know
  // what they are.
  assert.equal(await getAsset(a).blob.text(), 'one');
  assert.equal(getAsset(b).ext, 'png');
});

test('a reused pull still fetches what the stash does not have', async () => {
  // Half and half, which is the ordinary case: a board that shares some
  // photographs with the one being closed and not others.
  clearAssets();
  const drive = fakeStore();
  const a = await stubAsset('one');
  const b = await stubAsset('two');
  const pushed = await pushBoard(drive.provider, 'brd1', boardWith([a, b]));
  assert.ok(pushed.ok);

  const stash = new Map([[a, getAsset(a)]]);
  clearAssets();

  const [remote] = await remoteBoards(drive.provider);
  await pullBoard(drive.provider, remote, { reuse: stash });
  assert.equal(await getAsset(a).blob.text(), 'one', 'the shared one came from the stash');
  assert.equal(await getAsset(b).blob.text(), 'two', 'the other one was fetched');
});

test('a folder with no board in it is not a board', async () => {
  // A push that died before its last step leaves exactly this. It must not show
  // up in the list as a board that then fails to open.
  clearAssets();
  const drive = fakeStore();
  const root = await drive.provider.store.folder('mbrd', null);
  await drive.provider.store.folder('half-written', root);
  assert.deepEqual(await remoteBoards(drive.provider), []);
});

test('a missing asset in the cloud is a hole, not a refusal', async () => {
  // unpackBoard's own bargain: the item keeps its hash, the card comes back if
  // the bytes ever do, and refusing the whole board over one picture helps
  // nobody.
  clearAssets();
  const drive = fakeStore();
  const a = await stubAsset('one');
  const pushed = await pushBoard(drive.provider, 'brd1', boardWith([a]));
  assert.ok(pushed.ok);
  for (const f of drive.files.values()) {
    if (f.name === `${a}.png`) drive.files.delete(f.id);
  }

  clearAssets();
  const [remote] = await remoteBoards(drive.provider);
  const { board } = await pullBoard(drive.provider, remote);
  assert.equal(board.items.length, 1);
  assert.equal(getAsset(a), undefined);
});

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

test('an adopted board is filed against the folder it came out of', async () => {
  const remote = { boardId: 'brd1', folder: 'f9', modifiedTime: 'T' };
  const row = adoptedRow({ id: 'gdrive', label: 'Google Drive' }, remote, 'T');
  assert.equal(row.provider, 'gdrive');
  assert.equal(row.folder, 'f9');
  assert.equal(row.seen, 'T');
  // `file` is null on purpose: a pulled board has never been written from here,
  // so there is no board.json id of ours to replace. The next push finds it in
  // the listing.
  assert.equal(row.file, null);
});

test('a provider that cannot sync says so rather than throwing a TypeError', async () => {
  const shareOnly = { id: 'gdrive', label: 'Google Drive' };
  await assert.rejects(
    () => pushBoard(shareOnly, 'brd1', boardWith([])),
    /Google Drive cannot keep boards in sync/,
  );
});
