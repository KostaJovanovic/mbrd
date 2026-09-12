import { firefox } from 'playwright-core';
const browser = await firefox.launch();
const page = await browser.newPage();
await page.goto('http://localhost:6273/', { waitUntil: 'load' });
const svc = {
  'gstatic v2':   'https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://github.com&size=64',
  'icon.horse':   'https://icon.horse/icon/github.com',
  'favicone':     'https://favicone.com/github.com?s=64',
  'faviconkit':   'https://api.faviconkit.com/github.com/64',
  'allesedv':     'https://f1.allesedv.com/64/github.com',
  'favicon.im':   'https://favicon.im/github.com',
};
for (const [name, url] of Object.entries(svc)) {
  const r = await page.evaluate(async u => {
    try { const res = await fetch(u); const b = await res.blob();
      return { status: res.status, type: b.type, size: b.size }; }
    catch (e) { return { error: String(e).slice(0, 40) }; }
  }, url);
  console.log(name.padEnd(12), JSON.stringify(r));
}
await browser.close();
