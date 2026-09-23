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
- `patch-notes-full.md` — **an archive, not open work.** It holds every release
  at the length it was first written, internal work included. Nothing generates
  anything from it.

**Keep this level short.** There is one list of open work, because two lists
disagree about the same tree.
