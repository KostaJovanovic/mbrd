// The Content-Security-Policy, and the four ways it can go stale in silence.
//
// web/_headers is the only file in this repository that nothing in this
// repository executes. tools/serve.py sends no headers, so the dev server runs
// with no policy at all; the deployed host reads the file and enforces it. That
// gap is the whole reason this file exists - between "it works locally" and "it
// works on the deploy" there is no step that would tell anybody, and a CSP
// failure is not a stack trace. It is a picture that does not draw, a font that
// falls back, an embed that stays a link.
//
// Four things drift, and each one is checked in both directions here:
//
//   - the inline-script hashes. Change one byte inside <script> in index.html
//     and the deployed page loses its pre-paint appearance restore: an
//     installed PWA flashes the default pigment on every launch, and only on
//     the deploy. The hashes are checked against the actual bytes, and the
//     bytes against the hashes, so an edit to either side fails loudly.
//   - the embed hosts. canvas/embed.ts is the only place in the app that talks
//     to a third party; a provider added there and not here is a card whose
//     "Watch here" button swaps in a frame that never loads.
//   - the one remote host in connect-src, which comes from optimize/media.ts.
//   - the worker exemption path, which is a URL written as a string in one file
//     and as a path in another, with nothing between them.
//
// What this file cannot check is whether a directive is *too tight* - whether
// some renderer needs a scheme nobody thought of. That is a browser question
// and it is answered by opening the deploy, which is the same answer the suite
// gives for pan and zoom. See the header of web/_headers for what each
// directive is for and what tightening it further would cost.

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WEB, JS, read, walk } from './helpers.js';

const HEADERS = join(WEB, '_headers');

/**
 * The _headers file, parsed the way the host parses it.
 *
 * The format is three kinds of line: a comment starting with #, a rule path
 * starting at column 0, and an indented `Name: value` (or `! Name`, which
 * removes a header the broader rules set) belonging to the rule above it.
 * Anything else is a typo, and a typo in this file is not an error anywhere -
 * the host skips the line and serves the page with one fewer header on it.
 */
function parse(text) {
  const rules = [];
  const junk = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      if (!line.startsWith('/')) { junk.push(line); continue; }
      rules.push({ path: line.trim(), set: new Map(), removed: [] });
      continue;
    }
    const body = line.trim();
    const rule = rules.at(-1);
    if (!rule) { junk.push(line); continue; }
    if (body.startsWith('! ')) { rule.removed.push(body.slice(2).trim()); continue; }
    const at = body.indexOf(':');
    if (at < 1) { junk.push(line); continue; }
    rule.set.set(body.slice(0, at).trim(), body.slice(at + 1).trim());
  }
  return { rules, junk };
}

const { rules, junk } = parse(read(HEADERS));
const site = rules.find(r => r.path === '/*');
const policy = site?.set.get('Content-Security-Policy') ?? '';

/** The policy as directive name -> source list, which is how CSP reads it. */
const directives = new Map(
  policy.split(';').map(part => part.trim()).filter(Boolean)
    .map(part => {
      const [name, ...sources] = part.split(/\s+/);
      return [name.toLowerCase(), sources];
    })
);

/** Every token in the policy, once, whichever directive it came from. */
const tokens = [...directives.values()].flat();

// ---------------------------------------------------------------------------
// The file itself
// ---------------------------------------------------------------------------

test('the policy is served to the whole site and parses', () => {
  assert.ok(existsSync(HEADERS), 'web/_headers is gone - the deploy has no CSP');
  assert.deepEqual(junk, [], `lines the host would skip: ${junk.join(' | ')}`);
  // Guards the guard: every assertion below reads `directives`, and an empty
  // map would let all of them pass while the deploy ran with no policy at all.
  assert.ok(site, 'no /* rule - the policy would only cover whatever path it names');
  assert.ok(directives.size >= 14,
    `only ${directives.size} directives parsed - has the header value been split across lines?`);
  // A header value is one line. Folding it would not be a style choice; the
  // host would send the first line and drop the rest.
  assert.ok(!policy.includes('\n'), 'the policy value spans lines');
});

test('every directive names at least one source', () => {
  // An empty directive is not "unset", it is "'none'" - `img-src;` blocks every
  // image on the board. The commonest way to write one is deleting the last
  // source out of a list while tightening.
  for (const [name, sources] of directives) {
    assert.ok(sources.length > 0, `${name} has no sources - that is an accidental 'none'`);
  }
});

test("'none' is never written beside something else", () => {
  // 'none' means nothing at all and a browser ignores every other source in the
  // list when it is present - so `object-src 'none' https://x` is not a
  // narrowing, it is a directive that silently forbids the thing it names.
  for (const [name, sources] of directives) {
    if (sources.includes("'none'")) {
      assert.equal(sources.length, 1, `${name} has 'none' alongside ${sources.join(' ')}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The inline scripts
// ---------------------------------------------------------------------------

/**
 * Every inline <script> the app ships, as [hash, where].
 *
 * Swept over web/*.html rather than listed, for the reason tests/icons.test.js
 * sweeps for <use href>: a list is only correct until the next page grows a
 * script. 404.html is a byte copy of index.html and contributes the same two
 * hashes, which is the right answer rather than a duplicate to filter - if it
 * ever stops matching, tests/notfound.test.js says so first.
 *
 * Newlines are normalised to \n before hashing because that is what a browser
 * hashes: the HTML parser rewrites CRLF in the input stream before the
 * tokeniser ever sees it, so a file checked out with CRLF endings still has to
 * produce these hashes. .gitattributes pins the tree to LF, which makes this
 * belt and braces - but the braces cost one call and the belt is a setting.
 */
const INLINE = /<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/g;

const inlineScripts = readdirSync(WEB)
  .filter(name => name.endsWith('.html'))
  .flatMap(name => [...read(join(WEB, name)).replace(/\r\n?/g, '\n').matchAll(INLINE)]
    .map(m => [
      'sha256-' + createHash('sha256').update(m[2], 'utf8').digest('base64'),
      `${name} <script ${m[1].trim()}>`.replace(' >', '>'),
    ]));

/**
 * The same for inline <style> blocks.
 *
 * These are hashed for the same reason the scripts are, and they became
 * hashable only once the last `style=` attribute in the tree was gone - a hash
 * covers an element, never an attribute, and a browser ignores 'unsafe-inline'
 * the moment any hash is present, so the two cannot be mixed. See the style-src
 * section of web/_headers.
 */
const INLINE_STYLE = /<style(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/style>/g;

const inlineStyles = readdirSync(WEB)
  .filter(name => name.endsWith('.html'))
  .flatMap(name => [...read(join(WEB, name)).replace(/\r\n?/g, '\n').matchAll(INLINE_STYLE)]
    .map(m => [
      'sha256-' + createHash('sha256').update(m[2], 'utf8').digest('base64'),
      `${name} <style ${m[1].trim()}>`.replace(' >', '>'),
    ]));

/** Hashes per directive, because a script hash in style-src would allow nothing. */
const hashesIn = name => new Set((directives.get(name) ?? [])
  .filter(t => t.startsWith("'sha")).map(t => t.slice(1, -1)));
const scriptHashes = hashesIn('script-src');
const styleHashes = hashesIn('style-src');

test('the policy carries a hash for every inline script in the app', () => {
  assert.ok(inlineScripts.length >= 4,
    `only ${inlineScripts.length} inline scripts found - has the regex stopped matching?`);
  const missing = inlineScripts.filter(([hash]) => !scriptHashes.has(hash));
  assert.deepEqual(missing, [],
    `no hash in web/_headers for: ${missing.map(([h, where]) => `${where} (${h})`).join(', ')}`);
});

test('the policy carries no hash for a script that is gone', () => {
  // The other direction, and the one that rots quietly: a stale hash allows
  // nothing and costs nothing, so it survives every deploy and every reading,
  // and the next person cannot tell which of five hashes is load-bearing.
  const asked = new Set(inlineScripts.map(([hash]) => hash));
  const orphans = [...scriptHashes].filter(hash => !asked.has(hash));
  assert.deepEqual(orphans, [], `hashes matching no inline script: ${orphans.join(', ')}`);
});

test('the policy carries a hash for every inline style, and none for one that is gone', () => {
  // Both directions in one test, because a style hash has a sharper failure
  // than a script hash and the two halves are the same sentence. A block whose
  // hash has drifted is not refused loudly - the browser simply declines to
  // apply it, and the page renders unstyled. So this is the only thing standing
  // between a one-character edit and a deploy that looks like a broken
  // stylesheet.
  assert.ok(inlineStyles.length >= 2,
    `only ${inlineStyles.length} inline style blocks found - has the regex stopped matching?`);

  const missing = inlineStyles.filter(([hash]) => !styleHashes.has(hash));
  assert.deepEqual(missing, [],
    `no hash in web/_headers for: ${missing.map(([h, where]) => `${where} (${h})`).join(', ')}`);

  const asked = new Set(inlineStyles.map(([hash]) => hash));
  const orphans = [...styleHashes].filter(hash => !asked.has(hash));
  assert.deepEqual(orphans, [], `hashes matching no inline style: ${orphans.join(', ')}`);
});

test('style-src allows nothing but self and those hashes', () => {
  // The directive this app spent a while unable to tighten. It is only holdable
  // while nothing writes a style attribute: assigning .style through the CSSOM
  // is outside CSP, but a `style="..."` parsed from markup is not, and one of
  // those anywhere in web/ would silently stop applying under this policy.
  const sources = directives.get('style-src') ?? [];
  assert.ok(sources.includes("'self'"), 'style-src has no self - the stylesheets would not load');
  assert.ok(!sources.includes("'unsafe-inline'"),
    "style-src has taken 'unsafe-inline' back - the hashes below it are now dead weight, "
    + 'since a browser ignores the keyword whenever a hash is present');
  const rest = sources.filter(s => s !== "'self'" && !s.startsWith("'sha"));
  assert.deepEqual(rest, [], `style-src has grown a source: ${rest.join(' ')}`);
});

test('nothing in web/ writes a style attribute', () => {
  // The invariant the directive above rests on, checked at its source rather
  // than inferred. Markup and modules both: a template string that interpolates
  // a runtime value into style="..." is the exact shape that cannot be hashed,
  // and it is how this policy was stuck at 'unsafe-inline' to begin with.
  const offenders = [];
  for (const name of readdirSync(WEB).filter(n => n.endsWith('.html'))) {
    const src = read(join(WEB, name));
    // Strip comments first - the reasoning about this rule mentions the pattern.
    if (/style\s*=\s*["']/.test(src.replace(/<!--[\s\S]*?-->/g, ''))) offenders.push(name);
  }
  for (const rel of walk(JS, ['.ts', '.js'])) {
    const src = read(join(WEB, rel));
    if (/setAttribute\(\s*['"]style['"]/.test(src)) offenders.push(`${rel} (setAttribute)`);
    // The half the comment above promised and the check did not do. Scanning
    // only for setAttribute left the shape it actually names - a template
    // string interpolating into style="..." - completely uncovered, and
    // innerHTML and insertAdjacentHTML are live in canvas/item-dom.ts,
    // canvas/transport.ts and canvas/video.ts. Such an attribute is legal
    // JavaScript, reaches the DOM, and is then dropped by style-src on the
    // deploy and nowhere else, so it works in front of whoever wrote it.
    //
    // Comments come off first: this rule is discussed in prose in several
    // module headers. Block comments in full, line comments only where the //
    // opens the line, so that a 'https://...' inside a string literal survives
    // for the connect-src check further down.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    if (/\bstyle\s*=\s*\\?["']/.test(code)) offenders.push(`${rel} (style= in a string)`);
  }
  assert.deepEqual(offenders, [],
    `these write a style attribute, which style-src will refuse: ${offenders.join(', ')}`);
});

test('script-src allows nothing but self and those hashes', () => {
  const sources = directives.get('script-src') ?? [];
  assert.ok(sources.includes("'self'"), 'script-src has no self - assets/app.js would not load');
  const rest = sources.filter(s => s !== "'self'" && !s.startsWith("'sha"));
  assert.deepEqual(rest, [],
    `script-src has grown a source: ${rest.join(' ')} - a host here is a place an injected <script> can come from`);
});

test("no directive allows 'unsafe-inline' for script", () => {
  // A browser ignores 'unsafe-inline' for scripts the moment a hash is present,
  // so adding it would not break the deploy - it would sit in the file reading
  // like a permission the policy grants, and be honoured the day somebody
  // removes the last hash.
  for (const name of ['script-src', 'script-src-elem', 'script-src-attr', 'default-src']) {
    const sources = directives.get(name) ?? [];
    assert.ok(!sources.includes("'unsafe-inline'"), `${name} allows inline script`);
  }
});

test('nothing in the policy allows eval', () => {
  // Compared as whole tokens, not with includes(): 'wasm-unsafe-eval' has
  // 'unsafe-eval' inside it and is a different and much narrower permission, so
  // a substring check here would be right for the wrong reason and would go on
  // being right if somebody swapped one for the other.
  const evals = tokens.filter(t => t === "'unsafe-eval'" || t === "'wasm-unsafe-eval'");
  assert.deepEqual(evals, [],
    `${evals.join(' ')} in the policy - nothing in web/ calls eval, new Function or WebAssembly on the main thread`);
});

// ---------------------------------------------------------------------------
// The hosts, against the code they came from
// ---------------------------------------------------------------------------

/** Every host canvas/embed.ts will actually put in an iframe src. */
const embedHosts = [...read(join(JS, 'canvas', 'embed.ts'))
  .matchAll(/src: `(https:\/\/[^/`]+)/g)].map(m => m[1]);

test('frame-src is exactly the hosts canvas/embed.ts frames', () => {
  assert.ok(embedHosts.length >= 2,
    `only ${embedHosts.length} embed hosts found in embed.ts - has the src template moved?`);
  const framed = directives.get('frame-src') ?? [];
  const missing = [...new Set(embedHosts)].filter(h => !framed.includes(h));
  assert.deepEqual(missing, [],
    `embed.ts frames ${missing.join(' ')} and frame-src does not allow it - the player would never load`);
  const extra = framed.filter(h => !embedHosts.includes(h));
  assert.deepEqual(extra, [],
    `frame-src allows ${extra.join(' ')}, which embed.ts never frames`);
});

test('no module names a remote host the policy does not allow', () => {
  // The general form of the check below, and the one that was missing.
  // csp.test.js greps optimize/media.ts by name for its host, so a *second*
  // module reaching for a CDN was invisible: import/pdf.ts loaded pdf.js from
  // cdn.jsdelivr.net against `script-src 'self'` and pointed a worker at it
  // against `worker-src 'self'`, so PDF import and viewing were dead on the
  // deploy and alive under serve.py, which sends no headers. The catch turned
  // both refusals into a grey card. The URL was in the committed bundle - it is
  // what shipped.
  //
  // Comments are stripped first: half the modules here discuss hosts in prose,
  // and _headers is itself quoted in a few of them. What is left is a URL that
  // opens a string literal or a template, which is a URL the code will use.
  const allowed = new Set(
    [...directives.values()].flat().filter(s => s.startsWith('http')).map(s => s.replace(/\/$/, '')));

  /**
   * Hosts that appear in a string and are never fetched.
   *
   * Each of these is here for a stated reason, which is the point: the check is
   * worth nothing if the way past it is to add a name. A URL in a module is
   * either something the app will load - and then the policy has to carry it -
   * or one of these three shapes.
   */
  const NOT_FETCHED = new Map([
    // The XML and SVG namespaces, handed to createElementNS. A namespace is an
    // identifier that happens to look like an address; nothing resolves it.
    ['http://www.w3.org', 'an XML namespace, not an address'],
    // Recognised, not requested: canvas/embed.ts matches a pasted watch link
    // and rewrites it to youtube-nocookie.com, which frame-src does carry.
    ['https://www.youtube.com', 'matched when a link is pasted, then rewritten'],
    // A placeholder in a field.
    ['https://example.com', 'placeholder text'],
  ]);

  const offenders = [];
  for (const rel of walk(JS, ['.ts', '.js'])) {
    const code = read(join(WEB, rel))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    for (const m of code.matchAll(/['"`](https?:\/\/[^/'"`]+)/g)) {
      if (!allowed.has(m[1]) && !NOT_FETCHED.has(m[1])) offenders.push(`${rel} -> ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(offenders)], [],
    'these reach a host the policy does not carry, so they work under serve.py '
    + 'and are refused on the deploy');
});

test('connect-src carries the one host the app fetches from', () => {
  // optimize/media.ts is the only outbound request mbrd makes on its own. The
  // check is on the host rather than the whole URL because that is all CSP
  // matches on, and the version in the path is expected to move.
  //
  // Matched only where the URL *opens a string literal*. It used to be the
  // first `https://` anywhere in the file, which a sentence of prose in the
  // module header could retarget - the check would then assert connect-src
  // against a host the code never fetches, and pass while the real one was
  // missing. A quote in front of it is what makes it code.
  const core = /['"`]https:\/\/([^/'"`]+)\//.exec(read(join(JS, 'optimize', 'media.ts')));
  assert.ok(core, 'no absolute URL in optimize/media.ts - has the core moved?');
  const sources = directives.get('connect-src') ?? [];
  assert.ok(sources.includes(`https://${core[1]}`),
    `optimize/media.ts fetches ${core[1]} and connect-src does not allow it`);
});

test('no remote host reaches anything that renders a document', () => {
  // The directives that would have caught a "renderer follows a URL out of a
  // .mbrd" bug outright, whatever the code did. A board renders the same with
  // the network off; these three are what make that a guarantee rather than a
  // habit, and the only way to lose it is to add a host here.
  for (const name of ['default-src', 'img-src', 'media-src', 'font-src', 'style-src']) {
    const remote = (directives.get(name) ?? []).filter(s => s.includes('//'));
    assert.deepEqual(remote, [], `${name} allows a remote host: ${remote.join(' ')}`);
  }
});

test('no source is a wildcard', () => {
  // `*`, `https:`, `*.example.com` - each of them turns a directive into a
  // sentence about a category rather than about this app, and each is the
  // shape a tightening becomes when somebody is in a hurry.
  const wild = tokens.filter(t => t === '*' || t.startsWith('*.') || t.includes('://*') || /^https?:$/.test(t));
  assert.deepEqual(wild, [], `wildcard sources: ${wild.join(' ')}`);
});

// ---------------------------------------------------------------------------
// The deliberate 'none's, and the one that cannot be
// ---------------------------------------------------------------------------

test('the plugin and form surfaces are shut', () => {
  assert.deepEqual(directives.get('object-src'), ["'none'"],
    "object-src must be 'none' - there is no <object> or <embed> in this app");
  assert.deepEqual(directives.get('form-action'), ["'none'"],
    "form-action must be 'none' - there is not one <form> in web/, because there is no server");
  assert.deepEqual(directives.get('frame-ancestors'), ["'none'"],
    "frame-ancestors must be 'none' - a page that frames a canvas is a clickjack over somebody's work");
});

test("base-uri is 'self' and not 'none', for the reason index.html gives", () => {
  // The one place the tight answer is the wrong one. <base href="/"> is
  // load-bearing: the same document is served as the 404 at arbitrary paths,
  // and 'none' would kill the tag and send the app looking for its modules in
  // whatever directory the bad URL happened to name.
  assert.deepEqual(directives.get('base-uri'), ["'self'"]);
  assert.match(read(join(WEB, 'index.html')), /<base href="\/">/,
    "index.html has lost its <base> - then base-uri could be 'none'; see wrangler.jsonc");
});

// ---------------------------------------------------------------------------
// The worker exemptions
// ---------------------------------------------------------------------------

/**
 * The two workers allowed to run without the site policy, each derived from the
 * code that names it rather than written out here.
 *
 * Two rather than one since the pdf.js worker was added: it carries an Emscripten
 * OpenJPEG build and compiles it with new WebAssembly.Module, which the policy
 * forbids - so every PDF holding a JPEG 2000 image came back as a grey card while
 * ordinary ones rendered. See the note beside the rule in web/_headers.
 *
 * Derived, because a URL written as a string in one file and as a path in another
 * with nothing between them is exactly the pair that drifts. A rename would leave
 * the rule pointing at nothing and the worker inheriting the site policy, which
 * forbids the one thing it exists to do - and the way that shows is a feature
 * quietly not being offered.
 */
function spawnedWorkers() {
  const media = /new Worker\('([^']+)'\)/.exec(read(join(JS, 'optimize', 'media.ts')));
  assert.ok(media, 'optimize/media.ts no longer spawns a worker - is the exemption still needed?');

  const pdf = read(join(JS, 'import', 'pdf.ts'));
  const dir = /PDF_DIR = '([^']+)'/.exec(pdf);
  const worker = /workerSrc = pdfURL\('([^']+)'\)/.exec(pdf);
  assert.ok(dir && worker, 'import/pdf.ts no longer points pdf.js at a worker of its own');

  return [media[1], dir[1] + worker[1]].map(url => url.replace(/^\.?\//, '/'));
}

test('the exempted paths are the workers the app actually spawns', () => {
  const exempt = rules.filter(r => r.removed.includes('Content-Security-Policy'));
  const wanted = spawnedWorkers();
  assert.deepEqual(exempt.map(r => r.path).sort(), [...wanted].sort(),
    'a path drops the policy that is not one of the two workers, or a worker has lost its rule '
    + '- each unlisted one is a page or a script running unprotected');
  for (const rule of exempt) {
    assert.ok(existsSync(join(WEB, rule.path.slice(1))), `${rule.path} does not exist`);
  }
});

test('nothing but those workers is exempted, and no page is', () => {
  for (const rule of rules) {
    if (!rule.removed.length) continue;
    // .mjs as well as .js: the vendored pdf.js worker is an ES module, which is
    // how pdf.js spawns it - new Worker(src, { type: 'module' }).
    assert.match(rule.path, /\.m?js$/, `${rule.path} drops a header and is not a script`);
    assert.ok(!rule.path.includes('*'), `${rule.path} exempts a whole tree, not one file`);
  }
});
