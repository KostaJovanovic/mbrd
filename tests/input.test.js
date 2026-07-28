import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDoubleTap, needsSelectionBeforeMove, repeatsLongPressContextMenu,
  releasePointerSafely, resizeHandleAction, shortcutsSuppressed,
} from '../web/assets/js/canvas/input.js';

test('double taps match within the touch timing and distance windows', () => {
  const first = { x: 100, y: 200, at: 1_000 };

  assert.equal(isDoubleTap(first, { x: 120, y: 210, at: 1_320 }), true);
  assert.equal(isDoubleTap(first, { x: 100, y: 200, at: 1_351 }), false);
  assert.equal(isDoubleTap(first, { x: 129, y: 200, at: 1_200 }), false);
});

test('double taps reject missing or backwards samples', () => {
  assert.equal(isDoubleTap(null, { x: 0, y: 0, at: 1 }), false);
  assert.equal(isDoubleTap({ x: 0, y: 0, at: 2 }, { x: 0, y: 0, at: 1 }), false);
});

test('an item must already be selected before a drag may move it', () => {
  const selected = new Set(['picked']);
  assert.equal(needsSelectionBeforeMove(selected, 'picked'), false);
  assert.equal(needsSelectionBeforeMove(selected, 'resting'), true);
});

test('canvas shortcuts stand down when handled or an overlay owns the keyboard', () => {
  // Nothing in the way: the shortcut runs.
  assert.equal(shortcutsSuppressed(false, false), false);
  // Already handled - e.g. the context menu's capture listener took the arrow key.
  assert.equal(shortcutsSuppressed(true, false), true);
  // A modal dialog or the open menu owns the keyboard.
  assert.equal(shortcutsSuppressed(false, true), true);
});

test('a native context menu does not reopen a freshly opened touch menu', () => {
  const opened = { x: 100, y: 200, at: 1_000 };
  assert.equal(repeatsLongPressContextMenu(opened, { x: 108, y: 207, at: 1_700 }), true);
  assert.equal(repeatsLongPressContextMenu(opened, { x: 108, y: 207, at: 1_901 }), false);
  assert.equal(repeatsLongPressContextMenu(opened, { x: 130, y: 200, at: 1_100 }), false);
});

test('the southeast resize handle opens the item menu on a tap', () => {
  const start = { x: 100, y: 200 };
  assert.equal(resizeHandleAction('se', start, { x: 102, y: 201 }), 'wait');
  assert.equal(resizeHandleAction('se', start, { x: 102, y: 201 }, true), 'menu');
  assert.equal(resizeHandleAction('nw', start, { x: 102, y: 201 }, true), 'wait');
});

test('dragging the southeast resize handle still starts a resize', () => {
  const start = { x: 100, y: 200 };
  assert.equal(resizeHandleAction('se', start, { x: 103, y: 200 }), 'resize');
  assert.equal(resizeHandleAction('se', start, { x: 120, y: 230 }, true), 'resize');
});

test('a pointer invalidated during capture release is already released', () => {
  const stale = {
    hasPointerCapture: () => true,
    releasePointerCapture: () => {
      throw new DOMException('Invalid pointer id', 'NotFoundError');
    },
  };

  assert.equal(releasePointerSafely(stale, 7), false);
});

test('safe pointer release does not hide ordinary programming errors', () => {
  const broken = {
    hasPointerCapture: () => true,
    releasePointerCapture: () => {
      throw new Error('broken release implementation');
    },
  };

  assert.throws(() => releasePointerSafely(broken, 7), /broken release implementation/);
});
