// web/ served the way the host serves it, for the headless checks: a file, or
// 404.html with a 404, as wrangler.jsonc says. No headers, like serve.py.
// Imported by tools/smoke.mjs; run directly (`node tools/web-server.mjs 6290`)
// it is the browser suite's web server (tests-browser/playwright.config.js).

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WEB = join(ROOT, 'web');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm', '.txt': 'text/plain',
  '.xml': 'application/xml', '.md': 'text/markdown',
};

/** Listen on `port` (0 for any) on loopback; resolves to the server. */
export function serve(port = 0) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = normalize(join(WEB, path));
    if (!file.startsWith(WEB + sep) && file !== WEB) { res.writeHead(403).end(); return; }
    try { if (statSync(file).isDirectory()) file = join(file, 'index.html'); } catch { /* checked below */ }
    let status = 200;
    try { statSync(file); } catch { file = join(WEB, '404.html'); status = 404; }
    res.writeHead(status, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise(ok => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await serve(Number(process.argv[2]) || 0);
  console.log(`serving web/ on http://127.0.0.1:${server.address().port}/`);
}
