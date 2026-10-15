// openModal() in ui/dialog.ts, the one way a <dialog> here opens and closes.
// It owns the backdrop click and the listeners' lifetime for ask(), link-props,
// export-options and the colour picker, so a leak here is a leak in all four:
// a listener that survives its box fires on the next box's buttons. The
// <dialog> is an EventTarget with the two methods the module calls, which is
// enough because the signal is the whole of the cleanup.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openModal } from '../web/assets/js/ui/dialog.ts';

/** A <dialog> as far as openModal() can tell: showModal(), and a close() that fires 'close'. */
class FakeDialog extends EventTarget {
  open = false;
  showModal() { this.open = true; }
  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event('close'));
  }
}

test('the box is open when the call returns, and the promise settles on close', async () => {
  const el = new FakeDialog();
  let settled = false;
  const done = openModal(el, () => {}, { quiet: true }).then(() => { settled = true; });
  assert.equal(el.open, true, 'a caller focusing after the call would focus a closed box');
  await Promise.resolve();
  assert.equal(settled, false);
  el.close();
  await done;
  assert.equal(settled, true);
});

test('every listener added with the signal is gone once the box closes', async () => {
  const el = new FakeDialog();
  const button = new EventTarget();
  let presses = 0;
  const done = openModal(el, signal => {
    button.addEventListener('click', () => { presses++; }, { signal });
  }, { quiet: true });
  button.dispatchEvent(new Event('click'));
  el.close();
  await done;
  button.dispatchEvent(new Event('click'));
  assert.equal(presses, 1, 'a closed box still answered its button');
});

test('a click on the backdrop closes, unless the box is holding', async () => {
  const el = new FakeDialog();
  let holding = true;
  const done = openModal(el, () => {}, { quiet: true, hold: () => holding });
  el.dispatchEvent(new Event('click'));
  assert.equal(el.open, true, 'a drag released past the square threw the colour away');
  holding = false;
  el.dispatchEvent(new Event('click'));
  await done;
  assert.equal(el.open, false);
});

test('close() handed to the box is the way out for its buttons', async () => {
  const el = new FakeDialog();
  const button = new EventTarget();
  const done = openModal(el, (signal, close) => {
    button.addEventListener('click', close, { signal });
  }, { quiet: true });
  button.dispatchEvent(new Event('click'));
  await done;
  assert.equal(el.open, false);
});
