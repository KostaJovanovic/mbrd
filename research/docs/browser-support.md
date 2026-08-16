# Browser support

The one hard property of this project is that it ships no bundler, no build step
and no runtime dependency — the browser loads the ES modules under `web/`
directly. Everything below follows from that: the supported set is "browsers
new enough to run the modules as written", stated here so "supported" is a
contract rather than a guess. This file is what the startup capability check
(`warnMissingCapabilities()` in `main.ts`) points at when it finds a gap.

## The floor and the target

| Level | Safari | Meaning |
|---|---|---|
| **Best experience** | 26+ | SVG icons throughout, WebCodecs audio encoding, script-controlled media volume on iPadOS. |
| **Supported target** | 18.4+ | The core app, with the iPhone volume exception below. Test releases here. |
| **Compatibility floor** | 16.4 | Where WebKit added Compression Streams (`deflate-raw`) and OffscreenCanvas 2D. Runs, with the degradations listed. |
| **Below the floor** | < 16.4 | Not supported. Cannot open a `.mbrd` a newer browser deflated; the OffscreenCanvas optimiser path is absent. |

Chrome and Firefox: current and one prior major. Both clear the floor comfortably
— the floor is set by WebKit, which is last to ship these features.

## What sets the floor

A `.mbrd` written by a modern browser deflates its entries (`storage/mbrd.ts`),
and the reader inflates only through `DecompressionStream('deflate-raw')`
(`storage/zip.ts`) — there is no JavaScript fallback. That is the single hard
break below Safari 16.4 and the only capability the startup check raises a toast
for. The rest degrade inside optional paths:

- **OffscreenCanvas 2D** — image thumbnails and the optimiser (`optimize/picture.ts`,
  `canvas/model.ts` still capture).
- **`<dialog>.showModal()`** — the discard/clear question; `ui/dialog.ts` already
  feature-detects and defaults destructive answers to cancel when it is absent.
- **CSS `:has()`, `@property`, `color-mix()`, modern colour** — the palette and a
  handful of layout rules.
- **External SVG `<use>`** — every icon in the app is a `<symbol>` in
  `assets/icons.svg`, referenced as `<use href="assets/icons.svg#i-note">`. Above
  the floor this is uniform; it is called out because it is the app's only
  cross-document reference and it fails in a particular way. A browser that will
  not follow it draws *nothing* — no error, no fallback, a blank box where the
  icon was. IE and legacy Edge were the browsers that needed a polyfill for it
  (`svg4everybody`); every engine at or above this floor resolves it natively.
  Two consequences that outlive any one browser, both from the symbol rendering
  into a shadow tree: inherited properties reach it (which is how one `.ico` rule
  sets the weight of all forty drawings, and how `currentColor` works at all),
  and selectors do not (which is why `#zoom-lock` swaps two wrappers instead of
  two paths, and why `#origin-mark` is still written inline).

## Safari behaviours the app already accommodates

Documented so "Safari support" does not imply feature parity on every point release:

- **A canvas cannot encode WebP. On any Safari, at any version, through 27.**
  Not `toBlob`, not `toDataURL`, not `OffscreenCanvas.convertToBlob`; macOS and
  iOS alike, and the Safari 27 beta adds nothing. The specification says an
  engine that cannot write the type asked for substitutes PNG *and says
  nothing*, so the failure is invisible on every other engine. **Ask for WebP,
  then keep whatever comes back** — a mismatch is not a refusal. Six places
  treated it as one, which cost, in order: the display copy (so a board of two
  dozen photographs mounted full-resolution originals and killed the tab —
  `canvas/display.ts`), every thumbnail, every video poster, every model still,
  the whole picture pass of the optimiser, and the library's board thumbnails.
  Where alpha may be present the substitute PNG is kept; where the picture is
  provably opaque (a video frame, a board thumbnail) or the source was itself a
  JPEG, one JPEG retry gets the size back. `import/pdf.ts` had it right all
  along and is the pattern.
- **The canvas area ceiling is 16,777,216 pixels**, and a canvas past it draws
  *transparent* rather than throwing — so an over-large export is a blank file
  rather than an error. `MAX_AREA` in `ui/snapshot.ts` is applied on every
  engine: a probe would mean allocating the oversized canvas on the device being
  protected, and a user-agent test would be wrong for Chrome on iOS.
- **From iOS 26, every site added to the Home Screen opens as a web app by
  default.** Relevant to the storage note below rather than to layout: WebKit
  grants `navigator.storage.persist()` on installed-web-app heuristics, so "add
  it to your Home Screen" is now a real answer to "will my board still be here".
- **iPhone volume is locked to the hardware buttons.** Assigning `media.volume`
  is ignored; `canvas/audio.ts` detects this and hides the volume slider, showing
  "use the device volume buttons" instead. iPadOS gained script volume in Safari 26.
- **No File System Access picker.** Safari has no `showOpenFilePicker` /
  `showSaveFilePicker`; Open falls back to a hidden `<input>` and Export to a Blob
  download (`storage/storage.ts`).
- **No `launchQueue` / `file_handlers`.** "Open with mbrd" from the OS is absent
  rather than broken; the `launchQueue` use in `main.ts` is guarded.
- **Best-effort storage.** WebKit may evict the IndexedDB copy under pressure.
  The first explicit Save requests `navigator.storage.persist()`, and the receipt
  says "export a file to keep a durable copy" when persistence was not granted.
  The exported `.mbrd` is always the durable path.
- **Backdrop blur** needs `-webkit-backdrop-filter` before Safari 18; the two
  blurred surfaces (audio play button over cover art, the dialog scrim) carry it.
- **The Audio Session API is Safari-only, and that is where it is needed.** The
  interface sounds run on a live `AudioContext`, which on a phone can interrupt
  or duck audio playing in another app — and somebody arranging pictures with
  music on in the background is the ordinary case here, not the edge one. There
  is **no way to duck another app from a web page**; no API offers it. What
  there is is `navigator.audioSession.type = 'ambient'`, which says *mix,
  interrupt nothing, and be silenced by the ringer switch* — the same category a
  keyboard click uses. `cuelume/engine.ts` sets it where it exists and does
  nothing where it does not, which is the whole of the handling: elsewhere a
  hundred-millisecond Web Audio blip generally mixes anyway. **Unverified on
  hardware**, and it cannot be verified anywhere else — see the checklist below.
- **Optimiser codecs.** WebCodecs audio encoding needs Safari 26; Ogg Opus
  playback needs 18.4; WebM on iOS needs 17.4. These only matter if the optional
  ffmpeg core is bundled, which this repo does not ship.

## Known limitations

Deliberate boundaries rather than bugs, documented so they read as stated scope:

- **HEVC/H.265 posters need the network, and show black offline.** A clip the
  browser cannot decode itself (HEVC everywhere but Safari, AV1 on old builds,
  ProRes) has its poster frame pulled by the optional ffmpeg core, which is a
  one-time ~32 MB fetch from a CDN (`optimize/media.ts`) and is deliberately *not*
  in the service-worker precache. So the first HEVC poster on a fresh install
  needs a connection, and offline it degrades to a black rectangle with a dead
  play button. The clip itself still plays where the browser can decode it; only
  the still is affected. This is cross-browser, not a Safari quirk — Safari is the
  one desktop browser that decodes HEVC natively and so rarely reaches this path.
- **A HEIC with only a small embedded preview is not a portable board.** Safari
  decodes HEIC and no other engine does, so `import/drop.ts` cuts the camera's
  own JPEG out of one on the way in and stores it beside the untouched original
  — see `NOT_PORTABLE` in `import/preview.ts`. That preview only becomes the
  pixels the card draws when it is at least `PORTABLE_MIN_EDGE` (1280) on its
  long edge, which is the display ceiling, so adopting it costs the viewer
  nothing. Where a file carries only a small thumbnail there is nothing worth
  adopting, and the board is honestly less portable: the photograph is perfect
  on the phone and a named card on a desktop. Converting the original instead
  would be the fix, and this app does not rewrite the bytes somebody imported.
  Newly relevant rather than new: **Safari 27 stops converting HEIC to JPEG on
  the way through a file input**, which it lists as a bug fix, so from iOS 27 a
  photo added on a phone arrives as a HEIC where it used to arrive as a JPEG.
- **No keyboard navigation on the spatial canvas.** Board items carry `role` and
  an accessible name for assistive tech (`canvas/items.ts`), but there is no
  roving-tabindex / arrow-to-move-focus / Enter-to-select model yet: items are
  selected and created by pointer, and the arrow keys nudge a selection made with
  the mouse rather than moving focus between cards. The full keyboard model is a
  browser-verified change held back to avoid a focus-order regression (AUD-09).
  The chrome, panels, dialogs and the Find palette are all keyboard-reachable; it
  is the canvas surface itself that is pointer-first.

## Release checklist

The Node suite (`npm test`) validates pure logic and structural invariants; it
does not instantiate WebKit. Adopting a browser driver (Playwright/WebKit,
`safaridriver`) would add the dev dependency and CI runner this project is
deliberately built without — a maintainer's call, not a default. Until then, run
this by hand on **current macOS Safari, the minimum supported Safari, and current
iPhone + iPad Safari** before a release:

1. Boot offline after a service-worker update (airplane mode, relaunch).
2. Add files → autosave → reload → board restored.
3. Pan / pinch-zoom / marquee-select / resize handles on touch and trackpad.
   Specifically: a two-finger swipe on the trackpad must **pan** and a mouse
   wheel must **zoom**, on the same machine — `readWheel()` tells them apart by
   the shape of the deltas, and Safari's are its own (see `canvas/input.ts`).
4. Save, then Export a `.mbrd`; reopen it. Cross-check: export from Chromium,
   open in Safari, and back.
5. Clear everything → confirm the wipe, and that Cancel aborts it.
6. Play an audio and a video card; confirm the volume slider is hidden on iPhone.
   A video card must show a **real frame** before it is tapped, not a black
   rectangle — that is the poster, and it is the tell for the WebP note above.
   An audio card's source is parked until first play on a coarse-pointer engine
   (`rationsDecoders()`), so confirm one still plays, seeks and shows a waveform.
7. Install to Home Screen / Dock; confirm the icon and a cold offline launch.
8. VoiceOver over the dialog and the waveform seek slider.
9. Export as PNG and as PDF from a board several thousand units across, and run
   Optimise over a board of photographs. Both are silent on the two ceilings
   above: a blank export and a pass that reports nothing to do look exactly like
   success.
10. **With music playing in another app on an iPhone**, open a board and do
   anything that makes a sound — drop a file, undo, toggle the grid. The music
   must keep playing at the volume it was at, and the ringer switch must silence
   the interface sounds. This is the one claim in this document that no test in
   the repository can make, and the only place it can be made is on a phone.

If a `safaridriver` suite is added later, flows 1–5 and 9 are the ones worth
automating first; 3, 7, 8 and 10 stay manual — 10 permanently, since a driver
has no second app to play music from.
