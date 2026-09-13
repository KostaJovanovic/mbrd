# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This file is a **checklist of things that break silently**, not an explanation of
the app. The reasoning lives elsewhere and is not repeated here:

- **[`research/docs/architecture.md`](research/docs/architecture.md)** — how the app
  is put together. The single source of truth.
- **[`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md)** — how to run it and
  test it, the five easily-broken invariants, style, and what a commit or PR has
  to say. It and `.github/THIRD-PARTY.md` sit there rather than at the root
  because GitHub surfaces both from `.github/`, and the root is kept for files
  that have no choice about being in it.
- **Module headers.** Every file opens with a 2–5 line comment: what the module
  does, key constraint, self-contained. **Read the top of a file before changing
  it**, and keep that convention in anything you add. Inline comments are short
  and state WHY, not WHAT — proportional to the complexity they explain.

There is deliberately no `AGENTS.md`: conventions stated in two places disagree
within a quarter.

**Edit files with the file tools, never through the shell.** Read, Edit, Write,
Grep, Glob — not `cat`, `sed -i`, a heredoc or a throwaway Python script, and
this holds over any harness setting that says to prefer the shell. The reason is
review: a tool edit lands as a diff somebody can read, and a `sed` rewrite lands
as an opaque command whose effect has to be reconstructed from the file
afterwards. The shell is for commands that are commands — `npm test`, the build,
`git`, `tools/serve.py`.

## Commands

```bash
npm test                          # node --test over tests/**/*.test.{js,ts} — no install, no deps
node --test tests/state-history.test.js                            # one file
node --test --test-name-pattern "undo" tests/state-history.test.js # one test
python tools/serve.py [port]      # dev server on 6273; server.bat on Windows
```

Everything below needs `npm install` first (four devDependencies). `npm test`
never does:

```bash
npm run dev         # esbuild watch → web/assets/app.js; edit, then refresh
npm run build       # minified bundle + both lab bundles — this is what ships
npm run lint        # oxlint, correctness only — adding a formatter is a regression
npm run typecheck   # tsc --noEmit, strict, every .ts under web/assets/js
npm run dev:lab     # watch build for web/lab.html, the pigment lab
npm run dev:sound   # watch build for web/lab-sound.html, the sound lab
save.bat            # version stamps → build → commit → portable copy → optionally push
```

`save.bat` rebuilds `desktop/portable/` — the portable copy — after every commit
it makes, which is the one step in it that **cannot fail the save**: it is
gitignored, so nothing built there is committed, pushed or deployed, and the
worst a failure does is leave one machine with a stale copy. It is skipped when
`desktop/node_modules` is absent, which is most checkouts. It also adds about
ninety seconds, which is why it runs last, after the push question.

The desktop shell is a **second package** under `desktop/` with its own
`node_modules`, and needs its own `npm install` before any of this:

```bash
desktop.bat                         # Windows: install, build, watch the web bundle, open
desktop.bat portable                # Windows: repackage desktop/portable/ and run it
npm run desktop                     # build the shell and open the app
npm run portable                    # → desktop/portable/, a runnable copy
cd desktop && npm run typecheck     # outside the root tsconfig on purpose
```

`desktop.bat` is the launcher to use. Over `npm run desktop` it adds three
things. It installs both packages' dependencies on a fresh clone. It builds the
web bundle first: Electron serves `web/` off the disk you are editing, but
`index.html` loads `assets/app.js`, so without a build an edit to a `.ts` file
opens the previous bundle and reads as a change that did nothing. And it keeps
`npm run dev` watching in its own console while the app is open, and stops it
when the app closes. A watch already running in another terminal is reused and
left alone. It also clears `ELECTRON_RUN_AS_NODE`, which an Electron-based
editor sets in its integrated terminal and which makes `electron .` boot as
plain Node: `app` is undefined and `main.ts` throws on its first line.

**`Ctrl+R` reloads, and only `desktop.bat` rebuilds for it.** The window reads
`web/` off the disk fresh on every request, so a reload shows the last *build*.
Under `desktop.bat` the watch has made that build a moment after the save.
Started any other way (`npm run desktop`), nothing watches: run `npm run build`
or `npm run dev` first. The Reload row is in the View menu. Nothing watches
`desktop/` itself, so a change to the shell (main, the menu, the title bar)
needs the window closed and `desktop.bat` run again.

`desktop/portable/` is the unpacked app plus the `portable` marker
`installer.nsh`'s Portable branch writes — there is no portable *target*, only
that page inside the one Setup.exe. `main.ts` reads the marker before `ready` and
puts `userData` in `portable/data`, which is why **`portable/data/` survives a
rebuild and everything else in there does not**. Not `desktop/dist/`, which is
the two esbuild bundles. See `desktop/scripts/portable.mjs`.

The root package still declares four devDependencies and no runtime
dependency, and `npm test` still installs nothing — that is what the two-package
layout is for. See `research/electron-2026-09-06.md` §11.

The lint is oxlint plus one vendored plugin, `tools/oxlint/anti-slop`, which is
why `@oxlint/plugins` is a dependency. Its rules are the single departure from
correctness-only and a narrow one — each fires on a way of writing TypeScript
that hides a mistake, never on layout. The argument is in `.oxlintrc.json`'s
header.

Generators, run when their source changes:
`node tools/gen-formats.mjs` (→ `import/formats.ts`), `tools/gen-stickers.mjs`
(→ `stickers.svg`), `node tools/gen-patch-page.mjs` (→ `web/patch.html`),
`node tools/gen-desktop-icons.mjs` (`icon.svg` → `desktop/icons/`, the `.ico`,
`.icns` and PNG the three installers want). That last one is the only generator
that needs an install, and it is `desktop/`'s: it renders SVG through the sharp
the shell already depends on. Its output is committed so nobody else runs it.

Two more `.mjs` under `tools/` are one-shot printers and not build steps:
`preset-oklch.mjs` and `gen-tier-palettes.mjs` print numbers that were pasted
into `tokens.css` by hand. Nothing regenerates from them and nothing should.

**A refresh alone is not enough.** The app is TypeScript, the browser gets one
esbuild bundle, and `index.html` loads `assets/app.js` — so an edit needs
`npm run dev` running.

**`npm test` needing no install is load-bearing.** Node strips types natively
from 22.18, which is why `engines` says 22.18 and `erasableSyntaxOnly` is on:
an `enum`, `namespace` or parameter property would make the whole suite
unrunnable without a loader. tsc refuses them first.

**`npm test` alone is not the bar.** CI runs five legs in this order — `npm test`
*before* `npm ci` (the only thing keeping the zero-install claim honest), then
lint, typecheck, build, and a parse of every committed module and both Python
tools. The build leg catches what `npm test` cannot: an unresolvable import, or
a dynamic import naming something that moved. The parse leg catches syntax
errors in modules no test imports — most of `ui/` and `canvas/` — but only after
the push, so `node --check` and `python -m py_compile` locally are faster.

**The typecheck leg does not reach everything, and the parse leg is why that is
survivable.** `include` is `web/assets/js/**/*.ts` and nothing else, so
`tools/` — the generators, and the vendored `anti-slop` plugin, which
`.oxlintrc.json` also ignores — is outside it, as are the three `.js` files left
under `web/assets/js`: `import/tiff-worker.js` and `optimize/media-worker.js`,
which are classic workers and need `importScripts`, and `version.js`, which
`save.bat` stamps. Every one of those is *parsed* by the fifth leg. Nothing is
typechecked twice and nothing is silently excused — but "green typecheck" means
the app's TypeScript, not the repository.

**`tsconfig.json` closes its ambient types (`"types": []`) and that line is not
optional.** tsc discovers `@types/*` by walking node_modules *upwards*, so an
`@types/node` in a home directory joins the compilation of a browser-only app
and every `setTimeout` handle stored in a `number` goes red. It reproduces on
one machine and never in CI. Deleting the line makes the check depend on what is
installed two directories above the repository.

There is **no browser-driven suite**. Pan and zoom, drag and marquee, save →
refresh → recover, and a clean boot console are checked by launching the app and
looking.

## Never hand-edit these

| file | why | what fails |
| --- | --- | --- |
| `web/assets/js/version.js`, the `VERSION` line in `web/sw.js` | `save.bat` stamps both by regex | reformatting breaks the stamp silently |
| `web/404.html` | byte-for-byte copy of `index.html`, remade by `save.bat` | `tests/notfound.test.js`, on one byte |
| `web/patch.html` | generated from `patch-notes.md` | nothing — `save.bat` regenerates it and a hand edit is overwritten |
| `web/assets/js/import/formats.ts`, `web/assets/stickers.svg` | generated | — |
| `web/assets/app.js` | the bundle, and it **is committed** — wrangler serves `./web` statically, so the last committed bundle is what visitors get | drifts behind its sources |

Also: **no apostrophes anywhere inside `SHELL` in `web/sw.js`**, comments
included — `tests/sw.test.js` reads that list by pulling out single-quoted runs.

## Where a change goes

- **A user-facing action** → an entry in `cmds` (`commands.ts`), never a second
  event listener. A toolbar tool is also a `<button data-cmd>` in `index.html`.
- **A setting** → one entry in `ui/settings-schema.ts`.
- **A menu** → `ui/menu.ts` renders every menu in the app. A hover flyout is one
  entry in `FLYOUTS` (`ui/flyout.ts`); `openAnchored()` opens a non-cursor one.
  **Never a second menu implementation.**
- **A file type** → a branch in `classify()` plus an entry in `RENDERERS`, both
  in `canvas/renderers.ts`.
- **A 3D format** → a module under `mesh/`, an entry in `KINDS` and one in
  `PARSERS`, all reachable from `mesh.ts`. `classify()` needs no edit: it asks
  `meshKind()`. **Every reader must be synchronous** — the per-parse ceilings in
  `mesh/shared.ts` and the `lift` retry in `canvas/model.ts` both rest on there
  being no `await` under `parseMesh()`, which is why `mesh/zip.ts` inflates by
  hand instead of using `DecompressionStream`.
- **A thing the viewer can show** → one entry in `VIEWS` (`ui/viewer.ts`). Its
  teardown is load-bearing: a mounted `<video>` keeps its decoder, blob URLs are
  this module's to revoke, a parsed PDF holds the whole file.
- **An arrangement** → a pure `(items, opts) => [{x, y}]` in
  `arrange/arrangements.ts`.
- **An icon** → a `<symbol>` in `web/assets/icons.svg`, referenced by name. A
  misspelled id fails *silently* on screen; `tests/icons.test.js` is what
  catches it, in both directions.
- **A stylesheet** → a `<link>` in `index.html`, the same place in `SHELL`
  (`web/sw.js`), and the same place in `APP_CSS_ORDER` (`tests/helpers.js`) —
  one list written three times, because **document order is the cascade** and
  `quality.css` wins on it rather than on specificity. Miss the third and
  nothing fails: every CSS test simply stops reading that sheet. `patch.html`
  is generated and needs no edit.
- **An id** — written in `index.html` or handed to a node at runtime by a
  module — is how the sheets address the furniture. A rename fails *silently*:
  the selector stays valid CSS and matches nothing. `tests/element-ids.test.js`
  checks both directions, the job `tests/icons.test.js` does for icon names.
- **A sound** → a recipe in `RECIPES` and a mapping from what happened to what
  is heard in `CUES`, both `cuelume/recipes.ts`. The recipes are vendored from
  Cuelume number for number; the cues are this app's. A press that logs nothing
  under `mbrd.sound.log()` never reached the engine.
- **A cloud provider** → a module under `storage/cloud/` exporting a
  `ShareProvider`, its id in `PROVIDER_IDS` (`cloud/provider.ts`) and its object
  in `PROVIDERS` (`cloud/cloud.ts`), its identifiers in `cloud/config.ts`, **its
  API host in `connect-src` in `web/_headers`**, and its sign-in page in
  `tests/csp.test.js`'s `NOT_FETCHED` — that last one because the sign-in is
  *navigated* to and not fetched, which is the only shape of URL allowed to be
  absent from the policy. Implementing `store` as well as the share methods is
  what lets it keep boards in sync; a provider that cannot is absent from that
  half rather than failing in it. The picker, once there are two, is one
  `openAnchored()` call and never a second menu. `research/docs/cloud.md` is the
  specification. **`config.ts` ships empty and `tests/share.test.js` asserts
  it**, so the rows are absent rather than broken in a checkout nobody has
  registered an application for.
- **A new class of asset reference** → `itemHashes()` / `timelineHashes()` **and**
  `boardAssetHashes()` in `storage/mbrd.ts`, which is what the cloud sync uploads
  from. The packer and that walk are two implementations bound by an assertion in
  `tests/mbrd.test.js`; a class added to one and not the other means the sync
  silently stops uploading a whole category and the board comes back on another
  machine with holes in it. Three readers had to learn at once when the stored
  versions arrived in v0.198, which is why this line exists.
- **A size ceiling** → a `CeilingId` and a risk sentence in `consent.ts`, a
  `throw oversize(...)` where the number is measured, and a `lift()` at the
  nearest async caller that knows the file. **No ceiling refuses anything on its
  own.** The numbers stay where they are argued — `IMPORT_LIMITS`
  (`import/budget.ts`), `LIMITS` (`storage/zip.ts`), `MAX_TRIANGLES`
  (`mesh.ts`), `MAX_ART` (`import/artwork.ts`) — and `consent.ts` holds only the
  prose and the decision.
- **Do not split `canvas/input.ts`.** One pipeline, exactly one active gesture.

Two traps in that list, both found the hard way:

- **A button that opens a menu must call `justDismissed()` first.** The menu
  closes on outside `pointerdown` in the capture phase, and the button is
  outside it — so the second press already closed it and the `click` reopens it.
  No toggle written in the opener can see this.
- **A native `<select>` stops being one only when there is something it cannot
  do**, never for consistency. The bar, and who has cleared it, is in the
  `PickerControl` block in `ui/settings-schema.ts`.

## Structural rules the tests enforce

- **The layering graph:** `util/geometry <- state <- {import, storage, canvas}
  <- ui`, with `canvas/` reaching `import/` only for the generated format
  catalogue. `tests/layers.test.js` checks both halves and its `DEBT` map of
  known inversions **is empty and may only shrink**. `optimize/` is unranked on
  purpose.
- **`state.ts` is the only door**, and the base layer under it may never import
  it back. `tests/layers.test.js` holds that list too.
- **A lower module that needs the interface gets it injected, never imported** —
  `setOverlays()` (`notify.ts`), `setAssetNameLookup()`, `setNoteMenu()`
  (`canvas/notes.ts`). Unwired, each is a no-op, which is what keeps those
  modules loadable in a test with no browser.
- **No module touches `document` at import time** — export an `init*()`. Three
  are exempt and `tests/imports.test.js` names them.
- **No module carries `@ts-nocheck`.** `tests/ts-debt.test.js` counted the
  migration to zero and is now a plain guard.
- **Import paths are case-sensitive on the deployed host and not on Windows.**
  CI runs on `ubuntu-latest` for this, but reports after the push and the deploy
  does not wait — match the filename exactly.

## Safety rules

- **The hand-written binary readers parse files the app did not write** —
  `storage/zip.ts`, `mesh.ts` and everything under `mesh/`, `import/artwork.ts`,
  `import/preview.ts`, `import/document.ts`, `import/containers.ts`,
  `optimize/opus.ts`. All bounds-check before allocating. A change near them
  wants a test that feeds it something broken.
- **Those readers throw two different things and the difference is load-bearing.**
  `Oversize` (`consent.ts`) means "this is larger than the number somebody wrote
  down" — a question, carried up to whoever owns the file, and lifted with a
  `lift` flag if they say yes. A plain `Error` means the file does not say what it
  means: an offset past the end, two entries under one name, a count that is not
  an integer. **`lift` must never reach the second kind.** A ceiling that stops
  being liftable, or a corruption check that starts being one, both look like a
  one-word edit and neither is.
- **`setRiskPrompt()` unwired allows everything**, unlike storage's `setPrompt()`.
  Argued at length in `consent.ts`; the short version is that a module with no
  interface attached must not invent a refusal, and this is what keeps `import/`,
  `storage/` and `mesh.ts` loadable in a test with no DOM. It also means the
  ceilings are only as good as `main.ts`'s wiring — if that line goes, nothing
  fails, and every limit in the app silently becomes no limit.
- **Nothing that reads a foreign document may touch `innerHTML`.**
  `ui/markdown.ts` and `ui/documents.ts` build trees with `createElement` and
  `createTextNode` only, so there is no escaping to get right. The one exception
  is SVG in `ui/documents.ts`: parsed detached and walked against an
  **allow-list**.
- **`web/_headers` is a CSP nothing here runs.** `serve.py` sends no headers, so
  a mistake is invisible locally and is a picture that does not draw on the
  deploy. `tests/csp.test.js` is the whole substitute — it checks the inline
  `<script>` hashes in `index.html` against their bytes, the embed hosts against
  `canvas/embed.ts`, the one `connect-src` host against `optimize/media.ts`, and
  the worker exemption. **A new embed provider is two edits.**
- **No inline `style=` anywhere.** `style-src` carries no `unsafe-inline`, and a
  hash covers an element, never an attribute. Setting `.style` from script is
  fine; a `style` attribute in markup is not.

## Two ordering rules in `index.html`

1. **`#sidebar`, `#header-panel`, … `#toolbar`, `#timeline-strip`,
   `#nowplaying`, `#tour`.** Every rule that steps one of these up a tier is a
   *general sibling combinator*, which only looks forward. Move any of them
   above its dependents and a layout breaks silently — and only in one state:
   on a phone, or while the timeline is open, or while something is playing.
2. The strip and the player share one gap along the foot, `--foot-left` /
   `--foot-right`, defined once at `:root` in `chrome.css`. A panel opening at
   either end widens it for both.

## `/patch` — a document wearing the app's cascade

`web/patch.html` is **index.html's `<head>`** — the fonts, the whole cascade in
order, and the pre-paint look script — and then the changelog. Nothing else: no
sidebar, no board furniture, no bundle. Generated by `node
tools/gen-patch-page.mjs` from `patch-notes.md`; `save.bat` re-runs it on every
save, so what is committed follows the prose.

It used to be index.html's entire *body*, so the app booted on it and the panel
over the changelog was the app's real panel. That went when the sidebar came off
the page, and with it two things it had been carrying: half a megabyte of script
booting a board nobody could see, and `#grain` — the app's fixed, full-window
paper texture — sitting still behind a page whose own texture scrolls.

What matters when touching it:

- **`patch-notes.md` is the only place the page's prose is written, and it is
  the author's to write.** Nothing checks it and nothing generates it. Do not
  add releases, fill a version gap, or edit the prose.
- **It carries only what a reader would notice.** Features, repairs somebody
  could have hit, speed-ups somebody could have felt. The full record, internal
  work included, is archived in `research/patch-notes-full.md`, which nothing
  reads and nothing generates from.
- `main.ts`'s `isPatch` branch stays and is **not dead**: `sw.js` precaches
  `patch.html`, so a returning visitor can be handed a cached copy from back
  when the page did boot the app. That branch reads no session and freezes the
  preference store, which is what keeps such a copy harmless.
- The page follows the whimsy dial by design — the pre-paint script alone puts
  the reader's look on it, with no script of its own.
- No `<base>` tag, unlike `index.html` — a base makes every fragment resolve
  against it and load a board.

## `web/lab.html` and `web/lab-sound.html` are benches, not pages of the site

Each has its own bundle (`npm run dev:lab`, `npm run dev:sound`), its own
colours, none of `tokens.css` — a bench rendering at the current whimsy tier
makes a wrong colour and a warmly displayed one look identical. `noindex` rather
than a `robots.txt` Disallow (a Disallow stops the fetch, which stops the
directive being read), absent from `sitemap.xml` and from `SHELL`.

## Reporting work

Call out **`.mbrd` schema, generated-catalogue and service-worker cache changes
explicitly**.

## Where the reasoning lives

`research/docs/` holds the specifications —
[`mbrd-format.md`](research/docs/mbrd-format.md),
[`layout-settings.md`](research/docs/layout-settings.md),
[`browser-support.md`](research/docs/browser-support.md),
[`cloud.md`](research/docs/cloud.md).

`research/` holds why things are the way they are, in three tiers: open work at
the top level, carried-out work in `old/`, speculative work in `future/`. See
[`research/README.md`](research/README.md). **Nothing in `old/` is
authoritative** — if it disagrees with the code, the code is right.

`window.mbrd` is a deliberate console handle, and `main.ts` names all eight
keys: `board`, `bus`, `vp`, `cmds`, `selection`, `perf`, `debugGrips`, `sound`.
`mbrd.sound.log()` starts a transcript of every interface cue and what became of
it; **its value is the lines that are not there**, since a press that logs
nothing never reached the engine.
