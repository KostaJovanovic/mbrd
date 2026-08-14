// The changelog: the source, and the page built from it.
//
// /patch is a document, not the app. web/patch.html carries the whole changelog
// as markup and loads no bundle - so there is no board on it, no session, and
// nothing a visitor does while reading can reach what they own. What it does
// load is index.html's own cascade, copied at build time, which is what makes
// the page follow the whimsy dial: the look the reader set on their board is on
// <html> before first paint, and tokens.css prints the changelog three
// different ways off that one attribute.
//
// That gives this file three jobs. The first is the one every changelog needs:
// the newest release has to be the version the app is running, or the page has
// stopped being evidence of anything. The second is the pair of promises the
// design rests on - that the page is dressed by the app and is not the app. The
// third is the one generated artifacts always need: proof that what is
// committed is what the generator would write today, because a build output
// that has drifted from its source is worse than no build output at all - it
// looks authoritative and is stale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { ROOT, WEB, read } from './helpers.js';

const SOURCE = join(ROOT, 'patch-notes.md');
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
    else if (line.startsWith('- ')) out.at(-1).bullets++;
  }
  return out;
})();

/** The anchor the generator derives from a codename. Held to it by a test below. */
const idOf = name => 'r-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

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

test('releases run newest first, with no version or codename claimed twice', () => {
  // Not Number('0.87') against Number('0.105'). A version here is a major and a
  // commit count, not a decimal - 0.105 is the hundred and fifth commit and
  // comes *after* 0.87, which reading the pair as fractions gets backwards. The
  // suite got this wrong first, which is the reason for the sentence.
  const rank = v => {
    const m = v.match(/(\d+)\.(\d+)/);
    return Number(m[1]) * 100000 + Number(m[2]);
  };
  const names = new Set(), versions = new Set();
  let last = Infinity;
  for (const r of releases) {
    assert.ok(!names.has(r.name), `two releases are called "${r.name}"`);
    assert.ok(!versions.has(r.version), `two releases claim ${r.version}`);
    names.add(r.name);
    versions.add(r.version);
    const low = rank(r.version);
    assert.ok(low <= last, `"${r.name}" (${r.version}) is out of order`);
    last = low;
  }
});

test('the spans are contiguous, and they cover every commit from the first', () => {
  // The property that makes a gap in the record visible instead of plausible.
  //
  // Until v0.195 it did not hold: 0.22 to 0.40, 0.76 to 0.86, 0.93 to 0.104 and
  // 0.152 to 0.155 fell between two spans and were described by neither, while
  // several of the things done in them had been folded into the bullets of a
  // release whose number did not contain them - so the record read as complete
  // and was not, which is the worse of the two failures. A changelog with a
  // hole in it that nothing can see is one nobody can audit.
  //
  // Ends of a span, as a plain commit count. The major is not in this yet -
  // RELEASE_COMMITS in version.js is still empty and nothing has been crowned -
  // so a span is two commit counts and this stays honest as long as that is
  // true. Crowning a release is what makes it two numbers, and this is where
  // that would be noticed.
  const ends = v => {
    const m = v.match(/^0\.(\d+)(?:\s*-\s*0\.(\d+))?$/);
    assert.ok(m, `"${v}" is not a version or a span of them`);
    const low = Number(m[1]);
    const high = m[2] === undefined ? low : Number(m[2]);
    assert.ok(high >= low, `"${v}" runs backwards`);
    return [low, high];
  };

  // Oldest first, which is the direction the arithmetic reads in.
  const spans = releases.map(r => [r.name, ...ends(r.version)]).reverse();
  const [firstName, firstLow] = spans[0];
  assert.equal(firstLow, 0, `the record starts at 0.${firstLow} ("${firstName}") and not at the first commit`);
  for (let i = 1; i < spans.length; i++) {
    const [name, low] = spans[i];
    const [prevName, , prevHigh] = spans[i - 1];
    assert.equal(low, prevHigh + 1,
      `"${prevName}" ends at 0.${prevHigh} and "${name}" starts at 0.${low}`
      + (low > prevHigh + 1
        ? ` - 0.${prevHigh + 1}${low - prevHigh > 2 ? ` to 0.${low - 1}` : ''} is in no release`
        : ' - the two overlap'));
  }
});

test('every date is written the one way', () => {
  // "13 August 2026", or "4 - 6 August 2026" where a release spans days. One
  // shape, because a column of dates is read by its shape before it is read.
  const DATE = /^(\d{1,2}( - \d{1,2})? [A-Z][a-z]+ \d{4})$/;
  for (const r of releases) assert.match(r.date, DATE, `"${r.name}" has an odd date: ${r.date}`);
});

test('the source carries no em-dash and no emoji', () => {
  // The whole repository is em-dash-free on purpose and the separator is a
  // spaced hyphen; the changelog is the one file most likely to forget, being
  // prose. Emoji for the same reason: three tags are the legend and there is
  // no second vocabulary.
  assert.doesNotMatch(source, /—/, 'patch-notes.md has an em-dash in it');
  assert.doesNotMatch(source, /\p{Extended_Pictographic}/u, 'patch-notes.md has an emoji in it');
});

test('a tag is one of the three', () => {
  const body = source.slice(source.indexOf('\n## Releases\n'));
  for (const m of body.matchAll(/^- \[([a-z]+)\]/gm)) {
    assert.ok(['new', 'fix', 'faster'].includes(m[1]), `[${m[1]}] is not one of the three tags`);
  }
});

// ---------------------------------------------------------------------------
// The page is the changelog
// ---------------------------------------------------------------------------

test('every release is on the page, in the source order', () => {
  const names = [...prose.matchAll(/<h2 class="pn-name">([^<]+)<\/h2>/g)].map(m => m[1]);
  assert.deepEqual(names, releases.map(r => r.name),
    'the page and the source disagree about which releases there are, or their order');
  for (const r of releases) {
    assert.ok(prose.includes(`>${r.version}</p>`), `the page is missing the version ${r.version}`);
    assert.ok(prose.includes(`>${r.date}</p>`), `the page is missing the date for "${r.name}"`);
  }
});

test('every release is addressable, and nothing on the page is an index', () => {
  // Two halves of one decision. The anchors exist because a release quoted in
  // an issue or kept as a bookmark should land on that release - they are for
  // links written elsewhere.
  for (const r of releases) {
    assert.ok(prose.includes(`id="${idOf(r.name)}"`),
      `"${r.name}" is not reachable at /patch#${idOf(r.name)}`);
  }
  // And nothing here links to one. The changelog is a single column read top to
  // bottom; a list of eleven codenames beside it is a second way to navigate a
  // page that needs one. This half is a test because it is the thing somebody
  // adds back on a quiet afternoon.
  assert.doesNotMatch(prose, /href="#r-/,
    'the page has grown an index of the releases');
});

test('the tally is counted rather than typed', () => {
  // Three numbers the page states about itself. The release count is the one
  // that can be checked from here without reimplementing the generator, and it
  // is the one somebody would otherwise leave at "ten" for a year.
  assert.ok(prose.includes(`<span>${releases.length} releases</span>`),
    `the page does not say there are ${releases.length} releases`);
});

// ---------------------------------------------------------------------------
// The page is dressed by the app, and is not the app
// ---------------------------------------------------------------------------

test('the page is the app, and its body is index.html byte for byte', () => {
  // The whole design in one assertion. /patch runs the app so that the panel on
  // it is the app's panel - the real tab strip, the real sections built by
  // ui/panel.ts from ui/settings-schema.ts, the real Credits sheet - rather than
  // a hand-written likeness. Three attempts at a likeness produced three
  // different sidebars and none of them was this one.
  //
  // Compared whole rather than sampled: a shell copy that has drifted is the
  // failure this test exists for, and "does it still have a #sidebar" would not
  // catch a section added next door. patch.css hides the board furniture; that
  // is a stylesheet's job and not a reason to edit the copy.
  assert.match(prose, /<script type="module" src="assets\/app\.js">/,
    'patch.html does not load the bundle, so its sidebar would be an empty shell');
  const bodyOf = html => {
    const s = html.indexOf('<body');
    return html.slice(html.indexOf('>', s) + 1, html.lastIndexOf('</body>'));
  };
  const mine = bodyOf(html);
  const cut = mine.indexOf('<main class="pn">');
  assert.ok(cut > 0, 'patch.html has no changelog in it');
  assert.ok(mine.slice(0, cut).includes(bodyOf(read(join(WEB, 'index.html'))).trim()),
    'patch.html is no longer index.html body plus the changelog - the shell copy '
    + 'has drifted, so run `node tools/gen-patch-page.mjs`');
});

test('the page wears the app cascade, with patch.css last', () => {
  // Copied out of index.html at build time rather than listed here, so a
  // stylesheet added to the app dresses this page in the same commit. tokens.css
  // is the one that matters most: it carries the three whimsy printings, and
  // without it the page has no look at all rather than a plain one.
  for (const sheet of ['tokens.css', 'base.css', 'sidebar.css', 'quality.css']) {
    assert.ok(prose.includes(`href="assets/css/${sheet}"`), `patch.html does not load ${sheet}`);
  }
  const patch = prose.indexOf('href="assets/css/patch.css"');
  const tokens = prose.indexOf('href="assets/css/tokens.css"');
  assert.ok(patch > tokens, 'patch.css is not after the app cascade, so it cannot correct it');
  assert.ok(prose.indexOf('</head>') > patch, 'patch.css is not in the head');
});

test('the look is restored before first paint, from the same bytes as the app', () => {
  // What makes the page follow the whimsy dial. The script is index.html's own,
  // copied whole - so it hashes to a value web/_headers already carries (see
  // tests/csp.test.js) and it cannot drift from the app's idea of a saved look.
  const INLINE = /<script>([\s\S]*?)<\/script>/g;
  const mine = [...html.replace(/\r\n?/g, '\n').matchAll(INLINE)].map(m => m[1]);
  const theirs = [...read(join(WEB, 'index.html')).replace(/\r\n?/g, '\n').matchAll(INLINE)]
    .map(m => m[1]);
  assert.ok(mine.some(s => theirs.includes(s)),
    'patch.html carries no script that index.html also carries - the pre-paint '
    + 'restore has been rewritten rather than copied, so the page will flash the '
    + 'default look and the CSP hash is now its own');
  assert.ok(mine.some(s => s.includes('data-whimsy') || s.includes('dataset.whimsy')),
    'nothing on the page puts the saved whimsy level on <html>');
});

test('the sidebar is whole: the shell for it, and the tabs it fills at runtime', () => {
  // The two halves the panel needs. The markup is the shell - the head, the tab
  // strip and the body - and ui/panel.ts pours all three tabs into it from the
  // schema when the bundle runs, which is why nothing here looks for a section
  // by name: there are none in the file, and that is the point.
  for (const bit of ['id="sidebar"', 'id="menu-btn"', 'id="side-close"',
    'class="side-head"', 'class="wordmark"', 'class="side-tabs"',
    'class="side-body"', 'class="side-foot"', 'id="version"']) {
    assert.ok(prose.includes(bit), `the sidebar shell is missing ${bit}`);
  }
  // And the sheets that dress it, which the load block brings. quality.css is
  // in the pair because it is what sets each whimsy stop label in the face of
  // the tier it names - the dial says what it does by how it is set.
  for (const sheet of ['sidebar.css', 'quality.css']) {
    assert.ok(prose.includes(`href="assets/css/${sheet}"`), `patch.html does not load ${sheet}`);
  }
});

test('the board furniture is hidden by the stylesheet, not left out of the copy', () => {
  // The shell arrives whole - it has to, or the panel is not the app's - so the
  // viewport and the toolbar are in the document and patch.css puts them away.
  // If somebody ever "tidies" them out of the generator, this says why not.
  assert.ok(prose.includes('id="viewport"'), 'the shell copy has been edited, not just dressed');
  const css = read(join(WEB, 'assets', 'css', 'patch.css'));
  assert.match(css, /body\.is-patch[^{]*#viewport/,
    'patch.css no longer hides the board furniture');
  assert.match(prose, /<body class="is-patch">/, 'the page does not carry the is-patch hook');
});

test('no inline style attribute anywhere, which the policy forbids outright', () => {
  // style-src is 'self' plus two hashes and no 'unsafe-inline'. A hash covers an
  // element, never an attribute, so a style= on this page is a rule the deploy
  // silently drops - and the way that shows up is one thing out of place, only
  // over there. See the head of web/_headers.
  assert.doesNotMatch(prose, /\sstyle="/, 'patch.html carries an inline style attribute');
});

test('no base tag, so the index rows stay on the page', () => {
  // index.html carries <base href="/"> because it is served at every address it
  // does not have. This page is served at one, and a base here would be actively
  // wrong: a fragment-only href resolves against the base rather than the
  // document, so every row in the sidebar's index would point at /#r-something
  // and load a board instead of scrolling. It shipped once and did exactly that.
  //
  // Read from the comment-stripped copy: the head carries a comment naming the
  // tag and saying why it is absent, and that note is the thing most likely to
  // stop somebody putting it back.
  assert.doesNotMatch(prose, /<base\b/, 'patch.html has a <base> tag');
});

// ---------------------------------------------------------------------------
// The way in, and the way it is served
// ---------------------------------------------------------------------------

test('the page and its stylesheet are precached, and the old board is not', () => {
  const sw = read(join(WEB, 'sw.js'));
  for (const path of ['./patch.html', './assets/css/patch.css']) {
    assert.ok(sw.includes(`'${path}'`), `${path} is not in SHELL in sw.js`);
  }
  // The .mbrd went with the board design. A SHELL entry with no file behind it
  // fails the install outright, so this is not a tidiness check.
  assert.doesNotMatch(sw, /patch-notes\.mbrd/, 'sw.js still precaches the changelog board');
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
  // The check the others rest on. Everything above reads the built page and
  // holds it to the source; this one proves it was actually built from it,
  // rather than hand-edited afterwards into something that happens to pass. A
  // generated file somebody has patched by hand is the worst of both -
  // authoritative-looking, and gone the next time the tool runs.
  //
  // Run for real rather than reimplemented: a second copy of the generator in
  // here would only prove the two copies agree.
  const before = read(join(WEB, 'patch.html'));
  execFileSync(process.execPath, [join(ROOT, 'tools', 'gen-patch-page.mjs')], { cwd: ROOT });
  assert.equal(before, read(join(WEB, 'patch.html')),
    'web/patch.html is not what the generator produces - it is built from '
    + 'index.html and patch-notes.md, so run `node tools/gen-patch-page.mjs`');
});
