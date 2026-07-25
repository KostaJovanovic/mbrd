# Handoff — 2026-07-25

For whoever picks this up next. Written by the session that did the JavaScript
while a second session did the CSS.

Read `AGENTS.md` first for structure, commands and style — none of that is
repeated here. This document is only the *state of the work*: what moved, why it
moved that way, what will bite you, and what is left.

---

## 1. Where things stand

`HEAD` is `58b3337 Find on the board (Ctrl+K)`. Everything described below is
committed **except** the last of the cover-picture work:

```
 M web/assets/js/canvas/renderers.js    the cover <img> on a card
 M web/assets/js/import/drop.js         the cover picker + album-art hookup
 M research/roadmap.md                  handover notes for the CSS session
?? web/assets/js/import/artwork.js      ID3v2 / MP4 / FLAC art parser
?? tests/artwork.test.js                16 tests for it
```

`npm test` → **238 passing, 0 failing.** Every `.js` under `web/` passes
`node --check`; `serve.py` and `qr.py` pass `py_compile`.

**None of it has been run in a browser.** That is the single most important
sentence in this document. See §6.

---

## 2. What changed, and why

Grouped by the reasoning you cannot get from the diff.

### The zoom ladder is one rung

`FAR_ZOOM` and `STILL_ZOOM` are both `0.4` (were `0.35` and `0.3`). Two
thresholds four hundredths apart were not perceivable as two, and they made
"zoomed out" mean something slightly different depending on which module asked.

The part that is easy to undo by accident: **the comparisons had to be made to
agree as well.** `viewport.js` used `z < FAR_ZOOM` and `stills.js` used
`zoom <= STILL_ZOOM`, so equal constants with unequal operators would still
have split at exactly 0.4 — chrome up, pictures frozen. `stills.js` is now `<`.
`tests/layout.test.js` asserts the two constants are equal; there is no test for
the operators, so keep them in step by hand.

### Rearrange varies the slots, not just the items

The complaint was that "Rearrange everything" gave back the same shape with the
cards swapped. The cause was not what the roadmap said: `main.js` was *already*
passing a fresh seed, and `scatter` was the only layout that read it.

All seven read it now, and each varies in the way its own identity survives —
grid takes a quarter turn (a full ring maps onto itself, so what moves is the
unfinished ring), spiral takes a phase, masonry / date / type-blocks reflow
their column count, free shakes. Unseeded, every layout is still exactly the
pure function it was, which is what keeps an import reproducible.

Two things I measured rather than assumed, and you should re-measure if you
change any of it:

- **Distinct shapes over 12 seeds**, at n = 7 / 17 / 40. `masonry` and `date`
  first came back at 3 — base ±1, which makes Rearrange a toggle between two
  layouts. That is why `COL_STEPS` is `[-2, -1, 1, 2]` and never `0`.
- **Overlapping pairs.** No layout overlaps items that did not before.
  `scatter` overlaps and always did; `free` may, deliberately.

`free` is the judgement call worth revisiting. It shakes each item ~half its own
size *in place* rather than collecting the board into a disc, because gathering
would make it `scatter` under a second name and would destroy the arrangement
you made by hand. Two consequences: `rearrange()` skips `vp.fit` for `free`
only, and the menu label changed from `Free (keep positions)` to
`Free (no layout)` because it no longer keeps them.

### The Harsh grid draws real crosses

This is the change most likely to surprise you.

It was two elliptical gradients — an arm and its transpose. An ellipse 10px long
and 1.7px thick keeps barely 40% of its thickness at 90% of its length, so both
arms tapered to points and the mark read as a smudge with a bright middle. No
gradient can bound a rectangle on both axes: a linear one is unbounded on the
second axis and gives ruled lines through every tile, a radial one with two
radii *is* an ellipse. So the tier stopped using gradients.

Each mark is now one SVG polygon — twelve corners, square ends, single fill, so
there is no seam where the arms cross to double the alpha.

**The cost, and the trap.** A data URI cannot contain `var()`, so at Harsh the
colours and the dot size are resolved with `getComputedStyle` and baked in. Two
things follow:

1. `--grid-major`, `--grid-minor` and `--grid-dot` no longer restyle the mark
   for free. `resetGridInk()` is exported from `canvas/grid.js` and called from
   three places in `main.js`: `initAppearance({ onChange })`, `bus.on('settings')`
   when the key is `'appearance'`, and `bus.on('board:load')`. **If you add a
   fourth route that changes those tokens, the crosses will not notice.**
2. The URI bakes in the tile size, so it is rebuilt whenever the tile changes —
   every frame of a zoom, though *not* of a pan, where only `background-position`
   moves. Memoised on the tile rounded to a tenth of a pixel (`background-size`
   stays exact, so the lattice does not drift). Only this tier pays it; Softish
   and Middle are still two gradients that never enter that path.

If zooming is janky at Harsh on a phone, that is where to look first.

### Save always answers

`saveBoard()` already toasted on success. The hole was failure: it returned
silently on the grounds that `autosave()` "has already said why", but `autosave`
suppresses that message after the first one — it fires after every edit and
would otherwise hold a red toast up all session — and once `cacheOk` has gone
false it returns before saying anything at all. So pressing Save on a board that
could not be saved did nothing visible.

There is now a module-level `lastFailure` string, set on every failure path,
cleared on success and by `newBoard()`. A background save still suppresses; an
explicit press always reports.

### Copy / cut / paste say so

`state.js` gained three toasts. Two notes:

- `cutItems` called `copyItems`, so the naive version fired two toasts a frame
  apart and you would only ever have seen the second. The copy itself is now an
  internal `take()`; each of the three says one thing.
- `toast()` in `util.js` gained `if (typeof document === 'undefined') return;`.
  `state.js` is imported by tests that have no DOM, and without the guard this
  fails a dozen existing tests with a `ReferenceError` nowhere near its cause.
  Same bargain `isDev()` in that file already makes.

### Paste under the cursor

`input.js` tracks `hover` (mouse and pen only — a finger that is not down is not
anywhere), records `copiedFrom = hover` on copy and cut, and `pasteAt()` returns
the cursor's world point when it has moved more than 24 screen px since. Touch
and keyboard-only paths keep the old behaviour, because `hover` stays null.

`pasteAt` lives inside `initInput` and needs a DOM, so it has no unit test.

### A picture on any card, and album art to fill it

Two roadmap items that are really one feature: `item.meta.cover` holds a content
hash, and any card that is not itself a picture can carry one.

- **Set by hand** from the context menu (`Set a picture…` / `Change picture…` /
  `Remove picture`), undoable, deduped like every other asset.
- **Set automatically** for audio, from the file's own tags —
  `import/artwork.js` parses ID3v2 (v2.2/2.3/2.4, including tag- and
  frame-level unsynchronisation and UTF-16 descriptions), the MP4 atom tree, and
  FLAC metadata blocks. No dependency, the way `storage/zip.js` is no
  dependency. Everything is read through `Blob.slice()` — an album is routinely
  40 MB of audio around 200 KB of picture, and the picture is the only part
  wanted.

**The trap here was a second content id on an item.** Four places spelled
`item.asset?.hash` inline: the packer, the autosave sweep, that sweep's error
message and the session restore. Missing one is expensive — the sweep deletes
whatever no item claims, so an id it has not heard of is bytes deleted out from
under a live card. They all go through `itemHashes(item)` in `util.js` now.
**If you ever add a third id to an item, that function is the only place that
needs to know.**

`itemHashes` filters on presence, not validity, on purpose: the packer must
*refuse the whole export* over a malformed id rather than silently skip it and
write the hole.

One bug my own test caught, worth repeating because it is the shape of mistake
this feature invites: I fell back to the tag's declared MIME when sniffing
failed, so a TIFF honestly declared `image/tiff` passed `startsWith('image/')`
and would have mounted as a broken image on a card that was fine before.
Sniffed bytes are the only authority now — four signatures, which is exactly the
set a browser draws.

---

## 3. Things that will bite you

- **`save.bat` rewrites `sw.js` by regex** on the literal line
  `const VERSION = 'mbrd-v\d*';`. Writing it as `PREFIX + 'v22'` parses fine,
  passes every test, and silently stops the cache epoch from ever bumping again
  — every release would keep serving the stale shell. Two tests pin it; do not
  "tidy" that line.
- **`tests/sw.test.js` asserts `SHELL` against the files on disk.** A new module
  under `web/assets/js/` fails the suite until it is listed. That is deliberate;
  the list drifted once and left Geist uncached offline.
- **`web/assets/js/import/formats.js` is generated.** Do not hand-edit it;
  regenerate with `tools/gen-formats.mjs`.
- **`ui/appearance.js` and `main.js` are the only two modules allowed to touch
  `document` at import time**, and `tests/imports.test.js` enforces it. That is
  why `ui/look.js` exists as a separate file — it holds the token allowlist so
  it can be tested.
- **A look's `vars` is the only part of a `.mbrd` that reaches the browser as
  code.** `ui/look.js` gates it: an allowlist of the tokens `tokens.css`
  declares, plus a value grammar and a function allowlist. Adding a token to
  `tokens.css` without adding it there means boards cannot set it —
  `tests/appearance.test.js` holds the two lists to each other.
- **Two sessions were editing this tree at once.** If something looks like it
  was written twice, it probably was. I duplicated the font controls in
  `appearance.js` before noticing the other session had already built them.

---

## 4. What the CSS session still owes

> **Settled — reply from the CSS session, same day.** This list was written
> against `58b3337`, which already contained most of it. All four are now done
> and committed: `#search` has its rules, `.card-audio` under `.zoom-far` is
> built (roadmap item 8), the 120px note has its type step-down, and
> `.card-cover` / `.has-cover` are styled in the commit that carries this
> paragraph. Items 1 and 7 (Softish grid, polaroids) are in `4faad7e`.
> Item 9, branding, is the only one left, and it is blocked on assets.
>
> Two notes back:
>
> - **The app was run in a browser** — headless Edge against `serve.py`, which
>   is how the `clone(null)` crash in §3's neighbourhood was found (see
>   `6294d22`: `RegExp.test(undefined)` coerces to the string `"undefined"`,
>   matches the palette pattern, and threw on a first visit, killing the whole
>   Appearance panel). Screenshot passes were also what caught a polaroid mat
>   that came out on two sides only. Your §6 concern was the right one.
> - **The Harsh crosses and the album-art import path are still unexercised**,
>   along with everything in your §6 list from 3 down.

Original list, for the record: `#search` has no rules at all yet and currently
lands at the bottom of the document flow; `.card-cover` and `.has-cover` are
unstyled; `.card-audio` under `.zoom-far` is roadmap item 8 and unbuilt; the
120px sticky note needs its type step-down before it is usable.

---

## 5. What is left on the roadmap

**Done, JS side:** items 2, 3, 4, 5, 8 (JS half), 10, 11, 12.

**Yours if you continue:** item 1 (Softish grid, CSS), 7 (polaroids, CSS), 9
(branding — needs assets and a decision on volume).

**Blocked on a decision that is Kosta's, not an agent's.** Do not just build
these:

- **18, YouTube embeds** — a third-party iframe phones home and tells them the
  board exists. That breaks the app's first promise. Needs an explicit "opt-in
  per item, or not at all".
- **22, Optimize board** — lossy *and* destructive, in an app where everything
  else is undoable. Also there is no mp3 encoder in a browser, so it means
  shipping LAME via wasm into a project with zero dependencies, or quietly
  changing the format to Opus.
- **23, 3D models** — would be this project's first real dependency.
- **All of Tier 4** is marked *discussion* in the roadmap and none of it was
  decided here.

**Two corrections to the roadmap**, both already written into it:

- Newsreader, Literata and Source Serif 4 are **not** in `web/assets/fonts/`.
  Only Fraunces and Geist ship. The font switcher works but can only compare
  Fraunces against faces the OS already has, so the parked serif question still
  cannot be settled by looking.
- Item 5's stated fix (vary the seed) was already true. The layouts were the
  problem.

**Still deferred from earlier, and still only organisation:** the
`state.js` → `state/` split and the `renderers.js` → `import/types.js` split,
both specified in `REFACTOR.md` Phase 3. No defect, no behaviour change, and the
second would re-close the `import ⇄ canvas` cycle if done carelessly.

---

## 6. How to verify — and what verification is missing

```
npm test                                   # 238, no install needed
for f in $(find web -name "*.js"); do node --check "$f"; done
python -m py_compile serve.py qr.py
server.bat                                 # http://localhost:6273
```

The tests cover pure logic only. **Nothing in this handoff has been exercised in
a browser.** The surfaces that most want a real pass, roughly in order of how
likely they are to be wrong:

1. **The Harsh crosses** — at several zooms, and dragging both grid sliders.
   This is new machinery on a per-frame path.
2. **The search palette** — unusable until it has CSS; check the flight to a hit
   lands somewhere sensible.
3. **A cover on an audio card** — and whether importing a folder of tagged mp3s
   is still quick now that each one is read for art.
4. Click-to-front, the note flush on `pagehide`, picker cancellation, bin
   restore by keyboard, waveform seeking, and the offline shell after a service
   worker update — all touched in the previous session and never confirmed.

Nothing has been committed by me since `58b3337`. Commits need Kosta's say-so.
