// The swatch: a colour, the number for it, and the promise that a type
// nobody has heard of is still an item. `swatch` is the first item type
// added since research/docs/mbrd-format.md was written, so it is the first real test
// of that spec's promise for an unknown `type` - shown as a plain card and
// written back untouched, not dropped. No DOM, so only the model, the round
// trip and the one mutation are asserted, not the renderer.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, byId, addItems, undo, redo, serializeBoard, setSwatchHex, setBoardMode,
} from '../web/assets/js/state.ts';
import {
  swatchHex, SWATCH_DEFAULT, defaultSize, hasRenderer,
} from '../web/assets/js/canvas/renderers.ts';
import { fresh } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

const swatch = (props = {}) => ({
  type: 'swatch', w: 128, h: 148, name: '#AABBCC', meta: { hex: '#aabbcc' }, ...props,
});

// ---------------------------------------------------------------------------
// The colour, held to what it has to be
// ---------------------------------------------------------------------------

test('a swatch colour is six lowercase hex digits or the default', () => {
  // Not a preference: `<input type="color">` refuses anything else, and the
  // stylesheet interpolates the value straight into a custom property.
  assert.equal(swatchHex('#AABBCC'), '#aabbcc', 'case is normalised, not rejected');
  assert.equal(swatchHex('  #aabbcc  '), '#aabbcc');
  assert.equal(swatchHex('#f00'), '#ff0000', 'the short form is folded out, not refused');
  assert.equal(swatchHex('#ABC'), '#aabbcc');
});

test('anything that is not a colour falls back rather than reaching the card', () => {
  // All of these can arrive: `meta` is open and a .mbrd may not be this
  // app's own. A named colour is the interesting case - valid CSS, still
  // useless here since the picker cannot show it.
  for (const bad of ['red', 'rgb(1,2,3)', '#gggggg', '#12345', 'aabbcc', '', null, undefined, 42, {}]) {
    assert.equal(swatchHex(bad), SWATCH_DEFAULT, `${JSON.stringify(bad)} should fall back`);
  }
});

test('the default is a grey, which is the app declining to pick a colour', () => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(SWATCH_DEFAULT.slice(i, i + 2), 16));
  assert.equal(r, g);
  assert.equal(g, b, `${SWATCH_DEFAULT} should be neutral - see SWATCH_DEFAULT`);
});

// ---------------------------------------------------------------------------
// The type
// ---------------------------------------------------------------------------

test('a swatch has a renderer and a box sized for a colour and a number', () => {
  assert.ok(hasRenderer('swatch'));
  const { w, h } = defaultSize('swatch');
  assert.ok(h > w, `the hex line makes it taller than it is wide, got ${w}x${h}`);
  assert.ok(w > 48, `a swatch starts below the resize floor at ${w}`);
  assert.ok(w < defaultSize('image').w, 'a swatch should not outweigh a photo');
});

test('a swatch survives serialize and reload with its colour and its name', () => {
  addItems([swatch()]);
  const written = serializeBoard();
  const out = written.items.find(i => i.type === 'swatch');
  assert.ok(out, 'the swatch reached the file');
  assert.equal(out.meta.hex, '#aabbcc');
  assert.equal(out.name, '#AABBCC');
  assert.equal(out.asset, null, 'a swatch has no bytes behind it');
});

// ---------------------------------------------------------------------------
// The promise that made adding it safe
// ---------------------------------------------------------------------------

test('a type this build has never heard of loads, keeps its meta and is written back', () => {
  // research/docs/mbrd-format.md's claim, as a test - an older build meeting a swatch
  // is this case exactly: carried, not dropped, unknown meta included.
  fresh([{ type: 'sculpture', w: 200, h: 200, name: 'thing', meta: { chisel: 'fine' } }]);
  const it = board.items.find(i => i.type === 'sculpture');
  assert.ok(it, 'an unrecognised type is still an item');
  assert.equal(it.meta.chisel, 'fine', 'unknown meta is carried untouched');
  assert.equal(hasRenderer('sculpture'), false, 'and there is nothing to draw it with');

  const out = serializeBoard().items.find(i => i.type === 'sculpture');
  assert.ok(out, 'it goes back out again');
  assert.equal(out.meta.chisel, 'fine');
});

// ---------------------------------------------------------------------------
// Recolouring
// ---------------------------------------------------------------------------

test('recolouring writes the hex and the name as one undoable step', () => {
  const [it] = addItems([swatch()]);
  setSwatchHex(it.id, '#112233');
  assert.equal(byId(it.id).meta.hex, '#112233');
  assert.equal(byId(it.id).name, '#112233'.toUpperCase(),
    'the number is the name - see setSwatchHex');

  undo();
  assert.equal(byId(it.id).meta.hex, '#aabbcc', 'one Ctrl+Z takes back both halves');
  assert.equal(byId(it.id).name, '#AABBCC');

  redo();
  assert.equal(byId(it.id).meta.hex, '#112233');
  assert.equal(byId(it.id).name, '#112233'.toUpperCase());
});

test('a colour the card could not show is dropped rather than stored', () => {
  const [it] = addItems([swatch()]);
  for (const bad of ['red', '#f00', 'nonsense', '', null]) {
    setSwatchHex(it.id, bad);
    assert.equal(byId(it.id).meta.hex, '#aabbcc', `${JSON.stringify(bad)} should not land`);
  }
  // Including the short form: swatchHex() folds `#f00` out on the way to
  // the card, but nothing types it into a colour input, so it never reaches
  // the board in the first place.
});

test('recolouring a swatch that arrived without a colour can be undone back to none', () => {
  // `undefined` is a real previous value: a hand-written .mbrd can carry a
  // swatch with no hex. Undo must remove the key again, not set it to
  // undefined, or the board holds a field it does not have.
  const [it] = addItems([{ type: 'swatch', w: 128, h: 148, name: 'x' }]);
  setSwatchHex(it.id, '#112233');
  undo();
  assert.equal('hex' in byId(it.id).meta, false, 'the key is gone, not undefined');
  assert.equal(byId(it.id).name, 'x', 'and the name it had comes back');
});

test('only a swatch can be recoloured', () => {
  const [it] = addItems([{ type: 'note', w: 100, h: 100, meta: { text: 'n' } }]);
  setSwatchHex(it.id, '#112233');
  assert.equal(byId(it.id).meta.hex, undefined);
});
