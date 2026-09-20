# The cleaning simulator: performance audit and plan

## Status (2026-09-19)

Phases 1–4 are carried out; phase 5 is still to be measured. Not yet seen in a
browser. What landed, and where it departs from the plan below:

- **1.1** `crustRows()` / `crustPainter()` in `art.ts`; `crustPixels()` and
  `paintField()` are one-shot runs of them, so the lab and `grime-shots` are
  unchanged. `drainPaint()` spends `PAINT_MS` (6) a frame, 12 with motion off.
  New: a crust not yet painted is skipped by the jet and the mop
  (`LiveField.painted`), so paint can never land over a grid already washed.
- **1.2** `frontOf()` keeps the last front. Rust measured 31.3 → 27.4 ms.
- **1.3** corners read in one pass in `startClean()` and handed to `buildCard()`.
- **2.1** brushes drawn once (`brush()`, `dab()`, `dabEllipse()` in `art.ts`).
  The bite and the sheen keep their exact shape - a round gradient cut by the
  ellipse, done with a transformed pattern rather than a stretched image. Faint
  brushes are drawn at full alpha and laid at their real one. Runoff colour is
  quantised to sixteenths of `dirt`.
- **2.2** `shieldOf()` is a grid mask, cached per card per frame (`tickAt`),
  not invalidated at the four debris-moving sites.
- **2.3** per touch: `cleanNow()` replaces `cardClean(asState())` in
  `workCard()` and `robotMop()`; the sheen's opacity is written by `tick()`
  only. The glove-loop hoists were dropped - those loops run only for pieces in
  reach, not per cell.
- **3.1** `mistInk`: the mist canvas is cleared only when something was on it.
- **3.2** done differently: each `LiveCard` keeps its counting view
  (`state`), updated by `dissolve()`, and `liveState()` returns it. No version
  counter to keep in step, and no allocation per card per frame.
- **4.1** `unfold()` / `fold()`: wet and run canvases sit at 0 × 0 and hidden
  until used, and go back once faded.
- **4.2** `.clean-web-shade`: a second path per web under the strands; the
  sheet's filter is gone. **Needs a look** - sharper than the blurred shadow.
- **4.3** (tighter web bounds) not done: with the filter gone the size of the
  sheet costs nothing.

---

Open work. An audit of the easter egg (`web/assets/js/ui/clean/`, `clean.css`)
as it stood on 2026-09-19, after the intro, the swipe peel and the 25-card cap.
Nothing here changes how the mode looks or plays except where a phase says so;
the brief is still **zen**, and a faster frame is not a licence to add anything.

**What was measured and what was read.** Only the crust generation was timed
(Node, `crustPixels()`, figures below). Everything else is from reading the hot
paths and is an estimate of *relative* cost, not a profile. There is no browser
suite; phases 2–5 need a look in the browser, and over Remote Desktop animation
looks choppy regardless, so judge smoothness locally.

## The frame, as it runs

- **Opening.** `startClean()` builds every card's DOM, deals grids, then queues
  each crust's paint; `drainPaint()` paints one crust per frame from `tick()`.
  The intro (`intro.ts`) runs over the top, with its date reels moved by script
  every frame.
- **Every frame** (`tick()`): per card, `setLean`, `drawRuns`, the sheen decay,
  `paintBadge`, `paintHeld`; then spider, robots, `drawMist`.
- **Every touch of a tool** (`apply()` → `workCard()`): called up to `MAX_DABS`
  (160) times per pointer event, once per coalesced event, plus once per frame
  when the hand is still.

## Findings, worst first

### 1. Crust painting stalls the opening — measured

`crustPixels()` at the rich size (232 on the long side, a 4:3 card), median of
five, Node on the maintainer's machine:

| grime | rich (ms) | light (ms) |
| --- | --- | --- |
| rust | 31.3 (max 45.0) | 12.3 |
| ink | 24.4 | 9.9 |
| dirt | 20.5 | 7.2 |
| lime | 19.4 | 8.6 |
| coffee | 19.3 | 8.6 |
| tar | 16.8 | 6.7 |
| film | 13.4 | 5.7 |

Plus the `drawImage` upscale to the card canvas. `PAINT_PER_FRAME = 1`, so the
first ~25 frames of the mode are each 15–45 ms long — and those frames are
exactly the intro's date spin, which is script-driven (`roll()` writes a
transform per reel per frame). That spin is where the stutter is visible.
About 750 ms of work in total at 25 cards.

### 2. Rust evaluates its front twice per pixel

`crustAt()` calls `rustFront()` (`art.ts:322`) and the rust surface calls it
again for `deep` (`art.ts:528`), at the same `u, v`. `rustFront` is a 3-octave
gradient fBm, two gradient noises and a 9-cell cellular lookup. Roughly a
quarter of rust's 31 ms.

### 3. Every touch of the washer rebuilds its brushes

Per card under the nozzle, per touch (`workCard`, washer branch):

- `sheen()` → one `createRadialGradient` + fill, and a
  `card.wet.style.opacity` write (same value every time).
- `shieldOf(card)` → maps the debris into a new array and allocates a closure;
  that closure then runs `bits.some(Math.hypot…)` for every grid cell the
  ellipse covers, twice (in `wearOf` and in `stamp`).
- `card.fields.slice()`.
- Per field: `wearOf` and `stamp` (two walks over the ellipse's cells),
  `eraseAt` (save/restore and **three** radial gradients), and where cells
  finished, `wetAt` (another gradient), `gleam` (throttled), `startRun`.
- `cardClean(asState(card), webs)` → `asState` allocates a state object and a
  mapped field array on every touch.

With 160 touches per event this is the heaviest thing a stroke does. The
gradients dominate: a gradient object is built, its colour stops parsed from
strings, and it is thrown away, up to five times per touch per card.

The glove branch has the same shape on a smaller scale: `carried.map(...)`
inside the per-bit loop, per touch.

### 4. Rivulets rebuild their brushes too

`drawRuns()` lays up to 12 sub-steps per rivulet per frame, each `runAt()`
building one gradient (three at the head) and calling `washOf()`, which
allocates an array. Cosmetic and short-lived, but it runs every frame while
water is running.

### 5. The mist canvas re-uploads every idle frame

`drawMist()` does `clearRect` over the whole viewport **before** checking
whether there are motes. A cleared canvas is a changed canvas: the compositor
re-uploads a full-viewport texture 60 times a second while nothing is happening.
On a 4K or high-DPI screen that is the mode's largest idle cost.

### 6. Badges recompute from scratch every frame

`paintBadge()` runs for every card every frame and calls
`toolWork(liveState(card), …)`: a new state object, a filtered and mapped field
array, a result object — about 75 allocations a frame at 25 cards, for answers
that change only when that card is worked. The DOM writes are already guarded;
the computation is not.

### 7. Canvas memory: most of it is idle

`buildCard()` gives every card its crust canvas(es) **plus** a wet canvas and a
run canvas, each `texSide()` up to 512 × 512 — 1 MiB of backing store apiece.
At 25 large cards that is ~75–100 MiB, and only the card being washed ever uses
its wet and run canvases. `.clean-wet` also carries `mix-blend-mode: screen`,
which is 25 blended layers kept in the compositor while invisible.

### 8. The web sheet is one huge filtered surface

`.clean-webs` is a single SVG sized to the bounding box of every strand plus
400 world units of padding, with `filter: drop-shadow(...)`. A filtered element
is rasterised through an offscreen surface sized to its bounds (clipped to the
viewport where the browser can), and re-rasterised on every zoom step.

### 9. Opening reads 25 computed styles between DOM writes

`buildCard()` → `setRadius()` → `getComputedStyle(node).borderRadius`, once
per card, after the previous card's box was appended. Each read after a write
forces a style recalculation — 25 of them inside the keypress that opens the
mode.

### 10. The drained colour — measure before touching

`.item.is-clean-held .item-body { filter: saturate(0.15) }` on up to 25 card
bodies, with a 1.2 s filter transition on every body while the mode is up.
Filtered layers re-raster on zoom, and big images make that expensive — but a
compositor-side saturate may be cheap. Needs a DevTools performance trace of a
pan and zoom across a board of large images before anything is changed. It is
also the mode's best moment (colour coming back card by card), so the bar for
replacing it is high.

### Low priority

- **The star reveal** re-rasterises a full-screen masked SVG rect each frame for
  ~1.2 s. Short, once per run.
- **The date blur** changes `filter: blur()` on a ~96px line each frame of the
  spin. Small element.
- **The robots' `seekJob`** builds spot arrays over every cell of every card
  (`dirtySpots`); it is throttled by `seekAt` and runs only with robots out.
  `robotMop` has the same per-stamp gradient cost as §3 and gets that fix free.
- **`tick()` runs continuously** even when nothing moves. With §5 and §6 done
  its idle cost is a few map lookups per card; not worth an idle gate.

## Plan

Each phase is independent and ends with `npx tsc --noEmit; npm run lint;
npm run build; npm test` green. None touches the `.mbrd` schema, a generated
catalogue, or `sw.js`.

### Phase 1 — a smooth opening (no visible change)

1. **Time-slice the crust.** Make `crustPixels()` resumable: a small state
   object (arrays, next row, pass) and a `step(budgetMs)` that works rows until
   the deadline; the existing one-shot function becomes a loop over it, so
   `tools/grime-shots.mjs` and the tests keep working unchanged. `drainPaint()`
   spends ~6 ms a frame across the queue instead of one whole crust. 750 ms of
   work at 6 ms a frame is ~2 s of frames, all under the intro's black, which is
   up for 6–7 s. A worker was considered and rejected: a new bundle, a CSP
   `worker-src` entry and a `SHELL` line for a cost the intro already hides.
   With `quality.anim` off the intro is instant, so keep the budget but let it
   take more (say 12 ms) until the queue is empty.
2. **Rust's front once.** In `crustAt()`, when the kind is rust, keep the raw
   front in module scratch (the `cellF1` pattern); the rust surface reads it
   instead of recomputing. `crustPixels` calls `crustAt` then the surface for
   the same point, so the scratch is always fresh. Re-time with the Node
   one-liner; expect rust near 23 ms.
3. **Read corners first.** Split `setRadius()` so `startClean()` reads every
   picked card's `borderRadius` (and GIF check) in one pass before
   `buildCard()` writes anything.

Check: re-run the timing; in the browser, the date reels should roll evenly
from the first frame.

### Phase 2 — cheaper washing (should look identical)

1. **Brush sprites.** A module-level cache in `art.ts` of small offscreen
   canvases, one per brush profile: the soft erase, the crisp erase, `wetAt`,
   `sheenAt`, `gleamAt`, and `runAt`'s wash, bead and highlight — each drawn
   once at a fixed size (e.g. 64 px) with the same colour stops at alpha 1.
   A touch becomes `globalAlpha = strength` + `drawImage(sprite, x - rx, y - ry,
   2rx, 2ry)`, which also gives the ellipse for free. `runAt`'s colour varies by
   grime and dirt: cache per kind with `dirt` quantised to ~8 steps. The erase's
   per-disc jitter and size roll stay as they are.
   Look check: a sprite at 64 px drawn up to a 150 px brush is soft enough for
   these falloffs; if the crisp edge softens, give the crisp sprite 128 px.
2. **Shield once per frame.** Cache each card's shield on the `LiveCard`,
   rebuilt only when its debris changes (scoop, skid, drop, tug) — a
   `debrisVersion` bump in those four places. Precompute it as a `Uint8Array`
   over the grid rather than a closure, so the per-cell test is an index.
3. **Per-frame, not per-touch.** Collect touched cards in a `Set` during
   `apply()`; in `tick()` run `cardClean` once per touched card, and write
   `wet.style.opacity` once. `workCard()`'s own `cardClean` call goes.
4. Hoist `carried.map(c => c.kind)` out of the glove loops, and the
   `fields.slice()` where nothing is removed mid-loop.

Check: wash a tar card fast and slow, look at the edge, the sheen and the
runoff side by side with the current build.

### Phase 3 — a quiet idle frame

1. `drawMist()`: keep a `mistDirty` flag; clear only if the canvas had motes
   last frame, and return before the clear when it did not.
2. Badge change counter: a `workVersion` on each `LiveCard`, bumped wherever
   its fields, debris or webs change; `paintBadge()` recomputes `toolWork` only
   when the version, the held tool or the check timer moved.

Check: DevTools → Rendering → paint flashing, hand still, no tool: nothing
should flash.

### Phase 4 — memory and layers (one visible change: the web shadow)

1. **Lazy wet and run canvases.** Create on first `sheen()` / `startRun()`,
   append in their slot (before `bits`), and release after the fade (remove the
   node, `width = 0`). `drawRuns` and the sheen decay already know when they
   are finished. Saves ~50 MiB at 25 large cards and the 25 idle blended
   layers. `stopClean()` needs nothing new — they die with the layer.
2. **Bake the web shadow.** Drop the filter; add a second path per web, offset
   down and a little right, in the ink colour at low alpha, drawn first — the
   way `shadowOf()` does it for debris. The shadow will be sharper than the
   blurred one; widen its stroke a touch to compensate. **Look check needed.**
3. Optionally tighten the web sheet's bounds (the 400 pad exists for the
   spider's drop and dust; the spider has its own node, so the pad can shrink
   to the sag plus the stroke).

### Phase 5 — measure, then decide

A DevTools performance trace on a board of 25 large images: pan and zoom with
the mode up and with it down. If the `saturate` filter shows as re-raster time,
the candidates are (a) moving the drain to the image's own `filter` only
(not the whole body), or (b) dropping the transition and switching at once.
Both change the feel of the colour coming back; bring them to the maintainer
as options rather than choosing.

## Order and risk

Phases 1–3 carry no visual risk and fix the one problem already on screen (the
intro stutter). Phase 4 changes how the web shadow looks and wants a look.
Phase 5 is measurement first. Recommended: 1 → 3 → 2 → 4 → 5 (3 is small and
independently verifiable with paint flashing, 2 is the largest diff).
