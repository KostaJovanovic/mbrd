# The design audit: where the app disagrees with itself

Scope was everything: board chrome, sidebar and panels, on-card furniture,
dialogs and the standalone pages. Depth was "inconsistencies plus weak spots" —
so this reports both places where the app contradicts itself and places where it
is perfectly consistent and still reads badly. It does not question the visual
direction; that was explicitly out of scope.

Read against source, not against a running browser. Every claim below carries a
file and a line, and the counts are from the stylesheets and modules as
committed at v0.263.

## The finding, in one paragraph

The token layer is in good shape and the *use* of it is not. Colour, type,
duration and corner all have tokens, all have arguments written next to them,
and the type scale even has a ratchet test holding the literal count at 24. What
has no token at all is the thing this interface is mostly made of: **a small
square button with an icon in it.** There are around thirty of them across ten
stylesheets, and no two clusters agree on size, corner, glyph size, hover wash,
hover ink, disabled treatment or focus ring. Ten of them are the same button —
"close this" — at eight sizes and four corners. Underneath that is one real bug:
three rules print near-white ink on the accent, and at whimsy 2 the accent is
neon, so the timeline's current-step marker disappears on two palettes.

Findings are ordered by what they cost, not by how easy they are.

---

## A. Broken, not just uneven

### A1. The timeline's current step is invisible on two palettes

`timeline.css:333`, `timeline.css:338` and `timeline.css:552` set
`color: var(--paper-card)` on `background: var(--accent)`. Sixteen other places
in the app print `var(--accent-fg)` there, and `cards.css:356` carries the
comment explaining why:

> `--accent-fg`, not `--paper-card`: this is ink printed *on* the accent, and
> `--accent-fg` is the one mixed to stay legible when the palette moves.

The palette does move. Every whimsy-2 block redeclares `--accent-fg` to
`var(--ink)` — `tokens.css:1324`, `:1333`, `:1342`, `:1351` — precisely because
the tier's accents are `#ff6909`, `#d5fa00`, `#fb0047` and `#0fffed`. On
absinthe (`#d5fa00`, acid yellow) and orca (`#0fffed`, cyan), `--paper-card` is
still a near-white, so the glyph inside the current step, the same glyph in the
strip's hover state, and the current row's mark in the timeline sheet all print
white on near-white.

These are the three marks whose entire job is "you are here".

**Fix:** `--accent-fg` in all three. Three words. It is first on the list
because it is the only thing here that is actually broken.

### A2. Hover sticks after a tap across half the app

`@media (hover: hover)` guards exist in seven stylesheets and are missing from
thirteen. The gap is not evenly spread — it lands hardest on the surfaces a
finger actually touches:

| file | `:hover` rules | guarded blocks |
| --- | --- | --- |
| `mobile.css` | 12 | 1 |
| `timeline.css` | 12 | 0 |
| `menu.css` | 11 | 0 |
| `canvas.css` | 11 | 0 |
| `dialog.css` | 10 | 0 |
| `trash.css` | 9 | 0 |
| `chrome.css` | 16 | 11 |
| `sidebar.css` | 23 | 7 |

On a touch screen an unguarded `:hover` latches on tap and stays until you tap
something else, so the timeline sheet — which *is* the phone's face for the
timeline — leaves a lit row behind every press, and so does every context menu
item. `chrome.css` and `sidebar.css` know this; nothing else was told.

**Fix:** wrap the hover halves in `@media (hover: hover)`, leaving `:active`
outside it. Mechanical, but it touches six files and wants looking at rather
than sed.

---

## B. One thing, many shapes

### B1. Ten close buttons, eight sizes, four corners, four hovers

Every one of these means "close the thing you are looking at".

| button | size | corner | glyph | hover |
| --- | --- | --- | --- | --- |
| `#tour-editor .tour-close` `chrome.css:1127` | 24 | `--radius-sm` | 14 | ink 8% / `--ink` |
| `#nowplaying .np-close` `chrome.css:699` | 26 | `50%` | 12 | `--paper-2` / `--accent-deep` |
| `.sticker-window-close` `sticker-pad.css:74` | 28 | `--leaf` | 15 | `--paper-3` / `--ink` |
| `.player-window-close` `mobile.css:973` | 28 | `--leaf` | 15 | `--paper-3` / `--ink` |
| `#side-close`, `#header-close` `sidebar.css:318` | 30 | `50%` | 15 | `--paper-2` / `--accent-text` + rotate 90° |
| `#tour .tour-close` `chrome.css:887` | 30 | `50%` | 15 | `--paper-2` / `--accent-deep` |
| `.library-close` `library.css:52` | 30 | — | — | `--ink` only, no wash |
| `#darkroom-close` `dialog.css:578` | 30 × `--density` | `--leaf` | 15 | `--paper-2` / `--accent-text` |
| `#viewer-close` `viewer.css:77` | 32 | `--leaf` | 15 | `--paper-2` / `--accent-deep` |
| `#timeline-strip .tl-close` `timeline.css:167` | — | `--radius-sm` | 14 | ink 8% / `--ink` |

The 90° rotation on the sidebar's close is a real signature and should stay —
it is gated at whimsy 2 in `quality.css:230` and is the one piece of character
in the list. Everything else in the table is drift.

**Fix:** one `--close-size` / `--close-glyph` pair and one shared rule, with the
sidebar's rotation as the single documented departure. The four `--leaf` ones
are already right; the two `--radius-sm` ones are wrong for the reason in C1.

### B2. Ten glyph sizes, three of them inside one bar

Icon sizes across the app run 11, 12, 13, 14, 15, 16, 17, 18, 20, 34 px, all
written as literals. Inside `#nowplaying` alone there are three: the close is 12
(`chrome.css:716`), the volume icon 15 (`:697`), the transport buttons 16
(`:745`). Inside the timeline there are two: 14 on the name and close
(`timeline.css:175`), 15 on the sheet's mark (`:530`).

15 is the plurality — eight surfaces use it — and would make a reasonable
default. There is no token, which is why nobody could reach for one.

### B3. Three hover washes, and two comments each claiming to be the canon

- `background: var(--paper-2)` — 15 files, the most common by a distance
- `background: var(--paper-3)` — 8 files, mostly the mobile player and sticker window
- `background: color-mix(in srgb, var(--ink) 8%, transparent)` — `timeline.css` ×3, `cards.css`, `chrome.css`

`timeline.css:167` introduces the third with the line *"the tint the rest of the
app hovers with"*, which is not true — it is the rarest of the three. Meanwhile
`--paper-3` is elsewhere the **press** step (`chrome.css:907`,
`chrome.css:744`), so `.player-window-close` and `.sticker-window-close` hover
at what the rest of the app uses for a press.

Worth noting the two are not interchangeable: `--paper-2` is a paper tint and
tracks the palette's paper, `color-mix(ink 8%)` is an ink veil and works on any
ground. That is a real argument for keeping both — but then the rule needs
writing down, and today it is decided per file by whoever wrote it last.

### B4. Two hover inks, no rule

`--accent-deep` (chrome, viewer, `#conn-chip`, `#history-ctl`) and
`--accent-text` (sidebar closes, darkroom, `.ask-row`) both appear as "the ink a
hovered control turns". No comment anywhere says which is for what.

### B5. Four disabled recipes

| rule | treatment |
| --- | --- |
| `#zoom-ctl button:disabled` `chrome.css:59` | `--ink-3`, no opacity |
| `#history-ctl button:disabled` `trash.css:229` | `--ink-3`, no opacity |
| `#bin-empty:disabled` `trash.css:279` | `--ink-3`, transparent border |
| `#tour button:disabled` `chrome.css:910` | `--ink-3` + `0.45` |
| `#tour-editor .tour-add:disabled` `chrome.css:1212` | `--ink-3` + `0.45` |
| `.pw-btn:disabled` `mobile.css:1176` | `--ink-3` + `0.4` |
| `.viewer-more:disabled` `viewer.css:441` | `0.5` only — no ink change |

`--ink-3` alone is already a faded ink; stacking 0.45 on top of it makes those
buttons roughly twice as faded as the zoom cluster's. The last one is the odd
case out: the only disabled control that keeps full-strength ink.

### B6. The app draws its own focus ring in panels and the browser's in the chrome

Focus-visible rules exist for `.side-tab`, `.ctx-item`, `.ask-row button`,
`.search-hit`, `#conn-chip button`, `.sticker-tile`, and the ranges — drawn in
`outline: var(--sel-line) solid var(--select)` with `outline-offset:
var(--sel-gap)`, which is a proper decision documented at `sidebar.css:44`.

Zero exist for `#toolbar`, `#zoom-ctl`, `#history-ctl`, `#tour`, `#nowplaying`,
`#bin-btn`, `#menu-btn`, `#timeline-strip` or `.tour-chip`.

This is not an accessibility failure — nothing does a bare `outline: none` there,
so the browser's own ring still lands, and every `outline: none` in the codebase
is correctly paired with a `:focus-visible`. It is a consistency failure: tab
through the app and the ring changes character halfway round, from the app's
accent outline to Firefox's, on controls sitting a few pixels apart.

### B7. The stacking order is fourteen magic numbers in ten files

20, 21, 24, 25, 30, 40, 41, 50, 55, 59, 60, 61, 70, 90 — plus
`canvas.css:801`'s `z-index: 100000 !important` on a selected title card.
Nothing declares the ladder, nothing documents it, and nothing tests it, in a
codebase that tests icon names, element ids and stylesheet order precisely
because those fail silently. This one fails silently too: a panel one rung short
appears behind something and nobody notices until they hit that combination.

---

## C. Rules the app wrote down and then did not follow

### C1. `--leaf` sizes controls

`tokens.css:308` states it plainly: *"`--leaf` sizes controls, `--ogee` the
panels that hold them, `--radius-xs` the small fry (checkboxes, chips, kbd)."*

Controls not wearing `--leaf`: `#tour-editor .tour-close` and
`#timeline-strip .tl-close` use `--radius-sm`; `.tour-mark`
(`item-chrome.css:771`) uses `--radius-xs` on what is a button, not a chip.
The `50%` group is exempt and says so at `tokens.css:333`.

### C2. `--radius-sm` has sixteen uses and no stated job

It is the one step in the shape scale the scale's own sentence does not account
for. Either it earns a clause in that comment or its sixteen uses belong to
`--leaf` and `--radius-xs`.

### C3. Three corners still ignore the Corner radius slider

`tokens.css:311` describes this exact failure in the past tense — five
independent literals, the slider moving only the first, "half the interface
followed the control and half ignored it". Three literals survived the fix:

- `cards.css:390` — `.ntb-chip`, `border-radius: 4px`. `--radius-xs` resolves to
  4.004px at the middle tier, so this is the token frozen as the number it
  happened to be when it was copied.
- `sidebar.css:527` — `.field-picker-chips > i`, `2px`.
- `viewer.css:288`, `:322` — `4px` on the document renderer's code blocks.

Drag Corner radius to 0 and these four stay rounded; drag it to 28 and they stay
tight. Same bug, same shape, three sites.

---

## D. Weak spots — consistent, and still reading wrong

### D1. Accent fill means "you are here", except once

Across 29 accent-filled surfaces the meaning is remarkably stable: the playing
track (`chrome.css:420`), the playing transport (`media.css:214`), the current
timeline step (`timeline.css:332`), the current tour chip
(`chrome.css:1401`), the engaged sidebar toggle. It is a **state** colour.

`#tour-editor .tour-add.is-primary` (`chrome.css:1196`) uses it as a
**priority** colour — "this is the main action" — which the app does not do
anywhere else. The dialog is the proof: `.ask-row button` (`dialog.css:132`) is
paper with a hairline for *every* answer, including the one the panel wants you
to press, and the only colour in the whole dialog is `danger` on the
irreversible one.

That is mine, from this week, and it is against the grain. The honest fix is the
`.btn-row button.primary` treatment from `sidebar.css:622` if a filled primary
is wanted at all, or paper-with-accent-border if the dialog's argument holds.

### D2. Two buttons on a card, two of everything

| | `.item-pen` / `.item-rename` | `.tour-mark` |
| --- | --- | --- |
| size | `calc(30px * --iz)` | `calc(22px * --iz)` |
| corner | `calc(--leaf * --iz)` | `calc(--radius-xs * --iz)` |
| ground | `--paper-card` + hairline + `--shadow-1` | `--accent` (or paper when `+`) |
| hidden below | `#world.zoom-tiny` | `#world.zoom-far` (40%) |

Both are hover-revealed buttons that live on an item and hold constant
on-screen size. They agree on the `--iz` idiom and on nothing else. The two
zoom thresholds are the sharpest edge: at 39% zoom the tour marks are gone and
the pen is still there, for no reason a reader could name. Also mine.

### D3. Two strips of numbered squares, built twice

`#tour-editor .tour-chip` (30px, `--radius-xs`, accent when current) and
`#timeline-sheet .tl-mark` (26px, `50%`, accent when current) are the same
object: a small numbered square standing for a place in an ordered list, in a
foot-anchored strip, that fills with accent where you are. They were built weeks
apart and share no measurement. Whichever is better, there should be one.

### D4. There is no spacing rhythm

Thirteen distinct `gap` values in use: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14,
18. The 5/7/9 group accounts for thirteen declarations on its own. Dense chrome
justifies tight values; it does not justify every integer from 1 to 10. A 2/4/6/
8/12 rhythm would absorb almost all of them and cost nothing visible.

### D5. One non-square icon button

`#conn-chip button` (`menu.css:516`) is 30 × 28. Everything else in this class
is square. It is inside a segmented group whose seam idiom (`border-left`
hairline, squared inner corners) is a legitimate second pattern the app uses
deliberately — `#zoom-ctl` and `#history-ctl` are the others — but the 30 × 28
looks like a measurement rather than a decision.

---

## E. Words

### E1. The vague label goes to the sighted user and the specific one to the screen reader

`index.html:471` — `aria-label="Close menu" title="Close"`.
`index.html:531` — `aria-label="Close header options" title="Close"`.

Exactly backwards. The tooltip is what a hesitating user reads, and it is the
one that says nothing. Two more are bare in both channels: `#viewer-close`
(`index.html:1140`) and `#darkroom-close` (`:1172`), plus `.library-close`
(`ui/library.ts:159`).

Elsewhere the app is specific and good at it — "Close the timeline",
"Close the player", "End the tour", "Stop and close". These five are the
exception.

### E2. The tour calls one act three things

- The button's visible label: `'Remove'` — `ui/tour-edit.ts:502`
- That same button's tooltip: `'Take these off the tour…'` — `:505`
- The mark on the card: `'Take this card off the tour'` — `:608`
- The chip's context menu: `'Take off'`

A control disagreeing with its own tooltip is the worst version of this. Mine,
and the fix is to say "Take off" everywhere — it is the better phrase and it is
already in three of the four places.

There is a second-order problem underneath: `'Take the tour'` and `'Take this
card off the tour'` put *take* on two opposite jobs, one paragraph apart.

### E3. Six verbs for making something go away

Delete (5×), Remove (10×), Throw out, Discard (4×), Clear, Take off. Some of
that spread is genuine — removing a connection is not deleting a board. But
`ui/menu.ts:833` labels a card's own destruction "Delete" while
`state.ts:1123` labels the same act "Remove card" in the history, and the trash
that receives it says "Throw it all out" (`index.html:669`). Three names, one
journey. The timeline gets it right: "Delete" → "Deleted"
(`ui/timeline-view.ts:138`).

### E4. "Trash, empty" reads as an order

`index.html:672`, both `aria-label` and `title`. It means "the trash is empty".
Read aloud by a screen reader immediately after the word "button", it is an
instruction to empty the trash — which is a real command this app has, sitting
two elements away. "Trash — nothing in it" or "Trash (empty)" both survive being
spoken.

### E5. A row of switches in two grammatical moods

`ui/settings-schema.ts` puts "Show grid", "Show axes", "Show readout", "Show
connections" (imperative) in the same panel as "Card shadows", "Blurred
backdrops", "Animate GIFs", "Animations", "Sounds" (nouns). For a checkbox the
noun form is the stronger one — the box already carries the verb — and "Show
grid" as a *label* reads like a button that will do something when pressed.

Not a finding: "Start over" appearing twice is scoped to its section and the
comment at `:818` says so; `&` in "Board & grid" matches the app's title style;
the debug entries are `advanced: true`.

---

## Already known, still open

`research/ui-clutter-2026-08-15.md` remains the standing document on quantity
rather than consistency, and most of it is still true. Its item **G** is now
done — the trash and undo/redo are one `.bin-row` (`index.html:668`), and the
scale bar is docked inside `#corner` (`:694`). Items A through F are untouched,
and item **F** (the timeline strip is high ink, low information) overlaps this
audit's D3: if the strip's shape is being questioned anyway, the numbered-square
decision belongs to the same sitting.

Two things this audit found healthy and worth saying so: the type scale, held at
24 literals by `tests/type-scale.test.js` with a reason written at every site;
and the transition vocabulary, where exactly one duration in 17,649 lines of CSS
is not a `--dur-*` token.

---

## Sequence

Ordered by payoff per unit of risk, each independent.

1. **A1** — three tokens. Fixes an actual invisible control. Minutes.
2. **E1, E2, E4** — copy only, no CSS, no risk. Also minutes.
3. **B1** — one shared close rule with `--close-size` / `--close-glyph`. The
   single largest visible gain, and it makes B2 mostly fall out with it.
4. **C1, C3** — four corners onto the tokens they were copied from.
5. **A2** — hover guards across six files. Mechanical but wants reading.
6. **D1, D2** — the two the tour feature owes: the accent-filled primary, and
   the on-card pair agreeing on size, corner and zoom threshold.
7. **B3, B4, B5** — write the wash / ink / disabled rules down first, then
   apply. The writing is the work; the edits are trivial afterwards.
8. **B7** — a `--z-*` ladder in `tokens.css` and a test in the spirit of
   `tests/layers.test.js`.
9. **D3, D4** — the numbered-square question and the spacing rhythm. Biggest
   design questions, least urgent, and D3 should wait for ui-clutter F.

Two items are deliberately not on this list. B6 (focus rings in the chrome) is
correct-but-inconsistent and touching it means deciding whether the app wants to
own focus everywhere — a direction question, and direction was out of scope.
D5 is a two-pixel observation and can ride along with B1.
