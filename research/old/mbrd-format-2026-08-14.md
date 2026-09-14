# Finishing the `.mbrd` format before anybody has one

Open work. Written 2026-08-14, after an audit of the container against
[`docs/mbrd-format.md`](docs/mbrd-format.md) and against `.3mf`, which is the
same bet — ZIP, renamed, one primary document, embedded resources, published
spec — made by a committee with a decade of implementations behind it.

**This document was twice as long a draft ago, and the trimming is the point.**
The audit produced a list of nine things; most of them turned out to be
infrastructure for people who do not exist yet — a JSON Schema, a generated
sample-file suite, freedesktop packaging, an IANA registration, a board
identity with no reader in the app. All of that is real work with real value
*the week somebody starts writing a second implementation*, and none of it
improves the file for the person using mbrd today. It is recorded at the bottom
rather than done.

## The window this work sits in

**Nothing has shipped, so the format is not yet owed compatibility with
anything.** That is the whole reason to do any of this now rather than agree it
would be nice.

Two consequences, stated so they are not re-litigated:

- **`version` stays `1`.** Not bumped for anything here. The format's version 1
  is whatever ships at launch, and until launch there is no older reader to
  protect — a bump now would only mean v1 was a thing nobody ever had.
- **After launch, `manifest.requires` is the mechanism** and this window is
  closed. That field went in during this audit precisely because a gate added
  the day it is first needed is a gate no existing reader checks.

---

## Done

- **`mimetype` as the first entry**, stored, no extra field, so the media type
  sits at a fixed offset 30 bytes in — the ODF and EPUB convention, and the
  thing that lets `file(1)` name a `.mbrd`. It also replaced a false claim: the
  spec said the MIME was written into the archive's header, and nothing was
  writing it anywhere but the Blob's `type`, which does not survive reaching a
  disk. Deliberately not read back — `manifest.format` stays the only answer to
  "what is this", so an archive rezipped in the wrong order still opens.
- **WOFF and WOFF2 stored rather than deflated.** `font/woff2` matched none of
  the media patterns, so every embedded face took a full pass through
  `CompressionStream` to produce a result the writer then discarded for being no
  smaller. TTF and OTF still compress and should — that is the packer's largest
  single win on a board carrying a face.
- **`manifest.requires`**, empty and checked. The reasoning is in the spec.
- **Assets carry a readable name** — `assets/kitchen-window--9f2c…b71e.jpg`. The
  slug is optional and discarded on read, the digest remains the only identity,
  and the label comes from the card's name before the stored filename because
  the two are the same string until somebody deliberately renames a card. The
  slugifier is an allow-list, so a card named `../../etc/passwd` files as
  `etc-passwd` by construction rather than by having thought of it.
- **`thumbnails/` dropped.** Reserved in the first draft, never written by
  anything. A reader cannot depend on a directory nothing writes, and the
  reservation was never what made adding it legal — the compatibility rules
  already say a new top-level directory is free.
- **The spec's file references** now say `.ts`. Five of them, and worth doing by
  hand rather than by substitution: `version.js` and `sw.js` really are `.js`.

One thing was started and abandoned: splitting `versions[].data` out to
`versions/<id>.json`. Approved, then overtaken — the versions feature is being
removed entirely in the timeline's phase 3, where a saved version becomes a
named step. **The argument for the split was right and transfers whole to
`timeline`**, which is the one item still open.

---

## Open: the history stops being a blob inside `board.json`

**Blocked** on phase 3 landing. Not to be started while `board-model.ts` and
`state.ts` are being rewritten under it.

Once versions become named steps, `timeline` is the whole of a board's history
and it inherits both problems the `versions/` split was meant to solve, larger:

- **It is the one part of the archive you cannot open on its own.** A `base`
  snapshot of every item as escaped JSON strings, plus a before-and-after pair
  of escaped JSON per changed item per step, all nested inside the document that
  carries it. Everything else in a `.mbrd` is a file you can read.
- **Its repetitions are out of reach of deflate.** The window is 32KB and a
  board of two hundred items serialises to several times that, so the near-
  identical copies a history is *made of* cannot back-reference each other. This
  was the miscalculation in the old `versions` sizing note — twenty stored copies
  do not compress to roughly one, they compress to roughly twenty.

### The shape

```
timeline/base.json         the board before step 0
timeline/steps.jsonl       one step per line, oldest first
```

`board.json` keeps `timeline: { at, fingerprint }` — the marker and the check —
and the documents move out.

**JSONL for the steps, and it is a deliberate departure.** Everything else here
is indented JSON, but the cap is 20,000 steps and an indented array of twenty
thousand objects is not a thing a person reads; it is a thing that hangs an
editor. One step per line is greppable, diffable and tailable. The format
already has a precedent for hand-laying-out where `JSON.stringify` would produce
something unreadable — waveforms are written sixteen numbers to a line for
exactly this reason — so this is an established rule applied to a longer list.

Splitting does not improve the compression: ZIP deflates each entry
independently, so the entries share nothing either. What it buys is legibility
and `zip -d`.

---

## Not now, and why

Recorded so it is not rediscovered as a good idea every six months. Everything
in this section is worth doing **the week somebody starts a second
implementation**, and worth nothing before it.

- **A conformance suite** — one good `.mbrd` using every feature, plus a handful
  of deliberately broken ones each stating what a correct reader must do
  (refuse the escaping path, refuse the mismatched digest, ignore the truncated
  waveform, round-trip the unknown `type`). Generated by a script and checked by
  a test, the way `patch.html` and `404.html` already are, with a fixed date
  passed to `writeZip()` so the archives are byte-reproducible. This is the
  single most useful thing that could be built *for implementers*, and there are
  none.
- **A JSON Schema for `board.json`**, with a test asserting it accepts
  everything `serializeBoard()` emits. Same audience, same timing. It is also a
  second source of truth against `normalizeBoard()`, which is the function that
  actually decides what a board is, and a test only proves a schema is not too
  strict.
- **`shared-mime-info` XML, a libmagic rule, IANA registration** of
  `application/vnd.mbrd+zip`. The `mimetype` entry above is the precondition and
  is done; the rest is packaging and paperwork for an app with no users. The
  libmagic rule is now derivable from the spec by whoever files it.
- **A board identity** (`manifest.id`, minted at save so that opening a file
  never changes it, preserved through Save As). Decided, and then not built:
  nothing in the app reads it. Merge, autosave collision and lineage are the
  three things that would, and none of them asks yet.
- **Per-asset thumbnails.** The dropped reservation was `thumbnails/<hash>.webp`
  — keyed by content hash, so it was never a file-manager preview of the board;
  it was a small copy of each asset so a card can draw without decoding a
  40-megapixel JPEG. That is a real performance feature and it is not container
  work: it touches import, the renderers and the asset store, and wants its own
  document. Adding the directory back is free when it happens.

## Never

- **Zstd (ZIP method 93).** Info-ZIP, Windows Explorer and macOS Archive Utility
  all fail on it, so it trades promise 2 — rename it to `.zip` and open it with
  anything — for a few percent. `CompressionStream` cannot produce it either, so
  it would mean a WASM encoder in an app with no runtime dependency at all.
- **Encryption**, including as an optional extension. `.3mf` has one; the reason
  not to copy it is that a board nobody can open is worse than a board somebody
  else can, and there is no key story here that does not end in an account.
- **A binary `board.json`.** The waveform arithmetic already settled this at
  small scale: after deflate the saving is a rounding error against the media,
  and the cost is the second promise.
- **Minifying `board.json`.** Indentation is the most compressible thing in the
  file; removing it saves far less than it looks like it should and costs the
  property the file exists to have.
- **External assets** — `asset: { external: { path } }`. Still the open question
  at the foot of the spec, still a maintainer decision, and still explicitly not
  to be built until that decision is made.
