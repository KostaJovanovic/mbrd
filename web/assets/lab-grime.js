// web/assets/js/ui/clean/mess.ts
var MESS = {
  lime: { tool: "washer", family: "field", label: "limescale" },
  dirt: { tool: "washer", family: "field", label: "windblown dirt" },
  rust: { tool: "washer", family: "field", label: "rust" },
  tar: { tool: "washer", family: "field", label: "tar" },
  coffee: { tool: "washer", family: "field", label: "a coffee ring" },
  ink: { tool: "washer", family: "field", label: "ink" },
  film: { tool: "washer", family: "field", label: "a film of dust" },
  leaves: { tool: "glove", family: "debris", bulk: 1, label: "leaves" },
  crumbs: { tool: "glove", family: "debris", bulk: 1, label: "crumbs" },
  gum: { tool: "glove", family: "debris", bulk: 1, label: "gum" },
  paper: { tool: "glove", family: "debris", bulk: 2, label: "crumpled paper" },
  cap: { tool: "glove", family: "debris", bulk: 1, label: "a bottle cap" },
  dust: { tool: "glove", family: "debris", bulk: 1, label: "a ball of dust" },
  tape: { tool: "glove", family: "debris", bulk: 1, label: "masking tape" },
  sticky: { tool: "glove", family: "debris", bulk: 1, label: "a sticky note" },
  cobweb: { tool: "duster", family: "web", label: "cobweb" },
  track: { tool: "washer", family: "track", label: "muddy prints" }
};
var GRIMES = ["lime", "lime", "dirt", "dirt", "rust", "rust", "tar", "film"];
var rand = (rng2, lo, hi) => lo + rng2() * (hi - lo);
var FAMILY_TOOLS = { field: [], debris: [], web: [], track: [] };
for (const kind of Object.keys(MESS)) {
  const { family, tool } = MESS[kind];
  if (!FAMILY_TOOLS[family].includes(tool)) FAMILY_TOOLS[family].push(tool);
}

// web/assets/js/cuelume/recipes.ts
var RECIPES = {
  /** A soft two-note ascending bell, like a confirmation tink. */
  chime: {
    masterGain: 0.5,
    layers: [
      { kind: "tone", waveform: "sine", frequency: 1046.5, attack: 6e-3, decay: 0.22, peak: 0.09 },
      { kind: "tone", waveform: "sine", frequency: 1568, offset: 0.09, attack: 6e-3, decay: 0.26, peak: 0.08 }
    ],
    shimmer: { delay: 0.12, feedback: 0.25, wet: 0.18, lowpass: 4e3 }
  },
  /** A quick ascending twinkle of four notes - bright and playful. */
  sparkle: {
    masterGain: 0.5,
    layers: [
      { kind: "tone", waveform: "sine", frequency: 1760, offset: 0, attack: 3e-3, decay: 0.09, peak: 0.045 },
      { kind: "tone", waveform: "sine", frequency: 2217, offset: 0.045, attack: 3e-3, decay: 0.09, peak: 0.04 },
      { kind: "tone", waveform: "sine", frequency: 2637, offset: 0.09, attack: 3e-3, decay: 0.1, peak: 0.038 },
      { kind: "tone", waveform: "sine", frequency: 3520, offset: 0.135, attack: 3e-3, decay: 0.12, peak: 0.032 }
    ],
    shimmer: { delay: 0.07, feedback: 0.35, wet: 0.22, lowpass: 6e3 }
  },
  /** A single note gliding smoothly downward, like a drop of water. */
  droplet: {
    masterGain: 0.55,
    layers: [
      { kind: "tone", waveform: "sine", frequency: 1200, glideTo: 550, glideTime: 0.14, attack: 4e-3, decay: 0.2, peak: 0.075 }
    ],
    shimmer: { delay: 0.09, feedback: 0.2, wet: 0.15, lowpass: 3e3 }
  },
  /** A warm, slow-swelling pad from two gently detuned sines. */
  bloom: {
    masterGain: 0.5,
    layers: [
      { kind: "tone", waveform: "sine", frequency: 528, attack: 0.06, decay: 0.32, peak: 0.06 },
      { kind: "tone", waveform: "sine", frequency: 528, detune: 12, attack: 0.06, decay: 0.34, peak: 0.05 }
    ],
    shimmer: { delay: 0.15, feedback: 0.2, wet: 0.12, lowpass: 2500 }
  },
  /** A soft hush with a falling tone - the quietest thing in the palette. */
  whisper: {
    masterGain: 0.48,
    layers: [
      { kind: "noise", filterType: "lowpass", filterFrequency: 1600, filterQ: 0.7, attack: 0.025, decay: 0.13, peak: 0.04 },
      { kind: "tone", waveform: "sine", frequency: 880, glideTo: 660, glideTime: 0.14, offset: 0.01, attack: 0.012, decay: 0.14, peak: 0.025 }
    ]
  },
  /** A focused bandpass tick with a bright sine ping on top - crisp and instant. */
  tick: {
    masterGain: 0.4,
    layers: [
      { kind: "noise", filterType: "bandpass", filterFrequency: 5400, filterQ: 1.8, attack: 1e-3, decay: 0.018, peak: 0.14 },
      { kind: "tone", waveform: "sine", frequency: 2600, attack: 1e-3, decay: 0.012, peak: 0.018 }
    ]
  },
  /** A dull, muted knock - a key bottoming out. */
  press: {
    masterGain: 0.4,
    layers: [
      { kind: "noise", filterType: "bandpass", filterFrequency: 1700, filterQ: 1.4, attack: 1e-3, decay: 0.02, peak: 0.13 }
    ]
  },
  /** A brighter, springier tick - a key returning. */
  release: {
    masterGain: 0.4,
    layers: [
      { kind: "noise", filterType: "bandpass", filterFrequency: 4600, filterQ: 1.8, attack: 1e-3, decay: 0.016, peak: 0.12 },
      { kind: "tone", waveform: "sine", frequency: 3200, offset: 6e-3, attack: 1e-3, decay: 0.05, peak: 0.02 }
    ]
  },
  /** A two-part click-clack, like a mechanical switch flipping between states. */
  toggle: {
    masterGain: 0.4,
    layers: [
      { kind: "noise", filterType: "bandpass", filterFrequency: 2200, filterQ: 1.6, attack: 1e-3, decay: 0.016, peak: 0.12 },
      { kind: "noise", filterType: "bandpass", filterFrequency: 3800, filterQ: 1.6, offset: 0.024, attack: 1e-3, decay: 0.02, peak: 0.1 }
    ]
  },
  /** A short, warm three-note ascending confirmation - "done", not a fanfare. */
  success: {
    masterGain: 0.5,
    layers: [
      { kind: "tone", waveform: "sine", frequency: 880, attack: 4e-3, decay: 0.09, peak: 0.06 },
      { kind: "tone", waveform: "sine", frequency: 1108.73, offset: 0.06, attack: 4e-3, decay: 0.1, peak: 0.06 },
      { kind: "tone", waveform: "sine", frequency: 1318.51, offset: 0.12, attack: 4e-3, decay: 0.18, peak: 0.07 }
    ],
    shimmer: { delay: 0.1, feedback: 0.22, wet: 0.16, lowpass: 4500 }
  },
  /** A muted knock followed by two descending tones - a calm, recoverable refusal. */
  error: {
    masterGain: 0.42,
    layers: [
      { kind: "noise", filterType: "bandpass", filterFrequency: 850, filterQ: 1.1, attack: 1e-3, decay: 0.035, peak: 0.13 },
      { kind: "tone", waveform: "triangle", frequency: 440, offset: 0.025, attack: 4e-3, decay: 0.09, peak: 0.045 },
      { kind: "tone", waveform: "triangle", frequency: 349.23, offset: 0.1, attack: 4e-3, decay: 0.14, peak: 0.04 }
    ]
  },
  /** A papery filtered flick with a tiny glass tick - pages and carousels. */
  page: {
    masterGain: 0.38,
    layers: [
      { kind: "noise", filterType: "lowpass", filterFrequency: 1800, filterQ: 0.7, attack: 6e-3, decay: 0.08, peak: 0.11 },
      { kind: "noise", filterType: "bandpass", filterFrequency: 4200, filterQ: 1.2, offset: 0.04, attack: 4e-3, decay: 0.065, peak: 0.08 },
      { kind: "tone", waveform: "sine", frequency: 2400, offset: 0.075, attack: 2e-3, decay: 0.045, peak: 0.02 }
    ]
  },
  /** A brief unresolved lift - work has started. */
  loading: {
    masterGain: 0.42,
    layers: [
      { kind: "noise", filterType: "lowpass", filterFrequency: 1400, filterQ: 0.6, attack: 0.035, decay: 0.14, peak: 0.035 },
      { kind: "tone", waveform: "sine", frequency: 420, glideTo: 630, glideTime: 0.18, attack: 0.025, decay: 0.18, peak: 0.05 }
    ],
    shimmer: { delay: 0.11, feedback: 0.18, wet: 0.12, lowpass: 2800 }
  },
  /** A quick lock-on sweep resolving to a clear tone - the system is ready. */
  ready: {
    masterGain: 0.48,
    layers: [
      { kind: "noise", filterType: "bandpass", filterFrequency: 3600, filterQ: 1.8, attack: 1e-3, decay: 0.02, peak: 0.11 },
      { kind: "tone", waveform: "triangle", frequency: 330, glideTo: 660, glideTime: 0.12, offset: 0.012, attack: 4e-3, decay: 0.16, peak: 0.055 },
      { kind: "tone", waveform: "sine", frequency: 990, offset: 0.13, attack: 4e-3, decay: 0.22, peak: 0.06 }
    ],
    shimmer: { delay: 0.1, feedback: 0.16, wet: 0.1, lowpass: 4200 }
  },
  /** A compact synthetic chirp - crisp feedback for a primary control. */
  pulse: {
    masterGain: 0.42,
    layers: [
      { kind: "noise", filterType: "bandpass", filterFrequency: 2600, filterQ: 2.4, attack: 1e-3, decay: 0.022, peak: 0.08 },
      { kind: "tone", waveform: "triangle", frequency: 620, glideTo: 1240, glideTime: 0.07, attack: 2e-3, decay: 0.085, peak: 0.055 }
    ]
  },
  /** A fast three-step locator signal - playful, secondary. */
  scan: {
    masterGain: 0.4,
    layers: [
      { kind: "tone", waveform: "sine", frequency: 740, attack: 2e-3, decay: 0.055, peak: 0.05 },
      { kind: "tone", waveform: "sine", frequency: 1110, offset: 0.045, attack: 2e-3, decay: 0.055, peak: 0.045 },
      { kind: "tone", waveform: "sine", frequency: 1665, offset: 0.09, attack: 2e-3, decay: 0.07, peak: 0.04 }
    ],
    shimmer: { delay: 0.065, feedback: 0.16, wet: 0.1, lowpass: 4200 }
  },
  /** A rising harmonic portal with a soft tail - somewhere has been arrived at. */
  arrival: {
    masterGain: 0.44,
    layers: [
      { kind: "noise", filterType: "lowpass", filterFrequency: 900, filterQ: 0.8, attack: 0.05, decay: 0.24, peak: 0.035 },
      { kind: "tone", waveform: "sine", frequency: 220, glideTo: 440, glideTime: 0.32, attack: 0.04, decay: 0.34, peak: 0.055 },
      { kind: "tone", waveform: "sine", frequency: 659.25, offset: 0.12, attack: 0.045, decay: 0.32, peak: 0.04 },
      { kind: "tone", waveform: "sine", frequency: 987.77, offset: 0.19, attack: 0.045, decay: 0.34, peak: 0.032 }
    ],
    shimmer: { delay: 0.16, feedback: 0.28, wet: 0.18, lowpass: 3200 }
  }
};
var SOUND_NAMES = (
  // SAFETY: as above.
  Object.keys(RECIPES)
);
var CUES = {
  pick: { sound: "toggle" },
  tap: { sound: "tick" },
  say: { sound: "press" },
  on: { sound: "pulse" },
  off: { sound: "pulse", reverse: true },
  rise: { sound: "chime" },
  fall: { sound: "chime", reverse: true },
  done: { sound: "success" },
  fail: { sound: "error" },
  note: { sound: "page" },
  arrive: { sound: "arrival" },
  sweep: { sound: "ready" }
};
var CUE_NAMES = (
  // SAFETY: as above.
  Object.keys(CUES)
);
var MAX_TRIM = 10 ** (10 / 20);

// web/assets/js/notify.ts
var NOWHERE = Object.freeze({
  label() {
  },
  step() {
  },
  end() {
  }
});

// web/assets/js/util.ts
var clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

// web/assets/js/ui/clean/art.ts
function hashI(x, y, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177);
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return (h ^ h >>> 16) >>> 0;
}
var hash = (x, y, seed) => hashI(x, y, seed) / 4294967296;
function vnoise(x, y, seed) {
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
function fbm(x, y, seed, octaves) {
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
var GX = [1, 0.7071, 0, -0.7071, -1, -0.7071, 0, 0.7071];
var GY = [0, 0.7071, 1, 0.7071, 0, -0.7071, -1, -0.7071];
function corner(ix, iy, seed, fx, fy) {
  const k = hashI(ix, iy, seed) & 7;
  return GX[k] * fx + GY[k] * fy;
}
function gnoise(x, y, seed) {
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
function gfbm(x, y, seed, octaves) {
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
var cellF1 = 0;
var cellId = 0;
function cells(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 9;
  let id = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      const h = hashI(cx, cy, seed);
      const px = cx + (h & 65535) / 65536 - x;
      const py = cy + (h >>> 16) / 65536 - y;
      const d = px * px + py * py;
      if (d < f1) {
        f1 = d;
        id = h;
      }
    }
  cellF1 = Math.sqrt(f1);
  cellId = (Math.imul(id, 2654435761) >>> 0) / 4294967296;
}
var clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
var smooth = (edge0, edge1, v) => {
  const t = clamp01((v - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
};
var mix = (a, b, t) => a + (b - a) * t;
var CRUST_AT = 0.35;
var common = (relief, gloss = 0, shine = 1) => ({
  scale: 1,
  relief,
  gloss,
  shine,
  tone: 1,
  sat: 1,
  warmth: 0,
  cover: 0.8,
  bands: 0,
  patch: 0,
  edge: 0,
  poster: 0
});
var LOOK = {
  /** Degrees round the screen (0 is right, -90 up) and up off the card, and
   *  how dark a face turned fully away from it gets. */
  light: { azimuth: -127.5, elevation: 40.9, ambient: 0.3 },
  /** How far one card's crust may stray from the next of its kind: its scale
   *  in octaves either way, its tone and cover as a share, its warmth. Rolled
   *  from the card's seed, so a card keeps its look across a repaint. */
  vary: { scale: 0.7, tone: 0.12, warmth: 0.3, cover: 0.1, patch: 0.25 },
  /** How many tide marks the drying left, how much of it has built up into
   *  crust, how much cover the thin film between keeps, how much iron has
   *  yellowed it, and the share of places a dried drop left a spot. */
  lime: { ...common(0.012), patch: 0.3, edge: 0.35, cover: 0.85, rings: 5, crust: 0.45, film: 0.45, stain: 0.35, spots: 0.35 },
  /** How strongly it piled into drifts, how streaked along the wind, how
   *  close the ripples lie, how gritty the soil, and how much cover the
   *  scoured places keep. */
  dirt: { ...common(0.014), patch: 0.2, cover: 0.9, drift: 0.7, scour: 0.6, ripples: 16, grit: 0.4, thin: 0.35 },
  /** Flake frequency, where old gives way to orange (lower is more orange),
   *  how many pits, how much of it has blistered into lifting scale, how
   *  strongly it runs down in streaks, and how far across the card it has
   *  spread from where it started (1 is about to reach the far side). Always
   *  opaque - see `rust`. */
  rust: { ...common(0.03), patch: 0.3, edge: 0.25, flakes: 12, age: 0.4, pits: 0.12, scaly: 0.7, runs: 0.6, spread: 0.76 },
  /** How deep the sag wrinkles are, and the share of cells with a blister. */
  tar: { ...common(0.02, 0.8, 60), patch: 0.15, wrinkles: 0.2, blisters: 0.2 },
  /** A spill is a few overlapping rounds - a cup set down three times - not
   *  one: how many, how big against the card, how much of the darkness is
   *  the tide line rather than the body, and how much cover the body keeps
   *  (1 is as solid as the ring; a stain is in the paper and thin). */
  coffee: { ...common(4e-3, 0.1, 12), blots: 4, size: 0.26, tide: 0.9, body: 0.35, drops: 3 },
  /** Blots, their size, how far the edge frays along the fibres, the
   *  droplets thrown clear, and how much darker it dried at its rim. */
  ink: { ...common(6e-3, 0.25, 26), blots: 5, size: 0.2, fray: 0.15, drops: 6, rim: 0.6 },
  /** How much the finger wipes thin it, the grain's frequency, how many wipes
   *  cross it and how narrow they are (higher is finer). */
  film: { ...common(8e-3), edge: 0.3, patch: 0.3, cover: 0.75, wipe: 0.75, grain: 70, streaks: 4, fine: 0.7 }
};
var GRIME_KINDS = ["lime", "dirt", "rust", "tar", "coffee", "ink", "film"];
var isGrime = (kind) => GRIME_KINDS.some((g) => g === kind);
var lookOf = (kind) => isGrime(kind) ? LOOK[kind] : LOOK.lime;
var spillOf = (kind) => kind === "coffee" ? LOOK.coffee : kind === "ink" ? LOOK.ink : null;
function blotAt(seed, x, y, n, size) {
  let edge = -1;
  for (let i = 0; i < n; i++) {
    const cx = 0.5 + (hash(i, 1, seed) - 0.5) * 0.62;
    const cy = 0.5 + (hash(i, 2, seed) - 0.5) * 0.62;
    const r = size * (0.55 + hash(i, 3, seed) * 0.9);
    const sx = 0.8 + hash(i, 4, seed) * 0.45;
    const dx = (x - cx) / (r * sx);
    const dy = (y - cy) / r;
    const wob = (gnoise(x * 6 + i * 3, y * 6, seed + i) - 0.5) * 0.22;
    edge = Math.max(edge, 1 - Math.hypot(dx, dy) + wob);
  }
  return { edge };
}
function spillEdge(spill, seed, x, y) {
  let edge = blotAt(seed, x, y, Math.round(spill.blots), spill.size).edge;
  const drops = Math.round(spill.drops);
  for (let j = 0; j < drops; j++) {
    const cx = 0.5 + (hash(j, 11, seed) - 0.5) * 0.9;
    const cy = 0.5 + (hash(j, 12, seed) - 0.5) * 0.9;
    const r = spill.size * (0.1 + hash(j, 13, seed) * 0.14);
    edge = Math.max(edge, 1 - Math.hypot(x - cx, y - cy) / r);
  }
  return edge;
}
function rustFront(seed, x, y) {
  const from = Math.floor(hash(0, 70, seed) * 8);
  const fx = from & 1 ? 1 - x : x;
  const fy = (from < 4 ? from & 1 : from & 2) ? 1 - y : y;
  const across = from < 4 ? from & 2 ? fy : fx : Math.hypot(fx, fy) / 1.25;
  const rim = Math.min(x, 1 - x, y, 1 - y);
  const n = gfbm(x * 3.2, y * 3.2, seed + 71, 3);
  const rag = gnoise(x * 18, y * 18, seed + 72) + gnoise(x * 45, y * 45, seed + 74) * 0.5;
  const reach = LOOK.rust.spread * (0.92 + 0.16 * hash(1, 70, seed));
  let front = reach - across + 0.12 * (1 - smooth(0, 0.12, rim)) + (n - 0.5) * 0.4 + (rag - 0.75) * 0.07;
  cells(x * 7, y * 7, seed + 73);
  if (cellId < 0.3) front = Math.max(front, 0.05 * (0.4 + cellId * 3) - cellF1 * 0.14);
  return front;
}
var frontSeed = NaN;
var frontX = NaN;
var frontY = NaN;
var frontLast = 0;
function frontOf(seed, x, y) {
  if (seed !== frontSeed || x !== frontX || y !== frontY) {
    frontSeed = seed;
    frontX = x;
    frontY = y;
    frontLast = rustFront(seed, x, y);
  }
  return frontLast;
}
function crustAt(c, x, y) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return 0;
  if (c.kind === "rust") return clamp01(CRUST_AT + frontOf(c.seed, x, y) * 60);
  const spill = spillOf(c.kind);
  if (!spill) return 1;
  return clamp01(spillEdge(spill, c.seed, x, y) * 6);
}
var sH = 0;
var sR = 0;
var sG = 0;
var sB = 0;
var sWet = 1;
var sA = 1;
var lime = (seed, x, y, rich) => {
  const L = LOOK.lime;
  const wx = x + (gnoise(x * 2.2, y * 2.2, seed + 61) - 0.5) * 0.08;
  const wy = y + (gnoise(x * 2.2 + 4, y * 2.2 + 9, seed + 62) - 0.5) * 0.08;
  const level = gfbm(wx * 1.3, wy * 1.3, seed + 63, 2);
  const t = level * L.rings;
  const f = t - Math.floor(t);
  const reach = 0.16 + 0.1 * gnoise(x * 7, y * 7, seed + 64);
  const ring = smooth(0, 0.02, f) * smooth(reach, 0, f);
  cells(wx * 11, wy * 11, seed + 65);
  const lumpy = smooth(0.5, 0.1, cellF1);
  const pooled = smooth(0.7 - L.crust * 0.5, 0.84 - L.crust * 0.5, level);
  const crust = clamp01(pooled * (0.45 + 0.55 * lumpy));
  cells(x * 13, y * 13, seed + 68);
  const r0 = 0.16 + cellId * 0.2;
  const spot = cellId < L.spots ? smooth(0.05, 0, Math.abs(cellF1 - r0)) + smooth(r0, r0 * 0.4, cellF1) * 0.3 : 0;
  const grain = rich ? gfbm(x * 70, y * 70, seed + 66, 2) : gnoise(x * 70, y * 70, seed + 66);
  sH = crust * 0.55 + ring * 0.3 + spot * 0.25 + grain * (0.12 + 0.35 * crust);
  const solid = clamp01(Math.max(crust, ring * 0.8, spot * 0.9));
  let r = mix(206, 240, solid) + (grain - 0.5) * 18;
  let g = mix(204, 236, solid) + (grain - 0.5) * 18;
  let b = mix(194, 222, solid) + (grain - 0.5) * 16;
  const iron = smooth(0.55, 0.8, gfbm(x * 2.2 + 7, y * 2.2, seed + 67, 2)) * L.stain * (0.4 + 0.6 * solid);
  r = mix(r, 212, iron);
  g = mix(g, 182, iron);
  b = mix(b, 118, iron);
  sR = r;
  sG = g;
  sB = b;
  sWet = 0;
  sA = mix(L.film, 1, solid);
};
var dirt = (seed, x, y, rich) => {
  const L = LOOK.dirt;
  const a = (hash(0, 71, seed) - 0.5) * 1.4 + (hash(1, 71, seed) < 0.5 ? 0 : Math.PI);
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const along = x * dx + y * dy;
  const across = -x * dy + y * dx;
  const streak = gfbm(along * 1.4, across * 7, seed + 72, 3);
  const drift = gfbm(x * 1.6 + 3, y * 1.6, seed + 73, 2);
  const banks = 0.5 + (drift - 0.5) * 1.6 * L.drift;
  const thick = clamp01(banks + (streak - 0.5) * 1.4 * L.scour);
  const bend = (gnoise(across * 2.5, along * 1.5, seed + 74) - 0.5) * 1.4;
  const f = along * L.ripples * (0.85 + 0.3 * drift) + bend;
  const p = f - Math.floor(f);
  const where = smooth(0.4, 0.7, gnoise(x * 2.1 + 5, y * 2.1, seed + 77));
  const ripple = (p < 0.78 ? p / 0.78 : (1 - p) / 0.22) * smooth(0.3, 0.65, thick) * where;
  const grain = rich ? gfbm(x * 80, y * 80, seed + 75, 2) : gnoise(x * 80, y * 80, seed + 75);
  cells(x * 40, y * 40, seed + 76);
  const grit = cellId > 1 - L.grit * 0.1 ? smooth(0.26, 0.1, cellF1) : 0;
  sH = clamp01(banks) * 0.6 + ripple * 0.14 + grain * 0.18 + grit * 0.35;
  let r = mix(172, 118, thick) + (grain - 0.5) * 26 + ripple * 8;
  let g = mix(142, 90, thick) + (grain - 0.5) * 22 + ripple * 7;
  let b = mix(106, 62, thick) + (grain - 0.5) * 16 + ripple * 5;
  if (grit) {
    r = mix(r, 74, grit);
    g = mix(g, 62, grit);
    b = mix(b, 50, grit);
  }
  sR = r;
  sG = g;
  sB = b;
  sWet = 0;
  sA = mix(L.thin, 1, smooth(0.1, 0.6, thick));
};
var rust = (seed, x, y, rich, u, v) => {
  const L = LOOK.rust;
  const wx = x + (gnoise(x * 4, y * 4, seed + 31) - 0.5) * 0.1;
  const wy = y + (gnoise(x * 4 + 7, y * 4 + 13, seed + 32) - 0.5) * 0.1;
  const deep = smooth(0, 0.3, frontOf(seed, u, v));
  const grit = rich ? gfbm(x * 70, y * 70, seed + 35, 3) : gnoise(x * 70, y * 70, seed + 35);
  const swell = gfbm(x * 4.5, y * 4.5, seed + 36, 2);
  const lift = L.scaly * (0.25 + 0.9 * deep);
  const scaly = smooth(1 - lift - 0.08, 1 - lift + 0.08, gfbm(wx * 2.4 + 11, wy * 2.4, seed + 39, 2));
  const f = L.flakes * 0.5;
  const sheet = gfbm(wx * f, wy * f, seed + 33, 3) + (grit - 0.5) * 0.12;
  const hole = scaly * smooth(0.56, 0.575, sheet);
  const near = smooth(0.44, 0.56, sheet);
  const curl = scaly * near * (1 - hole);
  const flake = scaly - hole;
  const cluster = smooth(0.55, 0.75, gnoise(x * 3 + 21, y * 3, seed + 41));
  cells(wx * 22, wy * 22, seed + 34);
  const pit = cellId > 1 - L.pits * (0.4 + 1.2 * cluster) ? smooth(0.3, 0.08, cellF1) : 0;
  sH = (swell * 0.45 + grit * 0.5) * (0.5 + 0.5 * deep) + flake * 0.5 + curl * 0.9 - pit * 0.5;
  const run = gfbm(x * 18, y * 1.8, seed + 38, 2);
  const age = gfbm(wx * 2.8 + 9, wy * 2.8, seed + 37, 3);
  const t = clamp01(0.5 + (age - L.age - 0.1) * 2.4 + (grit - 0.5) * 0.4 + (run - 0.5) * L.runs + (1 - deep) * 0.45 - deep * 0.15);
  let r = t < 0.72 ? mix(58, 128, smooth(0.1, 0.72, t)) : mix(128, 186, (t - 0.72) / 0.28);
  let g = t < 0.72 ? mix(32, 56, smooth(0.1, 0.72, t)) : mix(56, 92, (t - 0.72) / 0.28);
  let b = t < 0.72 ? mix(22, 32, smooth(0.1, 0.72, t)) : mix(32, 40, (t - 0.72) / 0.28);
  const speck = (grit - 0.5) * 52;
  r += speck;
  g += speck * 0.5;
  b += speck * 0.28;
  const k = 1 - hole * 0.5 - pit * 0.7;
  const fresh = hole * smooth(0.45, 0.7, grit);
  const lip = curl * near;
  r = r * k + lip * 34 + fresh * 38;
  g = g * k + lip * 17 + fresh * 16;
  b = b * k + lip * 5 + fresh * 4;
  sR = r;
  sG = g;
  sB = b;
  sWet = 0;
};
var tar = (seed, x, y, rich) => {
  const L = LOOK.tar;
  const wx = x + (gnoise(x * 2.2, y * 2.2, seed + 51) - 0.5) * 0.3;
  const wy = y + (gnoise(x * 2.2 + 5, y * 2.2 + 11, seed + 52) - 0.5) * 0.3;
  const flow = gfbm(wx * 3.1, wy * 3.1, seed + 53, rich ? 3 : 2);
  const where = smooth(0.5, 0.72, gnoise(x * 2.6 + 3, y * 2.6, seed + 54));
  const ridge = 1 - Math.abs(2 * fbm(wx * 3.5, wy * 17, seed + 55, 2) - 1);
  cells(x * 8, y * 8, seed + 56);
  const blister = cellId > 1 - L.blisters ? smooth(0.2, 0, cellF1) : 0;
  sH = flow * 2.4 + ridge * ridge * where * L.wrinkles + blister * 0.3;
  const v = gnoise(x * 30, y * 30, seed + 57);
  sR = 30 + flow * 16 + v * 5;
  sG = 23 + flow * 12 + v * 4;
  sB = 16 + flow * 9 + v * 3;
  sWet = 1;
};
var coffee = (seed, x, y, rich, u, v) => {
  const L = LOOK.coffee;
  const edge = spillEdge(L, seed, u, v);
  const tide = smooth(0.22, 0.02, edge) * L.tide + smooth(0.6, 0.3, edge) * (1 - L.tide);
  const grain = rich ? gfbm(x * 40, y * 40, seed + 71, 2) : gnoise(x * 40, y * 40, seed + 71);
  sH = tide * 0.5 + grain * 0.1;
  const dark = 0.3 + tide * 0.7;
  sR = mix(206, 128, dark) + grain * 8;
  sG = mix(176, 88, dark) + grain * 6;
  sB = mix(138, 58, dark) + grain * 4;
  sWet = 0.2;
  sA = mix(L.body, 1, clamp01(tide * 1.4));
};
var ink = (seed, x, y, rich, u, v) => {
  const L = LOOK.ink;
  const edge = spillEdge(L, seed, u, v);
  const fray = (gfbm(x * 34, y * 34, seed + 81, rich ? 3 : 2) - 0.5) * L.fray;
  const body = smooth(0, 0.16, edge + fray);
  const rim = smooth(0.3, 0.04, edge) * L.rim;
  sH = body * 0.7 + rim * 0.3 + (rich ? gfbm(x * 25, y * 25, seed + 82, 2) * 0.12 : 0);
  const n = gnoise(x * 28, y * 28, seed + 83);
  const lift = 1 - body + (1 - rim) * L.rim * 0.9;
  sR = 34 + lift * 26 + n * 5;
  sG = 26 + lift * 20 + n * 4;
  sB = 19 + lift * 15 + n * 3;
  sWet = 0.35;
  sA = 1 - (1 - rim) * L.rim * 0.25;
};
var film = (seed, x, y, rich) => {
  const L = LOOK.film;
  const f = L.grain;
  const grain = rich ? gfbm(x * f, y * f, seed + 91, 2) : gnoise(x * f, y * f, seed + 91);
  const wy = y + (gnoise(x * 1.7, y * 1.7, seed + 92) - 0.5) * 0.5;
  const band = 1 - Math.abs(2 * fbm(x * 1.3, wy * L.streaks, seed + 93, 2) - 1);
  const lo = 0.62 + L.fine * 0.3;
  const wipe = smooth(lo, Math.min(0.99, lo + 0.33 - L.fine * 0.2), band) * L.wipe;
  cells(x * 38, y * 38, seed + 94);
  const speck = L.fine > 0 && cellId > 0.9 ? smooth(0.16, 0.04, cellF1) * L.fine : 0;
  sH = grain * 0.22 + (1 - wipe) * 0.12 + speck * 0.4;
  const k = (1 - wipe * 0.55 * (1 - L.fine)) * (1 - speck * 0.35);
  sR = (176 + grain * 22) * k;
  sG = (168 + grain * 20) * k;
  sB = (154 + grain * 18) * k;
  sWet = 0;
  sA = 1 - wipe * L.fine * 0.85;
};
var MATERIAL = {
  // Milky: limescale in water is a cloud, not a colour.
  lime: { surface: lime, fleck: "rgb(226 222 208)", wash: [184, 184, 176] },
  dirt: { surface: dirt, fleck: "rgb(118 90 62)", wash: [96, 72, 46] },
  rust: { surface: rust, fleck: "rgb(150 74 30)", wash: [108, 54, 24], bloom: [180, 96, 44] },
  tar: { surface: tar, fleck: "rgb(44 34 25)", wash: [34, 26, 19] },
  coffee: { surface: coffee, fleck: "rgb(150 108 70)", wash: [120, 86, 54] },
  ink: { surface: ink, fleck: "rgb(48 38 28)", wash: [38, 30, 22] },
  film: { surface: film, fleck: "rgb(178 170 156)", wash: [134, 128, 116] }
};
var materialOf = (kind) => MATERIAL[kind] ?? MATERIAL.lime;
var NOISE_MAX = 232;
var NOISE_LIGHT = 150;
function lightOf() {
  const az = LOOK.light.azimuth * Math.PI / 180;
  const el2 = clamp(LOOK.light.elevation, 5, 90) * Math.PI / 180;
  const lx = Math.cos(az) * Math.cos(el2);
  const ly = Math.sin(az) * Math.cos(el2);
  const lz = Math.sin(el2);
  const hn = Math.hypot(lx, ly, lz + 1);
  return { lx, ly, lz, hx: lx / hn, hy: ly / hn, hz: (lz + 1) / hn, ambient: clamp01(LOOK.light.ambient) };
}
function paintField(ctx, c, w, h, rich = true) {
  crustPainter(ctx, c, w, h, rich)(Infinity);
}
function tileOf(px, w, h) {
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const into = out.getContext("2d");
  if (!into) return out;
  const img = into.createImageData(w, h);
  img.data.set(px);
  into.putImageData(img, 0, 0);
  return out;
}
function crustPainter(ctx, c, w, h, rich = true) {
  if (w <= 0 || h <= 0) return () => true;
  const scale = Math.min(1, (rich ? NOISE_MAX : NOISE_LIGHT) / Math.max(w, h));
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const job = crustRows(c, nw, nh, rich);
  return (until) => {
    if (!job.step(until)) return false;
    ctx.drawImage(tileOf(job.px, nw, nh), 0, 0, w, h);
    return true;
  };
}
function crustRows(c, w, h, rich) {
  const m = materialOf(c.kind);
  const k = lookOf(c.kind);
  const { lx, ly, lz, hx, hy, hz, ambient } = lightOf();
  const roll = (i) => hash(i, 97, c.seed) * 2 - 1;
  const size = Math.max(0.05, k.scale * 2 ** (LOOK.vary.scale * roll(1)));
  const tone = k.tone * (1 + LOOK.vary.tone * roll(2));
  const warmth = k.warmth + LOOK.vary.warmth * roll(3);
  const cover = m.bloom ? 1 : clamp01(k.cover * (1 + LOOK.vary.cover * roll(4)));
  const bands = Math.round(k.bands);
  const poster = Math.round(k.poster);
  const patch = clamp01(k.patch + LOOK.vary.patch * roll(5));
  const px = new Uint8ClampedArray(w * h * 4);
  const n = w * h;
  const thick = new Float32Array(n);
  const high = new Float32Array(n);
  const wet = new Float32Array(n);
  const dens = new Float32Array(n);
  const col = new Float32Array(n * 3);
  const long = Math.max(w, h);
  const ax = w / long;
  const ay = h / long;
  const heights = (y) => {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const t = crustAt(c, u, v);
      if (t <= 0.02) continue;
      const i = y * w + x;
      thick[i] = t;
      sA = 1;
      m.surface(c.seed, u * ax / size, v * ay / size, rich, u, v);
      let d = 1;
      if (patch > 0) d -= patch * 0.7 * (1 - smooth(0.3, 0.7, gfbm(u * ax * 2.2, v * ay * 2.2, c.seed + 401, 3)));
      if (k.edge > 0) {
        const rim = Math.min(u, 1 - u, v, 1 - v) * 2;
        d -= k.edge * 0.55 * smooth(0.15, 0.85, rim);
      }
      const thin = 1 - Math.max(0.3, d);
      dens[i] = m.bloom ? 1 : Math.max(0.3, d) * sA;
      if (m.bloom && thin > 0) {
        const [br, bg, bb] = m.bloom;
        const s = thin * 0.6;
        sR = mix(sR, br, s);
        sG = mix(sG, bg, s);
        sB = mix(sB, bb, s);
      }
      high[i] = sH * k.relief * size * (0.4 + 0.6 * Math.max(0.3, d));
      wet[i] = sWet;
      const grey = sR * 0.299 + sG * 0.587 + sB * 0.114;
      col[i * 3] = (grey + (sR - grey) * k.sat) * tone + warmth * 24;
      col[i * 3 + 1] = (grey + (sG - grey) * k.sat) * tone + warmth * 6;
      col[i * 3 + 2] = (grey + (sB - grey) * k.sat) * tone - warmth * 24;
    }
  };
  const light = (y) => {
    const y0 = y > 0 ? y - 1 : y;
    const y1 = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * 4;
      const a = smooth(0, CRUST_AT, thick[i]);
      if (a <= 0) continue;
      const x0 = x > 0 ? x - 1 : x;
      const x1 = x < w - 1 ? x + 1 : x;
      const dx = (high[y * w + x1] - high[y * w + x0]) * long / (x1 - x0 || 1);
      const dy = (high[y1 * w + x] - high[y0 * w + x]) * long / (y1 - y0 || 1);
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const nx = -dx * inv;
      const ny = -dy * inv;
      const nz = inv;
      let lit = Math.max(0, nx * lx + ny * ly + nz * lz) / lz;
      if (bands >= 2) lit = Math.round(lit * (bands - 1)) / (bands - 1);
      const shade = ambient + (1 - ambient) * lit;
      let r = col[i * 3] * shade;
      let g = col[i * 3 + 1] * shade;
      let b = col[i * 3 + 2] * shade;
      if (k.gloss) {
        const wetness = k.gloss * wet[i];
        const s = Math.pow(Math.max(0, nx * hx + ny * hy + nz * hz), k.shine) * wetness;
        const sky = smooth(-0.05, 0.5, -ny) * wetness * 0.3;
        r += (196 - r) * sky + (250 - r) * s;
        g += (182 - g) * sky + (246 - g) * s;
        b += (160 - b) * sky + (236 - b) * s;
      }
      if (poster >= 2) {
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        const q = Math.round(lum / 255 * (poster - 1)) / (poster - 1) * 255;
        const f = lum > 1 ? q / lum : 1;
        r *= f;
        g *= f;
        b *= f;
      }
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = a * cover * dens[i] * 255;
    }
  };
  let pass = 0;
  let row = 0;
  return {
    px,
    /** Rows until `until`, at least one; true once both passes are done. */
    step(until) {
      while (pass < 2) {
        if (pass === 0) heights(row);
        else light(row);
        if (++row === h) {
          row = 0;
          pass++;
        }
        if (until !== Infinity && performance.now() >= until) break;
      }
      return pass >= 2;
    }
  };
}
var brushes = /* @__PURE__ */ new Map();
function brush(key, side, stops) {
  const had = brushes.get(key);
  if (had) return had;
  const image = document.createElement("canvas");
  image.width = side;
  image.height = side;
  const g = image.getContext("2d");
  if (g) {
    const r = side / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    for (const [at, colour] of stops) grad.addColorStop(at, colour);
    g.fillStyle = grad;
    g.fillRect(0, 0, side, side);
  }
  const made = { image, pattern: g?.createPattern(image, "no-repeat") ?? null };
  brushes.set(key, made);
  return made;
}
function dabEllipse(ctx, b, x, y, rx, ry) {
  if (!b.pattern) return;
  const r = Math.max(rx, ry);
  const s = 2 * r / b.image.width;
  b.pattern.setTransform({ a: s, b: 0, c: 0, d: s, e: x - r, f: y - r });
  ctx.fillStyle = b.pattern;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}
var BITE_PX = 128;
function eraseAt(ctx, x, y, rx, ry, strength, rng2, crisp = false) {
  if (rx <= 0 || ry <= 0 || strength <= 0) return;
  const b = crisp ? brush("bite-crisp", BITE_PX, [[0, "#000"], [0.55, "#000"], [0.86, "rgba(0,0,0,0.55)"], [1, "rgba(0,0,0,0)"]]) : brush("bite", BITE_PX, [[0, "#000"], [0.35, "rgba(0,0,0,0.82)"], [0.7, "rgba(0,0,0,0.32)"], [1, "rgba(0,0,0,0)"]]);
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.globalAlpha = Math.min(1, strength);
  for (let i = 0; i < 3; i++) {
    const jx = x + (rng2() - 0.5) * rx * 0.55;
    const jy = y + (rng2() - 0.5) * ry * 0.55;
    const kx = rx * rand(rng2, 0.6, 0.92);
    const ky = ry * rand(rng2, 0.6, 0.92);
    dabEllipse(ctx, b, jx, jy, kx, ky);
  }
  ctx.restore();
}
var ROBOT_SIZE = 60;
var ROBOT_BOX = ROBOT_SIZE + 16;

// web/assets/js/ui/clean/grime-lab.ts
var RANGE = {
  azimuth: [-180, 180, 1],
  elevation: [5, 90, 0.5],
  ambient: [0, 1, 0.01],
  scale: [0.25, 4, 0.05],
  relief: [0, 0.06, 1e-3],
  gloss: [0, 1.5, 0.05],
  shine: [1, 120, 1],
  tone: [0.4, 1.6, 0.01],
  sat: [0, 2, 0.01],
  warmth: [-2, 2, 0.05],
  flakes: [3, 30, 0.5],
  age: [0, 0.8, 0.01],
  pits: [0, 1, 0.01],
  wrinkles: [0, 1, 0.01],
  blisters: [0, 1, 0.01],
  blots: [1, 10, 1],
  size: [0.05, 0.6, 0.01],
  tide: [0, 1, 0.01],
  fray: [0, 0.3, 5e-3],
  wipe: [0, 1, 0.01],
  grain: [10, 160, 1],
  cover: [0.2, 1, 0.01],
  bands: [0, 8, 1],
  poster: [0, 8, 1],
  patch: [0, 1, 0.01],
  edge: [0, 1, 0.01],
  rings: [1, 14, 0.5],
  crust: [0, 1, 0.01],
  film: [0, 1, 0.01],
  stain: [0, 1, 0.01],
  spots: [0, 1, 0.01],
  scaly: [0, 1, 0.01],
  runs: [0, 1.5, 0.01],
  spread: [0.3, 1.3, 0.01],
  drift: [0, 1.5, 0.01],
  scour: [0, 1.5, 0.01],
  ripples: [0, 40, 0.5],
  grit: [0, 1, 0.01],
  thin: [0, 1, 0.01],
  body: [0, 1, 0.01],
  drops: [0, 12, 1],
  rim: [0, 1, 0.01],
  streaks: [1, 12, 0.5],
  fine: [0, 1, 0.01]
};
var VARY_RANGE = {
  scale: [0, 2, 0.05],
  tone: [0, 0.6, 0.01],
  warmth: [0, 2, 0.05],
  cover: [0, 0.6, 0.01],
  patch: [0, 0.6, 0.01]
};
var ALL = {
  cover: [0.2, 1, 0.01],
  patch: [0, 1, 0.01],
  edge: [0, 1, 0.01],
  bands: [0, 8, 1],
  poster: [0, 8, 1],
  sat: [0, 2, 0.01],
  tone: [0.4, 1.6, 0.01]
};
var STORE = "mbrd.lab.grime";
var DEFAULTS = JSON.parse(JSON.stringify(LOOK));
var DEFAULT_DEAL = [...GRIMES];
var VARIED = { scale: 0.7, tone: 0.12, warmth: 0.3, cover: 0.1, patch: 0.25 };
var DEAL_REDESIGN = ["lime", "lime", "dirt", "dirt", "rust", "rust", "tar", "film"];
var PRESETS = {
  today: { look: {}, deal: DEFAULT_DEAL },
  illustrated: {
    look: {
      light: { ambient: 0.55 },
      vary: { ...VARIED, scale: 0.6, cover: 0.08, patch: 0.2 },
      lime: { patch: 0.2, edge: 0.3, bands: 3, poster: 5, relief: 8e-3, sat: 1.25, cover: 0.9 },
      dirt: { bands: 3, poster: 5, relief: 0.01, sat: 1.25, cover: 0.92 },
      rust: { patch: 0.2, edge: 0.2, bands: 3, poster: 5, relief: 0.014, sat: 1.2, scale: 1.5 },
      tar: { bands: 3, poster: 5, relief: 0.02, cover: 0.92, scale: 1.5, gloss: 1, shine: 30 },
      coffee: { body: 0.35, tide: 0.95, bands: 3, poster: 5, sat: 1.25, cover: 0.92, drops: 3 },
      ink: { fray: 0.1, bands: 3, poster: 5, cover: 0.95, drops: 6, rim: 0.6 },
      film: { fine: 0.8, streaks: 4, edge: 0.3, patch: 0.3, cover: 0.8, bands: 3, poster: 5 }
    },
    deal: DEAL_REDESIGN
  },
  heavy: {
    look: {
      light: { ambient: 0.16, elevation: 32 },
      vary: { ...VARIED, cover: 0.08 },
      lime: { patch: 0.35, edge: 0.5, relief: 0.024, cover: 0.9, crust: 0.6 },
      dirt: { relief: 0.026, cover: 0.93, drift: 0.9, grit: 0.6 },
      rust: { patch: 0.3, edge: 0.4, pits: 0.18, scaly: 0.85, spread: 0.82, relief: 0.04, sat: 0.9 },
      tar: { patch: 0.15, relief: 0.038, cover: 0.92 },
      coffee: { body: 0.4, tide: 0.9, relief: 8e-3, drops: 3 },
      ink: { fray: 0.15, relief: 0.011, drops: 6, rim: 0.6 },
      film: { fine: 0.7, streaks: 4, edge: 0.45, patch: 0.35, cover: 0.8, relief: 9e-3 }
    },
    deal: DEAL_REDESIGN
  }
};
var table = () => LOOK;
var cards = [];
var queue = /* @__PURE__ */ new Set();
var view = { mode: "compare", perRow: 6, shape: "mixed", rich: true, show: new Set(GRIME_KINDS) };
var LOOK_BLURB = {
  today: "What the game draws now - the varied look: natural materials, every card its own.",
  illustrated: "Flat painted patches and stepped shading, like a poster.",
  heavy: "Deep relief under a low light: gritty rust, wet glossy tar."
};
var DEALT = 12;
var seedBase = 1;
var frame = 0;
var el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== void 0) node.textContent = text;
  return node;
};
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = Math.imul(s ^ s >>> 15, 2246822507) + 2654435769 >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}
var SHAPES = {
  square: [[190, 190]],
  landscape: [[240, 160]],
  portrait: [[160, 230]],
  mixed: [[240, 160], [190, 190], [160, 230], [260, 150], [200, 250]]
};
function paintFace(ctx, w, h, face, seed) {
  const r = rng(seed * 7 + 3);
  if (face === 0) {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#9cc4dc");
    sky.addColorStop(1, "#f1dcb8");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#e9b04f";
    ctx.beginPath();
    ctx.arc(w * (0.2 + r() * 0.6), h * 0.36, h * 0.1, 0, Math.PI * 2);
    ctx.fill();
    for (const [c, y0] of [["#6f8f5a", 0.62], ["#4d6a45", 0.74]]) {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 8) ctx.lineTo(x, h * y0 + Math.sin(x / w * 6 + r() * 0.4 + y0 * 9) * h * 0.06);
      ctx.lineTo(w, h);
      ctx.fill();
    }
  } else if (face === 1) {
    ctx.fillStyle = "#fbf1b8";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#3b3326";
    ctx.font = "600 15px Georgia, serif";
    ctx.fillText("Things to fix", 14, 26);
    ctx.fillStyle = "#6d6250";
    for (let y = 46; y < h - 10; y += 16) ctx.fillRect(14, y, (w - 28) * (0.5 + r() * 0.5), 2);
  } else if (face === 2) {
    ctx.fillStyle = "#fbfaf6";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#b9b2a4";
    ctx.font = "12px ui-monospace, monospace";
    ctx.fillText("plain card", 12, 22);
  } else {
    const g = ctx.createRadialGradient(w * 0.5, h * 0.45, 4, w * 0.5, h * 0.5, Math.max(w, h) * 0.7);
    g.addColorStop(0, "#c2573a");
    g.addColorStop(0.5, "#4a2c3a");
    g.addColorStop(1, "#161219");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
}
function repaint(which) {
  for (const c of cards) if (which(c)) queue.add(c);
  if (!frame) frame = requestAnimationFrame(drain);
}
function drain() {
  frame = 0;
  const until = performance.now() + 14;
  for (const c of queue) {
    queue.delete(c);
    if (!c.dealt && !c.look && !view.show.has(c.kind)) continue;
    const ctx = c.crust.getContext("2d");
    if (!ctx) continue;
    ctx.clearRect(0, 0, c.w, c.h);
    under(c.look, () => paintField(ctx, { kind: c.kind, seed: c.seed }, c.w, c.h, view.rich));
    c.washed = false;
    if (performance.now() > until) break;
  }
  if (queue.size) frame = requestAnimationFrame(drain);
}
function under(name, fn) {
  const preset = name ? PRESETS[name] : null;
  if (!preset) {
    fn();
    return;
  }
  const look = table();
  const kept = JSON.parse(JSON.stringify(look));
  for (const [section, knobs] of Object.entries(DEFAULTS))
    for (const [key, was] of Object.entries(knobs)) look[section][key] = preset.look[section]?.[key] ?? was;
  try {
    fn();
  } finally {
    for (const [section, knobs] of Object.entries(kept))
      for (const [key, value] of Object.entries(knobs)) look[section][key] = value;
  }
}
function wash(card, e) {
  const box = card.crust.getBoundingClientRect();
  const ctx = card.crust.getContext("2d");
  if (!ctx) return;
  const x = (e.clientX - box.left) * (card.w / box.width);
  const y = (e.clientY - box.top) * (card.h / box.height);
  eraseAt(ctx, x, y, 22, 22, 0.35, Math.random);
  card.washed = true;
}
function makeCard(kind, seed, w, h, face, dealt, look = null) {
  const card = { kind, seed, w, h, face, crust: el("canvas", "crust"), washed: false, dealt, look };
  const host = el("div", "card");
  host.dataset.seed = String(seed);
  host.title = `${kind}, seed ${seed} - drag to wash`;
  const canvas = el("canvas", "face");
  canvas.width = card.crust.width = w;
  canvas.height = card.crust.height = h;
  host.style.width = w + "px";
  host.style.height = h + "px";
  const fctx = canvas.getContext("2d");
  if (fctx) paintFace(fctx, w, h, face, seed);
  card.crust.addEventListener("pointerdown", (e) => {
    card.crust.setPointerCapture(e.pointerId);
    wash(card, e);
  });
  card.crust.addEventListener("pointermove", (e) => {
    if (card.crust.hasPointerCapture(e.pointerId)) wash(card, e);
  });
  host.append(canvas, card.crust);
  if (dealt || look) host.append(el("span", "tag", kind));
  cards.push(card);
  return host;
}
function buildDealt(board) {
  const row = el("section", "row dealt");
  const counts = GRIME_KINDS.map((k) => `${k} ${GRIMES.filter((g) => g === k).length}`).filter((s) => !s.endsWith(" 0")).join(" / ");
  row.append(el("h3", "", `a board of pictures, as dealt - ${counts}`));
  const strip = el("div", "strip");
  const r = rng(seedBase * 31 + 5);
  const shapes = SHAPES.mixed;
  for (let i = 0; i < DEALT; i++) {
    const kind = GRIMES[Math.floor(r() * GRIMES.length)];
    const grime = GRIME_KINDS.find((g) => g === kind);
    if (!grime) continue;
    const [w, h] = shapes[i % shapes.length];
    const seed = seedBase * 104723 + i * 2654435761 >>> 0;
    strip.append(makeCard(grime, seed, Math.round(w * 0.8), Math.round(h * 0.8), i % 2 ? 3 : 0, true));
  }
  row.append(strip);
  board.append(row);
}
var COMPARE_DEALT = 6;
function buildCompare(board) {
  const grid = el("div", "compare");
  const shapes = SHAPES.mixed;
  const small = (n) => Math.round(n * 0.62);
  for (const [name, preset] of Object.entries(PRESETS)) {
    const col = el("section", "look");
    const head = el("div", "look-head");
    const tune = el("button", "", "tune this");
    tune.type = "button";
    tune.title = "Open this look on the sliders";
    tune.addEventListener("click", () => {
      setMode("tune");
      applyPreset(name);
    });
    head.append(el("h3", "", name), tune);
    col.append(head, el("p", "blurb", LOOK_BLURB[name] ?? ""));
    col.append(el("h4", "", "a board of pictures"));
    const dealt = el("div", "strip");
    const r = rng(seedBase * 31 + 5);
    for (let i = 0; i < COMPARE_DEALT; i++) {
      const pick = preset.deal[Math.floor(r() * preset.deal.length)];
      const grime = GRIME_KINDS.find((g) => g === pick);
      if (!grime) continue;
      const [w, h] = shapes[i % shapes.length];
      const seed = seedBase * 104723 + i * 2654435761 >>> 0;
      dealt.append(makeCard(grime, seed, small(w), small(h), i % 2 ? 3 : 0, false, name));
    }
    col.append(dealt, el("h4", "", "every grime"));
    const every = el("div", "strip");
    GRIME_KINDS.forEach((kind, k) => {
      const [w, h] = shapes[k % shapes.length];
      const seed = seedBase * 7919 + k * 104729 >>> 0;
      every.append(makeCard(kind, seed, small(w), small(h), k % 4, false, name));
    });
    col.append(every);
    grid.append(col);
  }
  board.append(grid);
}
function setMode(mode) {
  view.mode = mode;
  document.body.classList.toggle("is-compare", mode === "compare");
  for (const b of document.querySelectorAll("#modes button")) {
    toggle(b, b.dataset.mode === mode);
  }
  buildBoard();
}
function buildBoard() {
  const board = document.getElementById("board");
  if (!board) return;
  board.replaceChildren();
  cards.length = 0;
  queue.clear();
  if (view.mode === "compare") {
    buildCompare(board);
    repaint(() => true);
    return;
  }
  buildDealt(board);
  const shapes = SHAPES[view.shape] ?? SHAPES.mixed;
  for (const kind of GRIME_KINDS) {
    const row = el("section", "row");
    row.dataset.kind = kind;
    row.hidden = !view.show.has(kind);
    row.append(el("h3", "", kind));
    const strip = el("div", "strip");
    for (let i = 0; i < view.perRow; i++) {
      const [w, h] = shapes[i % shapes.length];
      const seed = seedBase * 7919 + GRIME_KINDS.indexOf(kind) * 104729 + i * 15485863 >>> 0;
      strip.append(makeCard(kind, seed, w, h, i % 4, false));
    }
    row.append(strip);
    board.append(row);
  }
  repaint(() => true);
}
function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ look: LOOK, deal: GRIMES }));
  } catch {
  }
}
function restore() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(STORE) ?? "null");
  } catch {
    return;
  }
  if (!saved || typeof saved !== "object") return;
  const look = "look" in saved ? saved.look : saved;
  if (look && typeof look === "object") {
    const into = table();
    for (const [section, knobs] of Object.entries(look)) {
      const knobsInto = into[section];
      if (!knobsInto || !knobs || typeof knobs !== "object") continue;
      for (const [key, value] of Object.entries(knobs)) {
        if (key in knobsInto && typeof value === "number" && Number.isFinite(value)) knobsInto[key] = value;
      }
    }
  }
  if ("deal" in saved && Array.isArray(saved.deal)) {
    const deal = saved.deal.filter((k) => GRIME_KINDS.some((g) => g === k));
    if (deal.length) GRIMES.splice(0, GRIMES.length, ...deal);
  }
}
var decimals = (step) => (String(step).split(".")[1] ?? "").length;
function field(knob) {
  const [min, max, step] = knob.range;
  const row = el("label", "field");
  const input = el("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(knob.get());
  const out = el("span", "value");
  const paint = () => {
    const v = knob.get();
    out.textContent = v.toFixed(decimals(step));
    row.classList.toggle("is-moved", v !== knob.was);
  };
  input.addEventListener("input", () => {
    knob.set(Number(input.value));
    paint();
    save();
    printOut();
    if (knob.repaints) repaint(knob.repaints);
    else buildBoard();
  });
  row.addEventListener("dblclick", () => {
    input.value = String(knob.was);
    input.dispatchEvent(new Event("input"));
  });
  paint();
  row.append(el("span", "name", knob.name), input, out);
  return row;
}
function lookKnob(section, key, range) {
  const look = table();
  return {
    name: key,
    range,
    was: DEFAULTS[section][key],
    get: () => look[section][key],
    set: (v) => {
      look[section][key] = v;
    },
    repaints: (c) => section === "light" || section === "vary" || c.kind === section
  };
}
function allKnob(key, range) {
  const look = table();
  return {
    name: key,
    range,
    was: DEFAULTS.lime[key],
    get: () => look.lime[key],
    set: (v) => {
      for (const g of GRIME_KINDS) look[g][key] = v;
    },
    repaints: () => true
  };
}
function dealKnob(kind) {
  const count = () => GRIMES.filter((g) => g === kind).length;
  return {
    name: kind,
    range: [0, 6, 1],
    was: DEFAULT_DEAL.filter((g) => g === kind).length,
    get: count,
    set: (v) => {
      const rest = GRIMES.filter((g) => g !== kind);
      if (!rest.length && v < 1) v = 1;
      GRIMES.splice(0, GRIMES.length, ...rest, ...Array.from({ length: v }, () => kind));
      const at = (k) => GRIME_KINDS.findIndex((g) => g === k);
      GRIMES.sort((a, b) => at(a) - at(b));
    },
    repaints: null
  };
}
var BLURB = {
  all: "Sets the knob on every grime at once. The per-grime sliders below follow.",
  deal: "What a picture card is dealt, as weights. The top row of the bench is dealt from this.",
  light: "One light for every grime. Azimuth: 0 is from the right, -90 from the top.",
  vary: "How far each card strays from the others of its kind. 0 makes every card of a kind the same.",
  lime: "Hard-water limescale: tide marks, dried drop spots, chalky crust where it pooled, a thin milky film between.",
  dirt: "Soil the wind laid over the card: drifts, streaks it scoured thin, ripples across the wind, grit. Each card has its own wind.",
  rust: "Always opaque (cover does nothing here; thin places turn orange instead). Spread = how far across the card it has got from the side or corner it started at (the bare part counts as clean). Scaly = how much lifts in curling flakes, runs = streaks down. Age: lower is more orange, higher is more old brown.",
  tar: "A wet skin. Gloss and shine are most of it.",
  coffee: "A spill of rings. Tide = how much of the darkness is the ring at the edge.",
  ink: "Blots with frayed edges.",
  film: "A dust film with finger wipes through it."
};
function buildSliders() {
  const host = document.getElementById("knobs");
  if (!host) return;
  host.replaceChildren();
  const look = table();
  const section = (name, open, knobs) => {
    const box = el("details", "section");
    box.open = open;
    box.append(el("summary", "", name), el("p", "blurb", BLURB[name] ?? ""));
    for (const knob of knobs) box.append(field(knob));
    host.append(box);
  };
  section("all", true, Object.entries(ALL).map(([key, range]) => allKnob(key, range)));
  section("deal", true, GRIME_KINDS.map(dealKnob));
  for (const name of Object.keys(look)) {
    const knobs = [];
    for (const key of Object.keys(look[name])) {
      const range = name === "vary" ? VARY_RANGE[key] : RANGE[key];
      if (range) knobs.push(lookKnob(name, key, range));
    }
    section(name, name === "vary", knobs);
  }
}
function printOut() {
  const out = document.getElementById("out");
  if (!out) return;
  const look = table();
  const lines = [];
  for (const [section, knobs] of Object.entries(look)) {
    for (const [key, value] of Object.entries(knobs)) {
      const was = DEFAULTS[section][key];
      if (value !== was) lines.push(`LOOK.${section}.${key}: ${was} -> ${value}`);
    }
  }
  if (GRIMES.join() !== DEFAULT_DEAL.join()) {
    lines.push(`GRIMES: [${DEFAULT_DEAL.join(", ")}] -> [${GRIMES.join(", ")}]`);
  }
  out.textContent = lines.length ? lines.join("\n") : "nothing moved yet";
}
function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  const look = table();
  for (const [section, knobs] of Object.entries(DEFAULTS))
    for (const [key, was] of Object.entries(knobs)) look[section][key] = preset.look[section]?.[key] ?? was;
  const deal = preset.deal.flatMap((k) => GRIME_KINDS.filter((g) => g === k));
  GRIMES.splice(0, GRIMES.length, ...deal);
  save();
  buildSliders();
  printOut();
  buildBoard();
}
function toggle(button, on) {
  button.setAttribute("aria-pressed", String(on));
}
function buildControls() {
  const kinds = document.getElementById("kinds");
  if (kinds) {
    kinds.replaceChildren();
    for (const kind of GRIME_KINDS) {
      const b = el("button", "", kind);
      b.type = "button";
      toggle(b, view.show.has(kind));
      b.addEventListener("click", (e) => {
        if (e.shiftKey) view.show = /* @__PURE__ */ new Set([kind]);
        else if (view.show.has(kind)) view.show.delete(kind);
        else view.show.add(kind);
        for (const other of kinds.querySelectorAll("button")) {
          toggle(other, view.show.has(other.textContent ?? ""));
        }
        for (const row of document.querySelectorAll("#board .row")) {
          row.hidden = !view.show.has(row.dataset.kind ?? "");
        }
        repaint((c) => c.kind === kind);
      });
      kinds.append(b);
    }
  }
  const on = (id, type, fn) => document.getElementById(id)?.addEventListener(type, fn);
  const presets = document.getElementById("presets");
  if (presets) {
    presets.replaceChildren();
    for (const name of Object.keys(PRESETS)) {
      const b = el("button", "", name);
      b.type = "button";
      b.addEventListener("click", () => applyPreset(name));
      presets.append(b);
    }
  }
  for (const b of document.querySelectorAll("#modes button")) {
    b.addEventListener("click", () => setMode(b.dataset.mode === "tune" ? "tune" : "compare"));
  }
  on("reseed", "click", () => {
    seedBase++;
    buildBoard();
  });
  on("reseed-compare", "click", () => {
    seedBase++;
    buildBoard();
  });
  on("unwash-compare", "click", () => repaint((c) => c.washed));
  on("unwash", "click", () => repaint((c) => c.washed));
  on("reset", "click", () => applyPreset("today"));
  on("copy", "click", () => {
    const text = document.getElementById("out")?.textContent ?? "";
    navigator.clipboard?.writeText(text).catch(() => {
    });
  });
  on("per-row", "input", (e) => {
    if (e.target instanceof HTMLInputElement) view.perRow = Number(e.target.value);
    buildBoard();
  });
  on("shape", "change", (e) => {
    if (e.target instanceof HTMLSelectElement) view.shape = e.target.value;
    buildBoard();
  });
  on("rich", "change", (e) => {
    if (e.target instanceof HTMLInputElement) view.rich = e.target.checked;
    repaint(() => true);
  });
}
function initGrimeLab() {
  restore();
  buildControls();
  buildSliders();
  printOut();
  setMode("compare");
}
export {
  initGrimeLab
};
