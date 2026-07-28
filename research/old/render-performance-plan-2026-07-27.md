# Render performance — execution plan for a Sonnet agent — 2026-07-27

Companion to `render-performance-2026-07-27.md` (the diagnosis) and
`scalability-readability-audit-2026-07-27.md` (the wider audit). This is a
step-by-step plan to make pan/zoom smooth and stop scrolling images being a toll,
ordered low-risk-first. **Step 1 is already done** and is recorded here for
context.

## Ground rules for whoever executes this

- **The test suite does not exercise the DOM render path.** `npm test` (515
  tests) guards logic and structure only. Every step below must be verified by
  hand in the browser: `python serve.py`, open on `localhost:6273`, and use a
  *large* board (see "Test board" below). Do not report a step done on a green
  test run alone.
- **Do not kill the dev server on port 6273** — it is the user's.
- One step per commit. After each: `npm test`, `node --check` the touched `.js`,
  then the manual pan/zoom pass. If a step regresses stacking, selection, or
  media playback, revert it — none of these is worth a correctness bug.
- Keep the module-header comment convention (the *why*, at length). Match the
  surrounding prose density.
- Respect the invariants in `CLAUDE.md`: no browser globals at import time; every
  shipped asset in `SHELL` in `sw.js`; do not hand-edit the version-stamp lines.

## Test board (build once, reuse)

You need a board heavy enough to make the O(n) costs visible. In the browser
console (`window.mbrd` is a live handle):

- Aim for **500–2,000 items**, mostly photos, spread across a wide area so many
  are on and off screen. Import a folder of images (drag-drop) and use
  "Rearrange all" a few times, or script additions via `mbrd`/`cmds`.
- Open Chrome DevTools → Performance, record a 3–4 s pan and a 3–4 s pinch/scroll
  zoom. The metric that matters is **scripting + rendering time per frame** and
  whether frames hold 60 fps (16.6 ms). Note the worst offenders in the flame
  chart before and after each step.

---

## Step 1 — Decouple `paintStack()` from the view path — DONE

Already applied in `canvas/items.js` this session. `sync(restack = true)`;
`syncView()` calls `sync(false)`; fresh mounts read a cached `stackIndex`; the
event paths still restack. See the diagnosis doc for the rationale.

**Verify (not yet done):** on the test board, drag one card and confirm z-order
is correct (it should sit above/below the right neighbours); pan and zoom and
confirm cards keep correct stacking as they mount in; check sticky notes still
draw above their host after a move. Record the per-frame scripting drop.

---

## Step 2 — Spatial grid index for culling (biggest remaining win)

**Problem:** `sync()` (`items.js:198`) scans all `board.items` every zoom frame,
and crossing the cull margin during a pan fires one full scan in a single frame
(the pan hitch).

**Approach:** bucket item ids into a coarse uniform grid keyed by world
position, so `sync()` visits only the buckets overlapping the padded viewport
rect instead of the whole array.

- New small module `canvas/spatial.js` (bottom layer, no `state`/DOM imports —
  it takes plain `{id,x,y,w,h}` and a cell size). API roughly:
  `rebuild(items)`, `update(id, item)`, `remove(id)`, `queryRect(rect) → ids`.
  Cell size ≈ a few hundred world units (tune so a typical viewport touches a
  handful of cells). An item spanning cells is registered in each it overlaps;
  dedupe on query.
- Wire it from `canvas/items.js`: rebuild on `board:load`/`items`, `update` in
  the `geom` handler per moved id, `remove` on cull-discard is **not** needed
  (index is by item existence, not mount state). In `sync()`, replace
  `for (const item of board.items)` with iterate `queryRect(paddedRect)` for the
  *mount* decisions; still need to detach nodes that left — handle that by
  walking the currently-mounted `nodes` map (which is bounded by what is on
  screen, not by board size) and unmounting any whose id is no longer in the
  query set.
- Keep `BUILD_BUDGET` rationing unchanged.

**Watch out:** rotated items — `itemRadius` already gives a circumscribed radius;
register by that padded box so nothing pops in late. Verify the "media survives
leaving the screen" cache path (`disposable()`, `items.js:230`) still works —
unmounting logic must not discard mid-playback video.

**Acceptance:** panning a 2,000-item board shows no periodic hitch; zoom
scripting time is flat as item count grows (scan is now viewport-bounded, not
board-bounded). No missing/late cards at the viewport edge.

---

## Step 3 — Skip culling while zooming *in*

**Problem:** zoom invalidates the `syncedRect` guard every frame, so `sync()`
runs every zoom frame. But zooming *in* only ever *hides* items (the visible rect
shrinks) — nothing new can appear, so there is nothing to mount.

**Approach:** in `syncView()` (`items.js:181`), when the new visible rect is
*contained* in `syncedRect` (already the guard) OR the zoom increased and the
rect shrank, skip `sync()` during the active gesture (`vp.moving === true`,
already tracked, `viewport.js:611`) and run one final `sync()` on settle. Zoom-out
(rect grows) must still sync each frame so revealed cards mount.

- Simplest correct form: if `vp.moving` and the new rect ⊆ `syncedRect`, return
  (the existing containment check already covers pure zoom-in — confirm it does
  and that this needs no new code beyond not special-casing zoom). If it already
  returns for zoom-in, this step is just a verification that zoom-in is cheap and
  the work is only on zoom-out.
- Ensure the settle path (`viewport.js:624` emits `change` on stop) triggers a
  final `sync()` so anything deferred lands. It does via `syncView`; confirm.

**Acceptance:** zoom-in scripting time is near-zero (no per-frame sync); zoom-out
still mounts revealed cards smoothly under the build budget.

---

## Step 4 — `byId` → `Map<id,item>` index

**Problem:** `byId` (`state.js:246`) is an O(n) `find`, called ~60× including in
drag/`geom` paths (`placeNode` `items.js:614`, `applyGeom` `state.js:943`).

**Approach:** maintain a `Map<id,item>` inside `state.js` alongside
`board.items`. Rebuild it in `loadBoard`/`normalizeBoard`; keep it in sync in the
few mutation sites that push/splice `board.items` (`addItems`, `removeItems`,
`restoreItems`, clipboard paste, trash restore). `byId` becomes `map.get(id)`.

**Watch out:** `board.items` is a mutable exported singleton some modules iterate
directly — do **not** change its shape or order; the Map is an *index beside* it,
not a replacement. Every code path that adds/removes an item must update both.
Add a cheap dev assertion (behind a flag) that `map.size === board.items.length`
after mutations while developing, then remove it.

**Acceptance:** `npm test` green; dragging a multi-select on a large board is
visibly cheaper in the flame chart (no O(n) `find` per moved id per frame).

---

## Step 5 — Opaque caption plates: remove the per-image `backdrop-filter`

**This is the user's flagged effect** ("name background goes translucent when
moving"). The translucency-on-move is the app dropping the frosted blur for
performance (`app.css:1688`). Removing the blur entirely deletes both the
per-image cost *and* the flicker.

**Approach (aesthetic decision — confirm with the user before shipping):**

- Replace `.item-bar { backdrop-filter: blur(3px) }` (`app.css:1596`) with an
  **opaque or near-opaque solid tint** that reads over any photo without
  sampling through itself. Bump the plate's `color-mix` paper toward opaque
  (currently `88%`, `app.css:1594`) or use a flat token colour.
- Once no plate uses `backdrop-filter`, **delete the cheap-mode rule**
  `#world.is-viewing .item-bar { backdrop-filter:none }` (`app.css:1688-1693`)
  for `.item-bar` — there is nothing left to toggle, so the flicker is gone.
- Decide separately whether the media-button blurs (`.vbig` `:1107`,
  `.transport-video` `:1139`, `.card-audio.has-cover .play` `:1070`) keep their
  blur; they are far fewer than caption plates. If kept, leave their `is-viewing`
  toggles in place.

**Acceptance:** a stationary 200-photo board no longer shows per-plate blur cost
in the paint profiler; the name bar looks identical moving and still (no
flicker). Get the owner's sign-off on the look — this trades frosted glass for
flat, and that is a taste call, not a bug fix.

---

## Step 6 — Delta-carrying `items` / `geom` events (structural)

**Problem:** `bus.emit('items')` carries no payload, so listeners full-scan the
board. Worst: `main.js:440` re-grows *every* note on every `items` event; also
`paintCount` and mobile-bounds recompute over all items.

**Approach:** have the mutators emit `{ added:[ids], removed:[ids] }` with
`items`, and keep `geom` carrying its id array (it already does). Update
listeners to act on the delta:

- `main.js:440` — grow only added notes.
- `canvas/items.js` `reconcile()` — can use `removed` instead of diffing the
  whole `nodes` map against a fresh Set of all ids (`items.js:126`).
- Leave listeners that genuinely need the whole board (counts) reading
  `board.items.length`, which is O(1).

**Watch out:** several emit sites (8 of them, per the audit). Backward-compat:
listeners that ignore the payload keep working, so migrate emitters first, then
listeners, and default a missing payload to "unknown → full scan" so nothing
breaks mid-migration.

**Acceptance:** importing/adding many items no longer shows O(n) work per added
item; `npm test` green.

---

## Step 7 — `contain` / `content-visibility` on `.item` (cheap experiment)

Add `contain: layout paint` to `.item` (`app.css:480` block) and measure. If
solid, try `content-visibility: auto` with a `contain-intrinsic-size` matching
the card box so offscreen-but-mounted cards skip rendering. **Measure both** —
`content-visibility` can interact badly with the existing JS culling and with
`overflow:hidden` clipping; keep it only if the profiler clearly improves and
nothing pops. Low effort, revert if neutral.

## Step 8 — Trim standing layers

`.wave-fill { will-change: clip-path }` (`app.css:987`) promotes a layer per
audio card for its whole life. Scope it to only while the card is actually
playing (toggle a class from `canvas/audio.js` on play/pause and put
`will-change` behind it), or drop it and measure. Minor unless boards are
audio-heavy.

---

## Suggested order & stopping point

Do **2 → 3 → 4** first: they are the per-frame JS wins and are correctness-safe
if the "watch out" notes are respected. Then **5** (the user's flicker
complaint) once they confirm the look. **6** is the highest-value structural
change but the broadest — do it deliberately, on its own branch. **7 and 8** are
cheap experiments to run last and keep only if measured.

Stop and re-measure after each step; if pan/zoom is already smooth on the target
board after 2–3, the rest is polish and can wait.
