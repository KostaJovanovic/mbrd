# A text editor in the viewer — 22 September 2026

A plan, written before any of it exists. The brief from the maintainer: a very
simplified Word / Google Docs / Obsidian, **a quick note-taking thing and not a
standalone app**, plus the writing modes of [Vomdraft](https://vomdraft.com/)
(Vomit Draft, Cielo Croci's free screenwriting app). Nothing here is decided
beyond what the maintainer answered; the open questions are at the end.

## What was decided

| question | answer |
| --- | --- |
| where it lives | **the viewer** — opening a `.md` / `.txt` item edits it; one entry in `VIEWS` (`ui/viewer.ts`) |
| format on disk | **markdown**, plain; nothing mbrd-only in the file |
| how it feels | **WYSIWYG**, markdown underneath; `# ` becomes a heading as it is typed |
| engine | **hand-written**: our own document model over `contenteditable`, no dependency |
| v1 formatting | headings, bold / italic / strike, lists (bullet, numbered, task), find & replace, word count — **as little as possible** |
| toolbar | **a fixed bar on top** of the page |
| entry points | a sticky that overflows, and opening any existing `.md` / `.txt` |
| saving | on close, plus an idle autosave |
| old content | **the timeline**: the edit swaps the item's asset in place and the old bytes stay reachable through history; no versions model, no `.mbrd` schema change |
| phone | **all of it**, the lock included |
| the extra | Vomit Mode, Super (word lock), a `.fountain` screenplay mode, an outline sidebar |
| delivery | **three phases**, each shippable alone |
| Vomit Mode lock | backspace inside the current word only; locked text fades; the timer ending just unlocks, silently |
| phone autocorrect | the correction a keyboard makes on space **is part of that space** and locks with it |
| screenplay storage | its own file type, `.fountain` |
| Theatre mode | not in v1 |
| sticky → document (2026-09-23) | **at the 121st character**, while typing, not on close |
| idle autosave and undo (2026-09-23) | **one step per opening** of the editor; every save in it coalesces |

**Status, 2026-09-23: phase 1 is built.** Where it departs from what follows:

- **A file that is not clean UTF-8 opens read-only.** Writing it back would
  change bytes nobody touched, which breaks the round-trip rule.
- **A save that lands after the board was swapped is dropped** (a board
  generation guard in `ui/viewer.ts`). At most the last 1.5 s of typing can go
  that way; the flush on close, restart and leaving the page covers the rest.
- **No separate session-store draft.** The idle save plus that flush does its job.
- **The sticky handoff holds keystrokes in a hidden textarea** (`holdTyping()`)
  while the note is hashed into a file, then types them into the editor, so
  nothing typed across the 121st character is lost. Whitespace an ATX title
  line would swallow is carried over as typed.
- **The card renderer's tokenizer changed with it**, since both share
  `inlineTokens()`: backslash escapes, no emphasis on an intraword `_`, and
  `# C#` keeping its sharp.

"Stored versions", which the first draft of this plan leaned on, were withdrawn in
v0.198 (`board-model.ts:125`, `board-schema.ts:110`); the timeline replaced them,
and it is enough here.

## Phase 1 — the editor

### Shape

- **`ui/editor/`**, three layers, the lower two DOM-free so `npm test` reaches
  them with no browser:
  - `model.ts` — the document: a list of blocks (paragraph, heading 1–3, list
    item with kind and depth, quote, code fence, **raw**) holding inline runs
    (bold, italic, strike, code, link). Every edit is a pure
    `apply(doc, edit) → doc`. Undo inside the editor is a stack of these; the
    browser's native undo is never used, because it undoes DOM the model did not
    write.
  - `markdown.ts` — `parse(text) → doc` and `serialize(doc) → text`.
    `ui/markdown.ts` is a one-pass DOM renderer with no tree
    (`renderMarkdown()` returns a fragment) and cannot be reused for a round
    trip; the card and read-only renderer stay as they are.
  - `view.ts` — renders the model into the page with `createElement` /
    `createTextNode` only (the file is foreign; **no `innerHTML`**), and reads
    input back.
- **Round-trip is the contract.** Anything the editor does not model — tables,
  images, HTML, footnotes, front matter — parses to a `raw` block, is shown as
  its source in a muted monospace box, and serializes byte for byte. Opening a
  file and closing it untouched must not change its hash, so **nothing is
  written unless the text changed**.
- **Input:** handle `beforeinput` where it is cancelable, and for everything
  else (IME composition, Android keyboards) let the DOM change, diff it against
  the model on `input`, and fold the difference into an edit. The same
  reconcile path is what makes the Vomit Mode lock work on a phone (phase 2).
  `canvas/notes.ts` and `note-model.ts` already solve IME and `beforeinput` for
  stickies — read them first and reuse what transfers.

### Saving

- New text becomes an asset through `addFile(new File([text], name, { type }))`
  (`storage/assets.ts:61`), and the item is pointed at it **in place** — same
  id, so the card rebuilds instead of being replaced — in one `commit`, which
  emits `bus 'item'` and redraws the card (`items.ts:1374`). `swapAssets()`
  (`state.ts:765`) does nearly this but stamps optimizer metadata (`meta.opt`,
  `meta.was`); either a flag on it or a small sibling (`replaceText()`?) in
  `state.ts`. Not `meta.was`: that is the optimizer's "original", and
  `replaceOldVersions()` would offer to delete it.
- The old bytes stay recoverable because the timeline keeps every hash a past
  step references (`timelineHashes`, `timeline.ts:1276`).
- **Idle autosave** commits the same swap after a pause in typing. An unsaved
  draft also goes to the session store so a crash loses nothing.

### Viewer changes

- `VIEWS` has no per-view teardown; the global `teardown()` (`viewer.ts:205`)
  needs an editor hook beside `releaseDoc` / `pdfDoc`, which saves.
- **Escape** is native dialog cancel and would close without the editor seeing
  it; handle `cancel` the way the note composer does (`notes.ts:1082`). Escape
  closes find first, then closes and saves.
- **Ctrl+F** opens the editor's own find & replace bar, not the browser's.
- The canvas keyboard already stands down for a contenteditable and for an open
  dialog (`input.ts:3033`, `:3056`), so Ctrl+Z inside the editor is the
  editor's.
- The app's right-click menu still fires on a collapsed caret in a
  contenteditable (`input.ts:70`) — exempt the editor.
- **Size.** The viewer reads at most `TEXT_MAX = 200000` characters
  (`viewer.ts:37`). Editing a truncated read would destroy the rest, so a larger
  file is a **ceiling** in the house sense: a `CeilingId` and risk sentence in
  `consent.ts`, an `Oversize` thrown where the length is measured, and a `lift`
  that reads the whole file. Not a silent read-only fallback.

### The sticky that overflows

Today a sticky past `NOTE_SHEET_MAX = 120` characters becomes a `.md` when its
editor closes (`notes.ts:900`, `noteToFile` in `import/drop.ts:322`, via
`retypeItem`), and the new card simply appears — `openComposer` hands the node
home with no landing (`notes.ts:1057`). The new behaviour: **the note expands
into paper and the editor opens on the new document**, caret where it was.

- The animation is a FLIP from the note's on-screen rect (the composer mount,
  or `screenBoxOf()` for an inline edit) to the viewer's page rect: the note's
  colour turns to paper while it grows, then the toolbar, title and backdrop
  fade in. Transform and opacity only.
- It follows the whimsy dial and `prefers-reduced-motion` (a plain cross-fade).
  Check it over RDP by sampling frames before judging it broken.
- `canvas/` may not import `ui/`, so the handoff is injected like the overflow
  itself (`setNoteOverflow`, `notes.ts:47`).
- **Sequence after the sticky work in progress lands** — another session is in
  `notes.ts` now.

### Where the pieces go (per CLAUDE.md)

- A stylesheet `css/editor.css` → `index.html`, `SHELL` in `sw.js`, and
  `APP_CSS_ORDER` in `tests/helpers.js`. **This is a service-worker cache
  change** and gets reported as one.
- Toolbar icons → `<symbol>`s in `icons.svg` (`tests/icons.test.js`).
- New ids → `tests/element-ids.test.js`.
- Any menu (the timer picker in phase 2) → `ui/menu.ts` / `openAnchored()`, and
  the button calls `justDismissed()` first.
- No inline `style=`; set `.style` from script.
- Formatting commands are editor-local — to confirm the sticky editor's toolbar
  sets that precedent rather than routing through `cmds`.

### Tests

Round trip over a corpus (parse → serialize equals input; `raw` blocks
survive untouched); the markdown shortcuts as model edits; find & replace;
the untouched-file-keeps-its-hash rule; the ceiling throws `Oversize` and never
a plain `Error`.

## Phase 2 — Vomit Mode and Super

A toggle in the toolbar with a duration (5 / 10 / 15 / 25 / 60 minutes, or
custom) and a small countdown in the bar.

- **The rule is on the document, not on input.** A lock boundary sits in the
  model. Space and Enter move it to the caret. Any edit that would change text
  before it is refused — however it arrived: a key, a paste, a keyboard's
  replacement, a drop.
- **Backspace works inside the current word**, back to the boundary and no
  further.
- **The caret cannot go behind the boundary.** Clicks, arrows and selections
  clamp to it.
- **In-editor undo is off** for the session, and so is find & replace. Toolbar
  marks apply only to unlocked text. A markdown shortcut at a line start still
  works, because a line started after Enter is unlocked.
- **Locked text fades**, following the whimsy dial.
- **When the timer ends it just unlocks** — no cue, no summary. Closing the
  viewer ends the session.
- **Phone:** the lock is enforced by the reconcile step. A change reaching into
  the locked range is restored from the model, caret included. Autocorrect needs
  no special case: the keyboard's "teh" → "the " sits entirely after the
  boundary (it only advances once the space is applied), so it commits. A
  keyboard reverting the correction on backspace reaches behind the boundary
  and is refused.
- **Super:** the current word also locks after 10 seconds, even mid-word.
- The rules are a pure function over the model — `apply(doc, edit, boundary)`
  — and the tests are written against it, not against a browser.

## Phase 3 — screenplay (`.fountain`) and the outline

- **File type.** `fountain` joins `TEXT_EXT` (`canvas/renderers.ts:69`) so it
  classifies as `text`, and the editor picks screen mode by extension. Check
  whether the generated `import/formats.ts` also needs it; if so, through
  `tools/gen-formats.mjs` — **a generated-catalogue change**, reported as one.
- **Model.** Elements rather than blocks: scene heading, action, character,
  parenthetical, dialogue, transition, centred, section, synopsis, note,
  page break, title page, dual dialogue. Unknown or awkward Fountain (boneyard
  `/* */`) is kept as raw, the same round-trip contract as phase 1.
- **Typing.**
  - It formats itself: `INT.` / `EXT.` makes a scene heading, a capitalised line
    followed by text makes a character name.
  - Enter picks the next element the way screenwriting tools do (character →
    dialogue → action).
  - Tab / Shift+Tab cycle the element, and Ctrl+1–8 jump straight to one.
  - Ctrl+D pairs two speeches as dual dialogue.
- **Serialization** writes Fountain's forcing marks (`!`, `@`, `.`, `>`) only
  where the element would not be inferred without one.
- **Outline sidebar** in the editor: headings for a `.md`, scenes and sections
  for a `.fountain`, click to jump.
- **Status bar:** words for a `.md`; pages and scenes for a `.fountain`. The page
  count is an estimate from the standard layout (Courier 12, about 55 lines a
  page), and is labelled as one.
- Vomit Mode works unchanged in screen mode.
- **Out:** Theatre mode, Final Draft `.fdx` import and export, PDF export — each
  can come later as its own piece.

## What this changes that CLAUDE.md says to call out

- `.mbrd` schema: **none** — a text edit is an asset swap.
- Service-worker cache: **yes**, phase 1 (a new stylesheet in `SHELL`).
- Generated catalogue: **maybe**, phase 3 (`.fountain`).

## Open questions

1. **When does a sticky become a document?** Today it happens on close. The
   animation reads best **at the moment the 121st character is typed** —
   writing never stops, the note just grows into paper under the caret.
   Recommended, but it changes the sticky's behaviour and needs a yes.
2. **Idle autosave and undo.** Every idle save is a `commit`, so a long session
   leaves many "Edit document" steps. Recommended: coalesce every save from one
   opening of the editor into a single step.
3. **Starting Vomit Mode mid-document.** Recommended: the caret jumps to the end
   and everything before it locks, the typewriter way. The alternative is
   locking from the caret and freezing the text after it too.
4. **Super's 10 seconds** — from the word's last keystroke (recommended) or from
   its first? And should the number be a setting (one entry in
   `ui/settings-schema.ts`)?
5. **A `.fountain` card on the board** — plain text as today, or a small
   formatted preview?
