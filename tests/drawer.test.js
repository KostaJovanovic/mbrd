// The corner button's two jobs, and the one rule the drawer's markup lives under.
//
// #drawer-btn is Delete while something is selected and the way into the
// drawer otherwise - two behaviours behind one press, easy to swap by a
// later edit. Stands up just enough browser to open and close the window;
// the point is that the button tells the two states apart and says which one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, selection, loadBoard, addItems, select, removeItems, restoreItems,
  byId, stuckTo, setBoardMode,
} from '../web/assets/js/state.ts';
import { initDrawer } from '../web/assets/js/ui/drawer.ts';
import { fresh, note, photo, sticker } from './state-fixtures.js';

class FakeElement {
  constructor(tag = 'div') {
    this.tag = tag;
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    this.style = { setProperty() {}, removeProperty() {} };
    this.classList = {
      add() {}, remove() {}, toggle() {}, contains: () => false,
    };
  }

  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener() {}
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name]; }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  remove() {}
  contains() { return false; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setPointerCapture() {}
}

/**
 * Enough of a browser to open the drawer in: the document that builds
 * elements, the globals the shelf watcher reaches for, and
 * a body to append to. Handed back as a teardown, since a `delete` at the
 * foot of a test only runs when every assertion passed, and a stray browser
 * global makes an unrelated module throw at import (tests/imports.test.js).
 */
function fakeBrowser(ids) {
  const elements = Object.fromEntries(ids.map(id => [id, new FakeElement()]));
  const previous = {
    document: globalThis.document,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IntersectionObserver: globalThis.IntersectionObserver,
  };
  globalThis.document = {
    body: new FakeElement('body'),
    getElementById: id => elements[id] || null,
    createElement: tag => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: text => ({ text }),
    elementFromPoint: () => null,
  };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  // Never called back: a shelf that never gets a frame never mounts a card.
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  };
  return { elements, restore: () => Object.assign(globalThis, previous) };
}

/** Everything under `node` wearing this class, in the order it was built. */
function findAll(node, className) {
  const out = [];
  const walk = el => {
    if (!el || typeof el !== 'object') return;
    if (String(el.className || '').split(' ').includes(className)) out.push(el);
    for (const kid of el.children || []) walk(kid);
  };
  walk(node);
  return out;
}

test('the drawer button deletes the selection and otherwise opens the drawer', (t) => {
  const { elements, restore } = fakeBrowser(['drawer-btn', 'viewport']);
  t.after(restore);
  const btn = elements['drawer-btn'];
  // As index.html declares it - deleting a selection must not announce a
  // drawer that was never open.
  btn.setAttribute('aria-expanded', 'false');

  loadBoard({ title: 'Drawer button', items: [], trash: [] });
  initDrawer({ width: 800, height: 600 });
  const [item] = addItems([{ type: 'note', meta: { text: 'Delete me' } }]);
  select([item.id]);

  assert.equal(btn.title, 'Delete 1 selected item');
  btn.listeners.get('click')();
  assert.equal(board.items.length, 0);
  assert.equal(board.trash.length, 1);
  assert.equal(selection.size, 0);
  assert.equal(btn['aria-expanded'], 'false');
  assert.equal(btn.title, 'Drawer, 1 item');

  btn.listeners.get('click')();
  assert.equal(btn['aria-expanded'], 'true');
  btn.listeners.get('click')();
  assert.equal(btn['aria-expanded'], 'false');
});

// A delete files the host and its riders as separate entries, since separate
// things left the board - but they left as one pile and come back as one
// (riderCascade/ridersInBin, trash.ts). A shelf showing three cards would
// describe a drawer nobody has, since dragging any one back brings all three.
//
// Nothing about getting this wrong fails on its own - the window still opens
// and the restore still works, just with two extra cards that can't be taken
// back separately. Asserted here, the one place it's decided.
test('a card and everything stuck to it get one slot on the shelf', (t) => {
  const { elements, restore } = fakeBrowser(['drawer-btn', 'viewport']);
  t.after(restore);
  const btn = elements['drawer-btn'];
  btn.setAttribute('aria-expanded', 'false');

  setBoardMode('desktop');
  fresh();
  initDrawer({ width: 800, height: 600 });

  const [pic] = addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [n] = addItems([note({ x: -100, y: -100 })]);
  const [star] = addItems([sticker({ x: 100, y: 100 })]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id);
  assert.equal(stuckTo(byId(star.id))?.id, pic.id);

  removeItems([pic.id]);
  assert.equal(board.trash.length, 3, 'three things left the board');

  btn.listeners.get('click')();
  const win = document.body.children.at(-1);
  const slots = findAll(win, 'drawer-slot');
  assert.equal(slots.length, 1, 'one pile, one slot');
  assert.equal(slots[0].dataset.id, pic.id, 'the host is what the slot puts back');
  assert.match(slots[0]['aria-label'], /2 things stuck to it/);

  // The other half of the same rule: take the pile back out - all three
  // come - then throw the note and sticker away on their own. Two things
  // that are nobody's rider are two slots.
  restoreItems([pic.id]);
  assert.equal(board.trash.length, 0, 'the whole pile came back on one restore');
  removeItems([n.id]);
  removeItems([star.id]);
  assert.equal(board.trash.length, 2);
  const alone = findAll(document.body.children.at(-1), 'drawer-slot');
  assert.equal(alone.length, 2, 'nothing in the drawer is stuck to anything still in it');

  btn.listeners.get('click')();
});

// The drawer draws items from a .mbrd somebody else wrote, so it falls under
// CLAUDE.md's rule against innerHTML on a foreign document. The panel this
// replaced used a template string interpolating item `meta` into an
// attribute - "safe because of a guard three lines up" is the arrangement
// the rule refuses.
//
// It draws no thumbnails now - shelves hold the board's own cards (built by
// canvas/item-dom.ts), and header marks come from the menu's icon() via
// createElementNS. No escaping to get right anywhere in this module.
test('ui/drawer.ts builds its markup rather than writing it', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/assets/js/ui/drawer.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML']) {
    assert.ok(!src.includes(sink), `ui/drawer.ts is back to ${sink} on a document it did not write`);
  }
});
