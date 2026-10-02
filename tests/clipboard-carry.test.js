// A copy that outlives its board: the clipboard holds the bytes its cards name
// through an injected carry (clipboard.ts, wired in main.ts), so a paste on the
// next board brings the pictures with it. Unwired, a load empties it as before.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  addItems, copyItems, pasteItems, clipboardSize, setBoardMode, setClipboardCarry,
} from '../web/assets/js/state.ts';
import { getAsset, putAsset, clearAssets } from '../web/assets/js/storage/assets.ts';
import { itemHashes } from '../web/assets/js/util.ts';
import { hash } from './helpers.js';
import { fresh, photo } from './state-fixtures.js';

const PIC = hash('a photograph');
const THUMB = hash('its thumbnail');

/** The carry main.ts wires, written out again so this file tests the seam. */
const carry = {
  hold: items => {
    const held = new Map();
    for (const it of items) for (const h of itemHashes(it)) if (getAsset(h)) held.set(h, getAsset(h));
    return held;
  },
  restore: held => {
    for (const [h, a] of held) putAsset(h, a.blob, { mime: a.mime, ext: a.ext, name: a.name });
  },
};

const card = () => photo({
  x: 0, y: 0, name: 'p.jpg',
  asset: { hash: PIC, ext: 'jpg', mime: 'image/jpeg', name: 'p.jpg' },
  meta: { thumb: THUMB },
});

beforeEach(() => {
  setBoardMode('desktop');
  setClipboardCarry(null);
  clearAssets();
  fresh();
});

after(() => setClipboardCarry(null));

/** What a board switch does to the two halves: the registry empties, the board is replaced. */
function switchBoards() {
  clearAssets();
  fresh();
}

test('with the carry wired, a copy pastes whole onto the next board', () => {
  setClipboardCarry(carry);
  putAsset(PIC, new Blob(['jpeg bytes'], { type: 'image/jpeg' }), { ext: 'jpg', name: 'p.jpg' });
  putAsset(THUMB, new Blob(['thumb bytes'], { type: 'image/webp' }), { ext: 'webp' });
  const [a] = addItems([card()]);
  copyItems([a.id]);

  switchBoards();
  assert.equal(getAsset(PIC), undefined, 'the switch really did empty the registry');
  assert.equal(clipboardSize(), 1, 'the copy survived the load');

  const [pasted] = pasteItems({ x: 0, y: 0 });
  assert.ok(pasted, 'the paste landed');
  assert.equal(pasted.asset.hash, PIC);
  assert.ok(getAsset(PIC), 'and its picture came with it');
  assert.ok(getAsset(THUMB), 'derived references too, not only the file');
});

test('unwired, a board load empties the clipboard as it always did', () => {
  putAsset(PIC, new Blob(['jpeg bytes'], { type: 'image/jpeg' }), { ext: 'jpg' });
  const [a] = addItems([card()]);
  copyItems([a.id]);
  switchBoards();
  assert.equal(clipboardSize(), 0, 'hashes nothing can resolve are not offered');
});
