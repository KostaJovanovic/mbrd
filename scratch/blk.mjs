import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
await page.evaluate(async () => {
  const rs = await navigator.serviceWorker.getRegistrations(); for (const r of rs) await r.unregister();
  if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
});
await page.reload({ waitUntil:'domcontentloaded' });
await page.waitForFunction(() => !!window.mbrd?.joins, null, {timeout:15000});
await page.waitForTimeout(3000);
const info = await page.evaluate(() => ({
  badges: document.querySelectorAll('.join-badge').length,
  blockedPathD: (document.querySelector('#web .web-blocked')?.getAttribute('d')||'').slice(0,80),
  blockedPathStroke: document.querySelector('#web .web-blocked') ? getComputedStyle(document.querySelector('#web .web-blocked')).stroke : null,
}));
console.log('badges left:', info.badges);
console.log('blocked path d:', info.blockedPathD || '(empty)');
console.log('blocked stroke:', info.blockedPathStroke);
await page.evaluate(() => window.mbrd.vp.fit(window.mbrd.board.items, 80, 0));
await page.waitForTimeout(700);
await page.screenshot({ path:'scratch/blk.png' });
await b.close();
