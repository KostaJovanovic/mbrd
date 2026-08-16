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

// web/assets/js/color.ts
var cbrt = Math.cbrt;
function toLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function toSrgb(c) {
  const v = c <= 31308e-7 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}
function oklch(r, g, b) {
  const R = toLinear(r), G = toLinear(g), B = toLinear(b);
  const l = cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, Bb);
  let h = Math.atan2(Bb, A) * 180 / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
}
function oklchToLinear(L, C, h) {
  const rad = h * Math.PI / 180;
  const A = Math.cos(rad) * C, B = Math.sin(rad) * C;
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ];
}
function inGamut([r, g, b]) {
  const lo = -1e-4, hi = 1 + 1e-4;
  return r >= lo && r <= hi && g >= lo && g <= hi && b >= lo && b <= hi;
}
function hex(L, C, h) {
  let lo = 0, hi = C;
  if (!inGamut(oklchToLinear(L, C, h))) {
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear(L, mid, h))) lo = mid;
      else hi = mid;
    }
  } else lo = C;
  const [r, g, b] = oklchToLinear(L, lo, h);
  return "#" + [r, g, b].map((v) => toSrgb(v).toString(16).padStart(2, "0")).join("");
}
function luminance(r, g, b) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}
function parseHex(s) {
  return [
    parseInt(s.slice(1, 3), 16),
    parseInt(s.slice(3, 5), 16),
    parseInt(s.slice(5, 7), 16)
  ];
}
function contrast(a, b) {
  const x = luminance(...parseHex(a)), y = luminance(...parseHex(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function mixHex(a, b, t) {
  const [ar, ag, ab] = parseHex(a), [br, bg, bb] = parseHex(b);
  const m = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return "#" + m(ar, br) + m(ag, bg) + m(ab, bb);
}

// web/assets/js/layout-settings.ts
var PALETTE_TOKENS = [
  "--paper",
  "--paper-2",
  "--paper-3",
  "--paper-card",
  "--ink",
  "--ink-2",
  "--ink-3",
  "--rule",
  "--rule-2",
  "--accent",
  "--accent-warm",
  "--accent-deep",
  "--leafy",
  "--accent-fg"
];
var TYPOGRAPHY_TOKENS = ["--font-display", "--font-body"];
var paletteToken = /* @__PURE__ */ new Set([...PALETTE_TOKENS, ...TYPOGRAPHY_TOKENS]);

// web/assets/js/ui/pigments.ts
var apart = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};
var BINS = 72;
var NEUTRAL_C = 0.045;
var NEUTRAL_FAINT = 0.018;
var MIN_L = 0.12;
var MAX_L = 0.95;
var COLOUR_MIN = 5e-3;
var COLOUR_FULL = 0.02;
var MIN_SEP = 40;
var MIN_SHARE = 0.15;
var MAX_HUES = 3;
function huesOf(chunks) {
  return peaksOf(readBoard(chunks)).map((p) => p.h);
}
function standings(mass, peaks) {
  let total = 0;
  for (const v of mass) total += v;
  if (!total) return peaks.map(() => 0);
  return peaks.map(({ i }) => {
    let m = 0;
    for (let k = -2; k <= 2; k++) m += mass[(i + k + BINS) % BINS];
    return m / total;
  });
}
function readBoard(chunks) {
  const strict = census(chunks, NEUTRAL_C);
  return strict.voters ? strict : census(chunks, NEUTRAL_FAINT);
}
function census(chunks, floor) {
  const votes = new Float64Array(BINS);
  const mass = new Float64Array(BINS);
  const litSum = new Float64Array(BINS);
  const chrSum = new Float64Array(BINS);
  const toneWeight = new Float64Array(BINS);
  let voters = 0, vividSum = 0, keySum = 0, lit = 0;
  for (const px of chunks) {
    const one = new Float64Array(BINS);
    const oneL = new Float64Array(BINS);
    const oneC = new Float64Array(BINS);
    let weight = 0, coloured = 0, lSum = 0, opaque = 0;
    for (let i = 0; i + 3 < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      const { L, C, h } = oklch(px[i], px[i + 1], px[i + 2]);
      lSum += L;
      opaque++;
      if (L < MIN_L || L > MAX_L || C < floor) continue;
      const bin = Math.floor(h / 360 * BINS) % BINS;
      one[bin] += C;
      oneL[bin] += C * L;
      oneC[bin] += C * C;
      weight += C;
      coloured++;
    }
    if (opaque) {
      keySum += lSum / opaque;
      lit++;
    }
    if (!weight) continue;
    const trust = clamp((coloured / opaque - COLOUR_MIN) / (COLOUR_FULL - COLOUR_MIN), 0, 1);
    if (!trust) continue;
    for (let i = 0; i < BINS; i++) {
      votes[i] += trust * one[i] / weight;
      mass[i] += trust * one[i] / opaque;
      litSum[i] += trust * oneL[i];
      chrSum[i] += trust * oneC[i];
      toneWeight[i] += trust * one[i];
    }
    vividSum += trust * (weight / coloured);
    voters += trust;
  }
  return {
    votes,
    mass,
    tone: { litSum, chrSum, toneWeight },
    voters,
    vivid: voters ? vividSum / voters : 0,
    // No pixels at all is the reference picture rather than a black one: with
    // nothing to say, the tables stand as measured.
    key: lit ? keySum / lit : REF_KEY
  };
}
function toneAt({ litSum, chrSum, toneWeight }, i) {
  let l = 0, c = 0, w = 0;
  for (let k = -2; k <= 2; k++) {
    const j = (i + k + BINS) % BINS;
    l += litSum[j];
    c += chrSum[j];
    w += toneWeight[j];
  }
  return w ? { L: l / w, C: c / w } : null;
}
function peaksOf({ votes, mass, tone, voters }) {
  if (!voters) return [];
  const smooth = new Float64Array(BINS);
  const K = [1, 2, 3, 2, 1], KSUM = 9;
  for (let i = 0; i < BINS; i++) {
    let sum = 0;
    for (let k = -2; k <= 2; k++) sum += K[k + 2] * votes[(i + k + BINS) % BINS];
    smooth[i] = sum / KSUM;
  }
  const peaks = [];
  for (let i = 0; i < BINS; i++) {
    const prev = smooth[(i - 1 + BINS) % BINS], next = smooth[(i + 1) % BINS];
    if (smooth[i] > 0 && smooth[i] >= prev && smooth[i] > next) {
      peaks.push({ i, h: (i + 0.5) * 360 / BINS, w: smooth[i] });
    }
  }
  if (!peaks.length) {
    let best = 0;
    for (let i = 1; i < BINS; i++) if (smooth[i] > smooth[best]) best = i;
    if (smooth[best] <= 0) return [];
    peaks.push({ i: best, h: (best + 0.5) * 360 / BINS, w: smooth[best] });
  }
  peaks.sort((a, b) => b.w - a.w);
  const standing = standings(mass, peaks);
  const sheet = { ...peaks[0], standing: standing[0] };
  const floor = sheet.w * MIN_SHARE;
  const facing = (p) => 1 + FACING_BONUS * apart(p.h, sheet.h) / 180;
  const rest = peaks.map((p, n) => ({ ...p, standing: standing[n] })).slice(1).filter((p) => p.w >= floor).sort((a, b) => b.standing * facing(b) - a.standing * facing(a) || b.w - a.w);
  const out = [sheet];
  for (const p of rest) {
    if (out.length >= MAX_HUES) break;
    if (out.every((q) => apart(p.h, q.h) >= MIN_SEP)) out.push(p);
  }
  return out.map((p) => ({ h: p.h, standing: p.standing, tone: toneAt(tone, p.i) }));
}
var SHEET = {
  "--paper": { L: 0.98, C: 7e-3 },
  "--paper-2": { L: 0.952, C: 0.01 },
  "--paper-3": { L: 0.914, C: 0.015 },
  "--paper-card": { L: 0.993, C: 3e-3 },
  "--ink": { L: 0.268, C: 0.026 },
  "--ink-2": { L: 0.437, C: 0.033 },
  "--ink-3": { L: 0.611, C: 0.035 },
  "--rule": { L: 0.878, C: 0.014 },
  "--rule-2": { L: 0.776, C: 0.021 }
};
var PIGMENT = {
  "--accent": { L: 0.548, C: 0.147 },
  "--accent-warm": { L: 0.73, C: 0.158 },
  "--accent-deep": { L: 0.415, C: 0.114 }
};
var WEARABLE_L = { min: 0.36, max: 0.78 };
var WEARABLE_C_MIN = 0.055;
function wearable(tone) {
  if (!tone) return null;
  return {
    L: clamp(tone.L, WEARABLE_L.min, WEARABLE_L.max),
    C: Math.max(tone.C, WEARABLE_C_MIN)
  };
}
var DEEP_DROP = PIGMENT["--accent"].L - PIGMENT["--accent-deep"].L;
var DEEP_TEMPER = PIGMENT["--accent-deep"].C / PIGMENT["--accent"].C;
var deepen = (ink) => ({ L: Math.max(0, ink.L - DEEP_DROP), C: ink.C * DEEP_TEMPER });
var WARM_ANCHOR = 75;
var WARM_TURN = 20;
var LEAFY_SOLO_TURN = 85;
var LEAFY = { L: 0.572, C: 0.111 };
var ANALOGOUS = 60;
var LEAFY_DROP = 0.07;
var FACING_BONUS = 1;
function rolesFor(hues) {
  const [sheet, ...rest] = hues.map((p) => typeof p === "number" ? { h: p, standing: 0, tone: null } : p);
  const score = (p) => p.standing * (1 + FACING_BONUS * apart(p.h, sheet.h) / 180);
  const order = [...rest].sort((a, b) => score(b) - score(a) || apart(b.h, sheet.h) - apart(a.h, sheet.h));
  const ranked = order.map((p) => p.h);
  const tone = {
    sheet: sheet.tone || null,
    accent: order.length ? order[0].tone || null : sheet.tone || null,
    leafy: order.length > 1 ? order[1].tone || null : null
  };
  return {
    tone,
    sheet: sheet.h,
    accent: ranked.length ? ranked[0] : sheet.h,
    // A third photographed hue if the board has one. With two, the wash sits
    // *between* them rather than at a turn of its own: on a board of rose and
    // magenta, +85 degrees is an olive that nothing on the board is, and the
    // ornament is no better a place to invent a colour than the button was.
    // Only a board with a single hue has nothing to sit between, and there the
    // turn stands - a wash that is its own accent is not a second voice at all.
    leafy: ranked.length > 1 ? ranked[1] : ranked.length ? midHue(sheet.h, ranked[0]) : (sheet.h + LEAFY_SOLO_TURN) % 360,
    // --accent-warm has no photograph left to take by this point - the vote
    // yields three hues at the most and the other two are spoken for - so it
    // stays a relative of the sheet it washes.
    warm: warmer(sheet.h)
  };
}
var REF_VIVID = 0.065;
var REF_KEY = 0.62;
var VIVID_FLOOR = 0.4;
var VIVID_CEIL = 1.35;
var KEY_GAIN = 0.3;
var KEY_DOWN = 0.085;
var KEY_UP = 0.01;
var PAPERS = ["--paper", "--paper-2", "--paper-3", "--paper-card", "--rule", "--rule-2"];
var PLAIN_PAPER = 0.985;
var PLAIN_TINT = 0.55;
function temper(traits) {
  const scale = traits?.vivid != null ? clamp(Math.sqrt(traits.vivid / REF_VIVID), VIVID_FLOOR, VIVID_CEIL) : 1;
  const key = traits?.key != null ? clamp((traits.key - REF_KEY) * KEY_GAIN, -KEY_DOWN, KEY_UP) : 0;
  const shift = traits?.plain ? PLAIN_PAPER - SHEET["--paper"].L : key;
  const sheetScale = traits?.plain ? scale * PLAIN_TINT : scale;
  const sheet = {}, pigment = {};
  for (const [key2, { L, C }] of Object.entries(SHEET)) {
    sheet[key2] = {
      L: PAPERS.includes(key2) ? clamp(L + shift, 0, 1) : L,
      C: C * sheetScale
    };
  }
  for (const [key2, { L, C }] of Object.entries(PIGMENT)) pigment[key2] = { L, C: C * scale };
  return { sheet, pigment, leafy: { L: LEAFY.L, C: LEAFY.C * scale } };
}
var FLOOR = {
  "--ink": 7,
  "--ink-2": 4.5,
  "--ink-3": 2.2
};
var ACCENT_FLOOR = 4.5;
function paletteFor(hues, traits = null) {
  if (!hues.length) return null;
  return build(rolesFor(hues), traits);
}
function build(roles, traits) {
  const { sheet, pigment, leafy } = temper(traits);
  const vars = {};
  for (const [key, { L, C }] of Object.entries(sheet)) vars[key] = hex(L, C, roles.sheet);
  const accentInk = wearable(roles.tone?.accent) || pigment["--accent"];
  const leafyInk = wearable(roles.tone?.leafy) || leafy;
  for (const [key, { L, C }] of Object.entries(pigment)) {
    if (key === "--accent-warm") {
      vars[key] = hex(L, C, (roles.warm + 360) % 360);
      continue;
    }
    const ink = key === "--accent-deep" ? deepen(accentInk) : accentInk;
    vars[key] = hex(ink.L, ink.C, (roles.accent + 360) % 360);
  }
  const crowded = apart(roles.accent, roles.leafy) < ANALOGOUS;
  vars["--leafy"] = hex(crowded ? leafyInk.L - LEAFY_DROP : leafyInk.L, leafyInk.C, (roles.leafy + 360) % 360);
  return repair(vars, roles, sheet, accentInk);
}
function repair(vars, roles, sheet, accentInk) {
  const paper = vars["--paper"];
  for (const [key, floor] of Object.entries(FLOOR)) {
    const { C: C2 } = sheet[key];
    let { L: L2 } = sheet[key];
    for (let i = 0; i < 40 && contrast(vars[key], paper) < floor; i++) {
      L2 = Math.max(0, L2 - 0.02);
      vars[key] = hex(L2, C2, roles.sheet);
      if (L2 === 0) break;
    }
  }
  const light = mixHex(paper, "#ffffff", 0.55);
  const { C } = accentInk;
  let { L } = accentInk;
  for (let i = 0; i < 40 && contrast(vars["--accent"], light) < ACCENT_FLOOR; i++) {
    L = Math.max(0, L - 0.02);
    vars["--accent"] = hex(L, C, roles.accent);
    if (L === 0) break;
  }
  vars["--accent-fg"] = light;
  if (contrast(vars["--accent"], light) < ACCENT_FLOOR) {
    vars["--accent"] = hex(accentInk.L, accentInk.C, roles.accent);
    vars["--accent-fg"] = vars["--ink"];
  }
  return vars;
}
function paletteFromAccent(picked, { plain = false } = {}) {
  if (!/^#[0-9a-f]{6}$/i.test(picked)) return null;
  const chosen = picked.toLowerCase();
  const { C, h } = oklch(...parseHex(chosen));
  if (C < NEUTRAL_C) return null;
  const vars = build(
    { sheet: h, accent: h, leafy: (h + LEAFY_SOLO_TURN) % 360, warm: warmer(h) },
    // The axis applies to a colour chosen by hand exactly as it does to one
    // read off the photographs: the sheet a pick brings with it is still the
    // sheet, and at the plain end of the axis the sheet is white.
    { plain }
  );
  vars["--accent"] = chosen;
  const light = mixHex(vars["--paper"], "#ffffff", 0.55);
  vars["--accent-fg"] = contrast(chosen, light) >= contrast(chosen, vars["--ink"]) ? light : vars["--ink"];
  return vars;
}
function midHue(a, b) {
  const d = (b - a + 540) % 360 - 180;
  return (a + d / 2 + 360) % 360;
}
function warmer(h) {
  const d = (WARM_ANCHOR - h + 540) % 360 - 180;
  return h + Math.sign(d) * Math.min(Math.abs(d), WARM_TURN);
}
function extractPalette(chunks, { plain = false } = {}) {
  const board = readBoard(chunks);
  const hues = peaksOf(board);
  if (!hues.length) return null;
  return paletteFor(hues, { vivid: board.vivid, key: board.key, plain });
}
function dominantColors(chunk, n = 5) {
  const peaks = peaksOf(readBoard([chunk]));
  const out = [];
  for (const p of peaks) {
    if (out.length >= n) break;
    if (!p.tone) continue;
    out.push(hex(p.tone.L, p.tone.C, p.h));
  }
  return out;
}
var MAX_SOURCES = 24;
var SAMPLE = 48;
async function samplePixels(urls, limit = MAX_SOURCES) {
  const ctx = sampler();
  if (!ctx) return [];
  const asked = limit || MAX_SOURCES;
  const n = asked === Infinity ? urls.length : Math.max(1, Math.min(asked, MAX_SOURCES));
  const out = [];
  for (const url of urls.slice(0, n)) {
    try {
      const src = await frameFor(url);
      ctx.clearRect(0, 0, SAMPLE, SAMPLE);
      ctx.drawImage(src, 0, 0, SAMPLE, SAMPLE);
      out.push(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
      if ("close" in src) src.close();
    } catch {
    }
  }
  return out;
}
function sampler() {
  try {
    if (typeof OffscreenCanvas === "function") {
      const ctx = new OffscreenCanvas(SAMPLE, SAMPLE).getContext("2d", { willReadFrequently: true });
      if (ctx) return ctx;
    }
  } catch {
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SAMPLE;
  return canvas.getContext("2d", { willReadFrequently: true });
}
async function frameFor(url) {
  if (typeof createImageBitmap === "function" && typeof fetch === "function") {
    try {
      return await createImageBitmap(await (await fetch(url)).blob());
    } catch {
    }
  }
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}
export {
  MAX_SOURCES,
  PALETTE_TOKENS,
  contrast,
  dominantColors,
  extractPalette,
  hex,
  huesOf,
  oklch,
  paletteFor,
  paletteFromAccent,
  samplePixels
};
