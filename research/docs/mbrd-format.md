# The `.mbrd` format

Version 1. Written 2026-07-25, from the code in `web/assets/js/storage/mbrd.js`
and `web/assets/js/storage/zip.js`, which are the only two files that read or
write it.

> **The format is free to implement.** This specification is published so that
> other software can read and write `.mbrd` files, and no permission, licence or
> attribution is required to do so. The app's GPL covers mbrd's *source*, not
> the format it stores work in — an implementation in any language, under any
> licence, open or closed, is fine and is the point. A file format only one
> program can read is a worse place to keep your work.
>
> If you build one, an issue saying so would be welcome; interoperability
> reports are the most useful bug reports this project can get.

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
| `app`      | Which build wrote it, as `mbrd <version>`. Mostly informational — the one thing that reads it back is the title repair below, which needs to know whether the writer predates v0.51. |
| `created`  | Preserved across re-saves, so a board keeps its birthday. |
| `modified` | Set on every pack. |
| `title`    | The board's name. Also the filename it was exported under, in practice. |

**The title repair.** A board's name and its filename are not the same string:
`fileNameFor()` turns spaces into underscores so the name is safe in a file
picker. Opening a file takes `board.json`'s `title` exactly as it stands —
underscores are legal in a title, so a board named `my_board` stays named
`my_board`. The one exception is a file written **before v0.51**, where a
Save As renamed the board itself to the picker-safe filename: those titles have
their underscores decoded back to spaces, and `app` is how that is told. A file
with no `app` is believed, not repaired. Where no title is stored at all, the
filename supplies one and is decoded the same way.

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
  "mobileHeader": { "font": "", "size": 13, "stretch": 100, "leading": 100, "weight": 700, "offset": 0, "italic": false, "wrap": true, "axes": {} },
  "titleHidden": false,
  "mediaFit": "contain",
  "paletteSources": 12,
  "items": [ … ],
  "layouts": {
    "desktop": [ { "id": "k3f9a2", "x": 120, "y": -40, "w": 320, "h": 240, "rot": 0, "z": 7 } ],
    "mobile":  [ { "id": "k3f9a2", "x": 0, "y": -120, "w": 320, "h": 240, "rot": 0, "z": 7 } ]
  },
  "connections": [ ["k3f9a2", "p81m4x"] ],
  "audioOrder": [ "a91k2c", "a44m7d" ],
  "trash": [ { "at": 1753440000000, "item": { … } } ]
}
```

`view` and `settings` are the board's own state — where you were looking and how
the board was configured — and they travel with it, so opening a board puts you
back where you left it.

`view.zoom` is the raw world-to-screen scale, not the percentage the corner
prints. The two differ by `BASE_ZOOM` in `canvas/viewport.js`: the interface
calls scale 0.8 "100%", so a board left at 100% records `0.8` here. Readers
should treat the number as a scale and not multiply it by a hundred.

`settings.gridStyle` has only ever had one value. It is kept because older
files carry it, which is the compatibility rule at the bottom of this document
working as intended.

`settings.appearance` is the board's own look: a palette name and a bag of CSS
custom properties. **`vars` is the only part of a `.mbrd` that reaches the
browser as code**, and it is gated accordingly — see **Safety**.

`mobileHeader` is the typography of the board's name, shared by the Mobile
masthead and the Desktop title card. It is **board-level** (one style for both
layouts). Files written before it moved here carry it under `settings.mobileHeader`
instead; a reader takes the top-level value first and falls back to that. It is
also mirrored back into `settings.mobileHeader` on save, so an older reader still
finds it. `titleHidden` is `true` only when the Desktop title card has been
deleted; a board without the key seeds the card on open. The card itself is an
ordinary item of `type: "title"` in `items` (a singleton, id `__title__`), with
its own Desktop geometry in `layouts.desktop`; it is never packed onto Mobile.

`mediaFit` is how photos and videos sit in their cards board-wide: `"contain"`
(the default) fits the whole picture in and letterboxes; `"cover"` fills the
card and crops. It is **board-level** (one value for both layouts). A single
image or video can override it with `meta.fit` (`"cover"` / `"contain"`) — an
absent or unrecognised `mediaFit` reads as `"contain"`.

`paletteSources` is how many of the board's pictures the Dynamic palette is read
from, newest first — a whole number clamped to
`[1, 24]`, or **`0` for every picture on the board**, defaulting to `12`.
Board-level, since the palette it feeds is shared across layouts. Absent or
unreadable reads as `12`; a count above 24 reads as `24`.

`0` is the slider's stop past the top rather than a count below its bottom: 24
is the highest number of sources the sampler reads by default, and `0` lifts
that ceiling instead of naming a bigger number. An older reader that clamps this
field to `[1, 24]` will read `0` as `1` and take its colours from the newest
picture alone — a duller palette, not a broken board.

`settings.fonts` is the faces the board carries with it, at most eight, each
`{ "hash", "family" }` — the hash naming bytes in `assets/`, the family becoming
a CSS family name. A record filtered out for a bad hash or an unusable family
name drops on its own; the rest of the list still opens.

Two optional fields describe the same thing at two strengths, and **at most one
of them appears**:

| field | when | what |
| --- | --- | --- |
| `axes` | the file's `fvar` could be read | The variable axes, up to 32, each `{ "tag", "min", "default", "max" }`. `tag` is four characters from `[A-Za-z0-9 ]`; a record whose bounds are not finite or whose `max` is not above its `min` is dropped. |
| `variable` | it could not | `true`, meaning only "this file has an `fvar`". |

The weaker field exists because WOFF2 keeps its table data in one Brotli stream
and browsers ship no decoder for it, so a `.woff2` whose filename does not carry
the conventional `Family[opsz,wght]` bracket group cannot have its axes read
here at all — while its *table directory*, which is not compressed, still says
whether an `fvar` is present. That is enough for a reader to declare a weight
range wide enough to reach the axis rather than pinning the face at 400, and it
is deliberately not enough to draw a slider. A reader that ignores `variable`
loses real weights on those faces and nothing else.

Item coordinates and sizes are rounded to two decimals on the way out. A board
is a place things sit, not a measurement, and the third decimal of a drag is
noise that costs bytes in every item.

`layouts` gives each live item independent Desktop and Mobile geometry and
settings while its content, assets, name, metadata, palette, whimsy, typography,
and custom fonts remain shared. Each geometry record is keyed by `id` and
carries `x`, `y`, `w`, `h`, `rot`, `z`, plus an optional layout-specific
`presnap`. Mobile is a vertical board either 6 or 8 grid spaces wide, selected
by its layout-specific `settings.mobileColumns` value; missing or invalid
values fall back to 6. Its upper edge is `y = 6 × settings.gridStep`; it is at
least 25 grid spaces tall and extends to 15 spaces below its lowest item. Fitted
items occupy rectangular spans in the selected grid, fill rows from left to
right where they fit, and use the grid's normal inset seam widened by the Mobile
profile's own `settings.spacing`, which defaults to `0`. A file with no Mobile
settings record of its own is read at `0` rather than inheriting the top-level
(Desktop) value. The same packing resolves import collisions.

`layouts.mobile.arrangement` names an **order**, not a shape: the column is
always packed the same way, so the arrangement decides only the sequence the
packer meets items in. The values are `fit`, `free`, `date`, `type`, `name` and
`shuffle`; `free`, `date` and `type` are the same ids the Desktop catalogue
uses. Any other value — including the Desktop shapes an older file stored here —
is read as the nearest order (`scatter` → `shuffle`, everything else → `fit`)
and is not rewritten on load. The
Mobile viewport leaves a small gutter outside the side edges and suppresses the
world axes, origin marker, and relationship web. Those are presentation rules,
not saved settings.
The top-level geometry in `items` duplicates Desktop deliberately: older
readers see the Desktop arrangement, and files without `layouts` acquire one
from those fields.

The currently selected layout is not saved. It is a local device preference,
so one file can stay in Mobile mode on a phone and Desktop mode on a computer.

`trash` is the bin, and its items carry their assets. That is deliberate: a bin
that cannot restore anything after a save is not a bin.

### `connections`

Lines somebody drew between two cards, as unordered pairs of item ids. A
connection has two ends and no direction — `["a","b"]` and `["b","a"]` are the
same one, and the second is dropped on the way in.

**Top-level, not inside a layout,** and that is the structural point: a
connection is between *items*, items are shared across Desktop and Mobile, and
only geometry is per-layout. Filing them under a layout would mean a board
connected on a desktop opened unconnected on a phone and then lost the lines the
next time it was saved from one.

Nothing about the path is stored. Where a line runs is a function of where the
two cards are now, worked out at draw time, so there is nothing to invalidate
and nothing to go stale — the same relationship the automatic web this replaced
had with the board. The *shape* of that path answers the whimsy axis, which is a
setting of the app rather than of the board, and is likewise not stored.

**A third element, when there is one, says how the line is drawn.**
`["a","b",{…}]`, and every key in it is optional:

| key | values | default |
| --- | --- | --- |
| `dir` | `"none"`, `"fwd"`, `"back"`, `"both"` | `"none"` |
| `style` | `"solid"`, `"dashed"`, `"dotted"` | `"solid"` |
| `color` | `"line"`, `"accent"`, `"warm"`, `"leaf"`, `"danger"` | `"line"` |
| `weight` | `"fine"`, `"normal"`, `"bold"` | `"normal"` |
| `label` | a string, whitespace collapsed, 60 characters | absent |

`dir` is read against the pair **in the order the file carries it** — `"fwd"`
points the arrow at the second id — which is why that order is preserved even
though the pair is otherwise unordered.

Three properties of this are load-bearing rather than incidental:

- **Defaults are omitted, not written.** A connection at its defaults is a bare
  `["a","b"]`, so an ordinary board's connections are two-element arrays and
  nothing about the common case changed when this was added.
- **Every value is a name, never a value.** A colour is `"leaf"` and not a hex
  triple; what a name looks like is one rule in `canvas.css`. This object comes
  out of a file somebody else wrote, and a string that reached a stroke would be
  a string that reached the CSSOM.
- **Unknown keys and unknown values are dropped, not carried.** A `color` this
  build does not know draws the ordinary grey line rather than nothing, which is
  the right answer to a board written by a newer build.

Additive, so no version bump was owed for it: an older reader ignores the extra
element and draws a plain line between the same two cards.

What is held to, on the way in and on the way out:

- Both ends must name an item the file actually carries, **live or binned**. A
  pair naming a card in the bin is kept, because restoring that card has to
  bring its lines back with it; a pair naming nothing is dropped, since nothing
  could make it mean something again.
- A card joined to itself is not a connection. Dropped.
- Duplicates collapse. Malformed entries — not an array, one id, a non-string —
  are dropped one at a time rather than failing the load.
- At most 2000 (`MAX_CONNECTIONS`). JSON is cheap and every entry costs a route
  to work out and a subpath to draw.

*While the app is running* a connection whose item has been deleted is simply
not drawn, and is deliberately **not** removed — that is what lets delete, undo,
trash and restore work with no bookkeeping at any of them. The pruning above
happens only at the file boundary.

An older reader ignores the key and shows the board without lines — and, unlike
an unknown `type` or an unknown `meta` key, does **not** write it back, because
`board.json` is rebuilt field by field rather than carried through. So a board
saved by a build that predates this loses its connections. That is the one place
the format's forward-compatibility promise does not reach, and it is worth
knowing before adding another top-level key.

`settings.web` — which predates all of this and is still called that, so an
older build reads it and behaves — is the switch for whether they are drawn.

### `audioOrder`

The order the Playlist plays the board's audio in, as a flat list of item ids.
Dragging a track to a new place in the Playlist writes it; a track with no entry
here sorts after the ones that do, in the board's arrangement order.

**Top-level, not inside a layout,** for the same reason as `connections`: it is
an ordering of *items*, which are shared across Desktop and Mobile, so a
per-layout copy would let a playlist re-sorted on a phone come back scrambled on
a laptop.

What is held to, on the way in and out:

- Every id must name an item the file carries, **live or binned** — the same
  union `connections` use, so an order that names a since-thrown-away track
  survives to be restored with it.
- Duplicates and non-string entries are dropped one at a time rather than failing
  the load; the cap is `MAX_ITEMS`.
- The Playlist filters this to the audio it actually has and appends anything new
  in arrangement order, so a list that outlived some of its ids is self-healing
  rather than wrong — the file is not rewritten to prune them until the next save.

Additive with an empty default (`[]`), so it needs no format-version bump: a
board that predates it simply has no saved order and sorts by arrangement, and —
like `connections` — an older reader drops the unknown key rather than carrying
it through.

### Fences

A **fence** is an item of `type: "fence"` — a labelled rectangle, with the cards
inside it belonging to it. Its `name` is the label; it carries no asset and its
`meta` is empty but for the membership key below.

**Membership is not a list, and there is deliberately nothing here that holds
one.** A card is in a fence when its centre falls inside the fence's rectangle,
which is a fact about the geometry the file already carries. So there is no
member array to disagree with the coordinates beside it, and no way for a file to
claim a grouping its own numbers contradict.

`meta.fence` on the *member* is a record of that measurement rather than the
authority for it, kept for two reasons. A pixel of drift across a save must not
lose a grouping somebody plainly made; and membership is measured on **Desktop**
geometry only, so a reader that opens a board straight into the Mobile layout has
nothing to measure and this key is all it has. A reader that ignores the key
entirely still gets the right answer on Desktop, by measuring.

The Desktop-only rule is worth stating plainly for anyone implementing this: on
Mobile a fence is drawn as a full-width band with its members packed *beneath*
it, so no card is geometrically inside its own fence there. Measuring in that
layout would find every fence empty.

Fences nest, and the **smallest** containing fence wins. A fence may only be
contained by one of strictly greater area, which is what makes the containment
chain a strict order.

An older reader that does not know the type shows a fence as a large empty named
card, in the right place and at the right size, and writes it back untouched —
the ordinary unknown-`type` behaviour described below. The grouping is lost to
that reader and survives the round trip, which is the whole reason this is an
item type and not a new top-level key like `connections`.

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
| `type` | `image`, `video`, `audio`, `text`, `note`, `link`, `swatch`, `sticker`, `model`, `fence`, `generic`. |
| `x`, `y` | The item's **centre**, in world units. **`y` points up** — this is the one convention that surprises people, and it is why the renderer lays items out at `-y`. |
| `w`, `h` | Size in world units. Bounded to 48…20000 (`geometry.js`). |
| `rot`  | Degrees, anticlockwise-positive. Only stickers set it so far — ±8° rolled fresh every time one is pressed down — but every geometry helper has always respected it, and a hand-rotated card of any type round-trips. |
| `z`    | Stacking order. Higher is nearer. |
| `name` | The label on the card. Editable, and independent of the filename. |
| `asset`| `{ hash, embedded: true }`, or `null` for items that are only text. |
| `meta` | Per-type extras. See below. |

**An unknown `type`** — a reader that does not recognise one shows the item as a
plain named card rather than dropping it (`RENDERERS[item.type] ||
RENDERERS.generic`), and writes it back out untouched. `type` is a free-form
string in the model for exactly that reason. It is what let `swatch` and then
`sticker` be added without older builds losing those items, or losing the board
they were on, and it is the same extension point unknown `meta` keys get below.

For a sticker that fallback is worth picturing: an older build draws a plain
grey card, named "Star", where the star was, and writes the item back out
untouched. Honest, and not pretty. There is no version gate in this format and
adding one for a decoration would cost more than it saves.

**`asset.external`** — `{ external: { path } }` is reserved for a
link-instead-of-embed setting that does not exist. Unpack tolerates it; pack has
no bytes to write for such an item. **If it is ever implemented it breaks
promise 1 above,** and that is the open question at the bottom of this document.

### `meta`, by type

| key | on | what |
| --- | -- | ---- |
| `text`   | `note` | The note's whole text, Markdown-flavoured: `# ` a title line, `## ` a heading line, anything else a paragraph. The plaintext half — what search, linkify and older readers read. Capped at 512 characters (`NOTE_MAX`). A note with no `#` markers reads its first line as the title, so a note written before `rich` existed still shows titled. |
| `rich`   | `note` | The formatted content when present, and then authoritative over `text` (which it flattens to). `{ font, size, valign, blocks: [{ tag, align, text }] }` — `tag` is `h1`/`h2`/`p`, `align` is `left`/`center`/`right`, `font` is an allowlist key (`sheet`/`sans`/`serif`/`mono`), `size` a multiplier clamped to 0.7–1.8, `valign` is `top`/`middle`/`bottom`. Normalised on the way in (`normalizeNoteRich`): unknown values fall back, and the flattened text is held to `NOTE_MAX`. Absent on a legacy note, which is parsed back from `text`. |
| `stuckTo`| `note` | The id of the item this sticky note is pinned to, or `null` for loose. Stamped from live geometry at save; a load seeds the runtime memo from it so the pin survives a reload and a Mobile reflow even when the note no longer visibly overlaps its host. A dangling id (host deleted) falls back to measuring overlap. |
| `loose`  | `note` | `true` when the author explicitly unstuck this note (right-click → Unstick). Present only then; absent means the ordinary case. A stuck note is *pinned* — a drag on it takes hold of its host instead — and this is the one thing about stickiness that is a decision rather than a measurement, so it is the one thing stored rather than derived. It has to be: the usual reason to unstick a note is to nudge it, so the note is normally still lying on the card it was unstuck from and no geometry could tell you otherwise. Cleared by any drop that finds a host. **A reader that ignores it degrades one way**: it will measure the overlap, find the host, and treat the note as stuck again — so a board unstuck in a new build opens pinned in an old one, and unstuck again in the new one. Nothing is lost, and the older build writes the key back out untouched. |
| `shape`  | `sticker` | Which shape it is: a `<symbol>` id in `web/assets/stickers.svg`, e.g. `"s-star"`. Checked against the catalogue on every render (`stickerShape`), never trusted from the file — the value goes straight into a `<use href>`, where a name that matches nothing draws nothing at all and says nothing about it. An unknown id falls back to the first shape rather than leaving a hole. |
| `tint`   | `note`, `sticker` | Which colour off the pad, as a number. A note cycles 1–4 (`--note-1..4`) as it is made; a sticker is born wearing its shape's own default and 1–8 (`--sticker-1..8`) are the overrides the item menu offers. Out-of-range or missing falls back to the shape's default. |
| `url`    | `link` | The address. **Revalidated on every render**, never trusted from the file. |
| `hex`    | `swatch` | The colour, as `#rrggbb`. The item's `name` carries the same value uppercased — a swatch has no other name it could have, which is what makes one findable and what a copy of one puts on the system clipboard. Held to six hex digits on the way in and on the way out to the card (`swatchHex`); `#rgb` is folded out to the long form, and anything else falls back to the default grey rather than being stored. The item carries no asset. |
| `peaks`  | `audio` | RMS readings in [0, 1]. Moved out to `waveforms/` when packing — see below. |
| `trackTitle`, `artist`, `album` | `audio` | The track's tags, read off the file (ID3 / Vorbis / MP4) the first time the Mobile Playlist lens shows it, then cached here. The Playlist and the now-playing bar prefer `trackTitle` to the filename and show `artist` beneath it. Absent means the file carried no such tag; a re-encode with no title is still a track. Plain strings, additive — no `version` bump. |
| `duration` | `audio` | The track length in seconds, read off the file's metadata and cached so the row shows it without loading the file again. A number; additive. |
| `cover`  | any | An asset hash for the picture a card shows: album art, a diagram, a chosen image. On a `video` it is the poster — a still cut from the clip's own first frame at import, so the card is a picture of itself before it is played. Same key either way, and readers need not tell them apart. |
| `fit`    | `image`, `video` | This one card's fit, overriding the board-wide `mediaFit`: `"cover"` fills and crops, `"contain"` fits the whole picture in. Absent means follow the board default. |
| `fence`  | any | The id of the fence this item is inside, when it is inside one. Absent means loose — the key is written only where there is a fence to name, since a null on every card would be noise. Stamped at save from live geometry; a load seeds the runtime memo from it. A dangling id (fence deleted) falls back to measuring. |
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
Option 1 is the only one that needs no code. **This is an open maintainer
decision and nothing should be built for it until it is made** — a pull request
implementing any of the three would be premature, but the discussion is welcome
in an issue.
