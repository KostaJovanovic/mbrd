// The paper sheet's corner cursors, which are written down twice.
//
// canvas.css gives each grip its own diagonal so the corner reads right under
// the pointer; canvas/paper.ts repeats the same four values as GRIPS[].axis,
// because during a drag the pointer has left the grip and the cursor is held
// on :root instead. Two lists of the same fact, and a wrong one is invisible:
// the resize still works, it just points across the diagonal it is on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { join } from 'node:path';

import { GRIPS } from '../web/assets/js/canvas/paper.ts';
import { appCss, read, JS } from './helpers.js';

const css = appCss();

/** The cursor canvas.css gives one corner, e.g. 'nwse-resize' for nw. */
function cursorFor(id) {
  const rule = new RegExp(
    `\\.paper-grip\\[data-grip="${id}"\\][^{]*\\{([^}]*)\\}`,
  ).exec(css);
  assert.ok(rule, `canvas.css has no rule for the ${id} grip`);
  const cursor = /cursor:\s*([a-z-]+)/.exec(rule[1]);
  assert.ok(cursor, `the ${id} grip rule sets no cursor`);
  return cursor[1];
}

test('every corner agrees with the cursor its own rule gives it', () => {
  for (const g of GRIPS) {
    assert.equal(cursorFor(g.id), `${g.axis}-resize`,
      `GRIPS says ${g.id} is ${g.axis}, canvas.css draws it otherwise`);
  }
});

test('the two diagonals are used twice each, which is what a rectangle has', () => {
  const axes = GRIPS.map(g => g.axis).sort();
  assert.deepEqual(axes, ['nesw', 'nesw', 'nwse', 'nwse']);
});

test('the held cursor covers both axes, not just the default one', () => {
  // nwse is the bare .is-sizing-paper rule, so a missing attribute still
  // resizes; nesw has to be reached by the attribute paper.ts writes.
  assert.match(css, /:root\.is-sizing-paper\s*\*\s*\{\s*cursor:\s*nwse-resize/);
  assert.match(
    css,
    /:root\.is-sizing-paper\[data-sizing-axis="nesw"\]\s*\*\s*\{\s*cursor:\s*nesw-resize/,
  );
});

test('the attribute the CSS waits for is the one the module writes', () => {
  // `dataset.sizingAxis` and `data-sizing-axis` are the same attribute spelled
  // two ways, in two files, and a rename can land on one of them alone. The
  // failure is silent: the class still goes on, so the drag still works and
  // only the cursor stops following the corner.
  const src = read(join(JS, 'canvas', 'paper.ts'));
  assert.match(src, /dataset\.sizingAxis\s*=/, 'paper.ts no longer sets the axis');
  assert.match(src, /delete document\.documentElement\.dataset\.sizingAxis/,
    'the axis outlives the drag and the page keeps a resize cursor');
});
