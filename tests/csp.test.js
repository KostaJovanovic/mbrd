// Hold the CSP in web/_headers in step with the code it protects.
// serve.py sends no headers, so violations are invisible locally — this
// test is the substitute. Checks both directions for four drift surfaces:
// inline-script hashes, inline-style hashes, embed hosts, connect-src
// hosts, and worker exemption paths.

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ROOT, WEB, JS, read, walk } from './helpers.js';
import { parsePolicy } from '../desktop/csp.mts';

const HEADERS = join(WEB, '_headers');
/** The policy as stage-web.mjs hands it to the Android shell. Gitignored. */
const STAGED = join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'assets', 'mbrd-csp.json');

/** Parse _headers: # comments, column-0 paths, indented Name: value or ! Name. */
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
  // An empty map would let every assertion below pass vacuously.
  assert.ok(site, 'no /* rule - the policy would only cover whatever path it names');
  assert.ok(directives.size >= 14,
    `only ${directives.size} directives parsed - has the header value been split across lines?`);
  // The host would send only the first line of a folded value.
  assert.ok(!policy.includes('\n'), 'the policy value spans lines');
});

test('every directive names at least one source', () => {
  // An empty directive is an accidental 'none', not "unset".
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

/** Every inline <script> as [hash, where]. Swept, not listed, so a new page
 * is covered automatically. Newlines normalised to \n (browsers hash LF). */
const INLINE = /<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/g;

const inlineScripts = readdirSync(WEB)
  .filter(name => name.endsWith('.html'))
  .flatMap(name => [...read(join(WEB, name)).replace(/\r\n?/g, '\n').matchAll(INLINE)]
    .map(m => [
      'sha256-' + createHash('sha256').update(m[2], 'utf8').digest('base64'),
      `${name} <script ${m[1].trim()}>`.replace(' >', '>'),
    ]));

/** Inline <style> blocks, same treatment. Hashable only because no style=
 * attribute remains in markup (browsers ignore 'unsafe-inline' with hashes). */
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
  // Stale hashes rot quietly — they allow nothing and nobody notices.
  const asked = new Set(inlineScripts.map(([hash]) => hash));
  const orphans = [...scriptHashes].filter(hash => !asked.has(hash));
  assert.deepEqual(orphans, [], `hashes matching no inline script: ${orphans.join(', ')}`);
});

test('the policy carries a hash for every inline style, and none for one that is gone', () => {
  // A drifted style hash silently drops the block — the page renders unstyled.
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
  // Holds only while no style= attribute exists in markup (CSSOM is fine).
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
    // Also check template strings with style= (innerHTML, insertAdjacentHTML).
    // Strip block comments and line-leading // comments; keep inline // so
    // 'https://...' in string literals survives the connect-src check below.
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
  // Browsers ignore it with hashes present, but it would be honoured the day
  // somebody removes the last hash.
  for (const name of ['script-src', 'script-src-elem', 'script-src-attr', 'default-src']) {
    const sources = directives.get(name) ?? [];
    assert.ok(!sources.includes("'unsafe-inline'"), `${name} allows inline script`);
  }
});

test('nothing in the policy allows eval', () => {
  // Whole-token compare: 'wasm-unsafe-eval' contains 'unsafe-eval' as a
  // substring but is a different, narrower permission.
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
  // Sweep all modules for remote hosts the policy does not carry.
  // Comments stripped first (modules discuss hosts in prose).
  const allowed = new Set(
    [...directives.values()].flat().filter(s => s.startsWith('http')).map(s => s.replace(/\/$/, '')));

  /** Hosts in code that are never fetched — each must have a stated reason. */
  const NOT_FETCHED = new Map([
    ['http://www.w3.org', 'XML/SVG namespace, not an address'],
    ['https://www.youtube.com', 'matched on paste, rewritten to nocookie host'],
    ['https://example.com', 'placeholder text'],
    // Navigated in a popup, not fetched — no CSP directive governs navigation.
    ['https://accounts.google.com', 'sign-in page, navigated to in a popup'],
    // Written into a share link the apps hand over, never requested.
    ['https://mbrd.valjdakosta.com', 'the website a share link from the apps names'],
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

test('connect-src carries the host the converter is fetched from', () => {
  // Host only (CSP ignores path); match a string literal, not prose.
  const core = /['"`]https:\/\/([^/'"`]+)\//.exec(read(join(JS, 'optimize', 'media.ts')));
  assert.ok(core, 'no absolute URL in optimize/media.ts - has the core moved?');
  const sources = directives.get('connect-src') ?? [];
  assert.ok(sources.includes(`https://${core[1]}`),
    `optimize/media.ts fetches ${core[1]} and connect-src does not allow it`);
});

test('connect-src carries the host a board is shared through', () => {
  // API constant only — google.ts also names the sign-in page (in NOT_FETCHED).
  const api = /\bconst API = '(https:\/\/[^/']+)'/.exec(read(join(JS, 'storage', 'cloud', 'google.ts')));
  assert.ok(api, "no `const API = 'https://...'` in storage/cloud/google.ts - has the host moved?");
  const sources = directives.get('connect-src') ?? [];
  assert.ok(sources.includes(api[1]),
    `storage/cloud/google.ts fetches ${api[1]} and connect-src does not allow it`);
});

test('no remote host reaches anything that renders a document', () => {
  // These directives guarantee a board renders with no network.
  for (const name of ['default-src', 'img-src', 'media-src', 'font-src', 'style-src']) {
    const remote = (directives.get(name) ?? []).filter(s => s.includes('//'));
    assert.deepEqual(remote, [], `${name} allows a remote host: ${remote.join(' ')}`);
  }
});

test('no source is a wildcard', () => {
  // Wildcards turn a directive into a category rather than a policy.
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
  // NOT 'none': <base href="/"> is load-bearing for 404 routing.
  assert.deepEqual(directives.get('base-uri'), ["'self'"]);
  assert.match(read(join(WEB, 'index.html')), /<base href="\/">/,
    "index.html has lost its <base> - then base-uri could be 'none'; see wrangler.jsonc");
});

// ---------------------------------------------------------------------------
// The worker exemptions
// ---------------------------------------------------------------------------

/** Derive the five exempted worker paths from the code that names them.
 * A URL as a string in one file and a path in _headers is exactly the pair
 * that drifts — deriving catches a rename before it silently breaks. */
function spawnedWorkers() {
  const media = /new Worker\('([^']+)'\)/.exec(read(join(JS, 'optimize', 'media.ts')));
  assert.ok(media, 'optimize/media.ts no longer spawns a worker - is the exemption still needed?');

  const pdf = read(join(JS, 'import', 'pdf.ts'));
  const dir = /PDF_DIR = '([^']+)'/.exec(pdf);
  const worker = /workerSrc = pdfURL\('([^']+)'\)/.exec(pdf);
  assert.ok(dir && worker, 'import/pdf.ts no longer points pdf.js at a worker of its own');

  // Read WORKER_URL constant, not the new Worker() call (which wraps in URL()).
  const matte = /WORKER_URL = '([^']+)'/.exec(read(join(JS, 'canvas', 'matte.ts')));
  assert.ok(matte, 'canvas/matte.ts no longer names a worker - is the exemption still needed?');

  // Same: read the constant, not the Worker() call.
  const occt = /WORKER_URL = '([^']+)'/.exec(read(join(JS, 'mesh', 'occt.ts')));
  assert.ok(occt, 'mesh/occt.ts no longer names a worker - is the exemption still needed?');

  // Same: libarchive.js is handed the constant, and spawns the worker itself.
  const archive = /WORKER_URL = '([^']+)'/.exec(read(join(JS, 'import', 'archive.ts')));
  assert.ok(archive, 'import/archive.ts no longer names a worker - is the exemption still needed?');

  return [media[1], dir[1] + worker[1], matte[1], occt[1], archive[1]].map(url => url.replace(/^\.?\//, '/'));
}

test('the exempted paths are the workers the app actually spawns', () => {
  const exempt = rules.filter(r => r.removed.includes('Content-Security-Policy'));
  const wanted = spawnedWorkers();
  assert.deepEqual(exempt.map(r => r.path).sort(), [...wanted].sort(),
    'a path drops the policy that is not one of the five workers, or a worker has lost its rule '
    + '- each unlisted one is a page or a script running unprotected');
  for (const rule of exempt) {
    assert.ok(existsSync(join(WEB, rule.path.slice(1))), `${rule.path} does not exist`);
  }
});

test('csp.mts, which the desktop and Android enforce from, reads what this file reads', () => {
  // Two parsers of one file: this test's own, and the shells'. A disagreement
  // is a policy the tests pass and the apps do not send.
  const shells = parsePolicy(read(HEADERS));
  assert.equal(shells.value, policy);
  assert.deepEqual([...shells.exempt].sort(), [...spawnedWorkers()].sort());
});

test('the policy staged for Android is the one in _headers', t => {
  if (!existsSync(STAGED)) return t.skip('nothing staged - run `npm run stage` in mobile/');
  // A stale mbrd-csp.json ships the policy of the last staging, not this one.
  assert.deepEqual(JSON.parse(read(STAGED)), parsePolicy(read(HEADERS)),
    'mbrd-csp.json is stale - run `npm run stage` in mobile/');
});

test('nothing but those workers is exempted, and no page is', () => {
  for (const rule of rules) {
    if (!rule.removed.length) continue;
    // .mjs: pdf.js worker is an ES module.
    assert.match(rule.path, /\.m?js$/, `${rule.path} drops a header and is not a script`);
    assert.ok(!rule.path.includes('*'), `${rule.path} exempts a whole tree, not one file`);
  }
});
