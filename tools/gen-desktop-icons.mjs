// The desktop app's icons, from the one the web already has.
//
// Three formats, because three operating systems each insist on their own:
// `.ico` for Windows (a container of several square PNGs), `.icns` for macOS
// (another container, differently spelled), and a bare 512px PNG for Linux,
// where electron-builder wants a directory of sizes and takes the largest.
//
// **Generated, not drawn.** `web/assets/img/icon.svg` is the only place the
// icon is designed; everything under `desktop/icons/` is a rendering of it.
// Re-run this when that file changes - it is listed with the other generators
// in CLAUDE.md, and like them it writes files nobody should hand-edit.
//
// The *maskable* variant is not the source: it carries the safe-area padding
// Android's adaptive icons need, which on a desktop is a small picture in a
// large empty square, and Android is the one platform this file does not build
// for.
//
// ── Why this needs sharp, and why that is allowed ──
//
// It renders SVG through the same libvips the desktop already depends on for
// HEIC. That makes this the one generator in tools/ not runnable with a bare
// `npm test` install, which is why it is not in the root package's scripts: it
// is run from `desktop/`, where sharp is a dependency, and its output is
// committed so nobody else runs it.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '..', 'web', 'assets', 'img', 'icon.svg');
const OUT = join(HERE, '..', 'desktop', 'icons');

// Resolved from desktop/, the package that has it. This script lives in tools/
// with the other generators, not because the root package can run it.
const require = createRequire(join(HERE, '..', 'desktop', 'package.json'));
const sharp = require('sharp');

/**
 * The sizes each container holds.
 *
 * Windows wants the small ones most: 16 and 32 are what a taskbar, a title bar
 * and a file listing draw, and an .ico with only large entries is downscaled by
 * the shell into something muddy. macOS wants the large ones, including the
 * 1024 Retina asks for.
 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];

await mkdir(OUT, { recursive: true });

const png = size => sharp(SOURCE, { density: 384 }).resize(size, size).png().toBuffer();

// Linux, and electron-builder's own fallback: one large PNG.
await writeFile(join(OUT, 'icon.png'), await png(512));

await writeFile(join(OUT, 'icon.ico'), ico(await Promise.all(ICO_SIZES.map(png)), ICO_SIZES));
await writeFile(join(OUT, 'icon.icns'), icns(await Promise.all(ICNS_SIZES.map(png)), ICNS_SIZES));

console.log(`icons -> ${OUT}`);

/**
 * An .ico, written by hand.
 *
 * A six-byte header, a sixteen-byte directory entry per image, then the images.
 * Every entry is a PNG rather than a BMP - accepted by Windows since Vista, and
 * the only sane way to carry an alpha channel.
 *
 * By hand because the alternative is a dependency whose whole job is thirty
 * lines of DataView writes, and this file already has the hard part: something
 * that can rasterise an SVG.
 */
function ico(images, sizes) {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(0, 0);                 // reserved
  head.writeUInt16LE(1, 2);                 // type: icon
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach((png, i) => {
    const at = 6 + i * 16;
    // 256 is written as 0, which is the format's way of saying "not 8 bits".
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

/**
 * An .icns, on the same terms.
 *
 * A four-byte magic, a four-byte total length, then one chunk per image: a
 * four-character type, a length that *includes* the eight-byte chunk header,
 * and the PNG. The type codes are Apple's - the only part to look up rather
 * than reason about.
 */
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
