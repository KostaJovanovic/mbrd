// Folding one board into another. planMerge() is pure and takes no board,
// which is why it's testable at all - every merge failure is silent: a
// mishandled collision doesn't throw, it produces a board where somebody
// else's note is stuck to your photograph and looks entirely normal. So
// these cases are about references surviving a rename.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { planMerge } = await import('../web/assets/js/merge.ts');
const { makeItem } = await import('../web/assets/js/board-model.ts');

/** An incoming board, with only the four fields planMerge() reads. */
const incoming = (items, extra = {}) => ({
  items: items.map(makeItem),
  connections: [],
  audioOrder: [],
  tour: [],
  ...extra,
});

/**
 * A tour written the short way: one stop per card. planMerge() receives a
 * board already through normalizeBoard(), so it sees `{ cards }` per stop
 * rather than a flat id list. The merge never cares about grouping, so this
 * says "one card per stop" once instead of at eight call sites.
 */
const tourOf = (...ids) => ids.map(id => ({ cards: [id] }));

/** A host card at a known spot, so placement can be asserted against it. */
const host = (id, x = 0, y = 0) => makeItem({ id, type: 'note', x, y, w: 100, h: 100 });

test('ids that do not collide are left exactly alone', () => {
  const plan = planMerge(incoming([{ id: 'a', type: 'note' }]), ['x', 'y']);
  assert.equal(plan.items[0].id, 'a');
});

test('a colliding id is renamed, and every reference to it follows', () => {
  const plan = planMerge(incoming(
    [
      { id: 'photo', type: 'image', w: 200, h: 200 },
      { id: 'note', type: 'note', meta: { stuckTo: 'photo' } },
    ],
    { connections: [['photo', 'note']], tour: tourOf('photo'), audioOrder: ['photo'] },
  ), ['photo']);

  const [photo, note] = plan.items;
  assert.notEqual(photo.id, 'photo', 'the collision is renamed');
  assert.equal(note.id, 'note', 'a name nobody else holds is kept');
  // The four references, all pointing at the new id, not the string that
  // now belongs to a card on the host board.
  assert.equal(note.meta.stuckTo, photo.id);
  assert.deepEqual(plan.connections, [[photo.id, note.id]]);
  assert.deepEqual(plan.tour, [{ cards: [photo.id] }]);
  assert.deepEqual(plan.audioOrder, [photo.id]);
});

test('a fence membership survives the rename too', () => {
  const plan = planMerge(incoming([
    { id: 'fence', type: 'fence', w: 400, h: 400 },
    { id: 'card', type: 'note', meta: { fence: 'fence' } },
  ]), ['fence']);
  const [fence, card] = plan.items;
  assert.notEqual(fence.id, 'fence');
  assert.equal(card.meta.fence, fence.id);
});

test('a reference to something the file does not carry is dropped, not kept', () => {
  // The incoming note names a host id, so leaving it would pin the arrival
  // to a board it was merged into by accident. An absent stuckTo sends the
  // question back to the measurement, as sticky.ts does for a loose note.
  const plan = planMerge(incoming(
    [{ id: 'note', type: 'note', meta: { stuckTo: 'someone-elses-card' } }],
    { connections: [['note', 'someone-elses-card']], tour: tourOf('someone-elses-card') },
  ), ['someone-elses-card']);

  assert.equal('stuckTo' in plan.items[0].meta, false, 'the dangling pin is dropped');
  assert.deepEqual(plan.connections, [], 'a pair with only one end here is not carried');
  assert.deepEqual(plan.tour, [], 'nor a stop naming a card that did not arrive');
});

test('connection meta rides along with a remapped pair', () => {
  const plan = planMerge(incoming(
    [{ id: 'a', type: 'note' }, { id: 'b', type: 'note' }],
    { connections: [['a', 'b', { label: 'because', color: 'accent' }]] },
  ), ['a', 'b']);
  const [a, b] = plan.items;
  assert.deepEqual(plan.connections, [[a.id, b.id, { label: 'because', color: 'accent' }]]);
});

test('a note stuck to itself is not made into a new kind of nonsense', () => {
  // Hand-written .mbrd files exist, and this is the shape a broken one
  // takes. The rename must keep it self-referential, not point it at a
  // stranger; sticky.ts decides such a note is simply loose.
  const plan = planMerge(incoming([
    { id: 'n', type: 'note', meta: { stuckTo: 'n' } },
  ]), ['n']);
  assert.equal(plan.items[0].meta.stuckTo, plan.items[0].id);
});

test('the arriving block keeps its own shape and lands beside the host', () => {
  const board = [host('h', 0, 0)];
  const plan = planMerge(incoming([
    { id: 'a', type: 'note', x: 0, y: 0, w: 100, h: 100 },
    { id: 'b', type: 'note', x: 300, y: 0, w: 100, h: 100 },
  ]), ['h'], board);

  const [a, b] = plan.items;
  // The composition is what's being merged, so the gap between the cards is
  // exactly what it was in the file - fails if arrange() ever "improves" it.
  assert.equal(b.x - a.x, 300, 'the block is translated, never re-laid-out');
  assert.equal(a.y, b.y);
  // Clear of the host card, which sits at x = 0 with a half-width of 50.
  assert.ok(a.x - 50 > 50, `the block starts clear of the host (a.x = ${a.x})`);
});

test('merging into an empty board leaves the arrivals where their file put them', () => {
  const plan = planMerge(incoming([
    { id: 'a', type: 'note', x: 700, y: -400, w: 100, h: 100 },
  ]), []);
  assert.equal(plan.items[0].x, 700);
  assert.equal(plan.items[0].y, -400);
});

test('the bin counts as taken, so a restore cannot collide later', () => {
  // The id union the caller passes is the live board's *and* the bin's. A
  // restored card comes back with its old id, so an arrival taking that
  // string would collide at restore time, long after the merge.
  const plan = planMerge(incoming([{ id: 'binned', type: 'note' }]), ['binned']);
  assert.notEqual(plan.items[0].id, 'binned');
});

test('content hashes are not ids and are never remapped', () => {
  // meta.cover names bytes in the asset store, which two boards are allowed
  // to share - remapping it would break the picture.
  const hash = 'a'.repeat(64);
  const plan = planMerge(incoming([
    { id: 'track', type: 'audio', meta: { cover: hash } },
  ]), ['track']);
  assert.notEqual(plan.items[0].id, 'track', 'the id did collide');
  assert.equal(plan.items[0].meta.cover, hash, 'and the hash is untouched');
});

test('a dangling reference does not latch onto a card the rename just created', () => {
  // The host owns `a`. The incoming file has an image `a` and a note whose
  // meta.stuckTo says `a~2` - a reference to nothing in that file.
  // dedupeIds() renames the image to `a~2`, and the guard used to ask
  // whether the *renamed* id was among the arrivals - it is, because the
  // rename just made it, silently pinning the note to a photo it never touched.
  const plan = planMerge(incoming([
    { id: 'a', type: 'image', w: 200, h: 200 },
    { id: 'note', type: 'note', meta: { stuckTo: 'a~2' } },
  ]), ['a']);

  const [photo, note] = plan.items;
  assert.equal(photo.id, 'a~2', 'the fixture depends on this being the rename');
  assert.equal(note.meta.stuckTo, undefined,
    'a reference the file never resolved must not resolve here');
});

test('a dangling fence, connection, tour stop and track are dropped the same way', () => {
  const plan = planMerge(incoming(
    [
      { id: 'a', type: 'image', w: 200, h: 200 },
      { id: 'note', type: 'note', meta: { fence: 'a~2' } },
    ],
    { connections: [['a~2', 'note']], tour: tourOf('a~2'), audioOrder: ['a~2'] },
  ), ['a']);

  const note = plan.items.find(i => i.id === 'note');
  assert.equal(note.meta.fence, undefined);
  assert.deepEqual(plan.connections, []);
  assert.deepEqual(plan.tour, []);
  assert.deepEqual(plan.audioOrder, []);
});
