# The `.mbrd` format

Version 1. Written 2026-07-25, from the code in `web/assets/js/storage/mbrd.ts`
and `web/assets/js/storage/zip.ts`, which are the only two files that read or
write it.

> **The format is free to implement.** This specification is published so that
> other software can read and write `.mbrd` files, and no permission, licence or
> attribution is required to do so. The app's GPL covers mbrd's *source*, not
> the format it stores work in. An implementation in any language, under any
> licence, open or closed, is fine and is the point. A file format only one
> program can read is a worse place to keep your work.
>
> If you build one, an issue saying so would be welcome; interoperability
> reports are the most useful bug reports this project can get.

This document exists because the format has grown two deliberate features
(`notes/` full of real Markdown and `waveforms/` full of readable JSON) that
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
   chat window. Every byte a board needs to render is inside it: no sidecar
   directory, no asset server, no network. This is why assets are embedded
   rather than linked, and it is the property that costs the most and is worth
   the most.

2. **The archive is legible.** Not "parseable given the source": legible. Your
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
├── mimetype                    the media type, first and uncompressed
├── manifest.json               what this file is
├── board.json                  the board itself
├── timeline/base.json          the board before its history, and the marker
├── timeline/steps-<k>.jsonl    the history in pieces of 500, one step to a line
├── assets/<slug>--<hash>.<ext> embedded bytes, deduped by content hash
├── notes/<slug>--<id>.md       one sticky note, as Markdown
├── waveforms/<hash>.json       one audio file's measured readings
├── boards/<id>/board.json      a board inside the board, the same shape as board.json
├── boards/<id>/timeline/…      its history, as timeline/ is for the top
├── boards/<id>/notes/…         its sticky notes, as notes/ is
├── boards/<id>/thumbnail.webp  it, small, for the card that opens it
└── thumbnail.webp              the whole board, small, for a list of boards
```

Only `manifest.json` and `board.json` are required. A reader that finds none of
the last three directories is looking at a perfectly valid board; a board
nobody has changed, with no sticky notes and no audio on it, has none of them.

### `thumbnail.webp`

The board as a picture at most 360px on its long edge, so a list of boards can
show each one without opening it. **`thumbnail.jpg`** instead where the engine
that drew it cannot write WebP (no Safari can); never both. It is *derived*: it
shows the board as it was when last drawn, which can be older than
`board.json`, and a reader must never take anything about the board from it.

- **Optional, and new.** Files written before it existed have none, and a reader
  that ignores it loses nothing. Older builds already ignore it: every reader
  skips a top-level name it does not know.
- **Stored, never deflated, and the last entry** of a whole write, so it sits
  just in front of the central directory. That is what lets the app read it
  from the file's last few hundred KB. An append carries it again only when the
  picture changed, so after many saves it can sit further back; the app reads
  up to 4 MB from the end for it and gives up past that.
- **Read by its bytes, not its name.** The app takes it only if it starts like
  a WebP or a JPEG and is under 512 KB, and shows nothing otherwise.
- The app draws it when a board is left, when the board list opens, and when
  the desktop or Android app closes. The autosave never draws one; it writes
  the last picture taken.

It replaces the `thumbnails/<hash>.webp` reserved in the first draft, which
nothing ever wrote: one picture per board is all a list needs, and a fixed name
is what a reader looking only at the directory can find.

### ZIP details

- Deflate or stored. Nothing else is written and nothing else is accepted.
- No ZIP64. A board past 4GB is not a board.
- No encryption, no multi-part archives.
- Entry names are `/`-separated, and the reader validates every one of them
  before it is used (see **Safety** below).
- The MIME type is `application/vnd.mbrd+zip`. A file is recognised by its
  `.mbrd` extension, by that type, or by the `mimetype` entry below.

### `mimetype`

The media type, as bytes, with no trailing newline. **First entry in the
archive, stored rather than deflated, and written with no extra field**, which
puts it at a fixed offset, where a tool that has never heard of this format can
find it. A local file header is 30 bytes plus the name, so offset 30 holds the
eight bytes `mimetype` and the string `application/vnd.mbrd+zip` begins at
**offset 38**: the number a `file(1)` magic rule wants, and the number this
paragraph got wrong by exactly the length of the name for as long as it has
existed. It is the ODF and EPUB convention, and it is there so `file(1)` can
name a `.mbrd` instead of shrugging and saying "Zip archive data".

mbrd's own reader checks it in one case only: **when `mimetype` is the first
entry and names another type**, the file is refused as "This is not an mbrd
board". That is another ZIP-based format renamed to `.mbrd`; an EPUB or an ODF
document says what it is in exactly this place. In every other case the entry
is not consulted. `manifest.json`'s `format` is still the answer to "what is
this", and a `.mbrd` whose `mimetype` is missing, not first, or deflated is still
a `.mbrd`: somebody may have unzipped a board, edited a note and rezipped it with
a tool that put the entries back in a different order.

Absent from every file written before it was added, which is why no reader may
require it, and why it is a courtesy rather than the fourth thing in the list
of what a `.mbrd` is.

---

## `manifest.json`

```json
{
  "format": "mbrd",
  "version": 1,
  "app": "mbrd v0.21",
  "created": "2026-07-25T10:04:11.882Z",
  "modified": "2026-07-25T18:22:03.117Z",
  "title": "Kitchen",
  "requires": []
}
```

| field      | meaning |
| ---------- | ------- |
| `format`   | Always `"mbrd"`. A file whose manifest says otherwise is refused. |
| `version`  | Format version, currently `1`. A **higher** number loads anyway with a console warning: a board from a newer mbrd is more likely to be readable than not, and refusing it outright would lose work that a slightly lossy open would have kept. |
| `requires` | Features a reader **must** understand to open this file at all. `["boards"]` on a file with a board inside it, empty on every other, and see below. |
| `app`      | Which build wrote it, as `mbrd <version>`, rewritten by every save, an appended one included. Two things read it back: the title repair below, which needs to know whether the writer predates v0.51, and the open, which reads this field alone before anything is filed and asks about a board a newer build saved. Opened anyway, such a board has no file behind it, so the next save makes a new one and the newer file is never written by an older build. Versions compare as two numbers (`0.10` after `0.09`, `1.10` after `1.9`, `1.0` after `0.999`). |
| `created`  | Preserved across re-saves, so a board keeps its birthday. |
| `modified` | Set on every pack. |
| `title`    | The board's name. Also the filename it was exported under, in practice. |

### `requires`, and why it is nearly always empty

A list of feature names. **A reader that does not understand every name in it
must refuse the file** rather than open it, and this is the one rule in this
document that asks a reader to fail rather than degrade.

It exists because `version` cannot do this job, and the reason is worth reading
once: no reader anywhere refuses a higher `version`. The check is a console
warning and the load continues, here and in every implementation modelled on it.
So a build meeting a field it has never heard of drops that field, writes it back
out missing, and reports the save as a success. `version` can say *this is newer
than you*. Only `requires` can say *this is newer than you **and you will lose
something***, which is the only version of that sentence anybody can act on.

**It is empty on almost every file, and meant to stay so.** Everything in the
format but one feature degrades honestly: an unknown item `type` draws as a plain named
card, an unknown `meta` key rides along untouched, an unread history is a history
that simply is not shown. None of that is worth refusing somebody's board over,
and a `requires` that cried wolf would be the first thing an implementer
hard-coded past.

What it is *for* is the field that comes later and cannot degrade: the one where
a person would rather be told to update than be handed a board that opens, looks
right, and has quietly lost something. That field puts its name in here in the
same commit that writes it.

The reason it ships empty rather than being added when first needed: **a gate
added the day it is first needed is a gate no existing reader checks.** That is
exactly the trap `version` fell into, one level up, and it is not recoverable
afterwards. So it is here now, doing nothing, being checked by everything.

If you are implementing a reader: check this list, and fail loudly on a name you
do not know. It will cost you nothing for years and then save somebody's work
once.

**The first name: `boards`** (v0.672, October 2026). A file with a board inside it
says `"requires": ["boards"]`, and only such a file: one whose tree is only its
top board writes `[]` as before and opens in every build. This is the field the
gate was waiting for. An older build would open the top board, draw each board
card as a plain named card, and write the file back on its next save *without*
`boards/` - every child gone, the save reported as a success. Every build since
the gate shipped refuses the file instead, with "update mbrd". See
`boards/<id>/` below.

**The title repair.** A board's name and its filename are not the same string:
`fileNameFor()` turns spaces into underscores so the name is safe in a file
picker. Opening a file takes `board.json`'s `title` exactly as it stands;
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
  "mobileHeader": { "font": "", "size": 13, "stretch": 100, "leading": 100, "weight": 700, "offset": 0, "italic": false, "wrap": false, "axes": {} },
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
  "tour": [ { "cards": ["k3f9a2"] }, { "cards": ["p81m4x", "s02b7q"], "caption": "The two greens" } ],
  "trash": [ { "at": 1753440000000, "item": { … } } ]
}
```

`view` and `settings` are the board's own state (where you were looking and how
the board was configured), and they travel with it, so opening a board puts you
back where you left it.

`view.zoom` is the raw world-to-screen scale, not the percentage the corner
prints. The two differ by `BASE_ZOOM` in `canvas/viewport.ts`: the interface
calls scale 0.8 "100%", so a board left at 100% records `0.8` here. Readers
should treat the number as a scale and not multiply it by a hundred.

`settings.tilt` is `false` when the board's cards hang square (Look → Tilt
cards). Absent or `true` means each card rests at the lean the whimsy tier
gives it. Harsh and a snapped board stand every card square, whatever this
says. A reader that ignores it tilts the cards, which is a degradation, not a
corruption.

`settings.gridStyle` has only ever had one value. It is kept because older
files carry it, which is the compatibility rule at the bottom of this document
working as intended.

`settings.paperShow` is `true` when the paper sheet is drawn, and
`settings.paper` names its size (`a4`, `letter`, …: the ids in `PAPERS`,
`measure.ts`) whether it is drawn or not. The two used to be one key: an empty
`settings.paper` was how a board said "no sheet", so putting the sheet away
also forgot which one it had been. **A file with no `paperShow` was written
then**, and a reader recovers the flag from the id (a known size means the
sheet was up, an empty or unknown one means it was down), then falls the id
back to `a4`. A reader that ignores `paperShow` draws a sheet on a board that
had none, which is a degradation and not a corruption. Both keys are
Desktop-only and are pinned down in a Mobile profile.

`settings.appearance` is the board's own look: a palette name and a bag of CSS
custom properties. **`vars` is the only part of a `.mbrd` that reaches the
browser as code**, and it is gated accordingly; see **Safety**. `dark` is
`true` when the board is shown in the dark theme (Look → Dark theme); present
only then, and anything but `true` reads as light, the default. The pigments in
`vars` stay the light ones either way; the dark twins are worked out on screen.
A reader that ignores it opens the board light. Additive, no `version` bump.

`mobileHeader` is the typography of the board's name, shared by the Mobile
masthead and the Desktop title card. It is **board-level** (one style for both
layouts). Files written before it moved here carry it under `settings.mobileHeader`
instead; a reader takes the top-level value first and falls back to that. It is
also mirrored back into `settings.mobileHeader` on save, so an older reader still
finds it. `wrap` is `false` on a new board. A `mobileHeader` without the key was
written before the setting existed, and reads as `true`, as it was drawn.
`titleHidden` is `true` only when the Desktop title card has been
deleted; a board without the key seeds the card on open. The card itself is an
ordinary item of `type: "title"` in `items` (a singleton, id `__title__`), with
its own Desktop geometry in `layouts.desktop`; it is never packed onto Mobile.

`mediaFit` is how photos and videos sit in their grid cells board-wide:
`"contain"` (the default) fits the whole picture in and letterboxes; `"cover"`
fills the cells and crops. It only applies with snapping on. Off the grid a
photo or video card is kept at its picture's shape (a Softish photograph at
its print's, which is taller by the chin), so there is nothing to fit.
It is **board-level** (one value for both layouts). A single image or video can
override it with `meta.fit` (`"cover"` / `"contain"`); an absent or
unrecognised `mediaFit` reads as `"contain"`.

`paletteSources` is how many of the board's pictures the Dynamic palette is read
from, newest first: a whole number clamped to
`[1, 24]`, or **`0` for every picture on the board**, defaulting to `12`.
Board-level, since the palette it feeds is shared across layouts. Absent or
unreadable reads as `12`; a count above 24 reads as `24`.

`0` is the slider's stop past the top rather than a count below its bottom: 24
is the highest number of sources the sampler reads by default, and `0` lifts
that ceiling instead of naming a bigger number. An older reader that clamps this
field to `[1, 24]` will read `0` as `1` and take its colours from the newest
picture alone: a duller palette, not a broken board.

`settings.fonts` is the faces the board carries with it, at most eight, each
`{ "hash", "family" }`, the hash naming bytes in `assets/`, the family becoming
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
here at all, while its *table directory*, which is not compressed, still says
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
uses. Any other value (including the Desktop shapes an older file stored here)
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

**Emptying it is the one action that removes bytes from a board.** Everything
else that deletes leaves the asset where it is, because undo, the bin and the
step ledger can each put the card back, so a file stays in `assets/` until one
of those three stops naming it, and emptying the bin is the only thing that
makes all three stop at once. What is left in place of each file is an item of
type `gone` carrying its name, its kind and its size (see `meta.gone` below),
written into the bin entry that comes back if the emptying is undone, and into
every copy of that item the step ledger holds. A reader that does not know the
type shows a plain named card, which is very nearly the right picture.

### `connections`

Lines somebody drew between two cards, as unordered pairs of item ids. A
connection has two ends and no direction: `["a","b"]` and `["b","a"]` are the
same one, and the second is dropped on the way in.

**Top-level, not inside a layout,** and that is the structural point: a
connection is between *items*, items are shared across Desktop and Mobile, and
only geometry is per-layout. Filing them under a layout would mean a board
connected on a desktop opened unconnected on a phone and then lost the lines the
next time it was saved from one.

Nothing about the path is stored. Where a line runs is a function of where the
two cards are now, worked out at draw time, so there is nothing to invalidate
and nothing to go stale, the same relationship the automatic web this replaced
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

`dir` is read against the pair **in the order the file carries it** (`"fwd"`
points the arrow at the second id), which is why that order is preserved even
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
- Duplicates collapse. Malformed entries (not an array, one id, a non-string)
  are dropped one at a time rather than failing the load.
- At most 2000 (`MAX_CONNECTIONS`). JSON is cheap and every entry costs a route
  to work out and a subpath to draw.

*While the app is running* a connection whose item has been deleted is simply
not drawn, and is deliberately **not** removed: that is what lets delete, undo,
trash and restore work with no bookkeeping at any of them. The pruning above
happens only at the file boundary.

An older reader ignores the key and shows the board without lines and, unlike
an unknown `type` or an unknown `meta` key, does **not** write it back, because
`board.json` is rebuilt field by field rather than carried through. So a board
saved by a build that predates this loses its connections. That is the one place
the format's forward-compatibility promise does not reach, and it is worth
knowing before adding another top-level key.

`settings.web` (which predates all of this and is still called that, so an
older build reads it and behaves) is the switch for whether they are drawn.

### `hadMusic`

`true` once a song has been on the board, and never cleared. It is what shows
the sidebar's Playlist button, which before it opened an empty player. The first
song imported on the canvas also opens the player window, once. Omitted rather
than written `false`, so a board with no music saves as it did before the key
existed. A board saved before the key, with music on it, gets it on load without
the window opening (`ui/playlist.ts`). Added 2026-09-14.

### `ownLook`

Only in a board inside another (`boards/<id>/board.json`): `true` when it keeps
a look of its own. Absent, it wears the look of the board above it, which the
app puts on it each time it is opened, so the look its own `settings` hold is
only the last one it was seen in. A choice made in its Look panel sets it;
"Same look as the board above" clears it. Omitted rather than written `false`.
Meaningless in a top `board.json`, which has nothing above it. Added 2026-10-08
(v0.677).

### `audioOrder`

The order the Playlist plays the board's audio in, as a flat list of item ids.
Dragging a track to a new place in the Playlist writes it; a track with no entry
here sorts after the ones that do, in the board's arrangement order.

**Top-level, not inside a layout,** for the same reason as `connections`: it is
an ordering of *items*, which are shared across Desktop and Mobile, so a
per-layout copy would let a playlist re-sorted on a phone come back scrambled on
a laptop.

What is held to, on the way in and out:

- Every id must name an item the file carries, **live or binned**: the same
  union `connections` use, so an order that names a since-thrown-away track
  survives to be restored with it.
- Duplicates and non-string entries are dropped one at a time rather than failing
  the load; the cap is `MAX_ITEMS`.
- The Playlist filters this to the audio it actually has and appends anything new
  in arrangement order, so a list that outlived some of its ids is self-healing
  rather than wrong; the file is not rewritten to prune them until the next save.

Additive with an empty default (`[]`), so it needs no format-version bump: a
board that predates it simply has no saved order and sorts by arrangement, and
(like `connections`) an older reader drops the unknown key rather than carrying
it through.

### `tour`

The board's tour: an ordered list of **stops**, each holding one or more cards
and, optionally, a line of text. A tour is a *reading* of a board (somebody's
route through it), and the app walks it with one camera move per stop, framing
everything at that stop together.

```json
"tour": [
  { "cards": ["k3f9a2"] },
  { "cards": ["p81m4x", "s02b7q"], "caption": "The two greens" }
]
```

A stop holds a group because that is what a stop on a moodboard usually is: a
photograph and the two swatches beside it are one thing being shown, and a tour
that flew to each of them separately would be reading out the parts of a
sentence. `caption` is **absent** rather than empty when there is nothing to
say, so an uncaptioned tour writes exactly the keys it always did plus the
nesting.

**Three shapes are read and one is written.** The entries are told apart by
what they are, so a hand-edited file is read stop by stop rather than refused
whole:

| in the file | read as |
| --- | --- |
| `"k3f9a2"` | a stop holding that one card |
| `["p81m4x", "s02b7q"]` | a stop holding both, no caption |
| `{ "cards": [...], "caption": "…" }` | itself (the form written) |

The first row is the whole of the migration: a file written before stops could
hold more than one card carries a flat `["a", "b"]`, and that reads as two
stops of one card each: the same tour it always was.

**A file written now, opened by a build from before this, shows no tour.** The
older reader holds every entry to `typeof id === 'string'` and drops the
objects, so the tour reads as empty rather than as broken. That cost was
accepted rather than worked around; nothing else in the file is affected.

**Top-level, not inside a layout,** for exactly the reason `connections` and
`audioOrder` are: it is an ordering of *items*, items are shared across Desktop
and Mobile, and a per-layout copy would let a tour built on a laptop come back
pointing at different cards on a phone. The geometry each stop is framed against
is already in `layouts`, so the same list frames the same cards on both.

**Where the reader had got to is not here, and will not be.** What the file
carries is the itinerary; the position in it is a fact about a reading session,
the same kind of thing as the Feed's scroll offset, and writing it would make
opening a board a change to it.

What is held to, on the way in and out:

- Every id must name an item the file carries, **live or binned**: the same
  union `connections` and `audioOrder` use, so a stop whose card is in the bin
  survives to be restored with it. The *running* tour is held to the live board
  instead and simply skips what is not there, which is the one place the two
  differ and is deliberate: a file must remember, a camera must not fly to a
  card that is not on the board.
- **A card appears at one stop at most.** Deduping is across the whole tour and
  not within a stop: a card at stop 2 and again at stop 7 makes "how far
  through am I" unanswerable, and no reading of a moodboard means it. The
  second appearance is dropped.
- A stop left holding no cards (every one of them dropped, or named by nothing
  the file carries) is dropped itself. An empty stop is a place the camera
  cannot go.
- Duplicates and non-string entries are dropped one at a time rather than
  failing the load; the cap is `MAX_ITEMS` and counts **cards**, not stops, so
  the bound is the one the flat list carried. A caption is trimmed, collapsed
  to single spaces and cut at `MAX_TOUR_CAPTION` (140).
- Written even when empty, for the reason the same rule is stated for
  `audioOrder`: a tour that was built and then cleared must not read as a board
  that never had one.

Additive with an empty default (`[]`), so it needs no format-version bump, and
an older reader drops the unknown key rather than carrying it through: the same
caveat `connections` carries about round-tripping through a build that predates
the field.

### `versions` (withdrawn)

**Not written, and ignored on read.** For one release (v0.197) a board carried
a list of stored copies of itself, newest first, each entry a whole `board.json`
under a `data` key, written out beside the board as `versions/<id>.json`. It is
gone as of v0.198. A file that still has the key opens; the key is dropped, the
directory is walked past, and what comes back is the board without its snapshots.

**Why it went, one release after it arrived.** The `timeline` field below answers
the same question better. Undo now survives the refresh, every step is a point
the board can be taken back to, and any step can be named, so a stored version
was a second, coarser, far more expensive answer to *take me back*.

**What went with it is a class of reference, and that is the part worth
recording.** The packer writes only hashes something still points at, and the
browser's housekeeping sweep deletes whatever nothing claims. A version named
cards the board no longer had (that was the entire point of one), so an asset
only a version wanted was *live*, and three separate places had to know it:
`packBoard`, the autosave sweep, and the inventory sheet. Each of those is a
place that can silently delete somebody's photograph, and each now asks three
questions instead of four:

1. an item on the live board,
2. an item in the bin,
3. **an item named by a step of the timeline.**

**A reader that wants the old data can still have it**, which is why nothing here
is destructive to a file on disk: `versions/<id>.json` inside a v0.197 `.mbrd` is
a complete `board.json`, openable on its own, and unzipping the archive is the
whole of the recovery. What the app will not do is carry it forward.

### `timeline`

How the board got here. Absent on a board nobody has changed, and absent from a
**share** where the person sending it said to leave it out.

Export used to ask the same question and default to leaving it out. It no longer
asks and no longer drops: a file written to your own disk without its ledger
opens as a board with no past, and nothing at the far end can put back what was
never written. Share still asks, because that is the path where the file goes to
somebody else by definition and the ledger holds everything that was tried and
thrown away. So a reader must still cope with the key being absent: an older
build, an unedited board, or a share somebody trimmed.

```json
"timeline": {
  "version": 2,
  "base": { "items": { "…": "id -> JSON" }, "itemOrder": ["…"],
            "desktop": { "…": "id -> place" }, "mobile": { "…": "id -> place" },
            "rest": { "…": "…" } },
  "at": 42,
  "first": 120,
  "fingerprint": "3f9a21c4",
  "steps": [
    { "id": "s8k2m", "at": 1755180000000, "label": "Move", "run": "desktop:k3f|x,y",
      "delta": { "desktop": { "changed": { "k3f": ["{…before}", "{…after}"] } } } }
  ]
}
```

`base` is the board before step 0, as text. `steps` are in order, oldest first.
`at` is how many of them are on the board (the marker), so a file can be saved
with the history rolled back and comes back that way. `first`, absent until a
trim or the step cap folds something, is how many steps have been folded into
`base` over the ledger's life; the file uses it to number its pieces (below).

**A card's place is kept apart from the card** (`version` 2). `items` holds each
card without `x`, `y`, `w`, `h`, `rot`, `z` and `meta.presnap`. `desktop` and
`mobile` hold its place in each layout, shaped as `layouts` entries are. So a
move is a change to one layout's places and nothing else, and one history
replays on the Canvas and on the Feed. `rest` has no `settings`, `arrangement`
or `layoutMode`: the first two are the live layout's copy of `layoutSettings` and
`arrangements`, and the third is which layout is on screen, which a trip through
the history leaves alone. A card with no place yet in the layout on screen gets
one the way a layout switch gives one.

A timeline with no `version` (up to v0.377) kept each place on its card, and is
not read: the board opens with no past.

**In the file, the history is not in `board.json`.** The object above is what the
app holds and what the cloud copy carries. A `.mbrd` splits it in two, so the
board stays readable at a glance however long its past is:

- `timeline/base.json` holds every key but `steps`, plus `count`, how many steps
  there are.
- `timeline/steps-<k>.jsonl` hold the steps, one JSON object to a line, oldest
  first, in pieces. Piece `k` holds the steps numbered `k*500` to `k*500+499`,
  where a step's number is its place in `steps` plus `first`, how many steps
  have been folded into `base` over the ledger's life (absent is 0). A reader
  takes the pieces in order of `k` and reads them as one list.

**Why pieces.** A save to a board's own file appends only the entries that
changed, and leaves what they replace as dead bytes until the file is next
written whole. One file of steps changed on every save, so every save wrote the
whole history again: near the step cap, a third of a megabyte a save. Numbered
over the ledger's life rather than by place in the list, a new step changes the
last piece and a fold the first, and the rest are pointed at where they are.

A file written before the pieces (v0.316 to v0.464) has one `timeline/steps.jsonl`
holding every step, and a reader must still take it. A build from before the
pieces opening a newer file finds no `steps.jsonl`, reads fewer steps than
`count`, and opens the board with its history stale.

These files outrank a `timeline` key in `board.json`, which is where a file
written before them (up to v0.316) keeps it, and a reader must still take it from
there. A line that will not parse, or fewer lines than `count` - a piece missing
from the middle among them - makes the history stale, for the same reason a
fingerprint that does not match does. An unreadable `base.json` opens the board
with no past.

**Most steps are a difference; some also carry a rule.** Each `delta` holds the
state on both sides of what one action touched, keyed by item id, which is what
makes it reversible in either direction without knowing what the action meant. A
step with only that is **sealed**: it replays exactly and cannot be edited,
because there is nothing in *this card was at 40 and is now at 80* to change.

A step may also carry an `op`, a rule and its arguments:

```json
"op": { "name": "align", "params": { "edge": "left", "ids": ["k3f", "p81"] } }
```

Change an argument and the step can be run again to a different answer, with
every step after it replayed on top of it. Three commands carry one so far
(`align`, `distribute`, `arrange`), chosen because they are the ones where
editing the past visibly ripples. The `delta` is still recorded alongside and is
what ordinary scrubbing uses; it is rewritten whenever the rule is re-run. A
reader that does not understand `op` treats every step as sealed, which is
correct rather than merely safe.

**A delta applies only the fields it changed**, not the whole recorded object.
This is not an optimisation. Writing the object whole would make every step
assert everything about that card, so editing a step in the past would take
effect and then be silently undone by the next step that happened to mention the
same card.

**A run of changes to one card is one step.** Twelve taps of an arrow key are
one entry holding the first position and the last. Undo in the session that made
them is still finer than that, and *that* fineness is not written down: reopen
the file and one undo takes the whole move back. This is intended (it is what
keeps a file the size of somebody's intentions rather than the size of their
keystrokes), and it is the one place the format deliberately remembers less than
the app did.

`run` is what says whether two steps were one: the ids that changed and which of
their fields, and (for a step carrying a rule) the rule's name in front of
them, as `op:arrange|desktop:k3f,desktop:p81|x,y`. So cycling an arrangement to
see which one looks right is one step holding the board before the first press
and the arrangement settled on at the last, while an align and an arrange over
the same cards stay two. A reader can ignore the field entirely: it is only ever
consulted when the *next* step is recorded, in the session that records it.

**`fingerprint` is taken over `items` and `trash` as this file carries them**,
not over the live board, because a board written out and read back is not the
same object: coordinates round, absent keys take defaults, layouts are
recomputed. On load, a timeline whose fingerprint does not match the document it
arrived in is marked stale and shown as unusable rather than believed. The
failure this guards is specific: an older build opens the file, drops the key it
does not understand, writes the board back edited, and it comes here again. A
history that quietly describes the wrong board is worse than no history. A
timeline with no fingerprint at all is taken at its word, since that is what a
file written before the check looks like.

**Checkpoints are not in here and never will be.** Scrubbing needs a full copy
of the board every fifty-odd steps, and a full board is on the order of a
hundred kilobytes against a step's eighty bytes, so storing them would make
them roughly thirty times the size of the history. They are rebuilt in memory
when a board is first scrubbed. Nothing is lost by a reader that ignores this:
`items` is the end state, exactly as it always was.

**It is the fourth class of reference, and this is the part with teeth.** A step
that deleted a photograph carries that photograph on its *before* side, and that
is what stepping back puts on the board again. So an asset a step points at is
live even when no card, no bin entry and no version wants it. Four readers now
compute "what is still used": `packBoard()`, the autosave sweep in
`storage/session.ts`, `ui/inventory.ts`, and the timeline itself supplying the
fourth set. Miss one and the history comes back with holes in it. Unlike the
other three classes, a missing asset here is **not** fatal to an export: a step
can name bytes the optimiser legitimately discarded, and refusing to write
somebody's board because of an entry in its history would be the wrong way
round.

Additive and absent by default, so it needs no version bump; see the
compatibility note below, which this field is now the reason for.

### Fences

A **fence** is an item of `type: "fence"`: a labelled rectangle, with the cards
inside it belonging to it. Its `name` is the label; it carries no asset, and its
own `meta` holds at most two keys:

- `tint`: an integer 1–4, the note sheet its region is washed in. Absent is the
  plain well.
- `rolled`: `true` when the fence is rolled up to its name bar, with every card
  inside it out of sight on the canvas. Absent is open. It is a way of showing
  the board, and nothing moves: the cards keep their places, and the fence
  keeps its full size for when it rolls down. The Feed ignores it.

Members carry the membership key below.

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
card, in the right place and at the right size, and writes it back untouched:
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
| `type` | `image`, `video`, `audio`, `text`, `note`, `link`, `swatch`, `sticker`, `drawing`, `board`, `model`, `fence`, `gone`, `archive`, `folder`, `card`, `generic`. |
| `x`, `y` | The item's **centre**, in world units. **`y` points up**. This is the one convention that surprises people, and it is why the renderer lays items out at `-y`. |
| `w`, `h` | Size in world units. Bounded to 48…20000 (`geometry.ts`). |
| `rot`  | Degrees, anticlockwise-positive. Only stickers set it so far (±8° rolled fresh every time one is pressed down), but every geometry helper has always respected it, and a hand-rotated card of any type round-trips. |
| `z`    | Stacking order. Higher is nearer. |
| `name` | The label on the card. Editable, and independent of the filename. |
| `asset`| `{ hash, embedded: true }`, or `null` for items that are only text. |
| `meta` | Per-type extras. See below. |

**An unknown `type`**: a reader that does not recognise one shows the item as a
plain named card rather than dropping it (`RENDERERS[item.type] ||
RENDERERS.generic`), and writes it back out untouched. `type` is a free-form
string in the model for exactly that reason. It is what let `swatch` and then
`sticker` be added without older builds losing those items, or losing the board
they were on, and it is the same extension point unknown `meta` keys get below.

For a sticker that fallback is worth picturing: an older build draws a plain
grey card, named "Star", where the star was, and writes the item back out
untouched. Honest, and not pretty. There is no version gate in this format and
adding one for a decoration would cost more than it saves.

**`asset.external`**: `{ external: { path } }` is reserved for a
link-instead-of-embed setting that does not exist. Unpack tolerates it; pack has
no bytes to write for such an item. **If it is ever implemented it breaks
promise 1 above,** and that is the open question at the bottom of this document.

### `meta`, by type

| key | on | what |
| --- | -- | ---- |
| `text`   | `note` | The note's whole text, Markdown-flavoured: `# ` a title line, `## ` a heading line, anything else a paragraph. The plaintext half: what search, linkify and older readers read. Capped at 512 characters (`NOTE_MAX`). A note with no `#` markers reads its first line as the title, so a note written before `rich` existed still shows titled. |
| `rich`   | `note` | The formatted content when present, and then authoritative over `text` (which it flattens to). `{ font, size, valign, blocks: [{ tag, align, text, wash? }] }`. `tag` is `h1`/`h2`/`p`, `align` is `left`/`center`/`right`, `font` is an allowlist key (`sheet`/`sans`/`serif`/`mono`), `size` a multiplier clamped to 0.7–1.8, `valign` is `top`/`middle`/`bottom`. `wash` is the highlighter drawn over that one line (`amber`/`terracotta`/`olive`/`graphite`), and is the one field written only when it is set: an unmarked line has no `wash` key rather than a `wash` of "none", so an unmarked note's blocks are byte-for-byte what they were before markers existed. An unknown wash is dropped rather than repaired, since there is no nearest marker to round a stranger's name to. Normalised on the way in (`normalizeNoteRich`): unknown values fall back, and the flattened text is held to `NOTE_MAX`. Absent on a legacy note, which is parsed back from `text`. **`runs`** (additive, no `version` bump): a block may carry `runs: [{ text, title, font, size, wash? }]`, the line as styled stretches (a title, face, size and marker per run rather than per line), and when present it is the truth for that line. The older fields are still written beside it, re-derived from the runs: `text` their words, `tag` `h1` when every run is a title and `p` otherwise, `wash` when every run shares one. A reader that ignores `runs` therefore shows every word, with the line's look where the line has one look and plain where it mixes: a degradation, not a loss. A block without `runs` reads as one run off its `tag` and `wash` in the sheet's `font` and `size`, `h2` as a title a size smaller. The editor writes `valign` as `top` (the control is gone) and the sheet `font`/`size` as the first run's. |
| `stuckTo`| `note` | The id of the item this sticky note is pinned to, or `null` for loose. Stamped from live geometry at save; a load seeds the runtime memo from it so the pin survives a reload and a Mobile reflow even when the note no longer visibly overlaps its host. A dangling id (host deleted) falls back to measuring overlap. |
| `loose`  | `note` | `true` when the author explicitly unstuck this note (right-click → Unstick). Present only then; absent means the ordinary case. A stuck note is *pinned* (a drag on it takes hold of its host instead), and this is the one thing about stickiness that is a decision rather than a measurement, so it is the one thing stored rather than derived. It has to be: the usual reason to unstick a note is to nudge it, so the note is normally still lying on the card it was unstuck from and no geometry could tell you otherwise. Cleared by any drop that finds a host. **A reader that ignores it degrades one way**: it will measure the overlap, find the host, and treat the note as stuck again, so a board unstuck in a new build opens pinned in an old one, and unstuck again in the new one. Nothing is lost, and the older build writes the key back out untouched. |
| `faded`  | `note` | `true` when the note's paper is drawn at 60% (right-click → Low opacity), with its words solid and no drop shadow. The paper comes back to full under the pointer, and below the far-zoom rung. Present only then; `false` is never written. **A reader that ignores it draws the note at full strength**, which is a degradation, not a corruption. Additive, no `version` bump. |
| `ascii`  | any with a file; read on text | `true` when the document is ASCII art (the editor's **ASCII art** toggle), so the viewer shows it unwrapped and scrolling sideways rather than wrapped to the page. Present only then; `false` is never written. **A reader that ignores it wraps the lines**, which spoils the picture and changes no byte. Additive, no `version` bump. |
| `shape`  | `sticker` | Which shape it is: a `<symbol>` id in `web/assets/stickers.svg`, e.g. `"s-star"`. Checked against the catalogue on every render (`stickerShape`), never trusted from the file: the value goes straight into a `<use href>`, where a name that matches nothing draws nothing at all and says nothing about it. An unknown id falls back to the first shape rather than leaving a hole. |
| `tint`   | `note`, `sticker` | Which colour off the pad, as a number. A note cycles 1–4 (`--note-1..4`) as it is made; a sticker is born wearing its shape's own default and 1–8 (`--sticker-1..8`) are the overrides the item menu offers. Out-of-range or missing falls back to the shape's default. |
| `url`    | `link` | The address. **Revalidated on every render**, never trusted from the file. |
| `gone`   | `gone` | `{ type, ext, bytes }`: what a file was before the bin was emptied on it. `type` is the item type it had, carried as the string it was rather than checked against this list, for the same reason an unknown `type` is carried. `ext` is its extension and `bytes` what it weighed. This is the **whole** of what such an item keeps: `asset` is `null`, the rest of `meta` is dropped, and the geometry and `name` stay so that the card is drawn where and as large as the thing it replaces. There is nothing here that could ever resolve to a file again, which is the point: emptying the bin is the one action in the app that destroys rather than files, and this is the record it leaves in place of what it destroyed. |
| `hex`    | `swatch` | The colour, as `#rrggbb`. The item's `name` carries the same value uppercased. A swatch has no other name it could have, which is what makes one findable and what a copy of one puts on the system clipboard. Held to six hex digits on the way in and on the way out to the card (`swatchHex`); `#rgb` is folded out to the long form, and anything else falls back to the default grey rather than being stored. The item carries no asset. |
| `strokes`, `space` | `drawing` | What the pen drew (`canvas/strokes.ts`). `space` is `[w, h]`, the size of the drawing's own coordinate space when its strokes were laid down; the card draws that space centred in its box at one scale (an SVG `viewBox` with `meet`), so a resized card scales the sketch rather than reflowing it and never squashes it. `strokes` is `[{ tool, ink, width, pts }]`, highlighters drawn under pens: `tool` is `pen` or `highlighter`; `ink` a token *name* (`ink`, `accent`, `warm`, `leaf` or `danger`), never a colour, so a drawing follows the board's palette, its scheme and colourblind mode; `width` in the space's units; `pts` one string of points `x,y,p` in base 36, x and y in tenths of a unit with y running **down** (the SVG's way, unlike the item's own `y`), p the pressure in hundredths, points separated by spaces. Simplified when the stroke ends and capped at 2000 points a stroke and 400 strokes a drawing. How a stroke is *drawn* (tapered, smooth or plain) is the whimsy tier's at render time and is not stored. Read back through `readDrawing()`, which drops a stroke with no points, clamps the width, falls back to `pen` and `ink`, and skips a point it cannot read. The item carries no asset. Additive, no `version` bump: an older build draws a plain card where the drawing was and writes the item back out untouched. |
| `board`  | `board` | The id of the board this card opens: a directory `boards/<id>/` in the same file (see above). A string matching `[A-Za-z0-9_-]{1,64}`; anything else names nothing, and a card whose child is missing shows itself missing. The item carries no asset - its picture is the child's own `boards/<id>/thumbnail.webp`. |
| `before`, `cards`, `by` | `card` | A card with a before-and-after drawing of the board on it (`canvas/spotless.ts`). `before` is where each cleaned card sat in a 104×78 frame and the colour of its grime, `[[x, y, w, h, colour], …]`; `cards` is how many; `by` is `"robot"` when the robot vacuum finished the board and absent otherwise. Read back through `spotlessRects()`, which keeps only four finite numbers inside the frame and an `rgb()` or hex colour, and at most 400 of them. The item carries no asset. An older build draws it as a plain named card. |
| `archive`, `archiveName`, `path` | `folder` | A folder inside an archive: the asset hash of the archive it points into, that archive's filename (whose extension says how to read it), and the folder's path inside it, ending in `/`. The archive itself is not otherwise on the board once it is unzipped; this reference is what keeps its bytes in the file, until nothing points into it. An `archive` item carries the archive as its ordinary `asset`, and Unzip replaces it with what is inside. |
| `files`  | `folder` | A folder dropped from the disk: `[{ path, hash, size }]`, every file under it by its path below the folder and its asset hash. Each hash is an ordinary asset, packed and synced like any other (`itemHashes`). An entry without a string `path` and a valid `hash` is dropped on the way in. A folder card carries `files` or `archive`, never both; Open replaces it with the files at its top level and one folder card per folder inside. |
| `count`  | `folder` | How many files are anywhere under the folder, for the card to show. A number; a reader may recount. |
| `peaks`  | `audio` | RMS readings in [0, 1]. Moved out to `waveforms/` when packing; see below. |
| `trackTitle`, `artist`, `album` | `audio` | The track's tags, read off the file (ID3 / Vorbis / MP4) the first time the Mobile Playlist lens shows it, then cached here. The Playlist and the now-playing bar prefer `trackTitle` to the filename and show `artist` beneath it. Absent means the file carried no such tag; a re-encode with no title is still a track. Plain strings, additive, no `version` bump. |
| `duration` | `audio` | The track length in seconds, read off the file's metadata and cached so the row shows it without loading the file again. A number; additive. |
| `playlistHidden` | `audio` | `true` when the track was hidden from the Playlist (the row's menu → Hide from playlist). Present only then; showing it again deletes the key. A hidden track is drawn greyed at the foot of the list, and next and previous step over it, but it keeps its slot in `audioOrder` and its card on the board still plays. Off the undo stack, like `audioOrder`. **A reader that ignores it lists the track like any other**, which is a degradation, not a corruption. Additive, no `version` bump. |
| `cover`  | any | An asset hash for the picture a card shows: album art, a diagram, a chosen image. On a `video` it is the poster: a still cut from the clip's own first frame at import, so the card is a picture of itself before it is played. Same key either way, and readers need not tell them apart. |
| `display`| `image` | An asset hash for a baked ~1024px WebP copy of the picture: the pixels a card and the Feed mount **instead of** the full original, since decoding a multi-megapixel photo for a card a few hundred pixels wide is what made a phone's Feed scroll badly. Derived and optional: made at import (`optimize/picture.ts`, `DISPLAY_SIDE`), backfilled for older boards as their photos are viewed (silently, so opening a board is not an edit), and **a reader that ignores it shows the same photograph from the original**, which is slower, not wrong. Only for a plain picture; a `crop`/`rotate`/`matte` card's copy is the *edited* one, made at display time (`canvas/display.ts`) and never stored here. The canvas swaps the original back in when a card is zoomed larger than this copy (`canvas/hires.ts`). Rides the asset walk (`itemHashes`) so it packs and syncs like any other. |
| `source` | `image` | An asset hash for **the file that arrived**, on a card whose `asset` is a picture decoded from it: a `.heic` (`import/heif.ts`) or a camera RAW (`optimize/demosaic.ts`), turned into a WebP at import so that every part of the app (the card, the viewer, Open, Edit picture, the export) is looking at a picture rather than at a container only one reader here can open. `name`, `origName` and the sensor are all still here, so the original is one undo or one unpacking away; `ext` and `mime` describe the *decoded* file, because they describe `asset`. Rides the asset walk (`itemHashes`) so it packs and syncs like any other. **Optimize deletes it**: that is the one thing in the run that gives bytes back rather than shrinking them, and the card it leaves is an ordinary photograph. A reader that ignores this key shows the same picture and merely carries a file nothing points at. |
| `demosaiced` | `image` | `true` on a camera RAW card whose `preview` is the sensor developed by LibRaw (the Demosaic row, `optimize/demosaic.ts`), rather than the JPEG the camera stored inside the file. `asset` is still the untouched RAW, and `thumb` and `display` are cut from the developed picture. Absent means the preview, if there is one, is the camera's own; `false` is never written. **A reader that ignores it shows the same `preview`**; the key only stops the menu offering Demosaic twice. Optimize replaces the RAW with a developed, shrunk picture and takes this key, `preview` and `display` off with it, rewriting `ext` and `mime` to the new file. This is the older of the two shapes a RAW card takes: since the import developer arrived, a RAW lands with its picture at `asset` and the sensor at `source` above, and the Demosaic row replaces that picture rather than a preview beside it. Both shapes are read. |
| `fit`    | `image`, `video` | This one card's fit on the grid, overriding the board-wide `mediaFit`: `"cover"` fills its cells and crops, `"contain"` fits the whole picture in. Absent means follow the board default. |
| `crop`   | `image` | The rectangle of the picture the card shows: `{ x, y, w, h }`, four **fractions of the source** with the origin at the top left. Fractions rather than pixels so the record survives the bytes being re-encoded at another size by Optimize. Non-destructive: the asset is untouched, and the crop is applied when the display copy is made (`canvas/display.ts`). A full-frame rectangle is not a crop and carries no key. **A reader that honours only this key still gets the right region**, whatever the four below say. |
| `rotate` | `image` | A quarter turn, clockwise: `90`, `180` or `270`. Not an arbitrary angle; straightening is a different feature. Applied **after** `crop` and before `flip`, which is what keeps `crop` in the source's own coordinates. Absent, `0` or a full turn means the way the file arrived. A quarter turn swaps the card's proportions, so it is baked into the display copy rather than applied as a transform. |
| `flip`   | `image` | Which way round the picture is hung: `{ x, y }`, two booleans, `x` mirroring left to right and `y` top to bottom. Truthy rather than `=== true`. Applied **last**, to whatever `crop` and `rotate` left, and as a compositor transform rather than in the pixels: a mirror does not change the box. Neither axis set means no key. |
| `adjust` | `image`, `video` | The grade: `{ brightness, contrast, saturation }`, each a multiplier around 1, clamped to 0–2. Becomes one CSS `filter`, which is why there are three and not thirty. Neutral on all three means no key. Video too, unlike the four above: a filter grades a frame as happily as a still. |
| `matte`  | `image` | `true` when the picture is shown with its background taken out. A flag and nothing else: the cut is a salient-object model (U²-Netp, vendored; see `canvas/matte.ts`), and it has no setting a person could turn. Applied after `crop` and `rotate`. Absent means the picture keeps every pixel it arrived with; `false` is never written. Non-destructive like the rest: the mask lives in the derived copy and in the export, never in the asset, so **a reader that ignores this key shows the same photograph with its background**, which is a degradation and not a corruption. |
| `fence`  | any | The id of the fence this item is inside, when it is inside one. Absent means loose; the key is written only where there is a fence to name, since a null on every card would be noise. Stamped at save from live geometry; a load seeds the runtime memo from it. A dangling id (fence deleted) falls back to measuring. |
| `presnap`| any | Where the item was before snap-to-grid moved it, so turning snapping off can put it back. `{ x, y, w, h }`. |
| `stuckOf`| `note`, `sticker`, **in `trash` only** | The id of the drawer entry this one was stuck to when the two were deleted together. Written by `removeItems` at the delete, when both are still on the board and the relation can be measured; read by `restoreItems`, which brings the whole pile back on its host and places each rider at the fraction of the host it held. Dropped the moment the item lands back on the board, where the geometry is the truth again, so this key never appears on an item in `items`. It exists because `stuckTo` cannot answer here: two entries in the drawer have no geometry to measure against each other. A dangling id is the ordinary case (the host was taken back out, or emptied) and means the entry comes back on its own. |
| `clipOf` | `video`, **in `trash` only** | The id of the live card a frozen clip came off; see `freezeClip`. The card stays on the board wearing the still it was showing and the clip goes to the drawer, so this entry has a home to return to and is the one the drawer restores on a click rather than a drag. Same shape as `stuckOf` above and dropped the same way. A dangling id (the card has since been deleted) means the clip comes back as an ordinary video card. |

Unknown `meta` keys are carried through untouched. That is the extension point:
a future version can add one without older readers losing it.

---

## `assets/<slug>--<hash>.<ext>`

The bytes, named by the SHA-256 of themselves. Two identical photographs
dropped twice are one entry.

```
assets/kitchen-window--9f2c4a…b71e.jpg
assets/inter--3d81ff…09ac.woff2
assets/c07e12…4d55.mp4                  also legal; the slug is optional
```

**The slug is for you and the hash is for the reader**, the same split the note
sidecars make and for the same reason: a board of forty photographs that unzips
to forty files named in hexadecimal satisfies every promise this format makes
except the one about being able to read it.

- **`<slug>` is optional and is discarded on read.** A reader must accept
  `assets/<hash>.<ext>` exactly as it accepts the decorated form, and must not
  derive anything from the slug: not the type, not the name, not the order.
  Requiring it would mean requiring every implementation to reproduce this
  app's slug function byte for byte in order to write a file this one will read.
  Writing it is a courtesy; ignoring it is conformant.
- **The hash remains the only identity.** The digest is still checked against
  the bytes, dedup is still by digest, and two entries carrying the same digest
  under different slugs are still refused as stored twice. A slug that lies
  about what the bytes are costs nothing.
- **Split on the last `--`.** The slug has its own runs of punctuation collapsed
  to a single dash, so two in a row appear nowhere inside it.
- What it is made of: what the card calls the asset, then the filename the bytes
  arrived under, then (for a face, which nothing on the board names) the font
  family. Lowercased, non-alphanumerics collapsed to dashes, 48 characters. The
  extension is dropped from the label where it matches the entry's own `<ext>`,
  so a card named `kitchen-window.jpg` files as `kitchen-window`, while one
  named `Notes v1.2` keeps its version number. Where a hash is referenced more
  than once the first reference wins, in a fixed order, so an archive is
  reproducible.
- `<hash>` is 64 lowercase hex characters. Enforced in both directions.
- `<ext>` is `[a-z0-9]{1,12}`, taken from the original filename, and used only
  to rebuild the MIME type on the way back in, since ZIP entries carry no content
  type of their own.
- Only hashes still referenced by a live item or a binned one are written, so
  deleting things and saving actually shrinks the file.
- **A referenced hash with no bytes fails the export.** It used to warn and
  carry on, which produced a `.mbrd` with a hole in it while telling the user
  their work was safe.

---

## `boards/<id>/`: boards inside the board

A board can hold boards: a **board card** on it opens a whole board of its own
(research/boards-in-boards-2026-10-07.md). Each child lives in the parent's file,
in a directory of its own:

- **`boards/<id>/board.json`** is exactly a `board.json`: title, view, settings,
  items, bin, connections, tour - everything above applies to it unchanged. It
  never carries `boards` itself.
- **`boards/<id>/timeline/…`** and **`boards/<id>/notes/…`** are its history and
  its notes' sidecars, read as `timeline/` and `notes/` are for the top.
- **`boards/<id>/thumbnail.webp`** (or `.jpg`) is the child, small, drawn when it
  was last left; the card that opens it shows this. Optional, read by its bytes,
  as the top's is.
- **`assets/` and `waveforms/` stay one shared directory.** A picture on three
  levels is stored once. This is why a child is a directory and not a nested
  `.mbrd`, which would store the photograph again.

**Flat, never nested.** A grandchild is `boards/<its id>/` like any other child,
so a path never grows with the depth and every child is one hop from the root.
Which board holds which is said only by the board cards - an item of type
`board` whose `meta.board` is the id - so the tree cannot disagree with itself.
`<id>` is `[A-Za-z0-9_-]{1,64}`; any other directory name is not read.

**Limits**, written down rather than argued later: **200 children** a file and
**8 levels** deep. Past either the app offers no way to make more; a file
claiming more is read up to 200 and the rest are reported. A child whose
`board.json` will not parse, or has no `items` list, is left out and reported -
and a board card naming a child that is not there shows itself missing rather
than failing the file. A `boards` key inside a `board.json` is ignored: only the
directories are the tree.

**Gated by `requires: ["boards"]`**, written whenever the file holds a child -
see `requires` above for why this is the one feature that refuses rather than
degrades.

---

## `notes/<slug>--<id>.md`

Each sticky note, again, as Markdown:

```markdown
# buy the smaller one

the big one does not fit under the shelf
```

First line becomes an `# ` heading, the rest is the body.

- `<slug>` is the first line, lowercased and hyphenated, capped at 48
  characters, for you.
- `<id>` is the item id, for the reader, which is how a file is matched back
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

`res` is the number of readings, and it must equal `peaks.length`; a file
where they disagree has been truncated and is ignored.

- Keyed by the **hash of the audio**, not the id of the card: a waveform is a
  property of a recording, so the same clip on the board twice is measured once.
- Written sixteen numbers to a line, so the file is something a person can actually read.
- When a sidecar is written, `meta.peaks` is **removed** from `board.json`.
  Storing it twice would be the same bytes for nothing and two places to
  disagree.
- The sidecar outranks `board.json` where there is one; `board.json` still works
  where there is not (an older board); and a truncated or hand-mangled file is
  **ignored, not fatal**: the card falls back to measuring the audio again.

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
  `../escape` used to pack back out as `assets/../escape.bin`: harmless here,
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
  allowlist (`ui/look.ts`).
- **`meta.presnap` is checked before it is written onto an item's geometry**:
  four finite numbers with a size inside the legal range, or the memo is
  dropped.

---

## Compatibility rules

For anyone changing this format later:

- **Adding a `meta` key is free.** Older readers carry it through.
- **Adding a top-level directory is free.** Older readers ignore what they do
  not recognise, which is why nothing needs reserving in advance.
- **Adding a `board.json` field is free**, as long as its absence has a sane
  default.
- **Renaming or repurposing anything is a version bump.** `version` exists for
  exactly this and nothing has yet needed it.
- **Removing a fallback is the dangerous change.** The three "sidecar outranks
  `board.json`, `board.json` still works" rules (notes, waveforms, the timeline)
  are what let an old board open in a new mbrd. Deleting either half of one
  silently breaks files that already exist.

### An older build opening a newer file loses what it does not know

Stated on its own because `timeline` is the field where it costs something a
person would miss, and because the obvious protection turns out not to exist.

The reader builds an explicit board object field by field. Builds from
2026-09-14 on keep every top-level `board.json` key they do not know in a side
bag (`extra`, `unknownKeys()` in `board-schema.ts`) and write it back on save,
after everything they own, so a newer build's field survives an older one's
save. Builds before that drop such a key **on load**, and it is then absent
from the next file that build writes. A board with six months of history,
opened once in one of those builds and saved, comes back with none. Keys inside
an item other than `meta` are not carried by either. A build from before the
history had its own files (v0.316 and older) does not look in `timeline/` at
all, so it opens a newer file with no past and saves it that way.

The tempting answer is to move `version` in `manifest.json` so an old build
declines the file instead of flattening it. **That does not work, and the reason
is worth writing down rather than rediscovering.** Older builds do not decline a
newer file: the check is `if (Number(manifest.version) > FORMAT_VERSION)
console.warn(…)` and the load continues. Bumping the number changes a console
message and nothing else. There is no build in the wild that would refuse, so
there is nothing to protect with, and bumping would only cost every existing
reader a warning about a file it can open perfectly well.

**So the decision is: history is losable by an older build, and it is written
down here rather than defended in code.** The blast radius is bounded by what a
version actually is (a convenience copy of something you still have in front of
you), and the alternative buys nothing at all.

The one thing this *does* impose is on any future field: if something is ever
added that a person would rather lose the whole file than silently lose, the
protection has to be a real one (a `format` change, which older readers do
refuse), not a `version` bump.

---

## The open question

**Should assets ever be allowed to live outside the file?**

The schema already reserves `asset: { external: { path } }` for it, and there is
a real case: a board of 4K video is gigabytes, and every save rewrites all of
it.

Against it, plainly: **it ends promise 1.** A board stops being one thing you
can send someone. It becomes a file plus a directory, and the failure mode is
the worst kind: the board opens, looks fine, and three photographs are grey
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
decision and nothing should be built for it until it is made**. A pull request
implementing any of the three would be premature, but the discussion is welcome
in an issue.
