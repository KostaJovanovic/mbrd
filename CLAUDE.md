# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Read these first

- **[`research/docs/architecture.md`](research/docs/architecture.md)** — the canonical description
  of how the app is put together: the layering graph, `state.ts` as the only
  door, the command surface, coordinates and culling, the two layouts, assets
  and persistence, the stylesheet order, and the invariants the tests enforce.
  It is the single source of truth; this file does not repeat it.
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — how to run it, how to test it, the
  five invariants that are easy to break by accident, where a given kind of
  change belongs, and the conventions: indentation, quoting and naming under
  *Style*, commit subjects and what a pull request has to say under *Commits and
  pull requests*.

  That last pair used to be an `AGENTS.md` this list linked to, and the link
  outlived the file — it went at v0.156, in the commit that also took the
  Playwright suite out. It is deliberately not coming back: every line it held
  was a second copy of a section of `CONTRIBUTING.md`, and a repository that
  states its conventions in two places is one where they disagree by the end of
  the quarter. The same rule this list opens with — architecture.md is the single
  source of truth and this file does not repeat it — applies to the conventions
  as well.

Module headers in this codebase carry the *why*, often at length. **Read the top
of a file before changing it**, and keep that convention when adding one.

## Commands

```bash
npm test                          # node --test over tests/ — no install, no deps; Node 22+
node --test tests/state-history.test.js                            # one file
node --test --test-name-pattern "undo" tests/state-history.test.js # one test
python tools/serve.py [port]      # dev server on 6273; server.bat is the Windows launcher
node tools/gen-formats.mjs [path-to-file-analyser]   # regenerate import/formats.ts
save.bat                          # bump version stamps, commit, optionally push
```

Two optional runs, both needing `npm install` first (three devDependencies —
`npm test` still needs none). CI runs both on every push and pull request, so
they are no longer only as good as your memory — but a green `npm test` on its
own is still not the whole bar:

```bash
npm run lint        # oxlint, correctness only — no formatter, and adding one is a regression
npm run typecheck   # tsc --noEmit under strict, over the whole tree; nothing is emitted
```

There is no browser-driven suite. `npm test` is the whole automated bar, and it
is a headless one — pan and zoom, drag and marquee, save → refresh → recover and
a clean boot console are checked by launching the app and looking, not by a
runner.

Syntax checks worth running on a change: `node --check` on touched `.js`,
`python -m py_compile` on `tools/serve.py` / `tools/qr.py`. CI now parses every
committed module and both Python tools, which is the catch for a syntax error in
a module no test imports — but it catches it after the push, so running them
here is still faster than finding out from a red run.

There is no runtime dependency, and nothing TypeScript reaches the browser. But
there **is** a build step now: the app is written in TypeScript, a browser
cannot fetch a `.ts` module, and what `index.html` loads is `assets/app.js` —
one bundle esbuild writes. So an edit is `npm run dev` (esbuild watch) and a
refresh, not a refresh alone. The sources still ship beside the bundle; no
source map does. Nothing in `tests/` is served.

`npm test` still needs no install, and that is load-bearing rather than
incidental: Node strips types natively from 22.18, which is why `engines` says
22.18 and not 22, and why `erasableSyntaxOnly` is on in `tsconfig.json`. An
`enum`, a `namespace` or a parameter property would make the whole suite
unrunnable without a loader — tsc refuses them first, so that stays a type
error rather than becoming a broken runner.

## Things worth saying twice

- **Do not edit `web/assets/js/version.js` or the `VERSION` line in
  `web/sw.js`.** `save.bat` stamps both by regex; reformatting either line
  breaks the stamp silently.
- **No apostrophes anywhere inside the `SHELL` array in `web/sw.js`**, comments
  included. `tests/sw.test.js` reads that list by pulling out single-quoted
  runs, so one apostrophe in a comment there breaks it.
- **Do not hand-edit `web/404.html`.** It is `web/index.html` byte for byte —
  the static host's only way to say "the app, with a 404 status", where
  `serve.py` can just set the status. `save.bat` remakes the copy on every
  commit and `tests/notfound.test.js` fails on a single differing byte; the
  setting that makes the file mean anything is `assets.not_found_handling` in
  `wrangler.jsonc`.
- **Do not hand-edit `web/assets/js/import/formats.ts` or
  `web/assets/stickers.svg`.** Both are generated — `tools/gen-formats.mjs` and
  `tools/gen-stickers.mjs`. The sticker sprite is vendored Phosphor art at a
  pinned revision; the shapes it carries are chosen in the generator's own
  `SHAPES` table, and everything *about* them (names, categories, default
  tints) is hand-written in `web/assets/js/stickers/catalogue.ts`, which is not
  generated. Adding a shape is one entry in each, then re-run the generator.
- **Do not split `canvas/input.ts`.** One pipeline, exactly one active gesture.
- **A new module must not touch `document` at import time** — export an
  `init*()`. Exactly three modules are exempt and `tests/imports.test.js` lists
  them.
- **A new user-facing action is an entry in `cmds`** (`commands.ts`), not a
  second event listener. A new setting is one entry in `ui/settings-schema.ts`.
  A new toolbar tool is a `<button data-cmd>` in `index.html` plus that entry.
  A hover flyout on one of those buttons is one entry in `FLYOUTS`
  (`ui/flyout.ts`) — never a second menu implementation; `ui/menu.ts` renders
  every menu in the app, and `openAnchored()` is how a non-cursor one is opened.
  A new file type is a branch in `classify()` plus an entry in `RENDERERS`,
  both in `canvas/renderers.ts`. A new arrangement is a pure
  `(items, opts) => [{x, y}]` in `arrange/arrangements.ts`.
- **Icons are `<symbol>`s in `web/assets/icons.svg`, reached by name** —
  `<use href="assets/icons.svg#i-note">`. A misspelled id fails silently: no
  console warning, no failed request, just a hole where the icon was.
  `tests/icons.test.js` checks the references against the sprite and the sprite
  against the references.
- **`state.ts` is the only door, and it is being split downward.** The base
  layer under it — `board-store.ts`, `board-model.ts`, `history.ts`,
  `sticky.ts`, `fences.ts`, `layout.ts`, `stacking.ts`, `web-graph.ts`,
  `web-route.ts`, the five the state split added (`board-schema.ts`,
  `onboarding.ts`, `clipboard.ts`, `connections.ts`, `trash.ts`) and the four
  the `util.ts` split added (`crypto.ts`, `prefs.ts`, `notify.ts`,
  `media/transport.ts`) — may never import `state.ts` back. That one-way edge is
  the whole reason they are separate files: a concern lifted out of `state.ts`
  only stays out if what it stands on is lower than what it left.
- **`notify.ts` is a channel, not a renderer, and that is the point.** Five
  modules the layering forbids from importing `ui/` still need to say something
  to the person using the app — `state.ts`, `clipboard.ts`, `connections.ts` and
  the two in `storage/`. So `toast()` and `busy()` live at the bottom of the
  graph with no DOM in them at all, and `ui/overlays.ts` hands them an
  implementation through `setOverlays()`, the same shape as
  `setAssetNameLookup()`. Unwired, a toast is a no-op and `busy()` returns a
  frozen job that does nothing — which is what makes every one of those modules
  still loadable in a test with no browser. `main.ts` calls `initOverlays()`
  first, before the viewport exists.
  `tests/layers.test.js` holds the list.
- **The hand-written binary readers parse files the app did not write.**
  `storage/zip.ts`, `mesh.ts`, `import/artwork.ts`, `import/preview.ts`,
  `import/document.ts` and `optimize/opus.ts` all bounds-check before they
  allocate, and their tests are largely about malformed input. A change near
  them wants a test that feeds it something broken.
- **Nothing that reads a foreign document may touch `innerHTML`.**
  `ui/markdown.ts` and `ui/documents.ts` turn somebody else's file into a
  document tree, and both do it entirely through `createElement` and
  `createTextNode` — so there is no escaping to get right, by construction. Raw
  markup in a source file shows as the characters it is made of. The one
  exception is SVG in `ui/documents.ts`, which is parsed detached and walked
  against an **allow-list** of elements and attributes; a block-list there would
  be a promise that the author thought of everything.
- **A new thing the viewer can show is one entry in `VIEWS`**
  (`ui/viewer.ts`), the way a new card type is one entry in `RENDERERS`. The
  dialog, the head, the scroller and the teardown are already there — and the
  teardown is load-bearing: a `<video>` left mounted keeps its decoder, a
  document's blob URLs are this module's to revoke, and a parsed PDF holds the
  whole file.
- **`#toolbar` must stay before `#nowplaying` in `index.html`.** The rules that
  step the player up a tier when the phone's toolbar opens are general sibling
  combinators, which only look forward. Reordering the two breaks the layout
  silently and only on a phone.
- **Import paths are case-sensitive on the deployed host and not on this
  machine.** Windows resolves `'./Foo.js'` for `foo.js` happily; the Pages
  demo, served off a Linux filesystem, 404s. The CI job runs on `ubuntu-latest`
  for exactly this reason and is the leg that catches it — but it reports on the
  push, and the deploy does not wait for it, so match the filename exactly.
- **`web/patch.html` is the public changelog, and the second page this site
  has.** Kept entirely by hand — nothing generates it and `save.bat` does not
  touch it — with the whole authoring contract written in a comment at the top
  of `<main>`: read that before adding an entry. The rule it turns on is that
  the newest `.patch-version` must equal `VERSION` in `version.js`, which
  `tests/patch.test.js` asserts along with the tag set, the ordering and the
  fact that nothing is folded away. It is dressed by `assets/css/patch.css`,
  which is *not* one of the twenty in the app's cascade and is not in
  `index.html`; it is in `SHELL` in `sw.js`, because `tests/sw.test.js` walks
  the stylesheet directory. The page runs no script at all, which is what keeps
  it out of the CSP hash list. Reached from the app at System → What changed.
- Call out `.mbrd` schema, generated-catalog or service-worker cache changes
  explicitly when reporting work.

## Where the reasoning lives

`research/docs/` holds the specifications: [`mbrd-format.md`](research/docs/mbrd-format.md),
[`layout-settings.md`](research/docs/layout-settings.md),
[`browser-support.md`](research/docs/browser-support.md).

`research/` holds why things are the way they are, in three tiers — open work at
the top level, carried-out work in `old/`, speculative work in `future/`. See
[`research/README.md`](research/README.md); nothing in `old/` is authoritative,
and if it disagrees with the code, the code is right.

`window.mbrd` is a deliberate console handle (`mbrd.board`, `mbrd.cmds.fit()`,
`mbrd.vp`).
