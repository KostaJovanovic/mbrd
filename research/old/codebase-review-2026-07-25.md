# Whole-codebase review — 2026-07-25

> **Status: acted on the same day.** All six high-priority findings and all
> fifteen medium ones are fixed; three of the five low ones are fixed and one is
> partly addressed. See [Resolution](#resolution) at the foot of this document
> for what changed, what was deliberately left, and what has *not* been verified
> in a browser. The findings below are left exactly as written.

## Executive summary

The current working tree is thoughtfully structured and unusually well
documented. The pure logic has a strong dependency-free test suite, URL-bearing
DOM is built safely, asset export now fails on missing bytes, and the ZIP reader
has substantially better structural and CRC validation than the baseline.

The review still found six high-priority issues:

1. A `.mbrd` can apply arbitrary CSS properties from `appearance.vars`,
   including properties that trigger network requests.
2. A DEFLATE entry can lie about its uncompressed size, bypass every pre-inflate
   limit, and be rejected only after the browser has inflated all of it.
3. Opening a syntactically valid but malformed board is not atomic: the old
   assets are released before `loadBoard()` validates or finishes changing
   state.
4. Crafted asset hashes are accepted as archive path components and can be
   re-exported as traversal-style ZIP entries such as
   `assets/../escape.bin`.
5. A partially populated service-worker cache is allowed to activate and then
   delete the last complete cache.
6. Browser Save can report success and mark a board clean even when referenced
   asset bytes are absent.

The 167 automated tests all pass. Most remaining defects are in browser-owned
lifecycles—DOM events, IndexedDB, file pickers, service workers, and media
elements—which the current Node-only suite deliberately does not execute.

## Scope and method

Reviewed:

- all handwritten JavaScript under `web/assets/js/`;
- the HTML document, manifest, service worker, and CSS;
- `.mbrd`, ZIP, IndexedDB, autosave, and in-memory asset handling;
- all Node tests;
- `serve.py`, `qr.py`, `server.bat`, `save.bat`, and
  `tools/gen-formats.mjs`;
- `README.md`, `PLAN.md`, `REFACTOR.md`, and `CLAUDE_TASKS.md`.

The generated `web/assets/js/import/formats.js`, bundled fonts, and image assets
were checked for integration and cache coverage but not reviewed line by line
as authored source.

Checks performed:

- `npm test` — 167 passed, 0 failed;
- `node --check` on every `.js`/`.mjs` file — passed;
- `python -m py_compile serve.py qr.py` — passed;
- JSON parsing for `package.json` and `web/manifest.json` — passed;
- `git diff --check` — passed;
- local-server and headless Edge smoke test at 1440×1000 — the empty board,
  grid, axes, origin, menu, trash, zoom controls, and HUD rendered correctly;
- targeted in-memory reproductions described under the relevant findings.

The repository already contained substantial uncommitted work. This review
treated the current working tree as the product under review and changed only
this report.

## Severity

- **High** — security boundary, credible data loss/corruption, or a core
  offline/save guarantee can fail.
- **Medium** — user-visible correctness, recovery, accessibility, or scaling
  defect.
- **Low** — latent correctness, maintainability, documentation, or coverage
  debt with limited immediate impact.

---

## High-priority findings

### H1. Untrusted boards can write arbitrary CSS and make network requests

**Evidence**

- `web/assets/js/state.js:661-685` copies
  `data.settings.appearance.vars` from the parsed board without filtering keys.
- `web/assets/js/ui/appearance.js:188-198` runs
  `root.style.setProperty(key, value)` for every entry.
- `web/assets/js/ui/appearance.js:235-252` clamps `whimsy`, but neither
  `palette` nor the keys and values in `vars` are constrained.

Although the data model describes `vars` as CSS custom-property overrides, a
crafted board can supply ordinary properties:

```json
{
  "settings": {
    "appearance": {
      "vars": {
        "display": "none",
        "background-image": "url(https://example.invalid/opened)"
      }
    }
  }
}
```

`display:none` can make the app disappear immediately after open.
URL-bearing properties can issue an external request, contradicting the
local-only/privacy guarantee in `README.md:11-13`. This is CSS injection rather
than script execution, but it still crosses a meaningful trust boundary.

**Recommendation**

Define an explicit allowlist of appearance tokens and validate each value by
type/range before it reaches the DOM. At minimum, reject every key that is not
an approved `--mbrd`/design token; do not accept arbitrary properties merely
because the field is named `vars`. Add a restrictive CSP as defense in depth,
especially `connect-src`, `img-src`, `media-src`, and `font-src` rules that do
not allow arbitrary remote origins.

### H2. Declared-size ZIP limits do not bound actual inflation

**Evidence**

- `web/assets/js/storage/zip.js:298-309` applies entry, total, and ratio limits
  exclusively to the central directory's declared `usize`.
- `web/assets/js/storage/zip.js:54-56` converts the entire decompression stream
  to an `ArrayBuffer`.
- `web/assets/js/storage/zip.js:319-325` compares the actual length only after
  full inflation has completed.
- `totalOut` is likewise updated only after the allocation at
  `web/assets/js/storage/zip.js:337-338`.

A controlled reproduction created 8 MiB of zeros, which compressed to 8,157
bytes, then changed only the central-directory `usize` from 8,388,608 to `1`.
`readZip()` bypassed the ratio/size checks, inflated all 8 MiB, and only then
threw `"bomb.bin" failed to inflate cleanly`. Node reported roughly 25.9 MiB of
additional `ArrayBuffer` memory from the stream/copy pipeline.

A hostile entry can use the same mismatch at a much larger scale and exhaust a
browser tab before the post-inflate check runs. This is the exact case the
hardening comments at `zip.js:164-168` say should be prevented.

**Recommendation**

Read `DecompressionStream.readable` incrementally, count actual output bytes,
and cancel as soon as any of these is exceeded:

- the declared uncompressed size;
- the per-entry ceiling;
- the remaining archive-wide output budget;
- an actual-output compression ratio ceiling.

Do not collect the full result through `new Response(stream).arrayBuffer()`
until the counted stream has proved safe. Add a regression test whose declared
size is small but whose actual inflated output is large.

### H3. Failed board loading can partially replace the current board

**Evidence**

- `web/assets/js/storage/storage.js:206-217` considers unpacking successful,
  revokes the old board's URLs, and keeps the new asset registry before state is
  loaded.
- `web/assets/js/storage/storage.js:184-188` calls `loadBoard()` only after that
  asset-side commit.
- `web/assets/js/storage/mbrd.js:349-350` parses `board.json` but performs no
  schema validation.
- `web/assets/js/state.js:655-701` mutates the singleton `board` field by field;
  `(data.items || []).map(makeItem)` can throw after title, view, settings, and
  arrangement have already changed.

Reproduction:

1. Loaded `{title:"old", items:[{id:"keep", ...}]}`.
2. Called `loadBoard({title:"poison", items:{}})`.
3. The call threw `"(data.items || []).map is not a function"`, but
   `board.title` was already `"poison"` while the old `"keep"` item remained.

Through `openFile()`, the same class of malformed board also causes the old
object URLs to be revoked and the asset registry to switch before the partial
state failure. The comments at `storage.js:197-204` promise the opposite.

**Recommendation**

Validate and normalize `manifest.json` and `board.json` completely into a
detached candidate before touching global state or assets. Validate arrays,
unique IDs, finite coordinates/sizes/z values, settings, trash entries, asset
references, and bounded metadata. Commit the candidate state and candidate
asset map as one operation; if either commit can throw, retain enough state to
roll both back. Add malformed-schema tests in addition to malformed-ZIP tests.

### H4. Crafted content IDs are re-exported as traversal-style ZIP paths

**Evidence**

- `web/assets/js/storage/mbrd.js:387-395` accepts every path beginning with
  `assets/`, derives a supposed hash from the remaining filename, and registers
  it without validating its shape or the bytes it names.
- `web/assets/js/storage/mbrd.js:90-97` interpolates that value directly into a
  new ZIP entry name.
- `web/assets/js/storage/assets.js:25-37` accepts any string as a hash and does
  not verify that SHA-256 of the blob matches it.
- Note IDs are also interpolated into filenames at
  `web/assets/js/storage/mbrd.js:146-155`.

A crafted archive containing an item with hash `../escape` and an entry named
`assets/../escape.bin` opened successfully. Repacking the returned board
produced:

```text
manifest.json | board.json | assets/../escape.bin
```

The app itself never extracts that path to disk, but it can produce an archive
that a path-unsafe third-party extractor interprets outside its destination
directory. Failure to verify hashes also breaks the content-addressing,
deduplication, and waveform-by-hash invariants.

**Recommendation**

Require embedded hashes to match `/^[0-9a-f]{64}$/`; require canonical entry
names of `assets/<hash>[.<safe-ext>]`; reject separators, dot segments,
backslashes, control characters, duplicate hashes with different paths, and
unexpected nested paths. Hash the unpacked bytes and compare them with the
declared content ID before registering. Sanitize or encode item IDs before
using them in sidecar names.

### H5. A failed service-worker install can replace a complete offline shell

**Evidence**

- `web/sw.js:67-75` catches every individual `cache.add()` failure, so install
  succeeds with a partial or even empty new cache.
- `web/sw.js:68` calls `skipWaiting()`.
- `web/sw.js:79-84` activates that cache and deletes every cache whose name is
  not the new version.

A transient network failure or one bad response during update therefore leaves
the new worker installed, deletes the last known-good shell, and makes the PWA
unreliable precisely when it is offline. The structural test at
`tests/sw.test.js:39-53` proves that source paths exist in the repository; it
does not prove that an install populated the cache.

The activation filter also deletes caches belonging to other applications on
the same origin, because Cache Storage is origin-wide and the code does not
filter to the `mbrd-` prefix.

**Recommendation**

Populate a staging/versioned cache and fail installation if any required shell
entry fails. Only activate and delete the previous `mbrd-*` cache after the new
one is complete. Never delete cache names outside this app's namespace. A
service-worker integration test should simulate one rejected shell request and
assert that the previous version remains.

### H6. Browser Save can declare an incomplete board safe

**Evidence**

- `web/assets/js/storage/mbrd.js:331-397` does not check that every referenced
  embedded asset was actually found in the archive.
- `web/assets/js/storage/storage.js:323-329` silently skips a referenced hash
  missing from the in-memory asset store.
- `web/assets/js/storage/storage.js:332-343` still writes the session snapshot
  and returns `true`.
- `web/assets/js/storage/storage.js:51-57` then marks the board clean and shows
  `Saved in this browser`.
- `restoreSession()` at `storage.js:364-370` likewise loads the board when an
  IndexedDB asset record is absent or lacks a blob.

The explicit file export correctly refuses missing data in
`mbrd.js:69-87`, but the browser Save path does not share that invariant. A
corrupt `.mbrd`, a partial IndexedDB state, or a malformed asset reference can
therefore become a successful-looking clean browser save containing broken
cards.

**Recommendation**

Validate referential integrity during unpack and restore. Make `autosave()`
fail if any referenced embedded hash lacks bytes; do not write the new snapshot
or mark the board clean. If a degraded recovery mode is desirable, identify
the affected cards prominently and keep the board dirty until the user removes
or repairs them.

---

## Medium-priority findings

### M1. Clicking an item changes its stack order outside undo and dirty state

`startMove()` raises the selection immediately at
`web/assets/js/canvas/input.js:141-161`, before the pointer crosses
`DRAG_SLOP`. `finishGesture()` commits geometry only when `g.moved` is true
(`input.js:359-367`).

A simple click therefore changes every selected item's `z`, emits `geom`, but
creates no history entry and does not call `markDirty()`. A later unrelated
save may capture the change, while closing immediately may lose it. A second
finger that converts the gesture to pinch has the same pre-slop mutation.

Delay the raise until movement crosses the slop, or treat click-to-front as an
explicit undoable, dirty command. If click-to-front is not intended, restore
the `before` snapshot when a gesture ends without movement.

### M2. Crash recovery does not observe every persisted state change

Three paths fall outside the autosave event model:

1. `web/assets/js/main.js:104-109` writes `board.view.pan/zoom` on viewport
   changes but emits no state event. Closing after a pan/zoom restores an older
   view, despite `README.md:79-80` and `PLAN.md:200-203`.
2. `initStorage()` subscribes to `items`, `geom`, `item`, `settings`, and
   `board`, but not `trash` (`storage.js:386-389`). `emptyTrash()` emits only
   `trash` inside its command (`state.js:210-215`). If the board was already
   dirty and the prior debounce has fired, `markDirty()` is idempotent and no
   new `board` event schedules a snapshot.
3. Note text exists only in contenteditable DOM until `finish()` calls
   `setItemText()` (`canvas/notes.js:139-176`). Typing can call `growNote()` and
   trigger an autosave that records the new height with the old text. A crash
   or teardown that does not deliver a usable `focusout` loses the active edit.
   In-place rename has the same commit-on-blur shape in
   `canvas/items.js:240-275`.

Use a throttled/debounced view event, subscribe autosave to `trash`, and ensure
live editors update a draft in state or are synchronously flushed before a
snapshot/pagehide. Browser tests should close/crash while an editor is still
focused.

### M3. Cancelling the fallback Open picker leaves a pending operation

`pickViaInput()` resolves only from `change`
(`web/assets/js/storage/storage.js:221-236`). On browsers without the File
System Access API, cancelling a native file chooser commonly produces no
`change`; modern browsers expose a `cancel` event for this case.

The promise remains pending and the shared hidden input can retain
`.mbrd`/single-file settings. A later Add files action installs another path on
the same input, allowing stale Open and new content-import listeners to react
to the same selection.

Handle `cancel`, restore all input state on every exit, and retain a
focus-return fallback for engines without `cancel`.

### M4. Session restoration races the PWA file-launch consumer

`main.js:221-234` starts asynchronous `restoreSession()` immediately. Execution
yields at the first await, then `main.js:238-243` registers a `launchQueue`
consumer that can call `openFile()` concurrently.

If the OS supplies a launch file before IndexedDB restoration finishes, both
flows can load boards and register assets. The last `loadBoard()` wins, while
the shared asset registry can contain bytes from an interleaving of both.

Store the startup promise and make the launch consumer await it, or decide
before restoration whether a launch file is pending and skip session recovery
when one is.

### M5. Appearance overrides leak from one board into the next

`apply()` sets properties present in the new look but never removes inline
properties from the previous look (`ui/appearance.js:188-199`). The board event
handler also returns immediately when the new board has no custom look
(`appearance.js:97-103`).

Consequences:

- a board with custom `--accent` can contaminate a later palette-only board;
- opening a no-look board after a board-specific look retains the prior board's
  look instead of returning to the stored user preference;
- the controls can show values from `current` while stale inline properties
  still win in computed CSS.

Before switching, remove every property applied by the previous `current.vars`.
When a loaded board has no look, clone and apply the user's stored preference
rather than returning without changing anything.

### M6. The promised text renderer is absent

`classify()` returns `text` for text MIME types and many extensions
(`canvas/renderers.js:28-41`), and `defaultSize()` provides a text size
(`renderers.js:44-56`). But `RENDERERS` at `renderers.js:134-316` has no
`text` member, so `buildContent()` falls back to the generic card.
`readText()` is imported at `renderers.js:6` and never used.

This contradicts `README.md:48-58` and is already documented as unresolved in
`REFACTOR.md:336-346`. Implement the bounded text renderer or change product
copy and classification until it exists. Add a renderer-routing test so the
classification and renderer maps cannot drift again.

### M7. Media and DOM caches grow for the life of the tab

- `canvas/items.js:13-14` caches one node per ID.
- Culling at `items.js:52-69` detaches offscreen nodes but retains them and all
  media descendants in the map. Panning across a large board eventually
  retains every visited node, so memory—not connected DOM—is proportional to
  the visited board, contrary to the scaling implication in
  `README.md:115-120`.
- `canvas/audio.js:47-105` keeps every audio element ever built in a strong
  `Set`, including deleted items and old audio elements replaced during rename
  rebuilds.
- `audio.js:150-164` caches peaks per item, so two newly mounted cards that
  share one asset hash can decode the same recording concurrently despite the
  “once per file” claim.

Evict safely rebuildable offscreen nodes, preserve only active media state,
unregister deleted/rebuilt players, and cache measured/in-flight waveforms by
asset hash. A `WeakRef` alone is not a full lifecycle policy, but a strong
ever-growing set is avoidable.

### M8. Large imports are serialized and can stall for many minutes

`importFiles()` processes up to 500 files in a sequential loop
(`import/drop.js:131-173`). Each unreadable video can wait for the two-second
metadata timeout at `canvas/renderers.js:113-125`; 500 such inputs can therefore
consume roughly 1,000 seconds before any item is added. Hashing and
`arrayBuffer()` reads are also serialized.

Use bounded concurrency (for example 4–8 workers), report progressive results,
and allow cancellation. Avoid unbounded parallelism because each file can be
large.

Relatedly, the ZIP reader accepts a 2 GiB archive and 2 GiB expanded total
(`storage/zip.js:175-196`) while retaining the original archive, all output
entries, stream copies, and per-asset copies (`mbrd.js:393-395`). Those ceilings
are far beyond a realistic mobile or typical desktop tab. Revisit limits using
measured peak memory or move to incremental asset handling.

### M9. Undoing a delete does not restore trash entries evicted by that delete

`removeItems()` inserts the new entries, truncates trash to 60, and discards the
oldest entries (`state.js:153-170`). Its undo removes only the just-deleted
items from trash (`state.js:171-173`); it does not restore entries pushed out
by the truncation.

Reproduction from a 60-entry trash:

```text
after delete: 60 entries, previous oldest absent
after undo:   59 entries, previous oldest still absent
```

An undo command should reverse every state change its redo made. Capture the
evicted tail as part of the command and restore it on undo; reapply the same
eviction on redo.

### M10. Batch additions have ambiguous stack order

`addItems()` maps every draft through `makeItem()` before pushing any of them
(`state.js:134-142`). Each item therefore sees the same `topZ()` and receives
the same `z`.

This flattens the internal order of a multi-file import or duplicated pile and
contradicts the `itemsIn()` contract at `state.js:283-304`. The defect is
already asserted as current behavior in `tests/state.test.js:271-286` and
documented in `REFACTOR.md:353-363`.

Thread a running z through the batch. Replace the “known defect” assertion with
the intended invariant rather than leaving a passing test that locks in broken
behavior.

### M11. Autosave remains disabled after the user clears the failing board

Any IndexedDB/quota error permanently sets module-level `cacheOk = false`
(`storage/storage.js:314-349`). `newBoard()` clears the session
(`storage.js:243-250`) but never resets or probes `cacheOk`. Save and autosave
then return `false` for every later board until the page is reloaded, even if
clearing the old assets freed enough quota.

Reset the latch after a successful clear/new-board operation, or make it a
backoff/retry state rather than a permanent session-wide disable.

### M12. Original filenames do not survive a `.mbrd` round trip

The asset registry stores `name` (`storage/assets.js:28-35`) and
`renameItem()` relies on it to restore a cleared name
(`state.js:599-608`). `packBoard()` writes asset bytes and extension but no
original-name metadata (`storage/mbrd.js:90-97`), and unpack registers the blob
without `name` (`mbrd.js:387-395`).

After reopen, clearing a renamed item's name falls back to its current renamed
value rather than the original imported filename. Persist `originalName` in
asset metadata or on the item and cover rename → save → open → clear-name in a
round-trip test.

### M13. Core interactions have keyboard and assistive-technology gaps

- The global keydown handler excludes inputs/contenteditable but not buttons or
  links (`canvas/input.js:411-427`). Pressing Space on a focused sidebar or
  canvas control is prevented and enters pan mode instead of activating the
  control.
- Trash rows are non-focusable `<div>` elements and restoration exists only as
  pointer drag (`ui/trash.js:76-114`, `140-185`). A keyboard or screen-reader
  user can delete but cannot later choose and restore a specific entry.
- `#toast` has no `role="status"`/`alert` or `aria-live`
  (`web/index.html:254`), so save and failure messages are not announced.
- `user-scalable=no` (`index.html:5`) disables browser zoom in engines that
  honor it, which is harmful for low-vision users even though the canvas has
  its own zoom.
- The custom waveform slider has a role and label but no focusability, keyboard
  controls, or ARIA value attributes (`canvas/audio.js:292-299`).

Let native controls retain Space, provide a Restore button/action per trash
row, make status messages live, permit page zoom, and implement the ARIA slider
keyboard/value contract.

### M14. Development/release helpers can act on the wrong process or branch

`server.bat:11-14` force-kills whatever process listens on port 6273, explicitly
including unrelated software. A development launcher should fail with the PID
and command line or stop only a process it can identify as this repository's
server.

`save.bat`:

- stages the entire working tree before the commit prompt (`save.bat:94-102`);
- hardcodes `origin main` instead of the current branch
  (`save.bat:128`, `145`, `179`, `198`);
- offers raw `--force` rather than `--force-with-lease`
  (`save.bat:151-155`, `181-185`).

On a feature branch, the helper can commit there and then push a different
branch while reporting success. Resolve the current branch/remote, push
`HEAD`, preview the staged diff before confirmation, and use
`--force-with-lease` only after an explicit warning.

### M15. User-facing save and server documentation contradicts the code

- `README.md:21-22` says `server.bat` opens port 3000, while
  `server.bat:9`, `serve.py:18`, and `serve.py:29` use 6273.
- `README.md:77-80` says Save writes back to a `.mbrd` when the File System
  Access API exists. Current code and sidebar copy define Save as IndexedDB-only
  and Export as the file operation (`storage/storage.js:1-19`,
  `sidebar.js:54-58`).
- `storage/storage.js:34` still describes `fileHandle` as the handle “Save
  writes back to,” though only Export uses it.

The Save discrepancy is data-safety relevant: a reader can believe Ctrl+S
updated a durable file when it only updated browser storage. Align README,
comments, AGENTS instructions, and keyboard copy with the chosen product
contract.

---

## Low-priority findings

### L1. The declared dependency graph is not yet the actual graph

The repository says
`util/geometry ← state ← {import, storage, canvas} ← ui`, but:

- `state.js:19` imports `storage/assets.js`;
- `import/drop.js:11` imports `canvas/renderers.js`;
- `canvas/renderers.js:8` imports `import/formats.js`.

The latter two make the `import` and `canvas` subsystems mutually dependent.
This is a consequence of the deliberately deferred `import/types.js` split in
`REFACTOR.md:268-277`. Moving classification/measurement/default sizes into
`import/types.js` would restore the intended seam. Persisting an item's
original name directly would also remove state’s dependency on storage.

### L2. Browser lifecycles and tooling have little executable coverage

The test suite is valuable and broad for pure state, geometry, arrangements,
ZIP structure, `.mbrd` sidecars, and shell-list drift. It does not execute:

- IndexedDB transactions, quota failure, or restoration;
- file pickers and cancellation;
- `launchQueue`;
- pointer/keyboard gestures and contenteditable editors;
- service-worker install/activate/fetch behavior;
- media/node cleanup;
- appearance switching and CSS application;
- the Python server, QR encoder, or batch helpers.

`tests/imports.test.js:19-29` explicitly exempts the two DOM entry points, and
`tests/sw.test.js:25-29` source-parses the worker rather than running it. Add a
small browser integration layer for the critical open/save/recovery/offline
workflows and focused Python tests for routing/QR output. This does not need to
replace the fast dependency-free Node suite.

### L3. A literal NUL byte makes `canvas/web.js` look binary to tools

`canvas/web.js:68` uses a literal U+0000 as the thread-key separator. Node and
the browser accept it, but `rg` classifies the source as binary, and some
editors/diff/review tools will do the same.

Use the escaped spelling `'\0'` or `'\u0000'`. Also validate loaded IDs, because
the statement that the separator “cannot occur in an id” is true for `uid()`
but not for untrusted IDs read from JSON.

### L4. The ZIP writer does not enforce all non-ZIP64 field limits

`writeZip()` rejects individual payload and body offsets above 4 GiB, but it
writes `entries.length` into 16-bit EOCD fields without checking
(`storage/zip.js:138-145`). It also does not explicitly bound encoded entry
names to 65,535 bytes or validate central-directory size/final archive size.

Normal app-generated boards stay far below these limits, so this is latent.
Still, a minimal writer that explicitly rejects ZIP64 should reject every field
that would require it rather than silently truncate.

### L5. The development server hides real errors and canonicalizes too late

`serve.py:126-129` suppresses every `log_error()` call, although the comment
only justifies hiding aborted-connection noise. Genuine malformed requests and
handler failures become harder to diagnose.

`serve.py:50-66` percent-decodes and probes a joined filesystem path before
ensuring the resolved path remains under `ROOT`. `SimpleHTTPRequestHandler`
later normalizes what it actually serves, so no direct file-read path was found,
but the preflight filesystem probe should still resolve/canonicalize under the
document root before calling `isfile()`.

Log expected connection aborts narrowly and preserve other server errors.
Validate the resolved candidate with `os.path.commonpath()` (including
case-normalization on Windows) before probing it.

---

## Positive observations

- Link rendering uses a strict `http`/`https` allowlist, real DOM properties,
  `textContent`, and `noopener noreferrer`
  (`canvas/renderers.js:248-310`, `341-384`). No script/HTML injection path was
  found in item names, note text, link labels, trash rows, or context-menu
  labels.
- ZIP parsing now checks most structural offsets, duplicate names, methods,
  stored-size consistency, declared limits, and CRC32, with an extensive
  adversarial test set.
- File export fails before writing when referenced assets are missing and names
  the affected items.
- The fresh-asset-map idea in `unpackBoardFresh()` is sound; the transaction
  boundary simply needs to include schema validation and state commit.
- Preferences are consistently guarded against storage exceptions.
- Object URL handling explicitly accounts for the back/forward cache.
- The pure geometry consolidation, undo/clipboard/sticky tests, and service
  worker asset-list parity checks are strong regression protection.
- Source comments generally explain invariants and tradeoffs rather than
  restating code, which materially improved auditability.

## Suggested remediation order

1. Validate `.mbrd` schema, appearance tokens, canonical asset hashes/paths,
   content hashes, and referential integrity before committing any open.
2. Replace full-buffer inflation with an actual-output-capped stream.
3. Make open commit state and assets atomically.
4. Make service-worker installation transactional and cache deletion
   namespace-safe.
5. Make Save fail on missing assets and close the autosave event/editor gaps.
6. Fix click-to-front history, picker cancellation, and startup launch races.
7. Address text rendering, media lifecycle, import concurrency, and accessibility.
8. Harden the batch helpers, align documentation, and add browser lifecycle
   coverage.


---

## Resolution

Written after working through the findings above. The review's own text is
unchanged; this section records what was done about it.

`npm test` is now **210 passing, 0 failing** (167 when the review was written).
Every fix that could be covered by the dependency-free suite has a test that
fails without it.

### High

| | Fix |
|---|---|
| **H1** | `settings.appearance.vars` is filtered through a new `web/assets/js/ui/look.js`: an allowlist of the 74 tokens `tokens.css` declares, a value grammar that excludes `url(`, `\`, `;`, `}` and `@`, and a function allowlist so naming a resource is impossible by construction rather than by blocklist. Filtering happens in `clone()`, which every look — stored, board-supplied, or edited — already passed through. `palette` is shape-checked too. Split into its own module because `appearance.js` touches `document` at import and had to stay untestable. `tests/appearance.test.js` covers both attacks, proves a real look survives intact, and asserts the allowlist equals `tokens.css` — the same drift bargain as `SHELL`. |
| **H2** | `inflateRaw()` now reads `DecompressionStream.readable` incrementally against a byte budget and cancels the moment it is exceeded. The budget is the entry's *own declared size*, so a correct entry never trips it and a lying one costs only what it claimed. The post-inflate length check stays: the cap catches an entry that expands past its promise, not one truncated short. |
| **H3** | `loadBoard()` is two steps. `normalizeBoard()` builds a complete replacement out of whatever arrived and cannot throw — every container is checked for the shape it is about to be used as, and `makeItem()` was made total to match. Only then are the fields assigned, with nothing between them that can fail. On the storage side the old `unpackBoardFresh()` became `withFreshAssets(commit)` and now wraps `loadBoard()` as well as the unpack, so the asset registry and the board commit or roll back together. |
| **H4** | Content ids are held to `/^[0-9a-f]{64}$/` (`util.js/isHash`, shared by the two layers that need it) at both ends: `unpackBoard()` requires canonical `assets/<hash>[.<ext>]` names, rejects duplicates, and **verifies SHA-256 of the bytes against the name**; `packBoard()` re-checks before spelling a hash into a path. `state.js/makeItem` drops an asset reference whose hash is not a digest, so a crafted board degrades to a plain card instead of becoming unexportable. Note sidecars are only written for filename-safe ids — the text is in `board.json` regardless. |
| **H5** | Install is all-or-nothing: one failed `cache.add` deletes the staging cache and fails the install, so the new worker never activates and the previous shell stays live. `skipWaiting()` moved after success. Activation only deletes caches under the `mbrd-` prefix. `tests/sw.test.js` now *runs* both handlers against a fake Cache Storage, including the install→activate sequence — the four new cases were checked against the pre-fix worker to confirm they discriminate. |
| **H6** | `autosave()` collects referenced hashes with no bytes on disk and none in memory, and returns `false` — so `saveBoard()` does not mark the board clean and does not say "Saved in this browser". It still *writes* the snapshot, because recovering a board with one broken card beats recovering nothing, but stores it with `dirty` set. `restoreSession()` warns and keeps the board dirty when an asset record is missing. |

### Medium

**M1** the raise moved out of `startMove()` and into the first movement past
`DRAG_SLOP`, so a click no longer reorders the stack — and when it is a drag,
the z-change lands inside the same undo entry as the move. **M2** all three
paths: a debounced `view` event that `initStorage` subscribes to (without
marking dirty — panning is not editing), `trash` added to the same list, and
`flushNoteEdit()` called on `pagehide` and `visibilitychange`. **M3** `cancel`
plus a focus fallback, with every exit restoring the shared input. **M4** the
launch consumer awaits the startup promise. **M5** `apply()` tracks what it
wrote and removes what the new look does not set; a board with no look now
restores the user's stored preference instead of leaving the previous board's.
**M6** the text renderer exists — `.card-text` was already in `app.css`, waiting
— plus `tests/renderers.test.js`, which asserts every type `classify()` can
produce has a renderer. **M7** off-screen nodes are now discarded unless their
media is mid-playback, `releasePlayers()` unregisters players when a card is
destroyed or rebuilt, and in-flight waveform measurements are de-duplicated by
asset hash. **M8** imports run six at a time, in order, and the ZIP ceilings
were re-costed against actual peak memory (they implied over 6 GB). **M9** the
trash entries a delete pushes out are captured and restored by its undo.
**M10** was already fixed before the review landed. **M11** both latches reset
on `newBoard()`. **M12** the original filename rides on the item as
`meta.origName`, so it survives a round trip. **M13** all five: `role="status"`
on the toast, `user-scalable=no` gone, focused controls keep Space and Enter,
bin rows are focusable and restore on Enter, and the waveform slider has the
full keyboard and value contract. **M14** `server.bat` only kills a process it
can identify as this repo's server and reports anything else; `save.bat`
resolves the current branch and uses `--force-with-lease` behind an explicit
warning. **M15** README, `AGENTS.md` and the `fileHandle` comment now match the
code.

### Low

**L3**, **L4** and **L5** are fixed. **L2** is partly addressed — the service
worker, the appearance rules and renderer routing are now executed rather than
source-parsed — but there is still no browser integration layer and no Python
tests.

**L1 is deliberately not done.** Moving classification and measurement into
`import/types.js` would restore the intended seam, and it should happen; it is
pure organisation with no correctness payoff, and doing it in the same pass as
everything above would have made this change set much harder to review. It
remains specified in `REFACTOR.md` Phase 3.

### Not verified

Everything here is covered by `npm test` (210 passing), `node --check` on every
`.js`/`.mjs`, and `python -m py_compile` on both Python files. **None of it has
been exercised in a browser.** The changes with real interaction surface —
click-to-front, the note flush, the picker cancellation, bin restore by
keyboard, waveform seeking, the text renderer's appearance, and the offline
shell after a service-worker update — want the manual pass described under
Verification in `REFACTOR.md` before this is trusted.
