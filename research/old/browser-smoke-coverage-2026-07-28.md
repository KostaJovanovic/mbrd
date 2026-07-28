# Browser boundary coverage — the gap AUD-13 names, and why it stays a note

**Date:** 2026-07-28
**Finding:** AUD-13 — Browser boundary behaviour lacks regression coverage
**Status:** documented, not automated. The tooling decision is deferred to a
maintainer; see "The decision" at the end.

## What AUD-13 asks for

A small browser smoke layer — "a dozen high-value boundary flows" — driven by a
real browser in CI, because some defects only exist against a real DOM, a real
IndexedDB and a real service worker, and the fast Node suite cannot see them.
The audit is right that the structural import test (`tests/imports.test.js`) can
make a browser-heavy file *look* exercised while none of its functions run.

## Why it is a note and not a `playwright.config.js`

This project's one hard property is that it has **no bundler, no build step and
no runtime or dev dependency** (see `CLAUDE.md`, and `package.json`, which exists
only to run `node --test`). A browser-driver — Playwright, Puppeteer, WebDriver —
is a heavyweight dev dependency plus a CI runner, and adopting one is a change to
the shape of the project, not a bug fix. That is a maintainer's call to make on
purpose, not something a hardening pass should slip in. So this note records the
flows that want covering and how far the dependency-free suite already reaches;
turning it into an automated layer is a follow-up, gated on that decision.

## What the Node suite already covers, without a browser

The hostile-input and boundary logic that *can* be pulled behind a fake global
now is, so the remaining gap is genuinely browser-bound, not merely untested:

- `tests/idb.test.js` — transaction completion vs. request success, abort, and
  version-change, against a controllable fake `indexedDB`.
- `tests/storage-clear.test.js` — `clearSession()` rejects a wipe that does not
  commit (the AUD-03 "reported success while data survived" defect).
- `tests/sw.test.js` — install all-or-nothing, activate scoping, and runtime
  fetch scoped to the version cache (AUD-14), in a `vm` sandbox with a fake Cache
  Storage.
- `tests/budget.test.js`, `tests/zip.test.js`, `tests/mesh.test.js`,
  `tests/state.test.js` — the import budgets, archive/mesh ceilings and persisted
  -state invariants, all pure.
- `tests/input.test.js`, `tests/items.test.js` — the shortcut-suppression
  predicate and the accessible-name builder as pure functions.

## The flows still only checkable in a browser

Each is a boundary the Node fakes cannot fully stand in for. Roughly a dozen, to
match the audit's target:

1. **Add → autosave → reload → restore** — the whole round trip through real
   IndexedDB and the boot script. The single most valuable flow.
2. **Overlapping autosaves (A/B inversion)** — a later save must not be
   overwritten by an earlier one landing late. Needs the real debounce + bus
   wiring `initStorage()` installs. (AUD-02)
3. **Clear-during-save race** — a wipe requested while a save is in flight must
   win, and must not be repopulated by the draining writer. (AUD-03)
4. **Real IndexedDB quota / abort** — `QuotaExceededError` surfaced to the user
   rather than swallowed.
5. **File System Access cancel / write failure** — Export cancelled at the
   picker, and a write that fails mid-stream, each reported honestly.
6. **Modal / context-menu keyboard isolation** — an open `<dialog>` or `#ctx-menu`
   must swallow board shortcuts; e.g. ArrowRight inside a dialog must not nudge a
   selected item. The predicate is unit-tested; the real event path is not.
   (AUD-08)
7. **Roving-tabindex board navigation** — Tab/arrow movement across items and the
   per-item action button, with real focus. (AUD-09, keyboard half)
8. **Object-URL lifecycle** — a media element's blob URL created on mount and
   revoked on cull, with no leak across a pan that mounts/unmounts cards.
9. **Service-worker fetch against multiple same-origin caches** — a live SW
   answering from its own version cache only. (AUD-14; logic covered, live path
   not)
10. **Worker crash / timeout recovery** — the optimize media worker dying
    mid-job must reject the job and respawn, not hang. (AUD-10)
11. **WebGL context ceiling** — many model cards sharing the one context while
    panning, none coming back blank. (`canvas/model.js`)
12. **Discard-confirmation gate** — Open/New/Clear on a dirty board must route
    through the injected prompt and honour Cancel. (Now dependency-injected in
    `storage.js` via `setPrompt`, so it is *drivable* headlessly once a harness
    exists.)

## What the AUD-12 work already did to make this cheaper

The persistence coordinator and the input policy were made dependency-injectable
during the AUD-12 pass, which is exactly what the audit's recommendation asked
for ("Make the persistence coordinator and input policy dependency-injectable so
most ordering cases stay deterministic and fast"):

- `storage.js` takes its confirmation dialog via `setPrompt()` — flows 3 and 12
  can be driven with a scripted prompt instead of a real click.
- `state.js` takes the asset-name lookup via `setAssetNameLookup()`.
- `canvas/input.js` exposes `shortcutsSuppressed()` as a pure predicate — flow 6's
  logic is already deterministic; only the real key-event path remains.

So if the browser layer is adopted later, several of these are ordering tests
that stay fast and deterministic, and only the truly DOM-bound ones (1, 5, 7, 8,
10, 11) need the real browser.

## The decision

Pick one, on purpose:

- **Keep as a note (recommended).** No dependency, no CI runner; the property the
  project is built on is intact. Revisit if a browser-only regression actually
  bites.
- **Adopt a browser driver.** Add Playwright (or similar) as a dev dependency and
  a CI job, and turn flows 1–12 into a smoke suite. This ends the "no
  dependency" property; make it a deliberate entry, not a side effect.
- **Won't-fix.** Declare the fake-global Node coverage sufficient and close
  AUD-13.
