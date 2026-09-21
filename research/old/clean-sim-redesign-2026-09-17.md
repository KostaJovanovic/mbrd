# The cleaning simulator, second pass: three tools you hold

Open work. A plan for one agent to carry out, top to bottom. Decisions below were
made by the maintainer on 2026-09-17 and are **not to be re-argued**; where the
plan says "tune by playing" the number is a starting point.

The egg today (`web/assets/js/ui/clean/`, `web/assets/css/clean.css`,
`tests/clean.test.js`, all uncommitted on `main`) has six tools, ten kinds of
mess, two chains and a drying clock. It is confusing and does not feel like
anything. This pass cuts it to three tools that are physically *held*, a trash
can, a caked grime whose reveal is the reward, and no way to fail.

**The brief in one line: a zen experience.** Every choice that is not settled
here is settled by that. Slow eases, soft sounds, nothing counted against the
player, nothing that times out, nothing that says "no" loudly.

## How to run this

Four sessions, each a fresh agent, each stopping for the maintainer to look.
Paste the prompt as written; every one begins by reading this file.

**Stage 1 — the arithmetic.**
> Read `research/clean-sim-redesign-2026-09-17.md` in full, then `CLAUDE.md`.
> Carry out steps 1 and 2 of §11 only: `mess.ts`, `konami.ts` and their tests in
> `tests/clean.test.js`, per §1, §2, §5 and §10. `clean.ts` and `art.ts` will
> stop compiling against the new table — make the smallest edits that keep
> `npm run typecheck` and `npm run build` green (stub, do not redesign) and list
> each stub in your report. Spawn no subagents. Do not commit. Stop when
> `npm test`, lint, typecheck and build are green and report what you stubbed.

**Stage 2 — how it looks.**
> Read `research/clean-sim-redesign-2026-09-17.md` in full, then `CLAUDE.md`.
> Stage 1 is done. Carry out steps 3 and 4 of §11: the new grime, the two new
> debris pieces, the four illustrations, the bar markup and `clean.css`, per §6
> and §7. Wire just enough in `clean.ts` that opening the egg shows the new
> grime and debris on a real board with the old interaction still limping.
> Spawn no subagents. Do not commit. Do not start a server — the maintainer's is
> at `169.254.83.107:6273`. Stop and report: what to open, what to look at, the
> measured time to paint thirty cards, and anything in §6 you could not make
> look right.

**Stage 3 — holding the tools.**
> Read `research/clean-sim-redesign-2026-09-17.md` in full, then `CLAUDE.md`.
> Stages 1 and 2 are done and the look is approved. Carry out steps 5, 6 and 7
> of §11 per §3, §4, §5, §8 and §9. Remove every stage-1 stub. Spawn no
> subagents. Do not commit. Stop when all four checks are green and report
> against §12 line by line — say which lines you could verify without a browser
> and which are the maintainer's to play.

**Stage 4 — after playing.**
> Read `research/clean-sim-redesign-2026-09-17.md`, then `CLAUDE.md`. The
> maintainer has played it; their notes follow. Fix what they list and nothing
> else; tuning numbers live in `TUNING` in `mess.ts`. Then write the §13 report.
> Notes: …

## 0. Ground rules for whoever carries this out

- Read `CLAUDE.md` first, then the header of every file before touching it.
  File tools only, never the shell, for edits.
- **Other sessions share this checkout.** Stage only your own files. Do not
  start `serve.py`; the maintainer's server is at `169.254.83.107:6273`.
  Do not commit unless asked. Never read or edit `research/old/`.
- Spawn no subagents.
- The layering stays as it is: `mess.ts` and `konami.ts` pure (no DOM, no
  `state.ts`), `art.ts` draws, `clean.ts` is the mode, `canvas/input.ts` reaches
  all of it through `cmds` only. The one `keydown` listener stays the only one.
- Keep: the dirt layer inside `#world`, the glass (`.clean-catch`) inside the
  viewport element, arithmetic hit-testing, the occupancy grid with per-cell
  depth, `stamp()`, stroke interpolation in `strokeTo()`, the queued painting
  (`drainPaint`), `sustain()` in the cuelume engine, the music handling, media
  pause/resume, the state resets in `stopClean()`.
- Bar for done: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`
  all green, then played by hand (section 9).

## 1. What goes

- Tools `cloth`, `brush`, `tweezers`, `spray`, `squeegee`, and their six
  `i-clean-*` symbols in `icons.svg`.
- Mess kinds `dust`, `streaks`, `grease`, `greaseLoose`, `water`. With them:
  `becomes`, `driesTo`, `dry()`, `emptyField()`'s chain use, `chainTarget()`,
  `paintChain()`, `paintSpot()`, `SPOT_SEED`, `.clean-streaked`, the drying loop
  in `tick()`, `TUNING.dryMs`, `guarantee()`'s mud/grease logic, `STARTING` as it
  stands, the `SOUND` table's five entries.
- The rule "one kind of mess per card".
- The auto-close at the end (`setTimeout(stopClean, 4200)`).
- The drawn-cursor-always model: the tool cursor now exists only while a tool is
  held.
- Every test in `tests/clean.test.js` that holds a removed thing (the chains,
  drying, "exactly one tool per mess / every tool in the bar", mud+grease
  guarantee, one-kind-per-card). Konami, coverage, stamp, depth, web pairing and
  counting tests stay, adjusted.

## 2. The table (`mess.ts`)

```ts
TOOLS = [
  { id: 'glove',  label: 'Glove' },            // key 1
  { id: 'washer', label: 'Pressure washer' },  // key 2
  { id: 'duster', label: 'Duster' },           // key 3
]

MessKind = 'mud' | 'moss' | 'tar'              // field  -> washer
         | 'leaves' | 'crumbs' | 'gum' | 'paper' | 'cap'   // debris -> glove
         | 'cobweb'                            // web    -> duster
```

`MessDef` loses `becomes` and `driesTo` and gains `bulk: number` for debris —
how much of a handful one piece takes: crumbs 1, leaves 1, cap 1, gum 1,
paper 2.

Tuning, all in `TUNING`:

| key | value | note |
| --- | --- | --- |
| `depth` | mud 2, moss 3, tar 5 | passes of the jet per cell |
| `clearAt` | 0.95 | last specks dissolve on their own |
| `cover` | 0.9 | share of the grid a dealt field fills (see §4) |
| `reach.washer.radius` | 30 | narrow; aiming is the play. Tune |
| `reach.glove.radius` | 34 | |
| `reach.duster.radius` | 44 | |
| `handful` | 5 | bulk the glove holds |
| `dusterHolds` | 3 | webs before it must be shaken out |
| `gumTugs` | 3 | unchanged |
| `tank` | `{ fullMs: 6000, fadeMs: 2000, refillMs: 1700 }` | §5 |
| `maxCards`, `grid`, `webGap`, `webPerCard`, `perPatch` | as now | |

`rate` in `reach` is unused today; delete it.

### Dealing (`planBoard`)

Per card, independently:

- grime with probability 0.7, kind picked from mud/moss/tar weighted 3:2:1;
- a debris patch with probability 0.5, kind from leaves/crumbs/gum/paper/cap
  (gum and paper and cap: 1–3 pieces, never a scatter of ten; gum still 1);
- a card that rolled neither gets debris.

So a card can carry **debris on top of grime**. Guarantees for a board with
cards: at least one grimed card and at least one debris card (re-deal one if
not), so no tool in the bar is ever idle on a board with two or more cards.
Webs from `pairWebs()` unchanged; the duster is allowed to be idle on a
spread-out board — then **its slot is not shown at all** (`BoardPlan.webs.length
=== 0` → hide the button), rather than a tool with nothing to do.

`CardPlan.fields` stays an array (length 0 or 1) so the counting code does not
change shape.

### Pure helpers to add, each with tests

- `tankStep(state, dtMs, spraying) → state` and `tankPower(state) → 0..1` (§5).
- `handRoom(carried, piece) → boolean` and `bulkOf(carried)`.
- `nearestOnQuad(ax, ay, mx, my, bx, by, x, y)` stays sampled; but **store the
  sag on the web** (`Web` gains nothing; `LiveWeb` gains `sag`) and have
  `webPath()` take it as a parameter instead of rolling it, so the hit line is
  the drawn line. `nearCurve()` currently assumes 0.2.

## 3. Holding a tool

State: `held: ToolId | null`, replacing `tool`. The mode opens with **empty
hands**.

**Picking up.** Click a tool in the bar, or press 1–3. The icon leaves its slot:
the button gets `.is-out` (glyph hidden, a dashed outline of it left behind,
`aria-pressed="true"`), and the tool appears under the hand, easing from the
slot's screen position to the pointer over ~320 ms. On touch, where there is no
hover point, it eases to the centre of the viewport and then follows the finger,
drawn offset up-left of it (about 36 px) so the finger does not cover the work.

**Putting down.** Click the empty slot; click another tool (the held one flies
home, the new one lifts — one press); right-click anywhere; `Esc`; the same
digit again. The tool eases back into its slot, ~320 ms.

**Carrying blocks putting down.** A glove with anything in it, or a duster with
any web on it, cannot go home or be swapped. No shake, no error sound: the trash
can's lid lifts and the can glows softly for a second, which is the answer to
"what do I do with this". `Esc` in that state does the same and nothing else.

**Esc chain.** Held and empty → put down. Held and carrying → nudge to the can.
Empty hands → the existing "Leave it dirty?" confirm. Confirm up → `Esc` again
leaves. `cleanStop` in `commands.ts` becomes this chain (rename `cleanEscape`);
it still answers `true` whenever the mode is up so `input.ts` marks it closed.
The ✕ in the bar asks as now.

**The cursor.** Empty hands: the ordinary cursor, `grab` over bare board.
Holding: `cursor: none` and the drawn tool, as today but **large** — 56 px, not
38 — and drawn as its own small illustration (§6), not a 16 px UI glyph scaled
up. It tilts a few degrees with horizontal velocity and settles back, eased.
Dimmed to 0.4 where a press would pan rather than work (the existing
`is-idle-tool`).

**What a press means.** Decided at `pointerdown`, never mid-gesture:

1. Middle button, or Space held → pan. (Right button no longer pans; it puts the
   tool down. `contextmenu` stays prevented.)
2. Left, empty hands → pan.
3. Left, holding, and `underTool()` says this tool has work at this point
   (a card with matching mess within reach; for the duster, a strand within
   reach — bare board included) → work.
4. Left, holding the glove with something in it, not over the can → drop the
   handful here (§4, glove).
5. Otherwise → pan.

Two fingers pan, as now. `intent()` becomes this function and gets the point.

## 4. The three tools

### Glove and trash can

- **Scoop.** Button down on/near debris, sweep: every piece within
  `reach.glove.radius` that still fits (`handRoom`) leaves the card and joins the
  hand. Gum takes `gumTugs` separate *presses* first (each one stretches it
  toward the glove and lets it snap back, eased — `.clean-resist`, slower than
  today's 200 ms), then comes away on the next.
- **Carried pieces are drawn in the glove**: the same SVG nodes, re-parented into
  the cursor's SVG, piled with small offsets and rotations. A full glove looks
  full. No number.
- **The can** is the last thing in the bar, right of a vertical rule, after the
  ✕'s old position — order: three tools, count, ✕, rule, can. (✕ moves left of
  the rule so the can is truly "all the way to the right".) It is a `<button
  data-clean="can">`, about 56 px, an illustration and not a UI glyph, with a lid
  that is a separate SVG group so it can hinge.
- **Hover with a load** (pointer over the bar's can, or within ~90 px of it): lid
  eases open. **Click** the can: pieces leave the glove one after another
  (~70 ms apart), each an arc into the can with a little tumble, a soft muffled
  thunk per piece pitched slightly apart, the can settles a pixel or two per
  piece, lid eases shut after the last. Web Animations API or CSS transitions on
  `transform`; no layout properties.
- **A click anywhere else** with a loaded glove that is not work (rule 4 above):
  the handful drifts down to where the click was. Over a card → the pieces
  become that card's debris at that spot (the card un-cleans if it was clean —
  silently, the count just reads what is true). Over bare board → they lie on the
  board as **loose debris**: a new list `loose: LiveBit[]` in world coordinates
  in the dirt layer, scoopable like any other, and the board is not done while it
  is non-empty. `tally()` takes a `loose` count. Nothing is recorded as a miss.
- **The washer over debris** does not clean it: pieces within the jet skid a few
  world units away from the nozzle (eased, clamped to the card), so a leaf on
  grime has to be gloved off first — grime cells under a piece's footprint are
  shielded from `stamp()` while it lies there. Implement the shield as a
  predicate passed to `stamp()` (`skip?: (i: number) => boolean`) so `mess.ts`
  stays pure; test it.

### Washer

- The only thing that touches a field. `stamp()` with `bite` 1 scaled by tank
  power: accumulate fractional power per stroke and bite when it crosses 1, so a
  weakening jet thins more slowly rather than not at all until it is at zero.
- **Tank** (§5).
- **What it looks like working:** a short cone of mist from the nozzle (a few
  dozen canvas particles on one overlay canvas sized to the viewport, inside the
  glass; float and fade, ~600 ms), flecks of the grime's own colour thrown off
  where cells finish, and a **wet sheen** left on the cleaned area that fades
  over ~2 s — cosmetic, never counted, no tool. All particle counts halve when
  `quality` says so; check what `quality.motion` actually is before reusing it
  as the "rich" flag (the current code does, and it may be the wrong dial).
- **Per-card ring.** While the jet is on a card, a thin ring sits at the card's
  top-right corner (in the dirt layer, counter-scaled so it is a constant
  screen size) showing share cleaned; it fills, and on clear it closes into a
  small check, a soft `rise` cue plays, and the card's one pass of light runs
  (existing `.is-clean::after`). The ring fades out 1.5 s after the jet leaves.

### Duster

- Sweep across a strand (existing `sweepWebs`/`nearCurve`): the web does not
  vanish, it **winds onto the duster** — the path shortens toward the duster
  over ~450 ms (animate `stroke-dashoffset` on the strand, then remove), and the
  duster's drawn head gets a visible wrap of grey, one layer per web.
- At `dusterHolds` it takes no more: further strands under it just sway
  (a small eased displacement of the path's control point, then back).
- **Emptying:** click the can, same as the glove. The wrap slides off as a grey
  tuft and drifts in. The duster is then clean.
- A web still holds both its cards back, as now. A web wound on the duster but
  not yet binned does **not** hold the cards back, but the board is not done
  until the duster is empty (`tally()` takes `carrying: boolean`).

## 5. The tank

Numbers are the maintainer's: **6 s of full spray, then 2 s in which the stream
weakens to nothing, then 1.7 s to refill.**

State `{ level: 0..1 }`, where 1 is full. Spraying drains at `1 / (fullMs +
fadeMs)` per ms. Power is 1 while `level > fadeMs / (fullMs + fadeMs)` (i.e.
above 0.25) and falls linearly to 0 across the last quarter. Not spraying, it
refills at `1 / refillMs` per ms — from wherever it was, not only from empty, so
short bursts cost short rests. Holding the button on an empty tank does nothing
and refills nothing; release to refill.

Shown on the tool itself: a small vertical gauge on the washer's body in the
cursor illustration, easing, no numbers. The `sustain()` hiss follows power —
`level(power * (worked ? 1 : 0.12))` — and its filter frequency falls with power
so an emptying tank is *heard* softening before it is seen. That needs
`Sustain` to grow a `tone(frequency)` method in `cuelume/engine.ts`; ramped like
`level()`. No new rows in `RECIPES`.

`tankStep`/`tankPower` are pure, in `mess.ts`, tested: full for 6000 ms, zero at
8000, monotone between, full again 1700 ms after release from empty, a partial
drain refills proportionally.

## 6. How it looks (`art.ts`)

### Grime — redone from nothing

The current grime is a translucent noise film. Replace it with a **thick, opaque
caked layer that hides the card**, so washing is a reveal with a clean edge.

- Coverage: the mask fills ~90 % of the grid — the whole card but for an
  irregular, noise-warped margin and a few bare bites at the edges. Build the
  mask from a noise-thresholded rounded rectangle, not from blobs;
  `fieldBlobs`/`maskFor`/`cover` go. The **same function** must feed the grid
  predicate and the paint alpha (today's blob-sharing rule, kept).
- Alpha 0.92–1 across the body, falling to 0 only in the last few percent at the
  rim. The card underneath should be unreadable.
- Depth is visible. Light it: derive a height from the fBm, take a cheap
  gradient (difference of two neighbouring samples), and shade — highlights up
  and left, a darker lip at the rim so the crust reads as *sitting on* the card.
  This is the difference between a stain and a layer.
- Three materials, distinguishable in peripheral vision:
  - **mud** — warm browns, matte, dried: a Voronoi-ish crack network (dark thin
    lines) over broad clods. Soft: 2 passes.
  - **moss** — deep greens with yellow-green tips, clumpy high-frequency
    stipple, fuzzy rim, slight variation toward brown at the edges. 3 passes.
  - **tar** — near-black, glossy: broad smooth shapes, few specular streaks
    (the sheen term that water used), drips running down from the lower rim.
    5 passes.
- **Erasing shows the layers.** Each pass should not just lower alpha: a cell at
  partial depth looks *thinned and wet* — draw erasure as `destination-out` at
  `1/depth` as now, plus a darkening/wet multiply pass on what remains under the
  jet, so a half-washed patch is visibly different from untouched crust. The
  last pass leaves a crisp edge: tighten `eraseAt`'s falloff for the final bite
  (gradient stops nearer a cliff) — the clean/dirty boundary being sharp is what
  makes the reveal satisfying. Keep the three-jittered-discs raggedness.
- Still generated small (`NOISE_MAX`) and drawn up, still queued two per frame.
  Measure the open: thirty cards must not freeze the frame. If lighting doubles
  the cost, drop `NOISE_MAX` before dropping the lighting.

### Debris

Keep `leaf`, `crumb`, `gum`. Add `paper` (a crumpled ball: an irregular polygon
with interior fold lines and one shaded facet) and `cap` (a bottle cap: a
circle with a crimped edge and an inner ring). All in the card's 0..100 box as
now. Give every piece a soft drop shadow (an offset darker copy at low opacity,
not a CSS filter per node) so it reads as lying on the crust.

### Tools and the can

Four new illustrations, each as a `<symbol>` in `icons.svg` with a larger
viewBox (`0 0 48 48`) and fills, not the 16 px stroke glyphs:
`i-clean-glove`, `i-clean-washer`, `i-clean-duster`, `i-clean-can` (the can's lid
is drawn by `clean.ts` as a separate node so it can hinge — or two symbols,
`i-clean-can` and `i-clean-can-lid`). The bar buttons use the same symbols
smaller. `tests/icons.test.js` checks both directions: remove the six old ids
and every reference, add the new ones and reference each.

The washer's gauge and the duster's wrap and the glove's load are drawn by
`clean.ts` over the symbol, in the cursor's SVG.

### Motion

One set of eases for the mode, defined once at the top of `clean.css`:
`--clean-ease: cubic-bezier(0.22, 0.61, 0.36, 1)`, durations 320 ms (tool
travel), 450 ms (things leaving), 900 ms (card shine), 2200 ms (final sweep).
Nothing snaps; nothing bounces hard. `quality.css` still wins — it loads after.
The maintainer sometimes tests over Remote Desktop, where animation looks
instant or absent: do not "fix" motion on that evidence.

## 7. The bar and markup (`index.html`, `clean.css`)

```
[ Glove ] [ Washer ] [ Duster ]   3 / 12   ✕  │  🗑
```

- `#clean-tools` holds three tool buttons (name under glyph, as now), the count,
  the ✕; then a rule; then `#clean-can`.
- A lifted tool's button: `.is-out`. Width of the bar must not change when a
  tool lifts.
- Every id named in a stylesheet must exist in `index.html` and the reverse
  (`tests/element-ids.test.js`); address runtime-made nodes by class, as the
  dirt layer already is.
- No inline `style=` in markup. Setting `.style` from script is fine.
- `clean.css` stays where it is in all three lists (`index.html`, `SHELL` in
  `sw.js`, `APP_CSS_ORDER`). No apostrophes in anything added inside `SHELL`.
- Narrow screens: three tools fit easily now; drop the 44 px fallback, keep one
  breakpoint.
- The ending's "Done" (§8) is a button in the bar, in `#clean-confirm`'s place.

## 8. Ways in, and the ending

**Konami** unchanged.

**Touch: seven taps on the wordmark.** `.wordmark h1` in `#sidebar`
(`index.html:297`). Not `#version` — that is a `data-cmd="patch-notes"` button
and the first tap would open the patch notes. Seven taps within 3 s (window
restarts on a gap over 600 ms). A pure `tapMatcher(now)` beside
`konamiMatcher()` in `konami.ts`, tested. Wire it as **a command**, not a second
listener convention of its own: `cmds.cleanTap()`, called from one `click`
listener added where the sidebar is initialised (`ui/sidebar.ts` may import
`ui/clean/`; check `tests/layers.test.js`). On success: close the sidebar, then
`startClean()`.

`startClean()` must refuse — answer `false`, keys fall through — when: the board
has no cards; a tour is up (`.is-touring`, `.is-tour-edit`); the Timeline is
playing; the board is a mobile Feed or Playlist board (the canvas is not what is
on screen — find how `#mobile-feed` decides and ask the same thing). The second
and third are open holes today.

**The ending.** When `tally()` says done: the held tool flies home, the can's
lid shuts with its thunk, `done` cue, the light crosses the board, "Everything
is spotless." fades in — and **it stays**. Music keeps playing (no `fadeMusic(0)`
here). The bar swaps to a single quiet **Done** button; `Esc` does the same.
Pan and zoom still work so the clean board can be looked at. No timer of any
kind. Remove the `doneTimer` that closes the mode, keep the handle pattern for
any delayed cue so `stopClean()` can still clear it.

## 9. Sounds

All through `cue()` and `sustain()`; nothing new in `RECIPES`, which is vendored
number for number. Map in `cuelume/recipes.ts`'s `CUES` only if a cue name is
missing — prefer existing ones at low volume:

- lift / put down a tool: `tap` at 0.35, put-down a little lower;
- scoop a piece: `pick` 0.4; gum tug: `pick` 0.25;
- piece into can: `pick` or the nearest soft low cue at 0.3, playback varied a
  few percent per piece if the engine allows, otherwise leave it;
- washer: `sustain` highpass as now, `tone()` following tank power;
- duster: a very quiet bandpass `sustain` while sweeping;
- card clean: `rise` 0.4; board done: `done`, then `sweep`.

Check each with `mbrd.sound.log()` — a press that logs nothing never reached the
engine.

## 10. Tests (`tests/clean.test.js`)

Drop what §1 lists. Add:

- table: every mess names a tool in `TOOLS`; every debris has `bulk ≥ 1`; every
  field kind has a depth; three tools exactly.
- dealing: over 40 seeds — at least one grime and one debris card on any board
  of ≥ 2 cards; a card never has two fields; gum never more than one per card;
  debris lands inside the card; the dealt mask covers ≥ 85 % of the grid.
- tank: the five properties in §5.
- glove: `handRoom` refuses past `handful`; paper takes 2.
- `stamp()` with a `skip` predicate leaves shielded cells alone and counts none.
- `tally()`: loose debris holds the board back; a carrying duster holds it back;
  a web on the duster does not hold its cards back.
- `tapMatcher`: seven quick taps fire, six do not, a long gap restarts.
- existing konami, coverage, web pairing, per-card cap tests stay green.

`tests/icons.test.js`, `tests/element-ids.test.js`, `tests/sw.test.js`,
`tests/layers.test.js`, `tests/imports.test.js` (no `document` at import time)
must stay green without edits to them beyond what the new names require.

## 11. Order of work

1. `mess.ts` + tests: new table, dealing, tank, hand, `skip`, `tally`. Green in
   Node before any DOM work.
2. `konami.ts` + tests: `tapMatcher`.
3. `art.ts`: new grime (mask + three materials + lighting + layered erase), two
   new debris, remove blobs and spots. Look at it on a real board at three zooms.
4. `icons.svg` + `index.html` + `clean.css`: four illustrations, the bar, the
   can, `.is-out`, eases.
5. `clean.ts`: held-tool state, pick up / put down / swap / blocked, the press
   rule, glove + can + loose debris, washer + tank + particles + ring, duster +
   wind + empty, the ending that waits, `startClean()` refusals.
6. `commands.ts` / `input.ts` / sidebar: `cleanEscape`, digits 1–3, right-click
   via the glass, `cleanTap`. `InputCommands` type updated to match.
7. `engine.ts`: `Sustain.tone()`.
8. All four checks, then play it (below), then report.

## 12. Playing it — the real acceptance

On the maintainer's server, a board with 10+ cards, some close together:

- konami opens it with empty hands; left-drag pans everywhere; wheel zooms.
- lift each tool by click and by digit; swap in one click; right-click and Esc
  put down; the slot shows empty while out and the bar does not change width.
- glove: scoop five, a sixth stays; gum takes three tugs; drop on a card, on
  bare board, in the can; a loaded glove will not go home and the can answers.
- washer: a leaf shields the grime under it and skids; six seconds full, two
  fading, 1.7 back — by ear as well as by eye; ring fills, card shines; tar
  visibly takes longer than mud; the reveal edge is crisp.
- duster: three webs wind on, a fourth sways; empty in the can; both cards then
  come clean.
- finish: tool goes home, line appears, **nothing closes**; Done and Esc leave;
  board is exactly as it was; open it a second time straight away and
  everything works (no stuck pointer, Space, timers).
- phone-width window: seven taps on "mbrd." in the sidebar opens it; tool draws
  offset from the finger; two fingers pan.
- during a tour and during Timeline playback the code does nothing.
- whimsy/quality at lowest: still playable, fewer particles, no broken layout.
- console clean throughout.

## 13. Report

Say plainly what was and was not verified by playing. Call out: **`sw.js`
unchanged unless a file was added to `SHELL`**; no `.mbrd` schema change; no
generated catalogue touched; `icons.svg` ids removed and added; the
`Sustain.tone()` addition to the vendored-adjacent engine.
