# Capacitor — the plan for a mobile app

Open work. The argument for wrapping the web app as an installable iOS and
Android build, and the record of every decision it rests on. Written against
`299b768` (v0.293), after the Electron work (groups A–J) shipped — which is the
fact that makes this document short.

This is the *why* and *what*, in one file. It is not an executable task list
yet; an `capacitor-tasks-*.md` split can follow on the terms
`electron-tasks-2026-09-06.md` took, once the §1 table is ratified. Read §1
before proposing an alternative to any choice in it: the table is the
maintainer's to settle, the same way the Electron plan's §1 was.

Goes to `old/` on the last commit of the work it schedules.

---

## §0 — The one-paragraph version

The desktop shell taught this app to answer seven questions through a
`Platform` port (`web/assets/js/platform/platform.ts`) and to keep its store
behind a `StoreBackend` seam (`web/assets/js/storage/idb.ts`). A browser tab
uses the web defaults; Electron wires an adapter. **Capacitor is a third
adapter and nothing more.** The renderer is the same WebView the phone already
runs the site in, so the app already works — this plan packages it, gives it a
native way to open and share a `.mbrd`, flushes on background instead of on
close, ships native ffmpeg and over-the-air updates, and stops registering the
service worker. v1 keeps the store on IndexedDB, which the WebView already has.

---

## §1 — Decisions (the maintainer's to ratify)

Answer these before the task split is written. Each carries the recommendation
and the reason, in the shape the Electron plan's §1 used.

| # | question | recommendation | why |
| --- | --- | --- | --- |
| 1 | **A third package, or fold into `desktop/`?** | A new sibling package `mobile/`, own `node_modules`, own deps. | The root stays zero-dependency and `npm test` stays zero-install — the property `desktop/` already protects. Capacitor's deps have nothing to do with Electron's. |
| 2 | **The store on the phone.** | v1: keep IndexedDB as-is (zero work — the WebView has it). Durable native backend is a measured fast-follow (§4). | Fastest route to a working app, and the website already runs on this store. The seam is ready if eviction testing says move. |
| 3 | **iOS build host.** | GitHub is not enough; iOS needs a Mac with Xcode. Android builds from Windows. | Apple signs and archives only on macOS. Same OS wall as the DMG, stricter. |
| 4 | **Native work (ffmpeg, matte, decode).** | Wire **native ffmpeg** through a plugin to fill the `NativePort` (poster frames, transcode). Matte and decode stay web defaults in v1. | Native ffmpeg is linked ARM code, not wasm — a different performance story, and worth it on a phone. The seam is already the shape `desktop/native/ffmpeg.ts` fills. The maintainer's "not worth it" was about *wasm* ffmpeg in a browser, not this. See O5 for the sourcing and licence risk. |
| 5 | **`isDesktop()` — rename or overload?** | Rename to `isShell()` (or `isNativeShell()`) across its call sites. | Capacitor wires a `Platform`, so the flag means "a shell is wired", not "desktop". The service-worker guard (§6) and any desktop-only UI branch must read it correctly. |
| 6 | **Frame and the title bar.** | Web defaults. No custom title bar. | A phone draws no window frame. `frame.own()` false is already the web answer. |
| 7 | **Stores to publish to, and when.** | Android (Play, $25 one-time) first; iOS (App Store, $99/yr) when a Mac is available. | Android is buildable and testable from the maintainer's Windows machine today; iOS is gated on hardware. |
| 8 | **Cloud share (Google Drive) on the phone.** | Decide after testing cross-origin fetch from the Capacitor scheme (§5, open question O1). | `googleapis` is reached by `fetch` from `capacitor://localhost`; that may need `CapacitorHttp` or a CORS path. It is the one network feature that can silently break. |
| 9 | **Auto-update on mobile.** | **Custom OTA via GitHub Releases**, filling the `UpdatesPort`. Web assets only; native changes still ship through the store. | mbrd is web assets, so a new bundle is a new version — the mobile mirror of Electron serving `web/` off disk. Fixes reach users without a store review. See §13, O6, O7. |

---

## §2 — What is already done (and must not be redone)

The Electron groups A–J closed the hard part. None of this is Capacitor's to
build:

- **The `Platform` interface** — `files`, `lifecycle`, `native`, `updates`,
  `frame`, `setDocument`, `relaunch`. Seven ports, web defaults that *are* the
  browser behaviour, wired by `setPlatform()`. See `platform.ts`.
- **The `StoreBackend` seam** — eight operations behind `idb.ts`, swappable by
  `setStoreBackend()`. IndexedDB is the default; the Electron file backend
  proved a second one drops in.
- **The wiring point** — `web/assets/js/main.ts:103`, the one read of a shell
  global, before anything touches the store:
  ```ts
  const bridge = window.mbrdDesktop;
  if (bridge) { setPlatform(electronPlatform(bridge)); setStoreBackend(electronStore(bridge)); }
  ```
  Capacitor adds a branch beside this, not a rewrite of it.
- **The document model** — `DocumentRef`, Save vs Save As vs Export, the shelf's
  path rows, `onCloseRequested`/`onOpenFiles`. All expressed through the ports.
- **The invariant** — the web app works at every commit; an unwired port is the
  web behaviour. Capacitor inherits this rule unchanged.

**The adapter to mirror is `platform/electron.ts`.** A Capacitor adapter is the
same file one runtime over: translate a native surface into the ports, convert
Blobs at the seam, read no global (main.ts hands the surface in).

---

## §3 — What Capacitor changes, port by port

Seven ports. Three stay on their web default. Four need a Capacitor adapter.

| port | on Capacitor | work |
| --- | --- | --- |
| **`native`** | **ffmpeg via a plugin**; matte/decode web default | wire ffmpeg to `firstFrame`/`transcode`/`canTranscode` (§1 #4, O5) |
| **`updates`** | **custom OTA adapter** (GitHub Releases) | fill `check`/`install`; download, verify, swap the web bundle (§13, O6, O7) |
| `frame` | web default (`own()` false) | none — no window frame |
| `setDocument` | web default (no-op) | none — no title bar |
| `relaunch` | web default (`location.reload()`) | none — reload is fine |
| **`files`** | **Capacitor adapter** | open, save, share a `.mbrd` natively (§7) |
| **`lifecycle`** | **Capacitor adapter** | flush on background, open-in from other apps (§8) |

Plus one non-port change: **the store backend** (§4, IndexedDB in v1) and **the
service worker** (§6, not registered).

That is the whole surface. Everything not in this section is already correct
because the web default is already correct on a phone.

---

## §4 — The store: the one real decision

The app's boards live in the store behind `idb.ts`. On a phone there are three
ways to hold them, and this is the choice worth arguing.

**(a) IndexedDB, unchanged — the v1 recommendation.** The Capacitor WebView has
IndexedDB, so the store needs *nothing*. The website already runs on it. Ship
this first.
- **Risk:** WebKit can evict WebView storage under disk pressure, and IndexedDB
  in a WKWebView is invisible to the user and awkward to back up. A board is the
  user's document; losing one is the worst thing this app can do. **This risk is
  the reason (b) and (c) exist and the reason the seam was built.**
- **What to do about it:** test eviction deliberately (open question O2) before
  the store holds anything a person cannot lose. The move to (b) is a backend
  swap at one line, not a rewrite — that is the whole point of the seam.

**(b) A `@capacitor/filesystem` `StoreBackend`.** One file per key under the
app's data directory, exactly as `electronStore` writes under `userData`. Boards
become real files the OS backs up and the user can export.
- **Cost:** `@capacitor/filesystem` writes binary as **base64** on native
  (+33% and an encode pass on the save thread). Blobs must be converted at the
  seam, the same place `electron.ts`'s `down()`/`up()` already convert them.
- This is the robust answer, and it reuses the `StoreBackend` contract verbatim.

**(c) An SQLite `StoreBackend`** (`@capacitor-community/sqlite`). A proper
key–value store with blob columns, no base64, transactional.
- **Cost:** a heavier native dependency and a schema to own. Overkill unless (b)
  proves too slow.

**Recommendation:** ship (a), measure eviction (O2), and move to (b) if the
measurement or a tester says so. Do not build (c) without a number that demands
it — the same discipline the Electron plan applied to its streaming escape
hatch.

---

## §5 — Serving and CSP

Electron serves `web/` over a custom `app://` scheme and reads `web/_headers`
for the CSP, because `index.html`'s `<base href="/">` forbids `file://`.
Capacitor solves the same problem its own way: it serves the bundled web assets
from `capacitor://localhost` (iOS) / `https://localhost` (Android), a scheme
under which `<base href="/">` and every relative URL resolve. So the serving
question is answered by Capacitor's own local server; no custom scheme handler
is needed.

**The CSP does not travel.** Capacitor's local server does not read `_headers`,
so the runtime enforces no Content-Security-Policy — exactly the situation
`serve.py` is already in ("a CSP nothing here runs"). The real locks are the
code-level ones `_headers`' own header documents: `createElement`/
`createTextNode` everywhere, the SVG allow-list, and `tests/csp.test.js` holding
the policy to the code. Those hold on Capacitor unchanged. **Do not add a
`<meta http-equiv>` CSP** to chase parity — it would be a fourth copy of a
policy the repo keeps in one place, and the first one a test cannot check.

**The external hosts still have to be reachable.** `connect-src` names
`googleapis` (Drive share), `jsdelivr` (ffmpeg core — moot on mobile per §1 #4),
and the Spotify/YouTube oembed hosts (`open.spotify.com`, `i.scdn.co`,
`www.youtube.com`). A `fetch` from `capacitor://localhost` to these is
cross-origin and depends on the remote's CORS. The Drive share is the one that
breaks silently if it is blocked — see open question O1.

---

## §6 — The service worker

**Do not register it.** `sw.js` is the web's updater; on a packaged app the
store updates the app instead, and a service worker caching a
`capacitor://localhost` origin is a second, stale copy of the app fighting the
bundle. The guard already exists at `main.ts:666`:
```ts
if (!isDesktop() && 'serviceWorker' in navigator) { ... }
```
Because Capacitor wires a `Platform`, `isDesktop()` is already `true` and the
worker is already skipped — **but only if §1 #5 is settled**. If `isDesktop()`
is renamed to `isShell()`, this guard reads correctly for both shells. If it is
left as `isDesktop()`, it is a misnomer that happens to work; the rename is the
honest fix and is cheap.

`SHELL` in `web/sw.js` is on the do-not-touch list and needs no edit: the worker
simply never runs.

---

## §7 — The files port on a phone

A phone has no File System Access API and no "Save As path" model. The Capacitor
`FilesPort` adapter answers each method with a native surface:

- **`canPick()`** — `true` (a native picker exists), so `write()` never falls to
  the browser `download()` path, which does not work in a WebView.
- **`pickOpen(spec)` / `pickImport(spec)`** — a native document picker
  (`@capawesome/capacitor-file-picker`, or the platform picker), returning bytes
  + a name. A `.mbrd` filter on the picker where the OS allows one.
- **`write(ref, blob)`** — save to the app's Documents directory via
  `@capacitor/filesystem`, then offer the **Share sheet**
  (`@capacitor/share`) so the user can send the `.mbrd` to Files, Drive, email,
  AirDrop. "Save" on a phone means "keep it, and let me send it somewhere".
- **`read(ref)` / `exists(ref)`** — over `@capacitor/filesystem` by path/URI.

This mirrors `electronFiles` method for method; the difference is the surface
underneath, not the shape. Convert Blob ↔ base64/ArrayBuffer at this seam, the
job `electron.ts` does for IPC.

---

## §8 — The lifecycle port on a phone

- **`onCloseRequested(fn)`** — a phone app backgrounds, it does not close. Wire
  `@capacitor/app`'s `appStateChange` (and `pause`) to run the flush when the
  app goes to the background, and the web default's `visibilitychange` still
  fires under the WebView as a second belt. The flush is `flushEdits` unchanged.
- **`onOpenFiles(fn)`** — open-in from another app. Android declares an intent
  filter for `.mbrd` / `application/vnd.mbrd+zip`; iOS declares a document type
  (UTI) for the same. Capacitor delivers the incoming URL via `appUrlOpen`; the
  adapter reads the file and calls `fn` with an `OpenedFile[]`, exactly as the
  Electron `onOpenFiles` does.

Neither needs a renderer change: B4 of the Electron work already routed close
and open-files through these ports.

---

## §9 — What this plan does *not* fix: the jank

The maintainer's stated reason for wanting an app is that the PWA feels janky on
most phones (low framerate on pan/zoom, slow boot). **Capacitor does not change
this.** It renders in the same system WebView as the browser — WKWebView on iOS,
System WebView on Android — so pan/zoom framerate and boot time are identical to
the PWA. Capacitor buys native file access, a store presence, and open-in; it
does not buy a faster renderer.

The framerate work is a separate, web-side effort that benefits the browser and
the app at once — profile the canvas path on-device (layout thrash, oversized
draws, non-passive touch handlers, main-thread work during the gesture). That is
its own document, not this one. This plan is honest that it packages the app; it
does not claim to make it feel better.

---

## §10 — The order of work

Each group ends with the web app still working, because every port is unwired by
default. Groups map onto the Electron plan's discipline: seams first, adapter
next, packaging last.

| group | what | web still works? |
| --- | --- | --- |
| **A** | `isDesktop()` → `isShell()` rename, and the service-worker guard (§1 #5, §6) | yes — a rename, same behaviour |
| **B** | `mobile/` package: Capacitor config, `webDir` → built `web/`, `npx cap add android` | yes — nothing wired |
| **C** | `platform/capacitor.ts`: files + lifecycle adapters; updates/frame from web defaults (§7, §8). `native` stubbed to web default until H | yes — adapter unwired until D |
| **D** | Wire it: the branch beside `main.ts:103` that reads the Capacitor runtime and calls `setPlatform`/(store, if §4 moves) | yes — guarded on the runtime being present |
| **E** | Android packaging: intent filter, icons, splash, safe-area/status-bar CSS, version stamping (§11) | yes |
| **F** | iOS packaging (needs a Mac): document type/UTI, icons, launch screen, safe-area | yes |
| **G** | Store listings, screenshots, privacy text; Android internal-test track; TestFlight | yes |
| **H** | Native ffmpeg: a plugin filling `NativePort.firstFrame`/`transcode`/`canTranscode`, sourced and licensed per O5. Any time after D. | yes — `native` is web default until wired |
| **I** | OTA auto-update: the `updates` adapter in `platform/capacitor.ts`, the swap primitive (Capgo self-hosted, or a custom plugin), the GitHub-release `manifest.json`+`bundle.zip` in CI, and integrity/rollback/`minNativeVersion` (§12, O6, O7). Any time after D. | yes — `updates` is web default (null) until wired |

A, D, and I are the groups that touch existing shared `web/` code (a rename, the
wiring branch in `main.ts`, and the boot-time update check); the rest add new
files under `mobile/`, the native projects `cap add` generates, or
`platform/capacitor.ts`. **H and I can land whenever** — the app works without
either (native work falls to the web path, and updates fall back to the store),
so both are feature groups, not blockers.

**Layering:** add `'platform/capacitor.ts'` to `BASE` in `tests/layers.test.js`
beside `'platform/electron.ts'`, same reasoning.

---

## §11 — Version stamping

`desktop/package.json` carries `0.0.0` and the release workflow stamps it from
`web/assets/js/version.js`. Mobile has two extra numbers the stores demand:

- **`versionName`** (Android) / **`CFBundleShortVersionString`** (iOS) — the
  `VERSION` string, stamped the same way.
- **`versionCode`** (Android) / **`CFBundleVersion`** (iOS) — a monotonic
  integer that must increase every upload. `VERSION` is `0.293`-shaped; pick a
  scheme that only grows (e.g. the integer after the dot, or
  `major*1000 + minor`). **This is a decision, not a default** — a `versionCode`
  that ever goes backwards is an upload the store refuses for good. Settle it in
  the task split.

Like `desktop/`, keep `mobile/package.json` at `0.0.0` in the repo and stamp in
CI, so the version lives in `version.js` and nowhere else.

---

## §12 — Mobile auto-update (OTA)

**The idea, and why it fits.** mbrd is web assets bundled into a native shell,
so a new `web/` build *is* a new version — exactly what Electron ships by serving
`web/` off disk. On mobile the mirror is an over-the-air swap: download a newer
bundle and serve from it, with no store review. It fills the `UpdatesPort`
(`check`/`install`) the app already has, and drives the same "New version ready"
toast the web and desktop already show.

**What can and cannot go OTA.** Web assets only — HTML, CSS, the `app.js`
bundle, fonts, vendored wasm. **Native code cannot**: a new Capacitor plugin,
the group-H ffmpeg library, or an SDK bump ships through the store like any app.
This split is the whole hazard — see O6.

**The host is GitHub Releases**, the same backend electron-updater uses, so
there is no server — the property the app keeps everywhere (§5, and `_headers`'
"no server" notes). A release carries a `manifest.json` and a `bundle.zip`.

**The mechanism.**
- `check()` fetches `manifest.json` from the latest release, compares its bundle
  version to the installed one, and returns `UpdateInfo` or null.
- `install()` downloads `bundle.zip`, verifies it, unpacks it to app storage,
  points the WebView at the new directory, and reloads.

**The swap primitive is not in Capacitor core.** Core cannot repoint the served
bundle at runtime — that is precisely why Capgo exists. "Custom via GitHub"
therefore means *you own the distribution* (manifest, integrity, host), while the
swap-and-rollback primitive comes from one of two places:
- **`@capgo/capacitor-updater` with a self-hosted source** — the recommendation.
  It gives proven download, atomic swap, and boot-failure rollback; point it at
  the GitHub-hosted manifest/zip and run no Capgo backend. One dependency, little
  code.
- **A small custom native plugin** (Swift + Kotlin) — most control, most code,
  and it re-implements the swap and rollback the first option already ships.

**Integrity (O7).** GitHub over TLS secures the transport, but a bundle that
swaps the whole app deserves more than transport trust: the manifest carries a
SHA-256 per bundle and the app refuses a mismatch. A signed manifest (Ed25519,
public key baked into the native build) is the stronger form, and it is worth it
because the payload is the entire running app.

**Rollback (O7).** A swapped bundle that fails to boot must revert to the
last-good bundle, and the shipped bundle is the floor. A "mark this bundle good
only after it boots once" latch is the shape.

**Version alignment with the native shell (O6).** The one hazard with no desktop
equivalent: an OTA web bundle may call a native capability the installed shell
does not have — the group-H ffmpeg plugin pushed to a phone still on the
pre-ffmpeg shell, say. The manifest carries a `minNativeVersion`, and the app
refuses a bundle newer than its shell can serve. Native features must also
degrade rather than throw when absent, which the `NativePort` null-fallback
contract already guarantees.

---

## §13 — Open questions

- **O1 — Cross-origin fetch from `capacitor://localhost`.** Does the Google
  Drive share (`googleapis`) work over `fetch` from the Capacitor scheme, or does
  it need `CapacitorHttp` (which routes through native and sidesteps CORS)? Test
  before promising the share on mobile. The oembed card-decoration fetches
  (Spotify/YouTube) fail *gracefully* already, so they are not blockers; Drive
  does not.
- **O2 — IndexedDB durability in the WKWebView.** Does the store survive an
  eviction pass under disk pressure and an OS update? This is the number that
  decides §4 (a) vs (b). Fill a store, stress the device, relaunch, check the
  boards are there.
- **O3 — Accelerator/keyboard and hardware back button (Android).** Android's
  hardware/gesture back must not drop the user out of the app mid-board; wire
  `@capacitor/app`'s `backButton` to the app's own back semantics or a
  confirm-exit, not the default.
- **O4 — Safe areas and the status bar.** The board is full-bleed; notches and
  the status bar need `env(safe-area-inset-*)` handling and a `@capacitor/status-bar`
  colour that follows the whimsy dial. A layout task, checked by eye on a real
  device, not a test.
- **O5 — Sourcing native ffmpeg, and the iOS licence wall.** Two problems, both
  real. FFmpegKit — the usual Capacitor/React Native ffmpeg wrapper — was retired
  in 2025 and its prebuilt binaries were pulled from the remote repositories, so
  the plugin route means self-hosting its last release, a maintained fork, or
  building libav yourself. And a **GPL** ffmpeg build (the one the desktop ships)
  conflicts with the App Store terms on iOS; an LGPL build without the GPL-only
  codecs, or a different distribution stance, is the way through. **Android has
  neither problem** — a GPL build ships fine and the binaries can be self-hosted.
  Note also the mechanism: mobile links ffmpeg as a *library*, not a spawned
  binary like `desktop/native/ffmpeg.ts`, so the implementation differs while the
  port stays the same. On iOS, `AVFoundation` is a licence-clean alternative for
  the poster-frame case (`firstFrame`) even if transcode waits.
- **O6 — OTA bundle vs native shell skew.** An OTA web bundle can outrun the
  installed native shell — a bundle that expects the group-H ffmpeg plugin,
  pushed to a phone still on the pre-ffmpeg shell. The manifest's
  `minNativeVersion` and a refusal to apply a bundle newer than the shell are the
  guard (§12). Decide the versioning scheme for the native shell that this
  compares against, and confirm every native feature degrades rather than throws
  when its plugin is absent.
- **O7 — OTA integrity and rollback.** Two things a whole-app swap must not get
  wrong: a bundle whose bytes were tampered with (SHA-256 in the manifest, and
  ideally an Ed25519 signature the native build verifies), and a bundle that
  bricks the boot (revert to last-good, shipped bundle as the floor). Confirm the
  chosen swap primitive (`@capgo/capacitor-updater` self-hosted, or a custom
  plugin) does both, and store-policy-check that silent OTA of interpreted code
  is within Apple's and Google's current terms (it is, for JS that does not
  change the app's core purpose — verify at build time).

---

## Checklist

Mark each group `DONE <commit>`, `SKIPPED — <reason>`, or leave blank.

| group | status | notes |
| --- | --- | --- |
| A | | |
| B | | |
| C | | |
| D | | |
| E | | |
| F | | |
| G | | |
| H | | |
| I | | |
