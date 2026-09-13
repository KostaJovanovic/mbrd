import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
await page.reload({ waitUntil:'domcontentloaded' });
await page.waitForFunction(() => !!window.mbrd?.joins, null, {timeout:15000});
await page.waitForTimeout(2800);
const rows = await page.evaluate(() => window.mbrd.joins());
for (const r of rows) console.log(`  ${r.from} -> ${r.to} drawn=${r.drawn} blocked=${r.blocked} pts=${r.points} through=[${r.through}]`);
const t = await page.evaluate(() => {
  const its = window.mbrd.board.items.filter(i=>i.name==='isolate.gif');
  its.sort((a,b)=> (b.y-a.y) || (a.x-b.x));
  window.mbrd.vp.fit([its[0]], 260, 0);
});
await page.waitForTimeout(600);
await page.screenshot({ path:'scratch/topshot2.png' });
await b.close();
