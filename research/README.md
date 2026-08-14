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
| `research/old/` | work **carried out or abandoned**, and the arguments behind what is open | no — history only |
| `research/future/` | **not started, and on nobody's list** | speculative |

`docs/` sits in here rather than at the repo root because everything written
about this app belongs in one place; it is the only directory under `research/`
that is not an argument, and the table above is what says so.

**One thing that used to be in here and is not.** The changelog source is
`patch-notes.md` at the repository root, not `research/patch-notes.md`. It is
neither an argument nor a specification — it is the record of what shipped, so
it fits none of the four rows above, and a file that fits none of the rows was
being filed here by habit rather than by the rule. `tools/gen-patch-page.mjs`
reads it from the root, `/patch` is generated from it, and it is still the only
place the changelog prose is written.

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

**One file, and this is the change worth understanding.** This level used to
hold five documents at once, each with its own status block claiming which of its
own items were done. On 2026-08-14 all five were read against the source, and
three of those blocks were wrong — every one of them in the same direction, and
none of them through carelessness. Work carried out under one document closes
items belonging to another, and nothing tells the other document. Five status
blocks is five things that can be wrong about the same tree.

So the open items are now in one register, and the documents that argued them are
all five in `old/` with the reasoning intact:

- `open-work-2026-08-14.md` — **the whole of what is open, in plain language.**
  Twenty items with an id each: five things somebody using the app would hit
  (**U1–U5**), four features that are not started (**L1–L4**), nine developer-only
  items (**S1–S9**), the design system's last unfinished axis (**V1**), and one
  decision about this directory (**B1**). Each says what it is, why it matters and
  where to look, and most name the document in `old/` that argued it — **four do
  not, and the register says so about itself.** U5 and L1's three new neighbours
  were added on 2026-08-14 out of a discussion rather than out of a document, so
  for those four the entry is the whole of the thinking rather than a summary of
  it, and the decisions that looked open are left open in the text instead of
  being settled by whoever was typing. Two other parts of it earn their place
  beyond the list. The first is **U1**, which
  is the only item on it writing bad data into files people keep: the tap path
  into Join never asks whether a thing may be joined, so a sticker can be written
  into `board.connections` as a pair nothing will ever draw, and **saved boards
  may already carry them** — so fixing it is a load-time cleanup as well as a
  guard. The second is its closing list of **things already done**, which exists
  because the failure this file was made to stop is somebody re-finding closed
  work in `old/`. The sharpest entry there is the search box: it rescans on every
  keystroke, that looks exactly like a defect, and it is a decision with the
  reasoning written next to it. Do not "fix" it.

- `plan-2026-08-14.md` — **the order the register is being worked in**, for the
  eighteen items picked out of it on 2026-08-14 (everything except **L1** and
  **B1**, both of which stay open and unscheduled). Ten batches, the decisions
  each one needs before it can start, and what to look at afterwards. Three
  orderings in it are load-bearing rather than preference and are argued at the
  top: **S8 before U5**, because the cut-out guess should borrow the decode the
  import path already does rather than add one to a path about to be rebuilt;
  **L4 before L3, report-only**, because both turn on the word *unreferenced* and
  an inventory that offers to delete orphans becomes a data-loss bug the moment
  stored versions can hold the only reference to one; and **S1 alone**, because
  it is the only item on the list that can change what every board looks like for
  everybody.

That is the whole of this level, and the second file is the exception this rule
asks for rather than a hole in it. **A second open document here is the thing to
argue about, not to add quietly** — the point of one register is that it cannot
disagree with itself, and that property is lost the moment there are two. The
argument for the plan is that it *cannot* disagree with the register, because it
carries no description of any item: only ids, order, and what to check. If a
sentence in it starts explaining what an item is, it has become a second register
and belongs back in the first. It also has an end — it goes to `old/` on the last
commit of the work it schedules, and the register outlives it.

The five that were here went down on the same commit, and the four in `old/` are
the unusual case the filing rule at the top does not cover: `ui-audit` went down
with **all four** of its findings still open. It is in `old/` because its
findings are carried above and what is left in it is the reasoning — which for
that document is the better half anyway. Its section on **what a driven browser
gets wrong about this app** is the thing to read before automating anything
here: more than half of what a driver reports as broken is the driving, the idle
fade takes `pointer-events: none` and eats the first click, and
`requestAnimationFrame` stops dead when the window is occluded, which made stored
connections look permanently undrawn for minutes and produced the most convincing
false finding of the pass.

`old/visual-audit-2026-08-12.md` and `old/build-and-framework-audit-2026-08-12.md`
went down nearly finished — one item each. Two things in them outlive their
lists. The visual audit's closing rule is the reusable one: **audit at the ends
of the whimsy axis, never at the middle**, because a literal is indistinguishable
from a token at the value it was copied from and obvious at every other, which is
where every fault it found had been hiding. And the build audit is still the
answer to *should this be on a framework* — it reaches that verdict independently
of `old/open-source-readiness-2026-08-02.md` Part 1 and agrees with it, which is
worth knowing when the question is asked again.

`old/share-link-2026-08-14.md` went down with **nothing in it built at all**, and
it is worth saying why it is not in `future/`, because that is where it was filed
first and it was wrong. Read literally, `future/` fits it — nothing started, and
it may never be. But `ui-audit` went to `old/` the same day with all four of its
findings open, on the rule that the register carries the items and the document
keeps the argument, and two documents of the same shape cannot take opposite
rules. The deeper reason is what `future/` is *for*: the two documents in there
are on nobody's list, and that is the property that makes the shelf mean
something. **A document the register lists is not speculative, whatever state the
work is in.** So the line is not "is it built" — it is *is anything at this level
pointing at it*.

Read it before proposing any way of sharing a board. Most of its value is the
two approaches it rules out and why, and both get proposed again by anyone who
has not read it: peer-to-peer cannot work for a link, because both people would
have to have the tab open at the same moment; and a link carrying the board
inside it cannot hold a single photograph, which in this app is the whole
payload.

*The paragraph this replaced argued the opposite, on the grounds that `old/` is
read as history and an unbuilt feature is not history. That is true and it is not
the point: what makes `old/` safe to read is the banner at the top of each
document saying what is still live in it, and this one carries one.*

`old/feature-run-2026-08-14.md` went down on the commit that finished the last
three of its ten, and it is worth reading for the departures rather than for the
list. It was written as a handover between sessions and briefed three features
file by file; the work followed it and disagreed with it in six places, each
recorded with the reason. The three that matter to anyone working near this code:
`state.ts` has no `tour:at` event and never needed one — which stop you are on is
not board data; the tour's *membership* commands belong with the tag writes in
`commands/item-meta.ts` rather than with the camera commands the brief put them
with; and the Playlist's prev/next may only be greyed with shuffle off and repeat
off, because `queuePrev`/`queueNext` wrap when they are pressed. It also carries
the one thing the run left open on purpose — a durable `meta.tilt`, which is the
only way an export can lean a card that has been culled, and is a `.mbrd`
addition to decide deliberately rather than as a side effect of a PDF. Its
verification section ends in three by-eye checks that were not run, the sharpest
of which is the exported file size with grain on.

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
