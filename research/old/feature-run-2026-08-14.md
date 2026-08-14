# The feature run of 14 August 2026: all ten, and what the last three cost

*Carried out. Ten features from one run of requests; seven were in the tree when
this document was written as a handover, and the three it briefed — the tour, the
Playlist lens and PDF export fidelity — went in against that brief. This is the
record, not a plan. Nothing here is authoritative: `research/docs/` and the code
are.*

The full plan this came from is at
`C:\Users\mjova\.claude\plans\now-make-a-plan-goofy-whale.md`. Decisions taken
with the author, all three honoured:

- the PDF export covers **the whole board surface**, not just cards
- the tour is **desktop canvas only**
- merging is **a prompt on drop**, never a button

---

## The seven

| what | where it landed |
| --- | --- |
| **Item lock** | `meta.locked`; guards in `canvas/input.ts`, rearrange and align/distribute; menu pair; padlock badge |
| **Crop & adjust** | `meta.crop` + `meta.adjust`; new `ui/darkroom.ts`; the crop is baked into the display copy in `canvas/display.ts`, so object-fit and the far-zoom twin need no changes |
| **Tags & filter** | `meta.tags`; `tagFilter` in `board-store.ts`; folds on both menus; an eighth arrangement on both layouts; tags scored second in search |
| **Feed ghost cards** | the dial's rules were scoped to `.item[data-type="ghost"]`, which does not exist on the Feed — now a shared `.ghost-mount` class, plus per-hint span and a measured height |
| **Privacy page** | `/privacy`, plain document, no inline style so the CSP needs no new hash; in `sitemap.xml` and `SHELL` |
| **Panel moves** | Patch notes under Reload; Clear everything inside the Debug fold; Display font / Body font; swipe logger removed |
| **The shelf always holds the board on screen** | `openFile()`/`newBoard()` stash to the library instead of prompting; `confirmDiscard()` deleted; `newBoard`/`newLibraryBoard` collapsed; `ensureCurrentOnShelf()` for the popup; `setBoardThumb()` injection |
| **Debug menu** | four report buttons (safety, storage, weight, history) + the frame profiler, which had no door in the interface at all |
| **Palette picker** | `type: 'picker'` in the schema, `buildPicker` in `ui/panel.ts`, colours read live out of `tokens.css` by `ui/palettes.ts` |
| **Merge a board** | pure `merge.ts` + `mergeBoard()` in `state.ts` + `openOrMergeFile()` in storage; asked on drop, `tests/merge.test.js` |

Two things worth knowing in the storage neighbourhood, unchanged by the three
below:

- **`shelveCurrent()` returns a boolean and the callers refuse if it is false.**
  Removing the discard prompt meant a failed shelf write would silently destroy
  the outgoing board — the exact case the dialog existed for. That guard is
  where the old safety now lives. `tests/state-notfound.test.js`'s stub
  IndexedDB had to grow `put`/`get` because of it.
- **`ask()` grew a `danger` option.** Every question this app stopped to ask
  used to be destructive, so the `go` button was unconditionally red. The
  open-or-merge question is not, and passes `danger: false`.

---

## 1. Tour — in

`board.tour` already existed end to end with nothing consuming it, so this was a
UI feature with its state already built. It stayed that way: **no state change
was needed and none was made.**

**Landed in:** new `ui/tour.ts`; `commands/view.ts`; `commands/item-meta.ts`;
`canvas/input.ts`; `ui/menu.ts`; `index.html`; `chrome.css`;
`research/docs/mbrd-format.md`.

- **The runner is `ui/tour.ts`** — it needs the board, the bus and the Viewport
  *and* it builds chrome, and `canvas/` may not build chrome. `tourStart`,
  `tourStop`, `tourStep(delta)`, `tourGo(i)`, `inTour` and `tourLength` are in
  `commands/view.ts`.
- **Membership went to `commands/item-meta.ts`, not to `view.ts`.** The brief
  put all of it in `view.ts`; the split it actually wanted is the one that file's
  own header draws — the four above move the camera, and `canTour` /
  `selectionInTour` / `toggleSelectionTour` write `board.tour`. Same relation the
  tag rows have to the filter rows.
- **Which stop you are on is not board data, and there is no `tour:at` event.**
  The brief said `state.ts` had one; it does not, and it did not need one. The
  index lives in `ui/tour.ts` alone. The file carries the itinerary — a thing
  somebody made — where the position in it is a fact about a reading session, the
  same status as the Feed's scroll offset, and writing it would make opening a
  board a change to it.
- **`canvas/input.ts` gained the two cases and no more**, in the
  `cmds.playPause?.()` idiom already in that handler: the arrows try
  `cmds.tourStep?.(dir)` and fall through to `nudge(e)`, and `Escape` tries
  `cmds.tourStop?.()` first. `tourStep` answers true whenever a tour is running,
  including at the last stop — otherwise the arrows at the end of a tour would
  drop through to nudging the selection.
- **Camera:** `vp.fit([item], 140, travelMs(), BASE_ZOOM * 1.5)`. The cap was the
  brief's, and it is load-bearing: the default is 500%, so a stop on a sticker
  flew the whole way in and the board vanished.
- **Mobile declines with a toast**, the way `lockZoom` does — `vp.fit()` ignores
  its items there. (`ui/search.ts` still has the identical blind spot; it is a
  `ui/feed.ts` scroll job and still a separate change.)
- **Stops are resolved live on every read**, through `byId()`, and missing ones
  are skipped. `setTour()` normalizes against the live board on a write, but a
  tour running while cards are deleted is exactly the window where the two
  disagree.
- **Clamped at the ends, not wrapped**, and the two buttons grey there.
- **Authoring** is one ticked row in the item fold — not a fold of its own, since
  a board has exactly one tour and a fold holding one entry is a drill-down into
  a checkbox. Starting it is one flipping row on the canvas menu, hidden entirely
  when the board has no stops.
- **Chrome is literal markup in `index.html`**, hidden, styled in `chrome.css`
  beside `#nowplaying`. No new stylesheet, no `JS_BUILT` entry, and no new icon —
  `i-chevron-left`, `i-chevron-right` and `i-close` were already in the sprite.
- **`#tour` sits *after* `#nowplaying`**, and that is as load-bearing as
  `#toolbar` sitting before it. The rule that lifts the tour bar clear of the
  player is a general sibling combinator, and those only look forward: this one
  has to see the player from the tour where the player's own has to see the
  toolbar from the player. Two constraints, opposite directions, neither
  reorderable. Both are written down at both ends.
- **It is deliberately absent from the idle fade list.** A stop is something you
  look at, and looking at one for fifteen still seconds is the normal case — a
  faded bar takes `pointer-events: none` with it, which is the trap `/patch`
  already fell into once.
- **Doc gap closed:** `research/docs/mbrd-format.md` now has a `tour` section
  beside `connections` and `audioOrder`. No format change — only the doc.

## 2. Playlist lens — in

The gap was exactly as briefed: the desktop floating window was a complete
player and the lens hero had Play + Shuffle, with `#nowplaying` hidden on that
lens. `#nowplaying` is still hidden there — the argument in `chrome.css` holds,
and now more strongly, because the lens really does carry the transport.

1. **`makeWindowPlayer()` → `makePlayer({ volume })`, every `pw-` class kept**,
   and `createView()` builds one for both variants. Nothing in it had ever been
   the window's. Seek, scrub, wave sizing, prev/next/repeat and the play-icon
   swap all arrived already written; `mobile.css` adds lens-scoped sizes under
   `#mobile-playlist`, hides the 64px cover (the hero above it is already a
   cover the width of the sheet) and gives the five buttons a thumb.
2. **`windowPlayer` became `players`, a `Set`.** `makePlayer()` adds itself and
   the owning view's `destroy()` takes it out, so there is no second handle to
   keep in step — which is the bookkeeping that would have gone wrong first.
   `onNowPlaying`/`onQueue` fan out to `bindPlayers()`/`refreshPlayers()`.
3. **A `setAwake()` the brief did not ask for, and it is needed.** The window's
   player is built and dropped with the window; the lens's is built once with a
   lens that is only ever *hidden*. Without this its follow loop would run a rAF
   a frame behind the Feed, or behind the whole Desktop board, for as long as a
   track played. `destroy()` is the right teardown for sleeping, so this is that
   plus a flag that stops `bind()` putting it back.
4. **`ActionGroup`/`refreshActions()` did not widen.** The hero's Play/Shuffle
   pair is the album's call to action; the transport under it is what you use
   once something is playing. Different sentences.
5. **`QueueSnapshot` gained `index`** — `queuePos` mapped back through
   `queueOrder`, `-1` when idle. It reads "4 of 12" on a third line under the
   artist. No "up next".
6. **Greying is gated on `!shuffle && repeat === 'off'`, which the brief did not
   say and the code required.** `queuePrev`/`queueNext` *wrap* when pressed, so
   greying at a list index would have been a lie under shuffle and under repeat
   'all'. Read straight through with repeat off, disabling is not a lie about the
   button — it *is* the behaviour, and is what every player does.
7. **Shuffle and repeat persist through `prefs.ts`** (`mbrd.shuffle`,
   `mbrd.repeat`), the same argument `canvas/audio.ts` makes for volume. **No
   schema change.**
8. **Volume on the lens**, with `volumeLocked()` copied verbatim from
   `initNowPlaying()` — the row is not built at all where iOS ignores the write,
   rather than built and disabled. `assets/icons.svg#i-volume` through
   `ui/menu.ts`'s `icon()`.
9. **The transport hides on a board with no audio**, in both homes. Five buttons
   that cannot do anything over a "No music here yet" panel is not a transport.

## 3. PDF export — in, and it is still a second renderer

`ui/snapshot.ts` is the whole feature and the DOM route still taints, so
`renderBoardCanvas()` remains a parallel implementation kept in step by hand.
What changed is how much of it is *restated* rather than *asked*: `fitMode()`,
`itemCrop()`, `adjustFilter()`, `routeConnection()`, `pathData()`, `connMeta()`,
`boardGridStep()`, `flattenNoteRich()` and `paperMm()` are all the board's own
answers now. Only three things could not be reused, and each is annotated with
why: `paintGrid()`, `paintGrain()` and `paintPaper()` all paint against a live
viewport into an on-screen layer, and this has no camera.

**Structure first, while it was free**

- **`detail: 'full' | 'thumb'`**, taken as part of this work. `boardThumb()` runs
  on every open and every new since the storage change, and now skips the
  lattice, the sheet, the web, the stock, the shadows and every string of text —
  all invisible at 360px and all paid for on a gesture somebody is waiting on.
- **`drawItem()`'s branches became `PAINTERS`, keyed by type the way `RENDERERS`
  is**, with `paintMedia` as the fallback because "has pixels, or has a name" is
  not a kind.
- **One `Look` object, read once per render.** `readToken()` is a style flush and
  `--ink` was being read per card.

**Cards**

- **Resting tilt** — read back off the mounted node through `tiltOf()` times
  `--tilt-max`, and zeroed at Harsh and on a snapped board the way
  `drawnTilt()` in `canvas/web.ts` does. *The consequence stands and is written
  into the module header:* a card that is culled has no node, so an export taken
  while zoomed out far enough gets some cards leaning and some straight. The
  clean fix is an optional durable `meta.tilt` — **a backwards-compatible
  `.mbrd` addition, still to be decided deliberately, and deliberately not taken
  as a side effect of an export.**
- **Shadows** — from `--shadow-1`, resolved by putting it on a probe element and
  reading the *computed* `box-shadow` back. A custom property is handed back as
  the tokens it was written with, so `color-mix(...)` does not resolve through
  `getPropertyValue` — and this file was not going to grow a colour-space
  implementation. `none` at both ends of the axis comes back as null, which is
  the case a parser would have got wrong quietly. Not drawn under a sticker or a
  fence.
- **`meta.crop` and `meta.adjust`** — **the filter-string builder moved out of
  `canvas/item-dom.ts` down to `board-model.ts` as `adjustFilter()`**, and both
  the card's `--item-filter` and the canvas context's `filter` are now the same
  string from the same function. This was correctness, not fidelity: two features
  shipped this run and the export knew about neither.
- **`object-fit`** — through `fitMode()`. A contained picture gets the card
  painted behind it so the bands are the card rather than a hole in the board.
- **Caption bar and the kicker/meta line** — the plate across the foot of a
  picture card, and `formatBytes() · describeExt()` under a face card's name.
  Both suppressed below a size where they are a smudge on a smudge.
- **Board fonts** — `--font-display` and `--font-body`, after `document.fonts.ready`.
  Without the await the first export after a board load was set in the fallback
  stack, which is the one difference from the screen nobody would think to check.
- **Notes** — `flattenNoteRich()` (in `canvas/note-model.ts`, not
  `storage/mbrd.ts` as the brief said), wrapped top-left. It was `it.name`, which
  is a note's *first line*, so a six-line note exported as its own heading.
  **`meta.rich`'s block layout is deliberately not reimplemented** — that is a
  text engine, and it would disagree with the note on screen at the first styled
  note.

**Board surface**

- **Fences** — a stroked rounded rect with the name on the bottom bar. They fell
  to the named-card branch before, so a board organised into six labelled areas
  exported as six grey boxes lying under the work they grouped.
- **Connections** — routed by `routeConnection()` and stroked as a `Path2D` off
  `pathData()`, so an export's web is routed by the code that routed it on
  screen. Colour, weight and dash from `connMeta()`. Arrowheads are a filled
  triangle and labels are a word with a paper-coloured halo under it — plain, as
  briefed.
- **Grid** — dots, or crosses at Harsh; `boardGridStep()` for the step; the two
  ink tokens. It stops below four drawn pixels rather than coarsening, because
  there is no zoom here to coarsen with.
- **Paper outline** — a dashed stroked rectangle centred on the world origin,
  sized through `paperMm()`/`toUnits()`, which is the only place `settings.scale`
  enters the file.
- **Grain — done last and drawn deliberately weak.** A deterministic 128px tile
  of 3px specks at `--grain × 0.35`, composited `overlay`. Noise is the worst
  case a JPEG can be handed, and the seed is the board's item count rather than
  `Math.random`, so two exports of one board are the same file. **The output size
  with grain on is the one number still to be checked by eye** — see below. If it
  is unacceptable the answer is not a lower strength: `buildPdf()` writes
  `/DCTDecode`, and a `/FlateDecode` PNG path is available because
  `CompressionStream` and `storage/zip.ts`'s deflate already exist. That is a
  bigger change than a constant, so it is written down rather than done.

---

## Verification

All four legs green on the finished tree:

```
npx tsc --noEmit        silent
npm run lint            62 warnings, the baseline, no new ones
npm test                1237
npm run build           491.4kb
```

The tour touched `index.html`, so both generated copies were remade:

```
cp web/index.html web/404.html
node tools/gen-patch-page.mjs
```

**Not done, because there is no browser-driven suite and this was not run in a
browser.** These are the by-eye checks the work still owes, in the order they
are cheapest:

- **Tour** — step with the arrows and Escape; check a stop on a sticker does not
  fly to 500%; check it declines on Mobile; check the bar clears the player when
  something is playing and clears the sidebar when it is open.
- **Playlist** — at phone width in the Playlist lens: seek, scrub, prev/next
  greyed at the ends with repeat off and *live* with it on, shuffle, repeat
  cycling, volume, and both modes surviving a reload.
- **PDF** — export a board carrying a cropped photo, a graded photo, a fence,
  connections, a styled note and a custom font; compare against the screen; and
  **check the file size with grain on**, which is the one number that decides
  whether the JPEG container survives.
