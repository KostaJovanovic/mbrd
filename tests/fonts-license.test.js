// Every typeface the shell ships must carry its licence with it.
//
// The bundled faces are under the SIL Open Font License 1.1, whose condition 2
// is that redistribution include the licence - "stand-alone text files" beside
// the software counts. The Geist faces shipped for several versions with no
// such file (AUD-17); this holds the door shut, the same way sw.test.js holds
// SHELL against the files on disk. A new woff2 family with no OFL beside it, or
// a THIRD-PARTY.md that forgets to name that OFL, fails here rather than at a
// licence audit nobody runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';

import { WEB, ROOT, read, walk } from './helpers.js';

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
  // The walk first. `shipped.filter(...)` over an empty walk is an empty list
  // of unmapped faces, so a broken directory read - a rename, a moved folder -
  // reported perfect licence coverage over no fonts at all.
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
  // One file covers two shipped families; if it names only one, the other is
  // redistributed without the reserved-name notice the OFL requires.
  const text = read(join(FONTS, 'geist-OFL.txt'));
  assert.match(text, /Reserved Font Name.*Geist/s);
  assert.match(text, /Geist Mono/);
});

test('THIRD-PARTY.md names every licence file that covers a shipped face', () => {
  const manifest = read(join(ROOT, 'THIRD-PARTY.md'));
  for (const licence of new Set(Object.values(COVER))) {
    assert.ok(manifest.includes(licence), `THIRD-PARTY.md does not point at ${licence}`);
  }
});
