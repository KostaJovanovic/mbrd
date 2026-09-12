// Serve web/ over app://mbrd/ so <base href="/"> resolves correctly,
// IndexedDB/workers get a real origin, and file:// quirks never apply.
// CSP is read from web/_headers (one policy, two enforcers — no copy).
// Path traversal is checked after resolve(); nothing outside web/ is served.

import { app, protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { log } from './log.ts';

/** The one host under the scheme. Not a hostname, just a name. */
const HOST = 'mbrd';
export const APP_ORIGIN = `app://${HOST}`;
export const APP_INDEX = `${APP_ORIGIN}/index.html`;
/** The changelog path. readPage() resolves this extensionless form to patch.html. */
export const APP_PATCH = `${APP_ORIGIN}/patch`;

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

/** Parse the CSP and its exemptions from web/_headers (Cloudflare format). */
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
