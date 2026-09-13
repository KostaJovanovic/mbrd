import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
// frame the top-left corner + ring gap where lines thread
await page.evaluate(() => { const vp=window.mbrd.vp; vp.zoomAt(innerWidth/2, innerHeight/2, 2.0); });
await page.waitForTimeout(600);
await page.screenshot({ path:'scratch/zoomshot.png' });
await b.close();
