import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  fileNameFor, titleForOpenedBoard, titleFromFileName,
} from '../web/assets/js/storage/storage.js';

test('export filenames replace board-name spaces with underscores', () => {
  assert.equal(fileNameFor('Summer references'), 'Summer_reference.mbrd');
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

test('the sidebar title field carries the shared sixteen-character limit', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="board-title"[^>]*maxlength="16"/);
});
