// The download page, and the ways it goes wrong without anybody noticing.
//
// Its one button opens the latest release in the public
// KostaJovanovic/mbrd-release. Every release file carries its version, so a
// `releases/latest/download/<name>` link would 404 after the next release, and
// a link into the private KostaJovanovic/mbrd 404s to anybody signed out. Both
// fail only on the deployed site. research/old/apps-2026-09-13.md §1 #10 and #31.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { WEB, read } from './helpers.js';

const page = read(join(WEB, 'download.html'));
const hrefs = [...page.matchAll(/href="([^"]+)"/g)].map(m => m[1]);

test('one button, to the latest release in the public repo', () => {
  const latest = hrefs.filter(href => /\/releases\/latest\/?$/.test(href));
  assert.deepEqual(latest, ['https://github.com/KostaJovanovic/mbrd-release/releases/latest'],
    'web/download.html should link to releases/latest exactly once, on KostaJovanovic/mbrd-release');
});

test('no link reaches the private repo', () => {
  const inPrivate = hrefs.filter(href => /github\.com\/KostaJovanovic\/mbrd(\/|$)/.test(href));
  assert.deepEqual(inPrivate, [],
    'KostaJovanovic/mbrd is private, so these links 404 to anybody signed out');
});

test('no link names a release file', () => {
  // A release file carries its version, so a fixed link to one dies on the next release.
  const direct = hrefs.filter(href => href.includes('/releases/latest/download/'));
  assert.deepEqual(direct, [], 'releases/latest/download/ links cannot follow a versioned file name');
});

test('the page names the file to pick on each system', () => {
  for (const ending of ['.exe', '.dmg', '.AppImage', '.apk']) {
    assert.ok(page.includes(`<code>${ending}</code>`), `web/download.html no longer names the ${ending} file`);
  }
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

test('the page states the things it exists to state', () => {
  // These rank above the button itself: an unsigned build isn't warning-free,
  // and macOS 15 removed the workaround everyone still recommends. Asserted as
  // prose since the words are the feature.
  assert.match(page, /not code-signed/,
    'the page no longer says the builds are unsigned, which is the paragraph that '
    + 'stops somebody deciding this is malware');
  assert.match(page, /macOS 15/,
    'the page no longer names macOS 15, where the right-click - Open bypass is gone');
  assert.match(page, /Open Anyway/,
    'the page no longer names Open Anyway, the first step for an app with an ad-hoc signature');
  assert.match(page, /xattr -d com\.apple\.quarantine/,
    'the page no longer carries the one command a Mac user may have to type');
});
