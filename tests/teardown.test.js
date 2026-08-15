// What a card lets go of when it is thrown away, and what culling must not
// touch.
//
// discard() argues at length that "the media element frees its buffers when its
// source goes, not when the last reference to it does", and four other kinds of
// state turned out to want the same sentence: a frozen GIF's object URL, a
// transport's selection subscription, a model stage's size observer, and the
// contents of a card being *rebuilt* rather than removed. This file holds the
// list together - the shape of a teardown cannot be run here, so what is
// asserted is that each hook exists and that the one door calls all of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { JS, read } from './helpers.js';

const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const src = rel => code(read(join(JS, rel)));

test('discard() calls every release hook there is', () => {
  const items = src('canvas/items.ts');
  const body = items.slice(items.indexOf('function discard('), items.indexOf('function disposable('));
  for (const hook of ['releaseContent', 'releaseStills', 'releaseTransports', 'releaseModels']) {
    assert.ok(new RegExp(`${hook}\\(`).test(body + items),
      `discard() no longer reaches ${hook}()`);
  }
});

test('a rebuild tears its old body down the way a discard does', () => {
  // rebuild() replaces a card's whole body on a rename, a Fit toggle, a crop,
  // an adjust or a cover change - every one of which arrives as an 'item' emit
  // - and called releasePlayers() and nothing else. So the old <img> was
  // dropped by replaceChildren() with its src intact, and a 4000x3000
  // photograph's decode lived until the next GC, once per rename.
  const items = src('canvas/items.ts');
  const rebuild = items.slice(items.indexOf('function rebuild('));
  assert.match(rebuild.slice(0, 900), /releaseContent\(body\);/,
    'rebuild() is back to releasing only the players');
  assert.ok(!/^\s*releasePlayers\(body\);/m.test(rebuild.slice(0, 900)),
    'rebuild() still tears down by hand instead of through releaseContent()');
});

test('culling leaves a card that has been lifted out of the world layer alone', () => {
  // The note composer moves the live .item into #compose-mount, where it is
  // still isConnected and nowhere near the padded rect - so any sync while the
  // dialog was up discarded it and dropped it from the node map: the sheet
  // blanked mid-edit, and on close the card was appended back into #world as an
  // orphan the map no longer knew about, so the next sync built a second card
  // for the same item. resnap() has always guarded on this same test.
  const items = src('canvas/items.ts');
  assert.match(items, /if \(el\.parentElement !== worldEl\) continue;/,
    'the detach pass no longer checks that the node is still in the world layer');
});

test('the title card is found by its id, not by walking the board', () => {
  // This runs on every full sync - every frame of a zoom-out - and `find`
  // walked the whole board to reach a card whose id is a constant.
  const items = src('canvas/items.ts');
  assert.ok(!/board\.items\.find\(i => i\.type === 'title'\)/.test(items),
    'sync() is back to scanning the board for the title card every frame');
  assert.match(items, /byId\(TITLE_ID\)/, 'the title card is no longer looked up by id');
});

test('resetItems() clears the id latches as well as the node maps', () => {
  // Each is "which card is wearing this mark", and each is compared before it
  // is written - so with the pointer resting on a card while a board loads,
  // setHoverGroup(id) returned early on `id === lastHoverId` and the rebuilt
  // card never got its is-hover.
  const items = src('canvas/items.ts');
  const reset = items.slice(items.indexOf('export function resetItems()'));
  for (const latch of ['lastHoverId', 'hoverGroup', 'stickTargetId', 'pickedId', 'aimedId']) {
    assert.ok(reset.slice(0, 700).includes(latch), `resetItems() leaves ${latch} behind`);
  }
});

test('a route is owed again when any card moves, not only its own two ends', () => {
  // The seg cache is keyed on the pair's own boxes, so A-B routed around C
  // stayed routed around C after C was dragged away, and stayed drawn *through*
  // C after C was dragged onto the line - contradicting web-route.ts's own
  // "nothing is cached... nothing to go stale".
  const web = src('canvas/web.ts');
  assert.match(web, /function fieldSig\(where: Map<string, Card>\): number/,
    'the obstacle-field signature is gone');
  assert.match(web, /if \(field !== lastField\) \{/,
    'build() no longer invalidates the stored routes when the field moves');
});

test('the mark cannot point at a line that is fading out', () => {
  // lastSeg keeps a removed connection for the whole of its fade, so nearestSeg
  // could hand back a pair no longer on the board - and deleteActiveConnection
  // then ran toggleConnection() on it, found it absent, and re-created it.
  const web = src('canvas/web.ts');
  const near = web.slice(web.indexOf('function nearestSeg('));
  assert.match(near.slice(0, 700), /if \(!settled\.has\(key\)\) continue;/,
    'nearestSeg() walks fading segments again');
});

test('release() takes the mark, the hover and the memoised lean with it', () => {
  const web = src('canvas/web.ts');
  const release = web.slice(web.indexOf('function release()'), web.indexOf('function reshape()'));
  assert.match(release, /activeMoved\?\.\(\);/,
    'release() drops the mark without telling ui/conn-chip.ts');
  assert.match(release, /hoveredKey = null;/, 'release() leaves the hover key standing');
  assert.match(release, /over-connection/, 'release() leaves the connection cursor on');
  assert.match(release, /leanDeg = null;/,
    'release() keeps a lean memoised from the previous board');
});

test('threads() answers nothing for nothing', () => {
  // n = 0 slipped past the DENSE_LIMIT guard, made k = min(14, -1) and threw a
  // RangeError out of new Float64Array(-1).
  assert.match(src('web-graph.ts'), /if \(!n\) return \[\];/,
    'threads([]) throws again');
});
