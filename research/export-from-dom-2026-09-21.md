# Export the board's own cards, 21 September 2026

**Status: built, 7 October 2026.** `ui/capture.ts` and `ui/capture-css.ts`,
wired into `renderBoardCanvas()` through `drawCard()`. What the spike and the
build found, against the plan below:

- Unknowns 1-3 hold on Chromium under the deployed CSP (served by
  `research/export-trace/spike.mjs`): `data:` fonts inside the image render,
  `:root[data-whimsy]` rules match the `<svg>` root and its custom properties
  inherit, and a capture drawn at 300 ppi is sharp. About 100 ms a card.
- **Unknown 5: Firefox does not taint either.** It exports through the
  capture. The painters are Safari's path and the thumbnail's.
- The page's CSP refuses a `style` attribute written from script, even on a
  detached copy. Every inline style the capture moves goes through the CSSOM.
- An `<input>`'s value is a property, so a copy shows the default (a swatch's
  well came out black): `freeze()` writes values back as attributes.
- Stylesheet pictures (the fence's cork and grain, on `::after`) are inlined
  only for a card whose computed style reads them, pseudo-elements included.
- Fonts are inlined per card for the families its computed style names, not
  the whole of `fonts.css` (2.9 MB a card in the spike).
- A plain photograph is drawn from its original, scaled to the size the card is
  drawn at. A cropped, turned or cut-out one is its display copy, about 1024 px
  on the long edge.
- Captures are decoded SVGs cached by item, look and resolution, so the export
  box's preview redraws without capturing again.
- Painted rather than captured: models (a WebGL frame), and any card whose
  capture fails. The five common painters (picture, note, link, swatch, text)
  now follow the stylesheets for Safari.
- Check by eye with `node research/export-trace/export.mjs
  [chromium|firefox|painters]` after a build; `painters` is Chromium with the
  probe failed, which is the path Safari takes.

A plan, not yet started. The image and PDF export (`ui/snapshot.ts`) draws
every card with a painter of its own, restating the card stylesheets in canvas
calls. It has fallen too far behind them to be caught up, and this replaces the
painters with the cards themselves.

## Why the painters cannot keep up

Compared on one board holding one card of every kind, screenshotted live at
100% and exported at 1:1, in all three whimsy tiers:

| card | on the board | in the export |
| --- | --- | --- |
| picture, Softish | a print: mat, chin, italic caption on the chin (`quality.css`) | photograph to the edge, a plate across it |
| picture, Middle | no caption until hovered | caption plate always drawn |
| picture caption | opaque | 0.92 alpha, the photograph ghosting through |
| text, Markdown, CSV | name, then the file's own text (mono, or rendered) | large file name, "109 B · TXT" |
| sticky note | display face, fitted to fill the note | small body text, top left |
| link | faded wordmark, globe pill with the domain | "example.com" and "COM" |
| swatch | card with a rounded chip and the hex | a bare square, no card, no label |
| audio | AUDIO kicker, name, size, status line | a generic name card |
| archive | ARCHIVE kicker, size, Unzip, foot strip | a generic name card |
| every card face | `--paper-card` with a hairline | `--paper-2`, no edge |
| Harsh | square corners, ink hairlines | rounded, no edge |
| the board | wash and vignette gradients (`base.css` body) | flat `--paper` |

Not yet compared: video posters, documents, models, embeds, fences, ghosts.

The card styling is over a hundred kilobytes of CSS across three tiers, and every
row above is a rule somebody added to it without a painter to add it to. A
second implementation of that stylesheet will always be behind it. The only
export that stays right is one drawn *by* it.

## What makes it possible

`snapshot.ts`'s header says foreignObject taints the canvas. Measured on
2026-09-21 in Edge 145: an SVG holding HTML in a `<foreignObject>`, loaded as a
**`data:` URL** and drawn with `drawImage()`, leaves the canvas readable:
`getImageData()` returned the pixel. The same SVG as a **`blob:` URL taints it**
(SecurityError). So the route is open on Chromium, which is Chrome, Edge, the
desktop shell (Electron) and the Android shell (WebView), provided every URL
handed to it is a `data:` URL. Safari taints either way as far as is known, and
keeps the painters (see "Fallback").

`web/_headers` already allows `img-src data:`.

## The shape

Everything the export does *around* the cards stays: the plan and ppi
(`planRender`), the ground, the grain tile, the lattice, the sheet, the web,
the shadow underlay, the stage that sets a turned card down, the JPEG encoder,
the PDF writer, the options box and its preview. Only the per-card painter
changes, from "draw this card in canvas calls" to "draw this card's DOM".

One card at a time, not the whole board as one SVG. A card is small, its SVG is
small, a failure costs one card rather than the export, and it composes with
the stage and the underlay unchanged.

For each item, in z order:

1. **Build it detached.** `buildItem(item, tilt, false)` from
   `canvas/item-dom.ts`, the node the board would mount, built whether or not
   the board has it mounted, so a culled card exports as well as a visible one.
   Never read the mounted node: it carries hover, selection, grips, badges and
   drag state, and a culled card has none.
2. **Settle it.** A card built detached has not had what mounting gives it:
   the title card's typography (`applyTitleStyle()` in `ui/mobile-header.ts`),
   a GIF's frozen still (`canvas/stills.ts`), a video's poster, the waveform, a
   model's rendered frame. Each needs a way to be asked for its settled face
   without a live mount. This is the step most likely to grow: every renderer
   that paints late or into a `<canvas>` needs an entry.
3. **Freeze what an image cannot hold.** SVG-as-image runs no script and loads
   nothing but `data:` URLs. So, on a clone:
   - every `<img>`, `background-image` and `<image>` becomes a `data:` URL
     (`blob:` and same-origin alike), downscaled first to the pixel size the card
     is drawn at, or a 300 ppi A4 of photographs becomes hundreds of megabytes
     of base64;
   - every `<canvas>` becomes an `<img>` of its pixels;
   - every `<video>` becomes its poster, every `<iframe>` its cover or nothing;
   - every `<use href="assets/icons.svg#…">` gets its `<symbol>` inlined.
4. **Dress it.** The SVG carries a `<style>` holding the app's cascade in
   `APP_CSS_ORDER`, and the root `<svg>` carries the document's `data-*`
   attributes (`data-whimsy`, `data-palette`, `data-snap`, `data-no-tilt`, …)
   so that `:root[data-whimsy="0"] …` selectors match it, with `:root`'s
   custom properties inherited down through the foreignObject. Only if that
   proves unreliable, fall back to rewriting `:root` in the sheet text. Font
   faces the card actually uses (`fonts.css` and the board's own faces from
   `ui/fonts.ts`) go in as `data:` URLs in `@font-face`. `url()`s in the
   stylesheet that the card does not need are dropped, not inlined.
5. **Draw it.** Serialise (XMLSerializer, XHTML namespace), wrap at the card's
   world size with a `viewBox`, encode as a `data:image/svg+xml` URL, decode,
   and `drawImage()` it at `w * scale` pixels, onto the export canvas, or onto
   the stage when the card is turned. An SVG image rasterises at the size it is
   drawn, so 300 ppi should be sharp rather than an upscale; the spike checks.
6. **Keep the shadows out of it.** The underlay pass already draws every
   card's shadow below every card, as `#item-shadows` does. The card's own
   `box-shadow` (the title card has one, `canvas.css`) must be suppressed in
   the capture or it would be drawn twice.

The board ground's wash and vignette (`base.css` body) are a separate small
fix: three radial gradients painted after the paper fill, read as computed
values like the shadows are.

## Fallback

A one-pixel probe at the first export per session: draw a trivial foreignObject
`data:` SVG, read it back. If that throws or comes back blank, the engine is
one that taints (Safari) and the export uses today's painters. The painters stay
in the tree for that reason and for the library thumbnail (`boardThumb()`),
which runs on every board switch and cannot afford a DOM capture per card.
Nothing about the fallback may be silent in the code: one branch, named, and a
line in the module header saying which engines take it.

## Order of work

1. **Spike, before any structure.** One picture card, one note, one link, in
   Softish and Harsh, captured by hand in the page and compared with the live
   screenshot. Settles the six unknowns below. If any of the first three fails,
   stop and report back rather than work round it.
2. `ui/capture.ts` (or `canvas/capture.ts` if the layering prefers): build,
   settle, freeze, dress, draw, for one item. Pure helpers (CSS text
   assembly, the `:root` attribute copy, the URL inlining walk over a detached
   tree) are tested under `node --test` on hand-built nodes where they can be.
3. Wire it into `renderBoardCanvas()` behind the probe, card by card, picture
   first, then note, text, link, swatch, audio, archive, title, and the untested
   kinds. Each one lands with its row in the audit harness passing by eye.
4. Delete each painter the capture fully replaces, except where the thumbnail or
   the Safari fallback still reads it.
5. Measure a real board (`test.mbrd`, 106 items, mostly photographs) at 300
   ppi: time, peak memory, file size. The busy strip gets `job.step(done,
   total)` per card if it takes more than a second or two.

## Unknowns the spike settles

1. Whether a `data:` SVG carrying `@font-face` `data:` fonts renders them, in
   Chromium, **under the deployed CSP** (`font-src 'self' blob:` has no `data:`;
   the question is whether the page's policy reaches inside an image
   document). `serve.py` sends no headers, so this needs the policy injected
   locally or a built APK (`mobile/`, which stages `web/_headers`).
2. Whether `:root[data-…]` rules match the `<svg>` root and its custom
   properties inherit through the foreignObject.
3. Whether the capture is sharp at 300 ppi, and how large a `data:` URL
   Chromium will decode (a card with a 3000 px photograph inlined).
4. What does not paint inside an SVG image: `backdrop-filter`, `mix-blend-mode`
   against the ground (the card is drawn onto a transparent image, not onto the
   board), container queries (the title's `100cqw`), `text-wrap: balance`.
5. Firefox: taints or not.
6. Speed of `XMLSerializer` + base64 + decode per card at 300 ppi.

## How to check it

The audit harness used for the table above: headless Edge over CDP, a board
built by dropping one file of every kind plus a link, note, swatch, stickers and
a connection web, then for each whimsy tier a live screenshot at 100% and an
export at `25.4 × scale` ppi, which is 1:1. It should live in the repository as
`research/export-trace/audit.mjs`, beside `research/phone-trace/`, and the
comparison is by eye: there is no browser-driven suite (CLAUDE.md), and a pixel
diff against a live screenshot would fail on the toolbar alone.
