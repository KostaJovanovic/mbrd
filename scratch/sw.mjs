import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
await page.evaluate(async () => {
  const rs = await navigator.serviceWorker.getRegistrations();
  for (const r of rs) await r.unregister();
  if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
});
await page.reload({ waitUntil:'domcontentloaded' });
await page.waitForFunction(() => !!window.mbrd?.joins, null, {timeout:15000});
await page.waitForTimeout(3000);
const rows = await page.evaluate(() => window.mbrd.joins());
for (const r of rows) console.log(`  ${r.from} -> ${r.to} drawn=${r.drawn} blocked=${r.blocked} reason="${r.reason}" pts=${r.points} through=[${r.through}]`);
await b.close();
