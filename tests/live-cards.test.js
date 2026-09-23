// What the cull and a rebuild must leave alone: a clip that is playing, and an
// embedded player. Removing a media element pauses it, removing an iframe
// destroys it, and a body replaced under either is the same act. No document
// here, so this reads the source of canvas/items.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { JS, read } from './helpers.js';

const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const items = code(read(join(JS, 'canvas/items.ts')));
const fn = name => {
  const at = items.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name}() is gone`);
  return items.slice(at, items.indexOf('\n}\n', at));
};

test('an embedded player is never detached by the cull', () => {
  // The detach pass skips what sounding() names. An iframe taken out of the
  // document is destroyed, so a pan away stopped the song and a pan back
  // loaded the player again from the start.
  assert.match(fn('sounding'), /querySelector\('iframe'\)/,
    'sounding() no longer counts an embedded player');
  assert.match(fn('sync'), /if \(sounding\(el\)\) continue;/,
    'the detach pass no longer skips a sounding card');
});

test('a rebuild keeps a sounding body unless what it plays has changed', () => {
  // Every 'item' event rebuilds: a rename, a tag, a poster or a title filled
  // in by the idle backfill. Each used to stop the clip or swap the player back
  // for its offer.
  const rebuild = fn('rebuild');
  const guard = rebuild.indexOf('if (sounding(body) && drawnSource.get(el) === sourceOf(item))');
  const replace = rebuild.indexOf('body.replaceChildren(');
  assert.ok(guard >= 0, 'rebuild() replaces a sounding body again');
  assert.ok(guard < replace, 'the guard comes after the body is already replaced');
  assert.match(rebuild.slice(guard, replace), /retitleContent\(body, item\)/,
    'a kept body no longer takes the new name');
  assert.match(fn('build'), /drawnSource\.set\(el, sourceOf\(item\)\)/,
    'build() no longer records what the body plays');
});

test('what a body plays is its asset and its address, nothing else', async () => {
  const { sourceOf } = await import('../web/assets/js/canvas/items.ts');
  const clip = { asset: { hash: 'a1' }, meta: { cover: 'p1', title: 'x' } };
  assert.equal(sourceOf(clip), sourceOf({ ...clip, name: 'renamed', meta: { tags: ['t'] } }));
  assert.notEqual(sourceOf(clip), sourceOf({ ...clip, asset: { hash: 'a2' } }));
  const link = { asset: null, meta: { url: 'https://open.spotify.com/track/a' } };
  assert.notEqual(sourceOf(link), sourceOf({ ...link, meta: { url: 'https://open.spotify.com/track/b' } }));
});
