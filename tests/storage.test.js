import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  fileNameFor, titleForOpenedBoard, titleFromFileName,
} from '../web/assets/js/storage/storage.ts';
import { BOARD_TITLE_MAX } from '../web/assets/js/board-model.ts';

test('export filenames replace board-name spaces with underscores', () => {
  assert.equal(fileNameFor('Summer references'), 'Summer_references.mbrd');
  assert.equal(fileNameFor('A B C'), 'A_B_C.mbrd');
});

test('filenames become readable board names when they supply the title', () => {
  assert.equal(titleFromFileName('Summer_references.mbrd'), 'Summer references');
  assert.equal(titleFromFileName('Already readable.mbrd'), 'Already readable');
});

test('a stored title is taken as typed, underscores included', () => {
  // cleanBoardTitle() permits underscores, so `my_board` stays `my_board`
  // however the file ended up named. The unconditional repair this replaced
  // rewrote it on first reopen and made the change durable.
  const now = 'mbrd 0.110';
  assert.equal(titleForOpenedBoard('my_board', 'my_board.mbrd', now), 'my_board');
  assert.equal(titleForOpenedBoard('my_board', 'Different_name.mbrd', now), 'my_board');
  assert.equal(titleForOpenedBoard('Notes_2026 draft', 'Notes_2026_draft.mbrd', now),
    'Notes_2026 draft');
});

test('a file written before v0.51 still has its packed filename decoded', () => {
  // Up to v0.50 Save As renamed the board to the picker-safe filename, so
  // those underscores are the mapping's, not the author's. manifest.app
  // tells the two apart.
  assert.equal(
    titleForOpenedBoard('Summer_references', 'Summer_references.mbrd', 'mbrd 0.50'),
    'Summer references',
  );
  assert.equal(
    titleForOpenedBoard('Summer_references', 'Summer_references.mbrd', 'mbrd v0.21'),
    'Summer references',
    'the field has carried a v prefix in the past; both spellings parse',
  );
  assert.equal(
    titleForOpenedBoard('Summer_references', 'Summer_references.mbrd', 'mbrd 0.51'),
    'Summer_references',
    'v0.51 is the build that stopped packing',
  );
});

test('a file naming no build is believed rather than repaired', () => {
  // Nothing this app writes lacks manifest.app, so this only happens by hand.
  assert.equal(titleForOpenedBoard('my_board', 'my_board.mbrd'), 'my_board');
  assert.equal(titleForOpenedBoard('my_board', 'my_board.mbrd', 'something else'), 'my_board');
});

test('a file with no stored title falls back to a readable filename', () => {
  assert.equal(titleForOpenedBoard('', 'Fallback_name.mbrd'), 'Fallback name');
  assert.equal(titleForOpenedBoard(null, 'Fallback_name.mbrd', 'mbrd 0.110'), 'Fallback name');
});

test('the sidebar title field carries the shared thirty-two-character limit', async () => {
  // In the settings table now that ui/panel.ts builds the panel: the field
  // must stop where cleanBoardTitle() stops, or a full-length name comes
  // back cut.
  const schema = await readFile(
    new URL('../web/assets/js/ui/settings-schema.ts', import.meta.url), 'utf8');
  // The control, then its own maxlength - not "a maxlength of 32 somewhere
  // nearby", which a neighbouring control could satisfy. Compared against
  // BOARD_TITLE_MAX, not a literal 32, so the two move together.
  const control = /\{[^{}]*id: 'board-title'[\s\S]*?\n\s*\},/.exec(schema);
  assert.ok(control, "no 'board-title' control in settings-schema.ts");
  const max = /maxlength:\s*(\d+)/.exec(control[0]);
  assert.ok(max, 'the board-title field carries no maxlength');
  assert.equal(Number(max[1]), BOARD_TITLE_MAX);
});
