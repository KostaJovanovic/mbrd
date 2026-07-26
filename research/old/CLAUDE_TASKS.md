# Code Review Remediation Tasks

Implement the following fixes in priority order. Preserve the dependency-free architecture and existing coding style. Do not edit generated `web/assets/js/import/formats.js`. Afterward, run JavaScript and Python syntax checks and manually verify the affected browser workflows.

## 1. Protect Dirty Boards on Every Open Path

**Files:** `web/assets/js/import/drop.js`, `web/assets/js/storage/storage.js`, `web/assets/js/main.js`

A dropped `.mbrd` calls `openFile()` directly and replaces the current board without the discard confirmation used by `openBoard()`. The PWA launch-queue path has the same bypass.

- Put discard protection in a shared opening API so picker, drop, and launch paths behave consistently.
- Allow an explicit bypass only for startup flows that cannot replace active user work.
- Do not prompt until a valid open operation is actually requested.

**Verify:** Edit a board, then open another via button, drop, and launch handler. Each replacement must require confirmation; cancellation must preserve the current board and assets.

## 2. Fail Export When Referenced Assets Are Missing

**File:** `web/assets/js/storage/mbrd.js`

`packBoard()` currently warns and skips missing asset bytes, allowing export to report success and mark an incomplete board clean.

- Collect missing referenced hashes and affected item names/IDs.
- Abort packing with a clear error instead of creating an incomplete archive.
- Ensure the existing export error path shows a useful message and does not mark the board clean.

**Verify:** Construct a board item whose asset is absent and confirm export fails without writing a successful-looking `.mbrd`.

## 3. Harden ZIP Reading Against Malformed Archives and ZIP Bombs

**File:** `web/assets/js/storage/zip.js`

- Validate EOCD, central-directory, local-header, and compressed-data offsets before every `DataView` read or slice.
- Reject excessive archive size, entry count, individual uncompressed size, total uncompressed size, and suspicious compression ratios.
- Enforce limits before inflation where metadata permits, and track actual inflated totals.
- Reject truncated data and duplicate critical paths rather than silently accepting them.
- Validate CRC32 for stored and inflated entries.
- Return readable errors through the current open-file error handling.

Choose conservative limits suitable for an in-browser moodboard and define them as named constants with comments.

**Verify:** Test a normal `.mbrd`, truncated ZIP, invalid offsets, CRC mismatch, oversized declared entry, and highly compressed oversized payload.

## 4. Garbage-Collect IndexedDB Assets

**Files:** `web/assets/js/storage/storage.js`, `web/assets/js/storage/idb.js`

Autosave only inserts assets, so data from old boards and permanently removed items accumulates until quota failure.

- Determine hashes referenced by both live items and trash.
- After successfully persisting required assets and the session snapshot, delete unreferenced IndexedDB asset records.
- Do not remove bytes needed for undo/trash restoration.
- Avoid leaving a new session snapshot pointing to assets deleted by a failed or partially completed save.

**Verify:** Open multiple boards, delete and empty trash, autosave, and confirm obsolete hashes are removed while live/trash assets restore correctly.

## 5. Preserve Media Across Back/Forward Cache Restoration

**File:** `web/assets/js/storage/assets.js`

`pagehide` revokes object URLs but leaves revoked strings cached in asset entries. A back/forward-cache restore can therefore show broken media.

- Respect `PageTransitionEvent.persisted`, or clear each cached `url` after revocation so `assetURL()` can recreate it.
- Ensure normal board switching still releases URLs.

**Verify:** Navigate away and back using browser history and confirm images, video, and audio still load.

## 6. Make the First Export’s Internal Title Match Its Filename

**File:** `web/assets/js/storage/storage.js`

The board is packed before the save picker chooses a filename, then its in-memory title changes afterward. The first exported file can therefore contain the previous title.

- For picker-based new exports, choose the handle before serializing/packing, then use the selected filename-derived title consistently.
- Preserve cancellation behavior and avoid dirty-state or autosave regressions.

**Verify:** Export an untitled board as `example.mbrd`, reopen it in a fresh session, and confirm its title is `example`.

## Required Checks

Run:

```powershell
Get-ChildItem web -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
node --check tools/gen-formats.mjs
python -m py_compile serve.py
```

Add focused automated tests for ZIP parsing and persistence helpers if practical. Report changed files, tests performed, and any remaining limitations.
