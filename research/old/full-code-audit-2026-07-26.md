# Full code audit — 2026-07-26

## Executive summary

This audit covers the complete browser application, its local Python server and
Windows helpers, the test suite, generated/static assets, offline behavior, and
the current working-tree changes layered over commit `9041621` (`v0.44`).

The codebase is unusually disciplined for a dependency-free browser
application. The ZIP parser, `.mbrd` integrity checks, service-worker install
transaction, board undo/trash logic, geometry, and DOM/CSS injection defenses
are all strong. The test suite is broad for pure logic and all shipped modules
remain importable outside a browser.

The principal risks are concentrated at the boundaries where asynchronous
browser APIs and untrusted files meet the otherwise pure core:

- IndexedDB write helpers report success before their transactions commit.
- Autosaves can overlap, finish out of order, and race clearing the working
  cache.
- File count limits are not paired with realistic byte, decoded-pixel, or model
  allocation limits.
- Loaded boards do not bound item count or require finite, positive geometry and
  unique IDs.
- Global canvas shortcuts remain active while a modal or context menu owns the
  keyboard.
- The adaptive dense-web controller is wall-clock dependent and its test is
  observably flaky.

I classify 6 findings as high severity, 7 as medium, and 4 as low. “High” here
does not imply remote code execution; it means a plausible path to lost or
misrepresented recovery state, destructive behavior, or tab-level resource
exhaustion.

## Snapshot and scope

The repository was actively being edited during the audit. The final checks
below describe the working tree observed after the new paper/measurement work
appeared, not only committed `v0.44`. No existing source or research file was
changed by this audit; this report is the only application-facing deliverable.

Inventory at the final pass:

| Area | Files | Lines | Reviewed for |
| --- | ---: | ---: | --- |
| JavaScript and tools | 49 | 19,258 | Architecture, correctness, security, persistence, lifecycle, performance |
| CSS | 4 | 4,406 | Token safety, focus/touch behavior, responsive structure, offline inclusion |
| HTML | 2 | 539 | Semantics, boot behavior, forms/dialogs, script/style loading |
| Python | 2 | 538 | Path confinement, serving behavior, QR generation, network exposure |
| Tests | 20 | 4,569 | Coverage, determinism, structural guarantees, missing boundary tests |
| Other | service worker, manifests, batch files, docs | — | Offline updates, release workflow, deployment assumptions |

No third-party package audit was necessary: `package.json` declares no runtime
or development dependencies. Vendored fonts and the optional media encoder were
reviewed as release assets instead.

## Verification performed

| Check | Result |
| --- | --- |
| `npm test` on the final tree | **421 passed, 1 failed, 422 total** |
| Repeated full-suite runs | Adaptive dense-web test failed intermittently |
| Focused repetition | 2 observed failures in 30 runs; one failed after 16 consecutive passes |
| JavaScript parse check | 49/49 files passed `node --check` |
| Python parse check | `serve.py` and `qr.py` compiled successfully in memory |
| `git diff --check` | Passed; only existing CRLF conversion warnings |
| Node experimental coverage | 60.08% lines, 86.06% branches, 50.61% functions |
| Headless Edge startup | Passed in a fresh isolated profile; `window.mbrd` present and `v0.44 ready` logged |
| Headless Edge modal-key test | Failed behaviorally: ArrowRight on the focused Cancel button moved the selected card from x=0 to x=1 behind the open modal |
| IndexedDB transaction mock | Confirmed a write promise resolves before the mocked transaction completes |
| Service-worker shell parity | Passed through the structural and behavioral tests |
| Import graph | No circular dependency found by the existing graph; several declared layer inversions found |

Coverage is strongest in geometry, state, archive parsing, `.mbrd` packing, mesh
happy paths, palette generation, and layout. It is weakest precisely where the
highest-risk findings live:

- `canvas/input.js`: 8.04% lines in the diagnostic coverage run
- `storage/storage.js`: 35.75% lines, 0% functions
- `storage/idb.js`: 39.13% lines, 0% functions
- `import/drop.js`: 28.55% lines, 0% functions
- `ui/dialog.js`: 29.45% lines, 0% functions
- `optimize/media.js`: 57.87% lines, 0% functions
- `optimize/optimize.js`: 39.93% lines, 0% functions

The “0% functions” values are an artifact of importing modules without driving
their browser APIs, not evidence that the files are unused.

## Severity rubric

- **High:** Can lose, regress, falsely report, or unexpectedly delete working
  data; or can exhaust a browser tab with a file that passes current front-door
  checks.
- **Medium:** Material correctness, accessibility, availability, or maintenance
  issue with a narrower trigger or a recoverable result.
- **Low:** Defense-in-depth, release hygiene, or lifecycle weakness unlikely to
  harm a typical session by itself.

## Findings

### AUD-01 — IndexedDB writes resolve before transaction commit

**Severity:** High
**Area:** Persistence correctness
**Evidence:** `web/assets/js/storage/idb.js:27-39`, especially line 34

`tx()` resolves any request-backed operation from `req.onsuccess`. For
`put()`, `delete()`, and `clear()`, request success only means the operation was
accepted within the transaction. The transaction may still abort afterward.
Because the returned promise is already fulfilled, `t.onerror` or `t.onabort`
cannot turn that apparent success into a failure.

All three write exports use that path:

- `idbSet()` at line 43
- `idbDel()` at line 44
- `idbClear()` at line 46

A targeted transaction mock confirmed `idbSet()` resolved while the
transaction-complete event had not fired. This invalidates the durability
assumption made by autosave, cache sweeping, new-board clearing, and
clear-everything.

**Impact**

- The UI can report “Saved in this browser” before bytes are durable.
- The autosave sweep can proceed after a write request succeeds but before the
  containing transaction later aborts.
- Clearing can report completion even if a transaction later fails.

**Recommendation**

Capture the request result, but resolve write operations only from
`transaction.oncomplete`. Reject from request error, transaction error, and
abort exactly once. Add a real-browser test that aborts a write transaction
after request success and asserts that the public promise rejects.

### AUD-02 — Autosaves can overlap and commit stale snapshots out of order

**Severity:** High
**Area:** Persistence ordering
**Evidence:** `web/assets/js/storage/storage.js:387-396`,
`web/assets/js/storage/storage.js:454-525`, `web/assets/js/main.js:531-543`

The debounce controls only when an autosave starts. There is no single-flight
promise, generation number, queued rerun, or stale-writer check once
`autosave()` is running. Lifecycle flushing also calls autosave directly.

A plausible ordering is:

1. Save A serializes the board and waits while querying or writing assets.
2. The board changes and save B starts.
3. Save B writes its newer snapshot.
4. Save A resumes, writes the older snapshot, then sweeps assets according to
   the older reference set.

The early IndexedDB resolution in AUD-01 enlarges this window, but fixing that
helper alone does not serialize the full multi-step save.

**Impact**

- Reload recovery can regress to an older board.
- A stale sweep can delete an asset referenced only by the newer snapshot.
- A successful later edit can be followed by a stale “success.”

**Recommendation**

Use one autosave coordinator:

- At most one save may run.
- Changes during a save set a `rerun` flag or increment a generation.
- Completion immediately runs the newest generation.
- Stale generations never publish a snapshot or sweep.

Prefer preparing in-memory data first, then committing assets, session record,
and sweep in one read/write transaction spanning both stores. Add a delayed
fake-IDB or browser test that forces A/B completion inversion.

### AUD-03 — New/clear operations race in-flight saves and hide deletion failure

**Severity:** High
**Area:** Destructive operations and privacy
**Evidence:** `web/assets/js/storage/storage.js:316-342`,
`web/assets/js/storage/storage.js:595-597`,
`web/assets/js/storage/storage.js:626-650`

`clearAllData()` cancels the debounce and sets `cacheOk = false`, but an
autosave already past its initial `cacheOk` check continues. It can repopulate
IndexedDB after `clearSession()` starts or completes. `newBoard()` has the same
class of race and later re-enables caching.

Separately, `clearSession()` catches every failure and returns no status:

```js
try { await idbClear('kv'); await idbClear('assets'); }
catch { /* nothing to clear */ }
```

The caller then clears preferences, reloads, and returns `true`, even when user
data may remain. Combined with AUD-01, even awaited clears are not currently
transaction-complete guarantees.

**Impact**

- “Clear everything” may not clear everything.
- A supposedly new board may restore old data after reload.
- Storage errors are indistinguishable from “there was nothing to clear.”

**Recommendation**

Introduce a persistence barrier/generation shared by autosave and destructive
operations. A clear should invalidate pending generations, await the active
writer, perform verified transaction-complete clears, and surface failure
instead of reloading. Add browser tests for clear during a blocked autosave and
for an aborted clear transaction.

### AUD-04 — Oversized ZIP Blobs are fully allocated before the size check

**Severity:** High
**Area:** Hostile-file resource use
**Evidence:** `web/assets/js/storage/zip.js:276-295`

For a `Blob` or `File`, `readZip()` calls `source.arrayBuffer()` at line 288.
Only after that full allocation does it compare the byte length with the 768
MiB archive limit at line 293. A file whose cheap `Blob.size` already proves it
will be rejected can therefore exhaust memory before the intended error is
reached.

The documented accepted worst case is also too high for the intended phone/PWA
environment:

- Archive: 768 MiB
- One inflated entry: 512 MiB
- Total inflated entries: 768 MiB
- Commented peak: approximately archive + 2 × inflated total, about 2.3 GiB

The parser’s structural checks, duplicate rejection, CRC validation, declared
and actual inflate limits, and path/hash validation are otherwise excellent.

**Recommendation**

Check `Blob.size` before `arrayBuffer()`. Set platform-realistic memory budgets,
with a materially lower mobile default. Longer term, parse central-directory
metadata from slices and inflate/process entries incrementally so the full
archive and all outputs do not coexist.

### AUD-05 — Ordinary imports have a count cap but no aggregate byte/decode budget

**Severity:** High
**Area:** Import availability and memory
**Evidence:** `web/assets/js/import/drop.js:203-305`,
`web/assets/js/storage/assets.js:41-49`,
`web/assets/js/canvas/renderers.js:132-145`,
`web/assets/js/optimize/picture.js:56-80`

The importer caps a batch at 500 files and sensibly limits preparation to six
workers. It does not cap:

- Per-file bytes
- Aggregate bytes in one import
- Aggregate bytes already resident on the board
- Decoded image dimensions or pixel count before `createImageBitmap()`
- Concurrent decoded-memory cost

`addFile()` reads each entire file into an `ArrayBuffer`, hashes it, and creates
a `Blob`. Image measurement and optimization decode before applying output-size
limits. Six compressed “dimension bomb” images or very large videos can consume
far more memory than their file sizes suggest.

**Recommendation**

Create one shared import-budget policy covering raw bytes, decoded pixels,
model allocations, and concurrency. Preflight `File.size`; inspect image
headers for dimensions where practical; reject or sequentialize work that
exceeds the remaining budget. Keep the 500-file UX cap, but do not treat it as
a memory boundary.

### AUD-06 — glTF accessors allocate from untrusted counts before validation

**Severity:** High
**Area:** Model import availability
**Evidence:** `web/assets/js/import/mesh.js:482-514`,
`web/assets/js/import/mesh.js:552-581`,
`web/assets/js/import/mesh.js:585-594`

`readAccessor()` allocates a typed array of `acc.count * components` at line
560 before validating that:

- `count` is finite, integral, non-negative, and within a project limit
- The accessor’s last element fits its buffer view
- Multiplication is safe
- The eventual primitive can fit the triangle limit

The 2,000,000-triangle check happens only after position, normal, and index
accessors have been allocated. Embedded data URIs also pass through `atob()` and
another same-size typed array without a byte cap.

The cycle guard in `walkNode()` is correct for cyclic graphs, but a deeply
nested acyclic node tree still uses one JavaScript stack frame per node and can
overflow the call stack.

**Recommendation**

Validate all scalar fields and byte ranges before allocating. Derive the
maximum legal accessor count from the mesh budget and the buffer view. Cap
embedded buffer bytes. Traverse nodes iteratively with an explicit stack and a
node/depth ceiling. Add fixtures for huge counts, multiplication overflow,
invalid stride/offset, huge data URIs, and deep acyclic trees.

### AUD-07 — Loaded board state permits unbounded collections and invalid geometry

**Severity:** Medium
**Area:** File-open robustness and state invariants
**Evidence:** `web/assets/js/state.js:104-125`,
`web/assets/js/state.js:1352-1419`,
`web/assets/js/canvas/items.js:17`, `web/assets/js/canvas/items.js:248-280`

`makeItem()` uses `+value || fallback` for x, y, width, height, and rotation.
`Infinity` is truthy and survives. Negative dimensions survive. IDs are merely
nonempty strings truncated to 64 characters.

`normalizeBoard()` maps every object in `items` and `trash` without:

- Maximum item/trash counts
- Unique-ID enforcement
- Finite and bounded positions/rotation
- Positive bounded dimensions
- A title length cap
- A known item-type allowlist

Duplicate IDs conflict with the renderer’s module-level `Map`, selection,
`byId()` first-match behavior, and DOM identity. Infinite coordinates can poison
bounds, fit, placement, and transform calculations. Very large arrays amplify
DOM and autosave costs even when the ZIP byte limit is respected.

**Recommendation**

Define persisted-state invariants centrally and enforce them both on load and
creation:

- finite positions and rotations within a generous coordinate range
- positive size within existing item limits
- unique normalized IDs, regenerating collisions deterministically
- explicit item/trash/title limits
- known type or explicit generic fallback

Report dropped/adjusted content to the user. Add state tests for Infinity,
negative sizes, duplicate IDs, huge arrays, and oversized strings.

### AUD-08 — Canvas keyboard shortcuts mutate the board behind modal UI

**Severity:** Medium
**Area:** Correctness and keyboard accessibility
**Evidence:** `web/assets/js/canvas/input.js:718-779`,
`web/assets/js/ui/menu.js:34-41`

The global keydown listener exempts text inputs and lets native controls keep
Space/Enter. It does not check:

- `event.defaultPrevented`
- whether the `<dialog>` is open
- whether a menu or other overlay owns focus
- whether the event originated inside non-canvas chrome

This was reproduced in a real headless Edge session:

1. Add and select a note at x=0.
2. Open “Clear everything?”
3. Focus the modal’s Cancel button.
4. Press ArrowRight.
5. The note moves to x=1 while the modal remains open.

Delete, Backspace, F, 0, zoom, and other shortcuts have similar leakage.
Context-menu ArrowUp/ArrowDown is especially clear: the menu’s capture listener
prevents the event and moves focus, but the later canvas listener ignores
`defaultPrevented` and can also nudge the selection.

**Recommendation**

Return immediately when `e.defaultPrevented`. Disable non-global canvas
shortcuts while a modal/menu owns interaction. Define which modified shortcuts,
if any, remain global during dialogs. Add browser tests covering Arrow, Delete,
Space, Escape, and Ctrl/Cmd shortcuts in dialogs, menus, sidebar controls, and
note editors.

### AUD-09 — Canvas cards are not keyboard-selectable or individually named

**Severity:** Medium
**Area:** Accessibility
**Evidence:** `web/assets/js/canvas/items.js:248-280`,
`web/assets/js/canvas/items.js:325-331`

Cards are plain `<div class="item">` elements with no role, tabindex, or
accessible name. Keyboard users can tab to each item’s menu button, but every
button is named only “Actions,” so a board exposes a sequence of
indistinguishable controls. Keyboard selection, multi-selection, direct
navigation, and F2/Delete/nudge all depend on selection that normally begins
with a pointer.

The application otherwise shows strong accessibility intent: real buttons,
native dialog use, labels, reduced-motion handling, focus styles, and
touch-sized controls are present.

**Recommendation**

Use a roving-tabindex canvas-item model or an accessible parallel navigator.
Give each card an appropriate role and a name derived from type/name, expose
selected state, and name its menu “Actions for {item name}.” Test keyboard-only
add, select, rename, move, delete, restore, and menu use.

### AUD-10 — Optional media-worker jobs can remain pending forever

**Severity:** Medium
**Area:** Worker lifecycle and optional optimization
**Evidence:** `web/assets/js/optimize/media.js:80-103`,
`web/assets/js/optimize/media.js:155-177`

Each `ask()` call listens only for a matching message. It has no timeout,
`error`, `messageerror`, termination, or cancellation path. If the worker
crashes during an encode, the promise never settles and the optimization UI can
remain busy indefinitely.

The boot error listener rejects only the `ready` promise. A rejected module-level
`ready` is retained, so later attempts cannot respawn a worker. Listeners are
also not cleaned up on all failure paths.

This feature is currently dormant when the FFmpeg bundle is absent, which
reduces present exposure but does not make the lifecycle sound.

**Recommendation**

Manage jobs in an ID-to-promise map, reject every job on worker error,
messageerror, or termination, use a bounded timeout/cancel path, clean
listeners, terminate the failed worker, and reset `ready`/`worker` so a later
attempt can retry.

### AUD-11 — Adaptive dense-web behavior and its test depend on wall-clock noise

**Severity:** Medium
**Area:** Determinism, CI reliability, visual stability
**Evidence:** `web/assets/js/canvas/web.js:531-648`,
`tests/web.test.js:161-182`

The dense limit learns from `performance.now()` measurements of tree and pass
cost. That makes behavior depend on scheduler load, CPU scaling, test-runner
warmup, and unrelated work. The test expects the last ten values to settle to
one number, but repeatedly observed two adjacent plateaus:

```text
461 461 461 461 461 461 461 384 384 384
```

The final audit run failed this test. Across repeated runs, two failures were
seen in 30 attempts.

This is more than a brittle assertion: the runtime threshold can also change
based on incidental frame timing, producing different web detail on equivalent
boards.

**Recommendation**

Inject the clock/cost sampler so controller math can be tested with deterministic
measurements. Use hysteresis and a minimum observation window in production.
Test bounds, convergence, and response to controlled slow/fast samples instead
of measuring the host running the tests.

### AUD-12 — Declared module layering is already inverted in several places

**Severity:** Medium
**Area:** Architecture and testability
**Evidence:** import statements in the named files

The repository guideline declares:

```text
util/geometry ← state ← {import, storage, canvas} ← ui
```

with canvas allowed to reach into import only for the generated format catalog.
The current graph is acyclic, but these imports violate that policy:

- `state.js` → `storage/assets.js`
- `storage/storage.js` → `ui/dialog.js`
- `import/drop.js` → `canvas/renderers.js`
- `import/drop.js` → `storage/storage.js`
- `canvas/model.js` → `import/mesh.js`
- `canvas/renderers.js` → `import/mesh.js`

The large orchestration modules compound the problem: `state.js`,
`ui/appearance.js`, `canvas/input.js`, `canvas/web.js`, and
`storage/storage.js` hold many distinct responsibilities. Browser-only
dependencies then make their important functions difficult to exercise in
Node.

**Recommendation**

Do not fix this with path shuffling alone. Extract layer-neutral capabilities:

- asset interface supplied to state
- pure file classification/measurement shared by import and canvas
- storage service returning decisions/errors rather than opening UI
- pure mesh core in a neutral module
- persistence coordinator separate from dialogs and browser handles

Add an import-boundary test so the intended direction is executable policy.

### AUD-13 — Browser boundary behavior lacks regression coverage

**Severity:** Medium
**Area:** Testing strategy
**Evidence:** coverage results and `tests/imports.test.js`

The module-import structural test is valuable, but it can make browser-heavy
files look exercised without invoking their functions. There are no automated
behavior tests for:

- Real IndexedDB transaction completion, quota, abort, or version change
- Overlapping autosaves and clear/save races
- File System Access cancellation and write failure
- Modal/context-menu keyboard isolation
- Object URL lifecycle
- Service-worker fetch behavior against multiple same-origin caches
- Worker crash/timeout recovery
- A complete add → autosave → reload → restore workflow

The modal defect and IDB defect both passed the normal suite for this reason.

**Recommendation**

Keep the fast Node suite and add a small browser smoke layer using an already
available browser in CI. Focus on a dozen high-value boundary flows rather than
duplicating pure tests. Make the persistence coordinator and input policy
dependency-injectable so most ordering cases stay deterministic and fast.

### AUD-14 — Runtime cache lookup is not scoped to the active app cache

**Severity:** Low
**Area:** Offline correctness
**Evidence:** `web/sw.js:148-165`

Install and activation correctly use the versioned `mbrd-*` namespace and
install the shell transactionally. Runtime lookup uses global
`caches.match(...)`, however, which searches every cache for the origin. On a
shared origin, a stale response from another service worker/cache can satisfy
the request. The runtime `cache.put()` is also not passed to `event.waitUntil()`
or awaited, so a worker termination can drop it and a rejection can become
unhandled.

**Recommendation**

Open the active `VERSION` cache and call `cache.match()` on that instance.
Await or `waitUntil()` the put while still returning the network response.
Extend the service-worker test with an unrelated same-origin cache containing a
conflicting URL.

### AUD-15 — The pre-paint appearance path bypasses the normal token sanitizer

**Severity:** Low
**Area:** Defense in depth
**Evidence:** `web/index.html:21-32`,
`web/assets/js/ui/appearance.js:355`, `web/assets/js/ui/look.js`

The module path correctly filters custom properties through `safeVars()`. The
inline anti-flash script directly applies every key/value found in
`localStorage`. Under normal use that storage contains already-sanitized data,
but a poisoned same-origin store can apply arbitrary CSS custom properties
before the module corrects them, including values capable of initiating a
resource request through CSS use.

This is not a `.mbrd` injection path and is low risk in the current local-first
deployment. It is still a second security rule for the same data.

**Recommendation**

Generate a small bootstrap-safe allowlist shared with `look.js`, or store only a
validated compact appearance record and validate names/value grammar inline
before first paint. A strict CSP would add useful deployment defense, but the
current inline script would first need a hash/nonce or an external equivalent.

### AUD-16 — IndexedDB connection lifecycle is not recoverable

**Severity:** Low
**Area:** Browser lifecycle
**Evidence:** `web/assets/js/storage/idb.js:10-24`

`dbPromise` remains permanently rejected if the first open fails. A successful
connection is not closed on `versionchange`, and `blocked` is not surfaced.
These cases are uncommon with a single-version local app, but they matter during
upgrades, privacy-mode changes, and multiple open tabs.

**Recommendation**

Reset `dbPromise` on open failure, close and clear it on `versionchange`, expose
blocked/upgrade errors, and permit a later operation to retry.

### AUD-17 — Release provenance for Geist fonts is incomplete

**Severity:** Low
**Area:** Distribution hygiene
**Evidence:** `web/assets/css/fonts.css:59-89`, `web/assets/fonts/`

Fraunces includes `fraunces-OFL.txt` and an in-source license note. Geist and
Geist Mono are shipped as font files, but no adjacent Geist license/provenance
file was found. This is not an application runtime defect, but public
distribution should carry the required notice for every bundled asset.

**Recommendation**

Record the exact Geist source/version and include its license/copyright notice
beside the font assets. Add a short third-party-assets manifest so this remains
auditable when assets change.

## Positive findings

The following areas were specifically checked and did not produce an actionable
defect:

- ZIP parsing performs central-directory bounds checks, rejects duplicate
  names and unsupported methods, validates CRCs, enforces declared and actual
  inflate budgets, and has adversarial tests.
- `.mbrd` opening verifies asset paths, digest-shaped IDs, content hashes, and
  duplicate content under different extensions.
- Fresh-asset staging prevents a partially opened board from contaminating the
  live asset store.
- Export refuses referenced assets whose bytes are unavailable instead of
  claiming a complete save.
- Notes and waveform sidecars round-trip without mutating live items.
- DOM construction uses `textContent`/created nodes for untrusted content; the
  observed `innerHTML` uses are fixed application SVG.
- External links are constrained to HTTP(S) and opened with
  `noopener,noreferrer`; YouTube IDs are strictly parsed and embeds are
  sandboxed and created only on user action.
- Board appearance values use a token allowlist and value grammar on the normal
  load/application path.
- The local Python server’s filesystem path check keeps decoded paths inside
  `web/`; SPA fallback does not expose arbitrary repository files.
- Service-worker shell install is all-or-nothing, activation deletes only older
  app caches, and tests require every shipped asset to appear in `SHELL`.
- Undo/redo, bounded trash, sticky relations, arrangement determinism, geometry,
  hashes, formats, and mesh transforms have substantial pure-logic coverage.
- File import preparation has bounded concurrency, preserves input order, and
  reliably ends the busy indicator in `finally`.
- The code has no package-manager dependency or bundler supply-chain surface.

## Deployment and operational notes

`serve.py` binds to the LAN by design and has no authentication or TLS. That is
appropriate for the documented local workflow, but it should be treated as a
trusted-network development server, not an internet-facing production server.
If it is ever exposed beyond a trusted LAN, add explicit host/origin policy,
security headers, request limits, and a hardened production server.

`save.bat` still stages with `git add .` and does not run the test suite before
versioning/commit/push. It does show proposed changes and the repository has no
build step, so this is an operational footgun rather than a code defect.
Consider calling `npm test` before the version bump and requiring an explicit
confirmation of the staged file list.

`window.mbrd = { board, bus, vp, cmds, selection }` in `main.js:525` exposes
mutable application internals to any same-origin script and browser-console
snippet. It is useful for diagnostics and enabled the smoke test in this audit.
For hosted production, consider gating it behind development-host detection or
exposing a read-only diagnostic snapshot.

## Prioritized remediation plan

### 1. Make persistence truthful and ordered

Address AUD-01, AUD-02, and AUD-03 as one change. A correct transaction helper,
single-flight save coordinator, and clear barrier need a shared design; fixing
them separately risks preserving a race between individually improved pieces.
Add deterministic ordering tests before changing user-visible save messages.

### 2. Establish one resource-budget policy

Address AUD-04, AUD-05, AUD-06, and the relevant part of AUD-07 together.
Define explicit budgets for raw bytes, decompressed bytes, decoded pixels,
accessor elements, tree nodes/depth, and item count. Make error messages name
the exceeded limit and keep existing graceful per-file failure behavior.

### 3. Isolate keyboard ownership

Fix AUD-08 first because it has a small, testable surface and destructive keys
are involved. Then implement a keyboard-accessible card/navigation model for
AUD-09. Browser tests should drive both changes.

### 4. Remove nondeterministic timing from tests and policy

Inject cost/clock inputs into the dense-web controller and add hysteresis.
Restore a consistently green `npm test` before relying on it as a release gate.

### 5. Create browser boundary tests and enforce layers

Add the compact browser suite described in AUD-13, then extract the persistence
and input policies behind testable interfaces. Add a layer-rule test before
moving modules so the target architecture cannot silently regress.

### 6. Finish lifecycle and release hardening

Handle worker failures, scope runtime cache access, harden the pre-paint path,
repair IndexedDB reconnect behavior, and include missing asset provenance.

## Suggested acceptance tests for the first remediation milestone

Persistence work should not be considered complete until all of these pass:

1. A write request succeeds, its transaction aborts, and the public save
   promise rejects.
2. Save A is delayed, save B starts and finishes, then A is released; reload
   restores B and B-only assets remain.
3. An edit occurs during a save; exactly one follow-up save writes the newest
   generation.
4. “Clear everything” begins during a blocked autosave; after both settle and
   reload, no session, assets, or preferences remain.
5. A clear transaction aborts; the UI reports failure and does not reload or
   claim success.
6. Two tabs trigger `versionchange`; the old connection closes and a later
   operation reconnects.
7. Quota failure leaves the board dirty, identifies export as the safe path, and
   a later retry can recover when storage becomes available.

## Bottom line

The core file format and pure board logic are in good shape, and several risks
identified in older reviews—partial service-worker installs, incomplete exports,
unsafe look values, and under-checked ZIP inflation—are now well defended.

The application should not yet treat browser autosave as a fully reliable
recovery guarantee, and its current file limits are not a sufficient memory
safety boundary for large or hostile input. Persistence serialization and
resource budgeting are the two changes with the highest return. The modal-key
leak and flaky dense-web controller are smaller, directly reproducible defects
that should be fixed alongside them to restore trustworthy interaction and a
stable release gate.
