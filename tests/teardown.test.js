// What a card lets go of when it is thrown away, and what culling must not
// touch. A media element frees its buffers when its source goes, not when
// its last reference does - a rule four other kinds of state also need: a
// frozen GIF's object URL, a transport's selection subscription, a model
// stage's size observer, and a card being *rebuilt* rather than removed.
// No document here, so this asserts that each release hook exists and that
// the one door calls all of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { JS, read } from './helpers.js';

const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const src = rel => code(read(join(JS, rel)));

test('discard() calls every release hook there is', () => {
  const items = src('canvas/items.ts');
  const body = items.slice(items.indexOf('function discard('), items.indexOf('function disposable('));
  for (const hook of ['releaseCardContent', 'releaseStills', 'releaseTransports', 'releaseModels']) {
    assert.ok(new RegExp(`${hook}\\(`).test(body + items),
      `discard() no longer reaches ${hook}()`);
  }
});

test('a rebuild tears its old body down the way a discard does', () => {
  // rebuild() replaces a card's whole body on a rename, Fit toggle, crop,
  // adjust or cover change, but used to call only releasePlayers(). The old
  // <img> was then dropped by replaceChildren() with its src intact, and a
  // 4000x3000 photo's decode lived until the next GC, once per rename.
  const items = src('canvas/items.ts');
  const rebuild = items.slice(items.indexOf('function rebuild('));
  assert.match(rebuild.slice(0, 900), /releaseCardContent\(body\);/,
    'rebuild() is back to releasing only the players');
  assert.ok(!/^\s*releasePlayers\(body\);/m.test(rebuild.slice(0, 900)),
    'rebuild() still tears down by hand instead of through releaseCardContent()');
});

test('the drawer lets its cards go through the same door the board does', () => {
  // ui/drawer.ts drops cards scrolled out of the window, the same act as
  // culling one off the board - so it is the same exported function, not
  // four lines copied. A copy would keep working for years while quietly
  // missing whatever the next renderer starts holding on to.
  const items = src('canvas/items.ts');
  assert.match(items, /export function releaseCardContent\(/,
    'releaseCardContent() is private again - the drawer cannot reach it');
  const drawer = src('ui/drawer.ts');
  assert.match(drawer, /releaseCardContent\(/,
    'the drawer no longer hands its cards back through canvas/items.ts');
});

test('culling leaves a card that has been lifted out of the world layer alone', () => {
  // The note composer moves the live .item into #compose-mount, still
  // isConnected but nowhere near the padded rect - a sync while the dialog
  // was up used to discard it and drop it from the node map, blanking the
  // sheet mid-edit and building a second card for the same item on close.
  const items = src('canvas/items.ts');
  assert.match(items, /if \(el\.parentElement !== worldEl\) continue;/,
    'the detach pass no longer checks that the node is still in the world layer');
});

test('the title card is found by its id, not by walking the board', () => {
  // Runs on every full sync - every zoom-out frame - and `find` walked the
  // whole board to reach a card whose id is a constant.
  const items = src('canvas/items.ts');
  assert.ok(!/board\.items\.find\(i => i\.type === 'title'\)/.test(items),
    'sync() is back to scanning the board for the title card every frame');
  assert.match(items, /byId\(TITLE_ID\)/, 'the title card is no longer looked up by id');
});

test('resetItems() clears the id latches as well as the node maps', () => {
  // Each latch is "which card wears this mark", compared before it is
  // written - with the pointer resting on a card during load,
  // setHoverGroup(id) returned early on `id === lastHoverId` and the
  // rebuilt card never got its is-hover.
  const items = src('canvas/items.ts');
  const reset = items.slice(items.indexOf('export function resetItems()'));
  for (const latch of ['lastHoverId', 'hoverGroup', 'stickTargetId', 'pickedId', 'aimedId']) {
    assert.ok(reset.slice(0, 700).includes(latch), `resetItems() leaves ${latch} behind`);
  }
});

test('a route is owed again when any card moves, not only its own two ends', () => {
  // The seg cache is keyed on the pair's own boxes, so A-B routed around C
  // stayed routed around C after C was dragged away, and stayed drawn
  // *through* C after C was dragged onto the line.
  const web = src('canvas/web.ts');
  assert.match(web, /function fieldSig\(where: Map<string, Card>\): number/,
    'the obstacle-field signature is gone');
  assert.match(web, /if \(field !== lastField\) \{/,
    'build() no longer invalidates the stored routes when the field moves');
});

test('the mark cannot point at a line that is fading out', () => {
  // lastSeg keeps a removed connection for the whole of its fade, so
  // nearestSeg could hand back a pair no longer on the board, and
  // deleteActiveConnection would find it absent and re-create it.
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
  // n = 0 slipped past the DENSE_LIMIT guard, made k = min(14, -1), and
  // threw a RangeError out of new Float64Array(-1).
  assert.match(src('web-graph.ts'), /if \(!n\) return \[\];/,
    'threads([]) throws again');
});
