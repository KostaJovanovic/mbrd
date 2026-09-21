# The cleaning simulator, third pass: depth in the washing, life in the mess

Open work. Follows `clean-sim-redesign-2026-09-17.md`, which is carried out: three
held tools, a bin, mud / rust / tar at four fifths opacity edge to edge, six kinds
of debris, a tank, an ending that waits. **Read that file's §0 first; its ground
rules are this file's.** The eleven things below were picked by the maintainer
from a longer list on 2026-09-17 and are not to be re-argued or added to.

The brief has not moved: **zen.** Nothing here may be missed, failed, timed or
counted against anybody. Every one of these is either feedback on something the
player already does, or a small thing that happens and asks for nothing.

**Where the look lives, because it was got wrong twice.** What lies on the board —
grime, debris, webs, anything new below — is drawn *as the thing itself*: lit from
the upper left, its own warm colours, no outlines. What is the app's — the tools,
the bin, the bar, the ring, any text — is in the app's language: `--sticker-body`
bodies, `--ink` lines, one palette pigment, shadows mixed from `--ink`, never a
grey and never a blue. A new colour on the chrome side is a token or it is wrong.
Every `color-mix()` needs its `@supports not` twin (`tests/legacy-color.test.js`),
and every pixel gap is 2/4/6/8/12 (`tests/spacing.test.js`).

## How to run this

Three sessions, each a fresh agent, each stopping for the maintainer to look.

**Stage A — the washing.** §1, §2, §3, §4.
> Read `research/clean-sim-third-pass-2026-09-17.md` in full, then §0 of
> `research/clean-sim-redesign-2026-09-17.md`, then `CLAUDE.md`. Carry out §1 to
> §4 of the third pass and nothing else. Spawn no subagents. Do not commit. Do
> not start a server. Stop when `npm test`, lint, typecheck and build are green
> and report what to look at and what you could not verify without a browser.

**Stage B — the mess.** §5, §6, §7, §8, §9.
> Same preamble. Stage A is done. Carry out §5 to §9.

**Stage C — the ending and the polish.** §10, §11, §12.
> Same preamble. Stages A and B are done. Carry out §10 to §12, then write the
> report the first plan's §13 asks for.

---

## 1. Distance as pressure

The jet answers to how the hand moves. Pointer speed in *world* units per second,
smoothed over ~120 ms:

| speed | radius | bite per stamp |
| --- | --- | --- |
| still, or under 40 | 0.7 × `reach.washer.radius` | 1.6 |
| about 250 | 1 × | 1 |
| 700 and over | 1.35 × | 0.55 |

Linear between the rows, and multiplied by tank power as now. A pure
`jetShape(speed) → { radius, bite }` in `mess.ts` with the three rows in
`TUNING.jet`, tested at the rows and for monotonicity. The reach ring follows the
radius, eased, so the narrowing is *seen*. The mist cone narrows with it. No
text, no meter: slow strokes simply clean better, which is the whole of the zen
argument for this one.

## 2. Water runs down

Where the jet finishes cells, dirty water leaves. Cosmetic: never counted, no
tool, gone on its own.

- One canvas per card is already there for the sheen (`.clean-wet`); runoff goes
  on a sibling, `.clean-run`, *under* the debris and *over* the crust, normal
  blend, so a rivulet crosses grime it has not cleaned yet.
- A rivulet is a particle in card space: born at the stamp point when a stamp
  finished at least 3 cells, at most one per ~90 ms per card. It falls at
  ~0.35 card-heights a second with a slow sideways wander from value noise,
  leaves a trail 1.5–2.5 px wide in the grime's own `fleckColour()` at 0.35
  alpha, thinning along its length, and dies at the card's bottom edge with a
  single drip that falls a further ~20 world px below the card and fades.
- The whole run canvas fades by multiplying alpha down each frame
  (`destination-out` at ~0.02), so trails are gone in about two seconds with no
  bookkeeping per trail.
- Falls along the card's *own* down, so a rotated card drips at its angle. That
  is deliberate: it is cheaper and nobody will check.
- Halved on the low quality tier; off entirely if `quality.anim` is false.

## 3. Clean-edge sparkle

On a stamp that *finishes* cells (not one that only thins), a short bright arc on
the leading edge of the stamp: `source-over` on the wet canvas, a 1.2 px line in
`rgb(255 252 240 / 0.7)` along the half of the stamp ellipse facing the
direction of travel. It dies with the wet canvas's own fade. No new canvas, no
particles. At rest (press without moving) it is a full faint ring.

## 4. The card wakes up

Replaces `.clean-card.is-clean::after`'s pass of light as the *main* event; keep
the light, shorter (600 ms) and fainter (0.35).

When a card comes clean, the real item under it does what it does on hover:
`--lift-hover` / `--grow-hover` for ~500 ms and back, with the mode's ease. The
cards are frozen with `pointer-events: none`, which does not stop a class — add
`is-woken` to the item's node and give it, in `clean.css` and only under
`:root.is-cleaning`, the same transform the hover rule in `items.css` uses. Read
that rule first and reuse its custom properties, so the whimsy tiers decide how
much a card moves (Harsh: not at all, and that is correct). The dirt layer's
`.clean-card` box gets the same transform for the same duration so the two do
not slide against each other. Reach the item's node the way `clean.ts` already
does to copy its corner radius.

## 5. Grime fits the card

Three more fields, all washer, all in `art.ts` as `Surface`s lit like the rest:

| kind | for | depth | look |
| --- | --- | --- | --- |
| `coffee` | notes, text, documents | 2 | rings and a spill: thin translucent sepia with a darker tide line at every edge; several overlapping rings from a cup. The one grime that is *meant* to be see-through in the middle |
| `ink` | notes, text, documents | 3 | blots: warm near-black (`--ink`'s value), dense centres, feathered capillary edges, a few satellite drops |
| `film` | audio, video, embeds, files | 1 | a settled dust film: warm grey, matte, fine even grain, finger-trail streaks wiped through it |

`coffee` and `ink` do not cover the whole card — they are the exception to
"edge to edge", because a spill that is a rectangle is not a spill. `crustAt()`
answers per kind again: blobs for these two, flat 1 for the rest. The coverage
test in `tests/clean.test.js` splits accordingly (full-cover kinds ≥ 0.99; spill
kinds between 0.3 and 0.7).

Dealing: `planBoard()` takes each box's item `type` (add it to `Box`; `clean.ts`
already has the item). A weight table in `mess.ts`, `GRIME_FOR`, maps type →
weighted kinds; images and anything unlisted keep mud / rust / tar. Weighted,
never exclusive: a photo can still get coffee one time in ten. Pure, tested
(every type resolves to a non-empty list; every listed kind is a `field`).

## 6. Layered grime

Some cards — `TUNING.layeredChance`, 0.2 — are dealt two fields: a top and an
under. Allowed pairs only: mud over rust, film over ink, film over coffee. The
top must be the shallower.

`CardPlan.fields` is already an array. Order is bottom first. The washer bites
the *topmost field that still has the cell*; a cell of the under-layer is
shielded while the top's cell at the same index is non-zero. That is the `skip`
predicate `stamp()` already takes for debris — compose the two. Tests: a stamp on
a layered card takes nothing from the under-layer until the top's cell is zero;
the card is not clean until both are clear; the ring shows the two combined.

Both canvases sit at 0.8 opacity, so where both remain the card is nearly
hidden and where only the under-layer remains it is not — the reveal happens
twice, which is the point.

## 7. Muddy tracks

A trail of prints across the board: a new family, `track`, tool `washer`,
owned by no card — the webs' counterpart for the washer.

- `planBoard()` deals at most one trail, on boards with 4+ cards: a gently
  curving path (a quadratic through the picked cards' bounds, entering and
  leaving past the outermost cards) with a print every ~70 world px, alternating
  left and right of the line, each turned along the path. `TUNING.trackChance`
  0.5. Pure; tested for count bounds, alternation, and that no print is NaN.
- Each print is one small canvas in the dirt layer (world coordinates, ~44×90
  world px), painted with the mud `Surface` masked to a boot-sole shape: a heel,
  a sole, three tread bars cut out. One shared occupancy field per print at a
  coarse grid (8×16), depth 1.
- Prints that fall on a card are drawn *over* the card's grime (they came later)
  and are washed first.
- `underTool()` answers true over a print with the washer, so a press there is
  work and not a pan. `tally()` takes the prints left; the board is not done
  while any remain. The count in the bar stays cards only.

## 8. A spider

One, on boards that dealt at least one web, on the web with the longest span. No
rule touches it: it is not in `tally()`, cannot be hit, picked up or washed.

- Drawn in `art.ts` as the thing itself: a small warm-dark body and abdomen,
  eight legs as two-segment lines, about 14 world px across. Idles at ~0.4 of the
  way along the lowest strand with a slow leg shuffle (two keyframes, 2.4 s).
- When its web is dusted it drops on a single thread (a line that lengthens
  from the old anchor) for ~600 ms, then walks — legs alternating, ~90 world px a
  second — in a straight line to the nearest edge of the *viewport* and is
  removed when it leaves it. If the mode ends first, it goes with the layer.
- If the pointer comes within 60 world px while it idles, it scuttles a short
  way along the strand. That is all it does.
- Off when `quality.anim` is false: it sits still and vanishes with its web.

## 9. Tape and sticky residue, and motes

Two more glove pieces in `mess.ts` (`bulk` 1, dealt `fewPieces`), drawn in
`art.ts` like the rest:

- `tape`: a torn strip of yellowed masking tape, serrated short ends, a lifted
  corner with its shadow, faint fibres. `TUNING.peelMs` 700: it does not come
  away on a press — hold on it and it *peels* from the lifted corner over 700 ms
  (the strip's SVG scales along its length from the far end while the corner
  follows the glove), then joins the hand. Releasing early lets it ease back
  down. No counter, no failure; it just takes a moment.
- `sticky`: a curled sticky note, one of the app's four `--note-N` colours —
  the one piece of debris that *is* allowed a token, because it is the app's own
  stationery. Peels the same way in 400 ms.

Gum keeps its three tugs.

Motes: when the duster clears a strand, 6–10 specks rise from along it on the
existing mist canvas — 1–1.5 px, `rgb(250 246 235 / 0.6)`, drifting up and
sideways on noise for ~1.4 s. Halved on the low tier.

## 10. Polaroid ending

Instead of the line fading in over the board, the ending is dealt as a card.

- At `startClean()`, after the first paint queue drains, capture nothing —
  there is no screenshot API to lean on and html-to-canvas is not coming in.
  The "before" is *drawn*: a small schematic of the board, each picked card a
  rounded rect in its place at thumbnail scale, filled with its grime's
  `fleckColour()`. The "after" is the same schematic in `--paper-card` with
  `--item-border`. Two frames side by side, ~220 px wide together.
- Built as DOM in the glass: a `.clean-polaroid` in `--paper-card`, the app's
  `--item-shadow`, `--radius`, a slight `--tilt-max` rotation, the two frames,
  and under them "Everything is spotless." in `--font-display`, then a second
  line in `--ink-3`, small: the card count and nothing else ("12 cards").
  No time, no score.
- It arrives from below with the mode's ease (600 ms), after the tools fly home
  and the light crosses. It can be dragged about with the left button — it is a
  card, cards move — and does nothing else. Gone with the mode. **Never
  saved, never added to the board, never in the `.mbrd`.**

## 11. The robot

Typing the konami code *while the mode is up* does not reopen it (`startClean()`
already refuses) — it releases a robot vacuum. `cleanFeed` in `commands.ts`
becomes: matched and mode down → `startClean()`; matched and mode up →
`releaseRobot()`. The seven-tap way in does the same from the sidebar.

- Drawn in `art.ts` as the thing itself: a disc ~60 world px across seen from
  above, warm dark grey, a lighter lid, a bumper arc at the front, one small
  amber light. Lives in the dirt layer.
- Enters from the nearest viewport edge and wanders: straight until it meets a
  card's edge or the bounds of the dealt cards plus a margin, then turns a random
  45–160° — the real thing's bump-and-turn. ~70 world px a second.
- Eats **loose debris only** — pieces lying on the bare board — within its own
  radius, and debris on a card it happens to drive across. It never touches
  grime, webs, prints, or a piece the glove is holding. Eaten pieces shrink into
  it over 200 ms; `tally()` sees them go.
- One at a time; a second code while it is out makes it do a slow full turn and
  carry on. It parks itself off the nearest edge when there is no loose debris
  left and none has appeared for 8 s, and at the ending.
- A quiet low `sustain()` while it is on screen, gain scaled by distance from
  the view centre. No `RECIPES` rows.

Nothing depends on it. It is a second secret inside the first.

## 12. Small polish

- **The glove closes.** A second symbol, `i-clean-glove-held`, same box, same
  line language, fingers curled over the palm; swapped in while `carried` is
  non-empty. Add it to `CLEAN_BOX` in `tests/icons.test.js`. `TIP` does not move.
- **The bin fills.** After 8 pieces binned in a session a leaf tip shows under
  the lid's rim; after 20, a second scrap. Two small `<use>`-free paths toggled
  by class on `#clean-can`, drawn in the bin's own line language. Reset on
  `stopClean()`.
- **Height from speed.** The cursor's second drop-shadow offset and blur scale
  with pointer speed (8 px → 16 px at 900 screen px/s, eased 200 ms) via one
  custom property on `.clean-cursor`. The `@supports not` twin follows.
- **The count.** "3 of 12", the numerals in `--font-display`, "of" in `--ink-3`
  at the body size. `aria-live` text unchanged in meaning.

---

## Tests to add, in one place

`tests/clean.test.js`: `jetShape` rows and monotonicity; `GRIME_FOR` totality;
spill vs full coverage bounds; layered `stamp` shielding and layered `tally`;
track dealing bounds and that tracks hold the board back; `tape` / `sticky`
in the table with `bulk` and a tool; the robot's eat rule as a pure predicate
(`robotEats(piece) → boolean`: loose or on-card yes, carried no).

Everything visual is checked by playing. Say so in the report, item by item.

## Playing it

- slow strokes visibly narrow the ring and clean faster; fast sweeps are wide
  and light; nothing tells you this in words.
- rivulets run and drip and are gone in two seconds; none survive on a clean
  card; a rotated card drips at its own angle.
- the bright edge leads the stroke and only when something actually came off.
- a cleaned card lifts and settles with the board's own hover feel; on Harsh it
  does not move at all.
- a note gets coffee or ink far more often than mud; a spill has a shape.
- a layered card reveals rust under mud, then the card.
- a trail crosses cards and bare board; pressing on a print with the washer
  washes and does not pan; the board will not finish while one is left.
- the spider shuffles, scuttles when approached, drops and walks off when
  dusted, and nothing anywhere waits for it.
- tape peels over most of a second and eases back if let go.
- the ending is dealt as a card, can be nudged about, and leaves no trace.
- the code typed again releases the robot; it bumps, turns, eats what is loose,
  and parks.
- the glove closes on a load, the bin shows a leaf after eight pieces, the tool's
  shadow lengthens on a fast move, the count reads "3 of 12".
- every one of those at the lowest quality tier, and on each palette.
