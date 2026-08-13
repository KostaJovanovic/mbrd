// The changelog, checked against the app it describes.
//
// web/patch.html is the one page in this repository that is kept entirely by
// hand: nothing generates it, save.bat does not touch it, and every rule about
// how to write an entry lives in a comment inside the file. That is the right
// arrangement - a generated changelog is a list of commit subjects, which is
// the thing a changelog exists not to be - and it has one failure mode, which
// is that hand-kept files drift and nobody notices for a quarter.
//
// So the rules that can be checked are checked here rather than trusted. The
// first of them is the only one that really matters: the newest entry must be
// the version the app is printing in the foot of its sidebar. A changelog whose
// top entry is behind the running app is not slightly out of date, it is a page
// that has stopped being evidence of anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { WEB, read } from './helpers.js';
import { VERSION } from '../web/assets/js/version.js';

const html = read(join(WEB, 'patch.html'));

/** The prose, with the authoring guide and every other comment taken out. */
const prose = html.replace(/<!--[\s\S]*?-->/g, '');

/**
 * Every entry on the page, in document order, outermost markup only.
 *
 * `extra` is everything on the opening tag that is not the class name itself -
 * the rest of the class list, and the id the panel index links to. Kept as one
 * string because the two tests that read it ask different questions of it
 * (is this the milestone, and what is it called), and neither wants a parser.
 */
const entries = [...prose.matchAll(/<div class="patch-entry([^"]*)"([^>]*)>([\s\S]*?)<\/div>/g)]
  .map(m => ({ extra: `${m[1]} ${m[2]}`.trim(), body: m[3] }));

/** The text of one <p class="patch-x"> inside an entry. */
const field = (body, name) => {
  const m = body.match(new RegExp(`<p class="patch-${name}">([^<]*)</p>`));
  return m ? m[1].trim() : null;
};

const versions = entries.map(e => field(e.body, 'version'));

test('the page has entries at all', () => {
  // Guards every assertion below it: an extractor that matched nothing would
  // let all of them pass while saying nothing, and the shape it reads is
  // hand-written markup rather than a format anything validates.
  assert.ok(entries.length >= 4,
    `only ${entries.length} entries found in patch.html - has the markup moved?`);
});

test('the newest entry is the version the app is running', () => {
  // The rule the whole page rests on. The newest entry may be a range - most of
  // them are, because save.bat bumps the counter on every commit and a commit is
  // not a release - and what has to match is the high end of it, since that is
  // the version somebody reading the sidebar will be looking for.
  const newest = versions[0];
  assert.ok(newest, 'the first entry has no <p class="patch-version">');
  const high = newest.split(' - ').pop().trim();
  assert.equal(high, VERSION,
    `patch.html leads with ${newest} and the app reports v${VERSION}. Either the ` +
    'newest release went undocumented, or the entry was written for a version ' +
    'save.bat has not stamped yet. See version.js and the guide comment in the page.');
});

test('entries run newest first, and no version is claimed twice', () => {
  // Both directions of the same question. A range is compared on its low end
  // against the previous range's low end, which is what makes 0.145 - 0.155
  // sort correctly under 0.156 and above 0.135 - 0.144.
  const low = v => Number(v.split(' - ')[0].trim().split('.')[1] ?? -1);
  const seen = new Set();
  let previous = Infinity;
  for (const v of versions) {
    assert.ok(v, 'an entry has no version');
    assert.ok(!seen.has(v), `two entries both claim ${v}`);
    seen.add(v);
    const n = low(v);
    assert.ok(n < previous,
      `${v} is listed under a version below it - entries run newest first`);
    previous = n;
  }
});

test('every entry carries a version, a name and a date', () => {
  for (const { body } of entries) {
    const version = field(body, 'version');
    assert.ok(field(body, 'name'), `${version} has no codename`);
    // The format the guide asks for: "13 August 2026", or "4 - 6 August 2026"
    // where the entry spans days. Checked because a date nobody parses is a
    // date that drifts into three different spellings within a year.
    const date = field(body, 'date');
    assert.ok(date, `${version} has no date`);
    assert.match(date, /^\d{1,2}( - \d{1,2})? [A-Z][a-z]+ \d{4}$/,
      `${version} has the date "${date}" - the guide asks for "13 August 2026"`);
  }
});

test('the panel index and the column say the same thing', () => {
  // The page's one hand-kept correspondence, and the step of adding a release
  // that is easiest to forget: the card goes in the column, and a row has to go
  // in the panel beside it. Checked in both directions and in order, because
  // each failure is different and silent in its own way - a missing row is a
  // release you cannot jump to, a stale row is a link that scrolls nowhere, and
  // a row out of order is an index that disagrees with the page under it.
  const rows = [...prose.matchAll(
    /<li><a href="#([^"]+)">([^<]+)<span>([^<]*)<\/span><\/a><\/li>/g)]
    .map(m => ({ href: m[1], name: m[2].trim(), version: m[3].trim() }));

  assert.ok(rows.length > 3, `only ${rows.length} index rows found - has the panel moved?`);

  const cards = entries.map(e => ({
    id: (e.extra.match(/id="([^"]+)"/) ?? [])[1],
    name: field(e.body, 'name'),
    version: field(e.body, 'version'),
  }));

  for (const c of cards) {
    assert.ok(c.id, `the ${c.name} card has no id, so nothing can link to it`);
  }
  assert.deepEqual(
    rows.map(r => [r.href, r.name, r.version]),
    cards.map(c => [c.id, c.name, c.version]),
    'the Releases list in the panel does not match the cards in the column, in ' +
    'order. Every card needs a row, every row needs a card, and the codename ' +
    'and version on each have to agree.');
});

test('no codename is used twice', () => {
  // The one rule in the guide with nothing else holding it up. A repeated
  // codename is not a broken page, it is a page where two different updates
  // answer to the same name, and it is invisible until somebody goes looking
  // for the wrong one.
  const names = entries.map(e => field(e.body, 'name'));
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(twice, [], `these codenames appear more than once: ${twice.join(', ')}`);
});

test('the whole history is on the page, with nothing folded away', () => {
  // The page's one layout decision, and the one a future tidy-up is most likely
  // to undo: every entry is open, in one column, oldest included. A changelog
  // that hides its own past behind a disclosure - or archives it to a second
  // page - is asking the reader to guess whether there is more, and there always
  // is. If this file becomes long enough for that to cost something, the answer
  // is shorter entries rather than a lid.
  assert.doesNotMatch(prose, /<details/,
    'an entry has been folded away - the whole history stays open, see the guide comment');
  // And the oldest entry is still here, which is the half a fold would take
  // first and the half nobody would notice missing.
  assert.equal(versions.at(-1), '0.00 - 0.21',
    'the first release is no longer the last entry on the page');
});

test('a tag is one of the three, and leads its bullet', () => {
  // The tag set is deliberately closed: three registers that can be told apart
  // at a glance, with a pigment each in patch.css. A fourth would need a colour
  // that is not already spoken for and a reader who remembers what it means.
  const ALLOWED = new Set(['patch-tag', 'patch-tag is-fix', 'patch-tag is-faster']);
  for (const m of prose.matchAll(/<span class="(patch-tag[^"]*)">([^<]*)<\/span>/g)) {
    assert.ok(ALLOWED.has(m[1]), `<span class="${m[1]}"> is not one of the three tags`);
    assert.match(m[2], /^(New|Fix|Faster)$/, `"${m[2]}" is not a tag word`);
  }
  // And the word matches the class it is wearing, which is the half that would
  // otherwise rot silently: a Fix in accent outline reads as a new feature.
  for (const [, cls, word] of prose.matchAll(/<span class="(patch-tag[^"]*)">([^<]*)<\/span>/g)) {
    const expected = cls.includes('is-fix') ? 'Fix' : cls.includes('is-faster') ? 'Faster' : 'New';
    assert.equal(word, expected, `<span class="${cls}"> says "${word}"`);
  }
});

test('the page carries no em-dash and no emoji', () => {
  // Repository-wide conventions, checked on the one file most likely to break
  // them: it is the only prose here written to be read by somebody who is not
  // editing the code, which is exactly the register an em-dash creeps into.
  assert.doesNotMatch(prose, /[—–]/,
    'patch.html has an em-dash or an en-dash - separators in this repository are " - "');
  assert.doesNotMatch(prose, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    'patch.html has an emoji');
});

test('the page runs no script and writes no style attribute', () => {
  // What keeps patch.html out of the hash list in web/_headers entirely. An
  // inline <script> or <style> here would need a sha256 in the policy, and a
  // style="..." attribute cannot be hashed at all - see tests/csp.test.js, which
  // checks the same thing from the policy end for every page in web/.
  assert.doesNotMatch(prose, /<script(?![^>]*type="application\/ld\+json")/,
    'patch.html has a script - the page is deliberately script-free');
  assert.doesNotMatch(prose, /<style/, 'patch.html has an inline style block');
  assert.doesNotMatch(prose, /style\s*=\s*["']/, 'patch.html writes a style attribute');
});

test('no base tag, so the index links stay on the page', () => {
  // The bug this is here for shipped and was caught by hand: with
  // <base href="/"> in the head - which index.html carries, for a reason that
  // does not apply here - a fragment-only href resolves against the base rather
  // than the document. Every row in the panel index pointed at /#r-whatever,
  // so clicking one left the changelog and loaded a board.
  //
  // Both halves are asserted, because either alone would let it back: the tag
  // must stay out, and the anchors must stay fragment-only. An anchor written
  // as /patch#r-x would survive a base tag and is therefore the tempting wrong
  // fix - it also hardcodes the page's own address into every row.
  // Read from the comment-stripped copy, because the head carries a comment
  // that names the tag and says why it is absent - which is the note most
  // likely to stop somebody putting it back, so it must not be what fails here.
  assert.doesNotMatch(prose, /<base\b/,
    'patch.html has a <base> tag, which would send every #fragment link to the app');
  const offenders = [...prose.matchAll(/href="([^"]*#[^"]*)"/g)]
    .map(m => m[1])
    .filter(href => !href.startsWith('#'));
  assert.deepEqual(offenders, [],
    `these in-page links carry a path as well as a fragment: ${offenders.join(', ')}`);
});

test('the stylesheet it needs is the one it loads', () => {
  // Three sheets and deliberately not the app's twenty. Asserted because the
  // tempting maintenance here - "this page looks unstyled, let me add base.css"
  // - is the change that would break it: base.css opens by refusing to scroll.
  assert.match(html, /href="assets\/css\/patch\.css"/, 'patch.html does not load patch.css');
  assert.match(html, /href="assets\/css\/tokens\.css"/, 'patch.html does not load tokens.css');
  assert.doesNotMatch(html, /href="assets\/css\/base\.css"/,
    'patch.html loads base.css, which pins the page to the window and stops it scrolling');
});

test('the service worker precaches the page and its sheet', () => {
  // Both, or neither is any use: the page offline without its stylesheet is
  // unreadable, and the stylesheet cached without the page is dead weight.
  const sw = read(join(WEB, 'sw.js'));
  assert.match(sw, /'\.\/patch\.html'/, 'patch.html is not in SHELL in sw.js');
  assert.match(sw, /'\.\/assets\/css\/patch\.css'/, 'patch.css is not in SHELL in sw.js');
});

test('the sidebar has a way to reach it', () => {
  // The page is not linked from the board itself, so the row in the System tab
  // is the only door to it inside the app. The command behind that row is
  // checked by tests/settings-panel.js, which asserts every cmd the schema names
  // exists; what is checked here is that the row has not been quietly dropped.
  const schema = read(join(WEB, 'assets', 'js', 'ui', 'settings-schema.ts'));
  assert.match(schema, /cmd: 'patch-notes'/,
    'nothing in the settings schema opens the patch notes');
});

test('the sitemap lists it', () => {
  const sitemap = read(join(WEB, 'sitemap.xml'));
  assert.match(sitemap, /<loc>https:\/\/mbrd\.valjdakosta\.com\/patch<\/loc>/,
    'the changelog is not in sitemap.xml');
  // The canonical and the sitemap entry must be the same string, trailing slash
  // and all - the sitemap says so itself about the home page, and a second
  // opinion is time a crawler spends resolving rather than reading.
  assert.match(html, /rel="canonical" href="https:\/\/mbrd\.valjdakosta\.com\/patch"/,
    'the canonical on patch.html does not match its sitemap entry');
});
