# mbrd

A moodboard that runs in your browser. Drop in images, video, audio, 3D models,
notes and links, arrange them on a canvas that goes on forever, and save the
whole board as a single file.

Nothing is uploaded and there is no account. Everything stays on your computer.

## Run it

```
python tools/serve.py
```

Then open `http://localhost:6273`. It also prints a QR code, so a phone on the
same Wi-Fi can open the same board. Needs Python 3 and nothing else — no install,
no build step. On Windows, double-click `server.bat` instead.

## Controls

| | |
|---|---|
| drag empty space | pan around |
| `space` + drag, or middle-drag | pan from anywhere, even over an item |
| wheel | zoom to the cursor |
| `Shift` + wheel | pan sideways |
| two fingers on a touchpad | scroll to pan, pinch to zoom |
| two fingers on a screen | pan and pinch-zoom |
| `0` / `F` | back to centre / fit everything on screen |
| `Shift` or `Ctrl` + drag empty space | select several items |
| `Ctrl`+`A` / `Del` | select all / delete |
| drag an item | move it, and anything selected or stuck to it |
| corner grip | resize; hold `Shift` to keep the proportions |
| edge grip | resize one direction only |
| arrows | nudge; `Shift` moves a whole grid step |
| double-click | zoom to an item, play a video, edit a note |
| `F2` | rename |
| `Ctrl`+`C` `X` `V` / `Ctrl`+`D` | copy, cut, paste / duplicate |
| `Ctrl`+`Z` / `Y` | undo / redo |
| `Ctrl`+`K` | search the board and jump to a result |
| `Ctrl`+`S` / `Ctrl`+`O` | save in this browser / open a `.mbrd` |
| `Ctrl`+`Shift`+`S` | export a `.mbrd` file |
| right-click, or long-press | menu |

Add files by dragging them in (folders work too), pasting from the clipboard, or
using **Add files** in the sidebar. Pasted text becomes a sticky note.

## What it does

- **Shows almost anything.** Images, video, audio, sticky notes, links and 3D
  models (`.stl`, `.obj`, `.glb`) all display properly. Around 1,350 other file
  types show up as a labelled card that says what they are, so a `.sldprt` reads
  "SolidWorks · 3D / CAD" instead of appearing broken.
- **Arranges for you.** Seven layouts — spiral, grid, masonry, by type, by date,
  scattered, or free-form. Use one for the whole board or just part of it.
- **Groups things with fences.** Draw a box round some cards to make a named
  region. Move the fence and everything inside comes with it.
- **Has a bin.** Deleted items go to the corner and can be dragged back out.
- **Fits phones too.** Each board has a desktop layout and a mobile one. Same
  items, arranged differently — a canvas on a laptop, a scrolling column on a
  phone.
- **Measures real size.** Turn on a paper outline (A4, Letter…) and drag it until
  the sheet looks right next to your photos. From then on the board knows how big
  everything is in millimetres or inches — useful for prints and layouts.
- **Picks up your colours.** Once the board holds three pictures, the whole
  interface recolours itself from them. Four ready-made palettes are there if you
  would rather choose. You can also drop in a font file and use it.
- **Runs on tired hardware.** A quality setting with three steps trades effects
  for speed. Full is the default.
- **Makes boards smaller.** **Optimize** re-compresses images and audio — a 13 MB
  music file typically comes out around 1.8 MB, still sounding fine. It tells you
  what it will do first, and it can be undone.

## Your files

A board saves as one `.mbrd` file that holds the layout *and* copies of
everything on it, so you can email it or move it to another machine and it opens
the same.

A `.mbrd` is just a ZIP with a different name. Rename it to `.zip` and you can
open it: your images are in there as ordinary images and your notes as ordinary
text files. If mbrd vanished tomorrow, your work would still be readable.

**Save** (`Ctrl`+`S`) keeps the board inside this browser — quick, no dialog.
**Export** (`Ctrl`+`Shift`+`S`) writes the actual `.mbrd` file — that is the copy
to back up or send. Do both. The board is also saved automatically as you work,
so closing the tab by accident loses nothing.

Want it synced? Export into a Dropbox, Drive, iCloud or OneDrive folder and your
existing sync app handles it.

## Privacy

The app works with the internet switched off, and opening a board tells nobody.
Two things reach outside, and only if you ask: pressing play on a YouTube or
Spotify card, and generating a preview image for video your browser cannot read.

## Browsers

Chrome, Firefox, Edge and Safari 18.4 or newer. Safari 16.3 and older will not
work at all. Details in [`research/docs/browser-support.md`](research/docs/browser-support.md).

## Developing

TypeScript, no framework, no runtime dependency. There is a build step — a
browser cannot fetch a `.ts` module, so what the page loads is `assets/app.js`,
one bundle esbuild writes — which makes an edit `npm run dev` and a refresh
rather than a refresh alone. The built bundle is committed, so *running* it still
needs nothing fetched.

```bash
python tools/serve.py   # dev server on port 6273
npm test                # run the tests, no install needed
npm run dev             # rebuild the bundle on save (needs npm install)
```

[`CONTRIBUTING.md`](CONTRIBUTING.md) is where to start,
[`research/docs/architecture.md`](research/docs/architecture.md) explains how it is put together,
and [`research/docs/mbrd-format.md`](research/docs/mbrd-format.md) specifies the file format.
Contributions welcome.

## Licence

[GNU GPL v3 or later](LICENSE) — free to use, change and share, as long as
changes stay free too. The `.mbrd` format itself is free for anyone to implement
under any licence.
