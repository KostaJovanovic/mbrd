# Repository Guidelines

Conventions for working in this repository. **Structure and design live in
[`docs/architecture.md`](docs/architecture.md)** — the layering graph, the state
model, coordinates and culling, the stylesheet order, the invariants — and are
not repeated here. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers running, testing
and where a given change belongs.

## Project layout, briefly

`web/` is the browser application and the static document root. Entry files
(`index.html`, `manifest.json`, `sw.js`) sit at its top level;
styles are in `web/assets/css/` and JavaScript under `web/assets/js/`, split by
responsibility into `canvas/`, `import/`, `arrange/`, `storage/`, `ui/`,
`optimize/` and `perf/`.

`tools/` holds the development scripts. `tools/serve.py` is the local threaded
server; an address it does not have gets `index.html` back under a 404 status,
because the app is its own 404 page and there is no separate error document.
`tools/qr.py` beside it holds the terminal QR encoder, and
`tools/gen-formats.mjs` regenerates the committed format catalog. `server.bat`
at the repo root is the Windows launcher.

## Build, test and development commands

There is no dependency installation, bundler or build step for the application.
`package.json` exists only to run the tests and declares no dependencies.

- `python tools/serve.py [port]` — dev server on 6273; edits appear after refresh.
- `server.bat` — the same thing, on Windows, plus the LAN QR.
- `npm test` — Node's built-in runner over `tests/`, no install required.
- `node tools/gen-formats.mjs [path-to-file-analyser]` — rebuild
  `web/assets/js/import/formats.js` from the sibling catalog.
- `save.bat` — bump version stamps, then commit and optionally push. Review its
  proposed changes before confirming. **Maintainer only**: a contribution never
  touches the two stamped lines.

## Coding style and naming

Two-space indentation in JavaScript and CSS, four spaces in Python; semicolons
in JavaScript; single-quoted strings where practical. ES modules with explicit
relative imports. `camelCase` for variables and functions, `PascalCase` for
classes, uppercase constants such as `MIN_ZOOM`. Keep modules focused on their
current subsystem. Use the CSS custom properties from `tokens.css` rather than
duplicating a visual value.

Module headers carry the *why*, often at length. Read the top of a file before
changing it, and write one when adding a module: what it is for, what it must
not do, and what was tried and rejected.

## Testing

`npm test` covers the pure logic: the ZIP container and its hardening, the
`.mbrd` sidecars, board state and undo, the clipboard, the sticky relation,
geometry, the arrangement engine, the grid. Two structural tests earn their keep
in particular — every module must import without a browser, and every shipped
asset must appear in the service worker's `SHELL` (that list drifted silently
once and left Geist uncached offline).

Tests are not a substitute for looking. Launch the app and exercise the affected
workflow in a modern browser. For canvas or storage changes, check pan/zoom,
selection, save/open, refresh recovery and the browser console. Verify
responsive or touch-facing changes using the LAN URL when possible.

There is no CI; nothing runs on push. One consequence is worth knowing: this
codebase is developed on a case-insensitive filesystem, so a wrong-case import
path resolves locally and 404s on the Pages demo, which is case-sensitive.
Nothing catches that but you.

## Commit and pull request guidelines

History favours short, descriptive, imperative or outcome-focused subjects (for
example, `Drag a link in from another tab`); release commits use tags such as
`v0.18`. Keep each commit scoped to one coherent change.

Pull requests should explain the user-visible result, list manual verification
performed, and link related issues or design notes. Include screenshots or a
short recording for UI changes. Call out `.mbrd` schema, generated-catalog or
service-worker cache changes explicitly.
