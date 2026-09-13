import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.mbrd?.joins, null, {timeout:15000});
await page.waitForTimeout(3000);
const dump = async (tag) => console.log(tag, await page.evaluate(() => {
  const els=[...document.querySelectorAll('.join-badge')];
  const blocked = window.mbrd.joins().filter(r=>r.blocked).length;
  const vis=els.find(x=>!x.hidden);
  return { zoom:+window.mbrd.vp.zoom.toFixed(3), nodes:els.length, blocked,
    w: vis?Math.round(vis.getBoundingClientRect().width):null, styleW: vis?.style.width||null };
}));
await dump('settle');
await page.evaluate(() => window.mbrd.vp.zoomAt(innerWidth/2, innerHeight/2, 1.7));
await page.waitForTimeout(500);
await dump('zoomIn');
await b.close();
