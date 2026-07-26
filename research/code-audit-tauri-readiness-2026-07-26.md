# mbrd code audit and Tauri readiness review

Date: 2026-07-26  
Audited revision: `9041621dfc116c0f55c6d91edb0e5854f0b9b43c` plus the uncommitted working tree present during the review  
Targets: browser/PWA, Android, Windows, macOS, Linux  
Scope: application JavaScript, CSS and HTML; `.mbrd` and ZIP handling; storage and recovery; import/media pipelines; Python development server; tests; architecture and release posture

## Executive summary

mbrd is a mature browser application with unusually good pure-logic tests, a carefully hardened ZIP reader, content-addressed assets, safe DOM construction, and clear architectural intent. It is not yet ready to ship as a privileged multi-platform Tauri application.

There are no confirmed critical remote-code-execution defects in the current browser app. The principal release blockers are:

1. IndexedDB writes resolve before their transactions commit, while autosaves can overlap. An older save can land after a newer save, and an in-flight save can race a destructive clear.
2. Untrusted archives, imports, and glTF files can allocate very large amounts of memory before meaningful limits take effect. The current ZIP ceiling admits a documented worst-case peak near 2.3 GB.
3. Browser-specific file, persistence, lifecycle, link-opening, and service-worker behavior is mixed into application modules. A Tauri wrapper added directly to those modules would create a brittle web/native fork.
4. A native security boundary has not been designed yet: there is no Tauri CSP, capability set, command scope, or navigation policy.
5. The suite is not deterministic at present. The full run failed the adaptive dense-web test, while the same test passed alone and the instrumented coverage run passed all tests.

Recommended decision: keep the present web UI and domain logic, but do not start by sprinkling `window.__TAURI__` checks through it. First harden persistence and hostile-input handling, then introduce explicit platform ports with web and Tauri adapters. Initially let Rust own native file handles, atomic writes, lifecycle events, and recovery storage. Move archive streaming and hashing into Rust after a cross-runtime conformance suite exists.

## Audit method and limitations

The review used:

- full repository and dependency-direction inspection;
- a generated code/document graph;
- targeted source review of trust boundaries, storage ordering, parsers, navigation, lifecycle, accessibility, and browser-only APIs;
- the repository's complete Node test suite;
- Node's built-in coverage instrumentation;
- `git diff --check`;
- syntax compilation of `serve.py` and `qr.py`;
- current official Tauri v2 documentation for WebViews, security, files, mobile associations, testing, and distribution.

The worktree was actively changing during the audit. For example, an early test run saw a service-worker shell mismatch for a newly added module; that mismatch was fixed by the final run without changes from this audit. Findings and line references describe the final observed working tree, not only the named commit.

No browser GUI, Tauri binary, Android emulator, or packaged application existed to exercise. Runtime DOM, codec, install, signing, file-association, and lifecycle claims therefore remain recommendations until those targets exist.

## Verification snapshot

| Check | Result |
| --- | --- |
| `npm test` | 382 tests: 381 passed, 1 failed |
| Current failure | `tests/web.test.js:169`, “the dense limit stays inside its bounds and settles” |
| Isolated rerun of that test | Passed |
| Coverage-instrumented full run | All 382 passed |
| Instrumented aggregate coverage | 59.84% lines, 86.50% branches, 49.33% functions |
| `git diff --check` | Passed; only CRLF-to-LF warnings |
| Python syntax check | `serve.py` and `qr.py` passed |
| Dependency audit | Not applicable to the current app: `package.json` declares no dependencies |

The coverage headline is optimistic for browser-facing code because importing a module counts top-level lines while many functions are never executed. Particularly important gaps are:

- `storage/storage.js`: 37.20% lines, 0% functions;
- `storage/idb.js`: 39.13% lines, 0% functions;
- `import/drop.js`: 29.39% lines, 0% functions;
- `canvas/input.js`: 6.09% lines, 0% functions;
- `canvas/items.js`: 34.53% lines, 0% functions;
- `optimize/media.js`: 57.87% lines, 0% functions.

The pure parsers and state model are much better covered: `storage/zip.js` reached 95.98% line coverage, `storage/mbrd.js` 96.42%, `import/mesh.js` 97.78%, and `state.js` 87.44%.

## What is already strong

- The ZIP reader validates directory bounds, local offsets, methods, duplicate names, declared sizes, expansion ratio, aggregate expansion, actual inflate length, and CRC. The associated adversarial tests are valuable.
- `.mbrd` assets are content-addressed, deduplicated, hash-verified on open, and required to exist before export succeeds.
- User-controlled card text is assigned with `textContent`. The audit found no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval`, `new Function`, or `document.write`.
- Link URLs are parsed and scheme-restricted before becoming anchors, with `noopener noreferrer`; YouTube IDs are constrained and the iframe is sandboxed (`canvas/renderers.js:339-386`, `canvas/embed.js:114-139`).
- Appearance tokens and font family names have explicit allowlists and tests.
- The structural tests keep most modules importable without a browser and keep shipped assets synchronized with the service-worker shell.
- The application has no runtime npm dependency or bundler today, reducing its current supply-chain and build complexity.
- `serve.py` confines resolved paths to `web/` before probing them.
- The code comments frequently document invariants and failure modes. These should be preserved when code is split into platform layers.

## Prioritized finding register

Severity describes impact in the intended local-first native application, not exploitability over the public internet.

| ID | Severity | Finding | Release status |
| --- | --- | --- | --- |
| PERSIST-01 | High | IndexedDB writes resolve on request success, before transaction commit | Block native and web release |
| PERSIST-02 | High | Autosaves are not single-flight; stale saves and sweeps can finish out of order | Block native and web release |
| PERSIST-03 | High | Clear/New can race an in-flight save; clear failures are swallowed | Block destructive-data claims |
| INPUT-01 | High | Blob archive size is checked only after allocating the entire Blob | Block Android release |
| INPUT-02 | High | ZIP memory ceilings are too high for mobile and uncomfortable for desktop | Block Android release |
| INPUT-03 | High | Import has a file-count cap but no per-file or total-byte budget | Block Android release |
| INPUT-04 | High | glTF accessors allocate from untrusted counts before bounds validation | Block hostile-file release |
| INPUT-05 | Medium | Board normalization accepts infinities, negative geometry, duplicates, and unbounded collections | Fix before file associations |
| ARCH-01 | High | Documented one-way module layering is already violated | Fix before platform adapters |
| ARCH-02 | High | File, persistence, lifecycle, dialog, link, and reload behavior lack platform ports | Block Tauri integration |
| SECURITY-01 | High | Tauri CSP, capabilities, command scopes, and navigation policy are absent | Block all native release |
| SECURITY-02 | Medium | Remote links and iframe behavior need native interception and explicit policy | Fix before native beta |
| SECURITY-03 | Low | Mutable internals are exposed as `window.mbrd` in production | Remove/guard before native beta |
| COMPAT-01 | High | Required Web APIs vary across system WebViews; some uses lack fallbacks | Block supported-platform claim |
| COMPAT-02 | Medium | Service-worker and page lifecycle logic assumes a browser tab | Fix before native beta |
| MEDIA-01 | Medium | ffmpeg runtime is referenced but not vendored; its custom-scheme/WASM policy is untested | Decide before native beta |
| TEST-01 | High | Adaptive dense-web test and controller are wall-clock-sensitive | Restore deterministic CI |
| TEST-02 | Medium | Browser storage, DOM workflows, and native boundaries lack behavioral tests | Fix before native beta |
| A11Y-01 | Medium | Board items have no keyboard selection/focus semantics; action labels are indistinguishable | Fix before store review |
| RELEASE-01 | Medium | Native icon, signing, notarization, packaging, and license notices are incomplete | Block public distribution |
| PLAN-01 | Medium | `PLAN.md` Tauri assumptions are stale and omit macOS from M4 | Update before implementation |
| MAINT-01 | Medium | Large state/UI modules and central god nodes will amplify adapter coupling | Split boundaries, not everything |
| DEV-01 | Low | The development server intentionally exposes the static app to the LAN without authentication | Document trusted-LAN use |

## Detailed findings

### PERSIST-01 — IndexedDB write promises are not durable-completion promises

Evidence: `web/assets/js/storage/idb.js:27-46`.

`tx()` resolves as soon as an individual request fires `onsuccess`. For `put`, `delete`, and `clear`, that can happen before the containing read/write transaction fires `oncomplete`. A later transaction abort cannot reject a Promise that has already resolved.

This contradicts the ordering claimed by `autosave()`:

1. persist new assets;
2. persist the snapshot;
3. sweep assets no longer referenced.

The caller can advance to the next step while the previous transaction is not committed. A crash, quota failure, or abort can therefore leave the ordering weaker than the comments and UI promise.

Remediation:

- resolve write operations only from `transaction.oncomplete`;
- retain the request result separately when an operation needs one;
- reject from `onerror` and `onabort` exactly once;
- reset `dbPromise` after an open failure so a transient failure is retryable;
- close the connection on `versionchange` and surface `blocked` upgrades;
- add delayed/failing IndexedDB tests with `fake-indexeddb` or a small browser harness.

### PERSIST-02 — overlapping autosaves can regress state

Evidence: `web/assets/js/storage/storage.js:377-381` and `438-509`.

The debounce prevents two timers, but it does not prevent a second `autosave()` from starting while the first is still in progress. Each call serializes independently, reads keys, writes assets and a snapshot, then sweeps. If an older save is slower, it can write its older snapshot after a newer one or delete assets referenced by the newer snapshot.

`saveBoard()` clears only the pending timer; it does not wait for or supersede an in-flight save. `flushEdits()` also calls `autosave()` directly from lifecycle events.

Remediation:

- serialize every persistence mutation through one queue;
- use a generation number and coalesce queued saves so only the latest snapshot is committed;
- make explicit Save await the current generation;
- run asset writes, snapshot replacement, and sweep under one logical native transaction;
- add tests where IDB calls are deliberately delayed and completed out of order.

For Tauri, use the same single-writer model and write recovery snapshots atomically: temporary file, flush/sync as appropriate, then rename.

### PERSIST-03 — destructive clearing can fail silently or be undone by a race

Evidence: `web/assets/js/storage/storage.js:568-570` and `599-623`.

`clearSession()` swallows every IndexedDB failure. `clearAllData()` then clears preferences, reloads, and reports success behavior even if the saved board and assets were not deleted. An already-running autosave is not cancelled by `clearTimeout(saveTimer)` or `cacheOk = false`; it can finish after the clear and repopulate data.

This is a correctness and privacy problem for a button labeled “Delete it all.”

Remediation:

- route clear through the same single-writer queue;
- cancel/supersede and await in-flight saves before deletion;
- propagate clear errors and do not reload or claim success after failure;
- verify the stores are empty before completing;
- cover quota, abort, blocked DB, and in-flight-save cases.

### INPUT-01 — archive size is checked after whole-Blob allocation

Evidence: `web/assets/js/storage/zip.js:276-295`.

For a `Blob` or `File`, `readZip()` calls `await source.arrayBuffer()` and only then compares `bytes.length` with the 768 MiB archive ceiling. A file far beyond the limit can exhaust memory before the rejection is reached.

Remediation:

- if `source` is a Blob, check `source.size` before `arrayBuffer()`;
- reject unknown source types explicitly;
- in the native adapter, inspect metadata and stream from a file/URI rather than materializing the complete archive;
- add a test using a fake Blob whose `arrayBuffer()` must never be called after an oversize `size`.

### INPUT-02 — accepted ZIP limits are incompatible with mobile memory

Evidence: `web/assets/js/storage/zip.js:227-253`.

The code itself calculates a worst-case peak around 2.3 GB: archive bytes plus inflated entries plus Blob copies. The configured archive and aggregate-uncompressed ceilings are both 768 MiB, and a single entry may be 512 MiB. Those limits are unlikely to fail gracefully on many Android devices and can still destabilize desktop WebViews.

The existing checks are good anti-bomb checks, but a safe ratio does not imply a safe resident set.

Remediation:

- define separate web-desktop and mobile budgets;
- use a conservative Android default, with a clear preflight message;
- stream archive entries in Rust and avoid simultaneous archive/inflated/Blob copies;
- parse `manifest.json` and `board.json` under small dedicated limits before importing assets;
- expose cancellation and progress for long native imports.

### INPUT-03 — imports cap count, not bytes

Evidence: `web/assets/js/import/drop.js:28-40`, `203-266`, `303-325`; `web/assets/js/storage/assets.js:40-52`.

Up to 500 files are accepted and six are prepared concurrently. Each `addFile()` reads a complete file into an ArrayBuffer, hashes it, and creates a new Blob from that buffer. Measurement and artwork extraction can add more decode buffers. Six large videos can therefore create a large transient peak, and 500 files can leave a huge in-memory asset set.

Remediation:

- add per-file, total-import, and current-board byte budgets before starting workers;
- lower concurrency dynamically on Android or low-memory devices;
- hash and copy streams in Rust for native builds;
- provide progress, cancellation, and a list of files skipped for size;
- avoid retaining both the original `File` list and copied Blob data longer than necessary.

### INPUT-04 — glTF allocation and traversal trust hostile structure too early

Evidence: `web/assets/js/import/mesh.js:474-515` and `552-583`.

`readAccessor()` creates a typed array of `acc.count * components` before validating the buffer view, offsets, stride, or available byte length. An attacker-controlled count can request a huge allocation even when the file contains almost no matching data.

Additional risks:

- bounds are checked against the entire backing buffer rather than the declared `bufferView.byteLength`;
- count, offsets, stride, node indices, and transform values are not comprehensively checked for finite non-negative integers;
- recursive `walkNode()` prevents cycles but can still overflow the stack on a very deep acyclic graph;
- the two-million-triangle ceiling is enforced after accessor allocation and permits very large plain-JavaScript position/normal arrays before conversion.

Remediation:

- validate and calculate every accessor byte range before allocating;
- enforce accessor, vertex, index, node-depth, primitive, decoded-byte, and triangle budgets;
- validate against the buffer view's declared range;
- replace recursive traversal with an explicit stack and depth/node budget;
- reduce the mobile triangle ceiling;
- fuzz OBJ/STL/glTF/GLB parsing and share malicious fixtures with any Rust implementation.

### INPUT-05 — board normalization is total but not bounded

Evidence: `web/assets/js/state.js:77-131` and `1190-1243`.

`+value || fallback` retains `Infinity`, negative widths/heights, huge coordinates, and huge rotations. `normalizeBoard()` has no explicit item/trash limit, no duplicate-ID handling, and no useful cap for title, type, general metadata, or several settings. Duplicate item IDs collide in the DOM/node maps. Large or non-finite geometry can poison bounds, layout, transforms, and rendering.

The `.mbrd` reader allows a single entry up to 512 MiB, so the archive layer does not make these missing domain limits harmless.

Remediation:

- require finite numbers and clamp coordinate, dimension, rotation, zoom, and timestamp ranges;
- reject or remap duplicate IDs deterministically;
- cap item/trash counts and user-facing strings;
- validate metadata by item type rather than carrying an arbitrary object;
- reject grossly invalid boards before mutating the current board;
- add tests for infinities, negative dimensions, duplicate IDs, deep metadata, and excessive item counts.

The reserved `asset.external` value is carried through untouched (`state.js:118-131`). If it later becomes a native path, imported documents must never be allowed to select arbitrary filesystem paths. Resolve it only through a user-granted handle or a document-scoped token.

### TEST-01 — the dense-web controller and its test are timing-dependent

Evidence: `web/assets/js/canvas/web.js:413-540`; `tests/web.test.js:169-183`.

The algorithm learns limits from `performance.now()`. The test expects a fixed point after a fixed number of real wall-clock measurements. In the final full suite it produced two values in the last ten samples and failed; it passed when run alone and in the coverage-instrumented full run.

The test is flaky, but it may also be exposing the user-visible behavior its comments describe: a noisy machine can move the limit by more than the hysteresis threshold and change the web shape.

Remediation:

- extract the cost estimator/controller into a pure function;
- inject timings in tests;
- separately benchmark the real algorithm without making CI pass/fail depend on scheduler noise;
- consider a cooldown, a larger sample window, and monotonic/session-stable policy;
- reset learned state explicitly in tests.

### ARCH-01 — current imports violate the documented layering rule

The repository requires:

`util/geometry ← state ← {import, storage, canvas} ← ui`

and allows `canvas` to reach into `import` only for the generated format catalog. Current exceptions are:

- `storage/storage.js:31` imports `ui/dialog.js`;
- `import/drop.js:11` imports `canvas/renderers.js`;
- `canvas/model.js:23` imports `import/mesh.js`;
- `canvas/renderers.js:13` imports `import/mesh.js`.

No import cycle was detected, but acyclicity alone is weaker than the intended ownership rule. These edges matter now because platform adapters need stable lower layers.

Remediation:

- move pure classification, default sizing, URL parsing, and mesh parsing into a neutral `core/`, `domain/`, or `media/` layer below both import and canvas;
- move user workflows into an application/controller layer;
- inject a confirmation/dialog port rather than importing UI from storage;
- add an architectural test for allowed directory edges, not only browser-free importability.

### ARCH-02 — native platform concerns have no explicit boundary

Evidence includes:

- File System Access API and Blob downloads in `storage/storage.js:43`, `89-147`, and `164-180`;
- hidden file-input workflows in `storage/storage.js:263-294`;
- `location.reload()` in `storage/storage.js:622`;
- `beforeunload` in `storage/storage.js:648-653`;
- `launchQueue` in `main.js:374-381`;
- service-worker registration in `main.js:384-387`;
- direct anchors for outbound URLs in `canvas/renderers.js:339-386`.

Recommended dependency shape:

```text
UI and application controllers
            |
            v
  state / geometry / board schema
            |
            v
      platform interfaces
       /              \
 web adapters      Tauri adapters
 IDB, FS Access,   Rust commands/plugins,
 launchQueue, SW   app data, OS lifecycle
```

Suggested interfaces:

- `files`: `openBoard`, `importFiles`, `saveCurrent`, `saveAs`;
- `recovery`: `loadSnapshot`, `persistSnapshot`, `clearSnapshot`;
- `lifecycle`: `onOpenFiles`, `onCloseRequested`, `onSuspend`, `onResume`;
- `links`: `openExternal`;
- `features`: explicit WebView/media capability results;
- `media`: optimize through web APIs, native implementation, or unavailable.

Only a bootstrap/composition module should decide which adapter to construct. Domain and UI modules should not test `window.__TAURI__`.

### SECURITY-01 — native CSP and capabilities must exist before IPC

There is no CSP in `web/index.html`, and there is an inline pre-paint script at `index.html:21-33`. In a browser this is defense in depth. In Tauri, a frontend compromise can reach whatever native APIs and custom commands the WebView has been granted.

Tauri's [CSP documentation](https://v2.tauri.app/security/csp/) states that protection is active only when configured, and its [capabilities documentation](https://v2.tauri.app/security/capabilities/) explains that permissions merge when a window belongs to multiple capabilities. It also notes that registered custom commands are broadly callable by default unless the application establishes its own permission boundary.

Required policy:

- enable an explicit CSP in `tauri.conf.json`;
- explicitly list capability identifiers in the app config;
- scope capabilities to the main window and target platform;
- split desktop and Android capabilities;
- grant only open/save dialogs, app-data recovery, selected-file operations, and tightly scoped URL opening;
- do not grant shell execution;
- do not grant recursive home-directory access;
- validate every custom Rust command again in Rust;
- keep all remote origins, including the YouTube iframe, outside native capabilities.

Starting CSP to refine:

```text
default-src 'self';
script-src 'self';
worker-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' asset: http://asset.localhost blob: data:;
media-src 'self' asset: http://asset.localhost blob:;
font-src 'self' asset: http://asset.localhost blob: data:;
connect-src 'self' ipc: http://ipc.localhost;
frame-src https://www.youtube-nocookie.com;
object-src 'none';
base-uri 'none';
form-action 'none'
```

Add `'wasm-unsafe-eval'` to `script-src` only if the ffmpeg WASM path is actually shipped. Tauri can add hashes/nonces to bundled local code at compile time. The pre-paint code should still be moved to a small external module and should reuse the same appearance-token sanitizer as the running app; it currently loops over saved `vars` without filtering.

### SECURITY-02 — external navigation and embeds need a native policy

The current URL parser and iframe sandbox are strong browser-side controls. In native builds:

- intercept external-link activation and call the opener plugin's URL operation;
- restrict the opener scope to `http` and `https`;
- prevent in-WebView top-level navigation and unexpected window creation;
- keep the YouTube origin in `frame-src` only, never in a remote native capability;
- test that `file:`, custom schemes, `javascript:`, malformed URLs, popups, and iframe requests cannot invoke native APIs.

This is especially important because Tauri warns that Linux and Android cannot reliably distinguish a remote iframe request from the containing window when remote capabilities are used. See [Capabilities](https://v2.tauri.app/security/capabilities/).

### SECURITY-03 — production debug exposure

`web/assets/js/main.js:326-328` publishes mutable `board`, `bus`, `vp`, `cmds`, and `selection` objects as `window.mbrd`.

That is useful for development, but it unnecessarily expands the surface available to injected or third-party code. Guard it with an explicit development build flag or expose a frozen, read-only diagnostic subset.

### COMPAT-01 — Tauri uses four materially different system WebViews

Tauri does not bundle one Chromium runtime. It uses WebView2 on Windows, the system Android WebView, WKWebView on macOS, and WebKitGTK on Linux. Official details are in [Tauri Webview Versions](https://v2.tauri.app/reference/webview-versions/).

Current features requiring a capability/fallback matrix include:

- unguarded `OffscreenCanvas` in `optimize/picture.js:80` and `canvas/model.js:500`;
- `CompressionStream` and `DecompressionStream` in `storage/zip.js`;
- `AudioEncoder`/WebCodecs in `optimize/opus.js`;
- `createImageBitmap`;
- WebGL and WebGL context restoration;
- `FontFace` and `document.fonts`;
- audio/video codec support;
- classic workers and `importScripts`;
- CSS `color-mix()`, `:has()`, and other WebKit-sensitive features;
- File System Access API, `launchQueue`, and service workers, which must not be treated as the native implementation.

Create a startup feature probe that records a small explicit matrix and drives graceful degradation. Do not infer support from the operating-system name.

### COMPAT-02 — page lifecycle is not native lifecycle

Evidence: `main.js:340-348`, `storage/assets.js:78-104`, `storage/storage.js:631-653`.

`pagehide`, `visibilitychange`, and `beforeunload` cannot guarantee completion of asynchronous IndexedDB work. `flushEdits()` starts `autosave()` but cannot await it. A Tauri window close, OS shutdown, Android backgrounding, and Android process death have different event and time budgets.

Remediation:

- disable service-worker registration in the Tauri adapter;
- handle Tauri close requests and OS open-file events centrally;
- persist edits continuously rather than relying on the close event;
- flush contenteditable note state before snapshot serialization;
- on Android, save on pause/background and design recovery for process death;
- map the Android back action to dismiss menus/dialogs/search before closing or navigating.

### MEDIA-01 — optional ffmpeg is absent and cross-platform behavior is undecided

`optimize/media.js:35-104` expects `web/assets/vendor/ffmpeg/ffmpeg-core.js`, but `web/assets/vendor/ffmpeg/` is absent in the audited tree. The code degrades gracefully, so this is not a current crash, but video optimization is not a shippable capability.

If vendored later, its 32 MB single-threaded WASM, `HEAD` probe, classic worker, `importScripts`, custom protocol URLs, CSP, licensing, and per-platform memory behavior all need testing. Linux media playback also depends on system WebKitGTK/GStreamer codec availability.

Choose one of:

1. explicitly mark video optimization unavailable on unsupported targets;
2. ship and test the vendored WASM core with an exact license/notice and CSP;
3. implement native media optimization behind the media port.

Do not silently download a codec/runtime from a CDN; that would violate the application's local-first promise.

### TEST-02 — missing behavioral layers

Add:

- IndexedDB transaction-completion, failure-injection, quota, upgrade, and overlapping-save tests;
- DOM interaction tests for selection, item menus, file workflows, dialogs, search, and accessibility;
- property/fuzz tests for ZIP, `.mbrd`, OBJ/STL/glTF/GLB and their Rust equivalents;
- golden `.mbrd` fixtures read and written by both JavaScript and Rust;
- CSP/capability negative tests that deliberately request forbidden paths, commands, schemes, and navigation;
- Tauri unit tests using its mock runtime;
- desktop end-to-end tests with WebdriverIO's Tauri service on Windows, Linux, and macOS, which the current [official WebDriver guide](https://v2.tauri.app/develop/tests/webdriver/) supports;
- Android emulator/device tests for content URIs, single/multiple share, file association, back behavior, IME/contenteditable, pause/resume, process death, and low memory.

### A11Y-01 — canvas items are not keyboard-navigable objects

Evidence: `web/assets/js/canvas/items.js:145-224`.

The item wrapper is a plain unfocusable `div` with no role or accessible name. The only tabbable control on each card is a button labeled simply “Actions,” so a screen reader encounters many indistinguishable buttons. Keyboard shortcuts operate on selection, but there is no complete keyboard path to move focus between items and select one.

Remediation:

- adopt a deliberate canvas semantic model, such as a labeled listbox with options or a documented application/roving-tabindex pattern;
- give each item an accessible name containing its item name/type;
- use `aria-selected` and visible focus;
- label the menu button “Actions for {item name}”;
- support keyboard selection, menu opening, moving, resizing, and deletion;
- test screen reader and hardware-keyboard behavior on Android, Windows, macOS, and Linux.

### RELEASE-01 — distribution assets and compliance are incomplete

- Tauri native icon sets do not exist. Generate ICO, ICNS, Linux PNG sizes, and Android adaptive foreground/background assets from a reviewed 1024×1024 RGBA source. The current maskable SVG is a useful design input, not the complete native set.
- Fraunces includes an OFL notice, while the bundled Geist font files have no corresponding notice in `web/assets/fonts/`. Verify and ship all third-party notices.
- If ffmpeg is shipped, select a build whose LGPL/GPL obligations match the distribution model and include notices/source offer as required.
- Add dependency review for Rust crates and any Tauri npm packages once introduced (`cargo audit`, locked builds, license inventory).
- Store disclosures should state that boards remain local, while YouTube is an explicit user-triggered remote embed.

Tauri's [distribution overview](https://v2.tauri.app/distribute/) covers signing and packaging requirements for Windows, macOS, Linux formats, and Google Play.

### PLAN-01 — the existing Tauri plan has drifted

Evidence: `PLAN.md:25`, `105-111`, `135-140`, and `164-168`.

- `devUrl` is planned as port 3000, but the repository's server defaults to 6273.
- M4 lists Windows and Linux but not the newly requested macOS target.
- M5 lists Android and iOS; this review's requested set is Android, Windows, macOS, and Linux.
- The planned storage interface does not match current Save-versus-Export behavior.
- The plan says canvas may reach into import for a generated catalog, but current code also reaches into the mesh parser.
- Direct `window.__TAURI__` detection would spread a runtime global unless contained in one adapter.
- The format section still mentions a vendored `fflate.module.js`, while the implementation uses native Compression Streams and its own ZIP code.

Update the plan before scaffolding `src-tauri/`.

### MAINT-01 — central modules will become migration choke points

The graph identifies `byId`, `toast`, `markDirty`, `Viewport`, `packBoard`, `initInput`, `bus`, `board`, and `commit` as the most connected abstractions. The weakest-cohesion large communities are Import/Rendering and the 3D model pipeline.

Large current files include the state model, appearance controller, palette implementation, model renderer, and input controller. A broad rewrite is not justified. Extract only the seams needed for:

- persistence queue and recovery;
- platform file operations;
- link/navigation policy;
- pure import classification and mesh parsing;
- lifecycle and feature detection.

This keeps the Tauri work from increasing the responsibility of already central modules.

### DEV-01 — development server exposure is intentional but should be explicit

`serve.py` binds `0.0.0.0` and presents a LAN QR code. It serves only static content under `web/`, and its path confinement is sound, but any device on the LAN can fetch the in-progress application.

Document that it is for trusted networks, consider an opt-in LAN flag with loopback as the default, and never reuse this server as a Tauri production localhost sidecar.

## Detailed `board` dependency trace

The graph's `board` node is the mutable domain singleton declared at `state.js:40`. It has 16 direct importers:

- application shell: `main.js`;
- UI: `appearance.js`, `sidebar.js`, `search.js`, `trash.js`, and `fonts.js`;
- canvas: `model.js`, `items.js`, `input.js`, `web.js`, and `grid.js`;
- import: `drop.js`;
- optimization: `optimize.js`;
- persistence: `storage.js`;
- tests: `state.test.js`;
- its containing module: `state.js`.

That breadth is why `board` appears to bridge almost every community. It is a pull-based shared-state design: consumers import the same live object instead of receiving an immutable snapshot or a narrow service. The event `bus` at `state.js:26` forms a parallel coupling plane with 16 direct importers across the application shell, UI, rendering, import, persistence, audio, notes, and still capture.

The important conclusion is that `board` is not the Tauri boundary. It is shared application state and should remain platform-neutral. The actual cut belongs outside it, at effectful workflows.

The graph exposes three representative paths:

```text
board <- storage.js -> idb.js
board <- storage.js -> dialog.js
board <- drop.js -> mbrd.js -> zip.js
```

The first path mixes domain state with browser recovery. The second proves that persistence currently reaches upward into UI. The third shows file acquisition, board mutation, archive decoding, and ZIP mechanics connected through the import path.

`storage.js` is the primary seam problem: it has 52 graph connections and combines state access, asset registration, board packing, IndexedDB, browser picker/download behavior, confirmation UI, autosave, session restore, and destructive clear. `main.js`, with 99 connections and imports of all major subsystems, is already the natural composition root.

Recommended cut:

```text
main.js composition root
          |
          v
application workflows
open / save / import / recover / clear
          |
          +---------------- shared ----------------+
          |                                        |
          v                                        v
state.js: board + bus                     mbrd schema / codec
          |
          v
injected effect ports
files / recovery / lifecycle / links
       /                         \
web adapters                 Tauri adapters
IDB, picker, download,        Rust commands/plugins,
launchQueue, page events      app data, OS events
```

Concrete refactor sequence:

1. Keep `board`, state transitions, geometry, undo, and the `.mbrd` compatibility model shared.
2. Split `storage.js` into a pure codec-facing document service and injected effect ports.
3. Move confirmation orchestration above storage so storage no longer imports `ui/dialog.js`.
4. Split `drop.js` into input acquisition, pure preparation, and a controller that commits prepared items.
5. Construct web or Tauri adapters only in `main.js` or a new bootstrap module.
6. Route inbound native file/share events through the same open workflow and outbound Save through one atomic file port.
7. Keep Rust commands narrow: selected-handle reads, atomic writes, app-data recovery, lifecycle events, and external URL opening. Rust should not own or duplicate the live board model.

This gives Tauri a narrow system boundary without creating separate web and native board implementations.

## Recommended Tauri architecture

### 1. Preserve the static frontend, isolate the bridge

The current no-build `web/` output can be used as `frontendDist` initially. If retaining no-build operation, enable Tauri's global API only for a single `platform/tauri.js` adapter. No other module should read `window.__TAURI__`.

Longer term, a minimal bundling step makes official ESM plugin imports, type checking, CSP, dead-code removal, and platform mocks cleaner. That is a product tradeoff: it adds build tooling but reduces reliance on a broad runtime global. Make the choice explicitly rather than drifting into both models.

### 2. Keep one board/domain model

Do not fork the board schema or normalization by platform. Keep:

- state and undo semantics in shared JavaScript;
- the `.mbrd` schema and compatibility rules shared through golden fixtures;
- one error vocabulary presented by the application controller.

Start with Rust reading/writing opaque `.mbrd` bytes and handling paths/URIs atomically. Move ZIP parsing, hashing, and streaming into Rust only after conformance tests prove byte/schema parity. This avoids implementing two subtly different file formats at once.

### 3. Give Rust the native responsibilities

Native commands or tightly scoped plugins should own:

- open/save dialogs and Android content URIs;
- current-document identity;
- atomic file replacement;
- application-data recovery snapshots;
- open-with/share events;
- lifecycle/close coordination;
- external URL opening;
- streaming file metadata, hashing, and eventually archive extraction;
- cancellation/progress for long operations.

Commands must not accept an arbitrary caller-supplied path and then read or write it. Operate on a path/URI returned by a user gesture, a persisted scoped handle, or an app-owned directory.

### 4. Native save model

Keep two concepts:

- recovery/autosave: app-owned, frequent, crash-oriented;
- document save: user-owned `.mbrd`, atomic, explicit.

On desktop, opening a document should establish a current document so Save writes it and Save As prompts. On Android, content URIs may not behave like reusable desktop paths, so retain a document token/URI abstraction rather than exposing string paths to domain code. Tauri's [dialog plugin documentation](https://v2.tauri.app/plugin/dialog/) confirms that desktop dialogs return filesystem paths while Android returns content URIs.

### 5. Open-with and single instance

Declare `.mbrd` in `bundle.fileAssociations`, including a custom MIME type. Tauri's [mobile file-association guide](https://v2.tauri.app/learn/mobile-file-associations/) generates Android intent filters from that configuration and supports View/Send/SendMultiple behavior.

On Windows and Linux, opening a second `.mbrd` may start a second process. Register the single-instance plugin before other plugins, forward the file to the existing main window, and serialize it through the same “finish recovery, then open requested file” ordering already used by `launchQueue`.

### 6. Recovery location and migration

Use the native app-data directory for recovery. Do not use the resource directory; Tauri's [filesystem documentation](https://v2.tauri.app/plugin/file-system/) notes platform write restrictions and app-directory defaults.

A native app cannot transparently read the browser origin's IndexedDB. The supported migration path from the PWA should be export `.mbrd`, then open it in the native app. Keep the Tauri application identifier stable so its own app-data and WebView origin do not move between releases.

## Platform readiness matrix

| Concern | Windows | macOS | Linux | Android |
| --- | --- | --- | --- | --- |
| WebView | WebView2/Chromium | WKWebView | WebKitGTK | System Android WebView |
| File selection | Paths | Paths/security scope if sandboxed | Paths/portal behavior | Content URIs |
| File association | `.mbrd`, second-instance forwarding | document types/open events | desktop MIME/second instance | intent filters, View/Send/SendMultiple |
| Packaging | MSI/NSIS or Store | DMG/App Store | AppImage/deb/rpm/Flatpak decision | signed AAB/APK/Play |
| Signing | Authenticode recommended | signing and notarization required for direct distribution | artifact/repository policy | mandatory release signing |
| Main compatibility risk | minimum WebView2 and installer mode | WebKit feature gaps and sandbox URLs | WebKitGTK/GStreamer and distro spread | low memory, content URIs, lifecycle/process death |
| Required manual tests | install/upgrade, long paths, open-with | notarized launch, open-with, codecs | portals, codecs, target distros | share/import, back, IME, rotation, pause/kill/restore |

Platform notes:

- Windows: choose a minimum WebView2 version if required features demand it; Tauri's [Windows installer guide](https://v2.tauri.app/distribute/windows-installer/) supports installer enforcement.
- macOS: set a deliberate minimum system version, sign and notarize direct-download builds, and test every WebKit-dependent feature. App Store sandboxing adds a separate security-scoped-file design.
- Linux: pick a supported WebKitGTK baseline and a small distro matrix. Codec availability is not uniform. Test xdg-desktop-portal behavior if Flatpak is in scope.
- Android: set a conservative import/archive/model budget, use adaptive icons, handle the system back action and IME, and test process death. Treat URIs as opaque handles rather than paths.

## Phased implementation plan

### Phase 0 — harden the web core

- Fix PERSIST-01 through PERSIST-03.
- Add archive/import/model budgets and validation.
- Make the dense-limit test deterministic.
- Add duplicate-ID and finite-geometry normalization.
- Enforce the documented module dependency rule.
- Add storage/browser behavioral tests.

Exit criterion: repeated full suites are green, destructive clear is verified, and malformed/oversize fixture tests fail without excessive allocation.

### Phase 1 — establish platform ports

- Split workflows from persistence and dialogs.
- Implement web adapters with behavior identical to the present PWA.
- Add platform mocks for tests.
- Move the pre-paint appearance logic into a reusable sanitized module.

Exit criterion: the web app passes existing and new tests without a Tauri global in domain/UI modules.

### Phase 2 — desktop Tauri shell

- Scaffold Tauri v2 with `frontendDist = "../web"` and the actual dev server URL.
- Add Windows, macOS, and Linux capability files.
- Implement native dialog/file/recovery/link/lifecycle adapters.
- Add `.mbrd` associations and single-instance forwarding.
- Disable service-worker registration in native mode.
- Add CSP and negative capability tests.
- Add WebdriverIO smoke flows: open, edit, Save, Save As, reopen, recovery, external link.

Exit criterion: signed test packages on all three desktop systems pass the same golden-board suite and native E2E flows.

### Phase 3 — Android adaptation

- Add mobile capability configuration and file associations/share intents.
- Implement URI-based open/save/import.
- Add back, safe-area, IME, rotation, suspend/resume, and process-death handling.
- Apply mobile memory budgets and cancellation/progress.
- Produce adaptive icons and signed internal-test AABs.

Exit criterion: low/mid-range physical-device testing can open, edit, recover, export, receive, and reopen boards without out-of-memory termination.

### Phase 4 — streaming, release, and operations

- Move archive/hash operations to streaming Rust if profiling supports it.
- Add update strategy for desktop and store-led Android delivery.
- Complete signing/notarization secrets and CI matrices.
- Produce SBOM/license notices and run Rust/npm vulnerability checks.
- Add crash diagnostics that contain no board contents or file paths unless the user explicitly opts in.

Exit criterion: reproducible signed artifacts, denied-permission tests, install/upgrade tests, store metadata, and rollback/recovery exercises are complete.

## Suggested issue backlog

1. Make IndexedDB write helpers resolve on transaction completion.
2. Introduce a coalescing single-writer autosave queue.
3. Make Clear Everything wait for persistence quiescence and propagate deletion failure.
4. Check Blob size before reading ZIP bytes.
5. Replace desktop ZIP limits with platform memory budgets.
6. Add per-file and aggregate import-byte limits.
7. Preflight glTF accessors and replace recursive node traversal.
8. Clamp normalized geometry and deduplicate IDs.
9. Extract pure import/render classification into a lower-level module.
10. Remove `storage -> ui` dependency with a workflow/dialog port.
11. Extract web platform adapters.
12. Add an explicit native navigation/opener policy.
13. Add Tauri CSP and platform-specific capability files.
14. Externalize and sanitize the pre-paint appearance bootstrap.
15. Guard/remove `window.mbrd` in production.
16. Add deterministic tests for the adaptive dense-web controller.
17. Add IndexedDB failure/concurrency tests.
18. Add golden `.mbrd` fixtures and parser fuzzing.
19. Add startup WebView feature probes and fallbacks.
20. Decide and document ffmpeg/video-optimization support per platform.
21. Add accessible item focus/selection semantics.
22. Generate native/adaptive icon sets.
23. Add Geist and future dependency license notices.
24. Update `PLAN.md` for port 6273, macOS, current Save/Export semantics, and adapters.
25. Build signed CI smoke packages for Windows, macOS, Linux, and Android.

## Graph-derived architecture observations

The generated graph covered 85 supported files and about 177,229 words, producing 961 nodes, 2,416 built edges, and 37 communities. The most connected nodes are:

1. `byId()` — 42 edges
2. `toast()` — 30
3. `markDirty()` — 25
4. `Viewport` — 22
5. `packBoard()` — 20
6. `initInput()` — 19
7. `clamp()` — 18
8. `bus` — 16
9. `board` — 16
10. `commit()` — 16

No import cycles were detected. The graph did, however, show low cohesion in Import/Rendering and the 3D model pipeline, matching the source-level recommendation to extract neutral classification/parser boundaries.

Semantic similarities found across documentation reinforce three intended invariants:

- local-first file ownership connects the plan, README, format specification, and sync decision;
- the one-way dependency rule connects `AGENTS.md` and `REFACTOR.md`;
- complete-asset export, hardened ZIP reading, browser-save integrity, and canonical content IDs form one data-integrity concern.

Graph integrity warning: the raw extraction contained 84 dangling-endpoint edges, one self-loop, and 10 same-endpoint edge groups collapsed by the undirected build. The graph was used only for navigation; findings above were verified in source. Graph token telemetry was recorded as 0 input/0 output because the host-agent semantic extraction did not expose usage counts to the graph tool.

Suggested graph questions for future reviews:

- Why does `Viewport` bridge geometry and application commands?
- Why does `board` bridge nearly every runtime subsystem?
- Should Import/Rendering be split into smaller focused modules?
- Should the 3D model pipeline be split into parser, material, and renderer layers?
- Are the inferred relationships around `packBoard()` reflected in explicit tests?

Generated navigation artifacts are in `graphify-out/GRAPH_REPORT.md`, `graphify-out/graph.json`, and `graphify-out/graph.html`.

## Native release definition of done

A platform may be called supported only when:

- all deterministic unit, parser, storage, and golden-format tests pass;
- CSP is enabled and forbidden native calls/navigation are tested;
- capability files are explicit, minimal, and platform-specific;
- open, save, Save As, recovery, clear, and open-with work without data loss;
- oversize/malicious imports fail before dangerous allocation;
- service workers and browser-only APIs are not required in native mode;
- accessibility works with the platform screen reader and hardware keyboard where applicable;
- install, upgrade, uninstall, signing, and file association are verified on the actual target;
- third-party license notices and privacy/store declarations are complete;
- the supported OS/WebView/distro/device minimums are written down.

Until those conditions are met, describe the Tauri builds as development previews rather than production multi-platform releases.

## Interaction follow-up: mobile selection and trash action

Implemented after the audit:

- On touch input, a tap followed within 350 ms by a second touch within 28 screen
  pixels arms marquee selection. Dragging the second touch more than the normal
  drag threshold draws and applies the existing world-space marquee.
- The gesture starts only on empty canvas. Item dragging, embedded controls,
  long-press context menus, one-finger panning, desktop modifier-drag selection,
  and two-finger pinch remain on their existing paths; a second simultaneous
  finger still cancels the pending gesture and wins as pinch.
- A plain double tap without the drag still reaches the existing double-click
  “fit board” behavior. A separate 12-pixel first-tap movement allowance keeps
  ordinary finger jitter from making the gesture unreliable without treating a
  real pan as a tap.
- The trash icon now calls the recoverable `removeItems()` state command when
  the selection is non-empty. This clears the deleted IDs from selection,
  creates normal trash entries, and remains undoable. With no selection, the
  same icon retains its existing role of opening or closing the trash panel.
- The trash icon's accessible name and tooltip change to “Delete N selected
  items” while a selection exists, then return to the trash contents count after
  deletion.
- The hamburger, trash, undo, and redo controls now share one size contract:
  42×40 pixels for a precise pointer and 46×46 pixels for a coarse pointer.
  Undo and redo remain a segmented pair, with each half occupying one control's
  width.

Verification:

- Focused appearance-token, browser-free import, and offline-shell checks:
  64 passed, 0 failed.
- Repository-wide suite after the interaction and chrome changes:
  421 passed, 0 failed.
