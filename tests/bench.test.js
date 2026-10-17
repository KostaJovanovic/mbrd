// The benchmark's arithmetic and its file, without a browser: how gaps are
// read, how a series is stored, what the standard board is made of, and what
// a result is called. Everything that is a frame needs a browser and is
// checked by running it (research/bench-2026-09-23.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  frameStats, summariseGaps, encodeSeries, decodeSeries, gapsOf, scoredGaps, spread,
  mulberry32, jpegWithComment, pngWithText, crc32,
} from '../web/assets/js/perf/frames.ts';
import {
  planStandardBoard, DEFAULT_SEED, HISTORY_STEPS,
} from '../web/assets/js/perf/bench-board.ts';
import {
  SCENARIOS, parseBenchHash, benchFileName, deviceName, switchWords, longFrameTotals,
  fingerprint, summaryLine, rebeat, BENCH_SCHEMA,
} from '../web/assets/js/perf/bench.ts';

// ---- reading gaps ----------------------------------------------------------

test('the beat is the fast end of the run, and the tail is counted in it', () => {
  // A 120 Hz run: ninety clean frames, five two-beat gaps, five of three.
  const beat = 1000 / 120;
  const gaps = [...Array(90).fill(beat), ...Array(5).fill(2 * beat), ...Array(5).fill(3 * beat)];
  const s = frameStats(gaps);
  assert.ok(Math.abs(s.base - beat) < 1e-9);
  assert.equal(s.twos, 5);
  assert.equal(s.overs, 5);
  assert.equal(s.off, 0, 'whole beats are never off the beat');
  const m = summariseGaps(gaps);
  assert.equal(m.n, 100);
  assert.equal(m.fps, 120);
  assert.equal(m.twoBeatPct, 5);
  assert.equal(m.threePlusPct, 5);
  assert.equal(m.worst, 25);
});

test('a stretch at 60 Hz on a 120 Hz panel is two beats, not three', () => {
  const gaps = [...Array(50).fill(8.33), ...Array(50).fill(16.67)];
  const m = summariseGaps(gaps);
  assert.equal(m.threePlusPct, 0, 'a refresh-rate drop is not accused');
  assert.equal(m.twoBeatPct, 50);
});

test('an empty run reads as zeros rather than NaN', () => {
  const m = summariseGaps([]);
  assert.deepEqual(Object.values(m).filter(v => !Number.isFinite(v)), []);
  assert.equal(m.n, 0);
});

test('a scenario that never reached the display\'s rate is counted in the run\'s beat', () => {
  // Every frame of it 60 ms, on a run whose beat was 8.3: its own 5th
  // percentile is a slow frame, and against that nothing was ever dropped.
  const times = [0];
  for (let i = 0; i < 60; i++) times.push(times[times.length - 1] + 60);
  const own = summariseGaps(scoredGaps(times, 150));
  assert.equal(own.threePlusPct, 0, 'counted in its own beat, the scrub drops nothing');
  const results = [{ id: 'timeline', name: '', runs: [{ summary: { ...own }, frames: encodeSeries(times) }] }];
  rebeat(results, 1000 / 120);
  const s = results[0].runs[0].summary;
  assert.equal(s.threePlusPct, 100, 'in the run\'s, every frame is a lost one');
  assert.equal(s.beatFrom, 'run');
  // A scenario at the display's rate keeps its own beat.
  const quick = [{ id: 'x', name: '', runs: [{ summary: { beatMs: 8.4, threePlusPct: 0 }, frames: { t0: 0, d: [] } }] }];
  rebeat(quick, 1000 / 120);
  assert.equal(quick[0].runs[0].summary.beatFrom, undefined);
});

test('the warm-up is not scored', () => {
  const times = [0, 100, 200, 208, 216, 224];
  assert.deepEqual(scoredGaps(times, 150), [100, 8, 8, 8], 'gaps ending after the first 150 ms');
  assert.deepEqual(gapsOf(times), [100, 100, 8, 8, 8]);
});

// ---- the series ------------------------------------------------------------

test('a series survives the file to within a tenth of a millisecond', () => {
  const rand = mulberry32(7);
  let t = 1234.5678;
  const times = [t];
  for (let i = 0; i < 500; i++) { t += 8 + rand() * 30; times.push(t); }
  const coded = encodeSeries(times);
  assert.ok(coded.d.every(Number.isInteger), 'whole tenths');
  const back = decodeSeries(coded);
  assert.equal(back.length, times.length);
  const worst = Math.max(...back.map((v, i) => Math.abs(v - times[i])));
  assert.ok(worst <= 0.05 + 1e-9, `drifted by ${worst} ms`);
  assert.ok(JSON.stringify(coded).length < 5 * times.length, 'a few bytes a frame');
});

test('the spread across repeats is the range as a share of the mean', () => {
  assert.deepEqual(spread([100, 110, 90]), { min: 90, max: 110, rangePct: 20 });
  assert.deepEqual(spread([]), { min: 0, max: 0, rangePct: 0 });
});

// ---- one picture, many assets ----------------------------------------------

test('a comment segment goes in after SOI and nothing else moves', () => {
  const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xd9);
  const out = jpegWithComment(jpeg, 'card 7');
  assert.deepEqual([...out.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xfe]);
  const len = (out[4] << 8) | out[5];
  assert.equal(len, 2 + 'card 7'.length);
  assert.equal(new TextDecoder().decode(out.subarray(6, 6 + len - 2)), 'card 7');
  assert.deepEqual([...out.subarray(4 + len)], [...jpeg.subarray(2)], 'the rest is the original');
  assert.notDeepEqual(jpegWithComment(jpeg, 'card 8'), out, 'two cards, two files');
  assert.throws(() => jpegWithComment(Uint8Array.of(1, 2, 3, 4), 'x'), /not a JPEG/);
});

test('a tEXt chunk goes in after IHDR with a CRC a strict reader accepts', () => {
  assert.equal(crc32(new TextEncoder().encode('IEND')), 0xae426082, 'the CRC every PNG ends on');
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...Array(13).fill(1), 0, 0, 0, 0];
  const iend = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  const png = Uint8Array.from([...sig, ...ihdr, ...iend]);
  const out = pngWithText(png, 'card 3');
  const view = new DataView(out.buffer);
  const len = view.getUint32(33);
  assert.equal(new TextDecoder().decode(out.subarray(37, 41)), 'tEXt');
  assert.equal(view.getUint32(41 + len), crc32(out.subarray(37, 41 + len)));
  assert.deepEqual([...out.subarray(45 + len)], iend, 'IEND still closes it');
  assert.throws(() => pngWithText(Uint8Array.of(1, 2, 3), 'x'), /not a PNG/);
});

// ---- the standard board ----------------------------------------------------

test('the standard board is the same board from the same seed, and another from another', () => {
  const a = planStandardBoard(DEFAULT_SEED);
  assert.deepEqual(planStandardBoard(DEFAULT_SEED), a);
  assert.notDeepEqual(planStandardBoard(DEFAULT_SEED + 1).cards, a.cards);
});

test('the standard board is ~120 cards, mostly camera photographs', () => {
  const { cards, connections, fences, tour, moves } = planStandardBoard();
  const count = kind => cards.filter(c => c.kind === kind).length;
  assert.equal(cards.length, 120);
  assert.equal(count('photo'), 88);
  assert.ok(count('screenshot') && count('note') && count('swatch') && count('sticker'));
  assert.equal(new Set(cards.filter(c => c.kind === 'photo').map(c => c.base)).size, 4,
    'every base picture of a shape is used');
  assert.equal(connections.length, 8);
  for (const [a, b] of connections) {
    assert.notEqual(a, b);
    assert.ok(cards[a].kind !== 'sticker' && cards[b].kind !== 'sticker', 'a sticker is never an end');
  }
  assert.equal(fences.length, 2);
  assert.deepEqual(tour.map(s => s.length), [3, 3, 3]);
  assert.ok(tour.flat().every(i => cards[i].kind === 'photo'));
  assert.equal(moves.length, HISTORY_STEPS);
  // Centred on the origin, so the fit and the recenter scenarios frame the same place.
  const xs = cards.map(c => c.x), ys = cards.map(c => c.y);
  assert.ok(Math.abs(Math.max(...xs) + Math.min(...xs)) < 400);
  assert.ok(Math.abs(Math.max(...ys) + Math.min(...ys)) < 400);
});

// ---- the file --------------------------------------------------------------

test('every scenario has a distinct id, which is what the compare tool pairs on', () => {
  const ids = SCENARIOS.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length >= 14);
  assert.ok(ids.every(id => /^[a-z0-9-]+$/.test(id)));
  // The ones that move cards, need a history or switch the layout never run
  // on the user's board.
  const guarded = SCENARIOS.filter(s => s.standardOnly).map(s => s.id).sort();
  assert.deepEqual(guarded, ['feed', 'rearrange', 'timeline']);
});

test('the address carries the switches, and says what it did not understand', () => {
  const p = parseBenchHash('#bench:quality=light,grid=off,grain=0,whimsy=2,repeat=3,seed=42,only=zoom-sweep.pan-fit,bogus=1');
  assert.deepEqual(p.options.switches, { quality: 'light', grid: false, grain: false, whimsy: 2 });
  assert.equal(p.options.repeat, 3);
  assert.deepEqual(p.options.only, ['zoom-sweep', 'pan-fit']);
  assert.equal(p.seed, 42);
  assert.deepEqual(p.unknown, ['bogus=1']);
  assert.deepEqual(parseBenchHash('#bench'), { options: {}, seed: null, unknown: [], open: false });
  assert.deepEqual(parseBenchHash('#bench:repeat=9').unknown, ['repeat=9'], 'five repeats at most');
});

test('#bench:board opens the standard board with nothing run, and nothing else does', () => {
  assert.equal(parseBenchHash('#bench:board').open, true);
  assert.equal(parseBenchHash('#bench:board,seed=7').seed, 7);
  assert.equal(parseBenchHash('#bench').open, false);
  // A value on it is not the bare word, so it is not understood rather than half-read.
  assert.deepEqual(parseBenchHash('#bench:board=1').unknown, ['board=1']);
  assert.equal(parseBenchHash('#bench:board=1').open, false);
});

test('a result is named by device, version, time and switches', () => {
  const at = new Date(2026, 8, 24, 15, 7).toISOString();
  const name = benchFileName({
    at, device: { name: 'sm-s906b' }, app: { version: '0.464', switches: { quality: 'light', grid: false } },
  });
  assert.equal(name, 'mbrd-bench-sm-s906b-0.464-20260924-1507-light-nogrid.json');
  // The shells refuse any other shape of name (MbrdBench.java, desktop/boards.ts).
  assert.match(name, /^mbrd-bench-[a-z0-9.-]{1,160}\.json$/);
  assert.deepEqual(switchWords({}), []);
});

test('the device is named from what the page can see', () => {
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 14; SM-S906B) AppleWebKit/537.36', 'android'), 'sm-s906b');
  // Chrome's reduced agent says K, which names nothing.
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36', 'web'), 'android');
  assert.equal(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'desktop'), 'windows-app');
  assert.equal(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 'web'), 'mac');
});

test('long frames are split into script, rendering and style-and-layout', () => {
  const entries = [
    { startTime: 100, duration: 80, renderStart: 150, styleAndLayoutStart: 160, scripts: [{ duration: 30 }, { duration: 10 }] },
    // Under the threshold, and outside the window: neither counts.
    { startTime: 300, duration: 20, renderStart: 310, styleAndLayoutStart: 312, scripts: [{ duration: 5 }] },
    { startTime: 9000, duration: 90, renderStart: 9010, styleAndLayoutStart: 9020, scripts: [] },
  ];
  assert.deepEqual(longFrameTotals(entries, 0, 1000),
    { n: 1, scriptMs: 40, renderMs: 10, styleLayoutMs: 20, worstMs: 80 });
});

test('the board somebody has is fingerprinted by what is on it', () => {
  const fp = fingerprint([{ type: 'image' }, { type: 'image' }, { type: 'note' }], { count: 5, bytes: 1234 });
  assert.deepEqual(fp, { items: 3, byType: { image: 2, note: 1 }, assets: 5, assetBytes: 1234 });
});

// ---- the compare tool ------------------------------------------------------

const { readResult, judge, warnings, compare, SCHEMA } = await import('../tools/bench-compare.mjs');

test('the compare tool reads the schema the app writes, and refuses another', () => {
  assert.equal(SCHEMA, BENCH_SCHEMA);
  assert.throws(() => readResult('{"kind":"mbrd-bench","schema":99}', 'x.json'), /schema 99/);
  assert.throws(() => readResult('{"kind":"board"}', 'x.json'), /not a benchmark/);
  assert.throws(() => readResult('nope', 'x.json'), /not JSON/);
});

test('a change is marked only past the noise, and says when there was none to measure', () => {
  assert.deepEqual(judge('fps', 100, 102, 5, 5, +1), { mark: '', measured: true }, 'inside the spread');
  assert.deepEqual(judge('fps', 100, 80, 5, 5, +1), { mark: '-', measured: true }, 'slower is worse');
  assert.deepEqual(judge('fps', 100, 120, null, null, +1), { mark: '+', measured: false });
  assert.deepEqual(judge('threePlusPct', 1, 4, null, null, -1), { mark: '-', measured: false }, 'more lost frames is worse');
  assert.equal(judge('threePlusPct', 1, 1.2, null, null, -1).mark, '', 'under the floor');
});

test('the compare tool says when two runs do not compare', () => {
  const run = (over = {}) => ({
    kind: 'mbrd-bench', schema: BENCH_SCHEMA, at: '2026-09-24T12:00:00Z', cancelled: false,
    device: { name: 'x', platform: 'android', dpr: 3, window: { w: 400, h: 900 }, seenHz: 120 },
    app: { version: '0.464', quality: 'full', switches: {} },
    board: { kind: 'standard', seed: 1 },
    timing: { sincePreviousRunMs: null, repeat: 1 },
    scenarios: [{ id: 'zoom-sweep', name: 'Zoom sweep', runs: [{ summary: { fps: 100, threePlusPct: 1, p95: 10 } }] }],
    ...over,
  });
  const said = warnings([run(), run({
    board: { kind: 'standard', seed: 2 },
    device: { name: 'y', platform: 'web', dpr: 1, window: { w: 1, h: 1 }, seenHz: 60 },
    timing: { sincePreviousRunMs: 30000, repeat: 1 },
  })], ['a', 'b']).join('\n');
  assert.match(said, /not on a's board/);
  assert.match(said, /not both Android/);
  assert.match(said, /30 s after a previous run/);
  assert.match(said, /single runs/);
  const text = compare([run(), run()], ['a', 'b']);
  assert.match(text, /zoom-sweep - Zoom sweep/);
});

test('Copy puts the whole run on one line', () => {
  const summary = { fps: 118.2, threePlusPct: 0.4 };
  const line = summaryLine({
    schema: BENCH_SCHEMA,
    device: { name: 'sm-s906b', dpr: 3, window: { w: 412, h: 915 }, seenHz: 120 },
    app: { version: '0.464', quality: 'full', switches: {} },
    board: { kind: 'standard', seed: 20260923 },
    scenarios: [
      { id: 'zoom-sweep', runs: [{ summary }] },
      { id: 'tour', runs: [], skipped: 'this board has no tour' },
    ],
  });
  assert.equal(line.includes('\n'), false);
  assert.match(line, /^mbrd bench v0\.464 sm-s906b 3x 412x915 120Hz standard:20260923 full \| zoom-sweep 118\.2fps 3f\+0\.4%$/);
});
