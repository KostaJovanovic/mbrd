// The boards inside the board (board-tree.ts), and the save that carries them:
// a board opened with children writes them back, wherever in the tree the
// board on screen is. The file side is tests/mbrd.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  setChildren, childDocs, childCount, pushLevel, popLevel, boardPath, atTop, topDoc,
  childIdsOf, otherLevels, MAX_CHILD_BOARDS,
} from '../web/assets/js/board-tree.ts';
import { loadBoard, serializeBoard } from '../web/assets/js/state.ts';

const doc = (title, items = []) => ({ title, items, trash: [] });

test('a tree takes real children only, and no more than the limit', () => {
  const raw = { a: doc('A'), '../b': doc('B'), c: 'not a board' };
  for (let i = 0; i < MAX_CHILD_BOARDS + 3; i++) raw[`k${i}`] = doc(`K${i}`);
  const dropped = setChildren(raw);
  assert.equal(childCount(), MAX_CHILD_BOARDS);
  assert.equal(dropped, 2 + 4, 'the bad id, the non-board, and the four past the limit');
  setChildren(null);
  assert.equal(childDocs(), null);
});

test('going in keeps the level left, and coming out hands it back', () => {
  setChildren({ kid: doc('Kid'), grand: doc('Grand') });
  pushLevel('kid', doc('Top, as left'));
  assert.deepEqual(boardPath(), ['kid']);
  assert.equal(topDoc().title, 'Top, as left');
  pushLevel('grand', doc('Kid, as left'));
  assert.deepEqual(boardPath(), ['kid', 'grand']);
  assert.equal(popLevel(doc('Grand, as left')).title, 'Kid, as left');
  assert.equal(popLevel(doc('Kid, again')).title, 'Top, as left');
  assert.ok(atTop());
  assert.equal(topDoc(), null);
  assert.equal(popLevel(doc('nothing')), null, 'there is no level above the top');
  const docs = childDocs();
  assert.equal(docs.kid.title, 'Kid, again');
  assert.equal(docs.grand.title, 'Grand, as left');
});

test('the children a board names are its board cards, bin included', () => {
  const ids = childIdsOf({
    items: [
      { type: 'board', meta: { board: 'one' } },
      { type: 'image', meta: { board: 'not-a-card' } },
      { type: 'board', meta: { board: '../escape' } },
    ],
    trash: [{ item: { type: 'board', meta: { board: 'two' } } }],
  });
  assert.deepEqual(ids, ['one', 'two']);
});

test('every other level is what a bin being emptied must leave alone', () => {
  setChildren({ kid: doc('Kid'), grand: doc('Grand') });
  assert.deepEqual(otherLevels().map(d => d.title).sort(), ['Grand', 'Kid']);
  pushLevel('kid', doc('Top'));
  assert.deepEqual(otherLevels().map(d => d.title).sort(), ['Grand', 'Top']);
  popLevel(doc('Kid'));
});

test('a board opened with children saves them back', () => {
  loadBoard({ title: 'Kitchen', items: [], boards: { tiles: doc('Tiles'), bad: 7 } });
  const saved = serializeBoard();
  assert.equal(saved.title, 'Kitchen');
  assert.deepEqual(Object.keys(saved.boards), ['tiles']);
  assert.equal(saved.boards.tiles.title, 'Tiles');
  loadBoard({ title: 'Plain', items: [] });
  assert.equal('boards' in serializeBoard(), false, 'a board with none writes no key');
});
