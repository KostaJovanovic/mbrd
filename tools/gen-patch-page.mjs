// Build the changelog page, from patch-notes.md at the repository root.
//
//   node tools/gen-patch-page.mjs
//
// One output, and it is not hand-editable:
//
//   web/patch.html   index.html's entire body, the app running on it, and the
//                    changelog as the thing it shows instead of a board.
//
// ── The app's cascade, not the app ──
//
// **This page is a document and nothing else.** It takes index.html's head -
// the fonts, the twenty stylesheets in cascade order, and the pre-paint script
// that puts the reader's saved look on <html> - and then its own prose. No
// sidebar, no toolbar, no viewport, no bundle.
//
// It was not always. The page used to be index.html's entire *body*, copied
// verbatim, so that the app booted on it and the panel over the changelog was
// the app's real panel rather than a likeness that drifts. That argument was
// sound and the thing it bought is gone: the sidebar has been taken off this
// page, and once it is off, everything the copy was for goes with it. What the
// copy left behind was a changelog shipping half a megabyte of script to boot
// an empty board nobody could see, and #grain - the app's fixed, full-window
// paper texture - sitting still behind a page whose own texture scrolls, which
// is two sheets of stock over one another and was visible as exactly that.
//
// The head is still lifted rather than listed, and that half of the old design
// is the half worth keeping: a stylesheet added to the app dresses this page in
// the same commit and still in the right place in the cascade, and the look
// restore is the same bytes and therefore the same CSP hash.
//
// ── Nothing you do while reading may change what you own ──
//
// Now trivially true, since nothing here runs. main.ts keeps its isPatch branch
// all the same and it is not dead code: sw.js precaches patch.html, so a
// returning visitor can be handed a cached copy of the page from back when it
// did boot the app. That branch reads no session, stops the writer and freezes
// the preference store, and it is what keeps that copy harmless.
//
// ── The whimsy axis is the design ──
//
// tokens.css carries three personalities keyed off one attribute on <html>:
// 0 Softish is a scrapbook, 1 Middle is that room with the furniture
// straightened, 2 Harsh is a spec sheet. The app writes that attribute from the
// look the visitor set, before first paint, in an inline script this file
// copies out of index.html byte for byte - which is why the copy costs no new
// CSP hash, and why a changed pre-paint script reaches this page in the same
// commit that changes it.
//
// So the changelog arrives dressed the way that visitor's own board is dressed,
// and patch.css says what each of the three printings looks like. There is no
// dial on this page to move it with - that lived in the sidebar - and there is
// nothing here that could write a preference if there were.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'patch-notes.md');
const SHELL = join(ROOT, 'web', 'index.html');
// An argument overrides where the page lands. save.bat and every hand run pass
// nothing and write web/patch.html; a path argument writes elsewhere, which is
// how the output can be inspected without writing over the committed file.
const OUT = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'web', 'patch.html');

const SITE = 'https://mbrd.valjdakosta.com';

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/**
 * Everything under "## Releases", as a list of releases.
 *
 * The prose above that heading is the guide for whoever writes the next entry
 * and is not part of the changelog; splitting on it rather than on the first
 * `##` is what lets that guide use `##` headings of its own.
 */
function parseSource(text) {
  const cut = text.indexOf('\n## Releases\n');
  if (cut < 0) throw new Error('patch-notes.md has no "## Releases" heading');
  const body = text.slice(cut + '\n## Releases\n'.length);

  const releases = [];
  let current = null;
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^## (.+)$/))) {
      current = { name: m[1].trim(), version: '', date: '', parts: [{ head: null, bullets: [] }] };
      releases.push(current);
      continue;
    }
    if (!current) {
      if (line.trim()) throw new Error(`stray line before the first release: ${line}`);
      continue;
    }
    if ((m = line.match(/^version:\s*(.+)$/))) { current.version = m[1].trim(); continue; }
    if ((m = line.match(/^date:\s*(.+)$/))) { current.date = m[1].trim(); continue; }
    if ((m = line.match(/^### (.+)$/))) {
      current.parts.push({ head: m[1].trim(), bullets: [] });
      continue;
    }
    if ((m = line.match(/^- (.+)$/))) {
      let body = m[1].trim();
      let tag = null;
      const t = body.match(/^\[(new|fix|faster)\]\s*/);
      if (t) { tag = t[1]; body = body.slice(t[0].length); }
      current.parts.at(-1).bullets.push({ tag, body });
      continue;
    }
    // An indented line continues the bullet above it. Every bullet used to have
    // to be one line, which at this length meant lines of three hundred
    // characters in a repository that wraps everything else at eighty - so the
    // source was the one file nobody could read in the editor it was written
    // in, and a paragraph could only be revised by retyping all of it.
    //
    // Folded with a single space, which is the whole of the rule: the wrap is a
    // property of the file and not of the sentence, and the page decides its own
    // line breaks from the width it is being read at.
    if ((m = line.match(/^\s+(\S.*)$/))) {
      const bullets = current.parts.at(-1).bullets;
      if (!bullets.length) throw new Error(`continuation before any bullet in "${current.name}": ${line}`);
      bullets.at(-1).body += ' ' + m[1].trim();
      continue;
    }
    if (line.trim()) throw new Error(`unreadable line in "${current.name}": ${line}`);
  }

  for (const r of releases) {
    if (!r.version) throw new Error(`"${r.name}" has no version:`);
    if (!r.date) throw new Error(`"${r.name}" has no date:`);
    if (!r.parts.some(p => p.bullets.length)) throw new Error(`"${r.name}" has no bullets`);
  }
  if (!releases.length) throw new Error('no releases found');
  return releases;
}

/** The tag word as it is printed. */
const TAG_WORD = { new: 'New', fix: 'Fix', faster: 'Faster' };

/**
 * The anchor for a release, derived from its codename rather than counted.
 *
 * So /patch#r-under-the-floor is stable across every release added above it.
 * Nothing on the page links to one - there is no index - so these are for a
 * link somebody else wrote: a release quoted in an issue, or a bookmark.
 */
const idOf = name => 'r-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * How many commits a release covers.
 *
 * A version here is a commit count - `0.187` is the 187th commit, see save.bat
 * - so a span is arithmetic and not a guess, and "0.156 - 0.187" really is
 * thirty-two commits of work. That number is the one piece of information this
 * page has that the prose does not, which is why it is printed in the margin
 * beside each release rather than left implied.
 *
 * A release naming one version covers one commit. A span that will not parse
 * gets nothing printed, because a wrong number in a margin is worse than an
 * empty margin.
 */
function commitsIn(version) {
  const ends = [...version.matchAll(/(\d+)\.(\d+)/g)]
    .map(m => Number(m[1]) * 100 + Number(m[2]));
  if (!ends.length) return null;
  const lo = Math.min(...ends), hi = Math.max(...ends);
  return hi - lo + 1;
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

const esc = s => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/’/g, '&rsquo;').replace(/“/g, '&ldquo;')
  .replace(/”/g, '&rdquo;').replace(/…/g, '&hellip;')
  .replace(/·/g, '&middot;').replace(/‑/g, '&#8209;');

/** The source's inline flavour as markup, escaped first so no source can inject. */
const inline = s => esc(s)
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/_([^_]+)_/g, '<em>$1</em>');

/** One release, as the article it is on the page. */
function buildRelease(r) {
  const out = [];
  const commits = commitsIn(r.version);
  out.push(`<li class="pn-rel" id="${idOf(r.name)}">`);
  // The margin: a mark on the spine and, beside it, the size of the release in
  // the only unit this project has. aria-hidden because the count is furniture
  // to a reader who is being read to - the version span two lines down already
  // says which release this is, and in words that mean something out loud.
  out.push('  <div class="pn-margin" aria-hidden="true">');
  out.push('    <span class="pn-mark"></span>');
  if (commits) out.push(`    <span class="pn-count">${commits}</span>`);
  out.push('  </div>');
  out.push('  <article class="pn-plate">');
  out.push('    <header class="pn-plate-head">');
  out.push(`      <p class="pn-ver">${esc(r.version)}</p>`);
  out.push(`      <h2 class="pn-name">${esc(r.name)}</h2>`);
  out.push(`      <p class="pn-date">${esc(r.date)}</p>`);
  out.push('    </header>');
  for (const part of r.parts) {
    if (!part.bullets.length) continue;
    if (part.head) out.push(`    <h3 class="pn-part">${esc(part.head)}</h3>`);
    out.push('    <ul class="pn-notes">');
    for (const b of part.bullets) {
      const tag = b.tag
        ? `<span class="pn-tag is-${b.tag}">${TAG_WORD[b.tag]}</span>`
        : '';
      out.push(`      <li${b.tag ? '' : ' class="is-plain"'}>${tag}${inline(b.body)}</li>`);
    }
    out.push('    </ul>');
  }
  out.push('  </article>');
  out.push('</li>');
  return out.join('\n');
}

/**
 * The page.
 *
 * Everything index.html loads is taken as one slice rather than matched tag by
 * tag: from its first font preload to the end of its head is a contiguous run
 * holding the two preloads, the twenty stylesheets in cascade order, and the
 * pre-paint script that puts the saved look on <html> before anything is drawn.
 * Lifted rather than listed, so a stylesheet added to the app dresses this page
 * in the same commit, still in the right place in the cascade - and so the look
 * restore is the same bytes and therefore the same CSP hash.
 *
 * **The head and only the head.** index.html's body is not copied; see the note
 * at the top of this file for what that copy was for and why it went with the
 * sidebar. The one thing it took a moment to notice is that the slice below has
 * to keep carrying the inline script, since it is now the whole of what dresses
 * this page - a page that lost it would render in the default pigment for
 * everybody, silently and only on their own machine.
 *
 * patch.css goes after that slice, which is what makes it last: it is the only
 * sheet here that knows this is a document and not a board.
 */
function buildPage(shell, releases, entries) {
  const bodyStart = shell.indexOf('<body>');
  if (bodyStart < 0) throw new Error('index.html has no <body>');

  const head = shell.slice(0, bodyStart);
  const from = head.indexOf('<link rel="preload"');
  const to = head.lastIndexOf('</head>');
  if (from < 0 || to < 0) throw new Error('cannot find the load block in index.html');
  const loads = head.slice(from, to).trim();
  if (!/<script>/.test(loads)) {
    throw new Error('the load block carries no inline script - has the pre-paint restore moved?');
  }
  // Asserted rather than assumed, and this is the assertion that replaced the
  // one about the bundle. A slice that quietly stopped carrying the sheets
  // would give a page of unstyled prose, which is a thing somebody would notice
  // - a slice missing one of them is not.
  if (!loads.includes('assets/css/tokens.css') || !loads.includes('assets/css/base.css')) {
    throw new Error('the load block is missing the app cascade - has the head been reordered?');
  }

  // The version stamp, which the app used to write into the sidebar's foot on
  // this page. There is no sidebar here now, so it is read and printed below.
  const stamps = readFileSync(join(ROOT, 'web', 'assets', 'js', 'version.js'), 'utf8');
  // The app's own count, not the sum of the spans. The two agree as long as the
  // releases tile the history from the first commit to this one - but this is
  // still the number read off version.js rather than added up from the page,
  // because it
  // is the number in the foot of the app's sidebar and a reader comparing the
  // two should find one figure and not two derivations of it.
  const commits = (stamps.match(/const COMMIT_COUNT = (\d+)/) || [])[1] || '';
  const version = (stamps.match(/const VERSION = '([^']+)'/) || [])[1] || '';
  const oldest = releases.at(-1);
  const DESC = 'Every version of mbrd, newest first - what was added, what was fixed and '
    + 'what got faster on the infinite freeform moodboard that runs in your browser.';
  const SHORT = 'Every version of mbrd, newest first - what was added, what was fixed and '
    + 'what got faster.';

  return `<!doctype html>
<html lang="en">
<head>
<!-- GENERATED - do not edit. Run: node tools/gen-patch-page.mjs
     The prose lives in patch-notes.md at the repository root, the only place the
     changelog is written. The load block below is index.html's own, copied at
     build time so this page wears the app's cascade rather than a second
     account of it. See the head of the generator. -->
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<!-- NO <base href="/"> HERE, unlike index.html, and that is a decision.

     The app carries one because it is served at every address it does not
     have. This page is served at exactly one, so it has nothing to fix - and a
     base would break every fragment link on it: a fragment-only href resolves
     against the base rather than the document, so #r-the-viewer would become
     /#r-the-viewer and following it would leave the changelog and load a board.
     It shipped once and did exactly that. -->
<title>Patch notes - mbrd</title>
<meta name="description" content="${DESC}">
<meta name="author" content="valjdakosta">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#faf8f3">
<link rel="canonical" href="${SITE}/patch">
<link rel="icon" href="assets/img/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="assets/img/icon-192.png">

<meta property="og:type" content="article">
<meta property="og:site_name" content="mbrd">
<meta property="og:title" content="Patch notes - mbrd">
<meta property="og:description" content="${SHORT}">
<meta property="og:url" content="${SITE}/patch">
<meta property="og:locale" content="en_US">
<meta property="og:image" content="${SITE}/assets/img/og.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The mbrd wordmark on a paper board, with cards and threads laid across it.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Patch notes - mbrd">
<meta name="twitter:description" content="${SHORT}">
<meta name="twitter:image" content="${SITE}/assets/img/og.png">
<meta name="twitter:image:alt" content="The mbrd wordmark on a paper board, with cards and threads laid across it.">

<!-- The crumb says where this page sits relative to the app; without it a
     crawler reads /patch as a second, unrelated root. -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "mbrd", "item": "${SITE}/" },
    { "@type": "ListItem", "position": 2, "name": "Patch notes", "item": "${SITE}/patch" }
  ]
}
</script>
<!-- Nothing in either block may depend on the releases, and that is a rule
     rather than an oversight. An inline script is admitted by the hash of its
     bytes (script-src in web/_headers, no unsafe-inline), so a block carrying
     the newest version number is a block whose hash rotates every time somebody
     writes a changelog entry - and the failure that buys is not a stack trace,
     it is the deployed page silently refusing its own metadata. It carried
     "version" until v0.195 and did exactly that. The page states every version
     it covers in its own prose; a crawler is not short of them. -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": "mbrd patch notes",
  "description": "${SHORT}",
  "url": "${SITE}/patch",
  "mainEntityOfPage": "${SITE}/patch",
  "image": "${SITE}/assets/img/og.png",
  "author": { "@type": "Person", "name": "valjdakosta" },
  "about": { "@type": "SoftwareApplication", "name": "mbrd", "url": "${SITE}/" }
}
</script>

${loads}

<link rel="stylesheet" href="assets/css/patch.css">
</head>
<body class="is-patch">

<!-- The whole page. index.html's body is NOT copied here - see the head of
     tools/gen-patch-page.mjs. There is no sidebar, no board furniture and no
     bundle: this is a document, and the only thing it takes from the app is the
     cascade above and the look that cascade is read at. -->
<main class="pn">
 <div class="pn-inner">
  <!-- The way back, and it is a real one.

       There is a link in the footer and there has been all along, which is the
       bottom of a page fifteen thousand pixels tall - a way out you have to
       read the whole changelog to reach. So: a button, at the top, that stays
       at the top. Sticky inside the column rather than fixed to the window, so
       it rides the measure and cannot land somewhere different on a phone.

       An <a> and not a button: this is a document, and the way out of a
       document is a link. Nothing on this page runs, so there is nothing else
       it could have been.

       href="/" and not "patch/..", matching the footer: this page carries no
       <base>, and the root is the root. -->
  <a class="pn-back" href="/">
    <svg class="ico" aria-hidden="true"><use href="assets/icons.svg#i-chevron-left"/></svg>
    Back to the board
  </a>
  <header class="pn-head">
    <h1 class="pn-title">Patch notes</h1>
    <p class="pn-lede">What has changed in mbrd, newest first. The things
      worth knowing about, rather than every commit.</p>
    <!-- The three numbers this page can state without anybody writing them
         down: how many releases there are, how many commits they cover, and
         when it started. All counted from the source. -->
    <p class="pn-tally">
      <span>${releases.length} releases</span>
      <span>${commits} commits</span>
      <span>since ${esc(oldest.date)}</span>
    </p>
  </header>

  <ol class="pn-list">
${entries}
  </ol>

  <footer class="pn-foot">
    <span>mbrd ${esc(version)} by valjdakosta</span>
    <a href="/">Back to the board</a>
  </footer>
 </div>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------

const releases = parseSource(readFileSync(SOURCE, 'utf8'));
const page = buildPage(
  readFileSync(SHELL, 'utf8'),
  releases,
  releases.map(buildRelease).join('\n'),
);
writeFileSync(OUT, page);
console.log(`${releases.length} releases`);
console.log(`  ${OUT}  ${page.length} bytes`);
