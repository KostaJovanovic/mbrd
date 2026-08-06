# Fix plan — code audit 2026-08-06

> **Status: carried out.** All twenty-one findings in
> [`code-audit-2026-08-06.md`](code-audit-2026-08-06.md) are fixed, and both files
> moved here on the commit that finished it, per
> [`research/README.md`](../README.md). What follows is the plan as written, kept
> for the reasoning and the rejected alternatives; the outcome is in the code.
>
> **Three departures from it, and why.** Read these before taking any line below
> as a description of the app:
>
> 1. **1f took different numbers.** The plan moved `gone` to x -224, which puts
>    the two cards 128 apart and abandons the 64-unit channel the header
>    documents. x **-160** satisfies the lattice equally, keeps the channel, and
>    leaves the pair spanning -384..384 - centred under the title card at x 0.
>    `back` took y -96 as planned. The plan's parenthetical that the channel "is
>    currently stated as 64 and is actually 96" was simply wrong: it was 64.
> 2. **3b put `POSTER_TIME` in `canvas/video.js`, not `canvas/renderers.js`.**
>    renderers.js imports video.js, so exporting it from renderers and importing
>    it back into video.js is a cycle, and `tests/imports.test.js` says so. video.js
>    is the better home anyway - the constant is about how a video is parked.
> 3. **2b has no unit test.** The plan asked for one in `tests/input.test.js`, and
>    that file tests only the pure exported helpers: the gesture pipeline needs a
>    `document`, the suite has no DOM stub, and adding one to install jsdom would
>    cost `npm test`'s no-install property. The three guards are one-line changes
>    matching four sites already in the same file. Left uncovered and said out loud
>    rather than covered by something that does not exercise it.
>
> Two things were also done that the plan did not ask for, both one line and both
> in the same breath as a fix it did: `import/drop.js`'s change handler now tests
> `mode === 'content' || mode === 'cover'` rather than the absence of a mode (the
> other end of 4b's belt and braces), and `resetWheelKind()` kept its
> test-only-ness in a comment rather than in this document, per 5a.

Three decisions taken up front, because each shapes more than one finding.

- **The not-found board needs a gate, not more one-off checks.** C-01, C-15 and
  (indirectly) C-14 are the same missing thing: `isNotFoundBoard()` exists but
  nothing outside `canvas/ghosts.js` consults it, so the storage layer cannot tell
  a board it is deliberately not writing from a browser that will not write.
  Commit 1 gives that state one representation the destructive paths honour, and
  the rest of the not-found findings fall out of the same commit. This is the
  commit that must land **before** the 404 work is committed — C-01 destroys user
  data and it ships the moment that branch does.
- **`byId()`'s index is invalidated on announcement, and that is the bug.**
  C-02 is not "add a null check in `sticky.js`". The index has to be dropped when
  `board.items` is *replaced*, not when the replacement is announced, or the same
  class of failure returns the next time something reads the board between those
  two points. The proximate `sticky.js:255` lookup is fixed as well, because it is
  redundant regardless, but the index fix is the one that matters.
- **No `.mbrd` schema change, no generated-catalog change, no service-worker
  change.** C-09 changes how a `.mbrd` is *read* and touches nothing about what is
  written; `docs/mbrd-format.md` already specifies the behaviour being restored.
  If that stops being true during implementation it gets called out in the commit
  message, per `CLAUDE.md`.

Order is by risk, not by file. Commits 1 and 2 hold everything that loses data or
throws; 3 to 5 can land in any order after them.

---

## Commit 1 — the not-found board

**C-01, C-12, C-13, C-14, C-15, C-17, C-20, C-21.** All uncommitted work; this
commit is a prerequisite for committing it.

### 1a. Gate the destructive paths (C-01) — the one that matters

`isNotFoundBoard()` is already exported from `state.js:707` and `storage/` is
allowed to import `state.js`. Two edits:

```js
// storage/storage.js, at the head of newBoard() — before confirmDiscard()
export async function newBoard() {
  // A not-found board is not the visitor's board: it was never loaded from the
  // session slot, so clearing that slot below would delete a board they cannot
  // see and have not been asked about, and resetSessionLatches() would then let
  // the blank replacement autosave over it. Hand over first; leaveNotFound()
  // restores their board and re-arms the writer in the right order.
  if (isNotFoundBoard()) { toast('Nothing to start over here'); return false; }
  ...
```

and the same guard in `clearAllData()` (`session.js:463`), which reaches the
identical wipe from **System → Clear everything** — it asks first, but the thing
it asks about is not the board on screen.

Rejected alternative: routing `newBoard()` through `leaveNotFound()` first. It
looks tidier and is worse — it restores a board only to immediately discard it,
and it would fire the "Moved to your board" toast on the way past.

**Test.** `tests/` has no `notFound` reference at all. Add
`tests/state-notfound.test.js` covering: a not-found board reports
`isNotFoundBoard()` true; `newBoard()` on one returns false and does not reach
`clearSession()`; and `leaveNotFoundBoard()` clears the flag so the *next* New
behaves normally.

### 1b. Close the composer before the handover (C-12)

One line, at the head of `leaveNotFound()` (`main.js:380`), before the `await`:

```js
  bus.off('items', onFirstContent);
  leaveNotFoundBoard();
  // Nothing may replace the board while an editor holds a card outside #world.
  // resetItems() would call el.remove() on a node living in #compose-mount, the
  // blur re-parents it inside Chrome's own removal step, and the throw takes the
  // rest of the 'board:load' handler with it. flushNoteEdit() is the synchronous
  // close pagehide already uses.
  flushNoteEdit();
```

`flushNoteEdit` is exported from `canvas/notes.js:815` and `main.js` already
imports it for the `pagehide` path.

The belt-and-braces variant — skipping nodes whose `closest('#compose-mount')` is
non-null inside `resetItems()` — is **not** taken. It hides the ordering error
rather than fixing it, and `canvas/items.js` should not know the composer exists.

### 1c. Re-read the visitor's items after the await (C-13)

`main.js:387` snapshots before a chunked IndexedDB read that can take hundreds of
milliseconds. Capture ids up front and collect after:

```js
  // Taken after the await, not before it. restoreSession() yields for a chunked
  // asset read, and anything dropped or typed inside that window would otherwise
  // be dropped on the floor by loadBoard()'s wholesale reassignment of
  // board.items, with clearHistory() removing even the undo entry. main.js:544
  // fixes the same race for launchQueue by awaiting `started`.
  const held = board.items;
  const had = await restoreSession();
  const mine = held.filter(isContent);
```

`held` keeps a reference to the pre-load array, which `loadBoard()` replaces
rather than mutates (`state.js:1851`), so items added during the wait are still in
it. Verify that assumption holds at implementation time — if `loadBoard()` is ever
changed to mutate in place, this silently reverts to the current behaviour, so the
test below is the guard, not the comment.

**Test.** Playwright, or a node test driving `leaveNotFound()`'s shape directly:
add two items across the await, assert both survive.

### 1d. Put the title back when there was no session (C-14)

`leaveNotFound()`, in the `else` of `if (had)`, before `resetSessionLatches()`:

```js
  } else {
    // No stored board to merge into, so nothing overwrote the name the way
    // loadBoard() does on the other branch. Left alone it persists: the writer
    // is about to come back on, 'Not found' fails isDefaultTitle(), and the
    // board is called that on the title card, in the masthead and in the name
    // Export would give the file.
    setTitle(defaultBoardTitle());
  }
```

**Test.** Extends the `tests/state-notfound.test.js` from 1a.

### 1e. Say something true when Save is pressed (C-15)

`session.js` needs to distinguish a deliberate suspension from a storage failure.
Add a module-level `suspended` flag set by `suspendCache()` and cleared by
`resetSessionLatches()`, and branch in `writeSnapshot()` (`session.js:241-245`):

```js
  if (!cacheOk) {
    lastFailure = suspended
      ? 'This board has no address of its own yet - put something on it, or export it'
      : 'This browser will not store the board (full, or blocked) - export it to a file';
    return false;
  }
```

`saveBoard()` (`storage.js:112-123`) and `restartApp()`
(`ui/board-actions.js:360-374`) both surface `lastSaveFailure()` verbatim, so they
need no change. Check the `restartApp()` dialog copy reads correctly with the new
string — it wraps it in "Restart anyway?", which still works.

The other two `suspendCache()` callers are momentary and end with `cacheOk` back
on, so the flag is only ever live on the not-found path.

### 1f. Move the not-found cards onto the lattice (C-17)

`state.js:627`. `gone` takes x **-224** (low edge -448, seven steps of 64) and
`back` takes y **-96** (low edge -192, three steps). Correct the spans in the
header comment and the channel figure, which is currently stated as 64 and is
actually 96.

Then add the assertion that would have caught it, beside the `HINT_GHOSTS` case
if one exists and as a new one if not: every seeded card is invariant under
`latticeBox(g, 64)`.

### 1g. Documentation (C-20, C-21)

- `serve.py:9-13` — rewrite to the three cases the code actually implements: `/`
  and any real file served literally; `/name` falls through to `/name.html` when
  that file exists; everything else is `index.html` under a 404 status. Point at
  `_serve_notfound()` and `web/_redirects`.
- `AGENTS.md:12` and `README.md:369` — drop `404.html` from the file listings.
- `AGENTS.md:16` — `serve.py` is no longer "the local threaded server with SPA
  fallback".
- `web/assets/css/items.css:430-432` — delete the three stale lines. The inline
  comment at 440-444 already says what the rule does and why it is not
  `margin-top: auto`.

---

## Commit 2 — load and gesture safety

**C-02, C-06, C-07.** Three ways the app throws or wedges on input it should
survive. No shared code, but they belong together as "stop trusting that the item
is still there".

### 2a. Invalidate `byId()`'s index where the list is replaced (C-02)

`board-model.js` owns the index (`:431`). Export an explicit invalidator beside
`byId`:

```js
/**
 * Drop the id index without announcing anything.
 *
 * The index is normally rebuilt lazily after an 'items' emit, which is right for
 * every ordinary mutation. loadBoard() is the exception: it replaces board.items
 * outright and then runs a full layout pass before it emits, and every byId() in
 * that pass would otherwise be answered from the previous board.
 */
export function dropIdIndex() { ... }
```

Call it in `loadBoard()` immediately after `state.js:1851`, in the same breath as
the assignment rather than anywhere later — the point of the fix is that nothing
sits between the two.

Then remove the redundant lookup at `sticky.js:255`:

```js
-  build(note, byId(host.id), hostDst);
+  build(note, host, hostDst);   // already the live item stuckTo() returned
```

Not a belt-and-braces null check: `host` is a live item object by construction, so
re-looking it up by id was never buying anything and re-introducing the round trip
is what let a stale index in.

**Test.** `tests/state-board.test.js`: `loadBoard(A)` → `setBoardMode('mobile')` →
`byId(...)` to populate the index → `loadBoard(B)` where B holds a note with
`meta.stuckTo`, and assert it completes and `byId` answers about B. Also add the
silent variant — same ids in both boards, assert the note is placed from B's
geometry and not A's.

### 2b. Let a gesture tolerate its items disappearing (C-06)

Three sites in `canvas/input.js`. The file already does this correctly in four
other places (`stackOrder`'s `byId(a)?.z`, `input.js:1234`'s `leadItem?.type`,
`applyGeom`'s `if (!it) continue`, `snapshotGeom`'s filter) — this is bringing
three stragglers into line, not inventing a policy.

```js
// :1245, move branch — filter rather than map
applyGeom(g.origin.flatMap(o => {
  const it = byId(o.id);
  return it ? [{ id: o.id, x: o.x + dx + sx, y: o.y + dy + sy,
                 w: it.w, h: it.h, rot: it.rot, z: it.z }] : [];
}));

// :758, raiseToFront
for (const sid of stackOrder(ids)) { const it = byId(sid); if (it) it.z = ++z; }

// :1323, resize branch — head of the branch
const it = byId(g.id);
if (!it) { abortGesture(); return; }
```

Do **not** also add a "skip the commit when nothing in `g.before` resolves" branch
to `finishGesture()`. `commitGeom` already recomputes `after` from surviving ids
and returns without committing when the set is empty; the partial case (towed
followers surviving a delete that removed only the selection) produces at worst a
no-op undo entry, and `applyGeom` writes by id so no geometry is corrupted. Adding
a second guard for a cosmetic residue is how `finishGesture()` grows a branch
nobody can explain later.

**Test.** `tests/input.test.js`: start a move, remove the item from the board, feed
another `pointermove`, assert no throw and that the release commits nothing.

### 2c. Bound `dedupeIds()` (C-07)

`board-model.js:489`. The suffix must survive the truncation:

```js
    // Room reserved for the suffix, because the cap is what made this loop
    // non-terminating: a 64-character id truncated back to 64 characters is the
    // same id, so `seen` rejected every candidate forever. Ids are capped at 64
    // by makeItem() and docs/mbrd-format.md declares 64 legal, so a file can
    // reach this with two of them.
    const stem = it.id.slice(0, 58);
    let k = 2, next;
    do { next = stem + '~' + k++; } while (seen.has(next) && k < 1e6);
    if (seen.has(next)) next = uid();
```

`58 + 1 + 5` keeps every candidate inside 64 for `k` up to 99999, and the `uid()`
fallback means even an adversarial file cannot spin. Determinism — the property
the function header promises — is preserved for every realistic input.

**Test.** Belongs with the malformed-input tests the binary readers already carry:
two items with 64 identical characters, and a live/trash pair sharing one. Assert
`normalizeBoard()` returns, with distinct ids.

---

## Commit 3 — memos and memory ceilings

**C-03, C-05, C-08.** Three places where something that should be forgotten is
kept, or kept is forgotten.

### 3a. A z change is not a placement (C-03)

`layout.js:739`. `SNAP_KEYS` is already exported at `layout.js:46` and is exactly
`['x','y','w','h']` — the set the memo remembers:

```js
-      if (GEOM_KEYS.some(k => after[i][k] !== before[i][k])) forgetPresnap(byId(after[i].id));
+      // SNAP_KEYS, not GEOM_KEYS: the memo records where a card sat before the
+      // lattice moved it, so only a spatial change can invalidate it. Bring to
+      // front rewrites z and nothing else, and the comment below already lists
+      // it among the callers that "change no note's position relative to
+      // anything".
+      if (SNAP_KEYS.some(k => after[i][k] !== before[i][k])) forgetPresnap(byId(after[i].id));
```

Fixed at `commitGeom` rather than by passing `preservePresnap: true` from
`raiseSelection`/`lowerSelection`: the predicate is wrong for every caller, not
just those two, and the option already exists for callers that move things
spatially and still want the memo (`layout.js:314`, `ui/board-actions.js:684`).
Leaving `rot` out is deliberate and worth a word in the commit message — a
rotation does not change the snapped box, and `unsnapAll()` restores only
`SNAP_KEYS`.

**Test.** `tests/layout.test.js`: snap on, raise a card, assert `meta.presnap`
survives and that turning snap off returns it to its original box.

### 3b. Stop treating the poster seek as playback (C-05)

`canvas/renderers.js` and `canvas/items.js`. Hold the constant once and test
against it rather than against zero:

```js
// canvas/renderers.js, near the video branch
export const POSTER_TIME = 0.1;   // the #t= fragment that buys a free poster frame

// canvas/items.js:310-313, disposable()
-  if (m.currentTime > 0) return false;
+  // > POSTER_TIME, not > 0: every desktop video is parked at the poster
+  // fragment, which is not "media that is doing something" and must not exempt
+  // a card from the cull. Without this the nodes map grows one detached <video>
+  // per video card panned over, for the life of the tab.
+  if (m.currentTime > POSTER_TIME) return false;
```

and the same comparison in `canvas/video.js:101-102`'s `parked`, which restores
the "a parked clip shows how long it is" readout on desktop.

Option (b) — dropping the fragment and setting `currentTime` from a
`loadedmetadata` listener — was considered and rejected: it trades a constant for
an event round trip, and the poster frame would flash empty on slow decodes.

Note that the touch path's readout is `0:00` for an unrelated reason (no `src`, so
`duration` is `NaN`). Out of scope here; worth its own line in the commit message
so the next reader does not think this commit fixed it.

**Test.** `tests/` covers `disposable()` directly; add the poster-time case. The
retention itself wants an e2e assertion on `mbrd.viewStats().cached` after a pan
across video cards, in `tests/e2e/board.spec.js`.

### 3c. Include the bin in the originals sweep (C-08)

`session.js:146`:

```js
-  for (const it of data.items || []) {
+  // The bin as well as the board. A binned optimised item still carries
+  // meta.was, discardOriginals() never clears it, and restoreItems() brings it
+  // back live - so sweeping its original bytes strands the item permanently:
+  // writeSnapshot() then reports it missing on every save and the board never
+  // goes clean again.
+  for (const it of [...(data.items || []), ...(data.trash || []).map(t => t?.item)]) {
     if (it?.meta?.was) out.add(it.meta.was);
     if (it?.meta?.wasCover) out.add(it.meta.wasCover);
   }
```

Preferred over dropping `was`/`wasCover` when an item is binned: undo across a
delete closes over the old ids, so stripping them would break the undo the memo
exists for. This is the conservative half of the same choice.

While here, fix the message this produced: `describeMissing()`
(`session.js:321-334`) matches only `item.asset.hash`, so an unmatched hash yields
**"0 items () have no stored data"**. Make it fall back to a count-only sentence
when nothing resolves to a name — an unactionable message that names nothing is
worse than a vaguer one that is true.

**Test.** `tests/session*.test.js`: optimise, bin the item, run
`referencedHashes()`, assert the original hash is still referenced. And a
`describeMissing()` case for a hash matching no item.

---

## Commit 4 — format and import

**C-09, C-10, C-11, C-18.**

### 4a. A hand-edited note wins over `meta.rich` too (C-09)

`storage/mbrd.js:442`, in the notes loop. The sidecar is authoritative — that is
what `docs/mbrd-format.md:423` promises — so when the two halves disagree,
re-derive the blocks from the sidecar and keep the note-level style:

```js
  // The .md outranks board.json, and meta.rich is part of board.json. Left
  // alone it wins on screen while meta.text takes the edit, so the card shows
  // the old words, Find matches the new ones, and the next keystroke in the
  // editor flattens the stale rich back over text and destroys the hand edit.
  // Style (face, size, alignment) stays: the sidecar carries words, not looks.
  const text = parseNote(...);
  item.meta = { ...item.meta, text };
  if (item.meta.rich && flattenNoteRich(item.meta.rich) !== text) {
    item.meta.rich = { ...item.meta.rich, blocks: parseNoteText(text) };
  }
```

Check the exact names of the two helpers against `canvas/note-model.js` when
implementing — `mbrd.js` currently imports neither, and adding an import from
`canvas/` into `storage/` needs a look at `tests/layers.test.js` first. If that
edge is not allowed, the block-splitting helper moves down to `note-model.js`'s
pure half, which is where it belongs anyway.

Dropping `rich` outright also honours the promise and is a one-liner, but it
throws away the note's font, size and alignment on every hand edit. Not worth it.

Same commit, same writer: `noteMarkdown()` (`mbrd.js:226-231`) prefixes `'# '`
unconditionally, so a rich note whose first line already carries a marker exports
as `# # buy the smaller one`. Cosmetic — `parseNote()`'s `^#+\s*` eats it on the
way back — but it is the same "never updated for `meta.rich`" oversight.

**Test.** `tests/mbrd.test.js:174-191` is the test that should have caught this and
does not, because every note it builds has `meta.text` and no `meta.rich`. Add the
rich case beside it: pack, rewrite the `.md`, unpack, assert
`normalizeNoteRich(meta.rich, meta.text).blocks` reflects the edit. **This is the
most valuable test in the plan** — the promise is the format's selling point and
nothing currently guards it.

### 4b. Clear the picker mode when the picker opens (C-10)

`import/drop.js`. The header at `:174-178` already establishes that a cancelled
picker never fires `change` and rewrites `accept`/`multiple` at open time for
exactly that reason; `mode` was missed. Reset it in the same place, and clear
`coverFor` with it:

```js
  // Rewritten at open time with accept/multiple and for the same reason: a
  // cancelled picker never fires change, so anything left set here is still set
  // when the next caller opens the same input - and storage.js's Open shares it.
  input.dataset.mode = ...; coverFor = ...;
```

Also correct the now-false comment at `drop.js:188-196` ("Cleared as soon as it is
read, so a cancelled picker cannot leave a card armed") — `coverFor` was only ever
cleared on read.

Belt and braces, cheap: have `storage.js`'s `pickViaInput()` set
`input.dataset.mode = 'mbrd'`, so `drop.js`'s handler returns on a mode it does
not own rather than on the absence of one. Two independent fixes for a
cross-module shared mutable, which is the kind of coupling that earns both.

**Test.** Node-testable via the `dataset` shape; the browser half wants an e2e
case if one is cheap to write.

### 4c. Put a clock on the worker boot (C-11)

`optimize/media.js`. Two ceilings:

```js
  // :107 — the probe
  await fetch(CORE_URL, { method: 'HEAD', signal: AbortSignal.timeout(PROBE_MS) });

  // :157 — the handshake
  // spawn() settles on 'ready', a constructor throw, or error/messageerror. A
  // core download that stalls without throwing fires none of them, and the
  // synchronous importScripts in the worker blocks its own message loop, so it
  // cannot report the failure either. Left unbounded this wedges the import pool
  // for the rest of the session: `ready` stays pending, so `if (!ready)` never
  // retries and every later call awaits the same dead promise.
  await Promise.race([ready, bootTimeout()]);
```

The timeout must call `killWorker()` and **null `ready`**, so the next attempt
respawns rather than inheriting the corpse. Reuse the shape of `JOB_TIMEOUT_MS`,
which already does the equivalent inside `ask()`.

**Test.** `tests/media.test.js` covers crash, reject and constructor-throw. Add
the stall: a worker stub that never posts `ready`, asserting `firstFrame()`
settles and that a second call re-spawns.

### 4d. Report the drop cap (C-18)

`import/drop.js`. `walkEntry()` saturates at exactly `MAX_FILES`, so
`files.length > MAX_FILES` at `:262` can never be true. Have `filesFrom()` report
what it did rather than having the caller infer it:

```js
  return { files: out, fromFolder, truncated: hitCap };
```

and seed `trimmed` from `truncated` in `importFiles()`. Changing `:262` to `>=`
would also work and is one character, but it is wrong for the picker path, where
500 files really is 500 files and no cap was applied.

**Test.** `tests/` has no `trimmed`/`MAX_FILES` assertion at all. Add one: walk
past the cap, assert the suffix appears.

---

## Commit 5 — input feel, the ghost latch, and the e2e baseline

**C-04, C-16, C-19.**

### 5a. Reset the whole burst on a fresh burst (C-04)

`canvas/input.js:392`:

```js
-  if (fresh) axisX = axisY = 0;
+  // Both pairs, not just the magnitudes. seenX/seenY are the presence measures
+  // the unrail gain reads, and a burst the platform railed drives the gated one
+  // to ~0 - so the next free swipe on the same pad is amplified by up to
+  // UNRAIL_CAP per event until it eases back. Fresh means fresh.
+  if (fresh) { axisX = axisY = 0; seenX = seenY = 1; }
```

`docs/architecture.md:615-617` already states the invariant this restores ("Both
measures start at 'delivered whole'"), so it needs no doc change.

`resetWheelKind()` at `:294` is called by nothing under `web/` — only by
`tests/input.test.js`. Either delete it and have the test drive the real path, or
leave it and say in the commit message that it is test-only. Do not quietly leave
a reader to discover it a third time.

**Test.** `tests/input.test.js:327` currently passes on a tie (`deltaX 20`,
`deltaY 20` → `axisX === axisY` → the gate is 0). Change it to a lopsided second
swipe, e.g. `{deltaX: 20, deltaY: 21}`, which fails before the fix (`dx 53.9`) and
passes after.

### 5b. Use `isContent` for the ghost latch (C-16)

`state.js:1855`, one line, and `isContent` is already imported at `state.js:58`:

```js
-  resetGhostLatch(board.items.some(i => i.type !== 'title'));
+  resetGhostLatch(board.items.some(isContent));
```

Drift from the fences commit (20e0331), which converted `hasContent()` and missed
this one call. The comment above the line already frames the rule as *content*, so
it needs no rewording.

**Test.** `tests/fences.test.js` is the right home, beside the `hasContent()` case
at `:320`: a fences-only board round-tripped through save and load still shows its
hints.

### 5c. Repair the two stale e2e assertions (C-19)

Both are test-side; the app behaviour they contradict is the deliberate,
documented one.

- `tests/e2e/board.spec.js:366` — point at the `#pick` dialog
  (`#pick-hex` / `#pick-go`, and `#pick-cancel` for the cancel half) rather than
  `#ask-field`. `cmds.addSwatch` moved to `pickColor()` and `ui/color-picker.js`'s
  header says so.
- `tests/e2e/board.spec.js:693` — a band drawn inside a region catches only the
  card, so `sharedFence()` returns early and no prompt opens. Change the final
  assertion to `await expect(prompt).toHaveCount(0)` with a comment naming
  `sharedFence()`, which is the behaviour worth pinning.

Worth a moment at implementation time on whether the two flows that lost coverage
(swatch creation via the toolbar, the in-region band stand-down) want a positive
case as well as the corrected negative one.

---

## Not in this plan, and why

- **`report.emptied`'s undercount** (R-06). An item with both an empty asset and
  an empty cover yields one `plan.empty` entry while two references go. The
  per-item bucketing is deliberate and documented at `optimize.js:57-61`; the
  toast is not wrong, just coarse.
- **`serve.py`'s keep-alive fragility** (R-07). `_cc_set` would misbehave if
  someone set `protocol_version = "HTTP/1.1"`. It is not set and nothing plans to
  set it. Worth a one-line comment at most, not a change.
- **The touch path's `0:00` transport readout** (noted under C-05). Real, but a
  different cause (no `src`, so `duration` is `NaN`) and a different fix. It wants
  its own look at whether the touch path should carry duration metadata at all.

## Definition of done

`npm test` green with the new cases above, `npm run lint` and
`npm run typecheck` clean, `npm run test:e2e` green **including** the two
assertions C-19 repairs — that suite is currently red at HEAD and the point of
5c is that it stops being. `node --check` on every touched `.js` and
`python -m py_compile serve.py`, since CI runs both over every tracked file and a
syntax error in a module no test imports still fails.

The C-01 guard should be verified by hand as well as by test, in the browser, on a
404 address, with a real board in the session slot — it is the one finding here
where being wrong costs a user their work.
