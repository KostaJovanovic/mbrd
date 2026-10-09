// The boot smoke test: serve web/ from this process, open it in headless
// Chromium, open the example board, and fail on any console error or uncaught
// exception. CI runs it after the build (.github/workflows/ci.yml); locally,
// `node tools/smoke.mjs` after `npm run build`, with Playwright from desktop/.
// Not under tests/: npm test needs no install, and this needs a browser.

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ROOT, serve } from './web-server.mjs';

const TIMEOUT = 30_000;

/** Playwright from the root install CI makes, or from desktop/, which has it already. */
async function playwright() {
  try {
    return await import('playwright');
  } catch {
    return createRequire(join(ROOT, 'desktop', 'package.json'))('playwright');
  }
}

const server = await serve();
const { port } = server.address();
const { chromium } = await playwright();
const browser = await chromium.launch();
const problems = [];
try {
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', e => problems.push(`uncaught: ${e.stack || e.message}`));
  page.on('crash', () => problems.push('the page crashed'));

  await page.goto(`http://127.0.0.1:${port}/`, { timeout: TIMEOUT });
  await page.waitForFunction(() => !!window.mbrd?.board && !document.getElementById('splash'), null, { timeout: TIMEOUT });
  console.log('booted');

  await page.evaluate(() => window.mbrd.cmds.exampleBoard());
  await page.waitForFunction(() => window.mbrd.board.items.length > 0
    && document.querySelectorAll('#world .item').length > 0, null, { timeout: TIMEOUT });
  // Long enough for the thumbnails and the first autosave to have happened.
  await page.waitForTimeout(3000);
  const cards = await page.evaluate(() => window.mbrd.board.items.length);
  console.log(`example board open, ${cards} cards`);
} catch (err) {
  problems.push(`step failed: ${err instanceof Error ? err.message : err}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error(`smoke test failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('smoke test passed');
