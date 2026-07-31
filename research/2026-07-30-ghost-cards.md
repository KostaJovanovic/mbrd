# Ghost cards

Status: **implemented**, 2026-07-31. Planned 2026-07-30.

Built as designed below, with the four open questions in §6 resolved as
recommended - hints are not threaded by the web, not dealt slots by "Rearrange
all", and carry layout-neutral copy so one sentence is true on Desktop and
Mobile alike. §6.1 (undo entries outliving their items) was checked before
building and is a non-issue; the detail is in that entry.

Two things came out differently from the plan and are worth knowing:

- **Leaving needed no code at all.** `canvas/items.js` already flies out every
  id named in a removed delta, so a ghost exits with the whimsy tier's own feel
  the moment `dismissGhosts()` emits. The only requirement that placed on the
  design was that the emit name the ids, which is why `dismissGhosts()` returns
  them rather than emitting bare.
- **The `packable` line at `state.js:720` is the wrong lever** and was reverted
  during the build. That filter belongs to `repackMobileBoard()`, not to
  "Rearrange all", and excluding hints there would strand them when the Mobile
  column count changes - they *are* drawn on Mobile, unlike the title card.
  Rearrange is filtered in `main.js` at the `cmds.rearrange` entry instead.

Verified in a real browser as well as by the suite (617 pass): a fresh board
opens `ghost, ghost, ghost, title`; adding a note leaves `note, title` with the
three nodes still in `#exit-layer` mid-animation; undoing that note leaves
`title` alone and the hints stay gone.

Three cards that are already on a board the moment it is made, saying what a
blank board cannot say for itself: drop things here, drag to move around, add a
note. The first time real content arrives — a dropped file, an added note — they
leave, and that board never shows them again.

They are furniture, not content. A `.mbrd` never contains one, the bin never
holds one, and undoing the import that dismissed them does not bring them back.

A fourth card sits under the title card and carries the whimsy dial itself - 4:1
rather than 3:2, a control rather than a sentence. It reaches `setWhimsy` through
`cmds`, because it is built under `canvas/` and may not import
`ui/appearance.js`; `main.js` hands `cmds` to `initGhosts()`, the same move it
makes for storage's confirmation prompt. Keeping the dial honest when the level
is moved from the settings panel is a `MutationObserver` on `data-whimsy` - the
one thing `ui/appearance.js` already writes on every change, and what
`canvas/grid.js` reads for the same reason. `canvas/input.js` needed nothing:
its widget branch already names `input`, so a drag on the thumb moves the thumb
and not the card.

**Mobile is a column, and they are born into it.** The dial leads it, under the
masthead, which is where it sits on Desktop too; a stable sort keeps the three
hints in reading order behind it. Everything starts flush with the board's top
edge — see the note on `placeMobileItems()` and the Desktop title card, which
used to push the first free row four or five spaces down for every import on a
phone, not just for these.
 `ensureGhostCards()` forks
the way `addItems()` does: Desktop gets the arrangement below, Mobile gets one
full-width card per row through `placeMobileItems()`. It has to happen at seeding
rather than at the mode switch, because a phone never makes that switch — it
opens in Mobile, and `completeLayout()` only fills in the profile that is *not*
live, so nothing else would ever have placed them. Seeded raw, two of the four
sat off the side of a 512-wide board. The Mobile heights are the `mh` field in
`GHOSTS`: a card twice as wide needs nothing like twice the height for the same
three lines.

**They are laid on the lattice.** Harsh means snapping on Desktop, so a board
saved there is snapped the moment it loads — and hints are pushed straight onto
`board.items` by `ensureGhostCards()` rather than going through `addItems()`,
which is where `onLattice()` sits. Nothing else laid them down, so on every
refresh at Harsh they arrived at their own coordinates while every other card on
the board sat flush in its cells. Two halves to the fix: seeding runs each box
through `latticeBox()` at the board's own `baseStep()` when snapping is on (no
commit, no `presnap` memo — a hint is never unsnapped back to anything), and the
geometry in `GHOSTS` is itself written in whole grid spaces, so the snapped and
unsnapped layouts are the same layout. The sizes went up to 4×3 cells
(256×192) as part of that: `latticeSide()` rounds 216×144 *down* to 187×123,
which clipped the longest hint's own paragraph.

The dial card is the sidebar's own control, not a copy of it. The renderer gives
its row `class="field"`, so the track, the lozenge thumb, the stop names and
everything the whimsy axis does to the three of them arrive from the panel's
block in `app.css` — one slider, styled once. The three names are duplicated in
`canvas/ghosts.js` (`STOPS`) because the panel's list lives in `ui/`, which
`canvas/` may not reach into; `tests/ghosts.test.js` compares the two copies so
they cannot drift. They are printed *above* the track on the card and below it in
the panel, because the panel has a label over its slider and this card does not:
the names are the label. There is no title on it for the same reason — a heading
reading "Whimsy" over a row that already reads Softish / Middle / Harsh. says
nothing twice — so the word goes to the input as its `aria-label`, and the level
reaches a screen reader as `aria-valuetext` rather than as "1 of 2".

It is also the one hint that stays an ordinary card at every stop on the axis:
no dashed edge, no torn page, no tape. A dash marks a hint as provisional and a
control is not, and the Softish treatment is actively hostile to this card — the
perforation eats the left end of the track, a strip of tape lands across the
thumb, and the mask that cuts the page applies to everything inside it. The tape
is refused at minting (`GHOSTS` carries `tape: false`, since the placement is
rolled there rather than drawn from the tier); the rest is
`:not([data-hint="whimsy"])` on the Softish rules in `app.css`.

---

## 1. The one decision: they are real items

The alternative was an overlay layer — nodes parked in `#world`, outside
`board.items`, getting pan/zoom free from the single world transform and
touching nothing else. That is much cleaner at the boundaries and was the
default until the interaction question was answered: **ghost cards behave
entirely like real cards** — selectable, draggable, resizable, rotatable.

That answer decides it. All of that behaviour lives in `canvas/input.js` and
runs on `board.items` through `byId` / `snapshotGeom` / `applyGeom` /
`commitGeom`. An overlay would have to reimplement the whole gesture pipeline
for three cards, and `input.js`'s header is explicit that there is exactly one
active gesture and one pipeline. A second one is the regression.

So: **a new item type, `ghost`**, minted like the Desktop title card and
excluded at three boundaries instead of one.

`title` is the precedent throughout — a singleton pseudo-item, present by
default, deletable, geometry travelling in `board.layouts` like anything else.
`state.js:860-925` is the shape to copy. The difference is that `title` *is*
board content and persists; a ghost is not and must not.

### The three exclusions

Everything else about a ghost is an ordinary card. Only these three are special,
and each is one predicate at one call site:

| # | Boundary | Where | Rule |
|---|---|---|---|
| 1 | Persistence | `serializeBoard`, `state.js:2751` | Ghosts are stripped from `items` and from both `layouts` records. A `.mbrd` can never contain one, so the schema does not change and no other reader needs to learn the type. |
| 2 | Dismissal | new `dismissGhosts()` in `state.js` | Removal is hydration, not a command — no `commit`, no history entry, exactly like `ensureTitleCard()`. This is what makes "they don't come back" survive an undo of the import that triggered it. |
| 3 | The bin | `removeItems`, `state.js:813-818` | A ghost deleted by hand is gone, not binned. The existing `title` branch there already does this shape; ghosts join the `.filter(r => r.item.type !== 'title')` line. |

Exclusion 1 is the important one. Get it wrong and onboarding hints ship inside
users' saved boards.

---

## 2. When they show

No new persisted flag, and nothing added to the `.mbrd` schema. Visibility is
derived from state the board already has, plus one session-scoped latch.

```
hasContent()  =  board.items.some(i => i.type !== 'title' && i.type !== 'ghost')
show          =  !dismissed && !hasContent()
```

`main.js:858` already uses `board.items.every(it => it.type === 'title')` as its
"board is effectively empty" test for the opening view. This is that predicate,
widened by one type — worth extracting to a single exported helper in `state.js`
so the two cannot drift.

The latch is a module-local `let dismissed = false` in `state.js`, and its whole
job is the undo case:

- set `true` by `dismissGhosts()` when content first arrives;
- reset on `board:new` → a fresh board seeds ghosts again (this is the answered
  scope: **every new board**, not once per browser);
- on `board:load`, set to `hasContent()` — a board arriving with content is
  dismissed for the session, an empty one gets ghosts.

Because it is session state and never written anywhere, a reload of a board that
was emptied by deleting everything will show ghosts again. That is a deliberate
consequence, not an oversight: an empty board is an empty board, and the hints
are as useful the second time. Flagging it because it is the one case where
"don't come back" is read loosely.

### Seeding

Two call sites, mirroring exactly how the title card is seeded today:

- `main.js` `bus.on('board:load')` (~line 808), beside `ensureTitleCard()`.
- `main.js` `start()` (~line 1680), the first-run branch where no session was
  restored — with the same follow-up `bus.emit('items', {added, removed})` that
  mounts the title card without a reload.

`state.loadBoard()` deliberately does not seed the title card so its own tests
can load and serialise an exact item set (`state.js:2491`). `ensureGhostCards()`
follows that rule for the same reason.

### Dismissal trigger

One subscriber, in `main.js`, on the `items` bus event: if `hasContent()` and
ghosts are on the board, call `dismissGhosts()`. That covers every door at once —
drop, paste, the sidebar note button, the bin restoring something, an
arrangement import — rather than hunting for each one. `import/drop.js` and the
note command need no edit.

---

## 3. How they look

Whimsy is `0 Softish · 1 Middle · 2 Harsh` (`ui/appearance.js:45`). `canvas/`
cannot import from `ui/` — the layering test enforces it — so the level is read
off `document.documentElement.dataset.whimsy`, which is the established pattern
in `canvas/grid.js:221` and `canvas/exit-anim.js:91`. In practice the styling is
pure CSS gated on `:root[data-whimsy="…"]`, so no JS reads it at all.

**Middle and Harsh — a regular card, and the *only* difference is the border.**
Paper, inner rule, drop shadow and full reading weight on the text, exactly as a
filed card wears them; `border: 2px dashed` replaces the inset hairline, with the
radius from `var(--radius)` so it rounds at Middle and squares at Harsh with no
second rule.

This is a correction. The first build also made the body transparent and faded
the text, which is three cues all saying "provisional" — and it read as a broken
card rather than an invitation. At Middle, the default level and the one most
boards are actually looked at, it also left the words too pale to read. One cue
is enough, and the edge is the right one to carry it.

The shadow is CSS on `.ghost-card` rather than an `#item-shadows` twin, because
a ghost's silhouette is not its item box — Softish clips it to a torn polygon,
and a rectangular twin would lay a clean shadow under a ragged scrap. Same
reason `.title-card` carries its own, and `canvas/items.js:532` skips both.

**Softish — a page torn out, taped down.** The scrapbook dialect of the dashed
edge, saying the same thing twice in two registers: the sheet was ripped out of
something, and it is only stuck here for now.

Papyrus was here first and was dropped outright. It was a *costume* — a
different metaphor from the dashed edge, borrowed from somewhere the app has
nothing to do with — and no amount of work on its edges fixed that. Six
candidates were put on a real board at once to choose between (plain, pencil,
tape, photo corners, tracing paper, torn page); this is torn page and tape
together.

- **The page.** Perforation stubs down the left edge where it left the pad,
  faint rules, and the margin the rules stop at. The perforation is a repeating
  CSS `mask`, not a `clip-path`: a torn stub is a circle, and a polygon is the
  one thing that cannot do a circle cheaply.
- **The tape.** One or two strips per card, each straddling a different edge at
  an angle, half on and half off — the overhang is the entire read.

Two traps here, both found the hard way:

- **A mask applies to descendants.** Tape drawn inside the card would be punched
  full of the same perforations, so the strips are *siblings* of the card. The
  ghost renderer returns a `DocumentFragment` for exactly that reason;
  `items.js` appends whatever it gets and `append()` spreads a fragment, so
  nothing there needed changing.
- **`.card` clips its own pseudo-elements** (`overflow: hidden`), which cut the
  tape off flat at the card edge and made it read as printed on. A ghost card
  holds two lines of text and no media, so it lets its tape out.

**The randomness lives in the item, not in the render.** `tapeFor()` in
`state.js` rolls the placements once, when the hint is minted, and they travel
in `meta.tape`. `canvas/items.js` throws a culled card's node away and rebuilds
it from nothing when it comes back on screen — a placement chosen while drawing
would put the tape somewhere new every time the board panned past it. Random per
board; fixed for that board's life. `tapeStyle()` in `canvas/ghosts.js` turns a
placement into the four CSS values, and is pure so the geometry is testable.

The strips are built at every tier and hidden by CSS away from Softish, so the
whimsy dial shows and hides them without rebuilding a card.

### Leaving

`canvas/exit-anim.js` already maps whimsy to a feel — `fall` / `dissolve` /
`shatter`, with `title` special-cased to `chip` (`exitKindFor`, line 33). Ghosts
should play the whimsy-matched exit so they leave the way any card leaves.

They do **not** need the clone machinery that module exists for. Cloning is
there to free the item's id for an immediate undo and to strip live media
players; a ghost has no player and its removal is not undoable. Play the
`.exit-*` animation on the real node and remove it on `animationend`, with the
same `FALLBACK_MS` guard.

---

## 4. Change list

New:

- `web/assets/js/canvas/ghosts.js` — the copy, the default geometry per layout
  mode, and the pure helpers. Header carries the why, per repo convention.
- `tests/ghosts.test.js`.

Edited:

- `state.js` — `GHOST_IDS`, `ensureGhostCards()`, `dismissGhosts()`,
  `hasContent()`; the `removeItems` bin filter (~816); `serializeBoard` (~2784)
  and both `layouts` records (~2785-2795); `packable` (~720) so "Rearrange all"
  leaves them alone, as it already leaves the title card alone.
- `main.js` — seed on `board:load` and in `start()`; the `items` subscriber that
  dismisses; `paintCount` (~1217) so the HUD does not count hints as things.
- `canvas/renderers.js` — a `ghost` entry in `RENDERERS`, and `defaultSize`.
  **Not** a branch in `classify()`: that function routes dropped *files*, and no
  file is ever a ghost.
- `canvas/items.js` — join the title card's no-shadow exclusion (~532).
- `canvas/exit-anim.js` — `exitKindFor` stays as it is; ghosts take the whimsy
  default. Listed only so the file is checked, not necessarily changed.
- `app.css`, `tokens.css` — the styling above.
- `web/sw.js` — `./assets/js/canvas/ghosts.js` into `SHELL`.

`canvas/web.js` `centres()` (~264) is a genuine open question, below.

---

## 5. Invariants this must not break

The tests enforce these; all four are cheap to satisfy and expensive to notice
late.

- **`SHELL` completeness** (`tests/sw.test.js`). A new JS file that is not in
  `SHELL` is a file that is missing offline. Note the comment at `sw.js:38` — no
  apostrophes anywhere in that array, including comments, because the test
  parses it by pulling single-quoted runs out of the source.
- **Layering** (`tests/layers.test.js`). `canvas/ghosts.js` may import `state.js`
  and `geometry.js`. It may not import anything under `ui/`. The whimsy level
  comes off the DOM, not from `ui/appearance.js`.
- **No browser globals at import time** (`tests/imports.test.js`). `document`
  inside a function is fine; `document` in the module body is not, and the
  exception list is closed at three files.
- **Every `classify()` return has a renderer** (`tests/renderers.test.js`). This
  cuts the other way here: `ghost` is a type without a `classify()` route, which
  is fine, but check the test asserts the direction it claims and not the
  converse before adding the type.

New tests should cover the pure parts, in the style of `exitKindFor`:
`hasContent()` over a synthetic item list, the dismissal latch across
load/new/undo, ghost slot geometry per layout mode, and — the one that matters —
**`serializeBoard()` on a board carrying ghosts contains none of them**, in
`items` and in both `layouts`.

---

## 6. Risks and open questions

1. ~~**Undo entries that outlive their items.**~~ **Checked — not a problem.**
   Ghosts are draggable, so a drag commits a real `commitGeom` history entry.
   Content then arrives, the ghosts are removed with no history, and undoing
   back past that drag replays geometry against ids that no longer exist.
   `applyGeom` already skips them — `const it = byId(g.id); if (!it) continue;`
   at `state.js:1246-1247` — so the replay is a silent no-op for the ghost and
   correct for everything else in the same entry. `snapshotGeom` (1230) filters
   the same way. No history scrubbing needed, and `dismissGhosts()` stays a
   plain removal.

   One unrelated sharp edge noticed while checking: `commitGeom` (1265) pairs
   `after` and `before` by index, and `snapshotGeom` returns a *shorter* array
   when an id has gone. An item removed mid-gesture would misalign that
   comparison. Pre-existing, not reachable through ghosts — a ghost still
   exists at commit time — and out of scope here, but worth a note.

2. ~~**Do threads connect to ghosts?**~~ **Resolved: they do not.** `centres()`
   in `canvas/web.js` excludes them alongside stuck riders. The web is a picture
   of how a board's contents relate and a hint relates to nothing; it would also
   have meant drawing a web on an empty board and tearing it down at the first
   import.

3. ~~**Rearrange.**~~ **Resolved: hints stay put**, filtered at `cmds.rearrange`
   in `main.js`. See the note at the top of this file about why the `packable`
   line named in §4 was the wrong place for it.

4. ~~**Mobile.**~~ **Resolved, and it needed less than expected.**
   `completeLayout('mobile')` packs any item with no saved geometry, so ghosts
   are dealt column slots by the ordinary path with no special case. The copy
   problem was real and was solved by writing it layout-neutral: each line names
   the outcome ("Drag the board to travel. Zoom to see more of it.") rather than
   the device's gesture, so one sentence is true of a wheel and of a pinch. That
   also keeps the renderer free of any mode-dependent DOM.

5. **`worldEl.classList.toggle('is-empty', …)`** at `canvas/items.js:280` is set
   but matched by no CSS rule anywhere — a dead hook. It is also wrong already:
   the title card is an item, so a fresh board has length 1 and `is-empty` never
   fires. Either repoint it at `hasContent()` and use it, or delete it. Noted
   because it is adjacent and looks like a half-built version of this feature.
