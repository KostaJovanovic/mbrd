// Display copies: shrink photos to card size so full-res originals stay out of
// the GPU. Generation is serialized (one decode at a time). Matted copies are
// persisted to IndexedDB so the neural net does not re-run on every load.

import { getAsset, assetURL } from '../storage/assets.ts';
import { loadMatte, saveMatte, forgetMatte } from '../storage/matte-cache.ts';
import { quality } from '../quality.ts';
import { DISPLAY_SIDE } from '../optimize/picture.ts';
import { blobDimensions } from '../image-header.ts';
import { cutout, MODEL_NAME, ORT_VERSION } from './matte.ts';
import { surface, surfaceToBlob, type Surface } from './surface.ts';

// Driven by the quality dial. Changing it invalidates the cache (resetItems → clearDisplay).
const displayMax = () => quality.sharpness;

/**
 * Whether the baked copy a board carries (meta.display, DISPLAY_SIDE long) is
 * sharp enough for the dial. At Soft it is exactly the size asked for. Above
 * it the baked copy was the reason Picture sharpness seemed to do nothing: a
 * plain photo showed it whatever the dial said, so a runtime copy at the
 * dial's edge is made instead.
 */
export const bakedServes = () => displayMax() <= DISPLAY_SIDE;

/** The long edge of the copy a plain photo shows, for canvas/hires.ts. */
export const copyEdge = () => Math.max(DISPLAY_SIDE, displayMax());

/**
 * How far a copy has to shrink its source to be worth making.
 *
 * A copy is a decode, a resize and a WebP encode, redone at every start (only
 * cut-outs are kept), and it loses a little to the encode. Pictures optimised
 * to MAX_SIDE (1200) under Balanced's 1152 were the case that found this: a
 * copy of every photograph on the board to take 4% off its width, the queue
 * busy for the first minute of every session, and each card re-rastered as its
 * copy landed. Under a tenth smaller, the source is shown as it is.
 */
const WORTH = 0.9;

/** The scale a copy of a picture `long` px on its long edge is drawn at; 1 for none. */
export function copyScale(long: number, max = displayMax()) {
  const scale = Math.min(1, max / long);
  return scale > WORTH ? 1 : scale;
}
const QUALITY = 0.82;

// Crop is baked into the copy so object-fit keeps working without knowing crops exist.
export type Crop = { x: number, y: number, w: number, h: number } | null;

// Baked into the copy: quarter turn (swaps the box), matte (no CSS equivalent).
// Applied after crop, in that order.
export type Turn = 90 | 180 | 270 | null;
export type Matte = boolean;

const keyFor = (hash: string, crop: Crop, rot: Turn, matte: Matte) =>
  hash
  + (crop ? `|${crop.x},${crop.y},${crop.w},${crop.h}` : '')
  + (rot ? `@${rot}` : '')
  + (matte ? '%' : '');

const derived = (crop: Crop, rot: Turn, matte: Matte) => !!(crop || rot || matte);

// Bump when the drawing code changes to invalidate persisted copies.
const COPY_REV = 1;

// Persist key for cut-outs. Includes sharpness, quality, model version, and COPY_REV.
export const matteVariant = (hash: string, crop: Crop, rot: Turn) =>
  keyFor(hash, crop, rot, true).slice(hash.length)
  + `~${displayMax()}~${QUALITY}~${MODEL_NAME}@${ORT_VERSION}~${COPY_REV}`;

const cache = new Map<string, { url: string; own: boolean }>();
const pending = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();
// Bumped by clearDisplay(); stale jobs check this and decline to publish.
let epoch = 0;

// A job's right to publish: the epoch it started in, and whether
// forgetDisplay() has since purged its hash.
type Ticket = { epoch: number, forgotten: boolean };
const tickets = new Map<string, Ticket>();

// Synchronous: returns the URL if the copy exists, else null.
export function displayURLReady(
  hash: string, crop: Crop = null, rot: Turn = null, matte: Matte = false,
): string | null {
  return cache.get(keyFor(hash, crop, rot, matte))?.url || null;
}

/**
 * Idempotent: repeated calls share one job. Null if the asset is gone.
 *
 * `baked` is the board's own DISPLAY_SIDE copy of a plain picture
 * (meta.display). Above Soft a copy the dial asks for is made fresh every
 * session, so where one would be made at all, the baked copy is shown in its
 * place: a little softer than the dial's edge until the swap to the original
 * (canvas/hires.ts), and no decode, resize and encode per photo per start.
 */
export function ensureDisplay(
  hash: string, crop: Crop = null, rot: Turn = null, matte: Matte = false, baked = '',
): Promise<string | null> {
  const key = keyFor(hash, crop, rot, matte);
  const done = cache.get(key);
  if (done) return Promise.resolve(done.url);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const mine: Ticket = { epoch, forgotten: false };
  const job = start(hash, crop, rot, matte, mine, derived(crop, rot, matte) ? '' : baked);
  // Deleted by identity so a post-clear settle does not remove a newer job's entry.
  const tracked: Promise<string | null> = job.finally(() => {
    if (pending.get(key) === tracked) pending.delete(key);
    if (tickets.get(key) === mine) tickets.delete(key);
  });
  pending.set(key, tracked);
  tickets.set(key, mine);
  return tracked;
}

// Cached cut-outs bypass the queue (already card-sized). Everything else queues.
async function start(
  hash: string, crop: Crop, rot: Turn, matte: Matte, mine: Ticket, baked: string,
): Promise<string | null> {
  if (matte) {
    const kept = await loadMatte(hash, matteVariant(hash, crop, rot));
    if (kept) return publish(hash, crop, rot, matte, kept, mine);
  }
  // A plain picture needs only its header to learn whether a copy is due, and
  // the answer never waits behind somebody else's decode.
  if (!derived(crop, rot, matte)) {
    const a = getAsset(hash);
    if (!a) return null;
    const dims = a.blob ? await blobDimensions(a.blob) : null;
    if (dims && copyScale(Math.max(dims.w, dims.h)) === 1) return publish(hash, crop, rot, matte, null, mine);
    if (dims && baked && getAsset(baked)) return publish(hash, crop, rot, matte, baked, mine);
  }
  const decode = queue.then(() => derive(hash, crop, rot, matte, mine));
  queue = decode.catch(() => {});
  return decode;
}

async function derive(
  hash: string, crop: Crop, rot: Turn, matte: Matte, mine: Ticket,
): Promise<string | null> {
  const key = keyFor(hash, crop, rot, matte);
  const existing = cache.get(key);
  if (existing) return existing.url;
  const a = getAsset(hash);
  if (!a) return null;
  const variant = matte ? matteVariant(hash, crop, rot) : '';
  const made = await shrink(a.blob, crop, rot, matte);
  // Only persist when the model actually ran; a failed cutout must not be pinned to disk.
  if (matte && made.knocked && made.blob && !mine.forgotten) void saveMatte(hash, variant, made.blob);
  return publish(hash, crop, rot, matte, made.blob, mine);
}

// `small` is a copy made here, the hash of the board's baked copy, or null for
// the source itself.
function publish(
  hash: string, crop: Crop, rot: Turn, matte: Matte, small: Blob | string | null, mine: Ticket,
): string | null {
  if (mine.epoch !== epoch || mine.forgotten) return null;
  const key = keyFor(hash, crop, rot, matte);
  const won = cache.get(key);
  if (won) return won.url;
  // own=true: this module revokes it. own=false: asset store's URL, not ours.
  const entry = small && typeof small !== 'string'
    ? { url: URL.createObjectURL(small), own: true }
    : { url: assetURL(small || hash)!, own: false };
  cache.set(key, entry);
  return entry.url;
}

type Made = { blob: Blob | null, knocked: boolean };
const NOTHING: Made = { blob: null, knocked: false };

async function shrink(
  blob: Blob | null | undefined, crop: Crop = null, rot: Turn = null, matte: Matte = false,
): Promise<Made> {
  if (!blob || !/^image\//i.test(blob.type)) return NOTHING;
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    return NOTHING;
  }
  try {
    const sx = crop ? Math.round(crop.x * bmp.width) : 0;
    const sy = crop ? Math.round(crop.y * bmp.height) : 0;
    const sw = Math.max(1, crop ? Math.round(crop.w * bmp.width) : bmp.width);
    const sh = Math.max(1, crop ? Math.round(crop.h * bmp.height) : bmp.height);
    const scale = copyScale(Math.max(sw, sh));
    if (scale === 1 && !derived(crop, rot, matte)) return NOTHING;
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const quarter = rot === 90 || rot === 270;
    const dw = quarter ? h : w;
    const dh = quarter ? w : h;
    const face = surface(dw, dh);
    if (!face) return NOTHING;
    if (rot) {
      face.ctx.translate(dw / 2, dh / 2);
      face.ctx.rotate(rot * Math.PI / 180);
      face.ctx.drawImage(bmp, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
      face.ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      face.ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
    }
    // After the turn so the model sees the picture upright.
    const knocked = matte ? await cutout(face, dw, dh) : false;
    return { blob: await encode(face, blob.type, knocked), knocked };
  } catch {
    return NOTHING;
  } finally {
    bmp.close?.();
  }
}

// WebP first; JPEG fallback only for opaque JPEG sources (Safari cannot encode WebP).
// A matted image must keep alpha, so it stays as whatever the canvas produced (PNG).
async function encode(
  face: Surface, sourceType: string, knocked = false,
): Promise<Blob | null> {
  const first = await surfaceToBlob(face, 'image/webp', QUALITY);
  if (!first) return null;
  if (first.type.toLowerCase() === 'image/webp') return first;
  if (knocked || !/^image\/jpe?g$/i.test(sourceType)) return first;
  try {
    const jpeg = await surfaceToBlob(face, 'image/jpeg', QUALITY);
    return jpeg?.type.toLowerCase() === 'image/jpeg' ? jpeg : first;
  } catch {
    return first;
  }
}

// Drop copies of specific hashes (for bin purge). Splits key at the first sigil.
export function forgetDisplay(hashes: Iterable<string>) {
  const doomed = new Set(hashes);
  const mine = (key: string) => doomed.has(key.split(/[|@%]/)[0]);
  for (const key of Array.from(cache.keys()).filter(mine)) {
    const entry = cache.get(key);
    if (entry?.own) URL.revokeObjectURL(entry.url);
    cache.delete(key);
  }
  for (const key of Array.from(pending.keys()).filter(mine)) pending.delete(key);
  // A job still running would publish a new copy of a purged hash.
  for (const [key, ticket] of tickets) {
    if (mine(key)) { ticket.forgotten = true; tickets.delete(key); }
  }
  void forgetMatte(doomed);
}

export function clearDisplay() {
  for (const e of cache.values()) if (e.own) URL.revokeObjectURL(e.url);
  cache.clear();
  pending.clear();
  tickets.clear();
  // Queue stays alive — a fresh chain would allow two full decodes at once.
  epoch++;
}
