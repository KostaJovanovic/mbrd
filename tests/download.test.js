// The download page, and the one way it goes wrong without anybody noticing.
//
// Three buttons on web/download.html point at GitHub's
// `releases/latest/download/<name>` redirect, which resolves a filename - so
// the page and electron-builder.yml's three artifactName lines are one fact
// in two files. Disagreement 404s only on the deployed site, only for
// somebody trying to install - nothing else would catch it, since the page
// isn't generated and the builds don't run on this machine. Compared by
// string, both directions.
//
// Also holds: no ${version} in an artifactName - `latest/download/` can't
// resolve one, so every link would die on the next tag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { WEB, ROOT, read } from './helpers.js';

const page = read(join(WEB, 'download.html'));
const builder = read(join(ROOT, 'desktop', 'electron-builder.yml'));

/**
 * What electron-builder substitutes for `${ext}`, per target. Not derivable
 * from the config - an AppImage's extension is `AppImage`, capitals and all,
 * and lowercasing it is the mistake this file exists to catch.
 */
const EXT = { nsis: 'exe', dmg: 'dmg', appImage: 'AppImage' };

/**
 * The artifact names the builder will produce, as a Map of target to filename.
 *
 * Walked line by line rather than a YAML parser (same reason tests/sw.test.js
 * reads SHELL by hand: no runtime dependency for three lines at a known
 * indent). Not one regex either - a lazy `[\s\S]*?` between a top-level key
 * and `artifactName` spans intervening keys, filing the first artifact under
 * whichever key happened to be first. It did exactly that.
 */
const artifacts = new Map();
{
  let target = '';
  for (const line of builder.split('\n')) {
    const top = line.match(/^(\w+):/);
    if (top) { target = top[1]; continue; }
    const name = line.match(/^ {2}artifactName: (\S+)\s*$/);
    if (name) artifacts.set(target, name[1]);
  }
}

test('the builder still names three artifacts', () => {
  // Guards the guard - a reindented config or a fourth target would make
  // every assertion below vacuous rather than failing.
  const targets = [...artifacts.keys()].sort();
  assert.deepEqual(targets, ['appImage', 'dmg', 'nsis'],
    `artifactName lines found for: ${targets.join(', ')} - has electron-builder.yml been reshaped?`);
});

test('no artifactName carries the version', () => {
  const versioned = [...artifacts].filter(([, name]) => name.includes('${version}'));
  assert.deepEqual(versioned, [],
    'a versioned filename cannot be reached through releases/latest/download/, so every '
    + `button on the download page would 404 after the next tag: ${versioned.map(([t, n]) => `${t}: ${n}`).join(', ')}`);
});

/**
 * The three filenames, with `${ext}` resolved the way the builder resolves it.
 *
 * A function, not a constant - an unknown target must fail as a test, not
 * throw at import time and take the whole file down.
 */
function filenames() {
  return [...artifacts].map(([target, name]) => {
    assert.ok(EXT[target], `no extension known for target "${target}" - add it to EXT above`);
    return name.replace('${ext}', EXT[target]);
  });
}

/** Every release asset the page links to, in the order it links to them. */
const linked = [...page.matchAll(
  /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/latest\/download\/(\S+?)"/g,
)].map(m => m[1]);

test('the page links to a release asset for every artifact the builder makes', () => {
  const missing = filenames().filter(name => !linked.includes(name));
  assert.deepEqual(missing, [],
    `built by electron-builder and linked from no button on web/download.html:\n  ${missing.join('\n  ')}`);
});

test('the page links to no release asset the builder does not make', () => {
  // The direction that rots quietly: a button pointing at a filename nothing
  // produces looks finished but hands the visitor GitHub's 404.
  const built = filenames();
  const unbuilt = linked.filter(name => !built.includes(name));
  assert.deepEqual(unbuilt, [],
    `linked from web/download.html and produced by nothing:\n  ${unbuilt.join('\n  ')}`);
});

test('the page is precached and findable', () => {
  // Neither fails alone: unlisted in SHELL means it renders naked offline;
  // unlisted in the sitemap means nobody finds it unprompted.
  const sw = read(join(WEB, 'sw.js'));
  const shell = sw.match(/const SHELL = \[([\s\S]*?)\];/)?.[1] ?? '';
  assert.ok(shell.includes("'./download.html'"), 'download.html is not in SHELL in web/sw.js');
  assert.match(sw, /\/\\\/download\(\\\.html\)\?\\\/\?\$\//,
    'sw.js has no navigate branch for /download, so an offline visit to it is handed a board');

  assert.match(read(join(WEB, 'sitemap.xml')), /<loc>https:\/\/mbrd\.valjdakosta\.com\/download<\/loc>/,
    'the download page is not in sitemap.xml');
});

test('the page states the two things it exists to state', () => {
  // These rank above the buttons themselves: an unsigned build isn't
  // warning-free, and macOS 15 removed the workaround everyone still
  // recommends. Asserted as prose since the words are the feature.
  assert.match(page, /not code-signed/,
    'the page no longer says the builds are unsigned, which is the paragraph that '
    + 'stops somebody deciding this is malware');
  assert.match(page, /macOS 15/,
    'the page no longer names macOS 15, where the right-click - Open bypass is gone');
  assert.match(page, /xattr -d com\.apple\.quarantine/,
    'the page no longer carries the one command a Mac user has to type');
});
