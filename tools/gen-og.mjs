// Render tools/og.html into web/assets/img/og.png, the 1200x630 link-preview card.
// Headless Edge draws it with the app's own fonts inlined, and sharp (from
// desktop/node_modules, like gen-desktop-icons.mjs) packs it into a palette PNG:
// WhatsApp drops a preview image much over 300 KB. Output is committed.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FONTS = join(HERE, '..', 'web', 'assets', 'fonts');
const OUT = join(HERE, '..', 'web', 'assets', 'img', 'og.png');
const W = 1200, H = 630;
const BUDGET = 300 * 1024;

const require = createRequire(join(HERE, '..', 'desktop', 'package.json'));
const sharp = require('sharp');

const BROWSERS = [
  process.env.EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const browser = BROWSERS.find(p => existsSync(p));
if (!browser) throw new Error('No Edge or Chrome found; set EDGE to its path.');

// Data URIs, because a file:// page may not load a font from another file.
const face = async (family, file, style = 'normal') =>
  `@font-face { font-family: '${family}'; font-style: ${style}; font-weight: 100 900; ` +
  `src: url(data:font/woff2;base64,${(await readFile(join(FONTS, file))).toString('base64')}) format('woff2'); }`;
const fonts = (await Promise.all([
  face('Fraunces', 'fraunces-latin.woff2'),
  face('Fraunces', 'fraunces-latin-italic.woff2', 'italic'),
  face('Geist', 'geist-latin.woff2'),
  face('Geist Mono', 'geist-mono-latin.woff2'),
])).join('\n');

const work = await mkdtemp(join(tmpdir(), 'mbrd-og-'));
try {
  const page = join(work, 'og.html');
  const shot = join(work, 'og.png');
  await writeFile(page, (await readFile(join(HERE, 'og.html'), 'utf8')).replace('/*FONTS*/', fonts));
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    `--user-data-dir=${join(work, 'profile')}`,
    // Headless Edge takes browser chrome out of the window, so the viewport of
    // a 1200x630 window is smaller than that. The page is laid out in fixed
    // pixels, so a larger window and a crop give the exact size.
    '--force-device-scale-factor=1', `--window-size=${W + 200},${H + 200}`,
    // Time for the inlined fonts to decode before the shot is taken.
    '--virtual-time-budget=4000',
    `--screenshot=${shot}`, pathToFileURL(page).href,
  ], { stdio: 'ignore' });

  const png = await sharp(shot)
    .extract({ left: 0, top: 0, width: W, height: H })
    .png({ palette: true, colours: 256, dither: 1, effort: 10, compressionLevel: 9 })
    .toBuffer();
  await writeFile(OUT, png);
  const kb = Math.round(png.length / 1024);
  console.log(`og.png -> ${OUT} (${kb} KB)`);
  if (png.length > BUDGET) console.warn(`over the ${BUDGET / 1024} KB budget`);
} finally {
  await rm(work, { recursive: true, force: true });
}
