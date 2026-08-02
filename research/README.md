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

Three documents, which is the point of the tier:

- `code-audit-2026-08-02.md` — the pass after the July audits. Eight findings,
  none of them a crash or a data-loss path; all eight are now fixed. Kept here
  rather than in `old/` for its last section, which records what was checked and
  found sound so the next pass need not redo it.
- `code-audit-2026-08-02-plan.md` — how those eight were fixed: five groups, the
  changes per file, the tests each one earned, what was deliberately left, and
  the two things that can only be checked in a browser.
- `scalability-readability-audit-2026-07-27.md` — all eight leverage items are
  closed; the medium and low findings it lists are the remaining work, and are
  the natural source of issues.

Worth knowing about one that is *not* here. `old/open-source-readiness-2026-08-02.md`
is the plan this repository's public layout, CI, linting, typecheck and file
splits were carried out from, and it moved down the moment it was finished -
which is the rule above being followed rather than described. Read it for the
reasoning behind *not* rewriting the app on a UI framework: the line counts are
in it, and it is the answer to a question that will be asked again.
