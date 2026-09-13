import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('6273')) page=p;
const res = await page.evaluate(() => {
  const vp = window.mbrd.vp;
  const items = window.mbrd.board.items;
  const byId = id => items.find(i=>i.id===id);
  const box = it => { const hw=it.w/2, hh=it.h/2; return {id:it.id,nm:it.name,x0:it.x-hw,x1:it.x+hw,y0:it.y-hh,y1:it.y+hh}; };
  const cards = items.map(box);
  const inside = (wx,wy) => cards.find(c => wx>c.x0+6 && wx<c.x1-6 && wy>c.y0+6 && wy<c.y1-6);
  // endpoints of each connection (card centres)
  const eps = [];
  for (const cn of window.mbrd.board.connections) { const a=byId(cn.from),d=byId(cn.to); if(a)eps.push(a); if(d)eps.push(d); }
  const hits = [];
  for (const path of document.querySelectorAll('#web path')) {
    const len = path.getTotalLength(); if (len<5) continue;
    for (let s=0;s<=len;s+=3){ const pt=path.getPointAtLength(s); const w=vp.toWorld(pt.x,pt.y); const c=inside(w.x,w.y);
      if(c){ // nearest endpoint distance
        let nd=1e9; for(const e of eps) nd=Math.min(nd, Math.hypot(e.x-w.x, e.y-w.y));
        hits.push({card:c.nm, wx:w.x|0, wy:w.y|0, nearEnd: nd|0}); } }
  }
  // collapse
  const byCard={};
  for(const h of hits){ (byCard[h.card] ||= {n:0,minEnd:1e9}); byCard[h.card].n++; byCard[h.card].minEnd=Math.min(byCard[h.card].minEnd,h.nearEnd); }
  return { total:hits.length, byCard, sample: hits.slice(0,6) };
});
console.log(JSON.stringify(res, null, 1));
await b.close();
