# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` holds the contributor guide — coding style, naming, commit and PR
conventions. Read it too; it is not repeated here.

## Commands

```bash
npm test                          # node --test over tests/ — no install, no deps
node --test tests/state.test.js   # one file
node --test --test-name-pattern "undo" tests/state.test.js   # one test
python serve.py [port]            # dev server on 6273; server.bat is the Windows launcher
node tools/gen-formats.mjs [path-to-file-analyser]   # regenerate import/formats.js
save.bat                          # bump version stamps, commit, optionally push
```

There is no bundler, no build step and no runtime dependency. The browser loads
the ES modules under `web/` directly — an edit is one refresh away.
`package.json` exists only to run the tests; nothing in `tests/` is served.

Syntax checks worth running on a change: `node --check` on touched `.js`,
`python -m py_compile` on `serve.py` / `qr.py`.

## Architecture

### Layering

`util`/`geometry` ← `state` ← {`import`, `storage`, `canvas`} ← `ui`, with
`canvas` reaching into `import` only for the generated format catalog. A `ui/`
module imported from `canvas/` is a layering regression — `tests/layers.test.js`
enforces the graph, so this is a test failure and not just a style note.
Anything that builds an item's DOM belongs under `canvas/` — that is why
`renderers.js`, `notes.js`, `audio.js` and `model.js` live there rather than
under `import/` or `ui/`.

The bottom of the graph is wider than `util`/`geometry`: `measure.js`,
`mesh.js`, `arrange/arrangements.js`, `import/budget.js` and `canvas/spatial.js`
are all pure — no DOM, no `state` import — and are meant to stay that way.
`mesh.js` sits at the top level rather than under `canvas/` for exactly that
reason: it is struct reading, and only `canvas/model.js` turns its output into
pixels. `web-graph.js` is there for the same reason — the thread graph and its
governor are arithmetic over points, and only `canvas/web.js` draws them.
Six more sit down there for a different reason: they are what `state.js` was
split onto, and they took nearly half of it with them. `board-store.js` holds the
`bus`, the `selection` and the dirty flag; `board-model.js` the board's shape,
its defaults and the `byId` index; `history.js` the undo/redo engine;
`sticky.js` which note is stuck to what; `layout.js` the Mobile pack, both
geometry profiles and the undoable geometry writes; `stacking.js` z-order. All
six are re-exported by `state.js` under their old names, so nothing imports them
directly and no caller knows they exist — and **none may ever import `state.js`
back**, since a concern lifted out of that file can only stay out if what it
stands on is lower than what it left. `tests/layers.test.js` lists all six as
BASE, which is what enforces it; that list is the split, not a note about it.

Two things about that shape are worth knowing before adding to it. The Mobile
pack and the layout profiles are **one** module however they read as two —
`placeMobileItems()` and `completeLayout()` call each other, so splitting them
would be two modules importing each other. And the façade is written out
explicitly rather than as a star re-export, which is deliberate: the one thing
that broke during the split was four names that `state.js` re-exports but never
uses itself, and being explicit is what made that break loudly in five test
files instead of quietly at runtime.

### Nothing is a dependency

`storage/zip.js` inflates its own entries, `mesh.js` reads STL/OBJ/GLB by hand,
`import/artwork.js` walks ID3v2 / MP4 atoms / FLAC blocks itself,
`optimize/opus.js` wraps WebCodecs' bare Opus packets in an Ogg container it
writes by hand, and `ui/pigments.js` does its own OKLCh. That is the repo's one
real property: zero runtime dependencies. A new format is a few hundred lines of
header reading in the same style, not an npm package.

### state.js is the only door

Every board mutation goes through `state.js`, which emits on a shared `bus`
(`items`, `geom`, `item`, `selection`, `settings`, `layout`, `board`,
`board:load`, `trash`, `history`). Subsystems subscribe; they never call each other.
Undo/redo is command-based — `commit(label, redo, undo)` — so a new mutating
operation must push its own inverse rather than relying on a diff. A command
that closes over a whole-board snapshot passes a fourth argument, `weight`: the
number of items it retains, so the history evicts on what it holds and not only
on how many entries it has.

`main.js` is the wiring point: it builds the `Viewport`, calls every `init*()`,
and owns `cmds`, the single command surface that sidebar buttons
(`data-cmd="…"`), the keyboard and the context menu all drive. A new user-facing
action is an entry in `cmds`, not a second event listener.

### The sidebar is a table

`index.html` carries a head, an empty tab strip and an empty body; every control
in the panel is a row in `ui/settings-schema.js`, built by `ui/panel.js`. A new
setting is one entry there — id, tab, section, type, `get`/`set`, and `when` if
it only applies to one layout. Three tabs (Board / Look / System), always opening
on Board; `advanced: true` sinks a control into its section's fold; `when` is
*absence*, not disabling. `external: true` means another module owns the
behaviour and the builder only makes the element under the id that module looks
up — `ui/appearance.js` (whimsy, palette, the three token hosts) and
`ui/sidebar.js` (the board name) both predate the builder and are handed their
elements. The panel is built **once**, before those modules run, and repainted;
it is never rebuilt, because they hold their nodes.

Not all chrome is in the panel. `ui/nowplaying.js` is the bar along the foot
that comes up when a clip starts: the transport again, pinned to the glass, so
the thing making a noise can be stopped by whoever is listening rather than by
whoever can find its card. Volume is a row it took *out* of the sidebar — a
volume dial is reached for while something is playing, which is exactly when
the bar is up. It keeps playing off-screen because `sounding()` in
`canvas/items.js` exempts the one card making a noise from the cull; removing a
media element from the document pauses it, so before that a pan stopped the
music.

`ui/search.js` is a palette over the canvas
rather than a field in the sidebar — a search you have to open a drawer to reach
is one you stop using — and it exists because an infinite canvas can lose a
thing that is saved and intact, four screens away at last week's zoom.
`ui/idle.js` fades the corner controls after five seconds of nothing and brings
them back on any sign of life; waking too eagerly costs nothing, being invisible
when somebody reaches for a control costs everything. `canvas/mobile-frame.js`
positions the Mobile sheet and masthead in screen space itself, because doing it
the old way — custom properties written onto `#viewport` every frame —
invalidated the computed style of all of `#world` beneath it. Inherited custom
properties on an ancestor of `#world` are a whole-board cost; keep new ones off
it.

### Quality is not board state

`quality.js` sits in the base layer beside `measure.js`: one dial (Light /
Balanced / Full) resolving seven flags that `canvas/*` reads —`motion`,
`shadows`, `threads`, `blur`, `anim`, `sharpness`, `build`. Full is the default
and is exactly what shipped before it existed, so the numbers in `PRESETS.full`
are the constants they replaced (`DISPLAY_MAX`, `BUILD_BUDGET`). It is stored per
device in `localStorage`, never in the `.mbrd` — how hard someone else's phone
should work is not a property of your board. `ui/quality.js` writes the level and
three flags onto `<html>`; the CSS half is at the foot of `tokens.css` and
`app.css`, and must stay last, since `[data-quality]` and `[data-whimsy]` have
identical specificity.

### Two layouts, one board

Desktop and Mobile share **items** and differ in everything spatial. `board`
carries `layouts` (mode → geometry per item), `layoutSettings` (mode →
settings), `arrangements` (mode → name) and `sharedAppearance`; `board.settings`
and `board.arrangement` are the *active* mode's, rebuilt by `setBoardMode()`.
`board.layoutMode` is local UI state and is deliberately not persisted, so a
phone and a laptop each remember their own choice.

`layout-settings.js` is the pure split: `splitAppearance()` / `mergeAppearance()`
send palette and typography tokens board-wide and keep radius, density, grid ink
and panel dimensions layout-local. Paper is Desktop-only. Adding a setting means
deciding which half it belongs to. `docs/layout-settings.md` is the reference,
and the `.mbrd` schema keeps top-level `items`/`settings`/`arrangement`
describing Desktop for older readers.

### Coordinates and rendering

World space is float, origin at board centre, **+y up** (maths plane, not screen
space). That sign flip lives in `canvas/viewport.js` and `canvas/items.js`
`place()` only — nothing else should think about it.

`#world` is one absolutely-positioned layer moved by a single
`translate(...) scale(...)`, so pan/zoom composite on the GPU and native
`<img>`/`<video>`/`<audio>` keep working. `canvas/grid.js` paints the grid in
*screen* space on `#viewport`, not inside the transformed `#world`, which is why
it stays hairline-crisp at any zoom — and why it repaints on every view change.
Two tiers, two techniques: Softish and Middle are layered CSS radial gradients
carrying `var()`, so a slider move restyles them with no repaint and a pan is
one `background-position` write; Harsh is a `<canvas>`, because crosses are not
circles. Spacing is quantised in powers of two so zooming out never degenerates
into a solid fill.

`canvas/items.js` culls: nodes outside the viewport (plus `CULL_MARGIN`) are
detached, then either kept (media mid-playback, so a video survives leaving the
screen) or discarded. Which items are near the screen is answered by
`canvas/spatial.js`, a uniform grid over world space — the scan used to be O(all
items) per view change, redone every frame of a zoom. Assume an item's node may
not be in the DOM; `ensureMounted(id)` is the way in.

Culling bounds how many nodes exist; two more modules bound what each one costs,
and both are memory ceilings rather than polish. `canvas/display.js` mounts a
copy capped at ~1200px on the long edge instead of the stored original — a
decoded bitmap is `naturalWidth × naturalHeight × 4` however small the card is
drawn, so one phone photograph is ~96 MB and a board framed by zoom-to-fit is
what kills the tab on iOS Safari. The original is untouched and is still what
Export writes. `canvas/stills.js` is the same idea for time: past a zoom
threshold each animated GIF's *current* frame is painted into a static twin and
the two are swapped, because a browser gives no way to pause an `<img>`.

`canvas/web.js` draws the threads between item centres, and its rule is that no
two may cross: a Euclidean minimum spanning tree first (guarantees one connected
piece, and an MST provably contains no crossing), then every other thread that
fits, shortest first. `canvas/input.js` is one Pointer Events pipeline for
mouse, pen and touch with exactly one active gesture (`g`); a second finger
always wins and converts a drag into a pinch. Its header carries the full
gesture map — read it before adding a binding.

`canvas/renderers.js` is one entry per item type — `RENDERERS` plus a branch in
`classify()`. Adding a type touches nothing else.

`canvas/model.js` holds **one** WebGL context for the whole app and blits it into
each card's 2D canvas; browsers cap contexts around sixteen and a panning board
would spend them all. Model cards are stored as self-photographed WebP stills
until "Rotate model" hands the geometry back.

### Size and arrangement

`measure.js` sits beside `util`/`geometry` at the bottom — pure, no DOM, no
`state` import. It defines the board's one link to reality: `settings.scale` is
**world units per millimetre**, and `settings.units` only chooses the names the
numbers are dressed in. Geometry never reads either. `canvas/paper.js` draws a
real A4/A3/Letter outline through that scale, and dragging its corners sets the
scale — that is the intended way to set it, not typing a number.

`arrange/arrangements.js` is likewise pure: every arrangement is
`(items, opts) => [{x, y}]` in input order, so a fresh import and "Rearrange
all" share one code path. `spacing` always means edge-to-edge gap; passing a
`seed` is what makes a layout move its slots, so seedless calls stay
reproducible.

### Assets and persistence

Items never hold a Blob or URL, only `asset: { hash, embedded: true }`.
`storage/assets.js` is the hash → bytes registry, which is what makes
dedupe-by-content free. `storage/zip.js` is a hand-rolled ZIP over the browser's
own `CompressionStream('deflate-raw')`; `storage/mbrd.js` is the `.mbrd`
container on top of it (`docs/mbrd-format.md` is the spec).

`storage/storage.js` keeps Save and Export deliberately separate: Save writes to
IndexedDB (same store as the autosave interval), Export packs the `.mbrd` file
via the File System Access API where available. They fail differently, and the
UI says which is which. Any path that can replace the current board must go
through the discard confirmation. `storage/idb.js` is the whole IndexedDB
surface — two stores, `kv` for the board snapshot and `assets` for Blobs by
hash — and it is crash recovery only. The durable artefact is always the `.mbrd`
the user saved.

`optimize/` is loaded by dynamic `import()` and never runs on its own — it is a
button. Nothing in it fires on import, on save or on a timer; it says what it is
about to do first, and originals stay under `meta.was` so the undo is real. It
touches only what it can make meaningfully smaller (`WORTH_IT` in
`optimize.js`), which is why it is allowed to be lossy at all. The browser does
the work: pictures through `picture.js`, sound through `opus.js`. Video is
deliberately left alone — a wasm encoder pins a core for the length of the clip
— so `optimize/media.js` is down to one job, pulling a first frame out of a clip
no browser here can decode (H.265 from a phone), and that is the one path that
needs ffmpeg.

`import/budget.js` is the importer's memory boundary and the only one: the
500-file cap in `import/drop.js` is a UX guard, not a limit on bytes, since one
50 KB PNG can claim 30000×30000 and cost gigabytes at `createImageBitmap()`.
New import paths take `IMPORT_LIMITS` and a byte budget, not a file count.

### Three things that reach outside

Everything else in mbrd renders the same with the network off, and opening a
board tells nobody. Three modules are the exceptions and each is built so the
exception is a choice:

`canvas/embed.js` is the only code that talks to a third party — a link card
becomes a YouTube or Spotify player per click, never by default, because loading
an embed tells someone else's server what is on this board. `ui/fonts.js` takes
a dropped `.woff2` into the type menus and inside the `.mbrd` as an asset rather
than fetching a face, so a board keeps its look when it is sent to someone else.
The family name there is *rebuilt* from the filename, never taken — it lands
inside a CSS declaration.

`optimize/media.js` is the third and the only one that fetches: the ffmpeg core
lives at jsdelivr and is pulled on first use, since thirty megabytes is not
something to ship in the shell. Nothing about a board is sent — only the request
for the core — and it is the one thing in `optimize/` deliberately absent from
`SHELL` in `web/sw.js`, so video posters are the single feature that degrades
offline until the core has been fetched once. Everything there fails to "no
poster", never to a broken card, and the dialog says which case it is in.

### Look

Every colour, radius and spacing value is a CSS custom property in `tokens.css`;
`ui/appearance.js` writes them onto `:root`. `settings.appearance.vars` is the
only part of a board that reaches the browser as *code*, so it is filtered
through the `TOKENS` allowlist in `ui/look.js` — keep it that way.
`ui/pigments.js` derives whole palettes in OKLCh from board pictures (48×48
canvas, nothing uploaded) and repairs contrast afterwards.

CSS is three files and no more: `tokens.css` (the properties), `fonts.css` (the
bundled `@font-face` set) and `app.css` — one large stylesheet in load order, so
a new rule goes next to the subsystem it styles rather than into a new file the
service worker's `SHELL` would have to learn about.

## Invariants the tests enforce

- **No browser globals at import time.** Reaching for `document` inside a
  function is fine; reaching for it in a module body is not. The only exceptions
  are `main.js`, `ui/appearance.js` and `optimize/media-worker.js`, listed in
  `tests/imports.test.js`. Adding a fourth is a regression.
- **Every shipped asset appears in `SHELL` in `web/sw.js`** (`tests/sw.test.js`).
  That list drifted once and left a font uncached offline.
- **The layering graph is executable** (`tests/layers.test.js`), not advice.
- **Every bundled `woff2` family has its licence file beside it**
  (`tests/fonts-license.test.js`). Geist shipped without one for several
  versions; the OFL requires it.
- `web/sw.js`'s `VERSION` and `web/assets/js/version.js` are bumped by regex in
  `save.bat` — do not hand-edit or reformat those lines.
- `web/assets/js/import/formats.js` is generated. Regenerate it, never edit it.

Tests are not a substitute for looking: for canvas or storage changes, launch
the app and exercise pan/zoom, selection, save/open, refresh recovery and the
browser console. Call out `.mbrd` schema, generated-catalog or service-worker
cache changes explicitly.

## Notes

`PLAN.md` is the full design; `research/` holds the reasoning behind past
decisions, and its top level is deliberately short — only work that is still
open. One document lives there now: the scalability/readability audit, whose
status header is current — all eight of its leverage items are closed, including
the `state.js` split, and what remains is the medium/low findings it lists. Anything carried out moves to
`research/old/` — that is where the Safari audit and its fixes, the Mobile
scroll pair, the sidebar rebuild, the ghost-cards plan, the pan/zoom performance
plan and `REFACTOR.md` are. `research/future/` is the not-yet-started pile
(Tauri readiness, and the LOD proxy and memory budget the perf plan left gated
on an on-device measurement). `docs/` holds three
references worth reading before touching their subsystems: `docs/mbrd-format.md`
and `docs/layout-settings.md` are the specs, `docs/browser-support.md` records
the browser floor. `window.mbrd` is a deliberate console handle (`mbrd.board`,
`mbrd.cmds.fit()`, `mbrd.vp`).

`tools/` has two scripts: `gen-formats.mjs` regenerates the generated
`import/formats.js` (regenerate, never hand-edit); `preset-oklch.mjs` reads
`tokens.css` and prints the OKLCh ranges the `SHEET`/`PIGMENT` tables in
`ui/pigments.js` were built from — analysis only, writes nothing.

Module headers in this codebase carry the *why*, often at length — read the top
of a file before changing it, and keep that convention when adding one.
