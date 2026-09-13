import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
const info = await page.evaluate(() => {
  const B = window.mbrd.board;
  return {
    total: B.items.length,
    items: B.items.map(i => ({ n:i.name, type:i.type, rider:i.rider??null, fence:i.fence??null,
      display:i.display??i.isDisplay??i.copy??null, x:i.x|0, y:i.y|0 })),
    connCount: B.connections.length,
  };
});
console.log('total items:', info.total, 'connections:', info.connCount);
for (const it of info.items) console.log(`  ${it.n} type=${it.type} rider=${it.rider} disp=${it.display} @${it.x},${it.y}`);
await b.close();
