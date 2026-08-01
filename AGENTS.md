# Repository Guidelines

## Project Structure & Module Organization

`web/` is the browser application and static document root. Entry files (`index.html`, `manifest.json`, `sw.js`, and `404.html`) sit at its top level. Styles live in `web/assets/css/`; JavaScript is split by responsibility under `web/assets/js/`, including `canvas/`, `import/`, `arrange/`, `storage/`, and `ui/`. Images and bundled fonts are under `web/assets/img/` and `web/assets/fonts/`.

Dependencies run one way: `util`/`geometry` ← `state` ← {`import`, `storage`, `canvas`} ← `ui`, with `canvas` reaching into `import` only for the generated format catalog. Anything that builds an item's DOM belongs under `canvas/` — that is why `renderers.js`, `notes.js` and `audio.js` live there. Keep that direction; a `ui/` module imported from `canvas/` is a layering regression, and `tests/layers.test.js` enforces the graph rather than merely describing it.

The bottom of the graph is wider than `util`/`geometry`. `measure.js`, `mesh.js`, `web-graph.js`, `arrange/arrangements.js`, `import/budget.js` and `canvas/spatial.js` are pure — no DOM, no `state` import — and stay that way. Six more are what `state.js` was split onto: `board-store.js`, `board-model.js`, `history.js`, `sticky.js`, `layout.js` and `stacking.js`. `state.js` re-exports all six under their old names, so nothing imports them directly, and none of them may import `state.js` back.

`serve.py` provides the local threaded server and SPA fallback; `qr.py` beside it holds the terminal QR encoder. `server.bat` is the Windows launcher. `tools/gen-formats.mjs` regenerates the committed format catalog. Design and implementation notes are in `PLAN.md` and `research/`, whose top level holds only work that is still open — anything carried out moves to `research/old/` (`REFACTOR.md` is there), and `research/future/` is the not-yet-started pile. `docs/` holds the `.mbrd` and layout-settings specs and the browser floor.

## Build, Test, and Development Commands

There is no dependency installation, bundler, or build step for the application. `package.json` exists only to run the tests and declares no dependencies.

- `server.bat` — start the development server and open the app at `http://localhost:6273`.
- `python serve.py [port]` — equivalent direct server command; edits appear after refresh.
- `node tools/gen-formats.mjs [path-to-file-analyser]` — rebuild `web/assets/js/import/formats.js` from the sibling catalog.
- `save.bat` — bump application and service-worker versions, then optionally commit and push. Review its proposed changes before confirming.

## Coding Style & Naming Conventions

Match the existing style: two-space indentation in JavaScript and CSS, four spaces in Python, semicolons in JavaScript, and single-quoted strings where practical. Use ES modules with explicit relative imports. Prefer `camelCase` for variables and functions, `PascalCase` for classes, and uppercase constants such as `MIN_ZOOM`. Keep modules focused on their current subsystem. Use CSS custom properties from `tokens.css` instead of duplicating visual values. Do not hand-edit generated `import/formats.js`.

## Testing Guidelines

Run `npm test` — Node's built-in runner over `tests/`, no install required. It covers the pure logic: the ZIP container and its hardening, the `.mbrd` sidecars, board state and undo, the clipboard, the sticky relation, geometry, the arrangement engine, and the grid. Two structural tests earn their keep in particular: every module must import without a browser (so the suite stays possible), and every shipped asset must appear in the service worker's `SHELL` (that list drifted silently once and left Geist uncached offline).

Tests are not a substitute for looking. Launch the app and exercise the affected workflow in a modern browser too. For canvas or storage changes, check pan/zoom, selection, save/open, refresh recovery, and browser-console errors as relevant. Verify responsive or touch-facing changes using the LAN URL when possible.

## Commit & Pull Request Guidelines

Recent history favors short, descriptive, imperative or outcome-focused subjects (for example, `Drag a link in from another tab`); release commits use tags such as `v0.18`. Keep each commit scoped to one coherent change.

Pull requests should explain the user-visible result, list manual verification performed, and link related issues or design notes. Include screenshots or a short recording for UI changes. Call out `.mbrd` schema, generated-catalog, or service-worker cache changes explicitly.
