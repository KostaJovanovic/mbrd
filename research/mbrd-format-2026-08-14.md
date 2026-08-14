# Finishing the `.mbrd` format before anybody has one

Open work. Written 2026-08-14, after an audit of the container against
[`docs/mbrd-format.md`](docs/mbrd-format.md) and against `.3mf`, which is the
same bet — ZIP, renamed, one primary document, embedded resources, published
spec — made by a committee with a decade of implementations behind it.

Three things came out of that audit and are already done. Six are left, and this
is the order to do them in and the reasoning for each.

## The window this work sits in

**Nothing has shipped, so the format is not yet owed compatibility with
anything.** That is the whole reason to do this now rather than agree it would
be nice. Every item below is either free today and impossible later, or free
today and merely expensive later.

Two consequences, stated so they are not re-litigated halfway through:

- **`version` stays `1`.** It is not bumped for anything in this document. The
  format's version 1 is whatever ships at launch, and until launch there is no
  older reader to protect. A bump now would only mean that v1 was a thing nobody
  ever had.
- **After launch, `manifest.requires` is the mechanism** and this window is
  closed. That field went in during this audit precisely because a gate added
  the day it is first needed is a gate no existing reader checks.

## What is already done

Landed in this pass, all three tested:

- **`mimetype` as the first entry**, stored, no extra field, so the media type
  sits at a fixed offset 30 bytes in — the ODF and EPUB convention, and the
  thing that lets `file(1)` name a `.mbrd`. It also replaced a false claim: the
  spec said the MIME was written into the archive's header and nothing was
  writing it anywhere but the Blob's `type`, which does not survive reaching a
  disk.
- **WOFF and WOFF2 stored rather than deflated.** `font/woff2` matched none of
  the media patterns, so every embedded face took a full pass through
  `CompressionStream` to produce a result the writer then discarded for being no
  smaller. TTF and OTF still compress and should — that is the packer's largest
  single win on a board carrying a face.
- **`manifest.requires`**, empty and checked. The reasoning is in the spec.

One thing was started and abandoned: splitting `versions[].data` out to
`versions/<id>.json`. It was approved and then overtaken — the versions feature
is being removed entirely in the timeline's phase 3, where a saved version
becomes a named step. **The argument for the split was right and transfers
whole to `timeline`**, which is item 2 below.

---

## 1. Assets get a readable name

**The single largest remaining hole in promise 2, and the format has already
solved it once.**

Unzip a board today and the pictures are `assets/9f2c4a…b71e.jpg`, forty of
them, named by digest. The promise is that if mbrd disappeared tomorrow somebody
with `unzip` would still have their work — and they would, as a directory of
hex. They could not tell which file was the kitchen window without parsing
`board.json` by hand and matching hashes.

The notes directory does not have this problem, and the spec says why in three
words: `<slug>--<id>.md`, where the slug is **"for you"** and the id is **"for
the reader"**. Assets never got the same treatment, and there is no reason for
that beyond order of implementation.

### The shape

```
assets/kitchen-window--9f2c4a…b71e.jpg
```

- **The hash is still the identity.** The slug is decoration and is discarded on
  read. `sha256(bytes) === hash` is still checked, dedup is still by hash, and
  the "stored twice" refusal still fires when two entries carry the same digest
  under different slugs.
- **The separator is `--`**, the same one the notes use and for the same reason:
  the slug has its own runs collapsed to a single dash, so two in a row appear
  nowhere else in the name.
- **Both forms are legal.** A bare `assets/<hash>.<ext>` reads exactly as it does
  now. This is not a compatibility hedge — it is what a third-party writer
  should be allowed to produce. Computing a slug is a courtesy to a human, and
  requiring it would be requiring every implementation to reproduce this app's
  slug function byte for byte in order to write a file this app will read.

### Where the slug comes from

In order, first non-empty wins:

1. **The asset store's `name`** — the original filename, minus its extension.
   `Asset` already carries it (`storage/assets.ts`), set from `file.name` at
   import, and it is the best answer available: it is what the person called the
   file before mbrd ever saw it.
2. **The referencing item's `name`** — for bytes that arrived without a
   filename, or a cover that is only ever a cover.
3. **The font's `family`**, for the faces, which are the one class of bytes no
   item names.
4. Nothing, in which case the entry is the bare `assets/<hash>.<ext>`.

One hash can be referenced by several items with different names. The slug is
taken from the **first reference in `referenced` order**, which is fixed —
board items, then the bin, then whatever the history contributes — so the
archive is reproducible rather than dependent on iteration order.

### Work

- Extract the slug function out of `noteFile()`, which currently has it inline,
  into a `slugify()` the two callers share. One answer to "what is a slug here",
  not two that drift.
- Build a `hash -> slug` map in `packBoard()` alongside the existing asset walk.
  It needs the same three passes the walk already makes, so it rides along
  rather than adding one.
- `unpackBoard()`: split the entry name on the **last** `--` before the existing
  parse. Everything after is `<hash>.<ext>` and goes through exactly the
  validation it goes through today; everything before is thrown away unread.
- Spec: a paragraph under `assets/`, stating loudly that the slug is optional
  and that a reader must accept both forms.

### Tests

The slug appears and is derived from the filename; the same photograph on the
board twice is still one entry; an asset with no name anywhere is written bare;
an archive of bare-hash entries still opens; two entries carrying one digest
under different slugs are still refused; a name full of punctuation and
non-Latin characters produces a safe slug rather than a path.

### Risk

Low, and contained to `storage/mbrd.ts` and its tests. The slug never becomes an
identity and never reaches a filesystem this app writes to, so the traversal
question the hash rule exists for does not arise a second time — but the
slugifier's character class is what guarantees that, and it should be written as
an allow-list for the same reason the SVG walk in `ui/documents.ts` is.

---

## 2. The history stops being a blob inside `board.json`

**Blocked** on the timeline's phase 3 landing. Not to be started while
`board-model.ts` and `state.ts` are being rewritten under it — see *Sequencing*
below.

Once versions become named steps, `timeline` is the whole of a board's history,
and it inherits both problems the `versions/` split was meant to solve, larger:

- **It is the one part of the archive you cannot open on its own.** A `base`
  snapshot of every item as escaped JSON strings, plus a before-and-after pair
  of escaped JSON per changed item per step, all nested inside the document that
  carries it. Everything else in a `.mbrd` is a file you can read. This is a
  document escaped inside another document.
- **Its repetitions are out of reach of deflate.** The window is 32KB and a
  board of two hundred items serialises to several times that, so the near-
  identical copies a history is *made of* cannot back-reference each other. This
  was the miscalculation in the `versions` sizing note — twenty stored copies do
  not compress to roughly one, they compress to roughly twenty — and a step
  ledger is the same shape.

### The shape

```
timeline/base.json         the board before step 0
timeline/steps.jsonl       one step per line, oldest first
```

`board.json` keeps `timeline: { at, fingerprint }` — the marker and the check —
and the documents move out.

**JSONL for the steps, and it is a deliberate departure.** Everything else here
is indented JSON, but the cap is 20,000 steps and an indented array of twenty
thousand objects is not a thing a person reads; it is a thing that makes an
editor hang. One step per line is greppable, diffable, tailable, and streamable.
The format already has a precedent for hand-laying-out where `JSON.stringify`
would produce something unreadable — the waveform sidecars are written sixteen
numbers to a line for exactly this reason — so this is the established rule
applied to a longer list, not a new one.

### Work

`timelineHashes()` reads from the new location; `serializeTimeline()` and
`adoptTimeline()` split their output and input across the index and the two
files; the fingerprint check is unchanged and still the thing that decides
whether a history describes the board it arrived with. A missing or unparseable
`steps.jsonl` marks the timeline stale rather than failing the load, which is
what that machinery already does.

Splitting does not improve the compression — ZIP deflates each entry
independently, so the entries share nothing either — and the plan should not
claim it does. What it buys is legibility and `zip -d`.

---

## 3. Decide `thumbnails/`

**The reservation has outlived its explanation and should be resolved either
way.** A directory reserved and empty since version 1 is a promise the format is
not keeping.

Worth noticing what the reserved path actually says: `thumbnails/<hash>.webp`,
keyed by **content hash, not by board**. So the thing reserved was never a
preview of the board for a file manager — it was a small copy of each *asset*,
so a card can draw without decoding a 40-megapixel JPEG. That is a performance
feature, and a real one on photo-heavy boards.

Three ways to close it:

1. **Implement it as reserved** — per-asset thumbnails, generated at import,
   written beside the originals, used by the renderers when the card is small.
   Genuinely useful, and the largest piece of work in this document: it touches
   import, the renderers and the asset store, not just the container. It should
   be its own piece of work with its own document, not a bullet in this one.
2. **Repurpose it as a board preview** — `thumbnails/board.webp`, one render of
   the whole board, which is what would make a `.mbrd` show a picture in a file
   manager and is the better story for "email someone a board". But the board is
   DOM, not canvas, and there is no cheap render of it; doing this properly
   means reimplementing the renderers against a canvas, and doing it improperly
   means shipping a picture that is not what the board looks like. No dependency
   is going to be added for it.
3. **Drop the reservation** and say the format has no thumbnails. Costs nothing,
   loses nothing that exists, and stops the spec promising something no reader
   can rely on.

**Recommendation: 3 now, 1 later on its own merits.** Option 1 is worth doing
and is not format work — when it happens it adds a directory, which the
compatibility rules already say is free. Reserving it in the meantime buys
nothing: a reader cannot depend on a directory nothing writes, and the
reservation is not what would make adding it legal.

This needs a maintainer decision before item 4 can be finished, because the
corpus and the spec both have to say one thing or the other.

---

## 4. A conformance corpus

**What turns "the format is free to implement" from a sentence into something
somebody can do in an afternoon.** The spec's own preamble says interoperability
reports are the most useful bug reports this project can get; there is currently
nothing an implementer can check themselves against.

Two halves:

- **One golden `.mbrd`** exercising every feature — every item type, both
  layouts, connections, an audio file with a sidecar, a note with rich blocks, a
  fence, an embedded variable font, a history.
- **A directory of deliberately broken ones**, each with a one-line statement of
  what a conforming reader must do: an entry name climbing out of `assets/`, a
  digest that does not match its bytes, a truncated waveform, a duplicated path,
  a compression bomb, a `requires` naming an unknown feature, an unknown item
  `type` that must survive a round trip untouched.

### Generated, not hand-committed

`tools/gen-corpus.mjs` writes them and a test regenerates and compares — the
same arrangement `web/patch.html` and `web/404.html` already have, and for the
same reason: a committed artifact that nothing regenerates drifts behind the
code it documents. ZIP archives embed timestamps, so the generator passes a
fixed `date` to `writeZip()` and the output is byte-reproducible.

Lives in `research/docs/corpus/` with a `README.md` naming each file and the
required behaviour, because it is part of the specification rather than an
argument about it.

**Depends on 1, 2 and 3 being settled** — a golden file built before the layout
is final is a golden file regenerated twice and cited wrong in between.

### What about a JSON Schema?

Tempting and half a good idea. A schema for `board.json` would help an
implementer enormously, and it is a second source of truth against
`normalizeBoard()`, which is the function that actually decides what a board is.
Worth doing **only** with a test asserting the schema accepts everything
`serializeBoard()` emits — without that it is a document that is wrong within a
quarter. Lower priority than the corpus, which cannot drift because it is
generated.

---

## 5. Make the rest of the world recognise the file

Unlocked by the `mimetype` entry, and almost none of it is code in this
repository.

- **`packaging/mbrd.xml`** — a freedesktop `shared-mime-info` definition, so
  Linux file managers name and icon a `.mbrd` instead of calling it a ZIP.
  Committed here with install instructions; small, self-contained, ours to do.
- **A libmagic rule** — the EPUB rule is the template and now applies to this
  format verbatim, since the media type is at the offset it looks at. Write the
  exact rule into the spec so it can be filed upstream against `file` without
  the filer having to derive it.
- **IANA registration of `application/vnd.mbrd+zip`** — the vendor tree, so a
  form rather than standards-track review. It needs a contact address and a
  published specification URL, and the URL now exists. **This one is the
  maintainer's to file**; nothing in the repository can do it.

---

## 6. The spec's file references predate TypeScript

`docs/mbrd-format.md` opens with "from the code in `web/assets/js/storage/mbrd.js`
and `web/assets/js/storage/zip.js`" and goes on to cite `geometry.js`,
`ui/look.js`, `canvas/viewport.js`, `canvas/audio.js`, `board-schema.js` and
`state.js`. All of those are `.ts` now.

Trivial, and worth doing carefully rather than with a find-and-replace: **`version.js`
and `sw.js` really are `.js`** and must not be rewritten. A blind substitution
would introduce two wrong references while fixing eight.

This matters more than an ordinary stale comment because this is the one
document written for people outside the project, who cannot tell a stale
reference from a real filename.

---

## Sequencing

The constraint that is not about dependencies: **another agent is rewriting
`board-model.ts`, `state.ts` and the versions feature right now.** Item 2 sits
squarely in that work and item 4's golden file depends on its outcome. Nothing
below should be started in those files until that lands.

| order | item | blocked by | files |
| --- | --- | --- | --- |
| 1 | **6** — spec file references | nothing | `docs/mbrd-format.md` |
| 2 | **1** — asset slugs | nothing | `storage/mbrd.ts`, tests, spec |
| 3 | **5** — mime packaging | nothing | `packaging/`, spec |
| 4 | **3** — decide thumbnails | a maintainer decision | spec |
| 5 | **2** — timeline sidecars | phase 3 landing | `timeline.ts`, `storage/mbrd.ts` |
| 6 | **4** — conformance corpus | 1, 2, 3 | `tools/`, `docs/corpus/`, tests |
| — | IANA registration | 5 | outside the repository |

Items 6, 1 and 5 can be done today and in that order without touching anything
the other work is in.

## What is deliberately not here

Recorded so it does not come back as a suggestion every six months.

- **Zstd (ZIP method 93).** Info-ZIP, Windows Explorer and macOS Archive Utility
  all fail on it, so it trades promise 2 — rename it to `.zip` and open it with
  anything — for a few percent. `CompressionStream` cannot produce it either, so
  it would mean a WASM encoder, in an app with no runtime dependency at all.
- **Encryption**, including as an optional extension. `.3mf` has one; the reason
  not to copy it is that a board nobody can open is worse than a board somebody
  else can, and there is no key story here that does not end in an account.
- **A binary `board.json`.** The waveform arithmetic already settled this at
  small scale: after deflate the saving is a rounding error against the media,
  and the cost is the second promise.
- **Minifying `board.json`.** Indentation is the most compressible thing in the
  file; removing it saves far less than it looks like it should, and costs the
  property the file exists to have.
- **External assets** — `asset: { external: { path } }`. Still the open question
  at the foot of the spec, still a maintainer decision, and still explicitly not
  to be built until that decision is made.
