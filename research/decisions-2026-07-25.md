# Six decisions

Written 2026-07-25, after finishing everything on the roadmap that was not
marked *(discussion)*. These six are what is left, and they are left because in
each case **the decision costs more than the code** — which is exactly what the
roadmap said about tier 4 and is now the only thing standing between it and
being empty.

Each brief is the same three parts: what is actually true in the codebase today
(measured, not remembered), what the options are, and a recommendation. The
recommendations are opinions and are meant to be argued with. Nothing here has
been built.

`.mbrd` documentation — roadmap item 14 — is **not** in this file. It turned out
to be pure writing with one open question at the end of it, so it was written:
see `docs/mbrd-format.md`.

---

## 1. Quality modes for weaker hardware *(item 16)*

### Where this stands now

Most of this item has been taken away from it by other work, and what is left is
smaller than the roadmap thought.

- **The zoom detail ladder is unconditional.** GIFs freeze and card chrome drops
  below 0.4 zoom, for everybody, always. That was the largest lever and it is
  spent.
- **Items are culled** to the viewport plus 400 world px, and an off-screen
  node is discarded outright unless its media is mid-playback.
- **The web is now culled too**, and its two quadratic passes are gone: a
  500-item board rebuilds its threads in about 5ms where it used to take 72ms,
  and panning no longer rebuilds anything at all.
- **The Harsh lattice draws only inside the canvas**, which is the viewport.
- `DENSE_LIMIT` (700) still drops the web to a bare spanning tree on very large
  boards, and it is now the only quality lever left that is not automatic.

### The options

1. **Nothing.** The ladder covers the common case and the remaining costs are
   bounded. A setting that most people never touch is a setting that has to be
   maintained forever.
2. **One auto-detected mode.** Watch frame times, and if they go bad, raise the
   thresholds — freeze GIFs earlier, drop chrome earlier, lower `DENSE_LIMIT`.
   No UI at all.
3. **An explicit setting.** A "reduce detail" checkbox. Discoverable, and one
   more thing in a sidebar that item 17 says is already too full.

### Recommendation

**Option 1, and close the item.** The measurements above are what this item was
worried about, and they are fine now. If a real board on real hardware stutters
later, option 2 is the one to build then, because it needs no sidebar space and
no decision from the user — and by then there will be a specific number to aim
at rather than a general anxiety.

The one thing worth doing regardless is cheap: **make `DENSE_LIMIT` follow
measured frame time rather than a constant.** That is option 2 in miniature, on
the single lever that is already there.

---

## 2. Sidebar reform *(item 17)*

### Where this stands now

Seven sections: Board, Content, Arrange, View, Appearance, By hand, Trash. Since
the roadmap was written, two of the four things it predicted would want a home
found one somewhere else — Search became a Ctrl+K palette, and the font switcher
went inside Appearance. Quality modes are recommended above as nothing.

So the pressure the item described has partly come off. What has not changed is
that the panel is three different kinds of thing wearing one coat:

- **Commands** — New, Open, Save, Export, Add files, Write a note, Rearrange.
- **Board settings** — grid, axes, snap, spacing, arrangement, appearance.
- **A list** — Trash.

### The options

1. **It is a settings panel.** Commands move out to a toolbar or live only on
   the keyboard and in the context menu. Cleanest conceptually, and it is the
   largest change: it needs a toolbar that does not exist.
2. **It is a tool palette.** Settings move into a modal preferences dialog.
   Backwards from where the app is now — the Appearance controls are the ones
   people actually play with, and burying them would be a loss.
3. **It is an inspector.** Contents change with the selection: nothing selected
   shows board settings, one photo selected shows that photo's properties. The
   most useful long-term and the most work, and it needs per-item properties
   that mostly do not exist yet.
4. **Leave it, but split the scroll.** Commands pinned at the top, settings
   scrolling under them, Trash out to the bin panel it already has. Small.

### Recommendation

**Option 4 now, option 3 as the direction.** Trash is already duplicated — the
bin button opens a panel with the same list — and removing that section is a
strict improvement for free. Pinning the command rows costs a `position: sticky`
and makes the panel usable at a phone's height, where today Save scrolls away.

Option 3 is the right end state, but it should follow per-item properties
existing, not lead them. Building an inspector with nothing to inspect would be
building the frame first.

---

## 3. Default palettes and 60-30-10 *(item 15)*

### Where this stands now

The measurement from the roadmap holds: in OKLCH, all four palettes are already
two-hue. `--leafy` carries the second at 44° from the accent in Absinthe, 93° in
Tea rose, 104° in Peacock. Chroma never exceeds 0.127 anywhere.

So the *raw material* for a 60-30-10 reading is present. The question was never
about the tokens; it is about the **proportions on screen**, which is a question
about `app.css`.

And there the answer is fairly clear: mbrd is not a 60-30-10 interface and
cannot easily become one. 60-30-10 assumes a page with regions. This is a canvas
whose entire middle is user content, where the app's own colour appears in a
sidebar, a bin, a grid and a selection ring. The "60" is not a colour the app
chooses — it is whatever photographs somebody dropped.

### The options

1. **Rebuild the palettes on 60-30-10.** Costs the existing look, which is
   genuinely good, for a rule that does not fit the surface.
2. **Apply 60-30-10 to the chrome only** — sidebar, panels, menus — and leave
   the canvas out of it. Coherent, and much smaller.
3. **Drop it.** Keep the two-hue palettes and state that as the system.

### What happened when it was tried

Option 1 was built and measured before being thrown away, so the argument above
is no longer only an argument.

Absinthe, Tea rose and Peacock were rebuilt on the reading that puts the
palette's hue in the ink and hands the accent to a contrasting one. Then every
painted pixel of a screenshot was assigned to its nearest token family, sidebar
open, three items on the board:

| | 60 band | 30 band | 10 band |
| - | ---- | ---- | ---- |
| Papyrus, untouched | 91.3% | 8.1% | 0.5% |
| Absinthe, rebuilt | 96.6% | 2.9% | 0.5% |
| Tea rose, rebuilt | 97.1% | 2.3% | 0.6% |
| Peacock, rebuilt | 97.4% | 2.1% | 0.5% |

**The rebuild landed further from 60-30-10 than the palette nobody touched.**
Two reasons, and neither is a tuning error:

- **The 30 band is text and hairlines.** Glyphs and one-pixel rules cover a few
  percent of a screen whatever colour they are printed in. No choice of pigment
  moves that number. A real 30 needs a large *filled* surface — the sidebar as a
  panel of colour rather than a sheet of paper — which is a change to what the
  app looks like, not to what it is coloured.
- **A near-neutral sheet makes it worse.** Tinting the paper down to let the ink
  carry the hue moved more pixels into the paper family and grew the 60.

And it looked wrong, which the numbers do not say on their own: with the paper
that neutral, Absinthe read as Papyrus with a rust accent rather than as a green
board.

### Recommendation

**Option 3, and it is now measured rather than argued.** Keep the two-hue rule
the palettes were built on: two hues, chroma capped near 0.13, accent for action
and `--leafy` for the second voice.

The four presets are back to exactly what they were, and 60-30-10 is off the
list — for the presets *and* for extraction, where it would have been the
obvious rule to reach for next. The constraint the attempt uncovered is written
up under item 4, because that is where it still bites.

---

## 4. Image palette extraction *(item 18)*

### Where this stands now

Settled in earlier conversations, and none of it has changed: cluster in OKLCH
not RGB, exclude near-neutral pixels from the hue vote, let the harmony fall out
of what the photographs contain rather than forcing one, repair lightness
afterwards so ink stays legible on paper. `setPigments()` in `ui/appearance.js`
is the hook.

**Scope, from Kosta directly: this is about palettes derived from the photos on
the board. The four preset palettes stay exactly as they are.**

### The two open questions

**Two hues or three.** The token set has room for two independent hues today —
the accent trio and `--leafy`. A third needs either `--accent-warm` breaking
away from the accent (it is currently a relative of it) or a new token that has
to be given real work to do in `app.css`, or it will be a colour that exists and
is never seen.

**When it fires.** A button, a one-time offer after an import, or silently on
import.

### One constraint, found the hard way

Extraction sets `--accent`. **Setting `--accent` repaints every sticky note on
the board**, because the note pack is derived from it:

```css
--note-1: color-mix(in srgb, var(--accent-warm) 34%, var(--paper-card));
--note-2: color-mix(in srgb, var(--accent) 17%, var(--paper-card));
--note-3: color-mix(in srgb, var(--leafy) 26%, var(--paper-card));
```

That derivation is right for the presets — it is what stops a note turning into
a stray office-yellow rectangle on a sage-green board — and it is wrong the
moment the accent stops being the board's own hue. Item 3's rebuild moved the
accent to a contrasting one and turned a green board's stickies peach, which is
the single most visible thing that went wrong with it.

The tint numbers are a note's *identity* — a board is written with tint 2 meaning
one thing and tint 3 another — so extraction repainting them is not a palette
change, it is an edit to the user's notes.

The fix is small and should land with extraction rather than before it: name the
note pigments in their own slots (`--note-a` … `--note-d`, defaulting to
`var(--accent-warm)`, `var(--accent)`, `var(--leafy)`, `var(--accent-warm)`) and
let a palette or an extraction pin them. Two things to know if it is built:

- `--note-1` … `--note-4` are declared **twice** — the base block and again at
  the plain end of the whimsy axis. Both have to move, or the plain end silently
  keeps the old derivation.
- Every token declared in `tokens.css` must also appear in `TOKENS` in
  `ui/look.js`, or `tests/appearance.test.js` fails. That test is doing its job;
  it caught exactly this.

### Settled, and built

Decided 2026-07-25 and in the tree: `web/assets/js/ui/pigments.js`, wired through
`recolourFromBoard()` in `ui/appearance.js`, with `tests/pigments.test.js`.

- **Scope: everything.** Paper, ink and pigment — thirteen tokens. An extracted
  palette is a whole palette, not a tint on top of Papyrus.
- **Hues: one to three, whatever the pictures hold.** The first takes the sheet,
  the ink and the accent; the second takes `--leafy`; a third takes
  `--accent-warm` outright instead of staying a relative of the accent. With one
  hue, `--leafy` turns 85° away, because a board whose ornamental wash is its own
  accent has no second voice.
- **Rule: the presets' own.** Every lightness and chroma in the tables comes from
  measuring the four presets — `tools/preset-oklch.mjs` prints the measurement —
  so an extracted palette and a chosen one sit in the same place on every axis.
- **Trigger: a switch, and then every picture.** *Revised the same day — see
  below. It shipped first as "silent while the look is presets-only, plus a
  button", gated on an inferred `isPresetOnly()`.*

#### The gate became a switch

Kosta, on seeing it: *"'take colours from pictures' should be a toggle, and
recalculate every time a picture is put in."* Right, and for a reason worth
writing down: the inferred gate meant the honest answer to "will importing a
photograph repaint my board?" was a paragraph about provenance. A switch the
user can see is a better answer than a rule they have to be told — and it fixes
what the inference got wrong in *both* directions. Somebody who wants their
hand-tuned board recoloured anyway can now say so, and somebody who never wanted
it is no longer relying on having happened to touch a slider.

Which changed four things:

- **`appearance.auto`**, the user's setting, alongside `derived`. Both are
  non-token fields carried through `clone()`. `derived` narrowed to what it
  actually is — provenance, read only by the palette menu deciding whether to
  drop two tokens or fourteen.

  Stored inverted, since (later the same evening) the switch was made **on by
  default**: `auto: false` means off, and absence means on. A board that has
  never been near the setting has no field for it, and that has to mean the same
  thing as one that was switched on — otherwise the default would only ever
  apply to boards made after the day it changed.
- **The three-picture floor went.** It existed because the feature fired unasked,
  and a whole interface turning over on one dropped file reads as a fault. Asked
  for by a switch, it *is* what was asked for, and refusing until the third
  photograph arrives is the fault.
- **The named palette is no longer cleared.** Checked rather than assumed: the
  `[data-palette]` blocks declare exactly the thirteen tokens `SHEET` +
  `PIGMENT` + `--leafy` cover, so an extraction overrides the named palette
  completely and nothing leaks through from underneath. Leaving it standing is
  what gives the switch somewhere to fall back to.
- **Only a *pigment* set by hand switches it off**, via `PALETTE_TOKENS`. Setting
  any control used to, which meant choosing a display face silently stopped the
  colour extraction.

Turning it on extracts at once — waiting for the next import would look
identical to broken. Turning it off changes nothing on screen: it only stops
recalculating, because the colours already taken are the board's colours now.
The palette menu is the way back, and it is the one control that drops all
fourteen tokens at once.

Three things are worth knowing about the implementation:

- **Only lightness is repaired.** Hue is the answer the photographs gave; chroma
  is what keeps a board tinted rather than saturated. Contrast is made of
  lightness, which is why the whole file works in OKLab and not HSL. A test
  walks all 360° and asserts ink-on-paper ≥ 7 and accent-fg-on-accent ≥ 4.5.
- **Gamut clipping gives up chroma, never lightness or hue.** Clipping channels
  instead — the obvious thing — drags a too-blue blue towards cyan, and the
  palette stops being the one that was chosen.
- **The vote is chroma-weighted and skips near-neutrals.** A photograph is mostly
  near-grey, and letting those pixels vote makes every board extract to the same
  faint beige. A grey street with one red door extracts red, which is also what
  anybody would call the colour of that picture.

`import/drop.js` announces `bus.emit('imported')` rather than calling any of
this, because `ui/appearance.js` reaches for `document` at import time and
`tests/imports.test.js` holds the import pipeline to loading without a browser.

### The recommendation this replaced

**Two hues, and a button.**

Two, because it matches what the presets already are, so an extracted palette
and a chosen one are the same kind of object; and because a third hue with no
job in `app.css` is a token that exists to satisfy an algorithm rather than to
be looked at. If a third is wanted later, the honest way to add it is to give it
a use first.

A button, because this rewrites the look of the board and silence is the wrong
default for that. "Take the colours from these pictures" in the Appearance
section, next to the palette chooser, is discoverable, repeatable, and undoable
in the way a silent import is not. A one-time offer is the worst of both — it
interrupts, and then it never comes back when you actually want it.

---

## 5. Cloud sync *(item 21)*

### Where this stands now

`research/gdrive implementation.md` has the detail and its recommendation
stands. The short version:

- **The synced-folder route costs no code at all.** Save already writes a real
  file to a real path through the File System Access API. A folder inside Drive,
  iCloud or Dropbox syncs it, and mbrd never knows.
- **The Drive API route needs OAuth, a registered origin, and re-consent roughly
  hourly without a backend** — and a backend is a server, which this project
  does not have and whose absence is a feature.

### The open question

Conflict handling, and it only exists on the API route. Last-writer-wins with a
warning is cheap. Merging is not: positions are absolute, there is no CRDT, and
two people moving the same card is a genuine conflict rather than a mergeable
one.

### Recommendation

**Say the synced folder is the answer, write two paragraphs of documentation,
and take this off the list.**

It is not a compromise. A `.mbrd` is one self-contained file — the format was
built for exactly this — and one file in a synced folder is what every other
document-shaped app does. The API route buys a file picker inside the app, and
pays for it with an OAuth flow, a registered origin, an hourly re-consent, and a
conflict model nobody has designed.

If it is ever built anyway: **last-writer-wins with a loud warning and a
timestamped copy of the loser.** Not merging. A board where two people's edits
were silently interleaved is worse than a board with a duplicate.

---

## 6. "Optimize board" *(item 23)*

### Where this stands now

Nothing built. The sketch from the roadmap: photos to 1200px on the long edge
at 4:2:0 JPEG q87, audio to 192kbps mp3, video to 480p, already-optimised files
marked so they are never processed twice.

Four things make this its own conversation, and all four are still true.

**It is lossy and destructive.** Every other operation in mbrd is undoable. This
one rewrites bytes. The bin holds items, not versions.

**The browser can do two of the three.** Canvas re-encodes images and WebCodecs
handles video. There is **no mp3 encoder in a browser**, so audio means either
shipping LAME as wasm — 200KB+, and the first dependency, in a project whose
one real property is having none — or transcoding to Opus, which is better in
every measurable way except that it is not mp3 and some player somewhere will
not open it.

**Where the mark lives.** A per-asset flag in `board.json` versus a hash of the
optimised bytes. The asset store is content-addressed, so a re-encode changes
the hash, and dedup interacts with this in ways that need thinking about
rather than discovering.

**4:2:0 at q87 is a photo setting.** It is wrong for screenshots, line art, UI
captures and anything with text in it — which is a large fraction of what a
moodboard actually collects. Chroma subsampling on red text is visibly bad.

### The options

1. **Don't.** Boards are as big as their contents.
2. **Non-destructive: optimise on export only.** The board keeps originals; a
   "compact copy" export writes the shrunk one. Nothing is ever lost, the
   original file is still the original file, and no marks or flags are needed at
   all because nothing in the store changes.
3. **Destructive, with the originals kept.** Doubles storage before it halves
   it, which defeats the point.
4. **Destructive, as sketched.** Fast, small, and irreversible.

### Recommendation

**Option 2, and it is not a compromise — it is a better feature.**

"Export a compact copy" is what people actually want: a board small enough to
send. The working board keeps its originals, because that is the one that gets
edited for months. It removes the destructive question entirely, removes the
marking question entirely (nothing in the store is ever rewritten, so nothing
needs a flag), and it makes the format question easy — a compact export can use
whatever the browser encodes best, because it is a copy and not the master.

On the two remaining sub-questions:

- **Images: detect, do not assume.** A cheap heuristic separates photographs
  from line art — count distinct colours in a sample and look at edge sharpness.
  Photos take 4:2:0 q87; everything else takes 4:4:4 at a higher quality, or is
  left alone. Getting this wrong on a screenshot is the most visible failure
  this feature could have.
- **Audio: Opus in WebCodecs, or leave audio alone.** Not LAME. A 200KB wasm
  blob to produce a worse codec is the wrong trade in this project, and "leave
  audio alone" is a perfectly respectable v1 — audio is rarely what makes a
  moodboard large.

---

## Summary

| # | Item | Recommendation | Code needed |
| - | ---- | -------------- | ----------- |
| 1 | Quality modes | Close it; the ladder covers it. Optionally make `DENSE_LIMIT` adaptive. | ~none |
| 2 | Sidebar reform | Pin commands, drop the duplicated Trash section. Inspector later. | small |
| 3 | 60-30-10 | **Settled: dropped.** Built, measured at 97-2-0.5, reverted. Two-hue rule stands. | none |
| 4 | Palette extraction | **Settled: built.** One to three hues, whole palette, silent on import while the look is presets-only, plus a button. | done |
| 5 | Cloud sync | Synced folder. Document it and close the item. | none |
| 6 | Optimize board | Non-destructive "export a compact copy" instead. | large |

Four of the six close with little or no code. The two that are real features —
palette extraction and compact export — are both better specified now than they
were, and neither is blocked on anything but a yes.
