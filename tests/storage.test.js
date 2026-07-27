import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { fileNameFor } from '../web/assets/js/storage/storage.js';

test('export filenames replace board-name spaces with underscores', () => {
  assert.equal(fileNameFor('Summer references'), 'Summer_reference.mbrd');
  assert.equal(fileNameFor('A B C'), 'A_B_C.mbrd');
});

test('the sidebar title field carries the shared sixteen-character limit', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="board-title"[^>]*maxlength="16"/);
});
