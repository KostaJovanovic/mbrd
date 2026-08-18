# Simplification — the task list

Open work. The executable half of
[`simplification-2026-08-18.md`](simplification-2026-08-18.md). That document
argues *why*; this one says *what to type*. Read that one only when a task here
tells you to.

Written against `add013e` (v0.252), tree clean. Every line number below was
checked at that commit.

**Who this is for.** An agent working through the list one task at a time. Each
task is self-contained: it names the file, gives a string to search for, says
what should be there, and says what to change it to. You do not need to have
read the audit, and you do not need to hold the whole plan in your head.

---

## Rules that apply to every task

Read these once. They are not repeated per task.

**1. Find by string, not by line number.** Line numbers are a hint and they
drift as you edit. Every task gives a **Find** string. Use it.

**2. If what you find does not match what the task says is there, stop that
task.** Do not improvise a different fix. Mark the task `SKIPPED — anchor
mismatch` in the checklist at the bottom and move to the next one. A task whose
code has changed underneath it is a task whose reasoning may no longer hold.

**3. Read the top of the file before you change it.** Every file in this repo
argues its own design in a header comment. That header is often the reason the
code looks the way it does. If the header contradicts the task, **the header
wins** — stop and record it.

**4. An unused symbol may be a test anchor.** Some tests in this repo read
source files **as text** and assert on their contents. A grep for a symbol name
will not find those references. Before deleting anything, run:

```bash
grep -rn "<symbol>" tests/ tools/ web/assets/js/
grep -rln "readFileSync\|read(join" tests/
```

If any test reads the file you are editing as text, open that test and check it
by hand. `util.ts` `isDev()` is the known case — **never delete it**, its own
header says it stays.

**5. Never touch these files.**

| file | why |
| --- | --- |
| `patch-notes.md` | the author's, and only theirs |
| `web/patch.html` | generated from the above |
| `web/404.html` | byte-for-byte copy of `index.html` |
| `web/assets/js/version.js`, the `VERSION` line in `web/sw.js` | stamped by regex |
| `web/assets/js/import/formats.ts`, `web/assets/stickers.svg` | generated |
| `web/assets/app.js` | the build output — regenerate, never hand-edit |

**6. Nothing in this plan changes behaviour a user can see**, with one
exception: task **T1.1**, which fixes a wrong label. Everything else is the same
bytes in, same bytes out, same files on disk. If a change you are making would
alter the `.mbrd` file format, a generated catalogue, or the `SHELL` list in
`web/sw.js` — **you have misread the task**. Stop.

**7. No `style=` attributes in markup.** Setting `.style` from script is fine.
A `style` attribute in HTML is a CSP violation that fails silently on the deploy
and never locally.

**8. Verify at commit boundaries, not per task.**

```bash
npm test          # no install needed, run it first
npm run lint      # oxlint, correctness only
npm run typecheck # tsc --noEmit, strict
npm run build     # catches unresolvable and dynamic imports
```

This repo's habit is to move fast and skip these. That habit is for small
interactive edits. This is forty-odd mechanical changes across sixty files, so
run all four at the end of every commit group below. If a leg fails, fix it
before starting the next group.

**9. Do not `git push`.** Commit if asked. Pushing is a separate decision that
belongs to the person who owns the repo.

**10. When a fix has a sibling.** Several tasks below say *"the rule is argued
at `<other file>`"*. That means a header somewhere already explains why the code
you are fixing is wrong, and the knowledge never travelled. When you fix it,
**leave a one-line pointer** in a comment at the site you fixed, naming the file
that argues it. That is the actual repair — the code change alone lets the next
copy happen.

---

## Order

Seven commit groups, in this order. The order is not arbitrary; two of the
constraints inside it are traps and are marked where they occur.

| group | what | why here |
| --- | --- | --- |
| C1 | bugs | before anything moves, so their history stays readable |
| C2 | false documentation | before C6/C7 relocate the code it describes |
| C3 | per-frame costs | small, local, none architectural |
| C4 | sibling sites | partly editorial; wants C2 already done |
| C5 | costs that scale | larger diffs, lower urgency |
| C6 | the fixed-point walk | largest change, on its own — **may be declined** |
| C7 | duplication and dead code | most likely to be abandoned half-done |

---

# C1 — Bugs

Seven tasks. Five are one-liners.

### T1.1 — The palette readout prints "120 photos" where it should say "Every photo"

**Do this before T1.2.** Fixing them the other way round hides the symptom:
with the slice narrowed first, the wrong number on screen becomes a *smaller*
wrong number instead of an obviously wrong one.

**File** `web/assets/js/ui/appearance-controls.ts:313` and `:327`

**Find** `grep -n "Infinity" web/assets/js/ui/appearance-controls.ts`

**Now** Three sites test `sourceCount()` against `Infinity`:

```ts
const all = n === Infinity;                                    // :313
input.value = String(d.sourceCount() === Infinity ? d.ALL_SOURCES_STOP : d.sourceCount()); // :327
```

`sourceCount()` has not returned `Infinity` since it was changed to return
`ALL_SOURCES_MAX` (= `120`, `ui/appearance.ts:711`). So `all` is permanently
false and the readout prints `"120 photos"` instead of `"Every photo"`.

**Do** Test against the real top-stop value instead. `ALL_SOURCES_MAX` is
module-private in `appearance.ts`; it is already passed in through the `d`
dependency object — check `ui/appearance-controls.ts:82` for the shape and add
`ALL_SOURCES_MAX` to it if it is not there, wired at the call site in
`appearance.ts` (search `CONTROLS,` near `:202`).

```ts
const all = n >= d.ALL_SOURCES_MAX;                            // :313
input.value = String(d.sourceCount() >= d.ALL_SOURCES_MAX ? d.ALL_SOURCES_STOP : d.sourceCount()); // :327
```

**Guard** `input.max` is `ALL_SOURCES_STOP` (= `MAX_SOURCES + 1` = `25`). Line
`:327` currently writes `"120"` into an input capped at `25` and the browser
clamps it, so the slider *looks* right today. Your change must keep it landing
on `ALL_SOURCES_STOP` at the top stop.

**Done when** With `paletteSources` set to `0`, the readout beside the slider
reads **Every photo**, and the slider sits at its maximum.

---

### T1.2 — Ninety-six blob URLs minted per `items` event and never read

**File** `web/assets/js/ui/appearance.ts:812`

**Find** `grep -n "hashes.slice(0, sourceCount())" web/assets/js/ui/appearance.ts`

**Now**

```ts
const urls = hashes.slice(0, sourceCount()).map(assetURL)
  .filter((u): u is string => !!u);
```

`sourceCount()` returns up to `120`. `samplePixels()`
(`ui/pigments.ts:1105`) then clamps to `MAX_SOURCES` = `24`. So at the top stop
the app mints 120 blob URLs, session-caches them with no per-hash release, and
reads 24.

**Do** Slice to what the sampler will actually consume:

```ts
const urls = hashes.slice(0, Math.min(sourceCount(), MAX_SOURCES)).map(assetURL)
  .filter((u): u is string => !!u);
```

`MAX_SOURCES` is exported from `ui/pigments.ts:1089`. Check whether
`appearance.ts` already imports it; add it to the existing import if not.

**Guard** Do not change `sourceCount()` itself — the setting it reads is also
used elsewhere. Only the slice narrows.

**Done when** The slice can never exceed `MAX_SOURCES`.

---

### T1.3 — Two stale comments about `Infinity`

**File** `web/assets/js/ui/appearance.ts:681`, `web/assets/js/ui/pigments.ts:1108`

**Find** `grep -n "which is Infinity here" web/assets/js/ui/appearance.ts`
and `grep -n "may be Infinity" web/assets/js/ui/pigments.ts`

**Now** `sourceCount()`'s docblock says the zero stop *"means every picture on
the board, which is Infinity here"*. It is not — the docblock twelve lines
below at `:693` argues at length why it is `120`. And `samplePixels()`'s comment
says *"`limit` may be Infinity, which is what 'every picture' arrives as"*.
After T1.2, nothing hands it `Infinity`.

**Do** Correct both to describe what the code does. In `appearance.ts:681`,
say the zero stop means `ALL_SOURCES_MAX` and point at the block below.
In `pigments.ts:1108`, drop the `Infinity` sentence; keep the falsy-limit
sentence, which is still true and still load-bearing.

**Do also** `ui/pigments.ts:1113` —
`const n = asked === Infinity ? urls.length : …` — is now a dead branch. Reduce
to `const n = Math.max(1, Math.min(asked, MAX_SOURCES));`.

---

### T1.4 — Six global listeners leaked per floating-window open

**File** `web/assets/js/ui/float-window.ts`

**Find** `grep -n "addEventListener('pointermove'\|addEventListener('pointerup'\|addEventListener('pointercancel')" web/assets/js/ui/float-window.ts`

**Now** `makeWindowDrag` and `makeWindowResize` each register three permanent
listeners on `window` (bare `addEventListener` at module scope resolves to
`window`) — around `:60, 71, 72` and `:106, 119, 120`. Both floating windows are
rebuilt on every open, so each open/close cycle leaves six listeners closing
over a detached element.

**Do** Give both functions one shared grab helper that returns a detach
function, and have the window's close path call it. Sketch:

```ts
function grab(win: HTMLElement, handle: HTMLElement, onMove: (e: PointerEvent) => void, onEnd: (e: PointerEvent) => void): () => void {
  const move = (e: PointerEvent) => onMove(e);
  const end = (e: PointerEvent) => onEnd(e);
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
  return () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
  };
}
```

Both `makeWindowDrag` and `makeWindowResize` must **return** the detach so the
caller can hold it.

**Guard** The comment at `:55` explains why these listeners are on `window` and
not on the handle: *"a pointer that left the bar delivered nothing here"*. That
reasoning is correct and must survive. You are changing their **lifetime**, not
their target. Keep the comment and add a sentence saying the detach is what
bounds them.

**Then** find the two callers (`grep -rn "makeWindowDrag\|makeWindowResize"
web/assets/js/`) and call the detach on close.

**Done when** Opening and closing a floating window ten times leaves no
listeners behind.

---

### T1.5 — `clearQueue()` leaves an `error` handler on a shared element

**File** `web/assets/js/canvas/playlist-queue.ts:507`

**Find** `grep -n "removeEventListener('ended', queueEnded)" web/assets/js/canvas/playlist-queue.ts`

**Now** Three teardown sites. Two remove both handlers:

```ts
el.removeEventListener('ended', queueEnded);
el.removeEventListener('error', queueRefused);
```

`clearQueue()` removes only `ended`:

```ts
if (endedBound) { endedBound.removeEventListener('ended', queueEnded); endedBound = null; }
```

This is the board-replacement path — the one that revokes asset URLs — so
`queueRefused` survives on the shared element and can call `advanceQueue()`
against a queue that was just emptied.

**Do**

```ts
if (endedBound) {
  endedBound.removeEventListener('ended', queueEnded);
  endedBound.removeEventListener('error', queueRefused);
  endedBound = null;
}
```

**Done when** All three teardown sites remove both listeners.

---

### T1.6 — Feet-and-inches never take the shared-unit branch

**File** `web/assets/js/measure.ts:151`

**Find** `grep -n "a.slice(a.indexOf(' '))" web/assets/js/measure.ts`

**Now** `formatSize()` recovers a unit by re-parsing already-formatted text:

```ts
const unit = a.slice(a.indexOf(' '));
```

An imperial `"4 ft 3 in"` has two spaces, so `unit` becomes `" ft 3 in"` and the
shared-unit branch below it silently never fires for imperial.

**Do** The real repair is upstream: `metric()` and `imperial()` chose the unit
and threw the choice away into a string. Change them to return
`{ value: string, unit: string }` and have `formatMm` join them. Then
`formatSize` compares `unit` fields directly and never parses text.

**Guard** `formatMm` and `formatLength` are the public shape and are called
widely — `grep -rn "formatMm\|formatLength" web/assets/js/`. Their **return
type must stay `string`**. Only the private `metric()`/`imperial()` change
shape.

**If that refactor looks larger than it should**, the minimal fix is to match
the unit from the end instead of from the first space — but record in the
checklist that you took the smaller option, because the string round-trip is the
actual defect.

**Done when** `formatSize` of two imperial lengths that share a unit says the
unit once.

---

### T1.7 — A submenu would announce its own shortcut as part of its name

**File** `web/assets/js/ui/menu.ts:1767`

**Find** `grep -n "row.textContent?.trim() || 'More'" web/assets/js/ui/menu.ts`

**Now**

```ts
child.setAttribute('aria-label', row.textContent?.trim() || 'More');
```

`fillPanel` appends a `<kbd>` accelerator into that same row (around
`:1601`–`:1606`). A sub-bearing row that ever gained an accelerator would
announce itself as *"Tags F2"*.

**Do** `entry.label` is in scope at the one call site (`:1673`). Pass it in and
use it, falling back to `row.textContent` then `'More'`.

**Guard** This is latent, not live — no sub-bearing row currently carries an
accelerator. Do not change the accelerator markup to "fix" it from the other
end; the label is the thing that is wrong.

---

### T1.8 — A handler that provably cannot do anything

**Files** `web/assets/js/ui/dialog.ts`, `web/assets/js/ui/color-picker.ts`

**Find** `grep -n "onCancelEvent" web/assets/js/ui/dialog.ts web/assets/js/ui/color-picker.ts`

**Now**

```ts
const onCancelEvent = () => { answer = 'cancel'; };
```

`answer` is already `'cancel'` on every path that can reach it, and the only
other writer calls `el.close()`, which fires `close` and not `cancel`.

**Do** Delete the declaration and both its `addEventListener` /
`removeEventListener` pairs, in both files. Four sites in total:
`dialog.ts:199`, `:211`; `color-picker.ts:288`, `:307`.

**Guard** Leave a one-line comment where it was saying Escape is handled by the
browser firing `cancel` then `close`, and that `close` is the one this listens
to. Otherwise the next reader re-adds it.

---

**Commit C1.** Run the four verification legs. Message should name the palette
readout and the two leaks explicitly.

---

# C2 — Documentation that is false

Three tasks. No code changes at all except one deletion.

### T2.1 — A paragraph that argues against the function beneath it

**File** `web/assets/js/optimize/optimize.ts:259`

**Find** `grep -n "one at a time and awaited" web/assets/js/optimize/optimize.ts`

**Now** A docblock says *"Every file is done one at a time and awaited. Running
them concurrently would be faster on paper and is the wrong shape here … eight
of those at once on a board of large photographs is how you find the tab's
memory ceiling."* The function directly beneath it is `pool()`, whose own header
says the opposite — *"Lanes rather than Promise.all"* — and `runOptimize` (near
`:386`) calls `pool(jobs, LANES.media, …)`.

**Do** **Delete the paragraph.** Do not move it, do not rewrite it. `pool()`'s
own header already tells the true story, and the design this paragraph describes
was reversed.

**Guard** Read `pool()`'s header first and confirm it says what this claims. If
`pool()` turns out to be serial after all, stop — the audit is wrong and that
matters more than the task.

---

### T2.2 — Seven doc blocks on the wrong declaration

Each block describes one function and sits on a different one, leaving the thing
it describes bare further down. Mechanical: move the block down to the
declaration it describes.

| move the block at | which describes | off | note |
| --- | --- | --- | --- |
| `commands.ts:155` | `createCommands` (`:242`) | `layoutItems` (`:188`) | |
| `commands/connections.ts:97` | `joinable` (`:121`) | `CONNECT_ALL_MAX` (`:119`) | |
| `arrange/arrangements.ts:535` | `lattice` (`:622`) | `clustered` (`:567`) | `clustered` has its own — do not delete it |
| `layout.ts:1349` | `writeSnapSetting` (`:1367`) | `type SnapState` (`:1363`) | the type has its own |
| `web-route.ts:309` | `routeConnection` (`:340`) | `type Route` (`:338`) | the type has its own |
| `optimize/optimize.ts:459` | `backfillPosters` | `clipsWantingStills` | |
| `optimize/optimize.ts:597` | `backfillThumbs` | `thumbSource` | |

**Do** For each row: read the block, confirm it describes the target and not
what it sits on, then move it. Work bottom-up within a file so earlier line
numbers stay valid.

**Guard** Three of the seven are displacing a docblock that is **correct**
(`clustered`, `SnapState`, `Route`). Do not delete those. You are moving the
intruder past them, not replacing them.

**Guard** The two `optimize.ts` rows are in the same file as T2.1. Do T2.1
first, then re-find these by string.

---

### T2.3 — Two docstrings that claim a caller they do not have

**Files** `web/assets/js/cuelume/engine.ts:808`, `web/assets/js/import/cfbf.ts:317`

**Now** `engine.ts:808` says `playVoice` is *"the bench's door and nothing
else's"* — but `ui/sound-lab.ts` uses `playRecipe` exclusively.
`cfbf.ts:317` says `pictureFrom()` exists *"so the summary stream is looked up
once"* — but the caller does the lookup and passes it in, so it happens once
either way.

**Do** Correct both to say what is true now. Both symbols are resolved properly
in C7 (T7.9 deletes `playVoice`, T7.10 inlines `pictureFrom`); the point here is
that the prose is wrong in the meantime, and C7 may not happen.

---

**Commit C2.** Run the four legs.

---

# C3 — Per-frame costs

Six tasks. All small, all local.

### T3.1 — Sixty accessibility-tree writes a second

**Do this one first in the group.** It is the only cost here paid continuously
while nothing is happening.

**File** `web/assets/js/canvas/transport.ts:202`–`210`

**Find** `grep -n "aria-valuetext" web/assets/js/canvas/transport.ts`

**Now** `paint()` runs every rAF frame while a card plays and unconditionally
writes `time.textContent` plus three `setAttribute`s:

```ts
time.textContent = clock(sound.currentTime || sound.duration || 0);
wave.setAttribute('aria-valuemax', String(Math.round(sound.duration || 0)));
wave.setAttribute('aria-valuenow', String(Math.round(sound.currentTime || 0)));
wave.setAttribute('aria-valuetext', `${clock(sound.currentTime || 0)} of ${clock(sound.duration || 0)}`);
```

`aria-valuemax` is constant for the clip. `aria-valuenow` and both `clock()`
strings change at 1 Hz. Only the fill's `clipPath` needs frame rate.

**Do** Cache the last whole second written and skip all four when it has not
changed:

```ts
let lastSec = -1;
// …inside paint():
const sec = Math.round(sound.currentTime || 0);
if (sec !== lastSec) {
  lastSec = sec;
  // the four writes
}
```

Hoist `aria-valuemax` out of `paint()` entirely if the duration is known when
the transport is built; otherwise write it once per duration change.

**Guard** Every existing comment in that block argues the **content** of each
string. None addresses how often it is written. Keep all of them and add one
sentence about the rate.

**Guard** Reset `lastSec` on seek and on clip change, or the readout will lag
after a scrub.

---

### T3.2 — Two whole-board walks per `pointermove`, and a copied map callback

**File** `web/assets/js/canvas/web.ts:1447`, `:1484`–`:1486`

**Find** `grep -n "boxOf" web/assets/js/canvas/web.ts`

**Now** Two problems in the same commit:

1. `boxOf(overId)` is built as a truthiness test, discarded, and rebuilt as
   `boxOf(aim)` for the same id on the next line.
2. `boxOf` reaches the item with `board.items.find` where `byId` is O(1).
   `web.ts:35` imports from `state.ts` but not `byId`.

**Do** Bind the box once and reuse it. Add `byId` to the existing `state.ts`
import and use it inside `boxOf`.

**Do also, same commit** `boxOf` (`:1446`) is `centres()`'s map callback
(`:545`–`:566`) copied — same lean rule, same `y: -it.y`, same
`rot: -(it.rot || 0) + lean`. Extract one `cardOf(item)` and have both call it.

**Guard** `boxOf`'s own comment records that the lean was **omitted here once**.
That is the bug this duplication already produced. Move that comment to
`cardOf` — it is the reason the shared function exists.

---

### T3.3 — A layout forced per turn frame

**File** `web/assets/js/canvas/model.ts:797`, `:806`

**Find** `grep -n "getBoundingClientRect\|getContext('2d')" web/assets/js/canvas/model.ts`

**Now** `drawInto()` calls `stage.getBoundingClientRect()` and
`stage.getContext('2d')` on every frame. The stage's box cannot change during a
captured drag, and there is already a `ResizeObserver` on it (`:299`) whose
whole job is to repaint when it does. `getContext('2d')` returns the same object
every call.

**Do** Cache both. The observer at `:299` is the invalidation signal for the
box — have it clear the cached rect. Cache the context on the element or in a
`WeakMap` keyed by the canvas.

**Guard** The comment at `:809` removed a per-frame `getComputedStyle` for
exactly this reason and left these two standing. Extend that comment to cover
all three rather than adding a second one beside it.

---

### T3.4 — Note-resize re-derives everything around the measurement

**Files** `web/assets/js/canvas/notes.ts:119`, called from
`web/assets/js/canvas/input.ts:2482`

**Now** Per pointermove of a note resize, this re-walks `nodeFor(id)` → `.card`
→ `.note-rich` and calls `getComputedStyle(card)` for the paddings. Only `width`
differs between frames; the nodes and the padding are invariant for the gesture.

**Do** Resolve the nodes and the padding once when the gesture is entered —
`input.ts:1806`, beside `grip.box` — and pass them through.

**Guard** The measurement itself is defended in `notes.ts`'s header and is
**not** in question. Do not remove it or replace it with an estimate. What is
roundabout is re-deriving its inputs.

---

### T3.5 — A `find` per frame of every drag

**File** `web/assets/js/canvas/input.ts:2355`

**Find** `grep -n "drag.origin.find(o => o.id === drag.lead)" web/assets/js/canvas/input.ts`

**Now**

```ts
const lead = drag.origin.find(o => o.id === drag.lead) || drag.origin[0];
```

Neither `drag.origin` nor `drag.lead` is reassigned after `enter('move', …)` at
`:1645`.

**Do** Resolve once in `startMove()` and store it on the drag state.

**Guard** Keep the `|| drag.origin[0]` fallback. Do not split
`canvas/input.ts` — one pipeline, one active gesture, and that is a standing
rule.

---

### T3.6 — `byId` resolved twice per moved item per frame

**Files** `web/assets/js/canvas/items.ts:249`–`258`, with `:1452`–`:1458`

**Now** `placeNode(id)` resolves `byId(id)` and the caller immediately resolves
it again.

**Do** Have `placeNode` take the item, or return what the caller needs. Each
lookup is O(1) so this is mostly clarity — but the duplication is invisible from
the call site, which is how it got there.

---

**Commit C3.** Run the four legs. Then open the app and play a track: the
transport should still glide, and the clock should still tick.

---

# C4 — The sibling sites

Six tasks. Each one has a header elsewhere in the tree that already argues the
rule. **Rule 10 applies to all of them** — leave a pointer.

### T4.1 — Five comparisons by `JSON.stringify`

**Files** `state.ts:586`, `state.ts:1452`, `connections.ts:195`,
`timeline.ts:315`, `timeline.ts:720`

**Find** `grep -rn "JSON.stringify(.*) === JSON.stringify(" web/assets/js/`

**Now** `ui/look.ts:223` documents both the problem and what a false negative
cost: keys *"arrive in whatever order the palette that wrote them happened to
use"*, two identical looks compared as different, and the re-apply that followed
*"clears `derived`"* — so *"a board could quietly lose the provenance of its own
extracted palette by being told about itself."*

Five sites still do it. Two matter most:

- `state.ts:1452` compares `board.mobileHeader`, which carries an `axes` map
  built by `Object.entries` iteration. Same hazard shape, on the door the
  masthead sliders write through.
- `state.ts:586` serialises a note's whole block model twice on every editor
  commit to answer *"did anything change"*.

**Do** Replace each with a structural comparison. `state.ts` already has the
right shape three times over — read `sameRect` (`:1177`), `sameAdjust`
(`:1207`) and `sameFlip` (`:1237`) and follow their style.

**Guard** These are five different data shapes. Do not write one generic deep
compare and point all five at it — write the comparison each site needs, the
way the three existing `same*` helpers do. A generic one would have to handle
cases none of these five have, and that is how the next bug gets in.

**Guard** `ui/look.ts:223` itself is already **fixed** and is the file that
documents the fix. Do not change it. Point at it.

---

### T4.2 — `includes` inside a growing loop, in the file that bans it

**File** `web/assets/js/layout.ts:1169`

**Find** `grep -n "driven.includes(b.id)" web/assets/js/layout.ts`

**Now**

```ts
if (!driven.includes(b.id) || !isFence(byId(b.id))) continue;
```

inside a loop over every moved item — in the file that argues against precisely
this at `:1027`, where `travelling()`'s header says `out.includes(id)` in a
growing loop *"makes the fixed-point walk quadratic … the drag doing that
arithmetic on every commit."*

**Do** Build a `Set` above the loop and test against it.

**Guard** `driven` may be undefined — the branch is already guarded by
`if (driven && …)`. Build the Set inside that guard.

---

### T4.3 — `byId(host.id)` where `host` is already live

**Do this before C6.** Folding these loops into `attachRiders` needs the helper's
callback widened, and that is an API change that should not ride along with a bug
fix.

**File** `web/assets/js/ui/board-actions.ts:862`, `:863`, `:882`

**Find** `grep -n "byId(host.id)\|byId(i.id)" web/assets/js/ui/board-actions.ts`

**Now** `host` comes from `stuckTo(note)`, which returns the board item via
`byId` (`sticky.ts:191`). So `byId(host.id)` **is** `host`, recomputed twice on
adjacent lines inside a loop that repeats until it stops growing. The `!`
assertions exist only because the round trip discards a non-nullness the code
already had.

`:882` is the same shape: `items.map(i => byId(i.id)).filter(it => !!it)` over
items that are already live.

**Do** Use `host` directly and drop the now-unnecessary `!` assertions. Delete
the `map`/`filter` at `:882`.

**Guard** The rule is argued at `sticky.ts:571`: *"`host` itself, not
`byId(host.id)`. stuckTo() already returned the live item, so the round trip
bought nothing and cost the one thing an index can be: out of date."* Leave a
pointer to it.

**Guard** Confirm `stuckTo` still returns the live item before you rely on it.
One grep: `grep -n "export function stuckTo" -A 15 web/assets/js/sticky.ts`.

---

### T4.4 — The board walked twice, one line after the call that avoids it

**File** `web/assets/js/ui/appearance.ts:805`, `:818`

**Now** `autoRecolour` honours `sourceKey`'s documented one-pass design — the
walk is a parameter *"so autoRecolour() can count the pictures and build the key
off one pass rather than two"* (`:734`) — and then calls `recolourFromBoard()`,
which walks the board again and rebuilds the key. Fires on every `items` event
with Dynamic on.

**Do** Thread the hashes through. `recolourFromBoard` should take the already
-computed hashes as an optional parameter and only call `pictureHashes()` when
it is not given one.

**Guard** This file is also touched by T1.2 and T1.3. Do those first, then
re-find by string.

---

### T4.5 — A square root taken only to compare

**File** `web/assets/js/arrange/arrangements.ts:402`

**Find** `grep -n "Math.hypot(at.x, at.y)" web/assets/js/arrange/arrangements.ts`

**Now**

```ts
const r = Math.hypot(at.x, at.y);
if (r < near) { near = r; best = at; }
```

`r` is used only to compare against `near`. `geometry.ts:357` exports `distSq`
and its header says the square root is monotonic and *"Do not 'fix' this into a
real distance."*

**Do** Compare squared distances. `near` starts at `Infinity`, which stays
correct.

**Guard** Confirm `r` is not read anywhere else in that scope after the loop.

---

### T4.6 — Template strings as `Set` keys in the Mobile packer

**File** `web/assets/js/layout.ts:166`, `:192`, `:199`, `:204`

**Find**

```bash
grep -n '${col}:${row}' web/assets/js/layout.ts
```


**Now** A `` `${col}:${row}` `` string built as a `Set` key. The header at
`:208` already names this cost — *"tens of millions of template strings on the
main thread"* — and fixed only the row-scan half.

**Do** `columns` is bounded and rows are non-negative, so `row * columns + col`
into a `Set<number>` is exact and allocation-free.

**Guard** Confirm `columns` is in scope and constant for the packer's lifetime
at all four sites. If any site can see a different `columns`, the key collides —
stop and record it.

**Guard** Extend the header at `:208` to say the key half is now fixed too.

---

**Commit C4.** Run the four legs. Then open the app, switch to Mobile, and drag
something — the packer and the fence-resize path are both touched here.

---

# C5 — Costs that grow with the board or the file

Ten tasks. Larger diffs, lower urgency, easy to verify by reading.

### T5.1 — Every descendant element spread into an array, 34 times

**File** `web/assets/js/import/ooxml.ts:67`

**Find** `grep -n "export const byLocal" web/assets/js/import/ooxml.ts`

**Now**

```ts
export const byLocal = (root, name) =>
  [...root.getElementsByTagName('*')].filter(n => n.localName === name);
```

34 call sites, a third of which take `[0]`. Called twice per paragraph in
`slide.ts:399`–`402` and once per shape in `walk()`, so on a large deck it is
the dominant cost of `collect()`.

**Do** `root.getElementsByTagNameNS('*', name)` answers by local name across
namespaces natively — O(matches) rather than O(all elements).

**This is a semantic change and the commit must say so.**
`getElementsByTagNameNS` returns a **live `HTMLCollection`**, not the snapshot
array `byLocal` hands back today. Call sites that only index (`[0]`, `.length`)
are a straight swap. Call sites that iterate or use array methods need a spread.

**Do** Go through all 34 (`grep -rn "byLocal" web/assets/js/import/`) and
classify each before you change the helper. Then either spread inside `byLocal`
(safe, keeps the array, still O(matches) — **prefer this**) or return the live
collection and fix each site.

**Guard** These documents are parsed read-only and nothing mutates the tree
mid-walk, so live-vs-snapshot is safe today. It is still a semantic change.
Say so in the commit message.

---

### T5.2 — 64 MB slurped where a Blob slice would do

**File** `web/assets/js/import/carved.ts:231`

**Now** Reads up to `MAX_PICTURE` = 64 MB into memory and wraps it in a
`new Blob([tiff])`, then hands it to `embeddedPreview()`, which takes a Blob
precisely so it can slice lazily. The module header says *"slice, never
slurp."*

**Do** `file.slice(at, at + size)` is the same Blob at zero cost. The bound is
already checked on the line above.

**Guard** Confirm `at` and `size` are the same values the read used. Do not
remove the bound check — that is a ceiling, and ceilings are not touched by this
plan.

---

### T5.3 — Every stream in the file materialised to read eight bytes of each

**File** `web/assets/js/import/cfbf.ts:336`

**Now** `fromCache()` materialises *every* stream — each one a
`new Uint8Array(length)` plus a chain copy — to read eight bytes of signature
from each. `MAX_FILE` is 96 MB and this is the common path for `.doc`/`.xls`.

**Do** Rank candidates by the `size` the directory entry already holds, sniff
the first sector of each in rank order, and read only the winner in full.

**Guard** `import/cfbf.ts` is a hand-written binary reader that parses files the
app did not write. It bounds-checks before allocating and **that must stay
true**. A change here wants a test that feeds it something broken — add one to
`tests/`.

**Guard** Do not touch the `Oversize` vs plain `Error` distinction anywhere in
this file. `Oversize` means "larger than a number somebody wrote down" and is
liftable; a plain `Error` means the file does not say what it means and is not.

---

### T5.4 — The board and bin walked twice per autosave

**File** `web/assets/js/storage/session.ts:193`–`244`

**Now** `referencedHashes()` walks items and trash for hashes, then builds a
fresh concatenated array of the whole board and bin **again** to read
`meta.was` / `meta.wasCover` — two keys reachable in the first walk. Runs on
every autosave tick, every commit's trailing edge, every explicit Save, and
again in `restoreSession()`.

**Do** Collect all four in the one pass.

---

### T5.5 — Twenty thousand wrapper objects to delete a few items

**File** `web/assets/js/trash.ts:261`

**Find** `grep -n "map((item, index) => ({ item, index }))" web/assets/js/trash.ts`

**Now** `removeItems()` does
`board.items.map((item, index) => ({ item, index })).filter(…)`.

**Do** One loop that pushes only the matches, or a reverse loop that splices.

**Guard** Check whether the resulting order matters to the caller. If it
splices, splice in reverse so earlier indices stay valid.

---

### T5.6 — Seven intermediate arrays per serialize

**File** `web/assets/js/board-schema.ts:534`, `:542`; same shape at `:147`

**Now** Seven intermediate arrays over board plus bin per `serializeBoard()`,
for two id sets that differ only by `isJoinEnd`. `normalizeBoard()` at `:147`
has the same shape on the load path.

**Do** One pass building both sets.

**Guard** The header defends **why the two sets are separate**. That reasoning
stands — you are changing how they are built, not merging them. Two sets out,
one pass in.

**Guard** This file is next to the `.mbrd` schema. Read its header before
touching it and confirm nothing you change alters what is written to disk.

---

### T5.7 — Sorting a whole list to take one element

Three sites, one commit.

- **`import/packages.ts:405`** — fully sorts every page with a comparator that
  re-lowercases and re-tokenises **both** names on every comparison, to take
  `[0]`. A 300-page `.cbz` is roughly five thousand tokenisations to pick one
  cover. **Do** a single linear min-scan, with the tokenisation done once per
  name up front if it is still needed.
- **`arrange/arrangements.ts:111`** — `filter().sort()[0]` **inside a
  comparator**, so the allocation happens O(n log n) times per Mobile reorder.
  **Do** hoist it out of the comparator.
- **`commands/view.ts:108`** — builds two whole arrays to read two lengths.
  **Do** count in one pass.

---

### T5.8 — The whole library index rewritten once per evicted row

**File** `web/assets/js/storage/library.ts:194`

**Now** `trimLibrary()` awaits `removeLibraryBoard` per evicted row, and each
one re-reads, re-sorts and rewrites the entire index. Dropping k boards is k
reads and k writes where one filter and one write would do. Runs on
`shelveCurrent()`, which every Open, New and Switch calls.

**Do** Compute the eviction set, then one read, one filter, one write.

**Guard** The per-row function also deletes the board's payload, not just its
index row. Keep those deletions — only the **index** rewrite collapses.

---

### T5.9 — The optimize plan built twice, and the videos decoded twice

**Files** `web/assets/js/optimize/ui.ts:35`, `:49`;
`web/assets/js/optimize/optimize.ts:344`, `:522`

**Now** `optimize/ui.ts:35` builds a `Plan` for the dialog and `runOptimize`
discards it and builds another. `ui.ts:49` and `optimize.ts:522` both call
`clipsWantingStills()`, each decoding every video cover. The two plans can also
**disagree**, since the board can change between the question and the answer.

**Do** `runOptimize` already takes an options object. Pass the plan the dialog
built.

**Guard** The disagreement is a real behaviour question, not just waste. Decide
deliberately: passing the plan means the run does what the dialog **promised**,
even if the board moved. That is almost certainly right — it is what the user
agreed to — but say so in the commit message.

---

### T5.10 — Eight smaller members of the same family

One commit, or one per site. Each is "the same work done twice".

| file | what |
| --- | --- |
| `import/drop.ts:536` with `:966` | the same 128 KB header slice read and parsed twice per image, up to `MAX_FILES` = 500 per drop |
| `import/preview.ts:231` | `scalar` is `async` with no `await`, awaited six times, and rebuilds a `DataView` per call inside a loop |
| `optimize/optimize.ts:737` | `audioTags` and `coverArt` walk the same container serially for the same `ilst` range |
| `import/containers.ts:907` | `flv()` rescans up to 256 KB three times for three fields |
| `import/carved.ts:339` | three full copies of a vCard to find one line |
| `ui/documents.ts:376` | `childOf` run twice per flag, four flags per text run |
| `ui/hud.ts:298` | the whole board reduced, then discarded on the single-selection branch |
| `ui/fonts.ts:638` | the font file read and walked twice, where the second answer is only consulted when the first is empty |

**Guard** Four of these are in hand-written binary readers (`preview.ts`,
`containers.ts`, `carved.ts`, and `optimize.ts`'s container walk). All
bounds-check before allocating. Keep every bounds check exactly as it is, and
add a test that feeds the reader something broken.

**Guard** `ui/documents.ts` must not touch `innerHTML` — it reads foreign
documents and builds trees with `createElement`/`createTextNode` only.

---

**Commit C5**, or several. Run the four legs at the end.

---

# C6 — The fixed-point walk, six copies

**One task. This is the largest change in the plan and the one most reasonable
to decline.** Read the argument at the end of the audit before starting. If the
answer is "not now", mark it `DECLINED` in the checklist and go to C7 — nothing
else depends on it.

**T4.3 must be done first.**

### T6.1 — One `followers()` for four of the six

| | |
| --- | --- |
| `sticky.ts:556` | `attachRiders<T>` — generic, exported, three callers in `layout.ts` |
| `sticky.ts:597` | `stuckFollowers` |
| `fences.ts:478` | `fenceFollowers` — near-verbatim, same reverse-splice, same comment shape |
| `trash.ts:77` | `stickerCascade` |
| `ui/board-actions.ts:826` | hand-rolled, fences |
| `ui/board-actions.ts:853` | hand-rolled, riders — near-verbatim of `attachRiders` |

**Do** One `followers(pool, seed, parentOf)` covering the middle four.

**The `trash.ts:77` case.** Its header argues at length that the naive
*"`stuckFollowers()` then filter"* is wrong, because a sticker on a note on a
deleted photograph must stay. That argument is entirely about **which items are
in the pool** — so the pool predicate carries it and the documented subtlety
survives. Move that paragraph to the shared helper as the reason the predicate
is a parameter.

**The two `ui/board-actions.ts` copies.** They cannot call `attachRiders` as it
stands: that helper hands its `build` callback the **live** host, and
`board-actions` needs the host's **pre-move geometry from a snapshot**. Folding
them in means widening the callback — an API change to a helper with three
existing callers in `layout.ts`. Do that deliberately, in this commit, and check
all three callers.

**Guard** Four of the six copies are correct, tested and stable. The argument
for doing this is not line count. It is that `ui/board-actions.ts` grew its
copies by transcription and inherited a bug `sticky.ts` had already fixed and
documented — which is what a seventh copy will do too.

**Guard** `sticky.ts` and `fences.ts` sit **below** `canvas/` in the layering
graph. The shared helper must live at or below their level. `tests/layers.test.js`
enforces this and its `DEBT` map may only shrink.

**Done when** `npm test` passes, and `grep -c "grew = true" web/assets/js/**/*.ts`
has dropped by at least three.

---

# C7 — Duplication and dead code

Ten tasks. Least urgent, most abandonable. Safe to stop partway — just record
where.

### T7.1 — Two duplicated constants with the hazard written on them

**Files** `web/assets/js/canvas/items.ts:206`, `web/assets/js/canvas/web.ts:981`

**Now** The same `cullMargin` one-liner with both constants duplicated.
`items.ts:196`–`205` says outright: *"this copy had drifted away from it …
Change one and change the other."*

**Do** Export it from `viewport.ts`, which both already import. Move the comment
with it.

**Also** `canvas/renderers.ts:1692` re-spells `gridStep > 0 ? gridStep : 64`
against `layout.ts:487`'s explicit warning that *"a second copy … in another
file is how the two would come to disagree."* `renderers.ts` already imports
from `state.ts`, which re-exports `baseStep` at `:216`. **One word in an existing
import.**

---

### T7.2 — The `contentEditable` fallback, three times

**Files** `canvas/items.ts:1183`, `canvas/notes.ts:639`, `ui/board-title.ts:216`

**Now** The `contentEditable = 'plaintext-only'` fallback, three lines and an
identical comment, three times.

**Do** One `makeEditable(el)` helper.

**Guard** `canvas/` and `ui/` are different layers. The helper must go
somewhere both may import — check `tests/layers.test.js` before choosing.

---

### T7.3 — The select-all-contents range dance, five times

**Files** `canvas/items.ts:1234`, `canvas/notes.ts:276`, `ui/board-title.ts:240`
(collapse-to-end variant) and `:308`, `ui/mobile-header.ts:751`

**Now** Five sites, each carrying its own copy of the `getSelection()!`
justification.

**Do** Two helpers: `selectContents(el)` and `caretToEnd(el)`. Same layering
guard as T7.2.

---

### T7.4 — Fisher-Yates, three times

**Files** `util.ts:86` `shuffle`, `arrange/arrangements.ts:985` `shuffleWith`
(identical but for the RNG source), and inlined again at
`canvas/playlist-queue.ts:286` beside `mulberryLike()`, which is a one-line
forward to `Math.random`.

**Do** `export function shuffle<T>(arr: T[], rnd = Math.random)` in `util.ts`
serves all three.

**Also** `web-graph.ts:427` `clampi` re-declares `util.ts:45` `clamp`. Check
whether `clampi` rounds — if it does, keep it and say so in a comment; if it
does not, delete it.

---

### T7.5 — Five hand-written copies of one SVG block

**Files** `ui/feed.ts:1142`, `ui/trash.ts:241`, `ui/sticker-window.ts:319`,
`canvas/renderers.ts:1367`

**Now** `stickers/catalogue.ts:41` already says *"five places build a
`<svg class="sticker-art">` around a `<use>` … five literals is five chances for
one of them to be left behind"* — and then shares only the `viewBox` constant.

**Do** Finish the job the comment started: share the builder, not just the
constant.

**Guard** An icon is a `<symbol>` in `web/assets/icons.svg` referenced by name,
and **a misspelled id fails silently on screen**. `tests/icons.test.js` is what
catches it, in both directions. Run it.

---

### T7.6 — Six private copies of create-element-with-class

**Files** `ui/panel.ts:90`, `ui/documents.ts:169`, `ui/sound-lab.ts:65`,
`ui/feed.ts:1270`, `ui/playlist.ts:1343`, `ui/sticker-window.ts:511`

**Do** One shared helper in a `ui/` module they all already import.

**Guard** `ui/sound-lab.ts` is part of the **sound lab bundle**
(`npm run dev:sound`), which is a bench and not a page of the site. It has its
own bundle and none of `tokens.css`. Do not make it depend on something that
drags the app's cascade into the bench. If in doubt, leave `sound-lab.ts`'s copy
alone and say why.

---

### T7.7 — The role+tabIndex+click+key block, five times

**Files** `ui/feed.ts` and `ui/playlist.ts`

**Do** One helper.

**Also** `ui/menu.ts:1964` exports `icon()` **precisely so others can borrow
it**, and `ui/timeline-view.ts:598` re-spells it byte for byte while already
importing `openAnchored` from that module. One word in an existing import.

---

### T7.8 — Four per-file duplications

| file | what |
| --- | --- |
| `canvas/grid.ts:614` and `:933` | the same `ensureCanvas` twice |
| `import/artwork.ts:461`/`:489` | the same FLAC block walk twice |
| `import/artwork.ts:565`/`:611` | the same `moov → udta → meta → ilst` descent twice — the file's own comment calls the version/flags skip *"the one irregular step"*, and it is written twice |
| `web-graph.ts:204` and `:316` | two copies of one uniform spatial hash, ~50 lines |

**Guard** `import/artwork.ts` is a hand-written binary reader. Bounds checks
stay exactly as they are.

---

### T7.9 — Dead code, verified

Verified against `tests/`, `tools/` and both lab bundles. **Re-verify each one
with rule 4 before deleting.**

- `cuelume/engine.ts:812` `playVoice`
- `cuelume/recipes.ts:268` `isSoundName`
- `import/budget.ts:169` `resetByteBudget`
- `sticky.ts:421` `forgetSticks` and `fences.ts:254` `forgetFences`, with their
  four re-exports in `state.ts`
- eleven pass-through re-exports at `canvas/renderers.ts:44` — **keep the three
  that `tests/renderers.test.js` anchors on**
- `ui/settings-schema.ts:1027` `resetQuality`
- `ui/documents.ts:217`'s `head` option, never passed by any of five call sites
- `tools/gen-formats.mjs:86`'s `slug`, written and never read

**Never delete** `util.ts:331` `isDev()`. Its header says it stays.
`tests/sw.test.js:282` reads `util.ts` as **text**.

**Guard** `tools/gen-formats.mjs` generates `import/formats.ts`. After editing
it, run `node tools/gen-formats.mjs` and confirm the generated file is
**unchanged** — if it changes, you have altered a generated catalogue and that
must be reported explicitly.

---

### T7.10 — Two symbols to inline, and three classes with no rule

**Inline** `import/cfbf.ts:317` `pictureFrom()` — its stated reason (looking the
summary stream up once) is not real, because the caller does the lookup and
passes it in. See T2.3.

**Three classes set in JS with no rule in `web/assets/css`:**
`ui/menu.ts:1579` `is-toggle`, `ui/playlist.ts:653` `is-single`,
`ui/timeline-view.ts:577` `is-sealed`.

**`is-sealed` is not a simple deletion.** Its comment claims *"a square dot for
a step that carries a difference, a round one for a step that carries a rule"* —
and only `.is-ruled` has a rule, so the distinction the comment describes does
not exist on screen. That is either a missing CSS rule or a wrong comment.
**Do not guess.** Record it as a question for the repo's owner and leave the
class in place.

`is-toggle` and `is-single` may be deleted.

**Guard** Class names are often built by interpolation (`web-c-${color}`,
`note-${tag}`). Before deleting any class, grep for its **suffix** as well as
its whole name.

---

**Commit C7.** Run the four legs.

---

## Two questions this plan does not answer

Both belong to whoever owns the repo. If you hit them, record and move on.

**1. `state.ts:511` `setItemText()` — delete it or document it?** It has no
caller outside `tests/state-items.test.js`. Note editing goes through
`setNoteContent()` (`:577`), which caps `NOTE_MAX`, keeps `meta.rich` in step
and re-derives `noteName()`. `setItemText` does the first and third and leaves
`meta.rich` stale — so calling it on a rich note produces exactly the desync
`storage/mbrd.ts:810`–`821` describes. Either fold its two assertions into the
`setNoteContent` tests and delete it, or keep it and say in its header that it is
the non-rich door. It is **exercised** by a real test rather than merely named by
one, which is why this is a question.

**2. Is C6 wanted at all?** See the guard on T6.1.

---

## Things this plan will not touch, deliberately

Do not "fix" any of these. Each was looked at and left alone on purpose.

1. **`util.ts:331` `isDev()`** — test anchor.
2. **`board.settings` and `board.arrangement` stay hand-synced caches.**
   Derived from `board.layoutSettings[mode]` / `board.arrangements[mode]` and
   written from three modules. `layout.ts:923` calls them *"the live
   compatibility surface"* and drag paths read `board.settings` hot. Debt, not
   scheduled.
3. **`import/` keeps its per-file byte primitives.** `le32`/`be32`/`le16`/`bytes`
   are duplicated across six modules and four of those headers explicitly argue
   against a shared low-level module.
4. **No bounds check, ceiling, or `Oversize`/`Error` distinction is touched by
   anything above.** `mesh.ts:865`'s redundant-looking `count > elemCap` stays:
   it is arithmetically subsumed by `:875`, but the two throws quote different
   numbers and `tests/mesh.test.js:568` matches on message text.
5. **`canvas/input.ts` is not split**, the `viewport.ts` LOD wrappers stay, and
   `ui/menu.ts` remains the only menu implementation.
6. **`sticky.ts:243` `wouldStick()`** is a full board scan called from
   `canvas/input.ts:2371` on every pointermove of a note drag. It is a real cost,
   but there is no direct answer already in hand and `sticky.ts` sits below
   `canvas/` so it cannot reach `canvas/spatial.ts`'s index. Architectural, and
   outside this plan.

---

## Checklist

Mark each as `DONE`, `SKIPPED — <reason>`, or `DECLINED`.

| | task | status |
| --- | --- | --- |
| T1.1 | palette readout tests `Infinity` | |
| T1.2 | 96 blob URLs minted and unread | |
| T1.3 | two stale `Infinity` comments + dead branch | |
| T1.4 | six leaked window listeners per open | |
| T1.5 | `clearQueue()` leaves `error` handler | |
| T1.6 | feet-and-inches unit branch | |
| T1.7 | submenu announces its own shortcut | |
| T1.8 | `onCancelEvent` cannot do anything | |
| | **commit C1 + four legs** | |
| T2.1 | delete the reversed `optimize.ts` paragraph | |
| T2.2 | seven doc blocks on the wrong declaration | |
| T2.3 | two docstrings claiming a caller | |
| | **commit C2 + four legs** | |
| T3.1 | 60 aria writes a second | |
| T3.2 | two board walks per pointermove + `cardOf` | |
| T3.3 | layout + context forced per turn frame | |
| T3.4 | note resize re-derives its inputs | |
| T3.5 | `find` per drag frame | |
| T3.6 | `byId` twice per moved item | |
| | **commit C3 + four legs** | |
| T4.1 | five `JSON.stringify` comparisons | |
| T4.2 | `includes` in a growing loop | |
| T4.3 | `byId(host.id)` on a live host | |
| T4.4 | board walked twice for the palette key | |
| T4.5 | `Math.hypot` taken only to compare | |
| T4.6 | template strings as `Set` keys | |
| | **commit C4 + four legs** | |
| T5.1 | `byLocal` spreads every descendant | |
| T5.2 | 64 MB slurped instead of sliced | |
| T5.3 | every CFBF stream materialised | |
| T5.4 | board and bin walked twice per autosave | |
| T5.5 | 20 000 wrappers to delete a few items | |
| T5.6 | seven arrays per serialize | |
| T5.7 | sort-to-take-one, three sites | |
| T5.8 | library index rewritten per evicted row | |
| T5.9 | optimize plan built twice | |
| T5.10 | eight smaller same-work-twice sites | |
| | **commit C5 + four legs** | |
| T6.1 | one `followers()` for four copies | |
| | **commit C6 + four legs** | |
| T7.1 | `cullMargin` and `baseStep` duplicated | |
| T7.2 | `contentEditable` fallback ×3 | |
| T7.3 | select-contents range dance ×5 | |
| T7.4 | Fisher-Yates ×3, `clampi` | |
| T7.5 | sticker SVG block ×5 | |
| T7.6 | create-element-with-class ×6 | |
| T7.7 | role+tabIndex block ×5, `icon()` | |
| T7.8 | four per-file duplications | |
| T7.9 | dead code | |
| T7.10 | inline `pictureFrom`, three classes | |
| | **commit C7 + four legs** | |

---

## When you are finished

Report, in this order:

1. Which tasks are `DONE`, `SKIPPED` and `DECLINED`, and why for each of the
   last two.
2. **Any `.mbrd` schema, generated-catalogue or service-worker cache change.**
   There should be none. If there is one, say so first and loudly.
3. Whether all four verification legs pass.
4. The two open questions above, if you reached them.

Do not push.
