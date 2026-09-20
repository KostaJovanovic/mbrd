# The phone blink, and what a zoom costs — 20 September 2026

Measured on the maintainer's Android phone (1224x2720, dpr 3, 90Hz panel,
Android 16) over USB, against `test.mbrd`: 106 items, mostly photographs.
The harness is `research/phone-trace/cdp.mjs` — a dependency-free CDP client
that drives the WebView, runs `mbrd.perf`, and records renderer traces.

## What was wrong, and what fixed it

**The blink.** Cards, axes, grid and menus dropped out and came back while the
board moved. The phone's log said why, hundreds of times over:
`cc/tiles/tile_manager.cc: WARNING: tile memory limits exceeded, some content
may not draw`. Zoom decided it: ten zoom steps near 100% produced 0 warnings,
the same ten zoomed out produced 213.

`will-change: transform` on `#world` both promotes the layer *and pins its
raster scale*, so a board at 30% was still being rastered at 1:1 — ten
screenfuls of texture for one screen. Promotion now comes from a `translateZ(0)`
written into the transform (`canvas/viewport.ts`), which carries no such hint.
**213 warnings to 0**, and the maintainer confirmed the blink was gone. For
contrast, on a hard zoom ramp the old pinning scores 317 warnings where the new
code scores 85.

**The zoom being slow.** A traced pinch spent 28ms of each 55ms frame inside
`recalcStyle`, invalidated by the per-frame `--iz` write, which is inherited by
every node under `#world`. And `RasterImplementation::ReadbackImagePixels` cost
110ms a go — the frozen-GIF capture in `canvas/stills.ts`, shooting on the frame
that crosses the rung. `--iz` now moves on a coarser ladder while a gesture is in
flight (`IZ_STEP_MOVING`), and the capture is owed to the settling frame instead
of taken mid-gesture. Measured over a 6s zoom loop: **79 frames to ~115**, median
gap 66.7ms to 50ms, worst frame 516ms to 167ms.

Two things that sound right and are not, both measured: pinning the raster scale
*for the length of the gesture only* buys nothing (126 warnings against 137), and
hiding the shadows only while moving buys nothing either (71 against 77). The
board has to be cheaper throughout, not cheaper in bursts.

## What is still open: the shadow under every card

A pinch still exceeds the tile budget, and the blurred twin is why. All figures
are warnings over one normal-sized pinch (0.34 to 0.82 and back, 3s):

| `--item-shadow` | warnings |
| --- | --- |
| as it ships (`0 1px 1px` + `0 10px 22px -10px`) | 21 |
| `0 4px 10px -4px` | 14 |
| `0 2px 6px -1px` | 8 |
| pre-blurred 9-slice sprite, 24px outset | 8 |
| `0 1px 2px -1px` | 5 |
| `0 3px 0 -1px` (no blur at all) | 1 |
| `0 2px 3px -1px` | **0** |
| no shadow | **0** |

The shape of that table is the finding: **cost follows the area of translucent
shadow in board space, not the blur arithmetic.** A pre-blurred texture — the
obvious "cheaper to draw" answer — still scores 8, because the pixels still have
to be blended over the same wide penumbra. A tight shadow scores 0 while still
being a soft shadow. Turning shadows off below the far-zoom rung scores 17: no
good, because most of the pinch happens above it.

So the redesign, if it is wanted, is **tight rather than textured**: keep the
contact shadow, drop the 22px lift. Screenshots of both, same cards, same zoom,
are in `research/phone-trace/` (`shadow-now-crop.png`, `shadow-tight-crop.png`).
Scoping it to `(pointer: coarse) and (max-width: 640px)` would leave the desktop
look untouched; the maintainer had not decided when this was written.

## Worth knowing for the next look

- The panel runs at 90Hz and the app mostly gets 60. Untouched, and an Android-side
  question rather than a web one.
- Style recalc is ~26% of a pinch; `--grain-fade` is written on `:root`, which
  re-styles the whole document, though suppressing it alone changed nothing
  measurable.
- Frame-rate numbers taken while driving input over CDP are worthless: the USB
  round trip lands in the gap being measured. Drive the view from inside the page
  (`zoomloop` in the harness) and the runs repeat to the millisecond.
