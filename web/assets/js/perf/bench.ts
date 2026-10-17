// The benchmark engine: a fixed set of moves, zooms and animations driven from
// inside the page, one view write per frame, recorded frame by frame and
// written out as one JSON document (research/bench-2026-09-23.md). Runs on the
// standard board (#bench) or on the board on screen, which it moves and never
// edits. Factory, so nothing here touches a browser global at import time.

import {
  board, isBenchBoard, isContent, setSetting, goTo, timelineSteps, timelineAt,
} from '../state.ts';
import { itemBounds } from '../geometry.ts';
import { isRecord } from '../util.ts';
import type { Viewport } from '../canvas/viewport.ts';
import { mobilePerfFlags } from '../canvas/viewport.ts';
import { cullProfile, viewStats, setDiscardProbe } from '../canvas/items.ts';
import { quality, qualityLevel, setQualityLevel, setQualityOverride } from '../quality.ts';
import { assetBytes } from '../storage/assets.ts';
import { isOpen as sidebarIsOpen, open as openSidebar, close as closeSidebar } from '../ui/sidebar.ts';
import { cleanActive, stopClean } from '../ui/clean/clean.ts';
import { VERSION, COMMIT_COUNT } from '../version.js';
import type { ViewPerf } from './view-perf.ts';
import {
  decodeSeries, encodeSeries, gapsOf, round, scoredGaps, spread, summariseGaps,
} from './frames.ts';
import type { GapSummary } from './frames.ts';

/** Bumped whenever a reader of the file would misread the new shape. */
export const BENCH_SCHEMA = 1;
/** The start of every scenario that is not scored: the panel waking up. */
const WARMUP_MS =150;
/** A long animation frame, as the observer reports them. */
const LONG_FRAME_MS = 50;
/** How long the page must go without a long frame to count as idle. */
const IDLE_QUIET_MS = 1000;
const IDLE_MAX_MS = 15000;

// ---------------------------------------------------------------------------
// Options and the file
// ---------------------------------------------------------------------------

/** The switches a run may throw, each recorded in the file and in its name. */
type BenchSwitches = {
  quality?: 'light' | 'balanced' | 'full',
  whimsy?: 0 | 1 | 2,
  grid?: boolean,
  grain?: boolean,
  shadows?: boolean,
  /** The three Mobile kill switches, as `mbrd.perf.mobile()` takes them. */
  legacyVars?: boolean,
  chrome?: boolean,
  gridPos?: boolean,
};

export type BenchOptions = {
  /** Which board. Defaults to the standard board on #bench, this board anywhere else. */
  board?: 'standard' | 'this',
  /** Scenario ids to run, in the table's order; all that apply when absent. */
  only?: string[],
  /** Each scenario this many times, for its spread. 1 to 5. */
  repeat?: number,
  switches?: BenchSwitches,
  /** The standard board's seed, the first time it is built on this page. */
  seed?: number,
  signal?: AbortSignal,
  /** Told how far the standard board's generation has got, 0 to 1. */
  onBuild?: (fraction: number) => void,
  /** Told before each scenario - never during one. */
  onProgress?: (p: { index: number, total: number, id: string, name: string, repeat: number }) => void,
};

/** Per-frame timings from the window itself, from the Android shell. */
type GlassFrames = {
  /** The refresh rate the display claims, in Hz. */
  refreshHz: number,
  /** Vsync time in ms (the frame's intended start), total duration and deadline in ms. */
  frames: { vsync: number, total: number, deadline: number }[],
};

type GlassPort ={ start(): Promise<void>, stop(): Promise<GlassFrames> };

type LongFrames ={ n: number, scriptMs: number, renderMs: number, styleLayoutMs: number, worstMs: number };

type ScenarioSummary =GapSummary & {
  durationMs: number,
  longFrames: LongFrames | null,
  cullAvgMs: number | null,
  cullFullSyncPct: number | null,
  mounted: number,
  decodedMB: number,
  settleMs?: number,
  glass?: GlassSummary,
  /** 'run' when the tail is counted in the run's beat rather than this scenario's own - see rebeat(). */
  beatFrom?: 'run',
};

type GlassSummary = {
  n: number, missed: number, missedPct: number, p95TotalMs: number, worstTotalMs: number,
  vsync: GapSummary,
};

type ScenarioRun = {
  summary: ScenarioSummary,
  /** rAF timestamps: the first, then every gap in tenths of a millisecond. */
  frames: { t0: number, d: number[] },
  /** FrameMetrics, where the shell has them: vsync series as above, durations in tenths. */
  glass?: { t0: number, d: number[], total: number[], deadline: number[] },
};

type ScenarioResult = {
  id: string, name: string,
  runs: ScenarioRun[],
  /** Across repeats, when there was more than one. */
  spread?: { fps: ReturnType<typeof spread>, threePlusPct: ReturnType<typeof spread>, p95: ReturnType<typeof spread> },
  skipped?: string,
};

type BoardDescription =
  | { kind: 'standard', seed: number, generationMs: number, cards: number, assetBytes: number }
  | { kind: 'this', fingerprint: { items: number, byType: Record<string, number>, assets: number, assetBytes: number } };

export type BenchResult = {
  schema: number,
  kind: 'mbrd-bench',
  at: string,
  device: {
    platform: 'web' | 'desktop' | 'android',
    name: string,
    userAgent: string,
    dpr: number,
    screen: { w: number, h: number },
    window: { w: number, h: number },
    /** From the beat of the run, in Hz: the rate the run actually saw. */
    seenHz: number,
    /** What the display claims, where the shell can ask. */
    claimedHz: number | null,
    cores: number | null,
    memoryGB: number | null,
    reducedMotion: boolean,
  },
  app: {
    version: string, commit: number,
    quality: string, flags: Record<string, unknown>,
    whimsy: number | null,
    grid: boolean,
    boardMode: string,
    mobilePerfFlags: Record<string, boolean>,
    switches: BenchSwitches,
  },
  board: BoardDescription,
  sources: { raf: true, longFrames: boolean, glass: boolean },
  timing: { sinceLoadMs: number, sincePreviousRunMs: number | null, totalMs: number, repeat: number },
  scenarios: ScenarioResult[],
  memory: {
    before: { dom: number, heapMB: number | null },
    after: { dom: number, heapMB: number | null },
    discarded: number,
    finalised: number,
  },
  cancelled: boolean,
};

// ---------------------------------------------------------------------------
// What the engine is handed
// ---------------------------------------------------------------------------

/** The commands a scenario drives, as `cmds` has them. Whatever they answer is not read. */
type BenchCommands = {
  fit(): void,
  recenter(): void,
  feed(): void,
  canvas(): void,
  cleanTap(): void,
  cleanEscape(): void,
  tourStart(): void,
  tourStep(delta: number): void,
  tourStop(): void,
  openViewer(id: string): void,
  rearrange(): void,
  setWhimsy(level: number): void,
};

type BenchDeps = {
  vp: Viewport,
  cmds: BenchCommands,
  perf: ViewPerf,
  /** The shell's frame source, or null where the page's own rAF is the best there is. */
  glass: GlassPort | null,
  platform: 'web' | 'desktop' | 'android',
  /** The standard board, built and loaded. Only called on #bench. */
  buildBoard: (seed: number | undefined, progress: (f: number) => void) =>
    Promise<{ seed: number, generationMs: number, cards: number, assetBytes: number }>,
};

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type Fit = { pan: { x: number, y: number }, zoom: number, w: number, h: number };

type Ctx = {
  vp: Viewport,
  cmds: BenchCommands,
  fit: Fit,
  /** The next frame's timestamp. Throws once the run is cancelled. */
  frame(): Promise<number>,
  /** Frames for `ms`. */
  wait(ms: number): Promise<void>,
  /** One step per frame for `ms`, with the fraction of the way through. */
  drive(ms: number, step: (t: number) => void): Promise<void>,
  /** Until the view's own animation (a camera move, a glide) has ended. */
  settled(maxMs?: number): Promise<void>,
  /** The timestamps recorded so far in this scenario. */
  times: number[],
};

type Scenario = {
  id: string,
  name: string,
  /** Moves cards, needs a history, or switches the layout: never on the user's board. */
  standardOnly?: boolean,
  /** Why it cannot run here, or null when it can. */
  refuse?(ctx: Ctx): string | null,
  run(ctx: Ctx): Promise<{ settleMs?: number } | void>,
};

/**
 * Close the viewer the way its own button does, so its teardown runs (the
 * close function is the viewer's own and not exported). Only when it is open.
 */
function closeViewer() {
  const dlg = document.getElementById('viewer');
  if (dlg instanceof HTMLDialogElement && dlg.open) document.getElementById('viewer-close')?.click();
}

/** 0 -> 1 -> 0 over t in [0, 1]. */
const there = (t: number) => (t < 0.5 ? 2 * t : 2 - 2 * t);
/** Geometric between two zooms, which is how the app's own zoom moves. */
const zoomBetween = (a: number, b: number, t: number) => a * Math.pow(b / a, t);

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'zoom-sweep', name: 'Zoom sweep, fit to 500% and back',
    async run({ vp, fit, drive }) {
      await drive(6000, t => vp.viewTo(fit.pan, zoomBetween(fit.zoom, 5, there(t))));
    },
  },
  {
    id: 'zoom-35', name: 'Zoom oscillation around 35%',
    async run({ vp, fit, drive }) {
      await drive(5000, t => vp.viewTo(fit.pan, 0.35 * Math.pow(1.3, Math.sin(2 * Math.PI * 5 * t))));
    },
  },
  {
    id: 'zoom-out', name: 'Zoom out from 500% through 90-80%',
    async run({ vp, fit, drive }) {
      await drive(3000, t => vp.viewTo(fit.pan, zoomBetween(5, 0.5, t)));
    },
  },
  ...([['pan-fit', 'Pan at fit', 0], ['pan-35', 'Pan at 35%', 0.35], ['pan-100', 'Pan at 100%', 1]] as const)
    .map(([id, name, z]): Scenario => ({
      id, name,
      async run({ vp, fit, drive }) {
        const zoom = z || fit.zoom;
        // An ellipse across the middle of the fitted box, the same share of
        // it on any window.
        await drive(3000, t => vp.viewTo({
          x: fit.pan.x + fit.w * 0.35 * Math.sin(2 * Math.PI * t),
          y: fit.pan.y + fit.h * 0.35 * (1 - Math.cos(2 * Math.PI * t)) / 2,
        }, zoom));
      },
    })),
  {
    id: 'pinch', name: 'Pinch-shaped zoom about an off-centre point',
    async run({ vp, fit, drive }) {
      // Through zoomAt(), which is the pinch's own arithmetic, about a point a
      // third of the way in from the top left - never the centre, which is the
      // one point where a wrong pin cannot show.
      const x = vp.left + vp.width * 0.3, y = vp.top + vp.height * 0.35;
      await drive(4000, t => {
        const want = fit.zoom * Math.pow(3, Math.sin(Math.PI * t));
        vp.zoomAt(x, y, want / vp.zoom);
      });
    },
  },
  {
    id: 'fling', name: 'Fling: a drag let go, gliding out',
    async run({ vp, fit, frame, settled }) {
      vp.viewTo(fit.pan, 1);
      // A 400 ms drag at a thumb's speed, then the glide the app gives a
      // release at that speed - the same decay, from the same call.
      const vx = 2400, vy = -800;
      let last = await frame();
      const end = last + 400;
      for (;;) {
        const now = await frame();
        const dt = (now - last) / 1000;
        last = now;
        vp.panByScreen(vx * dt, vy * dt);
        if (now >= end) break;
      }
      vp.glide(vx, vy);
      await settled(4000);
    },
  },
  {
    id: 'settle', name: 'Settle: the frames after motion stops',
    async run({ vp, fit, drive, wait, times }) {
      await drive(1200, t => vp.viewTo(fit.pan, zoomBetween(fit.zoom, fit.zoom * 2.5, t)));
      const stop = times[times.length - 1];
      await wait(800);
      // The worst gap once the hand is off: the unpin, the rungs and the device
      // snap all land on the settling frame (_moving() in canvas/viewport.ts).
      let worst = 0;
      for (let i = 1; i < times.length; i++) {
        if (times[i] > stop) worst = Math.max(worst, times[i] - times[i - 1]);
      }
      return { settleMs: round(worst) };
    },
  },
  {
    id: 'camera', name: 'Fit and recenter, animated',
    async run({ cmds, settled, wait }) {
      cmds.recenter();
      await settled();
      await wait(200);
      cmds.fit();
      await settled();
      await wait(200);
    },
  },
  {
    id: 'feed', name: 'Canvas to Feed, Feed scroll, Feed to Canvas', standardOnly: true,
    async run({ cmds, wait, drive }) {
      cmds.feed();
      await wait(800);
      const feed = document.getElementById('mobile-feed');
      if (feed) {
        const far = Math.max(0, (feed.scrollHeight - feed.clientHeight) * 0.8);
        await drive(3000, t => { feed.scrollTop = far * there(t); });
      }
      cmds.canvas();
      await wait(800);
    },
  },
  {
    id: 'star', name: 'The star intro',
    refuse: () => (cleanActive() ? 'the clean-up mode is already up' : null),
    async run({ cmds, wait }) {
      // Seven taps inside the matcher's window (ui/clean/konami.ts): 600 ms
      // between taps at most, three seconds for the lot.
      for (let i = 0; i < 7; i++) { cmds.cleanTap(); await wait(120); }
      if (!cleanActive()) return;
      await wait(2500);
      cmds.cleanEscape();
      await wait(800);
      stopClean();
      await wait(500);
    },
  },
  {
    id: 'tour', name: 'Tour playback over three stops',
    refuse: () => (board.tour.length ? null : 'this board has no tour'),
    async run({ cmds, settled, wait }) {
      cmds.tourStart();
      await settled();
      await wait(400);
      for (let i = 0; i < 2; i++) {
        cmds.tourStep(1);
        await settled();
        await wait(400);
      }
      cmds.tourStop();
      await wait(300);
    },
  },
  {
    id: 'timeline', name: 'Timeline scrub across the history', standardOnly: true,
    refuse: () => (timelineSteps().length > 1 ? null : 'no history to scrub'),
    async run({ drive }) {
      const n = timelineSteps().length;
      let at = timelineAt();
      await drive(3000, t => {
        const want = Math.round(n * (1 - there(t)));
        if (want !== at) { goTo(want); at = want; }
      });
      goTo(n);
    },
  },
  {
    id: 'chrome', name: 'Sidebar and viewer, open and closed',
    async run({ cmds, wait }) {
      const was = sidebarIsOpen();
      if (was) { closeSidebar(); await wait(500); }
      openSidebar();
      await wait(600);
      closeSidebar();
      await wait(600);
      if (was) openSidebar();
      const photo = board.items.find(i => i.type === 'image');
      if (photo) {
        cmds.openViewer(photo.id);
        await wait(800);
        closeViewer();
        await wait(600);
      }
    },
  },
  {
    id: 'rearrange', name: 'Rearrange', standardOnly: true,
    async run({ cmds, wait }) {
      cmds.rearrange();
      await wait(1800);
    },
  },
];

// ---------------------------------------------------------------------------
// Reading the page
// ---------------------------------------------------------------------------

/** The long-animation-frame entry, as far as it is read here. Chromium 123+. */
type LoafEntry = {
  startTime: number, duration: number, renderStart: number, styleAndLayoutStart: number,
  scripts: { duration: number }[],
};

/** Whether the engine reports long animation frames at all. */
const hasLoaf = () => typeof PerformanceObserver !== 'undefined'
  && (PerformanceObserver.supportedEntryTypes ?? []).includes('long-animation-frame');

/** A number a browser object may or may not carry, as a number. */
const numberAt = (obj: unknown, key: string) => {
  const v = isRecord(obj) ? obj[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

/**
 * Read a long-animation-frame entry into the fields used here. By name rather
 * than by cast: lib.dom does not carry the type yet, and an engine midway
 * through shipping it may lack a field, which reads as 0 and is skipped below.
 */
function readLoaf(e: PerformanceEntry): LoafEntry {
  const scripts = isRecord(e) ? e.scripts : undefined;
  return {
    startTime: e.startTime,
    duration: e.duration,
    renderStart: numberAt(e, 'renderStart'),
    styleAndLayoutStart: numberAt(e, 'styleAndLayoutStart'),
    scripts: Array.isArray(scripts) ? scripts.map(s => ({ duration: numberAt(s, 'duration') })) : [],
  };
}

function watchLongFrames() {
  const entries: LoafEntry[] = [];
  if (!hasLoaf()) return { entries, stop: () => {} };
  const obs = new PerformanceObserver(list => {
    for (const e of list.getEntries()) entries.push(readLoaf(e));
  });
  obs.observe({ type: 'long-animation-frame', buffered: false });
  return { entries, stop: () => obs.disconnect() };
}

/**
 * The three phases of each long frame, summed: script, the rendering steps
 * before style (rAF callbacks, observers), and style-and-layout to the end.
 */
export function longFrameTotals(entries: readonly LoafEntry[], from: number, to: number): LongFrames {
  let n = 0, scriptMs = 0, renderMs = 0, styleLayoutMs = 0, worstMs = 0;
  for (const e of entries) {
    if (e.startTime < from || e.startTime > to || e.duration < LONG_FRAME_MS) continue;
    n++;
    worstMs = Math.max(worstMs, e.duration);
    for (const s of e.scripts ?? []) scriptMs += s.duration || 0;
    const end = e.startTime + e.duration;
    if (e.renderStart > 0) {
      const style = e.styleAndLayoutStart > 0 ? e.styleAndLayoutStart : end;
      renderMs += Math.max(0, style - e.renderStart);
      styleLayoutMs += Math.max(0, end - style);
    }
  }
  return { n, scriptMs: round(scriptMs), renderMs: round(renderMs), styleLayoutMs: round(styleLayoutMs), worstMs: round(worstMs) };
}

/** Chromium's JS heap, in MB, or null where the engine keeps it to itself. */
function heapMB(): number | null {
  // performance.memory is a Chromium extension, absent from lib.dom.
  const used = numberAt(isRecord(performance) ? performance.memory : undefined, 'usedJSHeapSize');
  return used ? round(used / 1048576) : null;
}

const domSize = () => document.getElementsByTagName('*').length;

/** The board somebody actually has, described well enough to match two runs on it. */
export function fingerprint(items: readonly { type: string }[], assets: { count: number, bytes: number }) {
  const byType: Record<string, number> = {};
  for (const it of items) byType[it.type] = (byType[it.type] || 0) + 1;
  return { items: items.length, byType, assets: assets.count, assetBytes: assets.bytes };
}

/** A short, filename-safe name for the device, from what the page can see. */
export function deviceName(ua: string, platform: string): string {
  const android = /Android [\d.]+; ([^;)]+)/.exec(ua);
  if (android && android[1].trim() !== 'K') return clean(android[1]);
  if (/Android/.test(ua)) return 'android';
  if (/iPhone|iPad/.test(ua)) return 'ios';
  if (/Windows/.test(ua)) return platform === 'desktop' ? 'windows-app' : 'windows';
  if (/Mac OS X/.test(ua)) return platform === 'desktop' ? 'mac-app' : 'mac';
  if (/Linux/.test(ua)) return platform === 'desktop' ? 'linux-app' : 'linux';
  return 'device';
}
const clean = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'device';

/** The switches as words, for a file name and a summary line. */
export function switchWords(s: BenchSwitches): string[] {
  const out: string[] = [];
  if (s.quality) out.push(s.quality);
  if (s.whimsy !== undefined) out.push(['softish', 'middle', 'harsh'][s.whimsy] ?? `whimsy${s.whimsy}`);
  if (s.grid === false) out.push('nogrid');
  if (s.grid === true) out.push('grid');
  if (s.grain === false) out.push('nograin');
  if (s.shadows === false) out.push('noshadows');
  if (s.legacyVars) out.push('legacy');
  if (s.chrome === false) out.push('nochrome');
  if (s.gridPos === false) out.push('nogridpos');
  return out;
}

/** `mbrd-bench-<device>-<version>-<yyyymmdd-hhmm>[-switches].json`. */
export function benchFileName(r: Pick<BenchResult, 'device' | 'app' | 'at'>): string {
  const d = new Date(r.at);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return ['mbrd-bench', r.device.name, r.app.version, stamp, ...switchWords(r.app.switches)].join('-') + '.json';
}

/** The whole run as one line, for Copy: one of these per device stacks into a table. */
export function summaryLine(r: BenchResult): string {
  const boardWord = r.board.kind === 'standard' ? `standard:${r.board.seed}` : `this:${r.board.fingerprint.items}`;
  const head = [
    `mbrd bench v${r.app.version}`, r.device.name, `${r.device.dpr}x`,
    `${r.device.window.w}x${r.device.window.h}`, `${r.device.seenHz}Hz`, boardWord,
    r.app.quality, ...switchWords(r.app.switches),
  ].join(' ');
  const parts = r.scenarios.filter(s => !s.skipped && s.runs.length).map(s => {
    const m = s.runs[0].summary;
    return `${s.id} ${m.fps}fps 3f+${m.threePlusPct}%`;
  });
  return [head, ...parts].join(' | ');
}

/**
 * The options a `#bench:` address carries, for the device that has no console:
 * `#bench:quality=light,grid=off,repeat=3,only=zoom-sweep.pan-fit`. Anything
 * not understood is left out rather than guessed at, and named in `unknown` so
 * the overlay can say so - a switch that silently did nothing is a run that
 * has to be taken again.
 *
 * `#bench:board` is the board alone: built and left on screen with nothing run,
 * for trying a gesture by hand on the board the numbers come from (`open`).
 */
export function parseBenchHash(hash: string): { options: BenchOptions, seed: number | null, unknown: string[], open: boolean } {
  const options: BenchOptions = {};
  const switches: BenchSwitches = {};
  const unknown: string[] = [];
  let seed: number | null = null;
  let open = false;
  const body = /^#bench:(.*)$/.exec(hash)?.[1] ?? '';
  const onOff = (v: string) => (v === 'on' || v === '1' ? true : v === 'off' || v === '0' ? false : null);
  for (const part of body.split(',').filter(Boolean)) {
    const [key, value = ''] = part.split('=');
    const flag = onOff(value);
    if (key === 'quality' && (value === 'light' || value === 'balanced' || value === 'full')) switches.quality = value;
    else if (key === 'whimsy' && (value === '0' || value === '1' || value === '2')) switches.whimsy = value === '0' ? 0 : value === '1' ? 1 : 2;
    else if ((key === 'grid' || key === 'grain' || key === 'shadows' || key === 'chrome' || key === 'gridPos') && flag !== null) switches[key] = flag;
    else if (key === 'legacy' && flag !== null) switches.legacyVars = flag;
    else if (key === 'repeat' && /^[1-5]$/.test(value)) options.repeat = Number(value);
    else if (key === 'seed' && /^\d{1,9}$/.test(value)) seed = Number(value);
    else if (key === 'only' && value) options.only = value.split('.');
    else if (key === 'board' && !value) open = true;
    else unknown.push(part);
  }
  if (Object.keys(switches).length) options.switches = switches;
  return { options, seed, unknown, open };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** A scenario whose own beat is this much slower than the run's never reached the display's rate. */
const SLOW_BEAT = 1.4;

/**
 * Count the tail of every scenario that never reached the display's rate in
 * the beat the rest of the run saw, rather than in its own. See summariseGaps()
 * in perf/frames.ts: a scenario where every frame is slow has a slow frame for
 * a beat, and its dropped frames stop counting. Marked `beatFrom: 'run'`.
 */
export function rebeat(results: ScenarioResult[], beat: number) {
  if (!beat) return;
  for (const s of results) {
    for (const r of s.runs) {
      if (r.summary.beatMs <= beat * SLOW_BEAT) continue;
      const times = decodeSeries(r.frames);
      Object.assign(r.summary, summariseGaps(scoredGaps(times, WARMUP_MS), beat), { beatFrom: 'run' });
    }
  }
}

const LAST_RUN_KEY = 'mbrd.bench.lastEnd';

/** When the previous run on this tab ended, if one did - see the thermal note in the plan. */
function sincePreviousRun(): number | null {
  try {
    const at = Number(sessionStorage.getItem(LAST_RUN_KEY));
    return at ? Math.max(0, Date.now() - at) : null;
  } catch { return null; }
}

function markRunEnded() {
  try { sessionStorage.setItem(LAST_RUN_KEY, String(Date.now())); } catch { /* private mode: the file says null */ }
}

class Cancelled extends Error {
  constructor() { super('benchmark cancelled'); this.name = 'AbortError'; }
}

export type Bench = ReturnType<typeof createBench>;

export function createBench(deps: BenchDeps) {
  const { vp, cmds, glass } = deps;
  let running = false;
  /** The standard board, once built on this page. */
  let built: { seed: number, generationMs: number, cards: number, assetBytes: number } | null = null;

  /** Which scenarios this run will attempt, in the table's order. */
  const planned = (standard: boolean, only?: string[]) =>
    SCENARIOS.filter(s => (!only || only.includes(s.id)) && (standard || !s.standardOnly));

  const content = () => board.items.filter(i => isContent(i) && i.type !== 'title');

  /** Frame the board with no animation, and say where that left the camera. */
  const fitNow = (): Fit => {
    const items = content();
    vp.fit(items, 80, 0);
    const box = itemBounds(items) ?? { x0: -500, y0: -500, x1: 500, y1: 500 };
    return { pan: { ...vp.pan }, zoom: vp.zoom, w: box.x1 - box.x0, h: box.y1 - box.y0 };
  };

  function applySwitches(s: BenchSwitches) {
    if (s.quality) setQualityLevel(s.quality);
    if (s.grain !== undefined) setQualityOverride('grain', s.grain);
    if (s.shadows !== undefined) setQualityOverride('shadows', s.shadows);
    if (s.whimsy !== undefined) cmds.setWhimsy(s.whimsy);
    if (s.grid !== undefined) setSetting('grid', s.grid);
    const flags: Partial<typeof mobilePerfFlags> = {};
    if (s.legacyVars !== undefined) flags.legacyVars = s.legacyVars;
    if (s.chrome !== undefined) flags.chrome = s.chrome;
    if (s.gridPos !== undefined) flags.gridPos = s.gridPos;
    if (Object.keys(flags).length) deps.perf.mobile(flags);
  }

  async function run(opts: BenchOptions = {}): Promise<BenchResult> {
    if (running) throw new Error('a benchmark is already running');
    const standard = (opts.board ?? (isBenchBoard() ? 'standard' : 'this')) === 'standard';
    if (standard && !isBenchBoard()) {
      throw new Error('the standard board runs at #bench - open the app at index.html#bench');
    }
    const switches = opts.switches ?? {};
    // The user's board is measured as it stands. A switch is a setting or a
    // preference, and either one thrown here would outlive the run.
    if (!standard && Object.keys(switches).length) {
      throw new Error('switches run on the standard board only, where nothing is kept');
    }
    // The Feed and Playlist are the Mobile profile, and leaving it drops the
    // undo stack (setBoardMode() in layout.ts) - an edit to their board.
    if (!standard && board.layoutMode === 'mobile') {
      throw new Error('switch to the canvas first - this board is measured where it is, and changing its layout would drop its undo history');
    }
    const repeat = Math.max(1, Math.min(5, Math.trunc(opts.repeat ?? 1)));
    running = true;
    const signal = opts.signal;
    const t0 = performance.now();
    const sincePrevious = sincePreviousRun();
    const view = { pan: { ...vp.pan }, zoom: vp.zoom };
    const sidebarWas = sidebarIsOpen();
    // The leak check: every card discard() throws away, and how many of those
    // the collector has since taken. A count that stays at zero while the
    // other climbs is the 2026-09-23 leak.
    let discarded = 0, finalised = 0;
    const registry = typeof FinalizationRegistry === 'function'
      ? new FinalizationRegistry<number>(() => { finalised++; }) : null;
    setDiscardProbe(el => { discarded++; registry?.register(el, discarded); });
    const results: ScenarioResult[] = [];
    let cancelled = false;
    try {
      if (standard && !built) built = await deps.buildBoard(opts.seed, opts.onBuild ?? (() => {}));
      if (standard && board.layoutMode === 'mobile') cmds.canvas();
      applySwitches(switches);
      const memBefore = { dom: domSize(), heapMB: heapMB() };
      const list = planned(standard, opts.only);
      const total = list.length * repeat;
      let index = 0;
      for (const sc of list) {
        const result: ScenarioResult = { id: sc.id, name: sc.name, runs: [] };
        results.push(result);
        for (let r = 0; r < repeat; r++) {
          opts.onProgress?.({ index: index++, total, id: sc.id, name: sc.name, repeat: r });
          const outcome = await runScenario(sc, signal);
          if (typeof outcome === 'string') { result.skipped = outcome; index += repeat - r - 1; break; }
          result.runs.push(outcome);
        }
      }
      return finish(memBefore);
    } catch (err) {
      if (!(err instanceof Cancelled)) throw err;
      cancelled = true;
      return finish({ dom: domSize(), heapMB: heapMB() });
    } finally {
      setDiscardProbe(null);
      cullProfile.on = deps.perf.active;
      if (cleanActive()) stopClean();
      cmds.tourStop();
      closeViewer();
      if (sidebarIsOpen() !== sidebarWas) (sidebarWas ? openSidebar : closeSidebar)();
      // This board goes back to exactly where it was looked at from.
      if (!standard) vp.setView(view.pan, view.zoom);
      markRunEnded();
      running = false;
    }

    function finish(memBefore: { dom: number, heapMB: number | null }): BenchResult {
      const beats = results.flatMap(s => s.runs.map(x => x.summary.beatMs)).filter(b => b > 0).sort((a, b) => a - b);
      const beat = beats.length ? beats[Math.floor(beats.length / 2)] : 0;
      rebeat(results, beat);
      // After rebeat(), which can move the figures the spread is taken over.
      for (const s of results) {
        if (s.runs.length < 2) continue;
        const of = (k: 'fps' | 'threePlusPct' | 'p95') => spread(s.runs.map(x => x.summary[k]));
        s.spread = { fps: of('fps'), threePlusPct: of('threePlusPct'), p95: of('p95') };
      }
      const whimsy = Number(document.documentElement.dataset.whimsy);
      const ua = navigator.userAgent;
      // deviceMemory is a Chromium extension absent from lib.dom.
      const memory = numberAt(navigator, 'deviceMemory');
      return {
        schema: BENCH_SCHEMA,
        kind: 'mbrd-bench',
        at: new Date().toISOString(),
        device: {
          platform: deps.platform,
          name: deviceName(ua, deps.platform),
          userAgent: ua,
          dpr: round(devicePixelRatio, 3),
          screen: { w: screen.width, h: screen.height },
          window: { w: innerWidth, h: innerHeight },
          seenHz: beat ? round(1000 / beat) : 0,
          claimedHz: glass ? lastClaimedHz : null,
          cores: navigator.hardwareConcurrency || null,
          memoryGB: memory || null,
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        },
        app: {
          version: VERSION,
          commit: COMMIT_COUNT,
          quality: qualityLevel(),
          flags: { ...quality },
          whimsy: Number.isInteger(whimsy) ? whimsy : null,
          grid: !!board.settings.grid,
          boardMode: board.layoutMode,
          mobilePerfFlags: { ...mobilePerfFlags },
          switches,
        },
        board: standard && built
          ? { kind: 'standard', ...built }
          : { kind: 'this', fingerprint: fingerprint(board.items, assetBytes()) },
        sources: { raf: true, longFrames: hasLoaf(), glass: !!glass },
        timing: {
          sinceLoadMs: Math.round(t0),
          sincePreviousRunMs: sincePrevious,
          totalMs: Math.round(performance.now() - t0),
          repeat,
        },
        scenarios: results,
        memory: {
          before: memBefore,
          after: { dom: domSize(), heapMB: heapMB() },
          discarded, finalised,
        },
        cancelled,
      };
    }
  }

  let lastClaimedHz: number | null = null;

  const frame = (signal?: AbortSignal) => new Promise<number>((resolve, reject) => {
    requestAnimationFrame(now => (signal?.aborted ? reject(new Cancelled()) : resolve(now)));
  });

  /**
   * Wait for a page with nothing left to do: every mounted picture decoded, and
   * a second of frames with no long one among them. Gives up after fifteen
   * seconds and runs anyway - a board that never settles is itself the result.
   */
  async function waitIdle(signal?: AbortSignal) {
    const imgs = [...vp.world.getElementsByTagName('img')];
    await Promise.race([
      Promise.all(imgs.map(im => im.decode().catch(() => {}))),
      new Promise(r => setTimeout(r, IDLE_MAX_MS / 2)),
    ]);
    const start = await frame(signal);
    let last = start, quietFrom = start;
    for (;;) {
      const now = await frame(signal);
      if (now - last > LONG_FRAME_MS) quietFrom = now;
      last = now;
      if (now - quietFrom >= IDLE_QUIET_MS || now - start > IDLE_MAX_MS) return;
    }
  }

  /** One scenario, recorded: a ScenarioRun, or why it did not run. */
  async function runScenario(sc: Scenario, signal?: AbortSignal): Promise<ScenarioRun | string> {
    if (signal?.aborted) throw new Cancelled();
    const fit = fitNow();
    const times: number[] = [];
    const ctx: Ctx = {
      vp, cmds, fit, times,
      frame: () => frame(signal),
      async wait(ms) {
        const end = (await frame(signal)) + ms;
        while ((await frame(signal)) < end) { /* frames pass */ }
      },
      async drive(ms, step) {
        const start = await frame(signal);
        for (;;) {
          const now = await frame(signal);
          const t = Math.min(1, (now - start) / ms);
          step(t);
          if (t >= 1) return;
        }
      },
      async settled(maxMs = 3000) {
        const end = (await frame(signal)) + maxMs;
        // A frame after the animation's own last one, so its final write paints.
        while (vp._anim != null && (await frame(signal)) < end) { /* gliding */ }
        await frame(signal);
      },
    };
    const refusal = sc.refuse?.(ctx);
    if (refusal) return refusal;
    await waitIdle(signal);
    // Recording starts here and ends when the scenario's promise does.
    let recording = true;
    const record = (now: number) => {
      if (!recording) return;
      times.push(now);
      requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
    const loaf = watchLongFrames();
    cullProfile.reset();
    cullProfile.on = true;
    let glassOn = false;
    if (glass) {
      try { await glass.start(); glassOn = true; } catch (err) { console.warn('[bench] no frame metrics:', err); }
    }
    let extra: { settleMs?: number } | void;
    try {
      extra = await sc.run(ctx);
    } finally {
      recording = false;
      loaf.stop();
    }
    let glassFrames: GlassFrames | null = null;
    if (glassOn && glass) {
      try { glassFrames = await glass.stop(); lastClaimedHz = glassFrames.refreshHz || null; }
      catch (err) { console.warn('[bench] frame metrics lost:', err); }
    }
    const gaps = scoredGaps(times, WARMUP_MS);
    const m = viewStats();
    const summary: ScenarioSummary = {
      ...summariseGaps(gaps),
      durationMs: times.length ? round(times[times.length - 1] - times[0]) : 0,
      longFrames: hasLoaf() ? longFrameTotals(loaf.entries, times[0] ?? 0, times[times.length - 1] ?? 0) : null,
      cullAvgMs: cullProfile.runs ? round(cullProfile.ms / cullProfile.runs, 3) : null,
      cullFullSyncPct: cullProfile.runs ? round(100 * cullProfile.fullSyncs / cullProfile.runs) : null,
      mounted: m.mounted,
      decodedMB: round(m.imgBytes / 1048576),
    };
    if (extra && extra.settleMs !== undefined) summary.settleMs = extra.settleMs;
    const out: ScenarioRun = { summary, frames: encodeSeries(times) };
    if (glassFrames && glassFrames.frames.length) {
      const g = glassFrames.frames;
      const vs = g.map(f => f.vsync);
      // The same warm-up as the page's own series, measured from the first vsync.
      const vsGaps = scoredGaps(vs, WARMUP_MS);
      const totals = g.map(f => f.total).sort((a, b) => a - b);
      const missed = g.filter(f => f.total > f.deadline).length;
      summary.glass = {
        n: g.length,
        missed,
        missedPct: round(100 * missed / g.length),
        p95TotalMs: round(totals[Math.min(totals.length - 1, Math.floor(0.95 * totals.length))]),
        worstTotalMs: round(totals[totals.length - 1]),
        vsync: summariseGaps(vsGaps.length ? vsGaps : gapsOf(vs)),
      };
      out.glass = {
        ...encodeSeries(vs),
        total: g.map(f => Math.round(f.total * 10)),
        deadline: g.map(f => Math.round(f.deadline * 10)),
      };
    }
    return out;
  }

  /** The standard board, built and left on the canvas with nothing run - `#bench:board`. */
  async function openBoard(seed?: number, onBuild: (f: number) => void = () => {}): Promise<void> {
    if (!isBenchBoard()) throw new Error('the standard board opens at #bench - open the app at index.html#bench:board');
    if (!built) built = await deps.buildBoard(seed, onBuild);
    if (board.layoutMode === 'mobile') cmds.canvas();
    fitNow();
  }

  return {
    get running() { return running; },
    /** The scenarios a run on this board would attempt, for the overlay's count. */
    planned: (standard: boolean) => planned(standard).map(s => ({ id: s.id, name: s.name })),
    run,
    openBoard,
  };
}
