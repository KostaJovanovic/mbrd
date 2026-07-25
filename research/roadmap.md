# mbrd — roadmap

Captured 2026-07-25. The original list had two items numbered 11 and two
numbered 16; they are renumbered here and nothing was dropped.

Three groups: things that can be built as specified, things that need a
decision before anyone writes code, and things large enough to be their own
project. The middle group is the important one — several of these are cheap to
build and expensive to build *wrong*.

---

## A. Ready to build

Specified well enough to start. No open questions.

### A1. Search
Find items by name, note text, link URL, file type. Open questions are only
about surface, not behaviour: an overlay palette (Ctrl+K) versus a sidebar
field. Should probably fly the viewport to a hit and select it, since a board
is spatial and a list of names without positions is not much use.

### A2. Toasts for copy / cut / paste
`copyItems` / `cutItems` / `pasteItems` in `state.js` are silent. Cut is the
one that actually needs it — items vanish into the bin with no confirmation.
`toast()` is in `util.js` and already fades.

### A3. Paste under the cursor
Today paste offsets from where the items were copied. It should land where the
pointer is if the pointer has moved since. `pasteItems(at)` already takes an
optional point and centres the clipboard bounds on it — this is mostly a
question of tracking the last pointer position in `input.js` and deciding when
"the cursor moved enough to mean somewhere else".

### A4. Softish grid matches Middle
Softish sets `--grid-alpha: 0.18` and `--grid-dot: 2.4px` against Middle's
`0.14` and `1.7px` — noticeably heavier dots. Deleting both declarations from
the `[data-whimsy="0"]` block inherits Middle's values, which is the whole fix.
Check it does not leave that block empty of anything else it needs.

### A5. Rearrange shuffles positions, not just items
`rearrange()` in `main.js` shuffles which item goes in which slot, but the
slots themselves come out of `arrange()` in the same order every time. The
layouts take a `seed`, so the fix is to vary it — and for `free`, to actually
scatter rather than no-op.

### A6. Live font switcher
Buttons to swap `--font-display` / `--font-body` at runtime, to settle the type
by looking rather than arguing. Feeds directly into the parked serif decision;
Newsreader, Literata and Source Serif 4 are already downloaded as variable
woff2 with `opsz` axes and true italics.

### A7. Album art from audio files
Read embedded cover art (ID3v2 `APIC` for mp3, `metadata`/`covr` atom for m4a,
FLAC `PICTURE` block) and show it on the audio card. No dependency needed — the
frame headers are simple enough to parse by hand, the way `storage/zip.js` was.
Falls back to the waveform, which stays the card's identity when there is no
art.

### A8. Custom pictures on text and audio cards
Let any card carry a chosen image. Overlaps A7: album art is the automatic case
of the same feature, so build the slot once and have A7 fill it.

### A9. valjdakosta branding
Needs the assets and a decision on how loud it should be. Mechanically small.

---

## B. Decide before building

### B1. Sidebar reform *(discussion)*
The sidebar has grown to six sections and keeps growing — search, optimize,
fonts and quality modes all want a home. Worth settling what it *is* before
adding more: a settings panel, a tool palette, or an inspector that changes
with the selection.

### B2. Image palette extraction *(discussion)*
Partly discussed already. Settled so far: cluster in OKLCH not RGB, exclude
near-neutral pixels from hue voting, let the harmony fall out of what the
photos contain rather than forcing one, and repair lightness afterwards so ink
on paper stays legible. **Open: two hues or three.** The token set has room for
two independent hues today — the accent trio and `--leafy` — so a third needs
either `--accent-warm` breaking away from the accent, or a new token with real
work to do in `app.css`. Also open: when it fires (a button, a one-time offer,
or silently on import). `setPigments()` in `ui/appearance.js` is the hook.

### B3. Default palettes and 60-30-10 *(discussion)*
Whether Papyrus / Absinthe / Tea rose / Peacock should be rebuilt on a
60-30-10 split. Worth knowing before that conversation: measured in OKLCH, the
existing palettes are already two-hue, with `--leafy` carrying the second at
44° (Absinthe), 93° (Tea rose) and 104° (Peacock) from the accent. Chroma never
exceeds 0.127 anywhere. So the raw material for a 60-30-10 reading is there;
the question is whether the *proportions* on screen match it, which is a
question about `app.css` usage rather than about the tokens.

### B4. `.mbrd` format documentation *(discussion)*
No written spec exists. The format has grown a `notes/` directory of real
Markdown and a `waveforms/<hash>.json` sidecar set, both of which are
deliberate — the archive is meant to be openable and readable. That principle
should be written down before it is accidentally broken. Related open question:
whether assets should ever be split out of the file, which would stop a board
being one thing you can email.

### B5. Cloud sync *(discussion)*
See `research/gdrive implementation.md`. Recommendation there stands: try the
synced-folder route first, because Save already writes a real file to a real
path and a folder inside Drive/iCloud costs no code at all. The Drive API route
needs OAuth, a registered origin, and re-consent roughly hourly without a
backend. Decide conflict handling (last-writer-wins with a warning is cheap;
merging is not, since positions are absolute and there is no CRDT).

### B6. "Optimize board" *(discussion — its own conversation)*
Flagged as needing separate discussion, and it does. Sketch as given: photos to
1200px on the long edge at 4:2:0 JPEG q87, audio to 192kbps mp3, video to 480p,
already-optimised files marked so they are never processed twice.

The things that make this its own conversation:
- **It is lossy and it is destructive.** Every other operation in this app is
  undoable. This one rewrites the bytes. Does the original survive anywhere?
- **The browser can do two of these three.** Canvas re-encodes images and
  `WebCodecs` can handle video, but there is no mp3 encoder in a browser —
  that means shipping one (LAME via wasm, ~200KB+) or transcoding to Opus in
  WebCodecs instead, which is better in every way except that it is not mp3.
- **Where the mark lives.** A per-asset flag in `board.json` versus a hash of
  the optimised bytes. The asset store is already content-addressed, so a
  re-encode changes the hash and dedupe interacts with this.
- **4:2:0 at q87 is a photo setting.** It is wrong for screenshots, line art
  and anything with text in it, which are exactly the things a moodboard
  collects. Whether to detect that or let it be lossy is a real choice.

### B7. Quality modes for weaker hardware *(discussion)*
Distinct from B6: that one shrinks the file, this one shrinks the work. The
levers already exist — culling in `items.js`, the GIF freeze in
`canvas/stills.js`, the web's `DENSE_LIMIT`, the fade machinery in `web.js`.
Question is whether this is one auto-detected mode or an explicit setting.

---

## C. Large

### C1. Mobile
Touch already works — `input.js` handles pinch and two-finger pan. What does
not is the layout: the sidebar is a desktop panel, the bin and zoom controls
sit in thumb-hostile corners, and the resize grips are sized for a mouse.

### C2. 3D model support
`.stl`, `.obj`, `.glb`. Needs a renderer, which means either WebGL by hand or
the first real dependency this project has taken. `formats.js` already knows
what these files *are*; today they land as named cards.

### C3. YouTube (and video) embeds
A pasted YouTube link becomes a player rather than a link card. Note this
breaks the offline-first property — an embed is a third-party iframe that
phones home and knows the board exists. Worth deciding whether embeds are
opt-in per item.

### C4. Konami code → 90s skin
Konami sequence swaps the whole interface for one built from
`C:\Users\kosta\Projekti\sajt90`. Explored — the source is hand-written static
HTML with one 4618-line stylesheet, and it is a good fit because it is already
CSS-variable driven, so the two projects share an architecture.

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
- **The 90s devices that genuinely exist there** — a real `<marquee>`,
  `2px outset` → `inset` beveled buttons, hard `4px 4px 0` unblurred shadows, a
  VCR-font hit counter, an "under construction" text banner, custom `.cur`
  cursors, 88×31 linkback buttons, `> ` ASCII list bullets, `wallpaper.jpg` as
  a fixed cover layer. There is **no** tiled background, no blink, no divider
  GIFs, no webring.

Whether this is a real reskin or a joke that lasts thirty seconds decides how
much of it is worth wiring to the token system.

---

## Parked

- **Finalise the serif.** Fraunces is a placeholder chosen for its optical-size
  axis. Newsreader, Literata and Source Serif 4 are downloaded and their axes
  checked; the comparison page was never built. A6 would settle it faster.
- **Drag a selected-text URL onto the board.** Deliberately not supported —
  gating on `text/plain` would raise the drop overlay for every text drag
  across the window. Only `text/uri-list` is accepted.
- **Favicons on link cards.** Deliberately not built: it is a request to the
  linked site, which tells them the board holds a link to them, and it would
  make an offline board render differently from an online one.
