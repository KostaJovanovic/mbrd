// Serve web/ over app://mbrd/ so <base href="/"> resolves correctly,
// IndexedDB/workers get a real origin, and file:// quirks never apply.
// CSP is read from web/_headers by csp.mts (one policy, one parser, no copy).
// Path traversal is checked after resolve(); nothing outside web/ is served,
// except the title bar's pages under /__chrome/, from an allow-list.

import { app, protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { log } from './log.ts';
import { parsePolicy, type Policy } from './csp.mts';

/** The one host under the scheme. Not a hostname, just a name. */
const HOST = 'mbrd';
export const APP_ORIGIN = `app://${HOST}`;
export const APP_INDEX = `${APP_ORIGIN}/index.html`;

/** The title bar's and the menu panel's pages (desktop/chrome/), built into
 * dist/chrome/ beside main.js. On the app's own origin, so they share
 * tokens.css, the fonts and localStorage with the board. Never part of web/. */
const CHROME_PREFIX = '/__chrome/';
export const APP_CHROME = `${APP_ORIGIN}${CHROME_PREFIX}`;
/** An allow-list, not a path join, so this handler reads nothing else in dist/.
 * chrome/preload.js is absent on purpose: Electron loads it by path. */
export const CHROME_FILES = new Set([
  'titlebar.html',
  'titlebar.css',
  'titlebar.js',
  'panel.html',
  'panel.js',
  'look.js',
]);

/** Register the scheme before `ready`. `standard` gives it a real origin;
 * `secure` enables crypto.subtle; `supportFetchAPI` lets the page self-fetch. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false },
  }]);
}

/** Answer `app://mbrd/...` out of web/. Must run after `ready`. */
export function serveWeb(): void {
  const root = webRoot();
  const policy = readPolicy(root);
  log('info', 'serving web/', { root, exemptions: policy.exempt.length });

  protocol.handle('app', async request => {
    const url = new URL(request.url);
    if (url.hostname !== HOST) return new Response('Not found', { status: 404 });
    if (url.pathname.startsWith(CHROME_PREFIX)) {
      return serveChrome(url.pathname.slice(CHROME_PREFIX.length), policy.value);
    }

    // Decode before containment check so percent-encoded separators cannot bypass it.
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    // Directory → index.html, matching the web server and the app's routing.
    if (rel.endsWith('/')) rel += 'index.html';

    const file = resolve(join(root, rel));
    // Containment check after resolve() has collapsed all `..` sequences.
    if (file !== root && !file.startsWith(root + sep)) {
      log('warn', 'refused a path outside web/', { requested: url.pathname });
      return new Response('Forbidden', { status: 403 });
    }

    const found = await readPage(file);
    if (!found) {
      log('info', 'not served', { path: url.pathname });
      return new Response('Not found', { status: 404 });
    }

    const headers = new Headers({ 'Content-Type': mimeOf(found.file) });
    // Exempt paths get no CSP — two values are intersected, not overridden.
    if (policy.value && !policy.exempt.includes(url.pathname)) {
      headers.set('Content-Security-Policy', policy.value);
    }
    return new Response(new Uint8Array(found.body), { headers });
  });
}

/** A chrome page or script, under the same CSP as every other response. */
async function serveChrome(name: string, csp: string): Promise<Response> {
  if (!CHROME_FILES.has(name)) return new Response('Not found', { status: 404 });
  let body: Buffer;
  try {
    body = await readFile(join(__dirname, 'chrome', name));
  } catch (err) {
    log('error', 'a chrome file is missing from dist/chrome', { name, err: String(err) });
    return new Response('Not found', { status: 404 });
  }
  const headers = new Headers({ 'Content-Type': mimeOf(name) });
  if (csp) headers.set('Content-Security-Policy', csp);
  return new Response(new Uint8Array(body), { headers });
}

/** Read the file, trying extensionless-as-.html first (makes `/patch` work). */
async function readPage(file: string): Promise<{ file: string, body: Buffer } | null> {
  const named = /\.[a-z0-9]+$/i.test(file);
  for (const candidate of named ? [file] : [`${file}.html`, file]) {
    try {
      return { file: candidate, body: await readFile(candidate) };
    } catch {
      // The next spelling, or none. The caller logs the miss once.
    }
  }
  return null;
}

/** Where web/ is, found rather than assumed. */
function webRoot(): string {
  const base = app.getAppPath();
  for (const candidate of [join(base, 'web'), join(base, '..', 'web')]) {
    if (existsSync(join(candidate, 'index.html'))) return resolve(candidate);
  }
  log('error', 'no web/ found beside the app', { base });
  return resolve(join(base, 'web'));
}

/** The CSP and its exemptions from web/_headers. csp.mts parses, for Android too. */
function readPolicy(root: string): Policy {
  let text: string;
  try {
    text = readFileSync(join(root, '_headers'), 'utf8');
  } catch (err) {
    log('error', 'no _headers - the window will run with no CSP', err);
    return { value: '', exempt: [] };
  }
  const policy = parsePolicy(text);
  if (!policy.value) log('error', 'no /* Content-Security-Policy in _headers');
  return policy;
}

/** Content type from extension. Only what web/ actually holds. */
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
