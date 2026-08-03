# Contributing to mbrd

mbrd has no dependencies, no bundler and no build step. The browser loads the ES
modules under `web/` directly, so an edit is one refresh away. That is the
project's one real property, and most of what follows exists to keep it true.

Please read [`docs/architecture.md`](docs/architecture.md) before a first
change. It is the one canonical description of how the app is put together; this
file is only about working on it.

---

## Run it

```bash
python serve.py            # dev server on http://localhost:6273
python serve.py 8000       # or any port
```

Python 3 with no packages. `serve.py` is a static server with three behaviours
`python -m http.server` does not have: `web/` as the document root, an SPA
fallback so a deep link does not 404, and threading — without it the service
worker's background revalidation fetches deadlock. It binds `0.0.0.0` and prints
a QR for the LAN URL, so a phone on the same Wi-Fi opens the same board.

On Windows, `server.bat` is a convenience wrapper around exactly that.

No `npm install` to run the app or its tests. `package.json` declares no runtime
dependencies at all, and its three devDependencies are for the optional lint,
typecheck and end-to-end runs below — `npm test` uses Node's own runner and needs
nothing fetched. **Node 22 or newer**: the test script hands `node --test` a
glob, and Node only expands one itself from 21 onwards.

## Test it

```bash
npm test                                                          # everything
node --test tests/state-history.test.js                           # one file
node --test --test-name-pattern "undo" tests/state-history.test.js  # one test
```

Node's built-in runner over `tests/`. It covers the pure logic: the ZIP
container and its hardening, the `.mbrd` sidecars, board state and undo, the
clipboard, the sticky relation, geometry, the arrangement engine, the grid.

Worth running on any change you touched: `node --check` on each changed `.js`,
and `python -m py_compile serve.py qr.py` if you touched either.

### Three optional runs

None is needed to contribute, and `npm test` still needs no install at all.
All three want `npm install` first, which pulls exactly three devDependencies.

```bash
npm run lint        # oxlint; correctness only, no formatter
npm run typecheck   # tsc --noEmit over JSDoc types; no TypeScript ships
npm run test:e2e    # Playwright; also needs `npx playwright install chromium`
```

`npm run lint` is deliberately about mistakes and not about taste — unused
things, undefined things, `let` that should be `const`, `==` that should be
`===`. See the header of `.oxlintrc.json`. **There is no formatter, and adding
one would be a regression**: Prettier would rewrite all 31,000 lines and destroy
the blame that makes this codebase's module headers worth having.

`npm run typecheck` is the answer to the one thing hand-written JavaScript
genuinely lacks. Nothing is compiled and nothing is emitted - `jsconfig.json`
points tsc at the **pure layer** (geometry, measurement, the arrangement engine,
quality, the layout split, the thread graph, the spatial grid, the import
budget) and it reads types out of JSDoc. Widening that `include` is how it
grows; do it a module at a time with the run clean at each step. It earned its
keep immediately: it found `web-graph.js` calling two `geometry.js` helpers it
had never imported, which threw out of `threads()` and stopped the relationship
web drawing.

`npm run test:e2e` covers the four things a headless unit test structurally
cannot see: pan and zoom, add/select/delete/undo, save → refresh → recover, and
that the app **boots with a clean console**. That last one is the cheapest real
safety net in the repository - every module resolving is not the same as every
module running.

**Tests are not a substitute for looking.** Launch the app and exercise the
affected workflow. For canvas or storage changes that means pan/zoom, selection,
save/open, refresh recovery and the browser console. For anything responsive or
touch-facing, use the LAN URL on a real phone.

---

## Five invariants you can break by accident

Each of these is enforced by a test, because each has actually gone wrong at
least once. If one fails, it is telling you something structural, not being
fussy.

1. **The layering graph is executable.** `util`/`geometry` ← `state` ←
   {`import`, `storage`, `canvas`} ← `ui`. A `ui/` module imported from
   `canvas/` is a regression, not a style note. Enforced by
   `tests/layers.test.js`, which also lists the base layer — the modules
   `state.js` was split onto may never import `state.js` back.
2. **No browser globals at module import time.** Reaching for `document` inside
   a function is fine; reaching for it in a module body is not, because it makes
   the module untestable headlessly. Exactly three modules are exempt —
   `main.js`, `ui/appearance.js`, `optimize/media-worker.js` — and adding a
   fourth is a regression. Enforced by `tests/imports.test.js`. In practice this
   means a new module exports an `init*()` rather than doing work on import.
3. **Every shipped asset appears in `SHELL` in `web/sw.js`.** That list drifted
   once and left a font uncached offline. Enforced by `tests/sw.test.js`, which
   walks `assets/js`, `assets/css` and `assets/fonts`. Note the constraint in
   that file's comment: **no apostrophes inside the `SHELL` array**, comments
   included, because the test parses it by pulling out single-quoted runs.
4. **Every bundled `woff2` family has its licence file beside it.** The OFL
   requires it and Geist shipped without one for several versions. Enforced by
   `tests/fonts-license.test.js`. A new face also means a row in
   `THIRD-PARTY.md`.
5. **`web/assets/js/import/formats.js` is generated.** Regenerate it with
   `node tools/gen-formats.mjs`; never hand-edit it.

One more that no test can catch: **do not edit `VERSION` / `COMMIT_COUNT` in
`web/assets/js/version.js`, or the `VERSION` line in `web/sw.js`.** Those are
stamped at release time by `save.bat`, which matches them by regex — reformatting
either line breaks the stamp silently. Your pull request should not touch them
at all; the maintainer bumps on merge.

---

## Style

Match what is around you. Concretely: two-space indent in JavaScript and CSS,
four in Python; semicolons; single quotes where practical; ES modules with
explicit relative imports; `camelCase` for values and functions, `PascalCase`
for classes, `UPPER_SNAKE` for constants like `MIN_ZOOM`. Use the custom
properties in `tokens.css` rather than duplicating a visual value.

**Module headers carry the *why*, often at length.** This is the single biggest
reason a stranger can work on this codebase, and it is an expectation for new
modules, not a habit of old ones. Say what the module is for, what it must not
do, and what was tried and rejected. Read the top of a file before changing it.

---

## Where a change goes

The architecture doc has the full map; these are the four places most changes
land, and none of them require touching anything else:

| you want to add | you edit |
| --- | --- |
| a new arrangement | `arrange/arrangements.js` — a pure `(items, opts) => [{x, y}]` in input order |
| support for a new file type | a branch in `classify()` plus an entry in `RENDERERS`, both in `canvas/renderers.js` |
| a setting | one entry in `ui/settings-schema.js` — id, tab, section, type, `get`/`set` |
| a user-facing action | one entry in `cmds` (`commands.js`), which the sidebar, toolbar, keyboard and context menu all drive |
| a tool on the toolbar | a `<button data-cmd="…">` in `index.html`, plus the `cmds` entry above. `data-desktop` keeps it off the phone's tier, `data-phone` off every other width |

Two things not to do, both of which look like improvements:

- **Do not split `canvas/input.js`.** It is one Pointer Events pipeline with
  exactly one active gesture (`g`), for mouse, pen and touch together. A second
  finger always wins and converts a drag into a pinch. Splitting it reintroduces
  precisely the class of bug that single-`g` design exists to prevent. Its
  header carries the full gesture map — read it before adding a binding.
- **Do not add a runtime dependency.** A new format is a few hundred lines of
  header reading in the same style as `mesh.js` or `import/artwork.js`, not an
  npm package. `storage/zip.js` inflates its own entries; `ui/pigments.js` does
  its own OKLCh. Dev-only tooling in `package.json` is a separate question and
  is fine to propose — there are three, all optional, and `npm test` still runs
  without any of them.

Three modules reach outside the machine, and each is built so that reaching out
is a choice the user makes: `canvas/embed.js` (a link card becomes a player per
click, never by default), `ui/fonts.js` (a dropped `.woff2` is embedded, never
fetched), and `optimize/media.js` (the ffmpeg core, on first use only). Adding a
fourth needs a good argument in the pull request.

---

## Commits and pull requests

Short, descriptive, imperative or outcome-focused subjects — `Drag a link in
from another tab` is the house style. Keep each commit to one coherent change.

A pull request should say what the **user-visible result** is, list the manual
verification you actually performed, and include a screenshot or short recording
for anything visual. Call out explicitly if you changed the `.mbrd` schema, the
generated format catalog, or the service worker's `SHELL` — those three have
consequences beyond the diff.

CI runs the suite on Linux and Windows. The Linux run matters more than it
looks: this codebase was developed on a case-insensitive filesystem, so an
import path with the wrong case works locally and 404s in CI.

---

## The part that is worth being careful about

The app hand-parses ZIP, STL/OBJ/GLB, ID3/MP4/FLAC and Ogg out of files it did
not write, and `.mbrd` is a file that arrives from outside. Every one of those
readers bounds-checks before it allocates, and `tests/zip.test.js`,
`tests/mesh.test.js` and `tests/mbrd.test.js` are largely about malformed input
rather than about correct input. A change anywhere near them wants a test that
feeds it something broken.
