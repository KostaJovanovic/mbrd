# What stands between mbrd and 1.0 - 6 October 2026

**Status: open.** An audit, read-only. Nothing in it is built yet.

This is a read of the tree at v0.635, done to answer one question: what has to
change before the version can honestly say 1.0. It does not repeat
`todo-2026-09-14.md`. Where an item is already on that list, it is named here
only when 1.0 changes how urgent it is. "Verified" means the code or a command
showed it. "Inferred" means the reading points to it and nobody has run it.

## Summary

The engineering is close to 1.0. The release is not. The format is specified
and versioned, the parsers check bounds, the CSP is tight, there is not one
`TODO` or `FIXME` in the app, desktop or mobile source, and `npm test` ran
3,034 tests in 12 seconds with nothing installed: 3,033 passed, 1 skipped,
none failed. The gaps are in what a stranger sees first and in how a release
reaches people:

1. **Placeholder and joke copy ships in the About sheet**, and so does an
   "experimental, might suck" hint (B1).
2. **The privacy page, the README and the architecture doc each describe
   fewer network contacts than the app makes**, and they call the project open
   source while its repository is private (B2, B6).
3. **Every push to `main` deploys, nothing gates the deploy, and since
   v0.633 every open web tab reloads into the new build** within about fifteen
   minutes. At about twenty commits a day there is no release candidate and no
   freeze (B3).
4. **No build is signed, and macOS and Linux have never been published** (B4).
5. **On the web the browser's own storage is the only copy of a board** until
   the user exports. Nothing reminds them to export, and the one place that
   answers "is my work safe?" is a Debug fold (B5).
6. **Image and PDF export do not look like the board**, and on the desktop
   and Android apps export is the only way to send a board, because neither has
   Drive (B7, B8).

None of these is a long engineering job except B7. Most are decisions plus
small edits.

---

## Blockers

### B1. Placeholder and unprofessional copy in the shipped interface. Effort S.

**What.** The Credits sheet is what `Help > About mbrd` opens on the desktop
(`desktop/menu.ts:118`, `cmd: 'credits'`). It still holds:

- `web/index.html:953-955`: a Lorem ipsum paragraph under the comment
  "Placeholder for the maintainer's own words".
- `web/index.html:971`: `[INSERT FUNNY QUIP HERE]`.
- `web/index.html:972-973`: "Rewrote this entire project in rust. Also runs in
  the web. Fuck you."
- `web/index.html:1017`: "i like how calm it is, clears my mind" as a licence
  row's description.

And `web/assets/js/ui/settings-schema.ts:1084`: the hint under `Sounds
(experimental)` reads "Experimental feature. Might suck."

**Why it matters.** The About sheet is the one screen a reviewer, a journalist
or an employer opens on purpose. `web/404.html` is a byte copy of
`index.html`, so the same text is on the not-found page too.

**Fix.** Write the paragraph, or delete the element. Decide whether the
mbrd-rs credit stays and in what words. Then pick one: the sounds are good
enough to lose "experimental", or they stay out of 1.0 and the row is hidden.
Add a test in the spirit of `tests/credits.test.js` that fails on `Lorem`,
`[INSERT`, and on placeholder brackets in `index.html`.

### B2. The privacy statement is out of date. Effort S.

**What.** `web/privacy.html:127-150` says "Four things reach the network, and
all four you have to ask for": a YouTube or Spotify player on play, the ffmpeg
core, the host itself, and Share link. It was last changed on 1 September 2026
(`:94`). The code reaches out more often than that:

- **oEmbed on render, not on play.** `canvas/embed-meta.ts:1-6` fetches a
  player card's title from `open.spotify.com` or `www.youtube.com`, and a cover
  from `i.scdn.co`, for any card with no stored title. It needs no click. So
  importing or receiving a board with a Spotify link tells Spotify, unasked.
  Verified, and `web/_headers:98-108` allows it.
- **Drive sync.** `research/docs/cloud.md`, section "Keeping a board in sync",
  uploads `board.json` and every asset after each autosave. The page mentions
  only Share link.
- **Update checks.** The desktop asks `api.github.com` once a day
  (`desktop/updates.ts:24`, `:36-41`). Android asks once a day at start-up
  (`MbrdUpdate.java:51`). Neither has a setting to turn it off (inferred: no
  such setting was found under `desktop/`). An open web tab asks its own host
  every fifteen minutes (`ui/web-update.ts:24`). That last one is the host, but
  it is still a contact the page does not mention.
- **"mbrd is open source"** (`privacy.html:165`). The source repository is
  private (`gh repo view KostaJovanovic/mbrd` returns `PRIVATE`). The public
  `mbrd-release` repository holds a README and nothing else.

`README.md:7` says "Nothing is uploaded and there is no account", and
`README.md:94-96` says two things reach outside. `architecture.md` "Three
things that reach outside" (`:1779-1801`) says the same and leaves out
`embed-meta.ts` and the updaters.

**Why it matters.** The privacy page is the one claim the app makes to the
people who use it. Its own header (`privacy.html:10-16`) gives the reason:
a page that undersells what leaves the machine is worth less than no page.

**Fix.** Rewrite the network section from a list made by grepping every
`fetch(` and `net.request` in `web/`, `desktop/` and `mobile/`. Update the
README and the architecture section in the same commit. Then decide whether the
oEmbed fetch should wait for a click, as the player does, and add an opt-out
for update checks. Consider a test that ties the hosts the privacy page names
to `connect-src` in `_headers`, as `tests/csp.test.js` already does for the
code.

### B3. A push is a deploy, and now it is also a reload. Effort M.

**What.** `.github/workflows/ci.yml:11-20` says it plainly: wrangler deploys on
every push to `main`, CI runs alongside, and "a push that breaks the app still
deploys the broken app". Since f8d0d96 (v0.633), `ui/web-update.ts` reloads
every open tab into the new build at the first idle moment, and checks every
fifteen minutes. `git log` shows about twenty commits on 5 and 6 October
alone, most of them features (a LaTeX editor, a command palette, an Obsidian
Markdown reader). There is no browser-driven test (`CONTRIBUTING.md:120-124`).
The one end-to-end test, the Electron smoke run (`desktop/test/smoke.spec.ts`),
runs only inside `release.yml:241-247`.

**Why it matters.** Before v0.633, a bad deploy reached a user on their next
visit. Now it reaches every open session within the quarter hour, and loads
under a board in the middle of work. The board is stored first
(`web-update.ts:4-6`), but a build that breaks the restore then breaks it for
everyone at once. A 1.0 promises some stability, and at this pace the code on
the site is hours old.

**Fix.**
- Turn on branch protection with the CI job as a required check. It is a
  setting, and the CI header already asks for it.
- Deploy production from a `release` branch or a tag, with `main` going to a
  preview URL.
- Run the Electron smoke test, or a Playwright boot of `web/` with a clean
  console check, in `ci.yml`. The harness already exists in `desktop/`.
- Before 1.0, freeze features for a few days: a release candidate, the owed
  checks from `todo-2026-09-14.md` "Checks still owed", then the crown.

### B4. Unsigned builds, and two of the four systems never shipped. Effort M (mostly cost and paperwork).

**What.**
- Windows is unsigned (`desktop/electron-builder.yml:87-89`), so SmartScreen
  stops the first run (`release.yml:520-522`).
- macOS is signed ad hoc only (`electron-builder.yml:129-134`): no Developer
  ID, no notarisation, and "Open Anyway" in System Settings. Because of that,
  macOS cannot install its own updates (`updates.ts` only opens the release
  page there).
- In the public `mbrd-release` repository, none of the nine releases listed
  carries a macOS or Linux file. v0.634.0, v0.600.0, v0.550.0 and the rest
  each hold only `mbrd-Windows-*.exe` and `mbrd-android-*.apk`. Verified with
  `gh api .../releases`.
- There is a leftover draft, `v0.448.0`, with one asset.

**Why it matters.** Two of the four systems the release notes and
`electron-builder.yml` describe have never been in anybody's hands. A 1.0 that
names macOS and Linux would be their first release, without the hand checks
`todo-2026-09-14.md` still owes (R28, L31, "The macOS accelerator check").

**Fix.** Either buy the two certificates, already listed under "Needs the
maintainer", and run `save.bat release all` at least once before 1.0. Or state
that 1.0 covers the web, Windows and Android, and that macOS and Linux are
previews. Delete the stray draft.

### B5. On the web, nobody is told that the browser is the only copy. Effort M.

**What.** On the web, `storage/idb.ts` is "crash recovery only. The durable
artefact is always the .mbrd the user saved" (`architecture.md:1667-1670`).
But a new user's work goes into exactly that cache, and nothing pushes them
towards the durable copy:

- `navigator.storage.persist()` is asked only on the first explicit Save
  (`storage/storage.ts:145-161`). A user who relies on the autosave, which the
  README says "loses nothing" (`README.md:86-87`), is never asked for durable
  storage.
- Safari deletes all script-writable storage, IndexedDB included, after seven
  days of Safari use without a visit to the site. A Home Screen web app keeps
  its own count. `browser-support.md:125-128` mentions only "eviction under
  pressure". Verified in the docs. The 7-day rule is WebKit policy (sources
  below).
- No code reminds anyone that a board was never exported. A grep for
  `backup|remind|lastExport` in `web/assets/js` finds nothing.
- The one honest readout, `Is my work safe?`, sits inside the Debug fold
  (`settings-schema.ts:1260`, `:1316`).
- One failed IndexedDB write turns the autosave off for the rest of the
  session (`storage/session.ts:335-343`, `cacheOk = false`). A transient error
  is treated like a full disk: there is one toast and no retry.
- **Inferred, worth a test.** Every tab writes the same `kv` key, `'session'`
  (`session.ts:91`), and each snapshot deletes every stored asset its own board
  does not name (`session.ts:319-321`). Nothing coordinates tabs: there is no
  `BroadcastChannel` and no `navigator.locks`. So two tabs holding different
  boards can delete each other's pictures from the store. If the tab that wrote
  last closes before it writes again, the restore comes back with holes. The
  in-memory copy repairs this only while that tab is still open.

**Why it matters.** Losing data is the one thing a 1.0 must not do quietly,
and the web is where most first-time users will try the app.

**Fix.** Ask for `persist()` on the first real edit, not the first Save. Show
the safety state somewhere a user sees it, for example "Not backed up" in the
header until the first export. Nudge an export after N edits or N days. Retry
the autosave with backoff before giving up. Take a Web Lock, or give each
tab's slot its own key, and test the two-tab case. Say what Safari does in
`browser-support.md`.

### B6. The source and licence position is not consistent. Effort S (a decision), M if the source is published.

**What.** `LICENSE` is GPL-3.0-or-later, and the README invites contributions
(`README.md:120`). But the source repository is private. The public release
repository has no LICENSE and no source (`gh api` reports `license: null` and
only `README.md`). The Credits sheet sends readers to
`.github/THIRD-PARTY.md` for the FFmpeg source offer (`index.html:1108-1109`),
and that file sits in the private repository. The GPL FFmpeg source offer and
the LGPL relinking argument for libvips, OCCT, LibRaw and libheif
(`THIRD-PARTY.md:138-221`) are only findable through that same file.

**Why it matters.** As the copyright holder, the maintainer may ship his own
code without publishing it. The third-party GPL and LGPL notices are a
different matter: they have to reach the person who downloads the binary, and
right now they point to a 404. Shipping 1.0 while saying "open source" turns
an inconsistency into a false claim.

**Fix.** Publish the source, or at least a source tarball attached to each
release, plus LICENSE and THIRD-PARTY.md in `mbrd-release`. Or drop "open
source" and "contributions welcome" and ship the notices inside the apps, for
example in a Licences fold in the Credits sheet. Either way, add mbrd's own
version, licence and source link to the About sheet. Today it has none of the
three.

### B7. Image and PDF export do not look like the board. Effort L.

**What.** `research/export-from-dom-2026-09-21.md` is still open. Its table
(`:15-25`) lists ten card kinds whose export differs from the screen. In the
export, a picture loses its mat and caption, notes are set in the wrong face,
a link is drawn as "example.com COM", swatches lose their card, and audio and
archives become generic name cards.

**Why it matters.** For a moodboard, the PNG or PDF sent to a client or a
teacher is the deliverable. On the desktop and Android apps it is the only way
to share besides the raw `.mbrd`, because neither app has Drive (B8).
Milanote, Miro, FigJam and Freeform all export what the board shows.

**Fix.** Build that plan, or for 1.0 at least bring the five most common
painters (picture, note, link, swatch, text) in line with the stylesheets, and
add a golden-image check to the by-eye list.

### B8. Drive is web-only, and its Google project state is unknown. Effort S in code, with a wait for Google.

**What.** `storage/cloud/config.ts:26-34` ships `GOOGLE_DESKTOP_CLIENT_ID = ''`
and `GOOGLE_ANDROID_CLIENT = false`, so the apps have no Drive rows at all.
That is G28 in the todo. Nothing in the repository records whether the web
client's OAuth consent screen is published to production or still in Testing.
In Testing, Google limits the project to 100 test users, and each grant
expires after seven days. Also stale: `cloud.md:193-196` says
`tests/share.test.js` asserts that neither identifier is filled in, but the
web pair is filled in.

**Why it matters.** "Keep a board in sync" is a headline cloud feature that
works on one of three shells. If the consent screen is still in Testing,
sharing breaks for user 101.

**Fix.** Make the two clients (G28), confirm the consent screen is in
production with a verified brand (`drive.file` needs no security assessment,
as `cloud.md` argues), and correct `cloud.md`. Or say in the app and on the
download page that sync is web-only in 1.0.

---

## Should-have for 1.0

- **Recovery from a renderer crash.** Verified: `desktop/main.ts` has no
  `render-process-gone` handler, and no Java file implements
  `onRenderProcessGone`. A WebView that runs out of memory on a large board
  takes the whole Android app down, and on the desktop it leaves a blank
  window. Both should reload the page and say what happened. The autosave
  interval is 20 s (`session.ts:93`), so the loss is bounded, but the user
  should not have to work out what happened. M.
- **Board items you can reach from the keyboard.** `canvas/item-dom.ts:481-487`
  gives each card a role and a name, and leaves out "the full
  keyboard-selection model (roving tabindex, arrow navigation)". A keyboard-only
  or screen-reader user can pan, zoom and `Ctrl+A`, but cannot reach one card.
  tldraw moves focus between shapes with Tab and announces the selection
  (source below). This is the "Accessible focus" idea on the todo list. For a
  1.0, it is the one accessibility gap that blocks real use. M.
- **Dark mode and a high-contrast path.** No stylesheet reads
  `prefers-color-scheme`. `forced-colors` and `prefers-contrast` appear only in
  `base.css` and `quality.css`. The todo defers dark mode on the maintainer's
  word, and that is a legitimate call. But PureRef, Eagle, Milanote and every
  design tool the target user keeps open have one, so its absence will be the
  most common complaint. L.
- **Onboarding beyond four ghost cards.** On an empty board `onboarding.ts`
  shows four hint cards: drop, move, formats, whimsy. There is no sample
  board, no template, and no help page. `Help > Take the Tour`
  (`desktop/menu.ts:120`) runs the *board's own* tour (`commands/view.ts:138`).
  On a board without one, it opens the tour editor (`ui/tour.ts:108-110`),
  which is not what a Help menu promises. Milanote and Miro open on templates.
  Fix: one bundled example board, offered from the empty state, and rename the
  menu row or give it a real app tour. M.
- **A web "Report a problem".** The desktop has one, plus `Show Logs`
  (`desktop/menu.ts:133-134`). The web, which has the most users, has only the
  issues link at the foot of the privacy page. A "copy diagnostics" button,
  which puts the version, the browser, `storageReport()` and the last errors
  from `errors.ts` on the clipboard, keeps the no-telemetry promise and makes
  reports possible. S.
- **Rolling backups on the desktop and Android.** There the board file is the
  only copy (`architecture.md:1711-1720`). `desktop/atomic.mts` makes each
  write all-or-nothing, which is good, but a bad write that succeeds, or a
  build that loads and re-saves wrongly, has nothing to fall back on. Keep the
  last N versions in `.trash/` or a `.versions/` folder. M.
- **Golden `.mbrd` fixtures and fuzzing.** Already an idea on the todo list.
  For 1.0 it matters more: once the format promises compatibility, a test needs
  a board from v0.2xx, v0.4xx and the release in hand. `tests/` has 205 test
  files and no fixture files. M.
- **The 1.0 version mechanism has never run.** `RELEASE_COMMITS` (`version.js:6`)
  and `RELEASES` (`save.bat:209`) are two hand-synced lists, both empty.
  `versionLabel()` is used and tested nowhere (a grep of `tests/`, the app,
  `desktop/` and `mobile/tools` finds nothing). After the crown the app will say
  `1.05` while the release files say `1.5.0` (`desktop/scripts/version.mjs:12-17`).
  Crowning also means editing `version.js`, which CLAUDE.md lists under "never
  hand-edit". Write the crown as a `save.bat` verb, test `versionLabel()`, and
  decide whether minor numbers that count commits are what 1.x means. S.
- **The changelog lags the version.** The newest group in `patch-notes.md`
  ends at 0.599 (`:166`), and `VERSION` is 0.635. The LaTeX editor, the S
  palette and the web auto-update are not on `/patch`. The prose is the
  author's to write, and 1.0 needs it, plus a "what 1.0 means" page. S.
- **Android store readiness, if a store is in scope.**
  `AndroidManifest.xml:84` (`MANAGE_EXTERNAL_STORAGE`) and `:88`
  (`REQUEST_INSTALL_PACKAGES`) are both refused by Play for this kind of app,
  as the comments there say. `minifyEnabled false` (`build.gradle:48`). The
  Capacitor template's `ExampleInstrumentedTest.java` is still in the tree.
  `allowBackup="true"` has no backup rules, so Android's cloud backup decides
  what it copies of the WebView's store. The first screen a fresh install
  shows is the one the todo calls ugly. If 1.0 is sideload-only, say so on the
  download page. M.
- **The owed hand checks, as one release checklist.** `todo-2026-09-14.md`
  "Checks still owed" and "Needs the maintainer" hold about twenty by-eye and
  on-device checks. Some, like the update install from the title bar (M9/R3)
  and the first `.deb`, test exactly what a 1.0 release exercises. M.
- **Scale.** The level-of-detail proxy and the memory budget wait on an iPhone
  reading that nobody has taken. The built-in benchmark has not run on a phone
  (`bench-2026-09-23.md` status). Before 1.0 says "boards of any size", take
  one reading on a mid-range phone with a 300-picture board. S to measure.
- **Non-Latin text.** Every bundled face is subset to Latin and Latin Extended
  (`THIRD-PARTY.md:257-263`). Cyrillic, Greek and CJK notes fall back to a
  system font, which breaks the look on exactly the boards a Serbian-speaking
  maintainer's friends will make. Adding a Cyrillic subset of Geist or
  Fraunces is S.

## Nice-to-have, post-1.0

- **Localisation.** Verified: every string is inline English. British
  spelling is a rule (`patch-notes.md:136`), `lang="en"`, and there is no
  message catalogue. Excalidraw and tldraw ship many languages. This is large,
  and shipping 1.0 in English only is fine if the store pages say so. L.
- **Drawing tools.** The `cmds` table has notes, swatches, stickers, links,
  fences and connections. It has no freehand pen, no shapes and no standalone
  text. Freeform, FigJam, Miro, Excalidraw and tldraw treat these as basic.
  PureRef and Eagle do not. Decide which family mbrd is. If it is "PureRef
  with more", leave them out and say so. If it is "Milanote", a pen and a
  heading tool are expected. M to L.
- **PureRef-style desktop tricks.** Always on top, opacity over the window,
  click-through to trace, and flip or greyscale per image. Nothing like this is
  in `desktop/main.ts`. It is cheap in Electron and is PureRef's whole appeal
  to artists. S to M.
- **Moving in from other tools.** There is no reader for PureRef `.pur`, a
  Milanote export, a Miro export, or JSON Canvas (Obsidian's open format). This
  matters more now that the Markdown reader handles Obsidian syntax
  (`ui/markdown.ts:2`). JSON Canvas import and export is the cheap one. M.
- **A web clipper.** Milanote and Eagle both have a browser extension that
  saves images from the page you are on. mbrd's equivalent is drag and drop. M.
- **Boards inside boards.** Milanote nests boards. Here a board can only be
  merged into another. M.
- **Collaboration.** A share link gives the recipient a copy, by design
  (`cloud.md`, "What the recipient gets"). Sync has no merge and asks the user
  on every conflict (`cloud.md`, "What it is not"). There are no comments and
  no read-only link. That is a defensible scope for a local-first 1.0, and it
  needs saying on the site, because every competitor in the table below leads
  with live collaboration. A second provider (OneDrive) is already on the todo.
- **Housekeeping.**
  - `desktop/favicon-cors.mjs` and `desktop/batch-probe.mjs` are tracked
    scratch probes with no module header, against the convention in CLAUDE.md.
  - `window.mbrd` and the Debug fold ship to everyone. Both are deliberate, so
    move `Is my work safe?` out of that fold (B5).
  - The `Current` list in `research/README.md` names four documents. The top
    level holds nine, `qol-2026-10-02.md` among them, and that one is built and
    due for `old/`.
  - The hidden cleaning mode is about 9,500 lines under `ui/clean/`, the
    largest single feature in the tree. It is a maintenance cost to weigh
    before 1.0 freezes the surface, not a defect.

## What is already strong

- **Tests.** 3,034 tests run with no install and in 12 seconds. Guards
  enforce the structure: layering, import-time DOM access, the CSS order, icon
  and element ids, CSP hashes, the SHELL list, the release file names.
- **Security.** The CSP has no `unsafe-inline` and no `unsafe-eval`. Wasm is
  quarantined to workers that are exempted one by one (`web/_headers`).
  Foreign documents are built with `createElement` only, and SVG passes an
  allow-list. Every hand-written parser checks bounds before it allocates. The
  distinction between `Oversize` and `Error` keeps "too big" from becoming
  "corrupt". The bridges check paths on the native side.
- **Format.** There is a written spec (`mbrd-format.md`) with a `version` and
  a `requires` field, rules for additive change, and a renamed-ZIP container
  any user can open.
- **Saves.** Writes are atomic and flushed on the desktop. A snapshot is
  written assets first, so a failure leaves the old snapshot whole. Sync
  writes `board.json` last, detects conflicts against Drive's own clock, and
  never deletes on stop.
- **Updates.** Each download is checked against GitHub's SHA-256 digest, and a
  release with no digest never installs. The draft release keeps every system
  on one version at a time.
- **Licences.** Third-party licences are documented with care (THIRD-PARTY.md),
  and font licences are test-enforced.
- **Clean code.** There is no `TODO`, `FIXME` or `@ts-nocheck` anywhere in the
  app.
- **Reach.** The app accepts a remarkable range of file types (RAW, HEIC,
  TIFF, STEP/IGES, PDF, archives, LaTeX, Obsidian Markdown), works offline, and
  honours reduced motion (`prefers-reduced-motion` in 9 stylesheets and 10
  modules).

## Competitor table stakes

| Expected by users of... | Feature | mbrd today |
| --- | --- | --- |
| all | Infinite canvas, drag in images, notes, links | yes |
| PureRef, Eagle | Many image formats, crop, flip, opacity | formats far beyond them; crop and turn in the darkroom; Low opacity on notes only |
| PureRef | Always on top, click-through overlay | no |
| Milanote, Miro, Freeform | Templates and a sample board | no (four hint cards) |
| Milanote, Eagle | Browser web clipper | no |
| Milanote | Boards inside boards | no |
| Freeform, FigJam, Excalidraw, tldraw | Pen, shapes, text tool | no (notes and connections only) |
| all | Export PNG and PDF that matches the board | exports, but they differ from the board (B7) |
| Excalidraw | Export SVG and an open JSON format | `.mbrd` is an open ZIP; no SVG |
| Miro, FigJam, Freeform, Milanote, Kosmik | Live collaboration, comments | no; a copy by link, and one-user sync with a conflict prompt |
| Freeform, Milanote | Sync on every device | web only (B8) |
| tldraw | Keyboard navigation between shapes, screen-reader announcements | names only, no focus (should-have) |
| Excalidraw, tldraw | Many interface languages | English only |
| PureRef, Eagle, Miro | Dark theme | no |
| Eagle, Kosmik | Tagging and search | tags, tag filter, Find, S palette; no auto-tagging |
| all native apps | Signed installers | unsigned (B4) |

## Sources consulted

- PureRef handbook, features: https://www.pureref.com/handbook/features/ and https://pureref.com/handbook/2.0/features/
- Milanote product page: https://milanote.com/product/online-whiteboard ; GetApp overview: https://www.getapp.com/collaboration-software/a/milanote/ ; review: https://mindmappingsoftwareblog.com/milanote-review/
- Eagle: https://eagle.cool/support/get-started ; https://docs-en.eagle.cool/article/584-tricks-you-must-know ; https://alternativeto.net/software/eagle-cool/about
- tldraw accessibility: https://tldraw.dev/sdk-features/accessibility
- Excalidraw overviews: https://www.hackdesign.org/toolkit/excalidraw/ ; https://dev.to/diflowrin/excalidraw-open-source-hand-drawn-diagram-tool-2hn2
- Kosmik: https://techcrunch.com/2023/12/21/meet-kosmik-a-visual-canvas-with-an-in-built-pdf-reader-and-a-web-browser
- Apple Freeform launch: https://www.apple.com/uk/newsroom/2022/12/apple-launches-freeform-a-powerful-new-app-designed-for-creative-collaboration
- Safari's 7-day storage cap: https://searchengineland.com/what-safaris-7-day-cap-on-script-writeable-storage-means-for-pwa-developers-332519 ; https://mjtsai.com/blog/?p=28475 ; https://bugs.webkit.org/show_bug.cgi?id=237350
- Google OAuth publishing status and test-user limits: https://support.google.com/cloud/answer/15549945 ; https://developers.google.com/identity/protocols/oauth2/production-readiness/overview
