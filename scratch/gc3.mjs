import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
await page.evaluate(() => {
  const g = window.mbrd.board.items.find(i=>i.name==='gcodevisualiser.gif');
  const vp = window.mbrd.vp;
  vp.zoom = 0.6; vp.pan.x = g.x + 250; vp.pan.y = g.y;
  vp.onChange && window.dispatchEvent(new Event('resize'));
  vp.viewTo ? vp.viewTo({x:g.x+250,y:g.y}, 0.6, 0) : 0;
});
await page.waitForTimeout(500);
await page.screenshot({ path:'scratch/gc3.png' });
await b.close();
