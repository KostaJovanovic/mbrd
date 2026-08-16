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
function voiceFor(cue) {
  return CUES[cue];
}
function invert(recipe) {
  const last = Math.max(...recipe.layers.map((l) => l.offset ?? 0));
  return {
    ...recipe,
    layers: recipe.layers.map((layer) => {
      const moved = { ...layer, offset: last - (layer.offset ?? 0) };
      if (moved.kind !== "tone" || moved.glideTo === void 0) return moved;
      return { ...moved, frequency: moved.glideTo, glideTo: moved.frequency };
    })
  };
}
var INTEGRATION = 0.2;
var GRAIN = 1e-3;
var NYQUIST = 24e3;
function weighting(frequency) {
  const f2 = frequency * frequency;
  const response = 12194 ** 2 * f2 * f2 / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return 1.2589 * response;
}
function centreOf(layer) {
  if (layer.kind !== "tone") return layer.filterFrequency;
  return layer.glideTo === void 0 ? layer.frequency : Math.sqrt(layer.frequency * layer.glideTo);
}
function densityOf(layer) {
  if (layer.kind === "tone") return Math.SQRT1_2;
  const q = layer.filterQ ?? 1;
  const bandwidth = layer.filterType === "bandpass" ? Math.PI / 2 * (layer.filterFrequency / q) : 1.11 * layer.filterFrequency;
  return Math.sqrt(Math.min(1, bandwidth / NYQUIST) / 3);
}
function envelopeAt(layer, t) {
  const start = layer.offset ?? 0;
  if (t < start) return 0;
  const since = t - start;
  if (since < layer.attack) return layer.attack > 0 ? since / layer.attack : 1;
  const falling = since - layer.attack;
  if (falling > layer.decay) return 0;
  return 1e-3 ** (falling / layer.decay);
}
function loudnessOf(recipe) {
  if (!recipe.layers.length) return 0;
  const span = Math.max(...recipe.layers.map((l) => (l.offset ?? 0) + l.attack + l.decay));
  const amplitude = recipe.layers.map((l) => l.peak * densityOf(l) * weighting(centreOf(l)));
  const steps = Math.ceil((span + INTEGRATION) / GRAIN);
  const width = Math.round(INTEGRATION / GRAIN);
  const power = [];
  let running = 0;
  let loudest = 0;
  for (let i = 0; i < steps; i++) {
    let sum = 0;
    for (let j = 0; j < recipe.layers.length; j++) {
      const a = amplitude[j] * envelopeAt(recipe.layers[j], i * GRAIN);
      sum += a * a;
    }
    power.push(sum);
    running += sum;
    if (i >= width) running -= power[i - width];
    if (running > loudest) loudest = running;
  }
  return recipe.masterGain * Math.sqrt(loudest / width);
}
var TARGET_LOUDNESS = 36e-4;
var MAX_TRIM = 10 ** (10 / 20);
var trims = /* @__PURE__ */ new WeakMap();
function trimFor(recipe) {
  const cached = trims.get(recipe);
  if (cached !== void 0) return cached;
  const loudness = loudnessOf(recipe);
  const wanted = loudness > 0 ? TARGET_LOUDNESS / loudness : 1;
  const trim = Math.min(MAX_TRIM, Math.max(1 / MAX_TRIM, wanted));
  trims.set(recipe, trim);
  return trim;
}

// web/assets/js/prefs.ts
function readPref(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch {
    return fallback;
  }
}
var frozen = false;
function writePref(key, value) {
  if (frozen) return false;
  try {
    localStorage.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}

// web/assets/js/cuelume/engine.ts
var SOURCE_STOP_PADDING = 0.05;
var CLEANUP_MARGIN = 0.05;
var INAUDIBLE_GAIN = 1e-3;
var OUTPUT_GAIN = 4;
function renderTone(context, destination, layer, startTime, detune) {
  const oscillator = context.createOscillator();
  oscillator.type = layer.waveform;
  oscillator.frequency.setValueAtTime(layer.frequency, startTime);
  if (layer.detune || detune) oscillator.detune.value = (layer.detune ?? 0) + detune;
  if (layer.glideTo !== void 0) {
    const glideTime = layer.glideTime ?? layer.attack + layer.decay;
    oscillator.frequency.exponentialRampToValueAtTime(layer.glideTo, startTime + glideTime);
  }
  const gain = context.createGain();
  gain.gain.setValueAtTime(1e-4, startTime);
  gain.gain.exponentialRampToValueAtTime(layer.peak, startTime + layer.attack);
  gain.gain.exponentialRampToValueAtTime(1e-4, startTime + layer.attack + layer.decay);
  oscillator.connect(gain).connect(destination);
  oscillator.start(startTime);
  oscillator.stop(startTime + layer.attack + layer.decay + SOURCE_STOP_PADDING);
}
var NOISE_SECONDS = 2;
var noiseBuffer = null;
function getNoise(context) {
  if (noiseBuffer && noiseBuffer.sampleRate === context.sampleRate) return noiseBuffer;
  const length = Math.max(1, Math.ceil(NOISE_SECONDS * context.sampleRate));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = 2 * Math.random() - 1;
  noiseBuffer = buffer;
  return buffer;
}
function renderNoise(context, destination, layer, startTime) {
  const duration = layer.attack + layer.decay + SOURCE_STOP_PADDING;
  const buffer = getNoise(context);
  const source = context.createBufferSource();
  source.buffer = buffer;
  const filter = context.createBiquadFilter();
  filter.type = layer.filterType;
  filter.frequency.value = layer.filterFrequency;
  if (layer.filterQ !== void 0) filter.Q.value = layer.filterQ;
  const gain = context.createGain();
  gain.gain.setValueAtTime(1e-4, startTime);
  gain.gain.exponentialRampToValueAtTime(layer.peak, startTime + layer.attack);
  gain.gain.exponentialRampToValueAtTime(1e-4, startTime + layer.attack + layer.decay);
  source.connect(filter).connect(gain).connect(destination);
  const window2 = Math.max(0, buffer.duration - duration);
  source.start(startTime, Math.random() * window2, duration);
  source.stop(startTime + duration);
}
function attachShimmer(context, source, destination, shimmer) {
  const delay = context.createDelay(1);
  delay.delayTime.value = shimmer.delay;
  const feedbackFilter = context.createBiquadFilter();
  feedbackFilter.type = "lowpass";
  feedbackFilter.frequency.value = shimmer.lowpass;
  const feedbackGain = context.createGain();
  feedbackGain.gain.value = shimmer.feedback;
  const wetGain = context.createGain();
  wetGain.gain.value = shimmer.wet;
  source.connect(delay);
  delay.connect(feedbackFilter);
  feedbackFilter.connect(feedbackGain);
  feedbackGain.connect(delay);
  feedbackFilter.connect(wetGain);
  wetGain.connect(destination);
  return [delay, feedbackFilter, feedbackGain, wetGain];
}
function sourceEnd(recipe) {
  return Math.max(
    ...recipe.layers.map((l) => (l.offset ?? 0) + l.attack + l.decay + SOURCE_STOP_PADDING)
  );
}
function shimmerTail(shimmer) {
  if (!shimmer || shimmer.feedback <= 0) return 0;
  if (shimmer.feedback >= 1) return shimmer.delay;
  return shimmer.delay * (1 + Math.ceil(Math.log(INAUDIBLE_GAIN) / Math.log(shimmer.feedback)));
}
var sharedOutput = null;
function getOutput(context) {
  if (sharedOutput) return sharedOutput;
  const output = context.createGain();
  output.gain.value = OUTPUT_GAIN;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -2;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 1e-3;
  limiter.release.value = 0.02;
  output.connect(limiter).connect(context.destination);
  sharedOutput = output;
  return output;
}
var nextFree = 0;
var MIN_SPACING = 0.012;
var MAX_LOOKAHEAD = 0.08;
function startFor(context) {
  const now = context.currentTime;
  const start = Math.max(now, Math.min(nextFree, now + MAX_LOOKAHEAD));
  nextFree = start + MIN_SPACING;
  return start;
}
function renderRecipe(context, recipe, volume, detune) {
  const now = startFor(context);
  const lead = Math.max(0, now - context.currentTime);
  const output = getOutput(context);
  const master = context.createGain();
  master.gain.value = recipe.masterGain * trimFor(recipe) * volume;
  master.connect(output);
  const shimmerNodes = recipe.shimmer ? attachShimmer(context, master, output, recipe.shimmer) : [];
  for (const layer of recipe.layers) {
    const startTime = now + (layer.offset ?? 0);
    if (layer.kind === "tone") renderTone(context, master, layer, startTime, detune);
    else renderNoise(context, master, layer, startTime);
  }
  const cleanupAfterMs = (lead + sourceEnd(recipe) + shimmerTail(recipe.shimmer) + CLEANUP_MARGIN) * 1e3;
  setTimeout(() => {
    master.disconnect();
    for (const node of shimmerNodes) node.disconnect();
  }, cleanupAfterMs);
}
var PREF = "mbrd.sound";
var LOG_PREF = "mbrd.soundLog";
var GAIN_AT = [0, 0.35, 0.6, 1];
var DEFAULT_LEVEL = 2;
var level = DEFAULT_LEVEL;
var armed = false;
var clampLevel = (n) => {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? Math.min(3, Math.max(0, Math.round(v))) : DEFAULT_LEVEL;
};
function setSoundLevel(n) {
  const next = clampLevel(n);
  if (next === level) return level;
  level = next;
  writePref(PREF, String(level));
  return level;
}
function refusal() {
  if (!armed) return "unarmed";
  if (level === 0) return "level-off";
  if (typeof matchMedia !== "function") return null;
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduced-motion" : null;
  } catch {
    return null;
  }
}
var muted = () => refusal() !== null;
var sharedContext = null;
var idleTimer = null;
var IDLE_MS = 5e3;
function sleepLater(context) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (context.state === "running") void context.suspend().catch(() => {
    });
  }, IDLE_MS);
}
var STALE_MS = 200;
var waking = null;
function wake(context) {
  if (!waking) {
    waking = Promise.resolve(context.resume()).then(
      () => {
        waking = null;
      },
      (reason) => {
        waking = null;
        throw reason;
      }
    );
  }
  return waking;
}
function getAudioContext() {
  if (sharedContext) return sharedContext;
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  if (!Ctor) return null;
  try {
    sharedContext = new Ctor();
  } catch {
    return null;
  }
  return sharedContext;
}
function setAmbient() {
  if (typeof navigator === "undefined") return;
  const session = navigator.audioSession;
  if (!session) return;
  try {
    session.type = "ambient";
  } catch {
  }
}
var lastCue = null;
var lastAt = -Infinity;
var repeats = 0;
function resetCueState() {
  lastCue = null;
  lastAt = -Infinity;
  repeats = 0;
}
var LOG_MAX = 400;
var logging = false;
var log = [];
var loggedAt = 0;
var stamp = () => typeof performance === "object" ? Math.round(performance.now()) : Date.now();
function record(name, sound, outcome) {
  const at = stamp();
  const entry = {
    at,
    gap: loggedAt ? at - loggedAt : 0,
    cue: name,
    sound,
    outcome
  };
  loggedAt = at;
  log.push(entry);
  if (log.length > LOG_MAX) log.shift();
  console.info(
    `[cue] +${String(entry.gap).padStart(5)}ms  ${name.padEnd(7)} ${sound.padEnd(8)} ${outcome}`
  );
}
function playRecipe(recipe, volume = 1) {
  if (muted()) return;
  render(recipe, volume, 0, logging ? { cue: "lab", sound: "custom" } : null);
}
function render(recipe, volume, detune, note) {
  const say = (outcome) => {
    if (note) record(note.cue, note.sound, outcome);
  };
  const gain = GAIN_AT[level] * Math.min(1, Math.max(0, volume));
  if (gain <= 0) {
    say("level-off");
    return;
  }
  const context = getAudioContext();
  if (!context) {
    say("no-audio");
    return;
  }
  if (context.state === "running") {
    renderRecipe(context, recipe, gain, detune);
    sleepLater(context);
    say("played");
    return;
  }
  const asked = stamp();
  try {
    void wake(context).then(
      () => {
        if (stamp() - asked > STALE_MS) {
          say("stale");
          return;
        }
        if (muted() || context.state !== "running") {
          say("blocked");
          return;
        }
        renderRecipe(context, recipe, gain, detune);
        sleepLater(context);
        say("resumed");
      },
      () => say("blocked")
    );
  } catch {
    say("blocked");
  }
}
function initCuelume(stored = readPref(PREF)) {
  level = stored === null ? DEFAULT_LEVEL : clampLevel(stored);
  armed = true;
  resetCueState();
  setAmbient();
  logging = !!readPref(LOG_PREF);
  if (logging) console.info("[cue] logging is on from a previous session - mbrd.sound.log(false) to stop.");
  return level;
}

// web/assets/js/ui/sound-lab.ts
var recipeOf = (voice) => {
  const recipe = RECIPES[voice.sound];
  return voice.reverse ? invert(recipe) : recipe;
};
var el = (tag, cls = "", text = "") => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
};
var host = (id) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`lab-sound: no #${id} on the page`);
  return node;
};
function buildCues() {
  const table = host("cues");
  table.replaceChildren();
  const head = el("div", "row head");
  head.append(el("span", "cue", "cue"), el("span", "col", "sound"));
  table.append(head);
  for (const name of CUE_NAMES) {
    const voice = voiceFor(name);
    const row = el("div", "row");
    row.append(el("span", "cue", name));
    const button = el("button", "col");
    button.textContent = voice.sound + (voice.reverse ? " \u21A9" : "");
    button.addEventListener("click", () => playRecipe(recipeOf(voice)));
    row.append(button);
    table.append(row);
  }
}
function buildPairs() {
  const row = host("pairs");
  row.replaceChildren();
  for (const [up, down] of [["pick", "tap"], ["on", "off"], ["rise", "fall"]]) {
    const button = el("button", "", `${up} \u2192 ${down}`);
    button.addEventListener("click", () => {
      resetCueState();
      playRecipe(recipeOf(voiceFor(up)));
      setTimeout(() => playRecipe(recipeOf(voiceFor(down))), 200);
    });
    row.append(button);
  }
  const flurry = el("button", "", "forty taps");
  flurry.addEventListener("click", () => {
    resetCueState();
    const recipe = recipeOf(voiceFor("tap"));
    for (let i = 0; i < 40; i++) setTimeout(() => playRecipe(recipe), i * 80);
  });
  row.append(flurry);
}
var FIELDS = [
  { key: "frequency", min: 60, max: 4e3, step: 1 },
  { key: "glideTo", min: 60, max: 4e3, step: 1 },
  { key: "glideTime", min: 0.01, max: 0.6, step: 5e-3 },
  { key: "detune", min: -200, max: 200, step: 1 },
  { key: "filterFrequency", min: 100, max: 8e3, step: 10 },
  { key: "filterQ", min: 0.1, max: 8, step: 0.1 },
  { key: "offset", min: 0, max: 0.5, step: 5e-3 },
  { key: "attack", min: 1e-3, max: 0.2, step: 1e-3 },
  { key: "decay", min: 5e-3, max: 0.8, step: 5e-3 },
  { key: "peak", min: 5e-3, max: 0.3, step: 5e-3 }
];
var draft = clone(RECIPES.chime);
var draftName = "chime";
var draftReversed = false;
function clone(recipe) {
  return {
    masterGain: recipe.masterGain,
    layers: recipe.layers.map((l) => ({ ...l })),
    ...recipe.shimmer ? { shimmer: { ...recipe.shimmer } } : null
  };
}
function buildPicker() {
  const row = host("recipes");
  row.replaceChildren();
  for (const name of SOUND_NAMES) {
    const button = el("button", "", name);
    button.addEventListener("click", () => {
      draftName = name;
      draftReversed = false;
      draft = clone(RECIPES[name]);
      buildSliders();
      playRecipe(draft);
    });
    row.append(button);
  }
}
function buildSliders() {
  const panel = host("numbers");
  panel.replaceChildren();
  const title = el("div", "title", draftName + (draftReversed ? " (reversed)" : ""));
  panel.append(title);
  panel.append(slider("masterGain", draft.masterGain, 0.05, 1.2, 0.01, (v) => {
    draft.masterGain = v;
  }));
  draft.layers.forEach((layer, i) => {
    panel.append(el("div", "sub", `layer ${i + 1} \u2014 ${layer.kind === "tone" ? layer.waveform : layer.filterType + " noise"}`));
    for (const field of FIELDS) {
      const bag = layer;
      const value = bag[field.key];
      if (value === void 0) continue;
      panel.append(slider(field.key, value, field.min, field.max, field.step, (v) => {
        bag[field.key] = v;
      }));
    }
  });
  if (draft.shimmer) {
    panel.append(el("div", "sub", "shimmer"));
    const s = draft.shimmer;
    panel.append(slider("delay", s.delay, 0.01, 0.4, 5e-3, (v) => {
      s.delay = v;
    }));
    panel.append(slider("feedback", s.feedback, 0, 0.9, 0.01, (v) => {
      s.feedback = v;
    }));
    panel.append(slider("wet", s.wet, 0, 0.6, 0.01, (v) => {
      s.wet = v;
    }));
    panel.append(slider("lowpass", s.lowpass, 400, 8e3, 50, (v) => {
      s.lowpass = v;
    }));
  }
}
function slider(name, value, min, max, step, write) {
  const wrap = el("label", "field");
  const label = el("span", "name", name);
  const read = el("span", "value", String(value));
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    write(v);
    read.textContent = input.value;
    playRecipe(draft);
  });
  wrap.append(label, input, read);
  return wrap;
}
function initSoundLab() {
  initCuelume(null);
  setSoundLevel(3);
  buildCues();
  buildPairs();
  buildPicker();
  buildSliders();
  host("play").addEventListener("click", () => playRecipe(draft));
  host("flip").addEventListener("click", () => {
    draft = invert(draft);
    draftReversed = !draftReversed;
    buildSliders();
    playRecipe(draft);
  });
  host("dump").addEventListener("click", () => {
    host("out").textContent = JSON.stringify(draft, null, 2);
  });
}
export {
  initSoundLab
};
