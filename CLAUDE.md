# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Read these first

- **[`docs/architecture.md`](docs/architecture.md)** — the canonical description
  of how the app is put together: the layering graph, `state.js` as the only
  door, the command surface, coordinates and culling, the two layouts, assets
  and persistence, the stylesheet order, and the invariants the tests enforce.
  It is the single source of truth; this file does not repeat it.
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — how to run it, how to test it, the
  five invariants that are easy to break by accident, and where a given kind of
  change belongs.
- **[`AGENTS.md`](AGENTS.md)** — style, naming, commit and PR conventions.

Module headers in this codebase carry the *why*, often at length. **Read the top
of a file before changing it**, and keep that convention when adding one.

## Commands

```bash
npm test                          # node --test over tests/ — no install, no deps; Node 22+
node --test tests/state-history.test.js                            # one file
node --test --test-name-pattern "undo" tests/state-history.test.js # one test
python tools/serve.py [port]      # dev server on 6273; server.bat is the Windows launcher
node tools/gen-formats.mjs [path-to-file-analyser]   # regenerate import/formats.js
save.bat                          # bump version stamps, commit, optionally push
```

Three optional runs, all needing `npm install` first (three devDependencies —
`npm test` still needs none). There is no CI, so nothing runs these for you and
a green `npm test` is not the whole bar:

```bash
npm run lint        # oxlint, correctness only — no formatter, and adding one is a regression
npm run typecheck   # tsc --noEmit over JSDoc; jsconfig.json scopes it to the pure layer
npm run test:e2e    # Playwright on 6274; also needs `npx playwright install chromium`
```

Syntax checks worth running on a change: `node --check` on touched `.js`,
`python -m py_compile` on `tools/serve.py` / `tools/qr.py`. Nothing runs these
automatically, so a syntax error in a module no test imports reaches a browser
before it reaches a failure.

There is no bundler, no build step and no runtime dependency. The browser loads
the ES modules under `web/` directly — an edit is one refresh away.
`package.json` exists only to run the tests; nothing in `tests/` is served.

## Things worth saying twice

- **Do not edit `web/assets/js/version.js` or the `VERSION` line in
  `web/sw.js`.** `save.bat` stamps both by regex; reformatting either line
  breaks the stamp silently.
- **No apostrophes anywhere inside the `SHELL` array in `web/sw.js`**, comments
  included. `tests/sw.test.js` reads that list by pulling out single-quoted
  runs, so one apostrophe in a comment there breaks it.
- **Do not hand-edit `web/assets/js/import/formats.js` or
  `web/assets/stickers.svg`.** Both are generated — `tools/gen-formats.mjs` and
  `tools/gen-stickers.mjs`. The sticker sprite is vendored Phosphor art at a
  pinned revision; the shapes it carries are chosen in the generator's own
  `SHAPES` table, and everything *about* them (names, categories, default
  tints) is hand-written in `web/assets/js/stickers/catalogue.js`, which is not
  generated. Adding a shape is one entry in each, then re-run the generator.
- **Do not split `canvas/input.js`.** One pipeline, exactly one active gesture.
- **A new module must not touch `document` at import time** — export an
  `init*()`. Exactly three modules are exempt and `tests/imports.test.js` lists
  them.
- **A new user-facing action is an entry in `cmds`** (`commands.js`), not a
  second event listener. A new setting is one entry in `ui/settings-schema.js`.
  A new toolbar tool is a `<button data-cmd>` in `index.html` plus that entry.
  A new file type is a branch in `classify()` plus an entry in `RENDERERS`,
  both in `canvas/renderers.js`. A new arrangement is a pure
  `(items, opts) => [{x, y}]` in `arrange/arrangements.js`.
- **Icons are `<symbol>`s in `web/assets/icons.svg`, reached by name** —
  `<use href="assets/icons.svg#i-note">`. A misspelled id fails silently: no
  console warning, no failed request, just a hole where the icon was.
  `tests/icons.test.js` checks the references against the sprite and the sprite
  against the references.
- **`state.js` is the only door, and it is being split downward.** The base
  layer under it — `board-store.js`, `board-model.js`, `history.js`,
  `sticky.js`, `fences.js`, `layout.js`, `stacking.js`, `web-graph.js`,
  `web-route.js` — may never import `state.js` back. That one-way edge is the
  whole reason they are separate files: a concern lifted out of `state.js` only
  stays out if what it stands on is lower than what it left.
  `tests/layers.test.js` holds the list.
- **The hand-written binary readers parse files the app did not write.**
  `storage/zip.js`, `mesh.js`, `import/artwork.js` and `optimize/opus.js` all
  bounds-check before they allocate, and their tests are largely about
  malformed input. A change near them wants a test that feeds it something
  broken.
- **`#toolbar` must stay before `#nowplaying` in `index.html`.** The rules that
  step the player up a tier when the phone's toolbar opens are general sibling
  combinators, which only look forward. Reordering the two breaks the layout
  silently and only on a phone.
- **Import paths are case-sensitive on the deployed host and not on this
  machine.** Windows resolves `'./Foo.js'` for `foo.js` happily; the Pages
  demo, served off a Linux filesystem, 404s. There is no CI leg to catch it
  either — match the filename exactly.
- Call out `.mbrd` schema, generated-catalog or service-worker cache changes
  explicitly when reporting work.

## Where the reasoning lives

`docs/` holds the specifications: [`mbrd-format.md`](docs/mbrd-format.md),
[`layout-settings.md`](docs/layout-settings.md),
[`browser-support.md`](docs/browser-support.md).

`research/` holds why things are the way they are, in three tiers — open work at
the top level, carried-out work in `old/`, speculative work in `future/`. See
[`research/README.md`](research/README.md); nothing in `old/` is authoritative,
and if it disagrees with the code, the code is right.

`window.mbrd` is a deliberate console handle (`mbrd.board`, `mbrd.cmds.fit()`,
`mbrd.vp`).
