// The interface sounds, checked everywhere they can be checked without ears.
//
// Two halves, and they fail in completely different ways.
//
// The **cue map** is the icons.test.js case exactly: a recipe name that does not
// exist resolves to `undefined`, the engine hands `undefined` to the audio
// graph, and what happens is *nothing* - on one cue, silently. No exception, no
// console line, nothing on screen; only somebody who happened to press that one
// thing would find it, and they would assume the feature was like that. So the
// walk below is the whole of the protection, and it runs in both directions:
// every cue reaches a recipe, and every recipe is either reached by a cue or on
// record in IDLE_SOUNDS as a spare. The second half is not pedantry - nine of
// the seventeen are spare now, and a list that is allowed to grow silently stops
// being the record of a decision.
//
// The **engine** is checked against a stub of Web Audio, because the thing worth
// asserting is not what a sine wave sounds like - it is when this module refuses
// to make one. Before the first user gesture, with the dial at Off, under
// reduced motion, before initCuelume() has run: four different reasons to be
// silent, each of which would otherwise be found by a browser throwing at
// somebody, or not found at all.
//
// Upstream ships 439 lines of runtime test that stubs the same surface and
// re-imports the module with a cache-busting query to reset it. That trick is
// what this file does not need: the fork has stopCuelume(), which exists for
// this and for the same reason setOverlays(null) does - a module that can be
// wired has to be unwirable, or the second test in a process inherits the
// first one's fake.

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
  // The axis carried sound for a day and does not any more - see the head of
  // CUES. This is the half of that decision worth asserting rather than
  // trusting: voiceFor() takes no tier, so a reader cannot reintroduce one by
  // adding a column and forgetting a row. If sound ever gets a character axis
  // again it should be its own control, and this test is what it has to argue
  // with.
  assert.equal(voiceFor.length, 1, 'voiceFor() has grown an argument');
});

test('every recipe is either named by a cue or on record as spare', () => {
  const used = new Set(Object.values(CUES).flat().map(v => v.sound));
  const idle = SOUND_NAMES.filter(name => !used.has(name));
  assert.deepEqual(idle, IDLE_SOUNDS,
    'a recipe nothing plays has to be a line in IDLE_SOUNDS with the reason - '
    + 'either put it back in the table, take it out of the palette, or say why '
    + 'it is being kept. The one thing it may not do is quietly stop sounding.');
  // The other direction, and the one that rots: a spare that has been given a
  // job again is a comment describing something that is no longer true.
  const claimed = IDLE_SOUNDS.filter(name => used.has(name));
  assert.deepEqual(claimed, [], `listed as spare but a cue plays it: ${claimed.join(', ')}`);
});

test('the pairs are one recipe played both ways, not two similar noises', () => {
  // The strongest claim the design makes, and the cheapest one to break by
  // hand: someone assigns `off` a different recipe from `on` because it sounded
  // better on its own, and the two stop being a pair without anything saying so.
  for (const [up, down] of [['on', 'off'], ['rise', 'fall']]) {
    const a = voiceFor(up), b = voiceFor(down);
    assert.equal(b.sound, a.sound, `${up}/${down} are different recipes`);
    assert.ok(!a.reverse && b.reverse, `${up}/${down} are not inverted`);
  }
});

test('isCue admits the eleven names and nothing off the prototype', () => {
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

  // An ascending arpeggio has to come out descending, which is the offsets and
  // not the glide - `sparkle` has no glide at all, so reversing only the pitch
  // ramp would leave it climbing through the same four notes in the same order.
  const flipped = invert(RECIPES.sparkle);
  const before = RECIPES.sparkle.layers.map(l => l.frequency);
  const after = [...flipped.layers]
    .sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0))
    .map(l => l.frequency);
  assert.deepEqual(after, [...before].reverse());
});

test('inverting leaves the envelopes and the gain alone', () => {
  // A reversed attack and decay is a different *kind* of sound rather than the
  // same one going the other way, and at these durations it is heard as a
  // smear. See the note over invert().
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
  // Offsets are compared to the nearest microsecond rather than exactly: a
  // mirror is a subtraction, and 0.1 - (0.1 - 0.025) is not 0.025 in binary
  // floating point. Twenty-five nanoseconds of drift is not a sound anyone can
  // hear, and rounding here says that rather than pretending the arithmetic is
  // exact.
  const shape = layer => ({ ...layer, offset: Math.round((layer.offset ?? 0) * 1e6) });
  for (const name of SOUND_NAMES) {
    assert.deepEqual(
      invert(invert(RECIPES[name])).layers.map(shape),
      RECIPES[name].layers.map(shape),
      name);
  }
});

test('inverting never touches the table it was handed', () => {
  // RECIPES is `as const` in TypeScript and an ordinary object at runtime, so
  // the only thing standing between a mutating invert() and a palette that
  // drifts over a session is that it copies. Frozen would say the same thing
  // and would cost a walk of the whole table at import time.
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
  // The fault every version of the table walked into, and the one thing about
  // it a reader will otherwise measure wrongly: `press` has the higher peak of
  // the two by a clear margin and cannot be heard beside `chime`. Twenty-one
  // milliseconds of band-limited noise against a third of a second of two
  // sines. If this assertion ever inverts, the model has stopped modelling a
  // listener and is back to reading the tallest number in the table.
  const peak = r => r.masterGain * Math.max(...r.layers.map(l => l.peak));
  assert.ok(peak(RECIPES.press) > peak(RECIPES.chime),
    'the table has moved under this test - pick another pair for it');
  assert.ok(loudnessOf(RECIPES.press) < loudnessOf(RECIPES.chime),
    'a 21ms noise burst measured louder than a 356ms bell, which is what peak '
    + 'says and what nobody hears');
});

test('every recipe is trimmed to one loudness', () => {
  // The palette was tuned a recipe at a time and came out spanning
  // twenty-three decibels: undo was a doorbell and a button press was almost
  // inaudible, and both were defensible on their own because nothing in the
  // table ever compares two of them. This is the thing that compares them.
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
  // The clamp, from the other side. It is a guard rather than a lever: it bites
  // on two recipes today and both are within a decibel of it.
  for (const name of SOUND_NAMES) {
    const trim = trimFor(RECIPES[name]);
    assert.ok(trim > 0 && Math.abs(dB(trim, 1)) <= 10 + 1e-9,
      `${name} is trimmed by ${dB(trim, 1).toFixed(1)} dB`);
  }
});

test('a pair comes out level with itself', () => {
  // `on`/`off` and `rise`/`fall` are one recipe dealt out both ways, and the
  // levelling measures each direction separately - so this is the assertion
  // that it does not hear a difference where a listener cannot. A pair whose
  // halves were a decibel apart would read as a switch that is louder one way.
  for (const [up, down] of [['on', 'off'], ['rise', 'fall']]) {
    const gap = dB(levelled(recipeFor(voiceFor(down))), levelled(recipeFor(voiceFor(up))));
    assert.ok(Math.abs(gap) < 0.5, `${up}/${down} come out ${gap.toFixed(2)} dB apart`);
  }
});

test('levelling never touches the table it measures', () => {
  // trimFor() memoises on the recipe object, which is a WeakMap and not a
  // property - the same claim invert() has to make, and for the same reason.
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
      // Recorded here as well as on a buffer source: a recipe is tones, noise or
      // both, so a spacing test that watched only one of the two would silently
      // measure nothing the day a cue was reassigned to the other kind. That is
      // exactly what happened when `pick` moved from a noise burst to a tone.
      start(at) { built.starts.push(at); },
      stop() {},
    });
    // Kept, not just counted: the repeat detune is written onto this node and
    // is the only evidence a run is being varied at all.
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
    // A real shape, because renderNoise() reads `duration` back off it to work
    // out how far into the shared buffer a burst may start. A stub answering
    // `undefined` there would make the offset NaN and every noise layer silent,
    // which is exactly the class of fault this file exists to catch.
    return {
      length, sampleRate, duration: length / sampleRate,
      getChannelData: () => new Float32Array(length),
    };
  }
  createBufferSource() {
    return Object.assign(new StubNode('source'), {
      buffer: null,
      // Recorded, because when a source is told to start is the whole of the
      // spacing rule and there is nothing else to look at. The offset is the
      // second argument and is what keeps one shared buffer from being one
      // repeated burst.
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

test('the dial defaults to Medium and clamps whatever it is given', t => {
  t.after(restoreGlobals);
  stubBrowser();

  assert.deepEqual([...SOUND_STOPS], ['Off', 'Low', 'Medium', 'High']);
  // On by default is the decision that makes the feature worth building. If
  // this line ever reads 0, somebody has turned the whole thing off for
  // everybody who never opens the panel, which is most people.
  assert.equal(initCuelume(null), 2, 'the default is Medium, which is to say on');

  assert.equal(initCuelume('0'), 0);
  assert.equal(initCuelume('3'), 3);
  // localStorage is anyone's to edit, and this value reaches a gain.
  assert.equal(initCuelume('9'), 3);
  assert.equal(initCuelume('-4'), 0);
  assert.equal(initCuelume('loud'), 2, 'unparseable falls back to the default');
  assert.equal(initCuelume('2.6'), 3, 'a fractional stop rounds to one that exists');

  setSoundLevel(1);
  assert.equal(soundLevel(), 1);
  setSoundLevel(99);
  assert.equal(soundLevel(), 3);
});

test('nothing is built before initCuelume has run', t => {
  t.after(restoreGlobals);
  stubBrowser();
  // The whole of how /patch stays silent: main.ts skips the call there, and
  // there is no page check inside the engine to get wrong. It is also what lets
  // state.ts and four base modules be imported in a test with no Web Audio.
  cue('tap');
  cue('fail');
  assert.equal(built.contexts, 0, 'an unwired engine reached for an AudioContext');
});

test('a cue before the page has been touched tries, and is logged if refused', t => {
  t.after(restoreGlobals);
  // There was a check on navigator.userActivation.hasBeenActive here and this
  // test asserted it. It is gone, and this is the behaviour that replaced it:
  // `hasBeenActive` is false on any fresh load, so refusing on it refused every
  // case a browser would in fact have allowed - a high media-engagement score,
  // a granted permission, an installed PWA. The board arriving at launch is the
  // one cue that legitimately speaks before anything is pressed, and it is the
  // exact case that guard blocked.
  stubBrowser({ activated: false });
  initCuelume(null);
  cue('arrive');
  assert.equal(built.contexts, 1, 'the engine declined to even try');

  // And where the browser does refuse, it refuses quietly and says so. A
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
  initCuelume(null);
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

  // Forty taps back to back, in the same tick - which is faster than any hand
  // and is the point: a run of presses must not be able to outpace this. Each
  // one starts on top of its predecessor, and the overlap is the stutter.
  let last = built.gains.length;
  for (let i = 0; i < 40; i++) {
    cue('tap');
    assert.ok(built.gains.length > last, `tap ${i + 1} of 40 was swallowed`);
    last = built.gains.length;
  }

  // The two rules that used to live here are gone and this is what replaced
  // them, so both directions are asserted rather than assumed: a different cue
  // arriving in the same breath plays too.
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

  // The thing that made "a press and its result" read as one event rather than
  // two. Both were scheduled at the identical currentTime, and two transients
  // that start on the same sample are one transient - which is not a failure of
  // overlapping, it is what perfect overlap sounds like.
  //
  // The earliest start of each cue rather than the nth entry, because a recipe
  // is however many layers it is and that changes whenever the table is
  // retuned. This test broke three times on exactly that before it was written
  // this way: it is about *when a cue begins*, and the layer count is none of
  // its business.
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

  // The backstop on the spacing above. Something firing a hundred cues in one
  // tick must not stretch them into a one-second arpeggio; past the lookahead
  // they pile up rather than queue, which is the behaviour asked for.
  built.starts.length = 0;
  for (let i = 0; i < 100; i++) cue('pick');
  // A layer's own offset rides on top of the cue's start - `toggle`'s second
  // burst is 24ms behind its first, by the recipe rather than by the spacing -
  // so the ceiling being asserted is the lookahead plus whatever the recipe
  // carries. Read off the table rather than written down, because a retune
  // changes it and this test is not about which recipe `pick` happens to use.
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
  // The console is the log's whole output and a test does not want it. Restored
  // by the same hook, since a swallowed console.info would follow this file into
  // every test after it.
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

  // Upstream allocates and fills a buffer per noise layer per cue - six
  // thousand Math.random() calls for a press, on every press. One buffer for
  // the session is the whole of this optimisation, and the thing that could go
  // wrong with it silently is that it stops being one.
  for (let i = 0; i < 20; i++) cue('pick');
  assert.equal(built.buffers, 1,
    `${built.buffers} buffers for twenty cues - the noise is meant to be made once`);

  // And the half that keeps one buffer honest: every burst is taken from a
  // different offset, or forty identical bursts sum coherently and read as one
  // sound with an amplitude problem. The stub records the offset as the second
  // argument to start().
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

  // The only thing keeping forty overlapping copies of one waveform from
  // phase-locking into a single sustained tone. Alternating and not climbing,
  // because a run of forty that walked one way would be a melody going
  // somewhere rather than a texture.
  // Picked off the table rather than named, because the detune is written onto
  // an *oscillator* and half the palette is noise: whichever cue is asserted
  // here has to be one whose recipe carries exactly one tone layer, and which
  // cue that is changes every time the table is retuned. This picks one.
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
  // web/lab-sound.html tunes a copy of a recipe on sliders, which is a shape
  // no cue name can reach. It goes through the same mute rules as everything
  // else, which is the half worth asserting.
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

  // A page that has not been touched may not make a sound, so a context built
  // at boot starts suspended and its resume() does not settle until the browser
  // decides to unlock it - which may be the next gesture or ten seconds later.
  // This is that browser.
  let resumes = 0;
  let unlock = () => {};
  class Locked extends StubContext {
    constructor() { super(); this.state = 'suspended'; }
    resume() {
      resumes++;
      return new Promise(resolve => { unlock = () => { this.state = 'running'; resolve(); }; });
    }
  }

  // A clock this test owns. The engine stamps a cue's arrival off
  // performance.now(), so this is what lets the wait below be ten seconds
  // without taking ten seconds - and, more to the point, what keeps the second
  // half from going stale because a loaded machine stalled for a fifth of a
  // second rather than because the engine decided anything.
  let clock = 0;
  stubBrowser();
  setGlobal('window', { AudioContext: Locked });
  setGlobal('performance', { now: () => clock });
  initCuelume('2');
  setCueLog(true);

  // The board arriving, and then a drag of the whimsy dial - which is exactly
  // the sequence that was reported: silence while the thumb moved, and then the
  // whole drag plus the boot chime arriving at once, long afterwards, as one
  // noise with nothing to explain it.
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

  // The other half, which is what keeps this from being a mute button: a
  // context that wakes when it is asked still speaks. Our own idle suspend is
  // this case and takes single-digit milliseconds, which is what the clock
  // standing still says here.
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

test('a browser with no Web Audio is silent rather than broken', t => {
  t.after(restoreGlobals);
  built = { contexts: 0, gains: [], oscillators: 0, limiters: 0, oscNodes: [], starts: [], offsets: [], buffers: 0 };
  setGlobal('window', {});
  setGlobal('navigator', { userActivation: { hasBeenActive: true } });
  initCuelume('3');
  assert.doesNotThrow(() => cue('done'));

  // And one that throws on construction, which is what a locked-down or
  // out-of-handles browser does.
  restoreGlobals();
  built = { contexts: 0, gains: [], oscillators: 0, limiters: 0, oscNodes: [], starts: [], offsets: [], buffers: 0 };
  setGlobal('window', { AudioContext: class { constructor() { built.contexts++; throw new Error('blocked'); } } });
  setGlobal('navigator', { userActivation: { hasBeenActive: true } });
  initCuelume('3');
  assert.doesNotThrow(() => cue('done'));
  assert.equal(built.contexts, 1, 'one attempt for one cue, and nothing thrown out of it');
  assert.doesNotThrow(() => cue('fail'));
});
