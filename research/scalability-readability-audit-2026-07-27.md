# Scalability, efficiency & readability audit — 2026-07-27

Companion to the 2026-07-26 correctness/security and Tauri-readiness audits.
Those covered *is it correct and safe*; this one covers *how well does it grow,
how hard is it to change, and how fast does it run*. Security findings are out
of scope here except where a performance defect and a correctness defect share a
root cause.

Method: dependency-direction inspection plus targeted source review of the five
subsystem clusters (core hub, canvas/render, import·storage·optimize, ui,
arrange), grounded against the running code. Line references describe the
working tree at `da660d9` (`v0.51`).

## Executive summary

The codebase is genuinely well-built for what it is today: a dependency-free,
build-step-free browser app with unusually strong pure-logic tests, clean
layering *on paper*, and thoughtful rendering machinery (viewport culling with a
build budget, a single shared WebGL context, RAF-throttled grid repaint). For a
board of dozens-to-a-few-hundred items on a modern machine it is fast and the
architecture holds.

The problems are **not correctness and not present-day speed** — they are what
happens as the board and the codebase grow. Two structural facts dominate
everything below:

1. **Almost every core operation is O(n) in total item count, and several are
   O(n²).** The board is a flat array with no id index, and a large amount of
   work — restacking, culling, serialization, note-stickiness, mobile packing —
   is redone over *all* items on *every* mutation and *every* frame, rather than
   over the items that actually changed. This is invisible at 100 items and a
   wall at 5,000–10,000.

2. **`state.js` (2,291 lines) is a god-module**, and it is the coupling hub the
   entire UI reaches into directly. It is the single hardest file to change
   safely, and it is where roughly half the scalability defects live.

The good news is that the highest-leverage fixes are concentrated: a persistent
`Map<id,item>` index and event payloads carrying *what changed* would together
retire the majority of the O(n²) hot paths without touching the architecture's
shape.

Severity tally: **11 high, 12 medium, ~10 low.** "High" here means a change that
becomes a real ceiling on board size or a real drag on maintainability — not a
crash or a vulnerability.

## Part 1 — Scalability

This is the headline. The recurring anti-pattern is *whole-board work triggered
by a single-item change*.

### 1.1 `byId()` is an O(n) linear scan — the single worst defect

`state.js:246` — `export function byId(id) { return board.items.find(...) }`.
Called ~60 times across 10 modules, frequently *inside loops and sort
comparators*, which turns O(n) into O(n²) or worse:

- `stackOrder()` (`state.js:1132-1133`) calls `byId` **twice per comparison** →
  O(n² log n).
- `raiseSelection`/`lowerSelection` (`state.js:1116`, `1126`) — `byId` per id in
  a loop.
- `applyGeom`/`snapshotGeom`/`writeSnapState` (`state.js:943`, `930`, `1076`) —
  `byId` per snapshot entry, i.e. per moved item per frame during a drag.
- `addItems` dedupe (`state.js:419`, `694`) — `byId` per added item.

There is no id→item index anywhere in the app. **Severity: high. This one fix
collapses most of the O(n²) paths at once.**

### 1.2 A single-item change re-touches the whole board

- **Restack on every frame — `canvas/items.js:609` `paintStack()`.** Runs on
  every `sync()` and every `geom` event; calls `visualStackOrder()` →
  `stackGroups()` (O(n log n), worst-case O(n²) when sticky relations are
  uncached), then walks the entire `nodes` Map writing `style.zIndex` on every
  node — *and allocates a fresh n-sized Map each call*. Dragging one card
  restacks the entire board once per frame. **High.**
- **Cull scan on every geom — `canvas/items.js:60`, `192`.** The `geom` handler
  re-places the moved ids, then calls `sync()`, which loops **all**
  `board.items` (O(n)). Dragging one card is O(n) cull + O(n log n) restack per
  frame. Pan is cheap (rect-containment guard at `items.js:185` short-circuits
  it); **zoom and drag are not** — both invalidate the guard every frame. **High.**
- **Note re-grow on every `items` event — `main.js:440`.**
  `bus.on('items', () => rAF(() => for all items if note growNote))` iterates
  *every* item on *every* add/remove/reorder. **High.**
- **`'items'` carries no payload** (`state.js`, 8 emit sites). Listeners cannot
  know *what* changed, so they full-scan. Giving the event a delta
  (added/removed ids) is the structural fix that lets §1.2 listeners stop
  scanning. **High.**

### 1.3 Serialization does heavy whole-board work on every autosave (~1/s)

`serializeBoard()` (`state.js:2229`) calls `completeLayout()` for **both**
desktop and mobile every time; mobile triggers a full `placeMobileItems()`
repack (`packMobileGrid`, `state.js:449` — nested first-fit probing an
occupancy Set with a freshly allocated `` `${x}:${y}` `` string per cell). It
then maps `serializeItem`/`serializeGeometry` over all items three times.
Autosave fires roughly once per second while editing; on a large board this
single function dominates the frame budget. **High.**

### 1.4 Sticky-notes and stack grouping are O(n²) after every load

`stackGroups()` (`state.js:1192`) calls `stackRoot()` → `stuckTo()` →
`measureStick()` (`state.js:1489`, a full O(n) scan) for every item. The
`sticks` Map memoizes, but it is cleared on every `loadBoard`/`forgetSticks`, so
the **first** render pass after opening a board is O(n²). `stuckFollowers()`
(`state.js:1529`) is a multi-pass fixpoint over all notes, each pass calling
`stuckTo` per note, and it runs at the start of every drag gesture. **High /
medium.**

### 1.5 Storage buffers the entire board in RAM, twice, serially

- `packBoard` (`storage/mbrd.js:150`) reads every asset via
  `await asset.blob.arrayBuffer()` into a `Uint8Array`, **serially**
  (await-in-loop), then `writeZip` (`storage/zip.js:199`) holds every compressed
  payload in `parts[]` and finally `new Blob([...parts, ...])`. Peak memory ≈
  all-uncompressed-bytes + all-payloads + final-Blob. A multi-GB board is
  resident 2×+. No streaming. **High.**
- Export (`storage/storage.js:126`) packs the whole Blob before writing a single
  byte, even on the File System Access path that *could* stream. **High.**
- Autosave does **one IndexedDB transaction per asset** (`storage.js:504-530`,
  `idb.js:27` opens a fresh tx per call) — thousands of transactions per
  debounced save on a heavy board. Restore is the same, serial `idbGet` per
  asset (`storage.js:597`). Should be one batched transaction. **High / medium.**
- Open re-hashes every asset serially (`mbrd.js:470` — `await sha256` per asset
  in a loop) before the board appears. **Medium.**

The one pipeline that got concurrency right is **import** (`drop.js:265`,
bounded-parallel `IMPORT_WORKERS=6`) — proof the pattern is understood; it just
wasn't applied on the storage side.

### 1.6 Other O(n²) / superlinear paths

- `selectionHasStackOverlap()` (`state.js:1170`) — O(n²) pairwise polygon
  overlap, exposed as a live context-menu command. **High.**
- `arrange/arrangements.js` packing (`slideOut` `:449`, `spiral` `:216`,
  `scatter` `:348`) — ~O(n²·tries), main-thread, documented at ~0.5s @ 2,000
  items and capped at 500/drop. Real ceiling, acknowledged. **Medium.**
- `ui/search.js` (`:182`) re-scans and re-allocates every item's search fields
  on every keystroke, no index, no debounce, full `replaceChildren()` rebuild.
  Author bounds it to "hundreds." **Medium.**
- `web.js build()` runs O(n²) `spanningTree` per drag frame, governed only by an
  adaptive dense-limit governor (see §2.2). **Medium.**

### 1.7 Undo/redo is bounded by count, not memory

History cap is 200 *entries* (`state.js:328`), but each entry closes over full
snapshots: a geom command over 10k items retains two 10k-element arrays
(`commitGeom` `:964`); `removeItems` (`:635`) pins full removed item objects
*and* evicted trash entries; `swapAssets` (`:1729`) clones every item's `meta`.
No byte-size cap. Trash pins up to 60 full items (with asset bytes) and is
serialized into the save file. **Medium.**

## Part 2 — Biggest structural problems

### 2.1 `state.js` is a god-module (2,291 lines, ~10 responsibilities)

In one file: title sanitization, command history, item CRUD, mobile grid
packing, layout/settings profiles, whole-board snapping, z-order/stacking,
sticky-note relations, clipboard, selection, and (de)serialization. Every one is
a candidate module, and changing any of them means opening the 2.3k-line hub.
The file already has comment-banner seams along exactly these lines — splitting
along them into modules that sit behind the same `bus` would not change the
architecture, only its blast radius. **High.**

### 2.2 A rendering file hides a self-contained algorithm module

`canvas/web.js` (889 lines) bundles four concerns: the graph algorithm
(`spanningTree`, `threads`, `EdgeGrid`, `crosses`), a ~120-line adaptive
performance governor (`learnTree`/`denseLimitFor`/`nextDenseLimit`/`settle`), a
fade animation state machine, and SVG culling/paint. The graph + governor (~450
lines) is a `web-graph.js` waiting to be extracted. The governor being
wall-clock dependent is also why its test was flaky (noted in the 07-26 audit).
**Medium/high.**

### 2.3 The UI layer reaches straight into `state`, `canvas`, and `storage`

There is no insulating layer. `ui/appearance.js` imports 6 named exports from
state, plus `pigments`, `storage`, and `look`; `ui/sidebar.js` imports 8;
`ui/menu.js:17` imports `canvas/items` and bypasses its own `cmds` surface;
`ui/search.js:23` reaches into `canvas/viewport`. The documented "state.js is the
only door" holds for *mutation*, but *reads and wiring* couple the UI to
internals widely, so `state.js` can't be refactored without touching most of
`ui/`. **High.**

### 2.4 Two sources of truth for "the look", reconciled by string compare

`ui/appearance.js` (1,110 lines) keeps `current` mutated in place *and* mirrors
it to both `localStorage` and `board.settings.appearance`; equality is
`JSON.stringify(clone(a)) === JSON.stringify(clone(b))` (`sameLook` `:910`),
whose key-order fragility the comment itself acknowledges. It is also a
god-module in its own right (data-model + persistence + extraction + fade loop +
control-building + colour conversion). Token ownership is split across three
files (`look.js TOKENS`, `pigments PALETTE_TOKENS`, `appearance AXIS_TOKENS`) so
"what is a pigment token" has no single home. **High.**

### 2.5 `main.js` and `storage.js` mix distinct concerns

- `main.js` (1,213 lines) is boot + wiring **plus** ~15 substantial UI concerns
  (title editing `:513`, zoom readout `:348`, save cooldown `:838`,
  clear-countdown `:977`, rearrange engine `:1038`) that aren't "wiring." **Medium.**
- `storage/storage.js` (738 lines) is five modules: Save, Export, Open, New, and
  the entire ~300-line IndexedDB working-cache/autosave/session subsystem
  (`:386-627`), which is a distinct concern from the file-door half. **High.**
- `import` ↔ `optimize` are mutually coupled (`optimize.js:27` and `opus.js:20`
  import `import/artwork.js`; `drop.js` imports `optimize/picture.js`). The
  shared audio-container parsing under `import/` belongs in a neutral module.
  **Medium.**

### 2.6 Global mutable singletons and an untyped event bus

`window.mbrd = { board, bus, vp, cmds, selection }` (`main.js:1155`) plus
`board`/`selection` exported as mutable singletons mean any importer can mutate
state outside the commit/event path. The `bus` (`util.js:102`) is stringly-typed
with no schema — payload conventions live only in a header comment, a typo fails
silently, and the emitter swallows handler exceptions. Coupling is implicit and
untyped, which is what makes §2.1 refactors risky. **Medium.**

### 2.7 `input.js` gesture state is ~10 loose module globals

`canvas/input.js` (1,157 lines) is coherent but drives an ad-hoc gesture state
machine from ~10 module-scope `let`s (`g`, `spaceDown`, `hover`, `copiedFrom`,
`pressTimer`, `longPressMenu`, `lastEmptyTap`, `armSelect`, …, `:144-158`), and
its `pointermove` (~190 lines) and `pointerdown` (~125 lines) handlers are giant
branch dispatchers. Collapsing the globals into one gesture-state object and
extracting the resize-math branch would help most. **Medium.**

## Part 3 — Efficiency (redundant work on hot paths)

- **`ui/appearance.js setVar` writes the whole sheet *and* persists on every
  drag frame** (`:772-824`). A colour-picker drag runs `paletteFromAccent`,
  writes ~14 CSS props, then `persist()` does `JSON.stringify` + **synchronous
  `localStorage` write** + `setAppearance(clone)` *per pointer-move*. No
  debounce. Synchronous storage I/O on the pointer path. **High.**
- **Forced style reads on drag frames.** `model.js:658`
  `getComputedStyle(stage).color` per orbit frame; `model.js:444` `boardInk()`
  appends/reads/removes a probe `<div>` (forced reflow) per card build.
  `appearance.js` calls `getComputedStyle(root)` from five separate functions
  (`:987`, `:762`, `:749`, `:462`, `:402`) that often run together — five style
  flushes where one batched read would do. **Medium.**
- **Images decoded 2–3× at import** (`drop.js:399` `measureSize` decodes, then
  `makeThumb`/`createImageBitmap` decodes again, video posters re-`measureSize`).
  **Medium.**
- **Three near-identical geometry write-loops** — `writeLayout` (`state.js:892`),
  `applyGeom` (`:943`), `writeSnapState` (`:1076`) each loop + `byId` +
  `fitBoardMode` + copy keys + emit. One helper. `commitGeom` snapshots twice
  (`:964`, `:981`). **Medium.**
- **`addFile` double-buffers every import** (`storage/assets.js:43` —
  `arrayBuffer()` then `new Blob([buf])` copies a File that was already a
  storable Blob). **Low.**
- **`marquee` filters all items per pointermove** (`input.js:324`); **`search
  move()` re-queries the DOM per arrow key** (`search.js:280`). **Low/medium.**

## Part 4 — Readability

The prevailing style is **rationale-dense**: module headers and function
preambles carry the *why*, often at length. This is a real asset — the design
reasoning is captured where a maintainer will find it, and it is consistently
good. The cost is that several files are **majority prose**, and the actual
control flow is slow to skim: a 30–40 line essay atop a 3–5 line function
(`cullMargin`, `nextDenseLimit`, `TOUCH_MIN_MM`, most of `appearance.js`) inverts
the usual signal ratio, and the comments sometimes re-argue history rather than
describe current behaviour. This is a taste call, and the current owner clearly
values it; flagging it as a *scanning cost for new contributors*, not a defect.

Concrete cleanups worth doing regardless of that taste:

- **Duplicated/orphaned doc blocks.** `renameItem` has two stacked JSDoc blocks
  (`state.js:1604` and `:1617`); `drop.js:504` documents `addLink` but sits above
  `embedPage`; `pigments.js:618` has three stacked blocks, two near-identical;
  `optimize/optimize.js` `planOptimize` is called and re-called. **Low.**
- **No element-creation helper exists.** `util.js` exports only `el =
  getElementById`. The identical `label.field > head(span+output) > input[range]`
  DOM is hand-built in `appearance.js:929`, `mobile-header.js:391`, and
  `buildWeight:336`; font-option `<select>` building is duplicated in three sites
  (`appearance.js:949`, `mobile-header.js:256`, `fonts.js:115`). A shared
  `field()`/`rangeControl()`/`fontOptions()` is the missing abstraction and would
  delete real duplication. **Medium.**
- **Oversized functions worth extraction** (length is dense inline math, not
  comments): `input.js` `pointermove`/`pointerdown`; `grid.js` `paintGrid` (~120);
  `web.js` `build`/`paint`/`threads`; `opus.js` `pager()` (70-line stateful
  closure). **Low/medium.**
- **Cosmetic:** dedented comment mid-function at `main.js:1059`; terse
  uncommented arithmetic in `fitMobile` (`state.js:776`). **Low.**

## What is genuinely good (keep it)

- `geometry.js`, `measure.js`, `layout-settings.js`, `look.js`, `dialog.js`,
  `idle.js`, `konami.js`, `scalebar.js` — small, pure, cohesive, testable. No
  action.
- Viewport culling with a per-frame build budget (`items.js:154`) and the
  pan-containment guard (`items.js:181`) — the right idea, well executed.
- The grid's gradient-tier repaint is **not** the cost it looks like: pan only
  rewrites `background-position`, image/size are string-compared and skipped,
  computed ink is cached (`grid.js`). Well-optimized.
- Single shared WebGL context blitted into 2D canvases (`model.js`) — correct
  answer to the ~16-context browser cap.
- Bounded-parallel import (`drop.js:265`). Content-addressed assets making
  dedupe free. The hand-rolled ZIP over `CompressionStream`.

## Prioritized fix list (leverage-ordered)

1. **Add a persistent `Map<id,item>` index; make `byId` O(1).** Retires §1.1 and
   most of the O(n²) callers in one change. Highest leverage in the codebase.
2. **Give `'items'`/`'geom'` events a delta payload** (added/removed/changed
   ids). Lets `main.js:440`, `paintStack`, and `sync` stop full-scanning on
   single-item changes (§1.2). Structural, but mechanical once byId is indexed.
3. **Decouple restack from cull, and make both incremental** (`items.js:60`,
   `:192`, `:609`). Restack only affected layers; only cull when the mounted set
   can actually change.
4. **Stop repacking mobile inside `serializeBoard`; batch autosave/restore into
   single IDB transactions** (§1.3, §1.5). Directly cuts the per-second cost.
5. **Stream ZIP entries** to the writable/Blob instead of buffering all payloads
   (`mbrd.js` packBoard + `zip.js` writeZip + export). Removes the memory
   ceiling on large boards.
6. **Debounce `appearance.js persist()`** off the pointer path (§ Part 3, first
   bullet). Small change, removes synchronous I/O from a drag.
7. **Split `state.js`** along its existing comment-banner seams (history,
   stacking, sticky, clipboard, mobile-pack, serialization) into modules behind
   the same `bus`. Then extract `web-graph.js` from `web.js` and the working-cache
   from `storage.js`. Reduces the blast radius of every future change.
8. **Cache the id index / spatial info for stacking and stickiness** so the
   first post-load render isn't O(n²) (§1.4); add a `field()` DOM helper to kill
   the control-building duplication (§ Part 4).

Items 1–2 are the ones that change the codebase's scaling class; everything else
is incremental. None of them require abandoning the no-build, no-dependency,
`bus`-centred architecture — they work with it.
