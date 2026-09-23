// The boards a command line names (desktop/argv.mts). A second launch hands
// its argv to the running copy, whose own folder is somewhere else, so a
// relative path must be resolved against the launch's folder. Unresolved, the
// open failed, and the shelf kept the path relative.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { boardsIn } from '../desktop/argv.mts';

const cwd = resolve('/home/someone/Desktop');

test('a relative board is named from the launch\'s folder', () => {
  assert.deepEqual(boardsIn(['mbrd', 'Summer.mbrd'], cwd), [resolve(cwd, 'Summer.mbrd')]);
  assert.deepEqual(boardsIn(['mbrd', 'sub/../A.MBRD'], cwd), [resolve(cwd, 'A.MBRD')]);
});

test('an absolute board and a file URL keep their place', () => {
  const abs = resolve('/tmp/x.mbrd');
  assert.deepEqual(boardsIn([abs], cwd), [abs]);
  assert.deepEqual(boardsIn([pathToFileURL(abs).href], cwd), [abs]);
});

test('flags and other files are not boards', () => {
  assert.deepEqual(boardsIn(['--inspect', '-x.mbrd', 'notes.txt', '.', '/usr/bin/mbrd'], cwd), []);
});

// Windows reads a URL with a host as a share (\\host\x.mbrd), which is a path.
test('a file URL on another host is skipped', { skip: process.platform === 'win32' }, () => {
  assert.deepEqual(boardsIn(['file://remote-host/x.mbrd'], cwd), []);
});
