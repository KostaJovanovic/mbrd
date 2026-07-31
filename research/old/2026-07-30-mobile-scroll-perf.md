# Mobile board scroll — root causes and plan (2026-07-30)

## Results

### The authoritative set (2026-07-31 00:09, warm, beat-aware)

Taken after the readout learned to measure against the display's beat rather
than the median, and with the board already warm — so neither the warm-up curve
nor the panel's refresh rate is in the way. 101-item Mobile board, 120Hz device.
`3f+` is the honest count of lost frames; `2f` is the ambiguous column; `beat`
is the fastest interval the panel delivered in that run.

| Run | fps | beat | 2f | **3f+** | offbeat | worst | n | cull | mnt |
|-----|-----|------|----|---------|---------|-------|---|------|-----|
| `#perf` shipped | 120.5 | 8.3ms | 3.2% | **0.5%** | 0.0% | 117ms | 1258 | 0.08ms | 6 |
| `#perf1` legacy | **59.9** | 8.3ms | 32.2% | **37.6%** | 0.0% | 133ms | 497 | 0.15ms | 6 |
| `#perf2` nochrome | 120.5 | 8.3ms | 3.3% | **0.3%** | 0.0% | 117ms | 1010 | 0.08ms | 4 |
| `#perf3` nogrid | 120.5 | 8.2ms | 2.5% | **0.2%** | 0.1% | 125ms | 1221 | 0.09ms | 5 |

**`beat` is 8.3ms in every run, the legacy one included.** That one column
closes the question the whole beat-aware rewrite was built to ask. The panel was
running at 120Hz throughout — its fastest interval was 8.3ms even while the
board was delivering 59.9 — so the halved frame rate is not the display
stepping down to 60. The display was ready every 8.3ms and the app could not
feed it. **The variable-refresh explanation is excluded, not argued away.**

**M-1 is now proven rather than inferred.** Restoring the five `#viewport`
custom properties takes genuinely-lost frames from 0.5% to **37.6%** — seventy
times as many — with another 32.2% at two beats on top, and delivers 497 frames
where the same gesture delivers 1258. `cull` doubles, 0.08 → 0.15ms, which is
the same one style invalidation being paid for in a second place.

**Steps 4 and 5 are closed on the numbers, this time cleanly.** `nochrome` and
`nogrid` are indistinguishable from what shipped: 0.3% and 0.2% against 0.5%,
which is noise. Neither the Mobile chrome nor the lattice repaint costs a
measurable frame on this board. The earlier readings that appeared to say
otherwise were the warm-up curve and the refresh rate, in some mixture, and not
a cost.

**One thing is left and is not addressed here.** `worst` is 117–133ms in *every*
run, the two good ones included — about fourteen beats, once per gesture. It is
not one of the three switches, it survives all of them, and at once per gesture
on an otherwise clean board it was not worth chasing today. First place to look
is a card build or an image decode landing on a frame; `BUILD_BUDGET` in
`canvas/items.js` is the knob if it ever becomes worth it.

### The first set (2026-07-30 23:43-23:50), and why it misled

Kept because the way it misled is worth more than the figures in it. `p95` is a
frame rate at the slow tail and `jank` the share of frames past 1.5x the run's
own median — both of which turned out to be the wrong questions. Runs are in the
order they were taken.

| # | Run | fps | p95 | worst | jank | n | cull | mnt |
|---|-----|-----|-----|-------|------|---|------|-----|
| 1 | `#perf` shipped, **cold** | 119.0 | 24.0 | 167ms | 28.3% | 727 | 0.16ms | 6 |
| 2 | `#perf1` legacy | **60.2** | 29.9 | 142ms | 20.3% | 479 | 0.23ms | 5 |
| 3 | `#perf2` nochrome | 120.5 | 59.9 | 117ms | 7.2% | 889 | 0.13ms | 6 |
| 4 | `#perf3` nogrid | 120.5 | 60.2 | 133ms | 5.8% | 843 | 0.12ms | 5 |
| 5 | `#perf` shipped, **warm** | 120.5 | **117.6** | 133ms | **4.7%** | 1347 | 0.08ms | 6 |

### Two traps, both in that table

**Trap one: a cold first run is not a baseline.** Run 5 is the same build as run
1 and beats it on every figure — 4.7% against 28.3% — so most of what runs 2 to
4 appeared to recover was the board getting warm: cards built, images decoded,
the first pass over ground that had never been mounted. Read against run 1, runs
3 and 4 look like the grid repaint and the Mobile chrome each costing a quarter
of the frames. That is a tidy story and it is the wrong one; the warm set above
shows both switches costing nothing at all. Only two runs of the *same* build at
either end of a session make the curve visible.

**Trap two, below.** The tail column in this table cannot mean what its units
claim.

### The p95 column is quantised, and the panel moves

Noticed after the table was written, and it changes how it should be read.
Every gap in it is a whole number of refreshes:

| p95 reported | gap | at 120Hz |
|--------------|-----|----------|
| 117.6 | 8.50ms | 1 frame |
| 60.2 / 59.9 | 16.6 / 16.7ms | 2 frames |
| 29.9 | 33.4ms | 4 frames |
| 24.0 | 41.7ms | 5 frames |

So `p95 = 60` does not mean "60 fps". It means the 95th-percentile frame took
**two refreshes** — and two refreshes at 120Hz is the same 16.7ms as one refresh
at 60Hz. These panels change their own rate, so no arithmetic on gap data can
tell "one frame was dropped" from "the display stepped down". Runs 3 and 4
landing at 59.9 and 60.2 is that: they are sitting on a rate, not agreeing with
each other about a cost.

The beat-aware set at the top settles which it was, and the answer is neither of
the flattering ones: `beat` came back 8.3ms in *every* run, so the panel never
stepped down at all — those two-refresh gaps were frames the app missed on a
display that was ready. Small numbers of them, and the same small number in
every warm run, which is why they indict nothing.

Worse, `jankPct` was measured against *the run's own median*, which a variable
display is free to move: a clean stretch at 60Hz scores as jank against a 120Hz
median while nothing was missed at all. The readout now takes the beat from the
5th-percentile gap - the interval the panel manages when it is trying - and
reports the tail in beats: `2f` (ambiguous, as above), `3f+` (past anything a
refresh change explains, so the honest count of lost frames) and `offbeat` (not
a whole number of beats at all, which is the one shape that says the beat itself
moved - 90Hz is 1.33 beats of 120). `jankPct` is kept in `report()` for
continuity with the readings above and should not be trusted on a phone.

### Decisions

- **Step 4 (the lattice moved by transform) is not indicated. Not built.**
  `#perf3` warm loses 0.2% of frames against the shipped build's 0.5%. There is
  no cost there to remove. It remains a reasonable idea for a *Desktop* board
  under a sustained zoom, where the tier fade and the changing zoom keep the
  layer genuinely dirty — but that is a different measurement on a different
  layout, and it is not this work.
- **Step 5 is closed.** Six mounted nodes on a 101-item board and 6MB of decoded
  image: the cull is doing its job and there is nothing for a tighter cull
  margin to save, so the vertical-margin idea joins the axis-aware one as
  withdrawn. A shadow-twin drop has six twins to remove, which is not a lever.
- **The work is done.** The flags stay in the tree as the regression check —
  `#perf1` reproducing 37.6% lost frames on a 120Hz display is the sharpest
  possible test that M-1 has not come back.
- **`worst` is the one number nobody has explained**, and it is deliberately
  left. See the note under the warm table.

---

## Status (closed 2026-07-31)

Steps 1–3 of `research/old/2026-07-30-mobile-scroll-impl.md` are on `main`, 600 unit
tests pass, and the measurement is in and confirmed — see Results above. Steps 4
and 5 were **not built**, and the numbers are why: the board holds 120Hz and
loses 0.5% of its frames, and neither remaining switch improves on that. What
the fix is worth is `#perf1`, which loses 37.6%.

Shipped:

- **M-1 and M-2 fixed together** — `canvas/mobile-frame.js` is new and owns the
  Mobile sheet and masthead. Nothing writes a custom property to `#viewport` on
  a view frame any more (`_paint`'s five-property block is gone). The sheet is
  clipped to the window and cached, so a scroll through the middle of a board
  writes *nothing*; the masthead moves by transform on a promoted layer. The
  `100vmax` spread shadow is gone, replaced by `#mobile-surround`, a static
  full-window wash under an opaque sheet — the same picture, never repainted.
- **M-5 fixed** — `paintButton()` in `ui/mobile-header.js` now diffs before it
  writes, like every other view listener in the app.
- **Step 1 instrumentation** — `mobilePerfFlags` in `canvas/viewport.js`, driven
  from `mbrd.perf.mobile({ … })`. `report()` also prints `boardMode` and
  `items`, because two runs are only comparable if they were the same board.
- **Tests** — `sheetBox()` and `mastShift()` are pure and exported, and
  `tests/viewport-mode.test.js` asserts the three scroll positions and both
  masthead stops directly. A new test asserts that `Viewport._paint()` writes no
  inherited custom property to `#viewport` at all, so M-1 cannot come back
  quietly.

**Not done, and deliberately so:** M-3 (the lattice's `backgroundPosition`
re-raster) and the conditional step-5 levers. The measurement says neither is
worth building — see Decisions above.

### How the measurement is taken (kept for the next time)

On the phone, at `…/#perf`, on the board that scrolls badly:

| Run | Address | Measures |
|-----|---------|----------|
| 0 | `#perf` | what shipped |
| 1 | `#perf1` | what M-1's removal bought |
| 2 | `#perf2` | what the chrome still costs |
| 3 | `#perf3` | whether M-3 is worth fixing |

Editing the digit is enough — the hash is re-read on `hashchange`, so the run
changes without a reload and the board, the mounted set and every decoded image
stay exactly as they were. Two readings taken that way differ by the switch and
by nothing else.

Each run: three slow full-screen drags, three flings, let the momentum settle,
then tap `copy` on the readout — one line, and four of them stack into the table
above. There is no console on the device, which is the whole reason the switches
are in the URL and the reading is on the glass.

**Take `#perf` twice, first and last.** A cold first run is not a baseline: the
first gesture over a board builds cards and decodes images that every later run
inherits, so a switch measured second looks better than the build measured
first, whatever the switch does. The two runs of the same build at either end of
the session are what make the warm-up visible, and on 2026-07-30 they were the
difference between shipping a grid rewrite and not needing one.

### What could not be checked without the device

The Mobile chrome was verified in headless Edge at the top stop — masthead on
the board's edge, top corners rounded, surround at the sides, no shadow, and
`#viewport` carrying no inline style at all. Scrolled states could **not** be
driven there: `requestAnimationFrame` does not run in a headless iframe after
boot, so no scripted pan repaints. That is why `sheetBox()`/`mastShift()` were
made pure and tested directly instead. The scroll extremes still want a look on
real glass — see the verification list in the implementation plan.

---

A populated board scrolls badly in **Mobile** layout. This document is the code
research behind that symptom and a prioritised plan.

It is deliberately **separate from** `research/2026-07-30-perf-plan.md`. That
document is about Desktop pan/zoom and about the iOS memory ceiling on
zoom-out. Neither analysis applies here, and conflating them wastes work:

- **Mobile has no zoom.** `Viewport.zoom` is pinned to `_mobileZoom()`
  (`viewport.js:300-311`, `:486`, `:568`) and there is no zoom control. So the
  whole `--iz` story — which `viewport.js:63-82` calls "the single largest
  reason zooming a full board feels heavy" — **does not fire during a mobile
  scroll**: `_setIz()` early-returns on an unchanged value (`viewport.js:661`).
- **Mobile pan is vertical only.** `viewport.js:435` forces `vx = 0`.
- **The visible rect never grows.** The zoom-out cull blow-up (Part B1 of the
  other plan, `items.js:296-320`) needs a growing `visibleRect`. A pure vertical
  translate escapes `syncedRect` once every ~`cullMargin()` world units of
  travel, not every frame.

So the levers that matter on Desktop are mostly already inert here, and the
board still scrolls badly. The reason is that **Mobile runs three per-frame code
paths that Desktop does not**, and all three are the expensive kind (style
invalidation, layout, full-screen raster) rather than the cheap kind (a
composited transform).

---

## What actually happens on one mobile scroll frame

A pointermove → `panBy` → `apply()` → `this._flush` (rAF-throttled,
`viewport.js:282`) → `_paint()` → `bus.emit('change')`. Eight listeners are
subscribed to that event (`items.js:173`, `paper.js:78`, `stills.js:64`,
`web.js:193`, `main.js:434`, `idle.js:35`, `mobile-header.js:134`,
`scalebar.js:47`).

Most of them are already well guarded and were audited in the 2026-07-29 and
2026-07-30 work: `scalebar.js:76-81` keys on a rung, `web.js:435` returns while
the screen stays inside the painted rect and `webVisible()` is false on Mobile
anyway (`web.js:274-292` releases the geometry outright), `stills.js:57-59`
keys on `childElementCount`, `paintZoom()` keys on a string (`main.js:564-566`),
`paper.js` early-returns because Paper is Desktop-only.

What is left, per frame, is the Mobile-only work.

### M-1. Five inherited custom properties written on `#viewport` every frame

`viewport.js:727-738`:

```js
if (this.isMobile) {
  const { left, width, top, bottom } = this.mobileScreenRect();
  this.el.style.setProperty('--mobile-board-left', …);
  this.el.style.setProperty('--mobile-board-width', …);
  this.el.style.setProperty('--mobile-board-top', …);     // changes every frame
  this.el.style.setProperty('--mobile-board-bottom', …);  // changes every frame
  this.el.style.setProperty('--mobile-header-height', …);
}
```

`this.el` is `#viewport` (`viewport.js:255`), and `#world` — every mounted card
and every child of every card — is inside it (`index.html:63`, `:112`). Custom
properties are **inherited**, so changing one on an ancestor invalidates the
computed style of the entire subtree. `#viewport` carries `contain: layout
paint` (`app.css:85`) which does nothing for this: style containment is not in
that list, and would not help if it were.

This is exactly the mechanism `viewport.js:63-82` documents as the worst cost on
the board, applied here on **every frame of every mobile scroll**, on a device
with the least CPU. Two of the five values genuinely change each frame
(`--mobile-board-top`, `--mobile-board-bottom`), which is enough — the other
three write the same string and are presumably diffed away by the CSSOM.

The consumers are two elements and nothing else: `#mobile-board-frame`
(`app.css:263-266`) and `#mobile-board-header` (`app.css:287-290`, plus
`#mobile-board-title` at `:333` and `:350`). The whole card tree is paying a
style recalculation for properties only two sibling elements read.

### M-2. The board frame is laid out and repainted every frame — with a 100vmax shadow

`#mobile-board-frame` is positioned by `top` / `left` / `width` / `height`
(`app.css:263-266`). `top` and `height` are derived from the two per-frame
values above, so the element **relayouts every frame**. It also carries:

```css
box-shadow: 0 0 0 100vmax color-mix(in srgb, var(--ink) 6%, transparent);
```

(`app.css:272`) — the surround tint, drawn as a shadow spread far past the
screen in every direction. Moving the element invalidates that paint, and the
invalidated area is the whole viewport (bounded only by `contain: paint` on
`#viewport`). `#mobile-board-frame` sits *before* `#world` in document order
(`index.html:67` vs `:112`) and is not promoted, so it shares the main
background layer with `#grid-ink` and the axes.

Net: **a full-screen main-thread raster on every scroll frame**, at whatever the
phone's device pixel ratio is. This is the most likely single cause of "scrolls
really bad" and is the cheapest thing on this list to fix.

`#mobile-board-header` (`app.css:284-302`) has the same shape of problem —
`top: calc(var(--mobile-board-top) - var(--mobile-header-height))` is a layout
per frame — though it is one small element with a clamped title rather than a
screen-wide shadow, so it is second order.

### M-3. The grid layer's background is re-rasterised every frame

`paintGrid()` writes `canvas.style.backgroundPosition` unconditionally
(`grid.js:301`). The image and size strings are cached and skipped
(`grid.js:298-300`) — that work was already done — but a background-position
change still repaints the element's whole background.

On Mobile the ink layer is not the viewport: `inkBox()` (`grid.js:133-158`)
sizes it to the board strip clipped to the screen. Mid-scroll on a long board
that intersection is `board width × full viewport height`, constant, so
`placeInk()` (`grid.js:164-179`) correctly writes nothing. But the *background*
underneath still shifts, and the tiers are 2–8 layered radial gradients
(`grid.js:264-272`). On a 390 px-wide board at DPR 3 that is roughly 1170×2550
device pixels of tiled gradient rasterised per frame.

This cost exists on Desktop too. It is worse here because of the pixel ratio and
because it lands on the same main thread as M-1 and M-2.

Note one Mobile-specific aggravation: `boardGridStep()` refuses to coarsen the
step on Mobile (`grid.js:104-109`, for a good reason — the strip's width *is*
its column count), so the lattice stays fine and the tile stays small.

### M-4. `placeInk()` does fire at the ends of the board

When the board's top or bottom edge is on screen — which includes the whole
first screenful, where the masthead is — `inkBox()` returns a changing `y`/`h`,
so `placeInk()` writes five styles and changes the element's box every frame
(`grid.js:164-179`). Only relevant near the ends, but the top of the board is
exactly where a scroll starts.

### M-5. `paintButton()` writes two attributes per frame

`mobile-header.js:597-601` sets `button.hidden` and `aria-hidden` on every view
change with no diff. Cheap, and probably diffed away by the engine, but it is
unguarded where every neighbouring listener in this codebase is guarded.

### M-6. More cards on screen than Desktop at the same zoom

Mobile's layout profile is `snap: true`, `spacing: 0`, `mobileColumns: 8`
(`state.js:231-233`), so items pack edge to edge into a dense mosaic. At the
fitted zoom (≤ 1:1, `viewport.js:83-88`) a phone screen can hold a lot of cards,
and none of them are `zoom-far`, so every one carries full chrome, a shadow twin
(`app.css:113-147`, dropped only by `#world.zoom-far .item-shadow` at
`app.css:2130`) and a live media element.

This is a *multiplier* on M-1 rather than an independent cause — a style
invalidation costs what it costs times the number of elements in the subtree —
and it is the reason the problem is described as showing up on a *populated*
board.

---

## Plan

Ordered by (confidence × size) ÷ risk. The first two are small, local and
almost certainly the bulk of it.

### Step 0 — Make the phone answer the question (do first, half a day)

The `#perf` HUD already exists and already reports mounted nodes, cull cost and
decoded MB (`main.js:380-410`, `items.js:415-440`). What it cannot show is which
of M-1/M-2/M-3 owns the frame, because all three are browser-side work that
happens *after* the listener returns — JS timing will report them as free.

So instead of trying to time them, **switch them off one at a time and read the
fps**. Add dev toggles under `mbrd.perf`, defaulting to on:

- `mbrd.perf.mobileVars(false)` — skip the `viewport.js:727-738` block.
- `mbrd.perf.mobileFrame(false)` — `#mobile-board-frame, #mobile-board-header
  { display: none }`.
- `mbrd.perf.gridPos(false)` — skip the `grid.js:301` write.

Then on the phone, on the board that scrolls badly: baseline, then each toggle
alone, then all three. That is a five-minute measurement that turns this
document from analysis into fact, and it also tells us whether to bother with
M-3 at all.

Keep the toggles; they are the regression check for the fixes below.

### Step 1 — Stop moving the mobile chrome by layout (M-1 + M-2 + M-4-adjacent)

One change fixes both of the top two causes, because they have the same root:
the frame's position is expressed as inherited CSS variables consumed by
layout-affecting properties.

Replace it with a **single promoted wrapper moved by transform**:

- Add `<div id="mobile-chrome">` inside `#viewport`, wrapping
  `#mobile-board-frame` and `#mobile-board-header` (`index.html:67`).
- The wrapper gets the board's `left` / `width` / `height` — all three change
  only on resize, on a zoom re-fit, or when `syncMobileBoardBounds()` runs
  (`main.js:908-910`, on `items`/`geom`), never on a scroll frame.
- Per frame, `_paint()` writes **one** property: `transform:
  translateY(<topPx>px)` on the wrapper. With `will-change: transform` that is
  a compositor move: no layout, no raster, and — critically — **no inherited
  custom property on an ancestor of `#world`.**
- `#mobile-board-frame` becomes `inset: 0` inside the wrapper.
  `#mobile-board-header` becomes `bottom: 100%; left: 0; right: 0; height:
  var(--mobile-header-height)`, which is the same "hung off the top edge"
  relationship expressed without arithmetic on a moving number.
- `--mobile-header-height` and `--mobile-title-*` move onto the wrapper (or
  onto `#mobile-board-header` itself). They must **not** stay on `#viewport`:
  keeping any of them there keeps the subtree invalidation, which is the whole
  point of the change. `app.css:345` documents them as "published on #viewport"
  — that comment moves with them.

Then reconsider the surround shadow (`app.css:272`). Inside a promoted wrapper
the 100vmax spread is rasterised once and moved, which is already an enormous
improvement, but it also makes the wrapper's layer very large. If the layer size
is a problem on the phone, replace the shadow with a **static** full-screen tint
element sitting below the frame — the tint never moves, so it never needs to be
in the moving layer at all. Prefer the static element if it is not visually
awkward; it is strictly less work for the compositor.

Nothing outside these two elements reads the five properties (verified by
grep: `app.css:263-266`, `:287-290`, `:333`, `:350` and nothing else), and the
grid gets its rectangle from `vp.mobileScreenRect()` in JS (`grid.js:139`), not
from CSS. So this is a contained change.

Expected effect: removes the per-frame full-screen raster **and** the per-frame
style recalculation of every mounted card. If the analysis is right this is most
of the fix.

### Step 2 — Guard `paintButton()` (M-5)

Cache the last value and return early, matching `scalebar.js:76-81` and
`paintZoom()` (`main.js:564-566`). Five lines, no risk, and it stops a listener
being the odd one out.

### Step 3 — Move the grid by transform instead of background-position (M-3)

Only if Step 0 says the grid is still hot after Step 1.

The lattice is periodic. Instead of writing `backgroundPosition` every frame,
make `#grid-ink` **one major tile larger than its box in each direction**, put
it inside a clipping wrapper sized to `inkBox()`, and write
`transform: translate(-(ox mod major)px, -(oy mod major)px)` per frame. The
background then never changes and the layer is composited; a repaint is needed
only when the zoom, the tier fade, the palette or the weight slider moves — none
of which happen during a Mobile scroll, where the zoom is fixed.

This helps Desktop pan identically and is the durable version of B3 in the
earlier plan ("skip grid repaint on negligible view deltas"), which only removed
the sub-pixel case.

Two things to get right:
- The Harsh tier draws crosses into the canvas (`grid.js:672-694`). Same trick
  applies — draw one tile-aligned oversized bitmap, translate it — but it is a
  separate code path and can be deferred; Harsh is not the default.
- `punchHole()` (`grid.js:337-372`) masks in the layer's own coordinates. It is
  already suppressed while `vp.moving`, so during a scroll there is nothing to
  reconcile; on settle, the mask offset has to account for the translate.

### Step 4 — Fewer live cards under the finger (M-6)

Only if Steps 1–3 leave it short, and measure `mountedNodes` on the HUD first.

Mobile packs at `spacing: 0` across 8 columns, so a screenful is many small
cards each with a shadow twin and full chrome. Two cheap levers, in order:

- Drop shadow twins on Mobile **while moving**, not only at `zoom-far`:
  `#world.is-viewing .item-shadow { display: none }` scoped to
  `:root[data-board-mode="mobile"]`. The twins exist to give depth to a spatial
  board; a moving feed does not need them, and each is a multi-layer composited
  element. This is the Mobile analogue of B2 in the earlier plan, which could
  not fire here because Mobile never reaches `zoom-far`.
- Reduce `CULL_MARGIN_PX` (`items.js:341`) on Mobile. 300 px of margin above
  *and* below a vertical-only scroll is 600 px of extra mounted board on an
  axis where the whole screen is ~800 px. A vertical-only pan does not need a
  horizontal margin at all; making the margin axis-aware is a small change in
  `cullMargin()` / `visibleRect()`.

Both are behaviour changes visible to the eye, which is why they are last.

### Step 5 — Re-baseline, and only then look further

If the phone is still short of 60 after Steps 1–4, the next candidates, in the
order the profiler is likely to indict them, are: the per-frame cull
(`cullFullSyncPct` on the HUD says whether it is even running), media element
count on a video-heavy feed (`liveVideos`), and the glide's rAF loop
(`viewport.js:453`) which drives the same listener chain during momentum.

---

## Sequencing

1. **Step 0** — dev toggles, then measure on the phone. Nothing below is worth
   doing before this reports which lever moves the number.
2. **Step 1** — the mobile chrome wrapper. The main event.
3. **Step 2** — `paintButton()` guard (trivial, fold in with Step 1).
4. Re-baseline.
5. **Step 3** — grid transform, if still indicated.
6. **Step 4** — shadow twins / cull margin, if still indicated.

Re-baseline after each step. Every "this should help" above is a hypothesis
until the HUD says so on the actual device.

## Risks and verification

- Step 1 touches `index.html`, `app.css` and `viewport.js._paint`. It is a
  canvas change, so per `CLAUDE.md` tests are not enough: exercise the Mobile
  board at both scroll stops (the masthead at the top, the last row at the
  bottom), the rounded corners of the strip, a window resize in Mobile mode, a
  Desktop↔Mobile switch in both directions, and the grid's edge clearance
  against the board edge.
- `atMobileTop()` (`viewport.js:322-325`) drives the masthead button's
  visibility and is pure arithmetic — unaffected — but it is worth confirming
  the button still appears exactly at the top stop after Step 2's guard.
- No `.mbrd` schema change, no generated-catalog change. Step 1 adds a DOM node
  but no new shipped asset, so `tests/sw.test.js` is unaffected; confirm that
  when the change lands.
- Step 3 changes `#grid-ink`'s geometry contract. `tests/` has grid render
  harnesses that mount a bare `#viewport` (`grid.js:790-800` mentions them) —
  they will need the wrapper or a fallback.
- Keep the Step 0 toggles in the tree. They are how the next person confirms
  none of this regressed.
