// The export, end to end: the example board saved as an image through the
// real Save image box, at each whimsy tier, beside a screenshot of the board.
// Chromium and Firefox draw the cards from their DOM (ui/capture.ts);
// `painters` shows the path Safari takes. Compare by eye. After a build:
//   node research/export-trace/export.mjs [chromium|firefox|painters] [outdir]
// Playwright comes from desktop/node_modules. Serves web/ itself, with the
// deployed CSP; never serve.py.

import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WEB = join(ROOT, 'web');
// `painters` is Chromium with the capture probe made to fail, which is the
// path Safari takes: every card drawn by its painter in ui/snapshot.ts.
const MODE = process.argv[2] || 'chromium';
const ENGINE = MODE === 'painters' ? 'chromium' : MODE;
const OUT = resolve(process.argv[3] || join(tmpdir(), `mbrd-export-${MODE}`));
mkdirSync(OUT, { recursive: true });

const CSP = readFileSync(join(WEB, '_headers'), 'utf8')
  .split('\n').find(l => /^\s+Content-Security-Policy:/.test(l)).trim().replace(/^Content-Security-Policy:\s*/, '');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  let file = normalize(join(WEB, path));
  if (!file.startsWith(WEB + sep) && file !== WEB) { res.writeHead(403).end(); return; }
  try { if (statSync(file).isDirectory()) file = join(file, 'index.html'); } catch { /* below */ }
  try { statSync(file); } catch { res.writeHead(404).end(); return; }
  const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' };
  if (extname(file) === '.html') headers['content-security-policy'] = CSP;
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));

const pw = createRequire(join(ROOT, 'desktop', 'package.json'))('playwright');
const browser = await pw[ENGINE].launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(e.message));
if (MODE === 'painters') {
  // canCapture() reads back a 4x4 canvas; a tainting engine throws there.
  await page.addInitScript(() => {
    const read = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      if (this.canvas.width === 4 && this.canvas.height === 4) throw new DOMException('tainted', 'SecurityError');
      return read.apply(this, args);
    };
  });
}
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => !!window.mbrd?.board && !document.getElementById('splash'));
await page.evaluate(() => window.mbrd.cmds.exampleBoard());
await page.waitForFunction(() => document.querySelectorAll('#world .item').length > 3);
await page.waitForTimeout(2500);

for (const whimsy of ['0', '1', '2']) {
  await page.evaluate(w => { document.documentElement.dataset.whimsy = w; }, whimsy);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `w${whimsy}-board.png`) });
  const t0 = Date.now();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    (async () => {
      void page.evaluate(() => window.mbrd.cmds.exportImage());
      const go = page.locator('dialog[open] button', { hasText: /^Save/ }).last();
      await go.waitFor({ timeout: 15_000 });
      await go.click();
    })(),
  ]);
  await download.saveAs(join(OUT, `w${whimsy}-export.jpg`));
  console.log(`whimsy ${whimsy}: exported in ${Date.now() - t0} ms`);
}
console.log('console errors:', errors.length ? errors : 'none');
console.log('written to', OUT);
await browser.close();
server.close();
