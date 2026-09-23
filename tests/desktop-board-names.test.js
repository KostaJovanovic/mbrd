// The names desktop/boards.ts gives board files in the boards folder. Main's
// own check on a name the page sends, and the free-name rule, whose "_(2)" has
// to survive the trip through a title and back (naming.ts), or a board would
// rename itself on every save. And the one rule by which the page may name a
// path in the folder that main has not handed it in this run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { plainName, nthName, isFolderBoard } from '../desktop/board-names.mts';
import { fileNameFor, titleFromFileName } from '../web/assets/js/storage/naming.ts';

test('a name is a plain file name that ends in .mbrd', () => {
  assert.equal(plainName('Summer'), 'Summer.mbrd');
  assert.equal(plainName('Summer.mbrd'), 'Summer.mbrd', 'one extension, not two');
  assert.equal(plainName('New_board_Sep_14.mbrd'), 'New_board_Sep_14.mbrd');
});

test('a name cannot leave the folder or hide in it', () => {
  assert.equal(plainName('../../evil'), 'evil.mbrd');
  assert.equal(plainName('C:\\Windows\\evil'), 'CWindowsevil.mbrd');
  assert.equal(plainName('/etc/evil'), 'etcevil.mbrd');
  assert.equal(plainName('.hidden'), 'hidden.mbrd');
});

test('a name Windows refuses is changed, and an empty one is "board"', () => {
  assert.equal(plainName('con'), '_con.mbrd');
  assert.equal(plainName('LPT1.notes'), '_LPT1.notes.mbrd');
  assert.equal(plainName('trailing. '), 'trailing.mbrd');
  assert.equal(plainName('a<b>c:d"e|f?g*h'), 'abcdefgh.mbrd');
  assert.equal(plainName(''), 'board.mbrd');
  assert.equal(plainName('...'), 'board.mbrd');
  assert.equal(plainName(42), 'board.mbrd');
});

test('the second choice of a name is name_(2).mbrd, and so on', () => {
  assert.equal(nthName('Summer.mbrd', 1), 'Summer.mbrd');
  assert.equal(nthName('Summer.mbrd', 2), 'Summer_(2).mbrd');
  assert.equal(nthName('Summer.mbrd', 12), 'Summer_(12).mbrd');
});

test('a free name reads back as a title that names the same file', () => {
  // Save sets the title from the file name, and a title change renames the
  // file. A suffix that did not survive the trip would rename it every time.
  for (const n of [1, 2, 3]) {
    const name = nthName('New_board_Sep_14.mbrd', n);
    assert.equal(fileNameFor(titleFromFileName(name)), name);
  }
});

test('a rename that changes only the case still renames', () => {
  // Read as text: boards.ts needs Electron. freePath() gives the board its own
  // name back in the new case, and a case-blind compare took that for no change.
  const boards = readFileSync(join(import.meta.dirname, '..', 'desktop', 'boards.ts'), 'utf8');
  const rename = /export function rename\([\s\S]*?\n\}/.exec(boards)[0];
  assert.match(rename, /if \(to === from\) return refOf\(from\);/);
  assert.doesNotMatch(rename, /same\(to, from\)/);
});

test('the page may name a board directly in the folder, and nothing else there', () => {
  const root = '/home/a/Documents/mbrd';
  const yes = p => assert.ok(isFolderBoard(p, root, 'linux'), p);
  const no = p => assert.ok(!isFolderBoard(p, root, 'linux'), p);
  yes('/home/a/Documents/mbrd/Summer.mbrd');
  yes('/home/a/Documents/mbrd/SUMMER.MBRD');
  no('/home/a/Documents/mbrd/.store/kv/x.mbrd');
  no('/home/a/Documents/mbrd/sub/x.mbrd');
  no('/home/a/Documents/mbrd/../x.mbrd');
  no('/home/a/Documents/mbrd/x.mbrd/');
  no('/home/a/Documents/mbrd/.hidden.mbrd');
  no('/home/a/Documents/mbrd/x.mbrd-tmp');
  no('/home/a/Documents/mbrd/run.sh');
  no('/home/a/Documents/MBRD/x.mbrd');
  no('Summer.mbrd');
  assert.ok(!isFolderBoard('/home/a/Documents/mbrd/x.mbrd', '', 'linux'), 'no folder chosen yet');

  const wroot = 'C:\\Users\\a\\Documents\\mbrd';
  assert.ok(isFolderBoard('C:\\Users\\a\\Documents\\mbrd\\x.mbrd', wroot, 'win32'));
  assert.ok(isFolderBoard('C:\\Users\\a\\documents\\MBRD\\x.mbrd', wroot, 'win32'), 'Windows folds case');
  assert.ok(!isFolderBoard('C:/Users/a/Documents/mbrd/x.mbrd', wroot, 'win32'), 'not as main wrote it');
  assert.ok(!isFolderBoard('C:\\Users\\a\\Documents\\mbrd\\a.mbrd:evil.mbrd', wroot, 'win32'));
  assert.ok(!isFolderBoard('C:\\Users\\a\\Documents\\mbrd\\sub\\..\\..\\x.mbrd', wroot, 'win32'));
});
