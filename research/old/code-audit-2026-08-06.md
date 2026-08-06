# Code audit — 2026-08-06

> **Status: carried out, and moved here on the commit that finished it** - which
> is [`research/README.md`](../README.md)'s rule being followed rather than
> described. All twenty-one findings below are fixed; the fix plan, with what was
> actually done against each and the two places it was departed from, is
> [`code-audit-2026-08-06-plan.md`](code-audit-2026-08-06-plan.md).
>
> **Dated from here on.** If any of this disagrees with the code, the code is
> right. The half still worth reading is "What was checked and found sound": nine
> plausible-looking findings were refuted with reasons, and re-finding them costs
> hours.

A multi-agent pass over the whole tree: seven auditors, one per subsystem, each
reading the real files rather than sampling, and every finding then handed to a
separate agent whose only instruction was to **refute** it — open the file, walk
the callers, look for the guard upstream, check whether a module header, `docs/`
or `research/` already sanctions the behaviour, and default to *refuted* when the
failure could not be demonstrated.

34 findings went into that filter. **25 survived, 9 were refuted.** Deduplicated
(three auditors independently found C-01; two found C-20; C-15 was reported twice
from opposite ends of the same call) the survivors are the **21 findings** below.

The refuted nine are kept at the foot of this file under
[What was checked and found sound](#what-was-checked-and-found-sound). That
section is the more useful half for a later pass: it is a list of things that
look wrong and are not, each with the reason, and re-finding them costs real time.

## Baseline

| check | result |
| --- | --- |
| `npm test` | pass, 0 fail |
| `node --check` over every tracked `.js`/`.mjs` | clean |
| `python -m py_compile serve.py qr.py` | clean |
| import paths, exact case | no mismatch |
| `web/assets/icons.svg` symbols vs `<use href>` | no mismatch, either direction |
| `SHELL` in `web/sw.js` vs files on disk | no missing app asset (see R-09) |
| `npm run test:e2e` | **2 failures** — see C-19 |

No `.mbrd` schema change, no generated-catalog change and no service-worker cache
change is implied by any finding here. C-09 touches the `.mbrd` *read* path
without changing what is written.

## Where the findings are

The uncommitted not-found/404 work is where the density is: **six of the
twenty-one** findings (C-01, C-12, C-13, C-14, C-15, C-17) live in code that is
not committed yet, including the only data-loss finding that survived refutation
with no mitigation at all. That is not a criticism of the work — it is the
newest and least-read code in the tree, and it is exactly where an audit should
find things. It does mean C-01 should land before that branch is committed.

| severity | count | ids |
| --- | --- | --- |
| high | 2 | C-01, C-02 |
| medium | 12 | C-03 … C-14 |
| low | 7 | C-15 … C-21 |

---

## High

### C-01 — `New` on a not-found board deletes the visitor's stored board

`web/assets/js/storage/storage.js:409` · data-loss · **uncommitted**

Found independently by three auditors; none could be refuted.

On a not-found boot `main.js:410` calls `suspendCache()`, which stops the
*writer*. Nothing stops the *deleter*. The sidebar renders complete on a 404
address — no module under `web/assets/js/ui/` consults `notFound` — so
`ui/settings-schema.js:144` (`{cmd:'new'}`) → `commands.js:241` → `newBoard()`
is fully live. Inside `newBoard()`:

- `storage.js:409` `await clearSession()` → `session.js:408-411` is
  `idbClear('kv')` + `idbClear('assets')`. That is the single session slot, and
  on a not-found boot the board on screen was never loaded from it
  (`main.js:411` skips `restoreSession`). It deletes a board the visitor cannot
  see and has not been asked about, plus every embedded asset.
- `storage.js:417` `resetSessionLatches()` → `session.js:565` sets
  `cacheOk = true`, undoing the boot-time suspend. The blank board then autosaves
  into the slot that was just emptied.

No prompt intervenes: `setTitle()` (`state.js:1807`) emits `'board'` without
`markDirty()`, and the title/ghost seeding is hydration with no commit, so
`isDirty()` is false and `confirmDiscard()` (`storage.js:436`) returns `true` on
its first line.

The one plausible rescue does not fire. `loadBoard()` inside `newBoard()` emits
`'items'` into the still-armed `onFirstContent` (`main.js:412`), but it seeds only
the title card, and `hasContent()` uses `isContent()`, which excludes furniture —
so the handover no-ops and `clearSession()` runs four lines later against the
untouched real session.

Two things settle that this is an oversight rather than a documented choice.
`openFile()` on the same board is safe — it neither clears the session nor resets
the latches, so the visitor's board survives an **Open** but not a **New**. And
`leaveNotFound()` (`main.js:380-402`) takes visible care over exactly this
ordering hazard (restore first, latches last), which shows the hazard is
understood; `newBoard()` simply does not participate. `main.js:415-419` states in
prose that the visitor's board cannot be lost here.

`isNotFoundBoard()` (`state.js:707`) has exactly two consumers — `canvas/ghosts.js:228`
and `state.js` itself. Nothing in `storage/`, `commands.js` or `ui/` consults it.
`clearAllData()` (`session.js:463`) reaches the same wipe from **System → Clear
everything**, though that one at least asks.

There is no test anywhere in `tests/` that mentions the not-found board.

> **Failure.** Visitor with a saved board follows a stale link
> `https://mbrd.valjdakosta.com/boards/kitchen`. They get a blank board with the
> two 404 cards. They press **New** to start something here. No confirmation.
> Their board and its images are gone, and the blank board is written over the
> emptied slot on the next tick. Returning to `/` restores nothing, with no
> message at any point.

### C-02 — `loadBoard()` swaps `board.items` while `byId()`'s index still describes the old board

`web/assets/js/state.js:1851` · correctness

`board.items = next.items.filter(...)` is at **state.js:1851**. The only thing
that drops `byId()`'s lazy Map (`board-model.js:431`) is the `'items'` event,
emitted at **state.js:1888** — the second-to-last statement of the function.
Everything in between runs against a Map built over the *previous* board, and
`completeLayout(layoutMode)` (`state.js:1868`) is in between.

On Desktop that is harmless (the Desktop branch calls no `byId`). On Mobile,
`attachRiders` does a redundant second lookup at `sticky.js:255` —
`build(note, byId(host.id), hostDst)` — although `host` is already the live item
object `stuckTo()` just returned. That `byId()` reads the stale index, returns
`undefined`, and `stuckOffset()` (`sticky.js:218`) dereferences `host.x`.

Mobile is not exotic: `ui/sidebar.js:104` sets the mode from the stored pref or
the detected viewport at startup, so a phone is in it from first paint.

The aftermath is worse than the throw. `openFile()` catches at
`storage.js:300-303` and `withFreshAssets()` rolls the asset registry back — but
`board.items` and `board.title` are already the new board's and no event fired,
so the old board's DOM sits over the new board's state with `selection`, history,
clipboard and the dirty flag never reset (`state.js:1869-1878` never ran). The
20s autosave then serialises that: the new file's items against the old board's
assets, over the user's session copy. This is precisely the half-loaded board
`loadBoard()`'s own header exists to prevent.

The same-id variant does not throw: the stale index hands back the previous
board's item and the note is placed from the old geometry, silently.

> **Failure.** Reproduced against the real modules:
> `loadBoard(A); setBoardMode('mobile'); byId('photoA'); loadBoard(B)` where B
> holds a note with `meta.stuckTo` throws
> `TypeError: Cannot read properties of undefined (reading 'x')` at
> `stuckOffset (sticky.js:218)` ← `attachRiders` ← `completeLayout (layout.js:549)`
> ← `loadBoard (state.js:1868)`. In the app: on a phone, open a second `.mbrd`
> containing a note stuck to a card.

---

## Medium

### C-03 — `commitGeom()` forgets the presnap memo on a z-only change

`web/assets/js/layout.js:737` · data-loss

`GEOM_KEYS` (`layout.js:334`) is `['x','y','w','h','rot','z']`, and the
presnap-forgetting block tests all six. Its comment scopes it to items "placed by
hand while snapping was on" — a spatial claim — but a pure `z` change satisfies
the predicate. `raiseSelection()`/`lowerSelection()` (`stacking.js:35-56`) always
assign a fresh `z` (so it differs even for an already-topmost card) and then call
`commitGeom()` with no `driven` and no `preservePresnap`.

`meta.presnap` is serialised through `geometryOf()` into the layouts record, so
the loss survives save and reload, and `unsnapAll()` (`state.js:938`) then has
nothing to put back. Undo restores it, but only immediately after the raise.

This contradicts the file's own model: `layout.js:743-747` explicitly lists
*Bring to front* among the callers that "change no note's position relative to
anything", and `docs/mbrd-format.md:382` defines `presnap` with no `z` caveat.
`preservePresnap: true` is already passed at `layout.js:314` and
`ui/board-actions.js:684`; neither covers the `z` path.

> **Failure.** Reproduced. Two cards at (13,27,241×181) and (400,27,241×181);
> `setSetting('snap', true)` records `presnap` on both. `select(['a']);
> raiseSelection()` → `byId('a').meta.presnap` is `undefined`. Turning snap off
> leaves `a` at (0, 32, 250.88, 186.88) — its snapped box — while the untouched
> `b` returns to (400, 27, 241, 181). Every card the user ever brought to front
> has lost its pre-lattice position.

### C-04 — `readWheel()` resets half the burst state, so a free swipe after a railed one is amplified

`web/assets/js/canvas/input.js:392` · correctness

The fresh-burst branch resets `axisX`/`axisY` but not `seenX`/`seenY`
(declared `:290-291`, eased at `:332-333`), and `seenX`/`seenY` are the only
input to the unrail gain at `:338`. The one other reset, `resetWheelKind()` at
`:294`, is called by nothing under `web/` — grep finds it only in
`tests/input.test.js`. The single app call site (`input.js:1523`) has no reset
path, so the state persists for the page lifetime.

Because `axisX`/`axisY` *are* reset, `minorIsX` is re-decided from the fresh
event's own deltas, so the stale presence measure only bites when the new
gesture's minor axis is the one the previous burst gated — a mostly-sideways
flick after a vertical rail passes through untouched. It also decays over ~10
events at `AXIS_EASE 0.15`, with `UNRAIL_CAP` bounding each event to 40px. Real,
reproducible, self-correcting: medium, not high.

`input.js:282-288` and `docs/architecture.md:615-617` ("Both measures start at
'delivered whole', so nothing is lifted on the strength of the first event or
two") both assert the invariant this breaks, and the header's own recorded pair
of a railed then a free swipe "from one pad within a minute" is the triggering
sequence.

The existing test passes on a tie, not on a reset: `tests/input.test.js:327` uses
`deltaY 20` against `deltaX 20`, so `axisX === axisY`, `minorIsX` is false and the
gate is 0. Changing it to `deltaY 20.0001` gives `dx 53.949`.

> **Failure.** 40 railed events `[0,15]`, pause past `WHEEL_STREAM_MS`, then
> `[20,21]` returns `dx` 53.95, 48.86, 44.53, 40.85 against a flat 20 from a cold
> start — 194px of invented sideways travel over 12 events. Exactly the "the
> board sliding out from under you" failure `unrail()` is documented to avoid.

### C-05 — the `#t=0.1` poster fragment makes every desktop video permanently non-disposable

`web/assets/js/canvas/renderers.js:454` · correctness

`renderers.js:451-454` is the plain `else` of `if (onTouch())`, so every desktop
video card gets `v.src = blobURL + '#t=0.1'`. Confirmed in Chromium that the UA
really does seek there and stay: `loadedmetadata` → `currentTime 0.1`, still
`0.1` two seconds later, `paused: true`. Without the fragment it is `0`.

`disposable()` (`canvas/items.js:310-313`) returns false on `m.currentTime > 0`,
so the detach pass (`items.js:576-590`) takes the `else` branch and only calls
`el.remove()`. The node stays in the `nodes` map with a live `src` and a decoded
first frame. There is no cache cap anywhere — the only other removals are
`dropNode` and `clearAll` — so `viewStats().cached` grows monotonically with
every desktop video panned over.

`disposable()`'s own doc scopes the exemption to "media that is doing something —
a video left playing, an audio scrubbed to the middle". A poster frame is
neither. Nothing in `CLAUDE.md`, `docs/` or the `poster.js`/`drop.js` comments
about `#t=0.1` acknowledges the `currentTime` side effect; they describe only the
free poster frame.

Second consequence: `paint()` (`canvas/video.js:101-102`) computes
`parked = video.paused && !video.currentTime`, which is now false, so the
transport prints `clock(0.1)` → `"0:00"`. The "a parked clip shows how long it
is" behaviour is dead on the desktop path. (It is dead on touch too, for the
unrelated reason that with no `src` there is no metadata and `duration` is `NaN`.)

The retained object is a detached, paused, `preload=metadata` element — demuxer,
buffered metadata range, one decoded frame — not a full playing pipeline. Real
and unbounded, but cheaper per card than "a live decoder each".

> **Failure.** 40 video cards on a desktop board, panned across once:
> `mbrd.viewStats().cached` reaches 40 and stays there for the life of the tab.

### C-06 — move and resize gestures dereference `byId()` unguarded

`web/assets/js/canvas/input.js:758, 1245, 1323` · correctness

Reproduced live in the app: press a card, drag past `DRAG_SLOP` so
`g.kind === 'move'`, press **Delete** without releasing, move again → five
consecutive uncaught `TypeError: Cannot read properties of undefined (reading 'w')`
page errors, one per `pointermove`.

No guard exists upstream. `input.js` registers zero `bus.on` listeners, so nothing
cancels the active gesture when items vanish; `abortGesture()` is only invoked by
the pinch takeover and the long-press menu. The keydown handler (`input.js:1589`)
stands down only for `typingInto()` and `shortcutsSuppressed()`, neither of which
knows about `g`. `removeItems()` emits `'items'`, which drops the index, so the
lookup genuinely returns `undefined`.

Three sites: `input.js:1245` (move, reproduced), `input.js:758`
(`raiseToFront`, reachable via press → Delete → first move past the slop) and
`input.js:1323` (resize, confirmed by reading — the harness could not start a
resize on the default board because ghosts expose no `.grip`).

The inconsistency is the tell: `stackOrder` uses `byId(a)?.z`, `input.js:1234`
uses `leadItem?.type`, `applyGeom` uses `if (!it) continue`, `snapshotGeom`
filters — yet these three dereference bare.
`research/old/2026-07-30-ghost-cards.md:341-345` already flags the scenario as a
known, unhandled edge.

One correction worth carrying to the fix: on release, `commitGeom` recomputes
`after` from the surviving ids, so a fully-deleted selection commits nothing.
A wrong entry only arises in the partial case (stuck followers surviving a delete
that removed only the selection), where `before[i]`/`after[i]` misalign. Since
`applyGeom` writes by id and skips missing ones, no geometry is corrupted; the
worst outcome is a spurious or skipped no-op undo entry. The gesture self-heals
on release. Practical harm: console noise and a card that stops tracking for the
rest of the drag.

### C-07 — `dedupeIds()` hangs forever on two items sharing a 64-character id

`web/assets/js/board-model.js:489` · correctness

`next = (it.id + '~' + k++).slice(0, 64)` returns `it.id` itself for every `k`
when `it.id` is already 64 characters, while `seen` already contains `it.id` from
line 487. Replayed under node with a tripwire: passed `k = 3,100,000` with
`next === it.id` still true. Non-terminating, no allocation, so no OOM fault —
just a wedged tab with no error, no toast and no way out but killing it.

`makeItem()` (`board-model.js:506`) truncates `partial.id.slice(0, 64)`, so any
two file-supplied ids agreeing on their first 64 characters reach it.
`docs/mbrd-format.md:347` declares `id` as `[A-Za-z0-9_-]{1,64}`, so a 64-char id
is *legal input*. No upstream guard: `normalizeBoard()` filters object shape and
caps counts before calling `dedupeIds` at `state.js:1920` (items) and
`state.js:1963` (trash, against the shared set), and `storage/mbrd.js` applies
`SAFE_ID` to note filenames on save, never to ids on load.

Severity is medium rather than high only because every board this app *writes*
uses `uid()` (~12 characters), so it needs a hand-written, third-party or
corrupted `board.json`. `withFreshAssets()` never gets to roll back, so the
previous board's asset URLs are left cleared in a hung document.

It contradicts two stated promises: `board-model.js:476-484` (deterministic
regeneration) and `state.js:1883-1889` (degrade "with no way to fail").

### C-08 — the autosave sweep deletes optimiser originals held by binned items

`web/assets/js/storage/session.js:146` · data-loss

`referencedHashes()` walks `data.trash` for `itemHashes()` at line 140, but the
`was`/`wasCover` loop at lines 146-149 iterates `data.items` only. `itemHashes()`
(`util.js:191-192`) reports `asset.hash, meta.cover, meta.shot, meta.thumb` — never
`was` — so a binned optimised item's original bytes read as unreferenced and the
sweep at `session.js:293` deletes them.

The bin really does carry `meta.was`: `removeItems()` bins the item object
untouched, `serializeItem` copies `meta` verbatim, `normalizeMeta()` gates only
`cover/shot/thumb`, `restoreItems()` spreads `...e.item`, and
`discardOriginals()` walks `board.items` only, so a binned item's `was` is never
cleared either.

Dragging the card back out then puts `was` on a live item: the next
`writeSnapshot()` finds the hash referenced, absent from `known` and absent from
`allAssets()`, pushes it into `missing`, returns false, and writes with
`dirty: true`. `saveBoard()` returns early on the false and never calls
`markDirty(false)`, so **the board never goes clean again**, and every later
reload counts it as `lost`.

The toast is worse than it first appears. `describeMissing()` (`session.js:321-334`)
matches the missing hash against `item.asset.hash` only, and a `meta.was` is no
item's `asset.hash` — so it resolves to no name and the message reads
**"0 items () have no stored data - the board cannot be saved complete"**. An
unactionable failure naming nothing. Verified by running `describeMissing`
directly.

Same-session deletion is safe (the memory store still holds the bytes); the
reload is what makes it permanent. `packBoard()` drops `was`, so Export is
unaffected. There is an escape hatch — **Discard originals** (`optimize/ui.js:154-170`)
strips `was` from live items — but nothing points the user at it.

The module header at `session.js:126-134` argues the opposite case in as many
words ("the bin's bytes are not optional").

### C-09 — a hand-edited `notes/*.md` is silently ignored for any note carrying `meta.rich`

`web/assets/js/storage/mbrd.js:442` · format round-trip

`unpackBoard()` writes `item.meta = { ...item.meta, text: parseNote(...) }`,
which preserves `meta.rich` untouched. Nothing anywhere in `mbrd.js` mentions
`rich` (zero grep hits), and `withoutPeaks()` strips only `peaks`/`was`/`wasCover`,
so `rich` is written to `board.json` in full. `normalizeNoteRich()`
(`canvas/note-model.js:93-96`) uses `text` only when `rich?.blocks` is not an
array, and `renderers.js:496` draws through it.

The scope is not an edge case: `readRich()` (`canvas/notes.js:167-179`) always
returns a full normalised object, so `rich` is present on essentially every note
the current editor has ever committed.

This contradicts the format's headline promise, stated in three places:
`docs/mbrd-format.md:423` ("The `.md` outranks `board.json`. Edit one of these
files by hand, rezip, and the board opens with your edit"), `mbrd.js:206-209`
and `434-435`, and `board-model.js:500-501`, which explicitly names "a
`notes/*.md` someone edited by hand outside the app" as a supported door.
`research/old/roadmap.md:198-201` flags this exact principle as one that "should
be written down before it is accidentally broken".

`tests/mbrd.test.js:174-191` ("a hand-edited note file wins over `board.json`")
only ever builds notes with `meta.text` and no `meta.rich`, which is why the
regression is uncaught.

Adjacent symptom in the same writer: `noteMarkdown()` (`mbrd.js:226-231`)
unconditionally prefixes `'# '` to the first line of `meta.text`, which for a
rich note already carries its own marker — the exported file reads
`# # buy the smaller one`. It still round-trips (`parseNote()`'s `^#+\s*` strip
eats the added marker), so it is cosmetic, but it is the same writer never having
been updated for `meta.rich`.

> **Failure.** Reproduced end to end. Export a board with a note reading "buy
> the smaller one"; edit the `.md` to "buy the larger one"; rezip; open. `meta.text`
> takes the edit, `meta.rich` does not, the card draws the old words, and Find
> matches on "larger" because search reads `meta.text`. Touching the note once
> flattens the stale `rich` back over `text` and the hand edit is gone for good.

### C-10 — a cancelled cover picker hijacks the Open-board picker

`web/assets/js/import/drop.js:204` · correctness

`pickCover()` sets `input.dataset.mode = 'cover'` on the shared `#file-input`.
The only site that clears it is the `change` handler (`drop.js:151-165`), and no
`cancel` or `focus` listener exists for that input outside `pickViaInput()`. So
an Escaped cover picker leaves `mode='cover'` set.

The module's own header at `drop.js:174-178` states the premise that makes this
fatal — "a cancelled picker never fires `change`" — and rewrites `accept` and
`multiple` at open time for exactly that reason. It never rewrites `mode`. This
is an oversight *inside* that fix, not a documented choice.

Listener ordering confirmed: `initDrop(vp)` runs at boot (`main.js:156`) while
`pickViaInput()`'s handler is only added when **Open** is pressed
(`storage.js:368`), so `drop.js`'s handler fires first and synchronously runs
`const files = [...input.files]; input.value = '';` before any `await`. Per the
HTML spec, setting `value` to `''` empties the selected-files list, so
`storage.js`'s handler then reads `input.files[0] || null` and gets `null`.

Two corrections to scope. It is a **one-shot** swallow — `drop.js:155` deletes
`dataset.mode` while handling the hijacked event, so only the first Open is
eaten. And the mirror case is mostly benign: a cancelled "Add files" leaves
`mode='content'`, and the hijacked Open routes through `importFiles()`, whose
`looksLikeMbrd` branch calls `openFile()`, so the board does open. The genuinely
broken path is: cancel a *cover* picker, then Open, on a browser without
`window.showOpenFilePicker` (Firefox/Safari).

The related comment at `drop.js:188-196` ("Cleared as soon as it is read, so a
cancelled picker cannot leave a card armed…") is wrong for the same reason —
`coverFor` is cleared on read only. It happens to be harmless because the next
`pickCover`/`pickFiles` overwrites it.

> **Failure.** Firefox/Safari: right-click a card → "Choose a picture" → Escape.
> Press **Open**, choose `holiday.mbrd`. `openBoard()` gets `null` and returns
> false; the board never opens; the only message is a toast reading
> "holiday.mbrd is not a picture".

### C-11 — the ffmpeg worker's boot handshake has no timeout

`web/assets/js/optimize/media.js:157` · correctness

`media.js:107`'s probe fetch has no `AbortSignal` and its catch handles rejection
only. `media.js:157`'s `await ready` has no ceiling: `spawn()` settles on a
`'ready'` message, a Worker-constructor throw, or `error`/`messageerror` — none of
which fire when `media-worker.js:22` (synchronous `importScripts`) or `:40`
(`await fetch`) stalls without throwing. `boot()`'s catch therefore never runs.
`JOB_TIMEOUT_MS` is armed inside `ask()`, strictly after boot.

The `importScripts` leg is a synchronous worker-thread load, so a stall there also
blocks the worker's own message loop — it cannot even report a later failure.

Reachable from ordinary import, not a button: `renderers.js:199/202` yields
`decodable:false` for a clip the browser cannot open, `drop.js:505` calls
`posterFor(file,false)`, which reaches `firstFrame()` at `drop.js:465`; its
try/catch catches rejections, not hangs.

Worse than a single stuck import: `ready` is left **pending** rather than
rejected, so `if (!ready)` (`media.js:142`) stays false and every later
undecodable-video import in the session awaits the same dead promise. And since
`mediaAvailable()` caches only `true`, a stall in the probe re-fires a fresh
hanging fetch on each call.

The module header (`22-24`, `37-39`) promises graceful degradation on the
assumption the fetch *throws*. Prior audits (AUD-10, A-03) and
`tests/media.test.js` cover crash, reject and constructor-throw — never a stall.

> **Failure.** Drop an H.265 clip on a half-dead network. One of the six import
> workers blocks forever inside `prepareFile`, `Promise.all` (`drop.js:325`)
> never resolves, `job.end()` in the `finally` never runs, `busy()` has no
> auto-expiry, and the "Reading N files" strip stays up for the rest of the
> session. The files that had already finished preparing are lost with it.

### C-12 — writing the first note on the not-found board throws and leaves a blank card

`web/assets/js/main.js:388` · correctness · **uncommitted**

Reproduced deterministically with Playwright, instrumented at rAF granularity:
t=121ms the note item is added to the not-found board; t=143ms `composeNote()`'s
rAF opens `#compose` and moves the card into `#compose-mount`; t=202ms
`restoreSession()` resolves, `loadBoard()` emits `board:load`, `main.js:275` runs
`resetItems()`, and `discard()` (`canvas/items.js:283`) calls `el.remove()` on the
card living in the dialog:

```
[mbrd] handler for "board:load" NotFoundError: Failed to execute 'remove' on
'Element': The node to be removed is no longer a child of this node.
  discard (canvas/items.js:283) <- resetItems (canvas/items.js:1195)
  <- main.js:275 <- loadBoard (state.js:1882) <- restoreSession (session.js:380)
  <- leaveNotFound (main.js:388)
```

Not a spurious no-op: removing the card blurs the focused `.note-rich`,
`onFocusOut` runs `finish()` synchronously, and its `onDone` does
`home.insertBefore(node, after)` (`canvas/notes.js:733`), re-parenting the node in
the middle of Chrome's removal step.

The observed damage, from three clean runs: the composer opens for ~60ms and is
then ripped away; `finish()` runs from the forced focusout with empty text;
`takeBack(added)` removes the note; and `leaveNotFound()`'s
`board.items.push(...mine)` puts that same removed item back. The restored board
gains **one permanently blank note and no editor**.

Beyond that: `resetItems()` aborts before `nodes.clear()`, `shadows.clear()`,
`shadowLayerEl.replaceChildren()`, `clearDisplay()`, the tiltBag reset,
`reconcile()`, `reindex()` and `sync()`; and the remainder of the `board:load`
handler (`resetModels()`, `syncBoardMode()`, `openingView()`, the hud toggle,
`paintSnap()`, `paintCount()`, `resetSave()`) never runs for the board that was
just restored — so the view is not fitted to it and a session saved in the other
layout mode comes back in the wrong one.

Nothing subscribes to `board:load` to close the composer, and `flushNoteEdit()`
(`canvas/notes.js:815`) — the synchronous close `main.js` already calls on
`pagehide` — is not called before the `await`. The `leaveNotFound()` header
enumerates three ordering requirements and says nothing about an open editor.

*(The originally reported duplicate card and mangled `"# "` text do not happen —
they were an artifact of the reporting script typing after teardown, when focus
had returned to the toolbar's Note button and the spaces re-pressed it.)*

### C-13 — items added while the handover awaits `restoreSession()` are discarded

`web/assets/js/main.js:387` · data-loss · **uncommitted**

`main.js:381` detaches `onFirstContent` unconditionally; `main.js:387` snapshots
`board.items.filter(isContent)` **before** the await at 388. `restoreSession()`
awaits a chunked IndexedDB asset read (CHUNK=32, `session.js:363-375`,
self-described as "the whole of the wait between opening the tab and seeing
anything") and then calls `loadBoard()`, which reassigns `board.items` wholesale
and calls `clearHistory()`. Only the pre-await snapshot is pushed back at
`main.js:399`.

Checks that failed to refute it: `busy()` is a non-blocking strip, not a modal;
`initDrop()` runs at module top so drop/paste listeners are live for the whole
window; `suspendCache()` suspends writes, not adds; nothing re-arms
`onFirstContent`; `clearHistory()` removes the undo entry, so there is no
recovery.

Severity is medium rather than high because it needs three things to coincide: a
not-found URL, a stored session heavy enough that the chunked read takes
appreciable time, and a *second* content-adding action inside that window. The
common case — land on a dead address, drop once — is fully covered, because
`addItems` pushes an entire batch before emitting `'items'`. The loss is visible
rather than invisible (the item disappears from screen), though the "Moved to
your board" toast actively misrepresents what happened.

`main.js:544-550` documents fixing the identical race for `launchQueue` by
awaiting `started` — corroborating that this is a bug, not a choice.

> **Failure.** Verified with Playwright. Stored session `[title, note@-500]`.
> Land on `/oops`, then in one tick `cmds.addNoteAt({x:800,y:0});
> cmds.addNoteAt({x:1200,y:0});`. Result: `['title:0','note:-500','note:800']` —
> `note@1200` is gone with no diagnostic anywhere.

### C-14 — a visitor with no stored session keeps a board permanently named "Not found"

`web/assets/js/main.js:436` · correctness · **uncommitted**

On a not-found boot `restored` is hardcoded false (`main.js:427`), so
`if (notFound) setTitle('Not found')` at `main.js:436` always fires and
`state.js:1807` assigns `board.title` for real. `main.js:449` arms
`onFirstContent` for every not-found visitor.

`restoreSession()` returns false immediately for an empty IndexedDB without
touching `board.title`, so `had === false` is trivially reachable — and nothing on
that path resets the title. `leaveNotFoundBoard()` clears a boolean;
`dismissGhosts()` strips ghost items. The title is only ever repaired
*incidentally* on the `had === true` branch, when `loadBoard()` overwrites it at
`state.js:1832`. There is no counterpart when there is no stored board.

`resetSessionLatches()` then re-enables the writer and `autosave()` persists it,
so it survives reload. `renderers.js:680` prints `board.title` on the Desktop
title card, and `isDefaultTitle()` is
`title === 'Untitled board' || AUTO_TITLE.test(title)` — `'Not found'` fails that
test, so it renders as a genuine board name rather than a placeholder, and Export
would write `Not found.mbrd`.

The comment at `main.js:433-435` justifies the `setTitle` call with "it marks
nothing dirty, and the writer is off anyway" — exactly the premise
`leaveNotFound()` invalidates by switching the writer back on.
`grep -rn "Not found"` over `web/`, `docs/`, `research/` and `tests/` returns a
single hit: line 436 itself.

No data loss and the user can rename, but the broken branch is the *common* case
for the population the feature targets — a first-time visitor at a bad URL is the
most likely to have an empty IndexedDB.

> **Failure.** Verified with Playwright in a fresh context. Load `/oops`, add one
> note. After the handover: `{url:'/', title:'Not found', titleCardText:'Not found'}`.
> Reload `/`: still `'Not found'`.

---

## Low

### C-15 — Save on a not-found board blames the browser for a suspension the app chose

`web/assets/js/storage/session.js:243` and `web/assets/js/main.js:426` · **uncommitted**

Reported twice, from both ends of the same call. `main.js:426`'s
`if (notFound) suspendCache();` sets `cacheOk = false`, and `writeSnapshot()`
(`session.js:241-245`) reads that latch as a *storage verdict*, setting
`lastFailure` to `'This browser will not store the board (full, or blocked) -
export it to a file'` — the same string as the quota/private-mode catch at
`session.js:314`. `saveBoard()` (`storage/storage.js:112-123`) toasts it verbatim
in red. `restartApp()` (`ui/board-actions.js:360-374`) reaches the same latch and
opens "Restart anyway? This board could not be stored in this browser".

Not short-circuited: `saveGen` starts at 0 and `committedGen` at -1, so the first
press always reaches `writeSnapshot`. The Save button is an unconditional schema
entry and Ctrl+S is bound unconditionally.

This is the only *durable* window for the wrong message — the other two
`suspendCache()` callers are momentary (`newBoard` re-arms four lines later;
`clearAllData` reloads). Here it lasts from boot until the first real content
triggers `leaveNotFound()`.

Nothing is at risk: a pristine not-found board holds only the title card and two
ghosts, none of which `isContent()` counts. The defect is a false diagnosis that
sends the visitor off to check their disk or their private-browsing setting, plus
advice ("export it to a file") that would write a blank board titled "Not found".
The refusal to write is right; only the stated reason is false.

### C-16 — `loadBoard()` counts fences as content when resetting the ghost latch

`web/assets/js/state.js:1855` · correctness

`resetGhostLatch(board.items.some(i => i.type !== 'title'))` counts a fence as
content. `isContent` (`board-model.js:395`) deliberately excludes fences and its
header says so in as many words: "a board holding nothing but fences is a board
holding nothing, which is exactly the board that should still be showing its
hints". `isContent` is already imported at `state.js:58`.

Drift, dated: `git log -S` puts the latch line at dc355e4 (v0.88) and `isContent`
at 20e0331 (v0.120) — the fences commit, which converted `hasContent()` and added
`tests/fences.test.js:320` but touched `state.js` in eight other places and missed
this one. The only types removed before the check are `'ghost'` (line 1851) and
`'title'` (in the predicate), leaving `'fence'` as the sole divergence.

Reachable in the app, not just in tests: `commands.js:417` explicitly supports
the empty band, and `canvas/ghosts.js:224` sweeps only on `hasContent()`, so
drawing a fence leaves the hints standing *in session* — which is precisely the
state that disappears on reopen.

> **Failure.** Reproduced through a real save/load round trip: in-session
> `hasContent=false, hasGhosts=true`; after reload `hasContent=false,
> hasGhosts=false`. Draw a fence on an empty board, save, reopen: the four
> onboarding hints are gone from a board that still holds nothing.

### C-17 — the not-found cards' geometry is off the 64-unit lattice its own header claims

`web/assets/js/state.js:627` · correctness · **uncommitted**

`latticeLow()` snaps the *low edge*. `NOTFOUND`'s `gone` has low x -416
(-6.5 steps of 64) and `back` low y -160 (-2.5 steps), so `latticeBox(g, 64)`
moves `gone` x -192 → -224 and `back` y -64 → -96, while all four `HINT_GHOSTS`
keep their centres exactly — they were clearly written to satisfy the invariant
`state.js:608-610` documents. The header's span arithmetic is independently wrong
too: -192 + 224 = 32, so the real channel is 96 units, not the stated 64.

The trigger is post-boot, not seed-time: `main.js:411` forces `restored = false`
so the board carries `DEFAULT_SETTINGS` with `snap=false`, and the one
snapped-by-default profile (mobile) takes the `placeMobileItems` branch instead.
The reachable route is the advanced **Snap to grid** checkbox
(`settings-schema.js:202`) or the whimsy slider moved to Harsh
(`ui/appearance.js:383`), both of which run `snapAll()`.

Effect is cosmetic only — after snapping nothing overlaps or clips, and the board
is never persisted. Nothing in `tests/` covers the `NOTFOUND` set at all.

### C-18 — folder drops are truncated to 500 with no notice

`web/assets/js/import/drop.js:262` · correctness

`walkEntry()` guards on entry with `if (out.length >= MAX_FILES) return;` and
pushes at most one file per call, so `out.length` saturates at exactly 500 and can
never exceed it. `importFiles()` then tests `files.length > MAX_FILES`, and
`500 > 500` is false, so `trimmed` never becomes true and the
`(capped at ${MAX_FILES})` suffix at `drop.js:391` never appends. `canWalk` is
true in every current browser and for loose files as well as folders, so this is
the ordinary drag-and-drop path.

The cap itself is deliberate and documented (`docs/architecture.md:765-768`,
`import/budget.js:3`), nothing is lost from disk, and the emitted toast is
truthful about what *was* added — hence low. The defect is a single missing
informational suffix, on the one path where it matters most. It still fires on
the clipboard-paste and `#file-input` picker paths, where the browser hands over
an uncapped list. The module header at `drop.js:96-98` argues explicitly against
silently swallowing a drop.

> **Failure.** Drag a folder of 2,000 photographs onto the board in Chrome. The
> toast reads "Added 500 items". 1,500 files were discarded with nothing said.

### C-19 — two e2e assertions contradict the code they cover, and fail

`tests/e2e/board.spec.js:366` and `:693` · correctness

Reproduced on a clean `git worktree` checkout of HEAD (56f9df7), not just on the
dirty tree:

1. `board.spec.js:366` fails `toHaveAttribute('type','color')` with Received
   `"text"`. `#ask-field` resolves to the static `<input hidden type="text">` at
   `web/index.html:853`, because `cmds.addSwatch` now awaits `pickColor()` and the
   `#pick` dialog (`web/index.html:877`) instead of `ask()`. `ui/dialog.js:79` is
   the only writer of that attribute, and `ui/color-picker.js`'s header states the
   replacement outright.
2. `board.spec.js:693` fails with `locator('#fence-prompt') element(s) not
   found`. `marqueeHit()` (`canvas/input.js:117-121`) catches a fence only by full
   containment, so a band drawn *inside* a region catches just the card,
   `fenced()` is `[card]`, and `sharedFence()` (`commands.js:150-154`) returns its
   fence so `cmds.fencePrompt` returns before `openFencePrompt`.

Both app behaviours are the deliberate, documented ones. The defect is in the two
stale assertions, which shipped in the same commit as the code that contradicts
them. Test-side only, and `playwright.config.js`'s header puts the suite outside
CI — but the cost is a red baseline for anyone following the repo's own "run it
when you have touched the canvas" advice, plus two flows losing coverage: swatch
creation via the toolbar, and the in-region band stand-down.

### C-20 — `serve.py`'s docstring documents an SPA fallback and a `404.html` that no longer exist

`serve.py:11` · stale docs · **uncommitted**

Found by two auditors. The docstring at lines 11-13 still reads
`"/anything-else -> web/index.html (SPA fallback), or 404.html for a request that
clearly wanted a real file (has an extension)"`. Neither half is true of the code
beneath it: `_route()` (68-109) has no SPA branch and no extension test, every
miss falls through to `self._not_found = True; return '/index.html'`, and
`_serve_notfound()` (111-130) sends `index.html` with a 404 status and never
touches `404.html`. `web/404.html` is staged deleted and absent from the tree.

The docstring is also *incomplete*: it omits the extensionless-`.html` fallback
`_route()` does still perform (lines 93-94 — `/foo` serves `web/foo.html`).

The header contradicts an in-body comment 90 lines below it (`serve.py:95-107`,
which documents the current design explicitly) — the exact drift `CLAUDE.md`'s
"module headers carry the why — read the top of a file before changing it"
convention exists to prevent. The same stale `404.html` reference survives in
`AGENTS.md:12` and `README.md:369`, and `AGENTS.md:16` describes `serve.py` as
"the local threaded server with SPA fallback".

### C-21 — contradictory comment on `.ghost-go`

`web/assets/css/items.css:430` · stale comment · **uncommitted**

The block comment at 430-432 says `.ghost-go` uses "margin-top: auto rather than a
gap, so it sits at the foot of the card … this is the one child that opts out of
that". The inline comment eleven lines later (440-444) says the opposite and
records the revert: "margin-top: auto opted this one out of that - which left the
button stranded at the bottom with a hole above it". The declaration at 445 is
`margin-top: 4px`.

`.ghost-go` is defined only here (plus `:hover` 458, `:focus-visible` 461) and
used only at `canvas/renderers.js:803`, with no media query or other stylesheet
re-setting `margin-top`, so the shipped behaviour matches the *inner* comment and
the header is stale. Not explained by `align-self: flex-start` at 439 — that is
the cross axis, whereas the stale comment is about main-axis placement under
`.ghost-card`'s `justify-content: center`. `git` shows `.ghost-go` does not exist
in HEAD: this is an uncommitted, half-finished edit.

Comment-only, no runtime effect. The harm is a contributor reading the header,
restoring `margin-top: auto` and reintroducing the stranded-button layout.

---

## What was checked and found sound

Nine findings were refuted. Each was a plausible reading of the code that turns
out to be wrong for a reason worth recording, so the next pass does not spend the
same hours on them.

**R-01 — `suspendCache()` on a not-found boot is not a one-way latch.**
The claim was that nothing opened in that tab is ever persisted.
`resetSessionLatches()` is called from *two* places, not one: `newBoard()`
(`storage.js:417`) and `main.js:398`, at the end of `leaveNotFound()`, bound as
the `'items'` listener for exactly this boot. `loadBoard()` emits `'items'`, so
open/drop/paste/every toolbar tool triggers the handover and autosave resumes.
`main.js:351-378` documents it, including "`resetSessionLatches()` is last. It is
the one that undoes the `suspendCache()` at boot". The only residue is the wording
imprecision recorded as C-15.

**R-02 — `_redirects` is not an unclosed portability gap.**
The claim was that no replacement was left for a host needing a literal
`404.html`. `research/old/open-source-readiness-2026-08-02.md:509-510` records
that the app is hosted on Cloudflare, which is exactly the host that reads
`_redirects`; the same document rules out GitHub Pages structurally (private
repository). No `CNAME`/`netlify.toml`/`wrangler.toml` ever existed in history.
The comment at `_redirects:12-14` is a portability note about a rejected host,
not an admission. And the change is coordinated across five files —
`serve.py:95-118`, `_redirects:16`, `sw.js:78-82` ("No 404 page in here, because
there is no 404 page"), `main.js:333-349`, `state.js:619-631` — which is the
signature of design, not oversight. The replacement is also better on the real
host: the deleted `404.html` was a static dead end, while the new path keeps a
genuine 404 status instead of a soft 404 that gets dead addresses indexed.

**R-03 — `commitGeom()`'s index pairing is not harmful.**
The pairing is real and already noted in
`research/old/2026-07-30-ghost-cards.md:341-345`, but the harmful branch is
guarded by **id, not index**: `layout.js:769` reads
`if (!driven.includes(before[i].id) || !isFence(byId(before[i].id))) continue;`,
and every id that can be in `driven` on a mid-gesture delete is an id that was
just removed, so `byId()` is undefined, `isFence` is optional-chained, and it
continues. `applyGeom` writes by id and skips missing ones, so the committed
entry is correct even when the pairing is skewed. The ghost variant is dead
(ghosts are furniture, never fenced, never riders).

**R-04 — `notFoundBoard` does have a door.**
The claim was that it is never reset. `state.js:716-718` is
`export function leaveNotFoundBoard() { notFoundBoard = false; }`, imported at
`main.js:23` and called synchronously at `main.js:382`, before the first await of
`leaveNotFound()`. The empty-board branch is covered too, via
`resetGhostLatch(false)` → `ensureGhostCards()` rewriting the flag. And a
hypothetically stale `true` would be unobservable: the sole reader sits behind
`if (!hasGhosts() || !hasContent()) return;`.

**R-05 — the Opus encode loop cannot hang on `dequeue`.**
The claim rested on WebCodecs resetting the queue *instead of* firing `dequeue`.
The spec requires the opposite: a fatal encoder error runs Close → Reset →
"If `[[encodeQueueSize]]` is greater than zero … Run the Schedule Dequeue Event
algorithm". The wait at `opus.js:167` is only entered when `encodeQueueSize > 24`,
which is the precondition of that step, so the event is guaranteed. Both wake
orderings terminate: either `flush()` rejects immediately on a closed encoder, or
`encode()` throws `InvalidStateError` synchronously. Both return `null`, which
`optimize.js:210` treats as an ordinary skip — the module's documented contract.

**R-06 — `report.emptied` is not an overcount.**
The toast reads "N empty files removed", not "N cards removed", and for a
cover-only entry an empty file reference genuinely is removed: `hollowCover` puts
`cover: null` into the swap and `swapAssets()` implements null as "take the
reference away", pinned by `tests/optimize-empty.test.js:133-153`. The only real
imprecision is the opposite of the claim and an *undercount* — an item with both
an empty asset and an empty cover yields one entry while two references go — and
that bucketing is deliberate and documented at `optimize.js:57-61`.

**R-07 — `serve.py`'s no-cache header is sent on every response.**
The claim assumed keep-alive. `serve.py` never overrides `protocol_version`, so
it stays `HTTP/1.0`; `http.server` enables keep-alive only at `>= HTTP/1.1`, so
`close_connection` is true after every request and `socketserver` builds a fresh
handler (fresh `_cc_set`) each time. Verified over a raw socket: three separate
connections each received the header, and a second request on the same socket got
0 bytes. Latent fragility only, if someone later sets `protocol_version`.

**R-08 — `main.js` importing `resetSessionLatches` is fine.**
The claim quoted the HEAD form of `storage.js`'s export block. The working tree
adds a sixth name plus a five-line comment explaining that
`suspendCache`/`resetSessionLatches` go "out to `main.js` as well as used in
here" — landed together with the `main.js` change that imports it. `node --check`
passes on both.

**R-09 — `og.png` belongs outside `SHELL`.**
`docs/architecture.md:904-912` states the ship-it/cache-it rule and scopes it in
the same bullet to `assets/js`, `assets/css` and `assets/fonts` — the scoping that
makes `web/lab.html` possible. `og.png` is scraper-facing metadata (all four
references are absolute production URLs), no manifest entry, no JS or CSS
requests it, and scrapers do not run service workers. Adding it would grow a
3,610,252-byte all-or-nothing install by 548,479 bytes for a file no client
requests. `robots.txt`, `sitemap.xml`, `_redirects`, `lab.html` and the three OFL
licences all ship and none are in `SHELL`.

## Method

Seven auditors, scoped by subsystem: the uncommitted diff; the state core and the
pure layer beneath it; canvas and gestures; the hand-written binary readers and
persistence; import and media-optimize; UI and the command surface; and a
cross-cutting pass (test/syntax/case/import-graph/icon/SHELL consistency). Each
was told to read the real files, to name a file and a line it had read, and to
report only defects that would change behaviour, corrupt data, break on a real
input or violate a stated invariant — not style, not naming, not missing tests as
such.

Each finding then went to a separate agent with the opposite instruction:
refute it. Open the file, read the callers and any upstream guard, ask whether the
bad input is reachable, whether something else already prevents it, whether the
browser handles it, and whether a module header, `CLAUDE.md`, `docs/` or
`research/` records it as a deliberate choice — and default to refuted when the
failure could not be demonstrated.

That second pass earned its keep. It killed nine findings outright, corrected the
severity of six, corrected drifted line numbers in four (`main.js` moved between
two reads within the session), and materially rewrote the failure scenario of
three — C-06 (the release path self-heals), C-10 (one-shot, not persistent) and
C-12 (the duplicate card was an artifact of the reporter's own script). Several
verifiers reproduced their finding under node or Playwright rather than arguing
from the source, and those reproductions are quoted above.

Roughly 3.2M tokens and 1,000 tool calls across 41 agents.
