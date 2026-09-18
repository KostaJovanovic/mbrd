// The card the cleaning simulator leaves on a board (canvas/spotless.ts). Its
// frames come out of the .mbrd, so the reader is held to taking only what the
// mode writes: four numbers inside the frame and a colour.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spotlessRects, spotlessBy, SPOTLESS_FRAME, SPOTLESS_WORDS } from '../web/assets/js/canvas/spotless.ts';

test('a spotless card reads back what the mode wrote', () => {
  const got = spotlessRects([[7, 7, 20, 12, 'rgb(132 100 66)'], [40.5, 30, 10, 10, '#a0b0c0']]);
  assert.deepEqual(got, [
    { x: 7, y: 7, w: 20, h: 12, colour: 'rgb(132 100 66)' },
    { x: 40.5, y: 30, w: 10, h: 10, colour: '#a0b0c0' },
  ]);
});

test('a spotless card drops anything a file could have put there instead', () => {
  const { w, h } = SPOTLESS_FRAME;
  const bad = [
    'not a list',
    [1, 2, 3, 4],
    [1, 2, 3, 4, 'red'],
    [1, 2, 3, 4, 'url(#x)'],
    [1, 2, 3, 4, '#abc" onload="x'],
    [Number.NaN, 2, 3, 4, '#abc'],
    [-1, 2, 3, 4, '#abc'],
    [1, 2, 0, 4, '#abc'],
    [w - 1, 2, 5, 4, '#abc'],
    [1, h - 1, 3, 5, '#abc'],
    ['1', 2, 3, 4, '#abc'],
  ];
  assert.deepEqual(spotlessRects(bad), []);
  assert.deepEqual(spotlessRects({ length: 3 }), []);
  assert.deepEqual(spotlessRects(undefined), []);
});

test('a spotless card draws at most a few hundred rectangles', () => {
  const many = Array.from({ length: 5000 }, () => [1, 1, 1, 1, '#abc']);
  assert.ok(spotlessRects(many).length <= 400);
});

test('the robot finishing a board is the only other thing a card can say', () => {
  assert.equal(spotlessBy({ meta: { by: 'robot' } }), 'robot');
  assert.equal(spotlessBy({ meta: {} }), 'hand');
  assert.equal(spotlessBy({ meta: { by: 'somebody else' } }), 'hand');
  assert.notEqual(SPOTLESS_WORDS.hand.said, SPOTLESS_WORDS.robot.said);
  assert.notEqual(SPOTLESS_WORDS.hand.hover, SPOTLESS_WORDS.robot.hover);
});
