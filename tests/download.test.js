// The download page, and the one way it goes wrong without anybody noticing.
//
// Three buttons on web/download.html point at GitHub's
// `releases/latest/download/<name>` redirect. That redirect resolves a
// *filename*, so the page and desktop/electron-builder.yml's three
// artifactName lines are one fact written in two files - and the failure when
// they disagree is the worst shape this repository has: a link that is valid
// HTML, on a page that renders correctly, 404ing only on the deployed site and
// only for the person trying to install the app.
//
// Nothing else would catch it. The page is not generated, the builder config is
// not typechecked, and the Linux and macOS builds have never run on this
// machine - the first time a wrong name would be visible is a stranger pressing
// a button. So this file compares the two by string, in both directions.
//
// It also holds the invariant underneath that: **no ${version} in an
// artifactName**. A versioned filename is not wrong on its own - it is wrong
// *here*, because `latest/download/` cannot know it, so every link dies on the
// next tag. That is one word to add back and the reason it must not be is a
// paragraph, which is why it is asserted rather than left in a comment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { WEB, ROOT, read } from './helpers.js';

const page = read(join(WEB, 'download.html'));
const builder = read(join(ROOT, 'desktop', 'electron-builder.yml'));

/**
 * What electron-builder substitutes for `${ext}`, per target.
 *
 * Not derivable from the config - it is the builder's own table, and the third
 * row is why this map is written out rather than guessed at: an AppImage's
 * extension is `AppImage`, capitals and all, and lowercasing it is the exact
 * mistake this file exists to catch.
 */
const EXT = { nsis: 'exe', dmg: 'dmg', appImage: 'AppImage' };

/**
 * The artifact names the builder will produce, as a Map of target to filename.
 *
 * Walked line by line rather than read with a YAML parser, for the reason
 * tests/sw.test.js reads SHELL by hand: a parser is a dependency, this
 * repository has none at runtime and four in development, and what is being
 * read is three lines at a known indent under a known key.
 *
 * Line by line rather than by one regex, too, and that is not fussiness - a
 * lazy `[\s\S]*?` between a top-level key and an `artifactName` happily spans
 * the keys in between, so the first artifact in the file gets filed under
 * whatever key happens to be first. It did exactly that.
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
  // Guards the guard. A reindented config, or a fourth target added above one
  // of these, would make every assertion below vacuous rather than failing.
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
 * A function rather than a constant: an unknown target has to fail as a test
 * and not as a throw at import time, which takes the whole file down and
 * reports nothing about the four assertions that would still have been true.
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
  // The direction that rots quietly. A button pointing at a filename nothing
  // produces is not a broken page - it is a page that looks finished and hands
  // back GitHub's 404 to the one visitor who wanted the app.
  const built = filenames();
  const unbuilt = linked.filter(name => !built.includes(name));
  assert.deepEqual(unbuilt, [],
    `linked from web/download.html and produced by nothing:\n  ${unbuilt.join('\n  ')}`);
});

test('the page is precached and findable', () => {
  // Both lists a page of this site has to join, and neither fails on its own:
  // an unlisted page is one that renders naked with the network off, and an
  // unlisted URL is one nobody finds who was not already told about it. The
  // stylesheet is covered by tests/sw.test.js, which walks the whole directory.
  const sw = read(join(WEB, 'sw.js'));
  const shell = sw.match(/const SHELL = \[([\s\S]*?)\];/)?.[1] ?? '';
  assert.ok(shell.includes("'./download.html'"), 'download.html is not in SHELL in web/sw.js');
  assert.match(sw, /\/\\\/download\(\\\.html\)\?\\\/\?\$\//,
    'sw.js has no navigate branch for /download, so an offline visit to it is handed a board');

  assert.match(read(join(WEB, 'sitemap.xml')), /<loc>https:\/\/mbrd\.valjdakosta\.com\/download<\/loc>/,
    'the download page is not in sitemap.xml');
});

test('the page states the two things it exists to state', () => {
  // The research note ranks these above the buttons themselves: an unsigned
  // build is not a warning-free build, and macOS 15 removed the workaround
  // every set of instructions on the internet still recommends. Asserted as
  // prose rather than as markup because the words are the feature - a rewrite
  // that keeps the shape and drops either of them is the regression.
  assert.match(page, /not code-signed/,
    'the page no longer says the builds are unsigned, which is the paragraph that '
    + 'stops somebody deciding this is malware');
  assert.match(page, /macOS 15/,
    'the page no longer names macOS 15, where the right-click - Open bypass is gone');
  assert.match(page, /xattr -d com\.apple\.quarantine/,
    'the page no longer carries the one command a Mac user has to type');
});
