# mbrd

An infinite, freeform moodboard. Origin `(0,0)` sits at the centre of the board
and it extends forever in every direction, oriented like a maths plane — `+x`
right, `+y` **up**, so the top-right quadrant is `(+,+)` and the bottom-left is
`(-,-)`. Drop in files of any type — images, video, audio, text, anything — and
place them wherever you like, the way icons sit on a desktop with *align to
grid* switched off. Or let the arrangement engine lay them out from the centre
outward.

Everything runs in the browser. Nothing is uploaded. A board saves as a single
`.mbrd` file that carries the layout *and* the embedded bytes, so it opens the
same on any machine.

## Run it

```
server.bat
```

Opens `http://localhost:6273` and prints a QR for the LAN URL, so a phone on the
same Wi-Fi can open the same board. (`python serve.py` works too, and takes a
port: `python serve.py 8000`.)

There is no build step — no bundler, no npm install. The browser loads the ES
modules in `web/` directly, so an edit is one refresh away.

## Using it

| | |
|---|---|
| drag empty space | pan |
| `Shift`+drag empty | marquee select |
| `space`+drag | pan from anywhere |
| wheel | zoom to the cursor |
| drag an item | move the selection |
| corner grips | resize (media keeps its aspect; `Shift` frees it) |
| double-click an item | zoom to it — or play/pause a video, or edit a note |
| `0` / `F` | recenter on `(0,0)` / zoom to fit |
| arrows | nudge; `Shift` for a whole grid step |
| `Ctrl`+`A` / `Del` | select all / delete |
| `Ctrl`+`Z` / `Y` | undo / redo |
| `Ctrl`+`S` / `O` | save in this browser / open a `.mbrd` |
| `Ctrl`+`K` | find anything on the board, and fly to it |
| right-click, or long-press | the context menu |

Files arrive by drag-and-drop (folders included), clipboard paste, or **Add
files** in the sidebar. Pasted text becomes a note. Multiple files land arranged
around the drop point using the layout picked in **Arrange**.

### What actually displays

Pictures, moving pictures, sound, text, links — and 3D models, which the browser
does not draw with no help but does draw with about six hundred lines of it.
`.stl`, `.obj` and `.glb`/`.gltf` are parsed by hand in
`web/assets/js/import/mesh.js` and drawn by `web/assets/js/canvas/model.js`,
which holds **one** WebGL context for the whole app and blits it into each
card's own 2D canvas — contexts are capped per page at around sixteen, and a
board that mounts and unmounts cards as you pan would spend them all. Drag a
model to turn it over, wheel to zoom it.

A YouTube link can become a player, and does so only when you press the button
on the card. Nothing is requested from anyone before that, the choice is not
stored in the `.mbrd`, and it uses `youtube-nocookie.com` with
`referrerpolicy=no-referrer`. That is the app's one and only third-party
request, and it never happens by itself.

Everything else becomes a named card rather than a broken box:
`web/assets/js/import/formats.js` is a data table lifted from the sibling
[file-analyser](../file-analyser) project that knows what ~1350 extensions
*are*, so a `.sldprt` reads "SolidWorks · 3D / CAD" and a `.dwg` reads
"Diagrams". Regenerate it with `node tools/gen-formats.mjs` when that catalog
grows. A photo this browser can't decode (HEIC, JPEG XL, camera RAW) is detected
at import and falls back to the same named card. Real viewers for those formats
are a later job.

## The `.mbrd` file

A `.mbrd` is a ZIP with a different extension — the same trick `.3mf` and
`.docx` use. Rename one to `.zip` and look inside:

```
myboard.mbrd
├── manifest.json        { format, version, app, created, modified, title }
├── board.json           { view, settings, arrangement, items[] }
├── assets/<hash>.<ext>  the embedded bytes, deduped by content hash
├── notes/<slug>--<id>.md      one sticky note, as readable Markdown
└── waveforms/<hash>.json      one audio file's measured readings
```

Items reference bytes by SHA-256 hash, so the same photo dropped five times is
stored once. Media is stored uncompressed (it already is); the JSON is deflated.
The schema reserves `asset: { external: { path } }` for a future
link-instead-of-embed setting.

The archive is meant to be *opened*, not merely parsed — your notes are Markdown
files with your words in them, and the waveform data is a list of numbers laid
out sixteen to a line. **[`docs/mbrd-format.md`](docs/mbrd-format.md) is the
full specification**, including which changes are free and which are a version
bump.

**Save** and **Export** are two different things, on purpose:

- **Save** (`Ctrl`+`S`) keeps the board *in this browser*. No dialog, no file,
  no folder to pick — the common case is wanting the work kept, not wanting a
  document filed. It writes to the same IndexedDB store the autosave uses.
- **Export** writes the `.mbrd` itself. Where the browser has the File System
  Access API it writes back to the file you chose, so exporting the same board
  again overwrites it; elsewhere it downloads one. That is the copy you email,
  archive, or move to another machine.

The distinction matters because the two fail differently: a browser store can
be cleared by the browser, a file cannot — but a file only exists if you asked
for one. Either way the working board is mirrored into IndexedDB as you go, so
closing the tab mid-edit doesn't lose anything.

Anything that would throw away unsaved work — **New**, or opening another board
— stops and asks first, and the dialog offers to export before it goes ahead.
Escape, the backdrop and Cancel are all the harmless answer, and the harmless
one is what has focus when it opens.

### Keeping boards in a synced folder

There is no sign-in and no cloud account, and there does not need to be. Export
a board into a folder your Drive, iCloud, Dropbox or OneDrive client already
watches, and it syncs — the sync client does the work it was installed to do.
Where the File System Access API is available (Chrome, Edge), exporting the same
board again writes back to that same file, so after the first time it is one
keystroke and the copy in the cloud folder is current.

That is deliberately the whole feature. A Drive API integration would need
OAuth, a registered origin, re-consent roughly hourly with no backend, and a
conflict policy written by hand — and it would put a third-party fetch in an app
whose first promise is that nothing leaves the machine. Two people editing the
same board at once is last-writer-wins, decided by the sync client rather than
by mbrd. If that becomes a real problem, it is worth solving properly rather
than approximately.

## Layout

```
web/
  index.html  manifest.json  sw.js  404.html
  assets/css/     tokens.css        design tokens, all runtime-overridable
                  app.css           layout, canvas chrome, item cards
  assets/js/
    main.js       boot + the command set the UI and keyboard share
    state.js      board state, selection, undo/redo, clipboard
    geometry.js   where an item is and what it covers
    util.js       helpers
    canvas/       viewport.js  grid.js  items.js  input.js  web.js
                  stills.js  renderers.js  notes.js  audio.js
    import/       drop.js  formats.js (generated)
    arrange/      arrangements.js
    storage/      storage.js  mbrd.js  zip.js  idb.js  assets.js
    ui/           sidebar.js  appearance.js  menu.js  trash.js
serve.py  qr.py  server.bat  save.bat
tools/gen-formats.mjs   regenerates import/formats.js from file-analyser
tests/                  node --test; `npm test`. Dev only - nothing ships.
```

Dependencies run one way: `util`/`geometry` ← `state` ← {`import`, `storage`,
`canvas`} ← `ui`, with `canvas` reaching into `import` for the format catalog.
Anything that builds an item's DOM lives under `canvas/`, which is why the
renderers, the note editor and the audio transport are there rather than under
`import/` or `ui/`.

There is no build step, but there is a test suite: `npm test` runs it under
Node's own runner with zero dependencies installed. Nothing in `tests/` is
served to the browser.

The rendering model is one DOM layer (`#world`) moved by a single CSS
`translate(...) scale(...)`, so pan and zoom composite on the GPU and native
`<img>` / `<video>` / `<audio>` just work. Items outside the viewport are
detached from the DOM but kept in a cache, so a playing video survives leaving
and re-entering the screen. The grid is painted in *screen* space as CSS
gradients on `#viewport`, which is why it stays hairline-crisp at any zoom.

## The look

Papyrus and terracotta: warm paper, iron-gall ink, art nouveau lines. Buttons
are leaf-cut, panels are ogee-arched, the section rules are whiplash curves, and
the sidebar is a floating sheet with a deckled edge. Light only for now.

The sidebar is deliberately **not** modal — no scrim, nothing disabled behind
it. Leave it open and keep panning, zooming, dropping and dragging.

Four palettes ship (Papyrus, Absinthe, Tea rose, Peacock) and every colour,
radius and spacing value is a CSS custom property in `tokens.css`. The
**Appearance** panel writes them straight onto `:root`, so changes are live. A
look is saved twice on purpose: to `localStorage` (follows you across boards)
and into `board.json` (travels with the board, so someone else's board opens
looking the way they made it).

**A board can also take its colours from its own pictures.** Drop a few photos
in and the whole palette — paper, ink and pigment — is read off them: one to
three hues, clustered in OKLCh, held to the same lightness and chroma the four
presets were built on, and repaired afterwards so the ink still clears its
contrast ratio on the sheet. **Take colours from pictures** in the Appearance
panel is on to begin with: the palette is taken again every time a picture
lands, so the board keeps up with what is actually on it. Picking a colour by
hand — or a named palette — switches it off and leaves your choice alone.
The colours already taken stay put; the palette menu is the way back. Nothing is
uploaded — the pixels are read from a 48×48 canvas in your own browser.

Picking a pigment by hand does the same thing from one colour: the paper, its
three shades, the ink, the rules and the two other pigments are all rebuilt from
that hue, so a board stays one palette rather than an accent and a sheet chosen
at different times. The colour you picked is the colour you get — the sheet is
built around it rather than it being nudged to fit the sheet.

**And a board can be set in a face you supply.** Drop a `.woff2`, `.woff`,
`.ttf` or `.otf` onto the board and it becomes an entry in the two type menus
instead of a card. The bytes go into the asset store like a photograph, so the
face travels *inside* the `.mbrd` and someone else opens the board seeing what
you saw — which is the only way this can work in an app that fetches nothing.
The family name is rebuilt from the filename rather than taken from it
(`Fraunces[opsz,wght].woff2` becomes "Fraunces"), because that name ends up
inside a CSS declaration.

Whimsy and Palette are the whole panel until you open **Advanced**, which holds
the type menus, the pigment, the extraction switch and the grid, radius and
panel sliders. The board's name at the top of the panel is a field — type in it
to rename the board.

## Status

- **M1 — core canvas** ✅ viewport, grid, the four native renderers,
  place/select/move/resize, arrangements, `.mbrd` save/open, IndexedDB
  recovery, PWA shell, papyrus interface.
- **M2** — viewers for the formats that need a decoder (PDF, PSD, HEIC/RAW,
  archives, fonts), thumbnails, rotation.
- **M3** — more arrangements, layers list.
- **M4/M5** — Tauri wrap for Windows/Linux, then Android and iOS/iPadOS.
- **Later** — optional self-hosted sync of `.mbrd` files.

See `PLAN.md` for the full design.

## Saving your work

```
save.bat
```

Bumps the version stamp (`web/assets/js/version.js` and the service-worker cache
epoch), then commits and optionally pushes. It offers to `git init` on first run.
