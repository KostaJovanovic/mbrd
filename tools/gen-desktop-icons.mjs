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
const rgba = size => sharp(SOURCE, { density: 384 }).resize(size, size).ensureAlpha().raw().toBuffer();

// Linux, and electron-builder's own fallback: one large PNG.
await writeFile(join(OUT, 'icon.png'), await png(512));

// Microsoft allows PNG compression for the 256 px image only. Every frame was a
// PNG, and the Windows taskbar, window and shortcuts showed a blank placeholder
// where they read the small ones, so those are 32-bit bitmaps now.
const icoFrames = await Promise.all(ICO_SIZES.map(s => (s >= 256 ? png(s) : rgba(s).then(px => dib(px, s)))));
await writeFile(join(OUT, 'icon.ico'), ico(icoFrames, ICO_SIZES));
await writeFile(join(OUT, 'icon.icns'), icns(await Promise.all(ICNS_SIZES.map(png)), ICNS_SIZES));

console.log(`icons -> ${OUT}`);

/**
 * One .ico frame as a 32-bit bitmap: a BITMAPINFOHEADER, the pixels bottom row
 * first in BGRA, then the 1-bit AND mask, all clear since the alpha carries the
 * shape. The header's height is doubled because it counts the mask too.
 */
function dib(px, size) {
  const maskRow = Math.ceil(size / 32) * 4;
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);                // header size
  head.writeInt32LE(size, 4);
  head.writeInt32LE(size * 2, 8);           // colour plus mask
  head.writeUInt16LE(1, 12);                // planes
  head.writeUInt16LE(32, 14);               // bits per pixel
  head.writeUInt32LE(0, 16);                // BI_RGB
  head.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const body = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = ((size - 1 - y) * size + x) * 4;
      const to = (y * size + x) * 4;
      body[to] = px[from + 2];
      body[to + 1] = px[from + 1];
      body[to + 2] = px[from];
      body[to + 3] = px[from + 3];
    }
  }
  return Buffer.concat([head, body, Buffer.alloc(maskRow * size)]);
}

/** Build an .ico by hand: 6-byte header, 16-byte directory per image, then the frames. */
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
    head.writeUInt8(0, at + 2);             // palette entries: none, 32-bit or PNG
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
