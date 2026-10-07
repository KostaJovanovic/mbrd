// Colour words for Find (colour-words.ts): which colour goes by which name,
// what the modifiers narrow, and that a query with any other word in it is
// left to the text search.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { colourQuery, colourName, COLOUR_NAMES } from '../web/assets/js/colour-words.ts';
import { oklch, parseHex } from '../web/assets/js/color.ts';

const named = hex => colourName(oklch(...parseHex(hex)));

test('the plain colours go by the names anybody would give them', () => {
  const cases = {
    '#d32f2f': 'red', '#f57c00': 'orange', '#fbc02d': 'yellow', '#388e3c': 'green',
    '#1976d2': 'blue', '#7b1fa2': 'purple', '#f48fb1': 'pink', '#6d4c41': 'brown',
    '#111111': 'black', '#ffffff': 'white', '#9e9e9e': 'grey', '#00838f': 'blue',
  };
  for (const [hex, name] of Object.entries(cases)) assert.equal(named(hex), name, hex);
});

test('every name in the list is a name some colour goes by', () => {
  // A name no colour can have would make its search return nothing, forever.
  const reachable = new Set();
  for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 17) for (let b = 0; b < 256; b += 17) {
    reachable.add(colourName(oklch(r, g, b)));
  }
  for (const name of COLOUR_NAMES) assert.ok(reachable.has(name === 'gray' ? 'grey' : name), name);
});

test('a colour query passes the colours it names and no others', () => {
  const red = colourQuery('red');
  assert.ok(red('#d32f2f'));
  assert.ok(!red('#1976d2'));
  assert.ok(colourQuery('gray')('#9e9e9e'), 'gray and grey are one name');
  assert.ok(colourQuery('Dark  Blue')('#0d2a6b'), 'case and spacing do not matter');
  assert.ok(!colourQuery('dark blue')('#90caf9'), 'a light blue is not a dark one');
  assert.ok(colourQuery('pastel')('#f8bbd0'));
  assert.ok(!colourQuery('pastel')('#d32f2f'));
  assert.ok(colourQuery('warm')('#f57c00'));
  assert.ok(colourQuery('cool')('#1976d2'));
  assert.ok(!colourQuery('warm')('#9e9e9e'), 'a grey is neither warm nor cool');
  assert.ok(colourQuery('muted green')('#7d8f74'));
});

test('a hex code finds that colour and its near neighbours', () => {
  assert.ok(colourQuery('#3a6ea5')('#3a6ea5'));
  assert.ok(colourQuery('#3a6ea5')('#3d70a8'), 'a shade away is still that colour');
  assert.ok(!colourQuery('#3a6ea5')('#a53a3a'));
  assert.ok(colourQuery('#f00')('#ff0000'), 'three digits are six written shorter');
});

test('a query with any word that is not a colour word is a text search', () => {
  assert.equal(colourQuery('red car'), null);
  assert.equal(colourQuery('facade'), null, 'hex letters without a # are a word');
  assert.equal(colourQuery('constructor'), null, 'an inherited key is not a modifier');
  assert.equal(colourQuery(''), null);
});
