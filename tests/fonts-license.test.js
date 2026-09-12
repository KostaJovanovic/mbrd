// Every typeface the shell ships must carry its licence with it.
//
// Bundled faces are under SIL OFL 1.1, whose condition 2 requires
// redistribution to include the licence. The Geist faces shipped for
// several versions with no such file (AUD-17); this holds the door shut,
// same as sw.test.js holds SHELL against the files on disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';

import { WEB, THIRD_PARTY, read, walk } from './helpers.js';

const FONTS = join(WEB, 'assets', 'fonts');

/** Every face the shell ships. */
const shipped = walk(FONTS, ['.woff2'], FONTS);

/** family name -> the OFL file it is meant to be covered by. */
const COVER = {
  playfair: 'playfair-OFL.txt',
  fraunces: 'fraunces-OFL.txt',
  geist: 'geist-OFL.txt',
};

const familyOf = file => basename(file).split('-')[0];

test('every shipped face belongs to a known family', () => {
  // The walk first: an empty walk gives an empty list of unmapped faces, so
  // a broken directory read would report perfect coverage over no fonts at all.
  assert.ok(shipped.length >= Object.keys(COVER).length,
    `only ${shipped.length} faces found in ${FONTS} - has the folder moved?`);
  const unknown = shipped.filter(f => !COVER[familyOf(f)]);
  assert.deepEqual(unknown, [], `no licence mapping for:\n  ${unknown.join('\n  ')}`);
});

test('each family\'s licence file exists and is the OFL', () => {
  for (const licence of new Set(Object.values(COVER))) {
    const path = join(FONTS, licence);
    assert.ok(existsSync(path), `${licence} is missing`);
    const text = read(path);
    assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1/, `${licence} is not the OFL`);
    assert.match(text, /Copyright/i, `${licence} has no copyright line`);
  }
});

test('the Geist licence reserves both Geist and Geist Mono', () => {
  // One file covers two families; naming only one redistributes the other
  // without the OFL's required reserved-name notice.
  const text = read(join(FONTS, 'geist-OFL.txt'));
  assert.match(text, /Reserved Font Name.*Geist/s);
  assert.match(text, /Geist Mono/);
});

test('THIRD-PARTY.md names every licence file that covers a shipped face', () => {
  const manifest = read(THIRD_PARTY);
  for (const licence of new Set(Object.values(COVER))) {
    assert.ok(manifest.includes(licence), `THIRD-PARTY.md does not point at ${licence}`);
  }
});
