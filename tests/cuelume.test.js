// The interface sounds, checked everywhere they can be checked without ears.
//
// Two halves. The **cue map**: a recipe name that doesn't exist resolves to
// `undefined` and nothing happens, silently - the walk below runs both ways,
// every cue reaches a recipe and every recipe is reached by a cue or recorded
// in IDLE_SOUNDS as a spare (ten of seventeen now).
//
// The **engine** is checked against a stub of Web Audio - what matters is not
// what a sine sounds like but when this module refuses to make one: before a
// user gesture, at Off, under reduced motion, before initCuelume() has run.
//
// Uses stopCuelume() to reset between tests rather than re-importing with a
// cache-busting query - a module that can be wired has to be unwirable, or
// the next test inherits this one's fake.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CUES, CUE_NAMES, IDLE_SOUNDS, RECIPES, SOUND_NAMES, TARGET_LOUDNESS,
  invert, isCue, loudnessOf, recipeFor, trimFor, voiceFor,
} from '../web/assets/js/cuelume/recipes.ts';
import {
  SOUND_STOPS, cue, cueLog, initCuelume, playRecipe, resetCueState, setCueLog,
  setSoundLevel, soundLevel, stopCuelume,
} from '../web/assets/js/cuelume/engine.ts';

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

test('every cue resolves to a real recipe', () => {
  assert.ok(CUE_NAMES.length >= 10, `only ${CUE_NAMES.length} cues - has the table moved?`);
  for (const name of CUE_NAMES) {
    const voice = voiceFor(name);
    assert.ok(voice, `${name} has no voice`);
    assert.ok(Object.hasOwn(RECIPES, voice.sound),
      `${name} names ${voice.sound}, which is not a recipe`);
    assert.ok(recipeFor(voice).layers.length > 0, `${name} renders no layers`);
  }
});

test('every cue sounds the same whatever the whimsy dial says', () => {
  // The whimsy axis carried sound for a day and no longer does (see the head
  // of CUES). voiceFor() takes no tier, so a reader can't reintroduce one by
  // adding a column and forgetting a row.
  assert.equal(voiceFor.length, 1, 'voiceFor() has grown an argument');
});

test('every recipe is either named by a cue or on record as spare', () => {
  const used = new Set(Object.values(CUES).flat().map(v => v.sound));
  const idle = SOUND_NAMES.filter(name => !used.has(name));
  assert.deepEqual(idle, IDLE_SOUNDS,
    'a recipe nothing plays has to be a line in IDLE_SOUNDS with the reason - '
    + 'either put it back in the table, take it out of the palette, or say why '
    + 'it is being kept. The one thing it may not do is quietly stop sounding.');
  // The direction that rots: a spare given a job again leaves a stale line.
  const claimed = IDLE_SOUNDS.filter(name => used.has(name));
  assert.deepEqual(claimed, [], `listed as spare but a cue plays it: ${claimed.join(', ')}`);
});

test('the pairs are one recipe played both ways, not two similar noises', () => {
  // Easy to break by hand: assigning `off` a different recipe from `on`
  // because it sounded better alone, silently breaking the pair.
  for (const [up, down] of [['on', 'off'], ['rise', 'fall']]) {
    const a = voiceFor(up), b = voiceFor(down);
    assert.equal(b.sound, a.sound, `${up}/${down} are different recipes`);
    assert.ok(!a.reverse && b.reverse, `${up}/${down} are not inverted`);
  }
});

test('isCue admits the twelve names and nothing off the prototype', () => {
  for (const name of CUE_NAMES) assert.ok(isCue(name));
  for (const bad of ['toString', 'constructor', '__proto__', '', null, 7]) {
    assert.equal(isCue(bad), false, `isCue(${String(bad)})`);
  }
});

// ---------------------------------------------------------------------------
// invert()
// ---------------------------------------------------------------------------

test('inverting swaps the glide and mirrors the offsets', () => {
  const back = invert(RECIPES.droplet);
  const [layer] = back.layers;
  assert.equal(layer.frequency, RECIPES.droplet.layers[0].glideTo);
  assert.equal(layer.glideTo, RECIPES.droplet.layers[0].frequency);

  // An ascending arpeggio must come out descending via offsets, not glide -
  // `sparkle` has no glide, so reversing only the pitch ramp wouldn't reorder it.
  const flipped = invert(RECIPES.sparkle);
  const before = RECIPES.sparkle.layers.map(l => l.frequency);
  const after = [...flipped.layers]
    .sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0))
    .map(l => l.frequency);
  assert.deepEqual(after, [...before].reverse());
});

test('inverting leaves the envelopes and the gain alone', () => {
  // A reversed attack/decay is a different kind of sound, heard as a smear at
  // these durations - see the note over invert().
  for (const name of SOUND_NAMES) {
    const back = invert(RECIPES[name]);
    assert.equal(back.masterGain, RECIPES[name].masterGain, name);
    back.layers.forEach((layer, i) => {
      assert.equal(layer.attack, RECIPES[name].layers[i].attack, `${name} layer ${i} attack`);
      assert.equal(layer.decay, RECIPES[name].layers[i].decay, `${name} layer ${i} decay`);
      assert.equal(layer.peak, RECIPES[name].layers[i].peak, `${name} layer ${i} peak`);
    });
  }
});

test('inverting twice is the recipe again', () => {
  // Offsets compared to the nearest microsecond, not exactly: a mirror is a
  // subtraction, and floating point drifts by nanoseconds nobody can hear.
  const shape = layer => ({ ...layer, offset: Math.round((layer.offset ?? 0) * 1e6) });
  for (const name of SOUND_NAMES) {
    assert.deepEqual(
      invert(invert(RECIPES[name])).layers.map(shape),
      RECIPES[name].layers.map(shape),
      name);
  }
});

test('inverting never touches the table it was handed', () => {
  // RECIPES is `as const` in TypeScript but an ordinary object at runtime, so
  // the only guard against a mutating invert() is that it copies.
  const before = JSON.stringify(RECIPES);
  invert(RECIPES.chime);
  invert(invert(RECIPES.arrival));
  assert.equal(JSON.stringify(RECIPES), before);
});

// ---------------------------------------------------------------------------
// Levelling
// ---------------------------------------------------------------------------

/** How loud a recipe comes out once its own trim is on it. */
const levelled = recipe => loudnessOf(recipe) * trimFor(recipe);

/** Decibels between two amplitudes. */
const dB = (a, b) => 20 * Math.log10(a / b);

test('loudness is not peak, which is the whole reason this exists', () => {
  // `press` has the higher peak by far but can't be heard beside `chime` - 21ms
  // of noise against a third of a second of two sines. If this ever inverts,
  // the model has stopped modelling a listener.
  const peak = r => r.masterGain * Math.max(...r.layers.map(l => l.peak));
  assert.ok(peak(RECIPES.press) > peak(RECIPES.chime),
    'the table has moved under this test - pick another pair for it');
  assert.ok(loudnessOf(RECIPES.press) < loudnessOf(RECIPES.chime),
    'a 21ms noise burst measured louder than a 356ms bell, which is what peak '
    + 'says and what nobody hears');
});

test('every recipe is trimmed to one loudness', () => {
  // Tuned one recipe at a time, the palette spanned 23dB - undo a doorbell,
  // a press nearly inaudible - because nothing ever compared two at once.
  const off = SOUND_NAMES.map(name => ({
    name, gap: dB(levelled(RECIPES[name]), TARGET_LOUDNESS),
  }));
  const worst = off.reduce((a, b) => (Math.abs(b.gap) > Math.abs(a.gap) ? b : a));
  assert.ok(Math.abs(worst.gap) <= 2.5,
    `${worst.name} lands ${worst.gap.toFixed(1)} dB off the target. Only the two `
    + 'held at the clamp may miss it at all, and a recipe that cannot be levelled '
    + 'from within ten decibels is a recipe whose own numbers want changing - '
    + 'widening the clamp instead would turn a sound into a click');
});

test('a trim never redesigns the sound it is levelling', () => {
  // A guard, not a lever - bites on two recipes today, both within a decibel.
  for (const name of SOUND_NAMES) {
    const trim = trimFor(RECIPES[name]);
    assert.ok(trim > 0 && Math.abs(dB(trim, 1)) <= 10 + 1e-9,
      `${name} is trimmed by ${dB(trim, 1).toFixed(1)} dB`);
  }
});

test('a pair comes out level with itself', () => {
  // Levelling measures each direction of a pair separately - asserting it
  // doesn't hear a difference where a listener can't (a switch louder one way).
  for (const [up, down] of [['on', 'off'], ['rise', 'fall']]) {
    const gap = dB(levelled(recipeFor(voiceFor(down))), levelled(recipeFor(voiceFor(up))));
    assert.ok(Math.abs(gap) < 0.5, `${up}/${down} come out ${gap.toFixed(2)} dB apart`);
  }
});

test('levelling never touches the table it measures', () => {
  // trimFor() memoises via a WeakMap, not a property - same claim as invert().
  const before = JSON.stringify(RECIPES);
  for (const name of SOUND_NAMES) trimFor(RECIPES[name]);
  assert.equal(JSON.stringify(RECIPES), before);
});

// ---------------------------------------------------------------------------
// The engine, against a stub
// ---------------------------------------------------------------------------

const originals = new Map();

function setGlobal(name, value) {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function restoreGlobals() {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  originals.clear();
  stopCuelume();
}

const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });

/** Whatever the last stubbed context was asked to build. */
let built;

class StubNode {
  constructor(kind) { this.kind = kind; this.out = []; }
  connect(to) { this.out.push(to); return to; }
  disconnect() {}
}

class StubContext {
  constructor() {
    built.contexts++;
    this.state = 'running';
    this.currentTime = 0;
    this.sampleRate = 8000;
    this.destination = new StubNode('destination');
  }
  createGain() {
    const node = Object.assign(new StubNode('gain'), { gain: param() });
    built.gains.push(node);
    return node;
  }
  createOscillator() {
    built.oscillators++;
    const node = Object.assign(new StubNode('osc'), {
      type: '', frequency: param(), detune: param(),
      // Recorded here as well as on a buffer source, since a recipe can be
      // tone, noise, or both - watching only one silently breaks when a cue
      // is reassigned (as happened when `pick` moved from noise to tone).
      start(at) { built.starts.push(at); },
      stop() {},
    });
    // Kept, not just counted - the repeat detune lives on this node.
    built.oscNodes.push(node);
    return node;
  }
  createDynamicsCompressor() {
    built.limiters++;
    return Object.assign(new StubNode('limiter'), {
      threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    });
  }
  createBuffer(channels, length, sampleRate) {
    built.buffers++;
    // A real shape - renderNoise() reads `duration` back off it to place a
    // burst; `undefined` here would make the offset NaN and every noise silent.
    return {
      length, sampleRate, duration: length / sampleRate,
      getChannelData: () => new Float32Array(length),
    };
  }
  createBufferSource() {
    return Object.assign(new StubNode('source'), {
      buffer: null,
      // When a source starts is the whole spacing rule; the offset (second
      // arg) is what keeps one shared buffer from being one repeated burst.
      start(at, offset) { built.starts.push(at); built.offsets.push(offset); },
      stop() {},
    });
  }
  createBiquadFilter() {
    return Object.assign(new StubNode('filter'), {
      type: '', frequency: param(), Q: param(),
    });
  }
  createDelay() { return Object.assign(new StubNode('delay'), { delayTime: param() }); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

/**
 * A browser that has been touched, has Web Audio, and asks for no reduced
 * motion. Each test bends one thing about it and asserts the silence.
 */
function stubBrowser({ activated = true, reduced = false } = {}) {
  built = { contexts: 0, gains: [], oscillators: 0, limiters: 0, oscNodes: [], starts: [], offsets: [], buffers: 0 };
  setGlobal('window', { AudioContext: StubContext });
  setGlobal('navigator', { userActivation: { hasBeenActive: activated } });
  setGlobal('matchMedia', query => ({
    matches: reduced && query.includes('reduced-motion'),
    media: query,
  }));
}

test('the dial defaults to Off and clamps whatever it is given', t => {
  t.after(restoreGlobals);
  stubBrowser();

  assert.deepEqual([...SOUND_STOPS], ['Off', 'Low', 'Medium', 'High']);
  // The sounds are experimental: nobody hears them until they switch them on.
  assert.equal(initCuelume(null), 0, 'the default is Off');

  assert.equal(initCuelume('0'), 0);
  assert.equal(initCuelume('3'), 3);
  // localStorage is anyone's to edit, and this value reaches a gain.
  assert.equal(initCuelume('9'), 3);
  assert.equal(initCuelume('-4'), 0);
  assert.equal(initCuelume('loud'), 0, 'unparseable falls back to the default');
  assert.equal(initCuelume('2.6'), 3, 'a fractional stop rounds to one that exists');

  setSoundLevel(1);
  assert.equal(soundLevel(), 1);
  setSoundLevel(99);
  assert.equal(soundLevel(), 3);
});

test('nothing is built before initCuelume has run', t => {
  t.after(restoreGlobals);
  stubBrowser();
  // How /patch stays silent: main.ts skips the call there, no page check
  // inside the engine to get wrong. Also lets base modules import with no Web Audio.
  cue('tap');
  cue('fail');
  assert.equal(built.contexts, 0, 'an unwired engine reached for an AudioContext');
});

test('a cue before the page has been touched tries, and is logged if refused', t => {
  t.after(restoreGlobals);
  // A check on hasBeenActive used to refuse here, but it's false on any fresh
  // load - refusing on it blocked every case a browser would actually allow
  // (high media-engagement, a granted permission, an installed PWA), including
  // the board arriving at launch, the one cue that legitimately speaks first.
  stubBrowser({ activated: false });
  initCuelume('2');
  cue('arrive');
  assert.equal(built.contexts, 1, 'the engine declined to even try');

  // Where the browser does refuse, it refuses quietly and says so - a
  // rejected resume is the ordinary shape of that.
  restoreGlobals();
  const info = console.info;
  console.info = () => {};
  t.after(() => { console.info = info; });
  built = { contexts: 0, gains: [], oscillators: 0, limiters: 0, oscNodes: [], starts: [], offsets: [], buffers: 0 };
  setGlobal('window', { AudioContext: class {
    constructor() { built.contexts++; this.state = 'suspended'; }
    resume() { return Promise.reject(new Error('not allowed to start')); }
  } });
  setGlobal('navigator', { userActivation: { hasBeenActive: false } });
  setGlobal('matchMedia', query => ({ matches: false, media: query }));
  initCuelume('2');
  setCueLog(true);
  assert.doesNotThrow(() => cue('arrive'));
  return new Promise(resolve => setImmediate(() => {
    assert.deepEqual(cueLog().map(r => r.outcome), ['blocked'],
      'a refusal has to appear in the transcript, or a blocked launch and a '
      + 'launch nobody wired look the same');
    setCueLog(false);
    resolve();
  }));
});

test('Off is silent, and so is reduced motion at any stop', t => {
  t.after(restoreGlobals);
  stubBrowser();
  initCuelume('0');
  cue('done');
  assert.equal(built.contexts, 0, 'the dial was at Off');

  restoreGlobals();
  stubBrowser({ reduced: true });
  initCuelume('3');
  cue('done');
  assert.equal(built.contexts, 0,
    'there is no reduced-sound media query, and somebody who has turned '
    + 'animation down has said something close enough to be worth honouring');
});

test('a cue renders through one shared output bus and one limiter', t => {
  t.after(restoreGlobals);
  stubBrowser();
  initCuelume('2');

  cue('done');
  const first = built.gains.length;
  assert.ok(first > 0, 'nothing was built at all');
  assert.equal(built.limiters, 1);

  resetCueState();
  cue('arrive');
  assert.equal(built.limiters, 1,
    'the limiter is what makes forty overlapping cues a texture rather than a '
    + 'clip, and there has to be exactly one of it');
  assert.ok(built.gains.length > first, 'the second cue built nothing');
});

test('nothing is ever dropped, and no cue waits for the one before it', t => {
  t.after(restoreGlobals);
  stubBrowser();
  initCuelume('2');

  // Forty taps in the same tick, faster than any hand - a run of presses must
  // not outpace this.
  let last = built.gains.length;
  for (let i = 0; i < 40; i++) {
    cue('tap');
    assert.ok(built.gains.length > last, `tap ${i + 1} of 40 was swallowed`);
    last = built.gains.length;
  }

  // Both directions asserted: a different cue arriving in the same breath
  // plays too.
  cue('fail');
  assert.ok(built.gains.length > last, 'a different cue was dropped');
  last = built.gains.length;
  cue('note');
  assert.ok(built.gains.length > last,
    'a receipt landing on the heels of something else still speaks - every '
    + 'toast makes a sound, with no exceptions');
});

test('two cues in one tick start apart rather than on the same sample', t => {
  t.after(restoreGlobals);
  stubBrowser();
  initCuelume('2');

  // Two transients starting on the same sample are one transient - not a
  // failure of overlap, but what perfect overlap sounds like.
  //
  // Uses the earliest start of each cue, not the nth entry, since layer count
  // varies as the table is retuned - this is about when a cue begins.
  built.starts.length = 0;
  cue('pick');
  const first = Math.min(...built.starts);
  built.starts.length = 0;
  cue('on');
  const second = Math.min(...built.starts);
  assert.ok(second > first, 'the second cue started on the same sample as the first');
  assert.ok(second - first >= 0.01 && second - first <= 0.02,
    `spaced by ${second - first}s - it wants to be about twelve milliseconds: `
    + 'enough to be two attacks, far below anything heard as latency');
});

test('a burst never becomes a queue', t => {
  t.after(restoreGlobals);
  stubBrowser();
  initCuelume('2');

  // The backstop on the spacing above: a hundred cues in one tick must not
  // stretch into a one-second arpeggio - past the lookahead they pile up.
  built.starts.length = 0;
  for (let i = 0; i < 100; i++) cue('pick');
  // A layer's own offset rides on the cue's start, so the ceiling is lookahead
  // plus whatever the recipe carries. Read off the table since a retune changes it.
  const layers = recipeFor(voiceFor('pick')).layers;
  const tail = Math.max(...layers.map(l => l.offset ?? 0));
  const last = Math.max(...built.starts);
  assert.ok(last <= 0.08 + tail + 1e-9,
    `the hundredth cue was pushed ${last - tail}s out - no cue may ever be `
    + 'delayed past MAX_LOOKAHEAD, whatever arrives');
  assert.equal(built.starts.length, 100 * layers.length,
    'a cue was dropped rather than piled');
});

test('the log records refusals as loudly as it records sounds', t => {
  t.after(() => { setCueLog(false); restoreGlobals(); });
  stubBrowser();
  initCuelume('2');
  // Restored by the same hook, since a swallowed console.info would follow
  // this file into every test after it.
  const info = console.info;
  console.info = () => {};
  t.after(() => { console.info = info; });

  setCueLog(true);
  cue('pick');
  cue('bogus');
  setSoundLevel(0);
  cue('pick');

  const rows = cueLog();
  assert.deepEqual(rows.map(r => `${r.cue}:${r.outcome}`),
    ['pick:played', 'bogus:unknown-cue', 'pick:level-off'],
    'the point of the transcript is that a cue which made no sound still appears '
    + 'in it - a muted cue and a cue nobody made must not look the same');
  assert.equal(rows[0].sound, voiceFor('pick').sound,
    'a played row names the recipe it resolved to');
  assert.equal(rows[2].sound, '-', 'a refused row never got as far as a recipe');
  assert.ok(rows.every(r => typeof r.gap === 'number'),
    'the gap column is the one the question is actually in');

  setCueLog(false);
  cue('pick');
  assert.equal(cueLog().length, 3, 'turning it off stopped it');
});

test('the noise buffer is made once and played from a different place each time', t => {
  t.after(restoreGlobals);
  stubBrowser();
  initCuelume('2');

  // One buffer for the session, not a refill per press - the risk is that it
  // silently stops being one.
  for (let i = 0; i < 20; i++) cue('pick');
  assert.equal(built.buffers, 1,
    `${built.buffers} buffers for twenty cues - the noise is meant to be made once`);

  // The half that keeps one buffer honest: every burst takes a different
  // offset, or forty identical bursts sum coherently into one loud sound.
  const offsets = built.offsets.filter(o => o !== undefined);
  assert.ok(offsets.length >= 20, `only ${offsets.length} offsets recorded`);
  assert.equal(new Set(offsets).size, offsets.length, 'two bursts took the same window');
  assert.ok(offsets.every(o => Number.isFinite(o) && o >= 0),
    `an offset was not a usable number: ${offsets.find(o => !Number.isFinite(o) || o < 0)}`);
});

test('a run detunes alternately rather than climbing', t => {
  t.after(restoreGlobals);
  stubBrowser();
  initCuelume('2');

  // What keeps forty overlapping copies of one waveform from phase-locking
  // into a sustained tone: alternating detune, not climbing. Picked off the
  // table rather than named, since which cue has exactly one tone layer
  // changes as the table is retuned.
  const tone = CUE_NAMES.find(name => {
    const layers = recipeFor(voiceFor(name)).layers;
    return layers.filter(l => l.kind === 'tone').length === 1;
  });
  assert.ok(tone, 'no cue resolves to a recipe with exactly one tone layer');

  built.oscNodes.length = 0;
  for (let i = 0; i < 5; i++) cue(tone);
  assert.deepEqual(built.oscNodes.map(n => n.detune.value), [0, 7, -7, 7, -7],
    `detune over a run of five ${tone} cues`);
});

test('the bench can play a recipe the table does not carry', t => {
  t.after(restoreGlobals);
  stubBrowser();
  initCuelume('2');
  // web/lab-sound.html tunes a recipe on sliders, a shape no cue name reaches
  // - it still goes through the same mute rules as everything else.
  const tuned = { masterGain: 0.5, layers: [{ kind: 'tone', waveform: 'sine', frequency: 440, attack: 0.01, decay: 0.1, peak: 0.05 }] };
  playRecipe(tuned);
  assert.equal(built.oscillators, 1);

  setSoundLevel(0);
  playRecipe(tuned);
  assert.equal(built.oscillators, 1, 'the bench ignored the dial');
});

test('stopCuelume puts the module back to silence', t => {
  t.after(restoreGlobals);
  stubBrowser();
  initCuelume('2');
  cue('tap');
  assert.equal(built.contexts, 1);

  stopCuelume();
  cue('rise');
  assert.equal(built.contexts, 1, 'a stopped engine built a second context');
});

test('a locked context queues nothing and plays nothing late', async t => {
  t.after(restoreGlobals);
  const info = console.info;
  console.info = () => {};
  t.after(() => { console.info = info; setCueLog(false); });

  // A context built at boot starts suspended, and its resume() doesn't
  // settle until the browser unlocks it - next gesture, or ten seconds later.
  let resumes = 0;
  let unlock = () => {};
  class Locked extends StubContext {
    constructor() { super(); this.state = 'suspended'; }
    resume() {
      resumes++;
      return new Promise(resolve => { unlock = () => { this.state = 'running'; resolve(); }; });
    }
  }

  // A clock this test owns, since the engine stamps arrival off
  // performance.now() - lets the ten-second wait not take ten seconds.
  let clock = 0;
  stubBrowser();
  setGlobal('window', { AudioContext: Locked });
  setGlobal('performance', { now: () => clock });
  initCuelume('2');
  setCueLog(true);

  // The reported sequence: the board arriving, then a whimsy-dial drag -
  // silence while the thumb moved, then everything arriving at once, late.
  cue('arrive');
  for (let i = 0; i < 6; i++) cue('pick');
  assert.equal(resumes, 1,
    `${resumes} resumes for seven cues - one wait is shared by everything `
    + 'behind it, or nothing can see that a queue is forming');
  assert.equal(built.gains.length, 0, 'a suspended context rendered anyway');

  clock = 10_000;
  unlock();
  await new Promise(setImmediate);

  assert.equal(built.gains.length, 0,
    'seven sounds arrived together ten seconds after anything that could '
    + 'explain them - a cue is feedback, and feedback that arrives after the '
    + 'fact is not quieter feedback, it is a noise with no cause');
  assert.deepEqual(new Set(cueLog().map(r => r.outcome)), new Set(['stale']),
    'and it has to say so, or a dropped cue and a cue nobody made look the same');

  // What keeps this from being a mute button: a context that wakes promptly
  // still speaks - our own idle suspend, at single-digit milliseconds.
  restoreGlobals();
  clock = 0;
  stubBrowser();
  setGlobal('window', { AudioContext: class extends StubContext {
    constructor() { super(); this.state = 'suspended'; }
  } });
  setGlobal('performance', { now: () => clock });
  initCuelume('2');
  setCueLog(true);
  cue('done');
  await new Promise(setImmediate);
  assert.ok(built.gains.length > 0, 'a context that resumed at once stayed silent');
  assert.deepEqual(cueLog().map(r => r.outcome), ['resumed']);
});

test('a resume that never settles is given up on, not carried for the page', async t => {
  t.after(restoreGlobals);
  const info = console.info;
  console.info = () => {};
  t.after(() => { console.info = info; setCueLog(false); });

  // The shape the cleaning game found, and the worst failure this module has
  // had. Its spa loop is an <audio> element; a media element taking the audio
  // focus can leave the context suspended with a resume() the browser is in no
  // hurry to keep. One cue held the shared wait, every cue behind it was handed
  // the same promise, and because that promise never settled the callback that
  // both renders the sound *and* records the entry never ran. The app went
  // silent for the rest of the page - and the transcript said nothing at all,
  // which is the one outcome it is supposed to be impossible to get: every other
  // branch of render() says something. "A press that prints nothing never
  // reached the engine" was, for this one bug, a lie.
  let resumes = 0;
  class NeverWakes extends StubContext {
    constructor() { super(); this.state = 'suspended'; }
    resume() { resumes++; return new Promise(() => {}); }
  }

  // Nothing here waits, so the clock never has to move - it is stubbed only
  // because record() stamps every entry off it.
  const clock = 0;
  stubBrowser();
  setGlobal('window', { AudioContext: NeverWakes });
  setGlobal('performance', { now: () => clock });
  initCuelume('2');
  setCueLog(true);

  // The deadline is a real timer, so the test owns it rather than waiting a
  // second for it. Stubbed after initCuelume so only wake()'s own timer lands
  // here: nothing else in this test gets far enough to arm one.
  const pending = [];
  setGlobal('setTimeout', fn => { pending.push(fn); return 0; });

  cue('pick');
  assert.equal(resumes, 1, 'the first cue asks the context to wake');
  assert.equal(cueLog().length, 0,
    'a resume still in flight has nothing to report yet - that silence is the trap');
  assert.equal(pending.length, 1, 'nothing armed the deadline');

  // Time passes. Nothing settled, and nothing ever will.
  for (const fire of pending.splice(0)) fire();

  cue('pick');
  assert.equal(resumes, 2,
    'the second press was handed the first press\'s dead promise - one hung '
    + 'resume must not be the last word on whether this app can make a sound');

  // And the shared wait is still shared *within* the deadline, which is the
  // thing the give-up must not undo: seven presses in a row are one resume.
  for (let i = 0; i < 5; i++) cue('pick');
  assert.equal(resumes, 2, 'the give-up turned the shared wait back into a queue');
});

test('a browser with no Web Audio is silent rather than broken', t => {
  t.after(restoreGlobals);
  built = { contexts: 0, gains: [], oscillators: 0, limiters: 0, oscNodes: [], starts: [], offsets: [], buffers: 0 };
  setGlobal('window', {});
  setGlobal('navigator', { userActivation: { hasBeenActive: true } });
  initCuelume('3');
  assert.doesNotThrow(() => cue('done'));

  // One that throws on construction, as a locked-down or out-of-handles
  // browser does.
  restoreGlobals();
  built = { contexts: 0, gains: [], oscillators: 0, limiters: 0, oscNodes: [], starts: [], offsets: [], buffers: 0 };
  setGlobal('window', { AudioContext: class { constructor() { built.contexts++; throw new Error('blocked'); } } });
  setGlobal('navigator', { userActivation: { hasBeenActive: true } });
  initCuelume('3');
  assert.doesNotThrow(() => cue('done'));
  assert.equal(built.contexts, 1, 'one attempt for one cue, and nothing thrown out of it');
  assert.doesNotThrow(() => cue('fail'));
});
