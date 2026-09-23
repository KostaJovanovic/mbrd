// desktop/main.ts, read as text: it runs in Electron's main process, which no
// test here can start. Each check holds one repair that nothing else would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const main = readFileSync(join(import.meta.dirname, '..', 'desktop', 'main.ts'), 'utf8');

test('the portable fallback note names the boards folder chooseFolder() picked', () => {
  // Built before chooseFolder(), the note said the boards were in the data
  // folder while they went to Documents/mbrd.
  const chosen = main.indexOf('boards.chooseFolder(inData)');
  // An assignment, not the `let` that declares it empty.
  const writes = [...main.matchAll(/\n\s+startupNote = /g)];
  assert.equal(writes.length, 1);
  const noted = writes[0].index;
  assert.ok(chosen > 0 && noted > chosen, 'the note is written after the folder is chosen');
  assert.match(main.slice(noted, noted + 200), /boardsFolder/);
});
