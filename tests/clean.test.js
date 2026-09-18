// The cleaning simulator's arithmetic - the two matchers that open it, the
// mess/tool table, the occupancy grid the jet clears, the pressure tank, what a
// glove will hold, and cobweb pairing. The mode itself is a drawing and is
// checked by playing it; everything a test can hold lives in ui/clean/mess.ts
// and ui/clean/konami.ts, which touch no DOM. The crust's shape comes from
// ui/clean/art.ts, which touches none at import time either.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  konamiMatcher, KONAMI, tapMatcher, TAPS, TAP_GAP_MS, TAP_SPAN_MS,
} from '../web/assets/js/ui/clean/konami.ts';
import {
  MESS, TOOLS, GRIMES, DEBRIS, GRIME_FOR, grimesFor, LAYERS, layersFor, TUNING, yieldsTo, planTracks,
  makeField, emptyField, coverage, fieldClear, stamp,
  fullTank, tankStep, tankPower, bulkOf, handRoom,
  gapBetween, trioWebs, spreadOf, webCards, webHolds, trianglesOverlap,
  planBoard, cardClean, tally, jetShape, SUBS, wearShare, WEAR_MAX, wearOf,
  toolWork, toolWanted, toolShare, peelFor,
} from '../web/assets/js/ui/clean/mess.ts';
import { crust, crustAt, crustMask, webCore, bootAt } from '../web/assets/js/ui/clean/art.ts';

/**
 * Deterministic PRNG, so a failing deal is reproducible rather than a one-off.
 *
 * Warmed before it is handed out. An xorshift seeded with a small integer takes
 * a few rounds to look random, and every test here seeds it with 1, 2, 3 - so
 * the *first* value was strongly correlated across seeds. A coin flip read off
 * it came up the same way eighty times running, which silently turned a
 * one-in-two chance into a certainty and hid the fact that nothing was testing
 * the other branch.
 */
function rng(seed = 1) {
  let h = (seed >>> 0) || 1;
  const next = () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
    return h / 0x100000000;
  };
  for (let i = 0; i < 8; i++) next();
  return next;
}

const box = (id, x, y, w = 100, h = 100) => ({ id, x, y, w, h });
const feedAll = (feed, keys) => keys.map(k => feed(k));

const CLEAN_TS = readFileSync(
  fileURLToPath(new URL('../web/assets/js/ui/clean/clean.ts', import.meta.url)), 'utf8');

// ---------------------------------------------------------------------------
// One run must not reach the next
//
// The mode is a module, not an object: leaving and re-entering runs a second
// session through the same variables. Three bugs of this shape shipped at once
// and none of them was visible in the run that caused it - a held button left
// the pointer count at one so the next run could only pan, a held Space left
// the pan modifier down, and the ending's timer closed a session four seconds
// later that had nothing to do with it.
//
// There is no DOM harness here, so this reads the source, the way
// tests/mobile-bridge.test.js holds two files in step as text.
// ---------------------------------------------------------------------------

/** The names declared in clean.ts's marked session-state block. */
function sessionState() {
  const block = CLEAN_TS.split('---- session state')[1]?.split('---- end session state')[0];
  assert.ok(block, 'the session-state block in clean.ts has lost its markers');
  return [...block.matchAll(/^let (\w+)/gm)].map(m => m[1]);
}

/** A function's body in clean.ts, to its closing brace at column 0. */
function bodyOf(signature) {
  const from = CLEAN_TS.indexOf(signature);
  assert.ok(from > 0, `${signature} is gone from clean.ts`);
  return CLEAN_TS.slice(from, CLEAN_TS.indexOf('\n}', from));
}

/** A body, plus the bodies of the no-argument helpers it calls - teardown is
 *  allowed to delegate (endStroke, stopMusic) and mostly should. */
function withHelpers(signature) {
  let text = bodyOf(signature);
  for (const [, name] of text.matchAll(/^\s*(\w+)\(\);/gm)) {
    const at = CLEAN_TS.indexOf(`function ${name}(`);
    if (at > 0) text += CLEAN_TS.slice(at, CLEAN_TS.indexOf('\n}', at));
  }
  return text;
}

test('no session state survives into the next run', () => {
  // Cleared on the way out, or set again on the way in. Either is safe; neither
  // is the bug. `on` is excluded because it is the flag both of those turn.
  const out = withHelpers('export function stopClean(');
  const back = withHelpers('export function startClean(');
  const missed = sessionState().filter(name =>
    name !== 'on'
    && !new RegExp(`\\b${name}\\s*=[^=]`).test(out)
    && !new RegExp(`\\b${name}\\s*=[^=]`).test(back));
  assert.deepEqual(missed, [],
    'carried into the next run - clear it in stopClean() or set it in startClean()');
});

test('the session block is not empty and names the ones that bit', () => {
  const names = sessionState();
  assert.ok(names.length >= 10, `only ${names.length} names found - the block moved`);
  for (const had of ['pointers', 'spaceHeld', 'drawing', 'panning'])
    assert.ok(names.includes(had), `${had} is no longer inside the marked block`);
});

test('what is in the hand is session state and is emptied on the way out', () => {
  // A glove still holding three leaves when the mode closes would hand the next
  // run a full hand, and the board it opens on has nowhere those came from.
  const names = sessionState();
  for (const had of ['held', 'carried', 'loose', 'tank'])
    assert.ok(names.includes(had), `${had} is not inside the marked block`);
});

test('no timer in the mode escapes the tracked helper', () => {
  // A bare setTimeout is a callback that can outlive the session it belongs to.
  // The one inside later() is the helper itself.
  const bare = [...CLEAN_TS.matchAll(/^[^\n]*\bsetTimeout\(/gm)]
    .map(m => m[0].trim())
    .filter(line => !line.startsWith('const id = setTimeout('));
  assert.deepEqual(bare, [], 'use later(), which stopClean() can clear');
});

test('the ending has no timer that closes it', () => {
  // It stays up until somebody leaves. A delayed stopClean() is exactly the bug
  // this mode shipped with once and the thing the second pass removed.
  const end = bodyOf('function finish(');
  assert.equal(/stopClean\(\)/.test(end), false,
    'the ending must not close itself - Done and Escape are the only ways out');
});

// ---------------------------------------------------------------------------
// konami
// ---------------------------------------------------------------------------

test('the code fires on its last key and not before', () => {
  const feed = konamiMatcher();
  const got = feedAll(feed, KONAMI);
  assert.deepEqual(got.slice(0, -1), Array(KONAMI.length - 1).fill(false));
  assert.equal(got.at(-1), true);
});

test('it re-arms, so a second run fires again', () => {
  const feed = konamiMatcher();
  feedAll(feed, KONAMI);
  assert.equal(feedAll(feed, KONAMI).at(-1), true);
});

test('caps lock does not throw away nine correct presses', () => {
  const feed = konamiMatcher();
  const shouted = KONAMI.map(k => (k.length === 1 ? k.toUpperCase() : k));
  assert.equal(feedAll(feed, shouted).at(-1), true);
});

test('a wrong key restarts the run', () => {
  const feed = konamiMatcher();
  feedAll(feed, ['ArrowUp', 'ArrowUp', 'ArrowDown', 'x']);
  assert.equal(feedAll(feed, KONAMI).at(-1), true);
});

test('a third ArrowUp is a failed third press and a good first one', () => {
  // The prefix rewind: ↑↑↑↓↓←→←→ba still matches, because the extra ↑ leaves
  // the matcher at one rather than at zero.
  const feed = konamiMatcher();
  const got = feedAll(feed, ['ArrowUp', ...KONAMI]);
  assert.equal(got.at(-1), true);
});

test('a half-finished run is carried, not timed out', () => {
  const feed = konamiMatcher();
  feedAll(feed, KONAMI.slice(0, 9));
  assert.equal(feed('a'), true);
});

// ---------------------------------------------------------------------------
// the tap, which is the way in where there is no keyboard
// ---------------------------------------------------------------------------

test('seven quick taps open it and six do not', () => {
  const tap = tapMatcher();
  const got = Array.from({ length: TAPS }, (_, i) => tap(i * 200));
  assert.deepEqual(got.slice(0, -1), Array(TAPS - 1).fill(false));
  assert.equal(got.at(-1), true);
});

test('it re-arms, so a second run of taps fires again', () => {
  const tap = tapMatcher();
  for (let i = 0; i < TAPS; i++) tap(i * 200);
  const again = Array.from({ length: TAPS }, (_, i) => tap(5000 + i * 200));
  assert.equal(again.at(-1), true);
});

test('a long gap restarts the run', () => {
  const tap = tapMatcher();
  for (let i = 0; i < TAPS - 1; i++) tap(i * 100);
  // One slow tap, and the six before it are gone.
  assert.equal(tap((TAPS - 1) * 100 + TAP_GAP_MS + 50), false);
  const got = Array.from({ length: TAPS - 1 }, (_, i) => tap(9000 + i * 100));
  assert.deepEqual(got, Array(TAPS - 1).fill(false),
    'the gap did not restart the run - it fired one tap early');
});

test('a patient drum inside the gap still runs out of the window', () => {
  // Both rules, not one: taps every 500ms are each inside the gap and the run
  // is still not seven taps in three seconds.
  const tap = tapMatcher();
  const step = TAP_GAP_MS - 50;
  assert.ok((TAPS - 1) * step > TAP_SPAN_MS, 'the fixture no longer overruns the window');
  const got = Array.from({ length: TAPS }, (_, i) => tap(i * step));
  assert.deepEqual(got, Array(TAPS).fill(false), 'a slow drum opened it');
});

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

test('there are three tools and every mess names one of them', () => {
  const ids = TOOLS.map(t => t.id);
  assert.equal(ids.length, 3, 'the bar is three tools you hold, not a mode switch');
  for (const [kind, def] of Object.entries(MESS)) {
    assert.ok(ids.includes(def.tool), `${kind} wants a tool that is not in the bar: ${def.tool}`);
    const takers = ids.filter(id => yieldsTo(kind, id));
    assert.deepEqual(takers, [def.tool], `${kind} is taken by ${takers.length} tools`);
  }
});

test('every tool in the bar has something to do', () => {
  for (const { id } of TOOLS) {
    const mine = Object.keys(MESS).filter(k => MESS[k].tool === id);
    assert.ok(mine.length > 0, `${id} has no mess of its own`);
  }
});

test('every piece of debris has a bulk and every grime a depth', () => {
  for (const [kind, def] of Object.entries(MESS)) {
    if (def.family === 'debris') {
      assert.ok(def.bulk >= 1, `${kind} takes no room in the hand`);
      assert.equal(TUNING.depth[kind], undefined, `${kind} is debris and should have no depth`);
      continue;
    }
    if (def.family !== 'field') continue;
    assert.equal(typeof TUNING.depth[kind], 'number',
      `${kind} has no depth, so it would clear in one pass`);
    assert.ok(TUNING.depth[kind] >= 1, `${kind} has a depth below one`);
  }
});

test('the deal lists name only things the table knows', () => {
  for (const kind of GRIMES) assert.equal(MESS[kind].family, 'field', `${kind} is not a grime`);
  for (const kind of DEBRIS) assert.equal(MESS[kind].family, 'debris', `${kind} is not debris`);
  // Every list in GRIME_FOR too, so a kind cannot be given to a card type it is
  // not a field for.
  for (const [type, list] of Object.entries(GRIME_FOR)) {
    assert.ok(list.length, `${type} resolves to nothing`);
    for (const kind of list)
      assert.equal(MESS[kind].family, 'field', `${type} may be dealt ${kind}, which is not a grime`);
  }
  // Every kind is reachable from some list, or it is a drawing nobody will ever
  // see. A field may arrive through GRIMES or through any GRIME_FOR entry.
  const dealtFields = new Set([...GRIMES, ...Object.values(GRIME_FOR).flat()]);
  for (const [kind, def] of Object.entries(MESS)) {
    if (def.family === 'field') assert.ok(dealtFields.has(kind), `${kind} is never dealt`);
    if (def.family === 'debris') assert.ok(DEBRIS.includes(kind), `${kind} is never dealt`);
  }
});

test('every card type resolves to grimes, and an unknown one still gets some', () => {
  // grimesFor() must never hand back an empty list: a card type nobody wrote a
  // rule for is not a clean card, it is a card with no rule.
  for (const type of Object.keys(GRIME_FOR))
    assert.ok(grimesFor(type).length, `${type} resolves to nothing`);
  assert.deepEqual(grimesFor(undefined), GRIMES);
  assert.deepEqual(grimesFor('sticker'), GRIMES, 'an unlisted type falls back to the caked three');
});

test('no card type is dealt only one kind of grime', () => {
  // Weighted, never exclusive. A table that said "notes get coffee, pictures
  // get mud" would deal the same board every time, only sorted.
  for (const [type, list] of Object.entries(GRIME_FOR))
    assert.ok(new Set(list).size >= 3, `${type} can only ever be dealt ${new Set(list).size} kinds`);
});

test('a note is dealt paper grime far more often than mud', () => {
  // The point of the table: what lands on a thing follows from what the thing
  // is. Checked as a share over many deals rather than on one, because the
  // whole design is weights.
  const boxes = Array.from({ length: 12 }, (_, i) =>
    ({ id: `n${i}`, x: i * 400, y: 0, w: 200, h: 200, type: 'note' }));
  let paper = 0;
  let caked = 0;
  for (let seed = 1; seed <= 60; seed++)
    for (const card of planBoard(boxes, rng(seed)).cards)
      for (const kind of card.fields) {
        if (kind === 'coffee' || kind === 'ink') paper++;
        if (kind === 'mud' || kind === 'rust' || kind === 'tar') caked++;
      }
  // A clear majority rather than a landslide: a note can also be dealt mud over
  // rust, which puts two caked grimes on one card at once, so the margin here
  // is smaller than the weights alone would suggest.
  assert.ok(paper > caked * 1.4, `notes got ${paper} paper grimes and ${caked} caked`);
  assert.ok(caked > 0, 'a note must still be able to get mud, or the table is exclusive');
});

test('the cobweb is the only mess that belongs to a pair of cards', () => {
  const webs = Object.keys(MESS).filter(k => MESS[k].family === 'web');
  assert.deepEqual(webs, ['cobweb']);
});

test('tar is the deepest thing on the board and mud the shallowest', () => {
  // Not a fact about the numbers so much as about the shape of the session:
  // the reward for finding tar is that it takes a while.
  assert.ok(TUNING.depth.tar > TUNING.depth.rust);
  assert.ok(TUNING.depth.rust > TUNING.depth.mud);
});

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

test('a field that was dealt nothing is already clean', () => {
  const f = emptyField('mud');
  assert.equal(coverage(f), 0);
  assert.equal(fieldClear(f), true);
});

test('a full field starts at 1 and clears at the threshold, not at zero', () => {
  const f = makeField('mud', () => true);
  assert.equal(coverage(f), 1);
  assert.equal(fieldClear(f), false);
  // Take everything but a hair under the threshold's worth of cells.
  const keep = Math.floor(f.total * (1 - TUNING.clearAt));
  f.left = keep;
  assert.equal(fieldClear(f), true, 'the last specks must dissolve on their own');
  f.left = keep + Math.ceil(f.total * 0.02);
  assert.equal(fieldClear(f), false);
});

test('a stamp takes the cells it covers and no others', () => {
  const f = makeField('mud', () => true);
  const took = stamp(f, 0.5, 0.5, 0.25, 0.25);
  assert.ok(took > 0);
  assert.equal(f.left, f.total - took);
  const grid = TUNING.grid;
  const at = (x, y) => f.cells[Math.floor(y * grid) * grid + Math.floor(x * grid)];
  assert.equal(at(0.5, 0.5), 0, 'the centre survived the stroke');
  assert.equal(at(0.02, 0.02), SUBS, 'a corner was taken by a stroke in the middle');
});

test('stamping the same place twice takes nothing the second time', () => {
  const f = makeField('mud', () => true);
  stamp(f, 0.5, 0.5, 0.3, 0.3);
  assert.equal(stamp(f, 0.5, 0.5, 0.3, 0.3), 0);
});

test('a deep field thins under one pass and only goes on the last', () => {
  // The difference between washing and stamping: one pass over a card must not
  // be a clean card.
  const f = makeField('tar', () => true, TUNING.grid, 3);
  assert.equal(stamp(f, 0.5, 0.5, 0.3, 0.3, 1), 0, 'a first pass finished cells');
  assert.equal(f.left, f.total, 'a first pass must thin, not clear');
  assert.equal(stamp(f, 0.5, 0.5, 0.3, 0.3, 1), 0);
  assert.ok(stamp(f, 0.5, 0.5, 0.3, 0.3, 1) > 0, 'the third pass must finish them');
});

test('a shielded cell is left alone and counts for nothing', () => {
  // The shield is what a piece of debris casts over the crust it lies on, and
  // is the whole of the rule that the glove comes before the jet.
  const grid = TUNING.grid;
  const f = makeField('mud', () => true, grid, 1);
  const half = i => (i % grid) < grid / 2;
  const took = stamp(f, 0.5, 0.5, 0.5, 0.5, 99, half);
  assert.ok(took > 0, 'the shield covered everything');
  for (let i = 0; i < f.cells.length; i++)
    if (half(i)) assert.equal(f.cells[i], SUBS, `shielded cell ${i} was taken`);
  assert.equal(f.left, f.total - took, 'the count and the grid disagree');
  // And with nothing shielded the same stroke takes strictly more.
  const open = makeField('mud', () => true, grid, 1);
  assert.ok(stamp(open, 0.5, 0.5, 0.5, 0.5, 99, null) > took);
});

test('a bite smaller than a pass thins the crust rather than skipping it', () => {
  // The grid counts sub-units of a pass exactly so that a weak jet is weak and
  // not intermittent. Whole passes meant a bite of 0.05 was banked until it
  // crossed 1 and then spent all at once: one stamp in twenty did every bit of
  // the work and the other nineteen did nothing, which reads as a fire rate.
  const f = makeField('mud', () => true, TUNING.grid, 1);
  const cell = () => f.cells[Math.floor(TUNING.grid / 2) * TUNING.grid + Math.floor(TUNING.grid / 2)];
  const full = cell();
  assert.equal(stamp(f, 0.5, 0.5, 0.3, 0.3, 0.05), 0, 'a fifth of a pass finished a cell');
  const once = cell();
  assert.ok(once < full, 'a fifth of a pass did nothing at all');
  assert.ok(once > full * 0.9, 'a fifth of a pass took most of the cell');
  // And it keeps taking, every single time, rather than every twentieth time.
  stamp(f, 0.5, 0.5, 0.3, 0.3, 0.05);
  assert.ok(cell() < once, 'the second stamp was a dud');
});

test('no single touch of the jet may clear its own disc', () => {
  // The share is worked out from the one cell under the nozzle and then spread
  // over an ellipse covering forty of them. A share of 1 - which a finished
  // centre cell used to ask for - wiped the lot at full strength whatever the
  // cells around it had left, and drew a hard-edged hole with no falloff.
  for (const before of [0, 0.001, 0.05, 0.3, 0.7, 1]) {
    for (const bite of [0.001, 0.05, 0.5, 1, 99]) {
      const share = wearShare(before, bite);
      assert.ok(share > 0, `nothing taken at ${before}/${bite}`);
      assert.ok(share <= WEAR_MAX, `${share} at ${before}/${bite} clears the disc`);
    }
  }
});

test('worn crust never sits in the band where it cannot be seen', () => {
  // Linear wear walked a tar cell down 0.8, 0.64, 0.48, 0.32, 0.16 and spent
  // half its life under two fifths opacity, where there is no telling what is
  // still there to clean. It must stay visible until the pass that takes it.
  //
  // The 0.8 is read out of the stylesheet rather than written here twice: it is
  // the one number that decides how dark a whole crust is, and a copy of it in
  // a test is a copy that goes stale the first time somebody tunes it.
  const css = readFileSync(new URL('../web/assets/css/clean.css', import.meta.url), 'utf8');
  const settled = /\.clean-grime\.clean-settled\s*\{[^}]*?opacity:\s*([\d.]+)/.exec(css);
  assert.ok(settled, 'clean.css no longer says what a settled crust is worth');
  const GRIME_OPACITY = Number(settled[1]);
  const FLOOR = 0.4;
  // Per *stamp*, not per pass: a point on a card is covered by a dozen
  // overlapping touches of the jet on the way past, and how much of the crust
  // each one takes is what wearShare() answers.
  const DABS_PER_PASS = 8;
  for (const [kind, depth] of Object.entries(TUNING.depth)) {
    const bite = 1 / (depth * DABS_PER_PASS);
    let alpha = 1;
    let left = 1;
    while (left > 0.02) {
      alpha *= 1 - wearShare(left, bite);
      left -= bite;
      const seen = alpha * GRIME_OPACITY;
      // Visible right up until the crust itself is nearly gone. The last sixth
      // of its life is the reveal - it has to fall through the faint band to
      // reach nothing, and the only alternative is a jump, which is the hard
      // edge this whole curve exists to avoid.
      if (left > 0.16) {
        assert.ok(seen >= FLOOR, `${kind} fell to ${seen.toFixed(2)} at ${left.toFixed(2)} left`);
      }
    }
    // And then it leaves, rather than lingering as a film nobody can wash off.
    for (let i = 0; i < DABS_PER_PASS; i++) alpha *= 1 - wearShare(0, bite);
    assert.ok(alpha * GRIME_OPACITY < 0.02, `${kind} left ${(alpha * GRIME_OPACITY).toFixed(3)} behind`);
  }
});

test('the jet takes nothing from an under-layer until the top has let go of that cell', () => {
  // The shield clean.ts composes, reproduced here over the pure parts: a cell
  // of the under-layer is protected exactly while the top's cell at the same
  // index still has something in it. Per cell and not per field - the jet takes
  // the mud off this patch and starts on the rust beneath it while the mud a
  // hand's width away is untouched.
  const under = makeField('rust', () => true, 32, 3);
  const top = makeField('mud', () => true, 32, 2);
  const shield = i => top.cells[i] > 0;
  const was = under.left;

  // Wash a small patch until the top there is gone.
  for (let i = 0; i < 40 && top.left === top.total; i++) stamp(top, 0.5, 0.5, 0.1, 0.1, 1);
  assert.ok(top.left < top.total, 'the fixture never cleared any of the top');
  assert.equal(under.left, was, 'the under-layer lost cells while the top still covered them');

  // Now the same patch bites through to the rust, and only there.
  for (let i = 0; i < 40; i++) stamp(under, 0.5, 0.5, 0.1, 0.1, 1, shield);
  assert.ok(under.left < was, 'the under-layer was never reached');

  // Everywhere the top is still whole, the rust is still whole too.
  const g = 32;
  for (let i = 0; i < g * g; i++)
    if (top.cells[i] > 0) assert.ok(under.cells[i] > 0, `cell ${i} lost its rust through the mud`);
});

test('a layered card is not clean until both of its grimes are', () => {
  const under = makeField('rust', () => true, 32, 3);
  const top = makeField('mud', () => true, 32, 2);
  const card = { id: 'a', fields: [under, top], debris: [] };
  assert.equal(cardClean(card, []), false);
  top.left = 0;
  assert.equal(cardClean(card, []), false, 'the top alone is not the card');
  under.left = 0;
  assert.equal(cardClean(card, []), true);
});

test('the badge counts both layers as one job', () => {
  // Two fields, one arc: what is owed here is the whole card, not the top of
  // it. A badge that filled and reset would read as the work being undone.
  const under = makeField('rust', () => true, 32, 3);
  const top = makeField('mud', () => true, 32, 2);
  const card = { id: 'a', fields: [under, top], debris: [] };
  const w = toolWork(card, [], 'washer', { debris: 0, webs: 0 });
  assert.equal(w.left, under.left + top.left);
  assert.equal(w.total, under.total + top.total);
  assert.equal(toolShare(w), 0, 'a freshly dealt layered card is at the start of its arc');
  top.left = 0;
  assert.ok(toolShare(toolWork(card, [], 'washer', { debris: 0, webs: 0 })) > 0,
    'clearing the top moved the arc not at all');
  assert.ok(toolShare(toolWork(card, [], 'washer', { debris: 0, webs: 0 })) < 1,
    'clearing the top finished the arc, with the rust still there');
});

test('a zero radius is a no-op rather than a divide by zero', () => {
  const f = makeField('mud', () => true);
  assert.equal(stamp(f, 0.5, 0.5, 0, 0), 0);
  assert.equal(f.left, f.total);
});

test('the wear is read off the whole disc, not off the cell under the nozzle', () => {
  // The bug this exists for: the nozzle sitting on a cell it has already
  // cleaned reported "nothing left here", which is wearShare()'s maximum-erase
  // branch - and that erase covers the forty-odd cells around it, most of
  // which still had their crust. Bare centre, dirty surroundings.
  const span = 2 * SUBS;
  const f = makeField('mud', () => true, 32, 2);
  // Clear a single cell and leave everything else alone. Aimed at a cell's
  // centre rather than at 0.5, which on a 32 grid is a boundary between four.
  const mid = 16.5 / 32;
  stamp(f, mid, mid, 0.02, 0.02, 99);
  assert.equal(f.total - f.left, 1, 'the fixture should have cleared exactly one cell');

  const wear = wearOf(f, mid, mid, 0.15, 0.15, 0.11, span);
  assert.ok(wear.before > 0.9,
    `a disc of untouched crust read ${wear.before.toFixed(3)} left`);
  assert.ok(wearShare(wear.before, wear.taken) < WEAR_MAX / 2,
    'one bare cell must not authorise the maximum erase over its neighbours');
});

test('holding the jet still on a cleaned spot does not wash away what is round it', () => {
  // A second of a still hand. tick() stamps once a frame whether or not the
  // pointer moves, so this is a real thing somebody does rather than a
  // contrived one, and it used to take the crust to 1e-13 of its alpha while
  // the grid barely moved - invisible, and still counted dirty.
  const span = 2 * SUBS;
  const f = makeField('mud', () => true, 32, 2);
  const mid = 16.5 / 32;
  stamp(f, mid, mid, 0.02, 0.02, 99);

  let alpha = 1;
  for (let frame = 0; frame < 60; frame++) {
    const wear = wearOf(f, mid, mid, 0.15, 0.15, 0.11, span);
    alpha *= 1 - wearShare(wear.before, wear.taken);
    stamp(f, mid, mid, 0.15, 0.15, 0.11);
  }
  // By now the grid has genuinely taken the disc, so the crust there *should*
  // be gone - what matters is that the two agreed on the way down rather than
  // the paint running a thousand times ahead of the count.
  const left = wearOf(f, mid, mid, 0.15, 0.15, 0, span).before;
  assert.ok(alpha >= left * 0.5,
    `the paint ran ahead of the grid: ${alpha.toExponential(2)} visible, ${left.toFixed(3)} still counted`);
});

test('the shield keeps the crust under a piece of debris from being washed through it', () => {
  const span = SUBS;
  const f = makeField('mud', () => true, 32, 1);
  const grid = 32;
  // Everything in the left half is under something.
  const skip = i => (i % grid) < grid / 2;
  const wear = wearOf(f, 0.5, 0.5, 0.2, 0.2, 1, span, skip);
  assert.ok(wear.before > 0.9, 'the crust is all still there');
  assert.ok(wear.taken > 0.3 && wear.taken < 0.7,
    `a half-shielded disc gave up ${wear.taken.toFixed(3)} of a pass`);
  assert.ok(wearShare(wear.before, wear.taken) < wearShare(wear.before, 1),
    'a shielded disc must erase less than a bare one');
});

test('a disc with nothing left in it erases outright', () => {
  // The other half of the rule: once the crust really is gone the last of it
  // must leave, rather than lingering as a film nobody can wash off.
  const f = makeField('mud', () => true, 32, 1);
  stamp(f, 0.5, 0.5, 0.3, 0.3, 99);
  const wear = wearOf(f, 0.5, 0.5, 0.15, 0.15, 1, SUBS);
  assert.deepEqual(wear, { before: 0, taken: 0 });
  assert.equal(wearShare(wear.before, wear.taken), WEAR_MAX);
});

// ---------------------------------------------------------------------------
// the crust
// ---------------------------------------------------------------------------

test('a dealt crust covers nearly the whole card', () => {
  // The reveal is the reward, and there is nothing to reveal if the crust is a
  // film over a card you can already read. 85% is the floor; the target is the
  // 90% in TUNING.cover.
  const grid = TUNING.grid;
  let worst = 1;
  let sum = 0;
  for (let seed = 1; seed <= 40; seed++) {
    for (const kind of ['mud', 'rust', 'tar']) {
      const f = makeField(kind, crustMask(crust(kind, rng(seed))), grid, 1);
      const share = f.total / (grid * grid);
      worst = Math.min(worst, share);
      sum += share;
    }
  }
  assert.ok(worst >= 0.85, `a crust covered only ${(worst * 100).toFixed(1)}% of its card`);
  const mean = sum / 120;
  assert.ok(Math.abs(mean - TUNING.cover) < 0.05,
    `crusts average ${(mean * 100).toFixed(1)}%, and TUNING.cover says ${TUNING.cover * 100}%`);
});

test('the middle of a card is always under the crust, and outside it is not', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const c = crust('mud', rng(seed));
    assert.equal(crustAt(c, 0.5, 0.5), 1, `seed ${seed} left a hole in the middle`);
    assert.equal(crustAt(c, 0.5, -0.4) < 0.35, true, 'the crust reached off the card');
  }
});

test('a spill has a shape, and a caked grime does not', () => {
  // The exception to edge-to-edge, and the reason for it: a spill that is a
  // rectangle is not a spill. Coffee and ink are meant to leave most of the
  // card showing; mud, rust, tar and a film of dust cover the lot.
  const grid = TUNING.grid;
  const share = (kind, seed) =>
    makeField(kind, crustMask(crust(kind, rng(seed))), grid, 1).total / (grid * grid);
  for (let seed = 1; seed <= 30; seed++) {
    for (const kind of ['mud', 'rust', 'tar', 'film'])
      assert.ok(share(kind, seed) >= 0.99,
        `${kind} covered only ${(share(kind, seed) * 100).toFixed(1)}% - it should be edge to edge`);
    for (const kind of ['coffee', 'ink']) {
      const s = share(kind, seed);
      assert.ok(s > 0.2 && s < 0.8, `${kind} covered ${(s * 100).toFixed(1)}% of its card`);
    }
  }
});

test('a spill is in one place on the card rather than sprayed over it', () => {
  // A blot count that drifted up, or a size that drifted down, would give a
  // speckle that reads as grain and washes like confetti. The spill's cells
  // have to hold together.
  const grid = TUNING.grid;
  for (let seed = 1; seed <= 20; seed++) {
    const c = crust('coffee', rng(seed));
    // The covered cells' spread about their own middle, as a share of the card.
    let n = 0; let mx = 0; let my = 0;
    const on = [];
    for (let iy = 0; iy < grid; iy++)
      for (let ix = 0; ix < grid; ix++) {
        const x = (ix + 0.5) / grid; const y = (iy + 0.5) / grid;
        if (crustAt(c, x, y) < 0.35) continue;
        on.push([x, y]); mx += x; my += y; n++;
      }
    assert.ok(n > 0, `seed ${seed} dealt a coffee ring with nothing in it`);
    mx /= n; my /= n;
    let far = 0;
    for (const [x, y] of on) far = Math.max(far, Math.hypot(x - mx, y - my));
    assert.ok(far < 0.75, `seed ${seed} spread its spill ${far.toFixed(2)} across the card`);
  }
});

test('a spill is see-through in the middle and darkest at its edge', () => {
  // Which is what coffee does: the liquid creeps outward and leaves its solids
  // at the boundary. Read off crustAt(), which is the same shape the surface
  // paints - a tide line drawn without a matching mask would wash off wrong.
  const c = crust('coffee', rng(3));
  const grid = TUNING.grid;
  let interior = 0; let rim = 0; let iN = 0; let rN = 0;
  for (let iy = 0; iy < grid; iy++)
    for (let ix = 0; ix < grid; ix++) {
      const x = (ix + 0.5) / grid; const y = (iy + 0.5) / grid;
      const t = crustAt(c, x, y);
      if (t <= 0) continue;
      // A cell is on the rim if any neighbour is off the spill.
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .some(([dx, dy]) => crustAt(c, x + dx / grid, y + dy / grid) <= 0);
      if (edge) { rim += t; rN++; } else { interior += t; iN++; }
    }
  assert.ok(iN > 0 && rN > 0, 'the spill has no inside or no edge');
  assert.ok(rim / rN < interior / iN,
    'the spill is not thinner at its edge, so crustAt is not describing a blot');
});

// ---------------------------------------------------------------------------
// the tank
// ---------------------------------------------------------------------------

const drain = (ms, from = fullTank()) => tankStep(from, ms, true);

test('the jet runs at full pressure for the whole of the full stretch', () => {
  assert.equal(tankPower(fullTank()), 1);
  assert.equal(tankPower(drain(TUNING.tank.fullMs)), 1, 'it faded early');
});

test('and is empty at the end of the fade, having weakened all the way down', () => {
  const { fullMs, fadeMs } = TUNING.tank;
  assert.equal(tankPower(drain(fullMs + fadeMs)), 0);
  const half = tankPower(drain(fullMs + fadeMs / 2));
  assert.ok(half > 0.35 && half < 0.65, `halfway through the fade reads ${half}`);
});

test('the fade is monotone - it never comes back on its own', () => {
  const { fullMs, fadeMs } = TUNING.tank;
  let was = 2;
  for (let ms = 0; ms <= fullMs + fadeMs; ms += 100) {
    const now = tankPower(drain(ms));
    assert.ok(now <= was + 1e-9, `pressure rose while spraying, at ${ms}ms`);
    was = now;
  }
});

test('an empty tank is full again after the refill, and not before', () => {
  const { fullMs, fadeMs, refillMs } = TUNING.tank;
  const empty = drain(fullMs + fadeMs);
  assert.equal(tankStep(empty, refillMs, false).level, 1);
  assert.ok(tankStep(empty, refillMs * 0.5, false).level < 1);
});

test('a short burst costs a short rest', () => {
  // It refills from wherever it was, not only from empty - which is what makes
  // the rhythm a rhythm rather than a queue.
  const { refillMs } = TUNING.tank;
  const used = drain(2000);
  assert.ok(used.level < 1);
  const back = tankStep(used, refillMs * (1 - used.level) + 1, false);
  assert.equal(back.level, 1);
});

test('holding the trigger on an empty tank neither drains nor fills', () => {
  const { fullMs, fadeMs } = TUNING.tank;
  const empty = drain(fullMs + fadeMs);
  assert.equal(empty.level, 0);
  assert.equal(tankStep(empty, 3000, true).level, 0);
});

// ---------------------------------------------------------------------------
// the hand
// ---------------------------------------------------------------------------

test('the glove holds a handful and then no more', () => {
  const full = Array(TUNING.handful).fill('crumbs');
  assert.equal(bulkOf(full), TUNING.handful);
  assert.equal(handRoom(full, 'crumbs'), false, 'a sixth crumb went in');
  assert.equal(handRoom(full.slice(1), 'crumbs'), true);
});

test('paper takes two of the five', () => {
  assert.equal(bulkOf(['paper']), 2);
  const nearly = Array(TUNING.handful - 1).fill('leaves');
  assert.equal(handRoom(nearly, 'leaves'), true, 'the last single space was refused');
  assert.equal(handRoom(nearly, 'paper'), false, 'paper went into a one-piece gap');
});

// ---------------------------------------------------------------------------
// cobwebs
// ---------------------------------------------------------------------------

test('the gap is between edges, and touching cards read zero', () => {
  assert.equal(gapBetween(box('a', 0, 0), box('b', 100, 0)), 0);
  assert.equal(gapBetween(box('a', 0, 0), box('b', 150, 0)), 50);
  assert.equal(gapBetween(box('a', 0, 0), box('b', 0, 0)), 0, 'overlapping cards are not apart');
});

/** A grid of cards, close enough together that every neighbouring trio is a
 *  candidate. 120 apart with 100-wide cards is a 20 gap. */
const cluster = (n, step = 120) =>
  Array.from({ length: n }, (_, i) => box(`c${i}`, (i % 4) * step, Math.floor(i / 4) * step));

test('two cards alone are never a web', () => {
  // The web takes three. A pair is what it used to be and what made it small.
  assert.deepEqual(trioWebs([box('a', 0, 0), box('b', 120, 0)], rng()), []);
});

test('cards beyond the reach get no web at all', () => {
  const far = TUNING.webGap + 500;
  const spread = [box('a', 0, 0), box('b', far, 0), box('c', 0, far)];
  assert.deepEqual(trioWebs(spread, rng()), []);
});

test('a spread-out board simply has no duster in the bar', () => {
  const spread = [box('a', 0, 0), box('b', 9000, 0), box('c', 0, 9000)];
  assert.deepEqual(trioWebs(spread, rng()), []);
});

test('all three of a web are close to each other, not passed along a chain', () => {
  // Two near neighbours plus a third that is near only one of them is a line,
  // not a corner - and the strand closing the triangle would cross the board.
  const chain = [box('a', 0, 0), box('b', 120, 0), box('c', 120, 0 + TUNING.webGap + 400)];
  assert.deepEqual(trioWebs(chain, rng()), []);

  for (const w of trioWebs(cluster(9), rng(5))) {
    const boxes = webCards(w).map(id => cluster(9).find(b => b.id === id));
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++)
        assert.ok(gapBetween(boxes[i], boxes[j]) <= TUNING.webGap,
          `${boxes[i].id} and ${boxes[j].id} are not close`);
  }
});

test('a web is never spun on three cards in a row or three in a heap', () => {
  // The sliver case, which is the other half of "sometimes it is too small":
  // a triangle with no area in it draws as one strand doubled over.
  const row = [box('a', 0, 0), box('b', 120, 0), box('c', 240, 0)];
  assert.deepEqual(trioWebs(row, rng()), [], 'three in a row is not a web');
  const heap = [box('a', 0, 0), box('b', 4, 3), box('c', 2, 6)];
  assert.deepEqual(trioWebs(heap, rng()), [], 'three in a heap is not a web');
});

test('every web that is spun is big enough to be worth drawing', () => {
  const boxes = cluster(12);
  const byId = new Map(boxes.map(b => [b.id, b]));
  const webs = trioWebs(boxes, rng(11));
  assert.ok(webs.length, 'a tight grid of twelve should carry webs');
  for (const w of webs) {
    const [a, b, c] = webCards(w).map(id => byId.get(id));
    assert.ok(spreadOf(a, b, c) >= TUNING.webArea,
      `${w.a}/${w.b}/${w.c} spans ${spreadOf(a, b, c)}, under the floor`);
  }
});

/** A scattered board, the shape a real one has: cards of varying size, thrown
 *  about. A grid is too regular to carry more than a web or two now that they
 *  may not overlap. */
function scatter(n, seed) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) =>
    ({ id: `c${i}`, x: r() * 1400, y: r() * 900, w: 160 + r() * 160, h: 120 + r() * 160 }));
}

test('the biggest webs are the ones that survive the cap', () => {
  // Closest-first was the bug: the closest trio is the one with the least room
  // between its cards, so the old rule optimised for the scrap.
  const boxes = scatter(30, 4);
  const byId = new Map(boxes.map(b => [b.id, b]));
  const spreads = trioWebs(boxes, rng(2)).map(w => {
    const [a, b, c] = webCards(w).map(id => byId.get(id));
    return spreadOf(a, b, c);
  });
  assert.ok(spreads.length > 1, `a thirty-card board carried ${spreads.length} webs`);
  for (let i = 1; i < spreads.length; i++)
    assert.ok(spreads[i] <= spreads[i - 1], 'a smaller web was taken before a bigger one');
});

test('a busy board still gets webs, and not so many that it is a net', () => {
  // The overlap rule and a cap of one web per card could between them refuse
  // everything, which would take the duster off the bar on every board. This is
  // the floor and the ceiling on that.
  let total = 0;
  for (let seed = 1; seed <= 12; seed++) total += trioWebs(scatter(30, seed), rng(seed)).length;
  const per = total / 12;
  assert.ok(per >= 2, `a thirty-card board averages ${per.toFixed(1)} webs`);
  assert.ok(per <= 9, `a thirty-card board averages ${per.toFixed(1)} webs, which is a net`);
});

test('no card is webbed to itself and no trio appears twice', () => {
  const webs = trioWebs(cluster(8), rng(7));
  const seen = new Set();
  for (const w of webs) {
    const ids = webCards(w);
    assert.equal(new Set(ids).size, 3, `${ids.join('/')} names a card twice`);
    const key = [...ids].sort().join('~');
    assert.equal(seen.has(key), false, `the trio ${key} appeared twice`);
    seen.add(key);
  }
});

test('no card carries more webs than the cap', () => {
  // A tight cluster would otherwise become a net.
  const count = new Map();
  for (const w of trioWebs(cluster(12, 110), rng(3)))
    for (const id of webCards(w)) count.set(id, (count.get(id) ?? 0) + 1);
  for (const [id, n] of count)
    assert.ok(n <= TUNING.webPerCard, `${id} carries ${n} webs`);
});

test('two webs never lie on top of one another', () => {
  // Sharing no card is not enough: two trios can interlock around each other
  // and draw two hubs and two spirals over the same ground, which reads as
  // neither web. This is the check for that, on the boards most likely to do
  // it - dense grids, where there are many trios to choose between.
  for (const [n, step] of [[9, 110], [12, 120], [16, 130], [16, 100]]) {
    for (let seed = 1; seed <= 12; seed++) {
      const boxes = cluster(n, step);
      const byId = new Map(boxes.map(b => [b.id, b]));
      const tris = trioWebs(boxes, rng(seed)).map(w => {
        const [a, b, c] = webCards(w).map(id => byId.get(id));
        const gx = (a.x + b.x + c.x) / 3;
        const gy = (a.y + b.y + c.y) / 3;
        return [a, b, c].map(p => ({
          x: gx + (p.x - gx) * TUNING.webRoom,
          y: gy + (p.y - gy) * TUNING.webRoom,
        }));
      });
      for (let i = 0; i < tris.length; i++)
        for (let j = i + 1; j < tris.length; j++)
          assert.equal(trianglesOverlap(tris[i], tris[j]), false,
            `${n}@${step} seed ${seed}: webs ${i} and ${j} overlap`);
    }
  }
});

test('the separating-axis test is not simply answering no to everything', () => {
  // A check that always said "apart" would pass the test above with nothing in
  // it, and every web on the board would be free to sit on every other.
  const tri = p => p;
  const a = tri([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }]);
  assert.equal(trianglesOverlap(a, a), true, 'a triangle must overlap itself');
  assert.equal(trianglesOverlap(a, tri([{ x: 40, y: 20 }, { x: 140, y: 20 }, { x: 90, y: 120 }])), true,
    'two triangles that plainly cross');
  assert.equal(trianglesOverlap(a, tri([{ x: 400, y: 0 }, { x: 500, y: 0 }, { x: 450, y: 100 }])), false,
    'two triangles far apart');
  // The case bounding boxes get wrong: boxes overlap, triangles do not.
  assert.equal(trianglesOverlap(
    tri([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }]),
    tri([{ x: 100, y: 100 }, { x: 20, y: 100 }, { x: 100, y: 20 }]),
  ), false, 'boxes may overlap where the triangles do not');
});

// ---------------------------------------------------------------------------
// the middle of a web
// ---------------------------------------------------------------------------

/** A frame of three sides, as clean.ts hands it over: each side leaves one card
 *  and lands on the next, and a card's two anchors are a little apart. */
const FRAME = [
  { ax: 0, ay: 0, bx: 390, by: 60, sag: 60 },
  { ax: 400, ay: 66, bx: 190, by: 336, sag: 52 },
  { ax: 176, ay: 340, bx: -6, by: 10, sag: 58 },
];

/** A point `t` along one side's drawn curve, the same quadratic art.ts bends. */
const onSide = (s, t) => {
  const k = 1 - t;
  return {
    x: k * k * s.ax + 2 * k * t * ((s.ax + s.bx) / 2) + t * t * s.bx,
    y: k * k * s.ay + 2 * k * t * ((s.ay + s.by) / 2 + s.sag) + t * t * s.by,
  };
};

/** How far a point is from a side's curve. Sampled finely enough that the gaps
 *  between samples are well under the tolerance the callers ask for - at 400 a
 *  400-unit side steps one unit at a time. Sampling at 100 made this report two
 *  units of error on a curve the point was exactly on. */
function nearestOnSide(side, p) {
  let best = Infinity;
  for (let i = 0; i <= 400; i++) {
    const q = onSide(side, i / 400);
    best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y));
  }
  return best;
}

test('the middle of a web is drawn as numbers and not as NaN', () => {
  // The failure this exists for is silent and total: one NaN anywhere in a `d`
  // and the browser drops the whole path, so the web - frame and all - simply
  // is not there, with nothing in the console to say so.
  const { d, hub, spokes, drop } = webCore(FRAME);
  assert.ok(d.length > 0, 'the middle drew nothing at all');
  for (const n of d.match(/-?\d+(\.\d+)?/g) ?? [])
    assert.ok(Number.isFinite(Number(n)), `${n} is not a number`);
  assert.ok(Number.isFinite(hub.x) && Number.isFinite(hub.y), 'the hub is not a point');
  assert.equal(spokes.length, drop.length);
  for (const s of spokes) assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y));
});

test('every radius lands on the frame, not near it', () => {
  // The bug this exists for: the middle used to run its spokes to three corner
  // points, so it met the outside only where the frame threads already met
  // each other and was otherwise a separate drawing sharing a bounding box. A
  // radius has to be tied to the thread that is on screen - which sags, and is
  // nowhere near the straight line between the corners at its middle.
  const { spokes } = webCore(FRAME);
  assert.ok(spokes.length >= 12, `only ${spokes.length} radii`);
  for (const s of spokes) {
    const best = Math.min(...FRAME.map(side => nearestOnSide(side, s)));
    assert.ok(best < 1, `a radius landed ${best.toFixed(1)} from the frame`);
  }
});

test('the radii land all the way round the frame, not bunched on one side', () => {
  const { spokes } = webCore(FRAME);
  // At least three on each side: a web anchored to one edge is a curtain.
  for (const side of FRAME) {
    const near = spokes.filter(s => nearestOnSide(side, s) < 1);
    assert.ok(near.length >= 3, `one side took only ${near.length} radii`);
  }
});

test('the hub hangs below the middle of the frame', () => {
  const { hub } = webCore(FRAME);
  let cy = 0;
  for (const s of FRAME) cy += s.ay + s.by;
  assert.ok(hub.y > cy / 6, 'the hub does not hang');
});

test('a web is spun once: the same frame always draws the same middle', () => {
  // The path is written at build time and never again, so anything that
  // re-rolled here would be a web that changed shape when nothing touched it.
  assert.equal(webCore(FRAME).d, webCore(FRAME).d);
  const moved = [{ ...FRAME[0], ax: 10 }, FRAME[1], FRAME[2]];
  assert.notEqual(webCore(FRAME).d, webCore(moved).d);
});

test('the spiral is a spiral and never closes into rings', () => {
  const { d } = webCore(FRAME);
  const runs = d.match(/M/g)?.length ?? 0;
  // Fifteen radii, four turns of spiral across them, two turns of hub
  // scaffold, a couple of loose threads and five specks, less the gaps.
  assert.ok(runs > 60, `the middle drew ${runs} runs, which is radii and little else`);
  assert.ok(d.includes('Q'), 'nothing in the middle curves, so nothing in it sags');
});

test('a web holds all three of its cards back, and letting go frees all three', () => {
  const web = { a: 'a', b: 'b', c: 'c' };
  for (const id of ['a', 'b', 'c']) {
    assert.equal(webHolds(web, id), true);
    assert.equal(cardClean({ id, fields: [], debris: [] }, [web]), false, `${id} should be held`);
    assert.equal(cardClean({ id, fields: [], debris: [] }, []), true, `${id} should be free`);
  }
  assert.equal(webHolds(web, 'd'), false, "someone else's web is not its problem");
});

// ---------------------------------------------------------------------------
// muddy tracks
// ---------------------------------------------------------------------------

/** A board wide enough to walk across. */
const walkable = n => Array.from({ length: n }, (_, i) =>
  box(`c${i}`, (i % 4) * 300, Math.floor(i / 4) * 300, 200, 200));

test('a small board is never walked across', () => {
  // There is no "across the board" on two cards, and a trail that starts and
  // stops inside one screen reads as litter rather than as somebody passing.
  for (let seed = 1; seed <= 20; seed++)
    for (let n = 0; n < TUNING.trackCards; n++)
      assert.deepEqual(planTracks(walkable(n), rng(seed)), [],
        `${n} cards got a trail`);
});

test('about half of big boards get a trail, and it is never endless', () => {
  let with_ = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const t = planTracks(walkable(9), rng(seed));
    if (!t.length) continue;
    with_++;
    assert.ok(t.length >= 4, `a trail of only ${t.length} prints is not a walk`);
    assert.ok(t.length <= TUNING.trackMax, `a trail of ${t.length} prints is a job`);
  }
  assert.ok(with_ > 20 && with_ < 70, `${with_} of 80 boards got a trail`);
});

test('the prints are numbers, and alternate feet', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const t = planTracks(walkable(9), rng(seed));
    if (!t.length) continue;
    for (const p of t) {
      for (const v of [p.x, p.y, p.rot])
        assert.ok(Number.isFinite(v), `seed ${seed} planted a print at ${p.x},${p.y} facing ${p.rot}`);
      assert.ok(p.side === 1 || p.side === -1, `side ${p.side}`);
    }
    // Left, right, left: somebody walking puts one foot either side of the line
    // they walk along, and a trail that does not alternate is a hopping man.
    for (let i = 1; i < t.length; i++)
      assert.notEqual(t[i].side, t[i - 1].side, `seed ${seed} put two ${t[i].side} feet in a row`);
  }
});

test('the prints are evenly spaced however hard the walk bends', () => {
  // Stepped by arc length, not by curve parameter - stepping in `t` bunches
  // the prints wherever the curve is tightest, which is a walk that slows down
  // in the corners.
  for (let seed = 1; seed <= 40; seed++) {
    const t = planTracks(walkable(9), rng(seed));
    if (t.length < 3) continue;
    const gaps = [];
    for (let i = 1; i < t.length; i++) gaps.push(Math.hypot(t[i].x - t[i - 1].x, t[i].y - t[i - 1].y));
    const lo = Math.min(...gaps);
    const hi = Math.max(...gaps);
    assert.ok(hi < lo * 2.2, `seed ${seed} spaced its prints ${lo.toFixed(0)} to ${hi.toFixed(0)} apart`);
  }
});

test('the walk crosses the board rather than starting in the middle of it', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const boxes = walkable(9);
    const t = planTracks(boxes, rng(seed));
    if (!t.length) continue;
    let x0 = Infinity; let x1 = -Infinity;
    for (const b of boxes) { x0 = Math.min(x0, b.x - b.w / 2); x1 = Math.max(x1, b.x + b.w / 2); }
    assert.ok(t[0].x < x0, `seed ${seed} began its walk inside the board`);
    assert.ok(t[t.length - 1].x > x1, `seed ${seed} ended its walk inside the board`);
  }
});

test('a print is a sole with tread cut out of it, not a blob', () => {
  // The tread is where the boot did *not* touch the floor. Drawn as marks
  // instead it reads as a rubber stamp, which was the first attempt.
  const g = 40;
  let on = 0;
  for (let iy = 0; iy < g; iy++)
    for (let ix = 0; ix < g; ix++) if (bootAt((ix + 0.5) / g, (iy + 0.5) / g)) on++;
  const share = on / (g * g);
  assert.ok(share > 0.15 && share < 0.55, `the sole covers ${(share * 100).toFixed(0)}% of its box`);
  assert.equal(bootAt(0.5, -0.2), 0, 'the print reached outside its box');
  assert.equal(bootAt(1.4, 0.5), 0, 'the print reached outside its box');
  // The arch: a gap right across, between sole and heel.
  for (let ix = 0; ix < g; ix++)
    assert.equal(bootAt((ix + 0.5) / g, 0.6), 0, 'the boot has no arch');
  // And there is tread: some row inside the sole is broken by it.
  const row = y => Array.from({ length: g }, (_, ix) => bootAt((ix + 0.5) / g, y));
  assert.ok([0.2, 0.3, 0.4, 0.5].some(y => row(y).every(v => !v)),
    'no tread bar was ever cut out of the sole');
});

test('the board is not spotless while a print is still on the floor', () => {
  const cards = [clean('a'), clean('b')];
  assert.equal(tally(cards, [], 0, false, 3).done, false, 'footprints must hold the board back');
  assert.equal(tally(cards, [], 0, false, 0).done, true);
  // But the count in the bar stays cards: a number that jumped about as the
  // trail came up would not match what anybody can see.
  assert.deepEqual(
    { clean: tally(cards, [], 0, false, 3).clean, total: tally(cards, [], 0, false, 3).total },
    { clean: 2, total: 2 },
  );
});

// ---------------------------------------------------------------------------
// counting
// ---------------------------------------------------------------------------

const clean = id => ({ id, fields: [], debris: [] });

test('a card with a web attached is not clean however clear its own fields are', () => {
  const card = clean('a');
  assert.equal(cardClean(card, []), true);
  assert.equal(cardClean(card, [{ a: 'a', b: 'b', c: 'c' }]), false, 'the web must hold it back');
  assert.equal(cardClean(card, [{ a: 'c', b: 'a', c: 'b' }]), false, 'from whichever corner');
  assert.equal(cardClean(card, [{ a: 'b', b: 'c', c: 'd' }]), true, "someone else's web is not its problem");
});

test('a web holds all three of its cards back', () => {
  const webs = [{ a: 'a', b: 'b', c: 'c' }];
  const cards = [clean('a'), clean('b'), clean('c'), clean('d')];
  assert.deepEqual(tally(cards, webs), { clean: 1, total: 4, done: false });
  assert.deepEqual(tally(cards, []), { clean: 4, total: 4, done: true });
});

test('a loaded glove frees the cards it emptied but not the board', () => {
  // Off the cards, so they count clean; still in your hand, so nothing is done.
  // The glove is the only tool this can be true of - the duster clears a strand
  // outright and never holds one.
  const cards = [clean('a'), clean('b')];
  assert.deepEqual(tally(cards, [], 0, true), { clean: 2, total: 2, done: false });
  assert.deepEqual(tally(cards, [], 0, false), { clean: 2, total: 2, done: true });
});

test('debris tipped out onto the board holds the board back', () => {
  const cards = [clean('a')];
  assert.equal(tally(cards, [], 3).done, false, 'a board with litter on it is not spotless');
  assert.equal(tally(cards, [], 0).done, true);
});

test('one speck of debris is enough to hold a card back', () => {
  const card = { id: 'a', fields: [], debris: [{}] };
  assert.equal(cardClean(card, []), false);
});

test('a card is clean once every field is past the threshold', () => {
  const f = makeField('mud', () => true);
  const card = { id: 'a', fields: [f], debris: [] };
  assert.equal(cardClean(card, []), false);
  f.left = 0;
  assert.equal(cardClean(card, []), true);
});

// ---------------------------------------------------------------------------
// what the tool in hand still owes a card - the badge at its corner
// ---------------------------------------------------------------------------

/** No pieces and no strands dealt, which is most of the cases below. */
const NONE = { debris: 0, webs: 0 };

test('each family is counted for its own tool and for no other', () => {
  const f = makeField('mud', () => true);
  const card = { id: 'a', fields: [f], debris: [{ kind: 'leaves' }], webs: 0 };
  const webs = [{ a: 'a', b: 'b', c: 'c' }];
  const dealt = { debris: 1, webs: 1 };

  assert.equal(toolWork(card, webs, 'washer', dealt).left, f.left, 'the crust is the washer\'s');
  assert.equal(toolWork(card, webs, 'glove', dealt).left, 1, 'the leaf is the glove\'s');
  assert.equal(toolWork(card, webs, 'duster', dealt).left, 1, 'the strand is the duster\'s');

  // And a tool is never handed another family's denominator, which would make
  // its arc start part-way round for work it cannot do.
  assert.equal(toolWork(card, webs, 'duster', dealt).total, 1);
  assert.equal(toolWork(card, webs, 'glove', dealt).total, 1);
});

test('every tool answers for every card, and never owes more than it was dealt', () => {
  const f = makeField('tar', () => true);
  const cards = [
    { id: 'a', fields: [], debris: [] },
    { id: 'a', fields: [f], debris: [] },
    { id: 'a', fields: [], debris: [{ kind: 'gum' }, { kind: 'cap' }] },
  ];
  for (const card of cards) {
    for (const { id } of TOOLS) {
      const w = toolWork(card, [{ a: 'a', b: 'b', c: 'c' }], id, { debris: 2, webs: 1 });
      assert.ok(w.left >= 0 && w.total >= 0, `${id} returned a negative`);
      assert.ok(w.left <= w.total, `${id} owes ${w.left} of ${w.total}`);
    }
  }
});

test('a tool with nothing to do here is finished with the card', () => {
  // The check-by-default rule: picking the washer up on a board with no grime
  // on it shows a check everywhere rather than an empty ring nobody can read.
  const card = { id: 'a', fields: [], debris: [] };
  const w = toolWork(card, [], 'washer', NONE);
  assert.deepEqual(w, { left: 0, total: 0 });
  assert.equal(toolWanted(w), false);
  assert.equal(toolShare(w), 1, 'no work is a closed circle, not an empty one');
});

test('a web is owed by all three of the cards it names', () => {
  const webs = [{ a: 'a', b: 'b', c: 'c' }];
  const dealt = { debris: 0, webs: 1 };
  for (const id of ['a', 'b', 'c']) {
    const w = toolWork({ id, fields: [], debris: [] }, webs, 'duster', dealt);
    assert.equal(toolWanted(w), true, `${id} should still owe the web`);
    assert.equal(toolShare(w), 0);
  }
  // Swept: the same card, the same denominator, and nothing left.
  const swept = toolWork({ id: 'a', fields: [], debris: [] }, [], 'duster', dealt);
  assert.equal(toolWanted(swept), false);
  assert.equal(toolShare(swept), 1);
});

test('the badge fills as the jet works and is full before the field dissolves', () => {
  const f = makeField('mud', () => true);
  const card = { id: 'a', fields: [f], debris: [] };
  const share = () => toolShare(toolWork(card, [], 'washer', NONE));

  assert.equal(share(), 0);
  let last = 0;
  for (let i = 0; i < 12 && !fieldClear(f); i++) {
    stamp(f, 0.5, 0.5, 0.5, 0.5, 1);
    const now = share();
    assert.ok(now >= last, `the arc went backwards: ${last} then ${now}`);
    last = now;
  }
  assert.ok(last > 0, 'twelve passes over the whole card moved nothing');
});

test('the badge routes by the mess table and not by a family written out here', () => {
  // The guard for kinds added later: coffee, ink and film went to the washer,
  // tape and sticky notes to the glove, and nothing here had to be told.
  // Whichever tool a kind names in MESS is the tool that must see it.
  for (const kind of DEBRIS) {
    const card = { id: 'a', fields: [], debris: [{ kind }] };
    const owed = TOOLS.filter(t => toolWork(card, [], t.id, { debris: 1, webs: 0 }).left > 0);
    assert.deepEqual(owed.map(t => t.id), [MESS[kind].tool], `${kind} went to the wrong tool`);
  }
  for (const kind of GRIMES) {
    const card = { id: 'a', fields: [makeField(kind, () => true)], debris: [] };
    const owed = TOOLS.filter(t => toolWork(card, [], t.id, NONE).left > 0);
    assert.deepEqual(owed.map(t => t.id), [MESS[kind].tool], `${kind} went to the wrong tool`);
  }
});

// ---------------------------------------------------------------------------
// the jet
// ---------------------------------------------------------------------------

test('the jet is tight and hard slow, wide and light fast', () => {
  // Within a rounding error, not to the bit: a row in the middle of the curve
  // is reached by interpolating to t=1, and `1.6 + (0.22 - 1.6)` is not 0.22.
  const near = (got, want, what) =>
    assert.ok(Math.abs(got - want) < 1e-9, `${what}: ${got} is not ${want}`);
  for (const row of TUNING.jet) {
    const got = jetShape(row.speed);
    near(got.radius, row.radius, `radius at ${row.speed}`);
    near(got.bite, row.bite, `bite at ${row.speed}`);
  }
});

test('the jet curve is flat outside its rows', () => {
  const slow = TUNING.jet[0];
  const fast = TUNING.jet[TUNING.jet.length - 1];
  // No extra reward for holding perfectly still: that would be a thing to be
  // good at rather than a thing to notice.
  assert.deepEqual(jetShape(0), { radius: slow.radius, bite: slow.bite });
  assert.deepEqual(jetShape(-5), { radius: slow.radius, bite: slow.bite });
  assert.deepEqual(jetShape(99999), { radius: fast.radius, bite: fast.bite });
});

test('radius only grows and bite only shrinks as the hand speeds up', () => {
  let last = jetShape(0);
  for (let speed = 10; speed <= 1000; speed += 10) {
    const now = jetShape(speed);
    assert.ok(now.radius >= last.radius, `radius fell at ${speed}`);
    assert.ok(now.bite <= last.bite, `bite rose at ${speed}`);
    assert.ok(Number.isFinite(now.radius) && Number.isFinite(now.bite));
    last = now;
  }
});

test('the jet interpolates between the rows rather than stepping', () => {
  const [a, b] = TUNING.jet;
  const mid = jetShape((a.speed + b.speed) / 2);
  assert.ok(mid.radius > a.radius && mid.radius < b.radius);
  assert.ok(mid.bite < a.bite && mid.bite > b.bite);
});

/** What a pass of the jet actually takes off a card: its **area** times its
 *  bite, not its width times its bite. A wider jet covers more cells and puts
 *  each of them under more overlapping stamps, and the two multiply. Measured
 *  against the width alone the curve read as a trade while being flat, which is
 *  how "go fast" stayed the best way to use the washer through two tunings. */
const jetWork = speed => {
  const { radius, bite } = jetShape(speed);
  return radius * radius * bite;
};

test('going slowly is worth it: the work a pass does falls as the hand speeds up', () => {
  let last = Infinity;
  for (let speed = 0; speed <= 900; speed += 25) {
    const work = jetWork(speed);
    assert.ok(work <= last + 1e-9, `work rose at ${speed}: ${work} after ${last}`);
    last = work;
  }
});

test('a slow hand does several times the work of a fast one, not a fraction more', () => {
  // A fast sweep covers roughly twice the ground of a slow one, so anything
  // short of a wide margin here is going fast being free.
  assert.ok(
    jetWork(0) > jetWork(900) * 3,
    `slow ${jetWork(0).toFixed(3)} must beat fast ${jetWork(900).toFixed(3)} by more than 3x`,
  );
  // And the middle of the curve must not be a flat spot either: it was, and a
  // normal sweep was as good as a crawl while covering twice as much card.
  assert.ok(jetWork(40) > jetWork(250) * 1.3, 'a crawl must beat an ordinary sweep clearly');
});

// ---------------------------------------------------------------------------
// dealing
// ---------------------------------------------------------------------------

test('every board with cards has work for the glove and for the washer', () => {
  // Not for the duster: webs need two cards close together, and a spread-out
  // board simply does not show that slot.
  for (let seed = 1; seed <= 40; seed++) {
    const boxes = Array.from({ length: 4 }, (_, i) => box(`c${i}`, i * 300, 0));
    const plan = planBoard(boxes, rng(seed));
    assert.ok(plan.cards.some(c => c.fields.length), `seed ${seed} dealt no grime at all`);
    assert.ok(plan.cards.some(c => c.debris.length), `seed ${seed} dealt no debris at all`);
  }
});

test('no card is left untouched', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const boxes = Array.from({ length: 6 }, (_, i) => box(`c${i}`, i * 400, 0));
    for (const card of planBoard(boxes, rng(seed)).cards)
      assert.ok(card.fields.length || card.debris.length,
        `seed ${seed} left ${card.id} clean on a dirty board`);
  }
});

test('an empty board plans nothing and asks for nothing', () => {
  const plan = planBoard([], rng());
  assert.deepEqual(plan.cards, []);
  assert.deepEqual(plan.webs, []);
});

test('a card carries one grime or two, never more, and debris may lie on either', () => {
  // A card used to be held to one grime, on the reasoning that two would be two
  // reveals fighting for the same pixels. They are not, so long as the top one
  // shields the one under it: the jet takes the mud off and what is underneath
  // is still not the card, which is the reveal happening twice. Three would be.
  let stacked = 0;
  let layered = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const boxes = Array.from({ length: 5 }, (_, i) => box(`c${i}`, i * 400, 0));
    for (const card of planBoard(boxes, rng(seed)).cards) {
      assert.ok(card.fields.length <= 2, `seed ${seed} dealt ${card.id} ${card.fields.length} grimes`);
      if (card.fields.length === 2) layered++;
      if (card.fields.length && card.debris.length) stacked++;
    }
  }
  assert.ok(stacked > 0, 'debris never once landed on grime - the deal is not independent');
  assert.ok(layered > 0, 'no card was ever dealt two layers');
});

test('a layered card is dealt bottom first, and the top is the shallower', () => {
  // Order is load-bearing: clean.ts shields a field with everything after it in
  // the list. Reversed, the jet would be shielded from the layer on top by the
  // one underneath and the card could never be cleaned at all.
  for (const [top, under] of LAYERS) {
    assert.ok(TUNING.depth[top] <= TUNING.depth[under],
      `${top} over ${under} puts the deeper grime on top`);
    assert.equal(MESS[top].family, 'field');
    assert.equal(MESS[under].family, 'field');
  }
  for (let seed = 1; seed <= 60; seed++) {
    const boxes = Array.from({ length: 6 }, (_, i) => box(`c${i}`, i * 400, 0));
    for (const card of planBoard(boxes, rng(seed)).cards) {
      if (card.fields.length !== 2) continue;
      const [under, top] = card.fields;
      assert.ok(LAYERS.some(([t, u]) => t === top && u === under),
        `${top} over ${under} is not a pair anybody allowed`);
    }
  }
});

test('a layer is only dealt where both its halves suit the card', () => {
  // A note is not given mud over rust merely because the pair exists - both
  // halves have to be grimes that type can get in the first place.
  for (const type of [...Object.keys(GRIME_FOR), 'sticker', undefined]) {
    const allowed = grimesFor(type);
    for (const [top, under] of layersFor(type)) {
      assert.ok(allowed.includes(top), `${type} may be dealt ${top} on top, which it cannot get`);
      assert.ok(allowed.includes(under), `${type} may be dealt ${under} under, which it cannot get`);
    }
  }
  // And the mechanism is reachable: at least one type can actually be layered,
  // or layeredChance is a number that does nothing.
  assert.ok(Object.keys(GRIME_FOR).some(t => layersFor(t).length), 'no card type can be layered');
});

test('every dealt mess is one the table knows, and debris sits on the card', () => {
  const plan = planBoard(Array.from({ length: 6 }, (_, i) => box(`c${i}`, i * 300, 0)), rng(11));
  for (const card of plan.cards) {
    for (const kind of card.fields) assert.equal(MESS[kind].family, 'field');
    for (const d of card.debris) {
      assert.equal(MESS[d.kind].family, 'debris');
      assert.ok(d.x >= 0 && d.x <= 1 && d.y >= 0 && d.y <= 1, 'debris landed off the card');
    }
  }
});

test('gum is a single stuck thing, and paper and caps come in ones and twos', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const plan = planBoard([box('a', 0, 0)], rng(seed));
    const debris = plan.cards[0].debris;
    const count = kind => debris.filter(d => d.kind === kind).length;
    assert.ok(count('gum') <= 1, `seed ${seed} dealt ${count('gum')} pieces of gum to one card`);
    for (const kind of ['paper', 'cap', 'dust', 'tape', 'sticky'])
      assert.ok(count(kind) <= TUNING.fewPieces[1],
        `seed ${seed} dealt ${count(kind)} of ${kind} to one card`);
  }
});

// ---------------------------------------------------------------------------
// tape and sticky notes
// ---------------------------------------------------------------------------

test('tape and a sticky note are glove debris, one bulk each, and are dealt', () => {
  for (const kind of ['tape', 'sticky']) {
    assert.equal(MESS[kind].family, 'debris', `${kind} is not debris`);
    assert.equal(MESS[kind].tool, 'glove', `${kind} is not the glove's`);
    assert.equal(MESS[kind].bulk, 1, `${kind} should take one place in the hand`);
    assert.ok(DEBRIS.includes(kind), `${kind} is in the table but never dealt`);
  }
});

test('only stuck things peel, and tape takes longer than a note', () => {
  assert.equal(peelFor('tape'), 700);
  assert.equal(peelFor('sticky'), 400);
  // Everything else lifts on a touch, gum included - gum keeps its tugs.
  for (const kind of Object.keys(MESS))
    if (kind !== 'tape' && kind !== 'sticky') assert.equal(peelFor(kind), 0, `${kind} peels`);
  // A peel is a glove thing: a peel time on a field or a web would be a number
  // nothing ever reads.
  for (const kind of Object.keys(TUNING.peelMs)) {
    assert.ok(kind in MESS, `peelMs names ${kind}, which is not a mess`);
    assert.equal(MESS[kind].tool, 'glove', `${kind} peels but is not the glove's`);
  }
});

test('a board that deals debris long enough deals tape and notes too', () => {
  // Not a rate - only that neither is a drawing nobody will ever see.
  const seen = new Set();
  for (let seed = 1; seed <= 400 && seen.size < 2; seed++) {
    for (const card of planBoard([box('a', 0, 0)], rng(seed)).cards)
      for (const d of card.debris) if (d.kind === 'tape' || d.kind === 'sticky') seen.add(d.kind);
  }
  assert.deepEqual([...seen].sort(), ['sticky', 'tape']);
});

test('a patch is one kind of debris, not a sweepings pile', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const boxes = Array.from({ length: 4 }, (_, i) => box(`c${i}`, i * 400, 0));
    for (const card of planBoard(boxes, rng(seed)).cards) {
      const kinds = new Set(card.debris.map(d => d.kind));
      assert.ok(kinds.size <= 1, `seed ${seed} gave ${card.id} ${kinds.size} kinds of debris`);
    }
  }
});
