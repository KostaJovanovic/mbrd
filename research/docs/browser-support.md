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
7. Install to Home Screen / Dock; confirm the icon and a cold offline launch.
8. VoiceOver over the dialog and the waveform seek slider.

If a `safaridriver` suite is added later, flows 1–5 are the ones worth
automating first; 3, 7 and 8 stay manual.
