# Safari audit — what got fixed, what stayed a note

**Date:** 2026-07-28
**Source:** `research/old/safari-support-audit-2026-07-26.md` (S1–S7)
**Verified:** `npm test` → 566 pass / 0 fail after the changes below.

The audit was two days old and the tree had already moved under it, so each
finding was re-checked against the current `web/` before acting. Icons (S3) were
already done in the interim.

## Addressed

- **S1 — evictable browser storage.** `storage.js` now requests
  `navigator.storage.persist()` on the first explicit Save (`ensurePersistence()`),
  and the receipt tells the truth: "Saved in this browser" when persistence was
  granted, "…export a file to keep a durable copy" when it was not. The save is
  always reported a success regardless; the `.mbrd` remains the durable path.
- **S2 — dead volume slider on iPhone.** `canvas/audio.js` probes a throwaway
  `Audio` element (`volumeLocked()`): a browser that ignores `volume` writes
  returns 1. When locked, the slider is hidden and replaced with "use the device
  volume buttons". iPadOS Safari 26 reports unlocked and keeps the slider.
- **S4 — implicit floor.** `main.js` `warnMissingCapabilities()` runs once at
  boot: it toasts only for the one hard failure (no `DecompressionStream` →
  cannot open a modern `.mbrd`) and logs the soft ones (`showModal`,
  `OffscreenCanvas`, `color-mix`). Non-blocking by design. Points at
  `docs/browser-support.md`.
- **S6 — backdrop blur.** `-webkit-backdrop-filter` added before every
  `backdrop-filter` in `app.css` (the two live blurs — audio play button over
  cover art, dialog scrim — and the three `none` overrides that cancel them),
  so Safari 16.4–17.x get the blur and the cheap-mode cancel both.
- **S3 — Home Screen icons.** Already resolved before this pass: PNG
  `apple-touch-icon` (192), PNG manifest icons at 192/512 plus maskable, all in
  the service-worker `SHELL`. A dedicated 180×180 is a nicety, not required — iOS
  scales the 192 down.

## Documented, not automated

- **S5 — no Safari regression suite** and **S7 — support contract.** Both land in
  the new `docs/browser-support.md`: the version matrix and floor, the Safari
  behaviours the app accommodates (locked volume, no file picker, no
  `launchQueue`, best-effort storage, codec gaps), and a manual release
  checklist. A `safaridriver`/Playwright suite would add the dev dependency and
  CI runner this project is built without — the same no-dependency property that
  kept AUD-13 a note, and the same maintainer decision. Recorded, not adopted.

## Noticed, out of scope

Three unreferenced 90s-easter-egg leftovers survive the egg's deletion:
`web/assets/img/arrow90.cur`, `pointer90.cur`, `wallpaper90.jpg`. No code, CSS or
`SHELL` entry references them (only two historical research docs mention them).
Safe to delete; left in place pending a go-ahead.
