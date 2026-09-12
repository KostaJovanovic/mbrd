// Sound bench (lab-sound.html). Plays every cue side-by-side, puts recipe
// numbers on sliders for tuning. Off the design system — own flat colours,
// no tokens.css. Bundled separately via `npm run dev:sound`.

import {
  CUE_NAMES, RECIPES, SOUND_NAMES, invert, voiceFor,
  type Cue, type NoiseLayer, type SoundLayer, type SoundName, type SoundRecipe,
  type ToneLayer, type Voice,
} from '../cuelume/recipes.ts';
import { initCuelume, playRecipe, resetCueState, setSoundLevel } from '../cuelume/engine.ts';

/** Resolve a voice to a playable recipe, applying inversion if needed. */
const recipeOf = (voice: Voice): SoundRecipe => {
  const recipe = RECIPES[voice.sound] as SoundRecipe;
  return voice.reverse ? invert(recipe) : recipe;
};

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, cls = '', text = '',
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
};

const host = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`lab-sound: no #${id} on the page`);
  return node;
};

// ---------------------------------------------------------------------------
// The cues
// ---------------------------------------------------------------------------

/** One row per cue. Button shows the recipe name (↩ if inverted). */
function buildCues(): void {
  const table = host('cues');
  table.replaceChildren();

  const head = el('div', 'row head');
  head.append(el('span', 'cue', 'cue'), el('span', 'col', 'sound'));
  table.append(head);

  for (const name of CUE_NAMES) {
    const voice = voiceFor(name);
    const row = el('div', 'row');
    row.append(el('span', 'cue', name));
    const button = el('button', 'col');
    button.textContent = voice.sound + (voice.reverse ? ' ↩' : '');
    // playRecipe directly, not cue() — bypass repeat-detune so the button plays exactly what it prints.
    button.addEventListener('click', () => playRecipe(recipeOf(voice)));
    row.append(button);
    table.append(row);
  }
}

/** Paired cues (on/off, rise/fall, pick/tap) played 200 ms apart — tests
 * whether the inversion sounds like one gesture backwards. */
function buildPairs(): void {
  const row = host('pairs');
  row.replaceChildren();
  for (const [up, down] of [['pick', 'tap'], ['on', 'off'], ['rise', 'fall']] as [Cue, Cue][]) {
    const button = el('button', '', `${up} → ${down}`);
    button.addEventListener('click', () => {
      resetCueState();
      playRecipe(recipeOf(voiceFor(up)));
      setTimeout(() => playRecipe(recipeOf(voiceFor(down))), 200);
    });
    row.append(button);
  }
  // Flurry: stress-test the repeat guard and detune.
  const flurry = el('button', '', 'forty taps');
  flurry.addEventListener('click', () => {
    resetCueState();
    const recipe = recipeOf(voiceFor('tap'));
    for (let i = 0; i < 40; i++) setTimeout(() => playRecipe(recipe), i * 80);
  });
  row.append(flurry);
}

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

/** Numeric keys extracted from layer types — prevents sliders for non-existent fields. */
type NumberKeys<T> = { [K in keyof T]-?: number extends T[K] ? K : never }[keyof T];
type LayerNumberKey = NumberKeys<ToneLayer> | NumberKeys<NoiseLayer>;

/** Slider ranges per field — hand-written to span the audible band, not just nudge. */
const FIELDS: { key: LayerNumberKey, min: number, max: number, step: number }[] = [
  { key: 'frequency', min: 60, max: 4000, step: 1 },
  { key: 'glideTo', min: 60, max: 4000, step: 1 },
  { key: 'glideTime', min: 0.01, max: 0.6, step: 0.005 },
  { key: 'detune', min: -200, max: 200, step: 1 },
  { key: 'filterFrequency', min: 100, max: 8000, step: 10 },
  { key: 'filterQ', min: 0.1, max: 8, step: 0.1 },
  { key: 'offset', min: 0, max: 0.5, step: 0.005 },
  { key: 'attack', min: 0.001, max: 0.2, step: 0.001 },
  { key: 'decay', min: 0.005, max: 0.8, step: 0.005 },
  { key: 'peak', min: 0.005, max: 0.3, step: 0.005 },
];

/** Deep-copied recipe under the sliders. RECIPES is frozen, so we clone. */
let draft: SoundRecipe = clone(RECIPES.chime as SoundRecipe);
let draftName: SoundName = 'chime';
let draftReversed = false;

function clone(recipe: SoundRecipe): SoundRecipe {
  return {
    masterGain: recipe.masterGain,
    layers: recipe.layers.map(l => ({ ...l })) as SoundLayer[],
    ...(recipe.shimmer ? { shimmer: { ...recipe.shimmer } } : null),
  };
}

function buildPicker(): void {
  const row = host('recipes');
  row.replaceChildren();
  for (const name of SOUND_NAMES) {
    const button = el('button', '', name);
    button.addEventListener('click', () => {
      draftName = name;
      draftReversed = false;
      draft = clone(RECIPES[name] as SoundRecipe);
      buildSliders();
      playRecipe(draft);
    });
    row.append(button);
  }
}

/** One slider per field the layer actually has — absent fields omitted, not greyed. */
function buildSliders(): void {
  const panel = host('numbers');
  panel.replaceChildren();

  const title = el('div', 'title', draftName + (draftReversed ? ' (reversed)' : ''));
  panel.append(title);

  panel.append(slider('masterGain', draft.masterGain, 0.05, 1.2, 0.01, v => {
    draft.masterGain = v;
  }));

  draft.layers.forEach((layer, i) => {
    panel.append(el('div', 'sub', `layer ${i + 1} — ${layer.kind === 'tone' ? (layer as ToneLayer).waveform : layer.filterType + ' noise'}`));
    for (const field of FIELDS) {
      const bag: Partial<Record<LayerNumberKey, number>> = layer;
      const value = bag[field.key];
      if (value === undefined) continue;
      panel.append(slider(field.key, value, field.min, field.max, field.step, v => {
        bag[field.key] = v;
      }));
    }
  });

  if (draft.shimmer) {
    panel.append(el('div', 'sub', 'shimmer'));
    const s = draft.shimmer;
    panel.append(slider('delay', s.delay, 0.01, 0.4, 0.005, v => { s.delay = v; }));
    panel.append(slider('feedback', s.feedback, 0, 0.9, 0.01, v => { s.feedback = v; }));
    panel.append(slider('wet', s.wet, 0, 0.6, 0.01, v => { s.wet = v; }));
    panel.append(slider('lowpass', s.lowpass, 400, 8000, 50, v => { s.lowpass = v; }));
  }
}

/** Labelled slider. Fires on input (not change) so tuning is continuous. */
function slider(
  name: string, value: number, min: number, max: number, step: number,
  write: (v: number) => void,
): HTMLElement {
  const wrap = el('label', 'field');
  const label = el('span', 'name', name);
  const read = el('span', 'value', String(value));
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    write(v);
    read.textContent = input.value;
    playRecipe(draft);
  });
  wrap.append(label, input, read);
  return wrap;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/** Build the page. Called from lab-sound.html, not at import time (imports test). */
export function initSoundLab(): void {
  // Init at level 3 (High) without reading/writing mbrd.sound prefs.
  initCuelume(null);
  setSoundLevel(3);

  buildCues();
  buildPairs();
  buildPicker();
  buildSliders();

  host('play').addEventListener('click', () => playRecipe(draft));
  host('flip').addEventListener('click', () => {
    draft = invert(draft);
    draftReversed = !draftReversed;
    buildSliders();
    playRecipe(draft);
  });
  // Dump tuned recipe as JSON for pasting back into recipes.ts.
  host('dump').addEventListener('click', () => {
    host('out').textContent = JSON.stringify(draft, null, 2);
  });
}
