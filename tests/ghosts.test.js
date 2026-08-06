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
  hasGhosts, GHOST_IDS, NOTFOUND_IDS, TITLE_ID, tapeFor, setSetting,
  mobileBoardWidth, mobileBoardTop,
} from '../web/assets/js/state.js';
import { latticeBox, CELL_GAP } from '../web/assets/js/geometry.js';
import { HINTS, hintFor, tapeStyle, STOPS, stopName, DIAL } from '../web/assets/js/canvas/ghosts.js';
import { exitKindFor } from '../web/assets/js/canvas/exit-anim.js';

const fresh = (items = []) => loadBoard({ title: 'T', items });
const photo = (props = {}) => ({ type: 'image', w: 200, h: 200, ...props });

const ghosts = () => board.items.filter(i => i.type === 'ghost');
// The hints that are pages. The dial is a card at every tier, so it has no tape.
const taped = () => ghosts().filter(i => i.meta?.hint !== DIAL);

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

test('an empty board earns its hints; a board with anything on it does not', () => {
  ensureGhostCards();
  assert.equal(ghosts().length, GHOST_IDS.length, 'a blank board opens with the full set');
  assert.deepEqual(ghosts().map(g => g.id), [...GHOST_IDS], 'in reading order');

  fresh([photo()]);
  ensureGhostCards();
  assert.equal(ghosts().length, 0, 'a board that already has content gets none');
});

test('the title card is furniture, not content, so it does not suppress the hints', () => {
  ensureTitleCard();
  assert.equal(hasContent(), false, 'a board with only its title card is still empty');
  ensureGhostCards();
  assert.equal(ghosts().length, GHOST_IDS.length);
});

test('seeding twice does not double the hints', () => {
  ensureGhostCards();
  ensureGhostCards();
  assert.equal(ghosts().length, GHOST_IDS.length);
});

test('every hint carries a key the copy knows a sentence for', () => {
  ensureGhostCards();
  for (const g of ghosts()) {
    assert.ok(g.meta.hint, 'the item carries its key');
    assert.ok(HINTS[g.meta.hint], `${g.meta.hint} has copy`);
    assert.ok(hintFor(g.meta.hint).title, 'and the copy has a title');
    assert.ok(hintFor(g.meta.hint).line, 'and a line');
  }
  assert.equal(new Set(ghosts().map(g => g.meta.hint)).size, ghosts().length,
    'each hint has a key of its own');
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
  assert.equal(ghosts().length, GHOST_IDS.length, 'the latch travels with the board, not the session');
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

// ---------------------------------------------------------------------------
// The dial
// ---------------------------------------------------------------------------

test('the card prints the same stop names the sidebar does', async () => {
  // The card borrows the sidebar's slider outright - same .field markup, same
  // CSS - and the three names under it have to be the sidebar's too. They are
  // duplicated rather than shared, because the panel's list lives in ui/ and
  // canvas/ may not reach into it, so this is the thing that holds the two
  // copies together. Including the full stop on "Harsh."
  const { SECTIONS } = await import('../web/assets/js/ui/settings-schema.js');
  const dial = SECTIONS.flatMap(s => s.controls || []).find(c => c.id === 'opt-whimsy');
  assert.ok(dial, 'the panel still has a whimsy dial');
  assert.deepEqual([...STOPS], dial.stops);
  assert.equal(+dial.min, 0);
  assert.equal(+dial.max, STOPS.length - 1, 'and one stop per position on it');
});

test('every level has a name to read out, and a bad one still does', () => {
  // The printed stops are hidden from the accessibility tree, so this is what a
  // screen reader hears instead of "1 of 2".
  assert.deepEqual(STOPS.map((_, i) => stopName(i)), [...STOPS]);
  assert.equal(stopName(7), STOPS[1], 'out of range falls back to the default tier');
});

// ---------------------------------------------------------------------------
// The tape
// ---------------------------------------------------------------------------

test('the dial is the one hint that is not taped down', () => {
  // It stays an ordinary card at every tier - a working control does not want
  // half a strip of tape across its track - and app.css keeps the rest of the
  // Softish treatment off it. The tape is the half that has to be refused at
  // minting, since it is rolled there rather than drawn from the tier.
  ensureGhostCards();
  const dial = board.items.find(i => i.meta?.hint === DIAL);
  assert.ok(dial, 'the dial card is one of the hints');
  assert.deepEqual(dial.meta.tape, [], 'and carries no tape');
});

test('every hint is taped down once or twice, never to the same edge twice', () => {
  ensureGhostCards();
  for (const g of taped()) {
    const tape = g.meta.tape;
    assert.ok(Array.isArray(tape), 'the placement travels in the item');
    assert.ok(tape.length === 1 || tape.length === 2, `one or two strips, got ${tape.length}`);
    assert.equal(new Set(tape.map(t => t.edge)).size, tape.length, 'one strip per edge');
    for (const t of tape) {
      assert.ok(['top', 'right', 'bottom', 'left'].includes(t.edge));
      // Well inside the corners, so a strip never hangs off one.
      assert.ok(t.pos >= 24 && t.pos <= 76, `pos ${t.pos} is off the edge`);
      assert.ok(Math.abs(t.rot) <= 9, `rot ${t.rot} is past a press of the thumb`);
      assert.ok(t.len >= 56 && t.len <= 98, `len ${t.len} is not a strip`);
    }
  }
});

test('the roll happens once, at minting, so culling cannot move the tape', () => {
  // The placement is item state, not a render-time decision: canvas/items.js
  // discards a culled card's node and rebuilds it, so anything rolled while
  // drawing would land somewhere new every time the board panned past.
  ensureGhostCards();
  const before = ghosts().map(g => JSON.stringify(g.meta.tape));
  ensureGhostCards();
  assert.deepEqual(ghosts().map(g => JSON.stringify(g.meta.tape)), before);
});

test('a pinned roll is reproducible, and both counts are reachable', () => {
  const pin = v => () => v;
  assert.equal(tapeFor(pin(0.9)).length, 1, 'high roll gives one strip');
  assert.equal(tapeFor(pin(0.1)).length, 2, 'low roll gives two');
  assert.deepEqual(tapeFor(pin(0.5)), tapeFor(pin(0.5)), 'same roll, same tape');
});

test('a placement becomes a point on the edge it straddles', () => {
  // Centred on that point by the stylesheet, so half the strip is off the card.
  assert.deepEqual(tapeStyle({ edge: 'top', pos: 30, rot: 5, len: 80 }),
    { x: '30%', y: '0%', rot: '5deg', len: '80px' });
  assert.deepEqual(tapeStyle({ edge: 'bottom', pos: 60, rot: -4, len: 70 }),
    { x: '60%', y: '100%', rot: '-4deg', len: '70px' });
  // The vertical edges add a quarter turn - a strip down the side runs with it.
  assert.deepEqual(tapeStyle({ edge: 'left', pos: 40, rot: 0, len: 60 }),
    { x: '0%', y: '40%', rot: '90deg', len: '60px' });
  assert.deepEqual(tapeStyle({ edge: 'right', pos: 50, rot: 3, len: 60 }),
    { x: '100%', y: '50%', rot: '93deg', len: '60px' });
});

// ---------------------------------------------------------------------------
// The lattice
// ---------------------------------------------------------------------------

test('a snapped board seeds its hints on the lattice', () => {
  // Harsh means snapping on Desktop, and a board saved there is snapped the
  // moment it loads - before anything has been dragged. Hints are pushed
  // straight onto board.items rather than going through addItems(), so nothing
  // else would lay them down: they arrived at their own coordinates on a board
  // where every other card sat flush in its cells.
  fresh();
  setSetting('snap', true);
  ensureGhostCards();
  const step = 64;
  for (const g of ghosts()) {
    assert.deepEqual(
      { x: g.x, y: g.y, w: g.w, h: g.h },
      latticeBox({ x: g.x, y: g.y, w: g.w, h: g.h }, step),
      `${g.meta.hint} is already where the lattice would put it`,
    );
  }
});

test('the hints are written in whole grid spaces, so snapping cannot move them', () => {
  // The stronger half of the same rule: the geometry in GHOSTS is *itself* on
  // the lattice, so a snapped board and an unsnapped one lay out identically
  // and the size a paragraph was fitted to is the size it gets. Sides come back
  // a seam short (geometry.js CELL_GAP) - that sliver is the join between two
  // neighbouring cells and is not a move.
  fresh();
  ensureGhostCards();
  const unsnapped = ghosts().map(g => ({ id: g.id, x: g.x, y: g.y, w: g.w, h: g.h }));
  const seam = 2 * 64 * CELL_GAP;
  for (const g of unsnapped) {
    const box = latticeBox(g, 64);
    assert.equal(box.x, g.x, `${g.id} keeps its x`);
    assert.equal(box.y, g.y, `${g.id} keeps its y`);
    assert.ok(Math.abs(box.w - (g.w - seam)) < 1e-9, `${g.id} keeps its width but the seam`);
    assert.ok(Math.abs(box.h - (g.h - seam)) < 1e-9, `${g.id} keeps its height but the seam`);
  }
});

test('the not-found cards are on the lattice too', () => {
  // The same rule, and the set that broke it: the big card's left edge was at
  // -416 and the small card's lower edge at -160, so a snapped board slid each
  // of them half a step and the arrangement the header describes - a 64-unit
  // channel, lower edges flush - was not the one on screen. Asserted rather than
  // described, because the header describing it is what let it through.
  fresh();
  ensureGhostCards({ notFound: true });
  const seam = 2 * 64 * CELL_GAP;
  assert.equal(ghosts().length, NOTFOUND_IDS.length, 'a not-found board opens with its own set');
  for (const g of ghosts()) {
    const box = latticeBox({ x: g.x, y: g.y, w: g.w, h: g.h }, 64);
    assert.equal(box.x, g.x, `${g.meta.hint} keeps its x`);
    assert.equal(box.y, g.y, `${g.meta.hint} keeps its y`);
    assert.ok(Math.abs(box.w - (g.w - seam)) < 1e-9, `${g.meta.hint} keeps its width but the seam`);
    assert.ok(Math.abs(box.h - (g.h - seam)) < 1e-9, `${g.meta.hint} keeps its height but the seam`);
  }
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

test('a board born on Mobile packs its hints into the column', () => {
  // A phone never switches modes - it opens in Mobile - and completeLayout()
  // only fills in the profile that is *not* live. So this is the one case
  // nothing else would have placed: seeded straight into the layout it is
  // already in, with a Desktop arrangement 900 units wide on a board of 512.
  fresh();
  setBoardMode('mobile');
  ensureGhostCards();
  const width = mobileBoardWidth();
  const half = width / 2;
  for (const g of ghosts()) {
    assert.ok(g.x - g.w / 2 >= -half && g.x + g.w / 2 <= half,
      `${g.meta.hint} is inside the Mobile frame`);
    // The dial takes the whole width; a hint takes half of it, so two sit side
    // by side. Both are measured against the seam the lattice leaves.
    const want = g.meta.hint === DIAL ? width : half;
    assert.ok(Math.abs(g.w - want) <= 2 * 64 * CELL_GAP + 1e-6,
      `${g.meta.hint} is ${Math.round(g.w)}, not the ${want} it asked for`);
  }
});

test('the dial leads the Mobile column and shares its row with nothing', () => {
  fresh();
  setBoardMode('mobile');
  ensureGhostCards();
  const top = g => g.y + g.h / 2;
  const dial = ghosts().find(g => g.meta.hint === DIAL);
  const hints = ghosts().filter(g => g.meta.hint !== DIAL);
  assert.ok(hints.every(h => top(h) <= dial.y - dial.h / 2),
    'every hint starts at or below the dial');
  assert.equal(Math.round(top(dial)), Math.round(mobileBoardTop() - 64 * CELL_GAP),
    'and the dial itself starts at the top of the board');
});
