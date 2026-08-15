# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This file is a **checklist of things that break silently**, not an explanation of
the app. The reasoning lives elsewhere and is not repeated here:

- **[`research/docs/architecture.md`](research/docs/architecture.md)** — how the app
  is put together. The single source of truth.
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — how to run it and test it, the five
  easily-broken invariants, style, and what a commit or PR has to say.
- **Module headers.** Every file in this codebase argues its own design at the
  top, often at length. **Read the top of a file before changing it**, and keep
  that convention in anything you add.

There is deliberately no `AGENTS.md`: conventions stated in two places disagree
within a quarter.

## Commands

```bash
npm test                          # node --test over tests/ — no install, no deps
node --test tests/state-history.test.js                            # one file
node --test --test-name-pattern "undo" tests/state-history.test.js # one test
python tools/serve.py [port]      # dev server on 6273; server.bat on Windows
```

Everything below needs `npm install` first (three devDependencies). `npm test`
never does:

```bash
npm run dev         # esbuild watch → web/assets/app.js; edit, then refresh
npm run build       # minified bundle + assets/lab-pigments.js — this is what ships
npm run lint        # oxlint, correctness only — adding a formatter is a regression
npm run typecheck   # tsc --noEmit, strict, whole tree
npm run dev:lab     # watch build for web/lab.html, the pigment lab
save.bat            # version stamps → build → commit → optionally push
```

Generators, run when their source changes:
`node tools/gen-formats.mjs` (→ `import/formats.ts`), `tools/gen-stickers.mjs`
(→ `stickers.svg`), `node tools/gen-patch-page.mjs` (→ `web/patch.html`).

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

There is **no browser-driven suite**. Pan and zoom, drag and marquee, save →
refresh → recover, and a clean boot console are checked by launching the app and
looking.

## Never hand-edit these

| file | why | what fails |
| --- | --- | --- |
| `web/assets/js/version.js`, the `VERSION` line in `web/sw.js` | `save.bat` stamps both by regex | reformatting breaks the stamp silently |
| `web/404.html` | byte-for-byte copy of `index.html`, remade by `save.bat` | `tests/notfound.test.js`, on one byte |
| `web/patch.html` | generated from `patch-notes.md` | `tests/patch.test.js` re-runs the generator |
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
- **A thing the viewer can show** → one entry in `VIEWS` (`ui/viewer.ts`). Its
  teardown is load-bearing: a mounted `<video>` keeps its decoder, blob URLs are
  this module's to revoke, a parsed PDF holds the whole file.
- **An arrangement** → a pure `(items, opts) => [{x, y}]` in
  `arrange/arrangements.ts`.
- **An icon** → a `<symbol>` in `web/assets/icons.svg`, referenced by name. A
  misspelled id fails *silently* on screen; `tests/icons.test.js` is what
  catches it, in both directions.
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
  `storage/zip.ts`, `mesh.ts`, `import/artwork.ts`, `import/preview.ts`,
  `import/document.ts`, `optimize/opus.ts`. All bounds-check before allocating.
  A change near them wants a test that feeds it something broken.
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

## `/patch` — the changelog is the app showing a document

`web/patch.html` is **index.html's entire body**, copied at build time, with the
changelog after it — so the bundle boots and the sidebar is the app's *real*
sidebar rather than a likeness. Generated by `node tools/gen-patch-page.mjs`
from `patch-notes.md`; `save.bat` re-runs it and `tests/patch.test.js` fails if
what is committed differs.

What matters when touching it:

- **`patch-notes.md` is the only place the prose is written**, and the rule it
  turns on: the high end of the newest `version:` span must equal `VERSION` in
  `version.js`. Spans are contiguous and cover every commit from the first.
- `main.ts`'s `isPatch` branch is what keeps a reader safe — the session is
  never read, `suspendCache()` and `freezePrefs()` stop the page recording
  anything. `initIdle()` is skipped there.
- The page follows the whimsy dial by design; `needsBoard` in the schema greys
  what needs a board rather than hiding it, the single deliberate inversion of
  the schema's "absence, not disabling" rule.
- No `<base>` tag, unlike `index.html` — a base makes every fragment resolve
  against it and load a board.

## `web/lab.html` is a bench, not a page of the site

Its own bundle (`npm run dev:lab`), its own colours, none of `tokens.css` — a
bench rendering at the current whimsy tier makes a wrong colour and a warmly
displayed one look identical. `noindex` rather than a `robots.txt` Disallow (a
Disallow stops the fetch, which stops the directive being read), absent from
`sitemap.xml` and from `SHELL`.

## Reporting work

Call out **`.mbrd` schema, generated-catalogue and service-worker cache changes
explicitly**.

## Where the reasoning lives

`research/docs/` holds the specifications —
[`mbrd-format.md`](research/docs/mbrd-format.md),
[`layout-settings.md`](research/docs/layout-settings.md),
[`browser-support.md`](research/docs/browser-support.md).

`research/` holds why things are the way they are, in three tiers: open work at
the top level, carried-out work in `old/`, speculative work in `future/`. See
[`research/README.md`](research/README.md). **Nothing in `old/` is
authoritative** — if it disagrees with the code, the code is right.

`window.mbrd` is a deliberate console handle, and `main.ts` names all seven
keys: `board`, `bus`, `vp`, `cmds`, `selection`, `perf`, `debugGrips`.
