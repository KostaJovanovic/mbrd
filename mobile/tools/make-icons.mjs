// Make the Android launcher icons and splash screens from the maskable mark,
// which is drawn for a mask the platform supplies, as an adaptive icon's is.
// Renders it with sharp onto the paper colour into mobile/assets/logo.png (an
// input, committed), then @capacitor/assets writes the mipmaps and splashes into
// android/app/src/main/res/. Run from mobile/: npm run icons. Rerun when the mark changes.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(MOBILE, '..');
const SOURCE = join(ROOT, 'web', 'assets', 'img', 'icon-maskable.svg');
const OUT = join(MOBILE, 'assets');
// manifest.json's background_color, the paper the site is printed on. The dark
// variants use it too: the app has no dark launcher or splash of its own.
const PAPER = '#faf8f3';
const SIZE = 1024;

const svg = readFileSync(SOURCE);
const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg.toString('utf8'));
if (!viewBox || viewBox[1] !== viewBox[2]) {
  console.error('make-icons: icon-maskable.svg has no square `viewBox="0 0 N N"`. Check the file');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
// density scales the viewBox straight to SIZE, so nothing is upscaled from a small raster.
await sharp(svg, { density: (72 * SIZE) / Number(viewBox[1]) })
  .resize(SIZE, SIZE)
  .flatten({ background: PAPER })
  .png()
  .toFile(join(OUT, 'logo.png'));
console.log('make-icons: mobile/assets/logo.png');

const cli = join(MOBILE, 'node_modules', '@capacitor', 'assets', 'bin', 'capacitor-assets');
execFileSync(process.execPath, [
  cli, 'generate', '--android',
  '--iconBackgroundColor', PAPER,
  '--iconBackgroundColorDark', PAPER,
  '--splashBackgroundColor', PAPER,
  '--splashBackgroundColorDark', PAPER,
], { cwd: MOBILE, stdio: 'inherit' });
