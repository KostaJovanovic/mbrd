// Build web/patch.html from patch-notes.md.
//
//   node tools/gen-patch-page.mjs [output-path]
//
// Takes index.html's <head> (fonts, cascade, pre-paint script) and appends the
// changelog as prose. No sidebar, no toolbar, no bundle — a document only.
// The pre-paint script is copied byte-for-byte (same CSP hash). The whimsy
// axis dresses the page in the reader's saved look; patch.css defines the three
// printings. main.ts's isPatch branch is not dead — sw.js precaches this page.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'patch-notes.md');
const SHELL = join(ROOT, 'web', 'index.html');
// Optional path argument writes elsewhere (for inspection without overwriting).
const OUT = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'web', 'patch.html');

const SITE = 'https://mbrd.valjdakosta.com';

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/** Split on "## Releases" — prose above it is the writing guide, not content. */
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
    // Continuation line — join to previous bullet (the page handles wrapping).
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

/** Stable anchor from codename (not a counter — stays valid as releases are added). */
const idOf = name => 'r-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Commit count from the version span (version = commit count, see save.bat).
 * Null if unparseable — an empty margin beats a wrong number. */
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

/**
 * The app's name set in the app's face, the same `.wm` the app itself uses.
 *
 * Runs on the *output* of inline(), after escaping and after the three marks,
 * so the span it adds is the only unescaped markup in the string and cannot be
 * produced by anything in patch-notes.md.
 *
 * Two exclusions, both because the name is not always the name. `<code>` spans
 * are stepped over whole - `mbrd.cmds.connectSelection()` is a handle somebody
 * types, and a wordmark in the middle of a code span is the mark appearing
 * where it means nothing. And a preceding `.` or word character keeps it off a
 * file extension, so "a .mbrd file" stays a format being named.
 *
 * Lookahead is used freely here and would be a bug in web/assets/js - this file
 * runs in Node, not in a browser, so the Safari floor tests/engine-floor.test.js
 * guards does not apply to it.
 */
const wordmark = html => html
  .split(/(<code>[\s\S]*?<\/code>)/)
  .map(part => part.startsWith('<code>') ? part : part.replace(
    /(^|[^.\w])(mbrd\.?(?![\w.]))/g,
    (_, before, name) => `${before}<span class="wm">${name}</span>`,
  ))
  .join('');

/** The source's inline flavour as markup, escaped first so no source can inject. */
const inline = s => wordmark(esc(s)
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/_([^_]+)_/g, '<em>$1</em>'));

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

  const stamps = readFileSync(join(ROOT, 'web', 'assets', 'js', 'version.js'), 'utf8');
  // The app's own count, not the sum of the spans. The two agree as long as the
  // releases tile the history from the first commit to this one - but this is
  // still the number read off version.js rather than added up from the page,
  // because it
  // is the number in the foot of the app's sidebar and a reader comparing the
  // two should find one figure and not two derivations of it.
  const commits = (stamps.match(/const COMMIT_COUNT = (\d+)/) || [])[1] || '';
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
<meta property="og:image:alt" content="The mbrd wordmark on a card in the middle of a board of photos, a video, a note, a sound clip and colour swatches, joined by threads.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Patch notes - mbrd">
<meta name="twitter:description" content="${SHORT}">
<meta name="twitter:image" content="${SITE}/assets/img/og.png">
<meta name="twitter:image:alt" content="The mbrd wordmark on a card in the middle of a board of photos, a video, a note, a sound clip and colour swatches, joined by threads.">

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
    <span><span class="wm">mbrd</span> by valjdakosta</span>
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
