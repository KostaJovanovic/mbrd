# Full code audit — 2026-08-02

> **Status: all eight findings fixed** (see
> [`code-audit-2026-08-02-plan.md`](code-audit-2026-08-02-plan.md) for what was
> done and what was deliberately left). The findings below are kept as written -
> a record of what was wrong and why it mattered - and so is "What was checked
> and found sound", which is the part a later pass should read first. Of the
> smaller notes, only the `makeItem()` `z` default was addressed, and only with
> the comment explaining why it is harmless.

A read of every JavaScript module under `web/assets/js/`, plus `web/sw.js`,
`serve.py` and the build/lint configuration. Roughly 25,000 lines of application
code read in full rather than sampled; the generated `import/formats.js` and the
test suite were skimmed rather than read line by line.

Prior audits (`old/full-code-audit-2026-07-26.md`,
`old/scalability-readability-audit-2026-07-27.md`,
`old/2026-07-31-full-repo-bug-audit.md`) closed the structural and
memory-boundary findings they raised; every AUD-nn referenced in the source was
spot-checked and is genuinely fixed. This audit is the pass after those, and it
finds a much shorter list.

## Baseline

| check | result |
| --- | --- |
| `npm test` | 728 pass, 0 fail |
| `npm run typecheck` | clean |
| `npx oxlint` | warnings only, no errors (`no-unused-expressions`, `no-new-array`, `no-useless-spread`, two intentional `no-control-regex`) |

No finding below is a crash, a data-loss path, or a security hole. The two
things worth fixing soon are **A-01** (a visible state lie after undo) and
**A-02** (the readout contradicting its own stated intent). The rest are small.

---

## Findings

### A-01 — Undoing "snap to grid" leaves the setting on and the board off it

`web/assets/js/state.js:1397`

`setSetting('snap', v)` writes the flag and *then* calls `snapAll()` /
`unsnapAll()`, which push their own `commit()`. The setting write is not part of
that command. So one Ctrl+Z after ticking the box restores every item's
geometry and leaves `settings.snap === true` — the panel says the board is
snapped, the grid says it is snapped, and nothing on it is.

Verified:

```
before snap: 13 27 201 137   snap=false
after snap : 32  0 186.88 122.88   snap=true
after undo : 13 27 201 137   snap=true      <- setting on, geometry unsnapped
```

The mirror case is the same: switch snapping off, undo, and everything is back
on the lattice with the box unticked. It is also reachable without the
checkbox — `axisMoved()` in `ui/appearance.js:399` flips `snap` from the whimsy
slider.

**Why it matters.** It is the only place in the app where undo produces a state
the user could not have produced by hand, and the recovery is unobvious (the
next drag silently re-snaps whatever it touches).

**Fix.** Fold the flag into the command the geometry already pushes: have
`snapAll()`/`unsnapAll()` commit a pair that writes `board.settings.snap` on the
way through and emits `settings` from both directions, and let `setSetting` skip
its own write for this one key. The alternative — leaving snapping off the
history entirely — means `applySnapState()` must stop committing too, or the
inconsistency simply moves.

---

### A-02 — The HUD counts the title card, so a blank board reads "1 thing"

`web/assets/js/ui/hud.js:240`

```js
const n = board.items.reduce((t, i) => t + (i.type === 'ghost' ? 0 : 1), 0);
```

Ghost cards are excluded; the Desktop title card is not. The comment two lines
above states the intent plainly — *"the number is meant to answer 'how much have
I put here' - which on a new board is none"* — and `state.js`'s own
`hasContent()` excludes both types. A brand-new board therefore opens reading
"1 thing", and every count on Desktop is one high thereafter.

**Fix.** One character of policy: `i.type === 'ghost' || i.type === 'title'`.
Better still, call `hasContent()`'s rule from one place so a fourth furniture
type cannot drift again.

---

### A-03 — A `new Worker()` that throws wedges the ffmpeg path for the session

`web/assets/js/optimize/media.js:196-197`, with the caller at `:142-146`

```js
function spawn() {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker('./assets/js/optimize/media-worker.js'); }
    catch (err) { ready = null; reject(err); return; }
```

`ready = null` runs inside the promise executor, which is synchronous — so it is
immediately overwritten by the caller's `ready = spawn()` on the next line. The
module is then left holding a permanently rejected promise, and `if (!ready)` is
false forever: every later `firstFrame()` rejects without attempting a respawn.

Every *other* death path (`onBoot` failure, `onDead`, the job timeout) goes
through `killWorker()`, which clears `ready` correctly. This is the one that
does not, and it is the constructor-throw case — a CSP that forbids workers, or
a blocked script URL.

**Fix.** Reject and let the caller clear, or call `killWorker(err)` instead of
assigning `ready` directly. The whole shape is what AUD-10 set out to fix; this
is the one branch it missed.

---

### A-04 — Opening a board rewrites underscores in a title the user chose

`web/assets/js/storage/naming.js:26`

```js
export function titleForOpenedBoard(storedTitle, fileName) {
  const title = ... storedTitle : titleFromFileName(fileName);
  return title.replace(/_/g, ' ');
}
```

The underscore substitution is unconditional. It is correct for the filename
fallback (`fileNameFor()` turns spaces into underscores) and wrong for a stored
title, which came out of `board.json` and never went through that mapping.
`cleanBoardTitle()` permits underscores, so a board deliberately named
`my_board` becomes `my board` the first time it is reopened — and stays that way,
because the load marks the change durable.

The comment acknowledges the reason ("older exports could pack the picker-safe
filename back into board.json") but applies the repair to every title rather
than only to the ones that need it.

**Fix.** Apply the substitution only on the filename branch. If old exports must
keep working, gate it on the stored title being byte-identical to
`fileNameFor(storedTitle)` minus the extension — that is the shape a
picker-safe title actually has.

---

### A-05 — The auto-palette mints an object URL for every picture on the board

`web/assets/js/ui/appearance.js:597-611`, reached from `:262-266` and `:646`

`sourceKey()` calls `pictureURLs()`, which walks the whole board and calls
`assetURL(hash)` for every image and every cover — *then* slices to
`sourceCount()`. `assetURL()` creates the object URL on first use and caches it,
so the first `items` event on a board with auto-palette on (the default) mints
one blob URL per picture, whether or not it is ever rendered, sampled or mounted.

On a 400-photo board that is 400 URLs held for the life of the session, which is
exactly the laziness `storage/assets.js` was written to preserve, and it defeats
`canvas/items.js`'s careful `discard()` bookkeeping for anything culled.

**Fix.** Key the comparison on hashes rather than URLs — `sourceKey()` only needs
a stable identity, and the hash *is* one — and slice before resolving URLs in
`recolourFromBoard()`. That also removes the incidental dependency on object-URL
stability across a `clearAssets()`.

---

### A-06 — `boardInk()` forces a style flush per model card

`web/assets/js/canvas/model.js:444-451`, called from `stillFor()` at `:415`

`boardInk()` appends a probe `<div>` to `document.body`, reads
`getComputedStyle(probe).color`, and removes it. `stillFor()` calls it for every
model card that carries a `shotInk` — which is every uncoloured model — and
`stillFor()` runs inside `buildModelCard()`, which runs inside the culler's build
budget. So mounting a screenful of model cards is one DOM insert, one forced
style recalculation and one removal each, on frames the budget exists to protect.

The value changes about as often as the palette does. `canvas/grid.js` already
solves the identical problem with a cached `gridInk()` plus a `resetGridInk()`
hook that `initAppearance({ onChange })` calls.

**Fix.** Cache the resolved ink and drop the cache from the `settings:appearance`
listener this module already has (`:539`).

---

### A-07 — A note can stick to the Desktop title card

`web/assets/js/sticky.js:107` (`measureStick`) and `:126` (`wouldStick`)

Neither excludes `title` or `ghost` items, so a sticky note dropped over the
title card becomes stuck to it and travels with it. `layout.js:429` goes to some
length to park the title card clear of the Mobile board precisely so that
"a note dropped on it became stuck to it" cannot happen there — but the rule was
fixed at the *obstacle* end, not at the stick end.

The consequence on Mobile is contained rather than fatal: `attachRiders()` places
the rider at the parked position, and `writeLayout()`'s `fitBoardMode()` clamps
it back to the top row (measured: `y` 533.5 requested, 321.44 written). So the
note is visible — but it lands in the first row *as a rider*, which the packer
never treated as an obstacle, so it can sit on top of whatever was packed there.

Ghost cards have the same exposure with a shorter fuse: a note stuck to a hint is
stuck to something that is deleted the moment real content arrives.

**Fix.** One predicate in both functions — a host must be a real item. This is
the same list `hasContent()`, `serializeBoard()` and `placeMobileItems()` already
keep; it is worth naming once (`isFurniture(item)`) and importing.

---

### A-08 — A stale comment claims video never raises the now-playing bar

`web/assets/js/canvas/video.js:211`

> `// playing; audio.js filters on type, so a video never raises the bar.`

`registerPlayer()`'s `play` handler in `canvas/audio.js:201-215` has no type
filter, the header of that file says the opposite in as many words
("Video as well as audio"), and `ui/nowplaying.js:154` explicitly branches on
`current.item.type === 'video'` to pick the line notation. The comment describes
behaviour that was deliberately changed.

**Fix.** Delete the clause. In a codebase where the comments *are* the
specification, a comment that contradicts three other files is a real defect.

---

## Smaller notes

Worth knowing, not worth a ticket on their own.

- **`board-model.js:408`** — `makeItem()` defaults `z` to `topZ() + 1`, which
  reads the *live* board. Inside `normalizeBoard()` (`state.js:1539`) the live
  board is still the previous one, so an incoming item with no `z` is stacked
  against a board that is about to be replaced. Harmless today because
  `normalizeLayout()`/`completeLayout()` overwrite geometry, and because every
  file this app writes carries a `z`.
- **`canvas/viewport.js:360, 369`** — the `scroll` listener calls `measure()`,
  which calls `mobileTopPad()`, which does a second `getBoundingClientRect()` on
  `#menu-btn`. The document does not scroll, so this fires almost never; it is
  only a trap for whoever makes it scroll.
- **`import/drop.js:71-74`** — the drop overlay is depth-counted on
  `dragenter`/`dragleave`. A drag that leaves the window without a matching
  `dragleave` (it happens on some Linux/GTK combinations) leaves the overlay up
  with no way down but another drag. A `dragend`/`drop`-on-window reset would
  close it.
- **`ui/trash.js:194`** — restore-by-keyboard lands the item at
  `vp.toWorld(innerWidth / 2, innerHeight / 2)` rather than at the viewport's own
  centre. Identical today (the viewport is full-bleed); it will stop being
  identical the first time anything is docked.
- **`canvas/notes.js:50`** — `noteHeight()` is a destructive-then-restored
  measurement and is called from `input.js:942` on every frame of a note resize.
  It is bounded to one note and reads `offsetHeight` once, so it is a forced
  reflow per frame of one gesture. Acceptable; worth remembering if the note
  editor ever grows.
- **`web/sw.js:236-248`** — the runtime cache accepts any same-origin `GET` and
  is only reclaimed on a `VERSION` bump. There is nothing large a board fetches
  same-origin today, so it is bounded by the shell in practice.
- **`web/assets/css/items.css` is 97 KB**, three times the next largest
  stylesheet and larger than most of the JavaScript modules put together. Not a
  fault, but it is the file that will want the same treatment `app.css` got.

---

## What was checked and found sound

Recorded so a later pass does not redo it.

**Untrusted input.** Every path a `.mbrd` takes was followed end to end. The ZIP
reader bounds-checks every offset before use, caps entry count, entry size, total
inflation and expansion ratio, treats the declared size as a *budget* rather than
a claim (`inflateRaw`), verifies CRC32 per entry, and rejects duplicate names.
`mbrd.js` re-verifies every asset's SHA-256 against the name it was stored under
and refuses a hash that is not a digest before it can be spelled into a path.
`normalizeBoard()` cannot throw part-way through a load, and every container is
checked for the shape it is about to be used as. `mesh.js` validates accessor
counts before allocating, caps embedded buffers from the base64 length rather
than after `atob()`, and walks the glTF node graph iteratively with depth, visit
and per-path cycle guards.

**Code reaching the browser as code.** `settings.appearance.vars` is the only
part of a board that becomes CSS. `ui/look.js` holds it to a token allowlist, a
value alphabet that admits no `\`, `;`, `}`, `@` or `<`, and a function
allowlist that excludes every way of naming a resource. Font family names are
*rebuilt* from filenames through `isFamily()` and never taken. `linkURL()`
allows exactly `http:`/`https:`. `embed.js` validates provider ids against exact
patterns before interpolating them into a fixed template, sets
`referrerpolicy=no-referrer`, and sandboxes the frame. Nothing anywhere builds
markup from a string a file supplied — `innerHTML` appears only with source
literals.

**Concurrency.** The single-flight save coordinator in `storage/session.js`
(`saveGen`/`committedGen`/`saving`) is correct: no two `writeSnapshot()` runs
overlap, a change arriving mid-write is captured by a follow-up, and the sweep
can never delete bytes the snapshot it just wrote still references. `drainSave()`
plus `suspendCache()` correctly close the window AUD-03 named. `idb.js` resolves
from `transaction.oncomplete` rather than `request.onsuccess`, which is the
distinction that makes "saved" mean saved.

**The layering rules.** `tests/layers.test.js`, `tests/imports.test.js`,
`tests/sw.test.js` and `tests/fonts-license.test.js` genuinely enforce what
`docs/architecture.md` claims. Nothing under `canvas/` imports `ui/`; the six
modules split out of `state.js` never import it back; exactly three modules touch
a browser global at import time; `SHELL` matches the files on disk. The
injection seams (`setAssetNameLookup`, `setPrompt`, `initSession`,
`initAppearanceControls`, `initGhosts(cmds)`) are all one-directional.

**Arithmetic.** `geometry.js` (Cohen–Sutherland, Sutherland–Hodgman,
rotated extents), `web-graph.js` (Prim, the crossing test, the governor's
quadratic solve and its deadband), `pigments.js` (OKLab conversions, the gamut
bisection, the contrast repair), `measure.js` (the unit ladders and the imperial
carry) and `opus.js` (the Ogg lacing table, including the multiple-of-255 and
>65,025-byte cases) were each read for correctness and hold up. `mesh.js`'s
`standUp()` box transform and `model.js`'s `orbitView()` handedness are both
right, and both carry the note explaining the version that was not.

---

## Suggested order

1. **A-01** — the only finding a user can hit and be confused by.
2. **A-02**, **A-08** — one line each, and both are the codebase disagreeing
   with itself.
3. **A-07** — one predicate, and it closes a class rather than a case.
4. **A-04**, **A-03** — narrow paths, real defects.
5. **A-05**, **A-06** — housekeeping, both with an existing pattern to copy.
