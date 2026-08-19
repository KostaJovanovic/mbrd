# A plan for fixing the 2026-08-15 audit

Open work. This is the plan for clearing
[`audit-2026-08-15.md`](audit-2026-08-15.md) — all of it, including the
findings marked *suspicion*.

Written at `fd8bd45` (v0.205), tree clean apart from the audit and this file.

## The shape of it

Fourteen commits, one per theme, in the order below. Each commit is a whole
theme: the code change, the test that holds it, and any doc or comment the
change makes wrong. After each one, before it is committed:

```
npm test && npm run lint && npm run typecheck && npm run build
```

and the rebuilt `web/assets/app.js` goes in with the sources, so no commit
in the history is a half-state. Nothing is pushed.

The tests come first, in three commits, because the audit's own conclusion is
that the suite is why the rest got through: a drift test that repairs the file
it is checking, a version rule half-asserted, a `@ts-nocheck` scan that reads
one byte, and about thirty assertions that cannot fail. Fixing behaviour
against a suite in that state is building on sand.

Nothing here touches `patch-notes.md` — that is yours. See the note at the
foot about what will be waiting for you.

---

## The twelve decisions I am making for you

Flagged here so you can reverse any of them before I start. Everything else in
the plan is a bug with one obvious repair.

**1. pdf.js gets vendored into the repo.**
`import/pdf.ts:88` loads it from `cdn.jsdelivr.net`, which is not in
`script-src`, so PDF import and viewing are dead on the deploy and work
locally. Three ways out: vendor the library, widen the CSP, or drop PDF
support. I am vendoring it — widening `script-src` to a CDN gives an outside
host script rights over every board, and `worker-src 'self'` would still need
a blob shim on top. Cost: roughly 1 MB of committed vendor code, four new
entries in `SHELL` (**service-worker cache change**), and a new line in
`tests/csp.test.js` that greps `import/pdf.ts` the way it already greps
`optimize/media.ts`.

**2. Deleting a board asks first.**
`ui/library.ts:169` destroys a saved board on one tap of a 22px `×`. I am
wiring it through the `setPrompt(ask)` dialog already used for
`clear-data` — one dialog, not a three-press arming, and no bin. A bin for
boards is a feature, not a bug fix.

**3. The note-colour custom property gets renamed, the whimsy one keeps
`--wash`.**
`cards.css` redefines `--wash` as a colour while `tokens.css` has owned it as
the whimsy ornament multiplier since long before. The note side moves to
`--note-wash`, matching the four `--note-wash-*` sheet tokens beside it. I am
renaming the newer of the two, not the one that is in the look allowlist and
in saved `.mbrd` files.

**4. `abortGesture()` starts doing what its name and its header say.**
Today it commits — land a second finger mid-drag and the card stays where it
was dropped with a `Move` on the undo stack. The module header argues at
length that this drops. Making the code match the prose is the smaller change
and the one the file asks for. It is a real behaviour change: pinching out of
a drag will snap the card back.

**5. A board with a missing asset becomes escapable.**
`storage/storage.ts:825` currently refuses to pack, so the only way off a
board that lost one file is Clear everything. Packing will keep the item and
omit the absent bytes, with the existing "came back without its data" warning
carried into the export. That is a change in what a `.mbrd` may contain.

**6. The Feed's menu retargets the selection first.**
`ui/menu.ts:543` — long-press tile B, tap Delete, card A dies. The canvas path
already retargets at `canvas/input.ts:2571`; the Feed gets the same call
rather than a second selection model.

**7. `meta.tint` is accepted as a number *and* a string.**
`canvas/item-dom.ts:396` only accepts a string, so every sticky note on every
board is currently on sheet 1. Accepting both means boards written by any
version keep working; I am not migrating stored data.

**8. `research/cuelume-main.zip` gets deleted.**
16 KB of an unrelated project, committed in v0.204, described nowhere. If it
is something you meant to keep, say so now.

**9. Docs lose their arguments to the code.**
Where `architecture.md`, `CONTRIBUTING.md` or a module header describes
behaviour the code no longer has, the prose is rewritten. The three big ones:
the stylesheet cascade table (17 sheets listed, 23 loaded), CONTRIBUTING's
`@ts-nocheck` instructions for a debt that is zero, and the playlist/panel-stack
headers describing a design the rewrite removed.

**10. The two undeclared CSS properties get real tokens.**
`--bad` becomes `--danger` (six uses in `timeline.css`, currently falling
through to a hard-coded `#c0392b` that ignores the board's palette).
`--seed` — used twice, declared nowhere, no fallback, so two buttons render
square — becomes `--radius-sm` unless the neighbouring rules say otherwise
when I get there.

**11. `--foot-left` / `--foot-right` go back to being defined once.**
`mobile.css:1438` redefines them on `#nowplaying`. The mobile inset moves into
the `:root` block in `chrome.css` where CLAUDE.md says it lives.

**12. The version rule gets asserted, and the suite goes red until you write
the patch note.**
`tests/patch.test.js:113` asserts only the bottom of the span ladder. Turning
on the top half — the rule CLAUDE.md actually states — fails immediately,
because the newest span ends at 0.201 and `VERSION` is 0.205. I will turn it
on anyway; a rule nobody enforces is the reason it drifted. **This is the one
place the plan deliberately leaves `npm test` failing**, and only you can
clear it. Tell me if you would rather I left the assertion off.

---

## The fourteen commits

### 1. tests: make the ratchets real
The guards that were supposed to catch this class of thing and did not.

- `patch.test.js:333` — stop running the generator against the working tree.
  Generate to a temp path and compare. `npm test` becomes read-only again.
- `patch.test.js:113` — assert the newest span's high end equals `VERSION`
  (decision 12 — goes red).
- `ts-debt.test.js:45` — scan the whole leading comment block, not byte 0.
  Every module here opens with a header, so the house style is currently the
  bypass.
- `zip.test.js:113` — perform the truncation the comment describes: keep the
  directory, lose the payload. Today it removes the EOCD and lands on a branch
  two other tests already cover, leaving `readZip`'s bounds check untested.
- `zip.test.js:100` — `rejects(p, /.+/)` accepts any error with a message;
  thirteen hostile-archive tests route through it. Assert the actual guard.
- `layers.test.js:56` — include dynamic `import()` in the edge set. Eight
  literal dynamic imports already cross tiers, invisibly.
- `imports.test.js:34` — catch browser globals Node also defines
  (`navigator`, `crypto`, `performance`, `Blob`, `File`).
- `csp.test.js:242` — the "no style attribute" check scans for
  `setAttribute('style'` only; extend it to the `innerHTML` template strings
  its own comment claims to cover.
- `csp.test.js:301` — the `connect-src` host is taken from the first `https://`
  anywhere in the file, so a URL in a header comment retargets the check.
- `icons.test.js:98/139` — the viewBox regex requires `id` before `viewBox`;
  and "every entry offers an icon" is a count equality that balances.
- `stylesheets.test.js:70/73` — `indexOf(A) < indexOf(B)` is vacuously true
  when `A` is absent.

### 2. tests: replace the assertions that cannot fail
The roughly thirty listed at the foot of the test-suite section — each one
re-pointed at the thing it was meant to check.

Named ones first: `state-notfound.test.js:129` (performs the fix, then asserts
it), `layout-settings.test.js:271` (asserts state left by another test; the
single-test invocation CLAUDE.md documents is broken — add the missing
`beforeEach`), `flyout.test.js:75/117` and `appearance.test.js:155`
(implementation compared against itself), `state-items.test.js:234` (named for
the opposite of what it pins), `input.test.js:356` (satisfied by the right
disjunct always), `web.test.js:97` (assertions inside a possibly-empty loop,
return value discarded by all five callers), `layout.test.js:634` (exercises
the test file's own helper), `font-tokens.test.js:43/48`,
`timeline.test.js:548` (unbounded `while` — hangs rather than fails),
`display.test.js:54` and `trash.test.js:34` (replace globals and never restore
them), plus the `ghosts`/`pigments`/`stickers`/`measure`/`geometry`/`markdown`/
`settings-panel`/`inventory`/`connections`/`viewport-mode`/`storage`/`mesh`/
`state-history` cases.

Care needed: the audit lists the **source-text anchors** — tests that read
source *text*, so an apparently-unused symbol or a reformatted line breaks
them. Those stay as they are.

### 3. tests: cover what is not covered
- New `tests/preview.test.js` and `tests/opus.test.js` — two of the six
  hand-written binary readers CLAUDE.md names have no test file at all.
- Export `scrub()` from `ui/documents.ts` and test the SVG allow-list in both
  directions. It is the single named exception to the no-`innerHTML` rule and
  has no test.
- `tests/mesh.test.js` — the named holes: negative accessor count, a
  `bufferView` overrunning the BIN chunk, an accessor naming a nonexistent
  bufferView, index values past the position count, unknown `componentType`,
  malformed `data:` URI, the OBJ and ASCII-STL triangle caps.
- `tests/zip.test.js` — hostile entry names (`../`, leading `/`, backslashes,
  NUL, absurd `nameLen`), the `LIMITS` cases, signature corruption, garbage
  DEFLATE, ZIP64 and data-descriptor records.
- `tests/note-model.test.js` — `wash` is untested entirely, including the two
  behaviours `research/docs/mbrd-format.md` now promises in writing.
- Hoist `resizeAxis()` and `nudgeBy()` out of `initInput()`'s closure so the
  two riskiest pieces of arithmetic in `canvas/input.ts` can be reached, the
  way every other pure rule in that file already is.

### 4. Data loss
The findings where a user loses work.

- `storage/mbrd.ts:466` — `parseNote()` strips the `# ` marker `noteMarkdown()`
  wrote, so the sidecar never matches and every note is rebuilt from plaintext
  on an ordinary export→import: `align` reset, every `wash` key gone.
  `tests/mbrd.test.js:395` currently locks the rebuild in and gets rewritten.
  **`.mbrd` round-trip fix.**
- `main.ts:533` — `flushEdits` armed before `restoreSession()` finishes. Reload
  mid-restore and a blank board is written over the snapshot, then the sweep
  deletes every asset. Arm it after the restore resolves.
- `ui/library.ts:169` — board delete confirmation (decision 2).
- `storage/storage.ts:825` — the un-leaveable board (decision 5).
- `state.ts:1511` and `:1489` — `setTour()` and `setAudioOrder()` prune against
  live items only, so any later edit silently drops the entries of cards
  sitting in the bin. `board-schema.ts` prunes against items **plus** trash;
  match it.
- `merge.ts:115`/`:121` — a dangling `meta.stuckTo` (or `meta.fence`) in a
  merged file resolves onto a renamed arrival, sticking a note to a card it was
  never on. The guard must test that the id was reached *through* `moved`.
- `state.ts:1209` — undoing an Untag writes the tag twice; the add branch has
  to be a union.
- `timeline.ts:720` + `:1127` — a step with no `at` coerces to 0, so every step
  in such a file counts as "older than 30 days" and one press folds the whole
  history, this morning included, irreversibly.
- `timeline.ts:1134` — `adoptTimeline()` keeps the *first* 20,000 steps where
  `recordStep()` folds the oldest; a 25,000-step file loses its newest 5,000.
- `storage/library.ts:80` — blob and index row written in two transactions with
  no reconciliation, and the index is a read-modify-write: overlapping stashes
  lose a row and strand a blob that nothing can list or delete.
- `storage/library.ts:77` — nothing caps the shelf, so twenty opened boards is
  twenty full archives; the quota error lands on `writeSnapshot()` and stops
  the *live* board autosaving.
- `storage/mbrd.ts:233` — `meta.poster` is in neither the packer's nor the
  sweep's reference union, so a legacy board's poster bytes are deleted by the
  first autosave. **`.mbrd` reference-union change.**

### 5. Hangs and unbounded allocation
Everything that can freeze a tab or exhaust memory, including the suspicions.

- `sticky.ts:382`/`:451` — `dragRoot()` never terminates on a cyclic
  `meta.stuckTo`, and `seedSticks()` is the door: it stores `n -> n` off a file
  with no self-reference test. First press freezes the browser (demonstrated).
- `mesh.ts:754`/`:759` — the `MAT4` accessor guard is off by 16×; a 356-byte
  GLB allocates 366 MiB (measured), and an accessor with no `bufferView` pays
  it once per primitive with no file-size bound at all. Also `:774` (signed
  component types into a `Uint32Array`), `:641` (unchecked `node.matrix`),
  `:564`, `:299`.
- `import/budget.ts:84` + `drop.ts:743`/`:775` — the pixel budget knows only
  four formats and two paths skip it; a 60-byte BMP allocates ~3.6 GB.
- `import/preview.ts:218` — `scanForJpeg()` is O(n²) over 12 MB on the main
  thread, uncapped and uncancellable. `:165` reads past the DataView on a
  truncated TIFF and takes the fallback down with it.
- `ui/markdown.ts:310` — quadratic backtracking; 200k backticks block the main
  thread 13.7 s (measured). `:112` — blockquote recursion with no depth cap.
- `import/document.ts:151` — `MAX_CONTAINER` caps the compressed container
  only; six concurrent workers can each hold 768 MB of inflated entries.
- `import/artwork.ts:209` — an ID3 tag length read off the file with no
  ceiling, then a second copy allocated by `desync()`.
- `import/drop.ts:1189` — `walkEntry()` recurses with no depth limit and no
  visited set. `:443` — the byte budget is per call, so concurrent drops each
  get a fresh 1 GB.
- `import/pdf.ts:165` — the raster scale has a floor, so `TARGET` is a target
  and not a cap; a 200,000-unit MediaBox asks for 1.6 GB.
- `canvas/spatial.ts:62` — `cellsFor()` has no bound on the box.
- `canvas/renderers.ts:292` — `svgSize()` decodes the whole file before slicing
  to 4 KB.
- `ui/documents.ts:189` — `MAX_CELLS` is checked once per row, so one row is
  unbounded. `:457` — `ooxmlSlides` ignores `MAX_IMAGES` by 16×. `:841` —
  recursion with no depth cap.
- `ui/snapshot.ts:1042` — `boardThumb()` renders at 8000×8000 (256 MB) then
  shrinks to 360px, past iOS Safari's canvas ceiling, on every open and every
  new.
- `layout.ts:203` — `packMobileGrid()` restarts its row scan per item;
  `:975` — `travelling()` uses `includes()` inside a growth loop.
- `commands/connections.ts:297` — the no-selection spanning tree is O(n²) with
  no ceiling.
- `ui/timeline-view.ts:421` — a full `serializeTimeline()` + `JSON.stringify`
  per bus event while the strip is up.
- `ui/appearance.ts:754` — the "Every photo" stop makes `sourceCount()` return
  `Infinity`, minting a blob URL per picture and decoding all of them.
- `measure.ts:277` — `decades()` loops to a bound with no finiteness guard.

### 6. Foreign documents and the CSP
- `ui/documents.ts:822` — `scrub()` never inspects the root `<svg>`'s own
  attributes, so `<svg onload=…>` survives into the page. `:837` — `style` is
  on the allow-list and text content is never filtered, so an SVG's `<style>`
  applies document-wide. `:849` — no case for the `style` *attribute*. `:850` —
  the xlink test matches literal prefixes only. All four are live under
  `serve.py`; on the deploy the allow-list `_headers` calls "the first lock" is
  the one failing.
- `import/pdf.ts:88` — vendoring (decision 1). **Service-worker `SHELL`
  change**, plus the `_headers` `connect-src` comment that still says "exactly
  three things fetch".
- `ui/trash.ts:167` — `innerHTML` built from `.mbrd`-sourced `meta`, against
  CLAUDE.md's rule. Not exploitable today; the rule exists so it does not
  depend on two validators staying correct.
- `ui/feed.ts:764` — swatch tiles are coloured from `item.name`, straight into
  `style.background`, bypassing `swatchHex()`.
- `ui/viewer.ts:560` and `ui/feed.ts:721` — the note sheet is tinted from
  `meta.color`, a key nothing writes, assigned unvalidated.
- `board-schema.ts:265` — the file's raw settings are spread wholesale over the
  defaults, so eight fields arrive from a foreign document untouched
  (`gridStep: 1e300` collapses a snapped board onto one point).
- `arrangements.ts:167` — `LAYOUTS[name] || LAYOUTS.grid` resolves inherited
  prototype keys; `"arrangement": "constructor"` takes down Rearrange.
- `timeline.ts:1137`, `storage/mbrd.ts:714`, `board-model.ts:1213` — three
  validators that check `isRecord()` (or nothing) and then dereference.
- `crypto.ts:59` — `crypto?.subtle` guards a missing property, not a missing
  binding, so the hand-written fallback is unreachable by `ReferenceError`.
- `index.html:181` — the anti-flash guard writes `dataset.whimsy`/`palette`
  with no validation, causing the flash it exists to prevent.
- `main.ts:505` — `window.mbrd` exposes `bus` and `selection` beyond the four
  documented members, on `/patch` too.
- `optimize/media-worker.js:14` — `onmessage` validates nothing and `boot()` is
  re-entrant, in the one context where CSP is explicitly removed.

### 7. The gesture pipeline
`canvas/input.ts` and `canvas/viewport.ts`. One file, one pipeline — not split.

The two that wedge it: `:1870` (a `move` built with an empty `origin` throws on
every subsequent `pointermove` until the button is released) and `:1488` (the
second pinch pointer is never captured, so a finger lifted outside `#viewport`
leaves a phantom that makes every later tap pan and zoom).

Then `:2064` (`endPointer` ends whichever gesture is standing without checking
ownership), `:2065` (a third finger lifting turns a pinch into a two-finger
pan that jumps back and forth), `:2170` (decision 4), `:1467` (pen barrel
button), `:1591` (unguarded `setPointerCapture` beside a `releasePointerSafely`
that exists for the same reason), `:1563`, `:2183` (wheel `preventDefault()`
before deciding anything, so nothing inside a card can scroll), `:1052`
(`insetNow()` live where the grip froze it), `:1173` and `:1183` (the marquee
rule the comment describes is not implemented, and the drawn band detaches on a
view change), `:2014` (a dead branch whose comment describes what it does not
do), and `viewport.ts:884` (raw `devicePixelRatio` published where
`deviceRatio()` clamps, so the hairline grid and the axis snap disagree).

### 8. Menus, panels and the chrome
- `ui/menu.ts:543` — the Feed menu (decision 6).
- `:391` — the capture-phase keydown swallows typing whenever any panel is up,
  including a hover flyout that declined focus. Ask
  `node.contains(document.activeElement)`.
- `:335` — `justDismissed()` records which *element* dismissed, not which
  *menu*, so pressing a second menu button while the first is open closes one
  and opens neither. Reproduces in the note toolbar and between More and the
  palette picker.
- `:1233`, `:1427`, `:428` — the hover-child lifecycle: an orphaned submenu on
  drill-in, a dead keyboard press on a row whose child a mouse left open, and a
  keyboard walk blind to the child panel entirely.
- `ui/flyout.ts:176` — `onOver()` treats `#ctx-child` as "anywhere else" and
  starts the close timer under the pointer. Latent, and the same trap
  `insideMenu()` documents on the other side.
- `ui/search.ts:92` — the palette's own closer is the `justDismissed()` trap;
  tapping Find with a query typed discards it and builds a fresh empty palette.
- `ui/board-actions.ts:158` and `:450` — an uncaught `autosave()` rejection
  strands Save disabled reading "Saving…" for the session and makes Restart —
  the only way back on a phone — do nothing.
- `ui/sidebar.ts:125` + `ui/toolbar.ts:66` — both `data-cmd` dispatchers
  discard the returned promise, which is what makes the two above invisible.
- `ui/library.ts:64/67` — `aria-modal` with no focus move, trap or restore.
- `ui/trash.ts:65` (three null policies for one class of lookup), `:292` (bin
  drag listeners on a row `paint()` can destroy mid-gesture).
- `ui/board-title.ts:207` — inline rename listeners on a node `canvas/items.ts`
  culls and rebuilds.
- `ui/panel.ts:132`, `:384`, `ui/tour.ts:191`, `ui/hud.ts:139`,
  `ui/float-window.ts:51`, `ui/menu.ts:892` (two different actions labelled
  "Reset size"), and the dead members at `menu.ts:186`,
  `commands/item-meta.ts:254`, `commands/file.ts:54`,
  `board-actions.ts:694`/`:99`/`:499`.

### 9. Media playback and the note composer
- `ui/nowplaying.ts:236` — `show()` bails on an unchanged item even when the
  element changed, so the bar draws 0:00 and scrubs a silenced element while
  sound comes out of another. `ui/playlist.ts:1137` already gets this right.
- `canvas/stills.ts:148` — frozen-GIF blob URLs never revoked; the header's
  argument that the node owns the URL is wrong about what a blob URL is.
  `:84` — the mount-count guard misses a GIF that arrives in a pass that also
  culls.
- `canvas/playlist-queue.ts:226` (a deleted current track restarts the queue at
  track 1), `:250` (a missing asset stalls the queue silently instead of
  skipping), `:267` (an autoplay rejection swallowed on the path every Play
  press takes — `canvas/transport.ts:284` argues against exactly this).
- `canvas/transport.ts:413` — a per-card `bus.on('selection')` unsubscribed
  only from inside its own handler, so 50 discarded cards leak 50 closures.
  `:70` — `TransportOptions` and everything it gates is dead.
- `ui/playlist.ts:922` (one module-level close timer for per-element
  animations), `:784` (unbounded concurrent `new Audio()` probes with no
  `load()` and no timeout backstop), `:1034`, `:1042`, `:55`.
- `canvas/video.ts:183`, `media/transport.ts:166`/`:170`/`:187`.
- Notes: `notes.ts:428` (the marker menu takes focus, so `setWash` reads a
  caret the menu's close disturbed), `:795` and `:809` (Enter splits a marked
  line and the second half comes out unmarked; Backspace-joining takes one
  line's mark and discards the other's), `:1167`, `:475`, `:494`, `:421`,
  `:1046`.
- `canvas/note-model.ts:236` — the `--wash` collision (decision 3).

### 10. Appearance and colour
`ui/look.ts:30` — the four `--note-wash-*` tokens missing from `TOKENS`. **This
is the one currently failing test**, and it is fixed in commit 1 rather than
here so the suite is green from the start; the rest of the appearance work
lands here.

`ui/appearance.ts:882` (a rejected pre-paint property no control can ever
clear), `:524` (the swatch paint writes `.value` on a `<button>`, so the
documented travelling swatch does not happen), `:432`, `:83` (three of ~57
axis-owned tokens named, so a whimsy move leaves the rest pinned), `:481`,
`:324`, `:361`; `layout-settings.ts:7` (a second allowlist with the same drift
shape, and nothing holds it to the blocks it mirrors — this wants the test
that `TOKENS` now has); `appearance-controls.ts:366`/`:129`;
`ui/darkroom.ts:299`/`:173`; `quality.ts:17`.

### 11. Items, renderers and the web graph
- `canvas/item-dom.ts:396` — `data-tint` (decision 7). **Every sticky note on
  every board is on sheet 1 right now**, in the shipped bundle.
- `canvas/items.ts:1032` (rebuild throws away a card's body without the media
  teardown `discard()` argues is mandatory — a renamed 4000×3000 photo keeps
  its ~48 MB decode), `:787` (the detach pass discards the note composer's
  lifted card, blanking the sheet mid-edit and leaving an orphan behind),
  `:757`, `:1440`.
- `canvas/renderers.ts:882`/`:892` (a duplicated id and a doubly-bound whimsy
  dial once the Feed is up), `:749`, `:733`.
- `canvas/model.ts:829`, `:296`; `canvas/item-dom.ts:510`;
  `canvas/display.ts:130`; `canvas/exit-anim.ts:66`; `canvas/grid.ts:557`.
- `canvas/web.ts:746` — a stored route is invalidated only when its own
  endpoints move, so a card dragged onto an existing line is never routed
  around, against `web-route.ts`'s "nothing to go stale". Then `:1169`, `:958`,
  `:623` (twice), `:1392`, `:1372`, `:795`, `:595`; `ui/conn-chip.ts:222`;
  `web-graph.ts:116`; `web-route.ts:362`; `commands/connections.ts:189`;
  `canvas/embed.ts:243`.

### 12. Layout, timeline and arrangements
- `timeline.ts:856` and `:900` — `goTo()` and `rebuildFrom()` replay the board
  without clearing the undo stacks, so the next Ctrl+Z writes another era's
  geometry onto the current board and marks it dirty. `tests/timeline.test.js`
  never exercises `goTo`.
- `layout.ts:1036` — `commitGeom()` pairs `after[i]` with `before[i]` while
  `snapshotGeom()` drops ids whose item is gone, so a deletion mid-gesture
  shifts every later index by one and four separate comparisons go to unrelated
  items.
- `arrangements.ts:169` — `free` returns before `avoidObstacles()`, so the
  obstacle list added for anchored cards is discarded for exactly the one
  layout that needs it most.
- `layout.ts:331` — `blockers` honoured at one of three call sites, so an
  anchor survives Rearrange and not a reflow. No test names it.
- `ui/timeline-view.ts:509` — the step editor offers desktop arrangements on a
  Mobile board; `:311`, `:380`.
- `arrangements.ts:797` — `MOBILE_ARRANGEMENTS` has seven entries where
  `research/docs/layout-settings.md` specifies six. **Spec-vs-code
  disagreement**: I will take the code and correct the spec unless `tag` on
  Mobile is genuinely unintended.
- `arrangements.ts:932`; `timeline.ts:756`, `:278`; `layout.ts:434`, `:144`,
  `:975`.
- The automated-edit residue at `layout.ts:671/674/681/933/1141`.

### 13. Boot, storage plumbing and the profiler
- `main.ts:771` — `dismissSplash` covers only a throw inside `start()`; any
  throw in the module body leaves the full-screen boot cover up forever with
  the toast underneath it.
- `main.ts:624` — a dropped promise in the not-found handover leaves the writer
  suspended for the session and makes the error message actively wrong about
  whose board it is.
- `errors.ts:264` — the re-entry guard returns before `console.error`, against
  this module's header promising it never swallows.
- `page.ts:58` — `/patch/` with a trailing slash classifies as not-found, which
  skips `freezePrefs()`, so a reader's whimsy and palette follow them home.
- `canvas/audio.ts:230` — a synchronous `localStorage.setItem` per volume
  slider `input` event, ~60/sec on the thread that draws.
- `storage/idb.ts:24` — a force-closed connection resolves forever to the dead
  handle and latches `cacheOk = false` for the session; `:33`.
- `main.ts:804` (an update already waiting never toasts), `:797`, `:437`,
  `storage/session.ts:709`, `storage/library.ts:82`, `util.ts:187`.
- `perf/view-perf.ts:249` (the profiler's own work lands in the interval it
  reports, inflating exactly the numbers it exists for), `:414` (`#imperfect`
  arms it), `:419`, `:195`.
- `storage/mbrd.ts:33` — `storage/` imports `canvas/note-model.ts`, a second
  peer-rank edge the layering graph does not sanction. Either it is argued into
  `architecture.md` and `tests/layers.test.js`, or the shared code moves down.
  **Layering change either way.**

### 14. Prose, CSS and the repo
- `research/docs/architecture.md` — the stylesheet cascade table (17 listed, 23
  loaded, 25 cached), the removed playlist design at `:399`, `IDLE_MS` at
  `:454`, the `@ts-nocheck` claim at `:1747`.
- `CONTRIBUTING.md:85` — instructions for converting modules off a pragma no
  module carries.
- `research/docs/mbrd-format.md:94` — the fixed-offset claim, wrong by eight
  bytes in both the spec and `storage/mbrd.ts:188`'s comment. **`.mbrd` spec
  correction.**
- `research/docs/browser-support.md:8` — thirteen modules named with a `.js`
  extension none of them has.
- `research/docs/layout-settings.md:46` — the Mobile arrangement list
  (see commit 12).
- `web/sw.js:104` — the three bundled OFL files are committed and not in
  `SHELL`, though the comment makes the argument for caching them.
  **Service-worker cache change.** `:152` — a source map that is not built.
- `web/_headers:35` — "four hashes" where the policy carries six.
- `.github/workflows/ci.yml:7` — a header quoting a CLAUDE.md sentence that no
  longer exists.
- `timeline.css:161`/`:408` (`--seed`), `:359` (`--bad`), `mobile.css:1438`
  (`--foot-*`), `chrome.css:453` (a byte-for-byte duplicate that is
  load-bearing and held together by nothing), `canvas.css:888`.
- `ui/playlist.ts:207`, `ui/panel-stack.ts:1`, `ui/mobile-header.ts:309`,
  `canvas/stills.ts:38`, `canvas/transport.ts:9`, `clipboard.ts:71`,
  `sticky.ts` header, `layout.ts:144` — module headers arguing for designs the
  code no longer has.
- Delete `research/cuelume-main.zip` (decision 8).

---

## What is left for you at the end

- **`patch-notes.md`** — the newest span ends at 0.201 and `VERSION` is 0.205,
  so 0.202–0.205 are described by no release, and after commit 1 the test says
  so out loud. Fourteen more commits land on top of that. The prose is yours;
  I will hand you a list of what changed per theme when the work is done.
- **A look at it in a browser.** There is no browser-driven suite, and this
  plan changes gestures, menus, the note composer and the connection layer.
  Pan and zoom, drag and marquee, a save → refresh → recover, and a clean boot
  console are checked by launching it and looking.
- **`save.bat`** when you are ready to release — it stamps the version, builds,
  commits and offers the push. Nothing in this plan pushes.

## What I would cut if you want it shorter

Commits 1–6 are the ones that matter: the suite, the data loss, the freezes and
the security. That is roughly a third of the findings and nearly all of the
risk. Commits 7–13 are correctness work on things that are visibly wrong but
recoverable, and 14 is prose. Say the word and I will stop after 6.
