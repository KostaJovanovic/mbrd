---
paths:
  - ".github/workflows/**"
  - "save.bat"
  - "desktop/updates.ts"
  - "desktop/electron-builder.yml"
  - "**/MbrdUpdate.java"
---

# Releases

Moved out of the root `CLAUDE.md`, which keeps the rules that a release is the
maintainer's and that a release file's name is a contract. This file is the
mechanics.

**A release is `save.bat release` (option 3 in its menu), and nothing else.**
After the push it runs `gh workflow run release.yml`, and
`.github/workflows/release.yml` builds and publishes into this repository's own
releases, which `Get the app` and the updaters read, so **this repository has
to be public**, or GitHub answers its releases with a 404 to anybody signed out.
Copies installed before the move read `KostaJovanovic/mbrd-release`, which the
workflow mirrors each release to while the `RELEASES_TOKEN` secret is set. A
plain push starts nothing. There is no update file in a release: the apps
read GitHub's API and find their file by the part of its name before the version
(`desktop/updates.ts`, `MbrdUpdate.java`), so **a release file's name is a
contract**, which `tests/desktop-package.test.js` holds. The secrets the workflow
reads are the maintainer's.

**Which systems that builds is the whole cost of a release.** Option 3 and
`save.bat release` build **Windows and Android**; option 7 and `save.bat
release all` add macOS and Linux. A macOS minute bills at ten times a Linux
one, so the two absent systems cost more than the two present. The short run
starts no macOS or Linux runner at all (the `systems` input shortens the
matrix rather than skipping jobs), and its release carries two files and says
so in its notes. A macOS or Linux copy then sees a version it cannot download
until the next full release, which updates it straight there; nothing is
stranded, because the updaters store a check time and never a version
(`desktop/updates.ts`). The workflow's own default is `all`, disagreeing with
`save.bat`'s on purpose: it is reached only by a hand-started run from the
Actions tab, where an incomplete release costs more than minutes.

**Nothing in a release goes through Actions artifact storage.** Each build job
uploads its file straight into a **draft** release that the version job opened,
and publish flips the draft visible once every expected name is in it. The
draft is what keeps the all-at-once rule: GitHub's latest-release endpoint,
which every updater reads, excludes drafts. Storage is 0.5 GB on this account
and one release set is about 1.3 GB, so the old collect-then-publish shape
could never fit: it filled, every upload was refused, and the cleanup step sat
in the job that a failed upload skips. **Do not reintroduce
`actions/upload-artifact` for the apps.**
