# research/

Why things are the way they are. Most of this was written before or during the
work it describes, so it records the reasoning — including the options that were
rejected and why — rather than the outcome. The outcome is in the code.

**None of it is a specification.** For that, read `docs/` (the `.mbrd` format,
the layout-settings split, the browser floor) and `docs/architecture.md`.

Three tiers, and the tier is the whole meaning:

| directory | what it holds | is it current? |
| --- | --- | --- |
| `research/` (top level) | work that is **still open** | yes — read this |
| `research/old/` | work that was **carried out**, or abandoned | no — history only |
| `research/future/` | **not started**, and may never be | speculative |

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
