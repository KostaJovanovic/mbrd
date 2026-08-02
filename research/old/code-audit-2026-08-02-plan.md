# Fix plan — code audit 2026-08-02

> **Status: carried out.** All five groups below are in the tree. `npm test` went
> from 728 to 741 passing, `npm run typecheck` is clean and `npx oxlint` reports
> warnings only. Where the plan and the implementation diverged, the plan text
> has been left as written and the difference is recorded in
> **What actually happened** at the foot of this file.

A plan for the eight findings in [`code-audit-2026-08-02.md`](code-audit-2026-08-02.md),
in the order the audit suggests, grouped into four commits. Every line number
below was re-checked against the working tree on 2026-08-02.

Two decisions taken up front, because they shape more than one finding:

- **A shared furniture predicate.** A-02 and A-07 are the same policy question
  asked in two places ("is this item something the user put here?"), and the
  answer is currently spelled out at eight sites. One exported `isFurniture()`
  in `board-model.js`, adopted where *both* types are meant to be excluded and
  nowhere else. Sites that exclude only one type on purpose (the packer,
  `itemsIn()`, `serializeBoard()`) keep their own test — they are not the same
  question and merging them would be the next bug.
- **No schema change, no service-worker change.** None of these findings touch
  `.mbrd` on disk, `import/formats.js` or `SHELL` in `web/sw.js`. If that stops
  being true during implementation it gets called out in the commit message.

---

## Commit 1 — A-01: snapping is one command, flag and geometry together

`web/assets/js/state.js:640-711, 1392-1407`

**The shape.** `setSetting('snap', v)` writes `board.settings.snap` itself and
then calls `snapAll()`/`unsnapAll()`, which push a `commit()` covering geometry
alone. Undo therefore takes the board off the lattice and leaves the flag on.
The fix folds the flag into the command that already exists rather than adding a
second one — one user action stays one entry in history.

**Changes.**

1. Add a private `writeSnapSetting(v)` beside `writeSnapState()`:

   ```js
   function writeSnapSetting(v) {
     board.settings.snap = v;
     board.layoutSettings[board.layoutMode] = layoutSettingsOf(board.settings);
     markDirty();
     bus.emit('settings', 'snap');
   }
   ```

   The `layoutSettings` mirror matters as much as the flag: without it an undo
   restores `settings.snap` and leaves `layoutSettings.desktop.snap` stale, and
   the next layout switch puts the lie back.

2. Give `applySnapState(before, after, label, snapTo)` a fourth argument, and
   have both directions of the command carry it:

   ```js
   function applySnapState(before, after, label, snapTo) {
     const moved = /* unchanged */;
     if (!moved) { if (snapTo !== undefined) writeSnapSetting(snapTo); return; }
     const apply = (list, flag) => {
       if (flag !== undefined) writeSnapSetting(flag);
       writeSnapState(list);
     };
     apply(after, snapTo);
     commit(label,
       () => apply(after, snapTo),
       () => apply(before, snapTo === undefined ? undefined : !snapTo));
   }
   ```

   `snapTo === undefined` is the `recheckBoardGeometry()` path — a reload
   re-asserting a flag that is already on, not a toggle — and must go on
   behaving exactly as it does now.

   The `!moved` branch is the empty board, or a board already flush on the
   lattice: nothing to undo geometrically, so the flag is written the way every
   other setting is written, outside history. That is a deliberate asymmetry and
   gets a comment saying so.

3. `snapAll(snapTo)` / `unsnapAll(snapTo)` pass the argument through.
   `recheckBoardGeometry()` calls `snapAll()` bare.

4. In `setSetting()`, replace `if (key === 'snap') value ? snapAll() : unsnapAll();`
   with an early return that hands the whole key over, above the
   `board.settings[key] === value` guard's tail:

   ```js
   if (key === 'snap') {
     if (board.settings.snap === value) return;
     value ? snapAll(value) : unsnapAll(value);
     return;
   }
   ```

   The write, the `markDirty()`, the `layoutSettings` mirror and the emit all
   now come from `writeSnapSetting()`, on both the moved and the unmoved path,
   so `setSetting`'s own tail must not run for this key.

**Watch for.** `snapAll()` no longer runs with the flag already written — check
that nothing it reaches reads `board.settings.snap`: `baseStep()`, `latticeBox()`,
`fitBoardMode()`. If one does, `writeSnapSetting()` moves ahead of the geometry
pass inside `apply()` (it already is, in the sketch above — keep it that way).

**Also covered.** `axisMoved()` in `ui/appearance.js:399` flips `snap` through
the same `setSetting()`, so the whimsy slider inherits the fix with no change of
its own.

**Tests** (`tests/state.test.js`):

- ticking snap, then undo, restores geometry *and* `board.settings.snap === false`;
- redo puts both back;
- the mirror case (snap on, then off, then undo) leaves `snap === true` with
  everything back on the lattice;
- `board.layoutSettings[mode].snap` tracks the flag through undo/redo;
- an empty board can still turn snapping on and off (the `!moved` branch);
- `recheckBoardGeometry()` on a snapped board still pushes at most the geometry
  command and never touches the flag.

---

## Commit 2 — A-02, A-08: the codebase disagreeing with itself

**A-02** — `web/assets/js/ui/hud.js:240`.

Add to `board-model.js`, next to `TITLE_ID`:

```js
/** The two types the app puts on a board itself - not anything of the user's. */
export const isFurniture = it => it.type === 'title' || it.type === 'ghost';
```

Then:

- `state.js:465` — `hasContent()` becomes `board.items.some(i => !isFurniture(i))`;
- `hud.js:240` — `const n = board.items.reduce((t, i) => t + (isFurniture(i) ? 0 : 1), 0);`,
  and the comment above it loses its "Hints" framing for the general one.

`board-model.js` is below both in the layering graph, so neither import is a new
edge. A brand-new Desktop board then reads "nothing yet", which is what the
comment two lines above has always claimed it does.

**A-08** — `web/assets/js/canvas/video.js:211`. Delete the trailing clause; the
sentence keeps its first half, which is true:

```js
// The item goes with it so the exclusive-playback rule can name what is playing.
```

**Tests.** `tests/hud.test.js` (or wherever `paintCount` is covered — a new file
if it is not): a board carrying only its title card reads "nothing yet"; title
card plus one photo reads "1 thing". No test for A-08 — it is a comment.

---

## Commit 3 — A-07: only real items can be stuck to

`web/assets/js/sticky.js:107, 126`

Both loops gain the same guard, using the predicate from commit 2:

```js
for (const it of board.items) {
  if (isFurniture(it)) continue;
  ...
}
```

`sticky.js` already imports `board`/`byId` from `board-model.js`, so this is one
name added to an existing import.

**Consequences worth stating in the commit message.** A `meta.stuckTo` in an
existing `.mbrd` that names the title card or a ghost is seeded into the memo by
`seedSticks()` and is *not* re-measured — `stuckTo()` returns the host as long as
`byId()` finds it. Two options:

- (chosen) filter in `seedSticks()` too: `sticks.set(id, ...)` only when the
  recorded host is absent from the board or passes `!isFurniture()`; otherwise
  seed `null`. Cheap, and it makes the repair retroactive.
- (rejected) leave the seed alone and let old boards keep their stuck-to-title
  notes. It would leave exactly the state the fix exists to prevent, reachable
  from a file.

`layout.js:429` — the Mobile parking of the title card — stays as it is. It was
written for the obstacle problem as well as the stick problem, and the comment
there already explains both; it gains a line noting that the stick half is now
also fixed at the stick end.

**Tests** (`tests/sticky.test.js`): a note overlapping the title card is loose;
a note overlapping a ghost card is loose; `wouldStick()` agrees with both; a
board whose `meta.stuckTo` names the title card seeds loose.

---

## Commit 4 — A-04, A-03: two narrow paths

**A-04** — `web/assets/js/storage/naming.js:20-27`.

The substitution moves off the stored branch and onto the two cases that can
actually be a picker-safe filename:

```js
export function titleForOpenedBoard(storedTitle, fileName) {
  const stored = typeof storedTitle === 'string' && storedTitle ? storedTitle : '';
  if (!stored) return titleFromFileName(fileName);
  // Older exports packed the picker-safe filename back into board.json. The
  // signature of one is that the stored title *is* the file's own base name;
  // any other stored title is a title somebody typed, underscores and all.
  if (stored === stripExt(fileName)) return stored.replace(/_/g, ' ');
  return stored;
}
```

`titleFromFileName()` already decodes, so the fallback branch needs nothing.

**The residual ambiguity, stated rather than hidden.** A board deliberately named
`my_board`, saved by *this* version and reopened from `my_board.mbrd`, is
byte-identical to an old export of "my board" and still gets decoded. There is no
information in the file that tells the two apart. The fix removes every other
case — a stored title reopened from a renamed file, a stored title with spaces in
it, a stored title that differs from the filename in any way — which is the whole
of the reachable damage in practice, since `fileNameFor()` is what suggests the
name at save time and the user is free to change it.

`tests/storage.test.js:19-25` asserts the current policy and changes with it:

```js
test('opening a file repairs the packed filename, not a typed title', () => {
  // Old export: board.json carried the picker-safe name of the file itself.
  assert.equal(titleForOpenedBoard('Summer_references', 'Summer_references.mbrd'),
    'Summer references');
  // A title that is not the file's own name is a title, and keeps its underscores.
  assert.equal(titleForOpenedBoard('my_board', 'Different_name.mbrd'), 'my_board');
  assert.equal(titleForOpenedBoard('', 'Fallback_name.mbrd'), 'Fallback name');
});
```

**A-03** — `web/assets/js/optimize/media.js:142-146, 193-197`.

The `ready = null` inside the promise executor cannot work, and neither would
`killWorker(err)` in its place: the executor is synchronous, so anything it
assigns to `ready` is overwritten by the caller's `ready = spawn()` on the very
next line. The clear has to happen after that assignment, which means at the
caller:

```js
  if (!ready) {
    say(`Loading the media decoder (${MEDIA_MB} MB, once)…`);
    // A boot that fails must not be remembered as a permanently rejected
    // promise - `if (!ready)` would be false forever and every later call would
    // reject without ever respawning. Cleared here rather than inside spawn()
    // because the executor runs *before* this assignment. Identity-guarded so a
    // late failure cannot clear a worker that has since booted.
    let boot;
    boot = spawn().catch(err => { if (ready === boot) ready = null; throw err; });
    ready = boot;
  }
  await ready;
```

and inside `spawn()` the dead assignment goes:

```js
    catch (err) { reject(err); return; }
```

Every other death path keeps going through `killWorker()`, unchanged.

`optimize/optimize.js` (or whatever else calls `firstFrame()`/`ask()`) needs no
change — this only affects whether a second attempt is possible.

**Tests.** The worker path is not currently unit-testable (no `Worker` in
`node --test`). Rather than build a harness for one branch, verify by hand with
a CSP that forbids `worker-src` — drop a video, get the failure toast, drop
another, and confirm the second attempt tries to spawn again. Note the manual
check in the commit message.

---

## Commit 5 — A-05, A-06: housekeeping, both copying an existing pattern

**A-05** — `web/assets/js/ui/appearance.js:597-611, 645-647, 668-706`.

`sourceKey()` needs a stable identity, not a URL, and the hash is one.

1. `pictureURLs()` → `pictureHashes()`: same walk, same "pictures only, covers
   count" policy, but it pushes `h` and tests membership with `getAsset(h)`
   instead of minting through `assetURL(h)`. `getAsset` is already exported from
   `storage/assets.js`; add it to the existing import.
2. `sourceKey()` → `pictureHashes().slice(0, sourceCount()).join('\n')`.
3. `recolourFromBoard()` resolves URLs *after* slicing:

   ```js
   const hashes = pictureHashes();
   const urls = hashes.slice(0, sourceCount()).map(assetURL).filter(Boolean);
   ```

   The `if (!urls.length)` guard becomes `if (!hashes.length)` — "no pictures on
   the board" is a fact about the board, not about the slice. The
   `console.info` line keeps `hashes.length` for "pictures on the board" and
   `pixels.length` for "read", which is what it already means.
   `samplePixels(urls, sourceCount())` keeps its limit argument: harmless now
   that the list is pre-sliced, and it stays correct if either side changes.

   `Infinity` from `sourceCount()` flows through `slice()` unchanged, so the
   "all pictures" stop needs no special case.

**Payoff, and the bit worth checking.** On a 400-photo board the first `items`
event now mints at most `sourceCount()` object URLs instead of 400, and
`canvas/items.js`'s `discard()` bookkeeping is meaningful again. The comparison
also stops depending on object-URL stability across `clearAssets()`.

**Tests** (`tests/appearance.test.js` if there is a seam; otherwise a note).
`sourceKey()` is module-private — if it cannot be reached from a test, assert
the shape indirectly: with `board.paletteSources = 2` and four pictures on the
board, only two entries appear in the key. If neither is reachable, say so in
the commit message rather than pretending.

**A-06** — `web/assets/js/canvas/model.js:444-451, 539-544`; `web/assets/js/main.js:106`.

Copy `canvas/grid.js:905-935` exactly:

```js
let ink = null;

function boardInk() {
  if (ink) return ink;
  const probe = document.createElement('div');
  ...
  return (ink = getComputedStyle(probe).color, probe.remove(), ink);
}

/** Forget the resolved ink - the look changed. See gridInk() for the twin. */
export function resetModelInk() { ink = null; }
```

(written out plainly rather than in a comma expression — the sketch is for the
shape only.)

Dropped from two places:

- the module's own `bus.on('settings', ...)` listener at `:539`, which already
  fires on `appearance` — one line at the top of its body, *before* the loop
  that re-emits each model, or the stills are compared against the old ink and
  none of them are invalidated;
- `main.js:106`'s `initAppearance({ onChange })`, beside the existing
  `resetGridInk()`. Slider drags do not commit a setting, so without this a
  live drag leaves every model card measuring against a stale colour for the
  length of the gesture. `main.js` already imports from `canvas/model.js`
  (`resetModels`), so this is one name on an existing import.

`ui/board-actions.js:309` also calls `resetGridInk()` (the palette reset path)
and should call `resetModelInk()` for the same reason. It already imports
`resetModels` from the same module.

**Tests.** DOM-bound; covered by the invariant tests only. Verify by hand:
mount a screenful of uncoloured model cards, change the palette, confirm the
stills go live and come back.

---

## Not taken, and why

From the audit's "Smaller notes":

- **`import/drop.js:71-74`** (a stuck drop overlay) — worth doing, and it is a
  genuine user-visible wedge on GTK. Deferred to its own change rather than
  smuggled in here: it wants a `dragend`/`drop`-on-window reset plus a look at
  whether the depth counter should exist at all, which is a bigger question than
  a fix list.
- **`ui/trash.js:194`** (restore centres on the window, not the viewport) —
  identical today. It becomes wrong the first time anything is docked, and the
  fix belongs to whatever docks something.
- **`board-model.js:408`** (`makeItem()` defaults `z` from the live board inside
  `normalizeBoard()`) — harmless today and the reasons are load-bearing.
  A comment in `normalizeBoard()` recording *why* it is harmless is the whole of
  the work, and goes in commit 2 with the other comment fix.
- **`canvas/viewport.js:360`**, **`canvas/notes.js:50`**, **`web/sw.js:236`** —
  correctly diagnosed as traps for later, not defects now. Left alone.
- **`web/assets/css/items.css` at 97 KB** — a real piece of work and its own
  project. Not part of this.

---

## Order, and what to run

1. Commit 1 (A-01) — the only one a user can hit and be confused by.
2. Commit 2 (A-02, A-08) — introduces `isFurniture()`, so it precedes 3.
3. Commit 3 (A-07).
4. Commit 4 (A-04, A-03).
5. Commit 5 (A-05, A-06).

After each: `npm test`, `npm run typecheck`, `npx oxlint`, and `node --check` on
every touched `.js`. The baseline to beat is 728 passing, clean typecheck, and
no new lint warnings. Commits 1-3 add tests, so the count should rise; commit 4
rewrites one existing test rather than adding to the count.

Manual passes worth doing before calling it done: tick snap / undo / redo on a
board with a dozen items in both layouts (commit 1); drop a note on the title
card on Desktop and on Mobile (commit 3); open a `.mbrd` named `my_board.mbrd`
that was saved with that title (commit 4); a 100-photo board with auto-palette
on, watching object-URL count in devtools (commit 5).

---

## What actually happened

The plan held. Five differences worth recording:

1. **A-01 lost a redundant write.** `applySnapState()` used to call
   `writeSnapState(after)` and then `commit(label, () => writeSnapState(after), …)` -
   and `commit()` runs its redo half itself, so the geometry was written twice.
   Harmless while it was idempotent geometry; not harmless once the same call
   also wrote a setting and emitted `settings`. The pre-call is gone and the
   command's own redo does the work.

2. **A-07's seed guard names the title card by its constant.** The plan said to
   drop a `meta.stuckTo` record that points at furniture by testing the host's
   type. At `seedSticks()` time there is no host to test: `loadBoard()` runs it
   before `main.js` seeds the Desktop title card. So `TITLE_ID` is named
   directly, and ghosts need no test at all - a load drops every ghost, so a
   record naming one finds no host and falls through to measuring.

3. **A-03 got a unit test after all.** The plan called it manual-only for want of
   a `Worker` in `node --test`. Stubbing `globalThis.Worker` with a constructor
   that throws, and `globalThis.fetch` for the availability probe, is enough:
   `tests/media.test.js` asserts that a second `firstFrame()` reaches the
   constructor again. Verified to fail against the old code.

4. **A-05's test is a source assertion.** `ui/appearance.js` is one of the three
   modules that touch a browser global at import time, so it cannot be imported
   without a DOM and `sourceKey()` is private either way. The check reads the
   module - the same shape as the density-slider case already in
   `tests/appearance.test.js` - and asserts that the walk calls `getAsset()` and
   not `assetURL()`, and that the resolve happens on the slice.

5. **A-06 is still unit-tested only by the invariant suites**, as planned. The
   `boardInk()` cache is dropped from three places rather than the two the plan
   named: the module's own `settings` listener, `main.js`'s `onChange` (slider
   drags commit no setting), and `ui/board-actions.js`'s `reloadBoard()`, which
   already resets the grid's ink beside it.

6. **A-04 went further than the plan, because the ambiguity turned out not to be
   one.** The plan accepted that a board named `my_board`, saved under its own
   suggested filename, could not be told from a legacy export of "my board" -
   and that is the commonest save in the app, so the repair went on rewriting
   exactly the case the fix was for. It was reported straight away, correctly.
   `git log -S` finds the origin: up to v0.50, `exportBoard()` ran
   `setTitle(stripExt(fileHandle.name))` after the picker, so a Save As renamed
   the board to the picker-safe filename and every save after that wrote the
   underscored form into `board.json`. v0.51 changed that line and added the
   repair. The population needing repair is therefore exactly "written before
   v0.51" - and `manifest.json` has recorded the writing build in `app` all
   along, documented as informational. `titleForOpenedBoard()` now takes it as a
   third argument and repairs nothing else; a file naming no build is believed.
   `docs/mbrd-format.md` gained the rule and lost the "nothing reads it back".

**Not done, deliberately:** no CHANGELOG entry. That file is written by hand in
batches and its newest entry is v0.93 against a v0.110 tree, so these belong in
whatever pass next brings it forward - the user-facing three are the snap undo,
the HUD count, and the board title keeping its underscores.

**Verified by hand, still worth doing:** the CSP case for A-03 (a browser that
forbids workers, two video drops, both attempting a spawn) and the palette
change for A-06 (a screenful of uncoloured model cards going live and coming
back). Neither is reachable from `node --test`.
