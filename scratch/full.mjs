import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
await page.evaluate(() => window.mbrd.vp.fit(window.mbrd.board.items, 90, 0));
await page.waitForTimeout(600);
await page.screenshot({ path:'scratch/full.png' });
// drawn subpaths (world-minus-origin coords)
const ds = await page.evaluate(() =>
  [...document.querySelectorAll('#web path')].map(p=>p.getAttribute('d')||'').filter(d=>d.length>30));
for (const d of ds) for (const sub of d.split(/(?=M)/)) { if (sub.length>5) console.log(sub.slice(0,240)); }
await b.close();
