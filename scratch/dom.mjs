import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
const info = await page.evaluate(() => {
  const sel = {};
  for (const s of ['#world .card', '#world [data-id]', '#world .item', '[data-id]']) {
    sel[s] = document.querySelectorAll(s).length;
  }
  // sample one card's tag/classes
  const one = document.querySelector('#world [data-id]');
  return { sel, sample: one ? { tag: one.tagName, cls: one.className, id: one.getAttribute('data-id') } : null,
    worldChildren: [...document.querySelector('#world').children].map(c=>c.className||c.id).slice(0,20) };
});
console.log(JSON.stringify(info, null, 1));
await b.close();
