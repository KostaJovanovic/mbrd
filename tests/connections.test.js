// Lines between cards: the list, and the one promise that makes it cheap.
//
// That promise is **dangling is tolerated, not prevented**. A connection whose
// item is not on the board is simply not drawn, which is why there is no
// bookkeeping in removeItems(), restoreItems() or either half of undo - and it
// is the thing that has to be asserted, because the cost of getting it wrong is
// a board that loses somebody's lines silently and only on the way back.
//
// The other half is the edges: the list is pruned exactly twice, on the way
// into a file and on the way out of one, so nothing accumulates on disk and
// nothing is lost while the app is running.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, byId, addItems, removeItems, restoreItems, undo, redo, loadBoard,
  serializeBoard, setBoardMode, toggleConnection, addConnections, areConnected,
  connectedTo, pairKey, MAX_CONNECTIONS, select, clearConnections,
  updateConnection, connectionMeta,
} from '../web/assets/js/state.ts';
import { createCommands } from '../web/assets/js/commands.ts';
import { fresh, note, photo, sticker } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

/** Two cards, joined. The setup nearly every case here starts from. */
function pair() {
  const [a, b] = addItems([photo(), photo()]);
  toggleConnection(a.id, b.id);
  return [a, b];
}

// ---------------------------------------------------------------------------
// Drawing one, and drawing it again
// ---------------------------------------------------------------------------

test('a pair is joined once, whichever way round it is asked', () => {
  const [a, b] = addItems([photo(), photo()]);
  assert.equal(toggleConnection(a.id, b.id), true, 'reports that it is joined now');
  assert.equal(areConnected(a.id, b.id), true);
  assert.equal(areConnected(b.id, a.id), true, 'a connection has two ends and no direction');
  assert.equal(board.connections.length, 1);
});

test('the same pair again parts them, which is how one is removed', () => {
  // The alternative was making connections selectable - hit-testing a path in
  // canvas/input.js and a selection model holding things that are not items -
  // which is a great deal of machinery for a delete key.
  const [a, b] = pair();
  assert.equal(toggleConnection(b.id, a.id), false, 'reports that they are parted');
  assert.equal(areConnected(a.id, b.id), false);
  assert.equal(board.connections.length, 0);
});

test('a card cannot be joined to itself', () => {
  const [a] = addItems([photo()]);
  assert.equal(toggleConnection(a.id, a.id), false);
  assert.equal(board.connections.length, 0);
});

test('drawing and removing are both one undoable step', () => {
  const [a, b] = addItems([photo(), photo()]);
  toggleConnection(a.id, b.id);
  undo();
  assert.equal(areConnected(a.id, b.id), false);
  redo();
  assert.equal(areConnected(a.id, b.id), true);

  toggleConnection(a.id, b.id);
  assert.equal(areConnected(a.id, b.id), false);
  undo();
  assert.equal(areConnected(a.id, b.id), true, 'undoing a removal puts the line back');
});

test('connectedTo names the other end, whichever end it was stored as', () => {
  const [a, b, c] = addItems([photo(), photo(), photo()]);
  toggleConnection(a.id, b.id);
  toggleConnection(c.id, a.id);
  assert.deepEqual(connectedTo(a.id).sort(), [b.id, c.id].sort());
  assert.deepEqual(connectedTo(b.id), [a.id]);
});

// ---------------------------------------------------------------------------
// Several at once - the generator's door
// ---------------------------------------------------------------------------

test('a batch is one undo entry and skips what is already there', () => {
  const [a, b, c] = addItems([photo(), photo(), photo()]);
  toggleConnection(a.id, b.id);
  const made = addConnections([[a.id, b.id], [b.id, c.id], [a.id, c.id]], 'Connect these');
  assert.equal(made, 2, 'the pair that was already joined is not counted or duplicated');
  assert.equal(board.connections.length, 3);

  undo();
  assert.equal(board.connections.length, 1, 'one Ctrl+Z takes back the whole batch');
  assert.equal(areConnected(a.id, b.id), true, 'and leaves the one that was there alone');
});

test('a batch carrying the same pair twice adds it once', () => {
  const [a, b] = addItems([photo(), photo()]);
  assert.equal(addConnections([[a.id, b.id], [b.id, a.id]]), 1);
});

test('a batch of nothing new is not a history entry at all', () => {
  // An entry that changed nothing is one of the user's undo steps spent saying
  // so. The next Ctrl+Z has to reach the last thing that actually happened.
  const [a, b] = pair();
  assert.equal(addConnections([[a.id, b.id]]), 0);
  undo();
  assert.equal(areConnected(a.id, b.id), false,
    'undo reached past the empty batch to the connection itself');
});

// ---------------------------------------------------------------------------
// Dangling: the promise
// ---------------------------------------------------------------------------

test('deleting an end leaves the connection alone, and undo brings both back', () => {
  // The whole reason there is no bookkeeping in removeItems(). The item comes
  // back and its lines come back with it, because they never left.
  const [a, b] = pair();
  removeItems([b.id]);
  assert.equal(board.connections.length, 1, 'the pair is kept while the card is in the bin');
  assert.equal(byId(b.id), undefined);

  undo();
  assert.ok(byId(b.id), 'the card is back');
  assert.equal(areConnected(a.id, b.id), true, 'and so is its line');
});

test('a card restored from the bin comes back joined', () => {
  const [a, b] = pair();
  removeItems([b.id]);
  restoreItems([b.id]);
  assert.equal(areConnected(a.id, b.id), true);
});

// ---------------------------------------------------------------------------
// The edges: into a file and out of one
// ---------------------------------------------------------------------------

test('a connection to a binned card is saved, because restoring has to work', () => {
  const [a, b] = pair();
  removeItems([b.id]);
  const out = serializeBoard();
  assert.equal(out.connections.length, 1);
  assert.deepEqual(out.connections[0].map(id => id === a.id || id === b.id), [true, true]);
});

test('a connection to a card that is gone for good is collected on the way out', () => {
  const [a, b] = pair();
  // Straight off the board and out of the bin, which is what a purge leaves.
  removeItems([b.id]);
  board.trash = [];
  assert.equal(board.connections.length, 1, 'still there while the app is running');
  assert.deepEqual(serializeBoard().connections, [], 'and collected at the file boundary');
  assert.ok(a);
});

test('connections round-trip through a file', () => {
  const [a, b] = pair();
  const written = JSON.parse(JSON.stringify(serializeBoard()));
  loadBoard(written);
  assert.equal(areConnected(a.id, b.id), true);
  assert.equal(board.connections.length, 1);
});

test('a hint card can never carry one into a file', () => {
  // Ghosts are stripped by serializeBoard(), so a pair naming one would dangle
  // in every reader that opened the file. Nothing in the app can draw such a
  // pair - the web layer does not node a ghost - but a hand-made board could.
  fresh([{ id: 'g', type: 'ghost', w: 100, h: 100 }, photo({ id: 'p' })]);
  // loadBoard drops incoming ghosts outright, so the pair is pruned on the way
  // in as well; assert the way out, which is the boundary that matters.
  assert.deepEqual(serializeBoard().connections, []);
});

test('a sticker cannot be an end, on the way in or the way out', () => {
  // The tap path used to write these and nothing ever drew them: centres() in
  // canvas/web.js filters its ends through isJoinEnd(), so a pair naming a
  // sticker is skipped every frame, in silence, and survives a save. Boards
  // written before the tool checked can already carry one, which is why both
  // boundaries prune rather than just the tool.
  loadBoard({
    title: 'T',
    items: [photo({ id: 'p' }), sticker({ id: 's' }), photo({ id: 'q' })],
    connections: [['p', 's'], ['p', 'q']],
  });
  assert.equal(areConnected('p', 's'), false, 'dropped on the way in');
  assert.equal(areConnected('p', 'q'), true, 'and the real pair is untouched');
  // The way out as well, for a pair that got into the live board some other way.
  board.connections.push(['p', 's']);
  assert.deepEqual(serializeBoard().connections, [['p', 'q']]);
});

test('a stuck note keeps its lines', () => {
  // The trap in the fix above. The draw path refuses riders too, but a rider is
  // a note that happens to be stuck to something *right now* - unstick it and
  // the line is drawable again. Pruning on that would delete real connections
  // the first time somebody opened a board with a stuck note on it, so the
  // prune is isJoinEnd() alone, which is a property of the type and permanent.
  const [host] = addItems([photo({ id: 'h' })]);
  const [n] = addItems([note({ id: 'n', x: host.x, y: host.y })]);
  toggleConnection(n.id, host.id);
  const written = JSON.parse(JSON.stringify(serializeBoard()));
  loadBoard(written);
  assert.equal(areConnected('n', 'h'), true);
});

// ---------------------------------------------------------------------------
// What a file is allowed to say
// ---------------------------------------------------------------------------

test('a loaded board keeps only pairs it can mean', () => {
  fresh();
  loadBoard({
    title: 'T',
    items: [photo({ id: 'a' }), photo({ id: 'b' }), note({ id: 'c' })],
    connections: [
      ['a', 'b'],          // good
      ['b', 'a'],          // the same one, the other way round
      ['a', 'a'],          // a card joined to itself
      ['a', 'ghost'],      // an id that is on no card
      ['a'],               // not a pair
      'ab',                // not an array
      [null, 'b'],         // not ids
      ['b', 'c'],          // good
    ],
  });
  assert.equal(board.connections.length, 2);
  assert.equal(areConnected('a', 'b'), true);
  assert.equal(areConnected('b', 'c'), true);
});

test('connections that are not a list at all leave the board with none', () => {
  for (const raw of [undefined, null, 'nope', 42, { a: 'b' }]) {
    loadBoard({ title: 'T', items: [photo({ id: 'a' })], connections: raw });
    assert.deepEqual(board.connections, [], `${JSON.stringify(raw)} should load as none`);
  }
});

test('a file cannot declare more connections than a board may hold', () => {
  // JSON is cheap and every entry costs a route to work out and a subpath to
  // draw. The cap is what keeps a hand-written file from being a denial of
  // service - see AUD-07 and MAX_CONNECTIONS.
  const items = Array.from({ length: 120 }, (_, i) => photo({ id: 'i' + i }));
  const many = [];
  for (let i = 0; i < 120; i++) {
    for (let j = i + 1; j < 120; j++) many.push(['i' + i, 'i' + j]);
  }
  assert.ok(many.length > MAX_CONNECTIONS, 'the fixture is bigger than the cap');
  loadBoard({ title: 'T', items, connections: many });
  assert.equal(board.connections.length, MAX_CONNECTIONS);
});

test('the app will not draw past the cap either', () => {
  const items = Array.from({ length: 2, }, (_, i) => photo({ id: 'x' + i }));
  loadBoard({ title: 'T', items });
  // Fill to the brim by hand - going through the tool 2000 times is a test that
  // measures node's speed rather than this behaviour.
  board.connections = Array.from({ length: MAX_CONNECTIONS }, (_, i) => ['p' + i, 'q' + i]);
  assert.equal(toggleConnection('x0', 'x1'), false, 'refused rather than silently dropped');
  assert.equal(board.connections.length, MAX_CONNECTIONS);
});

// ---------------------------------------------------------------------------
// Join these for me
//
// The spanning tree that used to *be* the web, run once on demand and turned
// into ordinary stored connections. Driven through the command surface rather
// than by calling web-graph.js directly, because what is being checked is the
// wiring: that what the generator produces lands on the board as real pairs
// somebody can then remove one at a time.
// ---------------------------------------------------------------------------

/** The command surface, with the two things it is normally handed stubbed. */
const commands = () => createCommands(
  { toWorld: () => ({ x: 0, y: 0 }), left: 0, top: 0, cx: 0, cy: 0 },
  { resetAppearance() {}, setWhimsy() {} });

test('the generator joins a board into one connected piece', () => {
  const items = [
    photo({ id: 'a', x: 0, y: 0 }), photo({ id: 'b', x: 300, y: 0 }),
    photo({ id: 'c', x: 300, y: 300 }), photo({ id: 'd', x: 0, y: 300 }),
  ];
  fresh(items);
  commands().connectSelection();
  // A spanning tree over n points has at least n-1 edges, and the second pass
  // only adds to it. One connected piece is the tree's whole job.
  assert.ok(board.connections.length >= 3,
    `expected a spanning tree over four cards, got ${board.connections.length}`);
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.ok(connectedTo(id).length > 0, `${id} was left on its own`);
  }
});

test('a board saved before connections existed is not left hiding them', () => {
  // `settings.web` defaults to on now, but absence of the key is the only case
  // that default reaches - and every board saved by an earlier build carries an
  // explicit false, because that was the old default. Without the migration,
  // joining two cards on an existing board draws a line and shows nothing, with
  // no way to guess why from the screen.
  loadBoard({
    title: 'T', settings: { web: false },
    items: [photo({ id: 'a', x: 0, y: 0 }), photo({ id: 'b', x: 300, y: 0 })],
  });
  assert.equal(board.settings.web, false, 'the fixture is an old board');
  commands().connectSelection();
  assert.equal(board.settings.web, true, 'asking for lines turns the switch on');
  assert.equal(areConnected('a', 'b'), true);
});

test('the generator works over the selection when there is one', () => {
  fresh([
    photo({ id: 'a', x: 0, y: 0 }), photo({ id: 'b', x: 200, y: 0 }),
    photo({ id: 'c', x: 4000, y: 4000 }),
  ]);
  select(['a', 'b']);
  commands().connectSelection();
  assert.equal(connectedTo('c').length, 0, 'a card outside the selection is left alone');
  assert.equal(areConnected('a', 'b'), true);
});

test('the generator leaves furniture out', () => {
  // A hint relates to nothing - it is talking to the person, not to the board -
  // and the title card is the board's name.
  fresh([
    photo({ id: 'a', x: 0, y: 0 }), photo({ id: 'b', x: 300, y: 0 }),
    { id: 'g', type: 'ghost', x: 150, y: 300, w: 100, h: 100 },
    { id: '__title__', type: 'title', x: 150, y: -300, w: 100, h: 100 },
  ]);
  commands().connectSelection();
  assert.equal(connectedTo('g').length, 0);
  assert.equal(connectedTo('__title__').length, 0);
  assert.equal(areConnected('a', 'b'), true);
});

test('what the generator made can be taken apart one line at a time', () => {
  // The whole point of it producing real connections rather than an effect: the
  // result is indistinguishable from lines drawn by hand, including being
  // removable by drawing over one.
  fresh([photo({ id: 'a', x: 0, y: 0 }), photo({ id: 'b', x: 300, y: 0 })]);
  commands().connectSelection();
  assert.equal(areConnected('a', 'b'), true);
  toggleConnection('a', 'b');
  assert.equal(areConnected('a', 'b'), false);
});

test('running it twice adds nothing the second time', () => {
  fresh([
    photo({ id: 'a', x: 0, y: 0 }), photo({ id: 'b', x: 300, y: 0 }),
    photo({ id: 'c', x: 300, y: 300 }),
  ]);
  const cmds = commands();
  cmds.connectSelection();
  const first = board.connections.length;
  cmds.connectSelection();
  assert.equal(board.connections.length, first, 'the same tree is the same lines');
});

// ---------------------------------------------------------------------------
// The broom
// ---------------------------------------------------------------------------

test('every line comes off in one undoable step', () => {
  const [a, b, c] = addItems([photo(), photo(), photo()]);
  addConnections([[a.id, b.id], [b.id, c.id], [a.id, c.id]]);
  assert.equal(clearConnections(), 3, 'it reports what it took');
  assert.deepEqual(board.connections, []);

  undo();
  assert.equal(board.connections.length, 3, 'one Ctrl+Z gives the board back');
  redo();
  assert.deepEqual(board.connections, []);
});

test('clearing an already-clear board is not a history entry', () => {
  const [a, b] = pair();
  assert.equal(clearConnections(), 1, 'the first one takes the line');
  assert.equal(clearConnections(), 0, 'and the second has nothing to take');
  undo();
  assert.equal(areConnected(a.id, b.id), true,
    'undo reached the clear that did something, not an empty one stacked on top');
});

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

test('the pair key is the same whichever way round it is built', () => {
  assert.equal(pairKey('a', 'b'), pairKey('b', 'a'));
  assert.notEqual(pairKey('a', 'b'), pairKey('a', 'c'));
  // The separator cannot occur in an id, so two ids can share one string
  // without `ab` + `c` colliding with `a` + `bc`.
  assert.notEqual(pairKey('ab', 'c'), pairKey('a', 'bc'));
});

// ---------------------------------------------------------------------------
// How a line is drawn
//
// The optional third element - `[a, b, {dir, style, color, weight, label}]`.
// Two properties of it are load-bearing rather than cosmetic, and both are here:
// a value outside the known list is dropped rather than stored, because this
// object arrives out of somebody else's file and every one of these names ends
// up in a class or a marker reference; and a setting at its default is *not*
// written, which is what keeps an ordinary board's connections two-element
// arrays and is why the whole thing owed no version bump.
// ---------------------------------------------------------------------------

test('colour and weight ride in the third element and survive a save', () => {
  const [ca, cb] = pair().map(it => it.id);
  updateConnection(ca, cb, { color: 'leaf', weight: 'bold' });
  assert.deepEqual(connectionMeta(ca, cb), { color: 'leaf', weight: 'bold' });

  const file = serializeBoard();
  loadBoard(file);
  assert.deepEqual(connectionMeta(ca, cb), { color: 'leaf', weight: 'bold' });
});

test('a colour or weight nobody has heard of is dropped, not stored', () => {
  const [ca, cb] = pair().map(it => it.id);
  updateConnection(ca, cb, { color: 'url(https://example.com/x.png)', weight: '9999' });
  assert.equal(connectionMeta(ca, cb), null);
  // And the pair stays a bare pair, which is the shape an older reader wants.
  assert.equal(board.connections[0].length, 2);
});

test('a setting put back to its default leaves no third element behind', () => {
  const [ca, cb] = pair().map(it => it.id);
  updateConnection(ca, cb, { color: 'danger' });
  assert.equal(board.connections[0].length, 3);
  updateConnection(ca, cb, { color: 'line' });
  assert.equal(connectionMeta(ca, cb), null);
  assert.equal(board.connections[0].length, 2);
});
