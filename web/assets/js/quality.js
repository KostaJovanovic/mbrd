// How hard this device should work to draw a board.
//
// Everything else in mbrd that can be set is a property of the *board* and
// travels inside the .mbrd. This is not: how much a phone should spend on a
// picture it is about to shrink into a card is a fact about the phone, and
// shipping it inside someone else's moodboard would be telling their laptop to
// hold GIFs still because ours could not keep up. So it lives in localStorage
// beside the Desktop/Mobile choice, and `docs/mbrd-format.md` never hears about
// it.
//
// One dial with three stops, and Full is the default and is *exactly* what the
// app did before this file existed - every number in PRESETS.full is the
// constant it replaced. That is the property worth keeping: installing a new
// version must not quietly change what anyone's board looks like.
//
// Under the dial sit the same seven flags as overrides. Moving the dial rewrites
// all of them; setting one by hand pins that one and leaves the rest following.
// It is the same bargain the appearance panel makes with Whimsy and its token
// sliders, and it fails the same way without a way back - hence
// clearQualityOverrides().
//
// This module is the bottom of the graph: pure, no DOM, and the only thing it
// touches outside itself is localStorage through util.js, and only from
// functions. canvas/* imports `quality` and reads it; ui/quality.js is what
// writes. Deliberately *not* an event on state.js's bus: quality is not board
// state, and a subscriber list of three is not worth pretending otherwise.

import { readPrefJSON, writePref } from './util.js';

const PREF = 'mbrd.quality';

/** The stops, low to high. The index is what the slider in the panel moves. */
export const QUALITY_LEVELS = [
  { id: 'light', label: 'Light' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'full', label: 'Full' },
];

/**
 * The long edge a display copy keeps - see canvas/display.js. 1280 is the
 * number that module shipped with; the two below it are the same picture with
 * fewer megabytes of decode behind it.
 *
 * The floor is 1024 and not lower, which is a correction: this ladder started
 * at 1280/1024/800 on the reasoning that a card is a few hundred world units
 * wide and the pixels past that never reach the eye. That is true at zoom 1 and
 * false the moment anyone zooms in, which is what a board is for - at 800 a card
 * examined closely is a visible 2x upscale, and no memory ceiling is worth a
 * picture that looks broken. The saving lost is small: decode cost is the square
 * of the edge, so the three stops are 1 : 0.81 : 0.64 of Full, and Light still
 * takes a third of the picture memory off while its other four flags - shadows,
 * threads, blur, anim - do the work that actually saves an old phone.
 *
 * Multiples of 128 so the numbers read as a ladder rather than as three
 * measurements.
 */
export const SHARPNESS_STEPS = [
  { px: 1280, label: 'Crisp' },
  { px: 1152, label: 'Middle' },
  { px: 1024, label: 'Soft' },
];

/**
 * How many cards a single frame may build - see BUILD_BUDGET in
 * canvas/items.js. The one lever here that is a trade rather than a reduction:
 * a smaller batch means a smoother zoom and a board that fills in later.
 */
export const BUILD_STEPS = [
  { n: 12, label: '12 — fills in fastest' },
  { n: 8, label: '8' },
  { n: 4, label: '4 — smoothest' },
];

/**
 * What each stop asks for.
 *
 *   motion     GIFs animate. Off means they hold still whatever the zoom -
 *              which is also the only thing that reaches a Mobile board, where
 *              the fitted zoom never drops below canvas/stills.js's threshold.
 *   shadows    the twin in #item-shadows is built at all. Off is less DOM, not
 *              just less ink.
 *   blur       backdrop-filter, wherever it is used - the dialog's scrim and
 *              the transport button over a cover. The most expensive thing a
 *              phone GPU is asked for here, and the least missed.
 *   anim       transitions and eases. Off is the whole interface snapping.
 *   sharpness  the display copy's long edge, in pixels.
 *   build      cards built per frame.
 *
 * Balanced changes only things you cannot see standing still: softer pictures,
 * no panel blur, smaller batches. Light is where the board visibly gives
 * something up, and says so in the panel.
 *
 * There was a `threads` flag here as well, and it is worth saying why it went.
 * It existed because the web computed a maximal planar set over every card on
 * every drag frame, which is genuinely more than a tired phone should be asked
 * for. Connections are drawn from a stored list now (canvas/web.js): a handful
 * of pairs somebody drew by hand, and no graph to solve. So the flag stopped
 * paying for itself, and what it had become was a switch that silently hid work
 * the user had done - which is not a quality trade, it is a missing feature. The
 * board's own "Show connections" is the honest control, and it is in View.
 */
const PRESETS = {
  full: { motion: true, shadows: true, blur: true, anim: true, sharpness: 1280, build: 12 },
  balanced: { motion: true, shadows: true, blur: false, anim: true, sharpness: 1152, build: 8 },
  light: { motion: false, shadows: false, blur: false, anim: false, sharpness: 1024, build: 4 },
};

const DEFAULT_LEVEL = 'full';
const KEYS = Object.keys(PRESETS.full);

let level = DEFAULT_LEVEL;
let overrides = {};

/**
 * The resolved flags, as one object that is mutated in place rather than
 * replaced.
 *
 * In place, because every reader imports it once at module load - `if
 * (quality.shadows)` inside a build loop - and a reassigned binding would leave
 * all of them holding the object from boot. The same reason canvas/viewport.js
 * exports `mobilePerfFlags` this way.
 */
export const quality = { ...PRESETS[DEFAULT_LEVEL] };

const listeners = new Set();

/** Which stop the dial is on. */
export const qualityLevel = () => level;

/** The flags the current stop asks for, before any override. */
export const qualityPreset = (id = level) => ({ ...(Object.hasOwn(PRESETS, id) ? PRESETS[id] : PRESETS[DEFAULT_LEVEL]) });

/** Whether a flag has been pinned by hand rather than left to the dial. */
export const qualityOverridden = key => key in overrides;

function resolve() {
  const preset = Object.hasOwn(PRESETS, level) ? PRESETS[level] : PRESETS[DEFAULT_LEVEL];
  for (const key of KEYS) {
    quality[key] = key in overrides ? overrides[key] : preset[key];
  }
}

function announce() {
  for (const fn of listeners) {
    try { fn(quality); } catch { /* a listener that throws is not the dial's problem */ }
  }
}

function persist() {
  // The default state writes nothing worth keeping, but it is still written -
  // "I chose Full" and "I have never been here" have to be the same thing on
  // the next launch, and they are only the same thing if both round-trip.
  writePref(PREF, JSON.stringify({ level, over: overrides }));
}

/** Read the saved setting. Called once, by ui/quality.js, after boot. */
export function initQuality(stored = readPrefJSON(PREF)) {
  const saved = stored && typeof stored === 'object' ? stored : {};
  // Object.hasOwn, not a truthy PRESETS[saved.level]: localStorage is anyone's
  // to edit, and "__proto__"/"constructor" would resolve to a truthy prototype
  // member, pass the guard, and make every resolved flag undefined.
  level = Object.hasOwn(PRESETS, saved.level) ? saved.level : DEFAULT_LEVEL;
  overrides = cleanOverrides(saved.over);
  resolve();
  announce();
  return quality;
}

/**
 * Only the seven known keys, each held to the type its preset has.
 *
 * localStorage is same-origin storage anyone with a console can edit, and these
 * numbers reach a canvas size and a loop bound. A string where a number belongs
 * would not throw - it would quietly make `built >= BUILD_BUDGET` compare a
 * number against text and build every card on the board in one frame.
 */
function cleanOverrides(from) {
  const out = {};
  if (!from || typeof from !== 'object') return out;
  for (const key of KEYS) {
    if (!(key in from)) continue;
    const value = from[key];
    const want = typeof PRESETS.full[key];
    if (typeof value !== want) continue;
    if (want === 'number' && !Number.isFinite(value)) continue;
    if (key === 'sharpness' && !SHARPNESS_STEPS.some(s => s.px === value)) continue;
    if (key === 'build' && !BUILD_STEPS.some(s => s.n === value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Move the dial. Every override is dropped, because the alternative is a dial
 * that appears to do nothing: pinning "no shadows" and then reaching for Full
 * has to give you shadows back or the stop is a lie.
 */
export function setQualityLevel(id) {
  if (!Object.hasOwn(PRESETS, id) || id === level) return quality;
  level = id;
  overrides = {};
  resolve();
  persist();
  announce();
  return quality;
}

/** Pin one flag by hand. It outranks the dial until the dial moves again. */
export function setQualityOverride(key, value) {
  if (!KEYS.includes(key)) return quality;
  const clean = cleanOverrides({ [key]: value });
  if (!(key in clean)) return quality;
  if (quality[key] === clean[key] && key in overrides) return quality;
  overrides[key] = clean[key];
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
export function onQuality(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
