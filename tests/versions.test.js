// The version history: what this board looked like before.
//
// Three things are worth asserting here and one of them is worth the whole
// file.
//
// The small two are the ring (automatic versions evict, named ones do not) and
// the restore (one undoable command, and the list survives it).
//
// The one that matters is **the reference union**. An asset a stored version
// points at is live, even when no card on the board wants it - and the packer
// writes only what something references while the autosave sweep deletes
// whatever nothing claims. Get that wrong and nothing loses a version: it
// leaves the version standing with holes where its photographs were, having
// reported every save as a success. That is the failure this feature can
// actually cause, so it is the one with the most tests under it.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  addItems, board, byId, loadBoard, removeItems, serializeBoard, setBoardMode,
  saveVersion, restoreVersion, forgetVersion, boardVersions, versionHashes,
  undo, redo, setTitle,
} from '../web/assets/js/state.ts';
import { VERSION_RING } from '../web/assets/js/board-model.ts';
import { fresh, note, photo } from './state-fixtures.js';

const HASH = c => c.repeat(64);

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

// ---------------------------------------------------------------------------
// Taking one
// ---------------------------------------------------------------------------

test('a version is a copy of the board, and does not change it', () => {
  addItems([photo(), note()]);
  const before = JSON.stringify(serializeBoard().items);
  const v = saveVersion();
  assert.ok(v);
  assert.equal(boardVersions().length, 1);
  assert.equal(JSON.stringify(serializeBoard().items), before, 'the board is untouched');
});

test('a version of a board with versions does not nest', () => {
  // Otherwise the second carries a copy of the first, the third a copy of both,
  // and a board left open grows its own history exponentially inside itself.
  addItems([photo()]);
  saveVersion('one');
  addItems([note()]);
  const second = saveVersion('two');
  assert.deepEqual(second.data.versions, [], 'the copy carries no history of its own');
});

test('an automatic version is not taken twice for an unchanged board', () => {
  addItems([photo()]);
  assert.ok(saveVersion());
  assert.equal(saveVersion(), null, 'nothing changed, so nothing was stored');
  addItems([note()]);
  assert.ok(saveVersion(), 'and something did change');
});

test('a named version is always taken, even unchanged', () => {
  // The de-duplication above is about a ring filling with copies of one state.
  // Naming one is somebody saying "this exact board, now", and refusing it
  // because an automatic copy happens to match would be the app arguing.
  addItems([photo()]);
  saveVersion();
  assert.ok(saveVersion('the one I showed them'));
  assert.equal(boardVersions().length, 2);
});

// ---------------------------------------------------------------------------
// The ring, and what is exempt from it
// ---------------------------------------------------------------------------

test('automatic versions evict and named ones do not', () => {
  addItems([photo()]);
  saveVersion('keep me');
  for (let i = 0; i < VERSION_RING + 5; i++) {
    // A distinct board each time, or the de-duplication above refuses them.
    setTitle(`board ${i}`);
    saveVersion('', 1000 + i);
  }
  const all = boardVersions();
  assert.equal(all.filter(v => !v.kept).length, VERSION_RING, 'the ring is capped');
  assert.equal(all.filter(v => v.kept).length, 1, 'the named one survived all of it');
  assert.equal(all.find(v => v.kept).label, 'keep me');
});

test('the list is newest first', () => {
  addItems([photo()]);
  setTitle('a'); saveVersion('', 1000);
  setTitle('b'); saveVersion('', 3000);
  setTitle('c'); saveVersion('', 2000);
  assert.deepEqual(boardVersions().map(v => v.at), [3000, 2000, 1000]);
});

// ---------------------------------------------------------------------------
// The reference union - the one with teeth
// ---------------------------------------------------------------------------

test('an asset only a version points at is still referenced', () => {
  const [p] = addItems([photo({ asset: { hash: HASH('a') } })]);
  saveVersion('with the photo');
  removeItems([p.id]);
  // Out of the bin as well, so the live board and the bin both disclaim it and
  // the version is the only thing left holding on.
  board.trash = [];
  const hashes = versionHashes(board.versions);
  assert.ok(hashes.has(HASH('a')),
    'the version still names it, so it is live - the packer and the autosave '
    + 'sweep both ask this, and a false answer here deletes somebody\'s picture');
});

test('every id an item can carry counts inside a version too', () => {
  addItems([photo({
    asset: { hash: HASH('a') },
    meta: { cover: HASH('b'), thumb: HASH('c'), preview: HASH('d') },
  })]);
  saveVersion();
  const hashes = versionHashes(board.versions);
  for (const c of ['a', 'b', 'c', 'd']) {
    assert.ok(hashes.has(HASH(c)), `${c} is an id an item owns and must count`);
  }
});

test('a version carries its own bin', () => {
  // A version restored has to bring its own bin back with it, so the bin inside
  // a stored document is referenced exactly like its items are.
  const [p] = addItems([photo({ asset: { hash: HASH('a') } })]);
  removeItems([p.id]);
  saveVersion('with something in the bin');
  assert.ok(versionHashes(board.versions).has(HASH('a')));
});

test('rubbish in a version does not throw the reference walk', () => {
  // It reads documents that may have been hand-edited, so it is total like the
  // rest of the reader - a version it cannot understand contributes nothing
  // rather than failing the save that asked.
  assert.deepEqual([...versionHashes([{ id: 'x', at: 0, label: '', kept: false, data: null }])], []);
  assert.deepEqual([...versionHashes([{ id: 'x', at: 0, label: '', kept: false, data: 7 }])], []);
  assert.deepEqual([...versionHashes([
    { id: 'x', at: 0, label: '', kept: false, data: { items: 'not a list' } },
  ])], []);
});

// ---------------------------------------------------------------------------
// Going back
// ---------------------------------------------------------------------------

test('restoring puts the board back, and undo takes it forward again', () => {
  const [a] = addItems([photo()]);
  saveVersion('one photo');
  const [b] = addItems([note()]);
  assert.equal(board.items.length, 2);

  assert.equal(restoreVersion(boardVersions()[0].id), true);
  assert.equal(board.items.length, 1, 'back to one');
  assert.ok(byId(a.id));
  assert.equal(byId(b.id), undefined);

  undo();
  assert.equal(board.items.length, 2, 'and the restore itself is undoable');
  assert.ok(byId(b.id));
  redo();
  assert.equal(board.items.length, 1);
});

test('restoring does not empty the list it was restored from', () => {
  // loadBoard() replaces every field of the board from the document it is
  // given, and a version's document has no versions in it - so without the
  // carry-across in restoreVersion() this would wipe the history on first use.
  addItems([photo()]);
  saveVersion('one');
  addItems([note()]);
  saveVersion('two');
  restoreVersion(boardVersions()[1].id);
  assert.equal(boardVersions().length, 2, 'both versions are still there');
  undo();
  assert.equal(boardVersions().length, 2, 'and after undoing the restore');
});

test('restoring something that is gone answers false', () => {
  assert.equal(restoreVersion('nothing'), false);
});

test('a version can be forgotten', () => {
  addItems([photo()]);
  const v = saveVersion('bye');
  assert.equal(forgetVersion(v.id), true);
  assert.equal(boardVersions().length, 0);
  assert.equal(forgetVersion(v.id), false, 'and forgetting it twice is not an error');
});

// ---------------------------------------------------------------------------
// Through a file
// ---------------------------------------------------------------------------

test('versions round-trip through a file', () => {
  addItems([photo()]);
  saveVersion('kept', 5000);
  const written = JSON.parse(JSON.stringify(serializeBoard()));
  loadBoard(written);
  const all = boardVersions();
  assert.equal(all.length, 1);
  assert.equal(all[0].label, 'kept');
  assert.equal(all[0].kept, true);
  assert.equal(all[0].at, 5000);
});

test('a file may not arrive claiming ten thousand versions', () => {
  const many = [];
  for (let i = 0; i < 200; i++) {
    many.push({ id: `a${i}`, at: i, label: '', kept: false, data: { items: [] } });
    many.push({ id: `k${i}`, at: i, label: 'k', kept: true, data: { items: [] } });
  }
  loadBoard({ title: 'T', items: [], versions: many });
  const all = boardVersions();
  assert.equal(all.filter(v => !v.kept).length, VERSION_RING);
  assert.ok(all.filter(v => v.kept).length <= 32);
});

test('a version with no document is dropped rather than kept unusable', () => {
  loadBoard({ title: 'T', items: [], versions: [
    { id: 'good', at: 2, label: '', kept: false, data: { items: [] } },
    { id: 'bad', at: 1, label: '', kept: false },
    { id: '', at: 3, label: '', kept: false, data: { items: [] } },
    { id: 'good', at: 4, label: '', kept: false, data: { items: [] } },
  ] });
  assert.deepEqual(boardVersions().map(v => v.id), ['good'],
    'no data, no id, and a duplicate id are all dropped');
});

test('versions are not pruned against the live board', () => {
  // Every other relation in a board names cards on it, and is pruned to them. A
  // version names cards the board no longer has, which is the whole of what it
  // is for - pruning it would empty every version the moment it became useful.
  loadBoard({
    title: 'T',
    items: [],
    versions: [{ id: 'v', at: 1, label: '', kept: false,
      data: { items: [{ id: 'long-gone', type: 'image', w: 10, h: 10 }] } }],
  });
  assert.equal(boardVersions().length, 1);
  assert.equal(boardVersions()[0].data.items.length, 1);
});
