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

Files arrive by drag-and-drop (folders included), clipboard paste, or **Add
files** in the sidebar. Pasted text becomes a note. Multiple files land arranged
around the drop point using the layout picked in **Arrange**.

### What actually displays

Pictures, moving pictures, sound and text — the four things a browser can draw
with no help. Everything else becomes a named card rather than a broken box:
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
└── assets/<hash>.<ext>  the embedded bytes, deduped by content hash
```

Items reference bytes by SHA-256 hash, so the same photo dropped five times is
stored once. Media is stored uncompressed (it already is); the JSON is deflated.
The schema reserves `asset: { external: { path } }` for a future
link-instead-of-embed setting.

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
