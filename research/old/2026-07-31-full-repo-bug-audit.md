# Full Repository Bug Audit — 2026-07-31

Status: **all six closed**, 2026-07-31 (`03c3b11`, and the reset before it).

- **P0, the unresolved merge.** Not resolved hunk by hunk: `MERGE_HEAD` turned
  out to be a strict superset of `HEAD`, the same 34 commits under fresh SHAs
  plus 26 of new work. The divergence traced to a single object — GitHub's
  orphan "Initial commit", present on one side with its PGP signature and on the
  other with it stripped, which rehashed the adoption merge and everything after
  it. `main` was reset to `origin/main`; nothing local was lost.
- **P2, `cloudflared.exe`.** Closed by that reset — the incoming side had
  already untracked it and added the ignore rule. The binary stays on disk.
- **P1 `save.bat`, P2 display race, P2 `serve.py`, P3 IndexedDB.** Fixed in
  `03c3b11`, with `tests/display.test.js` and a `tests/idb.test.js` case, both
  checked against the unfixed code rather than trusting a green run.

The one recommendation not carried out is the browser smoke test (step 4), which
needs a person at the app.

## Summary

The audit found six concrete issues. The immediate release blocker is the unresolved merge: the working tree contains conflict markers in core application files and cannot boot or run the full test suite.

Both parent commits are internally green when tested in isolated clean clones:

- `HEAD` (`1dd8d11`, `v0.64`): 577/577 tests passed.
- `MERGE_HEAD` (`589b375`, `y`): 664/664 tests passed.

This means the primary failure is in the unresolved integration rather than either clean parent snapshot. The combined application cannot be browser-smoke-tested until the merge is resolved.

## Findings

### P0 — The current application cannot boot

The repository has:

- 40 unmerged paths.
- 256 conflict hunks across 36 text files.
- Four additional unmerged binary icon files.

Conflict markers remain in core entry points and subsystems, including:

- `web/assets/js/state.js:30`
- `web/assets/js/main.js:13`
- `web/index.html:34`
- `web/sw.js:15`
- `web/assets/js/canvas/input.js:42`
- `web/assets/js/ui/look.js:37`
- `web/assets/js/ui/fonts.js:141`

`npm test` fails while parsing these files with errors such as:

```text
SyntaxError: Unexpected token '<<'
```

Browsers will fail on the same merge-marker syntax before the application can initialize.

### P1 — `save.bat` can commit unresolved conflict markers

`save.bat:104` runs:

```bat
git add .
```

It does not first check for unmerged index entries. After a pull conflict, the script tells the user to resolve the conflicts and rerun it. If it is rerun in the current state, `git add .` will stage the files containing literal conflict markers, marking the conflicts as resolved from Git's perspective. The following `git commit` can then commit and potentially push an unparseable application.

The script should refuse to continue while this command returns any paths:

```text
git diff --name-only --diff-filter=U
```

### P2 — Display-cache clearing races with active image generation

In `web/assets/js/canvas/display.js`, `ensureDisplay()` schedules asynchronous generation around lines 85–86. The job later writes its result to `cache` at line 103.

`clearDisplay()` at line 151 revokes current cached URLs, clears `cache` and `pending`, and resets `queue`. It does not invalidate or cancel a generation already in progress. That job can finish after the clear and repopulate the cache.

A self-contained reproduction produced:

```json
{"cacheRepopulatedAfterClear":true}
```

Consequences include:

- A board change can retain an obsolete display copy and its object URL.
- A quality change can race with generation and leave a copy at the previous resolution.
- Concurrent old and new jobs can overwrite each other's cache entry and leak the displaced object URL.

A generation epoch or cancellation token should prevent jobs started before a clear from publishing their result. Any generated URL rejected as stale must be revoked immediately.

### P2 — Crafted paths crash a dev-server request handler

`serve.py:59` calls `os.path.commonpath()` outside the surrounding `ValueError` guard:

```python
return full == root or os.path.commonpath([root, full]) == root
```

On Windows, a request path such as `/D:/outside` can produce a candidate on a different drive from a repository on `C:`. The handler then raises:

```text
ValueError: Paths don't have the same drive
```

The affected request receives a connection failure instead of the intended 404 response. The `commonpath()` operation should be inside the `try` block, with `ValueError` returning `False`.

### P2 — A 54.2 MB platform binary remains tracked

`cloudflared.exe` is tracked by Git and is 54,213,360 bytes. The incoming `.gitignore` change adds `cloudflared.exe`, but ignore rules do not affect files that are already tracked.

Unless vendoring this executable is intentional, it must also be removed from the index. Otherwise every clone and repository history continues carrying a large Windows-only binary despite the comment identifying it as local tooling rather than source.

### P3 — Blocked IndexedDB opens can leave an orphan connection

In `web/assets/js/storage/idb.js:33`, `req.onblocked` clears `dbPromise` and rejects it. An `IDBOpenDBRequest` is still active after its `blocked` event and may later succeed when the blocking tab closes.

The reproduced sequence showed:

```json
{
  "rejectedOnBlocked": true,
  "lateConnectionClosed": false,
  "hasVersionChangeHandler": true
}
```

The caller has already received a failure, but the eventual connection is left open without a consumer. During a future schema upgrade, a temporary block can also propagate into storage code as a save failure and disable autosave for the session.

The open request should normally remain pending through `blocked`, with the UI optionally notified. If the promise is deliberately rejected, a later successful connection must be closed rather than retained.

## Verification Performed

- Queried the existing Graphify repository graph to identify state, storage, viewport, import, rendering, and service-worker risk hubs.
- Scanned the complete working tree for conflict markers and maintenance markers.
- Ran `npm test` against the unresolved working tree; execution is blocked by merge-marker syntax errors.
- Tested clean `HEAD` in an isolated clone: 577 tests passed, 0 failed.
- Tested clean `MERGE_HEAD` in an isolated clone: 664 tests passed, 0 failed.
- Ran `python -m py_compile serve.py qr.py` successfully.
- Reproduced the display-cache race with mocked browser image APIs.
- Reproduced the different-drive `serve.py` exception.
- Reproduced the IndexedDB blocked-open lifecycle leak with a mocked open request.
- Confirmed `cloudflared.exe` is tracked with `git ls-files` and measured its size.
- Removed the temporary audit clones after testing.

## Recommended Order of Work

1. Resolve every merge conflict without using `save.bat`.
2. Add an unmerged-file preflight guard to `save.bat`.
3. Run the full test suite on the resolved integration.
4. Perform a browser smoke test covering boot, pan/zoom, selection, save/open, refresh recovery, Mobile layout, and console errors.
5. Fix and test the display-cache generation race.
6. Move `commonpath()` inside the dev-server exception guard.
7. Decide whether `cloudflared.exe` belongs in source history; untrack it if not.
8. Correct the IndexedDB `blocked` lifecycle before introducing a schema-version upgrade.
