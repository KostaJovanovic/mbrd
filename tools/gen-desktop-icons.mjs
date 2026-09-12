// Render icon.svg into .ico (Windows), .icns (macOS) and .png (Linux).
// Needs sharp from desktop/node_modules — the one generator that requires
// an install. Output is committed so nobody else runs it.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '..', 'web', 'assets', 'img', 'icon.svg');
const OUT = join(HERE, '..', 'desktop', 'icons');

// Resolved from desktop/, which has sharp as a dependency.
const require = createRequire(join(HERE, '..', 'desktop', 'package.json'));
const sharp = require('sharp');

/** Windows needs small sizes (taskbar/titlebar); macOS needs up to 1024 (Retina). */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];

await mkdir(OUT, { recursive: true });

const png = size => sharp(SOURCE, { density: 384 }).resize(size, size).png().toBuffer();

// Linux, and electron-builder's own fallback: one large PNG.
await writeFile(join(OUT, 'icon.png'), await png(512));

await writeFile(join(OUT, 'icon.ico'), ico(await Promise.all(ICO_SIZES.map(png)), ICO_SIZES));
await writeFile(join(OUT, 'icon.icns'), icns(await Promise.all(ICNS_SIZES.map(png)), ICNS_SIZES));

console.log(`icons -> ${OUT}`);

/** Build an .ico by hand: 6-byte header, 16-byte directory per image, then PNGs. */
function ico(images, sizes) {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(0, 0);                 // reserved
  head.writeUInt16LE(1, 2);                 // type: icon
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach((png, i) => {
    const at = 6 + i * 16;
    // 256 is encoded as 0 in the .ico format.
    head.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], at);
    head.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], at + 1);
    head.writeUInt8(0, at + 2);             // palette entries: none, it is a PNG
    head.writeUInt8(0, at + 3);             // reserved
    head.writeUInt16LE(1, at + 4);          // colour planes
    head.writeUInt16LE(32, at + 6);         // bits per pixel
    head.writeUInt32LE(png.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images]);
}

/** Build an .icns: 8-byte header, then chunks keyed by Apple's four-char type codes. */
function icns(images, sizes) {
  const TYPES = {
    16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07',
    256: 'ic08', 512: 'ic09', 1024: 'ic10',
  };
  const chunks = images.map((png, i) => {
    const type = TYPES[sizes[i]];
    const chunk = Buffer.alloc(8 + png.length);
    chunk.write(type, 0, 'ascii');
    chunk.writeUInt32BE(chunk.length, 4);
    png.copy(chunk, 8);
    return chunk;
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(head.length + body.length, 4);
  return Buffer.concat([head, body]);
}
