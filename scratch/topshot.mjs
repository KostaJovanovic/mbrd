import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
// find the isolate card that the top-left sweep enters: the top-left-most isolate
const target = await page.evaluate(() => {
  const its = window.mbrd.board.items.filter(i=>i.name==='isolate.gif');
  // topmost (max y in world y-up), leftmost tiebreak
  its.sort((a,b)=> (b.y-a.y) || (a.x-b.x));
  const t = its[0];
  window.mbrd.vp.fit([t], 260, 0);
  return { x:t.x|0, y:t.y|0 };
});
await page.waitForTimeout(600);
await page.screenshot({ path:'scratch/topshot.png' });
console.log('framed', JSON.stringify(target));
await b.close();
