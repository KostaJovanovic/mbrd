// What the readout says the board holds.
//
// The count answers "how much have I put here", so it counts items and not the
// furniture the app puts on a board itself. The hints were excluded from the
// start and the title card was not, which made every Desktop count one high and
// opened a brand-new board on "1 thing" - see hasContent(), whose rule this now
// shares through isFurniture().

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadBoard, addItems, select, ensureTitleCard, ensureGhostCards, board,
} from '../web/assets/js/state.js';

class FakeElement {
  constructor() {
    this.textContent = '';
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
  }

  addEventListener() {}
  setAttribute(name, value) { this[name] = value; }
  append() {}
  replaceChildren() {}
}

/** The readout, after a paint, with the DOM stubbed for the length of the call. */
async function countText(build) {
  const elements = {};
  globalThis.document = {
    getElementById: id => (elements[id] ||= new FakeElement()),
    createElement: () => new FakeElement(),
    documentElement: new FakeElement(),
  };
  try {
    const { paintCount } = await import('../web/assets/js/ui/hud.js');
    build();
    paintCount();
    return elements['hud-count'].textContent;
  } finally {
    delete globalThis.document;
  }
}

test('a board carrying only its furniture has nothing on it', async () => {
  assert.equal(await countText(() => {
    loadBoard({ title: 'Blank', items: [] });
    ensureTitleCard();
    ensureGhostCards();
    assert.ok(board.items.length > 0, 'the fixture should have put furniture there');
  }), 'nothing yet');
});

test('the count is of things the user put there, title card excluded', async () => {
  assert.equal(await countText(() => {
    loadBoard({ title: 'One photo', items: [] });
    ensureTitleCard();
    select([]);
    addItems([{ type: 'image', w: 200, h: 200 }]);
  }), '1 thing');

  assert.equal(await countText(() => {
    loadBoard({ title: 'Two photos', items: [] });
    ensureTitleCard();
    select([]);
    addItems([{ type: 'image', w: 200, h: 200 }, { type: 'note', w: 100, h: 100 }]);
  }), '2 things');
});
