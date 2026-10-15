// The benchmark's way in and its screen: the Debug row's one question, the
// overlay a run sits behind (inert, opaque to input, repainted only between
// scenarios), and the result with Save, Copy and the way back. The engine is
// perf/bench.ts; this module only asks, shows and hands the file over.

import { toast } from '../notify.ts';
import { markClosed } from '../util.ts';
import { homePath } from '../page.ts';
import { ask } from './dialog.ts';
import { copyText } from '../util.ts';
import { benchFileName, summaryLine, parseBenchHash } from '../perf/bench.ts';
import type { Bench, BenchOptions, BenchResult } from '../perf/bench.ts';

type BenchViewDeps = {
  bench: Bench,
  /** Put the file somewhere and say where, or throw. */
  save: (name: string, json: string) => Promise<string>,
  /** Whether this page is the #bench boot. */
  standardPage: boolean,
};

/** Above the app and below nothing but the profiler's own strip (99999). */
const Z = 99998;

const css = <E extends HTMLElement>(el: E, text: string): E => { el.style.cssText = text; return el; };

function button(label: string, run: () => void) {
  const b = css(document.createElement('button'),
    'font:inherit;color:inherit;background:rgba(255,255,255,.12);border:1px solid currentColor;'
    + 'border-radius:6px;padding:6px 12px;min-height:36px;cursor:pointer;pointer-events:auto');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', run);
  return b;
}

export function initBenchView({ bench, save, standardPage }: BenchViewDeps) {
  let shield: HTMLDivElement | null = null;
  let panel: HTMLDivElement | null = null;
  let abort: AbortController | null = null;

  /**
   * Everything that reaches the page while a run is up stops here: a stray
   * touch is a measurement of the touch. Capture phase on the window, ahead of
   * canvas/input.ts; only the panel's own buttons get through.
   */
  const swallow = (e: Event) => {
    if (!shield) return;
    // Escape is Cancel, and so is Android's Back, which arrives as a synthetic
    // Escape and asks whether anything closed (main.ts) - the run did.
    if (e instanceof KeyboardEvent && e.key === 'Escape') {
      if (e.type === 'keydown') { abort?.abort(); markClosed(e); }
      e.stopPropagation();
      return;
    }
    // A scenario's own presses (the viewer's close button) are synthetic, and
    // must reach the page.
    if (!e.isTrusted) return;
    if (panel && e.target instanceof Node && panel.contains(e.target)) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
  };
  const EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'touchstart', 'touchmove',
    'keydown', 'keyup', 'contextmenu', 'dblclick', 'click'];

  function mount() {
    shield = css(document.createElement('div'),
      `position:fixed;inset:0;z-index:${Z};touch-action:none;background:transparent`);
    panel = css(document.createElement('div'),
      `position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:${Z + 1};`
      + 'font:600 13px/1.35 ui-monospace,monospace;padding:10px 12px;border-radius:8px;'
      + 'background:rgba(0,0,0,.85);color:#0f0;max-width:min(94vw,760px);max-height:86vh;overflow:auto;'
      + 'box-sizing:border-box');
    panel.setAttribute('role', 'status');
    document.body.append(shield, panel);
    for (const type of EVENTS) addEventListener(type, swallow, { capture: true, passive: false });
  }

  function unmount() {
    for (const type of EVENTS) removeEventListener(type, swallow, { capture: true });
    shield?.remove();
    panel?.remove();
    shield = panel = null;
  }

  /** Repaint the panel. Called between scenarios only - never inside one. */
  function say(lines: string[], buttons: HTMLButtonElement[] = [], fraction: number | null = null) {
    if (!panel) return;
    panel.replaceChildren();
    const text = css(document.createElement('div'), 'white-space:pre-wrap');
    text.textContent = lines.join('\n');
    panel.append(text);
    if (fraction !== null) {
      const bar = css(document.createElement('div'), 'height:4px;margin:8px 0 2px;background:rgba(255,255,255,.2);border-radius:2px');
      bar.append(css(document.createElement('div'), `height:100%;width:${Math.round(fraction * 100)}%;background:currentColor;border-radius:2px`));
      panel.append(bar);
    }
    if (buttons.length) {
      const row = css(document.createElement('div'), 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px');
      row.append(...buttons);
      panel.append(row);
    }
  }

  /** The result as a table the panel can hold, one line per scenario. */
  function table(r: BenchResult): string[] {
    const pad = (s: string | number, n: number) => String(s).padStart(n);
    const out = [
      `${r.device.name}  v${r.app.version}  ${r.device.seenHz}Hz  ${r.board.kind === 'standard' ? 'standard board' : 'this board'}`
        + `  ${r.app.quality}${r.cancelled ? '  (cancelled)' : ''}`,
      `${'scenario'.padEnd(12)}${pad('fps', 7)}${pad('2f%', 6)}${pad('3f+%', 6)}${pad('p95', 7)}${pad('worst', 7)}${pad('long', 5)}`,
    ];
    for (const s of r.scenarios) {
      if (s.skipped) { out.push(`${s.id.padEnd(12)}  skipped: ${s.skipped}`); continue; }
      const m = s.runs[0]?.summary;
      if (!m) continue;
      out.push(`${s.id.padEnd(12)}${pad(m.fps, 7)}${pad(m.twoBeatPct, 6)}${pad(m.threePlusPct, 6)}`
        + `${pad(m.p95, 7)}${pad(m.worst, 7)}${pad(m.longFrames?.n ?? '-', 5)}`
        + (m.glass ? `  glass missed ${m.glass.missedPct}%` : '')
        + (m.settleMs !== undefined ? `  settle ${m.settleMs}ms` : ''));
    }
    out.push(`cards discarded ${r.memory.discarded}, collected ${r.memory.finalised}`
      + `   dom ${r.memory.before.dom} -> ${r.memory.after.dom}`
      + (r.memory.after.heapMB !== null ? `   heap ${r.memory.before.heapMB} -> ${r.memory.after.heapMB} MB` : ''));
    return out;
  }

  function showResult(r: BenchResult) {
    const json = JSON.stringify(r);
    const name = benchFileName(r);
    const lines = table(r);
    const buttons = [
      button('Save', () => {
        save(name, json).then(
          where => toast(`Saved ${where}`),
          err => toast(`The file could not be saved: ${err instanceof Error ? err.message : String(err)}`, 'error'),
        );
      }),
      button('Copy', () => {
        const line = summaryLine(r);
        void copyText(line).then(ok => {
          if (ok) { toast('Copied the summary'); return; }
          // Nothing reached the clipboard, so hand over the text instead.
          say([...lines, '', line], buttons);
        });
      }),
    ];
    if (standardPage) {
      // A navigation, not a load: the page boots again as itself, with the
      // user's own board, and nothing of this one comes along.
      buttons.push(button('Back to your board', () => { location.replace(homePath()); }));
      // A reload rather than a second run here: the run rearranged and scrubbed
      // this board, and a second run has to start from the same one the first did.
      buttons.push(button('Run again', () => { location.reload(); }));
    } else {
      buttons.push(button('Close', unmount));
    }
    say(lines, buttons);
    // The shield has done its job; the result is read and pressed, not guarded.
    shield?.remove();
    shield = null;
    for (const type of EVENTS) removeEventListener(type, swallow, { capture: true });
  }

  /** Run with the overlay up, and answer the same object the file holds. */
  async function start(opts: BenchOptions): Promise<BenchResult | null> {
    if (bench.running) { toast('A benchmark is already running'); return null; }
    unmount();
    mount();
    abort = new AbortController();
    const cancel = button('Cancel', () => abort?.abort());
    say(['Benchmark', 'Waiting for the board to settle'], [cancel], 0);
    try {
      const result = await bench.run({
        ...opts,
        signal: abort.signal,
        onBuild: f => say(['Benchmark', 'Building the standard board'], [cancel], f),
        onProgress: p => say(
          [`Benchmark  ${p.index + 1} / ${p.total}`, p.name + (p.repeat ? `  (again, ${p.repeat + 1})` : '')],
          [cancel], p.index / p.total),
      });
      showResult(result);
      console.log('[bench]', summaryLine(result));
      return result;
    } catch (err) {
      unmount();
      const message = err instanceof Error ? err.message : String(err);
      toast(`The benchmark stopped: ${message}`, 'error');
      console.error('[bench]', err);
      return null;
    } finally {
      abort = null;
    }
  }

  /** The #bench boot: build, run, show. Options ride the address. */
  function boot() {
    const { options, seed, unknown } = parseBenchHash(location.hash);
    if (unknown.length) toast(`Not understood, and left out: ${unknown.join(', ')}`, 'error');
    if (seed !== null) options.seed = seed;
    return start(options);
  }

  return {
    /** The Debug row: one question, then a navigation or a run in place. */
    async open() {
      if (bench.running) return;
      if (standardPage) { void boot(); return; }
      const answer = await ask({
        title: 'Run the benchmark',
        body: 'About two minutes of preset zooms, pans and animations, with a file of the timings at the end. '
          + 'The standard board is the same on every device and is thrown away afterwards. '
          + 'This board is measured as it is: moved, never edited.',
        go: 'Standard board',
        keep: 'This board',
        cancel: 'Cancel',
        danger: false,
      });
      if (answer === 'go') {
        // No history entry: the browser's Back from #bench would be a fragment
        // change on the same document and leave the benchmark's board on screen.
        // The board being left is flushed on the way out, as for Patch notes.
        history.replaceState(null, '', homePath() + '#bench');
        location.reload();
      } else if (answer === 'keep') {
        await start({ board: 'this' });
      }
    },
    /** `mbrd.cmds.bench(opts)`: the same run, from a console or over CDP. */
    run: (opts: BenchOptions = {}) => start(opts),
    boot,
  };
}
