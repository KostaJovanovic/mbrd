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
