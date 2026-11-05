// Make the Android launcher icons and splash screens from the maskable mark,
// which is drawn for a mask the platform supplies, as an adaptive icon's is.
// Renders it with sharp onto the paper colour into mobile/assets/logo.png (an
// input, committed), then @capacitor/assets writes the mipmaps and splashes into
// android/app/src/main/res/, and the adaptive icon's three layers are cut from the
// mark after it. Run from mobile/: npm run icons. Rerun when the mark changes.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// Then the adaptive icon again, over what capacitor-assets wrote: it can only paint
// the flattened logo as the foreground, so the background layer was hidden and
// there was no monochrome layer for Android 13's themed icons. Here the mark is
// split: paper and dots behind, the three cards in front, the cards alone in one
// colour as the monochrome. Each layer fills the full 108dp canvas, so the
// launcher has a margin to move them in. The 768-unit viewBox shows the cards at
// the size the old 16.7% inset gave them, and lets the dots run on into that margin.
const src = svg.toString('utf8');
const cards = /<g [^>]*>[\s\S]*?<\/g>/.exec(src)?.[0];
const ground = src.replace(cards ?? '', '')
  .replaceAll('<rect width="512" height="512"', '<rect x="-128" y="-128" width="768" height="768"');
if (!cards || viewBox[1] !== '512' || (ground.match(/x="-128"/g) ?? []).length !== 2) {
  console.error('make-icons: icon-maskable.svg is no longer a 512 paper rect, a dot rect and one <g> of cards. Update the split');
  process.exit(1);
}
const layer = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-128 -128 768 768">${body}</svg>`;
const LAYERS = {
  background: ground.replace('viewBox="0 0 512 512"', 'viewBox="-128 -128 768 768"'),
  foreground: layer(cards),
  // Android uses only the alpha of this layer and tints it to the wallpaper.
  monochrome: layer(cards.replace(/fill="#[0-9a-f]+"/gi, 'fill="#000"')),
};
const RES = join(MOBILE, 'android', 'app', 'src', 'main', 'res');
const DENSITIES = { ldpi: 0.75, mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [density, scale] of Object.entries(DENSITIES)) {
  const px = 108 * scale;
  for (const [name, body] of Object.entries(LAYERS)) {
    await sharp(Buffer.from(body), { density: (72 * px) / 768 })
      .resize(px, px)
      .png()
      .toFile(join(RES, `mipmap-${density}`, `ic_launcher_${name}.png`));
  }
}
const xml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
`;
for (const file of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
  writeFileSync(join(RES, 'mipmap-anydpi-v26', file), xml);
}
console.log('make-icons: adaptive icon layers, background, foreground and monochrome');
