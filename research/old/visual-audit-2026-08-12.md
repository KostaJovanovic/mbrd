# The visual audit: what the axis exposes

> **Moved to `old/` on 2026-08-14.** Five of its six plan items are done and
> annotated in place; the sixth, the type scale, is V1 in
> `research/open-work-2026-08-14.md`. Read this for the reasoning rather than the
> list — in particular the closing rule, which is the most reusable thing in it:
> *audit at the ends of the whimsy axis, never at the middle*, because a literal
> is indistinguishable from a token at the value it was copied from and obvious
> at every other. Paths written `old/…` below were written from `research/` and
> mean this directory.

*Open on one item. Written 2026-08-12, re-checked 2026-08-14. An
element-by-element pass over the interface at all three whimsy stops, ranked
worst to best, with the corner scale rebuilt as a scale. The high-severity half
was applied on the day — see* Applied *below — and five of the six items in the
plan have gone in since. **What is left is item 2, the type scale**, and it is
the one the plan itself called the real work.*

**`overlays.css` no longer exists.** Every `overlays.css:NNN` below is a
reference into a file that was split into eight subsystem sheets the same week
(`6e28f0e`) — `trash`, `menu`, `library`, `status`, `dialog`, `viewer`,
`color-picker`, `sticker-pad` — as a pure move, 1,665 rules in and 1,665 out.
The findings survive the move; the line numbers do not, so where one mattered it
has been rewritten to name the sheet the rule is in now.

---

## The finding, in one paragraph

`tokens.css` opens by claiming that nothing in the CSS hardcodes a colour, a
corner, a duration or a typeface. That claim is close to true, and where it is
false the failures are not scattered — they cluster, and they cluster by a
single mechanism. **Every literal in the stylesheets was eyed against the Middle
tier.** A 14px corner next to Middle's 15px `--ogee`, a 9px one next to its 10px
`--leaf`, a 12px label next to its 13px `--t-small`: each was chosen by someone
looking at the middle of the axis and seeing nothing wrong, because at the
middle of the axis there is nothing wrong. The literals only misbehave at the
two ends, and the two ends are exactly where nobody was looking. That is why
they survived, and it is why the audit is worth doing at the stops rather than
on the default board.

## What each stop is good for

The three tiers are not three skins. They are three different *tests*, and each
catches a different class of fault.

**Middle (`data-whimsy` unset or `1`)** is the tier every literal was tuned
against, so it is the one stop where the interface looks coherent whether or not
the system is being obeyed. It proves nothing. **Do not audit here.**

**Harsh (`data-whimsy="2"`)** is the strictest judge in the app. It declares that
nothing curves — one `--radius: 0px` now zeroes the whole scale — so any element
still holding a literal corner survives as a rounded object on a square board,
and it is visible from across the room. Every corner fault in this document was
found by looking at Harsh first. It is also where negative-radius `calc()`
expressions go invalid, and where a hardcoded `#fff` on an accent button is at
its ugliest, because Harsh is the tier with the least colour to hide behind.

**Softish (`data-whimsy="0"`)** doubles every corner, so it is the *proportion*
test rather than the presence test. A literal does not disappear here, it falls
behind — a 9px canvas button against a 26px card is the same fault as Harsh's,
measured in the opposite direction and about four times as wide. Softish is also
where the drift in the old scale showed: its five corners were `17 / 9 / 20 /
30` against Middle's `8 / 4 / 10 / 15`, which is 2.13× / 2.25× / 2.0× / 2.0×.
Four numbers that should have been one.

## The spine: one number, four ratios

The corner scale was five independent literals per tier, and the **Corner radius
slider in the Appearance panel writes exactly one of them** (`--radius`, 0–28px;
see `AXIS_TOKENS` in `ui/appearance.js:77`). So dragging it to 0 gave square
cards inside a toolbar still rounded at `--leaf: 10px`, and dragging it to 28
rounded the cards well past the `--ogee: 15px` panel holding them. Half the
interface followed its own control and half ignored it, at every position except
the two ends of the drag.

`--note-radius` had already solved this for itself — `calc(var(--radius) *
0.42)`, struck from the slider's number rather than declared beside it. The fix
is to do for the other four what the notes were already doing:

```css
--radius:    13px;                          /* the only corner a tier declares */
--radius-sm: calc(var(--radius) * 0.615);
--radius-xs: calc(var(--radius) * 0.308);
--leaf:      calc(var(--radius) * 0.77);
--ogee:      calc(var(--radius) * 1.154);
```

The ratios are Middle's own numbers over its 13, so **Middle resolves to the
identical `8 / 4 / 10 / 15` it always did** — this is not a restyle. What changes
is that the ends fall out for free: Softish declares `26px` and gets `16 / 8 / 20
/ 30`, Harsh declares `0px` and gets zeroes without listing them. Softish went
from six declarations to two and Harsh from six to two, and the slider now moves
the whole interface instead of a third of it.

The tell that the old scale was not a scale: **a set of numbers that has to be
zeroed one at a time is a set of numbers nothing derives from.**

A sixth token joins them, `--radius-pill` (999px, 0px at Harsh), for the two
shapes that want their ends capped rather than their corners eased — a hairline
meter and a pill button. Both were previously written as bare `1px` / `2px` /
`999px` literals, which made them the only elements in the app that ignored the
axis in *both* directions.

---

## The ranking, worst to best

Grades are about **conformance to the system**, not about how the element looks
on a default board. Several F-grade elements look perfectly fine at Middle. That
is the point.

| # | Element | Grade | What is wrong |
| --- | --- | --- | --- |
| 1 | **Note formatting toolbar** — `items.css` `.note-toolbar` | **F** | Four token families broken in one 90-line component. See below. |
| 2 | **Mobile player transport** — `mobile.css` `.pl-*`, `.pw-*` | **F** | Primary button printed `#fff` on the accent and darkened it with a black mix on hover, so it was the one control that did not move with the palette. Literal `999px` pill, literal `0.08s`/`0.15s` transitions. |
| 3 | **Web connection colours** — `canvas.css` `.web-c-leaf` | **F** | `stroke: var(--leaf)` — a *length*, 10px. The intended token is `--leafy`, the olive pigment, one letter away. The declaration was invalid and dropped, so a connection set to **Green** (`CONN_COLORS` in `board-model.js:355`, labelled in `ui/menu.js:341`) came out whatever the bulk stroke already was. A real user-facing bug, not a style drift. |
| 4 | **Hairline meters** — waveform bars, playlist EQ, range tracks, splash thread | **D** | `1px` and `2px` literals across all three tiers: the one class of element that never followed the axis at all. |
| 5 | **Canvas add-button** — `canvas.css` | **D** | `calc(9px * var(--iz, 1))`. Within a pixel of `--leaf` at Middle and nowhere near it at either end — the only control *on the board itself* that ignored the Corner radius slider. |
| 6 | **Nested-radius `calc()`s** — 5 sites in what was `overlays.css` | **C** | Unguarded subtraction against a token that is 0px at Harsh, so `calc(0px - 6px)` is an invalid radius and the browser drops the whole declaration. Latent rather than visible — the dropped rule happened to leave a square corner on a square tier — but it is the rule failing, not applying. `items.css:316` already had the `max(0px, …)` guard; the other five did not. |
| 7 | **The type scale** | **C** | Five steps declared (`30 / 21 / 15 / 13 / 11`), ~15 distinct sizes actually used, across 29 hardcoded `font-size` declarations. Unlike the corners, most of these are defensible one-offs (a 64px ghost glyph, a `clamp()` on a masthead) — but there is no line between "off-scale on purpose" and "never looked at the scale". |
| 8 | **`lab.html`** | **C** | Eight literal radii, its own `--edge` colour vocabulary, no token imports. Off-system by construction. It is a dev harness and not shipped chrome, so this is a deliberate-neglect grade rather than a defect. |
| 9 | **Chrome, overlays, sidebar, items** | **B+** | Token-clean on corners and colour. Three stray literal durations (`640ms`, `300ms`, and the mobile pair now fixed) and a handful of `#0009` shadows on the web-mode handles, which are arguably justified as they sit over arbitrary board content. |
| 10 | **`#conn-chip`** (uncommitted) | **A−** | Written to the system throughout — reads `--radius-sm`, `--dur-fast`, `--ease`, `--accent-deep`, `--danger`, `--btn-grow`. One `1px` where `--hairline` belonged, and it inherited the unguarded-`calc()` pattern from its neighbours. The best-behaved new code in the tree. |
| 11 | **`z-index`** | **A** | Looks like an outlier field (`1`…`90`, plus a `100000 !important`) and is not. Each site documents its own place in the stack, `base.css:259` writes the order out, and the `100000` is world-space items competing among themselves in a different stacking context from the chrome. No change wanted; it only lacked one central table. **It has one now** — `research/docs/architecture.md`, *The stack*, and it is four tables rather than one because there are four stacking contexts and the whole confusion was reading them as one. |
| 12 | **`tokens.css`, palettes, pigments** | **A** | The reason this audit was possible at all. Every finding above is measured against rules this file states plainly. |

### Why the note toolbar is bottom

It is worth spelling out, because it is the clearest picture of what "outside the
system" looks like:

- `border-radius: var(--radius-md, 14px)` — **`--radius-md` has never existed in
  this codebase.** Every board at every tier got the 14px fallback. It sat close
  enough to Middle's `--ogee: 15px` that nobody saw it, so a rounded bar floated
  over square cards at Harsh and a tight one over 26px cards at Softish.
- `border-radius: var(--radius-xs, 8px)` ×2 — names the small-fry token and then
  hands it a fallback at *twice* its real 4px value. Whichever way it resolved,
  it was wrong about something.
- `font-family: system-ui, sans-serif` — the only hardcoded family in the shipped
  CSS outside `@font-face`.
- `color: var(--paper-card)` on the active button — ink printed *on* the accent,
  using the card colour instead of `--accent-fg`, which exists precisely so that
  never comes out as a warm cream on a teal button.

One component, four of the system's five promises broken. Nothing about it was
malicious; it was written against a screenshot of the middle tier.

---

## Applied

All of the following are in the working tree.

**The scale.** `tokens.css` — `--radius-sm/-xs`, `--leaf` and `--ogee` derived
from `--radius`; Softish and Harsh collapsed to one declaration each; new
`--radius-pill`, added to the `TOKENS` allowlist in `ui/look.js` so a board may
carry it (`tests/appearance.test.js` checks that list against the declarations
both ways — it passes).

**Corners now on the system.** Note toolbar → `--ogee` for the panel and `--leaf`
for its controls, matching the rule `sidebar.css:19` already wrote down (*on the
glass is `--leaf`, inside a panel is `--radius-sm`*). Canvas add-button →
`calc(var(--leaf) * var(--iz, 1))`. Waveform, EQ, feed bars, range tracks,
splash thread, hue slider, mobile play/shuffle pills → `--radius-pill`. Both
bogus `var(--token, wrong-fallback)` pairs removed.

**Colour and motion.** `.pl-play` → `--accent-fg` / `--accent-deep`; `.pw-play`
hover → `--accent-fg`; note-toolbar active → `--accent-fg`; note-toolbar family →
`--font-body`; `#web .web-label` family → `--font-body`; mobile transport
transitions → `--dur-fast` / `--ease`.

**The bug.** `.web-c-leaf` → `var(--leafy)`. Green connections have a colour
again.

**Guards.** Six `max(0px, calc(…))` wraps across `overlays.css`, matching the
existing precedent in `items.css`. `#conn-chip`'s seam → `--hairline`. All six
rode the split into their new sheets untouched, so they are where the rules are
and not where this list says.

**Since, and not from this document.** Two things the split turned up on its own
and worth knowing before re-finding them: the forced-colors rule that named
`#menu` was styling nothing — the context menu is `#ctx-menu`, and it is
`tests/id-contract.test.js`, added the same week, that caught it. And three
comments described classes that no longer exist (`.note-body` in `items.css`,
`.playlist-up` and `.is-queue` in `chrome.css`); each now names the class the
rule actually depends on, which in the `.playlist-up` case is the difference
that had already broken the album view once.

Untouched on purpose: the `50%` circles (a dot is a shape, not a corner — though
see below), the two intentional `border-radius: 0` resets, `#000`/`#fff` inside
media scrims over arbitrary artwork, and the 12px `#web .web-label` size, which
is world-space and sized against the lines rather than the panel type. That last
one is now commented as a deliberate exception rather than left to look like an
oversight.

## The plan for what is left

*Six when this was written; **one** now. Items 1, 3, 4, 5 and 6 are done, each
annotated in place below. Item 2 is the only one still open, and it is the one
this list called the real work.*

~~**1 — Decide the circle question.**~~ **Done.** Harsh says nothing curves; ~13
elements are `border-radius: 50%` and stay perfectly round there. A swatch dot
and a slider thumb are shapes rather than eased corners, so this may well be
correct — but it was correct by accident, since nobody had chosen it. It has
been chosen, and the answer is where this list said it belonged: the
`--radius-pill` comment in `tokens.css`. The rule it settles on is worth
knowing before adding any `border-radius` at all — *an eased corner follows
`--radius`, a capped end follows `--radius-pill`, and a circle is drawn as a
circle at every tier*, because the axis governs how much the interface softens
and does not get to redraw what a thing is. Fourteen elements, not thirteen.

**2 — Draw the line under the type scale.** ***Open, and now the only open item
here.*** Not "replace 29 literals with tokens" — most should stay. The work is
to sort them into *on-scale*, *deliberately off-scale* (glyphs, mastheads,
`clamp()`ed world-space text), and *never looked*, then fix only the third pile
and comment the second. Expect the third pile to be small; the corners were the
systemic failure, the type mostly is not.

*Two notes from 2026-08-14. **The pile has not grown**, which is worth saying
because a first count suggested it had: `font-size:` with a bare pixel value —
which is what the 29 above counts — appears **27** times now, and 26 of those
are in sheets that already existed when this was written. The number that looks
alarming is 55, and that is every `font-size` not reading a `var()`, which
sweeps in the `em`, `rem` and `clamp()` values that this item's own second pile
is *for*. Counting those as debt is the mistake this item exists to stop, so
count px. And exactly one literal has been sorted so far: `ghosts.css:145`
carries the "off the type scale on purpose" annotation and names this item as
the reason. That is the shape the rest want — for the second pile the
annotation is the deliverable, not the token.*

~~**3 — Three stray durations.**~~ **Done, and it came out two-to-leave rather
than two-to-fix.** The autosave mark's `640ms` was the real one and is struck
from `--dur-travel` now (`1.6 × 400ms` is exactly the 640 it always was, so
Middle does not move and the ends come out for free: 1120ms at Softish, 352ms at
Harsh). `.toast-line`'s `300ms` stayed, and the guess below was right about why —
it is paired with `TOAST_FADE_MS` on the JavaScript side, so a duration the axis
could flatten to zero would leave the timer holding an invisible line on screen.
`#mobile-header-edit-btn`'s `0.3s` stayed as already documented. All three are
now commented where they sit, which was the actual ask.

~~**4 — `lab.html`, or not.**~~ **Done, the comment way.** `web/lab.html` opens
with an *"Off the design system on purpose"* block naming this document, and
`CLAUDE.md` carries the same reasoning: a bench that renders at the current
whimsy tier makes a wrong colour and a warmly-displayed colour look identical.

~~**5 — `--font-serif-display` is declared and read by nothing.**~~ **Done, the
way this item asked for it** — asserted rather than argued.
`tests/font-tokens.test.js` holds it: the token stays declared, nothing reads
it, and the test fails if Playfair leaves both font menus, which is the
condition under which it may finally go.

~~**6 — Write the z-index table.**~~ **Done.** *The stack* in
`research/docs/architecture.md`. It came out as four tables rather than one, and
that is the finding rather than an expansion of the brief: the app has four
stacking contexts, not one axis — the root, inside `#viewport`, inside `#world`,
and inside a single `.item` — with the top layer above all four and not a number
at all. Every value in the field means something only within its own. Which is
the whole explanation of the `100000 !important` this document
graded A and could not otherwise account for: it is sealed inside `#world` by a
permanent `transform`, and `#world` is sealed inside `#viewport` by
`contain: layout paint`, so a hundred thousand there cannot reach the toolbar at
20. Twelve of the seventeen sheets declare one, and two more sites are not
sheets at all — the `<noscript>` block in `index.html` and one inline write in
`perf/view-perf.js`. Fourteen files, not eight.

## The rule this leaves behind

The corner scale is the specific fix; the general one is the reason it worked.

**Audit at the ends, never at the middle.** A design system with an axis running
through it gets its conformance checking for free, because a literal is
indistinguishable from a token at the value the literal was copied from and
obvious at every other. Middle is where this interface is designed. Harsh and
Softish are where it is *tested*, and a change that was only ever looked at on a
default board has not been looked at.
