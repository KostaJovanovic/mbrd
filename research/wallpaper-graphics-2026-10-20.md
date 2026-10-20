# Wallpaper graphics at Softish (plan, 2026-10-20)

Decorative pieces that come in from the left and right edges of the window
at the Softish end of the whimsy dial, chosen and coloured by the board's
palette. Plants, gemstones, rocks, feathers, shells and the like. Anybody
can also upload their own picture, and mbrd cuts its subject out of the
background before setting it in. "Plant" below means any piece.
Nothing here is built yet. The decisions below are the maintainer's answers;
the open questions at the end are not decided.

## The look

The references are three studio botanical photographs (pincushion protea on
peach, black hellebore on mauve, green fritillaria on pale green) and the
Pixel 6 / Pixel 8 wallpapers on the "New board Sep 20" board. What they share:

- **Tone on tone.** The plant is the background's own colour a few steps
  deeper, with no second hue except a small accent in the centre of a flower.
- **Entering from an edge.** A stem crosses the side of the frame, and the
  plant fills one side while the rest of the frame stays empty.
- **Realistic, but soft.** Real forms and soft studio light, between a
  photograph and a Pixel render. No outlines and no flat cartoon fills.

## Decisions

| question | answer |
| --- | --- |
| Style | Between photoreal and the Pixel renders |
| Art source | High-quality placeholders now (code-drawn); the real source is decided later |
| Colour comes from | The chosen palette, including Dynamic and custom colours |
| Family | Sorted automatically from the palette's **accent** |
| Tone | Drawn from the **paper**, a few steps deeper, like the photos |
| Families | Rainbow 6, pink, brown, white, grey, dark (11) |
| Dark mode | A darker, moodier set: deep tones on the dark paper, low-key light |
| Placement | Left and right edges, **mirrored**: the same arrangement on both sides, flipped |
| Size | Scales with the window: wide on a desktop, slivers on a phone |
| Layer | Fixed to the window, **under the paper grain**, so the grain prints over the plants |
| Entrance | Slides in from the sides on app open / board open, on a palette change, on switching to Softish |
| Exit | Slides out on leaving Softish, and out-then-in on a palette change |
| Idle motion | Barely there: a few px of drift and a slow sway, a 10-20s cycle |
| Pan and zoom | No reaction; fixed to the screen |
| Quality | Animated at Full; a still picture at Balanced and below, and on phones |
| Setting | "Wallpaper graphics", on by default, shown only while Softish is chosen |
| Variety | Several arrangements per family; the board's id picks one, so a board always looks the same |
| Exports | Never in exports or snapshots: screen furniture, like the vignette |
| Pieces | Not only plants: gemstones, rocks, feathers and other decorative pieces too |
| Stones and gems | Come in from the sides like the plants |
| Own pictures | Allowed; mbrd cuts the subject out of the background first |
| Where an upload lives | In the board only: saved into the `.mbrd`, so it travels with the file |
| What it replaces | The built-in pieces on that board, whatever its palette |
| Upload colour | A switch per upload: its own colours (default) or toned to the palette |

## Families and pieces (proposed, not yet confirmed)

Sorted by `colourName()` (`colour-words.ts`), which already returns exactly
these eleven names from an OKLCh colour: red, orange, yellow, green, blue,
purple, pink, brown, black, white, grey. "Black" is the dark family.

| family | plants | stones, feathers, other |
| --- | --- | --- |
| Red | anthurium, red ginger, cockscomb | garnet cluster, red coral branch |
| Orange | pincushion protea, strelitzia, ranunculus | carnelian pebbles, pheasant feather |
| Yellow | mimosa sprigs, craspedia balls, ginkgo leaves | citrine point, honeycomb |
| Green | philodendron, haworthia, long thin grass blades, fritillaria bells | malachite slab, jade pebbles |
| Blue | eryngium thistle, delphinium, blue agave | lapis, sea glass, blue jay feather |
| Purple | lavender, allium globes, clematis | amethyst geode, fluorite |
| Pink | peony, cherry blossom, king protea | rose quartz, flamingo feather |
| Brown | dried pampas, fern fronds, autumn oak leaves | tiger's eye, petrified wood, owl feather |
| White | magnolia, cotton, lily of the valley | quartz cluster, swan feather, seashells |
| Grey | eucalyptus, lamb's ear, olive branch | stacked river stones, pigeon feather |
| Dark | black hellebore, black calla, aeonium rosettes | obsidian, black tourmaline, raven feather |

Each piece, or a small group of pieces, is one arrangement. That makes 5-6
per family. An arrangement can mix kinds, for example a fern with two
pebbles beside it. Every piece comes in from the side edges, stones
included. A stone is drawn so it reads as leaning in from the edge rather
than hanging in the air: a cluster or slab cut by the frame.

## Your own pictures

**Adding one.** "Add your own…" sits next to the setting. It takes a
picture by file, drop or paste. mbrd runs the background remover the
picture cards already use (`cutout()` in `canvas/matte.ts`: U²-Netp,
vendored, offline, in a worker; the desktop app uses its native matte).
That cuts the subject out, and the transparent result is cropped to the
subject's bounds and set in on both edges, mirrored, like the built-in
pieces.

**Checking the cut.** A preview shows the cut-out before it is kept, with
"Keep cut-out", "Use whole picture" and "Cancel". The remover finds the
most salient object, and on a busy photo that can be the wrong one or a
ragged edge. When the remover is unavailable (no worker, or a browser that
blocks canvas reads), the preview offers the whole picture only and says
why. `cutout()` never throws, so a failure is "the picture, uncut".

**Colour.** Each upload has a switch, "Tone to the palette", off by default.

- **Off:** the cut-out shows in its own colours.
- **On:** it is drawn in greyscale and mapped onto the board's tones
  (`--wp-1` to `--wp-hi`) by its lightness, so it sits like a drawn piece.
  That is an SVG filter (`feColorMatrix` to luminance, then
  `feComponentTransfer` tables), which follows a palette change as live
  as the drawn pieces do.

**Where it is kept.** In the board only. The cut-out is saved as an asset in
the `.mbrd` (`assets/`, content-addressed like any picture), and the board
gets one new field naming it, with its tone switch:
`wallpaper: { asset, tone }`. Anybody who opens the file sees it, and
another board is unaffected. Undo covers adding, changing and removing it,
since it is part of the board.

**What it replaces.** On a board with an upload, the upload replaces the
built-in pieces on both edges, mirrored, whatever the palette. A palette
change then re-tones it (if toned) instead of swapping it. Removing the
upload brings the built-ins back. A board with an upload but the setting
off shows nothing, like any other.

**Older copies.** An mbrd before this ignores the field and carries the
asset as an unreferenced file. It must not drop it on save, or the upload
is lost by opening the board in an old copy. That needs checking against
how the packer treats unknown fields and unreferenced assets. If it drops
them, the field has to go into `requires` in the manifest so an older copy
warns first.

**Limits.** The cut is made from a 320×320 mask scaled up, so a large
upload has a soft edge. The kept picture is stored at most 1600px tall,
which is plenty for an edge piece. An upload goes through the import
limits already in place (`IMPORT_LIMITS`), so a huge or odd file gets the
same question it does on the board.

## How it fits the app

**The element.** `<div id="wallpaper" aria-hidden="true">` goes in
`index.html` directly before `#grain`. It is `position: fixed; inset: 0;
pointer-events: none` and holds two side layers, `.wp-left` and `.wp-right`,
the right one being the left one under `scaleX(-1)`. It stacks over `body`'s
background (the paper, the blooms and the vignette) and under `#grain`,
which multiplies over it in the light and screens over it in the dark, as
it already does over the paper. Like `#grain`, it is outside `#viewport` so
nothing it does reaches the board's layers. The new id goes into
`tests/element-ids.test.js`'s view of things automatically, because
`index.html` writes it.

**The module.** `ui/wallpaper.ts`, with `initWallpaper()` and nothing at
import time. It has four jobs:

1. Read `--accent` and `--paper` off the root, sort the accent with
   `colourName()`, and use the dark set when `data-scheme="dark"`.
2. Pick the arrangement: a stable hash of `board.id` modulo that family's
   count.
3. Swap: when the family or arrangement changes (palette, board, scheme),
   send the old layers out and bring the new ones in.
4. Show and hide on the whimsy tier, the setting, the quality tier and
   reduced motion.

**The colour.** The art never names a colour. Every fill in an arrangement
is one of five tones set as custom properties on `#wallpaper`, mixed in
OKLCh from the paper and the ink:

- `--wp-1` to `--wp-4`: the paper taken 6% to 30% toward the ink, a little
  more chroma at each step.
- `--wp-hi`: a highlight a step above the paper.
- One `--wp-eye`: the accent itself, used only for the small centre of a
  flower, like the protea's tips and the hellebore's green middle.

A palette change re-tints a plant that is already on screen with no
redraw. Dynamic's re-extraction, which runs as pictures arrive, changes
only the tint. The plants are swapped only when the *family* changes, so a
board does not throw its plants out each time a picture is dropped.

**The art (placeholders).** One SVG per arrangement, under
`web/assets/img/wallpaper/<family>-<n>.svg`, in the realistic-but-soft
style:

- Layered shapes with linear and radial gradients for the soft light.
- Veins and petal edges as thin, low-contrast paths.
- No strokes as outlines.

Each sprig or leaf is its own `<g>`, which is how they sway slightly out of
step with each other. Fetched on first use, not precached (open question
5). When the real art arrives it replaces these files. A photograph cannot
be re-tinted the way these can, so real art means one image per family and
scheme, toned for that family's typical paper (open question 9).

**The sizes.** Each side layer is anchored to its edge and vertically
centred low, and part of it sits off-screen. Width per side is about
`clamp(64px, 22vw, 560px)`, with height following the art's aspect. On a
phone that leaves a sliver; on a wide window, stems with room.

**The motion.** Transform and opacity only, so it stays on the compositor:

- **In.** Each side goes from `translateX(∓60%)` and opacity 0 to rest over
  1.2s, ease-out. The right side is 120ms behind the left.
- **Out.** 0.5s, ease-in, back to its edge. A palette change runs out, then
  in.
- **Float.** Each sprig drifts 2-4px and turns ±0.6° about its stem's base,
  on a 12-20s cycle with each sprig's own period and phase. `will-change`
  is on the two side layers only.
- **Below Full and on phones.** No float. The entrance is a 0.3s fade.
- **`prefers-reduced-motion`.** No float and no slide. A fade only.
- **Hidden window.** The float pauses while the page is hidden.

**The setting.** One entry in `ui/settings-schema.ts`, "Wallpaper graphics",
default on. It is visible only while whimsy is Softish, the same rule the
other Softish-only rows follow, if any do; otherwise this is the first and
sets the pattern.

**Kept out of exports for free.** `ui/capture.ts` builds each card detached
in its own mount, and `ui/snapshot.ts` paints cards with their painters, so
neither reads anything fixed to the window: `#grain` is absent from exports
for the same reason. The build checks this once and changes nothing.

## What it touches, called out

- **`index.html`**: one new element. `404.html` is remade by `save.bat`.
- **A new stylesheet**, `wallpaper.css`: a `<link>` placed right after
  `base.css`. `tools/gen-shell.mjs` writes it into `SHELL` in `web/sw.js`, so
  **the service-worker cache changes**. The SVGs are not in `SHELL` unless
  question 5 says otherwise.
- **The `.mbrd` schema changes.** `board.json` gets `wallpaper: { asset,
  tone }`. The built-in pieces write nothing (the board's id picks them);
  only an upload does. The asset is a **new class of asset reference**, so
  it goes into `itemHashes()`/`timelineHashes()` *and*
  `boardAssetHashes()` in `storage/mbrd.ts`, with the assertion in
  `tests/mbrd.test.js`. Otherwise the cloud sync leaves it behind and the
  board comes back elsewhere without it. Also needed: an entry in
  `board-schema.ts`, the `research/docs/mbrd-format.md` row, and the
  older-copy check above.
- **Writers.** Adding an upload writes the user's board, so it asks
  `notUsersBoard()` first, and `tests/bench-guard.test.js` learns about it.
- **No generated catalogue changes.**
- **New tests**: the sort from accent to family, including palettes at the
  edges (near-grey accents, a near-black accent); the stable pick from a
  board id; and a check that every family has at least one arrangement file
  on disk.

## Build order

1. The system with the **green** family only: element, module, tones,
   setting, motion, quality and reduced-motion rules, exports excluded.
2. Your look at it in the app, at Softish, in light and dark, Full and
   Balanced, desktop and phone.
3. The other ten families, plants and the other pieces.
4. Your own pictures: upload, cut, preview, keep.

## Open questions

1. **The list of pieces above.** Keep it, or change which pieces go where?
2. **Dark mode.** The same plants drawn low-key on the dark paper, or every
   dark board gets the dark family (hellebore, calla, aeonium) whatever its
   accent?
3. **The Mobile board mode** (the phone-shaped sheet). Hide the plants
   there, as the grain already is, or keep them round the sheet?
4. **Phones generally.** Slivers, as decided, or off below a certain width?
5. **Offline.** Precache all the art (larger first install, works offline at
   once), or fetch a family on first use (a board opened offline for the
   first time in a new colour shows no plants)?
6. **First build size.** Three or four arrangements per family as listed,
   or one per family first and more later?
7. **The blooms.** The plants sit over the paper's soft accent glows (they
   are part of the paper itself). Should the glows stay, or fade where a
   plant is?
8. **Overlapping cards.** The plants are under the grain and so under every
   card. A card parked at the window's edge simply covers them. Fine, or
   should they fade when a card is over them?
9. **The real art, later.** Code-drawn SVG re-tints to any palette.
   Photographs or renders do not. When the real source is chosen, is one
   picture per family and scheme (22 sets) acceptable, or should the real
   art be greyscale and tinted in the browser (any palette, some loss of
   realism)?
10. **More than one upload per board.** One at a time (adding another
    replaces it), or several that the board cycles through or places
    differently on each edge? (Mirrored is decided, so one is the simple
    reading.)
11. **Where "Add your own…" lives.** In Appearance next to the setting,
    in the board's menu (it belongs to the board), or both?
