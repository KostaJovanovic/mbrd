import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
const r = await page.evaluate(() => {
  const el=document.createElement('button'); el.className='join-badge'; el.type='button'; el.textContent='?';
  document.body.append(el);
  const at = z => { const s=28*z; el.style.width=s+'px'; el.style.height=s+'px'; el.style.fontSize=(15*z)+'px';
    const cs=getComputedStyle(el); const rc=el.getBoundingClientRect();
    return { z, w:Math.round(rc.width), h:Math.round(rc.height), font:cs.fontSize, radius:cs.borderRadius }; };
  const out=[at(0.5), at(1), at(1.8)];
  el.remove();
  return out;
});
console.log(JSON.stringify(r,null,1));
await b.close();
