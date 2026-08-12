# Contributing to mbrd

mbrd has no runtime dependencies and ships no framework. It is written in
TypeScript and builds to one bundle: `npm run dev` watches and rebuilds, so an
edit is a save and a refresh. The property most of what follows exists to keep
true is the one underneath that — **`npm test` needs no install**, on a clean
clone, with nothing fetched.

Please read [`research/docs/architecture.md`](research/docs/architecture.md) before a first
change. It is the one canonical description of how the app is put together; this
file is only about working on it.

---

## Run it

```bash
python tools/serve.py      # dev server on http://localhost:6273
python tools/serve.py 8000 # or any port
```

Python 3 with no packages. `tools/serve.py` is a static server with three behaviours
`python -m http.server` does not have: `web/` as the document root, an SPA
fallback so a deep link does not 404, and threading — without it the service
worker's background revalidation fetches deadlock. It binds `0.0.0.0` and prints
a QR for the LAN URL, so a phone on the same Wi-Fi opens the same board.

On Windows, `server.bat` is a convenience wrapper around exactly that.

`package.json` declares no runtime dependencies at all, and its three
devDependencies are for the lint, the typecheck and the build below. `npm test`
uses Node's own runner and needs nothing fetched. **Node 22.18 or newer**, and
the floor is exact rather than cautious: Node strips TypeScript types natively
from 22.18, which is the whole reason the suite still runs on a clean clone with
nothing installed.

Running the *app* does need one build — the browser cannot fetch a `.ts` module,
so `npm run build` (or `npm run dev` to watch) writes the bundle `index.html`
actually loads. The built artifact is committed, so a clone can be served as-is;
you only need the build once you have changed something.

## Test it

```bash
npm test                                                          # everything
node --test tests/state-history.test.js                           # one file
node --test --test-name-pattern "undo" tests/state-history.test.js  # one test
```

Node's built-in runner over `tests/`. It covers the pure logic: the ZIP
container and its hardening, the `.mbrd` sidecars, board state and undo, the
clipboard, the sticky and fence relations, geometry, the arrangement engine, the
grid.

Worth running on any change you touched: `npm run typecheck`, which is what
`node --check` used to be for now that the modules are TypeScript, and
`python -m py_compile tools/serve.py tools/qr.py` if you touched either. CI runs
both, plus a parse of every committed module and a build of the bundle.

### Two optional runs

Neither is needed to contribute, and `npm test` still needs no install at all.
Both want `npm install` first, which pulls exactly three devDependencies -
oxlint, typescript and esbuild. Only the third produces anything, and what it
produces is the bundle.

```bash
npm run lint        # oxlint; correctness only, no formatter
npm run typecheck   # tsc --noEmit under strict; nothing is emitted
npm run build       # esbuild -> web/assets/app.js, the artifact that ships
npm run dev         # the same build, watched. This is the edit loop now.
```

`npm run lint` is deliberately about mistakes and not about taste — unused
things, undefined things, `let` that should be `const`, `==` that should be
`===`. See the header of `.oxlintrc.json`. **There is no formatter, and adding
one would be a regression**: Prettier would rewrite all 31,000 lines and destroy
the blame that makes this codebase's module headers worth having.

`npm run typecheck` is the answer to the one thing hand-written JavaScript
genuinely lacks, and it is no longer answered with JSDoc: the app is TypeScript,
`tsconfig.json` runs tsc `--noEmit` under **strict** over the whole tree, and
esbuild - not tsc - builds what ships.

Not every module is annotated yet. The rename moved 104 files in one step and
the ones still untyped carry `// @ts-nocheck`; `tests/ts-debt.test.js` holds the
count with a ceiling that may only fall. So a green typecheck means *everything
not on that list is clean under strict*. Converting a module is deleting its
pragma, fixing what tsc then says, and lowering the ceiling in the same commit.
Do it a module at a time with the run clean at each step. Its ancestor earned
its keep immediately: it found `web-graph.ts` calling two `geometry.ts` helpers it
had never imported, which threw out of `threads()` and stopped the relationship
web drawing.

There is no browser-driven suite. The four things a headless unit test
structurally cannot see — pan and zoom, add/select/delete/undo, save → refresh →
recover, and that the app **boots with a clean console** — are yours to check by
launching it. The console is the cheapest of the four and the one worth making a
habit: every module resolving is not the same as every module running.

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
   `state.ts` was split onto may never import `state.ts` back.
2. **No browser globals at module import time.** Reaching for `document` inside
   a function is fine; reaching for it in a module body is not, because it makes
   the module untestable headlessly. Exactly three modules are exempt —
   `main.ts`, `ui/appearance.ts`, `optimize/media-worker.js` — and adding a
   fourth is a regression. Enforced by `tests/imports.test.js`. In practice this
   means a new module exports an `init*()` rather than doing work on import.
   (The worker keeps its `.js`: it is fetched by URL at runtime rather than
   imported, and a browser cannot fetch a `.ts` file.)
3. **Every shipped asset appears in `SHELL` in `web/sw.js`.** That list drifted
   once and left a font uncached offline. Enforced by `tests/sw.test.js`, which
   walks `assets/css` and `assets/fonts` — and no longer `assets/js`, because
   the modules are not what ships any more. The bundle is, and it is asserted by
   name alongside the media worker. Note the constraint in
   that file's comment: **no apostrophes inside the `SHELL` array**, comments
   included, because the test parses it by pulling out single-quoted runs.
4. **Every bundled `woff2` family has its licence file beside it.** The OFL
   requires it and Geist shipped without one for several versions. Enforced by
   `tests/fonts-license.test.js`. A new face also means a row in
   `THIRD-PARTY.md`.
5. **`web/assets/js/import/formats.ts` is generated.** Regenerate it with
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
| a new arrangement | `arrange/arrangements.ts` — a pure `(items, opts) => [{x, y}]` in input order |
| support for a new file type | a branch in `classify()` plus an entry in `RENDERERS`, both in `canvas/renderers.ts` |
| a setting | one entry in `ui/settings-schema.ts` — id, tab, section, type, `get`/`set` |
| a user-facing action | one entry in `cmds` (`commands.ts`), which the sidebar, toolbar, keyboard and context menu all drive |
| a tool on the toolbar | a `<button data-cmd="…">` in `index.html`, plus the `cmds` entry above. `data-desktop` keeps it off the phone's tier, `data-phone` off every other width |

Two things not to do, both of which look like improvements:

- **Do not split `canvas/input.ts`.** It is one Pointer Events pipeline with
  exactly one active gesture (`g`), for mouse, pen and touch together. A second
  finger always wins and converts a drag into a pinch. Splitting it reintroduces
  precisely the class of bug that single-`g` design exists to prevent. Its
  header carries the full gesture map — read it before adding a binding.
- **Do not add a runtime dependency.** A new format is a few hundred lines of
  header reading in the same style as `mesh.ts` or `import/artwork.ts`, not an
  npm package. `storage/zip.ts` inflates its own entries; `ui/pigments.ts` does
  its own OKLCh. Dev-only tooling in `package.json` is a separate question and
  is fine to propose — there are three, all optional, and `npm test` still runs
  without any of them.

Three modules reach outside the machine, and each is built so that reaching out
is a choice the user makes: `canvas/embed.ts` (a link card becomes a player per
click, never by default), `ui/fonts.ts` (a dropped `.woff2` is embedded, never
fetched), and `optimize/media.ts` (the ffmpeg core, on first use only). Adding a
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

CI runs the suite, the lint, the typecheck and a parse of every committed module
on every push and pull request. It runs on `ubuntu-latest`, which is the point
rather than a default: this codebase was developed on a case-insensitive
filesystem, so an import path with the wrong case works locally and 404s on the
Pages demo, which serves off a case-sensitive one. A Linux runner is what turns
that into a red run instead of a broken page.

One thing it is not, said plainly: the production host runs `npx wrangler
deploy` on every push to main, triggered by the push rather than by the
workflow. The two run alongside each other and neither waits, so a push that
breaks the app still deploys the broken app. Making a red run block the deploy
needs branch protection with this job as a required status check, which lives in
GitHub's repository settings and cannot be committed as a file. Until somebody
sets that, CI is a smoke alarm and not a lock — so still run the suite before
you push.

---

## The part that is worth being careful about

The app hand-parses ZIP, STL/OBJ/GLB, ID3/MP4/FLAC and Ogg out of files it did
not write, and `.mbrd` is a file that arrives from outside. Every one of those
readers bounds-checks before it allocates, and `tests/zip.test.js`,
`tests/mesh.test.js` and `tests/mbrd.test.js` are largely about malformed input
rather than about correct input. A change anywhere near them wants a test that
feeds it something broken.
