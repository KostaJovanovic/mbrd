import { firefox } from 'playwright-core';
import { mkdirSync } from 'fs';
import { join } from 'path';
const OUT = join(process.cwd(), '..', 'tmp-batch');
mkdirSync(OUT, { recursive: true });

const b = await firefox.launch();
const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('ERR', m.text()); });
await page.goto('http://localhost:6273/', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.mbrd, null, { timeout: 15000 });
const paste = u => page.evaluate(url => { const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: { getData: t => (t==='text/plain'?url:''), files: [] } }); window.dispatchEvent(e); }, u);
const clear = () => page.evaluate(() => { window.mbrd.board.items = []; window.mbrd.bus.emit('items', { added: [], removed: [] }); });

async function shot(tag) {
  const items = await page.$$('.item:has(.card-link)');
  const el = items[items.length - 1];
  if (el) await el.screenshot({ path: join(OUT, `${tag}.png`) });
}

// 1. Steam
await paste('https://store.steampowered.com/app/1229490/ULTRAKILL/');
await page.waitForTimeout(400);
console.log('steam    ', await page.evaluate(() => {
  const el = document.querySelector('.item:has(.card-link) .card-embed');
  return JSON.stringify({ mark: el?.querySelector('.embed-mark text')?.textContent, chip: el?.querySelector('.embed-go .card-name')?.textContent, brand: !!el?.querySelector('.embed-brand path') });
}));
await shot('steam');

// 2. Reddit subreddit
await clear();
await paste('https://www.reddit.com/r/ultrakill/comments/abc/def/');
await page.waitForTimeout(400);
console.log('reddit   ', await page.evaluate(() => {
  const el = document.querySelector('.item:has(.card-link) .card-embed');
  return JSON.stringify({ mark: el?.querySelector('.embed-mark text')?.textContent, chip: el?.querySelector('.embed-go .card-name')?.textContent });
}));
await shot('reddit');

// 3. X — logo watermark
await clear();
await paste('https://x.com/jack/status/20');
await page.waitForTimeout(400);
console.log('x        ', await page.evaluate(() => {
  const el = document.querySelector('.item:has(.card-link) .card-embed');
  return JSON.stringify({ markText: el?.querySelector('.embed-mark text')?.textContent ?? null, markLogo: !!el?.querySelector('.embed-mark path'), chip: el?.querySelector('.embed-go .card-name')?.textContent });
}));
await shot('x');

// 4. YouTube — title fetched onto the button
await clear();
await paste('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
await page.waitForTimeout(2500);
console.log('youtube  ', await page.evaluate(() => {
  const el = document.querySelector('.item:has(.card-embed[data-provider="youtube"])');
  return JSON.stringify({ button: el?.querySelector('.embed-go span')?.textContent, title: window.mbrd.board.items.at(-1)?.meta?.title });
}));

// 5. Spotify — open and check the frame is not clipped
await clear();
await paste('https://open.spotify.com/track/41fgCIiVlDMMnWhWOUCzjo');
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('.embed-go')?.click());
await page.waitForTimeout(600);
console.log('spotify  ', await page.evaluate(() => {
  const s = (window.mbrd?.vp?.scale) || 1; const H = e => e ? Math.round(e.getBoundingClientRect().height / s) : null;
  const it = window.mbrd.board.items.at(-1); const card = document.querySelector('.card-embed.has-embed');
  return JSON.stringify({ itemH: Math.round(it.h), cardH: H(card), frameH: H(card?.querySelector('.embed-frame')), need: 152 });
}));

await b.close();
console.log('done', OUT);
