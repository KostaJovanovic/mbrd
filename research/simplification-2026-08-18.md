# The long way round — a simplification plan

Open work. Two sweeps of the whole tree on 2026-08-18, one for duplication and
dead code and one for indirection, and the order in which the results are worth
clearing.

Written at `7661965` (v0.251), tree clean.

**To carry this out, read
[`simplification-tasks-2026-08-18.md`](simplification-tasks-2026-08-18.md)
instead.** It is this document's findings as numbered tasks — a file, a string
to find it by, and what to change — with the argument left here. This document
is why; that one is what to type.

**Nothing in here touches the `.mbrd` schema, a generated catalogue, or `SHELL`
in `web/sw.js`.** Every item is an internal route to a result the app already
produces: same bytes in, same bytes out, same files on disk. That is not a
coincidence of what was found — both sweeps were told to say so if a finding
crossed one of those lines, and none did.

Nothing here touches `patch-notes.md`. That is yours.

---

## The finding, before the list

The interesting result is not the sixty-odd items below. It is that this
codebase **already knows better in almost every case, and the knowledge stayed
at the site that was fixed.**

Ten times, a module header argues a rule at length — usually because the rule
was learned from a real bug — and a sibling site still does the thing the header
warns against:

| the header that argues it | the site that still does it |
| --- | --- |
| `ui/look.ts:223` — comparison by `JSON.stringify` is order-sensitive and its false negatives cost a board its palette provenance | `state.ts:586`, `state.ts:1452`, `connections.ts:195`, `timeline.ts:315`, `timeline.ts:720` |
| `layout.ts:1027` — `out.includes(id)` inside a growing loop "makes the fixed-point walk quadratic … the drag doing that arithmetic on every commit" | `layout.ts:1169`, the same file, 140 lines later |
| `sticky.ts:571` — `byId(host.id)` when `host` is live "bought nothing and cost the one thing an index can be: out of date" | `ui/board-actions.ts:862`, `:863`, `:882` |
| `ui/appearance.ts:734` — the walk is a parameter "so autoRecolour() can count the pictures and build the key off one pass rather than two" | `ui/appearance.ts:805`, `:818`, one line after the call that honours it |
| `geometry.ts:357` — `distSq` exists because "the square root is monotonic … Do not 'fix' this into a real distance" | `arrange/arrangements.ts:402` |
| `layout.ts:208` — names the template-string cost, "tens of millions of template strings on the main thread" | `layout.ts:166`, `:192`, `:199`, `:204` — the row scan was fixed, the key ping-pong left |
| `ui/appearance.ts:693` — argues at length why the "every photo" stop returns `120` and not `Infinity` | `ui/appearance-controls.ts:313`, `:327`, `ui/pigments.ts:1113` still test for `Infinity` |
| `import/packages.ts:78` — documents returning bare `Bytes` for this caller | `import/pe.ts:125` wraps in a Blob; `import/document.ts:190` unwraps it |
| `canvas/model.ts:809` — a per-frame `getComputedStyle` was removed "so a turn no longer forces a style recalc per frame" | `canvas/model.ts:797`, four lines above, forces a layout per frame |
| `board-model.ts:1147` — `byId` is the O(1) index, and `canvas/items.ts:792` records killing the identical `find` | `canvas/web.ts:1447`, `ui/playlist.ts:947`, `ui/toolbar.ts:266` |

This is worth stating as the plan's own thesis because it changes what "done"
means for several items below. Fixing `layout.ts:1169` is five minutes. Fixing
it **and** noticing that `travelling()`'s comment forty lines up is the general
rule, and that nothing carries that rule to the next person, is the actual
repair. Where an item below has a sibling header, the commit should move the
argument to where it governs both — or at minimum leave a pointer.

The corollary is uncomfortable and worth writing down: this codebase's habit of
arguing every decision in place is what made both sweeps productive, and it is
also what let these ten survive. A rule written in the file that learned it is
invisible from the file that needs it.

---

## How this was found, and how far to trust each line

Two fan-outs of five readers each over disjoint areas — `canvas/`, `ui/`,
`state.ts` + `storage/`, `import/` + `optimize/` + `mesh.ts`, and the app core
plus `tools/`. The first sweep looked for duplication, dead code and
over-abstraction. The second looked only for **circuitous routes**: work done
and discarded, round trips through an identifier, scans where an index exists,
`async` with nothing to await, the DOM used as a data store, type ping-pong.

Two things about the method are worth keeping:

**The area split hid cross-directory duplication, and the second sweep did not
fix that.** Six copies of the same fixed-point walk exist (below); no single
reader could see more than three of them. Whole-tree greps found what the split
readers could not, and that is the half of the method to keep if this is ever
repeated.

**Two of my own conclusions were wrong and are recorded here so nobody
re-finds them.**

- I reported `util.ts:331` `isDev()` as dead. It is not. `tests/sw.test.js:282`
  reads `util.ts` **as text** and asserts `sw.js` carries the same LAN-host
  regex, so no grep for the symbol can see the reference. Its own header says
  "Nothing calls this, and it stays anyway." **Do not delete it.** This is the
  exact hazard `CLAUDE.md` warns about under structural rules, and it caught me
  anyway.
- I reported that the tree contains no comparison-by-serialisation. It contains
  six. I had grepped only for `JSON.parse(JSON.stringify(` and missed
  `JSON.stringify(a) === JSON.stringify(b)`, which is the form that actually
  appears — and which `ui/look.ts` documents as a bug.

Roughly a quarter of the items below were verified against the source by hand;
the rest come from readers that were told to verify and mostly did, but were
wrong at least twice between them. **Read the code before changing it** — which
is this repo's standing rule anyway, and the two errors above are what it is
for.

---

## The order, and why it is this order

Seven batches. Each is a commit or a small run of them.

**1. Bugs first, before anything moves.** Five of these are one-liners, and a
refactor that relocates the buggy line makes its history harder to read later.
More practically: three of them are leaks or stale handlers, and the cost of
leaving them is paid by anyone running the app in the meantime.

**2. Then the documentation that is actively false**, before the dedups in
batches 6 and 7 move the code it describes. One paragraph in `optimize.ts` now
argues *against* the function beneath it; seven more sit on the wrong
declaration. In a codebase whose stated rule is "read the top of a file before
changing it", a reader following that rule is currently handed the wrong
argument eight times. That has to be fixed before more readers are sent in.

**3. Then the per-frame costs.** All small, all local, none architectural.
`canvas/transport.ts` goes first within the batch because it is the only finding
whose cost is paid continuously while nothing is happening — sixty accessibility
-tree writes a second for the whole length of a track.

**4. Then the sibling-site fixes** — the ten in the table. These are the ones
where the repair is partly editorial, so they want a clear head and they want
the false docs (batch 2) already gone.

**5. Then the scans and allocations that grow with the board or the file.**
Larger diffs, lower urgency, easy to verify by reading.

**6. The fixed-point consolidation on its own, and late.** Argued below.

**7. Duplication and dead code last**, because it is the batch most likely to
be abandoned half-done and the least costly to leave.

Two orderings inside that are traps rather than preferences:

- **`ui/appearance-controls.ts` before `ui/appearance.ts:812`.** The `Infinity`
  callers and the over-wide slice are the same bug's two halves, but fixing the
  slice first makes the readout regression invisible: with the slice narrowed,
  the wrong count printed on screen becomes a smaller wrong number rather than
  an obviously wrong one. Fix what the user sees first, then the cost behind it.
- **`ui/board-actions.ts:862` before the fixed-point consolidation.** The `byId`
  round trip and the hand-rolled loop are in the same twenty lines, and folding
  the loop into `attachRiders` requires widening that helper's callback (below).
  Doing both in one commit conflates a bug fix with an API change. Take the
  round trip out first; the copy is smaller and its real shape is clearer when
  the consolidation arrives.

---

## Batch 1 — bugs

**1.1 The palette source count says the wrong thing and mints ninety-six blob
URLs nobody reads.** `ui/appearance.ts:693` argues, well and at length, why
`sourceCount()` returns `ALL_SOURCES_MAX` (120) rather than `Infinity`: at
`Infinity` a 400-photo board with Dynamic on minted a session-cached blob URL
per picture. The change was made and three callers were left testing for
`Infinity`:

- `ui/appearance-controls.ts:313` — `const all = n === Infinity` is permanently
  false, so the readout prints **"120 photos"** where the top stop should say
  **"Every photo"**.
- `ui/appearance-controls.ts:327` — writes `input.value = "120"` against
  `input.max = "25"`. The browser clamps it, so the slider lands right by
  accident.
- `ui/pigments.ts:1113` — `asked === Infinity ? urls.length : …` is a dead
  branch.
- `ui/appearance.ts:681` — `sourceCount()`'s own doc still says "which is
  Infinity here", contradicted by the docblock twelve lines below it.

And the leak the 120 was meant to close is narrowed, not closed:
`ui/appearance.ts:812` mints `slice(0, sourceCount())` = 120 URLs, and
`samplePixels` (`ui/pigments.ts:1113`) then clamps to `MAX_SOURCES` = 24. Ninety
-six blob URLs are minted and session-cached on every `items` event at the top
stop, and never read. Slice to what the sampler will actually consume.

**1.2 Six global listeners leaked per floating-window open.**
`ui/float-window.ts:60, 71, 72` and `:106, 119, 120` register permanent
`pointermove`/`pointerup`/`pointercancel` listeners on `window`. Both floating
windows are rebuilt on every open, so each open/close cycle leaves six listeners
closing over a detached element. The drag and resize wirings want one shared
`grab()` returning a detach that the window's close path calls.

**1.3 `clearQueue()` leaves a handler on a shared element across a board swap.**
`canvas/playlist-queue.ts:507` removes `ended` and not `error`. The two other
teardown sites (`:255`, `:389`) remove both. This is the board-replacement path
— the one that revokes asset URLs — so `queueRefused` survives on the shared
element and can call `advanceQueue()` against a queue that was just emptied.

**1.4 Feet-and-inches never take the shared-unit branch.** `measure.ts:151`
recovers a unit from already-formatted text with `a.slice(a.indexOf(' '))`. An
imperial `"4 ft 3 in"` has two spaces, so `unit` becomes `" ft 3 in"` and the
branch silently never fires. The real repair is that `metric()`/`imperial()`
chose the unit and threw the choice away into a string — return `{ value, unit }`
and let `formatMm` join.

**1.5 A submenu row would announce its own shortcut as part of its name.**
`ui/menu.ts:1767` sets `aria-label` from `row.textContent`, but `fillPanel`
appends a `<kbd>` accelerator into that row at `:1601`–`:1606`. A sub-bearing row
that ever gained an accelerator announces itself as "Tags F2". `entry.label` is
in scope at the one call site (`:1673`). Latent rather than live — no
sub-bearing row currently carries an accel — which is exactly why it will be
found the hard way.

**1.6 A handler that provably cannot do anything.** `ui/dialog.ts:186` and
`ui/color-picker.ts:265` install `onCancelEvent = () => { answer = 'cancel'; }`.
`answer` is already `'cancel'` on every path that can reach it, and the only
other writer calls `el.close()`, which fires `close` and not `cancel`. Delete
the handler and its add/remove pairs (`dialog.ts:199`, `:211`;
`color-picker.ts:288`, `:307`).

---

## Batch 2 — documentation that is false

**2.1 One paragraph must be deleted, not moved.** `optimize/optimize.ts:259`
says *"Every file is done one at a time and awaited. Running them concurrently
would be faster on paper and is the wrong shape here … eight of those at once on
a board of large photographs is how you find the tab's memory ceiling."* The
function directly beneath it is `pool()`, whose own header says the opposite —
*"Lanes rather than Promise.all"* — and `runOptimize:386` calls
`pool(jobs, LANES.media, …)`. The paragraph documents a design that was
reversed. `pool()` already tells the true story; this one goes.

**2.2 Seven doc blocks sit on the wrong declaration**, each leaving the thing it
describes bare further down:

| block at | describes | currently sits on |
| --- | --- | --- |
| `commands.ts:155` | `createCommands` (`:242`) | `layoutItems` (`:188`) |
| `commands/connections.ts:97` | `joinable` (`:121`) | `CONNECT_ALL_MAX` (`:119`) |
| `arrange/arrangements.ts:535` | `lattice` (`:622`, undocumented) | `clustered` (`:567`, which has its own) |
| `layout.ts:1349` | `writeSnapSetting` (`:1367`) | `type SnapState` (`:1363`, which has its own) |
| `web-route.ts:309` | `routeConnection` (`:340`) | `type Route` (`:338`, which has its own) |
| `optimize/optimize.ts:459` | `backfillPosters` | `clipsWantingStills` |
| `optimize/optimize.ts:597` | `backfillThumbs` | `thumbSource` |

**2.3 Two docstrings that claim a caller they do not have.**
`cuelume/engine.ts:808` says `playVoice` is "the bench's door and nothing
else's" — `ui/sound-lab.ts` uses `playRecipe` exclusively. `import/cfbf.ts:317`
says `pictureFrom()` exists "so the summary stream is looked up once", but the
caller does the lookup and passes it in, so it happens once either way. Both
resolve in batch 7 by deletion or inlining; the point here is that the prose is
wrong now.

---

## Batch 3 — per-frame costs

**3.1 `canvas/transport.ts:202`–`210`.** `paint()` runs every rAF frame while a
card plays and unconditionally writes `time.textContent` plus three
`setAttribute`s. `aria-valuemax` is constant for the clip; `aria-valuenow` and
both `clock()` strings change at 1 Hz. That is roughly sixty accessibility-tree
mutations a second, each preceded by string building, to write the value already
there. Only the fill's `clipPath` needs frame rate. Cache the last written
second and skip the rest. Every comment in that block argues the *content* of
each string; none addresses how often it is written.

**3.2 `canvas/web.ts:1447` and `:1484`–`:1486`.** Two whole-board walks per
`pointermove` while a connector end is picked. `boxOf(overId)` is built as a
truthiness test, discarded, and rebuilt as `boxOf(aim)` for the same id on the
next line; and `boxOf` itself reaches the item with `board.items.find` where
`byId` is O(1). `web.ts:35` imports from `state.ts` but not `byId`. Bind the box
once, and take the index.

Related and in the same commit: `boxOf` (`:1446`) is `centres()`'s map callback
copied — same lean rule, same `y: -it.y`, same `rot: -(it.rot || 0) + lean`. Its
own comment records that the lean *was* omitted here once, so this duplication
has already produced one bug. One `cardOf(item)` serves both.

**3.3 `canvas/model.ts:797, 806`.** `getBoundingClientRect()` and
`getContext('2d')` per turn frame. The stage's box cannot change during a
captured drag, and there is already a `ResizeObserver` on it (`:299`) whose
whole job is to repaint when it does. `getContext('2d')` on the same canvas
returns the same object every time. The comment at `:809` removed a per-frame
`getComputedStyle` for exactly this reason and left these two standing.

**3.4 `canvas/notes.ts:119`, called from `canvas/input.ts:2482`.** Per
pointermove of a note resize, this re-walks `nodeFor(id)` → `.card` →
`.note-rich` and calls `getComputedStyle(card)` for the paddings. Only `width`
differs between frames; the nodes and the padding are invariant for the gesture.
The measurement itself is defended in the header and is not in question — what
is roundabout is re-deriving everything around it. Resolve the nodes and padding
once when the gesture is entered (`input.ts:1806`, beside `grip.box`).

**3.5 `canvas/input.ts:2355`.** `drag.origin.find(o => o.id === drag.lead)` on
every frame of every drag. Neither `drag.origin` nor `drag.lead` is reassigned
after `enter('move', …)` at `:1645`. Resolve once in `startMove()`.

**3.6 `canvas/items.ts:249`–`258` with `:1452`–`:1458`.** `placeNode(id)`
resolves `byId(id)` and the caller immediately resolves it again, per moved item
per frame. Each is O(1), so this is mostly clarity — but the duplication is
invisible from the call site, which is how it got there.

---

## Batch 4 — the sibling sites

**4.1 The five `JSON.stringify` comparisons.** `ui/look.ts:223` documents both
the problem and what a false negative cost: `vars` keys "arrive in whatever
order the palette that wrote them happened to use", two identical looks compared
as different, and the re-apply that followed "clears `derived`", so "a board
could quietly lose the provenance of its own extracted palette by being told
about itself."

- `state.ts:1452` — compares `board.mobileHeader`, which carries an `axes` map
  built by `Object.entries` iteration. Same hazard shape as `vars`, on the door
  the masthead sliders write through.
- `state.ts:586` — a note's whole block model serialised twice on every editor
  commit, to answer "did anything change".
- `connections.ts:195`, `timeline.ts:315`, `timeline.ts:720`.

`state.ts` already has the right shape three times over in `sameRect`,
`sameAdjust` and `sameFlip` (`:1177`, `:1207`, `:1237`).

**4.2 `layout.ts:1169`.** `driven.includes(b.id)` inside a loop over every moved
item, in the file that argues against precisely this at `:1027`. A `Set` above
the loop.

**4.3 `ui/board-actions.ts:862`, `:863`, `:882`.** `host` is live from
`stuckTo(note)`, which returns the board item via `byId` (`sticky.ts:191`) — so
`byId(host.id)` *is* `host`, recomputed twice on adjacent lines inside a
loop that repeats until it stops growing. The `!` assertions exist only because
the round trip discards a non-nullness the code already had. `:882` is the same
shape: `items.map(i => byId(i.id)).filter(it => !!it)` over items that are
already live.

**4.4 `ui/appearance.ts:805`, `:818`.** `autoRecolour` honours `sourceKey`'s
documented one-pass design and then calls `recolourFromBoard()`, which walks the
board again and rebuilds the key. Fires on every `items` event with Dynamic on.
Thread the hashes through.

**4.5 `arrange/arrangements.ts:402`.** `Math.hypot` taken only to compare
against another radius, where `geometry.ts:357` exports `distSq` and its header
says not to reconstruct the long form.

**4.6 `layout.ts:166, 192, 199, 204`.** `` `${col}:${row}` `` as a `Set` key in
the Mobile packer. `columns` is bounded and rows are non-negative, so
`row * columns + col` into a `Set<number>` is exact. The header at `:208` already
names this cost and fixed only the row-scan half.

---

## Batch 5 — costs that grow with the board or the file

**5.1 `import/ooxml.ts:67`.** `byLocal` spreads **every descendant element**
into an array and filters it, at 34 call sites, a third of which take `[0]`.
`root.getElementsByTagNameNS('*', name)` answers by local name across namespaces
natively, O(matches) rather than O(all elements). Called twice per paragraph in
`slide.ts:399`–`402` and once per shape in `walk()`, so on a large deck it is
the dominant cost of `collect()`.

**Decision inside this one:** `getElementsByTagNameNS` returns a *live*
`HTMLCollection`, not the snapshot array `byLocal` currently hands back. Call
sites that only index are a straight swap; sites that iterate need a spread.
These documents are parsed read-only and nothing mutates the tree mid-walk, so
this is safe — but it is a semantic change and the commit should say so.

**5.2 `import/carved.ts:231`.** Reads up to `MAX_PICTURE` = 64 MB into memory
and wraps it in a Blob, then hands it to `embeddedPreview()`, which takes a Blob
precisely so it can slice lazily — the module header says "slice, never slurp".
`file.slice(at, at + size)` is the same Blob at zero cost, and the bound is
already checked on the line above.

**5.3 `import/cfbf.ts:336`.** `fromCache()` materialises *every* stream in the
file — each one a `new Uint8Array(length)` plus a chain copy — to read eight
bytes of signature from each. Rank by the `size` the directory entry already
holds, sniff the first sector, read only the winner. `MAX_FILE` is 96 MB and
this is the common path for `.doc`/`.xls`.

**5.4 `storage/session.ts:193`–`244`.** `referencedHashes()` walks items and
trash for hashes, then builds a fresh concatenated array of the whole board and
bin again to read `meta.was`/`meta.wasCover` — two keys reachable in the first
walk. Runs on every autosave tick, every commit's trailing edge, every explicit
Save, and again in `restoreSession()`.

**5.5 `trash.ts:261`.** `removeItems()` does
`board.items.map((item, index) => ({ item, index })).filter(…)` — on a 20 000
-item board, twenty thousand wrapper objects allocated to keep the matches.

**5.6 `board-schema.ts:534`, `:542`.** Seven intermediate arrays over board plus
bin per `serializeBoard()`, for two id sets that differ only by `isJoinEnd`. The
header defends why the two sets are separate, not the allocation.
`normalizeBoard()` at `:147` has the same shape on the load path.

**5.7 Sort-to-take-one.** `import/packages.ts:405` fully sorts every page with a
comparator that re-lowercases and re-tokenises **both** names on every
comparison, to take `[0]` — a 300-page `.cbz` is roughly five thousand
tokenisations to pick one cover. `arrange/arrangements.ts:111` does
`filter().sort()[0]` *inside a comparator*, so the allocation happens
O(n log n) times per Mobile reorder. `commands/view.ts:108` builds two whole
arrays to read two lengths.

**5.8 `storage/library.ts:194`.** `trimLibrary()` awaits `removeLibraryBoard`
per evicted row, and each one re-reads, re-sorts and rewrites the entire index.
Dropping k boards is k reads and k writes where one filter and one write would
do. On `shelveCurrent()`, which every Open, New and Switch calls.

**5.9 Double work in the optimize pass.** `optimize/ui.ts:35` builds a `Plan`
for the dialog and `runOptimize` (`optimize.ts:344`) discards it and builds
another; `optimize/ui.ts:49` and `optimize.ts:522` both call
`clipsWantingStills()`, each decoding every video cover. The two plans can also
disagree, since the board can change between the question and the answer.
`runOptimize` already takes an options object.

**5.10 Smaller, same family.** `import/drop.ts:536` with `:966` — the same
128 KB header slice read and parsed twice per image, up to `MAX_FILES` = 500 per
drop. `import/preview.ts:231` — `scalar` is `async` with no `await`, awaited six
times, and rebuilds a `DataView` per call inside a loop. `optimize.ts:737` —
`audioTags` and `coverArt` walk the same container serially for the same `ilst`
range. `import/containers.ts:907` — `flv()` rescans up to 256 KB three times for
three fields. `import/carved.ts:339` — three full copies of a vCard to find one
line. `ui/documents.ts:376` — `childOf` run twice per flag, four flags per text
run. `ui/hud.ts:298` — the whole board reduced, then discarded on the
single-selection branch. `ui/fonts.ts:638` — the font file read and walked twice
where the second answer is only consulted when the first is empty.

---

## Batch 6 — the fixed-point walk, six copies

| | |
| --- | --- |
| `sticky.ts:556` | `attachRiders<T>` — the generic one, exported, three callers in `layout.ts` |
| `sticky.ts:597` | `stuckFollowers` |
| `fences.ts:478` | `fenceFollowers` — near-verbatim of the above, same reverse-splice, same comment shape |
| `trash.ts:77` | `stickerCascade` |
| `ui/board-actions.ts:826` | hand-rolled, fences |
| `ui/board-actions.ts:853` | hand-rolled, riders — near-verbatim of `attachRiders` |

One `followers(pool, seed, parentOf)` covers the middle four. `trash.ts:77`
looks like the exception — its header argues at length that the naive
"`stuckFollowers()` then filter" is wrong, because a sticker on a note on a
deleted photograph must stay. But that argument is entirely about **which items
are in the pool**, so the pool predicate carries it and the documented subtlety
survives intact. Move that paragraph to the shared helper as the reason the
predicate is a parameter.

**Why this is late and on its own.** The two `ui/board-actions.ts` copies cannot
simply call `attachRiders` as it stands: that helper hands its `build` callback
the *live* host, and `board-actions` needs the host's pre-move geometry from a
snapshot. Folding them in means widening the callback, which is an API change to
a helper with three existing callers in `layout.ts`. That is a change worth
making deliberately and alone — not as a rider on a bug fix, which is why batch
4.3 takes the `byId` round trip out first.

**This is the largest single change in the plan and the one most reasonable to
decline.** Four of the six copies are correct, tested and stable. The argument
for doing it is not line count; it is that `ui/board-actions.ts` grew its copies
by transcription and inherited a bug that `sticky.ts` had already fixed and
documented. That is what a seventh copy will do too.

---

## Batch 7 — duplication and dead code

**7.1 Duplication with a documented hazard attached.**
`canvas/items.ts:206` and `canvas/web.ts:981` are the same `cullMargin`
one-liner with both constants duplicated, and `items.ts:196`–`205` says outright:
*"this copy had drifted away from it … Change one and change the other."*
Export it from `viewport.ts`, which both already import.
`canvas/renderers.ts:1692` re-spells `gridStep > 0 ? gridStep : 64` against
`layout.ts:487`'s explicit warning that "a second copy … in another file is how
the two would come to disagree"; it already imports from `state.ts`, which
re-exports `baseStep` at `:216`. One word in an existing import.

**7.2 Idioms duplicated across directories.** The `contentEditable =
'plaintext-only'` fallback, three lines and an identical comment, at
`canvas/items.ts:1183`, `canvas/notes.ts:639`, `ui/board-title.ts:216`. The
select-all-contents range dance at `canvas/items.ts:1234`,
`canvas/notes.ts:276`, `ui/board-title.ts:240` (collapse-to-end variant) and
`:308`, `ui/mobile-header.ts:751` — five sites, each carrying its own copy of
the `getSelection()!` justification. Two small helpers, `makeEditable(el)` and
`selectContents(el)`/`caretToEnd(el)`.

Fisher-Yates exists three times: `util.ts:86` `shuffle`,
`arrange/arrangements.ts:985` `shuffleWith` (identical but for the RNG source),
and inlined again at `canvas/playlist-queue.ts:286` beside `mulberryLike()`,
which is a one-line forward to `Math.random`. `export function shuffle<T>(arr,
rnd = Math.random)` serves all three. `web-graph.ts:427` `clampi` re-declares
`util.ts:45` `clamp`.

**7.3 UI builders written by hand N times.** The `<svg class="sticker-art">`
block at `ui/feed.ts:1142`, `ui/trash.ts:241`, `ui/sticker-window.ts:319`,
`canvas/renderers.ts:1367` — and `stickers/catalogue.ts:41` already says *"five
places build a `<svg class="sticker-art">` around a `<use>` … five literals is
five chances for one of them to be left behind"*, then shares only the `viewBox`
constant. Six private copies of create-element-with-class (`ui/panel.ts:90`,
`ui/documents.ts:169`, `ui/sound-lab.ts:65`, `ui/feed.ts:1270`,
`ui/playlist.ts:1343`, `ui/sticker-window.ts:511`). The role+tabIndex+click+key
block five times in `ui/feed.ts` and `ui/playlist.ts`. `ui/menu.ts:1964`
exports `icon()` precisely so others can borrow it, and
`ui/timeline-view.ts:598` re-spells it byte for byte while already importing
`openAnchored` from that module.

**7.4 Two per-file duplications worth the diff.** `canvas/grid.ts:614` and
`:933` are the same `ensureCanvas` twice. `import/artwork.ts:461`/`:489` are the
same FLAC block walk, and `:565`/`:611` the same `moov → udta → meta → ilst`
descent — the file's own comment calls the version/flags skip "the one irregular
step", and it is written twice. `web-graph.ts:204` and `:316` are two copies of
one uniform spatial hash, ~50 lines.

**7.5 Dead, verified against `tests/`, `tools/` and both lab bundles.**
`cuelume/engine.ts:812` `playVoice`; `cuelume/recipes.ts:268` `isSoundName`;
`import/budget.ts:169` `resetByteBudget` (found twice, independently);
`sticky.ts:421` `forgetSticks` and `fences.ts:254` `forgetFences` with their
four re-exports in `state.ts`; eleven pass-through re-exports at
`canvas/renderers.ts:44` (keep the three `tests/renderers.test.js` anchors);
`ui/settings-schema.ts:1027` `resetQuality`; `ui/documents.ts:217`'s `head`
option, never passed by any of five call sites; `tools/gen-formats.mjs:86`'s
`slug`, written and never read.

Three classes set in JS with no rule in `web/assets/css`: `ui/menu.ts:1579`
`is-toggle`, `ui/playlist.ts:653` `is-single`, `ui/timeline-view.ts:577`
`is-sealed`. The last matters — its comment claims "a square dot for a step that
carries a difference, a round one for a step that carries a rule", and only
`.is-ruled` has a rule, so the distinction the comment describes does not exist
on screen. That is either a missing rule or a wrong comment, and somebody has to
decide which.

---

## Decisions taken, reversible before anything starts

1. **`util.ts:331` `isDev()` stays.** See above — test anchor, and I got it
   wrong once already.
2. **`board.settings` and `board.arrangement` stay as hand-synced caches.** They
   are derived from `board.layoutSettings[mode]` / `board.arrangements[mode]`
   and written from three modules (`layout.ts:913`, `:944`, `state.ts:1497`,
   `:1521`, `:1541`, `:1548`). Making them accessors would put the fact in one
   place, and `layout.ts:923` calls them "the live compatibility surface" while
   drag paths read `board.settings` hot. Recorded as debt, not scheduled.
3. **`import/` keeps its per-file byte primitives.** `le32`/`be32`/`le16`/`bytes`
   are duplicated across six modules, and four of those headers explicitly argue
   against a shared low-level module. Left alone.
4. **No bounds check, ceiling or `Oversize`/`Error` distinction is touched by
   anything above.** `mesh.ts:865`'s redundant-looking `count > elemCap` stays:
   it is arithmetically subsumed by `:875`, but the two throws quote different
   numbers and `tests/mesh.test.js:568` matches on message text.
5. **`canvas/input.ts` is not split**, the `viewport.ts` LOD wrappers stay, and
   `ui/menu.ts` remains the only menu implementation.

## Two questions I am not answering for you

**`state.ts:511` `setItemText()` — delete it or document it?** No caller outside
`tests/state-items.test.js`. Note editing goes through `setNoteContent()`
(`:577`), which caps `NOTE_MAX`, keeps `meta.rich` in step and re-derives
`noteName()`; `setItemText` does the first and third and leaves `meta.rich`
stale, so calling it on a rich note produces exactly the desync
`storage/mbrd.ts:810`–`821` describes. Either fold its two assertions into the
`setNoteContent` tests and delete it, or keep it and say in its header that it
is the non-rich door. It is exercised by a real test rather than merely named by
one, which is why this is a question and not an item.

**Is batch 6 wanted at all?** See the argument at the end of that batch.

---

## What was checked and found clean

Recorded so it is not re-found. All 497 CSS class names resolve — the 27 that
look dead are built by interpolation (`web-c-${color}`, `note-${tag}`, and
`seekInnerHTML`'s prefix templating). No `JSON.parse(JSON.stringify(…))`
anywhere. Every `.filter(…).length` outside `commands/view.ts:108` and
`commands/item-meta.ts:172` is a genuine count being displayed. `paintGrain`,
`paintGrid` and `paintPaper` existing in both `canvas/` and `ui/snapshot.ts` is
a name collision and not duplication — one paints CSS onto DOM layers, the other
rasterises into a 2D context. No arrangement in `ARRANGEMENTS` or
`MOBILE_ARRANGEMENTS` is unreachable. `main.ts`'s `isPatch` branch, the
`setRiskPrompt` wiring and all eight `window.mbrd` keys are live and correctly
wired. Of ~184 exports with no importer, all but the handful listed in 7.5 are
types used locally or pure helpers exported for `tests/` — the house style, not
debt.

Indirection that a header argues for was left alone throughout, and there is a
lot of it: `ui/overlays.ts`'s per-call `getElementById`, `ui/panel.ts`'s
`data-value` store, `ui/snapshot.ts`'s render-then-downscale,
`ui/mobile-header.ts`'s write/read/write binary search in `fitLines`,
`canvas/embed.ts`'s `fitToPlayer(item.id)` re-read, `board-schema.ts:118`'s
per-item `topZ()` on load, `storage/zip.ts`'s compress-then-discard,
`patchMeta`'s double `validate()`. One thing found that is a real per-frame
O(board) cost and is **not** a roundabout route: `sticky.ts:243` `wouldStick()`
is a full scan called from `canvas/input.ts:2371` on every pointermove of a note
drag. There is no direct answer already in hand, and `sticky.ts` sits below
`canvas/` so it cannot reach `canvas/spatial.ts`'s index. Architectural, and
outside this plan.
