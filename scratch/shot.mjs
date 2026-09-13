import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
await page.evaluate(() => window.mbrd.vp.fit(window.mbrd.board.items, 80, 0));
await page.waitForTimeout(700);
await page.screenshot({ path:'scratch/shot.png' });
await b.close();
