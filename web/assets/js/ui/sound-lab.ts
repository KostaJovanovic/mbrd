// The bench for the interface sounds. Not part of the app.
//
// web/lab-sound.html is the page; this is everything on it. It is in ui/ for
// the reason ui/pigments.ts's bench half is - a page is interface - and it
// ships in web/ for the reason lab.html gives about itself: tools/serve.py's
// document root is web/, so this is the only place a page can reach the real
// cuelume/ modules rather than a copy of them. It reaches them through
// assets/lab-sound.js, which is this module bundled on its own by
// `npm run dev:sound`. A build product cannot drift; a duplicate would.
//
// ── Why this exists at all ──
//
// The cue table in cuelume/recipes.ts has been written three times, and every
// version chosen by reading the recipe names rather than by hearing them was
// wrong - twice by assigning the most-fired cue in the app to a sound that
// could not be heard at all. That is the method
// research/old/feedback-plan-2026-08-14.md records getting four diagnoses out
// of twelve wrong, every one of them found by opening the app rather than by
// reading the source. The equivalent here is listening, and there is no other
// way to do it: a table of numbers describing a sound tells you nothing about
// whether an undo should chirp or thud, and nothing whatever about whether it
// can be heard over a room.
//
// So the bench does two things the app cannot. It plays every cue in one column
// so they can be judged against each other rather than one at a time - `rise`
// and `fall` have to be audibly the same thing backwards, and that is a
// comparison. And it puts the recipe's own numbers on sliders, so a sound that
// wants to be twenty milliseconds longer is a drag rather than an edit, a
// rebuild and a refresh.
//
// ── Off the design system, like the pigment lab ──
//
// Its own flat colours, none of tokens.css, and it does not render at the
// current whimsy tier - the same rule lab.html states for itself, and for the
// same reason: a bench wearing the thing it is auditing takes the reading
// through it. It had a tier switch once, back when a cue resolved to a
// different recipe at each stop of the dial; the axis stopped carrying sound
// and the switch went with it.
//
// What that costs is worth naming. Nothing learned here about how a cue feels
// *in place* transfers to the app - a `tap` judged on its own, forty times in a
// row, is not a `tap` heard once while a card lands under your hand. Use the
// app for that. This page is for the palette, not for the wiring.

import {
  CUE_NAMES, RECIPES, SOUND_NAMES, invert, voiceFor,
  type Cue, type NoiseLayer, type SoundLayer, type SoundName, type SoundRecipe,
  type ToneLayer, type Voice,
} from '../cuelume/recipes.ts';
import { initCuelume, playRecipe, resetCueState, setSoundLevel } from '../cuelume/engine.ts';

/**
 * A voice as a playable recipe, with the inversion applied where it asks for
 * one.
 *
 * SAFETY: RECIPES is read back as readonly literals and SoundRecipe is the
 * mutable shape of one; the assertion drops `readonly` and claims nothing about
 * the contents. Nothing here writes to a recipe - invert() builds a new one and
 * playRecipe() only reads numbers off it.
 */
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

/**
 * One row per cue, with the recipe it plays printed on the button.
 *
 * The name is on the button rather than in a legend because the question this
 * page answers most often is "which recipe is that?" - heard first, read
 * second, which is the order the judgement actually happens in. A trailing
 * arrow marks a voice that is played inverted.
 */
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
    // Not cue(), which is the app's door and carries the repeat detune with it.
    // The voice is resolved here so a button plays exactly what it prints.
    button.addEventListener('click', () => playRecipe(recipeOf(voice)));
    row.append(button);
    table.append(row);
  }
}

/**
 * The pairs, played as pairs.
 *
 * `on`/`off` and `rise`/`fall` are the same recipe with the glide inverted, and
 * that claim is the single strongest argument for having taken a synthesiser
 * rather than a folder of samples - so it is the one thing on this page with a
 * button of its own. Two hundred milliseconds apart, which is far enough to
 * hear them as two events and close enough to hear them as one gesture.
 *
 * `pick`/`tap` is here on different terms: the two are the same voice today, so
 * this button is what a whole drag sounds like from the press to the landing -
 * which is what it was listened to as when the down/up version was thrown out.
 * Give `tap` its own row again and this is the button that says whether the new
 * one is any better. Two hundred milliseconds is about the shortest a real drag
 * takes.
 */
function buildPairs(): void {
  const row = host('pairs');
  row.replaceChildren();
  // SAFETY: the six names are cue names - CUES has a row for each, and the
  // bench would fail to build a button for one that did not. The assertion is
  // only that a nested array literal of strings is a list of pairs, which is
  // the shape and not the values.
  for (const [up, down] of [['pick', 'tap'], ['on', 'off'], ['rise', 'fall']] as [Cue, Cue][]) {
    const button = el('button', '', `${up} → ${down}`);
    button.addEventListener('click', () => {
      resetCueState();
      playRecipe(recipeOf(voiceFor(up)));
      setTimeout(() => playRecipe(recipeOf(voiceFor(down))), 200);
    });
    row.append(button);
  }
  // The other thing that cannot be judged one press at a time. Forty taps in
  // eighty milliseconds is what a drag of forty cards sounds like, and it is
  // the case the repeat guard and the detune exist for.
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

/**
 * Which fields of a layer are worth a slider, and over what range.
 *
 * Hand-written rather than derived from the values, and that is the point: a
 * range derived from the current number can only ever offer a nudge, and the
 * useful question at a bench is what the sound does somewhere it has never
 * been. Frequencies run over most of the audible band, envelopes over the
 * whole range from a click to a pad.
 */
/**
 * The numeric fields of a layer, taken from the layer types rather than typed
 * out again. A slider for a field a layer does not have is the one mistake this
 * table can make, and spelling `key: string` was what let it: `filterQ` on a
 * tone layer read as undefined and the row silently vanished, which looks
 * exactly like a field that is simply not set. Now a key that is not a number on
 * either arm fails here.
 */
type NumberKeys<T> = { [K in keyof T]-?: number extends T[K] ? K : never }[keyof T];
type LayerNumberKey = NumberKeys<ToneLayer> | NumberKeys<NoiseLayer>;

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

/**
 * The recipe currently under the sliders. A deep copy; RECIPES is frozen.
 *
 * SAFETY: RECIPES is declared with a deep `as const` so its members read back
 * as readonly literals. The bench mutates its copy, and clone() is what makes
 * it a copy - the assertion is dropping `readonly` off a value that has just
 * been rebuilt, not a claim about its shape.
 */
let draft: SoundRecipe = clone(RECIPES.chime as SoundRecipe);
let draftName: SoundName = 'chime';
let draftReversed = false;

function clone(recipe: SoundRecipe): SoundRecipe {
  // SAFETY: each layer is spread into a fresh object, so what comes back is the
  // same shape without the readonly - the map is the copy the assertion
  // describes. A spread of a ToneLayer is a ToneLayer.
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
      // SAFETY: as at `draft` above - clone() rebuilds it, so the assertion is
      // only dropping the readonly RECIPES carries.
      draft = clone(RECIPES[name] as SoundRecipe);
      buildSliders();
      playRecipe(draft);
    });
    row.append(button);
  }
}

/**
 * One slider per field a layer actually has.
 *
 * Absent fields get no slider rather than a disabled one, which is the schema's
 * own rule about absence over disabling. A `press` is one noise layer and it
 * should read as four numbers, not as ten with six greyed.
 */
function buildSliders(): void {
  const panel = host('numbers');
  panel.replaceChildren();

  const title = el('div', 'title', draftName + (draftReversed ? ' (reversed)' : ''));
  panel.append(title);

  panel.append(slider('masterGain', draft.masterGain, 0.05, 1.2, 0.01, v => {
    draft.masterGain = v;
  }));

  draft.layers.forEach((layer, i) => {
    // SAFETY: `kind === 'tone'` is SoundLayer's discriminant, so the ternary has
    // already picked the arm - the assertion is only that the narrowing does not
    // survive into the template literal.
    panel.append(el('div', 'sub', `layer ${i + 1} — ${layer.kind === 'tone' ? (layer as ToneLayer).waveform : layer.filterType + ' noise'}`));
    for (const field of FIELDS) {
      // A checked assignment, not a cast: every LayerNumberKey holds a number
      // or nothing on both arms of SoundLayer, so this view of the layer is one
      // the checker agrees with - and it writes through, because it is the same
      // object.
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

/**
 * One labelled range, playing the whole recipe on every change.
 *
 * On `input` rather than on `change`, and that is the whole ergonomic of this
 * page: a slider that only speaks when you let go turns tuning into a series of
 * guesses. It does mean a drag fires a lot of them, which is what the limiter
 * in the engine is for, and it is also a fair test of the thing.
 */
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

/**
 * Build the page. Exported and called from lab-sound.html rather than run at
 * import time, because tests/imports.test.js holds every module in the tree to
 * loading without a browser and its list of exceptions is three names long and
 * closed. A bench is not an argument for a fourth.
 */
export function initSoundLab(): void {
  // Armed by hand and pinned to High. The bench is not somebody's app and has
  // no business reading or writing mbrd.sound - a session spent auditioning
  // forty taps must not leave the real dial somewhere it was dragged to here.
  // initCuelume(null) takes the default without touching storage; setSoundLevel
  // then writes, which is the one thing it does that this page would rather it
  // did not, and is worth the alternative being a second volume path in the
  // engine that only the bench uses.
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
  // The one output worth taking away from here. A tuned recipe is a block of
  // numbers that goes back into cuelume/recipes.ts by hand, and printing it is
  // cheaper and more honest than any import path this page could offer.
  host('dump').addEventListener('click', () => {
    host('out').textContent = JSON.stringify(draft, null, 2);
  });
}
