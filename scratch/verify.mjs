import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
const rows = await page.evaluate(() => window.mbrd.joins());
console.log('through per row (drawn only):');
for (const r of rows) if (r.drawn) console.log(`  ${r.from} -> ${r.to} pts=${r.points} through=[${r.through}]`);
await b.close();
