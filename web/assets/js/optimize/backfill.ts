// Background video poster backfill: grabs first frames for clips that have
// none, one at a time, in idle windows. Stops on hidden tabs (rVFC does not
// fire), refused clips (H.265 without ffmpeg), or nothing left. Also audits
// existing covers for blank frames left by older builds. Thumbnail is cut
// alongside the poster so both zoom levels are covered.

import { board, bus, byId, setItemPoster, setItemThumb } from '../state.ts';
import { addFile, derivedFile, getAsset } from '../storage/assets.ts';
import { pictureIsFlat, videoFrame } from '../canvas/poster.ts';
import { makeThumb } from './picture.ts';
import type { Item } from '../board-model.ts';

const SETTLE_MS = 6000;
const GAP_MS = 1500;
const IDLE_MS = 4000;

const refused = new Set<string>();
let timer = 0;
let busy = false;
let wired = false;

export function initBackfill(): void {
  if (wired) return;
  wired = true;
  bus.on('board:load', () => { refused.clear(); arm(SETTLE_MS); });
  bus.on('items', () => arm(GAP_MS));
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') arm(GAP_MS);
  });
  arm(SETTLE_MS);
}

function arm(ms: number): void {
  if (timer || busy) return;
  timer = setTimeout(() => { timer = 0; void pass(); }, ms);
}

async function pass(): Promise<void> {
  if (busy || document.visibilityState !== 'visible') return;
  const item = nextWanted();
  if (!item) {
    // Nothing to grab; audit one existing cover for blank frames instead.
    busy = true;
    try {
      await idleWindow();
      if (await auditOne()) arm(GAP_MS);
    } catch { /* a cover that will not decode is not this module's business */ }
    finally { busy = false; }
    return;
  }

  busy = true;
  try {
    await idleWindow();
    // Re-read after idle wait; item may have been deleted or fixed.
    const fresh = byId(item.id);
    if (!fresh || !wantsPoster(fresh)) return;
    // Must refuse (not skip) missing assets, or nextWanted() retries forever.
    const asset = getAsset(fresh.asset?.hash);
    if (!asset) { refused.add(fresh.id); return; }

    const frame = await videoFrame(asset.blob);
    if (!frame) { refused.add(fresh.id); return; }
    const hash = await addFile(derivedFile(frame.blob, 'poster'));
    // `true`: force-replace — wantsPoster() confirmed the cover is blank or missing.
    setItemPoster(fresh.id, hash, true);
    const after = byId(fresh.id);
    if (after && wantsPoster(after)) { refused.add(fresh.id); return; }
    // Thumb from the poster, not the clip — poster is already 640px max.
    const small = await makeThumb(frame.blob);
    if (small) setItemThumb(fresh.id, await addFile(derivedFile(small.blob, 'thumb')));
  } catch (err) {
    refused.add(item.id);
    console.warn('[mbrd] no poster for', item.name || item.id, err);
  } finally {
    busy = false;
    arm(GAP_MS);
  }
}

function wantsPoster(it: Item): boolean {
  if (it.type !== 'video' || !it.asset?.hash || refused.has(it.id)) return false;
  const cover = typeof it.meta?.cover === 'string' ? it.meta.cover : '';
  if (!cover || !getAsset(cover)) return true;
  // Bytes present but flat (black rectangle) — needs re-cutting.
  return blank.has(cover);
}

// Keyed by hash — two clips sharing a blank poster share one entry.
const blank = new Set<string>();
const audited = new Set<string>();

function nextWanted(): Item | null {
  return board.items.find(wantsPoster) || null;
}

// Decode one unaudited cover to check if it is blank. Returns true if learned.
async function auditOne(): Promise<boolean> {
  const it = board.items.find(i =>
    i.type === 'video'
    && typeof i.meta?.cover === 'string'
    && !audited.has(i.meta.cover)
    && !!getAsset(i.meta.cover));
  const cover = typeof it?.meta?.cover === 'string' ? it.meta.cover : '';
  if (!cover) return false;
  audited.add(cover);
  const asset = getAsset(cover);
  if (!asset) return false;
  if (await pictureIsFlat(asset.blob)) {
    blank.add(cover);
    console.warn('[mbrd] poster: the picture on', it?.name || it?.id, 'has nothing in it - re-cutting');
  }
  return true;
}

// Wait for idle, with IDLE_MS timeout so continuous panning does not stall forever.
function idleWindow(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: IDLE_MS });
    } else {
      setTimeout(resolve, 0);
    }
  });
}
