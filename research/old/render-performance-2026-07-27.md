# Render performance — navigation lag investigation — 2026-07-27

Follow-up to `scalability-readability-audit-2026-07-27.md`, narrowed to one
complaint: **pan/zoom is laggy, and scrolling a board of photos should not be a
toll on the device.** This traces the actual per-frame path, names what clogs
it, records the one fix already applied, and lists the remaining levers. A
companion execution plan for a Sonnet agent is in
`render-performance-plan-2026-07-27.md`.

## How navigation draws a frame

`Viewport._paint` is RAF-throttled (`viewport.js:232`) and emits a single
`change` event per frame (`viewport.js:721`). ~8 subscribers run on that event:
grid, items (`syncView`), web (connection threads), stills, paper, scalebar,
mobile-header, idle. The world layer itself is one promoted element moved by a
`translate…scale` transform (`app.css:100 will-change:transform`), so pan/zoom
composite on the GPU — the images are cheap to *move*.

**The lag is not GPU compositing and not forced reflow.** There are no
`getBoundingClientRect`/`getComputedStyle` reads on the navigation path (the grid
deliberately caches its ink, `grid.js:216`). The lag is **CPU + DOM-write work
that scales with item count, redone every frame** — and it is worst on **zoom**,
because zoom changes the visible rect every frame and defeats the containment
guards that make pan cheap.

## Ranked clogs

1. **`paintStack()` inside every `sync()` — the dominant clog. [FIXED, see below]**
   `sync()` runs every zoom frame; each `paintStack()` (`items.js:609`) called
   `visualStackOrder()` → `stackGroups()` (O(n·log n), allocates an all-items
   Map, `state.js:1192`), allocated a second all-items Map, then wrote
   `style.zIndex` on **every mounted node**. Z-order is invariant when the view
   moves, so this was 100% wasted per-frame work — and the per-node `zIndex`
   writes dirtied compositing on every card each frame.

2. **`sync()`'s O(n) cull scan every zoom frame — `items.js:198`.** Walks all
   `board.items` to decide what is on screen. Inherent to culling *without a
   spatial index*. Also the source of the periodic **pan hitch**: crossing the
   cull margin fires one full `sync()` in a single frame. Fix = grid-bucket
   spatial index (plan step 2).

3. **`web.paint()` full `d`-string rebuild on zoom — `web.js:375`.** When
   connection threads are visible (zoomed in), every settled thread is
   re-emitted into one path string per frame, each tested by `segmentMeetsRect`.
   Guarded on pan (`paintedRect` containment) but not on zoom. Lower priority —
   only when the web is on screen.

4. **`main.js:440` re-grows every note on every `items` event.**
   `bus.on('items', () => rAF(() => for all items if note growNote))` — O(n)
   over the whole board on every add/remove/reorder, though only the changed
   items can need it. Fix = delta-carrying events (plan step 4).

## CSS / compositing — the per-image toll

The app is already disciplined here (culling detaches offscreen nodes, images
`decoding:async`, thumbnails swap in at far zoom, shadows live in one composited
underlay). Two effects still cost per photo:

- **`backdrop-filter: blur(3px)` on every caption plate — `.item-bar`,
  `app.css:1596`** (also on `.vbig` play button `:1107`, `.transport-video`
  `:1139`, `.card-audio.has-cover .play` `:1070`). A backdrop blur cannot be
  composited once and reused — the pixels behind it change every frame of a
  zoom, so **N photos on screen = N re-sampled blur regions per frame.** This is
  the single most expensive per-item effect on a moving board, and it is per-item
  on a *stationary* board too whenever anything behind a plate changes.

- **A blurred drop shadow per item — `.item-shadow { box-shadow: var(--item-shadow) }`,
  `app.css:122`** (`0 10px 22px -10px …`, `tokens.css:125`; heavier at "Harsh"
  whimsy, `tokens.css:512`). One twin element per item. Mitigated: the
  `#item-shadows` layer sits inside `#world` (`items.js:57`), so it rides the
  world transform and is composited during pan rather than repainted — the cost
  falls at build/restack/resize, not every pan frame.

### The "name background goes translucent when moving" effect

This is **`#world.is-viewing .item-bar { backdrop-filter: none }`**
(`app.css:1688-1693`), toggled by `viewport._moving()` (`viewport.js:606`,
removed 140 ms after motion stops). It is the app's "cheap mode": it drops the
single most expensive per-item effect exactly when it is most expensive. The
plate keeps its translucent paper but stops blurring, so the un-blurred image
shows through while moving — the flicker the user noticed.

**It is a deliberate, well-reasoned optimization, not a bug.** But it is
user-visible flicker, and it exists *only because the frosted plate is
expensive*. The clean resolution is to remove the reason rather than the
symptom: an **opaque (or solid-tinted, no-`backdrop-filter`) caption plate**
would cost nothing per frame, need no cheap-mode toggle, and look identical
moving and still — killing both the per-image toll and the flicker in one
change. This is the "unnecessary effect" to reconsider; the trade-off is purely
aesthetic (losing the frosted-glass look), so it is the owner's call. See plan
step 5.

## Fix already applied (this session)

`web/assets/js/canvas/items.js` — decoupled restacking from the view path so
navigation frames stop doing whole-board z-order work:

- `sync(restack = true)`; the view-change path `syncView()` now calls
  `sync(false)`.
- On `restack === false` frames the trailing `paintStack()` is skipped. A card
  newly mounted mid-pan takes its `zIndex` from a cached `stackIndex` map
  (populated by the last real `paintStack`) instead of forcing a full recompute.
- The event paths that genuinely change order — `bus.on('items')`,
  `bus.on('geom')`, gesture-end `syncItems()`, `ensureMounted`, load/reset —
  still call `sync()` with the default `true`, so stacking stays correct.

Net per zoom frame: one O(n·log n) computation, two n-sized allocations, and one
`zIndex` write per mounted node removed. Behavior identical; only the redundant
recompute is gone. All 515 tests pass. **Not yet verified in a browser** — the
test suite has no DOM render coverage, so this needs a manual pan/zoom check on a
large board (plan step 0).

## Remaining levers, by leverage

| # | Lever | Kills | Risk |
|---|-------|-------|------|
| 1 | `paintStack` decouple | per-zoom-frame restack | done |
| 2 | Spatial grid index for cull | per-zoom-frame O(n) scan + pan hitch | med |
| 3 | Skip cull while zooming *in* | half the zoom-frame syncs | low |
| 4 | `byId` → `Map<id,item>` | O(n) lookups in drag/geom | low |
| 5 | Opaque caption plates (drop `backdrop-filter`) | per-image blur toll + move-flicker | low, aesthetic |
| 6 | Delta-carrying `items`/`geom` events | `main.js:440` + other full-board listeners | med |
| 7 | `contain: layout paint` / `content-visibility:auto` on `.item` | style/layout recalc across cards | low |
| 8 | Scope/drop `.wave-fill { will-change:clip-path }` | standing layers on audio-heavy boards | low |

Everything here works *with* the existing no-build, `bus`-centred,
cull-and-composite architecture — none of it requires a rewrite.
