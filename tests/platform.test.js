// The six ports, and the promise they all make: unwired is the web. Every
// module below main.ts asks platform.* rather than the browser directly,
// so asking must change nothing - a port throwing where old code
// returned, or vice versa, ships a behaviour change to every browser
// visitor in the name of a desktop build that doesn't exist yet.
//
// The second half wires a fake shell and checks the other direction: that
// isDesktop() follows the wiring, not a capability, and that
// exportBoard() ends at platform.files.write() with no Electron to
// confuse the question.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './helpers.js';
import {
  platform, setPlatform, isDesktop, fileNameOf, refForHandle,
} from '../web/assets/js/platform/platform.ts';
import { setStoreBackend } from '../web/assets/js/storage/idb.ts';
import { exportBoard, openFile } from '../web/assets/js/storage/storage.ts';
import { loadBoard, board, isDirty, markDirty } from '../web/assets/js/state.ts';
import { unpackBoard } from '../web/assets/js/storage/mbrd.ts';

beforeEach(() => {
  setPlatform(null);
  setStoreBackend(memoryStore());
  loadBoard({ title: 'Ported', items: [] });
});

after(() => { setPlatform(null); setStoreBackend(null); });

// ---------------------------------------------------------------------------
// Unwired
// ---------------------------------------------------------------------------

test('unwired, this is a browser and says so', () => {
  assert.equal(isDesktop(), false);
});

test('every native port answers null, so every caller falls through', async () => {
  // The whole protocol of NativePort: ask first, fall through on null. If
  // any of these threw instead, four modules with no desktop branch
  // would need one.
  const bytes = new ArrayBuffer(8);
  assert.equal(await platform.native.firstFrame(bytes, 'clip.mov'), null);
  assert.equal(await platform.native.transcode(bytes, 'clip.mov', {}), null);
  assert.equal(await platform.native.matte(new Float32Array(3)), null);
  assert.equal(await platform.native.decode(bytes, 'photo.heic'), null);
});

test('the updates port answers nothing, because the service worker is the web updater', async () => {
  // Safe to call and does nothing, so a row wired to it can't throw on a web
  // build that somehow reached it.
  assert.equal(await platform.updates.check(), undefined);
});

test('a picker that is not there is a dismissal, not a crash', async () => {
  // There is no `window` at all, the strongest form of "no File System
  // Access API". Callers read err.name (see isAbort() in storage.ts), so
  // the name is the contract, not the class.
  await assert.rejects(() => platform.files.pickOpen({ types: [], accept: '', mode: 'x' }),
    err => err.name === 'AbortError');
  await assert.rejects(() => platform.files.pickSave('b.mbrd', { types: [], accept: '', mode: 'x' }),
    err => err.name === 'AbortError');
  assert.equal(platform.files.canPick(), false);
});

test('a browser cannot read a file by name, and says so as a dismissal', async () => {
  await assert.rejects(() => platform.files.read({ name: 'b.mbrd', path: '/tmp/b.mbrd' }),
    err => err.name === 'AbortError');
});

test('a document the web made always exists, because there is no path to go stale', async () => {
  assert.equal(await platform.files.exists({ name: 'b.mbrd' }), true);
});

test('the web lifecycle never hands over a file on its own', () => {
  // launchQueue is main.ts's own block and stays there. This port exists
  // so the desktop has a door; the web default must not invent one, or
  // both would fire on a PWA.
  let called = 0;
  platform.lifecycle.onOpenFiles(() => { called++; });
  assert.equal(called, 0);
});

test('fileNameOf reads both separators, because a path is the OS spelling', () => {
  assert.equal(fileNameOf('C:\\Users\\k\\Boards\\Summer.mbrd'), 'Summer.mbrd');
  assert.equal(fileNameOf('/home/k/boards/Summer.mbrd'), 'Summer.mbrd');
  assert.equal(fileNameOf('Summer.mbrd'), 'Summer.mbrd');
});

// ---------------------------------------------------------------------------
// Wired
// ---------------------------------------------------------------------------

/**
 * A shell that records what it was asked to do. Only the methods the
 * tests below reach are real; the rest keep the web defaults' shape so a
 * mistake shows up as a wrong answer, not a TypeError somewhere unrelated.
 */
function fakeShell({ canPick = true } = {}) {
  const calls = { picked: [], written: [], documents: [], relaunched: 0 };
  return {
    calls,
    files: {
      canPick: () => canPick,
      pickOpen: async () => { throw Object.assign(new Error('no'), { name: 'AbortError' }); },
      pickSave: async suggested => {
        calls.picked.push(suggested);
        return { name: suggested, path: '/tmp/' + suggested };
      },
      write: async (ref, blob) => { calls.written.push({ ref, blob }); },
      pickImport: async () => [],
      read: async () => { throw new Error('not in this test'); },
      exists: async () => true,
    },
    lifecycle: { onCloseRequested() {}, onOpenFiles() {}, onBack() {} },
    native: {
      canTranscode: () => false,
      firstFrame: async () => null, transcode: async () => null,
      matte: async () => null, decode: async () => null,
    },
    updates: { check: async () => {} },
    setDocument: state => { calls.documents.push(state); },
    relaunch: () => { calls.relaunched++; },
  };
}

test('isDesktop follows the wiring, not a capability', () => {
  const shell = fakeShell();
  setPlatform(shell);
  assert.equal(isDesktop(), true, 'a wired shell is a desktop');
  setPlatform(null);
  assert.equal(isDesktop(), false, 'and null puts the browser back');
});

test('the port object reads the current shell, not the one it was imported beside', () => {
  // `platform` is held at module scope by a dozen callers, all imported
  // long before main.ts wires anything. A snapshot rather than getters
  // would freeze every one onto the web defaults.
  const shell = fakeShell();
  setPlatform(shell);
  platform.relaunch();
  assert.equal(shell.calls.relaunched, 1);
});

test('exportBoard ends at platform.files.write, and writes the board', async () => {
  loadBoard({ title: 'Ported', items: [] });
  const shell = fakeShell();
  setPlatform(shell);

  assert.equal(await exportBoard({ pickNew: true }), true);
  assert.deepEqual(shell.calls.picked, ['Ported.mbrd'], 'the picker ran before anything was packed');
  assert.equal(shell.calls.written.length, 1);

  const { ref, blob } = shell.calls.written[0];
  assert.equal(ref.path, '/tmp/Ported.mbrd', 'it wrote to the document the picker returned');
  const { board: data } = await unpackBoard(new File([blob], ref.name));
  assert.equal(data.title, 'Ported', 'and the bytes are the board');
});

// `pickNew: true` establishes the document rather than relying on there
// being none. storage.ts holds it at module scope for the page's life, so
// these tests share one - each pins its own starting point instead of
// assuming the previous test left none behind.
test('a second export reuses the document instead of asking again', async () => {
  const shell = fakeShell();
  setPlatform(shell);
  await exportBoard({ pickNew: true });
  await exportBoard();
  assert.equal(shell.calls.picked.length, 1, 'asked once');
  assert.equal(shell.calls.written.length, 2, 'wrote twice');
});

test('Save As asks again even though there is a document', async () => {
  const shell = fakeShell();
  setPlatform(shell);
  await exportBoard({ pickNew: true });
  await exportBoard({ pickNew: true });
  assert.equal(shell.calls.picked.length, 2);
});

test('without a picker the write still happens, under the packed name', async () => {
  // Safari and Firefox. The old code branched between a handle and a
  // download; now both endings are write()'s, and the caller only decides
  // the name, which comes from what was packed since nothing renamed the board.
  loadBoard({ title: 'No picker', items: [] });
  const shell = fakeShell({ canPick: false });
  setPlatform(shell);

  assert.equal(await exportBoard(), true);
  assert.equal(shell.calls.picked.length, 0, 'no dialog was opened');
  assert.equal(shell.calls.written.length, 1);
  assert.equal(shell.calls.written[0].ref.name, 'No_picker.mbrd');
  assert.equal(shell.calls.written[0].ref.path, undefined, 'and there is no document');
});

test('an export is a save: the board goes clean', async () => {
  setPlatform(fakeShell());
  markDirty(true);
  assert.equal(isDirty(), true);
  await exportBoard();
  assert.equal(isDirty(), false);
});

test('a ref made from a handle is the document, so Save writes back to it', async () => {
  // The launchQueue path. Its handle used to become `fileHandle` directly;
  // dropping the ref would let "Open with mbrd" open the file and then
  // fail to save over it.
  const handle = { name: 'Handed_over.mbrd' };
  const ref = refForHandle(handle);
  assert.equal(ref.name, 'Handed_over.mbrd');

  const shell = fakeShell();
  setPlatform(shell);
  loadBoard({ title: 'Handed over', items: [] });
  await exportBoard({ pickNew: true });
  assert.ok(shell.calls.written[0].blob, 'the export path is unchanged by the wrapper existing');
});

test('openFile takes the document it was opened as', async () => {
  const shell = fakeShell();
  setPlatform(shell);
  loadBoard({ title: 'First', items: [] });
  await exportBoard({ pickNew: true });
  const packed = shell.calls.written[0].blob;

  // Reopening it with a ref means the next export writes back there
  // rather than asking - the whole point of a document ref.
  const opened = await openFile(new File([packed], 'Second.mbrd'),
    { name: 'Second.mbrd', path: '/tmp/Second.mbrd' });
  assert.equal(opened, true);
  assert.equal(board.title, 'First', 'the title comes out of the file, not the name');

  shell.calls.picked.length = 0;
  await exportBoard();
  assert.equal(shell.calls.picked.length, 0, 'no picker: it already knows the file');
  assert.equal(shell.calls.written.at(-1).ref.path, '/tmp/Second.mbrd');
});

test('the shell is told which document is on screen, and whether it is dirty', async () => {
  // The window's title bar and, on macOS, its proxy icon and close-dot.
  // There's no way to say this from inside the page - document.title is
  // the browser tab's, and this app never sets one - so a report is the
  // only shape it can take.
  const shell = fakeShell();
  setPlatform(shell);
  shell.calls.documents.length = 0;

  loadBoard({ title: 'Reported', items: [] });
  assert.ok(shell.calls.documents.length, 'loading a board says so');

  markDirty(true);
  assert.equal(shell.calls.documents.at(-1).dirty, true);

  await exportBoard({ pickNew: true });
  const last = shell.calls.documents.at(-1);
  assert.equal(last.ref.path, '/tmp/Reported.mbrd', 'and the document it was saved as');
  assert.equal(last.dirty, false, 'an export is a save, so the mark comes off');
});
