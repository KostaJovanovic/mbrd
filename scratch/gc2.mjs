import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
await page.reload({ waitUntil:'domcontentloaded' });
await page.waitForFunction(() => !!window.mbrd?.joins, null, {timeout:15000});
await page.waitForTimeout(2800);
const rows = await page.evaluate(() => window.mbrd.joins());
for (const r of rows) console.log(`  ${r.from} -> ${r.to} drawn=${r.drawn} blocked=${r.blocked} pts=${r.points} through=[${r.through}]`);
// frame gcode at a readable zoom
await page.evaluate(() => {
  const g = window.mbrd.board.items.find(i=>i.name==='gcodevisualiser.gif');
  const vp = window.mbrd.vp; vp.fit([g], 900, 0);
});
await page.waitForTimeout(600);
await page.screenshot({ path:'scratch/gc2.png' });
await b.close();
