import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  fileNameFor, titleForOpenedBoard, titleFromFileName,
} from '../web/assets/js/storage/storage.ts';

test('export filenames replace board-name spaces with underscores', () => {
  assert.equal(fileNameFor('Summer references'), 'Summer_references.mbrd');
  assert.equal(fileNameFor('A B C'), 'A_B_C.mbrd');
});

test('filenames become readable board names when they supply the title', () => {
  assert.equal(titleFromFileName('Summer_references.mbrd'), 'Summer references');
  assert.equal(titleFromFileName('Already readable.mbrd'), 'Already readable');
});

test('a stored title is taken as typed, underscores included', () => {
  // cleanBoardTitle() permits underscores, so a board named `my_board` is named
  // `my_board` - however it was saved, and whatever the file ended up called.
  // The unconditional repair this replaced rewrote it on the first reopen and
  // made the change durable.
  const now = 'mbrd 0.110';
  assert.equal(titleForOpenedBoard('my_board', 'my_board.mbrd', now), 'my_board');
  assert.equal(titleForOpenedBoard('my_board', 'Different_name.mbrd', now), 'my_board');
  assert.equal(titleForOpenedBoard('Notes_2026 draft', 'Notes_2026_draft.mbrd', now),
    'Notes_2026 draft');
});

test('a file written before v0.51 still has its packed filename decoded', () => {
  // Up to v0.50 a Save As renamed the board to the picker-safe filename, so the
  // underscores in those files are the mapping's and not the author's. The
  // manifest's `app` field is what tells the two apart.
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
  // Nothing this app writes lacks manifest.app, so the only way here is by hand.
  assert.equal(titleForOpenedBoard('my_board', 'my_board.mbrd'), 'my_board');
  assert.equal(titleForOpenedBoard('my_board', 'my_board.mbrd', 'something else'), 'my_board');
});

test('a file with no stored title falls back to a readable filename', () => {
  assert.equal(titleForOpenedBoard('', 'Fallback_name.mbrd'), 'Fallback name');
  assert.equal(titleForOpenedBoard(null, 'Fallback_name.mbrd', 'mbrd 0.110'), 'Fallback name');
});

test('the sidebar title field carries the shared thirty-two-character limit', async () => {
  // In the settings table rather than in index.html now that ui/panel.js builds
  // the panel. Same assertion, one file along: the field the board is renamed in
  // must stop where cleanBoardTitle() stops, or a name typed to the field's
  // limit comes back cut.
  const schema = await readFile(
    new URL('../web/assets/js/ui/settings-schema.ts', import.meta.url), 'utf8');
  assert.match(schema, /id: 'board-title'[\s\S]{0,200}?maxlength: 32/);
});
