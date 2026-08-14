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
```

Everything else wants `npm install` first — three devDependencies, and `npm
test` still needs none:

```bash
npm run dev         # esbuild watch → web/assets/app.js; edit, then refresh
npm run build       # the same bundle minified, plus assets/lab-pigments.js — this is what ships
npm run lint        # oxlint, correctness only — no formatter, and adding one is a regression
npm run typecheck   # tsc --noEmit under strict, over the whole tree; nothing is emitted
npm run dev:lab     # watch build for web/lab.html, the pigment lab
save.bat            # bump version stamps, rebuild, commit, optionally push
```

`save.bat` is in that second list rather than the first, and only recently: it
calls `npm run build` between the version stamps and the staging, so committing
now needs esbuild installed. A failed build stops the commit rather than warning
about it, because a bundle that did not build is not a stale bundle — it is the
previous one. The order matters as much as the step: `version.js` is bundled
*into* `app.js`, so a build before the stamps ships a release announcing the
previous version, which is how v0.187 came to log "v0.156 ready".

CI runs five legs on every push and pull request, in this order: `npm test` with
nothing installed — before `npm ci`, and that ordering is the whole point of it,
since it is the only thing keeping the zero-install claim from decaying in
silence — then lint, typecheck, build, and a parse of every committed module and
both Python tools. The build leg is not the suite twice: `npm test` resolves
specifiers through Node and the browser gets esbuild's output, and the two
disagree exactly when an import is unresolvable or a dynamic import names
something that moved. So a green `npm test` on its own is still not the whole
bar.

There is no browser-driven suite. `npm test` is the whole automated bar, and it
is a headless one — pan and zoom, drag and marquee, save → refresh → recover and
a clean boot console are checked by launching the app and looking, not by a
runner.

Syntax checks worth running on a change: `node --check` on touched `.js`,
`python -m py_compile` on `tools/serve.py` / `tools/qr.py`. That last CI leg is
the catch for a syntax error in a module no test imports — most of `ui/`,
`canvas/` and the tools — but it catches it after the push, so running them here
is still faster than finding out from a red run.

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
- **Do not hand-edit `web/assets/app.js` either — and note that it is
  committed.** Only the source map is ignored. The bundle is in the tree because
  nothing builds on deploy: wrangler serves `./web` as static files, so what
  reaches a visitor is whichever bundle was last committed. `save.bat` rebuilds
  it, which is what keeps the file from drifting behind the sources beside it.
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
  - **A button that opens a menu must call `justDismissed()` first.** The
    menu's own outside-press listener closes on `pointerdown` in the capture
    phase, and a button that opens a menu is *outside* it — so a second press
    already closed it, and the `click` that follows reopens it. The menu never
    appears to close. No toggle written in the opener can see this, because by
    the time the opener runs there is nothing left open; the fact has to be
    asked for rather than tested.
  - **A native `<select>` stops being one only when there is something it
    cannot do**, not when it looks unlike its neighbours. Two have cleared that
    bar and the reasoning for both, and for the ones that stay native, is in the
    `PickerControl` block in `ui/settings-schema.ts`.
- **Icons are `<symbol>`s in `web/assets/icons.svg`, reached by name** —
  `<use href="assets/icons.svg#i-note">`. A misspelled id fails silently: no
  console warning, no failed request, just a hole where the icon was.
  `tests/icons.test.js` checks the references against the sprite and the sprite
  against the references.
- **The layering graph, in one line:**
  `util/geometry <- state <- {import, storage, canvas} <- ui`, with `canvas/`
  allowed to reach into `import/` only for the generated format catalogue. That
  direction is what keeps the graph a DAG and keeps the lower modules loadable
  and testable without the ones above them. `tests/layers.test.js` makes both
  halves executable — no cycle, and the arrows point the stated way — and its
  `DEBT` map of known inversions is empty and may only shrink. `optimize/` is
  deliberately unranked there: it is dynamically imported, half leaf-helpers and
  half orchestrators, and it is a button.
- **A new module is written typed. No module may carry `@ts-nocheck`.** The
  migration renamed 105 modules in one step and carried 103 of them unchecked;
  `tests/ts-debt.test.js` counted them down to zero, which is why `typecheck`
  now means what it says about the whole tree rather than about everything
  except a list. At zero that file stopped being a ratchet and became a plain
  guard: a pragma added to get a change through fails the suite.
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
- **`web/_headers` is the same reasoning where the browser enforces it, and
  nothing here runs it.** `serve.py` sends no headers, so locally there is no
  policy at all and on the deploy there is — which means a CSP mistake is not a
  stack trace, it is a picture that does not draw, a font that falls back, an
  embed that stays a link, and only over there. `tests/csp.test.js` is the whole
  substitute for that missing feedback, and it checks four things in both
  directions: the hashes of the inline `<script>` blocks in `index.html` against
  their actual bytes (change one byte and the deployed page loses its pre-paint
  appearance restore, so an installed PWA flashes the default pigment on every
  launch), the embed hosts against `canvas/embed.ts`, the one remote host in
  `connect-src` against `optimize/media.ts`, and the worker exemption path. A
  new embed provider is two edits, not one.
- **A new thing the viewer can show is one entry in `VIEWS`**
  (`ui/viewer.ts`), the way a new card type is one entry in `RENDERERS`. The
  dialog, the head, the scroller and the teardown are already there — and the
  teardown is load-bearing: a `<video>` left mounted keeps its decoder, a
  document's blob URLs are this module's to revoke, and a parsed PDF holds the
  whole file.
- **`#toolbar`, then `#timeline-strip`, then `#nowplaying`, then `#tour` in
  `index.html`.** Every rule that steps the player up a tier — the phone's
  toolbar opening, the history strip coming up — is a general sibling
  combinator, and so is the one that lifts the tour bar clear of the player;
  those only look forward. So three things must be able to be seen *from* the
  player and one must see the player from itself. Four elements, three
  constraints pointing two ways, one legal order. Reordering breaks a layout
  silently — the first only on a phone, the second only while the strip is open,
  the third only while something is playing.
  - **And `#sidebar` and `#header-panel` must precede all four**, which is the
    same rule from further up the file. The strip and the player share one gap
    along the foot — `--foot-left` / `--foot-right` in `chrome.css`, defined once
    at `:root` rather than computed twice — and a panel opening at either end
    widens that gutter for *both* through `#sidebar.is-open ~ :is(#nowplaying,
    #timeline-strip)`. A sibling combinator again, so a panel moved below either
    bar stops moving it, and the bar slides under the panel.
- **Import paths are case-sensitive on the deployed host and not on this
  machine.** Windows resolves `'./Foo.js'` for `foo.js` happily; the Pages
  demo, served off a Linux filesystem, 404s. The CI job runs on `ubuntu-latest`
  for exactly this reason and is the leg that catches it — but it reports on the
  push, and the deploy does not wait for it, so match the filename exactly.
- **`web/lab.html` is a bench, not a page of the site.** It shows what the
  pigment extractor produced, it has its own bundle (`npm run dev:lab`, and a
  second entry in `npm run build` writing `assets/lab-pigments.js`), and it sits
  in `web/` only because `serve.py`'s document root is `web/` and that is the
  one place a page can import the real `ui/pigments.ts` rather than a copy. So
  it is off the design system on purpose — its own colours, none of
  `tokens.css`, because a bench that renders at the current whimsy tier makes a
  wrong colour and a warmly-displayed colour look identical. It carries
  `noindex` rather than a `robots.txt` Disallow (a Disallow stops the fetch,
  which stops the directive ever being read), it is not in `sitemap.xml`, and it
  is deliberately absent from `SHELL` in `sw.js`.
- **The changelog is a document, and `/patch` is the app showing one.**
  `web/patch.html` is **index.html's entire body**, copied at build time, with
  the changelog as markup after it — so the bundle boots and the sidebar on that
  page is the app's real sidebar: the real tab strip, the real Board, Look and
  System panels built by `ui/panel.ts` from `ui/settings-schema.ts`, the real
  Credits sheet. Not a hand-written likeness; three attempts at one produced
  three different sidebars and none of them was this one. `patch.css` hides the
  board furniture, and `main.ts`'s `isPatch` branch is what keeps a reader safe:
  the session is never read, `suspendCache()` stops the writer and
  `freezePrefs()` stops the panel recording a whimsy nudge as a preference, so
  nothing done while reading changes what they own. It is **generated** by
  `node tools/gen-patch-page.mjs` from `patch-notes.md` at the repository root,
  which is the only place the prose is written. It sits there rather than under
  `research/` because it is neither an argument nor a specification — it is the
  record of what shipped, and `research/README.md` is the file that says why
  nothing of that kind belongs in there. `save.bat` re-runs the generator on
  every commit and
  `tests/patch.test.js` runs it again and fails if what is committed differs. It
  may not be hand-edited.
  - **The page scrolls inside its own fixed surface**, the way `#mobile-feed`
    does, because `base.css` pins the app to the window and unpinning the body
    to let a document grow leaves every fixed layer the app draws measuring
    itself against something that is no longer the window.
  - `initIdle()` is **skipped** there. The idle fade exists to step the board's
    furniture back from the board; on a page of prose it faded the one control
    the page has, and a faded control takes `pointer-events: none` with it — so
    the menu button went and the sidebar could not be opened at all.
  - **It follows the whimsy dial, and that is the design.** The page loads
    `index.html`'s whole load block — every stylesheet, plus the pre-paint look
    restore, copied byte for byte — so the reader's own saved look is on
    `<html>` before first paint and `tokens.css` prints the changelog three
    ways: a scrapbook at 0, a straightened room at 1, a spec sheet at 2. What
    `assets/css/patch.css` adds at either end is only what a token cannot say —
    the tilt and the tape, and the fixed tag column that makes Harsh a table.
    The dial in the sidebar moves the page and writes nothing.
  - **The panel greys what needs a board rather than hiding it**, which is the
    single deliberate inversion of the schema's own "absence, not disabling"
    rule and applies on this page only. Hiding two thirds of the sidebar would
    turn the real one back into a likeness, which is the whole thing this page
    exists not to be. `needsBoard` in `ui/settings-schema.ts` marks which — set
    on a section it covers everything under it — `ui/panel.ts` writes the
    `disabled` that actually stops the click, and `.is-inert` in `sidebar.css`
    is only the fade. Quality, Appearance and the keyboard legend stay live,
    because those move the page in front of the reader.
  - **`Canvas`, `Feed` and `Playlist` navigate**, they do not switch a lens.
    There is no board on this page to switch: `feed` put the empty board behind
    the prose into the mobile layout and `playlist` floated a player over the
    changelog, and both did exactly that. `goHome()` in `page.ts` is the guard
    at the top of all three, and the face travels home as a fragment — `#feed`,
    `#playlist` — which `main.ts` reads once after the session is back.
  - **`page.ts` is where "which page is this" lives**, at the bottom of the
    graph and with nothing imported into it. Three tiers ask it the same
    question — `main.ts`, `ui/panel.ts` and `commands/view.ts` — so it cannot
    sit in any of them. It reads the URL lazily rather than at import time,
    which is what keeps it inside the rule `tests/imports.test.js` enforces.
  - **No index of the releases** anywhere on it — the changelog is one column
    read top to bottom.
  - **The spans in the source are contiguous and cover every commit from the
    first.** `tests/patch.test.js` enforces it. A gap used to be invisible: four
    runs of versions were in no release at all while the work done in them had
    been folded into the bullets of a release whose number did not contain it,
    so the record read as complete and was not.
  - **A bullet may wrap in the source.** An indented line continues the one
    above it, folded with a single space. Bullets used to have to be one line
    each, which at this length meant three-hundred-character lines in a
    repository that wraps everything else at eighty.
  - Each release still has an id — `/patch#r-the-viewer` — for links written
    elsewhere. Nothing on the page produces one.
  - The rule the whole thing turns on: the high end of the newest `version:` in
    the source must equal `VERSION` in `version.js`.
  - Its inline scripts are **index.html's own**, arriving with the copy, so they
    hash to values `_headers` already lists and the page needs no entry of its
    own. Editing either means regenerating the page — `tests/csp.test.js`
    recomputes them.
  - **No inline `style=` anywhere**, which is a policy rule and not a
    preference: `style-src` carries no `unsafe-inline`, and a hash covers an
    element and never an attribute.
  - No `<base>` tag on that page, unlike `index.html` — a base makes a fragment
    resolve against it, so every row in the index would point at
    `/#r-something` and load a board. It shipped once and did exactly that.
  - Reached from the app at System → What changed.
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
