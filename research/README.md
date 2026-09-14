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

The changelog source is `patch-notes.md` at the repository root, not in here.
`tools/gen-patch-page.mjs` reads it, and `/patch` is generated from it.

## Current

- `todo-2026-09-14.md` — **the list of open work.** On 2026-09-14 every
  document under `research/` was read for unfinished items, and each item was
  checked against the code. The list sorts them four ways: should be done,
  needs the maintainer, skipped on purpose, and already done. The maintainer's
  decisions of that day sit at its head.
- `rapid-fixes-2026-09-14.md` — **the maintainer's fix list of 2026-09-14, R1
  to R20.** Each item has a checkbox, and a **Done.** note says what was built
  and what was not tried. Only R18 is open.
- `ui-clutter-phone-2026-09-14.md` — **what could go at phone width**: twelve
  findings at 390 px. P1 to P5 are controls that do nothing on a phone, P6 to
  P11 are design calls, and P12 is a gap. Nothing in it is cut yet. The
  maintainer picks, and the cuts land under R18.
- `patch-notes-full.md` — **an archive, not open work.** It holds every release
  at the length it was first written, internal work included. Nothing generates
  anything from it.

**Keep this level short.** There is one list of open work, because two lists
disagree about the same tree.
