// The view-change frame, profiled - a dev tool and nothing else.
//
// Lifted out of main.js, where it was a 340-line IIFE in the middle of the
// wiring point. Nothing here runs on a board that never opens the console: the
// view listener reads `.active` and skips its two performance.now() marks while
// this is off, so the shipped path pays one boolean read per frame.
//
// The point it measures is the whole premise of the grid performance work: on a
// pan or zoom, how much of a frame is paintGrid() and how much is everything
// else? `mbrd.perf.on()`, pan/zoom for a few seconds, `mbrd.perf.report()`.
//
// A factory rather than a module-level singleton, for the reason every module
// under this tree is one: it needs the Viewport, and reaching for a browser
// global at import time is what tests/imports.test.js exists to prevent.

import { board } from '../state.ts';
import { cullProfile, viewStats } from '../canvas/items.ts';
import { mobilePerfFlags } from '../canvas/viewport.ts';

/**
 * One session's profiler, as its callers know it.
 *
 * Inferred from the factory rather than written out, because the object below
 * is thirty lines of methods and a hand-kept second copy of that shape would be
 * wrong within a release. It exists at all because the profiler is now injected
 * into the command surface (main.ts hands it to createCommands), and an
 * injection needs a name for what is being handed over.
 */
export type ViewPerf = ReturnType<typeof createViewPerf>;

/**
 * @param vp  the live Viewport - only `mobile()` touches it, to re-apply after
 *            a kill switch is thrown, which is the whole of what is asked of it
 *            and so the whole of what the parameter names.
 */
export function createViewPerf(vp: { apply(): void }) {
  let on = false, raf = 0, lastRaf = 0, moved = false;
  // An on-screen readout, built lazily the first time it is asked for. The
  // point of it is the phone: a device with no console the median frame rate can
  // be read off, so a real touch device can be measured on the glass instead of
  // over a debugging cable. Desktop gets it too - a live number beside the
  // gesture is worth more than one printed after it.
  let hud: HTMLDivElement | null = null, hudText: HTMLDivElement | null = null, hudAt = 0;
  // JS cost of the main.js view listener, per view frame.
  let gridMs = 0, restMs = 0, frames = 0, worstFrame = 0;
  // True frame cadence: the interval between animation frames, but recorded only
  // on frames where the view actually moved (a sample() landed since the last
  // rAF). Idle frames between two gestures would otherwise read as enormous
  // stalls and drown the real in-motion cadence - which was the trap in the
  // first cut of this. Held as raw intervals so report() can take percentiles;
  // the median is the honest frame rate, the tail is the jank.
  const gaps: number[] = [];
  const CAP = 8000;                 // ~a minute of 120fps motion; then it wraps
  const reset = () => {
    gridMs = restMs = frames = worstFrame = 0; gaps.length = 0; lastRaf = 0; moved = false;
    cullProfile.reset();
  };
  const pct = (sorted: number[], p: number) => sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
  /**
   * How far a gap is off the display's own beat, in frames.
   *
   * A gap is never a free quantity: the compositor hands over on a refresh or
   * it does not, so every interval is a whole number of them and the whole
   * distribution lands on multiples of one. Anything that is *not* near a
   * multiple did not come from a missed refresh, which is why it is counted
   * separately below.
   */
  const OFF_BEAT = 0.25;
  /** Below this a gap is a normal frame and no question is being asked of it. */
  const A_FRAME = 1.15;

  const stats = () => {
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = pct(sorted, 0.5) || 0;
    const janks = median ? gaps.filter(g => g > median * 1.5).length : 0;
    // The display's fastest interval, as this run actually saw it - not as the
    // device claims and not as the median says.
    //
    // The median is the wrong number to measure jank against on a phone, and
    // reading a run against it is what nearly cost a day. These panels change
    // refresh rate on their own: 120Hz under the finger, 60 when the system
    // decides otherwise. A run that spends part of itself at 60 has a median
    // pulled towards 16.7ms, so genuinely dropped frames stop looking dropped -
    // and, worse the other way, a clean stretch at 60Hz scores as jank against
    // a 120Hz median while nothing was missed at all.
    //
    // So the beat is taken from the fast end of the run instead: the 5th
    // percentile is the interval the panel manages when it is trying, robust
    // against the one or two impossibly short gaps a timer can produce.
    const base = pct(sorted, 0.05) || median;
    // ...and the tail is expressed in that beat. Two beats is deliberately kept
    // apart from three: a two-beat gap is exactly what a drop to 60Hz looks
    // like on a 120Hz panel and cannot be told from one missed refresh by any
    // arithmetic on this data, so it is reported and not accused. Three or more
    // is past anything a refresh-rate change explains, and is the honest count
    // of frames this app actually lost.
    const twos = base ? gaps.filter(g => g >= base * 1.5 && g < base * 2.5).length : 0;
    const overs = base ? gaps.filter(g => g >= base * 2.5).length : 0;
    // Gaps that are not a whole number of beats at all. A panel that stepped to
    // some third rate - 90Hz is 1.33 beats of 120 - lands here rather than in
    // the two counts above, which is the point: it is the one shape in the data
    // that says the beat itself moved. Overlaps `twos`/`overs` by design.
    const off = base ? gaps.filter(g => {
      const f = g / base;
      return f > A_FRAME && Math.abs(f - Math.round(f)) > OFF_BEAT;
    }).length : 0;
    return { sorted, median, janks, base, twos, overs, off };
  };
  /**
   * Which run this is, named as the address that produces it.
   *
   * Derived from the flags rather than from the hash, because the console can
   * set them too - and a console that has set two at once gets both names and
   * no address, which is the honest answer to "which run is this".
   */
  const runLabel = () => {
    const off = [
      mobilePerfFlags.legacyVars && 'legacy',
      !mobilePerfFlags.chrome && 'nochrome',
      !mobilePerfFlags.gridPos && 'nogrid',
    ].filter((name): name is string => !!name);
    const runs: Record<string, number> = { legacy: 1, nochrome: 2, nogrid: 3 };
    if (!off.length) return '#perf shipped';
    return off.length === 1 ? `#perf${runs[off[0]]} ${off[0]}` : off.join(' ');
  };

  /**
   * The whole reading as one line, which is the shape it is wanted in.
   *
   * Four runs are compared against each other, so four of these stack into
   * something readable with no editing, and each carries the address that
   * reproduces it and the board it was taken on - two readings only compare if
   * they were the same board in the same mode.
   */
  const summary = () => {
    const { sorted, median, base, twos, overs, off } = stats();
    if (!gaps.length) return `${runLabel()} — no motion sampled`;
    const m = viewStats();
    const cullAvg = cullProfile.runs ? cullProfile.ms / cullProfile.runs : 0;
    const fullPct = cullProfile.runs ? 100 * cullProfile.fullSyncs / cullProfile.runs : 0;
    const share = (k: number) => (100 * k / gaps.length).toFixed(1) + '%';
    return [
      runLabel(),
      `${board.layoutMode} ${board.items.length} items`,
      `fps ${(1000 / median).toFixed(1)}`,
      `beat ${base.toFixed(1)}ms`,
      // The two counts that replaced a jank percentage measured against a
      // median the panel is free to move - see stats().
      `2f ${share(twos)}`,
      `3f+ ${share(overs)}`,
      `offbeat ${share(off)}`,
      `worst ${pct(sorted, 1).toFixed(0)}ms`,
      `n ${gaps.length}`,
      `cull ${cullAvg.toFixed(2)}ms`,
      `full ${fullPct.toFixed(0)}%`,
      `mnt ${m.mounted}`,
      `vid ${m.videos}`,
      `img ${(m.imgBytes / 1048576).toFixed(0)}MB`,
    ].join('  ');
  };

  /**
   * Put a string on the clipboard on a device that has no console and,
   * usually, no secure context either.
   *
   * navigator.clipboard is the right answer and is the one that will not be
   * there: the phone reaches this board over the LAN at http://192.168.x.x, and
   * the Clipboard API is gated on a secure context, so the whole namespace is
   * undefined on exactly the device this button exists for. execCommand is
   * deprecated and works there, which is the trade - and it is tried first, for
   * the reason written against it below.
   *
   * And when neither lands, the text is put in a selectable box instead and the
   * user copies it by hand. A dev tool that says "copied" without copying is
   * worse than one that hands you the text.
   */
  const copyText = (text: string): Promise<boolean> => {
    // execCommand first, and synchronously, which is the whole point of the
    // order. Both paths need the tap that is still in progress, and awaiting
    // the Clipboard API's rejection would spend it: by the time the promise
    // settles the gesture is no longer the transient activation execCommand
    // asks for, so the fallback would fail on precisely the device it exists
    // for. Nothing is awaited before the attempt that has to work.
    const box = document.createElement('textarea');
    try {
      box.value = text;
      // Off-screen but focusable, and readOnly so a phone does not open its
      // keyboard over the readout on the way past.
      box.readOnly = true;
      box.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
      document.body.append(box);
      box.select();
      box.setSelectionRange(0, text.length);
      if (document.execCommand('copy')) return Promise.resolve(true);
    } catch { /* deprecated, and one day gone - the API below is the future */ }
    // In a finally-shaped position rather than after the call, because an
    // engine that has already removed execCommand throws there and left the
    // <textarea> in document.body - one orphan per press of a button whose
    // whole purpose is to be pressed until something works.
    finally { box.remove(); }
    try {
      if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text).then(() => true, () => false);
      }
    } catch { /* no secure context: there is nothing left to try */ }
    return Promise.resolve(false);
  };

  const showHud = () => {
    if (hud) return;
    hud = document.createElement('div');
    hud.id = 'perf-hud';
    hud.style.cssText =
      'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:99999;'
      + 'font:600 13px/1.3 ui-monospace,monospace;padding:6px 10px;border-radius:8px;'
      + 'background:rgba(0,0,0,.8);color:#0f0;pointer-events:none;white-space:pre;text-align:center';
    // The figures and the button are two children now, because the readout is
    // rewritten four times a second and a button inside that string would be
    // destroyed on the next repaint.
    // Held as a local as well, because the copy handler below reads it a tap
    // later - and by then the closure sees the outer binding, which the HUD
    // being taken down is allowed to have set back to null.
    const line = document.createElement('div');
    hudText = line;
    line.textContent = 'perf — move the board';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'copy';
    // The panel is inert to the pointer - it sits over the board and must not
    // catch a drag meant for it - so the one thing that is not gets it back.
    // 32px of height because this is tapped with a thumb.
    copy.style.cssText =
      'pointer-events:auto;margin-top:5px;width:100%;min-height:32px;'
      + 'font:inherit;color:inherit;background:rgba(255,255,255,.12);'
      + 'border:1px solid currentColor;border-radius:6px;cursor:pointer';
    copy.addEventListener('click', async () => {
      const text = summary();
      const ok = await copyText(text);
      copy.textContent = ok ? 'copied' : 'select and copy ↓';
      // Nothing could reach the clipboard, so hand over the text instead.
      if (!ok) line.textContent = text;
      setTimeout(() => { copy.textContent = 'copy'; }, 1500);
    });
    hud.append(line, copy);
    document.body.appendChild(hud);
  };
  const hideHud = () => { hud?.remove(); hud = hudText = null; };
  /** Whether it did the work - see the gap it costs, in tick(). */
  const paintHud = (now: number): boolean => {
    // hud and hudText are put up and taken down together, so either one standing
    // alone is not a state this has - but only the pair being tested says so.
    if (!hud || !hudText || now - hudAt < 250) return false;   // four updates a second is plenty
    // Before stats(), which sorts a copy of up to eight thousand numbers and
    // then divides by gaps.length four times. With no gaps yet there is nothing
    // to sort and nothing the readout could say, and this used to be tested
    // after all of it.
    if (!gaps.length) return false;
    hudAt = now;
    const { median, base, twos, overs, off } = stats();
    // A second line for what the frame rate cannot say on a panel that changes
    // its own refresh rate: the beat this run was actually delivered on, and
    // the tail counted in it - see stats(). `2f` is the ambiguous column and
    // `3f+` the accusing one.
    //
    // A third for what no frame rate can show: the cull's own per-frame cost
    // (the zoom-out hot path) and what is mounted right now - live node and
    // video counts and the decoded-image megabytes, which is the budget an
    // iPhone runs out of when the whole board is framed.
    //
    // A fourth saying which run this is. Every one of these numbers is read off
    // the glass, and a column of figures with no note of which switch was
    // thrown is a column of figures that has to be taken again. The board and
    // its size are here for the same reason: two runs only compare if they were
    // the same board in the same mode.
    const cullAvg = cullProfile.runs ? cullProfile.ms / cullProfile.runs : 0;
    const m = viewStats();
    const share = (k: number) => (100 * k / gaps.length).toFixed(1);
    hudText.textContent =
      `${(1000 / median).toFixed(0)} fps   beat ${base.toFixed(1)}ms   n ${gaps.length}\n`
      + `2f ${share(twos)}%   3f+ ${share(overs)}%   offbeat ${share(off)}%\n`
      + `cull ${cullAvg.toFixed(2)}ms   mnt ${m.mounted}  vid ${m.videos}  img ${(m.imgBytes / 1048576).toFixed(0)}MB\n`
      + `${board.layoutMode} ${board.items.length} items   ${runLabel()}`;
    return true;
  };
  /**
   * Whether the last frame carried the readout, and so must not be measured.
   *
   * The profiler's own work lands in the interval it is about to report: a
   * sort of up to eight thousand numbers, four filter passes and a text node
   * rewrite, all inside the rAF callback whose *next* gap they lengthen. Four
   * times a second, that inflates `2f`, `3f+` and `offbeat` - and it inflates
   * them most on the slow devices the readout exists for, which is the one
   * place a profiler must not be the thing it is measuring. So the gap the
   * paint lands in is skipped: four samples a second out of sixty, in exchange
   * for figures that are about the app.
   */
  let painted = false;
  const tick = (now: number) => {
    if (!on) return;
    // Only a moved frame counts. requestAnimationFrame still fires at the
    // display rate on an idle board, and those intervals are not what we are
    // measuring - the question is how fast frames come while something is
    // actually happening.
    if (lastRaf && moved && !painted) {
      if (gaps.length >= CAP) gaps.shift();
      gaps.push(now - lastRaf);
    }
    lastRaf = now;
    moved = false;
    painted = paintHud(now);
    raf = requestAnimationFrame(tick);
  };
  return {
    get active() { return on; },
    /** @param overlay  false to skip the on-screen readout (console only). */
    on(overlay = true) {
      // Arming an armed profiler starts the counters again and nothing else.
      // It used to start a second rAF loop as well, which sampled every frame
      // twice - and re-arming is the normal case now that switching runs is a
      // change of hash rather than a reload.
      const already = on;
      reset(); on = true; cullProfile.on = true;
      if (overlay) showHud();
      if (!already) raf = requestAnimationFrame(tick);
      console.log('[perf] on — pan/zoom continuously, then mbrd.perf.report()');
    },
    off() { on = false; cullProfile.on = false; if (raf) cancelAnimationFrame(raf); raf = 0; hideHud(); console.log('[perf] off'); },
    /**
     * The three Mobile kill switches, as one call - see mobilePerfFlags.
     *
     * `mbrd.perf.mobile({ legacyVars: true })` and so on. The class is here
     * rather than in the module because hiding the chrome is a stylesheet's job
     * and skipping the writes is the module's; both hang off the one flag.
     *
     * Returns the resulting flags, which is what makes this usable from a phone
     * - there is no console to read a global out of, so the call has to answer.
     */
    mobile(patch: Partial<typeof mobilePerfFlags> = {}) {
      Object.assign(mobilePerfFlags, patch);
      document.documentElement.classList.toggle(
        'perf-no-mobile-chrome', !mobilePerfFlags.chrome);
      vp.apply();
      return { ...mobilePerfFlags };
    },
    /** JS timings for one view frame, in ms: grid paint and the rest. */
    sample(grid: number, rest: number) {
      gridMs += grid; restMs += rest; frames++; moved = true;
      const f = grid + rest;
      if (f > worstFrame) worstFrame = f;
    },
    report() {
      if (!gaps.length) { console.log('[perf] no motion sampled — mbrd.perf.on(), then pan'); return null; }
      const { sorted, median, janks, base, twos, overs, off } = stats();
      const mem = viewStats();
      const share = (k: number) => +(100 * k / gaps.length).toFixed(1);
      const r = {
        // Which board and which layout, because two runs of this are only
        // comparable if they were the same board in the same mode - and the
        // Mobile work is measured by exactly that comparison.
        boardMode: board.layoutMode,
        items: board.items.length,
        motionFrames: gaps.length,
        fpsMedian: +(1000 / median).toFixed(1),
        fpsP95Low: +(1000 / pct(sorted, 0.95)).toFixed(1),   // the slow tail
        worstFrameGapMs: +pct(sorted, 1).toFixed(1),
        // The tail against the beat this run was delivered on rather than
        // against its own median, because the panel moves the median - see
        // stats(). Two beats is the ambiguous column: on a 120Hz panel it is
        // both "one frame missed" and "the display stepped down to 60", and no
        // arithmetic on this data separates them. Three or more is past what a
        // refresh-rate change explains and is the honest count of lost frames.
        beatMs: +base.toFixed(2),
        twoBeatPct: share(twos),
        threePlusBeatPct: share(overs),
        offBeatPct: share(off),   // the beat itself moved: 90Hz is 1.33 of 120
        // Kept for continuity with readings taken before the beat existed, and
        // not to be trusted on a variable-refresh display: it is measured
        // against the median, which such a display is free to move under it.
        jankPct: +(100 * janks / gaps.length).toFixed(1),
        // The listener's own JS share, for contrast - this is what the grid
        // rewrite would have touched, and it is tiny.
        jsGridAvgMs: frames ? +(gridMs / frames).toFixed(3) : null,
        jsRestAvgMs: frames ? +(restMs / frames).toFixed(3) : null,
        jsWorstFrameMs: +worstFrame.toFixed(3),
        // The cull the grid profiler never saw: its per-frame cost, and how often
        // a frame fell through to a full sync() (near 100% while zooming out).
        cullAvgMs: cullProfile.runs ? +(cullProfile.ms / cullProfile.runs).toFixed(3) : null,
        cullFullSyncPct: cullProfile.runs
          ? +(100 * cullProfile.fullSyncs / cullProfile.runs).toFixed(1) : null,
        // What is mounted at report time - the memory budget, not the frame time.
        mountedNodes: mem.mounted,
        liveVideos: mem.videos,
        decodedImgMB: +(mem.imgBytes / 1048576).toFixed(1),
      };
      console.table(r);
      // The same reading as the HUD's copy button puts on the clipboard, so a
      // run taken at the desk and a run taken on the glass are written the same
      // way and stack into one table.
      console.log(summary());
      return r;
    },
    /** The one-line reading, for a console that would rather have the string. */
    line: () => summary(),
  };
}

/**
 * Arm the profiler from the URL, and keep it in step with the hash.
 *
 * A phone has no console to type mbrd.perf.on() into, so the profiler can be
 * armed from the address as well: open the board at `.../#perf` on the device
 * and the on-screen readout comes up on its own. Harmless anywhere else.
 *
 * The three Mobile kill switches ride it too, because they are for exactly the
 * device that cannot be typed into - see mobilePerfFlags in canvas/viewport.js.
 * One run is one digit:
 *
 *   #perf    what shipped
 *   #perf1   the five #viewport custom properties written again
 *   #perf2   the Mobile sheet and masthead gone entirely
 *   #perf3   the lattice's background-position write skipped
 *
 * A digit rather than a word, because this is typed with a thumb on the device
 * being measured and between two runs exactly one character changes.
 *
 * Re-read on hashchange as well as at boot, which is the point of the digit
 * being at the end: a hash edit does not reload, so the run changes while the
 * board, the mounted set and every decoded image stay exactly as they were.
 * Two readings taken that way differ by the switch and by nothing else, which
 * is more than can be said for two readings either side of a reload. Arming an
 * already-armed profiler restarts its counters, so each run is measured clean.
 */
export function initPerfHash(perf: ViewPerf) {
  const armPerf = () => {
    // Anchored, and the digit is the whole of what may follow. Unanchored, this
    // matched the substring anywhere in the fragment: #imperfect, #superficial
    // or a heading anchor on a board somebody shared armed the profiler and put
    // a green readout over the board for a reader who asked for nothing.
    const run = location.hash.match(/^#perf(\d)?$/);
    if (!run) {
      // off() only stops the profiler; a run entered as #perf2/#perf3 also set
      // Mobile kill switches (hidden chrome, skipped grid writes) that would
      // otherwise persist after the hash is cleared. Put them back to default -
      // unconditionally, because `perf.active` is not the state they belong to:
      // mbrd.perf.off() from the console leaves the flags set and the profiler
      // inactive, and then clearing the hash was the one path that would have
      // restored them and did not. The Mobile sheet and the masthead stayed
      // gone for the session, which is exactly what the note above says is
      // being prevented. Both calls are no-ops when nothing was armed.
      if (perf.active) perf.off();
      perf.mobile({ legacyVars: false, chrome: true, gridPos: true });
      return;
    }
    perf.mobile({
      legacyVars: run[1] === '1',
      chrome: run[1] !== '2',
      gridPos: run[1] !== '3',
    });
    perf.on();
  };
  armPerf();
  addEventListener('hashchange', armPerf);
}
