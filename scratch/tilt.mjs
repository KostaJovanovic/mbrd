import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
const info = await page.evaluate(() => {
  const els = [...document.querySelectorAll('#world .item')].slice(0,5);
  return els.map(el => {
    const cs = getComputedStyle(el);
    // find rotate in transform of el or a child
    const tr = cs.transform;
    const inner = el.querySelector('*');
    return { id: el.getAttribute('data-id'), transform: tr,
      innerTransform: inner ? getComputedStyle(inner).transform : null };
  });
});
console.log(JSON.stringify(info,null,1));
await b.close();
