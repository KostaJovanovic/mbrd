import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
const info = await page.evaluate(() => {
  const root=getComputedStyle(document.documentElement);
  return { whimsy: root.getPropertyValue('--whimsy').trim() || '(unset)',
    bodyClass: document.body.className,
    htmlClass: document.documentElement.className,
    zoom:+window.mbrd.vp.zoom.toFixed(3) };
});
console.log(JSON.stringify(info,null,1));
// fit whole board and shoot
await page.evaluate(() => window.mbrd.vp.fit(window.mbrd.board.items, 100, 0));
await page.waitForTimeout(700);
await page.screenshot({ path:'scratch/board_full.png' });
await b.close();
