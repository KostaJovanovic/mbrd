// What a recording looks like: bytes in, one amplitude per bar out.
//
// The bars on an audio card are measured, not decorative. The file is decoded
// once, reduced to one RMS value per bar, and the result is cached on the item -
// so the shape you see is that recording's shape, a quiet intro reads as a quiet
// intro, and reopening the board does not decode anything a second time. The
// readings outlive the session too: a save writes them into the .mbrd as their
// own waveforms/<hash>.json, named after the audio rather than after the card,
// so a board comes back with its waveforms already drawn. See the sidecar block
// in storage/mbrd.js.
//
// When decoding is impossible - an exotic codec, no Web Audio, a context the
// browser has wedged - the fallback is a stable pattern derived from the file's
// own hash: still that file's own shape, in the weak sense that it never changes
// and never matches another file's, which is all a placeholder has to be.
//
// ── Why this is not beside the control strip ──
//
// This is arithmetic over sample data. There is no element in it, nothing here
// knows a bar is drawn as an <i> or that there is a play button next to it, and
// the one browser API it reaches for is a decoder that never touches the
// speakers. It sat inside the same module as a DOM transport for as long as
// there was only one caller for either, and the cost of that was that anything
// wanting to know a file's shape had to import a control strip - and, through
// it, the queue and the exclusivity rule.
//
// media/transport.js already says this in its own header, from the other side:
// "the audio *analysis* ... pairing it with a control strip would recreate the
// mixture this split exists to undo".
//
// ── What must not move in here ──
//
// Drawing. resample() below hands back numbers at whatever count the caller
// asked for and has no idea what a bar is; the moment this file knows a pitch in
// pixels it has become half of the transport again.
//
// Nor the cache policy for anything other than a measurement. peaks() writes to
// item.meta directly, which is a deliberate exception explained at the call and
// not a licence: it is a measurement of bytes that were already there, so it
// belongs in no undo entry - unlike every other write to an item, which goes
// through the mutation door.
//
// ── The item type is structural, and deliberately narrow ──
//
// This was written while state.ts and board-model.ts were both still carried
// under @ts-nocheck, and it said that when the board's own type landed this
// would become an import. The type has landed - board-model.ts exports `Item` -
// and this deliberately did not become an import.
//
// Because the two say different things. `Item` is what a card IS, and this is
// what a measurement NEEDS: an id, maybe an asset hash, maybe a place to put
// the readings. Naming the three fields keeps the requirement the narrower of
// the two, so this module stays callable with anything of that shape and its
// tests stay a struct literal rather than a whole board item. An `Item` is
// assignable to it, which is the direction that matters and the only one this
// module ever relies on.
//
// What would be a re-declaration, and is forbidden, is a second definition of
// `Item` itself. This is not one - it is a smaller requirement that `Item`
// happens to satisfy.

import { getAsset } from '../storage/assets.ts';
import { markDirty } from '../state.ts';

/** One reading per bucket, each in [0, 1]. PEAK_RES of them. */
export type Readings = number[];

/** The three fields of a board item a measurement needs. See the header. */
export interface Measurable {
  id: string;
  asset?: { hash?: string | null } | null;
  meta?: { peaks?: unknown } | null;
}

/**
 * How many readings are taken off a file, which is *not* how many bars get
 * drawn. The card's width decides that, and the card can be resized - so the
 * measurement is stored at a resolution finer than any card will ever show and
 * averaged down to fit. Re-measuring on resize would mean decoding the file
 * again to draw the same shape at a different pitch.
 */
const PEAK_RES = 256;

/**
 * The context, once. `null` is "not asked yet" and `false` is "asked and
 * refused" - see the constructor's own note below for why the two are told
 * apart.
 */
let decodeCtx: OfflineAudioContext | false | null = null;

function context(): OfflineAudioContext | null {
  // An OfflineAudioContext, deliberately, and not the live AudioContext this
  // used to build.
  //
  // Decoding is the only thing this module needs a context for - playback goes
  // through <audio>, which has its own pipeline - and an offline context never
  // reaches the speakers, so the autoplay policy takes no interest in it.
  // A live one is a different story: Firefox reports
  // getAutoplayPolicy('audiocontext') as "disallowed" out of the box, which
  // leaves the context parked in "suspended" until a gesture arrives. Every
  // card on the board decodes through the same one, so the whole set queues
  // behind that single gate and the waveforms all appear together some time
  // later, or never. Offline decoding also happens to be an order of magnitude
  // quicker - 9ms against 105ms on the same file - because nothing is being
  // scheduled against a real clock.
  //
  // The 1-frame, 44.1kHz shape is a formality. decodeAudioData ignores the
  // context's own length and resamples to its sample rate, and an RMS taken
  // over a bucket is indifferent to what that rate is.
  //
  // The constructor sits inside the try because it can throw - a browser with
  // audio disabled, a hardened profile - and it is called from outside
  // measure()'s own guard, where an exception would escape all the way out of
  // peaks() and leave the card with no readings at all. `false` records that
  // we asked and were refused, so it is not retried for every card.
  if (decodeCtx === null) {
    // The prefixed name is Safari's and is not in lib.dom, so the window is read
    // through an index rather than a property. Both spellings take the same
    // three arguments.
    const w = window as unknown as Record<string, typeof OfflineAudioContext | undefined>;
    const Ctx = w.OfflineAudioContext || w.webkitOfflineAudioContext;
    try { decodeCtx = Ctx ? new Ctx(1, 1, 44100) : false; } catch { decodeCtx = false; }
  }
  return decodeCtx || null;
}

/**
 * Measurements currently running, by asset hash.
 *
 * The readings cached on the item make this once per *file* rather than once
 * per mount - but only after the first one has finished. Two cards holding the
 * same recording mount together, both find nothing cached, and both start
 * decoding the same megabytes: the claim was true and the window in front of it
 * was not. Keyed by hash rather than by item id because that is what a waveform
 * actually belongs to - the same reason the sidecars in a .mbrd are named that
 * way - so the second card joins the first's decode instead of starting another.
 */
const measuring = new Map<string, Promise<Readings | null>>();

/**
 * One amplitude per bar, each in [0, 1], normalised so the loudest bar is full
 * height. RMS rather than peak: peak picks up single-sample transients and
 * draws almost every piece of music as a solid block.
 */
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

  // Cached on the item, so this happens once per file rather than once per
  // mount. Written directly rather than through a command: it is a measurement
  // of bytes that were already there, not an edit, and it belongs in no undo
  // entry.
  if (item.meta) item.meta.peaks = result;
  if (measured) markDirty();
  return result;
}

/**
 * Whether a set of readings can be drawn as they stand.
 *
 * The length check is what makes PEAK_RES safe to change: readings taken at
 * some older resolution are not recognised, and the file is measured again
 * rather than drawn at the wrong pitch. The value check earns its keep now
 * that readings can arrive out of a file a person is invited to open -
 * waveforms/<hash>.json inside the .mbrd - where a deleted comma or a stray
 * letter would otherwise reach drawBars() as a NaN and come out as a card of
 * bars with no height. mbrd.js checks that the file is well formed; this is
 * the narrower question of whether this build can use what was in it.
 */
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
    // Three decimals, not two. RMS against the loudest bucket puts quiet
    // passages well below 0.01, and rounding those to a flat 0.00 turns the
    // quiet half of a track into a dead line along the floor.
    return out.map(v => Math.round((v / loudest) * 1000) / 1000);
  } catch {
    return null;   // not a codec this browser decodes
  }
}

/**
 * How long a decode is given before the card settles for the stand-in shape.
 *
 * Not a guess at how slow decoding is - it is generous for that. It is here
 * because decodeAudioData is allowed to simply never settle: a codec the build
 * does not really support, a context the browser has quietly wedged, an
 * autoplay policy that leaves the whole graph parked. An await on a promise
 * that never resolves is indistinguishable from a hang, and the card would sit
 * there with no bars for the rest of the session with nothing logged anywhere.
 * Losing the real shape is a far smaller failure than an empty waveform.
 */
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
    // Swelled towards the middle, so it reads as a clip rather than as noise.
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
