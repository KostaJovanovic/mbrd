# Build, language and framework audit — 2026-08-12

An outside pass over the whole repository, asked for in these terms: *is there a
better way of doing this than JavaScript, maybe a framework* — with the
instruction to ignore what the project says about itself and answer from the
code.

So the code is what was read. This document reaches the same verdict as
`old/open-source-readiness-2026-08-02.md` Part 1 on the framework question and
disagrees with it on something that document never separated out, which is the
half worth reading.

**Half of its list has since been carried out — see *Status*, immediately
below.** It stays at the top level because the other half has not; read the
status block before acting on anything here, because four of the eight items now
describe the repository you are already standing in.

---

## Status — what has since been carried out

Written the day this document was, in the ten commits that followed it. The
ordered list at the foot is annotated the same way; this is the summary.

**Item 1, CI — done** (`fea074a`). `.github/workflows/ci.yml`, on
`ubuntu-latest`, which is the point rather than a default: it is the
case-sensitivity leg the repository never had, and it runs the suite with
nothing installed so that *"`npm test` needs no install"* goes on being asked
rather than assumed. Finding 3's premise is therefore gone, and so is the
sentence in `CLAUDE.md` it quotes.

**Item 2, the bundler — done** (`c85cf85`, wired in `317d4e0`). `npm run build`
is one esbuild line, `index.html` loads `assets/app.js`, and `SHELL` in
`web/sw.js` precaches that one artifact in place of the ninety-six modules it
used to name — `tests/sw.test.js` no longer walks the sources, because they are
no longer shipped assets. Finding 1's trade landed on the side this document did
not predict: **the sources still ship beside the bundle**, so view-source on the
deployed app is still this repository. What was dropped instead is the source
map (`3797da6`) — 2.9 MB rewritten and committed on every build, for a devtools
convenience nobody reviews.

**Item 3, TypeScript — done as the move, not as the types** (`317d4e0`). 104 of
106 modules are `.ts` under `strict`; `version.js` and `optimize/media-worker.js`
stay `.js` for reasons that would break silently otherwise, and `jsconfig.json`
is replaced by `tsconfig.json`, whose header is now the better statement of
Finding 2's argument than Finding 2 is. But a mechanical rename left **4,935
errors under `strict`**, so the 103 unannotated modules carry `@ts-nocheck` and
`tests/ts-debt.test.js` holds the count with a ceiling that may only fall. What
the typecheck asserts today is that everything *not* on that list is clean.
**The annotations are the open half of this item**, and they are most of the
value Finding 2 was asking for — the large stateful modules it names are exactly
the ones still carried unchecked.

**Item 7, continue the `state.js` split — done** (`6e28f0e`). 2,607 lines to
1,260, onto five new base modules — `board-schema.js`, `onboarding.js`,
`clipboard.js`, `connections.js`, `trash.js` — plus selection into
`board-store.js` and board-wide snapping into `layout.js`. Every one is in
`BASE` in `tests/layers.test.js` and `DEBT` is still empty. The four undoable
meta writes Finding 4 did not mention are one `patchMeta()`.

**Still open: 4, 5, 6, 8.** `initInput` is untouched and remains the largest
single risk named here. The CSP was in hand at the time of writing and is not
this document's to record. The global error handler and the question of what
`old/` should look like to a stranger have not been started.

**Finding 7 is unaffected and Finding 4's other two rows have moved:**
`createCommands` is where it was, `state.js` is at 1,260 rather than 2,607.

---

## What was measured, and found sound

Stated first because the findings below are the findings of a codebase that got
most of it right, and reading them without this is reading them wrong.

| | measured |
| --- | --- |
| tests | 1,113 passing, 9.2 s, no install, no dependencies |
| layering | enforced by `tests/layers.test.js`, not by convention |
| `!important` | **12**, across 519 KB of CSS |
| design tokens | 245 in `tokens.css` |
| empty `catch` blocks | **0**, in 187 catches |
| `innerHTML` on user text | **0** |

Three things are better than the norm and not by a little:

**The markdown renderer is safe by construction.** `ui/markdown.js` puts every
scrap of text in through `textContent` and builds every element through
`createElement`. There is no escaping to get wrong because there is no escaping.
The one string that reaches an attribute is a link's `href` and it goes through
`linkURL`. This is the correct design and most hand-written markdown renderers
do not have it.

**The undo engine is priced.** `history.js` carries two limits, not one, because
an entry closes over whatever its undo needs and a count says nothing about what
a whole-board command retains. The `weight` field and `WEIGHT_LIMIT` are a
consideration most command stacks never reach.

**The pre-paint inline script is threat-modelled.** The appearance restore in
`index.html` re-filters `--token` keys and values against a grammar before
setting them, because a poisoned same-origin store could otherwise land
`url(...)` and fire an outbound request before `ui/look.js` exists to stop it.
That is a real attack, correctly anticipated, and the guard is held in step by
`tests/appearance.test.js`.

None of what follows is a complaint about any of that.

---

## Finding 1 — "no framework" and "no build step" are two decisions, and only one of them was ever priced

*Carried out. The build step exists, `index.html` loads `assets/app.js`, and the
numbers below are what the repository looked like before it. Kept because the
argument for pricing the two decisions apart is the finding, and it will be
asked again.*

This is the substantive disagreement with `old/open-source-readiness-2026-08-02.md`,
and it is a disagreement about scope rather than about conclusions.

That document costed a bundler correctly but only ever as a *rider on a
framework rewrite*: "A framework means `node_modules`, a bundler, a dev server
that is not the production server, a version-skew story for the service worker."
Every one of those is true of a framework. Only two of them are true of a
bundler on its own, and the argument was never run with the framework taken out
of it.

Run separately, the numbers are these. Measured over the 96 modules actually
reachable from `main.js`, compressed per file because that is how they are
served:

| | as served | bundled + minified |
| --- | --- | --- |
| JS transferred (brotli) | **664 KB** | ~174 KB |
| JS requests | **96** | 1 |
| import waterfall | 4 levels deep | 1 |
| JS parsed on cold load | 2,134 KB | ~756 KB |

Plus ten render-blocking stylesheets, 141 KB brotli, and no `modulepreload`
anywhere in `web/` — so the browser cannot start fetching level 2 of the graph
until level 1 has arrived and been parsed.

The 174 KB figure is not a guess and not a framework's marketing number: it is
this repository's own JavaScript, comments stripped and concatenated, run
through brotli. The 3.8× is the cost of shipping the source tree as the
artifact.

### Why the multiplier is that large

**61.5% of the shipped JavaScript bytes are comments.** 1,312 KB of English
prose, downloaded and parsed by every visitor on every cold load. By line the
ratio is 22,575 code to 22,458 comment — very nearly one to one.

That is the deliberate house style and it is not, in itself, the finding. The
finding is that with no build step the style is paid for by the *user* rather
than by the repository. A bundler decouples the two: the source can stay as
discursive as it likes and the artifact stops carrying it.

### What this costs to fix

```
esbuild web/assets/js/main.js --bundle --minify --outfile=web/dist/app.js
```

One dev dependency, alongside the three that are already there. No framework, no
source change, no architectural decision, no runtime dependency, and
`THIRD-PARTY.md` stays four fonts long because nothing ships.

Three of the four costs the earlier document listed do not apply:

- *`node_modules`* — already present, for `oxlint`, `tsc` and Playwright.
- *a dev server that is not the production server* — `serve.py` can serve
  `web/` unbundled exactly as it does today. The bundle is a release artifact,
  and "edit a file and refresh" survives untouched.
- *a supply chain* — nothing reaches the browser. esbuild is a build-time
  binary in the same position as `oxlint`.

The fourth is real and has to be answered: **`web/sw.js` precaches a shell that
is literally the source files.** A bundle means the `SHELL` array names the
artifact instead, which is fewer entries and not more, but it must be stamped in
step with the build — `save.bat` already stamps `VERSION` there by regex, so
this is the same mechanism with one more line, not a new one.

There is also a genuine loss to weigh, and the earlier document is right that it
is the project's identity: **view-source on the deployed app stops being the
repository.** The mitigation is a source map, which esbuild emits with a flag,
and the repository is public regardless. Worth stating plainly rather than
waving away — it is the only thing on this list that is a trade rather than a
win.

---

## Finding 2 — the typecheck was the right answer to the right question, and is scoped away from where it matters

*Half carried out. Option 2 below was taken: `jsconfig.json` is gone, every
module is `.ts` and `tsconfig.json` is `strict` over the tree. The nine-file
scope this finding is about no longer exists — but the modules it names are
still unchecked, now behind `@ts-nocheck` and a falling ceiling rather than
behind an `include` list, so the finding's substance stands and only its
mechanism has changed.*

`old/open-source-readiness-2026-08-02.md` Part 1 named the one real argument for
a framework rewrite — "hand-written DOM has no compile-time safety" — and
answered it correctly: JSDoc, `checkJs`, `tsc --noEmit`. That was carried out.
`jsconfig.json` exists and its header makes the argument well.

It covers **nine files**. Its own comment says why: the pure layer, "where a
wrong type is a silently wrong board rather than a visible mistake."

That reasoning is sound for choosing where to *start* and it is not a resting
place. The nine files are 9 of 102, and they are the small, pure, heavily tested
ones — the least likely to hold a type error in the first place. `state.js`,
`canvas/input.js`, `canvas/items.js` and `commands.js` are 8,358 lines between
them, are where every mutation and every gesture lives, and are unchecked.

Two ways forward, and they are the same decision as Finding 1:

1. **Widen `include` a module at a time**, as its header instructs. Costs
   nothing, needs no build step, and stalls at the point where JSDoc annotation
   becomes more typing than a type annotation would be — which is exactly at the
   large stateful modules this is meant to reach.
2. **Rename `.js` to `.ts` and turn on `strict`.** This is the honest answer to
   "is there a better language than JavaScript for this," and the answer is yes,
   and it is TypeScript, and this repository is already 90% of the way there
   because `tsc` is already in the loop. It requires a build step — which is
   Finding 1. Treat them as one decision.

Nothing else in the language question is close. **Rust or WASM: no.** The
bottleneck is DOM node count and decoded-image memory — `viewStats()` in
`canvas/items.js` measures precisely that, `naturalWidth × naturalHeight × 4`,
which is the right thing to be measuring. The only compute-bound surfaces are
the palette extractor, `optimize/`, and the ZIP CRC, and all three are already
fast enough that no user waits on them.

---

## Finding 3 — there is no CI, so none of the above is enforced

*Carried out, and first, exactly as the closing list asks. There is a
`.github/workflows/ci.yml` and it runs on `ubuntu-latest`. Everything below is
the argument for why, which is worth keeping because the one thing CI still does
**not** do is named at the end of it and is still true: the host deploys on push,
triggered by the push and not by the workflow, so a red run does not block a
deploy until somebody sets branch protection.*

`CLAUDE.md` says it plainly: "There is no CI, so nothing runs these for you and
a green `npm test` is not the whole bar." There is no `.github/` directory.

1,113 tests that nothing runs on push are documentation. `npm run lint`,
`npm run typecheck` and `npm run test:e2e` are all marked optional and manual,
which means in practice they run when somebody remembers.

`old/open-source-readiness-2026-08-02.md` listed CI among the things it carried
out. It is the one item on that list that did not land, and the README's line
about that document — "the plan this repository's public layout, CI, linting,
typecheck and file splits were carried out from" — is currently wrong about a
quarter of itself. Worth correcting there whichever way this goes.

*It went the other way: the line is now right rather than corrected. CI exists,
so the sentence describes the repository again, and `research/README.md` says
where it came from instead of what it claimed.*

Twenty lines of workflow YAML converts the whole test suite from a claim into a
guarantee, and it is the prerequisite for Findings 1 and 2 both: a bundle nobody
tests is worse than no bundle.

---

## Finding 4 — three functions hold the risk

Not a style note. These are where the next real defect will be.

| | lines | shape |
| --- | --- | --- |
| `initInput` (`canvas/input.js:477`) | **1,509** | one closure, ~20 mutable `let`s, a 230-line `pointerdown` and a 270-line `pointermove` |
| `createCommands` (`commands.js:306`) | 831 | one closure returning the whole command surface |
| `state.js` | 2,607 | ten concerns, two lifted out so far |

*The third row is settled: `state.js` is 1,260 lines and seven more concerns are
out of it (`6e28f0e`). The first two are as measured, and `initInput` is now the
whole of this finding.*

`initInput` is the one to act on. `spaceDown`, `midButtonDown`, `midDragged`,
`armSelect`, `cardTap`, `lastEmptyTap`, `emptyTapCandidate`, `pressTimer`,
`longPressMenu`, `hover`, `g` — that is a finite state machine written as a bag
of booleans and nullable objects, where the legal combinations exist only in the
author's head and the illegal ones are reachable. The gesture invariant the
module is built on ("exactly one active gesture") is asserted nowhere; it is
maintained by every branch remembering to.

Making it explicit is a mechanical refactor, not a redesign: one `mode` field
over `idle | pan | marquee | move | resize | press`, the per-mode data hanging
off it instead of off the closure, and transitions in one table. The existing
pure helpers at the top of the file — `isDoubleTap`, `needsSelectionBeforeMove`,
`drewRectangle`, `resizeHandleAction`, `readWheel` — are already the right shape
and already tested, which is what makes this safe to do.

On `state.js`: `scalability-readability-audit-2026-07-27.md` records splitting it
from 3,202 lines to 1,806, "down 44%", into six modules. It is now **2,607** —
it has regrown by 44% of what the split removed. That is not an argument against
the split, which was right; it is an argument that the split needs to continue
rather than be treated as done. `board-store.js`'s own header names the
remaining candidates — the clipboard and serialization are the next clean cuts.

---

## Finding 5 — no Content-Security-Policy on the production deploy

`wrangler.jsonc` sets `assets.directory` and `not_found_handling` and nothing
else. There is no `_headers` file. Grepping `web/` and `tools/` for
`Content-Security-Policy` returns nothing.

This app opens files it did not write, renders markdown out of them, and embeds
third-party iframes for YouTube and Spotify. The XSS thinking is already done
and done well (see *found sound*, above) — a CSP is that same reasoning written
somewhere the browser enforces it, so that a future contributor who reaches for
`innerHTML` on a note's text gets a console error rather than a shipped bug.

Two things to know before writing one:

- The two inline `<script>` blocks in `index.html` need `'sha256-...'` hashes in
  `script-src`. They cannot be moved to files: the whole point of the first one
  is that it runs before first paint.
- `frame-src` has to allow exactly the embed hosts `canvas/embed.js` uses and
  nothing else, which is a stricter and more useful statement than the app can
  make in JavaScript.

`img-src`, `media-src` and `connect-src` are the ones that would have caught
AUD-15's attack class outright.

---

## Finding 6 — nothing surfaces an error to the person using it

`emitter.emit` in `util.js` wraps each handler in a try/catch and calls
`console.error`. That is the right call for the bus — one broken subscriber must
not take the rest down with it.

The consequence is that a subscriber that throws on every `geom` event fails
silently and forever, into a console nobody has open. There is no
`window.onerror` and no `unhandledrejection` handler anywhere in `web/`.

For an app with no account, no telemetry and no server, the failure mode is a
user watching a board stop responding with nothing to read and nothing to send.
The fix is small and fits the project: a global handler that raises the existing
`toast()`, names the module, and — the part that matters — checks that the
autosave still ran. There is no need to phone anywhere. Telling the person their
work is safe is most of the value.

---

## Finding 7 — filing

One, and it is a presentation call rather than a defect.

**`research/` is 74 tracked files, 1.17 MB**, of which `old/` is the bulk. The
README argues for keeping it and the argument is good; the volume is still the
single loudest signal to an outside reader about how this was built, and it
arrives before any of the code does. Worth considering an `old/` on its own
branch, or a one-line date and outcome in the README index with the bodies moved
out. This is a presentation call, not a correctness one, and it is last on this
list for that reason.

Nothing else in the filing is wrong. `research/docs/` is where the README says
it is and every reference to it — `README.md`, `CONTRIBUTING.md`, `CLAUDE.md` —
points at the right path. An earlier draft of this document claimed otherwise;
it was reading a mangled directory listing and not the tree.

---

## The framework question, answered from the byte counts

Measured by layer, over 102 modules:

| layer | bytes | would a view framework help? |
| --- | --- | --- |
| `ui/` (38 files) | 635 KB | **yes, this is the whole of it** |
| `canvas/` (21 files) | 602 KB | no — it would be actively worse |
| root (19 files: `state`, `layout`, `commands`, `mesh`, `geometry`, `web-route`…) | 518 KB | irrelevant |
| `storage/`, `import/`, `optimize/`, `arrange/`, `stickers/`, `perf/` | 383 KB | irrelevant |

Which reproduces `old/open-source-readiness-2026-08-02.md`'s finding on a
different measure and a great deal of growth later: **roughly a third of the
code is in the only place a framework speaks to, and two thirds would be put at
risk to reach it.**

The `canvas/` row is the strong claim and it holds up under reading. `sync()` in
`canvas/items.js` mounts off a spatial index, rations new node construction
against a build budget, defers the remainder to the next frame with exactly one
catch-up in flight, throttles the detach pass while the view is moving, and
refuses to detach the one `<video>` that is currently sounding. A reconciler
owning that tree does not do those things; it is the thing you would spend the
migration escaping. Same for `viewport.js`'s single composited transform and
`grid.js` painting via `background-position`.

**And `ui/settings-schema.js` plus `ui/panel.js` is already a declarative UI
framework** — 589 and 456 lines, controls as data with `get`/`set`/`when`,
absence rather than disabling, slots as the escape hatch, covered by
`tests/settings-panel.test.js`. That is the useful part of the thing a
migration would be buying.

So: **do not migrate `ui/` to React.** The state model underneath it — one bus,
one mutation door, commands that know their own inverse — is sound, tested, and
the part a rewrite would most likely damage. The two changes actually worth
making in `ui/` are much smaller:

1. **Add an element builder.** There are 137 bare `createElement` calls in `ui/`
   and 104 in `canvas/`, with no `h(tag, props, ...children)` helper anywhere.
   `ui/controls.js` already owns the *row's* shape for exactly this reason; the
   same argument applies one level down. Twenty lines, and it deletes most of
   241 call sites' worth of append chains.
2. **Rename `el` in `util.js`.** It is `document.getElementById`. The moment an
   element builder exists, `el` is the name it wants, and having the wrong
   function hold it is a papercut on every file that imports both.

If reactivity is wanted for *new* chrome, Lit or Solid (~10 KB, no virtual DOM,
operates on real nodes) composes with the existing DOM without a migration.
That is an option to keep open, not a recommendation to act on.

**And the thing larger than any of this:**
`future/code-audit-tauri-readiness-2026-07-26.md` is pointed at a better target
than the framework question is. Real filesystem access, no IndexedDB quota
ceiling, and native save/open dialogs are a bigger change to what the app *is*
than any view-layer decision, and the no-dependency architecture is what makes
that port cheap. If there is one budget, it should go there.

---

## The list, in order

1. ~~**Add CI.**~~ **Done** — `fea074a`. ~20 lines. Everything below depended on
   it, and it went first for that reason.
2. ~~**Add a bundler for the release artifact.**~~ **Done** — `c85cf85`, wired
   in `317d4e0`. `sw.js`'s `SHELL` moved in step, and the sources ship beside
   the bundle rather than being replaced by it.
3. **`.ts` and `strict`** — **the move is done** (`317d4e0`), the annotations
   are not. `jsconfig.json` is gone; the second half of this item is now
   measured by `tests/ts-debt.test.js` rather than by this list.
4. **Turn `initInput` into an explicit state machine.** *Open.* The pure helpers
   at the top of the file are already the right shape.
5. **Write a CSP.** *Open here* — hash the two inline scripts; pin `frame-src`
   to the embed hosts.
6. **A global error handler that raises a toast and confirms the autosave.**
   *Open.*
7. ~~**Continue the `state.js` split.**~~ **Done** — `6e28f0e`. 2,607 lines to
   1,260, onto five new base modules.
8. **Decide what `old/` should look like to a stranger.** *Open.* Cosmetic, and
   last.

Items 1, 5 and 6 are each an afternoon and none of them touch application code.
Two of those three are still true.

## What this document does not claim

It was not written with the app running. Everything above comes from reading
`web/`, running `node --test`, and measuring the tree; no board was loaded, no
profile was taken, and the three findings about *load* are arithmetic over file
sizes rather than a waterfall off a real network. The compression figures are
`zlib.brotliCompressSync` at default quality, which a CDN will beat slightly, so
664 KB is if anything the generous reading of the current state.

`old/open-source-readiness-2026-08-02.md` remains the better document on the
framework question proper: it has the module-by-module argument for why
`canvas/` resists a reconciler, and this one only confirms it from the outside.
What is new here is that the bundler was never costed apart from the framework,
and that when it is, it is the cheapest large win in the repository.
