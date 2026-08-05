# mbrd

An infinite, freeform moodboard that runs entirely in your browser.

Origin `(0,0)` sits at the centre and the board goes on forever in every
direction, oriented like a maths plane — `+x` right, `+y` **up**. Drop in files
of any kind, put them where you want them the way icons sit on a desktop with
*align to grid* switched off, or hand the job to the arrangement engine and let
it lay them out from the centre outward.

Nothing is uploaded, nothing is fetched, and there is no account. A board saves
as a single `.mbrd` file carrying the layout *and* the embedded bytes, so it
opens the same on any machine you send it to.

---

## Run it

```
python serve.py            # or: python serve.py 8000
```

Opens `http://localhost:6273` and prints a QR code for the LAN URL, so a phone
on the same Wi-Fi can open the same board. Python 3, no packages. On Windows,
`server.bat` is a wrapper around the same thing.

No bundler, no `npm install`, no build step. The browser loads the ES modules in
`web/` directly — an edit is one refresh away.

---

## Using it

| | |
|---|---|
| drag empty space | pan |
| `Shift` or `Ctrl` + drag empty | marquee select |
| `space` + drag, or middle-drag | pan from anywhere |
| wheel | zoom to the cursor |
| two fingers on a touchpad | scroll to pan, pinch to zoom |
| `Shift` + wheel or scroll | pan sideways |
| two fingers on a screen | pan and pinch-zoom |
| drag an item | move the whole selection, plus anything stuck to it |
| corner grip | resize freely; `Shift` holds the proportion |
| edge grip | resize that axis alone |
| double-click an item | zoom to it — or play a video, or edit a note |
| `0` / `F` | recenter on `(0,0)` / zoom to fit |
| arrows | nudge; `Shift` for a whole grid step |
| `Ctrl`+`A` / `Del` | select all / delete |
| `Ctrl`+`C` `X` `V` / `Ctrl`+`D` | copy, cut, paste / duplicate |
| `F2` | rename an item |
| `Ctrl`+`Z` / `Y` | undo / redo |
| `Ctrl`+`S` / `O` | save in this browser / open a `.mbrd` |
| `Ctrl`+`Shift`+`S` | export a `.mbrd` |
| `Ctrl`+`K` | find anything on the board and fly to it |
| right-click, or long-press | the context menu |

Files arrive by drag-and-drop (folders included), clipboard paste, or **Add
files** in the sidebar. Pasted text becomes a note. Several files at once land
arranged around the drop point using whatever layout **Arrange** is set to, and
they are pushed clear of whatever is already there rather than dropped on top of
it.

The three things you make rather than bring — a note, a colour, a link — each
come with a question, and nothing reaches the board until you answer it. A
colour opens a picker; a link asks for the address. A note is written on the
note: the sticky itself comes up in front of the board, at twice its size, with
the same editor, the same formatting bar and the same character count it has on
the board — because it *is* the card, lifted out for as long as you are writing
on it. **Add** drops it where it was made. Change your mind and there is
nothing to tidy up.

Seven arrangements ship — Spiral, Grid rings, Masonry, Cluster by type, By date,
Random scatter, and Free, which imposes no shape at all. `spacing` always means
the gap between edges, so it means the same thing in every one of them.

Drag a rubber band round a few cards and a small **Fence these 5** appears beside
the cursor, with the region it means held faintly on the board behind it — so you
can see what you would get before you take it. Take it and that outline becomes a
labelled region, or walk away and both withdraw themselves. A band that caught
nothing offers the empty region instead, to fill later. It arrives named — *Untitled fence 3* — with the name selected and
ready to be typed over, set large enough to read from wherever you can see the
whole region. Drag the fence by its label and everything inside comes along; drag
a card out and it is out; pull the fence's corner over three more and it has
them. Pulling it back in gathers what is already inside, the way shrinking a card
carries the notes stuck to it, and stops once they fill it — so nothing is dropped
or left hanging over the edge by a corner going a little too far. Everything else
about a region carries on working inside it: the board still pans where you drag
it, a band drawn within one takes the cards it went round and not the region
around them, and rearranging the board moves each region whole rather than dealing
its cards out. Right-click inside a fence and **Rearrange everything** becomes
**Rearrange fence** — the cards inside it are laid out in columns, below the
region's name, and the region closes around them.
There is no membership to manage, because there is none stored — a card is
in a fence when it is inside it, which is a thing you can see. On a phone, where
the board is a single column, each fence becomes a full-width heading with its
cards gathered under it. Deleting a fence takes away the line and leaves the
cards exactly where they were.

An empty board is not blank. It carries four hint cards — drop something, move
around, write a note, and a live Whimsy dial — which are real items on the board
rather than an overlay, so they pan and zoom like anything else. They leave for
good the moment the board has content of its own.

Deleting is not a one-way door: everything thrown away goes to the **bin** in
the corner and comes back by being dragged out of it to wherever you want it
now, which is usually not where it was when you deleted it.

### What actually displays

Pictures, moving pictures, sound, text, links, sticky notes — and 3D models,
which a browser does not draw with no help but does draw with about six hundred
lines of it. `.stl`, `.obj` and `.glb`/`.gltf` are parsed by hand in
`web/assets/js/mesh.js` and drawn by `canvas/model.js`, which holds **one**
WebGL context for the whole app and blits it into each card's own 2D canvas —
browsers cap contexts around sixteen, and a board that mounts and unmounts cards
as you pan would spend them all.

**A model card is a photograph of a model until you ask for the model.** The
first time one is drawn it takes its own picture — 450px on the long side, WebP,
kept in the board like any other asset — and from then on the card is an `<img>`.
**Rotate model** in its right-click menu hands the geometry back: drag to turn it
over, wheel to zoom, and clicking away photographs it again from wherever you
left it. The still is retaken on resize, and ignored — geometry redrawn instead —
when a card is dragged bigger than a still can honestly serve.

Photographs are mounted at a *display resolution*, not at the resolution they
arrived. A 6000×4000 phone picture is 96 MB of decoded bitmap however small the
card is drawn, and a board of them mounted at once is what kills a tab on a
phone. So a card-sized WebP copy is made once per session, one decode at a time,
and the original bytes stay untouched in storage for export.

Everything else becomes a named card rather than a broken box.
`import/formats.js` is a data table lifted from the sibling
[file-analyser](../file-analyser) project that knows what ~1350 extensions
*are*, so a `.sldprt` reads "SolidWorks · 3D / CAD" and a `.dwg` reads
"Diagrams". A photo this browser cannot decode (HEIC, JPEG XL, camera RAW) is
caught at import and falls back to the same named card.

---

## Two layouts, one board

A board has a **Desktop** layout and a **Mobile** one, and they share their
items and differ in everything spatial. Desktop is the infinite freeform plane
described above. Mobile is a vertical strip six or eight columns wide with a
masthead at the top — a feed you scroll rather than a plane you fly over,
because a phone has no room for the second thing.

The same items are in both. Position, size, spacing, grid, paper and the panel's
own dimensions are per layout; palette and typefaces are board-wide, so the two
are recognisably one board rather than two that happen to share pictures. Which
layout *you* are looking at is remembered per device and is deliberately not
saved into the file — a phone and a laptop each keep their own choice.

`docs/layout-settings.md` is the reference for which half of the split a setting
belongs to.

---

## Real size

A board's coordinates are floats with no unit, which is right for something you
compose by eye and useless the moment the board is about prints to hang or cards
to lay out. So a board carries one number, `settings.scale`, meaning **world
units per millimetre**. `settings.units` only picks the names the numbers are
dressed in; no geometry reads it.

You are not expected to type that number. Switch on a **paper outline** — A4,
A3, Letter — and drag its corners until the sheet looks right against the
photographs already on the board. A sheet of paper is a thing everybody has
held, so "that big" is an answer people have, where "0.37 units per millimetre"
is not. A scale bar in the corner then answers "how big is any of this" without
being asked, and the readout gives the size of whatever is selected.

---

## The `.mbrd` file

A `.mbrd` is a ZIP with a different extension — the same trick `.3mf` and
`.docx` use. Rename one to `.zip` and look inside:

```
myboard.mbrd
├── manifest.json               what this file is
├── board.json                  the board itself
├── assets/<hash>.<ext>         embedded bytes, deduped by content hash
├── notes/<slug>--<id>.md       one sticky note, as readable Markdown
└── waveforms/<hash>.json       one audio file's measured readings
```

Items reference bytes by SHA-256 hash, so the same photo dropped five times is
stored once. Media is stored uncompressed (it already is); the JSON is deflated.

The archive is meant to be *opened*, not merely parsed — your notes are Markdown
files with your words in them, and the waveform data is a list of numbers laid
out sixteen to a line. If mbrd disappeared tomorrow, someone with `unzip` would
still have their work. **[`docs/mbrd-format.md`](docs/mbrd-format.md) is the
full specification**, including which changes are free and which are a version
bump.

### Save and Export are two different things

- **Save** (`Ctrl`+`S`) keeps the board *in this browser*. No dialog, no file,
  no folder to pick — the common case is wanting the work kept, not wanting a
  document filed. It writes to the same IndexedDB store the autosave uses.
- **Export** (`Ctrl`+`Shift`+`S`) writes the `.mbrd` itself. Where the File
  System Access API exists it writes back to the file you chose, so exporting
  the same board again overwrites it; elsewhere it downloads one. That is the
  copy you email, archive, or move to another machine.

They fail differently, which is the reason they are separate: a browser store
can be cleared by the browser, a file cannot — but a file only exists if you
asked for one. Either way the working board is mirrored into IndexedDB as you
go, so closing the tab mid-edit loses nothing.

Anything that would throw away unsaved work — **New**, or opening another board
— stops and asks first, and offers to export before it goes ahead. Escape, the
backdrop and Cancel are all the harmless answer, and the harmless one is what
has focus when the dialog opens.

### Making a board smaller

**Optimize** trims a board down to what a board actually needs. Nothing about it
is automatic: it is a button, it says what it is about to do and what it weighs,
and it is one undo away from being taken back.

Pictures are capped at 1200px on the long side and rewritten as WebP at quality
0.82; album art and card covers get 600px rather than being dropped. Sound
becomes Opus at 96 kbit/s, keeping its tags and its artwork. A 13 MB FLAC comes
out around 1.8 MB and still sounds like the record on a board; a 3 MB photograph
drawn on a 300px card comes out under 100 KB. Nothing is touched unless it gets
at least ten percent smaller, because a re-encode that saves four percent has
spent a generation of quality on a rounding error. Animated GIFs, SVGs and
anything already efficient are left exactly alone.

Both encoders are the browser's own — a canvas writes the WebP, and WebCodecs
plus ninety lines of hand-written Ogg muxing writes the Opus — so this runs
offline with nothing downloaded. **Video is deliberately left alone.** Shrinking
a clip needs ffmpeg, 30 MB of single-threaded WebAssembly that pins a core for
the length of the clip, and for a board you look at that is not a trade worth
making.

Originals stay in the browser under `meta.was` until you discard them, which is
what makes the undo real rather than nominal — but they are stripped from an
export, so a `.mbrd` written after optimising carries only the small files.
**Discard originals** is its own question, because it is the one part of this
that cannot be taken back.

### Keeping boards in a synced folder

There is no sign-in and no cloud account, and there does not need to be. Export
a board into a folder your Drive, iCloud, Dropbox or OneDrive client already
watches, and it syncs — the sync client does the job it was installed to do.
Where the File System Access API is available (Chrome, Edge), exporting again
writes back to that same file, so after the first time it is one keystroke and
the copy in the cloud folder is current.

That is deliberately the whole feature. A Drive API integration would need
OAuth, a registered origin, re-consent roughly hourly with no backend, and a
hand-written conflict policy — and it would put a third-party fetch inside an
app whose first promise is that nothing leaves the machine. Two people editing
one board at once is last-writer-wins, decided by the sync client rather than by
mbrd. If that becomes a real problem it is worth solving properly rather than
approximately.

---

## Quality

One dial with three stops — **Light**, **Balanced**, **Full** — controlling
seven flags the canvas reads: GIF animation, card shadows, the thread web,
backdrop blur, UI animation, picture sharpness and how many cards are built per
frame. Full is the default and is *exactly* what the app did before the dial
existed, so installing a new version never quietly changes what a board looks
like. Light holds GIFs still, drops shadows, threads and animation, and is for a
tired phone. Any of the seven can be pinned by hand underneath, with a way back.

It is stored **per device**, in `localStorage`, and never in the `.mbrd` — how
hard someone else's phone should work is not a property of your board.

---

## The look

Papyrus and terracotta: warm paper, iron-gall ink, art nouveau lines. Buttons
are leaf-cut, panels are ogee-arched, the section rules are whiplash curves, and
the sidebar is a floating sheet with a deckled edge. Light only for now.

The sidebar is deliberately **not** modal — no scrim, nothing disabled behind
it. Leave it open and keep panning, zooming, dropping and dragging. It has three
tabs — **Board**, **Look**, **System** — and every control in it is one row in
`ui/settings-schema.js`, built by `ui/panel.js`. A control that does not apply to
the current layout is *absent*, not greyed out.

**Whimsy**, **Palette** and the two **type menus** are the whole of the Look tab
until you open the fold, which holds the pigment, the count of pictures the
palette reads, and the grid, radius and panel sliders. Whimsy is one axis from
Softish to Harsh, and it moves everything the fold sets one control at a time. At
the Softish end a fence stops being a marked-off part of the sheet and becomes a
cork board, which is the one thing on that axis that changes what something is
made of rather than how it is drawn.

Four palettes ship — Papyrus (terracotta), Absinthe (acid olive), Tea rose
(crimson) and Orca (deep teal). All four print on a near-neutral sheet, because
paper dyed far enough into its own hue to be told apart by it also tints every
photograph pinned to it; the colour goes into the pigments instead, hard enough
that most of these accents are the most saturated version of their hue sRGB can
show. Every colour, radius
and spacing value is a CSS custom property in `tokens.css`. The panel writes them
straight onto `:root`, so changes are live. A look is saved twice on purpose: to
`localStorage`, so it follows you across boards, and into `board.json`, so
someone else's board opens looking the way they made it.

**A board can take its colours from its own pictures.** Drop a few photos in and
the whole palette — paper, ink and pigment — is read off them: one to three hues,
clustered in OKLCh, held to the same lightness and chroma the four presets were
built on, and repaired afterwards so the ink still clears its contrast ratio on
the sheet. It happens on its own once the board is holding **three** pictures —
one photograph is not a collection, and a whole interface turning over on a
single dropped file reads as a fault — and from then on it runs again every time
a picture lands, so the board keeps up with what is actually on it. The palette
menu says **Dynamic** while that is what you are looking at, and choosing it
yourself skips the wait. Picking a colour by hand, or a named palette, hands the
sheet back and leaves your choice alone. Nothing is uploaded — the pixels are
read from a 48×48 canvas in your own browser.

Picking a pigment by hand does the same thing from one colour: the paper, its
three shades, the ink, the rules and the two other pigments are all rebuilt from
that hue, so a board stays one palette rather than an accent and a sheet chosen
at different times.

**And a board can be set in a face you supply.** Drop a `.woff2`, `.woff`, `.ttf`
or `.otf` onto the board and it becomes an entry in the type menus instead of a
card. The bytes go into the asset store like a photograph, so the face travels
*inside* the `.mbrd` and someone else opens the board seeing what you saw —
which is the only way this can work in an app that fetches nothing. The family
name is rebuilt from the filename rather than taken from it
(`Fraunces[opsz,wght].woff2` becomes "Fraunces"), because that name ends up
inside a CSS declaration.

---

## What reaches outside

Everything in mbrd renders the same with the network off, and opening a board
tells nobody. There are exactly three places that can talk to anyone else, and
all three are built so that it is a choice:

- **Embeds.** A YouTube or Spotify link is a plain card until you press the
  button on it. Nothing is requested from anyone before that, the choice is not
  stored in the `.mbrd`, and it uses the most private host each provider offers
  (`youtube-nocookie.com`) with `referrerpolicy=no-referrer`.
- **A poster frame for a clip this browser cannot decode.** A phone shoots
  H.265 and every desktop browser except Safari refuses it, so the card would be
  a black rectangle. The single-threaded ffmpeg core is pulled from a CDN the
  first time that happens and cached by the browser. Nothing about the board is
  sent — only the request for the core. Offline, the poster is simply not made,
  and the clip still plays the day the browser learns to.
- **Fonts you drop in** are embedded, never fetched — see above. This one
  reaches outside by *not* doing so.

---

## Layout

```
web/
  index.html  manifest.json  sw.js  404.html
  assets/css/     tokens.css   design tokens, all runtime-overridable
                  fonts.css    the bundled @font-face set
                  app.css      one stylesheet, in load order
  assets/js/
    main.js            boot, and `cmds` — the command surface the sidebar,
                       the keyboard and the context menu all drive
    state.js           board state, selection, undo/redo, clipboard, trash
    geometry.js        where an item is and what it covers
    measure.js         world units ↔ millimetres, inches, feet
    mesh.js            STL / OBJ / GLB parsed by hand
    quality.js         the three-stop dial and its seven flags
    layout-settings.js the Desktop/Mobile settings split
    util.js
    canvas/    viewport.js  grid.js  items.js  input.js  spatial.js  web.js
               renderers.js  model.js  notes.js  audio.js  video.js
               display.js  stills.js  paper.js  ghosts.js  embed.js
               mobile-frame.js  exit-anim.js
    import/    drop.js  budget.js  artwork.js  formats.js (generated)
    arrange/   arrangements.js
    storage/   storage.js  mbrd.js  zip.js  idb.js  assets.js
    optimize/  optimize.js  picture.js  opus.js  media.js  ui.js
    ui/        sidebar.js  panel.js  settings-schema.js  appearance.js
               pigments.js  look.js  fonts.js  quality.js  menu.js  trash.js
               search.js  scalebar.js  dialog.js  mobile-header.js  idle.js
serve.py  qr.py  server.bat  save.bat
tools/   gen-formats.mjs    regenerates import/formats.js from file-analyser
         preset-oklch.mjs   prints the OKLCh ranges the palettes were built from
tests/   node --test; `npm test`. Dev only — nothing here ships.
docs/    mbrd-format.md  layout-settings.md  browser-support.md
```

### How it holds together

Dependencies run one way: `util`/`geometry` ← `state` ← {`import`, `storage`,
`canvas`} ← `ui`, with `canvas` reaching into `import` only for the format
catalog. `tests/layers.test.js` executes that graph, so a `ui/` import inside
`canvas/` is a test failure rather than a style note. Anything that builds an
item's DOM lives under `canvas/`, which is why the renderers, the note editor
and the audio transport are there.

**`state.js` is the only door.** Every board mutation goes through it and emits
on a shared bus; subsystems subscribe and never call each other. Undo is
command-based — each mutation pushes its own inverse — so history is exact
rather than diffed.

**Nothing is a dependency.** `storage/zip.js` inflates its own entries,
`mesh.js` reads STL/OBJ/GLB by hand, `import/artwork.js` walks ID3v2 tags, MP4
atoms and FLAC blocks itself, `optimize/opus.js` muxes its own Ogg, and
`ui/pigments.js` does its own OKLCh. That is the repo's one real property: zero
runtime dependencies. A new format is a few hundred lines of header reading in
the same style, not an npm package.

**The rendering model** is one DOM layer (`#world`) moved by a single CSS
`translate(...) scale(...)`, so pan and zoom composite on the GPU and native
`<img>` / `<video>` / `<audio>` simply work. Items outside the viewport are
detached but cached, so a playing video survives leaving and re-entering the
screen; which items are near the screen is answered by a uniform spatial grid
rather than by scanning every item every frame. The background grid is painted
in *screen* space on `#viewport`, which is why it stays hairline-crisp at any
zoom, and the same is true of the axes, the scale bar and the paper sheet.

**The web** — the threads drawn between item centres on Desktop — obeys one
rule: no two may cross. A Euclidean minimum spanning tree first, which
guarantees one connected piece and provably contains no crossing, then every
other thread that fits, shortest first, which is what makes the result look like
a web instead of a few long diagonals thrown over everything.

---

## Browser support

Chrome and Firefox, current and one prior major. Safari 18.4+ is the tested
target; **Safari 16.4 is the floor**, where WebKit shipped
`CompressionStream('deflate-raw')` — below it a `.mbrd` written by a modern
browser cannot be read at all, and the app says so at startup rather than
failing later. `docs/browser-support.md` states the contract and lists what
degrades where.

---

## Working on it

```bash
python serve.py [port]            # dev server on 6273
npm test                          # node --test over tests/ — no install, no deps
node --test tests/state.test.js   # one file
node tools/gen-formats.mjs        # regenerate import/formats.js
```

Contributions are welcome. **[`CONTRIBUTING.md`](CONTRIBUTING.md)** is the place
to start — how to run and test it, the five invariants that are easy to break by
accident, and where a given kind of change belongs.
**[`docs/architecture.md`](docs/architecture.md)** is how the app is put
together, and answers *why is this not built on a framework* with the line counts
behind it. `AGENTS.md` covers style, naming and commit conventions.
[`research/`](research/README.md) holds the reasoning behind past decisions.

Module headers in this codebase carry the *why*, often at length: read the top of
a file before changing it.

A handful of invariants are enforced by the suite rather than by memory — the
layering graph, no browser globals at module import time, every shipped asset
present in the service worker's `SHELL`, a licence file beside every bundled
font. `window.mbrd` is a deliberate console handle (`mbrd.board`,
`mbrd.cmds.fit()`, `mbrd.vp`).

---

## Status

- **M1 — core canvas** ✅ viewport, grid, native renderers, place / select /
  move / resize, arrangements, `.mbrd` save and open, IndexedDB recovery, PWA
  shell, papyrus interface.
- **Since** ✅ 3D models, sticky notes, the bin, search, the relationship web,
  real-size measurement and the paper sheet, the Mobile layout, the quality
  dial, palette extraction from pictures, embedded fonts, the optimiser.
- **Next** — viewers for the formats that still need a decoder (PDF, PSD,
  HEIC/RAW, archives), a layers list, more arrangements.
- **Later** — Tauri wrap for Windows and Linux, then Android and iOS/iPadOS;
  optional self-hosted sync of `.mbrd` files.

The original design document is kept at
[`research/old/PLAN.md`](research/old/PLAN.md); it describes the project before
most of it existed and is history rather than a plan.
[`CHANGELOG.md`](CHANGELOG.md) is what has actually changed.

---

## Licence

**GNU GPL v3 or later** — see [`LICENSE`](LICENSE).

Copyleft, deliberately. mbrd keeps your work on your own machine and in a format
you can open with `unzip`; a fork that quietly took either of those away would be
a worse program wearing this one's face. The GPL is what makes "you can always
get the source of the thing holding your boards" a property rather than a
promise. Bundled typefaces and their licences are in
[`THIRD-PARTY.md`](THIRD-PARTY.md).

**The `.mbrd` format itself is free to implement**, by anyone, under any licence,
with no permission needed — see [`docs/mbrd-format.md`](docs/mbrd-format.md). The
GPL covers mbrd's *source*, not the format it stores work in: an implementation
in any language, open or closed, is fine and is the point. A file format that
only one program can read is a worse place to keep your work.
