// The example board survives the same normalisation a file does, whole: every
// card, every tour stop, every note under the length a note may hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exampleBoard } from '../web/assets/js/storage/example.ts';
import { normalizeBoard } from '../web/assets/js/board-schema.ts';

test('the example board loads with every card and every stop', () => {
  const raw = exampleBoard();
  const board = normalizeBoard(raw);
  const ids = new Set(board.items.map(i => i.id));
  for (const item of raw.items) assert.ok(ids.has(item.id), `${item.id} survives the load`);
  assert.equal(board.tour.length, raw.tour.length, 'no stop is dropped');
  assert.equal(board.connections.length, raw.connections.length);
});

test('its notes fit a note and its sticker is a real shape', () => {
  const raw = exampleBoard();
  for (const n of raw.items.filter(i => i.type === 'note')) assert.ok(n.meta.text.length <= 512, n.id);
  const sprite = readFileSync(new URL('../web/assets/stickers.svg', import.meta.url), 'utf8');
  for (const s of raw.items.filter(i => i.type === 'sticker')) assert.ok(sprite.includes(`id="${s.meta.shape}"`), s.meta.shape);
});

test('each call is a fresh copy', () => {
  const a = exampleBoard();
  a.items.length = 0;
  assert.ok(exampleBoard().items.length > 0);
});
