// The boards inside the board (board-tree.ts), and the save that carries them:
// a board opened with children writes them back, wherever in the tree the
// board on screen is. The file side is tests/mbrd.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  setChildren, childDocs, childCount, pushLevel, popLevel, boardPath, atTop, topDoc,
  childIdsOf, otherLevels, MAX_CHILD_BOARDS,
} from '../web/assets/js/board-tree.ts';
import {
  board, loadBoard, serializeBoard, enterBoard, leaveBoard, fileTitle, setFileTitle,
  isDirty, markDirty, renameBoard, undo, newChildBoard, childOf, childFace,
} from '../web/assets/js/state.ts';

const doc = (title, items = []) => ({ title, items, trash: [] });
/** The card that opens child `id`. */
const card = (id, name = '') => ({
  id: `card-${id}`, type: 'board', name, x: 0, y: 0, w: 320, h: 240, meta: { board: id },
});

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
  loadBoard({
    title: 'Kitchen', items: [card('tiles', 'Tiles')],
    boards: { tiles: doc('Tiles'), bad: 7, orphan: doc('No card opens me') },
  });
  const saved = serializeBoard();
  assert.equal(saved.title, 'Kitchen');
  assert.deepEqual(Object.keys(saved.boards), ['tiles'], 'not the unreadable one, nor the one no card reaches');
  assert.equal(saved.boards.tiles.title, 'Tiles');
  loadBoard({ title: 'Plain', items: [] });
  assert.equal('boards' in serializeBoard(), false, 'a board with none writes no key');
});

test('going into a child puts it on screen, and the file stays the top board', () => {
  loadBoard({
    title: 'Kitchen', items: [card('tiles', 'Tiles')],
    boards: { tiles: doc('Tiles', [card('grout', 'Grout')]), grout: doc('Grout') },
  });
  board.view = { pan: { x: 40, y: -12 }, zoom: 0.5 };
  assert.ok(enterBoard('tiles'));
  assert.equal(board.title, 'Tiles');
  assert.equal(fileTitle(), 'Kitchen');
  assert.deepEqual(boardPath(), ['tiles']);
  const saved = serializeBoard();
  assert.equal(saved.title, 'Kitchen', 'a save from inside writes the top as board.json');
  assert.equal(saved.boards.tiles.title, 'Tiles');
  assert.equal(enterBoard('nope'), false, 'no such child');
  assert.ok(enterBoard('grout'));
  assert.equal(enterBoard('tiles'), false, 'already on the path');
  assert.ok(leaveBoard('data:image/webp;base64,AA'));
  assert.ok(leaveBoard());
  assert.ok(atTop());
  assert.equal(board.title, 'Kitchen');
  assert.deepEqual(board.view, { pan: { x: 40, y: -12 }, zoom: 0.5 }, 'back where it was left');
  assert.equal(serializeBoard().boards.grout.thumb, 'data:image/webp;base64,AA');
  assert.equal(leaveBoard(), false, 'nothing above the top');
});

test('a level change keeps the dirty flag and each level its own history', () => {
  loadBoard({ title: 'Kitchen', items: [card('tiles', 'Tiles')], boards: { tiles: doc('Tiles') } });
  assert.equal(isDirty(), false);
  markDirty();
  enterBoard('tiles');
  assert.ok(isDirty(), 'an unsaved edit on the top is still unsaved inside');
  renameBoard('Wall tiles');
  leaveBoard();
  assert.equal(board.title, 'Kitchen');
  assert.equal(board.items.find(i => i.type === 'board').name, 'Wall tiles', 'the card takes its child\'s name');
  undo();
  assert.equal(board.title, 'Kitchen', "the child's rename is not the top's to undo");
  enterBoard('tiles');
  assert.equal(board.title, 'Wall tiles');
  undo();
  assert.equal(board.title, 'Tiles', 'and is still the child\'s');
  leaveBoard();
});

test('a new board inside is one step, and a save leaves out a child whose card was undone', () => {
  loadBoard({ title: 'Kitchen', items: [] });
  const made = newChildBoard({ x: 10, y: 20 });
  assert.equal(made.type, 'board');
  assert.equal(made.name, 'Untitled board');
  const id = childOf(made);
  assert.ok(id);
  assert.deepEqual(childFace(id), { thumb: null, count: 0 });
  assert.deepEqual(Object.keys(serializeBoard().boards), [id]);
  assert.ok(enterBoard(id));
  assert.equal(board.title, 'Untitled board');
  leaveBoard();
  undo();
  assert.equal(board.items.some(i => i.type === 'board'), false);
  assert.equal('boards' in serializeBoard(), false);
  assert.equal(childOf({ type: 'image', meta: { board: id } }), null, 'only a board card opens a board');
});

test('a name picked for the file from inside a child renames the top', () => {
  loadBoard({ title: 'Kitchen', items: [], boards: { tiles: doc('Tiles') } });
  enterBoard('tiles');
  setFileTitle('Kitchen, final');
  assert.equal(board.title, 'Tiles');
  assert.equal(fileTitle(), 'Kitchen, final');
  leaveBoard();
  assert.equal(board.title, 'Kitchen, final');
});
