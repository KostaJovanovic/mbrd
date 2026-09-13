# mbrd apps, the FileAnalyser way — tasks, 2026-09-13

*The executable half of `apps-2026-09-13.md`, and nothing else. The plan holds
the decisions and the reasons. This file holds what to do, in order, with a
string to find each place by. Written for a session that has not read the plan:
the rules below are the whole of what it needs first. When the two disagree, the
plan is the record of what was decided, this is the record of what to do, and
neither is the code.*

*The reference is `../FileAnalyser` (checked out beside this repository). Each
task names the FileAnalyser file to read before writing its mbrd twin.*

---

## Rules

1. **The web app works at every commit.** `npm test` passes after every group.
   A desktop group also leaves `desktop.bat` opening a working window.
2. **Find by string, not by line number.** Each task gives a `Find` string. When
   it is not there any more, **stop that task**, write why in the checklist, and
   go on. Do not improvise around moved code: the reason for the task may have
   moved with it.
3. **Never push, tag, release, or create secrets.** The maintainer runs
   `save.bat` (and `save.bat release`), and sets the GitHub secrets. One group is
   one save.
4. **Never hand-edit** `web/assets/js/version.js`, the `VERSION` line in
   `web/sw.js`, `web/404.html`, `web/patch.html` or `web/assets/app.js`. Never
   write `patch-notes.md`.
5. **Edit with the file tools** (Read, Edit, Write), never through the shell.
   The shell is for `npm`, `git`, `node`, `gradlew`.
6. **Before a group ends**: `npm test`, `npm run lint`, `npm run typecheck`,
   `npm run build`, and for any group that touches `desktop/`, `cd desktop &&
   npm run typecheck`. For a group that touches `mobile/android/`, `cd
   mobile/android && gradlew testDebugUnitTest`.
7. **Every new file opens with a 2–5 line header**: what it does, the key
   constraint. British spelling in user-facing text.
8. **Say it when a group changes** the `.mbrd` schema, a generated catalogue or
   the service-worker cache. None of these groups should.

---

## A — The counter and the owner

*Plan §4.5, §1 #9, #18. Small, and every later group depends on it.*

**A1. `save.bat` reads the counter from the source.**
- File: `save.bat`. Read FileAnalyser's `save.bat` `:save` block first.
- Find: `for /f %%i in ('git rev-list --count HEAD 2^>nul') do set COMMIT_COUNT=%%i`
- Do: read `COMMIT_COUNT` from `web/assets/js/version.js` with the regex
  `export const COMMIT_COUNT = (\d+);` (PowerShell, `-Encoding UTF8`), as
  FileAnalyser reads `src/core/app.ts`. Delete the `if not defined COMMIT_COUNT
  set COMMIT_COUNT=0` fallback. Add a `:countfail` label that prints why and
  aborts **before** any stamp is written. Keep the comment block style: say why
  rev-list went (a squash sent FileAnalyser from 8.14 to 0.02, and an Android
  `versionCode` must only grow).
- Done when: a save with an intact `version.js` bumps 301 to 302, and a save
  with the line blanked aborts with nothing staged.

**A2. The owner and the public links.**
*Done in part on 2026-09-13, before this list ran: the links in `menu.ts` and
`privacy.html`, `softwareHelp` and the About credit in `index.html`, its hash in
`_headers`, every link in `download.html`, and the `publish:` owner and repo
in `electron-builder.yml`. Nothing is left. Check it with the Grep below.*
- Files: `desktop/electron-builder.yml`, `desktop/menu.ts`, `web/privacy.html`,
  `web/index.html`, `web/_headers`. (`web/download.html` is group I's.)
- Find: `github.com/valjdakosta/` and `KostaJovanovic/mbrd` (Grep the repository,
  excluding `research/`, `scratch/` and `node_modules/`).
- Do: every link a user can follow names `KostaJovanovic/mbrd-release`, the
  public release repo (plan #31). The source repo is private, so its pages are
  a 404 for everybody else. `Report a Problem` in `menu.ts` and the issues link
  in `privacy.html` go to `https://github.com/KostaJovanovic/mbrd-release/issues`.
  `softwareHelp` in `index.html` goes to
  `https://github.com/KostaJovanovic/mbrd-release#readme`. In
  `electron-builder.yml`, only the `owner:` line changes here, to
  `KostaJovanovic`: group B replaces the whole `publish:` block. The About
  credit `github.com/valjdakosta/file-analyser` in `index.html` goes to
  `https://github.com/KostaJovanovic/Universal-File-Analyser`: the
  `valjdakosta` GitHub account does not exist.
  **Do not** change `mbrd.valjdakosta.com`: that is the site host. **Do not**
  change `-R KostaJovanovic/mbrd` in `save.bat` or `.github/`: the workflow runs
  in the source repo.
- The hash: `softwareHelp` sits in an inline `<script type="application/ld+json">`,
  and `web/_headers` admits that block by the hash of its bytes. The new hash
  replaced the old one in `script-src`. Until `save.bat` remakes
  `web/404.html`, that file still carries the old block, so two tests fail:
  `tests/notfound.test.js` and the CSP test for a hash per inline script.
  Neither is a fault in the change.
- Done when: the Grep finds no `github.com/valjdakosta/`, and outside `save.bat` and
  `.github/` every `KostaJovanovic/mbrd` is `KostaJovanovic/mbrd-release`.
  `npm test` passes except `tests/notfound.test.js`, which passes after the
  save. `tests/download.test.js` still passes (it matches any owner).

---

## B — The desktop updater

*Plan §4.2, §1 #3. Read FileAnalyser's `desktop/updater.mjs` whole first.*

**B1. Rewrite `desktop/updates.ts` as a port of `updater.mjs`.**
- File: `desktop/updates.ts` (replace the file).
- Keep: mbrd's `log()` for failures, TypeScript, CommonJS output.
- Port: `installKind()` (installer when `Uninstall mbrd.exe` is beside the exe
  and no `portable` marker, `appimage` when `APPIMAGE` is set, `manual`
  otherwise, `dev` when not packaged), `latestRelease()` against
  `https://api.github.com/repos/KostaJovanovic/mbrd-release/releases/latest`
  (the public release repo, plan #31: no token), `download()` with the streamed SHA-256, `fetchUpdate()`, `runInstaller()`
  (`/S --updated`, plus `--force-run` on Restart now), `check(manual)`,
  `offerRestart()`, `offerDownload()` (the portable text names the `data`
  folder), the `declined` set, `FIRST_CHECK_MS = 20 s`, `EVERY_MS = 6 h`, the
  `will-quit` install.
- The asset patterns: `^mbrd-Windows(-\d+(\.\d+)*)?\.exe$` and
  `^mbrd-linux-x64(-\d+(\.\d+)*)?\.AppImage$`. Export them: group I's test
  reads them.
- Exports: `startUpdates({ window, portable })` and `checkForUpdates()`.
- Done when: `cd desktop && npm run typecheck` passes.

**B2. Wire it in main.**
- File: `desktop/main.ts`.
- Find: `ipcMain.handle('updates:check', () => updates.check());` and the line
  after it, `ipcMain.on('updates:install', () => updates.install());`
- Do: one handler, `ipcMain.handle('updates:check', () => {
  updates.checkForUpdates(); })`, answering nothing. Delete `updates:install`.
- Find: `updates.watchForUpdates();`
- Do: `updates.startUpdates({ window: current, portable: <the portable flag
  claimPortableData() computed> })`. Store that flag in a module variable when
  `claimPortableData()` runs.

**B3. The bridge and the port.**
- File: `desktop/preload.ts`. Find: `  updates: {`. Do: `updates: { check: () =>
  invoke('updates:check') }`. Delete `install` and `onFound`.
- File: `web/assets/js/platform/electron.ts`. Find: `  updates: {` (in
  `Bridge`). Do: `updates: { check(): Promise<void> }`. Find: `function
  electronUpdates(bridge: Bridge): UpdatesPort {`. Do: `check: () =>
  bridge.updates.check().catch(() => {})`.
- File: `web/assets/js/platform/platform.ts`. Find: `export interface
  UpdatesPort {`. Do: `check(): Promise<void>`, with a doc line: the shell
  answers in its own dialogs. Remove `UpdateInfo` and `install()`. Web default:
  `check: async () => {}`.
- File: `web/assets/js/main.ts`. Find: `// Desktop update announcements
  (electron-updater).` Do: delete that whole `if (bridge) { … }` block. The
  shell's dialogs answer now.
- File: `tests/platform.test.js`. Find: `test('the updates port answers null,
  because the service worker is the web updater', async () => {`. Do: assert
  `check()` resolves `undefined` and the fake at `updates: { check: async () =>
  null, install() {} },` becomes `updates: { check: async () => {} },`.

**B4. The package and the build config.**
- File: `desktop/package.json`. Find: `"electron-updater": "^6.6.2",`. Delete
  it, and `--external:electron-updater` from the `build` script. Rewrite the
  sentence in `description` that names electron-updater. Run `npm install` in
  `desktop/` so the lockfile follows.
- File: `desktop/electron-builder.yml`. Find: `publish:`. Do: `publish: null`,
  with FileAnalyser's comment (no `latest*.yml`, no blockmap, the updater reads
  the GitHub API). Add `differentialPackage: false` under `nsis:` and
  `dmg: { writeUpdateInfo: false }` (keep the existing `dmg:` key).
- Grep: `MBRD_SIGNED` and `electron-updater` across `desktop/`, `web/` and
  `.github/`. Nothing may remain but historical prose.
- Done when: `cd desktop && npm run build && npm run typecheck` pass, and the
  root checks pass.

---

## C — The installer and the association

*Plan §4.3, §1 #7, #8, #12. Read FileAnalyser's `desktop/build/installer.nsh`
whole, and `electron-tasks-2026-09-06.md` group H's three NSIS failures.*

**C1. Rewrite `desktop/installer.nsh` as a port of FileAnalyser's.**
- Page 1 in `customWelcomePage`: "How do you want mbrd?", two cards, Install
  (recommended) and Portable, the Portable card with its own folder box
  (default: a `mbrd` folder beside the installer).
- The Install card carries a checkbox, **ticked at first**: "Open .mbrd files
  with mbrd". The Portable card has none.
- `customInstallMode`, `customInit` (`SectionSetFlags 0 0`), `customHeader`
  (section 0, the portable unpack, writing the `portable` marker with the text
  `scripts/portable.mjs` writes), `customInstall` (the section-number guard),
  `customPageAfterChangeDir` (the progress page, restyled), `customFinishPage`
  ("mbrd is ready", a box that starts mbrd).
- The colours are mbrd's paper look, light only: take `--paper`, `--ink` and the
  muted ink from `web/assets/css/tokens.css` at the middle whimsy tier.
- The portable section refuses to overwrite a running copy, clears the old
  `resources\` and `locales\`, and leaves `data\` alone.
- An update run (`/S --updated`) never sees page 1.
- Every installer-only function and variable inside `!ifndef
  BUILD_UNINSTALLER`.

**C2. The association.**
- File: `desktop/electron-builder.yml`. Find: `fileAssociations:`. Do: move the
  block under `mac:`. Set `allowToChangeInstallationDirectory: false` under
  `nsis:`.
- File: `desktop/installer.nsh`. In `customInstall`, for an Install with the box
  ticked: register `.mbrd` under `HKCU\Software\Classes` (a ProgID
  `mbrd.board`, `DefaultIcon` = the exe, `shell\open\command` = `"$INSTDIR\mbrd.exe"
  "%1"`), write `HKCU\Software\mbrd` `AssociateMbrd` = 1 (0 when unticked), and
  call `SHChangeNotify`. On a silent run, read `AssociateMbrd` and repeat the
  earlier answer.
- In `customUnInstall`: delete the ProgID and the `.mbrd` default only while
  they still point at `$INSTDIR`.
- **Verify** that electron-builder honours `fileAssociations` under `mac:` only.
  Build once (`npx electron-builder --win --dir`) and check the generated NSIS
  script or the registry after an install. If it still registers on Windows,
  put the block back at top level and delete the keys in `customInstall` when
  the box is unticked. Write which way it went in the checklist.

**C3. Done when**, by hand on Windows: an Install with the box ticked opens a
`.mbrd` on double-click; unticked, it does not; a Portable writes nothing under
`HKCU\Software\Classes` or the uninstall key; a second Portable run into the
same folder keeps `data\`; `npm run portable` still works.

---

## D — The macOS hook

*Plan §4.6, §1 #13.*

**D1.** New file `desktop/scripts/after-pack.cjs`, a port of FileAnalyser's
`desktop/tools/after-pack.cjs`: skip non-darwin, skip `appOutDir` ending in
`-temp`, then `codesign --force --deep --sign - <bundle>`.
- File: `desktop/electron-builder.yml`. Add `afterPack:
  ./scripts/after-pack.cjs` at top level, with FileAnalyser's comment. Keep
  `identity: null` and rewrite its comment.
- Done when: the release workflow's macOS job (group I) packs. Nothing here runs
  on Windows.

---

## E — The title bar leaves the page

*Plan §4.1, §1 #6. The largest group. Read FileAnalyser's `desktop/main.mjs`
(`createWindow`, the panel block, the zoom block), `desktop/menu.mjs`, and all of
`desktop/chrome/`. Split this group into as many saves as it needs. Each save
must leave a working window.*

**E1. The chrome build.**
- New folder `desktop/chrome/`: `titlebar.html`, `titlebar.ts`, `titlebar.css`,
  `panel.html`, `panel.ts`, `preload.ts`, `look.ts`, and `tsconfig.json` (DOM
  lib, like `desktop/test/tsconfig.json`: renderer code must not share main's
  lib, the J1 lesson).
- New file `desktop/scripts/build.mjs`: runs the two existing esbuild entries
  (main, preload) as today, a third for `chrome/preload.ts` (CommonJS, node
  platform, into `dist/chrome/preload.js`), a browser IIFE build for
  `chrome/titlebar.ts`, `chrome/panel.ts` and `chrome/look.ts` into
  `dist/chrome/`, and **copies `chrome/*.html` and `chrome/*.css` into
  `dist/chrome/`**.
- File: `desktop/package.json`. Find: `"build": "esbuild main.ts preload.ts`.
  Do: `"build": "node scripts/build.mjs"`.
- Done when: `npm --prefix desktop run build` leaves `titlebar.html`,
  `titlebar.css`, `titlebar.js`, `panel.html`, `panel.js`, `look.js`,
  `preload.js` in `desktop/dist/chrome/`.

**E2. Serve `__chrome/`.**
- File: `desktop/protocol.ts`. Find: `protocol.handle('app', async request => {`.
- Do: before the web lookup, a `/__chrome/` prefix served from
  `join(__dirname, 'chrome')` (that is `dist/chrome/`) through an allow-list
  `CHROME_FILES`. Anything else under the prefix answers 404. The CSP header is
  applied as for every other response. Export `CHROME_FILES`: group I's test
  reads it.

**E3. The bar page.**
- `titlebar.html`: no inline script, no inline style. Head: `<script
  src="/__chrome/look.js"></script>` (classic, blocking), then
  `/assets/css/tokens.css`, the font faces `index.html` loads, and
  `/__chrome/titlebar.css`. Body: `<script src="/__chrome/titlebar.js"></script>`.
- `look.ts`: apply `mbrd.appearance` (whimsy, palette, the per-token overrides,
  validated as `index.html`'s pre-paint script validates them) and
  `mbrd.quality` to `<html>`. Prefer importing the reader from
  `web/assets/js/ui/look.ts` if that module touches no DOM at import time. If it
  does, copy the pre-paint logic and extend `tests/appearance.test.js` to hold
  the third copy in step. Write which way it went in the checklist.
- `titlebar.ts`: port `titlebar.js` minus the back and forward arrows and the
  section label. The mark (hidden on macOS), the menu titles, the subject (board
  title and dirty dot), a spacer, and minimise / maximise / close (hidden on
  macOS). Windows draws the Segoe glyphs, other systems the small SVGs, as
  FileAnalyser does. A `storage` listener re-runs the look on `mbrd.appearance`
  changes. It reports its height and asks for state when ready.
- `titlebar.css`: the bar, from mbrd's tokens. Narrow windows shed parts in a
  fixed order, the window controls never.
- `panel.html` / `panel.ts`: port `panel.html` / `panel.js`.
- `preload.ts`: port `chrome/preload.cjs`: `mbrdChrome` for the bar,
  `mbrdPanel` for the panel, disjoint surfaces.

**E4. Two web contents.**
- File: `desktop/main.ts`. Find: `function createWindow(): BrowserWindow {`.
- Do, following FileAnalyser's `createWindow()`:
  - The `BrowserWindow`: `frame: false` except on macOS (`titleBarStyle:
    'hidden'`, `trafficLightPosition`), `autoHideMenuBar: true`, the chrome
    preload, `contextIsolation`, `sandbox`, no node integration. It loads
    `APP_ORIGIN + '/__chrome/titlebar.html'`.
  - A `WebContentsView` for the board with the existing preload and the same
    `webPreferences`, added with `win.contentView.addChildView(view)`, loading
    `APP_INDEX`.
  - `layout()` on resize, maximize, unmaximize, enter and leave full screen.
    Full screen tracked from the events, registered first.
  - Show the window on the **board's** `did-finish-load`, with the 4 s safety
    show. Warm the panel window up then.
  - `current()` and every `webContents` use that means the board must mean the
    view's contents: `holdCloseForFlush`, `console-message`, `will-navigate`,
    `setWindowOpenHandler`, `will-attach-webview`, the `Ctrl+R` handler,
    `deliver()`, the menu's `send`. Add an `appContents()` helper as FileAnalyser
    does.
- Find: `function reportFrame(win: BrowserWindow): void {` and `ipcMain.on('window:minimize'`.
  Do: replace both with the chrome IPC: `chrome:win` (minimise, maximise,
  close; checks the sender is the bar), `chrome:state` pushes (maximised, full
  screen, focused, or the panel focused), `chrome:height`, `chrome:ready`,
  `chrome:menu-model`, `chrome:menu-open`, `chrome:menu-close`, and the panel's
  `panel:size`, `panel:run`, `panel:close`. Every handler checks its sender.
- The panel window: `ensurePanelWindow()`, `closePanel()`, the 250 ms re-open
  guard, `blur` closes, sized from the panel's report, clamped to the display.
- The zoom block: `zoomFactor = 1.2 ^ level` set with the level, `tbCssHeight`
  apart from `tbHeight`, `Math.ceil`.

**E5. The menu tree.**
- File: `desktop/menu.ts`. Find: `const MENU: { label: string, rows: Row[] }[] = [`.
- Do: every clickable row gets an `id`. Keep `cmd:` on the rows that dispatch a
  command, so `tests/desktop-menu.test.js` still reads them. Replace each
  `role:` row that the drawn menu shows (zoom in, zoom out, actual size, full
  screen, reload, developer tools, close window) with an action main runs
  against the board's view, as FileAnalyser's `actions.view()` does. Keep cut,
  copy, paste as roles in the hidden `Menu` only.
- Find: `export function installMenu(send: (cmd: string) => void): void {`.
  Do: FileAnalyser's three consumers: `buildMenu()` (the hidden `Menu`, for
  accelerators), `menuModel()` (plain data for the bar), `runMenuItem(id)`
  (checks the id against the tree).
- Add to Help: "Where my data is stored" and "Check for updates" (group F wires
  them).

**E6. The subject.**
- File: `desktop/main.ts`. Find: `function showDocument(state: unknown): void {`.
- Do: after `win.setTitle(...)`, send the title and the dirty flag to the bar
  (`chrome:subject`). The bar shows them.

**E7. The web side lets go.**
- File: `web/assets/js/main.ts`. Find: `import { initWindowChrome } from
  './ui/window-chrome.ts';` and `initWindowChrome(cmds);`. Delete both.
- Delete `web/assets/js/ui/window-chrome.ts`.
- File: `web/index.html`. Find: `<div id="window-drag" hidden
  aria-hidden="true">` and `<div id="window-controls" hidden role="group"
  aria-label="Window">`. Delete both elements whole.
- File: `web/assets/css/chrome.css`. Find: `:root.is-framed {`. Delete every
  rule on `is-framed`, `is-fullscreen` and `#window-*`, and the comments that
  argue them (Grep the file for all three afterwards).
- File: `web/assets/icons.svg`. Find: `id="i-window-min"`, `id="i-window-max"`,
  `id="i-window-restore"`. Delete them unless the bar page uses the sprite.
  `tests/icons.test.js` checks both directions.
- File: `web/assets/js/commands/view.ts`. Find: `    windowMinimize: () =>
  platform.frame.minimize(),`. Delete the three window commands.
- File: `web/assets/js/platform/platform.ts`. Find: `export interface FramePort
  {` and `const webFrame: FramePort = {`. Delete the port, `FrameState`, and
  `frame` from `Platform`, `web` and `platform`.
- File: `web/assets/js/platform/electron.ts`. Find: `  win: {` and `function
  electronFrame(bridge: Bridge): FramePort {`. Delete both, and `frame:` in
  `electronPlatform()`.
- File: `desktop/preload.ts`. Find: `  win: {`. Delete it. Find: `  bridge: 2,`.
  Do: `bridge: 3`, and say why in the comment above it (a field was removed).
- Update `tests/element-ids.test.js` and `tests/platform.test.js` for the
  removals.
- Done when: the root checks pass and no file names `window-chrome`,
  `is-framed` or `platform.frame`.

**E8. The smoke test sees two contents.**
- File: `desktop/test/smoke.spec.ts`. Find: `const page = await
  app.firstWindow();`.
- Do: wait for the page whose URL starts with `app://mbrd/index.html` among
  `app.windows()`, and assert a page at `app://mbrd/__chrome/titlebar.html`
  exists too. If Playwright does not list a `WebContentsView` as a page, write
  that in the checklist with what does work, and do not weaken the test into
  checking only the bar.

**E9. Done when**, by hand on Windows: the bar draws in the board's look and
follows a whimsy change; each menu opens under its title, switches on hover,
closes on a click outside and on Escape; every entry works; minimise, maximise
(and double-click), close (with the flush) work; Win+Up and Snap update the
maximise glyph; View > Zoom keeps the bar's bottom edge; full screen hides the
bar and leaving it brings it back; every accelerator in the menu still fires;
the board has no gap and no overlap at the top. `desktop.bat portable` shows the
bar too: that is the 9.8 check.

---

## F — The desktop extras

*Plan §4.8, §1 #15.*

**F1. Window size and place.**
- File: `desktop/main.ts`. Port `readState()` / `writeState()` and the 400 ms
  queue from FileAnalyser's `main.mjs` (`userData/window-state.json`). Apply in
  `createWindow()`, maximise when stored.

**F2. Where my data is stored.**
- File: `desktop/main.ts`. Port `actions.showData()`: "Installed copy" or
  "Portable copy", the folder, "Open the folder". The text names boards:
  "Your boards are the .mbrd files you save. This folder keeps the recovery
  store, the shelf and the logs."

**F3. Check for updates.**
- The Help row runs `updates.checkForUpdates()`.

**F4.** Group E6 already puts the board title in the bar.

---

## G — Hardware video encode

*Plan §4.7, §1 #16. Read FileAnalyser's `desktop/ffmpeg-accel.mjs` (the rewrite
half only) and `desktop/ffmpeg-native.mjs` (`capabilities`, the probe).*

**G1.** New file `desktop/ffmpeg-accel.ts`, pure: `FAMILIES` (NVENC, Quick Sync,
AMF, VideoToolbox; no MediaCodec), `crfToBitrate()`, `accelerate(args, caps)`.
No `checkArgs()`: the page never picks ffmpeg arguments in mbrd. Say so in the
header. Add it to `desktop/tsconfig.json`'s `include` if the glob misses it.

**G2. The probe.**
- File: `desktop/native/ffmpeg.ts`. Find: `function binary(): string | null {`.
- Do: after the binary is found, a `capabilities()` that encodes one throwaway
  frame per family (FileAnalyser's probe arguments) and keeps what exits 0,
  cached in `userData/ffmpeg-caps.json` keyed by path, size and mtime.

**G3. The rewrite and the retry.**
- Find: `export async function transcode(bytes: ArrayBuffer, opts:
  TranscodeOpts): Promise<Buffer | null> {`.
- Do: build the software arguments as now, run `accelerate()` on them, run the
  accelerated list first, and **on failure run the original software list**.
  Log which one produced the clip.
- Done when: by hand, a 10 s 1080p clip transcodes on this machine with the
  hardware family the probe found, and a 32x32 clip (below NVENC's minimum)
  still transcodes through the retry. Write the three timings (WASM, software,
  hardware) into the header of `desktop/native/ffmpeg.ts`, and which families
  each fetched build carries.

---

## H — desktop.bat

*Plan §4.9, §1 #17. Read FileAnalyser's `desktop.bat` whole.*

**H1.** Rewrite `desktop.bat` in FileAnalyser's shape: clear
`ELECTRON_RUN_AS_NODE`; `npm install` at the root and in `desktop\` when their
`node_modules` are missing; `npm run build` and `npm --prefix desktop run
build`; `start /b` the `npm run dev` watch unless one is running (FileAnalyser's
`Get-CimInstance` count, matching `esbuild` and `--watch`); `call` Electron in the
foreground with `%*` passed on; stop the watch it started on exit; `pause` only
on a non-zero exit. Keep the `portable` mode as it is. Keep the comment
density of both files: every step says why.
- File: `CLAUDE.md`. Find: `` `desktop.bat` is the launcher to use `` and the
  `**`Ctrl+R` reloads, but nothing rebuilds.**` paragraph. Rewrite both to the
  new loop.
- Done when: a fresh clone's first `desktop.bat` installs and opens the app, a
  `.ts` edit shows after Ctrl+R, and closing the window stops the watch.

---

## I — The release, the download page and the panel row

*Plan §4.4, §4.10, §1 #4, #5, #10, #11. Read FileAnalyser's
`.github/workflows/release.yml` whole.*

**I1. The file names.**
- File: `desktop/electron-builder.yml`. Find: `  artifactName:
  mbrd-Setup.${ext}`, `  artifactName: mbrd-universal.${ext}`, `
  artifactName: mbrd-x86_64.${ext}`.
- Do: `mbrd-Windows-${version}.${ext}`, `mbrd-mac-universal-${version}.${ext}`,
  `mbrd-linux-x64-${version}.${ext}`. Replace the long comments that argue the
  fixed names with FileAnalyser's: the version is in the name, and the updaters
  find a file by the part before it.

**I2. The workflow.**
- New file `.github/workflows/release.yml`, a port of FileAnalyser's:
  `workflow_dispatch` with the `publish` box, `concurrency: release`,
  `permissions: contents: write`.
  - `version`: checkout, Node 22, read `VERSION` and `COMMIT_COUNT` from
    `version.js` (`node -e "import('./web/assets/js/version.js')..."`), compute
    the semver (`0.301` → `0.301.0`; `1.05` → `1.5.0`), output `version` and
    `label`, run `npm test`.
  - `desktop` (matrix, `fail-fast: false`): mbrd's current `desktop.yml` steps
    (root `npm ci` and build, desktop `npm ci`, `fetch-ffmpeg`, typecheck,
    smoke), then `npx electron-builder --<os> --publish never
    -c.extraMetadata.version=<version>` with `CSC_IDENTITY_AUTO_DISCOVERY:
    false`, then **the chrome check**: `npx asar list` on the packed
    `app.asar` must contain `dist/chrome/titlebar.html`, or the job fails with a
    message naming the 9.8 fault. Upload `desktop/out/mbrd-*.exe|dmg|AppImage`.
  - `android`: added by group O. Until then `publish` needs only `desktop`.
  - `publish` (`if: inputs.publish`), into the public release repo (plan
    #31, §4.4): fail at once, naming the secret, when `RELEASES_TOKEN` is
    empty. Check out `$GITHUB_SHA` and write
    `files/mbrd-source-<version>.zip` with `git archive --format=zip
    --prefix=mbrd-<version>/ "$GITHUB_SHA"` (plan #32). `.gitattributes`
    already marks what it leaves out. Download the
    artifacts. Write `notes.md` as FileAnalyser's publish step does (plan #34):
    its table with a direct link per file, on
    `https://github.com/KostaJovanovic/mbrd-release/releases/download/v<version>`,
    and its first-run lines, in mbrd's names. Add a line that macOS and Linux
    are new and less tested (plan #35), a line for the source zip, and the
    source commit. Then, with `GH_TOKEN: ${{ secrets.RELEASES_TOKEN }}`: `gh
    release create v<version> files/* -R KostaJovanovic/mbrd-release --title
    "mbrd <label>" --target main --latest`, or `upload --clobber` and `edit
    --latest`, both with the same `-R`. **Not `--target "$GITHUB_SHA"`**: that
    commit is not in the release repo. Last, tag the source commit
    `v<version>` in this repo with the job's own `GITHUB_TOKEN` (`gh api
    repos/${{ github.repository }}/git/refs -f ref=refs/tags/v<version> -f
    sha=$GITHUB_SHA`). Skip the tag when it exists.
- Delete `.github/workflows/desktop.yml`.

**I3. `save.bat release`.**
- File: `save.bat`. Find: `echo   1  save     add + commit + push`.
- Do: FileAnalyser's menu shape: `1 release`, then save, commit, push, pull,
  quit, and the `release` argument. Find: `echo [git]  pushed
  %REMOTE%/%BRANCH%`. Do: after it, `if "%RELEASE_MODE%"=="1" call
  :runrelease`, and the same after a force push. Port `:runrelease`, with `gh
  workflow run release.yml -R KostaJovanovic/mbrd --ref %BRANCH% -f
  publish=true`, and its two warnings. The portable rebuild at `:end` stays.

**I4. `scripts/portable.mjs` carries the version.**
- Find: `` await run(`npx electron-builder --win --dir
  "-c.directories.output=${SCRATCH}"`, DESKTOP); ``
- Do: read `VERSION` from `web/assets/js/version.js`, compute the semver as I2
  does, and pass `-c.extraMetadata.version=<semver>`. Put the semver function in
  one small shared module both use (`desktop/scripts/version.mjs`).

**I5. The package test.**
- New file `tests/desktop-package.test.js`: every name in `CHROME_FILES`
  (`desktop/protocol.ts`, read as text) has a source in `desktop/chrome/`
  (`.ts` for `.js`), and `desktop/scripts/build.mjs` copies or builds that
  extension; the three `artifactName` prefixes match the patterns exported by
  `desktop/updates.ts` (read as text), and `mbrd-android` matches
  `MbrdUpdate.java`'s pattern once group O exists (skip with a reason until
  then); `publish: null`.

**I6. The download page.**
- File: `web/download.html`. Find: `<ul class="dl-picks">`.
- Do: one button, "Download mbrd", to
  `https://github.com/KostaJovanovic/mbrd-release/releases/latest`, and the
  "All releases" link to `https://github.com/KostaJovanovic/mbrd-release/releases`.
  Under the button, one line per system naming the file to pick (Windows `.exe`, macOS `.dmg`, Linux
  `.AppImage`, Android `.apk`, Android 7 and later). The macOS section leads
  with Open Anyway, then the `xattr` line. The macOS and Linux lines say "new,
  less tested" (plan #35). Add an Android section: allow the
  browser or the file manager to install apps. Update the header comment and
  the lede ("for your computer" becomes "for your computer or phone"). Keep
  the no-script, no-inline-style rules. `download.css` may need a rule for the
  one-button layout.
- File: `tests/download.test.js`. Rewrite: the page has exactly one
  `releases/latest` link, on `KostaJovanovic/mbrd-release`; no link names the
  private `KostaJovanovic/mbrd/`; it has no
  `releases/latest/download/` link; the four file endings are named; the three
  prose checks stay, with the macOS one reading "Open Anyway" too; the SHELL
  and sitemap check stays.

**I7. The panel row.**
- File: `web/assets/js/commands/view.ts`. Add `getApp` (navigate to
  `/download`, the way `patchNotes` navigates to `/patch`) and `checkUpdates`
  (`platform.updates.check()`).
- File: `web/assets/js/ui/settings-schema.ts`. Find: `{ cmd: 'patch-notes',
  label: 'Patch notes', closesPanel: true,`. Do: in the same section, two rows
  written like the Save pair: `{ type: 'buttons', when: () => !isDesktop(),
  buttons: [{ cmd: 'get-app', label: 'Get the app', … }] }` and `{ type:
  'buttons', when: isDesktop, buttons: [{ cmd: 'check-updates', label: 'Check
  for updates', … }] }`, each with a `title` hint.
- Done when: `tests/settings-panel.test.js` and the command tests pass, and the
  row reads right in a browser and in the desktop app.

**I8. The first release is the test.** A run with **publish unticked** needs
no secret. Run that first, and check the three artifacts, the chrome step, and
the smoke test on each system. Before the first run with publish ticked, the
maintainer does three things once (plan §4.4):
1. Give `KostaJovanovic/mbrd-release` its first commit, a README. A tag there
   needs a commit to point at, and `softwareHelp` names the README.
2. Make a fine-grained token: `mbrd-release` only, Contents read and write.
3. `gh secret set RELEASES_TOKEN -R KostaJovanovic/mbrd`, and paste the token.

---

## J — The Android skeleton

*Plan §5.1, §5.8, §5.12. Read FileAnalyser's `mobile/` whole, except the Java
(groups K–O read that). Needs the Android SDK (platform 36) and a JDK 21.*

**J1. The package.** New `mobile/package.json` (private, `0.0.0`, scripts
`stamp`, `stage`, `sync` = stamp + stage + `cap sync android`, `open`, `icons`;
dependencies `@capacitor/android`, `@capacitor/core`; devDependencies
`@capacitor/cli`, `@capacitor/assets`, `esbuild`, `sharp`). New
`mobile/capacitor.config.json` as in plan §5.1. Take `minWebViewVersion` from
the Chrome floor in `research/docs/browser-support.md`.

**J2. The project.** `npx cap add android` in `mobile/`. Rename the Java package
to `com.valjdakosta.mbrd`. Keep `mobile/android/.gitignore` from the template.

**J3. `.gitignore`.** Find: `desktop/portable/`. Do: after that block, the
mobile block: `mobile/node_modules/`, `mobile/www/`, `mobile/ffmpeg/out/`,
`mobile/ffmpeg/work/`, and the three generated assets under
`mobile/android/app/src/main/assets/` (`mbrd-bridge.js`, `mbrd-files.txt`,
`mbrd-csp.json`), each with FileAnalyser's kind of comment.

**J4. Staging.** New `mobile/tools/stage-web.mjs`: copy `web/` to `mobile/www/`
with the desktop's exclusions (read them from `extraResources` in
`desktop/electron-builder.yml`'s comments: `lab*.html`, `assets/lab-*.js`,
`assets/app.js.map`, `sw.js`), write `mbrd-files.txt`. The bridge and the CSP
JSON arrive in group K. Refuse to run when `web/assets/app.js` is older than
any `.ts` under `web/assets/js` (the bundle would be stale).

**J5. The version.** New `mobile/tools/stamp-version.mjs`: `versionName` =
`VERSION`, `versionCode` = `COMMIT_COUNT`, written into
`android/app/build.gradle` by regex, as FileAnalyser's does.

**J6. Icons.** New `mobile/tools/make-icons.mjs`: render
`web/assets/img/icon-maskable.svg` with `sharp` onto `#faf8f3` into
`mobile/assets/logo.png`, then `@capacitor/assets generate --android`. Commit the
output.

**J7. `mobile.bat`.** A port of FileAnalyser's: first-run install, `npm run
build` (the root bundle), `npm run sync`, the JDK 21 finder, `gradlew
assembleDebug`, `adb install -r`, `am start -n com.valjdakosta.mbrd/.MainActivity`,
and the `apk` and `open` modes.

**J8. Done when**: `mobile.bat` puts an app on a phone that shows the board as
the website does. There is no bridge yet, so this is a plain WebView app on
IndexedDB, and it registers the service worker. That is expected for one group:
group K wires the bridge, and the worker then stops registering. `/patch` also
shows the board until group K routes it.

---

## K — The bridge, bytes, router and CSP

*Plan §5.2, §5.3, §5.7. Read FileAnalyser's `anr-bridge.js`, `AnrShell.java`
(`load()`, `bridgeScript()`), `AnrBytes.java`, `AnrWebViewClient.java`,
`AnrRouter.java`.*

**K1. `format.mts` without Buffer.**
- File: `desktop/format.mts`. Find: `export function encode(value: unknown):
  Buffer {` and `export function decode(raw: Buffer): unknown {`.
- Do: `Uint8Array` in and out, `TextEncoder` / `TextDecoder` for the JSON part.
  `desktop/store.ts` keeps working because `Buffer` is a `Uint8Array` (wrap
  with `Buffer.from(…buffer, offset, length)` where a `Buffer` API is needed).
- File: `tests/desktop-store-format.test.js`: add a round trip on a plain
  `Uint8Array`.

**K2. `csp.mts`.**
- File: `desktop/protocol.ts`. Find: `function readPolicy(root: string): {
  value: string, exempt: string[] } {`.
- Do: move the parse into a new pure `desktop/csp.mts` (`parsePolicy(text)`, no
  Electron, no fs). `protocol.ts` reads the file and calls it.
- File: `tests/csp.test.js`: parse `web/_headers` with `csp.mts` and assert the
  policy and the four exempt paths.

**K3. The bridge.** New `mobile/bridge/mbrd-bridge.ts`, bundled by
`stage-web.mjs` (esbuild, IIFE, `platform: 'browser'`) into
`android/app/src/main/assets/mbrd-bridge.js`, guarded by `if
(window.mbrdDesktop) return;` at the top. It defines `window.mbrdDesktop` with
every key of `Bridge` in `web/assets/js/platform/electron.ts` at `bridge: 3`,
plus `shell: 'capacitor'`, `platform: 'android'`. The byte channel
(`transfer()`, the ack queue, `CHUNK` = 4 MB, base64 fallback) and the GET
reader (`/__mbrd/...`) are FileAnalyser's. The store, files and native halves
call plugins that groups L and N add: stub them to reject until then.
`setDocument` and `onCommand` do nothing. `relaunch` reloads.

**K4. The web type.**
- File: `web/assets/js/platform/electron.ts`. Find: `export interface Bridge {`.
  Do: `shell?: string;` with one line: set by the Android shell, absent on the
  desktop.
- File: `web/assets/js/platform/platform.ts`. Find: `// Platform abstraction:`.
  Do: say in the header that "desktop" means "a native shell is wired", which
  is the Android shell too.
- New file `tests/mobile-bridge.test.js`: every key of `Bridge` (read from
  `electron.ts` as text) is defined in `mobile/bridge/mbrd-bridge.ts` (read as
  text). Skip with a reason while `mobile/` is absent.

**K5. The shell plugin and the client.** New Java, each with a header naming its
desktop twin:
- `MbrdShell.java` (`@CapacitorPlugin(name = "MbrdShell")`): `load()` installs
  `MbrdWebViewClient` for the page and the service worker, registers
  `MbrdBytes` as `mbrdBytes`, and injects the bridge at document start for the
  app origin and the dev server, with the boot object (`version`, `packaged`,
  `arrayBuffers`).
- `MbrdRouter.java`: a port of `readPage()` in `desktop/protocol.ts` over
  `mbrd-files.txt`, with the content-type table of `mimeOf()`.
- `MbrdWebViewClient.java`: `/__mbrd/*` to the plugins, `/_capacitor_*` 404,
  everything else routed, and the CSP header from `mbrd-csp.json` on every
  response outside the exempt paths.
- `MbrdBytes.java`: FileAnalyser's protocol, with targets `store`, `file`,
  `ff`, `stage`.
- `MainActivity.java`: `registerPlugin(MbrdShell.class)` before
  `super.onCreate`.

**K6. `stage-web.mjs` finishes.** Build the bridge (K3) and write
`mbrd-csp.json` from `csp.mts` (K2).

**K7. Done when**, on a phone: `window.mbrdDesktop.shell === 'capacitor'` in
the WebView's console (`chrome://inspect`); no service worker is registered;
`/patch` and `/download` show their own pages; a CSP violation (try an inline
`<img onerror>` in the console) is refused.

---

## L — The store, the files, the permission

*Plan §5.4, §5.5, §1 #19–#21.*

**L1. The permission.**
- `AndroidManifest.xml`: `MANAGE_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`
  with `maxSdkVersion="29"`, `requestLegacyExternalStorage="true"`.
- `MainActivity.java`: before the bridge loads, check the grant. Without it,
  show the native explanation screen with Allow (opens
  `ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION` for this package) and Not
  now. Resolve the store root: `Documents/mbrd/.store/` with the grant, the
  app's private files folder without it.

**L2. `MbrdStore.java`.** The four stores, the key rules and the atomic
`clear()` of `desktop/store.ts`, over bytes written by `MbrdBytes` (target
`store`) and read by `GET /__mbrd/store/<store>/<key>`. `keys`, `del`,
`delMany`, `clear` as plugin methods. A `.nomedia` in `.store/`. A sweep of
`*.trash-*` at start. When the grant arrives and the public store is empty, move
the private store there once.

**L3. `MbrdFiles.java`.** The table in plan §5.5: `pickSave` (a native name
dialog, replace prompt), `write` (temp and rename), `read` and `exists` (served
by token), `pickOpen` (the system picker, copy into `Documents/mbrd/`),
`pickImport` (several files, not copied). The `vouch()` rule: only paths under
`Documents/mbrd/` or handed out by this plugin.

**L4. The bridge halves.** `store.*` runs `encode()` / `decode()` from
`desktop/format.mts` in the page and moves bytes over the channel. `files.*`
fetches the token URLs to build `HandedFile.data`. `startupNotes()` returns the
private-folder note when the grant is missing.

**L5. Share and downloads.** A `navigator.share` in the bridge that sends files
too (bytes staged through the channel, `ACTION_SEND` with a `FileProvider` URI),
and the download interceptor (a capture click listener and the
`HTMLAnchorElement.prototype.click` wrapper), both from FileAnalyser's bridge.

**L6. Done when**, on a phone: Save writes `Documents/mbrd/<title>.mbrd`, and
the Files app shows it; a relaunch restores the board from
`Documents/mbrd/.store/`; after an uninstall and a reinstall with the grant, the
shelf and the boards are back; "Not now" leaves a working app and a toast that
names the folder; Send file opens the share sheet with the `.mbrd`.
**Measure**: save and boot a board of 300 photographs, against IndexedDB in the
same WebView, and write both numbers into `MbrdStore.java`'s header.

---

## M — Incoming files, back, pause, the bars

*Plan §5.6, §5.10, §1 #22–#24.*

**M1. Intents.** `AndroidManifest.xml`: the intent filters of plan §5.6.
`MbrdShell.deliver(intent)`: a `.mbrd` (by type, name or the ZIP magic) is
copied into `Documents/mbrd/` and delivered with its path; anything else with no
path. `MainActivity.onNewIntent` calls it, as FileAnalyser's does.

**M2. Media lands as cards.**
- File: `web/assets/js/main.ts`. Find: `platform.lifecycle.onOpenFiles(files =>
  {`.
- Do: `.mbrd` files go to `openFile()` as now. Every other file goes to the
  import path of `import/drop.ts` (find the exported function a drop calls),
  after `started`.

**M3. Back.**
- First, list the Escape handlers: Grep `'Escape'` in `web/assets/js` (twelve
  files on 2026-09-13: `canvas/items.ts`, `canvas/input.ts`, `canvas/notes.ts`,
  `ui/menu.ts`, `ui/library.ts`, `ui/board-title.ts`, `ui/timeline-view.ts`,
  `ui/sticker-window.ts`, `ui/nowplaying.ts`, `ui/drawer.ts`,
  `ui/fence-prompt.ts`, `ui/search.ts`). Decide how "close the top layer" knows
  it closed something: each handler calls `preventDefault()`, or one function
  checks the open layers in order. Write the choice in the checklist.
- File: `web/assets/js/platform/platform.ts`. Find: `export interface
  LifecyclePort {`. Do: `onBack(fn: () => boolean): void`. Web default: nothing.
- File: `web/assets/js/platform/electron.ts`: `onBack?(fn)` on `Bridge`, wired
  when present.
- File: `web/assets/js/main.ts`: register the function.
- Bridge: `window.__mbrdBack()` returns `handled` or `exit`. `MainActivity`: the
  back callback from FileAnalyser's, with `moveTaskToBack(true)` on `exit`.

**M4. Pause.** `MbrdShell.handleOnPause()` notifies the bridge, which runs the
`onClose` function.

**M5. Insets and bars.** FileAnalyser's `setUpInsets()`, `setBarColor()`,
`applyFullscreen()`. The bridge reports the page background on changes to
`data-whimsy`, `data-palette` and the body's style.

**M6. Done when**, on a phone: a `.mbrd` shared from Files opens and sits in
`Documents/mbrd/`; a photo shared from the gallery lands as a card; Back closes
an open menu, then the viewer, then leaves; switching away and killing the app
loses no edit; nothing sits under the status or gesture bar in either look.

---

## N — Native FFmpeg on Android

*Plan §5.9, §1 #25. Read FileAnalyser's `mobile/ffmpeg/build-android.sh`,
`.github/workflows/android-ffmpeg.yml`, `AnrFfmpeg.java`.*

**N0. Test first.** On two phones from different makers, run the binary from
FileAnalyser's workflow artifact with `-version`, then a one-frame
`h264_mediacodec` encode through a child process. Write the result in the
checklist. If it fails on both, stop this group and say so.

**N1.** Copy `build-android.sh` and the workflow. The output name is
`libmbrdffmpeg.so`. `stage-web.mjs` copies `mobile/ffmpeg/out/<abi>/ffmpeg` into
`jniLibs/<abi>/`. `build.gradle`: `packaging { jniLibs { useLegacyPackaging =
true } }`.

**N2. `MbrdFfmpeg.java`.** Two plugin methods, `firstFrame(xfer)` and
`transcode(xfer, maxEdge, bitrate)`, clamped as `desktop/native/ffmpeg.ts`
clamps them. Java builds the arguments. The chain `h264_mediacodec`, then
`libopenh264`. The probe cached by binary and `Build.FINGERPRINT`. A child
process, a ceiling, output served at `/__mbrd/ff/<session>/<name>`. `can()`
answers `transcode: true` only with a binary.

**N3. The notice.** The LGPL notice and the source offer in the About sheet
(`credits`), beside the desktop's GPL notice, which is still missing too.

**N4. Done when**: on a phone, video Optimise shrinks a clip with MediaCodec and
falls back to openh264 on a refused size; with no binary, the Optimise row does
not offer video, as on the website.

---

## O — Android updates and the release job

*Plan §5.11, §4.4 step 3, §1 #2, #27, #28. Read FileAnalyser's
`AnrUpdate.java`, `AnrUpdateTest.java`, `build.gradle`, the `android` job of
`release.yml`.*

**O1. `MbrdUpdate.java`** and **`MbrdUpdateTest.java`**, ports of the two, with
the pattern `^mbrd-android(-\d+(\.\d+)*)?\.apk$` and `mbrd` in every string.
`AndroidManifest.xml`: `REQUEST_INSTALL_PACKAGES`, the `InstallStatus`
receiver (not exported). `MainActivity.onCreate`: `MbrdUpdate.maybeCheck(this)`.
`MbrdShell`: a `checkUpdates` method the bridge's `updates.check()` calls.

**O2. `build.gradle`.** `buildConfigField "String", "UPDATE_FEED",
"\"${project.findProperty('mbrdUpdateFeed') ?: ''}\""`, `buildFeatures {
buildConfig = true }`, and the release signing from `MBRD_KEYSTORE`,
`MBRD_KEYSTORE_PASSWORD`, `MBRD_KEY_ALIAS`, `MBRD_KEY_PASSWORD`, with
FileAnalyser's comments.

**O3. The release job.** File: `.github/workflows/release.yml`. Add the
`android` job from FileAnalyser's, with mbrd's names: the FFmpeg cache on
`hashFiles('mobile/ffmpeg/build-android.sh')`, `npm ci` and `npm run sync` in
`mobile/`, the keystore step (fail with the secret names when absent), `gradlew
--no-daemon testReleaseUnitTest assembleRelease
-PmbrdUpdateFeed=https://api.github.com/repos/KostaJovanovic/mbrd-release/releases/latest`
(written out: `github.repository` is the private source repo), rename to
`mbrd-android-<version>.apk`. `publish` needs
`[version, desktop, android]`. The notes table gains the Android row.

**O4. The key (the maintainer does this).** Write the steps into
`mobile/README.md`: `keytool -genkeypair -v -keystore mbrd-release.jks -alias
mbrd -keyalg RSA -keysize 4096 -validity 36500`, then `base64` it into
`ANDROID_KEYSTORE_BASE64` and set `ANDROID_KEYSTORE_PASSWORD` and
`ANDROID_KEY_ALIAS` on `KostaJovanovic/mbrd`. Keep the `.jks` and the passwords
offline. **Never replace the key once a release is out.**

**O5. Done when**: a workflow run with publish unticked produces a signed APK
beside the three desktop files; with a published release newer than an
installed APK, the app offers the update, installs it through the session with
no confirm screen on Android 12+, and reopens on the new version.

---

## P — Docs and filing

*Plan §8 step 11. Last.*

- **P1.** `mobile/README.md`, the twin of FileAnalyser's: run it, build it, how
  it fits together (the file table), the bridge, routing and the CSP, moving
  bytes, the store and the permission, files, FFmpeg, security, releases and
  the key, what is not done.
- **P2.** `CLAUDE.md`: a "Mobile app (`mobile/`)" section in the checklist
  style of the file (what breaks silently: the staged copy, the bridge shape,
  `/_capacitor_*`, the key, `versionCode`), the new `desktop.bat` loop, the
  release option in the `save.bat` paragraph, `desktop/chrome/` and the 9.8
  fault. Remove every sentence about electron-updater, `desktop-v*` tags and
  the page-drawn bar.
- **P3.** `.github/CONTRIBUTING.md`. Find: `## Run it`. Add the desktop and
  Android launchers in two lines each.
- **P4.** `research/docs/architecture.md`: a short section on the three shells
  (browser, desktop, Android) and the one bridge shape. It names no Electron
  today.
- **P5.** `research/README.md`: this plan and this task list leave the Current
  list, and a paragraph says why they went down. Move this plan, this task
  list, `electron-2026-09-06.md` and `electron-tasks-2026-09-06.md` to `old/`
  with `git mv`.

---

## Checklist

Mark each task `DONE <commit>`, `SKIPPED — <reason>`, or leave it blank. Write
every decision a task left to you in the notes column.

| task | status | notes |
| --- | --- | --- |
| A1 | DONE (v0.302) | tested the five new lines out of `save.bat` in `cmd`: an intact `version.js` gives 301 to 302, a blanked line goes to `:countfail`. `git rev-list --count HEAD` said 303 on 2026-09-13, so the old code would have stamped 304 |
| A2 | DONE (v0.302) | the owner `valjdakosta` was made up by earlier sessions (3a9fb10, 7717c69, the 2026-09-09 checkpoints). `KostaJovanovic/Universal-File-Analyser` checked with `gh`. The two tests that read `web/404.html` fail until `save.bat` remakes it |
| B1 | DONE (v0.302) | `startUpdates(opts: UpdateOptions)`, a named interface, so `no-object-parameters` (which bans only `object`) passes. Added over FileAnalyser: a guard so a second macOS window does not arm the checks twice, an `error` handler on the installer spawn, and an unref'd interval. The `sha256:` digest field checked with `gh api` on a real FileAnalyser release. The uninstaller name checked in app-builder-lib: `Uninstall ${PRODUCT_FILENAME}.exe` |
| B2 | DONE (v0.302) | `portableCopy` is set when the marker exists, before the data-folder probe, so a read-only portable copy still counts as portable |
| B3 | DONE (v0.302) | `bridge` stays 2 here. E7 bumps it to 3 and covers both removals: no release falls between B and E |
| B4 | DONE (v0.302) | the lockfile no longer names electron-updater. `.github/workflows/desktop.yml` still runs `--publish always`, which now publishes nothing: I2 deletes that file. Its MBRD_SIGNED comment is gone |
| C1 | DONE (v0.302) | ported whole. The Install card holds the box, and its answer is kept in `HKCU\Software\mbrd\AssociateMbrd`, read in `customInit`, so a silent update repeats it. `win.target` now names `arch: [x64]`, because the portable section refuses to build without `APP_64`. `npx electron-builder --win` built `mbrd-Setup.exe` (177 MB) on 2026-09-13 with every hook expanded |
| C2 | DONE (v0.302) | under `mac:` only. Checked in `app-builder-lib/out/platformPackager.js`: `fileAssociations` is the top-level list plus the platform's own, so the Windows NSIS script gets none. Nothing checked in the registry yet: that is C3 |
| C3 | | needs a person on Windows, with `desktop/out/mbrd-Setup.exe`. `npm run portable` still works (checked) |
| D1 | DONE (v0.302) | `desktop/scripts/after-pack.cjs`. A Windows `--dir` pack calls it and it returns (exit 0). The macOS signature runs first in the release workflow's macOS job (I2). Dropped FileAnalyser's claim that a signed half stops the universal merge: not found in `@electron/universal`'s source. User hooks run last, checked in app-builder-lib's `asyncEventEmitter.js` |
| E1 | DONE (v0.302) | `scripts/build.mjs`, on the esbuild API. `npm --prefix desktop run build` leaves all seven files in `dist/chrome/` (checked 2026-09-13). Two more sources: `accel.ts` (the `accel.js` port, split before the names map, so `Plus` keeps its sign) and `bridge.ts` (the types the preload, the pages and `menu.ts` share). `chrome/tsconfig.json` also includes `web/assets/js/vendor-globals.d.ts`, because the look import pulls web modules in. `npm run portable` ships them: `asar list` shows the seven under `dist/chrome` |
| E2 | DONE (v0.302) | `CHROME_FILES` exported. Any other name under `/__chrome/` answers 404, and every answer carries the `/*` CSP from `_headers` |
| E3 | DONE (v0.302) | imported in part. `safeVars` (the token filter) comes from `web/assets/js/ui/look.ts`, which is not one of the six DOM entry points in `tests/imports.test.js`. That module exports no reader for whimsy, palette or quality, so those three checks are written out as the pre-paint script writes them, and a new test in `tests/appearance.test.js` holds the copy in step. The two pages have no inline script or style |
| E4 | DONE (v0.302) | as FileAnalyser, plus: `focusBoard()` after a menu run, Escape and maximise, so the board's own keys work again after a click on the bar. The hidden panel is destroyed when the window closes, or `window-all-closed` would never fire. The single-instance block moved to the end of `main.ts`, so every `let` above it is set before `main()` runs. `app:close-now` and `app:document` now check the sender is the board. A second click on an open title sends `chrome:menu-closed` back, so the title does not stay lit |
| E5 | DONE (v0.302) | every clickable row has an id. The accelerators the roles carried are written out, checked in Electron 38.8.6's `lib/browser/api/menu-item-roles.ts`, and so is the 0.5 zoom step. The new Help rows are "Where My Data Is Stored" and "Check for Updates", in the title case of the rows around them |
| E6 | DONE (v0.302) | `showDocument()` sends `{ title, dirty }`. Main keeps it and sends it again on `chrome:ready`, because the board can name itself before the bar listens |
| E7 | DONE (v0.302) | as written, and `platform` left the bridge with `win`: nothing in the board read it after the bar left. Also gone: the `debugFrame` command, its Debug row ("Show the window drag band") and its CSS, and `--frame-bar-h` in five sheets. `tests/window-chrome.test.js` went with its module. Grep: `window-chrome`, `is-framed` and `platform.frame` are left only in the plan and this file. `web/404.html` follows at `save.bat` |
| E8 | DONE (v0.302) | Playwright lists the `WebContentsView` as a page. The board is found at `app://mbrd/index.html` and the bar at `/__chrome/titlebar.html`. A new test checks that the bar draws four menus. `npm run smoke`: 5 passed on 2026-09-13 |
| E9 | | needs a person on Windows |
| F1 | DONE (v0.302) | ported with the 400 ms queue, plus two changes. `maximize()` runs at the reveal, because Electron's docs say it shows a hidden window, so FileAnalyser's early call shows the bar before the board. A saved place is used only if a screen still shows the bar's left end. `getNormalBounds()` always, which the docs say is the normal size in every state |
| F2 | DONE (v0.302) | wired in E: Help > Where My Data Is Stored. "Portable copy" only when the data folder really is beside the exe, as FileAnalyser's `PORTABLE_DATA`. A portable copy on read-only media says "Installed copy" and shows the folder it really uses |
| F3 | DONE (v0.302) | wired in E: Help > Check for Updates runs `updates.checkForUpdates()` |
| G1 | DONE (v0.302) | H.264 only: mbrd encodes nothing else, so the families carry no HEVC or AV1 names and the probe tries only the `h264_*` encoders. `crfToBitrate()` is there as the task says, and nothing on the desktop calls it: `transcode()` sets `-b:v`, not `-crf`. The `*.ts` glob covers the file. New `tests/ffmpeg-accel.test.js`, 8 tests |
| G2 | DONE (v0.302) | through the app on 2026-09-13 the probe found NVENC only. The gyan.dev build also lists Quick Sync and AMF, and both failed on this NVIDIA machine, which is why a listing is not evidence. The cache keeps vendor names only, so no encoder name read from disk reaches a command line |
| G3 | DONE (v0.302) | through the app: the 1080p clip took 1.2 s on NVENC. The 32x32 clip failed on NVENC ("Frame Dimension less than the minimum supported value") and came out of the software retry. Timings and families in the header: wasm 60.6 s, libx264 1.8 to 2.9 s, NVENC 0.9 to 1.4 s. Windows build: NVENC, Quick Sync, AMF. macOS build: VideoToolbox (a string search, the binary cannot run here). Linux build: none, and its URL is the moving "release" alias (7.0.2 that day), though the script's header says pinned. Two older bugs fixed on the way, each with its own cause. First, the input went in through a pipe, and an MP4 with its index at the end cannot be read from a pipe: the 1080p clip failed as "partial file" in software too, and so did its poster frame. The input is now a temp file. Second, `run()` started every job at once, because the queue held a promise that had already spawned. The queue now holds a function |
| H1 | DONE (v0.302) | the watch is found by name and command line: `node.exe` or `esbuild.exe`, with `esbuild`, `--watch` and `assets/app.js`. Without the names the query counted its own cmd and powershell, which carry the same words. Checked in a console of its own: 0 before, 2 while `npm run dev` runs, 0 after the stop. Run from Git Bash the watch ends at once, because esbuild stops when stdin closes. The portable mode now installs missing dependencies too, as the working copy does, since `:needs` argued the opposite of H1. The rest of it is unchanged. The fresh-clone check needs a person |
| I1 | DONE (v0.302) | the three names as the task says. The comments say what FileAnalyser's say: the version is in the name, and the updaters find a file by the part before it. `tests/desktop-package.test.js` holds the names against `updates.ts` |
| I2 | DONE (v0.302) | the `app.asar` paths come from app-builder-lib's `computeAppOutDir` (`platformPackager.js`): `win-unpacked`, `linux-unpacked`, `mac-universal/mbrd.app`. `asar list` prints backslashes on Windows, so the check matches `[\\/]`. Tested on `desktop/portable/resources/app.asar`: 1 match. The action versions are FileAnalyser's, whose last three runs passed. Notes table: the Windows install installs itself and a portable copy tells you (`installKind` gives `manual`), macOS tells you, the AppImage installs itself. The tag step skips an existing tag. No Android row until O. `desktop.yml` deleted. Not run: I8 |
| I3 | DONE (v0.302) | menu `1 release` to `6 quit`, the `release` argument, `:runrelease` with `--ref %BRANCH%` and its two warnings. Also FileAnalyser's third warning when nothing was pushed, on the no-remote path too. The menu checked in cmd (6 quits). `:runrelease` not run: it would start the workflow |
| I4 | DONE (v0.302) | `semver` checked: 0.301 to 0.301.0, 1.05 to 1.5.0, 1.10 to 1.10.0, `x` and `1.2.3` throw. `npm run portable` on 2026-09-13: `mbrd.exe` file version 0.301.0, and the packed `package.json` says 0.301.0. The `desktop/package.json` description now says how the version gets in |
| I5 | DONE (v0.302) | 6 tests, the Android one skipped until O. Two more than the task: `files:` still lists `dist/**`, and each updater pattern matches no other release file (the other systems, the source zip) |
| I6 | DONE (v0.302) | one button, four lines, the Android section, "for your computer or phone". macOS leads with Open Anyway, and the `xattr` line stays for the "damaged" case. `download.css`: `.dl-picks` and `.dl-note` gone, `.dl-pick` and `.dl-files` new. Seen in a browser at 1280 and 412 wide: no overflow, and the button fills a phone's width. The Android line names an `.apk` that no release carries until O |
| I7 | DONE (v0.302) | `camel()` in `ui/sidebar.ts` turns `get-app` into `getApp` and `check-updates` into `checkUpdates`. In a browser on 2026-09-13: "Get the app" sits in the patch-notes section with its title, and the `check-updates` row is hidden. The desktop app needs a person |
| I8 | | the maintainer's. A run with publish unticked first |
| J1 | DONE (v0.304) | `minWebViewVersion` 110. `browser-support.md` names no Chrome number, only "current and one prior major", so the floor comes from what the app needs: `deflate-raw` in Chrome 103 (MDN's compat data, WebView mirrors Chrome), `:has()` and `@container` 105, `dvh` and `svh` 108. 110 clears all of them and is FileAnalyser's. Above it: `round()` (125) in one custom property at whimsy 2, and `text-wrap`. Every option name checked in `@capacitor/cli` 8.5.2's `declarations.d.ts`. Capacitor 8.5.2 and `@capacitor/assets` 3.0.5 are npm's latest, esbuild and sharp are pinned as the root and `desktop/` pin them |
| J2 | DONE (v0.304) | `cap add android` names the Java package from `appId`, so `MainActivity` was already `com.valjdakosta.mbrd`. The two example tests moved out of the template's `com.getcapacitor.myapp`, and the instrumented one now expects `com.valjdakosta.mbrd`: the template's `com.getcapacitor.app` fails on every device. `mobile/android/.gitignore` kept. `minSdkVersion` 24 is Android 7.0, as the download page says |
| J3 | DONE (v0.304) | after the `desktop/portable/` block. `git check-ignore` agrees for `mobile/www/`, `assets/public/` and `mbrd-files.txt` |
| J4 | DONE (v0.304) | 270 files, 31.4 MB. A `.gz` stops the staging rather than being staged wrong (plan §5.8). The stale-bundle check compares file times. Not as J8 says: `sw.js` is not staged, so the worker does not register in this group. `register('sw.js')` fails, and `main.ts` catches it with a warning |
| J5 | DONE (v0.304) | imports `version.js`, as `desktop/scripts/version.mjs` does, and refuses a count or a label it cannot read. `mobile/package.json` stays `0.0.0` as J1 says (FileAnalyser's stamps it too). The committed `build.gradle` lags by one save: every sync stamps it again |
| J6 | DONE (v0.304) | looked at: the launcher icon is the whole mark, and the splash shows it at Capacitor's 20 % width on paper. The dark variants use the same paper, since the app has no dark launcher or splash. 59 files under `res/`, and `mobile/assets/logo.png` |
| J7 | DONE (v0.304) | two changes from FileAnalyser's: it installs the root package too, as `desktop.bat` does, and it installs on every phone `adb devices` lists, since a bare `adb install` refuses to pick one. `.\gradlew.bat`, because a shell with `NoDefaultCurrentDirectoryInExePath=1` does not search the current folder (this one has it). `mobile.bat apk` on 2026-09-13: `com.valjdakosta.mbrd`, versionCode 303, versionName 0.303. The install path is not run: no phone was connected. `gradlew` is committed 100644 as FileAnalyser's is, whose release workflow runs `chmod +x gradlew`: group O ports that |
| J8 | | needs a person, on both phones. The steps are under "Open" below |
| K1 | DONE (v0.305) | `encode()` returns a plain `Uint8Array` and `decode()` takes one. `store.ts` needed one type, on `writeAtomic`. `tests/desktop-bridge.test.js` read the output with `Buffer.toString('latin1')`, so it wraps it in `Buffer.from` now. New test: the constructor is `Uint8Array`, and a plain copy decodes |
| K2 | DONE (v0.305) | `desktop/csp.mts`, `parsePolicy(text)`. `protocol.ts` keeps the read and both logs. Two tests in `tests/csp.test.js`: the shells' parse equals the test's own (the value, and the four exempt paths from `spawnedWorkers()`), and the staged `mbrd-csp.json` equals a fresh parse. That one skips when nothing is staged, as in CI |
| K3 | DONE (v0.305) | three files: `mbrd-bridge.ts`, `boot.ts` (`MBRD_BOOT`) and `bytes.ts` (`transfer()`, `fetchBytes()`). The boot marker is in the wrapper `stage-web.mjs` writes, because esbuild drops comments. `native.can()` resolves `{ transcode: false, matte: false }` and does not reject, so the web path runs, as on the website. `onClose` and `onOpenFiles` do nothing until M. Nothing imports `bytes.ts` yet, so the bundle leaves it out until L. New `mobile/tsconfig.json` and `npm run typecheck` in `mobile/` (typescript 5.9.3, as the root): clean. So the store rejects every call and a phone saves nothing between K and L |
| K4 | DONE (v0.305) | as written. The test compares group by group, and also holds `bridge: 3` against `preload.ts` |
| K5 | DONE (v0.305) | `androidx.webkit` added to `app/build.gradle`: Capacitor has it as `implementation`, which does not reach the app. Checked in Capacitor 8.5.2's `Bridge.java`: `registerAllPlugins()` runs before `loadWebView()`, which keeps the client `load()` set, and Capacitor's own native bridge goes in by `addDocumentStartJavaScript`, so the page CSP does not block it. A path with no file is a plain 404, as on the desktop, not `404.html`. The router refuses `..`, `.`, `\` and empty segments before a lookup. `/__mbrd/*` answers 404 until L and N. New `MbrdRouterTest`, 6 tests on the host |
| K6 | DONE (v0.305) | esbuild's API, IIFE, `chrome110` (J1's floor). `mobile.bat apk` on 2026-09-13 put all three files in the APK's assets. `gradlew testDebugUnitTest`: 7 pass |
| K7 | | needs a person, on one phone. The steps are under "Open" below |
| L1 | DONE (v0.306) | the screen is built in code, in `MainActivity.load()`, which `BridgeActivity.onCreate()` calls. The bridge cannot wait for the answer: Capacitor registers its activity-result launchers while it builds the bridge, and Android refuses that once the activity has started. So that instance builds no bridge, and Allow (back from Android's page with the grant) or Not now calls `recreate()`. Not now holds for the process, so the next launch asks again. A phone with no per-app page gets the list of every app, then Not now. `MbrdRoot.java` picks the folder |
| L2 | DONE (v0.306) | `MbrdNames.java` ports `fileFor()` and `keyOf()` byte for byte, so a store folder copied from a phone reads on the desktop. New `MbrdNamesTest`, 6 tests on the host. The move of the private store runs on a thread behind a latch, and every read of the root waits for it. A failed move leaves the private store in place for that run. Boards saved as `.mbrd` files under the private folder stay there, and the shelf still opens them (`boardRoots()`) |
| L3 | DONE (v0.306) | the page names a path only if it is under a board folder with no hidden segment (so never `.store/`) or this process handed it out. `pickOpen` copies into this run's folder, with "name (2)" on a clash, except a board the picker found in `Documents/mbrd/` itself, which opens in place. A file with no `.mbrd` name is taken if it starts with the ZIP magic. `pickImport` copies nothing: each file is a `content://` token |
| L4 | DONE (v0.306) | `mobile/bridge/store.ts`, `files.ts` and `native.ts`. `setMany` writes one value at a time, since the channel carries one transfer at once. A value that does not decode reads as missing with a warning, as on the desktop. The "Not now" note names the private folder, as the desktop's names its fallback |
| L5 | DONE (v0.306) | `mobile/bridge/share.ts`. One file a share: FileAnalyser's shape. The shared copy sits in `cache/mbrd-share/<id>/`, which the next start deletes. A `data:` link is decoded in the page, because `connect-src` has `blob:` and no `data:`. Fixed on the way in `MbrdBytes`: a transfer that was short at `end` left the partial file in place, because `end` had closed the stream and the reset deleted nothing. FileAnalyser's `AnrBytes` has the same bug (below) |
| L6 | | needs a person, on both phones. The steps and the 300-photograph measurement are under "Open" below |
| M1 | DONE (v0.307) | `VIEW` names `content` and the MIME list. `SEND` and `SEND_MULTIPLE` name no scheme, because a `SEND` has no data URI to match. `deliver()` hands each file to `MbrdFiles.incoming()`, on a thread of its own. The ZIP magic counts only for a name with no extension, so a shared `.zip` or `.docx` is not taken for a board. A board is adopted as Open adopts it, so one already in `Documents/mbrd/` opens in place. An intent that arrives while the storage screen is up is kept for the bridge the answer builds. Fixed on the way, in L's code: a token now serves once and the table holds 1024, not 64. With 64, a pick or a share of more than 64 files pushed out its own first tokens before the page read them |
| M2 | DONE (v0.307) | the first `.mbrd` opens, and every other file goes to `importFiles()` at the view centre, the call the picker's change handler makes. So the desktop changes too: a file that is not a board, handed over by argv, now lands as a card and does not fail in `openFile()`. Shared text: a link becomes a `.url` internet shortcut, which `drop.ts` turns into a link card (`SHORTCUT_EXTS`), and other text becomes a `.txt` |
| M3 | DONE (v0.307) | the twelve files as listed. The choice: each Escape handler marks the event when it closes something (`markClosed()` in `util.ts`), and Back sends a synthetic Escape and reads the mark. Not `preventDefault()`: `timeline-view.ts` and `canvas/input.ts` stand down on a prevented Escape, so that signal would change the keyboard. Two layers come first, in the function in `main.ts`: an open menu (`isMenuOpen()`), then a modal dialog, which gets the `cancel` event the browser sends for Escape, because a synthetic key closes no `<dialog>`. The Escape case in `input.ts` marks only when a selection, a marked line, a sheet or the armed connector was there: `closeSidebar` and `clearActiveConnection` now answer that. New `tests/escape-mark.test.js` holds every Escape handler to the mark |
| M4 | DONE (v0.307) | `handleOnPause()` sends `pause`, not retained. The bridge runs the `onClose` function, which the Electron adapter already wraps in a catch |
| M5 | DONE (v0.307) | ported, with three changes. The bands start in the paper colour, not in white or black. The page colour goes through a 1-pixel canvas, because FileAnalyser's pattern reads `rgb()` only and a palette can set `--paper` with `color-mix()` (`tokens.css`). The colour is read again after 400 ms, for a look in transition |
| M6 | | needs a person, on both phones. The steps are under "Open" below |
| N0 | | needs a person, on both phones. No phone was connected on 2026-09-13, and FileAnalyser's "Build Android FFmpeg" workflow has never run (`gh run list --workflow android-ffmpeg.yml` is empty), so it has no artifact. The same script builds the binary inside FileAnalyser 9.10.0's release APK, through its release job: `lib/arm64-v8a/libanrffmpeg.so`, 22.6 MB, checked with `gh release download` and `tar -tf`. The steps use that file. They are under "Open" below |
| N1 | | held for N0, which says test first. A failure on both phones stops the group |
| N2 | | held for N0 |
| N3 | | held for N0. The desktop's GPL notice is still missing too |
| N4 | | held for N0 |
| O1 | DONE (v0.308) | ported whole, with `mbrd` in every string. The dialog says "Your boards and settings stay". The bounded read of the API answer lives in `MbrdUpdate`, because `MbrdShell.readAll` has no ceiling. `MainActivity` checks only when the bridge exists: with the storage screen up, the answer recreates the activity and would take the dialog with it, and the check would then wait six hours. `MbrdUpdateTest`, 4 tests, one more than FileAnalyser's: `version.mjs` turns the label 1.05 into 1.5.0, and the two compare equal. The Android test in `tests/desktop-package.test.js` now runs: it holds `APK_NAME` against the name the release job writes |
| O2 | DONE (v0.308) | as written, with FileAnalyser's comments. Checked on 2026-09-13 with a throwaway key: `assembleRelease` with `MBRD_KEYSTORE` set gives an APK that `apksigner verify` accepts, and `-PmbrdUpdateFeed` lands in `BuildConfig.UPDATE_FEED`. Without them the release is unsigned and the feed is empty |
| O3 | DONE (v0.308) | two changes from FileAnalyser's job. It builds the web bundle first, as the desktop job does, because `stage-web.mjs` refuses a bundle older than its sources and a fresh checkout writes `app.js` before every `.ts` under it (git writes in path order). A build rewrites `app.js` even with the same bytes: checked, the file time moved and git saw no change. The four FFmpeg steps skip until `mobile/ffmpeg/build-android.sh` exists (`hashFiles(...) != ''`), because N is held for N0. The notes gain the Android row, the Android line under the signing list, and "The macOS, Linux and Android builds are new". Not run: O5 |
| O4 | DONE (v0.308) | in a new `mobile/README.md`, which P1 fills in. The `keytool` options checked in JDK 21's `-genkeypair -help`, and `gh secret set` reads standard input when there is no `--body`. PowerShell has no `<`, so its steps pipe the file. The maintainer's to carry out |
| O5 | | the maintainer's, after O4. The steps are under "Open" below |
| P1 | DONE (v0.309) | the twin of FileAnalyser's, with mbrd's files, and O4's key steps inside it. FileAnalyser's `/api` and job-service sections have no mbrd twin, so they are gone. The live-reload paragraph says nobody has tried it on a phone: `MbrdWebViewClient` has the code for it, and that is all that was checked. The FFmpeg section says N is held |
| P2 | DONE (v0.309) | the "Mobile app" section before "Never hand-edit these", with the five the task names and the CSP. `save.bat release` in the command block, and a paragraph on the release after the portable one. The chrome and 9.8 paragraph after the Ctrl+R one. The `desktop.bat` sentence said the watch runs "in its own console", and `desktop.bat` runs it with `start /b` in the same console, so that changed. Nothing about electron-updater, `desktop-v*` tags or the page-drawn bar was left to remove: a Grep for updat, tag, frame and chrome found none |
| P3 | DONE (v0.309) | two short paragraphs after the `server.bat` line. The link is `../mobile/README.md`, because the file is in `.github/` |
| P4 | DONE (v0.309) | "Three shells, one bridge", before "Three things that reach outside", and `desktop/` and `mobile/` in the tree at the top |
| P5 | | held. Group N and the checks that need a person are open, and `research/README.md` files a document in `old/` only when its work is done. Run it after N4 |

### Open from the earlier sessions (was HANDOFF.md)

Checks that need a person, all on Windows except I8: C3 (the installer,
ticked, unticked and Portable), E9 (the title bar, the menus, the window
buttons, zoom, full screen, and `desktop.bat portable`), H1 (a fresh clone
installs and opens, a `.ts` edit shows after Ctrl+R, closing the window stops
the watch), G3 (a real phone clip, to see NVENC and the retry), I7 (the "Check
for updates" row in the desktop app), I8.

J8, on each of the two phones:

1. Turn on USB debugging: About phone, tap "Build number" seven times, then
   Developer options, USB debugging. The menu names differ by make.
2. Connect the phone by USB and accept "Allow USB debugging" on it.
3. Run `mobile.bat` in the repository root. Both phones can be connected at once.
4. Check that mbrd opens and shows the board as the website does.
5. Add a note, close the app from the recent apps, and open it again. The note
   must still be there. The v0.305 build fails this step, because its store
   rejects every call. Use v0.306 or later.

K7, on one phone, with a build from v0.305 or later:

1. Run `mobile.bat` with the phone connected, as in J8.
2. On the computer, open Chrome and go to `chrome://inspect`.
3. Under the phone, find `https://app/` and click "inspect".
4. In the console, type `window.mbrdDesktop.shell`. Expect `'capacitor'`.
5. Type `navigator.serviceWorker.getRegistrations()`. Expect an empty list.
6. Type `location.href = '/patch'`. Expect the changelog page, not the board.
7. Type `location.href = '/download'`. Expect the download page.
8. Type `location.href = '/'` to go back to the board.
9. Type `document.body.insertAdjacentHTML('beforeend', '<img src=x onerror="alert(1)">')`.
   Expect no alert, and a Content-Security-Policy error in the console.
10. On v0.305, expect store errors on the board. From v0.306, expect none.

L6, on each of the two phones, with a build from v0.306 or later. A first
install shows the "Keep your boards as files" screen before the board.

1. Press "Not now". Expect the board, and a toast that names the app's own folder.
2. Add a note, close mbrd from the recent apps, and open it again.
3. Expect the screen again. Press "Allow".
4. On Android's page, turn on the access for mbrd. Press Back.
5. Expect the board, with the note from step 2.
6. Use Save. Keep the name, and press "Save".
7. Open the Files app, then Documents, then mbrd. Expect the `.mbrd` file.
8. Close mbrd from the recent apps and open it again. Expect the same board.
9. Use Open, and pick the file from step 7. Expect the board, and no "(2)" copy.
10. Use Send file. Expect the share sheet, and share the file to yourself.
11. Uninstall mbrd, and run `mobile.bat` again. Press "Allow" and turn on the access.
12. Expect the shelf and the board as they were before the uninstall.

The measurement, on the faster phone:

1. Put 300 photographs on the phone.
2. In mbrd (v0.306 or later), import all 300 onto one board, and time it.
3. Close mbrd from the recent apps. Open it, and time until the photographs show.
4. Build v0.304 (`git checkout f366e94`, then `mobile.bat`), which keeps the store in IndexedDB.
5. Do steps 2 and 3 again on that build.
6. Send me the four times. They go into the header of `MbrdStore.java`.
7. Run `git checkout main` to go back.

M6, on each of the two phones, with a build from v0.307 or later:

1. Put a `.mbrd` file in Downloads. In the Files app, share it to mbrd.
2. Expect the board to open, and a copy of the file in Documents/mbrd.
3. In the gallery, share a photograph to mbrd. Expect a card in the middle of the view.
4. In Chrome, share a page to mbrd. Expect a link card.
5. Long-press a card to open its menu. Press Back. Expect the menu to close, and nothing else.
6. Open a picture in the viewer. Press Back. Expect the viewer to close.
7. With nothing open, press Back. Expect the home screen, and the board still there in the recent apps.
8. Add a note. Press Home at once, then swipe mbrd away in the recent apps.
9. Open mbrd. Expect the note.
10. In portrait, look at the top and bottom edges. Expect nothing under the status bar or the gesture bar.
11. Turn the phone. Expect full screen, and a swipe from the edge to show the bars.
12. Change the look in the panel. Expect the bands at the top and bottom to take the new paper colour.

N0, on each of the two phones, one phone at a time. The binary is FileAnalyser
9.10.0's, taken out of its release APK into
`C:\Users\Kosta\AppData\Local\Temp\n0\lib\arm64-v8a\libanrffmpeg.so`. Use the
SDK's adb by its full path: the `adb` in PATH is `C:\adb\adb.exe`, version
1.0.32, and it stops the SDK's newer server.

1. Connect the phone by USB with USB debugging on, as in J8 steps 1 and 2.
2. In PowerShell, run `C:\Android\sdk\platform-tools\adb.exe devices`. Expect one phone in the list.
3. Run `C:\Android\sdk\platform-tools\adb.exe push C:\Users\Kosta\AppData\Local\Temp\n0\lib\arm64-v8a\libanrffmpeg.so /data/local/tmp/ffmpeg`.
4. Run `C:\Android\sdk\platform-tools\adb.exe shell chmod 755 /data/local/tmp/ffmpeg`.
5. Run `C:\Android\sdk\platform-tools\adb.exe shell /data/local/tmp/ffmpeg -hide_banner -version`.
6. Expect a first line that starts with "ffmpeg version".
7. Run the one-frame hardware encode:
   `C:\Android\sdk\platform-tools\adb.exe shell '/data/local/tmp/ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=black:s=320x240:d=0.1:r=10 -pix_fmt yuv420p -c:v h264_mediacodec -frames:v 1 -f null - ; echo exit=$?'`
8. Expect `exit=0` and no error lines.
9. Run step 7 again with `libopenh264` in place of `h264_mediacodec`. Expect `exit=0`.
10. Run `C:\Android\sdk\platform-tools\adb.exe shell rm /data/local/tmp/ffmpeg`.
11. Send me the make, the model, the Android version, the line from step 6 and the output of steps 7 and 9.

O5, the maintainer's, with v0.308 or later pushed:

1. Do the four key steps in `mobile/README.md`.
2. On GitHub, open KostaJovanovic/mbrd, then Actions, then "Release apps".
3. Click "Run workflow". Untick "Publish the release", and click "Run workflow".
4. Expect four artifacts: release-windows, release-macos, release-linux and release-android.
5. Download release-android and unzip it.
6. Run `C:\Android\sdk\build-tools\35.0.0\apksigner.bat verify --print-certs` on the APK.
7. Expect the name you gave `keytool` in step 1.

The update, on one phone, after two published releases:

1. Uninstall any `mobile.bat` build. Its debug key cannot take a release update.
2. Install the older release's `mbrd-android-<version>.apk` from KostaJovanovic/mbrd-release.
3. Open mbrd. Expect "mbrd <newer version> is out". Press "Update".
4. Expect a progress bar. On Android 12 and later, expect no confirm screen.
5. Expect mbrd to close. Open it again.
6. In the panel, expect the newer version in the footer.

Asked outside the task list on 2026-09-13, done in v0.302: the desktop
changelog opens in place in the board view, under the bar, and no longer in a
window of its own (`desktop/main.ts`, and the plan's changelog line in §1). The smoke test covers
the trip there and back, the flush on the way out, and a close from the
changelog. Hand check: open What Changed from the Help menu, press "Back to the
board", and press a menu row while the changelog shows.

Bugs found outside the task list, not fixed:

1. Web poster frames through ffmpeg.wasm never work. `media-worker.js` needs
   `core.callMain`, and `@ffmpeg/core` 0.12.6 has `exec` and `FS` but no
   `callMain`, so `boot()` throws "this build exposes neither FS nor
   callMain". Fix: call `core.exec` when there is no `callMain`, and
   `core.reset()` between runs.
2. `desktop/scripts/fetch-ffmpeg.mjs` says "Pinned by version", but its Linux
   URL is johnvansickle's moving `ffmpeg-release` alias (7.0.2 on 2026-09-13).
   `releases/ffmpeg-7.0.2-amd64-static.tar.xz` answered 200 that day and
   `old-releases/` answered 404, so a pinned URL may disappear later.
3. `desktop/electron-builder.yml` says its `extraResources` comment twice: two
   paragraphs about `web/` and `_headers`, and two about ffmpeg and
   onnxruntime. It is in HEAD, not from this plan. Fix: keep one of each.
4. FileAnalyser's `AnrBytes` leaves a partial file behind. When a transfer is
   short at `end`, `end` has already closed the stream and cleared it, so the
   reset that follows deletes nothing. Fix: delete the target in the reset
   whenever one is set, as `MbrdBytes` does from v0.306.
5. `.github/CONTRIBUTING.md` links `research/docs/architecture.md` in its second
   paragraph. The file is in `.github/`, so the link points at
   `.github/research/docs/architecture.md`, which does not exist. It is in HEAD,
   not from this plan. Fix: `../research/docs/architecture.md`.

Before the first release, checked with `gh` on 2026-09-13: KostaJovanovic/mbrd
has no secrets, and KostaJovanovic/mbrd-release has no branch, so the publish
job's `--target main` has nothing to tag. The maintainer adds a first commit
there (a README) and sets `RELEASES_TOKEN` and the three `ANDROID_KEY*` secrets.
