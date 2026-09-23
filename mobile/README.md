# mbrd for Android

The Android shell of mbrd: Capacitor around the same `web/` tree the website
serves, the way `desktop/` wraps it for a computer. There is no fork of the app
code. The decisions are in `research/old/apps-2026-09-13.md` §5, and the tasks
in `research/old/apps-tasks-2026-09-13.md`, groups J to O.

Nothing here reaches the website: `web/` never sees it. iOS is written down in
the plan (§11) and not started, because it needs a Mac.

## Run it

`mobile.bat` in the repository root is the one step:

```
mobile.bat          build, install on every connected phone, and start it
mobile.bat apk      build only: mobile\android\app\build\outputs\apk\debug\app-debug.apk
mobile.bat open     stage and sync, then open Android Studio
```

Connect the phone over USB with USB debugging on: About phone, tap "Build
number" seven times, then Developer options, USB debugging. It needs Node 22.18
or newer, the Android SDK with platform 36 on `ANDROID_HOME`, and **JDK 21** for
Gradle, because Capacitor 8 does not build on 17. The script uses `JAVA_HOME`
when that is 21 or newer, and otherwise looks in `%USERPROFILE%\.jdks` and in
the runtime Android Studio bundles.

The steps by hand, from `mobile/`, after `npm install` here and at the root:

```
npm run sync                # stamp the version, stage web/, cap sync
npm run typecheck           # the bridge against platform/electron.ts
cd android
gradlew assembleDebug       # the APK
gradlew testDebugUnitTest   # MbrdRouterTest, MbrdNamesTest, MbrdUpdateTest
```

**The APK carries a copy of the site.** `tools/stage-web.mjs` copies `web/` into
`mobile/www/`, and `cap sync` copies that into the Android project. So an edit
shows on the phone only after `mobile.bat` runs again. The staging refuses a
bundle older than its sources, so `npm run build` at the root comes first, and
`mobile.bat` does that.

For a faster loop, point the WebView at `serve.py`: start `server.bat`, then
from `mobile/` run
`npx cap run android --live-reload --host <this PC's LAN IP> --port 6273`.
`MbrdWebViewClient` serves `/__mbrd/*` for the dev server too, so the bridge
still works. `serve.py` sends no CSP, so the policy is checked only in a built
APK. Nobody has tried this on a phone yet.

## How it fits together

| File | Job |
| --- | --- |
| `capacitor.config.json` | App id `com.valjdakosta.mbrd`, `server.hostname: "app"` over https, `minWebViewVersion: 110`, `resolveServiceWorkerRequests: false`, SystemBars `insetsHandling: "disable"` |
| `tools/stage-web.mjs` | `web/` to `www/`, with the desktop's exclusions. Writes `mbrd-files.txt`, `mbrd-csp.json` and the bridge bundle `mbrd-bridge.js` into the Android assets |
| `tools/stamp-version.mjs` | `versionName` is `VERSION` and `versionCode` is `COMMIT_COUNT`, both from `web/assets/js/version.js` |
| `tools/make-icons.mjs` | `npm run icons`: the launcher icons and the splash screens. The output is tracked |
| `bridge/mbrd-bridge.ts` | `window.mbrdDesktop` for the phone, in `desktop/preload.ts`'s shape |
| `bridge/store.ts`, `files.ts` | The store and the files halves, over `MbrdStore` and `MbrdFiles` |
| `bridge/lifecycle.ts` | What the desktop's main process sends the page: opened files, the pause, Back, the bar colour |
| `bridge/share.ts` | `navigator.share` and download links, which the WebView lacks |
| `bridge/bytes.ts`, `native.ts`, `boot.ts` | The page half of the byte channel, plugin calls and events, and the boot object |
| `android/.../MainActivity.java` | Registers the plugins, asks for the storage grant, and owns the insets, the bar colour, full screen in landscape, Back and incoming intents |
| `android/.../MbrdShell.java` | Injects the bridge and installs the routing. Startup notes, share, the bar colour, incoming files, the pause, the update check |
| `android/.../MbrdWebViewClient.java` | Every request to the app origin, for the page and its service worker, with the CSP |
| `android/.../MbrdRouter.java` | Which staged file a path names: the twin of `readPage()` in `desktop/protocol.ts` |
| `android/.../MbrdBytes.java` | The byte channel, page to native (`window.mbrdBytes`) |
| `android/.../MbrdStore.java` | The four stores, one file a key |
| `android/.../MbrdNames.java` | The store's file names, byte for byte the desktop's |
| `android/.../MbrdRoot.java` | Where the boards and the store live for this run |
| `android/.../MbrdFiles.java` | Save, Open, Import, and the files other apps hand in |
| `android/.../MbrdUpdate.java` | Release builds only: the update from `KostaJovanovic/mbrd-release` |

## The bridge

`bridge/mbrd-bridge.ts` defines `window.mbrdDesktop` with the **same shape as
`desktop/preload.ts`**, at `bridge: 3`. `main.ts` reads that object once and
wires every port from it (`platform/electron.ts`), so the phone runs through the
branch the desktop already has. Two keys are new, `shell: 'capacitor'` and
`platform: 'android'`, for a branch that must not run on a phone.
`tests/mobile-bridge.test.js` holds the two bridges to one shape, as text, in
every `npm test`, and `npm run typecheck` here checks the types.

`MbrdShell.load()` injects the bundle with `addDocumentStartJavaScript`, for the
app origin and the dev server only, before Capacitor loads the first page. So
the bridge exists before any page script runs, as the preload guarantees on the
desktop. Capacitor's own `window.Capacitor` arrives after it, so `native.ts`
looks it up at each call.

The bridge also adds what a WebView lacks:

- **Downloads.** A `blob:` or `data:` link with `download` does nothing in a
  WebView. The bridge catches those clicks, with a capture listener and a
  wrapper on `HTMLAnchorElement.prototype.click` for detached links, and hands
  the bytes to the Save dialog a board uses.
- **`navigator.share`**: text, a link, or one file, through the system share
  sheet.
- **Back.** `MainActivity` asks `window.__mbrdBack()` first. The page closes its
  top layer: an open menu, then a dialog, then whatever answers Escape, which
  marks the press with `markClosed()` in `util.ts`. With nothing left open, the
  app goes to the background and keeps the board.
- **The pause.** A phone does not close, it pauses and may be killed after. So
  the flush the desktop runs before a close runs on the pause.
- **The bar colour.** The status and gesture bands are black when the phone is
  in dark mode and white in light mode (`MainActivity.applyBars`). They used to
  follow the page's background through a bridge call, and a flood of those
  calls made the bars flicker.

## Routing and the CSP

Capacitor's server answers `index.html` for every path with no extension, and
its `RouteProcessor` only ever sees `/index.html`. So `MbrdShell` installs
`MbrdWebViewClient`, which asks `MbrdRouter` for the file. A path ending in `/`
gets `index.html`, a path with no extension tries `<path>.html` first
(`/patch`, `/privacy`), and nothing outside the staged tree is
served. A path with no file is a plain 404, as on the desktop. The staged tree
is `mbrd-files.txt`, so each "does this exist" is a set lookup.

Every answer carries `web/_headers`' Content-Security-Policy, parsed by the
desktop's own `desktop/csp.mts` into the staged `mbrd-csp.json`, with the same
exempt paths. `tests/csp.test.js` holds the staged file against a fresh parse.

No service worker registers while a shell is wired (`main.ts`), and `sw.js` is
not staged. A stale worker's requests still go through the same client:
`MbrdShell` sets it as the service-worker client, and
`resolveServiceWorkerRequests: false` stops Capacitor from replacing it.

## Moving bytes

Capacitor's bridge is JSON, so bytes would cross it as base64: a third larger,
with several copies alive at once. So bytes never use it:

- **Page to native:** `MbrdBytes`, a WebMessageListener the page sees as
  `window.mbrdBytes`. It takes `ArrayBuffer` chunks on a WebView with
  `WEB_MESSAGE_ARRAY_BUFFER`, and base64 chunks otherwise, 4 MB at most. Every
  message gets one acknowledgement, and the page waits for it, so one chunk at
  most is in flight. A store value and a board go to a temp name and are
  renamed at the end, so a cut transfer never replaces a whole file.
- **Native to page:** a plain GET. `/__mbrd/store/<store>/<key>` reads a store
  value, and `/__mbrd/file/<token>` streams a file the plugins handed out. A
  token serves once.

## The store and the permission

The four stores (`kv`, `assets`, `library`, `matte`) are one file a key, as in
`desktop/store.ts`: the same file names (`MbrdNames`), a write to a temp name
and a rename. The page encodes each value with `desktop/format.mts` and native
keeps the bytes as they come, so a store folder copied from a phone reads on the
desktop.

With the storage grant, the boards live in `Documents/mbrd/` and the store in
`Documents/mbrd/.store/`, so both survive an uninstall and the boards show in
Files. The grant is All files access on Android 11 and later, and the write
permission before that. Before the bridge loads, `MainActivity` shows a screen
that says why, with Allow and Not now. Not now keeps everything in the app's
private folder for that run, a note on the board says where, and the next start
asks again. The first run with the grant moves the private store across.

## Files

- **Every board is a file in the board folder**, as on the desktop
  (`MbrdBoards`, `desktop/boards.ts`'s five calls): the board list reads the
  folder, New makes a file, a rename renames it, and Delete moves it to
  `.trash/` inside the folder, which keeps it 30 days. The autosave writes the
  board on screen to its file a few seconds after an edit and when the app
  pauses, adding only what changed (the `append` target), and the store keeps no
  copy of it: only which file it is and where the view was. **Save as** asks for a
  name and asks again before it replaces a file. **Open** copies a board from
  anywhere into the board folder, `name (2).mbrd` on a clash, except a board
  already there, which opens in place. **Import** copies nothing: each picture,
  clip or document is a token, and its bytes go into the store.
- The page never names a path the plugins did not produce (`checked()` in
  `MbrdFiles`): a `.mbrd` file directly in a board folder and not hidden, so
  never the store, the bin, a subfolder or a picture kept there, or one this
  process handed out.
- **"Open with" and "Share to mbrd"** are in the manifest for boards, pictures,
  clips, sound, PDF and text, `content://` only. A board opens, every other file
  lands as a card at the centre of the view, and a shared link becomes a link
  card. An intent that arrives before the page listens waits for it.

## Native FFmpeg

Not built yet: group N of the task list, held until a test on two phones says
whether `h264_mediacodec` works from a child process. Until then
`native.can()` answers `transcode: false`, and video Optimise runs ffmpeg.wasm,
as the website does on the same phone.

## Security

The threat model is the desktop's. A crafted file that finds an XSS can call
every plugin directly, so every check lives in the Java plugins and none in the
bridge:

- `MbrdFiles`: only paths it produced, and names are flattened.
- `MbrdStore`: the four stores, and names through `MbrdNames`.
- The byte channel: registered for the app origin and the dev server only, and
  every field of a begin message is checked.
- `/_capacitor_file_/` and `/_capacitor_content_/` answer 404, on every host and
  scheme, the live-reload server included. Nothing here uses them, and they
  would give any page script a reader for every file the app can reach.
- Incoming intents: `content://` only, and never a URI on the app's own
  providers. The FileProvider hands out only the share folder in the cache.
- No general-purpose Capacitor plugin is installed: `package.json` has
  `@capacitor/android` and `@capacitor/core` and nothing else.

## Releases and updates

`.github/workflows/release.yml` builds the APK on GitHub, beside the desktop
builds, and publishes it in the same release in the public
`KostaJovanovic/mbrd-release` as `mbrd-android-<version>.apk`. The Android job
builds the web bundle, runs `npm run sync`, then
`gradlew testReleaseUnitTest assembleRelease` with the release key and the
update feed. Four FFmpeg steps wait for group N and skip until
`mobile/ffmpeg/build-android.sh` exists.

`MbrdUpdate.java` is the updater. It runs only when `BuildConfig.UPDATE_FEED`
holds a URL, and only the workflow sets one (`-PmbrdUpdateFeed`): the GitHub API
address of the latest release in `mbrd-release`. The release holds no update
file. At start-up, at most once every six hours, the updater reads that answer,
and the panel's "Check for updates" reads it at once. A newer tag than the
installed `versionName` asks first. **Update** downloads the asset named
`mbrd-android-<version>.apk` into the cache with a progress bar, checks it
against the SHA-256 digest GitHub gives for the asset, checks the package name
and that the `versionCode` is higher, and writes it into a `PackageInstaller`
session. On Android 12 and later the session sets `USER_ACTION_NOT_REQUIRED`:
the update installs with no confirm screen, and the app closes. When Android
still wants a yes, `MbrdUpdate.InstallStatus` (a receiver that is not exported)
opens the confirm screen. Sessions need `REQUEST_INSTALL_PACKAGES`. Android
checks the signature itself. `MbrdUpdateTest` covers the version comparison.

A Google Play build must not pass the feed, and must drop
`REQUEST_INSTALL_PACKAGES` and `MANAGE_EXTERNAL_STORAGE` from the manifest.

## The release key

The maintainer does this once, before the first release with an APK. The
release workflow signs the APK with the key from the repository secrets.
`build.gradle` signs with it only when `MBRD_KEYSTORE` names the file, so a
local build does not change.

**Never replace the key once a release is out.** Android refuses an update
signed with another key, so a new key strands every installed copy.

1. Make the key with the `keytool` of JDK 21. It asks for a password, then for
   a name, which the certificate shows:

   ```
   keytool -genkeypair -v -keystore mbrd-release.jks -alias mbrd -keyalg RSA -keysize 4096 -validity 36500
   ```

2. Turn the file into one line of base64.

   On Windows, in PowerShell:

   ```
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\mbrd-release.jks")) | Set-Content -NoNewline mbrd-release.b64
   ```

   On Linux:

   ```
   base64 -w0 mbrd-release.jks > mbrd-release.b64
   ```

3. Set the secrets on `KostaJovanovic/mbrd`, the private source repository,
   where the workflow runs. The second command asks for the password.

   On Windows, in PowerShell:

   ```
   Get-Content -Raw mbrd-release.b64 | gh secret set ANDROID_KEYSTORE_BASE64 -R KostaJovanovic/mbrd
   gh secret set ANDROID_KEYSTORE_PASSWORD -R KostaJovanovic/mbrd
   gh secret set ANDROID_KEY_ALIAS -R KostaJovanovic/mbrd --body mbrd
   ```

   On Linux, the first line is
   `gh secret set ANDROID_KEYSTORE_BASE64 -R KostaJovanovic/mbrd < mbrd-release.b64`.

4. Delete `mbrd-release.b64`. Keep `mbrd-release.jks` and its password offline,
   in two places.

`ANDROID_KEY_PASSWORD` is only for a key with a password of its own.
`keytool` writes a PKCS12 store, which has one password for the store and the
key, so this key needs none.

## Versioning

`tools/stamp-version.mjs` writes `versionName` (the footer's label, such as
`0.308`) and `versionCode` (`COMMIT_COUNT`) into `android/app/build.gradle` on
every sync. `COMMIT_COUNT` only grows, which is what Android needs for an
update. The committed `build.gradle` can lag behind, because every sync stamps
it again. Never set either by hand.

## Not done yet

- **A phone.** Everything here builds and its tests pass, but the checks that
  need a person (J8, K7, L6, M6, N0 and O5 in the task list) have not been run.
- **Native FFmpeg** (group N), and with it the LGPL notice in the About sheet.
- Native `matte` and `decode`: the bridge refuses them, and the page takes its
  web path, as on the website.
- A store listing, and iOS.
