import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
const res = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('#world .item')].map(el => {
    const r = el.getBoundingClientRect();
    const nm = el.querySelector('figcaption,.cap,.name')?.textContent?.trim() || el.getAttribute('data-id');
    return { nm, x0:r.left+6, y0:r.top+6, x1:r.right-6, y1:r.bottom-6, w:r.width };
  }).filter(c => c.w > 20);
  const inside = (x,y) => cards.find(c => x>c.x0 && x<c.x1 && y>c.y0 && y<c.y1);
  const out = [];
  for (const path of document.querySelectorAll('#web path')) {
    const len = path.getTotalLength(); if (len < 5) continue;
    const seen = new Set();
    for (let s=0; s<=len; s+=3) { const pt = path.getPointAtLength(s); const c = inside(pt.x, pt.y); if (c) seen.add(c.nm); }
    if (seen.size) out.push({ d: path.getAttribute('d')?.slice(0,30), through:[...seen] });
  }
  return { cardCount: cards.length, out };
});
console.log('cards:', res.cardCount);
console.log(JSON.stringify(res.out, null, 1));
await b.close();
