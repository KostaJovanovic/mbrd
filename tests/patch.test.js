// The changelog: the source, the board built from it, and the page that serves
// both.
//
// /patch is not a page about the app, it is the app. web/patch.html is
// index.html's own shell with a changelog head on it, and what it opens is
// web/assets/patch-notes.mbrd - a real .mbrd, one note card per release, read
// through the same unpackBoard() a dropped file goes through. Both are built
// from research/patch-notes.md by tools/gen-patch-board.mjs.
//
// That gives this file two jobs. The first is the one every changelog needs: the
// newest release has to be the version the app is running, or the page has
// stopped being evidence of anything. The second is the one generated artifacts
// always need - proof that what is committed is what the generator would write
// today, because a build output that has drifted from its source is worse than
// no build output at all: it looks authoritative and is stale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, WEB, read } from './helpers.js';
import { readZip } from '../web/assets/js/storage/zip.ts';
import { VERSION } from '../web/assets/js/version.js';

const SOURCE = join(ROOT, 'research', 'patch-notes.md');
const source = read(SOURCE);
const html = read(join(WEB, 'patch.html'));
const prose = html.replace(/<!--[\s\S]*?-->/g, '');

/** The releases, read out of the source the way the generator reads them. */
const releases = (() => {
  const body = source.slice(source.indexOf('\n## Releases\n') + '\n## Releases\n'.length);
  const out = [];
  for (const line of body.split('\n')) {
    let m;
    if ((m = line.match(/^## (.+)$/))) out.push({ name: m[1].trim(), bullets: 0 });
    else if ((m = line.match(/^version:\s*(.+)$/))) out.at(-1).version = m[1].trim();
    else if ((m = line.match(/^date:\s*(.+)$/))) out.at(-1).date = m[1].trim();
    else if (/^- /.test(line)) out.at(-1).bullets++;
  }
  return out;
})();

const board = await (async () => {
  const files = await readZip(readFileSync(join(WEB, 'assets', 'patch-notes.mbrd')));
  const dec = new TextDecoder();
  return {
    files,
    manifest: JSON.parse(dec.decode(files.get('manifest.json'))),
    data: JSON.parse(dec.decode(files.get('board.json'))),
  };
})();

test('the source has releases at all', () => {
  // Guards every assertion below it: a parser that matched nothing would let
  // all of them pass while saying nothing.
  assert.ok(releases.length >= 4, `only ${releases.length} releases parsed from patch-notes.md`);
  for (const r of releases) {
    assert.ok(r.version, `"${r.name}" has no version:`);
    assert.ok(r.date, `"${r.name}" has no date:`);
    assert.ok(r.bullets > 0, `"${r.name}" has no bullets`);
  }
});

test('the newest release is the version the app is running', () => {
  // The rule the whole changelog rests on. A release may cover a span - most do,
  // because save.bat bumps the counter on every commit and a commit is not a
  // release - and what has to match is the high end, since that is the number
  // somebody reading the sidebar will be looking for.
  const high = releases[0].version.split(' - ').pop().trim();
  assert.equal(high, VERSION,
    `patch-notes.md leads with ${releases[0].version} and the app reports v${VERSION}. ` +
    'Either the newest release went undocumented, or the entry was written for a ' +
    'version save.bat has not stamped yet.');
});

test('releases run newest first, with no version or codename claimed twice', () => {
  const low = v => Number(v.split(' - ')[0].trim().split('.')[1] ?? -1);
  const names = new Set();
  let previous = Infinity;
  for (const r of releases) {
    assert.ok(!names.has(r.name), `two releases are both called "${r.name}"`);
    names.add(r.name);
    const n = low(r.version);
    assert.ok(n < previous, `${r.version} is listed under a version below it`);
    previous = n;
  }
});

test('every date is written the one way', () => {
  // "13 August 2026", or "4 - 6 August 2026" across days. Checked because a date
  // nobody parses drifts into three spellings within a year.
  for (const r of releases) {
    assert.match(r.date, /^\d{1,2}( - \d{1,2})? [A-Z][a-z]+ \d{4}$/,
      `"${r.name}" has the date "${r.date}"`);
  }
});

test('the source carries no em-dash and no emoji', () => {
  // Repository-wide conventions, checked on the one file most likely to break
  // them: it is the only prose here written for somebody who is not editing the
  // code, which is exactly the register an em-dash creeps into.
  assert.doesNotMatch(source, /[—–]/,
    'patch-notes.md has an em-dash or en-dash - separators in this repository are " - "');
  assert.doesNotMatch(source, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    'patch-notes.md has an emoji');
});

test('a tag is one of the three', () => {
  // The set is deliberately closed: three registers that can be told apart at a
  // glance. A fourth would need a colour that is not already spoken for and a
  // reader who remembers what it means.
  const tags = [...source.matchAll(/^- \[([a-z]+)\]/gm)].map(m => m[1]);
  const bad = [...new Set(tags)].filter(t => !['new', 'fix', 'faster'].includes(t));
  assert.deepEqual(bad, [], `not a tag: ${bad.join(', ')}`);
});

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

test('the board is a real .mbrd, one note per release', () => {
  assert.equal(board.manifest.format, 'mbrd');
  assert.equal(board.manifest.version, 1);
  assert.equal(board.data.title, 'Patch notes');
  assert.equal(board.data.items.length, releases.length,
    'the board has a different number of cards than the source has releases');
  for (const item of board.data.items) {
    assert.equal(item.type, 'note', `${item.id} is a ${item.type}, not a note`);
    assert.ok(item.meta?.text, `${item.id} has no text`);
  }
  // Same order as the source, so the Feed reads newest first.
  assert.deepEqual(board.data.items.map(i => i.name), releases.map(r => r.name));
});

test('every note has its Markdown sidecar, which is what the format promises', () => {
  // packBoard() writes one notes/<slug>--<id>.md per sticky and unpackBoard()
  // reads it back, with the sidecar outranking board.json. Writing them is what
  // makes this file a board somebody can unzip and read - the second promise the
  // format makes after "one file you can email".
  const sidecars = [...board.files.keys()].filter(n => n.startsWith('notes/'));
  assert.equal(sidecars.length, board.data.items.length);
  for (const item of board.data.items) {
    assert.ok(sidecars.some(n => n.endsWith(`--${item.id}.md`)),
      `${item.id} has no sidecar, so unpackBoard would fall back to board.json`);
  }
});

test('the board file is reproducible', () => {
  // No timestamps anywhere in it - not in the ZIP entries, not in the manifest -
  // so building it twice from an unchanged source gives identical bytes. Without
  // that every commit that runs the generator carries a diff nobody can read,
  // and the check below could not exist at all.
  assert.ok(!('created' in board.manifest) && !('modified' in board.manifest),
    'the manifest carries a timestamp, so the file changes every time it is built');
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

test('the page is the app', () => {
  // The whole design in four assertions. /patch boots the real app - so it loads
  // the bundle and the app's cascade - and it is not a second hand-kept copy of
  // the shell, which is what the generator exists to prevent.
  assert.match(prose, /<script type="module" src="assets\/app\.js">/,
    'patch.html does not load the bundle, so there is no app on it');
  assert.match(prose, /href="assets\/css\/base\.css"/,
    'patch.html does not load the app cascade');
  assert.match(prose, /id="sidebar"/,
    'patch.html has no sidebar, so the shell copy has gone wrong');
  assert.match(prose, /id="menu-btn"/, 'patch.html has no menu button');
});

test('the fallback carries the whole changelog', () => {
  // What a crawler and a reader with no JavaScript get. Inside <noscript>, which
  // a parser with scripting on treats as text - so none of it is in the DOM the
  // board is built into, and the two renderings cannot interfere.
  const m = prose.match(/<noscript>\s*<div class="patch-fallback">([\s\S]*?)<\/noscript>/);
  assert.ok(m, 'patch.html has no <noscript> fallback');
  const fallback = m[1];
  for (const r of releases) {
    assert.ok(fallback.includes(`>${r.name}<`), `the fallback is missing "${r.name}"`);
  }
  assert.ok(fallback.includes(releases[0].version), 'the fallback is missing the newest version');
  // And its stylesheet, which is fetched only when the block is live.
  assert.match(prose, /<noscript><link rel="stylesheet" href="assets\/css\/patch\.css"><\/noscript>/,
    'the fallback stylesheet is not behind a noscript, so every visitor pays for it');
});

test('no base tag, so the fallback anchors stay on the page', () => {
  // index.html carries <base href="/"> because it is served at every address it
  // does not have. This page is served at one, and a base here would be actively
  // wrong: a fragment-only href resolves against the base rather than the
  // document, so an in-page link would load a board instead of scrolling.
  //
  // Read from the comment-stripped copy: the head carries a comment naming the
  // tag and saying why it is absent, and that note is the thing most likely to
  // stop somebody putting it back.
  assert.doesNotMatch(prose, /<base\b/, 'patch.html has a <base> tag');
});

test('the shell, the board and the page are all precached', () => {
  // Three files that are no use apart: the page with no board opens an empty
  // changelog, the board with no page is unreachable, and the fallback with no
  // stylesheet is unreadable.
  const sw = read(join(WEB, 'sw.js'));
  for (const path of ['./patch.html', './assets/patch-notes.mbrd', './assets/css/patch.css']) {
    assert.ok(sw.includes(`'${path}'`), `${path} is not in SHELL in sw.js`);
  }
});

test('the sidebar has a way to reach it, and the sitemap lists it', () => {
  const schema = read(join(WEB, 'assets', 'js', 'ui', 'settings-schema.ts'));
  assert.match(schema, /cmd: 'patch-notes'/, 'nothing in the settings schema opens the changelog');
  const sitemap = read(join(WEB, 'sitemap.xml'));
  assert.match(sitemap, /<loc>https:\/\/mbrd\.valjdakosta\.com\/patch<\/loc>/,
    'the changelog is not in sitemap.xml');
  assert.match(prose, /rel="canonical" href="https:\/\/mbrd\.valjdakosta\.com\/patch"/,
    'the canonical does not match the sitemap entry');
});

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

test('what is committed is what the generator writes', () => {
  // The check the other twelve rest on. Everything above reads the two built
  // files and holds them to the source; this one proves they were actually built
  // from it, rather than hand-edited afterwards into something that happens to
  // pass. A generated file somebody has patched by hand is the worst of both -
  // authoritative-looking, and gone the next time the tool runs.
  //
  // Run for real rather than reimplemented: a second copy of the generator in
  // here would only prove the two copies agree.
  const before = {
    mbrd: readFileSync(join(WEB, 'assets', 'patch-notes.mbrd')),
    html: read(join(WEB, 'patch.html')),
  };
  execFileSync(process.execPath, [join(ROOT, 'tools', 'gen-patch-board.mjs')], { cwd: ROOT });
  const after = {
    mbrd: readFileSync(join(WEB, 'assets', 'patch-notes.mbrd')),
    html: read(join(WEB, 'patch.html')),
  };
  assert.ok(before.mbrd.equals(after.mbrd),
    'web/assets/patch-notes.mbrd is not what the generator produces - run ' +
    '`node tools/gen-patch-board.mjs` and commit the result');
  assert.equal(before.html, after.html,
    'web/patch.html is not what the generator produces - it is built from ' +
    'index.html and research/patch-notes.md, so run `node tools/gen-patch-board.mjs`');
});
