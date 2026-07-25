# The `.mbrd` format

Version 1. Written 2026-07-25, from the code in `web/assets/js/storage/mbrd.js`
and `web/assets/js/storage/zip.js`, which are the only two files that read or
write it.

This document exists because the format has grown two deliberate features —
`notes/` full of real Markdown and `waveforms/` full of readable JSON — that
were designed and were never written down. Both are there because **the archive
is meant to be openable**, and a principle nobody has recorded is a principle
somebody optimises away.

---

## The one-line version

A `.mbrd` is a ZIP file with a different extension. Rename it to `.zip`, open
it with anything, and your work is in there as files you can read.

---

## The promise this format makes

Three things, in the order they matter.

1. **A board is one file.** You can email it, put it on a stick, drop it into a
   chat window. Every byte a board needs to render is inside it — no sidecar
   directory, no asset server, no network. This is why assets are embedded
   rather than linked, and it is the property that costs the most and is worth
   the most.

2. **The archive is legible.** Not "parseable given the source" — legible. Your
   sticky notes are Markdown files with your words in them. The waveform data is
   a list of numbers laid out sixteen to a line. `board.json` and
   `manifest.json` are indented JSON, not minified. If mbrd disappeared
   tomorrow, someone with `unzip` would still have their work.

3. **It opens with no network and no account.** Everything above follows from
   this one. There is nothing in a `.mbrd` that has to be resolved from
   somewhere else.

**Anything that breaks one of these three is a format change, not an
optimisation.** That is the whole reason this file exists.

---

## Layout

```
myboard.mbrd                    ZIP, renamed
├── manifest.json               what this file is
├── board.json                  the board itself
├── assets/<hash>.<ext>         embedded bytes, deduped by content hash
├── notes/<slug>--<id>.md       one sticky note, as Markdown
├── waveforms/<hash>.json       one audio file's measured readings
└── thumbnails/<hash>.webp      reserved; nothing writes these yet
```

Only `manifest.json` and `board.json` are required. A reader that finds neither
of the last three directories is looking at a perfectly valid older board.

### ZIP details

- Deflate or stored. Nothing else is written and nothing else is accepted.
- No ZIP64. A board past 4GB is not a board.
- No encryption, no multi-part archives.
- Entry names are `/`-separated, and the reader validates every one of them
  before it is used (see **Safety** below).
- The MIME type is `application/vnd.mbrd+zip`, written into the archive's
  header. A file is recognised by its `.mbrd` extension *or* that type.

---

## `manifest.json`

```json
{
  "format": "mbrd",
  "version": 1,
  "app": "mbrd v0.21",
  "created": "2026-07-25T10:04:11.882Z",
  "modified": "2026-07-25T18:22:03.117Z",
  "title": "Kitchen"
}
```

| field      | meaning |
| ---------- | ------- |
| `format`   | Always `"mbrd"`. A file whose manifest says otherwise is refused. |
| `version`  | Format version, currently `1`. A **higher** number loads anyway with a console warning — a board from a newer mbrd is more likely to be readable than not, and refusing it outright would lose work that a slightly lossy open would have kept. |
| `app`      | Which build wrote it. Informational; nothing reads it back. |
| `created`  | Preserved across re-saves, so a board keeps its birthday. |
| `modified` | Set on every pack. |
| `title`    | The board's name. Also the filename it was exported under, in practice. |

---

## `board.json`

```json
{
  "title": "Kitchen",
  "view": { "pan": { "x": 0, "y": 0 }, "zoom": 1 },
  "settings": {
    "grid": true, "axes": true, "snap": false, "hud": true,
    "gridStyle": "dots",
    "gridStep": 64,
    "spacing": 32,
    "appearance": { "palette": "papyrus", "vars": { "--accent": "#b4553a" } }
  },
  "arrangement": "spiral",
  "items": [ … ],
  "trash": [ { "at": 1753440000000, "item": { … } } ]
}
```

`view` and `settings` are the board's own state — where you were looking and how
the board was configured — and they travel with it, so opening a board puts you
back where you left it.

`settings.gridStyle` has only ever had one value. It is kept because older
files carry it, which is the compatibility rule at the bottom of this document
working as intended.

`settings.appearance` is the board's own look: a palette name and a bag of CSS
custom properties. **`vars` is the only part of a `.mbrd` that reaches the
browser as code**, and it is gated accordingly — see **Safety**.

Item coordinates and sizes are rounded to two decimals on the way out. A board
is a place things sit, not a measurement, and the third decimal of a drag is
noise that costs bytes in every item.

`trash` is the bin, and its items carry their assets. That is deliberate: a bin
that cannot restore anything after a save is not a bin.

### An item

```json
{
  "id": "k3f9a2",
  "type": "image",
  "x": 120, "y": -40,
  "w": 320, "h": 240,
  "rot": 0,
  "z": 7,
  "name": "kitchen-window.jpg",
  "asset": { "hash": "9f2c…", "embedded": true },
  "meta": { }
}
```

| field  | meaning |
| ------ | ------- |
| `id`   | Unique within the board. `[A-Za-z0-9_-]{1,64}`. |
| `type` | `image`, `video`, `audio`, `text`, `note`, `link`, `model`, `generic`. |
| `x`, `y` | The item's **centre**, in world units. **`y` points up** — this is the one convention that surprises people, and it is why the renderer lays items out at `-y`. |
| `w`, `h` | Size in world units. Bounded to 48…20000 (`geometry.js`). |
| `rot`  | Degrees, anticlockwise-positive. Nothing sets it yet; every geometry helper already respects it. |
| `z`    | Stacking order. Higher is nearer. |
| `name` | The label on the card. Editable, and independent of the filename. |
| `asset`| `{ hash, embedded: true }`, or `null` for items that are only text. |
| `meta` | Per-type extras. See below. |

**`asset.external`** — `{ external: { path } }` is reserved for a
link-instead-of-embed setting that does not exist. Unpack tolerates it; pack has
no bytes to write for such an item. **If it is ever implemented it breaks
promise 1 above,** and that is the open question at the bottom of this document.

### `meta`, by type

| key | on | what |
| --- | -- | ---- |
| `text`   | `note` | The note's whole text. First line is its title. Capped at 512 characters (`NOTE_MAX`). |
| `url`    | `link` | The address. **Revalidated on every render**, never trusted from the file. |
| `peaks`  | `audio` | RMS readings in [0, 1]. Moved out to `waveforms/` when packing — see below. |
| `cover`  | any | An asset hash for a chosen picture: album art, a diagram. |
| `presnap`| any | Where the item was before snap-to-grid moved it, so turning snapping off can put it back. `{ x, y, w, h }`. |

Unknown `meta` keys are carried through untouched. That is the extension point:
a future version can add one without older readers losing it.

---

## `assets/<hash>.<ext>`

The bytes, named by the SHA-256 of themselves. Two identical photographs
dropped twice are one entry.

- `<hash>` is 64 lowercase hex characters. Enforced in both directions.
- `<ext>` is `[a-z0-9]{1,12}`, taken from the original filename, and used only
  to rebuild the MIME type on the way back in — ZIP entries carry no content
  type of their own.
- Only hashes still referenced by a live item or a binned one are written, so
  deleting things and saving actually shrinks the file.
- **A referenced hash with no bytes fails the export.** It used to warn and
  carry on, which produced a `.mbrd` with a hole in it while telling the user
  their work was safe.

---

## `notes/<slug>--<id>.md`

Each sticky note, again, as Markdown:

```markdown
# buy the smaller one

the big one does not fit under the shelf
```

First line becomes an `# ` heading, the rest is the body.

- `<slug>` is the first line, lowercased and hyphenated, capped at 48
  characters — for you.
- `<id>` is the item id — for the reader, which is how a file is matched back
  to its note.
- Separated by **two** dashes, which appear nowhere else in either half.
- **The `.md` outranks `board.json`.** Edit one of these files by hand, rezip,
  and the board opens with your edit. That is the point of writing them.
- A note whose id is not filename-safe simply does not get a `.md`. Its text is
  still in `board.json`; nothing is lost but the convenience copy.

---

## `waveforms/<hash>.json`

An audio file's measured readings, so the card can draw its bars without
decoding several megabytes again.

```json
{
  "res": 240,
  "peaks": [
    0.021, 0.184, 0.402, 0.377, 0.298, 0.51, 0.663, 0.44, …
  ]
}
```

`res` is the number of readings, and it must equal `peaks.length` — a file
where they disagree has been truncated and is ignored.

- Keyed by the **hash of the audio**, not the id of the card — a waveform is a
  property of a recording, so the same clip on the board twice is measured once.
- Written sixteen numbers to a line, so the file is something a person can actually read.
- When a sidecar is written, `meta.peaks` is **removed** from `board.json`.
  Storing it twice would be the same bytes for nothing and two places to
  disagree.
- The sidecar outranks `board.json` where there is one; `board.json` still works
  where there is not (an older board); and a truncated or hand-mangled file is
  **ignored, not fatal** — the card falls back to measuring the audio again.

JSON rather than packed binary, and the size argument does not survive contact
with deflate: 16-bit samples would be 512 bytes against 1858 of text, but after
compression that is 426 against 582. A 156-byte saving per audio file, beside
the megabytes of audio it was measured from, is not worth making the archive
unreadable.

---

## Safety

A `.mbrd` is a file that arrives from somewhere else, and the reader treats it
that way.

- **Entry names are validated before use.** A board claiming an asset hash of
  `../escape` used to pack back out as `assets/../escape.bin` — harmless here,
  which never writes the archive to disk, and a directory traversal in any
  extractor that does.
- **ZIP bomb limits** on archive size, entry count, individual and total
  uncompressed size, and compression ratio. Enforced before inflation where the
  metadata allows it, and against the actual inflated total where it does not.
- **CRC32 is checked** on every entry, stored and deflated alike.
- **Truncated data and duplicate paths are refused**, not silently accepted.
- **`meta.url` is revalidated on every render**, against a scheme allowlist of
  exactly `http:` and `https:`. A hand-edited board cannot produce a clickable
  `javascript:` payload.
- **`look.vars` is the only part of a board that reaches the browser as code**,
  and it is gated by a token allowlist plus a value pattern and a function
  allowlist (`ui/look.js`).
- **`meta.presnap` is checked before it is written onto an item's geometry** —
  four finite numbers with a size inside the legal range, or the memo is
  dropped.

---

## Compatibility rules

For anyone changing this format later:

- **Adding a `meta` key is free.** Older readers carry it through.
- **Adding a top-level directory is free.** Older readers ignore what they do
  not recognise. `thumbnails/` is already reserved this way.
- **Adding a `board.json` field is free**, as long as its absence has a sane
  default.
- **Renaming or repurposing anything is a version bump.** `version` exists for
  exactly this and nothing has yet needed it.
- **Removing a fallback is the dangerous change.** The two "sidecar outranks
  `board.json`, `board.json` still works" rules are what let an old board open
  in a new mbrd. Deleting either half silently breaks files that already exist.

---

## The open question

**Should assets ever be allowed to live outside the file?**

The schema already reserves `asset: { external: { path } }` for it, and there is
a real case: a board of 4K video is gigabytes, and every save rewrites all of
it.

Against it, plainly: **it ends promise 1.** A board stops being one thing you
can send someone. It becomes a file plus a directory, and the failure mode is
the worst kind — the board opens, looks fine, and three photographs are grey
boxes because they were on the other machine.

Three ways it could go, and the differences are not small:

1. **Never.** Large boards are large. The format stays a format you can email,
   and "optimize board" (roadmap item 23) is the answer to size.
2. **Per-item, opt-in, and loudly.** An externally-referenced item is marked on
   the board, and export warns. Keeps the promise as a default rather than a
   guarantee.
3. **A second file type.** `.mbrd` stays self-contained by definition; a
   `.mbrdlink` or a project directory is a different thing with different rules,
   and nobody is ever surprised by which one they have.

Option 3 is the only one that keeps promise 1 true rather than usually true.
Option 1 is the only one that needs no code. **This is Kosta's call and nothing
should be built for it until it is made.**
