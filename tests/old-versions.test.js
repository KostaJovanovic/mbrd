// Letting go of the bytes an Optimize left behind, without letting go of the
// history that names them. Two claims survive an optimise: the card's own
// meta.was, and the ledger, which keeps the card as it was on the before side
// of the step. discardOriginals() ends the first and replaceOldVersions() the
// second - by rewriting, not by deleting, so every step still draws.
//
// What must hold: no step is lost, nothing still names a freed file, and a
// step from before the optimise comes back with the *new* picture on it. The
// old alternative was deleting the timeline outright, which is what these
// tests exist to keep from creeping back.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, addItems, swapAssets, discardOriginals, replaceOldVersions,
  timelineSteps, serializeTimeline, timelineHashes, historyDepth,
} from '../web/assets/js/state.ts';
import { fresh } from './state-fixtures.js';

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const RAW = 'c'.repeat(64);
const THUMB = 'd'.repeat(64);

const pic = (props = {}) => ({
  type: 'image', w: 200, h: 200, name: 'kitchen.jpg', asset: { hash: OLD }, ...props,
});

/** Every hash the ledger still names, as a sorted list. */
const recorded = () => [...timelineHashes(serializeTimeline())].sort();

beforeEach(() => { fresh(); });

test('an optimise is a step of its own, under a label the strip can read', () => {
  // It always was one; it rendered as "Changed 4 cards" with the ordinary pen,
  // because KINDS in ui/timeline-view.ts keys off the label's first word and
  // had no 'Optimize'. Now it does, so this is the string holding the two
  // together: rename it in swapAssets() and the icon silently goes back to
  // being a pen.
  const [card] = addItems([pic()]);
  swapAssets([{ id: card.id, asset: NEW }]);
  const last = timelineSteps().at(-1);
  assert.equal(last.label, 'Optimize board');
  assert.equal(last.label.split(' ')[0], 'Optimize', 'the key KINDS looks up');
});

test('the steps stay, and stop naming the file that went', () => {
  const [card] = addItems([pic()]);
  swapAssets([{ id: card.id, asset: NEW }]);
  const steps = timelineSteps().length;
  assert.ok(recorded().includes(OLD), 'the before side still holds the original');

  const doomed = new Set(discardOriginals());
  assert.deepEqual([...doomed], [OLD], 'meta.was is what the card was holding');
  assert.equal(replaceOldVersions(doomed) > 0, true, 'the ledger is rewritten');

  assert.equal(timelineSteps().length, steps, 'no step is lost');
  assert.equal(recorded().includes(OLD), false, 'and none of them names the old file');
  assert.ok(recorded().includes(NEW), 'they name the picture the card has now');
});

test('the card keeps the picture it shows, and loses only the memo', () => {
  const [card] = addItems([pic()]);
  swapAssets([{ id: card.id, asset: NEW }]);
  replaceOldVersions(new Set(discardOriginals()));

  const live = board.items.find(it => it.id === card.id);
  assert.equal(live.asset.hash, NEW);
  assert.equal(live.meta.was, undefined, 'nothing is left pointing at the original');
});

test('a field the card no longer has is dropped, not left dangling', () => {
  // The .dng an Optimize threw away: the card has drawn the developed picture
  // since the day it arrived, so there is no current version to put in its
  // place. A step that kept naming it would name a file that is not there.
  const [card] = addItems([pic({ meta: { source: RAW, thumb: THUMB } })]);
  swapAssets([{ id: card.id, asset: NEW, dropSource: true }]);

  const doomed = new Set([RAW, ...discardOriginals()]);
  replaceOldVersions(doomed);

  const left = recorded();
  assert.equal(left.includes(RAW), false, 'the source is gone from every step');
  assert.equal(left.includes(OLD), false);
  assert.ok(left.includes(THUMB), 'a file nothing replaced is left exactly as it was');
});

test('the undo stack goes, because its closures know a board that is gone', () => {
  // Running one would put back a card whose picture has just been freed. The
  // ledger is the thing being kept here; undo is not, and dropStacks() is the
  // one door that ends the second without the first.
  const [card] = addItems([pic()]);
  swapAssets([{ id: card.id, asset: NEW }]);
  assert.ok(historyDepth().undo > 0);

  replaceOldVersions(new Set(discardOriginals()));
  assert.equal(historyDepth().undo, 0);
  assert.ok(timelineSteps().length > 0, 'and the timeline is still there');
});

test('nothing to let go of changes nothing', () => {
  const [card] = addItems([pic()]);
  swapAssets([{ id: card.id, asset: NEW }]);
  const before = recorded();
  assert.equal(replaceOldVersions(new Set()), 0);
  assert.deepEqual(recorded(), before);
  assert.ok(historyDepth().undo > 0, 'and the undo stack is left alone');
});
