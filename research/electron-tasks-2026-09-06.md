# Electron — the task list

Open work. The executable half of
[`electron-2026-09-06.md`](electron-2026-09-06.md). That document argues *why*
and records every decision; this one says *what to do, in what order*. Read
that one when a task here points at a section of it, and read its §1 table
once before starting, because every choice in it was made by the maintainer and
is not yours to reopen.

Written against `9cf7cc6` (v0.272), tree clean apart from the two research
documents.

**Who this is for.** An agent — the maintainer intends an Opus 4.8 session —
working through the groups one at a time, in order, over several sessions.
Each task names the file, gives a string to find it by, says what is there,
says what to change, and says how you know it is done. Unlike
`simplification-tasks-2026-08-18.md`, most tasks here *build* rather than
edit, so the anchors are for the seams in the existing code and the new files
are described by what they must export and what test holds them.

---

## Rules that apply to every task

**1. `CLAUDE.md` first, then the header of any file you touch.** Both are
short and both are checklists of things that fail silently. The header wins
over this document if they disagree; stop and record it in the checklist at
the foot.

**2. Find by string, never by line.** Every task gives a **Find**. If what you
find does not match what the task says is there, mark the task
`SKIPPED — anchor mismatch` and move on. A task whose ground has moved is a
task whose reasoning may not hold.

**3. The web app must work at every commit.** This is the whole design of
Phase 0 and it is the property every later group leans on. Every port is
unwired by default and the unwired behaviour *is* the web behaviour. If a
change would alter what a browser user sees before the desktop shell exists,
you have misread the task.

**4. Never touch these.** `patch-notes.md`; `web/patch.html`; `web/404.html`;
`web/assets/js/version.js` and the `VERSION` line in `web/sw.js`;
`web/assets/js/import/formats.ts`; `web/assets/stickers.svg`;
`web/assets/app.js` (rebuild it, never edit it); the `.mbrd` schema in
`board-schema.ts` and `docs/mbrd-format.md`; `web/_headers` (the desktop
*reads* it); `SHELL` in `web/sw.js`.

**5. No module reads a browser or Node global at import time.** The bridge
object is an *argument* to `electronPlatform()`. Only `main.ts` reads
`window.mbrdDesktop`, once. `tests/imports.test.js` is the guard and you do
not add an exemption to it.

**6. `tsconfig.json` at the root does not change.** Its `types: []` is argued
in its header. `desktop/` gets its own config with Node types.

**7. Root `package.json` gains no dependency.** Electron and everything native
live in `desktop/package.json`. `npm test` at the root installs nothing, and
CI's first step is what checks that claim.

**8. Edit with the file tools.** Read, Edit, Write, Grep, Glob. The shell is
for `npm`, `git`, `node --check`, and running the app.

**9. Verify at group boundaries.**

```bash
npm test            # first, no install
npm run lint
npm run typecheck
npm run build
git ls-files 'web/**/*.js' 'web/*.js' 'tools/*.mjs' | xargs -n1 node --check
```

From group D onwards, also `cd desktop && npm run typecheck && npm run build`.

**10. Do not `git push`.** Commit at the end of each group with the message the
group names. Tagging a release is the maintainer's.

**11. When you finish a group, update the checklist at the foot** and, if a
decision in `electron-2026-09-06.md` turned out to be wrong in practice, add a
dated note under its §12 rather than silently doing something else.

---

## Order

| group | what | plan § | web still works? |
| --- | --- | --- | --- |
| A | the `platform/` module and the store backend seam | §4 | yes — nothing wired |
| B | the document ref, Save / Save As, the shelf's `path`, close and open-files handlers | §4 | yes — web adapter is the old behaviour |
| C | tests for the ports | §4, §11 | yes |
| D | `desktop/`: a window that loads the app from `app://` with the CSP | §3, §5 | yes |
| E | the Electron adapter: store, files, lifecycle, links, shelf | §4 | yes |
| F | native menu, title bar, single instance, open-with | §4, §8 Phase 1 | yes |
| G | native work: ffmpeg, onnxruntime-node, sharp | §6 | yes — every port answers null unwired |
| H | packaging: NSIS Install/Portable, DMG, AppImage, icons | §8 Phase 3 | yes |
| I | updater and the release workflow | §8 Phase 3 | yes |
| J | the Playwright smoke and the download page | §8 Phase 3 | yes |

A and B are the risky groups because they touch `storage/`. Everything from D
on is new files. Do not start D before C is green.

---

# A — `platform/` and the store seam

Commit: `A platform ports, unwired`.

### A1 — The module

**Create** `web/assets/js/platform/platform.ts`.

**Header** argues, in the style of `notify.ts`'s: seven questions the browser
answered (plan §3 table), each becomes a port, unwired means web, the bridge
is never read here. Point at `electron-2026-09-06.md` §4.

**Exports**

```ts
export function isDesktop(): boolean                 // false until setPlatform()
export interface DocumentRef { name: string; path?: string }
export interface FilesPort { pickOpen; pickSave; write; pickImport; exists }  // §4 files; exists(ref) is for the shelf (B3)
export interface LifecyclePort { onCloseRequested; onOpenFiles }            // §4 lifecycle
export interface NativePort { firstFrame; transcode; matte; decode }        // §4 native
export interface UpdatesPort { check; install }                             // §4 updates
export interface Platform { files; lifecycle; native; updates; relaunch(): void }
export function setPlatform(p: Platform | null): void
export const platform: Readonly<Platform>          // a proxy that reads the current one
```

The web defaults live in this file: `files` throws `AbortError`-shaped
rejections where the browser has no picker (the callers already treat that as
"dismissed" — see `isAbort` in `storage.ts`), `exists` answers `true` (a
handle the browser gave back is as good as it gets), `lifecycle.onCloseRequested`
registers on `pagehide` and cannot await, `native.*` resolve `null`,
`updates.check` resolves `null`, `relaunch` is `location.reload()`.

The `declare global` block that puts `showSaveFilePicker` and
`showOpenFilePicker` on `Window` moves here from `storage.ts` (B1 removes it
there). **Every `typeof window.showSaveFilePicker` test lives inside a
function.** Evaluating it at module scope breaks `tests/imports.test.js` and
this task's own done-when.

**Done when** `node -e "import('./web/assets/js/platform/platform.ts')"`
loads with no browser, and `isDesktop()` is false.

### A2 — Layering

**File** `tests/layers.test.js`

**Find** `'consent.ts',` — the last entry of `BASE`.

**Do** Add `'platform/platform.ts'` and `'platform/electron.ts'` with a comment
in the style of the entries above it: a thing storage, canvas and main all ask
has to be under all of them.

**Done when** `node --test tests/layers.test.js` passes with A1 in place.

### A3 — The store backend seam

**File** `web/assets/js/storage/idb.ts`

**Find** `function tx<F extends Issued>(`

**Now** `tx()` is the only door: every export below it is `tx(store, mode, fn)`.

**Do** Define a `StoreBackend` interface with exactly eight operations —
`get set del keys clear getMany setMany delMany` — over `StoreName`, make the
IndexedDB code the default backend behind it, and export
`setStoreBackend(b: StoreBackend | null)`. The eight exports the file has
today — `idbGet idbSet idbDel idbKeys idbClear idbGetMany idbSetMany
idbDelMany` — keep their names and signatures; each becomes
`backend().<op>(...)`. (The interface drops the `idb` prefix because the
second backend is not IndexedDB; the exports keep it because forty callers
use it.)

**Header** gains the paragraphs plan §4 *store* asks for: the file backend
writes keys one at a time, so the batch forms lose "all land or none", and that
is safe because of the order `writeSnapshot()` in `session.ts` argues; `clear`
must be atomic on every backend; keys are lowercase and under 200 bytes.
Leave a one-line pointer at `writeSnapshot()` too, naming this file.

**Guard** `session.ts`, `library.ts`, `matte-cache.ts`, `storage.ts` do not
change. Run `npm test` — the storage tests drive the IDB path through fakes and
must be untouched.

**Done when** `tests/` is green and `grep -rn "indexedDB" web/assets/js` finds
it only in `idb.ts` and `storage.ts`'s `storageBreakdown()`.

---

# B — The document, the shelf, and the two handlers

Commit: `B document model behind the ports`.

### B1 — The document ref replaces the file handle

**File** `web/assets/js/storage/storage.ts`

**Find** `let fileHandle: FileSystemFileHandle | null = null;`

**Now** The handle is held here, `canPickFiles()` tests for
`showSaveFilePicker`, and `exportBoard()` and `openFile()` read and write it.

**Do** Hold `let doc: DocumentRef | null = null` instead. The web adapter in
`platform.ts` (A1) is where `showSaveFilePicker` / `showOpenFilePicker` and the
hidden `<input type=file>` now live, wrapping a `FileSystemFileHandle` inside
its own `DocumentRef`; the `declare global` block for the two pickers
(**Find** `showSaveFilePicker?: (opts?: FilePickerOptions)`) goes with them
and is deleted here. `exportBoard()` becomes: `pickSave` when `pickNew` or
`!doc`, then pack, then `platform.files.write(doc, blob)`. `openFile()` takes
`(file, ref: DocumentRef | null = null)`. `saveBlob()` and the download path
stay as the web adapter's `write` when there is no handle.

**Guard** The picker still runs *before* anything is serialised — the comment
above the picker call says why and it still holds. `setTitle(titleFromFileName(...))`
still runs on the web when a picker was used.

**Done when** in a browser: Export, Export as, Open, and a dropped `.mbrd` all
behave as before. `tests/` green.

### B2 — Save means the file on desktop

**File** `web/assets/js/commands/file.ts`

**Find** `export: async () => { if (await confirmEmptyExport()) await exportBoard(); },`

**Do** Add `saveAs` beside `exportAs`. Make `save` branch on `isDesktop()`: on
desktop it is `exportBoard()` (the file); on the web it is `saveWithCooldown()`
as now. `export` on desktop keeps its meaning of "write a copy" and is what
Share's no-history path falls through to.

**File** `web/assets/js/ui/settings-schema.ts`

**Find** `{ cmd: 'save', label: 'Save', className: 'primary', closesPanel: true },`

**Do** On desktop the row group reads Save / Save As… / Export; on the web it
stays Save / Export. Use `when`, which is *absence*, as the schema's header
says. No new control type.

**File** `web/assets/js/canvas/input.ts`

**Find** `if (e.shiftKey) cmds.export(); else cmds.save();`

**Do** On desktop `Ctrl+Shift+S` is `cmds.saveAs()`. Leave the web branch. Do
not remove the handler for desktop — plan §12's first open question is whether
the native menu (group F) swallows the keystroke before the page sees it, and
that is checked by hand on each OS after F, not assumed here.

**Done when** on the web nothing changed; `cmds.saveAs` exists and is a
command, not a listener.

### B3 — The shelf learns about files

**File** `web/assets/js/storage/library.ts`

**Find** `export type LibraryEntry = {`

**Do** Add `path?: string`. `putLibraryBoard()` takes it; a row with a `path`
stores **no blob**. `getLibraryBoard()` on such a row returns `null` and the
caller (`switchBoard()` in `storage.ts`) opens the file through
`platform.files` instead. Plan §4 *shelf* is the specification — read it, it is
short, and it says what a missing file shows and what Locate does.

**File** `web/assets/js/storage/storage.ts`

**Find** `async function shelveCurrent() {`

**Do** On desktop, a board with a `doc` and `isDirty()` is asked the close
question (`d.prompt`, Save / Don't save / Cancel, `danger: false`) *before* it
is shelved, and is then shelved as a path row. An untitled board is shelved as a
blob row, no question, as now. On the web nothing changes.

**File** `web/assets/js/ui/library.ts`

**Do** The grid draws the file name under the title on a path row, greys a row
whose file is gone (`platform.files.exists(ref)`, from A1), and offers Locate,
which is `pickOpen` and a rewrite of the row.

**Guard** `tests/mbrd.test.js` has an assertion binding the packer to the
reference walk. You are not changing either. The library's index is in the
recovery store and never enters a `.mbrd`.

**Done when** on the web the shelf is unchanged; `tests/library*.test.js`
green with a new case for a path row.

### B4 — Close and open-files go through the lifecycle port

**File** `web/assets/js/main.ts`

**Find** `addEventListener('pagehide', flushEdits);`

**Do** Replace the two listeners with
`platform.lifecycle.onCloseRequested(flushEdits)`, where `flushEdits` becomes
`async`: `flushNoteEdit()`, `await autosave()`, and on desktop the dirty
question if `doc` is set. The web default in A1 registers the same function on
`pagehide` and `visibilitychange` exactly as the two listeners do today, so
this is a move, not a change.

**Find** `if ('launchQueue' in window) {`

**Do** Leave the block. Add beside it
`platform.lifecycle.onOpenFiles(async files => { await started; await openFile(files[0], refOf(files[0])); })`.
The web default never calls it.

**Find** the comment `The desktop equivalent lands in M4 via Tauri.`

**Do** Correct it: the desktop equivalent is `lifecycle.onOpenFiles`, wired
from `desktop/`.

**Find** `if ('serviceWorker' in navigator) {`

**Do** `if (!isDesktop() && 'serviceWorker' in navigator) {`.

**Find** `location.reload();` in `session.ts`'s `clearAllData()` and in
`ui/board-actions.ts`'s `reloadBoard()`.

**Do** `platform.relaunch()`.

**Done when** `tests/boot-order.test.js` still passes — if it names either
listener, add the row rather than fight it.

---

# C — Tests for the ports

Commit: `C port tests`.

### C1 — `tests/platform.test.js`

Unwired: `isDesktop()` false; every `native.*` resolves `null`;
`updates.check()` resolves `null`; `files.pickOpen()` rejects with
`name === 'AbortError'` when there is no picker global.

Wired with a fake `Platform`: `setPlatform(fake)` makes `isDesktop()` true;
`platform.files.write` is what `exportBoard()` reaches (drive `storage.ts` with
a fake backend from C2 and a fake platform and assert the blob it wrote unpacks
to the board).

### C2 — A fake store backend drives `session.ts`

An in-memory `StoreBackend` (a `Map` per store) handed to `setStoreBackend()`.
Assert: `autosave()` → `restoreSession()` round-trips a board with one asset;
the sweep deletes an unreferenced asset; `clearAllData()`'s drain still holds
(the existing test, now on the fake backend).

### C3 — `tests/desktop-menu.test.js`

Written now, red until F. Reads `desktop/menu.ts` **as text**, pulls every
`cmd: '<name>'`, and asserts each is a key `createCommands()` returns. Mirror
`tests/icons.test.js`'s shape. **The skip is conditional on `desktop/` not
existing yet**: while there is no `desktop/package.json` the test skips with a
message; once there is one (group D), a missing `desktop/menu.ts` is a
*failure*. A skip that can stay quiet forever is the silent pass
`tests/icons.test.js` exists to prevent. D and E run red on this one test on
purpose; F turns it green.

---

# D — A window

Commit: `D desktop shell loads the app`.

### D1 — The package

**Create** `desktop/package.json`: `"private": true`, `"main": "dist/main.js"`,
**no `"type": "module"`**, `version` `0.0.0` (the release workflow stamps it —
plan §11), `dependencies`: `electron-updater`; `devDependencies`: `electron`
(current stable), `electron-builder`, `esbuild`, `typescript`. `sharp` and
`onnxruntime-node` arrive in G. Scripts: `build` (esbuild `main.ts` and
`preload.ts` to `dist/`, `--platform=node --format=cjs --external:electron`),
`typecheck`, `start` (`npm run build && electron .`), `dev`.

**Both bundles are CommonJS, and this is not a style choice.** A preload
script under `sandbox: true` (D3) *must* be CommonJS — Electron does not run
an ESM preload in the sandbox. Main could be ESM with `"type": "module"` or a
`.mjs` name, and is not, so that the two files are one format and the package
carries one rule. The sources are still TypeScript modules; only the output
format is CJS.

**Create** `desktop/tsconfig.json`: `strict`, `types: ["node"]`, `include`
`["*.ts", "native/*.ts"]`, `noEmit`.

Root `package.json` gains one script, `"desktop": "npm --prefix desktop start"`,
and nothing else.

**File** `.gitignore`

**Find** `# Tauri (M4+)`

**Do** Replace that block with `desktop/node_modules/`, `desktop/dist/`,
`desktop/out/`, `desktop/resources/ffmpeg/`.

### D2 — `desktop/protocol.ts`

`registerSchemes()` before `ready`: `app`, `{ standard, secure, supportFetchAPI,
stream, corsEnabled: false }`. `serveWeb(session)` after `ready`:
`protocol.handle('app', ...)` mapping `app://mbrd/<path>` to `web/<path>`
(resolved under `app.getAppPath()`; `..` refused; a directory serves
`index.html`; MIME from extension, `.mjs` and `.js` as `text/javascript`,
`.wasm` as `application/wasm`).

**The CSP.** Read `web/_headers`, parse the `/*` rule's
`Content-Security-Policy` and the four `! Content-Security-Policy` path
exemptions, and attach the header to every response that is not exempt. Do
not copy the policy string into this file — the test in `tests/csp.test.js`
holds the one in `_headers` to the code, and a second copy is what that test
exists to prevent.

### D3 — `desktop/main.ts`

`requestSingleInstanceLock()` first (F wires what it does). Portable check
before `ready` (H2). `registerSchemes()`. On `ready`: `serveWeb()`, one
`BrowserWindow` with `contextIsolation: true, sandbox: true, nodeIntegration:
false, preload: dist/preload.js`, `loadURL('app://mbrd/index.html')`.
`setWindowOpenHandler` → `shell.openExternal` for `http:`/`https:`, `deny`
everything; `will-navigate` denied unless the URL starts with `app://mbrd/`.

**Logging** (plan §1): a `log(level, ...args)` in `desktop/log.ts` that
appends one line per call to `userData/logs/main.log`, rotates to `main.1.log`
at 1 MB, and is what every `catch` in `desktop/` writes to. The window's
`console-message` event mirrors renderer `error`-level lines into it. No
`crashReporter`. Help → Show logs (F1) opens the folder.

### D4 — `desktop/preload.ts`

`contextBridge.exposeInMainWorld('mbrdDesktop', {...})` with a version field
and, for now, nothing else. Every later group adds functions here and the
matching `ipcMain.handle` in main. Never expose `ipcRenderer`.

**Done when** `npm run desktop` opens the board, the console says
`[mbrd] vX ready`, no CSP violation is logged, the grid paints, a dropped
picture becomes a card, a `.md` renders, and a link card opens the system
browser. The service worker is not registered (check DevTools → Application).

---

# E — The Electron adapter

Commit: `E electron adapter: store, files, lifecycle, shelf`.

### E1 — `desktop/store.ts`

The file backend: `userData/store/<store>/<key>`; a key is percent-encoded to a
file name; a value is JSON unless it arrived as bytes, in which case raw with a
`.bin` suffix. Write to `<name>.tmp` then `rename`. `keys` is a `readdir`. IPC:
`store:get|set|del|keys|clear|getMany|setMany|delMany`, values crossing as
structured-clone with Blobs already turned into `ArrayBuffer` on the renderer
side. Three rules from plan §4 *store*, each with a test in `desktop/test/`:

- **`clear` is a rename.** `rename(<store>, <store>.trash-<Date.now()>)`,
  then a best-effort recursive delete; `main.ts` sweeps `*.trash-*` under
  `store/` on boot. A clear that throws on the rename has not happened; one
  that throws after it has.
- **Keys are lowercase and under 200 bytes** or `set` throws. Every key the
  app writes today qualifies (hex hashes, `uid()`); the rule is there for the
  next one, on filesystems where `Abc` and `abc` are one file.
- **`setMany` is one message** carrying all the pairs; main writes them with
  `Promise.all` and answers once. **Measure before H**: a board of three
  hundred photographs, time from `autosave()` to resolution and from launch to
  `[mbrd] ready`, against the same board in the browser. Record both numbers
  in the checklist. The plan declines the streaming-URL escape hatch; if these
  numbers are bad, that is a note for §12, not a licence to build it.

### E2 — `web/assets/js/platform/electron.ts`

`electronPlatform(bridge): Platform` and `electronStore(bridge): StoreBackend`.
Blob ↔ `ArrayBuffer` at this seam, both directions, so the callers of `idb.ts`
keep getting Blobs. `files.pickOpen` → `bridge.pickOpen()` returns
`{ name, path, bytes }` → a `File` and a `DocumentRef`. `files.write` sends
bytes and the path; main writes temp + rename. `relaunch` → `bridge.relaunch()`.
`lifecycle.onCloseRequested(fn)` → `bridge.onClose(async () => { await fn(); bridge.closeNow(); })`.

**File** `web/assets/js/main.ts`

**Find** `initOverlays();` — the first statement.

**Do** Immediately after it, and before anything that could touch the store:

```ts
const bridge = window.mbrdDesktop;
if (bridge) { setPlatform(electronPlatform(bridge)); setStoreBackend(electronStore(bridge)); }
```

Declare `mbrdDesktop` on `Window` in the same `declare global` block that
declares `mbrd`, as optional. This is the only read of the global in the tree.

### E3 — Main's side of files and lifecycle

`dialog.showOpenDialog` / `showSaveDialog` with the `.mbrd` filter and, for
`pickImport`, the picture/clip/document extensions from
`import/formats.ts` — read the generated catalogue, do not retype it.
`window.on('close')` → `preventDefault`, send `close-requested`, and close on
`close-now` or after a 10 s ceiling with a warning. `relaunch` →
`app.relaunch(); app.exit(0)`.

**Done when** open → edit → Save → quit → relaunch → the board is back, on
Windows by hand. `Clear everything` relaunches to a first run. The shelf shows
a path row for the file and opening it reads from disk.

---

# F — Menu, title, single instance, open-with

Commit: `F native menu and open-with`.

### F1 — `desktop/menu.ts`

A table, not a `Menu.buildFromTemplate` call with logic in it: `[{ label,
cmd, accelerator?, role? }]` per submenu. File: New, Open…, Open Recent
(built from the shelf's path rows, over IPC), Save, Save As…, Export…, Close.
Edit: Undo, Redo, Cut, Copy, Paste, Select All, Duplicate. View: Fit, Recenter,
Zoom in/out, Boards, Search, toggle Feed/Canvas. Help: About (the credits
sheet), Patch notes, Report a problem (a URL). Each item's click sends
`cmd:<name>`; preload exposes `onCommand(fn)`; `main.ts` wires
`bridge.onCommand(name => cmds[name]?.())`. C3's test goes green here.

### F2 — Title and dirty mark

`bridge.setDocument({ name, path, dirty })` from `storage.ts` wherever
`markDirty` and `doc` change (the `history` and `board:load` events are the
seams). Main: `setTitle`, and on macOS `setRepresentedFilename` and
`setDocumentEdited`.

### F3 — Second instance and open-file

`second-instance` (Windows, Linux): focus the window, take the `.mbrd` out of
argv, read it, send `open-files`. `open-file` (macOS): same, and it can fire
before `ready` — hold it. First launch: `process.argv` after `ready`. The
renderer side is B4's `onOpenFiles`.

**Done when** double-clicking a `.mbrd` while the app is running opens it in
the running window; while it is not, launches and opens it — on Windows and
macOS now, and on Linux once H1's `.deb` exists (an AppImage registers no
association; that is the reason the deb is in v1). Then do the
**accelerator check** plan §12 asks for: press `Ctrl+Z` on each OS with
DevTools open and note whether the page's `keydown` fired as well as the menu.
Record the answer in `electron-2026-09-06.md` §12 and, if it double-fires,
gate the page handler's modifier branch on `!isDesktop()`.

---

# G — Native work

Commit: `G native ffmpeg, matte, decode`.

### G1 — ffmpeg

`desktop/native/ffmpeg.ts`: locate the binary under `process.resourcesPath`,
spawn with `-i pipe:0 ... pipe:1`, one job at a time, kill on a ceiling.
`firstFrame(bytes, name)` and `transcode(bytes, name, opts)`. The binary is
fetched by a script into `desktop/resources/ffmpeg/<platform>/` and is
`.gitignore`d; the release workflow runs the script. Pick a **GPL** build and
put its notice in the credits sheet's data.

**File** `web/assets/js/optimize/media.ts`

**Find** `export async function firstFrame(file: File,`

**Do** First line: `const native = await platform.native.firstFrame(...)`; if
not `null`, return it. Everything below is the wasm path and is untouched.

**File** `web/assets/js/optimize/optimize.ts`

**Find** `if (it.type === 'video') {`

**Do** Read the header of `optimize/media.ts` first — it says why video was
left alone on the web. On desktop, and only when `platform.native.transcode`
answers, the video branch shrinks the clip. Same size ceilings the picture path
uses; the swap goes through the same asset replacement the picture path uses,
so `itemHashes()` and the timeline see nothing new.

### G2 — Background removal

`desktop/native/matte.ts`: `onnxruntime-node`, execution providers in order
`dml` (Windows), `coreml` (macOS), `cpu`. Session created once, on first ask.
Input and output are the one `Float32Array` each `canvas/matte-worker.js`
already speaks.

**File** `web/assets/js/canvas/matte.ts`

**Find** `export function cutout(`

**Do** Ask `platform.native.matte` before spawning the worker; on `null` fall
through. `matteAvailable()` answers true on desktop when the bridge is there.

### G3 — Decode

`desktop/native/decode.ts`: `sharp` for `heic heif hif tif tiff` → PNG bytes.

**File** `web/assets/js/import/drop.ts`

**Find** the comment beginning `A photo this browser can't decode - HEIC, JPEG XL, camera RAW`

**Do** Read `import/preview.ts`'s header — it argues the whole HEIC situation.
Before that branch reaches for an embedded preview, ask `platform.native.decode`;
a non-null answer is treated as the decodable stand-in that path already knows
how to keep. Do not change what goes into the `.mbrd` (the original bytes).

**Done when** with the network off on desktop: an HEVC `.mov` gets a poster; a
cut-out on a 12-megapixel photograph is under a second; a `.heic` shows its
picture. On the web every one of the three behaves as before.

---

# H — Packaging

Commit: `H packaging: NSIS install/portable, DMG, AppImage`.

### H1 — `desktop/electron-builder.yml`

`appId`, `productName: mbrd`, `files: ["dist/**", "../web/**"]` (excluding
`web/lab*.html`, `web/assets/app.js.map`), `extraResources` for ffmpeg and the
model, `fileAssociations: [{ ext: mbrd, mimeType, description, role: Editor }]`.
`win: { target: nsis }`, `nsis: { oneClick: false,
allowToChangeInstallationDirectory: true, include: installer.nsh }`.
`mac: { target: dmg, arch: universal }` — if `sharp` or `onnxruntime-node`
refuse to merge, switch to `[arm64, x64]` per plan §1. `linux: { target:
[AppImage, deb] }` — the deb is what carries the `.mbrd` association on
Linux; the AppImage is the one-file download.

### H2 — `desktop/installer.nsh`

A custom page before the directory page with two radios, **Install** and
**Portable**. Portable: `$INSTDIR` defaults to beside the installer; extract;
write `portable` (empty file) beside the exe; skip shortcuts, registry, the
uninstaller, and the file association. Install: the normal flow.

`desktop/main.ts`, before `ready`: if `portable` exists beside
`process.execPath`, try `mkdirSync(join(dir, 'data'))` and
`app.setPath('userData', ...)`; on `EACCES`/`EROFS` leave `userData` alone and
set a flag the renderer reads through `bridge.startupNotes()` to toast once
(plan §1: fall back and say so).

### H3 — Icons

`desktop/icons/` from `web/assets/img`'s maskable SVG: `icon.ico` (16–256),
`icon.icns`, and PNGs 16–512. A script under `tools/` that regenerates them,
listed in `CLAUDE.md`'s generators line.

**Done when** `npx electron-builder` in `desktop/` produces the three
artefacts on their respective OSes; the Setup.exe's portable branch runs from a
folder with a `data/` beside it; the installed one opens `.mbrd` on
double-click.

---

# I — Updater and the release workflow

Commit: `I updater and release workflow`.

### I1 — `desktop/updates.ts`

`electron-updater`, GitHub provider, `autoDownload: true`,
`autoInstallOnAppQuit: true`. **First line: `if (!app.isPackaged) return;`** —
a dev build is `0.0.0` and would find every release newer. Check once after
the window is up and every six hours. On `update-downloaded` send the version to the renderer. On portable
(the marker) and on unsigned macOS (`process.platform === 'darwin'` and no
signature — read it from `app.isPackaged` plus a build-time flag), do not
download; send `{ version, canInstall: false }`.

**File** `web/assets/js/main.ts`

**Find** the toast `'New version ready — reload to update'`

**Do** That is the web's. On desktop `platform.updates` drives the same toast
with "will install when you quit" or "Download vX" and a button that calls
`updates.install()` or opens the release page.

### I2 — `.github/workflows/desktop.yml`

On `push: tags: ['desktop-v*']`. Matrix `windows-latest`, `macos-latest`,
`ubuntu-latest`. Steps: checkout; Node 22; **read `VERSION` from
`web/assets/js/version.js` and fail unless the tag is `desktop-v` + that**;
write it into `desktop/package.json`; `npm ci` at the root; `npm run build`
(the web bundle); `npm ci` in `desktop/`; fetch ffmpeg; `electron-builder
--publish always` with `GH_TOKEN`; upload. The existing `ci.yml` is not
touched.

**Done when** a tag on a test branch produces a draft release with three
assets and `latest*.yml` files, and an installed Windows copy sees the next one.

---

# J — Smoke and download page

Commit: `J playwright smoke and download page`.

### J1 — `desktop/test/smoke.spec.ts`

`@playwright/test` with `_electron.launch`. Launch → wait for `[mbrd] v`
in the console → open `tests/fixtures/<a small .mbrd>` through
`bridge` (add a test-only `openPath` behind an env flag; never in production
builds) → add a note through `window.mbrd.cmds` → Save to a temp path →
close → relaunch → assert the note is there. Runs in `desktop.yml` after the
build, on all three runners. Read `old/ui-audit-2026-08-13.md`'s section on
what a driven browser gets wrong before writing the waits.

### J2 — Download page

Wherever the site's download lives (the maintainer says), the Windows Setup,
the DMG (with chip detection if H1 fell back to two), the AppImage and the deb,
and the unsigned-build note for macOS **both ways**, because Sequoia removed the
right-click → Open bypass: System Settings → Privacy & Security → *Open
Anyway* after the first refused launch, for people who will not paste a
command, and for those who will:

```
xattr -d com.apple.quarantine /Applications/mbrd.app
```

**Done when** a tester on each OS installs from the release page and
round-trips a board. That is v1; move `electron-2026-09-06.md` and this file to
`old/` on that commit and say so in `research/README.md`.

---

## Checklist

Mark each group `DONE <commit>`, `SKIPPED — <reason>` per task, or leave
blank. A group with a skipped task is not done.

| group | status | notes |
| --- | --- | --- |
| A | DONE | `pickOpen`/`pickSave` take the picker types as an argument — see below |
| B | DONE | `read`, `refForHandle`, `OpenedFile` added to the port — see below |
| C | DONE | C3 skips until `desktop/` exists; two real bugs found — see below |
| D | DONE | boots over `app://`, no CSP violation; C3 red until F as designed |
| E | | 300-photo board: save ms / boot ms, desktop vs browser: |
| F | | accelerator check result → plan §12 |
| G | | ffmpeg build chosen: |
| H | | universal DMG: worked / fell back |
| I | | |
| J | | |

### Notes from the work

**A, A1 — the picker types are an argument.** §4 has `pickOpen()` and
`pickSave(suggested)` knowing what a `.mbrd` is. They cannot: the MIME type is
`storage/mbrd.ts`'s one exported `MIME`, `platform/` is BASE and sits under
`storage/`, and a second copy of that string down there is the thing
`docs/mbrd-format.md` exists to prevent. So both take a `PickerType[]` and the
caller passes its own `PICKER_TYPES`. The desktop adapter hands the same list
to Electron's dialog filters, so it is one list in one place either way.

**A, A1 — `canPick()` is a seventh method on `FilesPort`.** Without it there is
no way for `exportBoard()` to tell "the person dismissed the dialog" from "this
browser has no dialog", and those two have to end differently: dismissed is
`false` and silence, no-dialog is a download. That is `canPickFiles()` in
`storage.ts` today, asked of the port instead of of `window`. B1 is where it
gets its callers.

**A, A1 — two fallbacks are still in `storage.ts` and B1 moves them.** The
hidden-`<input>` picker (`pickViaInput()`) is shared with `import/drop.ts`
through `dataset.mode`, and moving it in A would have been a copy living in two
files for a commit. `pickOpen` and `pickImport` reject as dismissed until then;
nothing calls either, because A is unwired. Both are marked `TODO(B1)`.

**A, A3 — the eight exports keep their return values, not just their names.**
`idbSetMany` and `idbDelMany` resolve to an array and `tests/idb.test.js`
asserts the empty-batch case is `[]`. `StoreBackend`'s mutations are typed
`Promise<unknown>` for that reason; a tidier `Promise<void>` is a red test.

**B, B1 — the pickers take a `PickSpec`, not a `PickerType[]`.** The two
fallbacks want the accept list in two spellings — the File System Access API's
`types`, and the hidden `<input>`'s `accept` attribute, which is deliberately
wider than the first and carries its own argument about iOS and UTIs. Neither
is derivable from the other without `platform/` guessing, so both travel
together with the `dataset.mode` owner name that the one hidden input needs.
`pickViaInput()` moved across whole and is now `viaInput()`.

**B, B3 — `FilesPort` gained `read(ref)`, and `fileNameOf()` is exported.** A
path row keeps no copy, so opening one is a read of the path and there was
nothing in §4 that could do it. `fileNameOf()` is here rather than at its two
call sites — `switchBoard()` and the shelf grid — because a path is the one
value in this app whose spelling depends on the operating system, and one wrong
split renders a card labelled with a whole `C:\Users\…` path.

**B, B4 — `onOpenFiles` hands over `OpenedFile[]`, not `File[]`.** "Open this"
and "this is the document you now have open" are different claims and only the
desktop can make the second, so the ref travels beside the file rather than in
a side table. `refForHandle()` is exported for the one web caller that has a
handle already: `launchQueue`, whose handle used to become `fileHandle`
directly, and which would silently stop being able to save over the file it
opened if the ref were dropped.

**B, B3 — `tests/library.test.js` is new, and `memoryStore()` is in
`helpers.js`.** An in-memory `StoreBackend` rather than another fake
IndexedDB: it impersonates the whole of `idb.ts`'s contract instead of the
database underneath it, which is the seam both real backends sit behind. C2
uses the same helper.

**C found two bugs in B, which is what it was for.** `pickOpen()` reached the
hidden-`<input>` fallback with no `window` at all and threw a ReferenceError
rather than an `AbortError`, so the one shape of failure this whole port keeps
consistent was inconsistent in the one case a test runs in. And `exportBoard()`
wrote to `doc ?? {name}`, which on a browser with no picker but a stale
document would have written back to a file nobody was shown a dialog for; it is
`picking && doc ? doc : {name}` now, which is the branch the file always had.

**C, C2 — `tests/store-backend.test.js` rather than a section of
`platform.test.js`.** Two subjects: what a port answers unwired, and whether
`session.ts` still works over a store with no transactions. The second holds
`idb.ts`'s two stated contracts — a `setMany()` that tears is survivable
because of `writeSnapshot()`'s order, and a `clear()` that tears must reject,
which is PERSIST-03 and the one that would be a privacy failure.

**C, C3 — the skip is conditional on `desktop/package.json`, as specified, and
the assertion inside it is not.** Once `desktop/` exists, a missing
`desktop/menu.ts` fails rather than skips. There is also a named check that
`saveAs` is on the menu: it is the one command that exists *because* of the
desktop, so it is the entry a sweep would most easily pass over.
