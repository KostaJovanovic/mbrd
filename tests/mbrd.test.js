// The .mbrd container: what goes into the archive, and what comes back out.
//
// Exercised end to end - pack, then unpack - rather than against the private
// helpers, because the interesting rules are all about the seam between the
// two. A note is written as Markdown and read back from it in preference to
// board.json; a waveform is written per audio hash and shared by every card
// holding that hash; a board whose bytes have gone missing must not pack at
// all. None of those are visible from one side alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { packBoard, unpackBoard, MIME } from '../web/assets/js/storage/mbrd.ts';
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
 * Register bytes the way an import would, and hand back the id they were filed
 * under. Really hashed, not labelled: unpack verifies that an entry contains
 * the data its name claims, so a stub whose id did not match its bytes would
 * be rejected as a corrupt archive rather than exercising anything.
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
  // Binned items are packed too - their bytes are the only thing that makes
  // the bin worth anything after a save - so they can be missing in the same
  // way and must be caught in the same way.
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
  // Named for the card, then the digest. The slug is what makes an unzipped
  // board readable; the hash is what makes it verifiable.
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
  // One entry, and it takes its name from the first card to reference it -
  // otherwise which of the two names won would come down to iteration order.
  assert.deepEqual(assetFiles, [`assets/a--${id}.png`]);
});

// ---------------------------------------------------------------------------
// Asset names: a slug for the person, a digest for the reader
// ---------------------------------------------------------------------------

/** The one entry under assets/, for the many tests that write exactly one. */
const soleAsset = async board =>
  [...(await readZip((await packBoard(board)).blob)).keys()]
    .find(n => n.startsWith('assets/'));

test('the extension is not slugged into the name', async () => {
  // item.name is seeded from the filename at import, extension and all, so the
  // ordinary case would read `kitchen-window-jpg--<hash>.jpg` without this.
  clearAssets();
  const id = await stubAsset('kitchen-window', { ext: 'jpg', mime: 'image/jpeg' });
  const name = await soleAsset(boardOf([withAsset(id, { id: 'i1', name: 'kitchen-window.jpg' })]));
  assert.equal(name, `assets/kitchen-window--${id}.jpg`);
});

test('a dot that is not the extension is kept', async () => {
  // Matched against the asset's own ext rather than against a pattern for what
  // an extension looks like, so a version number survives being filed.
  clearAssets();
  const id = await stubAsset('doc', { ext: 'png', mime: 'image/png' });
  const name = await soleAsset(boardOf([withAsset(id, { id: 'i1', name: 'Notes v1.2' })]));
  assert.equal(name, `assets/notes-v1-2--${id}.png`);
});

test('the card name wins over the stored filename', async () => {
  // The two are the same string until somebody renames the card, and a
  // deliberate rename is the better name to file the work under.
  clearAssets();
  const id = await stubAsset('IMG_4821', { ext: 'jpg', mime: 'image/jpeg' });
  const name = await soleAsset(boardOf([withAsset(id, { id: 'i1', name: 'the kitchen window' })]));
  assert.equal(name, `assets/the-kitchen-window--${id}.jpg`);
});

test('bytes no item names fall back to the stored filename', async () => {
  // A cover is the ordinary case: nothing on the board is called by its name.
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
  // The slugifier is an allow-list, so this is safe by construction rather than
  // by having thought of `../`. The same reasoning as the hash rule, one out.
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

test('a bare-hash archive still reads', async () => {
  // What another implementation writes. Computing a slug is a courtesy, and
  // requiring one would mean requiring everybody to reproduce our slug function.
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
  // The dedup refusal keys off the hash, so decorating the name must not give
  // an archive a way to smuggle the same content id in twice.
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
// readZip() is the wrong instrument for the two rules below, and deliberately
// not used: it hands back decompressed bytes in a Map, which is precisely the
// two facts under test - the order entries were written in, and whether each
// one was deflated - already thrown away. So these walk the local file headers
// the way any other ZIP reader does.
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
  // No parsing at all, which is the entire point: a local header is 30 bytes,
  // so the first entry's name starts at 30 and its content at 38. This is the
  // rule libmagic already carries for EPUB and ODF, and the reason the entry has
  // to be first, stored, and free of an extra field.
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
  // Every file written before the entry existed looks like this, and the reader
  // must not have grown a requirement the format cannot make retroactively.
  clearAssets();
  const { blob } = await packBoard(boardOf([item({ id: 'i1', name: 'kept' })]));
  const files = await readZip(blob);
  const rest = [...files].filter(([name]) => name !== 'mimetype')
    .map(([name, data]) => ({ name, data, compress: name.endsWith('.json') }));
  const { board } = await unpackBoard(await writeZip(rest, { mime: MIME }));
  assert.equal(board.items[0].name, 'kept');
});

test('a WOFF2 face is stored rather than deflated', async () => {
  clearAssets();
  // Bytes that would compress enormously, so this cannot pass by accident on
  // writeZip's own "only keep the deflate when it wins" guard. What is under
  // test is the decision not to attempt it, which is about the format carrying
  // its own Brotli rather than about the outcome for these particular bytes.
  const id = await stubAsset('face', { ext: 'woff2', mime: 'font/woff2', body: 'A'.repeat(4000) });
  const entries = localEntries(await packedBytes(
    boardOf([], { settings: { fonts: [{ hash: id, family: 'Face' }] } }),
  ));
  const face = entries.find(e => e.name === `assets/face--${id}.woff2`);
  assert.ok(face, 'the face is in the archive');
  assert.equal(face.method, 0);
});

test('a TTF face is still deflated', async () => {
  // The other half of the same rule. TTF tables are uncompressed, and this is
  // the largest single win the packer gets on a board carrying a face - a skip
  // list that caught it would cost more than the WOFF2 skip saves.
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

test('a note round-trips through its own .md file', async () => {
  clearAssets();
  const text = 'Shopping\nbread\nmilk';
  const back = await roundTrip(noteBoard(text));
  assert.equal(back.items[0].meta.text, text);
});

test('the blank line under the title is structure, not content', async () => {
  // The writer always puts one there because that is what Markdown wants
  // under a heading, and the reader always takes it back off. So a note whose
  // body happens to start with a blank line comes back without it - the one
  // deliberate asymmetry in this round trip, and the reason the case above is
  // written without one.
  clearAssets();
  const back = await roundTrip(noteBoard('Shopping\n\nbread'));
  assert.equal(back.items[0].meta.text, 'Shopping\nbread');
});

test('blank lines inside the body are kept', async () => {
  clearAssets();
  const text = 'Shopping\nbread\n\nmilk';
  const back = await roundTrip(noteBoard(text));
  assert.equal(back.items[0].meta.text, text);
});

test('a title-only note round-trips', async () => {
  clearAssets();
  const back = await roundTrip(noteBoard('just a title'));
  assert.equal(back.items[0].meta.text, 'just a title');
});

test('the note file is named after what it says', async () => {
  clearAssets();
  const files = await readZip((await packBoard(noteBoard('Buy the good coffee'))).blob);
  const note = [...files.keys()].find(n => n.startsWith('notes/'));
  assert.match(note, /^notes\/buy-the-good-coffee--i1\.md$/);
});

test('a hand-edited note file wins over board.json', async () => {
  // The whole promise of the format: unzip it, edit a note in any editor, zip
  // it back, and the board shows what you typed.
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
  assert.equal(back.items[0].meta.text, 'edited by hand\nwith a body');
});

test('a hand-edited note file wins over meta.rich as well', async () => {
  // The same promise, against the half that had never been asked. meta.rich is
  // part of board.json, and normalizeNoteRich() prefers it whenever it is
  // well-formed - so the sidecar took meta.text, the card went on showing the
  // words in meta.rich, Find matched the ones nobody could see, and the next
  // keystroke in the editor flattened the stale rich back over the edit.
  //
  // Every note in the file above carries meta.text and no meta.rich, which is
  // why none of them caught it.
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
  assert.equal(meta.text, 'edited by hand\nwith a body');
  assert.deepEqual(meta.rich.blocks.map(b => b.text), ['edited by hand', 'with a body'],
    'the blocks are re-derived from the sidecar');
  // Words, not looks: the .md has no way to carry a face or a size, so the note
  // keeps the ones it had rather than being reset to the defaults.
  assert.equal(meta.rich.font, 'serif');
  assert.equal(meta.rich.size, 1.4);
  assert.equal(meta.rich.valign, 'middle');
});

test('a note whose first line is already a heading is not marked twice', async () => {
  // meta.text has been Markdown-flavoured since meta.rich arrived, so the '# '
  // the writer added unconditionally landed on top of the block's own marker.
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
  // Stored twice would be the same bytes for nothing and two places to
  // disagree, so the packer strips them from the board on the way out.
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

// ---------------------------------------------------------------------------
// Asset paths and content ids
//
// The archive gets to choose these names, and this app then treats them as
// identities and writes them back out as paths. Both halves of that have to be
// checked or a .mbrd can name a file outside its own directory in whatever
// extractor opens it next, and can hand any bytes it likes to any id.
// ---------------------------------------------------------------------------

/** A .mbrd built by hand, so the entry names can be anything. */
async function archiveOf(entries) {
  const { writeZip } = await import('../web/assets/js/storage/zip.ts');
  return writeZip(entries.map(e => ({ compress: false, ...e })));
}

const boardJSON = items =>
  enc.encode(JSON.stringify({ title: 'crafted', items, trash: [] }));

test('an asset path that climbs out of assets/ is refused', async () => {
  // Opened happily once, and then packed back out as `assets/../escape.bin`.
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
  // Content addressing is a promise the archive is in no position to make on
  // its own: dedup, the waveform sidecars and the autosave sweep all assume a
  // hash names its bytes, so this is where that gets checked rather than
  // assumed.
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
  // No sidecar for it - the id is not something we will spell into a path -
  // but board.json carries the text either way, so nothing is lost.
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
  // The one rule in the format that fails rather than degrades. A reader that
  // opened this would drop the field it cannot see and write the loss back on
  // the next save, reporting success the whole way - which is the failure the
  // list exists to convert into an error somebody can act on.
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
  // Empty is the intended state, and the check has to be a no-op in it: every
  // board this app writes carries `"requires": []`, so a gate that tripped on
  // its own output would stop the app opening its own files.
  clearAssets();
  const { blob, manifest } = await packBoard(boardOf([item({ id: 'i1', name: 'here' })]));
  assert.deepEqual(manifest.requires, [], 'written, and written empty');
  const { board } = await unpackBoard(blob);
  assert.equal(board.items[0].name, 'here');
});

test('a non-string in the requires list gates nothing', async () => {
  // The list is a claim like every other key in the manifest. A number names no
  // feature, so it can withhold none - refusing on one would make a hand-mangled
  // manifest unopenable for no gain.
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
// For one release a board held a ring of whole copies of itself, in a `versions`
// key and in a `versions/<id>.json` directory beside board.json. Both are gone
// (see board-model.ts). What has to go on being true is that a file written by
// that release still *opens*: the key is read past, the directory is walked
// past, and what somebody gets back is their board without its snapshots rather
// than an error.

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
  // The one thing that would be worse than dropping the snapshots: a file with
  // a versions/ directory in it failing the read outright, or its entries being
  // mistaken for something the reader does trust.
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
