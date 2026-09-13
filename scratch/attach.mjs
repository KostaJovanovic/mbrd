// Attach to the user's running Edge over CDP, reload the mbrd tab to pick up the
// new bundle, let it route, and dump every connection's verdict.
// Run from the desktop package (has playwright): node ../scratch/attach.mjs
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const contexts = browser.contexts();
let page = null;
for (const ctx of contexts) {
  for (const p of ctx.pages()) {
    if (p.url().includes('localhost:6273') || p.url().includes('mbrd')) { page = p; break; }
  }
  if (page) break;
}
if (!page) {
  console.error('No mbrd tab found. Open the board at localhost:6273 in the debug Edge.');
  process.exit(1);
}
console.error('Found tab:', page.url());

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.mbrd && typeof window.mbrd.joins === 'function', null, { timeout: 15000 });
// Let the board settle and the route pass run (110ms settle + budget).
await page.waitForTimeout(2500);

const rows = await page.evaluate(() => window.mbrd.joins());
const conns = await page.evaluate(() => window.mbrd.board.connections.length);
const items = await page.evaluate(() => window.mbrd.board.items.map(i => ({ id: i.id, name: i.name, x: i.x | 0, y: i.y | 0, w: i.w | 0, h: i.h | 0, type: i.type })));

console.log('CONNECTIONS:', conns, ' ITEMS:', items.length);
console.log('ROWS:');
for (const r of rows) {
  console.log(`  ${r.from} -> ${r.to} | routed=${r.routed} drawn=${r.drawn} blocked=${r.blocked} reason="${r.reason}" pts=${r.points} | ${r.fromBox} / ${r.toBox}`);
}
console.log('\nITEMS:');
for (const it of items) console.log(`  ${it.name || it.id} (${it.type})  ${it.x},${it.y} ${it.w}x${it.h}`);

await browser.close();
