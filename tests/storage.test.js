import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  fileNameFor, titleForOpenedBoard, titleFromFileName,
} from '../web/assets/js/storage/storage.js';

test('export filenames replace board-name spaces with underscores', () => {
  assert.equal(fileNameFor('Summer references'), 'Summer_references.mbrd');
  assert.equal(fileNameFor('A B C'), 'A_B_C.mbrd');
});

test('filenames become readable board names when they supply the title', () => {
  assert.equal(titleFromFileName('Summer_references.mbrd'), 'Summer references');
  assert.equal(titleFromFileName('Already readable.mbrd'), 'Already readable');
});

test('opening a file repairs underscores in an embedded or fallback title', () => {
  assert.equal(
    titleForOpenedBoard('Saved_with_underscores', 'Different_name.mbrd'),
    'Saved with underscores',
  );
  assert.equal(titleForOpenedBoard('', 'Fallback_name.mbrd'), 'Fallback name');
});

test('the sidebar title field carries the shared thirty-two-character limit', async () => {
  // In the settings table rather than in index.html now that ui/panel.js builds
  // the panel. Same assertion, one file along: the field the board is renamed in
  // must stop where cleanBoardTitle() stops, or a name typed to the field's
  // limit comes back cut.
  const schema = await readFile(
    new URL('../web/assets/js/ui/settings-schema.js', import.meta.url), 'utf8');
  assert.match(schema, /id: 'board-title'[\s\S]{0,200}?maxlength: 32/);
});
