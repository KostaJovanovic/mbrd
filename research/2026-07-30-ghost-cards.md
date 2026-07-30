# Ghost cards

Status: plan, nothing built yet. 2026-07-30.

Three cards that are already on a board the moment it is made, saying what a
blank board cannot say for itself: drop things here, drag to move around, add a
note. The first time real content arrives — a dropped file, an added note — they
leave, and that board never shows them again.

They are furniture, not content. A `.mbrd` never contains one, the bin never
holds one, and undoing the import that dismissed them does not bring them back.

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

**Middle and Harsh — a regular card with a dashed outline.** `border: 2px dashed`
over a transparent body, radius from `var(--radius)` so it rounds at Middle and
squares at Harsh with no second rule. No shadow: `canvas/items.js:532` builds
shadows for everything except the title card, and ghosts join that exclusion —
an outline that casts a shadow reads as solid.

**Softish — yellowed papyrus with chipped sides.** Two techniques, both already
used elsewhere in the repo and both dependency-free:

- The yellowing is layered `radial-gradient`s carrying `var()`, the same
  technique `canvas/grid.js` uses for its two soft grid tiers and `app.css` uses
  for the paper blooms. A slider move restyles it with no repaint.
- The chipped edge is a `clip-path: polygon(…)` with an irregular point run.
  Cheaper and crisper at any zoom than an SVG displacement filter, and it
  composites on the GPU, which matters because `#world` is one transformed
  layer and a filter there would force a repaint on every pan.

Three cards want three different silhouettes or the trio reads as a repeated
tile — the same reasoning the icon's three cards are landscape/portrait/
landscape. `:nth-child` variants, not randomness, so a board looks the same
every time it opens.

New tokens go in the `[data-whimsy]` blocks in `tokens.css` (`0` at ~481, `2` at
~553); the rules go in `app.css` next to the other `.item` rules — CSS is three
files and stays three files.

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

2. **Do threads connect to ghosts?** `canvas/web.js` draws threads between item
   centres and excludes only stuck riders. "Behave entirely like real cards"
   argues for including them; against is that the web is a picture of how a
   board's contents relate, and hints relate to nothing. Recommend excluding
   them — a ghost is not a node — but it is a visible call either way and it is
   yours.

3. **Rearrange.** Plan excludes ghosts from `packable`, matching the title card.
   Consistent with (2), slightly against "entirely like real cards".

4. **Mobile.** Two layouts, and Mobile is a reading-order column feed, not a
   spatial map. Ghost slots need a Mobile answer — most likely the top three
   cells of the column grid — and the copy may need to differ, since "drag to
   pan, wheel to zoom" is a Desktop sentence. Worth deciding before writing the
   copy rather than after.

5. **`worldEl.classList.toggle('is-empty', …)`** at `canvas/items.js:280` is set
   but matched by no CSS rule anywhere — a dead hook. It is also wrong already:
   the title card is an item, so a fresh board has length 1 and `is-empty` never
   fires. Either repoint it at `hasContent()` and use it, or delete it. Noted
   because it is adjacent and looks like a half-built version of this feature.
