// Folding one board into another.
//
// planMerge() is pure and takes no board, which is the whole reason it is
// testable at all - and the reason it had to be. Every failure mode in a merge
// is silent: a collision handled wrongly does not throw, it produces a board
// where a note that arrived from somebody else's file is stuck to one of *your*
// photographs, and moves with it, and looks entirely normal. So the cases below
// are all about references surviving a rename.

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
    { connections: [['photo', 'note']], tour: ['photo'], audioOrder: ['photo'] },
  ), ['photo']);

  const [photo, note] = plan.items;
  assert.notEqual(photo.id, 'photo', 'the collision is renamed');
  assert.equal(note.id, 'note', 'a name nobody else holds is kept');
  // The four references, all pointing at the new id rather than at the string
  // that now belongs to a card on the host board.
  assert.equal(note.meta.stuckTo, photo.id);
  assert.deepEqual(plan.connections, [[photo.id, note.id]]);
  assert.deepEqual(plan.tour, [photo.id]);
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
  // The case that would otherwise resolve against a host card by accident: the
  // incoming note names a host id, so leaving it would pin the arrival to one of
  // the boards it was merged into. An absent stuckTo sends the question back to
  // the measurement, which is what sticky.ts already does for a loose note.
  const plan = planMerge(incoming(
    [{ id: 'note', type: 'note', meta: { stuckTo: 'someone-elses-card' } }],
    { connections: [['note', 'someone-elses-card']], tour: ['someone-elses-card'] },
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
  // Hand-written .mbrd files exist and this is the shape a broken one takes.
  // The rename must keep it self-referential rather than pointing it at a
  // stranger; sticky.ts is what decides such a note is simply loose.
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
  // The composition is the thing being merged, so the gap between the two cards
  // is exactly what it was in the file. This is the assertion that would fail if
  // anybody ever "improved" the placement by running arrange() over the arrivals.
  assert.equal(b.x - a.x, 300, 'the block is translated, never re-laid-out');
  assert.equal(a.y, b.y);
  // And it is clear of the host card, which sits at x = 0 with a half-width of 50.
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
  // The id union the caller passes is the live board's *and* the bin's. A card
  // dragged back out of the trash comes back with the id it had, so an arrival
  // that took that string would collide at the moment of the restore - long
  // after the merge, with nothing to connect the two.
  const plan = planMerge(incoming([{ id: 'binned', type: 'note' }]), ['binned']);
  assert.notEqual(plan.items[0].id, 'binned');
});

test('content hashes are not ids and are never remapped', () => {
  // meta.cover names bytes in the asset store, which is exactly the thing two
  // boards are allowed to share - remapping it would break the picture.
  const hash = 'a'.repeat(64);
  const plan = planMerge(incoming([
    { id: 'track', type: 'audio', meta: { cover: hash } },
  ]), ['track']);
  assert.notEqual(plan.items[0].id, 'track', 'the id did collide');
  assert.equal(plan.items[0].meta.cover, hash, 'and the hash is untouched');
});
