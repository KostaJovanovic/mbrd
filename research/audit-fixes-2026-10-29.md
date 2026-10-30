# Audit fixes, 29 October 2026

**Status: open.** Nothing built yet.

The plan for the 20 findings of the whole-repo audit of 29 October 2026 (bugs,
safety, data loss, slow paths, dead code), and the six small ones it left out.
The audit itself was a chat report and is not kept anywhere else, so each item
below restates the case it rests on. Numbers in brackets are the audit's own
numbers, so a reply about "4" still finds its item.

Two parts of the audit were read by helper agents: the Android Java and the
hand-written file readers. Their two main claims, and the FBX and glTF ones,
were checked against the code. The rest is marked **(unverified)** and starts
with reading the lines named and confirming the case before changing anything.
A line number can have moved since 29 October.

Nothing here changes the `.mbrd` schema, the generated format catalogue or the
service-worker cache list. Batch E is the one that comes close: it changes what
a worker loads, not what `SHELL` holds.

## Order

| batch | what | audit items | why this place |
| --- | --- | --- | --- |
| A | Android: the board file and its backups | 1, 2, 12, 13 | data loss on the phone |
| B | Readers: broken files never ask to lift a limit | 4 | a stated safety rule is false |
| C | Readers: time budgets | 5, 6, 7 | a small file freezes the tab |
| D | Desktop: temp files and the store | 9, 10 | silent loss of a stored value, junk in Documents |
| E | The ffmpeg core from the CDN | 3 | needs the maintainer's choice first |
| F | Cloud sync table | 8 | a board keeps syncing after Stop |
| G | One "which files does this board use" walk | 11 | a trap for the next asset class |
| H | Android: duplicates and the update row | 14, 15, and four small ones | wrong but not lossy |
| I | Wrong drawings and missing tags | 16, 17, 18, 19 | legal files shown wrong |
| J | Clean-up | 20, and two small ones | lean |

One commit per batch (`save.bat quick-commit`), A first. E waits on the
question in its section. Each batch says which tests it adds; none is done
until `npm test`, `npm run lint` (in PowerShell, see the rtk note) and
`npm run typecheck` pass, plus `cd desktop && npm run typecheck` for D and the
Gradle unit tests (`mobile/android`, `gradlew test`) for A and H.

---

## A. Android: the board file and its backups

**A1. Flush before the rename [1].** `MbrdBytes.java:147-178`, the `end` step
for `file`, `create` and `store`, closes the temp file and renames it with no
`getFD().sync()`. `MbrdFiles.java:274-284` (`adopt`) does the same. A power
loss a few seconds after a save can keep the rename and lose the bytes, and the
board opens empty. The desktop's `desktop/atomic.mts` is the model.

- Keep the `FileOutputStream` under the buffered stream in `begin()`, and in
  `end` call `flush()` then `fos.getFD().sync()` before `close()` and
  `renameTo`. Same in `adopt`.
- For `create` (a new name in the folder), also try a folder flush as
  `atomic.mts` does on Linux. Android has no clean API for it; skip it if it
  needs reflection, and say so in the comment.
- Test: none can prove a flush. Read the diff against `atomic.mts`.

**A2. A backup read stays read-only [2].** `MbrdFiles.java:400-402`: `read()`
returns `fileResult(file)` for a `READ_ONLY` path, and `fileResult()`
(`:151-156`) adds the path to `KNOWN`, which `checked()` then accepts for the
byte channel's `file` and `append` targets. After Earlier versions → open, a
write aimed at the backup replaces it. `desktop/files.ts:317-318` does not
vouch the path.

- In `read()`, for a `READ_ONLY` path, build the reply with
  `described(file.getName(), file.getPath(), token(new Handed(file, null)))`
  and leave `KNOWN` alone.
- Test: if `MbrdFiles` cannot be reached from a JVM unit test without
  Capacitor, pull the "may this path be written" decision into a pure helper
  (as `MbrdNames.isFolderBoard` is) and test that `READ_ONLY` paths answer no.

**A3. The bin keeps a board 30 days by its own clock [12] (unverified).**
`MbrdBoards.java:131-133` ignores what `setLastModified()` returns, and
`sweepBin()` (`:165-171`) deletes by modified time. Where shared storage
refuses to set the time, a board last edited two months ago is binned today
and deleted at the next launch.

- Put the time it was binned in the bin name: `<millis>-<name>.mbrd` under
  `.trash/`, sweep by the number, and fall back to the modified time only for a
  name with no number (bins made before this change).
- Restore, if the bin is listed or restored anywhere (check the page's "bin"
  rows and `MbrdBoards`), strips the prefix.
- Test: a pure `binnedAt(name, mtime)` in `MbrdNames` or `MbrdBoards`, tested
  in `MbrdNamesTest`.

**A4. Boards from "Not now" move with the store [13] (unverified).**
`MbrdRoot.java:56-79` and `:126-144`: the first run with the storage grant
moves `.store/` into Documents/mbrd but leaves the private `files/mbrd/*.mbrd`
behind, though `MbrdShell.java:176-177` told the user that allowing access would
keep them. An uninstall then deletes them.

- In the same one-time move, move each private `*.mbrd` into the folder under
  `MbrdBoards.freeFile` inside `synchronized (MbrdBoards.NAMES)`, copy then
  delete (a rename across the two roots may not work), and rewrite the shelf
  index rows whose `path` named the old file. The index is the `library-index`
  key in the `kv` store, which `MbrdStore` holds.
- A board that fails to move stays where it is and keeps its row; the move runs
  again at the next start. Never delete the private copy before the new one is
  flushed (A1).
- Until this is built, `startupNotes` should keep naming the private folder
  while it holds boards.
- This touches the user's own files on the first launch after an update. Try
  it on a phone with three boards made under "Not now" before committing.

---

## B. Readers: a broken file never asks to lift a limit

The rule (CLAUDE.md, Safety rules): `Oversize` is a question about a ceiling,
a plain `Error` (here `MeshError`) means the file is broken, and `lift` must
never reach the second. Each item below asks the question about a file that is
broken, so a "yes" spends memory on nothing.

**B1. FBX [4].** `mesh/fbx.ts:155` inflates with `inflateZlib(p.data)`, whose
only cap is `MAX_INFLATE` (512 MB), and compares `p.length * width` with the
result only afterwards (`:158`). A `Vertices` array declaring 9 elements whose
zlib data inflates to 500 MB is paid in full; past 512 MB the user is asked an
`Oversize` question about it.

- Give `inflateZlib` (`mesh/zip.ts`) an output limit argument. In `unpack()`,
  pass `p.length * width` and throw `MeshError('This FBX has an array longer
  than it declares')` the moment output passes it.
- Same gap in `mesh/zip.ts` `entryBytes` (`:381`, unverified): output past an
  entry's declared size is allowed up to the archive budget. Cap it at the
  declared size and throw `MeshError` past it, as `storage/zip.ts` `inflateRaw`
  does.
- Test (`tests/mesh-limits.test.js`): a tiny FBX whose packed array inflates
  past its declared length throws `MeshError`, not `Oversize`.

**B2. glTF [4].** `mesh.ts:589-606` checks `count` against the ceilings and
calls `alloc()` before it compares the bufferView with the buffer. A 1 KB GLB
with a 12-byte BIN chunk and an accessor of `count: 1e8` asks about
300,000,000 values; on "yes" it allocates 1.2 GB and then throws "truncated".

- Move the buffer lookup and a bounds check above the ceilings: when a view
  exists, throw `MeshError('This model declares data it does not contain')` if
  `start + (count - 1) * stride + comps * size > bv.byteLength`, or if the view
  itself runs past its buffer. Then the ceilings, then `alloc()`.
- `tests/mesh.test.js:707` expects the `Oversize` for a 4-byte buffer. Change
  it to expect `MeshError`, and keep one test where the data is really there and
  really over the ceiling, which must still be `Oversize`.

**B3. OFF and ASCII PLY [4] (unverified).** `mesh/off.ts:37` throws `Oversize`
before the line-count check at `:39`. Swap them. `mesh/ply.ts:180` (ASCII):
check the declared count against the lines the file has before the ceiling.
One test each in `tests/mesh-formats.test.js`.

**B4. Cover art [4] (unverified).** `import/artwork.ts:121` (ID3 size) and
`:281` (FLAC block length) judge the claimed size against the ceiling. A 5 MB
MP3 whose header claims 200 MB asks about 200 MB. Throw a plain `Error` when
the claim is past the end of the file (`size > file.size - 10` for ID3, the
block end past the file for FLAC), before the ceiling. Test in
`tests/artwork.test.js`.

---

## C. Readers: time budgets

**C1. PureRef picture scan [5] (unverified, measured by the agent).**
`import/pureref.ts:110-133` (`jpegEnd`), `:247-257` and `:333-343`
(`scanPictures`): at every `FF D8 FF` or PNG signature the scan walks segments
to the end, then moves on one byte. A file of the 8-byte block
`FF D8 FF FE 00 06 00 00` repeated makes every start walk to the end: 256 KB
took 1.6 s, so 1 MB is about 26 s, on the main thread.

- One step counter per scan, shared by every `jpegEnd` and `pngEnd` call
  (`{ left: b.length / 4 + 1e6 }`), each segment hop costs one. When it runs
  out, stop scanning and keep the pictures found so far.
- This is a time limit, not a size ceiling: running out is not an `Oversize`,
  and there is nothing to lift. Say so in the comment.
- Test (`tests/pureref.test.js`): 1 MB of that block finishes under a second.

**C2. STEP colouring [6] (unverified, measured).** `mesh/step.ts:887-907` and
`:831-836`: each `STYLED_ITEM` walks the faces under its item with a 2,000,000
step cap per walk. N items pointing at one shell of N faces is N×N; 8,000 took
7.9 s. Pass one budget per parse into `facesUnder`; when it is spent, stop
colouring and placing and draw the rest grey. Test in `tests/mesh-formats.test.js`
with N = 8,000 under a second.

**C3. Spreadsheet cells [7] (unverified).** `ui/documents.ts:134-163`,
`:420-427`, `:612-626`: `MAX_CELLS` restarts in every `tableOf` call, sheets
and ODF tables have no `MAX_PAGES` slice, and the ODF repeat count fills
`cells` before any cap. A 3.3 MB xlsx of 1,000 sheets builds about 41 million
cells.

- One counter per `readDocument`, passed into `tableOf`; the ODF repeat count
  takes from the same counter as it expands; `.slice(0, MAX_PAGES)` on sheets
  and tables. A cut table says it was cut, as the CSV one does.
- Test in `tests/documents.test.js`: many sheets add up to at most `MAX_CELLS`.

---

## D. Desktop: temp files and the store

**D1. One temp file per write in the store [9].** `desktop/store.ts:51-53`
writes every value to `<key>.tmp`. Two writes to one key at once open the same
temp file, the bytes mix, the rename keeps the mix, and `readValue()` logs a
warning and answers `undefined`. Use `file + '.' + randomUUID() + '.tmp'`.
`keys()` already skips names ending `.tmp`. Test: two `writeAtomic` calls to
one target with distinct temp names both resolve and the target decodes as one
of the two values (`tests/desktop-atomic.test.js`).

**D2. No temp file left behind [10].** `desktop/atomic.mts:14-21` leaves the
temp file when the write or the flush throws (a full disk). And the close path
can cut a write off: `web/assets/js/main.ts:624` compacts on close (a whole
write of the board), and `desktop/main.ts:585-588` closes after 10 s whatever
the page is doing, so a large board's compaction dies with the process. Nothing
deletes `*.mbrd-tmp`, and `boards.ts` `list()` hides them.

- `writeAtomic`: on any throw before the rename, `unlink(tmp)` (ignore its
  error) and throw the original.
- `boards.ts` `list()`: delete `*.mbrd-tmp` files in the folder older than an
  hour (a live write is never that old).
- **Question for the maintainer:** keep compacting on close? A minute of no
  edits (`QUIET_MS`) already compacts. Taking it off the close path removes the
  only write that can outlast the 10 s timer. The plan assumes yes, take it off;
  the sweep above is needed either way, for the full-disk case.
- Tests: `tests/desktop-atomic.test.js`, a write whose data throws leaves no
  temp file. Run `cd desktop && npm run typecheck`.

---

## E. The ffmpeg core from the CDN [3]

`optimize/media.ts:15` names `@ffmpeg/core@0.12.6` on cdn.jsdelivr.net, and
`optimize/media-worker.js:60` runs it with `importScripts(url)`, then fetches
the wasm at `:78`. `web/_headers` removes the CSP for that worker. The worker is
on the app's origin, so whatever the CDN serves can read and write IndexedDB
(every board in the browser) and CacheStorage (the service worker's copy of
`app.js`). Nothing checks the bytes. The `_headers` comment "No DOM, no state,
cannot reach the page" says less than is true.

**Question for the maintainer:** vendor the core, or pin its hashes? Vendoring
means no CDN at all, but check the wasm's size first: if it is past the deploy
host's per-file limit (Cloudflare's is 25 MiB), that is why it is not vendored
now, and pinning is the answer. The plan assumes pinning.

- In `media.ts`, next to `CORE_DIR`, the two SHA-256 values of
  `ffmpeg-core.js` and `ffmpeg-core.wasm` at 0.12.6. Compute them from the
  CDN's files once, by hand, and say in the comment how.
- `boot` sends the URL and both hashes. The worker fetches the script and the
  wasm, digests each with `crypto.subtle.digest('SHA-256', ...)`, and refuses
  (`ready`, `ok: false`) on any mismatch. Then `importScripts(URL.createObjectURL(
  new Blob([js], { type: 'text/javascript' })))`, revoke the URL, and pass the
  checked bytes as `wasmBinary` as now.
- Check whether the UMD core resolves anything else through `locateFile`
  (a worker file). If it does, that file needs the same check or the plan
  changes.
- Correct the `_headers` comment: the worker has the origin's storage; what
  keeps it honest is the hash.
- Tests: `tests/media.test.js` holds `CORE_DIR`; add that both hashes are 64
  hex digits, and that the worker source refuses a core whose digest differs
  (the worker's message handler can be driven in Node with a stub `self`,
  `fetch` and `importScripts`). `tests/csp.test.js` must still pass.
- The desktop shell serves the same exemption (`desktop/protocol.ts` reads
  `_headers`), so the fix covers it with no extra edit.

---

## F. Cloud sync table [8]

`storage/storage.ts:686-690` (`stopSyncingBoard`) and `:773`
(`openCloudBoard`) rewrite the `cloud-sync` table through `writeSyncRow`
(`storage/cloud/sync.ts:72-77`, read, change, write) outside `cloudTurn`. Stop
during an upload: the upload lands and writes the row back, and the board
syncs again. Two rewrites at once lose one row.

- Run `forgetSync` and `openCloudBoard`'s `writeSyncRow` inside `cloudTurn`.
  `openCloudBoard` must not hold the queue for the whole pull; wrap only the
  row write.
- A plain push already queued behind the Stop still runs, because `pushOnce`
  pushes with `known: null` when the row is gone. Before changing that, find
  every caller of `pushBoardToCloud()`: if none pushes a board that was never
  synced, `pushOnce` can return early when `syncFor(id)` is null. If one does
  (the share link, say), leave it and accept the one extra upload.
- Test (`tests/sync.test.js` or `tests/cloud-board.test.js`): a push held open
  by a fake provider, Stop called meanwhile, the push released: the table has
  no row for the board afterwards.

---

## G. One "which files does this board use" walk [11]

`storage/session.ts:245-276` (`referencedHashes`, which decides what the web
autosave deletes) and `storage/mbrd.ts:126-143` (`boardAssetHashes`, cloud
sync) walk the same tree: items, bin, fonts, timeline, wallpaper, child boards.
Only the second is held to the packer by `tests/mbrd.test.js`, and CLAUDE.md's
"A new class of asset reference" names only it. A class added there and not in
`session.ts` is deleted from IndexedDB by the next autosave on the web.

- One walk in `mbrd.ts`, `boardHashes(board: unknown, each = itemHashes)`, that
  takes a board as stored (so `isRecord` and `listOf` checks on every level, as
  `session.ts` does now; a malformed stored board must not throw at restore)
  and the per-item function. `boardAssetHashes` becomes
  `boardHashes(board)` filtered by `isHash`; `session.ts` calls
  `boardHashes(data, heldHashes)`.
- Delete `referencedHashes`, `BoardLike`, `listOf` and `str` from
  `session.ts` if nothing else there uses them (about 30 lines).
- `tests/mbrd.test.js` already holds the packer to `boardAssetHashes`; add one
  assertion that the session walk over the same fixture is that set plus the
  optimiser originals. `tests/session.test.js` must pass unchanged.
- Update CLAUDE.md's "A new class of asset reference" line to name the one
  walk.
- `session.ts` sits in `storage/` beside `mbrd.ts`, so the layering test does
  not care; check `tests/layers.test.js` anyway.

---

## H. Android: duplicates and the update row (unverified)

**H1. "Open with" duplicates a board already in the folder [14].**
`MbrdFiles.java:291-303` (`directFile`) recognises only
`com.android.externalstorage.documents` URIs, so Files by Google and Samsung
My Files hand over URIs that `adopt()` (`:334-344`) copies: every tap on
`trip.mbrd` makes `trip_(2).mbrd`, and the edits go to the copy. In `adopt()`,
before naming the copy, if the folder holds a file under the incoming name with
the same length, compare the bytes with the copied temp file; if equal, delete
the temp and return the existing file.

**H2. The update row after Cancel [15].** `MbrdUpdate.java:115-138` and
`:195-212`: a background download sets `readyFile` but not `waiting`, and
`installNow()` deletes the file after committing. When the confirm screen is
cancelled the row still says ready and a press does nothing; the next start
skips the check for 24 h. In `background()`, also set `waiting = apk;
waitingVersion = version;`. `MbrdUpdateTest` may already cover the state
machine; add the Cancel case there if it does.

**H3. The four small ones.** Each is a few lines.

- Rename to the same name in other letters does nothing
  (`MbrdBoards.java:109-111`): treat it as no change only when
  `to.getName().equals(from.getName())`; otherwise `renameTo`. The desktop does
  the same on purpose (`desktop/boards.ts:112-115`).
- Two sign-ins at once leave the first waiting forever
  (`MbrdAuth.java:65-86`): mark busy before `authorize()`, clear it on every
  reject path and in `consented()`.
- `adopt()` names its copy outside the names lock (`MbrdFiles.java:272-284`),
  so a board made meanwhile can be replaced by the rename: take the free name
  and rename inside `synchronized (MbrdBoards.NAMES)`, as `MbrdBytes` does.
- Any ZIP is adopted as a board (`MbrdFiles.java:265-271`): take the ZIP magic
  only for a name with no extension, as `incoming()` does at `:340`.

---

## I. Wrong drawings and missing tags (unverified)

**I1. IGES arcs [16].** `mesh/iges.ts:439-449` gives entity 100 the domain
0..2π from angle 0 and never reads the end point (parameters 5 and 6), so
every arc draws as a full circle: slot outlines in 144 trimmed planes, every
fillet in a 510 B-rep. Set `a0 = atan2(start - centre)`,
`a1 = atan2(end - centre)`, add 2π when `a1 <= a0`, and use `[a0, a1]`. Test in
`tests/mesh-formats.test.js`: a semicircle arc's points all lie on one side of
its chord.

**I2. AMF nesting [17].** `mesh/amf.ts:44-47` draws every constellation as a
root, so one placed inside another is drawn twice; `:39` adds nested Euler
angles instead of applying the inner rotation, then the outer. Draw only
constellations no other one references, and compose the rotations on points.
One test with two levels.

**I3. ID3 extended header [18].** `import/artwork.ts:130-141`: with flag
`0x40` the frame walk starts on the extended header and stops. Skip it first:
`4 + be32` for v2.3, the syncsafe size for v2.4. Test in
`tests/artwork.test.js` with a v2.3 and a v2.4 tag carrying one.

**I4. xlsx sheet names [19].** `ui/documents.ts:424-429` pairs names in tab
order with `sheetN.xml` in file order. Resolve each `<sheet r:id>` through
`xl/_rels/workbook.xml.rels` with the existing `relationships()` helper. Test
in `tests/documents.test.js` with a tab moved to the front.

---

## J. Clean-up

- **Delete `tools/ste-js-to-ts.py` and `tools/ste-audit.py` [20].** Nothing in
  the repository names either (checked on 29 October with `git grep`, outside
  `research/old/`). The first was a one-off rewrite that is done; the second
  loads a script from `~/.claude/skills/` and runs on one machine. 282 lines.
- **`desktop/board-names.mts:19` holds a literal NUL and a 0x1F byte** inside
  the regex character class, which makes editors and tools treat the file as
  binary. Write the range as `\x00-\x1f`. The file cannot be changed with the
  Edit tool while the bytes are in it, so this one edit is the exception that
  needs a shell command; say so in the commit. `tests/desktop-board-names.test.js`
  must pass unchanged.
- **Stale paths in comments:** `storage/cloud/oauth.ts` and `web/oauth.html`
  still say `storage/share/oauth.ts`; the module is `storage/cloud/oauth.ts`.
  The `_headers` header says "seven hashes" above a list of eight.

---

## What the audit did not read

`canvas/` (`input.ts`, the renderers, the viewport), most of `ui/`, `state.ts`,
the timeline, layout and arrange, the import pipeline outside the readers
above, `cuelume/`, `perf/`, the desktop title bar and menus, `save.bat` and the
build. No tests, lint or build were run for it. A second pass over `canvas/`
and `import/drop.ts` is the obvious next audit.
