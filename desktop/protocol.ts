// Serving web/ over a scheme of its own, and why the app is not loaded from a
// file.
//
// index.html carries `<base href="/">`, and two modules - mesh/occt.ts and
// errors.ts - hold absolute `/assets/...` paths. Under `file://` a leading
// slash resolves to the root of the filesystem, so every one of those 404s and
// the app does not boot. The tag cannot simply be removed: the same document is
// served as the 404 page at arbitrary paths on the deploy, and _headers'
// base-uri note argues that at length.
//
// So the window loads `app://mbrd/index.html` instead. That is Electron's own
// recommendation and it buys three things at once: `<base>` resolves to
// `app://mbrd/` and nothing in web/ learns it moved; the page gets a real
// origin, so IndexedDB, workers, `blob:` URLs and the CSP all behave exactly as
// they do on the web; and `file://`'s peculiar security rules never apply to
// anything.
//
// ── The policy is web/_headers, read rather than copied ──
//
// The deploy applies that file and this applies that file. Not a copy of it -
// a copy is the thing tests/csp.test.js exists to prevent, since it holds the
// hashes and hosts in that file in step with the code they came from and would
// go on passing while a second copy here drifted. One policy, one place, two
// enforcers.
//
// The four `! Content-Security-Policy` exemptions are read too. Each is a
// worker that compiles WebAssembly - the ffmpeg core, pdf.js's JPEG 2000
// decoder, the matting model, the CAD kernel - and _headers argues every one of
// them where it is written. A dedicated worker does not inherit the document's
// policy; it gets one from the headers on its own script response, which is
// this handler's to send or to withhold.
//
// ── What this handler will not do ──
//
// Serve anything outside web/. The path is resolved and then checked to be
// under the root, which catches `..` however it is spelled - percent-encoded,
// doubled, or arriving as a Windows separator. A renderer cannot name a path in
// this app at all (see main.ts), but a protocol handler is the one place a URL
// becomes a filename, so it is the one place that check has to exist.

import { app, protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { log } from './log.ts';

/** The one host under the scheme. Not a hostname, just a name. */
const HOST = 'mbrd';
export const APP_ORIGIN = `app://${HOST}`;
export const APP_INDEX = `${APP_ORIGIN}/index.html`;

/**
 * Register the scheme. Must run before `ready`, which is why it is not part of
 * serveWeb() below.
 *
 * `standard` is the load-bearing one: without it the scheme has no origin, and
 * a page with no origin gets no IndexedDB, no localStorage and no workers - the
 * three things this app is built on. `secure` puts it in the same bucket as
 * https for every "is this a secure context" test, which is what crypto.subtle
 * and the rest ask. `supportFetchAPI` lets the page fetch its own assets, which
 * ui/snapshot.ts does for the sticker sprite. `stream` lets the handler answer
 * with a body it has not finished reading.
 *
 * `corsEnabled: false` because there is nothing to be cross-origin *to*: one
 * origin serves the whole app, and turning it on would add preflight handling
 * for requests that cannot happen.
 */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false },
  }]);
}

/**
 * Answer `app://mbrd/...` out of web/. Must run after `ready`.
 *
 * `app.getAppPath()` is the packaged app's root, which is where electron-builder
 * puts both `desktop/dist` and `web` - see the `files` list in
 * electron-builder.yml. In development it is `desktop/`, so web/ is one level
 * up; the two are reconciled by looking for index.html rather than by asking
 * whether this is a packaged build, because "where is web/" is a question with
 * an answer on disk.
 */
export function serveWeb(): void {
  const root = webRoot();
  const policy = readPolicy(root);
  log('info', 'serving web/', { root, exemptions: policy.exempt.length });

  protocol.handle('app', async request => {
    const url = new URL(request.url);
    if (url.hostname !== HOST) return new Response('Not found', { status: 404 });

    // decodeURIComponent rather than the raw pathname, so a percent-encoded
    // separator is resolved *before* the containment check below sees it and
    // cannot smuggle a segment past it.
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    // A directory is index.html, which is what a web server does and what the
    // app's own routing expects: the share link and the not-found page are both
    // paths that resolve to the same document.
    if (rel.endsWith('/')) rel += 'index.html';

    const file = resolve(join(root, rel));
    // The one check. `resolve` has already collapsed every `..`, so this is a
    // question about where the answer landed rather than about what the request
    // looked like - which is the only form of this check that is not a game of
    // spotting escapes.
    if (file !== root && !file.startsWith(root + sep)) {
      log('warn', 'refused a path outside web/', { requested: url.pathname });
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const body = await readFile(file);
      const headers = new Headers({ 'Content-Type': mimeOf(file) });
      // Exempt paths get no policy at all rather than a looser one, for the
      // reason _headers gives: two Content-Security-Policy values are
      // intersected, not overridden, so a looser second one would change
      // nothing. The comparison is on the URL path, which is how _headers
      // spells them.
      if (policy.value && !policy.exempt.includes(url.pathname)) {
        headers.set('Content-Security-Policy', policy.value);
      }
      return new Response(new Uint8Array(body), { headers });
    } catch (err) {
      // Not an error worth a log line at `error`: a 404 here is usually the app
      // probing for something optional - a vendored decoder it can do without.
      log('info', 'not served', { path: url.pathname, err: String(err) });
      return new Response('Not found', { status: 404 });
    }
  });
}

/** Where web/ is, found rather than assumed. */
function webRoot(): string {
  const base = app.getAppPath();
  for (const candidate of [join(base, 'web'), join(base, '..', 'web')]) {
    // Sync on purpose and twice at most: this runs at startup, before a window
    // exists, and the alternative is threading a promise through the one call
    // that has to happen synchronously anyway.
    if (existsSync(join(candidate, 'index.html'))) return resolve(candidate);
  }
  // Neither is a broken build rather than a state to recover from - the same
  // thing storage.ts says about #file-input. Returning the packaged guess makes
  // the failure a 404 on index.html, which is legible in the log.
  log('error', 'no web/ found beside the app', { base });
  return resolve(join(base, 'web'));
}

/**
 * The policy and its exemptions, parsed out of web/_headers.
 *
 * The format is Cloudflare's and is two shapes: a path pattern on a column-zero
 * line, then indented `Header: value` lines under it, or `! Header` to remove
 * one. Only two things are wanted here - the `/*` rule's
 * Content-Security-Policy, and every path that removes it - so this reads those
 * and ignores the rest rather than becoming a general parser for a format with
 * one consumer.
 *
 * A file that cannot be read means no header rather than a guessed one. That is
 * the safe direction only because it is loud: the app runs with no policy, and
 * the log says so, which beats running with a policy nobody wrote.
 */
function readPolicy(root: string): { value: string, exempt: string[] } {
  const empty = { value: '', exempt: [] as string[] };
  let text: string;
  try {
    text = readFileSync(join(root, '_headers'), 'utf8');
  } catch (err) {
    log('error', 'no _headers - the window will run with no CSP', err);
    return empty;
  }

  let value = '';
  const exempt: string[] = [];
  let rule = '';
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    // Column zero is a path pattern; anything indented belongs to the last one.
    if (!/^\s/.test(raw)) { rule = raw.trim(); continue; }
    const line = raw.trim();
    const removal = /^!\s*Content-Security-Policy$/i.exec(line);
    if (removal) { exempt.push(rule); continue; }
    const header = /^Content-Security-Policy:\s*(.+)$/i.exec(line);
    if (header && rule === '/*') value = header[1].trim();
  }
  if (!value) log('error', 'no /* Content-Security-Policy in _headers');
  return { value, exempt };
}

/**
 * The content type, from the extension.
 *
 * Short on purpose: this serves one directory whose contents are known, so the
 * list is what web/ actually holds rather than a MIME database. The three that
 * matter are the ones a browser refuses to *use* on a wrong type - a module
 * served as text/plain does not execute, a wasm binary served as anything but
 * application/wasm does not stream-compile, and a font is rejected outright.
 */
function mimeOf(file: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1].toLowerCase() ?? '';
  switch (ext) {
    case 'html': return 'text/html; charset=utf-8';
    case 'js': case 'mjs': return 'text/javascript; charset=utf-8';
    case 'css': return 'text/css; charset=utf-8';
    case 'json': case 'webmanifest': return 'application/json; charset=utf-8';
    case 'wasm': return 'application/wasm';
    case 'svg': return 'image/svg+xml';
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'ico': return 'image/x-icon';
    case 'woff2': return 'font/woff2';
    case 'woff': return 'font/woff';
    case 'txt': case 'md': return 'text/plain; charset=utf-8';
    case 'xml': return 'application/xml; charset=utf-8';
    default: return 'application/octet-stream';
  }
}
