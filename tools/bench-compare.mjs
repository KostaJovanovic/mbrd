// Compare benchmark results side by side (research/bench-2026-09-23.md).
//
//   node tools/bench-compare.mjs a.json b.json [c.json ...]
//
// One table per scenario, the first file as the baseline. A change is marked
// only when it is past the run-to-run noise, and the noise is measured, not
// assumed: a result taken with `repeat` carries its spread, and without one the
// tool says a single run is not a verdict. It also says when two runs are not
// on the same board, not on the same kind of device, or one came hot off another.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The file shape this reads. perf/bench.ts's BENCH_SCHEMA. */
export const SCHEMA = 1;
/** A change in frame rate smaller than this is never marked, whatever the spread. */
const FLOOR_PCT = 3;
/** Nor a change in a tail share smaller than this many points. */
const FLOOR_POINTS = 0.5;
/** A run this soon after the one before it was taken on a warm device. */
const HOT_MS = 5 * 60 * 1000;

/** The figures a table shows, in its order: key, heading, which way is better. */
const ROWS = [
  ['fps', 'fps', +1],
  ['twoBeatPct', '2-beat %', -1],
  ['threePlusPct', '3+ beat %', -1],
  ['p95', 'p95 ms', -1],
  ['worst', 'worst ms', -1],
  ['long', 'long frames', -1],
  ['settleMs', 'settle ms', -1],
  ['glassMissedPct', 'glass missed %', -1],
];

/** Read and check one file. Throws with the reason a file is refused. */
export function readResult(text, name = 'result') {
  let r;
  try { r = JSON.parse(text); } catch { throw new Error(`${name}: not JSON`); }
  if (!r || r.kind !== 'mbrd-bench') throw new Error(`${name}: not a benchmark result`);
  if (r.schema !== SCHEMA) throw new Error(`${name}: schema ${r.schema}, and this tool reads ${SCHEMA} - use the tool from the same version`);
  return r;
}

const median = values => {
  const v = values.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

/** One figure of one scenario, the median across its repeats. */
function figure(scenario, key) {
  const pick = s => (key === 'long' ? s.longFrames?.n
    : key === 'glassMissedPct' ? s.glass?.missedPct
      : s[key]);
  return median((scenario?.runs ?? []).map(run => pick(run.summary)));
}

/**
 * How far a figure moves between repeats of the same run, in the figure's own
 * terms: a percentage for the frame rate, points for a share, ms for a time.
 * Null when there was only one run, which is the honest answer.
 */
function noise(scenario, key) {
  const runs = scenario?.runs ?? [];
  if (runs.length < 2) return null;
  const s = scenario.spread;
  if (key === 'fps' && s?.fps) return s.fps.rangePct;
  if (key === 'threePlusPct' && s?.threePlusPct) return s.threePlusPct.max - s.threePlusPct.min;
  if (key === 'p95' && s?.p95) return s.p95.max - s.p95.min;
  const values = runs.map(run => figure({ runs: [run] }, key)).filter(v => v !== null);
  return values.length > 1 ? Math.max(...values) - Math.min(...values) : null;
}

/**
 * Whether b's figure differs from a's past the noise, and which way. The
 * frame rate is compared as a percentage of a, everything else in its units.
 */
export function judge(key, a, b, noiseA, noiseB, better) {
  if (a === null || b === null) return { mark: '', measured: false };
  const measured = noiseA !== null && noiseB !== null;
  const spreadOf = Math.max(noiseA ?? 0, noiseB ?? 0);
  let past;
  if (key === 'fps') {
    const pct = a ? 100 * (b - a) / a : 0;
    past = Math.abs(pct) > Math.max(FLOOR_PCT, spreadOf);
  } else if (key.endsWith('Pct')) {
    past = Math.abs(b - a) > Math.max(FLOOR_POINTS, spreadOf);
  } else {
    past = Math.abs(b - a) > Math.max(1, spreadOf, 0.05 * Math.abs(a));
  }
  if (!past) return { mark: '', measured };
  const up = b > a;
  return { mark: (up === (better > 0)) ? '+' : '-', measured };
}

/** What to say about the set before any table: boards, devices, heat. */
export function warnings(results, names) {
  const out = [];
  const boardOf = r => (r.board.kind === 'standard' ? `standard:${r.board.seed}` : `this:${JSON.stringify(r.board.fingerprint)}`);
  const base = results[0];
  results.slice(1).forEach((r, i) => {
    const name = names[i + 1];
    if (boardOf(r) !== boardOf(base)) out.push(`${name} is not on ${names[0]}'s board - the scenarios compare, the boards do not`);
    if ((r.device.platform === 'android') !== (base.device.platform === 'android')) {
      out.push(`${name} and ${names[0]} are not both Android runs - their frame rates come from different sources and do not compare`);
    }
  });
  results.forEach((r, i) => {
    const since = r.timing?.sincePreviousRunMs;
    if (typeof since === 'number' && since < HOT_MS) {
      out.push(`${names[i]} started ${Math.round(since / 1000)} s after a previous run - a warm device runs slower`);
    }
    if (r.cancelled) out.push(`${names[i]} was cancelled part of the way through`);
  });
  if (results.every(r => (r.timing?.repeat ?? 1) < 2)) {
    out.push('single runs: a change marked here is past a floor, not past measured noise - take them with repeat=3 for a verdict');
  }
  return out;
}

const cell = (v, w) => String(v ?? '-').padStart(w);

/** The whole comparison as text. */
export function compare(results, names) {
  const lines = [];
  results.forEach((r, i) => {
    const sw = Object.entries(r.app.switches ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
    lines.push(`${String.fromCharCode(65 + i)}  ${names[i]}`);
    lines.push(`   ${r.device.name} ${r.device.platform} ${r.device.dpr}x ${r.device.window.w}x${r.device.window.h} `
      + `${r.device.seenHz}Hz  v${r.app.version}  ${r.app.quality}${sw ? '  ' + sw : ''}  ${r.at}`);
  });
  const warned = warnings(results, names);
  if (warned.length) lines.push('', ...warned.map(w => '! ' + w));
  const ids = [];
  for (const r of results) for (const s of r.scenarios) if (!ids.includes(s.id)) ids.push(s.id);
  const W = 12;
  for (const id of ids) {
    const per = results.map(r => r.scenarios.find(s => s.id === id));
    const name = per.find(Boolean)?.name ?? id;
    lines.push('', `${id} - ${name}`);
    lines.push(''.padEnd(16) + results.map((_, i) => cell(String.fromCharCode(65 + i), W)).join(''));
    const skipped = per.map(s => s?.skipped);
    if (skipped.some(Boolean)) lines.push('skipped'.padEnd(16) + skipped.map(s => cell(s ? 'yes' : '', W)).join(''));
    for (const [key, heading, better] of ROWS) {
      const values = per.map(s => figure(s, key));
      if (values.every(v => v === null)) continue;
      const row = values.map((v, i) => {
        if (i === 0 || v === null) return cell(v, W);
        const j = judge(key, values[0], v, noise(per[0], key), noise(per[i], key), better);
        return cell(`${v}${j.mark ? ` ${j.mark}${j.measured ? '' : '?'}` : ''}`, W);
      });
      lines.push(heading.padEnd(16) + row.join(''));
    }
  }
  lines.push('', '+ better than A, - worse, ? past the floor with no measured noise to hold it against');
  return lines.join('\n');
}

function main(args) {
  if (args.length < 2) {
    console.error('usage: node tools/bench-compare.mjs a.json b.json [c.json ...]');
    process.exit(2);
  }
  let results;
  try {
    results = args.map(path => readResult(readFileSync(path, 'utf8'), basename(path)));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(compare(results, args.map(p => basename(p))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
