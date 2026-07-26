# Safari support audit

**Date:** 2026-07-26  
**Scope:** `web/`, its browser-facing dependencies, the PWA shell, and relevant tests  
**Reviewed state:** the working tree as found, including uncommitted changes  
**Method:** repository knowledge-graph query, static source review, targeted API/CSS searches, current WebKit and Apple documentation, and the complete Node test suite

## Executive summary

The current application has no static-code blocker for its core board workflow in current Safari 26.5 on macOS, iOS, or iPadOS. Import, canvas interaction, IndexedDB autosave, `.mbrd` packing/unpacking, media playback, dialogs, and offline shell registration all use APIs that current Safari implements. The code is generally careful about WebKit: it uses Pointer Events with `touch-action`, preserves `pagehide.persisted` state for the back-forward cache, delays Blob URL revocation for Safari downloads, provides Web Crypto and native-picker fallbacks, uses `playsInline`, and carries several required `-webkit-` CSS forms.

This is not a Safari certification. The repository has no WebDriver, Playwright/WebKit, `safaridriver`, iOS Simulator, or physical-device test path, and this audit ran on Windows. The existing 415 tests all pass, but they validate pure logic and structural invariants rather than WebKit rendering, media, storage, installation, or touch behavior.

Recommended support statement:

- **Fully supported target:** Safari 18.4 or later for the core application, with the iPhone volume-control exception below.
- **Best current experience:** Safari 26 or later. This adds SVG icon support throughout Safari, WebCodecs audio encoding, and script-controlled media volume on iPadOS.
- **Compatibility floor:** Safari 16.4. This is where WebKit added both Compression Streams and OffscreenCanvas 2D. Safari 16.4–18.3 can run the core app, but has the documented degradations below.
- **Do not claim full support below Safari 16.4.** A browser without `DecompressionStream('deflate-raw')` cannot open the normal deflated entries in a `.mbrd` produced by a newer browser, and image optimization/thumbnails cannot use the current OffscreenCanvas path.

No source files were changed as part of the audit.

## Findings

### S1 — High: “Save in this browser” remains evictable in Safari

`saveBoard()` flushes the board and assets to IndexedDB, marks the board clean, and tells the user “Saved in this browser” ([storage.js](../web/assets/js/storage/storage.js#L50)). The repository never calls `navigator.storage.persisted()`, `navigator.storage.persist()`, or `navigator.storage.estimate()`.

WebKit stores origins in best-effort mode by default. Safari may evict an origin under overall quota pressure, device storage pressure, or inactivity. Safari 17 and later support requesting persistent mode, and WebKit explicitly recommends using the Storage API for applications that expect to store substantial data. A moodboard containing images, video, and audio is exactly that case.

Impact:

- A successful explicit Save can later disappear without an application-level delete.
- Marking the board clean suppresses the strongest signal that the user should export a durable `.mbrd`.
- Installed Home Screen/Dock use does not automatically make the existing code request persistent mode; WebKit only says the request may be granted based on heuristics such as installed-web-app use.

Recommendation:

1. On the first user-initiated browser save, feature-detect and call `navigator.storage.persist()`.
2. Record whether persistence was granted. Do not treat denial as a save failure, but change the receipt to distinguish “saved persistently” from “saved in browser storage; export a file for a durable copy.”
3. Use `navigator.storage.estimate()` before large imports and surface `QuotaExceededError` with current usage/quota.
4. Keep `.mbrd` export as the durable path.

Source: [WebKit — Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/).

### S2 — Medium: the volume slider is non-functional on iPhone Safari

The sidebar always displays a global volume slider. `setVolume()` writes `HTMLMediaElement.volume` for every audio and video player, and `registerPlayer()` initializes each player to the saved value ([audio.js](../web/assets/js/canvas/audio.js#L51), [audio.js](../web/assets/js/canvas/audio.js#L66), [audio.js](../web/assets/js/canvas/audio.js#L86)).

On iPhone, WebKit keeps media volume under the physical volume controls. Assigning `audio.volume` or `video.volume` has no effect and reading it returns full volume. Safari 26 added script-controlled media volume on **iPadOS**, not iOS. The present UI can therefore say “20%” while an iPhone plays at the system volume.

Recommendation:

- Detect locked volume using WebKit’s `:volume-locked` pseudo-class where available, or use a conservative iOS capability path.
- Hide or disable the slider and say “Use the device volume buttons” when volume is locked.
- Keep mute controls: `muted` is a separate, useful control.

Sources: [Apple — iOS-specific media considerations](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/Device-SpecificConsiderations/Device-SpecificConsiderations.html), [WebKit — Safari 26.0 media changes](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/).

### S3 — Medium: pre-Safari-26 Home Screen icons have no supported PNG fallback

The document declares an SVG as `apple-touch-icon` ([index.html](../web/index.html#L17)). The manifest also supplies only SVG icons ([manifest.json](../web/manifest.json#L12)).

Before Safari 26, Apple’s documented `apple-touch-icon` format was PNG. Safari 15.4+ gives an HTML `apple-touch-icon` precedence over manifest icons, so the unsupported SVG occupies the highest-priority slot. Safari 26 added SVG icon support throughout Safari, including Home Screen and Dock placements; earlier iOS versions can fall back to a screenshot/generic result rather than the intended icon.

Recommendation:

- Add at least an opaque 180×180 PNG `apple-touch-icon`.
- Consider 167×167 and 152×152 variants for older iPad placements.
- Keep the manifest SVG and maskable SVG for current Safari and other browsers.
- Add the PNG assets to the service worker `SHELL`; `tests/sw.test.js` will then enforce cache coverage.

Sources: [Apple — Configuring Web Applications](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html), [WebKit — Safari 26 SVG icons](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/), [WebKit — Safari 15.4 manifest icon precedence](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/).

### S4 — Medium: the supported Safari floor is implicit, and older Safari fails at file interoperability

The ZIP writer feature-detects `CompressionStream('deflate-raw')` and writes STORE entries when unavailable ([zip.js](../web/assets/js/storage/zip.js#L38)). That lets an old browser export its own uncompressed board.

The reader has no inflate implementation other than `DecompressionStream('deflate-raw')` ([zip.js](../web/assets/js/storage/zip.js#L72), [zip.js](../web/assets/js/storage/zip.js#L377)). A `.mbrd` made by a modern browser normally deflates `manifest.json`, `board.json`, notes, waveforms, and compressible assets ([mbrd.js](../web/assets/js/storage/mbrd.js#L86), [mbrd.js](../web/assets/js/storage/mbrd.js#L150)). Safari before 16.4 therefore cannot reliably exchange boards with supported browsers.

Other floor-setting features include:

- OffscreenCanvas 2D in the image thumbnail/optimizer and model still path ([picture.js](../web/assets/js/optimize/picture.js#L80), [model.js](../web/assets/js/canvas/model.js#L500));
- `Array.prototype.at()` and `Object.hasOwn()` in shipped modules;
- `<dialog>.showModal()`;
- CSS `:has()`, `@property`, `color-mix()`, and modern color syntax.

Most of these either degrade or fail only in an optional path, but together they establish a modern baseline. There is no startup capability check, user-facing minimum version, or Safari matrix in the repository.

Recommendation:

- Declare Safari 16.4 as the absolute floor and Safari 18.4+ as the supported target.
- Add a small startup capability check for:
  - `DecompressionStream` accepting `deflate-raw`;
  - `OffscreenCanvas` plus `convertToBlob`;
  - `HTMLDialogElement.prototype.showModal`;
  - `CSS.supports('color', 'color-mix(in srgb, red, blue)')`.
- Do not block the whole app when an optional capability is absent; explain exactly which workflows are unavailable.
- If Safari below 16.4 must be supported, add a bounded pure-JavaScript DEFLATE reader and an HTMLCanvasElement/`toBlob()` fallback.

Sources: [WebKit — Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/), [WebKit Compression Streams documentation](https://docs.webkit.org/Deep%20Dive/Modules/CompressionStreams.html).

### S5 — Medium: there is no real Safari regression suite

`package.json` runs only Node’s built-in test runner. Structural tests intentionally keep browser modules importable in Node, and the suite thoroughly tests board state, geometry, archives, imports, and service-worker logic. It does not instantiate WebKit or validate:

- macOS Safari pointer/wheel behavior;
- iPhone/iPad pinch, long press, touch selection, resize handles, and safe areas;
- IndexedDB Blob persistence and quota errors;
- service-worker install/update/offline launch;
- PWA Home Screen/Dock installation and icons;
- Blob downloads and `.mbrd` round-trips;
- media codec playback, custom controls, or Web Audio decoding;
- OffscreenCanvas WebP output;
- CSS `:has()`, `color-mix()`, `@property`, masks, and backdrop filters;
- VoiceOver focus behavior in `<dialog>` and custom sliders.

This is the main confidence gap. Safari has shipped fixes in exactly these areas across point releases.

Recommendation:

1. Add a small WebDriver suite runnable with `safaridriver` on macOS for boot, import, pan/zoom, save/open, IndexedDB recovery, and offline shell.
2. Add an iOS Simulator or physical-device manual release checklist.
3. Keep pure logic in Node; browser automation should cover only boundaries that Node cannot.
4. Test at least current Safari and the declared minimum.

### S6 — Low: Safari 17 and earlier miss all intended backdrop blur

The stylesheet uses only unprefixed `backdrop-filter` on video controls, item captions, and the modal backdrop ([app.css](../web/assets/css/app.css#L747), [app.css](../web/assets/css/app.css#L2867)). WebKit required `-webkit-backdrop-filter` before Safari 18.

The controls remain functional because they already have translucent background colors, so this is visual degradation rather than a blocker. It is nevertheless easy to avoid if Safari 16.4/17.x is in scope.

Recommendation: place `-webkit-backdrop-filter` immediately before each unprefixed declaration, including `none` overrides.

Source: [WebKit — unprefixed backdrop filters in Safari 18](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/).

### S7 — Low: Safari-only optional feature gaps are handled, but should be in the support contract

These are intentional degradations, not defects:

- Safari does not expose Chromium’s `showOpenFilePicker()` / `showSaveFilePicker()` picker-and-handle flow. The app correctly falls back to a hidden file input for Open and a Blob download for Export ([storage.js](../web/assets/js/storage/storage.js#L43), [storage.js](../web/assets/js/storage/storage.js#L88), [storage.js](../web/assets/js/storage/storage.js#L174)).
- Safari ignores the manifest `file_handlers` member and does not expose `launchQueue`. The `launchQueue` use is guarded, so “Open with mbrd” is absent rather than broken ([main.js](../web/assets/js/main.js#L547)).
- Audio optimization through WebCodecs is unavailable before Safari 26 because AudioEncoder/AudioDecoder were added in Safari 26. `opusAvailable()` detects this, and the dialog says sound will be left alone when the optional ffmpeg core is also absent ([opus.js](../web/assets/js/optimize/opus.js#L53), [ui.js](../web/assets/js/optimize/ui.js#L41)).
- Ogg Opus playback requires Safari 18.4+. This matters if the optional ffmpeg core is later bundled, because it outputs `audio/ogg`; the currently reviewed repository does not ship that core.
- WebM playback on iOS/iPadOS requires Safari 17.4+. This likewise matters only if the optional ffmpeg video optimizer is bundled.

Document these gaps so “Safari support” does not imply native file handles, OS file association, or identical optimization capabilities on every supported point release.

Sources: [WebKit bug — picker methods in the File System Access API](https://bugs.webkit.org/show_bug.cgi?id=213775), [WebKit — Safari 26 WebCodecs audio](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/), [WebKit — Ogg Opus in Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/), [WebKit — WebM on iOS in Safari 17.4](https://webkit.org/blog/15063/webkit-features-in-safari-17-4/).

## Compatibility strengths already present

The review found substantial Safari-aware work worth preserving:

- The viewport includes `viewport-fit=cover`, and floating controls use `env(safe-area-inset-*)` ([index.html](../web/index.html#L9), [app.css](../web/assets/css/app.css#L1501)).
- Pointer gestures are unified through Pointer Events, with `touch-action: none`, two-finger pinch handling, pointer capture, coarse-pointer hit targets, and an iOS touch-callout override ([input.js](../web/assets/js/canvas/input.js#L355), [app.css](../web/assets/css/app.css#L80), [app.css](../web/assets/css/app.css#L2953)).
- Wheel zoom explicitly registers `{ passive: false }`, avoiding WebKit’s passive-root-listener trap ([input.js](../web/assets/js/canvas/input.js#L686)).
- Command shortcuts use `metaKey` as well as `ctrlKey`, and clipboard operations use synchronous `copy`/`cut` event data rather than permission-gated async clipboard calls ([input.js](../web/assets/js/canvas/input.js#L734), [input.js](../web/assets/js/canvas/input.js#L847)).
- Pasted images/files use `ClipboardEvent.clipboardData.files`, and folder drops use WebKit’s own `webkitGetAsEntry()` with a flat-file fallback ([drop.js](../web/assets/js/import/drop.js#L96), [drop.js](../web/assets/js/import/drop.js#L509)).
- Video elements set `playsInline`, and playback starts from explicit controls with rejected `play()` promises surfaced to the user ([renderers.js](../web/assets/js/canvas/renderers.js#L264), [video.js](../web/assets/js/canvas/video.js#L108)).
- Audio waveform decoding includes the legacy `webkitOfflineAudioContext` fallback and an eight-second timeout for wedged decoders ([audio.js](../web/assets/js/canvas/audio.js#L139), [audio.js](../web/assets/js/canvas/audio.js#L270)).
- Local-storage access is exception-safe for private/restricted contexts ([util.js](../web/assets/js/util.js#L24)).
- Hashing falls back to a yielding JavaScript SHA-256 implementation when `crypto.subtle` is unavailable on insecure LAN development URLs ([util.js](../web/assets/js/util.js#L194)).
- Blob downloads retain their object URL for 20 seconds specifically to avoid Safari’s delayed-download failure ([storage.js](../web/assets/js/storage/storage.js#L150)).
- Object URLs are not revoked when `pagehide.persisted` indicates entry into Safari’s back-forward cache ([assets.js](../web/assets/js/storage/assets.js#L72)).
- The service worker is feature-detected, same-origin only, namespaced, all-or-nothing on install, and tested against every shipped asset ([main.js](../web/assets/js/main.js#L557), [sw.js](../web/sw.js#L101)).
- CSS supplies WebKit forms where still relevant: `-webkit-user-select`, masks, appearance, line clamp, details marker, tap highlight, and touch callout.
- `<dialog>` use is feature-detected and defaults destructive questions to cancellation if unavailable ([dialog.js](../web/assets/js/ui/dialog.js#L42)).

## Version matrix

| Safari version | Core board | `.mbrd` interoperability | PWA/icon quality | Optimization |
|---|---|---|---|---|
| 26.x | Expected supported | Supported | SVG icons supported throughout | Images supported; WebCodecs audio available when Opus config is supported |
| 18.4–18.6 | Expected supported | Supported | Pre-26 `apple-touch-icon` gap | Images supported; Ogg Opus playback supported; no WebCodecs AudioEncoder |
| 18.0–18.3 | Expected supported | Supported | Pre-26 `apple-touch-icon` gap | Images supported; Ogg Opus output not playable |
| 17.4–17.6 | Expected supported with cosmetic gaps | Supported | Pre-26 icon gap; no unprefixed backdrop blur | Images supported; WebM playback supported on iOS; no native audio encoding |
| 16.4–17.3 | Core likely usable, not certified | Supported; prefer 16.6+ due early Compression Streams fixes | Icon and backdrop gaps | Images supported; older iOS WebM limitations; no native audio encoding |
| Below 16.4 | Not fully supported | Cannot open ordinary deflated boards | Multiple modern CSS/API gaps | OffscreenCanvas path unavailable |

“Expected supported” means source-compatible based on documented WebKit features. It does not replace execution on those releases.

## Verification performed

- Queried the existing repository graph for browser-facing entry points and dependency paths.
- Reviewed browser globals and feature gates across storage, import, canvas, UI, optimization, service worker, manifest, and CSS.
- Checked current behavior against primary Apple/WebKit sources.
- Ran `npm test`.

Result:

```text
tests 415
pass 415
fail 0
duration_ms 1475.6195
```

Not performed:

- Safari/macOS execution;
- iOS/iPadOS Simulator or physical-device execution;
- installed PWA and offline launch;
- VoiceOver;
- codec/device matrix;
- storage-pressure or eviction simulation.

## Recommended action order

1. Address storage persistence and truthful Save messaging.
2. Hide/replace the volume slider when WebKit reports volume is locked.
3. Add PNG Apple touch icons and cache them.
4. Publish the Safari support floor and add capability diagnostics.
5. Add a minimal `safaridriver` plus iOS manual regression matrix.
6. Add prefixed backdrop-filter declarations if Safari 16/17 remains supported.

After those changes, test the complete release workflow on:

- current macOS Safari;
- the minimum supported macOS Safari;
- current iPhone Safari, both browser and Home Screen mode;
- current iPad Safari, including pointer/trackpad and touch;
- offline launch after a service-worker update;
- a `.mbrd` exported by Chromium and reopened in Safari, then exported by Safari and reopened in Chromium.
