import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
for (const c of b.contexts()) for (const p of c.pages()) {
  let has=false; try { has = await p.evaluate(()=>!!window.mbrd); } catch(e){}
  console.log(p.url(), 'mbrd=', has);
}
await b.close();
