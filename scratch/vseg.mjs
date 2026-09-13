import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
const ds = await page.evaluate(() =>
  [...document.querySelectorAll('#web path')].map(p=>p.getAttribute('d')||'').filter(d=>d.length>30));
for (const d of ds) for (const sub of d.split(/(?=M)/)) {
  if (sub.length<5) continue;
  const cs=(sub.match(/C/g)||[]).length;
  console.log(`C=${cs} | ${sub}`);
}
await b.close();
