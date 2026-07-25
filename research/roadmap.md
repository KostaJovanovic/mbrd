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

Unrelated to item 19's photo frame, and worth keeping straight: that one is a
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
always, which is what makes it cheap. It removes two of the levers item 15 was
going to argue about.

### 9. valjdakosta branding *(was A9)*
Mechanically small. Needs the assets and a decision on how loud it should be.

---

## Tier 3 — a real feature each

### 10. Search *(was A1)*
Find items by name, note text, link URL, file type. Open questions are only
about surface, not behaviour: an overlay palette (Ctrl+K) versus a sidebar
field. Should probably fly the viewport to a hit and select it, since a board
is spatial and a list of names without positions is not much use.

The flying is the part that is more than an afternoon — animating the viewport
to a point at a sensible zoom is new machinery.

### 11. Custom pictures on text and audio cards *(was A8)*
Let any card carry a chosen image. **Build this before 12** — album art is the
automatic case of exactly this feature, so the slot wants building once and
filling twice.

### 12. Album art from audio files *(was A7)*
Read embedded cover art (ID3v2 `APIC` for mp3, `metadata`/`covr` atom for m4a,
FLAC `PICTURE` block) and show it on the audio card. No dependency needed — the
frame headers are simple enough to parse by hand, the way `storage/zip.js` was.
Falls back to the waveform, which stays the card's identity when there is no
art.

Three container formats parsed by hand is the cost. Filling the slot from 11 is
the easy half.

---

## Tier 4 — the decision costs more than the code

### 13. `.mbrd` format documentation *(was B4)* *(discussion)*
No written spec exists. The format has grown a `notes/` directory of real
Markdown and a `waveforms/<hash>.json` sidecar set, both of which are
deliberate — the archive is meant to be openable and readable. That principle
should be written down before it is accidentally broken. Related open question:
whether assets should ever be split out of the file, which would stop a board
being one thing you can email.

Placed first in this tier because it is pure writing, and because every item
below it can break the format it describes.

### 14. Default palettes and 60-30-10 *(was B3)* *(discussion)*
Whether Papyrus / Absinthe / Tea rose / Peacock should be rebuilt on a
60-30-10 split. Worth knowing before that conversation: measured in OKLCH, the
existing palettes are already two-hue, with `--leafy` carrying the second at
44° (Absinthe), 93° (Tea rose) and 104° (Peacock) from the accent. Chroma never
exceeds 0.127 anywhere. So the raw material for a 60-30-10 reading is there;
the question is whether the *proportions* on screen match it, which is a
question about `app.css` usage rather than about the tokens.

### 15. Quality modes for weaker hardware *(was B7)* *(discussion)*
Distinct from 22: that one shrinks the file, this one shrinks the work. Item 8
has now taken the GIF freeze and the audio card out of this conversation by
making them unconditional, which leaves culling in `items.js` and the web's
`DENSE_LIMIT` as the levers still in play. Question is whether what remains is
one auto-detected mode, an explicit setting, or nothing at all now that the
zoom ladder covers the common case.

Cheap to build because the levers are built. The whole cost is deciding.

### 16. Sidebar reform *(was B1)* *(discussion)*
The sidebar has grown to six sections and keeps growing — search, optimize,
fonts and quality modes all want a home. Worth settling what it *is* before
adding more: a settings panel, a tool palette, or an inspector that changes
with the selection.

Note the ordering pressure: items 6, 10, 15 and 22 all add a control. Either
this happens before them or it happens to them.

### 17. Image palette extraction *(was B2)* *(discussion)*
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

### 18. YouTube (and video) embeds *(was C3)*
A pasted YouTube link becomes a player rather than a link card. Not much code —
URL parsing and an iframe, on top of the link card that already exists. It is
here for the principle, not the effort: **an embed breaks offline-first.** It is
a third-party iframe that phones home and tells them the board exists. Worth
deciding whether embeds are opt-in per item.

Same call that was made for you on link favicons, so it should be deliberate
rather than inherited.

### 19. Konami code → 90s skin *(was C4)*
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

### 20. Cloud sync *(was B5)* *(discussion)*
See `research/gdrive implementation.md`. Recommendation there stands: try the
synced-folder route first, because Save already writes a real file to a real
path and a folder inside Drive/iCloud costs no code at all. The Drive API route
needs OAuth, a registered origin, and re-consent roughly hourly without a
backend. Decide conflict handling (last-writer-wins with a warning is cheap;
merging is not, since positions are absolute and there is no CRDT).

Sits in Tier 5 for the API route. **The cheap route is genuinely cheap** — if
the answer is "a synced folder is fine", this drops out of the tier entirely.

### 21. Mobile *(was C1)*
Touch already works — `input.js` handles pinch and two-finger pan. What does
not is the layout: the sidebar is a desktop panel, the bin and zoom controls
sit in thumb-hostile corners, and the resize grips are sized for a mouse. A
layout rework across most of `app.css`, with a real interaction question under
it (what does select-then-act mean without hover).

### 22. "Optimize board" *(was B6)* *(discussion — its own conversation)*
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

### 23. 3D model support *(was C2)*
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
