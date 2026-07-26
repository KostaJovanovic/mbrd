# mbrd — roadmap

Captured 2026-07-25, reordered by effort. The original list had two items
numbered 11 and two numbered 16; they are renumbered here and nothing was
dropped.

Ordered easiest to hardest, in five tiers. Numbers are positional and shift
whenever something is added — the old A/B/C labels in parentheses are the
stable handles, as are the task IDs.

Effort is not the only thing that decides order of work. Several items in tiers
1–3 are cheap to *build* and expensive to build *wrong*; those carry a
**decide first** note. Tier 4 is the group where the decision costs more than
the code. Read the note before starting, not after.

---

## Tier 1 — minutes

### 1. Softish grid matches Middle *(was A4)*
Softish sets `--grid-alpha: 0.18` and `--grid-dot: 2.4px` against Middle's
`0.14` and `1.7px` — noticeably heavier dots. Deleting both declarations from
the `[data-whimsy="0"]` block inherits Middle's values, which is the whole fix.
Check it does not leave that block empty of anything else it needs.

Two lines. The smallest item on this list and fully specified.

### 2. Toasts for copy / cut / paste *(was A2)*
`copyItems` / `cutItems` / `pasteItems` in `state.js` are silent. Cut is the
one that actually needs it — items vanish into the bin with no confirmation.
`toast()` is in `util.js` and already fades.

### 3. Sticky notes at half size
`defaultSize('note')` in `renderers.js` returns `240 × 240`. One line to change,
and only affects new notes — existing boards keep whatever they were saved at.

**"Half" is ambiguous and the two readings are very different.** Half of each
side is `120 × 120`, which is a *quarter* of the area; half the area is about
`170 × 170`. The second is probably what a shrunken sticky should feel like,
but the first is what the words say.

Either way the type does not come with it. `.note-title` is set at
`var(--t-display)` — 28px in Softish — so on a 120px note the title alone eats
a third of the sheet, leaving about three lines of 16px body under it, and
`NOTE_MAX` is 512 characters. `.note-body` is `overflow: hidden`, so the excess
does not spill, it just stops being visible. If the small size is meant to hold
a real note rather than a word, notes need their own type step down from the
display ramp — that part is not a one-liner. Check the minimum resize limit
still sits below the new default.

---

## Tier 2 — an hour or two each

### 4. Paste under the cursor *(was A3)*
Today paste offsets from where the items were copied. It should land where the
pointer is if the pointer has moved since. `pasteItems(at)` already takes an
optional point and centres the clipboard bounds on it — this is mostly a
question of tracking the last pointer position in `input.js` and deciding when
"the cursor moved enough to mean somewhere else".

### 5. Rearrange shuffles positions, not just items *(was A5)*
`rearrange()` in `main.js` shuffles which item goes in which slot, but the
slots themselves come out of `arrange()` in the same order every time. The
layouts take a `seed`, so the fix is to vary it — and for `free`, to actually
scatter rather than no-op.

### 6. Live font switcher *(was A6)*
Buttons to swap `--font-display` / `--font-body` at runtime, to settle the type
by looking rather than arguing. Newsreader, Literata and Source Serif 4 are
already downloaded as variable woff2 with `opsz` axes and true italics.

**Worth doing early despite its position here:** it unblocks the parked serif
decision, which is otherwise waiting on a comparison page nobody has built.

### 7. Polaroid borders on Softish photos
In Softish, a photo gets a white mat around it with a deeper chin at the foot —
a print rather than a bare image. The tier is half-built for it already:
`--item-tilt` × `--tilt-max` gives Softish crooked cards, so the scattered-prints
reading is there and only the frame is missing.

Mostly CSS scoped to `[data-whimsy="0"]`, with three things to settle first:

- **Does the mat eat the photo, or grow the card?** `.item-body` is `inset: 0`
  and the image is `object-fit: cover`, with the item box sized to the photo's
  own aspect by `measureSize()`. Padding the body therefore crops the picture.
  Growing the item box instead means whimsy changes stored geometry, so
  switching tiers would resize every card on the board. The third way is to
  draw the mat *outside* the box on a pseudo-element with a negative inset —
  which is exactly the trick `.item::before` already uses for the selection
  ring, and it leaves the saved numbers alone. That is very likely the answer.
- **The caption plate wants to move.** `.item-label` is currently a translucent
  strip laid *over* the foot of the picture. A polaroid's chin is precisely
  where a caption belongs, so in Softish the label should sit on the mat rather
  than on the image. A win rather than a problem, but it is a second rule and
  the plate's `backdrop-filter` and `border-top` stop making sense there.
- **Corner radius fights the tier.** Softish runs `--radius: 26px`, a
  conspicuously round card; a real polaroid is square with at most a hint of a
  curve. Either `--shape-radius` is overridden for images here — going against
  the tier's own identity — or the frames come out round-cornered.

Unrelated to item 20's photo frame, and worth keeping straight: that one is a
correction *away* from polaroids, this one is an explicit ask *for* them.

### 8. The zoom detail ladder
Two rules, both specified:

- **GIFs freeze at 40% zoom**, not 30%. One constant: `STILL_ZOOM` in
  `viewport.js`, currently `0.3`. `stills.js` already does the rest.
- **Audio cards drop to a play/pause button** when zoomed out that far — no
  waveform, no name, no transport. `viewport.js` already puts `zoom-far` on
  `#world` below `FAR_ZOOM`, so this is a CSS rule against `.card-audio` plus
  centring and enlarging the one control that survives.

The one thing to settle: **these two want the same threshold, and today they
are different numbers.** `FAR_ZOOM` is `0.35` and `STILL_ZOOM` is `0.3`, so
chrome currently hides *before* GIFs freeze; moving the freeze to `0.4` inverts
that order. Simplest answer is one threshold at `0.4` driving both, which also
means the audio rule can hang off the existing `zoom-far` class unchanged.
Worth a glance at whether hiding item chrome at `0.4` is too early on its own.

Note this is a zoom ladder, not a hardware setting — it fires for everyone,
always, which is what makes it cheap. It removes two of the levers item 16 was
going to argue about.

### 9. Don't work on what is off screen
Half done already, and the half that is missing is the expensive one.

**Items are culled.** `sync()` in `items.js` mounts what falls inside
`visibleRect(CULL_MARGIN)` — 400 world px of slack — and detaches the rest,
discarding the node entirely unless its media is mid-playback. That part is
solid and needs nothing.

**The web is not.** `points()` in `web.js` is
`board.items.map(...)` with no visibility test at all, so every thread on the
board is recomputed whether or not any of it is on screen — and the comment
above `threads()` says the whole web is rebuilt *on every drag frame*. So
dragging one card on a 500-item board runs a spanning tree plus a
nearest-neighbour pass over all 500, several hundred times a second, to draw
threads that are almost all outside the viewport. `DENSE_LIMIT` (700) only
switches the second pass off; it does not reduce the first.

The fix is not simply "filter to the visible rect", and that is the whole
subtlety: the web is a *connected* structure. Cull the points and the spanning
tree changes shape, so threads would visibly reroute as you pan — the exact
failure that makes naive culling of a graph worse than none. Either the tree is
computed once over everything and only its visible edges are drawn (correct,
still O(n log n) per frame but no longer quadratic), or it is computed over the
visible set plus a margin and accepted as approximate near the edges. The first
is probably right, and the honest version of this item is "stop *drawing* what
is off screen, and stop *recomputing* what has not moved" — the web is rebuilt
on drag frames when only one item's position changed.

**Also worth a look while in here:** `sync()` walks every item on every view
change to decide what is visible. That is linear per frame and fine at hundreds,
not at tens of thousands; a spatial index is the answer if a board ever gets
there, and is over-engineering before then.

The Harsh lattice used to belong on this list and no longer does — it draws only
the marks inside the canvas, which is the viewport.

### 10. valjdakosta branding *(was A9)*
Mechanically small. Needs the assets and a decision on how loud it should be.

---

## Tier 3 — a real feature each

### 11. Search *(was A1)*
Find items by name, note text, link URL, file type. Open questions are only
about surface, not behaviour: an overlay palette (Ctrl+K) versus a sidebar
field. Should probably fly the viewport to a hit and select it, since a board
is spatial and a list of names without positions is not much use.

The flying is the part that is more than an afternoon — animating the viewport
to a point at a sensible zoom is new machinery.

### 12. Custom pictures on text and audio cards *(was A8)*
Let any card carry a chosen image. **Build this before 13** — album art is the
automatic case of exactly this feature, so the slot wants building once and
filling twice.

### 13. Album art from audio files *(was A7)*
Read embedded cover art (ID3v2 `APIC` for mp3, `metadata`/`covr` atom for m4a,
FLAC `PICTURE` block) and show it on the audio card. No dependency needed — the
frame headers are simple enough to parse by hand, the way `storage/zip.js` was.
Falls back to the waveform, which stays the card's identity when there is no
art.

Three container formats parsed by hand is the cost. Filling the slot from 12 is
the easy half.

---

## Tier 4 — the decision costs more than the code

### 14. `.mbrd` format documentation *(was B4)* *(discussion)*
No written spec exists. The format has grown a `notes/` directory of real
Markdown and a `waveforms/<hash>.json` sidecar set, both of which are
deliberate — the archive is meant to be openable and readable. That principle
should be written down before it is accidentally broken. Related open question:
whether assets should ever be split out of the file, which would stop a board
being one thing you can email.

Placed first in this tier because it is pure writing, and because every item
below it can break the format it describes.

### 15. Default palettes and 60-30-10 *(was B3)* *(discussion)*
Whether Papyrus / Absinthe / Tea rose / Peacock should be rebuilt on a
60-30-10 split. Worth knowing before that conversation: measured in OKLCH, the
existing palettes are already two-hue, with `--leafy` carrying the second at
44° (Absinthe), 93° (Tea rose) and 104° (Peacock) from the accent. Chroma never
exceeds 0.127 anywhere. So the raw material for a 60-30-10 reading is there;
the question is whether the *proportions* on screen match it, which is a
question about `app.css` usage rather than about the tokens.

### 16. Quality modes for weaker hardware *(was B7)* *(discussion)*
Distinct from 23: that one shrinks the file, this one shrinks the work. Item 8
has now taken the GIF freeze and the audio card out of this conversation by
making them unconditional, which leaves culling in `items.js` and the web's
`DENSE_LIMIT` as the levers still in play. Question is whether what remains is
one auto-detected mode, an explicit setting, or nothing at all now that the
zoom ladder covers the common case.

Cheap to build because the levers are built. The whole cost is deciding.

### 17. Sidebar reform *(was B1)* — **done, 2026-07-26**
The premise expired before the item did. The pressure this predicted — "search,
optimize, fonts and quality modes all want a home" — never arrived: search
shipped as an overlay, quality modes went automatic, and fonts folded into
Appearance. Nothing was queuing. So the problem was never what the sidebar *is*;
it was that one section had grown a heap of controls in no order.

What was done instead, on Kosta's list:

- **Appearance moved above Arrange**, and its section is Whimsy and Palette
  alone. Everything else — the two type menus, the pigment, the extraction
  switch, the grid, radius and panel sliders, Start over — sits under a closed
  **Advanced** fold. Whimsy and Palette between them already move every token
  the fold sets one at a time, which is the argument for the split.
- **The two type menus share a row.** One decision seen two ways.
- **Paper lost its control** and is derived from the pigment instead, with the
  whole sheet. Two colour pickers that could be put out of tune were the one
  mistake this panel made easiest to make.
- **The board's name became a field.** Type in it to rename.
- **Two hint paragraphs went**, and `--ls-scale` stopped moving with whimsy —
  tracking that shifts under the reader mid-slider reads as a bug.
- **Custom faces can be dropped in** (item 6's parked half, below).

Left alone deliberately: the grid is still described in two places (Show grid in
View, its strength and weight in Advanced), and Volume is still in View, where it
is not really a view setting. Both were in the proposal and neither was asked
for; recorded here rather than done.

### 18. Image palette extraction *(was B2)* *(discussion)*
Partly discussed already. Settled so far: cluster in OKLCH not RGB, exclude
near-neutral pixels from hue voting, let the harmony fall out of what the
photos contain rather than forcing one, and repair lightness afterwards so ink
on paper stays legible. **Open: two hues or three.** The token set has room for
two independent hues today — the accent trio and `--leafy` — so a third needs
either `--accent-warm` breaking away from the accent, or a new token with real
work to do in `app.css`. Also open: when it fires (a button, a one-time offer,
or silently on import). `setPigments()` in `ui/appearance.js` is the hook.

The hardest thing in this tier: a real clustering algorithm, plus a lightness
repair pass, plus a mapping onto 13 tokens.

---

## Tier 5 — large

### 19. YouTube (and video) embeds *(was C3)*
A pasted YouTube link becomes a player rather than a link card. Not much code —
URL parsing and an iframe, on top of the link card that already exists. It is
here for the principle, not the effort: **an embed breaks offline-first.** It is
a third-party iframe that phones home and tells them the board exists. Worth
deciding whether embeds are opt-in per item.

Same call that was made for you on link favicons, so it should be deliberate
rather than inherited.

### 20. Konami code → 90s skin *(was C4)*
Konami sequence swaps the whole interface for one built from
`C:\Users\kosta\Projekti\sajt90`. Large in volume, but with no unknowns — the
source is hand-written static HTML with one 4618-line stylesheet, and it is a
good fit because it is already CSS-variable driven, so the two projects share
an architecture and it can plug into the whimsy cascade rather than living
beside it.

What to take, verbatim:
- **Palette** — `--color-dark: #445f74`, `--color-mid: #80a4ba`,
  `--color-light-mid: #C8DCE8`, `--color-light: #F7FAFC`,
  `--color-border: #EDE9E4`, `--color-table-row: #E8F2F8`, page canvas
  `#B3BAB3`.
- **Type** — self-hosted, no CDN. `LT Remark` (body), `Redaction 10` /
  `Redaction 20` (headings, uppercase, `letter-spacing: 4px`,
  `text-shadow: 3px 3px`), `VCR OSD Mono` (numerals). Files under
  `sajt90/assets/ltremark/`, `redaction/`, `other_fonts/`.
- **The photo frame** — and this needs correcting from how it was described.
  There are no polaroid borders on that site: grep finds no `polaroid`, no
  `transform: rotate`, no `box-shadow` on photos, and no frame image asset.
  What exists is a flat card — `border: 3px solid #EDE9E4; padding: 4px;
  background: #F7FAFC;` around a `4/3` well with `object-fit: cover` and the
  caption outside the image at `0.75em` in `#80a4ba`. That reads as a print on
  paper, which is probably the impression being remembered. **Decide whether
  the skin reproduces that faithfully, or adds the rotation and drop-shadow a
  real polaroid has.** Faithful is one CSS rule; polaroid is a design choice.
  (Item 7 is a separate, deliberate ask for polaroids in Softish — the two
  should not be collapsed into one frame style.)
- **The 90s devices that genuinely exist there** — a real `<marquee>`,
  `2px outset` → `inset` beveled buttons, hard `4px 4px 0` unblurred shadows, a
  VCR-font hit counter, an "under construction" text banner, custom `.cur`
  cursors, 88×31 linkback buttons, `> ` ASCII list bullets, `wallpaper.jpg` as
  a fixed cover layer. There is **no** tiled background, no blink, no divider
  GIFs, no webring.

Whether this is a real reskin or a joke that lasts thirty seconds decides how
much of it is worth wiring to the token system — and that answer swings the
effort by an order of magnitude.

### 21. Cloud sync *(was B5)* — **closed as the cheap route, 2026-07-26**
The answer was "a synced folder is fine", so this drops out of the tier
entirely, and it needed no code: Export already writes a real file to a real
path, and where the File System Access API exists it writes back to the *same*
path on every later export. Put that path inside a folder Drive, iCloud, Dropbox
or OneDrive already watches and the sync is done by the client that was
installed to do it. Written up in the README under "Keeping boards in a synced
folder".

Not taken, and worth being explicit about why: the Drive API route needs OAuth,
a registered origin — which breaks `file://` and every local dev port —
re-consent roughly hourly with no backend, and a conflict policy written by
hand. It also puts a third-party fetch inside an app whose first promise is that
nothing leaves the machine. Conflicts are last-writer-wins, decided by the sync
client. If simultaneous editing becomes a real need it wants solving properly
(positions are absolute and there is no CRDT here), not approximated.

### 22. Mobile *(was C1)*
Touch already works — `input.js` handles pinch and two-finger pan. What does
not is the layout: the sidebar is a desktop panel, the bin and zoom controls
sit in thumb-hostile corners, and the resize grips are sized for a mouse. A
layout rework across most of `app.css`, with a real interaction question under
it (what does select-then-act mean without hover).

### 23. "Optimize board" *(was B6)* *(discussion — its own conversation)*
Flagged as needing separate discussion, and it does. Sketch as given: photos to
1200px on the long edge at 4:2:0 JPEG q87, audio to 192kbps mp3, video to 480p,
already-optimised files marked so they are never processed twice.

The things that make this its own conversation:
- **It is lossy and it is destructive.** Every other operation in this app is
  undoable. This one rewrites the bytes. Does the original survive anywhere?
- **The browser can do two of these three.** Canvas re-encodes images and
  `WebCodecs` can handle video, but there is no mp3 encoder in a browser —
  that means shipping one (LAME via wasm, ~200KB+) into a project with zero
  dependencies today, or transcoding to Opus in WebCodecs instead, which is
  better in every way except that it is not mp3.
- **Where the mark lives.** A per-asset flag in `board.json` versus a hash of
  the optimised bytes. The asset store is already content-addressed, so a
  re-encode changes the hash and dedupe interacts with this.
- **4:2:0 at q87 is a photo setting.** It is wrong for screenshots, line art
  and anything with text in it, which are exactly the things a moodboard
  collects. Whether to detect that or let it be lossy is a real choice.

### 24. 3D model support *(was C2)*
`.stl`, `.obj`, `.glb`. Needs a renderer, which means either WebGL by hand or
the first real dependency this project has taken. `formats.js` already knows
what these files *are*; today they land as named cards, which is a working
answer and not an embarrassing one.

Last because it is the only item that changes what this project is made of.

---

## Parked

- **Finalise the serif.** Fraunces is a placeholder chosen for its optical-size
  axis. Newsreader, Literata and Source Serif 4 are downloaded and their axes
  checked; the comparison page was never built. Item 6 would settle it faster.
- **Drag a selected-text URL onto the board.** Deliberately not supported —
  gating on `text/plain` would raise the drop overlay for every text drag
  across the window. Only `text/uri-list` is accepted.
- **Favicons on link cards.** Deliberately not built: it is a request to the
  linked site, which tells them the board holds a link to them, and it would
  make an offline board render differently from an online one.

---

# Status — end of 2026-07-25

Everything on this list that was not marked *(discussion)* is built. What
follows is the record of what landed and what did not, so the list above can be
read as history rather than as a plan.

## Done

**Tier 1** — items 1, 2, 3.
**Tier 2** — items 4, 5, 6, 7, 8, 9, 10.
**Tier 3** — items 11, 12, 13.
**Tier 5** — items 19, 20, 22, 24.

Three of those deserve a note, because they were not built the way this
document guessed.

**Item 9, "don't work on what is off screen."** Items were already culled; the
web was not. It is now split into a `build` that runs when geometry changes and
a `paint` that runs when the view changes, so panning across a board no longer
recomputes a spanning tree. Both quadratic passes inside `threads()` went with
it: the k-nearest search no longer allocates an array per point, and the
crossing test consults a grid of accepted threads rather than all of them. A
500-item board went from 72ms a rebuild to about 5ms, edge-for-edge identical.
Threads that are off screen also no longer get a fade element each, which is
what opening a 400-item board was spending eleven hundred DOM nodes on.

**Item 19, YouTube embeds.** Built opt-in *per click* rather than per item. A
stored `embed: true` would have turned one click today into a silent request
every time the board was opened afterwards, on any machine it was ever copied
to — which is the thing this item was placed in tier 5 to avoid. Nothing is
requested until the button on the card is pressed, and that was measured with
the network log open rather than reasoned about.

**Item 24, 3D models.** No dependency. `import/mesh.js` reads binary and ASCII
STL, OBJ and GLB/glTF by hand, and `canvas/model.js` draws them with one shared
WebGL context that every card blits from — because contexts are capped per page
at around sixteen, and a canvas that mounts and unmounts cards as you pan would
spend them all and then hand back blank cards.

## Not done, and why

**Item 12's parked question — finalising the display serif — is no longer
blocked, though it is still open.** Newsreader, Literata and Source Serif 4 are
still not in `web/assets/fonts/`; the scratchpad this document said they were
downloaded to is gone, and nothing here can fetch them without breaking the
no-third-party rule. What changed on 2026-07-26 is that they no longer need to
be *shipped* to be *tried*: dropping a woff2 onto the board registers it as a
face and puts it in both type menus, so the comparison this question needs can
be made by dragging three files in. Deciding to ship one is still a separate
step — an `@font-face` in fonts.css, the files, and a line in sw.js's SHELL.

Worth knowing about the drop-in path, since it is where a filename becomes CSS:
the family name is rebuilt rather than taken (`isFamily` in util.js is the
alphabet, `familyFor` in ui/fonts.js is the rebuilder), the bytes live in the
asset store under their own hash so they travel inside the `.mbrd`, and both the
packer and the autosave sweep had to learn that `settings.fonts` names bytes no
item claims — without that, a dropped face was deleted by the next autosave.

**Tier 4 and the rest of tier 5 are decisions, and they have been written up
rather than taken.** Item 14 turned out to be pure writing with one open
question at the end, so it is written: `docs/mbrd-format.md`. The other six —
items 15, 16, 17, 18, 21, 23 — each have a brief in
`research/decisions-2026-07-25.md`: what is actually true in the code today,
the options, and a recommendation. Four of the six close with little or no
code. Nothing was built for any of them.

## Corrections to this document

- **Item 5 said the fix was to vary the seed.** The seed was already being
  varied; `scatter` was the only layout that read it. All seven read it now.
- **Item 16's premise has mostly expired.** Item 8 made the zoom ladder
  unconditional and item 9 took the web's quadratics out, so the only quality
  lever left that is not automatic is `DENSE_LIMIT`.
- **The Harsh lattice is a canvas**, not a tiled image, and it draws only the
  marks inside the viewport. It no longer belongs on item 9's list and its
  colours are resolved in JS rather than read from tokens at paint time.

---

# Handover — the JS half, 2026-07-25

Written by the session doing JavaScript, for the session doing CSS. I touched
no `.css` file. Everything below is either done and needing styling, or a
correction to what this document said before.

## What you need to style

Four things now emit markup that has no rules yet. In rough order of how broken
they look without you:

**`#search` — the find palette (`ui/search.js`).** New, and the most exposed:
it is a `<div>` appended to `<body>` with no position of its own, so today it
lands at the bottom of the document flow. Structure:

```
#search[role=dialog]
  input#search-field[role=combobox]
  #search-hits[role=listbox]
    button.search-hit[role=option]   ( .is-at marks the keyboard highlight )
      span.search-kind               ( "image", "note", "audio" )
      span.search-name
      span.search-where              ( the matched snippet; often empty )
    p.search-note                    ( shown instead of rows when empty )
```

It wants to be a palette pinned near the top of the viewport, above the canvas
and above the sidebar. `.is-at` needs to be legible without hover, since the
arrow keys drive it and the pointer is usually nowhere near. `.search-where` is
a single line that should truncate rather than wrap.

**`.card-cover` — a chosen picture on a card (`canvas/renderers.js`).** Any card
that is not itself a picture can carry one: audio, text, link, note, generic.
The `<img>` is prepended inside `.card`, and the card also gets `.has-cover`, so
you can restyle the whole card rather than only the image. It should read as the
card's subject — album art, a diagram — not as decoration beside the name. On an
audio card it is the thing the waveform used to be alone in doing.

**`.card-audio` under `.zoom-far`.** Still yours, still unbuilt — roadmap item 8.
Note the threshold moved: `zoom-far` now engages below **0.4**, not 0.35.

**The Harsh grid.** Nothing for you to write, but it changed under you — see
below.

## What changed in JS that lands on your side

- **`FAR_ZOOM` and `STILL_ZOOM` are both `0.4`** and the comparisons agree
  (`<` in both). Chrome hiding and GIF freezing are one rung now. Anything you
  hang off `.zoom-far` fires earlier than it used to.
- **Sticky notes default to 120×120**, down from 240. Existing boards keep their
  saved sizes. `.note-title` at `var(--t-display)` is 28px in Softish, which on
  a 120px sheet leaves about three lines of body — the type step-down is yours
  and the small size is not really usable until it exists.
- **The Harsh grid draws real crosses now.** It was two elliptical gradients
  whose arms tapered to points; it is now one SVG polygon per mark, square
  ends, uniform density. The consequence for you: at Harsh the mark's colour and
  size are **resolved in JS and baked into a data URI**, so `--grid-major`,
  `--grid-minor` and `--grid-dot` no longer restyle it for free. `ui/appearance.js`
  hands the resolved values back on every look change and the grid repaints, so
  the sliders still work — but if you add a rule that changes those tokens by
  some route that does not go through `persist()` or `bus.emit('settings')`, the
  crosses will not notice. The other two tiers are untouched and still pure
  gradients.
- **`Free` is now labelled `Free (no layout)`** in the arrangement menu. It used
  to say "keep positions" and that stopped being true.

## Corrections to this document

- **Item 6 / Parked "finalise the serif": Newsreader, Literata and Source Serif 4
  are not in the repository.** `web/assets/fonts/` holds Fraunces and Geist and
  nothing else. The live font switcher exists and works, but it can only compare
  Fraunces against faces the operating system already has. Someone has to fetch
  those three woff2 files and their licences before the parked question can
  actually be settled.
- **Item 5 said the fix was to vary the seed.** The seed was already being
  varied; `scatter` was the only layout that read it. All seven read it now.

## Done, JS side

Items **2** (copy/cut/paste toasts), **3** (note size), **4** (paste under the
cursor), **5** (rearrange varies the slots, and `free` shakes in place),
**8** (the zoom ladder, JS half), **11** (search), **12** (a picture on any
card), **13** (album art — ID3v2, MP4 and FLAC parsed by hand, no dependency).

> Numbers in this section are as at the time of writing. Inserting item 9
> shifted everything from 10 up by one; they are corrected above.

Tier 4 is all marked *discussion* and none of it was decided here. Tier 5 was
not started: **19** breaks offline-first, **23** is destructive and lossy,
**24** would be this project's first dependency — three calls that belong to
Kosta, not to either of us.

## Not verified

Written by the JS session; the CSS session has since gone through most of it in
a real browser (headless Edge over the DevTools Protocol, against `serve.py`).

**Now verified.** Items 1, 6, 7, 8, 11, 12 and 13 have been looked at rather
than reasoned about, at all three whimsy levels. Doing so found three defects
the tests could not: `clone(null)` threw on any browser with no saved
preference and killed the whole Appearance panel on a first visit;
`releasePlayers()` queried only `'audio'`, so renaming a video card leaked a
player holding a decoded stream; and the polaroid mat came out on two sides
only, because an absolutely-positioned `<img>` with `width: auto` takes its
intrinsic size and drops the opposing offsets.

**The Harsh crosses were the worst of it, and are now rebuilt** — twice. The
tiled-SVG version minted 90 distinct images across 91 frames of one zoom; the
quantised version that fixed the churn made the marks blink in and out during a
resize, because a scaled image cannot land on the device pixel grid. They are
drawn on a canvas now. Measured at 0.086ms a paint, with zero blank frames
across 61 resize widths and 24 zoom steps.

**Still unverified:** whether importing a folder of tagged mp3s is still quick
now that each one is read for art — the one item on the original list that
needs real files rather than a synthetic board.
