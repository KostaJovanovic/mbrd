// The sticker sprite is somebody else's drawings, and has to carry their
// notice.
//
// web/assets/stickers.svg is forty-five Phosphor glyphs, vendored by
// tools/gen-stickers.mjs. The MIT licence's one condition is that the copyright
// and permission notices go with "all copies or substantial portions of the
// Software", and forty-five outlines lifted verbatim is substantial by any
// reading.
//
// tests/fonts-license.test.js holds the same door for the bundled faces: the
// Geist faces shipped for several versions with no OFL beside them (AUD-17)
// because nothing was checking. Vendored art is the second way that can happen,
// so it gets a check rather than a note in a file nobody opens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { WEB, ROOT, THIRD_PARTY, read } from './helpers.js';

const LICENCE = join(WEB, 'assets', 'phosphor-LICENSE.txt');

test('the sticker sprite is vendored art and says so', () => {
  // Guards the guard. If the sprite ever stops being third-party - redrawn in
  // house - delete this file rather than leave it passing over a licence that
  // covers nothing.
  const sprite = read(join(WEB, 'assets', 'stickers.svg'));
  assert.match(sprite, /Phosphor/, 'the sprite no longer names where it came from');
  assert.match(sprite, /GENERATED/, 'the sprite no longer says it is generated');
});

test('the MIT licence ships beside it', () => {
  assert.ok(existsSync(LICENCE), 'web/assets/phosphor-LICENSE.txt is missing');
  const text = read(LICENCE);
  assert.match(text, /MIT License/, 'that file is not the MIT licence');
  assert.match(text, /Copyright \(c\) \d{4} Phosphor Icons/, 'no Phosphor copyright line');
  // The permission notice itself - the half the condition is about.
  assert.match(text, /Permission is hereby granted, free of charge/);
  assert.match(text, /shall be included in all\s+copies or substantial portions/);
});

test('THIRD-PARTY.md names the sprite and its licence file', () => {
  const manifest = read(THIRD_PARTY);
  assert.ok(manifest.includes('phosphor-LICENSE.txt'), 'no pointer at the licence file');
  assert.ok(manifest.includes('web/assets/stickers.svg'), 'no pointer at the sprite');
  assert.ok(manifest.includes('phosphor-icons/core'), 'no pointer at the source repository');
});

test('the generator pins a revision rather than tracking a branch', () => {
  // Re-running the generator on a Tuesday must not quietly redraw a board made
  // on the Monday. A branch name would make the output depend on the day it was
  // produced, which a committed generated file cannot afford.
  const gen = read(join(ROOT, 'tools', 'gen-stickers.mjs'));
  assert.match(gen, /const REV = '[0-9a-f]{40}';/, 'REV is not a full commit sha');
});
