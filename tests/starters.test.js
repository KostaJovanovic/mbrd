// Starter layouts (storage/starters.ts): each loads as a board of titled,
// empty fences that sit under the title card and never overlap.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STARTERS } from '../web/assets/js/storage/starters.ts';
import { normalizeBoard } from '../web/assets/js/board-schema.ts';

test('every starter is a board of named fences, below the title and apart', () => {
  assert.ok(STARTERS.length >= 4);
  for (const s of STARTERS) {
    const data = normalizeBoard(s.board());
    const fences = data.items.filter(i => i.type === 'fence');
    assert.ok(fences.length >= 4, `${s.id}: only ${fences.length} fences`);
    assert.equal(fences.length, s.board().items.length, `${s.id}: every item survives the load, and all are fences`);
    for (const f of fences) {
      assert.ok(f.name, `${s.id}: a fence with no title`);
      assert.ok(f.y + f.h / 2 < -200, `${s.id}: ${f.name} reaches up to the title card`);
    }
    for (const a of fences) for (const b of fences) {
      if (a === b) continue;
      const apart = Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.y - b.y) >= (a.h + b.h) / 2;
      assert.ok(apart, `${s.id}: ${a.name} and ${b.name} overlap`);
    }
  }
});

test('each call hands out a fresh board, since loading one takes it over', () => {
  for (const s of STARTERS) assert.notEqual(s.board().items, s.board().items);
});
