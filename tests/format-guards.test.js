// Two guards on the .mbrd format. A top-level board.json key this build does
// not know survives a load and a save (normalizeBoard() keeps it, and
// serializeBoard() writes it back). And a ZIP whose leading `mimetype` names
// another format is refused by name, while a board with no `mimetype` at all
// - every file from before the entry existed - still opens.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadBoard, serializeBoard, board, setBoardMode } from '../web/assets/js/state.ts';
import { normalizeBoard } from '../web/assets/js/board-schema.ts';
import { unpackBoard, MIME } from '../web/assets/js/storage/mbrd.ts';
import { writeZip } from '../web/assets/js/storage/zip.ts';

const enc = new TextEncoder();
const json = value => enc.encode(JSON.stringify(value));

test('an unknown board.json key rides through a load and a save', () => {
  setBoardMode('desktop');
  loadBoard({ title: 'Newer', items: [], futureThing: { a: 1 }, tour: [] });
  assert.deepEqual(board.extra, { futureThing: { a: 1 } });
  const out = serializeBoard();
  assert.deepEqual(out.futureThing, { a: 1 });
  // A key this build owns is never taken from the bag.
  assert.equal(out.title, 'Newer');
});

test('the bag never holds a key this build knows, or __proto__', () => {
  const next = normalizeBoard(JSON.parse(
    '{"title":"T","items":[],"versions":[1],"hadMusic":true,"__proto__":{"x":1},"later":2}'));
  assert.deepEqual(Object.keys(next.extra), ['later']);
  assert.equal(Object.getPrototypeOf(next.extra), Object.prototype);
});

test('a leading mimetype for another format is refused by name', async () => {
  const blob = await writeZip([
    { name: 'mimetype', data: enc.encode('application/epub+zip'), compress: false },
    { name: 'board.json', data: json({ title: 'x', items: [] }) },
  ]);
  await assert.rejects(() => unpackBoard(blob), /This is not an mbrd board/);
});

test('a board with the right mimetype, or none, opens', async () => {
  const right = await writeZip([{ name: 'board.json', data: json({ title: 'Ok', items: [] }) }], { mime: MIME });
  assert.equal((await unpackBoard(right)).board.title, 'Ok');
  const none = await writeZip([{ name: 'board.json', data: json({ title: 'Old', items: [] }) }]);
  assert.equal((await unpackBoard(none)).board.title, 'Old');
});
