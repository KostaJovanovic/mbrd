// The arithmetic of a frame reading: percentiles, the display's own beat, the
// tail counted in it, and the compact series a benchmark file carries. Pure -
// no DOM, no clock - so the view profiler and the benchmark read gaps one way,
// and npm test can pin that way without a browser.

/** The value at fraction `p` of a sorted list, or 0 for an empty one. */
export function pct(sorted: readonly number[], p: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
}

/**
 * How far a gap is off the display's own beat, in frames.
 *
 * A gap is never a free quantity: the compositor hands over on a refresh or
 * it does not, so every interval is a whole number of them and the whole
 * distribution lands on multiples of one. Anything that is *not* near a
 * multiple did not come from a missed refresh, which is why it is counted
 * separately below.
 */
const OFF_BEAT = 0.25;
/** Below this a gap is a normal frame and no question is being asked of it. */
const A_FRAME = 1.15;

export type FrameStats = {
  sorted: number[], median: number, janks: number,
  base: number, twos: number, overs: number, off: number,
};

/**
 * The reading of a run of frame gaps, in ms.
 *
 * The median is the wrong number to measure jank against on a phone, and
 * reading a run against it is what nearly cost a day. These panels change
 * refresh rate on their own: 120Hz under the finger, 60 when the system
 * decides otherwise. A run that spends part of itself at 60 has a median
 * pulled towards 16.7ms, so genuinely dropped frames stop looking dropped -
 * and, worse the other way, a clean stretch at 60Hz scores as jank against
 * a 120Hz median while nothing was missed at all.
 *
 * So the beat is taken from the fast end of the run instead: the 5th
 * percentile is the interval the panel manages when it is trying, robust
 * against the one or two impossibly short gaps a timer can produce. The tail
 * is expressed in that beat. Two beats is deliberately kept apart from three:
 * a two-beat gap is exactly what a drop to 60Hz looks like on a 120Hz panel
 * and cannot be told from one missed refresh by any arithmetic on this data,
 * so it is reported and not accused. Three or more is past anything a
 * refresh-rate change explains, and is the honest count of frames lost.
 *
 * `off` is the gaps that are not a whole number of beats at all. A panel that
 * stepped to some third rate - 90Hz is 1.33 beats of 120 - lands there rather
 * than in the two counts, which is the point: it is the one shape in the data
 * that says the beat itself moved. Overlaps `twos`/`overs` by design.
 */
export function frameStats(gaps: readonly number[], beat = 0): FrameStats {
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = pct(sorted, 0.5) || 0;
  const janks = median ? gaps.filter(g => g > median * 1.5).length : 0;
  // `beat`, when given, is one measured elsewhere: see summariseGaps().
  const base = beat || pct(sorted, 0.05) || median;
  const twos = base ? gaps.filter(g => g >= base * 1.5 && g < base * 2.5).length : 0;
  const overs = base ? gaps.filter(g => g >= base * 2.5).length : 0;
  const off = base ? gaps.filter(g => {
    const f = g / base;
    return f > A_FRAME && Math.abs(f - Math.round(f)) > OFF_BEAT;
  }).length : 0;
  return { sorted, median, janks, base, twos, overs, off };
}

/** A number rounded to `places` decimals, as a number - what a JSON file wants. */
export const round = (n: number, places = 1) => {
  const k = 10 ** places;
  return Math.round(n * k) / k;
};

/** The frame half of a scenario's summary. Every figure a plain number. */
export type GapSummary = {
  n: number,
  fps: number,
  beatMs: number,
  twoBeatPct: number,
  threePlusPct: number,
  offBeatPct: number,
  p50: number, p95: number, p99: number, worst: number,
};

/**
 * The summary of a run of gaps, counted in its own beat - or in `beat` when
 * one is given, which is for a stretch that never once reached the display's
 * rate. Its own 5th percentile is then a slow frame, and every drop counted
 * against it vanishes: a timeline scrub at 60 ms a frame scored no 3-beat gaps
 * at all against a 60 ms "beat". The benchmark hands such a scenario the beat
 * the rest of the run saw (perf/bench.ts, rebeat()).
 */
export function summariseGaps(gaps: readonly number[], beat = 0): GapSummary {
  const { sorted, median, base, twos, overs, off } = frameStats(gaps, beat);
  const share = (k: number) => (gaps.length ? round(100 * k / gaps.length) : 0);
  return {
    n: gaps.length,
    fps: median ? round(1000 / median) : 0,
    beatMs: round(base, 2),
    twoBeatPct: share(twos),
    threePlusPct: share(overs),
    offBeatPct: share(off),
    p50: round(median),
    p95: round(pct(sorted, 0.95)),
    p99: round(pct(sorted, 0.99)),
    worst: round(pct(sorted, 1)),
  };
}

/**
 * Frame timestamps as the file carries them: the first, then every gap, in
 * whole tenths of a millisecond.
 *
 * A timestamp series is almost all the same small number, so storing the gaps
 * rather than the times is what keeps a two-minute run in the tens of
 * kilobytes. Tenths because a rAF timestamp is coarsened to 0.1ms or worse in
 * every engine, so a finer unit would store noise. Rounded per timestamp rather
 * than per gap, so the error does not accumulate along the series.
 */
export function encodeSeries(times: readonly number[]): { t0: number, d: number[] } {
  if (!times.length) return { t0: 0, d: [] };
  const tenths = times.map(t => Math.round(t * 10));
  const d: number[] = [];
  for (let i = 1; i < tenths.length; i++) d.push(tenths[i] - tenths[i - 1]);
  return { t0: tenths[0] / 10, d };
}

/** The inverse of encodeSeries(), to within the tenth it rounded to. */
export function decodeSeries({ t0, d }: { t0: number, d: readonly number[] }): number[] {
  const out = [t0];
  let at = Math.round(t0 * 10);
  for (const step of d) { at += step; out.push(at / 10); }
  return out;
}

/** Gaps between consecutive timestamps. */
export function gapsOf(times: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < times.length; i++) out.push(times[i] - times[i - 1]);
  return out;
}

/**
 * The gaps worth scoring: those that end after the warm-up.
 *
 * An adaptive panel idles at 24Hz and takes a frame or two to come back up
 * once something moves - every Feed run on the S22+ opened with a 3- or 5-beat
 * gap - so the first stretch of a scenario is a measurement of the panel
 * waking, not of the app.
 */
export function scoredGaps(times: readonly number[], warmupMs: number): number[] {
  if (!times.length) return [];
  const from = times[0] + warmupMs;
  const out: number[] = [];
  for (let i = 1; i < times.length; i++) if (times[i] > from) out.push(times[i] - times[i - 1]);
  return out;
}

/**
 * The spread of one figure across repeats of a scenario: min, max and the
 * range as a share of the mean. What the compare tool measures a change
 * against, rather than a noise level anybody assumed.
 */
export function spread(values: readonly number[]) {
  if (!values.length) return { min: 0, max: 0, rangePct: 0 };
  const min = Math.min(...values), max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { min, max, rangePct: mean ? round(100 * (max - min) / mean) : 0 };
}

/** mulberry32: the whole standard board comes out of one of these and its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// One base picture, many assets
// ---------------------------------------------------------------------------

/**
 * A JPEG with a comment segment carrying `text` put in straight after its
 * start-of-image marker.
 *
 * This is how eight encodes become a hundred distinct photographs: a COM
 * segment changes the bytes, so the hash, the asset, the blob URL and the
 * browser's decode are all the card's own, and no decoder draws a pixel of it.
 * Refuses anything that does not open with SOI rather than writing a file that
 * is no longer a JPEG.
 */
export function jpegWithComment(jpeg: Uint8Array, text: string): Uint8Array {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
  const body = new TextEncoder().encode(text);
  if (body.length > 0xfffd) throw new Error('comment too long for one segment');
  const len = body.length + 2;
  const out = new Uint8Array(jpeg.length + 4 + body.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set([0xff, 0xfe, len >> 8, len & 0xff], 2);
  out.set(body, 6);
  out.set(jpeg.subarray(2), 6 + body.length);
  return out;
}

let crcTable: Uint32Array | null = null;
/** CRC-32 as PNG chunks carry it. */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * A PNG with a tEXt chunk carrying `text` put in after IHDR - the screenshot
 * twin of jpegWithComment(). The chunk is ancillary, so a decoder skips it;
 * its CRC is real, so a strict one does not refuse the file.
 */
export function pngWithText(png: Uint8Array, text: string): Uint8Array {
  if (png.length < 33 || PNG_SIG.some((b, i) => png[i] !== b)) throw new Error('not a PNG');
  // IHDR is always first and always 13 bytes: 8 signature + 4 length + 4 type + 13 + 4 CRC.
  const at = 33;
  const data = new TextEncoder().encode('mbrd-bench\0' + text);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set([0x74, 0x45, 0x58, 0x74], 4);   // tEXt
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(png.subarray(at), at + chunk.length);
  return out;
}
