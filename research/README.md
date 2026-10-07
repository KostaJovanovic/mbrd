# research/

Why things are the way they are. Most of this was written before or during the
work it describes, so it records the reasoning, including the options that were
rejected, rather than the outcome. The outcome is in the code.

**`research/docs/` is the specification, and the rest is argument.** `docs/` is
the current, authoritative description of what the app *is*: the architecture,
the `.mbrd` format, the layout-settings split, the browser floor and the cloud.
When `docs/` and the code disagree, the code wins.

| directory | what it holds | is it current? |
| --- | --- | --- |
| `research/docs/` | the **specifications**, what the app is | yes, authoritative |
| `research/` (top level) | work that is **still open** | yes, read this |
| `research/old/` | work **carried out or abandoned** | no, ignore it |

**Nobody reads `old/`.** Nothing in it is authoritative, nothing in it is kept
up to date, and no work starts from it. A finished document moves down to
`old/`, and nobody edits it after that. A path into it is only a pointer to
history.

**Every plan or investigation says, under its title, whether it was done.** A
reader must not have to reconstruct that from `git log`: a plan is written
before its work, so its prose goes on saying "not yet built" long after it was.
The line comes directly under the `#` heading, bold, and starts with one of four
words:

```markdown
**Status: open.** Nothing built yet.
**Status: partly done, 2026-09-23.** The blink is fixed; the shadow redesign waits on the maintainer.
**Status: done, 2026-09-23.** All three phases built.
**Status: abandoned, 2026-09-23.** Superseded by the DOM export.
```

Update it in the same commit as the work that changes it, not later. A document
gets its final line (done or abandoned) as its last edit, in the commit that
moves it to `old/`. The rule covers every document at the top level and every
one on its way down. It does not cover `docs/`, which is current by definition,
the todo list, the archive, or anything already in `old/`, which nobody edits.

The changelog source is `patch-notes.md` at the repository root, not in here.
`tools/gen-patch-page.mjs` reads it, and `/patch` is generated from it.

## Current

- `todo-2026-09-14.md` — **the list of open work.** Audited on 2026-09-14 and
  trimmed on 2026-09-15 to what is still open: should be done, checks still
  owed, needs the maintainer (with the phone design calls P6 to P11), and
  ideas. What was done, decided or skipped, with the fix list R1 to R38, is in
  `old/done-2026-09-15.md`.
- `bench-2026-09-23.md` — the plan for a benchmark built into the app: preset
  moves, zooms and animations on a generated standard board (`#bench`) or the
  board on screen, saved as a JSON file, with real frame timings on Android.
  Built on 2026-09-24 except the lab page; not yet run on a phone. Its last
  section is what was built and where it differs from the plan.
- `qol-2026-10-04.md` — the second quality-of-life round: 23 picked changes
  in six batches (align carrying notes, drops avoiding cards, Nudge and fence
  scopes, selection and join rows, the viewer, Alt+drag), with three open
  questions. Not yet built.
- `features-2026-10-07.md` — eighteen features and 1.0 gaps the maintainer
  picked on 2026-10-07, each with the answers it has to match: colour search,
  rolling backups, JSON Canvas, colourblind mode, the pen, boards inside
  boards and the rest. Being built in its order.
- `pen-2026-10-07.md` — the design for item 17, the pen, highlighter and
  eraser: a `drawing` card, a `stroke` gesture inside `input.ts`, the dial's
  three ways of drawing a stroke. Waiting for the maintainer's approval.
- `boards-in-boards-2026-10-07.md` — the design for item 18: children as
  `boards/<id>/` inside the parent `.mbrd`, gated by `requires: ["boards"]`,
  a board card and a breadcrumb. Waiting for the maintainer's approval.
- `patch-notes-full.md` — **an archive, not open work.** It holds every release
  at the length it was first written, internal work included. Nothing generates
  anything from it.

**Keep this level short.** There is one list of open work, because two lists
disagree about the same tree.
