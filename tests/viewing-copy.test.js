// The viewing copy a share link can send (research/rapid-fixes-2026-09-14.md,
// R13): smaller pictures, posters for clips, no bin and no history - and
// through boardAssetHashes(), which tests/mbrd.test.js binds to the packer,
// a file that carries none of the originals it replaced.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { viewingCopy } from '../web/assets/js/storage/viewing-copy.ts';
import { boardAssetHashes } from '../web/assets/js/storage/mbrd.ts';
import { item } from './helpers.js';

const H = c => c.repeat(64);
const ORIGINAL = H('a');
const DISPLAY = H('b');
const CLIP = H('c');
const POSTER = H('d');
const PDF = H('e');

const all = () => true;

const board = () => ({
  title: 'Heavy',
  items: [
    item({ id: 'photo', type: 'image', asset: { hash: ORIGINAL }, meta: { display: DISPLAY, crop: { x: 0.1, y: 0, w: 0.5, h: 1 } } }),
    item({ id: 'clip', type: 'video', name: 'clip.mp4', asset: { hash: CLIP }, meta: { cover: POSTER, duration: 12 } }),
    item({ id: 'doc', type: 'generic', asset: { hash: PDF }, meta: {} }),
  ],
  trash: [{ item: item({ id: 'binned', type: 'image', asset: { hash: H('f') }, meta: {} }), at: 1 }],
  timeline: { steps: [] },
});

test('a photograph shows its display copy, and keeps its crop', () => {
  const copy = viewingCopy(board(), all);
  const photo = copy.items.find(i => i.id === 'photo');
  assert.equal(photo.asset.hash, DISPLAY);
  assert.deepEqual(photo.meta.crop, { x: 0.1, y: 0, w: 0.5, h: 1 });
});

test('a clip becomes a picture of its poster, under its own name', () => {
  const clip = viewingCopy(board(), all).items.find(i => i.id === 'clip');
  assert.equal(clip.type, 'image');
  assert.equal(clip.asset.hash, POSTER);
  assert.equal(clip.name, 'clip.mp4');
});

test('the bin and the history stay behind', () => {
  const copy = viewingCopy(board(), all);
  assert.deepEqual(copy.trash, []);
  assert.equal('timeline' in copy, false);
});

test('the file carries the smaller pictures and none of the originals', () => {
  const hashes = boardAssetHashes(viewingCopy(board(), all));
  assert.ok(hashes.has(DISPLAY));
  assert.ok(hashes.has(POSTER));
  assert.ok(hashes.has(PDF), 'a card with nothing smaller rides as it is');
  assert.equal(hashes.has(ORIGINAL), false);
  assert.equal(hashes.has(CLIP), false);
});

test('a card is never pointed at bytes this machine does not hold', () => {
  const copy = viewingCopy(board(), hash => hash !== DISPLAY && hash !== POSTER);
  assert.equal(copy.items.find(i => i.id === 'photo').asset.hash, ORIGINAL);
  const clip = copy.items.find(i => i.id === 'clip');
  assert.equal(clip.type, 'video');
  assert.equal(clip.asset.hash, CLIP);
});

test('the board handed in is left as it was', () => {
  const given = board();
  const before = JSON.stringify(given);
  viewingCopy(given, all);
  assert.equal(JSON.stringify(given), before);
});
