# research/

Why things are the way they are. Most of this was written before or during the
work it describes, so it records the reasoning — including the options that were
rejected and why — rather than the outcome. The outcome is in the code.

**The reasoning is not a specification, and one directory in here is.** Keep the
two apart: `research/docs/` is the current, authoritative description of what the
app *is* — the architecture, the `.mbrd` format, the layout-settings split, the
browser floor — and everything else under `research/` is the argument that led
there. When the two disagree, `docs/` wins; when `docs/` and the code disagree,
the code wins.

Four directories, and which one a file is in is the whole meaning:

| directory | what it holds | is it current? |
| --- | --- | --- |
| `research/docs/` | the **specifications** — what the app is | yes — authoritative |
| `research/` (top level) | work that is **still open** | yes — read this |
| `research/old/` | work that was **carried out**, or abandoned | no — history only |
| `research/future/` | **not started**, and may never be | speculative |

`docs/` sits in here rather than at the repo root because everything written
about this app belongs in one place; it is the only directory under `research/`
that is not an argument, and the table above is what says so.

The top level is deliberately short. Anything carried out moves down to `old/`
on the same commit that finishes it; if a document at the top level describes
something that already exists in the code, that is a bug in the filing and worth
a pull request on its own.

## Reading `old/` safely

`old/` is the useful half by volume and the dangerous half by accuracy. It
contains superseded plans, handoff notes written between working sessions,
audits whose findings have since been fixed, and design decisions recorded at
the moment they were made. Several documents are addressed to the maintainer in
the second person and assume context that is no longer true.

Treat every file in `old/` as *dated*. If it disagrees with the code, the code
is right. It is there because knowing why a thing was built the way it was is
worth more than the tidiness of deleting it — but it should never be the basis
for a change without checking the current source first.

## Current

- `scalability-readability-audit-2026-07-27.md` — all eight leverage items are
  closed; the medium and low findings it lists are the remaining work, and are
  the natural source of issues.
- `visual-audit-2026-08-12.md` — partly carried out. An element-by-element pass
  at all three whimsy stops, graded worst to best. Its spine is applied: the five
  corner tokens are now struck from `--radius`, so the Corner radius slider moves
  the whole interface rather than a third of it. **Five** items remain, listed
  under *The plan for what is left* — the sixth, the z-index table, is written
  and lives in `docs/architecture.md` under *The stack* — and two of the five are
  taste calls rather than patches. One thing to know before reading it at all:
  `overlays.css` was split into eight sheets after it was written, so every
  `overlays.css:NNN` in it points into a file that is gone, and its own opening
  note says so. Read the closing rule before auditing anything else here — the
  whole document is an argument for checking work at the ends of the axis rather
  than at the default board, which is where every fault in it hid.
- `build-and-framework-audit-2026-08-12.md` — **half carried out**, and it opens
  with a status block saying which half. An outside pass over the whole
  repository, written to answer whether this should be on a framework or in
  another language. It agrees with `old/open-source-readiness-2026-08-02.md`
  Part 1 and is not a reopening of it: the layer byte counts reproduce that
  document's finding, and the module-by-module argument for why `canvas/` resists
  a reconciler is still better made there. What is new is its Finding 1 — that
  document costed a bundler only ever as a rider on a framework rewrite, and
  priced apart from one it is the cheapest large win in the repository: 664 KB of
  JavaScript over 96 requests becomes about 174 KB over one, because 61.5% of the
  shipped bytes are comments. Read Findings 1 and 3 together, and read them as
  history: four of its eight items are done — CI, the bundle, the move to
  TypeScript, and the continuation of the `state.js` split — so most of what it
  measured describes the repository as it was on the morning it was written. What
  is still live is the other four: `initInput` as an explicit state machine, the
  CSP, a global error handler, and what `old/` should look like to a stranger.
  The annotations under `strict` are the open half of an item counted as done,
  and `tests/ts-debt.test.js` is where that is now measured rather than here.
- `ui-audit-2026-08-13.md` — **nothing applied.** A driven pass over the running
  app in a real browser rather than a runner: every toolbar tool, both lenses,
  the viewer, the player, the trash and the menus. Four findings, of which only
  the first is visible without hunting — a hover flyout clamped to the window
  when it should be clamped to the bar, which is why Arrange hangs 28px off the
  end. Read *What the harness got wrong* even if you skip the findings: more than
  half of what a driver reports as broken here is the driving, and two of the
  four causes are properties of this app — the idle fade takes
  `pointer-events: none` and eats the first click, and `requestBuild()` defers to
  a rAF that stops entirely when the window is occluded, which made stored
  connections look permanently undrawn. Its Finding 2 is also a `.mbrd` question
  and not only a UI one: the tap path into Join never asks `isJoinEnd`, so a
  sticker can be written into `board.connections` as a pair nothing will ever
  draw, and saved boards may already carry them.

`old/connections-2026-08-12.md` went down on the commit that carried it out, and
its status block is the part to read first: three of its own instructions were
departed from during the work, each with the reason. It is the argument for why
the *shape* of a connection answers the whimsy axis rather than only its corner
radius — lattice-bound at Harsh, taut at the middle, curving at Softish — and it
names the two things that make that safe: the router stays pure because the shape
is a parameter, and a cached route has to be dropped when the slider moves,
because no card moved and nothing else would notice. It also carries the reasons
behind the four affordances that went in with it (the draft line, the marked
connection, colour and weight, the focus lift), including the ones that were
argued down: no single-gesture drag-to-connect, and no membership in `selection`.

`old/fix-list-2026-08-12.md` went down on the commit that finished it, and its
status block is the part to read first: five departures from its own instructions,
one item left open, and one thing that turned out not to need doing at all. Read
it before the two things it is most likely to be re-derived from. The first is why
the two layout profiles are separate — a board built on the phone used to arrive
on the canvas still packed as a column, because `completeLayout()`'s Desktop
branch fell back to the *live* item, which at the moment of a switch is whatever
the layout being left made of it. The second is why three defects in it are the
same defect: the Feed replaced the world-space Mobile board and did not inherit
its paper grain, its scroll-gated pen, or its right-click menu. A fourth may
still be out there and nobody has swept for one.

Its most useful negative result is decision 1 in §4.5. The maintainer approved
vendoring third-party libraries locally, and then nothing was vendored — because
every feature on the approved list turned out to be dependency-free. Eleven
document formats are read by `import/document.js` and `ui/documents.js` with no
library at all, on the ZIP reader this repo already owns because a `.mbrd` is a
ZIP. Read that before reaching for a package.

`old/mobile-feed-2026-08-09.md` went down on the commit that carried it out — the
repurposing of the Mobile layout into a native-scrolling DOM feed of images and
video (`ui/mobile-feed.js`, the pure `arrange/feed-layout.js`, and the top-level
`board.feedOrder` its edit mode persists). Read it for why the feed is a separate
DOM surface rather than the world-space canvas, and why the manual order is a
top-level key rather than a per-layout one.

`old/code-audit-2026-08-06.md` and its plan went down the same way, on the commit
that fixed all twenty-one of their findings. Read the audit's "What was checked
and found sound" before re-auditing anything near the load path, the not-found
board or the import cap: nine plausible-looking findings were refuted there with
reasons, and re-finding them costs hours. The plan's status block lists the three
places its own instructions were departed from and why, which is the half most
worth reading if a fix looks wrong.

`old/fences-2026-08-04.md` went down on the commit that carried it out, which is
the rule above being followed rather than described. Read it for why fences are
an item rather than a top-level key, and why membership is measured on Desktop
geometry alone — both are decisions the code cannot explain on its own. It also
carries an amendment written the same day, which is the more useful half to read:
its Decision 3 traded away Fences' own draw-a-rectangle gesture on a cost that
turned out not to exist, because the marquee already *was* that gesture. Its v2
list is now roll-up and per-fence tint, and its two open questions are still open.

This section listed three for a while, two of which (`code-audit-2026-08-02.md`
and its plan) had already moved to `old/`. That is precisely the filing bug the
rule above describes, found by reading the two against each other; both are in
`old/` and this list now says so. `toolbar-2026-08-03.md` went down with them on
the commit that carried it out.

Worth knowing about one that is *not* here. `old/open-source-readiness-2026-08-02.md`
is the plan this repository's public layout, CI, linting, typecheck and file
splits were carried out from, and it moved down the moment it was finished -
which is the rule above being followed rather than described. Read it for the
reasoning behind *not* rewriting the app on a UI framework: the line counts are
in it, and it is the answer to a question that will be asked again.

That sentence was wrong about a quarter of itself for ten days, and the way it
was found is the argument for keeping this index in prose rather than as a list
of filenames. CI was on that plan's carried-out list and had never been written;
`build-and-framework-audit-2026-08-12.md` Finding 3 is what noticed, by reading
the claim against the tree instead of against the plan. It is true again now —
`.github/workflows/ci.yml` exists — so the line stands as written rather than
being corrected. **A carried-out list is a claim about the code, and it decays
the same way a comment does.**
