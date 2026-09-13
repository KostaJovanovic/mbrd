import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
const shown = async () => page.evaluate(() =>
  [...document.querySelectorAll('.join-badge')].filter(e=>!e.hidden).length);
const zoom = async () => page.evaluate(() => window.mbrd.vp.zoom);
console.log('at', (await zoom()).toFixed(3), 'visible badges', await shown());
// zoom out to ~0.35 via wheel-less API: set and fire change
await page.evaluate(() => { const vp=window.mbrd.vp; vp.zoom=0.35; vp.emitChange?.(); vp.onChange && 0; window.dispatchEvent(new Event('resize')); });
await page.waitForTimeout(300);
console.log('at', (await zoom()).toFixed(3), 'visible badges', await shown());
await b.close();
