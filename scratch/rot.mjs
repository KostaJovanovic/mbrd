import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
const info = await page.evaluate(() => {
  const B = window.mbrd.board;
  return B.items.map(i => ({ n:i.name, x:i.x|0, y:i.y|0, w:i.w|0, h:i.h|0,
    rot: i.rotation ?? i.rot ?? i.angle ?? i.tilt ?? null }));
});
const rots = info.map(i=>i.rot).filter(r=>r!=null && r!==0);
console.log('rotations present:', rots.length ? rots.slice(0,20).join(',') : 'NONE (all 0/undefined)');
console.log(JSON.stringify(info.slice(0,4),null,0));
await b.close();
