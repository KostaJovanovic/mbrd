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

**One register, and this is the change worth understanding.** This level used to
hold five documents at once, each with its own status block claiming which of its
own items were done. On 2026-08-14 all five were read against the source, and
three of those blocks were wrong — every one of them in the same direction, and
none of them through carelessness. Work carried out under one document closes
items belonging to another, and nothing tells the other document. Five status
blocks is five things that can be wrong about the same tree.

So the open items are in one register, and the documents that argued them are all
five in `old/` with the reasoning intact. Three files at this level now, the
register and two subject documents:

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

- `mbrd-format-2026-08-14.md` — **what is left to settle in the container while
  it is still free to change.** Most of it is done and listed as done; the one
  thing still open is that a board's history is a blob of escaped JSON nested
  inside `board.json`, and it wants to be `timeline/base.json` plus a
  `timeline/steps.jsonl` you can read a line of. It was blocked on the
  timeline's phase 3 and is not any more. Read the window it opens with before
  proposing anything else: nothing has shipped, so `version` stays `1` and no
  compatibility is owed yet — and read *Not now* and *Never* before proposing
  something it has already ruled out, which for Zstd, encryption and a binary
  `board.json` is most of the ideas that come up.

- `ui-clutter-2026-08-15.md` — **seven findings about the interface, one of them
  carried out.** Audited by driving the real app rather than by reading the CSS,
  which is the rule that made it worth writing. Its diagnosis is the part that
  outlives the list: no surface in the app is overloaded on its own, and the
  weight is that one command rests on three or four surfaces at once under two
  or three names — which the structural rules in `CLAUDE.md` permit, because
  nothing in them bounds how many surfaces a command may appear on. Finding **A**
  is done (the canvas menu is six rows, and `canvasEntries()` carries the
  argument); **B–H** are open, in the order the *Sequence* section gives.

- `simplification-2026-08-18.md` — **two whole-tree sweeps, one for duplication
  and dead code and one for circuitous routes, and the order to clear them in.**
  Seven batches, nothing touching the `.mbrd` schema, a generated catalogue or
  `SHELL`. Like the two above it, it carries open items the register has never
  heard of, and adds to the debt the closing section of this file describes. Its
  list is the disposable half. The part worth reading whatever you do with the
  items is the table it opens with: ten places where a module header argues a
  rule — usually one learned from a real bug — and a sibling site still does the
  thing the header warns against, because the knowledge stayed in the file that
  learned it. Two of that document's own claims were wrong before they were
  checked, and it records both rather than quietly dropping them; one of them is
  the `isDev()` trap `CLAUDE.md` already warns about.

`patch-notes-full.md` sits at this level too and is **not open work** - it is an
archive, and the only file here that argues nothing. It holds every release at
the length it was first written at, internal work included, and it was split off
when `/patch` was cut down to the entries a person using the app would notice.
Nothing generates anything from it and nothing keeps it in step; the live source
is `patch-notes.md` at the repository root.

Three documents that were at this level went down to `old/` on 2026-08-15.

`plan-2026-08-14.md` was **the order the register was worked in** — eighteen
items in ten batches, everything except **L1** and **B1**. It said in its own
text that it goes to `old/` on the last commit of the work it schedules, and all
ten batches have run; the one thing not finished under it, the rest of **S1**, is
carried by the register, which is exactly the split that lets the plan end. It is
worth reading for the three orderings it argues at the top, because each is a
trap rather than a preference: **S8 before U5**, because the cut-out guess should
borrow the decode the import path already does rather than add one to a path
about to be rebuilt; **L4 before L3, report-only**, because both turn on the word
*unreferenced* and an inventory that offers to delete orphans becomes a data-loss
bug the moment stored versions can hold the only reference to one; and **S1
alone**, because it is the only item on the list that can change what every board
looks like for everybody.

`timeline-2026-08-14.md` was **the design for T1**, the editable timeline, and
the largest thing ever asked of this app: every change becomes a step in the
board file, you can change one in the past and have the rest rebuild on top of
it, and it takes over the stored half of undo. **All five phases were built on
the day it was written**, which is why it is down there — the same file carries
what was built and where it diverged from the plan, because a design nobody
updated after building it is worse than no design. Two things in it are worth
knowing without touching the feature: the app is unusually well suited to it in
two specific ways (arrangements are already deterministic, and assets are
content-addressed so imports replay without touching a disk), and the
**reference union grows a fourth member**, which is the part most likely to
cause real data loss if a later change forgets it. What the register still
carries for T1 is the tail: more commands converted from sealed to editable, a
saved version ceasing to hold its own copy of the board, reordering and *insert
here*.

`feedback-plan-2026-08-14.md` was here and is not any more. It was a work queue
of twelve things seen on screen, it said in its own text that it went to `old/`
the day the twelfth was finished, and that day was the day it was written — all
twelve were built. It is `old/feedback-plan-2026-08-14.md` now, and it is worth
reading for one thing rather than for the queue: the section added at its head
records that **four of its twelve diagnoses were wrong**, including two it stated
confidently. The general lesson is in the plan's own rule and is the reason it
holds: *do not fix this by reading the CSS* — every one of the four was found by
opening the app, and every one of them had a plausible wrong answer available to
anybody who did not.

`cuelume-2026-08-15.md` was **the design for L5, interface sounds**, and it was
written and retired inside a day like the feedback plan above it. The app made no
sound of its own; it now makes eleven, synthesised from a table of numbers rather
than played from files, and the document is the argument for every choice in
`web/assets/js/cuelume/`. Three things in it are worth knowing without touching
the feature. **The whimsy axis carries sound as character rather than as
volume** — the same rule the visual audit reached about shape, and the reason
there is one recipe per cue *per tier* instead of a loudness control wearing a
second name. **Two thirds of Cuelume was taken and the last third thrown away**:
`bind()` is four capture-phase listeners on `document` and a second markup
contract beside `data-cmd`, which `CLAUDE.md` forbids in as many words. And the
one claim in it that no test can make is about a **phone** — whether
`audioSession = 'ambient'` really leaves somebody's background music alone. That
is now flow 9 of the release checklist in `docs/browser-support.md`, and it is
still unverified.

What it leaves genuinely open is the table itself. Eleven cues across three tiers
were assigned by reading adjectives, which is the method the feedback plan proves
wrong four times out of twelve; `web/lab-sound.html` is the bench for settling it
by ear, and the assignment is expected to move.

That is the whole of this level. **A second open document here is the thing to
argue about, not to add quietly** — the point of one register is that it cannot
disagree with itself, and that property is lost the moment there are two. The
plan was the clean version of the exception: it *could not* disagree with the
register, because it carried no description of any item, only ids, order and what
to check — and it had an end, which it kept, going to `old/` on the last commit of
the work it scheduled. The feedback plan is the proof that the end is real rather
than a promise: it was written and retired inside one day.

`cuelume-2026-08-15.md` was the third version of that exception and it kept the
same bargain, which is why it is only mentioned here in the past tense. It was
the one the register asked for outright: four rows carry their own argument
because no document exists for them, and the register says of itself that
**writing a proper document for one of them is the first half of doing it, not a
detour**. L5 was added with its document, so the row was a summary and the
argument sat beside it — the way every unbroken row in that table reads. It could
disagree with the register in a way the plan could not, since it did describe its
item; what kept that cheap was the end, and it went down to `old/` on the commit
that shipped the feature, one day after it was written.

**The two subject documents are the untidy version of it, and this is the debt to
be honest about.** `mbrd-format` and `ui-clutter` each carry open items the
register has never heard of — a history that wants to come out of `board.json`,
and seven findings about the interface — so there are three places at this level
that can be wrong about the same tree, which is the number this whole
reorganisation cut to one. Neither belongs in `old/` while its items are open,
and neither is speculative enough for `future/`. The fix is to give each of them
a row in the register the way T1 has one, with the document keeping the argument;
until somebody does that, read them as what they are — open work filed beside the
register instead of inside it.

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
