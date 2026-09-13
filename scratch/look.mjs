// Attach WITHOUT reloading — inspect the board exactly as the user sees it now.
// Dump joins() plus each drawn path's point count and bbox span, and shoot it.
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const ctx of browser.contexts())
  for (const p of ctx.pages())
    if (p.url().includes('localhost:6273') || p.url().includes('mbrd')) { page = p; break; }
if (!page) { console.error('No mbrd tab'); process.exit(1); }
console.error('tab:', page.url());

const rows = await page.evaluate(() => window.mbrd.joins());
const view = await page.evaluate(() => ({ zoom: window.mbrd.vp.zoom }));
const items = await page.evaluate(() => window.mbrd.board.items.map(i =>
  ({ name: i.name || i.id, x: i.x | 0, y: i.y | 0, w: i.w | 0, h: i.h | 0, type: i.type })));

console.log('zoom', view.zoom.toFixed(3));
console.log('ROWS:');
for (const r of rows)
  console.log(`  ${r.from} -> ${r.to} | drawn=${r.drawn} blocked=${r.blocked} reason="${r.reason}" pts=${r.points} through=[${r.through}]`);
console.log('ITEMS:');
for (const it of items) console.log(`  ${it.name} (${it.type}) ${it.x},${it.y} ${it.w}x${it.h}`);

await page.screenshot({ path: 'scratch/look.png' });
await browser.close();
