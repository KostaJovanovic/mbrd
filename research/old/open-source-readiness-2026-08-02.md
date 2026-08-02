# Open-source readiness — refactor plan, 2026-08-02

## Status, 2026-08-02 — carried out

Every item is done. The suite is **728 passing**, `npm run lint` and
`npm run typecheck` are both clean, the **Playwright set is 4/4 in a real
browser**, `node --check` is clean over every tracked `.js`, `serve.py`/`qr.py`
compile, and every entry in the service worker's `SHELL` was fetched over a live
`serve.py` and returned 200.

One thing is left for the maintainer: the repository slug in
`.github/ISSUE_TEMPLATE/config.yml`, which currently guesses `valjdakosta/mbrd`.

**The licence is settled: GPL-3.0-or-later**, recorded in `package.json` and
argued in one paragraph in the README. Copyleft was chosen over permissive on
the grounds that the app's two promises - your work stays on your machine, and
the format opens with `unzip` - are exactly the kind a fork can quietly drop.

**The typecheck found a live bug on its first run**, which is the whole argument
for Part 6 made concrete: `web-graph.js` called `corners()` and `pointInItem()`
without importing either, so `threads()` threw a `ReferenceError` on any board
with enough sized items to reach the extra-thread pass — the relationship web
stopped drawing past its spanning tree and said nothing. Fixed, with a
regression test (`tests/web.test.js`) that enters `CardGrid` deliberately.

| item | state |
| --- | --- |
| 2.1 entry points | done — README leads with `python serve.py`; the `.bat` files are untouched, by request |
| 2.3 hygiene | partly — filename with a space renamed; **BOM strip withdrawn**, see below |
| 2.4 licence / format | done — **GPL-3.0-or-later**, stated and reasoned in the README and declared in `package.json`; the `.mbrd` format separately declared free to implement |
| 3.1 CI | done — `.github/workflows/ci.yml`, ubuntu × windows, node 20/22, plus syntax and stamp checks |
| 3.2 Pages demo | done — `.github/workflows/pages.yml` |
| 3.3 community files | done — CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, three issue templates, PR template |
| 3.4 lint | done — `oxlint`, correctness rules only, no formatter. Cleared 51 findings; gated in CI |
| 3.5 seed issues | done — ten written out in `.github/SEED-ISSUES.md`, ready to paste on the day the repo goes public |
| 4.1 `main.js` split | done — 1,962 → 441, onto six modules |
| 4.2 `app.css` split | done — 6,021 → eight files |
| 4.3 `state.test.js` split | done — 1,803 → six files, all 128 cases accounted for |
| 4.4 second tier | done — all three. See below for the two that needed a designed seam |
| 5.1 one architecture doc | done — `docs/architecture.md`; CLAUDE.md and AGENTS.md are pointers |
| 5.2 clean root | done |
| 5.3 frame `research/` | done — `research/README.md` |
| Part 6 depth | done — `npm run typecheck` (clean, gated in CI) and `npm run test:e2e` (4 cases, optional) |

**The BOM item was wrong and is withdrawn.** `web/assets/js/version.js` and
`web/sw.js` carry a UTF-8 BOM because `save.bat` writes them with
`Set-Content -Encoding utf8`, which in Windows PowerShell 5.1 *means* a BOM.
Stripping them would be undone on the next commit, and the only real fix edits
`save.bat`. Both files parse fine with a BOM. Left alone.

### 4.4's other two needed a designed seam, not a cut

`ui/appearance.js` and `storage/storage.js` were **not** two sequential halves
the way `main.js` and `app.css` were. Measured rather than guessed:

- `ui/appearance.js` — the controls section uses **13** names from the look model
  above it (`current`, `apply`, `persist`, `setVar`, `setWhimsy`, `CONTROLS`,
  `HOSTS`, …) and the look model uses **11** back from the controls
  (`syncControls`, `buildControls`, `wirePalette`, `inputs`, …).
- `storage/storage.js` — the file/dialog half uses **9** names from the session
  half (`autosave`, `drainSave`, `clearSession`, `cacheOk`, …) and the session
  half uses **7** back (`fileHandle`, `exportBoard`, `newBoard`, `prompt`, …).

Both were mutually recursive, so each needed an injection interface and an
answer to *which module owns the mutable state*. Both now have one:

- **`ui/appearance.js` (1,261 → 1,047) + `ui/appearance-controls.js` (279).**
  The panel is handed what it borrows through `initAppearanceControls()`, and
  `current` goes through as a **getter** — the model reassigns it at four sites,
  so a captured reference would go stale the first time a board was opened. The
  first cut of this took `document.documentElement` at module scope and
  `tests/imports.test.js` rejected it, which is the invariant doing its job: a
  fourth import-time-dirty module would have been a regression, so the root
  element is taken in the initialiser instead.
- **`storage/storage.js` (949 → 468) + `storage/session.js` (569) +
  `storage/naming.js` (31).** The question was **who owns the file handle**, and
  the answer is `storage.js`: a handle is about the document somebody chose on
  disk, a session is about the copy this browser keeps. So the engine is handed
  the handle, the created-stamp, Export and the discard prompt, and never
  imports back. `lastFailure`, `cacheOk` and `warnedIncomplete` moved *to* the
  engine that sets them, and the file half resets them through
  `resetSessionLatches()` rather than reaching in.

Both were verified in a real browser afterwards, not only against the suite —
the save → refresh → recover case exercises the storage seam end to end.

`canvas/renderers.js` was the third and is done, because it genuinely did have a
separable piece: `classify()` and `RENDERERS` stay together (they are the pair a
new item type edits, and splitting them would double that work), while the
sticky-note formatting model and the video first-frame grab — neither of which is
type dispatch — moved to `canvas/note-model.js` and `canvas/poster.js`. That also
straightened a backwards arrow: `canvas/notes.js` is the note *editor* and was
reaching through the renderer for the model both of them read.

Three things this turned up that the plan did not predict:

1. **`commands.js` cannot import `ui/appearance.js`** — that would be a fourth
   module touching a browser global at import time. `resetAppearance` and
   `setWhimsy` are injected from `main.js` instead, in the same shape as
   `setAssetNameLookup()` and `setPrompt()`.
2. **The `motion.css` the plan implied does not exist.** The cheap-mode section
   runs straight into the grip rules, and both belong with items — shipping a
   file named for only half of what is in it would have been worse than the
   long file.
3. **The relationship web was broken** and nothing said so. See the typecheck
   note at the top.

---

Written against the tree at `v0.109` (109 commits, 219 tracked files, 31,645
lines of JavaScript, 7,202 of CSS, 9,129 of test).

Two questions are answered here. First, whether to rewrite on a framework
before opening the repo — the answer is no, with numbers. Second, what to
actually change so that somebody who is not the author can clone this, run it,
find their way around, and land a patch without a conversation first.

---

## Part 1 — Do not rewrite on a framework

### The addressable surface is about 3,000 lines

Of 31,645 lines of JavaScript, **11,458 are in modules that never touch
`document` or `window`**: `mesh.js`, `arrange/arrangements.js`, `layout.js`,
`import/artwork.js`, `web-graph.js`, `storage/mbrd.js`, `storage/zip.js`,
`geometry.js`, `measure.js`, `optimize/*`, and `state.js` itself. A view
framework has nothing to say about any of it. It is struct reading, ZIP
containers, OKLCh arithmetic, spanning trees and packing — it would survive a
rewrite untouched, which means a rewrite is not what it is for.

Of the ~20,000 lines that do touch the DOM, most are imperative *because the
app is*:

| module | lines | why a virtual DOM does not help |
| --- | --- | --- |
| `canvas/input.js` | 1,383 | one Pointer Events pipeline, exactly one active gesture; a framework's synthetic events are the thing you would have to escape |
| `canvas/items.js` | 1,100 | culls nodes off-screen and detaches them by hand for memory reasons — the opposite of a reconciler owning the tree |
| `canvas/renderers.js` | 1,197 | builds each card's DOM once; the cost is in decode, not diff |
| `canvas/grid.js` | 935 | paints in screen space on every view change; already avoids repaint by writing `background-position` |
| `canvas/viewport.js` | 870 | one composited `translate() scale()`; a framework must be told not to touch it |
| `canvas/model.js` | 803 | a single shared WebGL context blitted into 2D canvases |
| `canvas/audio.js` `video.js` `stills.js` `display.js` `grain.js` | ~1,500 | native media elements that must *not* be remounted; remounting pauses playback |

That leaves the genuinely view-shaped code: `ui/panel.js`,
`ui/settings-schema.js`, `ui/sidebar.js`, `ui/menu.js`, `ui/dialog.js`,
`ui/search.js`, `ui/trash.js`, `ui/nowplaying.js`, `ui/mobile-header.js`, and
the view halves of `ui/appearance.js` and `ui/fonts.js` — about **5,000 lines
of which perhaps 3,000 is actual view**, the rest being pigment derivation and
font-table parsing. That is the entire surface a framework could shorten. A
rewrite would put 32,000 lines at risk to improve 3,000.

### You already built the framework for that part

`ui/settings-schema.js` (455 lines) plus `ui/panel.js` (456) is declarative,
data-driven UI: a control is an object with `id`, `tab`, `section`, `type`,
`get`, `set`, `when`. Adding a setting is one entry. `ui/controls.js` owns the
row's shape so four call sites cannot each get it nearly right. That is exactly
the pattern a framework sells — already here, already covered by
`tests/settings-panel.test.js`, and with no runtime attached.

### What the rewrite would cost that is not code

The README's opening pitch is that nothing is uploaded, nothing is fetched, and
there is no build step. `THIRD-PARTY.md` is four fonts long. `web/sw.js`
precaches a shell that is literally the source files. That property is the
project's identity *and* its best recruiting tool: clone, `server.bat`, refresh.
A framework means `node_modules`, a bundler, a dev server that is not the
production server, a version-skew story for the service worker, and a supply
chain for an app whose selling point is that it does not have one.

### The honest case for the other side

Two real arguments, and what to do about them instead:

1. **More people know React than know your `bus`.** True. The fix is
   documentation and a legible entry point, not a rewrite — see Part 2. The
   layering test already makes the architecture executable, which most React
   codebases cannot say.
2. **Hand-written DOM has no compile-time safety.** Also true, and the real
   gap. The fix is **JSDoc types with `checkJs`** and `tsc --noEmit` in CI:
   dev-only, zero runtime, zero build step, and it buys most of what the
   rewrite was being considered for. See Phase 5.

**Verdict: keep vanilla. Spend the rewrite budget on Parts 2–4 instead.**

---

## Part 2 — Make the repo runnable by somebody who is not you

This phase is blocking. Everything here is a reason a first-time contributor
gives up before writing a line.

### 2.1 Entry points — a documentation fix, not a porting job

`server.bat` and `save.bat` are the maintainer's workflow and stay exactly as
they are. Neither needs a cross-platform twin, because the gap they appear to
leave is smaller than it looks:

- **Running the app already works everywhere.** `python serve.py [port]` is the
  portable path and it is complete — document root, SPA fallback, `404.html`,
  threaded so the service worker's revalidation fetches do not deadlock, LAN
  bind and QR. The problem is only that the README leads with `server.bat`, so a
  contributor on Linux reads "Run it: `server.bat`" and stops. **Fix: `README.md`
  and `CONTRIBUTING.md` lead with `python serve.py`, and mention `server.bat` as
  the Windows convenience wrapper that it is.** Python 3 with no packages is a
  fair floor for a repo that ships no dependencies.
- **Version bumping does not need porting at all.** `save.bat` stamps
  `web/assets/js/version.js` and `VERSION` in `web/sw.js` — that is a *release*
  step, and releases are the maintainer's. A contributor never runs it; their PR
  simply does not touch either stamp, and you bump on merge. Say that explicitly
  in `CONTRIBUTING.md` ("do not edit `version.js` or the `sw.js` VERSION line —
  they are stamped at release"), which also protects the two lines `save.bat`
  matches by regex from being reformatted by a well-meaning patch.

Net: no new tooling. One README reordering and one paragraph in
`CONTRIBUTING.md`.

### 2.2 The first Linux CI run will fail, and that is the point

This tree has only ever been resolved by a case-insensitive filesystem. Every
`import './Foo.js'` that should be `./foo.js` works on Windows and 404s on
Linux. Run the suite on `ubuntu-latest` before publishing, not after (Phase 3).

### 2.3 Small hygiene

- Strip the UTF-8 BOM from `web/assets/js/version.js` and `web/sw.js` (the only
  two files that have one).
- Rename `research/old/gdrive implementation.md` — the space breaks naive
  tooling and shell one-liners.
- `.gitattributes` is already correct on line endings; nothing to do there.
- Repo is 35 MB of `.git` across 109 commits with no large-blob problem and no
  secrets in tracked files (checked). **No history rewrite needed.**

### 2.4 Licensing and format decisions to make before publishing

- `LICENSE` is **GPL-3.0**. Confirm that is deliberate. For a browser app,
  GPL-3.0 and AGPL-3.0 differ materially — a hosted fork of a client-side app
  triggers neither's network clause in the way people expect, but AGPL is what
  stops "someone reskins mbrd as a SaaS". Permissive (MIT/Apache-2.0) maximises
  adoption and gives up that. This is a values call, not a technical one; make
  it once and say why in the README.
- **`docs/mbrd-format.md` should carry an explicit line that the format is free
  to implement**, independent of the app's licence. A documented open container
  format is the most citable thing this project has, and licence ambiguity is
  what stops people implementing one.
- `THIRD-PARTY.md` is already exemplary and `tests/fonts-license.test.js`
  enforces it. Nothing to do.

---

## Part 3 — Contribution machinery

### 3.1 CI (`.github/workflows/ci.yml`)

Matrix `ubuntu-latest` × `windows-latest`, Node 20 and 22:

1. `npm test` — the existing 39-file suite, no install needed.
2. `node --check` over every tracked `.js` (catches syntax in files no test
   imports).
3. `python -m py_compile serve.py qr.py`.
4. Later: `npx tsc --noEmit` (Phase 5) and `oxlint` (3.3).

Ubuntu is non-negotiable for the reason in 2.2.

### 3.2 A live demo on every push (`.github/workflows/pages.yml`)

The app is a static site with no build. Publishing `web/` to GitHub Pages on
`main` is about ten lines of workflow and gives you a permanent demo URL — the
single highest-leverage thing for a project whose pitch has to be seen to land.
Note that per-PR previews need a third-party action or Cloudflare Pages; the
main-branch deploy is free and enough to start.

### 3.3 Files the repo currently has none of

- **`CONTRIBUTING.md`** — largely `AGENTS.md` rewritten for humans, plus: how to
  run it two ways, what the test suite actually covers, and a short list of
  *the invariants you can break by accident*: the layering graph
  (`tests/layers.test.js`), no browser globals at import time
  (`tests/imports.test.js`), every shipped asset in `SHELL`
  (`tests/sw.test.js`), every bundled font's licence beside it
  (`tests/fonts-license.test.js`), and `import/formats.js` being generated.
- **`CODE_OF_CONDUCT.md`** — Contributor Covenant 2.1, unedited.
- **`SECURITY.md`** — this matters more here than for a typical local app. The
  real attack surface is *parsing untrusted bytes from a `.mbrd` or a dropped
  file*: `storage/zip.js`, `mesh.js`, `import/artwork.js` and `optimize/opus.js`
  all hand-parse binary formats. Say that malformed-file crashes and
  path-traversal in the ZIP reader are in scope, give a private reporting route,
  and note that there is no server to attack.
- **Issue templates** — bug (browser, OS, and a `.mbrd` that reproduces),
  feature, and a **new-format** template, since that is the natural shape of a
  contribution here.
- **PR template** — mirror `AGENTS.md`: user-visible result, manual verification
  performed, screenshot or recording for UI, and an explicit callout for
  `.mbrd` schema / generated catalog / service-worker `SHELL` changes.

### 3.4 Linting — the one place to accept a dependency

`package.json` is already dev-only and declares no dependencies; adding a
*devDependency* breaks nothing the README claims. "Match the existing style"
does not survive contact with a second author.

Recommend **`oxlint`** (single binary, no plugin sprawl, closer to this repo's
spirit than the ESLint config graph). Rules limited to what has actually bitten:
no-unused-vars, no-undef, prefer-const, eqeqeq.

**Do not add Prettier.** It would rewrite all 31,645 lines and destroy the blame
you are about to want, and this codebase's formatting is consistent already.

### 3.5 Seed the first issues

The repo has unusually good first-issue shapes; write them out before you
publish so the front page is not empty:

- **A new arrangement.** `arrange/arrangements.js` is pure
  `(items, opts) => [{x, y}]` in input order. Best first issue in the codebase —
  no DOM, no state, testable, visible.
- **A new import format.** A branch in `classify()` plus an entry in
  `RENDERERS`, per `canvas/renderers.js`.
- **A new setting.** One entry in `ui/settings-schema.js`.
- **A palette tweak**, with `web/lab.html` as the ready-made bench.

Label the medium/low findings still listed in
`research/scalability-readability-audit-2026-07-27.md`, and the two items in
`research/future/`, as the roadmap.

---

## Part 4 — Split the files everyone will collide on

Do this **before** publishing. A split rewrites blame and conflicts with every
in-flight branch; doing it with contributors already working is far worse than
doing it now.

### 4.1 `main.js` — 1,962 lines, and every feature PR touches it

It is currently the bootstrap *and* the command surface *and* the view-perf
governor *and* the HUD painters *and* board-mode sync *and* title editing *and*
the save cooldown *and* the three-press board clear *and* rearrange *and* the
lifecycle. Proposed split, by the section boundaries already in the file:

| new module | from `main.js` | ~lines |
| --- | --- | --- |
| `main.js` | build `Viewport`, call every `init*()`, wire `cmds`, `window.mbrd`, lifecycle/startup, splash, capability warning | ~250 |
| `commands.js` | the `cmds` object (L72–275) | ~200 |
| `perf/view-perf.js` | the `viewPerf` IIFE and `armPerf` (L362–715, L1797) | ~370 |
| `ui/hud.js` | `paintHistory`, `paintZoom`, `paintSnap`, `paintCount`, `paintSave`, `zoomText`, the saved indicator (L750–1000, L1362, L1490–1520) | ~330 |
| `ui/board-title.js` | `paintMobileTitle`, `editMobileTitle`, `editTitleCard`, `editBoardName`, `TITLE_TAP_SLOP` (L1036–1215) | ~190 |
| `ui/board-actions.js` | `saveWithCooldown`, `resetSize`, `resetSave`, the three-press clear, `reloadBoard`, `restartApp`, `scaleFromItem`, `rearrange` (L1227–1800) | ~450 |

`cmds` is the single command surface the sidebar, keyboard and context menu all
drive — it earns its own file and its own test more than anything else in the
list.

**Constraint:** `main.js` is one of only three modules allowed browser globals
at import time (`tests/imports.test.js`). Every new module must export an
`init*()` and touch nothing at module scope, or the split creates a fourth
exception and the test rightly fails. Add each new module to
`tests/layers.test.js` as it lands.

### 4.2 `app.css` — 6,021 lines, 278 KB, one file

The worst merge-conflict surface in the repo: every UI change lands in it.
`CLAUDE.md` says "three files and no more" because `SHELL` in `web/sw.js` is a
hand-written list — but `tests/sw.test.js` already *walks* `assets/css`, so the
walk is the source of truth and only the hand list has to keep up. That makes
the constraint cheap to lift.

Split by subsystem, in load order, one `<link>` each in `index.html`:

```
base.css      reset, type, the sheet, paper, grain
canvas.css    #world, transform layer, shadows, grips, threads, grid
items.css     the per-type cards
sidebar.css   panel, tabs, sections, .field and its variants
chrome.css    dock, HUD readouts, now-playing bar, idle fade
mobile.css    the Mobile sheet, masthead, mobile-only rules
overlays.css  #ask, credits, search palette, context menu, trash
quality.css   the [data-quality] / [data-whimsy] tail — MUST stay last
```

Cost is seven extra requests, all HTTP/2-multiplexed and all precached by the
service worker on first load. The "must stay last" rule for `quality.css`
becomes *more* enforceable, not less, since it is now a file position in
`index.html` rather than a scroll position in a 6,000-line file — and a test can
assert it.

### 4.3 `tests/state.test.js` — 1,803 lines, 71 KB

`state.js` was already split onto six modules; the test was not. Mirror it:
`state-items`, `state-history`, `state-sticky`, `state-layout`,
`state-stacking`, `state-board`. Mechanical, and it is the file two
contributors are most likely to both edit on their first day.

### 4.4 Second tier — after publishing, as reviewable PRs

- `ui/appearance.js` (1,261) — separate token writing from the whimsy/palette UI.
- `canvas/renderers.js` (1,197) — one file per item-type family, `RENDERERS`
  staying as the index. This is the file a "add support for X" contributor
  opens first, so making it small matters.
- `storage/storage.js` (949) — Save, Export and autosave are three failure
  models sharing one file; the UI already has to say which is which.

### 4.5 Leave alone, deliberately

`canvas/input.js` (1,383) is one pipeline with exactly one active gesture, and
its header carries the full gesture map. Splitting it would create precisely the
class of bug the single-`g` invariant exists to prevent. Say so in
`CONTRIBUTING.md` so nobody arrives and "helpfully" splits it.

---

## Part 5 — Documentation as one source of truth

### 5.1 Three copies of the architecture will drift

Architecture prose currently lives in `CLAUDE.md` (23.9 KB), `AGENTS.md`
(4.5 KB) and `README.md` (22.1 KB). Move it into **`docs/architecture.md`** as
the one canonical copy — the layering graph, `state.js` as the only door, the
command/undo model, coordinates and culling, quality, the two layouts, assets
and persistence, the three modules that reach outside. `CLAUDE.md` and
`AGENTS.md` shrink to a pointer plus their own tool-specific conventions.
`README.md` stays user-facing and loses the internals.

This is also the document that answers "should I rewrite this in React" for the
next person who asks, so put Part 1's numbers in it.

### 5.2 Clear the root

A newcomer's first impression is `ls`. Currently that includes `readme_old.md`,
`PATCH-NOTES.txt`, `PLAN.md` (which opens `Greenfield project in
C:\Users\kosta\Projekti\mbrd (currently empty)`), and `icon-mockups/` — 35
tracked files of design scratch.

- `readme_old.md` — delete; it is in the history.
- `PLAN.md` — move to `research/old/`. It describes a project that no longer
  exists and carries absolute local paths.
- `PATCH-NOTES.txt` → `CHANGELOG.md`. Either keep writing it by hand as now, or
  have `save.bat` append the commit subject under the version it just stamped —
  it already knows both. A maintainer step either way.
- `icon-mockups/` → `research/old/icon-mockups/`, or drop it.
- `docs/mbrd-format.md` L425 names you personally in an open decision — reword
  for a public reader.

### 5.3 Keep `research/`, but frame it

25 files of internal handoffs, several addressed to you by name. **Keep them** —
recorded reasoning is the thing that makes a repo pleasant to join, and most
projects have none. But add `research/README.md` saying what the three tiers
mean: top level is open work, `old/` is history and is *not* authoritative,
`future/` is speculative. Without that, a contributor reads a superseded handoff
as current and builds the wrong thing.

### 5.4 Keep, unchanged

The module headers. Every file in this codebase opens with why it exists and
what it must not do, often at length. That is the single biggest reason a
stranger can work on this code, and it is worth stating in `CONTRIBUTING.md`
as an expectation of new modules rather than leaving it as a habit.

---

## Part 6 — Optional depth, after the repo is open

- **JSDoc types + `jsconfig.json` with `checkJs`, `tsc --noEmit` in CI.** One
  devDependency, no runtime, no build. Start with the pure layer —
  `geometry.js`, `measure.js`, `arrange/arrangements.js`, `storage/mbrd.js`,
  `storage/zip.js` — where types pay most and intrude least. This is the item
  that answers the only good argument for a framework rewrite.
- **Playwright e2e**, `npm run test:e2e`, not required for a PR. Four flows the
  unit suite structurally cannot see: pan/zoom, marquee select and drag,
  save → refresh → recover, and importing a file. A canvas app's regressions
  live exactly here.

---

## Sequencing

**Before publishing** (these are the gate):

1. Part 2 in full — README leads with `python serve.py`, BOMs, filename, licence
   decision. No tooling changes; the `.bat` files are untouched.
2. Part 3.1 CI, and fix whatever the first Ubuntu run surfaces.
3. Part 3.3 community files.
4. Part 5.1 and 5.2 — one architecture doc, clean root.
5. Part 4.1 and 4.2 — the `main.js` and `app.css` splits, which must not happen
   with contributors in flight.

**At publish:** Pages demo (3.2), seeded issues (3.5), lint (3.4).

**After, in the open, as reviewable PRs:** 4.3, 4.4, and Part 6.

Rough shape: the gate is a few focused days of work; nothing in it is
architecturally risky, because Part 1's conclusion is that the architecture is
not the problem. The problem is that the repo currently assumes its only reader
already knows everything.
