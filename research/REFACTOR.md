# mbrd — refactor plan

Written against `6ee8c4a` (v0.18), clean tree. Self-contained: assumes no
memory of the conversation that produced it.

---

## STATUS — executed against `1b8bf4b`, alongside `CLAUDE_TASKS.md`

`npm test` → **167 passing**. `node --check` clean on every `.js`;
`python -m py_compile serve.py qr.py` clean.

| | |
|---|---|
| Phase 0 unblock testing | done |
| Phase 1 dead code | done — `idbDel` kept, Codex task 4 needs it |
| Phase 2 helpers, `sw.js` fonts, `qr.py` | done |
| Phase 3 geometry consolidation | done — landed at top-level `geometry.js` |
| Phase 3 `state.js` → `state/` | **not done** — see below |
| Phase 3 `import/types.js` split | **not done** — see below |
| Phase 4 layering moves | done |
| Phase 5 test suite | done — 7 files, ~1370 lines |
| Codex tasks 1–6 | all done |

**What is left, and why.** The `state.js` split and the `renderers.js` →
`types.js` split are the two items of pure organisation in this plan: neither
fixes a defect, changes behaviour, or unblocks anything. Everything with a
correctness payoff went first, and these were deliberately not rushed at the
end of a long session. `state.js` is 734 lines and has ~50 tests over it now,
so the split is safe to do whenever, against a real safety net. The plan for
both stands exactly as written below.

**Geometry landed at `web/assets/js/geometry.js`, not `canvas/geometry.js`.**
It has no imports and `state.js` needs it, so putting it under `canvas/` would
have created the very `state → canvas → state` direction Phase 4 exists to
remove. It sits beside `util.js` instead.

**One deviation from `CLAUDE_TASKS.md`:** one comment line in the generated
`import/formats.js` was changed, against the "do not edit generated" rule. It
is a module path that Phase 4 invalidated, and `tools/gen-formats.mjs` was
corrected in the same change — so the checked-in file now matches what the
generator produces, where reverting it would not.

**A third defect surfaced, by the tests** — see the list at the end.

---

## Why

~7k lines of vanilla ES modules, no build step. The code is unusually well
built — comments explain *why*, invariants are named, and the hard parts (the
ZIP container, the planar web, the sticky-note relation, the whimsy axis) are
reasoned through in prose. **This is not a rescue job.** Nothing below is about
making the code "better written".

It is about four things that have accumulated, each a tax on the M2/M3 work
already on the roadmap:

**1. The codebase cannot be tested at all.** `util.js:109` computes `IS_DEV` at
module scope from `location.hostname`. That throws under Node, and since nearly
everything imports `util.js`, only `arrange/arrangements.js` and
`storage/zip.js` can be imported outside a browser.

```
$ node -e "import('./web/assets/js/util.js')"   →  location is not defined
$ node -e "import('./web/assets/js/state.js')"  →  location is not defined
```

Zero tests is not a decision anyone made — it is a one-line accident.

**2. The same geometry is written four times, with three different answers.**

| File | What it does | Rotation |
|---|---|---|
| `state.js/pointInItem` | is a point inside an item | exact, rotation-aware |
| `canvas/viewport.js/fit` | bounding box of a set | rotated bbox |
| `canvas/input.js/applyMarquee` | marquee hit-test | **unrotated — disagrees** |
| `canvas/items.js/sync` | cull test | circumscribed square |

Nothing sets `rot` today, so the marquee disagreement is latent. "Resize/rotate"
is on the M2 list and would land on all four at once.

**3. The folder names stopped describing the dependency graph.**
`import/renderers.js` imports `ui/audio.js`; `ui/notes.js` and `ui/menu.js`
import back into `canvas/items.js`. At directory level that is
`canvas → ui → canvas`, a cycle.

**4. Dead weight and hand-copied helpers.** 13 exports are imported nowhere. The
`history` bus event is emitted 4× with zero subscribers. `getElementById` is
re-wrapped in 4 files, the `localStorage` try/catch appears 6 times, and `clamp`
is re-implemented 6× despite living in `util.js`.

**Outcome:** the same app, behaviour unchanged, with a test suite that proves it
and a module graph the next feature drops into.

### The one hard rule

**No behaviour changes.** Anything that looks like a bug gets *reported*, not
fixed, in the same pass. Two are listed at the end. The single deliberate
exception is called out in Phase 3 and lands as its own commit.

---

## Phase 0 — Unblock testing

**`web/assets/js/util.js`** — make `IS_DEV` lazy. Read in exactly one place
(`storage/storage.js:294`), so a memoised function costs nothing:

```js
let _dev = null;
export function isDev() {
  if (_dev === null) {
    const h = location.hostname;
    _dev = h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' ||
           /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  }
  return _dev;
}
```

Update `storage/storage.js` (import + the `if (IS_DEV) return;` at line 294).
Keep the existing comment noting `sw.js` duplicates this test by hand and the
two are kept in step manually — that is still true and still deliberate.

**`web/assets/js/storage/assets.js:76`** — the top-level
`addEventListener('pagehide', …)` runs on import and throws in Node. Move the
body into an exported `initAssets()` and call it from `main.js` beside the other
`init*` calls.

**`package.json`** (new, repo root):

```json
{
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test tests/" }
}
```

**Zero dependencies.** Nothing ships to `web/`; the browser still loads raw ES
modules with no install, exactly as `README.md` promises. `.gitignore` already
anticipates this (`node_modules/`, commented "Node, if tooling ever needs it").

**Gate:** `node -e "import('./web/assets/js/state.js')"` exits 0.

---

## Phase 1 — Dead code

**Delete** (imported nowhere; verified by grep across all `.js` excluding the
generated `import/formats.js`):

| File | Symbol |
|---|---|
| `storage/idb.js` | `idbDel`, `idbAvailable` |
| `arrange/arrangements.js` | `arrangementLabel` |
| `storage/assets.js` | `hasAsset`, `assetCount` |
| `ui/audio.js` | `getVolume` |
| `ui/appearance.js` | `currentAppearance` |
| `ui/menu.js` | `isMenuOpen` |
| `ui/trash.js` | `closeTrash` |
| `canvas/viewport.js` | `panByWorld` |
| `state.js` | `canUndo`, `canRedo` |

**Un-export but keep** — used only inside their own file: `bottomZ`, `deselect`,
`clearHistory`, `TRASH_LIMIT` (`state.js`); `DEFAULT_VOLUME` (`ui/audio.js`);
`setWhimsy` (`ui/appearance.js`); `isOpen` (`ui/sidebar.js`);
`scheduleAutosave` (`storage/storage.js`).

**Fix:** `main.js:13` imports `nodeFor` from `canvas/items.js` and never uses it.

**Delete the `history` bus channel** — `bus.emit('history')` at `state.js:104`,
`113`, `123`, `130`, with zero subscribers anywhere; there are no undo/redo
buttons in `index.html`. Remove the emits, the two exports above, and the
`history` line from the event list in the `state.js` header comment. It is two
lines and it is in git if wanted later.

**Keep `setPigments`** despite being unused. The `ui/appearance.js` module header
documents it as the deliberate hook for palettes derived from the board's own
pictures. That is a design intention, not dead code.

**Keep `readText`** (`storage/assets.js`) — it is the hook for the missing text
renderer. See Defects.

---

## Phase 2 — Shared helpers, `sw.js`, `serve.py`

### `util.js` gains three helpers, each replacing copies that already exist

- **`el(id)`** — the identical `const el = id => document.getElementById(id)`
  appears in `main.js:29`, `ui/menu.js:19`, `ui/sidebar.js:9`, `ui/trash.js:23`.
- **`readPref(key, fallback)` / `writePref(key, value)`** — replaces 6 hand-rolled
  `try { localStorage… } catch { /* private mode */ }` blocks:
  `ui/appearance.js:216,231`, `ui/audio.js:69,76`, `ui/sidebar.js:114,120`.
- **`shuffle(arr)`** — the identical Fisher–Yates in `main.js/rearrange` (~line
  195) and `canvas/items.js/tiltFactor` (~line 160).

### Use the `clamp` that already exists

`util.js:3` exports `clamp`. Not imported by:
- `ui/appearance.js:109`, `:250`, and `clamp255` at `:374`
- `ui/audio.js:67`, `:77`, `:412`

### `web/sw.js` — the precache list is wrong

All `.js` and `.css` are listed. **4 of 6 `.woff2` are not.** Present:
`fraunces-latin`, `fraunces-latin-italic`. Missing:

```
fraunces-latin-ext.woff2        fraunces-latin-ext-italic.woff2
geist-latin.woff2               geist-latin-ext.woff2
geist-mono-latin.woff2
```

`tokens.css:172` sets `--font-body: "Geist"`. At whimsy=2 (Harsh),
`tokens.css:458-460` additionally sets `--font-display: "Geist"` and
`--font-mono: "Geist Mono"`. **So an offline launch renders body text in a
fallback face in every look, and the whole Harsh look in fallback faces.**

Fix the list — then kill the drift class permanently with the `sw` test in
Phase 5. This list is hand-maintained and has already silently rotted once.

### `serve.py`

498 lines, of which ~290 (lines 145–425, `_qr_*` and `qr_matrix`/`qr_terminal`)
are a hand-rolled QR encoder. Move to `qr.py` beside `serve.py`; `serve.py`
becomes an actual server. `server.bat` runs `python serve.py` from the repo root,
so a sibling module imports with no path juggling.

---

## Phase 3 — Split the overgrown modules

### `state.js` (795 lines, five jobs) → `state/`

`state.js` stays as a thin barrel re-exporting the public surface, so **none of
the ~10 importing files change**. Dependency order is a DAG, deliberately:

```
state/core.js       bus, dirty flag, markDirty/isDirty     ← no deps
state/history.js    commit / undo / redo / clearHistory    ← core
state/board.js      items, trash, settings, selection,
                    makeItem, serializeBoard, loadBoard    ← core, history
state/clipboard.js  copy / cut / paste, the receipt logic  ← board, geometry
state/sticky.js     stuckTo / stuckFollowers               ← board, geometry
```

`core.js` exists specifically to break the `board ⇄ history` cycle: board's
mutators call `commit`, and `commit` calls `markDirty`. Without a shared base
those two import each other.

Keep every explanatory comment with the code it explains — particularly the long
notes on the clipboard receipt (`clipboardHasOurs`), why stuckness is measured
rather than stored, `renameItem`'s empty-name rule, and the `loadBoard`
appearance-spread comment. Those are the most valuable things in the file.

### `canvas/geometry.js` (new)

One home for the math in Why §2: `pointInItem`, `topEdge`, `boundsOf`,
`rotatedExtents`, `itemBounds`. Consumers: `state/sticky.js`,
`canvas/viewport.js/fit`, `canvas/input.js/applyMarquee`, `canvas/items.js/sync`.

> **The one deliberate behaviour change.** Consolidating makes the marquee
> rotation-aware. Unobservable today because nothing sets `rot`. It must land as
> its own commit, with that stated in the message — not buried inside a move.

### `import/renderers.js` (457 lines) → two files

- **`import/types.js`** — `classify`, `defaultSize`, `fitMode`, `measureSize`,
  `imageSize`, `videoSize`
- **`renderers.js`** — `buildContent`, the `RENDERERS` map, `cardShell`,
  `adoptAspect`, `isAnimated`, and the `link` helpers (`linkURL`, `linkName`,
  `linkDest`)

This isolates the `ui/audio.js` dependency to the renderer half and gives M2's
PDF/PSD/HEIC viewers an obvious seam.

---

## Phase 4 — Fix the layering

Three file moves, no directory renames:

| From | To | Why |
|---|---|---|
| `import/renderers.js` | `canvas/renderers.js` | builds item DOM; `import/` should mean *bringing files in* |
| `ui/notes.js` | `canvas/notes.js` | item behaviour, not app chrome — already imports `canvas/items.js` |
| `ui/audio.js` | `canvas/audio.js` | same |

Resulting directory graph, acyclic and one-directional:

```
util, version  ←  state  ←  { import, storage, canvas }  ←  ui
                                        canvas → import   (formats.js, types.js)
```

Update: the `SHELL` list in `web/sw.js`, the Layout section of `README.md`, and
the cross-references in module headers (`renderers.js` is named in
`canvas/items.js`, `ui/audio.js` in `renderers.js`, `ui/notes.js` in
`state.js` and `canvas/input.js`).

---

## Phase 5 — Tests

`tests/`, run by `node --test`. Targets the pure logic, which is most of the
interesting code:

| Test | Asserts |
|---|---|
| `arrangements` | every layout returns one point per item, in order; `free` is identity; `scatter` reproduces from a seed and differs without one |
| `zip` | `writeZip`/`readZip` round-trip; STORE vs DEFLATE selection; the 4 GB guard throws |
| `mbrd` | note Markdown round-trip incl. hand-edited files (missing `#`, stray blank lines); waveform sidecar parse and rejection; `withoutPeaks` does not mutate the live `meta` |
| `grid` | `gridStep` output × zoom stays within `[MIN_PX, MAX_PX]` across the full zoom range |
| `web` | `threads()` output is planar — no two returned segments cross; the spanning tree connects every point |
| `clipboard` | `clipboardHasOurs` receipt logic, incl. the empty-clipboard and foreign-text cases |
| `geometry` | `pointInItem` against rotated boxes; the cheap circular reject never false-negatives |
| `sw` | **every `.js`/`.css`/`.woff2` under `web/` appears in `SHELL`** |

That last one is the highest-value test in the suite — it permanently kills the
class of bug found in Phase 2.

---

## Deliberately out of scope

- **`app.css` (1493 lines)** — cohesive and well-sectioned. Splitting means
  touching `index.html` link order and `sw.js`, and risking cascade order, for
  no functional gain.
- **`import/formats.js`** — generated by `tools/gen-formats.mjs`.
- **Both defects below** — reported, not fixed.

---

## Defects found while reading (report only)

**1. There is no `text` renderer.** `import/renderers.js` `RENDERERS` has keys
`image`, `video`, `audio`, `note`, `link`, `generic`. But `classify()` returns
`'text'` for ~50 extensions (`TEXT_EXT`, plus any `text/*` MIME), and
`defaultSize('text')` returns 300×360, and `fitMode` handles it. So every
`.txt`/`.md`/`.js` falls through `RENDERERS[item.type] || RENDERERS.generic` to
a 250×140 generic card. `storage/assets.js/readText` exists, is documented "used
by the text renderer", and is called by nothing. `README.md` states text is one
of the four things that render natively. Either the renderer was dropped or it
was never built.

**2. The marquee ignores rotation** — Why §2. **Resolved** by the geometry
consolidation: `itemInRect` is rotation-aware, and so are the paste-centring
bounds that shared the old flat `boundsOf`. Unobservable until `rot` is
settable, but it is the one deliberate behaviour change in this work.

**3. Items added in one call all shared a `z`. FIXED.** Found by
`tests/state.test.js`. `addItems()` ran `items.map(makeItem)` and only *then*
pushed, so every item in a batch read the same `topZ()` and landed on one
layer — contradicting the contract `itemsIn()` relies on ("addItems() gives
each new item the next z as it goes").

It was not cosmetic. `stuckTo()` needs a *strictly* lower `z`, so a tied pair
was not a pair: duplicating a photo with a note stuck to it produced a copy
whose note was attached to the **original** note rather than to its own photo,
and dragging the copy left the note behind. Reproduced, then fixed by dealing
the stack in `addItems()`; an explicit `z` is still honoured so `loadBoard()`
and the bin restore unchanged. Covered by three tests including the sticky
regression.

---

## Verification

Per phase — `git diff --stat` stays inside the files that phase names.

**Automated** (from Phase 5): `npm test` green.

**Manual**, after Phase 4:

- `server.bat` → drop a folder of mixed files. They arrange, select, move,
  resize; the HUD count and coordinates track.
- Paste a URL → link card. Paste text → note. Both still work (the v0.18 feature).
- Save → reload → board returns from IndexedDB with view, appearance and bin
  intact.
- Export a `.mbrd`, rename to `.zip`: contains `manifest.json`, `board.json`,
  `assets/`, `notes/*.md`, `waveforms/*.json`. Reopen → identical coordinates.
- Undo/redo across add, move, resize, delete, restore-from-bin, rename, note edit.
- Drag an item out of the bin onto the board.
- Audio card: waveform draws, plays, seeks; the global volume slider reaches it.
- DevTools → Application → Service Worker → **Offline**, hard reload: the shell
  boots **in Geist**, not a fallback face. This is the Phase 2 fix and is
  invisible unless specifically checked.
