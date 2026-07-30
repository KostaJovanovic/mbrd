# Mobile scroll performance — implementation plan (2026-07-30)

> **Status: steps 1 and 2 are done** (600 tests pass; the Mobile chrome was
> checked in headless Edge at the top stop). Step 3 — the measurement on the
> phone — is the gate on everything after it and has not been run. See the
> Status block in `research/2026-07-30-mobile-scroll-perf.md` for what shipped
> and for the four runs to make.
>
> Two deviations from the plan below, both recorded here rather than quietly:
>
> - **The step 1 flags were built to outlive step 2.** The plan's `chromeVars`
>   would have measured nothing once step 2 removed the writes, so the flag is
>   `legacyVars` and it *restores the cost* rather than switching it off:
>   nothing reads the five properties any more, so writing them changes no
>   picture and re-creates only the invalidation. That makes the A/B runnable
>   after the fix instead of only before it, which is what a regression check
>   has to be.
> - **The sheet is not moved by transform.** It spans the whole board, which on
>   a long feed is tens of thousands of pixels, and promoting a layer that tall
>   is not obviously better than what it replaces. Clipping it to the window and
>   caching is strictly better and needs no promotion: through the middle of a
>   board the clipped rectangle is *the same rectangle every frame*, so the
>   painter writes nothing at all. The masthead is small and bounded and does
>   move by transform, as planned. This also kept the paint order intact - the
>   sheet sits below `#grid-ink` and the masthead above it, so the single
>   wrapper the plan describes would have collapsed the two into one depth.

Carries out `research/2026-07-30-mobile-scroll-perf.md`. That document is the
research: what the frame spends its time on and why. This one is the work: the
exact files, the exact edits, what each step is verified against, and where the
commits fall.

Read the research first. The short version is that a Mobile scroll frame does
three things a Desktop pan frame does not, all of them the expensive kind:

| # | Cost | Where | Step |
|---|------|-------|------|
| M-1 | Five **inherited** custom properties written on `#viewport`, invalidating the computed style of every mounted card | `viewport.js:727-738` | 2 |
| M-2 | `#mobile-board-frame` relayout + a `100vmax` spread shadow repainted full-screen | `app.css:263-266`, `:272` | 2 |
| M-3 | `#grid-ink` background re-rasterised (`backgroundPosition` written unconditionally) | `grid.js:301` | 4 |

Steps 1 and 3 are measurement. Steps 5 and 6 are conditional and only happen if
step 3 says they are still needed.

---

## Ground rules for this work

- **Measure between every step.** The `#perf` HUD exists for exactly this
  (`main.js:280-410`). Every claim below is a hypothesis until the phone agrees.
- **One commit per step**, so a regression bisects to a single idea.
- Per `CLAUDE.md`: these are canvas changes. `npm test` is necessary and not
  sufficient — the app gets launched and scrolled on the phone each time.
- No `.mbrd` schema change anywhere in this plan. No generated-catalog change.
  Step 2 adds a module and a DOM node, so `web/sw.js` `SHELL` changes and
  `tests/sw.test.js` covers it.
- Do not hand-edit `web/sw.js`'s `VERSION` or `web/assets/js/version.js`;
  `save.bat` bumps both by regex.
- The working tree currently carries unrelated uncommitted changes (pigments /
  appearance / mbrd-format). **Land or stash those first** — this work touches
  `main.js` and `app.css`, and mixing the two diffs makes both unreviewable.

---

## Step 1 — Dev toggles, then a baseline on the phone

**Why first.** M-1, M-2 and M-3 are all *browser* work that happens after the
listener returns. A `performance.now()` pair around the JS reports them as
free, which is why they have gone unnoticed through two rounds of profiling.
The only honest measurement is to switch each one off and read the frame rate.

### 1a. Add the flags

New export in `web/assets/js/canvas/viewport.js`, near the other dev
instrumentation:

```js
/**
 * Dev-only kill switches for the three per-frame Mobile costs, read by
 * mbrd.perf and defaulting to on.
 *
 * These are not features. They exist because M-1..M-3 are browser-side work -
 * style invalidation, layout, raster - which no JS timer can see: the listener
 * returns long before the frame is paid for. Switching one off and reading the
 * HUD is the only way to learn which of them owns the frame. They stay in the
 * tree afterwards as the regression check.
 */
export const mobilePerfFlags = { chromeVars: true, chromeFrame: true, gridPos: true };
```

`grid.js` already imports from `viewport.js` (`grid.js:19`), so it can read the
same object with no new edge in the layering graph.

Wire them:

- `viewport.js:727` — `if (this.isMobile && mobilePerfFlags.chromeVars) { … }`
- `grid.js:301` — `if (mobilePerfFlags.gridPos) canvas.style.backgroundPosition = …`
- `app.css` — a `:root.perf-no-mobile-chrome #mobile-board-frame,
  :root.perf-no-mobile-chrome #mobile-board-header { display: none; }` rule,
  toggled by the flag setter.

Expose on the existing `viewPerf` object in `main.js` (near `report()`):

```js
mobile(patch) {
  Object.assign(mobilePerfFlags, patch);
  document.documentElement.classList.toggle(
    'perf-no-mobile-chrome', !mobilePerfFlags.chromeFrame);
  vp.apply();
  return { ...mobilePerfFlags };
},
```

so the phone console — or a bookmarklet, since a phone has no console — can do
`mbrd.perf.mobile({ chromeVars: false })`.

### 1b. Fix the one thing the HUD cannot currently tell us

Add a `boardMode` and `layoutItems` line to `report()`'s table
(`main.js:385-410`). Comparing two runs is worthless if one was on a 40-item
board and one on 400.

### 1c. The measurement protocol

On the phone, on the board that scrolls badly, at `…/#perf`. Each run is the
same gesture: three slow full-screen drags, then three flings, then let the
momentum settle. `mbrd.perf.report()` after each.

| Run | Flags |
|-----|-------|
| 0 | baseline, all on |
| 1 | `chromeVars: false` |
| 2 | `chromeFrame: false` |
| 3 | `gridPos: false` |
| 4 | all three off |

Record `fpsMedian`, `fpsP95Low`, `jankPct`, `mountedNodes`, `cullAvgMs`,
`cullFullSyncPct`. Run 4 is the ceiling: if run 4 is still bad, the analysis in
the research document is wrong and steps 2–4 should not be built. **That is the
point of doing this first.**

Write the five rows into the research document under a "Baseline" heading before
touching anything else.

**Commit:** `Perf: dev kill switches for the Mobile per-frame chrome`

---

## Step 2 — Take the Mobile chrome off the per-frame layout path

The main event. Fixes M-1 and M-2 together, because they are the same root: the
sheet's position is expressed as inherited custom properties consumed by
layout-affecting properties.

### 2a. What replaces what

Three separate ideas, and they are worth keeping distinct:

**(i) The surround tint becomes a static element.**

`app.css:272` draws the off-board tint as `box-shadow: 0 0 0 100vmax` on the
sheet. A shadow moves with its element, so the tint is repainted every time the
sheet moves. Replace it with a full-screen element that never moves:

```html
<!-- The tint outside the Mobile strip. A plain full-screen wash under the
     sheet rather than a 100vmax shadow on it: the sheet is opaque, so a wash
     laid under it and covered by it is the same picture, and this one does not
     have to be repainted every time the board scrolls. -->
<div id="mobile-surround" aria-hidden="true"></div>
```

placed immediately **before** `#mobile-board-frame` in `index.html:67`, so it is
under the sheet, under `#grid-ink`, and under everything else — the same depth
the shadow had.

```css
#mobile-surround {
  display: none;
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  pointer-events: none;
}
:root[data-board-mode="mobile"] #mobile-surround { display: block; }
```

Equivalence to check by eye (it is exact in principle, and cheap to confirm):
the shadow is clipped to outside the sheet's *border box, radius included*, so
the corners must still show tint through the rounded notch — a wash under an
opaque rounded sheet gives that for free. The one assumption is that the sheet's
`color-mix(… var(--accent) 6%, #fff)` is fully opaque at every palette. It is,
because the second colour is `#fff`; confirm on the two extreme whimsy stops
anyway (`app.css:274-275`).

**(ii) The sheet is clipped to the screen and cached, so a scroll writes nothing.**

The sheet spans the whole board, which on a long feed is tens of thousands of
pixels tall. Mid-scroll both of its ends are off screen, so what is actually
visible is a band of constant width at a constant x running the full height of
the viewport — *it does not change at all while you scroll through the middle of
a board.*

So compute its **clipped** screen rect and write only when that changes. This is
not a new idea in this codebase: `inkBox()` / `placeInk()` in `grid.js:133-179`
already do precisely this for the lattice, including suppressing the radius on
an edge that has scrolled off screen. Reuse the shape, and the `topRadius` /
`bottomRadius` trick with it.

Mid-scroll: zero style writes, zero layout, zero repaint. At the two ends: it
changes per frame, but there the element is small and the alternative is a
visibly wrong edge.

**(iii) The masthead moves by transform.**

The masthead genuinely does move while it is on screen, so caching does not save
it. It is small and bounded (`mobileHeaderHeight()` is `boardWidth / 1.5`,
`viewport.js:71-73`), so it is safe to promote:

```css
#mobile-board-header {
  top: 0;                  /* the travel is the transform below */
  will-change: transform;
}
```

and one `transform: translateY(<px>px)` write per frame. When it has scrolled
entirely off the top, stop writing and set `visibility: hidden` once.

Its `left`, `width`, `height`, and the two custom properties its title reads
(`--mobile-board-width` at `app.css:333`, `--mobile-header-height` at
`app.css:350`) go **onto the masthead element itself**, not onto `#viewport`.
`#mobile-board-title` is its child, so inheritance still reaches it, and
`#viewport` is no longer an ancestor of `#world` that gets written to.

Checked: `--mobile-title-scale` / `-stretch` / `-offset` / `-fit` are already
written on the title element (`mobile-header.js:486-490`, `:586-594`), and the
Desktop title card's copy of those rules uses `100cqh` and `--mobile-title-ratio`
rather than `--mobile-header-height` (`app.css:526-537`), so nothing outside the
masthead subtree depends on the moved properties. `grid.js:139` gets the
rectangle from `vp.mobileScreenRect()` in JS, not from CSS.

### 2b. Where the code lives

A new module, `web/assets/js/canvas/mobile-frame.js`, following
`canvas/paper.js` exactly — that file is the existing precedent for
screen-space chrome painted off `vp.onChange` with a cached key
(`paper.js:70-80`, and the comment there about subscribing directly rather than
through a throttle of its own applies here for the same reason).

```js
// The Mobile strip's sheet and masthead, in screen space.
//
// These used to be positioned from five custom properties written on #viewport
// on every frame of every scroll (viewport.js, before this module existed).
// #viewport is an ancestor of #world, custom properties are inherited, and
// changing an inherited property on an ancestor invalidates the computed style
// of the whole subtree - which here is every mounted card and everything
// inside it. It was the same cost --iz is documented as carrying in
// viewport.js, paid on a layout that has no zoom at all.
//
// So nothing here writes to #viewport. The sheet is positioned from its own
// clipped rectangle and cached, exactly the way canvas/grid.js does its
// lattice layer, so scrolling through the middle of a board writes nothing at
// all; the masthead, which really does move while it is on screen, moves by
// transform on a promoted layer. What is left on a scroll frame is one
// transform write while the masthead is visible and nothing once it is gone.

import { mobileHeaderHeight } from './viewport.js';

export function initMobileFrame(vp) { … }
export const paintMobileFrame = () => draw();
```

- `initMobileFrame(vp)` subscribes `vp.onChange(draw)` and returns early if the
  elements are absent (the test harnesses mount a bare `#viewport`, the same
  reason `paper.js:66` and `grid.js:795-800` are written defensively).
- `draw()` returns immediately when `!vp.isMobile`, having hidden both elements
  once.
- Two cached keys: one for the sheet's clipped box, one for the masthead's
  non-moving geometry. Transform is the only unconditional write.

**Layering:** `canvas/ → canvas/` only. No new edge, `tests/layers.test.js`
unaffected. **No browser globals at module scope** — everything touching the DOM
is inside `initMobileFrame`/`draw`, so `tests/imports.test.js` stays at its
three exceptions.

### 2c. The edits, file by file

| File | Edit |
|------|------|
| `web/index.html` | Add `#mobile-surround` before `#mobile-board-frame` (`:67`). Extend the surrounding comment to say why the sheet no longer casts its own surround. |
| `web/assets/css/app.css` | Add `#mobile-surround`. Drop `box-shadow` at `:272`. `#mobile-board-frame`: drop the four `var(--mobile-board-*)` positions (`:263-266`), keep `border-radius`/background, position from inline styles. `#mobile-board-header`: `top: 0`, `will-change: transform`, drop the `calc()` at `:290`, keep `left`/`width`/`height` as inline. Update the comment at `:345` that says the property is "published on #viewport". |
| `web/assets/js/canvas/viewport.js` | Delete the `if (this.isMobile) { … }` block at `:727-738` and its comment. Keep `mobileScreenRect()` — it is public precisely because the grid needs it (`:706`), and now the frame does too. |
| `web/assets/js/canvas/mobile-frame.js` | New. |
| `web/assets/js/main.js` | `import { initMobileFrame, paintMobileFrame }`; call `initMobileFrame(vp)` beside `initPaper(vp)` (`:270`); add `paintMobileFrame()` to the three boot/paint sites that already call `paintPaper()`/`paintGrid(vp)` (`:598`, `:930`, `:1499`). |
| `web/sw.js` | `'./assets/js/canvas/mobile-frame.js'` into `SHELL`, beside `canvas/paper.js` (`:55`). |

### 2d. Also fold in: guard `paintButton()`

`mobile-header.js:597-601` writes `hidden` and `aria-hidden` on every view
change with no diff, alone among the view listeners in this codebase. Cache the
last value and return early — the same shape as `scalebar.js:76-81` and
`paintZoom()` (`main.js:564-566`). Five lines, and it stops the file being the
odd one out.

### 2e. Verification

`npm test` (`tests/sw.test.js` and `tests/layers.test.js` are the two that will
have an opinion), `node --check` on the three touched `.js`, then on the device:

- Scroll to the **top stop**: masthead sits on the board's top edge, board's top
  corners are rounded, the lattice still stops at the edge with its clearance
  (`MOBILE_GRID_EDGE_CLEARANCE`), the masthead button appears exactly at the
  stop (`atMobileTop()`, `viewport.js:322-325` — unchanged, but 2d touches what
  reads it).
- Scroll to the **bottom stop**: bottom corners rounded, tint below the board.
- **Mid-scroll**: square edges top and bottom, no seam where the clip is, tint
  down both sides.
- **Resize** in Mobile mode (rotate the phone; drag the window in Mobile mode on
  desktop) — the sheet and masthead re-measure.
- **Desktop ↔ Mobile switch**, both directions, twice, including with the board
  scrolled away from the top before switching.
- Rename the board from the masthead; open the masthead style panel and move
  Font size / Stretch / Vertical position — those write
  `--mobile-title-*` onto the title and must still take effect now that
  `--mobile-board-width` and `--mobile-header-height` arrive from the masthead
  rather than from `#viewport`.
- Both extreme whimsy stops, to confirm the sheet is opaque over the new wash.
- Save, export, reload, and refresh-recovery — untouched by this, but it is a
  canvas change and the guide says to look.

Then re-run the step 1 protocol. **Expected:** run 0 lands on or near where runs
1 and 2 landed together.

**Commit:** `Perf: take the Mobile sheet and masthead off the per-frame layout`

---

## Step 3 — Re-baseline

Not a formality. Steps 4–6 are each real work with real visual risk, and step 2
may well have finished the job. Run the step 1 protocol again, write the numbers
into the research document under "After step 2", and **decide in writing**
whether `gridPos: false` still buys anything worth having.

If it does not: stop. Keep the flags, close the work.

---

## Step 4 — Move the lattice by transform instead of by background-position

Only if step 3 indicts it.

### The idea

The lattice is periodic with period `major` (`grid.js:210-211`). Instead of
writing `backgroundPosition` every frame — which repaints the whole layer's
background — make the tiled layer **one major tile larger than its box in each
direction**, put it inside a clip wrapper sized to `inkBox()`, and write

```js
inner.style.transform =
  `translate(${-mod(ox, major)}px, ${-mod(oy, major)}px)`;
```

The background then never changes, and the layer is composited. A repaint is
needed only when the zoom, the tier fade, the palette or the dot-weight slider
moves — **none of which happen during a Mobile scroll, where the zoom is fixed**
(`viewport.js:300-311`).

This helps Desktop pan identically, and it is the durable form of B3 in
`research/2026-07-30-perf-plan.md` ("skip grid repaint on negligible view
deltas"), which only removed the sub-pixel case.

### What it touches

- `#grid-ink` gains a wrapper. `ensureCanvas()` (`grid.js:795-809`) builds the
  element when it is missing, and `index.html:72` ships it — both need the new
  shape, and `ensureCanvas()`'s cache-reset (`grid.js:805`) has to reset the new
  key too.
- `placeInk()` (`grid.js:164-179`) moves onto the wrapper; the oversize goes on
  the inner layer.
- `punchHole()` (`grid.js:337-372`) masks in the layer's own coordinates and
  now has to account for the translate. It is already suppressed while
  `vp.moving` (`grid.js:355`), so nothing has to be reconciled during a gesture
  — only on settle.
- **The Harsh tier is a separate path** and can be deferred: `drawCrosses()`
  (`grid.js:672-694`) paints into the canvas rather than tiling a background.
  The same trick applies — draw one tile-aligned oversized bitmap and translate
  it — but Harsh is not the default tier and this can be a follow-up. If it is
  deferred, say so in the commit message; a silent "gradient tiers only" is the
  kind of half-measure that reads as done.

### Verification

The grid is the thing in this app most easily made subtly wrong, and it has no
unit test. Check at both DPRs available, on all three whimsy tiers:

- Marks stay hairline-crisp at rest (the whole reason the grid is painted in
  screen space).
- The origin hole lands on the origin mark after a gesture settles.
- A tier crossing still cross-dissolves on a slow zoom and still snaps on a fast
  one (`grid.js:560-570`).
- The lattice still stops exactly at the Mobile board's edge with its clearance.
- No seam or drift at the wrap: pan a long way in one direction and back.

**Commit:** `Perf: move the lattice by transform instead of background-position`

---

## Step 5 — Fewer live cards under the finger

Conditional on step 3's numbers, and specifically on `mountedNodes`. Both of
these are visible behaviour changes, which is why they are last.

**5a. Drop the shadow twins while a Mobile board is moving.**

```css
:root[data-board-mode="mobile"] #world.is-viewing .item-shadow { display: none; }
```

The Mobile analogue of B2 in the earlier plan, which cannot fire here because
Mobile never reaches `zoom-far` (`app.css:2130`; at a typical fitted zoom of
~0.7 against a `farZoom()` of 0.32 it is not close). Each twin is a multi-layer
composited element (`app.css:120-147`), and Mobile packs at `spacing: 0` across
8 columns (`state.js:231-233`), so a screenful is a lot of them. `is-viewing` is
already the established "cheap mode" class (`viewport.js:665`).

Risk: cards visibly flatten during a scroll and lift again on settle. Look at it
before keeping it — if it reads as a glitch rather than as motion, drop the idea
rather than tuning it.

**5b. ~~Make the cull margin axis-aware.~~ Checked and withdrawn.**

The idea was that a vertical-only pan (`viewport.js:435`) needs no horizontal
margin, so the horizontal half of `CULL_MARGIN_PX = 300` (`items.js:341`) was
mounting cards that can never scroll in from the side. **It is not, because
there are no such cards.** The arithmetic:

- The strip is `mobileColumns × baseStep()` = 8 × 64 = **512 world units** wide
  (`state.js:975-979`, `:757-759`).
- `mobileZoom()` fits that to the window less a 16px pad each side
  (`viewport.js:83-88`), so on screen the board is `viewWidth - 32`.
- The *unmargined* visible rectangle is `cx / zoom` either side of centre
  (`viewport.js:363-374`), which exceeds the board's own half-width by
  `16 / zoom` — about 23 world units at a typical fitted zoom of 0.7.

So the visible rectangle already spans the entire board width before any margin
is added, and every item is inside the strip. Widening it horizontally reaches
past the board into empty world. The only thing the horizontal margin costs is
a wider `spatial.queryRect()` — cells are 512 units (`spatial.js:35`), so the
strip is one cell across and the margin makes it about four — and those extra
lookups are Map misses on a path that runs on a full sync, not on a frame.

**The real lever, if `mountedNodes` says one is needed, is the vertical margin.**
At the fitted zoom it works out at `min(300 / 0.7, 400)` = 400 world units, or
roughly 280 screen px above *and* below — about six rows of a dense 8-column
mosaic at each end. Cutting it cuts the mounted set directly. It trades against
pop-in during a fling, which travels most of a screen, so it wants the measured
number first and a look on the device after.

**Commit:** one per lever, `Perf: …`.

---

## Step 6 — Re-baseline, close, and write it up

- Final numbers into `research/2026-07-30-mobile-scroll-perf.md` under
  "Results", in the same table shape as the baseline, so the next person can see
  which step bought what.
- Add a **Status** block at the top of that document in the style of
  `research/2026-07-30-perf-plan.md`'s, naming what shipped, what was measured,
  and what was deliberately left.
- Update `research/2026-07-30-perf-plan.md`'s open list if step 4 lands — it
  supersedes B3 there.
- Keep the step 1 flags in the tree and say so in the status block. They are how
  the next regression gets diagnosed in five minutes instead of a day.
- `save.bat` for the version bump.

---

## Risk register

| Risk | Where | Mitigation |
|------|-------|------------|
| The clipped sheet shows a seam or a wrong corner radius at a stop | Step 2 (ii) | Mirror `inkBox()`'s `topRadius`/`bottomRadius` exactly; check both stops and mid-scroll |
| The wash is visible through a non-opaque sheet at some palette | Step 2 (i) | Check both extreme whimsy stops; the sheet mixes into `#fff` so it should be opaque by construction |
| The masthead's promoted layer costs more than it saves on a low-memory phone | Step 2 (iii) | It is bounded at `boardWidth / 1.5`; if it misbehaves, fall back to the cached-clip treatment the sheet gets |
| Title typography breaks because two custom properties moved element | Step 2 (iii) | Exercise every control in the masthead style panel; `--mobile-title-*` are unaffected (written on the title itself) |
| The grid drifts, moires, or loses its origin hole | Step 4 | No unit test exists — this one is verified by eye, on all three tiers, at two pixel ratios |
| Harsh tier left on the old path | Step 4 | Acceptable as a follow-up, but state it in the commit |
| Shadow-drop reads as a glitch | Step 5a | Look at it; abandon rather than tune |
| Mobile-only regressions land unnoticed on Desktop-only testing | all | Every step's verification list is device-first; `npm test` is the floor, not the check |

## What this plan deliberately does not do

- **No step-zoom, no reduced `MIN_ZOOM`.** Mobile has no zoom; those questions
  belong to the Desktop plan.
- **No import-time downscale, no video decoder pool.** A1/A3 in
  `research/2026-07-30-perf-plan.md` are the iOS *memory* work. Mobile's mounted
  set is bounded by the strip and a screenful, and the symptom here is frame
  time, not a crash. If `decodedImgMB` on the HUD says otherwise at step 1, that
  is a finding — record it and go read the other plan.
- **No native scrolling.** Mobile pan is the same Pointer Events pipeline as
  everything else (`input.js`, `#viewport { touch-action: none }` at
  `app.css:79`) and the glide is a JS rAF loop (`viewport.js:440-455`). Handing
  the axis to the browser would take the listener chain off the main thread, and
  it would also mean two different gesture models on one canvas, a second
  scrolling container inside `#viewport`, and a rewrite of the pan clamp. It is
  a real option and it is out of scope for a performance pass — note it as
  future work if steps 2–5 leave the phone short.
