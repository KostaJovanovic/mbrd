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

import { packBoard, unpackBoard } from '../web/assets/js/storage/mbrd.ts';
import { putAsset, clearAssets } from '../web/assets/js/storage/assets.ts';
import { readZip } from '../web/assets/js/storage/zip.ts';
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
  assert.ok(files.has(`assets/${id}.png`));
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
  assert.deepEqual(assetFiles, [`assets/${id}.png`]);
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
