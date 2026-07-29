# View-frame performance — handoff (2026-07-29)

Status of the pan/zoom performance work. Three changes are in the working tree,
uncommitted, on top of `v0.62` (`d3f3987`). This document records what they do,
why, how to verify them, and what the work is aiming at next.

## The problem being chased

Every pan and zoom fires `vp.onChange`, and that listener repaints the grid.
The grid is painted in *screen* space (CSS radial gradients on `#viewport`, or a
`Path2D` fill on the "Harsh" whimsy tier), so it repaints on **every** view
frame — full-viewport, at the display's refresh rate, for the whole duration of
a gesture. The open question the work started from: on a moving board, how much
of a frame is `paintGrid()` versus everything else the listener does? Measure
first, then cut.

## What's done (working tree, uncommitted)

### 1. Grid tier-fade is skipped mid-motion — `web/assets/js/canvas/grid.js`

`tierFade()` (grid.js:560) cross-dissolves the two dot lattices when a zoom
crosses a tier boundary (a doubling/halving of the grid step). The fade draws
**both** lattices at once for ~100ms (`TIER_MS`): up to fourteen radial
gradients repainted full-viewport, or a doubled `Path2D` fill on Harsh, held up
by its own repaint loop.

Standing still that's a harmless nicety. Under a continuous zoom the board
crosses tier after tier, the fades overlap, and it becomes a sustained
double-paint — felt exactly as the lag when the dots re-tier.

Fix (grid.js:567): the fade is suppressed while the view is moving.

```js
tier = { step, from: adjacent && !still() && !vp.moving ? tier.step : 0, at: now };
```

`vp.moving` (viewport.js:246, set by `_moving()`) is already `true` by the time
`paintGrid` runs inside a gesture. Mid-motion the marks simply snap — the fade
is invisible at that speed anyway — and the dissolve is kept for the slow,
settled crossing it was written for.

- Risk: low. Only affects the visual transition, not the grid geometry.
- Watch: a single wheel-notch zoom that settles immediately should still fade
  (the board is not "moving" once the gesture ends).

### 2. Mobile board-frame CSS vars skipped on Desktop — `web/assets/js/canvas/viewport.js`

The `_paint` path wrote five custom properties every frame — `--mobile-board-left`,
`--mobile-board-width`, `--mobile-board-top`, `--mobile-board-bottom`,
`--mobile-header-height` — that only the Mobile-layout DOM reads
(`#mobile-board-frame` et al. are `display:none` off Mobile). On every Desktop
pan frame that was `mobileScreenRect()` arithmetic plus five style
invalidations spent on properties nothing reads.

Fix (viewport.js:676): guard the whole block behind `if (this.isMobile)`.

```js
if (this.isMobile) {
  const { left, width, top, bottom } = this.mobileScreenRect();
  // ...set the five properties...
}
```

`isMobile` is a real getter (`get isMobile() { return this.boardMode === 'mobile'; }`,
viewport.js:268). Switching into Mobile re-runs `_paint` through
`setBoardMode → apply`, so the values are current the moment they start being
read again — no stale-frame risk.

- Risk: low. Verified the getter exists and is used throughout the class.
- Watch: correctness lives entirely in `isMobile` being accurate at mode-switch
  time; the re-paint on `setBoardMode` covers it.

### 3. Dev-only view-frame profiler — `web/assets/js/main.js`

Shipped so the rest of the work can be measured rather than guessed. Exposed as
`mbrd.perf`.

- `mbrd.perf.on()` / `.off()` — arm/disarm. `on(false)` skips the on-screen HUD
  (console only).
- On-screen HUD (main.js:284) — a fixed readout showing `fps / jank% / n`,
  updated 4×/sec. Built for the **phone**: a touch device with no console can be
  measured on the glass instead of over a debugging cable.
- URL trigger (main.js, near `window.mbrd`): opening the board at `.../#perf`
  arms the profiler automatically — `if (location.hash.includes('perf'))
  viewPerf.on();`.
- `mbrd.perf.report()` — dumps a table: median fps, p95-low (slow tail), worst
  frame gap, jank %, and the listener's own JS split (`jsGridAvgMs` vs
  `jsRestAvgMs`) so the grid's cost can be read against everything else.

Design notes worth keeping:
- Zero cost when off. `vp.onChange` reads one boolean (`viewPerf.active`) and
  takes the same path as ever; the two `performance.now()` marks only run when
  armed (main.js:377-384).
- The listener body after the grid was extracted into `afterGrid()` (main.js:367)
  so the profiler can time `paintGrid()` alone against the rest without
  duplicating the code.
- Only **moved** frames count toward the cadence (`moved` flag set in
  `sample()`). Idle rAF ticks between gestures would otherwise read as huge
  stalls and drown the real in-motion frame rate — that was the trap in the
  first cut.
- Frame gaps are held raw (capped at `CAP = 8000`, ~a minute of 120fps) so
  `report()` can take real percentiles; the median is the honest frame rate, the
  tail is the jank.

## Known issue in the profiler

`report()` (main.js:335) destructures `{ sorted, janks }` from `stats()` but
then uses a bare `median` at main.js:342 (`fpsMedian: +(1000 / median)...`).
`median` is not in scope there → `fpsMedian` comes out `NaN`. The HUD is
unaffected (it reads `median` from its own `stats()` call). Fix: destructure
`median` too, `const { sorted, median, janks } = stats();`. Low priority — it's
a dev tool — but it makes the headline number in `report()` useless until fixed.

## What's planned / next

The profiler is step one (measure). The intended sequence from here:

1. **Fix the `report()` median bug** so the numbers are trustworthy.
2. **Baseline on real hardware.** Run `#perf` on the phone (once the phone can
   load the board — see caveat below) and on desktop; capture median fps, p95,
   and the `jsGridAvgMs` / `jsRestAvgMs` split under sustained pan and sustained
   zoom, on each whimsy tier (gradient tiers vs Harsh `Path2D`).
3. **Cut grid repaint cost** — the premise of the whole effort. Candidates, in
   rough order, to be confirmed by the baseline:
   - Reduce the gradient count per paint on the gradient tiers (up to fourteen
     radial gradients full-viewport is the suspected hot spot).
   - Avoid repainting the grid when the view change doesn't move it enough to
     matter (sub-pixel pans).
   - Confirm the tier-fade and mobile-var changes above actually move the needle
     under the profiler, not just in theory.

Treat item 3 as hypotheses until the baseline says which one the frame is
actually spending time in — that is exactly what the profiler is for.

## Testing status

- `node --check` passes on all three touched JS files.
- App loads fine in a fresh/incognito browser on the dev machine (rules out a
  load-time regression from these edits).
- `npm test` not yet re-run against these edits — do it before committing.
- Not yet profiled on hardware.

## Unrelated caveat (not part of this work)

Phone testing over LAN hit a wall that cost time and is **not** a code issue:
- Windows Firewall on the desktop needed an inbound allow for python /
  TCP 6273 (the laptop already had it — hence "works from the laptop").
- After that the phone reached the server but showed a **blank page**. The build
  is fine (incognito on the desktop loads it). Cause is a stale/broken service
  worker cached on the phone for this desktop's origin (`192.168.0.126`), which
  is a *different* origin from the laptop's IP, so the laptop looked clean.
  Device: Android 16, Samsung Internet. Fix: clear that site's data on the phone
  (Samsung Internet → site settings for the address → delete data / unregister
  SW), then reload. No code change required.
