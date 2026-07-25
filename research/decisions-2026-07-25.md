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

### Recommendation

**Option 3, and write down the rule that is already being followed**: two hues,
chroma capped near 0.13, accent for action and `--leafy` for the second voice.
That is a real system, it is the one the palettes were built on, and naming it
is worth more than swapping it for a rule borrowed from a different kind of
page.

If the itch is specifically "the accent is over-used", that is option 2 and it is
a much narrower conversation about `app.css`.

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

### Recommendation

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
| 3 | 60-30-10 | Drop it; write down the two-hue rule that is already in force. | none |
| 4 | Palette extraction | Two hues, fired by a button in Appearance. | large |
| 5 | Cloud sync | Synced folder. Document it and close the item. | none |
| 6 | Optimize board | Non-destructive "export a compact copy" instead. | large |

Four of the six close with little or no code. The two that are real features —
palette extraction and compact export — are both better specified now than they
were, and neither is blocked on anything but a yes.
