import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.evaluate(() => {
  const g = window.mbrd.board.items.find(i=>i.name==='gcodevisualiser.gif');
  window.mbrd.vp.fit([g], 420, 0);
});
await page.waitForTimeout(600);
await page.screenshot({ path:'scratch/gcode.png' });
await b.close();
