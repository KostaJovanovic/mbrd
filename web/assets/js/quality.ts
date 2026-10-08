// Per-device rendering quality — three stops (Light / Balanced / Full) with
// per-flag overrides. Lives in localStorage, not in the .mbrd, because how
// hard a phone works is a fact about the phone, not about someone else's board.
// Pure, no DOM. canvas/* reads `quality`; ui/quality.ts writes it.

import { readPrefJSON, writePref } from './prefs.ts';
import { hasOwn, isRecord } from './util.ts';

const PREF = 'mbrd.quality';

/** The three stops, and the eight flags they resolve to. */
export type QualityLevel = 'light' | 'balanced' | 'full';

export type QualityFlags = {
  motion: boolean,
  shadows: boolean,
  blur: boolean,
  anim: boolean,
  grain: boolean,
  hires: boolean,
  sharpness: number,
  build: number,
};

export type QualityKey = keyof QualityFlags;

/** The stops, low to high. The index is what the slider in the panel moves. */
export const QUALITY_LEVELS: { id: QualityLevel, label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'full', label: 'Full' },
];

/** Long edge of a display copy (see canvas/display.ts). Floor is 1024 — below
 *  that a zoomed card is a visible 2x upscale. Multiples of 128. */
export const SHARPNESS_STEPS = [
  { px: 1280, label: 'Crisp' },
  { px: 1152, label: 'Middle' },
  { px: 1024, label: 'Soft' },
];

/** Cards built per frame (BUILD_BUDGET in canvas/items.ts). Smaller = smoother zoom, slower fill. */
export const BUILD_STEPS = [
  { n: 12, label: '12 (fills in fastest)' },
  { n: 8, label: '8' },
  { n: 4, label: '4 (smoothest)' },
];

// Balanced changes only invisible-at-rest things (softer pictures, no panel
// blur, smaller batches). Light visibly trades fidelity for speed.
//
// `grain` and `hires` are the two that cost most on a phone and were the two
// the dial could not reach, which is why Light was reported as no faster than
// Full on Android. Both are off at Light and untouched elsewhere:
//
//   grain  the paper texture (#grain, canvas/grain.ts) - a window-sized
//          multiply-blended layer whose tile is repositioned every pan frame
//          and *resampled* every zoom frame. A blended layer cannot be
//          composited past its backdrop, so that is a full-viewport repaint
//          per frame, for a texture nobody is looking at while the board moves.
//   hires  the zoomed-in swap to the untouched original (canvas/hires.ts). A
//          camera frame is ~48 MB decoded and the <img> is blank until it
//          lands, so on a phone - where devicePixelRatio is 3 and the
//          threshold is crossed by an ordinary card at ordinary zoom - it is
//          both the stall and the flash. Light shows the display copy at every
//          zoom instead, which is exactly the trade this stop is for.
const PRESETS = {
  full: { motion: true, shadows: true, blur: true, anim: true, grain: true, hires: true, sharpness: 1280, build: 12 },
  balanced: { motion: true, shadows: true, blur: false, anim: true, grain: true, hires: true, sharpness: 1152, build: 8 },
  light: { motion: false, shadows: false, blur: false, anim: false, grain: false, hires: false, sharpness: 1024, build: 4 },
} satisfies Record<QualityLevel, QualityFlags>;

const DEFAULT_LEVEL: QualityLevel = 'full';
// SAFETY: `satisfies` above guarantees these are the six QualityFlags keys.
const KEYS = Object.keys(PRESETS.full) as QualityKey[];

/** Guard against arbitrary localStorage strings (including "__proto__"). */
const isLevel = (v: unknown): v is QualityLevel =>
  typeof v === 'string' && hasOwn(PRESETS, v);

/** Whether a string names one of the eight flags. */
const isKey = (v: unknown): v is QualityKey => KEYS.some(k => k === v);

let level: QualityLevel = DEFAULT_LEVEL;
let overrides: Partial<QualityFlags> = {};

/** Resolved flags, mutated in place — readers import once at module load. */
export const quality: QualityFlags = { ...PRESETS[DEFAULT_LEVEL] };

const listeners = new Set<(flags: QualityFlags) => void>();

/** Which stop the dial is on. */
export const qualityLevel = () => level;

/** The flags the current stop asks for, before any override. */
export const qualityPreset = (id: unknown = level): QualityFlags => ({ ...(isLevel(id) ? PRESETS[id] : PRESETS[DEFAULT_LEVEL]) });

/** Whether a flag has been pinned by hand rather than left to the dial. */
export const qualityOverridden = (key: string) => key in overrides;

/** Generic single-key write — avoids the union-key type collapse tsc would hit. */
function writeFlag<K extends QualityKey>(into: Partial<QualityFlags>, key: K, value: QualityFlags[K]) {
  into[key] = value;
}

function resolve() {
  const preset = isLevel(level) ? PRESETS[level] : PRESETS[DEFAULT_LEVEL];
  for (const key of KEYS) {
    // Non-null: cleanOverrides only writes type-checked values.
    writeFlag(quality, key, key in overrides ? overrides[key]! : preset[key]);
  }
}

function announce() {
  for (const fn of listeners) {
    try { fn(quality); } catch { /* a listener that throws is not the dial's problem */ }
  }
}

function persist() {
  // Even the default is written — "chose Full" and "never visited" must round-trip the same.
  writePref(PREF, JSON.stringify({ level, over: overrides }));
}

/** Read the saved setting. Called once, by ui/quality.ts, after boot. */
export function initQuality(stored: unknown = readPrefJSON(PREF)) {
  const saved: Record<string, unknown> = isRecord(stored) ? stored : {};
  // hasOwn guard — "__proto__" would resolve truthy via the prototype.
  level = isLevel(saved.level) ? saved.level : DEFAULT_LEVEL;
  overrides = cleanOverrides(saved.over);
  resolve();
  announce();
  return quality;
}

/** Sanitise overrides from localStorage — a string where a number belongs would
 *  silently break the BUILD_BUDGET comparison. */
function cleanOverrides(from: unknown): Partial<QualityFlags> {
  const out: Partial<QualityFlags> = {};
  if (!isRecord(from)) return out;
  for (const key of KEYS) {
    if (!(key in from)) continue;
    const value = from[key];
    const want = typeof PRESETS.full[key];
    if (typeof value !== want) continue;
    if (want === 'number' && !Number.isFinite(value)) continue;
    if (key === 'sharpness' && !SHARPNESS_STEPS.some(s => s.px === value)) continue;
    if (key === 'build' && !BUILD_STEPS.some(s => s.n === value)) continue;
    // SAFETY: typeof check above matches; tsc can't follow the computed type name.
    writeFlag(out, key, value as QualityFlags[typeof key]);
  }
  return out;
}

/** Move the dial. All overrides are dropped so the stop means what it says. */
export function setQualityLevel(id: unknown) {
  if (!isLevel(id) || id === level) return quality;
  level = id;
  overrides = {};
  resolve();
  persist();
  announce();
  return quality;
}

/** Pin one flag by hand. It outranks the dial until the dial moves again. */
export function setQualityOverride(key: string, value: unknown) {
  if (!isKey(key)) return quality;
  const clean = cleanOverrides({ [key]: value });
  if (!(key in clean)) return quality;
  if (quality[key] === clean[key] && key in overrides) return quality;
  // Non-null: `key in clean` just passed.
  writeFlag(overrides, key, clean[key]!);
  resolve();
  persist();
  announce();
  return quality;
}

/** Hand every flag back to the dial. */
export function clearQualityOverrides() {
  if (!Object.keys(overrides).length) return quality;
  overrides = {};
  resolve();
  persist();
  announce();
  return quality;
}

/** Called on every change, with the resolved flags. Returns an unsubscribe. */
export function onQuality(fn: (flags: QualityFlags) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
