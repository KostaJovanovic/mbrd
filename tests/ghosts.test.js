// Ghost cards: the three hints a brand-new board opens with.
//
// They are real items - selectable, draggable, packed into a Mobile column like
// anything else - and the whole feature is the three places where they are not.
// So that is what this file is about: they never reach a file, they never reach
// the bin, and once they have gone they do not come back.
//
// state.js is a module singleton, so every case starts from a loaded board, the
// same door opening a .mbrd goes through.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, selection, loadBoard, serializeBoard, addItems, removeItems, undo,
  setBoardMode, ensureTitleCard, ensureGhostCards, dismissGhosts, hasContent,
  hasGhosts, GHOST_IDS, TITLE_ID,
} from '../web/assets/js/state.js';
import { HINTS, hintFor } from '../web/assets/js/canvas/ghosts.js';
import { exitKindFor } from '../web/assets/js/canvas/exit-anim.js';

const fresh = (items = []) => loadBoard({ title: 'T', items });
const photo = (props = {}) => ({ type: 'image', w: 200, h: 200, ...props });

const ghosts = () => board.items.filter(i => i.type === 'ghost');

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

test('an empty board earns its hints; a board with anything on it does not', () => {
  ensureGhostCards();
  assert.equal(ghosts().length, 3, 'a blank board opens with three');
  assert.deepEqual(ghosts().map(g => g.id), [...GHOST_IDS], 'in reading order');

  fresh([photo()]);
  ensureGhostCards();
  assert.equal(ghosts().length, 0, 'a board that already has content gets none');
});

test('the title card is furniture, not content, so it does not suppress the hints', () => {
  ensureTitleCard();
  assert.equal(hasContent(), false, 'a board with only its title card is still empty');
  ensureGhostCards();
  assert.equal(ghosts().length, 3);
});

test('seeding twice does not double the hints', () => {
  ensureGhostCards();
  ensureGhostCards();
  assert.equal(ghosts().length, 3);
});

test('every hint carries a key the copy knows a sentence for', () => {
  ensureGhostCards();
  for (const g of ghosts()) {
    assert.ok(g.meta.hint, 'the item carries its key');
    assert.ok(HINTS[g.meta.hint], `${g.meta.hint} has copy`);
    assert.ok(hintFor(g.meta.hint).title, 'and the copy has a title');
    assert.ok(hintFor(g.meta.hint).line, 'and a line');
  }
  assert.equal(new Set(ghosts().map(g => g.meta.hint)).size, 3, 'three different ones');
});

// ---------------------------------------------------------------------------
// They never reach a file
// ---------------------------------------------------------------------------

test('serializeBoard carries no hint, in items or in either layout', () => {
  ensureTitleCard();
  ensureGhostCards();
  addItems([photo({ id: 'p1' })]);
  // addItems does not dismiss on its own - that is canvas/ghosts.js's
  // subscriber, which needs a DOM. Put them back to serialise the worst case:
  // a board that holds both hints and content at once.
  ensureGhostCards();
  board.items.push(...GHOST_IDS
    .filter(id => !board.items.some(i => i.id === id))
    .map(id => ({ id, type: 'ghost', x: 0, y: 0, w: 208, h: 156, rot: 0, z: 1, name: '', asset: null, meta: {} })));
  assert.ok(ghosts().length, 'the board really is carrying hints');

  const out = serializeBoard();
  const ids = new Set(out.items.map(i => i.id));
  for (const id of GHOST_IDS) assert.equal(ids.has(id), false, `${id} is not in items`);
  assert.equal(out.items.some(i => i.type === 'ghost'), false, 'and no hint by type either');

  for (const mode of ['desktop', 'mobile']) {
    const geom = new Set(out.layouts[mode].items.map(g => g.id));
    for (const id of GHOST_IDS) {
      assert.equal(geom.has(id), false, `${id} has no ${mode} geometry in the file`);
    }
  }
  assert.ok(ids.has('p1'), 'the real item is still there');
});

test('a file that arrives carrying a hint is not trusted with it', () => {
  fresh([{ id: '__ghost_drop__', type: 'ghost', w: 208, h: 156 }, photo({ id: 'p1' })]);
  assert.equal(ghosts().length, 0, 'the hint is dropped on the way in');
  assert.ok(board.items.some(i => i.id === 'p1'), 'the rest of the board survives');
});

// ---------------------------------------------------------------------------
// They do not come back
// ---------------------------------------------------------------------------

test('dismissal names the ids it removed, so the canvas can fly them out', () => {
  ensureGhostCards();
  const gone = dismissGhosts();
  assert.deepEqual([...gone].sort(), [...GHOST_IDS].sort());
  assert.equal(ghosts().length, 0);
  assert.deepEqual(dismissGhosts(), [], 'a second sweep has nothing to do');
});

test('dismissal is not undoable, and re-seeding will not undo it either', () => {
  ensureGhostCards();
  addItems([photo({ id: 'p1' })]);
  dismissGhosts();

  ensureGhostCards();
  assert.equal(ghosts().length, 0, 'the latch holds while the board has content');

  // The import that triggered the sweep is undone. The board is empty again -
  // and the hints still stay gone, which is the point of the latch.
  undo();
  assert.equal(board.items.some(i => i.id === 'p1'), false, 'the undo really ran');
  ensureGhostCards();
  assert.equal(ghosts().length, 0, 'undo does not bring the hints back');
});

test('a new board earns its hints again', () => {
  ensureGhostCards();
  dismissGhosts();
  fresh();
  ensureGhostCards();
  assert.equal(ghosts().length, 3, 'the latch travels with the board, not the session');
});

test('a board that arrives with content is dismissed before it is drawn', () => {
  fresh([photo()]);
  ensureGhostCards();
  assert.equal(ghosts().length, 0);
});

// ---------------------------------------------------------------------------
// They are not the user's, so the bin never holds one
// ---------------------------------------------------------------------------

test('deleting a hint by hand finishes it rather than filing it', () => {
  ensureGhostCards();
  const [first] = GHOST_IDS;
  removeItems([first]);
  assert.equal(board.items.some(i => i.id === first), false, 'it is gone from the board');
  assert.equal(board.trash.some(t => t.item.id === first), false, 'and not in the bin');
});

test('a mixed delete bins the real item and not the hint', () => {
  ensureGhostCards();
  addItems([photo({ id: 'p1' })]);
  removeItems(['p1', GHOST_IDS[0]]);
  assert.deepEqual(board.trash.map(t => t.item.id), ['p1']);
});

// ---------------------------------------------------------------------------
// Everything else about them is an ordinary card
// ---------------------------------------------------------------------------

test('hasContent ignores the two kinds of furniture and nothing else', () => {
  assert.equal(hasContent(), false, 'nothing at all');
  ensureTitleCard();
  ensureGhostCards();
  assert.equal(hasContent(), false, 'title card and hints');
  assert.equal(hasGhosts(), true);
  addItems([photo()]);
  assert.equal(hasContent(), true, 'one real item is content');
});

test('a hint leaves with the whimsy tier, like any other card', () => {
  // Not a title card, so it takes the tier's own feel rather than the chip that
  // falls to the bin. canvas/items.js flies out every id in a removed delta,
  // which is why canvas/ghosts.js asks for no animation of its own.
  assert.equal(exitKindFor('ghost', '0'), 'fall');
  assert.equal(exitKindFor('ghost', '1'), 'dissolve');
  assert.equal(exitKindFor('ghost', '2'), 'shatter');
});

test('a dismissed hint is dropped from the selection', () => {
  ensureGhostCards();
  selection.add(GHOST_IDS[0]);
  selection.add(TITLE_ID);
  dismissGhosts();
  assert.equal(selection.has(GHOST_IDS[0]), false, 'the hint is deselected');
  assert.equal(selection.has(TITLE_ID), true, 'and nothing else is touched');
});

test('hints are packed into the Mobile column like real cards', () => {
  ensureGhostCards();
  setBoardMode('mobile');
  for (const g of ghosts()) {
    assert.ok(Number.isFinite(g.x) && Number.isFinite(g.y), 'has a Mobile place');
  }
  const xs = new Set(ghosts().map(g => g.x));
  const ys = new Set(ghosts().map(g => g.y));
  assert.ok(xs.size > 1 || ys.size > 1, 'and they are not all stacked on one point');
});
