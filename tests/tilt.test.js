// A card's resting lean against its size (canvas/item-dom.ts). Past eight grid
// spaces wide or six tall a card stands straight, and a resize across that line
// has to straighten it and hand it back its own angle - not a new one - when it
// comes back. A stand-in node carries the two things retilt() touches.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { restingTilt, retilt } from '../web/assets/js/canvas/item-dom.ts';
import { baseStep } from '../web/assets/js/state.ts';

const card = (tilt, lean) => {
  const props = new Map([['--item-tilt', tilt]]);
  const dataset = lean === undefined ? {} : { lean };
  return {
    dataset,
    style: {
      getPropertyValue: key => props.get(key) ?? '',
      setProperty: (key, value) => { props.set(key, value); },
    },
  };
};
const box = (w, h) => ({ type: 'image', w: w * baseStep(), h: h * baseStep() });
const fits = box(8, 6);

test('a card wider than eight or taller than six grid spaces rests straight', () => {
  assert.equal(restingTilt(box(9, 2)), '0');
  assert.equal(restingTilt(box(2, 7)), '0');
});

test('a resize past either limit straightens a card and gives its lean back', () => {
  for (const [w, h] of [[9, 6], [8, 7]]) {
    const el = card('0.620');
    assert.equal(retilt(el, fits), null, 'eight by six exactly still leans');
    assert.equal(retilt(el, box(w, h)), '0');
    assert.equal(el.style.getPropertyValue('--item-tilt'), '0');
    assert.equal(retilt(el, box(w, h)), null, 'nothing to do while it stays large');
    assert.equal(retilt(el, fits), '0.620');
    assert.equal(el.dataset.lean, undefined);
  }
});

test('a card built too large is dealt a lean the first time it fits', () => {
  const el = card('0', '');
  const tilt = retilt(el, fits);
  assert.ok(tilt !== null && Math.abs(parseFloat(tilt)) <= 1, `dealt ${tilt}`);
  assert.equal(el.dataset.lean, undefined);
});

test('a fence and a sticker are left alone at any size', () => {
  for (const type of ['fence', 'sticker']) {
    assert.equal(retilt(card('0'), { type, w: 40 * baseStep(), h: 40 * baseStep() }), null, type);
  }
});
