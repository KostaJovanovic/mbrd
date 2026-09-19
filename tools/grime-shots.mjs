// Draws every caked grime onto a contact sheet PNG, through the game's own
// crustPixels() (ui/clean/art.ts), so a look can be judged without a browser.
// Not a build step and not a test: a bench, like web/lab-grime.html.
//
//   node tools/grime-shots.mjs [out.png] [look.json]
//
// look.json, if given, is merged over LOOK (the same shape: { mud: { ... } })
// and may carry "deal": [...] to replace GRIMES for the dealt row. Needs no
// install - zlib and fs are Node's own.

import { writeFileSync, readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { LOOK, GRIME_KINDS, crustPixels } from '../web/assets/js/ui/clean/art.ts';
import { GRIMES } from '../web/assets/js/ui/clean/mess.ts';

const [out = 'grime-shots.png', lookFile] = process.argv.slice(2);

if (lookFile) {
  const over = JSON.parse(readFileSync(lookFile, 'utf8'));
  for (const [section, knobs] of Object.entries(over)) {
    if (section === 'deal') { GRIMES.splice(0, GRIMES.length, ...knobs); continue; }
    if (LOOK[section]) Object.assign(LOOK[section], knobs);
  }
}

const PER_ROW = 5;
const SHAPES = [[232, 154], [200, 200], [154, 232], [232, 134], [180, 232]];
const GAP = 16;
const LABEL = 18;
const BOARD = [236, 230, 218];

// ---- the cards under the crust ----------------------------------------------

/** A photo, a note, a blank card, a dark picture - as flat RGB, one pixel at a
 *  time, since there is no canvas here. */
function face(kind, w, h, seed) {
  const px = new Uint8ClampedArray(w * h * 3);
  const r = x => ((Math.sin(x * 12.9898 + seed * 0.001) * 43758.5453) % 1 + 1) % 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const v = y / h;
      let c;
      if (kind === 0) {
        const hill = 0.64 + Math.sin(x / w * 6 + r(1) * 3) * 0.05;
        const hill2 = 0.76 + Math.sin(x / w * 4 + r(2) * 3) * 0.04;
        const sun = Math.hypot(x - w * (0.25 + r(3) * 0.5), y - h * 0.34) < h * 0.1;
        c = v > hill2 ? [77, 106, 69] : v > hill ? [111, 143, 90] : sun ? [233, 176, 79]
          : [156 + (241 - 156) * v, 196 + (220 - 196) * v, 220 + (184 - 220) * v];
      } else if (kind === 1) {
        const line = y > 40 && (y - 40) % 16 < 2 && x > 14 && x < 14 + (w - 28) * (0.5 + r(y) * 0.5);
        c = line ? [109, 98, 80] : [251, 241, 184];
      } else if (kind === 2) {
        c = [251, 250, 246];
      } else {
        const d = Math.hypot(x / w - 0.5, y / h - 0.45) * 1.6;
        c = d < 0.5 ? [194 - d * 240, 87 - d * 80, 58] : [74 - (d - 0.5) * 100, 44 - (d - 0.5) * 60, 58 - (d - 0.5) * 70];
      }
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
    }
  }
  return px;
}

// ---- the sheet ----------------------------------------------------------------

const rows = [
  { label: 'dealt', cards: Array.from({ length: PER_ROW * 2 }, (_, i) => ({
    // A real hash rather than sin(): sin() at these inputs never reached the
    // top sixth, so the last grime in the list was never dealt.
    kind: GRIMES[((Math.imul(i + 1, 2654435761) ^ 0x5bd1e995) >>> 0) % GRIMES.length],
    face: i % 2 ? 3 : 0, seed: 7000 + i * 131, shape: SHAPES[i % SHAPES.length].map(n => Math.round(n * 0.7)),
  })) },
  ...GRIME_KINDS.map((kind, k) => ({
    label: kind,
    cards: Array.from({ length: PER_ROW }, (_, i) => ({
      kind, face: i % 4, seed: 1000 + k * 977 + i * 7919, shape: SHAPES[i % SHAPES.length],
    })),
  })),
];

const rowH = rows.map(row => Math.max(...row.cards.map(c => c.shape[1])) + LABEL);
const W = Math.max(...rows.map(row => row.cards.reduce((s, c) => s + c.shape[0] + GAP, GAP)));
const H = rowH.reduce((s, h) => s + h + GAP, GAP);
const sheet = new Uint8ClampedArray(W * H * 3);
for (let i = 0; i < W * H; i++) sheet.set(BOARD, i * 3);

let top = GAP;
rows.forEach((row, ri) => {
  let left = GAP;
  for (const card of row.cards) {
    const [w, h] = card.shape;
    const base = face(card.face, w, h, card.seed);
    const crust = crustPixels({ kind: card.kind, seed: card.seed }, w, h, true);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Rounded corners, as a card has.
        const cx = Math.min(x, w - 1 - x);
        const cy = Math.min(y, h - 1 - y);
        if (cx < 8 && cy < 8 && Math.hypot(8 - cx, 8 - cy) > 8) continue;
        const s = (y * w + x) * 3;
        const a = crust[(y * w + x) * 4 + 3] / 255;
        const o = ((top + LABEL + y) * W + left + x) * 3;
        for (let ch = 0; ch < 3; ch++) {
          sheet[o + ch] = base[s + ch] * (1 - a) + crust[(y * w + x) * 4 + ch] * a;
        }
      }
    }
    left += w + GAP;
  }
  // A row's label is a strip of colour per kind on the dealt row; the kind
  // rows are in GRIME_KINDS order, top to bottom, and need none.
  top += rowH[ri] + GAP;
});

// ---- PNG -------------------------------------------------------------------

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  Buffer.from(sheet.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
}
writeFileSync(out, Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]));
console.log(`${out}: ${W}x${H}, dealt ${rows[0].cards.map(c => c.kind).join(' ')}`);
