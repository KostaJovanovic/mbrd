// Memory budget for imports: file size, batch bytes, and pixel count ceilings.
// Nothing here refuses - ceilings are warnings. See consent.ts for the decision.
// Pure module: no DOM, no state, loadable without a browser.

import type { Crossed } from '../consent.ts';
import { mb } from '../consent.ts';
import { imageDimensions, HEADER_BYTES } from '../image-header.ts';

export const IMPORT_LIMITS = {
  /** One file, raw. Matches storage/zip.ts single-entry ceiling. */
  fileBytes: 512 * 1024 ** 2,
  /** Early heads-up threshold, well below the hard ceilings. */
  warnBytes: 60 * 1024 ** 2,
  /** Raw bytes across one import. */
  batchBytes: 1024 ** 3,
  /** Pixel budget per image. 64 MP ≈ 256 MB decoded. Declined → named card, no decode. */
  pixels: 64 * 1024 * 1024,
};

// Running byte account: check() measures, charge() bills, take() does both.
export function makeByteBudget(limit: number = IMPORT_LIMITS.batchBytes) {
  let spent = 0;
  return {
    /** Which ceilings this file crosses, without charging. Empty = fits. */
    check(bytes: number): Crossed[] {
      const n = Number.isFinite(bytes) ? bytes : 0;
      const out: Crossed[] = [];
      if (n > IMPORT_LIMITS.fileBytes) {
        out.push({
          ceiling: 'file-bytes',
          what: `This file is ${mb(n)}, past the ${mb(IMPORT_LIMITS.fileBytes)} one file is normally given.`,
        });
      }
      // Report from the larger of spent vs inFlight.
      const account = Math.max(spent, inFlight);
      if (account + n > limit) {
        out.push({
          ceiling: 'batch-bytes',
          what: `This import comes to ${mb(account + n)}, past the ${mb(limit)} one import is normally given.`
            + (inFlight > spent ? ' Another import is still running and shares the same budget.' : ''),
        });
      }
      return out;
    },
    /** Bill unconditionally (the user already agreed). */
    charge(bytes: number) {
      const n = Number.isFinite(bytes) ? bytes : 0;
      spent += n;
      inFlight += n;
    },
    take(bytes: number) {
      const n = Number.isFinite(bytes) ? bytes : 0;
      if (n > IMPORT_LIMITS.fileBytes) return false;
      if (spent + n > limit || inFlight + n > limit) return false;
      spent += n;
      inFlight += n;
      return true;
    },
    spent: () => spent,
    /** Release this budget's charge from the shared inFlight counter. */
    release() { inFlight = Math.max(0, inFlight - spent); },
  };
}

// Shared across concurrent imports so overlapping drops share one budget.
let inFlight = 0;

// The header reader moved to the base layer, where canvas/display.ts can reach
// it too; re-exported so this stays the place an import asks.
export { imageDimensions } from '../image-header.ts';
export type { Dimensions } from '../image-header.ts';

/** Header-only check: does this image exceed the pixel budget? */
export async function overPixelBudget(file: Blob): Promise<boolean> {
  return !!(await pixelCrossing(file));
}

// Memoised by Blob identity (immutable, asked multiple times per drop).
const crossingMemo = new WeakMap<Blob, Promise<Crossed | null>>();

/** Pixel crossing with dimensions, or null if it fits / unreadable. */
export function pixelCrossing(file: Blob): Promise<Crossed | null> {
  let hit = crossingMemo.get(file);
  if (!hit) {
    hit = computeCrossing(file);
    crossingMemo.set(file, hit);
  }
  return hit;
}

async function computeCrossing(file: Blob): Promise<Crossed | null> {
  try {
    const head = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
    const dims = imageDimensions(head);
    if (!dims || dims.w <= 0 || dims.h <= 0) return null;
    const px = dims.w * dims.h;
    if (px <= IMPORT_LIMITS.pixels) return null;
    return {
      ceiling: 'pixels',
      what: `This image declares ${dims.w}x${dims.h} - ${Math.round(px / 1e6)} megapixels, past the `
        + `${Math.round(IMPORT_LIMITS.pixels / 1e6)} a decode is normally given, and about `
        + `${mb(px * 4)} to decode.`,
    };
  } catch {
    return null;
  }
}
