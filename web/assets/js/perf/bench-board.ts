// The benchmark's standard board: the same ~120 cards on every device, built
// from a seed rather than shipped. planStandardBoard() is pure and decides every
// card; buildStandardBoard() draws eight photographs and four screenshots,
// makes a distinct asset per card from them and loads the lot. Never saved:
// main.ts boots it behind markBenchBoard() (onboarding.ts), which every writer asks.

import {
  loadBoard, board, byId, snapshotGeom, commitGeom, markBenchBoard,
} from '../state.ts';
import { putAsset } from '../storage/assets.ts';
import { sha256 } from '../crypto.ts';
import { mulberry32, jpegWithComment, pngWithText } from './frames.ts';

/** The seed a run uses unless it is given another. Written into every file. */
export const DEFAULT_SEED = 20260923;

/** How many photographs, screenshots and the rest. ~120 cards in all. */
const COUNTS: readonly (readonly [CardKind, number])[] = [
  ['photo', 88], ['screenshot', 8], ['note', 12], ['swatch', 6], ['sticker', 6],
];
/**
 * Distinct base encodes: eight photographs, four each way up, and four
 * screenshots. Every card's copy differs from its base by one comment.
 */
const PHOTO_BASES = 4;
const SHOT_BASES = 4;
/** Camera sizes, because the decode of one of these is what a real board pays. */
const PHOTO_W = 4000, PHOTO_H = 3000;
const SHOT_W = 1080, SHOT_H = 2340;
/** The baked copies a real import carries (displayFor / thumbFor in import/drop.ts). */
const DISPLAY_SIDE = 1024, THUMB_SIDE = 160;
/** The world cell a card is dealt into. Twelve across. */
const CELL = 320, COLS = 12;
/** A card's area, as import/drop.ts's default image box: 256 x 192. */
const CARD_AREA = 256 * 192;
/** Edits made after the load, so the timeline has a history to scrub. */
export const HISTORY_STEPS = 24;

const STICKERS = ['s-star', 's-heart', 's-check', 's-sparkle', 's-eye', 's-asterisk'];
const WORDS = ['light', 'north', 'river', 'paper', 'glass', 'stone', 'amber', 'salt',
  'ember', 'field', 'harbour', 'linen', 'orchard', 'quiet', 'signal', 'tide'];

type CardKind ='photo' | 'screenshot' | 'note' | 'swatch' | 'sticker';

export type CardPlan = {
  kind: CardKind,
  /** Which base picture, for a photo or a screenshot. */
  base: number,
  x: number, y: number, w: number, h: number, rot: number,
  text?: string, hex?: string, shape?: string, tint?: number,
  portrait?: boolean,
};

export type BoardPlan = {
  seed: number,
  cards: CardPlan[],
  /** Index pairs into `cards`. */
  connections: [number, number][],
  /** Boxes in world units, drawn round a block of cells each. */
  fences: { name: string, x: number, y: number, w: number, h: number }[],
  /** Card indices per stop. */
  tour: number[][],
  /** Card index and the offset it is moved by, one per timeline step. */
  moves: { card: number, dx: number, dy: number }[],
};

/** A box of the given aspect with the default card's area, in whole units. */
function boxFor(aspect: number) {
  const w = Math.sqrt(CARD_AREA * aspect);
  return { w: Math.round(w), h: Math.round(w / aspect) };
}

/**
 * Every card, every line, both fences, the tour and the history, from a seed.
 *
 * Pure and deterministic, which is the whole of the standard board's claim: a
 * file that says `seed 20260923` describes the same board on a phone and at
 * the desk. World +y is up; the board is centred on the origin.
 */
export function planStandardBoard(seed = DEFAULT_SEED): BoardPlan {
  const rand = mulberry32(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const kinds: CardKind[] = [];
  for (const [kind, n] of COUNTS) {
    for (let i = 0; i < n; i++) kinds.push(kind);
  }
  // Shuffled so the photographs are spread across the board rather than in a
  // block, which is what a board somebody made looks like.
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  const rows = Math.ceil(kinds.length / COLS);
  const cards: CardPlan[] = kinds.map((kind, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    // Cell centre, jittered by up to a sixth of a cell either way.
    const x = Math.round((col - (COLS - 1) / 2) * CELL + (rand() - 0.5) * CELL / 3);
    const y = Math.round(((rows - 1) / 2 - row) * CELL + (rand() - 0.5) * CELL / 3);
    const rot = 0;
    if (kind === 'photo') {
      const portrait = rand() < 0.3;
      const { w, h } = boxFor(portrait ? PHOTO_H / PHOTO_W : PHOTO_W / PHOTO_H);
      return { kind, base: Math.floor(rand() * PHOTO_BASES), x, y, w, h, rot, portrait };
    }
    if (kind === 'screenshot') {
      const { w, h } = boxFor(SHOT_W / SHOT_H);
      return { kind, base: Math.floor(rand() * SHOT_BASES), x, y, w, h, rot };
    }
    if (kind === 'note') {
      const text = Array.from({ length: 3 + Math.floor(rand() * 9) }, () => pick(WORDS)).join(' ');
      return { kind, base: 0, x, y, w: 160, h: 160, rot, text, tint: 1 + Math.floor(rand() * 4) };
    }
    if (kind === 'swatch') {
      const hex = '#' + Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0');
      return { kind, base: 0, x, y, w: 160, h: 160, rot, hex };
    }
    return { kind, base: 0, x, y, w: 72, h: 72, rot: Math.round((rand() * 16 - 8) * 10) / 10, shape: pick(STICKERS) };
  });
  // Lines between cards that can carry them (a sticker cannot be an end).
  const ends = cards.map((c, i) => (c.kind === 'sticker' ? -1 : i)).filter(i => i >= 0);
  const connections: [number, number][] = [];
  while (connections.length < 8) {
    const a = pick(ends), b = pick(ends);
    if (a !== b && !connections.some(([p, q]) => (p === a && q === b) || (p === b && q === a))) {
      connections.push([a, b]);
    }
  }
  // Two fences, each round a block of three by two cells.
  const fenceAt = (col: number, row: number, name: string) => ({
    name,
    x: Math.round((col + 1 - (COLS - 1) / 2) * CELL),
    y: Math.round(((rows - 1) / 2 - row - 0.5) * CELL),
    w: 3 * CELL, h: 2 * CELL,
  });
  const fences = [fenceAt(1, 1, 'First'), fenceAt(7, 6, 'Second')];
  // Three stops of three photographs each, from different parts of the board.
  const photos = cards.map((c, i) => (c.kind === 'photo' ? i : -1)).filter(i => i >= 0);
  const third = Math.floor(photos.length / 3);
  const tour = [0, 1, 2].map(k => photos.slice(k * third, k * third + 3));
  const moves = Array.from({ length: HISTORY_STEPS }, () => ({
    card: pick(photos),
    dx: Math.round((rand() - 0.5) * CELL),
    dy: Math.round((rand() - 0.5) * CELL),
  }));
  return { seed, cards, connections, fences, tour, moves };
}

// ---------------------------------------------------------------------------
// Drawing the bases (browser only)
// ---------------------------------------------------------------------------

type Encoded = { original: Uint8Array, display: Uint8Array, thumb: Uint8Array, mime: string, ext: string };

/** A little grain, so a picture compresses like a photograph and not a poster. */
function noiseTile(rand: () => number) {
  const tile = new OffscreenCanvas(256, 256);
  const g = tile.getContext('2d')!;
  const img = g.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(rand() * 255);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return tile;
}

function drawPhoto(g: OffscreenCanvasRenderingContext2D, w: number, h: number, rand: () => number, grain: OffscreenCanvas) {
  const hue = Math.floor(rand() * 360);
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, `hsl(${hue} 55% 70%)`);
  sky.addColorStop(0.6, `hsl(${(hue + 40) % 360} 45% 55%)`);
  sky.addColorStop(1, `hsl(${(hue + 80) % 360} 35% 25%)`);
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `hsl(${(hue + rand() * 120) % 360} ${30 + rand() * 50}% ${20 + rand() * 60}% / ${0.3 + rand() * 0.5})`;
    g.beginPath();
    g.arc(rand() * w, rand() * h, (0.02 + rand() * 0.2) * w, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 0.12;
  g.globalCompositeOperation = 'overlay';
  g.fillStyle = g.createPattern(grain, 'repeat')!;
  g.fillRect(0, 0, w, h);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

function drawShot(g: OffscreenCanvasRenderingContext2D, w: number, h: number, rand: () => number) {
  g.fillStyle = '#f4f4f2';
  g.fillRect(0, 0, w, h);
  g.fillStyle = `hsl(${Math.floor(rand() * 360)} 60% 45%)`;
  g.fillRect(0, 0, w, 220);
  g.font = '48px sans-serif';
  for (let y = 300; y < h - 100; y += 140) {
    g.fillStyle = '#ddd';
    g.fillRect(40, y, 100, 100);
    g.fillStyle = '#333';
    g.fillText(WORDS[Math.floor(rand() * WORDS.length)] + ' ' + WORDS[Math.floor(rand() * WORDS.length)], 170, y + 45);
    g.fillStyle = '#999';
    g.fillRect(170, y + 65, 300 + rand() * 500, 18);
  }
}

async function bytesOf(canvas: OffscreenCanvas, type: string, quality?: number) {
  const blob = await canvas.convertToBlob({ type, quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/** The same picture at a smaller long side, as a baked copy is. */
async function scaled(source: OffscreenCanvas, side: number, type: string) {
  const k = side / Math.max(source.width, source.height);
  const out = new OffscreenCanvas(Math.round(source.width * k), Math.round(source.height * k));
  const g = out.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, 0, 0, out.width, out.height);
  return bytesOf(out, type, 0.85);
}

async function encodeBase(kind: 'photo' | 'screenshot', portrait: boolean, rand: () => number, grain: OffscreenCanvas): Promise<Encoded> {
  const [w, h] = kind === 'photo'
    ? (portrait ? [PHOTO_H, PHOTO_W] : [PHOTO_W, PHOTO_H])
    : [SHOT_W, SHOT_H];
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d')!;
  if (kind === 'photo') drawPhoto(g, w, h, rand, grain); else drawShot(g, w, h, rand);
  const photo = kind === 'photo';
  const mime = photo ? 'image/jpeg' : 'image/png';
  // 0.82 lands a 12 MP picture of this kind at 2-3 MB, a phone camera's size;
  // 0.9 made the board 360 MB, past what an older phone should be asked to hold.
  const original = await bytesOf(canvas, mime, photo ? 0.82 : undefined);
  // The baked copies are JPEG for both kinds (the app's own are WebP): a comment
  // segment is what makes each card's copy distinct, and WebP has no such slot
  // a decoder is sure to skip.
  const display = await scaled(canvas, DISPLAY_SIDE, 'image/jpeg');
  const thumb = await scaled(canvas, THUMB_SIDE, 'image/jpeg');
  // Let the 48 MB backing store go before the next one is drawn.
  canvas.width = canvas.height = 0;
  return { original, display, thumb, mime, ext: photo ? 'jpg' : 'png' };
}

/**
 * A 64-hex id for a card's copy of a base picture, and the one shortcut here.
 *
 * Not the digest of the bytes: hashing a hundred and fifty megabytes on a phone
 * reached over the LAN goes through the hand-written SHA-256 at a twenty-fifth
 * of native speed, and would be most of the generation time. Nothing checks it
 * against the bytes - the board is never packed - and it is as distinct per card
 * as the bytes are, which is all an asset id is asked to be here.
 */
const cardHash = (base: string, role: string, i: number) =>
  sha256(new TextEncoder().encode(`${base}:${role}:${i}`));

type BuiltBoard ={ seed: number, cards: number, assetBytes: number, generationMs: number };

/**
 * Build the standard board and load it. Marks it as the benchmark's first, so
 * nothing the load sets off - an autosave, a shelving - can take it for the
 * user's. `progress` hears a fraction from 0 to 1.
 */
export async function buildStandardBoard(seed = DEFAULT_SEED, progress: (f: number) => void = () => {}): Promise<BuiltBoard> {
  markBenchBoard();
  const t0 = performance.now();
  const plan = planStandardBoard(seed);
  const rand = mulberry32(seed ^ 0x5eed);
  const grain = noiseTile(rand);
  // Base picture index -> its encodes. Photographs alternate landscape and
  // portrait by index, so every base is used by cards of its own shape.
  const photoBases: Encoded[][] = [[], []];
  const shotBases: Encoded[] = [];
  const steps = PHOTO_BASES * 2 + SHOT_BASES + 1;
  let step = 0;
  for (const portrait of [false, true]) {
    for (let b = 0; b < PHOTO_BASES; b++) {
      photoBases[portrait ? 1 : 0].push(await encodeBase('photo', portrait, rand, grain));
      progress(++step / steps);
    }
  }
  for (let b = 0; b < SHOT_BASES; b++) {
    shotBases.push(await encodeBase('screenshot', false, rand, grain));
    progress(++step / steps);
  }
  let assetBytes = 0;
  const ids = plan.cards.map((_, i) => `bench-${i}`);
  // Raw, as a file's board.json is: loadBoard() normalises every one of them.
  const items: Record<string, unknown>[] = [];
  for (let i = 0; i < plan.cards.length; i++) {
    const c = plan.cards[i];
    const common = { id: ids[i], x: c.x, y: c.y, w: c.w, h: c.h, rot: c.rot };
    if (c.kind === 'photo' || c.kind === 'screenshot') {
      const base = c.kind === 'photo' ? photoBases[c.portrait ? 1 : 0][c.base] : shotBases[c.base];
      const tag = `${c.kind}-${c.portrait ? 'p' : 'l'}-${c.base}`;
      const mark = (bytes: Uint8Array, jpeg: boolean) =>
        (jpeg ? jpegWithComment(bytes, `mbrd-bench ${seed} card ${i}`) : pngWithText(bytes, `${seed} card ${i}`));
      const original = mark(base.original, base.ext === 'jpg');
      const display = mark(base.display, true);
      const thumb = mark(base.thumb, true);
      const name = c.kind === 'photo' ? `IMG_${String(1000 + i)}.jpg` : `Screenshot_${String(i).padStart(3, '0')}.png`;
      const [h, hd, ht] = await Promise.all([
        cardHash(tag, 'original', i), cardHash(tag, 'display', i), cardHash(tag, 'thumb', i),
      ]);
      // SAFETY: each Uint8Array here was built whole by frames.ts, so its buffer
      // is its own - an ArrayBuffer, never a SharedArrayBuffer.
      const blob = (bytes: Uint8Array, type: string) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
      putAsset(h, blob(original, base.mime), { mime: base.mime, ext: base.ext, name });
      putAsset(hd, blob(display, 'image/jpeg'), { mime: 'image/jpeg', ext: 'jpg', name: 'display.jpg' });
      putAsset(ht, blob(thumb, 'image/jpeg'), { mime: 'image/jpeg', ext: 'jpg', name: 'thumb.jpg' });
      assetBytes += original.length + display.length + thumb.length;
      items.push({
        ...common, type: 'image', name,
        asset: { hash: h, embedded: true },
        meta: {
          mime: base.mime, ext: base.ext, size: original.length, mtime: 0, origName: name,
          sized: true, thumb: ht, display: hd,
        },
      });
    } else if (c.kind === 'note') {
      items.push({ ...common, type: 'note', name: c.text!.slice(0, 40), meta: { text: c.text, tint: c.tint } });
    } else if (c.kind === 'swatch') {
      items.push({ ...common, type: 'swatch', name: c.hex!.toUpperCase(), meta: { hex: c.hex } });
    } else {
      items.push({ ...common, type: 'sticker', name: c.shape!, meta: { shape: c.shape } });
    }
  }
  plan.fences.forEach((f, k) => {
    items.push({ id: `bench-fence-${k}`, type: 'fence', name: f.name, x: f.x, y: f.y, w: f.w, h: f.h, rot: 0, z: -1000 - k });
  });
  loadBoard({
    title: `Benchmark ${seed}`,
    items,
    connections: plan.connections.map(([a, b]) => [ids[a], ids[b]]),
    tour: plan.tour.map(stop => ({ cards: stop.map(i => ids[i]) })),
  });
  // A history to scrub: one moved photograph per step, each its own undo entry
  // and so its own timeline step, as a drag would leave.
  for (const m of plan.moves) {
    const id = ids[m.card];
    const it = byId(id);
    if (!it) continue;
    const before = snapshotGeom([id]);
    it.x += m.dx;
    it.y += m.dy;
    commitGeom('Move', before, [id]);
  }
  progress(1);
  return {
    seed,
    cards: board.items.length,
    assetBytes,
    generationMs: Math.round(performance.now() - t0),
  };
}
