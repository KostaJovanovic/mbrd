import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
if (!page) { console.log('no tab'); process.exit(0); }
await page.goto('http://localhost:6273/', { waitUntil:'domcontentloaded' });
await page.waitForFunction(() => !!window.mbrd?.joins, null, {timeout:15000});
await page.waitForTimeout(2800);
const info = await page.evaluate(() => {
  const B = window.mbrd.board;
  const byId = id => B.items.find(i=>i.id===id);
  const conns = B.connections.map(c => Array.isArray(c) ? {from:c[0],to:c[1]} : {from:c.from,to:c.to});
  const rows = conns.map(c => {
    const a=byId(c.from), d=byId(c.to);
    return a&&d ? { fromN:a.name, toN:d.name,
      a:{x:a.x|0,y:a.y|0,w:a.w|0,h:a.h|0}, d:{x:d.x|0,y:d.y|0,w:d.w|0,h:d.h|0} } : {bad:JSON.stringify(c)};
  });
  const blocked = window.mbrd.joins().filter(r=>r.blocked).map(r=>`${r.from}<->${r.to}`);
  const items = B.items.map(i=>`${i.name} (${i.x|0},${i.y|0} ${i.w|0}x${i.h|0})`);
  return { rows, blocked, items };
});
console.log('BLOCKED:', info.blocked.join(' , '));
console.log('CONNECTIONS:');
for (const r of info.rows) console.log(r.bad ? '  BAD '+r.bad : `  ${r.fromN} (${r.a.x},${r.a.y}) -> ${r.toN} (${r.d.x},${r.d.y})`);
console.log('ALL ITEMS:');
for (const it of info.items) console.log('  '+it);
await b.close();
