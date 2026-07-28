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
module imported from `canvas/` is a layering regression. Anything that builds an
item's DOM belongs under `canvas/` — that is why `renderers.js`, `notes.js`,
`audio.js` and `model.js` live there rather than under `import/` or `ui/`.

### state.js is the only door

Every board mutation goes through `state.js`, which emits on a shared `bus`
(`items`, `geom`, `item`, `selection`, `settings`, `layout`, `board`,
`board:load`, `trash`, `history`). Subsystems subscribe; they never call each other.
Undo/redo is command-based — `commit(label, redo, undo)` — so a new mutating
operation must push its own inverse rather than relying on a diff.

`main.js` is the wiring point: it builds the `Viewport`, calls every `init*()`,
and owns `cmds`, the single command surface that sidebar buttons
(`data-cmd="…"`), the keyboard and the context menu all drive. A new user-facing
action is an entry in `cmds`, not a second event listener.

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
`<img>`/`<video>`/`<audio>` keep working. The grid is painted in *screen* space
as CSS gradients on `#viewport`, which is why it stays hairline-crisp at any
zoom — and why it repaints on every view change.

`canvas/items.js` culls: nodes outside the viewport (plus `CULL_MARGIN`) are
detached, then either kept (media mid-playback, so a video survives leaving the
screen) or discarded. Assume an item's node may not be in the DOM;
`ensureMounted(id)` is the way in.

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
IndexedDB (same store as the autosave debounce), Export packs the `.mbrd` file
via the File System Access API where available. They fail differently, and the
UI says which is which. Any path that can replace the current board must go
through the discard confirmation.

`optimize/` is loaded by dynamic `import()` and never runs on its own — it is a
button. Originals stay under `meta.was` so the undo is real.

### Look

Every colour, radius and spacing value is a CSS custom property in `tokens.css`;
`ui/appearance.js` writes them onto `:root`. `settings.appearance.vars` is the
only part of a board that reaches the browser as *code*, so it is filtered
through the `TOKENS` allowlist in `ui/look.js` — keep it that way.
`ui/pigments.js` derives whole palettes in OKLCh from board pictures (48×48
canvas, nothing uploaded) and repairs contrast afterwards.

## Invariants the tests enforce

- **No browser globals at import time.** Reaching for `document` inside a
  function is fine; reaching for it in a module body is not. The only exceptions
  are `main.js`, `ui/appearance.js` and `optimize/media-worker.js`, listed in
  `tests/imports.test.js`. Adding a fourth is a regression.
- **Every shipped asset appears in `SHELL` in `web/sw.js`** (`tests/sw.test.js`).
  That list drifted once and left a font uncached offline.
- `web/sw.js`'s `VERSION` and `web/assets/js/version.js` are bumped by regex in
  `save.bat` — do not hand-edit or reformat those lines.
- `web/assets/js/import/formats.js` is generated. Regenerate it, never edit it.

Tests are not a substitute for looking: for canvas or storage changes, launch
the app and exercise pan/zoom, selection, save/open, refresh recovery and the
browser console. Call out `.mbrd` schema, generated-catalog or service-worker
cache changes explicitly.

## Notes

`PLAN.md` is the full design; `research/` holds the reasoning behind past
decisions (`research/old/REFACTOR.md`, plus dated audits — the Safari,
scalability and Tauri-readiness ones are the recent ones). `docs/` holds three
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
