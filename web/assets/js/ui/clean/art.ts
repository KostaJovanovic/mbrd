// How the mess looks: a caked crust built as a height field and lit from it,
// debris drawn as SVG so each piece lifts on its own, and the cobweb as sagging
// strands round a triangle of three cards. One function - crustAt() - feeds both
// the occupancy grid in mess.ts and the paint here, so what is seen and what is
// counted cannot drift apart. Nothing here touches the DOM until it is called.

import type { MessKind, Rng, DebrisPlan } from './mess.ts';
import { rand, randInt } from './mess.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------
// Noise
//
// Three primitives, and the materials below are nothing but these composed.
// Value noise for the slow things (the rim, a warp). Gradient noise for surface,
// because value noise has its extremes on the lattice and lights up as a grid
// the moment a normal is taken from it. Cellular noise for anything that has
// *pieces* - plates of dried mud, cushions of moss, a bubble in tar - since no
// amount of fBm ever produces an edge.
// ---------------------------------------------------------------------------

function hashI(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

const hash = (x: number, y: number, seed: number) => hashI(x, y, seed) / 4294967296;

/** Value noise, smoothstepped so the lattice does not show as diamonds. */
function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

/** Octaves of it, each half the amplitude and twice the frequency. */
function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += vnoise(x, y, seed + i * 977) * amp;
    norm += amp;
    amp *= 0.5;
    x *= 2;
    y *= 2;
  }
  return sum / norm;
}

// Eight directions from a table rather than an angle through sin and cos: this
// is called a few hundred thousand times a card.
const GX = [1, 0.7071, 0, -0.7071, -1, -0.7071, 0, 0.7071];
const GY = [0, 0.7071, 1, 0.7071, 0, -0.7071, -1, -0.7071];

function corner(ix: number, iy: number, seed: number, fx: number, fy: number): number {
  const k = hashI(ix, iy, seed) & 7;
  return GX[k]! * fx + GY[k]! * fy;
}

/** Gradient noise, 0..1, quintic fade. */
function gnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = corner(xi, yi, seed, fx, fy);
  const b = corner(xi + 1, yi, seed, fx - 1, fy);
  const c = corner(xi, yi + 1, seed, fx, fy - 1);
  const d = corner(xi + 1, yi + 1, seed, fx - 1, fy - 1);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return 0.5 + (top + (bot - top) * v) * 0.7071;
}

function gfbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += gnoise(x, y, seed + i * 1013) * amp;
    norm += amp;
    amp *= 0.5;
    x *= 2.03;
    y *= 2.03;
  }
  return sum / norm;
}

// Cellular noise answers three things at once, and allocating an object for
// them per pixel would be most of this module's cost. Module scratch instead;
// read straight after the call.
let cellF1 = 0;
let cellF2 = 0;
let cellId = 0;

/** Distance to the nearest and second-nearest feature point, and a stable 0..1
 *  id for the nearest - which is what lets one plate of mud be paler than the
 *  one beside it. */
function cells(x: number, y: number, seed: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  let id = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      const h = hashI(cx, cy, seed);
      const px = cx + (h & 0xffff) / 65536 - x;
      const py = cy + (h >>> 16) / 65536 - y;
      const d = px * px + py * py;
      if (d < f1) { f2 = f1; f1 = d; id = h; } else if (d < f2) f2 = d;
    }
  cellF1 = Math.sqrt(f1);
  cellF2 = Math.sqrt(f2);
  cellId = ((Math.imul(id, 2654435761) >>> 0) / 4294967296);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (edge0: number, edge1: number, v: number) => {
  const t = clamp01((v - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// The crust's shape
//
// A layer over the whole card, edge to edge, shown at four fifths so the card
// is faintly there underneath: washing it off is a reveal, and the clean edge
// the jet leaves behind is the reward.
// ---------------------------------------------------------------------------

/** One card's worth of crust: a kind and the seed everything about it comes
 *  from. Small enough to keep beside the field it was counted into. */
export type Crust = { kind: MessKind, seed: number };

export const crust = (kind: MessKind, rng: Rng): Crust =>
  ({ kind, seed: Math.floor(rng() * 0x7fffffff) });

/** Thickness at which a cell counts as dirty, and at which the paint is at full
 *  opacity. One number for both, which is what keeps the mask and the picture
 *  the same shape. */
const CRUST_AT = 0.35;

/** Blobs in a spill, and how big each one is against the card. A spill is a few
 *  overlapping rounds - a cup set down three times - not one. */
const COFFEE_RINGS = 4;
const INK_BLOTS = 5;

/**
 * Where a point falls inside a spill of `n` blobs, as a signed distance from
 * its boundary: positive inside, and larger the deeper in.
 *
 * The blobs are rolled from the seed alone, so this is the same answer every
 * time it is asked - which is what lets `crustAt()` and the surfaces above read
 * it independently without ever disagreeing about where the spill is.
 */
function blotAt(seed: number, x: number, y: number, n: number, size: number) {
  let edge = -1;
  for (let i = 0; i < n; i++) {
    const cx = 0.5 + (hash(i, 1, seed) - 0.5) * 0.62;
    const cy = 0.5 + (hash(i, 2, seed) - 0.5) * 0.62;
    const r = size * (0.55 + hash(i, 3, seed) * 0.9);
    // Squashed a little, and each one differently: a cup leaves an ellipse
    // unless it was set down dead flat.
    const sx = 0.8 + hash(i, 4, seed) * 0.45;
    const dx = (x - cx) / (r * sx);
    const dy = (y - cy) / r;
    // The rim wanders, or every ring is a drawn circle.
    const wob = (gnoise(x * 6 + i * 3, y * 6, seed + i) - 0.5) * 0.22;
    edge = Math.max(edge, 1 - Math.hypot(dx, dy) + wob);
  }
  return { edge };
}

/** Kinds that are a spill on the card rather than a layer over the whole of it.
 *  A spill that is a rectangle is not a spill. */
const SPILLS: Record<string, { n: number, size: number }> = {
  coffee: { n: COFFEE_RINGS, size: 0.26 },
  ink: { n: INK_BLOTS, size: 0.2 },
};

/**
 * How thick the crust is at a point in 0..1 card space: 0 is bare card, 1 is
 * the full layer. The grid predicate and the paint both read this, which is the
 * one rule this module exists to keep.
 */
export function crustAt(c: Crust, x: number, y: number): number {
  if (x < 0 || x > 1 || y < 0 || y > 1) return 0;
  const spill = SPILLS[c.kind];
  // Edge to edge for the caked grimes. It used to stop at an irregular rim with
  // a few bare bites taken out of it, and at four fifths opacity that rim read
  // as the crust having been put on crooked rather than as the crust having an
  // edge. The card's own rounded corners are the only outline those have now.
  if (!spill) return 1;
  // A spill has a shape, and this is the same shape its surface paints.
  return clamp01(blotAt(c.seed, x, y, spill.n, spill.size).edge * 6);
}

/** The predicate mess.ts fills its occupancy grid from. */
export const crustMask = (c: Crust) => (x: number, y: number) => crustAt(c, x, y) >= CRUST_AT;

// ---------------------------------------------------------------------------
// The crust's surface
//
// Each material answers one question per pixel - how high is the surface here,
// and what colour is it before any light falls on it - and the lighting is done
// once, afterwards, from the heights. That split is the redesign: the first
// version shaded each material by hand from a single diagonal difference, and
// every one of them came out as the same soft smear in a different colour.
// A real normal from a real height field is what makes mud a relief of plates,
// moss a bed of cushions, and tar a wet skin.
// ---------------------------------------------------------------------------

/** What a material says about one point. Module scratch, like the cell noise. */
let sH = 0;
let sR = 0;
let sG = 0;
let sB = 0;
/** Extra shine at this point, 0..1, scaled by the material's gloss. */
let sWet = 1;

type Surface = (seed: number, x: number, y: number, rich: boolean) => void;

type Material = {
  surface: Surface,
  /** Height of the surface detail, as a share of the card's long side. */
  relief: number,
  /** Specular strength and tightness. */
  gloss: number,
  shine: number,
  /** What a fleck thrown off it looks like. */
  fleck: string,
  /** The colour water carrying this grime away is, as channels rather than a
   *  string, because the runoff needs it at several alphas per drop. Darker and
   *  a shade cooler than the fleck: it is the grime *in* water, not the grime. */
  wash: readonly [number, number, number],
};

/**
 * Dried, cracked mud. Plates from cellular noise: the gap between the nearest
 * and second-nearest point is small exactly along the borders between cells,
 * so thresholding it gives a crack network that closes into polygons, the way
 * real mud does and a noise contour never will. Plates dish slightly - higher
 * at the rim than the middle - because they curl as they dry.
 */
const mud: Surface = (seed, x, y, rich) => {
  const wx = x + (gnoise(x * 5, y * 5, seed + 11) - 0.5) * 0.09;
  const wy = y + (gnoise(x * 5 + 9, y * 5 + 3, seed + 12) - 0.5) * 0.09;
  cells(wx * 6.5, wy * 6.5, seed + 3);
  const edge = cellF2 - cellF1;
  const id = cellId;
  const plate = smooth(0.01, 0.12, edge);
  const curl = smooth(0.5, 0.08, edge) * 0.22;
  let hair = 0;
  if (rich) {
    // Hairlines across the plate tops: a finer network, shallow, and only where
    // the big cracks are not already.
    cells(wx * 17, wy * 17, seed + 5);
    hair = (1 - smooth(0.0, 0.05, cellF2 - cellF1)) * plate;
  }
  const grain = gfbm(x * 46, y * 46, seed + 21, rich ? 3 : 2);
  const lump = gfbm(x * 7, y * 7, seed + 22, 2);
  sH = plate * (0.62 + curl) + lump * 0.3 + grain * 0.10 - hair * 0.10;

  // Pale and dusty on top, darker where it is still damp, nearly black down the
  // cracks. Each plate a slightly different tan.
  const damp = smooth(0.45, 0.75, gfbm(x * 2.4 + 5, y * 2.4, seed + 23, 2));
  const tint = 0.88 + id * 0.24;
  let r = mix(176, 116, damp) * tint;
  let g = mix(142, 86, damp) * tint;
  let b = mix(102, 58, damp) * tint;
  const dust = (grain - 0.5) * 34;
  r += dust; g += dust * 0.9; b += dust * 0.75;
  const pit = 1 - plate * 0.78 - hair * 0.3;
  const k = 1 - clamp01(pit) * 0.80;
  sR = r * k; sG = g * k; sB = b * k;
  sWet = 0;
};

/**
 * Rust. Scale, not smear: small flakes lifting at their edges over a pitted
 * ground, in the three colours rust actually is - a dark brown where it is old
 * and deep, the orange everybody means by the word, and a pale ochre bloom
 * where it is new. It took the place of moss, which was a green the rest of
 * this app has no word for; every colour here is a neighbour of the palette's
 * own terracotta and sienna.
 */
const rust: Surface = (seed, x, y, rich) => {
  const wx = x + (gnoise(x * 4, y * 4, seed + 31) - 0.5) * 0.10;
  const wy = y + (gnoise(x * 4 + 7, y * 4 + 13, seed + 32) - 0.5) * 0.10;
  cells(wx * 13, wy * 13, seed + 33);
  const flake = smooth(0.0, 0.2, cellF2 - cellF1);
  const id = cellId;
  // Pits: about one cell in four has rusted through to something darker.
  cells(wx * 9, wy * 9, seed + 34);
  const pit = cellId > 0.74 ? smooth(0.34, 0.06, cellF1) : 0;
  const grit = rich ? gfbm(x * 60, y * 60, seed + 35, 2) : gnoise(x * 60, y * 60, seed + 35);
  const swell = gfbm(x * 5, y * 5, seed + 36, 2);
  // The flakes are relief only, and slight. Drawn into the colour as well they
  // made a second cracked-mud, which is the one thing this must not be.
  sH = flake * (0.10 + id * 0.12) + swell * 0.6 + grit * 0.22 - pit * 0.5;

  // Old -> orange -> bloom, along a slow field, so a card has regions of each,
  // and run downwards in streaks, because rust is carried by water.
  const run = gfbm(x * 15, y * 2.2, seed + 38, 2);
  const age = gfbm(x * 3.2 + 9, y * 3.2, seed + 37, 3) * 0.7 + run * 0.3;
  const t = clamp01((age - 0.34) * 3 + (grit - 0.5) * 0.7);
  let r = t < 0.5 ? mix(84, 176, t * 2) : mix(176, 214, (t - 0.5) * 2);
  let g = t < 0.5 ? mix(42, 84, t * 2) : mix(84, 138, (t - 0.5) * 2);
  let b = t < 0.5 ? mix(24, 30, t * 2) : mix(30, 58, (t - 0.5) * 2);
  const tint = 0.86 + id * 0.26;
  r *= tint; g *= tint; b *= tint;
  // Down the seams between flakes, and in the pits, it is nearly black.
  const k = 1 - (1 - flake) * 0.14 - pit * 0.65;
  sR = r * k; sG = g * k; sB = b * k;
  sWet = 0;
};

/**
 * Tar. A slow, smooth skin with a few blisters in it and slack wrinkles where
 * it has sagged, almost black - and everything that makes it tar is in the
 * light: a tight white highlight and a broad cold reflection of a sky that is
 * not there. The albedo barely matters.
 */
const tar: Surface = (seed, x, y, rich) => {
  const wx = x + (gnoise(x * 2.2, y * 2.2, seed + 51) - 0.5) * 0.3;
  const wy = y + (gnoise(x * 2.2 + 5, y * 2.2 + 11, seed + 52) - 0.5) * 0.3;
  const flow = gfbm(wx * 3.1, wy * 3.1, seed + 53, rich ? 3 : 2);
  // Wrinkles run across the fall line, and only in patches.
  const where = smooth(0.5, 0.72, gnoise(x * 2.6 + 3, y * 2.6, seed + 54));
  // Value noise, not gradient: gradient noise is exactly 0.5 along every
  // lattice line, and a ridge taken from it draws the lattice.
  const ridge = 1 - Math.abs(2 * fbm(wx * 3.5, wy * 17, seed + 55, 2) - 1);
  // Blisters: a dome around about one feature point in five.
  cells(x * 8, y * 8, seed + 56);
  const blister = cellId > 0.8 ? smooth(0.2, 0.0, cellF1) : 0;
  sH = flow * 2.4 + ridge * ridge * where * 0.2 + blister * 0.3;

  // The app's own ink, which is a warm brown-black and not a blue one. A cold
  // black is the one colour on this board that would have come from elsewhere.
  const v = gnoise(x * 30, y * 30, seed + 57);
  sR = 30 + flow * 16 + v * 5;
  sG = 23 + flow * 12 + v * 4;
  sB = 16 + flow * 9 + v * 3;
  sWet = 1;
};

/**
 * Coffee. Barely a surface at all: a stain is *in* the paper, not on it, so the
 * relief is almost nothing and everything that makes it read is the tide line.
 *
 * Coffee dries darkest at its edge - the liquid creeps outward and the solids
 * are carried with it and left there. So the darkness here is a function of
 * distance from the spill's own boundary rather than of any noise, which is
 * also what puts a ring under every overlapping ring. The middle is deliberately
 * see-through: the one grime you can read the card through.
 */
const coffee: Surface = (seed, x, y, rich) => {
  // The same blobs crustAt() masked, read from the same place - a second copy
  // of these numbers is the mask and the paint drifting apart.
  const b = blotAt(seed, x, y, SPILLS.coffee!.n, SPILLS.coffee!.size);
  // How near this point is to the edge of whatever ring it is inside.
  const tide = smooth(0.22, 0.02, b.edge) * 0.8 + smooth(0.6, 0.3, b.edge) * 0.2;
  const grain = rich ? gfbm(x * 40, y * 40, seed + 71, 2) : gnoise(x * 40, y * 40, seed + 71);
  sH = tide * 0.5 + grain * 0.1;
  // Sepia, and light in the middle: 0.35 alpha of stain over a pale card is
  // what a coffee ring is, and a solid brown rectangle is what it is not.
  const dark = 0.3 + tide * 0.7;
  sR = mix(206, 128, dark) + grain * 8;
  sG = mix(176, 88, dark) + grain * 6;
  sB = mix(138, 58, dark) + grain * 4;
  sWet = 0.2;
};

/**
 * Ink. Blots with dense centres and capillary edges - the feathering where it
 * has wicked along the paper's fibres, which is the only thing that tells ink
 * from paint. Warm near-black, the app's own ink rather than a blue-black.
 */
const ink: Surface = (seed, x, y, rich) => {
  const b = blotAt(seed, x, y, SPILLS.ink!.n, SPILLS.ink!.size);
  // Fibres: the boundary is pushed in and out at high frequency, so the edge
  // frays instead of cutting.
  const fray = (gfbm(x * 34, y * 34, seed + 81, rich ? 3 : 2) - 0.5) * 0.09;
  const body = smooth(0.0, 0.16, b.edge + fray);
  sH = body * 0.7 + (rich ? gfbm(x * 25, y * 25, seed + 82, 2) * 0.12 : 0);
  const v = gnoise(x * 28, y * 28, seed + 83);
  sR = 34 + (1 - body) * 26 + v * 5;
  sG = 26 + (1 - body) * 20 + v * 4;
  sB = 19 + (1 - body) * 15 + v * 3;
  sWet = 0.35;
};

/**
 * A settled dust film. Flat, matte, fine and even - the whole of it is the
 * grain and the streaks somebody's fingers left wiping through it, which are
 * what say "dust" rather than "grey card".
 */
const film: Surface = (seed, x, y, rich) => {
  const grain = rich ? gfbm(x * 70, y * 70, seed + 91, 2) : gnoise(x * 70, y * 70, seed + 91);
  // Streaks: a few slow bands, warped, where the film is thinner.
  const wy = y + (gnoise(x * 1.7, y * 1.7, seed + 92) - 0.5) * 0.5;
  const band = 1 - Math.abs(2 * fbm(x * 1.3, wy * 7, seed + 93, 2) - 1);
  const wipe = smooth(0.62, 0.95, band) * 0.75;
  sH = grain * 0.22 + (1 - wipe) * 0.12;
  // Warm grey: the dust in this room is off a paper board, not off a road.
  const k = 1 - wipe * 0.55;
  sR = (176 + grain * 22) * k;
  sG = (168 + grain * 20) * k;
  sB = (154 + grain * 18) * k;
  sWet = 0;
};

const MATERIAL: Record<string, Material> = {
  mud: { surface: mud, relief: 0.016, gloss: 0, shine: 1, fleck: 'rgb(132 100 66)', wash: [96, 72, 46] },
  rust: { surface: rust, relief: 0.018, gloss: 0, shine: 1, fleck: 'rgb(150 74 30)', wash: [108, 54, 24] },
  tar: { surface: tar, relief: 0.020, gloss: 0.8, shine: 60, fleck: 'rgb(44 34 25)', wash: [34, 26, 19] },
  coffee: { surface: coffee, relief: 0.004, gloss: 0.1, shine: 12, fleck: 'rgb(150 108 70)', wash: [120, 86, 54] },
  ink: { surface: ink, relief: 0.006, gloss: 0.25, shine: 26, fleck: 'rgb(48 38 28)', wash: [38, 30, 22] },
  film: { surface: film, relief: 0.008, gloss: 0, shine: 1, fleck: 'rgb(178 170 156)', wash: [134 , 128, 116] },
};

const materialOf = (kind: MessKind) => MATERIAL[kind] ?? MATERIAL.mud!;

/** The colour a fleck thrown off this grime should be, for the jet's particles. */
export const fleckColour = (kind: MessKind): string => materialOf(kind).fleck;

/**
 * Water, before anything is in it.
 *
 * Cool, and deliberately so. The look rule this file's crust follows - warm
 * colours, lit from the upper left, no outlines - is about **what lies on the
 * board**: mud, rust, tar, leaves, webs. The "never a blue" half of it is about
 * the app's own furniture, the tools and the bar and the text. Water is neither.
 * It came out of a tank, it is the one cold thing in the mode, and a warm spray
 * reads as light rather than as water.
 */
const WATER: readonly [number, number, number] = [206, 232, 246];

/** Water as a mote's three stops want it. */
export const waterInk = (): readonly [number, number, number] => WATER;

/**
 * The colour water carrying this grime away is: the grime's own wash, pulled
 * part of the way back toward water.
 *
 * All the way to the grime and a rivulet is a trail of mud, which is what it
 * looked like. All the way to water and nothing is being carried off at all, so
 * the whole point of it goes. `dirt` is how much of the grime is still in it -
 * 1 where it lifts off the card, less as it runs.
 */
export function washOf(kind: MessKind, dirt = 1): readonly [number, number, number] {
  const w = materialOf(kind).wash;
  const k = clamp01(dirt);
  return [
    Math.round(mix(WATER[0], w[0], k)),
    Math.round(mix(WATER[1], w[1], k)),
    Math.round(mix(WATER[2], w[2], k)),
  ];
}

/** Longest side of the buffer a crust is generated into, before it is drawn up.
 *  Plates and cushions have edges, and an edge drawn up more than about twice
 *  goes soft - which is the look this replaced. The cost is per pixel and the
 *  painting is queued a card a frame, so this is a frame budget and not an
 *  opening freeze. */
const NOISE_MAX = 232;
const NOISE_LIGHT = 150;

// The light in this mode comes from up and left, and a little towards the eye.
const LX = -0.46;
const LY = -0.60;
const LZ = 0.655;
// Halfway between the light and the eye, for the highlight.
const HX = -0.253;
const HY = -0.330;
const HZ = 0.910;

/**
 * Paint a card's crust onto its canvas.
 *
 * `rich` is the quality dial: at Light the buffer is smaller and the materials
 * drop their finest layer. The lighting stays - without it a crust is a stain,
 * and a stain is the thing this replaced.
 */
export function paintField(
  ctx: CanvasRenderingContext2D, c: Crust, w: number, h: number, rich = true,
) {
  if (w <= 0 || h <= 0) return;
  const scale = Math.min(1, (rich ? NOISE_MAX : NOISE_LIGHT) / Math.max(w, h));
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  ctx.drawImage(tile(c, nw, nh, rich), 0, 0, w, h);
}

/** The generated crust, in its own small buffer. Two passes: heights and
 *  colour, then light from the heights. */
function tile(c: Crust, w: number, h: number, rich: boolean): HTMLCanvasElement {
  const m = materialOf(c.kind);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const into = out.getContext('2d');
  if (!into) return out;
  const img = into.createImageData(w, h);
  const px = img.data;

  const n = w * h;
  const thick = new Float32Array(n);
  const high = new Float32Array(n);
  const wet = new Float32Array(n);
  const col = new Float32Array(n * 3);
  // The materials are sampled in a space where the card's long side is 1, so a
  // plate of mud is as wide as it is tall on a card that is not square.
  const long = Math.max(w, h);
  const ax = w / long;
  const ay = h / long;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const t = crustAt(c, u, v);
      if (t <= 0.02) continue;
      const i = y * w + x;
      thick[i] = t;
      m.surface(c.seed, u * ax, v * ay, rich);
      high[i] = sH * m.relief;
      wet[i] = sWet;
      col[i * 3] = sR;
      col[i * 3 + 1] = sG;
      col[i * 3 + 2] = sB;
    }
  }

  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : y;
    const y1 = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * 4;
      const a = smooth(0, CRUST_AT, thick[i]!);
      if (a <= 0) continue;

      const x0 = x > 0 ? x - 1 : x;
      const x1 = x < w - 1 ? x + 1 : x;
      // Slope per unit of the card's long side, which is what the heights are in.
      const dx = (high[y * w + x1]! - high[y * w + x0]!) * long / (x1 - x0 || 1);
      const dy = (high[y1 * w + x]! - high[y0 * w + x]!) * long / (y1 - y0 || 1);
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const nx = -dx * inv;
      const ny = -dy * inv;
      const nz = inv;

      // Flat ground reads as 1, so the albedo above is the colour in the open.
      const lit = Math.max(0, nx * LX + ny * LY + nz * LZ) / LZ;
      const k = 0.30 + 0.70 * lit;
      let r = col[i * 3]! * k;
      let g = col[i * 3 + 1]! * k;
      let b = col[i * 3 + 2]! * k;

      if (m.gloss) {
        const wetness = m.gloss * wet[i]!;
        const s = Math.pow(Math.max(0, nx * HX + ny * HY + nz * HZ), m.shine) * wetness;
        // The room that is not there: faces tilted up the screen pick up the
        // colour of the paper around them, broad and faint. It is most of what
        // reads as "wet", and being paper-coloured is what keeps it in this app.
        const sky = smooth(-0.05, 0.5, -ny) * wetness * 0.30;
        r += (196 - r) * sky + (250 - r) * s;
        g += (182 - g) * sky + (246 - g) * s;
        b += (160 - b) * sky + (236 - b) * s;
      }

      // Painted opaque. The four fifths it is seen at is the canvas's opacity in
      // clean.css, so the jet erases a solid layer and the look stays one number.
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = a * 255;
    }
  }
  into.putImageData(img, 0, 0);
  return out;
}

/**
 * Take a bite out of a painted crust.
 *
 * Three overlapping discs at slight offsets rather than one, so the hole has a
 * ragged edge. A single soft circle leaves a trail of perfect scallops, which
 * is the tell that something was stamped rather than washed.
 *
 * `crisp` is the last pass. The falloff is most of what makes a stroke feel
 * soft, and softness is right while the crust is being thinned - but the
 * clean/dirty boundary at the end has to be an edge, because a sharp reveal is
 * the whole of what this mode is paying off.
 */
export function eraseAt(
  ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number,
  strength: number, rng: Rng, crisp = false,
) {
  if (rx <= 0 || ry <= 0 || strength <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 3; i++) {
    const jx = x + (rng() - 0.5) * rx * 0.55;
    const jy = y + (rng() - 0.5) * ry * 0.55;
    const kx = rx * rand(rng, 0.6, 0.92);
    const ky = ry * rand(rng, 0.6, 0.92);
    const r = Math.max(kx, ky);
    const grad = ctx.createRadialGradient(jx, jy, 0, jx, jy, r);
    grad.addColorStop(0, `rgba(0,0,0,${strength})`);
    if (crisp) {
      // Crisper than the ordinary bite, not square. It used to hold full
      // strength to 82% of the radius and fall to nothing over the last 6%,
      // which is a disc with an edge on it - and since the caller turns this on
      // whenever the cell under the nozzle is on its last pass, that is most
      // stamps once an area has been swept a couple of times. The reveal wants
      // a defined edge, not a cut one.
      grad.addColorStop(0.55, `rgba(0,0,0,${strength})`);
      grad.addColorStop(0.86, `rgba(0,0,0,${strength * 0.55})`);
    } else {
      grad.addColorStop(0.35, `rgba(0,0,0,${strength * 0.82})`);
      grad.addColorStop(0.7, `rgba(0,0,0,${strength * 0.32})`);
    }
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(jx, jy, kx, ky, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Darken what the jet did not take yet, so a half-washed patch is visibly
 * thinned and wet rather than simply fainter. `source-atop` is the whole trick:
 * it paints only where there is already crust, so this never spills onto the
 * card that has just been uncovered beside it.
 */
export function wetAt(
  ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, amount: number,
) {
  if (rx <= 0 || ry <= 0 || amount <= 0) return;
  const r = Math.max(rx, ry);
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, `rgba(12,14,18,${amount})`);
  grad.addColorStop(0.6, `rgba(12,14,18,${amount * 0.5})`);
  grad.addColorStop(1, 'rgba(12,14,18,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** The sheen left on a patch the jet has just cleared. Drawn on the card's own
 *  wet overlay, not on the crust, so it fades on its own and counts for
 *  nothing. */
export function sheenAt(
  ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number,
) {
  const r = Math.max(rx, ry);
  const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
  // Cool. This is a film of water lying on the card, not a light falling on it,
  // and the one cold thing in the mode is the thing that came out of the tank.
  //
  // **Faint on purpose.** This is laid down once per pass of the jet, and a pass
  // is one interpolated step of a stroke - some six of them overlap any point
  // the nozzle crosses, and every one of them adds. At a third of an alpha each
  // that summed to flat white over the whole swept path within one sweep: not a
  // wet card, a sheet of paper laid on top of it. These are the numbers for one
  // stamp; what is seen is half a dozen of them.
  grad.addColorStop(0, 'rgba(226,240,248,0.075)');
  grad.addColorStop(0.65, 'rgba(210,228,240,0.035)');
  grad.addColorStop(1, 'rgba(210,228,240,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * The gleam on the front of the jet: the card under the crust, wet and catching
 * the light for the moment before it dries.
 *
 * A soft warm highlight offset toward the way the hand is going and then up and
 * left toward the light the whole board is lit by - never an outline. An arc
 * along the stamp's own ellipse is a drawing of this module's hit region, and a
 * stroke of them down a sweep is a set of contour lines; it was on screen for
 * one version and looked exactly like what it was.
 */
export function gleamAt(
  ctx: CanvasRenderingContext2D, x: number, y: number, r: number,
  dx: number, dy: number,
) {
  if (r <= 0) return;
  // Toward the travel, then a nudge up-left: the specular on a wet surface sits
  // between the eye and the light, and every other lit thing here is lit from
  // there.
  const cx = x + dx * r * 0.5 - r * 0.12;
  const cy = y + dy * r * 0.5 - r * 0.18;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.85);
  // A reflection off water, so it takes water's colour and not the room's. It
  // shares the sheen's canvas and the sheen's two-second fade, so it adds to
  // whatever is already there - a third of an alpha every sixtieth of a second
  // is a white patch under a hand that is working slowly.
  grad.addColorStop(0, 'rgba(242,251,255,0.18)');
  grad.addColorStop(0.45, 'rgba(222,240,250,0.07)');
  grad.addColorStop(1, 'rgba(222,240,250,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.85, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * One step of dirty water running off a card.
 *
 * Painted, not drawn: a soft round wash of the grime's own colour laid down
 * every frame at the head of the rivulet, so the trail is the overlap of a
 * hundred of them and has no edge anywhere. A rivulet as a stroked polyline is
 * a pen mark in mud colour, which is what it looked like.
 *
 * `head` adds the meniscus - the bead at the front of a run of water, which is
 * thicker than the trail and is the only part of it that catches any light.
 */
export function runAt(
  ctx: CanvasRenderingContext2D, x: number, y: number, r: number,
  kind: MessKind, head: boolean, alpha: number, dirt = 1,
) {
  if (r <= 0 || alpha <= 0) return;
  const [wr, wg, wb] = washOf(kind, dirt);
  const wash = ctx.createRadialGradient(x, y, 0, x, y, r);
  wash.addColorStop(0, `rgba(${wr},${wg},${wb},${(alpha * 0.55).toFixed(3)})`);
  wash.addColorStop(0.5, `rgba(${wr},${wg},${wb},${(alpha * 0.3).toFixed(3)})`);
  wash.addColorStop(1, `rgba(${wr},${wg},${wb},0)`);
  ctx.fillStyle = wash;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  if (!head) return;
  // The bead: a touch darker in the middle, and one small warm highlight up and
  // left of it. Two gradients and no line.
  const bead = ctx.createRadialGradient(x, y, 0, x, y, r * 0.7);
  bead.addColorStop(0, `rgba(${wr},${wg},${wb},${(alpha * 0.5).toFixed(3)})`);
  bead.addColorStop(1, `rgba(${wr},${wg},${wb},0)`);
  ctx.fillStyle = bead;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.7, 0, Math.PI * 2);
  ctx.fill();
  // The bead's highlight is the one part of a rivulet that is water and not
  // what is in it: cold, and up and left of the bead because that is where the
  // light is. A warm one here made the whole run read as mud with a shine on it.
  const lx = x - r * 0.3;
  const ly = y - r * 0.34;
  const lit = ctx.createRadialGradient(lx, ly, 0, lx, ly, r * 0.5);
  lit.addColorStop(0, `rgba(234,246,252,${(alpha * 0.55).toFixed(3)})`);
  lit.addColorStop(1, 'rgba(234,246,252,0)');
  ctx.fillStyle = lit;
  ctx.beginPath();
  ctx.arc(lx, ly, r * 0.5, 0, Math.PI * 2);
  ctx.fill();
}

// ---- debris --------------------------------------------------------------

const svg = <K extends keyof SVGElementTagNameMap>(tag: K) =>
  document.createElementNS(SVG_NS, tag);

function shape<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const node = svg(tag);
  for (const [k, v] of Object.entries(attrs))
    node.setAttribute(k, typeof v === 'number' ? v.toFixed(2) : v);
  return node;
}

const f2 = (v: number) => v.toFixed(2);

/** World pixels to one unit of a piece's own drawing. A leaf is about ten units
 *  long, so about fifty pixels of board - big enough to be a thing you pick up
 *  rather than a speck you hunt. */
export const BIT_UNIT = 5;

/**
 * One piece of debris, as two nested groups in its host's 0..100 box.
 *
 * The split is load-bearing. The outer group carries *where the piece is*, as a
 * CSS transform the stylesheet transitions - which is what makes a skid under
 * the jet and a tug on the gum eased motion rather than teleporting. The inner
 * carries how the piece is turned and how big it is, as an attribute, which
 * nothing animates. One group doing both means every animation fights the
 * placement.
 */
export function debrisNode(d: DebrisPlan, rng: Rng): SVGGElement {
  const g = svg('g');
  g.setAttribute('class', 'clean-bit clean-bit-' + d.kind);
  const inner = svg('g');
  inner.setAttribute('class', 'clean-bit-body');
  inner.dataset.turn = ((d.rot * 180) / Math.PI).toFixed(1);
  inner.dataset.size = d.size.toFixed(3);
  const art = d.kind === 'leaves' ? leaf(rng)
    : d.kind === 'gum' ? gum(rng)
      : d.kind === 'paper' ? paper(rng)
        : d.kind === 'cap' ? cap(rng)
          : d.kind === 'dust' ? dust(rng)
            : d.kind === 'tape' ? tape(rng)
              : d.kind === 'sticky' ? sticky(rng)
              : crumb(rng);
  // Lying on the crust, not printed into it. An offset dark copy rather than a
  // filter: a blur filter per node is a separate render surface each, and there
  // are up to ten of these on every card.
  inner.append(shadowOf(art, d.rot), art);
  g.append(inner);
  sizeBit(g, 1, 1);
  placeBit(g, d.x * 100, d.y * 100);
  return g;
}

/**
 * How big one unit of the piece's drawing is in its host's box, on each axis.
 *
 * A card's debris SVG is a 0..100 box stretched over the card whatever its
 * shape, so on a card that is not square a unit is wider than it is tall and an
 * uncorrected leaf comes out squashed. The host says how big its box really is
 * and this undoes it: `sizeBit(node, BIT_UNIT * 100 / w, BIT_UNIT * 100 / h)` on
 * a card, `sizeBit(node, BIT_UNIT, BIT_UNIT)` for a piece lying loose in a
 * 100-pixel host. Call it again whenever a piece changes host.
 */
export function sizeBit(node: SVGGElement, ux: number, uy: number) {
  const inner = node.firstElementChild;
  if (!(inner instanceof SVGGElement)) return;
  const size = Number(inner.dataset.size) || 1;
  // Scale outside the turn, so the stretch being undone is the host's and not
  // the piece's own.
  inner.setAttribute('transform',
    `scale(${(ux * size).toFixed(4)} ${(uy * size).toFixed(4)}) rotate(${inner.dataset.turn ?? '0'})`);
}

/** Where a piece sits, in its SVG's own units. Written as a CSS transform so
 *  clean.css can transition it. */
export function placeBit(node: SVGGElement, x: number, y: number) {
  node.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
}

/** A dark copy of a drawing, offset away from the light. Every fill and stroke
 *  is rewritten rather than inherited: the shapes below set their own, and a
 *  presentation attribute beats anything an ancestor says. The offset is turned
 *  back by the piece's own rotation, or every shadow would fall a different way. */
function shadowOf(art: SVGGElement, rot: number): SVGGElement {
  // SAFETY: cloneNode(true) on an SVGGElement returns an SVGGElement.
  const shade = art.cloneNode(true) as SVGGElement;
  const ox = 0.5;
  const oy = 0.75;
  const cos = Math.cos(-rot);
  const sin = Math.sin(-rot);
  // The class turns currentColor into the palette's ink (clean.css), so the
  // shadow is this board's shadow colour, the way --item-shadow is.
  shade.setAttribute('class', 'clean-bit-shade');
  shade.setAttribute('transform', `translate(${f2(ox * cos - oy * sin)} ${f2(ox * sin + oy * cos)})`);
  shade.setAttribute('opacity', '0.26');
  for (const node of shade.querySelectorAll('*')) {
    if (node.getAttribute('fill') !== 'none') node.setAttribute('fill', 'currentColor');
    // Only a stroke that was there: giving one to a shape that had none would
    // fatten the shadow by a whole default line width.
    const stroke = node.getAttribute('stroke');
    if (stroke && stroke !== 'none') node.setAttribute('stroke', 'currentColor');
    // Highlights are drawn faint; their shadow is not a highlight.
    node.removeAttribute('opacity');
  }
  return shade;
}

// The pieces are drawn the way the grime is: as the thing itself, lit from the
// upper left, in its own colours. They were flat sticker drawings for an
// afternoon, and a paper-and-ink leaf lying on a lit relief of cracked mud read
// as a label stuck to a photograph. The tools in the bar are the app's and are
// drawn in its line language; what is lying on the board is the mess, and all
// of the mess is one world. Every colour stays in the warm half of the wheel -
// browns, ochres, rusts, creams - which is the half this app's palette lives in.

/** A filled shape with no outline. */
const fill = (d: string, colour: string, opacity = 1) =>
  shape('path', { d, fill: colour, stroke: 'none', opacity });

/** A line. */
const line = (d: string, colour: string, width: number, opacity = 1) => shape('path', {
  d, fill: 'none', stroke: colour, 'stroke-width': width, opacity,
  'stroke-linecap': 'round', 'stroke-linejoin': 'round',
});

/** Lit half, shaded half, vein. Autumn, because a green leaf on the board would
 *  be the one cold thing on it. */
const LEAF_TINTS = [
  ['#d08a2e', '#a9641c', '#6f3d10'],
  ['#c4562a', '#9a3d1b', '#5f230e'],
  ['#d9aa3c', '#b38426', '#735214'],
  ['#9b5a2a', '#774019', '#47240c'],
  ['#b9742f', '#91541d', '#57300f'],
];

/**
 * A leaf, folded along its midrib: one half catches the light and the other
 * does not, which is the cheapest way there is to make a flat shape look like
 * it is lying on something. Pointed tip, asymmetric belly, veins that curve
 * towards the tip, a stem, a dry edge and one or two blemishes.
 */
function leaf(rng: Rng) {
  const g = svg('g');
  const [lit, dark, vein] = LEAF_TINTS[Math.floor(rng() * LEAF_TINTS.length)]!;
  const w = rand(rng, 2.6, 3.6);
  const l = rand(rng, 9, 12);
  const top = -l / 2;
  const bot = l / 2;
  const lean = rand(rng, -0.5, 0.5);
  const belly = rand(rng, 0.08, 0.22) * l;

  const half = (side: 1 | -1) =>
    `M0 ${f2(top)}`
      + ` C ${f2(side * w * 0.55)} ${f2(top + l * 0.12)},`
      + ` ${f2(side * w * (1.25 + side * lean * 0.2))} ${f2(top + l * 0.3 + belly)},`
      + ` ${f2(side * w * 0.72)} ${f2(bot - l * 0.22)}`
      + ` C ${f2(side * w * 0.4)} ${f2(bot - l * 0.06)}, ${f2(side * w * 0.12)} ${f2(bot - l * 0.01)}, 0 ${f2(bot)} Z`;
  g.append(fill(half(-1), lit!), fill(half(1), dark!));
  // The dry edge: the outline again, thin and dark, so the blade has a rim and
  // does not dissolve into mud of nearly its own colour.
  g.append(line(half(-1), vein!, 0.18, 0.7), line(half(1), vein!, 0.18, 0.7));

  let d = `M0 ${f2(top + l * 0.04)} L0 ${f2(bot)}`;
  for (let i = 0; i < 5; i++) {
    const y = top + l * (0.2 + i * 0.13);
    // Short of the outline everywhere: a vein that crosses the edge of the
    // blade turns the leaf into a feather.
    const reach = w * (0.66 - Math.abs(i - 1.4) * 0.14);
    for (const side of [-1, 1])
      d += ` M0 ${f2(y)} Q ${f2(side * reach * 0.5)} ${f2(y - l * 0.015)} ${f2(side * reach)} ${f2(y - l * 0.085)}`;
  }
  g.append(line(d, vein!, 0.22, 0.8));
  g.append(line(
    `M0 ${f2(bot - 0.2)} q ${f2(w * 0.12)} ${f2(l * 0.1)} ${f2(w * rand(rng, -0.3, 0.5))} ${f2(l * 0.2)}`,
    vein!, 0.42,
  ));
  // A highlight along the lit side of the rib, where the fold catches.
  g.append(line(`M${f2(-0.18)} ${f2(top + l * 0.12)} L${f2(-0.18)} ${f2(bot - l * 0.2)}`, '#fff2cf', 0.16, 0.45));
  const spots = randInt(rng, 1, 3);
  for (let i = 0; i < spots; i++)
    g.append(shape('circle', {
      cx: rand(rng, -w * 0.6, w * 0.6), cy: rand(rng, top + l * 0.3, bot - l * 0.3),
      r: rand(rng, 0.2, 0.5), fill: vein!, stroke: 'none', opacity: 0.5,
    }));
  return g;
}

/** A wobbled polygon, as path data. */
function lump(rng: Rng, cx: number, cy: number, r: number, sides: number, wobble: number): { x: number, y: number }[] {
  const pts: { x: number, y: number }[] = [];
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * Math.PI * 2 + rand(rng, -0.25, 0.25);
    const rr = r * rand(rng, 1 - wobble, 1 + wobble * 0.6);
    pts.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
  }
  return pts;
}

const poly = (pts: readonly { x: number, y: number }[]) =>
  'M' + pts.map(p => `${f2(p.x)} ${f2(p.y)}`).join(' L') + ' Z';

/** Crust, crumb, toasted edge. */
const CRUMB_TINTS = [
  ['#c89a5c', '#e6c48a', '#7a5226'], ['#a9773f', '#d2a468', '#5f3c18'],
  ['#8d5f30', '#b98a52', '#4a2d10'], ['#d9b67c', '#f0dcae', '#8a6434'],
];

/** A little spill of crumbs: one bigger angular bit and a scatter of small ones
 *  round it, each with a lit facet towards the light and a toasted rim.
 *  Ellipses read as printed dots; a crumb has corners, and a top. */
function crumb(rng: Rng) {
  const g = svg('g');
  const n = randInt(rng, 5, 8);
  for (let i = 0; i < n; i++) {
    const [crust, top, edge] = CRUMB_TINTS[Math.floor(rng() * CRUMB_TINTS.length)]!;
    const big = i === 0;
    const cx = big ? 0 : rand(rng, -3.6, 3.6);
    const cy = big ? 0 : rand(rng, -3.6, 3.6);
    const r = big ? rand(rng, 1.5, 2) : rand(rng, 0.3, 1.1);
    const pts = lump(rng, cx, cy, r, randInt(rng, 5, 7), 0.35);
    g.append(shape('path', { d: poly(pts), fill: crust!, stroke: edge!, 'stroke-width': 0.16, 'stroke-linejoin': 'round' }));
    // The facet: the same outline pulled in and pushed towards the light.
    const facet = pts.map(p => ({ x: cx + (p.x - cx) * 0.52 - r * 0.2, y: cy + (p.y - cy) * 0.52 - r * 0.24 }));
    g.append(fill(poly(facet), top!));
  }
  return g;
}

/** Closed smooth outline through the midpoints of a ring of points. */
function blob(pts: readonly { x: number, y: number }[]): string {
  const last = pts[pts.length - 1]!;
  let d = `M${f2((pts[0]!.x + last.x) / 2)} ${f2((pts[0]!.y + last.y) / 2)}`;
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i]!;
    const next = pts[(i + 1) % pts.length]!;
    d += ` Q${f2(cur.x)} ${f2(cur.y)} ${f2((cur.x + next.x) / 2)} ${f2((cur.y + next.y) / 2)}`;
  }
  return d + ' Z';
}

/** Wad, its shaded underside, the wet highlight. Dusty rose, cream and a
 *  faded coral: gum colours, kept off the cold side of the wheel. */
const GUM_TINTS = [
  ['#d98a9a', '#b0626f', '#f6cbd2'], ['#e9dfcc', '#bfb29a', '#fffaf0'], ['#e0997a', '#b56f52', '#f8d3c0'],
];

/** Chewed gum, trodden flat: a smear stuck to the surface, a thicker wad on top
 *  of it, a fold pressed in, and a wet highlight. The smear is what says it is
 *  *stuck* - without it this is a sweet somebody dropped. */
function gum(rng: Rng) {
  const g = svg('g');
  const [wad, under, lit] = GUM_TINTS[Math.floor(rng() * GUM_TINTS.length)]!;
  const r = rand(rng, 3, 3.8);
  const squash = rand(rng, 0.7, 0.88);
  const ring = (scale: number, wobble: number, ox = 0, oy = 0) => {
    const pts: { x: number, y: number }[] = [];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const rr = r * scale * rand(rng, 1 - wobble, 1 + wobble);
      pts.push({ x: ox + Math.cos(a) * rr, y: oy + Math.sin(a) * rr * squash });
    }
    return blob(pts);
  };
  g.append(fill(ring(1.22, 0.22), under!, 0.85));
  g.append(shape('path', { d: ring(0.92, 0.12, -0.1, -0.15), fill: wad!, stroke: under!, 'stroke-width': 0.25 }));
  // A fold pressed into it.
  g.append(line(
    `M${f2(-r * 0.45)} ${f2(r * 0.12)} q ${f2(r * 0.4)} ${f2(r * 0.3)} ${f2(r * 0.95)} ${f2(-r * 0.05)}`,
    under!, 0.35, 0.8,
  ));
  g.append(shape('ellipse', {
    cx: -r * 0.3, cy: -r * 0.34 * squash, rx: r * 0.3, ry: r * 0.14,
    fill: lit!, stroke: 'none', opacity: 0.85,
    transform: `rotate(-24 ${f2(-r * 0.3)} ${f2(-r * 0.34 * squash)})`,
  }));
  return g;
}

/**
 * A crumpled ball of paper: an irregular outline fanned into facets from a
 * point off its centre, each facet one of four warm whites by which way it
 * faces the light. One shaded wedge reads as a stone with a mark on it; every
 * wedge shaded by its own angle reads as crumpled, because that is what
 * crumpling is. The whites are the app's own paper tokens' values, so a ball of
 * paper on the board is a ball of *this* paper.
 */
function paper(rng: Rng) {
  const g = svg('g');
  const r = rand(rng, 3.6, 4.6);
  const sides = randInt(rng, 9, 11);
  const pts = lump(rng, 0, 0, r, sides, 0.22);
  const hub = { x: rand(rng, -r * 0.25, r * 0.25), y: rand(rng, -r * 0.25, r * 0.25) };
  // A second ring halfway in, so the facets are not all slices of one pie.
  const mid = pts.map(p => ({
    x: hub.x + (p.x - hub.x) * rand(rng, 0.42, 0.62),
    y: hub.y + (p.y - hub.y) * rand(rng, 0.42, 0.62),
  }));
  const tones = ['#fdfdfa', '#f1efe8', '#e0dccf', '#c6c0ae'];
  const tone = (ax: number, ay: number) => {
    // Facing the light (up-left) is bright; away from it, dim; jittered, since
    // a crease can face anywhere.
    const len = Math.hypot(ax, ay) || 1;
    const facing = (-(ax / len) * 0.6 - (ay / len) * 0.8 + 1) / 2 + rand(rng, -0.22, 0.22);
    return tones[Math.max(0, Math.min(3, Math.floor((1 - facing) * 4)))]!;
  };
  const facet = (d: string, colour: string) =>
    shape('path', { d, fill: colour, stroke: '#b6ae9a', 'stroke-width': 0.12, 'stroke-linejoin': 'round' });
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const a = pts[i]!; const b = pts[j]!;
    const ma = mid[i]!; const mb = mid[j]!;
    g.append(facet(poly([a, b, mb, ma]), tone((a.x + b.x) / 2 - hub.x, (a.y + b.y) / 2 - hub.y)));
    g.append(facet(poly([ma, mb, hub]),
      tone((ma.x + mb.x) / 2 - hub.x + rand(rng, -1, 1), (ma.y + mb.y) / 2 - hub.y + rand(rng, -1, 1))));
  }
  g.append(line(poly(pts), '#8f8672', 0.26));
  return g;
}

/**
 * A ball of dust, the kind that gathers under things: a few soft overlapping
 * clumps with no edge to speak of, a tangle of fine fibres looped through them,
 * and two or three hairs that have escaped. It has no outline on purpose - an
 * outline is exactly what dust does not have - so its shape is carried by the
 * clumps being denser in the middle, where more of them overlap.
 */
function dust(rng: Rng) {
  const g = svg('g');
  const r = rand(rng, 3, 4.2);
  const greys = ['#8d8478', '#a79e90', '#6f675c', '#b8b0a2'];
  const clumps = randInt(rng, 6, 8);
  for (let i = 0; i < clumps; i++) {
    const a = rng() * Math.PI * 2;
    const off = r * rand(rng, 0, 0.5);
    const pts = lump(rng, Math.cos(a) * off, Math.sin(a) * off * 0.8, r * rand(rng, 0.45, 0.75), 9, 0.3);
    g.append(fill(blob(pts), greys[i % greys.length]!, rand(rng, 0.32, 0.5)));
  }
  // Fibres: loose loops that start and end inside the ball.
  let d = '';
  for (let i = 0; i < 14; i++) {
    const a = rng() * Math.PI * 2;
    const b = a + rand(rng, 1.2, 2.6);
    const ra = r * rand(rng, 0.2, 0.9);
    const rb = r * rand(rng, 0.2, 0.9);
    const bend = r * rand(rng, 0.6, 1.3);
    const m = (a + b) / 2;
    d += ` M${f2(Math.cos(a) * ra)} ${f2(Math.sin(a) * ra * 0.8)}`
      + ` Q${f2(Math.cos(m) * bend)} ${f2(Math.sin(m) * bend * 0.8)} ${f2(Math.cos(b) * rb)} ${f2(Math.sin(b) * rb * 0.8)}`;
  }
  g.append(line(d.trim(), '#5c554b', 0.12, 0.7));
  // The hairs that got away.
  let hairs = '';
  for (let i = 0; i < 3; i++) {
    const a = rng() * Math.PI * 2;
    const len = r * rand(rng, 0.5, 0.9);
    hairs += ` M${f2(Math.cos(a) * r * 0.7)} ${f2(Math.sin(a) * r * 0.56)}`
      + ` q${f2(Math.cos(a + 0.9) * len * 0.6)} ${f2(Math.sin(a + 0.9) * len * 0.6)}`
      + ` ${f2(Math.cos(a) * len)} ${f2(Math.sin(a) * len)}`;
  }
  g.append(line(hairs.trim(), '#4a443c', 0.14, 0.75));
  return g;
}

/** Painted top, and the darker enamel of the skirt. Terracotta, amber, olive,
 *  ink and bare tin. */
const CAP_TINTS = [
  ['#b94900', '#7f2f00'], ['#e0a21c', '#a3700c'], ['#6f8c33', '#48601c'], ['#3d3128', '#1f1812'], ['#d8d4c8', '#9a958a'],
];

/** A bottle cap seen from above: a crimped skirt, a flat painted top inside it,
 *  a pressed ring, a highlight on the lit side and a shade on the other. The
 *  crimp is the whole identity - a plain circle at this size is a full stop. */
function cap(rng: Rng) {
  const g = svg('g');
  const [top, skirt] = CAP_TINTS[Math.floor(rng() * CAP_TINTS.length)]!;
  const r = rand(rng, 2.7, 3.2);
  const teeth = 21;
  let d = '';
  for (let i = 0; i < teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2;
    const rr = r * (i % 2 ? 0.9 : 1);
    d += `${i ? 'L' : 'M'}${f2(Math.cos(a) * rr)} ${f2(Math.sin(a) * rr)}`;
  }
  g.append(shape('path', { d: d + ' Z', fill: skirt!, stroke: '#1f1812', 'stroke-width': 0.18, 'stroke-linejoin': 'round' }));
  g.append(shape('circle', { r: r * 0.8, fill: top!, stroke: 'none' }));
  g.append(shape('circle', { r: r * 0.56, fill: 'none', stroke: skirt!, 'stroke-width': 0.26, opacity: 0.9 }));
  g.append(line(
    `M${f2(-r * 0.62)} ${f2(-r * 0.2)} A ${f2(r * 0.66)} ${f2(r * 0.66)} 0 0 1 ${f2(-r * 0.05)} ${f2(-r * 0.65)}`,
    '#fff6e0', 0.5, 0.6,
  ));
  g.append(line(
    `M${f2(r * 0.6)} ${f2(r * 0.25)} A ${f2(r * 0.66)} ${f2(r * 0.66)} 0 0 1 ${f2(r * 0.1)} ${f2(r * 0.64)}`,
    '#1f1812', 0.45, 0.25,
  ));
  return g;
}

/**
 * Everything that peels rather than lifting is drawn inside one of these, and
 * `peelAt()` is the only thing that ever writes to it.
 *
 * It is a group *inside* the piece's art rather than the art's own root, because
 * shadowOf() clones the art and renames the root - so a peel group one level
 * down is cloned intact and the shadow comes up off the card with the piece
 * above it, which is most of what makes a peel read as a peel.
 *
 * `far` is the end it stays stuck by, in the drawing's own units.
 */
function peelGroup(far: number): SVGGElement {
  const g = svg('g');
  g.setAttribute('class', 'clean-peel');
  g.dataset.far = far.toFixed(2);
  return g;
}

/** How much of its length a piece gives up over a full peel. Not all of it: a
 *  strip that scales to nothing is gone from the card before it ever reaches the
 *  hand, and what turns up in the glove a frame later reads as a second object
 *  rather than as the thing that was just peeled off. */
const PEEL_SHRINK = 0.55;

/** How far a piece has peeled, 0 (flat on the card) to 1 (off it). Written on
 *  the piece and on its shadow both - see peelGroup(). */
export function peelAt(node: SVGGElement, t: number) {
  const k = 1 - clamp01(t) * PEEL_SHRINK;
  for (const g of node.querySelectorAll<SVGGElement>('.clean-peel')) {
    const far = Number(g.dataset.far) || 0;
    g.setAttribute('transform',
      `translate(0 ${f2(far)}) scale(1 ${k.toFixed(3)}) translate(0 ${f2(-far)})`);
  }
}

/** Yellowed paper, its edge, and the back of the tape where it has lifted. */
const TAPE_TINTS = [
  ['#e9dcb4', '#cfbf91', '#f5eed6'],
  ['#e3d3a6', '#c6b384', '#f1e8cb'],
  ['#efe4c4', '#d5c79e', '#f8f2de'],
];

/**
 * A torn strip of masking tape, lying along its own `y` so the peel has a
 * length to run down.
 *
 * Both short ends are serrated, because tape is torn and not cut - a strip with
 * two straight ends is a rectangle, and a rectangle on a card is a label. The
 * lifted corner is the whole invitation: it says where to put the glove, and it
 * is the point the strip comes away from.
 */
function tape(rng: Rng) {
  const g = svg('g');
  const l = rand(rng, 9, 13);
  const w = rand(rng, 3, 3.8);
  const top = -l / 2;
  const bot = l / 2;
  const peel = peelGroup(bot);
  const [body, edge, back] = TAPE_TINTS[Math.floor(rng() * TAPE_TINTS.length)]!;
  const teeth = 5;
  let d = `M${f2(-w / 2)} ${f2(top)}`;
  for (let i = 1; i <= teeth; i++)
    d += ` L${f2(-w / 2 + (w * i) / teeth)} ${f2(top + (i % 2 ? 0.45 : 0))}`;
  d += ` L${f2(w / 2)} ${f2(bot)}`;
  for (let i = 1; i <= teeth; i++)
    d += ` L${f2(w / 2 - (w * i) / teeth)} ${f2(bot - (i % 2 ? 0.45 : 0))}`;
  d += ' Z';
  peel.append(shape('path', { d, fill: body!, stroke: edge!, 'stroke-width': 0.14 }));
  // The fibres in the crepe, which are what stop a flat fill reading as plastic.
  let fibres = '';
  for (let i = 0; i < 7; i++) {
    const x = rand(rng, -w * 0.42, w * 0.42);
    const from = rand(rng, top + 0.6, top + l * 0.4);
    fibres += ` M${f2(x)} ${f2(from)} L${f2(x + rand(rng, -0.25, 0.25))} ${f2(from + rand(rng, l * 0.2, l * 0.5))}`;
  }
  peel.append(line(fibres.trim(), edge!, 0.09, 0.55));
  // The lifted corner, and what it casts on the card. Drawn last, over the
  // strip, because it is folded back on top of it.
  const lift = rand(rng, 1.8, 2.6);
  const fold = `M${f2(-w / 2)} ${f2(top + lift)} L${f2(w * 0.18)} ${f2(top - 0.1)} L${f2(-w * 0.1)} ${f2(top + lift * 1.15)} Z`;
  peel.append(fill(fold, 'rgb(0 0 0 / 0.16)', 1));
  peel.append(shape('path', {
    d: `M${f2(-w / 2 + 0.25)} ${f2(top + lift - 0.2)} L${f2(w * 0.12)} ${f2(top + 0.1)} L${f2(-w * 0.14)} ${f2(top + lift * 0.95)} Z`,
    fill: back!, stroke: edge!, 'stroke-width': 0.12,
  }));
  g.append(peel);
  return g;
}

/**
 * A sticky note, curled off the card at its top edge - the one piece of the
 * mess allowed a palette token, because it is the app's own stationery and a
 * note on this board should be one of the four colours notes are.
 *
 * The token goes in as `var(--note-N)` on the fill attribute rather than through
 * a class: shadowOf() rewrites fills as attributes, and an attribute cannot
 * beat a class rule - the shadow would have come out the colour of the note.
 */
function sticky(rng: Rng) {
  const g = svg('g');
  const s = rand(rng, 6.4, 7.6);
  const half = s / 2;
  const peel = peelGroup(half);
  const tint = `var(--note-${1 + Math.floor(rng() * 4)})`;
  const curl = rand(rng, 1.1, 1.8);
  const lip = -half + curl;
  // The sheet, from under the curl down.
  peel.append(shape('path', {
    d: `M${f2(-half)} ${f2(lip)} L${f2(half)} ${f2(lip)} L${f2(half)} ${f2(half)} L${f2(-half)} ${f2(half)} Z`,
    fill: tint, stroke: 'rgb(0 0 0 / 0.16)', 'stroke-width': 0.12,
  }));
  // Two strokes of somebody's pen. A blank note is a coloured square.
  let pen = '';
  for (let i = 0; i < 2; i++) {
    const y = lip + (i + 1) * (s - curl) * 0.3;
    pen += ` M${f2(-half * 0.55)} ${f2(y)} Q${f2(rand(rng, -1, 1))} ${f2(y - 0.35)} ${f2(half * rand(rng, 0.2, 0.6))} ${f2(y)}`;
  }
  peel.append(line(pen.trim(), 'rgb(40 34 26 / 0.45)', 0.16));
  // What the lip throws onto the sheet below it, and then the lip: the back of
  // the paper, which is paler than its face.
  peel.append(fill(
    `M${f2(-half)} ${f2(lip)} Q0 ${f2(lip + curl * 0.9)} ${f2(half)} ${f2(lip)}`
    + ` L${f2(half)} ${f2(lip + 0.55)} Q0 ${f2(lip + curl * 0.9 + 0.55)} ${f2(-half)} ${f2(lip + 0.55)} Z`,
    'rgb(0 0 0 / 0.13)',
  ));
  peel.append(shape('path', {
    d: `M${f2(-half)} ${f2(-half)} Q0 ${f2(-half + 0.7)} ${f2(half)} ${f2(-half)}`
      + ` L${f2(half)} ${f2(lip)} Q0 ${f2(lip + curl * 0.9)} ${f2(-half)} ${f2(lip)} Z`,
    fill: tint, stroke: 'rgb(0 0 0 / 0.14)', 'stroke-width': 0.12,
  }));
  peel.append(fill(
    `M${f2(-half)} ${f2(-half)} Q0 ${f2(-half + 0.7)} ${f2(half)} ${f2(-half)}`
    + ` L${f2(half)} ${f2(lip)} Q0 ${f2(lip + curl * 0.9)} ${f2(-half)} ${f2(lip)} Z`,
    'rgb(255 253 246 / 0.45)',
  ));
  g.append(peel);
  return g;
}

// ---- boot prints ---------------------------------------------------------

/**
 * The print's occupancy grid, a side like every other field's.
 *
 * Square over a boot-shaped box, so a cell is tall and thin in world units -
 * which is exactly what a card's cells already are on any card that is not
 * square, and `stamp()` reads a field's side back off `cells.length`. A second
 * grid shape would be a second set of arithmetic for one mess.
 *
 * Coarse at twelve: a print is a fifth the size of a card and does not want a
 * card's worth of bookkeeping.
 */
export const BOOT_GRID = 12;

/**
 * How much mud a point in the print's own 0..1 box was given, 0 to 1.
 *
 * A forefoot and a heel, apart at the arch, which never touches. Each is a
 * **rim** round the outside - the band every walking boot has, and what gives a
 * print its outline - and inside it rows of **lugs**: blocks laid like brickwork,
 * bent into chevrons pointing at the toe on the forefoot and straight across on
 * the heel. The mud is where the lugs pressed, with a thin smear in the grooves
 * between them, because a muddy sole leaves a little everywhere.
 *
 * It was once a sole with three bars cut straight across it. Seen from above,
 * three full-width gaps are not tread, they are a barcode - and a flat fill of
 * the caked-mud surface inside made each strip a slab of tiles. Tread is a
 * pattern of small pieces; nothing in a real one runs edge to edge.
 */
export function bootAt(x: number, y: number): number {
  if (x < 0 || x > 1 || y < 0 || y > 1) return 0;
  // The arch.
  if (y > 0.56 && y < 0.64) return 0;
  // Round the toe and the heel, and pull the waist in.
  const cx = 0.5 + (y < 0.5 ? Math.sin(y * 6.0) * 0.03 : 0);
  // Half-width down the length: wide at the ball, narrow at the waist, medium
  // at the heel.
  const half = y < 0.10 ? 0.30 * Math.sqrt(Math.max(0, y / 0.10))
    : y < 0.34 ? 0.30
      : y < 0.52 ? 0.30 - ((y - 0.34) / 0.18) * 0.12
        : y < 0.62 ? 0.18
          : y < 0.70 ? 0.18 + ((y - 0.62) / 0.08) * 0.06
            : y < 0.94 ? 0.24
              : 0.24 * Math.sqrt(Math.max(0, (1 - y) / 0.06));
  const off = Math.abs(x - cx);
  if (off >= half) return 0;
  // Soft at the outline: a boot presses its edge in last and least.
  const edge = smooth(0, 0.035, half - off);
  // Across the sole, 0 in the middle and 1 at its edge.
  const u = off / Math.max(half, 1e-3);
  // The rim. Broken up and down the length by the ends of the lug rows, as it is
  // on a real sole, rather than drawn as one unbroken line.
  if (u > 0.76) return edge * (0.7 + 0.3 * smooth(0.2, 0.4, Math.abs(((y * 14) % 1) - 0.5) * 2));
  const heel = y >= 0.6;
  const pitch = heel ? 0.068 : 0.074;
  // Chevrons: a row sits further from the toe at the sides than in the middle.
  const r = (y - (heel ? 0.645 : 0.035) - (heel ? 0 : u * 0.05)) / pitch;
  const row = Math.floor(r);
  const fr = r - row;
  const cols = heel ? 2 : 3;
  const c = ((x - cx) / half * 0.5 + 0.5) * cols + (row % 2 ? 0.5 : 0);
  const fc = c - Math.floor(c);
  const lug = smooth(0.12, 0.26, fr) * smooth(0.12, 0.26, 1 - fr)
    * smooth(0.08, 0.2, fc) * smooth(0.08, 0.2, 1 - fc);
  return edge * (0.14 + 0.86 * lug);
}

/** The predicate a print's occupancy grid is filled from: the rim and the lugs,
 *  and not the smear in the grooves, which goes with them. */
export const bootMask = () => (x: number, y: number) => bootAt(x, y) > 0.4;

/**
 * Paint one print: mud pressed off a sole, which is flat and wet rather than
 * caked. A print is thin - it has not had time to dry and crack, and at a fifth
 * of a card's size the caked surface's plates came out bigger than the lugs. So
 * the mud's own colours, a fine grain, and the uneven pressure of a step: the
 * ball and the heel bite, and mud never comes off a sole evenly.
 */
export function paintBoot(
  ctx: CanvasRenderingContext2D, seed: number, w: number, h: number, rich: boolean,
) {
  const img = ctx.createImageData(w, h);
  const px = img.data;
  const [dr, dg, db] = materialOf('mud').wash;
  for (let iy = 0; iy < h; iy++)
    for (let ix = 0; ix < w; ix++) {
      const x = (ix + 0.5) / w;
      const y = (iy + 0.5) / h;
      const i = (iy * w + ix) * 4;
      const k = bootAt(x, y);
      if (k <= 0.01) { px[i + 3] = 0; continue; }
      // The box is twice as tall as it is wide, so y runs at twice the rate to
      // keep the noise round.
      const press = clamp01(0.62 + 0.55 * fbm(x * 5, y * 10, seed, 2));
      const grain = rich ? gfbm(x * 40, y * 80, seed + 7, 2) : gnoise(x * 40, y * 80, seed + 7);
      // Thicker mud is darker; the smear in the grooves is thin and light.
      const lift = (1 - k) * 34 + (grain - 0.5) * 22;
      px[i] = Math.max(0, Math.min(255, dr + lift));
      px[i + 1] = Math.max(0, Math.min(255, dg + lift * 0.8));
      px[i + 2] = Math.max(0, Math.min(255, db + lift * 0.6));
      px[i + 3] = Math.max(0, Math.min(255, 235 * clamp01(k * press * 1.15)));
    }
  ctx.putImageData(img, 0, 0);
}

// ---- cobwebs -------------------------------------------------------------

/** How far the lowest strand of a web of this span droops. Rolled once and kept
 *  on the web, so the hit line and the drawn line are the same line. */
export const webSag = (span: number, rng: Rng) => span * rand(rng, 0.16, 0.28);

/**
 * One side of a web's **frame**: the taut outer thread the radii are anchored
 * to, between two points in world space.
 *
 * Two strands, not four. A spider lays its frame thread and then doubles back
 * along it, so a frame reads as a line with a second one shadowing it - and
 * four parallel sags was not that, it was a hammock. It was right when a web
 * was a band slung between two cards and nothing else; now that the middle
 * carries the radii and the spiral, the sides have to be a frame or the whole
 * thing is texture with no structure. See `webCore()`.
 *
 * The lower strand, at `sag`, is the hit line and the one the radii land on.
 * Both ends are anchored to cards that cannot move, so the path is computed
 * once and never again. Deterministic from its ends: the jitter comes from a
 * hash of the anchors.
 */
export function webPath(ax: number, ay: number, bx: number, by: number, sag: number) {
  const seed = (Math.round(ax * 13 + ay * 7 + bx * 3 + by) | 0) + 1;
  let turn = 0;
  const roll = () => hash(turn++, 17, seed);
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const at = (t: number, drop: number) => {
    const k = 1 - t;
    return {
      x: k * k * ax + 2 * k * t * mx + t * t * bx,
      y: k * k * ay + 2 * k * t * (my + drop) + t * t * by,
    };
  };
  const f1 = (v: number) => v.toFixed(1);
  // The frame thread and the doubling-back, a little above it.
  const sags = [sag, sag * 0.88];
  let d = '';
  for (const s of sags)
    d += ` M${f1(ax)} ${f1(ay)} Q${f1(mx)} ${f1(my + s)} ${f1(bx)} ${f1(by)}`;

  // The short ties between the two frame threads, gathered towards whichever
  // end the roll picks and each one bellied a little towards the ground.
  const flip = roll() < 0.5;
  const threads = 7;
  for (let i = 1; i < threads; i++) {
    let t = (i / threads) ** 1.35;
    if (flip) t = 1 - t;
    t = Math.min(0.96, Math.max(0.04, t + (roll() - 0.5) * 0.03));
    for (let k = 0; k < sags.length - 1; k++) {
      // Not every thread survives, and fewer do far from the anchor.
      if (roll() < 0.18) continue;
      const p = at(t + (roll() - 0.5) * 0.02, sags[k]!);
      const q = at(t + (roll() - 0.5) * 0.02, sags[k + 1]!);
      const belly = Math.hypot(p.x - q.x, p.y - q.y) * 0.18;
      d += ` M${f1(p.x)} ${f1(p.y)} Q${f1((p.x + q.x) / 2 + belly * 0.6)} ${f1((p.y + q.y) / 2 + belly)} ${f1(q.x)} ${f1(q.y)}`;
    }
  }
  // Broken threads, hanging.
  const span = Math.hypot(bx - ax, by - ay);
  for (let i = 0; i < 3; i++) {
    const p = at(0.2 + roll() * 0.6, sags[0]!);
    const len = span * (0.05 + roll() * 0.08);
    d += ` M${f1(p.x)} ${f1(p.y)} q ${f1((roll() - 0.5) * len * 0.5)} ${f1(len * 0.6)} ${f1((roll() - 0.5) * len * 0.3)} ${f1(len)}`;
  }
  // Dust: zero-length segments, which a round line cap draws as dots.
  for (let i = 0; i < 6; i++) {
    const p = at(0.1 + roll() * 0.8, sags[Math.floor(roll() * sags.length)]!);
    d += ` M${f1(p.x)} ${f1(p.y)} l0.1 0`;
  }
  return d.trim();
}

/** A point on the quadratic from `a` to `b` whose middle is pulled down by
 *  `drop` - the one curve every thread in a web is made of. */
function bend(
  ax: number, ay: number, bx: number, by: number, drop: number, t: number,
) {
  const k = 1 - t;
  return {
    x: k * k * ax + 2 * k * t * ((ax + bx) / 2) + t * t * bx,
    y: k * k * ay + 2 * k * t * ((ay + by) / 2 + drop) + t * t * by,
  };
}

/** Radii in a web. Enough that the spiral between them reads as a curve and
 *  not as a polygon; few enough that the middle does not go solid at the size
 *  a card-sized web is drawn at. */
const RADII = 15;

/** Where the capture spiral starts and stops, as a share of the way from the
 *  hub to the frame. It stops short of both: a spider leaves the hub clear to
 *  sit in, and leaves a free zone inside the frame it can cross without
 *  treading on its own sticky silk. */
const SPIRAL_IN = 0.17;
const SPIRAL_OUT = 0.9;

/** Turns of the capture spiral, and of the tight scaffold at the hub. */
const SPIRAL_TURNS = 4;
const HUB_TURNS = 2;

/** One drawn side of the frame: where it leaves each card and how far it
 *  droops. The same numbers `webPath()` was given, so the middle is tied to the
 *  curve that is on screen. */
export type FrameSide = { ax: number, ay: number, bx: number, by: number, sag: number };

/**
 * The middle of a web: the radii and the capture spiral, spun inside a frame
 * of three sides.
 *
 * **This is how an orb web is actually built, and the shape that was wrong
 * before is instructive.** It had three spokes running to the triangle's three
 * corners and rings strung between them - so the only places the middle met
 * the outside were the three points where the frame threads already met each
 * other, and everything between was two separate drawings sharing a bounding
 * box. A real web has no such seam: the spider lays the frame, then runs
 * *many* radii from the hub out to the frame, landing all along it, and only
 * then walks the spiral outward across those radii. Every thread in the middle
 * is tied to a thread on the outside.
 *
 * So the radii here land at points *on the frame curves* - `sags` is taken for
 * exactly that reason, so a radius meets the sagging thread where it hangs and
 * not where a straight line between the corners would have been.
 *
 * The spiral is one continuous walk rather than a set of rings: from
 * `SPIRAL_IN` out to `SPIRAL_OUT`, crossing to the next radius each step and
 * gaining a little radius as it goes. Rings are what you draw when you have
 * not looked at a web; the give-away is that they close, and a capture spiral
 * never does. It stops short at both ends - the hub is left clear for the
 * spider to sit in, and a free zone is left inside the frame.
 *
 * Everything sags. A radius droops less than a free strand because it is under
 * tension; a spiral segment bellies away from the hub *and* downward, only the
 * second of which is gravity.
 *
 * Deterministic from the frame, like `webPath()` - the web is spun once and
 * never re-rolled. Returns the hub and the radii's landing points, because
 * clean.ts hangs the hit lines off them: a duster swept through the middle has
 * to meet something.
 */
export function webCore(
  sides: readonly FrameSide[],
): { d: string, hub: { x: number, y: number }, spokes: { x: number, y: number }[], drop: number[] } {
  const seed = (Math.round(
    sides[0]!.ax * 11 + sides[0]!.ay * 5 + sides[1]!.ax * 3 + sides[1]!.ay * 7
    + sides[2]!.ax * 2 + sides[2]!.ay,
  ) | 0) + 1;
  let turn = 0;
  const roll = () => hash(turn++, 23, seed);
  const f1 = (v: number) => v.toFixed(1);
  const sag = (sides[0]!.sag + sides[1]!.sag + sides[2]!.sag) / 3;

  // The middle of the frame, from all six of its ends rather than from three
  // corners - **a side's two ends are not the next side's**. Each strand
  // leaves a card at the point on its edge facing the *other card of that
  // pair*, so a card carries two anchors a little apart and the frame is three
  // arcs with small gaps at the cards, not a closed triangle. Reading it as one
  // put the hub off-centre and the radii off the thread they were supposed to
  // be tied to.
  let cx = 0;
  let cy = 0;
  for (const s of sides) { cx += s.ax + s.bx; cy += s.ay + s.by; }
  // The hub sits below that: the whole web hangs, and a hub at the exact middle
  // looks pinned there.
  const hub = {
    x: cx / 6 + (roll() - 0.5) * sag * 0.3,
    y: cy / 6 + sag * (0.28 + roll() * 0.22),
  };

  /** A point on the frame, at `u` in 0..3 around the three sides - on the
   *  sagging curve `webPath()` actually drew, which is what a radius is tied
   *  to. */
  const onFrame = (u: number) => {
    const side = sides[Math.min(2, Math.floor(u))]!;
    return bend(side.ax, side.ay, side.bx, side.by, side.sag, u - Math.min(2, Math.floor(u)));
  };

  // The radii, landing all the way round the frame rather than at its corners.
  // Spaced by frame parameter and not by angle: the spider walks the frame, and
  // an even fan of angles would bunch the landings wherever a side runs close
  // to the hub.
  const spokes: { x: number, y: number }[] = [];
  const drop: number[] = [];
  for (let i = 0; i < RADII; i++) {
    const u = ((i + (roll() - 0.5) * 0.6) / RADII) * 3;
    spokes.push(onFrame(Math.min(2.999, Math.max(0, u))));
    drop.push(sag * (0.06 + roll() * 0.08));
  }

  /** A point `t` of the way out along radius `i`. */
  const along = (i: number, t: number) => {
    const s = spokes[i]!;
    return bend(hub.x, hub.y, s.x, s.y, drop[i]!, t);
  };

  let d = '';
  for (let i = 0; i < RADII; i++) {
    const s = spokes[i]!;
    d += ` M${f1(hub.x)} ${f1(hub.y)} Q${f1((hub.x + s.x) / 2)} ${f1((hub.y + s.y) / 2 + drop[i]!)} ${f1(s.x)} ${f1(s.y)}`;
  }

  // The capture spiral: one walk outward, a step per radius. Never closes.
  const steps = RADII * SPIRAL_TURNS;
  for (let k = 0; k < steps; k++) {
    // Not every segment survives. A web with no gaps in it has never caught
    // anything, and this one has been hanging in a room nobody dusts.
    if (roll() < 0.1) continue;
    const t0 = SPIRAL_IN + ((SPIRAL_OUT - SPIRAL_IN) * k) / steps;
    const t1 = SPIRAL_IN + ((SPIRAL_OUT - SPIRAL_IN) * (k + 1)) / steps;
    const p = along(k % RADII, t0 + (roll() - 0.5) * 0.02);
    const q = along((k + 1) % RADII, t1 + (roll() - 0.5) * 0.02);
    // Away from the hub as well as down: a thread pulled between two radii
    // bows outward, and only the downward half of that is gravity.
    const mx = (p.x + q.x) / 2;
    const my = (p.y + q.y) / 2;
    const out = Math.hypot(mx - hub.x, my - hub.y) || 1;
    const belly = Math.hypot(q.x - p.x, q.y - p.y) * (0.08 + roll() * 0.06);
    d += ` M${f1(p.x)} ${f1(p.y)} Q${f1(mx + ((mx - hub.x) / out) * belly)} ${f1(my + ((my - hub.y) / out) * belly + belly * 0.5)} ${f1(q.x)} ${f1(q.y)}`;
  }

  // The scaffold at the hub: a couple of tight turns holding the radii
  // together where they converge, which is the densest part of a real web.
  for (let k = 0; k < RADII * HUB_TURNS; k++) {
    const t = 0.05 + (0.1 * k) / (RADII * HUB_TURNS);
    const p = along(k % RADII, t);
    const q = along((k + 1) % RADII, t);
    d += ` M${f1(p.x)} ${f1(p.y)} L${f1(q.x)} ${f1(q.y)}`;
  }

  // A broken thread or two hanging loose, and dust caught on the spiral.
  const reach = Math.hypot(spokes[0]!.x - hub.x, spokes[0]!.y - hub.y);
  for (let i = 0; i < 2; i++) {
    const p = along(Math.floor(roll() * RADII), 0.3 + roll() * 0.5);
    const len = reach * (0.07 + roll() * 0.12);
    d += ` M${f1(p.x)} ${f1(p.y)} q ${f1((roll() - 0.5) * len * 0.6)} ${f1(len * 0.6)} ${f1((roll() - 0.5) * len * 0.4)} ${f1(len)}`;
  }
  for (let i = 0; i < 5; i++) {
    const p = along(Math.floor(roll() * RADII), SPIRAL_IN + roll() * (SPIRAL_OUT - SPIRAL_IN));
    d += ` M${f1(p.x)} ${f1(p.y)} l0.1 0`;
  }
  return { d: d.trim(), hub, spokes, drop };
}

export function webNode(d: string): SVGPathElement {
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('class', 'clean-web');
  p.setAttribute('d', d);
  return p;
}

// ---- the spider ----------------------------------------------------------

/** How wide the spider is, legs included, in world pixels. Its host's viewBox is
 *  this box exactly, centred on nothing - so a unit of the drawing below is a
 *  world pixel and the numbers in it are the size on the board. */
export const SPIDER_SIZE = 14;

/**
 * The one spider, drawn head-up: `-y` is the way it faces, so clean.ts turns it
 * with a single rotation off its heading.
 *
 * Eight legs in two interleaved groups rather than a left set and a right one.
 * A spider walks its first and third leg on one side with its second and fourth
 * on the other, and the two groups here are exactly those two teams - which is
 * why alternating them reads as walking and alternating sides reads as rowing.
 * The shuffle itself is clean.css's, one animation per group half a cycle apart.
 */
export function spiderNode(rng: Rng): SVGSVGElement {
  const host = svg('svg');
  host.setAttribute('class', 'clean-spider');
  const half = SPIDER_SIZE / 2;
  host.setAttribute('viewBox', `${-half} ${-half} ${SPIDER_SIZE} ${SPIDER_SIZE}`);
  // Warm dark, like everything else on this board: a black spider would be the
  // one cold thing in the mess.
  const shell = '#2f231a';
  const back = '#241a12';
  const lit = '#6b5440';

  const legs: [SVGGElement, SVGGElement] = [svg('g'), svg('g')];
  legs[0].setAttribute('class', 'clean-spider-legs');
  legs[1].setAttribute('class', 'clean-spider-legs is-b');
  for (let i = 0; i < 4; i++) {
    // Front legs reach forward and long, back legs trail; the knee is above the
    // line between shoulder and foot, which is the whole of a spider's stance.
    const along = -2.2 + i * 1.5;
    const out = 2.6 + (i === 0 || i === 3 ? 0.6 : 1.1);
    const reach = out + rand(rng, 1.4, 2.2);
    const lift = -1.1 - rand(rng, 0.5, 1.1) + i * 0.25;
    for (const side of [-1, 1] as const) {
      const d = `M${f2(side * 0.9)} ${f2(along)}`
        + ` L${f2(side * out)} ${f2(along + lift)}`
        + ` L${f2(side * reach)} ${f2(along + lift + rand(rng, 1.6, 2.4))}`;
      // Team A is the front-left and back-left with the middle two on the right;
      // team B is the mirror of it. `(i + side)` is odd for one and even for the
      // other, which is that split written once.
      legs[(i + (side > 0 ? 1 : 0)) % 2]!.append(line(d, shell, 0.5));
    }
  }

  const body = svg('g');
  // Abdomen behind, cephalothorax in front, and the abdomen is the bigger of the
  // two - a spider seen from above is mostly abdomen.
  body.append(shape('ellipse', { cx: 0, cy: 2.1, rx: 2.2, ry: 2.9, fill: back, stroke: 'none' }));
  body.append(shape('ellipse', { cx: 0, cy: -1.4, rx: 1.5, ry: 1.7, fill: shell, stroke: 'none' }));
  // A pale fleck on each, where the light is coming from.
  body.append(shape('ellipse', {
    cx: -0.7, cy: 1.1, rx: 0.7, ry: 1, fill: lit, stroke: 'none', opacity: 0.45,
    transform: 'rotate(-20 -0.7 1.1)',
  }));
  body.append(shape('circle', { cx: -0.5, cy: -1.8, r: 0.4, fill: lit, stroke: 'none', opacity: 0.4 }));
  // The palps, which are what stops the front end being a full stop.
  body.append(line('M-0.8 -2.4 L-1.7 -3.4', shell, 0.4));
  body.append(line('M0.8 -2.4 L1.7 -3.4', shell, 0.4));

  // Everything that turns with its heading goes in one group, which clean.ts
  // turns; the svg itself never turns, so the shadow its CSS filter draws stays
  // below it. A filter on a turned element is turned with it, and a spider
  // walking down the screen cast its shadow up it.
  const turn = svg('g');
  turn.setAttribute('class', 'clean-spider-turn');
  turn.append(legs[0], legs[1], body);
  host.append(turn);
  return host;
}

// ---- the robot -----------------------------------------------------------

/** Across, in world pixels. The host's viewBox is this box, centred, so the
 *  drawing's units are the board's. */
export const ROBOT_SIZE = 60;

/** Room round the disc in the robot's drawing, for what sticks out of it: the
 *  mop pad under it and its fringe. */
export const ROBOT_BOX = ROBOT_SIZE + 16;

/**
 * A robot vacuum seen from above, in two layers.
 *
 * `body` turns with its heading, and is drawn front toward `-y`, like the
 * spider. `host` does not turn, and carries what must not: the shadow (a CSS
 * filter on it, in clean.css) and the light on the lid. A filter is drawn in
 * the element's own frame *before* its transform, so a shadow on the turning
 * layer turned with it - driving down the screen, the shadow fell upward and
 * the highlight sat at the bottom, and the robot read as lit from below and
 * reversing. Everything that comes from the room stays still; everything that
 * belongs to the machine turns.
 *
 * The body: a warm dark shell, a lighter lid, the bumper - a darker band round
 * the front half - one small amber light, and a seam. The bumper and the light
 * are what say "this end first". Under it all, hidden until clean.ts fits it, a
 * mop pad.
 */
export function robotNode(): { host: HTMLElement, body: SVGSVGElement } {
  const r = ROBOT_SIZE / 2;
  const half = ROBOT_BOX / 2;
  const box = `${-half} ${-half} ${ROBOT_BOX} ${ROBOT_BOX}`;
  const host = document.createElement('div');
  host.className = 'clean-robot';

  const body = svg('svg');
  body.setAttribute('class', 'clean-robot-body');
  body.setAttribute('viewBox', box);
  // The mop pad: a fringed disc of cloth a little wider than the robot,
  // showing round its edge and trailing strands behind.
  const mop = svg('g');
  mop.setAttribute('class', 'clean-robot-mop');
  mop.append(shape('circle', { r: r + 3.2, fill: '#d9d1c2', stroke: '#9c9282', 'stroke-width': 0.6 }));
  let fringe = '';
  for (let i = 0; i < 13; i++) {
    const a = Math.PI * (0.22 + (i / 12) * 0.56);
    const x = Math.cos(a) * (r + 2.4);
    const y = Math.sin(a) * (r + 2.4);
    fringe += ` M${f2(x)} ${f2(y)} l${f2(Math.cos(a) * 3.4)} ${f2(Math.sin(a) * 3.4)}`;
  }
  mop.append(line(fringe.trim(), '#b8ae9d', 0.9));
  body.append(mop);
  // No side brushes: at this size their bristles read as hair.
  body.append(shape('circle', { r: r - 0.5, fill: '#4a423a', stroke: '#2b2520', 'stroke-width': 0.8 }));
  // The bumper: the front half of the rim, a shade darker and a hair proud.
  const rim = `M${f2(-(r - 2.2))} 0 A ${f2(r - 2.2)} ${f2(r - 2.2)} 0 0 1 ${f2(r - 2.2)} 0`;
  body.append(line(rim, '#2b2520', 3.4));
  body.append(line(rim, '#6d6358', 0.6, 0.6));
  body.append(shape('circle', { r: r * 0.7, fill: '#6d6358', stroke: '#3a332c', 'stroke-width': 0.6 }));
  // A seam across the lid, and the button in the middle of it.
  body.append(line(`M${f2(-r * 0.68)} ${f2(r * 0.18)} L${f2(r * 0.68)} ${f2(r * 0.18)}`, '#3a332c', 0.5, 0.7));
  body.append(shape('circle', { r: r * 0.1, fill: '#554c43', stroke: '#3a332c', 'stroke-width': 0.4 }));
  // The light, at the front, with a little glow round it.
  body.append(shape('circle', { cy: -r * 0.52, r: 2.6, fill: '#e0a21c', stroke: 'none', opacity: 0.3 }));
  const lamp = shape('circle', { cy: -r * 0.52, r: 1.3, fill: '#f2b531', stroke: 'none' });
  lamp.setAttribute('class', 'clean-robot-lamp');
  body.append(lamp);

  // The room's light on the lid: upper left, whichever way the robot faces.
  const sheen = svg('svg');
  sheen.setAttribute('viewBox', box);
  sheen.append(shape('ellipse', {
    cx: -r * 0.22, cy: -r * 0.24, rx: r * 0.4, ry: r * 0.26,
    fill: '#8a8074', stroke: 'none', opacity: 0.4,
    transform: `rotate(-30 ${f2(-r * 0.22)} ${f2(-r * 0.24)})`,
  }));
  host.append(body, sheen);
  return { host, body };
}

/** The thread it comes down on: a hairline in the layer, tied where the strand
 *  was. Its own element rather than a path in the web sheet, because the web
 *  sheet is the thing that has just been swept away. */
export function threadNode(): HTMLElement {
  const node = document.createElement('div');
  node.className = 'clean-thread';
  return node;
}

