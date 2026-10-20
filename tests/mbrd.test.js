// The .mbrd container: what goes in, what comes out. Exercised end to end
// (pack, then unpack) rather than against private helpers, since the
// interesting rules are about the seam between the two - a note preferring
// its Markdown sidecar over board.json, a shared waveform, a board with
// missing bytes refusing to pack.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boardAssetHashes, packBoard, packBoardFile, unpackBoard, MIME } from '../web/assets/js/storage/mbrd.ts';
import { putAsset, clearAssets } from '../web/assets/js/storage/assets.ts';
import { readZip, writeZip } from '../web/assets/js/storage/zip.ts';
import { item, hash, realHash } from './helpers.js';

const enc = new TextEncoder();

/** A board in the shape serializeBoard() produces. */
const boardOf = (items, extra = {}) => ({
  title: 'Test board',
  view: { pan: { x: 0, y: 0 }, zoom: 1 },
  settings: {},
  arrangement: 'spiral',
  items,
  trash: [],
  ...extra,
});

/**
 * Register bytes the way an import would, handing back the filed id.
 * Really hashed, not labelled: unpack verifies an entry's data matches its
 * name, so a mismatched stub would be rejected as corrupt rather than
 * exercising anything.
 */
async function stubAsset(label, { ext = 'png', mime = 'image/png', body = 'bytes' } = {}) {
  const data = enc.encode(body);
  const id = await realHash(data);
  putAsset(id, new Blob([data], { type: mime }), { ext, mime, name: `${label}.${ext}` });
  return id;
}

const withAsset = (hash, props = {}) => item({ asset: { hash, embedded: true }, ...props });

// ---------------------------------------------------------------------------
// Refusing to write an incomplete archive
// ---------------------------------------------------------------------------

test('packing fails when a referenced asset has no bytes', async () => {
  clearAssets();
  const board = boardOf([withAsset(hash('deadbeef'), { id: 'i1', name: 'holiday.jpg' })]);
  await assert.rejects(() => packBoard(board), /holiday\.jpg/);
});

test('the failure names the items rather than the hashes', async () => {
  clearAssets();
  const board = boardOf([
    withAsset(hash('h1'), { id: 'i1', name: 'one.png' }),
    withAsset(hash('h2'), { id: 'i2', name: 'two.png' }),
  ]);
  await assert.rejects(() => packBoard(board), err => {
    assert.match(err.message, /one\.png/);
    assert.match(err.message, /two\.png/);
    assert.match(err.message, /unchanged/, 'must say the board was left alone');
    return true;
  });
});

test('a missing asset in the bin also fails the export', async () => {
  // Binned items are packed too - their bytes are what make the bin worth
  // anything after a save - so a missing one must be caught the same way.
  clearAssets();
  const board = boardOf([], { trash: [{ at: 1, item: withAsset(hash('gone'), { id: 'i9', name: 'binned.png' }) }] });
  await assert.rejects(() => packBoard(board), /binned\.png/);
});

test('an item with no asset at all is fine', async () => {
  clearAssets();
  const board = boardOf([item({ id: 'i1', type: 'note', meta: { text: 'just words' } })]);
  const { blob } = await packBoard(board);
  assert.ok(blob.size > 0);
});

// ---------------------------------------------------------------------------
// What the archive contains
// ---------------------------------------------------------------------------

test('the archive holds a manifest, a board, and the referenced bytes', async () => {
  clearAssets();
  const id = await stubAsset('abc');
  const board = boardOf([withAsset(id, { id: 'i1', name: 'a.png' })]);
  const { blob, manifest } = await packBoard(board);
  const files = await readZip(blob);

  assert.ok(files.has('manifest.json'));
  assert.ok(files.has('board.json'));
  // Named for the card, then the digest: the slug makes an unzipped board
  // readable, the hash makes it verifiable.
  assert.ok(files.has(`assets/a--${id}.png`));
  assert.equal(manifest.format, 'mbrd');
  assert.equal(manifest.title, 'Test board');
});

test('the same asset used twice is stored once', async () => {
  clearAssets();
  const id = await stubAsset('shared');
  const board = boardOf([
    withAsset(id, { id: 'i1', name: 'a.png' }),
    withAsset(id, { id: 'i2', name: 'b.png' }),
  ]);
  const files = await readZip((await packBoard(board)).blob);
  const assetFiles = [...files.keys()].filter(n => n.startsWith('assets/'));
  // One entry, named after the first card to reference it - otherwise which
  // name won would come down to iteration order.
  assert.deepEqual(assetFiles, [`assets/a--${id}.png`]);
});

// ---------------------------------------------------------------------------
// The second reader of the reference union
//
// boardAssetHashes() answers "what does this board point at" for the cloud
// sync; packBoard() answers the same question for itself in a loop that also
// captures labels. Deliberately separate implementations (see the
// function's own header), so this test stops them drifting - a reference
// class added to one and not the other silently drops a whole asset
// category from sync, as happened when stored versions arrived in v0.197.
// ---------------------------------------------------------------------------

/** The digest out of an `assets/<slug>--<hash>.<ext>` entry, either spelling. */
const hashFromEntry = (name) => {
  const base = name.slice('assets/'.length).replace(/\.[a-z0-9]{1,12}$/i, '');
  const dashes = base.lastIndexOf('--');
  return dashes < 0 ? base : base.slice(dashes + 2);
};

test('boardAssetHashes names exactly what the packer writes', async () => {
  clearAssets();
  // One of every class the packer walks: a live item, its cover, a binned
  // item, a face, a picture named only by a history step. Missing any one
  // would let that class drift unnoticed.
  const live = await stubAsset('live');
  const cover = await stubAsset('cover', { body: 'cover-bytes' });
  const display = await stubAsset('display', { body: 'display-bytes' });
  // The .heic or the camera RAW a card's picture was decoded from, kept beside
  // it until Optimize drops it. A whole class of its own since the decoders
  // arrived, and one a board carries for as long as the original is worth
  // having - so a sync that skipped it would lose the only copy.
  const source = await stubAsset('source', { ext: 'heic', mime: 'image/heic', body: 'heic-bytes' });
  const binned = await stubAsset('binned', { body: 'binned-bytes' });
  const face = await stubAsset('face', { ext: 'woff2', mime: 'font/woff2', body: 'face-bytes' });
  const stepped = await stubAsset('stepped', { body: 'stepped-bytes' });
  // The board's own wallpaper picture (ui/wallpaper.ts): on no item, like a face.
  const wall = await stubAsset('wall', { body: 'wall-bytes' });
  const insideWall = await stubAsset('inside-wall', { body: 'inside-wall-bytes' });
  // A folder card out of an archive points into it; one off the disk lists its files.
  const zipped = await stubAsset('zipped', { ext: 'zip', mime: 'application/zip', body: 'zip-bytes' });
  const filed = await stubAsset('filed', { body: 'filed-bytes' });
  const folders = [
    item({ id: 'f1', type: 'folder', name: 'photos', meta: { archive: zipped, archiveName: 'set.zip', path: 'photos/', count: 1 } }),
    item({ id: 'f2', type: 'folder', name: 'raw', meta: { files: [{ path: 'a.png', hash: filed, size: 11 }], count: 1 } }),
  ];

  // And a board inside the board, with a picture on it and one in its bin -
  // the class the cloud sync would otherwise skip whole.
  const inside = await stubAsset('inside', { body: 'inside-bytes' });
  const insideBinned = await stubAsset('inside-binned', { body: 'inside-binned-bytes' });
  const child = boardOf([withAsset(inside, { id: 'c1', name: 'c.png' })], {
    trash: [{ at: 1, item: withAsset(insideBinned, { id: 'c9', name: 'd.png' }) }],
    wallpaper: { asset: insideWall },
  });

  const board = boardOf([withAsset(live, { id: 'i1', name: 'a.png', meta: { cover, display, source } }), ...folders], {
    boards: { kid: child },
    trash: [{ at: 1, item: withAsset(binned, { id: 'i9', name: 'b.png' }) }],
    settings: { fonts: [{ hash: face, family: 'Test Face' }] },
    wallpaper: { asset: wall, tone: true },
    timeline: {
      steps: [{
        delta: {
          items: {
            changed: {
              i5: [JSON.stringify(withAsset(stepped, { id: 'i5', name: 'gone.png' })), null],
            },
          },
        },
      }],
    },
  });

  const written = new Set(
    [...(await readZip((await packBoard(board)).blob)).keys()]
      .filter(n => n.startsWith('assets/'))
      .map(hashFromEntry),
  );

  assert.deepEqual(
    [...boardAssetHashes(board)].sort(),
    [...written].sort(),
    'the sync would upload a different set of assets than the packer writes',
  );
  // The guard on the guard: two empty sets are deepEqual, so a stubAsset()
  // that stopped registering anything would pass while proving nothing.
  assert.equal(written.size, 13);
});

// ---------------------------------------------------------------------------
// Boards inside the board: boards/<id>/, gated by requires
// ---------------------------------------------------------------------------

/** The smallest bytes thumbType() takes for a WebP, as a data URL. */
const WEBP = 'data:image/webp;base64,' + Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 tiny').toString('base64');

test('a board inside the board is written to its own directory, and says so', async () => {
  clearAssets();
  const shared = await stubAsset('shared', { body: 'shared-bytes' });
  const child = boardOf([
    withAsset(shared, { id: 'c1', name: 'tile.png' }),
    item({ id: 'c2', type: 'note', meta: { text: 'Grout\nwarm grey' } }),
  ], { title: 'Tiles', thumb: WEBP, timeline: { marker: 1, steps: [{ label: 'Add' }] } });
  const top = boardOf([
    withAsset(shared, { id: 'i1', name: 'kitchen.png' }),
    item({ id: 'b1', type: 'board', name: 'Tiles', meta: { board: 'tiles1' } }),
  ], { boards: { tiles1: child } });

  const { blob, manifest } = await packBoard(top);
  assert.deepEqual(manifest.requires, ['boards'], 'an older build must refuse rather than drop it');
  const files = await readZip(blob);
  assert.ok(files.has('boards/tiles1/board.json'));
  assert.ok(files.has('boards/tiles1/thumbnail.webp'));
  assert.ok(files.has('boards/tiles1/timeline/base.json'));
  assert.ok([...files.keys()].some(n => /^boards\/tiles1\/notes\/grout--c2\.md$/.test(n)));
  // One picture on two levels is stored once, in the one assets/.
  assert.equal([...files.keys()].filter(n => n.startsWith('assets/')).length, 1);
  const topJson = JSON.parse(new TextDecoder().decode(files.get('board.json')));
  assert.equal('boards' in topJson, false, 'board.json itself never carries the tree');
  const childJson = JSON.parse(new TextDecoder().decode(files.get('boards/tiles1/board.json')));
  assert.equal('thumb' in childJson, false);
  assert.equal('timeline' in childJson, false);

  const { board } = await unpackBoard(blob);
  const back = board.boards.tiles1;
  assert.equal(back.title, 'Tiles');
  assert.deepEqual(back.items.map(i => i.id), ['c1', 'c2']);
  // Read back from its own notes/ - the marker is the sidecar's, as on the top board.
  assert.equal(back.items[1].meta.text, '# Grout\nwarm grey');
  assert.equal(back.thumb, WEBP);
  assert.equal(back.timeline.steps.length, 1);
});

test('a child whose id cannot be a directory is not written', async () => {
  clearAssets();
  const top = boardOf([], { boards: { '../out': boardOf([]), ok: boardOf([]) } });
  const files = await readZip((await packBoard(top)).blob);
  const dirs = [...files.keys()].filter(n => n.startsWith('boards/'));
  assert.deepEqual(dirs, ['boards/ok/board.json']);
});

test('a board with no child says it needs nothing, and opens anywhere', async () => {
  clearAssets();
  const { manifest } = await packBoard(boardOf([], { boards: {} }));
  assert.deepEqual(manifest.requires, []);
});

test('a child that will not read is left out and the rest open', async () => {
  const blob = await writeZip([
    { name: 'manifest.json', data: enc.encode('{"format":"mbrd","version":1,"requires":["boards"]}'), compress: false },
    { name: 'board.json', data: enc.encode('{"items":[],"boards":{"sneaky":{"items":[]}}}'), compress: false },
    { name: 'boards/good/board.json', data: enc.encode('{"title":"Good","items":[]}'), compress: false },
    { name: 'boards/torn/board.json', data: enc.encode('{"title":'), compress: false },
    { name: 'boards/flat/board.json', data: enc.encode('{"title":"No items"}'), compress: false },
  ]);
  const { board } = await unpackBoard(blob);
  assert.deepEqual(Object.keys(board.boards), ['good'],
    'only a real child, and never one board.json claimed for itself');
});

// ---------------------------------------------------------------------------
// Asset names: a slug for the person, a digest for the reader
// ---------------------------------------------------------------------------

/** The one entry under assets/, for the many tests that write exactly one. */
const soleAsset = async board =>
  [...(await readZip((await packBoard(board)).blob)).keys()]
    .find(n => n.startsWith('assets/'));

test('the extension is not slugged into the name', async () => {
  // item.name is seeded from the filename including extension, so without
  // this it would read `kitchen-window-jpg--<hash>.jpg`.
  clearAssets();
  const id = await stubAsset('kitchen-window', { ext: 'jpg', mime: 'image/jpeg' });
  const name = await soleAsset(boardOf([withAsset(id, { id: 'i1', name: 'kitchen-window.jpg' })]));
  assert.equal(name, `assets/kitchen-window--${id}.jpg`);
});

test('a dot that is not the extension is kept', async () => {
  // Matched against the asset's own ext, not a pattern for what an
  // extension looks like, so a version number survives filing.
  clearAssets();
  const id = await stubAsset('doc', { ext: 'png', mime: 'image/png' });
  const name = await soleAsset(boardOf([withAsset(id, { id: 'i1', name: 'Notes v1.2' })]));
  assert.equal(name, `assets/notes-v1-2--${id}.png`);
});

test('the card name wins over the stored filename', async () => {
  // A deliberate rename is the better name to file the work under.
  clearAssets();
  const id = await stubAsset('IMG_4821', { ext: 'jpg', mime: 'image/jpeg' });
  const name = await soleAsset(boardOf([withAsset(id, { id: 'i1', name: 'the kitchen window' })]));
  assert.equal(name, `assets/the-kitchen-window--${id}.jpg`);
});

test('bytes no item names fall back to the stored filename', async () => {
  // A cover is the ordinary case: nothing on the board is named by it.
  clearAssets();
  const cover = await stubAsset('album-art', { ext: 'jpg', mime: 'image/jpeg' });
  const files = await readZip((await packBoard(
    boardOf([item({ id: 'i1', type: 'note', meta: { text: 'x', cover } })]),
  )).blob);
  assert.ok(files.has(`assets/album-art--${cover}.jpg`));
});

test('a name with nothing spellable in it writes the bare hash', async () => {
  clearAssets();
  const id = await stubAsset('', { ext: 'png', mime: 'image/png' });
  const name = await soleAsset(boardOf([withAsset(id, { id: 'i1', name: '???' })]));
  assert.equal(name, `assets/${id}.png`, 'no slug, no separator');
});

test('a hostile name cannot become a path', async () => {
  // The slugifier is an allow-list, so this is safe by construction rather
  // than by having thought of `../`.
  clearAssets();
  const id = await stubAsset('x', { ext: 'png', mime: 'image/png' });
  const name = await soleAsset(boardOf([
    withAsset(id, { id: 'i1', name: '../../etc/passwd' }),
  ]));
  assert.equal(name, `assets/etc-passwd--${id}.png`);
  assert.ok(!name.includes('..'), 'nothing that could climb a directory');
});

test('a slugged archive round-trips', async () => {
  clearAssets();
  const id = await stubAsset('holiday', { ext: 'jpg', mime: 'image/jpeg' });
  const { blob } = await packBoard(boardOf([withAsset(id, { id: 'i1', name: 'holiday.jpg' })]));
  clearAssets();
  const { board } = await unpackBoard(blob);
  assert.equal(board.items[0].asset.hash, id, 'the hash survives the decoration');
});

test('a board opened from its file and saved again points at its pictures', async () => {
  // Unpacking drops the slug, so a card with no name of its own comes back
  // with nothing to be filed under and would be saved as a bare hash. The
  // append matched by name, took that for a new picture and wrote it again:
  // a 388 MB board opened on a phone grew to 653 MB on its first save.
  clearAssets();
  const id = await stubAsset('holiday', { ext: 'jpg', mime: 'image/jpeg', body: 'x'.repeat(20000) });
  const first = await packBoardFile(boardOf([withAsset(id, { id: 'i1' })]));
  assert.ok((await readZip(first.blob)).has(`assets/holiday--${id}.jpg`));

  clearAssets();
  const { board } = await unpackBoard(first.blob);
  const again = await packBoardFile(board, { prior: first.layout });
  assert.equal(again.appended, true);
  assert.ok(again.blob.size < 5000, `the picture was written again: the tail is ${again.blob.size} bytes`);
  const files = await readZip(new Blob([first.blob, again.blob]));
  assert.deepEqual([...files.keys()].filter(n => n.startsWith('assets/')), [`assets/holiday--${id}.jpg`]);
});

test('a bare-hash archive still reads', async () => {
  // What another implementation writes: a slug is a courtesy, not a
  // requirement everybody must reproduce.
  clearAssets();
  const data = enc.encode('bytes');
  const id = await realHash(data);
  const archive = await writeZip([
    { name: 'manifest.json', data: enc.encode('{"format":"mbrd","version":1}') },
    { name: 'board.json', data: enc.encode(JSON.stringify({ items: [] })) },
    { name: `assets/${id}.png`, data },
  ]);
  const { board } = await unpackBoard(archive);
  assert.deepEqual(board.items, []);
});

test('one digest under two slugs is still stored twice', async () => {
  // The dedup refusal keys off the hash, so decorating the name must not
  // smuggle the same content id in twice.
  clearAssets();
  const data = enc.encode('bytes');
  const id = await realHash(data);
  const archive = await writeZip([
    { name: 'manifest.json', data: enc.encode('{"format":"mbrd","version":1}') },
    { name: 'board.json', data: enc.encode(JSON.stringify({ items: [] })) },
    { name: `assets/one--${id}.png`, data },
    { name: `assets/two--${id}.png`, data },
  ]);
  await assert.rejects(() => unpackBoard(archive), /stored twice/);
});

// ---------------------------------------------------------------------------
// What the archive looks like to something that is not this app
//
// readZip() is deliberately not used below: it hands back decompressed
// bytes in a Map, throwing away exactly the two facts under test here -
// entry order and whether each was deflated. So these walk the local file
// headers the way any other ZIP reader does.
// ---------------------------------------------------------------------------

/** Every local file header, in the order the archive actually carries them. */
function localEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let p = 0;
  while (p + 30 <= bytes.length && view.getUint32(p, true) === 0x04034b50) {
    const nameLen = view.getUint16(p + 26, true);
    const extraLen = view.getUint16(p + 28, true);
    const at = p + 30 + nameLen + extraLen;
    const csize = view.getUint32(p + 18, true);
    out.push({
      name: new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLen)),
      method: view.getUint16(p + 8, true),
      extraLen, at, csize,
    });
    p = at + csize;
  }
  return out;
}

const packedBytes = async board => new Uint8Array(await (await packBoard(board)).blob.arrayBuffer());

test('the media type sits where file(1) looks for it', async () => {
  clearAssets();
  const bytes = await packedBytes(boardOf([]));
  // No parsing at all, which is the point: a local header is 30 bytes, so
  // the first entry's name starts at 30 and content at 38 - the rule
  // libmagic already carries for EPUB and ODF.
  const dec = new TextDecoder();
  assert.equal(dec.decode(bytes.subarray(30, 38)), 'mimetype');
  assert.equal(dec.decode(bytes.subarray(38, 38 + MIME.length)), MIME);
});

test('the mimetype entry is first, stored, and carries no extra field', async () => {
  clearAssets();
  const [first] = localEntries(await packedBytes(boardOf([])));
  assert.equal(first.name, 'mimetype');
  assert.equal(first.method, 0, 'deflating it would move the media type off its offset');
  assert.equal(first.extraLen, 0, 'an extra field would move it too');
  assert.equal(first.at, 38, 'the offset the rule above depends on');
});

test('a board with no mimetype entry still opens', async () => {
  // Every file written before the entry existed looks like this - the
  // reader must not grow a requirement the format can't make retroactively.
  clearAssets();
  const { blob } = await packBoard(boardOf([item({ id: 'i1', name: 'kept' })]));
  const files = await readZip(blob);
  const rest = [...files].filter(([name]) => name !== 'mimetype')
    .map(([name, data]) => ({ name, data, compress: name.endsWith('.json') }));
  const { board } = await unpackBoard(await writeZip(rest, { mime: MIME }));
  assert.equal(board.items[0].name, 'kept');
});

// ---------------------------------------------------------------------------
// The timeline in its own files (R21)
// ---------------------------------------------------------------------------

const ledger = () => ({
  base: { items: {}, itemOrder: [], desktop: {}, mobile: {}, trash: {}, trashOrder: [], rest: {} },
  at: 2,
  fingerprint: 'abc123',
  steps: [
    { id: 's1', at: 1, label: 'Add', run: 'items:i1|', delta: { items: { changed: { i1: [null, '{"id":"i1"}'] } } } },
    { id: 's2', at: 2, label: 'Move', run: 'items:i1|x', delta: { items: { changed: { i1: ['{"id":"i1"}', '{"id":"i1","x":5}'] } } }, name: 'Moved' },
  ],
});

test('the history is written beside board.json, a step to a line', async () => {
  clearAssets();
  const files = await readZip((await packBoard(boardOf([], { timeline: ledger() }))).blob);
  const doc = JSON.parse(new TextDecoder().decode(files.get('board.json')));
  assert.equal('timeline' in doc, false, 'board.json no longer carries the history');
  const head = JSON.parse(new TextDecoder().decode(files.get('timeline/base.json')));
  assert.deepEqual(head, { base: ledger().base, at: 2, fingerprint: 'abc123', count: 2 });
  const lines = new TextDecoder().decode(files.get('timeline/steps-0.jsonl')).trim().split('\n');
  assert.deepEqual(lines.map(line => JSON.parse(line)), ledger().steps);
});

/** A ledger `n` steps long, with `first` steps already folded away. */
function longLedger(n, first = 0) {
  const out = {
    ...ledger(),
    at: n,
    steps: Array.from({ length: n }, (_, i) => ({
      id: `s${first + i}`, at: first + i, label: 'Move', run: 'desktop:i1|x',
      delta: { desktop: { changed: { i1: ['{"x":0}', `{"x":${first + i}}`] } } },
    })),
  };
  if (first) out.first = first;
  return out;
}

/** The history's pieces in a packed board: name -> text. */
async function piecesOf(timeline) {
  const files = await readZip((await packBoard(boardOf([], { timeline }))).blob);
  return new Map([...files].filter(([name]) => /^timeline\/steps-/.test(name))
    .map(([name, data]) => [name, new TextDecoder().decode(data)]));
}

test('a long history is kept in pieces of 500, numbered over its whole life', async () => {
  // Numbered by where a step stands among every step the ledger ever had, so
  // folding the oldest away leaves the later pieces where they are.
  clearAssets();
  const pieces = await piecesOf(longLedger(1200, 300));
  assert.deepEqual([...pieces.keys()], ['timeline/steps-0.jsonl', 'timeline/steps-1.jsonl', 'timeline/steps-2.jsonl']);
  assert.deepEqual([...pieces.values()].map(text => text.trim().split('\n').length), [200, 500, 500]);
  assert.deepEqual((await roundTrip(boardOf([], { timeline: longLedger(1200, 300) }))).timeline, longLedger(1200, 300));
});

test('a new step rewrites the last piece and a fold the first, and nothing else', async () => {
  // What the pieces are for: a save appends only the entries that changed, and
  // the whole history in one file changed on every save.
  clearAssets();
  const before = await piecesOf(longLedger(1500));
  const grown = await piecesOf(longLedger(1501));
  const changed = (a, b) => [...b.keys()].filter(name => a.get(name) !== b.get(name));
  assert.deepEqual(changed(before, grown), ['timeline/steps-3.jsonl']);
  const trimmed = longLedger(1500);
  const folded = { ...trimmed, first: 1, steps: trimmed.steps.slice(1), at: 1499 };
  assert.deepEqual(changed(before, await piecesOf(folded)), ['timeline/steps-0.jsonl']);
});

test('a history in the one file older saves wrote still opens', async () => {
  clearAssets();
  const { steps, ...head } = ledger();
  const old = await writeZip([
    { name: 'board.json', data: enc.encode(JSON.stringify(boardOf([]))) },
    { name: 'timeline/base.json', data: enc.encode(JSON.stringify({ ...head, count: steps.length })) },
    { name: 'timeline/steps.jsonl', data: enc.encode(steps.map(s => JSON.stringify(s) + '\n').join('')) },
  ], { mime: MIME });
  assert.deepEqual((await unpackBoard(old)).board.timeline, ledger());
});

test('the history comes back whole from its own files', async () => {
  const back = await roundTrip(boardOf([], { timeline: ledger() }));
  assert.deepEqual(back.timeline, ledger());
});

test('a file with the history inside board.json still opens with it', async () => {
  // Every .mbrd written before the history had its own files looks like this.
  clearAssets();
  const doc = JSON.stringify(boardOf([], { timeline: ledger() }));
  const old = await writeZip([{ name: 'board.json', data: new TextEncoder().encode(doc), compress: true }], { mime: MIME });
  assert.deepEqual((await unpackBoard(old)).board.timeline, ledger());
});

test('a history with a torn line or a lost tail reads as shorter than it says', async () => {
  // adoptTimeline() marks a ledger with an unreadable entry stale rather than
  // replaying steps that are not all there. The null is that entry.
  clearAssets();
  const files = await readZip((await packBoard(boardOf([], { timeline: ledger() }))).blob);
  const redo = async body => {
    const entries = [...files].map(([name, data]) => ({
      name, data: name === 'timeline/steps-0.jsonl' ? new TextEncoder().encode(body) : data, compress: false,
    }));
    return (await unpackBoard(await writeZip(entries, { mime: MIME }))).board.timeline.steps;
  };
  const [first, second] = new TextDecoder().decode(files.get('timeline/steps-0.jsonl')).trim().split('\n');
  assert.deepEqual(await redo(`${first}\n{torn\n`), [ledger().steps[0], null]);
  assert.deepEqual(await redo(`${first}\n`), [ledger().steps[0], null], 'two claimed, one there');
  assert.equal((await redo(`${first}\n${second}\n`)).length, 2);
});

test('a WOFF2 face is stored rather than deflated', async () => {
  clearAssets();
  // Bytes that would compress enormously, so this can't pass by accident on
  // writeZip's "only keep the deflate when it wins" guard - what's tested
  // is the decision not to attempt it, since WOFF2 carries its own Brotli.
  const id = await stubAsset('face', { ext: 'woff2', mime: 'font/woff2', body: 'A'.repeat(4000) });
  const entries = localEntries(await packedBytes(
    boardOf([], { settings: { fonts: [{ hash: id, family: 'Face' }] } }),
  ));
  const face = entries.find(e => e.name === `assets/face--${id}.woff2`);
  assert.ok(face, 'the face is in the archive');
  assert.equal(face.method, 0);
});

test('a TTF face is still deflated', async () => {
  // TTF tables are uncompressed, and this is the largest single win the
  // packer gets on a board carrying a face.
  clearAssets();
  const id = await stubAsset('face', { ext: 'ttf', mime: 'font/ttf', body: 'A'.repeat(4000) });
  const entries = localEntries(await packedBytes(
    boardOf([], { settings: { fonts: [{ hash: id, family: 'Face' }] } }),
  ));
  const face = entries.find(e => e.name === `assets/face--${id}.ttf`);
  assert.ok(face, 'the face is in the archive');
  assert.equal(face.method, 8);
});

test('created is carried across saves, modified is not', async () => {
  clearAssets();
  const board = boardOf([]);
  const first = await packBoard(board);
  const second = await packBoard(board, { created: first.manifest.created });
  assert.equal(second.manifest.created, first.manifest.created);
});

// ---------------------------------------------------------------------------
// Notes as Markdown
// ---------------------------------------------------------------------------

const noteBoard = text => boardOf([item({ id: 'i1', type: 'note', meta: { text } })]);

async function roundTrip(board) {
  const { blob } = await packBoard(board);
  clearAssets();
  return (await unpackBoard(blob)).board;
}

// The heading marker below is the change. parseNote() used to strip it, so
// the sidecar never equalled flattenNoteRich()'s output and every note's
// blocks got rebuilt from plaintext on export/re-import. These fixtures
// pass meta.text unmarked (a legacy note's shape); an unmarked first line
// is h1 too, so nothing on screen moves and the two halves now agree.

test('a note round-trips through its own .md file', async () => {
  clearAssets();
  const back = await roundTrip(noteBoard('Shopping\nbread\nmilk'));
  assert.equal(back.items[0].meta.text, '# Shopping\nbread\nmilk');
});

test('the blank line under the title is structure, not content', async () => {
  // The writer always adds a blank line under a heading (what Markdown
  // wants) and the reader always removes it - the one deliberate asymmetry
  // in this round trip.
  clearAssets();
  const back = await roundTrip(noteBoard('Shopping\n\nbread'));
  assert.equal(back.items[0].meta.text, '# Shopping\nbread');
});

test('blank lines inside the body are kept', async () => {
  clearAssets();
  const back = await roundTrip(noteBoard('Shopping\nbread\n\nmilk'));
  assert.equal(back.items[0].meta.text, '# Shopping\nbread\n\nmilk');
});

test('a title-only note round-trips', async () => {
  clearAssets();
  const back = await roundTrip(noteBoard('just a title'));
  assert.equal(back.items[0].meta.text, '# just a title');
});

test('a note that already carries its marker is not given a second one', async () => {
  clearAssets();
  const back = await roundTrip(noteBoard('# Shopping\nbread'));
  assert.equal(back.items[0].meta.text, '# Shopping\nbread');
  const twice = await roundTrip(noteBoard('## Shopping\nbread'));
  assert.equal(twice.items[0].meta.text, '## Shopping\nbread', 'and h2 stays h2');
});

test('an untouched rich note keeps its alignment and its markers', async () => {
  // The user-visible defect: export a board of marked-up notes, reopen it,
  // and every highlighter mark is gone and every centred line left-aligned
  // - no edit involved, the file just went out and came back.
  clearAssets();
  const rich = {
    font: 'serif', size: 1.4, valign: 'middle',
    blocks: [
      { tag: 'h1', align: 'center', text: 'original', wash: 'amber' },
      { tag: 'p', align: 'right', text: 'body', wash: 'olive' },
    ],
  };
  const back = await roundTrip(boardOf([item({
    id: 'i1', type: 'note', meta: { text: '# original\nbody', rich },
  })]));

  const meta = back.items[0].meta;
  assert.equal(meta.text, '# original\nbody', 'the sidecar and the model agree');
  assert.deepEqual(meta.rich.blocks.map(b => b.wash), ['amber', 'olive'],
    'the highlighter marks survived');
  assert.deepEqual(meta.rich.blocks.map(b => b.align), ['center', 'right'],
    'and so did the alignment');
  assert.deepEqual(meta.rich.blocks.map(b => b.tag), ['h1', 'p']);
  assert.equal(meta.rich.font, 'serif');
  assert.equal(meta.rich.size, 1.4);
  assert.equal(meta.rich.valign, 'middle');
});

test('the note file is named after what it says', async () => {
  clearAssets();
  const files = await readZip((await packBoard(noteBoard('Buy the good coffee'))).blob);
  const note = [...files.keys()].find(n => n.startsWith('notes/'));
  assert.match(note, /^notes\/buy-the-good-coffee--i1\.md$/);
});

test('a hand-edited note file wins over board.json', async () => {
  // The whole promise of the format: unzip, edit a note in any editor, zip
  // back, and the board shows what you typed.
  clearAssets();
  const { blob } = await packBoard(noteBoard('original'));
  const files = await readZip(blob);
  const noteName = [...files.keys()].find(n => n.startsWith('notes/'));

  const { writeZip } = await import('../web/assets/js/storage/zip.ts');
  const edited = await writeZip([...files].map(([name, data]) => ({
    name,
    data: name === noteName ? enc.encode('# edited by hand\n\nwith a body\n') : data,
    compress: true,
  })));

  const back = (await unpackBoard(edited)).board;
  assert.equal(back.items[0].meta.text, '# edited by hand\nwith a body');
});

test('a hand-edited note file wins over meta.rich as well', async () => {
  // meta.rich is part of board.json, and normalizeNoteRich() prefers it
  // whenever well-formed - so a hand edit to the .md sidecar took meta.text
  // while the card kept showing meta.rich, until the next keystroke
  // flattened the stale rich back over the edit. The notes above carry no
  // meta.rich, which is why none of them caught it.
  clearAssets();
  const rich = {
    font: 'serif', size: 1.4, valign: 'middle',
    blocks: [
      { tag: 'h1', align: 'center', text: 'original' },
      { tag: 'p', align: 'left', text: 'body' },
    ],
  };
  const board = boardOf([item({
    id: 'i1', type: 'note', meta: { text: '# original\nbody', rich },
  })]);
  const { blob } = await packBoard(board);
  const files = await readZip(blob);
  const noteName = [...files.keys()].find(n => n.startsWith('notes/'));

  const { writeZip } = await import('../web/assets/js/storage/zip.ts');
  const edited = await writeZip([...files].map(([name, data]) => ({
    name,
    data: name === noteName ? enc.encode('# edited by hand\n\nwith a body\n') : data,
    compress: true,
  })));

  const back = (await unpackBoard(edited)).board;
  const meta = back.items[0].meta;
  assert.equal(meta.text, '# edited by hand\nwith a body');
  assert.deepEqual(meta.rich.blocks.map(b => b.text), ['edited by hand', 'with a body'],
    'the blocks are re-derived from the sidecar');
  // Words, not looks: the .md can't carry a face or size, so the note keeps
  // what it had rather than resetting to defaults.
  assert.equal(meta.rich.font, 'serif');
  assert.equal(meta.rich.size, 1.4);
  assert.equal(meta.rich.valign, 'middle');
});

test('a note whose first line is already a heading is not marked twice', async () => {
  // meta.text has been Markdown-flavoured since meta.rich arrived, so an
  // unconditional '# ' would land on top of the block's own marker.
  clearAssets();
  const board = boardOf([item({
    id: 'i1', type: 'note',
    meta: {
      text: '# buy the smaller one',
      rich: { blocks: [{ tag: 'h1', align: 'left', text: 'buy the smaller one' }] },
    },
  })]);
  const files = await readZip((await packBoard(board)).blob);
  const noteName = [...files.keys()].find(n => n.startsWith('notes/'));
  const md = new TextDecoder().decode(files.get(noteName));
  assert.equal(md.split('\n')[0], '# buy the smaller one');
});

// ---------------------------------------------------------------------------
// Waveform sidecars
// ---------------------------------------------------------------------------

const peaks = n => Array.from({ length: n }, (_, i) => Math.round((i / n) * 1000) / 1000);

const song = () => stubAsset('song', { ext: 'mp3', mime: 'audio/mpeg' });
const audioCard = (id, hash, meta) => withAsset(hash, { id, type: 'audio', name: 's.mp3', meta });

test('a waveform is written per audio hash and read back', async () => {
  clearAssets();
  const id = await song();
  const board = boardOf([audioCard('i1', id, { peaks: peaks(256) })]);
  const { blob } = await packBoard(board);

  const files = await readZip(blob);
  assert.ok(files.has(`waveforms/${id}.json`), 'sidecar not written');

  clearAssets();
  const back = (await unpackBoard(blob)).board;
  assert.equal(back.items[0].meta.peaks.length, 256);
});

test('the readings leave board.json when they get a file of their own', async () => {
  // Storing twice would be two places to disagree, so the packer strips
  // them from the board on the way out.
  clearAssets();
  const id = await song();
  const board = boardOf([audioCard('i1', id, { peaks: peaks(256) })]);
  const files = await readZip((await packBoard(board)).blob);
  const json = JSON.parse(new TextDecoder().decode(files.get('board.json')));
  assert.equal(json.items[0].meta.peaks, undefined);
});

test('packing does not mutate the live item', async () => {
  clearAssets();
  const live = audioCard('i1', await song(), { peaks: peaks(256) });
  await packBoard(boardOf([live]));
  assert.equal(live.meta.peaks.length, 256, 'packing stripped the readings off the board in memory');
});

test('two cards on one recording both get the readings back', async () => {
  clearAssets();
  const id = await song();
  const board = boardOf([
    audioCard('i1', id, { peaks: peaks(256) }),
    audioCard('i2', id, {}),
  ]);
  const { blob } = await packBoard(board);
  clearAssets();
  const back = (await unpackBoard(blob)).board;
  assert.equal(back.items[1].meta.peaks.length, 256);
});

test('an unreadable waveform file is ignored, not fatal', async () => {
  clearAssets();
  const id = await song();
  const board = boardOf([audioCard('i1', id, { peaks: peaks(256) })]);
  const files = await readZip((await packBoard(board)).blob);

  const { writeZip } = await import('../web/assets/js/storage/zip.ts');
  const broken = await writeZip([...files].map(([name, data]) => ({
    name,
    data: name === `waveforms/${id}.json` ? enc.encode('{"res": 256, "peaks": [1, 2,') : data,
    compress: true,
  })));

  clearAssets();
  const back = (await unpackBoard(broken)).board;   // must not throw
  assert.ok(back.items[0], 'the board still opened');
});

// ---------------------------------------------------------------------------
// Rejecting what is not ours
// ---------------------------------------------------------------------------

test('a ZIP with no board.json is refused', async () => {
  const { writeZip } = await import('../web/assets/js/storage/zip.ts');
  const notABoard = await writeZip([{ name: 'hello.txt', data: enc.encode('hi'), compress: false }]);
  await assert.rejects(() => unpackBoard(notABoard), /board\.json/);
});

// A board.json that parses and is not a board. `JSON.parse` used to be the
// whole check, so a string spread into loadBoard() as indexed keys, and the
// open board was silently replaced by a blank one. `null` threw a bare
// TypeError several frames from the cause. Every malformed file now earns
// a sentence.
for (const [what, text] of [
  ['a string', '"hello"'],
  ['a list', '[1, 2, 3]'],
  ['null', 'null'],
  ['a number', '42'],
]) {
  test(`a board.json holding ${what} is refused with something to read`, async () => {
    const { writeZip } = await import('../web/assets/js/storage/zip.ts');
    const blob = await writeZip([
      { name: 'board.json', data: enc.encode(text), compress: false },
    ], { mime: MIME });
    await assert.rejects(() => unpackBoard(blob), err => {
      assert.match(err.message, /not a board/);
      return true;
    });
  });
}

test('a board.json that is not JSON at all is refused the same way', async () => {
  const { writeZip } = await import('../web/assets/js/storage/zip.ts');
  const blob = await writeZip([
    { name: 'board.json', data: enc.encode('{"items": [1,'), compress: false },
  ], { mime: MIME });
  await assert.rejects(() => unpackBoard(blob), err => {
    assert.match(err.message, /not readable/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Asset paths and content ids
//
// The archive chooses these names, and this app treats them as identities
// and writes them back out as paths. Both halves must be checked, or a
// .mbrd can name a file outside its own directory, or hand any bytes to any id.
// ---------------------------------------------------------------------------

/** A .mbrd built by hand, so the entry names can be anything. */
async function archiveOf(entries) {
  const { writeZip } = await import('../web/assets/js/storage/zip.ts');
  return writeZip(entries.map(e => ({ compress: false, ...e })));
}

const boardJSON = items =>
  enc.encode(JSON.stringify({ title: 'crafted', items, trash: [] }));

test('an asset path that climbs out of assets/ is refused', async () => {
  // Would otherwise be packed back out as `assets/../escape.bin`.
  const crafted = await archiveOf([
    { name: 'board.json', data: boardJSON([{ id: 'i1', asset: { hash: '../escape', embedded: true } }]) },
    { name: 'assets/../escape.bin', data: enc.encode('payload') },
  ]);
  await assert.rejects(() => unpackBoard(crafted), /not a valid asset path/);
});

test('an asset id that is not a digest is refused', async () => {
  const crafted = await archiveOf([
    { name: 'board.json', data: boardJSON([]) },
    { name: 'assets/shortname.png', data: enc.encode('payload') },
  ]);
  await assert.rejects(() => unpackBoard(crafted), /not a valid asset path/);
});

test('bytes that do not match the id they are filed under are refused', async () => {
  // Dedup, waveform sidecars and the autosave sweep all assume a hash names
  // its own bytes - checked here rather than assumed.
  const wrong = await realHash(enc.encode('something else'));
  const crafted = await archiveOf([
    { name: 'board.json', data: boardJSON([]) },
    { name: `assets/${wrong}.png`, data: enc.encode('payload') },
  ]);
  await assert.rejects(() => unpackBoard(crafted), /does not contain the data its name claims/);
});

test('the same content stored twice under two extensions is refused', async () => {
  const data = enc.encode('payload');
  const id = await realHash(data);
  const crafted = await archiveOf([
    { name: 'board.json', data: boardJSON([]) },
    { name: `assets/${id}.png`, data },
    { name: `assets/${id}.jpg`, data },
  ]);
  await assert.rejects(() => unpackBoard(crafted), /stored twice/);
});

test('a note whose id could not be a filename still keeps its text', async () => {
  // No sidecar for it since the id can't be spelled into a path, but
  // board.json carries the text either way.
  clearAssets();
  const board = boardOf([item({ id: '../../etc/passwd', type: 'note', meta: { text: 'hello' } })]);
  const { blob } = await packBoard(board);
  const files = await readZip(blob);
  assert.equal([...files.keys()].filter(n => n.startsWith('notes/')).length, 0);
  const back = (await unpackBoard(blob)).board;
  assert.equal(back.items[0].meta.text, 'hello');
});

test('a board written by another format is refused', async () => {
  const { writeZip } = await import('../web/assets/js/storage/zip.ts');
  const foreign = await writeZip([
    { name: 'manifest.json', data: enc.encode('{"format":"sketch","version":1}'), compress: false },
    { name: 'board.json', data: enc.encode('{"items":[]}'), compress: false },
  ]);
  await assert.rejects(() => unpackBoard(foreign), /sketch/);
});

test('a board requiring a feature this build lacks is refused, not flattened', async () => {
  // The one rule in the format that fails rather than degrades - opening
  // and re-saving would otherwise drop the field it can't see, reporting
  // success the whole way.
  const newer = await writeZip([
    {
      name: 'manifest.json',
      data: enc.encode('{"format":"mbrd","version":1,"requires":["sculpture"]}'),
      compress: false,
    },
    { name: 'board.json', data: enc.encode('{"items":[]}'), compress: false },
  ]);
  await assert.rejects(() => unpackBoard(newer), err => {
    assert.match(err.message, /sculpture/, 'must name what is missing');
    assert.match(err.message, /Nothing was opened/, 'must say the file was left alone');
    return true;
  });
});

test('a requires list this build satisfies opens normally', async () => {
  // Empty is the intended state and must be a no-op: every board this app
  // writes carries `"requires": []`.
  clearAssets();
  const { blob, manifest } = await packBoard(boardOf([item({ id: 'i1', name: 'here' })]));
  assert.deepEqual(manifest.requires, [], 'written, and written empty');
  const { board } = await unpackBoard(blob);
  assert.equal(board.items[0].name, 'here');
});

test('a non-string in the requires list gates nothing', async () => {
  // A number names no feature, so it can withhold none - refusing here
  // would make a hand-mangled manifest unopenable for no gain.
  const odd = await writeZip([
    {
      name: 'manifest.json',
      data: enc.encode('{"format":"mbrd","version":1,"requires":[7,null]}'),
      compress: false,
    },
    { name: 'board.json', data: enc.encode('{"items":[]}'), compress: false },
  ]);
  const { board } = await unpackBoard(odd);
  assert.deepEqual(board.items, []);
});

// ---------------------------------------------------------------------------
// A file from v0.197, which carried stored versions
// ---------------------------------------------------------------------------
//
// For one release a board held a ring of whole copies of itself, in a
// `versions` key and a `versions/<id>.json` directory. Both are gone (see
// board-model.ts), but a file from that release must still open - past the
// key, past the directory - with the board intact minus its snapshots.

test('a board written with stored versions still opens', async () => {
  clearAssets();
  const live = await stubAsset('live');
  const board = boardOf([withAsset(live, { id: 'i1', name: 'live.png' })], {
    versions: [{ id: 'v1', at: 1000, label: 'earlier', kept: true,
                 data: { items: [{ id: 'i0', type: 'image' }], trash: [] } }],
  });
  const { blob } = await packBoard(board);
  const back = await unpackBoard(blob);
  assert.equal(back.board.items.length, 1);
  assert.equal(back.board.items[0].name, 'live.png');
});

test('a versions/ entry in an archive is walked past, not read as an asset', async () => {
  // Worse than dropping the snapshots: failing the read outright, or
  // mistaking a versions/ entry for something the reader trusts.
  clearAssets();
  const live = await stubAsset('live');
  const { blob } = await packBoard(
    boardOf([withAsset(live, { id: 'i1', name: 'live.png' })]));
  const files = await readZip(blob);
  const entries = [...files.entries()]
    .filter(([name]) => name !== 'mimetype')
    .map(([name, data]) => ({ name, data, compress: false }));
  entries.push({
    name: 'versions/v1.json',
    data: enc.encode('{"items":[{"id":"i0","type":"image"}],"trash":[]}'),
    compress: false,
  });
  const back = await unpackBoard(await writeZip(entries, { mime: MIME }));
  assert.equal(back.board.items.length, 1);
  assert.equal(back.board.versions, undefined,
    'the key is not reconstructed out of the directory either');
});
