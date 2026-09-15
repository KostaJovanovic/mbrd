// Get the app, and the ways it goes wrong without anybody noticing.
//
// It opens the latest release in the public KostaJovanovic/mbrd-release. Every
// release file carries its version, so a `releases/latest/download/<name>` link
// would 404 after the next release, and a link into the private
// KostaJovanovic/mbrd 404s to anybody signed out. Both fail only on the deployed
// site. The download page that used to stand between the two is gone, and so is
// every road to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { WEB, read } from './helpers.js';

const LATEST = 'https://github.com/KostaJovanovic/mbrd-release/releases/latest';

test('Get the app opens the latest release in the public repo', () => {
  const view = read(join(WEB, 'assets', 'js', 'commands', 'view.ts'));
  assert.ok(view.includes(`export const RELEASES = '${LATEST}';`),
    'commands/view.ts should send Get the app to releases/latest on KostaJovanovic/mbrd-release');
  assert.match(view, /getApp: \(\) => \{ window\.open\(RELEASES,/, 'getApp no longer opens RELEASES');
});

test('the desktop updater opens the same page', () => {
  const updates = read(join(WEB, '..', 'desktop', 'updates.ts'));
  assert.match(updates, /RELEASE_PAGE = `https:\/\/github\.com\/\$\{OWNER\}\/\$\{REPO\}\/releases\/latest`/);
  assert.match(updates, /const OWNER = 'KostaJovanovic';/);
  assert.match(updates, /const REPO = 'mbrd-release';/);
});

test('nothing leads to the download page any more', () => {
  assert.ok(!existsSync(join(WEB, 'download.html')), 'web/download.html is back');
  const sw = read(join(WEB, 'sw.js'));
  assert.ok(!sw.includes('download.html') && !sw.includes('download.css'),
    'web/sw.js still precaches or routes to the download page');
  assert.ok(!read(join(WEB, 'sitemap.xml')).includes('/download<'), 'sitemap.xml still lists /download');
});
