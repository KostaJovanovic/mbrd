// The export-from-DOM spike (research/export-from-dom-2026-09-21.md, "Order
// of work" 1): open the example board in headless Chromium under the deployed
// CSP, capture cards through a data: SVG foreignObject, and write each capture
// beside a live screenshot of the same card for comparison by eye. Answers the
// first three unknowns. Run after `npm run build`:
//   node research/export-trace/spike.mjs [outdir]
// Playwright comes from desktop/node_modules. Serves web/ itself; never serve.py.

import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WEB = join(ROOT, 'web');
const OUT = resolve(process.argv[2] || join(tmpdir(), 'mbrd-export-spike'));
mkdirSync(OUT, { recursive: true });

// The site-wide policy from web/_headers, as the host sends it.
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

const { chromium } = createRequire(join(ROOT, 'desktop', 'package.json'))('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => !!window.mbrd?.board && !document.getElementById('splash'));
await page.evaluate(() => window.mbrd.cmds.exampleBoard());
await page.waitForFunction(() => document.querySelectorAll('#world .item').length > 3);
await page.waitForTimeout(2500);

for (const whimsy of ['0', '1', '2']) {
  await page.evaluate(w => { document.documentElement.dataset.whimsy = w; }, whimsy);
  await page.waitForTimeout(400);
  const results = await page.evaluate(async () => {
    const toData = async url => {
      const blob = await (await fetch(url)).blob();
      return await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
    };
    // The cascade, in document order, with every font the sheets name inlined.
    let css = '';
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      const base = new URL(link.href);
      let text = await (await fetch(link.href)).text();
      const urls = [...new Set([...text.matchAll(/url\(\s*['"]?([^'")]+\.woff2)['"]?\s*\)/g)].map(m => m[1]))];
      for (const u of urls) text = text.split(u).join(await toData(new URL(u, base).href));
      // Anything else a sheet points at would not load inside an image anyway.
      text = text.replace(/url\(\s*['"]?(?!data:)[^'")]+['"]?\s*\)/g, 'none');
      css += text + '\n';
    }
    const root = document.documentElement;
    const attrs = [...root.attributes].filter(a => a.name.startsWith('data-') || a.name === 'style')
      .map(a => `${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join(' ');
    const out = [];
    for (const node of [...document.querySelectorAll('#world .item')].slice(0, 8)) {
      const w = node.offsetWidth, h = node.offsetHeight;
      if (!w || !h) continue;
      const clone = node.cloneNode(true);
      for (const p of ['left', 'top', 'transform', 'translate', 'rotate', 'scale']) clone.style.removeProperty(p);
      clone.style.left = '0px';
      clone.style.top = '0px';
      clone.style.setProperty('--item-tilt', '0deg');
      for (const img of clone.querySelectorAll('img')) {
        if (img.src && !img.src.startsWith('data:')) img.src = await toData(img.src);
        img.removeAttribute('srcset');
        img.removeAttribute('loading');
      }
      const live = [...node.querySelectorAll('canvas')];
      [...clone.querySelectorAll('canvas')].forEach((c, i) => {
        const img = document.createElement('img');
        try { img.src = live[i].toDataURL(); } catch { /* tainted: left blank */ }
        img.className = c.className;
        c.replaceWith(img);
      });
      const xhtml = new XMLSerializer().serializeToString(clone);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${attrs}>`
        + `<style><![CDATA[${css}]]></style>`
        + `<foreignObject x="0" y="0" width="${w}" height="${h}">`
        + `<div xmlns="http://www.w3.org/1999/xhtml" id="viewport" style="position:absolute;inset:0;overflow:visible;background:none">`
        + `<div id="world" style="position:absolute;left:0;top:0;transform:none">${xhtml}</div></div>`
        + `</foreignObject></svg>`;
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      const t0 = performance.now();
      const img = new Image();
      img.src = url;
      let decoded = true;
      try { await img.decode(); } catch { decoded = false; }
      const k = 300 / 96;
      const c = document.createElement('canvas');
      c.width = Math.round(w * k);
      c.height = Math.round(h * k);
      const ctx = c.getContext('2d');
      if (decoded) ctx.drawImage(img, 0, 0, c.width, c.height);
      let readable = true, inked = 0;
      try {
        const px = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < px.length; i += 4 * 97) if (px[i] > 0) inked++;
      } catch { readable = false; }
      const ms = Math.round(performance.now() - t0);
      out.push({
        id: node.dataset.id, type: node.dataset.type, w, h, decoded, readable, inked, ms,
        svgKB: Math.round(url.length / 1024), png: readable ? c.toDataURL('image/png') : null,
      });
    }
    return out;
  });
  for (const r of results) {
    const name = `w${whimsy}-${r.type}-${r.id.slice(0, 6)}`;
    if (r.png) writeFileSync(join(OUT, `${name}-capture.png`), Buffer.from(r.png.split(',')[1], 'base64'));
    const live = await page.$(`#world .item[data-id="${r.id}"]`);
    if (live) await live.screenshot({ path: join(OUT, `${name}-live.png`) }).catch(() => {});
    console.log(`${name}: ${r.w}x${r.h} decoded=${r.decoded} readable=${r.readable} inked=${r.inked} ${r.ms}ms ${r.svgKB}KB`);
  }
}
console.log('console errors:', errors.length ? errors : 'none');
console.log('written to', OUT);
await browser.close();
server.close();
