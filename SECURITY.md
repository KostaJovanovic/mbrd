# Security policy

## What there is to attack

mbrd has no server, no account, no telemetry and no runtime dependencies. A
board never leaves the machine unless its owner exports it. So the usual web
surface — auth, sessions, injection into a backend — does not exist here.

What does exist is **parsing bytes from files the app did not write**. That is
most of the codebase's cleverness and all of its risk:

| module | parses |
| --- | --- |
| `storage/zip.js` | the ZIP container a `.mbrd` really is, including its own inflate path |
| `storage/mbrd.js` | `manifest.json`, `board.json` and the sidecars inside it |
| `mesh.js` | STL, OBJ and GLB by hand |
| `import/artwork.js` | ID3v2 frames, MP4 atoms, FLAC metadata blocks |
| `optimize/opus.js` | writes an Ogg container by hand around WebCodecs packets |
| `ui/fonts.js` | a dropped `.woff2`, whose family name is **rebuilt** from the filename because it lands inside a CSS declaration |

A `.mbrd` is a file people send each other. Opening one someone else made is the
threat model.

## In scope

- Path traversal or zip-slip in the `.mbrd` reader — an entry that escapes the
  archive, or a hash-named asset that is not where it claims to be.
- A crafted file that crashes the tab, hangs it, or allocates without bound.
  `import/budget.js` is the memory boundary and is meant to hold; a way past it
  is a finding. (One 50 KB PNG can declare 30000×30000 and cost gigabytes at
  `createImageBitmap()` — that is the shape of this class.)
- Script or CSS injection from file content or metadata: a note, an ID3 tag, a
  filename, an embedded font's family name, or anything reaching
  `settings.appearance.vars`, which is filtered through the `TOKENS` allowlist
  in `ui/look.js` precisely because it is the only part of a board that reaches
  the browser as code.
- A board that can cause a network request. Three modules may reach outside and
  only on an explicit user action — `canvas/embed.js`, `ui/fonts.js`,
  `optimize/media.js`. Anything that makes a *fourth*, or makes one of those
  three fire without being asked, is a finding: opening a board should tell
  nobody.
- Service-worker cache poisoning, or a way for one origin's board data to be
  read by another app on the same host.

## Out of scope

- Anything requiring the attacker to already have local access to the machine,
  the browser profile, or the IndexedDB store.
- The development server (`serve.py`). It binds `0.0.0.0` so a phone on the same
  Wi-Fi can be used for testing; that is deliberate and documented. Do not run it
  on an untrusted network, and do not use it to serve anything publicly.
- Denial of service by simply importing a very large legitimate file. The
  500-file cap in `import/drop.js` is a UX guard, not a security boundary.
- Third-party embeds behaving badly once a user has clicked to load one. Loading
  an embed tells YouTube or Spotify what is on that card; that is why it takes a
  click, and it is stated in the UI.

## Reporting

Please **do not open a public issue**.

Use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability), which is the preferred route.

Include the file or board that reproduces it if you can — a `.mbrd`, or the
crafted asset on its own — plus browser and version. A proof of concept that
crashes a tab is a perfectly good report; it does not need to be weaponised.

Expect an acknowledgement within a week. This is a small project maintained by
one person, so a fix may take longer than that, but you will be told where it
stands. Credit in the release notes is offered by default and declined on
request.

## Supported versions

The tip of `main` is what is supported. Versions are stamped per commit
(`0.<commit count>`); there are no maintenance branches, and the fix for
anything reported here will land on `main` and ship in the next commit.
