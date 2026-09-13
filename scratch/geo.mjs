// Per drawn connection: the two endpoint card centres and the actual SVG path d,
// so a forced go-around can be told from an avoidable overshoot.
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const ctx of browser.contexts())
  for (const p of ctx.pages())
    if (p.url().includes('6273') || p.url().includes('mbrd')) { page = p; break; }
if (!page) { console.error('No tab'); process.exit(1); }

const data = await page.evaluate(() => {
  const cs = window.mbrd.board.connections;
  const byId = id => window.mbrd.board.items.find(i => i.id === id);
  const out = [];
  for (const c of cs) {
    const a = byId(c.from), b = byId(c.to);
    if (!a || !b) continue;
    out.push({
      from: a.name, to: b.name,
      a: { x: a.x | 0, y: a.y | 0 }, b: { x: b.x | 0, y: b.y | 0 },
    });
  }
  // every drawn path d in #web
  const paths = [...document.querySelectorAll('#web path')].map(p => p.getAttribute('d')).filter(Boolean);
  return { out, paths };
});
console.log('CONNECTIONS (world centres):');
for (const c of data.out) console.log(`  ${c.from}(${c.a.x},${c.a.y}) -> ${c.to}(${c.b.x},${c.b.y})`);
console.log('\nPATH d (screen coords):');
for (const d of data.paths) console.log('  ' + d.slice(0, 400));
await browser.close();
