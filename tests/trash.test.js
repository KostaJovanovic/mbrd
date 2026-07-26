import { test } from 'node:test';
import assert from 'node:assert/strict';

import { board, selection, loadBoard, addItems, select } from '../web/assets/js/state.js';
import { initTrash } from '../web/assets/js/ui/trash.js';

class FakeElement {
  constructor() {
    this.hidden = true;
    this.disabled = false;
    this.dataset = {};
    this.listeners = new Map();
    this.classList = {
      add() {},
      toggle() {},
    };
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  setAttribute(name, value) {
    this[name] = value;
  }

  append() {}
  replaceChildren() {}
}

test('the trash button deletes the selection and otherwise opens the bin', () => {
  const ids = ['bin-panel', 'bin-btn', 'bin-list', 'bin-none', 'bin-hint', 'bin-empty', 'viewport'];
  const elements = Object.fromEntries(ids.map(id => [id, new FakeElement()]));
  globalThis.document = {
    getElementById: id => elements[id] || null,
    createElement: () => new FakeElement(),
  };

  loadBoard({ title: 'Trash button', items: [], trash: [] });
  initTrash({ width: 800, height: 600 });
  const [item] = addItems([{ type: 'note', meta: { text: 'Delete me' } }]);
  select([item.id]);

  assert.equal(elements['bin-btn'].title, 'Delete 1 selected item');
  elements['bin-btn'].listeners.get('click')();
  assert.equal(board.items.length, 0);
  assert.equal(board.trash.length, 1);
  assert.equal(selection.size, 0);
  assert.equal(elements['bin-panel'].hidden, true);
  assert.equal(elements['bin-btn'].title, 'Trash, 1 item');

  elements['bin-btn'].listeners.get('click')();
  assert.equal(elements['bin-panel'].hidden, false);

  delete globalThis.document;
});
