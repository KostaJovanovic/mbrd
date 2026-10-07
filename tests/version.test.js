// The version a commit reads as, before and after a crown, and the semver its
// installers carry: the two must say the same number (1.5 is 1.5.0), and the
// list save.bat appends to must stay the one line its regex finds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { versionLabel, RELEASE_COMMITS, COMMIT_COUNT, VERSION } from '../web/assets/js/version.js';
import { semver } from '../desktop/scripts/version.mjs';
import { ROOT, read } from './helpers.js';

test('before the first crown a version is 0.<count>, padded as it always was', () => {
  assert.equal(versionLabel(5, []), '0.05');
  assert.equal(versionLabel(663, []), '0.663');
});

test('a crowned commit reads X.0, and the ones after it count up unpadded', () => {
  assert.equal(versionLabel(699, [700]), '0.699');
  assert.equal(versionLabel(700, [700]), '1.0');
  assert.equal(versionLabel(705, [700]), '1.5');
  assert.equal(versionLabel(812, [700]), '1.112');
  assert.equal(versionLabel(900, [700, 900]), '2.0');
  assert.equal(versionLabel(903, [700, 900]), '2.3');
});

test('the app and the installers name the same version', () => {
  assert.equal(semver(versionLabel(705, [700])), '1.5.0');
  assert.equal(semver(versionLabel(700, [700])), '1.0.0');
  assert.equal(semver(versionLabel(663, [])), '0.663.0');
});

test('the stamped label is what versionLabel says for the stamped count', () => {
  assert.equal(VERSION, versionLabel(COMMIT_COUNT));
});

test('the crowned list is ascending and on the one line save.bat rewrites', () => {
  assert.deepEqual([...RELEASE_COMMITS].sort((a, b) => a - b), RELEASE_COMMITS);
  assert.equal(new Set(RELEASE_COMMITS).size, RELEASE_COMMITS.length);
  const src = read(join(ROOT, 'web', 'assets', 'js', 'version.js'));
  assert.match(src, /^export const RELEASE_COMMITS = \[[\d, ]*\];$/m);
  assert.match(read(join(ROOT, 'save.bat')), /export const RELEASE_COMMITS = \\\[\(\[\\d, \]\*\)\\\];/);
});
