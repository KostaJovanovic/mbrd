// Audio waveform extraction: decode once, cache RMS-per-bucket readings on the
// item (and in .mbrd sidecars). Falls back to a hash-derived pseudo-shape when
// decoding fails. Pure arithmetic — no DOM, no playback. Measurable is a
// structural subset of Item so tests need only a plain object.

import { getAsset } from '../storage/assets.ts';
import { markDirty } from '../state.ts';

/** One reading per bucket, each in [0, 1]. PEAK_RES of them. */
export type Readings = number[];

/** Structural subset of Item: just what a measurement needs. */
export interface Measurable {
  id: string;
  asset?: { hash?: string | null } | null;
  meta?: { peaks?: unknown } | null;
}

/** Storage resolution (not display bars). Finer than any card, resampled down to fit. */
const PEAK_RES = 256;

/** null = not tried, false = refused. */
let decodeCtx: OfflineAudioContext | false | null = null;

function context(): OfflineAudioContext | null {
  // Offline — avoids autoplay policy, 10x faster than live AudioContext.
  if (decodeCtx === null) {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    try { decodeCtx = Ctx ? new Ctx(1, 1, 44100) : false; } catch { decodeCtx = false; }
  }
  return decodeCtx || null;
}

/** In-flight decodes by asset hash. Dedupes concurrent mounts of the same file. */
const measuring = new Map<string, Promise<Readings | null>>();

/** Normalised RMS amplitudes in [0, 1]. Falls back to pseudo-shape on failure. */
export async function peaks(item: Measurable): Promise<Readings> {
  const cached = item.meta?.peaks;
  if (usable(cached)) return cached;

  const hash = item.asset?.hash;
  const asset: { blob: Blob } | undefined = hash ? getAsset(hash) : undefined;
  let measured: Readings | null = null;
  if (hash && asset) {
    let run = measuring.get(hash);
    if (!run) {
      run = measure(asset.blob).finally(() => measuring.delete(hash));
      measuring.set(hash, run);
    }
    measured = await run;
  }
  const result = measured || pseudo(hash || item.id);

  // Written directly — a measurement, not an edit, so no undo entry.
  if (item.meta) item.meta.peaks = result;
  if (measured) markDirty();
  return result;
}

/** Valid readings: right length, all numbers in [0, 1]. Guards against
 * changed PEAK_RES and corrupt .mbrd sidecars. */
function usable(v: unknown): v is Readings {
  return Array.isArray(v) && v.length === PEAK_RES
    && v.every(n => typeof n === 'number' && n >= 0 && n <= 1);
}

async function measure(blob: Blob): Promise<Readings | null> {
  const ctx = context();
  if (!ctx) return null;
  try {
    const buf = await withTimeout(ctx.decodeAudioData(await blob.arrayBuffer()));
    const data = buf.getChannelData(0);
    const per = Math.max(1, Math.floor(data.length / PEAK_RES));
    const out: number[] = [];
    let loudest = 0;
    for (let b = 0; b < PEAK_RES; b++) {
      const start = b * per;
      const end = Math.min(data.length, start + per);
      let sum = 0;
      for (let i = start; i < end; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / Math.max(1, end - start));
      out.push(rms);
      if (rms > loudest) loudest = rms;
    }
    if (!loudest) return out.map(() => 0);
    // 3 decimals — 2 would flatten quiet passages to zero.
    return out.map(v => Math.round((v / loudest) * 1000) / 1000);
  } catch {
    return null;   // not a codec this browser decodes
  }
}

/** Timeout for decode — decodeAudioData can hang on unsupported codecs. */
const DECODE_MS = 8000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('decode timed out')), DECODE_MS); }),
  ]);
}

/** A stable stand-in when the bytes cannot be decoded. Same file, same shape. */
function pseudo(seed: string): Readings {
  let h = 2166136261;
  for (let i = 0; i < String(seed).length; i++) {
    h ^= String(seed).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out: number[] = [];
  for (let i = 0; i < PEAK_RES; i++) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h |= 0;
    // Envelope swells toward centre so it reads as a clip, not noise.
    const envelope = 0.55 + 0.45 * Math.sin((i / (PEAK_RES - 1)) * Math.PI);
    out.push(Math.round(((0.25 + ((h >>> 0) % 1000) / 1000 * 0.75) * envelope) * 100) / 100);
  }
  return out;
}

/** Average the stored readings down to `n` bars. */
export function resample(values: readonly number[], n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * values.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / n));
    let sum = 0;
    for (let k = from; k < to; k++) sum += values[k];
    out.push(sum / (to - from));
  }
  return out;
}
